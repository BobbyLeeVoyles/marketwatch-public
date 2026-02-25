/**
 * Hourly Bot Loop (Conservative + Aggressive)
 *
 * Autonomous trading bot that:
 * 1. Polls BTC price + indicators every 10 seconds
 * 2. Checks strategy signal (conservative or aggressive)
 * 3. Places limit orders on Kalshi when signal triggers
 * 4. Monitors position for exit (early exit or settlement)
 * 5. Tracks daily P&L and enforces loss limits
 */

import { BTCData } from '@/lib/types';
import { calculateIndicators } from '@/lib/utils/indicators';
import { checkConservativeSignal } from '@/lib/strategies/conservative';
import { checkAggressiveSignal } from '@/lib/strategies/aggressive';
import { analyzeExit } from '@/lib/utils/exitLogic';
import { calculateKalshiFeeBreakdown, KALSHI_FEES } from '@/lib/utils/fees';
import { getPrice, fetchHourlyCandles } from './btcFeed';
import { findHourlyMarkets, getMarketCached, parseTickerSettlementTime, clearMarketCache } from '@/lib/kalshi/markets';
import { placeOrder, cancelAllOrders, getPosition } from './kalshiTrader';
import { readBotConfig } from '@/lib/utils/botConfig';
import { logTradeToFile, recordBotOrderId } from './positionTracker';
import { getKalshiClient } from '@/lib/kalshi/client';
import { KalshiMarket, BotPosition } from '@/lib/kalshi/types';
import * as fs from 'fs';
import * as path from 'path';

const BOT_POSITIONS_FILE = path.resolve('./data/bot-positions.json');
const BOT_CAPITAL_FILE = path.resolve('./data/bot-capital.json');
const LOOP_INTERVAL_MS = 10_000; // 10 seconds
const BALANCE_REFRESH_INTERVAL_MS = 60_000; // 60 seconds
const MIN_TRADING_BALANCE = 1; // Don't trade below $1

interface HourlyBotState {
  bot: 'conservative' | 'aggressive';
  running: boolean;
  intervalId?: NodeJS.Timeout;
  position: BotPosition | null;
  dailyPnL: number;
  tradesCount: number;
  lastError?: string;
  tradedThisHour: boolean; // Prevent multiple trades per hour
  lastTradeDirection: 'yes' | 'no' | null; // Direction of last trade this hour
  tradesThisHour: number; // Counter for trades this hour (max 2)
  currentHourKey: string;
  currentCapital: number; // Real-time capital from Kalshi
  lastBalanceCheck?: Date; // When we last fetched from Kalshi
  lastLowBalanceLog?: number; // Timestamp of last low balance log
  lastExitAttemptMs?: number; // Timestamp of last failed early-exit attempt (cooldown gate)
}

const botStates: Map<string, HourlyBotState> = new Map();

/**
 * Get current hour key (YYYY-MM-DD-HH UTC)
 */
function getHourKey(): string {
  const now = new Date();
  return `${now.toISOString().split('T')[0]}-${now.getUTCHours()}`;
}

/**
 * Get current available capital from Kalshi account (real-time balance)
 */
async function getCurrentCapital(bot: 'conservative' | 'aggressive'): Promise<number> {
  try {
    const kalshiClient = getKalshiClient();
    const balanceData = await kalshiClient.getBalance();

    // Balance is in CENTS, convert to DOLLARS
    const balanceInDollars = balanceData.balance / 100;
    const payoutInDollars = balanceData.payout / 100;

    // Total available capital = current balance + pending payouts
    const totalCapital = balanceInDollars + payoutInDollars;

    console.log(
      `[HOURLY BOT] ${bot} capital from Kalshi | ` +
      `Balance: $${balanceInDollars.toFixed(2)} | ` +
      `Pending: $${payoutInDollars.toFixed(2)} | ` +
      `Total: $${totalCapital.toFixed(2)}`
    );

    return totalCapital;
  } catch (error) {
    console.error(`[HOURLY BOT] ${bot} failed to get balance:`, error);
    // Fallback to saved value if API fails
    return loadSavedCapital(bot) || 100;
  }
}

/**
 * Load saved capital for a bot (fallback if API fails)
 */
function loadSavedCapital(bot: 'conservative' | 'aggressive'): number | null {
  try {
    if (fs.existsSync(BOT_CAPITAL_FILE)) {
      const data = JSON.parse(fs.readFileSync(BOT_CAPITAL_FILE, 'utf8'));
      return data[bot] || null;
    }
  } catch (error) {
    console.error('[HOURLY BOT] Failed to load saved capital:', error);
  }
  return null;
}

/**
 * Save capital for a bot (cache for fallback)
 */
function saveCapital(bot: 'conservative' | 'aggressive', capital: number): void {
  try {
    let data: Record<string, number> = {};
    if (fs.existsSync(BOT_CAPITAL_FILE)) {
      data = JSON.parse(fs.readFileSync(BOT_CAPITAL_FILE, 'utf8'));
    }
    data[bot] = capital;

    const dir = path.dirname(BOT_CAPITAL_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(BOT_CAPITAL_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[HOURLY BOT] Failed to save capital:', error);
  }
}

/**
 * Read bot positions from file
 */
function readBotPositions(): Record<string, BotPosition> {
  try {
    if (fs.existsSync(BOT_POSITIONS_FILE)) {
      return JSON.parse(fs.readFileSync(BOT_POSITIONS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('[HOURLY BOT] Failed to read positions file:', error);
  }
  return {};
}

/**
 * Write bot positions to file (atomic)
 */
function writeBotPositions(positions: Record<string, BotPosition>): void {
  try {
    const dir = path.dirname(BOT_POSITIONS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true});
    }
    const tmpFile = BOT_POSITIONS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(positions, null, 2));
    fs.renameSync(tmpFile, BOT_POSITIONS_FILE);
  } catch (error) {
    console.error('[HOURLY BOT] Failed to write positions file:', error);
  }
}

/**
 * Calculate daily P&L for a bot from trades file
 */
function calculateDailyPnL(bot: 'conservative' | 'aggressive'): { pnl: number; count: number } {
  try {
    const tradesPath = path.resolve('./data/trades.json');
    if (!fs.existsSync(tradesPath)) {
      return { pnl: 0, count: 0 };
    }
    const data = JSON.parse(fs.readFileSync(tradesPath, 'utf8'));
    const today = new Date().toISOString().split('T')[0];
    if (data.daily?.date !== today) {
      return { pnl: 0, count: 0 };
    }
    const botTrades = data.daily.trades.filter((t: { strategy: string }) => t.strategy === bot);
    const pnl = botTrades.reduce((sum: number, t: { netPnL: number }) => sum + t.netPnL, 0);
    return { pnl, count: botTrades.length };
  } catch (error) {
    console.error('[HOURLY BOT] Failed to calculate daily P&L:', error);
    return { pnl: 0, count: 0 };
  }
}

/**
 * Main bot loop
 */
async function hourlyBotLoop(bot: 'conservative' | 'aggressive'): Promise<void> {
  const state = botStates.get(bot);
  if (!state || !state.running) return;

  try {
    // Check bot config
    const config = readBotConfig();
    const botConfig = config[bot];
    if (!botConfig.enabled) {
      console.log(`[HOURLY BOT] ${bot} disabled in config, stopping`);
      stopHourlyBot(bot);
      return;
    }

    // Fetch real balance from Kalshi every 60 seconds
    const currentTime = new Date();
    const timeSinceLastCheck = state.lastBalanceCheck
      ? currentTime.getTime() - state.lastBalanceCheck.getTime()
      : Infinity;

    if (!state.lastBalanceCheck || timeSinceLastCheck > BALANCE_REFRESH_INTERVAL_MS) {
      state.currentCapital = await getCurrentCapital(bot);
      state.lastBalanceCheck = currentTime;
      saveCapital(bot, state.currentCapital); // Cache for fallback
    }

    // Balance floor — don't trade below minimum
    if (state.currentCapital < MIN_TRADING_BALANCE && !state.position) {
      const now = Date.now();
      if (!state.lastLowBalanceLog || now - state.lastLowBalanceLog > 60_000) {
        console.log(`[HOURLY BOT] ${bot} balance too low: $${state.currentCapital.toFixed(2)} < $${MIN_TRADING_BALANCE} — pausing`);
        state.lastLowBalanceLog = now;
      }
      return;
    }

    // Check daily loss limit
    const { pnl, count } = calculateDailyPnL(bot);
    state.dailyPnL = pnl;
    state.tradesCount = count;

    if (pnl < -botConfig.maxDailyLoss) {
      // Don't stop the bot — just skip trading this iteration.
      // Daily P&L resets to $0 when the date rolls over, so trading
      // resumes automatically the next day without a manual restart.
      state.lastError = `Daily loss limit reached: $${pnl.toFixed(2)} (paused until next day)`;
      return;
    }

    // Get BTC price and data
    const btcPrice = getPrice();
    if (btcPrice <= 0) {
      console.log(`[HOURLY BOT] ${bot} waiting for BTC price...`);
      return;
    }

    const hourlyCandles = await fetchHourlyCandles();
    if (hourlyCandles.length === 0) {
      console.log(`[HOURLY BOT] ${bot} waiting for hourly candles...`);
      return;
    }

    const indicators = calculateIndicators(hourlyCandles, btcPrice);
    const now = new Date();
    const hourKey = getHourKey();

    // Reset hourly trade flag on new hour
    if (hourKey !== state.currentHourKey) {
      state.currentHourKey = hourKey;
      state.tradedThisHour = false;
      state.lastTradeDirection = null;
      state.tradesThisHour = 0;
      console.log(`[HOURLY BOT] ${bot} new hour: ${hourKey}`);
    }

    const btcData: BTCData = {
      timestamp: now,
      price: btcPrice,
      hourlyData: hourlyCandles,
      indicators,
    };

    // Load position from file
    const positions = readBotPositions();
    state.position = positions[bot] || null;

    // === POSITION MONITORING ===
    if (state.position) {
      await handleActivePosition(bot, state, btcData, botConfig.capitalPerTrade);
      return;
    }

    // === ENTRY LOGIC ===
    if (state.tradedThisHour && state.lastTradeDirection) {
      if (state.tradesThisHour >= 2) {
        return; // Already had initial trade + one re-entry attempt this hour
      }
      // Allow re-entry only in the opposite direction
      const reentrySignal = bot === 'conservative'
        ? checkConservativeSignal(btcData)
        : checkAggressiveSignal(btcData, state.currentCapital);
      if (!reentrySignal.active || reentrySignal.direction === state.lastTradeDirection) {
        return; // No signal or same direction — block re-entry
      }
      console.log(
        `[HOURLY BOT] ${bot} opposite direction re-entry | ` +
        `Last: ${state.lastTradeDirection.toUpperCase()} → New: ${reentrySignal.direction?.toUpperCase()}`
      );
      // Opposite direction signal — allow re-entry below
    }

    // Check signal with real-time capital for adaptive position sizing
    const signal = bot === 'conservative'
      ? checkConservativeSignal(btcData)
      : checkAggressiveSignal(btcData, state.currentCapital);

    if (!signal.active) {
      return; // No signal
    }

    // Check minimum time remaining (15 minutes)
    const minutesRemaining = 60 - now.getMinutes();
    if (minutesRemaining < 15) {
      console.log(`[HOURLY BOT] ${bot} skipping: only ${minutesRemaining}m left in hour`);
      return;
    }

    // Find markets
    const markets = await findHourlyMarkets(btcPrice);
    let targetMarket: KalshiMarket | null = null;
    let strike: number | null = null;

    if (bot === 'conservative') {
      // Conservative trades floor strike
      targetMarket = markets.floorStrike;
      strike = markets.floorStrikeValue;
    } else {
      // Aggressive: YES → floor strike (ITM), NO → next-up strike (ITM)
      if (signal.direction === 'yes') {
        targetMarket = markets.floorStrike;
        strike = markets.floorStrikeValue;
      } else {
        targetMarket = markets.nextUpStrike;
        strike = markets.nextUpStrikeValue;
      }
    }

    if (!targetMarket || strike === null) {
      console.log(`[HOURLY BOT] ${bot} no suitable market found`);
      return;
    }

    const side = (signal.direction || 'yes') as 'yes' | 'no';

    // Market-aware entry pricing: use real ask, capped by model fair value
    const marketAskCents = side === 'yes' ? targetMarket.yes_ask : targetMarket.no_ask;
    const modelEntryDollars = signal.entryPrice || 0.25;
    const modelEntryCents = Math.round(modelEntryDollars * 100);

    // Use market ask if available and reasonable, otherwise use model price
    let priceInCents: number;
    if (marketAskCents > 0 && marketAskCents <= modelEntryCents) {
      priceInCents = marketAskCents; // Market is at or below model — good price
    } else if (marketAskCents > modelEntryCents) {
      priceInCents = modelEntryCents; // Market ask too high — limit at model price
    } else {
      priceInCents = modelEntryCents; // No ask available — use model price
    }

    // Calculate contracts from adaptive position size — capped by dashboard capitalPerTrade limit
    const positionSize = Math.min(
      signal.positionSize || botConfig.capitalPerTrade,
      botConfig.capitalPerTrade
    );
    const entryPriceDollars = priceInCents / 100;
    const contracts = Math.floor(positionSize / entryPriceDollars);

    if (contracts < 1) {
      console.log(`[HOURLY BOT] ${bot} insufficient capital: need at least $${entryPriceDollars.toFixed(2)}`);
      return;
    }

    // Place order
    console.log(
      `[HOURLY BOT] ${bot} ENTRY | ${side.toUpperCase()} | ` +
      `Strike: $${strike.toLocaleString()} | ` +
      `Ticker: ${targetMarket.ticker} | ` +
      `Entry: ${priceInCents}¢ (ask: ${marketAskCents}¢, model: ${modelEntryCents}¢) | ` +
      `Capital: $${state.currentCapital.toFixed(2)} | ` +
      `Position: $${positionSize.toFixed(2)} | ` +
      `Contracts: ${contracts} | ` +
      `BTC: $${btcPrice.toFixed(0)}`
    );

    try {
      const response = await placeOrder(
        bot,
        targetMarket.ticker,
        side,
        'buy',
        contracts,
        priceInCents
      );

      // Save position
      const position: BotPosition = {
        bot,
        ticker: targetMarket.ticker,
        side,
        contracts,
        entryPrice: priceInCents / 100,
        totalCost: contracts * (priceInCents / 100),
        entryTime: now.toISOString(),
        btcPriceAtEntry: btcPrice,
        strike,
        orderId: response.order.order_id,
        fills: response.fills || [],
      };

      state.position = position;
      positions[bot] = position;
      writeBotPositions(positions);

      state.tradedThisHour = true;
      state.lastTradeDirection = side;
      state.tradesThisHour++;

      // Track as bot-placed order (for manual trade detection)
      recordBotOrderId(response.order.order_id);

      console.log(
        `[HOURLY BOT] ${bot} order placed | ` +
        `Order ID: ${response.order.order_id} | ` +
        `Status: ${response.order.status} | ` +
        `Trade #${state.tradesThisHour} this hour`
      );
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      console.error(`[HOURLY BOT] ${bot} order failed:`, error);
      // Prevent infinite retries this hour — set direction so re-entry guard works correctly
      state.tradedThisHour = true;
      state.lastTradeDirection = side;
      state.tradesThisHour++; // Count failed attempts, not just successes
      // If it was a balance error, force an immediate refresh next tick
      if (state.lastError.toLowerCase().includes('balance') || state.lastError.toLowerCase().includes('insufficient')) {
        state.lastBalanceCheck = undefined;
      }
    }
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    console.error(`[HOURLY BOT] ${bot} loop error:`, error);
  }
}

/**
 * Handle active position (exit monitoring)
 */
async function handleActivePosition(
  bot: 'conservative' | 'aggressive',
  state: HourlyBotState,
  btcData: BTCData,
  capitalPerTrade: number
): Promise<void> {
  const position = state.position!;
  const btcPrice = btcData.price;
  const now = new Date();

  // Get current market data
  try {
    const market = await getMarketCached(position.ticker);

    // Safeguard: if market close_time is far in the past, this is a stale position
    // (e.g., PC went to sleep and missed settlement). Auto-clear it.
    const closeTime = new Date(market.close_time).getTime();
    const tickerSettlement = parseTickerSettlementTime(position.ticker);
    const settlementTime = tickerSettlement ? tickerSettlement.getTime() : closeTime;
    const minutesSinceClose = (Date.now() - Math.min(closeTime, settlementTime)) / 60000;

    if (minutesSinceClose > 60 && market.status !== 'settled') {
      console.log(
        `[HOURLY BOT] ${bot} stale position detected | ` +
        `Ticker: ${position.ticker} closed ${Math.round(minutesSinceClose)}m ago | ` +
        `Checking actual settlement result...`
      );

      // Bust cache and re-fetch fresh market data to check real settlement
      clearMarketCache();
      const freshMarket = await getMarketCached(position.ticker);

      if (freshMarket.status === 'settled') {
        // Market actually settled — use real result
        await handleSettlement(bot, state, position, freshMarket, btcPrice);
        return;
      }

      if (freshMarket.result) {
        // Has result but not fully settled — use result to determine win/loss
        const isWin = freshMarket.result === position.side;
        const exitPrice = isWin ? 1.0 : 0.0;
        const breakdown = calculateKalshiFeeBreakdown(
          position.contracts,
          position.entryPrice,
          exitPrice,
          'settlement'
        );

        logTradeToFile({
          id: position.orderId || `${bot}-${Date.now()}`,
          timestamp: position.entryTime,
          strategy: bot,
          direction: position.side,
          strike: position.strike!,
          entryPrice: position.entryPrice,
          exitPrice,
          exitType: 'settlement',
          contracts: position.contracts,
          netPnL: breakdown.netPnL,
          won: isWin,
          exitReason: `Stale position resolved: ${isWin ? 'WIN' : 'LOSS'} (result: ${freshMarket.result})`,
        });
      } else {
        // No settlement data available.
        // Check order fill status before recording a loss — orders placed on already-closed
        // markets are silently rejected by Kalshi (resting, fill_count=0), so no capital
        // was actually deployed and logging a loss would be incorrect.
        let netPnL = 0;
        let fillReason = 'fill unverified — defaulting to $0';
        try {
          const client = getKalshiClient();
          const ordersData = await client.getOrders(position.ticker);
          const orders: any[] = ordersData.orders || [];
          const ourOrder = orders.find((o: any) => o.order_id === position.orderId);
          if (ourOrder) {
            if (ourOrder.fill_count === 0 || ourOrder.status === 'resting') {
              fillReason = 'order never filled (resting) — $0 loss';
            } else if (ourOrder.fill_count > 0) {
              netPnL = -position.totalCost;
              fillReason = `order filled (${ourOrder.fill_count} contracts) — recording loss`;
            }
          } else {
            // Order not found in history — likely purged; default to $0
            fillReason = 'order not found in history — defaulting to $0';
          }
        } catch {
          // API check failed — default to $0 to avoid recording false losses
          fillReason = 'fill check API failed — defaulting to $0';
        }
        logTradeToFile({
          id: position.orderId || `${bot}-${Date.now()}`,
          timestamp: position.entryTime,
          strategy: bot,
          direction: position.side,
          strike: position.strike!,
          entryPrice: position.entryPrice,
          exitPrice: 0,
          exitType: 'settlement',
          contracts: position.contracts,
          netPnL,
          won: false,
          exitReason: `Stale position: no result (closed ${Math.round(minutesSinceClose)}m ago) — ${fillReason}`,
        });
      }

      const positions = readBotPositions();
      delete positions[bot];
      writeBotPositions(positions);
      state.position = null;
      return;
    }

    // Check if market has settled
    if (market.status === 'settled') {
      await handleSettlement(bot, state, position, market, btcPrice);
      return;
    }

    // Check if market is closed (expired but not yet settled)
    if (market.status === 'closed') {
      console.log(
        `[HOURLY BOT] ${bot} market closed, waiting for settlement | ` +
        `Ticker: ${position.ticker}`
      );
      return;
    }

    // Check early exit conditions
    const activeTrade = {
      id: position.orderId || '',
      timestamp: new Date(position.entryTime),
      strategy: bot,
      direction: position.side,
      strike: position.strike!,
      entryPrice: position.entryPrice,
      contracts: position.contracts,
      totalCost: position.totalCost,
      btcPriceAtEntry: position.btcPriceAtEntry,
    };
    // Calculate minutes remaining until hourly settlement (close_time, NOT expiration_time)
    // expiration_time is the event-level expiration (~7 days), close_time is hourly settlement
    let minutesRemaining = Math.max(0, (new Date(market.close_time).getTime() - Date.now()) / 60000);

    // Sanity check: if close_time seems wrong (>120 min), fall back to ticker-parsed settlement
    if (minutesRemaining > 120) {
      const tickerSettlement = parseTickerSettlementTime(position.ticker);
      if (tickerSettlement) {
        minutesRemaining = Math.max(0, (tickerSettlement.getTime() - Date.now()) / 60000);
        console.log(
          `[HOURLY BOT] ${bot} close_time unreliable (${Math.round(minutesRemaining)}m), ` +
          `using ticker settlement: ${Math.round(minutesRemaining)}m remaining`
        );
      }
    }

    const marketBid = position.side === 'yes' ? market.yes_bid : market.no_bid;
    const marketBidDollars = marketBid > 0 ? marketBid / 100 : undefined;

    const exitAnalysis = analyzeExit(
      activeTrade,
      btcPrice,
      minutesRemaining,
      btcData.indicators.volatility,
      KALSHI_FEES,
      marketBidDollars,  // Real market price for exit decisions
    );

    if (exitAnalysis.shouldExit) {
      const nowMs = Date.now();
      const exitCooldownMs = 60_000;
      if (state.lastExitAttemptMs && nowMs - state.lastExitAttemptMs < exitCooldownMs) {
        // Already attempted recently — stay silent until cooldown expires
        return;
      }
      state.lastExitAttemptMs = nowMs; // Record attempt time BEFORE the try

      console.log(
        `[HOURLY BOT] ${bot} early exit signal | ` +
        `Reason: ${exitAnalysis.reason} | ` +
        `BTC: $${btcPrice.toFixed(0)}`
      );

      // Place sell order at current market price
      const currentPrice = position.side === 'yes' ? market.yes_bid : market.no_bid;
      if (currentPrice > 0) {
        try {
          await placeOrder(
            bot,
            position.ticker,
            position.side,
            'sell',
            position.contracts,
            currentPrice
          );

          // Calculate P&L
          const breakdown = calculateKalshiFeeBreakdown(
            position.contracts,
            position.entryPrice,
            currentPrice / 100,
            'early'
          );

          // Log trade
          logTradeToFile({
            id: position.orderId || `${bot}-${Date.now()}`,
            timestamp: position.entryTime,
            strategy: bot,
            direction: position.side,
            strike: position.strike!,
            entryPrice: position.entryPrice,
            exitPrice: currentPrice / 100,
            exitType: 'early',
            contracts: position.contracts,
            netPnL: breakdown.netPnL,
            won: breakdown.netPnL > 0,
            exitReason: exitAnalysis.reason,
          });

          // Clear position
          const positions = readBotPositions();
          delete positions[bot];
          writeBotPositions(positions);
          state.position = null;
          state.lastExitAttemptMs = undefined; // Clear cooldown on success

          console.log(
            `[HOURLY BOT] ${bot} early exit complete | ` +
            `P&L: $${breakdown.netPnL.toFixed(2)}`
          );
        } catch (error) {
          console.error(`[HOURLY BOT] ${bot} early exit failed (will retry in 60s):`, error);
          // position stays open; lastExitAttemptMs gates the next retry
        }
      } else if (minutesRemaining <= 0) {
        // Market expired with no bid — contract is worthless, nothing to sell.
        // Record the full loss and clear the position so the bot can continue.
        const breakdown = calculateKalshiFeeBreakdown(
          position.contracts,
          position.entryPrice,
          0,
          'early'
        );
        logTradeToFile({
          id: position.orderId || `${bot}-${Date.now()}`,
          timestamp: position.entryTime,
          strategy: bot,
          direction: position.side,
          strike: position.strike!,
          entryPrice: position.entryPrice,
          exitPrice: 0,
          exitType: 'early',
          contracts: position.contracts,
          netPnL: breakdown.netPnL,
          won: false,
          exitReason: `Expired with no bid: ${exitAnalysis.reason}`,
        });
        const positions = readBotPositions();
        delete positions[bot];
        writeBotPositions(positions);
        state.position = null;
        state.lastExitAttemptMs = undefined;
        console.log(
          `[HOURLY BOT] ${bot} position cleared — expired with no bid | ` +
          `P&L: $${breakdown.netPnL.toFixed(2)}`
        );
      }
    }
  } catch (error) {
    console.error(`[HOURLY BOT] ${bot} position monitoring error:`, error);
  }
}

/**
 * Handle market settlement
 */
async function handleSettlement(
  bot: 'conservative' | 'aggressive',
  state: HourlyBotState,
  position: BotPosition,
  market: KalshiMarket,
  btcPrice: number
): Promise<void> {
  console.log(
    `[HOURLY BOT] ${bot} settlement | ` +
    `Ticker: ${position.ticker} | ` +
    `Result: ${market.result || 'unknown'}`
  );

  const isWin = market.result === position.side;
  const exitPrice = isWin ? 1.0 : 0.0;

  const breakdown = calculateKalshiFeeBreakdown(
    position.contracts,
    position.entryPrice,
    exitPrice,
    'settlement'
  );

  // Log trade
  logTradeToFile({
    id: position.orderId || `${bot}-${Date.now()}`,
    timestamp: position.entryTime,
    strategy: bot,
    direction: position.side,
    strike: position.strike!,
    entryPrice: position.entryPrice,
    exitPrice,
    exitType: 'settlement',
    contracts: position.contracts,
    netPnL: breakdown.netPnL,
    won: isWin,
    exitReason: `Settlement ${isWin ? 'WIN' : 'LOSS'}: BTC $${btcPrice.toFixed(0)}`,
  });

  // Clear position
  const positions = readBotPositions();
  delete positions[bot];
  writeBotPositions(positions);
  state.position = null;

  console.log(
    `[HOURLY BOT] ${bot} settlement complete | ` +
    `${isWin ? 'WIN' : 'LOSS'} | ` +
    `P&L: $${breakdown.netPnL.toFixed(2)}`
  );
}

/**
 * Start hourly bot
 */
export function startHourlyBot(bot: 'conservative' | 'aggressive'): void {
  if (botStates.has(bot)) {
    const state = botStates.get(bot)!;
    if (state.running) {
      console.log(`[HOURLY BOT] ${bot} already running`);
      return;
    }
  }

  // Pre-load any existing position so monitoring resumes immediately
  // and prevent double-entry on restart within the same hour.
  const existingPositions = readBotPositions();
  const existingPosition = existingPositions[bot] || null;

  const state: HourlyBotState = {
    bot,
    running: true,
    position: existingPosition,
    dailyPnL: 0,
    tradesCount: 0,
    tradedThisHour: existingPosition !== null,       // lock this hour if position exists
    lastTradeDirection: existingPosition ? existingPosition.side : null,
    tradesThisHour: existingPosition !== null ? 1 : 0,
    currentHourKey: getHourKey(),
    currentCapital: loadSavedCapital(bot) || 100, // Will be updated from Kalshi on first loop
    lastBalanceCheck: undefined, // Will fetch on first loop
  };

  if (existingPosition) {
    console.log(
      `[HOURLY BOT] ${bot} resuming position: ${existingPosition.ticker} | ` +
      `${existingPosition.side.toUpperCase()} ${existingPosition.contracts} @ ${(existingPosition.entryPrice * 100).toFixed(0)}¢`
    );
  }

  // Start polling loop
  state.intervalId = setInterval(() => hourlyBotLoop(bot), LOOP_INTERVAL_MS);

  // Run immediately
  hourlyBotLoop(bot);

  botStates.set(bot, state);
  console.log(`[HOURLY BOT] ${bot} started`);
}

/**
 * Stop hourly bot
 */
export function stopHourlyBot(bot: 'conservative' | 'aggressive'): void {
  const state = botStates.get(bot);
  if (!state) {
    console.log(`[HOURLY BOT] ${bot} not running`);
    return;
  }

  state.running = false;
  if (state.intervalId) {
    clearInterval(state.intervalId);
  }

  // Cancel resting orders
  if (state.position) {
    cancelAllOrders(bot, state.position.ticker).catch(error => {
      console.error(`[HOURLY BOT] ${bot} failed to cancel orders:`, error);
    });
  }

  botStates.delete(bot);
  console.log(`[HOURLY BOT] ${bot} stopped`);
}

/**
 * Get bot status
 */
export function getHourlyBotStatus(bot: 'conservative' | 'aggressive') {
  const state = botStates.get(bot);
  if (!state) {
    return {
      running: false,
      dailyPnL: 0,
      tradesCount: 0,
      currentCapital: loadSavedCapital(bot) || 0,
    };
  }

  return {
    running: state.running,
    startedAt: state.intervalId ? new Date().toISOString() : undefined,
    dailyPnL: state.dailyPnL,
    tradesCount: state.tradesCount,
    lastError: state.lastError,
    hasPosition: state.position !== null,
    position: state.position ? {
      ticker: state.position.ticker,
      side: state.position.side,
      contracts: state.position.contracts,
      entryPrice: state.position.entryPrice,
      totalCost: state.position.totalCost,
      entryTime: state.position.entryTime,
      btcPriceAtEntry: state.position.btcPriceAtEntry,
      strike: state.position.strike,
    } : null,
    currentCapital: state.currentCapital,
    lastBalanceCheck: state.lastBalanceCheck?.toISOString(),
  };
}
