#!/usr/bin/env python3
"""
BTC Hourly Options Backtest - Current Deployed vs Strike-Aware
Uses statistically-calibrated synthetic BTC data and simulates the
current deployed strategies vs strike-aware variants that require
minimum distance-to-strike before entering.
"""
import random
import time
import math
import json
from datetime import datetime, timezone, timedelta

# ──────────────────── SYNTHETIC DATA GENERATION ────────────────────
def generate_realistic_btc_data(days=365, seed=42):
    """
    Generate realistic hourly BTC candles using a regime-switching model
    calibrated to real BTC statistics:
    - Annualized volatility: ~60-70%
    - Hourly vol: ~0.8-1.2%
    - Trending periods, ranging periods, selloffs
    - Realistic OHLC candle shapes
    - Price range roughly $25k-$70k over a year
    """
    random.seed(seed)
    candles = []
    hours = days * 24

    # Starting price (Feb 2025 levels)
    price = 42000.0

    # Regime parameters: (drift_per_hour, vol_multiplier, name)
    regimes = {
        "bull_trend":   (0.0004,  0.8, "bull"),
        "strong_bull":  (0.0008,  1.2, "strong_bull"),
        "ranging":      (0.0000,  0.6, "range"),
        "bear_trend":   (-0.0003, 1.0, "bear"),
        "selloff":      (-0.0010, 2.0, "selloff"),
        "recovery":     (0.0006,  1.5, "recovery"),
    }
    regime_names = list(regimes.keys())
    # Transition probabilities (stay in same regime ~85-95% of time)
    current_regime = "bull_trend"
    regime_duration = 0

    # Base hourly volatility (~0.9% matches ~65% annualized)
    base_hourly_vol = 0.009

    start_ts = int(datetime(2025, 2, 11, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)

    for h in range(hours):
        # Regime switching
        regime_duration += 1
        if random.random() < 0.02 + (regime_duration / 500):  # increasing switch probability
            # Weight transitions based on current regime
            if current_regime in ("bull_trend", "strong_bull"):
                weights = [0.25, 0.15, 0.35, 0.15, 0.05, 0.05]
            elif current_regime == "ranging":
                weights = [0.25, 0.10, 0.30, 0.20, 0.05, 0.10]
            elif current_regime in ("bear_trend",):
                weights = [0.15, 0.05, 0.30, 0.25, 0.10, 0.15]
            elif current_regime == "selloff":
                weights = [0.10, 0.05, 0.15, 0.20, 0.20, 0.30]
            else:  # recovery
                weights = [0.30, 0.15, 0.25, 0.15, 0.05, 0.10]

            current_regime = random.choices(regime_names, weights=weights, k=1)[0]
            regime_duration = 0

        drift, vol_mult, _ = regimes[current_regime]
        hourly_vol = base_hourly_vol * vol_mult

        # Generate return with fat tails (mix of normal distributions)
        if random.random() < 0.05:  # 5% chance of tail event
            ret = random.gauss(drift, hourly_vol * 3)
        else:
            ret = random.gauss(drift, hourly_vol)

        # Compute OHLC
        open_price = price
        close_price = open_price * (1 + ret)

        # Generate realistic high/low
        intra_vol = abs(ret) + hourly_vol * random.uniform(0.3, 1.5)
        if close_price >= open_price:
            high = max(open_price, close_price) * (1 + random.uniform(0, intra_vol * 0.5))
            low = min(open_price, close_price) * (1 - random.uniform(0, intra_vol * 0.3))
        else:
            high = max(open_price, close_price) * (1 + random.uniform(0, intra_vol * 0.3))
            low = min(open_price, close_price) * (1 - random.uniform(0, intra_vol * 0.5))

        # Ensure OHLC constraints
        high = max(high, open_price, close_price)
        low = min(low, open_price, close_price)

        ts = start_ts + (h * 3600 * 1000)
        candles.append({
            "open_time": ts,
            "open": round(open_price, 2),
            "high": round(high, 2),
            "low": round(low, 2),
            "close": round(close_price, 2),
            "volume": round(random.uniform(500, 5000), 2),
            "close_time": ts + 3599999,
        })

        price = close_price

        # Mean reversion: gentle pull toward $50k center
        if price > 80000:
            price *= 0.9999
        elif price < 20000:
            price *= 1.0001

    print(f"Generated {len(candles)} synthetic hourly candles")
    print(f"  Start: ${candles[0]['open']:,.0f}  End: ${candles[-1]['close']:,.0f}")
    print(f"  Low: ${min(c['low'] for c in candles):,.0f}  High: ${max(c['high'] for c in candles):,.0f}")

    # Run multiple seeds for statistical robustness
    return candles


def generate_multi_seed_data(days=365, num_seeds=5):
    """Generate multiple price paths for Monte Carlo-style analysis."""
    all_paths = []
    for seed in range(num_seeds):
        candles = generate_realistic_btc_data(days=days, seed=seed * 17 + 42)
        all_paths.append(candles)
    return all_paths


# ──────────────────── INDICATORS (matches TypeScript) ────────────────────
def calc_sma(candles, period):
    if len(candles) < period:
        return 0
    return sum(c["close"] for c in candles[-period:]) / period

def calc_volatility(candle):
    if candle["open"] == 0:
        return 0
    return ((candle["high"] - candle["low"]) / candle["open"]) * 100

def calc_price_position(candle):
    rng = candle["high"] - candle["low"]
    if rng == 0:
        return 50
    return ((candle["close"] - candle["low"]) / rng) * 100

def calc_momentum_3h(candles, current_price):
    if len(candles) < 3:
        return 0
    three_ago = candles[-3]["close"]
    if three_ago == 0:
        return 0
    return ((current_price - three_ago) / three_ago) * 100

def calc_hour_return(candle, current_price):
    if candle["open"] == 0:
        return 0
    return ((current_price - candle["open"]) / candle["open"]) * 100


# ──────────────────── STRIKE CALC (matches TypeScript) ────────────────────
STRIKE_INCREMENT = 250

def calc_strike(btc_price, strike_type):
    if strike_type == "ATM":
        return round(btc_price / STRIKE_INCREMENT) * STRIKE_INCREMENT
    else:  # OTM
        return math.floor(btc_price / STRIKE_INCREMENT) * STRIKE_INCREMENT


# ──────────────────── FEES (matches TypeScript) ────────────────────
TAKER_FEE_PCT = 1.5

def calc_net_pnl(contracts, entry_price, exit_price, exit_type):
    entry_cost = contracts * entry_price
    entry_fee = entry_cost * (TAKER_FEE_PCT / 100)
    total_entry_cost = entry_cost + entry_fee

    exit_revenue = contracts * exit_price
    if exit_type == "early":
        exit_fee = exit_revenue * (TAKER_FEE_PCT / 100)
        return (exit_revenue - exit_fee) - total_entry_cost
    else:  # settlement
        return exit_revenue - total_entry_cost


# ──────────────────── RISK OF RUIN (matches TypeScript) ────────────────────
def calc_risk_of_ruin(current_price, strike, volatility, minutes_remaining):
    distance = current_price - strike
    time_hours = minutes_remaining / 60
    expected_move = current_price * (volatility / 100) * math.sqrt(max(time_hours, 0.01))

    if expected_move > 0:
        z = distance / expected_move
    else:
        z = 0

    # z-score lookup
    if z <= -2: ror = 0.98
    elif z <= -1: ror = 0.84
    elif z <= -0.5: ror = 0.69
    elif z <= 0: ror = 0.5
    elif z <= 0.5: ror = 0.31
    elif z <= 1: ror = 0.16
    elif z <= 1.5: ror = 0.07
    elif z <= 2: ror = 0.02
    else: ror = 0.01

    return ror


def estimate_contract_price(distance_from_strike, minutes_remaining):
    if distance_from_strike <= 0:
        return 0.30
    base = min(0.95, 0.5 + distance_from_strike / 1000)
    time_mult = 1 + (60 - minutes_remaining) / 120
    return min(0.99, base * time_mult)


# ──────────────────── STRATEGY SIGNALS ────────────────────
# Current deployed: both use loosened SMA, OTM strikes, intelligent exit

def check_conservative(candles, current_price, hour_utc, min_strike_distance=0):
    """Conservative signal (deployed config). min_strike_distance adds strike-awareness."""
    is_market = 14 <= hour_utc < 21
    sma3 = calc_sma(candles, 3)
    sma6 = calc_sma(candles, 6)
    sma12 = calc_sma(candles, 12)
    vol = calc_volatility(candles[-1])
    pos = calc_price_position(candles[-1])

    # Deployed: loosened SMA3 within 0.1% of SMA6
    short_trend = sma3 > sma6 or (sma6 > 0 and (sma6 - sma3) / sma6 < 0.001)
    medium_trend = sma6 > sma12
    vol_ok = 0.5 <= vol <= 2.0
    strong = pos > 60

    # Strike distance check (0 = disabled = current behavior)
    strike = calc_strike(current_price, "OTM")
    distance_to_strike = current_price - strike
    strike_ok = distance_to_strike >= min_strike_distance

    passed = is_market and short_trend and medium_trend and vol_ok and strong and strike_ok

    return {
        "signal": passed,
        "strike": strike if passed else None,
        "entry_price": 0.60,
        "contracts": math.floor(10 / 0.60),  # $10 position
        "checks": {
            "market_hours": is_market,
            "short_trend": short_trend,
            "medium_trend": medium_trend,
            "volatility": vol_ok,
            "position": strong,
            "strike_distance": strike_ok,
        },
        "values": {"sma3": sma3, "sma6": sma6, "sma12": sma12, "vol": vol, "pos": pos,
                    "strike_dist": distance_to_strike},
    }


def check_aggressive(candles, current_price, hour_utc, min_strike_distance=0):
    """Aggressive signal (deployed config). min_strike_distance adds strike-awareness."""
    is_market = 14 <= hour_utc < 21
    sma3 = calc_sma(candles, 3)
    sma6 = calc_sma(candles, 6)
    sma12 = calc_sma(candles, 12)
    mom = calc_momentum_3h(candles, current_price)
    hr = calc_hour_return(candles[-1], current_price)

    # Deployed: loosened SMA + momentum >1% + hour return >0.3%
    short_trend = sma3 > sma6 or (sma6 > 0 and (sma6 - sma3) / sma6 < 0.001)
    medium_trend = sma6 > sma12
    strong_mom = mom > 1.0
    hour_up = hr > 0.3

    # Strike distance check (0 = disabled = current behavior)
    strike = calc_strike(current_price, "OTM")
    distance_to_strike = current_price - strike
    strike_ok = distance_to_strike >= min_strike_distance

    passed = is_market and short_trend and medium_trend and strong_mom and hour_up and strike_ok

    return {
        "signal": passed,
        "strike": strike if passed else None,
        "entry_price": 0.40,
        "contracts": math.floor(20 / 0.40),  # $20 position @ $0.40
        "checks": {
            "market_hours": is_market,
            "short_trend": short_trend,
            "medium_trend": medium_trend,
            "momentum": strong_mom,
            "hour_return": hour_up,
            "strike_distance": strike_ok,
        },
        "values": {"sma3": sma3, "sma6": sma6, "sma12": sma12, "mom": mom, "hr": hr,
                    "strike_dist": distance_to_strike},
    }


# ──────────────────── TRADE SIMULATION ────────────────────
def simulate_trade(entry_price, strike, contracts, candles_after, volatility):
    """
    Simulate what happens during the hour after entry.
    Both strategies use intelligent exit (matches deployed autoTrader.ts).
    Checks at 30-min mark and 50-min mark for early exit conditions.
    """
    if not candles_after:
        return {"outcome": "no_data", "pnl": 0}

    settlement_candle = candles_after[0]  # next hour candle
    settlement_price = settlement_candle["close"]

    # ── CHECK AT 30 MIN MARK ──
    mid_price = (settlement_candle["open"] + settlement_candle["close"]) / 2
    distance_mid = mid_price - strike
    min_remaining = 30

    ror = calc_risk_of_ruin(mid_price, strike, volatility, min_remaining)
    implied_price = estimate_contract_price(distance_mid, min_remaining)

    early_exit_pnl = calc_net_pnl(contracts, entry_price, implied_price, "early")
    win_prob = 1 - ror
    settle_win_pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
    settle_lose_pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
    settle_ev = win_prob * settle_win_pnl + ror * settle_lose_pnl

    # Critical risk -> exit early
    if ror >= 0.5:
        return {
            "outcome": "early_exit_critical",
            "pnl": early_exit_pnl,
            "settlement_price": settlement_price,
            "exit_reason": "critical_risk",
        }

    # Negative EV to hold -> exit early
    if settle_ev < early_exit_pnl and early_exit_pnl > 0:
        return {
            "outcome": "early_exit_ev",
            "pnl": early_exit_pnl,
            "settlement_price": settlement_price,
            "exit_reason": "negative_ev_hold",
        }

    # ── CHECK AT 50 MIN MARK (10 min remaining) ──
    late_price = settlement_candle["close"]  # approximate
    late_distance = late_price - strike
    late_ror = calc_risk_of_ruin(late_price, strike, volatility, 10)

    if late_ror >= 0.3:
        late_implied = estimate_contract_price(late_distance, 10)
        late_exit_pnl = calc_net_pnl(contracts, entry_price, late_implied, "early")
        late_win_prob = 1 - late_ror
        late_settle_ev = late_win_prob * settle_win_pnl + late_ror * settle_lose_pnl
        if late_settle_ev <= late_exit_pnl * 1.2:
            return {
                "outcome": "early_exit_high_risk",
                "pnl": late_exit_pnl,
                "settlement_price": settlement_price,
                "exit_reason": "high_risk_late",
            }

    # ── HOLD TO SETTLEMENT ──
    if settlement_price > strike:
        pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
        return {"outcome": "win", "pnl": pnl, "settlement_price": settlement_price}
    else:
        pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
        return {"outcome": "loss", "pnl": pnl, "settlement_price": settlement_price}


# ──────────────────── MAIN BACKTEST ────────────────────
def run_backtest(candles, strategies):
    """Run strategy variants across the candle data."""

    results = {}
    for name in strategies:
        results[name] = {
            "signals": 0,
            "trades": 0,
            "wins": 0,
            "losses": 0,
            "early_exits": 0,
            "total_pnl": 0.0,
            "max_drawdown": 0.0,
            "pnl_series": [],
            "win_pnls": [],
            "loss_pnls": [],
            "monthly_signals": {},
            "criteria_fail_counts": {},
            "consecutive_losses_max": 0,
            "trade_details": [],
            "strike_dist_at_entry": [],
        }

    # Need at least 12 candles of history for indicators
    for i in range(12, len(candles) - 1):
        candle = candles[i]
        dt = datetime.fromtimestamp(candle["open_time"] / 1000, tz=timezone.utc)
        hour_utc = dt.hour
        current_price = candle["close"]
        history = candles[max(0, i - 12):i + 1]
        candles_after = candles[i + 1:]
        vol = calc_volatility(candle)
        month_key = dt.strftime("%Y-%m")

        for name, cfg in strategies.items():
            sig = cfg["fn"](history, current_price, hour_utc,
                           min_strike_distance=cfg.get("min_strike_dist", 0))
            r = results[name]

            if month_key not in r["monthly_signals"]:
                r["monthly_signals"][month_key] = 0

            if not sig["signal"]:
                for check_name, passed in sig["checks"].items():
                    if not passed:
                        r["criteria_fail_counts"][check_name] = r["criteria_fail_counts"].get(check_name, 0) + 1

            if sig["signal"]:
                r["signals"] += 1
                r["monthly_signals"][month_key] = r["monthly_signals"].get(month_key, 0) + 1
                r["strike_dist_at_entry"].append(sig["values"].get("strike_dist", 0))

                result = simulate_trade(
                    sig["entry_price"],
                    sig["strike"],
                    sig["contracts"],
                    candles_after[:2],
                    vol,
                )

                if result["outcome"] == "no_data":
                    continue

                r["trades"] += 1
                pnl = result["pnl"]
                r["total_pnl"] += pnl
                r["pnl_series"].append(r["total_pnl"])

                if "early_exit" in result["outcome"]:
                    r["early_exits"] += 1

                if pnl >= 0:
                    r["wins"] += 1
                    r["win_pnls"].append(pnl)
                else:
                    r["losses"] += 1
                    r["loss_pnls"].append(pnl)

                if r["pnl_series"]:
                    peak = max(r["pnl_series"])
                    dd = peak - r["total_pnl"]
                    if dd > r["max_drawdown"]:
                        r["max_drawdown"] = dd

                r["trade_details"].append({
                    "date": dt.isoformat(),
                    "price": current_price,
                    "strike": sig["strike"],
                    "strike_dist": sig["values"].get("strike_dist", 0),
                    "outcome": result["outcome"],
                    "pnl": pnl,
                })

    # Calculate consecutive losses
    for name, r in results.items():
        max_consec = 0
        current_consec = 0
        for t in r["trade_details"]:
            if t["pnl"] < 0:
                current_consec += 1
                max_consec = max(max_consec, current_consec)
            else:
                current_consec = 0
        r["consecutive_losses_max"] = max_consec

    return results


def aggregate_results(all_results):
    """Aggregate results across multiple Monte Carlo paths."""
    strategy_names = list(all_results[0].keys())
    agg = {}

    for name in strategy_names:
        runs = [r[name] for r in all_results]
        trades_list = [r["trades"] for r in runs]
        signals_list = [r["signals"] for r in runs]
        pnl_list = [r["total_pnl"] for r in runs]
        wr_list = [(r["wins"] / r["trades"] * 100) if r["trades"] > 0 else 0 for r in runs]
        dd_list = [r["max_drawdown"] for r in runs]
        early_list = [r["early_exits"] for r in runs]
        consec_list = [r["consecutive_losses_max"] for r in runs]

        avg_win_list = [(sum(r["win_pnls"]) / len(r["win_pnls"])) if r["win_pnls"] else 0 for r in runs]
        avg_loss_list = [(sum(r["loss_pnls"]) / len(r["loss_pnls"])) if r["loss_pnls"] else 0 for r in runs]
        pf_list = [abs(sum(r["win_pnls"]) / sum(r["loss_pnls"])) if r["loss_pnls"] and sum(r["loss_pnls"]) != 0 else 0 for r in runs]

        # Aggregate strike distance stats
        all_dists = []
        for r in runs:
            all_dists.extend(r.get("strike_dist_at_entry", []))
        avg_dist = sum(all_dists) / len(all_dists) if all_dists else 0
        min_dist = min(all_dists) if all_dists else 0
        median_dist = sorted(all_dists)[len(all_dists) // 2] if all_dists else 0

        n = len(runs)
        agg[name] = {
            "runs": n,
            "avg_signals": sum(signals_list) / n,
            "avg_trades": sum(trades_list) / n,
            "avg_win_rate": sum(wr_list) / n,
            "avg_pnl": sum(pnl_list) / n,
            "min_pnl": min(pnl_list),
            "max_pnl": max(pnl_list),
            "median_pnl": sorted(pnl_list)[n // 2],
            "avg_max_dd": sum(dd_list) / n,
            "worst_dd": max(dd_list),
            "avg_early_exits": sum(early_list) / n,
            "avg_max_consec_loss": sum(consec_list) / n,
            "avg_win_per_trade": sum(avg_win_list) / n,
            "avg_loss_per_trade": sum(avg_loss_list) / n,
            "avg_profit_factor": sum(pf_list) / n,
            "avg_expectancy": sum(pnl_list) / sum(trades_list) if sum(trades_list) > 0 else 0,
            "positive_runs": sum(1 for p in pnl_list if p > 0),
            "pnl_list": pnl_list,
            "wr_list": wr_list,
            "avg_strike_dist": avg_dist,
            "min_strike_dist": min_dist,
            "median_strike_dist": median_dist,
        }

    return agg


def print_monte_carlo_results(agg):
    """Print Monte Carlo aggregated results."""

    print("\n" + "=" * 120)
    print("  BTC HOURLY OPTIONS BACKTEST - CURRENT DEPLOYED vs STRIKE-AWARE")
    print("  Monte Carlo: 5 Price Paths, 1 Year Each")
    print("=" * 120)
    print("  Regime-switching synthetic data calibrated to real BTC volatility (~65% annualized)")
    print("  Both strategies use: loosened SMA, OTM strikes, intelligent exit logic")
    print("  Strike-aware variants add: minimum $N buffer above the $250-increment OTM strike")

    for name, a in agg.items():
        roi = a["avg_pnl"] / 100 * 100
        print(f"\n{'─' * 120}")
        print(f"  {name}")
        print(f"{'─' * 120}")
        print(f"  {'Avg Signals/Year:':<35} {a['avg_signals']:>8.0f}")
        print(f"  {'Avg Trades/Year:':<35} {a['avg_trades']:>8.0f}")
        print(f"  {'Avg Win Rate:':<35} {a['avg_win_rate']:>7.1f}%")
        print(f"  {'Avg Early Exits:':<35} {a['avg_early_exits']:>8.0f}")
        print(f"  {'Avg Max Consecutive Losses:':<35} {a['avg_max_consec_loss']:>8.1f}")
        print()
        print(f"  {'Avg Total P&L:':<35} ${a['avg_pnl']:>+8.2f}")
        print(f"  {'Best Path P&L:':<35} ${a['max_pnl']:>+8.2f}")
        print(f"  {'Worst Path P&L:':<35} ${a['min_pnl']:>+8.2f}")
        print(f"  {'Median Path P&L:':<35} ${a['median_pnl']:>+8.2f}")
        print(f"  {'Avg ROI ($100 start):':<35} {roi:>+7.1f}%")
        print(f"  {'Profitable Paths:':<35} {a['positive_runs']}/{a['runs']}")
        print(f"  {'Avg Max Drawdown:':<35} ${a['avg_max_dd']:>8.2f}")
        print(f"  {'Worst Drawdown:':<35} ${a['worst_dd']:>8.2f}")
        print(f"  {'Avg Win/Trade:':<35} ${a['avg_win_per_trade']:>+8.2f}")
        print(f"  {'Avg Loss/Trade:':<35} ${a['avg_loss_per_trade']:>+8.2f}")
        print(f"  {'Avg Profit Factor:':<35} {a['avg_profit_factor']:>8.2f}")
        print(f"  {'Avg Expectancy/Trade:':<35} ${a['avg_expectancy']:>+8.2f}")
        print(f"  {'Avg Strike Distance at Entry:':<35} ${a['avg_strike_dist']:>7.0f}")
        print(f"  {'Median Strike Distance:':<35} ${a['median_strike_dist']:>7.0f}")

    # ── HEAD-TO-HEAD ──
    # Group by strategy type for cleaner comparison
    cons_names = [n for n in agg if "Cons" in n or "Conservative" in n]
    aggr_names = [n for n in agg if "Aggr" in n or "Aggressive" in n]

    for group_label, group_names in [("CONSERVATIVE", cons_names), ("AGGRESSIVE", aggr_names)]:
        if not group_names:
            continue

        print(f"\n{'=' * 120}")
        print(f"  {group_label} - HEAD-TO-HEAD (AVERAGES ACROSS 5 PATHS)")
        print(f"{'=' * 120}")

        header = f"  {'Metric':<28}"
        for n in group_names:
            short = n.replace("Conservative ", "").replace("Aggressive ", "")
            header += f" {short:>18}"
        print(header)
        print(f"  {'─' * (28 + 19 * len(group_names))}")

        metrics = [
            ("Avg Signals/Year",  lambda a: f"{a['avg_signals']:.0f}"),
            ("Avg Trades/Year",   lambda a: f"{a['avg_trades']:.0f}"),
            ("Avg Win Rate",      lambda a: f"{a['avg_win_rate']:.1f}%"),
            ("Avg Total P&L",     lambda a: f"${a['avg_pnl']:+.2f}"),
            ("Avg ROI",           lambda a: f"{a['avg_pnl']/100*100:+.1f}%"),
            ("Best Path P&L",     lambda a: f"${a['max_pnl']:+.2f}"),
            ("Worst Path P&L",    lambda a: f"${a['min_pnl']:+.2f}"),
            ("Profitable Paths",  lambda a: f"{a['positive_runs']}/{a['runs']}"),
            ("Avg Max Drawdown",  lambda a: f"${a['avg_max_dd']:.2f}"),
            ("Avg Profit Factor", lambda a: f"{a['avg_profit_factor']:.2f}"),
            ("Avg Expectancy",    lambda a: f"${a['avg_expectancy']:+.2f}"),
            ("Avg Early Exits",   lambda a: f"{a['avg_early_exits']:.0f}"),
            ("Avg Strike Dist",   lambda a: f"${a['avg_strike_dist']:.0f}"),
        ]

        for label, fn in metrics:
            row = f"  {label:<28}"
            for n in group_names:
                row += f" {fn(agg[n]):>18}"
            print(row)

    # ── IMPACT OF STRIKE AWARENESS ──
    print(f"\n{'=' * 120}")
    print("  IMPACT OF STRIKE AWARENESS (Current Deployed -> Strike-Aware)")
    print(f"{'=' * 120}")
    print("  OTM strike = floor(price / $250) * $250")
    print("  Strike distance = price - OTM strike (ranges $0-$249)")
    print("  Strike-aware filters reject entries where distance < threshold")
    print()

    # Find the deployed vs strike-aware pairs
    for strat in ["Conservative", "Aggressive"]:
        deployed_name = f"{strat} (Deployed)"
        variants = [(n, agg[n]) for n in agg if n.startswith(strat) and n != deployed_name]
        if deployed_name not in agg:
            continue
        dep = agg[deployed_name]

        print(f"  {strat}:")
        print(f"    {'Variant':<30} {'Signals':>8} {'WinRate':>8} {'P&L':>10} {'Expect':>10} {'ProfFact':>10} {'Drawdown':>10}")
        print(f"    {'─' * 86}")

        # Print deployed first
        print(f"    {'Deployed (no filter)':<30} {dep['avg_signals']:>8.0f} {dep['avg_win_rate']:>7.1f}% ${dep['avg_pnl']:>+9.2f} ${dep['avg_expectancy']:>+9.2f} {dep['avg_profit_factor']:>10.2f} ${dep['avg_max_dd']:>9.2f}")

        for vname, va in sorted(variants, key=lambda x: x[1]["avg_pnl"], reverse=True):
            label = vname.replace(f"{strat} ", "")
            sig_delta = va["avg_signals"] - dep["avg_signals"]
            pnl_delta = va["avg_pnl"] - dep["avg_pnl"]
            print(f"    {label:<30} {va['avg_signals']:>8.0f} {va['avg_win_rate']:>7.1f}% ${va['avg_pnl']:>+9.2f} ${va['avg_expectancy']:>+9.2f} {va['avg_profit_factor']:>10.2f} ${va['avg_max_dd']:>9.2f}")
        print()

    print(f"{'=' * 120}")
    print("  METHODOLOGY & NOTES")
    print(f"{'=' * 120}")
    print("  Data: Regime-switching synthetic model (bull/bear/range/selloff/recovery)")
    print("  Calibration: ~65% annualized vol, ~0.9% base hourly vol, fat tails (5%)")
    print("  Monte Carlo: 5 independent price paths with different random seeds")
    print("  Conservative: $10 position, $0.60 entry, OTM strike, intelligent exit")
    print("  Aggressive: $20 position, $0.40 entry, OTM strike, intelligent exit")
    print("  Fees: 1.5% taker on entry + exit (early) or entry only (settlement)")
    print("  Market hours: 14:00-21:00 UTC only")
    print("  Both use: loosened SMA (within 0.1%), momentum >1%, hour return >0.3%")
    print("  Starting balance: $100")
    print("  $250 increments: OTM strike = floor(price/250)*250, distance = $0 to $249")
    print("  Strike-aware: requires price >= strike + $N before entering")
    print()


if __name__ == "__main__":
    NUM_PATHS = 5
    # Strike distance thresholds to test (in dollars)
    STRIKE_DISTANCES = [0, 50, 75, 100, 125, 150, 175]

    print("Running Monte Carlo backtest: Current Deployed vs Strike-Aware variants\n")
    print(f"Strike distance thresholds: {STRIKE_DISTANCES}")
    print(f"(0 = current deployed behavior, no filter)\n")

    all_paths = generate_multi_seed_data(days=365, num_seeds=NUM_PATHS)

    # Build strategy configs
    strategies = {}
    for dist in STRIKE_DISTANCES:
        if dist == 0:
            cons_label = "Conservative (Deployed)"
            aggr_label = "Aggressive (Deployed)"
        else:
            cons_label = f"Conservative (>=${dist})"
            aggr_label = f"Aggressive (>=${dist})"

        strategies[cons_label] = {
            "fn": check_conservative,
            "min_strike_dist": dist,
        }
        strategies[aggr_label] = {
            "fn": check_aggressive,
            "min_strike_dist": dist,
        }

    all_results = []
    for i, candles in enumerate(all_paths):
        date_start = datetime.fromtimestamp(candles[0]["open_time"] / 1000, tz=timezone.utc)
        date_end = datetime.fromtimestamp(candles[-1]["open_time"] / 1000, tz=timezone.utc)
        print(f"\nPath {i+1}: {date_start.strftime('%Y-%m-%d')} to {date_end.strftime('%Y-%m-%d')}")
        print(f"  Price: ${candles[0]['open']:,.0f} -> ${candles[-1]['close']:,.0f}")
        print(f"  Range: ${min(c['low'] for c in candles):,.0f} - ${max(c['high'] for c in candles):,.0f}")

        results = run_backtest(candles, strategies)
        all_results.append(results)

        # Quick summary per path
        for name, r in results.items():
            wr = (r['wins'] / r['trades'] * 100) if r['trades'] > 0 else 0
            print(f"    {name}: {r['signals']} sig, {r['trades']} trades, {wr:.0f}% WR, ${r['total_pnl']:+.2f}")

    agg = aggregate_results(all_results)
    print_monte_carlo_results(agg)
