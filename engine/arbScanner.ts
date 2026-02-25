/**
 * Arb Scanner
 *
 * Scans open KXBTC and KXBTC15M markets for same-market pricing anomalies
 * (yesAsk + noAsk < 99¢) and logs them for review.
 *
 * NOTE: Kalshi nets same-market YES/NO positions against each other, so
 * "buy both sides" does NOT create two independent legs — buying NO when
 * you hold YES simply closes the YES position. This scanner therefore only
 * LOGS detected anomalies rather than placing orders, until a cross-market
 * or true two-leg arb approach is implemented.
 */

import { getKalshiClient } from '@/lib/kalshi/client';
import { readBotConfig } from '@/lib/utils/botConfig';

const SCAN_INTERVAL_MS = 60_000; // 60 seconds

// Series tickers to scan for arb opportunities
const ARB_SERIES = ['KXBTCD', 'KXBTC15M'];

interface ArbScannerState {
  running: boolean;
  intervalId?: NodeJS.Timeout;
  lastScanTime?: string;
  arbsFoundToday: number;
  profitCapturedToday: number;
  lastError?: string;
}

let scannerState: ArbScannerState | null = null;

async function runArbScan(): Promise<void> {
  const config = readBotConfig();
  if (!config.arb.enabled) return;

  const client = getKalshiClient();
  // NOTE: arbScanner is superseded by strikeSniper.ts — kept for reference only.
  const minGapCents = 1;
  const maxContracts = 20;

  console.log(`[ARB] Scanning ${ARB_SERIES.join(', ')} for arb opportunities...`);

  for (const series of ARB_SERIES) {
    try {
      const markets = await client.getMarkets(series, 'open');

      for (const market of markets) {
        const yesAskCents = market.yes_ask ?? 0;
        const noAskCents = market.no_ask ?? 0;

        if (yesAskCents <= 0 || noAskCents <= 0) continue;

        const totalCents = yesAskCents + noAskCents;
        const gapCents = 100 - totalCents;

        if (gapCents < minGapCents) continue;

        // Log the anomaly — do NOT place orders (Kalshi nets same-market positions)
        const expectedProfit = (gapCents / 100) * maxContracts;
        console.log(
          `[ARB] Pricing anomaly detected (log only): ${market.ticker} ` +
          `YES=${yesAskCents}¢ + NO=${noAskCents}¢ = ${totalCents}¢ | ` +
          `gap: ${gapCents}¢ | theoretical profit @ ${maxContracts} contracts: $${expectedProfit.toFixed(2)}`
        );

        if (scannerState) {
          scannerState.arbsFoundToday++;
        }
      }
    } catch (scanErr) {
      const msg = scanErr instanceof Error ? scanErr.message : String(scanErr);
      console.warn(`[ARB] Failed to scan ${series}: ${msg}`);
      if (scannerState) scannerState.lastError = msg;
    }
  }

  if (scannerState) {
    scannerState.lastScanTime = new Date().toISOString();
  }
}

export function startArbScanner(): void {
  if (scannerState?.running) {
    console.log('[ARB] Arb scanner already running');
    return;
  }

  scannerState = {
    running: true,
    arbsFoundToday: 0,
    profitCapturedToday: 0,
  };

  console.log('[ARB] Arb scanner started — scanning every 60s');

  // Run immediately, then on interval
  runArbScan();
  scannerState.intervalId = setInterval(runArbScan, SCAN_INTERVAL_MS);
}

export function stopArbScanner(): void {
  if (!scannerState?.running) return;

  if (scannerState.intervalId) {
    clearInterval(scannerState.intervalId);
    scannerState.intervalId = undefined;
  }

  scannerState.running = false;
  console.log('[ARB] Arb scanner stopped');
}

export function getArbScannerStatus() {
  if (!scannerState) {
    return {
      running: false,
      arbsFoundToday: 0,
      profitCapturedToday: 0,
    };
  }
  return {
    running: scannerState.running,
    lastScanTime: scannerState.lastScanTime,
    arbsFoundToday: scannerState.arbsFoundToday,
    profitCapturedToday: scannerState.profitCapturedToday,
    lastError: scannerState.lastError,
  };
}
