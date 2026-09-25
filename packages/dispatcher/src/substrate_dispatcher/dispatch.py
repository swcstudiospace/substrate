"""One dispatcher tick: poll Linear, resolve each candidate's node, decide, launch Hermes.

D-10: a tick polls Linear for unstarted issues carrying a ``dispatch:*`` label and resolves each
dispatchable candidate through substrate-mcp ``graph_find`` before any launch decision.
D-11: only ``dispatch:hermes`` can launch.
D-14: at most 2 dispatched sessions, one per issue (SessionRegistry).
D-15: ``SUBSTRATE_DISPATCH_DISABLED=1`` in the live env file stops every tick before any call.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal, Mapping

from . import launcher, worktree
from .launcher import Launched
from .linear import Candidate
from .worktree import WorktreeRefused

DISPATCHABLE_SURFACES = frozenset({"hermes"})
COMMENT_PREFIX = "substrate-dispatcher:"
DISABLE_KEY = "SUBSTRATE_DISPATCH_DISABLED"
# Once-only comment texts by marker; every body starts with COMMENT_PREFIX and carries the stable
# tag "[<marker>]", which tick looks for in the issue's last 50 comments before posting.
MARKERS: dict[str, str] = {
    "not-dispatchable": "surface not dispatchable yet — this dispatcher only starts dispatch:hermes",
    "no-node": "no registered substrate graph node for this issue; register it with graph_register first",
    "already-claimed": "node already claimed by {holder}; not dispatching",
    "invalid-graph-id": "the graph id is not a safe worktree name; not dispatching",
    "no-checkout": "no verified checkout of the graph's repo on this host; not dispatching",
    "low-disk": "under 5 GB free on /; no worktree created, not dispatching",
    "path-conflict": "the worktree path is taken by something git does not track as this graph's worktree; not dispatching",
    "git-failed": "git could not prepare the worktree; not dispatching",
}

LaunchFn = Callable[[Candidate, dict], Launched]
Log = Callable[[str], None]


@dataclass(frozen=True)
class Decision:
    action: Literal["launch", "comment", "skip"]
    candidate: Candidate
    reason: str
    marker: str | None = None
    found: dict | None = None


class SessionRegistry:
    """Dispatched sessions by Linear issue id: at most ``max_sessions``, one per issue (D-14)."""

    def __init__(self, max_sessions: int = 2) -> None:
        self.max_sessions = max_sessions
        self._sessions: dict[str, Launched] = {}

    def add(self, issue_id: str, launched: Launched) -> None:
        if issue_id in self._sessions:
            raise ValueError(f"issue {issue_id} already has a dispatched session")
        if self.capacity_left() <= 0:
            raise ValueError(f"at capacity ({self.max_sessions} sessions)")
        self._sessions[issue_id] = launched

    def active_issue_ids(self) -> set[str]:
        return set(self._sessions)

    def capacity_left(self) -> int:
        return self.max_sessions - len(self._sessions)


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


def decide(
    candidate: Candidate, *, found: dict | None, active_issue_ids: set[str], capacity_left: int
) -> Decision:
    if candidate.surface not in DISPATCHABLE_SURFACES:
        return Decision(
            "comment", candidate, f"surface {candidate.surface} not dispatchable",
            marker="not-dispatchable",
        )
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
    registry: SessionRegistry,
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
            if candidate.surface in DISPATCHABLE_SURFACES and candidate.issue_id not in active:
                found = mcp.graph_find(linear_issue_id=candidate.issue_id)
            decision = decide(
                candidate, found=found, active_issue_ids=active, capacity_left=registry.capacity_left()
            )
            decisions.append(decision)
            if dry_run:
                log(f"{candidate.identifier} {candidate.dispatch_label} → {decision.action}: {decision.reason}")
                continue
            if decision.action == "comment" and decision.marker:
                holder = ((decision.found or {}).get("node") or {}).get("claimed_by") or ""
                _comment_once(linear, candidate, decision.marker, holder=str(holder))
            elif decision.action == "launch":
                try:
                    launched = launch_fn(candidate, decision.found or {})
                except WorktreeRefused as refused:
                    log(f"{candidate.identifier}: worktree refused {tag(refused.marker)}: {refused.reason}")
                    _comment_once(linear, candidate, refused.marker)
                    continue
                registry.add(candidate.issue_id, launched)
        except Exception as exc:  # noqa: BLE001 — one bad candidate never stops the tick
            log(f"{candidate.identifier}: {type(exc).__name__}: {exc}")
    return decisions


def _comment_once(linear: Any, candidate: Candidate, marker: str, **fields: str) -> None:
    """Post the marker's comment unless one of the issue's last 50 comments carries its tag."""
    if any(tag(marker) in existing for existing in linear.comment_bodies(candidate.issue_id)):
        return
    linear.comment(candidate.issue_id, comment_body(marker, **fields))


def make_launch_fn(
    *,
    log: Log,
    checkout: Callable[..., Path] = worktree.repo_checkout,
    ensure: Callable[..., Path] = worktree.ensure_worktree,
    launch: Callable[..., Launched] = launcher.launch,
) -> LaunchFn:
    """Compose D-12 (per-Graph-ID worktree) and D-13 (direct hermes chat) for one candidate."""

    def launch_fn(candidate: Candidate, found: dict) -> Launched:
        repo_path = checkout(found["repo"])
        path = ensure(repo_path, found["graph_id"], found["branch"])
        launched = launch(
            identifier=candidate.identifier,
            graph_id=found["graph_id"],
            node_id=found["node_id"],
            repo=found["repo"],
            worktree=path,
        )
        log(
            f"launched hermes for {candidate.identifier} graph {found['graph_id']} "
            f"node {found['node_id']} pid {launched.pid} worktree {path} log {launched.log_path}"
        )
        return launched

    return launch_fn
