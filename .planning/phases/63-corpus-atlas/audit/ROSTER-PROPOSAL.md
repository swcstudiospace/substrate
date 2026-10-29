# Run 14 roster proposal

The eight features of milestone v1.7 and how they map onto the planner's candidate roster. Phase text is in [ROADMAP.md](../../../ROADMAP.md); evidence in [AUDIT-REPORT.md](AUDIT-REPORT.md); status per item in [CAPABILITY-MATRIX.md](CAPABILITY-MATRIX.md); risks in [RISK-REGISTER.md](RISK-REGISTER.md).

## The eight features

Flag defaults are those the phase files state. A blank "not stated" means the roadmap names the flag and leaves the default to the unit; every feature ships off or as a dry run, and the operator turns it on.

| Phase | Feature | Resources used and why | Flag | Default | Rollback |
|---|---|---|---|---|---|
| 63 | Corpus Atlas: scan, classify, de-duplicate, plan, bulk ingest, tombstone | LightRAG docs plane (the retrieval store); the Postgres index store holds the `corpus_documents` manifest (a durable key `(repo, path)`, which the JSON state file and in-memory hashes cannot give); the ledger records outcomes as notes | `SUBSTRATE_CORPUS_ROOTS`, `SUBSTRATE_CORPUS_CONCURRENCY` 4, `SUBSTRATE_CORPUS_BATCH_DOCS` 20, `SUBSTRATE_CORPUS_BATCH_BYTES` 1000000 | `ingest` is a dry run until `--execute`; roots unset | Stop running the command; the new table is additive and unused by the previous release; documents already in the plane are removed by a tombstone plan, not by hand |
| 64 | Embedding fabric: TEI client, cache, fabric row, near-duplicates | TEI (the owner named it; Substrate has no client) to embed excerpts; Dragonfly as the cache for vectors under class `emb` (rebuildable, TTL on every key) | `TEI_URL`, `SUBSTRATE_TEI_MODEL`, `SUBSTRATE_TEI_DIM`, `SUBSTRATE_EMBED_CACHE` | not stated; no TEI URL means no TEI calls | Unset `TEI_URL` or the cache flag; the cache is rebuildable; near-duplicates are only reported |
| 65 | Doc Watch: hooks, watcher, reconcile timer, `corpus sync` | Postgres manifest as restart-safe state; ledger notes `docs.sync`; git for the fetched tree; the staged systemd units | existing `SUBSTRATE_DOCS_FRESHNESS_*`; staged units | units staged, not installed | Do not install, or disable, the units; hooks never overwrite a foreign hook and always exit 0 |
| 66 | Docs Reflect: telemetry, feedback, authority re-rank, digests, gaps | Postgres `corpus_retrievals` for telemetry (bounded, with retention); Hindsight `retain` with `document_id` replace for digests, through the memory governance gate; LightRAG gets one digest document per repository | `SUBSTRATE_DOCS_TELEMETRY`, `SUBSTRATE_DOCS_RERANK` | telemetry off; re-rank `off` (then `shadow`, then `on`) | Set both flags off; the table stays unused; digests are retained with replace and removable through the governed forget path |
| 67 | Live Steering GA: `steer` CLI, REST routes, `session_context`, brief sections, durable session registry, hook reader, long-poll | Postgres `steering_sessions` (opt-in, following the audit-table precedent); existing Dragonfly presence; ledger; no new Dragonfly role | `SUBSTRATE_STEERING_SESSIONS_TABLE`, `SUBSTRATE_BRIEF_SESSIONS`, existing `SUBSTRATE_PLANNING_STEERING` and `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` | opt-in; not stated for the new two | Turn the flags off; session state falls back to process memory; no hook is installed by the code |
| 68 | Worktree Fleet: registry, prune, conflict forecast, provision, disk floor | Postgres `worktrees` registry (a report posted by the CLI and collectors; the server never touches worktrees); git for discovery and `merge-tree`; the ledger records one note per removal | `SUBSTRATE_WORKTREE_ROOTS`, `SUBSTRATE_WORKTREE_MIN_FREE_GB` | not stated; prune is a dry run until `--execute` | Stop using the commands; a removal is the only irreversible step and is limited to `safe` worktrees, never `--force` |
| 69 | Doc Proofs: corpus Merkle root, proofs, verify | Greptime ledger (one `docs.corpus.root` note per sync) and the existing hourly anchor on Solana devnet, which covers the hour's event hashes | none new; existing anchor gates | no transaction is sent by the code; anchor timer operator-gated | Stop emitting the note; no memo format changes, so nothing on chain needs undoing |
| 70 | Docs SLO and eval: golden set, offline harness, series, docs lint, runbook | Greptime `metric_samples` for series (needs `SUBSTRATE_METRICS_HISTORY=on`); the staged canary timer; `bun test` for the offline harness and the lint | SLO threshold flags (names set by the unit) | history off; canary timer staged | Remove the staged canary run; the lint and harness are tests and carry no runtime state |

## Mapping to the planner's candidate roster

| Planner candidate | v1.7 phase | Fit |
|---|---|---|
| Ingestion | 63 | Direct: the owner's own capability (ingest every repository's documentation) |
| Change-triggered sync | 65 | Direct: the owner's own capability |
| Self-improving loop | 66 | Direct: the owner's own capability (the owner pointed at Hindsight as the model) |
| Live Steering | 67 | Direct: the owner's own capability; phase 58 already built part of it |
| Worktrees | 68 | Direct: the owner's own capability |
| Observability | 70 | Merged with the evaluation gate |
| Evaluation gate | 70 | Merged with observability: one set of series, one golden set, one runbook |
| Provenance anchoring | 69 | Contrived (see below); rides the existing hourly anchor, no new memo format |
| none | 64 | Added: the owner named TEI and Substrate has no client; the first consumer is near-duplicate detection |

Features 1 to 5 (phases 63, 65, 66, 67, 68) are the owner's own capabilities. Reserves R9 drift detection, R10 session handoff packs and R11 conventions registry have no phase of their own. Phase 67 reads handoffs into the brief; the rest stay in reserve.

## Resource roles

| Resource | Role in this milestone | Rule |
|---|---|---|
| Postgres index store ("TimescaleDB" in the owner's request; plain Postgres, zero hypertables) | System of record for the manifest, retrievals, steering sessions and worktrees | Every table additive and idempotent with a `down` text; opt-in tables use the `optIn` mechanism |
| GreptimeDB | System of record for the ledger and metric series | Append-only; only select, insert, create and show; corpus facts enter as notes mapped onto existing event kinds |
| Solana devnet | Timestamp witness of the hourly root; not a store | Optional: its absence yields `unanchored`, never a failure of ingest or search |
| DragonflyDB | Cache only, for rebuildable state: embedding vectors, docs-search answers, admission buckets, presence | Holds only rebuildable state: no queues, no locks, no sessions; every non-counter key has a TTL; a 256 MB `volatile-lru` instance may evict at any time, so losing it costs latency only |
| TEI | Stateless embedding service | Pinned model and dimension; endpoint loopback or an allowed proxy; a mismatch is refused |
| LightRAG | Derived retrieval plane in naive mode | Rebuildable from the manifest and the sources; one workspace; no extraction LLM |
| Hindsight | Derived memory for digests, pinned 0.9.1 | Writes go only through the memory governance gate |

## Contrived mappings

Weakest first.

1. Devnet anchoring (phase 69). The owner asked for Solana devnet; the honest use is a timestamp witness of the corpus root. Devnet can reset, so a proof can lose its chain evidence. The memo format is fixed (whole UTC hour, root, count) and the anchor covers ledger event hashes, so the root rides in an event. The stated swap-in is drift detection (R9): it already exists (`drift.ts:230`) and would give the owner a check that stays useful if devnet resets.
2. TimescaleDB (phases 63, 66, 67, 68). The index store is plain Postgres with no hypertable. The v1.7 tables are relational and small, not time series. Using the name "TimescaleDB" for them overstates the fit; the actual time-series store is Greptime.
3. TEI (phase 64). The only consumer is near-duplicate reporting. LightRAG's own embedding is set on the LightRAG server and locked to its data, so TEI does not improve retrieval itself. The client and fabric row are small and give the owner a measured, cached embedding path; retrieval does not depend on them.
