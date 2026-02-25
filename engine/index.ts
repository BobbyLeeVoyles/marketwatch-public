import 'dotenv/config';
import { BTCData, FeeStructure } from '@/lib/types';
import { calculateIndicators } from '@/lib/utils/indicators';
import { checkAggressiveSignal } from '@/lib/strategies/aggressive';
import { analyzeExit } from '@/lib/utils/exitLogic';
import { calculateFeeBreakdown } from '@/lib/utils/fees';
import { estimateContractFairValue } from '@/lib/utils/strikes';
import { isTelegramConfigured, notifyBuy, notifySell, notifySettle } from '@/lib/utils/telegram';
import { startPriceFeed, stopPriceFeed, getPrice, isConnected, fetchHourlyCandles } from './btcFeed';
import { writeSignal, EngineSignal } from './signalWriter';
import {
  readPosition,
  writePosition,
  clearPosition,
  hasBoughtThisHour,
  markBoughtThisHour,
  getCurrentHourKey,
  logTradeToFile,
} from './positionTracker';

// Engine uses limit orders → maker fees (0.5%) instead of taker (1.5%)
const ENGINE_FEES: FeeStructure = {
  takerFeePct: 0.5,  // Override: engine uses limit orders = maker rate
  makerFeePct: 0.5,
  settlementFeePct: 0,
};

const LOOP_INTERVAL_MS = 10_000; // 10 seconds

let lastHourKey = '';

async function engineLoop(): Promise<void> {
  const btcPrice = getPrice();
  if (btcPrice <= 0) {
    console.log('[ENGINE] Waiting for BTC price...');
    return;
  }

  const hourlyCandles = await fetchHourlyCandles();
  if (hourlyCandles.length === 0) {
    console.log('[ENGINE] Waiting for hourly candle data...');
    return;
  }

  const indicators = calculateIndicators(hourlyCandles, btcPrice);
  const now = new Date();
  const minutesRemaining = 60 - now.getMinutes();
  const hourKey = getCurrentHourKey();

  // Reset hour tracking on new hour
  if (hourKey !== lastHourKey) {
    lastHourKey = hourKey;
    console.log(`[ENGINE] New hour: ${hourKey}`);
  }

  const btcData: BTCData = {
    timestamp: now,
    price: btcPrice,
    hourlyData: hourlyCandles,
    indicators,
  };

  const position = readPosition();

  if (position.active || position.pending) {
    // === HOLDING A POSITION (or pending buy confirmation) ===

    // Check settlement: top of the hour, different hour than entry
    if (minutesRemaining >= 59 && position.hourKey) {
      const entryHourKey = position.hourKey;
      if (entryHourKey !== hourKey) {
        if (position.pending) {
          // Pending position — settlement clears it (no P&L to log, buy may not have filled)
          const signal: EngineSignal = {
            command: 'SETTLE',
            timestamp: now.toISOString(),
            strike: position.strike,
            direction: position.direction,
            btcPrice,
            reason: 'Settlement reached. Verify if position was filled and check result.',
            instruction: `Verify settlement result for 'Bitcoin ${position.direction === 'yes' ? 'above' : 'below'} $${position.strike?.toLocaleString()}'. Check if the buy order filled. Navigate back to the prediction markets list page.`,
          };
          writeSignal(signal);
          clearPosition();
          console.log(`[ENGINE] SETTLE (pending position) | BTC: $${btcPrice.toFixed(0)}`);
          return;
        }

        // Active position with known fill data — log P&L
        const isWin = position.direction === 'yes'
          ? btcPrice > position.strike!
          : btcPrice < position.strike!;
        const exitPrice = isWin ? 1.0 : 0.0;

        const breakdown = calculateFeeBreakdown(
          position.contracts!,
          position.entryPrice!,
          exitPrice,
          'settlement',
          ENGINE_FEES
        );

        const signal: EngineSignal = {
          command: 'SETTLE',
          timestamp: now.toISOString(),
          strike: position.strike,
          direction: position.direction,
          btcPrice,
          reason: isWin
            ? `Settlement WIN: BTC $${btcPrice.toFixed(0)} ${position.direction === 'yes' ? '>' : '<'} $${position.strike}`
            : `Settlement LOSS: BTC $${btcPrice.toFixed(0)} ${position.direction === 'yes' ? '<=' : '>='} $${position.strike}`,
          instruction: `Verify settlement result for 'Bitcoin ${position.direction === 'yes' ? 'above' : 'below'} $${position.strike?.toLocaleString()}'. Expected: ${isWin ? 'WIN' : 'LOSS'}. Then navigate back to the prediction markets list page.`,
        };
        writeSignal(signal);

        logTradeToFile({
          id: position.tradeId!,
          timestamp: position.entryTime!,
          strategy: 'aggressive',
          direction: position.direction ?? 'yes',
          strike: position.strike!,
          entryPrice: position.entryPrice!,
          exitPrice,
          exitType: 'settlement',
          contracts: position.contracts!,
          netPnL: breakdown.netPnL,
          won: isWin,
          exitReason: signal.reason,
        });

        clearPosition();
        console.log(`[ENGINE] SETTLEMENT: ${isWin ? 'WIN' : 'LOSS'} | P&L: $${breakdown.netPnL.toFixed(2)}`);
        notifySettle(position.direction ?? 'yes', position.strike!, btcPrice, isWin, breakdown.netPnL);
        return;
      }
    }

    // Pending position — skip exit analysis, just tell Claude to stay on position screen
    if (position.pending) {
      const signal: EngineSignal = {
        command: 'MONITOR',
        timestamp: now.toISOString(),
        strike: position.strike,
        direction: position.direction,
        btcPrice,
        reason: 'Buy order sent. Waiting on position screen for settlement.',
      };
      writeSignal(signal);
      console.log(
        `[ENGINE] MONITOR (pending) | BTC: $${btcPrice.toFixed(0)} | Strike: $${position.strike} | ${minutesRemaining}m left`
      );
      return;
    }

    // Active position with fill data — run exit analysis
    const activeTrade = {
      id: position.tradeId!,
      timestamp: new Date(position.entryTime!),
      strategy: 'aggressive' as const,
      direction: (position.direction ?? 'yes') as 'yes' | 'no',
      strike: position.strike!,
      entryPrice: position.entryPrice!,
      contracts: position.contracts!,
      totalCost: position.totalCost!,
      btcPriceAtEntry: position.btcPriceAtEntry!,
    };

    const exitAnalysis = analyzeExit(activeTrade, btcPrice, minutesRemaining, indicators.volatility, ENGINE_FEES);

    if (exitAnalysis.shouldExit) {
      const signal: EngineSignal = {
        command: 'SELL',
        timestamp: now.toISOString(),
        strike: position.strike,
        direction: position.direction,
        orderType: 'market',
        btcPrice,
        reason: exitAnalysis.reason,
        instruction: `Sell ALL contracts of 'Bitcoin ${position.direction === 'yes' ? 'above' : 'below'} $${position.strike?.toLocaleString()}' immediately. MARKET order. Sell all. Reason: ${exitAnalysis.reason}. After confirmation, navigate back to the prediction markets list page.`,
      };
      writeSignal(signal);

      // Log simulated P&L for strategy evaluation
      const yesSellPrice = estimateContractFairValue(
        btcPrice,
        position.strike!,
        indicators.volatility,
        minutesRemaining
      );
      const sellPrice = position.direction === 'no' ? 1 - yesSellPrice : yesSellPrice;

      const breakdown = calculateFeeBreakdown(
        position.contracts!,
        position.entryPrice!,
        sellPrice,
        'early',
        ENGINE_FEES
      );

      logTradeToFile({
        id: position.tradeId!,
        timestamp: position.entryTime!,
        strategy: 'aggressive',
        direction: position.direction ?? 'yes',
        strike: position.strike!,
        entryPrice: position.entryPrice!,
        exitPrice: sellPrice,
        exitType: 'early',
        contracts: position.contracts!,
        netPnL: breakdown.netPnL,
        won: breakdown.netPnL > 0,
        exitReason: exitAnalysis.reason,
      });

      clearPosition();
      console.log(`[ENGINE] SELL (market) | ${exitAnalysis.reason} | Est P&L: $${breakdown.netPnL.toFixed(2)}`);
      notifySell(position.direction ?? 'yes', position.strike!, btcPrice, exitAnalysis.reason, breakdown.netPnL);
    } else {
      const signal: EngineSignal = {
        command: 'MONITOR',
        timestamp: now.toISOString(),
        strike: position.strike,
        direction: position.direction,
        btcPrice,
        reason: exitAnalysis.reason,
      };
      writeSignal(signal);

      const dist = btcPrice - position.strike!;
      console.log(
        `[ENGINE] MONITOR | BTC: $${btcPrice.toFixed(0)} | Strike: $${position.strike} | ` +
        `Dist: ${dist > 0 ? '+' : ''}$${dist.toFixed(0)} | ${minutesRemaining}m left | ` +
        `Risk: ${exitAnalysis.riskLevel} (${(exitAnalysis.riskOfRuin * 100).toFixed(0)}%)`
      );
    }
  } else {
    // === NO POSITION ===
    if (hasBoughtThisHour()) {
      const signal: EngineSignal = {
        command: 'STANDBY',
        timestamp: now.toISOString(),
        btcPrice,
        reason: 'Already traded this hour',
      };
      writeSignal(signal);
      console.log(`[ENGINE] STANDBY (already traded this hour) | BTC: $${btcPrice.toFixed(0)}`);
      return;
    }

    const aggSignal = checkAggressiveSignal(btcData);
    const criteriaMetCount = aggSignal.criteriaChecks?.filter(c => c.passed).length ?? 0;
    const totalCriteria = aggSignal.criteriaChecks?.length ?? 6;

    if (aggSignal.active) {
      // All criteria met — BUY
      const maxPrice = aggSignal.maxEntryPrice ?? aggSignal.entryPrice!;
      const allocatePct = 20; // Use 20% of available balance
      const dir = aggSignal.direction ?? 'yes';
      const dirLabel = dir === 'yes' ? 'YES' : 'NO';
      const aboveBelow = dir === 'yes' ? 'above' : 'below';

      const signal: EngineSignal = {
        command: 'BUY',
        timestamp: now.toISOString(),
        strike: aggSignal.strike,
        direction: dir,
        orderType: 'limit',
        allocatePct,
        maxLimitPrice: maxPrice,
        btcPrice,
        criteriaMetCount,
        reason: `All ${totalCriteria} criteria met. ${dirLabel} fair value ${((aggSignal.estimatedProbability ?? 0) * 100).toFixed(0)}%, max entry at ${(maxPrice * 100).toFixed(0)}c.`,
        instruction: `Buy ${dirLabel} on 'Bitcoin ${aboveBelow} $${aggSignal.strike?.toLocaleString()}'. Use ${allocatePct}% of your available balance. Limit order, max price $${maxPrice.toFixed(2)} per contract. After order fills, stay on the position screen.`,
      };
      writeSignal(signal);

      // Mark as pending — engine doesn't know the real fill price/qty
      writePosition({
        active: false,
        pending: true,
        tradeId: `agg-${Date.now()}`,
        strike: aggSignal.strike,
        direction: dir,
        hourKey: getCurrentHourKey(),
      });
      markBoughtThisHour();

      console.log(
        `[ENGINE] BUY ${dirLabel} | Strike: $${aggSignal.strike} | ${allocatePct}% of balance @ max ${(maxPrice * 100).toFixed(0)}c | ` +
        `BTC: $${btcPrice.toFixed(0)}`
      );
      notifyBuy(dir, aggSignal.strike!, maxPrice, btcPrice, signal.reason!);
    } else if (criteriaMetCount >= 4) {
      // Almost ready — PREP
      const failedStr = aggSignal.failedCriteria?.join(', ') ?? '';
      const prepDir = aggSignal.direction ?? 'yes';
      const prepAboveBelow = prepDir === 'yes' ? 'above' : 'below';
      const signal: EngineSignal = {
        command: 'PREP',
        timestamp: now.toISOString(),
        strike: aggSignal.strike,
        direction: prepDir,
        btcPrice,
        criteriaMetCount,
        reason: `${criteriaMetCount}/${totalCriteria} criteria met. Waiting on: ${failedStr}`,
        instruction: `Navigate to 'Bitcoin ${prepAboveBelow} $${aggSignal.strike?.toLocaleString()}' contract and stand by.`,
      };
      writeSignal(signal);
      console.log(
        `[ENGINE] PREP (${criteriaMetCount}/${totalCriteria}) | BTC: $${btcPrice.toFixed(0)} | Waiting: ${failedStr}`
      );
    } else {
      // Not enough criteria — STANDBY
      const signal: EngineSignal = {
        command: 'STANDBY',
        timestamp: now.toISOString(),
        btcPrice,
        criteriaMetCount,
        reason: `${criteriaMetCount}/${totalCriteria} criteria met`,
      };
      writeSignal(signal);
      console.log(
        `[ENGINE] STANDBY (${criteriaMetCount}/${totalCriteria}) | BTC: $${btcPrice.toFixed(0)} | ${minutesRemaining}m left`
      );
    }
  }
}

// === MAIN ===

import { getBotOrchestrator } from './botOrchestrator';

console.log('===========================================');
console.log('  BTC PREDICTION TERMINAL - STRATEGY ENGINE');
console.log('===========================================');

// Check CLI args for mode
const args = process.argv.slice(2);
const modeArg = args.find(arg => arg.startsWith('--mode='));
const mode = modeArg ? modeArg.split('=')[1] : 'manual';

if (mode === 'bots') {
  // === BOT MODE (Autonomous) ===
  console.log('[ENGINE] Mode: BOT (Autonomous)');
  console.log('[ENGINE] Bots: Conservative + Aggressive + 15-Minute');
  console.log(`[ENGINE] Telegram: ${isTelegramConfigured() ? 'ENABLED' : 'disabled'}`);
  console.log('');

  // Check env vars
  const apiKeyId = process.env.KALSHI_API_KEY_ID;
  const privateKeyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
  const demoMode = process.env.KALSHI_DEMO_MODE === 'true';

  if (!apiKeyId || !privateKeyPath) {
    console.error('[ENGINE] ERROR: Missing Kalshi credentials');
    console.error('[ENGINE] Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH in .env');
    process.exit(1);
  }

  console.log(`[ENGINE] Kalshi API Key ID: ${apiKeyId}`);
  console.log(`[ENGINE] Kalshi Private Key: ${privateKeyPath}`);
  console.log(`[ENGINE] Demo Mode: ${demoMode ? 'YES' : 'NO'}`);
  console.log('');

  // Initialize bot orchestrator
  (async () => {
    try {
      const orchestrator = getBotOrchestrator();
      await orchestrator.initialize(apiKeyId, privateKeyPath, demoMode);
      orchestrator.startEnabledBots();

      const status = orchestrator.getStatus();
      console.log('[ENGINE] Bot status:');
      console.log(`  - Conservative: ${status.conservative.running ? 'RUNNING' : 'stopped'}`);
      console.log(`  - Aggressive: ${status.aggressive.running ? 'RUNNING' : 'stopped'}`);
      console.log(`  - 15-Minute: ${status.fifteenMin.running ? 'RUNNING' : 'stopped'}`);
      console.log('');
      console.log('[ENGINE] Bot mode active. Press Ctrl+C to stop.');
    } catch (error) {
      console.error('[ENGINE] Initialization failed:', error);
      process.exit(1);
    }
  })();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[ENGINE] Shutting down bots...');
    const orchestrator = getBotOrchestrator();
    await orchestrator.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[ENGINE] Shutting down bots...');
    const orchestrator = getBotOrchestrator();
    await orchestrator.shutdown();
    process.exit(0);
  });

} else {
  // === MANUAL MODE (Original behavior) ===
  console.log('[ENGINE] Mode: MANUAL (Signal-only)');
  console.log('[ENGINE] Strategy: Aggressive only');
  console.log('[ENGINE] Order type: Limit (maker fees 0.5%)');
  console.log('[ENGINE] Loop interval: 10 seconds');
  console.log(`[ENGINE] Telegram: ${isTelegramConfigured() ? 'ENABLED' : 'disabled (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)'}`);
  console.log('');

  startPriceFeed((price) => {
    // First price received
    if (currentPriceReady) return;
    currentPriceReady = true;
    console.log(`[ENGINE] First price received: $${price.toFixed(2)}`);
  });

  let currentPriceReady = false;

  // Main loop
  const interval = setInterval(engineLoop, LOOP_INTERVAL_MS);

  // Also run immediately after a short delay for first price
  setTimeout(engineLoop, 3000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[ENGINE] Shutting down...');
    clearInterval(interval);
    stopPriceFeed();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[ENGINE] Shutting down...');
    clearInterval(interval);
    stopPriceFeed();
    process.exit(0);
  });
}
