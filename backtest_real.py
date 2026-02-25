#!/usr/bin/env python3
"""
Backtest: Conservative & Aggressive strategies with BANKROLL tracking.
Uses the calibrated regime-switching synthetic BTC model (same as original backtest)
since external APIs are unavailable. Runs 10 independent price paths for robustness.
"""

import random
import math
from datetime import datetime, timezone, timedelta

# ============================================================
# STRATEGY PARAMETERS (exact match to codebase)
# ============================================================
STRIKE_INCREMENT = 250
MIN_STRIKE_DISTANCE = 50
TAKER_FEE_RATE = 0.015  # 1.5%

CONS_ENTRY_PRICE = 0.60
CONS_POSITION_SIZE = 10.00

AGG_ENTRY_PRICE = 0.40
AGG_POSITION_SIZE = 20.00

MARKET_OPEN_UTC = 14
MARKET_CLOSE_UTC = 21


# ============================================================
# SYNTHETIC DATA (calibrated to real BTC stats)
# ============================================================
def generate_btc_data(days=365, seed=42):
    random.seed(seed)
    candles = []
    hours = days * 24
    price = 42000.0

    regimes = {
        "bull_trend":  (0.0004,  0.8),
        "strong_bull": (0.0008,  1.2),
        "ranging":     (0.0000,  0.6),
        "bear_trend":  (-0.0003, 1.0),
        "selloff":     (-0.0010, 2.0),
        "recovery":    (0.0006,  1.5),
    }
    regime_names = list(regimes.keys())
    current_regime = "bull_trend"
    regime_duration = 0
    base_hourly_vol = 0.009  # ~65% annualized

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

        open_p = price
        close_p = open_p * (1 + ret)
        intra_vol = abs(ret) + hourly_vol * random.uniform(0.3, 1.5)
        if close_p >= open_p:
            high = max(open_p, close_p) * (1 + random.uniform(0, intra_vol * 0.5))
            low = min(open_p, close_p) * (1 - random.uniform(0, intra_vol * 0.3))
        else:
            high = max(open_p, close_p) * (1 + random.uniform(0, intra_vol * 0.3))
            low = min(open_p, close_p) * (1 - random.uniform(0, intra_vol * 0.5))

        high = max(high, open_p, close_p)
        low = min(low, open_p, close_p)

        ts = start_ts + (h * 3600 * 1000)
        candles.append({
            "ts": ts,
            "open": round(open_p, 2),
            "high": round(high, 2),
            "low": round(low, 2),
            "close": round(close_p, 2),
            "dt": datetime.fromtimestamp(ts / 1000, tz=timezone.utc),
        })
        price = close_p
        if price > 80000:
            price *= 0.9999
        elif price < 20000:
            price *= 1.0001

    return candles


# ============================================================
# INDICATORS (exact match to TypeScript codebase)
# ============================================================
def sma(closes, period):
    if len(closes) < period:
        return 0
    return sum(closes[-period:]) / period

def volatility(c):
    if c["open"] == 0: return 0
    return ((c["high"] - c["low"]) / c["open"]) * 100

def price_position(c):
    r = c["high"] - c["low"]
    if r == 0: return 50
    return ((c["close"] - c["low"]) / r) * 100

def momentum_3h(cur, closes):
    if len(closes) < 3: return 0
    if closes[-3] == 0: return 0
    return ((cur - closes[-3]) / closes[-3]) * 100

def hour_return_max(c):
    if c["open"] == 0: return 0
    return ((c["high"] - c["open"]) / c["open"]) * 100


# ============================================================
# STRIKE
# ============================================================
def otm_strike(price):
    return math.floor(price / STRIKE_INCREMENT) * STRIKE_INCREMENT


# ============================================================
# EXIT MODEL (matches exitLogic.ts)
# ============================================================
def risk_of_ruin(price, strike, vol_pct, mins):
    dist = price - strike
    t = max(mins / 60, 0.01)
    em = price * (vol_pct / 100) * math.sqrt(t)
    z = dist / em if em > 0 else 0
    if z <= -2:   return 0.98
    elif z <= -1:  return 0.84
    elif z <= -0.5: return 0.69
    elif z <= 0:   return 0.50
    elif z <= 0.5: return 0.31
    elif z <= 1:   return 0.16
    elif z <= 1.5: return 0.07
    elif z <= 2:   return 0.02
    else:          return 0.01

def implied_price(dist, mins):
    if dist <= 0: return 0.30
    base = min(0.95, 0.5 + dist / 1000)
    return min(0.99, base * (1 + (60 - mins) / 120))

def calc_pnl(contracts, entry, exit_px, is_settle):
    cost = contracts * entry
    fee = cost * TAKER_FEE_RATE
    total = cost + fee
    rev = contracts * exit_px
    if not is_settle:
        rev -= rev * TAKER_FEE_RATE
    return rev - total

def simulate_exit(entry_px, strike, contracts, next_c, vol):
    settle_px = next_c["open"]
    mid = (next_c["open"] + next_c["close"]) / 2
    ror30 = risk_of_ruin(mid, strike, vol, 30)
    imp30 = implied_price(mid - strike, 30)
    early30 = calc_pnl(contracts, entry_px, imp30, False)
    win_pnl = calc_pnl(contracts, entry_px, 1.0, True)
    lose_pnl = calc_pnl(contracts, entry_px, 0.0, True)
    ev = (1 - ror30) * win_pnl + ror30 * lose_pnl

    if ror30 >= 0.50:
        return early30, "early_critical"
    if ev < early30 and early30 > 0:
        return early30, "early_neg_ev"

    late = next_c["close"]
    ror10 = risk_of_ruin(late, strike, vol, 10)
    if ror10 >= 0.30:
        imp10 = implied_price(late - strike, 10)
        late_pnl = calc_pnl(contracts, entry_px, imp10, False)
        late_ev = (1 - ror10) * win_pnl + ror10 * lose_pnl
        if late_ev <= late_pnl * 1.2:
            return late_pnl, "early_high_risk"

    if settle_px > strike:
        return calc_pnl(contracts, entry_px, 1.0, True), "win"
    else:
        return calc_pnl(contracts, entry_px, 0.0, True), "loss"


# ============================================================
# STRATEGY CHECKS
# ============================================================
def check_conservative(candle, prev_closes, prev_c):
    h = candle["dt"].hour
    if h < MARKET_OPEN_UTC or h >= MARKET_CLOSE_UTC:
        return False, None
    s3, s6, s12 = sma(prev_closes, 3), sma(prev_closes, 6), sma(prev_closes, 12)
    if 0 in (s3, s6, s12): return False, None
    if not (s3 >= s6 or (s6 - s3) / s6 < 0.001): return False, None
    if s6 <= s12: return False, None
    v = volatility(prev_c)
    if not (0.5 <= v <= 2.0): return False, None
    if price_position(prev_c) <= 60: return False, None
    p = candle["open"]
    st = otm_strike(p)
    if p - st < MIN_STRIKE_DISTANCE: return False, None
    return True, {"strike": st, "dist": p - st, "vol": v}


def check_aggressive(candle, prev_closes, prev_c):
    h = candle["dt"].hour
    if h < MARKET_OPEN_UTC or h >= MARKET_CLOSE_UTC:
        return False, None
    s3, s6, s12 = sma(prev_closes, 3), sma(prev_closes, 6), sma(prev_closes, 12)
    if 0 in (s3, s6, s12): return False, None
    if not (s3 >= s6 or (s6 - s3) / s6 < 0.001): return False, None
    if s6 <= s12: return False, None
    mom = momentum_3h(candle["open"], prev_closes)
    if mom <= 1.0: return False, None
    if hour_return_max(candle) <= 0.3: return False, None
    p = candle["open"]
    st = otm_strike(p)
    if p - st < MIN_STRIKE_DISTANCE: return False, None
    return True, {"strike": st, "dist": p - st, "vol": volatility(prev_c), "mom": mom}


# ============================================================
# BANKROLL-TRACKED BACKTEST
# ============================================================
def run(candles, start_bank):
    cons = {"bank": start_bank, "trades": [], "w": 0, "l": 0, "early": 0,
            "peak": start_bank, "trough": start_bank, "monthly": {}}
    agg  = {"bank": start_bank, "trades": [], "w": 0, "l": 0, "early": 0,
            "peak": start_bank, "trough": start_bank, "monthly": {}}

    for i in range(12, len(candles) - 1):
        c = candles[i]
        pc = candles[i - 1]
        nc = candles[i + 1]
        prev_cl = [x["close"] for x in candles[max(0, i-12):i]]
        mk = c["dt"].strftime("%Y-%m")

        # Conservative
        if cons["bank"] >= 1.0:
            ok, info = check_conservative(c, prev_cl, pc)
            if ok:
                ps = min(CONS_POSITION_SIZE, cons["bank"] / (1 + TAKER_FEE_RATE))
                ct = math.floor(ps / CONS_ENTRY_PRICE)
                if ct > 0:
                    pnl, out = simulate_exit(CONS_ENTRY_PRICE, info["strike"], ct, nc, info["vol"])
                    cons["bank"] += pnl
                    cons["peak"] = max(cons["peak"], cons["bank"])
                    cons["trough"] = min(cons["trough"], cons["bank"])
                    won = out == "win" or (out.startswith("early") and pnl >= 0)
                    if won: cons["w"] += 1
                    else: cons["l"] += 1
                    if out.startswith("early"): cons["early"] += 1
                    cons["trades"].append({"d": c["dt"].strftime("%m/%d %H:%M"),
                        "btc": c["open"], "st": info["strike"], "dist": info["dist"],
                        "ct": ct, "out": out, "pnl": pnl, "bk": cons["bank"]})
                    if mk not in cons["monthly"]:
                        cons["monthly"][mk] = {"pnl": 0, "w": 0, "l": 0}
                    cons["monthly"][mk]["pnl"] += pnl
                    cons["monthly"][mk]["w" if won else "l"] += 1

        # Aggressive
        if agg["bank"] >= 1.0:
            ok, info = check_aggressive(c, prev_cl, pc)
            if ok:
                ps = min(AGG_POSITION_SIZE, agg["bank"] / (1 + TAKER_FEE_RATE))
                ct = math.floor(ps / AGG_ENTRY_PRICE)
                if ct > 0:
                    pnl, out = simulate_exit(AGG_ENTRY_PRICE, info["strike"], ct, nc, info["vol"])
                    agg["bank"] += pnl
                    agg["peak"] = max(agg["peak"], agg["bank"])
                    agg["trough"] = min(agg["trough"], agg["bank"])
                    won = out == "win" or (out.startswith("early") and pnl >= 0)
                    if won: agg["w"] += 1
                    else: agg["l"] += 1
                    if out.startswith("early"): agg["early"] += 1
                    agg["trades"].append({"d": c["dt"].strftime("%m/%d %H:%M"),
                        "btc": c["open"], "st": info["strike"], "dist": info["dist"],
                        "ct": ct, "out": out, "pnl": pnl, "bk": agg["bank"]})
                    if mk not in agg["monthly"]:
                        agg["monthly"][mk] = {"pnl": 0, "w": 0, "l": 0}
                    agg["monthly"][mk]["pnl"] += pnl
                    agg["monthly"][mk]["w" if won else "l"] += 1

    return cons, agg


def report(label, d, sb):
    t = d["w"] + d["l"]
    wr = (d["w"] / t * 100) if t > 0 else 0
    ret = ((d["bank"] - sb) / sb) * 100
    dd = d["peak"] - d["trough"]

    print(f"\n{'─' * 72}")
    print(f"  {label}")
    print(f"{'─' * 72}")
    print(f"  Starting Bankroll:  ${sb:.2f}")
    print(f"  Final Bankroll:     ${d['bank']:.2f}")
    print(f"  Total Return:       {ret:+.1f}%")
    print(f"  Total Trades:       {t}")
    print(f"  Wins / Losses:      {d['w']} / {d['l']}  ({wr:.1f}% win rate)")
    print(f"  Early Exits:        {d['early']}")
    print(f"  Peak Bankroll:      ${d['peak']:.2f}")
    print(f"  Low Point:          ${d['trough']:.2f}")
    print(f"  Max Drawdown:       ${dd:.2f}")

    wp = [x["pnl"] for x in d["trades"] if x["pnl"] >= 0]
    lp = [x["pnl"] for x in d["trades"] if x["pnl"] < 0]
    if wp: print(f"  Avg Win:            ${sum(wp)/len(wp):.2f}")
    if lp: print(f"  Avg Loss:           ${sum(lp)/len(lp):.2f}")

    if d["monthly"]:
        print(f"\n  {'Month':<10} {'Trades':>6} {'W':>4} {'L':>4} {'P&L':>10} {'Cum P&L':>10}")
        cum = 0
        for mk in sorted(d["monthly"]):
            m = d["monthly"][mk]
            tot = m["w"] + m["l"]
            cum += m["pnl"]
            print(f"  {mk:<10} {tot:>6} {m['w']:>4} {m['l']:>4} ${m['pnl']:>+9.2f} ${cum:>+9.2f}")

    if d["trades"]:
        n = min(20, len(d["trades"]))
        print(f"\n  Last {n} Trades:")
        print(f"  {'Date':<14} {'BTC':>9} {'Strike':>8} {'Dist':>5} {'Ct':>4} {'Outcome':<16} {'P&L':>8} {'Bank':>9}")
        for x in d["trades"][-n:]:
            print(f"  {x['d']:<14} ${x['btc']:>8,.0f} ${x['st']:>7,} ${x['dist']:>4.0f} {x['ct']:>4} {x['out']:<16} ${x['pnl']:>+7.2f} ${x['bk']:>8.2f}")


def main():
    SEEDS = 10
    DAYS = 365

    print("=" * 72)
    print("  MARKETWATCH BACKTEST - 1 YEAR - 10 PRICE PATHS")
    print("  Regime-switching synthetic BTC (~65% annualized vol)")
    print("  Same model used to calibrate the trading strategies")
    print("=" * 72)

    all_cons_100 = []
    all_agg_100 = []
    all_cons_5 = []
    all_agg_5 = []

    for s in range(SEEDS):
        seed = s * 17 + 42
        candles = generate_btc_data(days=DAYS, seed=seed)
        lo = min(c["low"] for c in candles)
        hi = max(c["high"] for c in candles)
        print(f"\n  Path {s+1} (seed {seed}): ${candles[0]['open']:,.0f} -> ${candles[-1]['close']:,.0f}  "
              f"(range ${lo:,.0f}-${hi:,.0f})")

        c100, a100 = run(candles, 100.0)
        c5, a5 = run(candles, 5.0)

        t100c = c100["w"] + c100["l"]
        t100a = a100["w"] + a100["l"]
        wr100c = (c100["w"]/t100c*100) if t100c else 0
        wr100a = (a100["w"]/t100a*100) if t100a else 0

        print(f"    $100 Conservative: {t100c} trades, {wr100c:.0f}% WR, ${c100['bank']:.2f} final")
        print(f"    $100 Aggressive:   {t100a} trades, {wr100a:.0f}% WR, ${a100['bank']:.2f} final")

        t5c = c5["w"] + c5["l"]
        t5a = a5["w"] + a5["l"]
        wr5c = (c5["w"]/t5c*100) if t5c else 0
        wr5a = (a5["w"]/t5a*100) if t5a else 0
        print(f"    $5   Conservative: {t5c} trades, {wr5c:.0f}% WR, ${c5['bank']:.2f} final")
        print(f"    $5   Aggressive:   {t5a} trades, {wr5a:.0f}% WR, ${a5['bank']:.2f} final")

        all_cons_100.append(c100)
        all_agg_100.append(a100)
        all_cons_5.append(c5)
        all_agg_5.append(a5)

    # ---- DETAILED REPORT: Best and worst paths for $100 ----
    best_cons = max(all_cons_100, key=lambda x: x["bank"])
    worst_cons = min(all_cons_100, key=lambda x: x["bank"])
    best_agg = max(all_agg_100, key=lambda x: x["bank"])
    worst_agg = min(all_agg_100, key=lambda x: x["bank"])

    report("CONSERVATIVE - BEST PATH ($100)", best_cons, 100)
    report("CONSERVATIVE - WORST PATH ($100)", worst_cons, 100)
    report("AGGRESSIVE - BEST PATH ($100)", best_agg, 100)
    report("AGGRESSIVE - WORST PATH ($100)", worst_agg, 100)

    # ---- DETAILED REPORT: Best path for $5 ----
    best_c5 = max(all_cons_5, key=lambda x: x["bank"])
    best_a5 = max(all_agg_5, key=lambda x: x["bank"])
    worst_c5 = min(all_cons_5, key=lambda x: x["bank"])
    worst_a5 = min(all_agg_5, key=lambda x: x["bank"])

    report("CONSERVATIVE - BEST PATH ($5)", best_c5, 5)
    report("AGGRESSIVE - BEST PATH ($5)", best_a5, 5)

    # ---- AGGREGATE SUMMARY ----
    print(f"\n{'=' * 72}")
    print(f"  AGGREGATE SUMMARY ACROSS 10 PRICE PATHS")
    print(f"{'=' * 72}")

    for label, data_list, sb in [
        ("CONSERVATIVE $100", all_cons_100, 100),
        ("AGGRESSIVE $100", all_agg_100, 100),
        ("CONSERVATIVE $5", all_cons_5, 5),
        ("AGGRESSIVE $5", all_agg_5, 5),
    ]:
        banks = [d["bank"] for d in data_list]
        trades = [d["w"] + d["l"] for d in data_list]
        wrs = [(d["w"] / (d["w"] + d["l"]) * 100) if (d["w"] + d["l"]) > 0 else 0 for d in data_list]
        rets = [((d["bank"] - sb) / sb * 100) for d in data_list]

        avg_bank = sum(banks) / len(banks)
        avg_trades = sum(trades) / len(trades)
        avg_wr = sum(wrs) / len(wrs)
        avg_ret = sum(rets) / len(rets)
        med_bank = sorted(banks)[len(banks) // 2]
        profitable = sum(1 for b in banks if b > sb)

        print(f"\n  {label}:")
        print(f"    Avg Final Bankroll:  ${avg_bank:.2f}")
        print(f"    Median Final:        ${med_bank:.2f}")
        print(f"    Best Final:          ${max(banks):.2f}")
        print(f"    Worst Final:         ${min(banks):.2f}")
        print(f"    Avg Return:          {avg_ret:+.1f}%")
        print(f"    Avg Trades/Year:     {avg_trades:.0f}")
        print(f"    Avg Win Rate:        {avg_wr:.1f}%")
        print(f"    Profitable Paths:    {profitable}/10")

    # ---- THE ANSWER ----
    print(f"\n{'=' * 72}")
    print(f"  THE BOTTOM LINE")
    print(f"{'=' * 72}")

    c100_avg = sum(d["bank"] for d in all_cons_100) / 10
    a100_avg = sum(d["bank"] for d in all_agg_100) / 10
    c5_avg = sum(d["bank"] for d in all_cons_5) / 10
    a5_avg = sum(d["bank"] for d in all_agg_5) / 10

    c100_med = sorted(d["bank"] for d in all_cons_100)[5]
    a100_med = sorted(d["bank"] for d in all_agg_100)[5]
    c5_med = sorted(d["bank"] for d in all_cons_5)[5]
    a5_med = sorted(d["bank"] for d in all_agg_5)[5]

    print(f"\n  If you started with $100 one year ago:")
    print(f"    Conservative: avg ${c100_avg:.2f} | median ${c100_med:.2f} | range ${min(d['bank'] for d in all_cons_100):.2f}-${max(d['bank'] for d in all_cons_100):.2f}")
    print(f"    Aggressive:   avg ${a100_avg:.2f} | median ${a100_med:.2f} | range ${min(d['bank'] for d in all_agg_100):.2f}-${max(d['bank'] for d in all_agg_100):.2f}")

    print(f"\n  If you started with $5 one year ago:")
    print(f"    Conservative: avg ${c5_avg:.2f} | median ${c5_med:.2f} | range ${min(d['bank'] for d in all_cons_5):.2f}-${max(d['bank'] for d in all_cons_5):.2f}")
    print(f"    Aggressive:   avg ${a5_avg:.2f} | median ${a5_med:.2f} | range ${min(d['bank'] for d in all_agg_5):.2f}-${max(d['bank'] for d in all_agg_5):.2f}")

    print(f"\n  Methodology:")
    print(f"    - 10 independent price paths, regime-switching model")
    print(f"    - Calibrated to real BTC: ~65% annualized vol, fat tails")
    print(f"    - Conservative: $0.60 entry, $10 positions, OTM strikes")
    print(f"    - Aggressive: $0.40 entry, $20 positions, OTM strikes + momentum")
    print(f"    - Both use intelligent exit (risk-of-ruin based)")
    print(f"    - Fees: 1.5% taker on entry + early exit, 0% on settlement")
    print(f"    - Market hours only (14:00-21:00 UTC)")
    print(f"    - Bankroll scales down when it can't afford full position")
    print()


if __name__ == "__main__":
    main()
