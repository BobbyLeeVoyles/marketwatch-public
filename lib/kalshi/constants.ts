/**
 * Kalshi API Constants
 *
 * Security: These constants are hardcoded to prevent unauthorized trading.
 * NEVER accept market tickers or API URLs from external sources.
 */

export const KALSHI_BASE_URL_PROD = 'https://api.elections.kalshi.com/trade-api/v2';
export const KALSHI_BASE_URL_DEMO = 'https://demo-api.kalshi.co/trade-api/v2';

export const KALSHI_WS_URL_PROD = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
export const KALSHI_WS_URL_DEMO = 'wss://demo-api.kalshi.co/trade-api/ws/v2';

/**
 * SECURITY: Allowlisted series tickers
 * Only these series are authorized for trading. Any attempt to trade
 * other markets will be rejected.
 */
export const ALLOWED_SERIES_TICKERS = ['KXBTC', 'KXBTCD', 'KXBTC15M'] as const;

export type AllowedSeriesTicker = typeof ALLOWED_SERIES_TICKERS[number];

/**
 * Validate that a series ticker is allowed
 * @throws Error if ticker is not in allowlist
 */
export function validateSeriesTicker(ticker: string): asserts ticker is AllowedSeriesTicker {
  if (!ALLOWED_SERIES_TICKERS.includes(ticker as AllowedSeriesTicker)) {
    throw new Error(
      `SECURITY VIOLATION: Series ticker "${ticker}" is not in allowlist. ` +
      `Allowed: ${ALLOWED_SERIES_TICKERS.join(', ')}`
    );
  }
}

/**
 * Validate that a market ticker belongs to an allowed series
 * Market tickers start with the series ticker (e.g., KXBTC-26FEB14-B98000)
 * @throws Error if market ticker doesn't start with an allowed series
 */
export function validateMarketTicker(ticker: string): void {
  const isValid = ALLOWED_SERIES_TICKERS.some(series => ticker.startsWith(series));
  if (!isValid) {
    throw new Error(
      `SECURITY VIOLATION: Market ticker "${ticker}" does not belong to an allowed series. ` +
      `Allowed series: ${ALLOWED_SERIES_TICKERS.join(', ')}`
    );
  }
}

/**
 * Kalshi rate limits (Basic tier defaults)
 * Check actual tier via GET /account/limits on startup
 */
export const RATE_LIMITS = {
  READ_PER_SECOND: 10,
  WRITE_PER_SECOND: 5,
};

/**
 * Order retry configuration
 */
export const ORDER_RETRY_CONFIG = {
  MAX_RETRIES: 3,
  INITIAL_BACKOFF_MS: 1000,
  MAX_BACKOFF_MS: 8000,
};
