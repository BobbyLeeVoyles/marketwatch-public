const STRIKE_INCREMENT = 250;

/**
 * Standard normal CDF using Abramowitz & Stegun approximation.
 * Returns P(Z ≤ x) for a standard normal random variable.
 */
export function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const y =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp((-absX * absX) / 2);

  return 0.5 * (1 + sign * y);
}

/**
 * Estimate the fair value of a "Yes" contract (BTC ≥ strike at settlement).
 *
 * This is our model's probability that BTC finishes at or above the strike,
 * which equals the fair value of a $1 binary contract.
 *
 * Uses a GBM-based probability model:
 *   P(BTC ≥ strike) = Φ(z)
 *   z = (btcPrice - strike) / expectedMove
 *   expectedMove = btcPrice × (hourlyVol/100) × √(minutesRemaining/60)
 *
 * Settlement on Robinhood: average of 60 RTI snapshots in the last minute.
 * This averaging reduces tail risk slightly, so we apply a small adjustment
 * in the final minute.
 */
export function estimateContractFairValue(
  btcPrice: number,
  strike: number,
  volatilityPct: number,
  minutesRemaining: number
): number {
  if (btcPrice <= 0 || volatilityPct <= 0) return 0.5;

  const timeFactorHours = Math.max(minutesRemaining, 0.5) / 60;
  const expectedMove = btcPrice * (volatilityPct / 100) * Math.sqrt(timeFactorHours);

  if (expectedMove <= 0) return btcPrice >= strike ? 0.99 : 0.01;

  const zScore = (btcPrice - strike) / expectedMove;
  let probability = normalCDF(zScore);

  // Settlement averaging adjustment: in the last minute, the settlement price
  // is the average of 60 RTI snapshots. This smooths out noise, making the
  // outcome more predictable. Slightly shrink uncertainty in the final minutes.
  if (minutesRemaining <= 2) {
    // The averaging reduces effective volatility by ~√(1/60) ≈ 13% of remaining vol
    // Push probability slightly toward 0 or 1 (more certain)
    const certaintyBoost = 0.15 * (1 - minutesRemaining / 2);
    if (probability > 0.5) {
      probability = probability + (1 - probability) * certaintyBoost;
    } else {
      probability = probability * (1 - certaintyBoost);
    }
  }

  // Clamp to [0.01, 0.99] — contracts always have some value
  return Math.max(0.01, Math.min(0.99, probability));
}

export function calculateStrike(btcPrice: number, type: 'ATM' | 'OTM'): number {
  if (type === 'ATM') {
    return Math.round(btcPrice / STRIKE_INCREMENT) * STRIKE_INCREMENT;
  } else {
    return Math.floor(btcPrice / STRIKE_INCREMENT) * STRIKE_INCREMENT;
  }
}

export const MIN_STRIKE_DISTANCE = 50;

export function getStrikeDistance(btcPrice: number): number {
  const otmStrike = calculateStrike(btcPrice, 'OTM');
  return btcPrice - otmStrike;
}

export function getNearbyStrikes(btcPrice: number, count: number = 4): number[] {
  const atm = calculateStrike(btcPrice, 'ATM');
  const strikes: number[] = [];

  const half = Math.floor(count / 2);
  for (let i = -half; i < count - half; i++) {
    strikes.push(atm + i * STRIKE_INCREMENT);
  }

  return strikes;
}

/**
 * Get nearby strikes with their estimated fair values.
 * Useful for showing the user which contracts have edge.
 */
export function getStrikesWithFairValues(
  btcPrice: number,
  volatilityPct: number,
  minutesRemaining: number,
  count: number = 6
): Array<{ strike: number; fairValue: number; distance: number }> {
  const strikes = getNearbyStrikes(btcPrice, count);
  return strikes.map((strike) => ({
    strike,
    fairValue: estimateContractFairValue(btcPrice, strike, volatilityPct, minutesRemaining),
    distance: btcPrice - strike,
  }));
}
