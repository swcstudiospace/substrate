---
phase: 24-substrate-dispatcher
verified: 2026-11-12T08:24:58Z
status: human_needed
score: 4/5 roadmap success criteria verified in code and tests; SC5 (live DISP-08 proof) human_needed, operator-gated
covered_files: [".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-01-PLAN.md", ".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-01-SUMMARY.md", ".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-02-PLAN.md", ".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-02-SUMMARY.md", ".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-03-PLAN.md", ".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-03-SUMMARY.md", ".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-04-PLAN.md", ".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-04-SUMMARY.md", "docs/dispatcher.md", "docs/runbooks/dispatch-proof.md", "infra/vps/substrate-dispatcher.service", "package.json", "packages/dispatcher/pyproject.toml", "packages/dispatcher/src/substrate_dispatcher/__init__.py", "packages/dispatcher/src/substrate_dispatcher/__main__.py", "packages/dispatcher/src/substrate_dispatcher/dispatch.py", "packages/dispatcher/src/substrate_dispatcher/host.py", "packages/dispatcher/src/substrate_dispatcher/launcher.py", "packages/dispatcher/src/substrate_dispatcher/linear.py", "packages/dispatcher/src/substrate_dispatcher/mcp.py", "packages/dispatcher/src/substrate_dispatcher/sessions.py", "packages/dispatcher/src/substrate_dispatcher/worktree.py", "packages/dispatcher/tests/test_clients.py", "packages/dispatcher/tests/test_dispatch.py", "packages/dispatcher/tests/test_host.py", "packages/dispatcher/tests/test_launcher.py", "packages/dispatcher/tests/test_main.py", "packages/dispatcher/tests/test_sessions.py", "packages/dispatcher/tests/test_worktree.py", "scripts/dispatcher-driver.py", "scripts/dispatcher-smoke.ts"]
covered_digest: "v3:sha256:a6a22cf2d1beaa30f795d13aa0af33f47a8663ba6ce8cdc559bc6c49d30d9beb"
behavior_unverified: 0
overrides_applied: 0
behavior_unverified_items: []
human_verification:
  - test: "Bounded kill-switch-off window: run docs/runbooks/dispatch-proof.md steps 1-8 verbatim (provision /etc/substrate/substrate-dispatcher.env, switch SUBSTRATE_DISPATCH_DISABLED off for the window, label a Linear issue dispatch:hermes, then restore SUBSTRATE_DISPATCH_DISABLED=1)"
    expected: "dispatch:hermes launches a session within 30 s; the claim lands under the Hermes token; Linear shows agent:hermes; Notion shows Agent hermes; a Claude Code brief names the claim within 60 s; the run ends in a gated Done or a release; the kill switch is back on afterwards"
    why_human: "Needs live Linear, Notion and Hermes model quota and explicit operator approval; the runbook evidence table is NOT RUN. Env provisioning, production restart and the dormant:24 -> live manifest flip are part of the same gated sequence and were not run."
regressions: []
gaps: []
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 24: substrate-dispatcher Verification Report

**Phase Goal:** Labelling a Linear issue `dispatch:hermes` starts a lease-correct Hermes session on the issue's Graph ID in its own worktree, and every issue it does not dispatch says why.
**Verified:** 2026-11-12T08:24:58Z
**Status:** human_needed
**Re-verification:** Yes. Re-run of the 2026-10-11 verification (prior status `passed`, rehearsal scope). This run routes the operator-gated live tail to human verification, as the decision tree requires.

## Goal Achievement

### Observable Truths (ROADMAP Phase 24 success criteria)

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | Supervised unit reads `dispatch:*` issues every 30 s under a flock and re-reads `SUBSTRATE_DISPATCH_DISABLED` each tick; each non-dispatch leaves one marker comment | ✓ VERIFIED | `__main__.py:36` `POLL_INTERVAL_SECONDS = 30`; `__main__.py:50-57` `acquire_lock` (LOCK_EX\|LOCK_NB); `dispatch.py:39` `DISABLE_KEY`, `dispatch.py:80-103` env-file-first re-read; `dispatch.py:328` checked each tick; marker vocabulary `dispatch.py:45-57` covers all 11 markers. Tests: `test_main.py:58` (30 s between iterations), flock tests `test_main.py:144+`, `test_dispatch.py:277` (host-refused once-only). |
| 2 | Worktree at `/var/lib/substrate/worktrees/<graph_id>` on `substrate/<graph_id>`, reused, origin-verified, refused below 5 GiB; `hermes` headless with allowlisted env, `claude-code` to Lane A, other surfaces `not-dispatchable` | ✓ VERIFIED | `worktree.py:26,31` root and branch prefix; `worktree.py:37-58` floor default 5 GiB; `worktree.py:126-147` origin check; `worktree.py:175-192` disk-floor gate before any git call; `launcher.py:185` `CHILD_ENV_ALLOW` allowlist; `dispatch.py:37,253` `DISPATCHABLE_SURFACES` = hermes, claude-code, else `not-dispatchable`; `dispatch.py:562` claude-code route. Tests: `test_worktree.py` (floor, origin, reuse), `test_claude_code_route.py`. |
| 3 | Launched agent claims with its own surface token, heartbeats, completes with `lease_id` + DoD or releases; dispatcher never claims; issue text never in prompt (read via `issue_get` as untrusted) | ✓ VERIFIED | `launcher.py:54-55` hermes token read at session runtime (path only in prompt); `launcher.py:65-121` prompt template: graph_claim, graph_heartbeat, graph_complete, graph_release, and an `issue_get` step with UNTRUSTED wording (`launcher.py:83-89`); `launcher.py:129-142` render takes validated ids only; `host.py:101` and `mcp.py:136` carry the substrate bearer on the dispatcher's own calls. Claim/release/complete calls appear only in the prompt template (grep). |
| 4 | Claim not landed after 900 s → SIGTERM then SIGKILL; exit without claim comments, removes label, gives up; given-up set survives restart | ✓ VERIFIED | `sessions.py:34` `CLAIM_TIMEOUT_SECONDS = 900`; `sessions.py:35,42` SIGTERM then kill grace; `sessions.py:476-477` SIGKILL when survived; `sessions.py:540-547` timeout terminate; `sessions.py:189-293` given-up load/save (0600, atomic replace), `give_up()` persists. Behavior exercised by passing tests: `test_sessions.py:103` (SIGTERM-ignoring session killed after grace), `:138` (real child timeout SIGTERM→SIGKILL), `:283` (unclaimed exit comments once, removes label, gives up), `:418` (claim-timeout path), `:442` (given-up survives restart via given_up.json), `:455` (0600). |
| 5 | Bounded window: `dispatch:hermes` launches within 30 s; claim under Hermes token; Linear `agent:hermes`; Notion Agent hermes; Claude Code brief within 60 s; ends Done or release; kill switch back on | ? UNCERTAIN (human) | Rehearsal evidence only: `scripts/dispatcher-smoke.ts` and `scripts/dispatcher-driver.py` exist (driver S1–S10 covers launch argv/cwd/env/prompt, landed claim, timeout, restart, leak sweep). Live steps are NOT RUN per `docs/runbooks/dispatch-proof.md` and `24-VALIDATION.md`. Routed to human verification. |

**Score:** 4/5 truths verified in code and tests; truth 5 needs the live tail.

### Requirements Coverage (REQUIREMENTS.md v1.3, Phase 24)

| Requirement | Plan | Status | Evidence |
| ----------- | ---- | ------ | -------- |
| DISP-01 | 24-01, 24-03 | ✓ SATISFIED | `__main__.py:36,50-57`; `dispatch.py:80-103`; `test_main.py:58`. Unit `infra/vps/substrate-dispatcher.service` staged with `ConditionPathExists`, `Restart=always`, `EnvironmentFile`. |
| DISP-02 | 24-02 | ✓ SATISFIED | 11-marker set `dispatch.py:45-57`; once-only `_comment_once`; `test_dispatch.py:277`. |
| DISP-03 | 24-01 | ✓ SATISFIED | `worktree.py:26-192`; `test_worktree.py`. |
| DISP-04 | 24-02 | ✓ SATISFIED | `dispatch.py:37,253,562`; `launcher.py:185`; `test_launcher.py`, `test_claude_code_route.py`. |
| DISP-05 | 24-02 | ✓ SATISFIED | Claim/heartbeat/complete only in the `launcher.py` prompt template; dispatcher bearer at `host.py:101`, `mcp.py:136`. |
| DISP-06 | 24-02 | ✓ SATISFIED | `sessions.py:34-547`; `test_sessions.py:103,138,283,418,442`. |
| DISP-07 | 24-02 | ✓ SATISFIED | `launcher.py:65-142`; prompt carries ids only; issue fetched via `issue_get`. |
| DISP-08 | 24-04 | ? NEEDS HUMAN | Rehearsal half present (smoke + driver, not re-run here). Live proof OPERATOR-GATED, NOT RUN. |

**Orphaned requirements:** none. All eight DISP IDs are claimed by plans.

**Note:** `.planning/milestones/v1.3-REQUIREMENTS.md` still lists DISP-01..08 as `Pending`. This verifier did not edit it (out of scope).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/dispatcher/src/substrate_dispatcher/{__main__,dispatch,sessions,launcher,worktree,linear,mcp,host}.py` | Phase 24 dispatcher modules | ✓ VERIFIED | Present, substantive, wired from the `__main__` tick path. |
| `packages/dispatcher/tests/test_*.py` (phase-24 set) | Unit coverage | ✓ VERIFIED | Present and run (see Behavioral Spot-Checks). |
| `infra/vps/substrate-dispatcher.service` | Staged unit, inert | ✓ VERIFIED | `ConditionPathExists` guard; `EnvironmentFile` names only; no secret values. |
| `scripts/dispatcher-smoke.ts`, `scripts/dispatcher-driver.py` | Rehearsal proof | ✓ VERIFIED (present) | Present; not executed in this pass. |
| `docs/runbooks/dispatch-proof.md` | Gated live tail | ✓ VERIFIED (present) | Steps marked OPERATOR-GATED, NOT RUN. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `__main__.py` loop | `dispatch.tick` + `sessions` reap | direct call | ✓ WIRED | `__main__.py:103-110`: readopt → reap → tick → sleep. |
| `dispatch.py` | `worktree.py`, `launcher.py`, `host.py` | `make_launch_fn` routing | ✓ WIRED | `dispatch.py:521-578`. |
| `sessions.py` give-up | `given_up.json` | `_save_given_up` / `_load_given_up` | ✓ WIRED | `sessions.py:211-293`. |
| `launcher.py` prompt | Linear issue text | `issue_get` at runtime | ✓ WIRED (by design) | Prompt instructs the session to fetch; the dispatcher never inlines issue text. |

### Data-Flow Trace (Level 4)

Not applicable in the UI sense. Dispatch decisions flow from Linear poll → `graph_find` → `graph_get` node state → launch or marker. The `graph_get` landed-claim read is exercised by `test_sessions.py:195,530,539`.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| covered files | — | `TBD`/`FIXME`/`XXX` | — | None found across covered source, tests, smoke, driver and unit. Debt gate passes. |
| `launcher.py` | 41-47 | IN-01 recorded, not fixed: dispatched Hermes runs as root and can read `/etc/substrate/substrate.env` | ℹ️ Info | Accepted, documented trust assumption (D-16). Not a must-have. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Dispatcher pytest suite (incl. timeout, give-up, restart, claim-route tests) | `python3 -m pytest packages/dispatcher/tests -q` | `289 passed in 10.36s`, exit 0 | ✓ PASS |
| Miner + dispatcher suite named in roadmap | not run | — | ? SKIP (dispatcher subset run above) |
| `bun run smoke:dispatcher` (rehearsal, loopback fakes) | not run | — | ? SKIP (starts loopback fakes; not run in this pass) |
| Live DISP-08 tail | not run | — | ? SKIP (operator-gated; routed to human) |

Note: the suite count is 289, not the 246 in the 2026-10-11 close-out. The extra tests cover modules added after phase 24 (`handoff.py`, `quota.py`, `test_handoff.py`, `test_quota.py`, `test_readoption.py`, `test_claude_code_route.py`). Those files are outside this phase's covered set, so the digest covers phase-24 files only.

### Probe Execution

No `scripts/*/tests/probe-*.sh` declared or found for this phase. Not applicable.

### Security Gate

No phase-level `*-SECURITY.md` exists in `24-substrate-dispatcher/`. The repo-root `SECURITY.md` is the project security policy, not a threat register for this phase, so no `threats_open` check applies. Not a blocker; recorded so it is visible.

### Human Verification Required

### 1. Live DISP-08 tail (bounded kill-switch-off window)

**Test:** Run `docs/runbooks/dispatch-proof.md` steps 1–8 verbatim: provision `/etc/substrate/substrate-dispatcher.env`, open the bounded kill-switch-off window, label a Linear issue `dispatch:hermes`, observe, then restore `SUBSTRATE_DISPATCH_DISABLED=1`.
**Expected:** `dispatch:hermes` launches a session within 30 s; the claim lands under the Hermes token; Linear shows `agent:hermes`; Notion shows Agent hermes; a Claude Code brief names the claim within 60 s; the run ends in a gated Done or a release; the kill switch is back on afterwards.
**Why human:** Needs live Linear, Notion and Hermes model quota and explicit operator approval. Env provisioning, production restart and the `dormant:24` → `live` manifest flip are part of the same gated sequence and were not run.

## Gaps Summary

No must-have is FAILED. No gap blocks the rehearsal scope. Status is `human_needed` because the live DISP-08 tail is operator-gated, and any human item rules out `passed`.

## Not Run

- `bun run smoke:dispatcher` and `scripts/dispatcher-driver.py` (not executed in this pass).
- `bun test`, `bunx tsc --noEmit`, `check:phase-close` (outside the phase-24 scope).
- Every live DISP-08 step, env provisioning, production restart, manifest flip.
