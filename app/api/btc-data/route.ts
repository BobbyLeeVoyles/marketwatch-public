import { NextResponse } from 'next/server';
import { HourlyCandle } from '@/lib/types';
import { calculateIndicators } from '@/lib/utils/indicators';

export const dynamic = 'force-dynamic';

async function fetchFromBinanceUS(): Promise<{
  price: number;
  hourlyData: HourlyCandle[];
}> {
  const tickerRes = await fetch(
    'https://api.binance.us/api/v3/ticker/price?symbol=BTCUSDT',
    { next: { revalidate: 0 } }
  );
  if (!tickerRes.ok) throw new Error(`Binance US ticker: ${tickerRes.status}`);
  const ticker = await tickerRes.json();
  const price = parseFloat(ticker.price);

  const klinesRes = await fetch(
    'https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=12',
    { next: { revalidate: 0 } }
  );
  if (!klinesRes.ok) throw new Error(`Binance US klines: ${klinesRes.status}`);
  const klines = await klinesRes.json();

  const hourlyData: HourlyCandle[] = klines.map(
    (k: [number, string, string, string, string, string, ...unknown[]]) => ({
      timestamp: new Date(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5] as string),
    })
  );

  return { price, hourlyData };
}

async function fetchFromCoinGecko(): Promise<{
  price: number;
  hourlyData: HourlyCandle[];
}> {
  // CoinGecko free API - no key needed
  const priceRes = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    { next: { revalidate: 0 } }
  );
  if (!priceRes.ok) throw new Error(`CoinGecko price: ${priceRes.status}`);
  const priceData = await priceRes.json();
  const price = priceData.bitcoin.usd;

  // Fetch OHLC data (last 1 day gives ~6 candles at 4h intervals)
  const ohlcRes = await fetch(
    'https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=1',
    { next: { revalidate: 0 } }
  );
  if (!ohlcRes.ok) throw new Error(`CoinGecko OHLC: ${ohlcRes.status}`);
  const ohlc = await ohlcRes.json();

  const hourlyData: HourlyCandle[] = ohlc.slice(-12).map(
    (k: [number, number, number, number, number]) => ({
      timestamp: new Date(k[0]),
      open: k[1],
      high: k[2],
      low: k[3],
      close: k[4],
      volume: 0,
    })
  );

  return { price, hourlyData };
}

async function fetchBTCData(): Promise<{
  price: number;
  hourlyData: HourlyCandle[];
}> {
  // Try Binance US first (works from US servers)
  try {
    return await fetchFromBinanceUS();
  } catch (e) {
    console.warn('Binance US failed, trying CoinGecko:', e);
  }

  // Fallback to CoinGecko
  try {
    return await fetchFromCoinGecko();
  } catch (e) {
    console.warn('CoinGecko failed, trying Binance global:', e);
  }

  // Last resort: Binance global (may be blocked in US)
  const tickerRes = await fetch(
    'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    { next: { revalidate: 0 } }
  );
  const ticker = await tickerRes.json();
  const price = parseFloat(ticker.price);

  const klinesRes = await fetch(
    'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=12',
    { next: { revalidate: 0 } }
  );
  const klines = await klinesRes.json();

  const hourlyData: HourlyCandle[] = klines.map(
    (k: [number, string, string, string, string, string, ...unknown[]]) => ({
      timestamp: new Date(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5] as string),
    })
  );

  return { price, hourlyData };
}

export async function GET() {
  try {
    const { price, hourlyData } = await fetchBTCData();
    const indicators = calculateIndicators(hourlyData, price);

    return NextResponse.json({
      timestamp: new Date(),
      price,
      hourlyData,
      indicators,
    });
  } catch (error) {
    console.error('Failed to fetch BTC data:', error);
    return NextResponse.json(
      { error: 'Failed to fetch BTC data' },
      { status: 500 }
    );
  }
}
