"""The ``/slo`` burn probe behind the dispatch storm-breaker (U4, SPE-10477).

One GET per tick to the substrate's ``/slo`` route — the same origin and bearer the
MCP client is built from — parsed for burn SLOs reporting ``breached``. Every
failure is fail-open: an unreachable or malformed snapshot trips nothing, it only
declines to trip the breaker, exactly like every other observability read on the
dispatch path.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from .mcp import DEFAULT_MCP_URL, resolve_substrate_bearer

DEFAULT_SLO_TIMEOUT_SECONDS = 5.0

# The burn objective ids the substrate serves in the ``burn`` array of GET /slo.
BURN_TOKENS_ID = "burn.tokens"
BURN_COST_ID = "burn.cost_usd"
BURN_SLO_IDS = frozenset({BURN_TOKENS_ID, BURN_COST_ID})


class SloUnreachable(RuntimeError):
    """The /slo snapshot could not be fetched or parsed; the caller fails open."""


def slo_url(mcp_url: str) -> str:
    """The /slo route on the same origin as the MCP endpoint: ``.../mcp`` → ``.../slo``."""
    parts = urlsplit(mcp_url)
    return urlunsplit((parts.scheme, parts.netloc, "/slo", "", ""))


def fetch_slo_snapshot(
    url: str,
    *,
    bearer: str | None = None,
    transport: httpx.BaseTransport | None = None,
    timeout: float = DEFAULT_SLO_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """GET one /slo snapshot; raise :class:`SloUnreachable` on any failure.

    Transport errors, non-2xx replies, unparseable bodies and non-object bodies all
    raise: the breaker needs either a verdict or an exception, never a guess.
    """
    headers = {"Accept": "application/json"}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    kwargs: dict[str, Any] = {"timeout": timeout}
    if transport is not None:
        kwargs["transport"] = transport
    try:
        with httpx.Client(**kwargs) as client:
            response = client.get(url, headers=headers)
            response.raise_for_status()
            snapshot = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise SloUnreachable(f"{url}: {type(exc).__name__}: {exc}") from None
    if not isinstance(snapshot, dict):
        raise SloUnreachable(f"{url}: snapshot is {type(snapshot).__name__}, not an object")
    return snapshot


def burn_breaches(snapshot: Mapping[str, Any]) -> list[str]:
    """Ids of the burn SLOs reporting ``breached``, in the order the snapshot lists them.

    Only entries this dispatcher knows as burn objectives count, and only on their
    own ``status`` word — every other shape (missing ``burn``, a non-list, a stray
    entry) answers ``[]``, which stands down the breaker rather than tripping it.
    """
    entries = snapshot.get("burn")
    if not isinstance(entries, list):
        return []
    return [
        entry["id"]
        for entry in entries
        if isinstance(entry, dict) and entry.get("id") in BURN_SLO_IDS and entry.get("status") == "breached"
    ]


def make_slo_fetcher(
    *,
    environ: Mapping[str, str] | None = None,
    transport: httpx.BaseTransport | None = None,
    timeout: float = DEFAULT_SLO_TIMEOUT_SECONDS,
) -> Callable[[], dict[str, Any]]:
    """A per-tick snapshot fetcher built from the MCP client's own URL and bearer config.

    ``SUBSTRATE_MCP_URL`` names the origin and :func:`resolve_substrate_bearer`
    names the token — the exact pair :meth:`McpClient.from_env` uses, so the probe
    can never be pointed somewhere the tool calls do not already go.
    """
    env = environ if environ is not None else os.environ
    url = slo_url(env.get("SUBSTRATE_MCP_URL") or DEFAULT_MCP_URL)
    bearer = resolve_substrate_bearer(env)

    def fetch() -> dict[str, Any]:
        return fetch_slo_snapshot(url, bearer=bearer, transport=transport, timeout=timeout)

    return fetch
