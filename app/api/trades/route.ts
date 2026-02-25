import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { DailyPerformance, Trade } from '@/lib/types';

const TRADES_FILE = path.join(process.cwd(), 'data', 'trades.json');

interface TradesData {
  daily: DailyPerformance;
  history: Record<string, DailyPerformance>;
}

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
    grok15minReturn: 0,
    grokHourlyReturn: 0,
    totalReturn: 0,
    totalFeesPaid: 0,
    netReturn: 0,
  };
}

function readTradesFile(): TradesData {
  try {
    if (fs.existsSync(TRADES_FILE)) {
      const raw = fs.readFileSync(TRADES_FILE, 'utf-8');
      const data: TradesData = JSON.parse(raw);
      const today = getTodayDate();
      if (data.daily.date !== today) {
        // Archive yesterday and start fresh
        if (data.daily.trades.length > 0) {
          data.history[data.daily.date] = data.daily;
        }
        data.daily = createNewDay(today);
        writeTradesFile(data);
      }
      return data;
    }
  } catch {
    // File corrupt or missing
  }
  return { daily: createNewDay(getTodayDate()), history: {} };
}

function writeTradesFile(data: TradesData): void {
  const dir = path.dirname(TRADES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TRADES_FILE, JSON.stringify(data, null, 2));
}

export async function GET() {
  try {
    const data = readTradesFile();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read trades' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const trade: Trade = await request.json();
    const data = readTradesFile();

    data.daily.trades.push(trade);

    if (trade.strategy === 'conservative') {
      data.daily.conservativeReturn += trade.netPnL;
    } else if (trade.strategy === 'fifteenMin') {
      data.daily.fifteenMinReturn += trade.netPnL;
    } else if (trade.strategy === 'grok15min') {
      data.daily.grok15minReturn = (data.daily.grok15minReturn || 0) + trade.netPnL;
    } else if (trade.strategy === 'grokHourly') {
      data.daily.grokHourlyReturn = (data.daily.grokHourlyReturn || 0) + trade.netPnL;
    } else {
      data.daily.aggressiveReturn += trade.netPnL;
    }

    data.daily.totalFeesPaid += (trade.entryFee ?? 0) + (trade.exitFee ?? 0);
    data.daily.totalReturn =
      data.daily.conservativeReturn +
      data.daily.aggressiveReturn +
      data.daily.fifteenMinReturn +
      (data.daily.grok15minReturn || 0) +
      (data.daily.grokHourlyReturn || 0);
    data.daily.netReturn = data.daily.totalReturn;

    writeTradesFile(data);
    return NextResponse.json({ success: true, daily: data.daily });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to save trade' }, { status: 500 });
  }
}
