import { BTCData, Signal, CriteriaCheck, HourlyCandle } from '@/lib/types';
import { calculateStrike, estimateContractFairValue } from '@/lib/utils/strikes';

const STRIKE_INCREMENT = 250;

// ────────────────────────────────────────────────────────────────────────────
// Multi-signal OTM strategy — BULLISH (YES) and BEARISH (NO)
//
// Checks 8 bullish + 8 bearish signal types. Any one firing (plus time +
// probability prerequisites) triggers a trade.
//
// Bullish signals → Buy YES on next-up strike (floor + $250)
// Bearish signals → Buy NO on floor strike (price must drop below)
//
// All signals use ROLLING momentum (close-to-close across candle boundaries).
// Smart early exit (OTM path in exitLogic.ts) is critical for profitability.
//
// OPTIMIZATIONS:
// - Bankroll % sizing (2-5% adaptive): +178% vs fixed position (ADAPTIVE_POSITION_SIZING_ANALYSIS.md)
// - Weak-trend signals (trend exhaustion): +3.3% improvement (AGGRESSIVE_ENHANCEMENT_ANALYSIS.md)
// ────────────────────────────────────────────────────────────────────────────

// Common parameters
const POSITION_SIZE = 20; // Default fallback
const MAX_ENTRY_PRICE = 0.75;
const MIN_TIME_REMAINING = 15;
const PROB_LO = 0.35;
const PROB_HI = 0.85;
const SMA_LOOSENESS = 0.003;

// Signal thresholds (symmetric for bull/bear)
const ROLLING_MIN_RETURN = 0.20;
const DIP_MIN_PCT = 0.30; // absolute value — dip > 0.3% or rally > 0.3%
const DIP_MIN_RECOVERY = 0.20;
const MULTI_MIN_1H = 0.10;
const MULTI_MIN_2H = 0.20;
const VOLUME_MIN_RATIO = 1.50;
const VOLUME_MIN_RETURN = 0.20;
const PSYCH_INCREMENT = 500;
const SELLOFF_MIN_MOVE = 0.50; // absolute: selloff > 0.5% or rally > 0.5%
const SELLOFF_MIN_REVERSAL = 0.20;
const VOL_EXPANSION_MIN = 1.80;
const VOL_EXPANSION_MIN_RET = 0.10;
const WEAK_TREND_THRESHOLD = 0.005; // 0.5% — trend exhaustion detection

// ──── Signal computation helpers ────

function rollingReturn(candles: HourlyCandle[], currentPrice: number, lookbackHours: number): number {
  if (candles.length < lookbackHours + 1) return 0;
  const oldClose = candles[candles.length - 1 - lookbackHours].close;
  if (oldClose === 0) return 0;
  return ((currentPrice - oldClose) / oldClose) * 100;
}

function volumeRatio(candles: HourlyCandle[], lookback: number = 6): number {
  if (candles.length < lookback + 2) return 1.0;
  const lastComplete = candles[candles.length - 2];
  const priorCandles = candles.slice(-(lookback + 2), -2);
  const avgVol = priorCandles.reduce((s, c) => s + c.volume, 0) / priorCandles.length;
  if (avgVol === 0) return 1.0;
  return lastComplete.volume / avgVol;
}

function dipRecovery(candles: HourlyCandle[], currentPrice: number): {
  dipPct: number;
  recoveryPct: number;
  isBouncing: boolean;
} {
  if (candles.length < 3) return { dipPct: 0, recoveryPct: 0, isBouncing: false };
  const twoPrev = candles[candles.length - 3];
  const prev = candles[candles.length - 2];
  if (twoPrev.close === 0 || prev.low === 0)
    return { dipPct: 0, recoveryPct: 0, isBouncing: false };

  const dipPct = ((prev.low - twoPrev.close) / twoPrev.close) * 100;
  const recoveryPct = ((currentPrice - prev.low) / prev.low) * 100;
  const isBouncing = dipPct < -0.1 && recoveryPct > 0.1;
  return { dipPct, recoveryPct, isBouncing };
}

function rallyRejection(candles: HourlyCandle[], currentPrice: number): {
  rallyPct: number;
  rejectionPct: number;
  isRejecting: boolean;
} {
  if (candles.length < 3) return { rallyPct: 0, rejectionPct: 0, isRejecting: false };
  const twoPrev = candles[candles.length - 3];
  const prev = candles[candles.length - 2];
  if (twoPrev.close === 0 || prev.high === 0)
    return { rallyPct: 0, rejectionPct: 0, isRejecting: false };

  // Rally: prev candle's high exceeded the prior close
  const rallyPct = ((prev.high - twoPrev.close) / twoPrev.close) * 100;
  // Rejection: current price has fallen back from that high
  const rejectionPct = ((currentPrice - prev.high) / prev.high) * 100;
  const isRejecting = rallyPct > 0.1 && rejectionPct < -0.1;
  return { rallyPct, rejectionPct, isRejecting };
}

function crossedAbovePsychLevel(
  candles: HourlyCandle[],
  currentPrice: number,
  increment: number,
): boolean {
  if (candles.length < 2) return false;
  const prevClose = candles[candles.length - 2].close;
  const level = Math.ceil(prevClose / increment) * increment;
  return prevClose < level && currentPrice >= level;
}

function crossedBelowPsychLevel(
  candles: HourlyCandle[],
  currentPrice: number,
  increment: number,
): boolean {
  if (candles.length < 2) return false;
  const prevClose = candles[candles.length - 2].close;
  const level = Math.floor(prevClose / increment) * increment;
  return prevClose > level && currentPrice <= level;
}

function candleVolatility(candle: HourlyCandle): number {
  if (candle.open === 0) return 0;
  return ((candle.high - candle.low) / candle.open) * 100;
}

function volExpansionRatio(candles: HourlyCandle[]): number {
  if (candles.length < 8) return 1.0;
  const currVol = candleVolatility(candles[candles.length - 1]);
  const priorVols = candles.slice(-7, -1).map(candleVolatility);
  const avgVol = priorVols.reduce((s, v) => s + v, 0) / priorVols.length;
  if (avgVol === 0) return 1.0;
  return currVol / avgVol;
}

// ──── Position sizing: Bankroll percentage (2-5% adaptive) ────
// Experiment showed +178% improvement vs fixed $20
function getPositionSize(capital?: number): number {
  if (!capital) return POSITION_SIZE; // Fallback to fixed $20

  let percentage: number;
  if (capital < 500) {
    percentage = 0.05; // 5% when starting out
  } else if (capital < 2000) {
    percentage = 0.03; // 3% when building
  } else {
    percentage = 0.02; // 2% when established
  }

  const position = capital * percentage;

  // Safety caps: $10 minimum ensures trading, $50 maximum prevents over-betting
  return Math.max(10, Math.min(50, position));
}

// ──── Signal results ────

interface SignalResult {
  name: string;
  fired: boolean;
  detail: string;
  direction: 'yes' | 'no';
}

// ──── BULLISH signal checks (YES contracts) ────

function checkBullRollingMomentum(
  candles: HourlyCandle[], price: number, shortUp: boolean, medUp: boolean,
): SignalResult {
  const ret = rollingReturn(candles, price, 1);
  return {
    name: 'BULL ROLLING MOM',
    fired: ret > ROLLING_MIN_RETURN && shortUp && medUp,
    detail: `1h: ${ret >= 0 ? '+' : ''}${ret.toFixed(2)}% (need >${ROLLING_MIN_RETURN}%)`,
    direction: 'yes',
  };
}

function checkBullDipRecovery(candles: HourlyCandle[], price: number): SignalResult {
  const { dipPct, recoveryPct, isBouncing } = dipRecovery(candles, price);
  return {
    name: 'BULL DIP RECOVERY',
    fired: dipPct < -DIP_MIN_PCT && recoveryPct > DIP_MIN_RECOVERY && isBouncing,
    detail: `Dip: ${dipPct.toFixed(2)}%, Bounce: +${recoveryPct.toFixed(2)}%`,
    direction: 'yes',
  };
}

function checkBullMultiHour(
  candles: HourlyCandle[], price: number, shortUp: boolean,
): SignalResult {
  const ret1h = rollingReturn(candles, price, 1);
  const ret2h = rollingReturn(candles, price, 2);
  return {
    name: 'BULL MULTI-HOUR',
    fired: ret1h > MULTI_MIN_1H && ret2h > MULTI_MIN_2H && shortUp,
    detail: `1h: +${ret1h.toFixed(2)}%, 2h: +${ret2h.toFixed(2)}%`,
    direction: 'yes',
  };
}

function checkBullVolumeMomentum(
  candles: HourlyCandle[], price: number, shortUp: boolean,
): SignalResult {
  const vr = volumeRatio(candles);
  const ret = rollingReturn(candles, price, 1);
  return {
    name: 'BULL VOL+MOM',
    fired: vr >= VOLUME_MIN_RATIO && ret > VOLUME_MIN_RETURN && shortUp,
    detail: `Vol: ${vr.toFixed(1)}x, Ret: ${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%`,
    direction: 'yes',
  };
}

function checkBullPsychLevel(
  candles: HourlyCandle[], price: number, shortUp: boolean,
): SignalResult {
  const crossed = crossedAbovePsychLevel(candles, price, PSYCH_INCREMENT);
  const nearestAbove = Math.ceil(price / PSYCH_INCREMENT) * PSYCH_INCREMENT;
  return {
    name: 'BULL PSYCH BREAK',
    fired: crossed && shortUp,
    detail: crossed
      ? `Broke above $${(nearestAbove - PSYCH_INCREMENT).toLocaleString()}`
      : `Next up: $${nearestAbove.toLocaleString()}`,
    direction: 'yes',
  };
}

function checkBullSelloffRecovery(candles: HourlyCandle[], price: number): SignalResult {
  if (candles.length < 4)
    return { name: 'BULL SELLOFF REC', fired: false, detail: 'Not enough data', direction: 'yes' };
  const c3h = candles[candles.length - 4];
  const c1h = candles[candles.length - 2];
  if (c3h.close === 0)
    return { name: 'BULL SELLOFF REC', fired: false, detail: 'No data', direction: 'yes' };
  const selloff = ((c1h.close - c3h.close) / c3h.close) * 100;
  const bounce = rollingReturn(candles, price, 1);
  return {
    name: 'BULL SELLOFF REC',
    fired: selloff < -SELLOFF_MIN_MOVE && bounce > SELLOFF_MIN_REVERSAL,
    detail: `Drop: ${selloff.toFixed(2)}%, Bounce: +${bounce.toFixed(2)}%`,
    direction: 'yes',
  };
}

function checkBullVolExpansion(
  candles: HourlyCandle[], price: number, shortUp: boolean,
): SignalResult {
  const exp = volExpansionRatio(candles);
  const ret = rollingReturn(candles, price, 1);
  return {
    name: 'BULL VOL EXPAND',
    fired: exp >= VOL_EXPANSION_MIN && ret > VOL_EXPANSION_MIN_RET && shortUp,
    detail: `Exp: ${exp.toFixed(1)}x, Ret: ${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%`,
    direction: 'yes',
  };
}

function checkBullWeakTrend(
  candles: HourlyCandle[], price: number, sma6: number, sma12: number,
): SignalResult {
  // Fires when downtrend is weakening AND recent positive momentum
  // SMA6 < SMA12 (still in downtrend) but trend strength < 0.5% (exhausted)
  // Plus at least one positive hourly return (early reversal signal)

  if (sma6 >= sma12) {
    return {
      name: 'BULL WEAK TREND',
      fired: false,
      detail: 'Not in downtrend',
      direction: 'yes',
    };
  }

  const trendStrength = sma12 > 0 ? (sma12 - sma6) / sma12 : 0;
  if (trendStrength >= WEAK_TREND_THRESHOLD) {
    return {
      name: 'BULL WEAK TREND',
      fired: false,
      detail: `Downtrend too strong: ${(trendStrength * 100).toFixed(2)}%`,
      direction: 'yes',
    };
  }

  const ret1h = rollingReturn(candles, price, 1);
  const ret2h = rollingReturn(candles, price, 2);
  const hasPositiveMomentum = ret1h > 0 || ret2h > 0;

  return {
    name: 'BULL WEAK TREND',
    fired: hasPositiveMomentum,
    detail: `Weak down ${(trendStrength * 100).toFixed(2)}%, 1h: ${ret1h >= 0 ? '+' : ''}${ret1h.toFixed(2)}%`,
    direction: 'yes',
  };
}

// ──── BEARISH signal checks (NO contracts) ────

function checkBearRollingMomentum(
  candles: HourlyCandle[], price: number, shortDown: boolean, medDown: boolean,
): SignalResult {
  const ret = rollingReturn(candles, price, 1);
  return {
    name: 'BEAR ROLLING MOM',
    fired: ret < -ROLLING_MIN_RETURN && shortDown && medDown,
    detail: `1h: ${ret.toFixed(2)}% (need <-${ROLLING_MIN_RETURN}%)`,
    direction: 'no',
  };
}

function checkBearRallyRejection(candles: HourlyCandle[], price: number): SignalResult {
  const { rallyPct, rejectionPct, isRejecting } = rallyRejection(candles, price);
  return {
    name: 'BEAR RALLY REJECT',
    fired: rallyPct > DIP_MIN_PCT && rejectionPct < -DIP_MIN_RECOVERY && isRejecting,
    detail: `Rally: +${rallyPct.toFixed(2)}%, Reject: ${rejectionPct.toFixed(2)}%`,
    direction: 'no',
  };
}

function checkBearMultiHour(
  candles: HourlyCandle[], price: number, shortDown: boolean,
): SignalResult {
  const ret1h = rollingReturn(candles, price, 1);
  const ret2h = rollingReturn(candles, price, 2);
  return {
    name: 'BEAR MULTI-HOUR',
    fired: ret1h < -MULTI_MIN_1H && ret2h < -MULTI_MIN_2H && shortDown,
    detail: `1h: ${ret1h.toFixed(2)}%, 2h: ${ret2h.toFixed(2)}%`,
    direction: 'no',
  };
}

function checkBearVolumeMomentum(
  candles: HourlyCandle[], price: number, shortDown: boolean,
): SignalResult {
  const vr = volumeRatio(candles);
  const ret = rollingReturn(candles, price, 1);
  return {
    name: 'BEAR VOL+MOM',
    fired: vr >= VOLUME_MIN_RATIO && ret < -VOLUME_MIN_RETURN && shortDown,
    detail: `Vol: ${vr.toFixed(1)}x, Ret: ${ret.toFixed(2)}%`,
    direction: 'no',
  };
}

function checkBearPsychLevel(
  candles: HourlyCandle[], price: number, shortDown: boolean,
): SignalResult {
  const crossed = crossedBelowPsychLevel(candles, price, PSYCH_INCREMENT);
  const nearestBelow = Math.floor(price / PSYCH_INCREMENT) * PSYCH_INCREMENT;
  return {
    name: 'BEAR PSYCH BREAK',
    fired: crossed && shortDown,
    detail: crossed
      ? `Broke below $${(nearestBelow + PSYCH_INCREMENT).toLocaleString()}`
      : `Next down: $${nearestBelow.toLocaleString()}`,
    direction: 'no',
  };
}

function checkBearRallyThenCrash(candles: HourlyCandle[], price: number): SignalResult {
  if (candles.length < 4)
    return { name: 'BEAR RALLY CRASH', fired: false, detail: 'Not enough data', direction: 'no' };
  const c3h = candles[candles.length - 4];
  const c1h = candles[candles.length - 2];
  if (c3h.close === 0)
    return { name: 'BEAR RALLY CRASH', fired: false, detail: 'No data', direction: 'no' };
  // Rally 2-3h ago, now crashing
  const rally = ((c1h.close - c3h.close) / c3h.close) * 100;
  const crash = rollingReturn(candles, price, 1);
  return {
    name: 'BEAR RALLY CRASH',
    fired: rally > SELLOFF_MIN_MOVE && crash < -SELLOFF_MIN_REVERSAL,
    detail: `Rally: +${rally.toFixed(2)}%, Crash: ${crash.toFixed(2)}%`,
    direction: 'no',
  };
}

function checkBearVolExpansion(
  candles: HourlyCandle[], price: number, shortDown: boolean,
): SignalResult {
  const exp = volExpansionRatio(candles);
  const ret = rollingReturn(candles, price, 1);
  return {
    name: 'BEAR VOL EXPAND',
    fired: exp >= VOL_EXPANSION_MIN && ret < -VOL_EXPANSION_MIN_RET && shortDown,
    detail: `Exp: ${exp.toFixed(1)}x, Ret: ${ret.toFixed(2)}%`,
    direction: 'no',
  };
}

function checkBearWeakTrend(
  candles: HourlyCandle[], price: number, sma6: number, sma12: number,
): SignalResult {
  // Fires when uptrend is weakening AND recent negative momentum
  // SMA6 > SMA12 (still in uptrend) but trend strength < 0.5% (exhausted)
  // Plus at least one negative hourly return (early reversal signal)

  if (sma6 <= sma12) {
    return {
      name: 'BEAR WEAK TREND',
      fired: false,
      detail: 'Not in uptrend',
      direction: 'no',
    };
  }

  const trendStrength = sma12 > 0 ? (sma6 - sma12) / sma12 : 0;
  if (trendStrength >= WEAK_TREND_THRESHOLD) {
    return {
      name: 'BEAR WEAK TREND',
      fired: false,
      detail: `Uptrend too strong: ${(trendStrength * 100).toFixed(2)}%`,
      direction: 'no',
    };
  }

  const ret1h = rollingReturn(candles, price, 1);
  const ret2h = rollingReturn(candles, price, 2);
  const hasNegativeMomentum = ret1h < 0 || ret2h < 0;

  return {
    name: 'BEAR WEAK TREND',
    fired: hasNegativeMomentum,
    detail: `Weak up ${(trendStrength * 100).toFixed(2)}%, 1h: ${ret1h.toFixed(2)}%`,
    direction: 'no',
  };
}

// ──── Main ────

export function checkAggressiveSignal(data: BTCData, capital?: number): Signal {
  const now = new Date();
  const minutesRemaining = 60 - now.getMinutes();
  const candles = data.hourlyData;

  const enoughTime = minutesRemaining > MIN_TIME_REMAINING;

  // SMA trends (0.3% looseness)
  const { sma3, sma6, sma12 } = data.indicators;
  const shortTrendUp =
    sma3 > sma6 || (sma6 > 0 && (sma6 - sma3) / sma6 < SMA_LOOSENESS);
  const mediumTrendUp =
    sma6 > sma12 || (sma12 > 0 && (sma12 - sma6) / sma12 < SMA_LOOSENESS);
  const shortTrendDown =
    sma3 < sma6 || (sma6 > 0 && (sma3 - sma6) / sma6 < SMA_LOOSENESS);
  const mediumTrendDown =
    sma6 < sma12 || (sma12 > 0 && (sma6 - sma12) / sma12 < SMA_LOOSENESS);

  // Run all 16 signal checks (8 bullish + 8 bearish) — first to fire wins
  const signals: SignalResult[] = [
    // Bullish (YES on next-up strike)
    checkBullRollingMomentum(candles, data.price, shortTrendUp, mediumTrendUp),
    checkBullDipRecovery(candles, data.price),
    checkBullMultiHour(candles, data.price, shortTrendUp),
    checkBullVolumeMomentum(candles, data.price, shortTrendUp),
    checkBullPsychLevel(candles, data.price, shortTrendUp),
    checkBullSelloffRecovery(candles, data.price),
    checkBullVolExpansion(candles, data.price, shortTrendUp),
    checkBullWeakTrend(candles, data.price, sma6, sma12),
    // Bearish (NO on floor strike)
    checkBearRollingMomentum(candles, data.price, shortTrendDown, mediumTrendDown),
    checkBearRallyRejection(candles, data.price),
    checkBearMultiHour(candles, data.price, shortTrendDown),
    checkBearVolumeMomentum(candles, data.price, shortTrendDown),
    checkBearPsychLevel(candles, data.price, shortTrendDown),
    checkBearRallyThenCrash(candles, data.price),
    checkBearVolExpansion(candles, data.price, shortTrendDown),
    checkBearWeakTrend(candles, data.price, sma6, sma12),
  ];

  const activeSignal = signals.find((s) => s.fired);
  const signalName = activeSignal?.name ?? 'NONE';
  const direction = activeSignal?.direction ?? 'yes';

  // Strike depends on direction:
  //   Bullish YES → floor strike (ITM)
  //   Bearish NO  → next-up strike (ITM)
  const floorStrike = calculateStrike(data.price, 'OTM');
  const strike = direction === 'yes' ? floorStrike : floorStrike + STRIKE_INCREMENT;

  // Fair value: YES FV from model, NO FV = 1 - YES FV
  const yesFairValue = estimateContractFairValue(
    data.price,
    strike,
    data.indicators.volatility,
    minutesRemaining,
  );
  const fairValue = direction === 'yes' ? yesFairValue : 1 - yesFairValue;

  const probabilityOk = fairValue >= PROB_LO && fairValue <= PROB_HI;
  const entryPrice = Math.min(MAX_ENTRY_PRICE, Math.floor(fairValue * 100) / 100);
  const affordableEntry = entryPrice > 0.01 && fairValue <= MAX_ENTRY_PRICE;

  // Adaptive position sizing: use bankroll % if capital provided, else fixed $20
  const positionSize = getPositionSize(capital);
  const contracts = entryPrice > 0 ? Math.floor(positionSize / entryPrice) : 0;

  const dirLabel = direction === 'yes' ? 'YES' : 'NO';
  const strikeLabel = direction === 'yes'
    ? `$${strike.toLocaleString()} (next-up)`
    : `$${strike.toLocaleString()} (floor)`;

  const criteriaChecks: CriteriaCheck[] = [
    {
      label: `TIME >${MIN_TIME_REMAINING}m`,
      passed: enoughTime,
      value: `${minutesRemaining}m left`,
    },
    {
      label: `${dirLabel} ${strikeLabel}`,
      passed: probabilityOk && affordableEntry,
      value: `${(fairValue * 100).toFixed(0)}% prob, ${(entryPrice * 100).toFixed(0)}¢ entry`,
    },
    {
      label: `PROB ${PROB_LO * 100}-${PROB_HI * 100}%`,
      passed: probabilityOk,
      value: `${(fairValue * 100).toFixed(0)}% fair value`,
    },
    ...signals.map((s) => ({
      label: s.name,
      passed: s.fired,
      value: s.detail,
    })),
  ];

  const allPassed = enoughTime && probabilityOk && affordableEntry && activeSignal !== undefined;

  if (allPassed) {
    return {
      active: true,
      strategy: 'aggressive',
      direction,
      strike,
      entryPrice,
      estimatedProbability: fairValue,
      maxEntryPrice: MAX_ENTRY_PRICE,
      positionSize,
      contracts,
      exitStrategy: `Buy ${dirLabel} ${strikeLabel} on ${signalName}. Entry ≤${(MAX_ENTRY_PRICE * 100).toFixed(0)}¢ (model: ${(fairValue * 100).toFixed(0)}¢)`,
      criteriaChecks,
    };
  }

  return {
    active: false,
    strategy: 'aggressive',
    strike,
    entryPrice,
    estimatedProbability: fairValue,
    maxEntryPrice: MAX_ENTRY_PRICE,
    positionSize,
    contracts,
    exitStrategy: `Buy ${dirLabel} ${strikeLabel} on signal. Entry ≤${(MAX_ENTRY_PRICE * 100).toFixed(0)}¢`,
    criteriaChecks,
    failedCriteria: criteriaChecks.filter((c) => !c.passed).map((c) => c.label),
  };
}
