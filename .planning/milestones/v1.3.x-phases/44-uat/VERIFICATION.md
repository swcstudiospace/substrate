---
phase: 44-uat
verified: 2026-11-12T08:35:56Z
status: human_needed
score: 1/1 must-haves verified in code (live regression re-run not run)
behavior_unverified: 0
overrides_applied: 0
covered_files: [".planning/milestones/v1.3.x-phases/44-uat/PLAN.md", ".planning/milestones/v1.3.x-phases/44-uat/SUMMARY.md", "docs/uat.md", "infra/vps/deploy-release.test.ts", "scripts/cache-stats.test.ts", "scripts/uat-phase0.test.ts", "scripts/uat-phase0.ts"]
covered_digest: "v3:sha256:e727fe6d6b351194ed4b7a6e65ded56779d33181bb4d7595457b9886bf98b0a2"
re_verification:
  previous_status: passed
  previous_score: "1 of 1 criterion proven in-repo (I-D1)"
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Re-run the Phase 0 regression on a scratch twin: from a detached worktree at the commit under test, `bun run rehearsal up`; source the run's consumer.env; `bun run uat:phase0 --tag <run-tag> --scenarios 1,3,4,6,7,8 --report <path>`; `bun run rehearsal down`."
    expected: "All six selected scenarios report passed (matches the recorded run 2 on origin/main 3e9a106: 6 of 6)."
    why_human: "Requires Docker and the rehearsal twin, which this verifier cannot start. The original run report lives outside the repository. Not run in this verification."
---

# Phase 44: UAT Verification Report

**Phase Goal:** The Phase 0 UAT runs as a repeatable script against any `SUBSTRATE_URL`.
**Verified:** 2026-11-12T08:35:56Z
**Status:** human_needed
**Re-verification:** Yes — previous VERIFICATION.md (2026-10-21, `passed`) re-checked against current code

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | The UAT runs as a repeatable script against any `SUBSTRATE_URL` (ROADMAP criterion 1, I-D1) | ✓ VERIFIED (code + unit tests); live regression re-run not run | `scripts/uat-phase0.ts:1013-1014` reads `SUBSTRATE_URL` and refuses if unset; `scripts/uat-phase0.ts:91-92` classifies scratch vs production; `scripts/uat-phase0.ts:95-104` refuses write scenarios on production without `--live <approval-ref>`; `scripts/uat-phase0.ts:652` store URLs excluded from the child env. `bun test scripts/uat-phase0.test.ts`: 54 pass, 0 fail (run in this verification). `docs/uat.md` documents the command. |

**Score:** 1/1 truths verified in code (0 present-but-behavior-unverified; live regression not re-run, see Human Verification)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `scripts/uat-phase0.ts` | Scenario runner reading only SUBSTRATE_URL and bearer inputs | ✓ VERIFIED | 1090 lines; eight scenarios; production guard; `surfaceBearer` (line 1007) never reads `SUBSTRATE_TOKEN` |
| `scripts/uat-phase0.test.ts` | Unit tests including the three phase-44 tests | ✓ VERIFIED | 548 lines; tests at lines 462 (no store connection), 488 (production write refused before any request, names `--live`), 531 (surface bearer from its own file) all pass |
| `scripts/cache-stats.test.ts` | Explicit 60 s wall budget for load-sensitive test | ✓ VERIFIED | line 185 `wallBudgetMs: 60_000` |
| `infra/vps/deploy-release.test.ts` | 30 s default timeout | ✓ VERIFIED | line 8 `setDefaultTimeout(30_000)` |
| `docs/uat.md` | Command and flag documentation | ✓ VERIFIED | Documents `uat:phase0`, flags, surface-bearer rule |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `package.json` | `scripts/uat-phase0.ts` | `"uat:phase0": "bun scripts/uat-phase0.ts"` (package.json:53) | ✓ WIRED | |
| `scripts/uat-phase0.ts` | `SUBSTRATE_URL` | env read in `surfaceBearer`/`runUat` (line 1013) | ✓ WIRED | Target is any URL, not hardcoded |
| `scripts/uat-phase0.ts` | surface bearers | `surfaceBearers` from per-surface token file (line 1028) | ✓ WIRED | |

### Data-Flow Trace (Level 4)

Skipped: the phase produces a test/report script, not a rendered dynamic UI.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Consumer contract, production guard, surface bearers | `bun test scripts/uat-phase0.test.ts` | 54 pass, 0 fail | ✓ PASS |
| Live regression on scratch twin | `bun run rehearsal up` + `uat:phase0` | Not run (Docker/rehearsal twin unavailable) | ? SKIP — routed to Human Verification |

### Probe Execution

No probe scripts declared or conventional for this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| I-D1 | PLAN.md | Regression check for every later phase | ? NEEDS HUMAN | Script and guards verified in code; the recorded 6-of-6 regression run is historical and was not reproduced |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER scan of all five implementation files | — | None found |

### Human Verification Required

### 1. Live regression re-run on scratch twin

**Test:** Start the rehearsal twin from a detached worktree at the commit under test (`bun run rehearsal up`), source its `consumer.env`, run `bun run uat:phase0 --tag <run-tag> --scenarios 1,3,4,6,7,8 --report <path>`, then `bun run rehearsal down`.
**Expected:** All six selected scenarios pass.
**Why human:** Needs Docker and the rehearsal twin, which this verifier cannot start. Postgres at 127.0.0.1:5432 was not used.

### Gaps Summary

No code gaps. The UAT script targets any `SUBSTRATE_URL`, refuses writes on production without an approval reference, keeps store URLs out of its child environment, and uses each surface's own bearer. The phase-44 tests pass. The status is `human_needed` only because the regression run was not repeated here. CI wiring remains an operator decision (D44-e) and is not a roadmap criterion.

---

_Verified: 2026-11-12T08:35:56Z_
_Verifier: Claude (gsd-verifier)_
