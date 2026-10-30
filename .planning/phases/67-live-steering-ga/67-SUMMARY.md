---
phase: 67-live-steering-ga
milestone: v1.7
requirements: [STEER-01, STEER-02, STEER-03, STEER-04, STEER-05, STEER-06]
status: implemented and merged on main (PR #180, squash ffe32957); every new surface is behind a flag that is off by default; installing a hook and turning the live flags on in production are operator-gated and were not done; no delivery to a real session was run
---

# 67-SUMMARY: Live Steering GA

Context and decisions: [67-CONTEXT.md](67-CONTEXT.md). The owner asked "what about Live Steering?" in Run 14; the plain answer is that v1.6 built a state machine and a directive inbox that had no command, no REST route and no reader of `checkpoint_hint`, and this phase adds those. Directives stay human and operator-only.

## What was built

- **Session registry, `packages/mcp-server/src/planning/session-state.ts`.** The in-memory registry (`STEERING_SESSION_CAP` 1,000) gains a write-through to a store, `loadDurable()` at boot (newest `cap` rows inside `STEERING_SESSION_TTL_MS`, seven days by default, older rows pruned), a bounded write queue, and one warning note when the store fails; a failing store never fails the call. Free text of a session (`steering`, `planning_hash`) is redacted at the storage and response boundaries.
- **Store, `packages/mcp-server/src/planning/steering-sessions-store.ts`.** Upsert per `(surface, session_id)`, read newest first, `prune(beforeMs)`. Migration step 37 `steering_sessions` in `packages/mcp-server/src/index-store.ts`, `optIn: "steering-sessions"`, expand phase, additive, with a `down` text. It runs only under `SUBSTRATE_STEERING_SESSIONS_TABLE`; `service.ts` wires the store and calls `loadDurable()` at start.
- **REST routes, `packages/mcp-server/src/planning/steering-rest.ts` and `packages/mcp-server/src/server.ts`.** `GET /steering/sessions`, `GET /steering/directives`, `POST /steering/queue`, `POST /steering/acknowledge`, `GET /steering/wait`. They call the tools' own functions (`queueSteering`, the acknowledge path, `listSteeringSessions`), audit through `auditedRest` under the tools' names (`steering_queue`, `steering_acknowledge`, `steering_list`), take their admission classes from `ROUTE_CLASSES` in `admission.ts`, and answer 404 while `SUBSTRATE_PLANNING_STEERING` is off. No route takes an author field; the author is the bearer's surface and only an operator may write. Also listed in `observe.ts`.
- **Long poll, `packages/mcp-server/src/planning/steering-waiters.ts`.** `SteeringWaiters` holds at most `STEERING_WAIT_PER_SESSION_MAX` (4) waiters per session and `STEERING_WAIT_TOTAL_MAX` (256) overall; `nextQueuedDirective` follows a monotonic inbox sequence, so a clock that steps back never hides a directive. A timeout above `SUBSTRATE_STEERING_WAIT_MAX_MS` (default 30,000) is clamped, not refused; the 200 body carries `wait_ms`, a 204 carries `X-Steering-Wait-Ms`. A client that goes away, or a server that closes, leaves no waiter.
- **Digest, `packages/mcp-server/src/session-context.ts`.** `session_context` (tool, registered in `mcp.ts`, class `read` in `admission.ts`, fail-open in `packages/audit/src/policy.ts`) and `GET /session/context`: presence (session, worktree, branch), claims, recent events, handoffs and `planning.changed` notes for one repository, each item with `source` and `age_s`. Bounds: `SESSION_CONTEXT_LIMITS` (20 sessions, 20 claims, 30 events, 10 handoffs, 10 planning), `SESSION_CONTEXT_MAX_BYTES` 24,000, text cut at 200 characters, a 2,000 ms budget; whatever is cut is named in `truncated`, a failed source in `notes`. `service.ts` supplies the sources, with a bounded handoff-only ledger query per graph.
- **Brief sections, `packages/mcp-server/src/brief-sessions.ts`.** `sessions`, `steering` and `handoffs` appended per request after the cached sections, behind `SUBSTRATE_BRIEF_SESSIONS`, never cached or stored in the snapshot; each at most `BRIEF_SESSIONS_SECTION_MAX_CHARS` (1,200). Priorities are added in `brief-profile.ts`, the asking session in `brief.ts` (`session_id`).
- **Handoff validation, `packages/mcp-server/src/handoff.ts`.** `isStoredHandoff` keeps a stored handoff out of the digest and the brief unless it is well formed; the builder's redact-then-cap is made stable.
- **CLI, `packages/cli/src/steer/`.** `substrate steer sessions | status | queue | ack | list | listen | context` (`index.ts`, `client.ts`, `render.ts`, `plain.ts`, `repo.ts`), wired in `packages/cli/src/index.ts`. Exit codes 0 to 3; `listen` paces and backs off with an abortable sleep, never reprints a directive and treats `--max-wait-ms` as one budget for the whole command.
- **Hook, `packages/cli/src/session/hook.ts`, `steering-consumed.ts`, `hook-config.ts`, `trigger-policy.ts`.** The `steering` trigger lists the session's acknowledged directives and writes the checkpoint each `checkpoint_hint` names, once, recording consumed ids beside the pending journal (at most five per run); the `context` trigger prints the digest (at most 4,000 characters) and takes no checkpoint; `hook-config` prints five targets: `claude-code`, `git-post-commit`, `steering`, `baseline`, `context`.
- **Docs and rows.** `docs/live-steering.md` (new), `docs/coordination.md`, `docs/data-planes.md`, `docs/runbooks/session-rollback.md`, `docs/runbooks/rollback-compat.md`, ADR 0007 note, four flag rows in `packages/mcp-server/src/flag-registry.ts` and `.env.example`, an event-source row.

## Key decisions

- **D67-1, D67-2 held.** One session registry serves both mechanisms; the CLI and REST routes were the missing parts.
- **D67-3 held.** The digest is built from presence, `graph_nodes` claims, ledger events, handoffs and `planning.changed` notes; every item names its source and age.
- **D67-4 held.** The durable registry is a Postgres table behind its own opt-in, as `planning_steering_audit` is; Dragonfly stays cache-only.
- **D67-5 held.** No route accepts an author; the rate limit and audit-before-queue order are the tools' own because the routes call the same functions.
- **Changed in review:** the hint rule. Round 2 made a `checkpoint_hint` exist only when an acknowledgement actually moved the session; a directive read back after a restart has none (see Deviations). Round 1 made the sessions feature set one flag, so `session_context` and its route also obey `SUBSTRATE_BRIEF_SESSIONS`.

## Deviations from the plan

- **Migration number.** The step is 37, not the next number the first commit used (35): the worktree and corpus phases took 35 and 36 first.
- **`checkpoint_hint` after a restart is `null`.** A directive acknowledged before a restart is read back from `planning_steering_audit`, whose rows store no transition result, so the hint cannot be rebuilt. The hook therefore writes no steering checkpoint from history. Documented limitation (`docs/live-steering.md`, "Limits").
- **`SUBSTRATE_BRIEF_SESSIONS` also gates `session_context`.** The ROADMAP names the flag only for the brief sections (criterion 3). Off, the tool and `GET /session/context` refuse with `session-context.disabled` (HTTP 503) and read nothing.
- **Brief size bound.** The ROADMAP says "within the existing size bound". Each live section is bounded at 1,200 characters; the compact profile's byte cap applies to them through the existing renderer, but no test pins that (see VERIFICATION, criterion 3).
- **TTL scope.** The TTL applies when the registry loads at boot and prunes the table then; a running process does not expire sessions, only the cap of 1,000 bounds it.
- **Extra command.** `substrate steer context` and the `context` hook trigger exist beyond the ROADMAP's command list.

## Findings

From the squash commit message of PR #180 (review rounds 1 to 5, a merge repair and two CI fixes); nothing here is beyond what it names.

- **Redaction.** Session directions were stored and returned unredacted (round 1). A handoff's capped text could outgrow its cap or differ from what was signed because the event layer redacts a second time (rounds 4 and 5): redaction now settles before the cap and a cut moves back only as far as needed.
- **Bounds and deadlines.** The live brief sections ran outside the brief deadline and were not appended to a snapshot reply; the digest read handoffs without a bounded query; an oversized wait was refused rather than clamped (round 1). A signed handoff was measured with its signature, and a body cut by the request limit was reported as a failure instead of a timeout (round 3).
- **Restart behaviour.** Acknowledged directives are read from durable history after a restart; the repository spelling is kept for lookups; deliveries follow a monotonic inbox sequence (round 1).
- **Correctness of results.** A malformed stored handoff could throw: it is validated and skipped (round 2). The conflict flag did not reach REST and the CLI (round 2). A hint was attached to moves the session refused (round 2).
- **CLI.** Server text reached the terminal unfiltered; the listener could spin or repeat a directive; `--max-wait-ms` bounded only the loop, not each request; typed refusals did not exit 3 (rounds 1 and 2).
- **CI.** A type error (`signature` on a spread of `object`) and the redaction lock matching a helper whose name began with `redact` (renamed). A merge with the worktree fleet closed the session-context route before the worktree block; the block was rebuilt.

## What remains

- **Operator-gated:** installing the printed `steering` and `context` hook configuration in a host (ADR 0007 maps no host event to them); enabling the flags and creating the opt-in table in production; issuing operator tokens; exercising delivery to a real session end to end. Nothing in this repository edits a host's settings.
- **Gaps:** the hint is lost across a restart; the TTL does not apply to a running process; no test shows the live brief sections inside the compact byte cap; a long poll holds one admission slot for as long as it waits.
