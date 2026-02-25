/**
 * Grok Swing Bot
 *
 * Replaces strikeSniper in the 'arb' bot slot.
 *
 * Strategy: During heavy 15-min and hourly BTC volatility, option prices
 * sometimes move ahead of BTC (momentum traders front-run the anticipated
 * reversal). This creates a brief mispricing window. The bot:
 *
 * 1. Runs a fast 3-second loop tracking BTC velocity and ATM proximity.
 * 2. When both exceed thresholds, fires an immediate Grok wakeup to assess entry.
 * 3. Grok decides side/strike; algo executes via IOC limit → pending retry.
 * 4. Exits rule-based at 25% capture rate or when BTC crosses back through ATM.
 * 5. Covers both 15-min (KXBTC15M) and hourly (KXBTCD) contracts.
 *
 * Exports: startGrokSwingBot, stopGrokSwingBot, getGrokSwingBotStatus
 * (replaces startArbScanner / stopArbScanner / getArbScannerStatus)
 */

import { randomUUID } from 'crypto';
import { getKalshiClient } from '@/lib/kalshi/client';
import { getPrice } from './btcFeed';
import { readBotConfig } from '@/lib/utils/botConfig';
import { logTradeToFile, openTradeLifecycle, closeTradeLifecycle } from './positionTracker';
import { getMarketCached, clearMarketCache } from '@/lib/kalshi/markets';
import { placeOrder } from './kalshiTrader';
import { getGrokSwingEntry, getGrokMultiExitCheck } from '@/lib/ai/grokClient';
import { buildSwingEntryPrompt, buildMultiExitPrompt } from '@/lib/ai/grokPrompts';
import { calculateKalshiFeeBreakdown } from '@/lib/utils/fees';
import { BotPosition } from '@/lib/kalshi/types';
import * as fs from 'fs';
import * as path from 'path';

// ── Constants ──────────────────────────────────────────────────────────────────

const LOOP_INTERVAL_MS = 3_000;            // 3-second main loop
const SIGNAL_WAKEUP_COOLDOWN_MS = 90_000;  // min 90s between Grok wakeup calls
const EXIT_CHECK_INTERVAL_MS = 3 * 60_000; // Grok exit check every 3 minutes
const PENDING_ENTRY_TTL_MS = 60_000;       // pending entry expires after 60s
const BTC_DRIFT_THRESHOLD = 0.003;         // 0.3% drift cancels pending entry
const BOT_POSITIONS_FILE = path.resolve('./data/bot-positions.json');

// ── Math helpers (copied from strikeSniper) ───────────────────────────────────

function normCdf(x: number): number {
  const t = 1.0 / (1.0 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return x > 0 ? 1 - p : p;
}

function estimateFairYes(btcPrice: number, strike: number, sigmaPerSqrtMin: number, minsRemaining: number): number {
  if (minsRemaining <= 0 || sigmaPerSqrtMin <= 0 || btcPrice <= 0 || strike <= 0) return 0.5;
  const sigmaT = sigmaPerSqrtMin * Math.sqrt(minsRemaining);
  if (sigmaT <= 0) return 0.5;
  const d = Math.log(btcPrice / strike) / sigmaT;
  return Math.max(0.01, Math.min(0.99, normCdf(d)));
}

function parseStrikeFromTicker(ticker: string): number | undefined {
  const m = ticker.match(/-T(\d+(?:\.\d+)?)$/);
  if (m) return parseFloat(m[1]);
  return undefined;
}

// ── Window key helpers ─────────────────────────────────────────────────────────

function get15MinWindowKey(): string {
  const now = new Date();
  const minutes = Math.floor(now.getMinutes() / 15) * 15;
  return `${now.toISOString().split('T')[0]}-${now.getUTCHours()}-${minutes}`;
}

function getHourlyWindowKey(): string {
  const now = new Date();
  return `${now.toISOString().split('T')[0]}-${now.getUTCHours()}`;
}

// ── Position persistence ───────────────────────────────────────────────────────

function readBotPositions(): Record<string, unknown> {
  try {
    if (fs.existsSync(BOT_POSITIONS_FILE)) {
      return JSON.parse(fs.readFileSync(BOT_POSITIONS_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

function writeBotPositions(positions: Record<string, unknown>): void {
  try {
    const dir = path.dirname(BOT_POSITIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = BOT_POSITIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(positions, null, 2));
    fs.renameSync(tmp, BOT_POSITIONS_FILE);
  } catch (e) {
    console.error('[SWING] Failed to write positions:', e);
  }
}

// ── Daily P&L from trades.json ─────────────────────────────────────────────────

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

// ── IOC limit order (copied from strikeSniper) ────────────────────────────────

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
    console.warn(`[SWING] IOC order failed: ${msg}`);
    return null;
  }
}

// ── State ──────────────────────────────────────────────────────────────────────

interface GrokSwingBotState {
  running: boolean;
  intervalId?: NodeJS.Timeout;

  // 15-min tracking
  fifteenMinPosition: BotPosition | null;
  tradedThisWindow: boolean;
  currentWindowKey: string;
  windowOpenBtcPrice: number;

  // Hourly tracking
  hourlyPosition: BotPosition | null;
  tradedThisHourlyWindow: boolean;
  currentHourlyWindowKey: string;
  hourlyWindowOpenBtcPrice: number;

  // Signal detection: rolling ~90s ring buffer
  btcPriceHistory: Array<{ price: number; ts: number }>;
  lastSignalWakeupTime: number;  // cooldown: min 90s between wakeups
  lastGrokExitCheckTime: number; // normal 3-min exit check cycle

  // Pending entry (IOC missed → watch for fill opportunity)
  pendingEntry?: {
    windowType: '15min' | 'hourly';
    side: 'yes' | 'no';
    ticker: string;
    contracts: number;
    limitPriceCents: number;     // original ask (re-check against this)
    btcPriceAtDecision: number;
    expiresAt: number;           // Date.now() + PENDING_ENTRY_TTL_MS
  };

  dailyPnL: number;
  tradesCount: number;
  lastError?: string;
  lastSignalDetail?: string;
}

let botState: GrokSwingBotState | null = null;
let loopRunning = false;

// ── Active position handling ───────────────────────────────────────────────────

interface ActiveLegInfo {
  posKey: 'arb' | 'arb-hourly';
  position: BotPosition;
  windowOpenBtcPrice: number;
  windowType: '15min' | 'hourly';
  currentBid: number;
  winProb: number;
  minutesRemaining: number;
}

async function handleActivePositions(btcPrice: number, arbConfig: ReturnType<typeof readBotConfig>['arb']): Promise<void> {
  if (!botState) return;

  const toCheck: Array<{ posKey: 'arb' | 'arb-hourly'; position: BotPosition; windowOpenBtcPrice: number; windowType: '15min' | 'hourly' }> = [];

  if (botState.fifteenMinPosition) {
    toCheck.push({ posKey: 'arb', position: botState.fifteenMinPosition, windowOpenBtcPrice: botState.windowOpenBtcPrice, windowType: '15min' });
  }
  if (botState.hourlyPosition) {
    toCheck.push({ posKey: 'arb-hourly', position: botState.hourlyPosition, windowOpenBtcPrice: botState.hourlyWindowOpenBtcPrice, windowType: 'hourly' });
  }

  const surviving: Array<{ posKey: 'arb' | 'arb-hourly'; position: BotPosition; windowOpenBtcPrice: number; windowType: '15min' | 'hourly' }> = [];
  const forGrokCheck: ActiveLegInfo[] = [];

  for (const item of toCheck) {
    const { posKey, position: pos, windowOpenBtcPrice } = item;

    try {
      clearMarketCache();
      const market = await getMarketCached(pos.ticker);

      // Settlement
      if (market.status === 'settled') {
        const isWin = market.result === pos.side;
        const exitPrice = isWin ? 1.0 : 0.0;
        const breakdown = calculateKalshiFeeBreakdown(pos.contracts, pos.entryPrice, exitPrice, 'settlement');

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
          netPnL: breakdown.netPnL,
          won: isWin,
          exitReason: `Settlement ${isWin ? 'WIN' : 'LOSS'}: BTC $${btcPrice.toFixed(0)} [${pos.signalName ?? ''}]`,
        });

        if (pos.orderId) {
          closeTradeLifecycle({
            tradeId: pos.orderId,
            exitTime: new Date().toISOString(),
            exitBtcPrice: btcPrice,
            exitType: 'settlement',
            exitPrice,
            finalPnL: breakdown.netPnL,
            won: isWin,
          });
        }

        console.log(`[SWING] Settlement ${isWin ? 'WIN' : 'LOSS'} | ${pos.ticker} | P&L: $${breakdown.netPnL.toFixed(2)}`);
        continue; // removed from surviving
      }

      // Waiting for settlement result
      if (market.status === 'closed') {
        surviving.push(item);
        continue;
      }

      const now = Date.now();
      const currentBid = pos.side === 'yes' ? market.yes_bid : market.no_bid;
      const currentAsk = pos.side === 'yes' ? market.yes_ask : market.no_ask;
      const winProb = currentBid > 0 && currentAsk > 0 ? (currentBid + currentAsk) / 2 : currentBid;
      const breakdown = calculateKalshiFeeBreakdown(pos.contracts, pos.entryPrice, currentBid / 100, 'early');
      const minutesRemaining = Math.max(0, (new Date(market.close_time).getTime() - now) / 60_000);
      const entryPriceCents = pos.entryPrice * 100;

      // Capture rate: fraction of maximum possible gain already locked in
      const captureRate = currentBid > entryPriceCents
        ? (currentBid - entryPriceCents) / (100 - entryPriceCents)
        : 0;

      // BTC crossed back through ATM against position direction
      const btcCrossedAgainst = pos.side === 'yes'
        ? btcPrice < windowOpenBtcPrice   // YES: BTC fell back below ATM
        : btcPrice > windowOpenBtcPrice;  // NO: BTC rose back above ATM

      // Evaluate exit conditions
      let exitReason: string | null = null;
      if (winProb < 10 && currentBid > 0) {
        exitReason = `Hard stop: win prob ${winProb.toFixed(1)}%`;
      } else if (captureRate >= arbConfig.exitCaptureRate) {
        exitReason = `Capture rate ${(captureRate * 100).toFixed(1)}% (target ${(arbConfig.exitCaptureRate * 100).toFixed(0)}%)`;
      } else if (btcCrossedAgainst && currentBid > 0) {
        exitReason = `BTC crossed ATM $${windowOpenBtcPrice.toFixed(0)} against ${pos.side.toUpperCase()}`;
      } else if (minutesRemaining < 2 && breakdown.netPnL > 0 && currentBid > 0) {
        exitReason = `Near-settlement profit protect (${minutesRemaining.toFixed(1)}m left)`;
      }

      if (exitReason && currentBid > 0) {
        try {
          await placeOrder('arb', pos.ticker, pos.side, 'sell', pos.contracts, currentBid);

          logTradeToFile({
            id: pos.orderId || `arb-${Date.now()}`,
            timestamp: pos.entryTime,
            strategy: 'arb' as any,
            direction: pos.side,
            strike: pos.strike,
            entryPrice: pos.entryPrice,
            exitPrice: currentBid / 100,
            exitType: 'early',
            contracts: pos.contracts,
            netPnL: breakdown.netPnL,
            won: breakdown.netPnL > 0,
            exitReason: `[SWING] ${exitReason}`,
          });

          if (pos.orderId) {
            closeTradeLifecycle({
              tradeId: pos.orderId,
              exitTime: new Date().toISOString(),
              exitBtcPrice: btcPrice,
              exitType: 'early',
              exitPrice: currentBid / 100,
              finalPnL: breakdown.netPnL,
              won: breakdown.netPnL > 0,
            });
          }

          console.log(`[SWING] Exit: ${exitReason} | ${pos.ticker} | P&L: $${breakdown.netPnL.toFixed(2)}`);
          // Don't add to surviving — position closed
        } catch (err) {
          console.error(`[SWING] Exit failed for ${pos.ticker}:`, err instanceof Error ? err.message : err);
          surviving.push(item);
        }
        continue;
      }

      // Passes all rule checks — keep and queue for Grok exit check
      surviving.push(item);
      if (currentBid > 0) {
        forGrokCheck.push({ ...item, currentBid, winProb, minutesRemaining });
      }

    } catch (err) {
      console.error(`[SWING] Error monitoring ${pos.ticker}:`, err instanceof Error ? err.message : err);
      surviving.push(item);
    }
  }

  // Grok multi-exit check every 3 minutes
  const now = Date.now();
  if (forGrokCheck.length > 0 && (now - botState.lastGrokExitCheckTime) >= EXIT_CHECK_INTERVAL_MS) {
    botState.lastGrokExitCheckTime = now;

    const exitPrompt = buildMultiExitPrompt({
      legs: forGrokCheck.map(({ position: pos, currentBid, winProb, minutesRemaining }) => ({
        ticker: pos.ticker,
        side: pos.side,
        contracts: pos.contracts,
        entryPrice: pos.entryPrice,
        unrealizedPnL: calculateKalshiFeeBreakdown(pos.contracts, pos.entryPrice, currentBid / 100, 'early').netPnL,
        currentBid,
        winProb,
        minsRemaining: minutesRemaining,
        strike: pos.strike,
      })),
      btcPrice,
      suggestedRisk: 'medium',
    });

    const exitCheck = await getGrokMultiExitCheck(exitPrompt, 'grokSwing');
    console.log(`[SWING] Multi-exit check: ${JSON.stringify(exitCheck.exits)}`);

    for (const exitDecision of exitCheck.exits) {
      if (exitDecision.action !== 'EXIT') continue;

      const legInfo = forGrokCheck.find(l => l.position.ticker === exitDecision.ticker);
      if (!legInfo) continue;

      const { posKey, position: pos, currentBid } = legInfo;
      const breakdown = calculateKalshiFeeBreakdown(pos.contracts, pos.entryPrice, currentBid / 100, 'early');

      try {
        await placeOrder('arb', pos.ticker, pos.side, 'sell', pos.contracts, currentBid);

        logTradeToFile({
          id: pos.orderId || `arb-${Date.now()}`,
          timestamp: pos.entryTime,
          strategy: 'arb' as any,
          direction: pos.side,
          strike: pos.strike,
          entryPrice: pos.entryPrice,
          exitPrice: currentBid / 100,
          exitType: 'early',
          contracts: pos.contracts,
          netPnL: breakdown.netPnL,
          won: breakdown.netPnL > 0,
          exitReason: '[SWING] Grok multi-exit',
        });

        if (pos.orderId) {
          closeTradeLifecycle({
            tradeId: pos.orderId,
            exitTime: new Date().toISOString(),
            exitBtcPrice: btcPrice,
            exitType: 'early',
            exitPrice: currentBid / 100,
            finalPnL: breakdown.netPnL,
            won: breakdown.netPnL > 0,
          });
        }

        console.log(`[SWING] Grok exit | ${pos.ticker} | P&L: $${breakdown.netPnL.toFixed(2)}`);

        // Remove from surviving
        const idx = surviving.findIndex(s => s.posKey === posKey);
        if (idx !== -1) surviving.splice(idx, 1);
      } catch (err) {
        console.error(`[SWING] Grok exit failed for ${pos.ticker}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // Persist surviving positions
  botState.fifteenMinPosition = surviving.find(s => s.posKey === 'arb')?.position ?? null;
  botState.hourlyPosition = surviving.find(s => s.posKey === 'arb-hourly')?.position ?? null;

  const allPositions = readBotPositions();
  if (botState.fifteenMinPosition) {
    allPositions['arb'] = botState.fifteenMinPosition;
  } else {
    delete allPositions['arb'];
  }
  if (botState.hourlyPosition) {
    allPositions['arb-hourly'] = botState.hourlyPosition;
  } else {
    delete allPositions['arb-hourly'];
  }
  writeBotPositions(allPositions);
}

// ── Pending entry retry ────────────────────────────────────────────────────────

async function handlePendingEntry(btcPrice: number): Promise<void> {
  if (!botState?.pendingEntry) return;

  const p = botState.pendingEntry;

  // Check expiry
  if (Date.now() > p.expiresAt) {
    botState.pendingEntry = undefined;
    console.log('[SWING] Pending entry discarded: expired');
    return;
  }

  // Check BTC drift
  const drift = Math.abs(btcPrice - p.btcPriceAtDecision) / p.btcPriceAtDecision;
  if (drift > BTC_DRIFT_THRESHOLD) {
    botState.pendingEntry = undefined;
    console.log(`[SWING] Pending entry discarded: BTC drift ${(drift * 100).toFixed(2)}%`);
    return;
  }

  // Fetch fresh ask
  let freshAsk: number;
  try {
    const market = await getMarketCached(p.ticker);
    freshAsk = p.side === 'yes' ? market.yes_ask : market.no_ask;
  } catch {
    return; // skip this tick, try again next
  }

  if (freshAsk <= 0 || freshAsk > p.limitPriceCents + 1) {
    return; // ask still too high — keep waiting
  }

  // Ask is now in range — market buy at ask
  const result = await placeIOCLimitOrder(p.ticker, p.side, p.contracts, freshAsk);
  if (!result) return;

  const filled = result.status !== 'canceled' && result.status !== 'cancelled';
  if (!filled) return; // still not filled, keep waiting

  // Record position
  const posKey = p.windowType === 'hourly' ? 'arb-hourly' : 'arb';
  const position: BotPosition = {
    bot: 'arb',
    ticker: p.ticker,
    side: p.side,
    contracts: p.contracts,
    entryPrice: freshAsk / 100,
    totalCost: p.contracts * (freshAsk / 100),
    entryTime: new Date().toISOString(),
    btcPriceAtEntry: btcPrice,
    orderId: result.orderId,
    fills: [],
    signalName: 'SWING PENDING FILL',
  };

  if (p.windowType === 'hourly') {
    botState.hourlyPosition = position;
    botState.tradedThisHourlyWindow = true;
  } else {
    botState.fifteenMinPosition = position;
    botState.tradedThisWindow = true;
  }

  const allPositions = readBotPositions();
  allPositions[posKey] = position;
  writeBotPositions(allPositions);

  botState.pendingEntry = undefined;
  console.log(`[SWING] Pending entry filled | ${p.ticker} ${p.side.toUpperCase()} @ ${freshAsk}¢ × ${p.contracts} | Order: ${result.orderId}`);
}

// ── Grok swing wakeup ──────────────────────────────────────────────────────────

async function grokSwingWakeup(
  windowType: '15min' | 'hourly',
  btcPrice: number,
  velocity: number,
  atmBtcPrice: number,
  arbConfig: ReturnType<typeof readBotConfig>['arb'],
): Promise<void> {
  if (!botState) return;

  const atmDistance = Math.abs(btcPrice - atmBtcPrice);
  const velocityDirection = velocity > 0 ? 'up' : 'down';

  console.log(
    `[SWING] Grok wakeup | ${windowType} | ` +
    `vel=${velocity >= 0 ? '+' : ''}${velocity.toFixed(0)}$/min | ` +
    `ATM dist=$${atmDistance.toFixed(0)} | BTC $${btcPrice.toFixed(0)}`
  );

  // Fetch ATM-adjacent markets
  const client = getKalshiClient();
  const series = windowType === 'hourly' ? 'KXBTCD' : 'KXBTC15M';
  const now = Date.now();
  const ATM_RANGE_DOLLARS = 1000; // show strikes within $1000 of BTC

  let rawMarkets: Awaited<ReturnType<typeof client.getMarkets>>;
  try {
    rawMarkets = await client.getMarkets(series, 'open');
  } catch (err) {
    console.warn(`[SWING] Failed to fetch ${series} markets: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const strikeMarkets = rawMarkets
    .filter(m => {
      const strike = parseStrikeFromTicker(m.ticker);
      if (!strike) return false;
      const close = new Date(m.close_time).getTime();
      return close > now && Math.abs(strike - btcPrice) <= ATM_RANGE_DOLLARS;
    })
    .map(m => ({
      market: m,
      strike: parseStrikeFromTicker(m.ticker)!,
    }))
    .sort((a, b) => a.strike - b.strike);

  if (strikeMarkets.length === 0) {
    console.warn(`[SWING] No ATM-adjacent ${series} markets found`);
    return;
  }

  // Pick the closest market to ATM for minutes-remaining reference
  const atmMarket = strikeMarkets.reduce((best, m) =>
    Math.abs(m.strike - btcPrice) < Math.abs(best.strike - btcPrice) ? m : best
  );
  const minsRemaining = Math.max(0, (new Date(atmMarket.market.close_time).getTime() - now) / 60_000);

  // σ $/√min → approx. fraction per √min at current BTC price
  // hourly: ~0.5% BTC move per hour → σ = 0.005 * btcPrice / sqrt(60)
  // 15-min: ~0.3% BTC move per 15min → σ = 0.003 * btcPrice / sqrt(15)
  const roughSigmaFrac = windowType === 'hourly' ? 0.005 / Math.sqrt(60) : 0.003 / Math.sqrt(15);
  const roughSigma = roughSigmaFrac; // dimensionless fraction; estimateFairYes uses log-normal

  const strikesForPrompt = strikeMarkets.slice(0, 8).map(({ market, strike }) => ({
    ticker: market.ticker,
    strike,
    yesAsk: market.yes_ask,
    noAsk: market.no_ask,
    fairYesPct: estimateFairYes(btcPrice, strike, roughSigma, minsRemaining) * 100,
  }));

  // Build prompt and call Grok
  const prompt = buildSwingEntryPrompt({
    utcTime: new Date().toISOString(),
    btcPrice,
    velocity,
    velocityDirection,
    atmBtcPrice,
    atmDistance,
    minutesRemaining: minsRemaining,
    windowType,
    strikes: strikesForPrompt,
  });

  const decision = await getGrokSwingEntry(prompt, 'grokSwing');

  console.log(
    `[SWING] Grok: ${decision.action}` +
    (decision.action === 'ENTER' ? ` ${decision.side.toUpperCase()} ${decision.ticker}` : '') +
    ` — "${decision.reason}"`
  );

  if (decision.action !== 'ENTER') return;

  // Validate Grok's response
  const chosenStrike = strikesForPrompt.find(s => s.ticker === decision.ticker);
  if (!chosenStrike) {
    console.warn(`[SWING] Grok returned unknown ticker: ${decision.ticker}`);
    return;
  }
  if (!['yes', 'no'].includes(decision.side)) {
    console.warn(`[SWING] Grok returned invalid side: ${decision.side}`);
    return;
  }

  // Fetch fresh ask
  const freshAskCents = decision.side === 'yes' ? chosenStrike.yesAsk : chosenStrike.noAsk;
  if (freshAskCents <= 0 || freshAskCents > arbConfig.maxEntryPriceCents) {
    console.log(`[SWING] Ask ${freshAskCents}¢ out of range (max ${arbConfig.maxEntryPriceCents}¢) — skip`);
    return;
  }

  const limitPriceCents = Math.max(1, freshAskCents - arbConfig.limitDiscountCents);
  const contracts = Math.floor(arbConfig.capitalPerTrade / (freshAskCents / 100));
  if (contracts < 1) {
    console.log(`[SWING] Insufficient capital ($${arbConfig.capitalPerTrade}) at ${freshAskCents}¢ — skip`);
    return;
  }

  // Place IOC limit order
  const result = await placeIOCLimitOrder(decision.ticker, decision.side, contracts, limitPriceCents);
  if (!result) return;

  const filled = result.status !== 'canceled' && result.status !== 'cancelled';
  const signalName = `SWING ${windowType}: ${decision.side.toUpperCase()} vel=${velocity.toFixed(0)}$/min`;

  if (filled) {
    // Record position immediately
    const posKey = windowType === 'hourly' ? 'arb-hourly' : 'arb';
    const position: BotPosition = {
      bot: 'arb',
      ticker: decision.ticker,
      side: decision.side,
      contracts,
      entryPrice: limitPriceCents / 100,
      totalCost: contracts * (limitPriceCents / 100),
      entryTime: new Date().toISOString(),
      btcPriceAtEntry: btcPrice,
      strike: chosenStrike.strike,
      orderId: result.orderId,
      fills: [],
      signalName,
    };

    if (windowType === 'hourly') {
      botState.hourlyPosition = position;
      botState.tradedThisHourlyWindow = true;
    } else {
      botState.fifteenMinPosition = position;
      botState.tradedThisWindow = true;
    }

    const allPositions = readBotPositions();
    allPositions[posKey] = position;
    writeBotPositions(allPositions);

    openTradeLifecycle({
      tradeId: result.orderId,
      bot: 'arb',
      ticker: decision.ticker,
      side: decision.side,
      contracts,
      entryPrice: limitPriceCents / 100,
      entryTime: position.entryTime,
      entryBtcPrice: btcPrice,
      signal: signalName,
    });

    console.log(
      `[SWING] ENTRY FILLED | ${windowType} ${decision.side.toUpperCase()} | ` +
      `${decision.ticker} | ${limitPriceCents}¢ × ${contracts} = $${position.totalCost.toFixed(2)} | ` +
      `Order: ${result.orderId} (${result.status})`
    );

  } else {
    // IOC missed — store as pending entry for re-attempt
    botState.pendingEntry = {
      windowType,
      side: decision.side,
      ticker: decision.ticker,
      contracts,
      limitPriceCents: freshAskCents,  // re-check against original ask
      btcPriceAtDecision: btcPrice,
      expiresAt: Date.now() + PENDING_ENTRY_TTL_MS,
    };

    console.log(
      `[SWING] IOC missed → pendingEntry | ` +
      `${decision.ticker} ${decision.side.toUpperCase()} @ ${freshAskCents}¢ | ` +
      `expires in ${PENDING_ENTRY_TTL_MS / 1000}s`
    );
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────────

async function swingBotLoop(): Promise<void> {
  if (!botState?.running) return;
  if (loopRunning) return;
  loopRunning = true;

  try {
    const config = readBotConfig();
    const arbConfig = config.arb;

    if (!arbConfig.enabled) {
      stopGrokSwingBot();
      return;
    }

    const btcPrice = getPrice();
    if (btcPrice <= 0) return;

    // Update daily P&L
    const { pnl, count } = calculateDailyPnL();
    botState.dailyPnL = pnl;
    botState.tradesCount = count;

    // Daily loss gate
    if (arbConfig.maxDailyLoss > 0 && botState.dailyPnL <= -arbConfig.maxDailyLoss) {
      botState.lastError = `Daily loss limit: $${botState.dailyPnL.toFixed(2)} (paused)`;
      return;
    }
    if (botState.lastError?.startsWith('Daily loss limit')) {
      botState.lastError = undefined;
    }

    // Update BTC price history (rolling 90s ring buffer)
    const nowTs = Date.now();
    botState.btcPriceHistory.push({ price: btcPrice, ts: nowTs });
    botState.btcPriceHistory = botState.btcPriceHistory.filter(h => h.ts >= nowTs - 90_000);

    // ── Window key resets ────────────────────────────────────────────────────

    const windowKey = get15MinWindowKey();
    if (windowKey !== botState.currentWindowKey) {
      botState.currentWindowKey = windowKey;
      botState.tradedThisWindow = false;
      botState.windowOpenBtcPrice = btcPrice;
      console.log(`[SWING] New 15-min window: ${windowKey} | BTC open: $${btcPrice.toFixed(0)}`);
    }

    const hourlyKey = getHourlyWindowKey();
    if (hourlyKey !== botState.currentHourlyWindowKey) {
      botState.currentHourlyWindowKey = hourlyKey;
      botState.tradedThisHourlyWindow = false;
      botState.hourlyWindowOpenBtcPrice = btcPrice;
      console.log(`[SWING] New hourly window: ${hourlyKey} | BTC open: $${btcPrice.toFixed(0)}`);
    }

    // ── Sync positions from disk ─────────────────────────────────────────────

    const diskPositions = readBotPositions();
    botState.fifteenMinPosition = (diskPositions['arb'] as BotPosition) || null;
    botState.hourlyPosition = (diskPositions['arb-hourly'] as BotPosition) || null;

    // Restore tradedThisWindow if a position exists from this window (handles restarts)
    if (botState.fifteenMinPosition && !botState.tradedThisWindow) {
      const posTime = new Date(botState.fifteenMinPosition.entryTime);
      const posWindowMinutes = Math.floor(posTime.getMinutes() / 15) * 15;
      const posWindowKey = `${posTime.toISOString().split('T')[0]}-${posTime.getUTCHours()}-${posWindowMinutes}`;
      if (posWindowKey === windowKey) botState.tradedThisWindow = true;
    }
    if (botState.hourlyPosition && !botState.tradedThisHourlyWindow) {
      const posTime = new Date(botState.hourlyPosition.entryTime);
      const posHourKey = `${posTime.toISOString().split('T')[0]}-${posTime.getUTCHours()}`;
      if (posHourKey === hourlyKey) botState.tradedThisHourlyWindow = true;
    }

    // ── Handle active positions ──────────────────────────────────────────────

    if (botState.fifteenMinPosition || botState.hourlyPosition) {
      await handleActivePositions(btcPrice, arbConfig);
    }

    // ── Handle pending entry ─────────────────────────────────────────────────

    if (botState.pendingEntry) {
      await handlePendingEntry(btcPrice);
      return; // don't fire new signals while a pending entry exists
    }

    // ── Signal detection ─────────────────────────────────────────────────────

    const cutoff60 = nowTs - 60_000;
    const window60s = botState.btcPriceHistory.filter(h => h.ts >= cutoff60);
    const velocity = window60s.length >= 2
      ? (window60s[window60s.length - 1].price - window60s[0].price) /
        ((window60s[window60s.length - 1].ts - window60s[0].ts) / 60_000)
      : 0;

    const velocityOk = Math.abs(velocity) >= arbConfig.velocityThresholdPerMin;
    const now = new Date();
    const minute15In = now.getMinutes() % 15;
    const minuteInHour = now.getMinutes();

    // 15-min signal check
    if (
      velocityOk &&
      !botState.tradedThisWindow &&
      !botState.fifteenMinPosition &&
      Math.abs(btcPrice - botState.windowOpenBtcPrice) <= arbConfig.atmProximityDollars &&
      minute15In >= arbConfig.minEntryMinute &&
      minute15In <= arbConfig.maxEntryMinute15 &&
      Date.now() - botState.lastSignalWakeupTime >= SIGNAL_WAKEUP_COOLDOWN_MS
    ) {
      botState.lastSignalWakeupTime = Date.now();
      botState.lastSignalDetail = `15m vel=${velocity.toFixed(0)}$/min ATM@${botState.windowOpenBtcPrice.toFixed(0)}`;
      await grokSwingWakeup('15min', btcPrice, velocity, botState.windowOpenBtcPrice, arbConfig);
    }

    // Hourly signal check (re-check cooldown in case 15m just fired)
    if (
      velocityOk &&
      !botState.tradedThisHourlyWindow &&
      !botState.hourlyPosition &&
      Math.abs(btcPrice - botState.hourlyWindowOpenBtcPrice) <= arbConfig.atmProximityDollars &&
      minuteInHour >= arbConfig.minEntryMinute &&
      minuteInHour <= 45 &&
      Date.now() - botState.lastSignalWakeupTime >= SIGNAL_WAKEUP_COOLDOWN_MS
    ) {
      botState.lastSignalWakeupTime = Date.now();
      botState.lastSignalDetail = `1h vel=${velocity.toFixed(0)}$/min ATM@${botState.hourlyWindowOpenBtcPrice.toFixed(0)}`;
      await grokSwingWakeup('hourly', btcPrice, velocity, botState.hourlyWindowOpenBtcPrice, arbConfig);
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (botState) botState.lastError = msg;
    console.error('[SWING] Loop error:', msg);
  } finally {
    loopRunning = false;
  }
}

// ── Public API (drop-in for strikeSniper exports used by botOrchestrator) ──────

export function startGrokSwingBot(): void {
  if (botState?.running) {
    console.log('[SWING] Already running');
    return;
  }

  const btcPrice = getPrice();
  botState = {
    running: true,

    fifteenMinPosition: null,
    tradedThisWindow: false,
    currentWindowKey: get15MinWindowKey(),
    windowOpenBtcPrice: btcPrice > 0 ? btcPrice : 0,

    hourlyPosition: null,
    tradedThisHourlyWindow: false,
    currentHourlyWindowKey: getHourlyWindowKey(),
    hourlyWindowOpenBtcPrice: btcPrice > 0 ? btcPrice : 0,

    btcPriceHistory: btcPrice > 0 ? [{ price: btcPrice, ts: Date.now() }] : [],
    lastSignalWakeupTime: 0,
    lastGrokExitCheckTime: 0,

    dailyPnL: 0,
    tradesCount: 0,
  };

  // Hot-reload guard: clear any orphaned interval from a previous module load
  const g = global as any;
  if (g.__grokSwingBotInterval) clearInterval(g.__grokSwingBotInterval);

  botState.intervalId = setInterval(() => swingBotLoop(), LOOP_INTERVAL_MS);
  g.__grokSwingBotInterval = botState.intervalId;

  swingBotLoop(); // run immediately

  console.log('[SWING] Started — 15-min + hourly swing modes, 3s loop');
}

export function stopGrokSwingBot(): void {
  if (!botState?.running) return;

  if (botState.intervalId) {
    clearInterval(botState.intervalId);
    botState.intervalId = undefined;
  }
  botState.running = false;

  const g = global as any;
  if (g.__grokSwingBotInterval) {
    clearInterval(g.__grokSwingBotInterval);
    g.__grokSwingBotInterval = undefined;
  }

  console.log('[SWING] Stopped');
}

export function getGrokSwingBotStatus() {
  if (!botState) {
    return {
      running: false,
      dailyPnL: 0,
      tradesCount: 0,
      hasFifteenMinPosition: false,
      hasHourlyPosition: false,
    };
  }
  return {
    running: botState.running,
    dailyPnL: botState.dailyPnL,
    tradesCount: botState.tradesCount,
    hasFifteenMinPosition: botState.fifteenMinPosition !== null,
    hasHourlyPosition: botState.hourlyPosition !== null,
    lastSignalDetail: botState.lastSignalDetail,
    lastError: botState.lastError,
    pendingEntry: botState.pendingEntry
      ? {
          windowType: botState.pendingEntry.windowType,
          side: botState.pendingEntry.side,
          ticker: botState.pendingEntry.ticker,
          expiresIn: Math.max(0, botState.pendingEntry.expiresAt - Date.now()),
        }
      : undefined,
  };
}
