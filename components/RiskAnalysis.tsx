'use client';

import { ExitAnalysis } from '@/lib/types';

interface RiskAnalysisProps {
  analysis: ExitAnalysis;
  earlyExitNet: number;
  holdWinAmount: number;
  holdLoseAmount: number;
  contracts: number;
  currentImpliedPrice: number;
  entryPrice: number;
}

const riskColors: Record<string, string> = {
  critical: 'text-terminal-red',
  high: 'text-terminal-yellow',
  medium: 'text-terminal-yellow',
  low: 'text-terminal-green',
  unknown: 'text-terminal-muted',
};

const riskBgColors: Record<string, string> = {
  critical: 'border-terminal-red',
  high: 'border-terminal-yellow',
  medium: 'border-terminal-yellow',
  low: 'border-terminal-green',
  unknown: 'border-terminal-border',
};

const riskIcons: Record<string, string> = {
  critical: '\u{1f534}',
  high: '\u26a0\ufe0f',
  medium: '\u{1f7e1}',
  low: '\u{1f7e2}',
  unknown: '\u2753',
};

export default function RiskAnalysis({
  analysis,
  earlyExitNet,
  holdWinAmount,
  holdLoseAmount,
  contracts,
  currentImpliedPrice,
  entryPrice,
}: RiskAnalysisProps) {
  const winProb = (1 - analysis.riskOfRuin) * 100;
  const loseProb = analysis.riskOfRuin * 100;
  const holdEV = analysis.expectedNetPnL;
  const delta = analysis.shouldExit
    ? earlyExitNet - holdEV
    : holdEV - earlyExitNet;

  const earlyExitRevenue = contracts * currentImpliedPrice;
  const earlyExitFee = earlyExitRevenue * 0.015;
  const earlyExitReturn = entryPrice > 0
    ? ((earlyExitNet / (contracts * entryPrice * 1.015)) * 100)
    : 0;

  return (
    <div className={`border ${riskBgColors[analysis.riskLevel]} p-3`}>
      <div
        className={`text-[12px] font-bold uppercase tracking-wider mb-2 ${riskColors[analysis.riskLevel]}`}
      >
        {riskIcons[analysis.riskLevel]} RISK ANALYSIS -{' '}
        {analysis.riskLevel.toUpperCase()} RISK
      </div>

      <div className="text-[11px] space-y-1 mb-3">
        <div className={riskColors[analysis.riskLevel]}>
          RISK OF RUIN: {loseProb.toFixed(0)}%
        </div>
      </div>

      {/* Exit Now Box */}
      <div className="border border-terminal-border p-2 mb-2">
        <div className="data-label mb-1">
          EXIT NOW ({(currentImpliedPrice * 100).toFixed(0)}&cent;):
        </div>
        <div className="text-[11px] space-y-0.5">
          <div className="flex justify-between">
            <span className="text-terminal-muted">Revenue:</span>
            <span>${earlyExitRevenue.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-terminal-muted">Exit Fee (1.5%):</span>
            <span className="text-terminal-red">${earlyExitFee.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-terminal-muted">Net P&L:</span>
            <span
              className={`data-value ${earlyExitNet >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}
            >
              {earlyExitNet >= 0 ? '+' : ''}${earlyExitNet.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-terminal-muted">Certainty:</span>
            <span>100%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-terminal-muted">Return:</span>
            <span>{earlyExitReturn >= 0 ? '+' : ''}{earlyExitReturn.toFixed(1)}%</span>
          </div>
        </div>
      </div>

      {/* Hold to Settlement Box */}
      <div className="border border-terminal-border p-2 mb-2">
        <div className="data-label mb-1">HOLD TO SETTLEMENT:</div>
        <div className="text-[11px] space-y-0.5">
          <div className="flex justify-between">
            <span className="text-terminal-muted">
              If Win ({winProb.toFixed(0)}%):
            </span>
            <span className="text-terminal-green">
              +${holdWinAmount.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-terminal-muted">
              If Lose ({loseProb.toFixed(0)}%):
            </span>
            <span className="text-terminal-red">
              {holdLoseAmount.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-terminal-muted">Expected Value:</span>
            <span
              className={`data-value ${holdEV >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}
            >
              {holdEV >= 0 ? '+' : ''}${holdEV.toFixed(2)}{' '}
              {holdEV >= 0 ? '\u2713' : '\u2717'}
            </span>
          </div>
        </div>
      </div>

      {/* Delta */}
      <div className="text-[11px] mb-2">
        <span className="text-terminal-muted">DELTA: </span>
        <span className="text-terminal-text">
          {analysis.shouldExit
            ? `Exit locks in $${delta.toFixed(2)} more than expected hold`
            : `Holding gains you $${delta.toFixed(2)} more`}
        </span>
      </div>

      {/* Recommendation */}
      <div
        className={`text-[12px] font-bold mb-1 ${riskColors[analysis.riskLevel]}`}
      >
        {analysis.shouldExit ? riskIcons[analysis.riskLevel] : '\u{1f7e2}'}{' '}
        RECOMMENDATION: {analysis.shouldExit ? 'EXIT NOW' : 'HOLD'}
      </div>
      <div className="text-[11px] text-terminal-muted">{analysis.reason}</div>
    </div>
  );
}
