# Marketwatch — Kalshi Bitcoin Trading Bot

Autonomous trading bot system for Kalshi Bitcoin prediction markets (KXBTCD hourly + KXBTC15M 15-minute). Includes a real-time web dashboard for monitoring and control.

---

## Getting Started

1. Download the ZIP from GitHub → extract it anywhere
2. Open the extracted folder
3. Right-click **`setup.bat`** → **Send to → Desktop (create shortcut)**
4. Double-click that shortcut anytime to launch Marketwatch

The installer handles everything — Node.js, dependencies, API keys, and starting the app.

---

## What It Does

Six independent bots run simultaneously, each with its own strategy and capital allocation:

| Bot | Market | Strategy | AI? |
|-----|--------|----------|-----|
| **Conservative Hourly** | KXBTCD (hourly) | Technical — floor strike, trend-following | No |
| **Aggressive Hourly** | KXBTCD (hourly) | Technical — directional breakout | No |
| **15-Minute** | KXBTC15M (15-min) | 6-signal regime-aware momentum | No |
| **Grok Hourly** | KXBTCD (hourly) | AI (Grok/xAI) entry + exit decisions | Yes |
| **Grok 15-Min** | KXBTC15M (15-min) | AI (Grok/xAI) entry + exit decisions | Yes |
| **Strike Sniper** | Both | OTM momentum + late-hour dislocation | No |

Each bot has independent capital limits, daily loss limits, and can be toggled on/off from the dashboard without restarting anything.

---

## Tech Stack

- **Dashboard:** Next.js 14, TypeScript, Tailwind CSS, Recharts
- **Trading Engine:** TypeScript, runs as a separate Node process
- **Kalshi API:** `kalshi-typescript` SDK
- **AI:** Grok via `openai` SDK (xAI-compatible endpoint)
- **BTC Data:** Binance WebSocket (real-time price, 1m/5m/1h candles, order book)

---

## Quick Start

### 1. Prerequisites

- Node.js v18 or higher
- Kalshi account with API key ([kalshi.com/api](https://kalshi.com/api))
- xAI API key if using Grok bots ([console.x.ai](https://console.x.ai)) — optional

### 2. Clone & Install

```bash
git clone https://github.com/BobbyLeeVoyles/marketwatch-public
cd marketwatch-public
npm install
```

### 3. Configure credentials

Open `.env` (already present with placeholders) and fill in your values:

```env
KALSHI_API_KEY_ID=your-key-id-from-kalshi
KALSHI_PRIVATE_KEY_PATH=./kalshi-private-key.pem
KALSHI_DEMO_MODE=true

XAI_API_KEY=your-xai-key-here   # only needed for Grok bots
```

Then copy your Kalshi private key PEM file into the project root:

```bash
cp ~/Downloads/kalshi-private-key.pem ./kalshi-private-key.pem
```

### 4. Start the dashboard

```bash
npm run dev
```

Open **http://localhost:3000**

### 5. Start the trading engine (separate terminal)

```bash
npm run engine -- --mode=bots
```

The engine connects to Kalshi, starts the BTC price feed, and initializes whichever bots are enabled in the dashboard config.

---

## Bot Details

### Conservative Hourly
Trades the floor strike on hourly KXBTCD markets. Entry based on RSI, trend alignment, and momentum on hourly candles. Uses EV-based early exit logic (compares expected settlement value vs current bid). Max 2 trades per hour.

### Aggressive Hourly
Same signal framework as Conservative but takes directional breakout positions — YES on bullish signal (floor strike), NO on bearish signal (next-up strike). Slightly higher capital allocation.

### 15-Minute
Trades KXBTC15M markets using a 6-signal system on 5-minute candles: Bollinger Band regime, RSI-7, 1-min + 3-min momentum, volume ratio, and EMA5/EMA10 differential. Supports averaging-down (0.75x add-on) when price dips 0.30% below entry. Pre-fetches the next window's market in the final 60 seconds to eliminate latency.

### Grok Hourly
Passes hourly candles, funding rate, order book imbalance, and the conservative algo signal to Grok as context. Grok decides entry direction, bet size, and which strikes to use. Exit decisions (every 3 min) are also delegated to Grok. Falls back to hard exits if win probability drops below 10% or settlement is under 2 minutes away.

### Grok 15-Min
Same pattern as Grok Hourly but on 15-minute markets. Passes 1m, 5m, and 1h candles plus the regime/RSI/volatility context. 3-minute cooldown between entry calls, requires 10+ minutes remaining in the window to enter.

### Strike Sniper
Two modes:
- **15-Min path:** Waits until minute 7 of a window, then buys the first OTM strike in the direction of momentum (threshold: 0.5% BTC move from window open). IOC orders only — no resting limit orders.
- **Hourly dislocation path:** Activates in the last 10 minutes of hourly contracts when BTC is within $300 of a strike. Detects mispricings using a log-normal fair value model and fades the dislocation (buys dips, fades fear spikes).

---

## Dashboard

The web dashboard at `http://localhost:3000` shows:

- Real-time BTC price and candle data
- Daily P&L per bot
- Active positions and open orders
- Bot controls: enable/disable, capital per trade, daily loss limit
- Full trade history

Each bot can be toggled on/off live from the dashboard without restarting the engine.

---

## Configuration

Bot settings (capital, limits, thresholds) are stored in `data/bot-config.json` and edited via the dashboard UI. Default starting values:

| Bot | Capital/Trade | Max Daily Loss |
|-----|--------------|----------------|
| Conservative Hourly | $30 | $100 |
| Aggressive Hourly | $20 | $80 |
| 15-Minute | $15 | $60 |
| Grok Hourly | $3 | configurable |
| Grok 15-Min | $3 | configurable |
| Strike Sniper | $5 | $20 |

Start with demo mode (`KALSHI_DEMO_MODE=true`) and small amounts. Switch to production only after validating in demo.

---

## Runtime Data

All state is written to the `data/` folder (gitignored):

```
data/
├── bot-config.json      # bot settings
├── bot-positions.json   # active open positions
├── trades.json          # trade history + daily P&L
├── execution-log.json   # full order audit trail
└── signal.json          # latest engine signal (manual mode)
```

---

## Stopping

```bash
# Engine (Terminal 2):
Ctrl+C

# Dashboard (Terminal 1):
Ctrl+C
```

The engine shuts down all bots gracefully before exiting.

---

## Troubleshooting

**"Failed to initialize Kalshi client"**
- Check `KALSHI_API_KEY_ID` in `.env`
- Confirm `kalshi-private-key.pem` exists in project root
- Verify the API key is active at kalshi.com

**"Waiting for BTC price..."**
- BTC feed connects via WebSocket — wait 10–30 seconds
- Check that your firewall isn't blocking outbound WebSocket connections

**"No suitable market found"**
- Kalshi markets open on a schedule — KXBTCD opens each hour, KXBTC15M every 15 min
- Check [kalshi.com](https://kalshi.com) to confirm markets are live

**Grok bots not entering**
- Confirm `XAI_API_KEY` is set in `.env`
- Check the engine logs for API errors from the xAI endpoint
