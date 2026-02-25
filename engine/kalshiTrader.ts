/**
 * Kalshi Trader
 *
 * Handles order placement, fill tracking, and position management
 */

import { randomUUID } from 'crypto';
import { getKalshiClient } from '@/lib/kalshi/client';
import { KalshiOrderRequest, KalshiOrderResponse, KalshiPosition, KalshiBalance } from '@/lib/kalshi/types';
import { calculateKalshiFeeBreakdown } from '@/lib/utils/fees';
import * as fs from 'fs';
import * as path from 'path';

const EXECUTION_LOG_PATH = path.resolve('./data/execution-log.json');

interface ExecutionLogEntry {
  timestamp: string;
  bot: string;
  action: 'BUY' | 'SELL' | 'CANCEL';
  ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  price: number; // dollars
  orderId?: string;
  fillIds?: string[];
  totalCost?: number; // dollars
  error?: string;
}

/**
 * Log all order placements and fills to audit log
 */
function logExecution(entry: ExecutionLogEntry): void {
  try {
    let log: ExecutionLogEntry[] = [];
    if (fs.existsSync(EXECUTION_LOG_PATH)) {
      const data = fs.readFileSync(EXECUTION_LOG_PATH, 'utf8');
      log = JSON.parse(data);
    }
    log.push(entry);
    // Keep last 1000 entries
    if (log.length > 1000) {
      log = log.slice(-1000);
    }
    fs.writeFileSync(EXECUTION_LOG_PATH, JSON.stringify(log, null, 2));
  } catch (error) {
    console.error('[KALSHI TRADER] Failed to write execution log:', error);
  }
}

/**
 * Place a limit order
 * @returns Order response with fill information
 */
export async function placeOrder(
  bot: string,
  ticker: string,
  side: 'yes' | 'no',
  action: 'buy' | 'sell',
  contracts: number,
  priceInCents: number
): Promise<KalshiOrderResponse> {
  const client = getKalshiClient();

  const request: KalshiOrderRequest = {
    ticker,
    action,
    side,
    type: 'limit',
    count: contracts,
    yes_price: side === 'yes' ? priceInCents : undefined,
    no_price: side === 'no' ? priceInCents : undefined,
    client_order_id: randomUUID(),
    // GTC: order rests in the book until filled or cancelled.
    // NOTE: do NOT set buy_max_cost — Kalshi SDK docs state it silently enables FOK behavior,
    // which causes order rejection when book depth < contracts requested.
    time_in_force: 'good_till_canceled',
  };

  const logEntry: ExecutionLogEntry = {
    timestamp: new Date().toISOString(),
    bot,
    action: action.toUpperCase() as 'BUY' | 'SELL',
    ticker,
    side,
    contracts,
    price: priceInCents / 100,
  };

  try {
    const response = await client.placeOrder(request);

    logEntry.orderId = response.order.order_id;

    // Check if order was filled (partially or fully)
    if (response.order.fill_count > 0) {
      const fillCount = response.order.fill_count;
      const fillPrice = side === 'yes' ? response.order.yes_price : response.order.no_price;
      logEntry.totalCost = fillCount * (fillPrice / 100);
    }

    logExecution(logEntry);

    // Map SDK response to KalshiOrderResponse format
    return {
      order: {
        order_id: response.order.order_id,
        client_order_id: response.order.client_order_id,
        user_id: response.order.user_id,
        ticker: response.order.ticker,
        side: response.order.side as 'yes' | 'no',
        action: response.order.action as 'buy' | 'sell',
        type: response.order.type as any,
        count: response.order.remaining_count + response.order.fill_count,
        remaining_count: response.order.remaining_count,
        yes_price: response.order.yes_price,
        no_price: response.order.no_price,
        status: response.order.status as any,
        created_time: new Date().toISOString(),
        is_taker: false, // Default value - SDK doesn't provide this
      },
      fills: [], // SDK doesn't return fills in create order response
    };
  } catch (error) {
    logEntry.error = error instanceof Error ? error.message : String(error);
    logExecution(logEntry);
    throw error;
  }
}

/**
 * Cancel an order
 */
export async function cancelOrder(
  bot: string,
  orderId: string,
  ticker: string
): Promise<void> {
  const client = getKalshiClient();

  const logEntry: ExecutionLogEntry = {
    timestamp: new Date().toISOString(),
    bot,
    action: 'CANCEL',
    ticker,
    side: 'yes', // placeholder
    contracts: 0,
    price: 0,
    orderId,
  };

  try {
    await client.cancelOrder(orderId);
    logExecution(logEntry);
  } catch (error) {
    logEntry.error = error instanceof Error ? error.message : String(error);
    logExecution(logEntry);
    throw error;
  }
}

/**
 * Get current positions
 */
export async function getPositions(): Promise<KalshiPosition[]> {
  const client = getKalshiClient();
  return await client.getPositions();
}

/**
 * Get account balance
 */
export async function getBalance(): Promise<KalshiBalance> {
  const client = getKalshiClient();
  return await client.getBalance();
}

/**
 * Find position for a specific market
 */
export async function getPosition(ticker: string): Promise<KalshiPosition | null> {
  const positions = await getPositions();
  return positions.find(p => p.market_ticker === ticker) || null;
}

/**
 * Calculate expected P&L from current position if we exit now
 * @param position Kalshi position
 * @param currentPrice Current market price in cents
 * @returns Expected P&L in dollars if we sell at current price
 */
export function calculatePositionPnL(
  position: KalshiPosition,
  currentPrice: number
): number {
  const contracts = Math.abs(position.position);
  const isLongYes = position.position > 0;

  // Average entry price
  const entryPrice = (position.total_cost / contracts) / 100; // convert cents to dollars

  // Exit price (current market price)
  const exitPrice = currentPrice / 100;

  // Calculate P&L using Kalshi fees
  const breakdown = calculateKalshiFeeBreakdown(
    contracts,
    entryPrice,
    exitPrice,
    'early'
  );

  // Adjust for direction
  return isLongYes ? breakdown.netPnL : -breakdown.netPnL;
}

/**
 * Check if we have an open position in a market
 */
export async function hasPosition(ticker: string): Promise<boolean> {
  const position = await getPosition(ticker);
  return position !== null && position.position !== 0;
}

/**
 * Get resting (unfilled) orders for a market
 */
export async function getRestingOrders(ticker: string) {
  const client = getKalshiClient();
  const orders = await client.getOrders(ticker, 'resting');
  return orders;
}

/**
 * Cancel all resting orders for a ticker
 */
export async function cancelAllOrders(bot: string, ticker: string): Promise<void> {
  try {
    const orders = await getRestingOrders(ticker);
    for (const order of orders) {
      await cancelOrder(bot, order.order_id, ticker);
    }
  } catch {
    // Ignore errors when cancelling orders during shutdown
  }
}
