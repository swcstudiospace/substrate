# Codebase & resource inventory — Wave 1 (n1, SPE-38284) · 2026-11-26

Evidence-first. Sources: live probes 2026-11-26 + `.planning/audit/*` (2026-11-23) + `audit/*` + code paths below.
Env-var names only; no secret values.

## 1. Outstanding phases (authoritative sources)

- `.planning/ROADMAP.md` + `.planning/STATE.md` + `gsd-tools query init.manager` (2026-11-26):
  milestone **v1.8** (Awaiting next milestone; closed 2026-11-22). 61 phases: 6 `passed` (44, 55, 56, 57, 58, 60); **10 outstanding** in v1.8:
  46 (LightRAG hybrid, `gaps_found`), 61 (`human_needed`), 66 (`human_needed`), 67 (`gaps_found`),
  68 (`human_needed`), 71 (`human_needed`), 74 (`human_needed`), 76 (`human_needed`), 77 (`human_needed`), 78 (`human_needed`).
- Trace spine: `substrate:m<ver>:p<num>` (Linear authoritative, Notion mirrored — `.planning/issue-programming/notion-linear-mapping.md` §0).
- Ultrathink graph `ut-d4ee2066e3-dee96df7`: 7 Linear issues SPE-38284…90 + 47 sub-issues, Notion task 424bc1a0… (status `Implementing` 2026-11-26).

## 2. Codebase conventions (verified paths)

- Monorepo: bun workspaces, **12 packages** (`package.json`): mcp-server, cli, host, collectors, projector, ledger, observability, audit, evidence, worktree-snapshot, fleet, corpus.
- Types: `tsconfig.json` strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noUnusedLocals/Params`; Biome `noExplicitAny: error`, `noNonNullAssertion: error`. Ratchet baselines: any=0, non-null=0, empty-catch=0.
- Gate: `bun run verify` → `scripts/verify.ts` GATE_STEPS; parity suite 31 pass (`scripts/verify.test.ts`).
- Resource clients (exact paths):
  - Timescale index: `packages/mcp-server/src/index-store.ts` — `MIGRATION_STEPS` (v1–52), `new SQL(url)` pool, ~300-entry flat `src/` (plane split by naming, not packages).
  - Ledger/Greptime: `packages/ledger/src/` (memo, merkle, solana anchor); Greptime ledger via substrate-mcp `events_emit`.
  - LightRAG: `packages/mcp-server/src/planes/lightrag.ts` (44K) + `lightrag-bulk.ts`; TEI `packages/mcp-server/src/planes/tei.ts`.
  - Hindsight: `packages/mcp-server/src/planes/hindsight.ts` (30K).
  - Dragonfly cache: cache plane in mcp-server (`healthz` cache `connected`).
  - Ingestion tool (out-of-repo): `/root/lightrag-sync/src/{cli,scanner,lightrag_adapter,reconciler,state_store}.py`.

## 3. Live resource audit (2026-11-26 probes)

| Resource | Version | Live state | Evidence |
|---|---|---|---|
| TimescaleDB `substrate-prod-pg` (25432) | PG 16.15 + timescaledb **2.32.0** | 19 public + 3 substrate tables; largest `graph_nodes` 3.6 MB; `max(schema_migrations)` **48** | `timescaledb_information.hypertables` → **0 rows** (live, 2026-11-26) |
| GreptimeDB `substrate-prod-greptime` (24000) | 1.1.4 | `/health` 200; ledger authoritative (180d) | `healthz` `greptime:true` |
| DragonflyDB `substrate-prod-dragonfly` (26379) | redis_version 7.4.0 / df-v2.1 | `PING→PONG`, Docker healthy | `healthz` cache connected |
| Hindsight api+worker (8888/8889) | 0.9.1 | `/health` 200 `database:connected`, pool idle | worker pending=0 (2026-11-23) |
| LightRAG `substrate-prod-lightrag` (9621) | v1.5.7 | `/health` 200, `pipeline_busy:false`; `status_counts`: **failed 1713 / processed 9665 / all 11378** | `/documents/status_counts` 2026-11-26 |
| TEI (8080) | BAAI/bge-small-en-v1.5 | ~2 ms probe | fabric `ok` |

**Hypertable verdict (evidence-based, overrides ADR-0010 wording):** live DB has **0 hypertables**, tables are small relational (3.6 MB max) — no time-series workload exists today. `docs/data-planes.md` (“plain Postgres tables, no hypertables”) is correct. F1 hypertable adoption is **not justified** for current tables; justified only when a new append-heavy time-series table (e.g. future `graph_history` at scale) proves volume. ADR-0010’s “hypertables for graph history” must be re-scoped to graph_history-only + volume gate (n3).

## 4. F1–F7 schema state (pre-existing, uncommitted)

- `index-store.ts` MIGRATION_STEPS v50 `graph_history`, v51 `rollup_freshness/telemetry_buckets/ledger_forecast_snapshots`, v52 `ordered_event_log/causal_recall_items/retrieval_evals` — **code-only, NOT applied** (live max v48; `graph_history`/`rollup_freshness`/`telemetry_buckets` absent live).
- ADRs accepted: `docs/adr/0010` (F1–F7 edge features, 2026-11-25), `docs/adr/0011` (closeout → 1.1.0).
- Live DB rehearsal required before any apply (lesson: rehearse on restored dump; `SUBSTRATE_TEST_PG_URL` must be the substrate-test-pg 55434, not local 5432 which is another project’s PG).

## 5. Per-resource workload pain (baselines)

- Timescale: graph/memory/governance relational; no slow-query baseline; under-queried.
- Greptime: ledger write/query throughput unbenchmarked; 180d retention untested at load.
- Dragonfly: TTLs 300/600/60s set; hit-rate unused to bound recall cost.
- Hindsight: per-surface banks; recall SLO unmeasured.
- LightRAG: `naive` mode only (hybrid deferred); recall@5 `null`; corpus manifest v21 stale (559k s lag, degraded fabric row).

## 6. Deliverable status

Wave-1 inputs for n2/n3/n4: phase list (§1), code paths (§2), live verdicts + baselines (§3–5), F1–F7 apply-gate (§4).
