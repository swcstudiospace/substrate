# F1–F7 data model (plane reference)

Storage contracts for the seven edge-specialist features (see ADR-0010/0011, `.planning/selection-matrix.md`).
All tables are plain Postgres today; hypertable conversion is an operator step when a table proves volume.

| ID | Tables (migration) | Contents | Owner |
|---|---|---|---|
| F1 | `graph_history` (v50) | structural per-graph event log `(graph_id, occurred_at, node_id)`, `seq` | TimescaleDB |
| F2 | `rollup_freshness` (v51) | per-layer refresh counts | TimescaleDB |
| F3 | `telemetry_buckets` (v51) | downsampled telemetry aggregates | TimescaleDB |
| F4 | `ledger_forecast_snapshots` (v51) | burn-rate forecast snapshots | TimescaleDB |
| F5 | `ordered_event_log` (v52) | wake-up hints w/ monotonic `seq` per graph | TimescaleDB (+ Dragonfly wake-ups) |
| F6 | `causal_recall_items` (v52) | source + chain link per recalled item | Hindsight-backed |
| F7 | `retrieval_evals` (v52) | recall@5 + latency per eval | LightRAG eval harness |

Conventions: UTC `timestamptz`; ordering `(occurred_at, seq)`; no payload text or PII in F1–F7 tables (structural ids, hashes, counters only).
