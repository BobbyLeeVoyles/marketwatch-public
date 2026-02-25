"""Claude Computer Use Orchestrator for Robinhood prediction markets.

Reads signal.json from the strategy engine and executes trades
via Claude Computer Use on the user's actual screen.
"""

import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import claude_agent

DATA_DIR = Path(__file__).parent.parent / "data"
SIGNAL_FILE = DATA_DIR / "signal.json"
POSITION_FILE = DATA_DIR / "position.json"
EXECUTION_LOG_FILE = DATA_DIR / "execution-log.json"

POLL_INTERVAL = 5  # seconds
ACTIONABLE_COMMANDS = {"BUY", "SELL", "PREP", "SETTLE"}


def read_signal() -> dict | None:
    """Read the current signal from signal.json."""
    try:
        if SIGNAL_FILE.exists():
            return json.loads(SIGNAL_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return None


def log_execution(entry: dict) -> None:
    """Append an execution entry to the log file."""
    log = []
    try:
        if EXECUTION_LOG_FILE.exists():
            log = json.loads(EXECUTION_LOG_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        log = []

    log.append(entry)

    # Keep last 500 entries
    if len(log) > 500:
        log = log[-500:]

    EXECUTION_LOG_FILE.write_text(json.dumps(log, indent=2))


def _read_position() -> dict:
    """Read current position.json."""
    try:
        if POSITION_FILE.exists():
            return json.loads(POSITION_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return {"active": False}


def _write_position(position: dict) -> None:
    """Atomic write to position.json."""
    tmp = POSITION_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(position, indent=2))
    tmp.rename(POSITION_FILE)


def _confirm_fill(final_message: str, signal: dict) -> None:
    """Parse Claude's FILL line and activate the position with real data.

    Expected format in final_message:
        FILL: contracts=65 price=0.28 total=18.47
    """
    # Search all text blocks Claude sent (final_message is the last text block)
    match = re.search(
        r"FILL:\s*contracts=(\d+)\s+price=([\d.]+)\s+total=([\d.]+)",
        final_message,
    )
    if not match:
        print("  [WARN] No FILL line found in Claude's response — position stays pending")
        return

    contracts = int(match.group(1))
    price = float(match.group(2))
    total = float(match.group(3))

    # Read current pending position and upgrade to active
    position = _read_position()
    position.update({
        "active": True,
        "pending": False,
        "entryPrice": price,
        "contracts": contracts,
        "totalCost": total,
        "btcPriceAtEntry": signal.get("btcPrice", 0),
        "entryTime": datetime.now().isoformat(),
    })
    _write_position(position)

    print(f"  [FILL CONFIRMED] {contracts} contracts @ ${price:.2f} = ${total:.2f}")
    print(f"  Position activated — engine will now run exit analysis")


def main(dry_run: bool = False) -> None:
    """Main orchestrator loop."""
    # Check ORCHESTRATOR_ENABLED env var (default: true for backward compat)
    enabled = os.environ.get("ORCHESTRATOR_ENABLED", "true").lower()
    if enabled in ("false", "0", "no", "off"):
        print("=" * 50)
        print("  CLAUDE COMPUTER USE ORCHESTRATOR")
        print("  STATUS: DISABLED (ORCHESTRATOR_ENABLED=false)")
        print("  Set ORCHESTRATOR_ENABLED=true in .env to re-enable")
        print("=" * 50)
        return

    print("=" * 50)
    print("  CLAUDE COMPUTER USE ORCHESTRATOR")
    print("=" * 50)
    print(f"  Mode: {'DRY RUN (no Submit)' if dry_run else 'LIVE'}")
    print(f"  Poll interval: {POLL_INTERVAL}s")
    print(f"  Signal file: {SIGNAL_FILE}")
    print()

    last_executed_timestamp = ""

    while True:
        try:
            signal = read_signal()

            if signal is None:
                time.sleep(POLL_INTERVAL)
                continue

            command = signal.get("command", "STANDBY")
            timestamp = signal.get("timestamp", "")
            instruction = signal.get("instruction", "")

            # Skip if we already executed this signal
            if timestamp == last_executed_timestamp:
                time.sleep(POLL_INTERVAL)
                continue

            # Only act on actionable commands
            if command not in ACTIONABLE_COMMANDS:
                status = f"[{command}] {signal.get('reason', '')}"
                print(f"\r{datetime.now().strftime('%H:%M:%S')} {status[:80]}", end="", flush=True)
                last_executed_timestamp = timestamp
                time.sleep(POLL_INTERVAL)
                continue

            # === EXECUTE ===
            print(f"\n{'=' * 50}")
            print(f"[{datetime.now().strftime('%H:%M:%S')}] EXECUTING: {command}")
            print(f"  Instruction: {instruction}")
            print(f"  Reason: {signal.get('reason', 'N/A')}")

            result = claude_agent.execute(instruction, dry_run=dry_run)

            log_entry = {
                "timestamp": datetime.now().isoformat(),
                "command": command,
                "signal_timestamp": timestamp,
                "instruction": instruction,
                "reason": signal.get("reason", ""),
                "dry_run": dry_run,
                "success": result.success,
                "actions_taken": result.actions_taken,
                "final_message": result.final_message,
                "error": result.error,
                "screenshots_taken": result.screenshots_taken,
            }
            log_execution(log_entry)

            status = "SUCCESS" if result.success else "FAILED"
            print(f"  Result: {status}")
            print(f"  Actions: {len(result.actions_taken)}")
            if result.final_message:
                print(f"  Message: {result.final_message[:200]}")
            if result.error:
                print(f"  Error: {result.error}")

            # After successful BUY: parse fill data and activate position
            if command == "BUY" and result.success and not dry_run:
                _confirm_fill(result.final_message, signal)

            print(f"{'=' * 50}")

            last_executed_timestamp = timestamp
            time.sleep(POLL_INTERVAL)

        except KeyboardInterrupt:
            print("\n\n[ORCHESTRATOR] Shutting down...")
            break
        except Exception as e:
            print(f"\n[ERROR] {e}")
            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    is_dry_run = "--dry-run" in sys.argv
    main(dry_run=is_dry_run)
