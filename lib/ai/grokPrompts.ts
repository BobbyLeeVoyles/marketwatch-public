/**
 * Grok Prompt Templates
 *
 * Prompt builders for 15-min and hourly Grok bots.
 * Designed to surface signals the algo cannot see:
 * social sentiment, funding rate, order book imbalance,
 * adjacent strike mispricing, session context, wick analysis.
 */

import { HourlyCandle, FiveMinCandle } from '@/lib/types';
import { FundingRateData, OrderBookImbalance } from '@/engine/btcFeed';

interface AlgoSignalContext {
  signal: 'YES' | 'NO' | 'SKIP';
  reason: string;
  confidence: number;
}

interface AdjacentStrike {
  ticker: string;
  strike: number;
  yesAsk: number; // cents
  noAsk?: number; // cents — required for hourly multi-bet; omitted by 15-min bot
}

// Format a candle table (oldest → newest)
function formatCandleTable(candles: FiveMinCandle[], label: string): string {
  if (candles.length === 0) return `${label}: no data`;
  return candles
    .slice(-15)
    .map(c => {
      const dir = c.close >= c.open ? '▲' : '▼';
      const wickUp = ((c.high - Math.max(c.open, c.close)) / c.open * 100).toFixed(2);
      const wickDn = ((Math.min(c.open, c.close) - c.low) / c.open * 100).toFixed(2);
      return `  ${new Date(c.timestamp).toISOString().substr(11, 5)} O:${c.open.toFixed(0)} H:${c.high.toFixed(0)} L:${c.low.toFixed(0)} C:${c.close.toFixed(0)} ${dir} UW:${wickUp}% DW:${wickDn}%`;
    })
    .join('\n');
}

function formatHourlyTable(candles: HourlyCandle[]): string {
  if (candles.length === 0) return 'no data';
  return candles
    .slice(-10)
    .map(c => {
      const dir = c.close >= c.open ? '▲' : '▼';
      return `  ${new Date(c.timestamp).toISOString().substr(11, 5)} O:${c.open.toFixed(0)} H:${c.high.toFixed(0)} L:${c.low.toFixed(0)} C:${c.close.toFixed(0)} ${dir} Vol:${c.volume.toFixed(1)}`;
    })
    .join('\n');
}

function formatAdjacentStrikes(strikes: AdjacentStrike[]): string {
  if (strikes.length === 0) return 'unavailable';
  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);

  const lines: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const noAskStr = s.noAsk !== undefined ? '  NO ask: ' + s.noAsk + '¢' : '';
    lines.push('  ' + s.ticker + '  ($' + s.strike.toLocaleString() + ')  YES ask: ' + s.yesAsk + '¢' + noAskStr);

    // Show straddle and breakout costs between adjacent pairs (only when both sides available)
    if (i < sorted.length - 1) {
      const next = sorted[i + 1];
      if (s.noAsk !== undefined && next.noAsk !== undefined) {
        // Straddle: YES on lower strike + NO on upper strike → pays if BTC stays in range
        const straddleCost = s.yesAsk + next.noAsk;
        // Breakout: NO on lower strike + YES on upper strike → pays if BTC breaks hard
        const breakoutCost = s.noAsk + next.yesAsk;
        lines.push(
          '    [straddle $' + s.strike.toLocaleString() + '–$' + next.strike.toLocaleString() +
          ' costs ' + straddleCost + '¢/contract; breakout costs ' + breakoutCost + '¢/contract]'
        );
      }
    }
  }

  // Flag inversions (lower strike YES priced BELOW higher strike YES — pricing error)
  const inversions: string[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].yesAsk < sorted[i + 1].yesAsk) {
      inversions.push(
        '  ⚠ PRICING ERROR: $' + sorted[i].strike + ' YES=' + sorted[i].yesAsk +
        '¢ < $' + sorted[i + 1].strike + ' YES=' + sorted[i + 1].yesAsk + '¢'
      );
    }
  }
  if (inversions.length > 0) {
    lines.push(...inversions);
  }

  return lines.join('\n');
}

export interface Build15MinPromptParams {
  utcTime: string;
  ticker: string;
  btcPrice: number;
  btcChange24h: number;
  fundingRate: FundingRateData | null;
  orderBookImbalance: OrderBookImbalance | null;
  yesMid: number;   // cents
  yesProb: number;  // %
  noMid: number;    // cents
  noProb: number;   // %
  adjacentStrikes: AdjacentStrike[];
  oneMinCandles: FiveMinCandle[];
  rsi: number;
  bbWidth: number;
  emaDiff: number;
  volatility: number;
  atr: number;
  regime: string;
  volumeRatio: number;
  algoSignal: AlgoSignalContext;
}

export function build15MinPrompt(p: Build15MinPromptParams): string {
  const fundingStr = p.fundingRate
    ? `${p.fundingRate.ratePercent} (next: ${p.fundingRate.nextFundingTime.substr(11, 5)} UTC)`
    : 'unavailable';

  const obiStr = p.orderBookImbalance
    ? `${p.orderBookImbalance.bidPct}% bid / ${p.orderBookImbalance.askPct}% ask (ratio: ${p.orderBookImbalance.imbalance.toFixed(2)})`
    : 'unavailable';

  return `You are a BTC binary prediction market trader on Kalshi.
Determine whether the next 15-minute KXBTC contract should be YES or NO.
Make your own independent judgment — the algo signal below is context, not instruction.

UTC time: ${p.utcTime}
Ticker: ${p.ticker}
BTC spot: $${p.btcPrice.toFixed(2)}  |  24h change: ${p.btcChange24h >= 0 ? '+' : ''}${p.btcChange24h.toFixed(2)}%

── MARKET MICROSTRUCTURE ──
Funding rate: ${fundingStr}
  [Positive = longs paying shorts = bearish pressure. Negative = shorts paying longs = bullish pressure.]
BTC order book imbalance (top 20 levels): ${obiStr}
  [>1 bid/ask ratio = bid-heavy = bullish pressure]
Kalshi YES mid: ${p.yesMid}¢ (${p.yesProb.toFixed(1)}%)  NO mid: ${p.noMid}¢ (${p.noProb.toFixed(1)}%)

── ADJACENT STRIKES (check for pricing errors) ──
${formatAdjacentStrikes(p.adjacentStrikes)}
  [Lower strike YES should always be priced HIGHER than higher strike YES — any inversion is a pricing error]

── PRICE ACTION (last 15 one-minute candles, oldest → newest) ──
  [UW = upper wick %, DW = lower wick % — long wicks = rejection signals]
${formatCandleTable(p.oneMinCandles, '1m candles')}

── TECHNICAL INDICATORS ──
RSI(7): ${p.rsi.toFixed(1)}  |  BB width: ${(p.bbWidth * 100).toFixed(3)}%  |  EMA diff: ${(p.emaDiff * 100).toFixed(4)}%
Volatility: ${p.volatility.toFixed(2)}%  |  ATR: $${p.atr.toFixed(0)}  |  Regime: ${p.regime}
Volume ratio (last vs avg): ${p.volumeRatio.toFixed(2)}x

── ALGO SIGNAL (context only — you make the final call) ──
Signal: ${p.algoSignal.signal} — "${p.algoSignal.reason}" — confidence: ${p.algoSignal.confidence}%

Use your X search tool to check BTC sentiment in the last 5–10 minutes if it would help.
Look for exchange news, whale moves, regulatory announcements, or macro sentiment shifts.

Session context: ${getSessionContext(new Date(p.utcTime))}

Respond ONLY with valid JSON — no markdown, no extra text:
{"decision":"YES"|"NO"|"SKIP","confidence":0-100,"reason":"<50 words — explain the key signals that drove this decision>","suggested_risk":"low"|"medium"|"high"}`;
}

export interface BuildHourlyPromptParams {
  utcTime: string;
  btcPrice: number;
  btcChange24h: number;
  fundingRate: FundingRateData | null;
  orderBookImbalance: OrderBookImbalance | null;
  adjacentStrikes: AdjacentStrike[];
  hourlyCandles: HourlyCandle[];
  rsi: number;
  bbWidth: number;
  emaDiff: number;
  volatility: number;
  atr: number;
  volumeRatio: number;
  minutesRemaining: number;
  algoSignal: AlgoSignalContext;
  capitalBudget: number;          // $ remaining to deploy this cycle
  currentPositions: Array<{       // already-open legs (so Grok knows what's on)
    side: 'yes' | 'no';
    ticker: string;
    contracts: number;
    entryPrice: number;           // dollars
    unrealizedPnL: number;
  }>;
}

export function buildHourlyPrompt(p: BuildHourlyPromptParams): string {
  const fundingStr = p.fundingRate
    ? `${p.fundingRate.ratePercent} (next: ${p.fundingRate.nextFundingTime.substr(11, 5)} UTC)`
    : 'unavailable';

  const obiStr = p.orderBookImbalance
    ? `${p.orderBookImbalance.bidPct}% bid / ${p.orderBookImbalance.askPct}% ask (ratio: ${p.orderBookImbalance.imbalance.toFixed(2)})`
    : 'unavailable';

  const openPositionsStr = p.currentPositions.length === 0
    ? 'none'
    : p.currentPositions.map(pos =>
        `  ${pos.side.toUpperCase()} ${pos.ticker} — ${pos.contracts} contracts @ ${(pos.entryPrice * 100).toFixed(0)}¢ | P&L: ${pos.unrealizedPnL >= 0 ? '+' : ''}$${pos.unrealizedPnL.toFixed(2)}`
      ).join('\n');

  return `You are a BTC binary prediction market trader on Kalshi managing a $${p.capitalBudget.toFixed(2)} budget this cycle.
You may place one or more bets. Available strategies:

  DIRECTIONAL YES — buy YES on a strike; pays $1/contract if BTC closes ABOVE strike
  DIRECTIONAL NO  — buy NO on a strike; pays $1/contract if BTC closes BELOW strike
  STRADDLE        — buy YES on lower strike + NO on upper strike (profits if BTC stays in range)
  BREAKOUT        — buy NO on lower strike + YES on upper strike (profits if BTC breaks hard)
  SKIP            — place no bets (return "bets": [])

Make your own independent judgment — the algo signal is context, not instruction.

UTC time: ${p.utcTime}  |  Minutes remaining this hour: ${p.minutesRemaining}
BTC spot: $${p.btcPrice.toFixed(2)}  |  24h change: ${p.btcChange24h >= 0 ? '+' : ''}${p.btcChange24h.toFixed(2)}%

── AVAILABLE MARKETS (use exactly these tickers in your response) ──
${formatAdjacentStrikes(p.adjacentStrikes)}
  [Lower strike YES should always be priced HIGHER than higher strike YES — any inversion is a pricing error]

── CAPITAL BUDGET ──
Remaining this cycle: $${p.capitalBudget.toFixed(2)}  (minimum $1.00 per leg)

── OPEN POSITIONS THIS CYCLE ──
${openPositionsStr}

── MARKET MICROSTRUCTURE ──
Funding rate: ${fundingStr}
  [For 60-minute exposure, funding rate carries more weight than 15-min trades]
BTC order book imbalance (top 20 levels): ${obiStr}

── HOURLY PRICE ACTION (last 10 candles, oldest → newest) ──
${formatHourlyTable(p.hourlyCandles)}

── TECHNICAL INDICATORS ──
RSI(7): ${p.rsi.toFixed(1)}  |  BB width: ${(p.bbWidth * 100).toFixed(3)}%  |  EMA diff: ${(p.emaDiff * 100).toFixed(4)}%
Volatility: ${p.volatility.toFixed(2)}%  |  ATR: $${p.atr.toFixed(0)}
Volume ratio: ${p.volumeRatio.toFixed(2)}x

── ALGO SIGNAL (context only) ──
Signal: ${p.algoSignal.signal} — "${p.algoSignal.reason}" — confidence: ${p.algoSignal.confidence}%

Use your X search tool to check BTC sentiment in the last 30 minutes.
Look for news, whale moves, and macro events that could move price by the hour close.

Session context: ${getSessionContext(new Date(p.utcTime))}

Respond ONLY with valid JSON — no markdown, no extra text:
{"bets":[{"side":"yes|no","ticker":"<exact ticker>","amount":<dollars>},...],"confidence":0-100,"reason":"<50 words>","suggested_risk":"low"|"medium"|"high"}
For no trade: {"bets":[],"confidence":0,"reason":"...","suggested_risk":"low"}
CONSTRAINT: sum of all bet amounts must not exceed $${p.capitalBudget.toFixed(2)}`;
}

export interface BuildExitPromptParams {
  strategy: string;
  direction: 'yes' | 'no';
  ticker: string;
  entryPrice: number;  // dollars
  contracts: number;
  unrealizedPnL: number;
  minsRemaining: number;
  btcPrice: number;
  entryBtcPrice: number;
  currentBid: number;  // cents
  winProb: number;     // %
  suggestedRisk: 'low' | 'medium' | 'high';
}

export function buildExitPrompt(p: BuildExitPromptParams): string {
  const btcMove = p.btcPrice - p.entryBtcPrice;
  return `Open position: ${p.strategy} ${p.direction.toUpperCase()} on ${p.ticker}
Entry: ${(p.entryPrice * 100).toFixed(0)}¢ × ${p.contracts} contracts | P&L: ${p.unrealizedPnL >= 0 ? '+' : ''}$${p.unrealizedPnL.toFixed(2)}
Minutes remaining: ${p.minsRemaining.toFixed(1)}
Current BTC: $${p.btcPrice.toFixed(2)} (vs entry $${p.entryBtcPrice.toFixed(2)}, move: ${btcMove >= 0 ? '+' : ''}$${btcMove.toFixed(0)})
Current bid: ${p.currentBid}¢ | Win prob: ${p.winProb.toFixed(1)}%
Entry risk profile: ${p.suggestedRisk}

Should this position be held or exited now?
Respond only: {"action":"HOLD"|"EXIT","reason":"<10 words>"}`;
}

export interface BuildMultiExitPromptParams {
  legs: Array<{
    ticker: string;
    side: 'yes' | 'no';
    contracts: number;
    entryPrice: number;     // dollars
    unrealizedPnL: number;
    currentBid: number;     // cents
    winProb: number;        // %
    minsRemaining: number;
    strike?: number;        // strike price in dollars (KXBTCD hourly markets)
  }>;
  btcPrice: number;
  suggestedRisk: 'low' | 'medium' | 'high';
}

export function buildMultiExitPrompt(p: BuildMultiExitPromptParams): string {
  const legsStr = p.legs.map((leg, i) => {
    const entryPriceCents = leg.entryPrice * 100;

    // Capture rate: fraction of the maximum possible gain already secured.
    // e.g. entry 25¢, current bid 60¢ → (60-25)/(100-25) = 46.7%
    const captureRate = leg.currentBid > entryPriceCents
      ? Math.round((leg.currentBid - entryPriceCents) / (100 - entryPriceCents) * 100)
      : 0;

    // Strike distance line (only when strike is known)
    let strikeLine = '';
    if (leg.strike && leg.strike > 0) {
      // Positive = BTC is on the winning side of the strike; negative = losing side
      const favorDist = leg.side === 'yes'
        ? p.btcPrice - leg.strike      // YES wins when BTC > strike
        : leg.strike - p.btcPrice;     // NO  wins when BTC < strike

      const absDist = Math.abs(favorDist);
      const distPct = (absDist / leg.strike * 100).toFixed(2);
      const positionStr = favorDist >= 0
        ? `$${absDist.toFixed(0)} ITM (${distPct}% above strike)`
        : `$${absDist.toFixed(0)} OTM (${distPct}% below strike)`;

      const riskLabel = absDist < 300  ? ' <- HIGH reversal risk'
                      : absDist < 800  ? ' <- moderate reversal risk'
                      :                  ' <- lower reversal risk';

      strikeLine = `\n      Strike: $${leg.strike.toLocaleString()} | BTC margin: ${positionStr}${riskLabel}`;
    }

    return (
      `  [${i + 1}] ${leg.side.toUpperCase()} ${leg.ticker}\n` +
      `      Entry: ${entryPriceCents.toFixed(0)}¢ x ${leg.contracts} contracts | ` +
      `P&L: ${leg.unrealizedPnL >= 0 ? '+' : ''}$${leg.unrealizedPnL.toFixed(2)} | ` +
      `${leg.minsRemaining.toFixed(1)}m remaining\n` +
      `      Current bid: ${leg.currentBid}¢ | Win prob: ${leg.winProb.toFixed(1)}% | ` +
      `Capture rate: ${captureRate}%` +
      strikeLine
    );
  }).join('\n');

  const tickerList = p.legs.map(l => `"${l.ticker}"`).join(', ');

  return `Evaluate these open Kalshi positions:
${legsStr}

Current BTC: $${p.btcPrice.toFixed(2)}
Overall risk profile: ${p.suggestedRisk}

EXIT GUIDANCE — apply per leg:
Capture rate = (currentBid - entryPrice) / (100c - entryPrice): how much of the max gain is already locked in.
BTC margin to strike is the key reversal risk signal — the smaller it is, the easier one volatile candle flips the outcome.

  HIGH reversal risk (BTC within $300 of strike):
    Lean EXIT if capture rate > 30% and P&L is positive.
    A single volatile candle can cross the strike; locking in gains matters more than squeezing extra value.

  Moderate reversal risk (BTC $300-$800 from strike):
    Consider EXIT if capture rate > 45%.
    Hold if BTC is moving clearly away from the strike with visible momentum.

  Lower reversal risk (BTC > $800 from strike):
    Lean HOLD — the win cushion is meaningful, let the position grow toward settlement.
    Only exit if capture rate > 65% or you see a reversal signal.

  Strong continuation exception: if BTC is accelerating away from the strike (high volume,
  clear breakout direction), you may hold even at HIGH risk provided capture rate is above 50%.

For each position, should I HOLD or EXIT now?
Respond only with valid JSON — no markdown, no extra text:
{"exits":[${p.legs.map(l => `{"ticker":"${l.ticker}","action":"HOLD|EXIT"}`).join(',')}]}
Use exactly these tickers: ${tickerList}`;
}

function getSessionContext(utc: Date): string {
  const hour = utc.getUTCHours();
  if (hour >= 13 && hour < 17) return 'US market hours (13:30-17:00 UTC) — high volatility, 3x normal BTC volume';
  if (hour >= 17 && hour < 20) return 'US afternoon session — moderate volatility';
  if (hour >= 7 && hour < 9) return 'EU/US handoff (07:00-09:00 UTC) — can be spiky';
  if (hour >= 20 || hour < 3) return 'Asian session (20:00-03:00 UTC) — quieter, thin Kalshi books';
  return 'Normal session';
}
