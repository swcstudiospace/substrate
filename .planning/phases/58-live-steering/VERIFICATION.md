---
phase: 58-live-steering
verified: 2026-10-26
status: gaps_found
score: 4 of 5 success criteria MET in the repository, 1 PARTIAL (criterion 2); the branch is not merged and waits for the draft stack
verified_on: gsd/v16-58-live-steering at 7edfd79 (in /root/src/worktrees/as-v16-58; the files were read there, nothing was run)
---

# 58-VERIFICATION: Live session steering for multi-day GSD-Core sessions

## Gates

Not run by the author of this record. The orchestrator's figures for the branch at 7edfd79, against a throwaway Postgres 16: 6639 pass, 2 skip, 0 fail; audit gate 0 unlisted (the draft base had 3 unlisted advisories until the dependency commit ed61286); `check:phase-close` pass. Evidence below is file paths and test titles read on that branch.

## Success criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Queued and acknowledged directives survive a restart through a durable store (an opt-in TimescaleDB step), and an unacknowledged directive expires to a `declined:timeout` audit row | MET | `packages/mcp-server/src/planning/steering-durable.test.ts` (`describe("restore from the audit log")`, `describe("acknowledgement deadline")`, `describe("the payload hash covers the reason")`); `steering-wiring.test.ts`: `"boot restores the open directives, writes no audit row, and starts the expiry timer at the sweep interval"`, `"an expiry pass closes a directive nobody acknowledged as declined:timeout, and shutdown clears the timer for good"`, `"production wiring: with the opt-in on and an index, the inbox is built over the audit table and restored from it at boot"`; `index-store.migrate-optin.test.ts` (steps 33 and 34 on this branch). |
| 2 | A queued directive reaches the target session within one scan interval through the existing hint channel and the next `docs_search` or brief; the two steering mechanisms share one state model | PARTIAL | Delivery: `steering-wiring.test.ts` `"a session with queued directives reads a count and at most three entries, and the reply is never storable"`, `"over MCP the docs_search reply carries the notice"`, `"each queued directive publishes one steering.queued note that names it and carries no body"`; `planning/steering-delivery.test.ts`. Not met: `"with no session state wired, which is production in this branch, the reply is the plain acknowledgement"` shows the acknowledgement-to-state mapping is not wired in production, and the adapter over main's `docs_steering_session` state machine is not written, so one state model is not true end to end. Delivery to the next brief and "within one scan interval" are not evidenced (UNVERIFIED). |
| 3 | A session quiet for more than 25 hours stays `active` while it heartbeats, and a restart publishes the changes made while the observer was down | MET | `planning/observer.test.ts`: `"30 simulated hours of scans with no planning change: the session stays active while it heartbeats, and goes stale when the heartbeats stop"`; `planning/baseline-store.test.ts` (saving, loading, strict reads); `steering-wiring.test.ts` `describe("the planning observer's baseline and liveness")` (liveness record on a quiet scan, baseline flushed to a file on shutdown). |
| 4 | `STATE.md` and `ROADMAP.md` are parsed into a position (milestone, phase, plan, step) exposed through `planning_status` | MET | `planning/position.ts`, `planning/position.test.ts` (`parsePosition: the two layouts`, `the states of a project`, `missing, malformed and oversize input`, `the progress table's status words`, `stable output`, `redaction and caps`); `planning/read.ts` and `mcp.ts` carry `position` on `planning_status`. |
| 5 | DragonflyDB carries only wake-up hints and ephemeral presence; the durable authority is TimescaleDB and the ledger | MET | `planning/presence-dragonfly.ts` (key lifetime derived from the presence TTL, margin bounds) and `presence-dragonfly.test.ts`; the durable record is the audit table; `cache.ts` command set unchanged (the commit touches no cache file). |

## Residual risks

- Criterion 2 is partial. Until the adapter exists, a directive acknowledged through this inbox does not drive `docs_steering_session` (shown by the "no session state wired" test), and [INFERENCE] a pause or redirect set through that state machine is not visible in the inbox.
- The branch cannot land before the draft PRs #104, #109, #110, #111 (on operator Hold); a rebase onto main will also have to reconcile index migration numbering (draft step 33, this phase's step 34).
- The observer baseline file and the liveness timers were exercised with injected clocks and a temporary directory only; no real multi-day session was run.
- The draft's presence TTL was built for minute-scale freshness; multi-day liveness rests on the new liveness heartbeat. With the default `SUBSTRATE_PLANNING_LIVENESS_INTERVAL_MS=0` a quiet checkout refreshes its presence record on every scan; the write cost of that in production is unmeasured (UNVERIFIED).
- Steering is pull-based through `docs_search` and hints; no push into a running agent was built.

## Operator-gated

Merging the draft stack and this branch; production opt-in of the audit table (migration steps 33 and 34); enabling steering in production.
