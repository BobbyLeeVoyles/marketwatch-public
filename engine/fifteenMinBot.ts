/**
 * 15-Minute Bot Loop V2
 *
 * Autonomous trading bot for KXBTC15M markets:
 * - 5-second polling with 5-min candle data (fixes hourly data bug)
 * - 6-signal strategy with regime detection
 * - Adaptive position sizing from Kalshi balance
 * - Market-aware entry pricing (reads bid/ask)
 * - EV-based early exit logic
 */

import { BTCData } from '@/lib/types';
import { calculateIndicators } from '@/lib/utils/indicators';
import { calculate5MinIndicators } from '@/lib/utils/indicators';
import { check15MinSignalV2 } from '@/lib/strategies/fifteenMin';
import { calculateKalshiFeeBreakdown } from '@/lib/utils/fees';
import { getPrice, fetchHourlyCandles, fetch5MinCandles } from './btcFeed';
import { find15MinMarket, getMarketCached, parseTickerSettlementTime, clearMarketCache } from '@/lib/kalshi/markets';
import { placeOrder, cancelAllOrders } from './kalshiTrader';
import { readBotConfig } from '@/lib/utils/botConfig';
import { logTradeToFile, openTradeLifecycle, appendTradeSnapshot, closeTradeLifecycle, recordBotOrderId } from './positionTracker';
import { getKalshiClient } from '@/lib/kalshi/client';
import { KalshiMarket, BotPosition } from '@/lib/kalshi/types';
import * as fs from 'fs';
import * as path from 'path';

const BOT_POSITIONS_FILE = path.resolve('./data/bot-positions.json');
const BOT_CAPITAL_FILE = path.resolve('./data/bot-capital.json');
const LOOP_INTERVAL_MS = 5_000; // 5 seconds (faster for 15-min markets)
const BALANCE_REFRESH_INTERVAL_MS = 60_000; // 60 seconds
const MIN_TRADING_BALANCE = 1; // Don't trade below $1

interface FifteenMinBotState {
  running: boolean;
  intervalId?: NodeJS.Timeout;
  position: BotPosition | null;
  dailyPnL: number;
  tradesCount: number;
  lastError?: string;
  tradedThisWindow: boolean;
  currentWindowKey: string;
  currentCapital: number;
  lastBalanceCheck?: Date;
  cachedMarket: KalshiMarket | null;
  cachedMarketWindowKey: string; // window key when market was fetched
  nextWindowMarket: KalshiMarket | null; // pre-fetched market for the upcoming window
  lastWindowBtcClose: number;    // BTC close of the most recently completed window
  prevWindowBtcOpen: number;     // BTC open of the most recently completed window (for prev-window return)
  lastLowBalanceLog?: number; // Timestamp of last low balance log
  addOnPlacedThisPosition: boolean; // Only one add-on per position
}

// Add-on constants (from backtest_addon.py sweep)
const ADD_ON_DIP_THRESHOLD = 0.003;  // 0.30% dip vs entry strike triggers add-on
const ADD_ON_SIZE_RATIO    = 0.75;   // Kelly-optimal: 0.75× the original position size
const ADD_ON_MIN_MINS_LEFT = 7;      // Only add on if ≥7 minutes remain in window

let botState: FifteenMinBotState | null = null;
let loopRunning = false;

/**
 * Get current 15-minute window key (rounded to nearest 15 minutes)
 */
function get15MinWindowKey(): string {
  const now = new Date();
  const minutes = Math.floor(now.getMinutes() / 15) * 15;
  return `${now.toISOString().split('T')[0]}-${now.getUTCHours()}-${minutes}`;
}

/**
 * Get current available capital from Kalshi account
 */
async function getCurrentCapital(): Promise<number> {
  try {
    const kalshiClient = getKalshiClient();
    const balanceData = await kalshiClient.getBalance();

    const balanceInDollars = balanceData.balance / 100;
    const payoutInDollars = balanceData.payout / 100;
    const totalCapital = balanceInDollars + payoutInDollars;

    console.log(
      `[15MIN BOT] Capital from Kalshi | ` +
      `Balance: $${balanceInDollars.toFixed(2)} | ` +
      `Pending: $${payoutInDollars.toFixed(2)} | ` +
      `Total: $${totalCapital.toFixed(2)}`
    );

    return totalCapital;
  } catch (error) {
    console.error('[15MIN BOT] Failed to get balance:', error);
    return loadSavedCapital() || 100;
  }
}

/**
 * Load saved capital (fallback if API fails)
 */
function loadSavedCapital(): number | null {
  try {
    if (fs.existsSync(BOT_CAPITAL_FILE)) {
      const data = JSON.parse(fs.readFileSync(BOT_CAPITAL_FILE, 'utf8'));
      return data.fifteenMin || null;
    }
  } catch (error) {
    console.error('[15MIN BOT] Failed to load saved capital:', error);
  }
  return null;
}

/**
 * Save capital (cache for fallback)
 */
function saveCapital(capital: number): void {
  try {
    let data: Record<string, number> = {};
    if (fs.existsSync(BOT_CAPITAL_FILE)) {
      data = JSON.parse(fs.readFileSync(BOT_CAPITAL_FILE, 'utf8'));
    }
    data.fifteenMin = capital;

    const dir = path.dirname(BOT_CAPITAL_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(BOT_CAPITAL_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[15MIN BOT] Failed to save capital:', error);
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
    console.error('[15MIN BOT] Failed to read positions file:', error);
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
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpFile = BOT_POSITIONS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(positions, null, 2));
    fs.renameSync(tmpFile, BOT_POSITIONS_FILE);
  } catch (error) {
    console.error('[15MIN BOT] Failed to write positions file:', error);
  }
}

/**
 * Calculate daily P&L for 15-min bot
 */
function calculateDailyPnL(): { pnl: number; count: number } {
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
    const botTrades = data.daily.trades.filter((t: { strategy: string }) => t.strategy === 'fifteenMin');
    const pnl = botTrades.reduce((sum: number, t: { netPnL: number }) => sum + t.netPnL, 0);
    return { pnl, count: botTrades.length };
  } catch (error) {
    console.error('[15MIN BOT] Failed to calculate daily P&L:', error);
    return { pnl: 0, count: 0 };
  }
}

/**
 * Determine entry price from market data (bid/ask aware)
 */
function getEntryPrice(market: KalshiMarket, direction: 'yes' | 'no'): number {
  const ask = direction === 'yes' ? market.yes_ask : market.no_ask;
  // Floor: 5¢ minimum — anything cheaper is deeply OTM; Kalshi often rejects orders
  // on such markets and our signals have no edge on extreme OTM contracts.
  // Cap: 48¢ maximum — never pay fair value or above.
  if (ask >= 5 && ask <= 48) {
    return ask;
  }
  return 0; // Ask out of reasonable range — skip trade
}

/**
 * Main bot loop
 */
async function fifteenMinBotLoop(): Promise<void> {
  if (!botState || !botState.running) return;
  if (loopRunning) return;
  loopRunning = true;

  try {
    // Check bot config
    const config = readBotConfig();
    const botConfig = config.fifteenMin;
    if (!botConfig.enabled) {
      console.log('[15MIN BOT] Disabled in config, stopping');
      stop15MinBot();
      return;
    }

    // Fetch real balance from Kalshi periodically
    const currentTime = new Date();
    const timeSinceLastCheck = botState.lastBalanceCheck
      ? currentTime.getTime() - botState.lastBalanceCheck.getTime()
      : Infinity;

    if (!botState.lastBalanceCheck || timeSinceLastCheck > BALANCE_REFRESH_INTERVAL_MS) {
      botState.currentCapital = await getCurrentCapital();
      botState.lastBalanceCheck = currentTime;
      saveCapital(botState.currentCapital);
    }

    // Balance floor — don't trade below minimum
    if (botState.currentCapital < MIN_TRADING_BALANCE && !botState.position) {
      const now = Date.now();
      if (!botState.lastLowBalanceLog || now - botState.lastLowBalanceLog > 60_000) {
        console.log(`[15MIN BOT] Balance too low: $${botState.currentCapital.toFixed(2)} < $${MIN_TRADING_BALANCE} — pausing`);
        botState.lastLowBalanceLog = now;
      }
      return;
    }

    // Check daily loss limit
    const { pnl, count } = calculateDailyPnL();
    botState.dailyPnL = pnl;
    botState.tradesCount = count;

    if (pnl < -botConfig.maxDailyLoss) {
      // Don't stop the bot — just skip trading this iteration.
      // Daily P&L resets to $0 when the date rolls over, so trading
      // resumes automatically the next day without a manual restart.
      botState.lastError = `Daily loss limit reached: $${pnl.toFixed(2)} (paused until next day)`;
      return;
    }

    // Get BTC price
    const btcPrice = getPrice();
    if (btcPrice <= 0) {
      return; // Waiting for price
    }

    // Fetch both hourly and 5-min candles
    const [hourlyCandles, fiveMinCandles] = await Promise.all([
      fetchHourlyCandles(),
      fetch5MinCandles(),
    ]);

    if (hourlyCandles.length === 0) {
      return; // Waiting for candles
    }

    const indicators = calculateIndicators(hourlyCandles, btcPrice);
    const fiveMinIndicators = fiveMinCandles.length >= 3
      ? calculate5MinIndicators(fiveMinCandles, btcPrice)
      : undefined;

    const now = new Date();
    const windowKey = get15MinWindowKey();

    // Reset window trade flag and cached market on new window
    if (windowKey !== botState.currentWindowKey) {
      const prevBtcClose = botState.lastWindowBtcClose;
      // Shift: the window that just closed becomes the "previous" window for inter-window momentum.
      // prevWindowBtcOpen = open of the window that just completed (was lastWindowBtcClose from the transition before that)
      botState.prevWindowBtcOpen = botState.lastWindowBtcClose; // prev window's open price
      botState.lastWindowBtcClose = btcPrice; // current price becomes open of new window
      botState.currentWindowKey = windowKey;
      botState.tradedThisWindow = false;
      botState.addOnPlacedThisPosition = false;

      // Promote pre-fetched market (eliminates cold-start API latency at window open)
      if (botState.nextWindowMarket) {
        botState.cachedMarket = botState.nextWindowMarket;
        botState.cachedMarketWindowKey = windowKey;
        console.log(`[15MIN BOT] Using pre-fetched market: ${botState.nextWindowMarket.ticker}`);
      } else {
        botState.cachedMarket = null; // Will fetch on demand
      }
      botState.nextWindowMarket = null;

      // Log regime + momentum context on new window
      if (fiveMinIndicators) {
        const regime = fiveMinIndicators.bbWidth >= 0.003 ? 'MOMENTUM' : 'MEAN_REVERSION';
        const prevReturn = prevBtcClose > 0
          ? ((btcPrice - prevBtcClose) / prevBtcClose) * 100
          : 0;
        console.log(
          `[15MIN BOT] New window: ${windowKey} | ` +
          `Regime: ${regime} | ` +
          `BB Width: ${(fiveMinIndicators.bbWidth * 100).toFixed(2)}% | ` +
          `RSI: ${fiveMinIndicators.rsi7.toFixed(1)} | ` +
          `Prev window BTC: ${prevBtcClose > 0 ? `${prevReturn >= 0 ? '+' : ''}${prevReturn.toFixed(3)}%` : 'n/a'} | ` +
          `Capital: $${botState.currentCapital.toFixed(2)}`
        );
      }
    }

    // Pre-fetch next window's market in the final 60 seconds of the current window.
    // This eliminates the cold-start API latency at the :00/:15/:30/:45 transition —
    // the market ticker is ready the instant the new window opens.
    const minuteInWindowNow = now.getMinutes() % 15;
    const secondsInWindow = minuteInWindowNow * 60 + now.getSeconds();
    const secondsRemaining = 15 * 60 - secondsInWindow;
    if (secondsRemaining <= 60 && !botState.nextWindowMarket) {
      find15MinMarket().then(market => {
        if (market && botState) {
          botState.nextWindowMarket = market;
          console.log(`[15MIN BOT] Pre-fetched next window market: ${market.ticker}`);
        }
      }).catch(() => {});
    }

    // Compute previous window return for inter-window momentum signal.
    // prevWindowBtcOpen = open of the completed window, lastWindowBtcClose = close of the completed window.
    const prevWindowReturn =
      botState.prevWindowBtcOpen > 0 && botState.lastWindowBtcClose > 0
        ? ((botState.lastWindowBtcClose - botState.prevWindowBtcOpen) / botState.prevWindowBtcOpen) * 100
        : undefined;

    const btcData: BTCData = {
      timestamp: now,
      price: btcPrice,
      hourlyData: hourlyCandles,
      indicators,
      fiveMinData: fiveMinCandles.length > 0 ? fiveMinCandles : undefined,
      fiveMinIndicators,
      prevWindowReturn,
    };

    // Load position from file
    const positions = readBotPositions();
    botState.position = positions.fifteenMin || null;

    // Restore tradedThisWindow from file state after a bot restart mid-window.
    // If the stored position was entered during the current 15-min window,
    // the in-memory flag must be true — otherwise a restart resets it to false
    // and the bot places a duplicate order on top of the resting one.
    if (botState.position && !botState.tradedThisWindow) {
      const posTime = new Date(botState.position.entryTime);
      const posWindowMinutes = Math.floor(posTime.getMinutes() / 15) * 15;
      const posWindowKey = `${posTime.toISOString().split('T')[0]}-${posTime.getUTCHours()}-${posWindowMinutes}`;
      if (posWindowKey === windowKey) {
        botState.tradedThisWindow = true;
        console.log(`[15MIN BOT] Restored tradedThisWindow=true from file (position entered this window: ${botState.position.ticker})`);
      }
    }

    // === POSITION MONITORING ===
    if (botState.position) {
      await handleActivePosition(btcData);
      // Block new entry only if this position is from the current window.
      // A prior-window position (tradedThisWindow=false) is settling on its
      // own — don't let it prevent a signal from firing in the new window.
      if (botState.tradedThisWindow) return;
    }

    // === ENTRY LOGIC ===
    if (botState.tradedThisWindow) {
      return; // Already traded this window
    }

    // Check signal first (cheap, no API call) before looking up market
    const signal = check15MinSignalV2(btcData, botState.currentCapital);

    // Diagnostic log every 30s so we can see what the strategy is evaluating
    const secondsInLoop = Math.floor(Date.now() / 1000);
    if (secondsInLoop % 30 < 6 && fiveMinIndicators) {
      const minuteInWin = now.getMinutes() % 15;
      const regime = fiveMinIndicators.bbWidth >= 0.003 ? 'MOM' : 'MR';
      const passed = signal.criteriaChecks?.filter(c => c.passed).map(c => c.label) || [];
      const failed = signal.failedCriteria || [];
      console.log(
        `[15MIN BOT] Signal eval | ` +
        `Regime: ${regime} (BB: ${(fiveMinIndicators.bbWidth * 100).toFixed(3)}%) | ` +
        `Min: ${minuteInWin}/15 | ` +
        `RSI: ${fiveMinIndicators.rsi7.toFixed(1)} | ` +
        `Mom1: ${fiveMinIndicators.momentum1 >= 0 ? '+' : ''}${fiveMinIndicators.momentum1.toFixed(3)}% | ` +
        `Mom3: ${fiveMinIndicators.momentum3 >= 0 ? '+' : ''}${fiveMinIndicators.momentum3.toFixed(3)}% | ` +
        `Vol: ${fiveMinIndicators.volumeRatio.toFixed(1)}x | ` +
        `EMA5-10: ${((fiveMinIndicators.ema5 - fiveMinIndicators.ema10) / fiveMinIndicators.ema10 * 100).toFixed(4)}% | ` +
        `Passed: [${passed.join(', ')}] | ` +
        `Failed: [${failed.join(', ')}]`
      );
    }

    if (!signal.active) {
      return; // No signal
    }

    // Find current 15-min market (cached per window to avoid spamming Kalshi API)
    // Only cache successful results — null means API failed, retry next loop.
    // If the window has changed and no fresh market is found, clear the stale
    // cache so we don't fall through and place an order on the previous window's ticker.
    if (!botState.cachedMarket || botState.cachedMarketWindowKey !== windowKey) {
      const freshMarket = await find15MinMarket();
      if (freshMarket) {
        botState.cachedMarket = freshMarket;
        botState.cachedMarketWindowKey = windowKey;
      } else if (botState.cachedMarketWindowKey !== windowKey) {
        botState.cachedMarket = null;
      }
    }
    const market = botState.cachedMarket;
    if (!market) {
      return; // No market available
    }

    const direction = signal.direction || 'yes';

    // Market-aware entry pricing
    const entryPriceCents = getEntryPrice(market, direction);
    if (entryPriceCents <= 0) {
      return; // No reasonable ask price available — skip trade
    }
    const entryPriceDollars = entryPriceCents / 100;

    // Dynamic half-Kelly position sizing.
    // Kelly fraction varies with entry price: cheap contracts = bigger fraction.
    //   f_full = (p*(b+1) - 1) / b,  where b = net_profit_per_dollar = (1 - entry) / entry
    //   f_half = f_full / 2  (half-Kelly for robustness to win-rate estimation error)
    // Example: 30¢ entry, 50% win rate → full Kelly 26%, half Kelly 13%
    //          20¢ entry, 50% win rate → full Kelly 35%, half Kelly 17.5%
    // The dashboard capitalPerTrade acts as a hard ceiling regardless of Kelly.
    const WIN_RATE_ESTIMATE = 0.42; // break-even matches 48c ask cap; blocks negative-EV entries
    const netOdds = (1 - entryPriceDollars) / entryPriceDollars;
    const fullKelly = Math.max(0, (WIN_RATE_ESTIMATE * (netOdds + 1) - 1) / netOdds);
    const halfKelly = fullKelly / 2;
    const kellySize = botState.currentCapital * halfKelly;

    // Cap: never exceed dashboard capitalPerTrade limit
    const positionSize = Math.min(kellySize, botConfig.capitalPerTrade);
    const contracts = Math.floor(positionSize / entryPriceDollars);

    if (contracts < 1) {
      console.log('[15MIN BOT] Insufficient capital for entry');
      return;
    }

    // Place order
    console.log(
      `[15MIN BOT] ENTRY | ${direction.toUpperCase()} | ` +
      `Ticker: ${market.ticker} | ` +
      `Entry: ${entryPriceCents}¢ | ` +
      `Contracts: ${contracts} | ` +
      `Position: $${positionSize.toFixed(2)} | ` +
      `Capital: $${botState.currentCapital.toFixed(2)} | ` +
      `Signal: ${signal.exitStrategy} | ` +
      `BTC: $${btcPrice.toFixed(0)}`
    );

    try {
      const response = await placeOrder(
        'fifteenMin',
        market.ticker,
        direction,
        'buy',
        contracts,
        entryPriceCents
      );

      // Save position
      const position: BotPosition = {
        bot: 'fifteenMin',
        ticker: market.ticker,
        side: direction,
        contracts,
        entryPrice: entryPriceDollars,
        totalCost: contracts * entryPriceDollars,
        entryTime: now.toISOString(),
        btcPriceAtEntry: btcPrice,
        orderId: response.order.order_id,
        fills: response.fills || [],
        signalName: signal.exitStrategy, // Signal name + regime for per-signal analysis
      };

      botState.position = position;
      positions.fifteenMin = position;
      writeBotPositions(positions);

      botState.tradedThisWindow = true;

      // Track as bot-placed order (for manual trade detection)
      recordBotOrderId(response.order.order_id);

      // Open lifecycle entry — records every 5-second tick from here to close
      openTradeLifecycle({
        tradeId: response.order.order_id,
        bot: 'fifteenMin',
        ticker: market.ticker,
        side: direction,
        contracts,
        entryPrice: entryPriceDollars,
        entryTime: now.toISOString(),
        entryBtcPrice: btcPrice,
        signal: signal.exitStrategy,
      });

      console.log(
        `[15MIN BOT] Order placed | ` +
        `Order ID: ${response.order.order_id} | ` +
        `Status: ${response.order.status}`
      );
    } catch (error) {
      botState.lastError = error instanceof Error ? error.message : String(error);
      console.error('[15MIN BOT] Order failed:', error);
      // Prevent infinite retries on the same signal this window
      botState.tradedThisWindow = true;
      // If it was a balance error, force an immediate refresh next tick
      if (botState.lastError.toLowerCase().includes('balance') || botState.lastError.toLowerCase().includes('insufficient')) {
        botState.lastBalanceCheck = undefined;
      }
    }
  } catch (error) {
    botState.lastError = error instanceof Error ? error.message : String(error);
    console.error('[15MIN BOT] Loop error:', error);
  } finally {
    loopRunning = false;
  }
}

/**
 * Handle active position: settlement monitoring + EV-based early exit
 */
async function handleActivePosition(btcData: BTCData): Promise<void> {
  const position = botState!.position!;
  const btcPrice = btcData.price;

  try {
    const market = await getMarketCached(position.ticker);

    // Safeguard: auto-clear stale positions (market closed >15 min ago)
    // This handles cases where the PC went to sleep and missed settlement.
    const closeTime = new Date(market.close_time).getTime();
    const tickerSettlement = parseTickerSettlementTime(position.ticker);
    const settlementTime = tickerSettlement ? tickerSettlement.getTime() : closeTime;
    const minutesSinceClose = (Date.now() - Math.min(closeTime, settlementTime)) / 60000;

    if (minutesSinceClose > 15 && market.status !== 'settled') {
      console.log(
        `[15MIN BOT] Stale position detected | ` +
        `Ticker: ${position.ticker} closed ${Math.round(minutesSinceClose)}m ago | ` +
        `Checking actual settlement result...`
      );

      // Bust cache and re-fetch fresh market data to check real settlement
      clearMarketCache();
      const freshMarket = await getMarketCached(position.ticker);

      if (freshMarket.status === 'settled') {
        // Market actually settled — use real result
        await handleSettlement(position, freshMarket, btcPrice);
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
          id: position.orderId || `fifteenMin-${Date.now()}`,
          timestamp: position.entryTime,
          strategy: 'fifteenMin',
          direction: position.side,
          strike: undefined,
          entryPrice: position.entryPrice,
          exitPrice,
          exitType: 'settlement',
          contracts: position.contracts,
          netPnL: breakdown.netPnL,
          won: isWin,
          exitReason: `Stale position resolved: ${isWin ? 'WIN' : 'LOSS'} (result: ${freshMarket.result})${position.signalName ? ` [${position.signalName}]` : ''}`,
        });
        if (position.orderId) {
          closeTradeLifecycle({ tradeId: position.orderId, exitTime: new Date().toISOString(), exitBtcPrice: btcPrice, exitType: 'settlement', exitPrice, finalPnL: breakdown.netPnL, won: isWin });
        }
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
          id: position.orderId || `fifteenMin-${Date.now()}`,
          timestamp: position.entryTime,
          strategy: 'fifteenMin',
          direction: position.side,
          strike: undefined,
          entryPrice: position.entryPrice,
          exitPrice: 0,
          exitType: 'settlement',
          contracts: position.contracts,
          netPnL,
          won: false,
          exitReason: `Stale position: no result (closed ${Math.round(minutesSinceClose)}m ago) — ${fillReason}${position.signalName ? ` [${position.signalName}]` : ''}`,
        });
        if (position.orderId) {
          closeTradeLifecycle({ tradeId: position.orderId, exitTime: new Date().toISOString(), exitBtcPrice: btcPrice, exitType: 'settlement', exitPrice: 0, finalPnL: netPnL, won: false });
        }
      }

      const positions = readBotPositions();
      delete positions.fifteenMin;
      writeBotPositions(positions);
      botState!.position = null;
      botState!.addOnPlacedThisPosition = false;
      return;
    }

    // Check if market has settled
    if (market.status === 'settled') {
      await handleSettlement(position, market, btcPrice);
      return;
    }

    // Check if market is closed (expired but not yet settled)
    if (market.status === 'closed') {
      return; // Waiting for settlement
    }

    // === LIFECYCLE SNAPSHOT (every 5-second tick while open) ===
    if (position.orderId) {
      const bidCents = position.side === 'yes' ? market.yes_bid : market.no_bid;
      const askCents = position.side === 'yes' ? market.yes_ask : market.no_ask;
      const bidDollars = bidCents / 100;
      const winProb = (bidCents + askCents) / 200;
      const snapBreakdown = calculateKalshiFeeBreakdown(
        position.contracts,
        position.entryPrice,
        bidDollars,
        'early'
      );
      const minuteInWindow = new Date().getMinutes() % 15;
      appendTradeSnapshot(position.orderId, {
        t: new Date().toISOString(),
        btc: btcPrice,
        bid: bidCents,
        ask: askCents,
        unrealisedPnL: snapBreakdown.netPnL,
        winProb,
        minsRemaining: 15 - minuteInWindow,
      });
    }

    // === DIP ADD-ON (Kelly-sized averaging down) ===
    // Fires when: position exists, no prior add-on, dip >= 0.30% vs entry strike,
    // and >= 7 minutes remain. Size = 0.75× original (Kelly-optimal from backtest).
    const minuteInWindow = new Date().getMinutes() % 15;
    const minsRemaining = 15 - minuteInWindow;

    if (
      !botState!.addOnPlacedThisPosition &&
      position.btcPriceAtEntry &&
      minsRemaining >= ADD_ON_MIN_MINS_LEFT &&
      botState!.currentCapital >= MIN_TRADING_BALANCE
    ) {
      const dipVsEntry = (position.btcPriceAtEntry - btcPrice) / position.btcPriceAtEntry;
      if (dipVsEntry >= ADD_ON_DIP_THRESHOLD) {
        // Get current ask for add-on entry
        const addOnAskCents = position.side === 'yes' ? market.yes_ask : market.no_ask;
        if (addOnAskCents > 0 && addOnAskCents <= 48) {
          const addOnAskDollars = addOnAskCents / 100;
          // Hard cap: total spend (entry + add-on) must not exceed capitalPerTrade
          const config = readBotConfig();
          const botConfig = config.fifteenMin;
          const remainingBudget = botConfig.capitalPerTrade - position.totalCost;
          const addOnCapital = Math.min(position.totalCost * ADD_ON_SIZE_RATIO, remainingBudget);
          const addOnContracts = Math.floor(addOnCapital / addOnAskDollars);

          if (addOnContracts >= 1) {
            console.log(
              `[15MIN BOT] DIP ADD-ON | ` +
              `Dip: ${(dipVsEntry * 100).toFixed(2)}% vs entry $${position.btcPriceAtEntry.toFixed(0)} | ` +
              `Ask: ${addOnAskCents}¢ | Contracts: ${addOnContracts} | ` +
              `Size: $${(addOnContracts * addOnAskDollars).toFixed(2)} (0.75× original) | ` +
              `Mins left: ${minsRemaining}`
            );

            try {
              await placeOrder(
                'fifteenMin',
                position.ticker,
                position.side,
                'buy',
                addOnContracts,
                addOnAskCents
              );
              botState!.addOnPlacedThisPosition = true;

              // Update stored position to reflect new total
              const addOnCost = addOnContracts * addOnAskDollars;
              const updatedPosition: BotPosition = {
                ...position,
                contracts: position.contracts + addOnContracts,
                totalCost: position.totalCost + addOnCost,
                // Blended average entry price
                entryPrice: (position.totalCost + addOnCost) / (position.contracts + addOnContracts),
              };
              botState!.position = updatedPosition;
              const positions = readBotPositions();
              positions.fifteenMin = updatedPosition;
              writeBotPositions(positions);

              console.log(
                `[15MIN BOT] Add-on placed | ` +
                `Total: ${updatedPosition.contracts} contracts | ` +
                `Avg entry: ${(updatedPosition.entryPrice * 100).toFixed(1)}¢`
              );
            } catch (error) {
              console.error('[15MIN BOT] Add-on order failed:', error);
              botState!.addOnPlacedThisPosition = true; // Don't retry on failure
            }
          }
        }
      }
    }

    // === EV-BASED EARLY EXIT ===
    // Disabled: Holding to settlement is mathematically optimal given Kalshi fee structure
    // and the necessity of full .00 payouts to sustain the 26% win rate edge.
  } catch (error) {
    console.error('[15MIN BOT] Position monitoring error:', error);
  }
}

/**
 * Handle market settlement
 */
async function handleSettlement(
  position: BotPosition,
  market: KalshiMarket,
  btcPrice: number
): Promise<void> {
  console.log(
    `[15MIN BOT] Settlement | ` +
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
    id: position.orderId || `fifteenMin-${Date.now()}`,
    timestamp: position.entryTime,
    strategy: 'fifteenMin',
    direction: position.side,
    strike: undefined,
    entryPrice: position.entryPrice,
    exitPrice,
    exitType: 'settlement',
    contracts: position.contracts,
    netPnL: breakdown.netPnL,
    won: isWin,
    exitReason: `Settlement ${isWin ? 'WIN' : 'LOSS'}: BTC $${btcPrice.toFixed(0)}${position.signalName ? ` [${position.signalName}]` : ''}`,
  });

  if (position.orderId) {
    closeTradeLifecycle({
      tradeId: position.orderId,
      exitTime: new Date().toISOString(),
      exitBtcPrice: btcPrice,
      exitType: 'settlement',
      exitPrice,
      finalPnL: breakdown.netPnL,
      won: isWin,
    });
  }

  // Clear position
  const positions = readBotPositions();
  delete positions.fifteenMin;
  writeBotPositions(positions);
  botState!.position = null;
  botState!.addOnPlacedThisPosition = false;

  console.log(
    `[15MIN BOT] Settlement complete | ` +
    `${isWin ? 'WIN' : 'LOSS'} | ` +
    `P&L: $${breakdown.netPnL.toFixed(2)}`
  );
}

/**
 * Start 15-minute bot
 */
export function start15MinBot(): void {
  if (botState && botState.running) {
    console.log('[15MIN BOT] Already running');
    return;
  }

  botState = {
    running: true,
    position: null,
    dailyPnL: 0,
    tradesCount: 0,
    tradedThisWindow: false,
    currentWindowKey: get15MinWindowKey(),
    currentCapital: loadSavedCapital() || 100,
    lastBalanceCheck: undefined,
    cachedMarket: null,
    cachedMarketWindowKey: '',
    nextWindowMarket: null,
    lastWindowBtcClose: 0,
    prevWindowBtcOpen: 0,
    addOnPlacedThisPosition: false,
  };

  // Start polling loop — clear any orphaned interval from a previous hot-reload
  const g = global as any;
  if (g.__fifteenMinInterval) clearInterval(g.__fifteenMinInterval);
  botState.intervalId = setInterval(() => fifteenMinBotLoop(), LOOP_INTERVAL_MS);
  g.__fifteenMinInterval = botState.intervalId;

  // Run immediately
  fifteenMinBotLoop();

  console.log('[15MIN BOT] Started (V2 - 5min candles, 6 signals, adaptive sizing)');
}

/**
 * Stop 15-minute bot
 */
export function stop15MinBot(): void {
  if (!botState) {
    console.log('[15MIN BOT] Not running');
    return;
  }

  botState.running = false;
  if (botState.intervalId) {
    clearInterval(botState.intervalId);
  }

  // Cancel resting orders
  if (botState.position) {
    cancelAllOrders('fifteenMin', botState.position.ticker).catch(error => {
      console.error('[15MIN BOT] Failed to cancel orders:', error);
    });
  }

  botState = null;
  console.log('[15MIN BOT] Stopped');
}

/**
 * Get bot status
 */
export function get15MinBotStatus() {
  if (!botState) {
    return {
      running: false,
      dailyPnL: 0,
      tradesCount: 0,
      currentCapital: loadSavedCapital() || 0,
    };
  }

  return {
    running: botState.running,
    startedAt: botState.intervalId ? new Date().toISOString() : undefined,
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
    currentCapital: botState.currentCapital,
    lastBalanceCheck: botState.lastBalanceCheck?.toISOString(),
  };
}
