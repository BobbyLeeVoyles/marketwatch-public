'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { BTCData, Trade, DailyPerformance, EngineSignal, EnginePosition, WeeklyDataPoint } from '@/lib/types';
import { useBinancePrice } from '@/lib/utils/binanceWs';
import {
  isNotificationsSupported,
  isNotificationsEnabled,
  requestNotificationPermission,
  disableNotifications,
  registerServiceWorker,
} from '@/lib/utils/notifications';
import DailyPnL from './DailyPnL';
import TradeHistory from './TradeHistory';
import BotControls from './BotControls';
import Analytics from './Analytics';

const PerformanceChart = dynamic(() => import('./PerformanceChart'), {
  ssr: false,
  loading: () => (
    <div className="terminal-panel">
      <div className="terminal-header">STRATEGY PERFORMANCE (7D)</div>
      <div className="text-terminal-muted text-[11px] py-4 text-center">Loading chart...</div>
    </div>
  ),
});

interface BotPosition {
  ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  entryPrice: number;
  totalCost: number;
  entryTime: string;
  btcPriceAtEntry: number;
  strike?: number;
}

interface BotStatusData {
  running: boolean;
  dailyPnL: number;
  tradesCount: number;
  lastError?: string;
  hasPosition: boolean;
  position: BotPosition | null;
  currentCapital: number;
}

function createEmptyDay(): DailyPerformance {
  return {
    date: new Date().toISOString().split('T')[0],
    startingCapital: 0,
    trades: [],
    conservativeReturn: 0,
    aggressiveReturn: 0,
    fifteenMinReturn: 0,
    totalReturn: 0,
    totalFeesPaid: 0,
    netReturn: 0,
  };
}

export default function Dashboard() {
  const [btcData, setBtcData] = useState<BTCData | null>(null);
  const [daily, setDaily] = useState<DailyPerformance>(createEmptyDay);
  const [tradeHistory, setTradeHistory] = useState<Record<string, DailyPerformance>>({});
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const [notifEnabled, setNotifEnabled] = useState(() => isNotificationsEnabled());
  const [engineSignal, setEngineSignal] = useState<EngineSignal | null>(null);
  const [enginePosition, setEnginePosition] = useState<EnginePosition | null>(null);

  // Live bot positions from server
  const [botPositions, setBotPositions] = useState<Record<string, BotPosition | null>>({});
  const [botCapitals, setBotCapitals] = useState<Record<string, number>>({});

  const { price: wsPrice, connected: wsConnected } = useBinancePrice();

  // Fetch full BTC data from API (historical + indicators)
  const fetchBTCData = useCallback(async () => {
    try {
      const res = await fetch('/api/btc-data');
      if (!res.ok) throw new Error('API error');
      const data = await res.json();
      setBtcData({
        ...data,
        timestamp: new Date(data.timestamp),
        hourlyData: data.hourlyData.map((c: Record<string, unknown>) => ({
          ...c,
          timestamp: new Date(c.timestamp as string),
        })),
      });
      setLastUpdate(new Date());
      setError(null);
    } catch (err) {
      setError('Failed to fetch BTC data - retrying...');
    }
  }, []);

  // Register service worker for PWA + notifications
  useEffect(() => {
    registerServiceWorker();
  }, []);

  // Initial fetch + 60s polling for historical data
  useEffect(() => {
    fetchBTCData();
    const interval = setInterval(fetchBTCData, 60000);
    return () => clearInterval(interval);
  }, [fetchBTCData]);

  // Poll engine status every 5 seconds
  useEffect(() => {
    const fetchEngineStatus = async () => {
      try {
        const res = await fetch('/api/signal');
        if (res.ok) {
          const data = await res.json();
          if (data.signal) setEngineSignal(data.signal);
          if (data.position) setEnginePosition(data.position);
        }
      } catch {
        // Engine not running or API not available
      }
    };
    fetchEngineStatus();
    const interval = setInterval(fetchEngineStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  // Poll bot status for active positions every 5 seconds
  useEffect(() => {
    const fetchBotStatus = async () => {
      try {
        const res = await fetch('/api/bot/status');
        if (!res.ok) return;
        const data = await res.json();
        const positions: Record<string, BotPosition | null> = {};
        const capitals: Record<string, number> = {};
        for (const bot of ['conservative', 'aggressive', 'fifteenMin'] as const) {
          if (data[bot]) {
            positions[bot] = data[bot].position || null;
            capitals[bot] = data[bot].currentCapital || 0;
          }
        }
        setBotPositions(positions);
        setBotCapitals(capitals);
      } catch {
        // API not available
      }
    };
    fetchBotStatus();
    const interval = setInterval(fetchBotStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  // Fetch trades from server every 10 seconds (sole source of trade data)
  useEffect(() => {
    const fetchTrades = async () => {
      try {
        const res = await fetch('/api/trades');
        if (!res.ok) return;
        const data = await res.json();
        if (data?.daily) {
          setDaily(data.daily);
        }
        if (data?.history) {
          setTradeHistory(data.history);
        }
      } catch {
        // API not available
      }
    };
    fetchTrades();
    const interval = setInterval(fetchTrades, 10000);
    return () => clearInterval(interval);
  }, []);

  // Use WebSocket price if available, otherwise fall back to API price
  const currentPrice = wsPrice ?? btcData?.price ?? 0;

  // Compute weekly data from server trade history
  const weeklyData = useMemo<WeeklyDataPoint[]>(() => {
    const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const points: WeeklyDataPoint[] = [];

    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const dayName = dayNames[d.getDay()];

      if (i === 0) {
        points.push({
          day: dayName,
          date: dateStr,
          conservative: daily.startingCapital + daily.conservativeReturn,
          aggressive: daily.startingCapital + daily.aggressiveReturn,
          algo: daily.startingCapital + daily.conservativeReturn + daily.aggressiveReturn + (daily.fifteenMinReturn || 0),
          ai: daily.startingCapital + (daily.grok15minReturn || 0) + (daily.grokHourlyReturn || 0),
        });
      } else if (tradeHistory[dateStr]) {
        const h = tradeHistory[dateStr];
        points.push({
          day: dayName,
          date: dateStr,
          conservative: h.startingCapital + h.conservativeReturn,
          aggressive: h.startingCapital + h.aggressiveReturn,
          algo: h.startingCapital + h.conservativeReturn + h.aggressiveReturn + (h.fifteenMinReturn || 0),
          ai: h.startingCapital + (h.grok15minReturn || 0) + (h.grokHourlyReturn || 0),
        });
      } else {
        points.push({ day: dayName, date: dateStr, conservative: 100, aggressive: 100, algo: 100, ai: 100 });
      }
    }
    return points;
  }, [daily, tradeHistory]);

  // Compute lifetime stats from server trade history + today
  const lifetime = useMemo(() => {
    let conReturn = daily.conservativeReturn;
    let conTrades = 0;
    let conWins = 0;
    let aggReturn = daily.aggressiveReturn;
    let aggTrades = 0;
    let aggWins = 0;
    let fifReturn = daily.fifteenMinReturn;
    let fifTrades = 0;
    let fifWins = 0;
    let grok15Return = daily.grok15minReturn || 0;
    let grok15Trades = 0;
    let grok15Wins = 0;
    let grokHrReturn = daily.grokHourlyReturn || 0;
    let grokHrTrades = 0;
    let grokHrWins = 0;

    // Count today's trades
    for (const t of daily.trades) {
      if (t.strategy === 'conservative') { conTrades++; if (t.won) conWins++; }
      else if (t.strategy === 'aggressive') { aggTrades++; if (t.won) aggWins++; }
      else if (t.strategy === 'fifteenMin') { fifTrades++; if (t.won) fifWins++; }
      else if (t.strategy === 'grok15min') { grok15Trades++; if (t.won) grok15Wins++; }
      else if (t.strategy === 'grokHourly') { grokHrTrades++; if (t.won) grokHrWins++; }
    }

    // Add history
    for (const day of Object.values(tradeHistory)) {
      conReturn += day.conservativeReturn;
      aggReturn += day.aggressiveReturn;
      fifReturn += day.fifteenMinReturn || 0;
      grok15Return += day.grok15minReturn || 0;
      grokHrReturn += day.grokHourlyReturn || 0;
      for (const t of day.trades) {
        if (t.strategy === 'conservative') { conTrades++; if (t.won) conWins++; }
        else if (t.strategy === 'aggressive') { aggTrades++; if (t.won) aggWins++; }
        else if (t.strategy === 'fifteenMin') { fifTrades++; if (t.won) fifWins++; }
        else if (t.strategy === 'grok15min') { grok15Trades++; if (t.won) grok15Wins++; }
        else if (t.strategy === 'grokHourly') { grokHrTrades++; if (t.won) grokHrWins++; }
      }
    }

    return {
      conservative: { return: conReturn, trades: conTrades, wins: conWins },
      aggressive: { return: aggReturn, trades: aggTrades, wins: aggWins },
      fifteenMin: { return: fifReturn, trades: fifTrades, wins: fifWins },
      grok15min: { return: grok15Return, trades: grok15Trades, wins: grok15Wins },
      grokHourly: { return: grokHrReturn, trades: grokHrTrades, wins: grokHrWins },
    };
  }, [daily, tradeHistory]);

  // Settlement countdown
  const [settleCountdown, setSettleCountdown] = useState('--:--');
  useEffect(() => {
    const update = () => {
      const now = new Date();
      const mins = 59 - now.getMinutes();
      const secs = 59 - now.getSeconds();
      setSettleCountdown(`${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  // Total Kalshi balance across bots
  const totalBalance = Object.values(botCapitals).reduce((max, v) => Math.max(max, v), 0);

  // Collect active bot positions for display
  const activePositions = Object.entries(botPositions)
    .filter(([, pos]) => pos !== null)
    .map(([bot, pos]) => ({ bot, ...pos! }));

  return (
    <div className="min-h-screen p-2 md:p-4 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="terminal-panel mb-2 flex flex-wrap justify-between items-center gap-2">
        <div className="flex items-center gap-3">
          <span className="text-[14px] font-bold uppercase tracking-wider text-terminal-cyan">
            BTC PREDICTION TERMINAL
          </span>
          <span
            className={`text-[10px] px-1 border ${
              wsConnected
                ? 'border-terminal-green text-terminal-green'
                : 'border-terminal-yellow text-terminal-yellow'
            }`}
          >
            {wsConnected ? 'LIVE' : 'POLLING'}
          </span>
          <span className="text-[10px] px-1 border border-terminal-green text-terminal-green">
            KALSHI LIVE
          </span>
          <button
            onClick={async () => {
              if (!isNotificationsSupported()) {
                alert('Notifications require adding this app to your home screen first (PWA).');
                return;
              }
              if (notifEnabled) {
                disableNotifications();
                setNotifEnabled(false);
              } else {
                const granted = await requestNotificationPermission();
                setNotifEnabled(granted);
                if (!granted) {
                  alert('Notifications were blocked. Check your browser settings to allow notifications for this site.');
                }
              }
            }}
            className={`text-[10px] px-1 border cursor-pointer transition-colors ${
              notifEnabled
                ? 'border-terminal-green text-terminal-green'
                : 'border-terminal-border text-terminal-muted hover:border-terminal-yellow hover:text-terminal-yellow'
            }`}
          >
            {notifEnabled ? 'NOTIF ON' : 'NOTIF OFF'}
          </button>
        </div>
        <div className="flex items-center gap-4">
          {totalBalance > 0 && (
            <span className="text-[12px]">
              <span className="text-terminal-muted">KALSHI BAL: </span>
              <span className="text-terminal-green" suppressHydrationWarning>
                ${totalBalance.toFixed(2)}
              </span>
            </span>
          )}
          <span className="text-[12px]">
            <span className="text-terminal-muted">CON: </span>
            <span className={lifetime.conservative.return >= 0 ? 'text-terminal-green' : 'text-terminal-red'} suppressHydrationWarning>
              {lifetime.conservative.return >= 0 ? '+' : '-'}${Math.abs(lifetime.conservative.return).toFixed(2)}
            </span>
            <span className="text-terminal-muted text-[10px] ml-0.5" suppressHydrationWarning>
              ({lifetime.conservative.trades > 0 ? Math.round((lifetime.conservative.wins / lifetime.conservative.trades) * 100) : 0}%W)
            </span>
          </span>
          <span className="text-[12px]">
            <span className="text-terminal-muted">AGG: </span>
            <span className={lifetime.aggressive.return >= 0 ? 'text-terminal-green' : 'text-terminal-red'} suppressHydrationWarning>
              {lifetime.aggressive.return >= 0 ? '+' : '-'}${Math.abs(lifetime.aggressive.return).toFixed(2)}
            </span>
            <span className="text-terminal-muted text-[10px] ml-0.5" suppressHydrationWarning>
              ({lifetime.aggressive.trades > 0 ? Math.round((lifetime.aggressive.wins / lifetime.aggressive.trades) * 100) : 0}%W)
            </span>
          </span>
          <span className="text-[12px]">
            <span className="text-terminal-muted">15M: </span>
            <span className={lifetime.fifteenMin.return >= 0 ? 'text-terminal-green' : 'text-terminal-red'} suppressHydrationWarning>
              {lifetime.fifteenMin.return >= 0 ? '+' : '-'}${Math.abs(lifetime.fifteenMin.return).toFixed(2)}
            </span>
            <span className="text-terminal-muted text-[10px] ml-0.5" suppressHydrationWarning>
              ({lifetime.fifteenMin.trades > 0 ? Math.round((lifetime.fifteenMin.wins / lifetime.fifteenMin.trades) * 100) : 0}%W)
            </span>
          </span>
          <span className="text-[12px]">
            <span className="text-terminal-muted">G15: </span>
            <span className={lifetime.grok15min.return >= 0 ? 'text-terminal-green' : 'text-terminal-red'} suppressHydrationWarning>
              {lifetime.grok15min.return >= 0 ? '+' : '-'}${Math.abs(lifetime.grok15min.return).toFixed(2)}
            </span>
            <span className="text-terminal-muted text-[10px] ml-0.5" suppressHydrationWarning>
              ({lifetime.grok15min.trades > 0 ? Math.round((lifetime.grok15min.wins / lifetime.grok15min.trades) * 100) : 0}%W)
            </span>
          </span>
          <span className="text-[12px]">
            <span className="text-terminal-muted">GHR: </span>
            <span className={lifetime.grokHourly.return >= 0 ? 'text-terminal-green' : 'text-terminal-red'} suppressHydrationWarning>
              {lifetime.grokHourly.return >= 0 ? '+' : '-'}${Math.abs(lifetime.grokHourly.return).toFixed(2)}
            </span>
            <span className="text-terminal-muted text-[10px] ml-0.5" suppressHydrationWarning>
              ({lifetime.grokHourly.trades > 0 ? Math.round((lifetime.grokHourly.wins / lifetime.grokHourly.trades) * 100) : 0}%W)
            </span>
          </span>
          <span className="text-terminal-muted text-[12px] uppercase">
            {dateStr} {timeStr}
          </span>
        </div>
      </div>

      {error && (
        <div className="terminal-panel mb-2 border-terminal-yellow text-terminal-yellow text-[11px]">
          {error}
        </div>
      )}

      {/* Top Row: BTC Price + Daily P&L */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-2">
        {/* BTC Price Panel */}
        <div className="terminal-panel">
          <div className="terminal-header">BTC/USD</div>
          <div className="text-[24px] font-bold text-terminal-text">
            {currentPrice > 0
              ? currentPrice.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })
              : '---'}
          </div>
          {btcData && btcData.hourlyData.length > 0 && (
            <div className="flex gap-4 text-[11px] mt-1">
              <div>
                <span className="text-terminal-muted">H: </span>
                <span>
                  {Math.max(...btcData.hourlyData.map((c) => c.high)).toLocaleString()}
                </span>
              </div>
              <div>
                <span className="text-terminal-muted">L: </span>
                <span>
                  {Math.min(...btcData.hourlyData.map((c) => c.low)).toLocaleString()}
                </span>
              </div>
              <div>
                <span className="text-terminal-muted">VOL: </span>
                <span>{btcData.indicators.volatility.toFixed(1)}%</span>
              </div>
              <div>
                <span className="text-terminal-muted">SETTLE: </span>
                <span className="text-terminal-cyan">{settleCountdown}</span>
              </div>
            </div>
          )}
        </div>

        <DailyPnL daily={daily} />
      </div>

      {/* Bot Controls */}
      <div className="mb-2">
        <BotControls />
      </div>

      {/* Active Kalshi Positions */}
      {activePositions.length > 0 && activePositions.map(({ bot, ticker, side, contracts, entryPrice, totalCost, entryTime, btcPriceAtEntry, strike }) => (
        <div key={bot} className="mb-2">
          <div className="terminal-panel">
            <div className="terminal-header">
              ACTIVE POSITION - {bot === 'fifteenMin' ? '15-MIN BOT' : `${bot.toUpperCase()} BOT`}
              <span className="ml-2 text-terminal-green text-[9px]">[KALSHI LIVE]</span>
            </div>
            <div className="space-y-1 text-[11px]">
              <div>
                <span className="text-terminal-muted">TICKER: </span>
                <span className="text-terminal-cyan">{ticker}</span>
              </div>
              <div>
                <span className="text-terminal-muted">ENTRY: </span>
                <span className="text-terminal-text">
                  {side.toUpperCase()} at {(entryPrice * 100).toFixed(0)}c
                  ({contracts} contracts) - COST: ${totalCost.toFixed(2)}
                </span>
              </div>
              <div>
                <span className="text-terminal-muted">BTC AT ENTRY: </span>
                <span className="text-terminal-text">
                  ${btcPriceAtEntry.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </span>
                <span className="text-terminal-muted"> NOW: </span>
                <span className="data-value">
                  ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                {strike && (() => {
                  const dist = currentPrice - strike;
                  return (
                    <span className={`ml-2 ${dist > 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                      [{dist > 0 ? '+' : ''}{dist.toFixed(0)} {dist > 0 ? 'ITM' : 'OTM'}]
                    </span>
                  );
                })()}
              </div>
              <div className="text-terminal-muted text-[9px]">
                Entered: {new Date(entryTime).toLocaleTimeString()}
              </div>
            </div>
          </div>
        </div>
      ))}

      {/* Performance Chart */}
      <div className="mb-2">
        <PerformanceChart data={weeklyData} />
      </div>

      {/* Engine Status (shown when strategy engine is running) */}
      {engineSignal && (
        <div className="terminal-panel mb-2">
          <div className="terminal-header">
            ENGINE STATUS
            <span className={`ml-2 text-[9px] px-1 border ${
              engineSignal.command === 'BUY' || engineSignal.command === 'SELL'
                ? 'border-terminal-yellow text-terminal-yellow'
                : engineSignal.command === 'MONITOR'
                  ? 'border-terminal-green text-terminal-green'
                  : engineSignal.command === 'PREP'
                    ? 'border-terminal-cyan text-terminal-cyan'
                    : 'border-terminal-muted text-terminal-muted'
            }`}>
              {engineSignal.command}
            </span>
          </div>
          <div className="space-y-1 text-[11px]">
            <div>
              <span className="text-terminal-muted">BTC (engine): </span>
              <span className="data-value">
                ${engineSignal.btcPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '---'}
              </span>
              {engineSignal.criteriaMetCount !== undefined && (
                <span className="text-terminal-muted ml-3">
                  CRITERIA: <span className={engineSignal.criteriaMetCount >= 6 ? 'text-terminal-green' : engineSignal.criteriaMetCount >= 4 ? 'text-terminal-yellow' : 'text-terminal-muted'}>
                    {engineSignal.criteriaMetCount}/6
                  </span>
                </span>
              )}
            </div>
            {engineSignal.reason && (
              <div>
                <span className="text-terminal-muted">STATUS: </span>
                <span className="text-terminal-text">{engineSignal.reason}</span>
              </div>
            )}
            {engineSignal.command === 'BUY' && engineSignal.allocatePct && (
              <div>
                <span className="text-terminal-muted">ORDER: </span>
                <span className="text-terminal-yellow">
                  {engineSignal.allocatePct}% of balance | Max ${engineSignal.maxLimitPrice?.toFixed(2)}/contract |
                  Strike ${engineSignal.strike?.toLocaleString()}
                </span>
              </div>
            )}
            {enginePosition?.pending && (
              <div>
                <span className="text-terminal-muted">POSITION: </span>
                <span className="text-terminal-yellow">
                  PENDING BUY | Strike ${enginePosition.strike?.toLocaleString()} |
                  Waiting for fill confirmation
                </span>
              </div>
            )}
            {enginePosition?.active && !enginePosition?.pending && (
              <div>
                <span className="text-terminal-muted">POSITION: </span>
                <span className="text-terminal-cyan">
                  {enginePosition.contracts} contracts @ {((enginePosition.entryPrice ?? 0) * 100).toFixed(0)}c |
                  Strike ${enginePosition.strike?.toLocaleString()} |
                  Cost ${enginePosition.totalCost?.toFixed(2)}
                </span>
              </div>
            )}
            <div className="text-terminal-muted text-[9px]">
              Last update: {new Date(engineSignal.timestamp).toLocaleTimeString()}
            </div>
          </div>
        </div>
      )}

      {/* Trade History (from Kalshi trades only) */}
      <TradeHistory
        trades={daily.trades}
        totalFees={daily.totalFeesPaid}
        btcPrice={currentPrice}
      />

      {/* Analytics Panel */}
      <div className="mt-2">
        <Analytics />
      </div>
    </div>
  );
}
