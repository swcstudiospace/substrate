---
phase: 58-live-steering
verified: 2026-10-28
status: passed
score: 5 of 5 success criteria MET in the repository
verified_on: main at 31a9bb36 (files read; nothing was run)
---

# 58-VERIFICATION: Live session steering for multi-day GSD-Core sessions

## Gates

Not run by the author of this record. The full gate runs in CI on main (frozen install, tsc with the strict flags, blocking Biome lint, the full bun test suite against a scratch Postgres, the Python suites, the repo locks) and the orchestrator records the run in .planning/STATE.md. This record's evidence is file paths and test titles read on main at 31a9bb36.

## Success criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Queued and acknowledged directives survive a restart through a durable store (an opt-in TimescaleDB step), and an unacknowledged directive expires to a `declined:timeout` audit row | MET | `packages/mcp-server/src/planning/steering-durable.test.ts` (`describe("restore from the audit log")`: `"a restart reloads queued directives, in priority order, and writes no audit row"`; `describe("acknowledgement deadline")`); `packages/mcp-server/src/steering-wiring.test.ts`: `"boot restores the open directives, writes no audit row, and starts the expiry timer at the sweep interval"`, `"an expiry pass closes a directive nobody acknowledged as declined:timeout, and shutdown clears the timer for good"`, `"production wiring: with the opt-in on and an index, the inbox is built over the audit table and restored from it at boot"`. |
| 2 | A queued directive reaches the target session within one scan interval through the existing hint channel and the next `docs_search` or brief; the two steering mechanisms (`docs_steering_session` and the inbox) share one state model | MET | Delivery: `steering-wiring.test.ts` `describe("the steering notice on docs_search")`: `"a session with queued directives reads a count and at most three entries, and the reply is never storable"`, `"over MCP the docs_search reply carries the notice"`; `planning/steering-delivery.test.ts` (acknowledgement-to-state mapping, `checkpoint_hint` on applied pause/redirect). One state model (PR #147, `23ced3cb`): `planning/session-state.ts` (`SteeringSessionRegistry implements SessionStatePort`, moves go through `nextSteeringSession`); production wiring injects the live registry as the acknowledgement port (`service.ts`: `this.steeringSessions = new SteeringSessionRegistry(...)`, `this.sessionState = ... steeringInbox !== null ? this.steeringSessions : null`) and `docs_steering_session` reads/writes the same registry (`mcp.ts`: `substrate.steeringSessions.get/put`, `acknowledgeSteeringWithState(steering, steeringCaller, args, substrate.sessionState)`); `session-state.test.ts` (`describe("applyTransition")`: pause/redirect apply, refusals, ambiguous/unheld sessions, unchanged no-ops); `steering-wiring.test.ts` `describe("the two steering mechanisms share one state model")`: `"a pause acknowledged through the inbox changes the state docs_steering_session reports, and the ledger names the directive"`, `"the reverse reads: a state docs_steering_session sets is the state the inbox side sees, and a resume lets a later redirect apply"`, plus refused/unchanged/not-registered cases. The earlier failing title `"with no session state wired, which is production in this branch"` no longer exists anywhere in `packages/mcp-server/src` (grep empty). Documented in `docs/adr/0007-checkpoint-triggers-and-sibling-hooks.md` (steering checkpoint hint) and `docs/data-planes.md` (steering queue/acknowledge). |
| 3 | A session quiet for more than 25 hours stays `active` while it heartbeats, and a restart publishes the changes made while the observer was down | MET | `planning/observer.test.ts` `describe("the liveness heartbeat: a session is alive, not only changing")`: `"30 simulated hours of scans with no planning change: the session stays active while it heartbeats, and goes stale when the heartbeats stop"`; `planning/baseline-store.test.ts` (saving, loading, strict reads); `steering-wiring.test.ts` `describe("the planning observer's baseline and liveness")` (liveness record on a quiet scan, baseline flushed to a file on shutdown). |
| 4 | `STATE.md` and `ROADMAP.md` are parsed into a position (milestone, phase, plan, step) exposed through `planning_status` | MET | `planning/position.ts`, `planning/position.test.ts` (`describe("parsePosition: the two layouts")`, `"the states of a project"`, `"missing, malformed and oversize input"`, plus progress-table status words, stable output, redaction and caps); `planning/read.ts` and `mcp.ts` carry `position` on `planning_status`. |
| 5 | DragonflyDB carries only wake-up hints and ephemeral presence; the durable authority is TimescaleDB and the ledger | MET | `planning/presence-dragonfly.ts` (key lifetime derived from the presence TTL) and `presence-dragonfly.test.ts`; the durable record is the audit table; no cache command-set change. |

## Residual risks

- The observer baseline file and the liveness timers were exercised with injected clocks and a temporary directory only; no real multi-day session was run.
- The presence TTL was built for minute-scale freshness; multi-day liveness rests on the new liveness heartbeat. With the default `SUBSTRATE_PLANNING_LIVENESS_INTERVAL_MS=0` a quiet checkout refreshes its presence record on every scan; the write cost of that in production is unmeasured (UNVERIFIED).
- Steering is pull-based through `docs_search` and hints; no push into a running agent was built.
- Live steps stay operator-gated: production opt-in of the audit table, enabling steering in production, and any multi-day live proof.
