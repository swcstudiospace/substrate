---
phase: 67-live-steering-ga
verified: 2026-11-05T00:00:00Z
status: gaps_found
score: 4 of 6 success criteria VERIFIED; 1 PRESENT_BEHAVIOR_UNVERIFIED (criterion 3, combined size bound); 1 FAILED as written (criterion 4, superseded by phase 71)
covered_files: [".env.example", ".planning/phases/67-live-steering-ga/67-SUMMARY.md", "docs/live-steering.md", "packages/audit/src/policy.ts", "packages/cli/src/index.ts", "packages/cli/src/session/hook-config.ts", "packages/cli/src/session/hook.ts", "packages/cli/src/session/steering-consumed.ts", "packages/cli/src/session/trigger-policy.ts", "packages/cli/src/steer/client.ts", "packages/cli/src/steer/index.ts", "packages/cli/src/steer/plain.ts", "packages/cli/src/steer/render.ts", "packages/cli/src/steer/repo.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/brief-profile.ts", "packages/mcp-server/src/brief-sessions.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/handoff.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planning/session-state.ts", "packages/mcp-server/src/planning/steering-rest.ts", "packages/mcp-server/src/planning/steering-sessions-store.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/planning/steering-waiters.ts", "packages/mcp-server/src/planning/steering.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.ts"]
covered_digest: "v3:sha256:9673b5d6c6e01e6ffc7d6923afa385840fc9e51885f02f90bdf8de355b0e53c0"
behavior_unverified: 1
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: "5 of 6 MET, 1 PARTIAL (record at ba7cc010; quoted test titles no longer exist in the tree and were re-mapped to current titles)"
  gaps_closed: []
  gaps_remaining:
    - "SC4 literal: steering_sessions is a historical table with no runtime writer"
  regressions:
    - "SC4 (previously MET): the in-process registry, write-through store, STEERING_SESSION_CAP/TTL and loadDurable were removed; live_session_bindings (phase 71, migration 42) is the authority now"
gaps:
  - truth: "SC4: With SUBSTRATE_STEERING_SESSIONS_TABLE on, session state lives in steering_sessions and survives a restart; TTL and cap are enforced."
    status: failed
    reason: "The criterion's mechanism no longer exists. steering_sessions (migration 37) is documented as a historical restart cache with no runtime adapter; nothing in runtime code writes or reads it. Session state lives in live_session_bindings (mandatory migration 42, phase 71). Restart survival holds through that table (STEER-04 met). The TTL is now the authoritative lease (SUBSTRATE_LIVE_SESSION_LEASE_S, 60..86400 s, default 3600 s), not the 7-day steering TTL; docs/live-steering.md states the retired restart-cache TTL configuration has no reader. No session cap exists in the current code (STEERING_SESSION_CAP is gone). This is a supersession by a v1.8 phase that the v1.7 record never noted, not a deferral: Step 9b does not apply, because phase 71 does not list this criterion as its deliverable."
    artifacts:
      - path: "packages/mcp-server/src/planning/steering-sessions-store.ts"
        issue: "Header says the steering_sessions restart cache has no runtime adapter or authorization role; the file now holds the live_session_bindings authority (bunLiveSessionAuthority, EXPIRY_PASS_LIMIT=100)."
      - path: "packages/mcp-server/src/planning/session-state.ts"
        issue: "The in-memory registry and its write-through are gone; only LiveSessionStatePort (SQL-authoritative transitions) remains."
      - path: "packages/mcp-server/src/index-store.ts"
        issue: "Step 37 is still gated by SUBSTRATE_STEERING_SESSIONS_TABLE and creates an unused table; its comment (about line 768) still says the application upserts rows and drops rows past the TTL at boot, which is no longer true."
      - path: "docs/live-steering.md"
        issue: "Line 94 says the retired restart-cache TTL configuration has no reader or example; the criterion text still describes it."
    missing:
      - "Owner decision: either accept the phase 71 authority as the replacement and amend SC4 (restart via live_session_bindings; TTL as the lease; cap dropped or re-specified), or reinstate a session cap and a steering_sessions writer. This record does not reopen any owner decision in force."
      - "Correct the step 37 comment in index-store.ts (stale claim). Not edited here."
deferred: []
behavior_unverified_items:
  - truth: "SC3: memory_brief keeps its sections (sessions, steering, handoffs) inside the existing size bound when SUBSTRATE_BRIEF_SESSIONS is on."
    test: "Run memory_brief with SUBSTRATE_BRIEF_SESSIONS=on, a repository with several other sessions, a pending directive and handoffs, under a tight SUBSTRATE_BRIEF_COMPACT_BYTES (MIN_COMPACT_BYTES); compare the compact text's UTF-8 length with the cap and check which lines were dropped."
    expected: "The compact text is at most the cap; dropped lines are the lowest-priority ones, the omitted line counts them; the state line stays first."
    why_human: "Presence and per-section bounds are tested. The combined bound with live sections is structural (served sections go through renderCompactBrief; priorities in brief-profile.ts) and has no end-to-end test in the tree."
coincidental_reliance_items: []
---

# 67-VERIFICATION: Live Steering GA

**Phase goal:** Live Steering is something an operator can see and use, and a session can learn what the other sessions of its repository are doing.
**Verified:** 2026-11-05, at head 6e5d766e (branch gsd/v18-int-all). Supersedes the record of ba7cc010 (2026-10-29).
**Status:** gaps_found
**Re-verification:** Yes. Earlier record had no covered list, so the covered list above is derived from 67-SUMMARY.md (the phase has no PLAN file: ROADMAP says "Plans: none written"), the criteria's named files, and the files the SUMMARY lists. The fingerprint is `verification.fingerprint` output, copied verbatim.

## Gates and evidence

- Gates not run here. Evidence is the gate r33 JUnit report at 6e5d766e, `/root/src/worktrees/backups/gate-r33-junit.xml`: 12290 testcases, 0 failures, 2 skipped (`redact.test.ts` D-04 and the Redis conformance case; neither is in phase 67 scope). No Postgres-gated phase 67 test is skipped; the HARD-S1 restart suite ran with 16 passes.
- Named passes below were matched by exact title against the JUnit `name` attribute and checked for no `<skipped/>` child. Titles in the old record (ba7cc010) for SC1, SC3, SC4 and SC6 are no longer in the tree; this record cites current titles.
- Not run by the verifier: no tests, no tsc, lint or formatters, no database.

## Changes since the last record that touch this phase

- Phase 71 (`live_session_bindings`, migration 42; docs/live-steering.md phase 71 note): replaces the process-memory and restart-cache authority. Re-audited SC4 against it. This is the cause of the SC4 result.
- Phase 77 (`ce06da4d` idempotency keys and per-session sequence; `9b3636ab` keyed replay hardening; `2f70ca6b` docs): `nextQueuedDirective` follows the inbox sequence (`steering-waiters.ts:63`); the wait body and the keyed reply carry the sequence; the keyed claim sits in the audit path on the Postgres route. Re-audited SC1 and SC6 against it; the unkeyed route and the operator guard are unchanged.
- Commits named for 6e5d766e (`49b9aece`, `b4bdd0fc`, `d1a5e89b`, `b4fe6bfe`, `6e5d766e`): judged by file scope. None names a phase 67 criterion. The brief's live sections are appended after the cache (`service.ts` ~2615 and ~2707-2716) and are never cached, so the forget-mark change in `d1a5e89b` does not reach them. Not re-read line by line.

## Success criteria

| # | Criterion (ROADMAP Phase 67) | Status | Evidence |
|---|---|---|---|
| 1 | `substrate steer sessions\|status\|queue\|ack\|list\|listen` work over REST routes with the same audit, admission and operator guard as the MCP tools; agents cannot author directives. | VERIFIED | Routes in `server.ts` (`/steering/sessions` GET and POST, `/steering/directives`, `/steering/queue`, `/steering/acknowledge`, `/steering/wait`), each behind `steeringRouteOpen` and calling the tools' own functions (`queueSteering`, `acknowledgeSteeringWithState`, `readLiveDirectives`). Operator rule in `steering-tools.ts` (`operator-queue`, `operator-ack`). CLI subcommands and routes in `cli/src/steer/index.ts` and `client.ts`. Named passes: server.steering.test.ts "bound nonoperator writes403, operator queue and directive-only ack commit state and honest hint"; "disabled steering routes remain absent rather than creating identities"; "anonymous401 and malformed400 are distinct from denied well-shaped targets"; admission.test.ts "live lifecycle admission is method-aware and shares the mutation tool classes"; "every route server.ts matches on is classified, exempt, or the MCP door — and nothing stale is listed"; policy.test.ts "every REST route server.ts audits has a mode"; "every live mutation explicitly requires audit; discovery and private reads do not". |
| 2 | `session_context` (MCP tool and `GET /session/context`) returns a bounded, redacted digest of the other live sessions of the caller's repository, each item with its source and age. | VERIFIED | `session-context.ts` (`SESSION_CONTEXT_LIMITS`, `SESSION_CONTEXT_MAX_BYTES` 24,000, `SESSION_CONTEXT_TEXT_MAX` 200); route `server.ts` ~2302; tool `mcp.ts` ~724, scope check and `session-context.disabled` refusal. Named passes: session-context.test.ts "every list stops at its bound and `truncated` names exactly the lists that lost items"; "past the byte cap the oldest events go first and every other list is left whole"; "a secret-shaped string planted in every free-text field never reaches the digest"; "every item names its source and its age"; "the caller's own session"; server.steering.test.ts "REST and MCP session_context preserve proof-free cross-session metadata and self label"; "digest malformed/anonymous/disabled behavior is unchanged". |
| 3 | `memory_brief` gains `sessions`, `steering` and `handoffs` sections behind `SUBSTRATE_BRIEF_SESSIONS`, within the existing size bound. | PRESENT_BEHAVIOR_UNVERIFIED | Sections and flag are present and wired: `brief-sessions.ts` (`composeLiveSections`, `BRIEF_SESSIONS_SECTION_MAX_CHARS` 1,200); `service.ts` `liveBriefSections` (~4135) and the merge at ~2707-2716; priorities in `brief-profile.ts` (`steering` 2, `sessions` 8, `handoffs` 9). Named passes: brief-sessions.test.ts "sections come in print order: sessions, steering, handoffs"; "a section with many long sessions stays inside 1,200 characters and counts what it left out"; "the steering section is bounded the same way, directive bodies included"; "text another session wrote is redacted before it reaches the brief"; "a read that fails, or a section the request does not ask for, leaves no note and no section"; server.steering.test.ts "historical-only brief never reads a private directive; explicit owner proof gets request-local augmentation". The combined bound rests on the generic compact renderer: served sections, live ones included, go through `renderCompactBrief`, whose hard byte cap is tested generically in brief-profile.test.ts "a tampered cache entry cannot reorder the compact rendering: priority comes from the section id". No test renders live sections under a tight cap. The old record's "off, the brief is byte-identical" test is gone; the current off-case test (server.steering.test.ts, `SUBSTRATE_BRIEF_SESSIONS: "off"`) checks that no private directive is read, not byte identity. |
| 4 | With `SUBSTRATE_STEERING_SESSIONS_TABLE` on, session state lives in `steering_sessions` (its own migration step, opt-in like the audit table) and survives a restart; TTL and cap are enforced. | FAILED (as written) | Step 37 exists and is opt-in (index-store.ts ~766-790; named passes index-store.migrate-optin.test.ts "with the opt-in off or absent, migrate() never creates steering_sessions"; "the step is gated, additive and idempotent, and lists only when its opt-in is on"). Runtime use is absent: `steering_sessions` appears only in the migration and in the store's header, which says it has no runtime adapter. Session state is in `live_session_bindings` (`steering-sessions-store.ts` `bunLiveSessionAuthority`). Restart survival is met there: live-session-restart.pg.test.ts (HARD-S1, 16 passes, 0 skipped), e.g. "teardown/reconstruction preserves owner proof, canonical state and terminal tombstone with cache migration off"; "actual migration37 stale rows cannot grant or revive across reconstructed services without a cache adapter"; "SQL-time expiry overrides an already-admitted independent service and cannot be renewed or re-registered". TTL is the lease (`SUBSTRATE_LIVE_SESSION_LEASE_S`, default 3600 s). No session cap exists. See the gap entry. |
| 5 | `substrate session hook` reads `checkpoint_hint` from an acknowledged directive and writes the named checkpoint; a `context` trigger prints the digest; `hook-config` prints all five triggers. | VERIFIED | `cli/src/session/hook.ts` (steering trigger reads the hint, `steering-consumed.ts` records consumed ids), `hook-config.ts` (`HOOK_CONFIG_TARGETS` = claude-code, git-post-commit, steering, baseline, context). Named passes (hook.test.ts): "an acknowledged directive with a hint gets exactly the checkpoint it names, with no envelope directive id"; "a second run, with the same hint still listed and the worktree changed, writes no second checkpoint for it"; "a server that is down: the normal steering checkpoint is taken, nothing is consumed, exit 0, nothing on stdout"; "takes no checkpoint and needs no session id"; "the output is at most 4,000 characters however large the digest is, and says lines were cut"; hook-config.test.ts "there are five targets, one per trigger the hook accepts, and the context script keeps stdout (it is the digest) while discarding stderr"; "the targets together cover every trigger `session hook` accepts". Hooks are not installed in any host (operator-gated; not a code criterion). |
| 6 | `GET /steering/wait` long-polls for a directive for one session with a bounded timeout; `steer listen` uses it. | VERIFIED | `server.ts` ~2286-2300 (`/steering/wait`, 200 with `wait_ms` and `directive.sequence`, 204 with `x-steering-wait-ms`, 429 busy); `steering-waiters.ts` (`SteeringWaiters`, `STEERING_WAIT_PER_SESSION_MAX` 4, `STEERING_WAIT_TOTAL_MAX` 256, `nextQueuedDirective` ordered by inbox sequence); `service.ts` `waitLiveDirectives` (~2300); CLI `client.ts` `wait` (~525) and `index.ts` `listen`. Named passes: server.steering.test.ts "already-queued directive returns immediately without registering timer"; "the wait body carries the delivery sequence of the directive it returns"; "queue wakes only the owner's held wait and releases all resources"; "final timeout204 rechecks authority and does not recharge or retain a waiter"; "overlong waits clamp to the configured ceiling, with bounded internal timers; invalid timeout holds nothing"; "client abort and server shutdown leave no waiter or timer"; "explicit service close wakes local waits immediately into terminal404"; steering-waiters.test.ts "each directive carries its sequence in its own session, and an after cursor walks one session in queue order"; cli steer index.test.ts "prints a directive that arrives, then with --once stops at the first"; "--max-wait-ms is one budget for the whole command"; "a server that answers 204 at once is paced, so the loop cannot spin". |

**Score:** 4/6 truths verified (criteria 1, 2, 5, 6). Criterion 3 is PRESENT_BEHAVIOR_UNVERIFIED and is excluded from the verified count. Criterion 4 is FAILED as written.

### Requirements coverage (REQUIREMENTS.md, phase 67)

| Requirement | Status | Evidence |
|---|---|---|
| STEER-01 | SATISFIED | SC1 |
| STEER-02 | SATISFIED | SC2 |
| STEER-03 | PARTIAL | SC3: sections and flag present; combined bound not behaviourally tested |
| STEER-04 | SATISFIED | "Survives a restart" holds through `live_session_bindings` (HARD-S1). The requirement text does not name the table; SC4's table wording is the failure |
| STEER-05 | SATISFIED | SC5 |
| STEER-06 | SATISFIED | SC6 |

No orphaned requirements: REQUIREMENTS maps only STEER-01..06 to phase 67.

### Anti-patterns

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| packages/mcp-server/src/index-store.ts | ~768 | Stale comment: "The application upserts one row per (surface, session_id) and drops rows past the TTL when it loads them at boot" | Warning | Describes behaviour that no longer exists; supports the SC4 finding. No debt marker (TBD/FIXME/XXX) in any covered file. |

### Probes and spot-checks

- Step 7b: no single-command runnable spot-check run; behavioural evidence is the JUnit named passes above. No full suite run.
- Step 7c: skipped. Phase 67 is not a migration or tooling phase, and no probe is declared in its SUMMARY.

## Human verification (not blocking the status; listed for the owner)

- SC3 combined bound: see behavior_unverified_items.
- Real-session delivery: no run has shown a steering directive reaching a real session through the hooks (ROADMAP status: hooks not installed; operator-gated).

## Gaps summary

Criterion 4 no longer describes the code. Phase 71 replaced the restart-cache mechanism with `live_session_bindings`, so the criterion's table, in-memory registry, TTL and cap are gone. Restart survival (STEER-04) holds on the new authority, with named Postgres passes. The cap is not replaced. The owner must decide whether to accept the supersession (and amend SC4) or reinstate a cap and a writer. Criterion 3 is structurally bounded but untested end to end with live sections present. Both are open items. No override is recorded.

## Open items

1. Owner decision on SC4 (accept phase 71 supersession and amend, or reinstate cap and writer).
2. Correct the stale step 37 comment in `index-store.ts` (~768).
3. ROADMAP Phase 67 text and the 67-SUMMARY "Key decisions" (D67-4, TTL and cap) describe the superseded mechanism; they need updating after decision 1.
4. Add an end-to-end test: live sections under a tight `SUBSTRATE_BRIEF_COMPACT_BYTES`.
5. Add a flag-off byte-identity test for `SUBSTRATE_BRIEF_SESSIONS` (the old named test is gone).
6. Operator-gated: install hooks and see a directive reach a real session (unchanged).

---

_Verified: 2026-11-05_
_Verifier: Claude (gsd-verifier)_
