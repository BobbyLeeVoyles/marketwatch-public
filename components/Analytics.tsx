'use client';

import { useState, useEffect } from 'react';

interface SignalStat {
  signal: string;
  count: number;
  wins: number;
  winRate: number;
  avgPnL: number;
  totalPnL: number;
}

interface DirectionStat {
  direction: string;
  count: number;
  winRate: number;
  avgPnL: number;
}

interface HourStat {
  hour: number;
  count: number;
  winRate: number;
  avgPnL: number;
}

interface ExitTypeStat {
  exitType: string;
  count: number;
  winRate: number;
  avgPnL: number;
}

interface AnalyticsData {
  bySignal: SignalStat[];
  byBtcDirection: DirectionStat[];
  byHour: HourStat[];
  byExitType: ExitTypeStat[];
  btcDirectionMethod: string;
}

function fmt(n: number, decimals = 2): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toFixed(decimals)}`;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export default function Analytics() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/analytics');
        if (!res.ok) throw new Error('API error');
        const json = await res.json();
        setData(json);
        setError(null);
      } catch {
        setError('Failed to load analytics');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="terminal-panel">
        <div className="terminal-header">TRADE ANALYTICS</div>
        <div className="text-terminal-muted text-[11px] py-2">Loading...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="terminal-panel">
        <div className="terminal-header">TRADE ANALYTICS</div>
        <div className="text-terminal-yellow text-[11px] py-2">{error ?? 'No data'}</div>
      </div>
    );
  }

  const totalTrades = data.bySignal.reduce((sum, s) => sum + s.count, 0);
  if (totalTrades === 0) {
    return (
      <div className="terminal-panel">
        <div className="terminal-header">TRADE ANALYTICS</div>
        <div className="text-terminal-muted text-[11px] py-2">No trade data yet.</div>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-header">TRADE ANALYTICS</div>

      {/* Panel A — Signal Performance */}
      <div className="mb-4">
        <div className="text-terminal-cyan text-[10px] uppercase mb-1">Signal Performance</div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="text-terminal-muted border-b border-terminal-border">
                <th className="text-left py-1 pr-3">Signal</th>
                <th className="text-right pr-3">Trades</th>
                <th className="text-right pr-3">Win Rate</th>
                <th className="text-right pr-3">Avg P&L</th>
                <th className="text-right">Total P&L</th>
              </tr>
            </thead>
            <tbody>
              {data.bySignal.map((s) => {
                const isGood = s.winRate > 0.5 && s.avgPnL > 0;
                const color = isGood ? 'text-terminal-green' : 'text-terminal-red';
                return (
                  <tr key={s.signal} className={`${color} border-b border-terminal-border border-opacity-30`}>
                    <td className="py-0.5 pr-3 text-terminal-text">{s.signal}</td>
                    <td className="text-right pr-3">{s.count}</td>
                    <td className={`text-right pr-3 ${color}`}>{pct(s.winRate)}</td>
                    <td className={`text-right pr-3 ${s.avgPnL >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                      {fmt(s.avgPnL)}
                    </td>
                    <td className={`text-right ${s.totalPnL >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                      {fmt(s.totalPnL)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Panel B — BTC Direction */}
        <div>
          <div className="text-terminal-cyan text-[10px] uppercase mb-1">BTC Direction at Entry</div>
          {data.byBtcDirection.length === 0 ? (
            <div className="text-terminal-muted text-[11px]">Waiting for btc-log data...</div>
          ) : (
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="text-terminal-muted border-b border-terminal-border">
                  <th className="text-left py-1 pr-3">Direction</th>
                  <th className="text-right pr-3">Trades</th>
                  <th className="text-right pr-3">Win Rate</th>
                  <th className="text-right">Avg P&L</th>
                </tr>
              </thead>
              <tbody>
                {data.byBtcDirection.map((d) => (
                  <tr key={d.direction} className="border-b border-terminal-border border-opacity-30">
                    <td className="py-0.5 pr-3 text-terminal-text capitalize">{d.direction}</td>
                    <td className="text-right pr-3 text-terminal-muted">{d.count}</td>
                    <td className={`text-right pr-3 ${d.winRate > 0.5 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                      {pct(d.winRate)}
                    </td>
                    <td className={`text-right ${d.avgPnL >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                      {fmt(d.avgPnL)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.byBtcDirection.length === 0 && (
            <div className="text-terminal-muted text-[9px] mt-1">{data.btcDirectionMethod}</div>
          )}
        </div>

        {/* Panel C — Hour of Day */}
        <div>
          <div className="text-terminal-cyan text-[10px] uppercase mb-1">Hour of Day (UTC, ≥3 trades)</div>
          {data.byHour.filter(h => h.count >= 3).length === 0 ? (
            <div className="text-terminal-muted text-[11px]">Not enough data yet.</div>
          ) : (
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="text-terminal-muted border-b border-terminal-border">
                  <th className="text-left py-1 pr-3">Hour (UTC)</th>
                  <th className="text-right pr-3">Trades</th>
                  <th className="text-right pr-3">Win Rate</th>
                  <th className="text-right">Avg P&L</th>
                </tr>
              </thead>
              <tbody>
                {data.byHour
                  .filter(h => h.count >= 3)
                  .sort((a, b) => b.winRate - a.winRate)
                  .map((h) => (
                    <tr key={h.hour} className="border-b border-terminal-border border-opacity-30">
                      <td className="py-0.5 pr-3 text-terminal-text">
                        {String(h.hour).padStart(2, '0')}:00
                      </td>
                      <td className="text-right pr-3 text-terminal-muted">{h.count}</td>
                      <td className={`text-right pr-3 ${h.winRate > 0.5 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                        {pct(h.winRate)}
                      </td>
                      <td className={`text-right ${h.avgPnL >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                        {fmt(h.avgPnL)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Panel D — Exit Type */}
      {data.byExitType.length > 0 && (
        <div className="mt-4">
          <div className="text-terminal-cyan text-[10px] uppercase mb-1">By Exit Type</div>
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="text-terminal-muted border-b border-terminal-border">
                <th className="text-left py-1 pr-3">Exit Type</th>
                <th className="text-right pr-3">Trades</th>
                <th className="text-right pr-3">Win Rate</th>
                <th className="text-right">Avg P&L</th>
              </tr>
            </thead>
            <tbody>
              {data.byExitType.map((e) => (
                <tr key={e.exitType} className="border-b border-terminal-border border-opacity-30">
                  <td className="py-0.5 pr-3 text-terminal-text capitalize">{e.exitType}</td>
                  <td className="text-right pr-3 text-terminal-muted">{e.count}</td>
                  <td className={`text-right pr-3 ${e.winRate > 0.5 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                    {pct(e.winRate)}
                  </td>
                  <td className={`text-right ${e.avgPnL >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                    {fmt(e.avgPnL)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
