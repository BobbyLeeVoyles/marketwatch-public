import { BTCData, Signal, CriteriaCheck } from '@/lib/types';
import { calculateStrike, getStrikeDistance, MIN_STRIKE_DISTANCE, estimateContractFairValue } from '@/lib/utils/strikes';

const PROB_LO = 0.50;
const PROB_HI = 0.95;
const MAX_ENTRY_PRICE = 0.70;
const POSITION_SIZE = 20;

/**
 * Conservative strategy for Robinhood hourly prediction markets.
 *
 * Approach: Buy "Yes" contracts on the floor strike (strike BELOW current BTC
 * price). BTC is already above the strike, so these have high win probability.
 * Pay up to 70¢ for contracts in the 50-95% probability band.
 *
 * Validated via V2 honest backtest with minute-level Brownian-bridge prices,
 * no future data leakage, RH-calibrated contract pricing, and bankroll ruin
 * tracking across 10 Monte Carlo paths × 365 days.
 *
 * Results: 62.6% WR, +$962/yr avg, 0/10 ruin, $106 max DD, risk-adj 9.04.
 * Profitable on ALL 10/10 paths (worst path: +$763).
 * Trades ~357/yr (~1.4 per trading hour).
 *
 * Key changes from prior conservative: removed vol filter (was 0.5-1.5%),
 * removed price position filter (was >60%), widened prob band (was >=85%),
 * increased position size ($20 vs $8), increased min time (15m vs 10m),
 * loosened SMA (0.3% vs 0.1%).
 */
export function checkConservativeSignal(data: BTCData): Signal {
  const now = new Date();
  const minutesRemaining = 60 - now.getMinutes();

  // Don't enter in the last 15 minutes — backtested optimal
  const enoughTime = minutesRemaining > 15;

  // SMA trend with 0.3% looseness (backtested optimal)
  const shortTrendUp =
    data.indicators.sma3 > data.indicators.sma6 ||
    (data.indicators.sma6 > 0 &&
      (data.indicators.sma6 - data.indicators.sma3) / data.indicators.sma6 < 0.003);
  const mediumTrendUp =
    data.indicators.sma6 > data.indicators.sma12 ||
    (data.indicators.sma12 > 0 &&
      (data.indicators.sma12 - data.indicators.sma6) / data.indicators.sma12 < 0.003);

  const strikeDistance = getStrikeDistance(data.price);
  const strikeDistanceOk = strikeDistance >= MIN_STRIKE_DISTANCE;

  // Floor strike — the $250-increment strike below current price
  const strike = calculateStrike(data.price, 'OTM');
  const fairValue = estimateContractFairValue(
    data.price,
    strike,
    data.indicators.volatility,
    minutesRemaining
  );

  // Probability must be in the 50-95% band
  // Too low (<50%) = too risky, too high (>95%) = contract costs too much for the edge
  const probabilityOk = fairValue >= PROB_LO && fairValue <= PROB_HI;

  // Cap at 70¢ — never overpay
  const entryPrice = Math.min(MAX_ENTRY_PRICE, Math.floor(fairValue * 100) / 100);
  const contracts = entryPrice > 0 ? Math.floor(POSITION_SIZE / entryPrice) : 0;

  const criteriaChecks: CriteriaCheck[] = [
    {
      label: 'TIME REMAINING >15m',
      passed: enoughTime,
      value: `${minutesRemaining}m left`,
    },
    {
      label: 'SHORT TREND UP',
      passed: shortTrendUp,
      value: `SMA3 ${data.indicators.sma3.toFixed(0)} ${shortTrendUp ? '>~' : '<'} SMA6 ${data.indicators.sma6.toFixed(0)}`,
    },
    {
      label: 'MEDIUM TREND UP',
      passed: mediumTrendUp,
      value: `SMA6 ${data.indicators.sma6.toFixed(0)} ${mediumTrendUp ? '>~' : '<'} SMA12 ${data.indicators.sma12.toFixed(0)}`,
    },
    {
      label: `STRIKE DIST >=$${MIN_STRIKE_DISTANCE}`,
      passed: strikeDistanceOk,
      value: `$${strikeDistance.toFixed(0)} from $${strike.toLocaleString()}`,
    },
    {
      label: `MODEL PROB ${PROB_LO * 100}-${PROB_HI * 100}%`,
      passed: probabilityOk,
      value: `${(fairValue * 100).toFixed(0)}% est. fair value`,
    },
  ];

  const allPassed =
    enoughTime && shortTrendUp && mediumTrendUp && strikeDistanceOk && probabilityOk;

  if (allPassed) {
    return {
      active: true,
      strategy: 'conservative',
      direction: 'yes',
      strike,
      entryPrice,
      estimatedProbability: fairValue,
      maxEntryPrice: MAX_ENTRY_PRICE,
      positionSize: POSITION_SIZE,
      contracts,
      exitStrategy: `Buy YES $${strike.toLocaleString()}+ if market price ≤${(entryPrice * 100).toFixed(0)}¢ (model: ${(fairValue * 100).toFixed(0)}¢ fair value)`,
      criteriaChecks,
    };
  }

  return {
    active: false,
    strategy: 'conservative',
    direction: 'yes',
    strike,
    entryPrice,
    estimatedProbability: fairValue,
    maxEntryPrice: MAX_ENTRY_PRICE,
    positionSize: POSITION_SIZE,
    contracts,
    exitStrategy: `Buy YES $${strike.toLocaleString()}+ if market price ≤${(entryPrice * 100).toFixed(0)}¢ (model: ${(fairValue * 100).toFixed(0)}¢ fair value)`,
    criteriaChecks,
    failedCriteria: criteriaChecks.filter((c) => !c.passed).map((c) => c.label),
  };
}
