/**
 * Telegram bot notification utility.
 *
 * Sends push notifications via Telegram Bot API — works even when
 * the user's phone screen is off (unlike browser PWA notifications).
 *
 * Setup:
 *   1. Message @BotFather on Telegram, create a bot, get the token
 *   2. Send /start to your bot
 *   3. Get your chat_id via: curl https://api.telegram.org/bot<TOKEN>/getUpdates
 *   4. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';

export function isTelegramConfigured(): boolean {
  return BOT_TOKEN.length > 0 && CHAT_ID.length > 0;
}

export async function sendTelegramNotification(message: string): Promise<boolean> {
  if (!isTelegramConfigured()) return false;

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
      }),
    });
    return res.ok;
  } catch (err) {
    console.error('[TELEGRAM] Failed to send notification:', err);
    return false;
  }
}

export function notifyBuy(
  direction: string,
  strike: number,
  maxPrice: number,
  btcPrice: number,
  reason: string
): Promise<boolean> {
  const dirLabel = direction === 'yes' ? 'YES' : 'NO';
  const aboveBelow = direction === 'yes' ? 'above' : 'below';
  return sendTelegramNotification(
    `🟢 *BUY ${dirLabel}*\n` +
    `Bitcoin ${aboveBelow} $${strike.toLocaleString()}\n` +
    `Max entry: ${(maxPrice * 100).toFixed(0)}¢\n` +
    `BTC: $${btcPrice.toLocaleString()}\n` +
    `_${reason}_`
  );
}

export function notifySell(
  direction: string,
  strike: number,
  btcPrice: number,
  reason: string,
  estimatedPnL?: number
): Promise<boolean> {
  const dirLabel = direction === 'yes' ? 'YES' : 'NO';
  const pnlStr = estimatedPnL !== undefined
    ? `\nEst P&L: ${estimatedPnL >= 0 ? '+' : ''}$${estimatedPnL.toFixed(2)}`
    : '';
  return sendTelegramNotification(
    `🔴 *SELL ${dirLabel}*\n` +
    `Strike $${strike.toLocaleString()}\n` +
    `BTC: $${btcPrice.toLocaleString()}${pnlStr}\n` +
    `_${reason}_`
  );
}

export function notifySettle(
  direction: string,
  strike: number,
  btcPrice: number,
  isWin: boolean,
  pnl: number
): Promise<boolean> {
  const dirLabel = direction === 'yes' ? 'YES' : 'NO';
  const icon = isWin ? '✅' : '❌';
  return sendTelegramNotification(
    `${icon} *SETTLEMENT ${isWin ? 'WIN' : 'LOSS'}*\n` +
    `${dirLabel} $${strike.toLocaleString()}\n` +
    `BTC: $${btcPrice.toLocaleString()}\n` +
    `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`
  );
}
