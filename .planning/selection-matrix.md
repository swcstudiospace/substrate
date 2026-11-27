# Selection matrix — Wave 3 (n3 SPE-38287) · 2026-11-26

7 features (within 6–8). Each tied to evidenced workload (inventory §3–5); nothing selected on novelty.
Hindsight: evaluated, **0 selected** (role beyond banks/recall unverified — n4 gate). Status: `audited → selected` (pending n5/n6 verify).

| ID | Resource / feature | Evidenced problem | Migration | Verify (measure) | Rollback |
|---|---|---|---|---|---|
| F1 | TimescaleDB `graph_history` partitioned log (v50, code-only) | `graph_nodes` 3.6 MB growing; append-only per-graph history has no dedicated store; PK+index shaped for time queries | Apply v50 on rehearsed dump; **plain table first** (hypertable only if volume gate met) | rowcount/checksum equal; `occurred_at` query p95 vs null | drop table (down text) — nothing reads it yet |
| F2 | TimescaleDB rollup freshness + telemetry buckets (v51) | burn/rollup today ad-hoc; `rollup_freshness` gives per-layer refresh proof | Apply v51; refresh jobs write only summaries | freshness row per layer; bucket counts = event counts (sample) | drop 3 tables (down text) |
| F3 | `ledger_forecast_snapshots` burn forecast (v51) | error-budget burn needs forecast, not raw scan | same v51 step; forecast job only | forecast compute < query scan; SLO burn matches manual | disable job; drop snapshot |
| F4 | GreptimeDB downsampled buckets projection | ledger 180d full-resolution is hot-path heavy | pipeline writes `telemetry_buckets` aggregates only (no ledger copy) | aggregate latency < full scan; storage delta recorded | stop pipeline; base ledger untouched |
| F5 | Dragonfly ordered event log (v52 `ordered_event_log`) + cache-aside already live | steering ordering (phases 67/77) needs monotonic seq store | Apply v52; seq allocation only, payloads stay in Greptime | replay writes 0 rows; seq monotonic per graph | drop 3 tables; cache plane untouched |
| F6 | LightRAG checkpointed idempotent ingestion (in-flight bg_106 + 4 repos pending) | 7465 docs unmanifested; recall@5 `null` | Resume per-repo sync; per-batch retrieval check | manifest `fully-synced` per repo; sample queries cite source docs | checkpoint preserved; failed batch retries, successes skipped |
| F7 | LightRAG hybrid retrieval eval harness (v52 `retrieval_evals`, `causal_recall_items`) | naive-only; no recall measurement (P0 gate) | Apply v52; golden-set eval job | recall@5 ≥ 0.6 target recorded; latency p95 within 2000 ms (NFR-P2) | drop eval tables; naive path unchanged |

Rejected (recorded): hypertable conversion of existing 22 tables (0 time-series workloads — bulk migration forbidden); Hindsight new feature (unverified role); Greptime replacing Timescale relational (category error); Dragonfly queue/locks (cache-only boundary, data-planes.md).

Hypertable decision: **DO NOT ADOPT** for any current table (live 0 hypertables, all relational/small). Adopt-gate for future: append-heavy time-series table + measured volume + retention policy + rehearsed backfill; F1 ships plain-partitioned-by-design (PK/idx) until then. ADR-0010 wording re-scoped accordingly (addendum in SUMMARY).

Links: parent graph `ut-d4ee2066e3-dee96df7`; per-feature Notion/Linear rows are n5’s job (Wave 4) — stable keys `GSD-p046-F6` etc. No invented IDs.
