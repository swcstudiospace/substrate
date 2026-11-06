---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-06T00:48:32Z
status: human_needed
score: "2/2 must-haves verified (SC1 VERIFIED within the owner-accepted pre-send scope, PLAN D76-10, with the buffer enabled per D76-15; SC2 PASSED by owner override, not verified). No gap open in SC1 or SC2 code. R-3 is closed for the abandon path (an identifier line per held record on stderr, 7a1d923a) and open for a held record behind a durable buffer (ABANDON-REPORT-SCOPE, info). SYNC-LAG-BUFFERED-NOT-RECORDED and CORPUS-EVAL-DOC-SYNC-LAG-WORDING are closed. W-L2-TIP-ORDER is closed in code; its owner ratification is not recorded."
covered_files: [".env.example", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-PLAN.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-SUMMARY.md", "docs/config-reference.md", "docs/greptime-ledger.md", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-buffer.test.ts", "packages/mcp-server/src/event-buffer.ts", "packages/mcp-server/src/event-dead-letter.test.ts", "packages/mcp-server/src/event-dead-letter.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/handoff.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/reanchor-run.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:d2530a156b831e555708dd7274bb5ca3116cdd2363e3198f9dcc9a21e2d65c43"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag."
    reason: "Owner accepted the override on 2026-11-02. The dead-letter store is deliberately unbounded (plan decision D76-13): a bound would have to drop records, the silent loss this phase removes. The buffer is bounded by SUBSTRATE_EVENT_BUFFER_MAX, and the depth of both stores is reported in /healthz. A dead-letter cap is a tracked follow-up."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: "2/2 (prior record 76-VERIFICATION.md at 6e5d766e, verified 2026-11-05T07:59:10Z)"
  mode: "re-verification at a46d42c3 (branch gsd/v18-int-all, clean). Ten covered files changed since 6e5d766e (274 insertions, 67 deletions), by four commits: 884e0753, 7a1d923a, f0f3c04e, a46d42c3. Commits e3914640, e958e8b1, 885e73ce, c371cece and 9b793653 touch no covered file. Each changed covered file was read in full or at each hunk that touches a phase 76 path. Line numbers are re-anchored at a46d42c3."
  gaps_closed:
    - "R-3 abandon path: a dead-letter record still held in memory when the buffer is abandoned is written to stderr as one identifier line (7a1d923a; event-buffer.ts:347-357, called from abandonAll at :338; wired by service.ts:2123)"
  gaps_remaining: []
  regressions: []
residuals_closed:
  - id: R-3-UNSETTLED-AT-EXIT
    truth: "An entry given up by abandonAll() while its delivery is in flight is recorded at the abandon, so an exit before that delivery settles keeps its record."
    status: "CLOSED at 49b9aece. abandonAll (event-buffer.ts:327-339) records every remaining entry at once, the in-flight one included; runDrain (event-buffer.ts:387-389) does not record it again when the delivery settles. Named tests, passing in gate r36 JUnit with no failure, error or skipped child: 'abandoning the buffer during a delivery records the in-flight entry at once, so an exit before that delivery settles keeps it' (event-buffer.test.ts:245) and 'an in-flight entry that lands after the buffer was abandoned was recorded at the abandon, once' (event-buffer.test.ts:265). A duplicate on a late landing is at-least-once and detectable, per the owner decision in force."
  - id: R-3-HELD-RECORD-REPORTED-AT-ABANDON
    truth: "A dead-letter record held in memory when the buffer is abandoned is reported on stderr, with identifiers only, so the process's exit leaves a trace."
    status: "CLOSED for the abandon path at 7a1d923a, with two limits recorded as warnings: the report carries no payload (ABANDON-STDERR-IDENTIFIERS-ONLY), and it runs only when the buffer is not durable (ABANDON-REPORT-SCOPE). Named tests, gate r36 JUnit, no failure, error or skipped child: 'abandonAll with a dead-letter file that cannot be written reports each held record on stderr as one JSON line of identifiers, never the summary' (event-buffer.test.ts:529); 'abandonAll on a durable dead-letter store writes no identifier line to stderr' (event-buffer.test.ts:504); 'a service that shuts down while a dead-letter file cannot be written reports each held record on stderr, and no summary text' (service-event-buffer.test.ts:234). The title 'an unwritable dead-letter store reports each held record on stderr' used in the request does not occur in the source or the JUnit; the titles above are the ones cited."
  - id: SYNC-LAG-BUFFERED-NOT-RECORDED
    truth: "A stored docs.sync note updates the corpus sync-lag gauge (phase 70 SC3), and so does a docs.sync note the server took but did not store."
    status: "CLOSED at b4bdd0fc, re-anchored here. The sync-lag hook (service.ts:3016-3019) runs on the stored, buffered and deadLettered branches of emit(), and reaches the gauge through the observer (884e0753: SubstrateObserver.syncLag, service.ts:1061; observe.ts:399-401 calls instruments.setCorpusSyncLag). Named test 'a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back' (service-event-buffer.test.ts:115; asserts 4000 s while down, after the drain, and the observer saw [4000] both times) passes in gate r36 JUnit with no skipped child. The deadLettered branch has no test of its own; it is code-verified only (service.ts:3016; deadLettered returns at :3171 and :3255)."
  - id: CORPUS-EVAL-DOC-SYNC-LAG-WORDING
    truth: "docs/corpus-eval.md describes when the sync-lag reading is set."
    status: "CLOSED at HEAD (884e0753 and bb6b38b7, outside this phase's covered list). docs/corpus-eval.md:105 now says the gauge is set by each docs.sync note the server took (stored, held for a later write, or dead-lettered). The record of 6e5d766e reported the old wording; that item is withdrawn."
warnings:
  - id: ABANDON-REPORT-SCOPE
    truth: "The stderr identifier report covers every held dead-letter record at shutdown."
    status: "OPEN (info; [INFERENCE] from code read; not exercised with a real DeadLetterStore and a durable buffer). drainPendingEvents calls abandonAll only when the buffer is not durable (service.ts:3316). With a durable buffer nothing is reported at exit. Most held records are backed by the buffer file: a given-up entry stays in the buffer as pending (dropFrom, event-buffer.ts:462-485; settlePending, :414-432), and hydrate reads it back. One is not: in enqueue (event-buffer.ts:259-284), when the buffer is full, onDeadLetter writes the new event's record (:267), the store keeps it in memory (record(), event-dead-letter.ts:107-127), and the event is refused with recorded false (:284). Its record is then held with no copy in the buffer, and a durable buffer exits without reporting it. The caller is told stored false (service.ts:3253-3255). The test that models this path (event-buffer.test.ts:457) uses a fake store and a memory-only buffer, so it does not reach the gap. Owner decision needed: report held records on every shutdown, or accept the limit."
  - id: ABANDON-STDERR-IDENTIFIERS-ONLY
    truth: "A record given up at shutdown keeps its event payload for an operator."
    status: "INFO. By design (event-buffer.ts:347-357: 'Never the payload or the summary'). The stderr line carries id, event_id, hash, reason, session_id and recorded_at. The payload is lost with the process unless the caller holds a copy. The report makes the loss visible, not recoverable. The owner decision in force, 'the in-flight event is recorded at shutdown', is met by the record, not by the line."
  - id: ABANDON-RECORD-UNCHECKED
    truth: "A dead-letter record taken at abandonAll() reaches the dead-letter file before the process exits."
    status: "NARROWED, still open. abandonAll ignores the boolean that onDeadLetter returns (event-buffer.ts:336; service.ts:2118-2121 returns deadLetters.durable). A record that did not reach the file is now reported on stderr at :338 when the store is not durable, so it is no longer silent. It is still not on disk at exit."
  - id: DOC-ABANDON-STDERR-AND-REFUSAL
    truth: "docs/greptime-ledger.md describes the abandon report and the refused-event rule."
    status: "OPEN (doc; covered file, reported, not edited). docs/greptime-ledger.md:1048 ('gives its entries up as abandoned, each with a record') does not name the stderr identifier line from 7a1d923a. Line 1049 says 'When the buffer is full and nothing can be given up, the new event is refused with stored: false and nothing is recorded'. The enqueue code can hold a record for that event before refusing it (event-buffer.ts:267-284), so 'nothing is recorded' is not exact for that sub-case. [INFERENCE from code read]"
  - id: DIGEST-NOT-REPRODUCED-AT-BASE
    truth: "The covered_digest stored in the 6e5d766e record reproduces at 6e5d766e."
    status: "OPEN (tooling, for the orchestrator). The stored value v3:sha256:02633fdb70dbe2a997f78e06763565c7dfeeab88c37ada1cdf35b57e29d33398 does not reproduce. Running gsd_run query verification.fingerprint on a git archive of 6e5d766e with the same 23 covered paths gives v3:sha256:24b18bd369d321b456c94ef4abb39a08f23c06b9db8674a7cc653b4198dfc87d. The per-file hashes at HEAD differ from the base archive in exactly the 11 covered files changed since 6e5d766e, so the archive is sound. The digest in this record is computed at HEAD only."
  - id: HARD-R3-ORPHANED
    truth: "REQUIREMENTS.md HARD-R3 maps to Phase 76."
    status: "ORPHANED (carried). No plan frontmatter declares requirements for 76-01-PLAN.md. REQUIREMENTS.md line 138 still reads 'Not started' at a46d42c3 (checked). ROADMAP.md still lists R-3 as open. Neither file is edited by this record."
  - id: HANDOFF-TIP-OUTSIDE-TURN
    truth: "Chain-tip reads for a session run inside that session's turn, so no append interleaves with them."
    status: "OPEN (info, carried; re-anchored). handoff() reads lastHash at service.ts:7723 outside any session turn; its emit at about :7747 reaches append (service.ts:3079, withSessionTurn) and then appendChained. A concurrent emit for the same session can land between the two, so the packet's prev_event_hash can differ from the stored event's prev. [INFERENCE from code read; not exercised.]"
  - id: KEYED-REPLAY-RESTATES-SYNC-LAG
    truth: "A keyed replay does not change the corpus sync-lag gauge (phase 70 SC3)."
    status: "OPEN (info; corrected from the 6e5d766e record). A keyed replay answered from the ledger returns deduplicated: true (replayOutcome, service.ts:3130), and emit() returns before the sync-lag hook (service.ts:2992-2996). So a ledger-answered replay does not restate the gauge. The 6e5d766e record said it did, citing a stored: true result; the deduplicated early return was already there at 6e5d766e (service.ts:2982). A replay answered as buffered (service.ts:3168) or as given up (service.ts:3171) does reach the hook (3016-3019) and restates that note's lag. If a different session's docs.sync note has stored in between, the gauge reverts to the replayed note's lag. [INFERENCE from code read; not exercised.]"
  - id: R-2-DRAIN-ALL-DURING-PASS
    truth: "A drain with all during a running pass delivers the entries that pass skipped."
    status: "CLOSED in code (a0572cf7). Named test 'a drain with all during a running pass still delivers the entries that pass skipped as not yet due' (event-buffer.test.ts:226) passes in gate r36 JUnit with no skipped child. A live drain has not been observed; kept as owner/operator item 14."
human_verification:
  - test: "Operator item 1. Live GreptimeDB rehearsal of the accepted outage limit: block the ledger and emit for one session; restore. Cover (a) a session whose tip is cached, first write fails; (b) that session's next write while the outage lasts; (c) a write for a session with no cached tip; (d) the same run with SUBSTRATE_LEDGER_CHAIN_CACHE=0, sessioned writes, including a write whose tip read succeeds and whose insert fails; (e) a sessionless write during the outage in a process that confirmed append-mode before the outage; (f) a sessionless write in a process whose first ledger contact is during the outage."
    expected: "(a) answers 503 with buffered true and stored false; /healthz eventBuffer.depth rises. (b) and (c) answer stored false with buffered absent, refused at the tip read (service.ts:3176-3184). (d) a sessioned write whose tip read fails is refused; one whose tip read succeeds and whose insert fails is buffered when append mode is confirmed; without that confirmation and without SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER=1|true|yes it is refused as APPEND_MODE_UNKNOWN before the insert (gate at service.ts:3196-3198). (e) is buffered. (f) is refused as APPEND_MODE_UNKNOWN unless the allow flag is set. After restore each buffered event lands once."
    why_human: "Needs a live GreptimeDB and a real outage. The sessionless and write-only clauses are code reads and fake-based tests, not live proofs."
  - test: "Operator item 2. Dead-letter exhaustion on a live outage (nominal budget 243 s; 195 to 292 s with jitter)."
    expected: "A dead-letter line is written with its hash (event-dead-letter.ts record(), hash from event.hash, :113) and the file mode is 0600 (event-dead-letter.ts:154-155). Boot refusal without SUBSTRATE_EVENT_DEAD_LETTER_PATH is covered by config.ts:2607-2612 and service-event-buffer.test.ts:286, not by this item."
    why_human: "Needs a live outage longer than the retry budget. Scratch probes wrote their own files, so 0600 on a service-written file was not exercised."
  - test: "Operator item 3. Restart during an outage with a durable file that may end in a torn line from a real crash."
    expected: "The next boot reports the depth, starts the drain timer, and drains each entry once. The torn line is counted as malformed and skipped. The next dead-letter write starts on a fresh line. No record is lost."
    why_human: "The tests inject a torn line; a real partial write on a real disk is not reproduced."
  - test: "Operator item 4 (R-3 residual). Shutdown under the service manager: index.ts:260 drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true }), then service.ts:3311-3317."
    expected: "Finishes within the unit's stop bound with a durable buffer. The bounds stack (retain pass, event pass, transitions, flush) can exceed infra/vps/substrate-host.service TimeoutStopSec=15, so a SIGKILL mid-pass is possible; confirm that a durable buffer survives it. A non-durable buffer's in-flight entry is recorded at the abandon (R-3-UNSETTLED-AT-EXIT), and each held record is reported on stderr as identifiers (R-3-HELD-RECORD-REPORTED-AT-ABANDON). Confirm the stderr lines are captured by the service manager's journal."
    why_human: "Needs the real service manager, a durable buffer file under a stop, and a non-durable run to see the stderr lines."
  - test: "Operator item 5 (D76-14, D76-19). Buffered session.end on a live steering session."
    expected: "The session closes first (service.ts:2280 liveSessions.close, :2282 steeringWaiters.closeSession, then the emit at :2283, wrapped at :2283-2286), so steering is closed whether or not the note lands. The code does not keep the session open until the note lands, as PLAN D76-14 and D76-19 say; docs/greptime-ledger.md describes the code."
    why_human: "Needs a live steering session and the owner's ratification of the behaviour."
  - test: "Operator item 6 (R-1). Keyed replay after a dead-letter record on a live collector spool."
    expected: "Confirm which trigger occurs: one new row with a new id (the dead-letter record is orphaned, the common case), or two rows. The replay of a pending give-up is code-verified (service.ts:3161-3171; service-event-buffer.test.ts:391, passing in gate r36); the live replay after the record has left the buffer is not."
    why_human: "Needs a live collector spool and ledger."
  - test: "Operator item 7 (D76-15). Operator decision to enable the buffer."
    expected: "SC1 holds with SUBSTRATE_EVENT_BUFFER_PATH and SUBSTRATE_EVENT_DEAD_LETTER_PATH set (config.ts:2605-2619 refuses boot when only the buffer path is set). With the buffer unset, a failed write answers stored false and nothing is queued (config.ts:2606 returns null)."
    why_human: "Configuration and policy decision, not code-verifiable."
  - test: "Operator item 8. /healthz staleness."
    expected: "The body is memoised for SUBSTRATE_HEALTHZ_CACHE_MS (default 5000, config.ts:1217; memo in server.ts:984-1001). Pollers see a depth change within that window."
    why_human: "Needs a running server and a poller."
  - test: "Owner item 9 (W-L2-TIP-ORDER, handoff). Commit a9e477e2 moved handoff()'s text refusal and graph-id check before placeOf and lastHash, as the recorded W-L2 rule requires (service.ts:7705-7713, before :7714 and :7723). The owner confirms this as the decided behaviour and records it."
    expected: "The owner records the ratification in ROADMAP.md or the phase record. If the owner wants a different rule, the handoff path is the only one affected."
    why_human: "An owner decision on write ordering; no verifier can supply it."
  - test: "Owner item 10 (doc precision, docs/greptime-ledger.md). (1) The replay-effect sentence ('a keyed replay answered from the ledger ... appends no event') is accurate for agent_events only; the event_ingest repair write is not named. (2) The cache-off sentence 'every session write reads the tip first' does not name a sessioned write refused for a lone surrogate, which is refused before the read. (3) Line 1049 'nothing is recorded' does not cover a record held for an event refused on a full buffer (DOC-ABANDON-STDERR-AND-REFUSAL). (4) Line 1048 does not name the stderr identifier line (7a1d923a)."
    expected: "The owner confirms or amends each sentence and records the decision. Doc edits are for the owner of that file."
    why_human: "A ratification is an owner decision; no verifier can supply it."
  - test: "Owner item 11 (D76-13). The dead-letter store is unbounded by plan decision, with an accepted override (2026-11-02). A dead-letter cap is a tracked follow-up."
    expected: "The owner confirms the follow-up is tracked, with its owner and phase, and that an unbounded dead-letter store is accepted until then. Depth is reported on /healthz (service.ts:9020)."
    why_human: "A scope decision, recorded in the override. No verifier can supply it."
  - test: "Owner item 12 (ABANDON-REPORT-SCOPE). Decide whether a held dead-letter record must be reported at shutdown when the buffer is durable, and whether the identifier-only stderr line (no payload) is the accepted form of R-3."
    expected: "Either the owner accepts both limits and records it, or asks for a change to drainPendingEvents (service.ts:3316) to report held records on every shutdown. Any change is a new code change, not part of this record."
    why_human: "An owner decision on what an exit must leave behind. The code path is read, not exercised."
  - test: "Owner item 13 (D76-14 and D76-19 ratification). A buffered session.end closes steering before its note lands; PLAN says the session should stay open until the note lands."
    expected: "The owner records whether the closing order stands, and docs/greptime-ledger.md is updated to match if so."
    why_human: "An owner decision on the session boundary; no verifier can supply it."
  - test: "Owner item 14 (R-2). The 'all' follow-up pass for entries a running pass skipped (event-buffer.ts:297-310; test at event-buffer.test.ts:226) is closed in code (a0572cf7). The owner or operator confirms it on a live drain."
    expected: "A live drain of an entry that was not yet due at the start of a running pass is delivered once, and the buffer is empty afterward."
    why_human: "Needs a live drain under load. The named test passes in gate r36; a live run is not observed."
  - test: "Owner item 15 (HARD-R3). No plan claims it. REQUIREMENTS.md still reads 'Not started'."
    expected: "The owner either maps HARD-R3 to 76-01 and updates its status, or records why it stays orphaned."
    why_human: "Traceability is an owner decision."
---

# Phase 76: Telemetry buffer and dead-letter Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently. (ROADMAP.md, Phase 76)

**Verified:** 2026-11-06T00:48:32Z
**Status:** human_needed
**Re-verification:** Yes. Prior record at 6e5d766e (verified 2026-11-05T07:59:10Z). Since then, four commits changed covered files: 884e0753 (sync-lag gauge at emit, phase 70 W-1), 7a1d923a (dead-letter report on stderr at abandon), f0f3c04e (request-shape refusals, silent failures reported, greptime reply shape), a46d42c3 (dead code removed). Verdicts not touched by them are carried forward.
**Worktree / HEAD:** `/root/src/worktrees/as-gsd-v18-all` (branch gsd/v18-int-all) at a46d42c3, clean. The fingerprint is recomputed at HEAD and copied into the frontmatter.
**Line references:** Re-anchored at a46d42c3. `event-buffer.ts`: `abandonAll` moved from 319 to 327 (+8) with the options and report additions, and later lines move with it. `service.ts` moved most in the buffer, emit and handoff areas (e.g. emit hook 3016, handoff lastHash 7723, health 9020). `event-dead-letter.ts` is +5 from line 93 on. `event.ts` is -5 from line 812 on. Test cites are file:line of the current source; each is also the JUnit `line` attribute for that title.
**Tests:** Not run here (assignment forbids test runs). Test evidence is the gate r36 JUnit at `/root/src/worktrees/backups/gate-r36-junit.xml`: 12,317 testcases, 0 failures, 0 errors, 2 skipped (neither is a title cited here). The JUnit records no commit; the cited titles appear at the same file:line as the HEAD source, which is the basis for treating it as covering HEAD.

## Goal Achievement

### Observable Truths

| #   | Truth   | Status     | Evidence       |
| --- | ------- | ---------- | -------------- |
| 1   | SC1: A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash. | ✓ VERIFIED (within the owner-accepted pre-send scope, D76-10; with the buffer enabled, D76-15) | Write failure → `appendChained` catch → `bufferEvent` (call sites service.ts:3207 and 3240; definition 3248). Bound: `EventBuffer.enqueue` evicts or refuses past `max` (event-buffer.ts:238-291). Backoff: base×2^n capped, ±20 % jitter (event-buffer.ts:40-44). Ceiling: `runDrain` (event-buffer.ts:362-402) dead-letters with `exhausted` at `attempts >= maxAttempts` (`dropFrom`, :462). Record: `DeadLetterStore.record` writes `event_hash` (event-dead-letter.ts:107-127, hash at :113). Retries use `insertEvent(entry.event, { mayExist: true })` (service.ts:3277; greptime.ts:1254-1268). |
| 2   | SC2: Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag. | ✓ PASSED (override), not verified | `health().eventBuffer` is `{ enabled: false }` when off, else `{ enabled: true, ...stats, deadLetter: { depth, durable } }` (service.ts:9020). `server.ts` spreads `health` into the `/healthz` body (server.ts:1001). Buffer bound by `SUBSTRATE_EVENT_BUFFER_MAX` (config.ts:2623, default 256 from event-buffer.ts:29). Dead-letter store is not bounded (D76-13; event-dead-letter.ts:11-12). Named passes in gate r36 JUnit: 'the health body reports the buffer's depth and the dead-letter depth, each with its durability' (service-event-buffer.test.ts:274); 'a buffer with no dead-letter path refuses boot, and the message names the missing variable' (service-event-buffer.test.ts:286). The literal SC2 is not met for the dead-letter half. Override carried forward. |

**Score:** 2/2 truths counted (1 VERIFIED, 1 PASSED by override). behavior_unverified: 0. Warnings below do not change the score.

### Abandon Path Re-audit (7a1d923a)

Trace, at a46d42c3:

1. Shutdown: `index.ts:260` runs `drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })` inside `server.close`, before the flush and `process.exit(0)`.
2. `drainPendingEvents` (service.ts:3311-3317) runs one bounded `drainEventBuffer({ all: true })`, stops the periodic drain, and calls `abandonAll()` only when `!stores.buffer.durable` (service.ts:3316).
3. `abandonAll` (event-buffer.ts:327-339) removes every entry, then for each entry not already pending sets `given_up = "abandoned"` and calls `onDeadLetter` (:336). An in-flight entry is included (R-3-UNSETTLED-AT-EXIT). A pending entry is not recorded again: its record is already with the store.
4. `reportHeldDeadLetters` (event-buffer.ts:347-357, called at :338) returns at once when the store is durable. Otherwise it writes one JSON line per record in `heldRecords()` (event-dead-letter.ts:97-99): `id`, `event_id`, `hash`, `reason`, `session_id`, `recorded_at`. No payload and no summary. `heldRecords()` covers every record not yet on the file, pending entries included.
5. The service wires the store into the buffer (service.ts:2110-2123, `deadLetters,` at :2123).

What is covered:
- An in-flight entry given up at shutdown, while its record is held, is reported (test event-buffer.test.ts:529 covers the held case with two entries; the in-flight case is covered in code by the same path).
- A held record for a pending entry is reported, because the report reads the store, not the buffer.
- A durable store writes no identifier line (event-buffer.test.ts:504; the test also asserts the store's own `[substrate] event ` line is the only stderr output).
- At service level, one JSON line for the `exhausted` record and no summary text (service-event-buffer.test.ts:234; the test spies on `process.stderr.write` for the single `drainPendingEvents` call and parses every write as JSON, so any other stderr write in that window would fail it).

What is not covered (recorded as warnings, not as a score change):
- **ABANDON-REPORT-SCOPE** (open, info). A durable buffer skips `abandonAll`, so nothing is reported at exit. Held records behind a durable buffer are backed by the buffer file when they belong to a pending entry. The exception is the full-buffer refusal: `enqueue` writes the new event's record (event-buffer.ts:267), the store holds it when the file write fails, and the event is refused with `recorded: false` (:284). That record has no copy in the buffer and is not reported at exit. The caller is told `stored: false` (service.ts:3253-3255). The only test of this branch (event-buffer.test.ts:457) uses a fake store and a memory-only buffer. [INFERENCE from code read.]
- **ABANDON-STDERR-IDENTIFIERS-ONLY** (info, by design). The payload of an abandoned event is lost with the process unless the caller holds a copy. The report makes the loss visible; it does not make it recoverable.
- **ABANDON-RECORD-UNCHECKED** (narrowed). `abandonAll` still ignores the boolean from `onDeadLetter` (:336). A record not on the file is now reported at :338 when the store is not durable.

Result: R-3 is closed for the abandon path of a non-durable buffer. The durable-buffer refusal case is open as an info item for the owner (owner item 12).

### Changed Since the 6e5d766e Record

`git diff --stat 6e5d766e..HEAD` over the covered list: ten covered files changed, 274 insertions and 67 deletions. Only four commits touch covered files; the rest of the range does not (e3914640, e958e8b1, 885e73ce, c371cece, 9b793653, and the docs commits bb6b38b7, 403e45f7, c71a539d, aef8a351, b1bb49f2). Each changed covered file was read.

| File | Change | Phase 76 effect |
| ---- | ------ | --------------- |
| `packages/mcp-server/src/event-buffer.ts` | 7a1d923a: `deadLetters` option (:105) and field (:148, :175); `abandonAll` calls `reportHeldDeadLetters` (:338); new `reportHeldDeadLetters` (:347-357). | R-3 abandon-path report (see Abandon Path Re-audit). SC1 and D76-13 unchanged: the enqueue, dropFrom, settlePending and runDrain logic is not in the diff. |
| `packages/mcp-server/src/event-buffer.test.ts` | 7a1d923a: tests at :504 and :529 added. | Pins the report and its absence on a durable store. Both pass in r36. |
| `packages/mcp-server/src/event-dead-letter.ts` | 7a1d923a: `heldRecords()` (:96-99), a copy of the records not yet on the file. | Read by the report. The rest of the file is unchanged, so the 0600 and append rules (:154-155) and the durability rule (:88-90) stand. This corrects the 6e5d766e note that the file was unchanged since 4b84e50c. |
| `packages/mcp-server/src/service.ts` | 884e0753: sync-lag hook at emit (:3016-3019), `syncLag` observer hook (:1061), REST gauge moved here. 7a1d923a: `deadLetters` passed to the buffer (:2123). f0f3c04e and 884e0753: `reportSilent` at former silent catches (e.g. :2284); `reportSilent` writes one stderr line per site per process (silent-failures.ts). a46d42c3: none in the covered path. | The sync-lag residual is closed (see residuals). The session-end order is unchanged: close at :2280, closeSession at :2282, emit at :2283. The new catch at :2283-2286 reports a rejected emit and returns `false`, the same answer as before. The handoff refusal (7705-7713) precedes placeOf (7714) and lastHash (7723). |
| `packages/mcp-server/src/service-event-buffer.test.ts` | 884e0753: `observer` argument and the sync-lag assertions in the test at :115. 7a1d923a: test at :234 added; later tests move (the boot refusal test at 245 under 6e5d766e is now 286). | Pins the sync-lag rule and the report. Both pass in r36. |
| `packages/mcp-server/src/server.ts` | 884e0753: `syncLagSeconds` import and the REST gauge call removed from `/events` (the call that was at old :1362). f0f3c04e: `/evidence`, `/handoff`, `/drift`, `/verify` refuse a non-object JSON body with 400 (checks at :1217, :1503, :1587, :1622); `handleMcp` close catches (:2802-2803). | The gauge is still set: emit() now calls `observer.syncLag`, which `observe.ts:399-401` routes to `instruments.setCorpusSyncLag`, and the `/events` route calls `substrate.emit` (server.ts:1358). No phase 76 path changes. |
| `packages/mcp-server/src/greptime.ts` | f0f3c04e: `sql()` reply is checked to be an object and `records.rows` an array (:922-934, within the hunk at 913-939). | Tip reads (`lastHash`, greptime.ts:1489) and `eventRowPresent` (:1305) go through `sql()`. A malformed reply that used to surface as a `TypeError` now surfaces as a `GreptimeError`. Both reach the same catches: a tip error refuses the write (service.ts:3190-3193); a delivery error is transient (service.ts:3280-3282). No change in outcome. `insertEvent` at :1254 (was :1243). |
| `packages/mcp-server/src/greptime.test.ts` | f0f3c04e: test at :305 added. | Pins the object-shape refusal. Passes in r36. |
| `packages/mcp-server/src/config.ts` | a46d42c3: a doc comment at :336-337 only. | None. The buffer settings (2600-2627) are unchanged. |
| `packages/mcp-server/src/event.ts` | a46d42c3: `isPlanningUpdate` removed (old :812-815). No caller remains. | None. |
| `packages/mcp-server/src/mcp.ts` | f0f3c04e: `reportSilent` at the Railway write-note catch (:2216). | None on phase 76. |

Other covered files (`handoff.ts`, `index.ts`, `flag-registry.ts`, `event.test.ts`, `event-dead-letter.test.ts`, `service.test.ts`, `reanchor-run.ts`, `docs/config-reference.md`, `docs/greptime-ledger.md`, `.env.example`, the two PLAN/SUMMARY files) are unchanged in the range, except that `docs/greptime-ledger.md` is unchanged and its verdicts stand.

### W-L2 Write-Path Ordering (re-checked at a46d42c3)

Question: does the surrogate refusal of the six write text fields, and the graph id check, happen before any chain-tip read, buffer or insert on a sessioned write?

| Write shape | Refusal reached at | Tip read before refusal? | Verdict |
| ----------- | ------------------ | ------------------------ | ------- |
| Keyed, replay lookup, via `emit` | service.ts:3152 (`assertWriteTextFields`), 3154 (`normalizeGraphId`), before `replayOutcome` (call at 3161) | No | ✓ refused before lookup, tip, buffer, insert |
| Sessioned, via `emit` / `appendChained`, keyed or unkeyed | service.ts:3152, 3154, before `lastHash` at 3180 | No | ✓ CONFIRMED (named test passing in gate r36; code unchanged in this range) |
| Sessionless, keyed or unkeyed | service.ts:3152 | No tip read exists | ✓ |
| Sessioned, via `handoff()`, then `emit` | service.ts:7705 (`normalizeGraphId(probe.graph_id)`) and the `assertWriteTextFields` call at 7706-7713, before `placeOf` (7714) and `lastHash` (7723) | No | ✓ CONFIRMED (test "refuses a lone surrogate in the handoff summary before it reads the chain tip", service.test.ts:1669, gate r36 JUnit, no skipped child) |

Coverage note (info): `handoff()` runs its refusal on the probe built from the caller's input. A `repo` that the place lookup fills in (`place.repo`, service.ts:7714) is not in the probe. That value comes from a graph row written under the same rules, so it cannot hold a lone surrogate. [INFERENCE]

Result: the W-L2 rule holds for every sessioned write path. The W-L2-TIP-ORDER warning is closed in code. Ratification is owner item 9.

### Doc Wording Check (docs/greptime-ledger.md)

`docs/greptime-ledger.md` is unchanged in the range. The wording verdicts from the 6e5d766e record stand, except for the new points below.

| Point | Doc says | Code | Verdict |
| ----- | -------- | ---- | ------- |
| Flag values, sessioned clause | `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` set to `1`, `true` or `yes`; `SUBSTRATE_LEDGER_CHAIN_CACHE=0` turns the cache off | config.ts accepts `1\|true\|yes`; cache off for `0\|false\|no`. Gate at service.ts:3196-3198. | **Confirmed**, unchanged. |
| Replay appends no event | "a keyed replay answered from the ledger before the tip read appends no event" | Replay lookup at service.ts:3161 (`replayOutcome`), before the tip read. An ingest-membership repair write can still happen. | **Accurate for `agent_events` only.** Owner item 10. |
| Cache-off, sessionless and uncached-session clauses | A session with no cached tip during an outage is refused at the tip read; a sessionless write reads no tip | `chainTips` null when the switch is off. `lastHash` only when `sessionId` is set. | **Confirmed by code read**, unchanged. Live outage not exercised (operator item 1). |
| Cache-off, "every session write reads the tip first" | As above | A sessioned write with a lone surrogate is refused before the read. | **Precision point for the owner** (owner item 10). Not an edit. |
| Durability sentence (line 1048) | "A buffer that is not durable gives its entries up as `abandoned`, each with a record" | True, but the held record's stderr identifier line (7a1d923a) is not named. | **Doc gap** (DOC-ABANDON-STDERR-AND-REFUSAL). Owner item 10. |
| Refusal sentence (line 1049) | "the new event is refused with `stored: false` and nothing is recorded" | Not exact for a record held for a refused event (event-buffer.ts:267-284). | **Doc precision point** (owner item 10). |

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-buffer.ts` | Bounded per-session FIFO, backoff, drop causes, in-flight protection, file persistence, abandon report | ✓ VERIFIED | Changed at a0572cf7, 49b9aece (`abandonAll` records the in-flight entry at once) and 7a1d923a (`reportHeldDeadLetters`, :347-357). Wired from service.ts:2111. Named tests in r36 JUnit (Abandon Path Re-audit; R-2 test at :226). |
| `packages/mcp-server/src/event-dead-letter.ts` | Append-only JSONL dead-letter store with hash, reason, depth, durability, held-record copy | ✓ VERIFIED | `heldRecords()` added at 7a1d923a (:96-99). Wired from service.ts:2110. 0600 on create and on append (:154-155). |
| `packages/mcp-server/src/service.ts` | Turn helper, buffering, drain, health, shutdown, sync-lag at emit | ✓ VERIFIED | `append` 2988 (turn at :3079), `appendChained` 3150, `bufferEvent` 3248, `deliverBuffered` 3267, `drainPendingEvents` 3311, `ensureEventDrainTimer` 3319, sync-lag hook 3016-3019, `eventBuffer` in health 9020. |
| `packages/mcp-server/src/greptime.ts` | `insertEvent(event, { mayExist })`; `sql()` reply shape | ✓ VERIFIED | `insertEvent` 1254; `mayExist` path 1268. `sql()` checks at 922-934 (f0f3c04e); its test at greptime.test.ts:305 passes in r36. |
| `packages/mcp-server/src/config.ts` | Six flags, boot refusal when the dead-letter path is missing | ✓ VERIFIED | config.ts:2600-2627 (unchanged in range apart from a comment at :336-337). |
| `packages/mcp-server/src/index.ts` | Shutdown calls `drainPendingEvents` with `abandon` | ✓ VERIFIED | index.ts:260 (unchanged). |
| `packages/mcp-server/src/server.ts` | `/healthz` spreads `health()`; `/events` reaches `emit` | ✓ VERIFIED | `/healthz` 984-1001 (spread at :1001). `/events` calls `substrate.emit` at :1358. REST gauge call removed (884e0753). |
| `packages/mcp-server/src/flag-registry.ts`, `.env.example`, `docs/config-reference.md` | Six flags documented | ✓ VERIFIED | Unchanged in range. The `scripts/config-reference.test.ts` run at 6e5d766e (12 pass) is carried forward; not re-run. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `appendChained` catch | `EventBuffer.enqueue` | `bufferEvent` | ✓ WIRED | service.ts:3240-3259 (call at 3240; the waiting-behind path at 3207) |
| `drainEventBuffer` | `deliverBufferedInTurn` | `EventBuffer.drain` | ✓ WIRED | service.ts:3293 (`deliverBufferedInTurn`), 3299-3305 (`drainEventBuffer`), event-buffer.ts:297 (`drain`) |
| `deliverBuffered` | `insertEvent(…, { mayExist: true })` | direct call | ✓ WIRED | service.ts:3277; greptime.ts:1254-1268 |
| `drainPendingEvents` | `abandonAll` | `options.abandon && !durable` | ✓ WIRED | service.ts:3311-3317 (abandonAll at 3316); index.ts:260 |
| `abandonAll` | stderr identifier line | `reportHeldDeadLetters` | ✓ WIRED | event-buffer.ts:338 → :347-357; store passed at service.ts:2123 |
| `onDeadLetter` | `DeadLetterStore.record` | constructor closure | ✓ WIRED | service.ts:2118-2121 |
| `emit()` sync-lag hook | `corpusSlo.recordSyncLag` and `observer.syncLag` | stored, buffered or deadLettered result | ✓ WIRED | service.ts:3016-3019; observe.ts:399-401 |
| `health()` | `/healthz` body | spread | ✓ WIRED | service.ts:9020; server.ts:1001 |

### Data-Flow Trace (Level 4)

Not applicable to a UI. The buffered event's data path is the real `insertEvent` row write and the dead-letter file record, both traced in the artifact table. The sync-lag reading is set from the note's own `lag_s` (corpus/slo.ts:69-74), not a static value. No static fallback was found.

### Behavioral Spot-Checks

Not run in this pass (assignment forbids running tests). Evidence is the gate r36 JUnit. Each title below was checked against the JUnit with its exact text (XML entities decoded) and its `line` attribute; none has a `failure`, `error` or `skipped` child.

| Behavior | Title as in source (file:line) | JUnit | Status |
| -------- | ------------------------------ | ----- | ------ |
| Abandon records the in-flight entry at once (R-3) | 'abandoning the buffer during a delivery records the in-flight entry at once, so an exit before that delivery settles keeps it' (event-buffer.test.ts:245) | line 245 | ✓ PASS (r36) |
| An in-flight entry landing after abandon is recorded once | 'an in-flight entry that lands after the buffer was abandoned was recorded at the abandon, once' (event-buffer.test.ts:265) | line 265 | ✓ PASS (r36) |
| Abandon gives every entry up | 'abandoning the buffer gives every entry up with the abandoned reason' (event-buffer.test.ts:214) | line 214 | ✓ PASS (r36) |
| R-2 (`all` during a pass) | 'a drain with all during a running pass still delivers the entries that pass skipped as not yet due' (event-buffer.test.ts:226) | line 226 | ✓ PASS (r36) |
| Abandon report, unwritable store (held records on stderr, identifiers only) | 'abandonAll with a dead-letter file that cannot be written reports each held record on stderr as one JSON line of identifiers, never the summary' (event-buffer.test.ts:529) | line 529 | ✓ PASS (r36) |
| Abandon report, durable store (no identifier line) | 'abandonAll on a durable dead-letter store writes no identifier line to stderr' (event-buffer.test.ts:504) | line 504 | ✓ PASS (r36) |
| Full-buffer refusal with a failed record write | 'a give-up whose record write fails with a full buffer is refused, and the caller keeps its copy' (event-buffer.test.ts:457) | line 457 | ✓ PASS (r36); fake store, memory-only buffer |
| Service shutdown reports the held record once, no summary | 'a service that shuts down while a dead-letter file cannot be written reports each held record on stderr, and no summary text' (service-event-buffer.test.ts:234) | line 234 | ✓ PASS (r36) |
| SYNC-LAG (buffered docs.sync note sets the reading, lands once) | 'a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back' (service-event-buffer.test.ts:115) | line 115 | ✓ PASS (r36) |
| Keyed replay of a pending give-up is refused as a give-up | 'a keyed replay of a pending give-up is refused as a give-up, not answered as buffered, and appends nothing' (service-event-buffer.test.ts:391) | line 391 | ✓ PASS (r36) |
| Health body reports both depths | 'the health body reports the buffer&apos;s depth and the dead-letter depth, each with its durability' (service-event-buffer.test.ts:274) | line 274 | ✓ PASS (r36) |
| Boot refusal without a dead-letter path | 'a buffer with no dead-letter path refuses boot, and the message names the missing variable' (service-event-buffer.test.ts:286) | line 286 | ✓ PASS (r36) |
| Handoff surrogate refused before tip read | 'refuses a lone surrogate in the handoff summary before it reads the chain tip' (service.test.ts:1669) | line 1669 | ✓ PASS (r36) |
| Object-shape refusal of a greptime SQL reply (f0f3c04e) | 'a reply that is not an object is refused with the module error, not a TypeError' (greptime.test.ts:305). The same title also appears under linear.test.ts:152 and notion.test.ts:179; cite the file and line. | line 305 | ✓ PASS (r36) |
| Whole workspace at HEAD | gate r36: 12,317 testcases, 0 failures, 0 errors, 2 skipped | — | ✓ PASS (gate evidence, not rerun) |
| Every title in event-buffer.test.ts, service-event-buffer.test.ts, event-dead-letter.test.ts, greptime.test.ts, service.test.ts | checked by script against the JUnit | all present at their file:line, none failed or skipped | ✓ PASS (r36) |
| Not run here | tsc, lint, the full suite, `config:reference --check`, the orchestrator gate | not run, by assignment (gate r36 covers them at HEAD of its run) | ? SKIP |

Postgres evidence: none. No covered test file on this path gates on `SUBSTRATE_TEST_PG_URL`.

### Probe Execution

No conventional probes exist (`find scripts -path '*/tests/probe-*.sh'` returns none), and no PLAN declares one. Step 7c does not apply.

### Fingerprint

Computed at HEAD a46d42c3 with `gsd_run query verification.fingerprint .planning/phases/76-telemetry-buffer-and-dead-letter` over the 23 covered paths above: `v3:sha256:f9098cb697706863901114a5c88634835e4d64353fe7d2991d06acdefd8baabd`. Stable on a second run. The stored digest of the 6e5d766e record does not reproduce there (DIGEST-NOT-REPRODUCED-AT-BASE).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R3 | none | Bounded queue, backoff with jitter, durable dead-letter with payload and error, per-record dedupe, depth metrics, chain ordering, truthful acks | ORPHANED | REQUIREMENTS.md line 138 reads "Not started" at a46d42c3. 76-01-PLAN.md declares no `requirements:`. The delivered code covers most of the description: bounded buffer, backoff, dead-letter with the payload, `mayExist` dedupe, depths in /healthz, chain ordering through the per-session FIFO, and truthful `stored: false` replies. The dead-letter bound is not covered (override). |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| all phase 76 source, test and doc files | — | TBD / FIXME / XXX / TODO / HACK / PLACEHOLDER | none | Debt-marker scan over every added line of the ten covered files changed since 6e5d766e: 0 matches. |

### Human Verification Required

See the `human_verification` frontmatter: operator items 1 to 8 (live GreptimeDB outage, dead-letter exhaustion, torn-line restart, shutdown under the service manager, live steering session, live replay, the enablement decision, /healthz staleness), plus owner items 9 to 15: the handoff reorder ratification (W-L2-TIP-ORDER), the doc precision points, D76-13 (the dead-letter cap follow-up), the abandon report scope (ABANDON-REPORT-SCOPE), the D76-14 and D76-19 ratification, R-2's live confirmation, and HARD-R3 traceability.

### Gaps Summary

No blocking gap. Both roadmap truths are satisfied: SC1 within the owner-accepted pre-send scope, SC2 by owner override. The status is `human_needed` because the live items and the owner decisions above are open.

Residuals at a46d42c3:
- **Closed:** R-3 for the abandon path of a non-durable buffer (identifier line on stderr; 7a1d923a). R-3-UNSETTLED-AT-EXIT (49b9aece). SYNC-LAG-BUFFERED-NOT-RECORDED (b4bdd0fc, re-anchored). CORPUS-EVAL-DOC-SYNC-LAG-WORDING (884e0753 and bb6b38b7; withdrawn from the 6e5d766e record). R-2 (a0572cf7; live not observed; owner item 14).
- **Open (info):** R-3 for a held record behind a durable buffer, the refused-full-buffer branch (ABANDON-REPORT-SCOPE; owner item 12). The identifier-only report leaves the payload lost (ABANDON-STDERR-IDENTIFIERS-ONLY). ABANDON-RECORD-UNCHECKED, narrowed.
- **Operator item 4** keeps its live check: a durable buffer survives a SIGKILL mid-pass. Its stderr capture is added to the same item.
- Operator items 1 to 8 (live), kept as written.
- D76-15: operator decision to enable the buffer (item 7).
- D76-14 and D76-19: a buffered `session.end` closes steering before its note lands; PLAN says it should stay open. Owner ratification open (item 5; owner item 13).
- D76-13: dead-letter store unbounded under the override; cap is a tracked follow-up (owner item 11).
- R-1: live keyed replay after a dead-letter record. Code path tested (service-event-buffer.test.ts:391), live not (item 6).
- HARD-R3: orphaned in REQUIREMENTS.md; status line stale (owner item 15).
- Handoff tip read outside the session turn (info, `HANDOFF-TIP-OUTSIDE-TURN`). Not exercised.
- `KEYED-REPLAY-RESTATES-SYNC-LAG` corrected: a ledger-answered replay does not restate the gauge; a buffered or given-up replay does (info).
- `DOC-ABANDON-STDERR-AND-REFUSAL`: docs/greptime-ledger.md lines 1048-1049 (owner item 10).
- `DIGEST-NOT-REPRODUCED-AT-BASE`: the stored 6e5d766e digest does not reproduce with the current tool (orchestrator).

Deferred items (Step 9b): none taken. The dead-letter bound is an owner override, not a deferral to a later phase.

---

_Verified: 2026-11-06T00:48:32Z_
_Verifier: Claude (gsd-verifier, read-only draft)_
