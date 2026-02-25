#!/usr/bin/env python3
"""
Inter-Window Momentum Backtest — Parameter Sweep

Tests whether a strong previous 15-min window BTC move predicts
the direction of the current window. Sweeps:
  - prev_return_threshold: minimum |return| to activate signal
  - direction: continuation (follow prev) or mean_reversion (fade prev)
  - regime_filter: all windows, momentum-regime, or mean-reversion regime

Outputs win rate, trade count, avg P&L per combination.
"""

import json
import math
import os
import statistics
from itertools import product
from collections import defaultdict

# ── Data loading ───────────────────────────────────────────────────────────────

DATA_PATH = os.path.join(os.path.dirname(__file__), 'data', 'btc_5min_real.json')

with open(DATA_PATH) as f:
    raw = json.load(f)

candles = sorted(raw, key=lambda c: c['t'])
print(f"Loaded {len(candles)} 5-min candles spanning "
      f"{(candles[-1]['t'] - candles[0]['t']) / 86400000:.1f} days")

# ── Math helpers ───────────────────────────────────────────────────────────────

def sharpe(returns: list) -> float:
    if len(returns) < 2:
        return 0.0
    m = statistics.mean(returns)
    s = statistics.stdev(returns)
    if s == 0:
        return 0.0
    return (m / s) * math.sqrt(96 * 252)  # 96 15-min windows per day


def max_drawdown(equity_curve: list) -> float:
    if not equity_curve:
        return 0.0
    peak = equity_curve[0]
    mdd = 0.0
    for v in equity_curve:
        if v > peak:
            peak = v
        dd = (peak - v) / abs(peak) if peak != 0 else 0
        if dd > mdd:
            mdd = dd
    return mdd


# ── Group 5-min candles into 15-min windows ─────────────────────────────────

def group_15min_windows(candles: list) -> list:
    buckets = defaultdict(list)
    for c in candles:
        ts_s = c['t'] // 1000
        window_start = (ts_s // (15 * 60)) * (15 * 60)
        buckets[window_start].append(c)

    windows = []
    for ws in sorted(buckets.keys()):
        cs = sorted(buckets[ws], key=lambda c: c['t'])
        if len(cs) == 3:
            volumes = [c['v'] for c in cs]
            avg_vol = sum(volumes) / len(volumes)
            # Bollinger-band-width proxy: (high-low range) / close
            all_closes = [c['c'] for c in cs]
            all_opens = [c['o'] for c in cs]
            prices = all_opens + all_closes
            price_range = max(prices) - min(prices)
            mid_close = cs[1]['c']
            bb_width_proxy = price_range / mid_close if mid_close > 0 else 0

            windows.append({
                'ts': ws,
                'open': cs[0]['o'],
                'close': cs[2]['c'],
                'candles': cs,
                'avg_vol': avg_vol,
                'bb_width_proxy': bb_width_proxy,  # simple proxy for Bollinger width
            })
    return windows


# ── Compute regime for each window ────────────────────────────────────────────

def compute_regimes(windows: list, lookback: int = 10) -> list:
    """
    Compute rolling Bollinger Band width for each window.
    bb_width = 4 * std(closes) / mean(closes) over lookback 5-min candles.
    """
    # Flatten all 5-min closes
    all_closes_by_window = []
    for w in windows:
        for c in w['candles']:
            all_closes_by_window.append((w['ts'], c['c']))

    # Build a flat series of 5-min closes
    flat_closes = []
    for c in candles:
        flat_closes.append(c['c'])

    # For each window, compute rolling bb_width from the preceding 10 5-min candles
    window_candle_map = {}
    for i, c in enumerate(candles):
        ts_s = c['t'] // 1000
        ws = (ts_s // (15 * 60)) * (15 * 60)
        if ws not in window_candle_map:
            window_candle_map[ws] = i  # index of first candle of this window

    regimes = []
    for w in windows:
        idx = window_candle_map.get(w['ts'])
        if idx is None or idx < lookback:
            regimes.append('unknown')
            continue
        prev_closes = [candles[j]['c'] for j in range(idx - lookback, idx)]
        mean_c = statistics.mean(prev_closes)
        std_c = statistics.stdev(prev_closes)
        bb_width = (4 * std_c / mean_c) if mean_c > 0 else 0  # ≈ (upper-lower)/middle
        # Momentum regime threshold: 0.003 (0.3%)
        regimes.append('momentum' if bb_width >= 0.003 else 'meanReversion')

    return regimes


# ── Inter-window momentum sweep ────────────────────────────────────────────────

def run_interwindow_sweep(windows: list, regimes: list) -> list:
    """
    For each pair of consecutive windows, test whether prev_return predicts
    the direction of curr_return.
    """
    param_grid = {
        'prev_return_threshold': [0.2, 0.3, 0.5, 0.8],
        'direction': ['continuation', 'mean_reversion'],
        'regime_filter': ['all', 'momentum', 'meanReversion'],
    }

    keys = list(param_grid.keys())
    combos = list(product(*[param_grid[k] for k in keys]))

    results = []

    for combo in combos:
        params = dict(zip(keys, combo))
        threshold = params['prev_return_threshold']
        direction = params['direction']
        regime_filter = params['regime_filter']

        trade_returns = []
        equity = [0.0]
        running_pnl = 0.0
        trade_count = 0
        skip_regime = 0
        skip_threshold = 0

        # Walk through pairs of consecutive windows
        for i in range(1, len(windows)):
            prev_w = windows[i - 1]
            curr_w = windows[i]

            # Ensure windows are consecutive (no gap)
            if curr_w['ts'] - prev_w['ts'] != 15 * 60:
                continue

            # Regime filter
            curr_regime = regimes[i] if i < len(regimes) else 'unknown'
            if regime_filter != 'all' and curr_regime != regime_filter:
                skip_regime += 1
                continue

            # Previous window return
            prev_return = (prev_w['close'] - prev_w['open']) / prev_w['open'] * 100
            curr_return = (curr_w['close'] - curr_w['open']) / curr_w['open'] * 100

            # Only activate signal if |prev_return| >= threshold
            if abs(prev_return) < threshold:
                skip_threshold += 1
                continue

            # Determine prediction
            prev_bullish = prev_return > 0
            if direction == 'continuation':
                predict_up = prev_bullish
            else:  # mean_reversion
                predict_up = not prev_bullish

            # Outcome: did current window go in predicted direction?
            curr_bullish = curr_return > 0
            won = (predict_up == curr_bullish)

            # Model P&L: assume we pay ~15¢ for a near-ATM contract (fair for a 50/50 prediction)
            # Win: +85¢ × 0.93 = +79¢, Loss: -15¢
            entry_cents = 15.0
            if won:
                pnl = (100 - entry_cents) * 0.93
            else:
                pnl = -entry_cents

            trade_returns.append(pnl)
            running_pnl += pnl
            equity.append(running_pnl)
            trade_count += 1

        if trade_count < 5:
            continue

        sh = sharpe(trade_returns)
        win_rate = sum(1 for r in trade_returns if r > 0) / len(trade_returns)
        avg_pnl = statistics.mean(trade_returns)
        mdd = max_drawdown(equity)

        # Also compute simple win rate at various thresholds for interpretability
        results.append({
            **params,
            'sharpe': sh,
            'win_rate': win_rate,
            'avg_pnl_cents': avg_pnl,
            'trade_count': trade_count,
            'max_drawdown': mdd,
            'skip_regime': skip_regime,
            'skip_threshold': skip_threshold,
        })

    return sorted(results, key=lambda r: r['sharpe'], reverse=True)


# ── Win rate vs threshold analysis ────────────────────────────────────────────

def win_rate_by_threshold(windows: list, thresholds: list) -> None:
    """
    Show win rate for continuation signal at different thresholds,
    without any regime filter, to find the inflection point.
    """
    print(f"\n{'─'*60}")
    print("  Continuation win rate by threshold (no regime filter):")
    print(f"{'─'*60}")
    print(f"  {'Threshold':>12}  {'Win Rate':>10}  {'Trade Count':>12}  {'Sharpe':>8}")
    print(f"  {'─'*12}  {'─'*10}  {'─'*12}  {'─'*8}")

    for thresh in thresholds:
        trade_returns = []
        for i in range(1, len(windows)):
            prev_w = windows[i - 1]
            curr_w = windows[i]
            if curr_w['ts'] - prev_w['ts'] != 15 * 60:
                continue
            prev_return = (prev_w['close'] - prev_w['open']) / prev_w['open'] * 100
            curr_return = (curr_w['close'] - curr_w['open']) / curr_w['open'] * 100
            if abs(prev_return) < thresh:
                continue
            predict_up = prev_return > 0
            curr_bullish = curr_return > 0
            won = (predict_up == curr_bullish)
            pnl = (100 - 15.0) * 0.93 if won else -15.0
            trade_returns.append(pnl)

        if len(trade_returns) < 5:
            print(f"  {thresh:>12.2f}%  {'N/A':>10}  {len(trade_returns):>12}  {'N/A':>8}")
            continue

        wr = sum(1 for r in trade_returns if r > 0) / len(trade_returns)
        sh = sharpe(trade_returns)
        print(f"  {thresh:>12.2f}%  {wr*100:>9.1f}%  {len(trade_returns):>12}  {sh:>+8.3f}")


# ── Display helpers ────────────────────────────────────────────────────────────

def print_top(results: list, title: str, n: int = 10):
    print(f"\n{'='*70}")
    print(f"  {title}")
    print(f"{'='*70}")
    if not results:
        print("  No results (insufficient trades)")
        return

    top = results[:n]
    for rank, r in enumerate(top, 1):
        param_parts = []
        stat_keys = {'sharpe', 'win_rate', 'avg_pnl_cents', 'trade_count',
                     'max_drawdown', 'skip_regime', 'skip_threshold'}
        for k, v in r.items():
            if k in stat_keys:
                continue
            param_parts.append(f"{k}={v}")
        params_str = ', '.join(param_parts)

        print(
            f"  #{rank:2d}  Sharpe: {r['sharpe']:+.3f}  "
            f"WinRate: {r['win_rate']*100:.1f}%  "
            f"AvgPnL: {r['avg_pnl_cents']:+.2f}c  "
            f"Trades: {r['trade_count']:4d}  "
            f"MaxDD: {r.get('max_drawdown', 0)*100:.1f}%"
        )
        print(f"        Params: {params_str}")

    best = top[0]
    print(f"\n  ** BEST: direction={best['direction']}  "
          f"threshold={best['prev_return_threshold']}%  "
          f"regime={best['regime_filter']}  "
          f"-> WinRate={best['win_rate']*100:.1f}%  Sharpe={best['sharpe']:+.3f}")

    # Derive the recommended INTER_WINDOW_MOM_THRESHOLD
    continuation_results = [r for r in results if r['direction'] == 'continuation']
    # Note: backtest shows MEAN REVERSION is the edge, not continuation.
    # The 7th signal should fade the previous window move.
    mr_results_filtered = [r for r in results if r['direction'] == 'mean_reversion' and r['trade_count'] >= 100]
    if mr_results_filtered:
        best_mr = mr_results_filtered[0]
        print(f"\n  RECOMMENDED INTER_WINDOW_MOM_THRESHOLD = "
              f"{best_mr['prev_return_threshold']}% "
              f"(MEAN REVERSION, {best_mr['regime_filter']} regime, "
              f"WR={best_mr['win_rate']*100:.1f}%, {best_mr['trade_count']} trades)")


# ── Main ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print("\n=== INTER-WINDOW MOMENTUM BACKTEST ===\n")

    print("Grouping candles into 15-min windows...")
    windows = group_15min_windows(candles)
    print(f"Found {len(windows)} complete 15-min windows")

    print("Computing regimes...")
    regimes = compute_regimes(windows, lookback=10)
    momentum_count = sum(1 for r in regimes if r == 'momentum')
    mr_count = sum(1 for r in regimes if r == 'meanReversion')
    print(f"Regime split: momentum={momentum_count}, meanReversion={mr_count}")

    print("Running parameter sweep...")
    results = run_interwindow_sweep(windows, regimes)

    print_top(results, "INTER-WINDOW MOMENTUM — Top 10 by Sharpe", n=10)

    # Extra analysis: win rate across thresholds
    fine_thresholds = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.5, 2.0]
    win_rate_by_threshold(windows, fine_thresholds)

    # Separate continuation vs mean reversion best
    cont_results = [r for r in results if r['direction'] == 'continuation']
    mr_results = [r for r in results if r['direction'] == 'mean_reversion']

    if cont_results:
        print(f"\n  Best continuation:    threshold={cont_results[0]['prev_return_threshold']}%  "
              f"regime={cont_results[0]['regime_filter']}  "
              f"WR={cont_results[0]['win_rate']*100:.1f}%  "
              f"Sharpe={cont_results[0]['sharpe']:+.3f}")
    if mr_results:
        print(f"  Best mean reversion:  threshold={mr_results[0]['prev_return_threshold']}%  "
              f"regime={mr_results[0]['regime_filter']}  "
              f"WR={mr_results[0]['win_rate']*100:.1f}%  "
              f"Sharpe={mr_results[0]['sharpe']:+.3f}")

    print(f"\n{'='*70}")
    print("Done. Use best continuation threshold in lib/strategies/fifteenMin.ts:")
    print("  const INTER_WINDOW_MOM_THRESHOLD = <threshold_from_above>;")
    print(f"{'='*70}\n")
