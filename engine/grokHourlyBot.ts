/**
 * Grok Hourly Bot
 *
 * AI-powered bot using Grok/xAI for KXBTCD hourly markets.
 * Independent of the algo — Grok makes its own entry/exit decisions.
 * Runs live with small capitalPerTrade ($3 default).
 * Trades only in the first 15 minutes of each hour.
 * Supports multi-bet per cycle (directional, straddle, breakout).
 */

import { getPrice, fetchHourlyCandles, fetchFundingRate, fetchOrderBookImbalance } from './btcFeed';
import { getMarketCached, parseTickerSettlementTime, clearMarketCache } from '@/lib/kalshi/markets';
import { placeOrder, cancelAllOrders } from './kalshiTrader';
import { readBotConfig } from '@/lib/utils/botConfig';
import { logTradeToFile, recordBotOrderId } from './positionTracker';
import { calculateKalshiFeeBreakdown } from '@/lib/utils/fees';
import { getGrokDecision, getGrokMultiExitCheck } from '@/lib/ai/grokClient';
import { buildHourlyPrompt, buildMultiExitPrompt } from '@/lib/ai/grokPrompts';
import { checkConservativeSignal } from '@/lib/strategies/conservative';
import { calculateIndicators } from '@/lib/utils/indicators';
import { getKalshiClient } from '@/lib/kalshi/client';
import { BotPosition } from '@/lib/kalshi/types';
import * as fs from 'fs';
import * as path from 'path';

const BOT_POSITIONS_FILE = path.resolve('./data/bot-positions.json');
const LOOP_INTERVAL_MS = 10_000;
const EXIT_CHECK_INTERVAL_MS = 3 * 60 * 1000;
const GROK_ENTRY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between entry calls on SKIP

interface GrokDecisionLog {
  timestamp: string;
  decision: string;
  confidence: number;
  reason: string;
  suggestedRisk: string;
  ticker?: string;
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
}

// Positions file can hold single BotPosition (other bots) or BotPosition[] (grokHourly)
type PositionsFile = Record<string, unknown>;

let botState: GrokHourlyBotState | null = null;
let loopRunning = false; // guard against concurrent setInterval ticks

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

async function handleActivePositions(): Promise<void> {
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
        continue;
      }

      if (market.status === 'closed') {
        survivingLegs.push(leg);
        continue;
      }

      const now = Date.now();
      const currentBid = leg.side === 'yes' ? market.yes_bid : market.no_bid;
      const currentAsk = leg.side === 'yes' ? market.yes_ask : market.no_ask;
      const winProb = currentBid > 0 && currentAsk > 0 ? (currentBid + currentAsk) / 2 : currentBid;
      const breakdown = calculateKalshiFeeBreakdown(leg.contracts, leg.entryPrice, currentBid / 100, 'early');
      const minutesRemaining = Math.max(0, (new Date(market.close_time).getTime() - now) / 60000);

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
          exitReason: 'Grok multi-exit',
        });
        console.log(`[GROK HOURLY] Grok exit | ${leg.ticker} | P&L: $${breakdown.netPnL.toFixed(2)}`);
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
      // positions already cleared by settlement; no forced clear needed
    }

    // Sync positions from disk (other processes may have modified)
    const diskPositions = readBotPositions();
    const diskLegs = readGrokHourlyLegs(diskPositions);
    // Preserve in-memory if we have more recent data (just placed orders)
    if (diskLegs.length > botState.positions.length) {
      botState.positions = diskLegs;
    }

    // Monitor active positions
    if (botState.positions.length > 0) {
      await handleActivePositions();
    }

    // Capital gate (replaces tradedThisHour guard)
    const capitalRemaining = botConfig.capitalPerTrade - botState.capitalDeployedThisHour;
    if (capitalRemaining < 1.00) return; // budget exhausted

    // Only trade in first 15 minutes of the hour
    const nowH = new Date();
    const minutesInHour = nowH.getMinutes();
    if (minutesInHour >= 15) {
      const nextWindowIn = 60 - minutesInHour;
      if (nowH.getMinutes() % 5 === 0 && nowH.getSeconds() === 0) {
        console.log(`[GROK HOURLY] Waiting for next hour — ${nextWindowIn}m remaining`);
      }
      return;
    }

    // Need at least 45 minutes remaining
    const minutesRemaining = 60 - minutesInHour;
    if (minutesRemaining < 45) return;

    // Cooldown between Grok calls
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
    const [fundingRate, obi] = await Promise.all([
      fetchFundingRate(),
      fetchOrderBookImbalance(),
    ]);

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
      return;
    }

    botState.positionSuggestedRisk = decision.suggested_risk;

    // Place each bet
    for (const bet of decision.bets) {
      // Find market in adjacentStrikes
      const market = adjacentStrikes.find(s => s.ticker === bet.ticker);
      if (!market) {
        console.warn(`[GROK HOURLY] Bet ticker not found in adjacent strikes: ${bet.ticker} — skipping`);
        continue;
      }

      const alreadyHeld = botState.positions.some(
        p => p.ticker === bet.ticker && p.side === bet.side
      );
      if (alreadyHeld) {
        console.log(`[GROK HOURLY] Already holding ${bet.side.toUpperCase()} on ${bet.ticker} — skipping duplicate`);
        continue;
      }

      const askCents = bet.side === 'yes' ? market.yesAsk : market.noAsk;
      if (askCents <= 0 || askCents > 45) {
        console.log(`[GROK HOURLY] Ask out of range for ${bet.ticker}: ${askCents}¢ (must be 1–45¢) — skipping bet`);
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
        const response = await placeOrder('grokHourly', bet.ticker, bet.side, 'buy', contracts, askCents);
        recordBotOrderId(response.order.order_id);

        const position: BotPosition = {
          bot: 'grokHourly',
          ticker: bet.ticker,
          side: bet.side,
          contracts,
          entryPrice: entryPriceDollars,
          totalCost: contracts * entryPriceDollars,
          entryTime: new Date().toISOString(),
          btcPriceAtEntry: btcPrice,
          strike: market.strike,
          orderId: response.order.order_id,
          fills: [],
        };

        botState.positions.push(position);
        botState.capitalDeployedThisHour += contracts * entryPriceDollars;
        botState.lastExitCheck = Date.now();

        // Persist after each successful order
        const allPos = readBotPositions();
        allPos.grokHourly = botState.positions;
        writeBotPositions(allPos);

        console.log(`[GROK HOURLY] Order placed | ${bet.ticker} | ID: ${response.order.order_id} | Capital deployed: $${botState.capitalDeployedThisHour.toFixed(2)}`);
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
