"""33-01 addon: claude-code route over a fake host transport (LANEA-04 rehearsal).

Proves the wired route end to end with fakes only: the real tick branch
(dispatch.py:382) drives the real HostClient over httpx.MockTransport, returns a
Launched whose proc is a RemoteTask, and the same SessionRegistry contract the
hermes path uses watches it. No routing-logic diffs — test doubles only.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from substrate_dispatcher.dispatch import COMMENT_PREFIX, MARKERS
from substrate_dispatcher.host import HostClient, RemoteTask
from substrate_dispatcher.sessions import SessionRegistry

from test_dispatch import EventMcp  # noqa: F401 — shared fake
from test_dispatch import FakeLinear, FakeMcp, cand, env_file, run_tick  # noqa: F401

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

TASK_STATUS = {"graph_id": GID, "node_id": "n1", "session_id": "n1", "state": "waiting", "exit_code": None}
BEARER = "substrate-bearer-planted-9f8e7d6c5b4a"

EXPECTED_MARKERS = frozenset({
    "not-dispatchable", "no-node", "already-claimed", "invalid-graph-id", "invalid-ids",
    "no-checkout", "low-disk", "path-conflict", "git-failed", "host-refused",
    "host-unreachable", "exited-unclaimed", "claim-timeout",
    # U4 (uplift 02): the storm-breaker's refusal is a new once-only reason the
    # operator reads on Linear; the D33-02 lock still pins every existing text.
    "quota-burn",
})


class FakeHostWorld:
    """Scripted substrate-host over MockTransport; records POST bodies and headers."""

    def __init__(self, status: int = 202, payload=None, fail: Exception | None = None):
        self.posts: list[dict] = []
        self.headers: list[dict] = []
        self.requests = 0
        self.status = status
        self.payload = TASK_STATUS if payload is None else payload
        self.fail = fail
        self.exit_code: int | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests += 1
        if self.fail is not None:
            raise self.fail
        if request.method == "POST" and request.url.path == "/tasks":
            body = json.loads(request.content)
            self.posts.append(body)
            self.headers.append(dict(request.headers))
            if isinstance(self.payload, bytes):
                return httpx.Response(self.status, content=self.payload)
            return httpx.Response(self.status, json=self.payload)
        if request.method == "GET":
            return httpx.Response(200, json={**TASK_STATUS, "exit_code": self.exit_code})
        if request.method == "POST":
            return httpx.Response(202, json={"accepted": True})
        return httpx.Response(404, json={"error": "no route"})

    def client(self) -> HostClient:
        return HostClient(transport=httpx.MockTransport(self.handler), bearer=BEARER)


class ClaimMcp(EventMcp):
    """EventMcp with a mutable graph_get node for the reap path."""

    def __init__(self, node=None, **kw):
        super().__init__(**kw)
        self.node = dict(node or {"node_id": "n1", "state": "unstarted", "claimed_by": None})

    def graph_get(self, graph_id: str) -> dict:
        return {"graph_id": graph_id, "nodes": [dict(self.node)]}


def launch_via_tick(world, mcp, linear, env_file, registry, tmp_path, candidate=None):
    """Run one tick with make_launch_fn bound to the real HostClient over the fake transport."""
    from substrate_dispatcher.dispatch import make_launch_fn

    candidate = candidate or cand(identifier="SWC-9", surface="claude-code")
    wt = tmp_path / GID
    launch_fn = make_launch_fn(
        log=lambda _l: None,
        checkout=lambda _slug: tmp_path,
        ensure=lambda _repo, _gid, _branch: wt,
        open_task=world.client().launch,
    )
    return run_tick(linear, mcp, env_file=env_file, registry=registry, launch_fn=launch_fn)


def test_claude_code_tick_posts_ids_only_body_with_bearer_and_emits_launched(tmp_path, env_file):
    world = FakeHostWorld()
    mcp = ClaimMcp(default=dict(FOUND))
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")])
    registry = SessionRegistry()
    decisions, lines, registry, _ = launch_via_tick(world, mcp, linear, env_file, registry, tmp_path)

    assert [d.action for d in decisions] == ["launch"]
    assert len(world.posts) == 1
    assert set(world.posts[0]) == {"graph_id", "node_id", "identifier", "repo", "worktree"}
    assert world.posts[0]["graph_id"] == GID and world.posts[0]["identifier"] == "SWC-9"
    assert world.headers[0].get("authorization") == f"Bearer {BEARER}"
    got = registry.get("i-1")
    assert got is not None and isinstance(got.proc, RemoteTask) and got.pid == 0
    assert linear.named("comment") == [] and linear.named("remove_label") == []
    launched = [a for t, a in mcp.events if t == "events_emit" and a["payload"].get("outcome") == "launched"]
    assert len(launched) == 1 and launched[0]["graph_id"] == GID


def test_claude_code_post_body_and_logs_carry_no_token_value(tmp_path, env_file):
    world = FakeHostWorld()
    mcp = ClaimMcp(default=dict(FOUND))
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")])
    decisions, lines, registry, _ = launch_via_tick(
        world, mcp, linear, env_file, SessionRegistry(), tmp_path)
    assert [d.action for d in decisions] == ["launch"]
    haystacks = [json.dumps(world.posts[0]), *lines]
    haystacks += [json.dumps(a) for _, a in mcp.events]
    assert all(BEARER not in h for h in haystacks)
    assert all("issue text" not in h for h in haystacks)


@pytest.mark.parametrize("shape", ["claimed_by", "state", "comment"])
def test_claude_code_landed_claim_counts_as_success_for_each_evidence_shape(tmp_path, env_file, shape):
    world = FakeHostWorld()
    mcp = ClaimMcp(default=dict(FOUND))
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")])
    registry = SessionRegistry()
    _, lines, registry, _ = launch_via_tick(world, mcp, linear, env_file, registry, tmp_path)
    assert registry.active_issue_ids() == {"i-1"}

    if shape == "claimed_by":
        mcp.node = {"node_id": "n1", "state": "unstarted", "claimed_by": "claude-code", "claim_session": "n1"}
        registry.reap(30.0, mcp=mcp, linear=linear, log=lines.append)
        assert registry.get("i-1").claimed_at == 30.0
        assert any("claim landed for SWC-9 (claimed_by, session n1)" in line for line in lines)
        world.exit_code = 0
        registry.reap(60.0, mcp=mcp, linear=linear, log=lines.append)
    elif shape == "state":
        mcp.node = {"node_id": "n1", "state": "completed", "claimed_by": None}
        registry.reap(30.0, mcp=mcp, linear=linear, log=lines.append)
        assert registry.get("i-1").claimed_at == 30.0
        assert any("claim landed for SWC-9 (state," in line for line in lines)
        world.exit_code = 0
        registry.reap(60.0, mcp=mcp, linear=linear, log=lines.append)
    else:
        linear.comments.setdefault("i-1", []).append(
            f"Claimed by claude-code — session S9 (graph {GID}, node n1)")
        world.exit_code = 0
        registry.reap(30.0, mcp=mcp, linear=linear, log=lines.append)
        assert any("after its claim (session S9)" in line for line in lines)

    assert registry.active_issue_ids() == set() and registry.given_up == set()
    assert linear.named("comment") == [] and linear.named("remove_label") == []


@pytest.mark.parametrize("status", [400, 409, 502])
def test_claude_code_refusal_comments_once_with_host_text_in_journal_only(tmp_path, env_file, status):
    world = FakeHostWorld(status=status, payload={"error": "node n1 already claimed by hermes"})
    mcp = ClaimMcp(default=dict(FOUND))
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")])
    registry = SessionRegistry()
    _, lines, _, _ = launch_via_tick(world, mcp, linear, env_file, registry, tmp_path)
    decisions, lines2, _, _ = launch_via_tick(world, mcp, linear, env_file, registry, tmp_path)
    posted = linear.named("comment")
    assert len(posted) == 1
    assert posted[0][2] == f"substrate-dispatcher: [host-refused] {MARKERS['host-refused']}"
    assert "already claimed" not in posted[0][2]
    assert any("[host-refused]" in line and "already claimed" in line for line in lines + lines2)
    assert registry.active_issue_ids() == set() and registry.given_up == set()
    assert world.requests == 2 and decisions[0].action == "launch"
    failed = [a for t, a in mcp.events if a.get("payload", {}).get("reason") == "host-refused"]
    assert len(failed) == 1 and failed[0]["kind"] == "warning"
    assert set(MARKERS) == EXPECTED_MARKERS  # D33-02: zero marker additions or text changes


def test_claude_code_connect_failure_retries_next_tick_with_comment_but_no_event(tmp_path, env_file):
    world = FakeHostWorld(fail=httpx.ConnectError("refused"))
    mcp = ClaimMcp(default=dict(FOUND))
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")])
    registry = SessionRegistry()
    launch_via_tick(world, mcp, linear, env_file, registry, tmp_path)
    launch_via_tick(world, mcp, linear, env_file, registry, tmp_path)
    posted = linear.named("comment")
    assert len(posted) == 1 and "[host-unreachable]" in posted[0][2]
    assert mcp.events == []  # silent: no dispatch.failed for the retryable marker
    assert registry.given_up == set() and registry.active_issue_ids() == set() and world.requests == 2


@pytest.mark.parametrize("body", [b"not json{", ["a", "list"]])
def test_claude_code_accepted_but_unreadable_reply_keeps_its_record_and_is_not_reposted(tmp_path, env_file, body):
    world = FakeHostWorld(status=200, payload=body)
    mcp = ClaimMcp(default=dict(FOUND))
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")])
    registry = SessionRegistry()
    launch_via_tick(world, mcp, linear, env_file, registry, tmp_path)
    launch_via_tick(world, mcp, linear, env_file, registry, tmp_path)
    posted = linear.named("comment")
    assert len(posted) == 1 and "[host-unreachable]" in posted[0][2]
    assert mcp.events == []  # silent: no dispatch.failed for the retryable marker
    # The host answered 200, so it may have opened the task: the record holds the slot and the second tick does not post again.
    assert registry.given_up == set() and registry.active_issue_ids() == {"i-1"} and world.requests == 1


def test_claude_code_exited_unclaimed_gives_up_removes_label_and_never_relaunches(tmp_path, env_file):
    state_dir = tmp_path / "state"
    world = FakeHostWorld()
    mcp = ClaimMcp(default=dict(FOUND))
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")])
    registry = SessionRegistry(state_dir=state_dir)
    _, lines, registry, _ = launch_via_tick(world, mcp, linear, env_file, registry, tmp_path)
    started = registry.get("i-1").started_at

    world.exit_code = 1
    registry.reap(started + 10.0, mcp=mcp, linear=linear, log=lines.append)
    posted = linear.named("comment")
    assert len(posted) == 1 and "[exited-unclaimed]" in posted[0][2]
    assert linear.named("remove_label") == [("remove_label", "i-1", "l-claude-code")]
    assert registry.given_up == {"i-1"} and registry.active_issue_ids() == set()
    failed = [a for t, a in mcp.events if a.get("payload", {}).get("reason") == "exited-unclaimed"]
    assert len(failed) == 1

    rebooted = SessionRegistry(state_dir=state_dir)
    assert rebooted.given_up == {"i-1"}
    world2 = FakeHostWorld()
    mcp2 = ClaimMcp(default=dict(FOUND))
    decisions, _, _, launch_b = launch_via_tick(
        world2, mcp2, linear, env_file, rebooted, tmp_path,
        candidate=cand(identifier="SWC-9", surface="claude-code"))
    assert [d.action for d in decisions] == ["skip"]
    assert world2.requests == 0  # never relaunches: no POST /tasks after restart


def test_claude_code_claim_timeout_gives_up_like_the_hermes_path(tmp_path, env_file):
    from substrate_dispatcher.sessions import CLAIM_TIMEOUT_SECONDS

    assert CLAIM_TIMEOUT_SECONDS == 900
    world = FakeHostWorld()
    mcp = ClaimMcp(default=dict(FOUND))
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")])
    registry = SessionRegistry()
    _, lines, registry, _ = launch_via_tick(world, mcp, linear, env_file, registry, tmp_path)
    started = registry.get("i-1").started_at
    registry.reap(started + 900.0, mcp=mcp, linear=linear, log=lines.append)
    assert any("[claim-timeout]" in c[2] for c in linear.named("comment"))
    assert linear.named("remove_label") == [("remove_label", "i-1", "l-claude-code")]
    assert registry.given_up == {"i-1"}
