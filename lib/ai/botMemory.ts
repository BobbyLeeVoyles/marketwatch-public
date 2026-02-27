/**
 * Bot Memory
 *
 * Lightweight per-bot learning memory. Each bot writes session observations
 * and reads back a precomputed statistical summary to inject into Grok prompts.
 *
 * Memory I/O is always fire-and-forget — the decision path is never blocked.
 * Files: data/{botId}-memory.json  (covered by data/*.json .gitignore rule)
 */

import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.resolve('./data');
const MAX_SESSIONS = 20;

export interface SessionRecord {
  windowKey: string;        // e.g. "2026-02-25-18-15"
  timestamp: string;        // ISO
  decision: string;         // "YES" | "NO" | "SKIP" | "ENTER" | "SKIP"
  reason: string;           // Grok's stated reason (first 60 chars)
  context: {
    btcPrice: number;
    velocity: number;       // $/min at decision time
    obi: number;            // bid/ask ratio
    rsi?: number;
    streak?: number;        // consecutive candle direction count
  };
  outcome?: 'WIN' | 'LOSS' | 'SKIP';
  pnl?: number;             // net P&L when known
}

export interface BotMemory {
  botId: string;
  sessions: SessionRecord[];
  summary: string;          // precomputed statistical summary
  summaryUpdatedAt: string;
  operatorNotes: string[];  // operator-written behavioral guidance (max 10)
}

function memoryFilePath(botId: string): string {
  return path.join(DATA_DIR, `${botId}-memory.json`);
}

export function readBotMemory(botId: string): BotMemory {
  try {
    const fp = memoryFilePath(botId);
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, 'utf8')) as BotMemory;
    }
  } catch { /* ignore */ }
  return { botId, sessions: [], summary: '', summaryUpdatedAt: '', operatorNotes: [] };
}

function writeBotMemory(mem: BotMemory): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const fp = memoryFilePath(mem.botId);
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(mem, null, 2));
    fs.renameSync(tmp, fp);
  } catch (e) {
    console.warn(`[BOT-MEMORY] Failed to write memory for ${mem.botId}:`, e);
  }
}

/** Append a new session record. Caps at MAX_SESSIONS. Non-blocking — call fire-and-forget. */
export function appendSession(botId: string, record: SessionRecord): void {
  const mem = readBotMemory(botId);
  // Avoid duplicate windowKey entries (idempotent on restart)
  const existingIdx = mem.sessions.findIndex(s => s.windowKey === record.windowKey);
  if (existingIdx !== -1) {
    mem.sessions[existingIdx] = record;
  } else {
    mem.sessions.push(record);
    if (mem.sessions.length > MAX_SESSIONS) {
      mem.sessions = mem.sessions.slice(-MAX_SESSIONS);
    }
  }
  refreshSummaryInternal(mem);
  writeBotMemory(mem);
}

/** Fill in the outcome for a previously appended session. Non-blocking — call fire-and-forget. */
export function updateOutcome(botId: string, windowKey: string, outcome: 'WIN' | 'LOSS', pnl: number): void {
  const mem = readBotMemory(botId);
  const session = mem.sessions.find(s => s.windowKey === windowKey);
  if (session) {
    session.outcome = outcome;
    session.pnl = pnl;
    refreshSummaryInternal(mem);
    writeBotMemory(mem);
  }
}

/** Recompute the summary string from current sessions and persist. */
export function refreshSummary(botId: string): void {
  const mem = readBotMemory(botId);
  refreshSummaryInternal(mem);
  writeBotMemory(mem);
}

function refreshSummaryInternal(mem: BotMemory): void {
  const sessions = mem.sessions;
  const trades = sessions.filter(s => s.outcome === 'WIN' || s.outcome === 'LOSS');
  const skips = sessions.filter(s => s.outcome === 'SKIP').length;
  const wins = trades.filter(s => s.outcome === 'WIN');
  const losses = trades.filter(s => s.outcome === 'LOSS');
  const n = sessions.length;

  if (n < 5) {
    mem.summary = 'Insufficient history (<5 sessions) — no pattern guidance yet.';
    mem.summaryUpdatedAt = new Date().toISOString();
    return;
  }

  const confidenceNote = n < 10 ? 'low confidence — calibrating' : `${n} sessions — moderate confidence`;
  const winRateStr = trades.length > 0
    ? `${wins.length}/${trades.length} trades (${Math.round(wins.length / trades.length * 100)}%)`
    : 'no closed trades';

  const avgWinPnl = wins.length > 0
    ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length
    : 0;
  const avgLossPnl = losses.length > 0
    ? losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length
    : 0;

  const avgWinStr = wins.length > 0 ? `+$${avgWinPnl.toFixed(2)}` : 'n/a';
  const avgLossStr = losses.length > 0 ? `$${avgLossPnl.toFixed(2)}` : 'n/a';

  // Win correlations
  const winCorrelations: string[] = [];
  if (wins.length >= 2) {
    const avgWinVel = wins.reduce((s, t) => s + Math.abs(t.context.velocity), 0) / wins.length;
    const streakWins = wins.filter(t => t.context.streak !== undefined);
    const avgWinStreak = streakWins.length > 0
      ? streakWins.reduce((s, t) => s + (t.context.streak ?? 0), 0) / streakWins.length
      : 0;
    if (avgWinVel > 30) winCorrelations.push(`velocity > ${Math.round(avgWinVel)}$/min`);
    if (avgWinStreak >= 2) winCorrelations.push(`streak >= ${Math.round(avgWinStreak)} directional candles`);
  }

  // Loss correlations
  const lossCorrelations: string[] = [];
  if (losses.length >= 2) {
    const obiRsiLosses = losses.filter(t => t.context.obi < 0.40 && (t.context.rsi ?? 0) > 65).length;
    if (obiRsiLosses >= 2) {
      lossCorrelations.push(`OBI < 0.40 when RSI > 65 (${obiRsiLosses} of ${losses.length} losses)`);
    }
  }

  // Recent streak check (last 3 sessions with outcomes)
  const recentWithOutcome = sessions.filter(s => s.outcome === 'WIN' || s.outcome === 'LOSS').slice(-3);
  const recentLosses = recentWithOutcome.filter(s => s.outcome === 'LOSS').length;
  const recentNote = recentLosses >= 2 ? `${recentLosses} of last 3 trades were losses — be selective` : '';

  let summary = `Bot memory (last ${n} sessions):\n`;
  summary += `Win rate: ${winRateStr} | Avg win ${avgWinStr} | Avg loss ${avgLossStr} | ${skips} SKIPs\n`;
  if (winCorrelations.length > 0) summary += `Wins correlated with: ${winCorrelations.join(', ')}\n`;
  if (lossCorrelations.length > 0) summary += `Losses correlated with: ${lossCorrelations.join(', ')}\n`;
  if (recentNote) summary += `Recent: ${recentNote}\n`;
  summary += `[Note: ${confidenceNote}. Treat as weak prior context, not a strategy override.]`;

  mem.summary = summary;
  mem.summaryUpdatedAt = new Date().toISOString();
}

/** Get the precomputed summary string to inject into a Grok prompt. */
export function getMemorySummary(botId: string): string {
  const mem = readBotMemory(botId);
  const base = mem.summary || 'Insufficient history (<5 sessions) — no pattern guidance yet.';
  const notes = mem.operatorNotes ?? [];
  if (notes.length === 0) return base;
  const notesStr = notes.map(n => `  • ${n}`).join('\n');
  return `${base}\n\nOperator guidance (follow unless contradicted by strong market signal):\n${notesStr}`;
}

/** Append an operator note to the bot's memory. Caps at 10, oldest dropped. */
export function appendOperatorNote(botId: string, note: string): void {
  const mem = readBotMemory(botId);
  const notes = [...(mem.operatorNotes ?? []), note].slice(-10);
  writeBotMemory({ ...mem, operatorNotes: notes });
}
