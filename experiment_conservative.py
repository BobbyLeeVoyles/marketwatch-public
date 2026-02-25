#!/usr/bin/env python3
"""
Large-scale conservative strategy experiment focused on avoiding ruin.
Tests 60+ parameter combinations across 10 Monte Carlo price paths (365 days each).
Ranks by: ruin avoidance (worst-path P&L), risk-adjusted return, drawdown, consistency.

Key conservative differences vs aggressive:
  - Higher probability contracts (>=70% fair value)
  - Dynamic entry price = fairValue * edge_cushion (not fixed)
  - Smaller position sizes
  - Volatility + price position filters
  - No momentum / hour return gates (conservative doesn't use them)
  - Market hours REMOVED (24/7 trading)
"""

import random
import math
import time
from datetime import datetime, timezone


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


# ──── Parameterized Conservative Signal Check ────

def check_signal(candles, current_price, minute, params):
    """Fully parameterized conservative signal check. NO market hours gate."""

    # Time remaining
    mins_remaining = 60 - minute
    if mins_remaining <= params["min_time_remaining"]:
        return {"signal": False}

    sma3 = calc_sma(candles, 3)
    sma6 = calc_sma(candles, 6)
    sma12 = calc_sma(candles, 12)
    if 0 in (sma3, sma6, sma12):
        return {"signal": False}

    vol = calc_volatility(candles[-1])
    pos = calc_price_position(candles[-1])

    # SMA trend check with configurable looseness
    sma_loose = params["sma_looseness"]
    if sma_loose is None:
        short_trend = True
        medium_trend = True
    elif sma_loose == 0:
        short_trend = sma3 > sma6
        medium_trend = sma6 > sma12
    else:
        short_trend = sma3 > sma6 or (sma6 > 0 and (sma6 - sma3) / sma6 < sma_loose)
        medium_trend = sma6 > sma12 or (sma12 > 0 and (sma12 - sma6) / sma12 < sma_loose)

    if not short_trend or not medium_trend:
        return {"signal": False}

    # Volatility filter
    vf = params["vol_filter"]
    if vf == "0.5-2":
        if not (0.5 <= vol <= 2.0):
            return {"signal": False}
    elif vf == "0.3-2.5":
        if not (0.3 <= vol <= 2.5):
            return {"signal": False}
    elif vf == "0.5-1.5":
        if not (0.5 <= vol <= 1.5):
            return {"signal": False}
    elif vf == "0.3-3":
        if not (0.3 <= vol <= 3.0):
            return {"signal": False}
    elif vf == "0.5-3":
        if not (0.5 <= vol <= 3.0):
            return {"signal": False}

    # Price position filter
    pf = params["pos_filter"]
    if pf == ">40":
        if pos <= 40: return {"signal": False}
    elif pf == ">50":
        if pos <= 50: return {"signal": False}
    elif pf == ">60":
        if pos <= 60: return {"signal": False}
    elif pf == ">70":
        if pos <= 70: return {"signal": False}

    # Strike
    strike = calc_strike(current_price, params["strike_type"])

    # Strike distance check
    strike_dist = current_price - strike
    if strike_dist < params["min_strike_distance"]:
        return {"signal": False}

    # Probability / fair value check — conservative needs HIGH prob
    fv = estimate_fair_value(current_price, strike, vol, mins_remaining)
    if fv < params["min_probability"]:
        return {"signal": False}

    # Max probability cap (don't overpay for near-certain outcomes)
    if "max_probability" in params and params["max_probability"] is not None:
        if fv > params["max_probability"]:
            return {"signal": False}

    # Dynamic entry price = fair value * edge cushion
    edge_cushion = params["edge_cushion"]
    max_entry = math.floor(fv * edge_cushion * 100) / 100

    # Hard cap on entry price (avoid paying too much)
    if "max_entry_cap" in params and params["max_entry_cap"] is not None:
        max_entry = min(max_entry, params["max_entry_cap"])

    # Don't enter if contract is too expensive (low ROI)
    if max_entry > 0.95:
        return {"signal": False}

    position_size = params["position_size"]
    contracts = math.floor(position_size / max_entry) if max_entry > 0 else 0
    if contracts <= 0:
        return {"signal": False}

    return {
        "signal": True,
        "strike": strike,
        "entry_price": max_entry,
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


# ──── Single Variant Backtest (with ruin tracking) ────

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
    min_bankroll = 100.0
    ruin_hit = False  # bankroll hit $0 or below
    losing_streak = 0
    max_losing_streak = 0

    for i in range(12, len(candles) - 1):
        candle = candles[i]
        current_price = candle["close"]
        history = candles[max(0, i - 12):i + 1]

        # No market hours gate — check every candle
        sig = check_signal(history, current_price, 30, params)

        if sig["signal"]:
            # Don't trade if bankroll can't cover position
            if bankroll < params["position_size"] * 0.5:
                ruin_hit = True
                continue

            result = simulate_trade(
                sig["entry_price"], sig["strike"], sig["contracts"],
                candles[i + 1:i + 3], sig["volatility"], params["use_exit_logic"]
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
    calmar = (total_pnl / max_dd) if max_dd > 0 else (999 if total_pnl > 0 else 0)

    return {
        "trades": trades, "wins": wins, "losses": losses,
        "win_rate": wr, "total_pnl": total_pnl,
        "max_dd": max_dd, "expectancy": expectancy,
        "early_exits": early_exits,
        "final_bankroll": bankroll,
        "min_bankroll": min_bankroll,
        "ruin_hit": ruin_hit,
        "max_losing_streak": max_losing_streak,
        "calmar": calmar,
    }


# ──── Experiment Definitions (50+ conservative experiments) ────

def build_experiments():
    """Build 60+ targeted experiments for conservative strategy anti-ruin tuning."""
    experiments = []
    exp_id = 0

    # Baseline: current deployed conservative config (minus market hours)
    base = {
        "strike_type": "OTM",
        "edge_cushion": 0.95,          # max entry = fairValue * 0.95
        "max_entry_cap": None,          # no hard cap
        "use_exit_logic": True,
        "position_size": 10,
        "vol_filter": "0.5-2",          # current: 0.5-2%
        "pos_filter": ">60",            # current: >60%
        "sma_looseness": 0.001,         # current: loose (0.1%)
        "min_strike_distance": 50,
        "min_time_remaining": 10,
        "min_probability": 0.70,        # current: >=70%
        "max_probability": None,
    }

    def add(name, overrides):
        nonlocal exp_id
        exp_id += 1
        p = dict(base)
        p.update(overrides)
        experiments.append({"id": exp_id, "name": name, "params": p})

    add("BASELINE (current conservative)", {})

    # ──── SWEEP 1: Minimum probability threshold (7 experiments) ────
    add("MinProb: 60%", {"min_probability": 0.60})
    add("MinProb: 65%", {"min_probability": 0.65})
    add("MinProb: 75%", {"min_probability": 0.75})
    add("MinProb: 80%", {"min_probability": 0.80})
    add("MinProb: 85%", {"min_probability": 0.85})
    add("MinProb: 90%", {"min_probability": 0.90})
    add("MinProb: 95%", {"min_probability": 0.95})

    # ──── SWEEP 2: Edge cushion (entry price discount) (5 experiments) ────
    add("Edge: 0.90 (10% discount)", {"edge_cushion": 0.90})
    add("Edge: 0.92 (8% discount)", {"edge_cushion": 0.92})
    add("Edge: 0.97 (3% discount)", {"edge_cushion": 0.97})
    add("Edge: 0.99 (1% discount)", {"edge_cushion": 0.99})
    add("Edge: 0.85 (15% discount)", {"edge_cushion": 0.85})

    # ──── SWEEP 3: Position size (5 experiments) ────
    add("Size: $5", {"position_size": 5})
    add("Size: $8", {"position_size": 8})
    add("Size: $15", {"position_size": 15})
    add("Size: $20", {"position_size": 20})
    add("Size: $3", {"position_size": 3})

    # ──── SWEEP 4: Volatility filter (5 experiments) ────
    add("Vol: none", {"vol_filter": "none"})
    add("Vol: 0.3-2.5%", {"vol_filter": "0.3-2.5"})
    add("Vol: 0.5-1.5%", {"vol_filter": "0.5-1.5"})
    add("Vol: 0.3-3%", {"vol_filter": "0.3-3"})
    add("Vol: 0.5-3%", {"vol_filter": "0.5-3"})

    # ──── SWEEP 5: Price position filter (4 experiments) ────
    add("Pos: none", {"pos_filter": "none"})
    add("Pos: >40%", {"pos_filter": ">40"})
    add("Pos: >50%", {"pos_filter": ">50"})
    add("Pos: >70%", {"pos_filter": ">70"})

    # ──── SWEEP 6: SMA looseness (4 experiments) ────
    add("SMA: strict", {"sma_looseness": 0})
    add("SMA: very loose (0.3%)", {"sma_looseness": 0.003})
    add("SMA: ultra loose (0.5%)", {"sma_looseness": 0.005})
    add("SMA: disabled", {"sma_looseness": None})

    # ──── SWEEP 7: Strike type (1 experiment) ────
    add("Strike: ATM", {"strike_type": "ATM"})

    # ──── SWEEP 8: Strike distance (3 experiments) ────
    add("Dist: $0", {"min_strike_distance": 0})
    add("Dist: $100", {"min_strike_distance": 100})
    add("Dist: $150", {"min_strike_distance": 150})

    # ──── SWEEP 9: Time remaining (3 experiments) ────
    add("Time: >5m", {"min_time_remaining": 5})
    add("Time: >15m", {"min_time_remaining": 15})
    add("Time: >20m", {"min_time_remaining": 20})

    # ──── SWEEP 10: Exit logic (1 experiment) ────
    add("Exit: hold to settlement", {"use_exit_logic": False})

    # ──── SWEEP 11: Max entry cap (3 experiments) ────
    add("Cap: max $0.85", {"max_entry_cap": 0.85})
    add("Cap: max $0.90", {"max_entry_cap": 0.90})
    add("Cap: max $0.80", {"max_entry_cap": 0.80})

    # ──── SWEEP 12: Max probability cap (2 experiments) ────
    add("MaxProb: <=95%", {"max_probability": 0.95})
    add("MaxProb: <=90%", {"max_probability": 0.90})

    # ──── COMBO EXPERIMENTS: Anti-ruin focused combinations ────

    # Combo 1: Ultra-safe — high prob + small size + tight vol
    add("COMBO: ultra-safe (prob>=85, $5, vol 0.5-1.5)", {
        "min_probability": 0.85, "position_size": 5, "vol_filter": "0.5-1.5"})

    # Combo 2: High prob + deep discount
    add("COMBO: high prob + deep discount (prob>=80, edge 0.90)", {
        "min_probability": 0.80, "edge_cushion": 0.90})

    # Combo 3: Relaxed entry + higher volume
    add("COMBO: relaxed (prob>=65, edge 0.97, pos>40)", {
        "min_probability": 0.65, "edge_cushion": 0.97, "pos_filter": ">40"})

    # Combo 4: Strict everything — maximum safety
    add("COMBO: max safety (prob>=85, edge 0.90, vol 0.5-1.5, pos>70, $5)", {
        "min_probability": 0.85, "edge_cushion": 0.90, "vol_filter": "0.5-1.5",
        "pos_filter": ">70", "position_size": 5})

    # Combo 5: Moderate relaxation with smart exit
    add("COMBO: moderate + exit (prob>=70, edge 0.95, vol 0.3-2.5)", {
        "min_probability": 0.70, "edge_cushion": 0.95, "vol_filter": "0.3-2.5"})

    # Combo 6: Higher position + higher prob for more profits
    add("COMBO: big safe (prob>=80, $15, edge 0.92)", {
        "min_probability": 0.80, "position_size": 15, "edge_cushion": 0.92})

    # Combo 7: SMA disabled + vol filter (more opportunities)
    add("COMBO: no SMA + vol 0.5-2 (more trades)", {
        "sma_looseness": None, "vol_filter": "0.5-2"})

    # Combo 8: ATM strike + high prob (high-prob ITM)
    add("COMBO: ATM + prob>=80 + edge 0.92", {
        "strike_type": "ATM", "min_probability": 0.80, "edge_cushion": 0.92})

    # Combo 9: Wider vol + lower prob = more trades, still safe
    add("COMBO: wider (prob>=65, vol 0.3-3, pos>50, edge 0.95)", {
        "min_probability": 0.65, "vol_filter": "0.3-3", "pos_filter": ">50"})

    # Combo 10: Time-conservative with tight filters
    add("COMBO: time-safe (>15m, prob>=80, edge 0.92)", {
        "min_time_remaining": 15, "min_probability": 0.80, "edge_cushion": 0.92})

    # Combo 11: Minimal filters — max volume
    add("COMBO: minimal (prob>=60, no vol, no pos, loose SMA)", {
        "min_probability": 0.60, "vol_filter": "none", "pos_filter": "none",
        "sma_looseness": 0.003})

    # Combo 12: Hold to settlement + high prob (avoid exit fees)
    add("COMBO: hold + high prob (prob>=80, no exit, $10)", {
        "min_probability": 0.80, "use_exit_logic": False, "position_size": 10})

    # Combo 13: Entry cap + relaxed prob = controlled risk
    add("COMBO: capped entry (prob>=65, cap $0.85, edge 0.97)", {
        "min_probability": 0.65, "max_entry_cap": 0.85, "edge_cushion": 0.97})

    # Combo 14: Anti-ruin best guess — high WR, small size, tight everything
    add("COMBO: anti-ruin v1 (prob>=80, $8, edge 0.92, vol 0.5-2, pos>60)", {
        "min_probability": 0.80, "position_size": 8, "edge_cushion": 0.92,
        "vol_filter": "0.5-2", "pos_filter": ">60"})

    # Combo 15: Anti-ruin v2 — even tighter
    add("COMBO: anti-ruin v2 (prob>=85, $8, edge 0.90, vol 0.5-1.5, pos>60)", {
        "min_probability": 0.85, "position_size": 8, "edge_cushion": 0.90,
        "vol_filter": "0.5-1.5", "pos_filter": ">60"})

    # Combo 16: Prob capped — avoid overpaying for certainty
    add("COMBO: capped prob (prob 70-95%, edge 0.95)", {
        "min_probability": 0.70, "max_probability": 0.95, "edge_cushion": 0.95})

    # Combo 17: OTM + higher dist for deeper safety
    add("COMBO: deep OTM (OTM, dist>=100, prob>=75)", {
        "strike_type": "OTM", "min_strike_distance": 100, "min_probability": 0.75})

    # Combo 18: Balanced moderate
    add("COMBO: balanced (prob>=75, edge 0.93, $10, vol 0.3-2.5, pos>50)", {
        "min_probability": 0.75, "edge_cushion": 0.93, "position_size": 10,
        "vol_filter": "0.3-2.5", "pos_filter": ">50"})

    # Combo 19: High-volume loose + small size for ruin protection
    add("COMBO: high-vol small (prob>=60, $5, no vol, SMA disabled)", {
        "min_probability": 0.60, "position_size": 5, "vol_filter": "none",
        "sma_looseness": None})

    # Combo 20: Edge 0.85 + larger size (big discount = bigger edge per trade)
    add("COMBO: deep discount big (prob>=75, edge 0.85, $15)", {
        "min_probability": 0.75, "edge_cushion": 0.85, "position_size": 15})

    return experiments


# ──── Main ────

if __name__ == "__main__":
    NUM_PATHS = 10
    start_time = time.time()

    print("=" * 120)
    print("  LARGE-SCALE CONSERVATIVE STRATEGY EXPERIMENT (ANTI-RUIN FOCUS)")
    print(f"  Testing parameter combinations across {NUM_PATHS} Monte Carlo price paths (365 days each)")
    print(f"  Market hours: REMOVED (24/7 trading)")
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
        worst_bank = min(r["final_bankroll"] for r in path_results)
        min_bank_ever = min(r["min_bankroll"] for r in path_results)
        ruin_count = sum(1 for r in path_results if r["ruin_hit"])
        avg_max_streak = sum(r["max_losing_streak"] for r in path_results) / n
        worst_streak = max(r["max_losing_streak"] for r in path_results)
        avg_calmar = sum(r["calmar"] for r in path_results) / n

        risk_adj = avg_pnl / avg_dd if avg_dd > 0 else (999 if avg_pnl > 0 else -999)

        # Anti-ruin score: penalizes strategies that come close to ruin
        # Higher is better. Weights: worst-path P&L, worst bankroll, no ruin, low DD
        anti_ruin = (
            (worst_pnl * 2) +                    # Heavily weight worst-case outcome
            (min_bank_ever * 1.5) +               # Penalize low bankroll dips
            (avg_pnl * 0.5) +                     # Still want positive expectation
            (-ruin_count * 50) +                   # Massive penalty for any ruin
            (-avg_dd * 1.0)                        # Penalize drawdown
        )

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
            "worst_bank": worst_bank,
            "min_bank_ever": min_bank_ever,
            "ruin_count": ruin_count,
            "avg_max_streak": avg_max_streak,
            "worst_streak": worst_streak,
            "avg_calmar": avg_calmar,
            "anti_ruin": anti_ruin,
        })

        if exp["id"] % 10 == 0:
            print(f"    Completed {exp['id']}/{total_exp} experiments...")

    elapsed = time.time() - start_time
    print(f"\n  All {total_exp} experiments complete in {elapsed:.1f}s")

    # ════════════════════════════════════════════════════════════════
    # RESULTS
    # ════════════════════════════════════════════════════════════════

    def detail(v, rank, label=""):
        p = v["params"]
        sma = "DISABLED" if p["sma_looseness"] is None else (
            "strict" if p["sma_looseness"] == 0 else f"loose({p['sma_looseness']*100:.1f}%)")
        max_p = f"{p['max_probability']*100:.0f}%" if p.get("max_probability") else "none"
        cap = f"${p['max_entry_cap']}" if p.get("max_entry_cap") else "none"

        print(f"\n  {'─' * 115}")
        print(f"  RANK #{rank} {label}")
        print(f"  {v['name']}")
        print(f"  {'─' * 115}")
        print(f"  Parameters:")
        print(f"    Strike: {p['strike_type']:<6}  EdgeCushion: {p['edge_cushion']:<6}  "
              f"Exit: {'Smart' if p['use_exit_logic'] else 'Hold':<6}  "
              f"Size: ${p['position_size']}  EntryCap: {cap}")
        print(f"    MinProb: >={p['min_probability']*100:.0f}%  MaxProb: {max_p}  "
              f"SMA: {sma}  MinDist: ${p['min_strike_distance']}  Time: >{p['min_time_remaining']}m")
        print(f"    Vol Filter: {p['vol_filter']:<10}  Pos Filter: {p['pos_filter']:<6}")
        print(f"  Results ({NUM_PATHS}-path average):")
        print(f"    Trades/Year: {v['avg_trades']:>6.0f}    Win Rate: {v['avg_wr']:>6.1f}%    "
              f"Expectancy: ${v['avg_exp']:>+6.2f}/trade")
        print(f"    Avg P&L:    ${v['avg_pnl']:>+9.2f}    Max DD:  ${v['avg_dd']:>8.2f}    "
              f"Risk-Adj: {v['risk_adj']:>6.2f}    Calmar: {v['avg_calmar']:>6.2f}")
        print(f"    Best Path:  ${v['best_pnl']:>+9.2f}    Worst:   ${v['worst_pnl']:>+9.2f}    "
              f"Profitable: {v['profitable']}/{NUM_PATHS}")
        print(f"    Avg Bankroll: ${v['avg_bank']:>8.2f}  Worst Bankroll: ${v['worst_bank']:>8.2f}  "
              f"Min Ever: ${v['min_bank_ever']:>8.2f}")
        print(f"    Ruin Hit: {v['ruin_count']}/{NUM_PATHS} paths    "
              f"Max Losing Streak: {v['worst_streak']}    "
              f"Anti-Ruin Score: {v['anti_ruin']:>+.1f}")

    # ──── FULL RANKING BY ANTI-RUIN SCORE ────
    by_antiruin = sorted(results, key=lambda x: x["anti_ruin"], reverse=True)

    print(f"\n{'=' * 120}")
    print(f"  FULL RANKING BY ANTI-RUIN SCORE (all {total_exp} experiments)")
    print(f"  Score = 2×worst_pnl + 1.5×min_bankroll + 0.5×avg_pnl - 50×ruin_count - 1×avg_dd")
    print(f"{'=' * 120}")
    for i, v in enumerate(by_antiruin):
        marker = " <<<" if v["name"] == "BASELINE (current conservative)" else ""
        print(f"  {i+1:>3}. {v['name']:<55} "
              f"Score:{v['anti_ruin']:>+8.1f}  P&L:${v['avg_pnl']:>+8.2f}  "
              f"WR:{v['avg_wr']:>5.1f}%  DD:${v['avg_dd']:>6.2f}  "
              f"Worst:${v['worst_pnl']:>+8.2f}  "
              f"Ruin:{v['ruin_count']}/{NUM_PATHS}{marker}")

    # ──── TOP 10 BY ANTI-RUIN (detailed) ────
    print(f"\n{'=' * 120}")
    print(f"  TOP 10 BY ANTI-RUIN SCORE (conservative = avoid ruin first)")
    print(f"{'=' * 120}")
    for i, v in enumerate(by_antiruin[:10]):
        detail(v, i + 1, "(anti-ruin)")

    # ──── TOP 10 BY P&L ────
    by_pnl = sorted(results, key=lambda x: x["avg_pnl"], reverse=True)

    print(f"\n{'=' * 120}")
    print(f"  TOP 10 BY AVERAGE P&L")
    print(f"{'=' * 120}")
    for i, v in enumerate(by_pnl[:10]):
        detail(v, i + 1, "(P&L)")

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

    # ──── TOP 10 ZERO-RUIN STRATEGIES (no ruin on any path) ────
    zero_ruin = sorted(
        [v for v in results if v["ruin_count"] == 0],
        key=lambda x: x["avg_pnl"], reverse=True)

    print(f"\n{'=' * 120}")
    print(f"  TOP 10 ZERO-RUIN STRATEGIES (never hit ruin on any path, ranked by P&L)")
    print(f"{'=' * 120}")
    for i, v in enumerate(zero_ruin[:10]):
        detail(v, i + 1, "(zero-ruin)")

    # ──── BASELINE vs BEST COMPARISON ────
    baseline = next(v for v in results if "BASELINE" in v["name"])
    best_ar = by_antiruin[0]
    best_pnl_v = by_pnl[0]
    best_zero = zero_ruin[0] if zero_ruin else by_antiruin[0]

    print(f"\n{'=' * 120}")
    print(f"  BASELINE vs BEST COMPARISON")
    print(f"{'=' * 120}")
    detail(baseline, 0, "CURRENT BASELINE")
    detail(best_ar, 1, "BEST ANTI-RUIN")
    detail(best_zero, 2, "BEST ZERO-RUIN BY P&L")
    detail(best_pnl_v, 3, "BEST BY RAW P&L")

    # ──── FINAL RECOMMENDATION ────
    print(f"\n{'=' * 120}")
    print(f"  FINAL RECOMMENDATION (CONSERVATIVE ANTI-RUIN)")
    print(f"{'=' * 120}")

    # Pick the best zero-ruin strategy, or best anti-ruin if none exist
    recommended = best_zero if zero_ruin else best_ar
    rp = recommended["params"]

    print(f"\n  RECOMMENDED: Experiment #{recommended['id']} - {recommended['name']}")
    print(f"    Anti-Ruin Score: {recommended['anti_ruin']:>+.1f}")
    print(f"    Avg P&L: ${recommended['avg_pnl']:>+.2f}/year  |  WR: {recommended['avg_wr']:.1f}%  |  "
          f"Trades: {recommended['avg_trades']:.0f}/year")
    print(f"    Worst Path: ${recommended['worst_pnl']:>+.2f}  |  Max DD: ${recommended['avg_dd']:.2f}  |  "
          f"Ruin: {recommended['ruin_count']}/{NUM_PATHS}")
    print(f"    Min Bankroll Ever: ${recommended['min_bank_ever']:.2f}  |  "
          f"Max Losing Streak: {recommended['worst_streak']}")

    print(f"\n  RECOMMENDED PARAMETERS:")
    sma = "DISABLED" if rp["sma_looseness"] is None else (
        "strict" if rp["sma_looseness"] == 0 else f"loose ({rp['sma_looseness']*100:.1f}%)")
    max_p = f"<={rp['max_probability']*100:.0f}%" if rp.get("max_probability") else "none"
    cap = f"${rp['max_entry_cap']}" if rp.get("max_entry_cap") else "none"
    print(f"    strike_type: {rp['strike_type']}")
    print(f"    edge_cushion: {rp['edge_cushion']}")
    print(f"    max_entry_cap: {cap}")
    print(f"    use_exit_logic: {rp['use_exit_logic']}")
    print(f"    position_size: ${rp['position_size']}")
    print(f"    vol_filter: {rp['vol_filter']}")
    print(f"    pos_filter: {rp['pos_filter']}")
    print(f"    sma_looseness: {sma}")
    print(f"    min_strike_distance: ${rp['min_strike_distance']}")
    print(f"    min_time_remaining: {rp['min_time_remaining']}m")
    print(f"    min_probability: {rp['min_probability']*100:.0f}%")
    print(f"    max_probability: {max_p}")

    # Delta from baseline
    pnl_delta = recommended["avg_pnl"] - baseline["avg_pnl"]
    wr_delta = recommended["avg_wr"] - baseline["avg_wr"]
    dd_delta = recommended["avg_dd"] - baseline["avg_dd"]
    print(f"\n  vs BASELINE: P&L {'+' if pnl_delta >= 0 else ''}{pnl_delta:.2f}/year, "
          f"WR {'+' if wr_delta >= 0 else ''}{wr_delta:.1f}pp, "
          f"DD {'+' if dd_delta >= 0 else ''}{dd_delta:.2f}")

    print(f"\n  Total runtime: {time.time() - start_time:.1f}s")
    print()
