---
phase: 67-live-steering-ga
verified: 2026-11-18T12:26:31Z
status: gaps_found
score: 4/6 success criteria verified (criterion 3 PARTIAL, criterion 4 FAILED against its literal wording)
covered_files: [".planning/REQUIREMENTS.md", ".planning/phases/67-live-steering-ga/67-CONTEXT.md", ".planning/phases/67-live-steering-ga/67-SUMMARY.md", "packages/cli/src/session/hook.ts", "packages/cli/src/steer/client.ts", "packages/cli/src/steer/index.ts", "packages/mcp-server/src/brief-sessions.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/planning/steering-sessions-store.ts", "packages/mcp-server/src/planning/steering-waiters.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/session-context.ts"]
covered_digest: "v3:sha256:a76ed611f3001b640771e08656f52275d8021aaa3b6fcdad270d41c33ace4092"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: "5 of 6 MET, 1 PARTIAL (criterion 3); recorded 2026-10-29 at main ba7cc010"
  previous_record: "67-VERIFICATION.md dated 2026-10-29, read-only, nothing run"
  gaps_closed: []
  gaps_remaining:
    - "Criterion 3: combined brief size with live sections not proved inside the compact bound"
    - "Criterion 4: steering_sessions restart-cache with TTL and cap (superseded at HEAD; see gap 1)"
  regressions:
    - "Criterion 4 evidence cited on 2026-10-29 no longer exists at HEAD: planning/session-state.durable.test.ts and steering-sessions-store.pg.test.ts are absent; the runtime restart cache and its 1,000-row cap were removed (commit ac313051 / d535f8c6)"
gaps:
  - truth: "With SUBSTRATE_STEERING_SESSIONS_TABLE on, session state lives in `steering_sessions` (own migration step, opt-in), survives a restart, and TTL and cap are enforced"
    status: failed
    reason: "At HEAD the steering_sessions table is migration 37 with its own opt-in, but nothing reads or writes it at runtime. flag-registry.ts describes SUBSTRATE_STEERING_SESSIONS_TABLE as 'Runtime cache removed; never grants live authority'. steering-sessions-store.ts says the table 'has no runtime adapter or authorization role'. Session authority is the mandatory live_session_bindings table (migration 42, index-store.ts line ~884), used through bunLiveSessionAuthority. Restart survival is provided by live_session_bindings and tested in live-session-restart.pg.test.ts. TTL is SQL-time expires_at, with at most EXPIRY_PASS_LIMIT=100 expiries per pass. No live-session count cap was found. The 1,000-row in-memory cap and the boot-load TTL that the 2026-10-29 record cited are gone; the cited test file is not in the tree at HEAD."
    artifacts:
      - path: "packages/mcp-server/src/planning/steering-sessions-store.ts"
        issue: "Header states the historical steering_sessions table has no runtime adapter; the authority reads and writes live_session_bindings"
      - path: "packages/mcp-server/src/flag-registry.ts"
        issue: "SUBSTRATE_STEERING_SESSIONS_TABLE is documented as migration selection only, with the runtime cache removed"
      - path: "packages/mcp-server/src/index-store.ts"
        issue: "steering_sessions migration (v37, opt-in) is retained by migration history; live_session_bindings (v42) is the table in use"
    missing:
      - "An owner decision, recorded in .planning, to either (a) accept the supersession by ac313051 / d535f8c6 and amend criterion 4 and STEER-04 to name live_session_bindings and SQL-time expiry, or (b) restore a steering_sessions runtime with a TTL and a live-session cap. Under (a), the cap clause needs a stated bound, or its removal."
      - "A Postgres run of live-session-restart.pg.test.ts and live-session-authority.pg.test.ts at the candidate HEAD (both skip without SUBSTRATE_TEST_PG_URL); not run here."
deferred: []
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: "Install the printed `steering` and `context` hook configuration (`substrate session hook-config`) in one real host and drive a directive through `substrate steer queue` / `steer listen` to that session."
    expected: "The directive is delivered to the live session, the checkpoint_hint writes its checkpoint, and the context trigger prints the digest inside that session."
    why_human: "Delivery to a real session has never been exercised; ADR 0007 maps no host event to these triggers. Operator-gated."
  - test: "Run the Postgres suites with SUBSTRATE_TEST_PG_URL set: live-session-restart.pg.test.ts and live-session-authority.pg.test.ts. Then restart a live server during a held `/steering/wait` and confirm the wait ends and the session state survives."
    expected: "Owner proof, canonical state and terminal tombstones survive the restart. The held wait ends on close. Expired rows stay closed."
    why_human: "Needs a live Postgres and a real server restart; the verifier was not to run the live stack. Also needed for STEER-04."
  - test: "Enable SUBSTRATE_BRIEF_SESSIONS in a deployed server and read a compact memory_brief for a session with live peers."
    expected: "The brief stays inside the compact byte bound with sessions, steering and handoffs present (residual of criterion 3)."
    why_human: "No test proves the combined brief stays within the compact bound with live sections present. Needs a live read."
---

# Phase 67: Live Steering GA Verification Report

**Phase Goal:** Live Steering is something an operator can see and use, and a session can learn what the other sessions of its repository are doing.
**Verified:** 2026-11-18T12:26:31Z
**Status:** gaps_found
**Re-verification:** Yes. The 2026-10-29 record (gaps_found, read-only, at main ba7cc010) is superseded. Each criterion was re-checked against candidate HEAD 357d6b15. The targeted test files below were run once each, alone. The Postgres suites and any live stack were not run.

## Goal Achievement

### Success Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `substrate steer sessions\|status\|queue\|ack\|list\|listen` work over REST routes with the same audit, admission and operator guard as the MCP tools; agents cannot author directives | ✓ VERIFIED | Routes in `packages/mcp-server/src/server.ts`: GET/POST `/steering/sessions` (2274-2300), GET `/steering/directives` (2301), POST `/steering/queue` (2313), POST `/steering/acknowledge` (2325), GET `/steering/wait` (2336). Each passes `steeringRouteOpen`. `steer/index.ts` SUBCOMMANDS (line 101-103) includes sessions, status, queue, ack, list, listen. `server.steering.test.ts`: 29 pass, 0 fail (includes the bound non-operator writes → 403 case). `steer/index.test.ts`: 235 pass, 0 fail. Admission and policy tests were not run in this verification. |
| 2 | `session_context` (MCP tool and `GET /session/context`) returns a bounded, redacted digest of the other live sessions of the caller's repository: presence, worktree and branch, claims, recent events, handoffs, planning changes, each with source and age | ✓ VERIFIED | `packages/mcp-server/src/session-context.ts` (`SESSION_CONTEXT_LIMITS`, `SESSION_CONTEXT_MAX_BYTES = 24_000`, `SESSION_CONTEXT_BUDGET_MS = 2_000`). GET `/session/context` at server.ts 2366, refusing with `session-context.disabled` when `SUBSTRATE_BRIEF_SESSIONS` is off (audited). `session-context.test.ts`: 26 pass, 0 fail. |
| 3 | `memory_brief` gains `sessions`, `steering`, `handoffs` sections behind `SUBSTRATE_BRIEF_SESSIONS`, within the existing size bound | ⚠️ PARTIAL | Flag: `config.ts:778, 1305`. Sections: `brief-sessions.ts` `sessionsSection`, `steeringSection`, `handoffsSection`, and `composeLiveSections` (357). Each is held to `BRIEF_SESSIONS_SECTION_MAX_CHARS = 1_200`, tested by "the section stays inside the 1,200-character bound" (line 463). Wired in `service.ts` `liveBriefSections` (3985-4020). `brief-sessions.test.ts`: 42 pass, 0 fail. Residual: no test shows the combined brief stays inside the compact profile bound with live sections present. |
| 4 | With `SUBSTRATE_STEERING_SESSIONS_TABLE` on, session state lives in `steering_sessions` (own migration step, opt-in), survives a restart, and TTL and cap are enforced | ✗ FAILED | Migration v37 `steering_sessions` is opt-in (`index-store.ts` 774-789). Nothing reads or writes it at runtime. `flag-registry.ts` says "Runtime cache removed; never grants live authority". The authority is `live_session_bindings` (v42, `index-store.ts` ~884), used by `planning/steering-sessions-store.ts` (`bunLiveSessionAuthority`). Restart survival is claimed through that table and covered by `live-session-restart.pg.test.ts`, which was not run. TTL is SQL-time `expires_at` with `EXPIRY_PASS_LIMIT = 100` per pass. No live-session count cap was found; the 1,000-row cap and boot-load TTL from the prior record are gone. The cited `session-state.durable.test.ts` and `steering-sessions-store.pg.test.ts` do not exist at HEAD. See gap 1. |
| 5 | `substrate session hook` reads `checkpoint_hint` from an acknowledged directive and writes the named checkpoint; a `context` trigger prints the digest; `hook-config` prints all five triggers | ✓ VERIFIED | `packages/cli/src/session/hook.ts`: checkpoint_hint reader (179-183), `context` trigger returns the digest (216-217, 375). `hook-config.ts`: `HOOK_CONFIG_TARGETS = ["claude-code", "git-post-commit", "steering", "baseline", "context"]` (line 15), five targets. `hook.test.ts`: 82 pass, 0 fail. |
| 6 | `GET /steering/wait` long-polls for one session's directive with a bounded timeout; `steer listen` uses it | ✓ VERIFIED | Route at server.ts 2336-2365, timeout clamped by `SUBSTRATE_STEERING_WAIT_MAX_MS` (config.ts 1304, default 30 s, range 1,000 to 120,000). 204 with `x-steering-wait-ms` on timeout, 429 past the waiter bounds. `steer/client.ts:525` calls `/steering/wait`. `planning/steering-waiters.test.ts`: 21 pass, 0 fail. |

**Score:** 4/6 verified (criteria 1, 2, 5, 6). Criterion 3 is partial. Criterion 4 fails against its literal wording.

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|---|---|---|---|
| STEER-01 | `substrate steer` lists sessions and steering state, and queues, acknowledges and lists directives | ✓ SATISFIED | Criterion 1 evidence. |
| STEER-02 | Bounded, redacted digest of peer sessions | ✓ SATISFIED | Criterion 2 evidence. |
| STEER-03 | `memory_brief` sections behind a flag | ⚠️ SATISFIED WITH RESIDUAL | Criterion 3 evidence. The combined-size residual is open. |
| STEER-04 | Steering session state survives a server restart | ? NEEDS HUMAN | Survival is designed through `live_session_bindings`. The Postgres restart tests were not run. |
| STEER-05 | Hook reads `checkpoint_hint` and a context trigger injects the digest | ✓ SATISFIED | Criterion 5 evidence. |
| STEER-06 | Long poll for a directive | ✓ SATISFIED | Criterion 6 evidence. |

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/mcp-server/src/server.ts` | Steering and session-context REST routes | ✓ VERIFIED | Routes at 2274-2366. |
| `packages/mcp-server/src/session-context.ts` | Bounded, redacted digest | ✓ VERIFIED | Limits and byte cap present. |
| `packages/mcp-server/src/brief-sessions.ts` | Live brief sections | ✓ VERIFIED | Sections bounded to 1,200 characters. |
| `packages/mcp-server/src/planning/steering-sessions-store.ts` | Durable session state | ⚠️ PRESENT, NOT THE CITED DESIGN | The live authority is `live_session_bindings`. Its header says the `steering_sessions` table has no runtime role. |
| `packages/mcp-server/src/index-store.ts` | Steering sessions migration step | ⚠️ PRESENT, INERT | v37 is opt-in and unused at runtime. |
| `packages/cli/src/session/hook.ts` | `checkpoint_hint` reader and context trigger | ✓ VERIFIED | Present, 82 tests pass. |
| `packages/cli/src/steer/index.ts` and `client.ts` | `steer` subcommands and listen over `/steering/wait` | ✓ VERIFIED | Present, 235 tests pass. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `steer listen` | `GET /steering/wait` | `steer/client.ts:525` | ✓ WIRED | |
| `memory_brief` | `composeLiveSections` | `service.ts:3985-4020` | ✓ WIRED | Gated on `briefSessions`. |
| `GET /session/context` | `sessionContext` | `server.ts` 2366 to `service.sessionContext` | ✓ WIRED | Off → audited refusal, 503. |
| Steering session authority | `steering_sessions` table | none | ✗ NOT WIRED | Authority reads and writes `live_session_bindings`. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `session_context` digest | sessions, claims, events, handoffs | presence, graph claims, ledger, handoff reads | Yes (`session-context.test.ts` 26 pass) | ✓ FLOWING |
| Brief sections | sessions, steering, handoffs | `composeLiveSections` sources | Yes (`brief-sessions.test.ts` 42 pass) | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Session context digest and bounds | `bun test packages/mcp-server/src/session-context.test.ts` | 26 pass, 0 fail | ✓ PASS |
| Brief live sections and size bound | `bun test packages/mcp-server/src/brief-sessions.test.ts` | 42 pass, 0 fail | ✓ PASS |
| Steering REST routes | `bun test packages/mcp-server/src/server.steering.test.ts` | 29 pass, 0 fail | ✓ PASS |
| Steering migration opt-in gating | `bun test packages/mcp-server/src/index-store.migrate-optin.test.ts` | 11 pass, 0 fail | ✓ PASS |
| Hook checkpoint_hint and context trigger | `bun test packages/cli/src/session/hook.test.ts` | 82 pass, 0 fail | ✓ PASS |
| `steer` CLI including listen | `bun test packages/cli/src/steer/index.test.ts` | 235 pass, 0 fail | ✓ PASS |
| Long-poll waiter bounds | `bun test packages/mcp-server/src/planning/steering-waiters.test.ts` | 21 pass, 0 fail | ✓ PASS |
| Durable restart and TTL on Postgres | `live-session-restart.pg.test.ts` | not run (needs `SUBSTRATE_TEST_PG_URL`) | ? SKIP |

### Probe Execution

No probe scripts declared for this phase. Not applicable.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `packages/mcp-server/src/flag-registry.ts` | 534 | `SUBSTRATE_STEERING_SESSIONS_TABLE` documented as selecting an inert migration | ⚠️ Warning | Operators can enable a flag that does nothing at runtime |
| `.planning/phases/67-live-steering-ga/67-VERIFICATION.md` (prior) | criterion 4 | Cited tests no longer in the tree | ⚠️ Warning | The previous record cannot be audited against HEAD |
| `.planning/ROADMAP.md` | Phase 67 status | Says "PARTIAL in delivery" with hooks not installed | ℹ️ Info | Matches the human items below |

No TBD, FIXME or XXX markers found in the phase-67 implementation files reviewed.

### Human Verification Required

### 1. Delivery to a real session

**Test:** Install the `steering` and `context` hook configuration from `substrate session hook-config` in one host. Queue a directive with `substrate steer queue` and receive it with `steer listen`.
**Expected:** The directive reaches the live session. The checkpoint_hint writes its checkpoint. The context trigger prints the digest there.
**Why human:** Never exercised. ADR 0007 maps no host event to these triggers.

### 2. Restart survival on Postgres

**Test:** Run `live-session-restart.pg.test.ts` and `live-session-authority.pg.test.ts` with `SUBSTRATE_TEST_PG_URL` set. Then restart a live server during a held `/steering/wait`.
**Expected:** Owner proof, canonical state and terminal tombstones survive. The held wait ends on close.
**Why human:** Needs a live Postgres and a real restart. Also needed to settle STEER-04.

### 3. Combined brief size

**Test:** With `SUBSTRATE_BRIEF_SESSIONS` on in a deployed server, read a compact `memory_brief` for a session with live peers.
**Expected:** The brief stays inside the compact bound with all three live sections present.
**Why human:** No test proves this (criterion 3 residual).

### Gaps Summary

Five of six criteria are satisfied in code and in the targeted tests: the REST routes and CLI, the bounded session digest, the brief sections, the hook reader and context trigger, and the long-poll. Criterion 3 is partial: its sections are bounded, but the combined brief bound is unproven.

Criterion 4 fails against its literal wording. The session state that survives a restart is in `live_session_bindings`, not in the opt-in `steering_sessions` table, which is now inert. The TTL is SQL-time and the 1,000-row cap is gone. The 2026-10-29 record cited a test file that does not exist at HEAD. Whether this is an accepted supersession (commit ac313051, "durable per-session credentials", a breaking change) or a regression is an owner decision. Until an override is recorded or the criterion is amended, the status stays `gaps_found`.

---

_Verified: 2026-11-18T12:26:31Z_
_Verifier: gsd-verify-queue-2 (gsd-verifier)_
