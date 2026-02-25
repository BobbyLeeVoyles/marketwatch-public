/**
 * Bot Configuration Manager
 *
 * Manages bot configs (enable/disable, capital allocation, daily loss limits)
 */

import * as fs from 'fs';
import * as path from 'path';
import { BotConfig } from '@/lib/types';

const CONFIG_PATH = path.resolve('./data/bot-config.json');

export const DEFAULT_BOT_CONFIG: BotConfig = {
  conservative: {
    enabled: false,
    capitalPerTrade: 30,
    maxDailyLoss: 100,
  },
  aggressive: {
    enabled: false,
    capitalPerTrade: 20,
    maxDailyLoss: 80,
  },
  fifteenMin: {
    enabled: false,
    capitalPerTrade: 15,
    maxDailyLoss: 60,
  },
  grok15min: {
    enabled: false,
    confidenceThreshold: 57,
    capitalPerTrade: 3,
    maxDailyLoss: 10,
  },
  grokHourly: {
    enabled: false,
    confidenceThreshold: 57,
    capitalPerTrade: 3,
    maxDailyLoss: 10,
  },
  arb: {
    enabled: false,
    capitalPerTrade: 5,
    maxDailyLoss: 20,
    momentumThreshold: 0.8,   // % BTC move — backtest optimum (89 trades, Sharpe +47.98)
    maxEntryPriceCents: 15,   // max ¢ to pay — backtest optimum
    btcProximityDollars: 300, // $ from strike — backtest optimum (Sharpe +20.74)
  },
};

/**
 * Read bot config from disk
 */
export function readBotConfig(): BotConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      writeBotConfig(DEFAULT_BOT_CONFIG);
      return DEFAULT_BOT_CONFIG;
    }
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    const stored = JSON.parse(data) as Partial<BotConfig>;
    // Merge with defaults so new bots added in code are always present
    return {
      conservative: { ...DEFAULT_BOT_CONFIG.conservative, ...stored.conservative },
      aggressive:   { ...DEFAULT_BOT_CONFIG.aggressive,   ...stored.aggressive   },
      fifteenMin:   { ...DEFAULT_BOT_CONFIG.fifteenMin,   ...stored.fifteenMin   },
      grok15min:    { ...DEFAULT_BOT_CONFIG.grok15min,    ...stored.grok15min    },
      grokHourly:   { ...DEFAULT_BOT_CONFIG.grokHourly,   ...stored.grokHourly   },
      arb:          { ...DEFAULT_BOT_CONFIG.arb,           ...stored.arb          },
    };
  } catch (error) {
    console.error('[BOT CONFIG] Failed to read config:', error);
    return DEFAULT_BOT_CONFIG;
  }
}

/**
 * Write bot config to disk
 */
export function writeBotConfig(config: BotConfig): void {
  try {
    // Ensure data directory exists
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('[BOT CONFIG] Failed to write config:', error);
    throw error;
  }
}

/**
 * Update a single bot's config
 */
export function updateBotConfig(
  bot: keyof BotConfig,
  updates: Partial<BotConfig[typeof bot]>
): void {
  const config = readBotConfig();
  (config[bot] as any) = { ...(config[bot] as any), ...updates };
  writeBotConfig(config);
}
