/**
 * GET  /api/bot/memory  — Returns precomputed memory summaries for all 3 Grok bots.
 * POST /api/bot/memory  — Appends an operator note to a bot's memory file.
 */

import { NextRequest } from 'next/server';
import { readBotMemory, appendOperatorNote } from '@/lib/ai/botMemory';

export const dynamic = 'force-dynamic';

const GROK_BOTS = ['grok15min', 'grokHourly', 'grokSwing'] as const;

export async function GET() {
  const result: Record<string, { summary: string; updatedAt: string }> = {};
  for (const botId of GROK_BOTS) {
    const mem = readBotMemory(botId);
    result[botId] = {
      summary: mem.summary || '',
      updatedAt: mem.summaryUpdatedAt || '',
    };
  }
  return Response.json(result);
}

export async function POST(req: NextRequest) {
  try {
    const { botId, note } = await req.json();
    if (!botId || !GROK_BOTS.includes(botId)) {
      return Response.json({ error: 'Invalid botId' }, { status: 400 });
    }
    if (!note || typeof note !== 'string' || !note.trim()) {
      return Response.json({ error: 'Invalid note' }, { status: 400 });
    }
    appendOperatorNote(botId, note.trim());
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}
