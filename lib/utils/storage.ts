import { DailyPerformance, Trade, WeeklyDataPoint } from '@/lib/types';

const DAILY_KEY = 'btc-terminal-daily';
const HISTORY_KEY = 'btc-terminal-history';
const LIFETIME_KEY = 'btc-terminal-lifetime';
const MAX_HISTORY_DAYS = 30;

function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

function createNewDay(date: string): DailyPerformance {
  return {
    date,
    startingCapital: 100,
    trades: [],
    conservativeReturn: 0,
    aggressiveReturn: 0,
    fifteenMinReturn: 0,
    totalReturn: 0,
    totalFeesPaid: 0,
    netReturn: 0,
  };
}

export function getDailyData(): DailyPerformance {
  try {
    const today = getTodayDate();
    const stored = localStorage.getItem(DAILY_KEY);

    if (!stored) {
      return createNewDay(today);
    }

    const data: DailyPerformance = JSON.parse(stored);

    if (data.date !== today) {
      archiveDay(data);
      return createNewDay(today);
    }

    return data;
  } catch {
    return createNewDay(getTodayDate());
  }
}

export function saveDailyData(data: DailyPerformance): void {
  try {
    localStorage.setItem(DAILY_KEY, JSON.stringify(data));
  } catch {
    // localStorage not available or full
  }
}

export function addTrade(trade: Trade): DailyPerformance {
  const daily = getDailyData();
  daily.trades.push(trade);

  if (trade.strategy === 'conservative') {
    daily.conservativeReturn += trade.netPnL;
  } else {
    daily.aggressiveReturn += trade.netPnL;
  }

  daily.totalFeesPaid += trade.entryFee + trade.exitFee;
  daily.totalReturn = daily.conservativeReturn + daily.aggressiveReturn;
  daily.netReturn = daily.totalReturn;

  saveDailyData(daily);
  return daily;
}

function archiveDay(data: DailyPerformance): void {
  try {
    const stored = localStorage.getItem(HISTORY_KEY);
    const history: Record<string, DailyPerformance> = stored ? JSON.parse(stored) : {};

    history[data.date] = data;

    // Accumulate lifetime return (persists beyond 30-day history window)
    const lifetime = getLifetimeData();
    lifetime.totalReturn += data.totalReturn;
    lifetime.totalFees += data.totalFeesPaid;
    lifetime.totalTrades += data.trades.length;
    lifetime.totalWins += data.trades.filter((t) => t.won).length;
    lifetime.daysTracked += 1;

    const dayCon = strategyStatsFromTrades(data.trades, 'conservative');
    const dayAgg = strategyStatsFromTrades(data.trades, 'aggressive');
    lifetime.conservative.return += dayCon.return;
    lifetime.conservative.trades += dayCon.trades;
    lifetime.conservative.wins += dayCon.wins;
    lifetime.aggressive.return += dayAgg.return;
    lifetime.aggressive.trades += dayAgg.trades;
    lifetime.aggressive.wins += dayAgg.wins;

    localStorage.setItem(LIFETIME_KEY, JSON.stringify(lifetime));

    // Purge entries older than MAX_HISTORY_DAYS
    const dates = Object.keys(history).sort();
    while (dates.length > MAX_HISTORY_DAYS) {
      const oldest = dates.shift()!;
      delete history[oldest];
    }

    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // localStorage not available
  }
}

export interface StrategyStats {
  return: number;
  trades: number;
  wins: number;
}

export interface LifetimeStats {
  totalReturn: number;
  totalFees: number;
  totalTrades: number;
  totalWins: number;
  daysTracked: number;
  conservative: StrategyStats;
  aggressive: StrategyStats;
}

function emptyStrategyStats(): StrategyStats {
  return { return: 0, trades: 0, wins: 0 };
}

function getLifetimeData(): LifetimeStats {
  try {
    const stored = localStorage.getItem(LIFETIME_KEY);
    if (stored) {
      const data = JSON.parse(stored);
      // Backfill per-strategy fields for old data that doesn't have them
      return {
        ...data,
        conservative: data.conservative ?? emptyStrategyStats(),
        aggressive: data.aggressive ?? emptyStrategyStats(),
      };
    }
  } catch {
    // ignore
  }
  return {
    totalReturn: 0, totalFees: 0, totalTrades: 0, totalWins: 0, daysTracked: 0,
    conservative: emptyStrategyStats(),
    aggressive: emptyStrategyStats(),
  };
}

function strategyStatsFromTrades(trades: Trade[], strategy: 'conservative' | 'aggressive'): StrategyStats {
  const filtered = trades.filter((t) => t.strategy === strategy);
  return {
    return: filtered.reduce((sum, t) => sum + t.netPnL, 0),
    trades: filtered.length,
    wins: filtered.filter((t) => t.won).length,
  };
}

export function getLifetimeReturn(): LifetimeStats {
  const lifetime = getLifetimeData();
  const today = getDailyData();
  const todayCon = strategyStatsFromTrades(today.trades, 'conservative');
  const todayAgg = strategyStatsFromTrades(today.trades, 'aggressive');

  return {
    totalReturn: lifetime.totalReturn + today.totalReturn,
    totalFees: lifetime.totalFees + today.totalFeesPaid,
    totalTrades: lifetime.totalTrades + today.trades.length,
    totalWins: lifetime.totalWins + today.trades.filter((t) => t.won).length,
    daysTracked: lifetime.daysTracked + 1,
    conservative: {
      return: lifetime.conservative.return + todayCon.return,
      trades: lifetime.conservative.trades + todayCon.trades,
      wins: lifetime.conservative.wins + todayCon.wins,
    },
    aggressive: {
      return: lifetime.aggressive.return + todayAgg.return,
      trades: lifetime.aggressive.trades + todayAgg.trades,
      wins: lifetime.aggressive.wins + todayAgg.wins,
    },
  };
}

export function getWeeklyData(): WeeklyDataPoint[] {
  try {
    const stored = localStorage.getItem(HISTORY_KEY);
    const history: Record<string, DailyPerformance> = stored ? JSON.parse(stored) : {};

    const today = getDailyData();
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
          conservative: today.startingCapital + today.conservativeReturn,
          aggressive: today.startingCapital + today.aggressiveReturn,
        });
      } else if (history[dateStr]) {
        const h = history[dateStr];
        points.push({
          day: dayName,
          date: dateStr,
          conservative: h.startingCapital + h.conservativeReturn,
          aggressive: h.startingCapital + h.aggressiveReturn,
        });
      } else {
        points.push({
          day: dayName,
          date: dateStr,
          conservative: 100,
          aggressive: 100,
        });
      }
    }

    return points;
  } catch {
    return [];
  }
}

export function exportTradesCSV(trades: Trade[]): string {
  const headers = [
    'Time', 'Strategy', 'Direction', 'Strike', 'Entry', 'Exit', 'Type',
    'Contracts', 'Entry Fee', 'Exit Fee', 'Net P&L', 'Won',
  ];

  const rows = trades.map((t) => [
    new Date(t.timestamp).toLocaleString(),
    t.strategy,
    (t.direction ?? 'yes').toUpperCase(),
    t.strike,
    t.entryPrice.toFixed(2),
    t.exitPrice.toFixed(2),
    t.exitType,
    t.contracts,
    t.entryFee.toFixed(2),
    t.exitFee.toFixed(2),
    t.netPnL.toFixed(2),
    t.won ? 'YES' : 'NO',
  ]);

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}
