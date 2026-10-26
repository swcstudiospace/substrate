# Requirements: Agent Substrate — v1.3.x and v1.5 programs

**Defined:** 2026-10-21
**Core Value:** Every agent on the host shares one brief, one event log, one governed memory plane, one skills library and one Graph ID.

## Sources

- `.planning/research/SUMMARY.md` lines 64–72: must-have (64–66), should-have (68), defer (70), anti-features to hold (72).
- `.planning/research/FEATURES.md` Differentiators table, rows for the 15 v1.3.x IDs at lines 197–222 (table header at line 195).
- `.planning/milestones/v1.3-REQUIREMENTS.md` line 85 (DOCS-04), cited only for the D-D1 conflict.
- `.planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements)`: the seven SOTA enhancements, lines 12–59.

Column mapping. The FEATURES.md Differentiators header is `| ID | Area | Feature | Value Proposition | Complexity | Notes |` (line 195). This file uses: Item = Feature; Outcome = Value Proposition; Notes = the FEATURES.md Notes column, verbatim; it sometimes names a dependency and sometimes gives a rationale. Where Notes is empty, the value is "not stated".

## v1.3.x should-have requirements

Source for all entries: `.planning/research/FEATURES.md` lines 197–222 and `.planning/research/SUMMARY.md` line 68. Phase mapping is set by the program plan, not by the sources.

- [x] **A-D1**: Lane B events reach the graph's brief and evidence without agents passing ids
  - Item: Infer the graph from the per-Graph-ID worktree path for herdr and Muse events. Area: A (Lane B collectors). Complexity: LOW. Notes: Needs C-T3. Phase: 37. Source: FEATURES.md:197
- [x] **B-D1**: Closes `coordination.md:321` "Not done"
  - Item: Mirror graph edges (`requires` / `blocks` / `gated_by`) into Linear relations. Area: B (claim mirror). Complexity: MEDIUM. Notes: not stated. Phase: 38. Source: FEATURES.md:200
- [x] **B-D3**: One artifact shows claim → Linear → Notion → DoD
  - Item: Put mirror outcomes in `substrate evidence` per node. Area: B (claim mirror). Complexity: LOW. Notes: M6. Phase: 38. Source: FEATURES.md:202
- [x] **C-D2**: The dispatched context can be replayed from the ledger (v0.3 §2)
  - Item: Dispatch as a signed handoff packet (goal from the issue, DoD lines, files). Area: C (dispatcher). Complexity: LOW-MEDIUM. Notes: M2. Phase: 39. Source: FEATURES.md:204. Decision (2026-10-21): the goal is the issue identifier and the DoD lines are fixed; issue prose stays out of the packet (DISP-07).
- [x] **C-D4**: A stale-brief warning before acting (v0.3 §2)
  - Item: Run `coord_drift_scan` on the worktree before launch. Area: C (dispatcher). Complexity: LOW. Notes: M2. Phase: 39. Source: FEATURES.md:206
- [ ] **D-D1**: `data-planes.md:34`
  - Item: Cross-surface recall in the brief: a bounded, cached fan-out over the `sub-*` banks. Area: D (docs plane). Complexity: MEDIUM. Notes: `agentId:"*"` is an Agentmemory idiom, and Hindsight banks are isolated ([docs](https://docs.hindsight.vectorize.io/memory-banks/)). Phase: 40. Source: FEATURES.md:207
  - Decision (2026-10-21): DOCS-04 is amended to allow recall inside the brief, as a bounded, cached fan-out (this item). The original DOCS-04 wording is in `.planning/milestones/v1.3-REQUIREMENTS.md:85`. The research anti-feature at `.planning/research/SUMMARY.md:72` still reads "recall inside the synchronous brief"; this decision accepts it for this bounded case only. Open for the phase 40 discuss step: whether the 1.5 s brief budget still applies.
- [ ] **D-D3**: One memory plane (the §5.0 no-silo rule)
  - Item: Retire Claude Code's global `hindsight` stdio MCP and Hermes supermemory once the `sub-*` banks answer, with restore routes recorded first. Area: D (docs plane). Complexity: MEDIUM. Notes: P10. Phase: 40. Source: FEATURES.md:209
- [ ] **D-D4**: Mental models replace stale detail (`data-planes.md:27,39`)
  - Item: A weekly `reflect` per bank. Area: D (docs plane). Complexity: LOW. Notes: not stated. Phase: 40. Source: FEATURES.md:210
- [ ] **E-D1**: PR and incident evidence anyone can check outside the system (v0.3 6.x)
  - Item: Anchors in the evidence bundle: a tx signature and an explorer link per hour. Area: E (ledger anchor). Complexity: LOW. Notes: M6. Phase: 41. Source: FEATURES.md:211
- [ ] **E-D2**: A user addition carried in the brief's area E
  - Item: Anchor teachable moments (graph id plus an observation digest). Area: E/F (as written in source). Complexity: MEDIUM. Notes: Needs F-D2 and E-T4. Phase: 41. Source: FEATURES.md:212
- [ ] **F-D3**: §5.1; v0.3 "4.x Skill approve audit"
  - Item: `skills_list` and an approve/decline audit trail. Area: F (skills plane). Complexity: LOW-MEDIUM. Notes: In September, approval meant the owner merging the PR (D-16). How `declined` is reported was left unspecified. Phase: 42. Source: FEATURES.md:215
- [ ] **F-D4**: Skills become searchable through `docs_search`
  - Item: Re-ingest the `agent-skills` dataset after each fast-forward. Area: F/D (as written in source). Complexity: LOW. Notes: D-T3. Phase: 42. Source: FEATURES.md:216
- [ ] **H-D1**: September N3: the container could reach example.com
  - Item: An enforced egress allowlist for the sandbox container. Area: H (Lane A). Complexity: MEDIUM. Notes: not stated. Phase: 43. Source: FEATURES.md:219
- [ ] **H-D3**: No orphaned VMs
  - Item: Re-adopt running tasks after a dispatcher restart (N4). Area: H (Lane A). Complexity: LOW-MEDIUM. Notes: not stated. Phase: 43. Source: FEATURES.md:221
- [ ] **I-D1**: A regression check for every later phase
  - Item: The UAT as a repeatable script run against any `SUBSTRATE_URL`. Area: I (Phase 0 UAT). Complexity: LOW-MEDIUM. Notes: not stated. Phase: 44. Source: FEATURES.md:222

## v1.5 SOTA requirements

Source for all entries: `.planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements)`. The Acceptance and Target files lines are copied verbatim.

- [ ] **SOTA-01**: Railway Resource Orchestrator. Phase: 45. Source: .planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements):12–17
  - Acceptance: MCP tool lists Railway resources, basic scale suggestion, cost report in /slo.
  - Target files: packages/mcp-server/src (new railway.ts), docs/data-planes.md, config-reference.md
  - Budget: $50 per month at test scale, confirmed 2026-10-21 (uplift-7/BLOCKING-UNKNOWNS.md item 8).
- [ ] **SOTA-02**: RAGFlow Advanced Hybrid RAG with Hindsight Context. Phase: 46. Source: .planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements):19–24
  - Acceptance: docs_search returns context-augmented results; tests for hybrid.
  - Target files: packages/mcp-server/src/planes/ragflow.ts, planes/hindsight.ts, docs/docs-plane.md
- [ ] **SOTA-03**: GreptimeDB + Dragonfly Predictive Analytics & Cache. Phase: 47. Source: .planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements):26–31
  - Acceptance: /slo has predictive rows; cache preloads based on patterns.
  - Target files: packages/mcp-server/src/cache.ts, greptime code, observability, data-planes.md
- [ ] **SOTA-04**: TailscaleDB Secure Unified Proxy Layer. Phase: 48. Source: .planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements):33–38
  - Acceptance: All DBs accessed via secure proxy; audit events for access.
  - Target files: docs/railway-tailscale.md, data-planes.md, config for DBs
- [ ] **SOTA-05**: Hindsight Graph Memory with Greptime Events. Phase: 49. Source: .planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements):40–45
  - Acceptance: memory_search returns graph-linked results; recall uses causal.
  - Target files: packages/mcp-server/src/planes/hindsight.ts, memory code, greptime
- [ ] **SOTA-06**: Dragonfly Pub/Sub for Real-time Events. Phase: 50. Source: .planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements):47–52
  - Acceptance: Real-time notifications for events via Dragonfly; tests.
  - Target files: packages/mcp-server/src/cache.ts, event emit code
- [ ] **SOTA-07**: Enterprise Unified Resource Fabric. Phase: 51. Source: .planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements):54–59
  - Acceptance: New MCP tools for fabric status, optimization suggestions; compliance report.
  - Target files: packages/mcp-server/src (new fabric/), observability, docs, config-reference

- [ ] **SOTA-08**: GSD-Core planning index and cross-session awareness core. Phase: 52. Source: .planning/ROADMAP.md Phase 52 (defined 2026-10-22; not in .planning/7-SOTA-ENHANCEMENTS.md, which lists items 1–7 only)
  - Acceptance: deterministic content-hash index of `.planning` artifacts where a full rebuild equals the incremental result; session presence with server-time TTL, stale derived at read time and never deleted; planning-change diffs on the existing event bus carrying paths and hashes, never bodies; read-only MCP tools `planning_status` and `planning_sessions`, each with an entry in `packages/audit/src/policy.ts`; file-only mode works with every backing service disabled; environment-only configuration.
  - Target files: packages/mcp-server/src (new planning/ modules), packages/audit/src/policy.ts, docs, config-reference
- [ ] **SOTA-09**: Steering, conflict control and checkpoint/resume. Phase: 53. Source: .planning/ROADMAP.md Phase 53 (defined 2026-10-22; not in .planning/7-SOTA-ENHANCEMENTS.md, which lists items 1–7 only)
  - Acceptance: steering directives queued, then acknowledged, then audited in TimescaleDB before any file change, and held with no file change when the audit cannot be written; conflicts between sessions on the same parsed phase or plan id emit events and never auto-resolve; a watcher gap marks the session view unknown until a full rescan; kill-and-restart at a plan-step boundary yields exactly one completion record keyed by phase id, plan step and file hash.
  - Target files: packages/mcp-server/src (planning steering and checkpoint modules), TimescaleDB index schema, config-reference
- [ ] **SOTA-10**: Planning observability and migration inventory. Phase: 54. Source: .planning/ROADMAP.md Phase 54 (defined 2026-10-22; not in .planning/7-SOTA-ENHANCEMENTS.md, which lists items 1–7 only)
  - Acceptance: each phase transition emits a GreptimeDB metric with a stdout fallback when GreptimeDB is disabled or unreachable; the session view reports exactly one of LOADING, EMPTY, STALE, DEGRADED, ERROR, SUCCESS; a documented inventory separates disk state from Railway-hosted state and lists host-bound paths and units; no cutover, DNS change or production deploy in scope.
  - Target files: packages/observability, docs, config-reference

## v1.6 contextual memory requirements

Source for all entries: the operator request of 2026-10-26 as planned by the Ultrathink graph ut-mvp59le0-8815e6d1, corrected against the repository (`.planning/phases/55-migration-safety/CONTEXT.md`). IDs continue the SOTA series.

- [ ] **SOTA-11**: Migration safety, session event vocabulary and the v1.6 baseline. Phase: 55. Source: .planning/ROADMAP.md Phase 55 (defined 2026-10-26)
  - Acceptance: an offline contract test rejects non-idempotent, destructive or edited-after-applied migration steps; a fake-connection harness proves lock-before-DDL, one transaction per step, rollback without a ledger row, zero DDL on re-run and partial resume; a rollback-compat test rejects non-additive or undocumented later steps; `session.checkpoint`, `session.rollback` and `session.rollback.refused` are note and warning events with validated payload builders and the vocabulary locks (EVENT_KINDS 12, SURFACES 42) stay green; an operator rehearsal runbook marks every production step operator-run.
  - Target files: packages/mcp-server/src/index-store.ts and tests, event-sources.ts, session-events.ts, docs/event-vocabulary.md, docs/runbooks
- [ ] **SOTA-12**: LightRAG client contract alignment and storage topology. Phase: 56. Source: .planning/ROADMAP.md Phase 56 (defined 2026-10-26)
  - Acceptance: the client cannot emit the clear-all route and deletes only by real document id; completion is read from the `busy` flag with explicit reasons for a fenced workspace and an unknown shape; the key is sent as `X-API-Key` only; track ids resolve to document ids and a 409 is a typed outcome; one `/query` client remains behind the breaker; a health probe fills `planes.lightrag.ok`; an upstream-derived route fixture with provenance and a contract test; the storage topology and upgrade design are written down; no live action.
  - Target files: packages/mcp-server/src/planes/lightrag.ts and tests, mcp.ts, server.ts, service.ts, docs/runbooks/lightrag-storage-topology.md
- [ ] **SOTA-13**: Tandem memory, LightRAG with Hindsight, with provenance and forget. Phase: 57. Source: .planning/ROADMAP.md Phase 57 (defined 2026-10-26)
  - Acceptance: retain metadata carries graph, session and node ids and recall exposes them with unchanged document ids; merged, deduplicated, cited LightRAG and Hindsight answers with the existing degraded fallback intact; a forget primitive that emits one ledger note per call and keeps the superseded index row; a cross-store consistency verifier reporting JSON drift with a non-zero exit code and no repair without a flag.
  - Target files: packages/mcp-server/src/memory-retain.ts, memory-recall.ts, memory-forget.ts, tandem-recall.ts, docs-search.ts, service.ts
- [ ] **SOTA-14**: Live session steering for multi-day GSD-Core sessions. Phase: 58. Source: .planning/ROADMAP.md Phase 58 (defined 2026-10-26)
  - Acceptance: durable directives that survive a restart and expire to an audited timeout; delivery to the target session within one scan interval and one shared state model for the two steering mechanisms; liveness that outlasts 25 hours of quiet; a STATE.md and ROADMAP.md position model; DragonflyDB limited to hints and ephemeral presence.
  - Target files: packages/mcp-server/src/planning/*, mcp.ts, event.ts, the TimescaleDB index schema (opt-in step), config-reference
- [ ] **SOTA-15**: Eternal logging, verifiable checkpoint and rollback events on Solana devnet. Phase: 59. Source: .planning/ROADMAP.md Phase 59 (defined 2026-10-26)
  - Acceptance: Merkle inclusion proofs for every tree size and index with tamper rejection; a checkpoint verification command reporting one of anchored, pending, unanchored, unverified or mismatch; mainnet and testnet RPC URLs refused at configuration load and at RPC construction; a signer set with validity windows and audited rotation; devnet reset detection apart from tampering with a re-anchor procedure; no transaction sent outside operator-run steps.
  - Target files: packages/ledger/src, packages/mcp-server/src/anchor.ts, service.ts, config.ts, packages/evidence, docs/runbooks
- [ ] **SOTA-16**: Eternal Memory Knowledge Nexus. Phase: 60. Source: .planning/ROADMAP.md Phase 60 (defined 2026-10-26)
  - Acceptance: governed memory records expose id, version, supersession chain, provenance and content hash and verify against an anchored root; deterministic capsules with a digest recorded as a ledger event and a content-addressed blob store (local and an S3-compatible adapter tested against a fake); redaction that keeps the hash and a tombstone; a decision record mapping Anda and KIP concepts with licenses noted.
  - Target files: packages/mcp-server/src (memory verification and capsule modules), docs/adr
- [ ] **SOTA-17**: Session rollback to an exact chat moment with file revert. Phase: 61. Source: .planning/ROADMAP.md Phase 61 (defined 2026-10-26)
  - Acceptance: tree-hash equality after snapshot, mutate and restore, with recovery after an interruption and never a partial end state; a dry-run, drift refusal and an always-taken safety snapshot; checkpoints at defined boundaries carrying an opaque transcript reference, git tree, manifest digest and chain head; an append-only rollback event with memory supersession and recall exclusion; per-surface transcript handling without rewriting any transcript; rollback from local checkpoints when the chain is unreachable.
  - Target files: packages/worktree-snapshot, packages/cli, packages/collectors, packages/mcp-server/src, docs/runbooks (a TimescaleDB opt-in schema step was listed here and was NOT built: checkpoints are ledger notes plus local pinned git refs)
- [ ] **SOTA-18**: Soak, runbooks and v1.6 close. Phase: 62. Source: .planning/ROADMAP.md Phase 62 (defined 2026-10-26)
  - Acceptance: a simulated multi-day run with bounded memory and handles and clean resume; runbooks for migration rehearsal, LightRAG hosting, chain outage and devnet reset, rollback and key rotation; decision records for store roles, rollback semantics and memo-only anchoring; STATE and ROADMAP reflect every phase and the milestone audit is written.
  - Target files: soak tests, docs/runbooks, docs/adr, .planning

## Out of scope and deferred

Defer (v2+), from `.planning/research/SUMMARY.md` line 70:

**Defer (v2+):** A-D2 herdr-hosted dispatch, A-D3 Orca tee, B-D2 Linear Agent Sessions, C-D3 extra launchers, D-D2 ingest on merge, G-D1 cua, H-D2 Codex/OpenCode/Pi VMs.

Anti-features, from `.planning/research/SUMMARY.md` line 72:

**Anti-features to hold:** substrate sending Done itself; `labelIds` overwrite; rolling back a lease on tracker failure; dispatcher claiming for the agent; issue text in prompts; RAGFlow MCP as backend; Hindsight as store of record; Dragonfly as queue/lock; recall inside the synchronous brief; event contents on chain; porting `chain.ts`; auto-merging skills; stopping production for UAT scenario 7; proof rows in the production ledger.

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| A-D1 | 37 | Complete (PR #89) |
| B-D1 | 38 | Complete (PR #90) |
| B-D3 | 38 | Complete (PR #90) |
| C-D2 | 39 | Complete (PR #91); signing needs `SUBSTRATE_HANDOFF_KEY` |
| C-D4 | 39 | Complete (PR #91) |
| D-D1 | 40 | In review (draft PR); no live effect until `SUBSTRATE_BRIEF_RECALL` and `HINDSIGHT_BANKS` are set |
| D-D3 | 40 | Blocked: restore drill and approval |
| D-D4 | 40 | In review (draft PR); narrowed to config-named models, see the phase 40 SUMMARY |
| E-D1 | 41 | Pending |
| E-D2 | 41 | Pending |
| F-D3 | 42 | Pending |
| F-D4 | 42 | Pending |
| H-D1 | 43 | Pending |
| H-D3 | 43 | Pending |
| I-D1 | 44 | Pending |
| SOTA-01 | 45 | Pending |
| SOTA-02 | 46 | Pending |
| SOTA-03 | 47 | Pending |
| SOTA-04 | 48 | Pending |
| SOTA-05 | 49 | Pending |
| SOTA-06 | 50 | Pending |
| SOTA-07 | 51 | Pending |
| SOTA-08 | 52 | Pending |
| SOTA-09 | 53 | Pending |
| SOTA-10 | 54 | Pending |
| SOTA-11 | 55 | Met in repo, not merged (gsd/v16-int e8dbe52): `index-store.migrate-contract.test.ts`, `index-store.migrate-harness.test.ts`, `rollback-compat.test.ts`, `session-events.test.ts`, `docs/runbooks/index-migration-rehearsal.md`; production rehearsal operator-run. `phases/55-migration-safety/VERIFICATION.md` |
| SOTA-12 | 56 | Met in repo, not merged (a573641): `planes/lightrag.test.ts` (clear-all denylist), `planes/lightrag.contract.test.ts` against `planes/__fixtures__/lightrag-v1.5.7-routes.json`; derived from upstream source, not a live server; deploy operator-gated. `phases/56-lightrag-contract/VERIFICATION.md` |
| SOTA-13 | 57 | Met in repo with fakes, not merged (77d18bc, 084eb69, a26841d, 2aaa19a): `memory-forget.test.ts`, `service-forget.test.ts`, `tandem-recall.test.ts`, `service-tandem-scope.test.ts`, `consistency-verify.test.ts`; the forget has no automatic expiry or operator trigger; Hindsight document-list route unverified. `phases/57-tandem-memory/VERIFICATION.md` |
| SOTA-14 | 58 | Partial, not merged (gsd/v16-58-live-steering 7edfd79, on the draft PR #110 stack): `planning/steering-durable.test.ts`, `steering-wiring.test.ts`, `planning/position.test.ts`; criterion 2's shared state model is not built. `phases/58-live-steering/VERIFICATION.md` |
| SOTA-15 | 59 | Partial, not merged (7b37ea6, 084eb69, a26841d, 2aaa19a, 824ceda): `ledger/src/merkle-proof.test.ts`, `checkpoint-verify.test.ts`, `signer-set.test.ts`, `devnet-reset.test.ts`, `reanchor-plan.test.ts`; the re-anchor send is not built; no live devnet proof (operator-gated). `phases/59-eternal-logging/VERIFICATION.md` |
| SOTA-16 | 60 | Met in repo with fakes, not merged (084eb69, a26841d, 979b5e2): `memory-record.test.ts`, `memory-verify.test.ts`, `capsule.test.ts`, `blob-store.test.ts`, `blob-store-s3.test.ts`, `cli/src/capsule.test.ts`, ADRs 0002 and 0003; bucket use operator-gated. `phases/60-eternal-nexus/VERIFICATION.md` |
| SOTA-17 | 61 | Partial, not merged (ff51cc7, a26841d, 99ec7e3, 824ceda, 979b5e2): `worktree-snapshot/src/*.test.ts`, `cli/src/session/rollback.test.ts`, `session-rollback.test.ts`, `session-rollback-e2e.test.ts`; automatic checkpoint triggers are not wired; no live rehearsal. `phases/61-session-rollback/VERIFICATION.md` |
| SOTA-18 | 62 | Written: `mcp-server/src/soak-multiday.test.ts` and `cli/src/session/soak.test.ts` (uncommitted when written), six runbooks, ADRs 0004-0007, `v1.6-MILESTONE-AUDIT.md`; milestone completion is an operator decision. `phases/62-soak-and-close/VERIFICATION.md` |

---
*Requirements defined: 2026-10-21*
