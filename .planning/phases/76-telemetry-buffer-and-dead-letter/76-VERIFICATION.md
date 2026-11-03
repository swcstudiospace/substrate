---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-03T16:04:02Z
status: human_needed
score: "2/2 must-haves verified (SC1 VERIFIED within the owner-accepted pre-send scope, PLAN D76-10, with the buffer enabled per D76-15; SC2 PASSED by owner override, not verified). Warning: W-L2-TIP-ORDER stays open for handoff(), which reads the chain tip before the surrogate refusal. The appendChained path is confirmed."
covered_files: ["packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-buffer.test.ts", "packages/mcp-server/src/event-buffer.ts", "packages/mcp-server/src/event-dead-letter.test.ts", "packages/mcp-server/src/event-dead-letter.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/handoff.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/reanchor-run.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "docs/greptime-ledger.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-PLAN.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-SUMMARY.md"]
covered_digest: "v3:sha256:ff835237bfc1df25b252ce220b9cc606a82acbe41882e57a878cdedd96866889"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag."
    reason: "Owner accepted the override on 2026-11-02. The dead-letter store is deliberately unbounded (plan decision D76-13): a bound would have to drop records, the silent loss this phase removes. The buffer is bounded by SUBSTRATE_EVENT_BUFFER_MAX, and the depth of both stores is reported in /healthz. A dead-letter cap is a tracked follow-up."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: "2/2 (8a604455 record, carried from the prior pass)"
  mode: "initial mode: the prior record has no gaps: section; re-checked at 4b84e50c. 4b84e50c does not touch any phase 76 file except service.ts lines outside the phase 76 path (see Changed Since Prior Record)"
  gaps_closed: []
  gaps_remaining: []
  regressions: []
warnings:
  - id: W-L2-TIP-ORDER
    truth: "The W-L2 surrogate refusal (summary, session_id, repo, branch, node_id, linear_identifier) happens before any chain-tip read, buffer or insert on a sessioned write."
    status: "CONFIRMED for the appendChained path (emit and every sessioned emit). NOT CONFIRMED for handoff(), which reads the chain tip before the refusal it then receives from emit. Still open at 4b84e50c."
    evidence: "appendChained: assertWriteTextFields(input) at service.ts:3093 is the first statement; keyed replay lookup 3100, buffer check 3104-3111, tip read lastHash at 3119, build 3126, append-mode probe 3135, buffer 3146-3154, insert 3157 all follow it. handoff(): lastHash at service.ts:7620 (inside the try at 7618-7624) runs before emit at 7651, and emit's append reaches the refusal. handoff.ts settle()/line() keep a lone surrogate, so the refusal does fire, after the read [INFERENCE from code read; not executed]."
    decision: "Owner decision. Options: move the handoff tip read after assertWriteTextFields (or call it at the top of handoff()), and add a handoff test that a handoff with a lone surrogate calls no lastHash. No code was changed by this pass."
human_verification:
  - test: "Operator item 1. Live GreptimeDB rehearsal of the accepted outage limit: block the ledger and emit for one session; restore. Cover (a) a session whose tip is cached, first write fails; (b) that session's next write while the outage lasts; (c) a write for a session with no cached tip; (d) the same run with SUBSTRATE_LEDGER_CHAIN_CACHE=0, sessioned writes, including a write whose tip read succeeds and whose insert fails; (e) a sessionless write during the outage in a process that confirmed append-mode before the outage; (f) a sessionless write in a process whose first ledger contact is during the outage. Also run (d) in a process that has not confirmed append mode, with the tip read answering and the append-mode probe failing."
    expected: "(a) answers 503 with buffered true and stored false; /healthz eventBuffer.depth rises. (b) and (c) answer stored false with buffered absent, refused at the tip read (service.ts:3128-3131). (d) a sessioned write whose tip read fails is refused; a sessioned write whose tip read succeeds and whose insert fails is buffered (service.ts:3157-3179) when append mode is confirmed in the process; without that confirmation and without SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER set to 1, true or yes it is refused as APPEND_MODE_UNKNOWN before the insert (service.ts:3135-3140). (e) is buffered (no tip read; the cache switch does not apply). (f) is refused as APPEND_MODE_UNKNOWN (service.ts:3137-3140) unless the allow flag is 1, true or yes. After restore each buffered event lands once, in session order."
    why_human: "Needs a live GreptimeDB and a real outage. The cache-off sentence's sessionless and write-only clauses are code reads and fake-based tests, not live proofs."
  - test: "Operator item 2. Dead-letter exhaustion on a live outage (nominal budget 243 s; 195 to 292 s with jitter)."
    expected: "A dead-letter line is written with its hash (event-dead-letter.ts:102-122, hash at :108, stderr 'dead-lettered' at :119) and the file mode is 0600 (event-dead-letter.ts:149-150). Boot refusal without SUBSTRATE_EVENT_DEAD_LETTER_PATH is covered by config.ts:2604-2618 and service-event-buffer.test.ts:229, not by this item."
    why_human: "Needs a live outage longer than the retry budget. The scratch probes wrote their own files, so 0600 on a service-written file was not exercised."
  - test: "Operator item 3. Restart during an outage with a durable file that may end in a torn line from a real crash (ENOSPC, kill mid-write)."
    expected: "The next boot reports the depth and starts the drain timer (service.ts:2112; ensureEventDrainTimer at service.ts:3258) and drains each entry once. The torn line is counted as malformed at boot and skipped. The next dead-letter write starts on a fresh line (event-dead-letter.ts:148). Boot does not repair the torn line. Confirm no record is lost."
    why_human: "The G1 test injects a torn line; a real partial write on a real disk is not reproduced."
  - test: "Operator item 4 (R-2, R-3). Shutdown under the service manager: index.ts:258 drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true }) after the retain pass at index.ts:255."
    expected: "Finishes within the unit's stop bound with a durable buffer. R-2: drain (event-buffer.ts:287-293) returns an in-flight pass and drops options.all, so shutdown can join a periodic pass and skip entries not yet due. R-3: abandonAll (event-buffer.ts:299-305, called at service.ts:3255) clears the entry in flight; an in-flight entry that lands is recorded abandoned. The bounds stack: retain pass (10 s, index.ts:221), event pass (10 s), transitions (5 s, index.ts:223), flush (2 s, index.ts:219). infra/vps/substrate-host.service:59 sets TimeoutStopSec=15 in the repository unit; the stack can exceed it, so a SIGKILL mid-pass is possible. A buffer that is not durable abandons its entries as warnings, not blockers."
    why_human: "Needs the real service manager and a durable buffer file under a stop. R-2 and R-3 were re-read at 4b84e50c and are still present in code; neither is exercised."
  - test: "Operator item 5 (D76-14, D76-19). Buffered session.end on a live steering session."
    expected: "The session is closed first (service.ts:2263 liveSessions.close, service.ts:2265 steeringWaiters.closeSession, then the emit at 2266), so steering is closed whether or not the note lands. event_stored is false while the note is buffered and the wake-up hint is withheld (publishHint runs only on a stored event, service.ts:2961; a buffered event publishes only on landing, service.ts:3223). docs/greptime-ledger.md residuals paragraph describes this. PLAN D76-14 and D76-19 say the session stays open until the note lands; the code does not do that, and the doc matches the code. Owner ratification is still open."
    why_human: "Needs a live steering session and the owner's ratification of the behaviour."
  - test: "Operator item 6 (R-1). Keyed replay after a dead-letter record on a live collector spool."
    expected: "Confirm which trigger occurs: Trigger A (one new row with a new id; the dead-letter record is orphaned, the common case) or Trigger B (two rows). The replay of a pending give-up is code-verified (service.ts:3109-3110, event-buffer.ts:195-197, deadLettered true, nothing appended; service-event-buffer.test.ts:334, which passed at 4b84e50c); the live replay after the record has left the buffer is not."
    why_human: "Needs a live collector spool and ledger."
  - test: "Operator item 7 (D76-15). Operator decision to enable the buffer."
    expected: "SC1 holds with SUBSTRATE_EVENT_BUFFER_PATH and SUBSTRATE_EVENT_DEAD_LETTER_PATH set (config.ts:2608-2613 refuses boot when only the buffer path is set). With the buffer unset, a failed write answers stored false and nothing is queued (config.ts:2606 returns null). The operator must make and record this decision."
    why_human: "Configuration and policy decision, not code-verifiable."
  - test: "Operator item 8. /healthz staleness."
    expected: "The body is memoised for SUBSTRATE_HEALTHZ_CACHE_MS (default 5000, config.ts:1217; memo at server.ts:985-991). Pollers see a depth change within that window. Line references re-checked at 4b84e50c and match."
    why_human: "Needs a running server and a poller."
  - test: "Owner decision (W-L2-TIP-ORDER, handoff). Decide whether handoff() must refuse a lone surrogate before its chain-tip read (service.ts:7618-7624), and whether to add a handoff test that such a handoff calls no lastHash."
    expected: "The owner records the decision. If the read is to move, the test asserts lastHash is not called and no event is stored for a handoff whose goal, from.session_id, repo, branch, node_id or linear_identifier holds a lone surrogate."
    why_human: "An owner decision on write ordering; no verifier can supply it."
  - test: "Owner ratification of the doc precision points in docs/greptime-ledger.md (see Doc Wording Check). The cache-off paragraph (line 979) is ratified and unchanged since 046fbe05. Two points remain for the owner: (1) the replay-effect sentence, including whether the unqualified word 'event' is accepted, has no ratification recorded; (2) the cache-off sentence 'every session write reads the tip first' does not name a sessioned write refused for a lone surrogate, which is now refused before the read. The cache-off ratification is not reopened by this pass."
    expected: "The owner confirms or amends the replay-effect sentence and records the decision; the owner decides whether point (2) needs a sentence. Both are recorded."
    why_human: "A ratification is an owner decision; no verifier can supply it."
---

# Phase 76: Telemetry buffer and dead-letter Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently. (ROADMAP.md, Phase 76)

**Verified:** 2026-11-03T16:04:02Z
**Status:** human_needed
**Re-verification:** No: initial mode (the prior record has no `gaps:` section). Prior frontmatter is carried for continuity.
**Worktree / HEAD:** `/root/src/worktrees/as-gsd-v18-all` (branch gsd/v18-int-all) at 4b84e50c. Prior record at 8a604455. The worktree's `packages/` tree was clean at the start of this pass.

## Goal Achievement

### Observable Truths

| #   | Truth   | Status     | Evidence       |
| --- | ------- | ---------- | -------------- |
| 1   | SC1: A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash. | ✓ VERIFIED (within the owner-accepted pre-send scope, D76-10; with the buffer enabled, D76-15) | Write failure → `appendChained` catch → `bufferEvent` (service.ts:3171-3179, 3187). Bound: `EventBuffer.enqueue` evicts or refuses past `max` (event-buffer.ts:229-263). Backoff: base×2^n capped, ±20 % jitter (event-buffer.ts:40-44). Ceiling: `runDrain` dead-letters with `exhausted` at `attempts >= maxAttempts` (event-buffer.ts:335-337). Record: `DeadLetterStore.record` writes `event_hash` (event-dead-letter.ts:102-120). Retries use `insertEvent(entry.event, { mayExist: true })` (service.ts:3216; greptime.ts:1248, 1262). Behavioural evidence this pass: all 17 tests in `service-event-buffer.test.ts` pass at 4b84e50c (see Behavioral Spot-Checks). 4b84e50c does not touch this path. |
| 2   | SC2: Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag. | ✓ PASSED (override), not verified | `health().eventBuffer` is `{ enabled: false }` when off, else `{ enabled: true, ...stats, deadLetter: { depth, durable } }` (service.ts:8914). Buffer bound by `SUBSTRATE_EVENT_BUFFER_MAX` (config.ts:2623, default 256). Dead-letter store is not bounded (D76-13). The health body test ("the health body reports ...") and the overflow test pass at 4b84e50c. The literal SC2 is not met for the dead-letter half. Override carried forward, owner-accepted 2026-11-02. This verifier did not re-accept it. |

**Score:** 2/2 truths counted (1 VERIFIED, 1 PASSED by override). behavior_unverified: 0. One WARNING (W-L2-TIP-ORDER, below) does not change the score.

### W-L2 Write-Path Ordering (re-checked at 4b84e50c)

Question: does the surrogate refusal of the six write text fields happen before any chain-tip read, buffer or insert on a sessioned write?

Refusal site: `appendChained` calls `assertWriteTextFields(input)` as its first statement (service.ts:3093). That function refuses `summary`, `session_id`, `repo`, `branch`, `node_id` and `linear_identifier` with `FieldLoneSurrogateError` (event.ts:255-286). `normalizeEvent` also calls it (event.ts:392), so the refusal is still reached on the normalise path.

| Write shape | Refusal reached at | Tip read (`lastHash`) before refusal? | Verdict |
| ----------- | ------------------ | ------------------------------------- | ------- |
| Keyed, replay lookup on (`accept` with replay marker, or `enforce`), via `emit` | service.ts:3093, before `replayOutcome` at 3100 | No | ✓ refused before lookup, tip, buffer, insert |
| Keyed, buffer on, no lookup | service.ts:3093, before `findKeyed` 3106 | No | ✓ |
| Sessionless, keyed or unkeyed | service.ts:3093 | No tip read exists (sessionless) | ✓ |
| Sessioned, via `emit` / `appendChained`, unkeyed or keyed with buffer off | service.ts:3093, before `lastHash` 3119 | No | ✓ CONFIRMED (named test, re-run at 4b84e50c) |
| Sessioned, via `handoff()`, then `emit` | `handoff()` reads the tip at service.ts:7620 before its `emit` call at 7651; the refusal fires inside that `emit` | **Yes** | ✗ NOT CONFIRMED (W-L2-TIP-ORDER, still open) |

Details:

- **Named tests (appendChained).** `packages/mcp-server/src/service.test.ts`, `describe("emit")`, uses a counting ledger that records each `lastHash` call and each write. The two refusal tests (`refuses a lone surrogate in the summary before it reads the chain tip`, line 724; `refuses a lone surrogate in the session id before it reads the chain tip`, line 731) assert that `emit` rejects (`rejects.toThrow`, an `InvalidEventError`, not a `stored: false` answer) and that `tipReads` and `written` are empty. The control (`a clean sessioned write reads the chain tip once`, line 738) asserts one tip read for `sess-1`. All three pass at 4b84e50c.
- **Coverage gap (info).** The tip-order tests cover `summary` and `session_id` only. `repo`, `branch`, `node_id` and `linear_identifier` reach the same `assertWriteTextFields` call at the same line (service.ts:3093), but no test asserts their tip-order.
- **Pre-refusal wait (unchanged).** `append()` (service.ts:3010-3021) computes `normalizeKey(input.session_id)` (3014) and waits in `withSessionTurn` (3020) before `appendChained`. A refused sessioned write waits for the session's earlier turn, which can include a buffered delivery holding the Greptime write timeout. The refusal comes after that wait. Information only.
- **Handoff path (not confirmed).** `handoff()` (service.ts:7595) runs `placeOf` (7611), normalises `from.session_id` with `normalizeKey` (7612) and reads `lastHash` (7620) before any refusal. Its `emit` call is at 7651. `buildHandoff` and `settle()` in handoff.ts keep a lone surrogate (`redact` does not remove it), so the packet reaches `emit` with the lone surrogate and `emit` refuses in `appendChained`. The read is therefore before the refusal. The owner decision (warning W-L2) was "refuse before the sessioned tip read", and this path is a sessioned tip read. `handoff.test.ts` has no surrogate test. [INFERENCE from code read; not executed.]
- **Adjacent, unchanged (info).** `handoff()` reads its tip at service.ts:7620 outside `withSessionTurn`, which `emit` takes later at 3020. A concurrent emit for the same session can land between the handoff read and its own append, so the packet's `prev_event_hash` may differ from the stored event's `prev`. [INFERENCE; not exercised.]
- **Wire encoding.** The read key for `appendChained` is `normalizeKey`, and every `session_id` with a lone surrogate is refused before the read. For `handoff()` the read key is also `normalizeKey`, but a lone surrogate in the middle of `from.session_id` is kept and reaches the read [INFERENCE; not exercised].

Result: the requested claim **is confirmed for the appendChained path** (every sessioned emit, keyed or not, and the replay probe). It is **not confirmed for handoff()**. The warning stays open for handoff only.

### Doc Wording Check (docs/greptime-ledger.md)

| Point | Doc says | Code | Verdict |
| ----- | -------- | ---- | ------- |
| Flag values, sessioned clause | `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` set to `1`, `true` or `yes`; `SUBSTRATE_LEDGER_CHAIN_CACHE=0` turns the cache off | `config.ts:1194` accepts `1\|true\|yes` case-insensitively on the trimmed value; `config.ts:2439` turns the cache off for `0\|false\|no`. Gate at service.ts:3135-3140. config.ts unchanged since 046fbe05 (zero diff to 4b84e50c). | **Confirmed**, unchanged. |
| Replay appends no event | "a keyed replay answered from the ledger before the tip read appends no event" | Replay lookup at service.ts:3100, before the tip read at 3119. A hit returns before any `lastHash` call. A queued or given-up keyed replay returns at 3104-3110 with no write. A hit whose `event_ingest` membership is missing calls `recordIngest`, one ingest record. | **Accurate for `agent_events` only.** Unqualified "event" hides the `event_ingest` repair write. Open. |
| Cache-off, sessionless and uncached-session clauses | A session with no cached tip during an outage is refused at the tip read; a sessionless write reads no tip | `chainTips` is null when the switch is off (greptime.ts:798). `lastHash` is called only when `sessionId` is set (service.ts:3115). Tip-unreadable refusal at service.ts:3128-3131, no buffering. | **Confirmed by code read**, unchanged. Outage behaviour not exercised live (operator item 1). |
| Cache-off, "every session write reads the tip first" (docs/greptime-ledger.md:979) | As above | A sessioned `appendChained` write for a lone surrogate is refused before the read (service.ts:3093 before 3119). Such a write no longer reads the tip. The sentence is accurate for every write that reaches the chain check. It does not name refused writes. | **Precision point for the owner** (human item 10). Not an edit; the cache-off ratification is not reopened. |

Owner stamp: the paragraph at docs/greptime-ledger.md:979 is unchanged from 046fbe05 (no diff to 4b84e50c). `.planning/ROADMAP.md` line 1317 records "The cache-off wording is ratified (owner, 2026-11-03) and matches the code", and the progress row at line 1424 carries the same status. The replay-effect sentence has no recorded ratification and stays open.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-buffer.ts` | Bounded per-session FIFO, backoff, drop causes, file persistence | ✓ VERIFIED | Zero diff from 046fbe05 to 4b84e50c; wired from service.ts:231 |
| `packages/mcp-server/src/event-dead-letter.ts` | Append-only JSONL dead-letter store with hash, reason, depth, durability | ✓ VERIFIED | Zero diff from 046fbe05 to 4b84e50c; wired from service.ts:230; 0600 at :149-150 |
| `packages/mcp-server/src/service.ts` | Turn helper, buffering, drain, health, shutdown | ✓ VERIFIED | `appendChained` 3091, `bufferEvent` 3187, `deliverBuffered` 3206, `drainPendingEvents` 3250, `ensureEventDrainTimer` 3258, `eventBuffer` in health 8914. 4b84e50c changed lines 2501, 3647, 3735 and 4592 only; none is on the phase 76 path (see Changed Since Prior Record) |
| `packages/mcp-server/src/event.ts` | Write-time refusal (six fields) and key normalisation | ✓ VERIFIED | `FieldLoneSurrogateError` (255), `refuseLoneSurrogate` (267), `assertWriteTextFields` (277), `withoutDanglingHigh` (190), `normalizeIdentifier` (207), `normalizeKey` (216), `normalizeEvent` refusal call (392), `session_id` keyed with `normalizeKey` (401), `repo` keyed with `normalizeKey` (407). Unchanged by 4b84e50c |
| `packages/mcp-server/src/config.ts` | Six flags; boot refusal on missing dead-letter path or shared file | ✓ VERIFIED | Zero diff to 4b84e50c; `loadEventBufferSettings` (2604-2628), missing dead-letter refusal (2608-2613), shared-file refusal (2614-2619), `chainCache` at 2439, `healthzCacheMs` at 1217 |
| `packages/mcp-server/src/reanchor-run.ts` | Isolated config nulls buffer | ✓ VERIFIED | Zero diff to 4b84e50c; `eventBuffer: null` at :279 |
| `packages/mcp-server/src/index.ts` | Shutdown calls drain | ✓ VERIFIED | Zero diff to 4b84e50c; `drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })` at :258 after the retain pass at :255 |
| `packages/mcp-server/src/greptime.ts` | `insertEvent` with `mayExist`; tip cache | ✓ VERIFIED | Zero diff to 4b84e50c; `mayExist` at :1248 and :1262; `chainTips` null when off (:798) |
| `packages/mcp-server/src/server.ts` | `/healthz` spreads `substrate.health()`, memoised | ✓ VERIFIED | Zero diff to 4b84e50c; memo at :985-991 |
| Debt markers (TBD, FIXME, XXX, TODO, HACK, PLACEHOLDER) in phase files | none allowed unreferenced | ✓ none found | Re-scanned at 4b84e50c over all phase 76 source, test and doc files listed in the frontmatter: 0 matches |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| service.ts | event-buffer.ts / event-dead-letter.ts | imports, `DeadLetterStore`, `EventBuffer` | ✓ WIRED | service.ts:230-231; constructed at :2095-2111 |
| appendChained | assertWriteTextFields (W-L2 refusal) | first statement | ✓ WIRED, ordering ✓ | service.ts:3093; event.ts:277 |
| appendChained | bufferEvent | write failure path | ✓ WIRED | service.ts:3171-3179; queued-behind path at :3145-3154 |
| handoff | assertWriteTextFields (through emit) | refusal reached inside emit at 7651 | ✓ WIRED, ordering ✗ | tip read at 7620 precedes it; see W-L2 table |
| deliverBuffered | greptime.insertEvent | retry with `mayExist` | ✓ WIRED | service.ts:3216; greptime.ts:1248, 1262 |
| session.end close | steering close before buffered note | `closeSession` then emit | ✓ WIRED (as documented, D76-14 wording differs; see human item 5) | service.ts:2263, 2265, 2266 |
| index.ts | drainPendingEvents | shutdown | ✓ WIRED | index.ts:258 |
| server.ts `/healthz` | eventBuffer | spread of `substrate.health()` | ✓ WIRED | no server change needed |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `EventBuffer.entries` | buffered event | `build(...)` from the real event normalised on write | ✓ | ✓ FLOWING |
| `/healthz eventBuffer.depth` | `stats().depth` | live `entries` size and `DeadLetterStore.depth()` | ✓ | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| W-L2 refusal before the chain-tip read (summary and session_id), the clean sessioned control, and all 17 tests of the phase 76 buffer suite (buffered not dropped, waits behind, lost reply, exhausts budget, overflow cascade, keyed replay of queued event, restart re-reads, buffer unset, health body, no dead-letter path refuses boot, buffer off unless path set, breaker is not an attempt, keyed event queued behind a failed lookup, keyed replay waits for delivery, one file refused, breaker-refused live write keeps budget, keyed replay of pending give-up) | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test packages/mcp-server/src/service.test.ts packages/mcp-server/src/service-event-buffer.test.ts -t "<20 name fragments>" --timeout 30000` | 20 pass, 0 fail, 61 expect() calls, 318 filtered out (3 in service.test.ts, 17 in service-event-buffer.test.ts) | ✓ PASS |

One targeted run, as assigned. The stderr lines in the run (buffered, dead-lettered, `dead-letter store append failed (EEXIST)` in the blocker test) are the tests' own expected output, not failures.

Not run in this pass: `event-buffer.test.ts`, `event-dead-letter.test.ts`, `event.test.ts`, the `greptime.test.ts` `mayExist` block, `bun run config:reference -- --check`, `flag-registry.test.ts`, `config-reference.test.ts`, and `memory-policy.test.ts` (the 4b84e50c regression test, which is phase 72's). Their claims rest on the code read above and on the prior record, which this pass did not reproduce.

### Probe Execution

No `scripts/*/tests/probe-*.sh` is declared or implied by this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R3 | none (ORPHANED) | Bounded queue with backpressure; failed batches retry with exponential backoff and jitter, then retain payload and error in a durable dead-letter store. REQUIREMENTS.md:120 and the traceability row at :138 map it to Phase 76 with "Not started". | ✗ ORPHANED | `76-01-PLAN.md` has no frontmatter `requirements:` field, so no plan claims HARD-R3. Code evidence covers most of its text; "backpressure" is a refusal (`stored: false`) when the buffer is full and nothing can be given up; the dead-letter store is durable only with its path set. Unchanged by 4b84e50c. Requires orchestrator decision. |

### Anti-Patterns Found

- None blocking. The debt-marker scan over the phase 76 files returned nothing.
- ℹ️ Info: `refuseLoneSurrogate` checks the whole redacted field before the length cap (event.ts:267-270, called from `assertWriteTextFields`). A lone surrogate beyond a cap is refused even though the stored text would drop it. Matches the stated "before the length cap" rule.
- ℹ️ Info: the tip-order tests cover `summary` and `session_id` only (see the coverage gap above).
- ⚠️ Warning: W-L2-TIP-ORDER, open for handoff() (above).

### Human Verification Required

See the frontmatter `human_verification` list: operator items 1–8, the owner decision on handoff ordering (W-L2-TIP-ORDER, item 9), and the owner ratification of the doc's replay-effect sentence and the cache-off precision point (item 10). All are open. None is closed by this pass.

### Deferred Items

None.

### Advisory

None (not a re-verification).

### Gaps Summary

No truth FAILED. No artifact is missing or a stub. No key link is unwired. Status is `human_needed` because the open human items remain, and a WARNING is open. It is not `passed`.

Changed since the prior record (8a604455):

- **Commit 4b84e50c** (fix(72,73)) does not touch any phase 76 implementation file. `git diff 046fbe05 4b84e50c` shows the phase 76 buffer, dead-letter, greptime, config, index, server, handoff and docs files with zero diff; `event.ts` changed only in the earlier 8a604455 and 3e26a5c1 range. The 4b84e50c service.ts edits change one call each at lines 2501, 3647, 3735 and 4592 (`normalizeKey` → `normalizeIdentifier` on the caller's repo for recall, memory read and recall). None is on `appendChained`, `bufferEvent`, `deliverBuffered`, `drainPendingEvents`, `handoff`, `health` or the session-end path. Line numbers in service.ts are unchanged, because the edits are one-for-one.
- **Corrected reference:** the prior record cited the repo write key at event.ts:417. The repo key is at event.ts:407; session_id is at :401. The prior "34 sites" count for `normalizeKey` is superseded: after 4b84e50c, 33 non-test lines in `packages/mcp-server/src` name `normalizeKey` (including its import and definition lines). Access and visibility comparisons now use `normalizeIdentifier`; the write keys and session/turn keys keep `normalizeKey`.
- **W-L2-TIP-ORDER, appendChained: closed in code and in the record.** Confirmed at 4b84e50c with the named tests and the 20-test run.
- **W-L2-TIP-ORDER, handoff(): still open (WARNING).** `handoff()` reads the tip at service.ts:7620 before its `emit` refuses (7651). The owner decides whether to move the read and add a handoff test.
- **W-L2 write-time refusal of branch, node_id, linear_identifier: in code** since 8a604455 (`assertWriteTextFields`). Whether stored rows of that form need action is not in this pass's scope.
- **For the phase 72 and 73 records (info, not a phase 76 finding):** 4b84e50c leaves a deliberate split. A repo written to the ledger is keyed with `normalizeKey` (trimmed at a 512-unit straddle, event.ts:407), while a caller's repo for access is compared exactly with `normalizeIdentifier`. A straddling repo can therefore read as a different repo on the access side. The commit records this as an owner item (ledger rows written with scope off keep the trimmed repo; pre-existing straddling rows are open data items). [INFERENCE on the access consequence; not exercised here.]

Still open, not closed by this pass:

- **D76-15**: enabling the buffer is an operator decision (item 7).
- **D76-14 and D76-19**: a buffered `session.end` closes steering at once (the code, service.ts:2263-2265) while PLAN says it stays open until the note lands (item 5). The doc matches the code. Owner ratification is open.
- **R-1**: the live keyed replay after a dead-letter record (item 6). Code-verified path, passing test (service-event-buffer.test.ts:334); the live trigger is not.
- **R-2**: `drain()` returns an in-flight pass and drops `options.all` (event-buffer.ts:287-293). Still present at 4b84e50c; shutdown can skip entries not yet due (item 4).
- **R-3**: `abandonAll()` (event-buffer.ts:299-305, called at service.ts:3255) clears the in-flight entry. Still present at 4b84e50c. [INFERENCE, not exercised: a late failure of that in-flight entry after abandonment may reach `dropFrom` and write a second record. Item 4 covers the live check.]
- **Operator items 1–8**: live Greptime outage rehearsal, real exhaustion, torn-line restart, shutdown under the service manager, live steering session, live replay, the enablement decision, and `/healthz` staleness. Each needs a live system.
- **Doc precision points** (item 10): the cache-off paragraph is ratified and unchanged; its "every session write reads the tip first" sentence now has an unnamed exception (refused writes). The replay-effect sentence is accurate for `agent_events` only and its ratification is not recorded. Open.
- **HARD-R3**: orphaned in REQUIREMENTS.md against Phase 76; no plan claims it.
- **Dead-letter cap**: a tracked follow-up under the override. SC2's literal dead-letter bound is not met.
- **Handoff tip read outside the session turn** (info, not changed by 4b84e50c): service.ts:7620 vs the turn at 3020. Not exercised.

---

_Verified: 2026-11-03T16:04:02Z_
_Verifier: Claude (gsd-verifier)_
