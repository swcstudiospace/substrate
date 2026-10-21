"""D43-A re-adoption: a VM task survives a dispatcher restart and is resolved against substrate-host.

The host is the real HostClient over httpx.MockTransport (HostWorld below); the tick, the launch
path and the reap are the production code. Times are passed in explicitly; nothing sleeps.
"""

from __future__ import annotations

import json
import stat
from pathlib import Path

import httpx

from substrate_dispatcher.dispatch import make_launch_fn
from substrate_dispatcher.host import HostClient, RemoteTask
from substrate_dispatcher.sessions import SessionRegistry, landed_claim
from test_dispatch import FOUND, GID, EventMcp, FakeLinear, FakeMcp, cand, env_file, run_tick  # noqa: F401 — env_file is a fixture


def found_for(graph_id: str) -> dict:
    return {**FOUND, "graph_id": graph_id}


class HostWorld:
    """substrate-host over MockTransport. POST /tasks opens a running task; GET reports it.

    ``tasks`` maps (graph, node) to its exit code (None while running); an absent task answers 404.
    ``down`` makes every request fail at the transport.
    """

    def __init__(self) -> None:
        self.tasks: dict[tuple[str, str], int | None] = {}
        self.down = False
        self.posts = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("substrate-host down", request=request)
        if request.method == "POST" and request.url.path == "/tasks":
            body = json.loads(request.content)
            self.posts += 1
            self.tasks[(body["graph_id"], body["node_id"])] = None
            return httpx.Response(202, json={"graph_id": body["graph_id"], "node_id": body["node_id"], "exit_code": None})
        if request.method == "GET" and request.url.path.startswith("/tasks/"):
            _, _, graph_id, node_id = request.url.path.split("/")
            if (graph_id, node_id) not in self.tasks:
                return httpx.Response(404, json={"error": "no such task"})
            return httpx.Response(200, json={"graph_id": graph_id, "node_id": node_id, "exit_code": self.tasks[(graph_id, node_id)]})
        if request.method == "POST":
            return httpx.Response(202, json={"accepted": True})
        return httpx.Response(500, json={"error": "unexpected request"})

    def client(self) -> HostClient:
        return HostClient(transport=httpx.MockTransport(self.handler))


class ReapMcp(EventMcp):
    """EventMcp with graph_get: every node is unstarted and unclaimed, so reap sees no claim."""

    def graph_get(self, graph_id: str) -> dict:
        return {"graph_id": graph_id, "nodes": [{"node_id": "n1", "state": "unstarted", "claimed_by": None}]}


def registry_for(state, world: HostWorld, lines: list[str], *, max_sessions: int = 2) -> SessionRegistry:
    return SessionRegistry(max_sessions=max_sessions, state_dir=state, log=lines.append, host=world.client())


def open_fn(world: HostWorld, lines: list[str]):
    return make_launch_fn(
        log=lines.append,
        checkout=lambda _slug: Path("/var/lib/substrate/worktrees"),
        ensure=lambda _repo, graph_id, _branch: Path("/var/lib/substrate/worktrees") / graph_id,
        open_task=world.client().launch,
    )


def launch_vm(registry, world, linear, mcp, env_file, lines) -> None:
    run_tick(linear, mcp, env_file=env_file, registry=registry, launch_fn=open_fn(world, lines))


def test_a_running_vm_task_survives_a_dispatcher_restart_and_is_readopted(tmp_path, env_file):
    state, world, lines = tmp_path / "state", HostWorld(), []
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")])
    first = registry_for(state, world, lines)
    launch_vm(first, world, linear, ReapMcp(default=dict(FOUND)), env_file, lines)
    original = first.get("i-1")
    assert original is not None and world.posts == 1

    # The dispatcher restarts while substrate-host keeps the task running.
    second = registry_for(state, world, lines)
    assert second.get("i-1") is None and second.active_issue_ids() == {"i-1"}
    second.readopt()
    got = second.get("i-1")
    assert isinstance(got.proc, RemoteTask) and got.pid == 0
    assert (got.identifier, got.graph_id, got.node_id, got.surface) == ("SWC-9", GID, "n1", "claude-code")
    assert got.started_at == original.started_at and got.repo == FOUND["repo"]
    assert second.capacity_left() == 1

    # Re-adopted like any other session: still running, so reap leaves it alone.
    second.reap(got.started_at + 10.0, mcp=ReapMcp(default=dict(FOUND)), linear=linear, log=lines.append)
    assert second.get("i-1") is got and linear.named("comment") == []


def test_a_claim_from_an_earlier_session_is_not_counted_for_a_readopted_task(tmp_path, env_file):
    state, world, lines = tmp_path / "state", HostWorld(), []
    earlier = f"Claimed by claude-code — session OLD1 (graph {GID}, node n1)"
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")], comments={"i-1": [earlier]})
    launch_vm(registry_for(state, world, lines), world, linear, ReapMcp(default=dict(FOUND)), env_file, lines)

    second = registry_for(state, world, lines)
    second.readopt()
    got = second.get("i-1")
    assert got is not None and got.prior_claim_sessions == frozenset({"OLD1"})
    assert landed_claim(got, None, [earlier]) is None


def test_a_vm_task_the_host_no_longer_knows_is_dropped_from_the_record_store(tmp_path, env_file):
    state, world, lines = tmp_path / "state", HostWorld(), []
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")])
    launch_vm(registry_for(state, world, lines), world, linear, ReapMcp(default=dict(FOUND)), env_file, lines)
    world.tasks.clear()  # substrate-host answers 404 from now on

    second = registry_for(state, world, lines)
    before = len(lines)
    second.readopt()
    assert second.get("i-1") is None
    named = lines[before:]
    assert len(named) == 1 and GID in named[0]
    assert registry_for(state, world, lines).active_issue_ids() == set()


def test_a_vm_task_that_finished_while_the_dispatcher_was_down_is_readopted_so_its_outcome_is_reaped(
    tmp_path, env_file
):
    state, world, lines = tmp_path / "state", HostWorld(), []
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")])
    launch_vm(registry_for(state, world, lines), world, linear, ReapMcp(default=dict(FOUND)), env_file, lines)
    world.tasks[(GID, "n1")] = 1  # the turn ended with exit code 1 while the dispatcher was down

    second = registry_for(state, world, lines)
    second.readopt()
    got = second.get("i-1")
    assert got is not None and got.proc.poll() == 1

    reap_mcp, reap_linear = ReapMcp(default=dict(FOUND)), FakeLinear()
    second.reap(got.started_at + 10.0, mcp=reap_mcp, linear=reap_linear, log=lines.append)
    assert second.get("i-1") is None
    assert reap_linear.named("remove_label") == [("remove_label", "i-1", "l-claude-code")]
    posted = [c[2] for c in reap_linear.named("comment")]
    assert len(posted) == 1 and "[exited-unclaimed]" in posted[0]
    failed = [a for t, a in reap_mcp.events if a.get("payload", {}).get("reason") == "exited-unclaimed"]
    assert len(failed) == 1
    assert registry_for(state, world, lines).active_issue_ids() == set()


def test_an_unreachable_host_keeps_the_record_and_retries_on_a_later_tick(tmp_path, env_file):
    state, world, lines = tmp_path / "state", HostWorld(), []
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")])
    launch_vm(registry_for(state, world, lines), world, linear, ReapMcp(default=dict(FOUND)), env_file, lines)

    world.down = True
    second = registry_for(state, world, lines)
    second.readopt()
    second.readopt()
    assert second.get("i-1") is None and second.active_issue_ids() == {"i-1"}

    world.down = False
    second.readopt()
    assert isinstance(second.get("i-1").proc, RemoteTask)


def test_an_unreachable_host_drops_the_record_after_sixty_failed_attempts(tmp_path, env_file):
    state, world, lines = tmp_path / "state", HostWorld(), []
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")])
    launch_vm(registry_for(state, world, lines), world, linear, ReapMcp(default=dict(FOUND)), env_file, lines)

    world.down = True
    second = registry_for(state, world, lines)
    before = len(lines)
    for _ in range(59):
        second.readopt()
    assert second.active_issue_ids() == {"i-1"}
    second.readopt()
    assert second.active_issue_ids() == set()
    named = lines[before:]
    assert len(named) == 1 and GID in named[0]
    assert registry_for(state, world, lines).active_issue_ids() == set()


def test_readoption_never_exceeds_max_sessions_and_the_rest_stay_recorded(tmp_path, env_file):
    state, world, lines = tmp_path / "state", HostWorld(), []
    issues = [("i-1", "SWC-1", "ut-readopt-a1"), ("i-2", "SWC-2", "ut-readopt-a2"), ("i-3", "SWC-3", "ut-readopt-a3")]
    linear = FakeLinear([cand(iid, ident, surface="claude-code") for iid, ident, _ in issues])
    mcp = ReapMcp(answers={iid: found_for(gid) for iid, _, gid in issues})
    first = registry_for(state, world, lines, max_sessions=3)
    run_tick(linear, mcp, env_file=env_file, registry=first, launch_fn=open_fn(world, lines))
    assert len(first.active_issue_ids()) == 3 and world.posts == 3

    second = registry_for(state, world, lines, max_sessions=2)
    second.readopt()
    assert second.get("i-1") is not None and second.get("i-2") is not None
    assert second.get("i-3") is None and second.capacity_left() == 0
    assert second.active_issue_ids() == {"i-1", "i-2", "i-3"}

    roomy = registry_for(state, world, lines, max_sessions=3)
    roomy.readopt()
    assert roomy.get("i-3") is not None  # the record held back by the cap was still there


def test_hermes_sessions_are_never_written_to_vm_tasks_json(tmp_path, env_file):
    state, world, lines = tmp_path / "state", HostWorld(), []
    registry = registry_for(state, world, lines)
    linear, mcp = FakeLinear([cand()]), FakeMcp()
    run_tick(linear, mcp, env_file=env_file, registry=registry)
    assert registry.get("i-1") is not None
    assert not (state / "vm_tasks.json").exists()

    rebooted = registry_for(state, world, lines)
    rebooted.readopt()
    assert rebooted.active_issue_ids() == set() and world.posts == 0


def test_a_corrupt_vm_tasks_json_starts_empty_and_logs_once(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    (state / "vm_tasks.json").write_text("{not json[")
    world, lines = HostWorld(), []
    registry = registry_for(state, world, lines)
    assert len(lines) == 1 and "vm_tasks.json" in lines[0]

    registry.readopt()
    assert registry.active_issue_ids() == set() and registry.capacity_left() == 2
    assert len(lines) == 1


def test_the_record_file_is_0600_and_its_directory_0700(tmp_path, env_file):
    state, world, lines = tmp_path / "state", HostWorld(), []
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")])
    launch_vm(registry_for(state, world, lines), world, linear, ReapMcp(default=dict(FOUND)), env_file, lines)
    assert stat.S_IMODE((state / "vm_tasks.json").stat().st_mode) == 0o600
    assert stat.S_IMODE(state.stat().st_mode) == 0o700


def test_a_give_up_removes_the_vm_task_record_so_a_restart_does_not_readopt_it(tmp_path, env_file):
    state, world, lines = tmp_path / "state", HostWorld(), []
    linear = FakeLinear([cand(identifier="SWC-9", surface="claude-code")])
    mcp = ReapMcp(default=dict(FOUND))
    first = registry_for(state, world, lines)
    launch_vm(first, world, linear, mcp, env_file, lines)
    started = first.get("i-1").started_at

    first.reap(started + 900.0, mcp=mcp, linear=linear, log=lines.append)  # claim timeout: give up
    assert first.given_up == {"i-1"}
    assert registry_for(state, world, lines).active_issue_ids() == set()
