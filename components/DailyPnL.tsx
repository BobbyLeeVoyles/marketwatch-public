'use client';

import { DailyPerformance } from '@/lib/types';

interface DailyPnLProps {
  daily: DailyPerformance;
}

export default function DailyPnL({ daily }: DailyPnLProps) {
  const total = daily.conservativeReturn + daily.aggressiveReturn + (daily.fifteenMinReturn || 0)
    + (daily.grok15minReturn || 0) + (daily.grokHourlyReturn || 0);
  const totalPct = (total / daily.startingCapital) * 100;

  return (
    <div className="terminal-panel">
      <div className="terminal-header">DAILY P&L (NET OF FEES)</div>
      <div className="space-y-1">
        <div className="flex justify-between">
          <span className="data-label">START</span>
          <span className="data-value">${daily.startingCapital.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="data-label">CONSERVATIVE</span>
          <span
            className={`data-value ${daily.conservativeReturn >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}
          >
            {daily.conservativeReturn >= 0 ? '+' : ''}${daily.conservativeReturn.toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="data-label">AGGRESSIVE</span>
          <span
            className={`data-value ${daily.aggressiveReturn >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}
          >
            {daily.aggressiveReturn >= 0 ? '+' : ''}${daily.aggressiveReturn.toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="data-label">15-MINUTE</span>
          <span
            className={`data-value ${(daily.fifteenMinReturn || 0) >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}
          >
            {(daily.fifteenMinReturn || 0) >= 0 ? '+' : ''}${(daily.fifteenMinReturn || 0).toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="data-label">GROK 15M</span>
          <span
            className={`data-value ${(daily.grok15minReturn || 0) >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}
          >
            {(daily.grok15minReturn || 0) >= 0 ? '+' : ''}${(daily.grok15minReturn || 0).toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="data-label">GROK HOURLY</span>
          <span
            className={`data-value ${(daily.grokHourlyReturn || 0) >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}
          >
            {(daily.grokHourlyReturn || 0) >= 0 ? '+' : ''}${(daily.grokHourlyReturn || 0).toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="data-label">FEES PAID</span>
          <span className="data-value text-terminal-red">
            -${daily.totalFeesPaid.toFixed(2)}
          </span>
        </div>
        <div className="border-t border-terminal-border my-1 pt-1">
          <div className="flex justify-between">
            <span className="data-label">NET TOTAL</span>
            <span
              className={`data-value ${total >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}
            >
              {total >= 0 ? '+' : ''}${total.toFixed(2)} ({totalPct >= 0 ? '+' : ''}
              {totalPct.toFixed(1)}%)
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
