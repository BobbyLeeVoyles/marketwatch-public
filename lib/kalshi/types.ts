/**
 * Kalshi API Types
 */

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  series_ticker: string;
  market_type: string;
  title: string;
  subtitle: string;
  yes_bid: number; // cents (1-99)
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  open_interest: number;
  status: 'open' | 'active' | 'closed' | 'settled';
  can_close_early: boolean;
  expiration_time: string; // ISO timestamp
  close_time: string;
  open_time: string;
  expected_expiration_time?: string;
  latest_expiration_time?: string;
  settlement_value?: number; // 0 or 1 after settlement
  result?: 'yes' | 'no';
  // Strike price for KXBTC markets (in market subtitle)
  strike?: number;
}

export interface KalshiOrder {
  order_id: string;
  client_order_id: string;
  user_id: string;
  ticker: string;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  type: 'limit' | 'market';
  yes_price?: number; // cents
  no_price?: number;
  count: number; // total contracts requested
  remaining_count: number; // unfilled contracts
  status: 'resting' | 'canceled' | 'executed';
  created_time: string;
  expiration_time?: string;
  is_taker: boolean;
}

export interface KalshiFill {
  order_id: string;
  fill_id: string;
  ticker: string;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  yes_price: number;
  no_price: number;
  count: number; // contracts filled
  created_time: string;
  is_taker: boolean;
  trade_id: string;
}

export interface KalshiPosition {
  ticker: string;
  market_ticker: string;
  event_ticker: string;
  position: number; // positive = long YES, negative = short YES (= long NO)
  total_cost: number; // cents
  fees_paid: number; // cents
  resting_order_count: number;
}

export interface KalshiBalance {
  balance: number; // cents
  payout: number; // cents pending from settled positions
}

export interface KalshiOrderRequest {
  ticker: string;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  type: 'limit' | 'market';
  count: number;
  yes_price?: number; // required for limit orders
  no_price?: number;
  client_order_id: string; // UUID for idempotency
  expiration_ts?: number; // unix timestamp in seconds (optional)
  sell_position_floor?: number; // for selling, min position to maintain
  buy_max_cost?: number; // for buying, max total cost in cents — WARNING: setting this enables implicit FOK behavior
  time_in_force?: 'fill_or_kill' | 'good_till_canceled' | 'immediate_or_cancel';
}

export interface KalshiOrderResponse {
  order: KalshiOrder;
  // If order immediately fills, may include fills
  fills?: KalshiFill[];
}

export interface KalshiOrderBook {
  ticker: string;
  yes: Array<[number, number]>; // [price in cents, quantity]
  no: Array<[number, number]>;
}

export interface KalshiWebSocketMessage {
  type: 'orderbook_snapshot' | 'orderbook_delta' | 'fill' | 'order_update' | 'market_lifecycle';
  msg?: {
    market_ticker?: string;
    yes?: Array<[number, number]>;
    no?: Array<[number, number]>;
    price?: number;
    delta?: number;
    side?: 'yes' | 'no';
    ts?: number;
    // Fill data
    order_id?: string;
    fill?: KalshiFill;
    // Order update
    order?: KalshiOrder;
    // Market lifecycle
    status?: string;
  };
}

/**
 * Internal bot position tracking (extends Kalshi position with bot-specific data)
 */
export interface BotPosition {
  bot: 'conservative' | 'aggressive' | 'fifteenMin' | 'grok15min' | 'grokHourly' | 'arb';
  ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  entryPrice: number; // dollars per contract
  totalCost: number; // dollars
  entryTime: string; // ISO timestamp
  btcPriceAtEntry: number;
  strike?: number; // for hourly markets
  orderId?: string; // Kalshi order_id
  fills: KalshiFill[];
  signalName?: string; // Signal/strategy name for per-signal analysis (15-min bot)
}
