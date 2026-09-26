"""python3 -m substrate_miner bridge --once | monitor

bridge --once   one tick of the Hermes pending-skill bridge, then the Omp and Grok queue drains;
                prints one summary line; exits 1 when the propose key is unreadable or refused (401)
monitor         the substrate-skill-miner cron precheck (stable output; no timestamps)
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone


def _bridge() -> int:
    from . import bridge

    with bridge.ProposeClient() as client:
        tick = bridge.run_once(client)
        omp = bridge.drain_queue(bridge.OMP_QUEUE, "omp", client)
        grok = bridge.drain_queue(bridge.GROK_QUEUE, "grok-build", client)
    ok = tick.ok and omp.ok and grok.ok
    print(
        f"[skills-bridge] proposed={tick.proposed} rejected={tick.rejected} held={tick.held} "
        f"kept={tick.kept} waiting={tick.waiting} "
        f"queue_proposed={omp.proposed + grok.proposed} queue_rejected={omp.rejected + grok.rejected} "
        f"queue_kept={omp.kept + grok.kept} key={'ok' if ok else 'unreadable-or-refused'}",
        flush=True,
    )
    return 0 if ok else 1


def _monitor() -> int:
    from .monitor import TRANSCRIPTS, monitor_output

    sys.stdout.write(monitor_output(TRANSCRIPTS, datetime.now(timezone.utc).strftime("%Y-%m-%d")))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m substrate_miner")
    sub = parser.add_subparsers(dest="command", required=True)
    bridge_parser = sub.add_parser("bridge", help="one bridge tick")
    bridge_parser.add_argument("--once", action="store_true", required=True, help="run one tick and exit")
    sub.add_parser("monitor", help="the substrate-skill-miner cron precheck")
    args = parser.parse_args(argv)
    return _bridge() if args.command == "bridge" else _monitor()


if __name__ == "__main__":
    sys.exit(main())
