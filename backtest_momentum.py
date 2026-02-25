#!/usr/bin/env python3
"""
Backtest: Aggressive strategy with varying momentum thresholds.
Compares current (>1.0%), lower values, and no momentum filter.
Uses the same regime-switching synthetic BTC model as backtest_real.py.
Runs 10 independent price paths for robustness.
"""

import random
import math
from datetime import datetime, timezone

# ============================================================
# STRATEGY PARAMETERS (exact match to codebase)
# ============================================================
STRIKE_INCREMENT = 250
MIN_STRIKE_DISTANCE = 50
TAKER_FEE_RATE = 0.015  # 1.5%

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
# AGGRESSIVE STRATEGY - PARAMETERIZED MOMENTUM
# ============================================================
def check_aggressive(candle, prev_closes, prev_c, mom_threshold=None, hr_threshold=0.3):
    """
    Check aggressive signal with configurable momentum threshold.
    mom_threshold=None means momentum check is disabled entirely.
    """
    h = candle["dt"].hour
    if h < MARKET_OPEN_UTC or h >= MARKET_CLOSE_UTC:
        return False, None
    s3, s6, s12 = sma(prev_closes, 3), sma(prev_closes, 6), sma(prev_closes, 12)
    if 0 in (s3, s6, s12): return False, None
    if not (s3 >= s6 or (s6 - s3) / s6 < 0.001): return False, None
    if s6 <= s12: return False, None

    mom = momentum_3h(candle["open"], prev_closes)

    # Momentum gate: None = disabled, otherwise must exceed threshold
    if mom_threshold is not None and mom <= mom_threshold:
        return False, None

    if hour_return_max(candle) <= hr_threshold: return False, None

    p = candle["open"]
    st = otm_strike(p)
    if p - st < MIN_STRIKE_DISTANCE: return False, None
    return True, {"strike": st, "dist": p - st, "vol": volatility(prev_c), "mom": mom}


# ============================================================
# BANKROLL-TRACKED BACKTEST (aggressive only)
# ============================================================
def run(candles, start_bank, mom_threshold, hr_threshold=0.3):
    agg = {"bank": start_bank, "trades": [], "w": 0, "l": 0, "early": 0,
           "peak": start_bank, "trough": start_bank, "monthly": {}}

    for i in range(12, len(candles) - 1):
        c = candles[i]
        pc = candles[i - 1]
        nc = candles[i + 1]
        prev_cl = [x["close"] for x in candles[max(0, i-12):i]]
        mk = c["dt"].strftime("%Y-%m")

        if agg["bank"] >= 1.0:
            ok, info = check_aggressive(c, prev_cl, pc, mom_threshold, hr_threshold)
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
                        "ct": ct, "out": out, "pnl": pnl, "bk": agg["bank"], "mom": info["mom"]})
                    if mk not in agg["monthly"]:
                        agg["monthly"][mk] = {"pnl": 0, "w": 0, "l": 0}
                    agg["monthly"][mk]["pnl"] += pnl
                    agg["monthly"][mk]["w" if won else "l"] += 1

    return agg


# ============================================================
# MAIN
# ============================================================
def main():
    SEEDS = 10
    DAYS = 365
    START_BANK = 100.0

    # Momentum thresholds to test: None = disabled
    THRESHOLDS = [
        (1.0,  "1.0% (current)"),
        (0.75, "0.75%"),
        (0.5,  "0.5%"),
        (0.25, "0.25%"),
        (0.0,  "0.0% (any positive)"),
        (None, "DISABLED"),
    ]

    print("=" * 90)
    print("  AGGRESSIVE STRATEGY - MOMENTUM THRESHOLD COMPARISON")
    print("  10 price paths x 365 days, regime-switching synthetic BTC (~65% ann. vol)")
    print("  All other filters unchanged: SMA trend, hour return >0.3%, strike dist >= $50")
    print("=" * 90)

    # Collect results: threshold -> list of run results across seeds
    all_results = {label: [] for _, label in THRESHOLDS}

    for s in range(SEEDS):
        seed = s * 17 + 42
        candles = generate_btc_data(days=DAYS, seed=seed)
        lo = min(c["low"] for c in candles)
        hi = max(c["high"] for c in candles)
        print(f"\n  Path {s+1} (seed {seed}): ${candles[0]['open']:,.0f} -> ${candles[-1]['close']:,.0f}  "
              f"(range ${lo:,.0f}-${hi:,.0f})")

        for thresh, label in THRESHOLDS:
            result = run(candles, START_BANK, thresh)
            all_results[label].append(result)
            t = result["w"] + result["l"]
            wr = (result["w"] / t * 100) if t else 0
            print(f"    Mom {label:<20s}: {t:>4} trades, {wr:>5.1f}% WR, ${result['bank']:>8.2f} final")

    # ============================================================
    # AGGREGATE COMPARISON TABLE
    # ============================================================
    print(f"\n{'=' * 90}")
    print(f"  AGGREGATE RESULTS ACROSS 10 PRICE PATHS ($100 start)")
    print(f"{'=' * 90}")

    header = (f"  {'Momentum Threshold':<22} {'Trades':>7} {'WinRate':>8} {'AvgFinal':>10} "
              f"{'Median':>10} {'Best':>10} {'Worst':>10} {'Profitable':>11} {'AvgDD':>8}")
    print(header)
    print(f"  {'─' * 86}")

    for _, label in THRESHOLDS:
        runs = all_results[label]
        banks = [d["bank"] for d in runs]
        trades = [d["w"] + d["l"] for d in runs]
        wrs = [(d["w"] / (d["w"] + d["l"]) * 100) if (d["w"] + d["l"]) > 0 else 0 for d in runs]
        dds = [d["peak"] - d["trough"] for d in runs]

        avg_bank = sum(banks) / len(banks)
        avg_trades = sum(trades) / len(trades)
        avg_wr = sum(wrs) / len(wrs)
        avg_dd = sum(dds) / len(dds)
        med_bank = sorted(banks)[len(banks) // 2]
        profitable = sum(1 for b in banks if b > START_BANK)

        print(f"  {label:<22} {avg_trades:>7.0f} {avg_wr:>7.1f}% ${avg_bank:>9.2f} "
              f"${med_bank:>9.2f} ${max(banks):>9.2f} ${min(banks):>9.2f} "
              f"{profitable:>6}/10    ${avg_dd:>7.2f}")

    # ============================================================
    # DETAILED STATS PER THRESHOLD
    # ============================================================
    for _, label in THRESHOLDS:
        runs = all_results[label]
        banks = [d["bank"] for d in runs]
        trades = [d["w"] + d["l"] for d in runs]
        wins = [d["w"] for d in runs]
        losses = [d["l"] for d in runs]
        earlys = [d["early"] for d in runs]
        wrs = [(d["w"] / (d["w"] + d["l"]) * 100) if (d["w"] + d["l"]) > 0 else 0 for d in runs]
        rets = [((d["bank"] - START_BANK) / START_BANK * 100) for d in runs]
        dds = [d["peak"] - d["trough"] for d in runs]

        wp = []
        lp = []
        for d in runs:
            for t in d["trades"]:
                if t["pnl"] >= 0: wp.append(t["pnl"])
                else: lp.append(t["pnl"])

        avg_win = sum(wp) / len(wp) if wp else 0
        avg_loss = sum(lp) / len(lp) if lp else 0
        pf = abs(sum(wp) / sum(lp)) if lp and sum(lp) != 0 else float('inf')
        expectancy = (sum(wp) + sum(lp)) / (len(wp) + len(lp)) if (wp or lp) else 0

        # Momentum stats at entry
        moms = [t["mom"] for d in runs for t in d["trades"]]
        avg_mom = sum(moms) / len(moms) if moms else 0
        med_mom = sorted(moms)[len(moms) // 2] if moms else 0

        print(f"\n{'─' * 90}")
        print(f"  MOMENTUM THRESHOLD: {label}")
        print(f"{'─' * 90}")
        print(f"  Avg Trades/Year:      {sum(trades)/len(trades):.0f}")
        print(f"  Avg Wins / Losses:    {sum(wins)/len(wins):.0f} / {sum(losses)/len(losses):.0f}")
        print(f"  Avg Win Rate:         {sum(wrs)/len(wrs):.1f}%")
        print(f"  Avg Early Exits:      {sum(earlys)/len(earlys):.0f}")
        print(f"  Avg Return:           {sum(rets)/len(rets):+.1f}%")
        print(f"  Avg Final Bankroll:   ${sum(banks)/len(banks):.2f}")
        print(f"  Median Final:         ${sorted(banks)[len(banks)//2]:.2f}")
        print(f"  Best / Worst Final:   ${max(banks):.2f} / ${min(banks):.2f}")
        print(f"  Profitable Paths:     {sum(1 for b in banks if b > START_BANK)}/10")
        print(f"  Avg Max Drawdown:     ${sum(dds)/len(dds):.2f}")
        print(f"  Worst Drawdown:       ${max(dds):.2f}")
        print(f"  Avg Win Size:         ${avg_win:+.2f}")
        print(f"  Avg Loss Size:        ${avg_loss:+.2f}")
        print(f"  Profit Factor:        {pf:.2f}")
        print(f"  Expectancy/Trade:     ${expectancy:+.2f}")
        print(f"  Avg Momentum@Entry:   {avg_mom:.2f}%")
        print(f"  Median Momentum@Entry:{med_mom:.2f}%")

        # Monthly breakdown (averaged across paths)
        all_months = set()
        for d in runs:
            all_months.update(d["monthly"].keys())
        if all_months:
            print(f"\n  {'Month':<10} {'AvgTrades':>10} {'AvgWR':>8} {'AvgP&L':>10}")
            for mk in sorted(all_months):
                mt = [d["monthly"].get(mk, {"pnl": 0, "w": 0, "l": 0}) for d in runs]
                mt_trades = [(m["w"] + m["l"]) for m in mt]
                mt_wr = [(m["w"] / (m["w"] + m["l"]) * 100) if (m["w"] + m["l"]) > 0 else 0 for m in mt]
                mt_pnl = [m["pnl"] for m in mt]
                at = sum(mt_trades) / len(mt_trades)
                if at > 0:
                    print(f"  {mk:<10} {at:>10.1f} {sum(mt_wr)/len(mt_wr):>7.1f}% ${sum(mt_pnl)/len(mt_pnl):>+9.2f}")

    # ============================================================
    # BOTTOM LINE
    # ============================================================
    print(f"\n{'=' * 90}")
    print(f"  BOTTOM LINE - WHICH MOMENTUM THRESHOLD PERFORMS BEST?")
    print(f"{'=' * 90}")

    ranked = []
    for thresh, label in THRESHOLDS:
        runs = all_results[label]
        banks = [d["bank"] for d in runs]
        trades = [d["w"] + d["l"] for d in runs]
        wrs = [(d["w"] / (d["w"] + d["l"]) * 100) if (d["w"] + d["l"]) > 0 else 0 for d in runs]
        wp = [t["pnl"] for d in runs for t in d["trades"] if t["pnl"] >= 0]
        lp = [t["pnl"] for d in runs for t in d["trades"] if t["pnl"] < 0]
        expectancy = (sum(wp) + sum(lp)) / (len(wp) + len(lp)) if (wp or lp) else 0

        ranked.append({
            "label": label,
            "avg_bank": sum(banks) / len(banks),
            "med_bank": sorted(banks)[len(banks) // 2],
            "avg_trades": sum(trades) / len(trades),
            "avg_wr": sum(wrs) / len(wrs),
            "expectancy": expectancy,
            "profitable": sum(1 for b in banks if b > START_BANK),
        })

    ranked.sort(key=lambda x: x["avg_bank"], reverse=True)

    print(f"\n  Ranked by average final bankroll ($100 start):\n")
    for i, r in enumerate(ranked):
        marker = " <-- CURRENT" if "current" in r["label"] else ""
        print(f"  {i+1}. {r['label']:<22} ${r['avg_bank']:>8.2f} avg | "
              f"${r['med_bank']:>8.2f} median | {r['avg_trades']:>4.0f} trades | "
              f"{r['avg_wr']:>5.1f}% WR | ${r['expectancy']:>+.2f}/trade | "
              f"{r['profitable']}/10 profitable{marker}")

    print(f"\n  Key insight: More trades (lower threshold) vs higher quality trades (higher threshold)")
    print(f"  The momentum filter's value depends on whether it's filtering out bad trades")
    print(f"  or just reducing opportunity.\n")


if __name__ == "__main__":
    main()
