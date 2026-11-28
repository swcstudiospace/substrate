---
phase: 105
verified: 2026-11-28T19:19:42Z
status: passed
score: 7/7 acceptance criteria hold at worktree (HEAD 9403664b + uncommitted wave files)
covered_files: [".planning/phases/105-f6-in-session-recall/105-PLAN.md", ".planning/phases/105-f6-in-session-recall/105-SUMMARY.md", "packages/mcp-server/src/brief-recall-fanout.test.ts", "packages/mcp-server/src/brief-recall.test.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-recall-budget.test.ts", "packages/mcp-server/src/memory-recall.test.ts", "packages/mcp-server/src/memory-recall.ts", "packages/mcp-server/src/recall-snapshot.test.ts", "packages/mcp-server/src/recall-snapshot.ts"]
covered_digest: "v3:sha256:de67ff3e320b64b2ed25ed921a9610618ac325ba048ca8e2002cb8063fdc406b"
---

# Phase 105 (F6) — In-Session Recall — VERIFICATION

**Goal:** One on-demand `recall` entry serves brief-prefill + ad-hoc calls with per-hit provenance under one 1.5s tunable budget; misses degrade explicitly, never fabricated.
**Status:** passed. No code edits; no STATE/ROADMAP edits.

## Acceptance check

| # | Criterion (PLAN) | Result | Evidence |
|---|---|---|---|
| 1 | Single entry: brief + ad-hoc funnel through `recallAcrossBanks`; no second implementation | HOLD | `recallMemories` → `resolveRecallBanks` → `recallAcrossBanks`; `fanOutBriefRecall` → same fan-out via `briefFanoutOf`; bank-first ordering + `dedupeHits` tests green |
| 2 | Every hit carries bank + document/entry + freshness; gaps explicit, never invented | HOLD | `DerivedMemoryHit` provenance (`bank`, `document_id`/`entry_id`, `asOf`); exact gap strings (`recall-timeout:`, `partial recall:`, `hindsight recall failed:`, …) asserted in tests |
| 3 | Single tunable budget default 1.5s, clamped `100..10000`, brief path inside cap minus margin | HOLD | `DEFAULT_RECALL_BUDGET_MS = 1500` shared by `SUBSTRATE_BRIEF_RECALL_BUDGET_MS` + `HINDSIGHT_RECALL_BUDGET_MS`; `BRIEF_RECALL_CAP_MS` 3000 − 250 margin; clamp tests green |
| 4 | Degradation ladder full → Hindsight-only → empty-with-reason, fake-timer proven | HOLD | slow-bank cut at budget, Hindsight-only with `withheld` reason, empty-with-reason; no hang, no fabrication |
| 5 | `visibleToCaller` contract unchanged | HOLD | `memory-policy.ts` untouched semantics, existing tests green |
| 6 | F2 relationship context consumed input-only, no schema change | HOLD | `attachRelated` join only; `RecallScope`/graph-scope flag unchanged |
| 7 | F7 live-exercise reason-string contract exposed | HOLD | ladder gap strings stable and documented for Phase 106 to assert against |

## Test runs (this verification)

- 5 harness files (fanout + brief + memory-recall + budget + snapshot): **280 pass, 0 fail** (matches SUMMARY's 280)
- Consumer suites (tandem/memory-search/docs-search/service-tandem-scope/repo-scope/hindsight-canary): green per SUMMARY (237 pass); spot re-run of `brief-recall + fanout + hindsight + memory-recall` in this verification: all pass
- `bunx tsc --noEmit`: clean (repo-wide)

## Decision coverage

CONTEXT decisions hold: deadline budget with fallback (Hindsight-only, then
empty-with-reason), per-hit provenance (bank + document + freshness + closed
`ledgerStatus` vocabulary `verified|untrusted|pending`, no promotion),
composition legs fail-open per-leg (recency boost bounded 0.15, version-keyed
cache `queryHash + v`, LightRAG↔Hindsight merge degrades per-leg).
