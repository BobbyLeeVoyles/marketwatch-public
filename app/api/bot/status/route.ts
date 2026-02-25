/**
 * GET /api/bot/status
 *
 * Get status of all bots
 */

import { getInitializedOrchestrator } from '@/lib/utils/orchestratorInit';

export async function GET() {
  try {
    const orchestrator = await getInitializedOrchestrator();
    const status = orchestrator.getStatus();

    return Response.json(status);
  } catch (error) {
    console.error('[API] /bot/status error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to get bot status' },
      { status: 500 }
    );
  }
}
