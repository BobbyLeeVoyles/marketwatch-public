/**
 * Grok Hourly Bot
 *
 * AI-powered bot using Grok/xAI for KXBTCD hourly markets.
 * Independent of the algo — Grok makes its own entry/exit decisions.
 * Runs live with small capitalPerTrade ($3 default).
 * Trades only in the first 15 minutes of each hour.
 * Supports multi-bet per cycle (directional, straddle, breakout).
 */

import { getPrice, fetchHourlyCandles, fetchFundingRate, getOBI, getOBIDelta, getVelocity } from './btcFeed';
import { appendSession, updateOutcome, getMemorySummary } from '@/lib/ai/botMemory';
import { getMarketCached, parseTickerSettlementTime, clearMarketCache } from '@/lib/kalshi/markets';
import { placeOrder, cancelAllOrders } from './kalshiTrader';
import { runSpreadLadder } from './spreadLadder';
import { readBotConfig } from '@/lib/utils/botConfig';
import { logTradeToFile, recordBotOrderId } from './positionTracker';
import { calculateKalshiFeeBreakdown } from '@/lib/utils/fees';
import { getGrokDecision, getGrokMultiExitCheck, getGrokSwingEntry } from '@/lib/ai/grokClient';
import { buildHourlyPrompt, buildMultiExitPrompt, buildSwingEntryPrompt } from '@/lib/ai/grokPrompts';
import { checkConservativeSignal } from '@/lib/strategies/conservative';
import { calculateIndicators } from '@/lib/utils/indicators';
import { getKalshiClient } from '@/lib/kalshi/client';
import { isExternallyClosed } from '@/lib/kalshi/reconcile';
import { BotPosition } from '@/lib/kalshi/types';
import * as fs from 'fs';
import * as path from 'path';

const BOT_POSITIONS_FILE = path.resolve('./data/bot-positions.json');
const LOOP_INTERVAL_MS = 10_000;
const EXIT_CHECK_INTERVAL_MS = 3 * 60 * 1000;
const GROK_ENTRY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes between entry calls (throughout full hour)

interface GrokDecisionLog {
  timestamp: string;
  decision: string;
  confidence: number;
  reason: string;
  suggestedRisk: string;
  ticker?: string;
}

interface OtmPosition {
  id: string;
  ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  entryPriceCents: number;   // ¢ paid per contract
  entryTime: number;         // ms timestamp
  btcPriceAtEntry: number;
  orderId: string;
}

interface GrokHourlyBotState {
  running: boolean;
  intervalId?: NodeJS.Timeout;
  positions: BotPosition[];               // was: position: BotPosition | null
  capitalDeployedThisHour: number;        // was: tradedThisHour: boolean
  positionSuggestedRisk: 'low' | 'medium' | 'high';
  dailyPnL: number;
  tradesCount: number;
  lastError?: string;
  currentHourKey: string;
  lastDecisions: GrokDecisionLog[];
  lastExitCheck: number;
  lastGrokCallTime: number; // timestamp of last entry Grok call (for cooldown)
  hardStopFailedTickers: Set<string>; // tickers where hard stop sell failed this session
  otmPositions: OtmPosition[];
  lastOtmEntryTime: number;
  lastOtmExitCheck: number;
  otmCountThisHour: number;       // OTM entries placed in current hourly window
  marketOpenStraddled: boolean;   // market open straddle fired this hour
}

// Positions file can hold single BotPosition (other bots) or BotPosition[] (grokHourly)
type PositionsFile = Record<string, unknown>;

let botState: GrokHourlyBotState | null = null;
let loopRunning = false; // guard against concurrent setInterval ticks
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const legLastReconciled = new Map<string, number>(); // ticker → last reconciliation ms

function getHourKey(): string {
  const now = new Date();
  return `${now.toISOString().split('T')[0]}-${now.getUTCHours()}`;
}

function readBotPositions(): PositionsFile {
  try {
    if (fs.existsSync(BOT_POSITIONS_FILE)) {
      return JSON.parse(fs.readFileSync(BOT_POSITIONS_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

function writeBotPositions(positions: PositionsFile): void {
  try {
    const dir = path.dirname(BOT_POSITIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = BOT_POSITIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(positions, null, 2));
    fs.renameSync(tmp, BOT_POSITIONS_FILE);
  } catch { /* ignore */ }
}

/** Read grokHourly from positions file, migrating single object → array if needed. */
function readGrokHourlyLegs(data: PositionsFile): BotPosition[] {
  const raw = data.grokHourly;
  if (Array.isArray(raw)) return raw as BotPosition[];
  if (raw && typeof raw === 'object') return [raw as BotPosition]; // migrate single → array
  return [];
}

function calculateDailyPnL(): { pnl: number; count: number } {
  try {
    const tradesPath = path.resolve('./data/trades.json');
    if (!fs.existsSync(tradesPath)) return { pnl: 0, count: 0 };
    const data = JSON.parse(fs.readFileSync(tradesPath, 'utf8'));
    const today = new Date().toISOString().split('T')[0];
    if (data.daily?.date !== today) return { pnl: 0, count: 0 };
    const botTrades = data.daily.trades.filter((t: { strategy: string }) => t.strategy === 'grokHourly');
    const pnl = botTrades.reduce((sum: number, t: { netPnL: number }) => sum + (t.netPnL || 0), 0);
    return { pnl, count: botTrades.length };
  } catch { return { pnl: 0, count: 0 }; }
}

async function handleActivePositions(arbConfig: ReturnType<typeof readBotConfig>['arb']): Promise<void> {
  if (!botState || botState.positions.length === 0) return;

  const legs = [...botState.positions];
  const survivingLegs: BotPosition[] = [];
  const legsForGrokCheck: Array<{
    leg: BotPosition;
    currentBid: number;
    winProb: number;
    minutesRemaining: number;
    breakdown: { netPnL: number };
  }> = [];

  for (const leg of legs) {
    try {
      const market = await getMarketCached(leg.ticker);

      const closeTime = new Date(market.close_time).getTime();
      const tickerSettlement = parseTickerSettlementTime(leg.ticker);
      const settlementTime = tickerSettlement ? tickerSettlement.getTime() : closeTime;
      const minutesSinceClose = (Date.now() - Math.min(closeTime, settlementTime)) / 60000;

      // Stale check
      if (minutesSinceClose > 60 && market.status !== 'settled') {
        clearMarketCache();
        const fresh = await getMarketCached(leg.ticker);
        const isWin = fresh.result === leg.side;
        const exitPrice = isWin ? 1.0 : 0.0;
        const breakdown = calculateKalshiFeeBreakdown(leg.contracts, leg.entryPrice, exitPrice, 'settlement');
        logTradeToFile({
          id: leg.orderId || `grokHourly-${Date.now()}`,
          timestamp: leg.entryTime,
          strategy: 'grokHourly',
          direction: leg.side,
          entryPrice: leg.entryPrice,
          exitPrice,
          exitType: 'settlement',
          contracts: leg.contracts,
          netPnL: breakdown.netPnL,
          won: isWin,
          exitReason: `Stale resolved: ${isWin ? 'WIN' : 'LOSS'}`,
        });
        console.log(`[GROK HOURLY] Stale settlement ${isWin ? 'WIN' : 'LOSS'} | ${leg.ticker} | P&L: $${breakdown.netPnL.toFixed(2)}`);
        setImmediate(() => {
          const entryD = new Date(leg.entryTime);
          const wk = `${entryD.toISOString().split('T')[0]}-${entryD.getUTCHours()}`;
          updateOutcome('grokHourly', wk, isWin ? 'WIN' : 'LOSS', breakdown.netPnL);
        });
        continue; // removed from survivingLegs
      }

      // Settlement check
      if (market.status === 'settled') {
        const isWin = market.result === leg.side;
        const exitPrice = isWin ? 1.0 : 0.0;
        const breakdown = calculateKalshiFeeBreakdown(leg.contracts, leg.entryPrice, exitPrice, 'settlement');
        logTradeToFile({
          id: leg.orderId || `grokHourly-${Date.now()}`,
          timestamp: leg.entryTime,
          strategy: 'grokHourly',
          direction: leg.side,
          entryPrice: leg.entryPrice,
          exitPrice,
          exitType: 'settlement',
          contracts: leg.contracts,
          netPnL: breakdown.netPnL,
          won: isWin,
          exitReason: `Settlement ${isWin ? 'WIN' : 'LOSS'}`,
        });
        console.log(`[GROK HOURLY] Settlement ${isWin ? 'WIN' : 'LOSS'} | ${leg.ticker} | P&L: $${breakdown.netPnL.toFixed(2)}`);
        setImmediate(() => {
          const entryD = new Date(leg.entryTime);
          const wk = `${entryD.toISOString().split('T')[0]}-${entryD.getUTCHours()}`;
          updateOutcome('grokHourly', wk, isWin ? 'WIN' : 'LOSS', breakdown.netPnL);
        });
        continue;
      }

      if (market.status === 'closed') {
        survivingLegs.push(leg);
        continue;
      }

      // Manual-close reconciliation: check every 5 min if Kalshi is flat
      const now = Date.now();
      const lastRecon = legLastReconciled.get(leg.ticker) ?? 0;
      if (now - lastRecon > RECONCILE_INTERVAL_MS) {
        legLastReconciled.set(leg.ticker, now);
        const closed = await isExternallyClosed(leg.ticker, leg.side);
        if (closed) {
          const currentBidRecon = leg.side === 'yes' ? market.yes_bid : market.no_bid;
          const exitPriceRecon = currentBidRecon / 100;
          const breakdownRecon = calculateKalshiFeeBreakdown(leg.contracts, leg.entryPrice, exitPriceRecon, 'early');
          console.log(`[GROK HOURLY] Manual close detected: ${leg.ticker} — logging and clearing position`);
          logTradeToFile({
            id: leg.orderId || `grokHourly-manual-${Date.now()}`,
            timestamp: leg.entryTime,
            strategy: 'grokHourly',
            direction: leg.side,
            entryPrice: leg.entryPrice,
            exitPrice: exitPriceRecon,
            exitType: 'early',
            contracts: leg.contracts,
            netPnL: breakdownRecon.netPnL,
            won: breakdownRecon.netPnL > 0,
            exitReason: 'Manual close (external)',
          });
          legLastReconciled.delete(leg.ticker);
          continue; // don't add to survivingLegs
        }
      }

      const currentBid = leg.side === 'yes' ? market.yes_bid : market.no_bid;
      const currentAsk = leg.side === 'yes' ? market.yes_ask : market.no_ask;
      const winProb = currentBid > 0 && currentAsk > 0 ? (currentBid + currentAsk) / 2 : currentBid;
      const breakdown = calculateKalshiFeeBreakdown(leg.contracts, leg.entryPrice, currentBid / 100, 'early');
      const minutesRemaining = Math.max(0, (new Date(market.close_time).getTime() - now) / 60000);

      // 98¢ derisk: lock in near-max value
      if (currentBid >= 98) {
        console.log(`[GROK HOURLY] 98¢ derisk: ${leg.ticker} bid ${currentBid}¢ — locking in near-max value`);
        try {
          await placeOrder('grokHourly', leg.ticker, leg.side, 'sell', leg.contracts, currentBid);
          logTradeToFile({
            id: leg.orderId || `grokHourly-${Date.now()}`,
            timestamp: leg.entryTime,
            strategy: 'grokHourly',
            direction: leg.side,
            entryPrice: leg.entryPrice,
            exitPrice: currentBid / 100,
            exitType: 'early',
            contracts: leg.contracts,
            netPnL: breakdown.netPnL,
            won: breakdown.netPnL > 0,
            exitReason: `98¢ derisk: bid ${currentBid}¢`,
          });
        } catch (err) {
          console.error(`[GROK HOURLY] 98¢ derisk sell failed for ${leg.ticker}:`, err);
          survivingLegs.push(leg);
        }
        continue;
      }

      // Hard stop: win prob < 10% on any leg
      if (winProb < 10 && currentBid > 0) {
        if (botState.hardStopFailedTickers.has(leg.ticker)) {
          console.log(`[GROK HOURLY] Hard stop skipped for ${leg.ticker} (previous attempt failed; holding to settlement)`);
          survivingLegs.push(leg);
          continue;
        }
        console.log(`[GROK HOURLY] Hard stop: ${leg.ticker} winProb ${winProb}% < 10%`);
        try {
          await placeOrder('grokHourly', leg.ticker, leg.side, 'sell', leg.contracts, currentBid);
          botState.hardStopFailedTickers.delete(leg.ticker);
          logTradeToFile({
            id: leg.orderId || `grokHourly-${Date.now()}`,
            timestamp: leg.entryTime,
            strategy: 'grokHourly',
            direction: leg.side,
            entryPrice: leg.entryPrice,
            exitPrice: currentBid / 100,
            exitType: 'early',
            contracts: leg.contracts,
            netPnL: breakdown.netPnL,
            won: breakdown.netPnL > 0,
            exitReason: `Hard stop: win prob ${winProb}%`,
          });
        } catch (err) {
          console.error(`[GROK HOURLY] Hard stop failed for ${leg.ticker}:`, err);
          botState.hardStopFailedTickers.add(leg.ticker);
          survivingLegs.push(leg); // keep if exit failed
        }
        continue;
      }

      // Near settlement: exit with any profit at < 2m remaining
      if (minutesRemaining < 2 && breakdown.netPnL > 0 && currentBid > 0) {
        try {
          await placeOrder('grokHourly', leg.ticker, leg.side, 'sell', leg.contracts, currentBid);
          logTradeToFile({
            id: leg.orderId || `grokHourly-${Date.now()}`,
            timestamp: leg.entryTime,
            strategy: 'grokHourly',
            direction: leg.side,
            entryPrice: leg.entryPrice,
            exitPrice: currentBid / 100,
            exitType: 'early',
            contracts: leg.contracts,
            netPnL: breakdown.netPnL,
            won: true,
            exitReason: `Near-settlement profit protect: ${minutesRemaining.toFixed(1)}m left`,
          });
          console.log(`[GROK HOURLY] Near-settlement exit | ${leg.ticker} | P&L: $${breakdown.netPnL.toFixed(2)}`);
        } catch (err) {
          console.error(`[GROK HOURLY] Near-settlement exit failed for ${leg.ticker}:`, err);
          survivingLegs.push(leg);
        }
        continue;
      }

      // Leg passes rule checks — add to Grok multi-exit check list
      survivingLegs.push(leg);
      legsForGrokCheck.push({ leg, currentBid, winProb, minutesRemaining, breakdown });

    } catch (err) {
      console.error(`[GROK HOURLY] Error monitoring leg ${leg.ticker}:`, err);
      survivingLegs.push(leg); // keep on error
    }
  }

  // Grok multi-exit check (every 3 minutes, only if legs remain)
  const now = Date.now();
  if (legsForGrokCheck.length > 0 && (now - botState.lastExitCheck) >= EXIT_CHECK_INTERVAL_MS) {
    botState.lastExitCheck = now;
    const btcPrice = getPrice();

    const exitPrompt = buildMultiExitPrompt({
      legs: legsForGrokCheck.map(({ leg, currentBid, winProb, minutesRemaining, breakdown }) => ({
        ticker: leg.ticker,
        side: leg.side,
        contracts: leg.contracts,
        entryPrice: leg.entryPrice,
        unrealizedPnL: breakdown.netPnL,
        currentBid,
        winProb,
        minsRemaining: minutesRemaining,
        strike: leg.strike,
      })),
      btcPrice,
      suggestedRisk: botState.positionSuggestedRisk,
    });

    const exitCheck = await getGrokMultiExitCheck(exitPrompt, 'grokHourly');
    console.log(`[GROK HOURLY] Multi-exit check: ${JSON.stringify(exitCheck.exits)}`);

    for (const exitDecision of exitCheck.exits) {
      if (exitDecision.action !== 'EXIT') continue;

      const legInfo = legsForGrokCheck.find(l => l.leg.ticker === exitDecision.ticker);
      if (!legInfo) continue;

      const { leg, currentBid, breakdown } = legInfo;
      if (currentBid <= 0) continue;

      try {
        // Use ladder for Grok exits (direct style — hourly bot has no velocity tracking)
        const exitResult = await runSpreadLadder({
          ticker: leg.ticker,
          side: leg.side,
          mode: { type: 'exit', sellContracts: leg.contracts },
          config: arbConfig,
          exitStyle: 'direct',
        });

        // Fall back to direct sell if ladder didn't fully close
        if (exitResult.sellFills < leg.contracts) {
          const remaining = leg.contracts - exitResult.sellFills;
          try {
            await placeOrder('grokHourly', leg.ticker, leg.side, 'sell', remaining, currentBid);
          } catch { /* best-effort */ }
        }

        const actualExitPrice = exitResult.finalAskCents > 0 ? exitResult.finalAskCents / 100 : currentBid / 100;
        const actualBreakdown = calculateKalshiFeeBreakdown(leg.contracts, leg.entryPrice, actualExitPrice, 'early');

        logTradeToFile({
          id: leg.orderId || `grokHourly-${Date.now()}`,
          timestamp: leg.entryTime,
          strategy: 'grokHourly',
          direction: leg.side,
          entryPrice: leg.entryPrice,
          exitPrice: actualExitPrice,
          exitType: 'early',
          contracts: leg.contracts,
          netPnL: actualBreakdown.netPnL,
          won: actualBreakdown.netPnL > 0,
          exitReason: 'Grok multi-exit (ladder)',
        });
        console.log(`[GROK HOURLY] Grok exit (ladder) | ${leg.ticker} | P&L: $${actualBreakdown.netPnL.toFixed(2)}`);
        // Remove from surviving legs
        const idx = survivingLegs.findIndex(l => l.ticker === leg.ticker && l.side === leg.side);
        if (idx !== -1) survivingLegs.splice(idx, 1);
      } catch (err) {
        console.error(`[GROK HOURLY] Grok exit failed for ${leg.ticker}:`, err);
      }
    }
  }

  // Update state and persist surviving legs
  botState.positions = survivingLegs;
  const allPositions = readBotPositions();
  allPositions.grokHourly = survivingLegs;
  writeBotPositions(allPositions);
}

/**
 * Market open straddle — fired once per hour on weekdays during UTC 14:20–14:50.
 * Buys cheap OTM YES (above BTC) + NO (below BTC) on the 10 AM EST closing contract
 * to capture the 9:30 AM stock market open volatility spike without a directional bet.
 */
async function enterMarketOpenStraddle(
  btcPrice: number,
  minutesRemaining: number,
  config: ReturnType<typeof readBotConfig>,
): Promise<void> {
  if (!botState) return;
  botState.marketOpenStraddled = true; // set immediately to prevent re-entry on next tick

  const botConfig = config.grokHourly;
  const otmDollars = botConfig.marketOpenStraddleOtmDollars ?? 400;
  const capitalPerSide = botConfig.marketOpenStraddleCapitalPerSide ?? 2;
  const maxAskCents = 20;

  let allMarkets: Awaited<ReturnType<ReturnType<typeof getKalshiClient>['getMarkets']>> = [];
  try {
    const client = getKalshiClient();
    const now = Date.now();
    allMarkets = (await client.getMarkets('KXBTCD', 'open')).filter(m => {
      const close = new Date(m.close_time).getTime();
      return close > now && close <= now + 70 * 60 * 1000;
    });
  } catch (err) {
    console.error('[GROK HOURLY] Market open straddle: failed to fetch markets', err);
    return;
  }

  if (allMarkets.length === 0) {
    console.log('[GROK HOURLY] Market open straddle: no 10 AM contracts available');
    return;
  }

  const withStrike = allMarkets
    .map(m => {
      const match = m.ticker.match(/-T(\d+(?:\.\d+)?)$/);
      const strike = match ? parseFloat(match[1]) : 0;
      return { ...m, strike };
    })
    .filter(m => m.strike > 0);

  // YES leg: closest strike above BTC by 70–200% of otmDollars
  const yesCandidate = withStrike
    .filter(m => {
      const dist = m.strike - btcPrice;
      return dist >= otmDollars * 0.7 && dist <= otmDollars * 2 &&
        m.yes_ask > 0 && m.yes_ask <= maxAskCents;
    })
    .sort((a, b) => (a.strike - btcPrice) - (b.strike - btcPrice))[0];

  // NO leg: closest strike below BTC by 70–200% of otmDollars
  const noCandidate = withStrike
    .filter(m => {
      const dist = btcPrice - m.strike;
      return dist >= otmDollars * 0.7 && dist <= otmDollars * 2 &&
        m.no_ask > 0 && m.no_ask <= maxAskCents;
    })
    .sort((a, b) => (btcPrice - a.strike) - (btcPrice - b.strike))[0];

  if (!yesCandidate && !noCandidate) {
    console.log(`[GROK HOURLY] Market open straddle: no OTM candidates within $${otmDollars} of BTC $${btcPrice.toFixed(0)}`);
    return;
  }

  const legs: Array<['yes' | 'no', typeof yesCandidate]> = [];
  if (yesCandidate) legs.push(['yes', yesCandidate]);
  if (noCandidate)  legs.push(['no',  noCandidate]);

  for (const [side, candidate] of legs) {
    if (!candidate) continue;
    const askCents = side === 'yes' ? candidate.yes_ask : candidate.no_ask;
    const contracts = Math.floor(capitalPerSide / (askCents / 100));
    if (contracts < 1) continue;

    try {
      await placeOrder('grokHourly', candidate.ticker, side, 'buy', contracts, askCents);
      const otmPos: OtmPosition = {
        id: `mktopen-${side}-${Date.now()}`,
        ticker: candidate.ticker,
        side,
        contracts,
        entryPriceCents: askCents,
        entryTime: Date.now(),
        btcPriceAtEntry: btcPrice,
        orderId: '',
      };
      botState.otmPositions.push(otmPos);
      botState.otmCountThisHour++;
      console.log(
        `[GROK HOURLY] Market open straddle: ${side.toUpperCase()} ${candidate.ticker} ` +
        `@ ${askCents}¢ × ${contracts} | strike $${candidate.strike} vs BTC $${btcPrice.toFixed(0)} | ${minutesRemaining}m left`
      );
    } catch (err) {
      console.error(`[GROK HOURLY] Market open straddle ${side} order failed:`, err);
    }
  }

  // Persist updated OTM positions
  const allPos = readBotPositions();
  (allPos as Record<string, unknown>).grokHourlyOtm = botState.otmPositions;
  writeBotPositions(allPos);
}

async function enterOtmPosition(
  btcPrice: number,
  velocity60: number,
  minutesRemaining: number,
  config: ReturnType<typeof readBotConfig>,
): Promise<void> {
  if (!botState) return;

  const botConfig = config.grokHourly;
  const otmMinOtm = botConfig.otmMinOtmDollars ?? 300;
  const otmMaxOtm = botConfig.otmMaxOtmDollars ?? 1200;
  const otmMinAsk = botConfig.otmMinAskCents ?? 2;
  const otmMaxAsk = botConfig.otmMaxAskCents ?? 20;
  const capital = botConfig.otmCapitalPerTrade ?? 2;
  const velocityDir = velocity60 > 0 ? 'up' : 'down';

  let candidates: Array<{ ticker: string; strike: number; yesAsk: number; noAsk: number; fairYesPct: number }> = [];

  try {
    const client = getKalshiClient();
    const now = Date.now();
    const allMarkets = await client.getMarkets('KXBTCD', 'open');
    candidates = allMarkets
      .filter(m => {
        const close = new Date(m.close_time).getTime();
        if (close <= now || close > now + 70 * 60 * 1000) return false;
        const match = m.ticker.match(/-T(\d+(?:\.\d+)?)$/);
        const strike = match ? parseFloat(match[1]) : 0;
        if (strike === 0) return false;
        if (velocityDir === 'up') {
          const dist = strike - btcPrice;
          if (dist < otmMinOtm || dist > otmMaxOtm) return false;
          if (m.yes_ask < otmMinAsk || m.yes_ask > otmMaxAsk) return false;
        } else {
          const dist = btcPrice - strike;
          if (dist < otmMinOtm || dist > otmMaxOtm) return false;
          if (m.no_ask < otmMinAsk || m.no_ask > otmMaxAsk) return false;
        }
        return true;
      })
      .map(m => {
        const match = m.ticker.match(/-T(\d+(?:\.\d+)?)$/);
        const strike = match ? parseFloat(match[1]) : 0;
        const dist = Math.abs(strike - btcPrice);
        const fairYesPct = Math.max(1, 50 - (dist / btcPrice * 1000));
        return { ticker: m.ticker, strike, yesAsk: m.yes_ask, noAsk: m.no_ask, fairYesPct };
      });
  } catch (err) {
    console.error('[GROK HOURLY OTM] Failed to fetch markets:', err);
    return;
  }

  if (candidates.length === 0) {
    console.log('[GROK HOURLY OTM] No OTM candidates found');
    return;
  }

  const memoryContext = getMemorySummary('grokHourly');
  const prompt = buildSwingEntryPrompt({
    utcTime: new Date().toISOString(),
    btcPrice,
    velocity: velocity60,
    velocityDirection: velocityDir,
    atmBtcPrice: btcPrice,
    atmDistance: 0,
    minutesRemaining,
    windowType: 'hourly',
    strikes: candidates,
    otmMode: true,
    capitalPerTrade: capital,
    memoryContext,
  });

  const decision = await getGrokSwingEntry(prompt, 'grokHourly-otm');
  if (decision.action !== 'ENTER' || !decision.ticker) {
    console.log(`[GROK HOURLY OTM] Grok SKIP: ${decision.reason}`);
    return;
  }

  const chosen = candidates.find(c => c.ticker === decision.ticker);
  if (!chosen) {
    console.log(`[GROK HOURLY OTM] Ticker not in candidates: ${decision.ticker}`);
    return;
  }

  const side = decision.side;
  const askCents = side === 'yes' ? chosen.yesAsk : chosen.noAsk;
  const contracts = Math.floor(capital / (askCents / 100));
  if (contracts < 1) {
    console.log(`[GROK HOURLY OTM] Contracts < 1 for ${chosen.ticker} at ${askCents}¢`);
    return;
  }

  console.log(`[GROK HOURLY OTM] ENTRY | ${side.toUpperCase()} ${chosen.ticker} | ${askCents}¢ × ${contracts} | ${decision.reason}`);

  try {
    const arbConfig = { ...config.arb, ladderTargetDiscount: 3 };
    const ladderResult = await runSpreadLadder({
      ticker: chosen.ticker,
      side,
      mode: { type: 'entry', buyContracts: contracts },
      config: arbConfig,
      minutesRemaining,
    });

    let finalOrderId = '';
    let finalEntryPriceCents: number;

    if (ladderResult.buyPlaced && ladderResult.status !== 'accidental-fill') {
      finalOrderId = ladderResult.buyOrderId ?? '';
      finalEntryPriceCents = ladderResult.buyPriceCents;
    } else {
      await placeOrder('grokHourly', chosen.ticker, side, 'buy', contracts, askCents);
      finalEntryPriceCents = askCents;
    }

    const otmPos: OtmPosition = {
      id: `otm-${Date.now()}`,
      ticker: chosen.ticker,
      side,
      contracts,
      entryPriceCents: finalEntryPriceCents,
      entryTime: Date.now(),
      btcPriceAtEntry: btcPrice,
      orderId: finalOrderId,
    };

    botState.otmPositions.push(otmPos);
    botState.lastOtmEntryTime = Date.now();
    botState.otmCountThisHour++;

    const allPos = readBotPositions();
    (allPos as Record<string, unknown>).grokHourlyOtm = botState.otmPositions;
    writeBotPositions(allPos);

    console.log(`[GROK HOURLY OTM] Position opened: ${side.toUpperCase()} ${chosen.ticker} @ ${finalEntryPriceCents}¢ × ${contracts}`);

    const hourKey = getHourKey();
    setImmediate(() => {
      appendSession('grokHourly', {
        windowKey: `${hourKey}-otm`,
        timestamp: new Date().toISOString(),
        decision: side.toUpperCase(),
        reason: decision.reason.substring(0, 60),
        context: { btcPrice, velocity: velocity60, obi: 0 },
      });
    });
  } catch (err) {
    console.error('[GROK HOURLY OTM] Order failed:', err);
  }
}

async function handleOtmExits(minutesRemaining: number): Promise<void> {
  if (!botState || botState.otmPositions.length === 0) return;

  const config = readBotConfig();
  const botConfig = config.grokHourly;
  const profitMultiple = botConfig.otmProfitMultiple ?? 3;
  const cutLossThreshold = botConfig.otmCutLossThreshold ?? 0.3;
  const cutLossMinutesLeft = botConfig.otmCutLossMinutesLeft ?? 20;

  const surviving: OtmPosition[] = [];
  const legsForGrokCheck: Array<{ pos: OtmPosition; currentBid: number; winProb: number }> = [];
  const btcPrice = getPrice();

  for (const pos of botState.otmPositions) {
    try {
      const market = await getMarketCached(pos.ticker);

      if (market.status === 'settled') {
        const isWin = market.result === pos.side;
        const exitPriceDollars = isWin ? 1.0 : 0.0;
        const breakdown = calculateKalshiFeeBreakdown(pos.contracts, pos.entryPriceCents / 100, exitPriceDollars, 'settlement');
        logTradeToFile({
          id: pos.id,
          timestamp: new Date(pos.entryTime).toISOString(),
          strategy: 'grokHourly',
          direction: pos.side,
          entryPrice: pos.entryPriceCents / 100,
          exitPrice: exitPriceDollars,
          exitType: 'settlement',
          contracts: pos.contracts,
          netPnL: breakdown.netPnL,
          won: isWin,
          exitReason: `OTM settlement: ${isWin ? 'WIN' : 'LOSS'}`,
        });
        console.log(`[GROK HOURLY OTM] Settlement ${isWin ? 'WIN' : 'LOSS'} | ${pos.ticker}`);
        setImmediate(() => {
          updateOutcome('grokHourly', `${getHourKey()}-otm`, isWin ? 'WIN' : 'LOSS', breakdown.netPnL);
        });
        continue;
      }

      if (market.status === 'closed') {
        surviving.push(pos);
        continue;
      }

      const currentBid = pos.side === 'yes' ? market.yes_bid : market.no_bid;
      const currentAsk = pos.side === 'yes' ? market.yes_ask : market.no_ask;
      const winProb = currentBid > 0 && currentAsk > 0 ? (currentBid + currentAsk) / 2 : currentBid;

      // 98¢ derisk: lock in near-max value
      if (currentBid >= 98) {
        console.log(`[GROK HOURLY OTM] 98¢ derisk | ${pos.ticker} | bid ${currentBid}¢`);
        try {
          await placeOrder('grokHourly', pos.ticker, pos.side, 'sell', pos.contracts, currentBid);
          const breakdown98 = calculateKalshiFeeBreakdown(pos.contracts, pos.entryPriceCents / 100, currentBid / 100, 'early');
          logTradeToFile({
            id: pos.id,
            timestamp: new Date(pos.entryTime).toISOString(),
            strategy: 'grokHourly',
            direction: pos.side,
            entryPrice: pos.entryPriceCents / 100,
            exitPrice: currentBid / 100,
            exitType: 'early',
            contracts: pos.contracts,
            netPnL: breakdown98.netPnL,
            won: true,
            exitReason: `98¢ derisk: bid ${currentBid}¢`,
          });
        } catch (err) {
          console.error('[GROK HOURLY OTM] 98¢ derisk failed:', err);
          surviving.push(pos);
        }
        continue;
      }

      // Rule 1: profit take at profitMultiple × entry
      if (currentBid >= profitMultiple * pos.entryPriceCents) {
        console.log(`[GROK HOURLY OTM] Profit take ${profitMultiple}x | ${pos.ticker} | bid ${currentBid}¢ vs entry ${pos.entryPriceCents}¢`);
        try {
          await placeOrder('grokHourly', pos.ticker, pos.side, 'sell', pos.contracts, currentBid);
          const breakdown = calculateKalshiFeeBreakdown(pos.contracts, pos.entryPriceCents / 100, currentBid / 100, 'early');
          logTradeToFile({
            id: pos.id,
            timestamp: new Date(pos.entryTime).toISOString(),
            strategy: 'grokHourly',
            direction: pos.side,
            entryPrice: pos.entryPriceCents / 100,
            exitPrice: currentBid / 100,
            exitType: 'early',
            contracts: pos.contracts,
            netPnL: breakdown.netPnL,
            won: true,
            exitReason: `OTM profit take ${profitMultiple}x`,
          });
          setImmediate(() => {
            updateOutcome('grokHourly', `${getHourKey()}-otm`, 'WIN', breakdown.netPnL);
          });
        } catch (err) {
          console.error('[GROK HOURLY OTM] Profit take sell failed:', err);
          surviving.push(pos);
        }
        continue;
      }

      // Rule 3: time-based cut loss
      if (minutesRemaining < cutLossMinutesLeft && currentBid < cutLossThreshold * pos.entryPriceCents) {
        console.log(`[GROK HOURLY OTM] Time-based cut | ${pos.ticker} | ${minutesRemaining.toFixed(1)}m left | bid ${currentBid}¢`);
        try {
          if (currentBid > 0) {
            await placeOrder('grokHourly', pos.ticker, pos.side, 'sell', pos.contracts, currentBid);
          }
          const exitPriceDollars = currentBid > 0 ? currentBid / 100 : 0;
          const breakdown = calculateKalshiFeeBreakdown(pos.contracts, pos.entryPriceCents / 100, exitPriceDollars, 'early');
          logTradeToFile({
            id: pos.id,
            timestamp: new Date(pos.entryTime).toISOString(),
            strategy: 'grokHourly',
            direction: pos.side,
            entryPrice: pos.entryPriceCents / 100,
            exitPrice: exitPriceDollars,
            exitType: 'early',
            contracts: pos.contracts,
            netPnL: breakdown.netPnL,
            won: false,
            exitReason: `OTM time cut: <${cutLossMinutesLeft}m left`,
          });
          setImmediate(() => {
            updateOutcome('grokHourly', `${getHourKey()}-otm`, 'LOSS', breakdown.netPnL);
          });
        } catch (err) {
          console.error('[GROK HOURLY OTM] Time cut sell failed:', err);
          surviving.push(pos);
        }
        continue;
      }

      // Candidate for Grok momentum-stall check (Rule 2)
      surviving.push(pos);
      legsForGrokCheck.push({ pos, currentBid, winProb });

    } catch (err) {
      console.error(`[GROK HOURLY OTM] Error monitoring ${pos.ticker}:`, err);
      surviving.push(pos);
    }
  }

  // Rule 2: Grok momentum-stall check every 3 minutes
  const now = Date.now();
  if (legsForGrokCheck.length > 0 && (now - botState.lastOtmExitCheck) >= EXIT_CHECK_INTERVAL_MS) {
    botState.lastOtmExitCheck = now;

    const velocity30 = getVelocity(30_000);
    const velocity60 = getVelocity(60_000);
    const velocityTrend: 'accelerating' | 'stable' | 'decelerating' =
      velocity60 === 0 ? 'stable' :
      Math.abs(velocity30) >= Math.abs(velocity60) * 1.2 ? 'accelerating' :
      Math.abs(velocity30) <= Math.abs(velocity60) * 0.5 ? 'decelerating' : 'stable';

    const exitPrompt = buildMultiExitPrompt({
      legs: legsForGrokCheck.map(({ pos, currentBid, winProb }) => ({
        ticker: pos.ticker,
        side: pos.side,
        contracts: pos.contracts,
        entryPrice: pos.entryPriceCents / 100,
        unrealizedPnL: calculateKalshiFeeBreakdown(pos.contracts, pos.entryPriceCents / 100, currentBid / 100, 'early').netPnL,
        currentBid,
        winProb,
        minsRemaining: minutesRemaining,
      })),
      btcPrice,
      suggestedRisk: 'high',
      velocityTrend,
    });

    const exitCheck = await getGrokMultiExitCheck(exitPrompt, 'grokHourly-otm');
    console.log(`[GROK HOURLY OTM] Multi-exit check: ${JSON.stringify(exitCheck.exits)}`);

    for (const exitDecision of exitCheck.exits) {
      if (exitDecision.action !== 'EXIT') continue;

      const legInfo = legsForGrokCheck.find(l => l.pos.ticker === exitDecision.ticker);
      if (!legInfo) continue;

      const { pos, currentBid } = legInfo;
      if (currentBid <= 0) continue;

      try {
        await placeOrder('grokHourly', pos.ticker, pos.side, 'sell', pos.contracts, currentBid);
        const breakdown = calculateKalshiFeeBreakdown(pos.contracts, pos.entryPriceCents / 100, currentBid / 100, 'early');
        logTradeToFile({
          id: pos.id,
          timestamp: new Date(pos.entryTime).toISOString(),
          strategy: 'grokHourly',
          direction: pos.side,
          entryPrice: pos.entryPriceCents / 100,
          exitPrice: currentBid / 100,
          exitType: 'early',
          contracts: pos.contracts,
          netPnL: breakdown.netPnL,
          won: breakdown.netPnL > 0,
          exitReason: 'OTM Grok momentum-stall exit',
        });
        console.log(`[GROK HOURLY OTM] Grok exit: ${pos.ticker} | P&L: $${breakdown.netPnL.toFixed(2)}`);
        const idx = surviving.findIndex(s => s.id === pos.id);
        if (idx !== -1) surviving.splice(idx, 1);
        setImmediate(() => {
          updateOutcome('grokHourly', `${getHourKey()}-otm`, breakdown.netPnL > 0 ? 'WIN' : 'LOSS', breakdown.netPnL);
        });
      } catch (err) {
        console.error(`[GROK HOURLY OTM] Grok exit sell failed for ${pos.ticker}:`, err);
      }
    }
  }

  botState.otmPositions = surviving;
  const allPos = readBotPositions();
  (allPos as Record<string, unknown>).grokHourlyOtm = surviving;
  writeBotPositions(allPos);
}

async function grokHourlyBotLoop(): Promise<void> {
  if (!botState?.running) return;
  if (loopRunning) return; // previous tick still running (Grok API in progress)
  loopRunning = true;

  try {
    const config = readBotConfig();
    const botConfig = config.grokHourly;
    if (!botConfig.enabled) {
      stopGrokHourlyBot();
      return;
    }

    const { pnl, count } = calculateDailyPnL();
    botState.dailyPnL = pnl;
    botState.tradesCount = count;

    // Daily loss limit
    if (botConfig.maxDailyLoss > 0 && botState.dailyPnL <= -botConfig.maxDailyLoss) {
      console.log(`[GROK HOURLY] Daily loss limit hit ($${botState.dailyPnL.toFixed(2)} / -$${botConfig.maxDailyLoss}) — paused until tomorrow`);
      return;
    }

    const btcPrice = getPrice();
    if (btcPrice <= 0) return;

    // Hour reset
    const hourKey = getHourKey();
    if (hourKey !== botState.currentHourKey) {
      botState.currentHourKey = hourKey;
      botState.capitalDeployedThisHour = 0;
      botState.hardStopFailedTickers.clear();
      botState.otmCountThisHour = 0;
      botState.marketOpenStraddled = false;
      // positions already cleared by settlement; no forced clear needed
    }

    // Sync positions from disk (other processes may have modified)
    const diskPositions = readBotPositions();
    const diskLegs = readGrokHourlyLegs(diskPositions);
    // Preserve in-memory if we have more recent data (just placed orders)
    if (diskLegs.length > botState.positions.length) {
      botState.positions = diskLegs;
    }

    // Compute minutesRemaining early (needed for OTM monitoring and entry trigger)
    const nowH = new Date();
    const minutesInHour = nowH.getMinutes();
    const minutesRemaining = 60 - minutesInHour;
    const utcHour = nowH.getUTCHours();
    const utcMin = nowH.getUTCMinutes();
    const isWeekday = nowH.getUTCDay() >= 1 && nowH.getUTCDay() <= 5;

    // Monitor active ATM positions
    if (botState.positions.length > 0) {
      await handleActivePositions(config.arb);
    }

    // Monitor active OTM positions (always, even with < 10 min remaining)
    if (botState.otmPositions.length > 0) {
      await handleOtmExits(minutesRemaining);
    }

    // Skip 5 PM EST markets: strike prices sit at 500-dollar non-support intervals
    // 5 PM EST = 22:00 UTC; the evaluation hour for those contracts is UTC 21
    if ((botConfig.skipFivePmEst ?? true) && utcHour === 21) {
      return;
    }

    // Capital gate (replaces tradedThisHour guard)
    const capitalRemaining = botConfig.capitalPerTrade - botState.capitalDeployedThisHour;
    if (capitalRemaining < 1.00) return; // budget exhausted

    // Stop accepting new entries when < 10 minutes remain in the hour
    if (minutesRemaining < 10) return;

    // 9:30 AM EST market open straddle (weekdays, UTC 14:20–14:50)
    // Buy cheap OTM YES + NO on the 10 AM closing contract to capture the volatility
    // spike without needing directional conviction.
    if (
      (botConfig.marketOpenStraddleEnabled ?? true) &&
      isWeekday && utcHour === 14 && utcMin >= 20 && utcMin <= 50 &&
      !botState.marketOpenStraddled
    ) {
      await enterMarketOpenStraddle(btcPrice, minutesRemaining, config);
    }

    // OTM entry trigger (independent of ATM cooldown)
    const velocity60 = getVelocity(60_000);
    const otmEnabled = botConfig.otmEnabled ?? false;
    const otmCooldownOk = Date.now() - botState.lastOtmEntryTime >= (botConfig.otmEntryCooldownMin ?? 15) * 60_000;
    const otmTimeOk = minutesRemaining >= (botConfig.otmMinMinutesLeft ?? 15);
    const noOtmInDirection = !botState.otmPositions.some(p =>
      (velocity60 > 0 && p.side === 'yes') || (velocity60 < 0 && p.side === 'no'),
    );
    const otmHourUtc = new Date().getUTCHours();
    const otmIsOvernight = otmHourUtc >= (botConfig.overnightStartHour ?? 0) &&
      otmHourUtc < (botConfig.overnightEndHour ?? 7);
    const effectiveOtmVelThreshold = (botConfig.otmVelocityThreshold ?? 75) *
      (otmIsOvernight ? (botConfig.otmOvernightMultiplier ?? 2.0) : 1.0);
    const otmCapOk = botState.otmCountThisHour < (botConfig.otmMaxPerHour ?? 2);

    if (otmEnabled && Math.abs(velocity60) >= effectiveOtmVelThreshold &&
        otmCooldownOk && otmTimeOk && noOtmInDirection && otmCapOk) {
      await enterOtmPosition(btcPrice, velocity60, minutesRemaining, config);
    }

    // Cooldown between ATM Grok calls
    if (Date.now() - botState.lastGrokCallTime < GROK_ENTRY_COOLDOWN_MS) return;

    const hourlyCandles = await fetchHourlyCandles();
    if (hourlyCandles.length === 0) return;

    const indicators = calculateIndicators(hourlyCandles, btcPrice);

    // Get adjacent strikes with both YES and NO ask prices
    let adjacentStrikes: Array<{ ticker: string; strike: number; yesAsk: number; noAsk: number }> = [];
    try {
      const client = getKalshiClient();
      const allMarkets = await client.getMarkets('KXBTCD', 'open');
      const now = Date.now();
      adjacentStrikes = allMarkets
        .filter(m => {
          const close = new Date(m.close_time).getTime();
          return close > now && close <= now + 70 * 60 * 1000;
        })
        .map(m => {
          const match = m.ticker.match(/-T(\d+(?:\.\d+)?)$/);
          const strike = match ? parseFloat(match[1]) : 0;
          return { ticker: m.ticker, strike, yesAsk: m.yes_ask, noAsk: m.no_ask };
        })
        .filter(s => s.strike > 0)
        .sort((a, b) => a.strike - b.strike);
    } catch { /* ignore */ }

    if (adjacentStrikes.length === 0) {
      console.log('[GROK HOURLY] No suitable hourly markets found — skipping');
      return;
    }

    // Get supporting data
    const fundingRate = await fetchFundingRate();
    const obi = getOBI();

    const velocity = getVelocity();
    const memoryContext = getMemorySummary('grokHourly');

    // Get algo signal as context
    const algoSignalRaw = checkConservativeSignal({
      timestamp: new Date(),
      price: btcPrice,
      hourlyData: hourlyCandles,
      indicators,
    });

    const algoSignal = {
      signal: algoSignalRaw.active
        ? (algoSignalRaw.direction?.toUpperCase() as 'YES' | 'NO') || 'YES'
        : 'SKIP' as const,
      reason: algoSignalRaw.exitStrategy || 'no signal',
      confidence: algoSignalRaw.active ? 60 : 0,
    };

    const btcChange24h = hourlyCandles.length >= 24
      ? ((btcPrice - hourlyCandles[hourlyCandles.length - 24].close) / hourlyCandles[hourlyCandles.length - 24].close) * 100
      : 0;

    const volumeRatio = hourlyCandles.length > 0
      ? hourlyCandles[hourlyCandles.length - 1].volume / (hourlyCandles.slice(-6).reduce((s, c) => s + c.volume, 0) / 6 || 1)
      : 1;

    const prompt = buildHourlyPrompt({
      utcTime: new Date().toISOString(),
      btcPrice,
      btcChange24h,
      fundingRate,
      orderBookImbalance: obi,
      adjacentStrikes,
      hourlyCandles,
      rsi: 50, // Placeholder — hourly RSI not separately computed
      bbWidth: 0,
      emaDiff: indicators.momentum3h / 100,
      volatility: indicators.volatility,
      atr: btcPrice * indicators.volatility / 100,
      volumeRatio,
      minutesRemaining,
      algoSignal,
      capitalBudget: capitalRemaining,
      currentPositions: botState.positions.map(p => ({
        side: p.side,
        ticker: p.ticker,
        contracts: p.contracts,
        entryPrice: p.entryPrice,
        unrealizedPnL: 0, // approximation; market data not fetched here
      })),
      velocity,
      memoryContext,
      obiTrend: getOBIDelta(),
    });

    botState.lastGrokCallTime = Date.now();
    // Persist lastGrokCallTime immediately so a restart mid-call applies the cooldown
    const metaPos = readBotPositions();
    (metaPos as any).grokHourlyMeta = {
      hourKey,
      lastGrokCallTime: botState.lastGrokCallTime,
      capitalDeployedThisHour: botState.capitalDeployedThisHour,
    };
    writeBotPositions(metaPos);
    console.log(`[GROK HOURLY] Querying Grok | Hour: ${hourKey} | ${minutesRemaining}m remaining | Budget: $${capitalRemaining.toFixed(2)}`);
    const decision = await getGrokDecision(prompt, 'grokHourly');

    // Log decision summary
    const betsSummary = decision.bets.length === 0
      ? 'SKIP'
      : decision.bets.map(b => `${b.side.toUpperCase()}@${b.ticker.split('-').pop()}`).join('+');

    const decisionLog: GrokDecisionLog = {
      timestamp: new Date().toISOString(),
      decision: betsSummary,
      confidence: decision.confidence,
      reason: decision.reason,
      suggestedRisk: decision.suggested_risk,
      ticker: decision.bets.length > 0 ? decision.bets[0].ticker : undefined,
    };
    botState.lastDecisions = [decisionLog, ...botState.lastDecisions].slice(0, 5);

    console.log(
      `[GROK HOURLY] Decision: ${betsSummary} | ` +
      `Confidence: ${decision.confidence}% | ` +
      `Risk: ${decision.suggested_risk} | ` +
      `"${decision.reason}"`
    );

    if (decision.bets.length === 0 || decision.confidence < botConfig.confidenceThreshold) {
      console.log(
        `[GROK HOURLY] Skipping: ${decision.bets.length === 0 ? 'no bets' : `confidence ${decision.confidence}% < ${botConfig.confidenceThreshold}%`} | ` +
        `Will re-evaluate in ${GROK_ENTRY_COOLDOWN_MS / 60000}m`
      );
      // Append SKIP session non-blocking
      setImmediate(() => {
        appendSession('grokHourly', {
          windowKey: hourKey,
          timestamp: new Date().toISOString(),
          decision: 'SKIP',
          reason: decision.reason.substring(0, 60),
          context: { btcPrice, velocity, obi: obi?.imbalance ?? 0 },
          outcome: 'SKIP',
        });
      });
      return;
    }

    // Append entry decision non-blocking (outcome filled in later)
    setImmediate(() => {
      appendSession('grokHourly', {
        windowKey: hourKey,
        timestamp: new Date().toISOString(),
        decision: decision.bets.length > 0 ? decision.bets[0].side.toUpperCase() : 'ENTER',
        reason: decision.reason.substring(0, 60),
        context: { btcPrice, velocity, obi: obi?.imbalance ?? 0 },
        grokConfidence: decision.confidence,
      });
    });

    botState.positionSuggestedRisk = decision.suggested_risk;

    // Place each bet
    for (const bet of decision.bets) {
      // Find market in adjacentStrikes
      const market = adjacentStrikes.find(s => s.ticker === bet.ticker);
      if (!market) {
        console.warn(`[GROK HOURLY] Bet ticker not found in adjacent strikes: ${bet.ticker} — skipping`);
        continue;
      }

      const askCents = bet.side === 'yes' ? market.yesAsk : market.noAsk;
      const maxAsk = botConfig.maxDirectionalAskCents ?? 30;
      if (askCents <= 0 || askCents > maxAsk) {
        console.log(`[GROK HOURLY] Ask ${askCents}¢ out of range (max ${maxAsk}¢) — skipping bet`);
        continue;
      }

      if (askCents < 5) {
        console.log(`[GROK HOURLY] Entropy: ask ${askCents}¢ too low — market near-certain, skipping leg`);
        continue;
      }

      const entryPriceDollars = askCents / 100;
      let contracts = Math.floor(bet.amount / entryPriceDollars);

      // Cap to remaining capital
      const capitalLeft = botConfig.capitalPerTrade - botState.capitalDeployedThisHour;
      const maxByCapital = Math.floor(capitalLeft / entryPriceDollars);
      if (maxByCapital < 1) {
        console.log(`[GROK HOURLY] Insufficient remaining capital ($${capitalLeft.toFixed(2)}) for ${bet.ticker} — skipping`);
        continue;
      }
      contracts = Math.min(contracts, maxByCapital);

      if (contracts < 1) {
        console.log(`[GROK HOURLY] Contracts < 1 for ${bet.ticker} (amount $${bet.amount}, ask ${askCents}¢) — skipping`);
        continue;
      }

      console.log(
        `[GROK HOURLY] ENTRY | ${bet.side.toUpperCase()} | ` +
        `Ticker: ${bet.ticker} | ` +
        `Ask: ${askCents}¢ | Contracts: ${contracts}`
      );

      try {
        const ladderResult = await runSpreadLadder({
          ticker: bet.ticker,
          side: bet.side,
          mode: { type: 'entry', buyContracts: contracts },
          config: config.arb,
          minutesRemaining,
        });

        if (ladderResult.status === 'accidental-fill') {
          console.warn(`[GROK HOURLY] Accidental fill during ladder for ${bet.ticker} — closing at market`);
          try {
            await placeOrder('grokHourly', bet.ticker, bet.side, 'buy', 1, ladderResult.finalAskCents);
          } catch { /* best-effort */ }
          continue;
        }

        if (!ladderResult.buyPlaced) {
          console.log(`[GROK HOURLY] Ladder entry did not place buy for ${bet.ticker} (status: ${ladderResult.status})`);
          continue;
        }

        if (ladderResult.buyOrderId) recordBotOrderId(ladderResult.buyOrderId);

        const actualEntryPriceDollars = ladderResult.buyPriceCents / 100;
        const position: BotPosition = {
          bot: 'grokHourly',
          ticker: bet.ticker,
          side: bet.side,
          contracts,
          entryPrice: actualEntryPriceDollars,
          totalCost: contracts * actualEntryPriceDollars,
          entryTime: new Date().toISOString(),
          btcPriceAtEntry: btcPrice,
          strike: market.strike,
          orderId: ladderResult.buyOrderId,
          fills: [],
        };

        botState.positions.push(position);
        botState.capitalDeployedThisHour += contracts * actualEntryPriceDollars;
        botState.lastExitCheck = Date.now();

        // Persist after each successful order
        const allPos = readBotPositions();
        allPos.grokHourly = botState.positions;
        writeBotPositions(allPos);

        const saving = askCents - ladderResult.buyPriceCents;
        console.log(
          `[GROK HOURLY] Ladder entry | ${bet.ticker} | ID: ${ladderResult.buyOrderId ?? 'n/a'} | ` +
          `${ladderResult.buyPriceCents}¢ (saved ${saving >= 0 ? saving : 0}¢) | ` +
          `Capital deployed: $${botState.capitalDeployedThisHour.toFixed(2)}`
        );
      } catch (err) {
        botState.lastError = err instanceof Error ? err.message : String(err);
        console.error(`[GROK HOURLY] Order failed for ${bet.ticker}:`, err);
        // Continue to next bet even if this one failed
      }
    }

  } catch (err) {
    if (botState) botState.lastError = err instanceof Error ? err.message : String(err);
    console.error('[GROK HOURLY] Loop error:', err);
  } finally {
    loopRunning = false;
  }
}

export function startGrokHourlyBot(): void {
  if (botState?.running) {
    console.log('[GROK HOURLY] Already running');
    return;
  }

  // Pre-load any existing positions so monitoring resumes immediately on restart.
  const existingPositions = readBotPositions();
  const existingLegs = readGrokHourlyLegs(existingPositions);
  const existingOtmPositions: OtmPosition[] = Array.isArray((existingPositions as Record<string, unknown>).grokHourlyOtm)
    ? (existingPositions as Record<string, unknown>).grokHourlyOtm as OtmPosition[]
    : [];

  const currentHourKey = getHourKey();
  const meta = (existingPositions as any).grokHourlyMeta;
  const metaForHour = meta?.hourKey === currentHourKey ? meta : null;

  const restoredCapital = Math.max(
    existingLegs.reduce((s: number, p: BotPosition) => s + p.totalCost, 0),
    metaForHour?.capitalDeployedThisHour ?? 0
  );

  botState = {
    running: true,
    positions: existingLegs,
    capitalDeployedThisHour: restoredCapital,
    positionSuggestedRisk: 'medium',
    dailyPnL: 0,
    tradesCount: 0,
    currentHourKey,
    lastDecisions: [],
    lastExitCheck: 0,
    lastGrokCallTime: metaForHour?.lastGrokCallTime ?? 0,
    hardStopFailedTickers: new Set<string>(),
    otmPositions: existingOtmPositions,
    lastOtmEntryTime: 0,
    lastOtmExitCheck: 0,
    otmCountThisHour: 0,
    marketOpenStraddled: false,
  };

  if (existingLegs.length > 0) {
    console.log(`[GROK HOURLY] Resuming ${existingLegs.length} position(s): ` +
      existingLegs.map(p =>
        `${p.ticker} ${p.side.toUpperCase()} ${p.contracts}@${(p.entryPrice * 100).toFixed(0)}¢`
      ).join(', '));
  }

  // Clear any orphaned interval from a previous hot-reload
  const g = global as any;
  if (g.__grokHourlyInterval) clearInterval(g.__grokHourlyInterval);
  botState.intervalId = setInterval(() => grokHourlyBotLoop(), LOOP_INTERVAL_MS);
  g.__grokHourlyInterval = botState.intervalId;
  grokHourlyBotLoop();

  console.log('[GROK HOURLY] Started');
}

export function stopGrokHourlyBot(): void {
  if (!botState) return;
  botState.running = false;
  if (botState.intervalId) clearInterval(botState.intervalId);
  for (const pos of botState.positions) {
    cancelAllOrders('grokHourly', pos.ticker).catch(() => {});
  }
  botState = null;
  loopRunning = false;
  console.log('[GROK HOURLY] Stopped');
}

export function getGrokHourlyBotStatus() {
  if (!botState) {
    return { running: false, dailyPnL: 0, tradesCount: 0, lastDecisions: [], hasPosition: false, positions: [] };
  }
  return {
    running: botState.running,
    dailyPnL: botState.dailyPnL,
    tradesCount: botState.tradesCount,
    lastError: botState.lastError,
    hasPosition: botState.positions.length > 0,
    positions: botState.positions.map(p => ({
      ticker: p.ticker,
      side: p.side,
      contracts: p.contracts,
      entryPrice: p.entryPrice,
      totalCost: p.totalCost,
      entryTime: p.entryTime,
      btcPriceAtEntry: p.btcPriceAtEntry,
      strike: p.strike,
    })),
    capitalDeployedThisHour: botState.capitalDeployedThisHour,
    lastDecisions: botState.lastDecisions,
  };
}
