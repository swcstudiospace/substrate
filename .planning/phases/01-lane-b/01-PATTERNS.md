# Phase 1: Lane B - Pattern Map

**Mapped:** 2026-09-24
**Files analyzed:** 20 (create/modify targets across 5 repos + agent-substrate)
**Analogs found:** 16 / 20 (4 flagged "No Analog Found" — genuinely new transport/config surface)

## Working notes the planner must not lose

1. **Tracked-source gate result — three repos are entirely uncommitted.** `git ls-files`
   returns empty for every path under `hermes-plugin/`, `omp-ultrathink/`, and
   `hermes-linear-connector/` (verified from `/root/src/repos`, the enclosing
   superproject git root for the first two: `git status --short` shows `?? hermes-plugin/`
   and `?? omp-ultrathink/`; `hermes-linear-connector` and `hermes-engineering-board` each
   have their own `.git` but `git log` returns `fatal: your current branch 'master' does
   not have any commits yet`). This is **not** the gitignored-mirror scenario the tracked-
   source gate is written for — there is no separate tracked origin to substitute; these
   are simply repos on disk that have never had a commit. Do not treat this as blocking:
   there is nowhere else these files live. But the plan must budget an explicit `git add`
   + first commit as part of any task touching them, and must stage only the exact paths
   touched (see Pitfall 2 in RESEARCH.md — `/root/src/repos` is a large, multi-repo,
   mixed-ownership superproject; `git add -A`/`.` there is unsafe).
2. `mcp/src/grok_hermes_connector/redactor.py` — the module RESEARCH.md says to reuse
   verbatim — is itself **untracked** in the `mcp` repo (`git ls-files` returns nothing for
   it, while `server.py`, `__init__.py`, `hermes_backend.py`, `pyproject.toml` in the same
   repo are all tracked). Reuse it as-is per RESEARCH.md's instruction, but flag it for a
   `git add` alongside whatever file change lands next to it.
3. Both hermes-plugin files are **mode 644, owned root**, not mode 0600 as CONTEXT.md's
   scope constraint states (verified via `stat`) — the discrepancy doesn't change the
   caveat: `/root/.hermes/plugins/prompt-uplift` is a symlink straight to
   `/root/src/repos/hermes-plugin` (not a copy), so every edit is live the instant it is
   saved, with Hermes sessions running against it. Same for
   `/root/.hermes/plugins/hermes_eng_board -> hermes-engineering-board/plugin/hermes_eng_board`.
   Treat every edit to these two files as hitting a running system.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `hermes-plugin/prompt_uplift/hook.py` | middleware (hook) | request-response + event-driven | *(self)* `hermes-plugin/__init__.py` L222-260 (`on_pre_llm_call`) | exact (extend existing wrapper, same file family) |
| `hermes-plugin/prompt_uplift/substrate.py` (NEW) | service/utility (fail-open HTTP client) | request-response | `claude-ultrathink/src/substrate/brief.ts` (TS shape) + `mcp/src/grok_hermes_connector/github_ext.py::_gh` (Python httpx idiom) | role-match (cross-language) |
| `hermes-plugin/tests/test_hook.py` | test | request-response | *(self)* existing `FakeCtx` pattern already in file | exact |
| `hermes-engineering-board/src/hermes_eng_board/hooks_session.py` | middleware (hook) | event-driven | *(self)* existing `handle_tool_call`/`handle_finalize` | exact (extend existing) |
| `hermes-engineering-board/src/hermes_eng_board/substrate_client.py` (NEW) | service (fail-open HTTP client) | request-response + event-driven | `hermes-engineering-board/src/hermes_eng_board/connector_client.py` | role-match, same repo |
| `hermes-engineering-board/tests/unit/test_hooks_session.py` | test | event-driven | *(self)* | exact |
| `omp-ultrathink/swe.ts` (`runAutonomousDiscovery`) | service | request-response | *(self)* same function, existing `calls.push` block | exact |
| omp↔substrate-mcp client registration | config | request-response | none — no MCP server registration exists anywhere on host (`mcpServers: {}` everywhere) | no analog |
| `claude-ultrathink-grok/hooks/uplift.ts` | hook (controller) | request-response | `claude-ultrathink/hooks/uplift.ts`'s sibling in the main checkout (same file, forked) + its own already-ported `src/substrate/brief.ts` | exact (same repo family) |
| `claude-ultrathink-grok/rules/substrate-brief.md` (NEW) | config (delivery channel) | file-I/O | `/root/.grok/rules/ultrathink.md` | exact — same delivery mechanism, already proven live on this host |
| `claude-ultrathink-grok/skills/substrate-brief/SKILL.md` (NEW) | config (skill) | file-I/O | `claude-ultrathink-grok/skills/ultrathink-kickoff/SKILL.md` | exact |
| `mcp/src/grok_hermes_connector/server.py` (add 4 tools + `graph_id` param) | controller (MCP tool server) | request-response + event-driven | *(self)* `handoff_to_hermes` (L333-601) and `get_task`/`list_recent_handoffs` (L732-803) tool registration pattern | exact |
| `mcp/src/grok_hermes_connector/substrate_ext.py` (NEW) | service (fail-open HTTP client, forwarding) | request-response | `mcp/src/grok_hermes_connector/github_ext.py` / `supabase_ext.py` | exact — same repo, same `_ext.py` convention |
| `mcp/src/grok_hermes_connector/pyproject.toml` | config | — | *(self)*, one-line version fix | exact |
| `mcp/tests/test_handoff_pack.py` | test | request-response | *(self)* existing test cases for `handoff_to_hermes` | exact |
| `agent-substrate/packages/collectors/src/muse.ts` (NEW) | service (collector, file-writer) | file-I/O | `packages/collectors/src/grok.ts` | role-match (drop the tail-and-emit half, keep fail-open fetch + write) |
| `agent-substrate/packages/collectors/src/herdr.ts` (NEW) | service (collector) | streaming / event-driven | `packages/collectors/src/grok.ts` (offset/state/emit loop shape) | role-match; transport (Unix socket ND-JSON) has no on-host precedent |
| `agent-substrate/packages/collectors/src/herdr-map.ts` (NEW) | transform (event mapper) | event-driven | `packages/collectors/src/grok-map.ts` | exact shape, new payload schema |
| `agent-substrate/packages/collectors/src/herdr-map.test.ts` / `muse.test.ts` (NEW) | test | — | `packages/collectors/src/grok-map.test.ts` | exact |
| `agent-substrate/infra/vps/substrate-collector-herdr.service` (NEW) | config (systemd unit) | — | `agent-substrate/infra/vps/substrate-collector-grok.service` | exact |

## Pattern Assignments

### `hermes-plugin/prompt_uplift/hook.py` (middleware, request-response + event-driven)

**Analog:** the file's own sibling wiring in `hermes-plugin/__init__.py` — no external file needed; this is an additive change inside the hook that already exists. **Caveat:** untracked in git (see Working note 1); symlinked live (Working note 3).

**Existing registration this must NOT disturb** (`__init__.py:222-260`, verified):
```python
def on_pre_llm_call(
	user_message: str = "",
	conversation_history=None,
	parent_session_id: str = "",
	platform: str = "",
	**kwargs,
):
	try:
		session = _read_session(ctx)
		uplift_complete, think_complete = build_completers(ctx, session, session)
		injected = handle_pre_llm_call(
			user_message, session, uplift_complete,
			conversation_history=conversation_history,
			parent_session_id=parent_session_id or "",
			platform=platform or "",
			max_chars=int(session["max_chars"]),
			think_enabled=bool(session["think_enabled"]),
			...
			issues_enabled=bool(session["issues_enabled"]),
			create_task=hermes_kanban_create if session["issues_enabled"] else None,   # D1: do not remove
			...
		)
		_write_session(ctx, session)
		...
		return injected
	except Exception:
		logger.warning("prompt-uplift pre_llm_call failed", exc_info=True)
		return None
ctx.register_hook("pre_llm_call", on_pre_llm_call)
```
Per D1, `hermes_kanban_create` and `write_gsd_milestone` stay exactly as-is — add the brief
fetch/events_emit call inside `handle_pre_llm_call` (or as a new step `on_pre_llm_call`
calls before/after it), not by touching the `issues_enabled`/`gsd_enabled` branches.

**Core pattern to extend** (`prompt_uplift/hook.py:91-176`, `handle_pre_llm_call`, verified
read in full): the existing fail-open convention inside this very file, already used for
`run_gsd_write` (lines 68-88):
```python
def run_gsd_write(uplift, graph, gsd_write, *, root=None):
	"""Call the milestone writer fail-open and normalise the outcome ..."""
	record = {"written": [], "skipped_reason": None, "error": None, "root": ...}
	try:
		outcome = gsd_write(uplift, graph)
		record["written"] = [str(f) for f in (getattr(outcome, "written", None) or [])]
		record["skipped_reason"] = getattr(outcome, "skipped_reason", None)
	except Exception as exc:  # fail-open: never block the turn
		record["error"] = f"{type(exc).__name__}: {exc}"
	return record
```
**Copy this exact shape** for the new `fetch_brief`/`emit_uplift_event` call sites: wrap in
try/except, put the outcome into `session[...]` (mirroring `session["last_gsd"]`), never let
an exception propagate into `handle_pre_llm_call`'s return value. Inject the returned brief
text into `addenda` (line 127's list) the same way `THINK_ADDENDUM` is appended (line 149) —
append-only, additive, no restructuring of the XML assembly.

**Error handling pattern:** the outer `on_pre_llm_call` in `__init__.py` already wraps the
whole hook in `try/except Exception: logger.warning(..., exc_info=True); return None` — the
substrate call doesn't need its own top-level guard as long as it also has the inner
fail-open guard shown above (defense in depth, matching the existing `run_gsd_write` model).

---

### `hermes-plugin/prompt_uplift/substrate.py` (NEW — service/utility, request-response)

**Analog:** `claude-ultrathink/src/substrate/brief.ts` for the *shape* (fail-open, env-driven
config, short timeout) ported to Python idiom per
`mcp/src/grok_hermes_connector/github_ext.py::_gh` (httpx, `transport` injection point for
tests, dict-shaped error returns instead of raising).

**Imports pattern** (from `github_ext.py:1-11`):
```python
from __future__ import annotations
from typing import Any
import httpx
```

**Core pattern to copy** (fail-open HTTP call, adapted from `github_ext.py:22-54` +
`claude-ultrathink/src/substrate/brief.ts:40-62`):
```python
import os
import httpx

DEFAULT_URL = "http://127.0.0.1:7410"
DEFAULT_TIMEOUT_S = 1.5

def _base_url() -> str:
	return os.environ.get("SUBSTRATE_URL", DEFAULT_URL).rstrip("/")

def _auth_headers() -> dict[str, str]:
	token = os.environ.get("SUBSTRATE_TOKEN", "").strip()
	return {"authorization": f"Bearer {token}"} if token else {}

async def fetch_brief(*, repo: str | None, branch: str | None, graph_id: str | None) -> str:
	if os.environ.get("SUBSTRATE_DISABLED") == "1":
		return ""
	try:
		async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_S) as client:
			resp = await client.post(
				f"{_base_url()}/brief",
				json={"repo": repo, "branch": branch, "graph_id": graph_id, "surface": "hermes"},
				headers=_auth_headers(),
			)
		return resp.text.strip() if resp.status_code == 200 else ""
	except httpx.HTTPError:
		return ""  # fail-open: a missing substrate never blocks a turn
```
Mirror the same shape for `emit_event`, matching `claude-ultrathink/src/substrate/brief.ts`'s
`emitEvent` field names (`kind`, `summary`, `surface`, `session_id`, `graph_id`, `node_id`,
`repo`, `branch`, `payload`) so the two languages emit an identical JSON body.

**Error handling pattern:** catch `httpx.HTTPError` only (not bare `Exception`) at this layer
— matches `github_ext.py:47`'s `except httpx.HTTPError as exc:` — and let the *caller*
(`hook.py`'s `run_gsd_write`-style wrapper) own the broader fail-open guard.

---

### `hermes-plugin/tests/test_hook.py` (test)

**Analog:** the file's own existing `FakeCtx`/fixture pattern (RESEARCH.md's Validation
Architecture table confirms this file already exists and should be extended, not replaced).
No excerpt needed beyond following the existing fixture naming already in the file.

---

### `hermes-engineering-board/src/hermes_eng_board/hooks_session.py` (middleware, event-driven)

**Analog:** itself — extend `handle_tool_call`/`handle_finalize` additively.

**Imports pattern** (verified, lines 1-17):
```python
from __future__ import annotations
import logging
from typing import Any, Callable
from hermes_eng_board.config import Settings
from hermes_eng_board.factory import build_deps, load_default_config
from hermes_eng_board.pipeline import PipelineResult, run_session_pipeline
from hermes_eng_board.work_unit_store import (
	append_tool, append_user_message, load_work_unit, new_work_unit, save_work_unit,
)
```

**Core pattern** (verified, lines 41-58 — `handle_tool_call`):
```python
def handle_tool_call(tool_name=None, session_id=None, **kwargs) -> None:
	sid = session_id or _session_id_from_kwargs(kwargs)
	name = tool_name or kwargs.get("tool") or kwargs.get("name")
	if not sid or not name:
		return
	unit = load_work_unit(sid)
	append_tool(unit, str(name))
	save_work_unit(unit)
```
Add the `events_emit` forward call as one more statement in this function (and in
`handle_session_start`/`handle_finalize`), keeping the existing `work_unit_store` write —
this is additive retargeting, not a replacement (RESEARCH.md's Architectural Responsibility
Map: "retargeting to `events_emit` is additive at the hook boundary").

**Error handling pattern:** `handle_finalize` (lines 61-93) already wraps
`run_session_pipeline` with a `finally: client.close()` and returns `PipelineResult` — thread
the new substrate call through the same `try/...finally` so a substrate outage cannot leak an
unclosed `ConnectorClient`.

---

### `hermes-engineering-board/src/hermes_eng_board/substrate_client.py` (NEW — service, request-response)

**Analog:** `hermes-engineering-board/src/hermes_eng_board/connector_client.py` (same repo,
same "one small httpx-backed client class" convention already used for the Linear connector).

**Full pattern to copy** (verified, lines 1-54 — copy the shape, not the Linear-specific
methods):
```python
from __future__ import annotations
from typing import Any
import httpx

class ConnectorClient:
	def __init__(self, base_url: str, *, transport: httpx.BaseTransport | None = None, timeout: float = 30.0) -> None:
		kwargs: dict[str, Any] = {"base_url": base_url.rstrip("/"), "timeout": timeout}
		if transport is not None:
			kwargs["transport"] = transport
		self._client = httpx.Client(**kwargs)

	def close(self) -> None:
		self._client.close()

	def health(self) -> dict[str, Any]:
		for path in ("/v1/health", "/health"):
			resp = self._client.get(path)
			if resp.status_code == 200:
				return resp.json()
		resp.raise_for_status()
		return {}
```
For the substrate client: `base_url` defaults to `http://127.0.0.1:7410`, add an
`emit_event(...)` method mirroring `ensure_issue`'s shape (build a payload dict, POST, raise
`RuntimeError` on `>=400` — lines 34-53) — but per the substrate's fail-open contract, catch
that `RuntimeError`/`httpx.HTTPError` at the `hooks_session.py` call site, not inside this
client, exactly as `handoff_to_hermes` callers do in `mcp/server.py`.

---

### `omp-ultrathink/swe.ts` (`runAutonomousDiscovery`) (service, request-response)

**Analog:** itself — the existing `calls.push` block is the literal template.

**Core pattern** (verified, `swe.ts:63-109`):
```typescript
const available = new Set(mcp.selectTools().map((tool) => tool.name));
const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
if (repo && available.has("github_repo_info")) {
	calls.push({ name: "github_repo_info", args: { owner: repo.owner, repo: repo.repo } });
}
if (available.has("linear_issues_list")) {
	calls.push({ name: "linear_issues_list", args: {} });
}
// ADD: if (available.has("memory_brief")) calls.push({ name: "memory_brief", args: { repo: repo?.repo, branch: snapshot.branch } });

const budget = AbortSignal.timeout(DISCOVERY_BUDGET_MS);
for (const call of calls.slice(0, 3)) {
	if (signal?.aborted || budget.aborted) break;
	const callSignal = AbortSignal.any([...]);
	try {
		const text = await mcp.call(call.name, call.args, callSignal);
		const max = call.name.startsWith("linear_") ? 800 : 1800;
		snapshot.toolResults.push({ name: call.name, ok: true, text: clip(text, max) });
	} catch (error) {
		snapshot.toolResults.push({ name: call.name, ok: false, text: error instanceof Error ? error.message : String(error) });
	}
}
```
Gate `memory_brief` behind `available.has("memory_brief")` exactly like the other three
calls — this makes the addition inert until the MCP client registration (see "No Analog
Found" below) actually lists substrate-mcp's tools.

**Caveat:** `omp-ultrathink/swe.ts` is untracked in git (Working note 1) — same "stage only
this exact path" discipline applies.

---

### `claude-ultrathink-grok/hooks/uplift.ts` (hook/controller, request-response)

**Analog:** its own already-ported, untested-but-present `src/substrate/brief.ts` (byte-
identical to `claude-ultrathink/src/substrate/brief.ts`, confirmed by RESEARCH Finding 4) —
the fetch call itself needs no new code, only wiring plus a delivery-path fix.

**What NOT to copy** (the dead pattern, confirmed no-op on Grok):
```typescript
// claude-ultrathink's own pattern — DO NOT port verbatim into uplift.ts:
process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: brief } }));
// Grok Build's UserPromptSubmit hook discards stdout entirely (Finding 4, verified).
```

**What TO copy instead** — the file-plus-rules delivery channel already proven live on this
host by a *different* installed ultrathink plugin (`/root/.grok/installed-plugins/
ultrathink-53674ac1`), whose rule file is:
```markdown
# Source: /root/.grok/rules/ultrathink.md (verified, read in full — the live, working pattern)
On every non-trivial user request, the ultrathink UserPromptSubmit hook writes an XML spec to:
- `$GROK_PLUGIN_DATA/last-spec.xml` (when set)
- `~/.grok/plugin-data/ultrathink/last-spec.xml`
If `last-action.json` has `"action": "uplift"` and the spec root is ...:
1. Execute that XML as the spec. Do not reprint it.
```
Apply the identical shape for the brief: `uplift.ts`'s `UserPromptSubmit` handler calls
`fetchBrief` from `src/substrate/brief.ts`, writes the result to
`$GROK_PLUGIN_DATA/substrate-brief.md` (or the plugin-data path if unset), and a new rule
file (see next section) tells the model to read it. This sidesteps the stdout-discard
problem entirely — no stdout write is needed for the brief.

---

### `claude-ultrathink-grok/rules/substrate-brief.md` (NEW — config, file-I/O)

**Analog:** `/root/.grok/rules/ultrathink.md` (full file quoted above) — copy its structure
(imperative numbered instructions, explicit file paths, explicit trigger condition) verbatim
in shape, substituting the substrate brief's path and always-on trigger (no `last-action.json`
gate needed — brief injection is unconditional per D1, unlike uplift's XML spec).

---

### `claude-ultrathink-grok/skills/substrate-brief/SKILL.md` (NEW — config, file-I/O)

**Analog:** `claude-ultrathink-grok/skills/ultrathink-kickoff/SKILL.md` (tracked, exists in
repo already — read its frontmatter/structure directly when writing the new skill; same repo,
same convention, no cross-repo translation needed).

---

### `mcp/src/grok_hermes_connector/server.py` (controller/MCP tool server, request-response + event-driven)

**Analog:** itself — the existing `@mcp.tool` registration convention, verified at multiple
call sites (`server.py:335-349` for `handoff_to_hermes`, `:732-747` for `get_handoff_status`/
`list_recent_handoffs`).

**Core pattern to copy** (tool registration shape, verified structure around line 732-748):
```python
@mcp.tool(
	name="get_handoff_status",
	...
)
async def get_handoff_status(handoffId: str) -> dict[str, Any]:
	"""
	handoffId: Id returned by handoff_to_hermes.
	"""
	...

@mcp.tool(
	name="list_recent_handoffs",
	...
)
async def list_recent_handoffs(limit: int = 20, tenant_id: str | None = None) -> dict[str, Any]:
	...
```
Add `memory_brief`, `memory_write`, `events_emit`, `graph_get` as four new `@mcp.tool`-
decorated async functions in this same style, each delegating to the new
`substrate_ext.py` module (below) — do not inline `httpx` calls directly in `server.py`,
matching how `github_ext.py`/`supabase_ext.py` are kept separate from `server.py` for every
other forwarded service.

**`handoff_to_hermes` Graph ID addition:** the function signature and `record_tool_call`
instrumentation pattern is at `server.py:349-372` — add a `graph_id: str | None = None`
parameter following the same optional-parameter style already used for `tenant` (visible in
`with span("tool.handoff_to_hermes", tenant=tenant):` at line 372), and thread it into the
`store.update_meta(...)` / audit call the same way `hermesPid`, `dispatchPid` etc. are already
threaded through `hermes_backend.py`'s `submit_hermes_background` (verified, lines 462-475).

---

### `mcp/src/grok_hermes_connector/substrate_ext.py` (NEW — service, request-response)

**Analog:** `mcp/src/grok_hermes_connector/github_ext.py` (verified, read in full) — same
`_ext.py` naming and internal-helper convention as `github_ext.py`/`supabase_ext.py`/
`greptile_ext.py`, all of which wrap one external service behind httpx.

**Imports pattern** (verified, `github_ext.py:1-11`):
```python
from __future__ import annotations
import base64
from typing import Any
from urllib.parse import quote
import httpx
from grok_hermes_connector.services import GITHUB_API_BASE, _TIMEOUT, github_token
```

**Core pattern — one call, normalized dict outcome, no raised exceptions** (verified,
`github_ext.py:22-54`):
```python
async def _gh(method, path, *, json_body=None, params=None, extra_headers=None, transport=None) -> dict[str, Any]:
	token = github_token()
	if not token:
		return _missing_token()
	headers = {"Authorization": f"Bearer {token}", ...}
	try:
		async with httpx.AsyncClient(timeout=_TIMEOUT, transport=transport) as client:
			resp = await client.request(method, f"{GITHUB_API_BASE}{path}", headers=headers, json=json_body, params=params)
	except httpx.HTTPError as exc:
		return {"error": "upstream_unreachable", "service_url": path, "message": str(exc)}
	if resp.status_code >= 400:
		return {"error": "upstream_error", "status": resp.status_code, "detail": resp.text[:2000]}
	try:
		return resp.json()
	except ValueError:
		return {"status_code": resp.status_code, "body": resp.text[:4000]}
```
Copy this exact `{"error": "..."}` dict-return convention (not exceptions) for
`substrate_ext.py`'s `brief(...)`, `write(...)`, `emit(...)`, `graph_get(...)` — this is the
house style every other forwarded service in this file already follows, and matches the
substrate's own fail-open contract (never raise, always return something the tool can hand
back to the model).

**Redaction requirement:** before any payload built here reaches `events_emit`'s call, route
it through `mcp/src/grok_hermes_connector/redactor.py`'s `redact_text` (verified, full file
quoted in Shared Patterns below) — this is the one non-negotiable cross-cutting rule
RESEARCH.md calls out by name ("Reuse the connector's redactor.py patterns").

---

### `mcp/src/grok_hermes_connector/pyproject.toml` (config)

**Analog:** itself. One-line fix: `version = "0.3.3"` → `version = "0.4.0"` to match
`__version__ = "0.4.0"` already in `src/grok_hermes_connector/__init__.py` (verified drift,
RESEARCH Finding 8). Trivial; no excerpt needed beyond the single line.

---

### `mcp/tests/test_handoff_pack.py` (test)

**Analog:** itself — extend existing test cases for `handoff_to_hermes` with a `graph_id`
argument/assertion; file is tracked and already covers this function (verified,
`git ls-files` confirms `tests/test_handoff_pack.py` tracked).

---

### `agent-substrate/packages/collectors/src/muse.ts` (NEW — service/collector, file-I/O)

**Analog:** `packages/collectors/src/grok.ts` (tracked, running as
`substrate-collector-grok.service`) — reuse its fail-open fetch shape but invert the
direction: fetch `/brief` and *write* `.substrate/BRIEF.md` into the target repo, instead of
tailing a log and POSTing `/events`.

**Fail-open fetch to reuse verbatim** (`grok.ts:92-107`):
```typescript
async function emit(event: EventInput): Promise<boolean> {
	try {
		const response = await fetch(`${SUBSTRATE_URL}/events`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(process.env.SUBSTRATE_TOKEN ? { authorization: `Bearer ${process.env.SUBSTRATE_TOKEN}` } : {}) },
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(3000),
		});
		return response.ok;
	} catch {
		return false;
	}
}
```
For `muse.ts`, swap this for a `POST /brief` fetch (same headers/timeout convention) whose
response text is written via `writeFileSync` — copy `grok.ts`'s own `saveOffsets` pattern
(`grok.ts:38-45`) for the "write, but never let a filesystem failure crash the collector"
shape:
```typescript
function saveOffsets(offsets: Offsets): void {
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, JSON.stringify(offsets));
	} catch (cause) {
		process.stderr.write(`[grok-collector] cannot persist offsets: ${String(cause)}\n`);
	}
}
```

**CLI/entrypoint pattern to copy** (`grok.ts:172-187`, shebang + `--once`/`--watch` args):
```typescript
#!/usr/bin/env bun
const args = process.argv.slice(2);
const watch = args.includes("--watch");
...
if (watch) {
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		...
	}
}
```

---

### `agent-substrate/packages/collectors/src/herdr.ts` (NEW — service/collector, streaming/event-driven)

**Analog:** `packages/collectors/src/grok.ts` for the overall collector shape (state file,
poll/watch CLI, fail-open `emit()`) — **the Unix-socket ND-JSON transport itself has no
on-host precedent** (grep across `packages/` for `createConnection`/`net.Socket`/`.sock`
returned nothing); this half is genuinely new and must be built from RESEARCH.md's D2 socket
contract directly (`node:net` `createConnection` to `~/.config/herdr/herdr.sock`, one JSON
object per line, race-free bootstrap: subscribe → ack → buffer → `session.snapshot` →
apply buffered, per CONTEXT.md D2).

**Reuse from `grok.ts` verbatim:** `loadOffsets`/`saveOffsets` (lines 30-45, for tracking
which herdr events have already been forwarded across restarts) and the `emit()` fail-open
POST (lines 92-107, unchanged — herdr events still land on `/events`).

**Re-fetch-on-error requirement** (RESEARCH Finding 9 / Security Domain): per herdr's own
documented issue (#4344, one bad pane fails the entire subscription), any `events.subscribe`
error must trigger a `session.snapshot` re-fetch rather than trusting the next pushed event —
there is no existing retry/backoff pattern in this codebase to copy for this; write it fresh,
modeled on `grok.ts`'s `--watch` loop's simple retry-by-polling shape (lines 180-187) but
replacing the timer with a socket-reconnect-on-error handler.

---

### `agent-substrate/packages/collectors/src/herdr-map.ts` (NEW — transform, event-driven)

**Analog:** `packages/collectors/src/grok-map.ts` (tracked) — same "one source event → one
`EventInput` or `null` to drop" shape, same deliberate-drop-list-with-reasons convention.

**Pattern to copy** (verified, `grok-map.ts:75-157`, structural shape only — the `DROPPED`
set and `switch` are the reusable idiom):
```typescript
const DROPPED = new Set([ /* ...noisy event types, each with a one-line reason comment... */ ]);

export function mapGrokEvent(event: GrokEvent, context: GrokContext): EventInput | null {
	const type = event.type;
	if (!type || DROPPED.has(type)) return null;
	const base = { surface: "grok-build" as const, session_id: context.sessionId, repo: context.repo, branch: context.branch, ts: event.ts };
	switch (type) {
		case "tool_completed": return { ...base, kind: "tool.call", summary: `...`, payload: { ... } };
		...
		default: return { ...base, kind: "note", summary: `grok ${type}` }; // unknown types are recorded, not dropped silently
	}
}
```
For `herdr-map.ts`: `surface: "herdr"`, map `pane.agent_detected`/`pane.agent_status_changed`/
`pane.output_matched`/`pane.exited` (the four events CONTEXT.md D2 names as relevant) through
the same switch, defaulting unknowns to a `note` kind exactly as `grok-map.ts` does — do not
silently drop unrecognized herdr event types, per the same reasoning already documented in
this file's own header comment.

---

### Test files: `herdr-map.test.ts` / `muse.test.ts` (NEW — test)

**Analog:** `packages/collectors/src/grok-map.test.ts` (tracked) — same per-event-type
table-driven assertion style; read that file directly when writing the new ones (small,
single Read call suffices at execution time).

---

### `agent-substrate/infra/vps/substrate-collector-herdr.service` (NEW — config, systemd unit)

**Analog:** `agent-substrate/infra/vps/substrate-collector-grok.service` (tracked, live).

**Full pattern to copy** (verified, entire unit read):
```ini
[Unit]
Description=Agent Substrate — Grok Build session collector
After=substrate-mcp.service
Wants=substrate-mcp.service
StartLimitIntervalSec=0

[Service]
Type=simple
EnvironmentFile=/etc/substrate/substrate.env
WorkingDirectory=/root/src/repos/agent-substrate
ExecStart=/root/.local/share/reflex/bun/bin/bun packages/collectors/src/grok.ts --watch
Restart=always
RestartSec=5
StateDirectory=substrate
Environment=SUBSTRATE_COLLECTOR_STATE=/var/lib/substrate/grok-offsets.json
StandardOutput=journal
StandardError=journal
SyslogIdentifier=substrate-collector-grok
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
```
For herdr: rename `Description`/`SyslogIdentifier`/`ExecStart` (`herdr.ts --watch`), change
`Environment=SUBSTRATE_COLLECTOR_STATE=.../herdr-offsets.json`, and add `AF_UNIX` is already
present in `RestrictAddressFamilies` (needed for the herdr socket — confirm it stays, unlike
a hypothetical TCP-only collector). This unit install is itself gated behind the
`checkpoint:human-verify` on herdr's install method (D2) — do not schedule it before that
checkpoint clears.

## Shared Patterns

### Fail-open substrate client (TypeScript)
**Source:** `claude-ultrathink/src/substrate/brief.ts` (full file, quoted in RESEARCH.md and
above)
**Apply to:** `muse.ts`, `herdr.ts`, `claude-ultrathink-grok/hooks/uplift.ts`, any other new
TS-side substrate caller
**Rule:** every call wraps `fetch` in try/catch, respects `SUBSTRATE_DISABLED=1`, uses
`AbortSignal.timeout(...)`, returns a neutral value (`""` or `false`) on any failure — never
throws.

### Fail-open substrate client (Python)
**Source:** synthesized from `mcp/src/grok_hermes_connector/github_ext.py::_gh` (httpx idiom)
+ `claude-ultrathink/src/substrate/brief.ts` (field names/timeout values) — no single
existing Python file does this against `substrate-mcp` yet; this is the pattern to
originate, not an existing file to copy wholesale.
**Apply to:** `hermes-plugin/prompt_uplift/substrate.py`,
`hermes-engineering-board/src/hermes_eng_board/substrate_client.py`,
`mcp/src/grok_hermes_connector/substrate_ext.py`
**Rule:** catch `httpx.HTTPError` (not bare `Exception`) at the client layer, return a dict
with an `"error"` key or empty string rather than raising; let the *caller* apply the
broader fail-open guard consistent with `hook.py`'s existing `run_gsd_write` convention.

### Redaction before emit
**Source:** `mcp/src/grok_hermes_connector/redactor.py` (full file, quoted below) — **flagged
untracked in git** (Working note 2), reuse as-is regardless.
```python
"""Redact secrets from untrusted Grok transcripts before persist."""
REDACTED = "[REDACTED]"
_PEM_RE = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----", re.DOTALL)
_TSKEY_RE = re.compile(r"tskey-[A-Za-z0-9_-]+")
_PASSWORD_COLON_RE = re.compile(r"(?i)(password\s*[:=]\s*)(\S+)")
...
def redact_text(text: str) -> str:
	if not text: return text
	out = _PEM_RE.sub(REDACTED_PEM, text)
	out = _TSKEY_RE.sub(REDACTED_TSKEY, out)
	out = _PASSWORD_COLON_RE.sub(rf"\1{REDACTED}", out)
	...
	return out
```
**Apply to:** every new emit path on the Python side (`substrate_client.py`,
`substrate_ext.py`) before a payload leaves the process — RESEARCH.md's explicit
instruction, no new redaction pass should be written.

### Hook registration must stay additive (Hermes)
**Source:** `hermes-plugin/__init__.py:262-286` (full registration block, quoted above)
**Apply to:** `hermes-plugin/prompt_uplift/hook.py`
**Rule:** `ctx.register_command("issues", ...)` and `ctx.register_hook("pre_llm_call",
on_pre_llm_call)` must remain unchanged in shape; the brief/events addition is new statements
inside the existing function bodies, never a new `register_hook`/`register_command` call and
never a removal of `hermes_kanban_create`'s wiring (D1).

### Collector shape: state file + fail-open POST + `--once`/`--watch` CLI
**Source:** `packages/collectors/src/grok.ts` (full file, quoted above)
**Apply to:** `muse.ts`, `herdr.ts`
**Rule:** every new collector persists its own offset/cursor state under
`/var/lib/substrate/<name>-offsets.json` (or equivalent), never crashes on a write failure
(log to stderr and continue), and exposes the same `--once`/`--watch`/`--backfill`-style CLI
convention so the systemd units stay uniform.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| omp-ultrathink ↔ substrate-mcp MCP client registration (config, not yet a named file) | config | request-response | No MCP server is registered anywhere on this host (`mcpServers: {}` in every `.claude.json`/`.pi` config found); `omp-ultrathink/mcp-client.ts`'s `UltrathinkMcpClient` class exists to *consume* whatever is registered, but nothing populates the registration itself — this is new wiring, not a pattern to copy. Planner should treat "how omp/Pi registers an MCP server" as its own research spike if RESEARCH.md doesn't already answer it. |
| `agent-substrate/packages/collectors/src/herdr.ts`'s Unix-socket ND-JSON transport layer specifically (the collector shell around it does have an analog, see above) | service | streaming | No `createConnection`/`net.Socket`/`.sock` usage exists anywhere under `packages/` on this host — build directly from CONTEXT.md D2's documented socket contract (subscribe → ack → buffer → snapshot → apply), not from an existing file. |
| Muse `SessionStart` hook injection path (Design 2 in RESEARCH Finding 7, if chosen over the pure-filesystem Design 1) | middleware (hook) | request-response | Muse is a closed binary; only hook *event names* were confirmed via `strings`, not the data path. `muse plugins hook test` (Open Question 3 / Assumption A2) must be run empirically before any file pattern can be assigned here — do not plan this path until that probe resolves it. Design 1 (pure filesystem convention, `muse.ts` above) requires no Muse-side file at all and is the safer default. |
| Grok Build older-plugin conflict (`ultrathink-53674ac1` firing alongside the new `substrate-brief` rule/skill) | — | — | Not a file to pattern-match; a coordination/removal decision (Finding 4's fourth bullet) the planner must sequence, not something to copy code from. |

## Metadata

**Analog search scope:** `agent-substrate/packages/collectors/src`, `agent-substrate/infra/vps`,
`claude-ultrathink/src/substrate`, `claude-ultrathink-grok/{hooks,skills,src/substrate}`,
`hermes-plugin/{__init__.py,prompt_uplift}`, `hermes-engineering-board/src/hermes_eng_board`,
`omp-ultrathink/{swe.ts,native-catalog.ts,mcp-client.ts}`,
`mcp/src/grok_hermes_connector/*.py`, `/root/.grok/rules`, `/root/.hermes/plugins`
**Files scanned:** ~45 read/grepped this session (see individual excerpts above for exact
paths and line numbers)
**Pattern extraction date:** 2026-09-24
**Tracked-source gate:** applied to every path above via `git ls-files`/`git status`/
`git log` from each repo's own root; three repos (`hermes-plugin`, `omp-ultrathink`,
`hermes-linear-connector`) returned fully untracked/uncommitted rather than a gitignored
mirror — see Working note 1 for why these are still named as edit targets, not substituted.
