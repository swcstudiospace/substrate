# Phase 7: Recall - Context

**Gathered:** 2026-09-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Any agent can recall what earlier sessions on any surface learned, through one substrate tool keyed by
Graph ID. substrate-mcp forwards its own already-redacted summaries to Agentmemory
(rohitg00/agentmemory on the owner's Railway) and fronts Agentmemory's search as `context_search`.
Agentmemory augments the substrate memory plane; Postgres/Greptime stay the source of truth.
Hindsight (Claude Code) and supermemory (Hermes) are retired in its favour.

</domain>

<decisions>
## Implementation Decisions

### Write path (owner accepted all, 2026-09-26)
- D-01 Forward only already-redacted `session.end`, `handoff` and `complete` event summaries plus `memory_write` entries (decision/warning/note). No raw transcripts.
- D-02 `POST /agentmemory/remember`: `project=<repo>`, `agentId=<surface>`, `concepts=["graph:<id>","repo:<r>","surface:<s>"]`, and a content header line `graph:<id> repo:<r> surface:<s>` (keeps near-identical summaries from different graphs apart under Jaccard>0.7 supersession). Not `/observe` (400-char truncation, drops agentId, #1159).
- D-03 Forwarding is async after the Greptime write, never on the caller's path. Outage → drop + log; a forwarded-id cursor replays missed records from Greptime. No local spool.
- D-04 Extend `redact()` with the classes agentmemory's `/remember` does not filter and ours misses: `AKIA`, `AIza`, `xoxb-`, `npm_`, `glpat-`, `dop_v1_`, `sk-proj-`, `pk-/rk-`, `<private>…</private>`, case-insensitive `api_key:`; fixture-tested. Cap forwarded content at 8 KB and concepts count.

### context_search (owner accepted all)
- D-05 `POST /agentmemory/search` with `format:"full"`; `project` filter when a repo is given; `agentId:"*"` for cross-surface recall (or a named surface); `graph_id` filtered client-side after over-fetch. (Supersedes ROADMAP SC1's "smart search" wording: smart-search ignores `project` and returns content-less hits.)
- D-06 MCP `context_search {query, repo?, graph_id?, surface?, limit≤20}` and `POST /context/search`; results `{text, graph_id, repo, surface, ts, score}`, framed UNTRUSTED; open to VM guests like `docs_search`.
- D-07 No brief integration: the brief stays deterministic in its 1.5 s budget; agents call `context_search` on demand.
- D-08 Own 2 s deadline (`AbortSignal.timeout`); 5xx/504/401/`success:false`/network error → empty result + logged reason. Boot/first-write gate: `GET /agentmemory/health` `.version ≥ 0.9.29` (0.9.28 drops agentId on `/remember`), else forwarding stays off and search still fails open. ROADMAP SC3's 0.9.28 floor is raised to 0.9.29.

### Retirement, scoping, proof (owner accepted all)
- D-09 Claude Code: remove the `hindsight` MCP entry and hooks (backup + restore route first; hindsight data left on disk); register substrate MCP in Claude Code so `context_search` is available.
- D-10 Hermes: `memory.provider` supermemory → none; Hermes reaches `context_search` through its existing substrate route (planner confirms connector tool vs MCP entry). agentmemory's native plugins are NOT installed (they bypass `redact()`).
- D-11 Substrate is the only writer holding `AGENTMEMORY_SECRET`; one agentId per surface; server scope `shared`. One-time backfill of the last 14 days of qualifying events, then continuous.
- D-12 Proof: a headless Omp session (`omp -p --mode json "/ultrathink-skip" …`, 04-08 precedent) records a decision in graph X; a headless `claude -p` session with a session-scoped `--mcp-config` (05-06 precedent) recalls it with graph X via `context_search`.
- D-13 (owner, 2026-09-27, OQ1): forwarded memory kinds are exactly `decision`, `warning` and `fact`; memory handoff entries are not forwarded.
- D-14 (owner, 2026-09-27, OQ2): host Claude Code gets the substrate MCP as `deny-mutating` — read tools only (memory_brief, memory_search, graph_get, graph_find, issue_get, docs_search, context_search); every mutating substrate tool is denied in Claude Code permissions.

### Claude's Discretion
- Cursor storage (Postgres table vs file under /var/lib/substrate), backfill batching, over-fetch factor.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `loadConfig` idioms, `packages/mcp-server/src/config.ts:55-79` → add `AGENTMEMORY_URL`, `AGENTMEMORY_SECRET`.
- `swallow()` fail-open helper, `brief.ts:78-84`.
- `redact()` / `redactValue`, `redact.ts:53,68`.
- `proposeAllowed` guard, `skills/propose-auth.ts:28-38`; 05-05's open `docs_search` / guarded `docs_ingest` split is the pattern for open `context_search`.
- `/healthz` shape `{index, greptime}`, `server.ts:104-107`.

### Established Patterns
- Every live change gets a RESTORE route first (`/var/lib/substrate/phase7-baseline/RESTORE.d/07-NN.md`); two-sided gates against a measured baseline; stage by explicit path; `Refs SPE-3576`.

### Integration Points
- `service.ts` emit path (post-Greptime hook for forwarding); `mcp.ts` tool registration; `server.ts` routes; `~/.claude.json` mcpServers; `~/.hermes/config.yaml` memory block.

</code_context>

<specifics>
## Specific Ideas

- Contract research (agentmemory v0.9.29 @2d38daf; endpoints, scoping, privacy filter, limits): `07-RESEARCH-CONTRACTS.md` (copied from the orchestrator's research artifact).
- Credentials: `AGENTMEMORY_URL`, `AGENTMEMORY_SECRET` in `/etc/substrate/substrate.env`, presence-checked only; the owner is appending them.

</specifics>

<deferred>
## Deferred Ideas

- Brief "Related past work" section (revisit after Phase 8 caching).
- agentmemory native Claude Code / Hermes plugins.

</deferred>
