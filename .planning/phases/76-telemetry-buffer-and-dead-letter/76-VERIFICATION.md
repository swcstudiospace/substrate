---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-05T07:59:10Z
status: human_needed
score: "2/2 must-haves verified (SC1 VERIFIED within the owner-accepted pre-send scope, PLAN D76-10, with the buffer enabled per D76-15; SC2 PASSED by owner override, not verified). No gap open in code. The R-3 shutdown residual and SYNC-LAG-BUFFERED-NOT-RECORDED, open at 42e3cf13, are closed in code at 49b9aece and b4bdd0fc. W-L2-TIP-ORDER for handoff() is closed in code at a9e477e2; its owner ratification is not recorded."
covered_files: [".env.example", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-PLAN.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-SUMMARY.md", "docs/config-reference.md", "docs/greptime-ledger.md", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-buffer.test.ts", "packages/mcp-server/src/event-buffer.ts", "packages/mcp-server/src/event-dead-letter.test.ts", "packages/mcp-server/src/event-dead-letter.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/handoff.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/reanchor-run.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:02633fdb70dbe2a997f78e06763565c7dfeeab88c37ada1cdf35b57e29d33398"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag."
    reason: "Owner accepted the override on 2026-11-02. The dead-letter store is deliberately unbounded (plan decision D76-13): a bound would have to drop records, the silent loss this phase removes. The buffer is bounded by SUBSTRATE_EVENT_BUFFER_MAX, and the depth of both stores is reported in /healthz. A dead-letter cap is a tracked follow-up."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: "2/2 (prior record 76-VERIFICATION.md at 42e3cf13, verified 2026-11-05T07:11:05Z)"
  mode: "re-verification at 6e5d766e (branch gsd/v18-int-all). Four covered files changed since 42e3cf13: event-buffer.ts, event-buffer.test.ts, service.ts, service-event-buffer.test.ts. Each was re-read against this phase's criteria. Changes are listed under Changed Since the 42e3cf13 Record."
  gaps_closed:
    - "R-3 residual: an in-flight entry given up at shutdown is recorded at once (49b9aece, event-buffer.ts abandonAll)"
    - "SYNC-LAG-BUFFERED-NOT-RECORDED: a docs.sync note the ledger did not take still sets the sync-lag reading (b4bdd0fc, service.ts emit)"
  gaps_remaining: []
  regressions: []
residuals_closed:
  - id: R-3-UNSETTLED-AT-EXIT
    truth: "An entry given up by abandonAll() while its delivery is in flight is recorded at the abandon, so an exit before that delivery settles keeps its record."
    status: "CLOSED at 49b9aece. abandonAll (event-buffer.ts:319-331) records every remaining entry at once, the in-flight one included; drain (event-buffer.ts:358) does not record it again when the delivery settles. Named tests, passing at 6e5d766e: 'abandoning the buffer during a delivery records the in-flight entry at once, so an exit before that delivery settles keeps it' (event-buffer.test.ts:245) and 'an in-flight entry that lands after the buffer was abandoned was recorded at the abandon, once' (event-buffer.test.ts:265). Both are in gate r33 JUnit with no skipped child. Duplicate on a late landing is at-least-once and detectable, per the owner decision in force."
  - id: SYNC-LAG-BUFFERED-NOT-RECORDED
    truth: "A stored docs.sync note updates the corpus sync-lag gauge (phase 70 SC3), and so does a docs.sync note the server took but did not store."
    status: "CLOSED at b4bdd0fc. The sync-lag hook (service.ts:3006) now runs on the stored, buffered and deadLettered branches of emit(). A buffered note sets the reading when it is held, and the drain does not change it. Named test 'a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back' (service-event-buffer.test.ts:115; asserts 4000 s while down and after the drain) passes; in gate r33 JUnit with no skipped child. The deadLettered branch has no test of its own; it is code-verified only (service.ts:3006, 3158 and 3242)."
warnings:
  - id: HARD-R3-ORPHANED
    truth: "REQUIREMENTS.md HARD-R3 maps to Phase 76."
    status: "ORPHANED. No plan frontmatter declares requirements for 76-01-PLAN.md. REQUIREMENTS.md line 138 still reads 'Not started' at 6e5d766e (checked; the docs commit 6e5d766e does not change HARD-R3). ROADMAP.md line 1424 lists R-3 as open; that row predates 49b9aece and is not edited by this record."
  - id: HANDOFF-TIP-OUTSIDE-TURN
    truth: "Chain-tip reads for a session run inside that session's turn, so no append interleaves with them."
    status: "OPEN (info). handoff() reads lastHash at service.ts:7694 outside withSessionTurn; its emit at service.ts:7725 reaches appendChained, which takes the turn at service.ts:3066. A concurrent emit for the same session can land between the two, so the packet's prev_event_hash can differ from the stored event's prev. [INFERENCE from code read; not exercised.] Line numbers re-anchored at 6e5d766e (+1 from 42e3cf13); code unchanged."
  - id: KEYED-REPLAY-RESTATES-SYNC-LAG
    truth: "A keyed replay does not change the corpus sync-lag gauge (phase 70 SC3)."
    status: "OPEN (info, new at 6e5d766e; not a phase 76 must-have). emit() passes the answered event's own payload to recordSyncLag (service.ts:3006), and corpus/slo.ts:69-72 keeps the last value written. A keyed replay answered from the ledger returns stored true (service.ts:3117-3118), so it already restated the replayed note's lag before b4bdd0fc. b4bdd0fc extends this to a replay answered as buffered (service.ts:3155) or as given up (service.ts:3158). If a different session's docs.sync note has stored in between, the gauge reverts to the replayed note's lag. [INFERENCE from code read; not exercised. Needs two docs.sync notes in different sessions; same-session notes queue behind each other.]"
  - id: ABANDON-RECORD-UNCHECKED
    truth: "A dead-letter record taken at abandonAll() reaches the dead-letter file before the process exits."
    status: "OPEN (info, pre-existing for entries other than the in-flight one; the in-flight one now follows it). abandonAll() (event-buffer.ts:328) ignores the boolean that onDeadLetter returns (service.ts:2117-2118 returns deadLetters.durable). If the dead-letter file cannot be written, the record is held in memory and the entry has already left the buffer, so an exit loses it. Dead-letter path is required at boot (config.ts:2607-2612), so this needs a failing write, not a missing config. [INFERENCE from code read; not exercised.]"
  - id: CORPUS-EVAL-DOC-SYNC-LAG-WORDING
    truth: "docs/corpus-eval.md describes when the sync-lag reading is set."
    status: "OPEN (info, outside this phase's covered list; reported, not edited). docs/corpus-eval.md:105 says the sync lag 'is set by each stored docs.sync note'. Since b4bdd0fc a note the server took but did not store (buffered or dead-lettered) also sets it. The orchestrator should route the wording fix to the owner of that doc."
human_verification:
  - test: "Operator item 1. Live GreptimeDB rehearsal of the accepted outage limit: block the ledger and emit for one session; restore. Cover (a) a session whose tip is cached, first write fails; (b) that session's next write while the outage lasts; (c) a write for a session with no cached tip; (d) the same run with SUBSTRATE_LEDGER_CHAIN_CACHE=0, sessioned writes, including a write whose tip read succeeds and whose insert fails; (e) a sessionless write during the outage in a process that confirmed append-mode before the outage; (f) a sessionless write in a process whose first ledger contact is during the outage."
    expected: "(a) answers 503 with buffered true and stored false; /healthz eventBuffer.depth rises. (b) and (c) answer stored false with buffered absent, refused at the tip read (service.ts:3167-3178). (d) a sessioned write whose tip read fails is refused; one whose tip read succeeds and whose insert fails is buffered when append mode is confirmed; without that confirmation and without SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER=1|true|yes it is refused as APPEND_MODE_UNKNOWN before the insert (gate at service.ts:3184-3186). (e) is buffered. (f) is refused as APPEND_MODE_UNKNOWN unless the allow flag is set. After restore each buffered event lands once."
    why_human: "Needs a live GreptimeDB and a real outage. The sessionless and write-only clauses are code reads and fake-based tests, not live proofs."
  - test: "Operator item 2. Dead-letter exhaustion on a live outage (nominal budget 243 s; 195 to 292 s with jitter)."
    expected: "A dead-letter line is written with its hash (event-dead-letter.ts record(), hash from event.hash) and the file mode is 0600. Boot refusal without SUBSTRATE_EVENT_DEAD_LETTER_PATH is covered by config.ts:2607-2612 and service-event-buffer.test.ts:245, not by this item."
    why_human: "Needs a live outage longer than the retry budget. Scratch probes wrote their own files, so 0600 on a service-written file was not exercised."
  - test: "Operator item 3. Restart during an outage with a durable file that may end in a torn line from a real crash."
    expected: "The next boot reports the depth, starts the drain timer, and drains each entry once. The torn line is counted as malformed and skipped. The next dead-letter write starts on a fresh line. No record is lost."
    why_human: "The tests inject a torn line; a real partial write on a real disk is not reproduced."
  - test: "Operator item 4 (R-3 residual). Shutdown under the service manager: index.ts:260 drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })."
    expected: "Finishes within the unit's stop bound with a durable buffer. The bounds stack (retain pass, event pass, transitions, flush) can exceed infra/vps/substrate-host.service TimeoutStopSec=15, so a SIGKILL mid-pass is possible; confirm that a durable buffer survives it. A non-durable buffer's in-flight entry is recorded only if its delivery settles before exit (see R-3-UNSETTLED-AT-EXIT)."
    why_human: "Needs the real service manager and a durable buffer file under a stop."
  - test: "Operator item 5 (D76-14, D76-19). Buffered session.end on a live steering session."
    expected: "The session closes first (service.ts:2273 liveSessions.close, :2275 steeringWaiters.closeSession, then the emit at :2276), so steering is closed whether or not the note lands. The code does not keep the session open until the note lands, as PLAN D76-14 and D76-19 say; docs/greptime-ledger.md describes the code."
    why_human: "Needs a live steering session and the owner's ratification of the behaviour."
  - test: "Operator item 6 (R-1). Keyed replay after a dead-letter record on a live collector spool."
    expected: "Confirm which trigger occurs: one new row with a new id (the dead-letter record is orphaned, the common case), or two rows. The replay of a pending give-up is code-verified (service.ts:3142-3158; service-event-buffer.test.ts:350, passing); the live replay after the record has left the buffer is not."
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

**Verified:** 2026-11-05T07:59:10Z
**Status:** human_needed
**Re-verification:** Yes. Prior record at 42e3cf13 (verified 2026-11-05T07:11:05Z). Since then, commits 49b9aece (R-3, event-buffer) and b4bdd0fc (SYNC-LAG, service.ts emit) changed covered files. Verdicts not touched by them are carried forward from the 42e3cf13 record.
**Worktree / HEAD:** `/root/src/worktrees/as-gsd-v18-all` (branch gsd/v18-int-all) at 6e5d766e. Covered files are at HEAD. The fingerprint is recomputed at HEAD (`gsd_run query verification.fingerprint`) and copied verbatim into the frontmatter.
**Line references:** Re-anchored at 6e5d766e. `event-buffer.ts`: lines after 330 are +3 from the 42e3cf13 numbers (49b9aece). `service.ts`: lines from 3006 on are +1 (b4bdd0fc added one line at 3005); the handoff, health and drain cites below are shifted accordingly. `service-event-buffer.test.ts`: lines after 115 are +16 (b4bdd0fc); cites are re-anchored (boot refusal now 245, keyed replay of a pending give-up now 350). `event-buffer.test.ts` lines after 240 are shifted by the 49b9aece rewrite; the R-3 tests are cited by name.

## Goal Achievement

### Observable Truths

| #   | Truth   | Status     | Evidence       |
| --- | ------- | ---------- | -------------- |
| 1   | SC1: A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash. | ✓ VERIFIED (within the owner-accepted pre-send scope, D76-10; with the buffer enabled, D76-15) | Write failure → `appendChained` catch → `bufferEvent` (call sites service.ts:3194 and 3227; definition 3235). Bound: `EventBuffer.enqueue` evicts or refuses past `max` (event-buffer.ts:~229-263). Backoff: base×2^n capped, ±20 % jitter (event-buffer.ts:40-44). Ceiling: `runDrain` dead-letters with `exhausted` at `attempts >= maxAttempts`. Record: `DeadLetterStore.record` writes `event_hash` (event-dead-letter.ts record()). Retries use `insertEvent(entry.event, { mayExist: true })` (service.ts:3264; greptime.ts:1262). Named passes in gate r33 JUnit: 'a failed write is buffered, not dropped, and lands once the ledger is back'; 'a write that exhausts its budget is dead-lettered with its hash and its reason'; 'overflow dead-letters the oldest buffered event and its session's later events, and never drops them silently'. |
| 2   | SC2: Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag. | ✓ PASSED (override), not verified | `health().eventBuffer` is `{ enabled: false }` when off, else `{ enabled: true, ...stats, deadLetter: { depth, durable } }` (service.ts:8988). `server.ts` spreads `health` into the `/healthz` body (server.ts:995-1002). Buffer bound by `SUBSTRATE_EVENT_BUFFER_MAX` (config.ts:2623, default 256). Dead-letter store is not bounded (D76-13). Named passes in gate r33 JUnit: 'the health body reports the buffer's depth and the dead-letter depth, each with its durability'; 'a buffer with no dead-letter path refuses boot, and the message names the missing variable'. The literal SC2 is not met for the dead-letter half. Override carried forward, owner-accepted 2026-11-02. This verifier did not re-accept it. |

**Score:** 2/2 truths counted (1 VERIFIED, 1 PASSED by override). behavior_unverified: 0. Warnings above do not change the score.

### Changed Since the 42e3cf13 Record (42e3cf13 to 6e5d766e)

`git diff --stat 42e3cf13..6e5d766e` over the covered list: four covered files changed (43 insertions, 20 deletions). Each diff was read in full.

| File | Change | Phase 76 effect |
| ---- | ------ | --------------- |
| `packages/mcp-server/src/event-buffer.ts` | `abandonAll()` (lines 313-331) now gives every remaining entry up with its record at once, the in-flight one included. The in-flight entry is no longer kept as pending. Numstat +11, -8. | R-3 residual closed (see `residuals_closed`). `drain` (lines 343-361) still does not record a delivery that settles after the abandon: an entry given up is not attempted, and a `landed` outcome deletes nothing that is still present. The overflow path (`enqueue`, ~229-263) and the pending/`settlePending` rules are unchanged, so SC1 and D76-13 are untouched. |
| `packages/mcp-server/src/event-buffer.test.ts` | Two R-3 tests replaced (lines 245 and 265). The earlier pending-rule assertions are gone. Numstat +14, -11. | Pins the new rule; both replaced tests pass (see Behavioral Spot-Checks). |
| `packages/mcp-server/src/service.ts` | One hunk at 3005-3006: the sync-lag hook now runs for stored, buffered and deadLettered results (b4bdd0fc). Numstat +2, -1. | SYNC-LAG residual closed (see `residuals_closed`). No other phase 76 path changed. The `noteDocsCanary` line (3004) is unchanged, so D76-14 stands as written. |
| `packages/mcp-server/src/service-event-buffer.test.ts` | One named test added at line 115 (+16 lines). | Pins the sync-lag rule for a buffered note. Shifts later cites in this file by +16. |

Other changes in the range are not covered by this phase and do not bear on it: `cache.ts`, `cache-breaker.test.ts`, `worktree.py`, `test_worktree.py`, `docs/corpus.md`, `docs/reconcile.md`, `REQUIREMENTS.md` (line 138 unchanged), `ROADMAP.md`, and the VERIFICATION records of phases 63 to 78 (76's own record is rewritten here). `docs/greptime-ledger.md`, `docs/config-reference.md`, `flag-registry.ts`, `config.ts`, `index.ts`, `server.ts`, `handoff.ts`, `greptime.ts`, `event.ts`, `event-dead-letter.ts` and the other covered test files are unchanged in the range.

Carried forward unchanged from the 42e3cf13 record: every verdict for a covered file or claim not named above. The line numbers in those verdicts are re-anchored where this run cites them.

### W-L2 Write-Path Ordering (re-checked at 6e5d766e)

Question: does the surrogate refusal of the six write text fields, and the graph id check, happen before any chain-tip read, buffer or insert on a sessioned write?

| Write shape | Refusal reached at | Tip read before refusal? | Verdict |
| ----------- | ------------------ | ------------------------ | ------- |
| Keyed, replay lookup, via `emit` | service.ts:3139 (`assertWriteTextFields`), 3141 (`normalizeGraphId`), before `replayOutcome` (call at 3148) | No | ✓ refused before lookup, tip, buffer, insert |
| Sessioned, via `emit` / `appendChained`, keyed or unkeyed | service.ts:3139, 3141, before `lastHash` at 3167 | No | ✓ CONFIRMED (named tests passing in gate r33; code unchanged in this range) |
| Sessionless, keyed or unkeyed | service.ts:3139 | No tip read exists | ✓ |
| Sessioned, via `handoff()`, then `emit` | service.ts:7676 (`normalizeGraphId(probe)`) and the `assertWriteTextFields` call at 7677-7684, before `placeOf` (7685) and `lastHash` (7694) | No | ✓ CONFIRMED (test "refuses a lone surrogate in the handoff summary before it reads the chain tip", service.test.ts:1669, gate r33 JUnit, no skipped child) |

Coverage note (info): `handoff()` runs its refusal on the probe built from the caller's input. A `repo` that the place lookup fills in (`place.repo`, service.ts:7685) is not in the probe. That value comes from a graph row written under the same rules, so it cannot hold a lone surrogate. [INFERENCE]

Result: the W-L2 rule holds for every sessioned write path. The W-L2-TIP-ORDER warning is closed in code. Ratification is a human item.

### Doc Wording Check (docs/greptime-ledger.md)

`docs/greptime-ledger.md` is unchanged in the range. The wording verdicts from the 42e3cf13 record stand. The durability sentence (line 1048), "A buffer that is not durable gives its entries up as `abandoned`, each with a record, except pending entries (below), whose records the dead-letter store already holds", matches 49b9aece: no entry is given up without a record, the in-flight one included.

| Point | Doc says | Code | Verdict |
| ----- | -------- | ---- | ------- |
| Flag values, sessioned clause | `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` set to `1`, `true` or `yes`; `SUBSTRATE_LEDGER_CHAIN_CACHE=0` turns the cache off | config.ts accepts `1\|true\|yes`; cache off for `0\|false\|no`. Gate at service.ts:3184-3186. | **Confirmed**, unchanged. |
| Replay appends no event | "a keyed replay answered from the ledger before the tip read appends no event" | Replay lookup at service.ts:3148 (`replayOutcome`), before the tip read. An ingest-membership repair write can still happen. | **Accurate for `agent_events` only.** Open (human item 10). |
| Cache-off, sessionless and uncached-session clauses | A session with no cached tip during an outage is refused at the tip read; a sessionless write reads no tip | `chainTips` null when the switch is off. `lastHash` only when `sessionId` is set. | **Confirmed by code read**, unchanged. Live outage not exercised (operator item 1). |
| Cache-off, "every session write reads the tip first" | As above | A sessioned write with a lone surrogate is refused before the read. | **Precision point for the owner** (human item 10). Not an edit. |

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-buffer.ts` | Bounded per-session FIFO, backoff, drop causes, in-flight protection, file persistence | ✓ VERIFIED | Changed at a0572cf7 (follow-up pass) and at 49b9aece (`abandonAll` records the in-flight entry at once; lines 313-331). Wired from service.ts (`EventBuffer` at 2108). Tests pass: named R-2 and R-3 tests plus the whole file (54 pass across the three targeted files, see Behavioral Spot-Checks). |
| `packages/mcp-server/src/event-dead-letter.ts` | Append-only JSONL dead-letter store with hash, reason, depth, durability | ✓ VERIFIED | Unchanged since 4b84e50c. Wired from service.ts:2107. 0600 on create and on append (lines 149-150). |
| `packages/mcp-server/src/service.ts` | Turn helper, buffering, drain, health, shutdown | ✓ VERIFIED | `appendChained` 3137, `bufferEvent` 3235, `deliverBuffered` 3254, `drainPendingEvents` 3298, `ensureEventDrainTimer` 3306, sync-lag hook 3006 (b4bdd0fc), `eventBuffer` in health 8988. The H-1 hunks (brief snapshot and forget paths, 42e3cf13 record) do not touch phase 76 paths. |
| `packages/mcp-server/src/greptime.ts` | `insertEvent(event, { mayExist })` | ✓ VERIFIED | greptime.ts:1243-1270. Unchanged in the range. greptime.test.ts passes in the 42e3cf13 run below. |
| `packages/mcp-server/src/config.ts` | Six flags, boot refusal when the dead-letter path is missing | ✓ VERIFIED | config.ts:2600-2627 (unchanged in range). |
| `packages/mcp-server/src/index.ts` | Shutdown calls `drainPendingEvents` | ✓ VERIFIED | index.ts:260 (unchanged). |
| `packages/mcp-server/src/server.ts` | `/healthz` spreads `health()` | ✓ VERIFIED | server.ts:995-1002 (unchanged). |
| `packages/mcp-server/src/flag-registry.ts`, `.env.example`, `docs/config-reference.md` | Six flags documented | ✓ VERIFIED | flag-registry.ts:358-363 (phase 76 rows unchanged); .env.example:38-46 (unchanged); docs/config-reference.md unchanged in this range. The `scripts/config-reference.test.ts` run at 42e3cf13 (12 pass) is carried forward. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `appendChained` catch | `EventBuffer.enqueue` | `bufferEvent` | ✓ WIRED | service.ts:3235-3247 and the call sites at 3194 and 3227 |
| `drainEventBuffer` | `deliverBufferedInTurn` | `EventBuffer.drain` | ✓ WIRED | service.ts:3280 (`deliverBufferedInTurn`), 3289 (`drain`) |
| `deliverBuffered` | `insertEvent(…, { mayExist: true })` | direct call | ✓ WIRED | service.ts:3264; greptime.ts:1262 |
| `drainPendingEvents` | `abandonAll` | `options.abandon && !durable` | ✓ WIRED | service.ts:3298-3304 (abandonAll at 3303); index.ts:260 |
| `onDeadLetter` | `DeadLetterStore.record` | constructor closure | ✓ WIRED | service.ts:2115-2118 |
| `emit()` sync-lag hook | `corpusSlo.recordSyncLag` | stored, buffered or deadLettered result | ✓ WIRED | service.ts:3006 (b4bdd0fc) |
| `health()` | `/healthz` body | spread | ✓ WIRED | service.ts:8988; server.ts:1002 |

### Data-Flow Trace (Level 4)

Not applicable to a UI. The buffered event's data path is the real `insertEvent` row write and the dead-letter file record, both traced in the artifact table. The sync-lag reading is set from the note's own `lag_s` (corpus/slo.ts:69-72), not a static value. No static fallback was found.

### Behavioral Spot-Checks

Run at 6e5d766e with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| The three suites touched by 49b9aece and b4bdd0fc: buffer, service-level buffering (incl. the new sync-lag test), dead-letter store | `cd packages/mcp-server && bun test --timeout 30000 src/event-buffer.test.ts src/service-event-buffer.test.ts src/event-dead-letter.test.ts` | 54 pass, 0 fail, 154 expect() calls, 3 files, 272 ms | ✓ PASS |
| R-3 (abandon records the in-flight entry at once) | named tests "abandoning the buffer during a delivery records the in-flight entry at once, so an exit before that delivery settles keeps it" and "an in-flight entry that lands after the buffer was abandoned was recorded at the abandon, once" (event-buffer.test.ts:245, :265) | passed (inside the 54-pass run; gate r33 JUnit, no skipped child) | ✓ PASS |
| SYNC-LAG (buffered docs.sync note sets the reading, lands once) | "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back" (service-event-buffer.test.ts:115) | passed (inside the 54-pass run; gate r33 JUnit, no skipped child) | ✓ PASS |
| R-2 (`all` during a pass) | "a drain with all during a running pass still delivers the entries that pass skipped as not yet due" (event-buffer.test.ts:226; gate r33 JUnit) | passed | ✓ PASS |
| Keyed replay of a pending give-up is refused as a give-up | service-event-buffer.test.ts:350 (gate r33 JUnit) | passed | ✓ PASS |
| Handoff surrogate refused before tip read | "refuses a lone surrogate in the handoff summary before it reads the chain tip" (service.test.ts:1669; gate r33 JUnit) | passed | ✓ PASS |
| Whole workspace at HEAD | gate r33 (`/root/src/worktrees/backups/gate-r33-junit.xml`): 12290 testcases, 0 failures, 2 skipped; none of the named tests above has a skipped child | green at 6e5d766e (gate evidence, not rerun) | ✓ PASS |
| Config reference vs registry | `bun test scripts/config-reference.test.ts` (repo root), run at 42e3cf13 | 12 pass, 0 fail (carried; docs/config-reference.md and flag-registry.ts unchanged since) | ✓ PASS (carried) |
| Not run here | tsc, lint, the full suite, `config:reference --check`, the orchestrator gate | not run, by assignment (gate r33 covers them at 6e5d766e) | ? SKIP |

Postgres evidence: none. No covered test file on this path gates on `SUBSTRATE_TEST_PG_URL` (checked by grep over `event-buffer.ts`, `event-buffer.test.ts`, `service.ts`, `service-event-buffer.test.ts` at 6e5d766e, and over the rest of the covered list at 42e3cf13; the grep is unchanged). The named passes above run in gate r33 and the targeted run unset the variable. No database was started or created.

### Probe Execution

No conventional probes exist (`find scripts -path '*/tests/probe-*.sh'` returns none), and no PLAN declares one. Step 7c does not apply.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R3 | none | Bounded queue, backoff with jitter, durable dead-letter with payload and error, per-record dedupe, depth metrics, chain ordering, truthful acks | ORPHANED | REQUIREMENTS.md line 138 reads "Not started" at 6e5d766e. 76-01-PLAN.md declares no `requirements:`. The delivered code covers most of the description: bounded buffer, backoff, dead-letter with the payload, `mayExist` dedupe, depths in /healthz, chain ordering through the per-session FIFO, and truthful `stored: false` replies. The dead-letter bound is not covered (override). |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| all phase 76 source, test and doc files | — | TBD / FIXME / XXX / TODO / HACK / PLACEHOLDER | none | Debt-marker scan over the files, and over every added line of the four covered files changed in 42e3cf13..6e5d766e (event-buffer.ts, event-buffer.test.ts, service.ts, service-event-buffer.test.ts): 0 matches. |

### Human Verification Required

See the `human_verification` frontmatter: operator items 1 to 8 (live GreptimeDB outage, dead-letter exhaustion, torn-line restart, shutdown under the service manager, live steering session, live replay, the enablement decision, /healthz staleness), plus owner items for the handoff reorder ratification, the D76-14/19 ratification, the two doc sentences, and HARD-R3 traceability. The SYNC-LAG owner item from the 42e3cf13 record is removed: the residual is closed in code (`residuals_closed`).

### Gaps Summary

No blocking gap. Both roadmap truths are satisfied: SC1 within the owner-accepted pre-send scope, SC2 by owner override. The status is `human_needed` because the live items and the owner decisions above are open.

Residuals at 6e5d766e:
- **Closed:** R-3 (an in-flight entry given up at exit is recorded at once; 49b9aece). SYNC-LAG-BUFFERED-NOT-RECORDED (b4bdd0fc). Both are listed in `residuals_closed` with their named tests.
- **Operator item 4** keeps its text. Its last sentence refers to R-3-UNSETTLED-AT-EXIT, which is now closed: a non-durable buffer's in-flight entry is recorded at the abandon, not at settlement. The item's live check (a durable buffer survives a SIGKILL mid-pass) is unchanged and still open.
- Operator items 1 to 8 (live), kept as written.
- D76-15: operator decision to enable the buffer.
- D76-14 and D76-19: a buffered `session.end` closes steering before its note lands; PLAN says it should stay open. Owner ratification open.
- R-1: live keyed replay after a dead-letter record. Code path tested, live not.
- R-2: closed in code (a0572cf7), named test passing at 6e5d766e.
- Dead-letter cap: a tracked follow-up under the override. SC2's literal dead-letter bound is not met.
- HARD-R3: orphaned in REQUIREMENTS.md; status line stale.
- Handoff tip read outside the session turn (info, `HANDOFF-TIP-OUTSIDE-TURN`). Not exercised.
- New info items at 6e5d766e: `KEYED-REPLAY-RESTATES-SYNC-LAG`, `ABANDON-RECORD-UNCHECKED`, and `CORPUS-EVAL-DOC-SYNC-LAG-WORDING` (outside the covered list; for the orchestrator). None changes the score or the status.
- Doc precision points (human item 10).

Deferred items (Step 9b): none taken. The dead-letter bound is an owner override, not a deferral to a later phase.

---

_Verified: 2026-11-05T07:59:10Z_
_Verifier: Claude (gsd-verifier)_
