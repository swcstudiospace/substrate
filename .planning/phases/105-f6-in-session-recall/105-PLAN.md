# Phase 105: F6 in-session recall — PLAN

**Goal:** One on-demand `recall` entry serves brief-prefill + ad-hoc tool calls with per-hit provenance and a 1.5s default latency budget; misses degrade gracefully (Hindsight-only → empty-with-reason), never fabricated. F7 exercises the path live.

**Tracer:** `recallMemories` (ad-hoc) and `fanOutBriefRecall` (brief) share `recallAcrossBanks` under one deadline before any provenance/gap shaping.

## Task 1 — Single recall entry + provenance

**Files:**
- `packages/mcp-server/src/memory-recall.ts` — `recallMemories`, `fanOutBriefRecall`, `recallAcrossBanks`, `resolveRecallBanks`, `briefFanoutOf`, `DerivedMemoryHit`
- `packages/mcp-server/src/recall-snapshot.ts` — `buildFanoutLines`, `fanoutSnapshot`, `recallSection`, `RECALL_TITLE_PREFIX`
- `packages/mcp-server/src/memory-policy.ts` — `visibleToCaller` (unchanged contract, verify)
- `packages/mcp-server/src/brief.ts` — brief recall-read wiring (reuse, no new path)

**Steps:**
1. Confirm single entry: ad-hoc `recallMemories` and brief `fanOutBriefRecall` both funnel through `recallAcrossBanks`; `resolveRecallBanks` puts caller bank first; no parallel recall implementation.
2. Every served hit carries provenance: source bank + document/entry id + freshness (snapshot age / `snapshotState`, `formatAge`). Reuse `recallSection` title convention (`RECALL_TITLE_PREFIX` + bank + age); untrusted-notice preserved (`UNTRUSTED_MEMORY_NOTICE`).
3. Keep F2 relationship context consumption as input only (no schema change here); graph-scope (`withGraphScope`/`scopeRecall`) stays behind existing `RecallScope` flag.
4. Fake-only tests: `HindsightFake` (see `packages/mcp-server/src/hindsight-fake.ts`) multi-bank fan-out; assert bank-first ordering, dedupe (`dedupeHits`), and provenance fields present on every hit.

**Acceptance:**
- One code path serves brief + ad-hoc; a second recall implementation is rejected in review.
- Every hit in the reply names bank + document + freshness; gaps are explicit (see Task 2), never silent, never invented.

## Task 2 — Latency budget + graceful degradation

**Files:**
- `packages/mcp-server/src/recall-snapshot.ts` — `loadRecallConfig`, `DEFAULT_RECALL_BUDGET_MS` (1.5s), `BRIEF_RECALL_CAP_MS`, `BRIEF_RECALL_BANK_MARGIN_MS`, `briefRecallBudgetMs`, `withDeadline`, `SYSTEM_TIMERS`
- `packages/mcp-server/src/memory-recall.ts` — `DEFAULT_RECALL_BUDGET_MS` (ad-hoc 4s precedent — reconcile to single tunable, brief path wins), `FanOutOptions`, forgotten-entry `withoutForgotten` deadline handling
- `packages/mcp-server/src/brief.ts` — `recall.read` / `recall.partial` + `BRIEF_RECALL_CAP_MS` enforce path

**Steps:**
1. Single tunable budget flag (default 1.5s per CONTEXT brief-path precedent); `briefRecallBudgetMs` clamps fan-out inside `BRIEF_RECALL_CAP_MS` minus margin; ad-hoc path uses same flag, not a second knob.
2. Deadline via `withDeadline` with injectable `SYSTEM_TIMERS` seam; tests use fake timers only (precedent: `brief-recall-fanout.test.ts` `onRecall` gate, `brief-recall.test.ts` cache-failure injection).
3. Degradation ladder, in order: full fan-out → Hindsight-only (skip forgotten-check / graph-scope under remaining budget) → empty snapshot with explicit reason (timeout / no banks / no Hindsight). Empty-with-reason renders as a named gap in `recallSection`, never placeholder content.
4. F7 (Phase 106) exercises this path live; expose the degraded reason string so the steering test can assert on it.

**Acceptance:**
- Budget exceeded → caller still gets an answer within cap: partial hits + named gap, or empty-with-reason; no hang, no fabrication.
- Fake-timer test proves: slow bank cut at budget, Hindsight-only fallback served, then empty-with-reason; tunable flag clamped to `[MIN_RECALL_BUDGET_MS, MAX_RECALL_BUDGET_MS]`.

## Task 3 — Verification harness (fake-timer + F7 live hookup)

**Files (tests only, no new prod modules):**
- `packages/mcp-server/src/brief-recall-fanout.test.ts` (extend: budget/degraded cases)
- `packages/mcp-server/src/brief-recall.test.ts` (extend: provenance-on-brief-section cases)
- `packages/mcp-server/src/hindsight-fake.ts` (reuse; extend bank-latency controls only if missing)

**Harness:**
```bash
# from repo root, per changed package
npx vitest run packages/mcp-server/src/brief-recall-fanout.test.ts packages/mcp-server/src/brief-recall.test.ts packages/mcp-server/src/memory-recall.test.ts
npx tsc --noEmit -p packages/mcp-server
```
- Fake timers + `HindsightFake` only; no live Hindsight/LightRAG in tests. Cases: (a) all banks fast → full provenance reply; (b) one bank slow → cut at budget, partial + gap; (c) all slow/down → empty-with-reason; (d) budget flag unset/invalid → 1.5s default + boot warning.
- F7 live check (Phase 106, not this phase): repo ingest + steering round-trip asserts a mid-session recall returns provenance hits or an explicit gap — no new harness here, just the reason-string contract from Task 2.

## SUMMARY spec

`SUMMARY.md` (written at execution closeout) must state:
- Entry point (function + file) serving both brief-prefill and ad-hoc recall.
- Budget default (1.5s), flag name, cap/margin constants, and degradation ladder (fan-out → Hindsight-only → empty-with-reason) with the exact gap strings.
- Provenance shape per hit (bank + document/entry + freshness) and where the brief renders it.
- Harness command + fake-timer cases passing; F7 live exercise result (pass + gap-string asserted, or explicit follow-up).

## Out of scope

- F2 relationship learning changes (Phase 101 owns them); F6 consumes only.
- LightRAG/graph retrieval tuning and hybrid ranking (Phase 46 debt).
- New daemons, new cache classes, alerting infra; reuse `recall-snapshot` cache + prefetcher as-is.
- Live-network tests; all new tests fake-only.
- Any fabricated recall content to fill gaps — explicit gaps are the requirement.
