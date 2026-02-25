import fs from 'fs';
import path from 'path';
import { calculateKalshiFeeBreakdown } from '@/lib/utils/fees';

const POSITION_FILE = path.join(process.cwd(), 'data', 'position.json');
const TRADES_FILE = path.join(process.cwd(), 'data', 'trades.json');
const LIFECYCLE_FILE = path.join(process.cwd(), 'data', 'trade-lifecycle.json');
const BOT_ORDER_IDS_FILE = path.join(process.cwd(), 'data', 'bot-order-ids.json');
const MAX_LIFECYCLE_TRADES = 200; // Keep last 200 trades

/**
 * Record a bot-placed order ID to distinguish from manual trades.
 * Appends to bot-order-ids.json (persists across restarts).
 */
export function recordBotOrderId(orderId: string): void {
  try {
    let ids: string[] = [];
    if (fs.existsSync(BOT_ORDER_IDS_FILE)) {
      ids = JSON.parse(fs.readFileSync(BOT_ORDER_IDS_FILE, 'utf-8'));
    }
    if (!ids.includes(orderId)) {
      ids.push(orderId);
      const dir = path.dirname(BOT_ORDER_IDS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(BOT_ORDER_IDS_FILE, JSON.stringify(ids, null, 2));
    }
  } catch (err) {
    console.error('[POSITION] Failed to record bot order ID:', err);
  }
}

/**
 * Load all known bot order IDs
 */
export function loadBotOrderIds(): Set<string> {
  try {
    if (fs.existsSync(BOT_ORDER_IDS_FILE)) {
      const ids: string[] = JSON.parse(fs.readFileSync(BOT_ORDER_IDS_FILE, 'utf-8'));
      return new Set(ids);
    }
  } catch { /* ignore */ }
  return new Set();
}

// ──── Trade lifecycle types ────

export interface TradeSnapshot {
  t: string;              // ISO timestamp
  btc: number;            // BTC spot price
  bid: number;            // contract bid (cents)
  ask: number;            // contract ask (cents)
  unrealisedPnL: number;  // dollars, negative while losing
  winProb: number;        // 0–1 from market midpoint
  minsRemaining: number;
}

export interface TradeLifecycle {
  tradeId: string;
  bot: string;
  ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  entryPrice: number;     // dollars per contract
  entryTime: string;
  entryBtcPrice: number;
  signal?: string;
  snapshots: TradeSnapshot[];
  // Filled on close
  open: boolean;
  exitTime?: string;
  exitBtcPrice?: number;
  exitType?: string;
  exitPrice?: number;     // dollars per contract
  finalPnL?: number;
  won?: boolean;
}

function readLifecycle(): TradeLifecycle[] {
  try {
    if (fs.existsSync(LIFECYCLE_FILE)) {
      return JSON.parse(fs.readFileSync(LIFECYCLE_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function writeLifecycle(trades: TradeLifecycle[]): void {
  const dir = path.dirname(LIFECYCLE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = LIFECYCLE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(trades, null, 2));
  fs.renameSync(tmp, LIFECYCLE_FILE);
}

/** Call immediately after an order is placed and position saved. */
export function openTradeLifecycle(params: {
  tradeId: string;
  bot: string;
  ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  entryPrice: number;
  entryTime: string;
  entryBtcPrice: number;
  signal?: string;
}): void {
  try {
    const trades = readLifecycle();
    trades.push({ ...params, snapshots: [], open: true });
    // Trim to max, keeping open trades
    const open = trades.filter(t => t.open);
    const closed = trades.filter(t => !t.open).slice(-(MAX_LIFECYCLE_TRADES - open.length));
    writeLifecycle([...closed, ...open]);
  } catch (err) {
    console.error('[LIFECYCLE] Failed to open lifecycle entry:', err);
  }
}

/** Call every 5-second loop tick while position is open. */
export function appendTradeSnapshot(tradeId: string, snapshot: TradeSnapshot): void {
  try {
    const trades = readLifecycle();
    const trade = trades.find(t => t.tradeId === tradeId && t.open);
    if (!trade) return;
    trade.snapshots.push(snapshot);
    writeLifecycle(trades);
  } catch (err) {
    console.error('[LIFECYCLE] Failed to append snapshot:', err);
  }
}

/** Call when the trade closes (settlement, early exit, stale). */
export function closeTradeLifecycle(params: {
  tradeId: string;
  exitTime: string;
  exitBtcPrice: number;
  exitType: string;
  exitPrice: number;
  finalPnL: number;
  won: boolean;
}): void {
  try {
    const trades = readLifecycle();
    const trade = trades.find(t => t.tradeId === params.tradeId && t.open);
    if (!trade) return;
    trade.open = false;
    trade.exitTime = params.exitTime;
    trade.exitBtcPrice = params.exitBtcPrice;
    trade.exitType = params.exitType;
    trade.exitPrice = params.exitPrice;
    trade.finalPnL = params.finalPnL;
    trade.won = params.won;
    writeLifecycle(trades);
  } catch (err) {
    console.error('[LIFECYCLE] Failed to close lifecycle entry:', err);
  }
}

export interface Position {
  active: boolean;
  pending?: boolean;
  tradeId?: string;
  strike?: number;
  direction?: 'yes' | 'no';
  entryPrice?: number;
  contracts?: number;
  totalCost?: number;
  btcPriceAtEntry?: number;
  entryTime?: string;
  hourKey?: string;
}

let boughtThisHour: Record<string, boolean> = {};

export function getCurrentHourKey(): string {
  const now = new Date();
  return `${now.toISOString().split('T')[0]}-${now.getUTCHours()}`;
}

export function hasBoughtThisHour(): boolean {
  const hourKey = getCurrentHourKey();
  return !!boughtThisHour[hourKey];
}

export function markBoughtThisHour(): void {
  const hourKey = getCurrentHourKey();
  boughtThisHour = { [hourKey]: true };
}

export function readPosition(): Position {
  try {
    if (fs.existsSync(POSITION_FILE)) {
      return JSON.parse(fs.readFileSync(POSITION_FILE, 'utf-8'));
    }
  } catch {
    // File corrupt or being written
  }
  return { active: false };
}

export function writePosition(position: Position): void {
  const dir = path.dirname(POSITION_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmpFile = POSITION_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(position, null, 2));
  fs.renameSync(tmpFile, POSITION_FILE);
}

export function clearPosition(): void {
  writePosition({ active: false });
}

export function logTradeToFile(trade: {
  id: string;
  timestamp: string;
  strategy: string;
  direction: string;
  strike?: number; // Optional for 15-min markets
  entryPrice: number;
  exitPrice: number;
  exitType: string;
  contracts: number;
  netPnL: number;
  won: boolean;
  exitReason?: string;
}): void {
  try {
    let data = { daily: { date: '', trades: [] as unknown[], startingCapital: 100, conservativeReturn: 0, aggressiveReturn: 0, fifteenMinReturn: 0, totalReturn: 0, totalFeesPaid: 0, netReturn: 0 }, history: {} as Record<string, unknown> };
    const today = new Date().toISOString().split('T')[0];

    if (fs.existsSync(TRADES_FILE)) {
      data = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf-8'));
      if (data.daily.date !== today) {
        if ((data.daily.trades as unknown[]).length > 0) {
          data.history[data.daily.date] = data.daily;
        }
        data.daily = { date: today, trades: [], startingCapital: 100, conservativeReturn: 0, aggressiveReturn: 0, fifteenMinReturn: 0, totalReturn: 0, totalFeesPaid: 0, netReturn: 0 };
      }
    } else {
      data.daily.date = today;
    }

    data.daily.trades.push(trade);
    if (trade.strategy === 'aggressive') {
      data.daily.aggressiveReturn += trade.netPnL;
    } else if (trade.strategy === 'conservative') {
      data.daily.conservativeReturn += trade.netPnL;
    } else if (trade.strategy === 'fifteenMin') {
      data.daily.fifteenMinReturn += trade.netPnL;
    }
    // Include all strategies in totalReturn (grok15min, grokHourly, arb, manual, etc.)
    data.daily.totalReturn = (data.daily.trades as Array<{ netPnL: number }>).reduce((sum, t) => sum + (t.netPnL || 0), 0);
    data.daily.netReturn = data.daily.totalReturn;

    const dir = path.dirname(TRADES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TRADES_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[POSITION] Failed to log trade:', err);
  }
}
