"""Dispatcher tick: launch path, decision table, once-only comments and the D-15 switch."""

from __future__ import annotations

from pathlib import Path

import pytest

from substrate_dispatcher.dispatch import (
    COMMENT_PREFIX,
    DISPATCHABLE_SURFACES,
    MARKERS,
    Decision,
    InvalidIds,
    decide,
    dispatch_disabled,
    make_launch_fn,
    tick,
)
from substrate_dispatcher.host import HostRefused
from substrate_dispatcher.launcher import Launched
from substrate_dispatcher.linear import Candidate
from substrate_dispatcher.sessions import Session, SessionRegistry
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


class FakeProc:
    """Popen stand-in: poll() returns ``code``; terminate() and kill() are recorded."""

    def __init__(self, pid: int = 4242, code: int | None = None):
        self.pid = pid
        self.code = code
        self.signals: list[str] = []

    def poll(self) -> int | None:
        return self.code

    def terminate(self) -> None:
        self.signals.append("terminate")

    def kill(self) -> None:
        self.signals.append("kill")


def launched(pid: int = 4242) -> Launched:
    return Launched(
        pid=pid, proc=FakeProc(pid), prompt_path=Path("/s/p.md"), log_path=Path("/s/l.log"),
        started_at=0.0,
    )


def session(issue_id: str = "i-1", **fields) -> Session:
    values = dict(
        issue_id=issue_id, identifier=f"SWC-{issue_id}", graph_id=GID, node_id="n1",
        surface="hermes", dispatch_label_id="l-hermes", proc=FakeProc(), pid=4242,
        started_at=0.0, log_path=Path("/s/l.log"), launch_state="unstarted",
    )
    values.update(fields)
    return Session(**values)


class FakeLinear:
    """Records every call; ``fail`` maps a method name to the exception it raises."""

    def __init__(
        self,
        candidates: list[Candidate] | None = None,
        comments: dict[str, list[str]] | None = None,
        fail: dict[str, Exception] | None = None,
    ):
        self.candidates = candidates or []
        self.comments = comments or {}
        self.fail = fail or {}
        self.calls: list[tuple] = []

    def _maybe_fail(self, name: str) -> None:
        if name in self.fail:
            raise self.fail[name]

    def dispatch_candidates(self) -> list[Candidate]:
        self.calls.append(("dispatch_candidates",))
        return list(self.candidates)

    def comment_bodies(self, issue_id: str) -> list[str]:
        self.calls.append(("comment_bodies", issue_id))
        self._maybe_fail("comment_bodies")
        return list(self.comments.get(issue_id, []))

    def comment(self, issue_id: str, body: str) -> None:
        self.calls.append(("comment", issue_id, body))
        self._maybe_fail("comment")
        self.comments.setdefault(issue_id, []).append(body)

    def remove_label(self, issue_id: str, label_id: str) -> None:
        self.calls.append(("remove_label", issue_id, label_id))
        self._maybe_fail("remove_label")

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


def test_make_launch_fn_routes_claude_code_to_open_task_after_the_worktree():
    order: list[tuple] = []
    repo_path, wt = Path("/root/src/repos/agent-substrate"), Path(f"/var/lib/substrate/worktrees/{GID}")

    def checkout(slug):
        order.append(("checkout", slug))
        return repo_path

    def ensure(repo, graph_id, branch):
        order.append(("ensure", repo, graph_id, branch))
        return wt

    def launch(**_k):  # pragma: no cover - must not be reached
        raise AssertionError("hermes launch for a claude-code candidate")

    def open_task(**kwargs):
        order.append(("open_task", kwargs))
        return Launched(pid=0, proc=FakeProc(0), prompt_path=Path("/t.json"), log_path=Path("/t.json"), started_at=0.0)

    lines: list[str] = []
    fn = make_launch_fn(log=lines.append, checkout=checkout, ensure=ensure, launch=launch, open_task=open_task)
    result = fn(cand(identifier="SWC-9", surface="claude-code"), FOUND)
    assert result.pid == 0
    assert order == [
        ("checkout", "swcstudiospace/agent-substrate"),
        ("ensure", repo_path, GID, "main"),
        ("open_task", dict(identifier="SWC-9", graph_id=GID, node_id="n1",
                           repo="swcstudiospace/agent-substrate", worktree=wt)),
    ]
    assert lines == [f"launched claude-code for SWC-9 graph {GID} node n1 task {GID}/n1 worktree {wt}"]


def test_make_launch_fn_hermes_candidate_never_calls_open_task():
    def open_task(**_k):  # pragma: no cover - must not be reached
        raise AssertionError("open_task for a hermes candidate")

    called: list[str] = []
    fn = make_launch_fn(
        log=lambda _l: None, checkout=lambda _s: Path("/r"), ensure=lambda *_a: Path("/w"),
        launch=lambda **_k: called.append("launch") or launched(5), open_task=open_task,
    )
    assert fn(cand(surface="hermes"), FOUND).pid == 5 and called == ["launch"]


def test_make_launch_fn_without_a_host_client_refuses_claude_code_as_unreachable():
    fn = make_launch_fn(log=lambda _l: None, checkout=lambda _s: Path("/r"), ensure=lambda *_a: Path("/w"))
    with pytest.raises(HostRefused) as err:
        fn(cand(surface="claude-code"), FOUND)
    assert err.value.marker == "host-unreachable"


def test_claude_code_is_dispatchable_and_launches_with_capacity(env_file):
    assert DISPATCHABLE_SURFACES == frozenset({"hermes", "claude-code"})
    linear, mcp = FakeLinear([cand(surface="claude-code")]), FakeMcp()
    decisions, _, registry, launch_fn = run_tick(linear, mcp, env_file=env_file)
    assert [d.action for d in decisions] == ["launch"]
    assert launch_fn.calls[0][0].surface == "claude-code"
    got = registry.get("i-1")
    assert got is not None and got.surface == "claude-code" and got.dispatch_label_id == "l-claude-code"
    assert linear.named("comment") == []


def test_host_refused_becomes_one_once_only_comment_without_a_session_or_give_up(env_file):
    linear, mcp = FakeLinear([cand(surface="claude-code")]), FakeMcp()
    refusing = RecordingLaunch(raises=HostRefused("HTTP 409: node n1 already claimed by hermes", "host-refused"))
    _, lines, registry, _ = run_tick(linear, mcp, env_file=env_file, launch_fn=refusing)
    decisions, _, _, _ = run_tick(linear, mcp, env_file=env_file, registry=registry, launch_fn=refusing)
    posted = linear.named("comment")
    assert len(posted) == 1 and posted[0][2] == f"{COMMENT_PREFIX} [host-refused] {MARKERS['host-refused']}"
    assert "already claimed" not in posted[0][2]  # the host's text stays in the journal
    assert registry.active_issue_ids() == set() and registry.given_up == set()
    assert len(refusing.calls) == 2 and decisions[0].action == "launch"
    assert any("[host-refused]" in line and "already claimed" in line for line in lines)


def test_host_unreachable_marker_is_retried_next_tick(env_file):
    linear, mcp = FakeLinear([cand(surface="claude-code")]), FakeMcp()
    down = RecordingLaunch(raises=HostRefused("POST /tasks failed: ConnectError", "host-unreachable"))
    _, _, registry, _ = run_tick(linear, mcp, env_file=env_file, launch_fn=down)
    run_tick(linear, mcp, env_file=env_file, registry=registry, launch_fn=down)
    posted = linear.named("comment")
    assert len(posted) == 1 and "[host-unreachable]" in posted[0][2] and "retry" in posted[0][2]
    assert len(down.calls) == 2 and registry.given_up == set()


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


@pytest.mark.parametrize(
    ("identifier", "field", "value"),
    [
        ("swc-1", None, None),
        ("SWC-1", "node_id", "n1; rm -rf /"),
        ("SWC-1", "graph_id", "../escape"),
        ("SWC-1", "repo", "owner/name/extra"),
    ],
)
def test_make_launch_fn_refuses_invalid_ids_before_any_checkout_or_worktree(identifier, field, value):
    touched: list[str] = []
    fn = make_launch_fn(
        log=lambda _l: None,
        checkout=lambda _s: touched.append("checkout") or Path("/r"),
        ensure=lambda *_a: touched.append("ensure") or Path("/w"),
        launch=lambda **_k: touched.append("launch") or launched(),
    )
    found = {**FOUND, field: value} if field else FOUND
    with pytest.raises(InvalidIds):
        fn(cand(identifier=identifier), found)
    assert touched == []


def test_invalid_node_id_comments_once_creates_no_worktree_and_is_not_retried(env_file):
    ensured: list[str] = []
    launch_fn = make_launch_fn(
        log=lambda _l: None,
        checkout=lambda _s: Path("/r"),
        ensure=lambda _r, gid, _b: ensured.append(gid) or Path("/w"),
        launch=lambda **_k: launched(),
    )
    linear, mcp = FakeLinear([cand()]), FakeMcp(default={**FOUND, "node_id": "bad node"})
    _, lines, registry, _ = run_tick(linear, mcp, env_file=env_file, launch_fn=launch_fn)
    decisions, _, _, _ = run_tick(linear, mcp, env_file=env_file, registry=registry, launch_fn=launch_fn)
    assert ensured == []
    posted = linear.named("comment")
    assert len(posted) == 1 and posted[0][2].startswith(f"{COMMENT_PREFIX} [invalid-ids]")
    assert registry.given_up == {"i-1"} and registry.active_issue_ids() == set()
    assert mcp.calls == ["i-1"]  # the second tick never resolved it again
    assert [d.action for d in decisions] == ["skip"]
    assert any("[invalid-ids]" in line for line in lines)


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
    registry.add(session("a"))
    with pytest.raises(ValueError):
        registry.add(session("a"))
    registry.add(session("b"))
    assert registry.capacity_left() == 0
    with pytest.raises(ValueError):
        registry.add(session("c"))
    assert registry.active_issue_ids() == {"a", "b"}


def test_launch_registers_session_with_launch_state_and_prior_claim_sessions(env_file):
    prior = [
        f"Claimed by hermes — session OLD1 (graph {GID}, node n1)",
        f"Claimed by omp — session OTHER (graph {GID}, node n1)",
    ]
    linear, mcp = FakeLinear([cand()], comments={"i-1": prior}), FakeMcp()
    reads_at_launch: list[int] = []

    def launch_fn(candidate, found):
        reads_at_launch.append(len(linear.named("comment_bodies")))
        return launched(1001)

    _, _, registry, _ = run_tick(linear, mcp, env_file=env_file, launch_fn=launch_fn)
    assert reads_at_launch == [1]
    got = registry.get("i-1")
    assert got is not None
    assert (got.graph_id, got.node_id, got.surface) == (GID, "n1", "hermes")
    assert got.dispatch_label_id == "l-hermes" and got.pid == 1001
    assert got.launch_state == "unstarted"
    assert got.prior_claim_sessions == frozenset({"OLD1"})


def test_prelaunch_comment_read_failure_launches_nothing_and_next_tick_decides_again(env_file):
    linear = FakeLinear([cand()], fail={"comment_bodies": RuntimeError("linear 503")})
    mcp = FakeMcp()
    _, lines, registry, launch_fn = run_tick(linear, mcp, env_file=env_file)
    assert launch_fn.calls == [] and registry.active_issue_ids() == set()
    assert linear.named("comment") == []
    assert any(l.startswith("SWC-1: not launched: comment_bodies failed") for l in lines)

    linear.fail.clear()
    run_tick(linear, mcp, env_file=env_file, registry=registry, launch_fn=launch_fn)
    assert len(launch_fn.calls) == 1 and registry.active_issue_ids() == {"i-1"}


def test_decide_skips_an_issue_the_registry_gave_up_on():
    decision = decide(cand(), found=FOUND, active_issue_ids=set(), capacity_left=2, given_up={"i-1"})
    assert decision.action == "skip" and "gave up" in decision.reason


def test_given_up_issue_is_not_resolved_or_launched(env_file):
    registry = SessionRegistry()
    registry.given_up.add("i-1")
    linear, mcp = FakeLinear([cand()]), FakeMcp()
    decisions, _, _, launch_fn = run_tick(linear, mcp, env_file=env_file, registry=registry)
    assert [d.action for d in decisions] == ["skip"]
    assert mcp.calls == [] and launch_fn.calls == [] and linear.named("comment") == []


def test_dry_run_never_launches(env_file):
    linear, mcp = FakeLinear([cand()]), FakeMcp()
    decisions, _, registry, launch_fn = run_tick(linear, mcp, env_file=env_file, dry_run=True)
    assert launch_fn.calls == []
    assert registry.active_issue_ids() == set()
    assert isinstance(decisions[0], Decision) and decisions[0].action == "launch"


# --- Task 2: decision table, once-only comments, dry run, CLI ------------------------------


def test_non_hermes_surface_comments_once_and_leaves_label(env_file):
    linear, mcp = FakeLinear([cand(surface="omp")]), FakeMcp()
    decisions, _, _, launch_fn = run_tick(linear, mcp, env_file=env_file)
    assert decisions[0].action == "comment" and decisions[0].marker == "not-dispatchable"
    posted = linear.named("comment")
    assert len(posted) == 1
    assert posted[0][2].startswith(COMMENT_PREFIX) and "[not-dispatchable]" in posted[0][2]
    assert "dispatch:hermes" in posted[0][2] and "dispatch:claude-code" in posted[0][2]
    assert mcp.calls == [] and launch_fn.calls == [] and linear.named("remove_label") == []

    decisions, _, _, _ = run_tick(linear, mcp, env_file=env_file)
    assert decisions[0].marker == "not-dispatchable"
    assert len(linear.named("comment")) == 1
    assert linear.named("remove_label") == []


def test_unregistered_issue_gets_one_no_node_comment(env_file):
    linear = FakeLinear([cand()])
    mcp = FakeMcp(default={"found": False, "reason": "no registered node for SWC-1"})
    decisions, _, _, launch_fn = run_tick(linear, mcp, env_file=env_file)
    run_tick(linear, mcp, env_file=env_file)
    assert decisions[0].action == "comment" and decisions[0].marker == "no-node"
    posted = linear.named("comment")
    assert len(posted) == 1 and "[no-node]" in posted[0][2]
    assert launch_fn.calls == []


def test_claimed_node_gets_one_already_claimed_comment_naming_holder(env_file):
    claimed = {**FOUND, "node": {**FOUND["node"], "claimed_by": "claude-code"}}
    linear, mcp = FakeLinear([cand()]), FakeMcp(default=claimed)
    decisions, _, _, launch_fn = run_tick(linear, mcp, env_file=env_file)
    run_tick(linear, mcp, env_file=env_file)
    assert decisions[0].action == "comment" and decisions[0].marker == "already-claimed"
    posted = linear.named("comment")
    assert len(posted) == 1
    assert "[already-claimed]" in posted[0][2] and "claude-code" in posted[0][2]
    assert launch_fn.calls == []


def test_issue_with_running_session_is_skipped_without_graph_find(env_file):
    registry = SessionRegistry()
    registry.add(session("i-1"))
    linear, mcp = FakeLinear([cand()]), FakeMcp()
    decisions, _, _, launch_fn = run_tick(linear, mcp, env_file=env_file, registry=registry)
    assert decisions[0].action == "skip"
    assert mcp.calls == [] and launch_fn.calls == [] and linear.named("comment") == []


def test_at_capacity_skips_and_decides_again_next_tick(env_file):
    registry = SessionRegistry(max_sessions=2)
    registry.add(session("a"))
    registry.add(session("b"))
    linear, mcp = FakeLinear([cand("i-3", "SWC-3")]), FakeMcp()
    decisions, _, _, launch_fn = run_tick(linear, mcp, env_file=env_file, registry=registry)
    assert decisions[0].action == "skip" and "capacity" in decisions[0].reason
    assert launch_fn.calls == [] and linear.named("comment") == []

    registry = SessionRegistry(max_sessions=2)
    registry.add(session("a"))
    decisions, _, _, launch_fn = run_tick(linear, mcp, env_file=env_file, registry=registry)
    assert decisions[0].action == "launch" and len(launch_fn.calls) == 1
    assert mcp.calls == ["i-3", "i-3"]


def test_worktree_refused_becomes_one_once_only_marker_comment(env_file):
    linear, mcp = FakeLinear([cand()]), FakeMcp()
    refusing = RecordingLaunch(raises=WorktreeRefused("only 1.0 GB free on /", "low-disk"))
    _, lines, registry, _ = run_tick(linear, mcp, env_file=env_file, launch_fn=refusing)
    run_tick(linear, mcp, env_file=env_file, launch_fn=refusing)
    posted = linear.named("comment")
    assert len(posted) == 1 and "[low-disk]" in posted[0][2]
    assert posted[0][2].startswith(COMMENT_PREFIX)
    assert registry.active_issue_ids() == set()
    assert any("[low-disk]" in line for line in lines)


def test_dry_run_logs_every_decision_and_writes_nothing(env_file):
    claimed = {**FOUND, "node": {**FOUND["node"], "claimed_by": "omp"}}
    linear = FakeLinear([cand("i-1", "SWC-1"), cand("i-2", "SWC-2", "omp"), cand("i-3", "SWC-3")])
    mcp = FakeMcp({"i-3": claimed})
    decisions, lines, _, launch_fn = run_tick(linear, mcp, env_file=env_file, dry_run=True)
    assert [d.action for d in decisions] == ["launch", "comment", "comment"]
    assert lines[1:] == [
        f"SWC-1 dispatch:hermes → launch: graph {GID} node n1",
        "SWC-2 dispatch:omp → comment: surface omp not dispatchable",
        "SWC-3 dispatch:hermes → comment: node already claimed by omp",
    ]
    assert launch_fn.calls == []
    assert linear.named("comment") == [] and linear.named("remove_label") == []
