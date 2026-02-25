#!/usr/bin/env python3
"""
Expanded OTM experiment: finding viable cheap-contract conditions.

Key improvements over prior experiment:
  1. ROLLING momentum (60m, 120m) — not clock-hour-boundary momentum
  2. Dip-recovery signals — buy the bounce after hard drops
  3. Volume spike filtering — confirms conviction behind moves
  4. Psychological level awareness — round numbers as support/magnets
  5. Early-hour momentum — catch the move before it's exhausted
  6. Targets 1-2+ trades/week frequency (50-150/year)

Tests 100+ parameter combos × 10 Monte Carlo paths × 365 days each.
"""

import random
import math
import time
from datetime import datetime, timezone


# ──── Data Generation (hourly candles with volume) ────

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
    start_ts = int(datetime(2025, 2, 11, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)

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

        # Volume correlates with volatility and regime — big moves = big volume
        vol_factor = 1.0
        if current_regime in ("strong_bull", "selloff", "recovery"):
            vol_factor = random.uniform(1.5, 3.0)
        elif abs(ret) > hourly_vol * 2:
            vol_factor = random.uniform(2.0, 4.0)  # spike candles get volume
        volume = base_volume * vol_factor * random.uniform(0.5, 2.0)

        ts = start_ts + (h * 3600 * 1000)
        candles.append({
            "open_time": ts, "open": round(open_price, 2),
            "high": round(high, 2), "low": round(low, 2),
            "close": round(close_price, 2),
            "volume": round(volume, 2),
            "close_time": ts + 3599999,
            "regime": current_regime,
        })
        price = close_price
        if price > 120000: price *= 0.9999
        elif price < 30000: price *= 1.0001

    return candles


# ──── Indicators ────

def calc_sma(candles, period):
    if len(candles) < period: return 0
    return sum(c["close"] for c in candles[-period:]) / period

def calc_volatility(candle):
    if candle["open"] == 0: return 0
    return ((candle["high"] - candle["low"]) / candle["open"]) * 100

def calc_price_position(candle):
    rng = candle["high"] - candle["low"]
    if rng == 0: return 50
    return ((candle["close"] - candle["low"]) / rng) * 100

def calc_rolling_return(candles, lookback_hours):
    """Rolling return over last N hours (close-to-close, NOT clock-hour-boundary)."""
    if len(candles) < lookback_hours + 1:
        return 0
    old_price = candles[-(lookback_hours + 1)]["close"]
    new_price = candles[-1]["close"]
    if old_price == 0: return 0
    return ((new_price - old_price) / old_price) * 100

def calc_volume_ratio(candles, lookback=6):
    """Current candle volume vs average of last N candles."""
    if len(candles) < lookback + 1: return 1.0
    avg_vol = sum(c["volume"] for c in candles[-(lookback+1):-1]) / lookback
    if avg_vol == 0: return 1.0
    return candles[-1]["volume"] / avg_vol

def calc_dip_recovery(candles):
    """
    Measure dip-recovery: how much did the prior candle(s) drop, and how much
    has the current candle recovered from that low?
    Returns (dip_pct, recovery_pct, is_bouncing).
    """
    if len(candles) < 3:
        return (0, 0, False)
    prev = candles[-2]
    curr = candles[-1]
    prev_prev = candles[-3]

    # Dip = drop from 2-candles-ago close to prior candle low
    if prev_prev["close"] == 0: return (0, 0, False)
    dip_pct = ((prev["low"] - prev_prev["close"]) / prev_prev["close"]) * 100

    # Recovery = how far current price has bounced from the prior low
    if prev["low"] == 0: return (dip_pct, 0, False)
    recovery_pct = ((curr["close"] - prev["low"]) / prev["low"]) * 100

    is_bouncing = dip_pct < -0.1 and recovery_pct > 0.1
    return (dip_pct, recovery_pct, is_bouncing)

def nearest_psych_level(price, increment=1000):
    """Distance to nearest round number. Positive = above, negative = below."""
    level_below = math.floor(price / increment) * increment
    level_above = level_below + increment
    dist_below = price - level_below
    dist_above = level_above - price
    if dist_below <= dist_above:
        return dist_below, level_below, "above"
    else:
        return -dist_above, level_above, "below"

def just_crossed_above_level(candles, increment=1000):
    """Did price just cross above a round number in the last 1-2 candles?"""
    if len(candles) < 2: return False, 0
    prev_close = candles[-2]["close"]
    curr_close = candles[-1]["close"]
    level = math.ceil(prev_close / increment) * increment
    if prev_close < level <= curr_close:
        return True, level
    return False, 0


# ──── Strike & PnL ────

STRIKE_INCREMENT = 250
TAKER_FEE_PCT = 1.5

def calc_strike(btc_price, strike_type):
    if strike_type == "ATM":
        return round(btc_price / STRIKE_INCREMENT) * STRIKE_INCREMENT
    else:
        return math.floor(btc_price / STRIKE_INCREMENT) * STRIKE_INCREMENT

def calc_net_pnl(contracts, entry_price, exit_price, exit_type):
    entry_cost = contracts * entry_price
    entry_fee = entry_cost * (TAKER_FEE_PCT / 100)
    total_entry_cost = entry_cost + entry_fee
    exit_revenue = contracts * exit_price
    if exit_type == "early":
        exit_fee = exit_revenue * (TAKER_FEE_PCT / 100)
        return (exit_revenue - exit_fee) - total_entry_cost
    else:
        return exit_revenue - total_entry_cost

def normal_cdf(x):
    """Standard normal CDF (Abramowitz & Stegun)."""
    a1, a2, a3, a4, a5 = 0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429
    p = 0.3275911
    sign = -1 if x < 0 else 1
    x = abs(x)
    t = 1.0 / (1.0 + p * x)
    y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * math.exp(-x * x / 2.0)
    return 0.5 * (1.0 + sign * y)

def estimate_fair_value(price, strike, vol, mins_remaining):
    """P(BTC >= strike at settlement) using GBM model."""
    if vol <= 0 or mins_remaining <= 0:
        return 1.0 if price > strike else 0.0
    time_hours = max(mins_remaining, 0.5) / 60
    expected_move = price * (vol / 100) * math.sqrt(time_hours)
    if expected_move <= 0:
        return 0.99 if price >= strike else 0.01
    z = (price - strike) / expected_move
    prob = normal_cdf(z)
    return max(0.01, min(0.99, prob))

def estimate_contract_price(distance_from_strike, minutes_remaining):
    if distance_from_strike <= 0: return 0.30
    base = min(0.95, 0.5 + distance_from_strike / 1000)
    time_mult = 1 + (60 - minutes_remaining) / 120
    return min(0.99, base * time_mult)

def calc_risk_of_ruin(current_price, strike, volatility, minutes_remaining):
    distance = current_price - strike
    time_hours = minutes_remaining / 60
    expected_move = current_price * (volatility / 100) * math.sqrt(max(time_hours, 0.01))
    if expected_move <= 0: return 0.5
    z = distance / expected_move
    return 1.0 - normal_cdf(z)


# ──── Parameterized OTM Signal Check ────

def check_otm_signal(candles, current_price, minute, params):
    """
    Expanded OTM signal check with rolling momentum, dip recovery,
    volume filtering, and psychological level awareness.
    """
    mins_remaining = 60 - minute
    if mins_remaining <= params["min_time_remaining"]:
        return {"signal": False}

    if len(candles) < 12:
        return {"signal": False}

    sma3 = calc_sma(candles, 3)
    sma6 = calc_sma(candles, 6)
    sma12 = calc_sma(candles, 12)
    if 0 in (sma3, sma6, sma12):
        return {"signal": False}

    vol = calc_volatility(candles[-1])

    # ── SMA trend check ──
    sma_loose = params.get("sma_looseness", 0.003)
    if sma_loose is None:
        short_trend = True
        medium_trend = True
    elif sma_loose == 0:
        short_trend = sma3 > sma6
        medium_trend = sma6 > sma12
    else:
        short_trend = sma3 > sma6 or (sma6 > 0 and (sma6 - sma3) / sma6 < sma_loose)
        medium_trend = sma6 > sma12 or (sma12 > 0 and (sma12 - sma6) / sma12 < sma_loose)

    # ── Signal type routing ──
    signal_type = params["signal_type"]

    # ── ROLLING MOMENTUM (replaces clock-hour-boundary momentum) ──
    if signal_type == "rolling_momentum":
        lookback = params.get("momentum_lookback_hours", 1)
        rolling_ret = calc_rolling_return(candles, lookback)
        min_ret = params.get("min_rolling_return", 0.3)

        if rolling_ret <= min_ret:
            return {"signal": False}
        if not short_trend or not medium_trend:
            return {"signal": False}

    # ── DIP RECOVERY — buy the bounce ──
    elif signal_type == "dip_recovery":
        dip_pct, recovery_pct, is_bouncing = calc_dip_recovery(candles)
        min_dip = params.get("min_dip_pct", -0.3)       # how deep the dip was (negative)
        min_recovery = params.get("min_recovery_pct", 0.2)  # how strong the bounce

        if dip_pct > min_dip:     # dip not deep enough (min_dip is negative)
            return {"signal": False}
        if recovery_pct < min_recovery:
            return {"signal": False}
        if not is_bouncing:
            return {"signal": False}

        # For dip recovery, we DON'T require uptrend — we're buying the reversal
        # But we can optionally require short trend is turning
        if params.get("require_trend_turn", False):
            if not short_trend:
                return {"signal": False}

    # ── VOLUME SPIKE + TREND ──
    elif signal_type == "volume_momentum":
        lookback = params.get("momentum_lookback_hours", 1)
        rolling_ret = calc_rolling_return(candles, lookback)
        min_ret = params.get("min_rolling_return", 0.2)
        vol_ratio = calc_volume_ratio(candles, params.get("vol_lookback", 6))
        min_vol_ratio = params.get("min_vol_ratio", 1.5)

        if rolling_ret <= min_ret:
            return {"signal": False}
        if vol_ratio < min_vol_ratio:
            return {"signal": False}
        if not short_trend:
            return {"signal": False}

    # ── PSYCHOLOGICAL LEVEL BOUNCE ──
    elif signal_type == "psych_level":
        crossed, level = just_crossed_above_level(candles, params.get("psych_increment", 1000))
        if not crossed:
            return {"signal": False}
        # Price just broke above a round number — momentum could carry
        if not short_trend:
            return {"signal": False}

    # ── DIP + VOLUME COMBO (dip on high volume, then recovery) ──
    elif signal_type == "dip_volume_combo":
        dip_pct, recovery_pct, is_bouncing = calc_dip_recovery(candles)
        vol_ratio = calc_volume_ratio(candles, params.get("vol_lookback", 6))
        min_dip = params.get("min_dip_pct", -0.3)
        min_recovery = params.get("min_recovery_pct", 0.2)
        min_vol_ratio = params.get("min_vol_ratio", 1.5)

        if dip_pct > min_dip:
            return {"signal": False}
        if recovery_pct < min_recovery:
            return {"signal": False}
        if vol_ratio < min_vol_ratio:
            return {"signal": False}
        if not is_bouncing:
            return {"signal": False}

    # ── MULTI-HOUR MOMENTUM (catch sustained moves) ──
    elif signal_type == "multi_hour_momentum":
        ret_1h = calc_rolling_return(candles, 1)
        ret_2h = calc_rolling_return(candles, 2)
        min_1h = params.get("min_1h_return", 0.2)
        min_2h = params.get("min_2h_return", 0.3)

        if ret_1h <= min_1h:
            return {"signal": False}
        if ret_2h <= min_2h:
            return {"signal": False}
        if not short_trend:
            return {"signal": False}

    # ── RECOVERY AFTER SELLOFF (2-3 hour pattern) ──
    elif signal_type == "selloff_recovery":
        if len(candles) < 4:
            return {"signal": False}
        # Look for: 2-3 hours ago was a selloff, now recovering
        ret_3h = calc_rolling_return(candles[:-1], 2)  # return 3h ago to 1h ago
        ret_1h = calc_rolling_return(candles, 1)        # return last hour
        min_selloff = params.get("min_selloff_pct", -0.5)  # negative
        min_bounce = params.get("min_bounce_pct", 0.2)

        if ret_3h > min_selloff:   # selloff wasn't deep enough
            return {"signal": False}
        if ret_1h < min_bounce:    # bounce isn't strong enough
            return {"signal": False}

    # ── VOLATILITY EXPANSION (vol spike = big moves coming) ──
    elif signal_type == "vol_expansion":
        if len(candles) < 7:
            return {"signal": False}
        recent_vols = [calc_volatility(c) for c in candles[-7:-1]]
        avg_vol = sum(recent_vols) / len(recent_vols) if recent_vols else 1
        curr_vol = vol
        vol_expansion = curr_vol / avg_vol if avg_vol > 0 else 1
        min_expansion = params.get("min_vol_expansion", 1.8)

        if vol_expansion < min_expansion:
            return {"signal": False}
        # Also need positive direction
        ret_1h = calc_rolling_return(candles, 1)
        if ret_1h <= params.get("min_rolling_return", 0.1):
            return {"signal": False}
        if not short_trend:
            return {"signal": False}

    else:
        return {"signal": False}

    # ── Strike selection ──
    floor_strike = calc_strike(current_price, "OTM")
    strike_offset = params.get("strike_offset", 1)  # 1=next-up, 2=two-up
    strike = floor_strike + strike_offset * STRIKE_INCREMENT

    fv = estimate_fair_value(current_price, strike, vol, mins_remaining)

    min_prob = params.get("min_probability", 0.05)
    max_prob = params.get("max_probability", 0.40)
    if fv < min_prob or fv > max_prob:
        return {"signal": False}

    max_entry = params.get("max_entry_price", 0.25)
    entry_price = min(max_entry, math.floor(fv * 100) / 100)
    if entry_price <= 0.01:
        return {"signal": False}

    position_size = params.get("position_size", 20)
    contracts = math.floor(position_size / entry_price)
    if contracts <= 0:
        return {"signal": False}

    return {
        "signal": True,
        "strike": strike,
        "entry_price": entry_price,
        "contracts": contracts,
        "fair_value": fv,
        "volatility": vol,
    }


# ──── Settlement Pinning + Probability-Based Outcome ────
#
# KEY INSIGHT from real order book data (user observation):
# Near hourly settlement, sell/buy walls stack at $250-increment strikes.
# Market makers pin price below OTM strikes to keep contracts worthless.
#
# This means: the TRUE win probability for OTM contracts is LOWER than
# the GBM model predicts. We apply a pinning discount based on:
#   - Distance to strike (closer = more pinning)
#   - Time remaining (less time = more pinning power)
#   - Strike "roundness" (exact $250/$500/$1000 increments get more defense)
#
# The simulation uses RANDOM outcomes based on adjusted probability.
# No forward-looking candle data. No deterministic paths.

def apply_pinning_discount(fair_value, btc_price, strike, mins_remaining):
    """
    Reduce the model's probability to account for order book manipulation
    near settlement. OTM contracts (price below strike) get hammered hardest.

    Returns adjusted probability (always <= fair_value).
    """
    distance = btc_price - strike  # negative for OTM
    strike_mod_1000 = strike % 1000
    strike_mod_500 = strike % 500

    # Base pinning: OTM contracts face sell pressure that increases as
    # settlement approaches. Deeper OTM = less pinning (no one cares),
    # near the money = heavy pinning.
    if distance < 0:
        # Price is BELOW strike (true OTM) — heavy sell pressure above
        abs_dist_pct = abs(distance) / btc_price * 100
        if abs_dist_pct < 0.5:
            # Very close OTM: 15-25% pinning discount
            pin_discount = 0.20
        elif abs_dist_pct < 1.0:
            # Moderate OTM: 10-15% discount
            pin_discount = 0.12
        else:
            # Far OTM: 5% discount (market makers don't bother)
            pin_discount = 0.05
    elif distance < 200:
        # Price barely above strike — defenders try to push it back down
        pin_discount = 0.15
    else:
        # Safely above strike — minimal pinning
        pin_discount = 0.03

    # Round number bonus: $1000 levels get MORE defense
    if strike_mod_1000 == 0:
        pin_discount += 0.05
    elif strike_mod_500 == 0:
        pin_discount += 0.03

    # Time factor: pinning is stronger closer to settlement
    if mins_remaining < 15:
        pin_discount *= 1.5
    elif mins_remaining < 30:
        pin_discount *= 1.2

    # Apply: reduce probability by discount percentage
    adjusted = fair_value * (1 - pin_discount)
    return max(0.01, min(adjusted, fair_value))


# ──── Trade Simulation (HONEST: probability-based outcomes, no forward look) ────

def simulate_trade(entry_price, strike, contracts, current_candle, volatility,
                   use_exit_logic, hour_index, rng, entry_minute=30):
    """
    Simulate trade using PROBABILITY-BASED random outcomes.

    NO forward-looking data. NO candle close peeking.
    The outcome is a random coin flip weighted by the model probability,
    adjusted for settlement pinning.

    This is honest because:
    1. We only know what we knew at entry time (fair value estimate)
    2. Settlement pinning reduces win probability for OTM
    3. Each trade outcome is independently random
    """
    if not current_candle:
        return {"outcome": "no_data", "pnl": 0}

    btc_price = current_candle["open"]  # only use open (known at entry)
    mins_remaining = 60 - entry_minute

    # Calculate true probability with pinning discount
    raw_prob = estimate_fair_value(btc_price, strike, volatility, mins_remaining)
    adj_prob = apply_pinning_discount(raw_prob, btc_price, strike, mins_remaining)

    # Random outcome based on adjusted probability
    won = rng.random() < adj_prob

    if not use_exit_logic:
        if won:
            pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
            return {"outcome": "win", "pnl": pnl}
        else:
            pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
            return {"outcome": "loss", "pnl": pnl}

    # Smart exit: at mid-hour, re-evaluate based on updated probability
    # Simulate a mid-hour price (random walk from open)
    mid_move = rng.gauss(0, btc_price * (volatility / 100) * math.sqrt(0.25))
    mid_price = btc_price + mid_move

    # Use fair value model for mid-hour implied contract price (NOT the broken
    # estimate_contract_price which returns 30¢ for all OTM contracts)
    mid_fv = estimate_fair_value(mid_price, strike, volatility, 30)
    implied_price = mid_fv  # contract is worth its probability

    early_exit_pnl = calc_net_pnl(contracts, entry_price, implied_price, "early")
    settle_win_pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
    settle_lose_pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
    settle_ev = adj_prob * settle_win_pnl + (1 - adj_prob) * settle_lose_pnl

    # Only early exit if it's clearly better than holding
    if early_exit_pnl > settle_ev and early_exit_pnl > 0:
        return {"outcome": "early_exit", "pnl": early_exit_pnl}

    # Final outcome
    if won:
        pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
        return {"outcome": "win", "pnl": pnl}
    else:
        pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
        return {"outcome": "loss", "pnl": pnl}


# ──── Backtest Runner ────

def run_variant(candles, params, path_seed=0):
    # Independent RNG per variant+path — reproducible but no info leakage
    rng = random.Random(hash((path_seed, str(params))) & 0xFFFFFFFF)

    trades = 0
    wins = 0
    losses = 0
    early_exits = 0
    total_pnl = 0.0
    max_dd = 0.0
    peak_pnl = 0.0
    bankroll = 100.0
    peak_bank = 100.0
    min_bankroll = 100.0
    ruin_hit = False
    losing_streak = 0
    max_losing_streak = 0
    last_trade_hour = -999

    for i in range(13, len(candles)):
        # We're at the START of candle[i]. We observe candles[0..i-1] (completed).
        # Entry price reference = candle[i]["open"] (current market price).
        # Settlement = probability-based random outcome with pinning discount.
        # NO forward-looking data used.

        current_candle = candles[i]
        current_price = current_candle["open"]
        history = candles[max(0, i - 13):i]

        cooldown = params.get("cooldown_hours", 1)
        if i - last_trade_hour < cooldown:
            continue

        entry_minute = 30
        sig = check_otm_signal(history, current_price, entry_minute, params)

        if sig["signal"]:
            if bankroll < params.get("position_size", 20) * 0.5:
                ruin_hit = True
                continue

            result = simulate_trade(
                sig["entry_price"], sig["strike"], sig["contracts"],
                current_candle, sig["volatility"],
                params.get("use_exit_logic", True),
                hour_index=i,
                rng=rng,
                entry_minute=entry_minute
            )
            if result["outcome"] == "no_data":
                continue

            trades += 1
            pnl = result["pnl"]
            total_pnl += pnl
            bankroll += pnl
            last_trade_hour = i

            if "early_exit" in result["outcome"]:
                early_exits += 1
            if pnl >= 0:
                wins += 1
                losing_streak = 0
            else:
                losses += 1
                losing_streak += 1
                if losing_streak > max_losing_streak:
                    max_losing_streak = losing_streak

            if total_pnl > peak_pnl:
                peak_pnl = total_pnl
            dd = peak_pnl - total_pnl
            if dd > max_dd:
                max_dd = dd
            if bankroll > peak_bank:
                peak_bank = bankroll
            if bankroll < min_bankroll:
                min_bankroll = bankroll

    wr = (wins / trades * 100) if trades > 0 else 0
    expectancy = (total_pnl / trades) if trades > 0 else 0

    return {
        "trades": trades, "wins": wins, "losses": losses,
        "win_rate": wr, "total_pnl": total_pnl,
        "max_dd": max_dd, "expectancy": expectancy,
        "early_exits": early_exits,
        "final_bankroll": bankroll,
        "min_bankroll": min_bankroll,
        "ruin_hit": ruin_hit,
        "max_losing_streak": max_losing_streak,
    }


# ──── Experiment Definitions ────

def build_experiments():
    experiments = []
    exp_id = 0

    def add(name, params):
        nonlocal exp_id
        exp_id += 1
        # Fill in defaults
        defaults = {
            "min_time_remaining": 15,
            "sma_looseness": 0.003,
            "position_size": 20,
            "use_exit_logic": True,
            "cooldown_hours": 1,
            "strike_offset": 1,  # next-up by default
            "min_probability": 0.05,
            "max_probability": 0.45,
            "max_entry_price": 0.25,
        }
        merged = {**defaults, **params}
        experiments.append({"id": exp_id, "name": name, "params": merged})

    # ═══════════════════════════════════════════════════════════════════
    # GROUP A: ROLLING MOMENTUM (fix the clock-hour-boundary problem)
    # ═══════════════════════════════════════════════════════════════════

    # A1-A4: 1-hour rolling at different return thresholds
    for ret in [0.15, 0.2, 0.3, 0.4]:
        add(f"Roll-1h ret>{ret}% next-up 25¢", {
            "signal_type": "rolling_momentum",
            "momentum_lookback_hours": 1,
            "min_rolling_return": ret,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # A5-A8: 2-hour rolling momentum (sustained moves)
    for ret in [0.3, 0.4, 0.5, 0.7]:
        add(f"Roll-2h ret>{ret}% next-up 25¢", {
            "signal_type": "rolling_momentum",
            "momentum_lookback_hours": 2,
            "min_rolling_return": ret,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # A9-A12: Rolling momentum with two-up strike (cheaper contracts)
    for ret in [0.2, 0.3, 0.4, 0.5]:
        add(f"Roll-1h ret>{ret}% two-up 15¢", {
            "signal_type": "rolling_momentum",
            "momentum_lookback_hours": 1,
            "min_rolling_return": ret,
            "strike_offset": 2, "max_entry_price": 0.15,
        })

    # A13-A16: Rolling momentum with various entry caps
    for cap in [0.15, 0.20, 0.30, 0.40]:
        add(f"Roll-1h ret>0.25% next-up {int(cap*100)}¢", {
            "signal_type": "rolling_momentum",
            "momentum_lookback_hours": 1,
            "min_rolling_return": 0.25,
            "strike_offset": 1, "max_entry_price": cap,
        })

    # A17-A19: Rolling momentum, no SMA requirement
    for ret in [0.3, 0.4, 0.5]:
        add(f"Roll-1h ret>{ret}% noSMA next-up 25¢", {
            "signal_type": "rolling_momentum",
            "momentum_lookback_hours": 1,
            "min_rolling_return": ret,
            "sma_looseness": None,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # A20-A22: More time remaining (>25m, >35m) with rolling
    for time_min in [20, 25, 35]:
        add(f"Roll-1h ret>0.25% >{time_min}m next-up 25¢", {
            "signal_type": "rolling_momentum",
            "momentum_lookback_hours": 1,
            "min_rolling_return": 0.25,
            "min_time_remaining": time_min,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # ═══════════════════════════════════════════════════════════════════
    # GROUP B: DIP RECOVERY (buy the bounce)
    # ═══════════════════════════════════════════════════════════════════

    # B1-B4: Different dip depths with moderate recovery
    for dip in [-0.2, -0.3, -0.5, -0.8]:
        add(f"Dip>{dip}% rec>0.2% next-up 25¢", {
            "signal_type": "dip_recovery",
            "min_dip_pct": dip,
            "min_recovery_pct": 0.2,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # B5-B8: Different recovery thresholds
    for rec in [0.1, 0.15, 0.3, 0.5]:
        add(f"Dip>-0.3% rec>{rec}% next-up 25¢", {
            "signal_type": "dip_recovery",
            "min_dip_pct": -0.3,
            "min_recovery_pct": rec,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # B9-B12: Dip recovery with two-up strike
    for dip in [-0.3, -0.5, -0.8, -1.0]:
        add(f"Dip>{dip}% rec>0.2% two-up 15¢", {
            "signal_type": "dip_recovery",
            "min_dip_pct": dip,
            "min_recovery_pct": 0.2,
            "strike_offset": 2, "max_entry_price": 0.15,
        })

    # B13-B16: Dip recovery requiring trend turning
    for dip in [-0.2, -0.3, -0.5, -0.8]:
        add(f"Dip>{dip}% rec>0.2% +trend next-up", {
            "signal_type": "dip_recovery",
            "min_dip_pct": dip,
            "min_recovery_pct": 0.2,
            "require_trend_turn": True,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # B17-B19: Deep dip, strong recovery, wider entry caps
    for cap in [0.20, 0.30, 0.40]:
        add(f"Dip>-0.5% rec>0.3% next-up {int(cap*100)}¢", {
            "signal_type": "dip_recovery",
            "min_dip_pct": -0.5,
            "min_recovery_pct": 0.3,
            "strike_offset": 1, "max_entry_price": cap,
        })

    # ═══════════════════════════════════════════════════════════════════
    # GROUP C: VOLUME SPIKE + MOMENTUM
    # ═══════════════════════════════════════════════════════════════════

    # C1-C4: Volume ratio thresholds
    for vr in [1.3, 1.5, 2.0, 2.5]:
        add(f"Vol>{vr}x ret>0.2% next-up 25¢", {
            "signal_type": "volume_momentum",
            "min_vol_ratio": vr,
            "min_rolling_return": 0.2,
            "momentum_lookback_hours": 1,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # C5-C8: Volume + higher momentum thresholds
    for ret in [0.1, 0.2, 0.3, 0.4]:
        add(f"Vol>1.5x ret>{ret}% next-up 25¢", {
            "signal_type": "volume_momentum",
            "min_vol_ratio": 1.5,
            "min_rolling_return": ret,
            "momentum_lookback_hours": 1,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # C9-C11: Volume + momentum with two-up
    for vr in [1.5, 2.0, 2.5]:
        add(f"Vol>{vr}x ret>0.3% two-up 15¢", {
            "signal_type": "volume_momentum",
            "min_vol_ratio": vr,
            "min_rolling_return": 0.3,
            "momentum_lookback_hours": 1,
            "strike_offset": 2, "max_entry_price": 0.15,
        })

    # C12-C14: Volume + 2h momentum
    for vr in [1.3, 1.5, 2.0]:
        add(f"Vol>{vr}x ret-2h>0.3% next-up 25¢", {
            "signal_type": "volume_momentum",
            "min_vol_ratio": vr,
            "min_rolling_return": 0.3,
            "momentum_lookback_hours": 2,
            "vol_lookback": 6,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # ═══════════════════════════════════════════════════════════════════
    # GROUP D: PSYCHOLOGICAL LEVEL PLAYS
    # ═══════════════════════════════════════════════════════════════════

    # D1-D3: Broke above $1000 round number
    for cap in [0.20, 0.25, 0.35]:
        add(f"Psych $1k cross next-up {int(cap*100)}¢", {
            "signal_type": "psych_level",
            "psych_increment": 1000,
            "strike_offset": 1, "max_entry_price": cap,
        })

    # D4-D6: Broke above $500 round number (more frequent)
    for cap in [0.20, 0.25, 0.35]:
        add(f"Psych $500 cross next-up {int(cap*100)}¢", {
            "signal_type": "psych_level",
            "psych_increment": 500,
            "strike_offset": 1, "max_entry_price": cap,
        })

    # D7-D8: Psych level with two-up
    add(f"Psych $1k cross two-up 15¢", {
        "signal_type": "psych_level",
        "psych_increment": 1000,
        "strike_offset": 2, "max_entry_price": 0.15,
    })
    add(f"Psych $500 cross two-up 15¢", {
        "signal_type": "psych_level",
        "psych_increment": 500,
        "strike_offset": 2, "max_entry_price": 0.15,
    })

    # ═══════════════════════════════════════════════════════════════════
    # GROUP E: DIP + VOLUME COMBO
    # ═══════════════════════════════════════════════════════════════════

    # E1-E4: Dip on high volume, then recovery
    for dip in [-0.2, -0.3, -0.5, -0.8]:
        add(f"DipVol dip>{dip}% vol>1.5x rec>0.2% next-up", {
            "signal_type": "dip_volume_combo",
            "min_dip_pct": dip,
            "min_recovery_pct": 0.2,
            "min_vol_ratio": 1.5,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # E5-E7: Higher volume requirement
    for vr in [1.5, 2.0, 2.5]:
        add(f"DipVol dip>-0.3% vol>{vr}x rec>0.2% next-up", {
            "signal_type": "dip_volume_combo",
            "min_dip_pct": -0.3,
            "min_recovery_pct": 0.2,
            "min_vol_ratio": vr,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # ═══════════════════════════════════════════════════════════════════
    # GROUP F: MULTI-HOUR MOMENTUM (sustained trend, not just spike)
    # ═══════════════════════════════════════════════════════════════════

    # F1-F4: Require both 1h and 2h positive
    for r1, r2 in [(0.1, 0.2), (0.15, 0.3), (0.2, 0.4), (0.1, 0.15)]:
        add(f"Multi 1h>{r1}% 2h>{r2}% next-up 25¢", {
            "signal_type": "multi_hour_momentum",
            "min_1h_return": r1,
            "min_2h_return": r2,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # F5-F7: Multi-hour with two-up
    for r1, r2 in [(0.2, 0.3), (0.3, 0.5), (0.15, 0.25)]:
        add(f"Multi 1h>{r1}% 2h>{r2}% two-up 15¢", {
            "signal_type": "multi_hour_momentum",
            "min_1h_return": r1,
            "min_2h_return": r2,
            "strike_offset": 2, "max_entry_price": 0.15,
        })

    # F8-F10: Multi-hour with wider entry caps
    for cap in [0.30, 0.35, 0.40]:
        add(f"Multi 1h>0.1% 2h>0.2% next-up {int(cap*100)}¢", {
            "signal_type": "multi_hour_momentum",
            "min_1h_return": 0.1,
            "min_2h_return": 0.2,
            "strike_offset": 1, "max_entry_price": cap,
        })

    # ═══════════════════════════════════════════════════════════════════
    # GROUP G: SELLOFF RECOVERY (2-3 hour V-pattern)
    # ═══════════════════════════════════════════════════════════════════

    # G1-G4: Various selloff depths + bounce strengths
    for sell, bounce in [(-0.3, 0.15), (-0.5, 0.2), (-0.5, 0.3), (-0.8, 0.3)]:
        add(f"Selloff>{sell}% bounce>{bounce}% next-up 25¢", {
            "signal_type": "selloff_recovery",
            "min_selloff_pct": sell,
            "min_bounce_pct": bounce,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # G5-G7: Selloff recovery with two-up
    for sell, bounce in [(-0.5, 0.2), (-0.8, 0.3), (-1.0, 0.3)]:
        add(f"Selloff>{sell}% bounce>{bounce}% two-up 15¢", {
            "signal_type": "selloff_recovery",
            "min_selloff_pct": sell,
            "min_bounce_pct": bounce,
            "strike_offset": 2, "max_entry_price": 0.15,
        })

    # G8-G10: Selloff recovery with wider caps
    for cap in [0.30, 0.35, 0.40]:
        add(f"Selloff>-0.5% bounce>0.2% next-up {int(cap*100)}¢", {
            "signal_type": "selloff_recovery",
            "min_selloff_pct": -0.5,
            "min_bounce_pct": 0.2,
            "strike_offset": 1, "max_entry_price": cap,
        })

    # ═══════════════════════════════════════════════════════════════════
    # GROUP H: VOLATILITY EXPANSION
    # ═══════════════════════════════════════════════════════════════════

    # H1-H4: Vol expansion + positive return
    for exp_ratio in [1.5, 1.8, 2.0, 2.5]:
        add(f"VolExp>{exp_ratio}x ret>0.1% next-up 25¢", {
            "signal_type": "vol_expansion",
            "min_vol_expansion": exp_ratio,
            "min_rolling_return": 0.1,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # H5-H7: Vol expansion with higher return requirement
    for ret in [0.2, 0.3, 0.4]:
        add(f"VolExp>1.8x ret>{ret}% next-up 25¢", {
            "signal_type": "vol_expansion",
            "min_vol_expansion": 1.8,
            "min_rolling_return": ret,
            "strike_offset": 1, "max_entry_price": 0.25,
        })

    # H8-H9: Vol expansion with two-up
    for exp_ratio in [1.8, 2.5]:
        add(f"VolExp>{exp_ratio}x ret>0.2% two-up 15¢", {
            "signal_type": "vol_expansion",
            "min_vol_expansion": exp_ratio,
            "min_rolling_return": 0.2,
            "strike_offset": 2, "max_entry_price": 0.15,
        })

    # ═══════════════════════════════════════════════════════════════════
    # GROUP I: COMBO EXPERIMENTS (best-of-breed combinations)
    # ═══════════════════════════════════════════════════════════════════

    # I1: Rolling momentum + volume confirmation
    add("COMBO: Roll-1h>0.2% + Vol>1.3x next-up 25¢", {
        "signal_type": "volume_momentum",
        "min_vol_ratio": 1.3,
        "min_rolling_return": 0.2,
        "momentum_lookback_hours": 1,
        "strike_offset": 1, "max_entry_price": 0.25,
    })

    # I2: Gentle dip + quick recovery (most frequent dip pattern)
    add("COMBO: Dip>-0.15% rec>0.15% next-up 30¢", {
        "signal_type": "dip_recovery",
        "min_dip_pct": -0.15,
        "min_recovery_pct": 0.15,
        "strike_offset": 1, "max_entry_price": 0.30,
    })

    # I3: Moderate everything (frequency target)
    add("COMBO: Roll-1h>0.15% noSMA next-up 30¢", {
        "signal_type": "rolling_momentum",
        "momentum_lookback_hours": 1,
        "min_rolling_return": 0.15,
        "sma_looseness": None,
        "strike_offset": 1, "max_entry_price": 0.30,
        "max_probability": 0.50,
    })

    # I4: Multi-hour loose with volume
    add("COMBO: Multi 1h>0.1% 2h>0.15% + Vol>1.3x", {
        "signal_type": "volume_momentum",
        "min_vol_ratio": 1.3,
        "min_rolling_return": 0.1,
        "momentum_lookback_hours": 2,
        "strike_offset": 1, "max_entry_price": 0.30,
    })

    # I5: Small position, very loose (max frequency)
    add("COMBO: Roll-1h>0.1% noSMA $10 next-up 30¢", {
        "signal_type": "rolling_momentum",
        "momentum_lookback_hours": 1,
        "min_rolling_return": 0.1,
        "sma_looseness": None,
        "position_size": 10,
        "strike_offset": 1, "max_entry_price": 0.30,
    })

    # I6: Dip recovery + volume (high confidence bounce)
    add("COMBO: DipVol dip>-0.2% vol>1.3x rec>0.15%", {
        "signal_type": "dip_volume_combo",
        "min_dip_pct": -0.2,
        "min_recovery_pct": 0.15,
        "min_vol_ratio": 1.3,
        "strike_offset": 1, "max_entry_price": 0.30,
    })

    # I7: Wider prob band (catch more, but still OTM)
    add("COMBO: Roll-1h>0.2% prob 5-55% next-up 35¢", {
        "signal_type": "rolling_momentum",
        "momentum_lookback_hours": 1,
        "min_rolling_return": 0.2,
        "min_probability": 0.05,
        "max_probability": 0.55,
        "strike_offset": 1, "max_entry_price": 0.35,
    })

    # I8: Bigger position on stronger signals
    add("COMBO: Roll-1h>0.3% $30 next-up 25¢", {
        "signal_type": "rolling_momentum",
        "momentum_lookback_hours": 1,
        "min_rolling_return": 0.3,
        "position_size": 30,
        "strike_offset": 1, "max_entry_price": 0.25,
    })

    # I9: 3-hour lookback for major trend
    add("COMBO: Roll-3h>0.5% next-up 25¢", {
        "signal_type": "rolling_momentum",
        "momentum_lookback_hours": 3,
        "min_rolling_return": 0.5,
        "strike_offset": 1, "max_entry_price": 0.25,
    })

    # I10: Dip recovery but NO trend requirement at all
    add("COMBO: Dip>-0.3% rec>0.25% noSMA next-up 30¢", {
        "signal_type": "dip_recovery",
        "min_dip_pct": -0.3,
        "min_recovery_pct": 0.25,
        "sma_looseness": None,
        "strike_offset": 1, "max_entry_price": 0.30,
    })

    return experiments


# ──── Main ────

if __name__ == "__main__":
    NUM_PATHS = 10
    start_time = time.time()

    print("=" * 130)
    print("  EXPANDED OTM EXPERIMENT: Rolling Momentum, Dip Recovery, Volume, Psych Levels")
    print(f"  {NUM_PATHS} Monte Carlo paths × 365 days each")
    print(f"  Target: find OTM strategies that fire 1-2+ times/week with positive expectancy")
    print("=" * 130)

    # Generate paths
    print("\n  Generating price paths...")
    all_paths = []
    for seed_idx in range(NUM_PATHS):
        candles = generate_realistic_btc_data(days=365, seed=seed_idx * 17 + 42)
        lo = min(c["low"] for c in candles)
        hi = max(c["high"] for c in candles)
        final = candles[-1]["close"]
        print(f"    Path {seed_idx+1}: seed={seed_idx*17+42}, "
              f"${candles[0]['open']:,.0f} -> ${final:,.0f} "
              f"(range ${lo:,.0f}-${hi:,.0f})")
        all_paths.append(candles)

    experiments = build_experiments()
    total_exp = len(experiments)
    print(f"\n  Running {total_exp} experiments × {NUM_PATHS} paths = "
          f"{total_exp * NUM_PATHS} backtests...\n")

    results = []
    for exp in experiments:
        path_results = []
        for path_idx, candles in enumerate(all_paths):
            r = run_variant(candles, exp["params"], path_seed=path_idx)
            path_results.append(r)

        n = len(path_results)
        avg_trades = sum(r["trades"] for r in path_results) / n
        avg_wr = sum(r["win_rate"] for r in path_results) / n
        avg_pnl = sum(r["total_pnl"] for r in path_results) / n
        avg_dd = sum(r["max_dd"] for r in path_results) / n
        avg_exp_val = sum(r["expectancy"] for r in path_results) / n
        worst_pnl = min(r["total_pnl"] for r in path_results)
        best_pnl = max(r["total_pnl"] for r in path_results)
        profitable = sum(1 for r in path_results if r["total_pnl"] > 0)
        avg_early = sum(r["early_exits"] for r in path_results) / n
        avg_bank = sum(r["final_bankroll"] for r in path_results) / n
        worst_bank = min(r["final_bankroll"] for r in path_results)
        min_bank_ever = min(r["min_bankroll"] for r in path_results)
        ruin_count = sum(1 for r in path_results if r["ruin_hit"])
        worst_streak = max(r["max_losing_streak"] for r in path_results)

        risk_adj = avg_pnl / avg_dd if avg_dd > 0 else (999 if avg_pnl > 0 else -999)

        # Frequency score: how close to 1-2/week target (52-104/yr)?
        freq_target_lo = 52
        freq_target_hi = 150
        if avg_trades >= freq_target_lo and avg_trades <= freq_target_hi:
            freq_score = 1.0
        elif avg_trades < freq_target_lo and avg_trades > 0:
            freq_score = avg_trades / freq_target_lo
        elif avg_trades > freq_target_hi:
            freq_score = freq_target_hi / avg_trades
        else:
            freq_score = 0

        # Composite score: profit + safety + frequency
        composite = (
            (avg_pnl * 1.0) +                      # want positive returns
            (worst_pnl * 1.5) +                     # heavily penalize worst case
            (-ruin_count * 100) +                   # massive ruin penalty
            (-avg_dd * 0.5) +                       # penalize drawdown
            (freq_score * 50) +                     # bonus for hitting frequency target
            (min_bank_ever * 0.5)                   # penalize near-ruin
        )

        results.append({
            "id": exp["id"],
            "name": exp["name"],
            "params": exp["params"],
            "avg_trades": avg_trades,
            "avg_wr": avg_wr,
            "avg_pnl": avg_pnl,
            "avg_dd": avg_dd,
            "avg_exp": avg_exp_val,
            "worst_pnl": worst_pnl,
            "best_pnl": best_pnl,
            "profitable": profitable,
            "avg_early": avg_early,
            "risk_adj": risk_adj,
            "avg_bank": avg_bank,
            "worst_bank": worst_bank,
            "min_bank_ever": min_bank_ever,
            "ruin_count": ruin_count,
            "worst_streak": worst_streak,
            "freq_score": freq_score,
            "composite": composite,
        })

        if exp["id"] % 20 == 0:
            print(f"    Completed {exp['id']}/{total_exp}...")

    elapsed = time.time() - start_time
    print(f"\n  All {total_exp} experiments complete in {elapsed:.1f}s\n")

    # ════════════════════════════════════════════════════════════════
    # RESULTS OUTPUT
    # ════════════════════════════════════════════════════════════════

    def detail(v, rank, label=""):
        p = v["params"]
        trades_wk = v["avg_trades"] / 52
        print(f"\n  {'─' * 125}")
        print(f"  RANK #{rank} {label}")
        print(f"  {v['name']}")
        print(f"  {'─' * 125}")
        print(f"  Signal: {p['signal_type']:<22}  Strike: +{p['strike_offset']}×$250  "
              f"MaxEntry: {int(p['max_entry_price']*100)}¢  "
              f"Size: ${p['position_size']}  Time: >{p['min_time_remaining']}m")
        sma = "off" if p.get("sma_looseness") is None else f"{p['sma_looseness']*100:.1f}%"
        print(f"  SMA: {sma}  Prob: {p['min_probability']*100:.0f}-{p['max_probability']*100:.0f}%  "
              f"Exit: {'Smart' if p['use_exit_logic'] else 'Hold'}")
        # Signal-specific params
        if p["signal_type"] == "rolling_momentum":
            print(f"  Lookback: {p.get('momentum_lookback_hours', 1)}h  "
                  f"MinReturn: {p.get('min_rolling_return', 0)}%")
        elif p["signal_type"] == "dip_recovery":
            print(f"  MinDip: {p.get('min_dip_pct', 0)}%  "
                  f"MinRecovery: {p.get('min_recovery_pct', 0)}%  "
                  f"TrendReq: {p.get('require_trend_turn', False)}")
        elif p["signal_type"] == "volume_momentum":
            print(f"  MinVolRatio: {p.get('min_vol_ratio', 0)}x  "
                  f"MinReturn: {p.get('min_rolling_return', 0)}%  "
                  f"Lookback: {p.get('momentum_lookback_hours', 1)}h")
        elif p["signal_type"] == "psych_level":
            print(f"  PsychIncrement: ${p.get('psych_increment', 1000)}")
        elif p["signal_type"] == "dip_volume_combo":
            print(f"  MinDip: {p.get('min_dip_pct', 0)}%  "
                  f"MinRec: {p.get('min_recovery_pct', 0)}%  "
                  f"MinVol: {p.get('min_vol_ratio', 0)}x")
        elif p["signal_type"] == "multi_hour_momentum":
            print(f"  Min1h: {p.get('min_1h_return', 0)}%  "
                  f"Min2h: {p.get('min_2h_return', 0)}%")
        elif p["signal_type"] == "selloff_recovery":
            print(f"  MinSelloff: {p.get('min_selloff_pct', 0)}%  "
                  f"MinBounce: {p.get('min_bounce_pct', 0)}%")
        elif p["signal_type"] == "vol_expansion":
            print(f"  MinExpansion: {p.get('min_vol_expansion', 0)}x  "
                  f"MinReturn: {p.get('min_rolling_return', 0)}%")

        print(f"  Results ({NUM_PATHS}-path avg):")
        print(f"    Trades/Yr: {v['avg_trades']:>6.0f} ({trades_wk:.1f}/wk)    "
              f"WR: {v['avg_wr']:>5.1f}%    "
              f"Exp: ${v['avg_exp']:>+.2f}/trade")
        print(f"    Avg P&L: ${v['avg_pnl']:>+9.2f}    Max DD: ${v['avg_dd']:>7.2f}    "
              f"Risk-Adj: {v['risk_adj']:>6.2f}")
        print(f"    Best: ${v['best_pnl']:>+9.2f}    Worst: ${v['worst_pnl']:>+9.2f}    "
              f"Profitable: {v['profitable']}/{NUM_PATHS}")
        print(f"    MinBankroll: ${v['min_bank_ever']:>7.2f}  "
              f"Ruin: {v['ruin_count']}/{NUM_PATHS}  "
              f"MaxLoseStreak: {v['worst_streak']}  "
              f"Composite: {v['composite']:>+.1f}")

    # ──── FULL RANKING ────
    by_composite = sorted(results, key=lambda x: x["composite"], reverse=True)

    print(f"{'=' * 130}")
    print(f"  FULL RANKING BY COMPOSITE SCORE (profit + safety + frequency)")
    print(f"  Score = 1×avg_pnl + 1.5×worst_pnl - 100×ruin - 0.5×dd + 50×freq_score + 0.5×min_bank")
    print(f"{'=' * 130}")
    for i, v in enumerate(by_composite):
        trades_wk = v["avg_trades"] / 52
        print(f"  {i+1:>3}. {v['name']:<55} "
              f"Score:{v['composite']:>+8.1f}  P&L:${v['avg_pnl']:>+8.2f}  "
              f"WR:{v['avg_wr']:>5.1f}%  T/wk:{trades_wk:>4.1f}  "
              f"Ruin:{v['ruin_count']}/{NUM_PATHS}  "
              f"Worst:${v['worst_pnl']:>+8.2f}")

    # ──── TOP 15 DETAILED ────
    print(f"\n{'=' * 130}")
    print(f"  TOP 15 BY COMPOSITE SCORE")
    print(f"{'=' * 130}")
    for i, v in enumerate(by_composite[:15]):
        detail(v, i + 1, "(composite)")

    # ──── TOP 10 ZERO-RUIN, 1+/WEEK ────
    weekly = sorted(
        [v for v in results if v["ruin_count"] == 0 and v["avg_trades"] >= 40],
        key=lambda x: x["avg_pnl"], reverse=True)

    print(f"\n{'=' * 130}")
    print(f"  TOP 10 ZERO-RUIN WITH 1+/WEEK FREQUENCY (>=40 trades/yr, 0 ruin)")
    print(f"{'=' * 130}")
    if weekly:
        for i, v in enumerate(weekly[:10]):
            detail(v, i + 1, "(weekly+safe)")
    else:
        print("  No strategies met criteria (0 ruin + 40+ trades/yr)")
        # Show best near-misses
        near = sorted(
            [v for v in results if v["ruin_count"] <= 1 and v["avg_trades"] >= 20],
            key=lambda x: x["avg_pnl"], reverse=True)
        if near:
            print(f"\n  Near-misses (<=1 ruin, >=20 trades/yr):")
            for i, v in enumerate(near[:5]):
                detail(v, i + 1, "(near-miss)")

    # ──── BY SIGNAL TYPE ────
    signal_types = set(v["params"]["signal_type"] for v in results)
    print(f"\n{'=' * 130}")
    print(f"  BEST BY SIGNAL TYPE (top 3 per type, 0 ruin preferred)")
    print(f"{'=' * 130}")

    for st in sorted(signal_types):
        st_results = [v for v in results if v["params"]["signal_type"] == st]
        # Prefer zero ruin, then sort by composite
        st_zero = sorted([v for v in st_results if v["ruin_count"] == 0],
                         key=lambda x: x["composite"], reverse=True)
        st_any = sorted(st_results, key=lambda x: x["composite"], reverse=True)
        best = st_zero[:3] if len(st_zero) >= 3 else (st_zero + st_any[:3-len(st_zero)])

        print(f"\n  ── {st.upper()} ──")
        for i, v in enumerate(best[:3]):
            trades_wk = v["avg_trades"] / 52
            print(f"    {i+1}. {v['name']:<55} "
                  f"P&L:${v['avg_pnl']:>+8.2f}  WR:{v['avg_wr']:>5.1f}%  "
                  f"T/wk:{trades_wk:>4.1f}  Ruin:{v['ruin_count']}/{NUM_PATHS}  "
                  f"Exp:${v['avg_exp']:>+.2f}")

    # ──── DIP RECOVERY SPECIAL ANALYSIS ────
    print(f"\n{'=' * 130}")
    print(f"  DIP RECOVERY ANALYSIS (does buying bounces work for OTM?)")
    print(f"{'=' * 130}")
    dip_results = sorted(
        [v for v in results if "dip" in v["params"]["signal_type"]],
        key=lambda x: x["composite"], reverse=True)
    for i, v in enumerate(dip_results[:8]):
        detail(v, i + 1, "(dip)")

    # ──── FREQUENCY ANALYSIS ────
    print(f"\n{'=' * 130}")
    print(f"  FREQUENCY ANALYSIS: How many trades per week?")
    print(f"{'=' * 130}")
    freq_buckets = {
        "0-0.5/wk (0-26/yr)": [v for v in results if v["avg_trades"] < 26],
        "0.5-1/wk (26-52/yr)": [v for v in results if 26 <= v["avg_trades"] < 52],
        "1-2/wk (52-104/yr)": [v for v in results if 52 <= v["avg_trades"] < 104],
        "2-3/wk (104-156/yr)": [v for v in results if 104 <= v["avg_trades"] < 156],
        "3+/wk (156+/yr)": [v for v in results if v["avg_trades"] >= 156],
    }
    for bucket, items in freq_buckets.items():
        profitable_items = [v for v in items if v["avg_pnl"] > 0]
        zero_ruin = [v for v in items if v["ruin_count"] == 0]
        best = max(items, key=lambda x: x["avg_pnl"]) if items else None
        print(f"\n  {bucket}: {len(items)} strategies tested, "
              f"{len(profitable_items)} profitable, {len(zero_ruin)} zero-ruin")
        if best:
            print(f"    Best: {best['name']}")
            print(f"    P&L: ${best['avg_pnl']:>+.2f}  WR: {best['avg_wr']:.1f}%  "
                  f"Ruin: {best['ruin_count']}/{NUM_PATHS}")

    # ──── FINAL RECOMMENDATION ────
    # Pick best zero-ruin with reasonable frequency, or best composite if none qualify
    candidates = sorted(
        [v for v in results if v["ruin_count"] == 0 and v["avg_trades"] >= 20 and v["avg_pnl"] > 0],
        key=lambda x: x["composite"], reverse=True)

    if not candidates:
        candidates = sorted(
            [v for v in results if v["ruin_count"] <= 1 and v["avg_pnl"] > 0],
            key=lambda x: x["composite"], reverse=True)

    print(f"\n{'=' * 130}")
    print(f"  FINAL RECOMMENDATION")
    print(f"{'=' * 130}")

    if candidates:
        rec = candidates[0]
        detail(rec, 1, "RECOMMENDED")
        if len(candidates) > 1:
            detail(candidates[1], 2, "RUNNER-UP")
        if len(candidates) > 2:
            detail(candidates[2], 3, "THIRD")
    else:
        print("  No viable OTM strategies found with current parameter ranges.")
        print("  The best overall:")
        detail(by_composite[0], 1, "BEST AVAILABLE")

    print(f"\n  Total runtime: {time.time() - start_time:.1f}s")
    print()
