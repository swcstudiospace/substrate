# Uplift 05 SUMMARY — Replayable signed dispatch handoffs + pre-launch drift gate

**Graph:** `ut-mv5r71hp-65f7b012` · **Plan:** `05-PLAN.md` · **Refs:** SPE-10477 · **Date:** 2026-10-13

## What shipped

- **`handoff.py` (new):** before any process starts, the dispatcher composes the dispatch context — goal line (ids and pointers only), DoD lines, file pointers (worktree path), `graph_id`/`node_id`/`linear_identifier`/`repo`/`branch` — and posts it via the existing MCP tool `coord_handoff` (server derives the sender from the bearer and signs when `SUBSTRATE_HANDOFF_KEY` is set). **Replayability:** `coord_handoff_list` rows alone rebuild the context (`handoff.replay`, newest-first, node-filterable) — a session killed any time after the post is recoverable from the ledger.
- **Drift gate:** `coord_drift_scan` runs against the worktree before the packet posts; a finding records one `warning` event `payload {action: "dispatch.handoff", status: "drift", findings: [slimmed]}` (evidence dropped). **Drift warning landing (recorded choice):** the warning-event payload, NOT a marker comment — the dispatcher posts no marker on successful launches, and adding a MARKERS entry was forbidden (D33-02).
- **Failure semantics (double fail-open):** scan failure, malformed report, handoff post failure, or unexpected reply each log + record one `warning` (`status: "drift"|"unsigned"|"failed"`) and the launch proceeds; a broken prelaunch step never blocks the launch (`make_launch_fn(prelaunch=…)`). Unsigned recording (`signed: false`) → `status: "unsigned"` with the reply's `gaps` in the payload. A reply that is not stored (`stored: false`/`error`) → `status: "failed"` carrying the reason.
- **Wiring:** `__main__.py` threads `make_prelaunch(mcp)` into `make_launch_fn` — same McpClient the loop already holds. `launcher.py`/`mcp.py` unchanged: the prompt stays template-only (DISP-07 — issue prose never enters prompt or packet; the composer has no issue-text parameter at all, asserted by test).

## Reply-shape correction (recorded)

The first pass validated an invented reply shape; corrected against ground truth `service.ts` `handoff()`: `{packet, signed, stored, event, gaps, error?…}`. Fakes now return the real shapes for `coord_handoff`, `coord_handoff_list` (rows `{event_id, ts, packet, verdict}` per `handoffsForGraph`), and `coord_drift_scan`.

## Verification (exercised)

- `bun run test:py` — **293 passed** (17 new handoff tests: exact packet shape, no-issue-prose invariant, pre-launch call order, replay-from-ledger rebuild with the launch process never started, unsigned/failed/drift warnings, fail-open paths; 4 prelaunch-order tests in test_dispatch.py)
- `bunx tsc --noEmit` clean (no TS changes); bun suite unchanged (3216 pass / recorded F-01)

## Deferred / surprises

- The packet posts after the worktree exists but before any process starts; a crash in the window between packet and process leaves a recorded packet with no session — visible as a `dispatch.handoff` packet with no subsequent events, which is the intended audit trail, not a leak.
