---
phase: 35-expected-version-for-skills-and-docs
verified: 2026-11-18T12:22:00Z
status: passed
score: 3/3 must-haves verified
covered_files: [".planning/milestones/v1.4-phases/35-expected-version-skills-docs/PLAN.md", ".planning/milestones/v1.4-phases/35-expected-version-skills-docs/SUMMARY.md", "packages/mcp-server/src/docs-ingest.test.ts", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/memory-write.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/skills-approve.test.ts", "packages/mcp-server/src/skills/request.ts"]
covered_digest: "v3:sha256:780033e8dacd2a8bd956468ed5edd9d0597b9776428b7ded4381f95ead550c93"
behavior_unverified: 0
overrides_applied: 0
gaps: []
behavior_unverified_items: []
human_verification: []
---

# Phase 35: expected_version for skills and docs - Verification Report

**Phase Goal:** Skill and docs writes enforce the same optimistic-concurrency contract memory decisions already use.
**Verified:** 2026-11-18T12:22:00Z
**Status:** passed
**Re-verification:** No - initial verification at HEAD 357d6b15 (branch gsd/autonomous-rerun)

Scope: `packages/mcp-server` in `/root/src/worktrees/as-autonomous`. The phase's PLAN/SUMMARY and archived verification are at `.planning/milestones/v1.4-phases/35-expected-version-skills-docs/`. They were written against an older tree (`efa3ee4`, code tree `b8f8331`), so this record re-checks the code at HEAD rather than relying on them.

## Goal Achievement

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A skill or docs write with a stale `expected_version` is rejected with the memory path's error, and the stored row is unchanged. | VERIFIED | Docs: `docs-ingest.ts:968-971` plans every page before the first upload and refuses the call with `version.stale`; `staleVersion` (`:777-800`) mirrors memory's `versionMismatch` (`memory-write.ts:1250`, reason `version.stale`). Test `docs-ingest.test.ts:575` asserts `reason: "version.stale"`, `current_version`, `conflict_with`, unchanged `seen` record (byte-identical), zero new uploads, and a logged warning. Skills: `service.ts:1030-1045` (`skillVersionStale`) throws `SkillProposalStale` in `beforeWork` (`:4803-4826`) before any git work; `skills/request.ts:113-124` maps it to 409 with `reason: "version.stale"`. Test `skills-approve.test.ts:739` asserts no proposal, unchanged registry rows, and no events. |
| 2 | A matching `expected_version` is accepted and the version increments. | VERIFIED | Docs: `docs-ingest.test.ts:613` asserts `status: "replaced"`, version 1 to 2, a second upload; an identical re-submit is `unchanged` and holds version 2. Batch and chained-version cases at `:552`, `:571`, `:625`. Skills: `skills-approve.test.ts:772` asserts the new proposal takes version 2 (rows `[12,1],[13,2]`). Version monotonic per name in `index-store.skills.test.ts:247` (test file changed in only 8 lines since the archived run). |
| 3 | A write without the field behaves exactly as it does today. | VERIFIED | Docs: `staleVersion` returns null when `expected === undefined` (`docs-ingest.ts:781`); test `docs-ingest.test.ts:631` ("an absent expected_version keeps today's behaviour"). Skills: `beforeWork` returns null when `expected === undefined` (`service.ts:4808`); test `skills-approve.test.ts:789` asserts `registry.calls` is `["upsert"]` and a retry changes no row. |

**Score:** 3/3 truths verified (0 present-but-behavior-unverified)

### Behavioral test evidence

Run once in this worktree after `bun install --frozen-lockfile` (gitignored `node_modules` only; no tracked files changed):

```
cd packages/mcp-server && bun test src/docs-ingest.test.ts src/skills-approve.test.ts src/skills/request.test.ts
164 pass, 0 fail, 590 expect() calls, 3 files
```

The behavior-dependent truths (1 and 2, state transitions on stored rows and versions) are covered by named tests that were executed and passed (`docs-ingest.test.ts:575, 613`; `skills-approve.test.ts:739, 772`).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/docs-ingest.ts` | Docs `expected_version` check before any upload | VERIFIED | `firstVersionConflict` (`:945`) and the LightRAG-plane check (`:1478-1480`) both refuse with `version.stale`. |
| `packages/mcp-server/src/service.ts` | Skill staleness check before git | VERIFIED | `skillVersionStale` (`:1030`), `SkillProposalStale` (`:1014`), `beforeWork` hook (`:4803`). |
| `packages/mcp-server/src/skills/request.ts` | 409 mapping and body-shape validation | VERIFIED | `proposalFailure` (`:111-124`) returns 409 with memory's fields; `expected_version` non-negative-integer validation (`:49`). |
| `packages/mcp-server/src/server.ts` | HTTP route surfaces 409 | VERIFIED | Docs pages route maps `version.stale` to 409 (`:1739`); skills propose route uses `proposalFailure` (`:2213`). |
| `packages/mcp-server/src/mcp.ts` | MCP skills tool surfaces the same failure body | VERIFIED | `proposalFailure` used at `:2125`. |
| Tests: `docs-ingest.test.ts`, `skills-approve.test.ts` | Cover the three criteria | VERIFIED | See truth table; all pass at HEAD. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| docs ingest (`ingestDocs`) | `firstVersionConflict` / `staleVersion` | call in `writeBatch` before first upload | WIRED | `docs-ingest.ts:968-971` |
| `skills_propose` (`substrate.proposeSkill`) | `skillVersionStale` via `beforeWork` | `service.ts:4803-4826` | WIRED | Runs after ledger replay, before git work. |
| `SkillProposalStale` | HTTP 409 / MCP error body | `proposalFailure` in `skills/request.ts` | WIRED | Used by `server.ts:2213` and `mcp.ts:2125`. |

### Anti-Patterns Found

None blocking. No TODO/FIXME/XXX markers were found in the changed sections of `docs-ingest.ts`, `service.ts` (phase-35 functions) or `skills/request.ts`.

### Requirements Coverage

The uplift-7 audit row "A stale concurrent update is rejected or resolved under the documented policy" (`.planning/uplift-7/MILESTONE-AUDIT.md:24`, previously FAIL for skills and docs) is covered for the stale-write rejection path by criteria 1 to 3 above.

## Not Proven

- No concurrent-writer test exists for skills or docs. The tests are single-process and sequential. This is not a ROADMAP criterion, so it does not change the status.
- The HTTP status 409 for the stale refusal is established by code inspection (`server.ts:1739`, `skills/request.ts:113-124`), not asserted by the unit tests in this run.

## Human Verification Required

None. No criterion needs a live operator action.

## Gaps Summary

No gaps. All three ROADMAP success criteria are implemented in the code at HEAD and exercised by passing tests.

---

_Verified: 2026-11-18T12:22:00Z_
_Verifier: Claude (gsd-verifier)_
