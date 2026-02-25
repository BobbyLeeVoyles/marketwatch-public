import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { HourlyCandle, FiveMinCandle } from '@/lib/types';
import { calculateRSI, calculateBollingerBands } from '@/lib/utils/indicators';

const BTC_LOG_FILE = path.join(process.cwd(), 'data', 'btc-log.json');
const BTC_LOG_MAX = 10_000;
const BTC_LOG_INTERVAL_MS = 60_000;

const WS_URLS = [
  'wss://stream.binance.us:9443/ws/btcusdt@trade',
  'wss://stream.binance.com:9443/ws/btcusdt@trade',
];

const COINBASE_API = 'https://api.exchange.coinbase.com';
const COINBASE_HEADERS = { 'User-Agent': 'MarketwatchBot/1.0' };

// Coinbase candle format: [time_sec, low, high, open, close, volume] — newest-first
// Binance candle format:  [time_ms, open, high, low, close, volume, ...] — oldest-first
function parseCoinbaseCandles(klines: [number, number, number, number, number, number][]): HourlyCandle[] {
  return klines
    .map(k => ({
      timestamp: new Date(k[0] * 1000),
      open: k[3],
      high: k[2],
      low: k[1],
      close: k[4],
      volume: k[5],
    }))
    .reverse(); // newest-first → oldest-first
}

function parseBinanceCandles(klines: [number, string, string, string, string, string, ...unknown[]][]): HourlyCandle[] {
  return klines.map(k => ({
    timestamp: new Date(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5] as string),
  }));
}

const KLINES_BINANCE_URLS = [
  'https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=12',
  'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=12',
];

const KLINES_5M_BINANCE_URLS = [
  'https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=24',
  'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=24',
];

const RECONNECT_DELAY = 3000;
const STALE_TIMEOUT = 30_000; // Force reconnect if no message in 30s

let currentPrice = 0;
let ws: WebSocket | null = null;
let urlIndex = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let staleCheckTimer: ReturnType<typeof setInterval> | null = null;
let connected = false;
let lastMessageTime = Date.now();

let cachedCandles: HourlyCandle[] = [];
let lastCandleFetch = 0;
const CANDLE_REFRESH_MS = 60_000;

let cached5MinCandles: FiveMinCandle[] = [];
let last5MinCandleFetch = 0;
const CANDLE_5MIN_REFRESH_MS = 15_000; // 15-second refresh for tighter 15-min strategy

function connect(onPrice?: (price: number) => void): void {
  // Clean up stale-check timer
  if (staleCheckTimer) {
    clearInterval(staleCheckTimer);
    staleCheckTimer = null;
  }

  if (ws?.readyState === WebSocket.OPEN) {
    ws.close();
  }

  const wsUrl = WS_URLS[urlIndex % WS_URLS.length];
  console.log(`[BTC-FEED] Connecting to ${wsUrl}...`);

  try {
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      connected = true;
      lastMessageTime = Date.now();
      console.log('[BTC-FEED] WebSocket connected - waiting for price data...');

      // Start stale connection monitor
      staleCheckTimer = setInterval(() => {
        const timeSinceMessage = Date.now() - lastMessageTime;
        if (timeSinceMessage > STALE_TIMEOUT) {
          console.warn(`[BTC-FEED] Connection stale (no messages for ${Math.floor(timeSinceMessage / 1000)}s) — reconnecting`);
          ws?.close();
        }
      }, 10_000);

      // Send ping to keep connection alive
      const pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 20_000);

      // Clean up ping interval when connection closes
      if (ws) {
        ws.once('close', () => clearInterval(pingInterval));
      }
    });

    ws.on('message', (data: WebSocket.Data) => {
      const isFirstMessage = lastMessageTime === Date.now() - 1000 || currentPrice === 0;
      lastMessageTime = Date.now();
      try {
        const msg = JSON.parse(data.toString());
        if (msg.p) {
          currentPrice = parseFloat(msg.p);
          recordPriceTick(currentPrice);
          if (isFirstMessage) {
            console.log(`[BTC-FEED] ✓ Receiving price updates (BTC: $${currentPrice.toFixed(2)})`);
          }
          onPrice?.(currentPrice);
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on('pong', () => {
      // Keep connection alive
      lastMessageTime = Date.now();
    });

    ws.on('close', () => {
      connected = false;
      ws = null;
      if (staleCheckTimer) {
        clearInterval(staleCheckTimer);
        staleCheckTimer = null;
      }
      urlIndex = (urlIndex + 1) % WS_URLS.length;
      console.log(`[BTC-FEED] Disconnected. Reconnecting in ${RECONNECT_DELAY}ms...`);
      reconnectTimer = setTimeout(() => connect(onPrice), RECONNECT_DELAY);
    });

    ws.on('error', () => {
      ws?.close();
    });
  } catch {
    reconnectTimer = setTimeout(() => connect(onPrice), RECONNECT_DELAY);
  }
}

export function startPriceFeed(onPrice?: (price: number) => void): void {
  connect(onPrice);
}

export function stopPriceFeed(): void {
  if (staleCheckTimer) clearInterval(staleCheckTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
  ws = null;
  connected = false;
}

export function getPrice(): number {
  return currentPrice;
}

export function isConnected(): boolean {
  return connected;
}

export async function fetchHourlyCandles(): Promise<HourlyCandle[]> {
  const now = Date.now();
  if (cachedCandles.length > 0 && now - lastCandleFetch < CANDLE_REFRESH_MS) {
    return cachedCandles;
  }

  // Try Coinbase first (real BTC-USD volume)
  try {
    const end = new Date(now).toISOString();
    const start = new Date(now - 12 * 3600 * 1000).toISOString();
    const url = `${COINBASE_API}/products/BTC-USD/candles?granularity=3600&start=${start}&end=${end}`;
    const res = await fetch(url, { headers: COINBASE_HEADERS });
    if (res.ok) {
      const klines = await res.json();
      if (Array.isArray(klines) && klines.length > 0) {
        cachedCandles = parseCoinbaseCandles(klines);
        lastCandleFetch = now;
        return cachedCandles;
      }
    }
  } catch {
    // fall through to Binance
  }

  // Fallback: Binance.US / Binance.com
  for (const url of KLINES_BINANCE_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const klines = await res.json();
      cachedCandles = parseBinanceCandles(klines);
      lastCandleFetch = now;
      return cachedCandles;
    } catch (err) {
      console.warn(`[BTC-FEED] Failed to fetch hourly candles from ${url}:`, err);
    }
  }

  return cachedCandles; // Return stale cache if all fail
}

let btcLogTimer: ReturnType<typeof setInterval> | null = null;

export function startBtcPriceLog(): void {
  if (btcLogTimer) return; // already running
  btcLogTimer = setInterval(async () => {
    try {
      const price = getPrice();
      if (price === 0) return; // no price yet

      const candles = await fetch5MinCandles();
      const completed = candles.length >= 2 ? candles.slice(0, -1) : candles;
      const rsi = calculateRSI(completed, 7);
      const bb = calculateBollingerBands(completed, 9, 2);

      const entry = {
        t: new Date().toISOString(),
        price: Math.round(price * 100) / 100,
        rsi: Math.round(rsi * 10) / 10,
        bbWidth: Math.round(bb.width * 100000) / 100000,
      };

      let log: Array<typeof entry> = [];
      if (fs.existsSync(BTC_LOG_FILE)) {
        try { log = JSON.parse(fs.readFileSync(BTC_LOG_FILE, 'utf-8')); } catch { log = []; }
      }
      log.push(entry);
      if (log.length > BTC_LOG_MAX) log = log.slice(-BTC_LOG_MAX);

      const dir = path.dirname(BTC_LOG_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(BTC_LOG_FILE, JSON.stringify(log));
    } catch (err) {
      console.warn('[BTC-LOG] Failed to append price log:', err);
    }
  }, BTC_LOG_INTERVAL_MS);
}

// ─── 1-min candles ───────────────────────────────────────────────────────────

const KLINES_1M_BINANCE_URLS = [
  'https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=15',
  'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=15',
];

let cached1MinCandles: FiveMinCandle[] = [];
let last1MinCandleFetch = 0;
const CANDLE_1MIN_REFRESH_MS = 30_000; // 30-second refresh

export async function fetch1MinCandles(): Promise<FiveMinCandle[]> {
  const now = Date.now();
  if (cached1MinCandles.length > 0 && now - last1MinCandleFetch < CANDLE_1MIN_REFRESH_MS) {
    return cached1MinCandles;
  }

  // Try Coinbase first
  try {
    const end = new Date(now).toISOString();
    const start = new Date(now - 15 * 60 * 1000).toISOString();
    const url = `${COINBASE_API}/products/BTC-USD/candles?granularity=60&start=${start}&end=${end}`;
    const res = await fetch(url, { headers: COINBASE_HEADERS });
    if (res.ok) {
      const klines = await res.json();
      if (Array.isArray(klines) && klines.length > 0) {
        cached1MinCandles = parseCoinbaseCandles(klines) as FiveMinCandle[];
        last1MinCandleFetch = now;
        return cached1MinCandles;
      }
    }
  } catch {
    // fall through to Binance
  }

  // Fallback: Binance.US / Binance.com
  for (const url of KLINES_1M_BINANCE_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const klines = await res.json();
      cached1MinCandles = parseBinanceCandles(klines) as FiveMinCandle[];
      last1MinCandleFetch = now;
      return cached1MinCandles;
    } catch (err) {
      console.warn(`[BTC-FEED] Failed to fetch 1-min candles from ${url}:`, err);
    }
  }
  return cached1MinCandles;
}

// ─── Funding rate ─────────────────────────────────────────────────────────────
// NOTE: Binance futures API (fapi.binance.com) is geo-blocked from the US (HTTP 451).
// No accessible US alternative exists. This function always returns null.
// Grok prompts show "unavailable" when this is null.

export interface FundingRateData {
  rate: number;        // e.g. 0.0001 = 0.01%
  ratePercent: string; // formatted string
  nextFundingTime: string; // ISO
}

export async function fetchFundingRate(): Promise<FundingRateData | null> {
  return null;
}

// ─── Shared velocity ring buffer ─────────────────────────────────────────────

const btcPriceHistory: Array<{ price: number; ts: number }> = [];
const VELOCITY_MAX_WINDOW_MS = 120_000; // keep up to 120s of history

export function recordPriceTick(price: number): void {
  const now = Date.now();
  btcPriceHistory.push({ price, ts: now });
  // Trim entries older than max window
  const cutoff = now - VELOCITY_MAX_WINDOW_MS;
  while (btcPriceHistory.length > 0 && btcPriceHistory[0].ts < cutoff) {
    btcPriceHistory.shift();
  }
}

/** Returns BTC velocity in $/min over the given window (default 60s). */
export function getVelocity(windowMs = 60_000): number {
  const now = Date.now();
  const cutoff = now - windowMs;
  const window = btcPriceHistory.filter(h => h.ts >= cutoff);
  if (window.length < 2) return 0;
  const elapsed = (window[window.length - 1].ts - window[0].ts) / 60_000;
  if (elapsed <= 0) return 0;
  return (window[window.length - 1].price - window[0].price) / elapsed;
}

/** Count consecutive candles in the same direction from the most recent candle backward. */
export function getMomentumStreak(
  candles: import('@/lib/types').FiveMinCandle[],
  minMovePct = 0.05,
): { direction: 'up' | 'down' | 'flat'; streak: number } {
  if (candles.length === 0) return { direction: 'flat', streak: 0 };

  const candleDir = (c: import('@/lib/types').FiveMinCandle): 'up' | 'down' | 'flat' => {
    const movePct = Math.abs(c.close - c.open) / c.open * 100;
    if (movePct < minMovePct) return 'flat';
    return c.close > c.open ? 'up' : 'down';
  };

  const dir = candleDir(candles[candles.length - 1]);
  if (dir === 'flat') return { direction: 'flat', streak: 1 };

  let streak = 1;
  for (let i = candles.length - 2; i >= 0; i--) {
    if (candleDir(candles[i]) === dir) {
      streak++;
    } else {
      break;
    }
  }
  return { direction: dir, streak };
}

// ─── Order book imbalance ─────────────────────────────────────────────────────

export interface OrderBookImbalance {
  bidDepth: number;   // total bid quantity (top 20 levels)
  askDepth: number;   // total ask quantity (top 20 levels)
  bidPct: number;     // bid depth as % of total (0-100)
  askPct: number;     // ask depth as % of total (0-100)
  imbalance: number;  // bid/ask ratio (>1 = bid-heavy = bullish)
  source: 'coinbase' | 'binance';  // which exchange provided this data
}

let cachedOBI: OrderBookImbalance | null = null;
let lastOBIFetch = 0;
const OBI_REFRESH_MS = 30_000; // 30-second refresh

function computeOBI(bids: [string, string][], asks: [string, string][], source: 'coinbase' | 'binance'): OrderBookImbalance | null {
  const bidDepth = bids.slice(0, 20).reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
  const askDepth = asks.slice(0, 20).reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
  const total = bidDepth + askDepth;
  if (total === 0) return null;
  return {
    bidDepth,
    askDepth,
    bidPct: Math.round((bidDepth / total) * 100),
    askPct: Math.round((askDepth / total) * 100),
    imbalance: askDepth > 0 ? bidDepth / askDepth : 1,
    source,
  };
}

export async function fetchOrderBookImbalance(): Promise<OrderBookImbalance | null> {
  const now = Date.now();
  if (cachedOBI && now - lastOBIFetch < OBI_REFRESH_MS) {
    return cachedOBI;
  }

  // Try Coinbase first — level=2 returns aggregated depth, no User-Agent needed
  // Coinbase format: { bids: [[price, size, num_orders], ...], asks: [...] }
  try {
    const res = await fetch(`${COINBASE_API}/products/BTC-USD/book?level=2`);
    if (res.ok) {
      const data = await res.json();
      const bids: [string, string][] = (data.bids || []).map((b: string[]) => [b[0], b[1]] as [string, string]);
      const asks: [string, string][] = (data.asks || []).map((a: string[]) => [a[0], a[1]] as [string, string]);
      const obi = computeOBI(bids, asks, 'coinbase');
      if (obi) {
        cachedOBI = obi;
        lastOBIFetch = now;
        console.log(`[BTC-FEED] OBI: coinbase — bid ${obi.bidPct}% / ask ${obi.askPct}% (ratio ${obi.imbalance.toFixed(2)})`);
        return cachedOBI;
      }
    }
  } catch {
    console.warn('[BTC-FEED] OBI: Coinbase failed, falling back to Binance');
  }

  // Fallback: Binance.US / Binance.com
  const OBI_BINANCE_URLS = [
    'https://api.binance.us/api/v3/depth?symbol=BTCUSDT&limit=20',
    'https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=20',
  ];

  for (const url of OBI_BINANCE_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const bids: [string, string][] = data.bids || [];
      const asks: [string, string][] = data.asks || [];
      const obi = computeOBI(bids, asks, 'binance');
      if (obi) {
        cachedOBI = obi;
        lastOBIFetch = now;
        console.log(`[BTC-FEED] OBI: binance — bid ${obi.bidPct}% / ask ${obi.askPct}% (ratio ${obi.imbalance.toFixed(2)})`);
        return cachedOBI;
      }
    } catch (err) {
      console.warn(`[BTC-FEED] Failed to fetch order book from ${url}:`, err);
    }
  }
  return cachedOBI;
}

export async function fetch5MinCandles(): Promise<FiveMinCandle[]> {
  const now = Date.now();
  if (cached5MinCandles.length > 0 && now - last5MinCandleFetch < CANDLE_5MIN_REFRESH_MS) {
    return cached5MinCandles;
  }

  // Try Coinbase first
  try {
    const end = new Date(now).toISOString();
    const start = new Date(now - 24 * 5 * 60 * 1000).toISOString(); // 24 × 5min = 120min
    const url = `${COINBASE_API}/products/BTC-USD/candles?granularity=300&start=${start}&end=${end}`;
    const res = await fetch(url, { headers: COINBASE_HEADERS });
    if (res.ok) {
      const klines = await res.json();
      if (Array.isArray(klines) && klines.length > 0) {
        cached5MinCandles = parseCoinbaseCandles(klines) as FiveMinCandle[];
        last5MinCandleFetch = now;
        return cached5MinCandles;
      }
    }
  } catch {
    // fall through to Binance
  }

  // Fallback: Binance.US / Binance.com
  for (const url of KLINES_5M_BINANCE_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const klines = await res.json();
      cached5MinCandles = parseBinanceCandles(klines) as FiveMinCandle[];
      last5MinCandleFetch = now;
      return cached5MinCandles;
    } catch (err) {
      console.warn(`[BTC-FEED] Failed to fetch 5-min candles from ${url}:`, err);
    }
  }

  return cached5MinCandles; // Return stale cache if all fail
}
