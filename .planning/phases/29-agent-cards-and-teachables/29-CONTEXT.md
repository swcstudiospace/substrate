# Phase 29: Agent Cards and teachable moments - Context

**Gathered:** 2026-10-10
**Status:** Ready for planning
**Mode:** Auto-generated, discuss skipped (per assignment; no operator decisions change a user-visible contract beyond what CARD-01..04 already fix)

## Phase Boundary

One PR on agent-substrate, `packages/mcp-server` only (ROADMAP: Repos `packages/mcp-server`; Requirements CARD-01..04).

1. **Agent Card per surface (CARD-01).** Each agent surface publishes an A2A v1.0 Agent Card served on loopback at `/.well-known/agent-card.json` (per surface), valid against the spec: id, name, description, supported interfaces, capabilities, default modes, `skills[]`.
2. **Teachable moments (CARD-02).** A teachable moment is a governed `fact` (tagged, no new memory kind) written through `memory_write` from a session's observations or edge cases; each accepted teachable appears as an entry in its surface's card `skills[]`.
3. **Anchor coverage (CARD-03).** Teachable writes emit events inside the hourly anchor's coverage, and `verify` reports the hour holding a teachable as anchored.
4. **Proof (CARD-04).** A teachable recorded from a session appears in that surface's Agent Card, and its event sits inside an anchored hour. Card validation and teachable mapping run isolated; the anchored-hour devnet anchor is an operator-approved window (agents do NOT run devnet transactions).

**Depends on:** Phase 21 (skill frontmatter conventions for `skills[]` entries: `name` + non-empty `description`), Phase 28 (hourly anchor job + `verifyGraph` hour report). Base: origin/main at 589a27c (phase 28 merged).

**Out of scope:**
- Any `ALTER`/`DROP` of `agent_events`, `event_ingest`, `anchors`, memory tables; new `EVENT_KINDS` (locked at 12 — `check:phase-close` enforces); new `SURFACES`; new memory kinds; new packages; schema drift of any kind.
- Agent-run devnet transactions (operator-approved window only; plans must use injected/fake RPC and scratch ledgers).
- Anchors in the evidence bundle (`buildGraphEvidence` stays chain-only, D28-13).
- Product source changes; only `packages/mcp-server/src` + its tests (+ `docs/` note at most).

## Implementation Decisions (locked for plans)

### Teachable tag convention (no schema change)
- `MemoryEntryInput` has **no tags field** (`types.ts:150-171`), and none is added. A teachable is a governed `fact` whose **subject carries the tag as the prefix `teachable:`** (e.g. subject `teachable:retry-budget`).
- Why the subject: the conflict key is `scope|kind|subject` (`memory-policy.ts:conflictKey`), so teachables collide sanely per topic; and `index-store.ts:1322-1328` matches `subjectPrefix` with `left()`, so the card builder reads a surface's teachables with a prefix search — no new index, no migration.
- The gate path is unchanged: `governMemoryWrite` → RBAC, classification, redaction, idempotency all apply. A refused teachable is a refused `fact`, nothing more.

### Teachable event (existing kind, matches the mapped sample)
- `event-sources.ts:367-382` already maps `teachable.accepted` (phase 29): kind `note`, surface = the memory writer's surface (`memory-writer` = whoever wrote), `actions: ["teachable"]`, `carriesRepo: false`, sample payload `{ action: "teachable", memory_id, subject, content_sha256 }`.
- Today `service.ts:auditMemoryWrite` (lines 1057-1087) returns **early on accepted writes** — accepted memories emit nothing. CARD-03 therefore adds exactly one emit: on an **accepted + verified_persisted** teachable `fact`, `Substrate` emits a `note` from the writer's surface shaped exactly like the `teachable.accepted` sample (summary `teachable accepted: <slug>`, caller's `session_id`/`graph_id`, payload `{ action: "teachable", memory_id, subject, content_sha256 }`). Content hash is `entry_hash`-derived (hex), never content.
- Kind `note` and writer surfaces are both in the locked vocabulary, so `vocabulary-smoke` / `store-lock` / `check:phase-close` stay green. The event is a normal event: server ingest order + `hourDigest` + anchor + `verifyGraph` cover it with zero anchor-code changes (CARD-03 falls out of the emit).

### Agent Card shape (A2A v1.0) and route
- New pure builder `packages/mcp-server/src/agent-card.ts`: `buildAgentCard(surface, teachables) → AgentCard` with A2A v1.0 fields: `name`, `description`, `url` (loopback), `version`, `capabilities` (object), `defaultInputModes` / `defaultOutputModes`, `skills[]`. Each skill entry: `{ id, name, description, tags }` — `name` satisfies phase-21 `SKILL_NAME_RE`, `description` is non-empty (phase-21 frontmatter contract, `propose.ts:validateProposal`).
- Skill description source: the teachable entry's redacted text, capped (1,200 chars, the DOCS-01 snippet precedent — never raw secrets; text already passed the gate's redaction, and the builder caps + redacts again defensively via shared `redact.ts`).
- Route: `GET /.well-known/agent-card.json?surface=<name>` in `server.ts` (`createHttpServer`, beside the other GET reads `/healthz`, `/metrics`, `/slo`). Unknown surface → 400; missing `surface` → 400 naming the parameter (no silent default — a card is per surface by CARD-01). Loopback-only like the rest of the server; unauthenticated (A2A discovery; same exemption class as `/healthz` — no agent action behind it, no audit record).
- `Substrate` gains one reader, e.g. `teachablesForSurface(surface)`: index `searchMemory` with `subjectPrefix "teachable:"`, writer filter = surface, excluding superseded (same "not briefed" rule as `MemoryEntry.superseded_by`). Pure read path; no emit, no gate.

### Verify and proof split
- CARD-03 needs no `verifyGraph` change: the teachable event's hour is digested whole and reported `anchored`/`pending`/… by the phase-28 hour report. Plan 29-03 pins this with a test (accepted teachable → event → hour digest covers the event → hour report names the hour), using the fake-RPC / scratch-ledger pattern from phase 28 — no devnet.
- CARD-04 proof in-repo = isolated only: card validates + teachable appears + event sits in an anchored hour on a scratch ledger with injected anchors row / fake RPC read-back. The real devnet-anchored hour is an operator-approved window and is NOT planned as agent work.

## Code Pointers (verified 2026-10-10 in the worktree)

- Governed fact path: `packages/mcp-server/src/memory-write.ts` (`governMemoryWrite`, `normalizeSubject`, `contentHash`/`entryHash`), `memory-policy.ts` (`conflictKey`, `grantFor`, `resolveTrust`), `types.ts:150-192` (`MemoryEntryInput`/`MemoryEntry` — no tags field).
- Service seams: `service.ts:992-1044` (`writeMemory`), `service.ts:1057-1087` (`auditMemoryWrite` — early return on accepted), `service.ts:870` (`emit`), `service.ts:2485-3028` (`hourDigest`, `verifyGraph`, hour report — untouched).
- HTTP routes: `server.ts:createHttpServer` — POST `/memory`, `/events`, `/verify`, GET `/healthz`, `/metrics`, `/slo`; no `/.well-known` route yet; `ANONYMOUS_ROUTES` set at `server.ts:64-77`.
- Vocabulary lock: `types.ts:30-47` SURFACES (27 + `substrate`), `types.ts:54-67` EVENT_KINDS (12), `event-sources.ts:367-382` `teachable.accepted` sample, `scripts/phase-close-check.ts` (`bun run check:phase-close`).
- Phase-21 conventions: `skills/frontmatter.ts` (`parseFrontmatter`), `skills/propose.ts:51` (`SKILL_NAME_RE`), `propose.ts:237-240` (name == frontmatter name, non-empty description).
- Prefix search: `index-store.ts:1322-1328` (`subjectPrefix` via `left()`), `types.ts:198-209` (`MemorySearch`).

## Open Questions (none blocking)

1. Card `url` value: loopback base the server knows (config) vs a fixed relative marker — executor picks whatever `config` already exposes; test pins relative shape, not host.
2. Whether `GET /.well-known/agent-card.json` needs an `observe.ts`/audit-policy entry: no (read-only discovery, same class as `/healthz`); if the policy test disagrees, the executor adds the exemption the way `/healthz` is exempted.
3. Static base skills in `skills[]` besides teachables (e.g. one entry per MCP tool family): optional; teachables are the requirement — executor may include a small fixed preamble only if it stays spec-valid.
