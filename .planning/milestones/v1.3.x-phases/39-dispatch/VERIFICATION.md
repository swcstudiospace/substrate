---
phase: 39-dispatch
verified: 2026-11-12T08:36:25Z
status: human_needed
score: "2/2 success criteria verified in-repo at HEAD af4c4278; 2 operator-gated live checks open"
covered_files: [".planning/milestones/v1.3.x-phases/39-dispatch/PLAN.md", ".planning/milestones/v1.3.x-phases/39-dispatch/SUMMARY.md", "packages/dispatcher/src/substrate_dispatcher/__main__.py", "packages/dispatcher/src/substrate_dispatcher/dispatch.py", "packages/dispatcher/src/substrate_dispatcher/handoff.py", "packages/dispatcher/tests/test_dispatch.py", "packages/dispatcher/tests/test_handoff.py", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/handoff.test.ts", "packages/mcp-server/src/handoff.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:479292b7d442daddf0b8b094fe0dfd748535b70cdb2773cb1dca209d79fa5687"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Production signing: confirm SUBSTRATE_HANDOFF_KEY is set on the substrate-mcp host (name only, never print the value). Dispatch one test issue, then call coord_handoff_list with its graph ID."
    expected: "The packet verdict is ok: true with a key_id, not unsigned."
    why_human: "Needs the production host environment and a live dispatch. Without the key, packets are recorded as unsigned. Not set in this verification."
  - test: "Live drift run: pick a Lane B worktree with known drift, dispatch one issue for it, and check the ledger."
    expected: "One dispatch.handoff warning with payload status 'drift' is recorded before the handoff packet for that node, and the launch proceeds."
    why_human: "Needs a real worktree on the dispatcher host. Not run here."
---

# 39-VERIFICATION: DISPATCH

**Phase Goal:** Dispatch is a signed handoff packet, and the worktree is drift-scanned before any session launches.
**Verified:** 2026-11-12T08:36:25Z
**Status:** human_needed
**Re-verification:** Yes. Regenerated against HEAD af4c4278. The prior report (2026-10-21) cited base 1d4e4aa.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | Dispatch is a signed handoff packet (goal from the issue identifier, fixed DoD lines, files), replayable from the ledger | ✓ VERIFIED (in-repo) | Build and sign: `packages/mcp-server/src/handoff.ts:260` buildHandoff, `:319` signHandoff (null signer gives unsigned), `:347` verifyHandoff. Packet written at `packages/mcp-server/src/service.ts:7427-7450`. Replay: `service.ts:7514` handoffsForGraph, exposed as `coord_handoff_list` at `mcp.ts:1958`. Dispatcher packet: `handoff.py:67` packet_arguments, `:184` post_handoff, DISPATCH_DOD at `:49`. Tests run now: `handoff.test.ts` 30 pass, 0 fail (including "a signed packet verifies" and "a Grok to Hermes handoff replays with nothing but the packet"). `test_kill_after_post_replay_rebuilds_the_dispatch_context_from_the_ledger` passes. |
| 2 | `coord_drift_scan` runs on the worktree before launch, with a stale-brief warning before acting | ✓ VERIFIED (in-repo) | Order: `dispatch.py:538-553` launch_fn calls prelaunch after `ensure` and before the launch. `handoff.py:164` drift_findings, `:284` prelaunch (scan, then warning, then post). Warning at `handoff.py:302-310` with status "drift" (summary at `:121`). Tests run now: `test_prelaunch_scans_drift_then_posts_the_packet_before_any_launch` passes; full dispatcher suite 289 passed. Substrate side: `service.ts:7595` driftScan; `mcp.ts:1976` registration. |

**Score:** 2/2 truths verified in-repo. Behavior-unverified: 0 (both behavior-dependent truths have passing tests).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/dispatcher/src/substrate_dispatcher/handoff.py` | Pre-launch drift scan, warning, packet post | ✓ VERIFIED | Wired from `__main__.py:161` via `make_prelaunch(mcp)` |
| `packages/dispatcher/src/substrate_dispatcher/dispatch.py` | launch_fn runs prelaunch before launch | ✓ VERIFIED | `:522`, `:538-553`; a broken prelaunch is logged and the launch proceeds |
| `packages/mcp-server/src/handoff.ts` | Build, sign, verify packet | ✓ VERIFIED | `:260`, `:319`, `:347`; key rotation read in `config.ts` (SUBSTRATE_HANDOFF_KEY and _PREV, `:1036`) |
| `packages/mcp-server/src/service.ts` | Write-time signing, ledger replay, drift gather | ✓ VERIFIED | `:7427-7450`, `:7514`, `:7595` |
| `packages/mcp-server/src/mcp.ts` | Tool registration for replay and drift | ✓ VERIFIED | `coord_handoff_list` `:1958`, `coord_drift_scan` `:1976` |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `dispatch.py` launch_fn | `handoff.py` prelaunch | injected `prelaunch=make_prelaunch(mcp)` (`__main__.py:161`) | ✓ WIRED | Called before the launch (`dispatch.py:538`) |
| `handoff.py` post_handoff | MCP packet write | `packet_arguments` → `dispatch.handoff` | ✓ WIRED | `service.ts:7427-7450` signs at write time |
| `service.ts` handoffsForGraph | `coord_handoff_list` | `mcp.ts:1971` | ✓ WIRED | Ledger replay returns each packet with its verdict |
| `handoff.py` drift_findings | `coord_drift_scan` | MCP tool call | ✓ WIRED | `service.ts:7595` driftScan; `mcp.ts:1976` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `handoff.py` packet | goal, files, dod | identifiers, worktree path, fixed DOD lines | Yes (ids and pointers, by design) | ✓ FLOWING |
| `service.ts` replay | handoff list | ledger events via `handoffsForGraph` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Dispatcher suite passes | `python3 -m pytest packages/dispatcher/tests -q` | 289 passed in 3.05s | ✓ PASS |
| Handoff signing and replay | `bun test packages/mcp-server/src/handoff.test.ts` | 30 pass, 0 fail, 203 expect() calls | ✓ PASS |
| Pre-launch order (named test) | `python3 -m pytest packages/dispatcher/tests/test_handoff.py::test_prelaunch_scans_drift_then_posts_the_packet_before_any_launch` | passed | ✓ PASS |
| Ledger replay (named test) | `python3 -m pytest packages/dispatcher/tests/test_handoff.py::test_kill_after_post_replay_rebuilds_the_dispatch_context_from_the_ledger` | passed | ✓ PASS |

### Probe Execution

Not applicable: not a migration phase, and no `scripts/*/tests/probe-*.sh` is declared for this phase.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| C-D2 | 39-PLAN | Dispatch as a signed handoff packet (goal from the issue, DoD lines, files), replayable from the ledger | ✓ SATISFIED in-repo; production signing needs the operator | Truth 1; REQUIREMENTS.md:34 |
| C-D4 | 39-PLAN | Run `coord_drift_scan` before launch; stale-brief warning | ✓ SATISFIED in-repo; live run needs the operator | Truth 2; REQUIREMENTS.md:37 |

No orphaned requirements: both requirement IDs assigned to this phase (C-D2, C-D4) are claimed by the plan.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `.planning/milestones/v1.3.x-phases/39-dispatch/PLAN.md` (Verification plan), SUMMARY.md, prior VERIFICATION.md | — | Stale evidence claim: "No product code changed since 3aea2d0 / the full suite run" | ⚠️ Warning | False at HEAD. `git diff --stat 3aea2d0 HEAD` over the covered paths shows 14 files changed (7380 insertions, 495 deletions), including `handoff.ts` (+119) and `service.ts`. The claim holds for the 1d4e4aa base only. The full repository suite was not re-run here; the in-repo results above come from the current tree. |
| covered files | — | `TBD` / `FIXME` / `XXX` debt markers | ✓ None found | Debt-marker gate passes |

No blocker anti-patterns found.

### Human Verification Required

### 1. Production signing

**Test:** Confirm `SUBSTRATE_HANDOFF_KEY` is set on the substrate-mcp host (name only; never print the value). Dispatch one test issue, then call `coord_handoff_list` with its graph ID.
**Expected:** The packet verdict is `ok: true` with a `key_id`, not unsigned.
**Why human:** Needs the production host environment. Without the key, packets are recorded as `status: "unsigned"`. Not set in this verification.

### 2. Live drift run on Lane B

**Test:** Pick a Lane B worktree with known drift, dispatch one issue for it, and check the ledger.
**Expected:** One `dispatch.handoff` warning with payload `status: "drift"` is recorded before the handoff packet for that node.
**Why human:** Needs a real worktree and dispatcher host. Not run.

### Gaps Summary

No gaps. Both ROADMAP success criteria are met in the repository at HEAD af4c4278, backed by passing tests run in this verification. The status is `human_needed` because two operator-gated live checks (the production signing key and a live drift run) are open. The stale "no product code changed" evidence claim is recorded as a warning, not a gap.

---

_Verified: 2026-11-12T08:36:25Z_
_Verifier: Claude (gsd-verifier)_
