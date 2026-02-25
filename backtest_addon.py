#!/usr/bin/env python3
"""
Experiment: Averaging down and strike diversification for 15-min binary options.

Core question: When BTC dips mid-window against our open position, does
averaging down at the cheaper contract price improve total PnL?

Secondary question: Does splitting capital across two strikes (floor + higher)
outperform all-in on one strike?

Data: real 5-min BTCUSDT Binance candles (~35k windows over 365 days)
"""

import json, math, os, sys

DATA_FILE = os.path.join('data', 'btc_5min_real.json')

# ── Model parameters ─────────────────────────────────────────────────────────
ANNUAL_VOL   = 0.60    # BTC historical vol (calibrated in prior backtests)
FEE_RATE     = 0.015   # Kalshi 1.5% taker fee on winning side at settlement
CAP          = 1.0     # Normalized $1 per trade for comparison
# We assume we already entered (signal fired) at 30c — representative discount entry.
# The experiment tests what happens AFTER entry, not whether to enter.
ENTRY_PRICE  = 0.30    # Fixed entry price (¢/100)
ADD_ON_CAP   = 1.0     # Additional $1 for the add-on (same size as initial)

# ── Pricing model ────────────────────────────────────────────────────────────

def norm_cdf(z):
    if z < 0:
        return 1.0 - norm_cdf(-z)
    k = 1.0 / (1.0 + 0.2316419 * z)
    t = k * (0.319381530 + k * (-0.356563782 + k * (1.781477937 + k * (-1.821255978 + k * 1.330274429))))
    return 1.0 - math.exp(-0.5 * z * z) / math.sqrt(2 * math.pi) * t

def win_prob(btc, strike, mins, vol=ANNUAL_VOL):
    """P(BTC closes above strike at settlement) — lognormal, no drift."""
    if mins <= 0:
        return 1.0 if btc > strike else 0.0
    T = mins / (365.25 * 24 * 60)
    s = vol * math.sqrt(T)
    return norm_cdf(math.log(btc / strike) / s)

def fair_price(btc, strike, mins):
    """Fair value in dollars (0–1)."""
    return win_prob(btc, strike, mins)

def trade_pnl(contracts, entry_dollars, settle_val):
    """Net PnL at settlement. Fee = 1.5% of winning profit only."""
    gross = contracts * (settle_val - entry_dollars)
    fee = FEE_RATE * contracts * (1.0 - entry_dollars) if settle_val > entry_dollars else 0.0
    return gross - fee

def max_drawdown(pnl_series):
    peak = running = dd = 0.0
    for p in pnl_series:
        running += p
        if running > peak: peak = running
        if peak - running > dd: dd = peak - running
    return dd

# ── Data loading ─────────────────────────────────────────────────────────────

def load_windows():
    with open(DATA_FILE) as f:
        raw = json.load(f)
    # Format: [{t, o, h, l, c, v}, ...]
    candles = [{'o': float(r['o']), 'h': float(r['h']), 'l': float(r['l']), 'c': float(r['c'])} for r in raw]
    # Group into 15-min windows (3 × 5-min candles)
    return [candles[i:i+3] for i in range(0, len(candles) - 2, 3)]

# ── Main simulation ───────────────────────────────────────────────────────────

def run():
    windows = load_windows()
    print(f"Loaded {len(windows):,} 15-min windows from real Binance data\n")

    # Accumulators
    strats = {
        'A_baseline':              [],
        'B_add_on_dip_0.15pct':   [],
        'C_add_on_dip_0.30pct':   [],
        'D_add_on_dip_0.50pct':   [],
        'E_add_on_at_10min_0.30': [],
        'F_split_floor_plus0.5pct': [],
    }
    addon_fires = {k: 0 for k in strats}

    # Conditional win tracking: bucketed by dip magnitude at minute 5
    cond_buckets = {
        'no_dip (<0.10%)':   {'w': 0, 'n': 0},
        'dip 0.10–0.20%':    {'w': 0, 'n': 0},
        'dip 0.20–0.35%':    {'w': 0, 'n': 0},
        'dip 0.35–0.50%':    {'w': 0, 'n': 0},
        'dip 0.50–1.00%':    {'w': 0, 'n': 0},
        'dip >1.00%':        {'w': 0, 'n': 0},
    }

    skipped = 0

    for w in windows:
        strike   = w[0]['o']        # ATM — strike equals open of window
        btc_5    = w[1]['o']        # BTC at minute 5
        btc_10   = w[2]['o']        # BTC at minute 10
        settle   = w[2]['c']        # Settlement at minute 15

        # Assume we already entered at ENTRY_PRICE (signal fired, got in at a discount)
        entry = ENTRY_PRICE
        contracts0 = max(1, int(CAP / entry))
        won        = settle > strike   # YES bet wins if BTC closes above strike
        sv         = 1.0 if won else 0.0

        # Contract fair prices mid-window
        p5  = fair_price(btc_5,  strike, 10)   # at minute 5, 10 min remaining
        p10 = fair_price(btc_10, strike,  5)   # at minute 10, 5 min remaining

        # Dip magnitude against our YES bet (positive = price dropped = cheaper contracts)
        dip5  = (strike - btc_5)  / strike
        dip10 = (strike - btc_10) / strike

        # ── A: Baseline ─────────────────────────────────────────────────────
        pnl_a = trade_pnl(contracts0, entry, sv)
        strats['A_baseline'].append(pnl_a)

        # ── Conditional win rate buckets ─────────────────────────────────────
        dip5_pct = dip5 * 100
        if dip5_pct < 0.10:
            cond_buckets['no_dip (<0.10%)']['w'] += won; cond_buckets['no_dip (<0.10%)']['n'] += 1
        elif dip5_pct < 0.20:
            cond_buckets['dip 0.10–0.20%']['w'] += won; cond_buckets['dip 0.10–0.20%']['n'] += 1
        elif dip5_pct < 0.35:
            cond_buckets['dip 0.20–0.35%']['w'] += won; cond_buckets['dip 0.20–0.35%']['n'] += 1
        elif dip5_pct < 0.50:
            cond_buckets['dip 0.35–0.50%']['w'] += won; cond_buckets['dip 0.35–0.50%']['n'] += 1
        elif dip5_pct < 1.00:
            cond_buckets['dip 0.50–1.00%']['w'] += won; cond_buckets['dip 0.50–1.00%']['n'] += 1
        else:
            cond_buckets['dip >1.00%']['w'] += won; cond_buckets['dip >1.00%']['n'] += 1

        # ── B/C/D: Add-on at minute 5 ────────────────────────────────────────
        for key, threshold in [
            ('B_add_on_dip_0.15pct', 0.0015),
            ('C_add_on_dip_0.30pct', 0.003),
            ('D_add_on_dip_0.50pct', 0.005),
        ]:
            if dip5 >= threshold and 0.05 < p5 < 0.92:
                c_add = max(1, int(ADD_ON_CAP / p5))
                total = trade_pnl(contracts0, entry, sv) + trade_pnl(c_add, p5, sv)
                strats[key].append(total)
                addon_fires[key] += 1
            else:
                strats[key].append(pnl_a)

        # ── E: Add-on at minute 10 on 0.30% dip ─────────────────────────────
        if dip10 >= 0.003 and 0.05 < p10 < 0.92:
            c_add = max(1, int(ADD_ON_CAP / p10))
            total = trade_pnl(contracts0, entry, sv) + trade_pnl(c_add, p10, sv)
            strats['E_add_on_at_10min_0.30'].append(total)
            addon_fires['E_add_on_at_10min_0.30'] += 1
        else:
            strats['E_add_on_at_10min_0.30'].append(pnl_a)

        # ── F: Split 50/50 — ATM floor + 0.5% higher strike ─────────────────
        strike_up = strike * 1.005
        p_up = fair_price(w[0]['o'], strike_up, 15)
        if p_up >= 0.05:
            c_floor = max(1, int(CAP * 0.5 / entry))
            c_up    = max(1, int(CAP * 0.5 / p_up))
            won_up  = settle > strike_up
            sv_up   = 1.0 if won_up else 0.0
            total   = trade_pnl(c_floor, entry, sv) + trade_pnl(c_up, p_up, sv_up)
        else:
            total = pnl_a
        strats['F_split_floor_plus0.5pct'].append(total)

    # ── Results table ─────────────────────────────────────────────────────────
    n_sim = len(windows) - skipped
    print(f"Simulated {n_sim:,} windows ({skipped:,} skipped outside entry range)\n")
    print("=" * 82)
    print(f"{'Strategy':<32} {'N':>6} {'Add%':>6} {'WinRate':>8} {'TotalPnL':>10} {'PerTrade':>10} {'MaxDD':>8}")
    print("=" * 82)

    baseline_data = strats['A_baseline']
    wins_baseline = sum(1 for p in baseline_data if p > 0)

    for name, data in strats.items():
        if not data: continue
        n        = len(data)
        total    = sum(data)
        per_t    = total / n
        wins     = sum(1 for p in data if p > 0)
        wr       = wins / n * 100
        dd       = max_drawdown(data)
        add_pct  = addon_fires[name] / n * 100

        print(f"{name:<32} {n:>6,} {add_pct:>5.1f}% {wr:>7.1f}% {total:>+10.2f} {per_t:>+10.5f} {-dd:>+8.2f}")

    # ── Conditional win rate table ────────────────────────────────────────────
    print()
    print("─── Win rate given dip magnitude at minute 5 (YES bet) ──────────────────────")
    print(f"{'Condition':<30} {'Wins':>6}  {'Total':>6}  {'WinRate':>8}  {'vs Baseline':>12}")
    baseline_wr = wins_baseline / len(baseline_data) * 100 if baseline_data else 0
    print(f"{'BASELINE (all windows)':<30} {wins_baseline:>6}  {len(baseline_data):>6}  {baseline_wr:>7.1f}%")
    print()
    for label, d in cond_buckets.items():
        if d['n'] == 0: continue
        wr = d['w'] / d['n'] * 100
        delta = wr - baseline_wr
        flag = '  <-- MEAN REVERSION' if wr > baseline_wr else ('  <-- MOMENTUM' if delta < -3 else '')
        print(f"  {label:<28} {d['w']:>6}  {d['n']:>6}  {wr:>7.1f}%  {delta:>+8.1f}pp{flag}")

    # ── Add-on deep-dive: isolate windows where add-on fires ─────────────────
    print()
    print("─── PnL on windows where add-on DID fire (apples-to-apples) ─────────────────")
    print(f"{'Strategy':<32} {'Fires':>6}  {'PnL (addon)'  :>12}  {'PnL (baseline same wins)':>25}")

    # Re-simulate to isolate add-on windows
    addon_wins = {k: {'addon_pnl': [], 'base_pnl': []} for k in strats if k != 'A_baseline' and k != 'F_split_floor_plus0.5pct'}

    for w in windows:
        strike = w[0]['o']
        btc_5  = w[1]['o']
        btc_10 = w[2]['o']
        settle = w[2]['c']

        entry = ENTRY_PRICE
        contracts0 = max(1, int(CAP / entry))
        won = settle > strike
        sv  = 1.0 if won else 0.0
        p5  = fair_price(btc_5, strike, 10)
        p10 = fair_price(btc_10, strike, 5)
        dip5  = (strike - btc_5) / strike
        dip10 = (strike - btc_10) / strike

        pnl_a = trade_pnl(contracts0, entry, sv)

        for key, threshold in [
            ('B_add_on_dip_0.15pct', 0.0015),
            ('C_add_on_dip_0.30pct', 0.003),
            ('D_add_on_dip_0.50pct', 0.005),
        ]:
            if dip5 >= threshold and 0.05 < p5 < 0.92:
                c_add = max(1, int(ADD_ON_CAP / p5))
                pnl_with_addon = trade_pnl(contracts0, entry, sv) + trade_pnl(c_add, p5, sv)
                addon_wins[key]['addon_pnl'].append(pnl_with_addon)
                addon_wins[key]['base_pnl'].append(pnl_a)

        if dip10 >= 0.003 and 0.05 < p10 < 0.92:
            c_add = max(1, int(ADD_ON_CAP / p10))
            pnl_with_addon = trade_pnl(contracts0, entry, sv) + trade_pnl(c_add, p10, sv)
            addon_wins['E_add_on_at_10min_0.30']['addon_pnl'].append(pnl_with_addon)
            addon_wins['E_add_on_at_10min_0.30']['base_pnl'].append(pnl_a)

    for key, d in addon_wins.items():
        if not d['addon_pnl']: continue
        n = len(d['addon_pnl'])
        addon_total = sum(d['addon_pnl'])
        base_total  = sum(d['base_pnl'])
        print(f"  {key:<30} {n:>6}  {addon_total:>+12.2f}  {base_total:>+25.2f}  delta: {addon_total-base_total:>+.2f}")

    # ── Recommendation ────────────────────────────────────────────────────────
    print()
    print("─── Verdict ─────────────────────────────────────────────────────────────────")

    b_total = sum(strats['A_baseline'])
    c_total = sum(strats['C_add_on_dip_0.30pct'])
    f_total = sum(strats['F_split_floor_plus0.5pct'])

    best_addon = max(
        [('B', sum(strats['B_add_on_dip_0.15pct'])),
         ('C', sum(strats['C_add_on_dip_0.30pct'])),
         ('D', sum(strats['D_add_on_dip_0.50pct'])),
         ('E', sum(strats['E_add_on_at_10min_0.30']))],
        key=lambda x: x[1]
    )

    print(f"  Baseline total PnL:        ${b_total:>+.2f}")
    print(f"  Best avg-down strategy:    ${best_addon[1]:>+.2f}  ({best_addon[0]})")
    print(f"  Split-strike strategy:     ${f_total:>+.2f}")
    print()
    if best_addon[1] > b_total * 1.05:
        print("  >> Averaging down shows MEANINGFUL improvement — worth implementing")
    elif best_addon[1] > b_total:
        print("  >> Averaging down shows small improvement — marginal benefit, adds complexity")
    else:
        print("  >> Averaging down HURTS — do NOT implement")

    if f_total > b_total * 1.02:
        print("  >> Split-strike shows improvement — worth investigating further")
    else:
        print("  >> Split-strike does NOT outperform single strike — skip")


if __name__ == '__main__':
    run()
