/**
 * 15-Minute Strategy V2
 *
 * Multi-signal architecture for KXBTC15M markets with regime detection.
 *
 * 3 Momentum signals (high-volatility regime):
 *   1. 5-Min Breakout: 1-candle return > 0.15% with EMA alignment
 *   2. 15-Min Trend: 3-candle return > 0.25% with volume confirmation
 *   3. EMA Crossover: EMA(5) crosses EMA(10) with volume
 *
 * 3 Mean Reversion signals (low-volatility regime):
 *   4. RSI Extreme: RSI(7) < 30 or > 70
 *   5. Bollinger Band Touch: Price at outer band with reversal candle
 *   6. Overextension Bounce: 15-min drop/pump > 0.20% with recovery
 *
 * Regime detection: bbWidth >= 0.003 = momentum, else mean reversion
 * Entry timing gate: minutes 3-10 of 15-min window only
 * Adaptive position sizing: bankroll % (1.5-3%) with $5 floor, $30 cap
 */

import { BTCData, Signal, CriteriaCheck, FiveMinIndicators } from '@/lib/types';

// ──── Thresholds ────

// Momentum signals
const BREAKOUT_MIN_RETURN = 0.15; // 1-candle return %
const TREND_MIN_RETURN = 0.25; // 3-candle return %
const TREND_MIN_VOLUME = 1.8; // volume ratio vs average
const EMA_CROSS_MIN_VOLUME = 1.3; // volume confirmation for EMA cross

// Mean reversion signals
const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const BB_TOUCH_MARGIN = 0.0005; // 0.05% from band = "touching"
const OVEREXT_MIN_MOVE = 0.20; // 15-min overextension %
const OVEREXT_MIN_RECOVERY = 0.05; // min recovery to confirm bounce

// Regime detection
const MOMENTUM_REGIME_THRESHOLD = 0.003; // bbWidth >= 0.3% = momentum regime

// Inter-window momentum
const INTER_WINDOW_MOM_THRESHOLD = 0.5; // % prev window return to trigger (from backtest_interwindow.py)

// Entry timing (minutes within 15-min window)
const ENTRY_WINDOW_START = 3;
const ENTRY_WINDOW_END = 10;

// ──── Signal result type ────

interface SignalResult {
  name: string;
  fired: boolean;
  detail: string;
  direction: 'yes' | 'no';
  regime: 'momentum' | 'meanReversion';
}

// ──── Position sizing ────
//
// Returns a suggested position size based on bankroll only.
// The bot loop overrides this with dynamic Kelly once the actual entry
// price (ask) is known — see fifteenMinBot.ts calcKellyPositionSize().
// This fallback is used when no entry price is available yet.

function getPositionSize(capital?: number): number {
  if (!capital || capital <= 0) return 1;
  // Conservative fallback: 10% of bankroll, no dollar floor, $30 hard cap
  return Math.min(capital * 0.10, 30);
}

// ──── Entry timing ────

function getMinuteInWindow(): number {
  const now = new Date();
  return now.getMinutes() % 15;
}

function isInEntryWindow(): boolean {
  const minute = getMinuteInWindow();
  return minute >= ENTRY_WINDOW_START && minute <= ENTRY_WINDOW_END;
}

// ──── Regime detection ────

function detectRegime(indicators: FiveMinIndicators): 'momentum' | 'meanReversion' {
  return indicators.bbWidth >= MOMENTUM_REGIME_THRESHOLD ? 'momentum' : 'meanReversion';
}

// ──── MOMENTUM SIGNALS (high-volatility regime) ────

function check5MinBreakout(ind: FiveMinIndicators): SignalResult {
  const bullish = ind.momentum1 > BREAKOUT_MIN_RETURN && ind.ema5 > ind.ema10;
  const bearish = ind.momentum1 < -BREAKOUT_MIN_RETURN && ind.ema5 < ind.ema10;

  if (bullish) {
    return {
      name: '5MIN BREAKOUT',
      fired: true,
      detail: `+${ind.momentum1.toFixed(3)}%, EMA5>EMA10`,
      direction: 'yes',
      regime: 'momentum',
    };
  }
  if (bearish) {
    return {
      name: '5MIN BREAKOUT',
      fired: true,
      detail: `${ind.momentum1.toFixed(3)}%, EMA5<EMA10`,
      direction: 'no',
      regime: 'momentum',
    };
  }

  return {
    name: '5MIN BREAKOUT',
    fired: false,
    detail: `Mom: ${ind.momentum1 >= 0 ? '+' : ''}${ind.momentum1.toFixed(3)}% (need ${BREAKOUT_MIN_RETURN}%)`,
    direction: 'yes',
    regime: 'momentum',
  };
}

function check15MinTrend(ind: FiveMinIndicators): SignalResult {
  const hasVolume = ind.volumeRatio >= TREND_MIN_VOLUME;
  const bullish = ind.momentum3 > TREND_MIN_RETURN && hasVolume;
  const bearish = ind.momentum3 < -TREND_MIN_RETURN && hasVolume;

  if (bullish) {
    return {
      name: '15MIN TREND',
      fired: true,
      detail: `+${ind.momentum3.toFixed(3)}%, Vol: ${ind.volumeRatio.toFixed(1)}x`,
      direction: 'yes',
      regime: 'momentum',
    };
  }
  if (bearish) {
    return {
      name: '15MIN TREND',
      fired: true,
      detail: `${ind.momentum3.toFixed(3)}%, Vol: ${ind.volumeRatio.toFixed(1)}x`,
      direction: 'no',
      regime: 'momentum',
    };
  }

  return {
    name: '15MIN TREND',
    fired: false,
    detail: `Mom3: ${ind.momentum3 >= 0 ? '+' : ''}${ind.momentum3.toFixed(3)}%, Vol: ${ind.volumeRatio.toFixed(1)}x`,
    direction: 'yes',
    regime: 'momentum',
  };
}

function checkEMACrossover(ind: FiveMinIndicators): SignalResult {
  const hasVolume = ind.volumeRatio >= EMA_CROSS_MIN_VOLUME;
  // EMA5 crossing above EMA10 = bullish, below = bearish
  // We detect cross by checking alignment + momentum confirmation
  const emaDiff = ind.ema5 - ind.ema10;
  const emaDiffPct = ind.ema10 > 0 ? (emaDiff / ind.ema10) * 100 : 0;

  // Cross is recent if EMA diff is small (< 0.05%) but directional with momentum
  const isFreshCross = Math.abs(emaDiffPct) < 0.10 && Math.abs(emaDiffPct) > 0.001;
  const bullish = emaDiff > 0 && isFreshCross && ind.momentum1 > 0 && hasVolume;
  const bearish = emaDiff < 0 && isFreshCross && ind.momentum1 < 0 && hasVolume;

  if (bullish) {
    return {
      name: 'EMA CROSSOVER',
      fired: true,
      detail: `EMA5>EMA10 by ${emaDiffPct.toFixed(3)}%, Vol: ${ind.volumeRatio.toFixed(1)}x`,
      direction: 'yes',
      regime: 'momentum',
    };
  }
  if (bearish) {
    return {
      name: 'EMA CROSSOVER',
      fired: true,
      detail: `EMA5<EMA10 by ${emaDiffPct.toFixed(3)}%, Vol: ${ind.volumeRatio.toFixed(1)}x`,
      direction: 'no',
      regime: 'momentum',
    };
  }

  return {
    name: 'EMA CROSSOVER',
    fired: false,
    detail: `EMA diff: ${emaDiffPct >= 0 ? '+' : ''}${emaDiffPct.toFixed(3)}%`,
    direction: 'yes',
    regime: 'momentum',
  };
}

// ──── MEAN REVERSION SIGNALS (low-volatility regime) ────

function checkRSIExtreme(ind: FiveMinIndicators): SignalResult {
  if (ind.rsi7 < RSI_OVERSOLD) {
    return {
      name: 'RSI EXTREME',
      fired: true,
      detail: `RSI(7): ${ind.rsi7.toFixed(1)} (oversold <${RSI_OVERSOLD})`,
      direction: 'yes', // Buy YES = expect price to recover
      regime: 'meanReversion',
    };
  }
  if (ind.rsi7 > RSI_OVERBOUGHT) {
    return {
      name: 'RSI EXTREME',
      fired: true,
      detail: `RSI(7): ${ind.rsi7.toFixed(1)} (overbought >${RSI_OVERBOUGHT})`,
      direction: 'no', // Buy NO = expect price to pull back
      regime: 'meanReversion',
    };
  }

  return {
    name: 'RSI EXTREME',
    fired: false,
    detail: `RSI(7): ${ind.rsi7.toFixed(1)} (need <${RSI_OVERSOLD} or >${RSI_OVERBOUGHT})`,
    direction: 'yes',
    regime: 'meanReversion',
  };
}

function checkBBTouch(ind: FiveMinIndicators, currentPrice: number): SignalResult {
  const margin = currentPrice * BB_TOUCH_MARGIN;

  // Price at/beyond lower band with recovery candle (momentum1 > 0)
  if (currentPrice <= ind.bbLower + margin && ind.momentum1 > 0) {
    return {
      name: 'BB TOUCH',
      fired: true,
      detail: `Price at lower BB ($${ind.bbLower.toFixed(0)}), bouncing +${ind.momentum1.toFixed(3)}%`,
      direction: 'yes',
      regime: 'meanReversion',
    };
  }

  // Price at/beyond upper band with rejection candle (momentum1 < 0)
  if (currentPrice >= ind.bbUpper - margin && ind.momentum1 < 0) {
    return {
      name: 'BB TOUCH',
      fired: true,
      detail: `Price at upper BB ($${ind.bbUpper.toFixed(0)}), rejecting ${ind.momentum1.toFixed(3)}%`,
      direction: 'no',
      regime: 'meanReversion',
    };
  }

  return {
    name: 'BB TOUCH',
    fired: false,
    detail: `Price $${currentPrice.toFixed(0)} | BB: $${ind.bbLower.toFixed(0)}-$${ind.bbUpper.toFixed(0)}`,
    direction: 'yes',
    regime: 'meanReversion',
  };
}

function checkOverextensionBounce(ind: FiveMinIndicators): SignalResult {
  // 15-min drop > threshold with recovery starting
  if (ind.momentum3 < -OVEREXT_MIN_MOVE && ind.momentum1 > OVEREXT_MIN_RECOVERY) {
    return {
      name: 'OVEREXT BOUNCE',
      fired: true,
      detail: `15m drop: ${ind.momentum3.toFixed(3)}%, 5m recovery: +${ind.momentum1.toFixed(3)}%`,
      direction: 'yes',
      regime: 'meanReversion',
    };
  }

  // 15-min pump > threshold with pullback starting
  if (ind.momentum3 > OVEREXT_MIN_MOVE && ind.momentum1 < -OVEREXT_MIN_RECOVERY) {
    return {
      name: 'OVEREXT BOUNCE',
      fired: true,
      detail: `15m pump: +${ind.momentum3.toFixed(3)}%, 5m pullback: ${ind.momentum1.toFixed(3)}%`,
      direction: 'no',
      regime: 'meanReversion',
    };
  }

  return {
    name: 'OVEREXT BOUNCE',
    fired: false,
    detail: `15m: ${ind.momentum3 >= 0 ? '+' : ''}${ind.momentum3.toFixed(3)}%, 5m: ${ind.momentum1 >= 0 ? '+' : ''}${ind.momentum1.toFixed(3)}%`,
    direction: 'yes',
    regime: 'meanReversion',
  };
}

// ──── INTER-WINDOW MOMENTUM SIGNAL ────

// Backtest (backtest_interwindow.py) shows MEAN REVERSION is the edge:
// after a strong previous-window move, the current window fades it (52.5% WR at 0.5% threshold).
// Direction is OPPOSITE to the prev window return.
function checkInterWindowMomentum(prevWindowReturn: number): SignalResult {
  const prevBullish = prevWindowReturn > INTER_WINDOW_MOM_THRESHOLD;
  const prevBearish = prevWindowReturn < -INTER_WINDOW_MOM_THRESHOLD;

  if (prevBullish) {
    // Previous window was strongly up → fade it → buy NO
    return {
      name: 'INTER-WINDOW MOM',
      fired: true,
      detail: `prev: +${prevWindowReturn.toFixed(3)}% (mean-reversion fade)`,
      direction: 'no',
      regime: 'meanReversion',
    };
  }
  if (prevBearish) {
    // Previous window was strongly down → fade it → buy YES
    return {
      name: 'INTER-WINDOW MOM',
      fired: true,
      detail: `prev: ${prevWindowReturn.toFixed(3)}% (mean-reversion bounce)`,
      direction: 'yes',
      regime: 'meanReversion',
    };
  }
  return {
    name: 'INTER-WINDOW MOM',
    fired: false,
    detail: `prev: ${prevWindowReturn >= 0 ? '+' : ''}${prevWindowReturn.toFixed(3)}% (need ±${INTER_WINDOW_MOM_THRESHOLD}%)`,
    direction: 'yes',
    regime: 'meanReversion',
  };
}

// ──── Main signal check ────

export function check15MinSignalV2(
  btcData: BTCData,
  capital?: number,
): Signal {
  const ind = btcData.fiveMinIndicators;

  // Need 5-min indicators to function
  if (!ind) {
    return {
      active: false,
      strategy: 'fifteenMin',
      failedCriteria: ['No 5-min indicator data'],
      criteriaChecks: [],
    };
  }

  const regime = detectRegime(ind);
  const minuteInWindow = getMinuteInWindow();
  const inEntryWindow = isInEntryWindow();

  // Run all 7 signal checks (7th only if prev window return is available)
  const signals: SignalResult[] = [
    // Momentum signals
    check5MinBreakout(ind),
    check15MinTrend(ind),
    checkEMACrossover(ind),
    // Mean reversion signals
    checkRSIExtreme(ind),
    checkBBTouch(ind, btcData.price),
    checkOverextensionBounce(ind),
    // Inter-window momentum (only evaluated when prev window return is known)
    ...(btcData.prevWindowReturn !== undefined
      ? [checkInterWindowMomentum(btcData.prevWindowReturn)]
      : []),
  ];

  // Find the first fired signal (no regime filtering — signals already have
  // appropriate conditions; regime gating was blocking valid entries)
  const firedSignal = signals.find(s => s.fired);

  // Position sizing
  const positionSize = getPositionSize(capital);

  // Build criteria checks for logging
  const criteriaChecks: CriteriaCheck[] = [
    {
      label: 'REGIME',
      passed: true,
      value: `${regime} (bbWidth: ${(ind.bbWidth * 100).toFixed(2)}%, threshold: ${(MOMENTUM_REGIME_THRESHOLD * 100).toFixed(1)}%)`,
    },
    {
      label: `TIMING min ${ENTRY_WINDOW_START}-${ENTRY_WINDOW_END}`,
      passed: inEntryWindow,
      value: `Minute ${minuteInWindow} of 15-min window`,
    },
    ...signals.map(s => ({
      label: s.name,
      passed: s.fired,
      value: s.detail,
    })),
  ];

  const direction = firedSignal?.direction ?? 'yes';
  const signalName = firedSignal?.name ?? 'NONE';

  // All conditions: timing + at least one fired signal
  const allPassed = inEntryWindow && firedSignal !== undefined;

  if (allPassed) {
    return {
      active: true,
      strategy: 'fifteenMin',
      direction,
      positionSize,
      contracts: 0, // calculated by bot from entry price
      exitStrategy: `${signalName} in ${regime} regime | Minute ${minuteInWindow}`,
      criteriaChecks,
    };
  }

  return {
    active: false,
    strategy: 'fifteenMin',
    direction,
    positionSize,
    contracts: 0,
    criteriaChecks,
    failedCriteria: criteriaChecks.filter(c => !c.passed).map(c => c.label),
  };
}
