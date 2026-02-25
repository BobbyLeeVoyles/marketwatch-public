#!/usr/bin/env python3
"""
Combined multi-signal backtest: mirrors the live aggressive.ts strategy exactly.

All 7 signals fire as OR gates (any one = trade), using the same parameters
as the deployed aggressive strategy. Starts with $100, tracks bankroll over
365 days × 10 Monte Carlo paths.

Runs TWO scenarios:
  A) With smart early exit (mid-hour sell at fair value)
  B) Hold-to-settlement only (more conservative, no mid-hour selling)
"""

import random
import math
import time


# ──── Reuse data generation and helpers from experiment ────

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
            "open": round(open_price, 2),
            "high": round(high, 2),
            "low": round(low, 2),
            "close": round(close_price, 2),
            "volume": round(volume, 2),
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

def calc_rolling_return(candles, current_price, lookback_hours):
    if len(candles) < lookback_hours + 1: return 0
    old_close = candles[-(lookback_hours + 1)]["close"]
    if old_close == 0: return 0
    return ((current_price - old_close) / old_close) * 100

def calc_volume_ratio(candles, lookback=6):
    if len(candles) < lookback + 2: return 1.0
    last_complete = candles[-2]
    prior = candles[-(lookback+2):-2]
    avg_vol = sum(c["volume"] for c in prior) / len(prior) if prior else 1
    if avg_vol == 0: return 1.0
    return last_complete["volume"] / avg_vol

def calc_dip_recovery(candles, current_price):
    if len(candles) < 3:
        return 0, 0, False
    two_prev = candles[-3]
    prev = candles[-2]
    if two_prev["close"] == 0 or prev["low"] == 0:
        return 0, 0, False
    dip_pct = ((prev["low"] - two_prev["close"]) / two_prev["close"]) * 100
    recovery_pct = ((current_price - prev["low"]) / prev["low"]) * 100
    is_bouncing = dip_pct < -0.1 and recovery_pct > 0.1
    return dip_pct, recovery_pct, is_bouncing

def crossed_above_psych_level(candles, current_price, increment):
    if len(candles) < 2: return False
    prev_close = candles[-2]["close"]
    level = math.ceil(prev_close / increment) * increment
    return prev_close < level <= current_price

def candle_volatility(candle):
    if candle["open"] == 0: return 0
    return ((candle["high"] - candle["low"]) / candle["open"]) * 100

def vol_expansion_ratio(candles):
    if len(candles) < 8: return 1.0
    curr_vol = candle_volatility(candles[-1])
    prior_vols = [candle_volatility(c) for c in candles[-7:-1]]
    avg_vol = sum(prior_vols) / len(prior_vols) if prior_vols else 1
    if avg_vol == 0: return 1.0
    return curr_vol / avg_vol


# ──── Strike & probability ────

STRIKE_INCREMENT = 250
TAKER_FEE_PCT = 1.5

def calc_strike(btc_price):
    return math.floor(btc_price / STRIKE_INCREMENT) * STRIKE_INCREMENT

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
    prob = normal_cdf(z)
    return max(0.01, min(0.99, prob))

def apply_pinning_discount(fair_value, btc_price, strike, mins_remaining):
    distance = btc_price - strike
    strike_mod_1000 = strike % 1000
    strike_mod_500 = strike % 500

    if distance < 0:
        abs_dist_pct = abs(distance) / btc_price * 100
        if abs_dist_pct < 0.5:
            pin_discount = 0.20
        elif abs_dist_pct < 1.0:
            pin_discount = 0.12
        else:
            pin_discount = 0.05
    elif distance < 200:
        pin_discount = 0.15
    else:
        pin_discount = 0.03

    if strike_mod_1000 == 0:
        pin_discount += 0.05
    elif strike_mod_500 == 0:
        pin_discount += 0.03

    if mins_remaining < 15:
        pin_discount *= 1.5
    elif mins_remaining < 30:
        pin_discount *= 1.2

    adjusted = fair_value * (1 - pin_discount)
    return max(0.01, min(adjusted, fair_value))

def calc_net_pnl(contracts, entry_price, exit_price, exit_type, fee_pct=TAKER_FEE_PCT):
    entry_cost = contracts * entry_price
    entry_fee = entry_cost * (fee_pct / 100)
    total_entry = entry_cost + entry_fee
    exit_revenue = contracts * exit_price
    if exit_type == "early":
        exit_fee = exit_revenue * (fee_pct / 100)
        return (exit_revenue - exit_fee) - total_entry
    return exit_revenue - total_entry


# ──── Exact aggressive.ts parameters ────

POSITION_SIZE = 20
MAX_ENTRY_PRICE = 0.25
MIN_TIME_REMAINING = 15
PROB_LO = 0.05
PROB_HI = 0.45
SMA_LOOSENESS = 0.003

ROLLING_MIN_RETURN = 0.20
DIP_MIN_PCT = -0.30
DIP_MIN_RECOVERY = 0.20
MULTI_MIN_1H = 0.10
MULTI_MIN_2H = 0.20
VOLUME_MIN_RATIO = 1.50
VOLUME_MIN_RETURN = 0.20
PSYCH_INCREMENT = 500
SELLOFF_MIN_DROP = -0.50
SELLOFF_MIN_BOUNCE = 0.20
VOL_EXPANSION_MIN = 1.80
VOL_EXPANSION_MIN_RET = 0.10


# ──── Combined signal check (mirrors aggressive.ts exactly) ────

def check_all_signals(candles, current_price, entry_minute=30):
    mins_remaining = 60 - entry_minute
    if mins_remaining <= MIN_TIME_REMAINING:
        return None
    if len(candles) < 12:
        return None

    sma3 = calc_sma(candles, 3)
    sma6 = calc_sma(candles, 6)
    sma12 = calc_sma(candles, 12)
    if 0 in (sma3, sma6, sma12):
        return None

    short_trend = sma3 > sma6 or (sma6 > 0 and (sma6 - sma3) / sma6 < SMA_LOOSENESS)
    med_trend = sma6 > sma12 or (sma12 > 0 and (sma12 - sma6) / sma12 < SMA_LOOSENESS)

    vol = calc_volatility(candles[-1])

    signal_name = None

    # 1. Rolling momentum
    ret1h = calc_rolling_return(candles, current_price, 1)
    if ret1h > ROLLING_MIN_RETURN and short_trend and med_trend:
        signal_name = "ROLLING_MOMENTUM"

    # 2. Dip recovery
    if not signal_name:
        dip_pct, rec_pct, bouncing = calc_dip_recovery(candles, current_price)
        if dip_pct < DIP_MIN_PCT and rec_pct > DIP_MIN_RECOVERY and bouncing:
            signal_name = "DIP_RECOVERY"

    # 3. Multi-hour momentum
    if not signal_name:
        r1h = calc_rolling_return(candles, current_price, 1)
        r2h = calc_rolling_return(candles, current_price, 2)
        if r1h > MULTI_MIN_1H and r2h > MULTI_MIN_2H and short_trend:
            signal_name = "MULTI_HOUR"

    # 4. Volume + momentum
    if not signal_name:
        vr = calc_volume_ratio(candles)
        r1h = calc_rolling_return(candles, current_price, 1)
        if vr >= VOLUME_MIN_RATIO and r1h > VOLUME_MIN_RETURN and short_trend:
            signal_name = "VOLUME_MOMENTUM"

    # 5. Psych level
    if not signal_name:
        if crossed_above_psych_level(candles, current_price, PSYCH_INCREMENT) and short_trend:
            signal_name = "PSYCH_LEVEL"

    # 6. Selloff recovery
    if not signal_name and len(candles) >= 4:
        c3h = candles[-4]
        c1h = candles[-2]
        if c3h["close"] > 0:
            selloff = ((c1h["close"] - c3h["close"]) / c3h["close"]) * 100
            bounce = calc_rolling_return(candles, current_price, 1)
            if selloff < SELLOFF_MIN_DROP and bounce > SELLOFF_MIN_BOUNCE:
                signal_name = "SELLOFF_RECOVERY"

    # 7. Vol expansion
    if not signal_name:
        exp_ratio = vol_expansion_ratio(candles)
        r1h = calc_rolling_return(candles, current_price, 1)
        if exp_ratio >= VOL_EXPANSION_MIN and r1h > VOL_EXPANSION_MIN_RET and short_trend:
            signal_name = "VOL_EXPANSION"

    if signal_name is None:
        return None

    floor_strike = calc_strike(current_price)
    strike = floor_strike + STRIKE_INCREMENT

    fv = estimate_fair_value(current_price, strike, vol, mins_remaining)
    if fv < PROB_LO or fv > PROB_HI:
        return None

    entry_price = min(MAX_ENTRY_PRICE, math.floor(fv * 100) / 100)
    if entry_price <= 0.01:
        return None

    contracts = math.floor(POSITION_SIZE / entry_price)
    if contracts <= 0:
        return None

    return (signal_name, strike, entry_price, contracts, fv, vol)


# ──── Trade simulation ────

def simulate_trade(entry_price, strike, contracts, current_candle, vol, rng,
                   entry_minute=30, use_exit=True):
    btc_price = current_candle["open"]
    mins_remaining = 60 - entry_minute

    raw_prob = estimate_fair_value(btc_price, strike, vol, mins_remaining)
    adj_prob = apply_pinning_discount(raw_prob, btc_price, strike, mins_remaining)

    won = rng.random() < adj_prob

    if use_exit:
        mid_move = rng.gauss(0, btc_price * (vol / 100) * math.sqrt(0.25))
        mid_price = btc_price + mid_move
        mid_fv = estimate_fair_value(mid_price, strike, vol, 30)

        early_exit_pnl = calc_net_pnl(contracts, entry_price, mid_fv, "early")
        settle_win_pnl = calc_net_pnl(contracts, entry_price, 1.0, "settlement")
        settle_lose_pnl = calc_net_pnl(contracts, entry_price, 0.0, "settlement")
        settle_ev = adj_prob * settle_win_pnl + (1 - adj_prob) * settle_lose_pnl

        if early_exit_pnl > settle_ev and early_exit_pnl > 0:
            return "early_exit", early_exit_pnl, adj_prob
    else:
        # Still consume RNG to keep paths identical
        rng.gauss(0, 1)

    if won:
        return "win", calc_net_pnl(contracts, entry_price, 1.0, "settlement"), adj_prob
    else:
        return "loss", calc_net_pnl(contracts, entry_price, 0.0, "settlement"), adj_prob


# ──── Run one full year backtest ────

def run_year(candles, path_seed=0, use_exit=True):
    rng = random.Random(hash(("combined", path_seed)) & 0xFFFFFFFF)

    bankroll = 100.0
    peak_bank = 100.0
    min_bank = 100.0
    max_dd = 0.0
    peak_pnl = 0.0
    total_pnl = 0.0
    trades = 0
    wins = 0
    losses = 0
    early_exits = 0
    ruin_hit = False
    last_trade_hour = -999
    signal_counts = {}
    all_probs = []

    for i in range(13, len(candles)):
        current_candle = candles[i]
        current_price = current_candle["open"]
        history = candles[max(0, i - 13):i]

        if i - last_trade_hour < 1:
            continue

        if bankroll < POSITION_SIZE * 0.5:
            ruin_hit = True
            continue

        entry_minute = 30
        sig = check_all_signals(history, current_price, entry_minute)

        if sig is None:
            continue

        signal_name, strike, entry_price, contracts, fv, vol = sig

        result_type, pnl, adj_prob = simulate_trade(
            entry_price, strike, contracts, current_candle, vol, rng,
            entry_minute, use_exit=use_exit
        )

        trades += 1
        total_pnl += pnl
        bankroll += pnl
        last_trade_hour = i
        all_probs.append(adj_prob)

        signal_counts[signal_name] = signal_counts.get(signal_name, 0) + 1

        if "early_exit" in result_type:
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
        if bankroll < min_bank:
            min_bank = bankroll

    wr = (wins / trades * 100) if trades > 0 else 0
    exp = (total_pnl / trades) if trades > 0 else 0
    avg_prob = sum(all_probs) / len(all_probs) if all_probs else 0

    return {
        "trades": trades,
        "wins": wins,
        "losses": losses,
        "early_exits": early_exits,
        "win_rate": wr,
        "total_pnl": total_pnl,
        "final_bankroll": bankroll,
        "peak_bankroll": peak_bank,
        "min_bankroll": min_bank,
        "max_dd": max_dd,
        "expectancy": exp,
        "ruin_hit": ruin_hit,
        "signal_counts": signal_counts,
        "avg_prob": avg_prob,
    }


# ──── Display helper ────

def print_results(title, results):
    n = len(results)

    print(f"\n{'─' * 100}")
    print(f"  {title}")
    print(f"{'─' * 100}")
    print(f"  {'Path':>6}  {'Trades':>7}  {'WR':>6}  {'$/Trade':>9}  "
          f"{'Total P&L':>11}  {'Final $':>9}  {'Min $':>8}  {'Max DD':>8}  {'Ruin':>5}  {'AvgProb':>7}")
    print(f"  {'─' * 93}")

    for i, r in enumerate(results):
        print(f"  {i+1:>6}  {r['trades']:>7}  {r['win_rate']:>5.1f}%  "
              f"${r['expectancy']:>+7.2f}  ${r['total_pnl']:>+10.2f}  "
              f"${r['final_bankroll']:>8.2f}  ${r['min_bankroll']:>7.2f}  "
              f"${r['max_dd']:>7.2f}  {'YES' if r['ruin_hit'] else 'no':>5}  "
              f"{r['avg_prob']*100:>5.1f}%")

    avg_trades = sum(r["trades"] for r in results) / n
    avg_wr = sum(r["win_rate"] for r in results) / n
    avg_pnl = sum(r["total_pnl"] for r in results) / n
    avg_bank = sum(r["final_bankroll"] for r in results) / n
    avg_dd = sum(r["max_dd"] for r in results) / n
    avg_exp = sum(r["expectancy"] for r in results) / n
    worst_bank = min(r["final_bankroll"] for r in results)
    best_bank = max(r["final_bankroll"] for r in results)
    worst_min = min(r["min_bankroll"] for r in results)
    ruin_count = sum(1 for r in results if r["ruin_hit"])
    median_bank = sorted(r["final_bankroll"] for r in results)[n // 2]
    avg_prob = sum(r["avg_prob"] for r in results) / n
    avg_early = sum(r["early_exits"] for r in results) / n
    profitable = sum(1 for r in results if r["final_bankroll"] > 100)

    print(f"  {'─' * 93}")
    print(f"  {'AVG':>6}  {avg_trades:>7.0f}  {avg_wr:>5.1f}%  "
          f"${avg_exp:>+7.2f}  ${avg_pnl:>+10.2f}  "
          f"${avg_bank:>8.2f}  ${worst_min:>7.2f}  "
          f"${avg_dd:>7.2f}  {ruin_count}/{n:>4}  "
          f"{avg_prob*100:>5.1f}%")

    print(f"\n  $100 → avg ${avg_bank:.2f}  |  median ${median_bank:.2f}  |  "
          f"best ${best_bank:.2f}  |  worst ${worst_bank:.2f}")
    print(f"  Trades/yr: {avg_trades:.0f} ({avg_trades/52:.1f}/wk)  |  "
          f"Early exits/yr: {avg_early:.0f} ({avg_early/avg_trades*100:.0f}% of trades)")
    print(f"  Profitable: {profitable}/{n} paths  |  Ruin: {ruin_count}/{n}  |  "
          f"Lowest ever: ${worst_min:.2f}")
    print(f"  Avg model probability: {avg_prob*100:.1f}% (this is the TRUE win rate w/o early exit)")

    return avg_bank, median_bank, avg_trades, avg_wr, avg_exp


# ──── Main ────

if __name__ == "__main__":
    NUM_PATHS = 10
    start = time.time()

    print("=" * 100)
    print("  COMBINED MULTI-SIGNAL BACKTEST — HONEST COMPARISON")
    print(f"  Starting capital: $100 | Position size: ${POSITION_SIZE} | 7 signals (OR)")
    print(f"  {NUM_PATHS} Monte Carlo paths × 365 days")
    print(f"  Scenario A: WITH smart early exit (sell mid-hour at fair value)")
    print(f"  Scenario B: HOLD to settlement only (no mid-hour selling)")
    print("=" * 100)

    # Generate paths
    print("\n  Generating price paths...")
    all_paths = []
    for seed_idx in range(NUM_PATHS):
        candles = generate_realistic_btc_data(days=365, seed=seed_idx * 17 + 42)
        lo = min(c["low"] for c in candles)
        hi = max(c["high"] for c in candles)
        final = candles[-1]["close"]
        print(f"    Path {seed_idx+1}: ${candles[0]['open']:,.0f} → ${final:,.0f} "
              f"(range ${lo:,.0f}–${hi:,.0f})")
        all_paths.append(candles)

    # ════════════════════════════════════════════
    # Scenario A: With smart early exit
    # ════════════════════════════════════════════
    print(f"\n  Running Scenario A (with early exit)...")
    results_a = []
    for path_idx, candles in enumerate(all_paths):
        r = run_year(candles, path_seed=path_idx, use_exit=True)
        results_a.append(r)

    avg_a, med_a, trades_a, wr_a, exp_a = print_results(
        "SCENARIO A: WITH SMART EARLY EXIT", results_a)

    # Signal breakdown for scenario A
    total_sig = {}
    for r in results_a:
        for sig, cnt in r["signal_counts"].items():
            total_sig[sig] = total_sig.get(sig, 0) + cnt
    print(f"\n  Signal breakdown:")
    for sig in sorted(total_sig.keys(), key=lambda k: total_sig[k], reverse=True):
        avg_cnt = total_sig[sig] / NUM_PATHS
        pct = (total_sig[sig] / sum(total_sig.values())) * 100
        print(f"    {sig:<22}  {avg_cnt:>6.1f}/yr ({avg_cnt/52:.1f}/wk)  {pct:>5.1f}%")

    # ════════════════════════════════════════════
    # Scenario B: Hold to settlement only
    # ════════════════════════════════════════════
    print(f"\n  Running Scenario B (hold to settlement)...")
    results_b = []
    for path_idx, candles in enumerate(all_paths):
        r = run_year(candles, path_seed=path_idx, use_exit=False)
        results_b.append(r)

    avg_b, med_b, trades_b, wr_b, exp_b = print_results(
        "SCENARIO B: HOLD TO SETTLEMENT (NO EARLY EXIT)", results_b)

    # ════════════════════════════════════════════
    # COMPARISON
    # ════════════════════════════════════════════
    print(f"\n{'=' * 100}")
    print(f"  HEAD-TO-HEAD COMPARISON")
    print(f"{'=' * 100}")
    print(f"  {'':>30}  {'With Exit':>15}  {'Hold Only':>15}  {'Difference':>15}")
    print(f"  {'─' * 78}")
    print(f"  {'Avg final bankroll':>30}  ${avg_a:>13.2f}  ${avg_b:>13.2f}  ${avg_a-avg_b:>+13.2f}")
    print(f"  {'Median final bankroll':>30}  ${med_a:>13.2f}  ${med_b:>13.2f}  ${med_a-med_b:>+13.2f}")
    print(f"  {'Avg trades/year':>30}  {trades_a:>13.0f}  {trades_b:>13.0f}")
    print(f"  {'Avg win rate':>30}  {wr_a:>12.1f}%  {wr_b:>12.1f}%")
    print(f"  {'Avg $/trade':>30}  ${exp_a:>+12.2f}  ${exp_b:>+12.2f}")
    print(f"  {'Ruin paths':>30}  "
          f"{sum(1 for r in results_a if r['ruin_hit'])}/{NUM_PATHS:>11}  "
          f"{sum(1 for r in results_b if r['ruin_hit'])}/{NUM_PATHS:>11}")

    # ════════════════════════════════════════════
    # REALITY CHECK
    # ════════════════════════════════════════════
    avg_prob = sum(r["avg_prob"] for r in results_a) / NUM_PATHS
    print(f"\n{'=' * 100}")
    print(f"  REALITY CHECK — WHY THESE NUMBERS ARE HIGH")
    print(f"{'=' * 100}")
    print(f"  1. Signal frequency: {trades_a:.0f} trades/yr = {trades_a/52:.1f}/week = {trades_a/365:.1f}/day")
    print(f"     The sim checks every hour with 0.9% base hourly vol — real BTC vol is ~0.3-0.5%")
    print(f"     In practice, signals would fire 30-50% less often than simulated")
    print(f"")
    print(f"  2. Model win probability: avg {avg_prob*100:.1f}% per trade (with pinning discount)")
    print(f"     This is the raw settlement probability. WITHOUT early exit, WR = {wr_b:.1f}%")
    print(f"     WITH early exit, WR = {wr_a:.1f}% (early exits capture favorable mid-hour moves)")
    print(f"")
    print(f"  3. Early exit assumes you can sell at fair value mid-hour")
    print(f"     In practice: bid-ask spread + slippage would reduce early exit profits")
    print(f"     The 'hold only' scenario is more conservative / realistic")
    print(f"")
    print(f"  4. Position sizing is FLAT $20 per trade (not compounding)")
    print(f"     Even at $50K bankroll, each trade still only risks $20")
    print(f"     So the returns scale linearly with trade count, not exponentially")
    print(f"")

    # Conservative estimate
    real_freq_mult = 0.40  # Real BTC vol is ~40-50% of simulated
    real_trades = trades_b * real_freq_mult
    real_pnl = exp_b * real_trades  # Use hold-only expectancy
    print(f"  ──────────────────────────────────────────────────────")
    print(f"  CONSERVATIVE REAL-WORLD ESTIMATE (hold-only, 40% freq):")
    print(f"  ──────────────────────────────────────────────────────")
    print(f"  Estimated trades/year:    {real_trades:.0f} ({real_trades/52:.1f}/week)")
    print(f"  Per-trade expectancy:     ${exp_b:+.2f}")
    print(f"  Estimated annual P&L:     ${real_pnl:+.2f}")
    print(f"  Estimated final bankroll: ${100 + real_pnl:.2f}")
    print(f"  Estimated annual return:  {real_pnl:+.1f}%")

    elapsed = time.time() - start
    print(f"\n  Runtime: {elapsed:.1f}s")
    print()
