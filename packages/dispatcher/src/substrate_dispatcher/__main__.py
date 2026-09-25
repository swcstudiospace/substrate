"""``python3 -m substrate_dispatcher --once --dry-run``: one read-only tick against live Linear.

The supervised loop and real-mode launches under the D-14 claim watch arrive with 02-07; until
then the only supported invocation is the pair ``--once --dry-run``.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .dispatch import SessionRegistry, make_launch_fn, tick
from .linear import LinearClient
from .mcp import McpClient

DEFAULT_ENV_FILE = "/etc/substrate/substrate.env"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="substrate_dispatcher")
    parser.add_argument("--once", action="store_true", help="run exactly one tick")
    parser.add_argument("--dry-run", action="store_true", help="log decisions, write nothing")
    args = parser.parse_args(argv)
    if not (args.once and args.dry_run):
        parser.error("only --once --dry-run is supported")

    try:
        linear = LinearClient.from_env()
    except RuntimeError as exc:
        print(f"substrate_dispatcher: {exc}", file=sys.stderr)
        return 2
    mcp = McpClient.from_env()
    say = lambda line: print(line, flush=True)  # noqa: E731
    try:
        tick(
            linear=linear,
            mcp=mcp,
            registry=SessionRegistry(),
            launch_fn=make_launch_fn(log=say),
            env_file=Path(os.environ.get("SUBSTRATE_ENV_FILE") or DEFAULT_ENV_FILE),
            environ=os.environ,
            dry_run=True,
            log=say,
        )
    finally:
        mcp.close()
        linear.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
