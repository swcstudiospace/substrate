"""``python3 -m substrate_dispatcher``: the supervised dispatch loop (D-10, D-14, D-15).

Default mode runs reap → tick every POLL_INTERVAL_SECONDS until SIGTERM/SIGINT. ``--once --dry-run``
runs one reap and one tick. ``--dry-run`` logs decisions and writes nothing. ``--once`` alone is
refused: a real launch must stay under the loop's D-14 watch (claim timeout, SIGTERM→SIGKILL,
registry). The real (non-dry) mode holds an exclusive flock on LOCK_PATH, so only one dispatcher
can launch sessions; a second one
exits 3 without polling. Launches go through dispatch.make_launch_fn (D-12 worktree, then D-13
hermes chat for dispatch:hermes or a substrate-host VM task for dispatch:claude-code, D-06). Every
line goes to stderr with the ``[substrate-dispatcher]`` prefix (journal).
"""

from __future__ import annotations

import argparse
import fcntl
import os
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Mapping, TextIO

from .dispatch import LaunchFn, Log, make_launch_fn, tick
from .host import HostClient
from .launcher import STATE_DIR
from .linear import LinearClient
from .mcp import McpClient
from .sessions import SessionRegistry

POLL_INTERVAL_SECONDS = 30  # D-10
LOCK_PATH = STATE_DIR / "dispatcher.lock"
LOG_PREFIX = "[substrate-dispatcher]"
DEFAULT_ENV_FILE = "/etc/substrate/substrate.env"


def make_log(stream: TextIO | None = None) -> Log:
    def log(line: str) -> None:
        print(f"{LOG_PREFIX} {line}", file=stream or sys.stderr, flush=True)

    return log


def acquire_lock(path: Path) -> int | None:
    """An fd holding an exclusive flock on path, or None when another process holds it."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return None
    return fd


def run_loop(
    *,
    linear: Any,
    mcp: Any,
    registry: SessionRegistry,
    launch_fn: LaunchFn,
    env_file: Path,
    environ: Mapping[str, str],
    sleep: Callable[[float], Any] | None = None,
    clock: Callable[[], float] = time.time,
    iterations: int | None = None,
    dry_run: bool = False,
    log: Log,
) -> int:
    """reap → tick → sleep until ``iterations`` ran or SIGTERM/SIGINT; returns iterations run.

    A signal sets the stop flag: the current iteration finishes and the loop returns. The
    default sleep waits on that flag, so a stop never waits out the poll interval.
    """
    stop = threading.Event()
    sleep = sleep or stop.wait
    previous: dict[int, Any] = {}
    if threading.current_thread() is threading.main_thread():
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous[signum] = signal.signal(signum, lambda *_: stop.set())
    ran = 0
    try:
        while not stop.is_set():
            try:
                registry.reap(clock(), mcp=mcp, linear=linear, log=log)
            except Exception as exc:  # noqa: BLE001 — the loop outlives any one failure
                log(f"reap failed: {type(exc).__name__}: {exc}")
            try:
                tick(
                    linear=linear, mcp=mcp, registry=registry, launch_fn=launch_fn,
                    env_file=env_file, environ=environ, dry_run=dry_run, log=log,
                )
            except Exception as exc:  # noqa: BLE001
                log(f"tick failed: {type(exc).__name__}: {exc}")
            ran += 1
            if (iterations is not None and ran >= iterations) or stop.is_set():
                break
            sleep(POLL_INTERVAL_SECONDS)
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
    if stop.is_set():
        log(f"stop signal received; exiting after {ran} iteration(s)")
    return ran


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="substrate_dispatcher",
        description="Supervised dispatch loop: Linear dispatch:<surface> → Hermes session.",
    )
    parser.add_argument(
        "--once", action="store_true", help="with --dry-run: run one reap and one tick, then exit"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="log decisions, write nothing (takes no lock)"
    )
    args = parser.parse_args(argv)
    if args.once and not args.dry_run:
        # A real launch outlives one tick; only the loop enforces the D-14 claim timeout and kill.
        parser.error("--once requires --dry-run; real dispatch runs only as the supervised loop")
    log = make_log()

    lock_fd: int | None = None
    if not args.dry_run:
        lock_fd = acquire_lock(LOCK_PATH)
        if lock_fd is None:
            print(f"another substrate-dispatcher holds {LOCK_PATH}", file=sys.stderr)
            return 3
    try:
        try:
            linear = LinearClient.from_env()
        except RuntimeError as exc:
            print(f"substrate_dispatcher: {exc}", file=sys.stderr)
            return 2
        mcp = McpClient.from_env()
        host = HostClient.from_env()
        try:
            run_loop(
                linear=linear,
                mcp=mcp,
                registry=SessionRegistry(),
                launch_fn=make_launch_fn(log=log, open_task=host.launch),
                env_file=Path(os.environ.get("SUBSTRATE_ENV_FILE") or DEFAULT_ENV_FILE),
                environ=os.environ,
                iterations=1 if args.once else None,
                dry_run=args.dry_run,
                log=log,
            )
        finally:
            host.close()
            mcp.close()
            linear.close()
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
