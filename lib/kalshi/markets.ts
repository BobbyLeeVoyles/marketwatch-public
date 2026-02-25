/**
 * Kalshi Market Discovery
 *
 * Find active KXBTCD (hourly) and KXBTC15M (15-minute) markets
 */

import { getKalshiClient } from './client';
import { KalshiMarket } from './types';

/**
 * Parse strike price from KXBTCD market ticker or subtitle.
 *
 * Ticker format: KXBTCD-26FEB1614-T79499.99 → strike = 79499.99
 * Subtitle format: "Bitcoin above $79,500 at 2pm ET" → strike = 79500
 *
 * Prefers ticker (exact) over subtitle (rounded).
 */
function parseStrike(market: KalshiMarket): number | undefined {
  // Try ticker first: "-T<number>" at the end
  const tickerMatch = market.ticker.match(/-T(\d+(?:\.\d+)?)$/);
  if (tickerMatch) {
    return parseFloat(tickerMatch[1]);
  }

  // Fallback: subtitle "$79,500"
  const subtitleMatch = market.subtitle.match(/\$([0-9,]+)/);
  if (subtitleMatch) {
    return parseInt(subtitleMatch[1].replace(/,/g, ''), 10);
  }
  return undefined;
}

/**
 * Parse the settlement hour from a KXBTCD ticker.
 *
 * Ticker format: KXBTCD-26FEB1614-T79499.99
 *   26    = year 2026
 *   FEB   = month
 *   16    = day
 *   14    = hour (ET)
 *
 * Returns a Date in ET (Eastern Time) for the settlement hour, or null.
 */
export function parseTickerSettlementTime(ticker: string): Date | null {
  // Match: KXBTCD-YYMONDDHR-T...
  const match = ticker.match(/^KXBTCD-(\d{2})([A-Z]{3})(\d{2})(\d{2})-/);
  if (!match) return null;

  const year = 2000 + parseInt(match[1], 10);
  const monthStr = match[2];
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);

  const months: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const month = months[monthStr];
  if (month === undefined) return null;

  // Build a Date in ET. We use the Intl API to handle EST/EDT correctly.
  // Create a UTC date at the given hour, then adjust for ET offset.
  // ET is UTC-5 (EST) or UTC-4 (EDT). To get the correct UTC time:
  // We construct the date in ET by adding the ET offset.
  // A reliable approach: create a date string and let the runtime parse it.
  const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00`;

  // Determine ET offset for this date
  try {
    const tempDate = new Date(`${dateStr}Z`); // treat as UTC temporarily
    const etFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    });
    // Get the ET hour at this UTC time to determine the offset
    const utcHour = tempDate.getUTCHours();
    const etHourStr = etFormatter.format(tempDate);
    const etHour = parseInt(etHourStr, 10);
    const offset = utcHour - etHour; // hours ahead of ET that UTC is
    // The settlement is at `hour` ET, so UTC = hour + offset
    const utcSettlement = new Date(Date.UTC(year, month, day, hour + offset, 0, 0));
    return utcSettlement;
  } catch {
    // Fallback: assume EST (UTC-5)
    return new Date(Date.UTC(year, month, day, hour + 5, 0, 0));
  }
}

/**
 * Find hourly KXBTCD markets for current hour.
 *
 * Uses close_time (market close) and ticker-parsed settlement hour
 * to find markets settling within the next 60 minutes.
 */
export async function findHourlyMarkets(btcPrice: number): Promise<{
  floorStrike: KalshiMarket | null;
  floorStrikeValue: number | null;
  nextUpStrike: KalshiMarket | null;
  nextUpStrikeValue: number | null;
}> {
  const client = getKalshiClient();

  // Get all open KXBTCD markets
  const markets = await client.getMarkets('KXBTCD', 'open');

  console.log(`[KALSHI] KXBTCD API returned ${markets.length} open markets`);

  const now = new Date();
  const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

  // Try filtering by close_time first (market close = settlement time)
  let currentHourMarkets = markets.filter(m => {
    const closeTime = new Date(m.close_time);
    return closeTime <= oneHourFromNow && closeTime > now;
  });

  // If close_time didn't work, try parsing the settlement hour from the ticker
  if (currentHourMarkets.length === 0) {
    currentHourMarkets = markets.filter(m => {
      const settlement = parseTickerSettlementTime(m.ticker);
      if (!settlement) return false;
      return settlement <= oneHourFromNow && settlement > now;
    });

    if (currentHourMarkets.length > 0) {
      console.log(`[KALSHI] Matched ${currentHourMarkets.length} markets via ticker-parsed settlement time`);
    }
  }

  if (currentHourMarkets.length === 0) {
    // Diagnostic: show what close_time and ticker parsing yield
    if (markets.length > 0) {
      const samples = markets.slice(0, 3).map(m => {
        const closeMs = new Date(m.close_time).getTime() - now.getTime();
        const closeMins = Math.round(closeMs / 60000);
        const settlement = parseTickerSettlementTime(m.ticker);
        const settleMins = settlement ? Math.round((settlement.getTime() - now.getTime()) / 60000) : '?';
        return `${m.ticker} close_time=${closeMins}m ticker_settle=${settleMins}m`;
      });
      console.warn(
        `[KALSHI] No hourly markets in current hour window (now → +60m). ` +
        `${markets.length} total open. Samples: ${samples.join(' | ')}`
      );
    } else {
      console.warn('[KALSHI] No open KXBTCD markets returned from API at all');
    }
    return { floorStrike: null, floorStrikeValue: null, nextUpStrike: null, nextUpStrikeValue: null };
  }

  // Parse strikes from tickers
  const marketsWithStrikes = currentHourMarkets
    .map(m => ({ market: m, strike: parseStrike(m) }))
    .filter(m => m.strike !== undefined) as Array<{ market: KalshiMarket; strike: number }>;

  // Calculate floor and next-up strikes using the same increment as the markets.
  // Detect increment from available strikes (typically $250 or $500).
  const strikes = marketsWithStrikes.map(m => m.strike).sort((a, b) => a - b);
  let strikeIncrement = 250; // default
  if (strikes.length >= 2) {
    // Find the most common gap between adjacent strikes
    const gaps: number[] = [];
    for (let i = 1; i < strikes.length; i++) {
      gaps.push(Math.round(strikes[i] - strikes[i - 1]));
    }
    // Use the smallest common gap
    const gapCounts = new Map<number, number>();
    for (const g of gaps) {
      gapCounts.set(g, (gapCounts.get(g) || 0) + 1);
    }
    let maxCount = 0;
    gapCounts.forEach((count, gap) => {
      if (count > maxCount && gap > 0) {
        maxCount = count;
        strikeIncrement = gap;
      }
    });
  }

  const floorStrikeValue = Math.floor(btcPrice / strikeIncrement) * strikeIncrement;
  const nextUpStrikeValue = floorStrikeValue + strikeIncrement;

  console.log(
    `[KALSHI] BTC: $${btcPrice.toFixed(0)} | Increment: $${strikeIncrement} | ` +
    `Floor: $${floorStrikeValue} | Next-up: $${nextUpStrikeValue} | ` +
    `${currentHourMarkets.length} markets, ${marketsWithStrikes.length} with strikes | ` +
    `Nearby: [${marketsWithStrikes
      .filter(m => Math.abs(m.strike - btcPrice) < strikeIncrement * 3)
      .map(m => `$${m.strike}`)
      .join(', ')}]`
  );

  // Find matching markets — try exact match first, then closest
  let floorMarket = marketsWithStrikes.find(m => m.strike === floorStrikeValue);
  let nextUpMarket = marketsWithStrikes.find(m => m.strike === nextUpStrikeValue);

  // If exact match fails, find the closest strikes below and above BTC price
  if (!floorMarket || !nextUpMarket) {
    const below = marketsWithStrikes
      .filter(m => m.strike <= btcPrice)
      .sort((a, b) => b.strike - a.strike);
    const above = marketsWithStrikes
      .filter(m => m.strike > btcPrice)
      .sort((a, b) => a.strike - b.strike);

    if (!floorMarket && below.length > 0) {
      floorMarket = below[0];
      console.log(`[KALSHI] Floor exact miss, using closest below: $${floorMarket.strike}`);
    }
    if (!nextUpMarket && above.length > 0) {
      nextUpMarket = above[0];
      console.log(`[KALSHI] Next-up exact miss, using closest above: $${nextUpMarket.strike}`);
    }
  }

  return {
    floorStrike: floorMarket?.market || null,
    floorStrikeValue: floorMarket?.strike || null,
    nextUpStrike: nextUpMarket?.market || null,
    nextUpStrikeValue: nextUpMarket?.strike || null,
  };
}

/**
 * Find current 15-minute KXBTC15M market
 * Returns the soonest expiring market (demo markets may have longer expiration times)
 */
export async function find15MinMarket(): Promise<KalshiMarket | null> {
  const client = getKalshiClient();
  const now = Date.now();

  // Kalshi accepts 'open' as a filter param but returns 'active' in the response payload.
  // Check both to handle the mismatch. close_time > now - 90s allows for the ~60s window
  // where Kalshi stops accepting orders but the market is still labelled active in the UI.
  const isActive = (m: KalshiMarket) => m.status === 'open' || m.status === 'active';
  const notExpired = (m: KalshiMarket) => new Date(m.close_time).getTime() > now - 90_000;

  // First try: only 'open'/'active' status markets
  let markets = await client.getMarkets('KXBTC15M', 'open');
  let activeMarkets = markets.filter(m => isActive(m) && notExpired(m));

  // Fallback: fetch all statuses — catches pre-listed upcoming windows
  if (activeMarkets.length === 0) {
    markets = await client.getMarkets('KXBTC15M');
    activeMarkets = markets.filter(m => isActive(m) && notExpired(m));
  }

  if (activeMarkets.length === 0) {
    console.warn('[KALSHI] No active KXBTC15M markets found');
    return null;
  }

  console.log(`[KALSHI] Found ${activeMarkets.length} active KXBTC15M market(s)`);

  // Sort by close_time ascending to find the soonest expiry (current window).
  activeMarkets.sort((a, b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime());
  const soonestCloseMs = new Date(activeMarkets[0].close_time).getTime();

  // Among markets in the same window (close_time within 60s of the soonest),
  // Kalshi now lists multiple contracts per window at different strikes.
  // Prefer the most ATM market — where yes_ask + no_ask is closest to 100¢
  // (a deeply OTM market has yes_ask ≈ 1¢ and is often rejected by the API).
  const sameWindowMarkets = activeMarkets.filter(
    m => Math.abs(new Date(m.close_time).getTime() - soonestCloseMs) < 60_000
  );

  const currentMarket = sameWindowMarkets.reduce((best, m) => {
    const mMid = (m.yes_ask ?? 0) + (m.no_ask ?? 0); // should be ~100 for ATM
    const bestMid = (best.yes_ask ?? 0) + (best.no_ask ?? 0);
    return Math.abs(mMid - 100) < Math.abs(bestMid - 100) ? m : best;
  });

  const closeTime = new Date(currentMarket.close_time);
  const minutesUntil = Math.floor((closeTime.getTime() - now) / 60000);
  const midPrice = (currentMarket.yes_ask ?? 0) + (currentMarket.no_ask ?? 0);

  console.log(
    `[KALSHI] Selected 15-min market: ${currentMarket.ticker} ` +
    `(closes in ${minutesUntil} mins, yes=${currentMarket.yes_ask}¢ no=${currentMarket.no_ask}¢ mid=${midPrice}¢` +
    `${sameWindowMarkets.length > 1 ? `, chosen from ${sameWindowMarkets.length} same-window markets` : ''})`
  );

  return currentMarket;
}

/**
 * Get full market details by ticker (with caching)
 */
const marketCache = new Map<string, { market: KalshiMarket; timestamp: number }>();
const CACHE_TTL_MS = 30 * 1000; // 30 seconds

export async function getMarketCached(ticker: string): Promise<KalshiMarket> {
  const cached = marketCache.get(ticker);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.market;
  }

  const client = getKalshiClient();
  const market = await client.getMarket(ticker);

  marketCache.set(ticker, { market, timestamp: Date.now() });
  return market;
}

/**
 * Clear market cache (call on errors or when switching markets)
 */
export function clearMarketCache(): void {
  marketCache.clear();
}
