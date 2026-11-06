---
phase: 67-live-steering-ga
verified: 2026-11-06T00:00:00Z
status: gaps_found
score: 5 of 6 success criteria VERIFIED; 1 FAILED as written (criterion 4, superseded by phase 71; owner decision open)
covered_files: [".env.example", ".planning/phases/67-live-steering-ga/67-SUMMARY.md", "docs/live-steering.md", "packages/audit/src/policy.ts", "packages/cli/src/index.ts", "packages/cli/src/session/hook-config.ts", "packages/cli/src/session/hook.ts", "packages/cli/src/session/steering-consumed.ts", "packages/cli/src/session/trigger-policy.ts", "packages/cli/src/steer/client.ts", "packages/cli/src/steer/index.ts", "packages/cli/src/steer/plain.ts", "packages/cli/src/steer/render.ts", "packages/cli/src/steer/repo.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/brief-profile.ts", "packages/mcp-server/src/brief-sessions.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/handoff.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planning/session-state.ts", "packages/mcp-server/src/planning/steering-rest.ts", "packages/mcp-server/src/planning/steering-sessions-store.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/planning/steering-waiters.ts", "packages/mcp-server/src/planning/steering.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.ts"]
covered_digest: "v3:sha256:699b63a9f000de1c5f80a4c45c0aa8b5b1175cf2c36203c86060dc85ed8f3f7c"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: "4 of 6 VERIFIED; 1 PRESENT_BEHAVIOR_UNVERIFIED (criterion 3); 1 FAILED as written (criterion 4) (record 67-VERIFICATION.md at 6e5d766e)"
  gaps_closed:
    - "Criterion 3 combined bound: live sections under a tight compact byte cap are now tested end to end (session-context.service.test.ts:375)"
    - "Open item 4: end-to-end test with live sections under a tight SUBSTRATE_BRIEF_COMPACT_BYTES (e958e8b1)"
    - "Open item 5: flag-off byte-identity test for SUBSTRATE_BRIEF_SESSIONS (e958e8b1, session-context.service.test.ts:394)"
  gaps_remaining:
    - "SC4 literal: steering_sessions is a historical table with no runtime writer; owner decision open (not amended here)"
    - "Stale step 37 comment in index-store.ts:767 (open item 2)"
    - "ROADMAP.md:1158 SC4 text and 67-SUMMARY D67-4 describe the superseded mechanism (open item 3)"
    - "Operator-gated: hooks installed and a directive seen reaching a real session (not observable here)"
  regressions: []
gaps:
  - truth: "SC4: With SUBSTRATE_STEERING_SESSIONS_TABLE on, session state lives in steering_sessions and survives a restart; TTL and cap are enforced."
    status: failed
    reason: "The criterion's mechanism is superseded. steering_sessions (migration step 37) has no runtime writer or reader: the only SQL naming it is the migration itself. Session state, restart survival and TTL-as-lease are carried by live_session_bindings (phase 71, step 42). No session cap exists in non-test code. Restart survival (STEER-04) holds through live_session_bindings and is tested by live-session-restart.pg.test.ts (16 passes in the r36 JUnit). The criterion text is not met as written; this is a supersession, not a deferral, so the phase's deferred list stays empty."
    artifacts:
      - path: "packages/mcp-server/src/index-store.ts"
        issue: "Step 37 (lines ~766-790) is opt-in and creates an unused table; the comment at line 767 still says the application upserts rows and drops rows past the TTL at boot."
      - path: "packages/mcp-server/src/planning/steering-sessions-store.ts"
        issue: "Header (lines 2-4) states the steering_sessions table has no runtime adapter; the file now holds the live_session_bindings authority."
      - path: "docs/live-steering.md"
        issue: "Line 94: the retired restart-cache TTL configuration has no reader or example; the criterion text still describes it."
    missing:
      - "OWNER ITEM: decide either (a) accept live_session_bindings as the replacement, amend ROADMAP Phase 67 SC4 (restart via live_session_bindings; TTL as the lease, SUBSTRATE_LIVE_SESSION_LEASE_S 60..86400 s default 3600; cap dropped or re-specified), or (b) reinstate a session cap and a steering_sessions writer. Evidence for the decision: index-store.ts:766-790, index-store.ts:882 (live_session_bindings), config.ts:775 and :1319, flag-registry.ts:534 ('Runtime cache removed; never grants live authority'). This verifier did not amend the criterion and does not reopen any owner decision in force."
      - "Correct the step 37 comment at index-store.ts:767 (not edited here)."
deferred: []
behavior_unverified_items: []
coincidental_reliance_items: []
---

# 67-VERIFICATION: Live Steering GA

**Phase goal:** Live Steering is something an operator can see and use, and a session can learn what the other sessions of its repository are doing.
**Verified:** 2026-11-06, at HEAD a46d42c3 (worktree `as-gsd-v18-all`, clean). Supersedes the record at 6e5d766e (2026-11-05).
**Status:** gaps_found
**Covered list:** unchanged from the prior record (33 files). Digest computed with `gsd_run query verification.fingerprint .planning/phases/67-live-steering-ga <covered files>` at HEAD: `v3:sha256:f015e4aa37b36fa4a0676dc881fd946dd8b2d528a8bab4482c37f71c20d14f37`. The prior digest (`v3:sha256:9673b5d6…`) differs because `server.ts`, `service.ts`, `observe.ts`, `config.ts`, `mcp.ts` and `steering-rest.ts` changed since 6e5d766e.

## Gates and evidence

- Gates not run here. No tests, tsc, lint, formatters, docker or database were run by the verifier.
- Evidence: gate r36 JUnit `/root/src/worktrees/backups/gate-r36-junit.xml`: 12317 testcases, 0 failures, 0 errors, 2 skipped. The skipped cases are `redact.test.ts` ("D-04 fixtures do not survive the write path while counts do") and `cache-conformance.test.ts` ("live loopback redis … unset"); neither is in phase 67 scope. The 16 `live-session-restart.pg.test.ts` cases are present with no skip, failure or error child.
- Titles were matched by exact `name` attribute in the JUnit, and each was checked for no `failure`, `error` or `skipped` child.
- Two new titles from e958e8b1 (checked in the JUnit, both `testcase` with no children, file `packages/mcp-server/src/session-context.service.test.ts`):
  - "under a tight compact byte cap, live sections stay within the bound, whole, naming their source and age"
  - "with the sessions flag off, live sessions do not change a byte of the brief"
- Named passes below that were cited in the prior record were re-checked in this pass: all are present in the JUnit with no failure or skip child. None was removed by f0f3c04e.

## Changes since the last record that touch this phase

- e958e8b1: adds the two tests above (open items 4 and 5). Test-only; no production code.
- 884e0753, b1bb49f2, aef8a351, c71a539d, 403e45f7, bb6b38b7 (earlier pass): sync-lag gauge moved to emit (`service.ts` observer `syncLag`); docs. None touches the steering routes, the brief sections or SC4 code.
- 9b793653, f0f3c04e, c371cece, 7a1d923a, 885e73ce, e3914640 (this pass): these add `reportSilent` to fire-and-forget catches, make null JSON bodies answer 400 on `/evidence`, `/handoff`, `/drift`, `/verify` (`server.ts`), and change `queryEventsFor` to accept `null`. None changes `/steering/*`, `/session/context`, `liveBriefSections`, `brief-sessions.ts`, `steering-waiters.ts`, `hook.ts` or `steering-rest.ts` behaviour. The `steering-rest.ts` change removes the unreferenced exported type `RestSteeringSession` (a46d42c3); no importer remains in `packages/`.
- a46d42c3: deletes dead exports and `fabric.ts`. No covered file imports a deleted module (every covered path exists).
- Commits 49b9aece, b4bdd0fc, d1a5e89b, b4fe6bfe, 6e5d766e and phase 77 commits: as in the prior record (not re-read line by line here).

## Success criteria

| # | Criterion (ROADMAP Phase 67) | Status | Evidence |
|---|---|---|---|
| 1 | `substrate steer sessions\|status\|queue\|ack\|list\|listen` work over REST routes with the same audit, admission and operator guard as the MCP tools; agents cannot author directives. | VERIFIED | Routes in `server.ts` (`/steering/sessions`, `/steering/directives`, `/steering/queue`, `/steering/acknowledge`, `/steering/wait`), each behind `steeringRouteOpen` and calling the tools' own functions. Operator rule in `steering-tools.ts`. CLI in `cli/src/steer/index.ts` and `client.ts`. Named passes: server.steering.test.ts "bound nonoperator writes403, operator queue and directive-only ack commit state and honest hint"; "disabled steering routes remain absent rather than creating identities"; "anonymous401 and malformed400 are distinct from denied well-shaped targets"; admission.test.ts "live lifecycle admission is method-aware and shares the mutation tool classes"; audit/policy.test.ts "every live mutation explicitly requires audit; discovery and private reads do not". |
| 2 | `session_context` (MCP tool and `GET /session/context`) returns a bounded, redacted digest of the other live sessions of the caller's repository, each item with its source and age. | VERIFIED | `session-context.ts` (`SESSION_CONTEXT_LIMITS`, `SESSION_CONTEXT_MAX_BYTES`, `SESSION_CONTEXT_TEXT_MAX`); route in `server.ts`; tool in `mcp.ts`. Named passes: session-context.test.ts "every list stops at its bound and `truncated` names exactly the lists that lost items"; "past the byte cap the oldest events go first and every other list is left whole"; "a secret-shaped string planted in every free-text field never reaches the digest"; "every item names its source and its age"; server.steering.test.ts "REST and MCP session_context preserve proof-free cross-session metadata and self label"; "digest malformed/anonymous/disabled behavior is unchanged". |
| 3 | `memory_brief` gains `sessions`, `steering` and `handoffs` sections behind `SUBSTRATE_BRIEF_SESSIONS`, within the existing size bound. | VERIFIED | `brief-sessions.ts` (`composeLiveSections`, `BRIEF_SESSIONS_SECTION_MAX_CHARS` 1,200); `service.ts` `liveBriefSections` and the merge; priorities in `brief-profile.ts`. Per-section bounds: brief-sessions.test.ts "sections come in print order: sessions, steering, handoffs"; "a section with many long sessions stays inside 1,200 characters and counts what it left out"; "the steering section is bounded the same way, directive bodies included"; "text another session wrote is redacted before it reaches the brief". Combined bound (new): session-context.service.test.ts:375 "under a tight compact byte cap, live sections stay within the bound, whole, naming their source and age" builds the compact brief with all three live sections present at caps 512, 640, 800 and 1024 bytes, and asserts `utf8Bytes(text) <= cap`, that every surviving line appears verbatim in the uncapped brief, that each section is whole, and that the state line is first. Flag off (new): session-context.service.test.ts:394 "with the sessions flag off, live sessions do not change a byte of the brief" asserts identical text and etag with the flag unset versus absent, with the flag on as control. Limitation: the source check keys on the fixture's one other session label (`[steering, hermes]`); handoff and directive lines are checked for age only. |
| 4 | With `SUBSTRATE_STEERING_SESSIONS_TABLE` on, session state lives in `steering_sessions` (its own migration step, opt-in like the audit table) and survives a restart; TTL and cap are enforced. | FAILED (as written) | Step 37 exists and is opt-in (index-store.ts ~766-790; named passes index-store.migrate-optin.test.ts "with the opt-in off or absent, migrate() never creates steering_sessions"; "the step is gated, additive and idempotent, and lists only when its opt-in is on"). No runtime SQL reads or writes `steering_sessions` outside the migration. No `STEERING_SESSION_CAP` or `STEERING_SESSION_TTL` constant exists in non-test code. Session state lives in `live_session_bindings` (index-store.ts:882; `planning/steering-sessions-store.ts` `bunLiveSessionAuthority`); the TTL is the lease (`SUBSTRATE_LIVE_SESSION_LEASE_S`, config.ts:775, :1319). Restart survival holds there: live-session-restart.pg.test.ts "teardown/reconstruction preserves owner proof, canonical state and terminal tombstone with cache migration off"; "actual migration37 stale rows cannot grant or revive across reconstructed services without a cache adapter". See the gap entry above and the owner item. |
| 5 | `substrate session hook` reads `checkpoint_hint` from an acknowledged directive and writes the named checkpoint; a `context` trigger prints the digest; `hook-config` prints all five triggers. | VERIFIED | `cli/src/session/hook.ts`, `steering-consumed.ts`, `hook-config.ts` (`HOOK_CONFIG_TARGETS`). None of these files changed since 6e5d766e. Named passes (hook.test.ts): "an acknowledged directive with a hint gets exactly the checkpoint it names, with no envelope directive id"; "a second run, with the same hint still listed and the worktree changed, writes no second checkpoint for it"; "a server that is down: the normal steering checkpoint is taken, nothing is consumed, exit 0, nothing on stdout"; "the output is at most 4,000 characters however large the digest is, and says lines were cut". hook-config.test.ts "the targets together cover every trigger `session hook` accepts". |
| 6 | `GET /steering/wait` long-polls for a directive for one session with a bounded timeout; `steer listen` uses it. | VERIFIED | `server.ts` `/steering/wait` (200 with `wait_ms` and `directive.sequence`, 204 with `x-steering-wait-ms`, 429 busy); `steering-waiters.ts` (`STEERING_WAIT_PER_SESSION_MAX`, `STEERING_WAIT_TOTAL_MAX`, `nextQueuedDirective` ordered by inbox sequence); CLI `client.ts` `wait` and `index.ts` `listen`. Named passes: server.steering.test.ts "already-queued directive returns immediately without registering timer"; "the wait body carries the delivery sequence of the directive it returns"; "queue wakes only the owner's held wait and releases all resources"; "overlong waits clamp to the configured ceiling, with bounded internal timers; invalid timeout holds nothing"; "client abort and server shutdown leave no waiter or timer"; planning/steering-waiters.test.ts "each directive carries its sequence in its own session, and an after cursor walks one session in queue order"; cli steer/index.test.ts "prints a directive that arrives, then with --once stops at the first"; "a server that answers 204 at once is paced, so the loop cannot spin". |

**Score:** 5 of 6 truths verified (criteria 1, 2, 3, 5, 6). Criterion 4 is FAILED as written and remains FAILED: it is not amended in this record.

### Requirements coverage (REQUIREMENTS.md, phase 67)

| Requirement | Status | Evidence |
|---|---|---|
| STEER-01 | SATISFIED | SC1 |
| STEER-02 | SATISFIED | SC2 |
| STEER-03 | SATISFIED | SC3, including the combined-bound test at session-context.service.test.ts:375 |
| STEER-04 | SATISFIED | "Survives a restart" holds through `live_session_bindings`; live-session-restart.pg.test.ts (16 passes). The requirement text does not name the table; SC4's table wording is the failure |
| STEER-05 | SATISFIED | SC5 |
| STEER-06 | SATISFIED | SC6 |

No orphaned requirements: REQUIREMENTS.md maps only STEER-01..06 to phase 67.

### Anti-patterns

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| packages/mcp-server/src/index-store.ts | 767 | Stale comment: "The application upserts one row per (surface, session_id) and drops rows past the TTL when it loads them at boot" | Warning | Describes behaviour that no longer exists; supports the SC4 finding. Open item 2. |

### Probes and spot-checks

- No runnable spot-check was executed (verifier does not run tests). Behavioural evidence is the JUnit named passes above.
- Migration probe: not applicable to this record (no migration added in the range; step 37 unchanged since 6e5d766e).

## Human verification (not blocking the status; listed for the owner)

- Real-session delivery: no run has shown a steering directive reaching a real session through the hooks (operator-gated; ROADMAP status: hooks not installed). Not observed here.

## Gaps summary

Criterion 4 no longer describes the code. Phase 71 replaced the restart-cache mechanism with `live_session_bindings`, so the criterion's table, in-memory registry, TTL and cap are gone. Restart survival (STEER-04) holds on the new authority, with named Postgres passes. The cap is not replaced. Criterion 3 is now behaviourally tested end to end under the compact cap; the earlier PRESENT_BEHAVIOR_UNVERIFIED item is closed.

## Open items

1. **OWNER ITEM — SC4.** Decide: accept the phase 71 supersession and amend ROADMAP Phase 67 SC4 (restart via `live_session_bindings`; TTL as the lease; cap dropped or re-specified), or reinstate a session cap and a `steering_sessions` writer. Evidence: index-store.ts:766-790 and :882; steering-sessions-store.ts:2-4; config.ts:775, :1319; flag-registry.ts:534; live-session-restart.pg.test.ts. Until decided, status stays `gaps_found`. This record does not amend the criterion and does not reopen any owner decision in force.
2. Correct the stale step 37 comment at index-store.ts:767 (not edited here).
3. ROADMAP.md:1158 (SC4 text) and 67-SUMMARY.md D67-4 (line 29) describe the superseded mechanism; update after item 1.
4. Closed in this pass: end-to-end test with live sections under a tight `SUBSTRATE_BRIEF_COMPACT_BYTES` (e958e8b1, session-context.service.test.ts:375).
5. Closed in this pass: flag-off byte-identity test for `SUBSTRATE_BRIEF_SESSIONS` (e958e8b1, session-context.service.test.ts:394).
6. Operator-gated: install hooks and see a directive reach a real session (unchanged).

---

_Verified: 2026-11-06_
_Verifier: Claude (gsd-verifier)_
