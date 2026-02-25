#!/usr/bin/env python3
"""
Experiment: Realistic Robinhood Pricing Model + Entry Cap Optimization

The old backtest used `estimate_contract_price()` which doesn't match real
Robinhood pricing.  This experiment replaces it with a model calibrated to
actual RH screenshots:

  Real data (BTC ~$67,850):
    25 min left  |  $67,750 floor (+$103)  → 69¢  |  $68,000 next-up (-$147) → 23¢
    45 min left  |  $67,750 floor (+$100)  → 71¢  |  $68,000 next-up (-$150) → 44¢

Key insight: with more time left, OTM contracts cost MORE (more uncertainty).
Floor strikes (price above strike) are always expensive (60-99¢).
The real aggressive play is the next-up strike, whose price depends heavily
on time remaining and distance from strike.

Tests 60+ configurations:
  - Strike selection: floor, next-up, always-ceil, smart-select, two-up
  - Entry cap: 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50
  - Time-based caps: different max for early-hour vs mid-hour
  - Probability bands: various ranges
  - Position sizes: 15, 20, 25, 30

Uses the same 10-path Monte Carlo infrastructure (365 days each).
"""

import random
import math
import time
from datetime import datetime, timezone

# ──── Data Generation (identical to existing experiments) ────

def generate_realistic_btc_data(days=365, seed=42):
    random.seed(seed)
    candles = []
    hours = days * 24
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

        ts = start_ts + (h * 3600 * 1000)
        candles.append({
            "open_time": ts, "open": round(open_price, 2),
            "high": round(high, 2), "low": round(low, 2),
            "close": round(close_price, 2),
            "volume": round(random.uniform(500, 5000), 2),
            "close_time": ts + 3599999,
        })
        price = close_price
        if price > 80000: price *= 0.9999
        elif price < 20000: price *= 1.0001

    return candles


# ──── Indicators ────

def calc_sma(candles, period):
    if len(candles) < period: return 0
    return sum(c["close"] for c in candles[-period:]) / period

def calc_volatility(candle):
    if candle["open"] == 0: return 0
    return ((candle["high"] - candle["low"]) / candle["open"]) * 100

def calc_hour_return(candle, current_price):
    if candle["open"] == 0: return 0
    return ((current_price - candle["open"]) / candle["open"]) * 100


# ──── Realistic Robinhood Contract Pricing Model ────
#
# Calibrated from actual RH screenshots.  Key observations:
#
# 1. Contracts are priced as probability * $1, but with a spread/markup.
# 2. For ITM contracts (price > strike), floor ~60-99¢ — always expensive.
# 3. For OTM contracts (price < strike), prices depend heavily on:
#    - Distance below strike (more distance = cheaper)
#    - Time remaining (more time = more expensive, since more chance to reach)
# 4. Robinhood uses their own model, but the result tracks closely to a
#    GBM-based normal CDF with ~0.8-1.2% hourly vol, plus a spread of ~3-5¢.
#
# Calibration points:
#   45 min, dist -150  → 44¢     25 min, dist -150  → 23¢
#   45 min, dist -400  → 17¢     25 min, dist -400  →  5¢
#   45 min, dist -650  →  4¢     25 min, dist -650  →  2¢
#   45 min, dist +100  → 71¢     25 min, dist +100  → 69¢

def normal_cdf(x):
    """Standard normal CDF (Abramowitz & Stegun)."""
    a1, a2, a3, a4, a5 = 0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429
    p = 0.3275911
    sign = -1 if x < 0 else 1
    ax = abs(x)
    t = 1 / (1 + p * ax)
    y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * math.exp(-ax * ax / 2)
    return 0.5 * (1 + sign * y)


def rh_contract_price(btc_price, strike, hourly_vol_pct, minutes_remaining):
    """
    Estimate what Robinhood would charge for a YES contract.

    Uses a GBM probability model plus a spread that matches observed RH prices.
    The spread represents the market-maker edge + bid-ask gap.
    """
    if minutes_remaining <= 0:
        return 0.99 if btc_price >= strike else 0.01

    # GBM-based probability that BTC >= strike at settlement
    distance = btc_price - strike
    time_hours = minutes_remaining / 60
    # Robinhood's implied vol is slightly higher than raw candle vol
    # because they account for intra-hour movement, not just open/close
    effective_vol = hourly_vol_pct * 1.15
    expected_move = btc_price * (effective_vol / 100) * math.sqrt(time_hours)

    if expected_move <= 0:
        return 0.99 if btc_price >= strike else 0.01

    z = distance / expected_move
    fair_prob = normal_cdf(z)

    # Robinhood spread: they sell contracts at a markup over fair value.
    # The spread is larger for mid-range contracts and smaller at extremes.
    # Observed: ~3-5¢ spread on contracts in the 20-50¢ range.
    spread = 0.04 * (1 - abs(fair_prob - 0.5) * 2)  # Max 4¢ at 50%, 0 at extremes

    rh_price = fair_prob + spread

    # Clamp to realistic RH range
    return max(0.01, min(0.99, rh_price))


def estimate_fair_value(price, strike, vol, mins_remaining):
    """Model probability (our estimate, not RH's price)."""
    if vol <= 0 or mins_remaining <= 0:
        return 1.0 if price > strike else 0.0
    distance = price - strike
    time_hours = mins_remaining / 60
    expected_move = price * (vol / 100) * math.sqrt(max(time_hours, 0.01))
    if expected_move <= 0:
        return 1.0 if price > strike else 0.0
    z = distance / expected_move
    return max(0.01, min(0.99, normal_cdf(z)))


# ──── Strike & PnL ────

STRIKE_INCREMENT = 250
TAKER_FEE_PCT = 1.5
MIN_STRIKE_DISTANCE = 50

def floor_strike(price):
    return math.floor(price / STRIKE_INCREMENT) * STRIKE_INCREMENT

def ceil_strike(price):
    cs = math.ceil(price / STRIKE_INCREMENT) * STRIKE_INCREMENT
    if cs <= price:
        cs += STRIKE_INCREMENT
    return cs

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

def calc_risk_of_ruin(current_price, strike, volatility, minutes_remaining):
    distance = current_price - strike
    time_hours = minutes_remaining / 60
    expected_move = current_price * (volatility / 100) * math.sqrt(max(time_hours, 0.01))
    z = distance / expected_move if expected_move > 0 else 0
    return max(0.01, min(0.99, 1 - normal_cdf(z)))


# ──── Trade Simulation (uses realistic RH pricing for exits too) ────

def simulate_trade(entry_price, strike, contracts, candles_after, volatility, btc_entry_price,
                   use_exit_logic=True):
    """Simulate a trade with realistic RH pricing for both entry and exit."""
    if not candles_after:
        return {"outcome": "no_data", "pnl": 0}

    settlement_candle = candles_after[0]
    settlement_price = settlement_candle["close"]

    if not use_exit_logic:
        # Hold to settlement
        if settlement_price > strike:
            pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
            return {"outcome": "win", "pnl": pnl}
        else:
            pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
            return {"outcome": "loss", "pnl": pnl}

    # Smart exit using RH pricing model
    mid_price = (settlement_candle["open"] + settlement_candle["close"]) / 2
    ror = calc_risk_of_ruin(mid_price, strike, volatility, 30)

    # What could we sell the contract for at 30min mark?
    implied_price = rh_contract_price(mid_price, strike, volatility, 30)
    early_exit_pnl = calc_net_pnl(contracts, entry_price, implied_price, "early")

    settle_win_pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
    settle_lose_pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
    settle_ev = (1 - ror) * settle_win_pnl + ror * settle_lose_pnl

    if ror >= 0.5:
        return {"outcome": "early_exit", "pnl": early_exit_pnl}
    if settle_ev < early_exit_pnl and early_exit_pnl > 0:
        return {"outcome": "early_exit", "pnl": early_exit_pnl}

    # Late check at 10min
    late_price = settlement_candle["close"]
    late_ror = calc_risk_of_ruin(late_price, strike, volatility, 10)
    if late_ror >= 0.3:
        late_implied = rh_contract_price(late_price, strike, volatility, 10)
        late_exit_pnl = calc_net_pnl(contracts, entry_price, late_implied, "early")
        late_settle_ev = (1 - late_ror) * settle_win_pnl + late_ror * settle_lose_pnl
        if late_settle_ev <= late_exit_pnl * 1.2:
            return {"outcome": "early_exit", "pnl": late_exit_pnl}

    if settlement_price > strike:
        pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
        return {"outcome": "win", "pnl": pnl}
    else:
        pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
        return {"outcome": "loss", "pnl": pnl}


# ──── Signal Check (common trend filters) ────

def check_trend(candles, current_price, hour_utc, sma_looseness=0.001):
    """Check common trend filters. Returns (passed, details)."""
    if not (14 <= hour_utc < 21):
        return False, {}

    sma3 = calc_sma(candles, 3)
    sma6 = calc_sma(candles, 6)
    sma12 = calc_sma(candles, 12)
    if 0 in (sma3, sma6, sma12):
        return False, {}

    if sma_looseness is None:
        short_trend = True
        medium_trend = True
    elif sma_looseness == 0:
        short_trend = sma3 > sma6
        medium_trend = sma6 > sma12
    else:
        short_trend = sma3 > sma6 or (sma6 > 0 and (sma6 - sma3) / sma6 < sma_looseness)
        medium_trend = sma6 > sma12 or (sma12 > 0 and (sma12 - sma6) / sma12 < sma_looseness)

    if not short_trend or not medium_trend:
        return False, {}

    hr = calc_hour_return(candles[-1], current_price)
    vol = calc_volatility(candles[-1])

    return True, {"vol": vol, "hr": hr}


# ──── Parameterized Aggressive Signal + Trade ────

def run_variant(candles, params):
    """Run a full year backtest with given parameters."""
    trades = 0
    wins = 0
    losses = 0
    early_exits = 0
    total_pnl = 0.0
    max_dd = 0.0
    peak_pnl = 0.0
    floor_used = 0
    next_up_used = 0
    ceil_used = 0
    two_up_used = 0
    skipped_too_expensive = 0
    skipped_no_strike = 0
    skipped_prob = 0
    bankroll = 100.0

    strike_type = params["strike_type"]
    position_size = params["position_size"]
    prob_lo = params["prob_lo"]
    prob_hi = params["prob_hi"]
    min_time = params["min_time_remaining"]
    hr_threshold = params["hour_return_threshold"]
    use_exit = params["use_exit_logic"]
    sma_loose = params["sma_looseness"]
    # Entry cap can be a fixed number or a dict with "early" and "late" keys
    entry_cap = params["entry_cap"]

    for i in range(12, len(candles) - 1):
        candle = candles[i]
        dt = datetime.fromtimestamp(candle["open_time"] / 1000, tz=timezone.utc)
        hour_utc = dt.hour
        current_price = candle["close"]
        history = candles[max(0, i - 12):i + 1]
        vol = calc_volatility(candle)

        # Simulate entry at a random point in the hour (weighted toward first half)
        # This matters because RH pricing changes with time remaining
        minute = random.randint(0, 45)  # Entry between :00 and :45
        mins_remaining = 60 - minute

        if mins_remaining <= min_time:
            continue

        passed, details = check_trend(history, current_price, hour_utc, sma_loose)
        if not passed:
            continue

        if details["hr"] <= hr_threshold:
            continue

        # ── Strike Selection ──
        fs = floor_strike(current_price)
        ns = fs + STRIKE_INCREMENT  # next-up
        ts = fs + 2 * STRIKE_INCREMENT  # two-up

        fv_floor = estimate_fair_value(current_price, fs, vol, mins_remaining)
        fv_next = estimate_fair_value(current_price, ns, vol, mins_remaining)
        fv_two = estimate_fair_value(current_price, ts, vol, mins_remaining)

        # RH market prices (what we'd actually pay)
        rh_floor = rh_contract_price(current_price, fs, vol, mins_remaining)
        rh_next = rh_contract_price(current_price, ns, vol, mins_remaining)
        rh_two = rh_contract_price(current_price, ts, vol, mins_remaining)

        # Determine max entry for this trade based on time
        if isinstance(entry_cap, dict):
            if mins_remaining >= 35:
                max_entry = entry_cap["early"]
            else:
                max_entry = entry_cap["late"]
        else:
            max_entry = entry_cap

        strike = None
        fair_value = None
        actual_entry = None
        strike_label = None

        if strike_type == "floor":
            dist = current_price - fs
            if dist >= MIN_STRIKE_DISTANCE and prob_lo <= fv_floor <= prob_hi:
                if rh_floor <= max_entry:
                    strike, fair_value, actual_entry = fs, fv_floor, rh_floor
                    strike_label = "floor"
                else:
                    skipped_too_expensive += 1
                    continue
            else:
                skipped_prob += 1
                continue

        elif strike_type == "next_up":
            # Always target first strike above price
            if prob_lo <= fv_next <= prob_hi:
                if rh_next <= max_entry:
                    strike, fair_value, actual_entry = ns, fv_next, rh_next
                    strike_label = "next_up"
                else:
                    skipped_too_expensive += 1
                    continue
            else:
                skipped_prob += 1
                continue

        elif strike_type == "two_up":
            # Target two strikes above — lottery ticket
            if prob_lo <= fv_two <= prob_hi:
                if rh_two <= max_entry:
                    strike, fair_value, actual_entry = ts, fv_two, rh_two
                    strike_label = "two_up"
                else:
                    skipped_too_expensive += 1
                    continue
            else:
                skipped_prob += 1
                continue

        elif strike_type == "next_up_fallback":
            # Try floor first, fall back to next-up
            dist = current_price - fs
            picked = False
            if dist >= MIN_STRIKE_DISTANCE and prob_lo <= fv_floor <= prob_hi and rh_floor <= max_entry:
                strike, fair_value, actual_entry = fs, fv_floor, rh_floor
                strike_label = "floor"
                picked = True
            if not picked and prob_lo <= fv_next <= prob_hi and rh_next <= max_entry:
                strike, fair_value, actual_entry = ns, fv_next, rh_next
                strike_label = "next_up"
                picked = True
            if not picked:
                skipped_no_strike += 1
                continue

        elif strike_type == "smart_select":
            # Pick whichever affordable strike has best risk/reward
            candidates = []
            dist = current_price - fs
            if dist >= MIN_STRIKE_DISTANCE and prob_lo <= fv_floor <= prob_hi and rh_floor <= max_entry:
                # Edge = fair value - market price (how much we're underpaying)
                edge = fv_floor - rh_floor
                candidates.append((fs, fv_floor, rh_floor, "floor", edge))
            if prob_lo <= fv_next <= prob_hi and rh_next <= max_entry:
                edge = fv_next - rh_next
                candidates.append((ns, fv_next, rh_next, "next_up", edge))
            if prob_lo <= fv_two <= prob_hi and rh_two <= max_entry:
                edge = fv_two - rh_two
                candidates.append((ts, fv_two, rh_two, "two_up", edge))

            if not candidates:
                skipped_no_strike += 1
                continue

            # Pick the one with the most edge (biggest gap between fair value and RH price)
            best = max(candidates, key=lambda x: x[4])
            strike, fair_value, actual_entry, strike_label = best[0], best[1], best[2], best[3]

        elif strike_type == "cheapest_valid":
            # Pick the cheapest contract that passes probability filter
            candidates = []
            dist = current_price - fs
            if dist >= MIN_STRIKE_DISTANCE and prob_lo <= fv_floor <= prob_hi and rh_floor <= max_entry:
                candidates.append((fs, fv_floor, rh_floor, "floor"))
            if prob_lo <= fv_next <= prob_hi and rh_next <= max_entry:
                candidates.append((ns, fv_next, rh_next, "next_up"))
            if prob_lo <= fv_two <= prob_hi and rh_two <= max_entry:
                candidates.append((ts, fv_two, rh_two, "two_up"))

            if not candidates:
                skipped_no_strike += 1
                continue

            best = min(candidates, key=lambda x: x[2])  # Cheapest RH price
            strike, fair_value, actual_entry, strike_label = best[0], best[1], best[2], best[3]

        else:
            continue

        # Track strike type usage
        if strike_label == "floor": floor_used += 1
        elif strike_label == "next_up": next_up_used += 1
        elif strike_label == "ceil": ceil_used += 1
        elif strike_label == "two_up": two_up_used += 1

        # Entry: use actual RH price (not our max cap)
        contracts_count = math.floor(position_size / actual_entry)
        if contracts_count <= 0:
            continue

        result = simulate_trade(
            actual_entry, strike, contracts_count,
            candles[i + 1:i + 3], vol, current_price,
            use_exit_logic=use_exit
        )

        if result["outcome"] == "no_data":
            continue

        trades += 1
        pnl = result["pnl"]
        total_pnl += pnl
        bankroll += pnl

        if "early_exit" in result["outcome"]:
            early_exits += 1
        if pnl >= 0:
            wins += 1
        else:
            losses += 1

        if total_pnl > peak_pnl:
            peak_pnl = total_pnl
        dd = peak_pnl - total_pnl
        if dd > max_dd:
            max_dd = dd

    wr = (wins / trades * 100) if trades > 0 else 0
    expectancy = (total_pnl / trades) if trades > 0 else 0

    return {
        "trades": trades, "wins": wins, "losses": losses,
        "win_rate": wr, "total_pnl": total_pnl,
        "max_dd": max_dd, "expectancy": expectancy,
        "early_exits": early_exits,
        "floor_used": floor_used, "next_up_used": next_up_used,
        "ceil_used": ceil_used, "two_up_used": two_up_used,
        "skipped_expensive": skipped_too_expensive,
        "skipped_prob": skipped_prob,
        "skipped_no_strike": skipped_no_strike,
        "final_bankroll": bankroll,
    }


# ──── Experiment Definitions ────

def build_experiments():
    experiments = []
    exp_id = 0

    base = {
        "strike_type": "next_up",
        "entry_cap": 0.30,
        "position_size": 20,
        "prob_lo": 0.20,
        "prob_hi": 0.70,
        "min_time_remaining": 15,
        "hour_return_threshold": 0.3,
        "use_exit_logic": True,
        "sma_looseness": 0.001,
    }

    def add(name, overrides):
        nonlocal exp_id
        exp_id += 1
        p = dict(base)
        p.update(overrides)
        experiments.append({"id": exp_id, "name": name, "params": p})

    # ════════════════════════════════════════════════════════════════
    # SWEEP 1: STRIKE SELECTION (6 experiments)
    # ════════════════════════════════════════════════════════════════
    add("BASELINE: next-up @ 30¢ cap", {})
    add("Strike: floor only @ 70¢ cap", {"strike_type": "floor", "entry_cap": 0.70, "prob_lo": 0.50, "prob_hi": 0.95})
    add("Strike: next-up fallback @ 50¢", {"strike_type": "next_up_fallback", "entry_cap": 0.50})
    add("Strike: always two-up @ 20¢", {"strike_type": "two_up", "entry_cap": 0.20, "prob_lo": 0.05, "prob_hi": 0.40})
    add("Strike: smart select @ 50¢", {"strike_type": "smart_select", "entry_cap": 0.50})
    add("Strike: cheapest valid @ 50¢", {"strike_type": "cheapest_valid", "entry_cap": 0.50})

    # ════════════════════════════════════════════════════════════════
    # SWEEP 2: ENTRY CAP FOR NEXT-UP (7 experiments)
    # ════════════════════════════════════════════════════════════════
    add("NextUp cap: 15¢", {"entry_cap": 0.15})
    add("NextUp cap: 20¢", {"entry_cap": 0.20})
    add("NextUp cap: 25¢", {"entry_cap": 0.25})
    add("NextUp cap: 35¢", {"entry_cap": 0.35})
    add("NextUp cap: 40¢", {"entry_cap": 0.40})
    add("NextUp cap: 45¢", {"entry_cap": 0.45})
    add("NextUp cap: 50¢", {"entry_cap": 0.50})

    # ════════════════════════════════════════════════════════════════
    # SWEEP 3: TIME-BASED ENTRY CAPS (6 experiments)
    # Early hour (>35min left) contracts cost more, late hour cheaper
    # ════════════════════════════════════════════════════════════════
    add("TimeCap: early 45¢ / late 25¢", {"entry_cap": {"early": 0.45, "late": 0.25}})
    add("TimeCap: early 50¢ / late 30¢", {"entry_cap": {"early": 0.50, "late": 0.30}})
    add("TimeCap: early 40¢ / late 20¢", {"entry_cap": {"early": 0.40, "late": 0.20}})
    add("TimeCap: early 45¢ / late 30¢", {"entry_cap": {"early": 0.45, "late": 0.30}})
    add("TimeCap: early 50¢ / late 25¢", {"entry_cap": {"early": 0.50, "late": 0.25}})
    add("TimeCap: early 35¢ / late 20¢", {"entry_cap": {"early": 0.35, "late": 0.20}})

    # ════════════════════════════════════════════════════════════════
    # SWEEP 4: PROBABILITY BANDS FOR NEXT-UP (7 experiments)
    # ════════════════════════════════════════════════════════════════
    add("Prob: 10-50%", {"prob_lo": 0.10, "prob_hi": 0.50})
    add("Prob: 15-60%", {"prob_lo": 0.15, "prob_hi": 0.60})
    add("Prob: 20-60%", {"prob_lo": 0.20, "prob_hi": 0.60})
    add("Prob: 25-70%", {"prob_lo": 0.25, "prob_hi": 0.70})
    add("Prob: 30-70%", {"prob_lo": 0.30, "prob_hi": 0.70})
    add("Prob: 15-80%", {"prob_lo": 0.15, "prob_hi": 0.80})
    add("Prob: 10-90% (wide open)", {"prob_lo": 0.10, "prob_hi": 0.90})

    # ════════════════════════════════════════════════════════════════
    # SWEEP 5: POSITION SIZE (4 experiments)
    # ════════════════════════════════════════════════════════════════
    add("Size: $10", {"position_size": 10})
    add("Size: $15", {"position_size": 15})
    add("Size: $25", {"position_size": 25})
    add("Size: $30", {"position_size": 30})

    # ════════════════════════════════════════════════════════════════
    # SWEEP 6: TIME REMAINING FILTER (4 experiments)
    # ════════════════════════════════════════════════════════════════
    add("Time: >10m", {"min_time_remaining": 10})
    add("Time: >20m", {"min_time_remaining": 20})
    add("Time: >25m", {"min_time_remaining": 25})
    add("Time: >30m", {"min_time_remaining": 30})

    # ════════════════════════════════════════════════════════════════
    # SWEEP 7: EXIT LOGIC (2 experiments)
    # ════════════════════════════════════════════════════════════════
    add("Exit: hold to settlement", {"use_exit_logic": False})
    add("Exit: hold + 25¢ cap", {"use_exit_logic": False, "entry_cap": 0.25})

    # ════════════════════════════════════════════════════════════════
    # SWEEP 8: HOUR RETURN THRESHOLD (4 experiments)
    # ════════════════════════════════════════════════════════════════
    add("HrRet: 0.0% (disabled)", {"hour_return_threshold": 0.0})
    add("HrRet: 0.15%", {"hour_return_threshold": 0.15})
    add("HrRet: 0.5%", {"hour_return_threshold": 0.5})
    add("HrRet: 0.8%", {"hour_return_threshold": 0.8})

    # ════════════════════════════════════════════════════════════════
    # SWEEP 9: SMA LOOSENESS (3 experiments)
    # ════════════════════════════════════════════════════════════════
    add("SMA: strict (0)", {"sma_looseness": 0})
    add("SMA: very loose (0.3%)", {"sma_looseness": 0.003})
    add("SMA: disabled", {"sma_looseness": None})

    # ════════════════════════════════════════════════════════════════
    # COMBO EXPERIMENTS (14 combos)
    # ════════════════════════════════════════════════════════════════

    # Best-guess optimal: next-up with time-based cap
    add("COMBO: next-up + timecap 45/25 + prob 15-60", {
        "entry_cap": {"early": 0.45, "late": 0.25}, "prob_lo": 0.15, "prob_hi": 0.60})

    # Smart select with generous cap, wide prob
    add("COMBO: smart + 50¢ + prob 15-80", {
        "strike_type": "smart_select", "entry_cap": 0.50, "prob_lo": 0.15, "prob_hi": 0.80})

    # Next-up with relaxed filters for max volume
    add("COMBO: next-up 40¢ + no hr filter + loose SMA", {
        "entry_cap": 0.40, "hour_return_threshold": 0.0, "sma_looseness": 0.003})

    # Cheapest valid contract approach — bargain hunting
    add("COMBO: cheapest + 30¢ + prob 10-50", {
        "strike_type": "cheapest_valid", "entry_cap": 0.30, "prob_lo": 0.10, "prob_hi": 0.50})

    # Tight quality: only enter cheap and high-prob
    add("COMBO: next-up 25¢ + prob 25-70 + >20m", {
        "entry_cap": 0.25, "prob_lo": 0.25, "prob_hi": 0.70, "min_time_remaining": 20})

    # Large position on high-confidence plays
    add("COMBO: next-up 35¢ + $30 size + >20m", {
        "entry_cap": 0.35, "position_size": 30, "min_time_remaining": 20})

    # Fallback with time caps
    add("COMBO: fallback + timecap 50/30 + prob 15-75", {
        "strike_type": "next_up_fallback", "entry_cap": {"early": 0.50, "late": 0.30},
        "prob_lo": 0.15, "prob_hi": 0.75})

    # Two-up lottery with strict filters
    add("COMBO: two-up 15¢ + >25m + hr 0.5%", {
        "strike_type": "two_up", "entry_cap": 0.15,
        "prob_lo": 0.05, "prob_hi": 0.35,
        "min_time_remaining": 25, "hour_return_threshold": 0.5})

    # Smart select early hour only
    add("COMBO: smart + timecap 50/25 + >20m + prob 10-70", {
        "strike_type": "smart_select",
        "entry_cap": {"early": 0.50, "late": 0.25},
        "min_time_remaining": 20, "prob_lo": 0.10, "prob_hi": 0.70})

    # Hold-to-settlement with time-based caps
    add("COMBO: next-up hold + timecap 45/25", {
        "use_exit_logic": False, "entry_cap": {"early": 0.45, "late": 0.25}})

    # Maximum volume: wide open everything
    add("COMBO: next-up 50¢ + prob 10-90 + hr 0 + SMA off", {
        "entry_cap": 0.50, "prob_lo": 0.10, "prob_hi": 0.90,
        "hour_return_threshold": 0.0, "sma_looseness": None})

    # Next-up with slightly higher cap for early entry
    add("COMBO: next-up timecap 40/30 + prob 20-70 + $25", {
        "entry_cap": {"early": 0.40, "late": 0.30},
        "prob_lo": 0.20, "prob_hi": 0.70, "position_size": 25})

    # Conservative-aggressive hybrid: floor with high prob
    add("COMBO: floor 65¢ + prob 55-85 + hold + $15", {
        "strike_type": "floor", "entry_cap": 0.65,
        "prob_lo": 0.55, "prob_hi": 0.85, "use_exit_logic": False,
        "position_size": 15})

    # Cheapest valid + time tiers + large position
    add("COMBO: cheapest timecap 40/25 + prob 10-60 + $25", {
        "strike_type": "cheapest_valid",
        "entry_cap": {"early": 0.40, "late": 0.25},
        "prob_lo": 0.10, "prob_hi": 0.60, "position_size": 25})

    return experiments


# ──── Main ────

if __name__ == "__main__":
    NUM_PATHS = 10
    start_time = time.time()

    print("=" * 130)
    print("  REALISTIC ROBINHOOD PRICING — ENTRY CAP OPTIMIZATION EXPERIMENT")
    print(f"  Testing {len(build_experiments())} configurations × {NUM_PATHS} Monte Carlo paths (365 days each)")
    print("  Using RH-calibrated contract pricing model (not synthetic estimate_contract_price)")
    print("=" * 130)

    # Validate pricing model against known data points
    print("\n  Pricing model validation (BTC ~$67,850):")
    print(f"  {'Strike':<10} {'Dist':>6} {'25m RH':>8} {'45m RH':>8} {'25m Actual':>10} {'45m Actual':>10}")
    print(f"  {'─' * 54}")
    test_price = 67850
    test_vol = 1.5  # typical hourly vol
    for strike, actual_25, actual_45 in [
        (67750, 0.69, 0.71), (68000, 0.23, 0.44),
        (68250, 0.05, 0.17), (68500, 0.02, 0.04)]:
        model_25 = rh_contract_price(test_price, strike, test_vol, 25)
        model_45 = rh_contract_price(test_price, strike, test_vol, 45)
        dist = test_price - strike
        print(f"  ${strike:<9} {dist:>+5.0f}  {model_25:>7.2f}  {model_45:>7.2f}  "
              f"{actual_25:>9.2f}  {actual_45:>9.2f}")

    # Generate paths
    print(f"\n  Generating {NUM_PATHS} price paths...")
    all_paths = []
    for seed_idx in range(NUM_PATHS):
        candles = generate_realistic_btc_data(days=365, seed=seed_idx * 17 + 42)
        lo = min(c["low"] for c in candles)
        hi = max(c["high"] for c in candles)
        print(f"    Path {seed_idx+1}: seed={seed_idx*17+42}, "
              f"${candles[0]['open']:,.0f} -> ${candles[-1]['close']:,.0f} "
              f"(range ${lo:,.0f}-${hi:,.0f})")
        all_paths.append(candles)

    experiments = build_experiments()
    total_exp = len(experiments)
    print(f"\n  Running {total_exp} experiments × {NUM_PATHS} paths = {total_exp * NUM_PATHS} backtests...")

    # Run all experiments
    results = []
    for exp in experiments:
        path_results = []
        for candles in all_paths:
            r = run_variant(candles, exp["params"])
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
        avg_floor = sum(r["floor_used"] for r in path_results) / n
        avg_next = sum(r["next_up_used"] for r in path_results) / n
        avg_two = sum(r["two_up_used"] for r in path_results) / n
        avg_skip_exp = sum(r["skipped_expensive"] for r in path_results) / n
        avg_skip_prob = sum(r["skipped_prob"] for r in path_results) / n

        risk_adj = avg_pnl / avg_dd if avg_dd > 0 else (999 if avg_pnl > 0 else -999)

        results.append({
            "id": exp["id"], "name": exp["name"], "params": exp["params"],
            "avg_trades": avg_trades, "avg_wr": avg_wr, "avg_pnl": avg_pnl,
            "avg_dd": avg_dd, "avg_exp": avg_exp_val, "risk_adj": risk_adj,
            "worst_pnl": worst_pnl, "best_pnl": best_pnl, "profitable": profitable,
            "avg_early": avg_early, "avg_bank": avg_bank,
            "avg_floor": avg_floor, "avg_next": avg_next, "avg_two": avg_two,
            "avg_skip_exp": avg_skip_exp, "avg_skip_prob": avg_skip_prob,
        })

        if exp["id"] % 10 == 0:
            elapsed = time.time() - start_time
            print(f"    Completed {exp['id']}/{total_exp} experiments... ({elapsed:.1f}s)")

    elapsed = time.time() - start_time
    print(f"\n  All {total_exp} experiments complete in {elapsed:.1f}s")

    # ════════════════════════════════════════════════════════════════
    # RESULTS
    # ════════════════════════════════════════════════════════════════

    def cap_str(p):
        ec = p["entry_cap"]
        if isinstance(ec, dict):
            return f"e{ec['early']:.2f}/l{ec['late']:.2f}"
        return f"${ec:.2f}"

    def detail(v, rank, label=""):
        p = v["params"]
        ec = cap_str(p)
        sma = "OFF" if p["sma_looseness"] is None else (
            "strict" if p["sma_looseness"] == 0 else f"{p['sma_looseness']*100:.1f}%")

        print(f"\n  {'─' * 125}")
        print(f"  RANK #{rank} {label}")
        print(f"  {v['name']}")
        print(f"  {'─' * 125}")
        print(f"  Parameters:")
        print(f"    Strike: {p['strike_type']:<18}  Entry Cap: {ec:<18}  "
              f"Exit: {'Smart' if p['use_exit_logic'] else 'Hold':<6}  "
              f"Size: ${p['position_size']}")
        print(f"    Prob Range: {p['prob_lo']*100:.0f}-{p['prob_hi']*100:.0f}%          "
              f"HourRet: >{p['hour_return_threshold']}%         "
              f"SMA: {sma:<8}  Time: >{p['min_time_remaining']}m")
        print(f"  Results ({NUM_PATHS}-path average):")
        print(f"    Trades/Year: {v['avg_trades']:>6.0f}    Win Rate: {v['avg_wr']:>6.1f}%    "
              f"Expectancy: ${v['avg_exp']:>+6.2f}/trade")
        print(f"    Avg P&L:    ${v['avg_pnl']:>+9.2f}    Max DD:  ${v['avg_dd']:>8.2f}    "
              f"Risk-Adj: {v['risk_adj']:>6.2f}")
        print(f"    Best Path:  ${v['best_pnl']:>+9.2f}    Worst:   ${v['worst_pnl']:>+9.2f}    "
              f"Profitable: {v['profitable']}/{NUM_PATHS}")
        print(f"    Strike Usage: Floor={v['avg_floor']:.0f}  NextUp={v['avg_next']:.0f}  "
              f"TwoUp={v['avg_two']:.0f}  "
              f"Skip(expensive)={v['avg_skip_exp']:.0f}  Skip(prob)={v['avg_skip_prob']:.0f}")

    # ──── FULL RANKING ────
    by_pnl = sorted(results, key=lambda x: x["avg_pnl"], reverse=True)

    print(f"\n{'=' * 130}")
    print(f"  FULL RANKING BY AVERAGE P&L ({total_exp} experiments)")
    print(f"{'=' * 130}")
    print(f"  {'#':>3} {'Name':<52} {'P&L':>10} {'WR':>7} {'Trades':>7} "
          f"{'DD':>8} {'RiskAdj':>8} {'Prof':>6} {'Cap':>16}")
    print(f"  {'─' * 126}")
    for i, v in enumerate(by_pnl):
        marker = " <<<" if v["name"] == "BASELINE: next-up @ 30¢ cap" else ""
        p = v["params"]
        ec = cap_str(p)
        print(f"  {i+1:>3} {v['name']:<52} ${v['avg_pnl']:>+8.2f} {v['avg_wr']:>6.1f}% "
              f"{v['avg_trades']:>6.0f}  ${v['avg_dd']:>7.2f} {v['risk_adj']:>8.2f} "
              f"{v['profitable']:>3}/{NUM_PATHS} {ec:>16}{marker}")

    # ──── TOP 15 BY P&L ────
    print(f"\n{'=' * 130}")
    print(f"  TOP 15 BY AVERAGE P&L")
    print(f"{'=' * 130}")
    for i, v in enumerate(by_pnl[:15]):
        detail(v, i + 1)

    # ──── TOP 10 BY RISK-ADJUSTED ────
    by_risk = sorted(
        [v for v in results if v["avg_dd"] > 0 and v["avg_trades"] >= 10],
        key=lambda x: x["risk_adj"], reverse=True)

    print(f"\n{'=' * 130}")
    print(f"  TOP 10 BY RISK-ADJUSTED RETURN")
    print(f"{'=' * 130}")
    for i, v in enumerate(by_risk[:10]):
        detail(v, i + 1, "(risk-adjusted)")

    # ──── TOP 10 BY CONSISTENCY ────
    by_consist = sorted(results, key=lambda x: (x["profitable"], x["avg_pnl"]), reverse=True)

    print(f"\n{'=' * 130}")
    print(f"  TOP 10 BY CONSISTENCY")
    print(f"{'=' * 130}")
    for i, v in enumerate(by_consist[:10]):
        detail(v, i + 1, "(consistent)")

    # ──── PARAMETER SENSITIVITY ────
    print(f"\n{'=' * 130}")
    print(f"  PARAMETER SENSITIVITY ANALYSIS")
    print(f"{'=' * 130}")

    # Entry cap sensitivity (next-up only)
    print(f"\n  ENTRY CAP IMPACT (next-up strike):")
    print(f"  {'Config':<25} {'P&L':>10} {'WR':>7} {'Trades':>8} {'DD':>8} {'Skip$':>7}")
    print(f"  {'─' * 67}")
    cap_exps = [v for v in results if v["name"].startswith("NextUp cap:") or "BASELINE" in v["name"]]
    cap_exps.sort(key=lambda x: x["avg_pnl"], reverse=True)
    for v in cap_exps:
        print(f"  {v['name']:<25} ${v['avg_pnl']:>+8.2f} {v['avg_wr']:>6.1f}% "
              f"{v['avg_trades']:>7.0f} ${v['avg_dd']:>7.2f} {v['avg_skip_exp']:>6.0f}")

    # Time-based cap sensitivity
    print(f"\n  TIME-BASED CAP IMPACT:")
    print(f"  {'Config':<35} {'P&L':>10} {'WR':>7} {'Trades':>8} {'DD':>8}")
    print(f"  {'─' * 72}")
    time_exps = [v for v in results if v["name"].startswith("TimeCap:")]
    time_exps.sort(key=lambda x: x["avg_pnl"], reverse=True)
    for v in time_exps:
        print(f"  {v['name']:<35} ${v['avg_pnl']:>+8.2f} {v['avg_wr']:>6.1f}% "
              f"{v['avg_trades']:>7.0f} ${v['avg_dd']:>7.2f}")

    # Strike type sensitivity
    print(f"\n  STRIKE SELECTION IMPACT:")
    print(f"  {'Config':<35} {'P&L':>10} {'WR':>7} {'Trades':>8} {'Floor':>7} {'Next':>7} {'TwoUp':>7}")
    print(f"  {'─' * 85}")
    strike_exps = [v for v in results if v["name"].startswith("Strike:") or "BASELINE" in v["name"]]
    strike_exps.sort(key=lambda x: x["avg_pnl"], reverse=True)
    for v in strike_exps:
        print(f"  {v['name']:<35} ${v['avg_pnl']:>+8.2f} {v['avg_wr']:>6.1f}% "
              f"{v['avg_trades']:>7.0f} {v['avg_floor']:>7.0f} {v['avg_next']:>7.0f} {v['avg_two']:>7.0f}")

    # Probability band sensitivity
    print(f"\n  PROBABILITY BAND IMPACT:")
    print(f"  {'Config':<25} {'P&L':>10} {'WR':>7} {'Trades':>8} {'DD':>8}")
    print(f"  {'─' * 60}")
    prob_exps = [v for v in results if v["name"].startswith("Prob:") or "BASELINE" in v["name"]]
    prob_exps.sort(key=lambda x: x["avg_pnl"], reverse=True)
    for v in prob_exps:
        print(f"  {v['name']:<25} ${v['avg_pnl']:>+8.2f} {v['avg_wr']:>6.1f}% "
              f"{v['avg_trades']:>7.0f} ${v['avg_dd']:>7.2f}")

    # ──── FINAL RECOMMENDATION ────
    baseline = next(v for v in results if "BASELINE" in v["name"])
    best = by_pnl[0]
    best_risk = by_risk[0] if by_risk else by_pnl[0]
    best_consist = by_consist[0]

    print(f"\n{'=' * 130}")
    print(f"  FINAL RECOMMENDATION")
    print(f"{'=' * 130}")

    detail(baseline, 0, "── BASELINE ──")
    detail(best, 1, "── BEST BY P&L ──")
    if best_risk["id"] != best["id"]:
        detail(best_risk, 2, "── BEST RISK-ADJUSTED ──")
    if best_consist["id"] != best["id"] and best_consist["id"] != best_risk["id"]:
        detail(best_consist, 3, "── MOST CONSISTENT ──")

    pnl_delta = best["avg_pnl"] - baseline["avg_pnl"]
    print(f"\n  Best vs Baseline: P&L {'+' if pnl_delta >= 0 else ''}{pnl_delta:.2f}/year, "
          f"WR {best['avg_wr'] - baseline['avg_wr']:+.1f}pp, "
          f"Trades {best['avg_trades'] - baseline['avg_trades']:+.0f}/year")

    print(f"\n  Total runtime: {time.time() - start_time:.1f}s")
    print()
