"""
Aggressive Strategy Enhancement Experiment
===========================================

Tests current aggressive strategy against enhanced versions with weak-trend signals.

Key Discovery from V1:
- DOWN moves preceded by WEAK uptrends (SMA6 barely > SMA12, diff +2.78)
- UP moves preceded by STRONG uptrends (SMA6 far > SMA12, diff +14.58)

Current Aggressive Gaps:
1. Bearish signals require STRONG downward momentum (ret < -0.2%)
2. Missing: Weak-trend bearish signal (trend exhaustion → reversal down)
3. Potentially missing: Weak-trend bullish signal (consolidation → breakout up)

Strategies Tested:
A. Current Aggressive (baseline) - 7 bull + 7 bear signals
B. Enhanced with Weak-Trend Bearish - Add BEAR WEAK TREND signal
C. Enhanced Bidirectional - Add both BEAR WEAK TREND and BULL WEAK TREND signals
"""

import json
import random
import math
from datetime import datetime, timedelta
from pathlib import Path

# ============================================================================
# CONFIGURATION
# ============================================================================

STARTING_CAPITAL = 100.0
DAYS = 365
HOURS_PER_DAY = 24
MONTE_CARLO_RUNS = 50

# Aggressive bot constants (from aggressive.ts)
POSITION_SIZE = 20.0
MAX_ENTRY_PRICE = 0.25
MIN_TIME_REMAINING = 15
PROB_LO = 0.05
PROB_HI = 0.45
SMA_LOOSENESS = 0.003
STRIKE_INCREMENT = 250

# Current aggressive thresholds
ROLLING_MIN_RETURN = 0.20
DIP_MIN_PCT = 0.30
DIP_MIN_RECOVERY = 0.20
MULTI_MIN_1H = 0.10
MULTI_MIN_2H = 0.20
VOLUME_MIN_RATIO = 1.50
VOLUME_MIN_RETURN = 0.20
SELLOFF_MIN_MOVE = 0.50
SELLOFF_MIN_REVERSAL = 0.20
VOL_EXPANSION_MIN = 1.80
VOL_EXPANSION_MIN_RET = 0.10

# NEW: Weak-trend thresholds
WEAK_TREND_MAX = 0.005  # SMA6-SMA12 difference < 0.5% = weak
WEAK_TREND_MIN_RETURN = 0.05  # Minimum recent momentum required

# ============================================================================
# PRICING MODEL (from strikes.ts)
# ============================================================================

def normal_cdf(x: float) -> float:
    """Standard normal CDF using Abramowitz & Stegun approximation."""
    a1 = 0.254829592
    a2 = -0.284496736
    a3 = 1.421413741
    a4 = -1.453152027
    a5 = 1.061405429
    p = 0.3275911
    sign = -1 if x < 0 else 1
    abs_x = abs(x)
    t = 1 / (1 + p * abs_x)
    y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * math.exp(-(abs_x * abs_x) / 2)
    return 0.5 * (1 + sign * y)


def estimate_contract_fair_value(
    btc_price: float,
    strike: float,
    volatility_pct: float,
    minutes_remaining: float
) -> float:
    """Estimate the fair value of a YES contract (BTC >= strike at settlement)."""
    if btc_price <= 0 or volatility_pct <= 0:
        return 0.5
    time_factor_hours = max(minutes_remaining, 0.5) / 60
    expected_move = btc_price * (volatility_pct / 100) * math.sqrt(time_factor_hours)
    if expected_move <= 0:
        return 0.99 if btc_price >= strike else 0.01
    z_score = (btc_price - strike) / expected_move
    probability = normal_cdf(z_score)
    # Settlement averaging adjustment
    if minutes_remaining <= 2:
        certainty_boost = 0.15 * (1 - minutes_remaining / 2)
        if probability > 0.5:
            probability = probability + (1 - probability) * certainty_boost
        else:
            probability = probability * (1 - certainty_boost)
    return max(0.01, min(0.99, probability))


def calculate_strike(btc_price: float, strike_type: str) -> float:
    """Calculate strike price."""
    if strike_type == 'ATM':
        return round(btc_price / STRIKE_INCREMENT) * STRIKE_INCREMENT
    else:  # OTM
        return math.floor(btc_price / STRIKE_INCREMENT) * STRIKE_INCREMENT


# ============================================================================
# DATA GENERATION
# ============================================================================

def generate_btc_candles(days=365, hours_per_day=24):
    """Generate synthetic BTC hourly candles with regime-switching behavior."""
    total_hours = days * hours_per_day
    candles = []
    current_price = 100000.0
    bull_regime = True
    hours_in_regime = 0
    regime_duration = random.randint(48, 168)

    for hour in range(total_hours):
        hours_in_regime += 1
        if hours_in_regime >= regime_duration:
            bull_regime = not bull_regime
            hours_in_regime = 0
            regime_duration = random.randint(48, 168)

        if bull_regime:
            drift = 0.0003
            volatility = 0.015
        else:
            drift = -0.0002
            volatility = 0.025

        change_pct = drift + random.gauss(0, volatility)
        new_price = current_price * (1 + change_pct)

        high = new_price * (1 + abs(random.gauss(0, 0.003)))
        low = new_price * (1 - abs(random.gauss(0, 0.003)))
        open_price = current_price
        close = new_price

        base_volume = 1000 + random.uniform(-200, 200)
        volume = base_volume * (1 + abs(change_pct) * 10)

        candles.append({
            'hour': hour,
            'open': open_price,
            'high': high,
            'low': low,
            'close': close,
            'volume': volume,
            'change_pct': change_pct * 100,
        })

        current_price = new_price

    return candles


def calculate_indicators(candles):
    """Calculate technical indicators for all candles."""
    for i in range(len(candles)):
        # SMAs
        if i >= 2:
            candles[i]['sma3'] = sum(c['close'] for c in candles[i-2:i+1]) / 3
        else:
            candles[i]['sma3'] = candles[i]['close']

        if i >= 5:
            candles[i]['sma6'] = sum(c['close'] for c in candles[i-5:i+1]) / 6
        else:
            candles[i]['sma6'] = candles[i]['close']

        if i >= 11:
            candles[i]['sma12'] = sum(c['close'] for c in candles[i-11:i+1]) / 12
        else:
            candles[i]['sma12'] = candles[i]['close']

        # Rolling returns
        if i >= 1:
            candles[i]['rolling_1h'] = ((candles[i]['close'] - candles[i-1]['close']) / candles[i-1]['close']) * 100
        else:
            candles[i]['rolling_1h'] = 0

        if i >= 2:
            candles[i]['rolling_2h'] = ((candles[i]['close'] - candles[i-2]['close']) / candles[i-2]['close']) * 100
        else:
            candles[i]['rolling_2h'] = 0

        if i >= 3:
            candles[i]['rolling_3h'] = ((candles[i]['close'] - candles[i-3]['close']) / candles[i-3]['close']) * 100
        else:
            candles[i]['rolling_3h'] = 0

        # Volume ratio
        if i >= 6:
            avg_vol = sum(c['volume'] for c in candles[i-6:i]) / 6
            candles[i]['volume_ratio'] = candles[i]['volume'] / avg_vol if avg_vol > 0 else 1.0
        else:
            candles[i]['volume_ratio'] = 1.0

        # Volatility
        if i >= 6:
            returns = [c['change_pct'] for c in candles[i-6:i+1]]
            mean_return = sum(returns) / len(returns)
            variance = sum((r - mean_return) ** 2 for r in returns) / len(returns)
            candles[i]['volatility'] = math.sqrt(variance)
        else:
            candles[i]['volatility'] = 1.5


# ============================================================================
# SIGNAL DETECTION (Current Aggressive)
# ============================================================================

def check_current_aggressive_signals(candle):
    """Check all 14 current aggressive signals (7 bull + 7 bear)."""
    sma3 = candle['sma3']
    sma6 = candle['sma6']
    sma12 = candle['sma12']
    price = candle['close']
    ret1h = candle['rolling_1h']
    ret2h = candle['rolling_2h']
    vol_ratio = candle['volume_ratio']

    # SMA trend checks
    short_trend_up = sma3 > sma6 or (sma6 > 0 and (sma6 - sma3) / sma6 < SMA_LOOSENESS)
    medium_trend_up = sma6 > sma12 or (sma12 > 0 and (sma12 - sma6) / sma12 < SMA_LOOSENESS)
    short_trend_down = sma3 < sma6 or (sma6 > 0 and (sma3 - sma6) / sma6 < SMA_LOOSENESS)
    medium_trend_down = sma6 < sma12 or (sma12 > 0 and (sma6 - sma12) / sma12 < SMA_LOOSENESS)

    signals = []

    # BULLISH SIGNALS
    # 1. Rolling momentum
    if ret1h > ROLLING_MIN_RETURN and short_trend_up and medium_trend_up:
        signals.append(('yes', 'BULL ROLLING MOM'))

    # 2-7. Simplified versions of other bullish signals
    # (For experiment purposes, using simplified logic)
    if ret1h > MULTI_MIN_1H and ret2h > MULTI_MIN_2H and short_trend_up:
        signals.append(('yes', 'BULL MULTI-HOUR'))

    if vol_ratio >= VOLUME_MIN_RATIO and ret1h > VOLUME_MIN_RETURN and short_trend_up:
        signals.append(('yes', 'BULL VOL+MOM'))

    # BEARISH SIGNALS
    # 1. Rolling momentum
    if ret1h < -ROLLING_MIN_RETURN and short_trend_down and medium_trend_down:
        signals.append(('no', 'BEAR ROLLING MOM'))

    # 2-7. Simplified versions of other bearish signals
    if ret1h < -MULTI_MIN_1H and ret2h < -MULTI_MIN_2H and short_trend_down:
        signals.append(('no', 'BEAR MULTI-HOUR'))

    if vol_ratio >= VOLUME_MIN_RATIO and ret1h < -VOLUME_MIN_RETURN and short_trend_down:
        signals.append(('no', 'BEAR VOL+MOM'))

    return signals[0] if signals else None


def check_weak_trend_bearish(candle):
    """
    NEW SIGNAL: BEAR WEAK TREND

    Fires when:
    - Uptrend is WEAK (SMA6 > SMA12 but difference < 0.5%)
    - Recent momentum is slightly negative (rolling_1h < 0 OR rolling_2h < 0)
    - Indicates trend exhaustion before reversal down
    """
    sma6 = candle['sma6']
    sma12 = candle['sma12']
    ret1h = candle['rolling_1h']
    ret2h = candle['rolling_2h']

    # Weak uptrend
    if sma6 <= sma12:
        return None

    trend_strength = (sma6 - sma12) / sma12 if sma12 > 0 else 0
    if trend_strength >= WEAK_TREND_MAX:
        return None  # Trend too strong

    # Recent downward momentum
    if not (ret1h < 0 or ret2h < 0):
        return None

    return ('no', 'BEAR WEAK TREND')


def check_weak_trend_bullish(candle):
    """
    NEW SIGNAL: BULL WEAK TREND

    Fires when:
    - Downtrend is WEAK (SMA6 < SMA12 but difference < 0.5%)
    - Recent momentum is slightly positive (rolling_1h > 0 OR rolling_2h > 0)
    - Indicates consolidation before breakout up
    """
    sma6 = candle['sma6']
    sma12 = candle['sma12']
    ret1h = candle['rolling_1h']
    ret2h = candle['rolling_2h']

    # Weak downtrend
    if sma6 >= sma12:
        return None

    trend_strength = (sma12 - sma6) / sma12 if sma12 > 0 else 0
    if trend_strength >= WEAK_TREND_MAX:
        return None  # Trend too strong

    # Recent upward momentum
    if not (ret1h > 0 or ret2h > 0):
        return None

    return ('yes', 'BULL WEAK TREND')


# ============================================================================
# STRATEGY IMPLEMENTATIONS
# ============================================================================

def check_strategy_a_signal(candle, minutes_remaining=30):
    """Strategy A: Current Aggressive (baseline)."""
    signal = check_current_aggressive_signals(candle)
    if not signal:
        return None

    direction, signal_name = signal
    price = candle['close']
    volatility = candle['volatility']

    # Strike selection
    floor_strike = calculate_strike(price, 'OTM')
    strike = floor_strike + STRIKE_INCREMENT if direction == 'yes' else floor_strike

    # Fair value
    yes_fv = estimate_contract_fair_value(price, strike, volatility, minutes_remaining)
    fair_value = yes_fv if direction == 'yes' else 1 - yes_fv

    # Probability band
    if not (PROB_LO <= fair_value <= PROB_HI):
        return None

    # Entry price
    entry_price = min(MAX_ENTRY_PRICE, math.floor(fair_value * 100) / 100)
    if entry_price <= 0.01:
        return None

    contracts = math.floor(POSITION_SIZE / entry_price)
    if contracts == 0:
        return None

    return {
        'direction': direction,
        'strike': strike,
        'entry_price': entry_price,
        'contracts': contracts,
        'cost': entry_price * contracts,
        'fair_value': fair_value,
        'signal_name': signal_name
    }


def check_strategy_b_signal(candle, minutes_remaining=30):
    """Strategy B: Enhanced with Weak-Trend Bearish."""
    # Try current signals first
    signal = check_current_aggressive_signals(candle)

    # If no current signal, try weak-trend bearish
    if not signal:
        signal = check_weak_trend_bearish(candle)

    if not signal:
        return None

    direction, signal_name = signal
    price = candle['close']
    volatility = candle['volatility']

    floor_strike = calculate_strike(price, 'OTM')
    strike = floor_strike + STRIKE_INCREMENT if direction == 'yes' else floor_strike

    yes_fv = estimate_contract_fair_value(price, strike, volatility, minutes_remaining)
    fair_value = yes_fv if direction == 'yes' else 1 - yes_fv

    if not (PROB_LO <= fair_value <= PROB_HI):
        return None

    entry_price = min(MAX_ENTRY_PRICE, math.floor(fair_value * 100) / 100)
    if entry_price <= 0.01:
        return None

    contracts = math.floor(POSITION_SIZE / entry_price)
    if contracts == 0:
        return None

    return {
        'direction': direction,
        'strike': strike,
        'entry_price': entry_price,
        'contracts': contracts,
        'cost': entry_price * contracts,
        'fair_value': fair_value,
        'signal_name': signal_name
    }


def check_strategy_c_signal(candle, minutes_remaining=30):
    """Strategy C: Enhanced Bidirectional (weak-trend bull + bear)."""
    # Try current signals first
    signal = check_current_aggressive_signals(candle)

    # If no current signal, try weak-trend signals
    if not signal:
        signal = check_weak_trend_bearish(candle)

    if not signal:
        signal = check_weak_trend_bullish(candle)

    if not signal:
        return None

    direction, signal_name = signal
    price = candle['close']
    volatility = candle['volatility']

    floor_strike = calculate_strike(price, 'OTM')
    strike = floor_strike + STRIKE_INCREMENT if direction == 'yes' else floor_strike

    yes_fv = estimate_contract_fair_value(price, strike, volatility, minutes_remaining)
    fair_value = yes_fv if direction == 'yes' else 1 - yes_fv

    if not (PROB_LO <= fair_value <= PROB_HI):
        return None

    entry_price = min(MAX_ENTRY_PRICE, math.floor(fair_value * 100) / 100)
    if entry_price <= 0.01:
        return None

    contracts = math.floor(POSITION_SIZE / entry_price)
    if contracts == 0:
        return None

    return {
        'direction': direction,
        'strike': strike,
        'entry_price': entry_price,
        'contracts': contracts,
        'cost': entry_price * contracts,
        'fair_value': fair_value,
        'signal_name': signal_name
    }


# ============================================================================
# SIMULATION ENGINE
# ============================================================================

def simulate_strategy(candles, strategy_name, strategy_func):
    """Simulate a trading strategy over the dataset."""
    capital = STARTING_CAPITAL
    trades = []
    signal_counts = {}

    for i in range(len(candles) - 1):
        current_candle = candles[i]
        next_candle = candles[i + 1]

        signal = strategy_func(current_candle, minutes_remaining=30)
        if signal is None:
            continue

        if capital < signal['cost']:
            continue

        capital -= signal['cost']

        # Track signal usage
        sig_name = signal['signal_name']
        signal_counts[sig_name] = signal_counts.get(sig_name, 0) + 1

        # Settlement
        settlement_price = next_candle['close']
        strike = signal['strike']
        direction = signal['direction']

        if direction == 'yes':
            won = settlement_price >= strike
        else:
            won = settlement_price < strike

        payout = signal['contracts'] if won else 0
        pnl = payout - signal['cost']
        capital += payout

        trades.append({
            'hour': current_candle['hour'],
            'direction': direction,
            'strike': strike,
            'entry_price': signal['entry_price'],
            'contracts': signal['contracts'],
            'cost': signal['cost'],
            'settlement': settlement_price,
            'won': won,
            'pnl': pnl,
            'capital': capital,
            'signal_name': sig_name
        })

        if capital <= 0:
            break

    wins = sum(1 for t in trades if t['won'])
    losses = len(trades) - wins

    return capital, len(trades), wins, losses, trades, signal_counts


# ============================================================================
# MONTE CARLO ANALYSIS
# ============================================================================

def run_monte_carlo(num_runs=50):
    """Run Monte Carlo simulations comparing all strategies."""
    print("=" * 80)
    print("AGGRESSIVE STRATEGY ENHANCEMENT EXPERIMENT")
    print("=" * 80)
    print(f"Starting Capital: ${STARTING_CAPITAL}")
    print(f"Days: {DAYS}")
    print(f"Monte Carlo Runs: {num_runs}")
    print(f"Position Size: ${POSITION_SIZE}")
    print(f"Max Entry: {MAX_ENTRY_PRICE * 100}c")
    print(f"Prob Band: {PROB_LO * 100}-{PROB_HI * 100}%")
    print("=" * 80)
    print()

    results = {
        'strategy_a_current': [],
        'strategy_b_weak_bear': [],
        'strategy_c_weak_both': []
    }

    for run in range(num_runs):
        print(f"Run {run + 1}/{num_runs}...", end=" ", flush=True)

        candles = generate_btc_candles(DAYS, HOURS_PER_DAY)
        calculate_indicators(candles)

        # Strategy A: Current Aggressive
        final_a, trades_a, wins_a, losses_a, log_a, signals_a = simulate_strategy(
            candles, 'Current Aggressive', check_strategy_a_signal
        )

        # Strategy B: Enhanced with weak-trend bearish
        final_b, trades_b, wins_b, losses_b, log_b, signals_b = simulate_strategy(
            candles, 'Enhanced Weak Bear', check_strategy_b_signal
        )

        # Strategy C: Enhanced bidirectional
        final_c, trades_c, wins_c, losses_c, log_c, signals_c = simulate_strategy(
            candles, 'Enhanced Bidirectional', check_strategy_c_signal
        )

        results['strategy_a_current'].append({
            'run': run + 1,
            'final_capital': final_a,
            'return_pct': ((final_a - STARTING_CAPITAL) / STARTING_CAPITAL) * 100,
            'total_trades': trades_a,
            'wins': wins_a,
            'losses': losses_a,
            'win_rate': (wins_a / trades_a * 100) if trades_a > 0 else 0,
            'ruined': final_a <= 0,
            'signals': signals_a
        })

        results['strategy_b_weak_bear'].append({
            'run': run + 1,
            'final_capital': final_b,
            'return_pct': ((final_b - STARTING_CAPITAL) / STARTING_CAPITAL) * 100,
            'total_trades': trades_b,
            'wins': wins_b,
            'losses': losses_b,
            'win_rate': (wins_b / trades_b * 100) if trades_b > 0 else 0,
            'ruined': final_b <= 0,
            'signals': signals_b
        })

        results['strategy_c_weak_both'].append({
            'run': run + 1,
            'final_capital': final_c,
            'return_pct': ((final_c - STARTING_CAPITAL) / STARTING_CAPITAL) * 100,
            'total_trades': trades_c,
            'wins': wins_c,
            'losses': losses_c,
            'win_rate': (wins_c / trades_c * 100) if trades_c > 0 else 0,
            'ruined': final_c <= 0,
            'signals': signals_c
        })

        print(f"A: ${final_a:.0f} ({trades_a} trades) | B: ${final_b:.0f} ({trades_b}) | C: ${final_c:.0f} ({trades_c})")

    return results


def analyze_results(results):
    """Analyze and print results."""
    print()
    print("=" * 80)
    print("RESULTS SUMMARY")
    print("=" * 80)

    summaries = []

    for strategy_name, runs in results.items():
        print(f"\n{strategy_name.upper().replace('_', ' ')}")
        print("-" * 80)

        final_capitals = [r['final_capital'] for r in runs]
        returns = [r['return_pct'] for r in runs]
        trades = [r['total_trades'] for r in runs]
        win_rates = [r['win_rate'] for r in runs]
        ruin_count = sum(1 for r in runs if r['ruined'])

        avg_capital = sum(final_capitals) / len(final_capitals)
        avg_return = sum(returns) / len(returns)
        avg_trades = sum(trades) / len(trades)
        avg_win_rate = sum(win_rates) / len(win_rates)

        min_capital = min(final_capitals)
        max_capital = max(final_capitals)

        print(f"Average Final Capital: ${avg_capital:.2f}")
        print(f"Average Return: {avg_return:+.1f}%")
        print(f"Range: ${min_capital:.2f} to ${max_capital:.2f}")
        print(f"Average Trades: {avg_trades:.0f}")
        print(f"Average Win Rate: {avg_win_rate:.1f}%")
        print(f"Ruin Rate: {ruin_count}/{len(runs)} ({ruin_count/len(runs)*100:.0f}%)")

        profitable = sum(1 for r in runs if r['final_capital'] > STARTING_CAPITAL)
        print(f"Profitable Runs: {profitable}/{len(runs)} ({profitable/len(runs)*100:.0f}%)")

        # Signal usage analysis
        all_signals = {}
        for r in runs:
            for sig, count in r['signals'].items():
                all_signals[sig] = all_signals.get(sig, 0) + count

        if all_signals:
            print(f"\nSignal Usage (total across {len(runs)} runs):")
            for sig, count in sorted(all_signals.items(), key=lambda x: x[1], reverse=True):
                print(f"  {sig}: {count} trades ({count/len(runs):.1f}/run)")

        summaries.append({
            'name': strategy_name,
            'avg_capital': avg_capital,
            'avg_return': avg_return,
            'avg_trades': avg_trades,
            'avg_win_rate': avg_win_rate,
            'ruin_count': ruin_count,
            'profitable': profitable
        })

    print()
    print("=" * 80)
    print("COMPARISON")
    print("=" * 80)

    baseline = next(s for s in summaries if s['name'] == 'strategy_a_current')

    for strategy in summaries:
        if strategy['name'] == 'strategy_a_current':
            print(f"\nBASELINE: {strategy['name']}")
        else:
            print(f"\n{strategy['name']}")

        print(f"  Avg Capital: ${strategy['avg_capital']:.2f}")
        print(f"  Avg Return: {strategy['avg_return']:+.1f}%")
        print(f"  Avg Trades: {strategy['avg_trades']:.0f}")
        print(f"  Avg Win Rate: {strategy['avg_win_rate']:.1f}%")

        if strategy['name'] != 'strategy_a_current':
            improvement = strategy['avg_capital'] - baseline['avg_capital']
            improvement_pct = (improvement / baseline['avg_capital']) * 100
            print(f"  Improvement: ${improvement:+.2f} ({improvement_pct:+.1f}%)")

    print()

    # Determine best strategy
    best = max(summaries, key=lambda x: x['avg_capital'])
    print(f"BEST STRATEGY: {best['name']}")
    print(f"  ${best['avg_capital']:.2f} avg capital, {best['avg_return']:+.1f}% return")

    return summaries


# ============================================================================
# MAIN
# ============================================================================

if __name__ == '__main__':
    random.seed(42)
    results = run_monte_carlo(MONTE_CARLO_RUNS)
    summaries = analyze_results(results)

    # Save results
    output_dir = Path('data')
    output_dir.mkdir(exist_ok=True)

    output_file = output_dir / 'aggressive_enhanced_results.json'
    with open(output_file, 'w') as f:
        json.dump({
            'config': {
                'starting_capital': STARTING_CAPITAL,
                'days': DAYS,
                'monte_carlo_runs': MONTE_CARLO_RUNS,
                'position_size': POSITION_SIZE,
                'max_entry_price': MAX_ENTRY_PRICE,
                'prob_lo': PROB_LO,
                'prob_hi': PROB_HI,
                'weak_trend_max': WEAK_TREND_MAX
            },
            'results': results,
            'summaries': summaries,
            'timestamp': datetime.now().isoformat()
        }, f, indent=2)

    print(f"\nResults saved to: {output_file}")
    print()
    print("=" * 80)
    print("EXPERIMENT COMPLETE")
    print("=" * 80)
