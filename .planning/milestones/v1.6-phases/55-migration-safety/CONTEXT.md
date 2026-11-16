---
phase: 55-migration-safety
milestone: v1.6
requirements: [SOTA-11]
discussed: 2026-10-26
status: discovery recorded; foundations in progress; live steps operator-gated
graph: ut-mvp59le0-8815e6d1
---

# 55-CONTEXT: Migration safety, session event vocabulary and the v1.6 baseline

## Scope

Phase 55 (ROADMAP.md, Phase 55 block) makes index migrations and ledger vocabulary changes contract-tested. This file is also the discovery record for the whole v1.6 milestone (phases 55 to 62).

The operator's request (2026-10-26): use LightRAG and Hindsight together with DragonflyDB, GreptimeDB and TimescaleDB; add migrations where the LightRAG change needs them; add live session steering for GSD-Core sessions that run for days (the USSR stack: Ultrathink, Substrate, Swarm, Realm); integrate Solana devnet for tamper-evident "eternal" logging and an Anda-inspired Eternal Memory Knowledge Nexus; and add session rollback to an exact chat moment with file revert.

## Method and labels

- The Ultrathink graph ut-mvp59le0-8815e6d1 was planned without repository access, so every repository fact in it was an assumption. Ten read-only scouts then read this tree (main 9aec7a11c) and the unmerged steering drafts. The orchestrator also read both Railway projects through the Railway API (read-only, no variable values), upstream LightRAG v1.5.7 source, and the Anda DB, KIP and Solana documentation.
- **verified**: read in this repository, in upstream source or in Railway. **inference**: derived from verified facts. **unverified**: not checked; it stays an open item.

## Corrections to the plan's assumptions

| # | The plan assumed | Evidence | Consequence |
|---|---|---|---|
| 1 | GreptimeDB is a derived telemetry sink. | It is the append-only authoritative event ledger: `agent_events` with a `hash`/`prev` chain, `anchors`, `event_ingest` (`packages/mcp-server/src/greptime.ts:876-930`); the guard `assertAppendOnly` denies everything except select, insert and create (`docs/greptime-ledger.md`). | Checkpoint and rollback truth is a ledger event. Nothing is ever rewritten. |
| 2 | TimescaleDB is the system of record for events, checkpoints and the outbox. | It is a plain-Postgres coordination index with no hypertable, continuous aggregate or policy (`docs/data-planes.md:25`, "0 hypertables measured 2026-10-13"). Events live in GreptimeDB, so no transaction spans an event and a Postgres row. | New Timescale tables are queryable indexes only. A hypertable needs an operator-approved rehearsal. |
| 3 | DragonflyDB holds the live steering queue. | Cache only, by owner decision of 2026-09-26 (`.planning/PROJECT.md:90-92`; `cache.ts:1-34`; `cache-conformance.test.ts` locks the command set and the eight cache classes). It forbids queues, locks, sessions and anything that must survive a restart. | The durable steering record is TimescaleDB plus the ledger. Dragonfly carries wake-up hints and ephemeral presence only. LightRAG KV and doc-status must not live there. |
| 4 | LightRAG was upgraded from a previous version. | No LightRAG service exists in either Railway project, and the RAGFlow service was deleted on 2026-10-25. `.env.example` plans `ghcr.io/hkuds/lightrag:latest` ("same Railway project"; the project name is not stated there) and `LIGHTRAG_URL` is unset. | There is no previous version. The work is aligning the client to upstream v1.5.x and deciding the topology. The deploy is Phase 46 T6, an operator step. |
| 5 | A migration tool (alembic, sqlx) is missing per store. | An in-repo engine exists: `MIGRATION_STEPS` (`index-store.ts:309`, versions 1 to 32), ledger table `schema_migrations`, a session advisory lock, one transaction per step (`index-store.ts:608-660`). GreptimeDB has no ALTER path except one TTL statement. Dragonfly keys are already versioned (`substrate:v1:`). | Extend the engine with contract tests. No new tool. No Greptime or Dragonfly migration is needed for the features in this milestone. |
| 6 | An outbox row commits in the same transaction as the event. | Events are in GreptimeDB, rows in Postgres. The hourly anchor job already reads closed hours from the ledger, is idempotent (adopt-before-send, `anchor.ts` header) and never blocks a write. | No outbox. Anchoring is non-blocking by construction. |
| 7 | Memo commitments per batch, sealed at checkpoints. | Memo v1 is fixed: `substrate:v1:<hour>:<root>:<count>` (`packages/ledger/src/memo.ts:9`); readers reject anything else (`memo.test.ts:44-46`). | A checkpoint is anchored indirectly: its event sits inside the hour's root. Add inclusion proofs. Memo v2 stays a separate operator decision and is not taken. |
| 8 | A new `nexus_record` table. | `memory_entries` already has version, `superseded_by`, conflict key, actor, session, graph and governance columns (index steps 10, 11, 27). | The Nexus is a verified projection and capsule export over existing records. |
| 9 | The steering inbox is new work. | It exists as unmerged drafts #104, #109, #110, #111 (phases 52 to 54). On main there are two disjoint in-memory mechanisms: the RAG state machine (`mcp.ts`, SPE-19388) and `docs_steering_session` (SPE-19390, `event.ts:339-420`). | Build on the drafts and join the two mechanisms. |
| 10 | The substrate reverts the worktree. | Decision D52-g: the substrate stays read-only on session worktrees. A Swarm lane's guard blocks `git checkout` and `git restore` inside the lane (`agent-swarm` `omp/src/guard.ts`). | The restore is a CLI that runs under the session's or operator's authority. The server plans, verifies and audits. |

## Decisions

- **D55-1 (plan q1) rollback marks memory superseded; nothing is hard-deleted.** Evidence: the ledger is append-only and `substrate verify` recomputes its hash chain; the memory index already supersedes by version. The ledger records a rollback as a new event pointing at an earlier one. Hindsight documents and LightRAG-derived entries written after the checkpoint are forgotten or superseded by entry id. Reversibility: high. Confidence: high.
- **D55-2 (plan q2) memo-only anchoring behind the existing job; no custom Solana program and no memo v2.** Evidence: item 7 above and `.planning/uplift-7/SOLANA-FEASIBILITY.md`. A per-checkpoint memo is a separate operator decision.
- **D55-3 (plan q3) rollback is a CLI plus MCP and REST twins that plan, verify and audit.** A session that predates the feature gets a `baseline` checkpoint at its first checkpoint-aware turn and cannot be rolled back before it.
- **D55-4 (plan q4) edits stay in this repository.** `.planning/STATE.md` (v1.3 run rules) says every live run, including "GitHub PRs on other repos", waits for operator approval. Hooks the sibling plugins need are written as documented proposals in this repository and are not applied there.
- **D55-5 store roles.** Greptime: authoritative event ledger and anchors. TimescaleDB: coordination index (graph, memory, skills registry, desk tables). DragonflyDB: rebuildable cache and hints. Hindsight: derived memory, never the store of record. LightRAG: derived docs index, rebuilt from the docs in git.
- **D55-6 devnet is evidence, not storage.** Solana documents that devnet may be reset and publishes no retention window for its public RPC; `getSignaturesForAddress` returns at most 1,000 signatures per call and public nodes prune old history. The durable proof is the ledger row, its inclusion proof and the `anchors` row; the chain is an external witness whose lookup can fail. A failed lookup is reported as `unverified`, never as tampering.
- **D55-7 Anda is a concept reference only.** `ldclabs/anda-db` v0.14.0 (reported MIT; verify the LICENSE file before adapting anything), KIP 2.0 (license unverified). No code is copied and the project does not move to ICP.
- **D55-8 branches.** One PR per phase, each cut from main. Phases 58 and 61 stack on the draft PR branches and wait for the merge decision.

## Verified facts by area

- **LightRAG client.** `planes/lightrag.ts` calls `POST /query`, `/documents/upload` (fallback `/documents/text` on a 404), `/documents/scan`, `GET /documents/pipeline_status` and `DELETE /documents` with a `doc_ids` body. A second private `/query` client lives in `mcp.ts:520-578`, bypassing the breaker and gated fetch. No health call exists (`service.ts:~6180`). Upstream v1.5.7 differs; see the findings.
- **TimescaleDB index.** Steps 1 to 32, no `down` path, retention is application-level (`index-sweep.ts`, `index-archive-spec.ts` `ARCHIVE_TABLES`). `docs/runbooks/rollback-compat.md` row for the index is prose, not a test. Production has no migration ledger before the first `migrate()`; the first run replays every idempotent step (playbook in `docs/runbooks/index-migration-rehearsal.md`).
- **GreptimeDB.** `agent_events` (append mode), `event_ingest`, `anchors` (11 columns, no ALTER), `substrate_health`, `metric_samples`. A new event concept needs an `EventSource` row, a docs row and a `payload.action`; EVENT_KINDS (12) and SURFACES (42) are locked by `bun run check:phase-close`. Idempotency keys work only under `SUBSTRATE_EVENT_IDEMPOTENCY=accept|enforce` (default off). Event payloads are capped at 16,000 bytes and carry no content.
- **DragonflyDB.** Cache classes `brief`, `memory-search`, `graph-view`, `brief-snapshot`, `recall-snapshot`, `docs-search`, the admission budget and generation counters; one pub/sub channel `substrate:v1:events` carrying six-field hints. Nothing durable.
- **Hindsight 0.9.1.** Retain only through `memory_write`; banks `sub-<surface>`; retain metadata lacks graph, session and node ids; `deleteDocument` and `patchDocumentTags` have no non-test caller; there is no forget or rollback semantic.
- **Steering.** Main has two in-memory steering mechanisms. The drafts add a planning index, presence (TTL 90 s in Dragonfly), a steering inbox with audit-before-effect (opt-in migration 33), conflict events and plan-step checkpoints keyed by file hash. Steering is pull-only, the directive store is in memory, a "checkpoint" has no chat position, tree or event id.
- **Solana.** Hourly job: Merkle root of closed-hour event hashes, devnet memo through the `solana` CLI, `anchors` row, `substrate verify` and the evidence bundle. The key holds 0 SOL, the timer is not installed, and the live proof is operator-gated (Phase 41, accepted debt).
- **Sessions and worktrees.** omp stores a JSONL tree (`id`, `parentId`, a leaf pointer) with `/branch`, `/tree` and `/fork`; no collector records a transcript turn id; per-Graph-ID worktrees are created by the dispatcher (`worktree.py:101-147`).
- **USSR siblings.** Realm (`agent-realm`) already anchors an audit-log Merkle root to devnet (`src/audit/anchor.ts`) and does not call Substrate; Swarm calls Substrate over REST and MCP with leases; Ultrathink calls `/brief` and `/events` and fails open. None uses Dragonfly, Greptime, Timescale or LightRAG.
- **Infrastructure (Railway, read-only, 2026-10-26).** Agent Substrate: Hindsight 0.9.1 (api, worker, control plane), TEI cpu-1.8, a Postgres 18 service, a Tailscale forwarder, two OAuth function services. Ultrathink: TimescaleDB `pg16-ts2.13` (PostGIS image, 500 MB volume), GreptimeDB v1.1.4 (500 MB), Dragonfly (`latest`, 5000 MB), a `ledger-archive` bucket. Whether the Timescale image has pgvector is unverified.

## Quality findings (severity ranked)

| Sev | Finding | Where | Phase |
|---|---|---|---|
| P0 | `deleteDocuments` sends `DELETE /documents`, which upstream implements as "clear all documents"; it takes no body, so a prune would wipe the index. Fixed by routing to `DELETE /documents/delete_document` and denylisting the clear-all route. | `planes/lightrag.ts:652-673`; upstream `document_routes.py:5749-5784` | 56 |
| P1 | `pollParseStatus` reads a `status` string; upstream returns `busy: boolean`, so every poll looks busy and ingest times out. | `planes/lightrag.ts:621-640`; upstream `:1384-1427` | 56 |
| P1 | The client sends `x-api-key` and `Authorization: Bearer <key>`; upstream validates any bearer as a JWT first and returns 401. | `planes/lightrag.ts`; upstream `utils_api.py:427-468` | 56 |
| P1 | The upload `track_id` is treated as a document id; upstream document ids come from `track_status`. A same-name upload is a 409. | `planes/lightrag.ts`, `docs-ingest.ts:1546-1549`; upstream `:926-952`, `:1155-1196` | 56 |
| P2 | Two `/query` clients; the private copy skips the breaker. No health probe, so `planes.lightrag.ok` is always null. | `mcp.ts:520-578`, `service.ts:~6180` | 56 |
| P2 | The index rollback-compat invariant is prose with no test; no check that `ARCHIVE_TABLES` covers every created table; migrations have no `down` convention; applied step text is not frozen. | `docs/runbooks/rollback-compat.md:39` | 55 |
| P2 | Hindsight retain metadata cannot be joined to a graph, session or ledger event. | `memory-retain.ts:206-215` | 57 |
| P2 | Steering is pull-only; the directive store is in memory; presence is built for minute-scale freshness; two steering mechanisms have no join. | `mcp.ts:486-502`; draft `steering.ts:171` | 58 |
| P3 | `planning_sessions` returns absolute worktree paths to any MCP caller; rollback metadata must use opaque ids. | drafts | 55, 61 |
| P3 | The LightRAG image is planned as `latest`, unpinned. | `.env.example` | 56 |

## Held and HARD_STOP (the milestone's code never performs these)

LightRAG deploy, ingest, cutover and RAGFlow removal (Phase 46 T5 to T8, waves W1 to W5); any new Railway service or cost; production index migrations (rehearsal runbook only); funding the anchor key, installing `substrate-anchor.timer` and any devnet send; any mainnet or testnet use; merging to main (the drafts #104, #109 to #111 and every v1.6 PR); completing or archiving a milestone; PRs on other repositories.

## Operator decisions requested (none blocks Phases 55 to 57, 59 or the snapshot library)

1. Merge order for the draft stack (Phases 58 and 61 wait for it).
2. LightRAG hosting: a dedicated pgvector Postgres service (a cost) or reuse of the existing Postgres service, and the LLM route (key or bridge `/chat` contract).
3. Whether a per-checkpoint memo v2 is wanted (not taken here).
4. A TimescaleDB hypertable policy (none is created without an approved rehearsal).
5. "Eternal": devnet cannot be it. Keep the chain as evidence plus the ledger archive as the durable copy, or plan a mainnet move later (out of scope today).

## Milestone map

| Phase | Units (from the scout reports) | Depends on |
|---|---|---|
| 55 | Migration contract tests and fake-connection harness; `down` convention; rollback-compat pin; session event vocabulary; rehearsal runbook | 17, 26 |
| 56 | Client defects D1 to D6, route fixture and contract test; topology and preflight docs | 46 |
| 57 | Retain join keys; forget primitive; tandem recall merge; consistency verifier; scoped brief recall | 56, 49 |
| 58 | Durable steering store; delivery; liveness lease; position model | 52 to 54 drafts, 57 |
| 59 | Merkle proofs and URL guard; checkpoint verify; signer set; reset detection; operator runbook | 55, 41 |
| 60 | Record verify; capsule export; blob store; Anda mapping decision record | 57, 59 |
| 61 | Snapshot library; transcript references; rollback planner and CLI; memory supersession | 55, 57 to 59, drafts |
| 62 | Soak; runbooks; audit | 55 to 61 |
