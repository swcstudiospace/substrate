# ADR 0004: Store roles: what each store is the record of, and what it is never allowed to hold

- **Status:** Accepted (records decisions already in force in the code and in `docs/data-planes.md`, and the v1.6 corrections to the milestone plan)
- **Date:** 2026-10-26
- **Tickets:** v1.6 phase 62, success criterion 2 (decision records for store roles)
- **Deciders:** Spectrum Web Co platform; Dragonfly's role is the owner decision of 2026-09-26
- **Affects:** `packages/mcp-server/src/{index-store,greptime,cache,event-bus,memory-forget,memory-forget-plane}.ts`, `packages/mcp-server/src/planes/{hindsight,lightrag}.ts`, `packages/ledger/src`
- **Supersedes:** nothing. It restates `docs/data-planes.md` for the stores v1.6 touches; where the two disagree the contradiction list at the end says so.

## Context

The v1.6 plan (written without repository access) treated the stores by their product names: GreptimeDB as a telemetry sink, TimescaleDB as the system of record for events and checkpoints, DragonflyDB as the home of a live steering queue, LightRAG as an upgrade of something that already ran. Ten read-only scouts then read the tree and corrected those assumptions (`.planning/phases/55-migration-safety/CONTEXT.md`, "Corrections to the plan's assumptions", items 1 to 6). Without a written role per store, the next feature will put a queue in the cache again or a checkpoint in the wrong database.

Constraints that bind every decision below: `EVENT_KINDS` has 12 entries and `SURFACES` 42 (`bun run check:phase-close`); SQL is composed only in `packages/mcp-server/src/greptime.ts` and `brief.ts` and the stores are reached only through `substrate-mcp` (`packages/mcp-server/src/store-lock.test.ts`); Solana is devnet only and carries roots, never event contents.

## Decision

One decision per store. "Evidence" names files that exist in this tree.

### 1. TimescaleDB: a plain-Postgres coordination index

- **Decision.** TimescaleDB holds the **coordination index**: graph tables (`graph_index`, `graph_nodes` with the lease columns, `graph_edges`, `graph_steps`, `graph_bindings`), governance tables (`memory_entries`, `memory_writes`, `memory_reviews`, `memory_quarantine`) and the skills registry. It is plain Postgres: **no hypertable, continuous aggregate or Timescale policy** (0 hypertables measured 2026-10-13, `docs/data-planes.md`, the Index row). Only `substrate-mcp` writes it. A new table is a queryable index over something authoritative elsewhere, never the authority. A hypertable needs an operator-approved rehearsal (`docs/runbooks/index-migration-rehearsal.md`) and none is created by this milestone.
- **Why migrations are contract-tested.** Production has no migration ledger before the first `migrate()`, the boot steps have no automatic `down`, and a step stamps its version only after its statement commits. A silent change to an applied step, a non-idempotent statement or a destructive one is a production incident that no test would otherwise see. `index-store.migrate-contract.test.ts` therefore fails any step that (a) is not idempotent, (b) drops, renames, retypes, truncates or deletes, (c) differs from its pinned digest (`index-store.migrations.digests.json`), (d) creates a table that is neither in `ARCHIVE_TABLES` nor allowlisted with a reason, or (e) from `FIRST_REVERSIBLE_VERSION` (33) on lacks `down` and `phase` (`expand` or `contract`). `index-store.migrate-harness.test.ts` proves, with a fake connection, the advisory lock before DDL, one transaction per step, no ledger row on rollback, zero DDL on a re-run and resume from a partial ledger. Steps 1 to 32 are frozen as they are.
- **Opt-in steering audit table.** Phase 58 (live steering) adds an **opt-in** index step for the durable directive and audit record. It lives on a branch stacked on the held draft pull requests and is **not on this branch**; its contents were not read for this record (UNVERIFIED). **Migration step 33 is reserved by that unmerged draft**: nothing in v1.6 adds an index step, table or column, so there is no number clash to resolve until the stack merges (the ROADMAP's phase 61 entry lists "TimescaleDB index schema (new opt-in step)"; as built it needs none, see the contradiction list).
- **Consequences.** No transaction spans a ledger event and a Postgres row, because they are different databases; any feature needing both must be idempotent and tolerate either side lagging. Retention is application-level (`index-sweep.ts`, dry-run unless `SUBSTRATE_INDEX_SWEEP=apply`); a forgotten memory row is exempt from the 90-day superseded-version deletion (`index-sweep.ts`, the comment on `forgotten:`), because it is the audit record of what was forgotten.
- **Evidence.** `packages/mcp-server/src/index-store.ts`, `index-store.migrate-contract.test.ts`, `index-store.migrate-harness.test.ts`, `index-store.migrations.digests.json`, `docs/runbooks/index-migration-rehearsal.md`, `docs/runbooks/rollback-compat.md`, `docs/data-planes.md`.

### 2. GreptimeDB: the authoritative append-only event ledger

- **Decision.** GreptimeDB is **not a derived sink**. It is the system of record for what agents did: `agent_events` (append mode, per-session `hash`/`prev` chain), `event_ingest`, and `anchors` (the hourly roots and their devnet signatures). The client's append-only guard allows select, insert and create only (`docs/greptime-ledger.md`); there is no ALTER path except one TTL statement, and `migrate()` warns on a shape mismatch instead of altering (`greptime.ts`). Nothing is rewritten: a correction, a rollback or a forget is a **new event** pointing at an earlier one.
- **What it holds and does not.** Ids, counts, digests and short summaries; payloads are redacted, strings capped, the whole payload capped at 16,000 bytes, and checkpoint, rollback, forget and capsule notes carry no file, transcript or memory content (`docs/event-vocabulary.md`).
- **Consequences.** A feature's durable truth is a ledger note (`session.checkpoint`, `session.rollback`, `session.rollback.refused`, `memory.forget`, `memory.capsule.export`, `memory.capsule.redact`, `anchor.signer.rotate`, `anchor.reanchor`), all existing kinds `note` or `warning` with `payload.action`. Idempotency keys are honoured only under `SUBSTRATE_EVENT_IDEMPOTENCY=accept|enforce`; the default `off` ignores them, so a replayed event can duplicate unless the caller deduplicates (`docs/event-vocabulary.md`, "Idempotent replay"). The ledger has a 180-day hot retention when `SUBSTRATE_LEDGER_TTL` is set, after an export step; the `anchors` rows and the archives are the only durable copies of the roots (`docs/runbooks/devnet-reset-and-reanchor.md`). Nothing outside `greptime.ts` and `brief.ts` may compose its SQL.
- **Evidence.** `packages/mcp-server/src/greptime.ts`, `packages/mcp-server/src/store-lock.test.ts`, `docs/greptime-ledger.md`, `docs/event-vocabulary.md`, `packages/mcp-server/src/event-sources.ts`.

### 3. DragonflyDB: cache only

- **Decision.** The owner decided on 2026-09-26 that Dragonfly is a **cache, not a queue** (`docs/data-planes.md`, `.planning/PROJECT.md`). `packages/mcp-server/src/cache.ts` says it in its header: a restart drops every key, and a missing URL, `SUBSTRATE_CACHE=0`, a refused connection or a bad value all return what the caller would have got with no cache. The key classes are a closed list, `CACHE_CLASSES` = `brief`, `memory-search`, `graph-view`, `brief-snapshot`, `recall-snapshot`, `docs-search`, `emb`, `budget`, `gen`, and the command set is `get`, `mget`, `set`, `incr`, `eval`; `cache-conformance.test.ts` fails the build on any change.
- **Generation keys.** Visibility after a write is by **generation counters**, not by scanning and deleting: `gen:memory`, `gen:recall`, `gen:graphs`, `gen:graph:<graph id>`, `gen:docs` under the prefix `substrate:v1`. A write or retain bumps a counter and every key built with the old one becomes unreachable. A forget bumps the recall and memory generations when it changes anything, so a forgotten entry stops being served from a warm cache at once (`service.ts` `memoryForget`, commit message of `824ceda`). Rate buckets (`budget:<surface>:<class>`) always carry a TTL.
- **What is never stored there.** Queues, locks, sessions, steering directives, checkpoints, capsules, worktree snapshots, an idempotency mirror, LightRAG key-value or document-status state, and anything that must survive a restart. The one pub/sub use, wake-up hints on `substrate:v1:events`, lives in `event-bus.ts` precisely so `cache.ts`'s command set stays closed; a hint has six fields and no text, is never the event, and the ledger is read when one arrives (`SUBSTRATE_EVENT_BUS`, default off). Phase 58's criterion 5 keeps that rule: the durable steering authority is Postgres and the ledger.
- **Deployment fact.** The Dragonfly service in the hosting layer is idle; production points at a co-located loopback Redis after a measured 180 to 310 ms round trip made the hosted hop unusable (`docs/data-planes.md`, "Current wiring"). Keep, repurpose or decommission is an operator decision this repository does not make.
- **Consequences.** Every cache read is allowed to miss. A feature that cannot tolerate a missing key does not belong here.
- **Evidence.** `packages/mcp-server/src/cache.ts`, `cache-conformance.test.ts`, `event-bus.ts`, `docs/data-planes.md`, `docs/runbooks/lightrag-storage-topology.md` ("Dragonfly kept cache-only").

### 4. Hindsight: derived memory

- **Decision.** Hindsight (banks `sub-<surface>`) is **derived**. The record of governed memory is the index row in `memory_entries`; `memory_write` accepts into the index and forwards gate-accepted entries to the writer's bank (`docs/data-planes.md`, "Hindsight banks"). A document in Hindsight can be rebuilt from the index row: `consistency-run.ts --repair` re-retains a missing document (`docs/runbooks/consistency-verify.md`). Whether a rebuilt document yields identical extracted facts is UNVERIFIED.
- **Forget deletes documents, never the index row.** `memory-forget.ts` marks the row `superseded_by = 'forgotten:<forget_id>'` (the brief and `memory_search` stop serving it at once), then deletes the plane document by its derived id (`memory-forget-plane.ts`), appends one `memory.forget` note, and bumps the cache generations. A plane failure never undoes the mark and is retried by repeating the same request. The row stays for audit and is exempt from the sweep.
- **Join keys.** A retain carries `graph_id`, `session_id` and `node_id` in its metadata when known, so recall can be scoped to a graph (`SUBSTRATE_BRIEF_RECALL_SCOPE`, default `off`, needs `SUBSTRATE_BRIEF_RECALL=enforce`); document ids are unchanged.
- **Consequences.** Hindsight is never the store of a claim. Its own Postgres is private to it. The Hindsight document-listing route that the verifier uses is unverified against 0.9.1 (commit `2aaa19a`); a failed listing makes the verifier report an unreadable store (exit 3), never `ok`.
- **Evidence.** `packages/mcp-server/src/{memory-forget,memory-forget-plane,memory-write,memory-recall,consistency-verify,consistency-run}.ts`, `packages/mcp-server/src/planes/hindsight.ts`, `docs/memory-governance.md`, `docs/event-vocabulary.md` ("Memory forget events").

### 5. LightRAG: the docs knowledge graph, on Postgres-only storage

- **Decision.** LightRAG is the **derived documents and planning-graph index**, rebuilt from the docs in git; it replaces RAGFlow (deleted 2026-10-25 per the orchestrator's read of the hosting layer recorded in `docs/runbooks/lightrag-storage-topology.md`). There was no previous LightRAG to upgrade: the work was aligning the client to upstream v1.5.x and deciding the topology. Alignment is done: the client never sends upstream's clear-all `DELETE /documents` (a denylist in `planes/lightrag.ts`, `isClearAllRequest`), removes documents only through `DELETE /documents/delete_document` with real ids, reads completion from the upstream `busy` flag, and is held to a route fixture derived from upstream v1.5.7 (`planes/__fixtures__/lightrag-v1.5.7-routes.json`, `planes/lightrag.contract.test.ts`).
- **Recommended topology.** A **dedicated Postgres service with pgvector** and the four `PG*` storage classes (`PGKVStorage`, `PGDocStatusStorage`, `PGVectorStorage`, `PGTableGraphStorage`), workspace isolation and a pinned image; not Dragonfly, and not the file-based default, which is lost on a redeploy. These are settings of the LightRAG server, not of `substrate-mcp`. The recommendation is **cost-gated and an operator decision**: a new Postgres service needs cost approval (HARD_STOP, `docs/runbooks/lightrag-storage-topology.md`), and deploy, ingest and cutover stay in phase 46 (T5 to T8). Nothing is deployed by this milestone.
- **Tandem with Hindsight.** With `SUBSTRATE_DOCS_TANDEM=on` (default `off`) a `docs_search` answer from LightRAG also carries the caller's Hindsight memory as derived, never-cached items, merged by reciprocal-rank fusion with provenance and de-duplication, fail-open (`tandem-recall.ts`, `docs/docs-search-ingest.md`). With LightRAG down the existing degraded fallback is unchanged.
- **Consequences.** Losing LightRAG loses an index, not a record. Re-ingest rebuilds it.
- **Evidence.** `packages/mcp-server/src/planes/lightrag.ts`, `lightrag.contract.test.ts`, `packages/mcp-server/src/{docs-search,tandem-recall}.ts`, `docs/runbooks/lightrag-storage-topology.md`, `docs/docs-search-ingest.md`.

### 6. Solana devnet: evidence of hourly Merkle roots only

- **Decision.** The chain carries one memo per closed hour, `substrate:v1:<hour>:<root>:<count>`, signed by the anchor key and read back by the verifier. It holds no event, no memory text, no capsule and no per-checkpoint digest. It is evidence, not storage. The reasoning, the verification model and the live-step gates are in ADR 0006; the durable copy of every root is the ledger's `anchors` table.
- **Evidence.** `packages/ledger/src/memo.ts`, `packages/mcp-server/src/anchor.ts`, `docs/adr/0006-memo-only-anchoring.md`.

## Cross-cutting rules these decisions give

- **The worktree is in no store.** Session checkpoints are pinned git refs local to the worktree plus ledger notes (ADR 0005); nothing in Dragonfly, Postgres or Hindsight holds file content.
- **Idempotent writes and fail-open reads.** Reads fall through to the next source or to an empty answer. Only ledger and index writes may fail closed, and only for the caller that asked for durability (`docs/data-planes.md`, "Fail-open budget").
- **No store reaches another's data directly.** Greptime and Postgres are reached only through `substrate-mcp`; sibling repositories (Ultrathink, Swarm, Realm) see them only as REST and MCP (`docs/ussr-integration.md`).

## Contradictions found while writing this record

- `.planning/PROJECT.md` (the Data section) lists hypertables among the Programming Desk tables in TimescaleDB; `docs/data-planes.md` says the index has none (0 measured) and that the desk's own tables are not in this repository. This ADR follows `docs/data-planes.md`.
- `docs/data-planes.md` still describes LightRAG as "hosted same Railway project" and keeps a RAGFlow dataset section, while `docs/runbooks/lightrag-storage-topology.md` records that no LightRAG service exists and RAGFlow was deleted on 2026-10-25.
- `.planning/ROADMAP.md` phase 61 lists a "TimescaleDB index schema (new opt-in step)"; no index step was added (rollback uses ledger notes and local refs).

## References

- ADR 0003 (memory nexus), ADR 0005 (rollback semantics), ADR 0006 (memo-only anchoring)
- `.planning/phases/55-migration-safety/CONTEXT.md`, decision D55-5 (store roles)
