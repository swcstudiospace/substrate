# Wave 8 baseline — 2026-11-28

Read-only snapshot. Sources: `.planning/ROADMAP.md`, `.planning/STATE.md`,
`.planning/REQUIREMENTS.md`, `.planning/execution-plan.md`,
`.planning/enhancement-design.md`, `scripts/verify.ts`, `package.json`,
`scripts/phase-close-check.ts`. No code touched.

## 1. Outstanding GSD phases

Ten phases remain owner-verification pending (STATE.md Wave 7 audit,
`n7 SPE-39367`; Deferred Verification table). Eight in assignment scope:

| Phase | Milestone | State | What is open |
|-------|-----------|-------|--------------|
| 46 LightRAG hybrid RAG | v1.5 | gaps_found | criteria 2, 4, 5, 6 + graph/hybrid modes; no parity comparator; cutover done, RAG-backend code removal gated; per-run operator approval + real LLM route |
| 61 Session rollback | v1.6 | human_needed | criterion 3 partial: no host installs/fires `substrate session hook` until operator installs printed config (ADR 0007, D55-4) |
| 66 Docs Reflect | v1.7 | human_needed | plane-score capture, live reflect, migration rehearsal operator-gated; PARTIAL |
| 67 Live Steering GA | v1.7 | gaps_found | host hook install + live delivery operator-gated; long-poll admission slot needs contract decision in admission.ts |
| 68 Worktree Fleet | v1.7 | human_needed | guard has no caller; merge-back check-then-note race needs external lock |
| 71 Multi-Session boundary | v1.8 | human_needed | operator-gated live proofs |
| 74 Cross-repo compensating | v1.8 | human_needed | migration step 43 rehearsal operator-gated; owner decision 2026-11-16: keep module-only, no route/MCP tool |
| 78 Cross-layer reconciliation | v1.8 | partial | memory.forget pair only; scheduler unwired (unit staged under infra/vps, not installed, operator gate) |

Also still deferred_human (outside assignment scope, same table):
76 Telemetry buffer (claim-withdrawal policy + buffer paths in systemd
operator-gated) and 77 Steering idempotency (migrations 44/45 rehearsal
operator-gated). Sibling phases passed: 72 (7/7), 73, 75.

v1.9 Unison Graph Engineering is defined (ROADMAP line 15:
data flow/indexing/retrieval, coordination layers, impact parity over
data/coordination/uplift structures; refs SPE-34076/34079) but unstarted.
No milestone is marked COMPLETE.

## 2. v1.9 phases 80–86 (REQUIREMENTS.md traceability, all Pending)

| Phase | Requirements | Scope |
|-------|--------------|-------|
| 80 | DG-1a | Dragonfly readiness probe/gate (running, healthy, within capacity) before E2 cache work |
| 81 | DG-1b | Gate decision implemented or documented: block E2 on not-ready, or record why not |
| 82 | E2-01, E2-02 | Dragonfly shared-context cache (cache-aside, TTLs, Lua atomic slots); fallback to durable read tested, stale never served fresh |
| 83 | E1-01 | Live Steering multi-worktree via SessionRegistry + live-session bindings, single operator per session via CLI |
| 84 | E3-01, E6-01 | Unified memory fabric (Hindsight bank owner / LightRAG provenance reader); episodic outcomes indexed with provenance, supersession visible |
| 85 | E4-01, E7-01 | Delegation handoffs with namespace + permission model; Leader fencing single-writer with TTL queueing + dead-letter surfacing |
| 86 | E5-01, E8-01 | Correlation IDs across Timescale/Greptime/Dragonfly + dashboards/burn alerts; append-only replay-to-checkpoint audit, summary mirrored read-only to Linear/Notion |

Coverage: 10/10 v1 requirements mapped, 0 unmapped. E2 gated by DG-1a
readiness (proof-mk9f interop verdict: FAIL-WITH-REASON until gate green).
Out of scope: hypertable conversion of non-time-series tables,
LightRAG→RAG-backend reversibility, Leader as primary writer.

## 3. Toolchain commands

`bun run verify` (`scripts/verify.ts`, GATE_STEPS in run order; CI runs the
same argv as separate steps; `--audit` opts into the audit step,
`--only`/`--skip` select steps):

1. `install` — `bun install --frozen-lockfile`
2. `types` — `bunx tsc --noEmit`
3. `lint` — `bunx biome lint --reporter=summary .` (same as `bun run lint` =
   `biome lint .`; error-any/non-null ratchet)
4. `tests` — `bun test`
5. `python` — `uv run --no-project --with httpx==0.28.1 --with pytest==9.1.1 python -m pytest packages/miner/tests packages/dispatcher/tests`
6. `locks` — `bun run check:phase-close`
7. `audit` (opt-in) — `bun scripts/audit-gate.ts`

`bun run check:phase-close` (`scripts/phase-close-check.ts`): proves
`EVENT_KINDS` unchanged vs v1.2 baseline `ab62c91` and `SURFACES` equals
baseline plus reviewed additions; runs 4 lock tests
(`store-lock`, `vocabulary-lock`, `event-sources`, `audit/policy`); read-only
git (`git --no-optional-locks show`); exit 0 pass / 1 failed / 2 precondition
refused.

Gate baselines on record: full verify 12872 pass / 16 skip / 5 fail (gap
recorded, Wave 7); migrate/contract/archive/rollback 94/94 green; tsc clean.
Live-service scripts (`gate:boot`, `smoke:*`) are never run autonomously.
Resources healthy on VPS (2026-11-28): LightRAG 1.5.7, Hindsight 0.9.1,
TEI :8080, DragonflyDB :26379, GreptimeDB 1.1.4, TimescaleDB prod :25432.

## 4. Per-n7-unit done-when mapping

n7 = SPE-39535 ordered wave plan (`.planning/execution-plan.md` lanes A–F);
per-lane gate: **live probe green + `bun run verify` + fabric compliance PASS**.

| Lane | Enhancement → Phase | Done when |
|------|---------------------|-----------|
| A DG readiness | DG-1a/1b → 80/81 | probe reports running/healthy/within-capacity; block-or-document decision recorded; gates E2/E4 work |
| B E2 cache | E2-01/02 → 82 | cache-aside + TTLs + Lua atomic slots live; fallback-to-durable tested; stale never served fresh |
| C E1 steering | E1-01 → 83 | SessionRegistry + live bindings; single operator per session via CLI; file-target conflicts detected |
| D E3+E6 memory | E3-01/E6-01 → 84 | Hindsight bank owns writes, LightRAG provenance-only, no competing writers; episodes indexed with visible supersession |
| E E4+E7 orchestration | E4-01/E7-01 → 85 | namespace + permission handoffs with per-agent audit; single-writer fencing with TTL queue + DLQ surfacing |
| F E5+E8 observability | E5-01/E8-01 → 86 | correlation IDs across all three stores with dashboards/alerts; append-only audit replays to checkpoint |

Order: A first; B, C concurrent after A; D after B; E after C; F last.
Constraints (enhancement-design.md): Dragonfly cache-only, Greptime
append-mode ledger writes alone, no hypertable conversion, no SVM/anchor
involvement, non-sensitive-only cache, test-with-live-resources only.
