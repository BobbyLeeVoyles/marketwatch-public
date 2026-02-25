# How to Enable Adaptive Position Sizing (+178% Improvement)

## Current vs Proposed Implementation

### What Happens NOW (Option 1 - Fixed $20 sizing)

**File:** `engine/hourlyBot.ts`

```typescript
// Line 183-185: Signal check WITHOUT capital
const signal = bot === 'conservative'
  ? checkConservativeSignal(btcData)
  : checkAggressiveSignal(btcData);  // ← No capital parameter!

// Line 220-222: Fixed position size from config
const estimatedEntryPrice = 0.25;
const contracts = Math.floor(botConfig.capitalPerTrade / estimatedEntryPrice);
// ↑ Uses fixed $20 from config.json every trade
```

**Result:**
- Every trade uses $20 position size (from `botConfig.capitalPerTrade`)
- Trade 1: $20 position
- Trade 100: $20 position (even if you now have $1,000!)
- Trade 1000: $20 position (even if you now have $10,000!)
- **Position size never grows with success**

---

### What Should Happen (Option 2 - Adaptive sizing)

```typescript
// Track current capital in bot state
let currentCapital = 100; // Starting bankroll

// Signal check WITH capital
const signal = checkAggressiveSignal(btcData, currentCapital);
// ↑ Returns signal.positionSize based on 2-5% of capital

// Use adaptive position size from signal
const estimatedEntryPrice = 0.25;
const contracts = Math.floor(signal.positionSize / estimatedEntryPrice);
// ↑ Uses adaptive size that grows with bankroll

// After trade completes
currentCapital += trade.netPnL; // Update capital!
```

**Result:**
- Trade 1: $5 position (5% of $100)
- Trade 100: $25 position (3% of $833)
- Trade 1000: $50 position (2% of $2,500, capped at $50)
- **Position size scales with success → exponential growth**

---

## Specific Code Changes Needed

### Change 1: Add Capital Tracking to Bot State

**File:** `engine/hourlyBot.ts` (lines 30-40)

**BEFORE:**
```typescript
interface HourlyBotState {
  bot: 'conservative' | 'aggressive';
  running: boolean;
  intervalId?: NodeJS.Timeout;
  position: BotPosition | null;
  dailyPnL: number;
  tradesCount: number;
  lastError?: string;
  tradedThisHour: boolean;
  currentHourKey: string;
}
```

**AFTER:**
```typescript
interface HourlyBotState {
  bot: 'conservative' | 'aggressive';
  running: boolean;
  intervalId?: NodeJS.Timeout;
  position: BotPosition | null;
  dailyPnL: number;
  tradesCount: number;
  lastError?: string;
  tradedThisHour: boolean;
  currentHourKey: string;
  currentCapital: number; // ← ADD THIS: Track running bankroll
}
```

---

### Change 2: Initialize Capital on Bot Start

**File:** `engine/hourlyBot.ts` (lines 470-478)

**BEFORE:**
```typescript
const state: HourlyBotState = {
  bot,
  running: true,
  position: null,
  dailyPnL: 0,
  tradesCount: 0,
  tradedThisHour: false,
  currentHourKey: getHourKey(),
};
```

**AFTER:**
```typescript
const state: HourlyBotState = {
  bot,
  running: true,
  position: null,
  dailyPnL: 0,
  tradesCount: 0,
  tradedThisHour: false,
  currentHourKey: getHourKey(),
  currentCapital: loadSavedCapital(bot) || 100, // ← ADD THIS: Load saved capital or start at $100
};
```

---

### Change 3: Pass Capital to Signal Check

**File:** `engine/hourlyBot.ts` (lines 183-185)

**BEFORE:**
```typescript
// Check signal
const signal = bot === 'conservative'
  ? checkConservativeSignal(btcData)
  : checkAggressiveSignal(btcData);
```

**AFTER:**
```typescript
// Check signal with current capital for adaptive sizing
const signal = bot === 'conservative'
  ? checkConservativeSignal(btcData)
  : checkAggressiveSignal(btcData, state.currentCapital); // ← ADD capital parameter
```

---

### Change 4: Use Signal's Position Size

**File:** `engine/hourlyBot.ts` (lines 220-226)

**BEFORE:**
```typescript
// Calculate contracts from capital allocation
const estimatedEntryPrice = 0.25; // $0.25 per contract
const contracts = Math.floor(botConfig.capitalPerTrade / estimatedEntryPrice);

if (contracts < 1) {
  console.log(`[HOURLY BOT] ${bot} insufficient capital: need at least $${estimatedEntryPrice}`);
  return;
}
```

**AFTER:**
```typescript
// Calculate contracts from adaptive position size
const positionSize = signal.positionSize || botConfig.capitalPerTrade; // Use signal's adaptive size
const estimatedEntryPrice = signal.entryPrice || 0.25;
const contracts = Math.floor(positionSize / estimatedEntryPrice);

if (contracts < 1) {
  console.log(`[HOURLY BOT] ${bot} insufficient capital: need at least $${estimatedEntryPrice}`);
  return;
}

console.log(
  `[HOURLY BOT] ${bot} position sizing | ` +
  `Capital: $${state.currentCapital.toFixed(2)} | ` +
  `Position: $${positionSize.toFixed(2)} | ` +
  `Contracts: ${contracts}`
);
```

---

### Change 5: Update Capital After Early Exit

**File:** `engine/hourlyBot.ts` (lines 368-392)

**AFTER logTradeToFile (insert before clearing position):**
```typescript
// Log trade
logTradeToFile({
  id: position.orderId || `${bot}-${Date.now()}`,
  timestamp: position.entryTime,
  strategy: bot,
  direction: position.side,
  strike: position.strike!,
  entryPrice: position.entryPrice,
  exitPrice: currentPrice / 100,
  exitType: 'early',
  contracts: position.contracts,
  netPnL: breakdown.netPnL,
  won: breakdown.netPnL > 0,
  exitReason: exitAnalysis.reason,
});

// ← ADD THIS: Update capital after trade
state.currentCapital += breakdown.netPnL;
saveCapital(bot, state.currentCapital);

console.log(
  `[HOURLY BOT] ${bot} capital updated | ` +
  `P&L: $${breakdown.netPnL.toFixed(2)} | ` +
  `New Capital: $${state.currentCapital.toFixed(2)}`
);

// Clear position
const positions = readBotPositions();
delete positions[bot];
writeBotPositions(positions);
state.position = null;
```

---

### Change 6: Update Capital After Settlement

**File:** `engine/hourlyBot.ts` (lines 430-455)

**AFTER logTradeToFile (insert before clearing position):**
```typescript
// Log trade
logTradeToFile({
  id: position.orderId || `${bot}-${Date.now()}`,
  timestamp: position.entryTime,
  strategy: bot,
  direction: position.side,
  strike: position.strike!,
  entryPrice: position.entryPrice,
  exitPrice,
  exitType: 'settlement',
  contracts: position.contracts,
  netPnL: breakdown.netPnL,
  won: isWin,
  exitReason: `Settlement ${isWin ? 'WIN' : 'LOSS'}: BTC $${btcPrice.toFixed(0)}`,
});

// ← ADD THIS: Update capital after trade
state.currentCapital += breakdown.netPnL;
saveCapital(bot, state.currentCapital);

console.log(
  `[HOURLY BOT] ${bot} capital updated | ` +
  `P&L: $${breakdown.netPnL.toFixed(2)} | ` +
  `New Capital: $${state.currentCapital.toFixed(2)}`
);

// Clear position
const positions = readBotPositions();
delete positions[bot];
writeBotPositions(positions);
state.position = null;
```

---

### Change 7: Add Capital Persistence Functions

**File:** `engine/hourlyBot.ts` (add after line 26)

```typescript
const BOT_CAPITAL_FILE = path.resolve('./data/bot-capital.json');

/**
 * Load saved capital for a bot
 */
function loadSavedCapital(bot: 'conservative' | 'aggressive'): number | null {
  try {
    if (fs.existsSync(BOT_CAPITAL_FILE)) {
      const data = JSON.parse(fs.readFileSync(BOT_CAPITAL_FILE, 'utf8'));
      return data[bot] || null;
    }
  } catch (error) {
    console.error('[HOURLY BOT] Failed to load capital:', error);
  }
  return null;
}

/**
 * Save capital for a bot
 */
function saveCapital(bot: 'conservative' | 'aggressive', capital: number): void {
  try {
    let data: Record<string, number> = {};
    if (fs.existsSync(BOT_CAPITAL_FILE)) {
      data = JSON.parse(fs.readFileSync(BOT_CAPITAL_FILE, 'utf8'));
    }
    data[bot] = capital;

    const dir = path.dirname(BOT_CAPITAL_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(BOT_CAPITAL_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[HOURLY BOT] Failed to save capital:', error);
  }
}
```

---

### Change 8: Update Bot Status Display

**File:** `engine/hourlyBot.ts` (lines 519-537)

**BEFORE:**
```typescript
export function getHourlyBotStatus(bot: 'conservative' | 'aggressive') {
  const state = botStates.get(bot);
  if (!state) {
    return {
      running: false,
      dailyPnL: 0,
      tradesCount: 0,
    };
  }

  return {
    running: state.running,
    startedAt: state.intervalId ? new Date().toISOString() : undefined,
    dailyPnL: state.dailyPnL,
    tradesCount: state.tradesCount,
    lastError: state.lastError,
    hasPosition: state.position !== null,
  };
}
```

**AFTER:**
```typescript
export function getHourlyBotStatus(bot: 'conservative' | 'aggressive') {
  const state = botStates.get(bot);
  if (!state) {
    return {
      running: false,
      dailyPnL: 0,
      tradesCount: 0,
      currentCapital: loadSavedCapital(bot) || 0, // ← ADD THIS
    };
  }

  return {
    running: state.running,
    startedAt: state.intervalId ? new Date().toISOString() : undefined,
    dailyPnL: state.dailyPnL,
    tradesCount: state.tradesCount,
    lastError: state.lastError,
    hasPosition: state.position !== null,
    currentCapital: state.currentCapital, // ← ADD THIS
  };
}
```

---

## How It Works - Detailed Example

### Starting State
```
Capital: $100
```

### Trade 1 - Early Growth Phase
```
1. Signal check: checkAggressiveSignal(btcData, $100)
2. Position sizing: 5% of $100 = $5
3. Entry: 20 contracts @ $0.25 = $5 total cost
4. Exit: Win $8 (after fees)
5. Update capital: $100 + $8 = $108
```

### Trade 50 - Building Phase
```
Capital: $420
1. Signal check: checkAggressiveSignal(btcData, $420)
2. Position sizing: 5% of $420 = $21
3. Entry: 84 contracts @ $0.25 = $21 total cost
4. Exit: Win $35 (after fees)
5. Update capital: $420 + $35 = $455
```

### Trade 200 - Established Phase
```
Capital: $1,200
1. Signal check: checkAggressiveSignal(btcData, $1200)
2. Position sizing: 3% of $1,200 = $36 (crossed $500 threshold)
3. Entry: 144 contracts @ $0.25 = $36 total cost
4. Exit: Win $60 (after fees)
5. Update capital: $1,200 + $60 = $1,260
```

### Trade 1000 - Mature Phase
```
Capital: $5,000
1. Signal check: checkAggressiveSignal(btcData, $5000)
2. Position sizing: 2% of $5,000 = $100 → capped at $50 (crossed $2K threshold)
3. Entry: 200 contracts @ $0.25 = $50 total cost
4. Exit: Win $83 (after fees)
5. Update capital: $5,000 + $83 = $5,083
```

---

## Position Size Evolution Over Time

```
Starting: $100

After 50 trades:  ~$400    | Position: $20  (5%)
After 100 trades: ~$900    | Position: $27  (3%)
After 200 trades: ~$2,500  | Position: $50  (2%, capped)
After 500 trades: ~$15,000 | Position: $50  (2%, capped)
After 1000 trades: ~$50,000| Position: $50  (2%, capped)

Final (4,551 trades): $192,016 | Position: $50 (capped)
```

**Key Point:** Position grows WITH your success, creating exponential compounding instead of linear growth.

---

## Safety Features Built-In

### 1. Percentage Tiers (Lower risk as you grow)
```typescript
if (capital < 500)    → 5% position  // Aggressive early to build
if (capital < 2000)   → 3% position  // Moderate mid-game
if (capital >= 2000)  → 2% position  // Conservative when established
```

### 2. Position Caps
```typescript
Minimum: $10   // Ensures you can always trade
Maximum: $50   // Prevents over-betting large bankrolls
```

### 3. Capital Floor
```typescript
// Optional: Prevent capital from going negative
state.currentCapital = Math.max(10, state.currentCapital + breakdown.netPnL);
```

---

## Testing the Changes

### 1. Start with Small Capital
```typescript
// In startHourlyBot() initialization
currentCapital: 100, // Start with $100
```

### 2. Monitor Position Sizing
```bash
# Watch the logs for position sizing
[HOURLY BOT] aggressive position sizing | Capital: $100.00 | Position: $5.00 | Contracts: 20
[HOURLY BOT] aggressive position sizing | Capital: $142.50 | Position: $7.13 | Contracts: 28
[HOURLY BOT] aggressive position sizing | Capital: $523.00 | Position: $15.69 | Contracts: 62
```

### 3. Check Capital File
```bash
cat data/bot-capital.json
```
```json
{
  "aggressive": 523.00,
  "conservative": 100.00
}
```

### 4. Verify Exponential Growth
```
Week 1:  $100 → $250  (2.5x in 1 week)
Week 2:  $250 → $580  (2.3x)
Week 4:  $580 → $2,100 (3.6x)
Month 2: $2,100 → $8,500
Month 6: $8,500 → $50,000
Year 1:  $100 → $192,000 (1,920x!)
```

---

## Comparison: Fixed vs Adaptive

### Fixed $20 Position Sizing (Current)
```
Trade 1:    $100 capital → $20 position (20% of bankroll!)
Trade 100:  $500 capital → $20 position (4% of bankroll)
Trade 1000: $5,000 capital → $20 position (0.4% of bankroll)

Final: $69,005 after 4,045 trades
```

**Problem:** Position becomes SMALLER relative to bankroll as you grow. Missing exponential compound.

### Adaptive 2-5% Sizing (Proposed)
```
Trade 1:    $100 capital → $5 position (5% of bankroll)
Trade 100:  $500 capital → $25 position (5% of bankroll)
Trade 1000: $5,000 capital → $50 position (1% of bankroll, capped)

Final: $192,016 after 4,551 trades
```

**Benefit:** Position scales WITH bankroll. Captures exponential compound. **178% better!**

---

## Implementation Checklist

- [ ] Add `currentCapital: number` to `HourlyBotState` interface
- [ ] Add `loadSavedCapital()` and `saveCapital()` functions
- [ ] Initialize `currentCapital` in `startHourlyBot()`
- [ ] Pass `state.currentCapital` to `checkAggressiveSignal()`
- [ ] Use `signal.positionSize` instead of `botConfig.capitalPerTrade`
- [ ] Update capital after early exit: `state.currentCapital += breakdown.netPnL`
- [ ] Update capital after settlement: `state.currentCapital += breakdown.netPnL`
- [ ] Add capital logging to console output
- [ ] Update `getHourlyBotStatus()` to return capital
- [ ] Test with small starting capital ($100)
- [ ] Monitor position sizing in logs
- [ ] Verify exponential growth over time

---

## Expected Results

### Before (Fixed $20)
- Starting: $100
- After 1 year: $69,005
- Return: +68,905% (689x)
- Trades: 4,045
- Win rate: 38.2%
- Ruin rate: 10%

### After (Adaptive 2-5%)
- Starting: $100
- After 1 year: $192,016
- Return: +191,917% (1,920x)
- Trades: 4,551
- Win rate: 41.5%
- Ruin rate: 0%
- **Improvement: +178%**

---

## Summary

**The core concept is simple:**

1. **Track your capital** - Know how much you have
2. **Risk a percentage** - Bet 2-5% of what you have
3. **Update after trades** - Capital goes up/down with each trade
4. **Let it compound** - Bigger capital → bigger positions → bigger wins → even bigger capital

**The magic is in the compounding:**
- Fixed $20: Linear growth (win $20, win $20, win $20...)
- Adaptive %: Exponential growth (win $5, win $7, win $12, win $25...)

Over 4,500+ trades, exponential beats linear by **178%**.

---

*See: ADAPTIVE_POSITION_SIZING_ANALYSIS.md for full experiment results*
