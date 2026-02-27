/**
 * POST /api/bot/chat
 *
 * Body: { botId: string, question: string }
 * Returns: { answer: string }
 *
 * Asks a Grok bot a question in character, contextualized with its memory summary
 * and last 5 entry decisions from grok-log.json.
 */

import { NextRequest } from 'next/server';
import { getGrokChat } from '@/lib/ai/grokClient';
import { buildBotChatPrompt } from '@/lib/ai/grokPrompts';
import { getMemorySummary } from '@/lib/ai/botMemory';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const VALID_BOT_IDS = ['grok15min', 'grokHourly', 'grokSwing'] as const;
const GROK_LOG_FILE = path.join(process.cwd(), 'data', 'grok-log.json');

// grokSwingBot logs under 'grokSwing' or 'grokSpikeOtm'
const BOT_LOG_ALIASES: Record<string, string[]> = {
  grokSwing: ['grokSwing', 'grokSpikeOtm'],
};

interface RawLogEntry {
  timestamp: string;
  type: string;
  bot?: string;
  parsed?: {
    decision?: string;
    action?: string;
    confidence?: number;
    reason?: string;
  };
}

function loadRecentDecisions(
  botId: string,
  limit: number,
): Array<{ timestamp: string; decision: string; confidence?: number; reason?: string }> {
  try {
    if (!fs.existsSync(GROK_LOG_FILE)) return [];
    const entries: RawLogEntry[] = JSON.parse(fs.readFileSync(GROK_LOG_FILE, 'utf-8'));
    const aliases = BOT_LOG_ALIASES[botId] ?? [botId];
    return entries
      .filter(e => e.type === 'entry-decision' && e.bot && aliases.includes(e.bot) && e.parsed)
      .slice(-limit)
      .map(e => ({
        timestamp: e.timestamp,
        decision: e.parsed?.decision ?? e.parsed?.action ?? 'UNKNOWN',
        confidence: e.parsed?.confidence,
        reason: e.parsed?.reason,
      }));
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  try {
    const { botId, question } = await req.json();

    if (!botId || !VALID_BOT_IDS.includes(botId)) {
      return Response.json({ error: 'Invalid botId' }, { status: 400 });
    }
    if (!question || typeof question !== 'string' || !question.trim()) {
      return Response.json({ error: 'Invalid question' }, { status: 400 });
    }

    const memorySummary = getMemorySummary(botId);
    const recentDecisions = loadRecentDecisions(botId, 5);
    const prompt = buildBotChatPrompt({ botId, question: question.trim(), memorySummary, recentDecisions });
    const answer = await getGrokChat(prompt, botId);

    return Response.json({ answer });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 });
  }
}
