# Phase 29: Agent Cards and teachable moments — Research

**Researched:** 2026-10-10
**Domain:** Per-surface A2A v1.0 Agent Cards on loopback whose `skills[]` list accepted teachables; teachables as governed `fact` entries (`teachable:` subject prefix) covered by the Phase 28 hourly anchor; no new kinds, surfaces, packages, or schema.
**Confidence:** HIGH for the repo-documented contract and seams (every source read on `main` at `e295746`, on `acc30a8`/`21652a2` git objects, and in `.planning/research/` this session); LOW where marked UNVERIFIED (resolved-or-gated below, never assumed).

<user_constraints>
## User Constraints (from CONTEXT.md)

Locked: D29-01 (teachable = governed `fact`, `teachable:` subject prefix, no new kind/tags field — operator D17), D29-02 (one new emit: accepted + verified teachable → sample-shaped `note` in `writeMemory`), D29-03 (all 27 SURFACES publish on demand at `GET /.well-known/agent-card.json?surface=`; 400 on missing/unknown; unauthenticated discovery), D29-04 (repo-documented v1.0 field set; in-repo validator marked UNVERIFIED until G1), D29-05 (`skills[]` teachables-only in v1.3), D29-06 (no `verifyGraph`/anchor changes), D29-07 (superseded excluded), D29-08 (rehearsal-first fixtures), G1/G2/G3 operator-gated (never executed by plans).
</user_constraints>

<a2a_fields>
## A2A v1.0 Agent Card Required Fields (from repo knowledge — UNVERIFIED vs the published spec)

No in-repo file quotes the published spec verbatim. The field set below is assembled from the repo's reviewed research; every row names its source. The set as a whole is UNVERIFIED against the current spec version (ARCHITECTURE's explicit flag) — confirming it is OPERATOR-GATED G1.

| Field | Repo source | Status |
|---|---|---|
| Discovery path `/.well-known/agent-card.json` | STACK.md §F; ARCHITECTURE §F2 | Attested (v0.3 renamed `agent.json` → `agent-card.json`) |
| `id` | ROADMAP CARD-01 ("validates against the spec (id, …)") | Attested as required by the phase contract |
| `name` | ROADMAP CARD-01 | Attested |
| `description` | ROADMAP CARD-01; STACK.md §F (stub "lacks … `description`") | Attested |
| `supportedInterfaces[]` | ROADMAP CARD-01 ("supported interfaces"); STACK.md §F ("v1.0 adds `supportedInterfaces[]`") | Attested as the v1.0 addition |
| `capabilities` (object) | ROADMAP CARD-01; STACK.md §F (stub "lacks … `capabilities`") | Attested |
| default modes (`defaultInputModes` / `defaultOutputModes`) | ROADMAP CARD-01 ("default modes"); STACK.md §F (stub "lacks … the default modes") | Attested |
| `skills[]` | ROADMAP CARD-01 + CARD-02 | Attested |
| `url` | STACK.md §F (v0.3 shape carried `url`) | Carried as loopback marker (exact value at executor discretion) |
| `version` | Stub + ARCHITECTURE (card versioning assumed) | Carried |
| `AgentSkill`: `id`, `name`, `description` | F-D1 ("teachable moments as `AgentSkill` entries (`id`, `name`, `description`, …)") | Attested |
| `AgentSkill`: `tags` including `teachable-moment` | F-D1 literal | Attested — plan tag is `teachable-moment` |
| `AgentSkill`: `examples` | F-D1 lists it | Attested as optional — omitted (no source data; nothing invented) |
| Spec version "A2A v1.0 (released 2026-03-12; v1.0.1 latest GitHub release); protobuf `a2a.proto` normative; spec at `https://a2a-protocol.org/latest/specification/`" | STACK.md §F + sources line | UNVERIFIED — G1 re-checks liveness and field currency |
| No SDK (`@a2a-js/sdk` not needed; static JSON; nothing speaks JSON-RPC) | STACK.md §F dependency table | Decided — no new packages |

What "spec-valid" means in-repo: `validateAgentCard` returns empty (checks every attested row above; `examples` not required). The function and its fixture corpus are marked UNVERIFIED-in-code until G1 confirms or corrects the set.
</a2a_fields>

<card_model>
## Card-Per-Surface Model (which surfaces publish cards)

27 SURFACES (`types.ts:30-47`): 11 lane-B/desk surfaces (`claude-code`, `cursor`, `hermes`, `omp`, `muse`, `grok-build`, `grok-bot`, `codex`, `opencode`, `pi`, `rivet-agentos`), 15 swarm surfaces (`swarm-a01-orch`…`swarm-a15-doc`), plus `substrate` (Phase 17 host-job surface; its card is the runtime identity of the anchor/sync/dispatcher jobs, with `payload.runtime`-style provenance in its description, not a new surface).

- All 27 publish on demand. Swarm surfaces are known surfaces with `fact` grants at `graph:`/`repo:`/`agent:<self>` scope (ADR 0001 S3 via `docs/memory-governance.md`), so they can be taught and therefore carded. Untaught surfaces return a valid card with `skills: []`.
- One route serves all: `GET /.well-known/agent-card.json?surface=<name>` (ROADMAP literal). ARCHITECTURE's `GET /agents/<surface>/agent-card.json` (which also proposed unioning library frontmatter into `skills[]`) is executor-discretion alias only — the library union is deferred with D29-05.
- Card identity per surface: `id`/`name` derive from the surface (executor picks the stable scheme; tests pin uniqueness across all 27, not the string template). A single loopback server therefore serves 27 distinct cards — the `?surface=` parameter is the demultiplexer, and its absence is a 400, never a silent default.
</card_model>

<capture_path>
## Teachable Capture Path (memory write gate → governed fact tag → hash anchor)

1. **Session observation → `memory_write`.** Any surface writes `kind: "fact"`, `subject: "teachable:<slug>"` (the Hermes hourly miner from Phase 22, skill-autonomy, Omp `learn`, or a direct session write — the convention is transport-agnostic; Phase 22 owns the mining paths, this phase owns the convention they write through).
2. **The unchanged gate.** `governMemoryWrite` → shape → RBAC (writer from the bearer token, never the body) → quarantine (secrets/speculative refused) → exactly-once → conflict/insert/read-back (`docs/memory-governance.md` five stages). Scope follows existing grants: `graph:<id>` / `repo:<owner/name>` / `agent:<own surface>` for facts; `global` facts propose until reviewer release.
3. **Tag = subject prefix.** No tags field exists (`types.ts:150-171`); the `teachable:` prefix is the tag. Conflict identity (`scope|kind|subject`) versions teachables per topic; `subjectPrefix` search (`index-store.ts:1322-1328`) reads them back without migration.
4. **Accepted + verified → one `note`.** `writeMemory` emits `teachable.accepted` (kind `note`, writer surface, `{ action: "teachable", memory_id, subject, content_sha256 }` — hash only, never text). Refused/quarantined/conflicting writes emit no teachable event (only the existing audit trail).
5. **Normal ingest → hourly anchor.** The event lands in its UTC ingest hour (`event_ingest`), `hourDigest` covers it, the Phase 28 job anchors the hour on devnet (memo `substrate:v1:<hour>:<root>:<count>` — roots only), `verifyGraph` reports the hour `anchored`. CARD-03 with zero anchor-code changes.
6. **Card read.** `teachablesForSurface` (prefix search, writer filter, superseded excluded) → `buildAgentCard` → `skills[]` entry per teachable (`id` = memory id, `name` = slug ∩ `SKILL_NAME_RE`, `description` = redacted text ≤ 1,200 chars, `tags: ["teachable-moment"]`).
</capture_path>

<stubs>
## acc30a8 Stub Inventory (what exists, what is dropped, what is redesigned)

| Stub | Location | Verdict |
|---|---|---|
| `AgentCard` interface `{agent, surface, version, skills[{name, framing, tags}], teachables[]}` | `21652a2:packages/mcp-server/src/types.ts:155-167` (also `8db99f9`) | **Dropped as shape** — not spec-valid (no `id`, `description`, `supportedInterfaces`, `capabilities`, default modes). Recorded only as the anti-pattern the validator must reject (a fixture card pins its rejection). |
| `TeachableMoment` interface (observations/edges/learnings/framing/`prev_event_hash`/`solana_anchor`) | Same file `:164-176` | **Redesigned** — no `TeachableMoment` type is stored anywhere; a teachable IS a `MemoryEntry` (`fact` + prefixed subject). Extraction heuristics (`extractTeachableFromEvents`: keyword grep for "error"/"learned"/"lesson") are not ported — mining policy belongs to Phase 22 paths. |
| `makeAgentCard` (`version: "v0.3-a2a"`) | `21652a2:packages/miner/src/teachable.ts:39-48` | **Dropped** — version string predates v1.0; replaced by `buildAgentCard` + `validateAgentCard`. |
| `anchorTeachableOnSolanaDevnet` (per-teachable memo `substrate:<graph_id>:<framing>`) | Same file `:50-62` | **Dropped** — unparseable by `memo.ts parseMemo` (ARCHITECTURE Port Map E); per-teachable memos would also multiply devnet sends 24×. Replaced by hourly-root coverage (D29-06). |
| `verifyTeachableAnchor` (boolean over stub fields) | Same file `:62+` | **Dropped** — replaced by the Phase 28 hour report naming the teachable's hour. |
| Devnet-memo stub ("devnet-memo style sig" built from `Date.now()`) | PITFALLS P15 (`04-skills-a2a/SUMMARY.md` "Solana stub") | **Cited as the stubs-as-complete anti-pattern** — this phase ships no stub: every proof asserts against a fake chain or a real read-back, never a fabricated signature. |

Net: nothing is ported. The stubs contribute exactly two things: the field names the validator must demand (by their absence) and the per-teachable-memo design that was considered and rejected (with rationale recorded above).
</stubs>

<unverified>
## UNVERIFIED Items: Resolve or Gate (never assume)

| ID | Item | Status after this research | Disposition |
|---|---|---|---|
| U-01 | A2A v1.0 required-field set vs the published spec | Assembled from reviewed in-repo research (ROADMAP + STACK + F-D1 + ARCHITECTURE); the spec URL/shape was already flagged UNVERIFIED when recorded | **GATED (G1):** operator-approved fetch of the spec + field diff; rehearsal validator implements the repo-documented set and is marked UNVERIFIED-in-code so it cannot calcify an assumption. Fixture corpus covers every attested field's absence. |
| U-02 | Any real card consumer / publication beyond loopback | No consumer exists in-repo; v1.3 serves loopback only by decision | **GATED (G2):** loopback reads are rehearsal + operator read-back; any exposure beyond loopback is a separate operator decision (with rollback) — never in this phase by default. |
| U-03 | Live teachable-anchor coverage on devnet-backed hours | Producible only with the funded devnet key + timer (Phase 28 L1-L10 precedent) | **GATED (G3):** rehearsal proves session → card → anchored-hour on scratch + fake RPC (including tamper-mismatch); the funded-key window + `substrate verify` read-back is operator-run. No `SOLANA_*` in any harness, no CLI spawn, no network in-repo. |
| U-04 | Whether two slugs can fold onto one `SKILL_NAME_RE` name | Normalization is lossy (case, separators) — collision is certain at scale | **RESOLVED as rehearsal-pinned:** numeric-suffix rule with a fold-collision fixture pair; cross-surface uniqueness not required (cards are per surface). |

Net: U-01..U-03 are explicitly gated live steps with rehearsal coverage for every known shape; U-04 is decided and fixture-pinned. No plan proceeds on an assumed external shape: the fake validator implements the repo-documented set loudly marked UNVERIFIED, and the fake RPC implements the Phase 28 read-back skeleton.
</unverified>

<locks>
## Store-Lock, Planes, and Vocabulary Notes for Plans

- No plane MCP in agent configs (operator D9; Phase 18 store-lock rule): cards are served from the governed index, never from Hindsight/RAGFlow (retired)/Dragonfly reads. Plans carry a negative gate — no `planes/` import in `agent-card.ts`/`teachable.ts`.
- `SOLANA_*` names appear only in the anchor module (Phase 18 rule; D28-11): plans carry a negative gate — no `SOLANA_*` in new files, tests, or fixtures.
- Vocabulary: `teachable.accepted` already mapped (`event-sources.ts:367-382`); `agent_card` already recorded as emit-nothing (`:595`). Plans add no `EVENT_SOURCES` entry and touch neither `types.ts` enums — `check:phase-close` + `vocabulary-smoke` stay green by construction, and every plan re-runs them.
- Redaction: skill descriptions re-pass shared `redact.ts` (Phase 18 owns it; no new rules). Finding-shaped payloads (`{file, line, rule}`, never values) for any refusal the route could surface — the route has no refusals beyond 400s, which carry names, not content.
</locks>

<contracts>
## Dep Contracts Consumed (21 + 26 + 28)

- **21 (skills_propose):** `SKILL_NAME_RE` (`skills/propose.ts:51`), non-empty-description rule, `readSkillDir` refusal posture (no symlinks/special/non-UTF-8 — mirrored in spirit: card descriptions are gate-redacted text, never raw library bytes).
- **26 (memory governance):** five-stage gate, writer-from-token, `teachable`-is-not-a-kind refusal, `verified_persisted` as the stored claim, Hindsight forward stays as-is (teachables forward like any accepted fact — no teachable branch in the forward path).
- **28 (anchor + verify):** `hourDigest` whole-hour digests, `anchors` 11-column rows, `verifyGraph` hour report (`anchored`/`pending`/`unanchored`/`mismatch`/`unverified`), fake-RPC + scratch-ledger proof pattern, `SOLANA_*`-free harness rule.
</contracts>
