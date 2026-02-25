#!/usr/bin/env python3
"""
Aggressive Strategy Optimizer
Tests a grid of parameters across 5 Monte Carlo price paths to find
the optimal Aggressive strategy configuration.

Levers tested:
  1. Strike type: ATM vs OTM
  2. Entry price: 0.40, 0.50, 0.60, 0.75
  3. Exit logic: hold-to-settlement vs intelligent exit
  4. Momentum threshold: 1.0%, 1.5%, 2.0%, 3.0%
  5. Hour return threshold: 0.3%, 0.5%, 0.8%
  6. Position size: $10, $15, $20
  7. Add volatility filter: none, 0.5-2%, 0.5-3%
  8. Add price position filter: none, >50%, >60%
"""
import random
import math
from datetime import datetime, timezone
from itertools import product

# ──── Reuse data generation & helpers from backtest.py ────

def generate_realistic_btc_data(days=365, seed=42):
    random.seed(seed)
    candles = []
    hours = days * 24
    price = 42000.0
    regimes = {
        "bull_trend":   (0.0004,  0.8, "bull"),
        "strong_bull":  (0.0008,  1.2, "strong_bull"),
        "ranging":      (0.0000,  0.6, "range"),
        "bear_trend":   (-0.0003, 1.0, "bear"),
        "selloff":      (-0.0010, 2.0, "selloff"),
        "recovery":     (0.0006,  1.5, "recovery"),
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
            elif current_regime in ("bear_trend",):
                weights = [0.15, 0.05, 0.30, 0.25, 0.10, 0.15]
            elif current_regime == "selloff":
                weights = [0.10, 0.05, 0.15, 0.20, 0.20, 0.30]
            else:
                weights = [0.30, 0.15, 0.25, 0.15, 0.05, 0.10]
            current_regime = random.choices(regime_names, weights=weights, k=1)[0]
            regime_duration = 0

        drift, vol_mult, _ = regimes[current_regime]
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

STRIKE_INCREMENT = 250
def calc_strike(btc_price, strike_type):
    if strike_type == "ATM":
        return round(btc_price / STRIKE_INCREMENT) * STRIKE_INCREMENT
    else:
        return math.floor(btc_price / STRIKE_INCREMENT) * STRIKE_INCREMENT

TAKER_FEE_PCT = 1.5
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


# ──── Parameterized Aggressive Signal ────
def check_aggressive_param(candles, current_price, hour_utc, params):
    """Parameterized aggressive signal check."""
    is_market = 14 <= hour_utc < 21
    sma3 = calc_sma(candles, 3)
    sma6 = calc_sma(candles, 6)
    sma12 = calc_sma(candles, 12)
    mom = calc_momentum_3h(candles, current_price)
    hr = calc_hour_return(candles[-1], current_price)
    vol = calc_volatility(candles[-1])
    pos = calc_price_position(candles[-1])

    # SMA trend (always loosened for aggressive optimizer)
    short_trend = sma3 > sma6 or (sma6 > 0 and (sma6 - sma3) / sma6 < 0.001)
    medium_trend = sma6 > sma12

    # Momentum
    strong_mom = mom > params["momentum_threshold"]

    # Hour return
    hour_up = hr > params["hour_return_threshold"]

    # Optional volatility filter
    if params["vol_filter"] == "none":
        vol_ok = True
    elif params["vol_filter"] == "0.5-2":
        vol_ok = 0.5 <= vol <= 2.0
    elif params["vol_filter"] == "0.5-3":
        vol_ok = 0.5 <= vol <= 3.0
    else:
        vol_ok = True

    # Optional price position filter
    if params["pos_filter"] == "none":
        pos_ok = True
    elif params["pos_filter"] == ">50":
        pos_ok = pos > 50
    elif params["pos_filter"] == ">60":
        pos_ok = pos > 60
    else:
        pos_ok = True

    passed = is_market and short_trend and medium_trend and strong_mom and hour_up and vol_ok and pos_ok

    strike_type = params["strike_type"]
    entry_price = params["entry_price"]
    position_size = params["position_size"]
    contracts = math.floor(position_size / entry_price)

    return {
        "signal": passed,
        "strike": calc_strike(current_price, strike_type) if passed else None,
        "entry_price": entry_price,
        "contracts": contracts,
    }


# ──── Trade Simulation ────
def simulate_trade(entry_price, strike, contracts, candles_after, volatility, use_exit_logic):
    if not candles_after:
        return {"outcome": "no_data", "pnl": 0}

    settlement_candle = candles_after[0]
    settlement_price = settlement_candle["close"]

    if not use_exit_logic:
        # Pure hold to settlement
        if settlement_price > strike:
            pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
            return {"outcome": "win", "pnl": pnl}
        else:
            pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
            return {"outcome": "loss", "pnl": pnl}
    else:
        # Intelligent exit logic (same as conservative)
        mid_price = (settlement_candle["open"] + settlement_candle["close"]) / 2
        distance_mid = mid_price - strike
        ror = calc_risk_of_ruin(mid_price, strike, volatility, 30)
        implied_price = estimate_contract_price(distance_mid, 30)

        early_exit_pnl = calc_net_pnl(contracts, entry_price, implied_price, "early")
        settle_win_pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
        settle_lose_pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
        settle_ev = (1 - ror) * settle_win_pnl + ror * settle_lose_pnl

        # Critical risk
        if ror >= 0.5:
            return {"outcome": "early_exit", "pnl": early_exit_pnl}

        # Negative EV
        if settle_ev < early_exit_pnl and early_exit_pnl > 0:
            return {"outcome": "early_exit", "pnl": early_exit_pnl}

        # Late check
        late_price = settlement_candle["close"]
        late_ror = calc_risk_of_ruin(late_price, strike, volatility, 10)
        if late_ror >= 0.3:
            late_implied = estimate_contract_price(late_price - strike, 10)
            late_exit_pnl = calc_net_pnl(contracts, entry_price, late_implied, "early")
            late_settle_ev = (1 - late_ror) * settle_win_pnl + late_ror * settle_lose_pnl
            if late_settle_ev <= late_exit_pnl * 1.2:
                return {"outcome": "early_exit", "pnl": late_exit_pnl}

        # Hold to settlement
        if settlement_price > strike:
            pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
            return {"outcome": "win", "pnl": pnl}
        else:
            pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
            return {"outcome": "loss", "pnl": pnl}


# ──── Single variant backtest ────
def run_variant(candles, params):
    trades = 0
    wins = 0
    losses = 0
    early_exits = 0
    total_pnl = 0.0
    max_dd = 0.0
    peak_pnl = 0.0

    for i in range(12, len(candles) - 1):
        candle = candles[i]
        dt = datetime.fromtimestamp(candle["open_time"] / 1000, tz=timezone.utc)
        hour_utc = dt.hour
        current_price = candle["close"]
        history = candles[max(0, i - 12):i + 1]
        vol = calc_volatility(candle)

        sig = check_aggressive_param(history, current_price, hour_utc, params)

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
    }


# ──── Main Optimizer ────
if __name__ == "__main__":
    NUM_PATHS = 5

    print("Generating 5 Monte Carlo price paths...")
    all_paths = []
    for seed_idx in range(NUM_PATHS):
        candles = generate_realistic_btc_data(days=365, seed=seed_idx * 17 + 42)
        all_paths.append(candles)

    # ──── PARAMETER GRID ────
    param_grid = {
        "strike_type":          ["ATM", "OTM"],
        "entry_price":          [0.40, 0.50, 0.60],
        "use_exit_logic":       [True, False],
        "momentum_threshold":   [1.0, 1.5, 2.0],
        "hour_return_threshold":[0.3, 0.5],
        "position_size":        [15, 20],
        "vol_filter":           ["none", "0.5-3"],
        "pos_filter":           ["none", ">50"],
    }

    keys = list(param_grid.keys())
    combos = list(product(*[param_grid[k] for k in keys]))
    total_combos = len(combos)

    print(f"\nTesting {total_combos} parameter combinations across {NUM_PATHS} paths...")
    print(f"Total simulations: {total_combos * NUM_PATHS}\n")

    all_variant_results = []

    for idx, combo in enumerate(combos):
        params = dict(zip(keys, combo))

        # Skip illogical combos: OTM strike with high entry price
        if params["strike_type"] == "OTM" and params["entry_price"] > 0.60:
            continue
        # Skip ATM with low entry (wouldn't get filled)
        if params["strike_type"] == "ATM" and params["entry_price"] < 0.50:
            continue

        path_results = []
        for candles in all_paths:
            r = run_variant(candles, params)
            path_results.append(r)

        # Aggregate across paths
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

        all_variant_results.append({
            "params": params,
            "avg_trades": avg_trades,
            "avg_wr": avg_wr,
            "avg_pnl": avg_pnl,
            "avg_dd": avg_dd,
            "avg_exp": avg_exp,
            "worst_pnl": worst_pnl,
            "best_pnl": best_pnl,
            "profitable": profitable,
            "avg_early": avg_early,
        })

        if (idx + 1) % 50 == 0:
            print(f"  Tested {idx + 1}/{total_combos} combos...")

    # ──── RANK & DISPLAY TOP RESULTS ────
    # Sort by avg_pnl descending
    by_pnl = sorted(all_variant_results, key=lambda x: x["avg_pnl"], reverse=True)

    # Sort by risk-adjusted return (avg_pnl / max_dd, higher is better)
    by_sharpe = sorted(
        [v for v in all_variant_results if v["avg_dd"] > 0],
        key=lambda x: x["avg_pnl"] / x["avg_dd"],
        reverse=True
    )

    # Sort by most consistent (profitable in most paths, then by avg_pnl)
    by_consistency = sorted(
        all_variant_results,
        key=lambda x: (x["profitable"], x["avg_pnl"]),
        reverse=True
    )

    print(f"\n{'=' * 110}")
    print("  AGGRESSIVE STRATEGY OPTIMIZATION RESULTS")
    print(f"  Tested {len(all_variant_results)} valid combinations across {NUM_PATHS} price paths")
    print(f"{'=' * 110}")

    def print_variant(v, rank, label=""):
        p = v["params"]
        strike = p["strike_type"]
        entry = p["entry_price"]
        exit_l = "Smart Exit" if p["use_exit_logic"] else "Hold"
        mom = p["momentum_threshold"]
        hr_t = p["hour_return_threshold"]
        pos_sz = p["position_size"]
        vol_f = p["vol_filter"]
        pos_f = p["pos_filter"]
        roi = v["avg_pnl"] / 100 * 100
        risk_adj = v["avg_pnl"] / v["avg_dd"] if v["avg_dd"] > 0 else 999

        print(f"\n  #{rank} {label}")
        print(f"  {'─' * 100}")
        print(f"  Config: Strike={strike} Entry=${entry} Exit={exit_l} Mom>{mom}% HrRet>{hr_t}% Size=${pos_sz} Vol={vol_f} Pos={pos_f}")
        print(f"  {'Avg Trades/Year:':<28} {v['avg_trades']:>6.0f}     {'Avg Win Rate:':<24} {v['avg_wr']:>6.1f}%")
        print(f"  {'Avg P&L:':<28} ${v['avg_pnl']:>+8.2f}   {'Avg ROI:':<24} {roi:>+6.1f}%")
        print(f"  {'Best Path:':<28} ${v['best_pnl']:>+8.2f}   {'Worst Path:':<24} ${v['worst_pnl']:>+8.2f}")
        print(f"  {'Avg Max Drawdown:':<28} ${v['avg_dd']:>8.2f}   {'Risk-Adj Return:':<24} {risk_adj:>6.2f}")
        print(f"  {'Profitable Paths:':<28} {v['profitable']}/{NUM_PATHS}          {'Avg Expectancy:':<24} ${v['avg_exp']:>+6.2f}")
        print(f"  {'Avg Early Exits:':<28} {v['avg_early']:>6.0f}")

    print(f"\n{'─' * 110}")
    print("  TOP 10 BY TOTAL P&L")
    print(f"{'─' * 110}")
    for i, v in enumerate(by_pnl[:10]):
        print_variant(v, i + 1)

    print(f"\n{'─' * 110}")
    print("  TOP 10 BY RISK-ADJUSTED RETURN (P&L / Max Drawdown)")
    print(f"{'─' * 110}")
    for i, v in enumerate(by_sharpe[:10]):
        print_variant(v, i + 1, "(risk-adj)")

    print(f"\n{'─' * 110}")
    print("  TOP 10 BY CONSISTENCY (most profitable paths)")
    print(f"{'─' * 110}")
    for i, v in enumerate(by_consistency[:10]):
        print_variant(v, i + 1, "(consistent)")

    # ──── COMPARE CURRENT vs BEST ────
    current_params = {
        "strike_type": "ATM", "entry_price": 0.75, "use_exit_logic": False,
        "momentum_threshold": 2.0, "hour_return_threshold": 0.5,
        "position_size": 20, "vol_filter": "none", "pos_filter": "none",
    }

    # Run current for comparison
    current_results = []
    for candles in all_paths:
        r = run_variant(candles, current_params)
        current_results.append(r)

    n = len(current_results)
    current_agg = {
        "params": current_params,
        "avg_trades": sum(r["trades"] for r in current_results) / n,
        "avg_wr": sum(r["win_rate"] for r in current_results) / n,
        "avg_pnl": sum(r["total_pnl"] for r in current_results) / n,
        "avg_dd": sum(r["max_dd"] for r in current_results) / n,
        "avg_exp": sum(r["expectancy"] for r in current_results) / n,
        "worst_pnl": min(r["total_pnl"] for r in current_results),
        "best_pnl": max(r["total_pnl"] for r in current_results),
        "profitable": sum(1 for r in current_results if r["total_pnl"] > 0),
        "avg_early": 0,
    }

    best = by_pnl[0]
    best_risk = by_sharpe[0]

    print(f"\n{'=' * 110}")
    print("  CURRENT vs RECOMMENDED AGGRESSIVE STRATEGIES")
    print(f"{'=' * 110}")

    print_variant(current_agg, 0, "CURRENT (baseline)")
    print_variant(best, 1, "BEST BY P&L (recommended)")
    print_variant(best_risk, 2, "BEST RISK-ADJUSTED (alternative)")

    # Print the actual parameter changes needed
    print(f"\n{'=' * 110}")
    print("  RECOMMENDED CHANGES TO AGGRESSIVE STRATEGY")
    print(f"{'=' * 110}")

    bp = best["params"]
    print(f"\n  FROM -> TO:")
    print(f"    Strike:           ATM -> {bp['strike_type']}")
    print(f"    Entry Price:      $0.75 -> ${bp['entry_price']}")
    print(f"    Exit Logic:       Hold to settlement -> {'Intelligent exit' if bp['use_exit_logic'] else 'Hold to settlement'}")
    print(f"    Momentum:         >2.0% -> >{bp['momentum_threshold']}%")
    print(f"    Hour Return:      >0.5% -> >{bp['hour_return_threshold']}%")
    print(f"    Position Size:    $20 -> ${bp['position_size']}")
    print(f"    Volatility Filter: none -> {bp['vol_filter']}")
    print(f"    Position Filter:  none -> {bp['pos_filter']}")

    pnl_delta = best["avg_pnl"] - current_agg["avg_pnl"]
    print(f"\n  Expected improvement: ${pnl_delta:+.2f}/year avg P&L")
    print(f"  Win rate improvement: {current_agg['avg_wr']:.1f}% -> {best['avg_wr']:.1f}%")
    print(f"  Drawdown change:     ${current_agg['avg_dd']:.2f} -> ${best['avg_dd']:.2f}")
    print()
