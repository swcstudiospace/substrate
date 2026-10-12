"""The U4 storm-breaker: quota-burn SLOs refuse launches before any session starts."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from substrate_dispatcher.dispatch import COMMENT_PREFIX, MARKERS, tick
from substrate_dispatcher.launcher import Launched
from substrate_dispatcher.linear import Candidate
from substrate_dispatcher.quota import (
    BURN_COST_ID,
    BURN_TOKENS_ID,
    SloUnreachable,
    burn_breaches,
    fetch_slo_snapshot,
    make_slo_fetcher,
    slo_url,
)
from substrate_dispatcher.sessions import SessionRegistry


def stormbreak_emits(mcp) -> list:
    """The launch-success `dispatched … launched` note is normal; only a
    storm-break event means the breaker refused, so fail-open tests assert its
    absence rather than an empty emit log."""
    return [item for item in mcp.emits if item[1].get("payload", {}).get("action") == "dispatch.stormbreak"]

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
    """Popen stand-in good enough for a registry add."""

    def __init__(self, pid: int = 4242):
        self.pid = pid

    def poll(self) -> int | None:
        return None

    def terminate(self) -> None:
        return None

    def kill(self) -> None:
        return None


def launched(pid: int = 4242) -> Launched:
    return Launched(
        pid=pid, proc=FakeProc(pid), prompt_path=Path("/s/p.md"), log_path=Path("/s/l.log"),
        started_at=0.0,
    )


class FakeLinear:
    """Records every call, comments included; the registry of what a tick touched."""

    def __init__(self, candidates: list[Candidate]):
        self.candidates = candidates
        self.comments: dict[str, list[str]] = {}
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


class EventMcp:
    """graph_find with the events_emit surface _emit talks to; every call is recorded."""

    def __init__(self, found: dict = FOUND):
        self.found = found
        self.finds: list[str] = []
        self.emits: list[tuple[str, dict]] = []

    def graph_find(self, *, linear_issue_id: str) -> dict:
        self.finds.append(linear_issue_id)
        return self.found

    def call(self, tool: str, arguments: dict) -> dict:
        self.emits.append((tool, arguments))
        return {"stored": True}


class RecordingLaunch:
    def __init__(self):
        self.calls: list[tuple[Candidate, dict]] = []

    def __call__(self, candidate: Candidate, found: dict) -> Launched:
        self.calls.append((candidate, found))
        return launched(1000 + len(self.calls))


class FakeSlo:
    """A /slo snapshot fetcher: answers ``payload``, or raises ``raises``."""

    def __init__(self, payload: dict | None = None, raises: Exception | None = None):
        self.payload = payload
        self.raises = raises
        self.calls = 0

    def __call__(self) -> dict:
        self.calls += 1
        if self.raises is not None:
            raise self.raises
        assert self.payload is not None
        return self.payload


def burn_entry(slo_id: str, status: str) -> dict:
    return {"id": slo_id, "status": status, "statement": f"sum ... <= ceiling ({slo_id})"}


def slo_snapshot(tokens: str = "ok", cost: str = "ok") -> dict:
    return {
        "results": [{"id": "brief.p95", "status": "insufficient-data"}],
        "breached": [],
        "burn": [burn_entry(BURN_TOKENS_ID, tokens), burn_entry(BURN_COST_ID, cost)],
    }


@pytest.fixture
def env_file(tmp_path: Path) -> Path:
    path = tmp_path / "substrate.env"
    path.write_text("LINEAR_API_KEY=secret\n")
    return path


def run_tick(linear, mcp, *, env_file, slo=None, environ=None, registry=None):
    lines: list[str] = []
    registry = registry if registry is not None else SessionRegistry()
    launch_fn = RecordingLaunch()
    decisions = tick(
        linear=linear, mcp=mcp, registry=registry, launch_fn=launch_fn, env_file=env_file,
        environ=environ or {}, dry_run=False, log=lines.append, slo=slo,
    )
    return decisions, lines, launch_fn, registry


# --- (a) a breaching token SLO refuses the launch ------------------------------------------


def test_breaching_token_slo_refuses_with_one_marker_one_event_and_no_launch(env_file):
    linear, mcp = FakeLinear([cand()]), EventMcp()
    slo = FakeSlo(slo_snapshot(tokens="breached"))
    decisions, lines, launch_fn, registry = run_tick(linear, mcp, env_file=env_file, slo=slo)

    assert launch_fn.calls == [] and mcp.finds == ["i-1"]
    assert [d.action for d in decisions] == ["launch"]  # the table decided; the breaker refused
    bodies = linear.comments["i-1"]
    assert len(bodies) == 1
    assert bodies[0].startswith(COMMENT_PREFIX) and "[quota-burn]" in bodies[0]
    assert "burn.tokens" in bodies[0]
    assert bodies[0] == COMMENT_PREFIX + " [quota-burn] " + MARKERS["quota-burn"].format(slo=BURN_TOKENS_ID)
    # One warning event naming the breached SLO; the issue's labels are untouched.
    assert len(mcp.emits) == 1
    tool, arguments = mcp.emits[0]
    assert tool == "events_emit"
    assert arguments["kind"] == "warning" and arguments["surface"] == "substrate"
    assert arguments["linear_identifier"] == "SWC-1"
    assert arguments["payload"]["action"] == "dispatch.stormbreak"
    assert arguments["payload"]["slo"] == BURN_TOKENS_ID
    assert arguments["payload"]["breached"] == [BURN_TOKENS_ID]
    assert linear.named("remove_label") == []
    assert registry.active_issue_ids() == set()
    # And the verdict was read exactly once for the tick.
    assert slo.calls == 1
    assert any("quota-burn" in line and "burn.tokens" in line for line in lines)


def test_token_breach_stays_once_only_while_breaching(env_file):
    linear, mcp = FakeLinear([cand()]), EventMcp()
    slo = FakeSlo(slo_snapshot(tokens="breached"))
    run_tick(linear, mcp, env_file=env_file, slo=slo)

    # A second tick against the same breaching snapshot: the tag is already on the
    # issue, so no second comment, no second event — and still no launch.
    launch_fn = RecordingLaunch()
    tick(
        linear=linear, mcp=mcp, registry=SessionRegistry(), launch_fn=launch_fn,
        env_file=env_file, environ={}, dry_run=False, log=lambda _line: None, slo=slo,
    )

    assert launch_fn.calls == []
    assert len(linear.comments["i-1"]) == 1
    assert len(mcp.emits) == 1


# --- (b) a breaching cost SLO refuses the same way ------------------------------------------


def test_breaching_cost_slo_refuses_with_one_marker_one_event_and_no_launch(env_file):
    linear, mcp = FakeLinear([cand()]), EventMcp()
    decisions, lines, launch_fn, _ = run_tick(
        linear, mcp, env_file=env_file, slo=FakeSlo(slo_snapshot(cost="breached"))
    )

    assert launch_fn.calls == []
    body = linear.comments["i-1"][0]
    assert "[quota-burn]" in body and "burn.cost_usd" in body
    assert body == COMMENT_PREFIX + " [quota-burn] " + MARKERS["quota-burn"].format(slo=BURN_COST_ID)
    _, arguments = mcp.emits[0]
    assert arguments["payload"]["action"] == "dispatch.stormbreak"
    assert arguments["payload"]["slo"] == BURN_COST_ID
    assert arguments["payload"]["breached"] == [BURN_COST_ID]
    assert linear.named("remove_label") == []


def test_both_breaching_names_the_first_and_records_both(env_file):
    linear, mcp = FakeLinear([cand()]), EventMcp()
    run_tick(linear, mcp, env_file=env_file, slo=FakeSlo(slo_snapshot(tokens="breached", cost="breached")))

    _, arguments = mcp.emits[0]
    assert arguments["payload"]["slo"] == BURN_TOKENS_ID
    assert arguments["payload"]["breached"] == [BURN_TOKENS_ID, BURN_COST_ID]
    assert "burn.tokens" in linear.comments["i-1"][0]


# --- (c) the override switch launches --------------------------------------------------------


def test_stormbreak_disabled_launches_and_never_reads_the_snapshot(env_file):
    env_file.write_text("LINEAR_API_KEY=secret\nSUBSTRATE_STORMBREAK_DISABLED=1\n")
    linear, mcp = FakeLinear([cand()]), EventMcp()
    slo = FakeSlo(slo_snapshot(tokens="breached", cost="breached"))
    decisions, lines, launch_fn, registry = run_tick(linear, mcp, env_file=env_file, slo=slo)

    assert len(launch_fn.calls) == 1 and registry.active_issue_ids() == {"i-1"}
    assert linear.comments == {} and not stormbreak_emits(mcp)
    assert slo.calls == 0
    assert "storm-breaker disabled (SUBSTRATE_STORMBREAK_DISABLED=1)" in lines


def test_override_in_process_env_applies_when_env_file_lacks_the_key(env_file):
    linear, mcp = FakeLinear([cand()]), EventMcp()
    decisions, lines, launch_fn, _ = run_tick(
        linear, mcp, env_file=env_file, slo=FakeSlo(slo_snapshot(tokens="breached")),
        environ={"SUBSTRATE_STORMBREAK_DISABLED": "1"},
    )

    assert len(launch_fn.calls) == 1 and not stormbreak_emits(mcp)


def test_override_line_read_with_quotes_like_the_d15_switch(env_file):
    env_file.write_text("SUBSTRATE_STORMBREAK_DISABLED='1'\n")
    linear, mcp = FakeLinear([cand()]), EventMcp()
    _, _, launch_fn, _ = run_tick(linear, mcp, env_file=env_file, slo=FakeSlo(slo_snapshot(tokens="breached")))

    assert len(launch_fn.calls) == 1 and not stormbreak_emits(mcp)


def test_env_file_value_wins_over_process_env(env_file):
    env_file.write_text("SUBSTRATE_STORMBREAK_DISABLED=0\n")
    linear, mcp = FakeLinear([cand()]), EventMcp()
    _, lines, launch_fn, _ = run_tick(
        linear, mcp, env_file=env_file, slo=FakeSlo(slo_snapshot(tokens="breached")),
        environ={"SUBSTRATE_STORMBREAK_DISABLED": "1"},
    )

    assert launch_fn.calls == [] and mcp.emits != []


# --- (d) an unreachable snapshot fails open --------------------------------------------------


def test_unreachable_snapshot_fails_open_and_launches(env_file):
    linear, mcp = FakeLinear([cand()]), EventMcp()
    decisions, lines, launch_fn, registry = run_tick(
        linear, mcp, env_file=env_file, slo=FakeSlo(raises=SloUnreachable("getsockopt: connection refused"))
    )

    assert len(launch_fn.calls) == 1 and registry.active_issue_ids() == {"i-1"}
    assert linear.comments == {} and not stormbreak_emits(mcp)
    assert any("fails open" in line for line in lines)


def test_malformed_snapshot_fails_open_and_launches(env_file):
    linear, mcp = FakeLinear([cand()]), EventMcp()
    _, lines, launch_fn, _ = run_tick(linear, mcp, env_file=env_file, slo=FakeSlo({"burn": "breached"}))

    assert len(launch_fn.calls) == 1 and not stormbreak_emits(mcp)


# --- (e) unset thresholds never breach --------------------------------------------------------


def test_unconfigured_burn_slos_never_breach(env_file):
    linear, mcp = FakeLinear([cand()]), EventMcp()
    _, lines, launch_fn, _ = run_tick(
        linear, mcp, env_file=env_file,
        slo=FakeSlo(slo_snapshot(tokens="unconfigured", cost="unconfigured")),
    )

    assert len(launch_fn.calls) == 1
    assert linear.comments == {} and not stormbreak_emits(mcp)
    assert not any("quota-burn" in line for line in lines)


def test_missing_burn_array_launches(env_file):
    """A substrate predating the burn array stands the breaker down rather than tripping it."""
    linear, mcp = FakeLinear([cand()]), EventMcp()
    _, _, launch_fn, _ = run_tick(linear, mcp, env_file=env_file, slo=FakeSlo({"results": [], "breached": []}))

    assert len(launch_fn.calls) == 1 and not stormbreak_emits(mcp)


def test_burn_verdict_is_read_once_per_tick_for_many_candidates(env_file):
    candidates = [cand(issue_id="i-1", identifier="SWC-1"), cand(issue_id="i-2", identifier="SWC-2")]
    linear, mcp = FakeLinear(candidates), EventMcp()
    slo = FakeSlo(slo_snapshot(tokens="breached"))
    _, _, launch_fn, _ = run_tick(linear, mcp, env_file=env_file, slo=slo)

    assert slo.calls == 1
    assert launch_fn.calls == []
    # Both issues got their marker, one each — each issue's comment is once-only on its own.
    assert len(linear.comments["i-1"]) == 1 and len(linear.comments["i-2"]) == 1


# --- quota.py units ---------------------------------------------------------------------------


def test_slo_url_maps_the_mcp_origin():
    assert slo_url("http://127.0.0.1:7410/mcp") == "http://127.0.0.1:7410/slo"
    assert slo_url("http://substrate.internal:7410/mcp/") == "http://substrate.internal:7410/slo"


def test_burn_breaches_reads_only_burn_entries():
    snapshot = {
        "results": [{"id": "brief.p95", "status": "breached"}],
        "breached": ["brief.p95"],
        "burn": [burn_entry(BURN_TOKENS_ID, "ok"), burn_entry(BURN_COST_ID, "breached")],
    }
    assert burn_breaches(snapshot) == [BURN_COST_ID]


@pytest.mark.parametrize(
    "snapshot",
    [
        {},
        {"burn": None},
        {"burn": "breached"},
        {"burn": [None, 7, {"id": "other.slo", "status": "breached"}]},
        {"burn": [{"id": BURN_TOKENS_ID, "status": "BREACHED"}]},
    ],
)
def test_burn_breaches_answers_empty_on_every_malformed_shape(snapshot):
    assert burn_breaches(snapshot) == []


def test_fetch_slo_snapshot_parses_and_authenticates():
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("Authorization", "")
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"results": [], "breached": [], "burn": []})

    snapshot = fetch_slo_snapshot(
        "http://mcp.test/slo", bearer="tok-substrate", transport=httpx.MockTransport(handler)
    )

    assert snapshot == {"results": [], "breached": [], "burn": []}
    assert seen["url"] == "http://mcp.test/slo"
    assert seen["auth"] == "Bearer tok-substrate"


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(503, text="down"),
        httpx.Response(200, text="<html>not json</html>"),
        httpx.Response(200, json=["a", "list"]),
    ],
)
def test_fetch_slo_snapshot_raises_on_bad_replies(response):
    with pytest.raises(SloUnreachable):
        fetch_slo_snapshot("http://mcp.test/slo", transport=httpx.MockTransport(lambda _request: response))


def test_fetch_slo_snapshot_raises_when_unreachable():
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    with pytest.raises(SloUnreachable):
        fetch_slo_snapshot("http://mcp.test/slo", transport=httpx.MockTransport(handler))


def test_make_slo_fetcher_uses_the_mcp_client_config():
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("Authorization", "")
        return httpx.Response(200, content=json.dumps({"burn": []}).encode())

    fetch = make_slo_fetcher(
        environ={"SUBSTRATE_MCP_URL": "http://mcp.test/mcp", "SUBSTRATE_TOKEN_SUBSTRATE": "tok-substrate"},
        transport=httpx.MockTransport(handler),
    )
    assert fetch() == {"burn": []}
    assert seen["url"] == "http://mcp.test/slo"
    assert seen["auth"] == "Bearer tok-substrate"
