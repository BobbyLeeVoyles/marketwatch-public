# Setup Guide — Marketwatch

## Prerequisites

- **Node.js** v18 or higher — [nodejs.org](https://nodejs.org)
- **Kalshi account** with API credentials — [kalshi.com/api](https://kalshi.com/api)
- **xAI API key** (optional, only needed for Grok bots) — [console.x.ai](https://console.x.ai)
- **Git**

---

## Step 1: Clone & Install

```bash
git clone https://github.com/BobbyLeeVoyles/marketwatch-public
cd marketwatch-public
npm install
```

---

## Step 2: Kalshi API Credentials

1. Log into [kalshi.com](https://kalshi.com)
2. Go to **Settings → API Keys**
3. Create an API key and download the private key (`.pem` file)
4. Copy the key ID shown on screen

```bash
# Copy your PEM file into the project root
cp ~/Downloads/kalshi-private-key.pem ./kalshi-private-key.pem
```

---

## Step 3: Fill in .env

The `.env` file is already in the project with placeholders. Open it and replace the values:

```env
KALSHI_API_KEY_ID=your-key-id-here
KALSHI_PRIVATE_KEY_PATH=./kalshi-private-key.pem
KALSHI_DEMO_MODE=true          # keep true until you've tested in demo

XAI_API_KEY=your-xai-key-here  # only needed for Grok bots
```

Leave `KALSHI_DEMO_MODE=true` for initial testing — demo mode uses fake money against real Kalshi markets.

---

## Step 4: Start the Dashboard

```bash
# Terminal 1
npm run dev
```

Open **http://localhost:3000** — you should see the dashboard load with a live BTC price feed.

---

## Step 5: Start the Trading Engine

```bash
# Terminal 2
npm run engine -- --mode=bots
```

Expected output:
```
[ENGINE] Mode: BOT (Autonomous)
[KALSHI] Connection verified ✓
[BTC FEED] Connected ✓
[ORCHESTRATOR] All bots initialized
```

---

## Step 6: Configure Bots from the Dashboard

1. Open **http://localhost:3000**
2. Find the **BOT CONTROLS** panel
3. For each bot, set your capital per trade and daily loss limit
4. Toggle bots ON to start trading

**Recommended for first run (demo mode):**

| Bot | Capital/Trade | Max Daily Loss |
|-----|--------------|----------------|
| Conservative Hourly | $30 | $100 |
| Aggressive Hourly | $20 | $80 |
| 15-Minute | $15 | $60 |
| Grok Hourly | $3 | $20 |
| Grok 15-Min | $3 | $20 |
| Strike Sniper | $5 | $20 |

Start with just 1–2 bots enabled. Add more once you've confirmed everything is working.

---

## Step 7: Verify It's Working

Watch the engine terminal for trade activity. Engine logs look like:

```
[HOURLY BOT] Aggressive ENTRY | YES | Strike: $102,500 | Contracts: 80 | BTC: $102,345
[HOURLY BOT] Order placed | Order ID: abc-123 | Status: resting
[HOURLY BOT] Settlement | WIN | P&L: +$23.45
```

Also check the dashboard — active positions and daily P&L update in real time.

---

## Going to Production (Real Money)

Only after running demo mode successfully:

1. Change `.env`:
   ```env
   KALSHI_DEMO_MODE=false
   KALSHI_API_KEY_ID=your-production-key-id
   KALSHI_PRIVATE_KEY_PATH=./kalshi-production-key.pem
   ```
2. Copy your production PEM file into the project root
3. Restart both terminals
4. Start with small capital amounts ($5–10/trade) for the first session

---

## Running 24/7 with pm2

For persistent operation (server or always-on machine):

```bash
npm install -g pm2

pm2 start npm --name "marketwatch-dashboard" -- run dev
pm2 start npm --name "marketwatch-engine" -- run engine -- --mode=bots
pm2 save
pm2 startup   # auto-restart on reboot
```

Monitor logs:
```bash
pm2 logs marketwatch-engine
```

---

## Stopping

```bash
# Ctrl+C in each terminal, or if using pm2:
pm2 stop all
```

---

## Troubleshooting

**Dashboard loads but BTC price shows "—"**
- Engine is not running — start `npm run engine -- --mode=bots` in a second terminal

**"Failed to initialize Kalshi client"**
- Double-check `KALSHI_API_KEY_ID` and that the `.pem` file is in the project root
- Confirm the API key is active on kalshi.com

**Grok bots show errors in logs**
- Confirm `XAI_API_KEY` is set in `.env`
- Grok bots are optional — disable them in the dashboard if you don't need AI decisions

**No trades after several minutes**
- Kalshi markets run on a schedule. KXBTCD opens each hour; KXBTC15M opens every 15 minutes
- Bots only enter when their signal conditions are met — no signal = no trade
- Check engine logs to see what conditions are failing
