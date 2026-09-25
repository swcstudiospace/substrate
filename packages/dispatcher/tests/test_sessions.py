"""D-14 session watch: landed-claim rule, unclaimed exit, 600 s timeout, SIGTERM → SIGKILL."""

from __future__ import annotations

import subprocess
import sys
import time

import pytest

from substrate_dispatcher.sessions import (
    CLAIM_TIMEOUT_SECONDS,
    TERMINATE_GRACE_SECONDS,
    SessionRegistry,
    claim_comment_sessions,
    landed_claim,
)
from test_dispatch import (  # noqa: F401 — env_file is a fixture
    GID, FakeLinear, FakeMcp, RecordingLaunch, cand, env_file, run_tick, session,
)


def claim_comment(sid: str, *, surface: str = "hermes", graph: str = GID, node: str = "n1") -> str:
    return f"Claimed by {surface} — session {sid} (graph {graph}, node {node})"


class FakeGraph:
    """graph_get stand-in: one node n1 whose fields the test mutates between reaps."""

    def __init__(self, fail: Exception | None = None, **node):
        self.node = {"state": "unstarted", "claimed_by": None, "claim_session": None, **node}
        self.fail = fail
        self.calls: list[str] = []

    def graph_get(self, graph_id: str) -> dict:
        self.calls.append(graph_id)
        if self.fail:
            raise self.fail
        return {"graph_id": graph_id, "nodes": [{"node_id": "n1", **self.node}]}


def setup(*, comments: list[str] | None = None, linear_fail=None, proc=None, **node):
    registry = SessionRegistry()
    s = session() if proc is None else session(proc=proc, pid=proc.pid)
    registry.add(s)
    linear = FakeLinear(comments={"i-1": list(comments or [])}, fail=linear_fail)
    mcp = FakeGraph(**node)
    lines: list[str] = []

    def reap(now: float) -> None:
        registry.reap(now, mcp=mcp, linear=linear, log=lines.append)

    return registry, s, linear, mcp, reap, lines


def posted(linear: FakeLinear) -> list[str]:
    return [c[2] for c in linear.named("comment")]


def assert_untouched(registry, s, linear):
    assert posted(linear) == []
    assert linear.named("remove_label") == []
    assert s.proc.signals == []
    assert registry.given_up == set()


# --- timeout -----------------------------------------------------------------------------


def test_timeout_at_600_comments_removes_label_terminates_and_holds_slot():
    registry, s, linear, _, reap, _ = setup()
    reap(CLAIM_TIMEOUT_SECONDS - 1)
    assert_untouched(registry, s, linear)
    capacity = registry.capacity_left()

    reap(CLAIM_TIMEOUT_SECONDS)
    bodies = posted(linear)
    assert len(bodies) == 1 and "[claim-timeout]" in bodies[0]
    assert linear.named("remove_label") == [("remove_label", "i-1", "l-hermes")]
    assert s.proc.signals == ["terminate"]
    assert s.terminated_at == CLAIM_TIMEOUT_SECONDS
    assert registry.given_up == {"i-1"}
    assert registry.capacity_left() == capacity and registry.active_issue_ids() == {"i-1"}

    # Exits inside the grace window: no SIGKILL, removed quietly, slot freed.
    s.proc.code = -15
    reap(CLAIM_TIMEOUT_SECONDS + 5)
    assert s.proc.signals == ["terminate"]
    assert registry.active_issue_ids() == set() and registry.capacity_left() == capacity + 1
    assert len(posted(linear)) == 1 and not any("[exited-unclaimed]" in b for b in posted(linear))
    assert len(linear.named("remove_label")) == 1


def test_sigterm_ignoring_session_is_killed_after_grace_and_holds_its_slot(env_file):
    registry, s, linear, mcp, reap, _ = setup()
    other = session("i-2")
    registry.add(other)
    reap(CLAIM_TIMEOUT_SECONDS)
    assert s.proc.signals == ["terminate"]

    reap(CLAIM_TIMEOUT_SECONDS + TERMINATE_GRACE_SECONDS - 1)
    assert s.proc.signals == ["terminate"]
    # Still terminating: the slot is held, so a new candidate is not launched.
    tick_linear = FakeLinear([cand("i-3", "SWC-3")])
    decisions, _, _, launch_fn = run_tick(
        tick_linear, FakeMcp(), env_file=env_file, registry=registry, launch_fn=RecordingLaunch()
    )
    assert registry.capacity_left() == 0
    assert decisions[0].action == "skip" and launch_fn.calls == []

    reap(CLAIM_TIMEOUT_SECONDS + TERMINATE_GRACE_SECONDS)
    assert s.proc.signals == ["terminate", "kill"]
    assert registry.active_issue_ids() == {"i-1", "i-2"}

    s.proc.code = -9
    reap(CLAIM_TIMEOUT_SECONDS + TERMINATE_GRACE_SECONDS + 30)
    assert registry.active_issue_ids() == {"i-2"} and registry.capacity_left() == 1
    assert not any("[exited-unclaimed]" in b for b in posted(linear))


IGNORE_SIGTERM = (
    "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
    "print('ready', flush=True); time.sleep(60)"
)
HONOUR_SIGTERM = "import time; print('ready', flush=True); time.sleep(60)"


@pytest.mark.parametrize("script, killed", [(IGNORE_SIGTERM, True), (HONOUR_SIGTERM, False)])
def test_real_child_timeout_sigterm_then_sigkill_only_if_still_alive(script, killed):
    proc = subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.PIPE, text=True)
    stdout = proc.stdout
    assert stdout is not None
    try:
        assert stdout.readline().strip() == "ready"
        registry, s, linear, mcp, reap, lines = setup(proc=proc)

        reap(CLAIM_TIMEOUT_SECONDS)
        assert s.terminated_at == CLAIM_TIMEOUT_SECONDS
        time.sleep(0.5)
        assert (proc.poll() is None) is killed
        reap(CLAIM_TIMEOUT_SECONDS + TERMINATE_GRACE_SECONDS - 1)
        if killed:
            # SIGTERM ignored (as Hermes did in 02-09): alive, slot held, no SIGKILL yet.
            assert proc.poll() is None and registry.active_issue_ids() == {"i-1"}
            reap(CLAIM_TIMEOUT_SECONDS + TERMINATE_GRACE_SECONDS)
            assert any("sent SIGKILL" in line for line in lines)
            assert proc.wait(timeout=5) == -9
            assert registry.active_issue_ids() == {"i-1"}
            reap(CLAIM_TIMEOUT_SECONDS + TERMINATE_GRACE_SECONDS + 30)
        else:
            assert proc.returncode == -15
            assert not any("sent SIGKILL" in line for line in lines)
        assert registry.active_issue_ids() == set()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        stdout.close()


# --- claim watch -------------------------------------------------------------------------


def test_claimed_by_at_120_records_claim_and_never_times_out():
    registry, s, linear, mcp, reap, lines = setup()
    reap(60)
    mcp.node.update(claimed_by="hermes", claim_session="S9", state="started")
    reap(120)
    assert s.claimed_at == 120 and s.claim_session == "S9"
    assert "claim landed for SWC-i-1 (claimed_by, session S9)" in lines
    reap(900)
    assert_untouched(registry, s, linear)
    assert registry.active_issue_ids() == {"i-1"}


def test_exit_after_observed_claim_is_removed_quietly():
    registry, s, linear, mcp, reap, lines = setup(claimed_by="hermes", claim_session="S9")
    reap(30)
    s.proc.code = 0
    reap(60)
    assert registry.active_issue_ids() == set() and registry.capacity_left() == 2
    assert_untouched(registry, s, linear)
    assert any("exited (code 0) after its claim (session S9)" in l for l in lines)


def test_exit_with_landed_claim_found_at_exit_time_is_removed_quietly():
    registry, s, linear, mcp, reap, _ = setup(claimed_by="hermes", claim_session="S9")
    s.proc.code = 0
    reap(30)
    assert registry.active_issue_ids() == set()
    assert_untouched(registry, s, linear)
    assert s.claim_session == "S9"


def test_claim_then_complete_between_reaps():
    # Exited variant: graph_get shows completed with the claim nulled by releaseNode.
    registry, s, linear, mcp, reap, lines = setup()
    reap(30)
    assert s.claimed_at is None
    mcp.node.update(state="completed", claimed_by=None, claim_session=None)
    linear.comments["i-1"].append(claim_comment("S1"))
    s.proc.code = 0
    reap(60)
    assert s.claimed_at == 60 and s.claim_session == "S1"
    assert len(linear.named("comment_bodies")) == 1
    assert registry.active_issue_ids() == set()
    assert_untouched(registry, s, linear)

    # Alive variant: the same node through start+600 s never times out.
    registry, s, linear, mcp, reap, _ = setup()
    reap(30)
    mcp.node.update(state="completed", claimed_by=None, claim_session=None)
    linear.comments["i-1"].append(claim_comment("S1"))
    for now in (60, 300, CLAIM_TIMEOUT_SECONDS, CLAIM_TIMEOUT_SECONDS + 30):
        reap(now)
    assert s.claimed_at == 60
    assert_untouched(registry, s, linear)
    assert registry.active_issue_ids() == {"i-1"}


@pytest.mark.parametrize(
    "node, comments, evidence",
    [
        ({"state": "started_review"}, [], ("state", None)),
        ({"state": "unstarted"}, [claim_comment("S2")], ("comment", "S2")),
    ],
    ids=["state-without-mirror-comment", "comment-after-release"],
)
def test_each_evidence_source_counts_alone(node, comments, evidence):
    registry, s, linear, mcp, reap, _ = setup(comments=comments, **node)
    assert landed_claim(s, mcp.node, comments) == evidence
    s.proc.code = 0
    reap(30)
    assert registry.active_issue_ids() == set()
    assert_untouched(registry, s, linear)


@pytest.mark.parametrize(
    "node, comments, launch_state, prior",
    [
        ({}, [claim_comment("OLD")], "unstarted", {"OLD"}),
        ({}, [claim_comment("S3", surface="omp")], "unstarted", set()),
        ({}, [claim_comment("S3", graph="ut-other-graph")], "unstarted", set()),
        ({}, [claim_comment("S3", node="n2")], "unstarted", set()),
        ({}, ["quoted: " + claim_comment("S3")], "unstarted", set()),
        ({"state": "completed"}, [], "completed", set()),
    ],
    ids=["prior-session", "other-surface", "other-graph", "other-node", "not-at-start", "completed-at-launch"],
)
def test_not_evidence_makes_the_exit_unclaimed(node, comments, launch_state, prior):
    registry, s, linear, mcp, reap, _ = setup(comments=comments, **node)
    s.launch_state, s.prior_claim_sessions = launch_state, frozenset(prior)
    assert landed_claim(s, mcp.node, comments) is None
    s.proc.code = 1
    reap(30)
    bodies = posted(linear)
    assert len(bodies) == 1 and "[exited-unclaimed]" in bodies[0]


def test_claim_comment_sessions_matches_this_surface_graph_and_node_only():
    bodies = [
        claim_comment("A"),
        claim_comment("B", surface="omp"),
        claim_comment("C", graph="ut-x"),
        "substrate-dispatcher: [no-node] nope",
        claim_comment("D"),
    ]
    assert claim_comment_sessions(bodies, surface="hermes", graph_id=GID, node_id="n1") == {"A", "D"}


# --- unclaimed exit, deferral, label retry -------------------------------------------------


def test_unclaimed_exit_comments_once_removes_label_and_gives_up():
    registry, s, linear, mcp, reap, _ = setup()
    s.proc.code = 1
    reap(30)
    bodies = posted(linear)
    assert len(bodies) == 1
    assert "[exited-unclaimed]" in bodies[0] and "exited (code 1)" in bodies[0]
    assert linear.named("remove_label") == [("remove_label", "i-1", "l-hermes")]
    assert registry.active_issue_ids() == set() and registry.capacity_left() == 2
    assert registry.given_up == {"i-1"}


def test_unclaimed_exit_comment_is_once_only():
    existing = "substrate-dispatcher: [exited-unclaimed] hermes session exited (code 1) earlier"
    registry, s, linear, mcp, reap, _ = setup(comments=[existing])
    s.proc.code = 1
    reap(30)
    assert posted(linear) == []
    assert len(linear.named("remove_label")) == 1 and registry.given_up == {"i-1"}


@pytest.mark.parametrize("broken", ["graph_get", "comment_bodies"])
@pytest.mark.parametrize("trigger", ["exit", "timeout"])
def test_unread_evidence_defers_the_decision_to_the_next_reap(broken, trigger):
    registry, s, linear, mcp, reap, lines = setup()
    if broken == "graph_get":
        mcp.fail = RuntimeError("mcp down")
    else:
        linear.fail["comment_bodies"] = RuntimeError("linear 503")
    now = 30 if trigger == "exit" else CLAIM_TIMEOUT_SECONDS
    if trigger == "exit":
        s.proc.code = 1
    reap(now)
    assert_untouched(registry, s, linear)
    assert s.terminated_at is None and registry.active_issue_ids() == {"i-1"}
    assert any("claim decision deferred" in l for l in lines)

    mcp.fail = None
    linear.fail.clear()
    reap(now + 30)
    marker = "[exited-unclaimed]" if trigger == "exit" else "[claim-timeout]"
    assert len(posted(linear)) == 1 and marker in posted(linear)[0]
    assert registry.given_up == {"i-1"}


def test_failed_label_removal_is_retried_and_the_issue_is_not_relaunched(env_file):
    registry, s, linear, mcp, reap, _ = setup(linear_fail={"remove_label": RuntimeError("503")})
    s.proc.code = 1
    reap(30)
    assert registry.pending_label_removal == {"i-1": "l-hermes"}
    assert registry.given_up == {"i-1"} and registry.active_issue_ids() == set()

    # Label still on the issue: the next tick skips it and never launches.
    tick_linear = FakeLinear([cand()])
    decisions, _, _, launch_fn = run_tick(tick_linear, FakeMcp(), env_file=env_file, registry=registry)
    assert [d.action for d in decisions] == ["skip"] and launch_fn.calls == []

    reap(60)
    assert len(linear.named("remove_label")) == 2
    linear.fail.clear()
    reap(90)
    assert len(linear.named("remove_label")) == 3
    assert registry.pending_label_removal == {}
    reap(120)
    assert len(linear.named("remove_label")) == 3
