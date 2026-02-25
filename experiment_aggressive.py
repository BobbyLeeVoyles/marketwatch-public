#!/usr/bin/env python3
"""
Large-scale aggressive strategy experiment.
Tests 75+ parameter combinations across 10 Monte Carlo price paths (365 days each).
Ranks by total P&L, risk-adjusted return, win rate, and consistency.

Parameters swept:
  1. Momentum threshold: disabled, 0.0, 0.25, 0.5, 1.0, 1.5
  2. Hour return threshold: 0.0, 0.15, 0.3, 0.5, 0.8
  3. SMA looseness: strict, loose (0.1%), very loose (0.3%), disabled
  4. Strike type: ATM, OTM
  5. Min strike distance: 0, 50, 100, 150
  6. Entry price: 0.35, 0.40, 0.50, 0.60
  7. Exit logic: hold-to-settlement, smart exit
  8. Volatility filter: none, 0.5-3, 0.3-4
  9. Price position filter: none, >40, >50
  10. Position size: 15, 20, 25
  11. Min time remaining: 10, 15, 20, 25 minutes
  12. Probability bounds: (0.25-0.80), (0.30-0.75), (0.35-0.70)
"""

import random
import math
import time
from datetime import datetime, timezone
from itertools import product

# ──── Data Generation (identical to existing backtest infra) ────

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

def calc_price_position(candle):
    rng = candle["high"] - candle["low"]
    if rng == 0: return 50
    return ((candle["close"] - candle["low"]) / rng) * 100

def calc_momentum_3h(candles, current_price):
    if len(candles) < 3: return 0
    three_ago = candles[-3]["close"]
    if three_ago == 0: return 0
    return ((current_price - three_ago) / three_ago) * 100

def calc_hour_return(candle, current_price):
    if candle["open"] == 0: return 0
    return ((current_price - candle["open"]) / candle["open"]) * 100


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

def calc_risk_of_ruin(current_price, strike, volatility, minutes_remaining):
    distance = current_price - strike
    time_hours = minutes_remaining / 60
    expected_move = current_price * (volatility / 100) * math.sqrt(max(time_hours, 0.01))
    z = distance / expected_move if expected_move > 0 else 0
    if z <= -2: return 0.98
    elif z <= -1: return 0.84
    elif z <= -0.5: return 0.69
    elif z <= 0: return 0.5
    elif z <= 0.5: return 0.31
    elif z <= 1: return 0.16
    elif z <= 1.5: return 0.07
    elif z <= 2: return 0.02
    else: return 0.01

def estimate_contract_price(distance_from_strike, minutes_remaining):
    if distance_from_strike <= 0: return 0.30
    base = min(0.95, 0.5 + distance_from_strike / 1000)
    time_mult = 1 + (60 - minutes_remaining) / 120
    return min(0.99, base * time_mult)

def estimate_fair_value(price, strike, vol, mins_remaining):
    """Estimate probability BTC stays above strike (simplified Black-Scholes-ish)."""
    if vol <= 0 or mins_remaining <= 0:
        return 1.0 if price > strike else 0.0
    distance = price - strike
    time_hours = mins_remaining / 60
    expected_move = price * (vol / 100) * math.sqrt(max(time_hours, 0.01))
    z = distance / expected_move if expected_move > 0 else 0
    # Approximate normal CDF
    if z <= -3: return 0.001
    elif z <= -2: return 0.02
    elif z <= -1: return 0.16
    elif z <= -0.5: return 0.31
    elif z <= 0: return 0.50
    elif z <= 0.5: return 0.69
    elif z <= 1: return 0.84
    elif z <= 1.5: return 0.93
    elif z <= 2: return 0.98
    else: return 0.99


# ──── Parameterized Signal Check ────

def check_signal(candles, current_price, hour_utc, minute, params):
    """Fully parameterized aggressive signal check."""
    # Market hours
    if not (14 <= hour_utc < 21):
        return {"signal": False}

    # Time remaining
    mins_remaining = 60 - minute
    if mins_remaining <= params["min_time_remaining"]:
        return {"signal": False}

    sma3 = calc_sma(candles, 3)
    sma6 = calc_sma(candles, 6)
    sma12 = calc_sma(candles, 12)
    if 0 in (sma3, sma6, sma12):
        return {"signal": False}

    mom = calc_momentum_3h(candles, current_price)
    hr = calc_hour_return(candles[-1], current_price)
    vol = calc_volatility(candles[-1])
    pos = calc_price_position(candles[-1])

    # SMA trend check with configurable looseness
    sma_loose = params["sma_looseness"]
    if sma_loose is None:
        # SMA disabled entirely
        short_trend = True
        medium_trend = True
    elif sma_loose == 0:
        # Strict: sma3 > sma6, sma6 > sma12
        short_trend = sma3 > sma6
        medium_trend = sma6 > sma12
    else:
        # Loose: allow small deviation
        short_trend = sma3 > sma6 or (sma6 > 0 and (sma6 - sma3) / sma6 < sma_loose)
        medium_trend = sma6 > sma12 or (sma12 > 0 and (sma12 - sma6) / sma12 < sma_loose)

    if not short_trend or not medium_trend:
        return {"signal": False}

    # Momentum gate
    mom_thresh = params["momentum_threshold"]
    if mom_thresh is not None:
        if mom <= mom_thresh:
            return {"signal": False}

    # Hour return gate
    if hr <= params["hour_return_threshold"]:
        return {"signal": False}

    # Volatility filter
    vf = params["vol_filter"]
    if vf == "0.5-3":
        if not (0.5 <= vol <= 3.0):
            return {"signal": False}
    elif vf == "0.3-4":
        if not (0.3 <= vol <= 4.0):
            return {"signal": False}

    # Price position filter
    pf = params["pos_filter"]
    if pf == ">40":
        if pos <= 40:
            return {"signal": False}
    elif pf == ">50":
        if pos <= 50:
            return {"signal": False}

    # Strike
    strike = calc_strike(current_price, params["strike_type"])

    # Strike distance check
    strike_dist = current_price - strike
    if strike_dist < params["min_strike_distance"]:
        return {"signal": False}

    # Probability / fair value check
    fv = estimate_fair_value(current_price, strike, vol, mins_remaining)
    prob_lo, prob_hi = params["prob_range"]
    if not (prob_lo <= fv <= prob_hi):
        return {"signal": False}

    entry_price = params["entry_price"]
    position_size = params["position_size"]
    contracts = math.floor(position_size / entry_price)

    return {
        "signal": True,
        "strike": strike,
        "entry_price": entry_price,
        "contracts": contracts,
        "fair_value": fv,
        "volatility": vol,
    }


# ──── Trade Simulation ────

def simulate_trade(entry_price, strike, contracts, candles_after, volatility, use_exit_logic):
    if not candles_after:
        return {"outcome": "no_data", "pnl": 0}

    settlement_candle = candles_after[0]
    settlement_price = settlement_candle["close"]

    if not use_exit_logic:
        if settlement_price > strike:
            pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
            return {"outcome": "win", "pnl": pnl}
        else:
            pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
            return {"outcome": "loss", "pnl": pnl}
    else:
        mid_price = (settlement_candle["open"] + settlement_candle["close"]) / 2
        distance_mid = mid_price - strike
        ror = calc_risk_of_ruin(mid_price, strike, volatility, 30)
        implied_price = estimate_contract_price(distance_mid, 30)

        early_exit_pnl = calc_net_pnl(contracts, entry_price, implied_price, "early")
        settle_win_pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
        settle_lose_pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
        settle_ev = (1 - ror) * settle_win_pnl + ror * settle_lose_pnl

        if ror >= 0.5:
            return {"outcome": "early_exit", "pnl": early_exit_pnl}
        if settle_ev < early_exit_pnl and early_exit_pnl > 0:
            return {"outcome": "early_exit", "pnl": early_exit_pnl}

        late_price = settlement_candle["close"]
        late_ror = calc_risk_of_ruin(late_price, strike, volatility, 10)
        if late_ror >= 0.3:
            late_implied = estimate_contract_price(late_price - strike, 10)
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


# ──── Single Variant Backtest ────

def run_variant(candles, params):
    trades = 0
    wins = 0
    losses = 0
    early_exits = 0
    total_pnl = 0.0
    max_dd = 0.0
    peak_pnl = 0.0
    bankroll = 100.0
    peak_bank = 100.0

    for i in range(12, len(candles) - 1):
        candle = candles[i]
        dt = datetime.fromtimestamp(candle["open_time"] / 1000, tz=timezone.utc)
        hour_utc = dt.hour
        minute = dt.minute
        current_price = candle["close"]
        history = candles[max(0, i - 12):i + 1]
        vol = calc_volatility(candle)

        # Simulate random minute within the hour for time-remaining check
        # Use a fixed minute=30 to be consistent (middle of hour)
        sig = check_signal(history, current_price, hour_utc, 30, params)

        if sig["signal"]:
            result = simulate_trade(
                sig["entry_price"], sig["strike"], sig["contracts"],
                candles[i + 1:i + 3], vol, params["use_exit_logic"]
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
            if bankroll > peak_bank:
                peak_bank = bankroll

    wr = (wins / trades * 100) if trades > 0 else 0
    expectancy = (total_pnl / trades) if trades > 0 else 0
    win_pnls = []
    loss_pnls = []

    return {
        "trades": trades, "wins": wins, "losses": losses,
        "win_rate": wr, "total_pnl": total_pnl,
        "max_dd": max_dd, "expectancy": expectancy,
        "early_exits": early_exits,
        "final_bankroll": bankroll,
    }


# ──── Experiment Definitions ────

def build_experiments():
    """Build 75+ targeted experiments covering all tunable dimensions."""
    experiments = []
    exp_id = 0

    # Baseline: current deployed config (momentum removed)
    base = {
        "strike_type": "ATM",
        "entry_price": 0.40,
        "use_exit_logic": True,
        "momentum_threshold": None,  # DISABLED (current live)
        "hour_return_threshold": 0.3,
        "position_size": 20,
        "vol_filter": "none",
        "pos_filter": "none",
        "sma_looseness": 0.001,
        "min_strike_distance": 50,
        "min_time_remaining": 15,
        "prob_range": (0.35, 0.70),
    }

    def add(name, overrides):
        nonlocal exp_id
        exp_id += 1
        p = dict(base)
        p.update(overrides)
        experiments.append({"id": exp_id, "name": name, "params": p})

    add("BASELINE (current deployed)", {})

    # ──── SWEEP 1: Momentum threshold (6 experiments) ────
    add("Mom: 0.0% (any positive)", {"momentum_threshold": 0.0})
    add("Mom: 0.25%", {"momentum_threshold": 0.25})
    add("Mom: 0.5%", {"momentum_threshold": 0.5})
    add("Mom: 1.0%", {"momentum_threshold": 1.0})
    add("Mom: 1.5%", {"momentum_threshold": 1.5})
    add("Mom: 2.0%", {"momentum_threshold": 2.0})

    # ──── SWEEP 2: Hour return threshold (5 experiments) ────
    add("HrRet: 0.0% (disabled)", {"hour_return_threshold": 0.0})
    add("HrRet: 0.15%", {"hour_return_threshold": 0.15})
    add("HrRet: 0.5%", {"hour_return_threshold": 0.5})
    add("HrRet: 0.8%", {"hour_return_threshold": 0.8})
    add("HrRet: 1.0%", {"hour_return_threshold": 1.0})

    # ──── SWEEP 3: SMA looseness (4 experiments) ────
    add("SMA: strict (0.0)", {"sma_looseness": 0})
    add("SMA: very loose (0.3%)", {"sma_looseness": 0.003})
    add("SMA: ultra loose (0.5%)", {"sma_looseness": 0.005})
    add("SMA: disabled", {"sma_looseness": None})

    # ──── SWEEP 4: Strike type + distance (6 experiments) ────
    add("Strike: OTM", {"strike_type": "OTM"})
    add("Strike: ATM dist=0", {"min_strike_distance": 0})
    add("Strike: ATM dist=25", {"min_strike_distance": 25})
    add("Strike: ATM dist=100", {"min_strike_distance": 100})
    add("Strike: ATM dist=150", {"min_strike_distance": 150})
    add("Strike: OTM dist=100", {"strike_type": "OTM", "min_strike_distance": 100})

    # ──── SWEEP 5: Entry price (5 experiments) ────
    add("Entry: $0.30", {"entry_price": 0.30})
    add("Entry: $0.35", {"entry_price": 0.35})
    add("Entry: $0.50", {"entry_price": 0.50})
    add("Entry: $0.60", {"entry_price": 0.60})
    add("Entry: $0.75", {"entry_price": 0.75})

    # ──── SWEEP 6: Position size (4 experiments) ────
    add("Size: $10", {"position_size": 10})
    add("Size: $15", {"position_size": 15})
    add("Size: $25", {"position_size": 25})
    add("Size: $30", {"position_size": 30})

    # ──── SWEEP 7: Exit logic (1 experiment) ────
    add("Exit: hold to settlement", {"use_exit_logic": False})

    # ──── SWEEP 8: Volatility filter (3 experiments) ────
    add("Vol: 0.5-3%", {"vol_filter": "0.5-3"})
    add("Vol: 0.3-4%", {"vol_filter": "0.3-4"})

    # ──── SWEEP 9: Price position filter (3 experiments) ────
    add("PosFilter: >40%", {"pos_filter": ">40"})
    add("PosFilter: >50%", {"pos_filter": ">50"})

    # ──── SWEEP 10: Time remaining (3 experiments) ────
    add("Time: >10m", {"min_time_remaining": 10})
    add("Time: >20m", {"min_time_remaining": 20})
    add("Time: >25m", {"min_time_remaining": 25})

    # ──── SWEEP 11: Probability bounds (3 experiments) ────
    add("Prob: 25-80%", {"prob_range": (0.25, 0.80)})
    add("Prob: 30-75%", {"prob_range": (0.30, 0.75)})
    add("Prob: 40-65%", {"prob_range": (0.40, 0.65)})

    # ──── COMBO EXPERIMENTS: Test promising multi-parameter combos ────

    # Combo 1: Remove momentum + lower hour return = max volume
    add("COMBO: no mom + HrRet 0.15%", {
        "momentum_threshold": None, "hour_return_threshold": 0.15})

    # Combo 2: Remove momentum + vol filter for quality
    add("COMBO: no mom + vol 0.5-3%", {
        "momentum_threshold": None, "vol_filter": "0.5-3"})

    # Combo 3: Loose SMA + no momentum = max opportunity
    add("COMBO: loose SMA + no mom + HrRet 0%", {
        "sma_looseness": 0.003, "momentum_threshold": None, "hour_return_threshold": 0.0})

    # Combo 4: Tight filters for high quality
    add("COMBO: strict SMA + mom 1% + HrRet 0.5%", {
        "sma_looseness": 0, "momentum_threshold": 1.0, "hour_return_threshold": 0.5})

    # Combo 5: OTM + lower entry price
    add("COMBO: OTM + entry $0.35", {
        "strike_type": "OTM", "entry_price": 0.35})

    # Combo 6: Higher position + smart exit
    add("COMBO: $25 size + smart exit", {
        "position_size": 25, "use_exit_logic": True})

    # Combo 7: Conservative-aggressive hybrid (wider prob, vol filter)
    add("COMBO: wide prob + vol filter", {
        "prob_range": (0.25, 0.80), "vol_filter": "0.5-3"})

    # Combo 8: Max relaxed (everything loose)
    add("COMBO: all loose (no mom, 0% hr, loose SMA)", {
        "momentum_threshold": None, "hour_return_threshold": 0.0,
        "sma_looseness": 0.003, "min_strike_distance": 25})

    # Combo 9: All tight (strict everything)
    add("COMBO: all tight (mom 1.5%, hr 0.8%, strict SMA, vol)", {
        "momentum_threshold": 1.5, "hour_return_threshold": 0.8,
        "sma_looseness": 0, "vol_filter": "0.5-3", "pos_filter": ">50"})

    # Combo 10: Optimal momentum + loose entry
    add("COMBO: mom 0.5% + entry $0.35", {
        "momentum_threshold": 0.5, "entry_price": 0.35})

    # Combo 11: No filters at all (just market hours + SMA)
    add("COMBO: minimal filters", {
        "momentum_threshold": None, "hour_return_threshold": 0.0,
        "vol_filter": "none", "pos_filter": "none",
        "min_strike_distance": 0, "prob_range": (0.10, 0.90)})

    # Combo 12: Smart exit + vol filter + pos filter
    add("COMBO: smart exit + vol + pos filter", {
        "use_exit_logic": True, "vol_filter": "0.5-3", "pos_filter": ">40"})

    # Combo 13: OTM + smart exit + larger size
    add("COMBO: OTM + smart exit + $25", {
        "strike_type": "OTM", "use_exit_logic": True, "position_size": 25})

    # Combo 14: Low entry + high volume approach
    add("COMBO: $0.30 entry + no mom + loose", {
        "entry_price": 0.30, "momentum_threshold": None,
        "hour_return_threshold": 0.15, "sma_looseness": 0.003})

    # Combo 15: Time-sensitive tight filter
    add("COMBO: >20m + mom 0.5% + vol", {
        "min_time_remaining": 20, "momentum_threshold": 0.5, "vol_filter": "0.5-3"})

    # Combo 16: High-confidence only
    add("COMBO: prob 40-65% + mom 1% + strict SMA", {
        "prob_range": (0.40, 0.65), "momentum_threshold": 1.0, "sma_looseness": 0})

    # Combo 17: Balanced approach
    add("COMBO: balanced (mom 0.25%, hr 0.15%, loose SMA)", {
        "momentum_threshold": 0.25, "hour_return_threshold": 0.15, "sma_looseness": 0.001})

    # Combo 18: Entry price sensitivity with OTM
    add("COMBO: OTM + $0.30 entry + no mom", {
        "strike_type": "OTM", "entry_price": 0.30, "momentum_threshold": None})

    # Combo 19: Max risk-adjusted (conservative filters + smart exit)
    add("COMBO: risk-adj (exit + vol + >20m + mom 0.5%)", {
        "use_exit_logic": True, "vol_filter": "0.5-3",
        "min_time_remaining": 20, "momentum_threshold": 0.5})

    # Combo 20: No mom + position filter + wider prob
    add("COMBO: no mom + pos>40 + prob 25-80%", {
        "momentum_threshold": None, "pos_filter": ">40", "prob_range": (0.25, 0.80)})

    # Combo 21: SMA disabled + momentum gated
    add("COMBO: no SMA + mom 1.0% + hr 0.5%", {
        "sma_looseness": None, "momentum_threshold": 1.0, "hour_return_threshold": 0.5})

    # Combo 22: ATM + higher entry + hold
    add("COMBO: ATM + $0.60 entry + hold", {
        "entry_price": 0.60, "use_exit_logic": False})

    # Combo 23: Everything moderate
    add("COMBO: moderate all (mom 0.25, hr 0.15, dist 25, prob 30-75)", {
        "momentum_threshold": 0.25, "hour_return_threshold": 0.15,
        "min_strike_distance": 25, "prob_range": (0.30, 0.75)})

    return experiments


# ──── Main ────

if __name__ == "__main__":
    NUM_PATHS = 10
    start_time = time.time()

    print("=" * 120)
    print("  LARGE-SCALE AGGRESSIVE STRATEGY EXPERIMENT")
    print(f"  Testing parameter combinations across {NUM_PATHS} Monte Carlo price paths (365 days each)")
    print("=" * 120)

    # Generate price paths
    print("\n  Generating price paths...")
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
    print(f"\n  Running {total_exp} experiments x {NUM_PATHS} paths = {total_exp * NUM_PATHS} backtests...")
    print()

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
        avg_exp = sum(r["expectancy"] for r in path_results) / n
        worst_pnl = min(r["total_pnl"] for r in path_results)
        best_pnl = max(r["total_pnl"] for r in path_results)
        profitable = sum(1 for r in path_results if r["total_pnl"] > 0)
        avg_early = sum(r["early_exits"] for r in path_results) / n
        avg_bank = sum(r["final_bankroll"] for r in path_results) / n

        risk_adj = avg_pnl / avg_dd if avg_dd > 0 else (999 if avg_pnl > 0 else -999)

        results.append({
            "id": exp["id"],
            "name": exp["name"],
            "params": exp["params"],
            "avg_trades": avg_trades,
            "avg_wr": avg_wr,
            "avg_pnl": avg_pnl,
            "avg_dd": avg_dd,
            "avg_exp": avg_exp,
            "worst_pnl": worst_pnl,
            "best_pnl": best_pnl,
            "profitable": profitable,
            "avg_early": avg_early,
            "risk_adj": risk_adj,
            "avg_bank": avg_bank,
        })

        if exp["id"] % 10 == 0:
            print(f"    Completed {exp['id']}/{total_exp} experiments...")

    elapsed = time.time() - start_time
    print(f"\n  All {total_exp} experiments complete in {elapsed:.1f}s")

    # ════════════════════════════════════════════════════════════════
    # RESULTS
    # ════════════════════════════════════════════════════════════════

    def fmt(v):
        """Format a result row."""
        p = v["params"]
        mom = "OFF" if p["momentum_threshold"] is None else f"{p['momentum_threshold']}%"
        sma = "OFF" if p["sma_looseness"] is None else f"{p['sma_looseness']}"
        return (f"  #{v['id']:<3} {v['name']:<50} "
                f"Trades:{v['avg_trades']:>5.0f}  WR:{v['avg_wr']:>5.1f}%  "
                f"P&L:${v['avg_pnl']:>+9.2f}  DD:${v['avg_dd']:>7.2f}  "
                f"Exp:${v['avg_exp']:>+5.2f}  "
                f"RiskAdj:{v['risk_adj']:>6.2f}  "
                f"Prof:{v['profitable']}/{NUM_PATHS}")

    def detail(v, rank, label=""):
        p = v["params"]
        mom = "DISABLED" if p["momentum_threshold"] is None else f">{p['momentum_threshold']}%"
        sma = "DISABLED" if p["sma_looseness"] is None else (
            "strict" if p["sma_looseness"] == 0 else f"loose({p['sma_looseness']*100:.1f}%)")
        prob_lo, prob_hi = p["prob_range"]

        print(f"\n  {'─' * 115}")
        print(f"  RANK #{rank} {label}")
        print(f"  {v['name']}")
        print(f"  {'─' * 115}")
        print(f"  Parameters:")
        print(f"    Strike: {p['strike_type']:<6}  Entry: ${p['entry_price']:<6}  "
              f"Exit: {'Smart' if p['use_exit_logic'] else 'Hold':<6}  "
              f"Size: ${p['position_size']}")
        print(f"    Momentum: {mom:<10}  HourRet: >{p['hour_return_threshold']}%  "
              f"SMA: {sma}  MinDist: ${p['min_strike_distance']}")
        print(f"    Vol Filter: {p['vol_filter']:<8}  Pos Filter: {p['pos_filter']:<6}  "
              f"Time: >{p['min_time_remaining']}m  Prob: {prob_lo*100:.0f}-{prob_hi*100:.0f}%")
        print(f"  Results ({NUM_PATHS}-path average):")
        print(f"    Trades/Year: {v['avg_trades']:>6.0f}    Win Rate: {v['avg_wr']:>6.1f}%    "
              f"Expectancy: ${v['avg_exp']:>+6.2f}/trade")
        print(f"    Avg P&L:    ${v['avg_pnl']:>+9.2f}    Max DD:  ${v['avg_dd']:>8.2f}    "
              f"Risk-Adj: {v['risk_adj']:>6.2f}")
        print(f"    Best Path:  ${v['best_pnl']:>+9.2f}    Worst:   ${v['worst_pnl']:>+9.2f}    "
              f"Profitable: {v['profitable']}/{NUM_PATHS}")
        print(f"    Avg Final Bankroll: ${v['avg_bank']:>9.2f}    Early Exits: {v['avg_early']:>4.0f}")

    # ──── FULL RANKING TABLE ────
    by_pnl = sorted(results, key=lambda x: x["avg_pnl"], reverse=True)

    print(f"\n{'=' * 120}")
    print(f"  FULL RANKING BY AVERAGE P&L (all {total_exp} experiments)")
    print(f"{'=' * 120}")
    for i, v in enumerate(by_pnl):
        marker = " <<<" if v["name"] == "BASELINE (current deployed)" else ""
        print(f"  {i+1:>3}. {v['name']:<52} "
              f"P&L:${v['avg_pnl']:>+9.2f}  WR:{v['avg_wr']:>5.1f}%  "
              f"Trades:{v['avg_trades']:>5.0f}  DD:${v['avg_dd']:>7.2f}  "
              f"RiskAdj:{v['risk_adj']:>6.2f}  "
              f"Prof:{v['profitable']}/{NUM_PATHS}{marker}")

    # ──── TOP 15 BY P&L (detailed) ────
    print(f"\n{'=' * 120}")
    print(f"  TOP 15 EXPERIMENTS BY AVERAGE P&L")
    print(f"{'=' * 120}")
    for i, v in enumerate(by_pnl[:15]):
        detail(v, i + 1)

    # ──── TOP 10 BY RISK-ADJUSTED RETURN ────
    by_risk = sorted(
        [v for v in results if v["avg_dd"] > 0 and v["avg_trades"] >= 10],
        key=lambda x: x["risk_adj"], reverse=True)

    print(f"\n{'=' * 120}")
    print(f"  TOP 10 BY RISK-ADJUSTED RETURN (P&L / Max Drawdown)")
    print(f"{'=' * 120}")
    for i, v in enumerate(by_risk[:10]):
        detail(v, i + 1, "(risk-adjusted)")

    # ──── TOP 10 BY WIN RATE (min 20 trades) ────
    by_wr = sorted(
        [v for v in results if v["avg_trades"] >= 20],
        key=lambda x: x["avg_wr"], reverse=True)

    print(f"\n{'=' * 120}")
    print(f"  TOP 10 BY WIN RATE (min 20 avg trades/year)")
    print(f"{'=' * 120}")
    for i, v in enumerate(by_wr[:10]):
        detail(v, i + 1, "(win-rate)")

    # ──── TOP 10 BY CONSISTENCY ────
    by_consist = sorted(
        results,
        key=lambda x: (x["profitable"], x["avg_pnl"]),
        reverse=True)

    print(f"\n{'=' * 120}")
    print(f"  TOP 10 BY CONSISTENCY (most profitable paths, then P&L)")
    print(f"{'=' * 120}")
    for i, v in enumerate(by_consist[:10]):
        detail(v, i + 1, "(consistent)")

    # ──── BASELINE vs BEST COMPARISON ────
    baseline = next(v for v in results if "BASELINE" in v["name"])
    best = by_pnl[0]
    best_risk = by_risk[0] if by_risk else by_pnl[0]

    print(f"\n{'=' * 120}")
    print(f"  BASELINE vs BEST COMPARISON")
    print(f"{'=' * 120}")
    detail(baseline, 0, "CURRENT BASELINE")
    detail(best, 1, "BEST BY P&L")
    detail(best_risk, 2, "BEST RISK-ADJUSTED")

    # ──── PARAMETER INSIGHTS ────
    print(f"\n{'=' * 120}")
    print(f"  PARAMETER SENSITIVITY ANALYSIS")
    print(f"{'=' * 120}")

    # Momentum sensitivity
    print(f"\n  MOMENTUM THRESHOLD IMPACT:")
    print(f"  {'Threshold':<20} {'Avg P&L':>10} {'Avg WR':>8} {'Avg Trades':>12}")
    print(f"  {'─' * 52}")
    mom_exps = [v for v in results if v["name"].startswith("Mom:") or "BASELINE" in v["name"]]
    mom_exps.sort(key=lambda x: x["avg_pnl"], reverse=True)
    for v in mom_exps:
        print(f"  {v['name']:<20} ${v['avg_pnl']:>+9.2f} {v['avg_wr']:>7.1f}% {v['avg_trades']:>11.0f}")

    # Hour return sensitivity
    print(f"\n  HOUR RETURN THRESHOLD IMPACT:")
    print(f"  {'Threshold':<20} {'Avg P&L':>10} {'Avg WR':>8} {'Avg Trades':>12}")
    print(f"  {'─' * 52}")
    hr_exps = [v for v in results if v["name"].startswith("HrRet:") or "BASELINE" in v["name"]]
    hr_exps.sort(key=lambda x: x["avg_pnl"], reverse=True)
    for v in hr_exps:
        print(f"  {v['name']:<20} ${v['avg_pnl']:>+9.2f} {v['avg_wr']:>7.1f}% {v['avg_trades']:>11.0f}")

    # SMA sensitivity
    print(f"\n  SMA LOOSENESS IMPACT:")
    print(f"  {'Config':<20} {'Avg P&L':>10} {'Avg WR':>8} {'Avg Trades':>12}")
    print(f"  {'─' * 52}")
    sma_exps = [v for v in results if v["name"].startswith("SMA:") or "BASELINE" in v["name"]]
    sma_exps.sort(key=lambda x: x["avg_pnl"], reverse=True)
    for v in sma_exps:
        print(f"  {v['name']:<20} ${v['avg_pnl']:>+9.2f} {v['avg_wr']:>7.1f}% {v['avg_trades']:>11.0f}")

    # Entry price sensitivity
    print(f"\n  ENTRY PRICE IMPACT:")
    print(f"  {'Config':<20} {'Avg P&L':>10} {'Avg WR':>8} {'Avg Trades':>12}")
    print(f"  {'─' * 52}")
    entry_exps = [v for v in results if v["name"].startswith("Entry:") or "BASELINE" in v["name"]]
    entry_exps.sort(key=lambda x: x["avg_pnl"], reverse=True)
    for v in entry_exps:
        print(f"  {v['name']:<20} ${v['avg_pnl']:>+9.2f} {v['avg_wr']:>7.1f}% {v['avg_trades']:>11.0f}")

    # Strike sensitivity
    print(f"\n  STRIKE TYPE/DISTANCE IMPACT:")
    print(f"  {'Config':<25} {'Avg P&L':>10} {'Avg WR':>8} {'Avg Trades':>12}")
    print(f"  {'─' * 57}")
    strike_exps = [v for v in results if v["name"].startswith("Strike:") or "BASELINE" in v["name"]]
    strike_exps.sort(key=lambda x: x["avg_pnl"], reverse=True)
    for v in strike_exps:
        print(f"  {v['name']:<25} ${v['avg_pnl']:>+9.2f} {v['avg_wr']:>7.1f}% {v['avg_trades']:>11.0f}")

    # ──── FINAL RECOMMENDATION ────
    print(f"\n{'=' * 120}")
    print(f"  FINAL RECOMMENDATION")
    print(f"{'=' * 120}")

    bp = best["params"]
    brp = best_risk["params"]

    print(f"\n  Best by raw P&L: Experiment #{best['id']} - {best['name']}")
    print(f"    Avg P&L: ${best['avg_pnl']:>+.2f}/year  |  WR: {best['avg_wr']:.1f}%  |  "
          f"Trades: {best['avg_trades']:.0f}/year  |  Profitable: {best['profitable']}/{NUM_PATHS} paths")

    print(f"\n  Best risk-adjusted: Experiment #{best_risk['id']} - {best_risk['name']}")
    print(f"    Avg P&L: ${best_risk['avg_pnl']:>+.2f}/year  |  WR: {best_risk['avg_wr']:.1f}%  |  "
          f"Trades: {best_risk['avg_trades']:.0f}/year  |  Risk-Adj: {best_risk['risk_adj']:.2f}")

    # Delta from baseline
    pnl_delta = best["avg_pnl"] - baseline["avg_pnl"]
    wr_delta = best["avg_wr"] - baseline["avg_wr"]
    print(f"\n  vs BASELINE: P&L {'+' if pnl_delta >= 0 else ''}{pnl_delta:.2f}/year, "
          f"WR {'+' if wr_delta >= 0 else ''}{wr_delta:.1f}pp")

    print(f"\n  Total runtime: {time.time() - start_time:.1f}s")
    print()
