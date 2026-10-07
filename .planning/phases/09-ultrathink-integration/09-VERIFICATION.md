---
phase: 09-ultrathink-integration
verified: 2026-10-07T15:00:00Z
status: passed
score: 3/3 must-haves verified
---

# Phase 9 Verification: claude-ultrathink integration

Goal: a planned prompt leaves a Graph ID record in the ledger without ever affecting the hook.
Source: PR claude-ultrathink #19 (`feat/substrate-plan-event`, `9ef87a6` + `6b3a76f`).

## Success criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | A planned prompt yields one `note` event carrying the Graph ID and no prompt text | VERIFIED | `src/claude/hook.test.ts`, `src/substrate/brief.test.ts`; payload is Graph ID, host, repo slug, branch, node count only. Live S1 smoke: emitEvent client accepted, note stored under the same Graph ID. |
| 2 | Skipped prompts, unknown sessions and failed state writes emit nothing | VERIFIED | hook tests for skipped prompt, fallback spec, unknown session, failed state write. |
| 3 | A rejecting or absent substrate leaves the hook result identical | VERIFIED | hook tests with rejecting and throwing emitter; no URL / `SUBSTRATE_DISABLED=1` sends nothing; request bounded by planning budget + 1.5 s timeout. |

## Requirements

| ID | Status | Evidence |
|----|--------|----------|
| UT-01 | Satisfied | Criterion 1; session id `<host session>:<graph id>` keeps per-graph hash chains. |
| UT-02 | Satisfied | Criteria 2-3. |

## Test runs
- claude-ultrathink branch: `tsc` clean, 2241 pass / 0 fail.
- Live S1 smoke (/tmp/s1-live-smoke.sh): 24/24 checks passed, including the ultrathink note.

## Deliberate exclusions
- No graph registration from the hook; ADR keeps graph tools MCP-only and the kickoff skill registers via MCP.

## Notes
- Greptile review on #19 in progress; findings so far fixed (budget-bounded request, elapsed time includes wait).
- PR claude-ultrathink #18 (teach autonomous capture) has 6 open Greptile findings in `src/teach/skills.ts` and `docs/privacy.md`; outside v1.1 scope, left for the user.
