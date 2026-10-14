---
phase: 17-event-vocabulary-and-audit-policy
plan: 17-01
subsystem: events
tags: [event-vocabulary, surfaces, substrate, normalizeEvent, bun-test]

# Dependency graph
requires:
  - phase: 16
    provides: rehearsal harness contract the sample-emit proof will run against (Phase 17 wave 2)
provides:
  - Closed event vocabulary lock (12 kinds, 27 surfaces with substrate last) in plain bun test
  - Typed EVENT_SOURCES table (27 rows) plus SILENT_SOURCES (7 rows) with write-path-proof samples
  - substrate token binding in attributedSurface, proven on /events and in unit tests
  - Reviewed docs/event-vocabulary.md drift-locked to the table by test
affects: [phase-19-collectors, phase-21-skills-propose, phase-22-skills-sync, phase-23-claim-mirror, phase-24-dispatcher, phase-25-docs-plane, phase-26-memory, phase-28-anchor, phase-29-teachables, phase-30-desktop, phase-32-lane-a, phase-33-approvals, 17-03-phase-close-check]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
# Same estimateTokens scale (chars/4 over the realized diff), never a harness token count.
actuals:
  tokens: 10500
  tasks: 3
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns: [typed source-to-enum mapping table with normalizeEvent round-trip proof, ordered-literal vocabulary lock, marked-table doc-vs-code drift test]

key-files:
  created: [packages/mcp-server/src/event-sources.ts, packages/mcp-server/src/event-sources.test.ts, packages/mcp-server/src/vocabulary-lock.test.ts, docs/event-vocabulary.md]
  modified: [packages/mcp-server/src/types.ts, packages/mcp-server/src/mcp.ts, packages/mcp-server/src/authority.test.ts, .env.example]

key-decisions:
  - "Host-job rows use fixed substrate with payload.runtime naming the job; no job-token SurfaceRule variant (operator 2026-10-08)"
  - "substrate token bound to its surface exactly like a swarm token in attributedSurface"
  - "Silent sources encoded as SILENT_SOURCES with em-dash kind/action cells in the marked doc table"

patterns-established:
  - "Every EVENT_SOURCES sample survives normalizeEvent unchanged in kind, surface and payload (deep-equal)"
  - "Doc-vs-table drift test parses the marked Markdown table and asserts identical id sets plus per-row kind/action equality"
  - "Roadmap-prefix coverage loop plus repo rule (no periodic row carries repo) plus no-content-key rule over samples"

requirements-completed: [FOUND-02]

# Coverage metadata (#1602) — one entry per shipped deliverable. Drives DETERMINISTIC UAT routing in verify-work.
coverage:
  - id: D1
    description: "Closed vocabulary lock pins the exact 12 EVENT_KINDS and 27 SURFACES (substrate last) in order"
    requirement: "FOUND-02"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/vocabulary-lock.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every EVENT_SOURCES sample passes normalizeEvent unchanged; roadmap coverage, repo rule and no-content rule hold"
    requirement: "FOUND-02"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/event-sources.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "substrate token resolves to substrate, emits as substrate, and is refused emitting as any other surface on /events and via attributedSurface"
    requirement: "FOUND-02"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/authority.test.ts#POST /events: the substrate token stores as itself"
        status: pass
    human_judgment: false
  - id: D4
    description: "docs/event-vocabulary.md marked table names the same ids, kinds and actions as EVENT_SOURCES plus SILENT_SOURCES"
    requirement: "FOUND-02"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/event-sources.test.ts#docs/event-vocabulary.md equals the table"
        status: pass
    human_judgment: false

# Metrics
duration: 12min
completed: 2026-10-08
status: complete
---

# Phase 17 Plan 01: Event Vocabulary and Audit Table Summary

**Closed event vocabulary locked: `substrate` surface appended (27 total, kinds unchanged at 12), 27-row typed `EVENT_SOURCES` table with write-path-proof samples, `substrate` token binding, and a drift-locked mapping document.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-10-08T23:24:52Z
- **Completed:** 2026-10-08T23:37:01Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- `SURFACES` gains exactly one reviewed system surface, `substrate`, last (27 total); `EVENT_KINDS` unchanged at 12, both pinned by ordered-literal lock tests
- `EVENT_SOURCES` holds all 27 v1.3 rows (each one kind plus one sample; host-job rows on fixed `substrate`) and `SILENT_SOURCES` covers 7 deliberate non-emitters; every sample survives `normalizeEvent` unchanged
- `attributedSurface` binds a `substrate` caller to its own surface like a swarm token; binding proven own-surface-stores / cross-surface-refused on `POST /events` and in unit tests, with body-first attribution preserved for all other non-swarm callers
- `docs/event-vocabulary.md` reviewed mapping document with the machine-checked marked table; drift test proven to fail on a single mutated kind cell

## Task Commits

Each task was committed atomically:

1. **Task 1: Tracer: substrate surface plus EVENT_SOURCES skeleton with six Phase-19 rows plus the literal lock** - `5d76920` (feat)
2. **Task 2: Expand EVENT_SOURCES to the full inventory with coverage, repo, no-content and substrate-binding tests** - `cab4932` (feat)
3. **Task 3: Write docs/event-vocabulary.md and the doc-vs-table drift test** - `fae0e55` (docs)

**Plan metadata:** SUMMARY commit follows below.

## Files Created/Modified

- `packages/mcp-server/src/event-sources.ts` - `SurfaceRule` (no job-token variant), `EventSource`, `EVENT_SOURCES` (27 rows), `SILENT_SOURCES` (7 rows); imports only `./types.ts`
- `packages/mcp-server/src/event-sources.test.ts` - round-trip, doc-equality, coverage, repo-rule, no-content tests (39 tests)
- `packages/mcp-server/src/vocabulary-lock.test.ts` - ordered-literal pins of 12 kinds and 27 surfaces
- `docs/event-vocabulary.md` - reviewed mapping: rules, marked table, silent sources, unverified herdr table, deferred producers, host-job decision, Lane A note, phase-close check
- `packages/mcp-server/src/types.ts` - `substrate` appended as final SURFACES element
- `packages/mcp-server/src/mcp.ts` - `attributedSurface` binds `substrate` callers to their own surface
- `packages/mcp-server/src/authority.test.ts` - 27-surface pin, substrate token resolution, binding tests incl. `POST /events`
- `.env.example` - blank `SUBSTRATE_TOKEN_SUBSTRATE=` line beside the swarm token lines

## Decisions Made

- Followed the plan as specified; no new decisions. All shape choices (field names, session-id formats, marked-table parse) used the plan's and research's recommendations verbatim.

## Deviations from Plan

None - plan executed exactly as written.

Two mid-execution repairs (not deviations — no plan content changed, no extra scope):

- An `Edit` insert landed mid-row in `event-sources.ts` during expansion; repaired the two seams and verified `tsc` clean before proceeding.
- A drift-proof mutation edit hit a rules-section line instead of the intended table row; reverted immediately, then mutated the correct row, observed the expected 1-fail result, and reverted.

## Issues Encountered

None. Targeted verifications: `vocabulary-lock.test.ts` 2 pass, `event-sources.test.ts` 39 pass, `authority.test.ts` 35 pass, `bunx tsc --noEmit` clean, neighboring `mcp.test.ts` (53 pass) and `server.authority.test.ts` (21 pass) unaffected, `store-lock.test.ts` (18 pass) green on the committed tree.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phases 19-33 can implement against `EVENT_SOURCES`; the contract is typed, tested and documented.
- Plan 17-03 builds the phase-close check (`check:phase-close`) on top of the lock tests created here.
- Plan 17-02 (audit policy) is untouched: no files under `packages/audit/`, `docs/mcp-audit.md` or `docs/swarm-correlation.md` were modified.
- STATE.md / ROADMAP.md bookkeeping is the orchestrator's; this phase does not edit them (per 17-CONTEXT.md).

## Self-Check: PASSED

All 8 artifacts found on disk; all 3 task commits (`5d76920`, `cab4932`, `fae0e55`) present in history.

---
*Phase: 17-event-vocabulary-and-audit-policy*
*Completed: 2026-10-08*
