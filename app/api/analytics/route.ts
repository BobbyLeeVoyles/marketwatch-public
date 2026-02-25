import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const TRADES_FILE = path.join(process.cwd(), 'data', 'trades.json');
const LIFECYCLE_FILE = path.join(process.cwd(), 'data', 'trade-lifecycle.json');
const BTC_LOG_FILE = path.join(process.cwd(), 'data', 'btc-log.json');

export const dynamic = 'force-dynamic';

interface BtcLogEntry {
  t: string;
  price: number;
  rsi: number;
  bbWidth: number;
}

interface TradeLifecycle {
  tradeId: string;
  signal?: string;
  entryTime: string;
  entryBtcPrice: number;
}

interface TradeRecord {
  id: string;
  timestamp: string;
  strategy: string;
  exitType: string;
  netPnL: number;
  won: boolean;
}

interface StatsAccum {
  count: number;
  wins: number;
  totalPnL: number;
}

function readJsonFile<T>(filepath: string): T | null {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf-8')) as T;
    }
  } catch { /* ignore */ }
  return null;
}

function collectAllTrades(): TradeRecord[] {
  const data = readJsonFile<{
    daily: { trades: TradeRecord[] };
    history: Record<string, { trades: TradeRecord[] }>;
  }>(TRADES_FILE);
  if (!data) return [];
  const trades: TradeRecord[] = [...(data.daily?.trades ?? [])];
  for (const day of Object.values(data.history ?? {})) {
    trades.push(...(day.trades ?? []));
  }
  return trades;
}

function findBtcPrice5MinBefore(btcLog: BtcLogEntry[], entryTimeMs: number): number | null {
  const target = entryTimeMs - 5 * 60 * 1000;
  let best: BtcLogEntry | null = null;
  for (const entry of btcLog) {
    const t = new Date(entry.t).getTime();
    if (t <= target) {
      if (!best || t > new Date(best.t).getTime()) best = entry;
    }
  }
  return best ? best.price : null;
}

function classifyBtcDirection(currentPrice: number, price5minAgo: number): 'bullish' | 'bearish' | 'flat' {
  const changePct = (currentPrice - price5minAgo) / price5minAgo;
  if (changePct > 0.001) return 'bullish';
  if (changePct < -0.001) return 'bearish';
  return 'flat';
}

function addToMap(map: Map<string, StatsAccum>, key: string, won: boolean, pnl: number): void {
  const s = map.get(key) ?? { count: 0, wins: 0, totalPnL: 0 };
  s.count++;
  if (won) s.wins++;
  s.totalPnL += pnl;
  map.set(key, s);
}

export async function GET() {
  try {
    const allTrades = collectAllTrades();
    const lifecycle = readJsonFile<TradeLifecycle[]>(LIFECYCLE_FILE) ?? [];
    const btcLog = readJsonFile<BtcLogEntry[]>(BTC_LOG_FILE) ?? [];

    const lifecycleMap = new Map<string, TradeLifecycle>();
    for (const lc of lifecycle) lifecycleMap.set(lc.tradeId, lc);

    const bySignalMap = new Map<string, StatsAccum>();
    const byBtcDirectionMap = new Map<string, StatsAccum>();
    const byHourMap = new Map<number, StatsAccum>();
    const byExitTypeMap = new Map<string, StatsAccum>();

    for (const trade of allTrades) {
      const lc = lifecycleMap.get(trade.id);
      const signal = lc?.signal ?? `${trade.strategy} trade`;
      const pnl = trade.netPnL;
      const won = trade.won;

      addToMap(bySignalMap, signal, won, pnl);

      // BTC direction from btc-log.json
      if (lc?.entryTime && lc?.entryBtcPrice) {
        const entryMs = new Date(lc.entryTime).getTime();
        const price5minBefore = findBtcPrice5MinBefore(btcLog, entryMs);
        if (price5minBefore !== null) {
          const dir = classifyBtcDirection(lc.entryBtcPrice, price5minBefore);
          addToMap(byBtcDirectionMap, dir, won, pnl);
        }
      }

      // Hour of day (UTC)
      if (trade.timestamp) {
        const hour = new Date(trade.timestamp).getUTCHours();
        const hourStats = byHourMap.get(hour) ?? { count: 0, wins: 0, totalPnL: 0 };
        hourStats.count++;
        if (won) hourStats.wins++;
        hourStats.totalPnL += pnl;
        byHourMap.set(hour, hourStats);
      }

      // Exit type
      if (trade.exitType) addToMap(byExitTypeMap, trade.exitType, won, pnl);
    }

    const bySignal = Array.from(bySignalMap.entries())
      .map(([signal, s]) => ({
        signal,
        count: s.count,
        wins: s.wins,
        winRate: s.count > 0 ? Math.round((s.wins / s.count) * 1000) / 1000 : 0,
        avgPnL: s.count > 0 ? Math.round((s.totalPnL / s.count) * 10000) / 10000 : 0,
        totalPnL: Math.round(s.totalPnL * 10000) / 10000,
      }))
      .sort((a, b) => b.totalPnL - a.totalPnL);

    const byBtcDirection = (['bullish', 'bearish', 'flat'] as const)
      .filter(dir => byBtcDirectionMap.has(dir))
      .map(dir => {
        const s = byBtcDirectionMap.get(dir)!;
        return {
          direction: dir,
          count: s.count,
          winRate: s.count > 0 ? Math.round((s.wins / s.count) * 1000) / 1000 : 0,
          avgPnL: s.count > 0 ? Math.round((s.totalPnL / s.count) * 10000) / 10000 : 0,
        };
      });

    const byHour = Array.from(byHourMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([hour, s]) => ({
        hour,
        count: s.count,
        winRate: s.count > 0 ? Math.round((s.wins / s.count) * 1000) / 1000 : 0,
        avgPnL: s.count > 0 ? Math.round((s.totalPnL / s.count) * 10000) / 10000 : 0,
      }));

    const byExitType = Array.from(byExitTypeMap.entries()).map(([exitType, s]) => ({
      exitType,
      count: s.count,
      winRate: s.count > 0 ? Math.round((s.wins / s.count) * 1000) / 1000 : 0,
      avgPnL: s.count > 0 ? Math.round((s.totalPnL / s.count) * 10000) / 10000 : 0,
    }));

    return NextResponse.json({
      bySignal,
      byBtcDirection,
      byHour,
      byExitType,
      btcDirectionMethod: 'entry price vs 5-min-ago price from btc-log, threshold ±0.1%',
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to compute analytics' }, { status: 500 });
  }
}
