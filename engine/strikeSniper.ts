/**
 * Strike Sniper
 *
 * Replaces the Arb Scanner slot. Buys cheap OTM contracts exploiting two
 * distinct opportunities:
 *
 * 1. 15-min sniper: After minute 7 of a 15-min window, if BTC has moved
 *    strongly (> momentumThreshold %), buy an OTM contract in the direction
 *    of momentum. OTM prices don't reach snipe range (≤ 20¢) until the
 *    second half of the window's life.
 *
 * 2. Hourly dislocation sniper: In the last 10 minutes of hourly KXBTCD
 *    contracts, when BTC is within btcProximityDollars of the strike, brief
 *    mispricings occur. YES price dips when BTC moves toward strike
 *    (profit-takers selling) → buy YES. YES price spikes when BTC moves
 *    away (fearful sellers) → buy NO.
 *
 * No AI — purely algorithmic. Uses limit + IOC orders so no resting orders
 * linger in illiquid OTM books.
 *
 * Exports the same function names as arbScanner.ts for drop-in compatibility
 * with botOrchestrator.ts.
 */

import { randomUUID } from 'crypto';
import { getKalshiClient } from '@/lib/kalshi/client';
import { getPrice } from './btcFeed';
import { readBotConfig } from '@/lib/utils/botConfig';
import { logTradeToFile, openTradeLifecycle, closeTradeLifecycle } from './positionTracker';
import { getMarketCached, findHourlyMarkets, clearMarketCache } from '@/lib/kalshi/markets';
import { KalshiMarket, BotPosition } from '@/lib/kalshi/types';
import * as fs from 'fs';
import * as path from 'path';

const LOOP_INTERVAL_MS = 10_000; // 10-second polling
const BOT_POSITIONS_FILE = path.resolve('./data/bot-positions.json');

// ── Normal CDF (erf approximation) ────────────────────────────────────────────

function normCdf(x: number): number {
  // Abramowitz and Stegun approximation
  const t = 1.0 / (1.0 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return x > 0 ? 1 - p : p;
}

/**
 * Estimate fair YES probability using log-normal diffusion.
 * P(BTC_T > strike) = N(d)  where  d = log(S/K) / (σ√T)
 * σ is in $/√min, T is minutes remaining.
 */
function estimateFairYes(btcPrice: number, strike: number, sigmaPerSqrtMin: number, minsRemaining: number): number {
  if (minsRemaining <= 0 || sigmaPerSqrtMin <= 0 || btcPrice <= 0 || strike <= 0) return 0.5;
  const sigmaT = sigmaPerSqrtMin * Math.sqrt(minsRemaining);
  if (sigmaT <= 0) return 0.5;
  const d = Math.log(btcPrice / strike) / sigmaT;
  return Math.max(0.01, Math.min(0.99, normCdf(d)));
}

// ── Strike parsing (same pattern as markets.ts parseStrike) ──────────────────

function parseStrikeFromTicker(ticker: string): number | undefined {
  const m = ticker.match(/-T(\d+(?:\.\d+)?)$/);
  if (m) return parseFloat(m[1]);
  return undefined;
}

// ── Position persistence ───────────────────────────────────────────────────────

function readBotPositions(): Record<string, BotPosition> {
  try {
    if (fs.existsSync(BOT_POSITIONS_FILE)) {
      return JSON.parse(fs.readFileSync(BOT_POSITIONS_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

function writeBotPositions(positions: Record<string, BotPosition>): void {
  try {
    const dir = path.dirname(BOT_POSITIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = BOT_POSITIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(positions, null, 2));
    fs.renameSync(tmp, BOT_POSITIONS_FILE);
  } catch (e) {
    console.error('[SNIPER] Failed to write positions:', e);
  }
}

// ── Daily P&L from trades.json ────────────────────────────────────────────────

function calculateDailyPnL(): { pnl: number; count: number } {
  try {
    const tradesPath = path.resolve('./data/trades.json');
    if (!fs.existsSync(tradesPath)) return { pnl: 0, count: 0 };
    const data = JSON.parse(fs.readFileSync(tradesPath, 'utf8'));
    const today = new Date().toISOString().split('T')[0];
    if (data.daily?.date !== today) return { pnl: 0, count: 0 };
    const arbTrades = data.daily.trades.filter((t: { strategy: string }) => t.strategy === 'arb');
    const pnl = arbTrades.reduce((s: number, t: { netPnL: number }) => s + t.netPnL, 0);
    return { pnl, count: arbTrades.length };
  } catch {
    return { pnl: 0, count: 0 };
  }
}

// ── 15-min window key (same helper as fifteenMinBot) ─────────────────────────

function get15MinWindowKey(): string {
  const now = new Date();
  const minutes = Math.floor(now.getMinutes() / 15) * 15;
  return `${now.toISOString().split('T')[0]}-${now.getUTCHours()}-${minutes}`;
}

function getHourlyWindowKey(): string {
  const now = new Date();
  return `${now.toISOString().split('T')[0]}-${now.getUTCHours()}`;
}

// ── IOC limit order ────────────────────────────────────────────────────────────

async function placeIOCLimitOrder(
  ticker: string,
  side: 'yes' | 'no',
  contracts: number,
  priceCents: number,
): Promise<{ orderId: string; status: string } | null> {
  const client = getKalshiClient();
  try {
    const response = await client.placeOrder({
      ticker,
      action: 'buy',
      side,
      type: 'limit',
      count: contracts,
      yes_price: side === 'yes' ? priceCents : undefined,
      no_price: side === 'no' ? priceCents : undefined,
      client_order_id: randomUUID(),
      time_in_force: 'immediate_or_cancel',
    });
    return {
      orderId: response.order.order_id,
      status: response.order.status,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[SNIPER] IOC order failed: ${msg}`);
    return null;
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

interface StrikeSniperState {
  running: boolean;
  intervalId?: NodeJS.Timeout;

  // 15-min sniper
  fifteenMinPosition: BotPosition | null;
  tradedThisWindow: boolean;
  currentWindowKey: string;
  windowOpenBtcPrice: number;

  // Hourly dislocation sniper
  hourlyPosition: BotPosition | null;
  tradedThisHourlyWindow: boolean;
  currentHourlyWindowKey: string;
  prevHourlyBtcPrice: number; // BTC price from previous tick (direction detection)

  // Shared
  dailyPnL: number;
  tradesCount: number;
  lastError?: string;
  lastTriggerDetail?: string;
}

let sniperState: StrikeSniperState | null = null;

// ── Find all open KXBTC15M markets with parsed strikes ────────────────────────

async function fetchKxbtc15mMarketsWithStrikes(): Promise<Array<{ market: KalshiMarket; strike: number }>> {
  const client = getKalshiClient();
  const now = Date.now();

  const markets = await client.getMarkets('KXBTC15M', 'open');
  const isActive = (m: KalshiMarket) => m.status === 'open' || m.status === 'active';
  const notExpired = (m: KalshiMarket) => new Date(m.close_time).getTime() > now - 90_000;

  return markets
    .filter(m => isActive(m) && notExpired(m))
    .map(m => ({ market: m, strike: parseStrikeFromTicker(m.ticker) }))
    .filter((x): x is { market: KalshiMarket; strike: number } => x.strike !== undefined)
    .sort((a, b) => a.strike - b.strike);
}

// ── Main sniper loop ───────────────────────────────────────────────────────────

async function sniperLoop(): Promise<void> {
  if (!sniperState?.running) return;

  try {
    const config = readBotConfig();
    if (!config.arb.enabled) {
      stopArbScanner();
      return;
    }

    const arbConfig = config.arb;
    const btcPrice = getPrice();
    if (btcPrice <= 0) return;

    // Daily loss guard
    const { pnl, count } = calculateDailyPnL();
    sniperState.dailyPnL = pnl;
    sniperState.tradesCount = count;

    if (pnl < -arbConfig.maxDailyLoss) {
      sniperState.lastError = `Daily loss limit: $${pnl.toFixed(2)} (paused until next day)`;
      return;
    }
    // Clear stale error message once recovered
    if (sniperState.lastError?.startsWith('Daily loss limit')) {
      sniperState.lastError = undefined;
    }

    // ── 15-MIN SNIPER PATH ────────────────────────────────────────────────────

    const windowKey = get15MinWindowKey();

    // New 15-min window: reset state
    if (windowKey !== sniperState.currentWindowKey) {
      sniperState.currentWindowKey = windowKey;
      sniperState.tradedThisWindow = false;
      sniperState.windowOpenBtcPrice = btcPrice;
      console.log(`[SNIPER] New 15-min window: ${windowKey} | BTC open: $${btcPrice.toFixed(0)}`);
    }

    // Restore tradedThisWindow from saved position after restart
    const positions = readBotPositions();
    sniperState.fifteenMinPosition = positions.arb || null;

    if (sniperState.fifteenMinPosition && !sniperState.tradedThisWindow) {
      const posTime = new Date(sniperState.fifteenMinPosition.entryTime);
      const posWindowMinutes = Math.floor(posTime.getMinutes() / 15) * 15;
      const posWindowKey = `${posTime.toISOString().split('T')[0]}-${posTime.getUTCHours()}-${posWindowMinutes}`;
      if (posWindowKey === windowKey) {
        sniperState.tradedThisWindow = true;
      }
    }

    // Check / settle existing 15-min position
    if (sniperState.fifteenMinPosition) {
      await monitor15MinPosition(btcPrice);
    }

    // Entry logic: only after minute 7, only if not yet traded this window
    if (!sniperState.tradedThisWindow) {
      const minuteInWindow = new Date().getMinutes() % 15;

      if (minuteInWindow < 7) {
        // Monitor-only phase: compute return but don't trade
        if (sniperState.windowOpenBtcPrice > 0) {
          const monitorReturn = (btcPrice - sniperState.windowOpenBtcPrice) / sniperState.windowOpenBtcPrice * 100;
          if (Math.abs(monitorReturn) >= arbConfig.momentumThreshold) {
            console.log(
              `[SNIPER] Pre-minute-7 monitor: BTC ${monitorReturn >= 0 ? '+' : ''}${monitorReturn.toFixed(3)}% ` +
              `(threshold ${arbConfig.momentumThreshold}%) — will check at min 7+`
            );
          }
        }
      } else {
        // Active entry window: minute 7+
        await try15MinEntry(btcPrice, arbConfig);
      }
    }

    // ── HOURLY DISLOCATION PATH ───────────────────────────────────────────────

    const hourlyKey = getHourlyWindowKey();
    if (hourlyKey !== sniperState.currentHourlyWindowKey) {
      sniperState.currentHourlyWindowKey = hourlyKey;
      sniperState.tradedThisHourlyWindow = false;
      sniperState.prevHourlyBtcPrice = btcPrice;
    }

    // Load / check existing hourly position
    const allPositions = readBotPositions();
    sniperState.hourlyPosition = allPositions['arb-hourly'] || null;

    if (sniperState.hourlyPosition) {
      await monitorHourlyPosition(btcPrice);
    }

    if (!sniperState.tradedThisHourlyWindow && !sniperState.hourlyPosition) {
      await tryHourlyEntry(btcPrice, arbConfig);
    }

    sniperState.prevHourlyBtcPrice = btcPrice;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (sniperState) sniperState.lastError = msg;
    console.error('[SNIPER] Loop error:', msg);
  }
}

// ── 15-min entry attempt ───────────────────────────────────────────────────────

async function try15MinEntry(btcPrice: number, arbConfig: ReturnType<typeof readBotConfig>['arb']): Promise<void> {
  if (!sniperState) return;

  if (sniperState.windowOpenBtcPrice <= 0) {
    sniperState.windowOpenBtcPrice = btcPrice;
    return;
  }

  const windowReturn = (btcPrice - sniperState.windowOpenBtcPrice) / sniperState.windowOpenBtcPrice * 100;

  if (Math.abs(windowReturn) < arbConfig.momentumThreshold) {
    return; // Not enough momentum
  }

  const direction = windowReturn > 0 ? 'yes' : 'no';
  console.log(
    `[SNIPER] 15M momentum signal | ` +
    `BTC ${windowReturn >= 0 ? '+' : ''}${windowReturn.toFixed(3)}% | ` +
    `Direction: ${direction.toUpperCase()}`
  );

  // Fetch all KXBTC15M markets with strikes
  let marketsWithStrikes: Array<{ market: KalshiMarket; strike: number }>;
  try {
    marketsWithStrikes = await fetchKxbtc15mMarketsWithStrikes();
  } catch (err) {
    console.warn('[SNIPER] Failed to fetch 15M markets:', err instanceof Error ? err.message : err);
    return;
  }

  if (marketsWithStrikes.length === 0) {
    console.warn('[SNIPER] No KXBTC15M markets with strikes found');
    return;
  }

  // Find first OTM strike in the direction of momentum
  let targetMarket: { market: KalshiMarket; strike: number } | undefined;
  if (direction === 'yes') {
    // OTM YES: strike > current price, first one above
    targetMarket = marketsWithStrikes.find(m => m.strike > btcPrice);
  } else {
    // OTM NO: strike < current price, first one below (last in sorted asc array)
    const below = marketsWithStrikes.filter(m => m.strike < btcPrice);
    targetMarket = below[below.length - 1]; // closest below
  }

  if (!targetMarket) {
    console.warn(`[SNIPER] No OTM ${direction.toUpperCase()} strike found for BTC $${btcPrice.toFixed(0)}`);
    return;
  }

  const market = targetMarket.market;
  const strike = targetMarket.strike;
  const askCents = direction === 'yes' ? market.yes_ask : market.no_ask;

  console.log(
    `[SNIPER] OTM target: ${market.ticker} | Strike: $${strike.toFixed(0)} | ` +
    `${direction.toUpperCase()} ask: ${askCents}¢`
  );

  if (askCents <= 0 || askCents > arbConfig.maxEntryPriceCents) {
    console.log(
      `[SNIPER] Ask ${askCents}¢ out of range (max ${arbConfig.maxEntryPriceCents}¢) — skipping`
    );
    sniperState.tradedThisWindow = true; // don't retry this window
    return;
  }

  const contracts = Math.floor(arbConfig.capitalPerTrade / (askCents / 100));
  if (contracts < 1) {
    console.log(`[SNIPER] Insufficient capital for entry ($${arbConfig.capitalPerTrade} at ${askCents}¢)`);
    sniperState.tradedThisWindow = true;
    return;
  }

  const result = await placeIOCLimitOrder(market.ticker, direction, contracts, askCents);
  sniperState.tradedThisWindow = true; // prevent retries regardless of fill

  if (!result) {
    console.warn('[SNIPER] IOC order not placed');
    return;
  }

  const triggerDetail = `${windowReturn >= 0 ? '+' : ''}${windowReturn.toFixed(2)}% → ${direction.toUpperCase()} ${strike.toFixed(0)} @ ${askCents}¢`;
  sniperState.lastTriggerDetail = triggerDetail;

  const position: BotPosition = {
    bot: 'arb',
    ticker: market.ticker,
    side: direction,
    contracts,
    entryPrice: askCents / 100,
    totalCost: contracts * (askCents / 100),
    entryTime: new Date().toISOString(),
    btcPriceAtEntry: btcPrice,
    strike,
    orderId: result.orderId,
    fills: [],
    signalName: `15M SNIPER: ${triggerDetail}`,
  };

  sniperState.fifteenMinPosition = position;
  const allPositions = readBotPositions();
  allPositions['arb'] = position;
  writeBotPositions(allPositions);

  openTradeLifecycle({
    tradeId: result.orderId,
    bot: 'arb',
    ticker: market.ticker,
    side: direction,
    contracts,
    entryPrice: askCents / 100,
    entryTime: position.entryTime,
    entryBtcPrice: btcPrice,
    signal: position.signalName || '15M SNIPER',
  });

  console.log(
    `[SNIPER] 15M ENTRY | ${direction.toUpperCase()} | ` +
    `${market.ticker} | Strike: $${strike.toFixed(0)} | ` +
    `${askCents}¢ × ${contracts} = $${position.totalCost.toFixed(2)} | ` +
    `Order: ${result.orderId} (${result.status})`
  );
}

// ── Hourly dislocation entry attempt ──────────────────────────────────────────

async function tryHourlyEntry(btcPrice: number, arbConfig: ReturnType<typeof readBotConfig>['arb']): Promise<void> {
  if (!sniperState) return;

  // Fetch current hourly markets
  let hourlyResult: Awaited<ReturnType<typeof findHourlyMarkets>>;
  try {
    hourlyResult = await findHourlyMarkets(btcPrice);
  } catch (err) {
    return; // Silently skip — hourly markets may not always be available
  }

  // Check the floor-strike market (BTC closest below)
  const hourlyMarket = hourlyResult.floorStrike;
  const hourlyStrike = hourlyResult.floorStrikeValue;

  if (!hourlyMarket || !hourlyStrike) return;

  // Minutes remaining in the hourly window
  const closeTime = new Date(hourlyMarket.close_time).getTime();
  const minsRemaining = (closeTime - Date.now()) / 60000;

  if (minsRemaining > 10 || minsRemaining < 0.5) return; // only last 10 minutes

  // Distance from strike
  const distance = Math.abs(btcPrice - hourlyStrike);
  if (distance > arbConfig.btcProximityDollars) return;

  // BTC direction (compared to previous tick)
  const prevBtc = sniperState.prevHourlyBtcPrice;
  if (prevBtc <= 0) return;

  const btcMovingTowardStrike = (
    (btcPrice > hourlyStrike && prevBtc > btcPrice) || // BTC above strike, moving down toward it
    (btcPrice < hourlyStrike && prevBtc < btcPrice)    // BTC below strike, moving up toward it
  );

  // Estimate fair YES probability.
  // σ is dimensionless fraction per sqrt-min: hourly vol ~0.5% → 0.005/sqrt(60)
  const roughSigma = 0.005 / Math.sqrt(60); // ~0.000645 per sqrt-min
  const fairYes = estimateFairYes(btcPrice, hourlyStrike, roughSigma, minsRemaining);
  const fairYesCents = fairYes * 100;
  const marketYesAsk = hourlyMarket.yes_ask;
  const marketNoAsk = hourlyMarket.no_ask;

  // Dislocation threshold: 10¢ divergence from fair value
  const DISLOC_THRESHOLD = 10;

  let direction: 'yes' | 'no' | null = null;
  let askCents = 0;
  let dislocReason = '';

  if (btcMovingTowardStrike && marketYesAsk > 0 && marketYesAsk < fairYesCents - DISLOC_THRESHOLD) {
    // Profit-takers sold YES too cheap → buy YES
    direction = 'yes';
    askCents = marketYesAsk;
    dislocReason = `YES dip: mkt=${marketYesAsk}¢ < fair=${fairYesCents.toFixed(1)}¢ (profit-takers)`;
  } else if (!btcMovingTowardStrike && marketYesAsk > 0 && marketYesAsk > fairYesCents + DISLOC_THRESHOLD) {
    // Fearful sellers pushed YES too high → buy NO
    direction = 'no';
    askCents = marketNoAsk;
    dislocReason = `NO cheap: YES mkt=${marketYesAsk}¢ > fair=${fairYesCents.toFixed(1)}¢ (fearful sellers)`;
  }

  if (!direction || askCents <= 0 || askCents > arbConfig.maxEntryPriceCents) return;

  const contracts = Math.floor(arbConfig.capitalPerTrade / (askCents / 100));
  if (contracts < 1) return;

  const result = await placeIOCLimitOrder(hourlyMarket.ticker, direction, contracts, askCents);
  sniperState.tradedThisHourlyWindow = true;

  if (!result) return;

  const triggerDetail = `HRLY DISLOC → ${direction.toUpperCase()} ${hourlyStrike} @ ${askCents}¢`;
  sniperState.lastTriggerDetail = triggerDetail;

  const position: BotPosition = {
    bot: 'arb',
    ticker: hourlyMarket.ticker,
    side: direction,
    contracts,
    entryPrice: askCents / 100,
    totalCost: contracts * (askCents / 100),
    entryTime: new Date().toISOString(),
    btcPriceAtEntry: btcPrice,
    strike: hourlyStrike,
    orderId: result.orderId,
    fills: [],
    signalName: `HRLY SNIPER: ${dislocReason}`,
  };

  sniperState.hourlyPosition = position;
  const allPositions = readBotPositions();
  allPositions['arb-hourly'] = position;
  writeBotPositions(allPositions);

  openTradeLifecycle({
    tradeId: result.orderId,
    bot: 'arb',
    ticker: hourlyMarket.ticker,
    side: direction,
    contracts,
    entryPrice: askCents / 100,
    entryTime: position.entryTime,
    entryBtcPrice: btcPrice,
    signal: position.signalName || 'HRLY SNIPER',
  });

  console.log(
    `[SNIPER] HOURLY ENTRY | ${direction.toUpperCase()} | ` +
    `${hourlyMarket.ticker} | Strike: $${hourlyStrike} | ` +
    `${askCents}¢ × ${contracts} | ${dislocReason} | ` +
    `${minsRemaining.toFixed(1)}m remaining`
  );
}

// ── Position monitoring: 15-min ────────────────────────────────────────────────

async function monitor15MinPosition(btcPrice: number): Promise<void> {
  const pos = sniperState?.fifteenMinPosition;
  if (!pos) return;

  try {
    clearMarketCache();
    const market = await getMarketCached(pos.ticker);

    if (market.status === 'settled') {
      const isWin = market.result === pos.side;
      const exitPrice = isWin ? 1.0 : 0.0;
      const netPnL = isWin
        ? (pos.contracts * (1 - pos.entryPrice)) * 0.93  // ~7% settlement fee
        : -pos.totalCost;

      logTradeToFile({
        id: pos.orderId || `arb-${Date.now()}`,
        timestamp: pos.entryTime,
        strategy: 'arb' as any,
        direction: pos.side,
        strike: pos.strike,
        entryPrice: pos.entryPrice,
        exitPrice,
        exitType: 'settlement',
        contracts: pos.contracts,
        netPnL,
        won: isWin,
        exitReason: `Settlement ${isWin ? 'WIN' : 'LOSS'}: BTC $${btcPrice.toFixed(0)} [${pos.signalName}]`,
      });

      if (pos.orderId) {
        closeTradeLifecycle({
          tradeId: pos.orderId,
          exitTime: new Date().toISOString(),
          exitBtcPrice: btcPrice,
          exitType: 'settlement',
          exitPrice,
          finalPnL: netPnL,
          won: isWin,
        });
      }

      const allPositions = readBotPositions();
      delete allPositions['arb'];
      writeBotPositions(allPositions);
      if (sniperState) sniperState.fifteenMinPosition = null;

      console.log(`[SNIPER] 15M SETTLED | ${isWin ? 'WIN' : 'LOSS'} | P&L: $${netPnL.toFixed(2)}`);
    }
  } catch (err) {
    console.error('[SNIPER] 15M position monitor error:', err instanceof Error ? err.message : err);
  }
}

// ── Position monitoring: hourly ────────────────────────────────────────────────

async function monitorHourlyPosition(btcPrice: number): Promise<void> {
  const pos = sniperState?.hourlyPosition;
  if (!pos) return;

  try {
    clearMarketCache();
    const market = await getMarketCached(pos.ticker);

    if (market.status === 'settled') {
      const isWin = market.result === pos.side;
      const exitPrice = isWin ? 1.0 : 0.0;
      const netPnL = isWin
        ? (pos.contracts * (1 - pos.entryPrice)) * 0.93
        : -pos.totalCost;

      logTradeToFile({
        id: pos.orderId || `arb-h-${Date.now()}`,
        timestamp: pos.entryTime,
        strategy: 'arb' as any,
        direction: pos.side,
        strike: pos.strike,
        entryPrice: pos.entryPrice,
        exitPrice,
        exitType: 'settlement',
        contracts: pos.contracts,
        netPnL,
        won: isWin,
        exitReason: `Settlement ${isWin ? 'WIN' : 'LOSS'}: BTC $${btcPrice.toFixed(0)} [${pos.signalName}]`,
      });

      if (pos.orderId) {
        closeTradeLifecycle({
          tradeId: pos.orderId,
          exitTime: new Date().toISOString(),
          exitBtcPrice: btcPrice,
          exitType: 'settlement',
          exitPrice,
          finalPnL: netPnL,
          won: isWin,
        });
      }

      const allPositions = readBotPositions();
      delete allPositions['arb-hourly'];
      writeBotPositions(allPositions);
      if (sniperState) sniperState.hourlyPosition = null;

      console.log(`[SNIPER] HOURLY SETTLED | ${isWin ? 'WIN' : 'LOSS'} | P&L: $${netPnL.toFixed(2)}`);
    }
  } catch (err) {
    console.error('[SNIPER] Hourly position monitor error:', err instanceof Error ? err.message : err);
  }
}

// ── Public API (same names as arbScanner for orchestrator compatibility) ───────

export function startArbScanner(): void {
  if (sniperState?.running) {
    console.log('[SNIPER] Already running');
    return;
  }

  const btcPrice = getPrice();
  sniperState = {
    running: true,
    fifteenMinPosition: null,
    tradedThisWindow: false,
    currentWindowKey: get15MinWindowKey(),
    windowOpenBtcPrice: btcPrice > 0 ? btcPrice : 0,
    hourlyPosition: null,
    tradedThisHourlyWindow: false,
    currentHourlyWindowKey: getHourlyWindowKey(),
    prevHourlyBtcPrice: btcPrice > 0 ? btcPrice : 0,
    dailyPnL: 0,
    tradesCount: 0,
  };

  // Hot-reload guard: clear any orphaned interval from a previous module load
  const g = global as any;
  if (g.__strikeSniperInterval) clearInterval(g.__strikeSniperInterval);

  sniperState.intervalId = setInterval(() => sniperLoop(), LOOP_INTERVAL_MS);
  g.__strikeSniperInterval = sniperState.intervalId;

  // Run immediately
  sniperLoop();

  console.log('[SNIPER] Strike Sniper started — 15-min + hourly dislocation modes, 10s loop');
}

export function stopArbScanner(): void {
  if (!sniperState?.running) return;

  if (sniperState.intervalId) {
    clearInterval(sniperState.intervalId);
    sniperState.intervalId = undefined;
  }
  sniperState.running = false;

  const g = global as any;
  if (g.__strikeSniperInterval) {
    clearInterval(g.__strikeSniperInterval);
    g.__strikeSniperInterval = undefined;
  }

  console.log('[SNIPER] Strike Sniper stopped');
}

export function getArbScannerStatus() {
  if (!sniperState) {
    return {
      running: false,
      dailyPnL: 0,
      tradesCount: 0,
      hasFifteenMinPosition: false,
      hasHourlyPosition: false,
    };
  }
  return {
    running: sniperState.running,
    dailyPnL: sniperState.dailyPnL,
    tradesCount: sniperState.tradesCount,
    hasFifteenMinPosition: sniperState.fifteenMinPosition !== null,
    hasHourlyPosition: sniperState.hourlyPosition !== null,
    lastTriggerDetail: sniperState.lastTriggerDetail,
    lastError: sniperState.lastError,
  };
}
