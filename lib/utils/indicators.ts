import { HourlyCandle, FiveMinCandle, Indicators, FiveMinIndicators } from '@/lib/types';

function calculateSMA(candles: HourlyCandle[], period: number): number {
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  const sum = slice.reduce((acc, c) => acc + c.close, 0);
  return sum / period;
}

function calculateVolatility(candles: HourlyCandle[]): number {
  if (candles.length === 0) return 0;

  // Use multi-candle average of completed candles' high-low ranges.
  // The last candle is the current (incomplete) hour — skip it.
  // This prevents underpricing early in the hour when the current candle
  // has barely any range (0.08% vs real 0.3-0.5%).
  const completed = candles.length >= 2 ? candles.slice(0, -1) : candles;
  const lookback = completed.slice(-6); // last 6 completed candles

  let totalRange = 0;
  let count = 0;
  for (const c of lookback) {
    if (c.open > 0 && c.high > c.low) {
      totalRange += ((c.high - c.low) / c.open) * 100;
      count++;
    }
  }

  if (count === 0) {
    // Fallback: use current candle if no completed candles available
    const latest = candles[candles.length - 1];
    if (latest.open === 0) return 0;
    return ((latest.high - latest.low) / latest.open) * 100;
  }

  return totalRange / count;
}

function calculatePricePosition(candles: HourlyCandle[]): number {
  if (candles.length === 0) return 50;
  const latest = candles[candles.length - 1];
  const range = latest.high - latest.low;
  if (range === 0) return 50;
  return ((latest.close - latest.low) / range) * 100;
}

function calculateMomentum3h(candles: HourlyCandle[], currentPrice: number): number {
  if (candles.length < 3) return 0;
  const threeHoursAgo = candles[candles.length - 3];
  if (threeHoursAgo.close === 0) return 0;
  return ((currentPrice - threeHoursAgo.close) / threeHoursAgo.close) * 100;
}

export function calculateIndicators(candles: HourlyCandle[], currentPrice: number): Indicators {
  return {
    sma3: calculateSMA(candles, 3),
    sma6: calculateSMA(candles, 6),
    sma12: calculateSMA(candles, 12),
    volatility: calculateVolatility(candles),
    pricePosition: calculatePricePosition(candles),
    momentum3h: calculateMomentum3h(candles, currentPrice),
  };
}

// ──── 5-Minute Indicator Functions ────

export function calculateRSI(candles: FiveMinCandle[], period: number = 7): number {
  if (candles.length < period + 1) return 50; // neutral default

  const changes: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    changes.push(candles[i].close - candles[i - 1].close);
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (const change of changes) {
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export function calculateBollingerBands(
  candles: FiveMinCandle[],
  period: number = 9,
  stdDevMult: number = 2,
): { upper: number; middle: number; lower: number; width: number } {
  if (candles.length < period) {
    const price = candles.length > 0 ? candles[candles.length - 1].close : 0;
    return { upper: price, middle: price, lower: price, width: 0 };
  }

  const slice = candles.slice(-period);
  const closes = slice.map(c => c.close);
  const middle = closes.reduce((sum, c) => sum + c, 0) / period;

  const variance = closes.reduce((sum, c) => sum + (c - middle) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = middle + stdDevMult * stdDev;
  const lower = middle - stdDevMult * stdDev;
  const width = middle > 0 ? (upper - lower) / middle : 0;

  return { upper, middle, lower, width };
}

export function calculateEMA(candles: FiveMinCandle[], period: number): number {
  if (candles.length === 0) return 0;
  if (candles.length < period) {
    // Not enough data for full EMA, use SMA of available candles
    return candles.reduce((sum, c) => sum + c.close, 0) / candles.length;
  }

  const multiplier = 2 / (period + 1);

  // Seed with SMA of first `period` candles
  let ema = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;

  // Apply EMA formula for remaining candles
  for (let i = period; i < candles.length; i++) {
    ema = (candles[i].close - ema) * multiplier + ema;
  }

  return ema;
}

export function calculateATR(candles: FiveMinCandle[], period: number = 5): number {
  if (candles.length < 2) return 0;

  const trueRanges: number[] = [];
  const start = Math.max(1, candles.length - period);
  for (let i = start; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  if (trueRanges.length === 0) return 0;
  return trueRanges.reduce((sum, tr) => sum + tr, 0) / trueRanges.length;
}

export function calculate5MinIndicators(
  candles: FiveMinCandle[],
  currentPrice: number,
): FiveMinIndicators {
  // Skip the last candle (current in-progress) — its volume is near-zero
  // and its open ≈ currentPrice, which makes momentum ≈ 0.
  // Same pattern as calculateVolatility (line 17).
  const completed = candles.length >= 2 ? candles.slice(0, -1) : candles;

  const rsi7 = calculateRSI(completed, 7);
  const bb = calculateBollingerBands(completed, 9, 2);
  const ema5 = calculateEMA(completed, 5);
  const ema10 = calculateEMA(completed, 10);
  const atr5 = calculateATR(completed, 5);

  // 1-candle momentum (5-min return)
  let momentum1 = 0;
  if (completed.length >= 1) {
    const lastCandle = completed[completed.length - 1];
    if (lastCandle.open > 0) {
      momentum1 = ((currentPrice - lastCandle.open) / lastCandle.open) * 100;
    }
  }

  // 3-candle momentum (15-min return)
  let momentum3 = 0;
  if (completed.length >= 3) {
    const threeAgo = completed[completed.length - 3];
    if (threeAgo.open > 0) {
      momentum3 = ((currentPrice - threeAgo.open) / threeAgo.open) * 100;
    }
  }

  // Volume ratio: last completed candle vs average of prior completed candles
  let volumeRatio = 1.0;
  if (completed.length >= 4) {
    const lastVol = completed[completed.length - 1].volume;
    const priorCandles = completed.slice(-7, -1);
    const avgVol = priorCandles.reduce((sum, c) => sum + c.volume, 0) / priorCandles.length;
    if (avgVol > 0) {
      volumeRatio = lastVol / avgVol;
    }
  }

  return {
    rsi7,
    bbUpper: bb.upper,
    bbMiddle: bb.middle,
    bbLower: bb.lower,
    bbWidth: bb.width,
    ema5,
    ema10,
    momentum1,
    momentum3,
    volumeRatio,
    atr5,
  };
}
