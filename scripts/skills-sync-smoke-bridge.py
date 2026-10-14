#!/usr/bin/env python3
"""Bridge driver for the skills-sync rehearsal smoke (Phase 22, SKILL-07).

Runs one bridge tick or one queue drain against a rehearsal twin, with every
path explicit on the command line: no production pending dir, library, log or
held-state path is reachable from here. The bearer comes from SUBSTRATE_TOKEN
in the environment (the smoke sets it from the twin's fixture tokens dir);
prints one JSON line and exits 0 on ok, 1 otherwise.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "packages" / "miner" / "src"))

from substrate_miner import bridge


def _opts(argv: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for arg in argv:
        if arg.startswith("--") and "=" in arg:
            key, _, value = arg[2:].partition("=")
            out[key] = value
    return out


def _summary(result: bridge.RunResult) -> dict[str, object]:
    return {
        "ok": result.ok,
        "proposed": result.proposed,
        "rejected": result.rejected,
        "held": result.held,
        "kept": result.kept,
        "waiting": result.waiting,
    }


def main(argv: list[str]) -> int:
    command, rest = argv[0], argv[1:]
    opts = _opts(rest)
    url = opts["url"]
    with bridge.ProposeClient(url, surface=opts.get("surface", "hermes")) as client:
        if command == "run-once":
            result = bridge.run_once(
                client,
                pending_dir=opts["pending-dir"],
                library=opts["library"],
                hermes_skills=opts["hermes-skills"],
                log_path=opts["log"],
                held_path=opts["held"],
                now=float(opts["now"]),
            )
        elif command == "drain":
            result = bridge.drain_queue(
                opts["dir"], opts["surface"], client, log_path=opts["log"]
            )
        else:
            raise SystemExit(f"unknown command {command}")
    print(json.dumps(_summary(result)), flush=True)
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
