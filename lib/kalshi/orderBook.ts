/**
 * Kalshi Order Book — Cached Fetch + Summarize
 *
 * Binary market interpretation:
 *   YES_bid at X¢ ≡ NO_ask at (100−X)¢
 *   The SDK returns yes bids only; no separate ask levels exist.
 *
 * Cache TTL: 3s per ticker (order books change quickly vs 30s for market data).
 */

import { getKalshiClient } from './client';
import { KalshiOrderBook } from './types';

const CACHE_TTL_MS = 3_000;

interface CacheEntry {
  book: KalshiOrderBook;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Fetch order book with short-lived per-ticker cache.
 * Returns null on error so callers can degrade gracefully.
 */
export async function fetchKalshiOrderBook(
  ticker: string,
  depth = 10
): Promise<KalshiOrderBook | null> {
  const cached = cache.get(ticker);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.book;
  }
  try {
    const client = getKalshiClient();
    const book = await client.getOrderBook(ticker, depth);
    cache.set(ticker, { book, timestamp: Date.now() });
    return book;
  } catch {
    return null;
  }
}

/**
 * Summarize order book depth for Grok prompts.
 *
 * Shows top bid levels and identifies the "thin zone" (price range with no bids)
 * where ladder sell orders are safe to place.
 *
 * @param book  - KalshiOrderBook from fetchKalshiOrderBook
 * @param side  - 'yes' (use yes bids) or 'no' (use no bids)
 * @returns     - e.g. "bids: 43¢×5, 42¢×12, 39¢×30 | thin zone: 44–46¢"
 */
export function summarizeOrderBookDepth(
  book: KalshiOrderBook,
  side: 'yes' | 'no'
): string {
  const levels = side === 'yes' ? book.yes : book.no;
  if (!levels || levels.length === 0) return 'no depth data';

  // Sort descending by price (best bid first)
  const sorted = [...levels].sort((a, b) => b[0] - a[0]);

  // Top 5 levels
  const topLevels = sorted.slice(0, 5);
  const bidStr = topLevels.map(([price, qty]) => `${price}¢×${qty}`).join(', ');

  // Identify thin zone: consecutive prices with no bids above the best bid
  const bestBid = sorted[0][0];
  const priceSet = new Set(sorted.map(([p]) => p));
  let thinEnd = bestBid + 1;
  while (!priceSet.has(thinEnd) && thinEnd <= 99) {
    thinEnd++;
  }
  const thinStr =
    thinEnd > bestBid + 1 ? ` | thin zone: ${bestBid + 1}–${thinEnd - 1}¢` : '';

  return `bids: ${bidStr}${thinStr}`;
}
