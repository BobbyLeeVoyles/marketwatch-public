/**
 * Manual Trade Watcher
 *
 * Polls Kalshi every 5 minutes for filled orders not placed by any bot.
 * Detects manual trades placed via the Kalshi website/app and logs them.
 */

import { getKalshiClient } from '@/lib/kalshi/client';
import { logTradeToFile, loadBotOrderIds, recordBotOrderId } from './positionTracker';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let watcherInterval: NodeJS.Timeout | null = null;

async function checkForManualTrades(): Promise<void> {
  try {
    const client = getKalshiClient();
    const botOrderIds = loadBotOrderIds();

    const filledOrders = await client.getFilledOrders();

    for (const order of filledOrders) {
      if (botOrderIds.has(order.orderId)) {
        // Bot-placed order — skip
        continue;
      }

      // Not in bot-order-ids set → manual trade
      console.log(
        `[MANUAL WATCHER] Detected manual trade | ` +
        `OrderId: ${order.orderId} | ` +
        `Ticker: ${order.ticker} | ` +
        `${order.side.toUpperCase()} ${order.action} | ` +
        `Price: ${order.price}¢ | ` +
        `Contracts: ${order.contracts}`
      );

      // Log the manual trade
      logTradeToFile({
        id: order.orderId,
        timestamp: order.fillTime,
        strategy: 'manual',
        direction: order.side,
        entryPrice: order.price / 100,
        exitPrice: 0,
        exitType: 'pending',
        contracts: order.contracts,
        netPnL: 0,
        won: false,
        exitReason: `Manual trade detected (source: Kalshi website/app)`,
      });

      // Add to known set so we don't re-log it
      recordBotOrderId(order.orderId);
    }
  } catch (error) {
    console.error('[MANUAL WATCHER] Error checking for manual trades:', error);
  }
}

export function startManualTradeWatcher(): void {
  if (watcherInterval) {
    return; // Already running
  }

  console.log('[MANUAL WATCHER] Started — polling every 5 minutes for manual Kalshi fills');

  // Run immediately, then poll
  checkForManualTrades();
  watcherInterval = setInterval(checkForManualTrades, POLL_INTERVAL_MS);
}

export function stopManualTradeWatcher(): void {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
    console.log('[MANUAL WATCHER] Stopped');
  }
}
