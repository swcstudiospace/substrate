---
phase: 32-lane-a-host-core
verified: 2026-11-12T08:30:11Z
status: human_needed
score: 15/15 truths verified in rehearsal (fakes only); live L1-L4 and live restart proof OPERATOR-GATED, not run
behavior_unverified: 0
overrides_applied: 0
covered_files: [".planning/milestones/v1.3-phases/32-lane-a-host-core/32-01-PLAN.md", ".planning/milestones/v1.3-phases/32-lane-a-host-core/32-01-SUMMARY.md", ".planning/milestones/v1.3-phases/32-lane-a-host-core/32-02-PLAN.md", ".planning/milestones/v1.3-phases/32-lane-a-host-core/32-02-SUMMARY.md", ".planning/milestones/v1.3-phases/32-lane-a-host-core/32-03-PLAN.md", ".planning/milestones/v1.3-phases/32-lane-a-host-core/32-03-SUMMARY.md", "docs/runbooks/lane-a-host.md", "infra/vps/substrate-host.service", "packages/host/src/hostfns.test.ts", "packages/host/src/main.ts", "packages/host/src/seed.test.ts", "packages/host/src/seed.ts", "packages/host/src/substrate.ts", "packages/host/src/sync.test.ts", "packages/host/src/tasks.test.ts", "packages/host/src/tasks.ts", "packages/host/src/vm.ts", "scripts/host-restart.test.ts", "scripts/host-smoke.test.ts", "scripts/host-smoke.ts"]
covered_digest: "v3:sha256:31822c98161b7d4502780e7c2de637911749e11d594d6d15839d9820372a891a"
human_verification:
  - test: "L1: real VM-backed node run on an isolated graph with a throwaway repo (runbook L1, OPERATOR-GATED)"
    expected: "openTask claims and heartbeats on the live substrate; commit/push/PR land on the throwaway repo; complete reaches graph_complete"
    why_human: "Spends Claude Code model quota and Docker capacity; requires an approved window. Fakes cannot prove live substrate behavior."
  - test: "Live restart mid-session (roadmap Phase 32 Proof; runbook L2, OPERATOR-GATED)"
    expected: "After stop/start of substrate-host, exactly one resume:1 continuation runs against the same session; a second boot sends nothing"
    why_human: "Requires installing/restarting the production unit in an approved window. Only the fake-VM restart rehearsal has run."
---

# Phase 32: Lane A host core Verification Report

**Phase Goal:** A host task works its node under the `claude-code` lease from start to finish, survives a host restart, and keeps every credential on the host.
**Verified:** 2026-11-12T08:30:11Z
**Status:** human_needed
**Re-verification:** No — fresh initial verification of the phase artifacts at HEAD (prior 32-VERIFICATION.md from 2026-10-11 was overwritten; its `passed` status did not account for the operator-gated proof in the roadmap).

## Goal Achievement

### Observable Truths

Roadmap success criteria (SC1-3) are the contract; plan must-haves (32-01/02/03) add detail. Evidence is from code read at HEAD and fake-based tests run in this session.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| SC1 | openTask claims as claude-code, keeps lease_id, heartbeats, seeds with sha256 read-back, opens ask-policy, releases on failure | ✓ VERIFIED | `tasks.ts:782-792` claimAndPersist + persist-then-verify; `tasks.ts:669-689` heartbeatOrReclaim; `tasks.ts:624` releaseOnce; `tasks.ts:824-826` sha256 read-back; tests `tasks.test.ts:436-535` |
| SC2 | After host restart, `<gid>:<nid>:resume:<n>` continuation resumes the work | ✓ VERIFIED (fakes) | `tasks.ts:976-1006` resumeInterrupted with heartbeat-or-reclaim; `scripts/host-restart.test.ts:186` kill→reboot one resume:1, third boot none; `tasks.test.ts:661-692` |
| SC3 | VM holds no tokens; host functions commit/push/PR and sync PR fields | ✓ VERIFIED (fakes) | `seed.test.ts:437,453` bearer in exactly one entry file or zero; `hostfns.test.ts:129,449` argvs fixed, no force/refspec; `scripts/host-smoke.ts` worked-node 38/38 |
| 1 (01) | openTask persists granted lease_id beside task record; logs presence only | ✓ VERIFIED | `substrate.ts:327-340` claimAndPersist; `substrate.ts:149-176` LeaseStore 0600; `main.ts:135` leases dir beside tasks; `tasks.test.ts:437,450` |
| 2 (01) | Heartbeat inside TTL while turn in flight; refused heartbeat → exactly one re-claim | ✓ VERIFIED | `tasks.ts:644` tick armed; `tasks.ts:669-689`; `tasks.test.ts:478,492,506` |
| 3 (01) | Every terminal path releases exactly once | ✓ VERIFIED | `tasks.ts:624` releaseOnce guarded by `released`; `tasks.ts:898,913,1180,1196`; `tasks.test.ts:405,523,535,555,567,577` |
| 4 (01) | Lease unverifiable at open → release + 502 | ✓ VERIFIED | `tasks.ts:782-788`; `tasks.test.ts:465` |
| 5 (02) | Kill mid-turn, reboot → exactly one resume-keyed continuation | ✓ VERIFIED (fakes) | `tasks.ts:976`; `scripts/host-restart.test.ts:186`; `tasks.test.ts:661` |
| 6 (02) | Second boot without new work sends zero prompts | ✓ VERIFIED (fakes) | `tasks.test.ts:692` (same-process second call sends nothing); `scripts/host-restart.test.ts:186` third boot |
| 7 (02) | Before each continuation: route re-established, heartbeat-or-reclaim | ✓ VERIFIED | `tasks.ts:999` heartbeatOrReclaim in resume; `tasks.test.ts:794-810` route→heartbeat→prompt order |
| 8 (02) | Route/heartbeat failure fails that task alone; others resume | ✓ VERIFIED | `tasks.test.ts:825,844`; `scripts/host-restart.test.ts:235`; `tasks.ts:1003` |
| 9 (03) | No token, bearer, or lease_id in VM env, sandbox options, or seed files except one loopback MCP entry | ✓ VERIFIED | `seed.ts:279,314` substrateProxyLoopback gate; `seed.test.ts:437,453`; `host-smoke` containment checks |
| 10 (03) | Commit/push/PR-create/sync run host-side end to end with fixed targets | ✓ VERIFIED (fakes) | `hostfns.test.ts:449`; `scripts/host-smoke.ts` worked-node checks (38/38 run this session) |
| 11 (03) | Runbook carries lease table, restart sequence, containment inventory, L1-L4 gated tail | ✓ VERIFIED | `docs/runbooks/lane-a-host.md:161-187` L1-L4 gates; 10 OPERATOR-GATED occurrences |
| 12 (03) | Manifest stays `dormant:31` in this phase | ✓ VERIFIED | `infra/identity/clients.json` substrate-host row `dormant:31`; `git diff` empty for that file |
| 13 | Unit keeps both stores under StateDirectory and SIGTERM reaches beginShutdown | ✓ VERIFIED | `infra/vps/substrate-host.service:27,59,66,68` (ConditionPathExists, TimeoutStopSec=15, StateDirectory=substrate); `scripts/doctor-units.test.ts` 18/18 |
| 14 | Restart sequence documented as OPERATOR-GATED, never run | ✓ VERIFIED | `docs/runbooks/lane-a-host.md:50,161-187` |
| 15 | No live side effects in this phase's proofs | ✓ VERIFIED | All tests and smoke use fakes; no VM, unit or manifest change |

**Score:** 15/15 truths verified in rehearsal (0 PRESENT_BEHAVIOR_UNVERIFIED; behavior-dependent truths are backed by named passing tests). Live proof is not in this count — see Human Verification.

### Deferred Items

None. The live restart and L1 run are phase-internal human gates, not deferred to a later phase.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/host/src/tasks.ts` | Lease lifecycle, heartbeat, release, resume | ✓ VERIFIED | Substantive, wired via main.ts and tests |
| `packages/host/src/substrate.ts` | claimAndPersist, LeaseStore, graphComplete with lease_id | ✓ VERIFIED | Used by tasks.ts |
| `packages/host/src/seed.ts` | Bearer loopback scoping | ✓ VERIFIED | `substrateProxyLoopback` used at line 314 |
| `scripts/host-restart.test.ts` | Kill-and-restart rehearsal | ✓ VERIFIED | 2/2 pass this session |
| `scripts/host-smoke.ts` | Worked-node rehearsal | ✓ VERIFIED | 38/38 pass this session |
| `docs/runbooks/lane-a-host.md` | Tables + L1-L4 gated tail | ✓ VERIFIED | OPERATOR-GATED markers present |
| `infra/vps/substrate-host.service` | Staged unit restart semantics | ✓ VERIFIED (staged only) | Not installed; L2 gated |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| tasks.ts openTask | SubstrateClient.claimAndPersist | `tasks.ts:782` | ✓ WIRED | |
| claimAndPersist | LeaseStore beside TaskStore | `main.ts:135` `<storage>/leases` | ✓ WIRED | |
| startPrompt tick | heartbeatOrReclaim → releaseOnce | `tasks.ts:644,713,716` | ✓ WIRED | |
| resumeInterrupted | heartbeatOrReclaim | `tasks.ts:999` | ✓ WIRED | |
| complete | graphComplete with lease_id + DoD | `tasks.ts:747` | ✓ WIRED | |
| seed bearer | single loopback entry file | `seed.ts:314` | ✓ WIRED | |

### Data-Flow Trace (Level 4)

Not applicable beyond the lease and task-record flows, which the fake-based tests exercise (state read back from on-disk LeaseStore/TaskStore in the restart rehearsal).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Host package + restart + doctor-unit suites | `bun test packages/host/ scripts/host-restart.test.ts scripts/doctor-units.test.ts` | 334 pass, 0 fail, 14 files | ✓ PASS |
| Worked-node rehearsal | `bun run smoke:host` | 38 checks green, exit 0 | ✓ PASS |

Not run: `bunx tsc --noEmit`, full `bun test`, and `bun test scripts/rehearsal.test.ts` (known pre-existing env failure, out of scope).

### Probe Execution

No probes declared for this phase.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| LANEA-02 | 32-01, 32-02 | Lease claim, persist, heartbeat, release, restart resume | ✓ SATISFIED (fakes) | Truths 1-8, SC1 |
| LANEA-03 | 32-02 | Durable session, resume-keyed continuation after restart | ✓ SATISFIED (fakes) | Truths 5-8, SC2; live restart pending human |
| LANEA-07 | 32-03 | Credentials stay on host; host-side commit/push/PR/sync | ✓ SATISFIED (fakes) | Truths 9-10, SC3 |

### Anti-Patterns Found

None blocking. No stubs or placeholder returns found in the cited sections; `scripts/host-smoke.ts` and tests use fakes by design (documented, not a stub).

### Human Verification Required

### 1. L1 real VM-backed node run (OPERATOR-GATED)

**Test:** Follow runbook L1 on an isolated graph with a throwaway repository, within an approved window.
**Expected:** Claim and heartbeats land on the live substrate; push and PR land on the throwaway repo; complete reaches graph_complete with DoD and lease.
**Why human:** Spends Claude Code quota and Docker capacity; needs operator approval and live systems.

### 2. Live restart mid-session (OPERATOR-GATED)

**Test:** Runbook L2: install/restart the production substrate-host unit in an approved window while a task is mid-turn.
**Expected:** Exactly one resume:1 continuation against the same session; a second boot sends nothing.
**Why human:** Production unit install/restart is operator-gated; only the fake-VM rehearsal has run.

## Gaps Summary

No code or test gaps. All 15 truths are verified against code and passing fake-based tests run in this session. Status is `human_needed` rather than `passed` because the roadmap Phase 32 Proof requires a live, operator-approved run (L1 and the live restart), and those cannot be verified programmatically. The prior 2026-10-11 report marked `passed`; that overstated the result by not treating the operator-gated proofs as human items.

---

_Verified: 2026-11-12T08:30:11Z_
_Verifier: Claude (gsd-verifier)_
