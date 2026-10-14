---
phase: 27-ledger-primitives-and-ingest-order
plan: "01"
subsystem: ledger
tags: [merkle, rfc6962, solana, greptime, anchoring, workspace]

# Dependency graph
requires:
  - phase: 16-harness
    provides: rehearsal harness (scripts/rehearsal.ts, rehearsal-env.ts, stores.env) the scratch proof builds on
  - phase: 18-redactor
    provides: redact-lock.test.ts the ported files must keep green
provides:
  - Five byte-identical ledger primitives (merkle, memo, period, rpc, solana) plus tests
  - packages/ledger/src/index.ts barrel re-exporting the public API only
  - @substrate/mcp-server → @substrate/ledger workspace wiring with lockfile entry
  - 27-BASELINE.md execution-base record and COVERAGE.md no-new-API declaration
  - One-line greptime.test.ts Wave 0 hardening (insertStatement picker)
affects: [27-02 (ingest record + DDL), 27-03 (hourDigest), 27-04 (scratch proof), phase-28 (first rpc/solana caller)]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 10300    # chars/4 over the realized diff (4756b51..HEAD incl. summary)
  tasks: 3         # tasks completed
  commits: 4       # 3 task commits + 1 summary commit

# Tech tracking
tech-stack:
  added: []
  patterns: [byte-identical port with cmp proof, audit-barrel re-export style, workspace:* local link]

key-files:
  created: [packages/ledger/src/merkle.ts, packages/ledger/src/memo.ts, packages/ledger/src/period.ts, packages/ledger/src/rpc.ts, packages/ledger/src/solana.ts, packages/ledger/src/merkle.test.ts, packages/ledger/src/memo.test.ts, packages/ledger/src/period.test.ts, packages/ledger/src/rpc.test.ts, packages/ledger/src/solana.test.ts, packages/ledger/src/index.ts, .planning/phases/27-ledger-primitives-and-ingest-order/27-BASELINE.md, .planning/phases/27-ledger-primitives-and-ingest-order/COVERAGE.md]
  modified: [packages/mcp-server/package.json, bun.lock, packages/mcp-server/src/greptime.test.ts]

key-decisions:
  - "Port dropped in with zero edits: cmp proves byte-identity, tsc clean under strict plus noUncheckedIndexedAccess"
  - "index.ts header phrased without GREPTIME_ and without naming agent_events, keeping the store-lock regex green"
  - "INGEST_LAG_MS left for plan 02 (greptime.ts), keeping period.ts byte-identical"

patterns-established:
  - "Port proof: git show acc30a8:<path> redirection plus per-file cmp, recorded in the summary"
  - "Barrel style: one grouped export block per module, types inline as `type X`, mirroring packages/audit/src/index.ts"

requirements-completed: [ANCHOR-02]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Five ledger modules and five tests ported byte-identical from acc30a8"
    requirement: "ANCHOR-02"
    verification:
      - kind: unit
        ref: "bun test packages/ledger (45 pass / 0 fail)"
        status: pass
      - kind: other
        ref: "cmp per file against git show acc30a8:<path> (10/10 identical)"
        status: pass
    human_judgment: false
  - id: D2
    description: "index.ts barrel re-exporting the public API of the five modules and nothing else"
    requirement: "ANCHOR-02"
    verification:
      - kind: other
        ref: "bunx tsc --noEmit clean"
        status: pass
    human_judgment: false
  - id: D3
    description: "mcp-server workspace dependency on @substrate/ledger resolving via node_modules symlink"
    requirement: "ANCHOR-02"
    verification:
      - kind: other
        ref: "bun install one-line bun.lock change; packages/mcp-server/node_modules/@substrate/ledger symlink present"
        status: pass
    human_judgment: false
  - id: D4
    description: "Wave 0 greptime.test.ts one-line picker fix; greptime + store-lock + redact-lock green"
    requirement: "ANCHOR-02"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/greptime.test.ts (59 pass), store-lock.test.ts (18 pass), redact-lock.test.ts + ledger (60 pass)"
        status: pass
    human_judgment: false

# Metrics
duration: 25min
completed: 2026-10-09
status: complete
---

# Phase 27 Plan 01: Ledger primitives port Summary

**Five September ledger modules ported byte-identical with cmp proof, audit-style barrel, workspace wiring, baseline record, and the Wave 0 test fix — 45 ported tests green, tsc clean**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-10-09T05:30Z
- **Completed:** 2026-10-09T05:55Z
- **Tasks:** 3
- **Files modified:** 16 (11 created ledger sources/tests + barrel, 2 planning docs, 3 modified)

## Accomplishments

- Ten files ported from `acc30a8` with `git show` redirection; `cmp` proves all ten byte-identical (see table below)
- `packages/ledger/src/index.ts` barrel re-exports the public API of the five modules and nothing else, in the `packages/audit/src/index.ts` grouped style
- `@substrate/mcp-server` gains `"@substrate/ledger": "workspace:*"` (alphabetical) plus the one-line `bun.lock` entry; the `node_modules/@substrate/ledger` symlink resolves
- `27-BASELINE.md` records all prerequisites present plus the dispatch base numbers; `COVERAGE.md` declares no new external API surface
- `greptime.test.ts:293` now picks the INSERT via the existing `insertStatement(sql)` helper, surviving plan 02's second INSERT

## Task Commits

Each task was committed atomically:

1. **Task 1: Verify the execution base and record baseline numbers** - `651a16b` (docs)
2. **Task 2: Port the five ledger modules, add the barrel, wire the workspace** - `ac74e7a` (feat)
3. **Task 3: Apply the Wave 0 test fix and declare API coverage** - `a02de3e` (test)

**Plan metadata:** summary commit recorded below after self-check.

## Byte-identity proof (T-27-01 mitigation)

`cmp <(git show acc30a8:packages/ledger/src/$f$s.ts) packages/ledger/src/$f$s.ts` — all pass:

| File | Result |
|---|---|
| merkle.ts / merkle.test.ts | IDENTICAL / IDENTICAL |
| memo.ts / memo.test.ts | IDENTICAL / IDENTICAL |
| period.ts / period.test.ts | IDENTICAL / IDENTICAL |
| rpc.ts / rpc.test.ts | IDENTICAL / IDENTICAL |
| solana.ts / solana.test.ts | IDENTICAL / IDENTICAL |

Zero compile-driven changes were needed (D27-01 clean port). No new dependency: imports are `./*.ts`, `node:child_process`, `node:path` and Bun globals only.

## Decisions Made

- `mkdir -p packages/ledger/src` before porting (`package.json` exists, `src/` did not) — the plan's loop assumes the dir; Rule 3 blocking fix, folded into the task commit.
- `index.ts` header states purity without `GREPTIME_` and without naming `agent_events`, because `store-lock.test.ts:119,127` scans comments too (PATTERNS safe wording adopted verbatim).
- `chain.ts` not ported anywhere: it lives at `acc30a8:packages/mcp-server/src/chain.ts`, not under `packages/ledger` (verified via `git ls-tree -r acc30a8`), per D27-03.

## Deviations from Plan

None - plan executed exactly as written (the `mkdir -p` is the plan's own port command precondition, not a deviation).

## Issues Encountered

- First port attempt failed: `packages/ledger/src/` did not exist so shell redirection failed. Fixed with `mkdir -p`, re-ran the loop, all ten files landed and `cmp` passed.

## Unverified claims and threat notes (per D27-06, T-27-02)

- **Memo program-ID claim unverified:** `memo.ts:11` says solana-cli 4.2.2 writes `Memo4c2p…` with no `[UNVERIFIED]` marker. Per D27-06 the file is NOT edited (byte-identity wins); the claim stays unverified here. Phase 28's devnet transaction is the first chance to check it.
- **T-27-02 for Phase 28:** `solana.ts`/`rpc.ts` error text has no caller in this phase. Phase 28 must pass quoted output through `redact` before storing.
- **T-27-SC:** no registry package installed; only the local workspace link plus its one-line lockfile entry.

## Stub scan

No stubs: no `=[]`/`={}`/`=null`/`TODO`/`FIXME`/`placeholder` introduced; `index.ts` re-exports live bindings only. The memo never carries event content (only `period_start`, `root`, `count` per `MEMO_RE`); `agent_events` untouched; no ingest record written (no caller yet).

## Verification (plan §verification, each on its own invocation)

- `bun test packages/ledger` — 45 pass / 0 fail (105 expects, 5 files)
- `bun test packages/mcp-server/src/greptime.test.ts` — 59 pass / 0 fail
- `bun test packages/mcp-server/src/store-lock.test.ts` — 18 pass / 0 fail
- Extra: `bun test packages/mcp-server/src/redact-lock.test.ts packages/ledger` — 60 pass / 0 fail
- `bunx tsc --noEmit` — clean (exit 0), run after every task-affecting change
- Counts reconcile with 27-BASELINE.md: +45 ledger tests, no other suite delta. The known flaky `audit/log.test.ts` timing test was not in the targeted scope and is left for the orchestrator's full run.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plans 02-04 can import `merkleRootHex`, `formatMemo`, `hourStart`, `hourEnd`, `isClosed` from `@substrate/ledger` today.
- `rpc.ts`/`solana.ts` await their first caller in Phase 28.
- No blockers. STATE.md / ROADMAP.md deliberately untouched per dispatch (orchestrator owns them).

---
*Phase: 27-ledger-primitives-and-ingest-order, plan 01*
*Completed: 2026-10-09*

## Self-Check: PASSED

- All created files exist (10 ported files, index.ts, 27-BASELINE.md, COVERAGE.md, 27-01-SUMMARY.md).
- All task commits exist: 651a16b, ac74e7a, a02de3e.
