"""One dispatcher tick: poll Linear, resolve each candidate's node, decide, launch.

D-10: a tick polls Linear for unstarted issues carrying a ``dispatch:*`` label and resolves each
dispatchable candidate through substrate-mcp ``graph_find`` before any launch decision.
D-11 / D-06: ``dispatch:hermes`` launches a Hermes chat; ``dispatch:claude-code`` opens a VM task
on substrate-host (host.HostClient) and is watched through the same registry contract.
D-14: at most 2 dispatched sessions, one per issue; an issue the registry gave up on is never
relaunched (sessions.SessionRegistry).
D-15: ``SUBSTRATE_DISPATCH_DISABLED=1`` in the live env file stops every tick before any call.
U4 / SPE-10477: before any launch, one ``/slo`` burn read (quota.py) storm-breaks the tick —
a breaching quota SLO posts the once-only ``[quota-burn]`` marker, emits one
``dispatch.stormbreak`` warning, and launches nothing while it stays breached.
U3 / SPE-10477: inside the launch path, after the worktree exists and before the process
starts, the prelaunch step (handoff.py, injected) runs ``coord_drift_scan`` over the
worktree and posts the signed ``coord_handoff`` packet — fail-open, so neither can stop a
launch; the packet, not the prompt, is the replayable record of what was dispatched.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal, Mapping

from . import launcher, sessions, worktree
from .host import HostRefused
from .launcher import Launched
from .linear import Candidate
from .quota import burn_breaches
from .worktree import WorktreeRefused

EVENT_RETRYABLE_MARKERS = frozenset({"host-unreachable"})
# Rows registered for this phase (Phase 17, event-sources.ts): a launch lands on
# ``dispatch.outcome`` (kind note), each terminal non-dispatch and give-up on
# ``dispatch.failed`` (kind warning). Transient states emit nothing.

DISPATCHABLE_SURFACES = frozenset({"hermes", "claude-code"})
COMMENT_PREFIX = "substrate-dispatcher:"
DISABLE_KEY = "SUBSTRATE_DISPATCH_DISABLED"
# U4 proof-window override: same file-scan, read every tick like the D-15 switch.
STORMBREAK_DISABLE_KEY = "SUBSTRATE_STORMBREAK_DISABLED"
# Once-only comment texts by marker; every body starts with COMMENT_PREFIX and carries the stable
# tag "[<marker>]", which tick looks for in the issue's last 50 comments before posting.
MARKERS: dict[str, str] = {
    "not-dispatchable": "surface not dispatchable yet — this dispatcher starts dispatch:hermes and dispatch:claude-code only",
    "no-node": "no registered substrate graph node for this issue; register it with graph_register first",
    "already-claimed": "node already claimed by {holder}; not dispatching",
    "invalid-graph-id": "the graph id is not a safe worktree name; not dispatching",
    "invalid-ids": "the issue identifier, node id, graph id or repo is not a safe prompt value; not dispatching, not retrying",
    "no-checkout": "no verified checkout of the graph's repo on this host; not dispatching",
    "low-disk": "under the free-disk floor on the worktree's filesystem; no worktree created, not dispatching",
    "path-conflict": "the worktree path is taken by something git does not track as this graph's worktree; not dispatching",
    "git-failed": "git could not prepare the worktree; not dispatching",
    "host-refused": "substrate-host refused the task; not dispatching",
    "host-unreachable": "substrate-host is not reachable; will retry on a later tick",
    "exited-unclaimed": "hermes session exited (code {code}) without claiming the node — removed the dispatch label; not retrying",
    "claim-timeout": "no claim within 15 minutes — removed the dispatch label; not retrying",
    "quota-burn": "quota burn SLO {slo} breached its rolling hour; dispatch storm-breaker tripped — not dispatching",
}

LaunchFn = Callable[[Candidate, dict], Launched]
# U3: the injected pre-launch step (handoff.make_prelaunch); None launches as before.
PrelaunchFn = Callable[..., None]
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


def _env_switch(env_file: Path, environ: Mapping[str, str], key: str) -> bool:
    """The last ``<key>=`` line in env_file decides; ``=1`` is on, anything else off.

    An appended line flips the switch without rewriting the secrets file. When the
    file lacks the key or cannot be read, the process environment decides. No other
    line is ever logged.
    """
    value: str | None = None
    try:
        with open(env_file, encoding="utf-8") as fh:
            for line in fh:
                stripped = line.strip()
                if stripped.startswith(key + "="):
                    value = stripped[len(key) + 1:]
    except OSError:
        value = None
    if value is None:
        value = environ.get(key, "")
    return value.strip().strip("'\"") == "1"


def dispatch_disabled(env_file: Path, environ: Mapping[str, str]) -> bool:
    """D-15 kill switch: the last ``SUBSTRATE_DISPATCH_DISABLED=`` line in env_file decides."""
    return _env_switch(env_file, environ, DISABLE_KEY)


def stormbreak_disabled(env_file: Path, environ: Mapping[str, str]) -> bool:
    """U4 override: the last ``SUBSTRATE_STORMBREAK_DISABLED=1`` line disables the breaker.

    Read exactly like the D-15 switch — env file first, process environment when the
    file lacks the key — so a proof window appends one line instead of rewriting the
    secrets file, and the value is re-decided on every tick.
    """
    return _env_switch(env_file, environ, STORMBREAK_DISABLE_KEY)


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
        result = call("events_emit", arguments)
    except Exception as exc:  # noqa: BLE001 - emission is observability, not the decision
        log(f"events_emit failed: {type(exc).__name__}: {exc}")
        return
    # A refused store is a normal reply, not an exception: log it with its ids.
    if isinstance(result, dict) and result.get("stored") is False:
        log(
            "events_emit not stored: "
            f"{arguments.get('graph_id') or arguments.get('linear_identifier')}"
            f"/{arguments.get('node_id') or 'none'} "
            f"{(arguments.get('payload') or {}).get('reason') or (arguments.get('payload') or {}).get('outcome')}"
        )


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


def emit_stormbreak(
    mcp: Any, *, breached: list[str], identifier: str, found: dict | None, log: Log
) -> None:
    """The storm-breaker tripped: one warning naming the breached burn SLOs (U4).

    Distinct from ``emit_failed`` on purpose — its payload ``action`` is
    ``dispatch.stormbreak``, so a reader can tell a quota stop from a per-issue
    failure, and the issue's own record stays clean of a fault it did not cause.
    """
    found = found or {}
    first = breached[0]
    arguments: dict[str, Any] = {
        "kind": "warning",
        "summary": f"dispatch stormbreak for {identifier}: quota burn SLO {first} breaching",
        "surface": "substrate",
        "session_id": f"dispatch:{found.get('graph_id') or identifier}:{found.get('node_id') or 'none'}",
        "linear_identifier": identifier,
        "payload": {
            "action": "dispatch.stormbreak",
            "runtime": "dispatcher",
            "slo": first,
            "breached": list(breached),
        },
    }
    if found.get("graph_id"):
        arguments["graph_id"] = found["graph_id"]
        arguments["payload"]["graph_id"] = found["graph_id"]
    if found.get("node_id"):
        arguments["node_id"] = found["node_id"]
        arguments["payload"]["node_id"] = found["node_id"]
    _emit(mcp, arguments, log)


def _lease_is_held(found: dict) -> bool:
    """True when graph_find's public lease view says the node is currently held.

    A stored ``claimed_by`` outlives its lease when no reaper clears it, so a
    bare holder must not block dispatch forever: ``held`` blocks, ``expired``
    and ``free`` fall through to launch (the session's own claim is the real
    gate), and a reply without a lease view keeps the old holder-only rule.
    """
    lease = found.get("lease")
    if not isinstance(lease, dict):
        return True
    return lease.get("state", "held") == "held"


def decide(
    candidate: Candidate,
    *,
    found: dict | None,
    active_issue_ids: set[str],
    capacity_left: int,
    given_up: set[str] | frozenset[str] = frozenset(),
    active_graph_ids: set[str] | frozenset[str] = frozenset(),
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
    if found.get("graph_id") in active_graph_ids:
        return Decision(
            "skip", candidate, f"session already running for graph {found.get('graph_id')}", found=found,
        )
    holder = (found.get("node") or {}).get("claimed_by")
    if holder and _lease_is_held(found):
        return Decision(
            "comment", candidate, f"node already claimed by {holder}",
            marker="already-claimed", found=found,
        )
    if capacity_left <= 0:
        return Decision("skip", candidate, "at capacity", found=found)
    return Decision(
        "launch", candidate, f"graph {found.get('graph_id')} node {found.get('node_id')}", found=found
    )


def stormbreak_breaches(
    *,
    env_file: Path,
    environ: Mapping[str, str],
    slo: Callable[[], Any] | None,
    log: Log,
) -> list[str]:
    """The once-per-tick burn verdict: breached SLO ids, or ``[]`` when the breaker stands down.

    Fail-open by construction: no fetcher, the override switch, an unreachable
    snapshot and a malformed snapshot all answer ``[]`` and the launch proceeds —
    the breaker only ever acts on a substrate verdict it actually read.
    """
    if slo is None:
        return []
    if stormbreak_disabled(env_file, environ):
        log(f"storm-breaker disabled ({STORMBREAK_DISABLE_KEY}=1)")
        return []
    try:
        snapshot = slo()
    except Exception as exc:  # noqa: BLE001 — an unreachable probe never blocks a launch
        log(f"slo snapshot unreachable; storm-breaker fails open: {type(exc).__name__}: {exc}")
        return []
    try:
        return burn_breaches(snapshot)
    except Exception as exc:  # noqa: BLE001 — a malformed snapshot never blocks a launch
        log(f"slo snapshot malformed; storm-breaker fails open: {type(exc).__name__}: {exc}")
        return []


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
    slo: Callable[[], Any] | None = None,
) -> list[Decision]:
    """Run one poll → resolve → decide → act pass; per-candidate errors never stop the tick.

    ``slo`` is the U4 burn probe; ``None`` (or a standing-down probe) launches as before.
    The probe is read once per enabled tick even when nothing can launch — zero
    candidates or full capacity still sample it, so the ledger keeps burn history
    across busy spells and the breaker has a span to judge when a slot opens.
    """
    if dispatch_disabled(env_file, environ):
        log(f"dispatch disabled ({DISABLE_KEY}=1)")
        return []
    candidates = linear.dispatch_candidates()
    log(f"tick: {len(candidates)} candidate issue(s)")
    decisions: list[Decision] = []
    stormbreak: list[str] | None = None

    def breaches_once() -> list[str]:
        """One snapshot and one verdict per tick, however many launches it gates."""
        nonlocal stormbreak
        if stormbreak is None:
            stormbreak = stormbreak_breaches(env_file=env_file, environ=environ, slo=slo, log=log)
        return stormbreak

    # The probe samples on every enabled tick, launch or not: history must accrue
    # while both slots are busy or the queue is empty, or an hour-long run would
    # leave the breaker nothing to judge when a slot finally opens.
    if not stormbreak_disabled(env_file, environ):
        breaches_once()

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
                active_graph_ids=registry.active_graph_ids(),
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
                breached = breaches_once()
                if breached:
                    # U4 storm-break: the once-only marker names the breached SLO, one
                    # warning event records the trip, and the issue keeps its labels —
                    # it did nothing wrong, so the next tick may launch it once the
                    # burn recovers. Until then the marker tag keeps both quiet.
                    log(
                        f"{candidate.identifier}: {tag('quota-burn')} quota burn SLO {breached[0]} "
                        "breaching; not dispatching"
                    )
                    if _comment_once(linear, candidate, "quota-burn", slo=breached[0]):
                        emit_stormbreak(
                            mcp, breached=breached, identifier=candidate.identifier,
                            found=decision.found, log=log,
                        )
                    continue
                found = decision.found or {}
                try:
                    bodies = linear.comment_bodies(candidate.issue_id)
                except Exception as exc:  # noqa: BLE001 — decided again next tick
                    log(
                        f"{candidate.identifier}: not launched: comment_bodies failed: "
                        f"{type(exc).__name__}: {exc}"
                    )
                    continue
                prior_claims = frozenset(
                    sessions.claim_comment_sessions(
                        bodies, surface=candidate.surface,
                        graph_id=found["graph_id"], node_id=found["node_id"],
                    )
                )
                try:
                    launched = _launch_recorded(registry, launch_fn, candidate, found, prior_claims)
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
                        repo=found["repo"],
                        launch_state=(found.get("node") or {}).get("state"),
                        prior_claim_sessions=prior_claims,
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


def _launch_recorded(
    registry: sessions.SessionRegistry, launch_fn: LaunchFn, candidate: Candidate, found: dict,
    prior_claims: frozenset[str],
) -> Launched:
    """Launch with a VM task's record on disk first, so a dispatcher that dies inside the launch
    re-adopts the task on its next start. A launch that raises drops the record again."""
    if candidate.surface != sessions.VM_SURFACE:
        return launch_fn(candidate, found)
    validate_ids(candidate, found)
    registry.note_vm_launch(
        issue_id=candidate.issue_id, identifier=candidate.identifier, graph_id=found["graph_id"],
        node_id=found["node_id"], dispatch_label_id=candidate.dispatch_label_id,
        repo=found["repo"], prior_claim_sessions=prior_claims,
    )
    try:
        return launch_fn(candidate, found)
    except WorktreeRefused:
        # Refused before any host request: no task was opened, so the record goes.
        registry.forget_vm_launch(candidate.issue_id)
        raise
    except HostRefused as refused:
        # Only a refusal that proves no task was opened drops the record; anything the host may have accepted stays for readopt().
        if not refused.may_be_open:
            registry.forget_vm_launch(candidate.issue_id)
        raise


def make_launch_fn(
    *,
    log: Log,
    checkout: Callable[..., Path] = worktree.repo_checkout,
    ensure: Callable[..., Path] = worktree.ensure_worktree,
    launch: Callable[..., Launched] = launcher.launch,
    open_task: Callable[..., Launched] | None = None,
    state_dir: Path | None = None,
    hermes_bin: str | None = None,
    prelaunch: PrelaunchFn | None = None,
) -> LaunchFn:
    """Compose D-12 (per-Graph-ID worktree) with D-13 (direct hermes chat) or D-06 (a VM task on
    substrate-host, ``open_task`` = HostClient.launch) for one candidate, by its surface.

    The prompt's ids are validated first, so an id render_prompt would refuse never leaves a
    worktree behind. ``prelaunch`` (U3) runs after the worktree exists and before any process
    starts — drift scan, then the signed handoff packet — and is fail-open twice over: the
    step itself never raises, and a broken step is logged and skipped rather than losing the
    launch.
    """

    def launch_fn(candidate: Candidate, found: dict) -> Launched:
        validate_ids(candidate, found)
        repo_path = checkout(found["repo"])
        path = ensure(repo_path, found["graph_id"], found["branch"])
        if prelaunch is not None:
            try:
                prelaunch(
                    identifier=candidate.identifier,
                    graph_id=found["graph_id"],
                    node_id=found["node_id"],
                    repo=found["repo"],
                    branch=found.get("branch"),
                    worktree=path,
                    surface=candidate.surface,
                    log=log,
                )
            except Exception as exc:  # noqa: BLE001 — a broken prelaunch never blocks a launch
                log(
                    f"{candidate.identifier}: prelaunch failed; launching anyway: "
                    f"{type(exc).__name__}: {exc}"
                )
        ids = dict(
            identifier=candidate.identifier,
            graph_id=found["graph_id"],
            node_id=found["node_id"],
            repo=found["repo"],
            worktree=path,
        )
        if candidate.surface == "claude-code":
            if open_task is None:
                # No request is sent, so no task was opened: the pending record must not survive.
                raise HostRefused("no substrate-host client configured", "host-unreachable", may_be_open=False)
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
