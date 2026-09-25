# Phase 2: claims-and-dispatch — Pattern Map

**Mapped:** 2026-09-24
**Files analyzed:** 20 (TS 11, Python 8, systemd 1) + optional hermes-linear-connector change
**Analogs found:** 19 / 20 (Notion REST client has no fetch-based analog in repo; backfill.ts is the closest)

All analog paths below verified git-tracked (`git ls-files`).

## File Classification

| New/Modified File (absolute) | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| /root/src/repos/agent-substrate/packages/mcp-server/src/service.ts (M) | service | request-response + event emit | itself: `claimNode` L139-167 | exact |
| /root/src/repos/agent-substrate/packages/mcp-server/src/types.ts (M) | model | — | itself `EVENT_KINDS` L19-35 | exact |
| /root/src/repos/agent-substrate/packages/mcp-server/src/mcp.ts (M) | route | request-response | itself `graph_claim/release/complete` L162-203 | exact |
| /root/src/repos/agent-substrate/packages/mcp-server/src/config.ts (M, optional: hermes-linear URL) | config | — | itself L58-60 | exact |
| /root/src/repos/agent-substrate/packages/mcp-server/src/index-store.ts (M: reverse lookup by linear id/identifier) | store | CRUD | itself `claimNode`/`setNodeState` L176-210 | exact |
| /root/src/repos/agent-substrate/packages/mcp-server/src/linear.ts (NEW) | service/client | request-response (GraphQL) | /root/src/repos/hermes-linear-connector/src/hermes_linear_connector/linear_client.py | role-match (cross-lang) |
| /root/src/repos/agent-substrate/packages/mcp-server/src/notion.ts (NEW) | service/client | request-response (REST) | packages/mcp-server/src/backfill.ts (`fetchNotionRows` + pure mapping split) | partial |
| /root/src/repos/agent-substrate/packages/mcp-server/src/mirror.ts (NEW) | service | transform + request-response | backfill.ts pure-map/IO split; state names from backfill.ts L139-148 | partial |
| .../src/service.test.ts (M), mirror.test.ts (NEW), event.test.ts (M for new kinds) | test | — | packages/mcp-server/src/service.test.ts L1-40 | exact |
| /root/src/repos/agent-substrate/packages/dispatcher/pyproject.toml (NEW) | config | — | /root/src/repos/hermes-linear-connector/pyproject.toml | exact |
| .../dispatcher/src/substrate_dispatcher/__main__.py (NEW) | entrypoint loop | batch/poll | hermes_linear_connector/poller_main.py | exact |
| .../substrate_dispatcher/linear.py (NEW) | client | request-response | hermes_linear_connector/linear_client.py | exact |
| .../substrate_dispatcher/mcp.py (NEW) | client (HTTP to substrate-mcp) | request-response | linear_client.py (httpx.Client + injectable transport) | role-match |
| .../substrate_dispatcher/worktree.py, launcher.py (NEW) | utility | subprocess/file-I/O | none in-repo; follow poller.py function style | none |
| .../dispatcher/tests/test_*.py (NEW) | test | — | hermes-linear-connector/tests/unit/test_linear_client.py (httpx.MockTransport) | exact |
| /root/src/repos/agent-substrate/infra/vps/substrate-dispatcher.service (NEW) | config | — | infra/vps/substrate-collector-grok.service | exact |
| /root/src/repos/hermes-linear-connector/src/hermes_linear_connector/webhook_app.py (M, if Open Q1 option b) | route | request-response | itself `POST /v1/mark-dod` L89-112 + `MarkDodBody` L27-33 | exact |
| /root/src/repos/hermes-linear-connector/tests/unit/test_sync_engine.py (M, if option b) | test | — | itself | exact |

## Pattern Assignments

### service.ts (modify) — analog: same file L135-173
Claim path pattern: guard on index, perform index op, then side effects that never fail the call:
```ts
async claimNode(graphId: string, nodeId: string, surface: Surface, sessionId: string) {
	if (!this.index) throw new Error("graph_claim requires SUBSTRATE_PG_URL");
	const result = await this.index.claimNode(graphId, nodeId, surface, sessionId);
	if (result.claimed) {
		const graph = await this.index.getGraph(graphId).catch(() => null);
		await this.emit({ surface, kind: "claim", summary: ..., graph_id: graphId, node_id: nodeId,
			linear_identifier: result.node.linear_identifier ?? undefined, session_id: sessionId,
			repo: graph?.repo ?? undefined, branch: graph?.branch ?? undefined,
		}).catch(() => undefined);
	}
	return result;
}
async releaseNode(graphId, nodeId) { ...; await this.index.releaseNode(graphId, nodeId); }          // emits nothing today
async completeNode(graphId, nodeId, state: NodeState = "completed") { setNodeState; releaseNode; } // emits nothing today
```
- Update the docblock at L136-137 ("Phase 2 adds the Linear and Notion mirroring").
- Mirror calls follow the `.catch(() => undefined)` + emit `kind:"warning"` convention: a mirror failure must not un-claim. `completeNode` must instead return `{completed:false, reason}` (D-06) — change return type, and `mcp.ts` must `json(...)` it rather than `text(...)`.
- Inject the mirror via the constructor deps object like `{ index, greptime }` (see test `new Substrate(loadConfig({}), { index, greptime })`) so tests can stub it.

### types.ts — `EVENT_KINDS` L19-35
Append `"release"`, `"complete"` (and any dispatch kind) to the `as const` array; `EventKind` derives from it. event.test.ts likely asserts kind validation — extend there.

### mcp.ts — L162-203
```ts
server.registerTool("graph_complete",
	{ title: "Complete a node", description: "Mark a node completed and drop its claim.",
	  inputSchema: { graph_id: z.string(), node_id: z.string() } },
	async ({ graph_id, node_id }) => { await substrate.completeNode(graph_id, node_id); return text(`Completed ...`); });
```
Add optional zod fields (e.g. `dod: z.object({summary: z.string(), tests_pass: z.boolean(), review_pass: z.boolean().optional()}).optional()`, `session_id`), pass `callerSurface` as `graph_claim` does (`surface ?? callerSurface ?? "claude-code"`), return `json(result)`.

### config.ts — L58-60
```ts
linearApiKey: env.LINEAR_API_KEY?.trim() || undefined,
notionApiKey: env.NOTION_API_KEY?.trim() || undefined,
notionTaskGraphDataSource: env.NOTION_TASK_GRAPH_DS?.trim() || "be3418f0-...",
```
Add `hermesLinearUrl: env.HERMES_LINEAR_URL?.trim() || "http://127.0.0.1:8792"` in the same style. Absent keys ⇒ mirror disabled (skip with warning event), never throw.

### index-store.ts — L176-210
Tagged-template `this.sql\`...\`` queries cast `as GraphNode[]`; single-row via `rows[0]`; throw `unknown node ${graphId}/${nodeId}` when missing. Reverse lookup (dispatcher: Linear identifier → graph/node) copies the `existing` select:
```ts
const existing = (await this.sql`
	select * from graph_nodes where graph_id = ${graphId} and node_id = ${nodeId}`) as GraphNode[];
```
→ `where linear_identifier = ${identifier}` (return `GraphNode | null`, no throw).

### linear.ts (new) — analog linear_client.py L1-60
Port the shape: constructor requires key (`Authorization: <key>` — no `Bearer`), POST `https://api.linear.app/graphql` with `{query, variables}`, throw on non-2xx and on `body.errors`. TS: accept an injectable `fetch` (`fetchImpl: typeof fetch = fetch`) — mirrors `transport` injection used in Python tests. Resolve states by **name within issue.team.states** (RESEARCH finding: "In Review" is type `started`).

### notion.ts / mirror.ts (new) — analog backfill.ts
backfill.ts header: "The mapping is pure and separately tested; only `fetchNotionRows` touches the network". Keep that split: `mirror.ts` exports pure `transitionFor(action) → {linearStateName, notionStateName}` using the backfill mapping (Todo→unstarted, In Progress→started, In Review→started_review, Done→completed; backfill.ts L139-148 `toNodeState`), and one IO function taking injected clients.

### Tests — analog service.test.ts L1-40
```ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { Substrate } from "./service.ts";
function stubStores(...) { const emitted: SubstrateEvent[] = []; const index = { claimNode: async ..., getGraph: async ... };
  const greptime = { lastHash: async () => null, insertEvent: async (e) => { emitted.push(e); } }; ... }
const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });
```
Comment regressions inline ("Regression: ..."). mirror.test.ts: stub `fetch` recording requests; assert state-id/Notion payloads and that failures yield a `warning` event.

### packages/dispatcher/pyproject.toml — analog hermes-linear-connector/pyproject.toml
Copy: `requires-python = ">=3.11"`, `dependencies = ["httpx>=0.27"]` (drop fastapi/pydantic unless needed), `[dependency-groups] dev = ["pytest>=8.0"]`, `[project.scripts] substrate-dispatcher = "substrate_dispatcher.__main__:main"`, hatchling backend, `[tool.hatch.build.targets.wheel] packages = ["src/substrate_dispatcher"]`, `[tool.pytest.ini_options] testpaths=["tests"] pythonpath=["src"] markers=["live: hits real Linear API (needs LINEAR_API_KEY)"]`, `[tool.uv] package = true`.

### __main__.py — analog poller_main.py
```python
def main() -> None:
    engine, store, linear, kanban = build_engine()
    interval = float(engine.config.sync.poll_interval_seconds)
    try:
        while True:
            try:
                poll_once(engine, store, kanban)
            except Exception as exc:  # noqa: BLE001
                store.add_dead_letter(source="poller-loop", payload="{}", error=str(exc))
            time.sleep(interval)
    finally:
        store.close(); linear.close()
```
Use `poll_once(...) -> int` pure-ish step (poller.py L34) so tests call one tick; interval 30 s (D-10); log errors to stderr/journal (no dead-letter store) or emit substrate `warning` event.

### linear.py / mcp.py — analog linear_client.py
```python
class LinearClient:
    def __init__(self, api_key: str, *, timeout: float = 30.0, transport: httpx.BaseTransport | None = None) -> None:
        key = (api_key or "").strip()
        if not key: raise ValueError("api_key required")
        kwargs = {"base_url": LINEAR_API_BASE, "headers": {"Authorization": key, "Content-Type": "application/json"}, "timeout": timeout}
        if transport is not None: kwargs["transport"] = transport
        self._client = httpx.Client(**kwargs)
    @classmethod
    def from_env(cls, env_var="LINEAR_API_KEY"): ...
    def graphql(self, query, variables=None): resp = self._client.post("/graphql", json=payload); resp.raise_for_status(); if body.get("errors"): raise ...
```
mcp.py: same class shape with `base_url` from `SUBSTRATE_HOST/PORT` and substrate bearer token header.

### tests — analog tests/unit/test_linear_client.py
`httpx.MockTransport(handler)` passed via `transport=`; no network. Use `@pytest.mark.live` for real-API tests.

### infra/vps/substrate-dispatcher.service — analog substrate-collector-grok.service (full file)
Copy verbatim structure: `After=/Wants=substrate-mcp.service`, `StartLimitIntervalSec=0`, `Type=simple`, `EnvironmentFile=/etc/substrate/substrate.env` (+ second EnvironmentFile for Linear key per RESEARCH since substrate.env lacks it — do not read its contents), `WorkingDirectory=/root/src/repos/agent-substrate`, `Restart=always`, `RestartSec=5`, `StateDirectory=substrate`, journal output, `SyslogIdentifier=substrate-dispatcher`, hardening block (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, `ProtectHome=false`, ...). ExecStart: `uv run --project packages/dispatcher python -m substrate_dispatcher` (machine-specific absolute uv path, comment like `# Machine-specific: command -v bun`). Default `KillMode` = kill switch (D-15).

### webhook_app.py (optional, Open Q1 option b) — analog same file L27-33, L89-112
```python
class MarkDodBody(BaseModel):
    kanban_task_id: str; summary: str = ""; tests_pass: bool = False; review_pass: bool = False; role: str = "implementer"; mark_done: bool = False

@app.post("/v1/mark-dod")
def mark_dod(body: MarkDodBody) -> dict[str, Any]:
    eng = state["engine"]
    try: eng.mark_dod_pass(...)
    except KeyError as exc: raise HTTPException(404, str(exc)) from exc
    ...
    return {"ok": True, ...}
```
New `CompleteIssueBody{linear_issue_id, summary, tests_pass, review_pass}` + `POST /v1/complete-issue` reusing the `require_dod_for_done` rule in sync_engine.py L185-241 (refuse → return `{completed: False, reason}`; allow → `linear.issue_update(state_id=completed)`). Do not duplicate the gate in TS.

## Shared Patterns
- **Side effects never fail the primary op:** `.catch(() => undefined)` on emit (service.ts L151-165); mirror errors → `warning` event.
- **Injection for tests:** TS deps object in `Substrate` ctor / injected `fetch`; Python `transport=` kwarg.
- **Config from env, trimmed, `|| undefined`:** config.ts L58-60; Python `from_env` classmethod.
- **Comments explain why** (regression notes) — house style in service.ts and tests.

## No Analog Found
| File | Reason |
|---|---|
| substrate_dispatcher/worktree.py, launcher.py | no git-worktree / `hermes chat` subprocess code in either repo; use `subprocess.run([...], check=True)` with args list, keep functions pure-testable by injecting a runner |
| notion.ts REST writes | backfill reads via MCP output, not REST; follow Notion API `PATCH /v1/pages/{id}` with `Notion-Version` header |

## PATTERN MAPPING COMPLETE
