import { useRef, useCallback, useEffect } from 'react';
import { Signal, ActiveTrade, Trade } from '@/lib/types';
import { calculateFeeBreakdown, ROBINHOOD_FEES } from './fees';
import { analyzeExit } from './exitLogic';
import { estimateContractFairValue } from './strikes';

interface AutoTraderConfig {
  conservativeSignal: Signal;
  aggressiveSignal: Signal;
  btcPrice: number;
  volatility: number;
  activeTrades: ActiveTrade[];
  onEnterTrade: (trade: ActiveTrade) => void;
  onExitTrade: (tradeId: string, exitPrice: number, exitType: 'early' | 'settlement') => void;
}

/**
 * Auto-trading engine for Robinhood hourly prediction markets.
 *
 * - Auto-enters trades when signals activate (using dynamic market-based pricing)
 * - Auto-exits based on risk-adjusted exit logic
 * - Auto-settles at the top of each hour
 * - Prevents duplicate entries per strategy per hour
 */
export function useAutoTrader({
  conservativeSignal,
  aggressiveSignal,
  btcPrice,
  volatility,
  activeTrades,
  onEnterTrade,
  onExitTrade,
}: AutoTraderConfig) {
  const tradedThisHour = useRef<Record<string, number>>({});
  const prevSignals = useRef<{ conservative: boolean; aggressive: boolean }>({
    conservative: false,
    aggressive: false,
  });

  const getCurrentHourKey = useCallback(() => {
    const now = new Date();
    return `${now.toISOString().split('T')[0]}-${now.getUTCHours()}`;
  }, []);

  // Auto-enter trades when signals activate
  useEffect(() => {
    if (btcPrice <= 0) return;

    const hourKey = getCurrentHourKey();

    // Conservative: enter when signal transitions to active
    if (
      conservativeSignal.active &&
      !prevSignals.current.conservative &&
      !activeTrades.some((t) => t.strategy === 'conservative') &&
      tradedThisHour.current[`conservative-${hourKey}`] !== 1
    ) {
      const strike = conservativeSignal.strike!;
      // Use the dynamic max entry price from the signal (not a fixed price)
      const entryPrice = conservativeSignal.maxEntryPrice ?? conservativeSignal.entryPrice!;
      const contracts = conservativeSignal.contracts!;
      const grossCost = contracts * entryPrice;
      const entryFee = grossCost * (ROBINHOOD_FEES.takerFeePct / 100);

      const trade: ActiveTrade = {
        id: `auto-${Date.now()}-con`,
        timestamp: new Date(),
        strategy: 'conservative',
        direction: conservativeSignal.direction ?? 'yes',
        strike,
        entryPrice,
        contracts,
        totalCost: grossCost + entryFee,
        btcPriceAtEntry: btcPrice,
      };

      tradedThisHour.current[`conservative-${hourKey}`] = 1;
      onEnterTrade(trade);
    }

    // Aggressive: enter when signal transitions to active
    if (
      aggressiveSignal.active &&
      !prevSignals.current.aggressive &&
      !activeTrades.some((t) => t.strategy === 'aggressive') &&
      tradedThisHour.current[`aggressive-${hourKey}`] !== 1
    ) {
      const strike = aggressiveSignal.strike!;
      const entryPrice = aggressiveSignal.maxEntryPrice ?? aggressiveSignal.entryPrice!;
      const contracts = aggressiveSignal.contracts!;
      const grossCost = contracts * entryPrice;
      const entryFee = grossCost * (ROBINHOOD_FEES.takerFeePct / 100);

      const trade: ActiveTrade = {
        id: `auto-${Date.now()}-agg`,
        timestamp: new Date(),
        strategy: 'aggressive',
        direction: aggressiveSignal.direction ?? 'yes',
        strike,
        entryPrice,
        contracts,
        totalCost: grossCost + entryFee,
        btcPriceAtEntry: btcPrice,
      };

      tradedThisHour.current[`aggressive-${hourKey}`] = 1;
      onEnterTrade(trade);
    }

    prevSignals.current = {
      conservative: conservativeSignal.active,
      aggressive: aggressiveSignal.active,
    };
  }, [
    conservativeSignal.active,
    aggressiveSignal.active,
    btcPrice,
    activeTrades,
    onEnterTrade,
    getCurrentHourKey,
    conservativeSignal,
    aggressiveSignal,
  ]);

  // Auto-exit logic: check every 10 seconds
  useEffect(() => {
    if (activeTrades.length === 0 || btcPrice <= 0) return;

    const checkExits = () => {
      const now = new Date();
      const minutesRemaining = 60 - now.getMinutes();

      for (const trade of activeTrades) {
        // Use proper probability model for current contract value
        const currentImpliedPrice = estimateContractFairValue(
          btcPrice,
          trade.strike,
          volatility,
          minutesRemaining
        );

        // Settlement: at the top of the hour, settle based on BTC vs strike
        // Robinhood settles using avg of 60 RTI snapshots in last minute
        if (minutesRemaining >= 59) {
          const tradeHour = new Date(trade.timestamp).getUTCHours();
          const currentHour = now.getUTCHours();
          if (tradeHour !== currentHour) {
            const isWin = trade.direction === 'yes'
              ? btcPrice > trade.strike
              : btcPrice < trade.strike;
            onExitTrade(trade.id, isWin ? 1.0 : 0.0, 'settlement');
            continue;
          }
        }

        // Risk-adjusted exit analysis
        const analysis = analyzeExit(trade, btcPrice, minutesRemaining, volatility);
        if (analysis.shouldExit) {
          onExitTrade(trade.id, currentImpliedPrice, 'early');
        }
      }
    };

    checkExits();

    const interval = setInterval(checkExits, 10000);
    return () => clearInterval(interval);
  }, [activeTrades, btcPrice, volatility, onExitTrade]);

  // Cleanup stale hour keys
  useEffect(() => {
    const hourKey = getCurrentHourKey();
    const keys = Object.keys(tradedThisHour.current);
    for (const key of keys) {
      if (!key.endsWith(hourKey.split('-').slice(-1)[0])) {
        const keyHour = key.split('-').pop();
        const currentHour = hourKey.split('-').pop();
        if (keyHour !== currentHour) {
          delete tradedThisHour.current[key];
        }
      }
    }
  }, [getCurrentHourKey]);
}
