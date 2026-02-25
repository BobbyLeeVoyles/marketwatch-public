/**
 * Grok/xAI Client
 *
 * OpenAI-compatible client using xAI's API.
 * Used for AI-powered trading decisions on Kalshi binary markets.
 */

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

const GROK_LOG_FILE = path.join(process.cwd(), 'data', 'grok-log.json');
const GROK_LOG_MAX = 500; // keep last 500 entries

interface GrokLogEntry {
  timestamp: string;
  type: 'entry-decision' | 'exit-check';
  bot?: string;
  prompt: string;
  reasoning: string | null;  // chain-of-thought from reasoning models (null for non-reasoning)
  rawResponse: string;
  parsed: GrokDecision | GrokExitCheck | GrokMultiExitCheck | GrokSwingEntry;
  durationMs: number;
}

function appendGrokLog(entry: GrokLogEntry): void {
  try {
    let log: GrokLogEntry[] = [];
    if (fs.existsSync(GROK_LOG_FILE)) {
      try { log = JSON.parse(fs.readFileSync(GROK_LOG_FILE, 'utf-8')); } catch { log = []; }
    }
    log.push(entry);
    if (log.length > GROK_LOG_MAX) log = log.slice(-GROK_LOG_MAX);
    const dir = path.dirname(GROK_LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GROK_LOG_FILE, JSON.stringify(log, null, 2));
  } catch { /* never let logging break trading */ }
}

export interface GrokBet {
  side: 'yes' | 'no';
  ticker: string;   // must be from the adjacentStrikes list provided in prompt
  amount: number;   // $ to deploy on this leg
}

export interface GrokDecision {
  bets: GrokBet[];                          // empty array = SKIP (primary interface for hourly bot)
  decision: 'YES' | 'NO' | 'SKIP';         // kept for grok15min backward compat
  confidence: number;                       // 0–100
  reason: string;
  suggested_risk: 'low' | 'medium' | 'high';
}

export interface GrokExitCheck {
  action: 'HOLD' | 'EXIT';
  reason: string;          // max 10 words
}

export interface GrokMultiExitCheck {
  exits: Array<{ ticker: string; action: 'HOLD' | 'EXIT' }>;
}

export interface GrokSwingEntry {
  action: 'ENTER' | 'SKIP';
  side: 'yes' | 'no';
  ticker: string;
  reason: string;
}

const SAFE_SKIP: GrokDecision = {
  bets: [],
  decision: 'SKIP',
  confidence: 0,
  reason: 'API error — skipping',
  suggested_risk: 'low',
};

const SAFE_HOLD: GrokExitCheck = {
  action: 'HOLD',
  reason: 'API error — holding position',
};

function getXaiClient(): OpenAI {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error('XAI_API_KEY not set in environment');
  }
  return new OpenAI({
    apiKey,
    baseURL: 'https://api.x.ai/v1',
  });
}

function getModel(): string {
  return process.env.XAI_MODEL || 'grok-4-1-fast-non-reasoning';
}

function parseGrokDecision(content: string): GrokDecision {
  // Strip markdown code blocks if present
  const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(cleaned);

  // New multi-bet format: { bets: [...], confidence, reason, suggested_risk }
  if (Array.isArray(parsed.bets)) {
    for (const bet of parsed.bets) {
      if (!['yes', 'no'].includes(bet.side)) {
        throw new Error(`Invalid bet side: ${bet.side}`);
      }
      if (typeof bet.amount !== 'number' || bet.amount <= 0) {
        throw new Error(`Invalid bet amount: ${bet.amount}`);
      }
      if (!bet.ticker || typeof bet.ticker !== 'string') {
        throw new Error(`Invalid bet ticker: ${bet.ticker}`);
      }
    }
    if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 100) {
      throw new Error(`Invalid confidence: ${parsed.confidence}`);
    }
    if (!['low', 'medium', 'high'].includes(parsed.suggested_risk)) {
      throw new Error(`Invalid suggested_risk: ${parsed.suggested_risk}`);
    }

    const bets: GrokBet[] = parsed.bets.map((b: { side: string; ticker: string; amount: number }) => ({
      side: b.side as 'yes' | 'no',
      ticker: String(b.ticker),
      amount: Number(b.amount),
    }));

    // Derive decision field for backward compat
    const decision: 'YES' | 'NO' | 'SKIP' =
      bets.length === 0 ? 'SKIP' : bets[0].side === 'yes' ? 'YES' : 'NO';

    return {
      bets,
      decision,
      confidence: Math.round(parsed.confidence),
      reason: String(parsed.reason || '').slice(0, 500),
      suggested_risk: parsed.suggested_risk,
    };
  }

  // Old format: { decision: "YES"|"NO"|"SKIP", ... } — backward compat for grok15min bot
  if (!['YES', 'NO', 'SKIP'].includes(parsed.decision)) {
    throw new Error(`Invalid decision: ${parsed.decision}`);
  }
  if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 100) {
    throw new Error(`Invalid confidence: ${parsed.confidence}`);
  }
  if (!['low', 'medium', 'high'].includes(parsed.suggested_risk)) {
    throw new Error(`Invalid suggested_risk: ${parsed.suggested_risk}`);
  }

  return {
    bets: [],   // no ticker available in old format — grok15min bot uses decision field instead
    decision: parsed.decision,
    confidence: Math.round(parsed.confidence),
    reason: String(parsed.reason || '').slice(0, 500),
    suggested_risk: parsed.suggested_risk,
  };
}

function parseGrokExitCheck(content: string): GrokExitCheck {
  const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(cleaned);

  if (!['HOLD', 'EXIT'].includes(parsed.action)) {
    throw new Error(`Invalid action: ${parsed.action}`);
  }

  return {
    action: parsed.action,
    reason: String(parsed.reason || '').slice(0, 80),
  };
}

function parseGrokMultiExitCheck(content: string): GrokMultiExitCheck {
  const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed.exits)) {
    throw new Error('Missing exits array');
  }

  const exits: Array<{ ticker: string; action: 'HOLD' | 'EXIT' }> = [];
  for (const e of parsed.exits) {
    if (!['HOLD', 'EXIT'].includes(e.action)) {
      throw new Error(`Invalid action: ${e.action}`);
    }
    if (!e.ticker || typeof e.ticker !== 'string') {
      throw new Error(`Invalid ticker: ${e.ticker}`);
    }
    exits.push({ ticker: String(e.ticker), action: e.action });
  }

  return { exits };
}

function parseGrokSwingEntry(content: string): GrokSwingEntry {
  const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(cleaned);

  if (!['ENTER', 'SKIP'].includes(parsed.action)) {
    throw new Error(`Invalid action: ${parsed.action}`);
  }

  if (parsed.action === 'ENTER') {
    if (!['yes', 'no'].includes(parsed.side)) {
      throw new Error(`Invalid side for ENTER: ${parsed.side}`);
    }
    if (!parsed.ticker || typeof parsed.ticker !== 'string') {
      throw new Error(`Invalid ticker for ENTER: ${parsed.ticker}`);
    }
  }

  return {
    action: parsed.action,
    side: parsed.side === 'yes' ? 'yes' : 'no',
    ticker: String(parsed.ticker || ''),
    reason: String(parsed.reason || '').slice(0, 200),
  };
}

/**
 * Get a swing entry decision from Grok.
 * Response: {"action":"ENTER"|"SKIP","side":"yes"|"no","ticker":"<exact>","reason":"<20 words>"}
 * Retries up to 2 times. Returns SKIP on any error.
 */
export async function getGrokSwingEntry(prompt: string, bot?: string): Promise<GrokSwingEntry> {
  const client = getXaiClient();
  const model = getModel();

  const SAFE_SWING_SKIP: GrokSwingEntry = {
    action: 'SKIP',
    side: 'no',
    ticker: '',
    reason: 'API error — skipping',
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 400,
      });

      const message = response.choices[0]?.message;
      const content = message?.content;
      if (!content) throw new Error('Empty response from Grok');

      const reasoning = (message as unknown as Record<string, unknown>)?.reasoning_content as string | null ?? null;

      const parsed = parseGrokSwingEntry(content);
      appendGrokLog({
        timestamp: new Date().toISOString(),
        type: 'entry-decision',
        bot,
        prompt,
        reasoning,
        rawResponse: content,
        parsed,
        durationMs: Date.now() - t0,
      });

      if (reasoning) {
        console.log(`[GROK] Swing reasoning (${bot ?? 'unknown'}):\n${reasoning.slice(0, 400)}${reasoning.length > 400 ? '…' : ''}`);
      }

      return parsed;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[GROK] Swing entry attempt ${attempt}/2 failed: ${msg}`);
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  console.warn('[GROK] Swing entry failed — returning SKIP');
  return SAFE_SWING_SKIP;
}

/**
 * Get an entry decision from Grok for a Kalshi binary market trade.
 * Retries up to 3 times with 1s backoff. Returns SKIP on any error.
 */
export async function getGrokDecision(prompt: string, bot?: string): Promise<GrokDecision> {
  const client = getXaiClient();
  const model = getModel();

  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now();
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1000,  // reasoning models use tokens for chain-of-thought before outputting JSON
      });

      const message = response.choices[0]?.message;
      const content = message?.content;
      if (!content) throw new Error('Empty response from Grok');

      // reasoning_content is returned by reasoning models (xAI-specific field)
      const reasoning = (message as unknown as Record<string, unknown>)?.reasoning_content as string | null ?? null;

      const parsed = parseGrokDecision(content);
      appendGrokLog({
        timestamp: new Date().toISOString(),
        type: 'entry-decision',
        bot,
        prompt,
        reasoning,
        rawResponse: content,
        parsed,
        durationMs: Date.now() - t0,
      });

      if (reasoning) {
        console.log(`[GROK] Reasoning (${bot ?? 'unknown'}):\n${reasoning.slice(0, 600)}${reasoning.length > 600 ? '…' : ''}`);
      }

      return parsed;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[GROK] Decision attempt ${attempt}/3 failed: ${msg}`);
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  console.error('[GROK] All decision attempts failed — returning SKIP');
  return SAFE_SKIP;
}

/**
 * Lightweight exit check — called every 3 minutes during open positions.
 * Retries up to 2 times. Returns HOLD on any error.
 * Still used by grok15min bot.
 */
export async function getGrokExitCheck(prompt: string, bot?: string): Promise<GrokExitCheck> {
  const client = getXaiClient();
  const model = getModel();

  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 400,  // reasoning models use tokens for chain-of-thought before outputting JSON
      });

      const message = response.choices[0]?.message;
      const content = message?.content;
      if (!content) throw new Error('Empty response from Grok');

      const reasoning = (message as unknown as Record<string, unknown>)?.reasoning_content as string | null ?? null;

      const parsed = parseGrokExitCheck(content);
      appendGrokLog({
        timestamp: new Date().toISOString(),
        type: 'exit-check',
        bot,
        prompt,
        reasoning,
        rawResponse: content,
        parsed,
        durationMs: Date.now() - t0,
      });
      return parsed;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[GROK] Exit check attempt ${attempt}/2 failed: ${msg}`);
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  console.warn('[GROK] Exit check failed — defaulting to HOLD');
  return SAFE_HOLD;
}

/**
 * Multi-leg exit check — called every 3 minutes when multiple positions are open.
 * Evaluates all open legs and returns per-leg HOLD/EXIT decisions.
 * Retries up to 2 times. Returns { exits: [] } on any error (safe = hold everything).
 */
export async function getGrokMultiExitCheck(prompt: string, bot?: string): Promise<GrokMultiExitCheck> {
  const client = getXaiClient();
  const model = getModel();

  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 400,
      });

      const message = response.choices[0]?.message;
      const content = message?.content;
      if (!content) throw new Error('Empty response from Grok');

      const reasoning = (message as unknown as Record<string, unknown>)?.reasoning_content as string | null ?? null;

      const parsed = parseGrokMultiExitCheck(content);
      appendGrokLog({
        timestamp: new Date().toISOString(),
        type: 'exit-check',
        bot,
        prompt,
        reasoning,
        rawResponse: content,
        parsed,
        durationMs: Date.now() - t0,
      });
      return parsed;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[GROK] Multi-exit check attempt ${attempt}/2 failed: ${msg}`);
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  console.warn('[GROK] Multi-exit check failed — defaulting to hold all');
  return { exits: [] };
}
