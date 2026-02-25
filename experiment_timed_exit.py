#!/usr/bin/env python3
"""
Timed Exit Experiment: Testing when to take profits and cut losses.

The aggressive OTM strategy buys cheap contracts on momentum signals, but the
current exit logic only compares earlyExitNet vs settlementEV. It has NO:
  - Time-based profit checkpoints (lock in gains at 15m/10m)
  - Momentum reversal detection (exit when momentum flips against you)
  - Buffer-based exit (exit if ITM but buffer is razor thin)

This experiment tests 8 exit strategies using minute-level price simulation
within each hour, checking exit conditions at every 5-minute mark.

Uses the same data generation and signal framework as experiment_otm_expanded.py.
"""

import random
import math
import time
from datetime import datetime, timezone


# ──── Data Generation (same as expanded experiment) ────

def generate_realistic_btc_data(days=365, seed=42):
    random.seed(seed)
    candles = []
    hours = days * 24
    price = 68000.0
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
    base_volume = 2500.0

    for h in range(hours):
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

        open_price = price
        close_price = open_price * (1 + ret)
        intra_vol = abs(ret) + hourly_vol * random.uniform(0.3, 1.5)
        if close_price >= open_price:
            high = max(open_price, close_price) * (1 + random.uniform(0, intra_vol * 0.5))
            low = min(open_price, close_price) * (1 - random.uniform(0, intra_vol * 0.3))
        else:
            high = max(open_price, close_price) * (1 + random.uniform(0, intra_vol * 0.3))
            low = min(open_price, close_price) * (1 - random.uniform(0, intra_vol * 0.5))
        high = max(high, open_price, close_price)
        low = min(low, open_price, close_price)

        vol_factor = 1.0
        if current_regime in ("strong_bull", "selloff", "recovery"):
            vol_factor = random.uniform(1.5, 3.0)
        elif abs(ret) > hourly_vol * 2:
            vol_factor = random.uniform(2.0, 4.0)
        volume = base_volume * vol_factor * random.uniform(0.5, 2.0)

        candles.append({
            "open": round(open_price, 2), "high": round(high, 2),
            "low": round(low, 2), "close": round(close_price, 2),
            "volume": round(volume, 2), "regime": current_regime,
        })
        price = close_price
        if price > 120000: price *= 0.9999
        elif price < 30000: price *= 1.0001

    return candles


# ──── Math helpers ────

def normal_cdf(x):
    a1, a2, a3, a4, a5 = 0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429
    p = 0.3275911
    sign = -1 if x < 0 else 1
    x = abs(x)
    t = 1.0 / (1.0 + p * x)
    y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * math.exp(-x * x / 2.0)
    return 0.5 * (1.0 + sign * y)

def estimate_fair_value(price, strike, vol, mins_remaining):
    if vol <= 0 or mins_remaining <= 0:
        return 1.0 if price > strike else 0.0
    time_hours = max(mins_remaining, 0.5) / 60
    expected_move = price * (vol / 100) * math.sqrt(time_hours)
    if expected_move <= 0:
        return 0.99 if price >= strike else 0.01
    z = (price - strike) / expected_move
    return max(0.01, min(0.99, normal_cdf(z)))

def calc_net_pnl(contracts, entry_price, exit_price, exit_type):
    TAKER_FEE_PCT = 1.5
    entry_cost = contracts * entry_price
    entry_fee = entry_cost * (TAKER_FEE_PCT / 100)
    total_entry = entry_cost + entry_fee
    revenue = contracts * exit_price
    if exit_type == "early":
        exit_fee = revenue * (TAKER_FEE_PCT / 100)
        return (revenue - exit_fee) - total_entry
    else:
        return revenue - total_entry

def apply_pinning_discount(fair_value, btc_price, strike, mins_remaining):
    distance = btc_price - strike
    strike_mod_1000 = strike % 1000
    strike_mod_500 = strike % 500
    if distance < 0:
        abs_dist_pct = abs(distance) / btc_price * 100
        if abs_dist_pct < 0.5: pin_discount = 0.20
        elif abs_dist_pct < 1.0: pin_discount = 0.12
        else: pin_discount = 0.05
    elif distance < 200: pin_discount = 0.15
    else: pin_discount = 0.03
    if strike_mod_1000 == 0: pin_discount += 0.05
    elif strike_mod_500 == 0: pin_discount += 0.03
    if mins_remaining < 15: pin_discount *= 1.5
    elif mins_remaining < 30: pin_discount *= 1.2
    return max(0.01, fair_value * (1 - pin_discount))


# ──── Indicators ────

STRIKE_INCREMENT = 250

def calc_sma(candles, period):
    if len(candles) < period: return 0
    return sum(c["close"] for c in candles[-period:]) / period

def calc_volatility_multi(candles):
    """Multi-candle volatility (average of last 6 completed candles' ranges).
    Matches the fix applied to indicators.ts — NOT single-candle."""
    if len(candles) < 2:
        c = candles[-1] if candles else None
        if not c or c["open"] == 0: return 0
        return ((c["high"] - c["low"]) / c["open"]) * 100
    completed = candles[:-1]  # skip current (incomplete)
    lookback = completed[-6:]
    total = 0
    count = 0
    for c in lookback:
        if c["open"] > 0 and c["high"] > c["low"]:
            total += ((c["high"] - c["low"]) / c["open"]) * 100
            count += 1
    if count == 0:
        c = candles[-1]
        if c["open"] == 0: return 0
        return ((c["high"] - c["low"]) / c["open"]) * 100
    return total / count

def calc_rolling_return(candles, lookback_hours):
    if len(candles) < lookback_hours + 1: return 0
    old = candles[-(lookback_hours + 1)]["close"]
    new = candles[-1]["close"]
    if old == 0: return 0
    return ((new - old) / old) * 100


# ──── Combined Signal Check (any of 7 bull signals) ────

def check_any_bull_signal(candles, current_price, entry_minute):
    """Matches the aggressive strategy's 7 bull signals as OR gates."""
    mins_remaining = 60 - entry_minute
    if mins_remaining <= 15 or len(candles) < 12:
        return None

    sma3 = calc_sma(candles, 3)
    sma6 = calc_sma(candles, 6)
    sma12 = calc_sma(candles, 12)
    if 0 in (sma3, sma6, sma12):
        return None

    vol = calc_volatility_multi(candles)
    SMA_LOOSE = 0.003
    short_up = sma3 > sma6 or (sma6 > 0 and (sma6 - sma3) / sma6 < SMA_LOOSE)
    med_up = sma6 > sma12 or (sma12 > 0 and (sma12 - sma6) / sma12 < SMA_LOOSE)

    ret_1h = calc_rolling_return(candles, 1)
    ret_2h = calc_rolling_return(candles, 2)

    # Volume ratio
    if len(candles) >= 8:
        avg_vol = sum(c["volume"] for c in candles[-8:-2]) / 6
        vr = candles[-2]["volume"] / avg_vol if avg_vol > 0 else 1.0
    else:
        vr = 1.0

    # Vol expansion
    if len(candles) >= 7:
        cvols = [((c["high"] - c["low"]) / c["open"] * 100) if c["open"] > 0 else 0
                 for c in candles[-7:-1]]
        avg_cv = sum(cvols) / len(cvols) if cvols else 1
        curr_cv = ((candles[-1]["high"] - candles[-1]["low"]) / candles[-1]["open"] * 100) \
                  if candles[-1]["open"] > 0 else 0
        vol_exp = curr_cv / avg_cv if avg_cv > 0 else 1
    else:
        vol_exp = 1.0

    # Dip recovery
    dip_pct = rec_pct = 0
    bouncing = False
    if len(candles) >= 3:
        pp = candles[-3]
        pr = candles[-2]
        if pp["close"] > 0 and pr["low"] > 0:
            dip_pct = ((pr["low"] - pp["close"]) / pp["close"]) * 100
            rec_pct = ((current_price - pr["low"]) / pr["low"]) * 100
            bouncing = dip_pct < -0.1 and rec_pct > 0.1

    # Psych level cross
    psych_crossed = False
    if len(candles) >= 2:
        prev_close = candles[-2]["close"]
        level = math.ceil(prev_close / 500) * 500
        psych_crossed = prev_close < level and current_price >= level

    # Selloff recovery
    selloff_sig = False
    if len(candles) >= 4:
        c3h = candles[-4]
        c1h = candles[-2]
        if c3h["close"] > 0:
            sell = ((c1h["close"] - c3h["close"]) / c3h["close"]) * 100
            bounce = ret_1h
            selloff_sig = sell < -0.50 and bounce > 0.20

    # 7 signals as OR gates
    fired = False
    entry_momentum = 0  # 1h return at time of entry
    if ret_1h > 0.20 and short_up and med_up:
        fired = True  # rolling momentum
    elif dip_pct < -0.30 and rec_pct > 0.20 and bouncing:
        fired = True  # dip recovery
    elif ret_1h > 0.10 and ret_2h > 0.20 and short_up:
        fired = True  # multi-hour
    elif vr >= 1.50 and ret_1h > 0.20 and short_up:
        fired = True  # volume momentum
    elif psych_crossed and short_up:
        fired = True  # psych level
    elif selloff_sig:
        fired = True  # selloff recovery
    elif vol_exp >= 1.80 and ret_1h > 0.10 and short_up:
        fired = True  # vol expansion

    if not fired:
        return None

    entry_momentum = ret_1h

    # Strike: next-up (floor + 250)
    floor_strike = math.floor(current_price / STRIKE_INCREMENT) * STRIKE_INCREMENT
    strike = floor_strike + STRIKE_INCREMENT

    fv = estimate_fair_value(current_price, strike, vol, mins_remaining)
    if fv < 0.05 or fv > 0.45:
        return None

    entry_price = min(0.25, math.floor(fv * 100) / 100)
    if entry_price <= 0.01:
        return None

    contracts = math.floor(20 / entry_price)
    if contracts <= 0:
        return None

    return {
        "strike": strike, "entry_price": entry_price,
        "contracts": contracts, "fair_value": fv,
        "volatility": vol, "entry_momentum": entry_momentum,
    }


# ──── Minute-Level Price Path Simulation ────

def simulate_minute_path(btc_open, hourly_vol, rng, minutes=60):
    """Generate minute-level BTC prices within an hour using GBM random walk."""
    prices = [btc_open]
    minute_vol = (hourly_vol / 100) / math.sqrt(60)  # per-minute volatility
    p = btc_open
    for _ in range(minutes):
        ret = rng.gauss(0, minute_vol)
        p = p * (1 + ret)
        prices.append(p)
    return prices  # prices[0] = open, prices[60] = close


# ──── Exit Strategy Variants ────

def should_exit(variant, minute, btc_price, strike, entry_price, contracts,
                vol, entry_momentum, rng):
    """
    Evaluate whether to exit at this minute given the exit strategy variant.

    Returns (should_exit: bool, reason: str) or (False, "").
    """
    mins_remaining = 60 - minute
    if mins_remaining <= 0:
        return False, ""  # settlement handles this

    # Current fair value and P&L
    fv = estimate_fair_value(btc_price, strike, vol, mins_remaining)
    early_pnl = calc_net_pnl(contracts, entry_price, fv, "early")

    # Settlement EV
    adj_prob = apply_pinning_discount(
        estimate_fair_value(btc_price, strike, vol, mins_remaining),
        btc_price, strike, mins_remaining
    )
    win_pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
    lose_pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
    settle_ev = adj_prob * win_pnl + (1 - adj_prob) * lose_pnl

    # Current momentum (how much has price moved since entry)
    # entry_momentum is the 1h return at entry time
    # We check if it reversed by looking at distance from entry strike area
    distance = btc_price - strike
    price_gain_pct = ((fv - entry_price) / entry_price * 100) if entry_price > 0 else 0

    # ── VARIANT: BASELINE ──
    # Current behavior: pure EV comparison + 5m loss cut
    if variant == "baseline":
        if early_pnl > settle_ev and early_pnl > 0:
            return True, "EV exit"
        if mins_remaining <= 5 and early_pnl > lose_pnl:
            return True, "5m loss cut"
        return False, ""

    # ── VARIANT: 15m-profit ──
    # Lock in any profit at ≤15m remaining
    elif variant == "15m_profit":
        if early_pnl > settle_ev and early_pnl > 0:
            return True, "EV exit"
        if mins_remaining <= 15 and early_pnl > 0:
            return True, "15m profit lock"
        if mins_remaining <= 5 and early_pnl > lose_pnl:
            return True, "5m loss cut"
        return False, ""

    # ── VARIANT: 10m-profit ──
    # Lock in any profit at ≤10m remaining
    elif variant == "10m_profit":
        if early_pnl > settle_ev and early_pnl > 0:
            return True, "EV exit"
        if mins_remaining <= 10 and early_pnl > 0:
            return True, "10m profit lock"
        if mins_remaining <= 5 and early_pnl > lose_pnl:
            return True, "5m loss cut"
        return False, ""

    # ── VARIANT: 15m-momentum ──
    # At ≤15m, exit if momentum has reversed (price moving wrong way)
    elif variant == "15m_momentum":
        if early_pnl > settle_ev and early_pnl > 0:
            return True, "EV exit"
        if mins_remaining <= 15:
            # Momentum reversal: we entered bullish but price is now below strike
            # or moving away from strike
            if distance < 0 and early_pnl > lose_pnl:
                return True, "15m momentum reversed"
            if early_pnl > 0 and price_gain_pct < 10:
                return True, "15m weak momentum"
        if mins_remaining <= 5 and early_pnl > lose_pnl:
            return True, "5m loss cut"
        return False, ""

    # ── VARIANT: 10m-momentum ──
    elif variant == "10m_momentum":
        if early_pnl > settle_ev and early_pnl > 0:
            return True, "EV exit"
        if mins_remaining <= 10:
            if distance < 0 and early_pnl > lose_pnl:
                return True, "10m momentum reversed"
            if early_pnl > 0 and price_gain_pct < 10:
                return True, "10m weak momentum"
        if mins_remaining <= 5 and early_pnl > lose_pnl:
            return True, "5m loss cut"
        return False, ""

    # ── VARIANT: 15m-buffer ──
    # At ≤15m, exit if price is above strike but buffer < $100
    elif variant == "15m_buffer":
        if early_pnl > settle_ev and early_pnl > 0:
            return True, "EV exit"
        if mins_remaining <= 15:
            if 0 < distance < 100 and early_pnl > 0:
                return True, "15m thin buffer"
            if distance < 0 and early_pnl > lose_pnl:
                return True, "15m below strike"
        if mins_remaining <= 5 and early_pnl > lose_pnl:
            return True, "5m loss cut"
        return False, ""

    # ── VARIANT: combined ──
    # Best of all: EV exit + 15m momentum check + 10m loss cut + 20m profit lock
    elif variant == "combined":
        if early_pnl > settle_ev and early_pnl > 0:
            return True, "EV exit"
        # 20m: lock in big gains (contract up 30%+ from entry)
        if mins_remaining <= 20 and early_pnl > 0 and price_gain_pct >= 30:
            return True, "20m big profit lock"
        # 15m: exit if momentum reversed or thin buffer
        if mins_remaining <= 15:
            if distance < 0 and early_pnl > lose_pnl:
                return True, "15m below strike cut"
            if 0 < distance < 100 and early_pnl > 0:
                return True, "15m thin buffer lock"
        # 10m: aggressive loss cut
        if mins_remaining <= 10 and early_pnl > lose_pnl and distance < 50:
            return True, "10m loss cut"
        if mins_remaining <= 5 and early_pnl > lose_pnl:
            return True, "5m loss cut"
        return False, ""

    # ── VARIANT: aggressive_combined ──
    # Even more aggressive: take any profit at 20m, cut any loss at 15m
    elif variant == "aggressive_combined":
        if early_pnl > settle_ev and early_pnl > 0:
            return True, "EV exit"
        if mins_remaining <= 20 and early_pnl > 0:
            return True, "20m any profit lock"
        if mins_remaining <= 15 and early_pnl > lose_pnl:
            return True, "15m loss cut"
        return False, ""

    return False, ""


# ──── Trade Simulation with Minute-Level Exit Checking ────

def simulate_trade_with_exits(entry_price, strike, contracts, vol, entry_momentum,
                               variant, rng, entry_minute=30):
    """
    Simulate a trade using minute-level price paths.
    Check exit conditions every minute from entry to settlement.
    """
    btc_entry = strike - 50  # Start slightly below strike (OTM entry)
    # Adjust entry price based on a realistic distance
    # Use fair value to estimate where BTC actually is
    # If fair value is 25%, BTC is moderately below strike
    # Invert: P(above) = fv => z = invCDF(fv)
    # distance = z * expectedMove
    # We'll use a simpler approach: sample realistic entry distance
    expected_move = btc_entry * (vol / 100) * math.sqrt((60 - entry_minute) / 60)
    if expected_move > 0:
        # Place BTC at a position consistent with the fair value
        z_entry = -0.5 + rng.gauss(0, 0.3)  # typically slightly below strike
        btc_entry = strike + z_entry * expected_move
    else:
        btc_entry = strike - 100

    # Generate minute-level prices from entry to hour end
    remaining_minutes = 60 - entry_minute
    prices = simulate_minute_path(btc_entry, vol, rng, remaining_minutes)

    # Check exit at each minute
    for m in range(1, remaining_minutes):
        minute = entry_minute + m
        btc_now = prices[m]
        should, reason = should_exit(
            variant, minute, btc_now, strike, entry_price, contracts,
            vol, entry_momentum, rng
        )
        if should:
            fv = estimate_fair_value(btc_now, strike, vol, 60 - minute)
            pnl = calc_net_pnl(contracts, entry_price, fv, "early")
            return {"outcome": "early_exit", "pnl": pnl, "reason": reason,
                    "exit_minute": minute}

    # Settlement
    settle_price = prices[-1]
    adj_prob = apply_pinning_discount(
        estimate_fair_value(settle_price, strike, vol, 1),
        settle_price, strike, 1
    )
    won = rng.random() < adj_prob
    if won:
        pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
        return {"outcome": "win", "pnl": pnl, "reason": "settlement win",
                "exit_minute": 60}
    else:
        pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
        return {"outcome": "loss", "pnl": pnl, "reason": "settlement loss",
                "exit_minute": 60}


# ──── Backtest Runner ────

def run_backtest(candles, variant, path_seed=0):
    rng = random.Random(hash((path_seed, variant)) & 0xFFFFFFFF)
    bankroll = 100.0
    trades = 0
    wins = 0
    early_exits = 0
    total_pnl = 0.0
    peak_bank = 100.0
    min_bank = 100.0
    max_dd = 0.0
    peak_pnl = 0.0
    daily_returns = []
    day_pnl = 0.0
    last_day = -1
    last_trade_hour = -999
    exit_reasons = {}

    for i in range(13, len(candles)):
        # Track daily returns
        day = i // 24
        if day != last_day and last_day >= 0:
            daily_returns.append(day_pnl)
            day_pnl = 0.0
        last_day = day

        if i - last_trade_hour < 1:
            continue

        current_price = candles[i]["open"]
        history = candles[max(0, i - 13):i]

        entry_minute = 30
        sig = check_any_bull_signal(history, current_price, entry_minute)

        if sig and bankroll >= 10:
            result = simulate_trade_with_exits(
                sig["entry_price"], sig["strike"], sig["contracts"],
                sig["volatility"], sig["entry_momentum"],
                variant, rng, entry_minute
            )

            trades += 1
            pnl = result["pnl"]
            total_pnl += pnl
            bankroll += pnl
            day_pnl += pnl
            last_trade_hour = i

            reason = result.get("reason", "unknown")
            exit_reasons[reason] = exit_reasons.get(reason, 0) + 1

            if "early_exit" in result["outcome"]:
                early_exits += 1
            if pnl >= 0:
                wins += 1

            if bankroll > peak_bank:
                peak_bank = bankroll
            if bankroll < min_bank:
                min_bank = bankroll
            if total_pnl > peak_pnl:
                peak_pnl = total_pnl
            dd = peak_pnl - total_pnl
            if dd > max_dd:
                max_dd = dd

    # Final day
    if day_pnl != 0:
        daily_returns.append(day_pnl)

    # Sharpe ratio
    if len(daily_returns) > 1:
        mean_dr = sum(daily_returns) / len(daily_returns)
        var_dr = sum((d - mean_dr) ** 2 for d in daily_returns) / (len(daily_returns) - 1)
        std_dr = math.sqrt(var_dr) if var_dr > 0 else 0.001
        sharpe = (mean_dr / std_dr) * math.sqrt(365)  # annualized
    else:
        sharpe = 0.0

    wr = (wins / trades * 100) if trades > 0 else 0
    ruin = bankroll < 1.0

    return {
        "trades": trades, "wins": wins, "win_rate": wr,
        "total_pnl": total_pnl, "final_bank": bankroll,
        "max_dd": max_dd, "min_bank": min_bank,
        "early_exits": early_exits, "ruin": ruin,
        "sharpe": sharpe, "exit_reasons": exit_reasons,
        "trades_per_week": trades / 52 if trades > 0 else 0,
    }


# ──── Main ────

if __name__ == "__main__":
    NUM_PATHS = 10
    VARIANTS = [
        "baseline",
        "15m_profit",
        "10m_profit",
        "15m_momentum",
        "10m_momentum",
        "15m_buffer",
        "combined",
        "aggressive_combined",
    ]

    start_time = time.time()

    print("=" * 120)
    print("  TIMED EXIT EXPERIMENT")
    print(f"  {len(VARIANTS)} exit strategies × {NUM_PATHS} Monte Carlo paths × 365 days")
    print("  Using multi-candle volatility (matches new indicators.ts fix)")
    print("  Minute-level price paths within each hour")
    print("=" * 120)

    # Generate paths
    print("\n  Generating price paths...")
    all_paths = []
    for seed_idx in range(NUM_PATHS):
        candles = generate_realistic_btc_data(days=365, seed=seed_idx * 17 + 42)
        final = candles[-1]["close"]
        print(f"    Path {seed_idx+1}: ${candles[0]['open']:,.0f} -> ${final:,.0f}")
        all_paths.append(candles)

    print(f"\n  Running {len(VARIANTS)} variants × {NUM_PATHS} paths = "
          f"{len(VARIANTS) * NUM_PATHS} backtests...\n")

    all_results = {}
    for variant in VARIANTS:
        path_results = []
        for path_idx, candles in enumerate(all_paths):
            r = run_backtest(candles, variant, path_seed=path_idx)
            path_results.append(r)
        all_results[variant] = path_results

    elapsed = time.time() - start_time
    print(f"  Complete in {elapsed:.1f}s\n")

    # ──── Results Table ────
    print(f"{'=' * 120}")
    print(f"  {'Variant':<25} {'Avg P&L':>10} {'Med Bank':>10} {'WR':>6} "
          f"{'T/wk':>6} {'Sharpe':>7} {'MaxDD':>8} {'MinBank':>9} "
          f"{'Ruin':>5} {'Early%':>7}")
    print(f"  {'-' * 115}")

    variant_summaries = []
    for variant in VARIANTS:
        results = all_results[variant]
        n = len(results)
        avg_pnl = sum(r["total_pnl"] for r in results) / n
        banks = sorted(r["final_bank"] for r in results)
        med_bank = banks[n // 2]
        avg_wr = sum(r["win_rate"] for r in results) / n
        avg_tpw = sum(r["trades_per_week"] for r in results) / n
        avg_sharpe = sum(r["sharpe"] for r in results) / n
        avg_dd = sum(r["max_dd"] for r in results) / n
        min_bank = min(r["min_bank"] for r in results)
        ruin_ct = sum(1 for r in results if r["ruin"])
        total_trades = sum(r["trades"] for r in results)
        total_early = sum(r["early_exits"] for r in results)
        early_pct = (total_early / total_trades * 100) if total_trades > 0 else 0

        variant_summaries.append({
            "variant": variant, "avg_pnl": avg_pnl, "med_bank": med_bank,
            "avg_wr": avg_wr, "avg_tpw": avg_tpw, "avg_sharpe": avg_sharpe,
            "avg_dd": avg_dd, "min_bank": min_bank, "ruin_ct": ruin_ct,
            "early_pct": early_pct,
        })

        ruin_str = f"{ruin_ct}/{n}"
        print(f"  {variant:<25} ${avg_pnl:>+9.2f} ${med_bank:>9.2f} "
              f"{avg_wr:>5.1f}% {avg_tpw:>5.1f} {avg_sharpe:>+6.2f} "
              f"${avg_dd:>7.2f} ${min_bank:>8.2f} {ruin_str:>5} {early_pct:>6.1f}%")

    # ──── Exit Reason Breakdown ────
    print(f"\n{'=' * 120}")
    print(f"  EXIT REASON BREAKDOWN (aggregated across all paths)")
    print(f"{'=' * 120}")

    for variant in VARIANTS:
        results = all_results[variant]
        combined_reasons = {}
        for r in results:
            for reason, count in r["exit_reasons"].items():
                combined_reasons[reason] = combined_reasons.get(reason, 0) + count
        total = sum(combined_reasons.values())
        print(f"\n  {variant}:")
        for reason, count in sorted(combined_reasons.items(), key=lambda x: -x[1]):
            pct = count / total * 100 if total > 0 else 0
            print(f"    {reason:<35} {count:>5} ({pct:>5.1f}%)")

    # ──── Individual Path Results for Best Variant ────
    best = max(variant_summaries, key=lambda x: x["avg_pnl"])
    print(f"\n{'=' * 120}")
    print(f"  BEST VARIANT: {best['variant']}")
    print(f"  Avg P&L: ${best['avg_pnl']:+.2f}  Med Bank: ${best['med_bank']:.2f}  "
          f"Sharpe: {best['avg_sharpe']:+.2f}  Ruin: {best['ruin_ct']}/{NUM_PATHS}")
    print(f"{'=' * 120}")

    results = all_results[best["variant"]]
    print(f"\n  {'Path':>6} {'Trades':>7} {'Wins':>5} {'WR':>6} {'P&L':>10} "
          f"{'Bank':>10} {'MaxDD':>8} {'MinBank':>9} {'Sharpe':>7} {'Early':>6}")
    for i, r in enumerate(results):
        print(f"  {i+1:>6} {r['trades']:>7} {r['wins']:>5} {r['win_rate']:>5.1f}% "
              f"${r['total_pnl']:>+9.2f} ${r['final_bank']:>9.2f} "
              f"${r['max_dd']:>7.2f} ${r['min_bank']:>8.2f} "
              f"{r['sharpe']:>+6.2f} {r['early_exits']:>6}")

    # ──── Comparison: Best vs Baseline ────
    baseline = next(v for v in variant_summaries if v["variant"] == "baseline")
    print(f"\n{'=' * 120}")
    print(f"  COMPARISON: {best['variant']} vs baseline")
    print(f"{'=' * 120}")
    print(f"  {'Metric':<20} {'Baseline':>12} {best['variant']:>20} {'Delta':>12}")
    print(f"  {'-' * 70}")
    metrics = [
        ("Avg P&L", baseline["avg_pnl"], best["avg_pnl"]),
        ("Med Bankroll", baseline["med_bank"], best["med_bank"]),
        ("Win Rate", baseline["avg_wr"], best["avg_wr"]),
        ("Sharpe", baseline["avg_sharpe"], best["avg_sharpe"]),
        ("Max Drawdown", baseline["avg_dd"], best["avg_dd"]),
        ("Min Bankroll", baseline["min_bank"], best["min_bank"]),
        ("Ruin Count", baseline["ruin_ct"], best["ruin_ct"]),
        ("Early Exit %", baseline["early_pct"], best["early_pct"]),
    ]
    for name, base_val, best_val in metrics:
        delta = best_val - base_val
        if name in ("Max Drawdown", "Ruin Count"):
            # Lower is better
            better = "better" if delta < 0 else ("worse" if delta > 0 else "same")
        else:
            better = "better" if delta > 0 else ("worse" if delta < 0 else "same")
        if isinstance(base_val, float):
            print(f"  {name:<20} {base_val:>12.2f} {best_val:>20.2f} "
                  f"{delta:>+11.2f} ({better})")
        else:
            print(f"  {name:<20} {base_val:>12} {best_val:>20} "
                  f"{delta:>+11} ({better})")

    # ──── RECOMMENDATION ────
    print(f"\n{'=' * 120}")
    print(f"  RECOMMENDATION")
    print(f"{'=' * 120}")

    ranked = sorted(variant_summaries,
                    key=lambda x: (x["ruin_ct"], -x["avg_pnl"]))
    rec = ranked[0]
    print(f"\n  Winner: {rec['variant']}")
    print(f"  Avg P&L: ${rec['avg_pnl']:+.2f}")
    print(f"  Med Bankroll: ${rec['med_bank']:.2f}")
    print(f"  Win Rate: {rec['avg_wr']:.1f}%")
    print(f"  Sharpe: {rec['avg_sharpe']:+.2f}")
    print(f"  Ruin: {rec['ruin_ct']}/{NUM_PATHS}")
    print(f"  Early Exit %: {rec['early_pct']:.1f}%")

    if rec["variant"] != "baseline":
        print(f"\n  vs Baseline improvement:")
        print(f"    P&L: ${rec['avg_pnl'] - baseline['avg_pnl']:+.2f}")
        print(f"    Sharpe: {rec['avg_sharpe'] - baseline['avg_sharpe']:+.2f}")
        print(f"    Ruin: {rec['ruin_ct'] - baseline['ruin_ct']:+d}")
    else:
        print(f"\n  Baseline is already the best strategy. The current exit logic")
        print(f"  (pure EV comparison + 5m loss cut) outperforms timed exits.")

    print(f"\n  Total runtime: {time.time() - start_time:.1f}s")
    print()
