#!/usr/bin/env python3
"""
Stop-Loss Backtest — Real BTC Price Data (Binance 5-min klines)

Downloads 365 days of real BTCUSDT 5-min candles from Binance,
simulates 15-minute Kalshi contract windows, and sweeps:

  1. Stop-loss threshold: none | bid drops to 20/30/40/50/70% of entry
  2. Entry timing: minute 2, 3, 4, 5, 6, 7 into the 15-min window

For each combo, reports: trades, win rate, total PnL, max drawdown,
and capital recovery from stop-losses (vs full loss).

Key model assumptions:
  - Contract: YES if BTC closes above open price at window start
  - Entry price: estimated from normal CDF (time/vol aware)
  - Stop-loss exit: sell at current contract fair value when bid hits threshold
  - Fee: 1.5% taker on entry; 1.5% on early exit, 0% on settlement
  - Position size: fixed $20 (same as backtest_combined.py)
"""

import urllib.request
import urllib.error
import json
import os
import math
import time
import sys

CACHE_FILE = "data/btc_5min_real.json"
POSITION_SIZE = 20.0
TAKER_FEE = 0.015
STRIKE_INCREMENT = 250  # Kalshi $250 strike ladder

# ──── Data download ────

def fetch_binance_klines(symbol, interval, start_ms, end_ms, limit=1000):
    url = (
        f"https://api.binance.com/api/v3/klines"
        f"?symbol={symbol}&interval={interval}"
        f"&startTime={start_ms}&endTime={end_ms}&limit={limit}"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except Exception:
        # Fallback to binance.us
        url2 = url.replace("api.binance.com", "api.binance.us")
        try:
            req2 = urllib.request.Request(url2, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req2, timeout=15) as resp2:
                return json.loads(resp2.read())
        except Exception as e:
            raise RuntimeError(f"Both Binance endpoints failed: {e}")


def load_or_fetch_candles(days=365):
    os.makedirs("data", exist_ok=True)

    if os.path.exists(CACHE_FILE):
        print(f"  Loading cached data from {CACHE_FILE}...")
        with open(CACHE_FILE) as f:
            candles = json.load(f)
        print(f"  Loaded {len(candles):,} candles from cache")
        return candles

    print(f"  Fetching {days} days of 5-min BTCUSDT data from Binance...")
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - days * 24 * 3600 * 1000
    interval_ms = 5 * 60 * 1000  # 5 minutes

    all_klines = []
    current_start = start_ms
    batch = 0

    while current_start < end_ms:
        batch += 1
        batch_end = min(current_start + 1000 * interval_ms, end_ms)

        try:
            klines = fetch_binance_klines("BTCUSDT", "5m", current_start, batch_end)
        except RuntimeError as e:
            print(f"\n  Error on batch {batch}: {e}")
            break

        if not klines:
            break

        all_klines.extend(klines)
        current_start = klines[-1][0] + interval_ms

        if batch % 10 == 0:
            pct = (current_start - start_ms) / (end_ms - start_ms) * 100
            print(f"  Batch {batch}: {len(all_klines):,} candles ({pct:.0f}%)", end="\r")

        time.sleep(0.1)  # Be polite to API

    print(f"\n  Downloaded {len(all_klines):,} candles total")

    # Convert to dicts
    candles = [{
        "t": k[0],           # open time ms
        "o": float(k[1]),    # open
        "h": float(k[2]),    # high
        "l": float(k[3]),    # low
        "c": float(k[4]),    # close
        "v": float(k[5]),    # volume
    } for k in all_klines]

    with open(CACHE_FILE, "w") as f:
        json.dump(candles, f)
    print(f"  Saved to {CACHE_FILE}")
    return candles


# ──── Group into 15-min windows ────

def group_into_windows(candles):
    """
    Group 5-min candles into 15-min windows.
    Each window = 3 consecutive 5-min candles aligned to 15-min boundaries.
    Returns list of windows: {open_price, candles[3], close_price, vol}
    """
    windows = []

    i = 0
    while i + 2 < len(candles):
        t = candles[i]["t"]
        # Check alignment: open_time must be on a 15-min boundary
        minute_of_hour = (t // 60000) % 60
        if minute_of_hour % 15 != 0:
            i += 1
            continue

        w_candles = candles[i:i+3]
        # Verify they are consecutive (no gaps)
        for j in range(1, 3):
            if w_candles[j]["t"] - w_candles[j-1]["t"] > 6 * 60 * 1000:  # >6 min gap
                break
        else:
            open_price = w_candles[0]["o"]
            close_price = w_candles[2]["c"]
            high = max(c["h"] for c in w_candles)
            low = min(c["l"] for c in w_candles)
            vol = sum(c["v"] for c in w_candles)

            windows.append({
                "t": t,
                "open": open_price,
                "close": close_price,
                "high": high,
                "low": low,
                "vol": vol,
                "candles": w_candles,
            })
            i += 3
            continue
        i += 1

    return windows


# ──── Probability / pricing model ────

def normal_cdf(x):
    a1, a2, a3, a4, a5 = 0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429
    p = 0.3275911
    sign = -1 if x < 0 else 1
    x = abs(x)
    t_val = 1.0 / (1.0 + p * x)
    y = 1.0 - (((((a5*t_val+a4)*t_val)+a3)*t_val+a2)*t_val+a1)*t_val*math.exp(-x*x/2.0)
    return 0.5 * (1.0 + sign * y)


def contract_fair_value(current_price, strike, vol_pct, mins_remaining):
    """
    P(price > strike at expiry) given current price, vol, and time remaining.
    vol_pct: annualised vol as a percentage (e.g. 65.0 for 65%)
    """
    if mins_remaining <= 0:
        return 1.0 if current_price > strike else 0.0
    hourly_vol = vol_pct / 100 / math.sqrt(8760)
    time_hours = mins_remaining / 60
    sigma = current_price * hourly_vol * math.sqrt(time_hours)
    if sigma <= 0:
        return 1.0 if current_price >= strike else 0.0
    z = (current_price - strike) / sigma
    return max(0.01, min(0.99, normal_cdf(z)))


def rolling_vol(windows, idx, lookback=48):
    """Annualised vol from recent 15-min window returns (as %)."""
    if idx < lookback + 1:
        return 65.0  # default
    returns = []
    for j in range(idx - lookback, idx):
        if windows[j]["open"] > 0:
            r = (windows[j]["close"] - windows[j]["open"]) / windows[j]["open"]
            returns.append(r)
    if not returns:
        return 65.0
    variance = sum(r*r for r in returns) / len(returns)
    # Annualise: there are 35,040 15-min periods per year
    ann_vol = math.sqrt(variance * 35040) * 100
    return max(20.0, min(200.0, ann_vol))


# ──── Fee calculation ────

def net_pnl(contracts, entry_price, exit_price, exit_type):
    entry_cost = contracts * entry_price
    entry_fee = entry_cost * TAKER_FEE
    total_entry = entry_cost + entry_fee
    exit_rev = contracts * exit_price
    if exit_type == "early":
        exit_fee = exit_rev * TAKER_FEE
        return (exit_rev - exit_fee) - total_entry
    return exit_rev - total_entry  # settlement: no exit fee


# ──── Simulate a single 15-min trade ────

def simulate_trade(window, entry_minute, stop_loss_ratio, vol):
    """
    entry_minute: which 5-min candle to enter on (0=start, 1=5min in, 2=10min in)
    stop_loss_ratio: exit if bid drops to this fraction of entry price (e.g. 0.3 = 30%)
                     None = no stop-loss
    Returns: (pnl, exit_type, win)
    """
    open_price = window["open"]

    # Strike: floor to nearest $250 (same convention as aggressive.ts)
    strike = math.floor(open_price / STRIKE_INCREMENT) * STRIKE_INCREMENT

    # Entry timing: 5-min boundaries within the 15-min window
    # minute 0 = candle 0 open, minute 5 = candle 1 open, minute 10 = candle 2 open
    entry_candle_idx = entry_minute // 5
    if entry_candle_idx >= len(window["candles"]):
        return None

    entry_price_btc = window["candles"][entry_candle_idx]["o"]
    mins_remaining_at_entry = 15 - entry_minute

    # Entry contract price
    fv_at_entry = contract_fair_value(entry_price_btc, strike, vol, mins_remaining_at_entry)
    # Cap at 48¢ (same as updated getEntryPrice)
    entry_contract_price = min(0.48, fv_at_entry)
    if entry_contract_price < 0.01:
        return None

    contracts = math.floor(POSITION_SIZE / entry_contract_price)
    if contracts < 1:
        return None

    # Stop-loss check: monitor price each 5-min candle after entry
    # For each remaining candle, compute contract fair value
    # If bid (≈ fair value * 0.95 to account for spread) drops below threshold, exit
    for candle_offset in range(entry_candle_idx + 1, 3):
        candle = window["candles"][candle_offset]
        mins_elapsed = (candle_offset - entry_candle_idx) * 5
        mins_left = mins_remaining_at_entry - mins_elapsed

        # Use candle low as worst-case price check
        low_price = candle["l"]
        fv_at_low = contract_fair_value(low_price, strike, vol, mins_left)
        bid_at_low = fv_at_low * 0.95  # approximate bid = fair value * 0.95

        if stop_loss_ratio is not None and bid_at_low < entry_contract_price * stop_loss_ratio:
            # Stop-loss triggered — exit at this bid
            pnl = net_pnl(contracts, entry_contract_price, bid_at_low, "early")
            return pnl, "stop_loss", False

        # Also check EV-based early exit (profitable exits)
        close_price = candle["c"]
        fv_at_close = contract_fair_value(close_price, strike, vol, max(mins_left - 5, 1))
        bid_at_close = fv_at_close * 0.95
        early_pnl = net_pnl(contracts, entry_contract_price, bid_at_close, "early")
        settle_ev = (fv_at_close * net_pnl(contracts, entry_contract_price, 1.0, "settlement") +
                     (1 - fv_at_close) * net_pnl(contracts, entry_contract_price, 0.0, "settlement"))
        if early_pnl > settle_ev * 1.2 and early_pnl > 0:
            return early_pnl, "early_profit", True

    # Hold to settlement
    won = window["close"] > strike
    exit_price = 1.0 if won else 0.0
    pnl = net_pnl(contracts, entry_contract_price, exit_price, "settlement")
    return pnl, "settlement", won


# ──── Run full backtest for one config ────

def run_backtest(windows, entry_minute, stop_loss_ratio):
    bankroll = 100.0
    peak_pnl = 0.0
    total_pnl = 0.0
    max_dd = 0.0
    trades = wins = losses = stop_losses = early_profits = 0
    capital_recovered_by_sl = 0.0  # how much stop-losses recovered vs full loss

    # Need at least 48 windows of history for vol calculation
    for i in range(48, len(windows)):
        if bankroll < POSITION_SIZE * 0.5:
            break

        vol = rolling_vol(windows, i)
        result = simulate_trade(windows[i], entry_minute, stop_loss_ratio, vol)
        if result is None:
            continue

        pnl, exit_type, won = result
        trades += 1
        total_pnl += pnl
        bankroll += pnl

        if exit_type == "stop_loss":
            stop_losses += 1
            losses += 1
            # What would full loss have been?
            w = windows[i]
            strike = math.floor(w["open"] / STRIKE_INCREMENT) * STRIKE_INCREMENT
            entry_candle_idx = entry_minute // 5
            entry_price_btc = w["candles"][entry_candle_idx]["o"]
            mins_rem = 15 - entry_minute
            fv = contract_fair_value(entry_price_btc, strike, vol, mins_rem)
            ep = min(0.48, fv)
            c = math.floor(POSITION_SIZE / ep) if ep > 0.01 else 0
            if c > 0:
                full_loss = net_pnl(c, ep, 0.0, "settlement")
                capital_recovered_by_sl += (pnl - full_loss)
        elif exit_type == "early_profit":
            early_profits += 1
            wins += 1
        elif won:
            wins += 1
        else:
            losses += 1

        if total_pnl > peak_pnl:
            peak_pnl = total_pnl
        dd = peak_pnl - total_pnl
        if dd > max_dd:
            max_dd = dd

    wr = wins / trades * 100 if trades > 0 else 0
    exp = total_pnl / trades if trades > 0 else 0

    return {
        "trades": trades,
        "wins": wins,
        "losses": losses,
        "stop_losses": stop_losses,
        "early_profits": early_profits,
        "win_rate": wr,
        "total_pnl": total_pnl,
        "final_bankroll": bankroll,
        "max_dd": max_dd,
        "expectancy": exp,
        "sl_capital_recovered": capital_recovered_by_sl,
    }


# ──── Main ────

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    start = time.time()

    print("=" * 100)
    print("  STOP-LOSS BACKTEST — REAL BTC DATA (Binance 5-min klines)")
    print("=" * 100)

    # ── Fetch / load data ──
    candles = load_or_fetch_candles(days=365)

    # ── Group into 15-min windows ──
    print("\n  Grouping into 15-min windows...")
    windows = group_into_windows(candles)
    first_date = time.strftime("%Y-%m-%d", time.gmtime(windows[0]["t"] / 1000))
    last_date  = time.strftime("%Y-%m-%d", time.gmtime(windows[-1]["t"] / 1000))
    print(f"  {len(windows):,} windows | {first_date} to {last_date}")

    # ── Configs to sweep ──
    ENTRY_MINUTES = [0, 5, 10]   # 5-min candle boundaries (0=open, 5=mid, 10=last)
    ENTRY_LABELS  = ["min 0", "min 5", "min 10"]

    STOP_LOSSES = [None, 0.70, 0.50, 0.40, 0.30, 0.20]
    SL_LABELS   = ["none", "70%", "50%", "40%", "30%", "20%"]

    # ── Run sweep ──
    print("\n  Running sweep (entry timing x stop-loss threshold)...")
    results = {}
    for em, el in zip(ENTRY_MINUTES, ENTRY_LABELS):
        results[el] = {}
        for sl, sl_label in zip(STOP_LOSSES, SL_LABELS):
            r = run_backtest(windows, em, sl)
            results[el][sl_label] = r

    # ── Print results by entry timing ──
    for el in ENTRY_LABELS:
        print(f"\n{'=' * 100}")
        print(f"  ENTRY TIMING: {el}")
        print(f"{'=' * 100}")
        print(f"  {'SL':>6}  {'Trades':>7}  {'WR':>6}  {'$/Trade':>9}  "
              f"{'Total PnL':>11}  {'Final $':>9}  {'MaxDD':>8}  "
              f"{'SL Count':>9}  {'SL Recovered':>13}  {'EarlyExit':>10}")
        print(f"  {'-' * 92}")
        for sl_label in SL_LABELS:
            r = results[el][sl_label]
            sl_rec = f"${r['sl_capital_recovered']:+.2f}" if r["stop_losses"] > 0 else "  n/a"
            print(f"  {sl_label:>6}  {r['trades']:>7}  {r['win_rate']:>5.1f}%  "
                  f"${r['expectancy']:>+7.2f}  ${r['total_pnl']:>+10.2f}  "
                  f"${r['final_bankroll']:>8.2f}  ${r['max_dd']:>7.2f}  "
                  f"{r['stop_losses']:>9}  {sl_rec:>13}  {r['early_profits']:>10}")

    # ── Summary: best config overall ──
    print(f"\n{'=' * 100}")
    print("  SUMMARY: BEST CONFIG BY TOTAL PnL")
    print(f"{'=' * 100}")
    best_pnl = -999999
    best_label = ""
    best_r = None
    for el in ENTRY_LABELS:
        for sl_label in SL_LABELS:
            r = results[el][sl_label]
            if r["total_pnl"] > best_pnl:
                best_pnl = r["total_pnl"]
                best_label = f"Entry={el}, SL={sl_label}"
                best_r = r

    print(f"\n  Best: {best_label}")
    print(f"  Trades: {best_r['trades']} | WR: {best_r['win_rate']:.1f}% | "
          f"$/trade: ${best_r['expectancy']:+.2f} | "
          f"Total PnL: ${best_r['total_pnl']:+.2f} | "
          f"MaxDD: ${best_r['max_dd']:.2f}")

    # ── Stop-loss verdict ──
    print(f"\n{'=' * 100}")
    print("  STOP-LOSS VERDICT")
    print(f"{'=' * 100}")
    for el in ENTRY_LABELS:
        no_sl = results[el]["none"]
        print(f"\n  Entry {el}:")
        for sl_label in SL_LABELS[1:]:  # skip "none"
            r = results[el][sl_label]
            delta = r["total_pnl"] - no_sl["total_pnl"]
            verdict = "HELPS" if delta > 0 else "HURTS"
            print(f"    SL {sl_label:>4}: {verdict}  PnL delta ${delta:+.2f}  "
                  f"({r['stop_losses']} triggers, recovered ${r['sl_capital_recovered']:+.2f} "
                  f"vs holding to zero)")

    elapsed = time.time() - start
    print(f"\n  Runtime: {elapsed:.1f}s")
    print()
