#!/usr/bin/env python3
"""
Experiment: Next-Strike-Up Fallback for Aggressive Strategy

Compares:
  A) CURRENT: Always targets floor strike (OTM = floor to $250)
  B) NEXT-UP FALLBACK: When floor strike is too deep ITM (prob > 70%),
     fall back to the next $250 strike above current price
  C) ALWAYS CEIL: Always target the ceiling strike (next $250 above)
  D) SMART SELECT: Pick whichever strike has fair value closest to $0.30

Uses the same Monte Carlo infrastructure as experiment_aggressive.py.
10 price paths, 365 days each.
"""

import random
import math
import time
from datetime import datetime, timezone


# ──── Data Generation (identical to experiment_aggressive.py) ────

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


# ──── Strike & Fair Value ────

STRIKE_INCREMENT = 250
TAKER_FEE_PCT = 1.5
MIN_STRIKE_DISTANCE = 50

def floor_strike(price):
    return math.floor(price / STRIKE_INCREMENT) * STRIKE_INCREMENT

def ceil_strike(price):
    return math.ceil(price / STRIKE_INCREMENT) * STRIKE_INCREMENT

def estimate_fair_value(price, strike, vol, mins_remaining):
    """Estimate probability BTC stays above strike."""
    if vol <= 0 or mins_remaining <= 0:
        return 1.0 if price > strike else 0.0
    distance = price - strike
    time_hours = mins_remaining / 60
    expected_move = price * (vol / 100) * math.sqrt(max(time_hours, 0.01))
    z = distance / expected_move if expected_move > 0 else 0
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


# ──── PnL & Exit ────

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


# ──── Trade Simulation (smart exit logic) ────

def simulate_trade(entry_price, strike, contracts, candles_after, volatility):
    if not candles_after:
        return {"outcome": "no_data", "pnl": 0}

    settlement_candle = candles_after[0]
    settlement_price = settlement_candle["close"]

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


# ──── Common Signal Checks (shared by all variants) ────

def common_checks(candles, current_price, hour_utc, minute):
    """Returns (passed, details) for checks shared across all strike variants."""
    if not (14 <= hour_utc < 21):
        return False, {}

    mins_remaining = 60 - minute
    if mins_remaining <= 15:
        return False, {}

    sma3 = calc_sma(candles, 3)
    sma6 = calc_sma(candles, 6)
    sma12 = calc_sma(candles, 12)
    if 0 in (sma3, sma6, sma12):
        return False, {}

    short_trend = sma3 > sma6 or (sma6 > 0 and (sma6 - sma3) / sma6 < 0.001)
    medium_trend = sma6 > sma12
    if not short_trend or not medium_trend:
        return False, {}

    hr = calc_hour_return(candles[-1], current_price)
    if hr <= 0.3:
        return False, {}

    vol = calc_volatility(candles[-1])

    return True, {"mins_remaining": mins_remaining, "vol": vol}


# ──── Strike Selection Strategies ────

ENTRY_PRICE = 0.30
POSITION_SIZE = 20
PROB_LO = 0.35
PROB_HI = 0.70


def select_strike_current(price, vol, mins_remaining):
    """CURRENT: Always use floor strike."""
    strike = floor_strike(price)
    dist = price - strike
    if dist < MIN_STRIKE_DISTANCE:
        return None, None, "dist_too_small"
    fv = estimate_fair_value(price, strike, vol, mins_remaining)
    if not (PROB_LO <= fv <= PROB_HI):
        return None, None, f"prob_out_of_range({fv:.2f})"
    return strike, fv, "floor"


def select_strike_next_up_fallback(price, vol, mins_remaining):
    """NEXT-UP FALLBACK: Try floor first, if prob too high (>70%), try ceil."""
    strike_floor = floor_strike(price)
    dist_floor = price - strike_floor

    # Try floor strike first
    if dist_floor >= MIN_STRIKE_DISTANCE:
        fv_floor = estimate_fair_value(price, strike_floor, vol, mins_remaining)
        if PROB_LO <= fv_floor <= PROB_HI:
            return strike_floor, fv_floor, "floor"

        # Floor failed — if probability too high (too deep ITM), try next up
        if fv_floor > PROB_HI:
            strike_up = strike_floor + STRIKE_INCREMENT
            fv_up = estimate_fair_value(price, strike_up, vol, mins_remaining)
            if PROB_LO <= fv_up <= PROB_HI:
                return strike_up, fv_up, "next_up"

    else:
        # Distance too small for floor — try next up directly
        strike_up = strike_floor + STRIKE_INCREMENT
        fv_up = estimate_fair_value(price, strike_up, vol, mins_remaining)
        if PROB_LO <= fv_up <= PROB_HI:
            return strike_up, fv_up, "next_up"

    return None, None, "no_valid_strike"


def select_strike_always_ceil(price, vol, mins_remaining):
    """ALWAYS CEIL: Always target the next $250 above price."""
    strike = ceil_strike(price)
    # If price is exactly on a $250 boundary, ceil == price, go one up
    if strike <= price:
        strike += STRIKE_INCREMENT
    fv = estimate_fair_value(price, strike, vol, mins_remaining)
    if not (PROB_LO <= fv <= PROB_HI):
        return None, None, f"prob_out_of_range({fv:.2f})"
    return strike, fv, "ceil"


def select_strike_smart(price, vol, mins_remaining):
    """SMART SELECT: Pick whichever strike has fair value closest to entry price."""
    strike_floor = floor_strike(price)
    strike_up = strike_floor + STRIKE_INCREMENT

    candidates = []

    # Floor candidate
    dist_floor = price - strike_floor
    if dist_floor >= MIN_STRIKE_DISTANCE:
        fv_floor = estimate_fair_value(price, strike_floor, vol, mins_remaining)
        if PROB_LO <= fv_floor <= PROB_HI:
            candidates.append((strike_floor, fv_floor, "floor",
                               abs(fv_floor - ENTRY_PRICE)))

    # Ceil candidate (always check)
    fv_up = estimate_fair_value(price, strike_up, vol, mins_remaining)
    if PROB_LO <= fv_up <= PROB_HI:
        candidates.append((strike_up, fv_up, "next_up",
                           abs(fv_up - ENTRY_PRICE)))

    if not candidates:
        return None, None, "no_valid_strike"

    # Pick the one whose fair value is closest to our entry price
    best = min(candidates, key=lambda x: x[3])
    return best[0], best[1], best[2]


# ──── Backtest Runner ────

STRIKE_SELECTORS = {
    "A) CURRENT (floor only)": select_strike_current,
    "B) NEXT-UP FALLBACK":     select_strike_next_up_fallback,
    "C) ALWAYS CEIL":          select_strike_always_ceil,
    "D) SMART SELECT":         select_strike_smart,
}


def run_variant(candles, selector_fn):
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
    skipped_no_strike = 0
    trade_details = []

    for i in range(12, len(candles) - 1):
        candle = candles[i]
        dt = datetime.fromtimestamp(candle["open_time"] / 1000, tz=timezone.utc)
        hour_utc = dt.hour
        current_price = candle["close"]
        history = candles[max(0, i - 12):i + 1]
        vol = calc_volatility(candle)

        passed, details = common_checks(history, current_price, hour_utc, 30)
        if not passed:
            continue

        mins_remaining = details["mins_remaining"]

        strike, fv, reason = selector_fn(current_price, vol, mins_remaining)

        if strike is None:
            skipped_no_strike += 1
            continue

        if reason == "floor":
            floor_used += 1
        elif reason == "next_up":
            next_up_used += 1
        elif reason == "ceil":
            ceil_used += 1

        contracts = math.floor(POSITION_SIZE / ENTRY_PRICE)

        result = simulate_trade(
            ENTRY_PRICE, strike, contracts,
            candles[i + 1:i + 3], vol
        )

        if result["outcome"] == "no_data":
            continue

        trades += 1
        pnl = result["pnl"]
        total_pnl += pnl

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

        trade_details.append({
            "date": dt.strftime("%m/%d %H:%M"),
            "price": current_price,
            "strike": strike,
            "dist": current_price - strike,
            "fv": fv,
            "type": reason,
            "pnl": pnl,
            "outcome": result["outcome"],
        })

    wr = (wins / trades * 100) if trades > 0 else 0
    expectancy = (total_pnl / trades) if trades > 0 else 0

    return {
        "trades": trades, "wins": wins, "losses": losses,
        "win_rate": wr, "total_pnl": total_pnl,
        "max_dd": max_dd, "expectancy": expectancy,
        "early_exits": early_exits,
        "floor_used": floor_used, "next_up_used": next_up_used,
        "ceil_used": ceil_used, "skipped": skipped_no_strike,
        "trade_details": trade_details,
    }


# ──── Main ────

if __name__ == "__main__":
    NUM_PATHS = 10
    start_time = time.time()

    print("=" * 120)
    print("  EXPERIMENT: NEXT-STRIKE-UP FALLBACK FOR AGGRESSIVE STRATEGY")
    print(f"  Testing 4 strike selection methods across {NUM_PATHS} Monte Carlo paths (365 days each)")
    print(f"  Entry: ${ENTRY_PRICE}  |  Position: ${POSITION_SIZE}  |  Prob range: {PROB_LO*100:.0f}-{PROB_HI*100:.0f}%")
    print("=" * 120)

    print("\n  Strike Selection Methods:")
    print("    A) CURRENT:        Always floor(price/250)*250 — current deployed behavior")
    print("    B) NEXT-UP FALLBACK: Try floor first; if prob > 70% (too ITM), try floor+250")
    print("    C) ALWAYS CEIL:    Always target ceil(price/250)*250 — always true OTM")
    print("    D) SMART SELECT:   Pick floor or ceil based on which fair value is closest to $0.30")

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

    # Run all variants across all paths
    all_results = {}
    for name, selector in STRIKE_SELECTORS.items():
        path_results = []
        for candles in all_paths:
            r = run_variant(candles, selector)
            path_results.append(r)
        all_results[name] = path_results

    elapsed = time.time() - start_time
    print(f"\n  All experiments complete in {elapsed:.1f}s")

    # ════════════════════════════════════════════════════════════════
    # RESULTS
    # ════════════════════════════════════════════════════════════════

    print(f"\n{'=' * 120}")
    print(f"  HEAD-TO-HEAD COMPARISON ({NUM_PATHS}-PATH AVERAGES)")
    print(f"{'=' * 120}")

    header = (f"  {'Method':<30} {'Trades':>7} {'WR':>7} {'P&L':>11} "
              f"{'Expect':>9} {'MaxDD':>9} {'RiskAdj':>9} "
              f"{'Floor':>7} {'NextUp':>7} {'Skip':>7} {'Prof':>6}")
    print(header)
    print(f"  {'─' * 118}")

    summaries = {}
    for name, path_results in all_results.items():
        n = len(path_results)
        avg_trades = sum(r["trades"] for r in path_results) / n
        avg_wr = sum(r["win_rate"] for r in path_results) / n
        avg_pnl = sum(r["total_pnl"] for r in path_results) / n
        avg_dd = sum(r["max_dd"] for r in path_results) / n
        avg_exp = sum(r["expectancy"] for r in path_results) / n
        avg_floor = sum(r["floor_used"] for r in path_results) / n
        avg_next_up = sum(r["next_up_used"] for r in path_results) / n
        avg_skip = sum(r["skipped"] for r in path_results) / n
        worst_pnl = min(r["total_pnl"] for r in path_results)
        best_pnl = max(r["total_pnl"] for r in path_results)
        profitable = sum(1 for r in path_results if r["total_pnl"] > 0)
        risk_adj = avg_pnl / avg_dd if avg_dd > 0 else (999 if avg_pnl > 0 else -999)

        summaries[name] = {
            "avg_trades": avg_trades, "avg_wr": avg_wr, "avg_pnl": avg_pnl,
            "avg_dd": avg_dd, "avg_exp": avg_exp, "risk_adj": risk_adj,
            "avg_floor": avg_floor, "avg_next_up": avg_next_up, "avg_skip": avg_skip,
            "worst_pnl": worst_pnl, "best_pnl": best_pnl, "profitable": profitable,
        }

        print(f"  {name:<30} {avg_trades:>7.0f} {avg_wr:>6.1f}% ${avg_pnl:>+9.2f} "
              f"${avg_exp:>+7.2f} ${avg_dd:>7.2f} {risk_adj:>9.2f} "
              f"{avg_floor:>7.0f} {avg_next_up:>7.0f} {avg_skip:>7.0f} "
              f"{profitable:>3}/{NUM_PATHS}")

    # ──── DETAILED BREAKDOWN ────
    for name, path_results in all_results.items():
        s = summaries[name]
        print(f"\n{'─' * 120}")
        print(f"  {name}")
        print(f"{'─' * 120}")
        print(f"  Averages across {NUM_PATHS} paths:")
        print(f"    Trades/Year:    {s['avg_trades']:>6.0f}      Win Rate:     {s['avg_wr']:>6.1f}%")
        print(f"    Avg P&L:       ${s['avg_pnl']:>+9.2f}    Max Drawdown: ${s['avg_dd']:>8.2f}")
        print(f"    Expectancy:    ${s['avg_exp']:>+7.2f}/trade   Risk-Adj:    {s['risk_adj']:>7.2f}")
        print(f"    Best Path:     ${s['best_pnl']:>+9.2f}    Worst Path:  ${s['worst_pnl']:>+9.2f}")
        print(f"    Profitable:     {s['profitable']}/{NUM_PATHS} paths")
        print(f"    Strike Usage:   Floor={s['avg_floor']:.0f}  NextUp={s['avg_next_up']:.0f}  Skipped={s['avg_skip']:.0f}")

        print(f"\n  Per-path breakdown:")
        print(f"    {'Path':>6} {'Trades':>7} {'WR':>7} {'P&L':>11} {'Floor':>7} {'NextUp':>7} {'Skip':>7}")
        for idx, r in enumerate(path_results):
            print(f"    {idx+1:>6} {r['trades']:>7} {r['win_rate']:>6.1f}% ${r['total_pnl']:>+9.2f} "
                  f"{r['floor_used']:>7} {r['next_up_used']:>7} {r['skipped']:>7}")

    # ──── NEXT-UP TRADE ANALYSIS ────
    # Show what happens specifically when next-up strikes are used
    print(f"\n{'=' * 120}")
    print(f"  NEXT-UP STRIKE TRADE ANALYSIS")
    print(f"  (trades where the fallback to next strike UP was used)")
    print(f"{'=' * 120}")

    for name in ["B) NEXT-UP FALLBACK", "D) SMART SELECT"]:
        if name not in all_results:
            continue
        next_up_trades = []
        floor_trades = []
        for r in all_results[name]:
            for t in r["trade_details"]:
                if t["type"] == "next_up":
                    next_up_trades.append(t)
                elif t["type"] == "floor":
                    floor_trades.append(t)

        if next_up_trades:
            nu_wins = sum(1 for t in next_up_trades if t["pnl"] >= 0)
            nu_total = len(next_up_trades)
            nu_pnl = sum(t["pnl"] for t in next_up_trades)
            nu_avg_dist = sum(t["dist"] for t in next_up_trades) / nu_total
            nu_avg_fv = sum(t["fv"] for t in next_up_trades) / nu_total

            print(f"\n  {name} — Next-Up Trades:")
            print(f"    Total:          {nu_total}")
            print(f"    Win Rate:       {nu_wins/nu_total*100:.1f}%")
            print(f"    Total P&L:     ${nu_pnl:+.2f}")
            print(f"    Avg P&L/Trade: ${nu_pnl/nu_total:+.2f}")
            print(f"    Avg Distance:  ${nu_avg_dist:.0f} (negative = price below strike)")
            print(f"    Avg Fair Value: {nu_avg_fv*100:.1f}%")

        if floor_trades:
            fl_wins = sum(1 for t in floor_trades if t["pnl"] >= 0)
            fl_total = len(floor_trades)
            fl_pnl = sum(t["pnl"] for t in floor_trades)

            print(f"\n  {name} — Floor Trades (for comparison):")
            print(f"    Total:          {fl_total}")
            print(f"    Win Rate:       {fl_wins/fl_total*100:.1f}%")
            print(f"    Total P&L:     ${fl_pnl:+.2f}")
            print(f"    Avg P&L/Trade: ${fl_pnl/fl_total:+.2f}")

    # ──── DELTA vs CURRENT ────
    print(f"\n{'=' * 120}")
    print(f"  DELTA vs CURRENT DEPLOYED")
    print(f"{'=' * 120}")

    current = summaries["A) CURRENT (floor only)"]
    for name, s in summaries.items():
        if name.startswith("A)"):
            continue
        pnl_d = s["avg_pnl"] - current["avg_pnl"]
        wr_d = s["avg_wr"] - current["avg_wr"]
        trade_d = s["avg_trades"] - current["avg_trades"]
        exp_d = s["avg_exp"] - current["avg_exp"]
        print(f"\n  {name}:")
        print(f"    P&L:         {'+' if pnl_d >= 0 else ''}{pnl_d:>.2f}/year")
        print(f"    Win Rate:    {'+' if wr_d >= 0 else ''}{wr_d:.1f}pp")
        print(f"    Trades:      {'+' if trade_d >= 0 else ''}{trade_d:.0f}/year")
        print(f"    Expectancy:  {'+' if exp_d >= 0 else ''}{exp_d:.2f}/trade")
        print(f"    Extra Next-Up Trades: {s['avg_next_up']:.0f}/year")

    print(f"\n  Total runtime: {time.time() - start_time:.1f}s")
    print()
