"""
Edge Case Price Sniping Experiment
===================================

Tests special-situation strategies that exploit pricing inefficiencies during:
- Volatility spikes
- Big price swings
- Rapid reversals
- Strike positioning anomalies
- Time decay opportunities
- Gap movements

Compares against enhanced aggressive baseline to find additional alpha.
"""

import json
import random
import math
from datetime import datetime
from pathlib import Path

# ============================================================================
# CONFIGURATION
# ============================================================================

STARTING_CAPITAL = 100.0
DAYS = 365
HOURS_PER_DAY = 24
MONTE_CARLO_RUNS = 50

POSITION_SIZE = 20.0
MAX_ENTRY_PRICE = 0.25
MIN_TIME_REMAINING = 15
PROB_LO = 0.05
PROB_HI = 0.45
STRIKE_INCREMENT = 250

# Edge case thresholds
VOL_SPIKE_MULTIPLIER = 2.0  # Volatility must be 2x+ average
BIG_SWING_THRESHOLD = 1.0  # Absolute return > 1.0%
REVERSAL_THRESHOLD = 0.8  # Reversal > 0.8% after big move
GAP_THRESHOLD = 0.5  # Gap > 0.5% between candles
TIME_DECAY_WINDOW = 20  # Enter in last 20 minutes
STRIKE_MISPRICING_THRESHOLD = 0.15  # 15% gap between strikes

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

        # Volume ratio
        if i >= 6:
            avg_vol = sum(c['volume'] for c in candles[i-6:i]) / 6
            candles[i]['volume_ratio'] = candles[i]['volume'] / avg_vol if avg_vol > 0 else 1.0
        else:
            candles[i]['volume_ratio'] = 1.0

        # Current volatility
        if i >= 6:
            returns = [c['change_pct'] for c in candles[i-6:i+1]]
            mean_return = sum(returns) / len(returns)
            variance = sum((r - mean_return) ** 2 for r in returns) / len(returns)
            candles[i]['volatility'] = math.sqrt(variance)
        else:
            candles[i]['volatility'] = 1.5

        # Average volatility (for spike detection)
        if i >= 12:
            vol_lookback = [candles[j]['volatility'] for j in range(i-12, i)]
            candles[i]['avg_volatility'] = sum(vol_lookback) / len(vol_lookback)
        else:
            candles[i]['avg_volatility'] = candles[i]['volatility']

        # Gap detection (open vs prev close)
        if i >= 1:
            candles[i]['gap_pct'] = ((candles[i]['open'] - candles[i-1]['close']) / candles[i-1]['close']) * 100
        else:
            candles[i]['gap_pct'] = 0


# ============================================================================
# BASELINE: ENHANCED AGGRESSIVE
# ============================================================================

def check_enhanced_aggressive(candle, minutes_remaining=30):
    """Enhanced aggressive with weak-trend signals (baseline)."""
    sma6 = candle['sma6']
    sma12 = candle['sma12']
    ret1h = candle['rolling_1h']
    ret2h = candle['rolling_2h']
    price = candle['close']
    volatility = candle['volatility']

    signals = []

    # Strong momentum signals
    if ret1h > 0.20:
        signals.append(('yes', 'BULL ROLLING MOM'))
    if ret1h < -0.20:
        signals.append(('no', 'BEAR ROLLING MOM'))

    if ret1h > 0.10 and ret2h > 0.20:
        signals.append(('yes', 'BULL MULTI-HOUR'))
    if ret1h < -0.10 and ret2h < -0.20:
        signals.append(('no', 'BEAR MULTI-HOUR'))

    # Weak-trend signals
    if sma6 > sma12:
        trend_strength = (sma6 - sma12) / sma12 if sma12 > 0 else 0
        if trend_strength < 0.005 and (ret1h < 0 or ret2h < 0):
            signals.append(('no', 'BEAR WEAK TREND'))

    if sma6 < sma12:
        trend_strength = (sma12 - sma6) / sma12 if sma12 > 0 else 0
        if trend_strength < 0.005 and (ret1h > 0 or ret2h > 0):
            signals.append(('yes', 'BULL WEAK TREND'))

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

    contracts = math.floor(POSITION_SIZE / entry_price)
    if contracts == 0:
        return None

    return {
        'direction': direction,
        'strike': strike,
        'entry_price': entry_price,
        'contracts': contracts,
        'cost': entry_price * contracts,
        'signal_name': signal_name
    }


# ============================================================================
# EDGE CASE STRATEGY 1: VOLATILITY SPIKE SNIPER
# ============================================================================

def check_volatility_spike(candle, minutes_remaining=30):
    """
    Enter when volatility spikes significantly above average.

    Theory: During vol spikes, contract pricing lags real risk.
    We can buy cheap contracts that should be more expensive.
    """
    price = candle['close']
    volatility = candle['volatility']
    avg_vol = candle['avg_volatility']
    ret1h = candle['rolling_1h']

    # Detect spike
    if volatility < avg_vol * VOL_SPIKE_MULTIPLIER:
        return None

    # Direction based on current momentum
    if ret1h > 0:
        direction = 'yes'
    elif ret1h < 0:
        direction = 'no'
    else:
        return None

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
        'signal_name': f'VOL SPIKE {volatility/avg_vol:.1f}x'
    }


# ============================================================================
# EDGE CASE STRATEGY 2: BIG SWING CONTINUATION
# ============================================================================

def check_big_swing_continuation(candle, minutes_remaining=30):
    """
    Enter after big moves, betting on continuation.

    Theory: Large hourly moves (>1%) tend to continue into next hour
    due to momentum and stop-loss cascades.
    """
    price = candle['close']
    volatility = candle['volatility']
    ret1h = candle['rolling_1h']

    # Detect big swing
    if abs(ret1h) < BIG_SWING_THRESHOLD:
        return None

    # Direction = same as swing
    direction = 'yes' if ret1h > 0 else 'no'

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
        'signal_name': f'BIG SWING {ret1h:+.1f}%'
    }


# ============================================================================
# EDGE CASE STRATEGY 3: RAPID REVERSAL SNIPER
# ============================================================================

def check_rapid_reversal(candle, minutes_remaining=30):
    """
    Enter when price reverses sharply after big move.

    Theory: Whipsaws create mispricing as market overreacts.
    Buy the reversal before pricing catches up.
    """
    price = candle['close']
    volatility = candle['volatility']
    ret1h = candle['rolling_1h']
    ret2h = candle['rolling_2h']

    # Detect reversal: 2h ago big move, 1h ago opposite move
    if abs(ret2h) < BIG_SWING_THRESHOLD:
        return None

    if abs(ret1h) < REVERSAL_THRESHOLD:
        return None

    # Must be opposite directions
    if (ret2h > 0 and ret1h > 0) or (ret2h < 0 and ret1h < 0):
        return None

    # Direction = continuation of reversal
    direction = 'yes' if ret1h > 0 else 'no'

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
        'signal_name': f'REVERSAL {ret2h:+.1f}%->{ret1h:+.1f}%'
    }


# ============================================================================
# EDGE CASE STRATEGY 4: TIME DECAY SNIPER
# ============================================================================

def check_time_decay_snipe(candle, minutes_remaining=30):
    """
    Enter in last 10-20 minutes when time decay accelerates.

    Theory: Contract pricing may lag in final minutes as traders
    don't update bids fast enough. Especially true if momentum is clear.
    """
    price = candle['close']
    volatility = candle['volatility']
    ret1h = candle['rolling_1h']

    # Only enter in time decay window
    if minutes_remaining > TIME_DECAY_WINDOW or minutes_remaining < 5:
        return None

    # Need clear momentum
    if abs(ret1h) < 0.15:
        return None

    direction = 'yes' if ret1h > 0 else 'no'

    floor_strike = calculate_strike(price, 'OTM')
    strike = floor_strike + STRIKE_INCREMENT if direction == 'yes' else floor_strike

    yes_fv = estimate_contract_fair_value(price, strike, volatility, minutes_remaining)
    fair_value = yes_fv if direction == 'yes' else 1 - yes_fv

    # Wider probability band for time decay (more opportunities)
    if not (PROB_LO <= fair_value <= 0.60):
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
        'signal_name': f'TIME DECAY {minutes_remaining}m'
    }


# ============================================================================
# EDGE CASE STRATEGY 5: GAP TRADING
# ============================================================================

def check_gap_trade(candle, minutes_remaining=30):
    """
    Enter when price gaps significantly at open.

    Theory: Gaps often fill during the hour. If gap up, bet on continuation
    or reversal based on gap size.
    """
    price = candle['close']
    volatility = candle['volatility']
    gap_pct = candle['gap_pct']
    ret1h = candle['rolling_1h']

    # Detect significant gap
    if abs(gap_pct) < GAP_THRESHOLD:
        return None

    # Gap continuation strategy (gaps tend to continue intraday)
    direction = 'yes' if gap_pct > 0 else 'no'

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
        'signal_name': f'GAP {gap_pct:+.1f}%'
    }


# ============================================================================
# EDGE CASE STRATEGY 6: COMBINED EDGE CASES
# ============================================================================

def check_combined_edge_cases(candle, minutes_remaining=30):
    """Try all edge case strategies, first one to fire wins."""
    strategies = [
        check_volatility_spike,
        check_big_swing_continuation,
        check_rapid_reversal,
        check_time_decay_snipe,
        check_gap_trade,
    ]

    for strategy in strategies:
        signal = strategy(candle, minutes_remaining)
        if signal:
            return signal

    return None


# ============================================================================
# SIMULATION ENGINE
# ============================================================================

def simulate_strategy(candles, strategy_name, strategy_func):
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

        sig_name = signal['signal_name']
        signal_counts[sig_name] = signal_counts.get(sig_name, 0) + 1

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
            'won': won,
            'pnl': pnl,
            'capital': capital,
            'signal_name': sig_name
        })

        if capital <= 0:
            break

    wins = sum(1 for t in trades if t['won'])
    losses = len(trades) - wins

    return capital, len(trades), wins, losses, signal_counts


# ============================================================================
# MONTE CARLO ANALYSIS
# ============================================================================

def run_monte_carlo(num_runs=50):
    print("=" * 80)
    print("EDGE CASE PRICE SNIPING EXPERIMENT")
    print("=" * 80)
    print(f"Testing special-situation strategies vs enhanced aggressive baseline")
    print(f"Monte Carlo Runs: {num_runs} × 365 days each")
    print("=" * 80)
    print()

    results = {
        'baseline_enhanced_aggressive': [],
        'edge_volatility_spike': [],
        'edge_big_swing': [],
        'edge_rapid_reversal': [],
        'edge_time_decay': [],
        'edge_gap_trading': [],
        'edge_combined_all': []
    }

    for run in range(num_runs):
        print(f"Run {run + 1}/{num_runs}...", end=" ", flush=True)

        candles = generate_btc_candles(DAYS, HOURS_PER_DAY)
        calculate_indicators(candles)

        strategies = [
            ('baseline_enhanced_aggressive', check_enhanced_aggressive),
            ('edge_volatility_spike', check_volatility_spike),
            ('edge_big_swing', check_big_swing_continuation),
            ('edge_rapid_reversal', check_rapid_reversal),
            ('edge_time_decay', check_time_decay_snipe),
            ('edge_gap_trading', check_gap_trade),
            ('edge_combined_all', check_combined_edge_cases),
        ]

        run_results = []
        for name, func in strategies:
            final, trades, wins, losses, signals = simulate_strategy(candles, name, func)

            results[name].append({
                'run': run + 1,
                'final_capital': final,
                'return_pct': ((final - STARTING_CAPITAL) / STARTING_CAPITAL) * 100,
                'total_trades': trades,
                'wins': wins,
                'losses': losses,
                'win_rate': (wins / trades * 100) if trades > 0 else 0,
                'ruined': final <= 0,
                'signals': signals
            })

            run_results.append(f"{name.split('_')[-1][:4]}:${final:.0f}")

        print(" | ".join(run_results))

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

        avg_capital = sum(final_capitals) / len(final_capitals)
        avg_return = sum(returns) / len(returns)
        avg_trades = sum(trades) / len(trades)
        avg_win_rate = sum(win_rates) / len(win_rates) if win_rates else 0

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
    print("COMPARISON VS BASELINE")
    print("=" * 80)

    baseline = next(s for s in summaries if 'baseline' in s['name'])
    print(f"\nBASELINE: Enhanced Aggressive")
    print(f"  ${baseline['avg_capital']:.2f}, {baseline['avg_return']:+.1f}%, {baseline['avg_trades']:.0f} trades")

    for strategy in summaries:
        if 'baseline' in strategy['name']:
            continue

        improvement = strategy['avg_capital'] - baseline['avg_capital']
        improvement_pct = (improvement / baseline['avg_capital']) * 100

        symbol = "✅" if improvement > 0 else "❌"
        print(f"\n{symbol} {strategy['name'].replace('_', ' ').upper()}")
        print(f"  ${strategy['avg_capital']:.2f}, {strategy['avg_return']:+.1f}%, {strategy['avg_trades']:.0f} trades")
        print(f"  Improvement: ${improvement:+.2f} ({improvement_pct:+.1f}%)")

    print()
    best = max(summaries, key=lambda x: x['avg_capital'])
    print(f"BEST STRATEGY: {best['name'].replace('_', ' ').upper()}")
    print(f"  ${best['avg_capital']:.2f} avg capital")

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

    output_file = output_dir / 'edge_case_sniping_results.json'
    with open(output_file, 'w') as f:
        json.dump({
            'config': {
                'starting_capital': STARTING_CAPITAL,
                'days': DAYS,
                'monte_carlo_runs': MONTE_CARLO_RUNS,
                'vol_spike_multiplier': VOL_SPIKE_MULTIPLIER,
                'big_swing_threshold': BIG_SWING_THRESHOLD,
                'reversal_threshold': REVERSAL_THRESHOLD,
                'gap_threshold': GAP_THRESHOLD,
                'time_decay_window': TIME_DECAY_WINDOW
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
