"""One dispatcher tick: poll Linear, resolve each candidate's node, decide, launch.

D-10: a tick polls Linear for unstarted issues carrying a ``dispatch:*`` label and resolves each
dispatchable candidate through substrate-mcp ``graph_find`` before any launch decision.
D-11 / D-06: ``dispatch:hermes`` launches a Hermes chat; ``dispatch:claude-code`` opens a VM task
on substrate-host (host.HostClient) and is watched through the same registry contract.
D-14: at most 2 dispatched sessions, one per issue; an issue the registry gave up on is never
relaunched (sessions.SessionRegistry).
D-15: ``SUBSTRATE_DISPATCH_DISABLED=1`` in the live env file stops every tick before any call.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal, Mapping

from . import launcher, sessions, worktree
from .host import HostRefused
from .launcher import Launched
from .linear import Candidate
from .worktree import WorktreeRefused

EVENT_RETRYABLE_MARKERS = frozenset({"host-unreachable"})
# Rows registered for this phase (Phase 17, event-sources.ts): a launch lands on
# ``dispatch.outcome`` (kind note), each terminal non-dispatch and give-up on
# ``dispatch.failed`` (kind warning). Transient states emit nothing.

DISPATCHABLE_SURFACES = frozenset({"hermes", "claude-code"})
COMMENT_PREFIX = "substrate-dispatcher:"
DISABLE_KEY = "SUBSTRATE_DISPATCH_DISABLED"
# Once-only comment texts by marker; every body starts with COMMENT_PREFIX and carries the stable
# tag "[<marker>]", which tick looks for in the issue's last 50 comments before posting.
MARKERS: dict[str, str] = {
    "not-dispatchable": "surface not dispatchable yet — this dispatcher starts dispatch:hermes and dispatch:claude-code only",
    "no-node": "no registered substrate graph node for this issue; register it with graph_register first",
    "already-claimed": "node already claimed by {holder}; not dispatching",
    "invalid-graph-id": "the graph id is not a safe worktree name; not dispatching",
    "invalid-ids": "the issue identifier, node id, graph id or repo is not a safe prompt value; not dispatching, not retrying",
    "no-checkout": "no verified checkout of the graph's repo on this host; not dispatching",
    "low-disk": "under 5 GB free on /; no worktree created, not dispatching",
    "path-conflict": "the worktree path is taken by something git does not track as this graph's worktree; not dispatching",
    "git-failed": "git could not prepare the worktree; not dispatching",
    "host-refused": "substrate-host refused the task; not dispatching",
    "host-unreachable": "substrate-host is not reachable; will retry on a later tick",
    "exited-unclaimed": "hermes session exited (code {code}) without claiming the node — removed the dispatch label; not retrying",
    "claim-timeout": "no claim within 15 minutes — removed the dispatch label; not retrying",
}

LaunchFn = Callable[[Candidate, dict], Launched]
Log = Callable[[str], None]


class InvalidIds(ValueError):
    """The ids launcher.render_prompt would reject; raised before any checkout or worktree."""


@dataclass(frozen=True)
class Decision:
    action: Literal["launch", "comment", "skip"]
    candidate: Candidate
    reason: str
    marker: str | None = None
    found: dict | None = None


def dispatch_disabled(env_file: Path, environ: Mapping[str, str]) -> bool:
    """D-15 kill switch: the last ``SUBSTRATE_DISPATCH_DISABLED=`` line in env_file decides.

    An appended line flips the switch without rewriting the secrets file. When the file lacks the
    key or cannot be read, the process environment decides. No other line is ever logged.
    """
    value: str | None = None
    try:
        with open(env_file, encoding="utf-8") as fh:
            for line in fh:
                stripped = line.strip()
                if stripped.startswith(DISABLE_KEY + "="):
                    value = stripped[len(DISABLE_KEY) + 1:]
    except OSError:
        value = None
    if value is None:
        value = environ.get(DISABLE_KEY, "")
    return value.strip().strip("'\"") == "1"


def tag(marker: str) -> str:
    return f"[{marker}]"


def comment_body(marker: str, **fields: str) -> str:
    return f"{COMMENT_PREFIX} {tag(marker)} {MARKERS[marker].format(**fields)}"


def _emit(mcp: Any, arguments: dict[str, Any], log: Log) -> None:
    """One ``events_emit`` call, fail-open: a refused emit never blocks the tick (D24-12)."""
    call = getattr(mcp, "call", None)
    if call is None:
        return
    try:
        call("events_emit", arguments)
    except Exception as exc:  # noqa: BLE001 - emission is observability, not the decision
        log(f"events_emit failed: {type(exc).__name__}: {exc}")


def emit_launched(mcp: Any, *, graph_id: str, node_id: str, identifier: str, log: Log) -> None:
    """A launch decision on the ``dispatch.outcome`` row (kind note, surface substrate)."""
    _emit(
        mcp,
        {
            "kind": "note",
            "summary": f"dispatched {graph_id}: launched",
            "surface": "substrate",
            "session_id": f"dispatch:{graph_id}:{node_id}",
            "graph_id": graph_id,
            "node_id": node_id,
            "linear_identifier": identifier,
            "payload": {
                "action": "dispatch",
                "runtime": "dispatcher",
                "outcome": "launched",
                "graph_id": graph_id,
                "node_id": node_id,
            },
        },
        log,
    )


def emit_failed(
    mcp: Any, *, graph_id: str, node_id: str, identifier: str, reason: str, log: Log
) -> None:
    """A terminal non-dispatch or give-up on the ``dispatch.failed`` row (kind warning)."""
    arguments: dict[str, Any] = {
        "kind": "warning",
        "summary": f"dispatch failed for {graph_id or identifier}: {reason}",
        "surface": "substrate",
        "session_id": f"dispatch:{graph_id or identifier}:{node_id or 'none'}",
        "linear_identifier": identifier,
        "payload": {
            "action": "dispatch",
            "runtime": "dispatcher",
            "outcome": "failed",
            "reason": reason,
        },
    }
    if graph_id:
        arguments["graph_id"] = graph_id
        arguments["payload"]["graph_id"] = graph_id
    if node_id:
        arguments["node_id"] = node_id
        arguments["payload"]["node_id"] = node_id
    _emit(mcp, arguments, log)


def decide(
    candidate: Candidate,
    *,
    found: dict | None,
    active_issue_ids: set[str],
    capacity_left: int,
    given_up: set[str] | frozenset[str] = frozenset(),
) -> Decision:
    if candidate.surface not in DISPATCHABLE_SURFACES:
        return Decision(
            "comment", candidate, f"surface {candidate.surface} not dispatchable",
            marker="not-dispatchable",
        )
    if candidate.issue_id in given_up:
        return Decision("skip", candidate, "gave up on this issue (no claim); not relaunching")
    if candidate.issue_id in active_issue_ids:
        return Decision("skip", candidate, "session already running for this issue")
    if not found or not found.get("found"):
        reason = (found or {}).get("reason") or "no registered node"
        return Decision("comment", candidate, f"no node: {reason}", marker="no-node", found=found)
    holder = (found.get("node") or {}).get("claimed_by")
    if holder:
        return Decision(
            "comment", candidate, f"node already claimed by {holder}",
            marker="already-claimed", found=found,
        )
    if capacity_left <= 0:
        return Decision("skip", candidate, "at capacity", found=found)
    return Decision(
        "launch", candidate, f"graph {found.get('graph_id')} node {found.get('node_id')}", found=found
    )


def tick(
    *,
    linear: Any,
    mcp: Any,
    registry: sessions.SessionRegistry,
    launch_fn: LaunchFn,
    env_file: Path,
    environ: Mapping[str, str],
    dry_run: bool,
    log: Log,
) -> list[Decision]:
    """Run one poll → resolve → decide → act pass; per-candidate errors never stop the tick."""
    if dispatch_disabled(env_file, environ):
        log(f"dispatch disabled ({DISABLE_KEY}=1)")
        return []
    candidates = linear.dispatch_candidates()
    log(f"tick: {len(candidates)} candidate issue(s)")
    decisions: list[Decision] = []
    for candidate in candidates:
        try:
            found = None
            active = registry.active_issue_ids()
            if (
                candidate.surface in DISPATCHABLE_SURFACES
                and candidate.issue_id not in active
                and candidate.issue_id not in registry.given_up
            ):
                found = mcp.graph_find(linear_issue_id=candidate.issue_id)
            decision = decide(
                candidate, found=found, active_issue_ids=active,
                capacity_left=registry.capacity_left(), given_up=registry.given_up,
            )
            decisions.append(decision)
            if dry_run:
                log(f"{candidate.identifier} {candidate.dispatch_label} → {decision.action}: {decision.reason}")
                continue
            if decision.action == "comment" and decision.marker:
                holder = ((decision.found or {}).get("node") or {}).get("claimed_by") or ""
                if _comment_once(linear, candidate, decision.marker, holder=str(holder)):
                    _maybe_emit_failed(mcp, candidate, decision.found, decision.marker, log)
            elif decision.action == "launch":
                found = decision.found or {}
                try:
                    bodies = linear.comment_bodies(candidate.issue_id)
                except Exception as exc:  # noqa: BLE001 — decided again next tick
                    log(
                        f"{candidate.identifier}: not launched: comment_bodies failed: "
                        f"{type(exc).__name__}: {exc}"
                    )
                    continue
                try:
                    launched = launch_fn(candidate, found)
                except InvalidIds as invalid:
                    # Ids never change for a registered node, so a retry could only fail again.
                    log(f"{candidate.identifier}: {tag('invalid-ids')} {invalid}; giving up on this issue")
                    if _comment_once(linear, candidate, "invalid-ids"):
                        _maybe_emit_failed(mcp, candidate, found, "invalid-ids", log)
                    registry.give_up(candidate.issue_id)
                    continue
                except WorktreeRefused as refused:
                    log(f"{candidate.identifier}: worktree refused {tag(refused.marker)}: {refused.reason}")
                    if _comment_once(linear, candidate, refused.marker):
                        _maybe_emit_failed(mcp, candidate, found, refused.marker, log)
                    continue
                except HostRefused as refused:
                    log(f"{candidate.identifier}: host refused {tag(refused.marker)}: {refused.reason}")
                    if _comment_once(linear, candidate, refused.marker):
                        _maybe_emit_failed(mcp, candidate, found, refused.marker, log)
                    continue
                registry.add(
                    sessions.Session(
                        issue_id=candidate.issue_id,
                        identifier=candidate.identifier,
                        graph_id=found["graph_id"],
                        node_id=found["node_id"],
                        surface=candidate.surface,
                        dispatch_label_id=candidate.dispatch_label_id,
                        proc=launched.proc,
                        pid=launched.pid,
                        started_at=launched.started_at,
                        log_path=launched.log_path,
                        launch_state=(found.get("node") or {}).get("state"),
                        prior_claim_sessions=frozenset(
                            sessions.claim_comment_sessions(
                                bodies, surface=candidate.surface,
                                graph_id=found["graph_id"], node_id=found["node_id"],
                            )
                        ),
                    )
                )
                emit_launched(
                    mcp, graph_id=found["graph_id"], node_id=found["node_id"],
                    identifier=candidate.identifier, log=log,
                )
        except Exception as exc:  # noqa: BLE001 — one bad candidate never stops the tick
            log(f"{candidate.identifier}: {type(exc).__name__}: {exc}")
    return decisions


def _comment_once(linear: Any, candidate: Candidate, marker: str, **fields: str) -> bool:
    """Post the marker's comment unless one of the issue's last 50 comments carries its tag."""
    if any(tag(marker) in existing for existing in linear.comment_bodies(candidate.issue_id)):
        return False
    linear.comment(candidate.issue_id, comment_body(marker, **fields))
    return True


def _maybe_emit_failed(
    mcp: Any, candidate: Candidate, found: dict | None, marker: str, log: Log
) -> None:
    """A freshly posted marker comment earns its ``dispatch.failed`` event — except retries."""
    if marker in EVENT_RETRYABLE_MARKERS:
        return
    found = found or {}
    emit_failed(
        mcp, graph_id=found.get("graph_id") or "", node_id=found.get("node_id") or "",
        identifier=candidate.identifier, reason=marker, log=log,
    )


def validate_ids(candidate: Candidate, found: dict) -> None:
    """Raise InvalidIds for any id launcher.render_prompt would refuse, using its own patterns."""
    identifier, node_id = candidate.identifier, found.get("node_id")
    graph_id, repo = found.get("graph_id"), found.get("repo")
    if not isinstance(identifier, str) or not launcher.IDENTIFIER_RE.fullmatch(identifier):
        raise InvalidIds(f"invalid Linear identifier {identifier!r}")
    if not isinstance(node_id, str) or not launcher.NODE_ID_RE.fullmatch(node_id):
        raise InvalidIds(f"invalid node id {node_id!r}")
    try:
        worktree.validate_graph_id(graph_id)
    except WorktreeRefused as refused:
        raise InvalidIds(refused.reason) from None
    if not isinstance(repo, str) or not worktree.REPO_SLUG_RE.fullmatch(repo):
        raise InvalidIds(f"invalid repo slug {repo!r}")


def make_launch_fn(
    *,
    log: Log,
    checkout: Callable[..., Path] = worktree.repo_checkout,
    ensure: Callable[..., Path] = worktree.ensure_worktree,
    launch: Callable[..., Launched] = launcher.launch,
    open_task: Callable[..., Launched] | None = None,
    state_dir: Path | None = None,
    hermes_bin: str | None = None,
) -> LaunchFn:
    """Compose D-12 (per-Graph-ID worktree) with D-13 (direct hermes chat) or D-06 (a VM task on
    substrate-host, ``open_task`` = HostClient.launch) for one candidate, by its surface.

    The prompt's ids are validated first, so an id render_prompt would refuse never leaves a
    worktree behind.
    """

    def launch_fn(candidate: Candidate, found: dict) -> Launched:
        validate_ids(candidate, found)
        repo_path = checkout(found["repo"])
        path = ensure(repo_path, found["graph_id"], found["branch"])
        ids = dict(
            identifier=candidate.identifier,
            graph_id=found["graph_id"],
            node_id=found["node_id"],
            repo=found["repo"],
            worktree=path,
        )
        if candidate.surface == "claude-code":
            if open_task is None:
                raise HostRefused("no substrate-host client configured", "host-unreachable")
            launched = open_task(**ids)
            log(
                f"launched claude-code for {candidate.identifier} graph {found['graph_id']} "
                f"node {found['node_id']} task {found['graph_id']}/{found['node_id']} worktree {path}"
            )
            return launched
        extra: dict[str, Any] = {}
        if state_dir is not None:
            extra["state_dir"] = state_dir
        if hermes_bin is not None:
            extra["hermes_bin"] = hermes_bin
        launched = launch(**ids, **extra)
        log(
            f"launched hermes for {candidate.identifier} graph {found['graph_id']} "
            f"node {found['node_id']} pid {launched.pid} worktree {path} log {launched.log_path}"
        )
        return launched

    return launch_fn
