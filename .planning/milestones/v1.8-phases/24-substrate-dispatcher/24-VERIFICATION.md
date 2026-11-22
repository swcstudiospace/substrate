---
phase: 24-substrate-dispatcher
verified: 2026-11-19T12:30:13Z
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
    - "SC1 already-running clause: an issue with a running session now posts one once-only [already-running] marker (commit 248a6572, dispatch.py decide + MARKERS); prior record asked for an owner decision, superseded by this marker"
    - "Reap path: run_loop does readopt -> reap -> tick each iteration (__main__.py); reap drops exited sessions via _remove_exited/_drop_session (sessions.py) freeing capacity for queued at-capacity/graph-busy re-decision; comment decisions never launch"
  gaps_remaining: []
  regressions: []
behavior_unverified_items:
  - truth: "SC3: the launched agent claims with its own surface token, heartbeats inside the TTL, completes with lease_id and DoD fields or releases, and reads issue text only through issue_get"
    test: "Dispatch one dispatch:hermes issue on a bounded live run and watch the Hermes session's graph_claim, graph_heartbeat and graph_complete/graph_release calls in the session log"
    expected: "Claim, renewals (at least every 10 minutes) and completion or release all carry the lease_id from the claim reply and the hermes surface token; no call is made by the dispatcher on the session's behalf"
    why_human: "The prompt template (launcher.py PROMPT_TEMPLATE) states these steps, but whether the live agent follows them is runtime behaviour; the rehearsal used a shell fake, and no test runs a real Hermes session"
coincidental_reliance_items: []
human_verification:
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
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 24: substrate-dispatcher Verification Report

**Phase Goal:** Labelling a Linear issue `dispatch:hermes` starts a lease-correct Hermes session on the issue's Graph ID in its own worktree, and every issue it does not dispatch says why.
**Verified:** 2026-11-19T12:30:13Z
**Status:** human_needed
**Re-verification:** Yes. Refresh of the 2026-11-19T00:53:45Z record (human_needed, 3/5) against commit 248a6572 (once-only markers for at-capacity, graph-busy and already-running). This run inspected code and the commit diff only; it ran no tests, tsc, biome, knip or formatters per the assignment.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: `substrate-dispatcher.service` reads unstarted `dispatch:*` issues every 30 s under a flock, re-reads `SUBSTRATE_DISPATCH_DISABLED` each tick, and every non-dispatch leaves one once-only marker comment | ✓ VERIFIED | `dispatch.py` `MARKERS` carries `at-capacity`, `graph-busy`, `already-running`. `decide()` returns `comment` with `marker="already-running"` (active issue branch, line 261), `marker="graph-busy"` (active graph branch), `marker="at-capacity"` (capacity_left <= 0); the only remaining `Decision("skip", ...)` is the gave-up branch (line 259). `tick()` posts comment decisions via `_comment_once` (tag check over last 50 comments) and `_maybe_emit_failed`; all three markers are in `EVENT_RETRYABLE_MARKERS`, so no `dispatch.failed` event is emitted (queued retry). `fetch`→`decide`→`comment` wiring verified. `docs/dispatcher.md` marker table lists all three as queued, emits nothing. |
| 2 | SC2: worktree at `/var/lib/substrate/worktrees/<graph_id>`, reused, origin-verified, refused below 5 GiB; hermes headless, claude-code to Lane A, others `not-dispatchable` | ✓ VERIFIED (carried forward) | `worktree.py`, `launcher.py`, `dispatch.py` `decide()` `not-dispatchable` branch. None of these files changed in commit 248a6572, so the prior evidence stands. |
| 3 | SC3: the launched agent claims with its own surface token, heartbeats, completes or releases, and reads issue text through `issue_get` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `launcher.py` PROMPT_TEMPLATE states the steps and excludes issue text. The runtime claim/heartbeat behaviour of a live agent is not exercised by any test. Routed to Human Verification 5. |
| 4 | SC4: 900 s claim deadline stops the session (SIGTERM, then SIGKILL); exit without claim comments, removes the label, gives up; given-up set survives restart | ✓ VERIFIED (carried forward) | `sessions.py`: `CLAIM_TIMEOUT_SECONDS = 900`; `_reap_one` terminate, then kill after grace; exit branch `_comment_once("exited-unclaimed")` then `_give_up()`; claim-timeout branch `_comment_once("claim-timeout")` then `_give_up()`. `sessions.py` unchanged by commit 248a6572. Warning carried from prior record: if substrate-mcp is unreadable at the 900 s mark, the session is not stopped until a read succeeds. |
| 5 | SC5: bounded live window: launch within 30 s, claim under the Hermes token, Linear and Notion show hermes, Claude Code brief within 60 s, kill switch restored | ? UNCERTAIN (operator-gated) | Not run. Human Verification 1 to 4. |

**Score:** 3/5 roadmap success criteria verified (SC1, SC2, SC4). SC3 is behaviour-unverified. SC5 is operator-gated.

### Dispatch Marker Comments (commit 248a6572)

- `EVENT_RETRYABLE_MARKERS = frozenset({"host-unreachable", "at-capacity", "graph-busy", "already-running"})` — the three new queued markers are silent on the event plane (see `dispatch.py` `_maybe_emit_failed` early return).
- `MARKERS` texts: `at-capacity` "every dispatch slot is busy; queued, will launch on a later tick"; `graph-busy` "this graph already has a running session; queued, will launch once it ends"; `already-running` "a session for this issue is already running; not launching a second one".
- `decide()` branches verified in code; `tick()` only launches on `action == "launch"` (elif branch), so comment decisions never call `launch_fn` and never add a session record — queued issues hold no slot.
- `_comment_once()` checks `tag(marker) in existing` over `linear.comment_bodies(...)` (last 50) before posting once — once-only semantics.

### Reap Path (session reaping before tick)

Verified in current code (not part of commit 248a6572's diff; pre-existing, now exercised by the queued markers):

- `__main__.py` `run_loop()`: each iteration runs `readopt()` → `reap()` → `tick()` → sleep 30 s; `reap`/`tick` failures are caught and logged, never stop the loop (lines 90-108).
- `sessions.py` `reap()` (line 458): retries `pending_label_removal` label removals, then `_reap_one()` per session (one bad session never stops the reap).
- `_reap_one()` (line 469): on exited-with-claim calls `_remove_exited()` → `_drop_session()` (frees the slot, so `capacity_left()` rises and a queued `at-capacity` issue launches on the next tick). On exited-without-claim posts `[exited-unclaimed]` then `_give_up()`; on claim timeout posts `[claim-timeout]` then `_give_up()` then SIGTERM (SIGKILL after grace).
- `capacity_left()` / `active_issue_ids()` / `active_graph_ids()` count live sessions plus pending VM tasks (lines 364-388), so a queued `graph-busy` decision re-decides to launch only after the live session's reap-driven removal.

### Updated Test Pin: test_claude_code_route.py

- `EXPECTED_MARKERS` now includes `"at-capacity", "graph-busy", "already-running"` (line 47) — the full once-only set is pinned.
- `test_claude_code_accepted_but_unreadable_reply_keeps_its_record_and_is_not_reposted` (line 222): first tick posts `[host-unreachable]`; second tick posts exactly one `[already-running]` (total 2 comments, `mcp.events == []`, `world.requests == 1`, record holds the slot). Verifies the once-only marker replaces a second host POST.
- Commit 248a6572 also rewrote `test_dispatch.py`: `test_issue_with_running_session_posts_one_already_running_marker_and_does_not_launch`, `test_at_capacity_posts_one_queued_marker_then_launches_when_a_slot_frees`, `test_graph_busy_posts_one_queued_marker_and_does_not_launch`, and `test_second_issue_on_a_live_graph_is_skipped` now expects `comment` `[graph-busy]`.

### Silent Skips Reviewed (SC1 interpretation, updated)

| Decision (`decide`) | Comment | Why it is acceptable |
| --- | --- | --- |
| `gave up on this issue (no claim)` (skip, line 259) | None on this tick | The give-up path always posts `exited-unclaimed` or `claim-timeout` before `_give_up()` (`sessions.py` 531-542), so the issue already carries its outcome marker — the skip is a re-decision, not a silent non-dispatch. This is the sole remaining silent branch. |
| `session already running for this issue` | `[already-running]`, once only | Closed by commit 248a6572 (was an open owner-decision item in the prior record). |
| `at capacity` / `session already running for graph` | `[at-capacity]` / `[graph-busy]`, once only | Closed by commit 248a6572. |

**Reading of "exactly one":** every marker uses the once-only tag scheme (`_comment_once`); repeated deferrals post nothing new, matching `already-claimed`/`no-node` behaviour. `docs/dispatcher.md` states "at most one" per marker and lists the gave-up skip explicitly.

### Spot-Check

This re-verification ran NO tests per the assignment (read-only inspection: commit diff, `dispatch.py`, `sessions.py`, `__main__.py`, tests, docs). The prior record's full-suite run (`298 passed`, 22.49 s) stands as history and was not repeated. No advisory re-run was performed, so no new pin-count is claimed here.

### Anti-Patterns

Commit 248a6572's changed files carry no `TODO`, `FIXME`, `XXX`, `TBD`, placeholder or stub markers in the inspected `dispatch.py` / test / docs hunks. The new `MARKERS` entries are real comment texts.

## Gaps Summary

No BLOCKER remains. The prior SC1 marker gap (at-capacity, graph-busy) and the already-running owner-decision item are both closed in code, tests and docs by commit 248a6572. The reap path that re-decides queued issues is present and wired (`__main__.py` readopt → reap → tick; `sessions.py` reap drops exited sessions). Two live proofs (SC5) and the live-agent behaviour check (SC3) remain for a human.

---

_Verified: 2026-11-19T12:30:13Z_
_Verifier: Claude (gsd-verifier)_
