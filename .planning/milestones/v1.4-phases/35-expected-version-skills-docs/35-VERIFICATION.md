---
phase: 35-expected-version-skills-docs
verified: 2026-11-12T08:31:05Z
status: human_needed
score: 3/3 must-haves verified (ROADMAP success criteria); 1 human decision open
covered_files: ["packages/mcp-server/src/docs-ingest.test.ts", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/http.test.ts", "packages/mcp-server/src/index-store.skills.test.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/rollback-compat.test.ts", "packages/mcp-server/src/server.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/skills-approve.test.ts", "packages/mcp-server/src/skills/propose.test.ts", "packages/mcp-server/src/skills/propose.ts", "packages/mcp-server/src/skills/registry.test.ts", "packages/mcp-server/src/skills/registry.ts", "packages/mcp-server/src/skills/request.ts"]
covered_digest: "v3:sha256:6ab9c3f29d81d39b970c7b35154d4484a1c0741c2cdea9613ecbddadef97378e"
human_verification:
  - test: "Decide whether the skills stale check must be atomic with the PR/registry write"
    expected: "Either accept the advisory check as policy (two concurrent proposals that both pass it each open a PR; the registry gives both the next version), or require enforcement at approval time"
    why_human: "SUMMARY.md GREY_AREA 2 leaves the skills check advisory and not closed. The uplift-7 audit row is about concurrent updates, so this is a policy call."
---

# Phase 35: expected_version for skills and docs — Verification Report

**Phase Goal:** Skill and docs writes enforce the same optimistic-concurrency contract memory decisions already use.
**Verified:** 2026-11-12T08:31:05Z
**Status:** human_needed
**Re-verification:** No — re-run of the initial verification for this phase directory. The 2026-10-21 report cited tests but was not re-derived from the code at HEAD.
**HEAD:** 79494be6. Unrelated uncommitted VERIFICATION.md edits in other phases were left untouched.

## Goal Achievement

### Observable Truths (ROADMAP success criteria, v1.4-ROADMAP.md:485-489)

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | A skill or docs write with a stale `expected_version` is rejected with the memory path's error; stored row unchanged | ✓ VERIFIED | Docs: whole-call pre-check before any upload, `docs-ingest.ts:968-971` (`firstVersionConflict`, `:930-950`), reason `version.stale`, `outcome: "conflict"`; route maps to 409 at `server.ts:1729`. Skills: `beforeWork` refuses before git work, `service.ts:4698-4720`; `SkillProposalStale` at `service.ts:1013-1024`; 409 body with memory's fields at `skills/request.ts:113-125`. Passing tests: docs "stored record is byte-identical" and "refused with outcome conflict and uploads nothing"; skills "refused before git…no row changes, nothing is emitted". |
| 2 | A matching `expected_version` is accepted and the version increments | ✓ VERIFIED | Docs: `docs-ingest.ts:1052` (`replacedPrior ? replacedPrior.version + 1 : 1`); passing test "matching expected_version is accepted and the record version increments". Skills: row takes `max(version)+1` under the per-name advisory lock, `index-store.ts:2517-2530`; passing test "new proposal takes the next version". The live-Postgres monotonic test (`index-store.skills.test.ts:249`) was skipped in this run. |
| 3 | A write without the field behaves as today | ✓ VERIFIED | Docs: `staleVersion` returns null when `expected === undefined` (`docs-ingest.ts:785`); passing test "absent expected_version keeps today's behaviour". Skills: `beforeWork` returns null when `expected === undefined` (`service.ts:4704`); passing test "no version is read, and a retry changes no row". |

**Score:** 3/3 truths verified. No behavior-unverified items: the refusal invariants are exercised by passing tests.

### Deviations from PLAN.md (not ROADMAP criteria, so not gaps)

- PLAN step 1f asked for an in-loop synchronous re-check. The code does only the whole-call pre-check (`docs-ingest.ts:932-971`). The SUMMARY addendum documents this.
- PLAN step 4a cites migration 31. The code uses 32 (`index-store.ts:623-625`). The addendum records the correction.
- PLAN step 5c places the check in `proposeSkill` before git work. It now runs in a `beforeWork` hook after the ledger replay (`service.ts:4698`). It is still before any git work.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/mcp-server/src/docs-ingest.ts` | version on record, stale check | ✓ VERIFIED | Wired via `ingestDocs` to `server.ts:1729` |
| `packages/mcp-server/src/index-store.ts` | migration 32, `skillVersion`, versioned upsert | ✓ VERIFIED | `:623-625`, `:2517-2530`, `:2544-2556` |
| `packages/mcp-server/src/service.ts` | stale check before git, `SkillProposalStale` | ✓ VERIFIED | `:1013`, `:4698-4720` |
| `packages/mcp-server/src/skills/request.ts` | validation and 409 body | ✓ VERIFIED | `:49-51`, `:113-125` |
| `packages/mcp-server/src/mcp.ts` | tools declare the field | ✓ VERIFIED | `:1649-1654`, `:2035` |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `server.ts` docs route | `docs-ingest` | `substrate.ingestDocs` | ✓ WIRED | `server.ts:1704` validates, `:1729` maps 409 |
| `service.proposeSkill` | `index.skillVersion` | `beforeWork` | ✓ WIRED | `service.ts:4708` |
| `upsertProposedSkill` | `skills_registry.version` | max+1 insert | ✓ WIRED | `index-store.ts:2517-2530` |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Docs, skills, rollback-compat, and registry/request/propose unit suites | `bun test` on 7 files (log: `/root/.hermes/cache/scratch/35-verify-tests.log`) | 349 pass, 12 skip, 0 fail | ✓ PASS (partial; see Not Run) |

### Probe Execution

No probes declared or implied for this phase. Skipped.

### Anti-Patterns Found

None blocking. The skills check is advisory at proposal time (SUMMARY GREY_AREA 2). That is a design gap, not a stub.

## Not Run

- Live-Postgres tests in `index-store.skills.test.ts` were **skipped**. `SUBSTRATE_TEST_PG_URL` is unset in this shell and nothing listens on 127.0.0.1:5432. Their presence was verified by reading the code; their pass was not.
- `server.test.ts:496` (HTTP 409, docs route) and `http.test.ts:1434` (HTTP 409, skills route) were not run.
- `bunx tsc --noEmit`, lint, and the full suite were not run.
- No concurrent-writer test exists. The tests are sequential and single-process.

## Human Verification Required

### 1. Skills stale check atomicity

**Test:** Decide whether the skills `expected_version` check must hold under concurrency.
**Expected:** Either accept the advisory check as policy (two concurrent proposals that both pass it each open a PR, and the registry gives both the next version), or require enforcement at approval time.
**Why human:** SUMMARY.md GREY_AREA 2 leaves this open. The uplift-7 audit row is about concurrent updates, so this is a policy call that tests cannot settle.

## Gaps Summary

No gaps against the three ROADMAP success criteria. Status is `human_needed` only because of the open concurrency decision above.

---

_Verified: 2026-11-12T08:31:05Z_
_Verifier: Claude (gsd-verifier)_
