/**
 * Spread Ladder — MM-Aware Price Compression
 *
 * Exploits market-maker pennying behaviour on Kalshi:
 *   - ENTRY mode: place SELL → MM undercuts → ask compresses → BUY at lower price
 *   - EXIT  mode: place SELL competitively → find buyers above bid
 *
 * Each sell order is a bona-fide 1-contract GTC order.
 * Fills are real exits; accidental fills in ENTRY mode trigger an abort.
 *
 * Phase 1: standalone utility — no bot wiring.  Bots call runSpreadLadder().
 */

import { getKalshiClient } from '@/lib/kalshi/client';
import { fetchKalshiOrderBook } from '@/lib/kalshi/orderBook';
import { placeOrder, cancelOrder } from '@/engine/kalshiTrader';
import { BotConfig } from '@/lib/types';

type ArbConfig = BotConfig['arb'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type LadderMode =
  | { type: 'entry'; buyContracts: number }   // compress ask → BUY N contracts
  | { type: 'exit';  sellContracts: number };  // find true price → SELL N contracts

export interface LadderResult {
  status: 'done' | 'aborted' | 'max-steps' | 'accidental-fill';
  sellFills: number;       // contracts actually sold during ladder
  finalAskCents: number;   // ask at termination
  buyPlaced: boolean;      // true if a buy order was placed (entry mode)
  buyPriceCents: number;   // 0 if buyPlaced is false
  buyOrderId?: string;     // order ID of the placed buy (entry mode)
}

export async function runSpreadLadder(params: {
  ticker: string;
  side: 'yes' | 'no';
  mode: LadderMode;
  config: ArbConfig;
  minutesRemaining?: number; // if < 3, skip ladder and go direct
  exitStyle?: 'ladder' | 'direct'; // EXIT mode: 'direct' → sell at bid immediately
}): Promise<LadderResult> {
  const { ticker, side, mode, config } = params;
  const {
    ladderStepCents,
    ladderMaxSteps,
    ladderTickMs,
    ladderTargetDiscount,
  } = config;

  const BOT_TAG = 'ladder';
  const askKey = side === 'yes' ? 'yes_ask' : 'no_ask';
  const bidKey = side === 'yes' ? 'yes_bid' : 'no_bid';

  // Helpers -----------------------------------------------------------------

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function fetchMarket() {
    const client = getKalshiClient();
    return client.getMarket(ticker); // bypass 30s cache — need fresh data each tick
  }

  async function isOrderStillResting(orderId: string): Promise<boolean> {
    try {
      const client = getKalshiClient();
      const data = await client.getOrders(ticker, 'resting') as { orders?: Array<{ order_id: string }> };
      const orders = data?.orders || [];
      return orders.some(o => o.order_id === orderId);
    } catch {
      return true; // assume still resting on error to avoid false fill detection
    }
  }

  async function tryCancelOrder(orderId: string): Promise<void> {
    try {
      await cancelOrder(BOT_TAG, orderId, ticker);
    } catch {
      // ignore cancel errors
    }
  }

  // INIT --------------------------------------------------------------------

  // Fast path: too close to expiry
  if (params.minutesRemaining !== undefined && params.minutesRemaining < 3) {
    return await goDirect({ ticker, side, mode, config: { askKey, bidKey }, botTag: BOT_TAG, fetchMarket, placeOrder });
  }

  // Fast path: EXIT mode with direct style
  if (mode.type === 'exit' && params.exitStyle === 'direct') {
    return await goDirect({ ticker, side, mode, config: { askKey, bidKey }, botTag: BOT_TAG, fetchMarket, placeOrder });
  }

  // Fetch initial market data
  let market: Awaited<ReturnType<typeof fetchMarket>>;
  try {
    market = await fetchMarket();
  } catch (err) {
    console.error('[LADDER] Failed to fetch market:', err);
    return { status: 'aborted', sellFills: 0, finalAskCents: 0, buyPlaced: false, buyPriceCents: 0 };
  }

  if (market.status === 'settled' || market.status === 'closed') {
    return { status: 'aborted', sellFills: 0, finalAskCents: (market as any)[askKey] ?? 0, buyPlaced: false, buyPriceCents: 0 };
  }

  let currentAsk: number = (market as any)[askKey] ?? 50;
  let currentBid: number = (market as any)[bidKey] ?? 50;
  const originalAsk = currentAsk;

  // Skip ladder if spread is already tight (entry mode only)
  if (mode.type === 'entry' && currentAsk - currentBid <= 2) {
    console.log(`[LADDER] Spread already tight (${currentAsk - currentBid}¢), going direct`);
    return await goDirect({ ticker, side, mode, config: { askKey, bidKey }, botTag: BOT_TAG, fetchMarket, placeOrder });
  }

  // Fetch order book and build depth map
  const bidDepthMap = new Map<number, number>();
  try {
    const book = await fetchKalshiOrderBook(ticker, 15);
    if (book) {
      const levels = side === 'yes' ? book.yes : book.no;
      for (const [price, qty] of levels) {
        bidDepthMap.set(price, qty);
      }
      console.log(`[LADDER] Book depth: ${bidDepthMap.size} price levels`);
    }
  } catch {
    // continue without depth map — ladder works without it
  }

  // Target prices
  const targetCents = mode.type === 'entry'
    ? originalAsk - ladderTargetDiscount  // buy when ask drops this much
    : currentBid + 1;                      // exit: sell above bid (stop when all sold)

  // EXIT mode: track current sell price, starts above bid and descends on retries
  let exitSellPrice = currentBid + ladderStepCents;

  // State
  let activeOrderId: string | null = null;
  let activeOrderPriceCents = 0;
  let steps = 0;
  let sellFills = 0;
  let ticksWithOrder = 0;
  let runStatus: 'running' | 'done' | 'aborted' | 'max-steps' | 'accidental-fill' = 'running';
  let buyPlaced = false;
  let buyPriceCents = 0;
  let buyOrderId: string | undefined;

  console.log(
    `[LADDER] Start — mode:${mode.type} side:${side} ticker:${ticker} ` +
    `ask:${currentAsk}¢ bid:${currentBid}¢ target:${targetCents}¢`
  );

  // Main loop ---------------------------------------------------------------
  while (runStatus === 'running') {
    await sleep(ladderTickMs);

    // Refresh order book every 3 steps
    if (steps > 0 && steps % 3 === 0) {
      try {
        const refreshedBook = await fetchKalshiOrderBook(ticker, 15);
        if (refreshedBook) {
          bidDepthMap.clear();
          const levels = side === 'yes' ? refreshedBook.yes : refreshedBook.no;
          for (const [price, qty] of levels) {
            bidDepthMap.set(price, qty);
          }
        }
      } catch {
        // ignore refresh errors
      }
    }

    // Step 1: Fetch market
    try {
      market = await fetchMarket();
    } catch {
      continue; // retry next tick on transient error
    }

    if (market.status === 'settled' || market.status === 'closed') {
      if (activeOrderId) await tryCancelOrder(activeOrderId);
      runStatus = 'aborted';
      break;
    }

    currentAsk = (market as any)[askKey] ?? currentAsk;
    currentBid = (market as any)[bidKey] ?? currentBid;

    // Step 2: Check if active order filled
    if (activeOrderId) {
      const stillResting = await isOrderStillResting(activeOrderId);
      if (!stillResting) {
        sellFills++;
        console.log(`[LADDER] Order ${activeOrderId} filled — sellFills:${sellFills}`);
        activeOrderId = null;
        ticksWithOrder = 0;

        if (mode.type === 'entry') {
          // Accidental fill: we sold YES without owning it (now hold NO position)
          console.warn('[LADDER] Accidental fill in ENTRY mode — aborting ladder');
          return {
            status: 'accidental-fill',
            sellFills: 1,
            finalAskCents: currentAsk,
            buyPlaced: false,
            buyPriceCents: 0,
          };
        } else {
          // EXIT mode: fills are success
          if (sellFills >= mode.sellContracts) {
            runStatus = 'done';
            break;
          }
          // Continue to sell remaining contracts
          exitSellPrice = currentBid + ladderStepCents;
        }
      }
    }

    // Step 4: Terminal checks
    if (mode.type === 'entry') {
      if (currentAsk <= targetCents || steps >= ladderMaxSteps) {
        if (activeOrderId) await tryCancelOrder(activeOrderId);
        try {
          const buyResp = await placeOrder(BOT_TAG, ticker, side, 'buy', mode.buyContracts, currentAsk);
          buyPlaced = true;
          buyPriceCents = currentAsk;
          buyOrderId = buyResp.order.order_id;
          console.log(`[LADDER] Entry done — bought ${mode.buyContracts} @ ${currentAsk}¢ orderId:${buyOrderId}`);
        } catch (err) {
          console.error('[LADDER] Buy order failed:', err);
        }
        runStatus = steps >= ladderMaxSteps ? 'max-steps' : 'done';
        break;
      }
    } else {
      if (sellFills >= mode.sellContracts || steps >= ladderMaxSteps) {
        if (activeOrderId) await tryCancelOrder(activeOrderId);
        runStatus = sellFills >= mode.sellContracts ? 'done' : 'max-steps';
        break;
      }
    }

    // Step 5: Place new sell order if no active order
    if (!activeOrderId) {
      let newSellPrice: number;
      if (mode.type === 'entry') {
        newSellPrice = currentAsk - ladderStepCents;
      } else {
        newSellPrice = exitSellPrice;
      }

      if (newSellPrice < 1) {
        console.warn('[LADDER] Sell price < 1¢, aborting');
        runStatus = 'aborted';
        break;
      }

      const bidsAtLevel = bidDepthMap.get(newSellPrice) ?? 0;
      if (bidsAtLevel > 20) {
        // Deep bid level — real buyers present, don't ladder into them
        console.log(`[LADDER] Deep bid at ${newSellPrice}¢ (${bidsAtLevel} contracts) — going direct`);
        if (mode.type === 'entry') {
          try {
            const buyResp = await placeOrder(BOT_TAG, ticker, side, 'buy', mode.buyContracts, currentAsk);
            buyPlaced = true;
            buyPriceCents = currentAsk;
            buyOrderId = buyResp.order.order_id;
            console.log(`[LADDER] Entry direct buy @ ${currentAsk}¢ orderId:${buyOrderId}`);
          } catch (err) {
            console.error('[LADDER] Direct buy failed:', err);
          }
        } else {
          const remaining = mode.sellContracts - sellFills;
          try {
            await placeOrder(BOT_TAG, ticker, side, 'sell', remaining, currentBid);
            sellFills = mode.sellContracts;
            console.log(`[LADDER] Exit direct sell ${remaining} @ ${currentBid}¢`);
          } catch (err) {
            console.error('[LADDER] Direct sell failed:', err);
          }
        }
        runStatus = 'done';
        break;
      }

      // Place GTC sell
      try {
        const sellResp = await placeOrder(BOT_TAG, ticker, side, 'sell', 1, newSellPrice);
        activeOrderId = sellResp.order.order_id;
        activeOrderPriceCents = newSellPrice;
        ticksWithOrder = 0;
        steps++;
        console.log(`[LADDER] Step ${steps}: placed SELL @ ${newSellPrice}¢ orderId:${activeOrderId}`);

        // Check for immediate fill (rare for GTC above bid)
        if (sellResp.order.remaining_count === 0) {
          sellFills++;
          console.log(`[LADDER] Immediate fill at ${newSellPrice}¢`);
          activeOrderId = null;
          if (mode.type === 'entry') {
            return {
              status: 'accidental-fill',
              sellFills: 1,
              finalAskCents: currentAsk,
              buyPlaced: false,
              buyPriceCents: 0,
            };
          }
          if (sellFills >= mode.sellContracts) {
            runStatus = 'done';
            break;
          }
          exitSellPrice = currentBid + ladderStepCents;
        }
      } catch (err) {
        console.error('[LADDER] Failed to place sell order:', err);
        runStatus = 'aborted';
        break;
      }

    } else {
      // Step 6: Manage active order (it did not fill this tick)
      ticksWithOrder++;

      if (mode.type === 'entry') {
        if (currentAsk < activeOrderPriceCents) {
          // MM undercut our sell — cancel and re-enter next tick at new level
          console.log(
            `[LADDER] MM undercut: ask ${currentAsk}¢ < our sell ${activeOrderPriceCents}¢ — cancelling`
          );
          await tryCancelOrder(activeOrderId);
          activeOrderId = null;
          ticksWithOrder = 0;
        } else if (ticksWithOrder >= 2) {
          // No MM response after 2 ticks — assume no MM active, go direct
          console.log('[LADDER] No MM response after 2 ticks — going direct');
          await tryCancelOrder(activeOrderId);
          activeOrderId = null;
          try {
            const buyResp = await placeOrder(BOT_TAG, ticker, side, 'buy', mode.buyContracts, currentAsk);
            buyPlaced = true;
            buyPriceCents = currentAsk;
            buyOrderId = buyResp.order.order_id;
            console.log(`[LADDER] No-MM direct buy @ ${currentAsk}¢ orderId:${buyOrderId}`);
          } catch (err) {
            console.error('[LADDER] No-MM direct buy failed:', err);
          }
          runStatus = 'done';
          break;
        }
      } else {
        // EXIT mode: lower the sell price after 2 ticks with no fill
        if (ticksWithOrder >= 2) {
          console.log(`[LADDER] No fill after 2 ticks at ${activeOrderPriceCents}¢ — lowering price`);
          await tryCancelOrder(activeOrderId);
          activeOrderId = null;
          ticksWithOrder = 0;
          exitSellPrice -= ladderStepCents;

          if (exitSellPrice <= currentBid) {
            // Reached bid — go direct
            const remaining = mode.sellContracts - sellFills;
            console.log(`[LADDER] Exit price hit bid ${currentBid}¢ — selling direct`);
            try {
              await placeOrder(BOT_TAG, ticker, side, 'sell', remaining, currentBid);
              sellFills = mode.sellContracts;
            } catch (err) {
              console.error('[LADDER] Exit direct sell failed:', err);
            }
            runStatus = 'done';
            break;
          }
        }
      }
    }
  }

  const result: LadderResult = {
    status: runStatus,
    sellFills,
    finalAskCents: currentAsk,
    buyPlaced,
    buyPriceCents,
    buyOrderId,
  };

  console.log(`[LADDER] Complete — status:${result.status} sellFills:${sellFills} finalAsk:${currentAsk}¢ buyPlaced:${buyPlaced} buyPrice:${buyPriceCents}¢`);
  return result;
}

// ---------------------------------------------------------------------------
// goDirect helper — skip ladder, execute immediately
// ---------------------------------------------------------------------------

async function goDirect(ctx: {
  ticker: string;
  side: 'yes' | 'no';
  mode: LadderMode;
  config: { askKey: string; bidKey: string };
  botTag: string;
  fetchMarket: () => Promise<any>;
  placeOrder: typeof placeOrder;
}): Promise<LadderResult> {
  const { ticker, side, mode, config: { askKey, bidKey }, botTag, fetchMarket } = ctx;
  let currentAsk = 50;
  let currentBid = 50;

  try {
    const market = await fetchMarket();
    currentAsk = (market as any)[askKey] ?? 50;
    currentBid = (market as any)[bidKey] ?? 50;
  } catch {
    // use defaults if market fetch fails
  }

  if (mode.type === 'entry') {
    console.log(`[LADDER] Direct entry buy @ ${currentAsk}¢`);
    try {
      const buyResp = await ctx.placeOrder(botTag, ticker, side, 'buy', mode.buyContracts, currentAsk);
      return { status: 'done', sellFills: 0, finalAskCents: currentAsk, buyPlaced: true, buyPriceCents: currentAsk, buyOrderId: buyResp.order.order_id };
    } catch (err) {
      console.error('[LADDER] Direct buy failed:', err);
      return { status: 'aborted', sellFills: 0, finalAskCents: currentAsk, buyPlaced: false, buyPriceCents: 0 };
    }
  } else {
    console.log(`[LADDER] Direct exit sell @ ${currentBid}¢`);
    try {
      await ctx.placeOrder(botTag, ticker, side, 'sell', mode.sellContracts, currentBid);
    } catch (err) {
      console.error('[LADDER] Direct sell failed:', err);
      return { status: 'aborted', sellFills: 0, finalAskCents: currentAsk, buyPlaced: false, buyPriceCents: 0 };
    }
    return { status: 'done', sellFills: mode.sellContracts, finalAskCents: currentAsk, buyPlaced: false, buyPriceCents: 0 };
  }
}
