---
phase: 44-uat
verified: 2026-11-18T12:21:32Z
status: passed
score: 1/1 roadmap success criteria verified (I-D1)
covered_files: [".planning/milestones/v1.3.x-phases/44-uat/CONTEXT.md", ".planning/milestones/v1.3.x-phases/44-uat/PLAN.md", ".planning/milestones/v1.3.x-phases/44-uat/SUMMARY.md", "docs/uat.md", "infra/vps/deploy-release.test.ts", "scripts/cache-stats.test.ts", "scripts/uat-phase0.test.ts", "scripts/uat-phase0.ts"]
covered_digest: "v3:sha256:b2e4919669760b12f49a03a6b509f87f8e6c882848a2cd4b641cca31804f7a55"
behavior_unverified: 0
overrides_applied: 0
advisory: []
---

# Phase 44: UAT Verification Report

**Phase Goal:** The Phase 0 UAT runs as a repeatable script against any `SUBSTRATE_URL`.
**Verified:** 2026-11-18T12:21:32Z
**Status:** passed
**Re-verification:** No — initial verification in this worktree (HEAD 357d6b15, branch gsd/autonomous-rerun)

## Location note

The phase directory `.planning/phases/44-uat/` did not exist in this worktree before this record was written. The phase's CONTEXT, PLAN, SUMMARY and the prior VERIFICATION are archived at `.planning/milestones/v1.3.x-phases/44-uat/` (archived by commit a93e71be). This record is written to the expected phase directory. ROADMAP.md's Phase 44 pointer (`phases/44-uat/VERIFICATION.md`) therefore resolves only through this file or the archive; the roadmap text was not edited here.

## Goal Achievement

### Roadmap Success Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | The UAT runs as a repeatable script against any `SUBSTRATE_URL` (I-D1) | ✓ VERIFIED | See evidence rows below |

### Evidence

| Claim | Evidence (in repository, read or run at HEAD) | Result |
|-------|-----------------------------------------------|--------|
| Script is the UAT entry point | `package.json:52` maps `uat:phase0` to `bun scripts/uat-phase0.ts` | present, wired |
| Target comes from `SUBSTRATE_URL`, not a hardcoded host | `scripts/uat-phase0.ts:1013-1014` reads `env.SUBSTRATE_URL`, trims the trailing slash, refuses when unset; `:1019` refuses an unparseable host | present |
| Production targets are classified and writes are guarded | `scripts/uat-phase0.ts:39` lists write scenarios; `:104` refuses writes on production without `--live <approval-ref>`; `:991-995` rejects empty or option-like `--live` values | present |
| Operator bearer and surface bearers come from the right sources | `scripts/uat-phase0.ts:1002-1008` `surfaceBearer` reads the surface's token file from `SUBSTRATE_TOKENS_DIR` / `SUBSTRATE_REHEARSAL_TOKENS_DIR` / default; `:1028` builds the cursor and hermes bearers from it; `:731`, `:928`, `:941` use them for surface-named requests | present |
| Operator docs describe the same contract | `docs/uat.md` states the script runs against any `SUBSTRATE_URL`, lists the flags, the scenario table, and exit codes (0 pass, 1 scenario failed, 2 usage or refused target) | present, consistent with code |
| Targeted test run at HEAD | `bun test scripts/uat-phase0.test.ts` (bun 1.4.0): **54 pass, 0 fail**, 143 expect calls. Includes: store URL never contacted (`consumer contract`), production write refused before any request naming `--live` (`live guard` / `consumer contract`), surface bearer from its own file (`surface bearers`) | ✓ passes |

The archived regression evidence is recorded in `.planning/milestones/v1.3.x-phases/44-uat/VERIFICATION.md`. It reports a regression run against a scratch twin of origin/main 3e9a106: run 1 passed 4 of 6, run 2 passed 6 of 6 after the surface-bearer fix. The run report lives outside the repository and was not re-run here. The live stack was not started, per this assignment.

### Caveats (do not change the status)

- **Regression evidence is historical.** The 6-of-6 run was against origin/main 3e9a106 on branch `gsd/v13x-44-uat`, not against HEAD 357d6b15. HEAD's `scripts/uat-phase0.ts` has changed since then (for example, types refactor `ca482e8e`). The targeted test file still passes at HEAD, which is the evidence this record relies on for the current tree.
- **No CI wiring.** The regression needs Docker and the rehearsal twin, which CI does not start. D44-e records this as an operator decision. The criterion does not require CI wiring, so it is not a gap.
- **Scenarios 2 and 5 are outside the harness default** by design (need seeded rows and a live kickoff graph). Not part of the criterion.

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `scripts/uat-phase0.ts` | UAT script against any SUBSTRATE_URL | ✓ VERIFIED | Substantive (~47 KB), reads `SUBSTRATE_URL`, guards writes, wired via `package.json` |
| `scripts/uat-phase0.test.ts` | Tests for classifier, live guard, consumer contract, surface bearers | ✓ VERIFIED | 54 pass, 0 fail at HEAD |
| `docs/uat.md` | Operator contract | ✓ VERIFIED | Matches flags and behavior in code |
| `scripts/uat/fixtures/notion-rows.json` | Backfill fixture | ✓ VERIFIED | Present (2.4 KB) |

## Requirements Coverage

| Requirement | Source | Description | Status | Evidence |
|-------------|--------|-------------|--------|----------|
| I-D1 | ROADMAP Phase 44 | A regression check for every later phase | ✓ SATISFIED | Repeatable script (above); `.planning/milestones/v1.3.x-REQUIREMENTS.md:65,173` marks I-D1 complete for Phase 44 |

## Anti-Patterns Found

None blocking. The `scripts/uat-phase0.ts` surface-bearer and refusal paths are not stubs; they are exercised by the targeted tests above.

## Human Verification Required

None required for the criterion as stated. A live re-run against a rehearsal twin or production is an operator action and is not needed to establish that the script runs against any `SUBSTRATE_URL`.

## Gaps Summary

No gaps. The roadmap pointer to `phases/44-uat/VERIFICATION.md` is a location issue (the phase is archived), recorded above; it is not a failed criterion.

---

_Verified: 2026-11-18T12:21:32Z_
_Verifier: Claude (gsd-verifier)_
