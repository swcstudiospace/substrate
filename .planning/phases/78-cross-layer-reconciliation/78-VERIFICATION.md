---
phase: 78-cross-layer-reconciliation
verified: 2026-11-18T12:22:19Z
status: human_needed
score: 2/2 must-haves verified
covered_files: [
    ".planning/phases/78-cross-layer-reconciliation/78-01-PLAN.md",
    ".planning/phases/78-cross-layer-reconciliation/78-SUMMARY.md",
    "package.json",
    "packages/mcp-server/src/cache.ts",
    "packages/mcp-server/src/config.test.ts",
    "packages/mcp-server/src/config.ts",
    "packages/mcp-server/src/flag-registry.ts",
    "packages/mcp-server/src/index-store.ts",
    "packages/mcp-server/src/reconcile-main.test.ts",
    "packages/mcp-server/src/reconcile-main.ts",
    "packages/mcp-server/src/reconcile-read.test.ts",
    "packages/mcp-server/src/reconcile-read.ts",
    "packages/mcp-server/src/reconcile-repair.test.ts",
    "packages/mcp-server/src/reconcile-repair.ts",
    "packages/mcp-server/src/reconcile-run.ts",
    "packages/mcp-server/src/reconcile-single-flight.test.ts",
    "packages/mcp-server/src/reconcile.test.ts",
    "packages/mcp-server/src/reconcile.ts",
    "packages/mcp-server/src/service.test.ts",
    "packages/mcp-server/src/service.ts",
    "scripts/reconcile.ts"
  ]
covered_digest: "v3:sha256:a508ca57156591b68b10cb67996e85960acfbd6e89fbfd7232e4354b88f9023e"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 2/2 must-haves verified (record at 0d896577 / c1367953, 2026-11-02)
  gaps_closed: []
  gaps_remaining: []
  regressions: []
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: "Staging host with SUBSTRATE_RECONCILE_INTERVAL_S=60 over a clean fixture: let one interval fire, then start a second tick while the first is in flight"
    expected: "Each tick writes one '[substrate] reconcile {...}' line with clean:true. No ledger, index or cache write. The second tick starts no second run"
    why_human: "The interval firing is real-time. The tick body and single-flight are covered by named tests (service.test.ts 'one scheduled tick on a clean fixture...'; reconcile-single-flight.test.ts), but the real timer is not"
  - test: "Live Dragonfly with the server stopped, on a copy of production key counts: repair --plan <file> (dry run), then repair --plan <file> --execute --server-stopped"
    expected: "The dry run writes nothing. The execute removes answers, then generation counters, then the forget mark, and keeps budget: and emb: keys. A prefix above 1000000 keys refuses with nothing removed. <plan>.result.json shows repaired against listed"
    why_human: "Real SCAN and UNLINK cost and behavior at production counts cannot be exercised by a unit test"
  - test: "Live GreptimeDB queryEvents for claim, warning and note kinds in a busy window"
    expected: "The lease comparison completes, or reports truncated when a node exceeds LOOKUP_LIMIT (100) rows or the lookup count passes the cap of 200"
    why_human: "Needs a live ledger with real volume"
  - test: "Live CLI run with real stores: report; repair --plan <file> --execute without --server-stopped; a dry run; repair --plan <file> --execute --server-stopped"
    expected: "Exit codes match docs/reconcile.md: report 0 or 1, usage and missing config 2, refused or failed repair 1. Missing --server-stopped exits 2 before any connection. The result file holds executed, refused, repaired, listed and error"
    why_human: "Needs live PG, GreptimeDB and Dragonfly"
---

# Phase 78: Cross-layer reconciliation Verification Report

**Phase Goal:** The ledger, the index and the cache agree, and any drift is reported with evidence. No drift is repaired destructively without a confirmed plan.
**Verified:** 2026-11-18T12:22:19Z
**Status:** human_needed
**Re-verification:** Yes. The prior record (2026-11-02, HEAD `0d896577`, human_needed, 2/2) is superseded. Both success criteria were re-checked against HEAD `357d6b15`. Code changed since `0d896577`: `service.ts` (scheduled tick and single-flight), `index-store.ts`, `config.ts`, `flag-registry.ts`, and the new `reconcile-single-flight.test.ts` (commit `325843e9`). The read and repair modules are unchanged.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1: a scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run | ✓ VERIFIED | `startReconcile` (`service.ts:4079-4090`) starts one unref'd `setInterval` at `SUBSTRATE_RECONCILE_INTERVAL_S`. `reconcileTick` (~:4095) is single-flight through `reconcilePass ??=`. `runScheduledReconcile` (~:4104-4123) calls `runReport` and writes one `[substrate] reconcile {...}` line carrying `counts`, `truncated`, `unchecked_layers`, `first` and `clean`. The read path writes nothing: `reconcile-read.ts` mutates only in-memory `Map`s; `reconcile-run.ts` and `reconcile.ts` make no store writes. Tests: `service.test.ts` "one scheduled tick on a clean fixture logs one clean reconcile line and writes nothing" (:5785) passes. `reconcile-read.test.ts:391` "with the cache off, the cache layer is unchecked..." passes. `reconcile-single-flight.test.ts` "two overlapping ticks run one pass..." passes. |
| 2 | SC2: repair is a separate confirmed step with a plan record, following the corpus delete rules | ✓ VERIFIED | `executePlan` (`reconcile-repair.ts:134`) is dry by default; `--execute` needs `serverStopped` (refusal at :177-181, before any read or delete). `planRefusal` (:112-123) refuses an item with another action, another match, or an orphan the fresh report does not list as live (checked at :162-165). The flush is a three-pass, prefix-bounded removal (`substrate:v1:*`, bound 1000000, fail-closed) that never removes `budget:` or `emb:` keys. It never touches the ledger or the index. The `plan --out` path refuses to overwrite. Result written to `<file>.result.json` in `finally` (`reconcile-main.ts:212-220`). Tests: `reconcile-repair.test.ts` dry run (:106), digest mismatch (:116), gone orphan (:130), other match (:288), other action (:300), budget/emb preservation (:173); `reconcile-main.test.ts` execute without `--server-stopped` exits 2 (:104), failed flush writes result (:52). Whole file set: 70 pass, 0 fail. |

**Score:** 2/2 must-haves verified. Behavior-unverified: 0 (behavior-dependent truths have named passing tests).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/reconcile-run.ts` | Read-only run, caps, cache-off detection | ✓ VERIFIED | `cacheOff` (:91); counts guard (:93-96); `uncheckedLayers` (:97) |
| `packages/mcp-server/src/reconcile.ts` | Pure comparators and report | ✓ VERIFIED | `unchecked_layers` on `Report` and `ReportInput`; `clean` derived |
| `packages/mcp-server/src/reconcile-repair.ts` | Plan-gated flush | ✓ VERIFIED | `planRefusal` (:112), `executePlan` (:134) |
| `packages/mcp-server/src/reconcile-main.ts` | CLI with plan, repair and result file | ✓ VERIFIED | Exit codes per usage; result file in `finally` |
| `packages/mcp-server/src/service.ts` | Scheduled timer, single-flight tick, log line | ✓ VERIFIED | `startReconcile`, `stopReconcile`, `reconcileTick`, `runScheduledReconcile`; line object carries `unchecked_layers` (:4118) |
| `docs/reconcile.md` | Matches the code | ✓ VERIFIED | Line 26 now states the scheduled line carries `unchecked_layers`, which matches `service.ts:4118`. The documentation warning from the prior pass is closed |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `startReconcile` timer | `reconcileTick` | `setInterval(() => void this.reconcileTick(), ...)` | ✓ WIRED | service.ts:4082 |
| `reconcileTick` | `runScheduledReconcile` | `reconcilePass ??=` | ✓ WIRED | service.ts:4097 |
| `runScheduledReconcile` | `runReport` | ledger, index and cache | ✓ WIRED | service.ts ~:4107 |
| `repair` CLI | `executePlan` | `reconcile-main.ts` | ✓ WIRED | Tests in reconcile-main.test.ts |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| Phase 78 SC1 | 78-01-PLAN | Scheduled per-layer report, no write on clean run | ✓ SATISFIED (unit scope) | Truth 1 |
| Phase 78 SC2 | 78-01-PLAN | Confirmed, plan-gated repair | ✓ SATISFIED (unit scope) | Truth 2 |

No orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/reconcile-read.ts` | 146-226 | `Map.set` calls | ℹ️ Info | In-memory accumulators only; no store write |

No TODO, FIXME, placeholder or stub markers in the phase-78 files.

## Human Verification Required

### 1. Real timer firing and single-flight on a staging host

**Test:** Staging host with `SUBSTRATE_RECONCILE_INTERVAL_S=60` over a clean fixture. Let one interval fire, then start a second tick while the first is in flight.
**Expected:** Each tick writes one `[substrate] reconcile {...}` line with `clean:true`. No ledger, index or cache write. The second tick starts no second run.
**Why human:** The interval firing is real-time. The tick body and single-flight have named tests, but the live timer and its overlap are not exercised by a test.

### 2. Live Dragonfly flush at production key counts

**Test:** Live Dragonfly, server stopped, on a copy of production key counts: `repair --plan <file>` (dry run), then `repair --plan <file> --execute --server-stopped`.
**Expected:** The dry run writes nothing. The execute removes answers, then generation counters, then the forget mark, and keeps `budget:` and `emb:` keys. A prefix above 1000000 keys refuses with nothing removed. `<plan>.result.json` shows `repaired` against `listed`.
**Why human:** Real SCAN and UNLINK cost and behavior at production counts cannot be exercised by a unit test.

### 3. Live GreptimeDB lease comparison in a busy window

**Test:** Live `queryEvents` for claim, warning and note kinds in a busy window.
**Expected:** The lease comparison completes, or reports `truncated` when a node exceeds `LOOKUP_LIMIT` (100) rows or the lookup count passes the cap of 200.
**Why human:** Needs a live ledger with real volume.

### 4. Live CLI run with real stores

**Test:** Live PG, GreptimeDB and Dragonfly: `report`; `repair --plan <file> --execute` without `--server-stopped`; a dry run; `repair --plan <file> --execute --server-stopped`.
**Expected:** Exit codes match `docs/reconcile.md`: report 0 or 1, usage and missing config 2, refused or failed repair 1. Missing `--server-stopped` exits 2 before any connection. The result file holds `executed`, `refused`, `repaired`, `listed` and `error`.
**Why human:** Needs live stores.

## Gaps Summary

No gaps. Both success criteria hold at HEAD `357d6b15` in code and in named tests. The four items above are live-operator checks, not gaps.

## Commands run (targeted, read-only)

- `bun test` on `reconcile.test.ts`, `reconcile-read.test.ts`, `reconcile-repair.test.ts`, `reconcile-main.test.ts`, `reconcile-single-flight.test.ts`: 70 pass, 0 fail.
- `bun test packages/mcp-server/src/service.test.ts -t "reconcile|scheduled"`: 2 pass, 0 fail.
- Named checks: `service.test.ts` one-scheduled-tick (1 pass), `reconcile-read.test.ts` cache-off (1 pass).

---

_Verified: 2026-11-18T12:22:19Z_
_Verifier: Claude (gsd-verifier)_
