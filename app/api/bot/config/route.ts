/**
 * POST /api/bot/config
 *
 * Update bot configuration (capital per trade, max daily loss, etc.)
 */

import { NextRequest } from 'next/server';
import { updateBotConfig, readBotConfig } from '@/lib/utils/botConfig';

const VALID_BOTS = ['conservative', 'aggressive', 'fifteenMin', 'grok15min', 'grokHourly', 'arb'] as const;
type ValidBot = typeof VALID_BOTS[number];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      bot,
      capitalPerTrade,
      maxDailyLoss,
      confidenceThreshold,
      maxContracts,
      minGapCents,
      momentumThreshold,
      maxEntryPriceCents,
      btcProximityDollars,
    } = body;

    if (!bot) {
      return Response.json({ error: 'Missing bot name' }, { status: 400 });
    }

    if (!VALID_BOTS.includes(bot as ValidBot)) {
      return Response.json(
        { error: `Invalid bot name. Must be one of: ${VALID_BOTS.join(', ')}` },
        { status: 400 }
      );
    }

    // Validate common fields
    if (capitalPerTrade !== undefined) {
      if (typeof capitalPerTrade !== 'number' || capitalPerTrade <= 0) {
        return Response.json({ error: 'capitalPerTrade must be a positive number' }, { status: 400 });
      }
    }

    if (maxDailyLoss !== undefined) {
      if (typeof maxDailyLoss !== 'number' || maxDailyLoss <= 0) {
        return Response.json({ error: 'maxDailyLoss must be a positive number' }, { status: 400 });
      }
    }

    if (confidenceThreshold !== undefined) {
      if (typeof confidenceThreshold !== 'number' || confidenceThreshold < 0 || confidenceThreshold > 100) {
        return Response.json({ error: 'confidenceThreshold must be 0–100' }, { status: 400 });
      }
    }

    if (maxContracts !== undefined) {
      if (typeof maxContracts !== 'number' || maxContracts <= 0) {
        return Response.json({ error: 'maxContracts must be a positive number' }, { status: 400 });
      }
    }

    if (minGapCents !== undefined) {
      if (typeof minGapCents !== 'number' || minGapCents < 0) {
        return Response.json({ error: 'minGapCents must be >= 0' }, { status: 400 });
      }
    }

    if (momentumThreshold !== undefined) {
      if (typeof momentumThreshold !== 'number' || momentumThreshold <= 0) {
        return Response.json({ error: 'momentumThreshold must be a positive number' }, { status: 400 });
      }
    }

    if (maxEntryPriceCents !== undefined) {
      if (typeof maxEntryPriceCents !== 'number' || maxEntryPriceCents <= 0) {
        return Response.json({ error: 'maxEntryPriceCents must be a positive number' }, { status: 400 });
      }
    }

    if (btcProximityDollars !== undefined) {
      if (typeof btcProximityDollars !== 'number' || btcProximityDollars <= 0) {
        return Response.json({ error: 'btcProximityDollars must be a positive number' }, { status: 400 });
      }
    }

    // Build updates object (only include defined fields)
    const updates: Record<string, number> = {};
    if (capitalPerTrade !== undefined) updates.capitalPerTrade = capitalPerTrade;
    if (maxDailyLoss !== undefined) updates.maxDailyLoss = maxDailyLoss;
    if (confidenceThreshold !== undefined) updates.confidenceThreshold = confidenceThreshold;
    if (maxContracts !== undefined) updates.maxContracts = maxContracts;
    if (minGapCents !== undefined) updates.minGapCents = minGapCents;
    if (momentumThreshold !== undefined) updates.momentumThreshold = momentumThreshold;
    if (maxEntryPriceCents !== undefined) updates.maxEntryPriceCents = maxEntryPriceCents;
    if (btcProximityDollars !== undefined) updates.btcProximityDollars = btcProximityDollars;

    updateBotConfig(bot as ValidBot, updates);

    const config = readBotConfig();

    return Response.json({
      success: true,
      config: config[bot as ValidBot],
    });
  } catch (error) {
    console.error('[API] /bot/config error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to update bot config' },
      { status: 500 }
    );
  }
}
