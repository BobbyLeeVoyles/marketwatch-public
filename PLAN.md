# BTC Prediction Terminal - Implementation Plan

## Current State
- Dashboard fully built: Next.js 14 + TypeScript + Tailwind
- Dual strategy signals (conservative + aggressive with 14 bull/bear signals)
- Direction-aware exit logic (YES + NO contracts)
- Engine + orchestrator built (Claude Computer Use for Robinhood)
- Branch: `claude/plan-project-build-eukBm`

---

## Phase 1: Fix Immediate Issues (Pricing, Exit Logic, Experiment) — COMPLETE

### 1A. Fix Volatility Model (Pricing Underestimate) — DONE

**Problem:** `calculateVolatility()` in `lib/utils/indicators.ts` uses only the current
candle's high-low range. Early in the hour this is tiny (0.08%), making the model think
BTC won't move, pricing OTM contracts at ~25¢ when the market is at ~40¢.

**Fix:** Replace single-candle range with **multi-candle realized volatility** —
average of the last 6 completed candles' ranges (skip the incomplete current candle).
This gives a stable hourly vol estimate (~0.3-0.5%) that matches what market makers use.

### 1B. Add Momentum-Reversal Exit + Timed Profit-Taking — SKIPPED

Experiment showed baseline (EV + 5m cut) is optimal. No momentum-reversal exit needed.

### 1C. Run Timed Exit Experiment — DONE

Baseline (EV + 5m cut) wins across all Monte Carlo paths.

---

## Phase 2: Architecture — Always-On Engine + Real Notifications — COMPLETE

### 2A. Connect Dashboard to Engine Trades — DONE
### 2B. Add Real Notifications (Telegram Bot) — DONE
### 2C. Disable Claude Computer Use (Reconnectable) — DONE

---

## Phase 3: Kalshi API Integration — Direct Trading (3 Bots)

### Architecture Overview

**Replace the Claude Computer Use orchestrator with direct Kalshi API trading.**
Kalshi powers the same hourly BTC markets available on Robinhood, plus 15-minute
BTC up/down markets. All trading goes through Kalshi's REST + WebSocket API.

**Three independent trading bots:**

| Bot | Market | Kalshi Series | Strategy | Contract Type |
|-----|--------|---------------|----------|---------------|
| **Conservative** | Hourly BTC price | `KXBTC` | ITM floor strike, trend-following | YES on floor strike (50-95% prob) |
| **Aggressive** | Hourly BTC price | `KXBTC` | OTM 7-signal momentum | YES/NO on next-up/floor ($250 increments) |
| **15-Minute** | 15-min BTC up/down | `KXBTC15M` | New strategy (see 3F) | YES on Up or Down |

Each bot is **independently toggleable** from the dashboard with its own capital allocation.

---

### 3A. Kalshi Client — Auth + REST + WebSocket

**Kalshi API details:**
- Base URL: `https://api.elections.kalshi.com/trade-api/v2`
- Demo URL: `https://demo-api.kalshi.co/trade-api/v2` (for testing)
- Auth: RSA-PSS signature — three headers per request:
  - `KALSHI-ACCESS-KEY` — API key ID
  - `KALSHI-ACCESS-SIGNATURE` — sign(`timestamp + method + path`) with RSA private key
  - `KALSHI-ACCESS-TIMESTAMP` — Unix timestamp in milliseconds
- Official TypeScript SDK: `kalshi-typescript` (npm)
- WebSocket: `wss://api.elections.kalshi.com/trade-api/ws/v2`
  - Public channels: `ticker`, `trade`, `market_lifecycle_v2`
  - Private channels: `orderbook_delta`, `fill`, `market_positions`

**Key endpoints:**
```
Public (no auth):
  GET  /markets?series_ticker=KXBTC&status=open     — List hourly markets
  GET  /markets?series_ticker=KXBTC15M&status=open   — List 15-min markets
  GET  /markets/{ticker}                              — Market details
  GET  /markets/{ticker}/orderbook                    — Order book

Authenticated:
  POST /portfolio/orders                              — Place order
  GET  /portfolio/orders                              — List my orders
  DELETE /portfolio/orders/{order_id}                  — Cancel order
  GET  /portfolio/positions                           — My positions
  GET  /portfolio/balance                             — Account balance
```

**Order placement (POST /portfolio/orders):**
```json
{
  "ticker": "KXBTC-26FEB14-B98000",
  "action": "buy",
  "side": "yes",
  "count": 20,
  "type": "limit",
  "yes_price": 65,
  "client_order_id": "uuid-for-dedup"
}
```
- Prices are in cents (1-99)
- `client_order_id` is a UUID for deduplication (safe to retry on network failures)
- `side`: "yes" or "no"
- `action`: "buy" or "sell"

**Fee structure:** `fee = 0.07 × contracts × price × (1 - price)`
- Capped at $0.02 per contract
- Capped at $1.75 per 100 contracts
- No settlement fee
- Fees highest at 50¢ (max $0.0175/contract), lowest at extremes

**Files to create:**
- `lib/kalshi/client.ts` — Singleton Kalshi client with RSA-PSS auth, request signing, retry logic
- `lib/kalshi/types.ts` — Kalshi-specific types (Market, Order, Position, Fill, OrderBook)
- `lib/kalshi/websocket.ts` — WebSocket connection for real-time orderbook + fill updates
- `lib/kalshi/constants.ts` — Hardcoded official endpoints, allowed series tickers (security)

**Files to modify:**
- `package.json` — Add `kalshi-typescript` dependency (official SDK)
- `.env.example` — Add `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH`, `KALSHI_DEMO_MODE`

**Security requirements:**
- Private key stored as PEM file on disk, path referenced in `.env` — NEVER committed
- `.gitignore` must include `*.pem`, `*.key`, `.env`
- Hardcode allowed series tickers: `['KXBTC', 'KXBTC15M']` — reject any order for other markets
- Validate all API URLs against hardcoded base URL before making requests
- Log all order placements and fills to `data/execution-log.json` for audit trail

---

### 3B. Kalshi Fee Model

**Replace Robinhood fee model with Kalshi's parabolic fee curve.**

Kalshi fee formula: `fee = 0.07 × C × P × (1 - P)`
- C = contract count
- P = price (e.g., 0.50 for a 50¢ contract)
- Capped at $0.02 per contract, $1.75 per 100 contracts
- No settlement fee — settling contracts is free

**Comparison to Robinhood:**

| | Robinhood | Kalshi |
|---|---|---|
| Entry at 25¢ (100 contracts) | $0.375 (1.5% taker) | $1.31 (parabolic) |
| Entry at 50¢ (100 contracts) | $0.750 (1.5% taker) | $1.75 (parabolic, capped) |
| Entry at 65¢ (100 contracts) | $0.975 (1.5% taker) | $1.59 (parabolic) |
| Entry at 90¢ (100 contracts) | $1.350 (1.5% taker) | $0.63 (parabolic) |
| Settlement fee | 0% | 0% |
| Early exit fee | Same as entry | Same as entry |

**Key insight:** Kalshi's fees are LOWER than Robinhood for contracts near the extremes
(high probability ITM or low probability OTM). This benefits both strategies:
- Conservative (65-90¢ entries): Lower fees than Robinhood
- Aggressive (5-25¢ entries): Comparable fees

**Files to modify:**
- `lib/utils/fees.ts` — Add `KALSHI_FEES` with parabolic fee calculation, add
  `calculateKalshiFee(contracts, price)` function

---

### 3C. Market Discovery — Find Active Contracts

**Kalshi market hierarchy:** Series → Event → Market

**Hourly BTC (KXBTC):**
- Series: `KXBTC`
- Event ticker format: `KXBTC-{YY}{MON}{DD}{HH}` (e.g., `KXBTC-26FEB1418`)
- Market ticker format: `KXBTC-{YY}{MON}{DD}-B{STRIKE}` (e.g., `KXBTC-26FEB14-B98000`)
- Strike increments: $250 (same as Robinhood — these are the same markets)
- Settlement: CF Benchmarks BRTI, 60-second average at top of hour

**15-Minute BTC Up/Down (KXBTC15M):**
- Series: `KXBTC15M`
- Market ticker format: `KXBTC15M-{YY}{MON}{DD}{HHMM}` (e.g., `KXBTC15M-26FEB141500`)
- Binary outcome: BTC price UP or DOWN from start of 15-minute window
- Settlement: CF Benchmarks BRTI, 60-second average at end of window
- New market opens every 15 minutes (96 per day)

**Market discovery flow:**
1. Query `GET /markets?series_ticker=KXBTC&status=open` to find all open hourly markets
2. Filter to the current hour's event (match by expiration time)
3. Find the specific strike market(s) needed by the strategy
4. For 15-min: query `GET /markets?series_ticker=KXBTC15M&status=open` and find current window
5. Cache market data, refresh every 60s (hourly) or every 30s (15-min)

**Files to create:**
- `lib/kalshi/markets.ts` — `findHourlyMarkets(btcPrice)` and `find15MinMarket()` functions
  - Returns the active market tickers for floor strike, next-up strike (hourly)
  - Returns the active 15-min up/down market ticker
  - Validates series tickers against allowlist before returning

---

### 3D. Adapt Hourly Strategies for Kalshi

**The existing conservative and aggressive strategies already produce correct signals.**
The signal logic (indicators, thresholds, criteria checks) is market-agnostic — it just
needs a BTC price and hourly candle data. What changes is how signals get executed.

**Current flow (Robinhood/Claude CU):**
```
Engine → checkAggressiveSignal() → write signal.json → Claude CU reads → clicks Robinhood UI
```

**New flow (Kalshi direct API):**
```
Engine → checkAggressiveSignal() → Kalshi REST API → place limit order → get fill confirmation
```

**Key changes to engine:**
1. Remove `signalWriter.ts` / `signal.json` intermediary for Kalshi trades
2. Add direct order placement via `lib/kalshi/client.ts`
3. Get real fill data (price, quantity) from API response instead of guessing
4. Track positions via Kalshi API (`GET /portfolio/positions`) as source of truth
5. Handle order lifecycle: place → partial fill → full fill → settlement
6. Support both conservative AND aggressive on hourly (currently engine only runs aggressive)

**Position tracking upgrade:**
- Current: `data/position.json` with `pending` flag (because CU can't confirm fills)
- New: Kalshi API confirms fills instantly → no more `pending` state for Kalshi trades
- Keep `pending` concept only for network failure recovery (order placed but response lost)

**Files to create:**
- `engine/kalshiTrader.ts` — Direct order placement, fill tracking, position management
  - `placeOrder(ticker, side, action, count, price)` → returns fill details
  - `getPositions()` → returns current Kalshi positions
  - `getBalance()` → returns available cash
  - `cancelOrder(orderId)` → cancel unfilled order

**Files to modify:**
- `engine/index.ts` — Add two independent hourly loops (conservative + aggressive)
  that call `kalshiTrader.placeOrder()` instead of `writeSignal()`
- `engine/positionTracker.ts` — Separate position tracking per bot:
  `data/position-conservative.json`, `data/position-aggressive.json`

---

### 3E. Dashboard Controls — Three Bot Toggles + Capital Allocation

**Three toggle switches in dashboard header:**

```
[CON: ON ▼ $30] [AGG: ON ▼ $20] [15M: OFF ▼ $15]
```

Each toggle controls:
1. **ON/OFF** — Whether the bot is actively placing trades
2. **Capital allocation** — Dollar amount per trade for that bot (input field)

**State management:**
- Bot configs stored in `data/bot-config.json` (read by engine, written by dashboard API)
- Dashboard sends config changes via `POST /api/bot-config`
- Engine reads config on every loop iteration (hot-reloadable, no restart needed)

**Bot config schema:**
```typescript
interface BotConfig {
  conservative: {
    enabled: boolean;
    capitalPerTrade: number;  // dollars
    maxDailyLoss: number;     // dollars, stop trading if daily loss exceeds this
  };
  aggressive: {
    enabled: boolean;
    capitalPerTrade: number;
    maxDailyLoss: number;
  };
  fifteenMin: {
    enabled: boolean;
    capitalPerTrade: number;
    maxDailyLoss: number;
  };
}
```

**Dashboard P&L display update:**
- Header: show P&L for all three bots: `CON: +$2.40 | AGG: -$1.20 | 15M: +$5.80`
- DailyPnL component: add third column for 15-min bot
- Trade history: add `bot` column to distinguish which bot made each trade
- Settlement countdown: show BOTH hourly countdown AND 15-min countdown

**Files to create:**
- `app/api/bot-config/route.ts` — GET/POST bot configuration
- `components/BotToggle.tsx` — Individual bot toggle switch + capital input

**Files to modify:**
- `components/Dashboard.tsx` — Add three BotToggle components in header, update P&L display,
  add 15-min settlement countdown alongside hourly countdown
- `components/DailyPnL.tsx` — Add third column for 15-min strategy
- `components/TradeHistory.tsx` — Add bot/strategy column
- `lib/types/index.ts` — Add `BotConfig` interface, extend `Trade.strategy` union type
  to include `'fifteenMin'`, extend `DailyPerformance` with `fifteenMinReturn`

---

### 3F. 15-Minute BTC Up/Down Strategy

**This is a new strategy module — fundamentally different from hourly.**

**Market mechanics:**
- Every 15 minutes, Kalshi opens a new binary market: "Will BTC be up or down?"
- At expiration, CF Benchmarks BRTI 60-second average determines settlement
- "Up" = BTC price at settlement > price at market open → YES pays $1
- "Down" = BTC price at settlement < price at market open → NO pays $1

**Why the hourly strategies don't apply:**
- SMA3/SMA6/SMA12 are meaningless on 15-min scale
- Multi-hour momentum signals don't exist
- Dip recovery takes 30+ minutes to develop
- $250 strike increments don't apply — it's just Up or Down

**15-Minute signal types:**

1. **Micro-momentum** — 1-3 minute rolling return from Binance tick data.
   If BTC gained >0.05% in last 2 minutes, bias toward UP. Mirror for DOWN.

2. **Volatility regime filter** — Only trade when BTC is moving. Calculate
   5-minute rolling volatility from Binance 1-min candles. If vol < 0.03%,
   skip (both sides trade near 50¢, no edge after fees). If vol > 0.08%, trade.

3. **Mean reversion after extreme moves** — If BTC dropped >0.15% in the last
   5 minutes, there's a bounce tendency. Buy UP. Vice versa for pumps.

4. **Kalshi order book imbalance** — If YES bids are 3x NO bids on the KXBTC15M
   market, there's directional sentiment. Use WebSocket `orderbook_delta` channel.

5. **Time-of-day volatility filter** — BTC has known intraday patterns. Higher vol
   during US market hours (13:30-20:00 UTC). More aggressive during high-vol hours.

**Entry/exit timing:**
- Enter in first 5-7 minutes of the 15-minute window (enough time for limit fills)
- If limit order doesn't fill within 5 minutes, cancel and skip this window
- **Prefer holding to settlement** — no settlement fee means holding is cheap
- Only exit early if position moved strongly against us AND we can exit at maker price
- At < 3 minutes remaining: NEVER exit early (fees + slippage not worth it)

**Fee awareness:**
- At 50¢ (typical Up/Down price): fee = $0.0175/contract (Kalshi cap)
- At 45¢ or 55¢: fee = ~$0.0173/contract
- **Use limit orders** to control entry price. Don't chase with market orders.
- Need 52-53% win rate to be profitable at 50¢ entries (after fees)

**Files to create:**
- `lib/strategies/fifteenMin.ts` — 15-minute strategy signals
- `lib/utils/microIndicators.ts` — Sub-minute indicators (micro-momentum, rolling vol,
  mean reversion score) calculated from Binance 1-min klines and tick data
- `engine/fifteenMinLoop.ts` — Independent loop for 15-min strategy
  - Runs every 5 seconds
  - Discovers current KXBTC15M market via `lib/kalshi/markets.ts`
  - Checks signals via `lib/strategies/fifteenMin.ts`
  - Places orders via `engine/kalshiTrader.ts`
  - Tracks position in `data/position-15min.json`

---

### 3G. Engine Architecture — Three Independent Loops

**The engine runs three concurrent loops:**

```
┌─────────────────────────────────────────────────────────┐
│                    ENGINE (engine/index.ts)              │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Conservative │  │  Aggressive  │  │  15-Minute   │  │
│  │  Hourly Loop │  │  Hourly Loop │  │    Loop      │  │
│  │  (10s cycle) │  │  (10s cycle) │  │  (5s cycle)  │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                 │                  │          │
│         └────────┬────────┴──────────┬───────┘          │
│                  │                   │                   │
│         ┌───────▼───────┐   ┌───────▼───────┐          │
│         │  Kalshi API   │   │  Binance Feed │          │
│         │  (orders,     │   │  (BTC price,  │          │
│         │   positions)  │   │   candles)    │          │
│         └───────────────┘   └───────────────┘          │
│                                                         │
│  Shared: bot-config.json (read each iteration)         │
│  Shared: Telegram notifications                         │
│  Shared: Kalshi client singleton (auth, rate limiting)  │
└─────────────────────────────────────────────────────────┘
```

**Each loop is independent:**
- Reads `data/bot-config.json` every iteration to check if enabled
- Has its own position file (`position-conservative.json`, `position-aggressive.json`, `position-15min.json`)
- Has its own "bought this period" guard (per-hour for hourly, per-15min-window for 15-min)
- Shares the Binance price feed and Kalshi client

**Engine startup sequence:**
1. Load environment: `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH`, `KALSHI_DEMO_MODE`
2. Validate Kalshi credentials (call `GET /portfolio/balance` to verify)
3. Start Binance WebSocket price feed
4. Start Kalshi WebSocket for fill notifications
5. Load bot configs from `data/bot-config.json`
6. Start three loops with `setInterval`
7. Log startup status + Telegram notification

**Graceful shutdown:**
- On SIGINT/SIGTERM: cancel all open orders, close WebSocket connections, save state, exit

**Files to modify:**
- `engine/index.ts` — Complete rewrite:
  - Import and start all three loops
  - Shared Kalshi client initialization
  - Shared Binance feed
  - Config hot-reload
  - Graceful shutdown with open order cancellation

**Files to create:**
- `engine/conservativeLoop.ts` — Hourly conservative strategy loop
- `engine/aggressiveLoop.ts` — Hourly aggressive strategy loop (extracted from current engine)
- `engine/fifteenMinLoop.ts` — 15-minute strategy loop
- `engine/kalshiTrader.ts` — Shared order placement + position management

---

### 3H. Remove Claude Computer Use Dependency

**The orchestrator (`orchestrator/`) is no longer needed for trading.**
Keep the directory for reference but remove it from the active trading flow.

- Engine no longer writes to `data/signal.json` for Kalshi trades
- `ORCHESTRATOR_ENABLED` env var is removed (Kalshi trades go direct)
- The `instruction` field on `EngineSignal` is no longer populated

**Files to modify:**
- `engine/index.ts` — Remove signalWriter imports and calls
- `.env.example` — Remove `ORCHESTRATOR_ENABLED`, add Kalshi vars

---

## Phase 4: 15-Minute Strategy Development + Backtesting

### 4A. Collect 15-Minute Data

Use Binance 1-minute klines API to build a dataset of BTC price at every minute
over the past 30+ days. This gives us 15-minute windows to backtest against.

```python
# Collect 1-min BTC data from Binance
GET /api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000
# Paginate backwards to get 30+ days
```

**File:** `backtest_collect_1min.py` (new)

### 4B. Backtest 15-Minute Strategies

Build `experiment_15min.py` that tests the micro-signals against real 1-minute data:
- Test each signal type independently (micro-momentum, vol filter, mean reversion, etc.)
- Test various entry timing windows (0-2m, 0-5m, 0-7m into the window)
- Test exit timing (hold to settlement vs early exit at 10m/12m)
- Account for Kalshi's parabolic fee curve
- Run with $100 starting capital, configurable per-trade size
- Monte Carlo: 10 paths × 30 days minimum

**File:** `experiment_15min.py` (new)

### 4C. Iterate Based on Results

Use backtest results to tune thresholds, combine signals, and optimize the
fee-aware entry/exit timing. The key metrics:
- Win rate (need >52% at 50¢ entries to beat fees)
- Fill rate on limit orders (modeled as a function of price aggressiveness)
- Drawdown and ruin risk
- Trades per day (96 possible windows × fill rate × signal frequency)

---

## Phase 5: Live Deployment + Calibration

### 5A. Demo Mode Testing (Kalshi Sandbox)

Kalshi provides a demo environment at `https://demo-api.kalshi.co/trade-api/v2`.
- Set `KALSHI_DEMO_MODE=true` in `.env`
- All three bots run against demo markets
- Verify: order placement, fill confirmation, position tracking, settlement, P&L logging
- Duration: 1-2 days

### 5B. Live Micro-Sizing

| Phase | Duration | Per-Trade Size | Goal |
|-------|----------|----------------|------|
| Smoke test | 1 day | $1/trade all bots | Verify orders place, fill, settle, P&L tracks |
| Calibration | 3-5 days | $2-5/trade | Measure fill rate, win rate, compare model vs reality |
| Scale up | Ongoing | User-controlled from dashboard | Increase size as confidence grows |

### 5C. Local Device Setup

Since the user will run on their local device:
- Engine runs as a background Node.js process (`npm run engine`)
- Dashboard runs as Next.js dev server (`npm run dev`) or built (`npm run build && npm start`)
- Use PM2 for process management: `pm2 start engine/index.ts --interpreter tsx`
- Systemd service file optional for auto-start on boot

**Files to create:**
- `ecosystem.config.js` — PM2 config for engine + dashboard processes

---

## Completion Status

| Phase | Task | Status |
|-------|------|--------|
| 1A | Fix volatility model | DONE |
| 1B | Momentum-reversal exit | SKIPPED |
| 1C | Timed exit experiment | DONE |
| 2A | Dashboard trade sync | DONE |
| 2B | Telegram notifications | DONE |
| 2C | CU disconnect flag | DONE |
| 3A | Kalshi client (auth + REST + WebSocket) | PENDING |
| 3B | Kalshi fee model | PENDING |
| 3C | Market discovery (KXBTC + KXBTC15M) | PENDING |
| 3D | Adapt hourly strategies for Kalshi | PENDING |
| 3E | Dashboard controls (3 toggles + capital) | PENDING |
| 3F | 15-minute strategy module | PENDING |
| 3G | Engine architecture (3 loops) | PENDING |
| 3H | Remove Claude CU dependency | PENDING |
| 4A | Collect 15-min data | PENDING |
| 4B | Backtest 15-min strategies | PENDING |
| 4C | Iterate on results | PENDING |
| 5A | Demo mode testing | PENDING |
| 5B | Live micro-sizing | PENDING |
| 5C | Local device setup | PENDING |

---

## Execution Order (Recommended Build Sequence)

**Phase 3 build order (each step builds on the previous):**

1. **3A: Kalshi client** — Auth, REST wrapper, WebSocket. Foundation for everything.
2. **3B: Fee model** — Add Kalshi fee calculations to `fees.ts`.
3. **3C: Market discovery** — Find active KXBTC and KXBTC15M markets by ticker.
4. **3D: Kalshi trader + hourly loops** — Direct order placement, adapt aggressive +
   add conservative hourly loops. First two bots are live.
5. **3E: Dashboard controls** — Three toggles + capital allocation. User can control bots.
6. **3H: Remove CU dependency** — Clean up signal.json flow, update engine entry point.
7. **4A-B: Collect data + backtest 15-min** — Build dataset, test micro-signals.
8. **3F: 15-minute strategy** — Build from backtest results.
9. **3G: Engine final architecture** — Wire up all three loops in engine/index.ts.
10. **5A-B: Demo testing → live micro-sizing** — Test, calibrate, scale.

---

## Security Checklist

- [ ] Private key stored as PEM file, path in `.env`, NEVER committed to git
- [ ] `.gitignore` includes `*.pem`, `*.key`, `.env`, `data/*.json`
- [ ] Hardcoded series allowlist: `['KXBTC', 'KXBTC15M']` — reject all other tickers
- [ ] Validate API base URL against hardcoded constant before every request
- [ ] All order placements logged to `data/execution-log.json` with timestamps
- [ ] `client_order_id` (UUID) used for every order — safe retry on network failures
- [ ] Max daily loss limit per bot (configurable from dashboard, enforced by engine)
- [ ] Graceful shutdown cancels all open orders before exit
- [ ] Rate limit handling with exponential backoff (respect Kalshi tier limits)
- [ ] No sensitive data in Telegram notifications (no API keys, no private key info)

---

## Article Analysis: Kelly Criterion + Bot Strategies (Retained from Previous Plan)

### Kelly Criterion vs Our Fixed Position Sizing

**Recommendation:** Implement **hybrid Kelly** — use 1/4 Kelly for conservative trades
(where model accuracy is higher), keep a capped fixed size for aggressive OTM trades,
and scale both with bankroll growth. Never bet more than 5% of bankroll on a single
trade regardless of Kelly output.

```
conservativeSize = min(bankroll * 0.05, max(5, bankroll * kellyFraction / 4))
aggressiveSize   = min(bankroll * 0.03, max(5, 20))  // capped fixed
fifteenMinSize   = min(bankroll * 0.02, max(3, 15))  // smaller per trade, more trades
```

### Return Expectations

**Hourly (Kalshi, same markets as Robinhood):**
- Conservative: ~$400-600/year on $100 starting capital (40-60% of backtest)
- Aggressive: Higher variance, potentially 2-3x conservative when it works
- Both strategies benefit from lower Kalshi fees at price extremes

**15-Minute (Kalshi KXBTC15M):**
- 96 windows/day vs ~24 hourly windows = 4x more trading opportunities
- Need 52-53% directional accuracy to be profitable after fees
- At 53% win rate, 40 trades/day at $5/trade: ~$12/day = ~$360/month
- At 55% win rate: ~$20/day = ~$600/month
- Fill rate on limit orders is the critical unknown — must calibrate live

**Combined realistic target (first 3 months):** $300-900/month on $500-2000 capital,
scaling with bankroll and confidence. Three bots running simultaneously with
independent risk management diversifies the risk.
