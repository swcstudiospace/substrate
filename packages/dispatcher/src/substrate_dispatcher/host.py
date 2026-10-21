"""substrate-host client (D-06): open a dispatch:claude-code task over loopback HTTP and watch it.

``HostClient.launch`` posts the task to substrate-host (127.0.0.1:7411, 03-03 api.ts) and returns
the same ``Launched`` shape as launcher.launch, with ``pid`` 0 and ``proc`` a ``RemoteTask``.
``RemoteTask`` serves exactly the Popen subset ``sessions.SessionRegistry._reap_one`` uses —
``poll()``, ``terminate()``, ``kill()`` — so the D-14 cap, the claim timeout and the landed-claim
rule apply to a VM task unchanged. The host, not the dispatcher, holds the session (D-05): the
dispatcher re-adopts persisted VM tasks from ``vm_tasks.json`` on its next start.

Nothing here logs or returns more than ids, HTTP codes and at most 200 characters of an error body.
The host bearer is never logged; error text is redacted of it before the 200-character cap.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any, Callable

import httpx

from .launcher import Launched

DEFAULT_HOST_URL = "http://127.0.0.1:7411"
HOST_TOKEN_ENV = "SUBSTRATE_HOST_API_TOKEN"
TASKS_DIR = Path("/var/lib/substrate/agentos/tasks")
# poll() answers None through this many consecutive failed status reads, then 2.
UNREACHABLE_LIMIT = 3
# The host answered and will not open the task: bad request, claimed elsewhere, a step failed.
REFUSAL_STATUSES = frozenset({400, 409, 502})
ERROR_TEXT_LIMIT = 200

Log = Callable[[str], None]
logger = logging.getLogger(__name__)


class HostRefused(Exception):
    """substrate-host did not open the task.

    ``marker`` is the once-only Linear comment key, as WorktreeRefused: "host-refused" when the
    host answered 400/409/502, "host-unreachable" for a transport error or any other status.
    ``may_be_open`` is False only when the host certainly did not open the task: the connection
    never opened, or the host refused it. Otherwise it is True, and the caller keeps the record.
    """

    def __init__(self, reason: str, marker: str, *, may_be_open: bool = True) -> None:
        super().__init__(reason)
        self.reason = reason
        self.marker = marker
        self.may_be_open = may_be_open


def _error_text(resp: httpx.Response, secret: str | None) -> str:
    try:
        payload = resp.json()
    except ValueError:
        payload = None
    text = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(text, str):
        text = resp.text
    if secret:
        text = text.replace(secret, "[redacted]")
    return text[:ERROR_TEXT_LIMIT]


class HostClient:
    def __init__(
        self,
        url: str = DEFAULT_HOST_URL,
        *,
        timeout: float = 15.0,
        transport: httpx.BaseTransport | None = None,
        bearer: str | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self._bearer = (bearer or "").strip() or None
        kwargs: dict[str, Any] = {"base_url": self.url, "timeout": timeout}
        if transport is not None:
            kwargs["transport"] = transport
        self._client = httpx.Client(**kwargs)

    @classmethod
    def from_env(cls, *, transport: httpx.BaseTransport | None = None) -> HostClient:
        """SUBSTRATE_HOST_URL and SUBSTRATE_HOST_API_TOKEN from the environment. The token is the
        bearer on every host API request; when it is unset, one warning names the variable."""
        token = (os.environ.get(HOST_TOKEN_ENV) or "").strip()
        if not token:
            logger.warning("%s is unset; substrate-host requests carry no bearer", HOST_TOKEN_ENV)
        return cls(
            os.environ.get("SUBSTRATE_HOST_URL") or DEFAULT_HOST_URL,
            bearer=token,
            transport=transport,
        )

    def _headers(self) -> dict[str, str]:
        if self._bearer:
            return {"Authorization": f"Bearer {self._bearer}"}
        return {}

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> HostClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    @staticmethod
    def _task_path(graph_id: str, node_id: str) -> str:
        return f"/tasks/{graph_id}/{node_id}"

    def open_task(
        self, *, identifier: str, graph_id: str, node_id: str, repo: str, worktree: Path | str
    ) -> dict:
        """POST /tasks; the task status JSON on 202 (new) or 200 (existing), else HostRefused."""
        body = {
            "graph_id": graph_id,
            "node_id": node_id,
            "identifier": identifier,
            "repo": repo,
            "worktree": str(worktree),
        }
        try:
            resp = self._client.post("/tasks", json=body, headers=self._headers())
        except httpx.HTTPError as exc:
            raise HostRefused(
                f"POST /tasks failed: {type(exc).__name__}", "host-unreachable",
                may_be_open=not isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout)),
            ) from None
        if resp.status_code in (200, 202):
            try:
                payload = resp.json()
            except ValueError:
                raise HostRefused(f"HTTP {resp.status_code}: non-JSON reply", "host-unreachable") from None
            if not isinstance(payload, dict):
                raise HostRefused(f"HTTP {resp.status_code}: unexpected reply shape", "host-unreachable")
            return payload
        reason = f"HTTP {resp.status_code}: {_error_text(resp, self._bearer)}"
        if resp.status_code in REFUSAL_STATUSES:
            raise HostRefused(reason, "host-refused", may_be_open=False)
        raise HostRefused(reason, "host-unreachable")

    def status(self, graph_id: str, node_id: str) -> dict | None:
        """GET the task's status JSON; None on 404; HostRefused("host-unreachable") otherwise."""
        try:
            resp = self._client.get(self._task_path(graph_id, node_id), headers=self._headers())
        except httpx.HTTPError as exc:
            raise HostRefused(f"GET task failed: {type(exc).__name__}", "host-unreachable") from None
        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            raise HostRefused(f"HTTP {resp.status_code}: {_error_text(resp, self._bearer)}", "host-unreachable")
        try:
            payload = resp.json()
        except ValueError:
            raise HostRefused("HTTP 200: non-JSON reply", "host-unreachable") from None
        if not isinstance(payload, dict):
            raise HostRefused("HTTP 200: unexpected reply shape", "host-unreachable")
        return payload

    def _post_verb(self, graph_id: str, node_id: str, verb: str) -> None:
        try:
            resp = self._client.post(f"{self._task_path(graph_id, node_id)}/{verb}", json={}, headers=self._headers())
        except httpx.HTTPError as exc:
            raise HostRefused(f"POST {verb} failed: {type(exc).__name__}", "host-unreachable") from None
        if resp.status_code != 202:
            raise HostRefused(f"HTTP {resp.status_code}: {_error_text(resp, self._bearer)}", "host-unreachable")

    def terminate(self, graph_id: str, node_id: str) -> None:
        """POST …/terminate (cancel the running turn); HostRefused when not accepted."""
        self._post_verb(graph_id, node_id, "terminate")

    def kill(self, graph_id: str, node_id: str) -> None:
        """POST …/kill (cancel, unload, release the claim); HostRefused when not accepted."""
        self._post_verb(graph_id, node_id, "kill")

    def launch(
        self,
        *,
        identifier: str,
        graph_id: str,
        node_id: str,
        repo: str,
        worktree: Path | str,
        clock: Callable[[], float] = time.time,
        log: Log | None = None,
    ) -> Launched:
        """Open the task on the host and hand back a Launched whose proc is a RemoteTask."""
        started_at = clock()
        self.open_task(
            identifier=identifier, graph_id=graph_id, node_id=node_id, repo=repo, worktree=worktree
        )
        state_path = TASKS_DIR / f"{graph_id}--{node_id}.json"
        return Launched(
            pid=0,
            proc=RemoteTask(self, graph_id, node_id, log=log),
            prompt_path=state_path,
            log_path=state_path,
            started_at=started_at,
        )


class RemoteTask:
    """A VM task on substrate-host seen through the Popen subset the session registry uses."""

    pid = 0

    def __init__(self, client: HostClient, graph_id: str, node_id: str, *, log: Log | None = None):
        self.client = client
        self.graph_id = graph_id
        self.node_id = node_id
        self._log = log or (lambda _line: None)
        self._failures = 0
        self._reported_unreachable = False

    def poll(self) -> int | None:
        """None while the host reports exit_code null; the host's 0 or 1 when the turn ended;
        2 when the host no longer knows the task or has been unreachable UNREACHABLE_LIMIT times."""
        try:
            status = self.client.status(self.graph_id, self.node_id)
        except HostRefused as refused:
            self._failures += 1
            if self._failures < UNREACHABLE_LIMIT:
                return None
            if not self._reported_unreachable:
                self._reported_unreachable = True
                self._log(
                    f"task {self.graph_id}/{self.node_id}: substrate-host unreachable "
                    f"{self._failures} times ({refused.reason}); reporting exit 2"
                )
            return 2
        self._failures = 0
        self._reported_unreachable = False
        if status is None:
            return 2
        code = status.get("exit_code")
        return None if code is None else int(code)

    def terminate(self) -> None:
        try:
            self.client.terminate(self.graph_id, self.node_id)
        except HostRefused as refused:
            self._log(f"task {self.graph_id}/{self.node_id}: terminate not accepted: {refused.reason}")

    def kill(self) -> None:
        try:
            self.client.kill(self.graph_id, self.node_id)
        except HostRefused as refused:
            self._log(f"task {self.graph_id}/{self.node_id}: kill not accepted: {refused.reason}")
