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
  - truth: "~~With SUBSTRATE_STEERING_SESSIONS_TABLE on, session state lives in `steering_sessions` (own migration step, opt-in), survives a restart, and TTL and cap are enforced~~ Superseded (owner decision, 2026-11-19) by the `live_session_bindings` design: session state lives in `live_session_bindings` (mandatory, migration v42), survives a restart, and expiry is enforced in SQL (`expires_at`)"
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
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: gaps_found
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
| 4 | ~~With `SUBSTRATE_STEERING_SESSIONS_TABLE` on, session state lives in `steering_sessions` (own migration step, opt-in), survives a restart, and TTL and cap are enforced~~ **Superseded (owner decision, 2026-11-19):** session state lives in `live_session_bindings` (mandatory, migration v42), survives a restart, and expiry is enforced in SQL (`expires_at`, at most `EXPIRY_PASS_LIMIT = 100` expiries per pass). The `steering_sessions` cap and TTL are superseded by that design. | ✗ FAILED | Migration v37 `steering_sessions` is opt-in (`index-store.ts` 774-789). Nothing reads or writes it at runtime. `flag-registry.ts` says "Runtime cache removed; never grants live authority". The authority is `live_session_bindings` (v42, `index-store.ts` ~884), used by `planning/steering-sessions-store.ts` (`bunLiveSessionAuthority`). Restart survival is claimed through that table and covered by `live-session-restart.pg.test.ts`, which was not run. TTL is SQL-time `expires_at` with `EXPIRY_PASS_LIMIT = 100` per pass. No live-session count cap was found; the 1,000-row cap and boot-load TTL from the prior record are gone. The cited `session-state.durable.test.ts` and `steering-sessions-store.pg.test.ts` do not exist at HEAD. See gap 1. |
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
Installing the printed `steering` and `context` hook configuration in a host (ADR 0007 maps no host event to them); enabling `SUBSTRATE_PLANNING_STEERING`, `SUBSTRATE_PLANNING_STEERING_PRINCIPALS`, `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE`, `SUBSTRATE_BRIEF_SESSIONS` and `SUBSTRATE_STEERING_SESSIONS_TABLE` in production, which creates the opt-in tables; issuing operator tokens; a live restart rehearsal of the registry; delivery to a real session end to end. None of it was done.

## Closure, 2026-11-11 (branch `reconcile/main-2026-11-11`)

Scope: the repo-buildable residual risks, gaps and criterion 3 above. Code commit `dfd7a2f0` (phase 67: close the repo-buildable live steering gaps); this closure record is its own commit. The 2026-10-29 record above is unchanged. The phase is still not GA: the operator-gated items and two residuals below stay open.

Evidence was run here: `bun test` on `brief-sessions`, `server.steering`, `session-context`, `session-context.service`, `session/hook-install` (new), `session/hook-config` and `session/command`: 220 of 220 pass. `bunx tsc --noEmit` exit 0; Biome clean on the touched files (one lint fix in `hook-install.ts`, re-tested, 22 of 22 pass). The tsc run preceded that one type-only annotation (`let info: Stats`). Tests use fake servers and scratch directories. No flag was added, no host or production store was touched, and no hook was installed.

### Residual risks and gaps

| # | Residual (above) | Status | Closure and evidence |
|---|---|---|---|
| 1 | Criterion 3: the combined brief is not proved inside the compact byte cap with live sections present | CLOSED | `brief-sessions.test.ts` "the compact byte cap holds with all four live sections beside a full cached brief, and the omitted line says what was dropped" (sessions, steering, handoffs and worktrees, each at its full bound, beside a cached heading, nodes, decisions and actions; at `MIN_COMPACT_BYTES` and at the default; the omitted line is present and the render is deterministic). "with the live sections alone the brief stays inside the smallest cap, and the lower-priority sections are the ones dropped". The full profile is not capped: each live section is at most 1,200 characters and the compact profile is the bound. |
| 2 | The hint after a restart: an acknowledged directive carries `checkpoint_hint: null` | NOT CLOSED | The acknowledged row in `planning_steering_audit` records the outcome, not whether a state movement committed, so the hint cannot be rebuilt from it. Closing it needs an additive migration step (a column for the committed movement) in `packages/mcp-server/src/index-store.ts`, which is outside this closure's paths, plus a rehearsal of that step on a restored dump. The current behaviour fails safe: the hook writes no checkpoint for a restored record. |
| 3 | Durability scope: the inbox is memory-only without `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` | OPERATOR-GATED | Opt-in by design; no default changed. Enabling the flag in production creates the table (migration steps 33 and 34, rehearsal first). See the operator list. |
| 4 | No route-level audit-refusal test | CLOSED | `server.steering.test.ts` "operator queue and acknowledge: a refused audit write is 503 audit-unavailable and leaves the inbox as it was". With the audit sink refusing fail-closed writes: `POST /steering/queue` and `POST /steering/acknowledge` answer 503 `audit-unavailable`; the steering history and the inbox are unchanged (the queued directive is still `queued` and its body is not listed); the two refusals are audited as `denied` and no allowed record is written. |
| 5 | Held connections: a long poll counts as one admission for as long as it waits | NOT CLOSED | Releasing the admission slot during a wait changes the admission contract in `packages/mcp-server/src/admission.ts`, outside this closure's paths, and needs Main's decision. The waiter bounds (4 per session, 256 overall, 429 past them) are unchanged. |
| 6 | A stale session stays listed in the digest until its age says so | CLOSED | The digest lists live sessions only: a presence row whose TTL has passed (`state: "stale"`) is left out (`session-context.ts`, documented in its module comment). Tests: `session-context.test.ts` "a stale presence row is not a live session and is left out, with its active neighbours kept" and "a presence list of stale rows alone leaves the sessions list empty, not truncated". The steering source already lists only active sessions; claims already drop lapsed leases. |
| 7 | Tests run against fake servers and stores; delivery to a real session never exercised | OPERATOR-GATED | Not repository-buildable: it needs a live session on a real host. See the operator list. |

### Hook installer (repository code, tested with fakes)

The gap was that the printed Claude Code `Stop` hook had no installer. `substrate session hook-install claude-code --settings PATH [--write]` (`packages/cli/src/session/hook-install.ts`, dispatch in `command.ts`) merges that hook into a settings file. It is dry run by default and prints the hook block, never the file, which can hold an `env` block with credentials. With `--write` it copies the previous file to `PATH.substrate-backup`, writes a temporary file and renames it, keeps the file's permission bits (a new file is `0600`), and refuses a symbolic link (a rename would replace it), a malformed or wrong-shaped file, a non-regular file and a file over 1 MiB. It is idempotent. Tests: `hook-install.test.ts` (22 tests, scratch directories only). Only `claude-code` is accepted: ADR 0007 maps the `Stop` event to it. `steering`, `baseline`, `context` and `git-post-commit` need host values or an event the operator chooses, so they stay printed text.

### Criteria

| # | Before | After this closure |
|---|---|---|
| 1 | MET | MET (unchanged) |
| 2 | MET | MET (unchanged) |
| 3 | PARTIAL | MET: the combined brief is proved inside the compact cap (residual 1). Restart hints are a separate residual (2). |
| 4 | MET | MET (unchanged); durability without the audit flag is residual 3 |
| 5 | MET | MET for the repository. The `steering` and `context` hooks are still printed text with no host event (operator list). A repository installer now exists for `Stop` only. |
| 6 | MET | MET (unchanged); held connections are residual 5 |

### Operator-gated (unchanged from above, plus these)

- Dry run, then `substrate session hook-install claude-code --settings <host settings file>` and, after review, `--write`. Never run from this repository.
- Choosing the host event for the `steering` and `context` configuration printed by `hook-config`. ADR 0007 maps none.
- Enabling `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` in production (residual 3), with migration steps 33 and 34 rehearsed on a restored dump.
- The restart-hint migration (residual 2): an operator decision on the new step, its rehearsal, and then the code change.
- Live delivery to a real session end to end (residual 7).

## Closure of residual 2, the restart hint (2026-11-11, branch `reconcile/main-2026-11-11`)

Residual 2 is CLOSED in repository code. Migration step 45 `planning_steering_movements` (additive, opt-in `steering-audit`, expand) records the committed result of each acknowledgement's session-state step. `applied` is a movement the session committed, and `checkpoint_hint` records whether the reply named a hint. The acknowledgement path writes it once after the session port answers (`steering-tools.ts` `recordSession`). The restart listing joins it (`steering-store.ts` `readClosed`), so a directive acknowledged before a restart is listed with the hint its live reply carried, and `GET /steering/directives` and the hook name the same checkpoint.

Evidence: `planning/steering-idempotency.pg.test.ts` "a session move committed before a restart is still listed with its checkpoint hint" passes against a disposable `postgres:16`, alongside the keyed-replay tests (6 of 6). The old residual is no longer pinned as `null`: `steering-wiring.test.ts` "the route still lists a directive that was acknowledged before the restart…" is a fake-port test of the earlier behaviour and still passes, because the fake keeps no movement row.

Residual, by design: a crash between the acknowledgement row and the step-45 row leaves no hint, which fails safe. The record is written after the port answers, since the audit row must precede the effect.

Operator gate, not run: rehearse migration steps 44 and 45 on a restored production dump before `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` is enabled in production. The operator decision named above is made by this change; the rehearsal is what remains.
