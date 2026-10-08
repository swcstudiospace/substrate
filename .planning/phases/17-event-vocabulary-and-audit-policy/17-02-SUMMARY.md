---
phase: 17-event-vocabulary-and-audit-policy
plan: 17-02
subsystem: audit
tags: [audit-policy, fail-open, fail-closed, auditMode, bun-test, scan-guard]

# Dependency graph
requires:
  - phase: 16
    provides: nothing direct; audit policy is independent of the rehearsal harness
provides:
  - Eight planned v1.3 tools encoded in their decided audit sets with Phase 17 comments
  - Independent PLANNED_V13 literal test pinning each planned mode
  - Served-name scan guard failing any registration without an audit decision
  - Audit docs naming all planned tools by phase with reasons, linked to event-vocabulary.md
affects: [phase-21-skills-propose, phase-23-claim-mirror, phase-25-docs-plane, phase-26-memory, phase-29-teachables, phase-30-desktop, 17-03-phase-close-check]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
# Same estimateTokens scale (chars/4 over the realized diff), never a harness token count.
actuals:
  tokens: 2400
  tasks: 2
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns: [independent literal table pinning a policy set from the test side, served-name scan guard over registration call sites]

key-files:
  created: [.planning/phases/17-event-vocabulary-and-audit-policy/17-02-SUMMARY.md]
  modified: [packages/audit/src/policy.ts, packages/audit/src/policy.test.ts, docs/mcp-audit.md, docs/swarm-correlation.md]

key-decisions:
  - "Scan guard asserts membership only, never exact counts, so a later phase adding a decided registration stays green"
  - "Planned tools documented in a dedicated Planned in v1.3 sub-table rather than merged into the served rows"
  - "Index-access casts use the file's existing `as string` idiom to satisfy noUncheckedIndexedAccess"

patterns-established:
  - "Every audit decision is pinned from both sides: the policy set carries the name, an independent test literal carries the mode"
  - "Registration call sites (registerTool, auditedRest) are scanned as text with whitespace-tolerant patterns; the undecided list is the failure message"

requirements-completed: [FOUND-02]

# Coverage metadata (#1602) — one entry per shipped deliverable. Drives DETERMINISTIC UAT routing in verify-work.
coverage:
  - id: D1
    description: "Eight planned v1.3 tools in their decided sets with auditMode returning the decided mode; removing or flipping any entry fails the suite"
    requirement: "FOUND-02"
    verification:
      - kind: unit
        ref: "packages/audit/src/policy.test.ts#the v1.3 planned tools are explicitly in their decided set"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every served registerTool and auditedRest name sits in exactly one audit set; a later undecided registration fails the suite"
    requirement: "FOUND-02"
    verification:
      - kind: unit
        ref: "packages/audit/src/policy.test.ts#every served tool and REST route has an explicit audit decision"
        status: pass
    human_judgment: false
  - id: D3
    description: "Audit docs record all eight planned tools by phase with reasons, link event-vocabulary.md, and state REST-twin inheritance"
    requirement: "FOUND-02"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/store-lock.test.ts"
        status: pass
    human_judgment: false

# Metrics
duration: 45min
completed: 2026-10-08
status: complete
---

# Phase 17 Plan 02: Audit Policy Summary

**Fail-open or fail-closed decided for all eight planned v1.3 tools, pinned by an independent test literal and a served-name scan guard, with docs updated.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-10-08T20:00Z
- **Completed:** 2026-10-08T20:45Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- `packages/audit/src/policy.ts` gains the eight planned entries: `skills_propose` (21), `docs_ingest` (25), `desktop_run` (30) fail-closed; `docs_search` (25), `issue_get` (23), `graph_find` (23), `memory_recall` (26), `agent_card` (29) fail-open. `auditMode` default-deny untouched.
- `policy.test.ts` gains the independent `PLANNED_V13` literal plus explicit-membership test, and a scan guard extracting all 19 `registerTool` and 8 `auditedRest` names and requiring each in exactly one set.
- `docs/mcp-audit.md` gains the Planned in v1.3 sub-table with per-tool Why, the reworded exhaustive sentence, the `event-vocabulary.md` link, and the REST-twin inheritance note. `docs/swarm-correlation.md` links the vocabulary doc.

## Task Commits

Each task was committed atomically:

1. **Task 1: Tracer: planned v1.3 entries in policy.ts with the independent mode test** - `c5587fc` (feat)
2. **Task 2: Audit docs update plus the served-name scan guard** - `55818c1` (docs)

**Plan metadata:** SUMMARY commit follows below.

## Files Created/Modified

- `packages/audit/src/policy.ts` - Eight planned names appended under Phase 17 comments; docblock exhaustive sentence reworded; `auditMode` unchanged
- `packages/audit/src/policy.test.ts` - `PLANNED_V13` literal, explicit-membership test, served-name scan guard; existing tests untouched
- `docs/mcp-audit.md` - Planned in v1.3 sub-table, reworded exhaustive sentence, vocabulary link, REST-twin note
- `docs/swarm-correlation.md` - One link sentence in the closed-enum section

## Decisions Made

- Scan guard asserts set membership only, never exact registration counts: a later phase that registers a planned tool (already decided in its set) stays green; only an undecided name fails.
- Planned tools documented in a dedicated sub-table rather than merged into the served rows, keeping served vs planned visibly distinct.
- Index-access casts follow the file's existing `as string` idiom (as in the REST-route test) to satisfy `noUncheckedIndexedAccess`.

## Deviations from Plan

None - plan executed exactly as written.

## Threat Flags

None - no new network endpoints, auth paths, file access patterns, or schema changes. The scan guard reads two source files as text at test time only.

## Self-Check: PASSED

- `packages/audit/src/policy.ts`, `packages/audit/src/policy.test.ts`, `docs/mcp-audit.md`, `docs/swarm-correlation.md` all FOUND on disk.
- Commits `c5587fc` and `55818c1` both present in `git log`.
- Targeted verification: `bun test ./packages/audit/src/policy.test.ts` 14 pass 0 fail; `bun test ./packages/mcp-server/src/store-lock.test.ts` 18 pass 0 fail; `bunx tsc --noEmit` exit 0.
- No stub patterns introduced (no empty literals, placeholders, TODOs in touched files).
- No secrets in any touched file (store-lock green covers this).

## Issues Encountered

- **Edit-tool path resolution:** the first `edit` call used a relative patch header that resolved against the operator checkout (`/root/src/repos/agent-substrate`) instead of the worktree. Detected via `git status` showing a clean worktree, reverted the stray edit with `git checkout --` in the operator checkout (verified clean afterwards), and used the absolute `~/src/worktrees/...` header form from `read` output for all subsequent edits. No operator-checkout content was left modified.
- **tsc `noUncheckedIndexedAccess`:** the scan guard's `m[1]` maps failed type-check; fixed with the file's existing `as string` cast idiom. Caught by the plan's own `tsc --noEmit` verification step.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phases 21, 23, 25, 26, 29, 30 can register their tools inheriting the decided modes; any registration under a new name fails `policy.test.ts` until its decision is added.
- Ready for 17-03 (phase-close check), which runs `policy.test.ts` as part of its gate.

---
*Phase: 17-event-vocabulary-and-audit-policy*
*Completed: 2026-10-08*
