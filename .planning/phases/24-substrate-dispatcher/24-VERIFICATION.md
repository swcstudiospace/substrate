---
phase: 24-substrate-dispatcher
verified: 2026-11-19T00:53:45Z
status: human_needed
score: 3/5 roadmap success criteria verified
covered_files: [".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-01-PLAN.md", ".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-01-SUMMARY.md", ".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-02-PLAN.md", ".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-02-SUMMARY.md", ".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-03-PLAN.md", ".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-03-SUMMARY.md", ".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-04-PLAN.md", ".planning/milestones/v1.3-phases/24-substrate-dispatcher/24-04-SUMMARY.md", "docs/dispatcher.md", "docs/runbooks/dispatch-proof.md", "infra/vps/substrate-dispatcher.service", "packages/dispatcher/src/substrate_dispatcher/__init__.py", "packages/dispatcher/src/substrate_dispatcher/__main__.py", "packages/dispatcher/src/substrate_dispatcher/dispatch.py", "packages/dispatcher/src/substrate_dispatcher/handoff.py", "packages/dispatcher/src/substrate_dispatcher/host.py", "packages/dispatcher/src/substrate_dispatcher/launcher.py", "packages/dispatcher/src/substrate_dispatcher/linear.py", "packages/dispatcher/src/substrate_dispatcher/mcp.py", "packages/dispatcher/src/substrate_dispatcher/quota.py", "packages/dispatcher/src/substrate_dispatcher/sessions.py", "packages/dispatcher/src/substrate_dispatcher/worktree.py", "packages/dispatcher/tests/test_claude_code_route.py", "packages/dispatcher/tests/test_dispatch.py", "packages/dispatcher/tests/test_quota.py", "packages/dispatcher/tests/test_readoption.py", "packages/dispatcher/tests/test_sessions.py"]
covered_digest: "v4:sha256:8cf8a4681f978b78ac91ad364923e489f1961dfebb03614ae8d4b602313a5bfb"
behavior_unverified: 1
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 2/5
  gaps_closed:
    - "SC1 marker clause: at-capacity and graph-busy skips now post once-only markers (dispatch.py MARKERS, decide, EVENT_RETRYABLE_MARKERS; tests and docs/dispatcher.md updated)"
  gaps_remaining: []
  regressions: []
behavior_unverified_items:
  - truth: "SC3: the launched agent claims with its own surface token, heartbeats inside the TTL, completes with lease_id and DoD fields or releases, and reads issue text only through issue_get"
    test: "Dispatch one dispatch:hermes issue on a bounded live run and watch the Hermes session's graph_claim, graph_heartbeat and graph_complete/graph_release calls in the session log"
    expected: "Claim, renewals (at least every 10 minutes) and completion or release all carry the lease_id from the claim reply and the hermes surface token; no call is made by the dispatcher on the session's behalf"
    why_human: "The prompt template (launcher.py PROMPT_TEMPLATE) states these steps, but whether the live agent follows them is runtime behaviour; the rehearsal used a shell fake, and no test runs a real Hermes session"
coincidental_reliance_items: []
human_verification:
  - test: "Owner decision on the silent skip 'session already running for this issue' (dispatch.decide, active_issue_ids branch). It posts no comment; docs/dispatcher.md states this. Confirm that a launched issue is a dispatched issue and not a non-dispatch under SC1, or add a once-only marker for it and update the test and marker table."
    expected: "A recorded owner answer: either the silence stands (documented, no action) or a marker is added"
    why_human: "Scope interpretation of SC1 ('every non-dispatch'), not observable from code"
  - test: "SC5 bounded live window (DISP-08 runbook, docs/runbooks/dispatch-proof.md steps 1-8): with the kill switch set to 0 for the window only, label a Linear issue dispatch:hermes"
    expected: "A Hermes session starts within 30 s on the issue's Graph ID in /var/lib/substrate/worktrees/<graph_id> on branch substrate/<graph_id>; the claim lands under the Hermes token; Linear shows agent:hermes and Notion Agent hermes; the run ends in a gated Done or a release"
    why_human: "Requires live Linear, Notion, substrate-mcp and Hermes model quota under an operator-approved window; the runbook marks this OPERATOR-GATED and it was not run"
  - test: "SC5 Claude Code route: label a Linear issue dispatch:claude-code during the same window"
    expected: "A Claude Code brief names the claim within 60 s of labelling, delivered through substrate-host (127.0.0.1:7411, Lane A)"
    why_human: "Requires the live Lane A host and an agentOS VM; docs/runbooks/lane-a-host.md marks the restart OPERATOR-GATED"
  - test: "SC5 kill switch restored: after the window, confirm SUBSTRATE_DISPATCH_DISABLED=1 is the last line of /etc/substrate/substrate-dispatcher.env and the dispatcher logs 'dispatch disabled'"
    expected: "Kill switch on; no further launches"
    why_human: "Operator-owned env file; values are not in the repo and must not be read into this record"
  - test: "Deployment check: confirm /opt/agent-substrate/current (the unit's WorkingDirectory and ConditionPathExists) is a release cut from main, as SC1 requires 'run from main'"
    expected: "The pinned release symlink resolves to a main-based release containing packages/dispatcher/src/substrate_dispatcher/__main__.py"
    why_human: "Host state; not observable from the repository"
  - test: "SC3 live agent contract: watch the first live Hermes session's graph_claim, graph_heartbeat and graph_complete / graph_release calls in STATE_DIR/sessions/*.log"
    expected: "All calls carry the hermes surface token and the claim's lease_id; renewals occur at least every 10 minutes"
    why_human: "Runtime behaviour of the live agent"
---

# Phase 24: substrate-dispatcher Verification Report

**Phase Goal:** Labelling a Linear issue `dispatch:hermes` starts a lease-correct Hermes session on the issue's Graph ID in its own worktree, and every issue it does not dispatch says why.
**Verified:** 2026-11-19T00:53:45Z
**Status:** human_needed
**Re-verification:** Yes. The prior record (2026-11-18, gaps_found, 2/5) had one BLOCKER: SC1 marker clause.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: `substrate-dispatcher.service` reads unstarted `dispatch:*` issues every 30 s under a flock, re-reads `SUBSTRATE_DISPATCH_DISABLED` each tick, and every non-dispatch leaves one once-only marker comment | ✓ VERIFIED (marker clause); ⚠️ WARNING on one silent skip, see Human Verification 1 | `dispatch.py` `decide()` returns `comment` with `marker="at-capacity"` (capacity_left <= 0) and `marker="graph-busy"` (graph already running); both have `MARKERS` text. `tick()` posts them through `_comment_once`, which skips when the `[<marker>]` tag is among the issue's last 50 comments. Both markers are in `EVENT_RETRYABLE_MARKERS`, so they emit no `dispatch.failed`. `tick()` still reads `dispatch_disabled()` every call (poll and flock clauses unchanged; `__main__.py` and the unit file are not in the diff). Tests: `test_at_capacity_posts_one_queued_marker_then_launches_when_a_slot_frees`, `test_graph_busy_posts_one_queued_marker_and_does_not_launch`, `test_second_issue_on_a_live_graph_is_skipped` (now asserts one `[graph-busy]` comment). Docs: the marker table has both rows and the "at most one once-only comment per marker" text matches the code. |
| 2 | SC2: worktree at `/var/lib/substrate/worktrees/<graph_id>`, reused, origin-verified, refused below 5 GiB; hermes headless, claude-code to Lane A, others `not-dispatchable` | ✓ VERIFIED (carried forward) | `worktree.py`, `launcher.py`, `dispatch.py` `decide()` `not-dispatchable` branch. None of these files changed in the uncommitted diff, so the prior evidence stands. |
| 3 | SC3: the launched agent claims with its own surface token, heartbeats, completes or releases, and reads issue text through `issue_get` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `launcher.py` PROMPT_TEMPLATE states the steps and excludes issue text. The runtime claim/heartbeat behaviour of a live agent is not exercised by any test. Routed to Human Verification 6. |
| 4 | SC4: 900 s claim deadline stops the session (SIGTERM, then SIGKILL); exit without claim comments, removes the label, gives up; given-up set survives restart | ✓ VERIFIED (carried forward) | `sessions.py`: `CLAIM_TIMEOUT_SECONDS = 900`; `_reap_one` terminate, then kill after grace; exit branch `_comment_once("exited-unclaimed")`, then `_give_up()`. `sessions.py` is not in the diff. Warning carried from prior record: if substrate-mcp is unreadable at the 900 s mark, the session is not stopped until a read succeeds. |
| 5 | SC5: bounded live window: launch within 30 s, claim under the Hermes token, Linear and Notion show hermes, Claude Code brief within 60 s, kill switch restored | ? UNCERTAIN (operator-gated) | Not run. Human Verification 2 to 5. |

**Score:** 3/5 roadmap success criteria verified (SC1, SC2, SC4). SC3 is behaviour-unverified. SC5 is operator-gated.

### Silent Skips Reviewed (SC1 interpretation)

| Decision (`decide`) | Comment | Why it is acceptable |
| --- | --- | --- |
| `gave up on this issue (no claim)` | None on this tick | The give-up path always posted `exited-unclaimed` or `claim-timeout` before `_give_up()` (`sessions.py` 531-542), so the issue already carries its marker. |
| `session already running for this issue` | None | The issue was launched, so it is dispatched, not a non-dispatch. `docs/dispatcher.md` says so explicitly. This reading needs owner confirmation (Human Verification 1). |
| `at capacity` / `session already running for graph` | `[at-capacity]` / `[graph-busy]`, once only | Closed by this re-verification. |

**Reading of "exactly one":** every marker in the dispatcher uses the once-only tag scheme (`_comment_once`). The new markers follow the same convention, so a deferral repeated on later ticks posts nothing new. This matches the existing `already-claimed` and `no-node` behaviour.

### Test-Contract Changes in the Diff

- `test_at_capacity_skips_and_decides_again_next_tick` was rewritten. It previously asserted that no comment is posted at capacity, which codified the gap. It now asserts one `[at-capacity]` comment, then no further comment, then launch once a slot frees.
- Four assertions moved from `skip` to `comment`: `test_quota.py`, `test_readoption.py`, `test_sessions.py`, and `test_dispatch.py::test_second_issue_on_a_live_graph_is_skipped`.
- `test_claude_code_route.py` `EXPECTED_MARKERS` gained `at-capacity` and `graph-busy`.

### Spot-Check: Dispatcher Test Suite (run once)

```
uv run --no-project --with pytest --with pytest-timeout --with httpx pytest packages/dispatcher/tests --timeout 60000 -q
298 passed in 22.49s
```

0 failed, 0 skipped. The whole `packages/dispatcher/tests` directory was run once, as the assignment asked.

### Anti-Patterns

The uncommitted diff adds no `TODO`, `FIXME`, `XXX`, or `TBD` markers. The new `MARKERS` entries are real comment texts, not placeholders.

## Gaps Summary

No BLOCKER remains. The prior SC1 marker gap is closed in code, tests, and docs. Two decisions and two live proofs remain for a human. None of them is a code defect that this run can see.

---

_Verified: 2026-11-19T00:53:45Z_
_Verifier: Claude (gsd-verifier)_
