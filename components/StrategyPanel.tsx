'use client';

import { Signal } from '@/lib/types';

interface StrategyPanelProps {
  signal: Signal;
  title: string;
  onLogTrade?: () => void;
}

export default function StrategyPanel({
  signal,
  title,
  onLogTrade,
}: StrategyPanelProps) {
  return (
    <div className="terminal-panel">
      <div className="terminal-header">{title}</div>

      <div className="mb-2">
        <span className="data-label">STATUS: </span>
        <span
          className={`data-value ${signal.active ? 'text-terminal-green' : 'text-terminal-muted'}`}
        >
          {signal.active ? 'ACTIVE' : 'NO SIGNAL'}
        </span>
      </div>

      <div className="space-y-1 mb-3">
        <div className="data-label">INDICATORS:</div>
        {signal.criteriaChecks?.map((check, i) => (
          <div key={i} className="flex items-center gap-2 text-[11px]">
            <span
              className={
                check.passed ? 'text-terminal-green' : 'text-terminal-red'
              }
            >
              [{check.passed ? '\u2713' : '\u2717'}]
            </span>
            <span className="text-terminal-text">{check.label}</span>
            {check.value && (
              <span className="text-terminal-muted ml-auto">
                ({check.value})
              </span>
            )}
          </div>
        ))}
      </div>

      {signal.active ? (
        <div className="border border-terminal-border p-2">
          <div className="data-label mb-1">TRADE RECOMMENDATION</div>
          <div className="space-y-1 text-[11px]">
            <div>
              <span className="text-terminal-muted">CONTRACT: </span>
              <span className="data-value text-terminal-cyan">
                {(signal.direction ?? 'yes').toUpperCase()} ${signal.strike?.toLocaleString()}+
              </span>
            </div>
            <div>
              <span className="text-terminal-muted">FAIR VALUE: </span>
              <span className="data-value">
                {((signal.estimatedProbability ?? 0) * 100).toFixed(0)}&cent; ({((signal.estimatedProbability ?? 0) * 100).toFixed(0)}% prob)
              </span>
            </div>
            <div>
              <span className="text-terminal-muted">MAX ENTRY: </span>
              <span className="data-value text-terminal-green">
                &le;{((signal.maxEntryPrice ?? signal.entryPrice ?? 0) * 100).toFixed(0)}&cent;
              </span>
            </div>
            <div>
              <span className="text-terminal-muted">SIZE: </span>
              <span className="data-value">
                ${signal.positionSize} ({signal.contracts} contracts)
              </span>
            </div>
            <div>
              <span className="text-terminal-muted">IF WIN: </span>
              <span className="data-value text-terminal-green">
                +{(((1 - (signal.maxEntryPrice ?? signal.entryPrice ?? 0)) / (signal.maxEntryPrice ?? signal.entryPrice ?? 1)) * 100).toFixed(0)}% per contract (${signal.contracts} &times; $1 = ${signal.contracts?.toFixed(2)})
              </span>
            </div>
            <div>
              <span className="text-terminal-muted">EXIT: </span>
              <span className="text-terminal-text">{signal.exitStrategy}</span>
            </div>
          </div>

          <div className="mt-3">
            <span className="text-[10px] px-2 py-0.5 border border-terminal-cyan text-terminal-cyan">
              AUTO-EXECUTING
            </span>
          </div>
        </div>
      ) : (
        <div className="text-[11px]">
          {signal.failedCriteria && signal.failedCriteria.length > 0 && (
            <div className="text-terminal-muted mb-2">
              <span className="data-label">NEEDS: </span>
              {signal.failedCriteria.join(', ')}
            </div>
          )}
          {signal.strike && (
            <div className="border border-terminal-border border-dashed p-2 opacity-70">
              <div className="data-label mb-1 text-terminal-muted">IF SIGNAL FIRES:</div>
              <div className="space-y-1">
                <div>
                  <span className="text-terminal-muted">CONTRACT: </span>
                  <span className="data-value">
                    {(signal.direction ?? 'yes').toUpperCase()} ${signal.strike?.toLocaleString()}+
                  </span>
                </div>
                <div>
                  <span className="text-terminal-muted">FAIR VALUE: </span>
                  <span className="data-value">
                    {((signal.estimatedProbability ?? 0) * 100).toFixed(0)}&cent; ({((signal.estimatedProbability ?? 0) * 100).toFixed(0)}% prob)
                  </span>
                </div>
                <div>
                  <span className="text-terminal-muted">LIMIT BUY: </span>
                  <span className="data-value">
                    &le;{((signal.maxEntryPrice ?? signal.entryPrice ?? 0) * 100).toFixed(0)}&cent; | ${signal.positionSize} ({signal.contracts} contracts)
                  </span>
                </div>
                <div>
                  <span className="text-terminal-muted">IF WIN: </span>
                  <span className="data-value">
                    +{(((1 - (signal.maxEntryPrice ?? signal.entryPrice ?? 0)) / (signal.maxEntryPrice ?? signal.entryPrice ?? 1)) * 100).toFixed(0)}% (${signal.contracts} &times; $1 = ${signal.contracts?.toFixed(2)})
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
