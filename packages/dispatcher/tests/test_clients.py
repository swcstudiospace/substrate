"""LinearClient and McpClient against httpx.MockTransport."""

from __future__ import annotations

import json

import httpx
import pytest

from substrate_dispatcher.linear import Candidate, LinearApiError, LinearClient
from substrate_dispatcher.mcp import McpClient, McpError

KEY = "lin_api_secret_value"


def _linear(handler) -> LinearClient:
    return LinearClient(KEY, transport=httpx.MockTransport(handler))


def _issue(labels):
    return {
        "id": "iss-1",
        "identifier": "SWC-465",
        "team": {"id": "team-1", "key": "SWC"},
        "labels": {"nodes": [{"id": lid, "name": name} for lid, name in labels]},
    }


def test_dispatch_candidates_sends_poll_filter_and_splits_dispatch_labels():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers["Authorization"]
        seen["query"] = json.loads(request.content)["query"]
        issues = [
            _issue([("l-bug", "bug"), ("l-h", "dispatch:hermes"), ("l-c", "dispatch:claude-code")]),
            {**_issue([("l-e", "dispatch:")]), "id": "iss-2", "identifier": "SWC-2"},
        ]
        return httpx.Response(200, json={"data": {"issues": {"nodes": issues}}})

    got = _linear(handler).dispatch_candidates()

    query = seen["query"]
    assert 'startsWith: "dispatch:"' in query
    assert 'type: { eq: "unstarted" }' in query
    assert "first: 50" in query
    assert seen["auth"] == KEY
    assert got == [
        Candidate("iss-1", "SWC-465", "team-1", "SWC", "hermes", "l-h", "dispatch:hermes"),
        Candidate("iss-1", "SWC-465", "team-1", "SWC", "claude-code", "l-c", "dispatch:claude-code"),
    ]


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, text="upstream exploded"),
        httpx.Response(200, json={"errors": [{"message": "Authentication required"}]}),
    ],
)
def test_graphql_errors_raise_without_leaking_the_key(response):
    client = _linear(lambda request: response)
    with pytest.raises(LinearApiError) as err:
        client.dispatch_candidates()
    assert KEY not in str(err.value)
    assert "Bearer" not in str(err.value)


def test_comment_bodies_reads_last_50():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.update(body)
        nodes = [{"body": "one"}, {"body": "two"}]
        return httpx.Response(200, json={"data": {"issue": {"comments": {"nodes": nodes}}}})

    assert _linear(handler).comment_bodies("iss-1") == ["one", "two"]
    assert "comments(last: 50)" in seen["query"]
    assert seen["variables"] == {"id": "iss-1"}


def test_comment_sends_comment_create_input():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"data": {"commentCreate": {"success": True}}})

    _linear(handler).comment("iss-1", "hello")
    assert "commentCreate" in seen["query"]
    assert seen["variables"] == {"input": {"issueId": "iss-1", "body": "hello"}}


def test_remove_label_uses_removed_label_ids_only():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["raw"] = request.content.decode()
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"data": {"issueUpdate": {"success": True}}})

    _linear(handler).remove_label("iss-1", "l-h")
    assert "issueUpdate" in seen["query"]
    assert seen["variables"] == {"id": "iss-1", "input": {"removedLabelIds": ["l-h"]}}
    assert "labelIds" not in seen["raw"].replace("removedLabelIds", "")


def test_empty_key_is_rejected():
    with pytest.raises(ValueError):
        LinearClient("  ")


def _rpc_reply(request: httpx.Request, result) -> dict:
    rpc_id = json.loads(request.content)["id"]
    return {"result": result, "jsonrpc": "2.0", "id": rpc_id}


def _text_result(text: str, **extra) -> dict:
    return {"content": [{"type": "text", "text": text}], **extra}


def _mcp(handler) -> McpClient:
    return McpClient("http://mcp.test/mcp", transport=httpx.MockTransport(handler))


def test_call_parses_sse_body():
    def handler(request: httpx.Request) -> httpx.Response:
        reply = _rpc_reply(request, _text_result('{"found": true, "graph_id": "g"}'))
        body = f"event: message\ndata: {json.dumps(reply)}\n\n"
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

    assert _mcp(handler).call("graph_find", {"linear_issue_id": "x"}) == {
        "found": True,
        "graph_id": "g",
    }


def test_call_parses_plain_json_and_returns_raw_non_json_text():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_rpc_reply(request, _text_result("No graph g in the index.")))

    client = _mcp(handler)
    assert client.call("graph_get", {"graph_id": "g"}) == "No graph g in the index."
    assert client.graph_get("g") is None


@pytest.mark.parametrize(
    "reply",
    [
        lambda rid: {"jsonrpc": "2.0", "id": rid, "error": {"code": -32602, "message": "bad"}},
        lambda rid: {"jsonrpc": "2.0", "id": rid, "result": _text_result("boom", isError=True)},
    ],
)
def test_jsonrpc_error_and_is_error_raise(reply):
    def handler(request: httpx.Request) -> httpx.Response:
        rid = json.loads(request.content)["id"]
        return httpx.Response(200, text=f"event: message\ndata: {json.dumps(reply(rid))}\n\n")

    with pytest.raises(McpError):
        _mcp(handler).call("graph_find", {"linear_issue_id": "x"})


def test_graph_find_sends_tools_call_with_accept_header():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["accept"] = request.headers["Accept"]
        seen["content_type"] = request.headers["Content-Type"]
        seen["body"] = json.loads(request.content)
        reply = _rpc_reply(request, _text_result('{"found": false, "reason": "unknown"}'))
        return httpx.Response(200, text=f"event: message\ndata: {json.dumps(reply)}\n\n")

    assert _mcp(handler).graph_find(linear_issue_id="x") == {"found": False, "reason": "unknown"}
    assert seen["accept"] == "application/json, text/event-stream"
    assert seen["content_type"] == "application/json"
    assert seen["body"]["method"] == "tools/call"
    assert seen["body"]["params"] == {"name": "graph_find", "arguments": {"linear_issue_id": "x"}}


def _authed_mcp(handler, bearer: str = "substrate-bearer-value") -> McpClient:
    return McpClient("http://mcp.test/mcp", transport=httpx.MockTransport(handler), bearer=bearer)


def test_mcp_post_carries_substrate_bearer():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("Authorization")
        reply = _rpc_reply(request, _text_result('{"found": false, "reason": "unknown"}'))
        return httpx.Response(200, text=f"event: message\ndata: {json.dumps(reply)}\n\n")

    _authed_mcp(handler).graph_find(linear_issue_id="x")
    assert seen["auth"] == "Bearer substrate-bearer-value"


def test_mcp_post_without_bearer_sends_no_authorization_header():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("Authorization")
        reply = _rpc_reply(request, _text_result('{"found": false, "reason": "unknown"}'))
        return httpx.Response(200, text=f"event: message\ndata: {json.dumps(reply)}\n\n")

    _mcp(handler).graph_find(linear_issue_id="x")
    assert seen["auth"] is None


def test_resolve_substrate_bearer_prefers_unit_var_then_env_then_file_then_dir(tmp_path):
    from substrate_dispatcher.mcp import resolve_substrate_bearer

    token_file = tmp_path / "token"
    token_file.write_text("file-bearer\n")
    assert (
        resolve_substrate_bearer(
            {
                "SUBSTRATE_TOKEN_SUBSTRATE": "unit-bearer",
                "SUBSTRATE_TOKEN": "env-bearer",
                "SUBSTRATE_TOKEN_FILE": str(token_file),
            },
            read=lambda p: None,
        )
        == "unit-bearer"
    )
    assert (
        resolve_substrate_bearer(
            {"SUBSTRATE_TOKEN": "env-bearer", "SUBSTRATE_TOKEN_FILE": str(token_file)}, read=lambda p: None
        )
        == "env-bearer"
    )
    assert (
        resolve_substrate_bearer(
            {"SUBSTRATE_TOKEN_FILE": str(token_file)}, read=lambda p: open(p).read().strip()
        )
        == "file-bearer"
    )
    assert (
        resolve_substrate_bearer(
            {"SUBSTRATE_TOKENS_DIR": str(tmp_path)}, read=lambda p: "dir-bearer" if p.endswith("/substrate") else None
        )
        == "dir-bearer"
    )
    assert resolve_substrate_bearer({}, read=lambda p: None) is None


def test_linear_post_carries_raw_key_without_bearer_prefix():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers["Authorization"]
        return httpx.Response(200, json={"data": {"issues": {"nodes": []}}})

    assert _linear(handler).dispatch_candidates() == []
    assert seen["auth"] == KEY
    assert not seen["auth"].startswith("Bearer ")
