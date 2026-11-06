---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-06T06:12:03Z
status: human_needed
score: "2/2 must-haves verified (SC1 VERIFIED within the owner-accepted pre-send scope, PLAN D76-10, with the buffer enabled per D76-15; SC2 PASSED by owner override, not verified). Re-verified at df31c749: both verdicts are unchanged. The one code change on this path, 6245863c (the buffer and dead-letter pair guard compares real destinations), is a recorded fix from review, not an owner decision; its three config tests are in source and have no run of record yet (passes in r43). The R-3, SYNC-LAG, CORPUS-EVAL and W-L2 residuals stand as at 5e304ef8. Every owner item stays open."
covered_files: [".env.example", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-PLAN.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-SUMMARY.md", "docs/config-reference.md", "docs/greptime-ledger.md", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/slo.ts", "packages/mcp-server/src/event-buffer.test.ts", "packages/mcp-server/src/event-buffer.ts", "packages/mcp-server/src/event-dead-letter.test.ts", "packages/mcp-server/src/event-dead-letter.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/handoff.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/linear.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/notion.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/reanchor-run.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/silent-failures.ts"]
covered_digest: "v3:sha256:f7f172448ae0d39aa6aa760f235a177532160d7f408f7758db2798313b478925"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag."
    reason: "Owner accepted the override on 2026-11-02. The dead-letter store is deliberately unbounded (plan decision D76-13): a bound would have to drop records, the silent loss this phase removes. The buffer is bounded by SUBSTRATE_EVENT_BUFFER_MAX, and the depth of both stores is reported in /healthz. A dead-letter cap is a tracked follow-up."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: "2/2 (prior record at 5e304ef8, verified 2026-11-06T02:58:33Z)"
  mode: "re-verification at df31c749 (branch gsd/v18-int-all, clean, read-only). Covered files changed since 5e304ef8: config.ts (6245863c, with config.test.ts, now cited here; the buffer and dead-letter pair guard compares destinations, following symlinks) and service.ts and service.test.ts (3ce87f63: brief index and signer-set pointer hunks, none on the emit, buffer, drain, shutdown, health or sync-lag path). cache.ts (0556dfd3), reconcile-read.ts and reconcile-repair.ts (d928e995), corpus (fd4a305f), host (7f6338c2) and the other range commits are not covered and not on a phase 76 path (see Changed Since the 5e304ef8 Record). Digest recomputed at df31c749 over 29 paths."
  gaps_closed:
    - "R-3 abandon path: a dead-letter record still held in memory when the buffer is abandoned is written to stderr as one identifier line (7a1d923a; event-buffer.ts:347-357, called from abandonAll at :338; wired by service.ts:2138). Unchanged at 5e304ef8."
    - "Buffer and dead-letter paths named one file through a symlink (6245863c): the same-file guard compared spellings, so a dead-letter path that reached the buffer file through a symlinked directory or a dangling symlink was accepted, and the buffer's next compaction (a rename over its path, event-buffer.ts:561-563) would have replaced the file with buffer entries alone. The guard now compares destinations (config.ts:2615; destinationOf at :2638). Closed in code; the config.test.ts titles are in source and their run passes in r43 (12,332 pass, 0 fail, 2 skip)."
  gaps_remaining: []
  regressions: []
residuals_closed:
  - id: R-3-UNSETTLED-AT-EXIT
    truth: "An entry given up by abandonAll() while its delivery is in flight is recorded at the abandon, so an exit before that delivery settles keeps its record."
    status: "CLOSED at 49b9aece, unchanged at 5e304ef8. abandonAll (event-buffer.ts:327-340) records every remaining entry at once, the in-flight one included; runDrain (event-buffer.ts:385-390) does not record it again when the delivery settles. Named tests, passing in gate r38 JUnit (line attributes match): 'abandoning the buffer during a delivery records the in-flight entry at once, so an exit before that delivery settles keeps it' (event-buffer.test.ts:245) and 'an in-flight entry that lands after the buffer was abandoned was recorded at the abandon, once' (event-buffer.test.ts:265). A duplicate on a late landing is at-least-once and detectable, per the owner decision in force."
  - id: R-3-HELD-RECORD-REPORTED-AT-ABANDON
    truth: "A dead-letter record held in memory when the buffer is abandoned is reported on stderr, with identifiers only, so the process's exit leaves a trace."
    status: "CLOSED for the abandon path of a non-durable buffer at 7a1d923a, unchanged at 5e304ef8, with two limits recorded as warnings: the report carries no payload (ABANDON-STDERR-IDENTIFIERS-ONLY), and it runs only when the buffer is not durable (ABANDON-REPORT-SCOPE). Named tests, gate r38 JUnit, no failure, error or skipped child: 'abandonAll with a dead-letter file that cannot be written reports each held record on stderr as one JSON line of identifiers, never the summary' (event-buffer.test.ts:529); 'abandonAll on a durable dead-letter store writes no identifier line to stderr' (event-buffer.test.ts:504); 'a service that shuts down while a dead-letter file cannot be written reports each held record on stderr, and no summary text' (service-event-buffer.test.ts:234). The title 'an unwritable dead-letter store reports each held record on stderr' is in neither the source nor the JUnit and is not cited."
  - id: SYNC-LAG-BUFFERED-NOT-RECORDED
    truth: "A stored docs.sync note updates the corpus sync-lag gauge (phase 70 SC3), and so does a docs.sync note the server took but did not store."
    status: "CLOSED at b4bdd0fc, re-anchored here, unchanged at 5e304ef8. The sync-lag hook (service.ts:3031-3034) runs on the stored, buffered and deadLettered branches of emit(), and reaches the gauge through the observer (service.ts:1076 SubstrateObserver.syncLag; observe.ts:398-400 calls instruments.setCorpusSyncLag). Named test 'a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back' (service-event-buffer.test.ts:115) passes in gate r38 JUnit with no skipped child. The deadLettered branch has no test of its own; it is code-verified only (service.ts:3031; deadLettered returns at :3186 and :3270)."
  - id: CORPUS-EVAL-DOC-SYNC-LAG-WORDING
    truth: "docs/corpus-eval.md describes when the sync-lag reading is set."
    status: "CLOSED at HEAD (884e0753 and bb6b38b7, outside this phase's covered list). docs/corpus-eval.md:105 says the gauge is set by each docs.sync note the server took (stored, held for a later write, or dead-lettered). Not re-read at 5e304ef8: the file is not covered."
warnings:
  - id: ABANDON-REPORT-SCOPE
    truth: "The stderr identifier report covers every held dead-letter record at shutdown."
    status: "OPEN (info; [INFERENCE] from code read; not exercised with a real DeadLetterStore and a durable buffer). drainPendingEvents calls abandonAll only when the buffer is not durable (service.ts:3331). With a durable buffer nothing is reported at exit. Most held records are backed by the buffer file: a given-up entry stays in the buffer as pending (dropFrom, event-buffer.ts:462-485; settlePending, :414-432), and hydrate reads it back. One is not: in enqueue (event-buffer.ts:259-284), when the buffer is full, onDeadLetter writes the new event's record (:267), the store keeps it in memory (record(), event-dead-letter.ts:107-127), and the event is refused with recorded false (:284). Its record is then held with no copy in the buffer, and a durable buffer exits without reporting it. The caller is told stored false (service.ts:3268-3270). The only test of this branch (event-buffer.test.ts:457) uses a fake store and a memory-only buffer."
  - id: ABANDON-STDERR-IDENTIFIERS-ONLY
    truth: "A record given up at shutdown keeps its event payload for an operator."
    status: "INFO. By design (event-buffer.ts:347-357: 'Never the payload or the summary'). The stderr line carries id, event_id, hash, reason, session_id and recorded_at. The payload is lost with the process unless the caller holds a copy. The report makes the loss visible, not recoverable. The owner decision in force, 'the in-flight event is recorded at shutdown', is met by the record, not by the line."
  - id: ABANDON-RECORD-UNCHECKED
    truth: "A dead-letter record taken at abandonAll() reaches the dead-letter file before the process exits."
    status: "NARROWED, still open, unchanged at 5e304ef8. abandonAll ignores the boolean that onDeadLetter returns (event-buffer.ts:336; service.ts:2133-2136 returns deadLetters.durable). A record that did not reach the file is reported on stderr at :338 when the store is not durable. It is still not on disk at exit."
  - id: DOC-ABANDON-STDERR-AND-REFUSAL
    truth: "docs/greptime-ledger.md describes the abandon report and the refused-event rule."
    status: "PARTLY CLOSED (doc; covered file; line 1048 edited in 5041193f, not by this verifier). Line 1048 now names the stderr identifier line (record id, event id, hash, reason, session id, recorded time; never the summary or payload). Its fields match event-buffer.ts:349-357. Two precision points remain for the owner (owner item 10): (a) its condition reads 'When the dead-letter file cannot be written at shutdown', but the report runs only when the buffer is not durable (service.ts:3331, then event-buffer.ts:348 for the store); a durable buffer reports nothing (ABANDON-REPORT-SCOPE). (b) Line 1049 still says 'When the buffer is full and nothing can be given up, the new event is refused with stored: false and nothing is recorded'. The enqueue code can hold a record for that event before refusing it (event-buffer.ts:267-284), so 'nothing is recorded' is not exact for that sub-case. [INFERENCE from code read]"
  - id: DIGEST-RECORDED-AT-HEAD
    truth: "The covered_digest in the frontmatter reproduces at the head the record names."
    status: "CLOSED for this record. covered_digest and covered_files are copied from gsd_run query verification.fingerprint at df31c749 (read-only), over the 28 covered paths of the 5e304ef8 record plus packages/mcp-server/src/config.test.ts, whose three tests this record now cites. The 5e304ef8 digest (v3:sha256:7b5b1433..., 28 paths) is superseded."
  - id: HANDOFF-TIP-OUTSIDE-TURN
    truth: "Chain-tip reads for a session run inside that session's turn, so no append interleaves with them."
    status: "OPEN (info, carried; re-anchored, unchanged at 5e304ef8). handoff() reads lastHash at service.ts:7750 outside any session turn; the emit at about :7774 reaches append (service.ts:3094, withSessionTurn) and then appendChained. A concurrent emit for the same session can land between the two, so the packet's prev_event_hash can differ from the stored event's prev. [INFERENCE from code read; not exercised.] The REST /handoff `to` refusal added in 14ac787a (server.ts:1507-1511) runs before rememberClaim and before the handoff call, so it adds no read and does not move this window."
  - id: KEYED-REPLAY-RESTATES-SYNC-LAG
    truth: "A keyed replay does not change the corpus sync-lag gauge (phase 70 SC3)."
    status: "OPEN (info; unchanged at 5e304ef8). A keyed replay answered from the ledger returns deduplicated: true (replayOutcome, service.ts:3145), and emit() returns before the sync-lag hook (service.ts:3007-3011). So a ledger-answered replay does not restate the gauge. A replay answered as buffered (service.ts:3183) or as given up (service.ts:3186) does reach the hook (3016-3019) and restates that note's lag. If a different session's docs.sync note has stored in between, the gauge reverts to the replayed note's lag. [INFERENCE from code read; not exercised.]"
  - id: R-2-DRAIN-ALL-DURING-PASS
    truth: "A drain with all during a running pass delivers the entries that pass skipped."
    status: "CLOSED in code (a0572cf7), unchanged at 5e304ef8 (event-buffer.ts:297-310 verified). Named test 'a drain with all during a running pass still delivers the entries that pass skipped as not yet due' (event-buffer.test.ts:226) passes in gate r38 JUnit with no skipped child. A live drain has not been observed; kept as owner/operator item 14."
  - id: OBS-SERVICE-APPEND-PROBE-DISCARDED (new, info)
    truth: "A failed append-mode probe on the emit path is reported, or its discard is stated, as the e62bc17b rule requires."
    status: "INFO, new at this re-verification. service.ts:3211 (appendChained) and service.ts:3286 (deliverBuffered) call greptime.ensureAppendMode().catch(() => null). The probe's error is not written to stderr and is not kept; the null becomes APPEND_MODE_UNKNOWN (service.ts:3213 and :3290). That is the outcome cited by operator item 1 (d) to (f), and the answer the criterion needs. The discard is not stated at either site. Neither line changed in the range (e62bc17b changed no service.ts line). No criterion cites the probe's cause. Not a gap; recorded so the owner can decide whether the cause should be reported at these two sites."
  - id: BUFFER-DEADLETTER-HARDLINK-ALIAS
    truth: "The buffer and dead-letter paths name two files, hard links included."
    status: "OPEN (info; [INFERENCE] from code read, not exercised). destinationOf follows symlinks only (config.ts:2638-2650). Two hard links to one inode pass the guard: realpath returns the same name for each link, and the guard does not compare inodes. The buffer's compaction renames a new file over its own path (event-buffer.ts:561-563), after which the two names point at different files. The commit claims symlinks only. A follow-up code change, not an owner decision."
  - id: BUFFER-DEADLETTER-GUARD-AT-LOAD
    truth: "The alias guard holds for the life of the process."
    status: "INFO. [INFERENCE] The guard runs once, in loadConfig (config.ts:2615), at boot. A link made while the process runs is not seen. No criterion cites this."
human_verification:
  - test: "Operator item 1. Live GreptimeDB rehearsal of the accepted outage limit: block the ledger and emit for one session; restore. Cover (a) a session whose tip is cached, first write fails; (b) that session's next write while the outage lasts; (c) a write for a session with no cached tip; (d) the same run with SUBSTRATE_LEDGER_CHAIN_CACHE=0, sessioned writes, including a write whose tip read succeeds and whose insert fails; (e) a sessionless write during the outage in a process that confirmed append-mode before the outage; (f) a sessionless write in a process whose first ledger contact is during the outage."
    expected: "(a) answers 503 with buffered true and stored false; /healthz eventBuffer.depth rises. (b) and (c) answer stored false with buffered absent, refused at the tip read (service.ts:3204-3207). (d) a sessioned write whose tip read fails is refused; one whose tip read succeeds and whose insert fails is buffered when append mode is confirmed; without that confirmation and without SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER=1|true|yes it is refused as APPEND_MODE_UNKNOWN before the insert (gate at service.ts:3211-3213). (e) is buffered. (f) is refused as APPEND_MODE_UNKNOWN unless the allow flag is set. After restore each buffered event lands once."
    why_human: "Needs a live GreptimeDB and a real outage. The sessionless and write-only clauses are code reads and fake-based tests, not live proofs."
  - test: "Operator item 2. Dead-letter exhaustion on a live outage (nominal budget 243 s; 195 to 292 s with jitter)."
    expected: "A dead-letter line is written with its hash (event-dead-letter.ts record(), hash from event.hash, :113) and the file mode is 0600 (event-dead-letter.ts:154-155). Boot refusal without SUBSTRATE_EVENT_DEAD_LETTER_PATH is covered by config.ts:2608-2613 and service-event-buffer.test.ts:286, not by this item."
    why_human: "Needs a live outage longer than the retry budget. Scratch probes wrote their own files, so 0600 on a service-written file was not exercised."
  - test: "Operator item 3. Restart during an outage with a durable file that may end in a torn line from a real crash."
    expected: "The next boot reports the depth, starts the drain timer, and drains each entry once. The torn line is counted as malformed and skipped (event-buffer.ts:508-519 counts parseStoredLine nulls; event-dead-letter.ts:193-243 counts them on read; event.ts:77 is the comment that says so). The next dead-letter write starts on a fresh line (event-dead-letter.ts:152-153). No record is lost."
    why_human: "The tests inject a torn line; a real partial write on a real disk is not reproduced."
  - test: "Operator item 4 (R-3 residual). Shutdown under the service manager: index.ts:261 drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true }), then service.ts:3326-3332."
    expected: "Finishes within the unit's stop bound with a durable buffer. The bounds stack (retain pass, event pass, transitions, flush) can exceed infra/vps/substrate-host.service TimeoutStopSec=15, so a SIGKILL mid-pass is possible; confirm that a durable buffer survives it. A non-durable buffer's in-flight entry is recorded at the abandon (R-3-UNSETTLED-AT-EXIT), and each held record is reported on stderr as identifiers (R-3-HELD-RECORD-REPORTED-AT-ABANDON). Confirm the stderr lines are captured by the service manager's journal."
    why_human: "Needs the real service manager, a durable buffer file under a stop, and a non-durable run to see the stderr lines."
  - test: "Operator item 5 (D76-14, D76-19). Buffered session.end on a live steering session."
    expected: "The session closes first (service.ts:2295 liveSessions.close, :2297 steeringWaiters.closeSession, then the emit at :2298, wrapped at :2298-2301), so steering is closed whether or not the note lands. The code does not keep the session open until the note lands, as PLAN D76-14 and D76-19 say; docs/greptime-ledger.md describes the code."
    why_human: "Needs a live steering session and the owner's ratification of the behaviour."
  - test: "Operator item 6 (R-1). Keyed replay after a dead-letter record on a live collector spool."
    expected: "Confirm which trigger occurs: one new row with a new id (the dead-letter record is orphaned, the common case), or two rows. The replay of a pending give-up is code-verified (service.ts:3176-3186; service-event-buffer.test.ts:391, passing in gate r38); the live replay after the record has left the buffer is not."
    why_human: "Needs a live collector spool and ledger."
  - test: "Operator item 7 (D76-15). Operator decision to enable the buffer."
    expected: "SC1 holds with SUBSTRATE_EVENT_BUFFER_PATH and SUBSTRATE_EVENT_DEAD_LETTER_PATH set (config.ts:2606-2620 refuses boot when only the buffer path is set). With the buffer unset, a failed write answers stored false and nothing is queued (config.ts:2607 returns null)."
    why_human: "Configuration and policy decision, not code-verifiable."
  - test: "Operator item 8. /healthz staleness."
    expected: "The body is memoised for SUBSTRATE_HEALTHZ_CACHE_MS (default 5000, config.ts:1218; memo in server.ts:984-1001). Pollers see a depth change within that window."
    why_human: "Needs a running server and a poller."
  - test: "Owner item 9 (W-L2-TIP-ORDER, handoff). Commit a9e477e2 moved handoff()'s text refusal and graph-id check before placeOf and lastHash, as the recorded W-L2 rule requires (service.ts:7732-7740, before :7741 and :7750). The owner confirms this as the decided behaviour and records it."
    expected: "The owner records the ratification in ROADMAP.md or the phase record. If the owner wants a different rule, the handoff path is the only one affected. ROADMAP.md:1317 still lists 'handoff() reads the tip before its emit (W-L2-TIP-ORDER, owner decision)' as open."
    why_human: "An owner decision on write ordering; no verifier can supply it."
  - test: "Owner item 10 (doc precision, docs/greptime-ledger.md). (1) The replay-effect sentence ('a keyed replay answered from the ledger ... appends no event') is accurate for agent_events only; the event_ingest repair write is not named. (2) The cache-off sentence 'every session write reads the tip first' does not name a sessioned write refused for a lone surrogate, which is refused before the read. ROADMAP.md:1317 records 'The cache-off wording is ratified (owner, 2026-11-03) and matches the code'; the owner says whether that ratification covers this point. (3) Line 1049 'nothing is recorded' does not cover a record held for an event refused on a full buffer (DOC-ABANDON-STDERR-AND-REFUSAL b). (4) Line 1048 now names the stderr identifier line (5041193f), but its condition ('when the dead-letter file cannot be written at shutdown') does not say that a durable buffer reports nothing (DOC-ABANDON-STDERR-AND-REFUSAL a)."
    expected: "The owner confirms or amends each sentence and records the decision. Doc edits are for the owner of that file."
    why_human: "A ratification is an owner decision; no verifier can supply it."
  - test: "Owner item 11 (D76-13). The dead-letter store is unbounded by plan decision, with an accepted override (2026-11-02). A dead-letter cap is a tracked follow-up."
    expected: "The owner confirms the follow-up is tracked, with its owner and phase, and that an unbounded dead-letter store is accepted until then. Depth is reported on /healthz (service.ts:9047)."
    why_human: "A scope decision, recorded in the override. No verifier can supply it."
  - test: "Owner item 12 (ABANDON-REPORT-SCOPE). Decide whether a held dead-letter record must be reported at shutdown when the buffer is durable, and whether the identifier-only stderr line (no payload) is the accepted form of R-3."
    expected: "Either the owner accepts both limits and records it, or asks for a change to drainPendingEvents (service.ts:3331) to report held records on every shutdown. Any change is a new code change, not part of this record."
    why_human: "An owner decision on what an exit must leave behind. The code path is read, not exercised."
  - test: "Owner item 13 (D76-14 and D76-19 ratification). A buffered session.end closes steering before its note lands; PLAN says the session should stay open until the note lands."
    expected: "The owner records whether the closing order stands, and docs/greptime-ledger.md is updated to match if so."
    why_human: "An owner decision on the session boundary; no verifier can supply it."
  - test: "Owner item 14 (R-2). The 'all' follow-up pass for entries a running pass skipped (event-buffer.ts:297-310; test at event-buffer.test.ts:226) is closed in code (a0572cf7). The owner or operator confirms it on a live drain."
    expected: "A live drain of an entry that was not yet due at the start of a running pass is delivered once, and the buffer is empty afterward."
    why_human: "Needs a live drain under load. The named test passes in gate r38; a live run is not observed."
  - test: "Owner item 15 (HARD-R3). No plan claims it. REQUIREMENTS.md still reads 'Not started'."
    expected: "The owner either maps HARD-R3 to 76-01 and updates its status, or records why it stays orphaned. REQUIREMENTS.md:138 still reads 'Not started' at 5e304ef8 (checked). ROADMAP.md:1317 describes R-3 as closed for a non-durable buffer, so the two files now disagree on R-3."
    why_human: "Traceability is an owner decision."
---

# Phase 76: Telemetry buffer and dead-letter Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently. (ROADMAP.md, Phase 76)

**Verified:** 2026-11-06T06:12:03Z
**Status:** human_needed
**Re-verification:** Yes. Prior record at 5e304ef8 (verified 2026-11-06T02:58:33Z). Since then config.ts and config.test.ts changed (6245863c, the alias guard), and service.ts and service.test.ts changed (3ce87f63, outside the phase 76 path). The SC1 and SC2 verdicts are carried forward with the hunk checks in the Changed Since the 5e304ef8 Record section. Correction to the 5e304ef8 record: its table cites `append` at :2988, but :2988 is `emit`; `append` is at :3084 (:3069 at 5e304ef8). The table row is corrected here.
**Worktree / HEAD:** `/root/src/worktrees/as-gsd-v18-all` (branch gsd/v18-int-all) at df31c749, clean at the start of this pass (`git status --short` empty). The fingerprint was computed at HEAD by `gsd_run query verification.fingerprint` (read-only) and copied verbatim into the frontmatter.
**Line references:** Re-anchored at df31c749. Shift rule from `git diff -U0 5e304ef8 df31c749`: `service.ts` old lines 850-876 move +13, 877-886 +14, 887-6920 +15, and 6921 on +27; `config.ts` old lines 9-2628 move +1 and 2629 on +29; `service.test.ts` old line 1669 is now 1673. Every `service.ts` and `config.ts` cite in this record was checked: the old line text at 5e304ef8 matches the mapped df31c749 line. Unchanged since 5e304ef8: `event-buffer.ts`, `event-dead-letter.ts`, `observe.ts`, `silent-failures.ts`, `greptime.ts` (including the comments at :1998 and :2236), `event.ts` (:77), `index.ts` (:261) and `server.ts` (:1591, :1626, :2806-2807).
**Tests:** Not run here (assignment forbids test runs). Test evidence is the gate r38 JUnit at `/root/src/worktrees/backups/gate-r38-junit.xml`, which ran on 66fa97bd: 12,322 testcases, 1 failure (`repository ratchet`, 'the ratchet is tight: no source counter sits below its baseline'; the brief says this is fixed at the code head and it is not among the titles cited here), 2 skipped (neither is cited here). The JUnit records no commit. Each cited title in a file unchanged since 5e304ef8 was checked against the JUnit by file, name and `line` attribute, and against the source. The run of record for this head is gate r43, which writes `/root/src/worktrees/backups/gate-r43-junit.xml` when it finishes; it was not present at this writing, and this record cites its passing titles. The three config.test.ts titles added by 6245863c are in no JUnit yet: they are cited as present in source, passes in r43.

## Goal Achievement

### Observable Truths

| #   | Truth   | Status     | Evidence       |
| --- | ------- | ---------- | -------------- |
| 1   | SC1: A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash. | ✓ VERIFIED (within the owner-accepted pre-send scope, D76-10; with the buffer enabled, D76-15) | Write failure → `appendChained` catch (service.ts:3235-3255) → `bufferEvent` (call sites service.ts:3222 and 3255; definition 3263). Bound: `EventBuffer.enqueue` evicts or refuses past `max` (event-buffer.ts:238-290). Backoff: base×2^n capped, ±20 % jitter (event-buffer.ts:40-44). Ceiling: `runDrain` (event-buffer.ts:362-402) dead-letters with `exhausted` at `attempts >= maxAttempts` (`dropFrom`, :462). Record: `DeadLetterStore.record` writes `event_hash` (event-dead-letter.ts:107-127, hash at :113). Retries use `insertEvent(event, { mayExist: true })` (service.ts:3292). Nothing changed in these lines in the range: the diff for event-buffer.ts and event-dead-letter.ts is export keywords only. |
| 2   | SC2: Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag. | ✓ PASSED (override), not verified | `health().eventBuffer` is `{ enabled: false }` when off, else `{ enabled: true, ...stats, deadLetter: { depth, durable } }` (service.ts:9047, unchanged). `server.ts` spreads `health` into the `/healthz` body (server.ts:1001, unchanged; `/healthz` at :984). Buffer bound by `SUBSTRATE_EVENT_BUFFER_MAX` (config.ts:2624, default 256 from event-buffer.ts:29). Dead-letter store is not bounded (D76-13; event-dead-letter.ts:11-12). Named passes in gate r38 JUnit: 'the health body reports the buffer's depth and the dead-letter depth, each with its durability' (service-event-buffer.test.ts:274); 'a buffer with no dead-letter path refuses boot, and the message names the missing variable' (service-event-buffer.test.ts:286). |

**Score:** 2/2 truths counted (1 VERIFIED, 1 PASSED by override). behavior_unverified: 0. Warnings below do not change the score.

### Abandon Path Re-audit (7a1d923a, re-checked at df31c749; no change to these paths since 5e304ef8)

Trace, at 5e304ef8:

1. Shutdown: `index.ts:261` runs `drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })` inside `server.close`, before the flush and `process.exit(0)`.
2. `drainPendingEvents` (service.ts:3326-3332) runs one bounded `drainEventBuffer({ all: true })`, stops the periodic drain, and calls `abandonAll()` only when `!stores.buffer.durable` (service.ts:3331).
3. `abandonAll` (event-buffer.ts:327-340) removes every entry, then for each entry not already pending sets `given_up = "abandoned"` and calls `onDeadLetter` (:336). An in-flight entry is included (R-3-UNSETTLED-AT-EXIT). A pending entry is not recorded again: its record is already with the store.
4. `reportHeldDeadLetters` (event-buffer.ts:347-358, called at :338) returns at once when the store is durable (:348). Otherwise it writes one JSON line per record in `heldRecords()` (event-dead-letter.ts:96-99): `id`, `event_id`, `hash`, `reason`, `session_id`, `recorded_at`. No payload and no summary. `heldRecords()` covers every record not yet on the file, pending entries included.
5. The service wires the store into the buffer (service.ts:2125-2138, `deadLetters,` at :2138; `onDeadLetter` at :2133-2136).

What is covered:
- An in-flight entry given up at shutdown, while its record is held, is reported (test event-buffer.test.ts:529 covers the held case with two entries; the in-flight case is covered in code by the same path).
- A held record for a pending entry is reported, because the report reads the store, not the buffer.
- A durable store writes no identifier line (event-buffer.test.ts:504; the test also asserts the store's own `[substrate] event ` line is the only stderr output).
- At service level, one JSON line for the `exhausted` record and no summary text (service-event-buffer.test.ts:234; the test spies on `process.stderr.write` for the single `drainPendingEvents` call and parses every write as JSON, so any other stderr write in that window would fail it).

What is not covered (recorded as warnings, not as a score change):
- **ABANDON-REPORT-SCOPE** (open, info). A durable buffer skips `abandonAll`, so nothing is reported at exit. Held records behind a durable buffer are backed by the buffer file when they belong to a pending entry. The exception is the full-buffer refusal: `enqueue` writes the new event's record (event-buffer.ts:267), the store holds it when the file write fails, and the event is refused with `recorded: false` (:284). That record has no copy in the buffer and is not reported at exit. The only test of this branch (event-buffer.test.ts:457) uses a fake store and a memory-only buffer. [INFERENCE from code read.]
- **ABANDON-STDERR-IDENTIFIERS-ONLY** (info, by design). The payload of an abandoned event is lost with the process unless the caller holds a copy. The report makes the loss visible; it does not make it recoverable.
- **ABANDON-RECORD-UNCHECKED** (narrowed). `abandonAll` still ignores the boolean from `onDeadLetter` (:336). A record not on the file is reported at :338 when the store is not durable.

Result: R-3 is closed for the abandon path of a non-durable buffer. The durable-buffer refusal case is open as an info item for the owner (owner item 12).

### Changed Since the 5e304ef8 Record

`git diff 5e304ef8 df31c749` on the covered paths: four files changed. `config.ts` and `config.test.ts` (6245863c; `config.test.ts` is added to the covered list because this record now cites its titles), `service.ts` and `service.test.ts` (3ce87f63). Each hunk was read.

| File | Commit | Hunk (df31c749 line) | Phase 76 effect |
| ---- | ------ | -------------------- | --------------- |
| `packages/mcp-server/src/config.ts` | 6245863c | :8 import (`readlinkSync`, `realpathSync`, `basename`, `dirname`, `join`); :2615 guard now `destinationOf(path) === destinationOf(deadLetterPath)` (was `resolve(path) === resolve(deadLetterPath)`); :2632 `MAX_LINK_HOPS`, :2638 `destinationOf`, :2651 `linkTargetOf` (new) | Changes the load-time same-file check only. A dead-letter path that reaches the buffer file through a symlinked directory or a dangling symlink is now refused with the existing message ("name one file"); distinct files are accepted. The missing-path refusal (:2608-2613), the buffer settings and every runtime path of SC1 and SC2 are unchanged. Verdicts unchanged. A recorded fix from review, not an owner decision. |
| `packages/mcp-server/src/config.test.ts` | 6245863c | :867-911, one `describe` with three tests | Cited in the Behavioral Spot-Checks table. Not in gate r38. Pending gate r43. |
| `packages/mcp-server/src/service.ts` | 3ce87f63 | :850-862 `namedBySignerSet` (new); :888-920 `judgePointer` and `readPointerChecks` (signer-set rule and comment); :2595 brief compose takes `this.briefIndex(request.surface)`; :6936-6947 `briefIndex` (new) | None on the phase 76 path. No line changed in `emit` (:3003), `append` and `appendChained` (:3084, :3165), the buffer and deliver path (:3263-3282), drain and shutdown (:3314-3334), sync-lag (:3031-3034) or health (:9047). The anchors move as stated in Line references. |
| `packages/mcp-server/src/service.test.ts` | 3ce87f63 | :2-3 and :16 imports; test blocks added at :6030 and :6401 | Test additions only. The phase 76 title moves from :1669 to :1673; its body is unchanged. |

Checked and not on the phase 76 path: `packages/mcp-server/src/cache.ts` (0556dfd3, `MAX_SCAN_ROUNDS` in `scanKeys`). Its callers are reconcile only (`reconcile-run.ts:87`, `:89`; `reconcile-repair.ts:129`, `:270`). `health()` (service.ts:9047) reads the buffer stats and the dead-letter depth and does not scan, so 0556dfd3 is off the health path and is not re-verified here. Also off the path: `reconcile-read.ts` and `reconcile-repair.ts` (d928e995), `corpus/service.ts` and `corpus/ingest.ts` (fd4a305f), `host` files (7f6338c2), `dispatcher/tests/test_worktree.py` (df31c749), `skills/propose.ts` (e2e4cba4), `packages/cli/src/index.ts` (4ac770af), and docs and verification records (4637a9b7, 700d9b5c, b577f5be, cebd76df). None of the covered docs, `.env.example`, `flag-registry.ts`, `silent-failures.ts`, `observe.ts`, `corpus/slo.ts` or the phase 76 PLAN and SUMMARY changed in the range.


### Changed Since the a46d42c3 Record (earlier re-verification, kept for history)

`git diff a46d42c3 5e304ef8 -- <23 record paths + 5 cited paths>`: thirteen files changed. Each hunk was read; the export-keyword-only pairs were filtered out mechanically (a `-` line whose only difference from its `+` line is the removed `export ` keyword), and every remaining hunk is listed here.

| File | Commit | Hunk (5e304ef8 line) | Phase 76 effect |
| ---- | ------ | -------------------- | --------------- |
| `docs/greptime-ledger.md` | 5041193f | :1048 (Durability bullet) now names the stderr identifier line. :1049 unchanged. | See DOC-ABANDON-STDERR-AND-REFUSAL: partly closed. |
| `packages/mcp-server/src/event.ts` | e62bc17b | :77, a comment in `parseStoredLine`'s catch: 'A line that is not JSON is counted as malformed by its caller (event-buffer.ts, event-dead-letter.ts), not reported here.' | Matches the code. The callers count the null: event-buffer.ts:508-519 and event-dead-letter.ts:193-243 (each writes one `skipped N malformed line(s)` line). No code change. |
| `packages/mcp-server/src/greptime.ts` | e62bc17b | :1998 (comment in `ping`'s catch) and :2236 (comment before `probeDialect` in `exportWindow`). | Comments only. `ping` and `exportWindow` are not on a phase 76 criterion path. Lines before 1998 are unchanged, so the `sql()` shape check (922-934), `insertEvent` (1254), `eventRowPresent` (1305) and `lastHash` (1489) keep their anchors. |
| `packages/mcp-server/src/index.ts` | e62bc17b | :50 import of `reportSilent`; :273 `exporter.flush().catch(… reportSilent("shutdown.exporter-flush"…))`. | The shutdown exporter flush is not a phase 76 path. The phase 76 shutdown call is unchanged at :261 (was :260). |
| `packages/mcp-server/src/server.ts` | 14ac787a | :1507-1511, a new 400 for `/handoff` when `body.to` is set and is not in SURFACES, before `rememberClaim` and before the handoff call. | No phase 76 criterion cites `/handoff`. The refusal writes nothing and reads no tip, so the HANDOFF-TIP-OUTSIDE-TURN window and the W-L2 order are unchanged. Not re-run. |
| `packages/mcp-server/src/service.ts` | 0947001e | :6436, `manifestCommit` now returns the row, not its `.commit`. | Phase 63 docs-search path. Not on phase 76. Checked only for this hunk. |
| `packages/mcp-server/src/config.ts`, `event-buffer.ts`, `event-dead-letter.ts`, `flag-registry.ts`, `greptime.ts`, `handoff.ts`, `mcp.ts`, `reanchor-run.ts`, `server.ts`, `service.ts`, `event.ts` | b8cbdeac; config.ts also 5e304ef8 | Export keyword removed from self-only declarations. No other change. | None. The removed names used elsewhere are checked by grep: `event.test.ts` refers to `GraphIdLoneSurrogateError` and `RepoTooLongError` only as strings in `constructor.name` assertions (event.test.ts:368, :396); `handoff.test.ts` and `server.test.ts` import only names that are still exported (HANDOFF_ALG, STREAM_BATCH). |

Line anchors that moved: `index.ts` (+1, :260 → :261) and `server.ts` (+5 after :1507; `/drift` check now :1591, `/verify` check now :1626, handleMcp close catch :2806-2807). Anchors cited for SC1 and SC2 in `event-buffer.ts`, `event-dead-letter.ts`, `service.ts`, `config.ts`, `greptime.ts` (before 1998), `server.ts` (before 1507) and `mcp.ts` are unchanged.

Changed in the range but not on this record's covered list: `packages/mcp-server/src/cache.ts` (f1266a9c; the cooldown refusal changes the error class only, and no SC1 or SC2 path changed, see Truth 1), `packages/mcp-server/src/memory-retain.ts` and `index-sweep.ts` (a2176f96; behaviour unchanged), `packages/cli/src/index.ts` (14ac787a; CLI handoff exit code, not a Phase 76 path). `packages/mcp-server/src/silent-failures.ts` (e62bc17b changed no line of it) is cited here, so it is covered now.

### W-L2 Write-Path Ordering (re-checked at df31c749)

Question: does the surrogate refusal of the six write text fields, and the graph id check, happen before any chain-tip read, buffer or insert on a sessioned write?

| Write shape | Refusal reached at | Tip read before refusal? | Verdict |
| ----------- | ------------------ | ------------------------ | ------- |
| Keyed, replay lookup, via `emit` | service.ts:3167 (`assertWriteTextFields`), 3169 (`normalizeGraphId`), before `replayOutcome` (call at 3176) | No | ✓ refused before lookup, tip, buffer, insert |
| Sessioned, via `emit` / `appendChained`, keyed or unkeyed | service.ts:3167, 3169, before `lastHash` at 3195 | No | ✓ CONFIRMED (named test in gate r38; code unchanged in this range) |
| Sessionless, keyed or unkeyed | service.ts:3167 | No tip read exists | ✓ |
| Sessioned, via `handoff()`, then `emit` | service.ts:7732 (`normalizeGraphId(probe.graph_id)`) and the `assertWriteTextFields` call at 7733-7740, before `placeOf` (7741) and `lastHash` (7750) | No | ✓ CONFIRMED (test "refuses a lone surrogate in the handoff summary before it reads the chain tip", service.test.ts:1673, gate r38 JUnit, no skipped child) |

Coverage note (info): `handoff()` runs its refusal on the probe built from the caller's input. A `repo` that the place lookup fills in (`place.repo`, service.ts:7741) is not in the probe. That value comes from a graph row written under the same rules, so it cannot hold a lone surrogate. [INFERENCE]

Result: the W-L2 rule holds for every sessioned write path. The W-L2-TIP-ORDER warning is closed in code. Ratification is owner item 9. ROADMAP.md:1317 still lists it as an owner decision.

### Doc Wording Check (docs/greptime-ledger.md)

The wording verdicts from the a46d42c3 record stand, except for the changes below.

| Point | Doc says | Code | Verdict |
| ----- | -------- | ---- | ------- |
| Flag values, sessioned clause | `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` set to `1`, `true` or `yes`; `SUBSTRATE_LEDGER_CHAIN_CACHE=0` turns the cache off | config.ts accepts `1\|true\|yes`; cache off for `0\|false\|no`. Gate at service.ts:3211-3213. | **Confirmed**, unchanged. |
| Replay appends no event | "a keyed replay answered from the ledger before the tip read appends no event" | Replay lookup at service.ts:3176 (`replayOutcome`), before the tip read. An ingest-membership repair write can still happen. | **Accurate for `agent_events` only.** Owner item 10. |
| Cache-off, sessionless and uncached-session clauses | A session with no cached tip during an outage is refused at the tip read; a sessionless write reads no tip | `chainTips` null when the switch is off. `lastHash` only when `sessionId` is set. | **Confirmed by code read**, unchanged. Live outage not exercised (operator item 1). ROADMAP.md:1317 records the cache-off wording as ratified by the owner on 2026-11-03. |
| Cache-off, "every session write reads the tip first" | As above | A sessioned write with a lone surrogate is refused before the read. | **Precision point for the owner** (owner item 10). Not an edit. |
| Durability sentence (line 1048) | "A buffer that is not durable gives its entries up as `abandoned`, each with a record … When the dead-letter file cannot be written at shutdown, each held record is reported on stderr as one JSON line of identifiers …" | The stderr line exists (event-buffer.ts:347-358) and its fields match. It runs only when the buffer is not durable (service.ts:3331). | **Named now (5041193f).** Condition precision point for the owner (owner item 10 (4)). |
| Refusal sentence (line 1049) | "the new event is refused with `stored: false` and nothing is recorded" | Not exact for a record held for a refused event (event-buffer.ts:267-284). | **Doc precision point** (owner item 10 (3)). Unchanged. |

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-buffer.ts` | Bounded per-session FIFO, backoff, drop causes, in-flight protection, file persistence, abandon report | ✓ VERIFIED | Changed at a0572cf7, 49b9aece (`abandonAll` records the in-flight entry at once) and 7a1d923a (`reportHeldDeadLetters`, :347-358). Range change: export keywords only (b8cbdeac). Wired from service.ts:2126. Named tests in gate r38 JUnit (Abandon Path Re-audit; R-2 test at :226). |
| `packages/mcp-server/src/event-dead-letter.ts` | Append-only JSONL dead-letter store with hash, reason, depth, durability, held-record copy | ✓ VERIFIED | `heldRecords()` added at 7a1d923a (:96-99). Wired from service.ts:2125. 0600 on create and on append (:154-155). Range change: export keywords only. |
| `packages/mcp-server/src/event.ts` | Stored-line parse that counts a malformed line as null | ✓ VERIFIED | `parseStoredLine` at :72. Range change: a comment at :77 and export keywords. |
| `packages/mcp-server/src/service.ts` | Turn helper, buffering, drain, health, shutdown, sync-lag at emit | ✓ VERIFIED | `emit` 3003, `append` 3084 (turn at :3094; `append` was misnamed as 2988 at 5e304ef8, which is `emit`), `appendChained` 3165, `bufferEvent` 3263, `deliverBuffered` 3282, `drainPendingEvents` 3326, `ensureEventDrainTimer` 3334, sync-lag hook 3031-3034, `eventBuffer` in health 9047. Range change: export keywords and the phase 63 `manifestCommit` line (:6436). 3ce87f63 adds the signer-set and brief-index hunks at :850-920, :2595 and :6936-6947; no emit-path, buffer, drain, shutdown or health line changed. |
| `packages/mcp-server/src/greptime.ts` | `insertEvent(event, { mayExist })`; `sql()` reply shape | ✓ VERIFIED | `insertEvent` 1254; `mayExist` path 1268. `sql()` checks at 922-934 (f0f3c04e); its test at greptime.test.ts:305 passes in gate r38. Range change: two comments (:1998, :2236) and export keywords. |
| `packages/mcp-server/src/config.ts` | Six flags, boot refusal when the dead-letter path is missing | ✓ VERIFIED | config.ts:2601-2628. Range change: export keywords only (b8cbdeac, 5e304ef8); 6245863c adds the destination guard at :2615 and the `destinationOf` helpers at :2632-2657 (see Changed Since). |
| `packages/mcp-server/src/index.ts` | Shutdown calls `drainPendingEvents` with `abandon` | ✓ VERIFIED | index.ts:261 (was :260, +1 import). Range change: the import and the exporter-flush `reportSilent` (shutdown path, not phase 76). |
| `packages/mcp-server/src/server.ts` | `/healthz` spreads `health()`; `/events` reaches `emit` | ✓ VERIFIED | `/healthz` 984-1001 (spread at :1001). `/events` calls `substrate.emit` at :1358. Range change: the REST `/handoff` `to` refusal (:1507-1511). |
| `packages/mcp-server/src/observe.ts` | Observer routes the sync-lag reading to the gauge | ✓ VERIFIED | `syncLag` at :398-400 calls `instruments.setCorpusSyncLag`. Unchanged in range. Cited here, so it is now covered. |
| `packages/mcp-server/src/silent-failures.ts` | `reportSilent`: one stderr line per site per process, code only | ✓ VERIFIED | Cited by index.ts:50 and :273. Unchanged in range. Writes `[substrate] <site> failed (<code>)`; never the message. |
| `packages/mcp-server/src/flag-registry.ts`, `.env.example`, `docs/config-reference.md` | Six flags documented | ✓ VERIFIED | Range change: export keywords only (flag-registry.ts, b8cbdeac). The `scripts/config-reference.test.ts` run at 6e5d766e (12 pass) is carried forward; not re-run. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `appendChained` catch | `EventBuffer.enqueue` | `bufferEvent` | ✓ WIRED | service.ts:3255-3274 (call at 3255; the waiting-behind path at 3222) |
| `drainEventBuffer` | `deliverBufferedInTurn` | `EventBuffer.drain` | ✓ WIRED | service.ts:3308 (`deliverBufferedInTurn`), 3314-3320 (`drainEventBuffer`), event-buffer.ts:297 (`drain`) |
| `deliverBuffered` | `insertEvent(…, { mayExist: true })` | direct call | ✓ WIRED | service.ts:3292; greptime.ts:1254-1268 |
| `drainPendingEvents` | `abandonAll` | `options.abandon && !durable` | ✓ WIRED | service.ts:3326-3332 (abandonAll at 3331); index.ts:261 |
| `abandonAll` | stderr identifier line | `reportHeldDeadLetters` | ✓ WIRED | event-buffer.ts:338 → :347-358; store passed at service.ts:2138 |
| `onDeadLetter` | `DeadLetterStore.record` | constructor closure | ✓ WIRED | service.ts:2133-2136 |
| `emit()` sync-lag hook | `corpusSlo.recordSyncLag` and `observer.syncLag` | stored, buffered or deadLettered result | ✓ WIRED | service.ts:3031-3034; observe.ts:398-400 |
| `health()` | `/healthz` body | spread | ✓ WIRED | service.ts:9047; server.ts:1001 |

### Data-Flow Trace (Level 4)

Not applicable to a UI. The buffered event's data path is the real `insertEvent` row write and the dead-letter file record, both traced in the artifact table. The sync-lag reading is set from the note's own `lag_s` (corpus/slo.ts:69-74), not a static value. No static fallback was found.

### Behavioral Spot-Checks

Not run in this pass (assignment forbids running tests). Evidence is the gate r38 JUnit. Each title below was checked by file, name and `line` attribute, and against the source line; none has a `failure`, `error` or `skipped` child.

| Behavior | Title as in source (file:line) | JUnit | Status |
| -------- | ------------------------------ | ----- | ------ |
| Abandon records the in-flight entry at once (R-3) | 'abandoning the buffer during a delivery records the in-flight entry at once, so an exit before that delivery settles keeps it' (event-buffer.test.ts:245) | line 245 | ✓ PASS (r38) |
| An in-flight entry landing after abandon is recorded once | 'an in-flight entry that lands after the buffer was abandoned was recorded at the abandon, once' (event-buffer.test.ts:265) | line 265 | ✓ PASS (r38) |
| Abandon gives every entry up | 'abandoning the buffer gives every entry up with the abandoned reason' (event-buffer.test.ts:214) | line 214 | ✓ PASS (r38) |
| R-2 (`all` during a pass) | 'a drain with all during a running pass still delivers the entries that pass skipped as not yet due' (event-buffer.test.ts:226) | line 226 | ✓ PASS (r38) |
| Abandon report, unwritable store (held records on stderr, identifiers only) | 'abandonAll with a dead-letter file that cannot be written reports each held record on stderr as one JSON line of identifiers, never the summary' (event-buffer.test.ts:529) | line 529 | ✓ PASS (r38) |
| Abandon report, durable store (no identifier line) | 'abandonAll on a durable dead-letter store writes no identifier line to stderr' (event-buffer.test.ts:504) | line 504 | ✓ PASS (r38) |
| Full-buffer refusal with a failed record write | 'a give-up whose record write fails with a full buffer is refused, and the caller keeps its copy' (event-buffer.test.ts:457) | line 457 | ✓ PASS (r38); fake store, memory-only buffer |
| Service shutdown reports the held record once, no summary | 'a service that shuts down while a dead-letter file cannot be written reports each held record on stderr, and no summary text' (service-event-buffer.test.ts:234) | line 234 | ✓ PASS (r38) |
| SYNC-LAG (buffered docs.sync note sets the reading, lands once) | 'a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back' (service-event-buffer.test.ts:115) | line 115 | ✓ PASS (r38) |
| Keyed replay of a pending give-up is refused as a give-up | 'a keyed replay of a pending give-up is refused as a give-up, not answered as buffered, and appends nothing' (service-event-buffer.test.ts:391) | line 391 | ✓ PASS (r38) |
| Health body reports both depths | 'the health body reports the buffer's depth and the dead-letter depth, each with its durability' (service-event-buffer.test.ts:274) | line 274 | ✓ PASS (r38) |
| Boot refusal without a dead-letter path | 'a buffer with no dead-letter path refuses boot, and the message names the missing variable' (service-event-buffer.test.ts:286) | line 286 | ✓ PASS (r38) |
| Handoff surrogate refused before tip read | 'refuses a lone surrogate in the handoff summary before it reads the chain tip' (service.test.ts:1673) | r38 line 1669; source line now 1673 | ✓ PASS (r38) |
| Object-shape refusal of a greptime SQL reply (f0f3c04e) | 'a reply that is not an object is refused with the module error, not a TypeError' (greptime.test.ts:305). The same title also appears under linear.test.ts:152 and notion.test.ts:179; cite the file and line. | line 305 | ✓ PASS (r38) |
| Dead-letter path through a symlinked directory refused at load (6245863c) | 'a dead-letter path reaching the buffer's file through a symlinked directory is refused at load' (config.test.ts:878) | not in r38 | passes in r43; source only |
| Dangling dead-letter symlink to the buffer file refused (6245863c) | 'a dead-letter symlink to the buffer file, not yet created, is refused at load' (config.test.ts:891) | not in r38 | passes in r43; source only |
| Distinct files accepted under a symlinked directory (6245863c) | 'distinct files are accepted, even when one of their directories is a symlink' (config.test.ts:899) | not in r38 | passes in r43; source only |
| Same spelling refused, buffer and dead-letter (guard now compares destinations) | 'the buffer and the dead-letter store cannot name one file' (service-event-buffer.test.ts:371) | line 371 | r38 PASS on the earlier guard; re-run passes in r43 |
| Whole workspace at 66fa97bd | gate r38: 12,322 testcases, 1 failure (ratchet, fixed at HEAD per the brief), 2 skipped | — | gate evidence, not rerun; no pass count is claimed for 5e304ef8 |
| Not run here | tsc, lint, the full suite, `config:reference --check`, the orchestrator gate | not run, by assignment | ? SKIP |

Postgres evidence: none. No covered test file on this path gates on `SUBSTRATE_TEST_PG_URL`.

### Probe Execution

No conventional probes exist (`find scripts -path '*/tests/probe-*.sh'` returns none), and no PLAN declares one. Step 7c does not apply.

### Fingerprint

Computed at HEAD df31c749 with `gsd_run query verification.fingerprint /root/src/worktrees/as-gsd-v18-all/.planning/phases/76-telemetry-buffer-and-dead-letter` over the 29 paths in `covered_files` (the 28 of the 5e304ef8 record plus `packages/mcp-server/src/config.test.ts`): `v3:sha256:f7f172448ae0d39aa6aa760f235a177532160d7f408f7758db2798313b478925`. Copied verbatim into the frontmatter. The 5e304ef8 digest (`v3:sha256:7b5b1433...`, 28 paths) is superseded.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R3 | none | Bounded queue, backoff with jitter, durable dead-letter with payload and error, per-record dedupe, depth metrics, chain ordering, truthful acks | ORPHANED | REQUIREMENTS.md:138 reads "Not started" at 5e304ef8 (checked). 76-01-PLAN.md declares no `requirements:`. The delivered code covers most of the description: bounded buffer, backoff, dead-letter with the payload, `mayExist` dedupe, depths in /healthz, chain ordering through the per-session FIFO, and truthful `stored: false` replies. The same-file guard refuses a symlink alias of the buffer file at load (6245863c). The dead-letter bound is not covered (override). |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| all phase 76 source, test and doc files changed in the range | — | TBD / FIXME / XXX / TODO / HACK / PLACEHOLDER | none | Debt-marker scan over every added line of the thirteen covered files changed since a46d42c3, and over the lines added at df31c749 in config.ts, config.test.ts, service.ts and service.test.ts: 0 matches. The added lines are export removals, two comments that state a reason (event.ts:77, greptime.ts:1998) and the two lines of server.ts, index.ts and docs line 1048 described above. |

### Human Verification Required

See the `human_verification` frontmatter: operator items 1 to 8 (live GreptimeDB outage, dead-letter exhaustion, torn-line restart, shutdown under the service manager, live steering session, live replay, the enablement decision, /healthz staleness), plus owner items 9 to 15: the handoff reorder ratification (W-L2-TIP-ORDER), the doc precision points (now with the line 1048 condition), D76-13 (the dead-letter cap follow-up), the abandon report scope (ABANDON-REPORT-SCOPE), the D76-14 and D76-19 ratification, R-2's live confirmation, and HARD-R3 traceability.

### Decisions (2026-11-06)

The owner decided on 2026-11-06 for phases 67 (criterion 4), 74 (HARD-R1) and 75 (O1) only. Phase 76 has no owner decision dated 2026-11-06, and none is recorded in ROADMAP.md, REQUIREMENTS.md or the phase directory at df31c749. Every owner item for phase 76 stays open. The buffer and dead-letter alias guard (6245863c) is a code fix from the Greptile review; it is recorded as a fix with its tests, not as an owner decision, and it adds no override. The D76-13 override (owner, accepted_at 2026-11-02) is unchanged. ROADMAP.md:1317 is free text and does not close owner item 10.

### Gaps Summary

No blocking gap. Both roadmap truths stand: SC1 within the owner-accepted pre-send scope, SC2 by owner override. The status is `human_needed` because the live items and the owner items are open, and because the three new config tests have no run of record yet (passes in r43).

Residuals at df31c749:
- **Closed:** R-3 for the abandon path of a non-durable buffer (identifier line on stderr; 7a1d923a). R-3-UNSETTLED-AT-EXIT (49b9aece). SYNC-LAG-BUFFERED-NOT-RECORDED (b4bdd0fc). CORPUS-EVAL-DOC-SYNC-LAG-WORDING (884e0753 and bb6b38b7). R-2 (a0572cf7; live not observed; owner item 14).
- **Open (info):** R-3 for a held record behind a durable buffer, the refused-full-buffer branch (ABANDON-REPORT-SCOPE; owner item 12). The identifier-only report leaves the payload lost (ABANDON-STDERR-IDENTIFIERS-ONLY). ABANDON-RECORD-UNCHECKED, narrowed.
- **Partly closed:** DOC-ABANDON-STDERR-AND-REFUSAL. Line 1048 names the stderr line (5041193f); line 1049 and the condition of 1048 remain for the owner (item 10).
- **New (info):** OBS-SERVICE-APPEND-PROBE-DISCARDED. The append-mode probe's error is discarded at service.ts:3211 and :3286; the answer APPEND_MODE_UNKNOWN stands.
- **Closed in code (fix, 6245863c):** the buffer and dead-letter alias guard compares destinations. Tests passes in r43.
- **New (info):** BUFFER-DEADLETTER-HARDLINK-ALIAS (hard links are not compared; see warnings). A follow-up code change, not an owner decision.
- **Operator item 4** keeps its live check: a durable buffer survives a SIGKILL mid-pass. Its stderr capture is added to the same item.
- Operator items 1 to 8 (live), kept as written.
- D76-15: operator decision to enable the buffer (item 7).
- D76-14 and D76-19: a buffered `session.end` closes steering before its note lands; PLAN says it should stay open. Owner ratification open (item 5; owner item 13).
- D76-13: dead-letter store unbounded under the override; cap is a tracked follow-up (owner item 11).
- R-1: live keyed replay after a dead-letter record. Code path tested (service-event-buffer.test.ts:391), live not (item 6).
- HARD-R3: orphaned in REQUIREMENTS.md (line 138, 'Not started'); ROADMAP.md:1317 describes R-3 as closed for a non-durable buffer, so the two files disagree (owner item 15).
- Handoff tip read outside the session turn (info, `HANDOFF-TIP-OUTSIDE-TURN`). Not exercised.
- `KEYED-REPLAY-RESTATES-SYNC-LAG`: a ledger-answered replay does not restate the gauge; a buffered or given-up replay does (info).
- `DIGEST-RECORDED-AT-HEAD`: the digest in the frontmatter is computed at df31c749 over 29 paths.

Deferred items (Step 9b): none taken. The dead-letter bound is an owner override, not a deferral to a later phase.

---

_Verified: 2026-11-06T06:12:03Z_
_Verifier: Claude (gsd-verifier, read-only draft)_
