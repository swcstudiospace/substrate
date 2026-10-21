# Phase 39 — DISPATCH: signed handoff packet and drift scan before launch

## Gap
- C-D2 (REQUIREMENTS.md:25-26): dispatch as a signed handoff packet (goal from the issue, DoD lines, files), replayable from the ledger.
- C-D4 (REQUIREMENTS.md:27-28): run `coord_drift_scan` on the worktree before launch; a stale-brief warning before acting.
- Success criteria (ROADMAP.md:542-545): (1) the packet is signed and the dispatched context replays from the ledger; (2) the drift scan runs before launch and gives a stale-brief warning.

## Current behaviour (read, with citations)
- Pre-launch step: `packages/dispatcher/src/substrate_dispatcher/handoff.py`. The drift scan runs first, then the packet post, and the step never raises (`drift_findings` :164; `make_prelaunch` :321). It is wired in `__main__.py:155` as `make_launch_fn(..., prelaunch=make_prelaunch(mcp))`.
- Drift warning: one `dispatch.handoff` warning event with `status: "drift"` (`handoff.py:121-123`).
- Packet: `packet_arguments` (`handoff.py:67`) carries `to`, `goal` (`goal_line` :59, ids and pointers only), `files` (the worktree path), `dod` (`DISPATCH_DOD`, fixed lines, :49), `blockers`, the graph, node and Linear ids, `repo` and `branch`.
- Signing: the server signs the packet when `SUBSTRATE_HANDOFF_KEY` is set. `packages/mcp-server/src/handoff.ts` has `signHandoff` and `verifyHandoff`, with key rotation. With no key, the packet is posted unsigned and recorded with `status: "unsigned"`.
- Replay: `coord_handoff_list` rebuilds the dispatch context from the ledger. `test_kill_after_post_replay_rebuilds_the_dispatch_context_from_the_ledger` (`packages/dispatcher/tests/test_handoff.py:371`) covers it.
- Fail-open: a drift scan or a post that cannot run logs one line and the launch proceeds (tests at `test_handoff.py` :284, :293, :316, :328, :343, :350).

## Decisions
1. **Issue prose stays out of the packet (DISP-07).** The `handoff.py` docstring states this design: the dispatcher never holds issue prose, and the packet carries pointers and DoD lines only. The operator chose this over carrying the issue title and DoD section (2026-10-21). C-D2's "goal from the issue" is met by the issue identifier in the goal line and the fixed DoD lines. REQUIREMENTS.md and ROADMAP.md now say so.
2. **No product code changes in this phase.** The existing implementation covers both criteria in-repo. This phase verifies it and records the evidence.

## Grey areas
- G1. "Signed" holds only where `SUBSTRATE_HANDOFF_KEY` is set on the server. An unset key is recorded as unsigned, not hidden. Setting the key on the Lane B host is an operator action.
- G2. The stale-brief warning is covered by tests, not by a live run on a Lane B worktree.
- G3. `.planning/UPLIFT_PROPOSAL.md` (line 46, per the read-only map) says the dispatcher uses neither mechanism. That statement is stale against this tree. It is recorded here and not edited.

## Out of scope
- Issue prose in the packet (decision 1).
- Setting `SUBSTRATE_HANDOFF_KEY` on a host, and a live drift run on Lane B (operator).
