---
phase: 33-lane-a-dispatch-route-and-approvals
verified: 2026-11-18T12:23:32Z
status: human_needed
score: 2/3 roadmap success criteria verified in code and rehearsal; criterion 3 live proof outstanding
behavior_unverified: 0
overrides_applied: 0
covered_files: [".planning/milestones/v1.3-phases/33-lane-a-dispatch-route-and-approvals/33-01-PLAN.md", ".planning/milestones/v1.3-phases/33-lane-a-dispatch-route-and-approvals/33-01-SUMMARY.md", ".planning/milestones/v1.3-phases/33-lane-a-dispatch-route-and-approvals/33-02-PLAN.md", ".planning/milestones/v1.3-phases/33-lane-a-dispatch-route-and-approvals/33-02-SUMMARY.md", ".planning/milestones/v1.3-phases/33-lane-a-dispatch-route-and-approvals/33-03-PLAN.md", ".planning/milestones/v1.3-phases/33-lane-a-dispatch-route-and-approvals/33-03-SUMMARY.md", "docs/runbooks/dispatch-proof.md", "packages/dispatcher/src/substrate_dispatcher/dispatch.py", "packages/dispatcher/src/substrate_dispatcher/host.py", "packages/dispatcher/tests/test_claude_code_route.py", "packages/host/src/hostfns.ts", "packages/host/src/tasks.ts", "packages/host/src/telegram.ts", "scripts/lane-a-e2e.ts"]
covered_digest: "v3:sha256:164c3c083531dbe5a2d1ec3523eb05bf4a0d5fd82e0162ae4391b378d8e6681c"
human_verification:
  - test: "Live G1 to G5 gated tail per docs/runbooks/dispatch-proof.md: apply the `dispatch:claude-code` label to a fresh issue on a throwaway repo and isolated graph, watch the VM open and claim, restart substrate-host mid-session, tap Approve and Deny in the approval bot, and confirm a real push, PR, PR-field sync and gated Done."
    expected: "The session resumes on the same session id after the restart; each permission request is answered by exactly one tap; an unanswered request is rejected at its deadline; the push and PR land on the throwaway repo; the Linear issue reaches a gated Done."
    why_human: "Requires live Linear, Notion, GitHub, the model route, the Telegram approval channel, >= 10 GiB free disk, and an operator approval at each gate. Not runnable from the repository."
  - test: "Confirm the Telegram approval message appears on the channel the operator calls the stop-notify path."
    expected: "A permission_request posts one message with Approve and Deny buttons only, naming the graph and node."
    why_human: "The phrase `existing Telegram stop-notify path` in ROADMAP criterion 2 has no identifier in the repository (grep finds it only in planning documents). The approval broker is wired in packages/host/src/main.ts via createApprovals. The operator must confirm this is the intended channel."
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 33: Lane A dispatch route and approvals - Verification

**Phase Goal:** A `dispatch:claude-code` label takes a Linear issue all the way to a gated Done through a Lane A VM, with a human approving each permission request.
**Verified:** 2026-11-18T12:23:32Z at tip `357d6b15` (branch `gsd/autonomous-rerun`)
**Status:** human_needed
**Scope:** ROADMAP success criteria 1 to 3 for phase 33. Live operator actions are human_needed, not gaps.

**Phase directory note:** `.planning/phases/33-...` held no plan or summary files at this tip. The phase's plans, summaries and prior verification live under `.planning/milestones/v1.3-phases/33-lane-a-dispatch-route-and-approvals/`. Those records were used as the plan source. The archived `33-VERIFICATION.md` (status passed, rehearsal scope, recorded at `ed696ef`) was treated as a claim to check, not as evidence.

## Goal Achievement

### Success Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Dispatcher routes `dispatch:claude-code` to `POST /tasks`; a refusal becomes a once-only Linear comment | VERIFIED | `dispatch.py` launch_fn (about line 562) sends `candidate.surface == "claude-code"` to `open_task(**ids)` and never to the hermes launcher. `host.py` `HostClient.open_task` posts to `/tasks` (line 129) and raises `HostRefused(..., "host-refused", may_be_open=False)` on a refusal. Targeted run: `python3 -m pytest packages/dispatcher/tests/test_claude_code_route.py -q` gives **14 passed**. `test_claude_code_refusal_comments_once_with_host_text_in_journal_only` (parametrised 400/409/502) asserts exactly one `[host-refused]` comment across two ticks, and asserts that the host's error text stays out of Linear. |
| 2 | Permission requests reach a human through single-use Approve/Deny buttons on the existing Telegram stop-notify path; an unanswered request times out | VERIFIED (rehearsal and code); live tap is a human item | `telegram.ts` `renderApprovalMessage` offers only an `allow_once` (Approve) and a `reject_once` (Deny) option and never the standing-permission option. `ApprovalBroker` refuses unauthorised callers and expired keys. Tests pass in `bun test packages/host/src/telegram.test.ts packages/host/src/tasks.test.ts`: **96 pass, 0 fail**. This covers the single-use test (second tap reads expired), the tap-vs-timeout race (`tasks.test.ts` "the sweep wins once, the late tap reads not_pending"), and planted-secret redaction. Timeout: `tasks.ts` `APPROVAL_TIMEOUT_MS = 900_000` (line 40). `recordApproval` stamps `deadlineMs` (line 1037). `sweepApprovalTimeouts` (line 1111) answers each expired request with `reject_once`. `main.ts` line 165 wires `createApprovals`. See the human item on the channel name. |
| 3 | `dispatch:claude-code` on a fresh issue opens a VM that claims and heartbeats; restarting `substrate-host` mid-session resumes the same session; a real push and PR land, the PR fields sync, and the issue reaches a gated Done | HUMAN_NEEDED (live proof outstanding); rehearsal harness currently RED | Code and unit paths exist: `hostfns.ts` `commit`, `gitPush`, `prCreate` (sites at lines 267 and 338); `tasks.ts` `heartbeatOrReclaim` (line 669) and the resume path. Targeted run: `bun test packages/host/src/hostfns.test.ts` gives **33 pass, 0 fail**. Resume and re-claim tests in `tasks.test.ts` (lines 661 to 844) pass in the 96-test run above. Rehearsal chain `bun scripts/lane-a-e2e.ts` gives **27/29**. Two checks fail: `host-side commit` and `push to the fixed branch`, both with `{"error":"worktree .git is missing"}`. The cause is in the harness, not the product path. `scripts/lane-a-e2e.ts` builds `hostCtx` without `worktreeRoot`, so `siteFor` resolves the production path `/var/lib/substrate/worktrees/<gid>`, which does not exist in the run. The `.git` back-pointer check was added by `fa8a467d` (host API and git boundary hardening), after the chain was written in `ac517777` (33-03). The archived record's "29/29 at ed696ef" no longer reproduces at this tip. The live tail (G1 to G5 in `docs/runbooks/dispatch-proof.md`) has not been run and cannot be run from the repository. |

**Score:** 2/3 criteria verified. Criterion 3 is human_needed.

### Warnings

1. **WARNING: rehearsal chain red at tip.** `scripts/lane-a-e2e.ts` gives 27/29 at `357d6b15`. The two failing checks are the commit and push steps. The fix belongs in the harness: pass `worktreeRoot` pointing at a tmp worktree that has a real `.git` back-pointer, as the hardened git boundary expects. This is not a product-code defect, because the 33 `hostfns` unit tests pass. Not fixed here; this verifier edits only this file.
2. **WARNING: "stop-notify path" has no code identifier.** ROADMAP criterion 2 and REQUIREMENTS LANEA-06 name it. The repository's only match is in planning documents. The approval bot in `telegram.ts`, wired from `main.ts`, is the closest implementation. The operator should confirm that this channel is the intended one.
3. **INFO: archived record is stale.** `.planning/milestones/v1.3-phases/33-lane-a-dispatch-route-and-approvals/33-VERIFICATION.md` says "29/29 at ed696ef". That claim does not hold at `357d6b15` (see Warning 1).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/dispatcher/src/substrate_dispatcher/dispatch.py` | claude-code branch to `open_task` | VERIFIED | Lines 562 to 571. |
| `packages/dispatcher/src/substrate_dispatcher/host.py` | `open_task` to `POST /tasks`; `HostRefused` | VERIFIED | Lines 117 to 147. |
| `packages/dispatcher/tests/test_claude_code_route.py` | route and refusal tests | VERIFIED | 14 pass. |
| `packages/host/src/telegram.ts` | single-use Approve/Deny broker | VERIFIED | Only `allow_once` and `reject_once` are offered. |
| `packages/host/src/tasks.ts` | approval deadline, sweep, resume, heartbeat | VERIFIED (rehearsal) | Lines 40, 669, 1037, 1111. |
| `packages/host/src/hostfns.ts` | commit, push, PR host functions | VERIFIED (unit) | 33 pass. Live push and PR not run. |
| `scripts/lane-a-e2e.ts` | one-command fake chain | STALE | 27/29 at tip; harness missing `worktreeRoot`. |
| `docs/runbooks/dispatch-proof.md` | G1 to G5 gate runbook | VERIFIED | Gates are marked OPERATOR-GATED. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `dispatch.py` launch_fn | `host.py` `HostClient.open_task` | `open_task(**ids)` for surface `claude-code` | WIRED | Confirmed by the route tests. |
| `host.py` `open_task` | substrate-host `POST /tasks` | `self._client.post("/tasks")` | WIRED | Confirmed by the route tests. |
| `HostRefused` | once-only Linear comment | `[host-refused]` marker, dedup across ticks | WIRED | Confirmed by the refusal test. |
| `main.ts` | `telegram.ts` `createApprovals` | line 165 | WIRED | Off unless all three `SUBSTRATE_APPROVAL_*` keys are set. |
| `ApprovalBroker` tap | `TaskService.respondApproval` | authorised single-use callback | WIRED | Confirmed by the single-use tests. |
| `sweepApprovalTimeouts` | `respondApproval(reject_once)` | expired `deadlineMs` | WIRED | Confirmed by the timeout tests. |

### Data-Flow Trace (Level 4)

Not applicable. Phase 33 is dispatch and approval control flow, not rendered data.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Claude-code route and once-only refusal | `python3 -m pytest packages/dispatcher/tests/test_claude_code_route.py -q` | 14 passed | PASS |
| Approval single-use, timeout, resume | `bun test packages/host/src/telegram.test.ts packages/host/src/tasks.test.ts` | 96 pass, 0 fail | PASS |
| Commit, push and PR host functions | `bun test packages/host/src/hostfns.test.ts` | 33 pass, 0 fail | PASS |
| Fake label-to-Done chain | `bun scripts/lane-a-e2e.ts` | 27/29; commit and push checks fail (`worktree .git is missing`) | FAIL (harness) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes are declared for this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| LANEA-04 | 33-01 | `dispatch:claude-code` route to `POST /tasks`; refusal comments once | SATISFIED (rehearsal) | Route tests, criterion 1. |
| LANEA-06 | 33-02 | Single-use Approve/Deny; unanswered request times out | SATISFIED (rehearsal); live tap human | Telegram and tasks tests, criterion 2. |
| LANEA-08 | 33-03 | Label to gated Done, with live proof | NEEDS HUMAN (live tail G1 to G5); chain red | Chain 27/29; live gates not run. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `scripts/lane-a-e2e.ts` | 452 to 457 | `hostCtx` omits `worktreeRoot`; stale against hardened git boundary | WARNING | Rehearsal red at tip; does not reflect product behavior. |

No TODO, FIXME or placeholder markers were found in the phase's dispatcher or host files covered above.

### Human Verification Required

1. **Live G1 to G5 gated tail.** Follow `docs/runbooks/dispatch-proof.md` on a throwaway repo and isolated graph. Apply the label, watch the VM claim and heartbeat, restart `substrate-host` mid-session, tap Approve and Deny, and confirm a real push, PR, PR-field sync and gated Done. Expected: the same session resumes after the restart, each request is answered by one tap, an unanswered request is rejected at its deadline, and the issue reaches a gated Done. Why human: it needs live Linear, Notion, GitHub, the model route, the Telegram channel, disk, and operator approval at each gate.
2. **Confirm the approval channel name.** Expected: one permission message with Approve and Deny buttons only. Why human: "stop-notify path" has no code identifier, so the operator must confirm the channel.

### Gaps Summary

No product-code gap was found for criteria 1 and 2. Both are verified by code and by targeted tests run at tip. Criterion 3 requires live operator proof, so it is human_needed and not a gap. The one actionable defect is that the fake chain `scripts/lane-a-e2e.ts` is red (27/29) at tip. Its commit and push checks need the harness to pass a `worktreeRoot`. Fixing it is outside this verifier's scope.

---

_Verified: 2026-11-18T12:23:32Z_
_Verifier: Claude (gsd-verifier)_
