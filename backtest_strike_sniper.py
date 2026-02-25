#!/usr/bin/env python3
"""
Strike Sniper Backtest — Parameter Sweep

Simulates two strategies against historical BTC 5-min candle data:
  1. 15-min sniper: buy cheap OTM contracts after a strong BTC move post-minute 7
  2. Hourly dislocation sniper: exploit mispricings near hourly expiry

Outputs top-10 parameter combinations by Sharpe ratio for each strategy.
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

candles = sorted(raw, key=lambda c: c['t'])  # ensure chronological order
print(f"Loaded {len(candles)} 5-min candles spanning "
      f"{(candles[-1]['t'] - candles[0]['t']) / 86400000:.1f} days")

# ── Math helpers ───────────────────────────────────────────────────────────────

def norm_cdf(x: float) -> float:
    """Standard normal CDF via erfc."""
    return 0.5 * math.erfc(-x / math.sqrt(2))


def estimate_otm_ask(current_btc: float, target_strike: float,
                     sigma_per_sqrt_min: float, minutes_remaining: float) -> float:
    """
    Estimate ask price (cents) for an OTM binary YES contract using a
    log-normal diffusion model.

    For YES (target_strike > current_btc, OTM above):
        d = log(S/K) / (σ√T) < 0  →  P_win = N(d) small (OTM)

    sigma_per_sqrt_min : dimensionless fraction per sqrt(minute)
                         e.g. 0.3%/sqrt(15min) = 0.003/sqrt(15)
    minutes_remaining  : minutes left in the window.

    Returns estimated ask in cents (P_win × 100 × 1.15 spread markup).
    For a NO OTM contract, call with target_strike < current_btc and
    compute P_no = 1 - P_yes, or pass the NO-specific strike.
    """
    if minutes_remaining <= 0 or sigma_per_sqrt_min <= 0:
        return 0.0
    if current_btc <= 0 or target_strike <= 0:
        return 0.0

    # σ√T is dimensionless (fraction over the remaining period)
    sigma_t = sigma_per_sqrt_min * math.sqrt(minutes_remaining)
    if sigma_t <= 0:
        return 0.0

    # log(S/K) is dimensionless; d is dimensionless
    try:
        d = math.log(current_btc / target_strike) / sigma_t
    except ValueError:
        return 0.0

    p_win = norm_cdf(d)  # P(BTC_T > strike)
    ask_cents = p_win * 100 * 1.15  # 15% markup for spread + fees
    return ask_cents


def sharpe(returns: list) -> float:
    """Annualised Sharpe (sqrt-252-day scaling, 96 windows per day for 15-min)."""
    if len(returns) < 2:
        return 0.0
    m = statistics.mean(returns)
    s = statistics.stdev(returns)
    if s == 0:
        return 0.0
    periods_per_day = 96  # 15-min windows
    return (m / s) * math.sqrt(periods_per_day * 252)


def max_drawdown(equity_curve: list) -> float:
    """Maximum peak-to-trough drawdown."""
    if not equity_curve:
        return 0.0
    peak = equity_curve[0]
    mdd = 0.0
    for v in equity_curve:
        if v > peak:
            peak = v
        dd = (peak - v) / peak if peak > 0 else 0
        if dd > mdd:
            mdd = dd
    return mdd


# ── Group 5-min candles into 15-min windows ────────────────────────────────────

def group_15min_windows(candles: list) -> list:
    """
    Returns list of dicts:
      { window_start_ts, open, candles: [c0, c1, c2], close }
    Only complete windows (exactly 3 candles) are included.
    Candle 0: minutes 0-4   (open of window)
    Candle 1: minutes 5-9
    Candle 2: minutes 10-14 (close of window)
    """
    buckets = defaultdict(list)
    for c in candles:
        ts_s = c['t'] // 1000
        window_start = (ts_s // (15 * 60)) * (15 * 60)
        buckets[window_start].append(c)

    windows = []
    for ws in sorted(buckets.keys()):
        cs = sorted(buckets[ws], key=lambda c: c['t'])
        if len(cs) == 3:
            windows.append({
                'ts': ws,
                'open': cs[0]['o'],
                'close': cs[2]['c'],
                'candles': cs,
            })
    return windows


# ── Compute rolling 15-min volatility ─────────────────────────────────────────

def compute_rolling_vol(windows: list, lookback: int = 20) -> list:
    """
    For each window, compute the 15-min return volatility from the preceding
    `lookback` windows. Returns sigma as a dimensionless fraction per sqrt(minute),
    suitable for use in the log-normal d-statistic:
        d = log(S/K) / (sigma_per_sqrt_min * sqrt(T_minutes))
    """
    returns_frac = []
    for w in windows:
        r = (w['close'] - w['open']) / w['open']  # fractional return
        returns_frac.append(r)

    vol_series = []
    for i, w in enumerate(windows):
        if i < lookback:
            vol_series.append(None)
            continue
        window_returns = returns_frac[i - lookback:i]
        std_frac = statistics.stdev(window_returns)
        # Convert 15-min fractional vol to per-sqrt-minute:
        #   sigma_per_sqrt_15min = std_frac
        #   sigma_per_sqrt_min   = std_frac / sqrt(15)
        sigma_per_sqrt_min = std_frac / math.sqrt(15)
        vol_series.append(sigma_per_sqrt_min)
    return vol_series


# ── 15-MIN SNIPER BACKTEST ─────────────────────────────────────────────────────

def run_15min_sniper_sweep(windows: list, vol_series: list) -> list:
    """
    Parameter sweep for the 15-min sniper.
    Returns list of result dicts sorted by Sharpe.
    """
    param_grid = {
        'momentum_threshold': [0.3, 0.5, 0.8, 1.0, 1.5],   # % BTC move from window open
        'check_at_minute':    [7, 8, 9, 10],                  # when to check (2nd half only)
        'otm_distance_pct':   [0.25, 0.5, 0.75],             # % OTM target distance
        'max_entry_price_cents': [10, 15, 20, 25],            # max ¢ to pay
    }

    keys = list(param_grid.keys())
    combos = list(product(*[param_grid[k] for k in keys]))

    # Map check_at_minute → which candle to use and price approximation
    # minute 7-9: use close of candle 1 (covers minutes 5-9)
    # minute 10: use open of candle 2

    results = []

    for combo in combos:
        params = dict(zip(keys, combo))
        mom_thresh = params['momentum_threshold']
        check_min = params['check_at_minute']
        otm_dist = params['otm_distance_pct']
        max_entry = params['max_entry_price_cents']

        trade_returns = []
        equity = [0.0]
        running_equity = 0.0
        trade_count = 0
        skip_count = 0

        for i, w in enumerate(windows):
            if vol_series[i] is None:
                continue
            sigma = vol_series[i]
            cs = w['candles']

            # Price at check_at_minute
            if check_min <= 9:
                btc_at_check = cs[1]['c']     # close of 2nd 5-min candle
                mins_remaining = 15 - 7.5     # mid-point of check (approx 7.5 min elapsed)
            else:  # check_min == 10
                btc_at_check = cs[2]['o']     # open of 3rd 5-min candle
                mins_remaining = 5.0           # 10 minutes elapsed, 5 remain

            # More precise minutes remaining:
            mins_remaining = 15 - check_min

            window_open = w['open']
            window_return = (btc_at_check - window_open) / window_open * 100

            # Only trade if momentum exceeds threshold
            if abs(window_return) < mom_thresh:
                continue

            # Determine direction
            direction = 'yes' if window_return > 0 else 'no'

            # OTM target strike
            if direction == 'yes':
                target_strike = btc_at_check * (1 + otm_dist / 100)
            else:
                target_strike = btc_at_check * (1 - otm_dist / 100)

            # Estimate ask price for this OTM contract
            if direction == 'yes':
                # Need BTC to close ABOVE target_strike (which is above current)
                ask = estimate_otm_ask(btc_at_check, target_strike, sigma, mins_remaining)
            else:
                # Need BTC to close BELOW target_strike (which is below current)
                # P(BTC < target) = 1 - P(BTC > target) = N(-d)
                # target_strike < btc_at_check, so log(S/K) > 0, d > 0, N(d) > 0.5
                # P_lose = N(d), P_win = N(-d)
                try:
                    d = math.log(btc_at_check / target_strike) / (sigma * math.sqrt(mins_remaining)) if sigma * math.sqrt(mins_remaining) > 0 else 0
                    p_win = norm_cdf(-d)
                except:
                    p_win = 0
                ask = p_win * 100 * 1.15

            if ask <= 0 or ask > max_entry:
                skip_count += 1
                continue

            # Simulate settlement: check if BTC close is beyond target
            btc_close = w['close']
            if direction == 'yes':
                won = btc_close > target_strike
            else:
                won = btc_close < target_strike

            # P&L (per dollar risked):
            # Win:  receive 100¢, paid ask¢, net = (100 - ask) × 0.93 - entry_fee
            # Loss: lose ask¢
            # Simplified: use ask as cost in cents
            if won:
                trade_pnl_cents = (100 - ask) * 0.93  # ~7% settlement fee
            else:
                trade_pnl_cents = -ask

            trade_returns.append(trade_pnl_cents)
            running_equity += trade_pnl_cents
            equity.append(running_equity)
            trade_count += 1

        if trade_count < 5:
            continue  # not enough trades for meaningful stats

        sh = sharpe(trade_returns)
        win_rate = sum(1 for r in trade_returns if r > 0) / len(trade_returns)
        avg_pnl = statistics.mean(trade_returns)
        mdd = max_drawdown(equity)

        results.append({
            **params,
            'sharpe': sh,
            'win_rate': win_rate,
            'avg_pnl_cents': avg_pnl,
            'trade_count': trade_count,
            'max_drawdown': mdd,
            'skipped': skip_count,
        })

    return sorted(results, key=lambda r: r['sharpe'], reverse=True)


# ── HOURLY DISLOCATION BACKTEST ────────────────────────────────────────────────

def group_hourly_windows(candles: list) -> list:
    """
    Group 5-min candles into hourly windows (12 candles per hour).
    Returns only complete hours.
    """
    buckets = defaultdict(list)
    for c in candles:
        ts_s = c['t'] // 1000
        hour_start = (ts_s // 3600) * 3600
        buckets[hour_start].append(c)

    windows = []
    for hs in sorted(buckets.keys()):
        cs = sorted(buckets[hs], key=lambda c: c['t'])
        if len(cs) == 12:
            # Derive a representative "strike" = nearest $500 to open price
            open_price = cs[0]['o']
            strike = round(open_price / 500) * 500
            windows.append({
                'ts': hs,
                'open': open_price,
                'close': cs[-1]['c'],
                'candles': cs,
                'strike': strike,
            })
    return windows


def compute_hourly_vol(hourly_windows: list, lookback: int = 20) -> list:
    """Rolling volatility for hourly windows, as dimensionless fraction per sqrt(minute)."""
    returns_frac = [(w['close'] - w['open']) / w['open'] for w in hourly_windows]
    vol_series = []
    for i, w in enumerate(hourly_windows):
        if i < lookback:
            vol_series.append(None)
            continue
        window_returns = returns_frac[i - lookback:i]
        std_frac = statistics.stdev(window_returns)
        # Convert 60-min fractional vol to per-sqrt-minute
        sigma_per_sqrt_min = std_frac / math.sqrt(60)
        vol_series.append(sigma_per_sqrt_min)
    return vol_series


def run_hourly_dislocation_sweep(hourly_windows: list, vol_series: list) -> list:
    """
    Parameter sweep for the hourly dislocation sniper.
    """
    param_grid = {
        'minutes_remaining': [5, 8, 10],
        'btc_proximity_dollars': [200, 300, 500],
        'direction_mode': ['continuation', 'dislocation'],
    }

    keys = list(param_grid.keys())
    combos = list(product(*[param_grid[k] for k in keys]))

    results = []

    for combo in combos:
        params = dict(zip(keys, combo))
        mins_rem = params['minutes_remaining']
        proximity = params['btc_proximity_dollars']
        mode = params['direction_mode']

        # Which candle index corresponds to N minutes before end of hour?
        # 12 candles/hour, each 5 min. Last candle = index 11 (min 55-59).
        # 5 min remaining → use candle 11 open (minute 55)
        # 8 min remaining → use candle 10 open (minute 50) — closest 5-min boundary
        # 10 min remaining → use candle 10 open (minute 50)
        if mins_rem <= 5:
            candle_idx = 11   # minute 55
        elif mins_rem <= 8:
            candle_idx = 10   # minute 50
        else:
            candle_idx = 10   # minute 50 (10 min remaining ~ 2 candles left)

        trade_returns = []
        equity = [0.0]
        running_equity = 0.0
        trade_count = 0

        for i, w in enumerate(hourly_windows):
            if vol_series[i] is None:
                continue
            sigma = vol_series[i]
            cs = w['candles']
            if candle_idx >= len(cs):
                continue

            btc_at_entry = cs[candle_idx]['o']
            strike = w['strike']

            # Skip if BTC is too far from strike
            if abs(btc_at_entry - strike) > proximity:
                continue

            # Estimate fair YES probability
            fair_ask = estimate_otm_ask(btc_at_entry, strike, sigma, mins_rem)
            # fair_ask is for YES (BTC above strike). Clamp to [1, 99]
            fair_ask = max(1.0, min(99.0, fair_ask))
            fair_no_ask = 100.0 - fair_ask / 1.15 * 1.15  # symmetric

            # Determine direction of BTC movement (prev vs current candle)
            prev_idx = candle_idx - 1
            if prev_idx < 0:
                continue
            btc_prev = cs[prev_idx]['c']
            moving_toward_strike = (
                (btc_prev < strike and btc_at_entry > btc_prev) or  # moving up toward strike above
                (btc_prev > strike and btc_at_entry < btc_prev)     # moving down toward strike below
            )

            if mode == 'continuation':
                # BTC moving toward strike → bet it will cross → buy YES
                if not moving_toward_strike:
                    continue
                # Entry: assume we pay fair_ask * 0.97 (slight improvement from limit)
                entry_cents = fair_ask * 0.97
                side = 'yes'
                won = w['close'] > strike

            else:  # dislocation
                # BTC moving away from strike → market over-prices the contract
                # YES price "spikes" too high → buy NO (it's cheap relative to fair)
                if moving_toward_strike:
                    continue
                # NO price estimate (dislocated: YES is overpriced, so NO is cheap)
                # Assume mkt YES ask = fair_ask * 1.10 (10% dislocation premium)
                # NO cost = 100 - mkt_yes_bid ≈ 100 - (fair_ask * 1.05)
                no_ask_cents = 100.0 - fair_ask * 1.05
                no_ask_cents = max(1.0, min(50.0, no_ask_cents))  # sanity clamp
                entry_cents = no_ask_cents
                side = 'no'
                won = w['close'] < strike

            if entry_cents <= 0 or entry_cents > 40:  # skip if too expensive
                continue

            if won:
                trade_pnl_cents = (100 - entry_cents) * 0.93
            else:
                trade_pnl_cents = -entry_cents

            trade_returns.append(trade_pnl_cents)
            running_equity += trade_pnl_cents
            equity.append(running_equity)
            trade_count += 1

        if trade_count < 5:
            continue

        sh = sharpe(trade_returns)
        win_rate = sum(1 for r in trade_returns if r > 0) / len(trade_returns)
        avg_pnl = statistics.mean(trade_returns)
        mdd = max_drawdown(equity)

        results.append({
            **params,
            'sharpe': sh,
            'win_rate': win_rate,
            'avg_pnl_cents': avg_pnl,
            'trade_count': trade_count,
            'max_drawdown': mdd,
        })

    return sorted(results, key=lambda r: r['sharpe'], reverse=True)


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
        for k, v in r.items():
            if k in ('sharpe', 'win_rate', 'avg_pnl_cents', 'trade_count', 'max_drawdown', 'skipped'):
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

    # Best combo summary
    best = top[0]
    print(f"\n  ** BEST: ", end='')
    for k, v in best.items():
        if k in ('sharpe', 'win_rate', 'avg_pnl_cents', 'trade_count', 'max_drawdown', 'skipped'):
            continue
        print(f"{k}={v}  ", end='')
    print()


# ── Main ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print("\n=== STRIKE SNIPER BACKTEST ===\n")

    # ── 15-min sniper ────────────────────────────────────────────────────────
    print("Grouping candles into 15-min windows...")
    windows_15 = group_15min_windows(candles)
    print(f"Found {len(windows_15)} complete 15-min windows")

    print("Computing rolling volatility...")
    vol_15 = compute_rolling_vol(windows_15, lookback=20)

    print("Running 15-min sniper parameter sweep...")
    results_15 = run_15min_sniper_sweep(windows_15, vol_15)

    print_top(results_15, "15-MIN SNIPER — Top 10 by Sharpe", n=10)

    # ── Hourly dislocation sniper ─────────────────────────────────────────────
    print("\nGrouping candles into hourly windows...")
    windows_1h = group_hourly_windows(candles)
    print(f"Found {len(windows_1h)} complete hourly windows")

    print("Computing hourly rolling volatility...")
    vol_1h = compute_hourly_vol(windows_1h, lookback=20)

    print("Running hourly dislocation sniper parameter sweep...")
    results_1h = run_hourly_dislocation_sweep(windows_1h, vol_1h)

    print_top(results_1h, "HOURLY DISLOCATION SNIPER — Top 10 by Sharpe", n=10)

    print(f"\n{'='*70}")
    print("Done. Use top parameters to configure lib/utils/botConfig.ts defaults.")
    print(f"{'='*70}\n")
