---
phase: 17-event-vocabulary-and-audit-policy
plan: 17-03
subsystem: events
tags: [event-vocabulary, phase-close, smoke, rehearsal, bun-test]

# Dependency graph
requires:
  - phase: 17-01
    provides: EVENT_SOURCES table, vocabulary lock tests, and substrate surface the gate and smoke verify
  - phase: 17-02
    provides: policy.test.ts, the fourth lock file in the gate's set
  - phase: 16
    provides: rehearsal harness contract the sample-emit proof runs against
provides:
  - Phase-close gate (`check:phase-close`) proving EVENT_KINDS unchanged and SURFACES equals baseline plus substrate
  - Vocabulary smoke (`smoke:vocabulary`) posting one sample per EVENT_SOURCES row with zero refusals
  - Recorded isolated proof: 27/27 stored, 0 refusals, 27/27 read back, gate exit 0, clean teardown
affects: [phase-18-through-33, every later phase runs check:phase-close]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
# Same estimateTokens scale (chars/4 over the realized diff), never a harness token count.
actuals:
  tokens: 5200
  tasks: 3
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns: [pure-core thin-CLI scripts with import.meta.main guard, consumer.env-only HTTP smoke with pre-request refusal, baseline-diff gate over lock tests]

key-files:
  created: [scripts/phase-close-check.ts, scripts/phase-close-check.test.ts, scripts/vocabulary-smoke.ts, scripts/vocabulary-smoke.test.ts]
  modified: [package.json]

key-decisions:
  - "Gate compares the imported EVENT_KINDS/SURFACES against git show ab62c91, printing index-level diff lines; missingFiles runs before the Bun spawn to close the exit-0-on-missing trap"
  - "Smoke holds the bearer in a short local, prints ids/counts/statuses only, and run-tags every sample rh-vocab-<epoch> with per-entry session ids under 512 chars"
  - "Proof ran on the default harness instance (--name p17 --port 0) with the default claude-code-first token via body-first attribution; no --surfaces flag needed"

patterns-established:
  - "Exit codes 0 pass / 1 check failed / 2 precondition refused across both scripts, matching the repo convention"
  - "Refusal guards (refuseTarget, refuseSmokeUrl shape) run before any request; no default URL, no process.env URL or token"

requirements-completed: [FOUND-02]

# Coverage metadata (#1602) — one entry per shipped deliverable. Drives DETERMINISTIC UAT routing in verify-work.
coverage:
  - id: D1
    description: "check:phase-close exits 0 on this phase, 2 on a missing lock file or absent baseline, 1 on any EVENT_KINDS/SURFACES change"
    requirement: "FOUND-02"
    verification:
      - kind: unit
        ref: "scripts/phase-close-check.test.ts"
        status: pass
      - kind: integration
        ref: "bun run check:phase-close exits 0 with the four-file pass report"
        status: pass
    human_judgment: false
  - id: D2
    description: "One sample per EVENT_SOURCES row stored over the wire with zero refusals and read back 27/27 through events/query"
    requirement: "FOUND-02"
    verification:
      - kind: unit
        ref: "scripts/vocabulary-smoke.test.ts"
        status: pass
      - kind: integration
        ref: "bun run smoke:vocabulary --name p17: stored 27/27, refusals 0, read back 27/27"
        status: pass
    human_judgment: false
  - id: D3
    description: "Both package.json scripts resolve and teardown leaves no rehearsal container or run dir"
    requirement: "FOUND-02"
    verification:
      - kind: integration
        ref: "bun run rehearsal down --name p17 plus empty label-filtered docker ps and gone run dir"
        status: pass
    human_judgment: false

# Metrics
duration: 25min
completed: 2026-10-08
status: complete
---

# Phase 17 Plan 03: Phase-Close Gate and Sample-Emit Proof Summary

**Phase-close gate proving the locked vocabulary against the v1.2 baseline plus a run-tagged smoke posting all 27 mapped samples over the wire with zero refusals, recorded against an isolated harness.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-10-08T23:30Z (approx)
- **Completed:** 2026-10-08T23:53:26Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- `scripts/phase-close-check.ts` gates the vocabulary: runs the four lock tests, diffs `EVENT_KINDS` against `git show ab62c91`, requires `SURFACES` to equal baseline plus `substrate`, exits 0/1/2 per the documented contract
- `scripts/vocabulary-smoke.ts` proves the mapping over the wire: consumer.env-only client, production-port and non-loopback refusal before any request, run-tagged posts of every `EVENT_SOURCES` sample with `events/query` readback
- Isolated proof recorded: 27/27 stored with 202, 0 refusals, 27/27 read back, `check:phase-close` exit 0 in the same run, teardown removed 2 containers and the run dir
- Both `package.json` scripts (`smoke:vocabulary`, `check:phase-close`) resolve; `bunx tsc --noEmit` clean; `store-lock.test.ts` green on the committed tree

## Task Commits

Each task was committed atomically:

1. **Task 1: Tracer: phase-close check with baseline diff over the locked tests** - `0d20741` (feat)
2. **Task 2: Vocabulary smoke script with guard tests plus package.json wiring** - `30b4b36` (feat)
3. **Task 3: Gated isolated proof against the Phase 16 harness** - no file change (proof run only; the `package.json` wiring it names landed in task 2)

**Plan metadata:** SUMMARY commit follows below.

## Files Created/Modified

- `scripts/phase-close-check.ts` - exports `BASELINE`, `LOCK_TESTS`, `parseEventKinds`, `parseSurfaces`, `diffKinds`, `diffSurfaces`, `missingFiles`, `main` behind `import.meta.main`; git is show-only with `--no-optional-locks`
- `scripts/phase-close-check.test.ts` - 14 pure-helper tests, no git, spawn or network
- `scripts/vocabulary-smoke.ts` - exports `parseConsumerEnv`, `refuseTarget`, `runTag`, `runSession`, async `main`; HTTP-only client reaching the ledger solely through the twin URL from consumer.env
- `scripts/vocabulary-smoke.test.ts` - 10 guard, parser and tag tests, no network
- `package.json` - two script entries added (`smoke:vocabulary`, `check:phase-close`); nothing else touched

## Proof Transcript

- `bun run rehearsal up --name p17 --port 0` — exit 0, twin on `http://127.0.0.1:42825` (ephemeral port)
- `bun run smoke:vocabulary --name p17` — exit 0; graph `rh-vocab-1791503590292`; 27/27 `ok` with status 202 (all 27 source ids, incl. the five `substrate` rows under the harness default token via body-first attribution); `stored 27/27, refusals 0`; `read back 27/27`; `28/28 checks passed`
- `bun run check:phase-close` — exit 0; 73 pass across the 4 lock files; `EVENT_KINDS unchanged at 12 against ab62c91; SURFACES equals baseline plus substrate at 27`
- `bun run rehearsal down --name p17` — exit 0 (`stopped pid 2822867, removed 2 containers`); `docker ps --filter label=substrate.rehearsal=p17` empty; run dir gone
- Targeted tests: `phase-close-check.test.ts` 14 pass, `vocabulary-smoke.test.ts` 10 pass, `store-lock.test.ts` 18 pass, `bunx tsc --noEmit` exit 0

## Decisions Made

- Followed the plan as specified; shape choices (pure-core thin-CLI, exit codes, `rh-vocab-<epoch>` tags, `include_payload` readback with bounded retry) used the plan's and research's recommendations verbatim.
- Task 3 needed no commit: the proof run changed no files, and the `package.json` entry it names already landed in task 2's commit.

## Deviations from Plan

None - plan executed exactly as written.

Three mid-execution repairs (not deviations — no plan content changed, no extra scope):

- The `SURFACES` regex matched `SWARM_SURFACES` first, dropping the non-swarm surfaces; anchored with a `(?<![A-Z_])` lookbehind (1 fail → 14 pass).
- A quote-escape test expectation doubled the unescaped quote (`a''b` vs the correct `a'b`); fixed the expectation, implementation untouched (1 fail → 10 pass).
- A temporary `zzz-probe` kind appended to `EVENT_KINDS` verified the exit-1 path live (lock tests failed → exit 1); reverted immediately, tree clean before commit.

## Failure-Mode Verification

- Missing lock file (moved `event-sources.test.ts` aside): exit 2 with `missing lock file` line; restored, tree clean.
- Appended kind (`zzz-probe`): exit 1. Note the run reaches exit 1 via the lock tests failing first — `vocabulary-lock.test.ts` pins the literal — so the index-level diff line prints only when the kinds differ while the lock tests pass (defense-in-depth ordering, e.g. a hand-edited lock file); `diffKinds` index-level lines themselves are unit-proven.
- Surfaces cases (substrate removed, extra surface added) are unit-proven in `diffSurfaces` tests; no live mutation was needed.

## Threat Flags

None - no new network endpoints, auth paths, file access patterns, or schema changes beyond the plan's threat register. The smoke aims only at the named instance's consumer.env URL after the loopback and production-port guard; the bearer is held in a short local and never printed; git is show-only; `store-lock.test.ts` (18 pass) covers all new scripts.

## Issues Encountered

None. The harness ran first try (`up` exit 0 in ~4 s); the smoke passed first try with zero refusals.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Every later phase (18-33) can run `bun run check:phase-close`; it passes here and fails closed on any kind/surface drift.
- FOUND-02 SC-2 (zero-refusal sample emits) and SC-3 (phase-close check passing and documented in `docs/event-vocabulary.md`) are met.
- STATE.md / ROADMAP.md / REQUIREMENTS.md bookkeeping is the orchestrator's; this plan does not edit them (per 17-CONTEXT.md).

## Self-Check: PASSED

All 5 artifacts found on disk; both task commits (`0d20741`, `30b4b36`) present in history; `git status` clean except the new SUMMARY file.

---
*Phase: 17-event-vocabulary-and-audit-policy*
*Completed: 2026-10-08*
