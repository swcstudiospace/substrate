---
phase: 18-guard-rails-and-shared-redactor
plan: "18-04"
subsystem: security
tags: [redaction, docs, rehearsal, bun-test, laneb-06]

# Dependency graph
requires:
  - 18-01-labelled-RULES-table
  - 18-02-skill-engine
  - 18-03-redaction-lock
provides:
  - docs/redaction.md topic doc with the two-column rule table, counter exemption, findings versus redactions, lock rules and allowlist, new-package and new-rule guides, D18-21 deviation, verbatim-port gaps and pre-restart rows
  - gated rehearsal round-trip describe in redact.test.ts proving D-04 fixtures do not survive the twin write path while counts do
affects: [skills_propose-21, docs_ingest-25, collectors-19, phase-19-hook]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 3900
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns: ["describe gated on SUBSTRATE_REHEARSAL_NAME with twin guard before any request", "runtime guards over unknown JSON bodies instead of inline casts in tests"]
key-files:
  created: [docs/redaction.md]
  modified: [docs/greptime-ledger.md, docs/memory-governance.md, docs/observability.md, packages/mcp-server/src/redact.test.ts]

key-decisions:
  - "Round trip reads back through POST /events/query, the REST door to the same events_query service call as the MCP tool, so the two cannot drift"
  - "Test response bodies are narrowed with typeof/in guards to satisfy the repo ts-no-inline-cast-access rule; no Phase 16 module is imported and no store key is named"

patterns-established:
  - "Gated harness proof: SUBSTRATE_REHEARSAL_NAME-gated describe, loopback plus not-7410 assertions first, run-tagged session id, only consumer.env sourced, only the one test file run"
  - "Results never carry the value: round-trip assertions name counts and the REDACTED marker, never a fixture secret"

requirements-completed: [LANEB-06]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "docs/redaction.md topic doc with pointers from greptime-ledger, memory-governance and observability"
    requirement: "LANEB-06"
    verification:
      - kind: unit
        ref: "packages/mcp-server/src/store-lock.test.ts#no tracked file carries a Greptime endpoint or credential"
        status: pass
    human_judgment: false
  - id: D2
    description: "Gated harness round trip proving D-04 fixtures do not survive the twin write path while counts do"
    requirement: "LANEB-06"
    verification:
      - kind: integration
        ref: "packages/mcp-server/src/redact.test.ts#harness round trip through the rehearsal twin"
        status: pass
    human_judgment: false

# Metrics
duration: ~45min
completed: 2026-10-09
status: complete
---

# Phase 18 Plan 18-04: Docs and Harness Proof Summary

**The shared redactor is documented for its future consumers and proven isolated: a new topic doc with three pointers, and a harness round trip through the rehearsal twin showing D-04 secrets redacted and counts intact.**

Redaction widens on the production write path at the operator's next approved restart of `substrate-mcp`; nothing restarts in this PR.

## Performance

- **Duration:** ~45 min
- **Started:** 2026-10-09T00:10:00Z
- **Completed:** 2026-10-09T00:55:00Z
- **Tasks:** 2
- **Files modified:** 5 (1 created, 4 modified)

## Accomplishments

- `docs/redaction.md` (new): the two-column rule table (30 event names, skill families, the `keypair-array` exclusion), the counter exemption, findings versus redactions, the lock's five rules plus the injected-seam allowlist with the cycle reason and the dormant `trace.ts` describe seam, how a new package redacts, how to add a rule, the `pk-rk` digit-required deviation (D18-21, operator 2026-10-08) with its rationale, the verbatim-port gaps, and the pre-restart rows
- Three pointers at their anchors with relative links: `greptime-ledger.md` (named rules and D-04 classes), `memory-governance.md` (rules plus the `<private>`/D-04 quarantine-as-`secret` sentence), `observability.md` (counter-exemption pointer)
- Gated round-trip describe in `redact.test.ts`: skipped without `SUBSTRATE_REHEARSAL_NAME`; under the twin it posts one note event carrying every D-04 fixture plus `input_tokens`/`output_tokens` counts, reads back through `events_query`, and asserts no fixture secret survives while the counts do
- Round-trip evidence: instance `p18` on loopback `127.0.0.1:36061`; gated file run 174 pass / 0 fail (the gated test ran, nothing skipped); `rehearsal down` removed both containers and `status` reports no instance
- Full suite 1395 pass / 57 skip / 1 fail with `bunx tsc --noEmit` clean — the delta from 1395/56/1 after 18-03 is exactly the new gated describe skipping without env; the 1 fail is the HEAD-present store-lock flag on `18-PATTERNS.md`, recorded not fixed

## Task Commits

Each task was committed atomically:

1. **Task 1: Redaction topic doc and three pointers** - `66306e0` (docs)
2. **Task 2: Gated harness round trip, full suite and live-effect line** - `da24a6d` (test)

## Files Created/Modified

- `docs/redaction.md` - new topic doc (ownership, rule table, exemption, findings, lock, guides, deviation, gaps, pre-restart)
- `docs/greptime-ledger.md` - pointer to the named rules and D-04 classes at the redaction paragraph
- `docs/memory-governance.md` - pointer plus the quarantine-as-`secret` sentence at the secret prose
- `docs/observability.md` - counter-exemption pointer at the bug blockquote
- `packages/mcp-server/src/redact.test.ts` - gated round-trip describe (79 added lines)

## Decisions Made

- The read-back goes through `POST /events/query`, the REST door to the same `queryEvents` service call as the MCP `events_query` tool, so the two cannot drift — no MCP JSON-RPC framing needed in the test.
- Test response bodies are narrowed with `typeof`/`in` guards rather than inline casts, per the repo `ts-no-inline-cast-access` rule; no Phase 16 module is imported and no store key is named.
- No CHANGELOG entry: the repo has no CHANGELOG file at execution time, and none was created.

## Deviations from Plan

None - plan executed exactly as written.

The plan's stated baseline (1129 pass / 56 skip / 0 fail) is the pre-phase-18 branch-base figure, stale after waves 1–3. Comparison was made against the actual post-18-03 numbers (1395/56/1) with the delta explained above, per the run rules — a clarification, not a scope change.

## Issues Encountered

- The file-edit tool resolves the patch header path against its own working directory, so the first three pointer edits landed in the operator checkout (`/root/src/repos/agent-substrate`) instead of the worktree. Caught immediately via `git status`: reverted byte-clean with `git checkout --` (verified clean afterwards) and re-applied with absolute patch-header paths. No committed state was ever affected; the worktree diff holds exactly the four intended doc changes.
- The appended test first read response bodies with inline casts; the repo `ts-no-inline-cast-access` rule fired. Rewrote to `unknown` plus `typeof`/`in` narrowing inside the same task commit — no separate commit, no behavior change.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- LANEB-06 is complete with this plan: topic doc, lock, corpus, and twin proof all green. Phases 19/21/22/25/28 inherit the shared module under the lock with no exemptions.
- The twin images used (`postgres:16-alpine`, `greptime/greptimedb:v0.14.4`) and the run-tag convention (`rh-p18-<ts>`) are recorded above for later proofs to reuse.
- No blockers. The HEAD-present store-lock failure (`18-PATTERNS.md`) predates this phase and is untouched.

## Verification Record

- `bun test packages/mcp-server/src/redact.test.ts packages/mcp-server/src/redact-lock.test.ts` — 186 pass / 1 skip / 0 fail (skip is the gated round trip without env)
- `bun test packages/mcp-server/src/store-lock.test.ts` — 17 pass / 1 fail; sole offender is the pre-existing `18-PATTERNS.md`, no new offender from touched docs
- Gated file under twin (`consumer.env` sourced, this file only) — 174 pass / 0 fail
- Full `bun test` without rehearsal env — 1395 pass / 57 skip / 1 fail (pre-existing fail only)
- `bunx tsc --noEmit` — clean

## PR body

```
Document the shared redactor and prove the phase isolated (LANEB-06).

- New docs/redaction.md: rule table, counter exemption, findings versus
  redactions, lock rules and allowlist, new-package and new-rule guides,
  the D18-21 pk-rk deviation, verbatim-port gaps, pre-restart rows; pointers
  from greptime-ledger, memory-governance and observability.
- Harness round trip on instance p18 (loopback twin): D-04 fixtures posted
  through the write path come back redacted while input_tokens/output_tokens
  counts survive; gated file run 174 pass / 0 fail, twin torn down after.
- Full suite 1395 pass / 57 skip / 1 fail (the 1 fail is the HEAD-present
  store-lock flag on 18-PATTERNS.md, recorded not fixed); tsc clean.

Redaction widens on the production write path at the operator's next approved restart of `substrate-mcp`; nothing restarts in this PR.
```

## Self-Check: PASSED

- All five touched files plus the SUMMARY exist on disk.
- Task commits `66306e0`, `da24a6d` verified in `git log`.
- Targeted suites: `redact` + `redact-lock` 186 pass / 1 skip / 0 fail; `store-lock` 17 pass / 1 pre-existing fail with the offender unchanged; gated twin run 174 pass / 0 fail with `down` confirmed (no instance, no p18 containers); full suite 1395/57/1; `tsc` clean.
- `redact.test.ts` and `redact-lock.test.ts` named in the verification record above; `store-lock.test.ts` shows no new offender from touched docs.
---
*Phase: 18-guard-rails-and-shared-redactor*
*Completed: 2026-10-09*
