# Phase 26: Hindsight recall and Dragonfly cache — Context

**Gathered:** 2026-10-10
**Status:** Ready for planning
**Mode:** Autonomous discuss-equivalent under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"): grey areas auto-accept unless they change a user-visible contract, and each is recorded below as a decision with its source. No operator questions were asked; items needing a live system are marked OPERATOR-GATED in the plans, not resolved here.

<domain>
## Phase Boundary

One PR on agent-substrate (DOCS-04, DOCS-05, DOCS-06, DOCS-07). Gate-accepted memories become recallable across surfaces through the substrate, and repeated reads are cached — without the recall plane ever running inside the brief's 1.5 s budget, without a cached brief hiding a fresh claim, and without a plane credential living outside `substrate.env`.

1. **The cache already ships; this phase ports recall and pins deltas.** `packages/mcp-server/src/cache.ts` (451 lines) is live in production: Bun `RedisClient`, `COMMAND_TIMEOUT_MS=800` (PR #43/#44), `POST /brief` + `memory_brief` + `memory_search` + `graph_get` coverage, `/healthz` reporting `{enabled, connected, mode, hits, misses, bypasses, errors}`, generation counters bumped on memory and graph writes. Production `DRAGONFLY_URL` points at a co-located loopback redis (hits ~4 ms) after a measured 180–310 ms tailnet RTT made the Railway hop unusable (Greptile P1 disposition recorded). Nothing in this phase rebuilds that client: the `acc30a8` hand-rolled RESP framing stays dropped, and the cache deltas are recall-result coverage, the claims-freshness pin, and the plaintext-`redis://` refusal — each proven, not assumed.
2. **The substrate becomes a Hindsight client; the gateway keeps its own.** No file under `packages/` imports a Hindsight client today and `loadConfig` ignores `HINDSIGHT_*` (`docs/grok-bot.md`, verified this session). The desk gateway holds `HINDSIGHT_URL` / `HINDSIGHT_API_KEY` and is the Hindsight client when configured, with substrate `memory_search` as its fallback and substrate `memory_write` running alongside every Hindsight retain. This phase adds `packages/mcp-server/src/planes/hindsight.ts` as the substrate-side client (the research SUMMARY phase-26 row's named deliverable), reading `HINDSIGHT_*` from the server env file only. Gateway code is not touched.
3. **Port the client knowledge, not the stub.** `acc30a8:planes.ts` contributes three keepers — `planesFromEnv` (trim + trailing-slash strip), bearer carriage, `hindsightRecall` (recall outside the brief) — reshaped to the `docs/data-planes.md` contract. Its single-`HINDSIGHT_BANK` shape, its 4 s recall inside the brief, and its never-called RESP client are the recorded anti-patterns and are NOT ported. The authoritative API shape is the claude-ultrathink `src/hindsight/` module (client + cli + 498-line `client.test.ts` fake-banks-server precedent, tested against Hindsight 0.9.1) plus its `.planning/research/hindsight-0.9.1-openapi.json`.
4. **Guards come from earlier phases.**
   - Redaction: Phase 18's `redact.ts` (`redact`, `redactValue` with the `COUNTER_KEY` exemption). Retain redacts before upload and refuses on findings; recall hits are redacted before reply.
   - The event mapping: Phase 17's `event-sources.ts` rows already exist (`memory.retain` — success emits nothing — and `memory.retain.failed` as `warning`); this phase emits against them and adds no kind and no surface (`EVENT_KINDS` closed at 12).
   - Audit policy: Phase 17's `policy.ts` already lists `memory_recall` fail-open (like `memory_search`); this phase registers the tool/route names (`KNOWN_TOOLS`, `KNOWN_ROUTES`) so the decided policy actually covers them. `memory_write` stays fail-closed.
   - Tokens-dir bearer resolution: Phase 20's `packages/cli/src/token.ts` pattern (D20-04) — recall/retain accept only authenticated surfaces; VM guests are refused.
5. **Rehearsal-first, then gated live.** Every behavior is proven against the Phase 16 harness plus a fake banks server (routed `fetch` fake; unrouted requests answer 500 so the call log still shows them — the ultrathink `client.test.ts` pattern) before any live step. The first live reachability/version probe, the first live bank ensure, the first live recall, the first live retain, and any live cache/topology change are OPERATOR-GATED steps the executor stops at.

**Out of scope:**
- Per-surface counters and the 24 h idempotency mirror as new cache keys (`docs/data-planes.md` names both a target, not a current key — this phase holds that line and does not build them).
- Any new `EVENT_KINDS` or `SURFACES` entry (Phase 17 lock); any Hindsight MCP server in any agent config (store-lock rule D9).
- RAGFlow (retired, superseded by LightRAG) retrieval/ingest (Phase 25 owns `planes/ragflow.ts`); the skills-sync LIVE cutover (Phase 22's deferred gate — recall serves pinned/index answers until then, no special degradation arm needed here).
- Hindsight 0.10.x (recall hang `vectorize-io/hindsight#4696` — the client keeps the fail-open timeout and the G1 probe records the deployed version; never assume it).
- Production credential values (Phase 20 provisioned names; this phase reads `HINDSIGHT_URL` / `HINDSIGHT_API_KEY` from the server env file only). Agents never prune the on-disk 5.91 GB `hindsight-api:0.9.1` image (operator decision D25).

**Depends on code already on `main`:**
- Phase 16: `scripts/rehearsal.ts`, `packages/mcp-server/src/rehearsal-env.ts`, harness twin on a scratch port.
- Phase 17: `event-sources.ts` memory rows, `docs/event-vocabulary.md`, `policy.ts` `memory_recall` entry, `observe.ts` registration points.
- Phase 18: `redact.ts` full engine, `redact-lock.test.ts`, store-lock rules.
- Phase 20: `infra/identity/clients.json`, `packages/cli/src/token.ts` resolver, `docs/runbooks/production-identity.md` agent-query rules.
- Phase 25: `planes/ragflow.ts` as the planes-module pattern to mirror (env trim + trailing-slash strip, bearer carriage, recording fake, four-point registration).
</domain>

<decisions>
## Implementation Decisions

### Reach and credentials (the substrate-second-door)
- **D26-01: The substrate reads Hindsight through `planes/hindsight.ts`; no Hindsight MCP in any agent config.**
  - Source: operator decision 2026-10-08 ("the data planes are reached only through the substrate") + Phase 18 store-lock D9 + research SUMMARY D9 (substrate-only; no plane MCP in agent configs).
  - `packages/mcp-server/src/planes/hindsight.ts` is the single substrate-side client. A store-lock test fails when any agent config registers a Hindsight MCP server, and when any package outside `mcp-server` imports the Hindsight client (mirrors the D25-01 ragflow pin; PITFALLS already names the `ragflow|hindsight` extension).
  - Grey area (desk gateway's direct reads) auto-accepted: the gateway keeps its own keys for its own paths per `docs/data-planes.md` "Current wiring" and `docs/grok-bot.md`; agent-facing recall/retain through the substrate does not change gateway code. This answers D9's "Yes — Grok Bot gateway route" user-visible flag with: route unchanged, reader added.
- **D26-02: Plane credentials live only in `/etc/substrate/substrate.env`; `substrate-mcp` reads `HINDSIGHT_URL` / `HINDSIGHT_API_KEY` starting this phase.**
  - Source: `docs/data-planes.md` "Environment keys" + DOCS-06 (credentials live only in `substrate.env`) + host fact (`HINDSIGHT_URL`, `HINDSIGHT_API_KEY` present in the server env file, documented unused-by-substrate).
  - Only `planes/hindsight.ts` names those variables (store-lock: no `HINDSIGHT_*` string outside `mcp-server`). A comment at the read site records that the gateway holds its own copies for its own paths.
  - This changes the `docs/data-planes.md` "Current wiring" Hindsight row from "not read by `substrate-mcp`" to "read by `substrate-mcp` `planes/hindsight.ts`; gateway keeps its own keys for its own paths"; the doc hunk ships in plan 26-03 (D25-02 precedent). Grey area (whether to keep the `.env.example` "unused" note) auto-accepted: update the note to name the new reader, same as D25-02 did for RAGFlow (retired, superseded by LightRAG).

### Bank strategy (D8 settled: per-surface prefix)
- **D26-03: Retain into the writer's `sub-<surface>` bank; recall as a bounded, cached fan-out over the `sub-*` banks.**
  - Source: research SUMMARY D8 (per-surface prefix wins; operator edits `substrate.env`) + `.env.example` `HINDSIGHT_BANK_PREFIX=sub-` + `docs/data-planes.md` Hindsight-banks table + FEATURES D-D1 (bounded cached fan-out; `agentId: "*"` is an Agentmemory idiom and Hindsight banks are isolated, so fan-out is per-bank queries, not a wildcard).
  - The single-`HINDSIGHT_BANK` shape in `acc30a8` contradicts `main` and is NOT ported. Bank names are `HINDSIGHT_BANK_PREFIX + surface` (`sub-claude-code`, `sub-hermes`, …); the desk's `pd-*` banks are gateway-owned and the substrate never names them.
  - Grey area (fan-out bound) auto-accepted: recall queries the caller's bank plus the other `sub-*` banks named in config, each with the same budget, results merged and marked with their source bank; the whole fan-out shares one abort budget so one slow bank cannot stall the rest (fail-open per result set, never a throw inside a turn).

### Retain governance (the gate stays the system of record)
- **D26-04: Hindsight retains a memory only after the governance gate returns `accepted` with `verified_persisted`, redacted and carrying a `receipt_path` or `source`.**
  - Source: REQUIREMENTS DOCS-04 + research SUMMARY phase-26 row + FEATURES D-T4 + v1.3 operator default ("Hindsight retains only gate-accepted memories").
  - The retain is an async forward after the Postgres index write is accepted — Postgres stays the governed store (FEATURES anti-pattern: `memory_write → Hindsight retain as the store of record` is refused because Hindsight rewrites facts and bypasses read-back/versioning/quarantine). The forward carries `document_id` (idempotent upsert, `update_mode: "replace"`) derived from the index idempotency key, `tags` including the surface, and string-valued `metadata` only (Hindsight drops nulls). Any redactor finding refuses the forward (never clean-and-publish); a refused or failed forward emits the existing `memory.retain.failed` warning — the write itself already succeeded, so the forward never blocks it.
  - Grey area (retain extraction mode) auto-accepted: `ensureBank` sets `retain_extraction_mode: "chunks"` (ultrathink precedent — stores text as-is, no server-side LLM rewrite), which is what makes the forward a faithful copy of the accepted text rather than a rephrased one.
- **D26-05: Recall never runs inside the brief's 1.5 s budget — it is a tool, with `memory_search` merging hits marked derived.**
  - Source: REQUIREMENTS DOCS-04 ("recall is a tool or derived-marked `memory_search` results") + research SUMMARY phase-26 row ("recall outside the 1.5 s brief or as cached async section") + FEATURES D-T4 ("never inside the 1.5 s brief path").
  - `memory_recall` (MCP + `POST /memory/recall`) is the explicit tool; `memory_search` additionally merges Hindsight hits framed as derived (source bank named, untrusted framing like D25-04's docs notice). The brief never calls either inline; at most it serves a previously cached recall section whose generation is still current. A test asserts no `planes/hindsight` import in the brief's synchronous compose path (the anti-pattern gate for the `acc30a8` 4 s in-brief recall).
  - Grey area (recall result count) auto-accepted: at most 4 results per bank (the `acc30a8` bound, kept as a ceiling not a target), `budget: "low"`, `max_tokens` capped, types default `["world", "experience", "observation"]` (ultrathink-tested values).

### Cache deltas (reconciling the shipped cache with DOCS-05)
- **D26-06: The shipped cache is taken as-is; this phase adds recall-result coverage, pins claims freshness, and refuses plaintext non-loopback `redis://`. Counters and the idempotency mirror stay targets.**
  - Source: REQUIREMENTS DOCS-05 + DOCS-06 + current `cache.ts` (coverage, healthz, generations) + `docs/data-planes.md` ("rate counters and an idempotency mirror stay a target, not a current key") + research SUMMARY D10/D11.
  - (a) Recall results cache under the existing `memory-search` class semantics (600 s) with the same generation rule: an accepted memory write bumps the memory generation, so a fresh retain is never hidden behind a stale recall. (b) Claims freshness is pinned, not assumed: the claims section of the brief is composed fresh on every brief (PITFALLS 16, D10), and a test proves a claim newer than 60 s is visible in a brief served immediately after a cache hit on identical arguments. The existing graph-write generation bumps are the mechanism; the new test is the proof. (c) `parseRedisUrl` refuses a plaintext `redis://` URL whose host is not loopback (DOCS-06); `rediss://` or loopback stays allowed. The production loopback-`DRAGONFLY_URL` fact (post-tailnet-RTT move) is recorded in the runbook as the D11 resolution for Dragonfly: bypass-until-private-hop is satisfied by not leaving the host.
  - Grey area (per-surface counters / 24 h idempotency mirror) auto-accepted: NOT built — the data-planes target line holds, and DOCS-05's "per-surface counters" requirement is met by the existing per-class hit/miss/bypass/error counters in `/healthz`, not by new counter keys (no new key classes, no queue/lock/session semantics ever).

### Vocabulary and audit (already decided, register only)
- **D26-07: No new event kind: retain success emits nothing, retain refusal/failure is the existing `memory.retain.failed` warning; recall reads emit nothing.**
  - Source: Phase 17 `event-sources.ts` (`memory.retain` reason: "A successful retain emits nothing; only a failure is a warning. Reads do not emit, like memory_search").
  - Payloads carry locator-style `{bank, document_id, rule}` plus hashes, never values (Phase 21 refusal precedent).
- **D26-08: No audit-policy change: `memory_recall` is already fail-open; register the names so the policy bites.**
  - Source: `packages/audit/src/policy.ts` (already lists `memory_recall`) + Phase 17 four-registration rule (Pattern 2, D25-09 precedent).
  - This phase adds `memory_recall` to `KNOWN_TOOLS`, `/memory/recall` to `KNOWN_ROUTES`, the MCP + REST registrations, and the `policy.test.ts` pins. `memory_write` (and therefore the retain forward's closed-ness) is untouched.

### Proof shape (rehearsal-first, gated live)
- **D26-09: Proof is rehearsal-first; the first live recall, first live retain, and any live cache/topology change are explicit OPERATOR-GATED steps.**
  - Source: v1.3 run rules (live runs wait for operator approval) + ROADMAP Phase 26 proof (DOCS-07: live, approved — headless session, cross-surface recall with source, second-brief cache hit, Dragonfly-down uncached).
  - Rehearsal (no approval): fake banks server proves bearer carriage, bank-in-path, chunks ensure (create-on-404 + PATCH), retain upsert shape, recall parse of both response shapes, timeout-as-Result (never throw), fan-out bound + single abort budget, derived marking, redacted hits, recall-hit caching, claims-freshness pin, `redis://` refusal, `/healthz` counters.
  - Gated (executor stops, operator approves): (G1) first live reachability/version probe (`GET /health` + `GET /version`, record version, confirm the 0.10.1 hang guard holds); (G2) first live bank ensure + first live recall; (G3) first live retain of a gate-accepted memory; (G4) any live cache/topology change (re-pointing `DRAGONFLY_URL`, refusal-behavior flip) and the DOCS-07 headless proof. Each gated step names its proof read and rollback in plan 26-03.
</decisions>

<code_context>
## Prior Art Consumed

- `acc30a8:packages/mcp-server/src/planes.ts` — `planesFromEnv` (env trim + trailing-slash strip), bearer carriage (`authorization: Bearer`), `hindsightRecall` request skeleton (`POST {url}/v1/default/banks/{bank}/memories/recall`, `{query, budget: "low", max_tokens: 400}`, `results[].text`, 4 s timeout, ≤4 results). Kept as adapted helpers; bank becomes per-surface prefix (D8), timeout moves out of the brief path (D26-05).
- `claude-ultrathink:src/hindsight/{client,types}.ts` — the tested-against-0.9.1 surface this phase ports from: bank URL shape, `GET /health` + `GET /version` (unauthenticated), `GET {bank}/config` → 404-create-then-`PATCH retain_extraction_mode: "chunks"`, retain `{items: [{content, context, tags, metadata, document_id, timestamp, update_mode: "replace"}], async: false}` → `{success, items_count}`, recall `{query, types, budget, max_tokens, tags, tags_match, tag_groups}` → `{results[]}`, document GET/DELETE/PATCH, `Result` returns (never reject), FastAPI-array-`detail` never shown. Plus `client.test.ts` (498 lines): routed-`fetch` fake banks server, unrouted → 500, per-call bearer assertions — the fixture pattern plan 26-01 mirrors.
- `claude-ultrathink:.planning/research/hindsight-0.9.1-openapi.json` — the spec to check the port against when the G1 probe returns the deployed version.
- `packages/mcp-server/src/cache.ts` — the shipped cache taken as-is (coverage, `COMMAND_TIMEOUT_MS=800`, healthz, generations); plan 26-03 extends it, never rewrites it.
- `packages/mcp-server/src/planes/ragflow.ts` (Phase 25) — the planes-module pattern to mirror: env trim + trailing-slash strip, bearer carriage, recording fake, four-point registration, `.env.example` + data-planes wiring-row doc hunks.
- `docs/data-planes.md` — Hindsight-banks table, "Current wiring" Hindsight row (changed by D26-02), cache table + fail-open budget, forwarder table for the runbook.
- `docs/grok-bot.md` — the gateway-is-the-Hindsight-client route this phase leaves unchanged (D26-01 grey area).
- `docs/railway-tailscale.md` — the forwarder-hop source for the plan-26-03 runbook.
- Phase 18 `redact.ts` contract + Phase 17 vocabulary/policy + Phase 20 token resolver (see domain section).
</code_context>
