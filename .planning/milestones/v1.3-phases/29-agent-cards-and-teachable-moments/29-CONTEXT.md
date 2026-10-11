# Phase 29: Agent Cards and teachable moments - Context

**Gathered:** 2026-10-10
**Status:** Ready for planning
**Mode:** Autonomous discuss (no operator round-trip; every decision below is sourced from a locked operator decision, the reviewed research, or a phase contract — nothing invents a user-visible choice). Items that change what the operator sees are recommended defaults the plans use, listed under "Open for the operator".

<domain>
## Phase Boundary

One PR on agent-substrate, `packages/mcp-server` only (ROADMAP: Repos `packages/mcp-server`; Requirements CARD-01..04).

1. **Agent Card per surface (CARD-01).** Every known surface gets an A2A v1.0 Agent Card on loopback at `/.well-known/agent-card.json?surface=<name>`, valid against the repo-documented v1.0 field set (id, name, description, supported interfaces, capabilities, default modes, `skills[]`). The in-repo validator implements that set from repo knowledge; the set itself is UNVERIFIED against the published spec — confirming it is OPERATOR-GATED G1, never agent work.
2. **Teachable moments (CARD-02).** A teachable is a governed `fact` whose subject carries the tag as the prefix `teachable:` (e.g. `teachable:retry-budget`), written through `memory_write`. No new memory kind, no tags field, no schema change. Each accepted teachable appears as one entry in its surface's card `skills[]`.
3. **Anchor coverage (CARD-03).** Each accepted teachable emits one `note` event shaped like the mapped `teachable.accepted` sample. The event is a normal event — server ingest order, `hourDigest`, hourly anchor, `verifyGraph` hour report cover it with zero anchor-code changes.
4. **Proof (CARD-04).** In-repo = isolated only: fixture cards + fake spec validator + scratch ledger + fake RPC. Card validation and teachable mapping run isolated; the devnet-anchored hour is an operator-approved window (agents do NOT run devnet transactions, do NOT fetch the spec, do NOT expose cards beyond loopback).

**Depends on:** Phase 21 (skill frontmatter conventions for `skills[]` entries: `SKILL_NAME_RE` + non-empty description), Phase 28 (hourly anchor job + `verifyGraph` hour report). Base: `main` at `e295746`.

**Out of scope:**
- Any `ALTER`/`DROP` of `agent_events`, `event_ingest`, `anchors`, memory tables; new `EVENT_KINDS` (locked at 12 — `check:phase-close` enforces); new `SURFACES`; new memory kinds; new packages; schema drift of any kind.
- Agent-run devnet transactions, agent-run spec fetches, agent-run card publication beyond loopback (G1/G2/G3 — operator windows only; plans carry them as markers, never steps).
- Anchors in the evidence bundle (`buildGraphEvidence` stays chain-only, D28-13).
- Library `SKILL.md` frontmatter inside cards (ARCHITECTURE's library-plus-teachable union is deferred; cards list teachables only in v1.3 — D29-05).
- The Hermes hourly miner rebind and skill-autonomy reinstall (Phase 22's OPERATOR-GATED cutover owns the mining paths; this phase owns the convention they write through).
</domain>

<decisions>
## Implementation Decisions

### Teachable convention (no schema change)
- **D29-01: A teachable is a governed `fact` with subject prefix `teachable:`.**
  - Sourced: operator D17 (STATE.md v1.3 decisions: "teachables are tagged governed facts, anchored by hash only") + F-D2's first alternative + `docs/memory-governance.md` ("`teachable` is not a memory kind", refused before any grant is consulted, proven in `memory-write.test.ts`).
  - `MemoryEntryInput` has no tags field (`types.ts:150-171`), and none is added. The subject carries the tag because the conflict key is `scope|kind|subject` (`memory-policy.ts:conflictKey`), so teachables collide sanely per topic, and `index-store.ts:1322-1328` matches `subjectPrefix` with `left()`, so the card builder reads a surface's teachables with a prefix search — no new index, no migration.
  - The gate path is unchanged: `governMemoryWrite` → RBAC, classification, redaction, idempotency, conflict, insert, read-back all apply. A refused teachable is a refused `fact`, nothing more. An empty slug after the prefix (`teachable:` with nothing after) is not a teachable.

### Teachable event (existing kind, matches the mapped sample)
- **D29-02: Exactly one new emit — accepted + verified_persisted teachable facts emit a `note` shaped like the `teachable.accepted` sample.**
  - Sourced: Phase 17 mapping (`event-sources.ts:367-382`: kind `note`, surface = writer's surface, `actions: ["teachable"]`, `carriesRepo: false`, sample payload `{ action: "teachable", memory_id, subject, content_sha256 }`) + EVENT_KINDS lock (12, D1).
  - `service.ts:auditMemoryWrite` returns early on accepted writes, so the emit lives in `writeMemory` after the gate returns, guarded on `accepted + verified_persisted + isTeachable + writer is a known surface` (the same SURFACES check the audit path uses). Fire-and-forget with `.catch(() => undefined)`: a failed trail write never fails the memory write.
  - Payload carries hash only (`memory_id`, full subject, 64-hex entry-hash-derived `content_sha256`) — never content bytes (PITFALLS 6; `docs/event-vocabulary.md:43`).

### Card-per-surface model (which surfaces publish cards)
- **D29-03: All 27 SURFACES publish cards on demand — the 11 lane-B/desk surfaces, the 15 `swarm-a01-orch`…`swarm-a15-doc` surfaces, and `substrate`.**
  - Sourced: `types.ts:30-47` (27 + `substrate`) + ADR 0001 S3 (swarm surfaces are known surfaces; their working set is `fact` at `graph:`/`repo:`/`agent:<self>` scope, so they can be taught) + ROADMAP criterion 1 ("each agent surface").
  - A surface with no teachables gets a valid card with empty `skills[]` — untaught is valid, not an error.
  - Route: `GET /.well-known/agent-card.json?surface=<name>` (ROADMAP literal). Missing `surface` → 400 naming the parameter; unknown surface → 400. No silent default — a card is per surface by CARD-01.
  - Unauthenticated discovery, same exemption class as `GET /healthz`: no agent action behind it, no audit record, emits nothing (`docs/event-vocabulary.md:92,115`; `docs/mcp-audit.md:246` already lists `agent_card` as fail-open read). Follows the existing GET-route pattern beside `/healthz`, `/metrics`, `/slo`.
  - ARCHITECTURE's `GET /agents/<surface>/agent-card.json` alias is executor's discretion (nice-to-have second route, same builder, same tests — not required).

### Card shape (repo-documented v1.0 set, UNVERIFIED — G1)
- **D29-04: The card implements the A2A v1.0 field set as documented in-repo: `name`, `description`, `url` (loopback marker), `version`, `capabilities` (object), `defaultInputModes` / `defaultOutputModes`, `skills[]`, plus `id` and `supportedInterfaces` per the ROADMAP criterion.**
  - Sourced: ROADMAP criterion 1 + STACK.md §F (v1.0 adds `supportedInterfaces[]`; discovery path `/.well-known/agent-card.json`) + F-D1 (AgentSkill `id`, `name`, `description`, `tags` including `teachable-moment`, `examples`).
  - The in-repo `validateAgentCard` checks exactly this set and is marked UNVERIFIED in code and docs until G1 (operator-approved fetch of the published spec + field diff) confirms or corrects it. The executor MUST NOT fetch the spec.
  - Skill entry mapping: `id` = accepted memory id; `name` = slug normalized to phase-21 `SKILL_NAME_RE` (`propose.ts:51`), with a numeric suffix when two slugs fold onto the same name (fixture-pinned); `description` = the entry's redacted text capped at 1,200 chars (DOCS-01 snippet precedent), re-passed through shared `redact.ts` defensively; `tags` = `["teachable-moment"]` (F-D1 literal); `examples` omitted — no source data exists and nothing is invented.

### What cards do NOT contain
- **D29-05: `skills[]` lists teachables only in v1.3 — no library `SKILL.md` frontmatter entries.**
  - Why: coupling cards to the `/root/agent-skills` checkout (dirty-tree refusals, sync state, Phase 22 ownership) would make card serving depend on library hygiene. ARCHITECTURE's library-plus-teachable union is recorded as a later enhancement, not this phase. A small static preamble (e.g. one entry per tool family) is allowed only if it stays spec-valid — default none.

### Verify and proof split
- **D29-06: CARD-03 needs no `verifyGraph` or anchor-code change.** The teachable event's hour is digested whole and reported `anchored`/`pending`/… by the Phase 28 hour report. Plan 29-03 pins this with a scratch-ledger + fake-RPC test (the Phase 28 pattern — no devnet, no `SOLANA_*` env, no CLI spawn, no network).
- **D29-07: `teachablesForSurface` excludes superseded rows** (`superseded_by` set — the same "not briefed" rule briefs use), kind `fact` only, writer === surface, newest-first. Read-only: no emit, no gate, no cache-bump.

### Rehearsal-first harness
- **D29-08: Every plan proves against fixtures first.** Plan 29-01 ships the shared fixture corpus (teachable entries: accepted / refused / quarantined / conflict / fold-collision pair); plan 29-02 ships fixture cards (valid + one per missing-field violation) and the fake spec validator; plan 29-03 ships the scratch-ledger + fake-RPC coverage proof. The Phase 16 harness is the runtime for route-level checks; the harness never carries `SOLANA_*` names (D28-12).

### Claude's Discretion
- File and method names (`teachable.ts`/`agent-card.ts`, `isTeachable`/`teachableSlug`/`buildAgentCard`/`validateAgentCard`/`teachablesForSurface`), the description cap constant, the fold-collision suffix scheme, the `url` loopback value (whatever `config` already exposes; tests pin relative shape, not host), whether the `/agents/<surface>/` alias route is added, and plan-internal test layout.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- Governed fact path: `packages/mcp-server/src/memory-write.ts` (`governMemoryWrite`, `normalizeSubject`, `contentHash`), `memory-policy.ts` (`conflictKey`, `grantFor`), `types.ts:150-192` (`MemoryEntryInput`/`MemoryEntry` — no tags field; `superseded_by` at :184; `MemorySearch.subjectPrefix` at :196-205).
- Service seams: `service.ts:1020` (`writeMemory`), `service.ts:1126` (`auditMemoryWrite` — early return on accepted+verified), `service.ts:870` (`emit`); `hourDigest`/`verifyGraph` hour report (untouched).
- HTTP routes: `server.ts:createHttpServer` — GET `/healthz`, `/metrics`, `/slo` (unauthenticated, unaudited); `ANONYMOUS_ROUTES` at `server.ts:64-77`.
- Vocabulary lock: `types.ts:30-47` SURFACES (27 + `substrate`), `types.ts:54-67` EVENT_KINDS (12), `event-sources.ts:367-382` `teachable.accepted` sample, `event-sources.ts:595` `agent_card` (emits nothing), `bun run check:phase-close`.
- Phase-21 conventions: `skills/propose.ts:51` (`SKILL_NAME_RE`), `skills/frontmatter.ts` (`parseFrontmatter`); name-valid + non-empty-description rule.
- Prefix search: `index-store.ts:1322-1328` (`subjectPrefix` via `left()`).
- Congruent prior attempt (unmerged): branch `gsd/v1.3-p29-agent-cards` holds a CONTEXT + 3 PLANs + implementation against the same constraints. Plans below are written to execute from `main` without that branch; where a design matches it, it does so because the constraints force it, and the branch is named as a cross-check, not a dependency.

### Established Patterns
- Only `greptime.ts` composes SQL; typed methods, values never syntax. This phase adds no store reads outside `searchMemory`/`hourDigest` typed methods.
- Fail closed where integrity is claimed, fail open for producers. The card route is a read (fail-open); the teachable emit never fails the write.
- `service.test.ts` injects structural stubs; `server.test.ts`/`http.test.ts` pin routes; `event-sources.test.ts` + `vocabulary-smoke.test.ts` pin the vocabulary.
- Rehearsal-first with fixtures; live tails operator-gated with rollback named (Phases 25/26 precedent: G1-G4 gated live map).

### Integration Points
- `service.ts`: `writeMemory` (emit hook), `teachablesForSurface` (new reader).
- `server.ts`: `GET /.well-known/agent-card.json` (new route, unauthenticated).
- `event-sources.ts`: no change (entry already mapped); tests pin the emit against the sample.
- `docs/agent-cards.md`: new (convention, route, coverage argument, gated live map).
</code_context>

<specifics>
## Specific Ideas

- Requirement wording is the contract. CARD-01: "validates against the spec (id, name, description, supported interfaces, capabilities, default modes, `skills[]`)". CARD-02: "tagged governed `fact` … with no new memory kind … each accepted teachable appears as an entry in its surface's card `skills[]`". CARD-03: "emit events inside the hourly anchor's coverage … `verify` reports the hour holding a teachable as anchored". CARD-04: "appears in that surface's Agent Card, and its event sits inside an anchored hour".
- Hash only, never text, on every trail: the `teachable.accepted` payload carries `memory_id`, `subject`, `content_sha256` — the hourly root then covers the teachable without any content touching the chain (operator D17).
- Roots only, never event contents, on devnet only (build plan §11; D28-07 argv unchanged and untouched by this phase).

</specifics>

<deferred>
## Deferred Ideas

- Library `SKILL.md` frontmatter entries in cards (ARCHITECTURE union) — later enhancement, needs Phase 22 sync-state coupling decision.
- `AgentSkill.examples` population — no source data; omitted, not stubbed.
- Anchors in the evidence bundle (FEATURES E-D1); per-teachable memos (ARCHITECTURE Port Map E: dropped — unparseable by `memo.ts parseMemo`, redesigned as hourly-root coverage).
- A repair sweep for events whose ingest record failed (D27-09); a legacy verifier for the D-era window.
- Moving cards beyond loopback (any real publication endpoint is G2).
</deferred>

## Open for the operator

Recommended defaults the plans use; each changes what the operator sees.

1. **The route is `?surface=` on the well-known path (D29-03).** Why: it satisfies the ROADMAP wording literally with one route. Alternative: ARCHITECTURE's `GET /agents/<surface>/agent-card.json` as the primary — the executor may add it as an alias, not a replacement.
2. **Cards list teachables only, no library skills (D29-05).** Effect: a freshly taught surface shows exactly what it was taught; the library stays out of the card until a later phase couples them.
3. **The card route is unauthenticated discovery (D29-03).** Why: A2A discovery is unauthenticated by design; no agent action sits behind the route. Effect: anonymous loopback GETs return 200. Alternative: bearer-required — contradicts A2A discovery and is not planned.

## Live steps (each needs operator approval — markers only, never executed by plans)

| # | What | Why | Kind |
|---|------|-----|------|
| G1 | Fetch the published A2A spec (`https://a2a-protocol.org/latest/specification/`) and diff its Agent Card required fields against the in-repo validator set; record confirmation or correction in the phase report | The spec URL/shape is UNVERIFIED (ARCHITECTURE research flag); the validator must not calcify an assumed set | read-only (network read) |
| G2 | Read a loopback card per surface (`GET /.well-known/agent-card.json?surface=<name>` × 27); decide whether any card is published beyond loopback (none in v1.3 — exposure is a separate operator decision with rollback: stop serving / restrict) | CARD-01 live leg; any real card publication endpoint is operator-gated per contract | read-only (loopback); write only if exposure is approved (never in this phase by default) |
| G3 | With the funded devnet key: emit a proof teachable into production, let the hourly timer anchor its hour, read the memo back by `tx_sig`, `substrate verify <proof graph>` shows the teachable hour `anchored` | CARD-03/CARD-04 live leg — every teachable covered by the hourly anchor, proven on devnet-backed hours | write (production ledger + devnet + `anchors` row + ledger event) |

## OPERATOR-GATED inventory (for the phase report)

- G1: real spec validation against the published A2A spec.
- G2: any real card publication endpoint beyond loopback.
- G3: live teachable-anchor coverage proof on devnet-backed hours.
