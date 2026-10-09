"""python3 -m substrate_miner bridge --once [--dry-run] | monitor

bridge --once   one tick of the Hermes pending-skill bridge, then the Omp and Grok queue drains;
                prints one summary line; exits 1 when a single-token variable is set, a surface
                token is unreadable or refused (401/403)
bridge --once --dry-run
                classify and build every proposal, post it with dry_run true, print one line per
                group or file, and never delete, move or hold anything
monitor         the substrate-skill-miner cron precheck (stable output; no timestamps)
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from typing import Mapping


def _refusal() -> str | None:
    from . import token as token_module

    return token_module.single_token_refusal(os.environ)


def _bridge(*, dry_run: bool) -> int:
    from . import bridge

    refused = _refusal()
    if refused is not None:
        print(f"[skills-bridge] refused: {refused} is set; unset it and use the per-surface token files",
              file=sys.stderr, flush=True)
        return 1
    tokens = bridge.resolve_surface_tokens(bridge.QUEUE_SURFACES, os.environ)
    with bridge.ProposeClient(tokens=tokens) as client:
        tick = bridge.run_once(client, dry_run=dry_run)
        omp = bridge.drain_queue(bridge.OMP_QUEUE, "omp", client, dry_run=dry_run)
        grok = bridge.drain_queue(bridge.GROK_QUEUE, "grok-build", client, dry_run=dry_run)
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
    bridge_parser.add_argument("--dry-run", action="store_true",
                               help="post with dry_run true; delete, move or hold nothing")
    sub.add_parser("monitor", help="the substrate-skill-miner cron precheck")
    args = parser.parse_args(argv)
    if args.command == "bridge":
        return _bridge(dry_run=args.dry_run)
    return _monitor()


if __name__ == "__main__":
    sys.exit(main())
