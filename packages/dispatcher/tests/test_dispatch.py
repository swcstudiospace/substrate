"""Dispatcher tick: launch path, decision table, once-only comments and the D-15 switch."""

from __future__ import annotations

from pathlib import Path

import pytest

from substrate_dispatcher.dispatch import (
    Decision,
    SessionRegistry,
    dispatch_disabled,
    make_launch_fn,
    tick,
)
from substrate_dispatcher.launcher import Launched
from substrate_dispatcher.linear import Candidate
from substrate_dispatcher.worktree import WorktreeRefused

GID = "ut-mugzzzzz-0123abcd"
FOUND = {
    "found": True,
    "graph_id": GID,
    "node_id": "n1",
    "repo": "swcstudiospace/agent-substrate",
    "branch": "main",
    "graph_status": "Implementing",
    "node": {"node_id": "n1", "state": "unstarted", "claimed_by": None},
}


def cand(issue_id: str = "i-1", identifier: str = "SWC-1", surface: str = "hermes") -> Candidate:
    return Candidate(
        issue_id=issue_id, identifier=identifier, team_id="t", team_key="SWC",
        surface=surface, dispatch_label_id=f"l-{surface}", dispatch_label=f"dispatch:{surface}",
    )


def launched(pid: int = 4242) -> Launched:
    return Launched(
        pid=pid, proc=None, prompt_path=Path("/s/p.md"), log_path=Path("/s/l.log"), started_at=0.0
    )


class FakeLinear:
    def __init__(self, candidates: list[Candidate], comments: dict[str, list[str]] | None = None):
        self.candidates = candidates
        self.comments = comments or {}
        self.calls: list[tuple] = []

    def dispatch_candidates(self) -> list[Candidate]:
        self.calls.append(("dispatch_candidates",))
        return list(self.candidates)

    def comment_bodies(self, issue_id: str) -> list[str]:
        self.calls.append(("comment_bodies", issue_id))
        return list(self.comments.get(issue_id, []))

    def comment(self, issue_id: str, body: str) -> None:
        self.calls.append(("comment", issue_id, body))
        self.comments.setdefault(issue_id, []).append(body)

    def remove_label(self, issue_id: str, label_id: str) -> None:
        self.calls.append(("remove_label", issue_id, label_id))

    def named(self, name: str) -> list[tuple]:
        return [c for c in self.calls if c[0] == name]


class FakeMcp:
    def __init__(self, answers: dict[str, dict | Exception] | None = None, default: dict = FOUND):
        self.answers = answers or {}
        self.default = default
        self.calls: list[str] = []

    def graph_find(self, *, linear_issue_id: str) -> dict:
        self.calls.append(linear_issue_id)
        answer = self.answers.get(linear_issue_id, self.default)
        if isinstance(answer, Exception):
            raise answer
        return answer


class RecordingLaunch:
    def __init__(self, raises: Exception | None = None):
        self.raises = raises
        self.calls: list[tuple[Candidate, dict]] = []

    def __call__(self, candidate: Candidate, found: dict) -> Launched:
        self.calls.append((candidate, found))
        if self.raises:
            raise self.raises
        return launched(1000 + len(self.calls))


@pytest.fixture
def env_file(tmp_path: Path) -> Path:
    path = tmp_path / "substrate.env"
    path.write_text("LINEAR_API_KEY=secret\n")
    return path


def run_tick(linear, mcp, *, env_file, registry=None, launch_fn=None, environ=None, dry_run=False):
    lines: list[str] = []
    registry = registry if registry is not None else SessionRegistry()
    launch_fn = launch_fn if launch_fn is not None else RecordingLaunch()
    decisions = tick(
        linear=linear, mcp=mcp, registry=registry, launch_fn=launch_fn, env_file=env_file,
        environ=environ or {}, dry_run=dry_run, log=lines.append,
    )
    return decisions, lines, registry, launch_fn


# --- Task 1: launch path, D-15, registry ---------------------------------------------------


def test_valid_unclaimed_hermes_candidate_launches_once(env_file):
    linear, mcp = FakeLinear([cand()]), FakeMcp()
    decisions, lines, registry, launch_fn = run_tick(linear, mcp, env_file=env_file)
    assert mcp.calls == ["i-1"]
    assert len(launch_fn.calls) == 1 and launch_fn.calls[0][1] == FOUND
    assert registry.active_issue_ids() == {"i-1"}
    assert [d.action for d in decisions] == ["launch"]
    assert lines[0] == "tick: 1 candidate issue(s)"


def test_disabled_env_file_makes_no_client_call(env_file):
    env_file.write_text("LINEAR_API_KEY=secret\nSUBSTRATE_DISPATCH_DISABLED=1\n")
    linear, mcp = FakeLinear([cand()]), FakeMcp()
    decisions, lines, _, launch_fn = run_tick(linear, mcp, env_file=env_file)
    assert decisions == []
    assert linear.calls == [] and mcp.calls == [] and launch_fn.calls == []
    assert lines == ["dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)"]
    assert "secret" not in "".join(lines)


def test_env_file_value_wins_over_process_env(env_file):
    env_file.write_text("SUBSTRATE_DISPATCH_DISABLED=0\n")
    assert dispatch_disabled(env_file, {"SUBSTRATE_DISPATCH_DISABLED": "1"}) is False


def test_process_env_decides_when_file_lacks_key(env_file):
    assert dispatch_disabled(env_file, {"SUBSTRATE_DISPATCH_DISABLED": "1"}) is True
    assert dispatch_disabled(env_file, {"SUBSTRATE_DISPATCH_DISABLED": "0"}) is False
    assert dispatch_disabled(env_file, {}) is False


def test_unreadable_env_file_falls_back_to_process_env(tmp_path):
    missing = tmp_path / "absent.env"
    assert dispatch_disabled(missing, {"SUBSTRATE_DISPATCH_DISABLED": "1"}) is True


@pytest.mark.parametrize(
    "lines, disabled",
    [
        (["SUBSTRATE_DISPATCH_DISABLED=1", "SUBSTRATE_DISPATCH_DISABLED=0"], False),
        (["SUBSTRATE_DISPATCH_DISABLED=0", "SUBSTRATE_DISPATCH_DISABLED=1"], True),
    ],
)
def test_last_line_wins(env_file, lines, disabled):
    env_file.write_text("LINEAR_API_KEY=secret\n" + "\n".join(lines) + "\n")
    assert dispatch_disabled(env_file, {}) is disabled


def test_make_launch_fn_composes_checkout_ensure_launch_in_order():
    order: list[tuple] = []
    repo_path, wt = Path("/root/src/repos/agent-substrate"), Path(f"/var/lib/substrate/worktrees/{GID}")

    def checkout(slug):
        order.append(("checkout", slug))
        return repo_path

    def ensure(repo, graph_id, branch):
        order.append(("ensure", repo, graph_id, branch))
        return wt

    def launch(**kwargs):
        order.append(("launch", kwargs))
        return launched(77)

    lines: list[str] = []
    fn = make_launch_fn(log=lines.append, checkout=checkout, ensure=ensure, launch=launch)
    result = fn(cand(identifier="SWC-9"), FOUND)
    assert result.pid == 77
    assert order == [
        ("checkout", "swcstudiospace/agent-substrate"),
        ("ensure", repo_path, GID, "main"),
        ("launch", dict(identifier="SWC-9", graph_id=GID, node_id="n1",
                        repo="swcstudiospace/agent-substrate", worktree=wt)),
    ]
    assert len(lines) == 1
    assert lines[0].startswith(
        f"launched hermes for SWC-9 graph {GID} node n1 pid 77 worktree {wt} log /s/l.log"
    )


def test_make_launch_fn_propagates_worktree_refused():
    def ensure(*_a):
        raise WorktreeRefused("only 1.0 GB free", "low-disk")

    def launch(**_k):  # pragma: no cover - must not be reached
        raise AssertionError("launch after a refused worktree")

    fn = make_launch_fn(log=lambda _l: None, checkout=lambda _s: Path("/r"), ensure=ensure, launch=launch)
    with pytest.raises(WorktreeRefused) as err:
        fn(cand(), FOUND)
    assert err.value.marker == "low-disk"


def test_graph_find_error_is_logged_and_next_candidate_still_processed(env_file):
    linear = FakeLinear([cand("i-bad", "SWC-1"), cand("i-good", "SWC-2")])
    mcp = FakeMcp({"i-bad": RuntimeError("mcp down")})
    decisions, lines, registry, launch_fn = run_tick(linear, mcp, env_file=env_file)
    assert mcp.calls == ["i-bad", "i-good"]
    assert any(l.startswith("SWC-1: RuntimeError: mcp down") for l in lines)
    assert [c.issue_id for c, _ in launch_fn.calls] == ["i-good"]
    assert [d.candidate.issue_id for d in decisions] == ["i-good"]
    assert registry.active_issue_ids() == {"i-good"}


def test_registry_cap_and_one_per_issue():
    registry = SessionRegistry(max_sessions=2)
    registry.add("a", launched())
    with pytest.raises(ValueError):
        registry.add("a", launched())
    registry.add("b", launched())
    assert registry.capacity_left() == 0
    with pytest.raises(ValueError):
        registry.add("c", launched())
    assert registry.active_issue_ids() == {"a", "b"}


def test_dry_run_never_launches(env_file):
    linear, mcp = FakeLinear([cand()]), FakeMcp()
    decisions, _, registry, launch_fn = run_tick(linear, mcp, env_file=env_file, dry_run=True)
    assert launch_fn.calls == []
    assert registry.active_issue_ids() == set()
    assert isinstance(decisions[0], Decision) and decisions[0].action == "launch"
