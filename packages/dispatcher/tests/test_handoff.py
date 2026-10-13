"""U3 handoffs: packet shape, pre-launch order, fail-open warnings, replay from the ledger."""

from __future__ import annotations

import inspect
import json
from pathlib import Path

import pytest

from substrate_dispatcher import handoff
from substrate_dispatcher.dispatch import make_launch_fn
from substrate_dispatcher.linear import Candidate

GID = "ut-mugzzzzz-0123abcd"
REPO = "swcstudiospace/agent-substrate"
WT = f"/var/lib/substrate/worktrees/{GID}"
FOUND = {
    "found": True,
    "graph_id": GID,
    "node_id": "n1",
    "repo": REPO,
    "branch": "main",
    "graph_status": "Implementing",
    "node": {"node_id": "n1", "state": "unstarted", "claimed_by": None},
}
IDS = dict(
    identifier="SWC-1", graph_id=GID, node_id="n1", repo=REPO, branch="main",
    worktree=WT, surface="hermes",
)
DOD = [line.format(graph_id=GID, node_id="n1", surface="hermes") for line in handoff.DISPATCH_DOD]


def cand(issue_id: str = "i-1", identifier: str = "SWC-1", surface: str = "hermes") -> Candidate:
    return Candidate(
        issue_id=issue_id, identifier=identifier, team_id="t", team_key="SWC",
        surface=surface, dispatch_label_id=f"l-{surface}", dispatch_label=f"dispatch:{surface}",
    )


def packet_reply(**packet_overrides) -> dict:
    """A well-formed coord_handoff reply: the server's shape, signed and stored."""
    packet = {
        "handoff_id": "hof_x",
        "graph_id": GID,
        "node_id": "n1",
        "signature": {"alg": "hmac-sha256", "key_id": "k1", "signed_at": "t", "value": "ab" * 32},
    }
    packet.update(packet_overrides)
    return {
        "packet": packet,
        "signed": packet["signature"] is not None,
        "stored": True,
        "event": {"id": "evt_hof_x", "ts": "2026-10-13T00:00:00.000Z", "hash": "cd" * 32, "prev": None},
        "gaps": [],
    }


class RecordingMcp:
    """Records every tool call; ``answers`` maps a tool to a reply or the exception it raises.

    Unanswered tools get the server's real shape — a clean drift report for
    ``coord_drift_scan``, a stored signed reply for ``coord_handoff`` — so the
    happy path exercises real replies rather than a stand-in. An explicit
    ``default`` still overrides every unanswered tool.
    """

    def __init__(
        self,
        answers: dict[str, dict | str | Exception] | None = None,
        default: dict | None = None,
    ):
        self.answers = answers or {}
        self.default = default
        self.defaults = {
            "coord_drift_scan": {"ok": True, "findings": []},
            "coord_handoff": packet_reply(),
        }
        self.calls: list[tuple[str, dict]] = []
        self.events: list[tuple[str, dict]] = []

    def call(self, tool: str, arguments: dict):
        self.calls.append((tool, arguments))
        if tool == "events_emit":
            self.events.append((tool, arguments))
            answer = self.answers.get(tool)
            if isinstance(answer, Exception):
                raise answer
            return answer if answer is not None else {"stored": True}
        if tool in self.answers:
            answer = self.answers[tool]
        elif self.default is not None:
            answer = self.default
        else:
            answer = self.defaults.get(tool)
        if isinstance(answer, Exception):
            raise answer
        return answer


class FakeSubstrate:
    """The ledger side: coord_handoff stores a signed packet, coord_handoff_list replays them."""

    def __init__(self, *, signed: bool = True, drift: dict | None = None):
        self.signed = signed
        self.drift = drift if drift is not None else {"ok": True, "findings": []}
        self.packets: list[dict] = []
        self.calls: list[tuple[str, dict]] = []

    def call(self, tool: str, arguments: dict):
        self.calls.append((tool, arguments))
        if tool == "coord_drift_scan":
            return self.drift
        if tool == "coord_handoff":
            packet = {
                "version": 1,
                "handoff_id": f"hof_{len(self.packets):032x}",
                "ts": "2026-10-13T00:00:00.000Z",
                "from": {"surface": "substrate", "session_id": None},
                "to": {"surface": arguments["to"], "session_id": None},
                "graph_id": arguments.get("graph_id"),
                "node_id": arguments.get("node_id"),
                "linear_identifier": arguments.get("linear_identifier"),
                "repo": arguments.get("repo"),
                "branch": arguments.get("branch"),
                "goal": arguments["goal"],
                "files": arguments.get("files") or [],
                "dod": arguments.get("dod") or [],
                "blockers": arguments.get("blockers") or [],
                "prev_event_hash": None,
                "lease_handover": False,
                "notes": None,
                "signature": (
                    None
                    if not self.signed
                    else {
                        "alg": "hmac-sha256", "key_id": "k1",
                        "signed_at": "2026-10-13T00:00:00.000Z", "value": "ab" * 32,
                    }
                ),
            }
            self.packets.append(packet)
            return {
                "packet": packet,
                "signed": self.signed,
                "stored": True,
                "event": {
                    "id": f"evt_{len(self.packets):032x}",
                    "ts": packet["ts"],
                    "hash": "cd" * 32,
                    "prev": None,
                },
                "gaps": [],
            }
        if tool == "events_emit":
            return {"stored": True}
        if tool == "coord_handoff_list":
            return [
                {
                    "event_id": f"evt_{i}",
                    "ts": packet["ts"],
                    "packet": packet,
                    "verdict": {"ok": self.signed, "key_id": "k1"} if self.signed
                    else {"ok": False, "reason": "unsigned"},
                }
                for i, packet in enumerate(self.packets)
                if packet["graph_id"] == arguments["graph_id"]
            ]
        raise AssertionError(f"unexpected tool {tool}")


def quiet(_line: str) -> None:
    pass


# --- the packet: pointers and DoD, never issue prose ----------------------------------------


def test_packet_arguments_exact_shape():
    assert handoff.packet_arguments(**IDS) == {
        "to": "hermes",
        "goal": (
            f"dispatch SWC-1: do the work Linear records for node {GID}/n1 in {REPO} on branch main; "
            "the task text is fetched at run time with issue_get, never carried here"
        ),
        "files": [WT],
        "dod": DOD,
        "blockers": [],
        "graph_id": GID,
        "node_id": "n1",
        "linear_identifier": "SWC-1",
        "repo": REPO,
        "branch": "main",
    }


def test_packet_arguments_omit_branch_when_the_graph_names_none():
    args = handoff.packet_arguments(**{**IDS, "branch": None})
    assert "branch" not in args
    assert "branch None" in args["goal"]


def test_packet_carries_no_issue_prose_even_when_the_caller_holds_some():
    # DISP-07: the packet carries pointers and DoD only. The composer has no
    # issue-text parameter at all — the strongest shape guarantee available.
    assert set(inspect.signature(handoff.packet_arguments).parameters) == {
        "identifier", "graph_id", "node_id", "repo", "branch", "worktree", "surface",
    }
    blob = json.dumps(handoff.packet_arguments(**IDS))
    assert "Secret Feature Title" not in blob


# --- pre-launch: drift scan, then the packet post -------------------------------------------


def test_prelaunch_scans_drift_then_posts_the_packet_before_any_launch():
    mcp = RecordingMcp()
    handoff.prelaunch(mcp, log=quiet, **IDS)
    assert mcp.calls == [
        ("coord_drift_scan", {"repo": REPO, "path": WT, "branch": "main"}),
        ("coord_handoff", handoff.packet_arguments(**IDS)),
    ]
    assert mcp.events == []


def test_drift_finding_records_one_dispatch_handoff_drift_warning():
    mcp = RecordingMcp(
        answers={"coord_handoff": packet_reply()},
        default={
            "ok": False,
            "findings": [{
                "kind": "git.tip_unlogged", "severity": "warn",
                "detail": "git is at abc1234 and no commit event names it",
                "graph_id": GID, "node_id": "n1", "evidence": {"git_tip": "a" * 40},
            }],
        },
    )
    handoff.prelaunch(mcp, log=quiet, **IDS)
    assert [tool for tool, _ in mcp.calls] == ["coord_drift_scan", "events_emit", "coord_handoff"]
    assert len(mcp.events) == 1
    tool, args = mcp.events[0]
    assert tool == "events_emit"
    assert args["kind"] == "warning" and args["surface"] == "substrate"
    assert args["graph_id"] == GID and args["node_id"] == "n1" and args["linear_identifier"] == "SWC-1"
    assert args["payload"]["action"] == "dispatch.handoff"
    assert args["payload"]["status"] == "drift"
    assert args["payload"]["findings"] == [{
        "kind": "git.tip_unlogged", "severity": "warn",
        "detail": "git is at abc1234 and no commit event names it",
        "graph_id": GID, "node_id": "n1",
    }]


def test_drift_scan_failure_is_fail_open_and_the_packet_still_posts():
    mcp = RecordingMcp(answers={"coord_drift_scan": RuntimeError("substrate down")})
    lines: list[str] = []
    handoff.prelaunch(mcp, log=lines.append, **IDS)
    assert [tool for tool, _ in mcp.calls] == ["coord_drift_scan", "coord_handoff"]
    assert mcp.events == []
    assert any("coord_drift_scan failed" in line and "launching anyway" in line for line in lines)


def test_malformed_drift_report_is_fail_open_too():
    mcp = RecordingMcp(default={"ok": True}, answers={"coord_handoff": packet_reply()})
    handoff.prelaunch(mcp, log=quiet, **IDS)
    assert [tool for tool, _ in mcp.calls] == ["coord_drift_scan", "coord_handoff"]
    assert mcp.events == []


# --- the post: unsigned fallback and failure are warnings, never blockers --------------------


def test_unsigned_reply_records_one_unsigned_warning():
    reply = packet_reply(signature=None)
    reply["gaps"] = ["DoD"]
    mcp = RecordingMcp(answers={"coord_handoff": reply})
    handoff.prelaunch(mcp, log=quiet, **IDS)
    assert len(mcp.events) == 1
    _, args = mcp.events[0]
    assert args["payload"]["action"] == "dispatch.handoff"
    assert args["payload"]["status"] == "unsigned"
    assert args["payload"]["gaps"] == ["DoD"]
    assert "findings" not in args["payload"] and "reason" not in args["payload"]


def test_post_failure_records_failed_warning_and_does_not_raise():
    mcp = RecordingMcp(answers={"coord_handoff": RuntimeError("HTTP 503: coord_handoff refused")})
    lines: list[str] = []
    handoff.prelaunch(mcp, log=lines.append, **IDS)  # must not raise
    assert len(mcp.events) == 1
    _, args = mcp.events[0]
    assert args["payload"]["action"] == "dispatch.handoff"
    assert args["payload"]["status"] == "failed"
    assert "HTTP 503" in args["payload"]["reason"]
    assert any("coord_handoff failed" in line and "launching anyway" in line for line in lines)


def test_unstored_reply_records_failed_warning():
    # The ledger took the call but refused the event: the server answers
    # ``stored: false`` with an ``error``, not an exception.
    reply = packet_reply()
    reply["stored"] = False
    reply["error"] = "the ledger refused the event"
    mcp = RecordingMcp(answers={"coord_handoff": reply})
    handoff.prelaunch(mcp, log=quiet, **IDS)
    assert len(mcp.events) == 1
    _, args = mcp.events[0]
    assert args["payload"]["action"] == "dispatch.handoff"
    assert args["payload"]["status"] == "failed"
    assert "the ledger refused the event" in args["payload"]["reason"]


def test_unexpected_handoff_reply_records_failed_warning():
    mcp = RecordingMcp(answers={"coord_handoff": "not a reply"})
    handoff.prelaunch(mcp, log=quiet, **IDS)
    assert mcp.events[0][1]["payload"]["status"] == "failed"
    assert "unexpected reply" in mcp.events[0][1]["payload"]["reason"]


def test_warning_emission_failure_never_stops_the_post():
    # The drift warning's own emit is refused; the packet still posts (D24-12 spirit).
    mcp = RecordingMcp(
        answers={
            "coord_drift_scan": {
                "ok": False,
                "findings": [{"kind": "lease.idle", "severity": "warn", "detail": "idle"}],
            },
            "coord_handoff": packet_reply(),
            "events_emit": RuntimeError("emit refused"),
        },
    )
    lines: list[str] = []
    handoff.prelaunch(mcp, log=lines.append, **IDS)
    assert [tool for tool, _ in mcp.calls] == ["coord_drift_scan", "events_emit", "coord_handoff"]
    assert any("events_emit failed" in line for line in lines)


# --- replay: the ledger alone rebuilds the dispatch context ----------------------------------


def test_kill_after_post_replay_rebuilds_the_dispatch_context_from_the_ledger():
    ledger = FakeSubstrate()
    order: list[str] = []

    def launch(**_kwargs):
        order.append("launch")
        raise RuntimeError("killed after the packet was posted")

    fn = make_launch_fn(
        log=lambda line: order.append(f"log:{line[:30]}"),
        checkout=lambda _repo: (order.append("checkout"), Path("/root/src/repos/agent-substrate"))[1],
        ensure=lambda _repo, _gid, _branch: (order.append("ensure"), Path(WT))[1],
        launch=launch,
        prelaunch=handoff.make_prelaunch(ledger),
    )
    with pytest.raises(RuntimeError, match="killed after the packet"):
        fn(cand(), FOUND)
    # The process never started, but the packet was already durable in the ledger.
    assert ledger.calls == [
        ("coord_drift_scan", {"repo": REPO, "path": WT, "branch": "main"}),
        ("coord_handoff", handoff.packet_arguments(**IDS)),
    ]

    # A fresh replay read — nothing but the ledger — rebuilds the same context.
    contexts = handoff.replay(ledger, GID, node_id="n1")
    assert len(contexts) == 1
    ctx = contexts[0]
    assert ctx["goal"] == handoff.goal_line(
        identifier="SWC-1", graph_id=GID, node_id="n1", repo=REPO, branch="main",
    )
    assert ctx["dod"] == DOD
    assert ctx["files"] == [WT]
    assert ctx["graph_id"] == GID and ctx["node_id"] == "n1"
    assert ctx["linear_identifier"] == "SWC-1"
    assert ctx["repo"] == REPO and ctx["branch"] == "main"
    assert ctx["signed"] is True
    # And the replayed context carries pointers and DoD, never issue prose.
    assert "Secret Feature Title" not in json.dumps(ctx)
    assert order[0] == "checkout" and order[1] == "ensure"


def test_replay_returns_newest_first_and_filters_by_node():
    ledger = FakeSubstrate()
    mcp = handoff.make_prelaunch(ledger)
    mcp(identifier="SWC-1", graph_id=GID, node_id="n1", repo=REPO, branch="main",
        worktree=WT, surface="hermes", log=quiet)
    mcp(identifier="SWC-2", graph_id=GID, node_id="n2", repo=REPO, branch="main",
        worktree=WT + "-2", surface="hermes", log=quiet)
    contexts = handoff.replay(ledger, GID)
    assert [ctx["node_id"] for ctx in contexts] == ["n2", "n1"]
    assert [ctx["linear_identifier"] for ctx in contexts] == ["SWC-2", "SWC-1"]
    assert [ctx["node_id"] for ctx in handoff.replay(ledger, GID, node_id="n2")] == ["n2"]
    assert handoff.replay(ledger, "ut-other", node_id="n1") == []


def test_replay_of_an_unsigned_packet_reports_it_unsigned():
    ledger = FakeSubstrate(signed=False)
    handoff.make_prelaunch(ledger)(
        identifier="SWC-1", graph_id=GID, node_id="n1", repo=REPO, branch="main",
        worktree=WT, surface="hermes", log=quiet,
    )
    ctx = handoff.replay(ledger, GID)[0]
    assert ctx["signed"] is False


def test_context_from_packet_tolerates_a_legacy_packet():
    ctx = handoff.context_from_packet({"goal": "take over", "signature": None})
    assert ctx["goal"] == "take over"
    assert ctx["dod"] == [] and ctx["files"] == []
    assert ctx["graph_id"] is None and ctx["signed"] is False


def test_goal_line_is_ids_and_pointers_only():
    line = handoff.goal_line(identifier="SWC-1", graph_id=GID, node_id="n1", repo=REPO, branch="main")
    assert "SWC-1" in line and GID in line and "issue_get" in line
    assert "Secret Feature Title" not in line
