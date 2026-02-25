import { ActiveTrade, ExitAnalysis, FeeStructure, RiskOfRuinAnalysis } from '@/lib/types';
import { calculateNetPnL, KALSHI_FEES } from './fees';
import { normalCDF, estimateContractFairValue } from './strikes';

// ─── Hedge-to-Lock Analysis ───────────────────────────────────────────────────

export interface HedgeLockAnalysis {
  shouldHedge: boolean;
  lockedProfitPerContract: number; // in dollars (e.g. 0.15 = 15¢)
  totalLockedProfit: number;       // in dollars across all contracts
  reason: string;
}

/**
 * Analyze whether buying the opposing side locks in guaranteed profit.
 *
 * When a YES trade is in-the-money and NO contracts are cheap enough:
 *   total basis = yesEntryPrice + noBestAsk (both in dollars, 0-1)
 *   if total basis < 1.00 → buying NO locks $1.00 settlement for less than $1.00 cost
 *
 * The calling bot is responsible for actually placing the hedge order.
 * This function is pure analysis — no side effects.
 *
 * Only applicable to YES positions (buy NO to hedge).
 */
export function analyzeHedgeLock(
  entryPrice: number,    // YES entry as dollar fraction (0-1)
  noBestAsk: number,     // NO best ask as dollar fraction (0-1)
  contracts: number,
  minutesRemaining: number,
): HedgeLockAnalysis {
  const totalBasis = entryPrice + noBestAsk;
  const lockedProfitPerContract = 1.00 - totalBasis;
  const totalLockedProfit = lockedProfitPerContract * contracts;

  if (lockedProfitPerContract <= 0) {
    return {
      shouldHedge: false,
      lockedProfitPerContract: 0,
      totalLockedProfit: 0,
      reason: `No hedge: ${(entryPrice * 100).toFixed(0)}¢ + ${(noBestAsk * 100).toFixed(0)}¢ = ${(totalBasis * 100).toFixed(0)}¢ ≥ 100¢`,
    };
  }

  if (minutesRemaining <= 5) {
    return {
      shouldHedge: false,
      lockedProfitPerContract,
      totalLockedProfit,
      reason: `Hedge skipped: <5m left, sell YES directly instead`,
    };
  }

  return {
    shouldHedge: true,
    lockedProfitPerContract,
    totalLockedProfit,
    reason: `Hedge-lock: ${(entryPrice * 100).toFixed(0)}¢ + ${(noBestAsk * 100).toFixed(0)}¢ = ${(totalBasis * 100).toFixed(0)}¢ → lock $${totalLockedProfit.toFixed(2)}`,
  };
}

/**
 * Calculate the risk that a "Yes" contract goes out of the money before settlement.
 *
 * Uses a proper normal CDF instead of a lookup table. The model estimates
 * P(BTC drops below strike) = 1 - Φ(z) where z = distance / expectedMove.
 *
 * Settlement on Robinhood uses the average of 60 RTI snapshots in the last
 * minute, which smooths out noise and reduces tail risk near expiry.
 */
export function calculateRiskOfRuin(
  currentBTCPrice: number,
  strike: number,
  volatility: number,
  minutesRemaining: number
): RiskOfRuinAnalysis {
  const distanceFromStrike = currentBTCPrice - strike;
  const distancePct = (distanceFromStrike / currentBTCPrice) * 100;

  const timeFactorHours = Math.max(minutesRemaining, 0.5) / 60;
  const expectedMoveRange =
    currentBTCPrice * (volatility / 100) * Math.sqrt(timeFactorHours);

  // z-score: how many expected moves above strike
  const zScore = expectedMoveRange > 0 ? distanceFromStrike / expectedMoveRange : 0;

  // P(BTC stays above strike) = Φ(z), so P(drops below) = 1 - Φ(z)
  let riskOfRuin = 1 - normalCDF(zScore);

  // Settlement averaging: in the final 2 minutes, the 60-snapshot average
  // reduces effective volatility, making outcomes more predictable
  if (minutesRemaining <= 2) {
    const certaintyBoost = 0.15 * (1 - minutesRemaining / 2);
    if (riskOfRuin < 0.5) {
      riskOfRuin = riskOfRuin * (1 - certaintyBoost);
    } else {
      riskOfRuin = riskOfRuin + (1 - riskOfRuin) * certaintyBoost;
    }
  }

  let riskLevel: RiskOfRuinAnalysis['riskLevel'];
  let reason: string;

  if (distanceFromStrike < 50 && volatility > 1.5) {
    riskLevel = 'critical';
    reason = `Only $${distanceFromStrike.toFixed(0)} above strike with ${volatility.toFixed(1)}% volatility`;
  } else if (distancePct < 0.1 && minutesRemaining < 10) {
    riskLevel = 'critical';
    reason = `Only ${distancePct.toFixed(2)}% above strike with ${minutesRemaining}m left`;
  } else if (riskOfRuin >= 0.5) {
    riskLevel = 'critical';
    reason = `${(riskOfRuin * 100).toFixed(0)}% chance of losing`;
  } else if (riskOfRuin >= 0.3) {
    riskLevel = 'high';
    reason = `${(riskOfRuin * 100).toFixed(0)}% chance of losing`;
  } else if (riskOfRuin >= 0.15) {
    riskLevel = 'medium';
    reason = `${(riskOfRuin * 100).toFixed(0)}% chance of losing`;
  } else {
    riskLevel = 'low';
    reason = `${(riskOfRuin * 100).toFixed(0)}% chance of losing - safe`;
  }

  const bufferNeeded = expectedMoveRange * 1.5;

  return {
    riskOfRuin,
    riskLevel,
    reason,
    expectedMove: expectedMoveRange,
    bufferNeeded,
  };
}

/**
 * Estimate the current market value of a contract using our probability model.
 * This replaces the old rough bucket-based estimator with the proper fair value model.
 */
export function estimateContractPrice(
  distanceFromStrike: number,
  minutesRemaining: number,
  btcPrice?: number,
  volatility?: number
): number {
  // If we have full data, use the proper model
  if (btcPrice && volatility) {
    const strike = btcPrice - distanceFromStrike;
    return estimateContractFairValue(btcPrice, strike, volatility, minutesRemaining);
  }

  // Fallback: rough estimate for backward compatibility
  // Use a simplified model when we don't have full data
  if (distanceFromStrike <= 0) return Math.max(0.05, 0.3 + distanceFromStrike / 1000);

  const baseValue = Math.min(0.95, 0.5 + distanceFromStrike / 1000);
  const timeMultiplier = 1 + (60 - minutesRemaining) / 120;

  return Math.min(0.99, Math.max(0.01, baseValue * timeMultiplier));
}

export function analyzeExit(
  trade: ActiveTrade,
  currentBTCPrice: number,
  minutesRemaining: number,
  volatility: number,
  fees: FeeStructure = KALSHI_FEES,
  marketBidPrice?: number
): ExitAnalysis {
  const distanceFromStrike = currentBTCPrice - trade.strike;
  const isNoTrade = trade.direction === 'no';

  // YES fair value from probability model
  const yesFairValue = estimateContractFairValue(
    currentBTCPrice,
    trade.strike,
    volatility,
    minutesRemaining
  );

  // Use actual market bid when available (fixes model vs market price mismatch).
  // GBM model remains fallback when no market data is available.
  const currentImpliedPrice = marketBidPrice !== undefined
    ? marketBidPrice
    : (isNoTrade ? 1 - yesFairValue : yesFairValue);

  const riskAnalysis = calculateRiskOfRuin(
    currentBTCPrice,
    trade.strike,
    volatility,
    minutesRemaining
  );

  // riskOfRuin = P(BTC drops below strike)
  // YES wins when BTC >= strike, NO wins when BTC < strike
  const winProbability = isNoTrade ? riskAnalysis.riskOfRuin : 1 - riskAnalysis.riskOfRuin;
  const lossRisk = 1 - winProbability;

  // Direction-aware risk level (based on probability of losing THIS trade)
  let dirRiskLevel: RiskOfRuinAnalysis['riskLevel'];
  if (lossRisk >= 0.5) dirRiskLevel = 'critical';
  else if (lossRisk >= 0.3) dirRiskLevel = 'high';
  else if (lossRisk >= 0.15) dirRiskLevel = 'medium';
  else dirRiskLevel = 'low';

  // Calculate net P&L for early exit at current estimated price
  const earlyExitNet = calculateNetPnL(
    trade.contracts,
    trade.entryPrice,
    currentImpliedPrice,
    'early',
    fees
  );

  // Expected P&L if we hold to settlement
  const winAmount = calculateNetPnL(trade.contracts, trade.entryPrice, 1.0, 'settlement', fees);
  const loseAmount = calculateNetPnL(trade.contracts, trade.entryPrice, 0.0, 'settlement', fees);
  const settlementExpectedNet = winProbability * winAmount + lossRisk * loseAmount;

  // ──── OTM-SPECIFIC EXIT LOGIC ────
  // OTM contracts (entry ≤ 50¢) are EXPECTED to be below strike — that's not
  // a crisis. The ITM logic below would panic-exit immediately on every OTM
  // trade because being below strike always registers as "critical risk."
  //
  // For OTM, we use pure EV comparison: exit when locking in profit beats
  // holding to settlement. This is the entire edge — without smart early
  // exit, OTM goes bankrupt (8/10 ruin). With it, it outperforms conservative.
  const isOTM = trade.entryPrice <= 0.50;

  if (isOTM) {
    // Exit when early exit P&L > settlement EV AND it's profitable.
    // This captures favorable mid-hour price swings.
    const minProfit = trade.totalCost * 0.10; // At least 10% return to exit early
    // Require bid >= $0.60 before locking profit — contracts exiting at $0.21-$0.41 that
    // settle at $1.00 leave 40-80¢/contract on the table. Only exit early if we've captured
    // 60%+ of terminal value. Also guard against misfiring when holdEV is negative (any
    // positive exit looks like "1.3x better than hold" when holdEV < 0).
    if (
      earlyExitNet > settlementExpectedNet * 1.3 &&
      earlyExitNet > minProfit &&
      settlementExpectedNet >= 0 &&
      currentImpliedPrice >= 0.60
    ) {
      return {
        shouldExit: true,
        reason: `OTM profit lock: exit $${earlyExitNet.toFixed(2)} > hold EV $${settlementExpectedNet.toFixed(2)}`,
        expectedNetPnL: earlyExitNet,
        currentValue: currentImpliedPrice,
        settlementExpectedValue: winProbability,
        feeImpact: earlyExitNet - settlementExpectedNet,
        confidence: 'high',
        riskOfRuin: lossRisk,
        riskLevel: dirRiskLevel,
      };
    }

    // If profitable and < 5 minutes remain, exit to beat MM manipulation.
    // MMs flood resistance at $250 levels in the final 5 minutes, tanking bids —
    // but minutes 6-10 still have enough time for the contract to recover if underwater.
    if (minutesRemaining <= 5 && earlyExitNet > 0) {
      return {
        shouldExit: true,
        reason: `OTM profit protect: $${earlyExitNet.toFixed(2)} profit, <5m left (MM window)`,
        expectedNetPnL: earlyExitNet,
        currentValue: currentImpliedPrice,
        settlementExpectedValue: winProbability,
        feeImpact: earlyExitNet - settlementExpectedNet,
        confidence: 'high',
        riskOfRuin: lossRisk,
        riskLevel: dirRiskLevel,
      };
    }

    // Probability-based stop-loss: if win probability is low and time is running out,
    // cut losses rather than riding to $0. The model already accounts for distance
    // from strike, volatility, and time decay.
    if (minutesRemaining <= 15 && winProbability < 0.20 && earlyExitNet > loseAmount) {
      return {
        shouldExit: true,
        reason: `OTM stop-loss: ${(winProbability * 100).toFixed(0)}% win prob, ${Math.round(minutesRemaining)}m left | exit $${earlyExitNet.toFixed(2)} vs full loss $${loseAmount.toFixed(2)}`,
        expectedNetPnL: earlyExitNet,
        currentValue: currentImpliedPrice,
        settlementExpectedValue: winProbability,
        feeImpact: 0,
        confidence: 'medium',
        riskOfRuin: lossRisk,
        riskLevel: dirRiskLevel,
      };
    }

    // Very little time left and no edge — cut losses to save what we can
    if (minutesRemaining <= 5 && earlyExitNet > loseAmount) {
      return {
        shouldExit: true,
        reason: `OTM <5m left: exit $${earlyExitNet.toFixed(2)} beats full loss $${loseAmount.toFixed(2)}`,
        expectedNetPnL: earlyExitNet,
        currentValue: currentImpliedPrice,
        settlementExpectedValue: winProbability,
        feeImpact: 0,
        confidence: 'medium',
        riskOfRuin: lossRisk,
        riskLevel: dirRiskLevel,
      };
    }

    // Otherwise hold — OTM needs time for the move to develop
    return {
      shouldExit: false,
      reason: `OTM hold: exit $${earlyExitNet.toFixed(2)} vs hold EV $${settlementExpectedNet.toFixed(2)} — waiting`,
      expectedNetPnL: settlementExpectedNet,
      currentValue: currentImpliedPrice,
      settlementExpectedValue: winProbability,
      feeImpact: 0,
      confidence: 'medium',
      riskOfRuin: lossRisk,
      riskLevel: dirRiskLevel,
    };
  }

  // ──── ITM / CONSERVATIVE EXIT LOGIC (entry > 50¢) ────

  // PRIORITY 1: CRITICAL RISK - Exit immediately
  if (dirRiskLevel === 'critical') {
    return {
      shouldExit: true,
      reason: `CRITICAL: ${riskAnalysis.reason}. Exit to preserve capital.`,
      expectedNetPnL: earlyExitNet,
      currentValue: currentImpliedPrice,
      settlementExpectedValue: winProbability,
      feeImpact: settlementExpectedNet - earlyExitNet,
      confidence: 'high',
      riskOfRuin: lossRisk,
      riskLevel: 'critical',
    };
  }

  // PRIORITY 2: NEGATIVE EXPECTED VALUE - Math says exit
  if (settlementExpectedNet < earlyExitNet && earlyExitNet > 0) {
    return {
      shouldExit: true,
      reason: `Hold EV ($${settlementExpectedNet.toFixed(2)}) < Exit ($${earlyExitNet.toFixed(2)}). Exit has better expected value.`,
      expectedNetPnL: earlyExitNet,
      currentValue: currentImpliedPrice,
      settlementExpectedValue: winProbability,
      feeImpact: earlyExitNet - settlementExpectedNet,
      confidence: 'high',
      riskOfRuin: lossRisk,
      riskLevel: dirRiskLevel,
    };
  }

  // PRIORITY 3: HIGH RISK with little time
  if (dirRiskLevel === 'high' && minutesRemaining < 15) {
    if (settlementExpectedNet > earlyExitNet * 1.2) {
      return {
        shouldExit: false,
        reason: `HIGH RISK (${(lossRisk * 100).toFixed(0)}%) but hold EV $${settlementExpectedNet.toFixed(2)} >> exit $${earlyExitNet.toFixed(2)}`,
        expectedNetPnL: settlementExpectedNet,
        currentValue: currentImpliedPrice,
        settlementExpectedValue: winProbability,
        feeImpact: 0,
        confidence: 'low',
        riskOfRuin: lossRisk,
        riskLevel: 'high',
      };
    } else {
      return {
        shouldExit: true,
        reason: `HIGH RISK (${(lossRisk * 100).toFixed(0)}%). Secure $${earlyExitNet.toFixed(2)} now.`,
        expectedNetPnL: earlyExitNet,
        currentValue: currentImpliedPrice,
        settlementExpectedValue: winProbability,
        feeImpact: settlementExpectedNet - earlyExitNet,
        confidence: 'medium',
        riskOfRuin: lossRisk,
        riskLevel: 'high',
      };
    }
  }

  // PRIORITY 4: STANDARD EXIT CRITERIA

  // Too early — wait
  if (minutesRemaining > 30) {
    return {
      shouldExit: false,
      reason: 'Too early — wait until <30m remaining',
      expectedNetPnL: settlementExpectedNet,
      currentValue: currentImpliedPrice,
      settlementExpectedValue: winProbability,
      feeImpact: 0,
      confidence: 'high',
      riskOfRuin: lossRisk,
      riskLevel: dirRiskLevel,
    };
  }

  // Currently underwater (YES: below strike, NO: above strike)
  const isUnderwater = isNoTrade ? currentBTCPrice >= trade.strike : currentBTCPrice <= trade.strike;
  if (isUnderwater) {
    return {
      shouldExit: false,
      reason: `BTC ${isNoTrade ? 'above' : 'below'} strike — hold for recovery`,
      expectedNetPnL: settlementExpectedNet,
      currentValue: currentImpliedPrice,
      settlementExpectedValue: winProbability,
      feeImpact: 0,
      confidence: 'medium',
      riskOfRuin: lossRisk,
      riskLevel: dirRiskLevel,
    };
  }

  // Early exit value not high enough relative to settlement EV
  const earlyExitThreshold = settlementExpectedNet * 0.85;
  if (earlyExitNet < earlyExitThreshold) {
    return {
      shouldExit: false,
      reason: `Exit ($${earlyExitNet.toFixed(2)}) < 85% of settlement EV ($${settlementExpectedNet.toFixed(2)})`,
      expectedNetPnL: settlementExpectedNet,
      currentValue: currentImpliedPrice,
      settlementExpectedValue: winProbability,
      feeImpact: settlementExpectedNet - earlyExitNet,
      confidence: 'medium',
      riskOfRuin: lossRisk,
      riskLevel: dirRiskLevel,
    };
  }

  // Contract price too low — fees eat the profit
  if (currentImpliedPrice < 0.75) {
    return {
      shouldExit: false,
      reason: `Contract at ${(currentImpliedPrice * 100).toFixed(0)}¢ — too low, fees would eat profit`,
      expectedNetPnL: settlementExpectedNet,
      currentValue: currentImpliedPrice,
      settlementExpectedValue: winProbability,
      feeImpact: (fees.takerFeePct / 100) * trade.contracts * currentImpliedPrice,
      confidence: 'medium',
      riskOfRuin: lossRisk,
      riskLevel: dirRiskLevel,
    };
  }

  // ALL CONDITIONS MET - EXIT
  return {
    shouldExit: true,
    reason: `Lock in $${earlyExitNet.toFixed(2)} (${(lossRisk * 100).toFixed(0)}% loss risk)`,
    expectedNetPnL: earlyExitNet,
    currentValue: currentImpliedPrice,
    settlementExpectedValue: winProbability,
    feeImpact: settlementExpectedNet - earlyExitNet,
    confidence: 'high',
    riskOfRuin: lossRisk,
    riskLevel: dirRiskLevel,
  };
}
