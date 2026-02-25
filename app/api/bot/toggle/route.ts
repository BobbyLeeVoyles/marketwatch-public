/**
 * POST /api/bot/toggle
 *
 * Toggle a bot on/off
 */

import { NextRequest } from 'next/server';
import { getInitializedOrchestrator } from '@/lib/utils/orchestratorInit';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { bot, enabled } = body;

    if (!bot || typeof enabled !== 'boolean') {
      return Response.json(
        { error: 'Invalid request body. Expected: { bot: string, enabled: boolean }' },
        { status: 400 }
      );
    }

    const validBots = ['conservative', 'aggressive', 'fifteenMin', 'grok15min', 'grokHourly', 'arb'];
    if (!validBots.includes(bot)) {
      return Response.json(
        { error: `Invalid bot name. Must be one of: ${validBots.join(', ')}` },
        { status: 400 }
      );
    }

    const orchestrator = await getInitializedOrchestrator();

    if (enabled) {
      orchestrator.startBot(bot);
    } else {
      orchestrator.stopBot(bot);
    }

    const status = orchestrator.getStatus();

    return Response.json({
      success: true,
      status: status[bot as keyof typeof status],
    });
  } catch (error) {
    console.error('[API] /bot/toggle error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to toggle bot' },
      { status: 500 }
    );
  }
}
