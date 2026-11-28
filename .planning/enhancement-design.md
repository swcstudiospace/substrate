# Per-resource + 8-enhancement design (Waves 2–3, SPE-39530/39532) — 2026-11-28

Verified bases (docker, 2026-11-28): LightRAG 1.5.7 healthy · Hindsight 0.9.1 api/worker/control-plane healthy · TEI (8080) · DragonflyDB v2.1 (26379, healthy) · GreptimeDB 1.1.4 (24000/24001) · TimescaleDB prod (25432) + test twins. Disks: 96% full (16 GB free). "Leader" = live baseline leader from Railway era (version/image unconfirmed — treat as discovery task, not a contract).

## Per-resource specialty map

| Resource | Specialty | Mechanism | Design note |
|---|---|---|---|
| Leader | session/lease fencing + steering single-writer gate | fencing tokens on lease renewals | unconfirmed version — confirm image/version before committing |
| DragonflyDB | in-memory LM + eviction; hot shared-context cache | cache-aside, TTLs, Lua script for atomic slots | volatile by default — rebuild from durable stores |
| TimescaleDB | time-aggregation + retention + continuous aggregates | X1/X5 consumption of F1–F4 | hypertable conversion only on new time-series tables (adopt-gate) |
| GreptimeDB | high-volume unified telemetry ingestion | unified action stream, shared session IDs | append-mode: TTL, never DELETE purge |
| Hindsight | cross-agent episodic recall | F6 causal_recall_items enrichment | bank = owner; no dual-write |
| LightRAG | graph retrieval + provenance | hybrid upgrade measured by F7 | naive until judge passes |

## The 8 enhancements (concise)

- **E1 Live Steering multi-worktree sessions** — SessionRegistry (graph_nodes/bindings leases) + live-session bindings; single operator per session via CLI (settled decision); conflict detect when two sessions target same files.
- **E2 DragonflyDB shared-context/output cache** — namespaced session/worktree context + recent output + hot-retrieval results; per-class TTL; stale/expired never served fresh; fallback = durable read (tested).
- **E3 Unified memory fabric** — remember/recall/summarise/forget over Hindsight banks + LightRAG provenance; no silent competing writers.
- **E4 CLI Agent + Grok Bot orchestration** — delegation handoffs with namespace + permission model, per-agent audit.
- **E5 Observability feedback loop** — correlation IDs across Timescale/Greptime/Dragonfly; dashboards + burn alerts.
- **E6 Episodic memory** (RAG) — session outcomes indexed with provenance; supercession visible.
- **E7 Resilient VPS coordination** — Leader fencing for single-writer; TTL’d queueing; dead-letter surfacing.
- **E8 Session replay/audit** — append-only steering/action audit; replay to checkpoint; summary → Notion/Linear (read-only post-hoc).

## Compose (one flow carries all six)

LightRAG recall (provenance, freshness) → Dragonfly cache-aside → agent acts → Greptime telemetry + Timescale history w/ same correlation ID → Hindsight episode written back → LightRAG re-index. Each leg fallbacks-degraded per r5. Leader gates session mutation; no single resource's failure corrupts another.

## Constraints honored

No hypertable conversion of non-time-series tables; Dragonfly remains cache-only (never authoritative); Greptime owns ledger writes alone; no SVM/anchor involvement; non-sensitive-only caching (no secrets/personal in hot cache); test-with-live-resources only.
