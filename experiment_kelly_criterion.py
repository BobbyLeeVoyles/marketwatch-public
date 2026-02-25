"""
Kelly Criterion Position Sizing Experiment
===========================================

Tests different position sizing strategies for aggressive bot:
1. Fixed position (baseline - $20)
2. Full Kelly
3. Fractional Kelly (0.25, 0.5, 0.75)
4. Kelly + signal strength multiplier
5. Kelly + volatility adjustment
6. Kelly + win rate adjustment
7. Kelly + multi-factor (signal + vol + win rate)
8. Dynamic Kelly (adjusts based on recent performance)
9. Risk-limited Kelly (max position cap)
10. Bankroll-percentage Kelly

Extensive testing to find optimal position sizing strategy.
"""

import json
import random
import math
from datetime import datetime
from pathlib import Path
from collections import deque

# ============================================================================
# CONFIGURATION
# ============================================================================

STARTING_CAPITAL = 100.0
DAYS = 365
HOURS_PER_DAY = 24
MONTE_CARLO_RUNS = 50

# Baseline parameters
BASE_POSITION_SIZE = 20.0
MAX_ENTRY_PRICE = 0.25
MIN_TIME_REMAINING = 15
PROB_LO = 0.05
PROB_HI = 0.45
STRIKE_INCREMENT = 250

# Kelly parameters
HISTORICAL_WIN_RATE = 0.38  # From previous experiments
HISTORICAL_AVG_WIN = 1.0  # Win = 1x payout
HISTORICAL_AVG_LOSS = 1.0  # Loss = 1x entry price
MAX_POSITION_CAP = 50.0  # Maximum position size (risk limit)
MIN_POSITION_SIZE = 5.0  # Minimum position size

# Signal strength multipliers
WEAK_SIGNAL_MULTIPLIER = 0.7
MEDIUM_SIGNAL_MULTIPLIER = 1.0
STRONG_SIGNAL_MULTIPLIER = 1.3
VERY_STRONG_SIGNAL_MULTIPLIER = 1.6

# ============================================================================
# PRICING MODEL
# ============================================================================

def normal_cdf(x: float) -> float:
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


def estimate_contract_fair_value(btc_price, strike, volatility_pct, minutes_remaining):
    if btc_price <= 0 or volatility_pct <= 0:
        return 0.5
    time_factor_hours = max(minutes_remaining, 0.5) / 60
    expected_move = btc_price * (volatility_pct / 100) * math.sqrt(time_factor_hours)
    if expected_move <= 0:
        return 0.99 if btc_price >= strike else 0.01
    z_score = (btc_price - strike) / expected_move
    probability = normal_cdf(z_score)
    if minutes_remaining <= 2:
        certainty_boost = 0.15 * (1 - minutes_remaining / 2)
        if probability > 0.5:
            probability = probability + (1 - probability) * certainty_boost
        else:
            probability = probability * (1 - certainty_boost)
    return max(0.01, min(0.99, probability))


def calculate_strike(btc_price, strike_type):
    if strike_type == 'ATM':
        return round(btc_price / STRIKE_INCREMENT) * STRIKE_INCREMENT
    else:
        return math.floor(btc_price / STRIKE_INCREMENT) * STRIKE_INCREMENT


# ============================================================================
# DATA GENERATION
# ============================================================================

def generate_btc_candles(days=365, hours_per_day=24):
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
    for i in range(len(candles)):
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

        if i >= 1:
            candles[i]['rolling_1h'] = ((candles[i]['close'] - candles[i-1]['close']) / candles[i-1]['close']) * 100
        else:
            candles[i]['rolling_1h'] = 0

        if i >= 2:
            candles[i]['rolling_2h'] = ((candles[i]['close'] - candles[i-2]['close']) / candles[i-2]['close']) * 100
        else:
            candles[i]['rolling_2h'] = 0

        if i >= 6:
            avg_vol = sum(c['volume'] for c in candles[i-6:i]) / 6
            candles[i]['volume_ratio'] = candles[i]['volume'] / avg_vol if avg_vol > 0 else 1.0
        else:
            candles[i]['volume_ratio'] = 1.0

        if i >= 6:
            returns = [c['change_pct'] for c in candles[i-6:i+1]]
            mean_return = sum(returns) / len(returns)
            variance = sum((r - mean_return) ** 2 for r in returns) / len(returns)
            candles[i]['volatility'] = math.sqrt(variance)
        else:
            candles[i]['volatility'] = 1.5


# ============================================================================
# SIGNAL DETECTION (Enhanced Aggressive)
# ============================================================================

def check_signal_with_strength(candle, minutes_remaining=30):
    """
    Returns signal with strength score (1-4):
    1 = Single weak signal
    2 = Single strong signal
    3 = Multiple signals firing
    4 = Very strong multi-signal setup
    """
    sma6 = candle['sma6']
    sma12 = candle['sma12']
    ret1h = candle['rolling_1h']
    ret2h = candle['rolling_2h']
    vol_ratio = candle['volume_ratio']
    price = candle['close']
    volatility = candle['volatility']

    signals = []
    signal_strength = 0

    # Strong momentum signals (high weight)
    if ret1h > 0.20:
        signals.append(('yes', 'BULL ROLLING MOM'))
        signal_strength += 2
    if ret1h < -0.20:
        signals.append(('no', 'BEAR ROLLING MOM'))
        signal_strength += 2

    # Multi-hour momentum (high weight)
    if ret1h > 0.10 and ret2h > 0.20:
        signals.append(('yes', 'BULL MULTI-HOUR'))
        signal_strength += 2
    if ret1h < -0.10 and ret2h < -0.20:
        signals.append(('no', 'BEAR MULTI-HOUR'))
        signal_strength += 2

    # Volume confirmation (medium weight)
    if vol_ratio >= 1.5 and ret1h > 0.20:
        signals.append(('yes', 'BULL VOL+MOM'))
        signal_strength += 1
    if vol_ratio >= 1.5 and ret1h < -0.20:
        signals.append(('no', 'BEAR VOL+MOM'))
        signal_strength += 1

    # Weak-trend signals (low weight)
    if sma6 > sma12:
        trend_strength = (sma6 - sma12) / sma12 if sma12 > 0 else 0
        if trend_strength < 0.005 and (ret1h < 0 or ret2h < 0):
            signals.append(('no', 'BEAR WEAK TREND'))
            signal_strength += 1

    if sma6 < sma12:
        trend_strength = (sma12 - sma6) / sma12 if sma12 > 0 else 0
        if trend_strength < 0.005 and (ret1h > 0 or ret2h > 0):
            signals.append(('yes', 'BULL WEAK TREND'))
            signal_strength += 1

    if not signals:
        return None

    direction, signal_name = signals[0]

    floor_strike = calculate_strike(price, 'OTM')
    strike = floor_strike + STRIKE_INCREMENT if direction == 'yes' else floor_strike

    yes_fv = estimate_contract_fair_value(price, strike, volatility, minutes_remaining)
    fair_value = yes_fv if direction == 'yes' else 1 - yes_fv

    if not (PROB_LO <= fair_value <= PROB_HI):
        return None

    entry_price = min(MAX_ENTRY_PRICE, math.floor(fair_value * 100) / 100)
    if entry_price <= 0.01:
        return None

    # Normalize strength to 1-4 scale
    strength_score = min(4, max(1, signal_strength // 2 + 1))

    return {
        'direction': direction,
        'strike': strike,
        'entry_price': entry_price,
        'fair_value': fair_value,
        'signal_name': signal_name,
        'strength': strength_score,  # 1=weak, 2=medium, 3=strong, 4=very strong
        'volatility': volatility,
        'signal_count': len(signals)
    }


# ============================================================================
# KELLY CRITERION CALCULATIONS
# ============================================================================

def calculate_full_kelly(win_rate, avg_win, avg_loss):
    """
    Full Kelly Criterion: f* = (p × b - q) / b
    where p = win rate, q = loss rate, b = odds (avg_win / avg_loss)
    """
    if avg_loss == 0:
        return 0

    q = 1 - win_rate
    b = avg_win / avg_loss

    kelly = (win_rate * b - q) / b
    return max(0, kelly)  # Never negative


def calculate_fractional_kelly(win_rate, avg_win, avg_loss, fraction):
    """Fractional Kelly for more conservative sizing."""
    full_kelly = calculate_full_kelly(win_rate, avg_win, avg_loss)
    return full_kelly * fraction


# ============================================================================
# POSITION SIZING STRATEGIES
# ============================================================================

def size_fixed(signal, capital, recent_history):
    """Strategy 1: Fixed position sizing (baseline)."""
    return BASE_POSITION_SIZE


def size_full_kelly(signal, capital, recent_history):
    """Strategy 2: Full Kelly based on historical performance."""
    kelly_fraction = calculate_full_kelly(
        HISTORICAL_WIN_RATE,
        HISTORICAL_AVG_WIN,
        HISTORICAL_AVG_LOSS
    )

    position = capital * kelly_fraction
    return min(position, MAX_POSITION_CAP)


def size_half_kelly(signal, capital, recent_history):
    """Strategy 3: Half Kelly (0.5 fraction)."""
    kelly_fraction = calculate_fractional_kelly(
        HISTORICAL_WIN_RATE,
        HISTORICAL_AVG_WIN,
        HISTORICAL_AVG_LOSS,
        0.5
    )

    position = capital * kelly_fraction
    return min(position, MAX_POSITION_CAP)


def size_quarter_kelly(signal, capital, recent_history):
    """Strategy 4: Quarter Kelly (0.25 fraction)."""
    kelly_fraction = calculate_fractional_kelly(
        HISTORICAL_WIN_RATE,
        HISTORICAL_AVG_WIN,
        HISTORICAL_AVG_LOSS,
        0.25
    )

    position = capital * kelly_fraction
    return min(position, MAX_POSITION_CAP)


def size_three_quarter_kelly(signal, capital, recent_history):
    """Strategy 5: Three-quarter Kelly (0.75 fraction)."""
    kelly_fraction = calculate_fractional_kelly(
        HISTORICAL_WIN_RATE,
        HISTORICAL_AVG_WIN,
        HISTORICAL_AVG_LOSS,
        0.75
    )

    position = capital * kelly_fraction
    return min(position, MAX_POSITION_CAP)


def size_kelly_signal_strength(signal, capital, recent_history):
    """Strategy 6: Half Kelly × signal strength multiplier."""
    base_kelly = calculate_fractional_kelly(
        HISTORICAL_WIN_RATE,
        HISTORICAL_AVG_WIN,
        HISTORICAL_AVG_LOSS,
        0.5
    )

    # Adjust by signal strength
    strength = signal['strength']
    if strength == 1:
        multiplier = WEAK_SIGNAL_MULTIPLIER
    elif strength == 2:
        multiplier = MEDIUM_SIGNAL_MULTIPLIER
    elif strength == 3:
        multiplier = STRONG_SIGNAL_MULTIPLIER
    else:
        multiplier = VERY_STRONG_SIGNAL_MULTIPLIER

    position = capital * base_kelly * multiplier
    return min(position, MAX_POSITION_CAP)


def size_kelly_volatility_adjusted(signal, capital, recent_history):
    """Strategy 7: Half Kelly × volatility adjustment."""
    base_kelly = calculate_fractional_kelly(
        HISTORICAL_WIN_RATE,
        HISTORICAL_AVG_WIN,
        HISTORICAL_AVG_LOSS,
        0.5
    )

    # Adjust by volatility (lower vol = larger position)
    volatility = signal['volatility']
    if volatility < 1.0:
        vol_multiplier = 1.3
    elif volatility < 1.5:
        vol_multiplier = 1.0
    elif volatility < 2.0:
        vol_multiplier = 0.8
    else:
        vol_multiplier = 0.6

    position = capital * base_kelly * vol_multiplier
    return min(position, MAX_POSITION_CAP)


def size_kelly_win_rate_adjusted(signal, capital, recent_history):
    """Strategy 8: Dynamic Kelly based on recent win rate."""
    if len(recent_history) < 20:
        # Use historical until we have enough data
        win_rate = HISTORICAL_WIN_RATE
    else:
        # Calculate recent win rate (last 50 trades)
        recent_trades = list(recent_history)[-50:]
        wins = sum(1 for t in recent_trades if t['won'])
        win_rate = wins / len(recent_trades)

    kelly_fraction = calculate_fractional_kelly(
        win_rate,
        HISTORICAL_AVG_WIN,
        HISTORICAL_AVG_LOSS,
        0.5
    )

    position = capital * kelly_fraction
    return min(position, MAX_POSITION_CAP)


def size_kelly_multi_factor(signal, capital, recent_history):
    """Strategy 9: Half Kelly × (signal + vol + win rate) adjustments."""
    # Base Kelly
    if len(recent_history) < 20:
        win_rate = HISTORICAL_WIN_RATE
    else:
        recent_trades = list(recent_history)[-50:]
        wins = sum(1 for t in recent_trades if t['won'])
        win_rate = max(0.2, wins / len(recent_trades))  # Floor at 20%

    base_kelly = calculate_fractional_kelly(
        win_rate,
        HISTORICAL_AVG_WIN,
        HISTORICAL_AVG_LOSS,
        0.5
    )

    # Signal strength multiplier
    strength = signal['strength']
    if strength == 1:
        sig_mult = 0.7
    elif strength == 2:
        sig_mult = 1.0
    elif strength == 3:
        sig_mult = 1.2
    else:
        sig_mult = 1.4

    # Volatility multiplier
    volatility = signal['volatility']
    if volatility < 1.0:
        vol_mult = 1.2
    elif volatility < 1.5:
        vol_mult = 1.0
    elif volatility < 2.0:
        vol_mult = 0.85
    else:
        vol_mult = 0.7

    # Probability multiplier (higher prob = more confident)
    fair_value = signal['fair_value']
    if fair_value > 0.35:
        prob_mult = 1.1
    elif fair_value > 0.25:
        prob_mult = 1.0
    else:
        prob_mult = 0.9

    position = capital * base_kelly * sig_mult * vol_mult * prob_mult
    return min(position, MAX_POSITION_CAP)


def size_bankroll_percentage(signal, capital, recent_history):
    """Strategy 10: Fixed percentage of bankroll (2%)."""
    return capital * 0.02


def size_risk_limited_kelly(signal, capital, recent_history):
    """Strategy 11: Half Kelly with strict risk limits."""
    base_kelly = calculate_fractional_kelly(
        HISTORICAL_WIN_RATE,
        HISTORICAL_AVG_WIN,
        HISTORICAL_AVG_LOSS,
        0.5
    )

    position = capital * base_kelly

    # Strict limits
    position = max(MIN_POSITION_SIZE, position)
    position = min(MAX_POSITION_CAP * 0.5, position)  # Half of max cap

    # Never risk more than 5% of bankroll on single trade
    position = min(position, capital * 0.05)

    return position


# ============================================================================
# SIMULATION ENGINE
# ============================================================================

def simulate_strategy(candles, strategy_name, sizing_func):
    """Simulate trading with specified position sizing strategy."""
    capital = STARTING_CAPITAL
    trades = []
    recent_history = deque(maxlen=100)  # Track last 100 trades

    for i in range(len(candles) - 1):
        current_candle = candles[i]
        next_candle = candles[i + 1]

        signal = check_signal_with_strength(current_candle, minutes_remaining=30)
        if signal is None:
            continue

        # Calculate position size using strategy
        position_size = sizing_func(signal, capital, recent_history)

        # Skip if position too small
        if position_size < MIN_POSITION_SIZE:
            continue

        entry_price = signal['entry_price']
        contracts = math.floor(position_size / entry_price)

        if contracts == 0:
            continue

        cost = entry_price * contracts

        # Check if we can afford
        if capital < cost:
            continue

        capital -= cost

        # Settlement
        settlement_price = next_candle['close']
        strike = signal['strike']
        direction = signal['direction']

        if direction == 'yes':
            won = settlement_price >= strike
        else:
            won = settlement_price < strike

        payout = contracts if won else 0
        pnl = payout - cost
        capital += payout

        trade = {
            'hour': current_candle['hour'],
            'direction': direction,
            'won': won,
            'pnl': pnl,
            'capital': capital,
            'position_size': position_size,
            'contracts': contracts,
            'strength': signal['strength']
        }

        trades.append(trade)
        recent_history.append(trade)

        if capital <= 0:
            break

    wins = sum(1 for t in trades if t['won'])
    losses = len(trades) - wins

    # Calculate position size stats
    if trades:
        avg_position = sum(t['position_size'] for t in trades) / len(trades)
        max_position = max(t['position_size'] for t in trades)
        min_position = min(t['position_size'] for t in trades)
    else:
        avg_position = max_position = min_position = 0

    return capital, len(trades), wins, losses, avg_position, max_position, min_position


# ============================================================================
# MONTE CARLO ANALYSIS
# ============================================================================

def run_monte_carlo(num_runs=50):
    print("=" * 80)
    print("KELLY CRITERION POSITION SIZING EXPERIMENT")
    print("=" * 80)
    print(f"Testing {11} position sizing strategies")
    print(f"Monte Carlo Runs: {num_runs} × 365 days each")
    print("=" * 80)
    print()

    strategies = [
        ('fixed_20', size_fixed),
        ('full_kelly', size_full_kelly),
        ('quarter_kelly', size_quarter_kelly),
        ('half_kelly', size_half_kelly),
        ('three_quarter_kelly', size_three_quarter_kelly),
        ('kelly_signal_strength', size_kelly_signal_strength),
        ('kelly_volatility', size_kelly_volatility_adjusted),
        ('kelly_win_rate', size_kelly_win_rate_adjusted),
        ('kelly_multi_factor', size_kelly_multi_factor),
        ('bankroll_2pct', size_bankroll_percentage),
        ('risk_limited_kelly', size_risk_limited_kelly),
    ]

    results = {name: [] for name, _ in strategies}

    for run in range(num_runs):
        print(f"Run {run + 1}/{num_runs}...", end=" ", flush=True)

        candles = generate_btc_candles(DAYS, HOURS_PER_DAY)
        calculate_indicators(candles)

        run_results = []
        for name, func in strategies:
            final, trades, wins, losses, avg_pos, max_pos, min_pos = simulate_strategy(
                candles, name, func
            )

            results[name].append({
                'run': run + 1,
                'final_capital': final,
                'return_pct': ((final - STARTING_CAPITAL) / STARTING_CAPITAL) * 100,
                'total_trades': trades,
                'wins': wins,
                'losses': losses,
                'win_rate': (wins / trades * 100) if trades > 0 else 0,
                'ruined': final <= 0,
                'avg_position': avg_pos,
                'max_position': max_pos,
                'min_position': min_pos
            })

            run_results.append(f"{name[:4]}:${final:.0f}")

        print(" | ".join(run_results[:6]))
        print(" " * 15 + " | ".join(run_results[6:]))

    return results


def analyze_results(results):
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
        win_rates = [r['win_rate'] for r in runs if r['total_trades'] > 0]
        ruin_count = sum(1 for r in runs if r['ruined'])
        avg_positions = [r['avg_position'] for r in runs if r['total_trades'] > 0]
        max_positions = [r['max_position'] for r in runs if r['total_trades'] > 0]

        avg_capital = sum(final_capitals) / len(final_capitals)
        avg_return = sum(returns) / len(returns)
        avg_trades = sum(trades) / len(trades)
        avg_win_rate = sum(win_rates) / len(win_rates) if win_rates else 0
        avg_avg_position = sum(avg_positions) / len(avg_positions) if avg_positions else 0
        avg_max_position = sum(max_positions) / len(max_positions) if max_positions else 0

        min_capital = min(final_capitals)
        max_capital = max(final_capitals)

        print(f"Average Final Capital: ${avg_capital:.2f}")
        print(f"Average Return: {avg_return:+.1f}%")
        print(f"Range: ${min_capital:.2f} to ${max_capital:.2f}")
        print(f"Average Trades: {avg_trades:.0f}")
        print(f"Average Win Rate: {avg_win_rate:.1f}%")
        print(f"Ruin Rate: {ruin_count}/{len(runs)} ({ruin_count/len(runs)*100:.0f}%)")
        print(f"Avg Position Size: ${avg_avg_position:.2f}")
        print(f"Avg Max Position: ${avg_max_position:.2f}")

        profitable = sum(1 for r in runs if r['final_capital'] > STARTING_CAPITAL)
        print(f"Profitable Runs: {profitable}/{len(runs)} ({profitable/len(runs)*100:.0f}%)")

        summaries.append({
            'name': strategy_name,
            'avg_capital': avg_capital,
            'avg_return': avg_return,
            'avg_trades': avg_trades,
            'avg_win_rate': avg_win_rate,
            'ruin_count': ruin_count,
            'profitable': profitable,
            'avg_position': avg_avg_position,
            'max_position': avg_max_position
        })

    print()
    print("=" * 80)
    print("COMPARISON VS FIXED BASELINE")
    print("=" * 80)

    baseline = next(s for s in summaries if 'fixed' in s['name'])
    print(f"\nBASELINE: Fixed $20 Position")
    print(f"  ${baseline['avg_capital']:.2f}, {baseline['avg_return']:+.1f}%, {baseline['avg_trades']:.0f} trades")

    sorted_strategies = sorted(summaries, key=lambda x: x['avg_capital'], reverse=True)

    for i, strategy in enumerate(sorted_strategies):
        if 'fixed' in strategy['name']:
            continue

        improvement = strategy['avg_capital'] - baseline['avg_capital']
        improvement_pct = (improvement / baseline['avg_capital']) * 100

        symbol = "✅" if improvement > 0 else "❌"
        rank = f"#{i+1}"
        print(f"\n{symbol} {rank} {strategy['name'].replace('_', ' ').upper()}")
        print(f"  ${strategy['avg_capital']:.2f}, {strategy['avg_return']:+.1f}%, {strategy['avg_trades']:.0f} trades")
        print(f"  Avg Position: ${strategy['avg_position']:.2f}, Max: ${strategy['max_position']:.2f}")
        print(f"  Improvement: ${improvement:+.2f} ({improvement_pct:+.1f}%)")

    print()
    best = sorted_strategies[0]
    print(f"BEST STRATEGY: {best['name'].replace('_', ' ').upper()}")
    print(f"  ${best['avg_capital']:.2f} avg capital ({best['avg_return']:+.1f}% return)")
    print(f"  Avg position: ${best['avg_position']:.2f}")

    return summaries


# ============================================================================
# MAIN
# ============================================================================

if __name__ == '__main__':
    random.seed(42)
    results = run_monte_carlo(MONTE_CARLO_RUNS)
    summaries = analyze_results(results)

    output_dir = Path('data')
    output_dir.mkdir(exist_ok=True)

    output_file = output_dir / 'kelly_criterion_results.json'
    with open(output_file, 'w') as f:
        json.dump({
            'config': {
                'starting_capital': STARTING_CAPITAL,
                'days': DAYS,
                'monte_carlo_runs': MONTE_CARLO_RUNS,
                'base_position': BASE_POSITION_SIZE,
                'max_position_cap': MAX_POSITION_CAP,
                'min_position': MIN_POSITION_SIZE
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
