# Phase 105: F6 in-session recall — SUMMARY

**Status:** Complete. Single recall entry serves brief-prefill + ad-hoc calls with per-hit provenance under one 1.5s tunable budget; misses degrade explicitly, never fabricated.

## Entry point

`recallAcrossBanks` (`packages/mcp-server/src/memory-recall.ts`) is the one fan-out both paths run:

- Ad-hoc: `recallMemories` → `resolveRecallBanks` (caller bank first, `sub-*` only, no shared fallback) → `recallAcrossBanks` → `rankedHits` → `attachRelated`.
- Brief-prefill: `fanOutBriefRecall` → the same `recallAcrossBanks` over the same banks under the caller's visibility, ranked by the same `rankedHits` (via `briefFanoutOf`), read through the `recall-snapshot` cache class and waited at most `BRIEF_RECALL_CAP_MS`.

`visibleToCaller` (`memory-policy.ts`) is unchanged — same contract, verified by existing tests. No second recall implementation exists; a second one is a review rejection per PLAN.

## Budget (single tunable) + degradation ladder

- Default `1500` ms (`DEFAULT_RECALL_BUDGET_MS`, re-exported from `recall-snapshot.ts`): `SUBSTRATE_BRIEF_RECALL_BUDGET_MS` and `HINDSIGHT_RECALL_BUDGET_MS` now share it (was 4000 for Hindsight alone).
- Clamp `100..10000` ms (`MIN_RECALL_BUDGET_MS`/`MAX_RECALL_BUDGET_MS`): enforced at parse (`loadConfig` via `clampRecallBudgetMs`) and at use (`recallMemories`).
- Brief path: `briefRecallBudgetMs` clamps the fan-out inside `BRIEF_RECALL_CAP_MS` (3000) minus `BRIEF_RECALL_BANK_MARGIN_MS` (250); the brief's own wait is `boundedRecall` (cap → `partial()`), real timers, fake-bank gated.
- Ladder, in order: full fan-out → entry-free Hindsight hits only (failed/timeout forgotten-check withholds entry-naming hits, fail-closed) → empty-with-reason. Exact gap strings: `recall-timeout: …`, `partial recall: …`, `hindsight recall failed: …`, `index: forgotten-entry check timed out/unavailable, hits that name an index entry were withheld`, `hindsight is not configured`, `vm-guest`, `memory_recall needs a query`, `no recall bank for surface …: configure HINDSIGHT_BANKS`.

## Provenance per hit + composition legs

- Per-hit shape (`DerivedMemoryHit`): `bank` + `document_id`/`entry_id` (`metadata.entry_id`) + `asOf` freshness anchor (age = `formatAge(now − Date.parse(asOf))`) + `ledgerStatus` where carried. Closed vocabulary `verified|untrusted|pending` from `metadata.ledger_status`; anything else stays absent, never guessed; ranking is score-only — F6 never promotes.
- Brief render: `recallSection` title keeps the convention `RECALL_TITLE_PREFIX + banks + age` (per-hit ids stay on the tool reply; the section carries bank + age).
- Composition (input-only, fail-open): `RecencySignal` (`nowMs` + `ageMsOf`, null = unknown) adds a bounded boost (`MAX_RECENCY_BOOST` 0.15, `RECENCY_HALF_LIFE_MS` 24h) before dedupe/sort; Timescale down (no signal) keeps plane order. Version-keyed cache: `fanoutSnapshotArgs` now carries `queryHash` (sha256-16) + `v: RECALL_CACHE_VERSION` beside repo/sorted-banks/query; TTL stays `ttlS`, explicit invalidation stays the memory/recall generation bump (+ a version bump on entry-shape change). LightRAG↔Hindsight merge (`mergeTandem`) already degrades per-leg (empty side contributes nothing) with per-item provenance — reused as-is, no new modules.

## Harness (fake-only; repo runs `bun test`, not vitest)

```
bun test packages/mcp-server/src/brief-recall-fanout.test.ts \
  packages/mcp-server/src/brief-recall.test.ts \
  packages/mcp-server/src/memory-recall.test.ts \
  packages/mcp-server/src/memory-recall-budget.test.ts \
  packages/mcp-server/src/recall-snapshot.test.ts
npx tsc --noEmit
```

- 280 pass / 0 fail across the 5 files (16s). New fake-timer cases: bank-first ordering + dedupe + per-hit provenance (`asOf`, `entry_id`); ledger passthrough/absence + no-promote ordering; recency lift / Timescale-down order / boost bound; budget default + clamp; forgotten-check timeout/failure → Hindsight-only + `withheld` reason; version-keyed args; stored-answer section title (banks + `5m old`).
- Consumer suites: tandem/memory-search/docs-search/service-tandem-scope/repo-scope/hindsight-canary green (237 pass). `tsc` clean in all touched files.

## F7 live exercise (Phase 106) — explicit follow-up

Not this phase. The reason-string contract F7 asserts against is the ladder above; a mid-session recall must return provenance hits or one of the named gaps — never placeholder content.

## Known pre-existing (not Phase 105, untouched)

- `tsc` errors in `packages/mcp-server/src/session-snapshot.ts` (Phase 103 work in this shared worktree).
- `flag-registry.test.ts` `.env.example` gap for `SUBSTRATE_SESSION_SNAPSHOT` (same source).
