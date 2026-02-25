'use client';

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { WeeklyDataPoint } from '@/lib/types';

interface PerformanceChartProps {
  data: WeeklyDataPoint[];
}

export default function PerformanceChart({ data }: PerformanceChartProps) {
  if (data.length === 0) {
    return (
      <div className="terminal-panel">
        <div className="terminal-header">STRATEGY PERFORMANCE (7D)</div>
        <div className="text-terminal-muted text-[11px] py-4 text-center">
          No performance data yet
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-header">STRATEGY PERFORMANCE (7D)</div>
      <div className="mt-2" style={{ width: '100%', height: 250 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 5, right: 5, left: -10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="1 1" stroke="#1e2540" />
            <XAxis
              dataKey="day"
              stroke="#8b92b8"
              style={{ fontSize: 10, fontFamily: 'JetBrains Mono' }}
              tick={{ fill: '#8b92b8' }}
            />
            <YAxis
              stroke="#8b92b8"
              style={{ fontSize: 10, fontFamily: 'JetBrains Mono' }}
              tick={{ fill: '#8b92b8' }}
              domain={[
                (dataMin: number) => Math.floor(Math.min(dataMin, 95)),
                (dataMax: number) => Math.ceil(Math.max(dataMax, 105)),
              ]}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#12162b',
                border: '1px solid #1e2540',
                fontFamily: 'JetBrains Mono',
                fontSize: 11,
                color: '#e0e6ff',
              }}
              formatter={(value, name) => {
                const v = typeof value === 'number' ? `$${value.toFixed(2)}` : '$0.00';
                const labels: Record<string, string> = {
                  conservative: 'Con (Algo)',
                  aggressive: 'Agg (Algo)',
                  algo: 'All Algo',
                  ai: 'AI Bots',
                };
                return [v, labels[name as string] ?? String(name)] as [string, string];
              }}
            />
            <ReferenceLine y={100} stroke="#ffaa00" strokeDasharray="3 3" />
            <Line
              type="monotone"
              dataKey="conservative"
              stroke="#00ff41"
              strokeWidth={2}
              dot={{ fill: '#00ff41', r: 4 }}
              activeDot={{ r: 6 }}
            />
            <Line
              type="monotone"
              dataKey="aggressive"
              stroke="#ff0044"
              strokeWidth={2}
              dot={{ fill: '#ff0044', r: 3, strokeWidth: 2 }}
              activeDot={{ r: 5 }}
            />
            <Line
              type="monotone"
              dataKey="algo"
              stroke="#4488ff"
              strokeWidth={2}
              dot={{ fill: '#4488ff', r: 3 }}
              activeDot={{ r: 5 }}
            />
            <Line
              type="monotone"
              dataKey="ai"
              stroke="#00ddff"
              strokeWidth={2}
              strokeDasharray="5 3"
              dot={{ fill: '#00ddff', r: 3 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap gap-4 mt-2 text-[10px]">
        <div className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-terminal-green" />
          <span className="text-terminal-muted">CON ALGO</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-terminal-red" />
          <span className="text-terminal-muted">AGG ALGO</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5" style={{ backgroundColor: '#4488ff' }} />
          <span className="text-terminal-muted">ALL ALGO</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5" style={{ backgroundColor: '#00ddff', borderTop: '2px dashed #00ddff', height: 0 }} />
          <span className="text-terminal-muted">AI BOTS</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-terminal-yellow opacity-50" />
          <span className="text-terminal-muted">$100 BASELINE</span>
        </div>
      </div>
    </div>
  );
}
