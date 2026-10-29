---
phase: 39-dispatch
verified: 2026-10-21
status: human_needed
score: 2 of 2 success criteria proven in the repository for the design decided in CONTEXT. Signing in production and a live drift run need an operator
verified_on: gsd/v13x-39-dispatch on origin/main 1d4e4aa. No file under packages or docs changed since 3aea2d0, the commit the full suite covered.
covered_files: ["packages/dispatcher/src/substrate_dispatcher/handoff.py", "packages/dispatcher/src/substrate_dispatcher/dispatch.py", "packages/dispatcher/src/substrate_dispatcher/__main__.py", "packages/dispatcher/tests/test_handoff.py", "packages/mcp-server/src/handoff.ts", "packages/mcp-server/src/handoff.test.ts"]
---

> Status detail, kept verbatim from the original frontmatter: passed. The score line records that signing in production and a live drift run need an operator. Set to human_needed for that reason

# 39-VERIFICATION: DISPATCH

## Proven in-repo

| Claim | Evidence |
|---|---|
| Dispatcher suite passes | `python3 -m pytest packages/dispatcher/tests -q` on 1d4e4aa: 251 passed |
| Handoff signing and replay pass | `bun test packages/mcp-server/src/handoff.test.ts`: 23 pass, 0 fail. Signed packets verify; every field and the signature header are covered; rotation keeps the retired key valid; with no keys, verification says so |
| The drift scan runs before the packet and before the launch | `test_prelaunch_scans_drift_then_posts_the_packet_before_any_launch` (`test_handoff.py:246`) |
| A drift finding is recorded as a stale-brief warning, before the launch acts | `test_drift_finding_records_one_dispatch_handoff_drift_warning` (`:256`) |
| The drift gate is fail-open | `test_drift_scan_failure_is_fail_open_and_the_packet_still_posts` (`:284`); `test_malformed_drift_report_is_fail_open_too` (`:293`) |
| An unsigned packet is recorded as unsigned; a failed post never stops the launch | `test_unsigned_reply_records_one_unsigned_warning` (`:303`); `test_post_failure_records_failed_warning_and_does_not_raise` (`:316`) |
| The dispatched context replays from the ledger after a kill | `test_kill_after_post_replay_rebuilds_the_dispatch_context_from_the_ledger` (`:371`); `test_replay_of_an_unsigned_packet_reports_it_unsigned` (`:431`); `test_replay_preserves_a_failed_signature_verdict_on_a_signed_packet` (`:442`) |
| The packet carries no issue prose | `test_packet_carries_no_issue_prose_even_when_the_caller_holds_some` (`:233`) |
| No product code changed since the full suite run | `git diff --stat 3aea2d0 origin/main -- packages docs` is empty |

## Not proven

- **"Signed" in production.** It needs `SUBSTRATE_HANDOFF_KEY` set on the server. It was not set here. Without it, packets are recorded as unsigned.
- **A live stale-brief warning on a real Lane B worktree.** Not run.

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Dispatch is a signed handoff packet (goal, DoD lines, files), replayable from the ledger | PASS in-repo for the design in CONTEXT (issue identifier and fixed DoD lines). Signed in production not proven | the signing and replay tests above |
| 2 | `coord_drift_scan` runs on the worktree before launch, with a stale-brief warning before acting | PASS in-repo. A live run is not proven | the pre-launch order and drift-warning tests above |

## Requirement coverage re-verification (2026-10-24)

Scope: C-D2 and C-D4 (`.planning/REQUIREMENTS.md:25`, `:27`). Checked against worktree HEAD bdcc798. Tests were not run in this task; the orchestrator runs them. Every path and line below was read before it was cited.

### C-D2: the dispatched context can be replayed from the ledger

- ROADMAP criterion 1 (`.planning/ROADMAP.md:550`), quoted: "Dispatch is a signed handoff packet (goal from the issue, DoD lines, files), and the dispatched context can be replayed from the ledger."
- Implementing code:
  - `packages/mcp-server/src/handoff.ts:217` `buildHandoff`, which validates, redacts and fits the packet before signing.
  - `packages/mcp-server/src/handoff.ts:276` `signHandoff`, which signs the final bytes; with no key it returns `signature: null`.
  - `packages/mcp-server/src/service.ts:5243-5266` builds and signs the packet at write time.
  - `packages/mcp-server/src/service.ts:5330-5347` `handoffsForGraph`, the ledger replay that attaches a verdict to each packet.
  - `packages/mcp-server/src/mcp.ts:1828-1840` the `coord_handoff_list` tool.
  - `packages/dispatcher/src/substrate_dispatcher/handoff.py:184` `post_handoff`, the dispatcher's packet post.
- Tests:
  - `packages/mcp-server/src/handoff.test.ts:102` "a signed packet verifies"
  - `packages/mcp-server/src/handoff.test.ts:289` "a Grok to Hermes handoff replays with nothing but the packet"
  - `packages/mcp-server/src/service.test.ts:1753` "replays a graph's handoffs back out of the ledger, each with its own verdict"
  - `packages/mcp-server/src/service.test.ts:1779` "a packet that does not verify is still returned, with the reason"
  - `packages/dispatcher/tests/test_handoff.py:371` "test_kill_after_post_replay_rebuilds_the_dispatch_context_from_the_ledger"
  - `packages/dispatcher/tests/test_handoff.py:431` "test_replay_of_an_unsigned_packet_reports_it_unsigned"
  - `packages/dispatcher/tests/test_handoff.py:442` "test_replay_preserves_a_failed_signature_verdict_on_a_signed_packet"
- Evidence status: in-repo proven. Code and tests were both found. Signing in production is not proven.
- Live proof remaining: `PENDING_VALIDATION`. Operator check, on the server host: confirm `SUBSTRATE_HANDOFF_KEY` is set (the name only; never print the value; the reader is `packages/mcp-server/src/config.ts:803`). Then dispatch one test issue, call `coord_handoff_list` with its graph ID, and confirm the packet verdict is `ok: true` with a `key_id`, not unsigned.

### C-D4: a stale-brief warning before acting

- ROADMAP criterion 2 (`.planning/ROADMAP.md:551`), quoted: "`coord_drift_scan` runs on the worktree before launch, giving a stale-brief warning before acting (v0.3 §2)."
- Implementing code:
  - `packages/dispatcher/src/substrate_dispatcher/handoff.py:164-181` `drift_findings`, the `coord_drift_scan` call on the worktree, fail-open (returns `None`).
  - `packages/dispatcher/src/substrate_dispatcher/handoff.py:284-300` `prelaunch`, which runs the scan before the post.
  - `packages/dispatcher/src/substrate_dispatcher/handoff.py:302-310` the `status="drift"` warning, recorded before `post_handoff` at `:311`.
  - `packages/dispatcher/src/substrate_dispatcher/dispatch.py:534-553` `launch_fn` calls `prelaunch` after the worktree is ensured and before the launch.
  - `packages/mcp-server/src/service.ts:5362` `driftScan`, the substrate-side gather. Each unreadable source is reported as not compared.
  - `packages/mcp-server/src/mcp.ts:1842-1843` the `coord_drift_scan` tool registration.
- Tests:
  - `packages/dispatcher/tests/test_handoff.py:246` "test_prelaunch_scans_drift_then_posts_the_packet_before_any_launch"
  - `packages/dispatcher/tests/test_handoff.py:256` "test_drift_finding_records_one_dispatch_handoff_drift_warning"
  - `packages/dispatcher/tests/test_handoff.py:284` "test_drift_scan_failure_is_fail_open_and_the_packet_still_posts"
  - `packages/dispatcher/tests/test_handoff.py:293` "test_malformed_drift_report_is_fail_open_too"
  - `packages/dispatcher/tests/test_dispatch.py:687` "test_make_launch_fn_runs_prelaunch_after_worktree_before_launch"
  - `packages/dispatcher/tests/test_dispatch.py:721` "test_broken_prelaunch_does_not_block_the_launch"
  - `packages/mcp-server/src/service.test.ts:1809` "reports each record as not compared rather than throwing when it cannot be read" (describe `driftScan`, `:1808`)
- Evidence status: in-repo proven. The pre-launch order and the warning are covered by the dispatcher tests; the scan is covered by the substrate test.
- Live proof remaining: `PENDING_VALIDATION`. Operator check, on the dispatcher host: pick a Lane B worktree with a known drift, dispatch one issue for it, and confirm the ledger shows one drift warning (payload `status: "drift"`) before the handoff packet for that node. No live run has been done.
