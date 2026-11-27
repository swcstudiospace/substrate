# Phase decomposition + workload mapping — Wave 2 (n2 SPE-38285 + n4 SPE-38286) · 2026-11-26

Consumes `.planning/audit/codebase-resource-inventory.md` (n1). Phase names/order/status from ROADMAP.md + STATE.md live re-query — nothing invented.

## 1. Outstanding phases (10) — dependency order

| # | Phase | Verif. | Primary planes | Sub-issue skeleton (parent Linear Issue + Notion row each) |
|---|---|---|---|---|
| 46 | LightRAG hybrid RAG | gaps_found | LightRAG, TEI, Hindsight | audit → parity comparator → hybrid enable → retrieval eval → cutover record |
| 61 | Session rollback exact chat moment | human_needed | Timescale (checkpoints), Greptime (ledger) | tree-hash suite → interrupt endings → drift refusal → live rehearsal |
| 66 | Docs Reflect | human_needed | LightRAG, Timescale (`corpus_feedback/retrievals`) | telemetry bound → `docs_feedback` audit → `scoreDocument` → supersession |
| 67 | Live Steering GA | gaps_found | Greptime, Dragonfly, Timescale | criterion-4 owner+PG → GA gate → steering idempotency link (77) |
| 68 | Worktree Fleet | human_needed | Timescale (`worktrees`), Greptime | fleet claim → lease → reconcile → soak |
| 71 | Multi-Session boundary | human_needed | Timescale (`live_session_bindings`), Dragonfly (presence only) | issuance authority → terminal tombstones → rehearsal |
| 74 | Cross-repo compensating | human_needed | Timescale (`cross_repo_*`), Greptime | compensating plan → replay-0-rows → proof |
| 76 | Telemetry buffer / dead-letter | human_needed | Greptime (buffer), Dragonfly (counters only) | DLQ depth → durable option → surfacing |
| 77 | Steering idempotency / ordering | human_needed | Greptime, Timescale | idempotency keys → ordering proof → replay |
| 78 | Cross-layer reconciliation | human_needed (partial) | all 5 + corpus | per-layer counts → first mismatch key → 0-write clean run |

Each phase: one parent Linear Issue (SPE project) + one Notion Task-Graph row, `substrate:m<ver>:p<num>` composite key, sha256 idempotent sync, 3-retry + ledger audit (`notion-linear-mapping.md` §1–6). Real writes gated on q-gate (§blocking-unknowns).

## 2. Workload → primary resource (authoritative)

| Workload | Authoritative | Projection/cache/index | Rule |
|---|---|---|---|
| append-only agent events / ledger | **GreptimeDB** (`agent_events`) | Timescale: Merkle root only; LightRAG: no payloads | single writer; hash chain + hourly anchor |
| graph/leases/memory/governance | **TimescaleDB** (plain tables, 0 hypertables) | Dragonfly: presence hints, never leases | cache miss → recompute; never authoritative in cache |
| docs corpus + retrieval | **LightRAG** (derived index) | Timescale `corpus_documents` manifest (control), TEI embeddings | source docs authoritative; LightRAG re-ingest on hash change |
| cross-agent memory recall | **Hindsight** (per-surface banks) | LightRAG context join (phase 46) | bank = owner; no dual-write |
| hot reads (brief/search/graph) | **DragonflyDB** cache-aside | TTL 300/600/60s → authoritative re-read | stale-if-error bounded; disable flag = bypass |

## 3. Timescale vs Greptime boundary

No overlap by design (PROJECT.md, data-planes.md): Greptime owns event appends/time-series; Timescale owns relational index. No workload writes both. F4 (Greptime downsampling) and F1–F3 (Timescale) must not duplicate the ledger — `telemetry_buckets` (v51) aggregates, never copies.

## 4. Shared identity / time / correlation (for n5)

- IDs: `source-system:entity-type:stable-key` + sha256 content hash for dedup (already used by LightRAG `repo:relpath`).
- Time: UTC `timestamptz` (schemas use `timestamptz`), precision ms; ordering by `(occurred_at, seq)` per graph — `graph_history` (v50) PK `(graph_id, occurred_at, node_id)` + `seq`.
- Correlation: propagate graph_id/request id through mcp-server planes into logs; LightRAG lineage = run_id + manifest hash.

## 5. n4 pause assessment

Proceed (see `blocking-unknowns.md`): no pause except Wave-3 sync write-gate + human-verify closes. Next: n3 selection matrix (Wave 3).
