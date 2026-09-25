"""Supervised loop, single-instance lock and CLI contract (D-10, D-12, D-13, D-15)."""

from __future__ import annotations

import fcntl
import io
import os
import signal
from pathlib import Path

import pytest

import substrate_dispatcher.__main__ as cli
from substrate_dispatcher.dispatch import make_launch_fn
from substrate_dispatcher.sessions import SessionRegistry
from substrate_dispatcher.worktree import WorktreeRefused
from test_dispatch import (  # noqa: F401 — env_file is a fixture
    GID, FakeLinear, FakeMcp, cand, env_file, launched,
)


class Recorder:
    def __init__(self):
        self.events: list[tuple] = []


class RecordingRegistry(SessionRegistry):
    def __init__(self, rec: Recorder):
        super().__init__()
        self.rec = rec

    def reap(self, now, *, mcp, linear, log):
        self.rec.events.append(("reap", now))


def recording_tick(rec: Recorder, raises_on: set[int] | None = None):
    def fake_tick(**kwargs):
        rec.events.append(("tick",))
        if raises_on and sum(e == ("tick",) for e in rec.events) in raises_on:
            raise RuntimeError("linear down")
        return []

    return fake_tick


def loop(monkeypatch, env_file, rec, *, iterations, raises_on=None, lines=None, sleep=None):
    monkeypatch.setattr(cli, "tick", recording_tick(rec, raises_on))
    lines = lines if lines is not None else []
    ran = cli.run_loop(
        linear=FakeLinear(), mcp=FakeMcp(), registry=RecordingRegistry(rec), launch_fn=lambda *_: None,
        env_file=env_file, environ={},
        sleep=sleep or (lambda s: rec.events.append(("sleep", s))),
        clock=lambda: 1000.0, iterations=iterations, log=lines.append,
    )
    return ran, lines


def test_loop_reaps_then_ticks_and_sleeps_30_s_between_iterations(monkeypatch, env_file):
    rec = Recorder()
    ran, _ = loop(monkeypatch, env_file, rec, iterations=2)
    assert cli.POLL_INTERVAL_SECONDS == 30
    assert ran == 2
    assert rec.events == [("reap", 1000.0), ("tick",), ("sleep", 30), ("reap", 1000.0), ("tick",)]


def test_a_failing_tick_is_logged_and_the_next_iteration_runs(monkeypatch, env_file):
    rec = Recorder()
    ran, lines = loop(monkeypatch, env_file, rec, iterations=2, raises_on={1})
    assert ran == 2 and rec.events.count(("tick",)) == 2
    assert "tick failed: RuntimeError: linear down" in lines


def test_sigterm_stops_the_loop_after_the_current_iteration(monkeypatch, env_file):
    rec = Recorder()
    before = signal.getsignal(signal.SIGTERM)

    def tick_then_sigterm(**kwargs):
        rec.events.append(("tick",))
        os.kill(os.getpid(), signal.SIGTERM)
        rec.events.append(("tick-finished",))
        return []

    monkeypatch.setattr(cli, "tick", tick_then_sigterm)
    lines: list[str] = []
    ran = cli.run_loop(
        linear=FakeLinear(), mcp=FakeMcp(), registry=RecordingRegistry(rec), launch_fn=lambda *_: None,
        env_file=env_file, environ={}, sleep=lambda s: rec.events.append(("sleep", s)),
        iterations=None, log=lines.append,
    )
    assert ran == 1
    assert rec.events[0][0] == "reap"
    assert rec.events[1:] == [("tick",), ("tick-finished",)]  # finished the iteration, no sleep
    assert signal.getsignal(signal.SIGTERM) is before
    assert "stop signal received; exiting after 1 iteration(s)" in lines


def test_launch_through_the_loop_uses_make_launch_fn_and_registers_the_session(env_file):
    order: list[str] = []

    def ensure(repo, graph_id, branch):
        order.append("ensure")
        return Path(f"/var/lib/substrate/worktrees/{graph_id}")

    def launch(**kwargs):
        order.append("launch")
        return launched(77)

    stream = io.StringIO()
    log = cli.make_log(stream)
    launch_fn = make_launch_fn(
        log=log, checkout=lambda slug: order.append("checkout") or Path("/r"), ensure=ensure, launch=launch
    )
    registry = SessionRegistry()
    cli.run_loop(
        linear=FakeLinear([cand()]), mcp=FakeMcp(), registry=registry, launch_fn=launch_fn,
        env_file=env_file, environ={}, sleep=lambda s: None, iterations=1, log=log,
    )
    assert order == ["checkout", "ensure", "launch"]
    got = registry.get("i-1")
    assert got is not None and got.dispatch_label_id == "l-hermes" and got.pid == 77
    launch_lines = [l for l in stream.getvalue().splitlines() if "launched hermes for" in l]
    assert len(launch_lines) == 1
    assert launch_lines[0].startswith(
        f"[substrate-dispatcher] launched hermes for SWC-1 graph {GID} node n1 pid 77"
    )


def test_worktree_refused_through_the_loop_comments_once(env_file):
    def ensure(*_a):
        raise WorktreeRefused("only 1.0 GB free on /", "low-disk")

    launch_fn = make_launch_fn(log=lambda _l: None, checkout=lambda _s: Path("/r"), ensure=ensure)
    linear, registry = FakeLinear([cand()]), SessionRegistry()
    cli.run_loop(
        linear=linear, mcp=FakeMcp(), registry=registry, launch_fn=launch_fn,
        env_file=env_file, environ={}, sleep=lambda s: None, iterations=2, log=lambda _l: None,
    )
    posted = linear.named("comment")
    assert len(posted) == 1 and "[low-disk]" in posted[0][2]
    assert registry.active_issue_ids() == set()


@pytest.fixture
def lock_path(tmp_path, monkeypatch) -> Path:
    path = tmp_path / "dispatcher" / "dispatcher.lock"
    monkeypatch.setattr(cli, "LOCK_PATH", path)
    return path


@pytest.fixture
def client_calls(monkeypatch) -> list[str]:
    calls: list[str] = []

    def linear_from_env():
        calls.append("linear")
        return FakeLinear()

    def mcp_from_env():
        calls.append("mcp")
        return FakeMcp()

    monkeypatch.setattr(FakeLinear, "close", lambda self: None, raising=False)
    monkeypatch.setattr(FakeMcp, "close", lambda self: None, raising=False)
    monkeypatch.setattr(cli.LinearClient, "from_env", staticmethod(linear_from_env))
    monkeypatch.setattr(cli.McpClient, "from_env", staticmethod(mcp_from_env))
    return calls


def hold(path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fd


def test_held_lock_exits_3_without_any_client(lock_path, client_calls, capsys):
    fd = hold(lock_path)
    try:
        assert cli.main([]) == 3
    finally:
        os.close(fd)
    assert client_calls == []
    assert f"another substrate-dispatcher holds {lock_path}" in capsys.readouterr().err


def test_dry_run_takes_no_lock(lock_path, client_calls, monkeypatch, env_file):
    monkeypatch.setenv("SUBSTRATE_ENV_FILE", str(env_file))
    fd = hold(lock_path)
    try:
        assert cli.main(["--once", "--dry-run"]) == 0
    finally:
        os.close(fd)
    assert client_calls == ["linear", "mcp"]


def test_once_without_dry_run_exits_2_before_lock_or_any_client(lock_path, client_calls, capsys):
    with pytest.raises(SystemExit) as exited:
        cli.main(["--once"])
    assert exited.value.code == 2
    assert client_calls == []
    assert not lock_path.exists()
    assert "--once requires --dry-run" in capsys.readouterr().err


def test_real_mode_takes_the_lock_and_releases_it(lock_path, client_calls, monkeypatch, env_file):
    monkeypatch.setenv("SUBSTRATE_ENV_FILE", str(env_file))
    runs: list[dict] = []
    monkeypatch.setattr(cli, "run_loop", lambda **kwargs: runs.append(kwargs) or 0)
    assert cli.main([]) == 0
    assert [(r["iterations"], r["dry_run"]) for r in runs] == [(None, False)]
    assert oct(lock_path.parent.stat().st_mode & 0o777) == "0o700"
    os.close(hold(lock_path))  # released: a new holder gets it


def test_missing_linear_key_exits_2_and_prints_no_environment(lock_path, monkeypatch, capsys):
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
    monkeypatch.setenv("SUBSTRATE_CANARY_SECRET", "canary-7f3a")
    assert cli.main([]) == 2
    out = capsys.readouterr()
    assert "LINEAR_API_KEY not set" in out.err
    assert "canary-7f3a" not in out.out + out.err

