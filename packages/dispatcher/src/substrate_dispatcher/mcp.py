"""substrate-mcp client over stateless streamable HTTP: one JSON-RPC POST per tool call.

The server runs with ``sessionIdGenerator: undefined`` (server.ts handleMcp), so there is no
initialize handshake. Replies arrive either SSE-framed (``event: message`` + ``data: {...}``)
or as plain JSON; both are parsed here.
"""

from __future__ import annotations

import itertools
import json
import os
from typing import Any

import httpx

DEFAULT_MCP_URL = "http://127.0.0.1:7410/mcp"
ACCEPT = "application/json, text/event-stream"
DEFAULT_TOKENS_DIR = "/etc/substrate/tokens"
SUBSTRATE_SURFACE = "substrate"


class McpError(RuntimeError):
    """A tool call failed: transport error, JSON-RPC error or a tool result with isError."""


def _sse_messages(text: str) -> list[Any]:
    """JSON payloads of every SSE event; multi-line ``data:`` fields are joined per the SSE spec."""
    messages: list[Any] = []
    data_lines: list[str] = []

    def flush() -> None:
        if data_lines:
            payload = "\n".join(data_lines)
            data_lines.clear()
            try:
                messages.append(json.loads(payload))
            except ValueError:
                raise McpError(f"unparseable SSE data: {payload[:200]}") from None

    for line in text.splitlines():
        if line == "":
            flush()
        elif line.startswith("data:"):
            value = line[5:]
            data_lines.append(value[1:] if value.startswith(" ") else value)
    flush()
    return messages


def resolve_substrate_bearer(
    environ: dict[str, str] | None = None,
    read: Any = None,
) -> str | None:
    """The surface-``substrate`` bearer for the dispatcher loop.

    ``SUBSTRATE_TOKEN_SUBSTRATE`` first — the per-unit env file names it
    (manifest `dispatcher` row, D20-07) and systemd populates it — else the
    Phase 20 order (cf. ``packages/cli/src/token.ts``): ``SUBSTRATE_TOKEN``,
    then ``SUBSTRATE_TOKEN_FILE``, then the per-surface file in
    ``SUBSTRATE_TOKENS_DIR`` (default ``/etc/substrate/tokens/substrate``).
    Absent or unreadable means None (fail-open): the server refuses
    anonymous calls, and the refusal surfaces as an ``McpError``.
    The value is never logged; callers must not log it either.
    """
    env = environ if environ is not None else os.environ

    def first_line(path: str) -> str | None:
        try:
            with open(path, encoding="utf-8") as fh:
                line = fh.readline().strip()
                return line or None
        except OSError:
            # Absent or unreadable: None, as the docstring says.
            return None

    reader = read or first_line
    unit_var = (env.get("SUBSTRATE_TOKEN_SUBSTRATE") or "").strip()
    if unit_var:
        return unit_var
    direct = (env.get("SUBSTRATE_TOKEN") or "").strip()
    if direct:
        return direct
    token_file = (env.get("SUBSTRATE_TOKEN_FILE") or "").strip()
    if token_file:
        via_file = reader(token_file)
        if via_file:
            return via_file
    tokens_dir = (env.get("SUBSTRATE_TOKENS_DIR") or "").strip() or DEFAULT_TOKENS_DIR
    return reader(f"{tokens_dir}/{SUBSTRATE_SURFACE}")


class McpClient:
    def __init__(
        self,
        url: str = DEFAULT_MCP_URL,
        *,
        timeout: float = 15.0,
        transport: httpx.BaseTransport | None = None,
        bearer: str | None = None,
    ) -> None:
        self.url = url
        self._bearer = (bearer or "").strip() or None
        kwargs: dict[str, Any] = {"timeout": timeout}
        if transport is not None:
            kwargs["transport"] = transport
        self._client = httpx.Client(**kwargs)
        self._ids = itertools.count(1)

    @classmethod
    def from_env(cls) -> McpClient:
        return cls(
            os.environ.get("SUBSTRATE_MCP_URL") or DEFAULT_MCP_URL,
            bearer=resolve_substrate_bearer(),
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> McpClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def call(self, tool: str, arguments: dict[str, Any]) -> Any:
        """Call one tool; returns the parsed JSON of content[0].text, or the raw text if not JSON."""
        rpc_id = next(self._ids)
        request = {
            "jsonrpc": "2.0",
            "id": rpc_id,
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        }
        headers = {"Content-Type": "application/json", "Accept": ACCEPT}
        if self._bearer:
            headers["Authorization"] = f"Bearer {self._bearer}"
        try:
            resp = self._client.post(self.url, json=request, headers=headers)
        except httpx.HTTPError as exc:
            raise McpError(f"{tool}: request failed: {type(exc).__name__}: {exc}") from None
        if resp.status_code >= 400:
            raise McpError(f"{tool}: HTTP {resp.status_code}: {resp.text[:200]}")

        text = resp.text
        if text.lstrip().startswith("{"):
            try:
                messages = [json.loads(text)]
            except ValueError:
                raise McpError(f"{tool}: unparseable JSON body: {text[:200]}") from None
        else:
            messages = _sse_messages(text)
        reply = next(
            (m for m in messages if isinstance(m, dict) and m.get("id") == rpc_id),
            None,
        )
        if reply is None:
            raise McpError(f"{tool}: no JSON-RPC reply with id {rpc_id} in response")
        if "error" in reply:
            err = reply["error"] or {}
            raise McpError(f"{tool}: JSON-RPC error {err.get('code')}: {err.get('message')}")

        result = reply.get("result") or {}
        content = result.get("content") or []
        first = content[0].get("text", "") if content and isinstance(content[0], dict) else ""
        if result.get("isError"):
            raise McpError(f"{tool}: tool error: {str(first)[:200]}")
        try:
            return json.loads(first)
        except (TypeError, ValueError):
            # Not JSON: the tool's text is returned as it is, as the docstring says.
            return first

    def graph_find(
        self, *, linear_issue_id: str | None = None, linear_identifier: str | None = None
    ) -> dict[str, Any]:
        arguments: dict[str, Any] = {}
        if linear_issue_id:
            arguments["linear_issue_id"] = linear_issue_id
        if linear_identifier:
            arguments["linear_identifier"] = linear_identifier
        if not arguments:
            raise ValueError("graph_find needs linear_issue_id or linear_identifier")
        result = self.call("graph_find", arguments)
        if not isinstance(result, dict):
            raise McpError(f"graph_find: unexpected reply: {str(result)[:200]}")
        return result

    def graph_get(self, graph_id: str) -> dict[str, Any] | None:
        """The graph as a dict, or None when substrate-mcp has no such graph."""
        result = self.call("graph_get", {"graph_id": graph_id})
        if isinstance(result, dict):
            return result
        if isinstance(result, str) and result.startswith("No graph"):
            return None
        raise McpError(f"graph_get: unexpected reply: {str(result)[:200]}")
