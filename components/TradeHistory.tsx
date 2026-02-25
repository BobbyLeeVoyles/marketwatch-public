'use client';

import { useState } from 'react';
import { Trade } from '@/lib/types';
import { exportTradesCSV } from '@/lib/utils/storage';
import { calculateFeeBreakdown, ROBINHOOD_FEES } from '@/lib/utils/fees';

interface TradeHistoryProps {
  trades: Trade[];
  totalFees: number;
  btcPrice: number;
  onLogTrade?: (trade: Trade) => void;
}

export default function TradeHistory({ trades, totalFees, btcPrice, onLogTrade }: TradeHistoryProps) {
  const [showForm, setShowForm] = useState(false);
  const [strategy, setStrategy] = useState<'conservative' | 'aggressive'>('conservative');
  const [strike, setStrike] = useState('');
  const [entryPrice, setEntryPrice] = useState('0.60');
  const [exitPrice, setExitPrice] = useState('1.00');
  const [contracts, setContracts] = useState('16');
  const [exitType, setExitType] = useState<'early' | 'settlement'>('settlement');

  const handleExport = () => {
    const csv = exportTradesCSV(trades);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `btc-trades-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleLogTrade = () => {
    const ep = parseFloat(entryPrice) || 0;
    const xp = parseFloat(exitPrice) || 0;
    const c = parseInt(contracts) || 0;
    const s = parseInt(strike) || Math.round(btcPrice / 250) * 250;

    if (c <= 0 || ep <= 0) return;

    const breakdown = calculateFeeBreakdown(c, ep, xp, exitType, ROBINHOOD_FEES);

    const trade: Trade = {
      id: `manual-${Date.now()}`,
      timestamp: new Date(),
      strategy,
      direction: 'yes',
      strike: s,
      entryPrice: ep,
      exitPrice: xp,
      exitType,
      contracts: c,
      grossCost: breakdown.grossCost,
      entryFee: breakdown.entryFee,
      totalCost: breakdown.totalCost,
      grossRevenue: breakdown.grossRevenue,
      exitFee: breakdown.exitFee,
      netRevenue: breakdown.netRevenue,
      netPnL: breakdown.netPnL,
      btcPriceAtEntry: btcPrice,
      btcPriceAtExit: btcPrice,
      won: breakdown.netPnL > 0,
    };

    onLogTrade?.(trade);
    setShowForm(false);
    setStrike('');
    setEntryPrice('0.60');
    setExitPrice('1.00');
    setContracts('16');
    setExitType('settlement');
  };

  // Preview P&L
  const previewEp = parseFloat(entryPrice) || 0;
  const previewXp = parseFloat(exitPrice) || 0;
  const previewC = parseInt(contracts) || 0;
  const preview = previewC > 0 && previewEp > 0
    ? calculateFeeBreakdown(previewC, previewEp, previewXp, exitType, ROBINHOOD_FEES)
    : null;

  return (
    <div className="terminal-panel">
      <div className="terminal-header">RECENT TRADES (NET P&L AFTER FEES)</div>

      {trades.length === 0 ? (
        <div className="text-terminal-muted text-[11px] py-2">
          No trades logged today
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-terminal-muted text-left">
                <th className="pb-1 pr-3">TIME</th>
                <th className="pb-1 pr-3">STRAT</th>
                <th className="pb-1 pr-3">STRIKE</th>
                <th className="pb-1 pr-3">ENTRY</th>
                <th className="pb-1 pr-3">EXIT</th>
                <th className="pb-1 pr-3">CNTR</th>
                <th className="pb-1 pr-3">FEE</th>
                <th className="pb-1 pr-1">P&L</th>
              </tr>
            </thead>
            <tbody>
              {trades
                .slice()
                .reverse()
                .map((trade) => {
                  const time = new Date(trade.timestamp).toLocaleTimeString(
                    'en-US',
                    {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    }
                  );
                  const totalFee = trade.entryFee + trade.exitFee;

                  return (
                    <tr key={trade.id} className="border-t border-terminal-border/50">
                      <td className="py-1 pr-3 text-terminal-muted">{time}</td>
                      <td className="py-1 pr-3">
                        {trade.strategy === 'conservative' ? 'CONS' : trade.strategy === 'aggressive' ? 'AGG' : '15M'}
                      </td>
                      <td className="py-1 pr-3">
                        {trade.strike ? trade.strike.toLocaleString() : 'N/A'}
                      </td>
                      <td className="py-1 pr-3">
                        {trade.entryPrice.toFixed(2)}
                      </td>
                      <td className="py-1 pr-3">
                        {trade.exitPrice.toFixed(2)}
                      </td>
                      <td className="py-1 pr-3">{trade.contracts}</td>
                      <td className="py-1 pr-3 text-terminal-red">
                        {totalFee.toFixed(2)}
                      </td>
                      <td
                        className={`py-1 pr-1 data-value ${trade.won ? 'text-terminal-green' : 'text-terminal-red'}`}
                      >
                        {trade.netPnL >= 0 ? '+' : ''}
                        {trade.netPnL.toFixed(2)}{' '}
                        {trade.won ? '\u2713' : '\u2717'}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex justify-between items-center mt-2 pt-2 border-t border-terminal-border">
        <div className="text-[11px] text-terminal-muted">
          TOTAL FEES:{' '}
          <span className="text-terminal-red">${totalFees.toFixed(2)}</span>
        </div>
        <div className="flex gap-2">
          {onLogTrade && (
            <button
              onClick={() => setShowForm(!showForm)}
              className={`border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors ${
                showForm
                  ? 'border-terminal-yellow text-terminal-yellow'
                  : 'border-terminal-green text-terminal-green hover:border-terminal-green'
              }`}
            >
              {showForm ? 'CANCEL' : 'LOG TRADE'}
            </button>
          )}
          {trades.length > 0 && (
            <button
              onClick={handleExport}
              className="border border-terminal-border text-terminal-muted px-2 py-0.5 text-[10px] uppercase tracking-wider hover:border-terminal-cyan hover:text-terminal-cyan transition-colors"
            >
              EXPORT CSV
            </button>
          )}
        </div>
      </div>

      {/* Manual Trade Log Form */}
      {showForm && onLogTrade && (
        <div className="mt-2 pt-2 border-t border-terminal-border space-y-2">
          <div className="data-label text-[10px] text-terminal-cyan">LOG COMPLETED TRADE:</div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-[11px]">
            {/* Strategy */}
            <div>
              <div className="text-terminal-muted text-[10px] mb-0.5">STRATEGY</div>
              <div className="flex gap-1">
                <button
                  onClick={() => setStrategy('conservative')}
                  className={`px-2 py-0.5 text-[10px] border ${
                    strategy === 'conservative'
                      ? 'border-terminal-cyan text-terminal-cyan'
                      : 'border-terminal-border text-terminal-muted'
                  }`}
                >
                  CONS
                </button>
                <button
                  onClick={() => setStrategy('aggressive')}
                  className={`px-2 py-0.5 text-[10px] border ${
                    strategy === 'aggressive'
                      ? 'border-terminal-cyan text-terminal-cyan'
                      : 'border-terminal-border text-terminal-muted'
                  }`}
                >
                  AGG
                </button>
              </div>
            </div>

            {/* Strike */}
            <div>
              <div className="text-terminal-muted text-[10px] mb-0.5">STRIKE</div>
              <input
                type="number"
                step="250"
                value={strike}
                placeholder={String(Math.round(btcPrice / 250) * 250)}
                onChange={(e) => setStrike(e.target.value)}
                className="bg-terminal-bg border border-terminal-border text-terminal-text px-2 py-0.5 text-[11px] w-full font-mono focus:border-terminal-cyan outline-none"
              />
            </div>

            {/* Entry Price */}
            <div>
              <div className="text-terminal-muted text-[10px] mb-0.5">ENTRY (c)</div>
              <input
                type="number"
                step="0.01"
                min="0.01"
                max="0.99"
                value={entryPrice}
                onChange={(e) => setEntryPrice(e.target.value)}
                className="bg-terminal-bg border border-terminal-border text-terminal-text px-2 py-0.5 text-[11px] w-full font-mono focus:border-terminal-cyan outline-none"
              />
            </div>

            {/* Exit Price */}
            <div>
              <div className="text-terminal-muted text-[10px] mb-0.5">EXIT (c)</div>
              <input
                type="number"
                step="0.01"
                min="0.00"
                max="1.00"
                value={exitPrice}
                onChange={(e) => setExitPrice(e.target.value)}
                className="bg-terminal-bg border border-terminal-border text-terminal-text px-2 py-0.5 text-[11px] w-full font-mono focus:border-terminal-cyan outline-none"
              />
            </div>

            {/* Contracts */}
            <div>
              <div className="text-terminal-muted text-[10px] mb-0.5">CONTRACTS</div>
              <input
                type="number"
                min="1"
                max="999"
                value={contracts}
                onChange={(e) => setContracts(e.target.value)}
                className="bg-terminal-bg border border-terminal-border text-terminal-text px-2 py-0.5 text-[11px] w-full font-mono focus:border-terminal-cyan outline-none"
              />
            </div>

            {/* Exit Type */}
            <div>
              <div className="text-terminal-muted text-[10px] mb-0.5">EXIT TYPE</div>
              <div className="flex gap-1">
                <button
                  onClick={() => setExitType('settlement')}
                  className={`px-2 py-0.5 text-[10px] border ${
                    exitType === 'settlement'
                      ? 'border-terminal-cyan text-terminal-cyan'
                      : 'border-terminal-border text-terminal-muted'
                  }`}
                >
                  SETTLE
                </button>
                <button
                  onClick={() => setExitType('early')}
                  className={`px-2 py-0.5 text-[10px] border ${
                    exitType === 'early'
                      ? 'border-terminal-cyan text-terminal-cyan'
                      : 'border-terminal-border text-terminal-muted'
                  }`}
                >
                  EARLY
                </button>
              </div>
            </div>
          </div>

          {/* Preview & Submit */}
          <div className="flex items-center justify-between pt-1">
            {preview && (
              <span className="text-[11px]">
                <span className="text-terminal-muted">P&L: </span>
                <span className={preview.netPnL >= 0 ? 'text-terminal-green' : 'text-terminal-red'}>
                  {preview.netPnL >= 0 ? '+' : ''}${preview.netPnL.toFixed(2)}
                </span>
                <span className="text-terminal-muted ml-2">
                  (fee: ${(preview.entryFee + preview.exitFee).toFixed(2)})
                </span>
              </span>
            )}
            <button
              onClick={handleLogTrade}
              className="bg-terminal-green/20 border border-terminal-green text-terminal-green px-3 py-0.5 text-[10px] uppercase tracking-wider hover:bg-terminal-green/30 transition-colors"
            >
              SUBMIT
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
