import { FeeStructure } from '@/lib/types';

export const ROBINHOOD_FEES: FeeStructure = {
  takerFeePct: 1.5,
  makerFeePct: 0.5,
  settlementFeePct: 0,
};

/**
 * Kalshi fee structure (parabolic formula)
 * Formula: fee = 0.07 × C × P × (1 - P)
 * Caps: $0.02 per contract, $1.75 per 100 contracts
 * Settlement: 0%
 */
export const KALSHI_FEES: FeeStructure = {
  takerFeePct: 0, // Kalshi uses parabolic formula, not percentage
  makerFeePct: 0,
  settlementFeePct: 0,
};

/**
 * Calculate Kalshi trading fee (parabolic formula)
 * @param contracts Number of contracts
 * @param priceInCents Contract price in cents (1-99)
 * @returns Fee in dollars
 */
export function calculateKalshiFee(contracts: number, priceInCents: number): number {
  const price = priceInCents / 100; // convert to 0-1 range
  const feePerContract = 0.07 * price * (1 - price);

  // Cap at $0.02 per contract
  const cappedPerContract = Math.min(feePerContract, 0.02);

  const totalFee = contracts * cappedPerContract;

  // Cap at $1.75 per 100 contracts
  const maxFee = (contracts / 100) * 1.75;

  return Math.min(totalFee, maxFee);
}

export function calculateNetPnL(
  contracts: number,
  entryPrice: number,
  exitPrice: number,
  exitType: 'early' | 'settlement',
  fees: FeeStructure = KALSHI_FEES
): number {
  const entryCost = contracts * entryPrice;
  const entryFee = entryCost * (fees.takerFeePct / 100);
  const totalEntryCost = entryCost + entryFee;

  const exitRevenue = contracts * exitPrice;

  if (exitType === 'early') {
    const exitFee = exitRevenue * (fees.takerFeePct / 100);
    const netExitRevenue = exitRevenue - exitFee;
    return netExitRevenue - totalEntryCost;
  } else {
    return exitRevenue - totalEntryCost;
  }
}

export function calculateFeeBreakdown(
  contracts: number,
  entryPrice: number,
  exitPrice: number,
  exitType: 'early' | 'settlement',
  fees: FeeStructure = KALSHI_FEES
) {
  const grossCost = contracts * entryPrice;
  const entryFee = grossCost * (fees.takerFeePct / 100);
  const totalCost = grossCost + entryFee;

  const grossRevenue = contracts * exitPrice;
  const exitFee = exitType === 'early' ? grossRevenue * (fees.takerFeePct / 100) : 0;
  const netRevenue = grossRevenue - exitFee;
  const netPnL = netRevenue - totalCost;

  return {
    grossCost,
    entryFee,
    totalCost,
    grossRevenue,
    exitFee,
    netRevenue,
    netPnL,
    totalFees: entryFee + exitFee,
  };
}

/**
 * Calculate Kalshi fee breakdown (uses parabolic formula)
 * @param contracts Number of contracts
 * @param entryPrice Entry price in dollars (e.g., 0.65 for 65¢)
 * @param exitPrice Exit price in dollars
 * @param exitType 'early' or 'settlement'
 * @returns Fee breakdown with netPnL
 */
export function calculateKalshiFeeBreakdown(
  contracts: number,
  entryPrice: number,
  exitPrice: number,
  exitType: 'early' | 'settlement'
) {
  const grossCost = contracts * entryPrice;
  const entryFee = calculateKalshiFee(contracts, entryPrice * 100);
  const totalCost = grossCost + entryFee;

  const grossRevenue = contracts * exitPrice;
  // Kalshi has no settlement fee
  const exitFee = exitType === 'early' ? calculateKalshiFee(contracts, exitPrice * 100) : 0;
  const netRevenue = grossRevenue - exitFee;
  const netPnL = netRevenue - totalCost;

  return {
    grossCost,
    entryFee,
    totalCost,
    grossRevenue,
    exitFee,
    netRevenue,
    netPnL,
    totalFees: entryFee + exitFee,
  };
}
