"""D-14 session registry: the cap, the claim watch and the 15-minute claim timeout.

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

import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable

from . import dispatch
from .host import TASKS_DIR, HostClient, HostRefused, RemoteTask

# Must outlast one Hermes 429 rate-limit backoff (HERMES_RATE_LIMIT_BACKOFF_SECONDS) plus startup:
# in 02-08 a 600 s timeout equal to that backoff turned every first-call 429 into a certain
# [claim-timeout] before Hermes could retry (D-14 amended 2026-09-25 by the owner).
HERMES_RATE_LIMIT_BACKOFF_SECONDS = 600
CLAIM_TIMEOUT_SECONDS = 900
# Hermes was seen ignoring SIGTERM (02-09 tracer): terminate, then kill once this has passed.
TERMINATE_GRACE_SECONDS = 10
LANDED_STATES = frozenset({"started_review", "completed"})
# D43-A: a persisted VM task that substrate-host stays unreachable for is dropped after this many
# failed re-adoption attempts in a row.
READOPT_UNREACHABLE_LIMIT = 60
# The 15-minute claim timeout: a younger record's 404 means the host may still be opening the task.
PENDING_GRACE_S = 900
VM_SURFACE = "claude-code"
VM_TASKS_FILE = "vm_tasks.json"
VM_RECORD_TEXT_FIELDS = (
    "issue_id", "identifier", "graph_id", "node_id", "surface", "dispatch_label_id", "repo",
)

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
    repo: str = ""


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


def _claim_is_fresh(node: dict, now: float) -> bool:
    """True unless the node's ``lease_expires_at`` is present and in the past.

    A stored ``claimed_by`` outlives its lease when no reaper clears it; only
    a live claim is landed-claim evidence. Missing or unparseable expiry
    keeps the old rule (fail-open toward landed: the reap still watches).
    """
    expires_at = node.get("lease_expires_at")
    if not isinstance(expires_at, str) or not expires_at:
        return True
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    return expiry.timestamp() >= now


def landed_claim(
    session: Session, node: dict | None, bodies: Iterable[str], *, now: float | None = None
) -> tuple[str, str | None] | None:
    """The landed-claim rule: (evidence, claim session id or None), or None without evidence."""
    node = node or {}
    if node.get("claimed_by") == session.surface and _claim_is_fresh(node, time.time() if now is None else now):
        return ("claimed_by", node.get("claim_session"))
    new_session = _new_claim_session(session, bodies)
    if node.get("state") in LANDED_STATES and session.launch_state not in LANDED_STATES:
        return ("state", new_session)
    if new_session is not None:
        return ("comment", new_session)
    return None


def _vm_key(graph_id: str, node_id: str) -> str:
    """The VM task record key: ``graph_id/node_id``, one record per graph node."""
    return f"{graph_id}/{node_id}"


def _valid_vm_record(record: object) -> bool:
    """True for a record shaped as ``SessionRegistry`` writes it; the claim evidence is optional."""
    if not isinstance(record, dict):
        return False
    if not all(isinstance(record.get(field), str) for field in VM_RECORD_TEXT_FIELDS):
        return False
    if not isinstance(record.get("started_at"), (int, float)):
        return False
    claimed_at = record.get("claimed_at")
    if claimed_at is not None and not isinstance(claimed_at, (int, float)):
        return False
    claim_session = record.get("claim_session")
    if claim_session is not None and not isinstance(claim_session, str):
        return False
    prior = record.get("prior_claim_sessions", [])
    return isinstance(prior, list) and all(isinstance(sid, str) for sid in prior)


def _vm_record(
    *, issue_id: str, identifier: str, graph_id: str, node_id: str, dispatch_label_id: str,
    repo: str, started_at: float, prior_claim_sessions: frozenset[str],
) -> dict:
    """The persisted VM task record: ids, the start time and prior claim session ids only."""
    return {
        "issue_id": issue_id, "identifier": identifier, "graph_id": graph_id, "node_id": node_id,
        "surface": VM_SURFACE, "dispatch_label_id": dispatch_label_id, "started_at": started_at,
        "repo": repo, "prior_claim_sessions": sorted(prior_claim_sessions),
    }


def _write_private_json(path: Path, payload: object) -> None:
    """Atomically replace ``path`` with ``payload`` as JSON: a 0600 file in a 0700 directory."""
    tmp = path.with_suffix(".json.tmp")
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise



class SessionRegistry:
    """Dispatched sessions by Linear issue id: at most ``max_sessions``, one per issue (D-14).

    A terminated session keeps its slot until its process has exited or been killed.
    The given-up set survives a restart (D24-05, DISP-06): with ``state_dir`` the
    registry loads ``given_up.json`` (0600, atomic replace) at construction and saves
    on every give-up, so a new process never relaunches a given-up issue. VM tasks
    (claude-code) are recorded in ``vm_tasks.json`` the same way until their session
    leaves, and ``readopt`` re-adopts the ones substrate-host still holds (D43-A).
    """

    def __init__(
        self, max_sessions: int = 2, *, state_dir: Any = None, log: Log | None = None,
        host: HostClient | None = None,
    ) -> None:
        self.max_sessions = max_sessions
        self._sessions: dict[str, Session] = {}
        self.given_up: set[str] = set()
        self.pending_label_removal: dict[str, str] = {}
        self._log: Log = log or (lambda line: print(f"[substrate-dispatcher] {line}", file=sys.stderr))
        self._host = host
        self._vm_tasks: dict[str, dict] = {}
        self._vm_failures: dict[str, int] = {}
        self._given_up_path = Path(state_dir) / "given_up.json" if state_dir is not None else None
        self._vm_tasks_path = Path(state_dir) / VM_TASKS_FILE if state_dir is not None else None
        if self._given_up_path is not None:
            self._load_given_up()
        if self._vm_tasks_path is not None:
            self._load_vm_tasks()

    def _load_given_up(self) -> None:
        """Re-read the persisted given-up set before the first tick (D24-05)."""
        assert self._given_up_path is not None
        try:
            raw = self._given_up_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return
        except OSError as exc:
            self._log(f"given_up.json unreadable ({type(exc).__name__}); restart protection may relaunch")
            return
        try:
            ids = json.loads(raw)
        except ValueError:
            self._log("given_up.json corrupt; starting with an empty given-up set")
            return
        if isinstance(ids, list):
            self.given_up.update(i for i in ids if isinstance(i, str))
        else:
            self._log("given_up.json corrupt; starting with an empty given-up set")

    def _save_given_up(self) -> None:
        """Atomically persist the given-up set (0600); a crash between add and fsync may relaunch once."""
        assert self._given_up_path is not None
        tmp = self._given_up_path.with_suffix(".json.tmp")
        try:
            self._given_up_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(sorted(self.given_up), fh)
                fh.flush()
                os.fsync(fh.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, self._given_up_path)
        except OSError as exc:
            self._log(f"given_up.json save failed ({type(exc).__name__}); restart protection may relaunch")
            try:
                os.unlink(tmp)
            except OSError:
                pass

    def _load_vm_tasks(self) -> None:
        """Re-read the persisted VM task records before the first tick (D43-A); corrupt starts empty."""
        assert self._vm_tasks_path is not None
        try:
            raw = self._vm_tasks_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return
        except OSError as exc:
            self._log(f"vm_tasks.json unreadable ({type(exc).__name__}); VM tasks are not re-adopted")
            return
        try:
            records = json.loads(raw)
        except ValueError:
            records = None
        if not isinstance(records, dict) or not all(_valid_vm_record(r) for r in records.values()):
            self._log("vm_tasks.json corrupt; starting with no VM task records")
            return
        for record in records.values():
            self._vm_tasks[_vm_key(record["graph_id"], record["node_id"])] = record

    def _save_vm_tasks(self) -> None:
        """Atomically persist the VM task records (0600); a failed save can leave a stale record."""
        assert self._vm_tasks_path is not None
        try:
            _write_private_json(self._vm_tasks_path, self._vm_tasks)
        except OSError as exc:
            self._log(f"vm_tasks.json save failed ({type(exc).__name__}); restart re-adoption may be stale")

    def give_up(self, issue_id: str) -> None:
        """Record a give-up and persist it when a state dir is configured.

        The VM task record goes first, so a crash between the two saves can only leave an issue
        given up without its VM task record.
        """
        self._forget_vm_task(issue_id)
        self.given_up.add(issue_id)
        if self._given_up_path is not None:
            self._save_given_up()

    def add(self, session: Session) -> None:
        if session.issue_id in self._sessions:
            raise ValueError(f"issue {session.issue_id} already has a dispatched session")
        if self._held_slots(except_issue=session.issue_id) >= self.max_sessions:
            raise ValueError(f"at capacity ({self.max_sessions} sessions)")
        self._sessions[session.issue_id] = session
        if session.surface == VM_SURFACE:
            self._remember_vm_task(session)

    def _remember_vm_task(self, session: Session) -> None:
        """Record an opened VM task so a restarted dispatcher can re-adopt it: ids and times only."""
        self._put_vm_record(_vm_record(
            issue_id=session.issue_id, identifier=session.identifier, graph_id=session.graph_id,
            node_id=session.node_id, dispatch_label_id=session.dispatch_label_id, repo=session.repo,
            started_at=session.started_at, prior_claim_sessions=session.prior_claim_sessions,
        ))

    def note_vm_launch(
        self, *, issue_id: str, identifier: str, graph_id: str, node_id: str,
        dispatch_label_id: str, repo: str, prior_claim_sessions: frozenset[str],
    ) -> None:
        """Write a VM task's record before its launch call, so a dispatcher that dies inside the
        launch re-adopts the task on its next start. ``started_at`` is provisional: add() replaces the
        record with the launch's own start time."""
        self._put_vm_record(_vm_record(
            issue_id=issue_id, identifier=identifier, graph_id=graph_id, node_id=node_id,
            dispatch_label_id=dispatch_label_id, repo=repo, started_at=time.time(),
            prior_claim_sessions=prior_claim_sessions,
        ))

    def forget_vm_launch(self, issue_id: str) -> None:
        """A launch that raised drops its pending record."""
        self._forget_vm_task(issue_id)

    def _put_vm_record(self, record: dict) -> None:
        self._vm_tasks[_vm_key(record["graph_id"], record["node_id"])] = record
        if self._vm_tasks_path is not None:
            self._save_vm_tasks()

    def _remember_claim(self, session: Session) -> None:
        """Persist a VM task's landed-claim evidence so a restarted dispatcher keeps it."""
        if session.surface != VM_SURFACE:
            return
        record = self._vm_tasks.get(_vm_key(session.graph_id, session.node_id))
        if record is None:
            return
        record["claimed_at"] = session.claimed_at
        record["claim_session"] = session.claim_session
        if self._vm_tasks_path is not None:
            self._save_vm_tasks()

    def _drop_session(self, issue_id: str) -> None:
        """A session leaves the registry; its VM task record leaves with it (D43-A)."""
        del self._sessions[issue_id]
        self._forget_vm_task(issue_id)

    def _forget_vm_task(self, issue_id: str) -> None:
        keys = [key for key, record in self._vm_tasks.items() if record["issue_id"] == issue_id]
        if not keys:
            return
        for key in keys:
            del self._vm_tasks[key]
            self._vm_failures.pop(key, None)
        if self._vm_tasks_path is not None:
            self._save_vm_tasks()

    def get(self, issue_id: str) -> Session | None:
        return self._sessions.get(issue_id)

    def active_issue_ids(self) -> set[str]:
        """Live sessions and pending VM tasks: a task awaiting re-adoption is never launched again."""
        return set(self._sessions) | {record["issue_id"] for record in self._vm_tasks.values()}

    def active_graph_ids(self) -> set[str]:
        """Graphs with a live session or a pending VM task: one worktree, one writer (Greptile P1)."""
        return {session.graph_id for session in self._sessions.values()} | {
            record["graph_id"] for record in self._vm_tasks.values()
        }

    def _held_slots(self, *, except_issue: str | None = None) -> int:
        """Slots held by live sessions and by pending VM tasks, one each.

        A pending VM task has no session yet, but its host task may still be running, so it keeps
        its slot until readopt() resolves it. ``except_issue`` leaves out one issue's own record: a
        launch in progress has just written that record and must not count against itself.
        """
        pending = {record["issue_id"] for record in self._vm_tasks.values() if record["issue_id"] != except_issue}
        return len(self._sessions) + len(pending - set(self._sessions))

    def capacity_left(self) -> int:
        """Free slots for a new launch: a live session and a pending VM task each hold one."""
        return max(0, self.max_sessions - self._held_slots())

    def readopt(self, now: float | None = None) -> None:
        """Re-adopt persisted VM tasks that have no live session (D43-A); call before each tick.

        substrate-host answers for each record: a 404 drops it once the record is older than
        PENDING_GRACE_S, and otherwise waits; a running or finished task becomes a
        session (a finished one is reaped like any other exit); an unreachable host keeps the record
        for a later call, and READOPT_UNREACHABLE_LIMIT failed attempts in a row drop it. Records
        beyond the free session slots stay recorded for a later call.
        """
        if self._host is None:
            return
        now = time.time() if now is None else now
        live_keys = {
            _vm_key(session.graph_id, session.node_id)
            for session in self._sessions.values()
            if session.surface == VM_SURFACE
        }
        for key, record in list(self._vm_tasks.items()):
            issue_id, graph_id, node_id = record["issue_id"], record["graph_id"], record["node_id"]
            if key in live_keys or issue_id in self._sessions:
                continue
            if len(self._sessions) >= self.max_sessions:
                return
            try:
                status = self._host.status(graph_id, node_id)
            except HostRefused:
                failures = self._vm_failures.get(key, 0) + 1
                if failures < READOPT_UNREACHABLE_LIMIT:
                    self._vm_failures[key] = failures
                    continue
                self._log(
                    f"{record['identifier']}: substrate-host unreachable for VM task {graph_id}/{node_id} "
                    f"{failures} times; dropping its record"
                )
                self._forget_vm_task(issue_id)
                continue
            self._vm_failures.pop(key, None)
            if status is None and now - record["started_at"] < PENDING_GRACE_S:
                self._log(
                    f"{record['identifier']}: substrate-host has no VM task {graph_id}/{node_id} yet; "
                    "waiting for it"
                )
                continue
            if status is None:
                self._log(
                    f"{record['identifier']}: substrate-host no longer knows VM task "
                    f"{graph_id}/{node_id}; dropping its record"
                )
                self._forget_vm_task(issue_id)
                continue
            # launch_state stays None: the node's state at launch was never recorded.
            self._sessions[issue_id] = Session(
                issue_id=issue_id,
                identifier=record["identifier"],
                graph_id=graph_id,
                node_id=node_id,
                surface=record["surface"],
                dispatch_label_id=record["dispatch_label_id"],
                proc=RemoteTask(self._host, graph_id, node_id, log=self._log),
                pid=0,
                started_at=record["started_at"],
                log_path=TASKS_DIR / f"{graph_id}--{node_id}.json",
                repo=record["repo"],
                claimed_at=record.get("claimed_at"),
                claim_session=record.get("claim_session"),
                prior_claim_sessions=frozenset(record.get("prior_claim_sessions", [])),
            )
            finished = " (finished while the dispatcher was down)" if status.get("exit_code") is not None else ""
            self._log(f"{record['identifier']}: re-adopted VM task {graph_id}/{node_id}{finished}")

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
                self._drop_session(session.issue_id)
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
            dispatch.emit_failed(
                mcp, graph_id=session.graph_id, node_id=session.node_id,
                identifier=session.identifier, reason="exited-unclaimed", log=log,
            )
            self._drop_session(session.issue_id)
            return

        log(f"{session.identifier}: no claim within {CLAIM_TIMEOUT_SECONDS} s; terminating pid {session.pid}")
        self._comment_once(linear, session, bodies, "claim-timeout", log)
        self._give_up(linear, session, log)
        dispatch.emit_failed(
            mcp, graph_id=session.graph_id, node_id=session.node_id,
            identifier=session.identifier, reason="claim-timeout", log=log,
        )
        session.proc.terminate()
        session.terminated_at = now

    def _record_claim(self, session: Session, evidence: tuple[str, str | None], now: float, log: Log) -> None:
        kind, claim_session = evidence
        session.claimed_at = now
        session.claim_session = claim_session
        self._remember_claim(session)
        log(f"claim landed for {session.identifier} ({kind}, session {claim_session or 'unknown'})")

    def _remove_exited(self, session: Session, code: int, log: Log) -> None:
        self._drop_session(session.issue_id)
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
        self.give_up(session.issue_id)
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
