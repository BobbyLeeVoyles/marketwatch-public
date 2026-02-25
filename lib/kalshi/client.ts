/**
 * Kalshi API Client - Using Official SDK
 *
 * Wrapper around kalshi-typescript SDK
 */

import { Configuration } from 'kalshi-typescript';
import { PortfolioApi } from 'kalshi-typescript/dist/api/portfolio-api';
import { MarketsApi } from 'kalshi-typescript/dist/api/markets-api';
import { MarketApi } from 'kalshi-typescript/dist/api/market-api';
import { OrdersApi } from 'kalshi-typescript/dist/api/orders-api';
import type { CreateOrderRequest } from 'kalshi-typescript/dist/models/create-order-request';
import type { CreateOrderResponse } from 'kalshi-typescript/dist/models/create-order-response';
import {
  KALSHI_BASE_URL_PROD,
  KALSHI_BASE_URL_DEMO,
  validateMarketTicker,
  validateSeriesTicker,
} from './constants';
import {
  KalshiMarket,
  KalshiBalance,
  KalshiOrderBook,
} from './types';

let clientInstance: KalshiClient | null = null;

export class KalshiClient {
  private config: Configuration;
  private portfolioApi: PortfolioApi;
  private marketsApi: MarketsApi;
  private marketApi: MarketApi;
  private ordersApi: OrdersApi;

  constructor(apiKeyId: string, privateKeyPath: string, demoMode: boolean = false) {
    const basePath = demoMode ? KALSHI_BASE_URL_DEMO : KALSHI_BASE_URL_PROD;

    this.config = new Configuration({
      apiKey: apiKeyId,
      privateKeyPath: privateKeyPath,
      basePath: basePath,
    });

    this.portfolioApi = new PortfolioApi(this.config);
    this.marketsApi = new MarketsApi(this.config);
    this.marketApi = new MarketApi(this.config);
    this.ordersApi = new OrdersApi(this.config);
  }

  /**
   * Test credentials by fetching account balance
   */
  async testConnection(): Promise<void> {
    try {
      await this.getBalance();
      console.log('[KALSHI] Connection verified');
    } catch (error) {
      throw new Error(`Kalshi connection failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Get account balance
   */
  async getBalance(): Promise<KalshiBalance> {
    try {
      const response = await this.portfolioApi.getBalance();
      return {
        balance: response.data.balance || 0,
        payout: response.data.portfolio_value || 0, // portfolio_value represents value of open positions
      };
    } catch (error: any) {
      throw new Error(`Failed to get balance: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Get markets for a series
   */
  async getMarkets(seriesTicker: string, status?: 'open' | 'closed' | 'settled'): Promise<KalshiMarket[]> {
    validateSeriesTicker(seriesTicker);
    try {
      const response = await this.marketsApi.getMarkets(
        200, // limit - fetch up to 200 to avoid pagination cutting off results
        undefined, // cursor
        undefined, // event_ticker
        seriesTicker, // series_ticker
        undefined, // max_close_ts
        undefined, // min_close_ts
        status, // status (optional - if undefined, gets all statuses)
        undefined  // tickers
      );
      return (response.data.markets || []) as unknown as KalshiMarket[];
    } catch (error: any) {
      console.error('[KALSHI] API Error:', error.response?.data || error.message);
      throw new Error(`Failed to get markets: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Get a specific market by ticker
   */
  async getMarket(ticker: string): Promise<KalshiMarket> {
    validateMarketTicker(ticker);
    try {
      const response = await this.marketApi.getMarket(ticker);
      return response.data.market as unknown as KalshiMarket;
    } catch (error: any) {
      throw new Error(`Failed to get market: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Place an order on Kalshi
   */
  async placeOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
    try {
      const response = await this.ordersApi.createOrder(request);
      return response.data;
    } catch (error: any) {
      throw new Error(`Failed to place order: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Cancel an order on Kalshi
   */
  async cancelOrder(orderId: string): Promise<void> {
    try {
      await this.ordersApi.cancelOrder(orderId);
    } catch (error: any) {
      throw new Error(`Failed to cancel order: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Get current positions
   */
  async getPositions(ticker?: string): Promise<any> {
    try {
      const response = await this.portfolioApi.getPositions(
        undefined, // cursor
        undefined, // limit
        undefined, // countFilter
        ticker,    // ticker filter
      );
      return response.data;
    } catch (error: any) {
      throw new Error(`Failed to get positions: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Get orders
   */
  async getOrders(ticker?: string, status?: string): Promise<any> {
    try {
      const response = await this.ordersApi.getOrders(
        ticker,     // ticker
        undefined,  // eventTicker
        undefined,  // minTs
        undefined,  // maxTs
        status,     // status
        undefined,  // limit
        undefined,  // cursor
      );
      return response.data;
    } catch (error: any) {
      throw new Error(`Failed to get orders: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Get order book depth for a market
   * Returns yes bids only (binary markets: YES_bid at X¢ ≡ NO_ask at (100−X)¢)
   */
  async getOrderBook(ticker: string, depth?: number): Promise<KalshiOrderBook> {
    try {
      const response = await this.marketApi.getMarketOrderbook(ticker, depth);
      const ob = response.data.orderbook;
      return {
        ticker,
        yes: ((ob['true'] as Array<Array<number>>) || []) as Array<[number, number]>,
        no: ((ob['false'] as Array<Array<number>>) || []) as Array<[number, number]>,
      };
    } catch (error: any) {
      throw new Error(`Failed to get order book: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Get all filled orders with structured fill data
   */
  async getFilledOrders(): Promise<Array<{
    orderId: string;
    ticker: string;
    side: 'yes' | 'no';
    action: 'buy' | 'sell';
    price: number; // cents
    contracts: number;
    fillTime: string;
  }>> {
    try {
      const response = await this.ordersApi.getOrders(
        undefined, // ticker
        undefined, // eventTicker
        undefined, // minTs
        undefined, // maxTs
        'filled',  // status
        100,       // limit
        undefined, // cursor
      );
      const orders: any[] = response.data.orders || [];
      return orders
        .filter((o: any) => o.fill_count > 0)
        .map((o: any) => ({
          orderId: o.order_id,
          ticker: o.ticker,
          side: o.side as 'yes' | 'no',
          action: o.action as 'buy' | 'sell',
          price: o.side === 'yes' ? o.yes_price : o.no_price,
          contracts: o.fill_count,
          fillTime: o.created_time || new Date().toISOString(),
        }));
    } catch (error: any) {
      throw new Error(`Failed to get filled orders: ${error.response?.data?.error?.message || error.message}`);
    }
  }
}

/**
 * Initialize the global Kalshi client
 */
export function initKalshiClient(apiKeyId: string, privateKeyPath: string, demoMode: boolean = false): void {
  clientInstance = new KalshiClient(apiKeyId, privateKeyPath, demoMode);
}

/**
 * Get the global Kalshi client instance
 */
export function getKalshiClient(): KalshiClient {
  if (!clientInstance) {
    throw new Error('Kalshi client not initialized. Call initKalshiClient() first.');
  }
  return clientInstance;
}
