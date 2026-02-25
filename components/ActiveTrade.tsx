'use client';

import { useState, useEffect, useMemo } from 'react';
import { ActiveTrade as ActiveTradeType, ExitAnalysis, Trade } from '@/lib/types';
import { analyzeExit } from '@/lib/utils/exitLogic';
import { calculateNetPnL, calculateFeeBreakdown, ROBINHOOD_FEES } from '@/lib/utils/fees';
import { estimateContractFairValue } from '@/lib/utils/strikes';
import RiskAnalysis from './RiskAnalysis';

interface ActiveTradeProps {
  trade: ActiveTradeType;
  btcPrice: number;
  volatility: number;
  onExit: (exitPrice: number, exitType: 'early' | 'settlement') => void;
  onCancel: () => void;
}

export default function ActiveTradeComponent({
  trade,
  btcPrice,
  volatility,
  onExit,
  onCancel,
}: ActiveTradeProps) {
  const [minutesRemaining, setMinutesRemaining] = useState(60);

  useEffect(() => {
    const updateTimer = () => {
      const now = new Date();
      const remaining = 60 - now.getMinutes();
      setMinutesRemaining(remaining);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, []);

  const distanceFromStrike = btcPrice - trade.strike;

  // Use proper probability model for contract valuation
  const currentImpliedPrice = estimateContractFairValue(
    btcPrice,
    trade.strike,
    volatility,
    minutesRemaining
  );

  const analysis = useMemo(
    () => analyzeExit(trade, btcPrice, minutesRemaining, volatility),
    [trade, btcPrice, minutesRemaining, volatility]
  );

  const earlyExitNet = calculateNetPnL(
    trade.contracts,
    trade.entryPrice,
    currentImpliedPrice,
    'early',
    ROBINHOOD_FEES
  );

  const holdWinAmount = calculateNetPnL(
    trade.contracts,
    trade.entryPrice,
    1.0,
    'settlement',
    ROBINHOOD_FEES
  );

  const holdLoseAmount = calculateNetPnL(
    trade.contracts,
    trade.entryPrice,
    0.0,
    'settlement',
    ROBINHOOD_FEES
  );

  const statusLabel =
    distanceFromStrike > 300
      ? 'SAFE'
      : distanceFromStrike > 50
        ? ''
        : 'FRAGILE';

  const mins = minutesRemaining;
  const secs = 60 - new Date().getSeconds();

  const direction = (trade.direction ?? 'yes').toUpperCase();

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        ACTIVE TRADE - {trade.strategy.toUpperCase()}
      </div>

      <div className="space-y-2 text-[11px] mb-3">
        <div>
          <span className="text-terminal-muted">ENTRY: </span>
          <span className="text-terminal-text">
            {direction} ${trade.strike.toLocaleString()}+ at{' '}
            {(trade.entryPrice * 100).toFixed(0)}&cent; ({trade.contracts}{' '}
            contracts) - COST: ${trade.totalCost.toFixed(2)}
          </span>
        </div>
        <div>
          <span className="text-terminal-muted">TIME REMAINING: </span>
          <span className="data-value text-terminal-cyan">
            {mins - 1}:{secs.toString().padStart(2, '0')}
          </span>
          <span className="text-terminal-muted text-[10px] ml-2">
            (settles via avg of 60 RTI snapshots in last minute)
          </span>
        </div>

        <div className="border-t border-terminal-border pt-2">
          <div className="data-label mb-1">CURRENT STATUS:</div>
          <div>
            <span className="text-terminal-muted">BTC: </span>
            <span className="data-value">
              ${btcPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span
              className={`ml-2 ${distanceFromStrike > 0 ? 'text-terminal-green' : 'text-terminal-red'}`}
            >
              [{distanceFromStrike > 0 ? '+' : ''}${distanceFromStrike.toFixed(0)}{' '}
              {distanceFromStrike > 0 ? 'ABOVE' : 'BELOW'} STRIKE]
              {statusLabel && (
                <span
                  className={`ml-1 ${
                    statusLabel === 'SAFE'
                      ? 'text-terminal-green'
                      : 'text-terminal-yellow'
                  }`}
                >
                  {statusLabel === 'SAFE' ? '\u2713' : '\u26a0\ufe0f'} {statusLabel}
                </span>
              )}
            </span>
          </div>
          <div className="mt-1">
            <span className="text-terminal-muted">
              Est. Contract Value:{' '}
            </span>
            <span className="data-value">
              ~{(currentImpliedPrice * 100).toFixed(0)}&cent;
            </span>
            <span className="text-terminal-muted ml-2">
              ({(currentImpliedPrice * 100).toFixed(0)}% win probability)
            </span>
          </div>
        </div>
      </div>

      {/* Risk Analysis */}
      <RiskAnalysis
        analysis={analysis}
        earlyExitNet={earlyExitNet}
        holdWinAmount={holdWinAmount}
        holdLoseAmount={holdLoseAmount}
        contracts={trade.contracts}
        currentImpliedPrice={currentImpliedPrice}
        entryPrice={trade.entryPrice}
      />

      {/* Action Buttons */}
      <div className="flex gap-2 mt-3">
        {analysis.shouldExit ? (
          <>
            <button
              onClick={() => onExit(currentImpliedPrice, 'early')}
              className="bg-terminal-red/20 border border-terminal-red text-terminal-red px-4 py-1.5 text-[11px] uppercase tracking-wider hover:bg-terminal-red/30 transition-colors flex-1"
            >
              EXIT AT {(currentImpliedPrice * 100).toFixed(0)}&cent; NOW
            </button>
            <button
              onClick={() => {}}
              className="border border-terminal-border text-terminal-muted px-4 py-1.5 text-[11px] uppercase tracking-wider hover:border-terminal-yellow hover:text-terminal-yellow transition-colors"
            >
              OVERRIDE: HOLD
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => onExit(currentImpliedPrice, 'early')}
              className="border border-terminal-border text-terminal-muted px-4 py-1.5 text-[11px] uppercase tracking-wider hover:border-terminal-muted transition-colors"
            >
              EXIT AT {(currentImpliedPrice * 100).toFixed(0)}&cent;
            </button>
            <button
              className="bg-terminal-green/20 border border-terminal-green text-terminal-green px-4 py-1.5 text-[11px] uppercase tracking-wider flex-1"
            >
              HOLD (RECOMMENDED)
            </button>
          </>
        )}
        <button
          onClick={() => onExit(1.0, 'settlement')}
          className="border border-terminal-cyan text-terminal-cyan px-3 py-1.5 text-[11px] uppercase tracking-wider hover:bg-terminal-cyan/10 transition-colors"
        >
          SETTLED WIN
        </button>
        <button
          onClick={() => onExit(0.0, 'settlement')}
          className="border border-terminal-red text-terminal-red px-3 py-1.5 text-[11px] uppercase tracking-wider hover:bg-terminal-red/10 transition-colors"
        >
          SETTLED LOSS
        </button>
      </div>
    </div>
  );
}
