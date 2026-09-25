"""D-14 session registry: the cap, the claim watch and the 10-minute claim timeout.

A dispatched Hermes session either lands its claim or ends without one. A session that ends
without a claim — its process exits first, or CLAIM_TIMEOUT_SECONDS pass — gets one Linear
comment, loses its ``dispatch:<surface>`` label and joins ``given_up``, which tick never
relaunches while the dispatcher runs.

Landed-claim evidence is any of: the node's ``claimed_by`` is the session's surface; the node
reached a LANDED_STATES state it did not have at launch; or a 02-01 Mirror.claim comment
(``Claimed by <surface> — session <id> (graph <gid>, node <nid>)``) whose session id was not on
the issue before launch. 02-05's graph_complete ends in index.releaseNode, which nulls
``claimed_by``, so a claim completed (or released) between two reaps still counts as landed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from . import dispatch

CLAIM_TIMEOUT_SECONDS = 600
# Hermes was seen ignoring SIGTERM (02-09 tracer): terminate, then kill once this has passed.
TERMINATE_GRACE_SECONDS = 10
LANDED_STATES = frozenset({"started_review", "completed"})

Log = Callable[[str], None]


@dataclass
class Session:
    issue_id: str
    identifier: str
    graph_id: str
    node_id: str
    surface: str
    dispatch_label_id: str
    proc: Any
    pid: int
    started_at: float
    log_path: Path
    claimed_at: float | None = None
    claim_session: str | None = None
    terminated_at: float | None = None
    launch_state: str | None = None
    prior_claim_sessions: frozenset[str] = frozenset()


def _claim_comment_re(*, surface: str, graph_id: str, node_id: str) -> re.Pattern[str]:
    return re.compile(
        rf"^Claimed by {re.escape(surface)} — session (\S+) "
        rf"\(graph {re.escape(graph_id)}, node {re.escape(node_id)}\)"
    )


def _claim_ids(bodies: Iterable[str], *, surface: str, graph_id: str, node_id: str) -> list[str]:
    pattern = _claim_comment_re(surface=surface, graph_id=graph_id, node_id=node_id)
    return [m.group(1) for body in bodies if (m := pattern.match(body))]


def claim_comment_sessions(
    bodies: Iterable[str], *, surface: str, graph_id: str, node_id: str
) -> set[str]:
    """Session ids of the 02-01 claim comments for exactly this surface, graph and node."""
    return set(_claim_ids(bodies, surface=surface, graph_id=graph_id, node_id=node_id))


def _new_claim_session(session: Session, bodies: Iterable[str]) -> str | None:
    ids = _claim_ids(
        bodies, surface=session.surface, graph_id=session.graph_id, node_id=session.node_id
    )
    return next((sid for sid in ids if sid not in session.prior_claim_sessions), None)


def landed_claim(
    session: Session, node: dict | None, bodies: Iterable[str]
) -> tuple[str, str | None] | None:
    """The landed-claim rule: (evidence, claim session id or None), or None without evidence."""
    node = node or {}
    if node.get("claimed_by") == session.surface:
        return ("claimed_by", node.get("claim_session"))
    new_session = _new_claim_session(session, bodies)
    if node.get("state") in LANDED_STATES and session.launch_state not in LANDED_STATES:
        return ("state", new_session)
    if new_session is not None:
        return ("comment", new_session)
    return None


class SessionRegistry:
    """Dispatched sessions by Linear issue id: at most ``max_sessions``, one per issue (D-14).

    A terminated session keeps its slot until its process has exited or been killed.
    """

    def __init__(self, max_sessions: int = 2) -> None:
        self.max_sessions = max_sessions
        self._sessions: dict[str, Session] = {}
        self.given_up: set[str] = set()
        self.pending_label_removal: dict[str, str] = {}

    def add(self, session: Session) -> None:
        if session.issue_id in self._sessions:
            raise ValueError(f"issue {session.issue_id} already has a dispatched session")
        if self.capacity_left() <= 0:
            raise ValueError(f"at capacity ({self.max_sessions} sessions)")
        self._sessions[session.issue_id] = session

    def get(self, issue_id: str) -> Session | None:
        return self._sessions.get(issue_id)

    def active_issue_ids(self) -> set[str]:
        return set(self._sessions)

    def capacity_left(self) -> int:
        return self.max_sessions - len(self._sessions)

    def reap(self, now: float, *, mcp: Any, linear: Any, log: Log) -> None:
        """Retry failed label removals, then watch, time out, kill or remove every session."""
        for issue_id, label_id in list(self.pending_label_removal.items()):
            if self._remove_label(linear, issue_id, label_id, log):
                log(f"{issue_id}: dispatch label removed on retry")
        for session in list(self._sessions.values()):
            try:
                self._reap_one(session, now, mcp=mcp, linear=linear, log=log)
            except Exception as exc:  # noqa: BLE001 — one session never stops the reap
                log(f"{session.identifier}: reap failed: {type(exc).__name__}: {exc}")

    def _reap_one(self, session: Session, now: float, *, mcp: Any, linear: Any, log: Log) -> None:
        code = session.proc.poll()
        if session.terminated_at is not None:
            if code is not None:
                del self._sessions[session.issue_id]
                log(f"{session.identifier}: terminated session pid {session.pid} ended (code {code})")
            elif now - session.terminated_at >= TERMINATE_GRACE_SECONDS:
                session.proc.kill()
                log(f"{session.identifier}: pid {session.pid} survived SIGTERM; sent SIGKILL")
            return

        node: dict | None = None
        node_read = False
        if session.claimed_at is None:
            try:
                node = _node(mcp.graph_get(session.graph_id), session.node_id)
                node_read = True
            except Exception as exc:  # noqa: BLE001
                log(f"{session.identifier}: graph_get failed: {type(exc).__name__}: {exc}")
            if node_read:
                evidence = landed_claim(session, node, [])
                if evidence:
                    self._record_claim(session, evidence, now, log)

        if session.claimed_at is not None:
            if code is None:
                return
            if session.claim_session is None:
                try:
                    bodies = linear.comment_bodies(session.issue_id)
                except Exception as exc:  # noqa: BLE001 — the claim is established; never defers
                    log(f"{session.identifier}: comment_bodies failed: {type(exc).__name__}: {exc}")
                else:
                    evidence = landed_claim(session, node, bodies)
                    session.claim_session = evidence[1] if evidence else None
            self._remove_exited(session, code, log)
            return

        timed_out = now - session.started_at >= CLAIM_TIMEOUT_SECONDS
        if code is None and not timed_out:
            return
        # Decision point: never declare a claim missing on unread evidence.
        if not node_read:
            log(f"{session.identifier}: claim decision deferred (graph_get unread)")
            return
        try:
            bodies = linear.comment_bodies(session.issue_id)
        except Exception as exc:  # noqa: BLE001
            log(
                f"{session.identifier}: claim decision deferred "
                f"(comment_bodies failed: {type(exc).__name__}: {exc})"
            )
            return
        evidence = landed_claim(session, node, bodies)
        if evidence:
            self._record_claim(session, evidence, now, log)
            if code is not None:
                self._remove_exited(session, code, log)
            return

        if code is not None:
            log(f"{session.identifier}: hermes pid {session.pid} exited (code {code}) without a claim")
            self._comment_once(linear, session, bodies, "exited-unclaimed", log, code=str(code))
            self._give_up(linear, session, log)
            del self._sessions[session.issue_id]
            return

        log(f"{session.identifier}: no claim within {CLAIM_TIMEOUT_SECONDS} s; terminating pid {session.pid}")
        self._comment_once(linear, session, bodies, "claim-timeout", log)
        self._give_up(linear, session, log)
        session.proc.terminate()
        session.terminated_at = now

    def _record_claim(self, session: Session, evidence: tuple[str, str | None], now: float, log: Log) -> None:
        kind, claim_session = evidence
        session.claimed_at = now
        session.claim_session = claim_session
        log(f"claim landed for {session.identifier} ({kind}, session {claim_session or 'unknown'})")

    def _remove_exited(self, session: Session, code: int, log: Log) -> None:
        del self._sessions[session.issue_id]
        log(
            f"{session.identifier}: hermes pid {session.pid} exited (code {code}) "
            f"after its claim (session {session.claim_session or 'unknown'})"
        )

    def _comment_once(
        self, linear: Any, session: Session, bodies: list[str], marker: str, log: Log, **fields: str
    ) -> None:
        if any(dispatch.tag(marker) in body for body in bodies):
            return
        try:
            linear.comment(session.issue_id, dispatch.comment_body(marker, **fields))
        except Exception as exc:  # noqa: BLE001
            log(f"{session.identifier}: {marker} comment failed: {type(exc).__name__}: {exc}")

    def _give_up(self, linear: Any, session: Session, log: Log) -> None:
        self.given_up.add(session.issue_id)
        self._remove_label(linear, session.issue_id, session.dispatch_label_id, log)

    def _remove_label(self, linear: Any, issue_id: str, label_id: str, log: Log) -> bool:
        try:
            linear.remove_label(issue_id, label_id)
        except Exception as exc:  # noqa: BLE001 — retried on every later reap
            self.pending_label_removal[issue_id] = label_id
            log(f"{issue_id}: dispatch label removal failed, will retry: {type(exc).__name__}: {exc}")
            return False
        self.pending_label_removal.pop(issue_id, None)
        return True


def _node(graph: dict | None, node_id: str) -> dict:
    """The node from a graph_get reply; an absent graph or node yields no evidence."""
    for node in (graph or {}).get("nodes") or []:
        if isinstance(node, dict) and node.get("node_id") == node_id:
            return node
    return {}
