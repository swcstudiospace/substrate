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
