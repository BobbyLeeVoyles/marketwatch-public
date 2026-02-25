/**
 * GET /api/grok-log
 *
 * Returns the last N Grok decision log entries from data/grok-log.json.
 * Query params:
 *   ?limit=50        — number of entries to return (default 50, max 500)
 *   ?bot=grok15min   — filter by bot name
 *   ?type=entry-decision|exit-check  — filter by call type
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const GROK_LOG_FILE = path.join(process.cwd(), 'data', 'grok-log.json');

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 500);
    const botFilter = searchParams.get('bot');
    const typeFilter = searchParams.get('type');

    if (!fs.existsSync(GROK_LOG_FILE)) {
      return NextResponse.json({ entries: [], total: 0, message: 'No Grok log yet — bots have not run' });
    }

    let entries = JSON.parse(fs.readFileSync(GROK_LOG_FILE, 'utf-8'));

    if (botFilter) entries = entries.filter((e: { bot?: string }) => e.bot === botFilter);
    if (typeFilter) entries = entries.filter((e: { type: string }) => e.type === typeFilter);

    const total = entries.length;
    // Return most recent first
    const sliced = entries.slice(-limit).reverse();

    return NextResponse.json({ entries: sliced, total });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read Grok log' },
      { status: 500 }
    );
  }
}
