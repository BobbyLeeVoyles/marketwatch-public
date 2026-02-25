'use client';

import { useState } from 'react';
import { Signal, ActiveTrade, Trade } from '@/lib/types';
import { calculateFeeBreakdown, ROBINHOOD_FEES } from '@/lib/utils/fees';
import { getNearbyStrikes } from '@/lib/utils/strikes';

interface TradeLoggerProps {
  signal: Signal;
  btcPrice: number;
  onConfirm: (trade: ActiveTrade) => void;
  onCancel: () => void;
}

export default function TradeLogger({
  signal,
  btcPrice,
  onConfirm,
  onCancel,
}: TradeLoggerProps) {
  const nearbyStrikes = getNearbyStrikes(btcPrice);
  const [selectedStrike, setSelectedStrike] = useState(signal.strike ?? nearbyStrikes[1]);
  const [entryPrice, setEntryPrice] = useState(signal.entryPrice ?? 0.6);
  const [contracts, setContracts] = useState(signal.contracts ?? 16);

  const fees = ROBINHOOD_FEES;
  const breakdown = calculateFeeBreakdown(contracts, entryPrice, entryPrice, 'early', fees);

  // Projected exit scenarios
  const earlyExit = calculateFeeBreakdown(contracts, entryPrice, 0.8, 'early', fees);
  const settlement = calculateFeeBreakdown(contracts, entryPrice, 1.0, 'settlement', fees);

  const handleConfirm = () => {
    const grossCost = contracts * entryPrice;
    const entryFee = grossCost * (fees.takerFeePct / 100);

    const trade: ActiveTrade = {
      id: `trade-${Date.now()}`,
      timestamp: new Date(),
      strategy: signal.strategy!,
      direction: signal.direction ?? 'yes',
      strike: selectedStrike,
      entryPrice,
      contracts,
      totalCost: grossCost + entryFee,
      btcPriceAtEntry: btcPrice,
    };

    onConfirm(trade);
  };

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        LOG TRADE - {signal.strategy?.toUpperCase()}
      </div>

      <div className="text-[11px] mb-3">
        <span className="text-terminal-muted">RECOMMENDED: </span>
        <span className="text-terminal-text">
          Strike ${signal.strike?.toLocaleString()}+ at &le;
          {((signal.entryPrice ?? 0) * 100).toFixed(0)}&cent; ({signal.contracts}{' '}
          contracts)
        </span>
      </div>

      <div className="border border-terminal-border p-3 space-y-3">
        <div className="data-label">ACTUAL TRADE EXECUTED:</div>

        {/* Strike Selection */}
        <div>
          <div className="data-label mb-1">STRIKE PURCHASED:</div>
          <div className="flex flex-wrap gap-2">
            {nearbyStrikes.map((s) => (
              <label
                key={s}
                className={`flex items-center gap-1 text-[11px] cursor-pointer px-2 py-1 border ${
                  selectedStrike === s
                    ? 'border-terminal-cyan text-terminal-cyan'
                    : 'border-terminal-border text-terminal-muted hover:border-terminal-muted'
                }`}
              >
                <input
                  type="radio"
                  name="strike"
                  className="hidden"
                  checked={selectedStrike === s}
                  onChange={() => setSelectedStrike(s)}
                />
                ${s.toLocaleString()}
                {s === signal.strike && (
                  <span className="text-terminal-green text-[9px]">REC</span>
                )}
              </label>
            ))}
          </div>
        </div>

        {/* Entry Price */}
        <div className="flex items-center gap-2">
          <span className="data-label w-24">ENTRY PRICE:</span>
          <input
            type="number"
            step="0.01"
            min="0.01"
            max="0.99"
            value={entryPrice}
            onChange={(e) => setEntryPrice(parseFloat(e.target.value) || 0)}
            className="bg-terminal-bg border border-terminal-border text-terminal-text px-2 py-1 text-[12px] w-24 font-mono focus:border-terminal-cyan outline-none"
          />
          <span className="text-terminal-muted text-[11px]">&cent;</span>
        </div>

        {/* Contracts */}
        <div className="flex items-center gap-2">
          <span className="data-label w-24">CONTRACTS:</span>
          <input
            type="number"
            min="1"
            max="100"
            value={contracts}
            onChange={(e) => setContracts(parseInt(e.target.value) || 1)}
            className="bg-terminal-bg border border-terminal-border text-terminal-text px-2 py-1 text-[12px] w-24 font-mono focus:border-terminal-cyan outline-none"
          />
        </div>

        {/* Validation */}
        <div className="space-y-0.5 text-[11px]">
          <div className="data-label">VALIDATION:</div>
          <div
            className={
              entryPrice <= (signal.entryPrice ?? 1)
                ? 'text-terminal-green'
                : 'text-terminal-yellow'
            }
          >
            {entryPrice <= (signal.entryPrice ?? 1) ? '\u2713' : '\u26a0'} Entry
            price{' '}
            {entryPrice <= (signal.entryPrice ?? 1)
              ? 'under'
              : 'over'}{' '}
            {((signal.entryPrice ?? 0) * 100).toFixed(0)}&cent; limit
          </div>
          <div
            className={
              selectedStrike === signal.strike
                ? 'text-terminal-green'
                : 'text-terminal-yellow'
            }
          >
            {selectedStrike === signal.strike ? '\u2713' : '\u26a0'} Strike{' '}
            {selectedStrike === signal.strike
              ? 'matches'
              : 'differs from'}{' '}
            recommendation
          </div>
        </div>

        {/* Fee Breakdown */}
        <div className="border-t border-terminal-border pt-2 space-y-1 text-[11px]">
          <div className="flex justify-between">
            <span className="text-terminal-muted">COST:</span>
            <span className="data-value">${breakdown.grossCost.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-terminal-muted">ENTRY FEE (1.5%):</span>
            <span className="text-terminal-red">${breakdown.entryFee.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-terminal-muted">TOTAL ENTRY COST:</span>
            <span className="data-value">${breakdown.totalCost.toFixed(2)}</span>
          </div>
        </div>

        {/* Projected Exit Scenarios */}
        <div className="border-t border-terminal-border pt-2 space-y-1 text-[11px]">
          <div className="data-label">PROJECTED EXIT SCENARIOS:</div>
          <div className="flex justify-between">
            <span className="text-terminal-muted">
              Exit at 80&cent;:
            </span>
            <span
              className={`data-value ${earlyExit.netPnL >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}
            >
              Net {earlyExit.netPnL >= 0 ? '+' : ''}${earlyExit.netPnL.toFixed(2)} (fee: ${earlyExit.exitFee.toFixed(2)})
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-terminal-muted">Settle $1.00:</span>
            <span
              className={`data-value ${settlement.netPnL >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}
            >
              Net {settlement.netPnL >= 0 ? '+' : ''}${settlement.netPnL.toFixed(2)} (no exit fee)
            </span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 pt-2">
          <button
            onClick={handleConfirm}
            className="bg-terminal-green/20 border border-terminal-green text-terminal-green px-4 py-1.5 text-[11px] uppercase tracking-wider hover:bg-terminal-green/30 transition-colors flex-1"
          >
            CONFIRM & TRACK
          </button>
          <button
            onClick={onCancel}
            className="border border-terminal-border text-terminal-muted px-4 py-1.5 text-[11px] uppercase tracking-wider hover:border-terminal-red hover:text-terminal-red transition-colors"
          >
            CANCEL
          </button>
        </div>
      </div>
    </div>
  );
}
