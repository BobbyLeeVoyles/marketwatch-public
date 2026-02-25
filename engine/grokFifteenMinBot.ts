/**
 * Grok 15-Minute Bot
 *
 * AI-powered bot using Grok/xAI for KXBTC15M markets.
 * Independent of the algo — Grok makes its own entry/exit decisions.
 * Runs live with small capitalPerTrade ($3 default).
 */

import { getPrice, fetch1MinCandles, fetch5MinCandles, fetchHourlyCandles, fetchFundingRate, fetchOrderBookImbalance } from './btcFeed';
import { find15MinMarket, getMarketCached, clearMarketCache } from '@/lib/kalshi/markets';
import { placeOrder, cancelAllOrders } from './kalshiTrader';
import { runSpreadLadder } from './spreadLadder';
import { readBotConfig } from '@/lib/utils/botConfig';
import { logTradeToFile, recordBotOrderId } from './positionTracker';
import { calculateKalshiFeeBreakdown } from '@/lib/utils/fees';
import { getGrokDecision, getGrokExitCheck, GrokDecision } from '@/lib/ai/grokClient';
import { build15MinPrompt, buildExitPrompt } from '@/lib/ai/grokPrompts';
import { check15MinSignalV2 } from '@/lib/strategies/fifteenMin';
import { calculate5MinIndicators, calculateIndicators } from '@/lib/utils/indicators';
import { getKalshiClient } from '@/lib/kalshi/client';
import { KalshiMarket, BotPosition } from '@/lib/kalshi/types';
import * as fs from 'fs';
import * as path from 'path';

const BOT_POSITIONS_FILE = path.resolve('./data/bot-positions.json');
const LOOP_INTERVAL_MS = 10_000;  // 10-second main loop
const EXIT_CHECK_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const GROK_ENTRY_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes between entry calls on SKIP

interface GrokDecisionLog {
  timestamp: string;
  decision: string;
  confidence: number;
  reason: string;
  suggestedRisk: string;
  ticker?: string;
}

interface Grok15MinBotState {
  running: boolean;
  intervalId?: NodeJS.Timeout;
  position: BotPosition | null;
  positionSuggestedRisk: 'low' | 'medium' | 'high';
  entryBtcPrice: number;
  dailyPnL: number;
  tradesCount: number;
  lastError?: string;
  tradedThisWindow: boolean;
  currentWindowKey: string;
  lastDecisions: GrokDecisionLog[];  // last 5 decisions
  lastExitCheck: number;             // timestamp
  lastGrokCallTime: number;          // timestamp of last entry Grok call (for cooldown)
}

let botState: Grok15MinBotState | null = null;
let loopRunning = false; // guard against concurrent setInterval ticks

function get15MinWindowKey(): string {
  const now = new Date();
  const minutes = Math.floor(now.getMinutes() / 15) * 15;
  return `${now.toISOString().split('T')[0]}-${now.getUTCHours()}-${minutes}`;
}

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
  } catch { /* ignore */ }
}

function calculateDailyPnL(): { pnl: number; count: number } {
  try {
    const tradesPath = path.resolve('./data/trades.json');
    if (!fs.existsSync(tradesPath)) return { pnl: 0, count: 0 };
    const data = JSON.parse(fs.readFileSync(tradesPath, 'utf8'));
    const today = new Date().toISOString().split('T')[0];
    if (data.daily?.date !== today) return { pnl: 0, count: 0 };
    const botTrades = data.daily.trades.filter((t: { strategy: string }) => t.strategy === 'grok15min');
    const pnl = botTrades.reduce((sum: number, t: { netPnL: number }) => sum + (t.netPnL || 0), 0);
    return { pnl, count: botTrades.length };
  } catch { return { pnl: 0, count: 0 }; }
}

async function handleActivePosition(): Promise<void> {
  if (!botState?.position) return;
  const position = botState.position;

  try {
    const market = await getMarketCached(position.ticker);

    // Check for stale position (market closed > 15 min ago)
    const closeTime = new Date(market.close_time).getTime();
    const minutesSinceClose = (Date.now() - closeTime) / 60000;

    if (minutesSinceClose > 15 && market.status !== 'settled') {
      clearMarketCache();
      const fresh = await getMarketCached(position.ticker);
      const isWin = fresh.result === position.side;
      const exitPrice = isWin ? 1.0 : 0.0;
      const breakdown = calculateKalshiFeeBreakdown(position.contracts, position.entryPrice, exitPrice, 'settlement');
      logTradeToFile({
        id: position.orderId || `grok15min-${Date.now()}`,
        timestamp: position.entryTime,
        strategy: 'grok15min',
        direction: position.side,
        entryPrice: position.entryPrice,
        exitPrice,
        exitType: 'settlement',
        contracts: position.contracts,
        netPnL: breakdown.netPnL,
        won: isWin,
        exitReason: `Stale resolved: ${isWin ? 'WIN' : 'LOSS'}`,
      });
      const positions = readBotPositions();
      delete positions.grok15min;
      writeBotPositions(positions);
      botState.position = null;
      return;
    }

    if (market.status === 'settled') {
      const isWin = market.result === position.side;
      const exitPrice = isWin ? 1.0 : 0.0;
      const breakdown = calculateKalshiFeeBreakdown(position.contracts, position.entryPrice, exitPrice, 'settlement');
      logTradeToFile({
        id: position.orderId || `grok15min-${Date.now()}`,
        timestamp: position.entryTime,
        strategy: 'grok15min',
        direction: position.side,
        entryPrice: position.entryPrice,
        exitPrice,
        exitType: 'settlement',
        contracts: position.contracts,
        netPnL: breakdown.netPnL,
        won: isWin,
        exitReason: `Settlement ${isWin ? 'WIN' : 'LOSS'}`,
      });
      const positions = readBotPositions();
      delete positions.grok15min;
      writeBotPositions(positions);
      botState.position = null;
      console.log(`[GROK 15MIN] Settlement ${isWin ? 'WIN' : 'LOSS'} | P&L: $${breakdown.netPnL.toFixed(2)}`);
      return;
    }

    if (market.status === 'closed') return; // Waiting for settlement

    // === GROK EXIT CHECK (every 3 minutes) ===
    const now = Date.now();
    const timeSinceLastCheck = now - botState.lastExitCheck;
    if (timeSinceLastCheck >= EXIT_CHECK_INTERVAL_MS) {
      botState.lastExitCheck = now;

      const currentBid = position.side === 'yes' ? market.yes_bid : market.no_bid;
      const currentAsk = position.side === 'yes' ? market.yes_ask : market.no_ask;
      const winProb = currentBid > 0 && currentAsk > 0 ? (currentBid + currentAsk) / 2 : currentBid;
      const btcPrice = getPrice();

      const breakdown = calculateKalshiFeeBreakdown(
        position.contracts,
        position.entryPrice,
        currentBid / 100,
        'early'
      );

      const minuteInWindow = new Date().getMinutes() % 15;
      const minsRemaining = 15 - minuteInWindow;

      // Hard stop: if win probability < 10%, Grok manages softer exits
      if (winProb < 10 && currentBid > 0) {
        console.log(`[GROK 15MIN] Hard stop triggered: winProb ${winProb}% < 10%`);
        try {
          await placeOrder('grok15min', position.ticker, position.side, 'sell', position.contracts, currentBid);
          logTradeToFile({
            id: position.orderId || `grok15min-${Date.now()}`,
            timestamp: position.entryTime,
            strategy: 'grok15min',
            direction: position.side,
            entryPrice: position.entryPrice,
            exitPrice: currentBid / 100,
            exitType: 'early',
            contracts: position.contracts,
            netPnL: breakdown.netPnL,
            won: breakdown.netPnL > 0,
            exitReason: `Hard stop: win prob ${winProb}%`,
          });
          const positions = readBotPositions();
          delete positions.grok15min;
          writeBotPositions(positions);
          botState.position = null;
        } catch (err) {
          console.error('[GROK 15MIN] Hard stop sell failed:', err);
        }
        return;
      }

      // Near settlement: hard exit at < 2m with any profit
      if (minsRemaining < 2 && breakdown.netPnL > 0 && currentBid > 0) {
        console.log(`[GROK 15MIN] Near-settlement profit exit: ${minsRemaining.toFixed(1)}m left, P&L $${breakdown.netPnL.toFixed(2)}`);
        try {
          await placeOrder('grok15min', position.ticker, position.side, 'sell', position.contracts, currentBid);
          logTradeToFile({
            id: position.orderId || `grok15min-${Date.now()}`,
            timestamp: position.entryTime,
            strategy: 'grok15min',
            direction: position.side,
            entryPrice: position.entryPrice,
            exitPrice: currentBid / 100,
            exitType: 'early',
            contracts: position.contracts,
            netPnL: breakdown.netPnL,
            won: true,
            exitReason: `Near-settlement profit protect: ${minsRemaining.toFixed(1)}m left`,
          });
          const positions = readBotPositions();
          delete positions.grok15min;
          writeBotPositions(positions);
          botState.position = null;
        } catch (err) {
          console.error('[GROK 15MIN] Near-settlement exit failed:', err);
        }
        return;
      }

      // Grok exit check
      if (currentBid > 0) {
        const exitPrompt = buildExitPrompt({
          strategy: 'grok15min',
          direction: position.side,
          ticker: position.ticker,
          entryPrice: position.entryPrice,
          contracts: position.contracts,
          unrealizedPnL: breakdown.netPnL,
          minsRemaining,
          btcPrice,
          entryBtcPrice: botState.entryBtcPrice,
          currentBid,
          winProb,
          suggestedRisk: botState.positionSuggestedRisk,
        });

        const exitCheck = await getGrokExitCheck(exitPrompt, 'grok15min');
        console.log(`[GROK 15MIN] Exit check: ${exitCheck.action} — "${exitCheck.reason}" | P&L: $${breakdown.netPnL.toFixed(2)}`);

        if (exitCheck.action === 'EXIT' && currentBid > 0) {
          try {
            await placeOrder('grok15min', position.ticker, position.side, 'sell', position.contracts, currentBid);
            logTradeToFile({
              id: position.orderId || `grok15min-${Date.now()}`,
              timestamp: position.entryTime,
              strategy: 'grok15min',
              direction: position.side,
              entryPrice: position.entryPrice,
              exitPrice: currentBid / 100,
              exitType: 'early',
              contracts: position.contracts,
              netPnL: breakdown.netPnL,
              won: breakdown.netPnL > 0,
              exitReason: `Grok exit: ${exitCheck.reason}`,
            });
            const positions = readBotPositions();
            delete positions.grok15min;
            writeBotPositions(positions);
            botState.position = null;
            console.log(`[GROK 15MIN] Grok exit complete | P&L: $${breakdown.netPnL.toFixed(2)}`);
          } catch (err) {
            console.error('[GROK 15MIN] Grok exit sell failed:', err);
          }
        }
      }
    }
  } catch (err) {
    console.error('[GROK 15MIN] Position monitoring error:', err);
  }
}

async function grokFifteenMinBotLoop(): Promise<void> {
  if (!botState?.running) return;
  if (loopRunning) return; // previous tick still running (Grok API in progress)
  loopRunning = true;

  try {
    const config = readBotConfig();
    const botConfig = config.grok15min;
    if (!botConfig.enabled) {
      stopGrok15MinBot();
      return;
    }

    const { pnl, count } = calculateDailyPnL();
    botState.dailyPnL = pnl;
    botState.tradesCount = count;

    // Daily loss limit
    if (botConfig.maxDailyLoss > 0 && botState.dailyPnL <= -botConfig.maxDailyLoss) {
      console.log(`[GROK 15MIN] Daily loss limit hit ($${botState.dailyPnL.toFixed(2)} / -$${botConfig.maxDailyLoss}) — paused until tomorrow`);
      return;
    }

    const btcPrice = getPrice();
    if (btcPrice <= 0) return;

    const windowKey = get15MinWindowKey();
    if (windowKey !== botState.currentWindowKey) {
      botState.currentWindowKey = windowKey;
      botState.tradedThisWindow = false;
    }

    // Monitor active position
    const positions = readBotPositions();
    botState.position = positions.grok15min || null;

    if (botState.position) {
      await handleActivePosition();
      if (botState.tradedThisWindow) return;
    }

    if (botState.tradedThisWindow) return;

    // Need at least 10 minutes remaining in the current window before entering
    const now15 = new Date();
    const minuteInWindow = now15.getMinutes() % 15;
    const minsRemaining = 15 - minuteInWindow;
    if (minsRemaining < 10) return;

    // Cooldown between Grok calls — don't call every 10s on SKIP
    if (Date.now() - botState.lastGrokCallTime < GROK_ENTRY_COOLDOWN_MS) return;

    // Find current 15-min market
    const market = await find15MinMarket();
    if (!market) {
      console.log('[GROK 15MIN] No open KXBTC15M market found — skipping this window');
      botState.tradedThisWindow = true; // don't spam retries
      return;
    }

    // Collect data for prompt
    const [oneMinCandles, fiveMinCandles, hourlyCandles, fundingRate, obi] = await Promise.all([
      fetch1MinCandles(),
      fetch5MinCandles(),
      fetchHourlyCandles(),
      fetchFundingRate(),
      fetchOrderBookImbalance(),
    ]);

    if (fiveMinCandles.length < 3) return;

    const indicators = calculateIndicators(hourlyCandles, btcPrice);
    const fiveMinIndicators = calculate5MinIndicators(fiveMinCandles, btcPrice);

    // Get algo signal as context
    const algoSignalRaw = check15MinSignalV2({
      timestamp: new Date(),
      price: btcPrice,
      hourlyData: hourlyCandles,
      indicators,
      fiveMinData: fiveMinCandles,
      fiveMinIndicators,
    }, botConfig.capitalPerTrade);

    const algoSignal = {
      signal: algoSignalRaw.active
        ? (algoSignalRaw.direction?.toUpperCase() as 'YES' | 'NO') || 'YES'
        : 'SKIP' as const,
      reason: algoSignalRaw.exitStrategy || 'no signal',
      confidence: algoSignalRaw.active ? 60 : 0,
    };

    // Get adjacent strikes for pricing analysis
    let adjacentStrikes: Array<{ ticker: string; strike: number; yesAsk: number }> = [];
    try {
      const client = getKalshiClient();
      const allMarkets = await client.getMarkets('KXBTC15M', 'open');
      const now = Date.now();
      adjacentStrikes = allMarkets
        .filter(m => {
          const close = new Date(m.close_time).getTime();
          return close > now && close <= now + 16 * 60 * 1000;
        })
        .map(m => {
          const match = m.ticker.match(/-T(\d+(?:\.\d+)?)$/);
          const strike = match ? parseFloat(match[1]) : 0;
          return { ticker: m.ticker, strike, yesAsk: m.yes_ask };
        })
        .filter(s => s.strike > 0)
        .sort((a, b) => a.strike - b.strike);
    } catch { /* ignore */ }

    // Calculate 24h BTC change
    const btcChange24h = hourlyCandles.length >= 24
      ? ((btcPrice - hourlyCandles[hourlyCandles.length - 24].close) / hourlyCandles[hourlyCandles.length - 24].close) * 100
      : 0;

    const yesMid = (market.yes_bid + market.yes_ask) / 2;
    const noMid = (market.no_bid + market.no_ask) / 2;
    const regime = fiveMinIndicators.bbWidth >= 0.003 ? 'MOMENTUM' : 'MEAN_REVERSION';

    const prompt = build15MinPrompt({
      utcTime: new Date().toISOString(),
      ticker: market.ticker,
      btcPrice,
      btcChange24h,
      fundingRate,
      orderBookImbalance: obi,
      yesMid,
      yesProb: yesMid,
      noMid,
      noProb: noMid,
      adjacentStrikes,
      oneMinCandles,
      rsi: fiveMinIndicators.rsi7,
      bbWidth: fiveMinIndicators.bbWidth,
      emaDiff: (fiveMinIndicators.ema5 - fiveMinIndicators.ema10) / fiveMinIndicators.ema10,
      volatility: indicators.volatility,
      atr: fiveMinIndicators.atr5,
      regime,
      volumeRatio: fiveMinIndicators.volumeRatio,
      algoSignal,
    });

    botState.lastGrokCallTime = Date.now(); // start cooldown from point of call
    // Persist lastGrokCallTime immediately so a restart mid-call applies the cooldown
    const preCallPos = readBotPositions();
    (preCallPos as any).grok15minMeta = {
      windowKey,
      lastGrokCallTime: botState.lastGrokCallTime,
    };
    writeBotPositions(preCallPos);
    console.log(`[GROK 15MIN] Querying Grok for ${market.ticker} | Window: ${windowKey} | ${minsRemaining}m remaining`);
    const decision = await getGrokDecision(prompt, 'grok15min');

    // Log decision
    const decisionLog: GrokDecisionLog = {
      timestamp: new Date().toISOString(),
      decision: decision.decision,
      confidence: decision.confidence,
      reason: decision.reason,
      suggestedRisk: decision.suggested_risk,
      ticker: market.ticker,
    };
    botState.lastDecisions = [decisionLog, ...botState.lastDecisions].slice(0, 5);

    console.log(
      `[GROK 15MIN] Decision: ${decision.decision} | ` +
      `Confidence: ${decision.confidence}% | ` +
      `Risk: ${decision.suggested_risk} | ` +
      `"${decision.reason}"`
    );

    if (decision.decision === 'SKIP' || decision.confidence < botConfig.confidenceThreshold) {
      console.log(
        `[GROK 15MIN] Skipping: ${decision.decision === 'SKIP' ? 'SKIP signal' : `confidence ${decision.confidence}% < threshold ${botConfig.confidenceThreshold}%`} | ` +
        `Will re-evaluate in ${GROK_ENTRY_COOLDOWN_MS / 60000}m`
      );
      // Don't lock the window — let the cooldown handle re-evaluation cadence.
      // Grok will get another look when GROK_ENTRY_COOLDOWN_MS elapses and time remains.
      return;
    }

    const side = decision.decision.toLowerCase() as 'yes' | 'no';
    const askCents = side === 'yes' ? market.yes_ask : market.no_ask;
    // Skip if ask is unreasonable or above 45¢ — paying >45¢ to win <55¢ is poor risk/reward
    if (askCents <= 0 || askCents > 45) {
      console.log(`[GROK 15MIN] Ask out of range: ${askCents}¢ (must be 1–45¢) — will retry after cooldown`);
      // Market conditions could change — allow retry after cooldown (lastGrokCallTime already set)
      return;
    }

    // minPriceEdgeCents: skip when both sides are near 50¢ (market open, low edge)
    const arbConfig = config.arb;
    if (Math.abs(market.yes_ask - 50) < arbConfig.minPriceEdgeCents) {
      console.log(
        `[GROK 15MIN] Price edge too low (yes_ask=${market.yes_ask}¢, threshold=${arbConfig.minPriceEdgeCents}¢) — skipping`
      );
      return;
    }

    const entryPriceDollars = askCents / 100;
    const contracts = Math.floor(botConfig.capitalPerTrade / entryPriceDollars);
    if (contracts < 1) {
      console.log(`[GROK 15MIN] Insufficient capital: $${botConfig.capitalPerTrade} < ${askCents}¢/contract`);
      botState.tradedThisWindow = true;
      return;
    }

    console.log(
      `[GROK 15MIN] ENTRY | ${side.toUpperCase()} | ` +
      `Ticker: ${market.ticker} | ` +
      `Ask: ${askCents}¢ | Contracts: ${contracts} | ` +
      `Capital: $${(contracts * entryPriceDollars).toFixed(2)}`
    );

    try {
      const ladderResult = await runSpreadLadder({
        ticker: market.ticker,
        side,
        mode: { type: 'entry', buyContracts: contracts },
        config: arbConfig,
        minutesRemaining: minsRemaining,
      });

      if (ladderResult.status === 'accidental-fill') {
        console.warn('[GROK 15MIN] Accidental fill during ladder — closing at market');
        try {
          await placeOrder('grok15min', market.ticker, side, 'buy', 1, ladderResult.finalAskCents);
        } catch { /* best-effort */ }
        botState.tradedThisWindow = true;
        return;
      }

      if (!ladderResult.buyPlaced) {
        console.log(`[GROK 15MIN] Ladder entry did not place buy (status: ${ladderResult.status})`);
        botState.tradedThisWindow = true;
        return;
      }

      if (ladderResult.buyOrderId) recordBotOrderId(ladderResult.buyOrderId);

      const actualEntryPriceDollars = ladderResult.buyPriceCents / 100;
      const position: BotPosition = {
        bot: 'grok15min',
        ticker: market.ticker,
        side,
        contracts,
        entryPrice: actualEntryPriceDollars,
        totalCost: contracts * actualEntryPriceDollars,
        entryTime: new Date().toISOString(),
        btcPriceAtEntry: btcPrice,
        orderId: ladderResult.buyOrderId,
        fills: [],
      };

      botState.position = position;
      botState.positionSuggestedRisk = decision.suggested_risk;
      botState.entryBtcPrice = btcPrice;
      botState.lastExitCheck = Date.now();
      botState.tradedThisWindow = true;

      const pos = readBotPositions();
      pos.grok15min = position;
      writeBotPositions(pos);

      const saving = askCents - ladderResult.buyPriceCents;
      console.log(
        `[GROK 15MIN] Ladder entry | ID: ${ladderResult.buyOrderId ?? 'n/a'} | ` +
        `${ladderResult.buyPriceCents}¢ (saved ${saving >= 0 ? saving : 0}¢)`
      );
    } catch (err) {
      botState.lastError = err instanceof Error ? err.message : String(err);
      console.error('[GROK 15MIN] Order failed:', err);
      botState.tradedThisWindow = true;
    }
  } catch (err) {
    if (botState) botState.lastError = err instanceof Error ? err.message : String(err);
    console.error('[GROK 15MIN] Loop error:', err);
  } finally {
    loopRunning = false;
  }
}

export function startGrok15MinBot(): void {
  if (botState?.running) {
    console.log('[GROK 15MIN] Already running');
    return;
  }

  // Pre-load any existing position so monitoring resumes immediately on restart.
  // If a position exists, mark this window as already traded to prevent a double-entry
  // (tradedThisWindow resets naturally when the window key changes).
  const existingPositions = readBotPositions();
  const existingPosition = (existingPositions as any).grok15min || null;

  const existingMeta = (existingPositions as any).grok15minMeta;
  const currentWindowKey = get15MinWindowKey();
  const metaForCurrentWindow = existingMeta?.windowKey === currentWindowKey ? existingMeta : null;
  const restoredLastGrokCall = metaForCurrentWindow?.lastGrokCallTime ?? 0;
  // If Grok was called this window (meta exists), treat as tradedThisWindow even if no position yet
  const restoredTradedThisWindow = existingPosition !== null || metaForCurrentWindow !== null;

  botState = {
    running: true,
    position: existingPosition,
    positionSuggestedRisk: 'medium',
    entryBtcPrice: existingPosition?.btcPriceAtEntry ?? 0,
    dailyPnL: 0,
    tradesCount: 0,
    tradedThisWindow: restoredTradedThisWindow,
    currentWindowKey,
    lastDecisions: [],
    lastExitCheck: 0,
    lastGrokCallTime: restoredLastGrokCall,
  };

  if (existingPosition) {
    console.log(`[GROK 15MIN] Resuming position: ${existingPosition.ticker} | ${existingPosition.side.toUpperCase()} ${existingPosition.contracts} @ ${(existingPosition.entryPrice * 100).toFixed(0)}¢`);
  }

  // Clear any orphaned interval from a previous hot-reload
  const g = global as any;
  if (g.__grok15MinInterval) clearInterval(g.__grok15MinInterval);
  botState.intervalId = setInterval(() => grokFifteenMinBotLoop(), LOOP_INTERVAL_MS);
  g.__grok15MinInterval = botState.intervalId;
  grokFifteenMinBotLoop();

  console.log('[GROK 15MIN] Started');
}

export function stopGrok15MinBot(): void {
  if (!botState) return;
  botState.running = false;
  if (botState.intervalId) clearInterval(botState.intervalId);
  if (botState.position) {
    cancelAllOrders('grok15min', botState.position.ticker).catch(() => {});
  }
  botState = null;
  loopRunning = false;
  console.log('[GROK 15MIN] Stopped');
}

export function getGrok15MinBotStatus() {
  if (!botState) {
    return { running: false, dailyPnL: 0, tradesCount: 0, lastDecisions: [] };
  }
  return {
    running: botState.running,
    dailyPnL: botState.dailyPnL,
    tradesCount: botState.tradesCount,
    lastError: botState.lastError,
    hasPosition: botState.position !== null,
    position: botState.position ? {
      ticker: botState.position.ticker,
      side: botState.position.side,
      contracts: botState.position.contracts,
      entryPrice: botState.position.entryPrice,
      totalCost: botState.position.totalCost,
      entryTime: botState.position.entryTime,
      btcPriceAtEntry: botState.position.btcPriceAtEntry,
    } : null,
    lastDecisions: botState.lastDecisions,
  };
}
