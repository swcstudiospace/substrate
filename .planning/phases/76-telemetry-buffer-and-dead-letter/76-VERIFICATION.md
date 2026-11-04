---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-04T23:05:04Z
status: human_needed
score: "2/2 must-haves verified (SC1 VERIFIED within the owner-accepted pre-send scope, PLAN D76-10, with the buffer enabled per D76-15; SC2 PASSED by owner override, not verified). No gap open in code. W-L2-TIP-ORDER for handoff() is closed in code at a9e477e2; its owner ratification is not recorded."
covered_files: [".env.example", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-PLAN.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-SUMMARY.md", "docs/config-reference.md", "docs/greptime-ledger.md", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-buffer.test.ts", "packages/mcp-server/src/event-buffer.ts", "packages/mcp-server/src/event-dead-letter.test.ts", "packages/mcp-server/src/event-dead-letter.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/handoff.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/reanchor-run.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:62502f6bfb24d76aa9e7021f50a33c34a32b2a1eece4e7e5c6bec7888fc681ef"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag."
    reason: "Owner accepted the override on 2026-11-02. The dead-letter store is deliberately unbounded (plan decision D76-13): a bound would have to drop records, the silent loss this phase removes. The buffer is bounded by SUBSTRATE_EVENT_BUFFER_MAX, and the depth of both stores is reported in /healthz. A dead-letter cap is a tracked follow-up."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: "2/2 (prior record 76-VERIFICATION.md at 504da465, verified 2026-11-04T22:36:18Z)"
  mode: "initial mode: the prior record has no gaps: section. Re-checked at 9e71f263; the only covered-file change since 504da465 is a test in service.test.ts outside the phase 76 tests. Changes are listed under Changed Since Prior Record."
  gaps_closed:
    - "R-2: drain(all) during an in-flight pass dropped the all flag (a0572cf7; event-buffer.ts:287-305; tests event-buffer.test.ts:226)"
    - "R-3: abandonAll() cleared the in-flight entry (a0572cf7; event-buffer.ts:318-327; tests event-buffer.test.ts:245, :265)"
    - "W-L2-TIP-ORDER for handoff(): the chain-tip read preceded the surrogate refusal (a9e477e2; service.ts:7628-7637 before the read at 7646; test service.test.ts:1669)"
  gaps_remaining: []
  regressions: []
warnings:
  - id: HARD-R3-ORPHANED
    truth: "REQUIREMENTS.md HARD-R3 maps to Phase 76."
    status: "ORPHANED. No plan frontmatter declares requirements for 76-01-PLAN.md. REQUIREMENTS.md line 138 still reads 'Not started' while the code is delivered."
  - id: HANDOFF-TIP-OUTSIDE-TURN
    truth: "Chain-tip reads for a session run inside that session's turn, so no append interleaves with them."
    status: "OPEN (info). handoff() reads lastHash at service.ts:7646 outside withSessionTurn; its emit at service.ts:7677 takes the turn later. A concurrent emit for the same session can land between the two, so the packet's prev_event_hash can differ from the stored event's prev. [INFERENCE from code read; not exercised.]"
  - id: R-3-UNSETTLED-AT-EXIT
    truth: "An entry given up by abandonAll() while its delivery is in flight is recorded once that delivery settles."
    status: "Residual (info). If the process exits before the in-flight delivery settles and the buffer's file was not saved, that entry gets no record in this process. A durable file keeps it as live for the next boot. [INFERENCE; not exercised.]"
human_verification:
  - test: "Operator item 1. Live GreptimeDB rehearsal of the accepted outage limit: block the ledger and emit for one session; restore. Cover (a) a session whose tip is cached, first write fails; (b) that session's next write while the outage lasts; (c) a write for a session with no cached tip; (d) the same run with SUBSTRATE_LEDGER_CHAIN_CACHE=0, sessioned writes, including a write whose tip read succeeds and whose insert fails; (e) a sessionless write during the outage in a process that confirmed append-mode before the outage; (f) a sessionless write in a process whose first ledger contact is during the outage."
    expected: "(a) answers 503 with buffered true and stored false; /healthz eventBuffer.depth rises. (b) and (c) answer stored false with buffered absent, refused at the tip read (service.ts:3121-3131). (d) a sessioned write whose tip read fails is refused; one whose tip read succeeds and whose insert fails is buffered when append mode is confirmed; without that confirmation and without SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER=1|true|yes it is refused as APPEND_MODE_UNKNOWN before the insert. (e) is buffered. (f) is refused as APPEND_MODE_UNKNOWN unless the allow flag is set. After restore each buffered event lands once."
    why_human: "Needs a live GreptimeDB and a real outage. The sessionless and write-only clauses are code reads and fake-based tests, not live proofs."
  - test: "Operator item 2. Dead-letter exhaustion on a live outage (nominal budget 243 s; 195 to 292 s with jitter)."
    expected: "A dead-letter line is written with its hash (event-dead-letter.ts record(), hash from event.hash) and the file mode is 0600. Boot refusal without SUBSTRATE_EVENT_DEAD_LETTER_PATH is covered by config.ts:2607-2612 and service-event-buffer.test.ts:229, not by this item."
    why_human: "Needs a live outage longer than the retry budget. Scratch probes wrote their own files, so 0600 on a service-written file was not exercised."
  - test: "Operator item 3. Restart during an outage with a durable file that may end in a torn line from a real crash."
    expected: "The next boot reports the depth, starts the drain timer, and drains each entry once. The torn line is counted as malformed and skipped. The next dead-letter write starts on a fresh line. No record is lost."
    why_human: "The tests inject a torn line; a real partial write on a real disk is not reproduced."
  - test: "Operator item 4 (R-3 residual). Shutdown under the service manager: index.ts:260 drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })."
    expected: "Finishes within the unit's stop bound with a durable buffer. The bounds stack (retain pass, event pass, transitions, flush) can exceed infra/vps/substrate-host.service TimeoutStopSec=15, so a SIGKILL mid-pass is possible; confirm that a durable buffer survives it. A non-durable buffer's in-flight entry is recorded only if its delivery settles before exit (see R-3-UNSETTLED-AT-EXIT)."
    why_human: "Needs the real service manager and a durable buffer file under a stop."
  - test: "Operator item 5 (D76-14, D76-19). Buffered session.end on a live steering session."
    expected: "The session closes first (service.ts:2263 liveSessions.close, :2265 steeringWaiters.closeSession, then the emit at :2266), so steering is closed whether or not the note lands. The code does not keep the session open until the note lands, as PLAN D76-14 and D76-19 say; docs/greptime-ledger.md describes the code."
    why_human: "Needs a live steering session and the owner's ratification of the behaviour."
  - test: "Operator item 6 (R-1). Keyed replay after a dead-letter record on a live collector spool."
    expected: "Confirm which trigger occurs: one new row with a new id (the dead-letter record is orphaned, the common case), or two rows. The replay of a pending give-up is code-verified (service.ts:3096-3112; service-event-buffer.test.ts:334, passing); the live replay after the record has left the buffer is not."
    why_human: "Needs a live collector spool and ledger."
  - test: "Operator item 7 (D76-15). Operator decision to enable the buffer."
    expected: "SC1 holds with SUBSTRATE_EVENT_BUFFER_PATH and SUBSTRATE_EVENT_DEAD_LETTER_PATH set (config.ts:2605-2619 refuses boot when only the buffer path is set). With the buffer unset, a failed write answers stored false and nothing is queued (config.ts:2606 returns null)."
    why_human: "Configuration and policy decision, not code-verifiable."
  - test: "Operator item 8. /healthz staleness."
    expected: "The body is memoised for SUBSTRATE_HEALTHZ_CACHE_MS (default 5000, config.ts:1217; memo in server.ts). Pollers see a depth change within that window."
    why_human: "Needs a running server and a poller."
  - test: "Owner ratification (W-L2-TIP-ORDER, handoff). Commit a9e477e2 moved handoff()'s text refusal and graph-id check before placeOf and lastHash, as the recorded W-L2 rule requires. The owner confirms this as the decided behaviour and records it."
    expected: "The owner records the ratification in ROADMAP.md or the phase record. If the owner wants a different rule, the handoff path is the only one affected."
    why_human: "An owner decision on write ordering; no verifier can supply it."
  - test: "Owner ratification of the doc precision points in docs/greptime-ledger.md. (1) The replay-effect sentence ('a keyed replay answered from the ledger ... appends no event') is accurate for agent_events only; the event_ingest repair write is not named. (2) The cache-off sentence 'every session write reads the tip first' does not name a sessioned write refused for a lone surrogate, which is refused before the read."
    expected: "The owner confirms or amends both sentences and records the decision."
    why_human: "A ratification is an owner decision; no verifier can supply it."
  - test: "Owner decision on HARD-R3. No plan claims it. REQUIREMENTS.md still reads 'Not started'."
    expected: "The owner either maps HARD-R3 to 76-01 and updates its status, or records why it stays orphaned."
    why_human: "Traceability is an owner decision."
---

# Phase 76: Telemetry buffer and dead-letter Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently. (ROADMAP.md, Phase 76)

**Verified:** 2026-11-04T23:05:04Z
**Status:** human_needed
**Re-verification:** No: initial mode (the prior record has no `gaps:` section). Prior frontmatter is carried for continuity.
**Worktree / HEAD:** `/root/src/worktrees/as-gsd-v18-all` (branch gsd/v18-int-all) at 9e71f263. Prior record at 504da465 (verified 2026-11-04T22:36:18Z). Sibling phases' VERIFICATION files in the worktree are modified by other workers and were not touched.

## Goal Achievement

### Observable Truths

| #   | Truth   | Status     | Evidence       |
| --- | ------- | ---------- | -------------- |
| 1   | SC1: A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash. | ✓ VERIFIED (within the owner-accepted pre-send scope, D76-10; with the buffer enabled, D76-15) | Write failure → `appendChained` catch → `bufferEvent` (service.ts:3189). Bound: `EventBuffer.enqueue` evicts or refuses past `max` (event-buffer.ts:~229-263). Backoff: base×2^n capped, ±20 % jitter (event-buffer.ts:40-44). Ceiling: `runDrain` dead-letters with `exhausted` at `attempts >= maxAttempts`. Record: `DeadLetterStore.record` writes `event_hash` (event-dead-letter.ts record()). Retries use `insertEvent(entry.event, { mayExist: true })` (service.ts:3216; greptime.ts:1248-1270), so an ambiguous write is not stored twice. Behavioural tests pass at 504da465 (see Behavioral Spot-Checks). |
| 2   | SC2: Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag. | ✓ PASSED (override), not verified | `health().eventBuffer` is `{ enabled: false }` when off, else `{ enabled: true, ...stats, deadLetter: { depth, durable } }` (service.ts:8940). `server.ts` spreads `health` into the `/healthz` body (server.ts:1002). Buffer bound by `SUBSTRATE_EVENT_BUFFER_MAX` (config.ts:2623, default 256). Dead-letter store is not bounded (D76-13). The health body test and the overflow test pass. The literal SC2 is not met for the dead-letter half. Override carried forward, owner-accepted 2026-11-02. This verifier did not re-accept it. |

**Score:** 2/2 truths counted (1 VERIFIED, 1 PASSED by override). behavior_unverified: 0. Warnings above do not change the score.

### Changed Since Prior Record (504da465 to 9e71f263)

Only one covered file changed in this range: `service.test.ts`, commit 94f4bc8e. The change sits in the phase 78 scheduled-reconcile `describe` block (from line 6384 on): the clean-tick fixture moved to a helper with its assertions unchanged, and one new test checks that overlapping scheduled ticks share one run. No phase 76 test or source line changed. The other commits in the range (fabric, corpus proofs, the corpus-sync runbook, the reconcile drop-in comment) are not covered files.

| Commit | Change | Verdict |
| ------ | ------ | ------- |
| 94f4bc8e | `service.test.ts`: reconcile-tick fixture moved to a helper (lines 6384 to 6470); one new test. No phase 76 hunk. | Phase 76 tests and their cited lines (for example service.test.ts:1669) sit above the changed block and are unchanged. Re-ran: 354 pass (service.test.ts and handoff.test.ts). |
| a0572cf7, a9e477e2, the 73-phase commits (carried from the 504da465 record) | Not in this range. `git diff 504da465..9e71f263` is empty for every other covered file. | Verdicts from the 504da465 record stand. |

### W-L2 Write-Path Ordering (re-checked at 9e71f263; service.ts unchanged since 504da465)

Question: does the surrogate refusal of the six write text fields, and the graph id check, happen before any chain-tip read, buffer or insert on a sessioned write?

| Write shape | Refusal reached at | Tip read before refusal? | Verdict |
| ----------- | ------------------ | ------------------------ | ------- |
| Keyed, replay lookup, via `emit` | service.ts:3093 (`assertWriteTextFields`), 3095 (`normalizeGraphId`), before `replayOutcome` | No | ✓ refused before lookup, tip, buffer, insert |
| Sessioned, via `emit` / `appendChained`, keyed or unkeyed | service.ts:3093, 3095, before `lastHash` at 3121 | No | ✓ CONFIRMED (named tests, passing) |
| Sessionless, keyed or unkeyed | service.ts:3093 | No tip read exists | ✓ |
| Sessioned, via `handoff()`, then `emit` | service.ts:7628 and the `assertWriteTextFields` call at 7629-7637, before `placeOf` (7637) and `lastHash` (7646) | No | ✓ CONFIRMED (test "refuses a lone surrogate in the handoff summary before it reads the chain tip", service.test.ts:1669, passing) |

Coverage note (info): `handoff()` runs its refusal on the probe built from the caller's input. A `repo` that the place lookup fills in (`place.repo`, service.ts:7637) is not in the probe. That value comes from a graph row written under the same rules, so it cannot hold a lone surrogate. [INFERENCE]

Result: the W-L2 rule is confirmed for every sessioned write path at 504da465. The W-L2-TIP-ORDER warning is closed in code. Ratification is a human item.

### Doc Wording Check (docs/greptime-ledger.md)

| Point | Doc says | Code | Verdict |
| ----- | -------- | ---- | ------- |
| Flag values, sessioned clause | `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` set to `1`, `true` or `yes`; `SUBSTRATE_LEDGER_CHAIN_CACHE=0` turns the cache off | config.ts accepts `1\|true\|yes`; cache off for `0\|false\|no`. Gate at service.ts:3135-3140. | **Confirmed**, unchanged. |
| Replay appends no event | "a keyed replay answered from the ledger before the tip read appends no event" | Replay lookup at service.ts:3100, before the tip read. An ingest-membership repair write can still happen. | **Accurate for `agent_events` only.** Open (human item 10). |
| Cache-off, sessionless and uncached-session clauses | A session with no cached tip during an outage is refused at the tip read; a sessionless write reads no tip | `chainTips` null when the switch is off. `lastHash` only when `sessionId` is set. | **Confirmed by code read**, unchanged. Live outage not exercised (operator item 1). |
| Cache-off, "every session write reads the tip first" | As above | A sessioned write with a lone surrogate is refused before the read. | **Precision point for the owner** (human item 10). Not an edit. |

Doc changes since 4b84e50c are the phase 73 identifier and straddled-row sections and the query-key paragraph. None touches the phase 76 cache-off paragraph or the replay paragraph.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-buffer.ts` | Bounded per-session FIFO, backoff, drop causes, in-flight protection, file persistence | ✓ VERIFIED | Changed at a0572cf7 (follow-up pass, abandon in-flight). Wired from service.ts (`EventBuffer` at 2098). Tests pass. |
| `packages/mcp-server/src/event-dead-letter.ts` | Append-only JSONL dead-letter store with hash, reason, depth, durability | ✓ VERIFIED | Unchanged since 4b84e50c. Wired from service.ts:2097. 0600 on create. |
| `packages/mcp-server/src/service.ts` | Turn helper, buffering, drain, health, shutdown | ✓ VERIFIED | `appendChained` 3091, `bufferEvent` 3189, `deliverBuffered` 3208, `drainPendingEvents` 3252, `ensureEventDrainTimer` 3262, `eventBuffer` in health 8940. |
| `packages/mcp-server/src/greptime.ts` | `insertEvent(event, { mayExist })` | ✓ VERIFIED | greptime.ts:1248-1270. Default path unchanged. Tests in greptime.test.ts pass. |
| `packages/mcp-server/src/config.ts` | Six flags, boot refusal when the dead-letter path is missing | ✓ VERIFIED | config.ts:2600-2627. |
| `packages/mcp-server/src/index.ts` | Shutdown calls `drainPendingEvents` | ✓ VERIFIED | index.ts:260. |
| `packages/mcp-server/src/server.ts` | `/healthz` spreads `health()` | ✓ VERIFIED | server.ts:995-1002. |
| `packages/mcp-server/src/flag-registry.ts`, `.env.example`, `docs/config-reference.md` | Six flags documented | ✓ VERIFIED (by read) | flag-registry.ts:358-363; .env.example:38-46. The config:reference check was not run here. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `appendChained` catch | `EventBuffer.enqueue` | `bufferEvent` | ✓ WIRED | service.ts:3189-3202 and the catch at ~3178-3185 |
| `drainEventBuffer` | `deliverBufferedInTurn` | `EventBuffer.drain` | ✓ WIRED | service.ts:3240-3246 |
| `deliverBuffered` | `insertEvent(…, { mayExist: true })` | direct call | ✓ WIRED | service.ts:3218; greptime.ts:1262 |
| `drainPendingEvents` | `abandonAll` | `options.abandon && !durable` | ✓ WIRED | service.ts:3252-3257; index.ts:260 |
| `onDeadLetter` | `DeadLetterStore.record` | constructor closure | ✓ WIRED | service.ts:2105-2108 |
| `health()` | `/healthz` body | spread | ✓ WIRED | service.ts:8940; server.ts:1002 |

### Data-Flow Trace (Level 4)

Not applicable to a UI. The buffered event's data path is the real `insertEvent` row write and the dead-letter file record, both traced in the artifact table. No static fallback was found.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Buffer, dead-letter, drain, persistence, Greptime `mayExist`, service-level buffering, event emit | `cd packages/mcp-server && env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 <event-buffer.test.ts> <event-dead-letter.test.ts> <service-event-buffer.test.ts> <greptime.test.ts> <event.test.ts>` | 323 pass, 0 fail, 1168 expect() calls, 5 files (run at 9e71f263) | ✓ PASS |
| `appendChained` and `handoff()` tip-order refusals, emit tests, handoff tests, changed reconcile tests in service.test.ts | `… bun test --timeout 30000 <service.test.ts> <handoff.test.ts>` | 354 pass, 0 fail, 1367 expect() calls, 2 files (run at 9e71f263) | ✓ PASS |
| R-2 (`all` during a pass) | named test "a drain with all during a running pass still delivers the entries that pass skipped as not yet due" | passed in the run above | ✓ PASS |
| R-3 (abandon during delivery) | named tests "abandoning the buffer during a delivery keeps the in-flight entry pending until that delivery fails" and "an in-flight entry that lands after the buffer was abandoned is not recorded as abandoned" | passed in the run above | ✓ PASS |
| Handoff surrogate refused before tip read | "refuses a lone surrogate in the handoff summary before it reads the chain tip" | passed in the run above | ✓ PASS |
| Not run here | `flag-registry.test.ts`, `config-reference.test.ts`, `config:reference --check`, tsc, lint, the full suite | not run, by assignment or outside the two targeted runs | ? SKIP (routed to the orchestrator gate) |

Postgres evidence: none. No covered test file gates on SUBSTRATE_TEST_PG_URL (checked at 9e71f263 in the six covered test files), and the phase 76 tests use fake ledgers and temp files. No scratch Postgres run was made for this phase, so database substrate_test_v76 was not used. PG counts per file: none.

### Probe Execution

No conventional probes exist (`find scripts -path '*/tests/probe-*.sh'` returns none), and no PLAN declares one. Step 7c does not apply.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R3 | none | Bounded queue, backoff with jitter, durable dead-letter with payload and error, per-record dedupe, depth metrics, chain ordering, truthful acks | ORPHANED | REQUIREMENTS.md line 120 is unchecked and line 138 reads "Not started". 76-01-PLAN.md declares no `requirements:`. The delivered code covers most of the description: bounded buffer, backoff, dead-letter with the payload, `mayExist` dedupe, depths in /healthz, chain ordering through the per-session FIFO, and truthful `stored: false` replies. The dead-letter bound is not covered (override). |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| all phase 76 source, test and doc files | — | TBD / FIXME / XXX / TODO / HACK / PLACEHOLDER | none | Debt-marker scan over the files and over the lines added since 4b84e50c: 0 matches. |

### Human Verification Required

See the `human_verification` frontmatter: operator items 1 to 8 (live GreptimeDB outage, dead-letter exhaustion, torn-line restart, shutdown under the service manager, live steering session, live replay, the enablement decision, /healthz staleness), plus owner items for the handoff reorder ratification, the D76-14/19 ratification, the two doc sentences, and HARD-R3 traceability.

### Gaps Summary

No blocking gap. Both roadmap truths are satisfied: SC1 within the owner-accepted pre-send scope, SC2 by owner override. The status is `human_needed` because the live items and the owner decisions above are open.

Open items that remain (from the prior record, updated):
- Operator items 1 to 8 (live).
- D76-15: operator decision to enable the buffer.
- D76-14 and D76-19: a buffered `session.end` closes steering before its note lands; PLAN says it should stay open. Owner ratification open.
- R-1: live keyed replay after a dead-letter record. Code path tested, live not.
- R-2 and R-3: closed in code (a0572cf7). Shutdown behaviour under the service manager is still operator item 4. R-3 residual above.
- Dead-letter cap: a tracked follow-up under the override. SC2's literal dead-letter bound is not met.
- HARD-R3: orphaned in REQUIREMENTS.md; status line stale.
- Handoff tip read outside the session turn (info): service.ts:7646 vs the turn at 3020/3240. Not exercised.
- Doc precision points (human item 10).

Deferred items (Step 9b): none taken. The dead-letter bound is an owner override, not a deferral to a later phase.

---

_Verified: 2026-11-04T23:05:04Z_
_Verifier: Claude (gsd-verifier)_
