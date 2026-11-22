---
phase: 30-desktop-run
verified: 2026-11-12T08:31:25Z
status: human_needed
score: 4/5 roadmap success criteria verified (1 present, behavior-unverified; live proof operator-gated)
covered_files: [".planning/milestones/v1.3-phases/30-desktop-run/30-01-PLAN.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-01-SUMMARY.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-02-PLAN.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-02-SUMMARY.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-03-PLAN.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-03-SUMMARY.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-04-PLAN.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-04-SUMMARY.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-05-PLAN.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-05-SUMMARY.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-06-PLAN.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-06-SUMMARY.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-07-PLAN.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-07-SUMMARY.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-CONTEXT.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-N1-SPIKE.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-PATTERNS.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-PROOF.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-RESEARCH.md", ".planning/milestones/v1.3-phases/30-desktop-run/30-VALIDATION.md", ".env.example", "README.md", "docs/event-vocabulary.md", "docs/mcp-audit.md", "docs/runbooks/desktop.md", "infra/desktop/substrate-desktop.sh", "package.json", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/desktop/actions.test.ts", "packages/mcp-server/src/desktop/actions.ts", "packages/mcp-server/src/desktop/config.test.ts", "packages/mcp-server/src/desktop/driver.test.ts", "packages/mcp-server/src/desktop/driver.ts", "packages/mcp-server/src/desktop/png.test.ts", "packages/mcp-server/src/desktop/png.ts", "packages/mcp-server/src/desktop/tool.test.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/http.test.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/rehearsal-env.test.ts", "packages/mcp-server/src/rehearsal-env.ts", "packages/mcp-server/src/service.ts", "scripts/desktop-smoke.test.ts", "scripts/desktop-smoke.ts", "scripts/rehearsal.test.ts", "scripts/rehearsal.ts", "scripts/substrate-desktop.test.ts"]
covered_digest: "v3:sha256:85fc159b31f428a011f39dadddf8fc8b9fe1b02439c35c7e6104efba329a1d89"
behavior_unverified: 1
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 12/12
  gaps_closed: []
  gaps_remaining: ["SC5 live pixel proof (typed marker in returned screenshot): NOT RUN, operator-gated"]
  regressions: []
behavior_unverified_items:
  - truth: "SC5: a headless session's desktop_run returns a screenshot whose pixels show the typed marker"
    test: "bun run rehearsal up --name p30 --surfaces omp,cursor --desktop-surfaces omp; bun run smoke:desktop --name p30; bun run check:phase-close; bun run rehearsal down --name p30"
    expected: "band pixels >= 1500 of the nonce RGB in the returned block, none in baseline; block sha equals stored file and event sha; 5/5 tool.call rows with text_sha256 (30-PROOF.md section 2)"
    why_human: "Needs the live substrate-desktop display; 30-PROOF.md records every live field as NOT-RUN. Presence and wiring do not show pixels."
human_verification:
  - test: "Run the 30-PROOF.md section 2 live chain against the local substrate-desktop container and record the numbers in 30-PROOF.md"
    expected: "All ten check lines in 30-PROOF.md section 2 pass, including the band-pixel clause"
    why_human: "Operator-gated: drives the live display and needs an operator-approved window"
  - test: "Run the 30-N1-SPIKE.md ladder (as-ported, timing, stacking, forced repaint) and record verdicts"
    expected: "n1_reproduced, capture_path, settle_ms recorded; if no capture path yields fresh pixels, the pixel clause stays a gap (never passed on titles)"
    why_human: "Operator-gated live run; 30-N1-SPIKE.md verdicts are NOT-RUN"
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 30: desktop_run Verification Report

**Phase Goal:** An authenticated agent can drive the dedicated webtop desktop and see the result, through a closed vocabulary that leaves an audit trail and exposes nothing else on the host.
**Verified:** 2026-11-12T08:31:25Z
**Status:** human_needed
**Re-verification:** Yes. The prior VERIFICATION.md (2026-10-11, status passed, 12/12) is superseded. It counted the operator-gated live checks as closed; 30-PROOF.md and 30-N1-SPIKE.md record them NOT-RUN, so the status is human_needed.

## Goal Achievement

### Observable Truths (ROADMAP Phase 30 success criteria)

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | desktop_run accepts only click/type/key/screenshot, at most 50 actions, 1–120 s timeout, fixed docker exec argv, one run at a time; screenshots as image blocks, mode 0600, 200 runs / 7 days | ✓ VERIFIED | actions.ts:21 (discriminated union), :50-51 (max 50; timeout 1–120, default 30); driver.ts:50-51 (RETAIN_RUNS 200, RETAIN_MS 7d), :409-411 (dirs 0700, files 0600), :484-488 (busy refusal via `active`); driver.ts:81-84 execFile, no shell, 16 MiB. Desktop unit suites pass (see Behavioral Spot-Checks). |
| 2 | One event per action under an existing kind; typed text only as length + sha256; no image block in the audit record | ✓ VERIFIED | driver.ts:442-444 `kind: "tool.call"`, `session_id: desktop:<run_id>`; driver.ts:394 `text_len` / `text_sha256`; http.test.ts "the audit record carries keys plus digest only, in fail-closed mode" passes. |
| 3 | Only allowlisted surfaces; unlisted token, anonymous caller and VM guest each refused, each tested; fail-closed in audit policy | ✓ VERIFIED | service.ts:2152-2170 (order: anonymous, not in `desktopSurfaces`, unwired, no ledger, busy); http.test.ts "an unlisted surface with a valid token is refused and runs nothing", "no bearer is 401 before the runner or the audit ever see the call", "a bogus bearer is 401"; policy.ts:33 `"desktop_run"` fail-closed entry. |
| 4 | Lifecycle script: ≥10 GiB free, `--pull never`, loopback 6081 behind basic auth, unprivileged, no docker socket, never touches `recruitment-desktop` | ✓ VERIFIED | substrate-desktop.sh:26 `MIN_FREE_BYTES=10737418240`; :25 `PUBLISH=127.0.0.1:6081:3000`; :119 `docker run -d --pull never`; no `recruitment` reference in the script. substrate-desktop.test.ts ran in the 351-pass batch; its one failure is the TMPDIR case below. |
| 5 | A headless session's desktop_run returns a screenshot whose pixels show the typed marker | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Code present and wired (driver.ts screenshot step; desktop-smoke.ts band finder). No live run: every 30-PROOF.md §2 field is NOT-RUN. Hermetic band-finder tests pass. |

**Score:** 4/5 truths verified (1 present, behavior-unverified)

### Plan-level items (30-06 spike)

| Item | Status | Evidence |
| ---- | ------ | -------- |
| 30-06: N1 spike reproduces the marker on the live container; records n1_reproduced, capture_path, settle_ms | ? UNCERTAIN (human) | 30-N1-SPIKE.md: `n1_reproduced=NOT-RUN`, `capture_path=NOT-RUN`. Live-gated. |
| 30-06: any capture fix stays in the four-action vocabulary with a builder-table test | ✓ VERIFIED (no fix to date) | actions.test.ts "argv builders > equal the fixed table exactly" passes. |

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| packages/mcp-server/src/desktop/actions.ts | closed vocabulary and limits | ✓ VERIFIED | 122 lines; schema :21-59 |
| packages/mcp-server/src/desktop/driver.ts | runner, env allowlist, busy lock, retention, tool.call | ✓ VERIFIED | 502 lines |
| packages/mcp-server/src/desktop/png.ts | XWD to PNG codec | ✓ VERIFIED | 149 lines; png.test.ts passes |
| packages/mcp-server/src/service.ts | runDesktop gate | ✓ VERIFIED | :2152-2200 |
| packages/mcp-server/src/mcp.ts | tool registration, image blocks | ✓ VERIFIED | :2518 registration; :18 import |
| infra/desktop/substrate-desktop.sh | lifecycle script | ✓ VERIFIED | 185 lines; `bash -n` clean per suite |
| scripts/desktop-smoke.ts | headless smoke client | ✓ VERIFIED (code); live run NOT-RUN | 815 lines; helper tests pass |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| service.ts runDesktop | desktop driver run (emit per call) | `this.desktop` | ✓ WIRED | service.ts:1510 field; runDesktop checks `desktopSurfaces` |
| mcp.ts desktop_run handler | service.runDesktop | tool handler | ✓ WIRED | mcp.ts:2518-2522 |
| index.ts | createDesktopDriver(bufferRunner, desktopDir) | production wiring | ✓ WIRED | per 30-04 SUMMARY; index.ts not re-read in this pass |
| driver.ts | png.ts decodeXwd/encodePng; ../redact.ts | import | ✓ WIRED | imports present; driver suites pass |
| rehearsal.ts | rehearsal-env.ts desktopSurfaces | runUp | ✓ WIRED | rehearsal.ts:1193, :1265 |

`verify.artifacts` and `verify.key-links` returned zero entries for the plan files, so the rows above come from direct grep and read.

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| driver.ts screenshot | PNG bytes | `xwd -root` via docker exec | Yes in code; not observed live | ? UNCERTAIN (live) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Desktop, config, rehearsal-env, smoke, lifecycle suites | `bun test packages/mcp-server/src/desktop packages/mcp-server/src/config packages/mcp-server/src/rehearsal-env.test.ts scripts/desktop-smoke.test.ts scripts/rehearsal.test.ts scripts/substrate-desktop.test.ts` | 351 pass, 1 fail (12 files) | ✓ VERIFIED |
| Lifecycle "up refuses without root" | `bun test scripts/substrate-desktop.test.ts -t "without root"` | Fails with default TMPDIR (under /root; setpriv uid 65534 cannot traverse it, exit 126). Passes with `TMPDIR=/tmp`. | ✓ VERIFIED (environment artifact, not a code defect) |
| HTTP gate and observe | `bun test packages/mcp-server/src/http.test.ts packages/mcp-server/src/observe.test.ts` | 164 pass, 0 fail | ✓ VERIFIED |
| Live proof chain | `bun run rehearsal up` … `smoke:desktop` | NOT RUN | ? UNCERTAIN (live-gated) |

Not run in this pass: full `bun test`, `bunx tsc --noEmit`, `bun run check:phase-close`, any live Docker or desktop command, the 30-PROOF §2 chain, and the N1 ladder.

### Probe Execution

No probes declared for this phase.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| DESK-01 | 30-01, 30-04 | closed vocabulary, limits, screenshot 0600 retention | ✓ SATISFIED | Truth 1 |
| DESK-02 | 30-01, 30-04 | one event per action, hashes only | ✓ SATISFIED | Truth 2 |
| DESK-03 | 30-02, 30-04 | allowlist; refusals; fail-closed policy | ✓ SATISFIED | Truth 3 |
| DESK-04 | 30-03 | lifecycle script gates | ✓ SATISFIED | Truth 4 |
| DESK-05 | 30-07 (+30-06) | headless pixel proof | ? NEEDS HUMAN | Truth 5; live chain NOT-RUN |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| scripts/substrate-desktop.test.ts | 399-416 | "without root" test depends on TMPDIR location under /root | ℹ️ Info | Fails with default TMPDIR in this sandbox; passes with TMPDIR=/tmp. Not a product defect. |
| .planning/milestones/v1.3-phases/30-desktop-run/30-SECURITY.md | 1-3 | header says it was recovered from another worktree and not re-verified against main | ℹ️ Info | Frontmatter `status: verified`, `threats_open: 0`; the security gate passes. Noted only. |

No stubs, placeholder returns, or hardcoded empty data found in the desktop modules during this pass.

### Human Verification Required

### 1. Live pixel proof chain (DESK-05 / SC5)

**Test:** From the repo root: `bun run rehearsal up --name p30 --surfaces omp,cursor --desktop-surfaces omp`, then `bun run smoke:desktop --name p30`, `bun run check:phase-close`, `bun run rehearsal down --name p30`. Record the numbers in 30-PROOF.md §2.
**Expected:** Band of at least 1500 exact-RGB pixels in the returned block and 0 in baseline; block, file and event sha256 equal; 5/5 `tool.call` rows with `text_sha256`; unlisted and no-token refusals; recruitment-desktop inspect unchanged.
**Why human:** Drives the live `substrate-desktop` display and needs an operator-approved window. 30-PROOF.md records every live field as NOT-RUN.

### 2. N1 stale-pixel ladder (30-06)

**Test:** Follow the ladder in 30-N1-SPIKE.md against the live container and record verdicts.
**Expected:** `n1_reproduced`, `capture_path`, `settle_ms` recorded; if no capture path gives fresh pixels, the pixel clause stays a gap.
**Why human:** Operator-gated live run; all verdicts are NOT-RUN.

## Gaps Summary

No code-level gaps. Four of five roadmap success criteria are verified against code and passing tests. SC5 (live pixel proof) and the N1 spike are present but not exercised, and both are operator-gated. Per the decision tree the status is `human_needed`, not `passed`. The prior `passed` status is superseded.

Operator steps (not run, not to be run by an agent): the live proof chain, the N1 ladder, and the production `SUBSTRATE_DESKTOP_SURFACES` change with restart. Procedures are in 30-PROOF.md §2, 30-N1-SPIKE.md and docs/runbooks/desktop.md.

---

_Verified: 2026-11-12T08:31:25Z_
_Verifier: Claude (gsd-verifier)_
