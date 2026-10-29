---
phase: 58-live-steering
milestone: v1.6
requirements: [SOTA-14]
status: implemented on gsd/v16-58-live-steering (7edfd79); partial; not merged; waits for the draft PR stack
---

# 58-SUMMARY: Live session steering for multi-day GSD-Core sessions

All code is on `gsd/v16-58-live-steering` (`/root/src/worktrees/as-v16-58`): commit 7edfd79, 35 files, 6181 insertions and 105 deletions, on the unmerged draft PR #110 head f1ae7de plus the dependency fix ed61286. Nothing from this phase is on `gsd/v16-int`. The facts below are from the commit message and the file list of 7edfd79; the author of this record did not re-run the branch's tests and read test names only.

## What was built

- **Durable inbox.** The append-only `planning_steering_audit` table (draft step 33) is the log. The inbox is rebuilt from it at boot, and a restore never audits. An unacknowledged directive older than the acknowledgement TTL (default 24 h, `SUBSTRATE_PLANNING_STEERING_ACK_TTL_S`) gets a system acknowledgement `declined:timeout` appended before it leaves the pending set; concurrent expiry is safe through the unique `(directive_id, transition)` key. Opt-in migration step 34 adds a nullable `reason` column that the payload hash covers. An expiry sweeper runs every `SUBSTRATE_PLANNING_STEERING_EXPIRY_SWEEP_S` seconds (default 60) only while steering is on with the audit table enabled.
- **Multi-day liveness.** A liveness heartbeat separate from the change heartbeat keeps a quiet session active while it heartbeats, with idle time reported apart (`SUBSTRATE_PLANNING_LIVENESS_INTERVAL_MS`, default 0 meaning every scan). The Dragonfly key lifetime is derived from the presence TTL instead of a fixed hour. A file-backed observer baseline (`baseline-store.ts`: atomic write, mode 0600, strict parse; `SUBSTRATE_PLANNING_BASELINE_DIR`) lets a restarted observer publish changes made while it was down.
- **GSD-Core position.** `position.ts` parses `STATE.md` and `ROADMAP.md` into milestone, phase, plan, step, status and progress (pure, total, redacted, deterministic, both file layouts) and `planning_status` carries it.
- **Delivery.** A `docs_search` reply carries a bounded steering notice for the calling session (never stored in the cache); a queued directive publishes one body-free hint note; an acknowledgement maps to a session state name through an injected port (`steering-delivery.ts`).
- Dragonfly stays cache-only.

## Key decisions

- The audit table is the durable authority; Dragonfly holds presence and hints only.
- The audit-before-effect rule of the draft is kept: the timeout acknowledgement is appended before the directive leaves the pending set.
- The state port is injected so the join with main's state machine can be written without touching the store.

## Deviations from the plan

- **Criterion 2 is not met end to end.** "The two steering mechanisms share one state model" needs an adapter over main's `docs_steering_session` state machine. That code reached main through PR #112 and is not on the draft branch, so the adapter (about 20 lines per the orchestrator's estimate) was not written; until the stack lands on main the two mechanisms do not share one state model.
- Delivery to the next brief is not evidenced: the commit message names `docs_search` and the hint note; no brief-side delivery was found in `steering-delivery.ts` (UNVERIFIED beyond a grep for "brief", which found nothing).
- The plan's opt-in TimescaleDB step is realised as step 34 on this branch only.

## Findings

- The draft base carried three unlisted high advisories (zod, body-parser, undici), so its audit gate failed; the dependency commit ed61286 patches them. After it, the branch's audit gate reports 0 unlisted.
- The Dragonfly presence key lifetime was a fixed hour and is now derived from the presence TTL (commit message). [INFERENCE] a fixed hour would have let a long-idle session's presence expire whatever the TTL setting said.

## What remains

- The state-machine adapter, to be written when the stack lands on main.
- Merge of the draft stack (PRs #104, #109, #110, #111, on operator Hold) before this commit can land.
- Production opt-in of the audit table (migration steps 33 and 34) is a production migration: operator-run.
- A live check of delivery to a real session, which was not run.
