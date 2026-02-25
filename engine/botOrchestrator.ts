/**
 * Bot Orchestrator
 *
 * Central manager for all trading bots:
 * - Conservative hourly bot
 * - Aggressive hourly bot
 * - 15-minute bot
 * - Grok 15-minute AI bot
 * - Grok hourly AI bot
 * - Arbitrage scanner
 *
 * Singleton pattern with lifecycle management
 */

import { startHourlyBot, stopHourlyBot, getHourlyBotStatus } from './hourlyBot';
import { start15MinBot, stop15MinBot, get15MinBotStatus } from './fifteenMinBot';
import { startGrok15MinBot, stopGrok15MinBot, getGrok15MinBotStatus } from './grokFifteenMinBot';
import { startGrokHourlyBot, stopGrokHourlyBot, getGrokHourlyBotStatus } from './grokHourlyBot';
import { startArbScanner, stopArbScanner, getArbScannerStatus } from './strikeSniper';
import { startManualTradeWatcher, stopManualTradeWatcher } from './manualTradeWatcher';
import { initKalshiClient, getKalshiClient } from '@/lib/kalshi/client';
import { readBotConfig, updateBotConfig } from '@/lib/utils/botConfig';
import { startPriceFeed, stopPriceFeed, isConnected as isFeedConnected, startBtcPriceLog } from './btcFeed';

export interface BotStatus {
  running: boolean;
  startedAt?: string;
  dailyPnL: number;
  tradesCount: number;
  lastError?: string;
  hasPosition?: boolean;
}

export interface GrokBotStatus extends BotStatus {
  lastDecisions?: Array<{
    timestamp: string;
    decision: string;
    confidence: number;
    reason: string;
    suggestedRisk: string;
    ticker?: string;
  }>;
  position?: {
    ticker: string;
    side: string;
    contracts: number;
    entryPrice: number;
    totalCost: number;
    entryTime: string;
    btcPriceAtEntry: number;
    strike?: number;
  } | null;
}

export interface ArbScannerStatus {
  running: boolean;
  dailyPnL: number;
  tradesCount: number;
  hasFifteenMinPosition: boolean;
  hasHourlyPosition: boolean;
  lastTriggerDetail?: string;
  lastError?: string;
}

export interface OrchestratorStatus {
  initialized: boolean;
  kalshiConnected: boolean;
  priceFeedConnected: boolean;
  conservative: BotStatus;
  aggressive: BotStatus;
  fifteenMin: BotStatus;
  grok15min: GrokBotStatus;
  grokHourly: GrokBotStatus;
  arb: ArbScannerStatus;
}

type BotName = 'conservative' | 'aggressive' | 'fifteenMin' | 'grok15min' | 'grokHourly' | 'arb';

class BotOrchestrator {
  private static instance: BotOrchestrator | null = null;
  private initialized: boolean = false;

  private constructor() {}

  static getInstance(): BotOrchestrator {
    if (!BotOrchestrator.instance) {
      BotOrchestrator.instance = new BotOrchestrator();
    }
    return BotOrchestrator.instance;
  }

  /**
   * Initialize Kalshi client and price feed
   */
  async initialize(
    apiKeyId: string,
    privateKeyPath: string,
    demoMode: boolean = false
  ): Promise<void> {
    if (this.initialized) {
      console.log('[ORCHESTRATOR] Already initialized');
      return;
    }

    console.log('[ORCHESTRATOR] Initializing...');

    // Initialize Kalshi client
    try {
      initKalshiClient(apiKeyId, privateKeyPath, demoMode);
      const client = getKalshiClient();
      await client.testConnection();
      console.log('[ORCHESTRATOR] Kalshi client connected');
    } catch (error) {
      throw new Error(`Failed to initialize Kalshi client: ${error instanceof Error ? error.message : error}`);
    }

    // Start price feed
    try {
      await startPriceFeed();
      console.log('[ORCHESTRATOR] BTC price feed connected');
    } catch (error) {
      throw new Error(`Failed to start price feed: ${error instanceof Error ? error.message : error}`);
    }

    // Start continuous BTC price log (for pre-trade context)
    startBtcPriceLog();
    console.log('[ORCHESTRATOR] BTC price log started');

    // Start manual trade watcher (detects fills placed outside bots)
    startManualTradeWatcher();
    console.log('[ORCHESTRATOR] Manual trade watcher started');

    this.initialized = true;
    console.log('[ORCHESTRATOR] Initialization complete');

    // Auto-restart any bots that were running before the server restarted.
    // Bot enabled state persists in bot-config.json — this restores it on every cold start.
    this.startEnabledBots();
  }

  /**
   * Start a specific bot
   */
  startBot(bot: BotName): void {
    if (!this.initialized) {
      throw new Error('Orchestrator not initialized. Call initialize() first.');
    }

    const isDemoMode = process.env.KALSHI_DEMO_MODE === 'true';

    if (isDemoMode && (bot === 'conservative' || bot === 'aggressive')) {
      throw new Error(
        `${bot} bot requires KXBTCD markets which are not available in demo mode. ` +
        'Set KALSHI_DEMO_MODE=false to use production markets.'
      );
    }

    console.log(`[ORCHESTRATOR] Starting ${bot} bot...`);

    try {
      switch (bot) {
        case 'conservative':
        case 'aggressive':
          startHourlyBot(bot);
          break;
        case 'fifteenMin':
          start15MinBot();
          break;
        case 'grok15min':
          startGrok15MinBot();
          break;
        case 'grokHourly':
          startGrokHourlyBot();
          break;
        case 'arb':
          startArbScanner();
          break;
      }

      updateBotConfig(bot, { enabled: true });
      console.log(`[ORCHESTRATOR] ${bot} bot started`);
    } catch (error) {
      console.error(`[ORCHESTRATOR] Failed to start ${bot} bot:`, error);
      throw error;
    }
  }

  /**
   * Stop a specific bot
   */
  stopBot(bot: BotName): void {
    console.log(`[ORCHESTRATOR] Stopping ${bot} bot...`);

    try {
      switch (bot) {
        case 'conservative':
        case 'aggressive':
          stopHourlyBot(bot);
          break;
        case 'fifteenMin':
          stop15MinBot();
          break;
        case 'grok15min':
          stopGrok15MinBot();
          break;
        case 'grokHourly':
          stopGrokHourlyBot();
          break;
        case 'arb':
          stopArbScanner();
          break;
      }

      updateBotConfig(bot, { enabled: false });
      console.log(`[ORCHESTRATOR] ${bot} bot stopped`);
    } catch (error) {
      console.error(`[ORCHESTRATOR] Failed to stop ${bot} bot:`, error);
      throw error;
    }
  }

  /**
   * Get status of all bots
   */
  getStatus(): OrchestratorStatus {
    const isDemoMode = process.env.KALSHI_DEMO_MODE === 'true';
    const conservativeStatus = getHourlyBotStatus('conservative');
    const aggressiveStatus = getHourlyBotStatus('aggressive');

    if (isDemoMode) {
      if (conservativeStatus.running) {
        conservativeStatus.lastError = 'KXBTCD markets not available in demo mode';
      }
      if (aggressiveStatus.running) {
        aggressiveStatus.lastError = 'KXBTCD markets not available in demo mode';
      }
    }

    return {
      initialized: this.initialized,
      kalshiConnected: this.initialized,
      priceFeedConnected: isFeedConnected(),
      conservative: conservativeStatus,
      aggressive: aggressiveStatus,
      fifteenMin: get15MinBotStatus(),
      grok15min: getGrok15MinBotStatus(),
      grokHourly: getGrokHourlyBotStatus(),
      arb: getArbScannerStatus(),
    };
  }

  /**
   * Start all enabled bots (based on config)
   */
  startEnabledBots(): void {
    if (!this.initialized) {
      throw new Error('Orchestrator not initialized. Call initialize() first.');
    }

    console.log('[ORCHESTRATOR] Starting enabled bots...');

    const config = readBotConfig();
    const botsToStart: BotName[] = ['conservative', 'aggressive', 'fifteenMin', 'grok15min', 'grokHourly', 'arb'];

    for (const bot of botsToStart) {
      if (config[bot].enabled) {
        try {
          this.startBot(bot);
        } catch (error) {
          console.error(`[ORCHESTRATOR] Failed to start ${bot} bot:`, error);
        }
      }
    }

    console.log('[ORCHESTRATOR] Enabled bots started');
  }

  /**
   * Stop all running bots
   */
  stopAll(): void {
    console.log('[ORCHESTRATOR] Stopping all bots...');

    const status = this.getStatus();

    if (status.conservative.running) this.stopBot('conservative');
    if (status.aggressive.running) this.stopBot('aggressive');
    if (status.fifteenMin.running) this.stopBot('fifteenMin');
    if (status.grok15min.running) this.stopBot('grok15min');
    if (status.grokHourly.running) this.stopBot('grokHourly');
    if (status.arb.running) this.stopBot('arb');

    stopManualTradeWatcher();

    console.log('[ORCHESTRATOR] All bots stopped');
  }

  /**
   * Graceful shutdown (stop bots + price feed)
   */
  async shutdown(): Promise<void> {
    console.log('[ORCHESTRATOR] Shutting down...');

    this.stopAll();
    stopPriceFeed();

    await new Promise(resolve => setTimeout(resolve, 1000));

    this.initialized = false;
    console.log('[ORCHESTRATOR] Shutdown complete');
  }
}

// Export singleton instance getter
export function getBotOrchestrator(): BotOrchestrator {
  return BotOrchestrator.getInstance();
}
