---
phase: 43-lane-a
verified: 2026-11-12T08:36:06Z
status: human_needed
score: 2/2 roadmap criteria proven in-repo; 2 live checks not run (operator-gated)
behavior_unverified: 0
overrides_applied: 0
covered_files: ["packages/dispatcher/src/substrate_dispatcher/sessions.py", "packages/dispatcher/src/substrate_dispatcher/dispatch.py", "packages/dispatcher/src/substrate_dispatcher/__main__.py", "packages/dispatcher/src/substrate_dispatcher/host.py", "packages/dispatcher/tests/test_readoption.py", "packages/dispatcher/tests/test_dispatch.py", "packages/dispatcher/tests/test_claude_code_route.py", "packages/host/src/sandbox-options.ts", "packages/host/src/sandbox-options.test.ts", "packages/host/src/sandbox-provider.ts", "docs/runbooks/lane-a-host.md", "docs/dispatcher.md"]
covered_digest: "v3:sha256:a1227c04cb5ee92fda5c1735869b2f9641600468dbf48a36f8795801777d6b65"
human_verification:
  - test: "Live egress enforcement: on a substrate-host with the sandbox network up, run a sandbox with SUBSTRATE_SANDBOX_EGRESS set to an allowlist and attempt a connection to an unlisted host (e.g. example.com)."
    expected: "The connection is refused; the allowed destination still connects. DOCKER-USER shows the per-address accepts followed by the source DROP."
    why_human: "Requires the live Docker host network; not run in this verification."
  - test: "Live dispatcher restart: with a running dispatch:claude-code VM task, restart substrate-dispatcher.service and watch the log."
    expected: "Log line '<identifier>: re-adopted VM task <graph>/<node>'; no orphaned VM remains; no second dispatch.failed is emitted."
    why_human: "Requires a live dispatcher and a real VM task on substrate-host; the in-repo tests use a fake host."
---

# 43-VERIFICATION: LANE-A

**Phase Goal:** The Lane A sandbox runs under an enforced egress allowlist, and running tasks are re-adopted after a dispatcher restart.
**Verified:** 2026-11-12T08:36:06Z
**Status:** human_needed
**Re-verification:** No — initial verification of the 43-lane-a phase directory (a prior bare VERIFICATION.md from 2026-10-21 exists and was not modified).

## Goal Achievement

### Observable Truths

| #   | Truth (ROADMAP criterion) | Status | Evidence |
| --- | ------------------------- | ------ | -------- |
| 1   | Enforced egress allowlist for the sandbox container (H-D1) | ✓ VERIFIED (in-repo) | `packages/host/src/sandbox-options.ts:131` `parseSandboxEgress` (deny-all default, refuses bad entries); `:204` `egressRules` composes DOCKER-USER accepts then source DROP; wired at `packages/host/src/sandbox-provider.ts:432` (parse before any Docker call) and `:25`/`:444`. `sandbox-options.test.ts:225` "an unlisted host gets no accept rule, and the source DROP is the last rule" passes. Full file: 35 pass, 0 fail. |
| 2   | Running tasks re-adopted after a dispatcher restart, no orphaned VMs (H-D3) | ✓ VERIFIED (in-repo, fake host) | `packages/dispatcher/src/substrate_dispatcher/sessions.py:388` `readopt()`; called before each reap at `__main__.py:93`; record write before launch at `dispatch.py` `note_vm_launch`/`forget_vm_launch` (`may_be_open` gate at `dispatch.py:508`); `vm_tasks.json` 0600/0700 (`sessions.py:169-175`). `test_readoption.py` 17 tests pass (includes restart re-adopt, 404, finished, unreachable x60, corrupt file, permissions, prior-claim, give-up ordering). |

**Score:** 2/2 criteria verified in-repo; both live proofs remain human items.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/host/src/sandbox-options.ts` | Allowlist parse + DOCKER-USER composition | ✓ VERIFIED | `parseSandboxEgress`, `egressRules`, `effectiveEgress`, `egressConflict` present and tested |
| `packages/host/src/sandbox-provider.ts` | Consumes policy at container create | ✓ VERIFIED | Line 432 parses `SUBSTRATE_SANDBOX_EGRESS`; refuses on conflict before Docker calls |
| `packages/dispatcher/src/substrate_dispatcher/sessions.py` | VM record store and `readopt()` | ✓ VERIFIED | `readopt` at :388; constants `READOPT_UNREACHABLE_LIMIT=60`, `PENDING_GRACE_S=900` at :40/:42 |
| `packages/dispatcher/src/substrate_dispatcher/dispatch.py` | Record written before launch | ✓ VERIFIED | `may_be_open` drop rule at :508 |
| `packages/dispatcher/src/substrate_dispatcher/__main__.py` | readopt before each reap | ✓ VERIFIED | :93 |
| `packages/dispatcher/src/substrate_dispatcher/host.py` | `HostRefused.may_be_open` | ✓ VERIFIED | :46-54, :133, :145-147 |
| `docs/runbooks/lane-a-host.md`, `docs/dispatcher.md` | Restart docs | ✓ VERIFIED | Present (content not behaviour-tested) |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `sandbox-provider.ts` | `sandbox-options.ts` `parseSandboxEgress`/`egressRules` | import + call at :432 | WIRED | |
| `__main__.py` | `sessions.py` `readopt()` | call before reap, :93 | WIRED | exceptions logged, loop continues |
| `dispatch.py` launch path | `sessions.py` record store | `note_vm_launch` / `forget_vm_launch` | WIRED | record persists before `launch_fn` |

### Data-Flow Trace (Level 4)

Not applicable to this phase: no UI or rendered dynamic data. The re-adopted session reads its status from substrate-host through `RemoteTask` (real host call in production; fake host in tests).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Re-adoption behaviours | `python3 -m pytest packages/dispatcher/tests/test_readoption.py -q` | 17 passed | ✓ PASS |
| Full dispatcher suite | `python3 -m pytest packages/dispatcher/tests -q` | 289 passed | ✓ PASS |
| Egress policy and composition | `bun test packages/host/src/sandbox-options.test.ts` | 35 pass, 0 fail | ✓ PASS |
| Live egress block on a host | — | not run | ? SKIP (operator-gated) |
| Live dispatcher restart | — | not run | ? SKIP (operator-gated) |

### Probe Execution

No probe scripts declared or conventional for this phase (`scripts/*/tests/probe-*.sh` not found for phase 43). Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| H-D1 | 43-PLAN | Sandbox egress allowlist enforced (September N3) | ✓ SATISFIED in-repo; live proof human | Truth 1 |
| H-D3 | 43-PLAN | No orphaned VMs after dispatcher restart | ✓ SATISFIED in-repo; live proof human | Truth 2 |

No orphaned requirements: REQUIREMENTS.md maps only H-D1 and H-D3 to phase 43.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | No `TBD`/`FIXME`/`XXX` markers in covered source or docs | — | None |

### Human Verification Required

### 1. Live egress enforcement

**Test:** On a substrate-host with the sandbox network up, set `SUBSTRATE_SANDBOX_EGRESS` to an allowlist and try to reach an unlisted host (e.g. example.com) from inside a sandbox.
**Expected:** Unlisted host is refused; listed destination connects; DOCKER-USER shows accepts then the source DROP.
**Why human:** Live Docker network on the host; not run here.

### 2. Live dispatcher restart with a running VM task

**Test:** With a running `dispatch:claude-code` VM task, restart `substrate-dispatcher.service`.
**Expected:** Log `re-adopted VM task <graph>/<node>`; no orphaned VM; no second `dispatch.failed`.
**Why human:** Needs a live dispatcher and a real VM task; in-repo tests use a fake host.

### Gaps Summary

No gaps. Both roadmap criteria are implemented and exercised by passing in-repo tests. The phase is `human_needed` only because the two live proofs (egress enforcement on a host; dispatcher restart with a live VM task) are operator-gated and were not run. Hermes sessions are not persisted by design (D43-a).

**Not run:** Postgres-backed suites (no live DB used for this phase's checks); full `bun test`; `bunx tsc --noEmit`; `check:phase-close`.

---

_Verified: 2026-11-12T08:36:06Z_
_Verifier: Claude (gsd-verifier)_
