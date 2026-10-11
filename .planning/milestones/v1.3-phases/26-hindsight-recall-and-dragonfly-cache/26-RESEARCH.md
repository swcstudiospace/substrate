# Phase 26: Hindsight recall and Dragonfly cache — Research

**Researched:** 2026-10-10
**Domain:** Substrate-side Hindsight 0.9.1 recall/retain behind `memory_recall` / gate-accepted forward on main's v1.2 surface-token server; recall placement vs the 1.5 s brief budget; `sub-<surface>` bank strategy; credential path (`HINDSIGHT_*` in `substrate.env` read by mcp-server only); shipped-cache deltas (recall coverage, claims-freshness pin, `redis://` refusal)
**Confidence:** HIGH for the repo-documented contract and port points (every source read on `main`, on `acc30a8:planes.ts`, and on `claude-ultrathink:src/hindsight/` this session); HIGH for the Hindsight HTTP shapes (ultrathink client tested against 0.9.1 + in-repo OpenAPI spec, not re-fetched here — the G1 version probe is the guard); LOW where marked UNVERIFIED (resolved-or-gated below, never assumed).

<user_constraints>
## User Constraints (from CONTEXT.md)

Locked: D26-01 (substrate-side client, no Hindsight MCP in agent configs, store-lock pinned; gateway route unchanged), D26-02 (credentials only in `substrate.env`, mcp-server reads `HINDSIGHT_URL`/`HINDSIGHT_API_KEY`, data-planes wiring row updated), D26-03 (retain into writer's `sub-<surface>` bank; recall as bounded cached fan-out over `sub-*`, per-bank queries not wildcards), D26-04 (retain only after `accepted` + `verified_persisted`, redacted, `receipt_path`/`source`, `document_id` upsert, chunks extraction mode; forward never blocks the write), D26-05 (recall never in the 1.5 s brief path — explicit tool plus derived-marked `memory_search` merge; ≤4/bank, `budget: low`; no hindsight import in brief compose), D26-06 (shipped cache as-is + recall coverage + claims-freshness pin + non-loopback `redis://` refusal; counters/idempotency-mirror stay targets), D26-07 (no new kind; retain-success silent, `memory.retain.failed` warning, recall silent), D26-08 (no policy change; register `memory_recall` + `/memory/recall`), D26-09 (rehearsal-first; G1–G4 gated).
</user_constraints>

<hindsight_api>
## Hindsight 0.9.1 API Surface (ported client knowledge, not the stub)

All shapes below are attested in `claude-ultrathink:src/hindsight/client.ts` + `types.ts` (tested against Hindsight 0.9.1) and checkable against `claude-ultrathink:.planning/research/hindsight-0.9.1-openapi.json`. The `acc30a8` skeleton agrees on the recall path shape only.

| Operation | Method plus path | Request shape (ultrathink-attested) | Response shape (ultrathink-attested) |
|---|---|---|---|
| Health | `GET {base}/health` (no auth) | — | `{status: "healthy", database: "connected"}` means ok |
| Version | `GET {base}/version` (no auth) | — | `{api_version: "0.9.1", features: {…}}` |
| Bank config | `GET {base}/v1/default/banks/{bank}/config` (bearer) | — | `{config: {retain_extraction_mode}}`; 404 means create |
| Bank create | `PUT {base}/v1/default/banks/{bank}` (bearer) | `{}` | bank created in server default mode |
| Bank mode | `PATCH {base}/v1/default/banks/{bank}/config` (bearer) | `{updates: {retain_extraction_mode: "chunks"}}` | mode set; want `chunks` (stores text as-is, no server LLM rewrite) |
| Retain | `POST {base}/v1/default/banks/{bank}/memories` (bearer) | `{items: [{content, context?, tags, metadata?, document_id, timestamp?, update_mode: "replace"}], async: false}` | `{success: true, bank_id, items_count, async}` |
| Recall | `POST {base}/v1/default/banks/{bank}/memories/recall` (bearer) | `{query, types, budget, max_tokens, tags?, tags_match?, tag_groups?}` | `{results: [{id, text, document_id?, tags, metadata, type?, context?, mentioned_at?}]}` |
| Documents | `GET/DELETE/PATCH {base}/v1/default/banks/{bank}/documents/{id}` (bearer) | PATCH body `{tags}` | GET 404 → null (not an error); DELETE 404 → false |
| Bank delete | `DELETE {base}/v1/default/banks/{bank}` (bearer) | — | destructive; never used outside throwaway test banks |

Client rules carried over: `Authorization: Bearer {key}` on everything except `/health` and `/version`; calls return a `Result` (`{ok, value} | {ok: false, error: {kind, message, status?}}`) and never reject except on caller abort; error kinds `auth / not-found / bad-request / rate-limit / server / timeout / network / invalid-response`; FastAPI array-valued `detail` is never shown (only a plain-string detail is safe); metadata values must be strings (Hindsight drops nulls); `ensureBank` is cached per client and only a success stays cached (failure retries next call); `document_id` upsert makes retain idempotent. Recall defaults: `types: ["world", "experience", "observation"]`, `budget: "low"`, per-bank ceiling 4 results.

What is deliberately NOT ported: the `acc30a8` single-bank shape (contradicts D8), recall inside the brief with a 4 s timeout (contradicts D26-05), `async: true` retain (needs unique `document_id` per item per HTTP 400 — the forward uses `async: false` + upsert), Hindsight 0.10.x (recall hang `vectorize-io/hindsight#4696` — client keeps `AbortSignal.timeout` fail-open and G1 records the deployed version).
</hindsight_api>

<unverified>
## UNVERIFIED Items: Resolve or Gate (never assume)

| ID | Item | Status after this research | Disposition |
|---|---|---|---|
| U-01 | Deployed Hindsight version | Not observable from this repo (no version pin on `main`; ultrathink tested against 0.9.1; a 0.9.1 image sits on disk unrun) | **GATED (G1):** the first live probe (`GET /health` + `GET /version`, no auth) records the deployment version into the phase report and checks it against `hindsight-0.9.1-openapi.json`; rehearsal covers both response shapes (full + minimal) via the version-pair test in plan 26-01 so skew cannot break parsing |
| U-02 | `sub-*` bank existence on the deployment | No live listing is observable from the repo; `ensureBank` creates-on-404 by design | **GATED (G2):** the first live bank ensure runs against a `sub-<surface>` bank in the operator window; rehearsal proves the 404→PUT→PATCH sequence plus the already-`chunks` one-GET path against the fake, so the live call is a single known sequence |
| U-03 | Cross-bank recall latency envelope | Fan-out cost depends on bank count and deployment RTT; the single abort budget bounds it but the bound value is unmeasured | **RESOLVED as rehearsal-measured:** the fake asserts the whole fan-out completes within the shared budget and that one slow bank degrades to a partial result, never a throw; G2 records the live per-bank timings and the phase report adjusts the budget only with operator sign-off |
| U-04 | `DRAGONFLY_URL` live value at proof time | Production points at co-located loopback redis today (post-tailnet-RTT move); any re-point is a topology change | **GATED (G4):** any live cache/topology change (re-point, refusal-flip) is operator-approved with a rollback (previous URL + `SUBSTRATE_CACHE=0` bypass) named in plan 26-03; rehearsal proves refusal + bypass + uncached-equivalence without touching the live value |

Net: U-01, U-02 and U-04 are explicitly gated live steps with rehearsal coverage for every known shape; U-03 is measured in rehearsal and confirmed live. No plan proceeds on an assumed server shape: the fake implements the ultrathink-attested skeleton, and the version-pair plus slow-bank tests prove the client survives the unknown.
</unverified>

<placement>
## Recall/Retain Placement vs the 1.5 s Brief Budget (D26-05)

- The brief's synchronous compose path (`packages/mcp-server/src/brief.ts`) never imports `planes/hindsight.ts`. Plan 26-01 carries the negative gate: a test fails on that import edge (the `acc30a8` 4 s in-brief recall is the anti-pattern).
- `memory_recall` runs outside the brief entirely: MCP tool + `POST /memory/recall`, bearer-resolved surface, bank fan-out under one abort budget, hits redacted and framed derived (source bank named). Errors yield `{results: [], degraded: true, reason}` — never a throw inside a turn (fail-open, policy.ts already lists it).
- `memory_search` merges Hindsight hits into its reply marked derived (source bank named, untrusted framing mirroring D25-04's docs notice). The merge is bounded (≤4 per bank) and cached under the recall class (D26-06a); a Hindsight outage yields index-only results with a reason, never a refusal.
- The brief may serve a previously cached recall section only when its generation is still current; an accepted memory write bumps the memory generation (`MEMORY_GENERATION_KEY`), so a fresh retain is never hidden. Claims are composed fresh on every brief regardless of cache state (D26-06b pin).
- Retain is post-accept async: the index write returns `accepted` first; the forward runs after, redacted, with `receipt_path`/`source`, into the writer's bank. Forward failure emits `memory.retain.failed` and never re-opens the write.
</placement>

<banks>
## Bank Strategy (D8/D26-03)

Writer's bank on retain: `HINDSIGHT_BANK_PREFIX + surface` (`sub-claude-code`, `sub-hermes`, `sub-omp`, `sub-muse`, `sub-grok-build`, `sub-cursor`, `sub-grok-bot`), tags include the surface, `document_id` derives from the index idempotency key (upsert = safe retry). Recall fans out over the configured `sub-*` set: caller's bank first, then the rest, each with the same recall body, merged by score with the source bank attached to every hit. The desk's `pd-desk` / `pd-<seat>` / `pd-lead-reports` banks are never named by substrate code (gateway-owned). No wildcard mechanism is assumed — D-D1's warning stands — so the bank list is explicit config, and adding a surface means adding its bank name, covered by a test that fails on an unlisted surface falling back to a shared bank.
</banks>

<credentials>
## Credential Path (D26-02, DOCS-06)

`HINDSIGHT_URL` / `HINDSIGHT_API_KEY` are read in exactly one place — `planes/hindsight.ts` via the `planesFromEnv`-style trim + trailing-slash strip — from the server env file (`/etc/substrate/substrate.env` in production). Store-lock pins: no `HINDSIGHT_*` string outside `mcp-server`, no Hindsight MCP server in any agent config, no key value in any event payload or error message (the ultrathink `redactMessage` rule: bearer values and known secret shapes become `[redacted]`, FastAPI array `detail` never shown). `HINDSIGHT_BANK_PREFIX` stays in `.env.example` with its `sub-` default. The `.env.example` "unused by substrate-mcp" note is updated to name the new reader (D25-02 precedent), and the `docs/data-planes.md` Hindsight wiring row changes from "not read by `substrate-mcp`" to "read by `substrate-mcp` `planes/hindsight.ts`; gateway keeps its own keys for its own paths".
</credentials>

<cache>
## Cache Deltas on the Shipped Client (D26-06)

Taken as-is from `packages/mcp-server/src/cache.ts`: `CACHE_PREFIX`, `CACHE_TTL` (`brief` 300 / `memory-search` 600 / `graph-view` 60), `MEMORY_GENERATION_KEY` + `GRAPHS_GENERATION_KEY` + per-graph keys, `earliestRefreshAt` (cached answers expire at the next lease/reverify deadline), `COMMAND_TIMEOUT_MS = CONNECT_TIMEOUT_MS = 800`, `CacheRedis` seam (fake in tests, Bun client in production), `/healthz` `{enabled, connected, mode, hits, misses, bypasses, errors}` with `mode` off/on/degraded. Deltas, and only deltas:
1. Recall-result coverage under `memory-search` class semantics (600 s, memory-generation bound, surface in the key input like the existing classes).
2. Claims-freshness pin: test that a claim newer than 60 s is visible in a brief served right after a cache hit on identical arguments (mechanism: existing graph-write generation bumps + always-fresh claims compose; the test is new, the mechanism is verified not assumed).
3. `parseRedisUrl` refusal of plaintext non-loopback `redis://` (DOCS-06); loopback and `rediss://` stay allowed; refusal is fail-open (cache off, answers uncached, reason logged).
4. NOT built: per-surface counters and the 24 h idempotency mirror as key classes (targets per data-planes; DOCS-05's counter need is met by the existing healthz counters). No queue/lock/session/pub-sub semantics are added — a restart still drops every key and the same answers come back uncached.
</cache>

<events>
## EVENT_KINDS Mapping (D26-07): Fits, No New Kind

Already decided in Phase 17 (`docs/event-vocabulary.md` mapping table plus `event-sources.ts`): `memory.retain` maps to `note` with the standing reason "A successful retain emits nothing; only a failure is a warning. Reads do not emit, like memory_search", and `memory.retain.failed` maps to `warning`. Recall is a read: no emit on success or on degraded-empty (the reason travels in the reply, like `memory_search`). Payloads follow the vocabulary rules: `{bank, document_id, rule}` locators plus hashes only, never values. This phase emits against the existing rows; the plan-26-02 test asserts `event-sources.test.ts` still passes unchanged.
</events>

<anti_pattern>
## Anti-Pattern Avoided (contract: acc30a8 stub + single-bank shape)

The `acc30a8` Hindsight stub ("recall inside the brief with 4 s timeout into one global bank, RESP client never called") is the shape this phase exists to replace: unbounded in-brief latency, unscoped single-bank reads, and unwritten cache promises. Every plan carries the negative gates: the fake banks server FAILS any recall missing the bank path segment and any retain missing `document_id`; a test fails on a `planes/hindsight` import in the brief compose path; a test fails on an unlisted surface falling back to a shared bank. A reviewer checking one thing checks that recall cannot slow the brief and cannot read outside the `sub-*` set.
</anti_pattern>
