"""HostClient and RemoteTask (D-06) against httpx.MockTransport: the Popen subset the registry uses."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import httpx
import pytest

from substrate_dispatcher.host import (
    DEFAULT_HOST_URL,
    TASKS_DIR,
    UNREACHABLE_LIMIT,
    HostClient,
    HostRefused,
    RemoteTask,
)
from substrate_dispatcher.launcher import Launched, child_env

GID = "ut-mugzzzzz-0123abcd"
WT = Path(f"/var/lib/substrate/worktrees/{GID}")
OPEN = dict(identifier="SWC-9", graph_id=GID, node_id="n1", repo="swcstudiospace/agent-substrate", worktree=WT)


class FakeHost:
    """Records every request; answers by (method, path) from ``routes`` or raises ``fail``."""

    def __init__(self, routes: dict[tuple[str, str], tuple[int, object]] | None = None):
        self.routes = routes or {}
        self.requests: list[tuple[str, str, object]] = []
        self.fail: Exception | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.requests.append((request.method, request.url.path, body))
        if self.fail is not None:
            raise self.fail
        status, payload = self.routes.get((request.method, request.url.path), (404, {"error": "no route"}))
        return httpx.Response(status, json=payload)

    def client(self, **kwargs) -> HostClient:
        return HostClient(transport=httpx.MockTransport(self.handler), **kwargs)

    def paths(self, method: str) -> list[str]:
        return [p for m, p, _ in self.requests if m == method]


STATUS_PATH = f"/tasks/{GID}/n1"
TASK = {"graph_id": GID, "node_id": "n1", "session_id": "n1", "state": "waiting", "exit_code": None}


# --- HostClient.open_task ------------------------------------------------------------------


@pytest.mark.parametrize("status", [202, 200])
def test_open_task_posts_the_five_fields_and_returns_the_json_on_202_or_200(status):
    host = FakeHost({("POST", "/tasks"): (status, TASK)})
    got = host.client().open_task(**OPEN)
    assert got == TASK
    assert host.requests == [(
        "POST", "/tasks",
        {"graph_id": GID, "node_id": "n1", "identifier": "SWC-9",
         "repo": "swcstudiospace/agent-substrate", "worktree": str(WT)},
    )]


@pytest.mark.parametrize("status", [400, 409, 502])
def test_open_task_refusal_raises_host_refused_with_the_hosts_error_text(status):
    host = FakeHost({("POST", "/tasks"): (status, {"error": f"worktree must be {WT}"})})
    with pytest.raises(HostRefused) as err:
        host.client().open_task(**OPEN)
    assert err.value.marker == "host-refused"
    assert f"HTTP {status}" in err.value.reason and f"worktree must be {WT}" in err.value.reason


def test_open_task_error_text_is_capped_at_200_characters():
    host = FakeHost({("POST", "/tasks"): (409, {"error": "x" * 1000})})
    with pytest.raises(HostRefused) as err:
        host.client().open_task(**OPEN)
    assert len(err.value.reason) < 240 and err.value.reason.count("x") == 200


def test_open_task_transport_error_or_other_5xx_is_host_unreachable():
    down = FakeHost()
    down.fail = httpx.ConnectError("connection refused")
    with pytest.raises(HostRefused) as err:
        down.client().open_task(**OPEN)
    assert err.value.marker == "host-unreachable" and "ConnectError" in err.value.reason
    assert "connection refused" not in err.value.reason  # never the transport's own message

    broken = FakeHost({("POST", "/tasks"): (500, {"error": "boom"})})
    with pytest.raises(HostRefused) as err:
        broken.client().open_task(**OPEN)
    assert err.value.marker == "host-unreachable" and "HTTP 500" in err.value.reason


def test_from_env_reads_substrate_host_url(monkeypatch):
    monkeypatch.delenv("SUBSTRATE_HOST_URL", raising=False)
    assert HostClient.from_env().url == DEFAULT_HOST_URL == "http://127.0.0.1:7411"
    monkeypatch.setenv("SUBSTRATE_HOST_URL", "http://127.0.0.1:7999/")
    assert HostClient.from_env().url == "http://127.0.0.1:7999"


# --- HostClient.launch ---------------------------------------------------------------------


def test_launch_returns_launched_with_pid_0_a_remote_task_and_the_task_state_path():
    host = FakeHost({("POST", "/tasks"): (202, TASK)})
    lines: list[str] = []
    got = host.client().launch(**OPEN, clock=lambda: 1234.5, log=lines.append)
    assert isinstance(got, Launched)
    assert got.pid == 0 and got.started_at == 1234.5
    assert isinstance(got.proc, RemoteTask)
    assert (got.proc.graph_id, got.proc.node_id, got.proc.pid) == (GID, "n1", 0)
    assert got.prompt_path == got.log_path == TASKS_DIR / f"{GID}--n1.json"
    assert TASKS_DIR == Path("/var/lib/substrate/agentos/tasks")
    assert host.paths("POST") == ["/tasks"] and lines == []


def test_launch_propagates_a_refusal_without_a_handle():
    host = FakeHost({("POST", "/tasks"): (409, {"error": "node n1 already claimed by hermes"})})
    with pytest.raises(HostRefused) as err:
        host.client().launch(**OPEN)
    assert err.value.marker == "host-refused" and "already claimed" in err.value.reason


# --- RemoteTask.poll ----------------------------------------------------------------------


@pytest.mark.parametrize("exit_code, expected", [(None, None), (0, 0), (1, 1)])
def test_poll_maps_the_hosts_exit_code(exit_code, expected):
    host = FakeHost({("GET", STATUS_PATH): (200, {**TASK, "exit_code": exit_code})})
    task = RemoteTask(host.client(), GID, "n1")
    assert task.poll() == expected
    assert host.requests == [("GET", STATUS_PATH, None)]


def test_poll_returns_2_when_the_host_no_longer_knows_the_task():
    host = FakeHost({("GET", STATUS_PATH): (404, {"error": f"no task {GID}/n1"})})
    assert RemoteTask(host.client(), GID, "n1").poll() == 2


def test_poll_tolerates_two_transport_failures_then_reports_2_and_logs_once():
    host = FakeHost({("GET", STATUS_PATH): (200, TASK)})
    lines: list[str] = []
    task = RemoteTask(host.client(), GID, "n1", log=lines.append)
    assert task.poll() is None
    host.fail = httpx.ConnectError("refused")
    assert UNREACHABLE_LIMIT == 3
    assert task.poll() is None
    assert task.poll() is None
    assert lines == []
    assert task.poll() == 2
    assert len(lines) == 1 and f"{GID}/n1" in lines[0] and "3" in lines[0]
    assert task.poll() == 2
    assert len(lines) == 1  # still 2, not logged again
    assert "refused" not in "".join(lines)


def test_a_successful_poll_between_failures_resets_the_unreachable_count():
    host = FakeHost({("GET", STATUS_PATH): (200, TASK)})
    lines: list[str] = []
    task = RemoteTask(host.client(), GID, "n1", log=lines.append)
    host.fail = httpx.ConnectError("refused")
    assert task.poll() is None and task.poll() is None
    host.fail = None
    assert task.poll() is None
    host.fail = httpx.ConnectError("refused")
    assert task.poll() is None and task.poll() is None
    assert lines == []
    assert task.poll() == 2 and len(lines) == 1


def test_a_5xx_status_counts_as_unreachable_like_a_transport_error():
    host = FakeHost({("GET", STATUS_PATH): (500, {"error": "engine down"})})
    task = RemoteTask(host.client(), GID, "n1")
    assert [task.poll() for _ in range(3)] == [None, None, 2]


# --- RemoteTask.terminate / kill -----------------------------------------------------------


def test_terminate_and_kill_post_the_host_routes():
    host = FakeHost({
        ("POST", f"{STATUS_PATH}/terminate"): (202, {"terminate": "accepted"}),
        ("POST", f"{STATUS_PATH}/kill"): (202, {"kill": "accepted"}),
    })
    task = RemoteTask(host.client(), GID, "n1")
    task.terminate()
    task.kill()
    assert host.requests == [
        ("POST", f"{STATUS_PATH}/terminate", {}),
        ("POST", f"{STATUS_PATH}/kill", {}),
    ]


def test_terminate_and_kill_log_a_transport_error_and_never_raise():
    host = FakeHost()
    host.fail = httpx.ConnectError("refused")
    lines: list[str] = []
    task = RemoteTask(host.client(), GID, "n1", log=lines.append)
    task.terminate()
    task.kill()
    assert len(lines) == 2
    assert "terminate" in lines[0] and "kill" in lines[1]
    assert all("ConnectError" in line and "refused" not in line for line in lines)

    gone = FakeHost()  # 404: the host answers, the task is gone — logged, not raised
    task = RemoteTask(gone.client(), GID, "n1", log=lines.append)
    task.terminate()
    assert len(lines) == 3 and "404" in lines[2]


def test_open_task_post_carries_substrate_bearer():
    seen: dict[str, str | None] = {}
    host = FakeHost({("POST", "/tasks"): (202, TASK)})

    def authed(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("Authorization")
        return host.handler(request)

    HostClient(transport=httpx.MockTransport(authed), bearer="substrate-bearer-value").open_task(
        **OPEN
    )
    assert seen["auth"] == "Bearer substrate-bearer-value"


def test_open_task_without_bearer_sends_no_authorization_header():
    seen = {}
    host = FakeHost({("POST", "/tasks"): (202, TASK)})

    def watching(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("Authorization")
        return host.handler(request)

    HostClient(transport=httpx.MockTransport(watching)).open_task(**OPEN)
    assert seen["auth"] is None


def test_open_task_non_json_reply_is_host_unreachable():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not json{")

    with pytest.raises(HostRefused) as err:
        HostClient(transport=httpx.MockTransport(handler)).open_task(**OPEN)
    assert err.value.marker == "host-unreachable" and "non-JSON" in err.value.reason


def test_open_task_wrong_shape_reply_is_host_unreachable():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, json=["a", "list"])

    with pytest.raises(HostRefused) as err:
        HostClient(transport=httpx.MockTransport(handler)).open_task(**OPEN)
    assert err.value.marker == "host-unreachable" and "unexpected reply shape" in err.value.reason


def test_from_env_sends_the_host_api_token_as_the_bearer(monkeypatch, caplog):
    monkeypatch.setenv("SUBSTRATE_HOST_API_TOKEN", "host-api-token-value")
    seen: dict[str, str | None] = {}
    host = FakeHost({("POST", "/tasks"): (202, TASK)})

    def watching(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("Authorization")
        return host.handler(request)

    with caplog.at_level(logging.WARNING, logger="substrate_dispatcher.host"):
        HostClient.from_env(transport=httpx.MockTransport(watching)).open_task(**OPEN)
    assert seen["auth"] == "Bearer host-api-token-value"
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


def test_from_env_without_the_token_sends_no_header_and_warns_once_naming_only_the_variable(
    monkeypatch, caplog
):
    monkeypatch.delenv("SUBSTRATE_HOST_API_TOKEN", raising=False)
    seen: dict[str, str | None] = {}
    host = FakeHost({("POST", "/tasks"): (202, TASK)})

    def watching(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("Authorization")
        return host.handler(request)

    with caplog.at_level(logging.WARNING, logger="substrate_dispatcher.host"):
        client = HostClient.from_env(transport=httpx.MockTransport(watching))
        client.open_task(**OPEN)
    assert seen["auth"] is None
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and "SUBSTRATE_HOST_API_TOKEN" in warnings[0]


def test_a_bearer_echoed_in_an_error_body_is_redacted_from_the_refusal_and_the_log(monkeypatch):
    secret = "host-api-token-value"
    monkeypatch.setenv("SUBSTRATE_HOST_API_TOKEN", secret)

    def echoing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"error": f"rejected {request.headers['Authorization']}"})

    client = HostClient.from_env(transport=httpx.MockTransport(echoing))
    with pytest.raises(HostRefused) as err:
        client.open_task(**OPEN)
    assert secret not in err.value.reason and "rejected Bearer [redacted]" in err.value.reason
    lines: list[str] = []
    RemoteTask(client, GID, "n1", log=lines.append).kill()
    assert len(lines) == 1 and secret not in lines[0] and "[redacted]" in lines[0]


def test_child_env_never_carries_the_host_api_token():
    env = child_env({
        "PATH": "/usr/bin",
        "HOME": "/root",
        "SUBSTRATE_HOST_API_TOKEN": "host-api-token-value",
    })
    assert "SUBSTRATE_HOST_API_TOKEN" not in env
    assert "host-api-token-value" not in env.values()


def test_every_post_including_the_verb_posts_is_sent_as_application_json():
    seen: list[tuple[str, str, str | None]] = []
    host = FakeHost({
        ("POST", "/tasks"): (202, TASK),
        ("POST", f"{STATUS_PATH}/terminate"): (202, {"terminate": "accepted"}),
        ("POST", f"{STATUS_PATH}/kill"): (202, {"kill": "accepted"}),
    })

    def recording(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, request.headers.get("Content-Type")))
        return host.handler(request)

    client = HostClient(transport=httpx.MockTransport(recording))
    client.open_task(**OPEN)
    task = RemoteTask(client, GID, "n1")
    task.terminate()
    task.kill()
    posts = [(path, ctype) for method, path, ctype in seen if method == "POST"]
    assert [path for path, _ in posts] == ["/tasks", f"{STATUS_PATH}/terminate", f"{STATUS_PATH}/kill"]
    assert all(ctype == "application/json" for _, ctype in posts)
