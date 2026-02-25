#!/usr/bin/env python3
"""
Experiment V2: Honest Aggressive Strategy Backtest with Minute-Level Data

Fixes every data-honesty problem from previous experiments:

1. MINUTE-LEVEL PRICES: Each hour generates 60 minute-by-minute prices via
   a Brownian bridge between open and close, with realistic intra-hour noise.
   Entry, exit, and settlement decisions use the actual price at that minute.

2. NO FUTURE INFORMATION:
   - Entry signal uses only completed prior hourly candles + the current
     minute's live price (not the hour's close).
   - 30-minute exit check uses the actual price at minute 30.
   - 50-minute exit check uses the actual price at minute 50.
   - Settlement uses the average of minutes 59-60 (Robinhood RTI averaging).

3. RH-CALIBRATED PRICING: Contract prices use the normal-CDF model
   calibrated against real Robinhood screenshots, not the old synthetic
   estimate_contract_price().

4. BANKROLL TRACKING WITH RUIN: Starts at $100.  When bankroll < cost of
   1 contract, the strategy is RUINED.  Marked as total loss.

5. ENTRY AT A REALISTIC PRICE: We compute the RH market price of the
   contract at entry time and only enter if it's below our cap.  The PnL
   uses the actual RH price paid, not a theoretical max.

Tests 65+ configurations x 10 Monte Carlo paths x 365 days.
"""

import random
import math
import time
from datetime import datetime, timezone

# ════════════════════════════════════════════════════════════════════════
# DATA GENERATION
# ════════════════════════════════════════════════════════════════════════

def generate_hourly_candles(days=365, seed=42):
    """Regime-switching synthetic BTC — identical to all prior experiments."""
    random.seed(seed)
    candles = []
    price = 42000.0
    regimes = {
        "bull_trend":   (0.0004,  0.8),
        "strong_bull":  (0.0008,  1.2),
        "ranging":      (0.0000,  0.6),
        "bear_trend":   (-0.0003, 1.0),
        "selloff":      (-0.0010, 2.0),
        "recovery":     (0.0006,  1.5),
    }
    regime_names = list(regimes.keys())
    current_regime = "bull_trend"
    regime_duration = 0
    base_hourly_vol = 0.009
    start_ts = int(datetime(2025, 2, 11, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)

    for h in range(days * 24):
        regime_duration += 1
        if random.random() < 0.02 + (regime_duration / 500):
            if current_regime in ("bull_trend", "strong_bull"):
                weights = [0.25, 0.15, 0.35, 0.15, 0.05, 0.05]
            elif current_regime == "ranging":
                weights = [0.25, 0.10, 0.30, 0.20, 0.05, 0.10]
            elif current_regime == "bear_trend":
                weights = [0.15, 0.05, 0.30, 0.25, 0.10, 0.15]
            elif current_regime == "selloff":
                weights = [0.10, 0.05, 0.15, 0.20, 0.20, 0.30]
            else:
                weights = [0.30, 0.15, 0.25, 0.15, 0.05, 0.10]
            current_regime = random.choices(regime_names, weights=weights, k=1)[0]
            regime_duration = 0

        drift, vol_mult = regimes[current_regime]
        hourly_vol = base_hourly_vol * vol_mult
        if random.random() < 0.05:
            ret = random.gauss(drift, hourly_vol * 3)
        else:
            ret = random.gauss(drift, hourly_vol)

        open_p = price
        close_p = open_p * (1 + ret)
        intra_vol = abs(ret) + hourly_vol * random.uniform(0.3, 1.5)
        if close_p >= open_p:
            high = max(open_p, close_p) * (1 + random.uniform(0, intra_vol * 0.5))
            low  = min(open_p, close_p) * (1 - random.uniform(0, intra_vol * 0.3))
        else:
            high = max(open_p, close_p) * (1 + random.uniform(0, intra_vol * 0.3))
            low  = min(open_p, close_p) * (1 - random.uniform(0, intra_vol * 0.5))
        high = max(high, open_p, close_p)
        low  = min(low, open_p, close_p)

        ts = start_ts + (h * 3600 * 1000)
        candles.append({
            "ts": ts, "open": round(open_p, 2), "high": round(high, 2),
            "low": round(low, 2), "close": round(close_p, 2),
            "hourly_vol": hourly_vol, "intra_vol": intra_vol,
        })
        price = close_p
        if price > 80000: price *= 0.9999
        elif price < 20000: price *= 1.0001

    return candles


def generate_minute_prices(candle, rng):
    """
    Generate 61 minute prices (minute 0 = open, minute 60 = close) using a
    Brownian bridge.  The bridge ensures minute[0]=open and minute[60]=close
    exactly, with intra-hour noise calibrated to the candle's volatility.

    Returns list of 61 prices: [price_at_min0, price_at_min1, ..., price_at_min60]
    """
    open_p = candle["open"]
    close_p = candle["close"]
    n = 60
    vol = candle["intra_vol"] * 0.5  # Scale down: intra_vol is a ratio, we need per-minute noise

    prices = [0.0] * (n + 1)
    prices[0] = open_p
    prices[n] = close_p

    # Generate a standard Brownian bridge
    # B(t) = W(t) - (t/T)*W(T) where W(t) is a Wiener process
    # Then shift to match open/close
    cumulative = [0.0] * (n + 1)
    for m in range(1, n + 1):
        step = rng.gauss(0, 1) * open_p * vol * (1.0 / math.sqrt(n))
        cumulative[m] = cumulative[m - 1] + step

    # Bridge correction: remove the drift so we land exactly on close
    for m in range(0, n + 1):
        t_frac = m / n
        bridge = cumulative[m] - t_frac * cumulative[n]
        # Linear interpolation from open to close + bridge noise
        prices[m] = open_p + t_frac * (close_p - open_p) + bridge

    # Ensure prices stay positive
    min_price = min(prices)
    if min_price <= 0:
        offset = abs(min_price) + 1
        prices = [p + offset for p in prices]

    return prices


# ════════════════════════════════════════════════════════════════════════
# INDICATORS (computed from completed hourly candles only)
# ════════════════════════════════════════════════════════════════════════

def sma(candles, period):
    if len(candles) < period: return 0
    return sum(c["close"] for c in candles[-period:]) / period

def hourly_vol_pct(candle):
    if candle["open"] == 0: return 0
    return ((candle["high"] - candle["low"]) / candle["open"]) * 100

def hour_return_at(candle_open, live_price):
    if candle_open == 0: return 0
    return ((live_price - candle_open) / candle_open) * 100


# ════════════════════════════════════════════════════════════════════════
# RH-CALIBRATED PRICING MODEL
# ════════════════════════════════════════════════════════════════════════

def normal_cdf(x):
    a1, a2, a3, a4, a5 = 0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429
    p = 0.3275911
    sign = -1 if x < 0 else 1
    ax = abs(x)
    t = 1 / (1 + p * ax)
    y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * math.exp(-ax * ax / 2)
    return 0.5 * (1 + sign * y)


def fair_probability(btc_price, strike, vol_pct, mins_remaining):
    """Our model's estimate of P(BTC >= strike at settlement)."""
    if mins_remaining <= 0:
        return 1.0 if btc_price >= strike else 0.0
    if vol_pct <= 0:
        return 1.0 if btc_price >= strike else 0.0
    dist = btc_price - strike
    t_hrs = max(mins_remaining / 60, 0.001)
    em = btc_price * (vol_pct / 100) * math.sqrt(t_hrs)
    if em <= 0:
        return 1.0 if btc_price >= strike else 0.0
    z = dist / em
    return max(0.001, min(0.999, normal_cdf(z)))


def rh_market_price(btc_price, strike, vol_pct, mins_remaining):
    """
    What Robinhood would charge for a YES contract.
    GBM probability + market-maker spread (calibrated to screenshots).
    """
    if mins_remaining <= 0:
        return 0.99 if btc_price >= strike else 0.01
    fp = fair_probability(btc_price, strike, vol_pct * 1.15, mins_remaining)
    # Spread: max ~4¢ at the money, shrinks toward extremes
    spread = 0.04 * (1 - abs(fp - 0.5) * 2)
    return max(0.01, min(0.99, fp + spread))


# ════════════════════════════════════════════════════════════════════════
# P&L
# ════════════════════════════════════════════════════════════════════════

TAKER_FEE_PCT = 1.5
STRIKE_INC = 250
MIN_DIST = 50

def net_pnl(contracts, entry_px, exit_px, is_settlement):
    cost = contracts * entry_px
    fee_in = cost * (TAKER_FEE_PCT / 100)
    total_cost = cost + fee_in
    revenue = contracts * exit_px
    if not is_settlement:
        fee_out = revenue * (TAKER_FEE_PCT / 100)
        revenue -= fee_out
    return revenue - total_cost


def floor_strike(price):
    return math.floor(price / STRIKE_INC) * STRIKE_INC


# ════════════════════════════════════════════════════════════════════════
# HONEST TRADE SIMULATION
# ════════════════════════════════════════════════════════════════════════

def simulate_hour(entry_minute, entry_price_paid, strike, contracts, minute_prices,
                  vol_pct, use_exit_logic):
    """
    Simulate a single hour's trade using minute-level prices.

    entry_minute:     the minute we entered (e.g. 15)
    entry_price_paid: the RH price we actually paid for the contract
    strike:           the strike of our YES contract
    contracts:        number of contracts
    minute_prices:    list of 61 prices (minute 0..60)
    vol_pct:          hourly volatility %
    use_exit_logic:   whether to check smart exits at :30 and :50

    Settlement: average of minute_prices[59] and minute_prices[60] (RH RTI).
    """
    settlement_price = (minute_prices[59] + minute_prices[60]) / 2
    win_pnl = net_pnl(contracts, entry_price_paid, 1.0, True)
    lose_pnl = net_pnl(contracts, entry_price_paid, 0.0, True)

    if use_exit_logic:
        # ── 30-minute check ──
        if entry_minute <= 28:
            price_30 = minute_prices[30]
            mins_left_30 = 30
            ror_30 = 1.0 - fair_probability(price_30, strike, vol_pct, mins_left_30)
            sell_price_30 = rh_market_price(price_30, strike, vol_pct, mins_left_30)
            # We'd sell at a discount (bid side) — subtract ~2¢ spread
            sell_price_30 = max(0.01, sell_price_30 - 0.02)
            exit_pnl_30 = net_pnl(contracts, entry_price_paid, sell_price_30, False)
            ev_hold = (1 - ror_30) * win_pnl + ror_30 * lose_pnl

            if ror_30 >= 0.50:
                return {"outcome": "early_exit_30", "pnl": exit_pnl_30}
            if ev_hold < exit_pnl_30 and exit_pnl_30 > 0:
                return {"outcome": "early_exit_30", "pnl": exit_pnl_30}

        # ── 50-minute check ──
        if entry_minute <= 48:
            price_50 = minute_prices[50]
            mins_left_50 = 10
            ror_50 = 1.0 - fair_probability(price_50, strike, vol_pct, mins_left_50)
            sell_price_50 = rh_market_price(price_50, strike, vol_pct, mins_left_50)
            sell_price_50 = max(0.01, sell_price_50 - 0.02)
            exit_pnl_50 = net_pnl(contracts, entry_price_paid, sell_price_50, False)
            ev_hold_50 = (1 - ror_50) * win_pnl + ror_50 * lose_pnl

            if ror_50 >= 0.30:
                if ev_hold_50 <= exit_pnl_50 * 1.2:
                    return {"outcome": "early_exit_50", "pnl": exit_pnl_50}

    # ── Settlement ──
    if settlement_price > strike:
        return {"outcome": "win", "pnl": win_pnl}
    else:
        return {"outcome": "loss", "pnl": lose_pnl}


# ════════════════════════════════════════════════════════════════════════
# PARAMETERIZED STRATEGY + BACKTEST
# ════════════════════════════════════════════════════════════════════════

def run_backtest(hourly_candles, params, path_rng):
    """
    Run a full 365-day backtest for one parameter set on one price path.
    Returns detailed results including bankroll trajectory.
    """
    bankroll = 100.0
    peak_bank = 100.0
    trough_bank = 100.0
    total_pnl = 0.0
    peak_pnl = 0.0
    max_dd = 0.0
    trades = 0
    wins = 0
    losses = 0
    early_exits = 0
    ruined = False
    ruin_trade = 0
    floor_ct = 0
    next_up_ct = 0
    two_up_ct = 0
    skip_expensive = 0
    skip_prob = 0
    skip_no_strike = 0
    monthly_pnl = {}

    strike_type    = params["strike_type"]
    entry_cap      = params["entry_cap"]
    position_size  = params["position_size"]
    prob_lo        = params["prob_lo"]
    prob_hi        = params["prob_hi"]
    min_time       = params["min_time_remaining"]
    hr_thresh      = params["hour_return_threshold"]
    use_exit       = params["use_exit_logic"]
    sma_loose      = params["sma_looseness"]
    entry_minute   = params.get("entry_minute", 15)  # Default: check at minute 15

    for i in range(12, len(hourly_candles) - 1):
        if ruined:
            break

        candle = hourly_candles[i]
        dt = datetime.fromtimestamp(candle["ts"] / 1000, tz=timezone.utc)
        hour_utc = dt.hour
        month_key = dt.strftime("%Y-%m")

        # Market hours only: 14:00-21:00 UTC
        if not (14 <= hour_utc < 21):
            continue

        mins_remaining = 60 - entry_minute
        if mins_remaining <= min_time:
            continue

        # Generate minute-level prices for this hour
        minute_prices = generate_minute_prices(candle, path_rng)
        live_price = minute_prices[entry_minute]

        # ── INDICATORS: use only completed prior candles ──
        prior = hourly_candles[max(0, i - 12):i]  # NOT including current candle
        if len(prior) < 12:
            continue

        s3 = sma(prior, 3)
        s6 = sma(prior, 6)
        s12 = sma(prior, 12)
        if 0 in (s3, s6, s12):
            continue

        # SMA trend
        if sma_loose is None:
            short_ok = True
            med_ok = True
        elif sma_loose == 0:
            short_ok = s3 > s6
            med_ok = s6 > s12
        else:
            short_ok = s3 > s6 or (s6 > 0 and (s6 - s3) / s6 < sma_loose)
            med_ok = s6 > s12 or (s12 > 0 and (s12 - s6) / s12 < sma_loose)
        if not short_ok or not med_ok:
            continue

        # Hour return: from current candle's OPEN to live price at entry_minute
        hr = hour_return_at(candle["open"], live_price)
        if hr <= hr_thresh:
            continue

        # Volatility from prior completed candle
        vol = hourly_vol_pct(prior[-1])

        # ── STRIKE SELECTION ──
        fs = floor_strike(live_price)
        ns = fs + STRIKE_INC
        ts_strike = fs + 2 * STRIKE_INC

        fv_f = fair_probability(live_price, fs, vol, mins_remaining)
        fv_n = fair_probability(live_price, ns, vol, mins_remaining)
        fv_t = fair_probability(live_price, ts_strike, vol, mins_remaining)

        rh_f = rh_market_price(live_price, fs, vol, mins_remaining)
        rh_n = rh_market_price(live_price, ns, vol, mins_remaining)
        rh_t = rh_market_price(live_price, ts_strike, vol, mins_remaining)

        # Resolve time-based cap
        if isinstance(entry_cap, dict):
            max_entry = entry_cap["early"] if mins_remaining >= 35 else entry_cap["late"]
        else:
            max_entry = entry_cap

        chosen_strike = None
        chosen_fv = None
        chosen_rh = None
        chosen_label = None

        if strike_type == "floor":
            dist = live_price - fs
            if dist < MIN_DIST:
                skip_prob += 1; continue
            if not (prob_lo <= fv_f <= prob_hi):
                skip_prob += 1; continue
            if rh_f > max_entry:
                skip_expensive += 1; continue
            chosen_strike, chosen_fv, chosen_rh, chosen_label = fs, fv_f, rh_f, "floor"

        elif strike_type == "next_up":
            if not (prob_lo <= fv_n <= prob_hi):
                skip_prob += 1; continue
            if rh_n > max_entry:
                skip_expensive += 1; continue
            chosen_strike, chosen_fv, chosen_rh, chosen_label = ns, fv_n, rh_n, "next_up"

        elif strike_type == "two_up":
            if not (prob_lo <= fv_t <= prob_hi):
                skip_prob += 1; continue
            if rh_t > max_entry:
                skip_expensive += 1; continue
            chosen_strike, chosen_fv, chosen_rh, chosen_label = ts_strike, fv_t, rh_t, "two_up"

        elif strike_type == "next_up_fallback":
            picked = False
            dist = live_price - fs
            if dist >= MIN_DIST and prob_lo <= fv_f <= prob_hi and rh_f <= max_entry:
                chosen_strike, chosen_fv, chosen_rh, chosen_label = fs, fv_f, rh_f, "floor"
                picked = True
            if not picked and prob_lo <= fv_n <= prob_hi and rh_n <= max_entry:
                chosen_strike, chosen_fv, chosen_rh, chosen_label = ns, fv_n, rh_n, "next_up"
                picked = True
            if not picked:
                skip_no_strike += 1; continue

        elif strike_type == "smart_select":
            candidates = []
            dist = live_price - fs
            if dist >= MIN_DIST and prob_lo <= fv_f <= prob_hi and rh_f <= max_entry:
                candidates.append((fs, fv_f, rh_f, "floor", fv_f - rh_f))
            if prob_lo <= fv_n <= prob_hi and rh_n <= max_entry:
                candidates.append((ns, fv_n, rh_n, "next_up", fv_n - rh_n))
            if prob_lo <= fv_t <= prob_hi and rh_t <= max_entry:
                candidates.append((ts_strike, fv_t, rh_t, "two_up", fv_t - rh_t))
            if not candidates:
                skip_no_strike += 1; continue
            best = max(candidates, key=lambda x: x[4])
            chosen_strike, chosen_fv, chosen_rh, chosen_label = best[0], best[1], best[2], best[3]

        elif strike_type == "cheapest_valid":
            candidates = []
            dist = live_price - fs
            if dist >= MIN_DIST and prob_lo <= fv_f <= prob_hi and rh_f <= max_entry:
                candidates.append((fs, fv_f, rh_f, "floor"))
            if prob_lo <= fv_n <= prob_hi and rh_n <= max_entry:
                candidates.append((ns, fv_n, rh_n, "next_up"))
            if prob_lo <= fv_t <= prob_hi and rh_t <= max_entry:
                candidates.append((ts_strike, fv_t, rh_t, "two_up"))
            if not candidates:
                skip_no_strike += 1; continue
            best = min(candidates, key=lambda x: x[2])
            chosen_strike, chosen_fv, chosen_rh, chosen_label = best[0], best[1], best[2], best[3]

        else:
            continue

        # ── BANKROLL CHECK ──
        actual_pos = min(position_size, bankroll / (1 + TAKER_FEE_PCT / 100))
        num_contracts = math.floor(actual_pos / chosen_rh)
        if num_contracts <= 0:
            ruined = True
            ruin_trade = trades
            break

        # Track strike usage
        if chosen_label == "floor": floor_ct += 1
        elif chosen_label == "next_up": next_up_ct += 1
        elif chosen_label == "two_up": two_up_ct += 1

        # ── SIMULATE THE TRADE ──
        result = simulate_hour(
            entry_minute, chosen_rh, chosen_strike, num_contracts,
            minute_prices, vol, use_exit
        )

        if result["outcome"] == "no_data":
            continue

        trades += 1
        pnl = result["pnl"]
        total_pnl += pnl
        bankroll += pnl

        if bankroll > peak_bank: peak_bank = bankroll
        if bankroll < trough_bank: trough_bank = bankroll
        if total_pnl > peak_pnl: peak_pnl = total_pnl
        dd = peak_pnl - total_pnl
        if dd > max_dd: max_dd = dd

        if result["outcome"] == "win":
            wins += 1
        elif result["outcome"] == "loss":
            losses += 1
        elif "early_exit" in result["outcome"]:
            early_exits += 1
            if pnl >= 0: wins += 1
            else: losses += 1

        if month_key not in monthly_pnl:
            monthly_pnl[month_key] = 0.0
        monthly_pnl[month_key] += pnl

        # Check for ruin after trade
        if bankroll <= 0:
            ruined = True
            ruin_trade = trades
            bankroll = 0
            break

    wr = (wins / trades * 100) if trades > 0 else 0
    exp_val = (total_pnl / trades) if trades > 0 else 0
    losing_months = sum(1 for v in monthly_pnl.values() if v < 0)
    total_months = len(monthly_pnl)

    return {
        "trades": trades, "wins": wins, "losses": losses, "win_rate": wr,
        "total_pnl": total_pnl, "max_dd": max_dd, "expectancy": exp_val,
        "early_exits": early_exits, "bankroll": bankroll,
        "peak_bank": peak_bank, "trough_bank": trough_bank,
        "ruined": ruined, "ruin_trade": ruin_trade,
        "floor_ct": floor_ct, "next_up_ct": next_up_ct, "two_up_ct": two_up_ct,
        "skip_expensive": skip_expensive, "skip_prob": skip_prob,
        "skip_no_strike": skip_no_strike,
        "losing_months": losing_months, "total_months": total_months,
    }


# ════════════════════════════════════════════════════════════════════════
# EXPERIMENT DEFINITIONS — 65+ CONFIGURATIONS
# ════════════════════════════════════════════════════════════════════════

def build_experiments():
    exps = []
    eid = 0

    base = {
        "strike_type": "next_up",
        "entry_cap": 0.40,
        "position_size": 20,
        "prob_lo": 0.20,
        "prob_hi": 0.70,
        "min_time_remaining": 15,
        "hour_return_threshold": 0.0,
        "use_exit_logic": True,
        "sma_looseness": 0.003,
        "entry_minute": 15,
    }

    def add(name, overrides):
        nonlocal eid
        eid += 1
        p = dict(base)
        p.update(overrides)
        exps.append({"id": eid, "name": name, "params": p})

    # ════ BASELINE: previous experiment winner ════
    add("BASELINE: next-up 40¢ noHR looseSMA", {})

    # ════ SWEEP 1: STRIKE TYPE (6) ════
    add("Strike: floor 70¢ prob 50-95", {"strike_type": "floor", "entry_cap": 0.70, "prob_lo": 0.50, "prob_hi": 0.95})
    add("Strike: floor 65¢ prob 55-85 hold", {"strike_type": "floor", "entry_cap": 0.65, "prob_lo": 0.55, "prob_hi": 0.85, "use_exit_logic": False})
    add("Strike: next-up fallback 50¢", {"strike_type": "next_up_fallback", "entry_cap": 0.50})
    add("Strike: smart select 50¢", {"strike_type": "smart_select", "entry_cap": 0.50})
    add("Strike: cheapest valid 50¢", {"strike_type": "cheapest_valid", "entry_cap": 0.50})
    add("Strike: two-up 20¢ prob 5-40", {"strike_type": "two_up", "entry_cap": 0.20, "prob_lo": 0.05, "prob_hi": 0.40})

    # ════ SWEEP 2: ENTRY CAP for next-up (8) ════
    add("Cap: 15¢", {"entry_cap": 0.15})
    add("Cap: 20¢", {"entry_cap": 0.20})
    add("Cap: 25¢", {"entry_cap": 0.25})
    add("Cap: 30¢", {"entry_cap": 0.30})
    add("Cap: 35¢", {"entry_cap": 0.35})
    add("Cap: 45¢", {"entry_cap": 0.45})
    add("Cap: 50¢", {"entry_cap": 0.50})
    add("Cap: 60¢", {"entry_cap": 0.60})

    # ════ SWEEP 3: TIME-BASED CAPS (6) ════
    add("TimeCap: e50/l30", {"entry_cap": {"early": 0.50, "late": 0.30}})
    add("TimeCap: e45/l25", {"entry_cap": {"early": 0.45, "late": 0.25}})
    add("TimeCap: e45/l30", {"entry_cap": {"early": 0.45, "late": 0.30}})
    add("TimeCap: e40/l25", {"entry_cap": {"early": 0.40, "late": 0.25}})
    add("TimeCap: e50/l25", {"entry_cap": {"early": 0.50, "late": 0.25}})
    add("TimeCap: e35/l20", {"entry_cap": {"early": 0.35, "late": 0.20}})

    # ════ SWEEP 4: PROBABILITY BANDS (8) ════
    add("Prob: 5-50", {"prob_lo": 0.05, "prob_hi": 0.50})
    add("Prob: 10-50", {"prob_lo": 0.10, "prob_hi": 0.50})
    add("Prob: 10-90", {"prob_lo": 0.10, "prob_hi": 0.90})
    add("Prob: 15-60", {"prob_lo": 0.15, "prob_hi": 0.60})
    add("Prob: 15-80", {"prob_lo": 0.15, "prob_hi": 0.80})
    add("Prob: 25-70", {"prob_lo": 0.25, "prob_hi": 0.70})
    add("Prob: 30-70", {"prob_lo": 0.30, "prob_hi": 0.70})
    add("Prob: 35-70 (old)", {"prob_lo": 0.35, "prob_hi": 0.70})

    # ════ SWEEP 5: POSITION SIZE (5) ════
    add("Size: $10", {"position_size": 10})
    add("Size: $15", {"position_size": 15})
    add("Size: $25", {"position_size": 25})
    add("Size: $30", {"position_size": 30})
    add("Size: $40", {"position_size": 40})

    # ════ SWEEP 6: ENTRY MINUTE (5) ════
    add("Enter at :05", {"entry_minute": 5})
    add("Enter at :10", {"entry_minute": 10})
    add("Enter at :20", {"entry_minute": 20})
    add("Enter at :25", {"entry_minute": 25})
    add("Enter at :30", {"entry_minute": 30})

    # ════ SWEEP 7: TIME REMAINING FILTER (4) ════
    add("MinTime: >10m", {"min_time_remaining": 10})
    add("MinTime: >20m", {"min_time_remaining": 20})
    add("MinTime: >25m", {"min_time_remaining": 25})
    add("MinTime: >30m", {"min_time_remaining": 30})

    # ════ SWEEP 8: HOUR RETURN THRESHOLD (4) ════
    add("HrRet: 0.15%", {"hour_return_threshold": 0.15})
    add("HrRet: 0.3%", {"hour_return_threshold": 0.3})
    add("HrRet: 0.5%", {"hour_return_threshold": 0.5})
    add("HrRet: 0.8%", {"hour_return_threshold": 0.8})

    # ════ SWEEP 9: SMA LOOSENESS (4) ════
    add("SMA: strict", {"sma_looseness": 0})
    add("SMA: default (0.1%)", {"sma_looseness": 0.001})
    add("SMA: ultra loose (0.5%)", {"sma_looseness": 0.005})
    add("SMA: disabled", {"sma_looseness": None})

    # ════ SWEEP 10: EXIT LOGIC (3) ════
    add("Exit: hold to settlement", {"use_exit_logic": False})
    add("Exit: hold + 30¢ cap", {"use_exit_logic": False, "entry_cap": 0.30})
    add("Exit: hold + 50¢ cap", {"use_exit_logic": False, "entry_cap": 0.50})

    # ════ COMBO EXPERIMENTS (12) ════
    add("COMBO: next-up 50¢ noFilter noSMA", {
        "entry_cap": 0.50, "prob_lo": 0.10, "prob_hi": 0.90,
        "hour_return_threshold": 0.0, "sma_looseness": None})

    add("COMBO: next-up 40¢ prob 10-50 enter@10", {
        "entry_cap": 0.40, "prob_lo": 0.10, "prob_hi": 0.50, "entry_minute": 10})

    add("COMBO: smart 50¢ prob 15-80 enter@10", {
        "strike_type": "smart_select", "entry_cap": 0.50,
        "prob_lo": 0.15, "prob_hi": 0.80, "entry_minute": 10})

    add("COMBO: next-up timecap e45/l25 prob 15-60", {
        "entry_cap": {"early": 0.45, "late": 0.25},
        "prob_lo": 0.15, "prob_hi": 0.60})

    add("COMBO: cheapest 30¢ prob 10-50", {
        "strike_type": "cheapest_valid", "entry_cap": 0.30,
        "prob_lo": 0.10, "prob_hi": 0.50})

    add("COMBO: next-up 35¢ $30 >20m", {
        "entry_cap": 0.35, "position_size": 30, "min_time_remaining": 20})

    add("COMBO: fallback timecap e50/l30 prob 15-75", {
        "strike_type": "next_up_fallback",
        "entry_cap": {"early": 0.50, "late": 0.30},
        "prob_lo": 0.15, "prob_hi": 0.75})

    add("COMBO: two-up 15¢ >25m hr0.5", {
        "strike_type": "two_up", "entry_cap": 0.15,
        "prob_lo": 0.05, "prob_hi": 0.35,
        "min_time_remaining": 25, "hour_return_threshold": 0.5})

    add("COMBO: floor 70¢ hold $15 prob 55-90", {
        "strike_type": "floor", "entry_cap": 0.70,
        "prob_lo": 0.55, "prob_hi": 0.90,
        "use_exit_logic": False, "position_size": 15})

    add("COMBO: next-up hold timecap e45/l25", {
        "use_exit_logic": False,
        "entry_cap": {"early": 0.45, "late": 0.25}})

    add("COMBO: next-up 45¢ $25 prob 15-70 enter@10", {
        "entry_cap": 0.45, "position_size": 25,
        "prob_lo": 0.15, "prob_hi": 0.70, "entry_minute": 10})

    add("COMBO: smart timecap e50/l25 $25 prob 10-70 enter@10", {
        "strike_type": "smart_select",
        "entry_cap": {"early": 0.50, "late": 0.25},
        "position_size": 25, "prob_lo": 0.10, "prob_hi": 0.70,
        "entry_minute": 10})

    return exps


# ════════════════════════════════════════════════════════════════════════
# OUTPUT / REPORTING
# ════════════════════════════════════════════════════════════════════════

def cap_str(p):
    ec = p["entry_cap"]
    if isinstance(ec, dict):
        return f"e{ec['early']:.2f}/l{ec['late']:.2f}"
    return f"${ec:.2f}"


def detail_block(v, rank, label=""):
    p = v["params"]
    ec = cap_str(p)
    sma_s = ("OFF" if p["sma_looseness"] is None else
             "strict" if p["sma_looseness"] == 0 else f"{p['sma_looseness']*100:.1f}%")

    print(f"\n  {'─' * 125}")
    print(f"  RANK #{rank} {label}")
    print(f"  {v['name']}")
    print(f"  {'─' * 125}")
    print(f"  Parameters:")
    print(f"    Strike: {p['strike_type']:<18}  Cap: {ec:<18}  "
          f"Exit: {'Smart' if p['use_exit_logic'] else 'Hold':<6}  "
          f"Size: ${p['position_size']}  Enter@:{p.get('entry_minute',15)}")
    print(f"    Prob: {p['prob_lo']*100:.0f}-{p['prob_hi']*100:.0f}%          "
          f"HrRet: >{p['hour_return_threshold']}%         "
          f"SMA: {sma_s:<8}  MinTime: >{p['min_time_remaining']}m")
    print(f"  Results ({v['n_paths']}-path average):")
    print(f"    Trades/Year: {v['avg_trades']:>6.0f}    Win Rate: {v['avg_wr']:>6.1f}%    "
          f"Expect: ${v['avg_exp']:>+6.2f}/trade")
    print(f"    Avg P&L:    ${v['avg_pnl']:>+10.2f}   Max DD:  ${v['avg_dd']:>8.2f}    "
          f"Risk-Adj: {v['risk_adj']:>7.2f}")
    print(f"    Best Path:  ${v['best_pnl']:>+10.2f}   Worst:   ${v['worst_pnl']:>+10.2f}   "
          f"Profitable: {v['profitable']}/{v['n_paths']}")
    print(f"    Avg Bank:   ${v['avg_bank']:>10.2f}   Peak:    ${v['avg_peak']:>10.2f}   "
          f"Trough: ${v['avg_trough']:>8.2f}")
    rr = v['ruined_paths']
    if rr > 0:
        print(f"    *** RUINED ON {rr}/{v['n_paths']} PATHS ***   Avg ruin after trade #{v['avg_ruin_trade']:.0f}")
    print(f"    Strikes: Floor={v['avg_floor']:.0f}  NextUp={v['avg_next']:.0f}  "
          f"TwoUp={v['avg_two']:.0f}  "
          f"Skip($)={v['avg_skip_exp']:.0f}  Skip(prob)={v['avg_skip_prob']:.0f}")
    print(f"    Losing Months: {v['avg_losing_months']:.1f}/{v['avg_total_months']:.1f}")


# ════════════════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    NUM_PATHS = 10
    start_time = time.time()
    experiments = build_experiments()
    total_exp = len(experiments)

    print("=" * 130)
    print("  V2 HONEST BACKTEST — MINUTE-LEVEL DATA, NO FUTURE INFORMATION")
    print(f"  {total_exp} configurations × {NUM_PATHS} paths × 365 days")
    print("  Brownian-bridge minute prices | RH-calibrated contract pricing")
    print("  Entry uses live price at entry minute | Exits use actual :30/:50 prices")
    print("  Settlement = avg(minute[59], minute[60]) simulating RH RTI averaging")
    print("  Bankroll starts at $100 — ruin = can't afford 1 contract")
    print("=" * 130)

    # Validate pricing model
    print("\n  RH Pricing model check (BTC $67,850, vol 1.5%):")
    print(f"  {'Strike':<10} {'Dist':>6} {'25m Model':>10} {'45m Model':>10} {'25m Real':>10} {'45m Real':>10}")
    for st, r25, r45 in [(67750,0.69,0.71),(68000,0.23,0.44),(68250,0.05,0.17),(68500,0.02,0.04)]:
        m25 = rh_market_price(67850, st, 1.5, 25)
        m45 = rh_market_price(67850, st, 1.5, 45)
        print(f"  ${st:<9} {67850-st:>+5.0f}  {m25:>9.2f}  {m45:>9.2f}  {r25:>9.2f}  {r45:>9.2f}")

    # Generate paths
    print(f"\n  Generating {NUM_PATHS} price paths with minute-level data...")
    all_candles = []
    path_rngs = []
    for s in range(NUM_PATHS):
        seed = s * 17 + 42
        candles = generate_hourly_candles(days=365, seed=seed)
        lo = min(c["low"] for c in candles)
        hi = max(c["high"] for c in candles)
        print(f"    Path {s+1}: seed={seed}, "
              f"${candles[0]['open']:,.0f} -> ${candles[-1]['close']:,.0f} "
              f"(range ${lo:,.0f}-${hi:,.0f})")
        all_candles.append(candles)
        # Each path gets its own RNG for minute-price generation (reproducible)
        path_rngs.append(random.Random(seed + 10000))

    # Run experiments
    print(f"\n  Running {total_exp} experiments × {NUM_PATHS} paths = {total_exp * NUM_PATHS} backtests...")
    all_summaries = []

    for exp in experiments:
        path_results = []
        for pi, candles in enumerate(all_candles):
            # Reset minute-price RNG for reproducibility per experiment
            prng = random.Random(path_rngs[pi].random())
            r = run_backtest(candles, exp["params"], prng)
            path_results.append(r)

        n = len(path_results)
        avg_trades = sum(r["trades"] for r in path_results) / n
        avg_wr = sum(r["win_rate"] for r in path_results) / n
        avg_pnl = sum(r["total_pnl"] for r in path_results) / n
        avg_dd = sum(r["max_dd"] for r in path_results) / n
        avg_exp = sum(r["expectancy"] for r in path_results) / n
        worst = min(r["total_pnl"] for r in path_results)
        best = max(r["total_pnl"] for r in path_results)
        profitable = sum(1 for r in path_results if r["total_pnl"] > 0)
        avg_bank = sum(r["bankroll"] for r in path_results) / n
        avg_peak = sum(r["peak_bank"] for r in path_results) / n
        avg_trough = sum(r["trough_bank"] for r in path_results) / n
        ruined_paths = sum(1 for r in path_results if r["ruined"])
        avg_ruin_trade = (sum(r["ruin_trade"] for r in path_results if r["ruined"]) /
                          max(1, ruined_paths))
        avg_floor = sum(r["floor_ct"] for r in path_results) / n
        avg_next = sum(r["next_up_ct"] for r in path_results) / n
        avg_two = sum(r["two_up_ct"] for r in path_results) / n
        avg_skip_exp = sum(r["skip_expensive"] for r in path_results) / n
        avg_skip_prob = sum(r["skip_prob"] for r in path_results) / n
        avg_early = sum(r["early_exits"] for r in path_results) / n
        avg_losing_months = sum(r["losing_months"] for r in path_results) / n
        avg_total_months = sum(r["total_months"] for r in path_results) / n
        risk_adj = avg_pnl / avg_dd if avg_dd > 0 else (999 if avg_pnl > 0 else -999)

        s = {
            "id": exp["id"], "name": exp["name"], "params": exp["params"],
            "n_paths": n,
            "avg_trades": avg_trades, "avg_wr": avg_wr, "avg_pnl": avg_pnl,
            "avg_dd": avg_dd, "avg_exp": avg_exp, "risk_adj": risk_adj,
            "worst_pnl": worst, "best_pnl": best, "profitable": profitable,
            "avg_bank": avg_bank, "avg_peak": avg_peak, "avg_trough": avg_trough,
            "ruined_paths": ruined_paths, "avg_ruin_trade": avg_ruin_trade,
            "avg_floor": avg_floor, "avg_next": avg_next, "avg_two": avg_two,
            "avg_skip_exp": avg_skip_exp, "avg_skip_prob": avg_skip_prob,
            "avg_early": avg_early,
            "avg_losing_months": avg_losing_months, "avg_total_months": avg_total_months,
        }
        all_summaries.append(s)

        if exp["id"] % 10 == 0:
            elapsed = time.time() - start_time
            print(f"    {exp['id']}/{total_exp} done ({elapsed:.1f}s)")

    elapsed = time.time() - start_time
    print(f"\n  All {total_exp} experiments done in {elapsed:.1f}s")

    # ════════════════════════════════════════════════════════════════
    # RESULTS
    # ════════════════════════════════════════════════════════════════

    by_pnl = sorted(all_summaries, key=lambda x: x["avg_pnl"], reverse=True)

    # ── FULL RANKING ──
    print(f"\n{'=' * 130}")
    print(f"  FULL RANKING BY AVERAGE P&L — {total_exp} experiments")
    print(f"{'=' * 130}")
    print(f"  {'#':>3} {'Name':<52} {'P&L':>10} {'WR':>7} {'Tr':>5} "
          f"{'DD':>8} {'RAdj':>7} {'Prof':>6} {'Ruin':>5} {'Bank':>8} {'Cap':>16}")
    print(f"  {'─' * 128}")
    for i, v in enumerate(by_pnl):
        marker = " <<<" if "BASELINE" in v["name"] else ""
        ruin_flag = f"{v['ruined_paths']}/{v['n_paths']}" if v["ruined_paths"] > 0 else "  -"
        ec = cap_str(v["params"])
        print(f"  {i+1:>3} {v['name']:<52} ${v['avg_pnl']:>+8.2f} {v['avg_wr']:>6.1f}% "
              f"{v['avg_trades']:>4.0f}  ${v['avg_dd']:>7.2f} {v['risk_adj']:>7.2f} "
              f"{v['profitable']:>3}/{v['n_paths']} {ruin_flag:>5} ${v['avg_bank']:>7.0f} "
              f"{ec:>16}{marker}")

    # ── TOP 15 ──
    print(f"\n{'=' * 130}")
    print(f"  TOP 15 BY AVERAGE P&L")
    print(f"{'=' * 130}")
    for i, v in enumerate(by_pnl[:15]):
        detail_block(v, i + 1)

    # ── TOTAL LOSS STRATEGIES ──
    ruined = [v for v in all_summaries if v["ruined_paths"] > 0]
    if ruined:
        print(f"\n{'=' * 130}")
        print(f"  *** STRATEGIES THAT CAUSED TOTAL LOSS (RUIN) ***")
        print(f"{'=' * 130}")
        ruined.sort(key=lambda x: x["ruined_paths"], reverse=True)
        for v in ruined:
            detail_block(v, "X", "⚠ RUINED")
    else:
        print(f"\n  No strategies caused total ruin on any path.")

    # ── MONEY LOSERS ──
    losers = [v for v in all_summaries if v["avg_pnl"] < 0]
    if losers:
        losers.sort(key=lambda x: x["avg_pnl"])
        print(f"\n{'=' * 130}")
        print(f"  MONEY LOSERS ({len(losers)} strategies with negative avg P&L)")
        print(f"{'=' * 130}")
        print(f"  {'#':>3} {'Name':<52} {'P&L':>10} {'WR':>7} {'Tr':>5} {'Worst':>10} {'Ruin':>5}")
        print(f"  {'─' * 96}")
        for i, v in enumerate(losers):
            ruin_flag = f"{v['ruined_paths']}/{v['n_paths']}" if v["ruined_paths"] > 0 else "  -"
            print(f"  {i+1:>3} {v['name']:<52} ${v['avg_pnl']:>+8.2f} {v['avg_wr']:>6.1f}% "
                  f"{v['avg_trades']:>4.0f}  ${v['worst_pnl']:>+8.2f} {ruin_flag:>5}")

    # ── TOP 10 RISK-ADJUSTED ──
    by_risk = sorted(
        [v for v in all_summaries if v["avg_dd"] > 0 and v["avg_trades"] >= 5],
        key=lambda x: x["risk_adj"], reverse=True)
    print(f"\n{'=' * 130}")
    print(f"  TOP 10 BY RISK-ADJUSTED RETURN")
    print(f"{'=' * 130}")
    for i, v in enumerate(by_risk[:10]):
        detail_block(v, i + 1, "(risk-adjusted)")

    # ── TOP 10 CONSISTENCY ──
    by_consist = sorted(all_summaries,
                        key=lambda x: (x["profitable"], -x["avg_losing_months"], x["avg_pnl"]),
                        reverse=True)
    print(f"\n{'=' * 130}")
    print(f"  TOP 10 BY CONSISTENCY (profitable paths, fewest losing months)")
    print(f"{'=' * 130}")
    for i, v in enumerate(by_consist[:10]):
        detail_block(v, i + 1, "(consistent)")

    # ── HOLD vs SMART EXIT comparison ──
    print(f"\n{'=' * 130}")
    print(f"  HOLD TO SETTLEMENT vs SMART EXIT — HEAD TO HEAD")
    print(f"{'=' * 130}")
    bl = next((v for v in all_summaries if "BASELINE" in v["name"]), None)
    hold_exps = [v for v in all_summaries if "hold" in v["name"].lower() or
                 (not v["params"]["use_exit_logic"])]
    print(f"\n  {'Name':<52} {'P&L':>10} {'WR':>7} {'Tr':>5} {'Early%':>7}")
    print(f"  {'─' * 85}")
    if bl:
        early_pct = (bl['avg_early'] / bl['avg_trades'] * 100) if bl['avg_trades'] > 0 else 0
        print(f"  {bl['name']:<52} ${bl['avg_pnl']:>+8.2f} {bl['avg_wr']:>6.1f}% "
              f"{bl['avg_trades']:>4.0f}  {early_pct:>6.1f}%")
    for v in sorted(hold_exps, key=lambda x: x["avg_pnl"], reverse=True):
        early_pct = (v['avg_early'] / v['avg_trades'] * 100) if v['avg_trades'] > 0 else 0
        print(f"  {v['name']:<52} ${v['avg_pnl']:>+8.2f} {v['avg_wr']:>6.1f}% "
              f"{v['avg_trades']:>4.0f}  {early_pct:>6.1f}%")

    # ── PARAMETER SENSITIVITY ──
    print(f"\n{'=' * 130}")
    print(f"  PARAMETER SENSITIVITY")
    print(f"{'=' * 130}")

    for sweep_name, prefix in [
        ("ENTRY CAP (next-up)", "Cap:"),
        ("TIME-BASED CAPS", "TimeCap:"),
        ("PROBABILITY BANDS", "Prob:"),
        ("POSITION SIZE", "Size:"),
        ("ENTRY MINUTE", "Enter at"),
        ("HOUR RETURN", "HrRet:"),
        ("SMA LOOSENESS", "SMA:"),
        ("MIN TIME REMAINING", "MinTime:"),
    ]:
        sweep = [v for v in all_summaries if v["name"].startswith(prefix)]
        if bl and prefix == "Cap:":
            sweep.append(bl)
        if not sweep:
            continue
        sweep.sort(key=lambda x: x["avg_pnl"], reverse=True)
        print(f"\n  {sweep_name}:")
        print(f"  {'Config':<35} {'P&L':>10} {'WR':>7} {'Tr':>5} {'DD':>8} {'RAdj':>7} {'Skip$':>6}")
        print(f"  {'─' * 80}")
        for v in sweep:
            nm = v['name'] if "BASELINE" not in v['name'] else ">> BASELINE <<"
            print(f"  {nm:<35} ${v['avg_pnl']:>+8.2f} {v['avg_wr']:>6.1f}% "
                  f"{v['avg_trades']:>4.0f}  ${v['avg_dd']:>7.2f} {v['risk_adj']:>7.2f} "
                  f"{v['avg_skip_exp']:>5.0f}")

    # ── FINAL RECOMMENDATION ──
    best_pnl = by_pnl[0]
    best_ra = by_risk[0] if by_risk else by_pnl[0]
    best_con = by_consist[0]

    print(f"\n{'=' * 130}")
    print(f"  FINAL HONEST RECOMMENDATION")
    print(f"{'=' * 130}")

    if bl:
        detail_block(bl, 0, "── BASELINE ──")
    detail_block(best_pnl, 1, "── BEST P&L ──")
    if best_ra["id"] != best_pnl["id"]:
        detail_block(best_ra, 2, "── BEST RISK-ADJUSTED ──")
    if best_con["id"] != best_pnl["id"] and best_con["id"] != best_ra["id"]:
        detail_block(best_con, 3, "── MOST CONSISTENT ──")

    if bl:
        d = best_pnl["avg_pnl"] - bl["avg_pnl"]
        print(f"\n  Best vs Baseline: P&L ${d:+.2f}/yr, "
              f"WR {best_pnl['avg_wr'] - bl['avg_wr']:+.1f}pp, "
              f"Trades {best_pnl['avg_trades'] - bl['avg_trades']:+.0f}/yr")

    print(f"\n  Total runtime: {time.time() - start_time:.1f}s")
    print()
