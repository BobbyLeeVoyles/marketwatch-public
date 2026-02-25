/**
 * Orchestrator Auto-Initialization
 *
 * Ensures the bot orchestrator is initialized before use
 */

import { getBotOrchestrator } from '@/engine/botOrchestrator';

let initPromise: Promise<void> | null = null;
let isInitialized = false;

/**
 * Initialize the bot orchestrator with environment variables
 * Returns the initialized orchestrator
 */
export async function getInitializedOrchestrator() {
  const orchestrator = getBotOrchestrator();

  // If already initialized, return immediately
  if (isInitialized) {
    return orchestrator;
  }

  // If initialization is in progress, wait for it
  if (initPromise) {
    await initPromise;
    return orchestrator;
  }

  // Start initialization
  initPromise = (async () => {
    try {
      console.log('[INIT] Initializing bot orchestrator...');

      const apiKeyId = process.env.KALSHI_API_KEY_ID;
      const privateKeyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
      const demoMode = process.env.KALSHI_DEMO_MODE === 'true';

      if (!apiKeyId || !privateKeyPath) {
        throw new Error('Missing Kalshi API credentials in environment variables');
      }

      await orchestrator.initialize(apiKeyId, privateKeyPath, demoMode);
      isInitialized = true;

      console.log('[INIT] Bot orchestrator initialized successfully');
    } catch (error) {
      initPromise = null; // Reset so it can be retried
      throw error;
    }
  })();

  await initPromise;
  return orchestrator;
}
