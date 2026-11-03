---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-03T03:02:49Z
status: human_needed
score: 2/2 must-haves verified (SC1 VERIFIED within the owner-accepted pre-send scope, D76-16; SC2 PASSED by owner override, not verified)
covered_files: [".env.example", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-PLAN.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-SUMMARY.md", "docs/config-reference.md", "docs/greptime-ledger.md", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-buffer.test.ts", "packages/mcp-server/src/event-buffer.ts", "packages/mcp-server/src/event-dead-letter.test.ts", "packages/mcp-server/src/event-dead-letter.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/reanchor-run.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:6fe6faaaaf1182d9946fe7611d169bed5a62373a63df6fff78e71522d8ffa3b8"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag."
    reason: "Owner accepted the override on 2026-11-02. The dead-letter store is deliberately unbounded (plan decision D76-13): a bound would have to drop records, the silent loss this phase removes. The buffer is bounded by SUBSTRATE_EVENT_BUFFER_MAX, and the depth of both stores is reported in /healthz. A dead-letter cap is a tracked follow-up."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: 2/2 (9ee12695 record)
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Live GreptimeDB rehearsal of the accepted outage limit: block the ledger and emit for one session; restore. Cover (a) a session with a cached tip whose first write fails, (b) that session's next write while the outage lasts, (c) a write for a session with no cached tip, (d) the same run with SUBSTRATE_LEDGER_CHAIN_CACHE=0."
    expected: "(a) answers 503 with buffered true and stored false; /healthz eventBuffer.depth rises. (b) and (c) answer stored false with buffered absent, refused at the tip read (service.ts:2996-2999). (d) buffers nothing during the outage. After restore each buffered event lands once, in chain order, each with an event_ingest row. Also check the mayExist exact-ts predicate (greptime.ts:1299-1312) against real timestamp precision."
    why_human: "Needs a live GreptimeDB and a real outage."
  - test: "Dead-letter exhaustion on a live outage (nominal budget 243 s; 195 to 292 s with jitter)."
    expected: "A dead-letter line is written with its hash (event-dead-letter.ts:102-122, stderr 'dead-lettered') and the file mode is 0600 (event-dead-letter.ts:149-150). Boot refusal without SUBSTRATE_EVENT_DEAD_LETTER_PATH is covered by config.ts:2589-2612 and service-event-buffer.test.ts:229, not by this item."
    why_human: "Needs a live outage longer than the retry budget. The scratch probes wrote their own files, so 0600 on a service-written file was not exercised."
  - test: "Restart during an outage with a durable file that may end in a torn line from a real crash (ENOSPC, kill mid-write)."
    expected: "The next boot reports the depth and starts the drain timer (service.ts:3126-3132) and drains each entry once. The torn line is counted as malformed at boot (stderr note) and is skipped. The next dead-letter write starts on a fresh line (G1 fix, event-dead-letter.ts:148). Boot does not repair the torn line; it stays in the file. Confirm no record is lost."
    why_human: "The G1 test injects a torn line; a real partial write on a real disk is not reproduced."
  - test: "Shutdown under the service manager: index.ts:252 drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true }). Check R-2 and R-3 here."
    expected: "Finishes within the unit's stop bound with a durable buffer. R-2: drain (event-buffer.ts:287-293) returns an in-flight pass and drops options.all, so shutdown can join a periodic pass and skip entries not yet due. R-3: abandonAll (event-buffer.ts:299-305) clears the entry in flight; an in-flight entry that lands is recorded abandoned. The bounds stack: the retain pass (index.ts:249, up to 10 s) runs before the event pass (index.ts:252, up to 10 s), then transitions (5 s) and flush (2 s). infra/vps/substrate-host.service:59 sets TimeoutStopSec=15 (staged, operator-gated install; cited from the prior pass). Worst-case stop exceeds 15 s, so SIGKILL can land mid-pass."
    why_human: "Needs the real service manager and its shutdown timing. R-2 and R-3 are open warnings, not blockers."
  - test: "Buffered session.end on a live steering session (D76-14, D76-19)."
    expected: "The session is closed first (service.ts:2133 liveSessions.close, then the emit at :2136), so steering is closed whether or not the note lands. event_stored is false while the note is buffered and the wake-up hint is withheld (publishHint runs only on a stored event, service.ts:3091). docs/greptime-ledger.md:963 describes this. Owner ratification is still open."
    why_human: "Needs a live steering session and the owner's ratification of the behaviour."
  - test: "Keyed replay after a dead-letter record (R-1) on a live collector spool."
    expected: "Confirm which trigger occurs: Trigger A (one new row with a new id; the dead-letter record is orphaned, the common case) or Trigger B (two rows). The G3 answer for a replay of a pending give-up is code-verified (deadLettered true, nothing appended, service-event-buffer.test.ts:334); the live replay after the record has left the buffer is not."
    why_human: "Needs a live collector spool and ledger."
  - test: "Operator decision to enable the buffer (D76-15)."
    expected: "SC1 holds with SUBSTRATE_EVENT_BUFFER_PATH and SUBSTRATE_EVENT_DEAD_LETTER_PATH set (config.ts:2589-2612 refuses boot when only the buffer path is set; docs/greptime-ledger.md:947 states the buffer is off by default). With the buffer unset, a failed write answers stored false and nothing is queued. The operator must make and record this decision."
    why_human: "Configuration and policy decision, not code-verifiable."
  - test: "/healthz staleness."
    expected: "The body is memoised for SUBSTRATE_HEALTHZ_CACHE_MS (default 5000, config.ts:1202). Pollers see a depth change within that window."
    why_human: "Needs a running server and a poller."
---

# Phase 76: Telemetry buffer and dead-letter Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently. (ROADMAP.md, Phase 76)
**Verified:** 2026-11-03T03:02:49Z, on `gsd/v18-int-all` at HEAD `79b3ba32`.
**Status:** human_needed
**Re-verification:** Yes. The prior record (9ee12695, human_needed, 2/2) is replaced. Its frontmatter has no `gaps:` section, so Step 0 selects initial mode, and every truth was checked in full on this tree.

**Criteria source:** ROADMAP.md `### Phase 76`, Success Criteria 1 and 2. The criteria text is unchanged. The ROADMAP Status line (line 1313 area) and the progress row (line 97) still say the owner must confirm the broader boundary. That is stale after the 2026-11-03 owner decision. Neither was edited here; see Corrections.

**Requirement cross-check:** REQUIREMENTS.md:120 is HARD-R3 "Telemetry buffer/dead-letter (Phase 76)". 76-01-PLAN declares no requirements, so under Step 6c HARD-R3 is ORPHANED. It is reported below and not counted.

**Gates:** targeted tests only, as assigned: two `bun test` commands with `TMPDIR=/root/src/worktrees/backups/gate-tmpfs` and `SUBSTRATE_TEST_PG_URL` unset. The full suite, tsc, lint and formatters were not run. No Postgres test was run.

## What changed since the 9ee12695 record

- **Phase-76 code and test files: unchanged.** `git diff --name-only 9ee12695 HEAD` lists none of `event-buffer.ts`, `event-dead-letter.ts`, `service.ts`, `greptime.ts`, `event.ts`, `config.ts`, `flag-registry.ts`, `server.ts`, `index.ts`, `mcp.ts`, `reanchor-run.ts`, or the phase-76 test files. `observe.ts` is also unchanged in that range.
- **`docs/greptime-ledger.md:961`** ("Not buffered") is the only phase-76 change in the range. It now states the broader boundary as "Owner-accepted, 2026-11-03", and it documents the outage limit. The code was already on this boundary at 9ee12695, so the change is documentation only.
- Other commits in the range (79b3ba32, a28ecac8, 27778dee, 0504e77c, and others) belong to phases 72, 78 and the v1.8 owner-decision records. They do not touch the phase-76 path.

## Scope decision (D76-16): owner-accepted 2026-11-03

**Accepted scope.** A write is refused, not buffered, when either of these fails before the send:

- the chain-tip read, for any error, breaker or not (`service.ts:2981-2999`: any error from `lastHash` sets `tipError`, answered `stored: false`);
- the append-mode probe, for any failure (`service.ts:3003-3008`: `ensureAppendMode().catch(() => null)`, refused as `APPEND_MODE_UNKNOWN`).

The reason is that an event has no hash without its tip, and the probe is a configuration gate. The owner accepted this broader boundary, with the outage limit documented.

**Outage limit, as the code behaves.** This is more precise than `docs/greptime-ledger.md:961`:

- `greptime.ts:1287` forgets a session's cached tip on any event-row insert error for that session, because a timed-out insert may have landed. The next write for that session must read the tip. During an outage that read fails, so the write is refused (stored false, not buffered), even though an earlier event of the session is waiting in the buffer. The tip cache rules are at `greptime.ts:773-779`.
- The tip read happens before the buffer check (`service.ts:2983-2991`, then `:3013`). So during a full outage the buffer holds a session's write only while that session's tip can still be read.
- With `SUBSTRATE_LEDGER_CHAIN_CACHE=0` (switch parsed at `config.ts:2424`; `chainTips` is null at `greptime.ts:776`) every write reads the tip, and a failed read is refused (`service.ts:2996-2999`). During an outage nothing is buffered. Code read, not tested.
- With the breaker open, the tip read is refused by the breaker as well (`greptime.ts:907`, `GreptimeBreakerOpen`), so writes for sessions without a cached tip are refused in that state too.
- The doc sentence "for a session whose tip is not cached" is accurate. It does not say that a failed write uncaches its session, or that the chain-cache flag removes buffering during an outage. Whether to add those facts is the owner's call; this record does not edit the doc.

**Test coverage of the refusal branches (corrected; see Corrections).** These assertions exist in `service.test.ts` and were **not run** this pass, because they fall outside the two allowed commands. They were read from the file.

- `service.test.ts:686-702`: a non-breaker tip-read failure (`greptime unreachable`) gives `stored: false`, an error containing `chain tip unreadable`, and nothing written. This test is present at 9ee12695 as well.
- `service.test.ts:1648-1680`: the same refusal on the handoff path.
- `service.test.ts:866` and `:879`: append-mode `false` gives an error containing `append_mode`, and `null` (unconfirmed) gives `could not confirm`. Both assert `stored: false` and nothing written.

The refusals run before the buffer decision, so these tests describe the buffer-on behaviour as well. No test runs with the buffer on.

## Fix verification (G1, G2, G3 from c7788f9d), rechecked

| Gap | Named test (file:line) | Code on 79b3ba32 | Verdict |
| --- | ---------------------- | ---------------- | ------- |
| G1 torn dead-letter tail | `a record written after a torn last line is readable...` (`event-dead-letter.test.ts:78`) | `flush` `event-dead-letter.ts:141-156`; lead `:148` when `endsMidLine` (`:159-170`); torn line skipped in `countOnFile` `:177-219` and `read` `:221-240` | **CLOSED.** Passes (run 1). |
| G2 live write refused by the breaker spent an attempt | `a live write the breaker refused is buffered with its full budget...` (`service-event-buffer.test.ts:319`) | `service.ts:3046` `attempts = cause instanceof GreptimeBreakerOpen ? 0 : 1`; `:3047` buffers; `enqueue` `event-buffer.ts:229-281`; `skipped` is not an attempt (`:332`, `service.ts:3087`) | **CLOSED on the insert path.** Passes (run 1). |
| G3 keyed replay of a pending give-up answered as buffered | `a keyed replay of a pending give-up is refused as a give-up...` (`service-event-buffer.test.ts:334`) | `findKeyed` `event-buffer.ts:190-192` (live only); `findPendingKeyed` `:195-197`; `service.ts:2977-2978` answers `deadLettered: true` before any write | **CLOSED.** Passes (run 1). |

## Goal Achievement

### Observable Truths

| #   | Truth (criterion) | Status | Evidence |
| --- | ----------------- | ------ | -------- |
| 1   | A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash (SC 1) | ✓ VERIFIED within the accepted pre-send scope (D76-16). Holds only when the buffer is enabled (D76-15, open). | **Insert path.** Live write fails: `service.ts:3024-3048`. Entry `:3047`. Bounded enqueue `event-buffer.ts:229-281`; over the bound the oldest live entry is given up (`:233-239`), or the new event is refused and not recorded (`:250-276`; `service.ts:3057-3062`). Backoff `eventBufferBackoffMs` `event-buffer.ts:40-44` (base 1 s, doubling, cap 60 s, ±20 % jitter). **Retry.** `drainEventBuffer` `service.ts:3106-3112` → `drain` `event-buffer.ts:287-293` → `runDrain` `:307-343` → `deliverBuffered` `service.ts:3074-3093`. **Dead letter.** `dropFrom` `event-buffer.ts:402-425` → `DeadLetterStore.record` `event-dead-letter.ts:102-122` (hash, reason, attempts, last error, whole event). Behavioural tests that pass: "a failed write is buffered, not dropped, and lands once the ledger is back" (`service-event-buffer.test.ts:79`); "a later event... waits behind the buffered one" (`:97`); "a write that exhausts its budget is dead-lettered with its hash" (`:128`); `event-buffer.test.ts:117` and `:145`. |
| 2   | Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag (SC 2) | ✓ PASSED (override), not verified | **Reported:** `service.ts:8706` (`eventBuffer`: `enabled`, `EventBuffer.stats()` depth/max/oldestAt/durable/pending, and `deadLetter: { depth, durable }`). `/healthz` spreads the health body (`server.ts:985-1004`), memoised for `SUBSTRATE_HEALTHZ_CACHE_MS` (`config.ts:1202`). **Buffer bound by flag:** `SUBSTRATE_EVENT_BUFFER_MAX` (`config.ts:2589-2612`; `flag-registry.ts:358`), enforced at `event-buffer.ts:229-233` and on hydrate `:460-463`. **Dead-letter bound:** none, by design (D76-13, owner override). |

**Score:** 2/2 truths (1 VERIFIED within the accepted scope, 1 PASSED by owner override). Behaviour-unverified truths: 0.

**Behaviour-dependence.** SC1 is a state transition (queued, retried, given up with a record). Its behavioural evidence is the named tests above, which passed in both runs.

**Coincidental-reliance (Step 3, 5c).** None flagged. The buffered tail's `prev` is fixed by code at queue time (`event-buffer.ts:12-16`, `:241`), not by fixture order.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-buffer.ts` | bounded per-session FIFO, backoff, give-up with write-ahead, file persistence, pending entries | ✓ VERIFIED with warnings | Enqueue `:229-281`; findKeyed `:190-192`; findPendingKeyed `:195-197`; drain `:287-293` (R-2); runDrain `:307-343`; settlePending `:354-368`; abandonAll `:299-305` (R-3); dropFrom `:402-425`; hydrate `:438-465`; `append` `:467-488`, `compact` `:490-508` (0600 at `:483`, `:502`). |
| `packages/mcp-server/src/event-dead-letter.ts` | append-only dead-letter store, hash and reason, torn-tail safe write | ✓ VERIFIED (G1 closed) | `record` `:102-122`; `flush` `:141-156` (lead `:148`, fresh-file chmod `:150`); `endsMidLine` `:159-170`; `countOnFile` `:177-219`; `read` `:221-240`; `depth` `:92-94`. Deliberately unbounded (override; comment `:11-12`). |
| `packages/mcp-server/src/service.ts` | wiring, write path, buffering, drain, shutdown, health | ✓ VERIFIED (accepted scope D76-16 applies to the refusals) | `appendChained` `:2961-3049`: keyed answer `:2972-2979`; tip refusal `:2981-2999`; append-mode refusal `:3003-3008`; live write and breaker attempts `:3024-3048`. `bufferEvent` `:3055-3067`; `deliverBuffered` `:3074-3093`; `drainEventBuffer` `:3106-3112`; `drainPendingEvents` `:3118-3124`; periodic tick `:3126-3132`. `closeLiveSession` close `:2133`, emit `:2136`. Health `:8706`. Stores built `:1963-1981`. |
| `packages/mcp-server/src/greptime.ts` | `insertEvent` with `mayExist`, breaker mapping, tip read | ✓ VERIFIED | `insertEvent` `:1248-1296`; `mayExist` branch `:1262-1274`; `eventRowPresent` `:1299-1302`; `cellWhere` `:1305-1312`; tip-cache forget on insert error `:1287`; transport catch and breaker mapping `:905-908`; `ensureAppendMode` `:1183-1192`; `lastHash` `:1483-1501`. |
| `packages/mcp-server/src/config.ts` | buffer settings, boot refusals | ✓ VERIFIED | `loadEventBufferSettings` `:2589-2612`: refusal without a dead-letter path, refusal when both paths name one file, bounds. Chain-cache flag `:2424`. |
| `packages/mcp-server/src/flag-registry.ts` | buffer flag rows | ✓ VERIFIED | `SUBSTRATE_EVENT_BUFFER_MAX` `:358`; the other buffer rows are present and checked by `flag-registry.test.ts` (run 2, passing). |
| `packages/mcp-server/src/server.ts` | `/healthz` body; `/events` carries `buffered` and `deadLettered` | ✓ VERIFIED | Memoised compute and body spread `:985-1004`; `buffered` and `deadLettered` `:1376-1377`. |
| `packages/mcp-server/src/mcp.ts` | `events_emit` reply carries `buffered` and `deadLettered` | ✓ VERIFIED | `:1190-1202`. |
| `packages/mcp-server/src/index.ts` | shutdown drains the buffer | ✓ VERIFIED (wiring) / ? (timing, human item 4) | `drainPendingRetains` `:249`; `drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })` `:252`. |
| `packages/mcp-server/src/observe.ts` | (not phase-76 behaviour) | ✓ NOT IN PHASE-76 PATH | `openAuditLog` factory; no buffer or dead-letter import. Unchanged since 9ee12695. Listed in `covered_files` because it is on the tree. |
| `packages/mcp-server/src/event.ts` | payload wrap (PR 204) | ✓ VERIFIED (code); wrap tested for arrays only | `asPayloadRecord` `:220-224` wraps a scalar or array as `{ _payload }`. No test in `event.test.ts` covers a scalar payload. Note only. |
| `docs/greptime-ledger.md` (phase 76 section, `:945-963`) | flags and behaviour documented | ✓ VERIFIED (read) | Off by default `:947`; dead letters and boot refusal `:953`; not buffered `:961` (owner-accepted 2026-11-03); buffered `session.end` `:963`. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `appendChained` live write failure (insert) | `bufferEvent` → `EventBuffer.enqueue` | `service.ts:3046-3047` | ✓ WIRED | Breaker refusal enters with `attempts: 0` (G2). |
| `appendChained` tip read or append-mode probe refused | `bufferEvent` | none | ✓ NOT WIRED, BY OWNER-ACCEPTED SCOPE | Returns `stored: false` before the send (`service.ts:2996-2999`, `:3003-3008`). Accepted 2026-11-03 (D76-16). |
| `EventBuffer` give-up | `DeadLetterStore.record` | `service.ts:1963-1981` | ✓ WIRED | Return value is the store's `durable`. |
| drain pass | `deliverBuffered` → `insertEvent(mayExist)` | `service.ts:3112`, `:3084` | ✓ WIRED | Breaker `skipped` is not an attempt (`:3087`). |
| shutdown | `drainPendingEvents` | `index.ts:252` → `service.ts:3118` | ✓ WIRED | Timing is human item 4 (R-2, R-3). |
| `/events` and `events_emit` | `buffered`, `deadLettered` reply keys | `server.ts:1376-1377`, `mcp.ts:1190-1202` | ✓ WIRED | Keys appear only when the buffer is on. |
| `health()` | `/healthz` body | `service.ts:8706` → `server.ts:985-1004` | ✓ WIRED | |
| `SUBSTRATE_EVENT_BUFFER_MAX` | buffer bound | `config.ts:2589-2612` → `service.ts:1963-1971` → `event-buffer.ts:229` | ✓ WIRED | |
| dead-letter depth | bound flag | none | ✓ ACCEPTED (override) | No bound flag by design (D76-13). |
| buffer and dead-letter depth | metrics export (HARD-R3 wording) | none | ✗ NOT WIRED | Only `/healthz` carries depth. No buffer or dead-letter metric in `packages/mcp-server/src` (grep, this pass, metric and gauge patterns). Open wording question (HARD-R3 cross-check). Not counted. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `/healthz` `eventBuffer` | depth, max, oldestAt, durable, pending | `EventBuffer.stats()` over the live map (`event-buffer.ts:209-217`) | Yes | ✓ FLOWING |
| `/healthz` `eventBuffer.deadLetter` | depth, durable | `DeadLetterStore.depth()` (on file plus held, `event-dead-letter.ts:92-94`) | Yes | ✓ FLOWING |
| dead-letter record | `event_hash` | `event.hash` of the buffered entry (`event-dead-letter.ts:108`) | Yes | ✓ FLOWING |

### Level 3 wiring and Step 4 and Step 5 mechanical checks

- Step 4, `verify.artifacts`: exit 66 (NO_INPUT), because 76-01-PLAN declares no `must_haves.artifacts`. Artifact status was taken from the Level 1 to 3 reads above.
- Step 5, `verify.key-links`: exit 66 (NO_INPUT), because 76-01-PLAN declares no `must_haves.key_links`. Wiring was taken from the reads above.
- Step 2b: no `must_haves` in the PLAN. The must-haves are the two ROADMAP Success Criteria.

### Behavioral Spot-Checks

Run from `/root/src/worktrees/as-gsd-v18-all`, `TMPDIR=/root/src/worktrees/backups/gate-tmpfs`, `SUBSTRATE_TEST_PG_URL` unset. Two `bun test` commands, both run by this verifier.

| Command | Result | Status |
| ------- | ------ | ------ |
| Run 1: `bun test packages/mcp-server/src/service-event-buffer.test.ts packages/mcp-server/src/event-dead-letter.test.ts` (includes G1 at `event-dead-letter.test.ts:78`, G2 at `service-event-buffer.test.ts:319`, G3 at `:334`, and the criterion-1 tests at `:79`, `:97`, `:128`) | 23 pass, 0 fail, 66 expect(), 23 tests across 2 files, 470 ms | ✓ PASS |
| Run 2: `bun test packages/mcp-server/src/event-buffer.test.ts packages/mcp-server/src/flag-registry.test.ts scripts/config-reference.test.ts` | 65 pass, 0 fail, 372 expect(), 65 tests across 3 files, 774 ms | ✓ PASS |

The run totals are the counts of every test in the named files. Per-test names are not in the summary output. The stderr lines in run 1 and run 2 are the expected logs from the exhaustion, overflow and malformed-line tests, not failures.

### Probe Execution

No probe is declared in 76-01-PLAN or 76-01-SUMMARY, and the phase is not a migration or tooling phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R3 (REQUIREMENTS.md:120) | none (ORPHANED: mapped to phase 76, not claimed by 76-01) | See cross-check below | ORPHANED, reported, not counted | Partly met; the metrics clause is not met as written. |

### HARD-R3 cross-check (not counted; owner wording decision open)

| Clause | Verdict | Evidence |
| ------ | ------- | -------- |
| Bounded queue with backpressure | Met as code (bounded; a full buffer refuses with `stored: false`) | `event-buffer.ts:229-281`, `service.ts:3057-3062` |
| Exponential backoff and jitter | Met (per event, not per batch) | `event-buffer.ts:40-44` |
| Retain payload and error in a durable store | Met with the buffer on; durable only when saved | `event-dead-letter.ts:102-122` |
| Per-record dedupe makes replay idempotent | Partly. `mayExist` and the keyed replay cover a known id. R-1 (fresh row after a give-up) and keyless resends leave gaps. | `service.ts:3084`, `:2977-2978` |
| Export queue depth and dead-letter metrics | ✗ NOT MET AS WRITTEN. Depth is in `/healthz` only. ROADMAP SC2 says "reported in /healthz", so the two texts differ. | `service.ts:8706`, `server.ts:985-1004` |
| Ordering and truthful acknowledgements | Met for ordering (`prev` fixed at queue time). Acknowledgements are truthful for the paths above, including the pre-send refusals (`stored: false`). | `event-buffer.ts:12-16`, `service.ts:2996-2999`, `:3003-3008` |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/service.ts` | 2981-2999, 3003-3008 | Every failed tip read and every failed append-mode probe is refused, not buffered | ⚠️ Warning (scope) | Owner-accepted 2026-11-03 (D76-16). Outage limit above. |
| `packages/mcp-server/src/greptime.ts` | 1287 | A failed event-row insert forgets that session's cached tip | ⚠️ Warning (outage limit) | Intended (timed-out insert may have landed). It is what makes a later write for the session refused during an outage. Stated in the scope section; not in the ledger doc. |
| `packages/mcp-server/src/event-buffer.ts` | 287-293 | R-2: `drain` returns the in-flight pass and drops `options.all` | ⚠️ Warning | Shutdown can join a periodic pass and skip entries not yet due. Open. Human item 4. |
| `packages/mcp-server/src/event-buffer.ts` | 299-305 | R-3: `abandonAll` clears the entry in flight; an in-flight entry that lands is recorded `abandoned` | ⚠️ Warning | Open. Reached only when the buffer is not durable (`service.ts:3123`). Duplicate, not loss. Human item 4. |
| `docs/greptime-ledger.md` | 963 | buffered `session.end` residual | ⚠️ Warning | Docs match the code. Owner ratification open (D76-14, D76-19). Human item 5. |
| `packages/mcp-server/src/service.ts` | 2981-2999, 3003-3008 | No buffer-on test of the refusal branches | ℹ️ Info | The refusals run before the buffer decision. Existing tests assert them buffer-off; they were not run this pass. |
| `packages/mcp-server/src/event.ts` | 220-224 | Scalar payload wrap not directly tested (arrays only) | ℹ️ Info | Note only. |

Debt markers (`TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER`) in the phase-76 implementation and test files: none (grep, this pass). The Step 7 debt-marker gate is clean.

**Residuals (at-least-once duplicates), documented in code:** `event-dead-letter.ts:99-100` (`record`), `:133-134` (`writeHeld`); `event-buffer.ts:350-353` (`settlePending`). A store write that fails partway and is retried can write a record twice. A crash between a store write and compaction hands a pending entry to the store again after boot. Both copies carry the same event id and hash.

**Warnings (not must-have failures; kept open):**
- R-1: keyed replay after a give-up. Trigger A (one new row with a new id) is the common case and lands once. Trigger B (two rows) is not reproduced. G3 closes the pending-state answer only (human item 6).
- R-2: `drain` joins an in-flight pass and drops `options.all` (`event-buffer.ts:287-293`; periodic tick `service.ts:3128-3131`; shutdown `service.ts:3121`). Re-read this pass.
- R-3: an in-flight entry abandoned at shutdown can be recorded `abandoned` and still land (`event-buffer.ts:299-305`). Re-read this pass.
- `abandonAll` on an unsaved buffer (`service.ts:3123`, `event-buffer.ts:299-305`): the abandoned entries are not compacted out of the file, so they can return at the next boot. Not reproduced.
- Shutdown bound: the retain pass (10 s) and the event pass (10 s) run in sequence (`index.ts:249-252`), before the transition pass (5 s) and flush (2 s).
- Outage limit (D76-16): see the scope section. The ledger doc sentence is accurate but does not state the uncaching or the chain-cache effect.

## Deferred Items

None. Phases 77 and 78 do not mention dead-letter, buffer, torn-write or breaker behaviour in their ROADMAP text (grep, this pass). The only match is phase 76's own progress row.

## Advisory (New Scope, Unevidenced)

None. Initial mode; no new-scope findings.

## Human Verification Required

Items 1 to 8 in the frontmatter. They are operator proofs and owner decisions, and none is counted as verified. The owner-wording item from the prior record is removed: the owner accepted the broader boundary on 2026-11-03.

**Why human_needed.** No must-have is FAILED. No artifact is missing or a stub, and no key link required by the in-scope SC1 path is unwired. No blocker anti-pattern remains. Human items exist, so Step 9 rule 2 routes the status to `human_needed`.

## Open decisions (kept open; none upgraded to verified)

| Decision | State | Where |
| -------- | ----- | ----- |
| D76-16: pre-send refusals (any tip-read failure, any append-mode probe failure) are not buffered | ACCEPTED by the owner on 2026-11-03 as the SC1 boundary. Outage limit documented in the ledger doc. Its precise behaviour (tip-cache forget at `greptime.ts:1287`, chain-cache flag) is stated in this record. | `service.ts:2981-2999`, `:3003-3008`; `docs/greptime-ledger.md:961` |
| D76-13: dead-letter store unbounded; depth reported, no flag | Owner override recorded 2026-11-02, a tracked follow-up. Carried as PASSED (override), NOT verified. KEPT OPEN for ratification. | Must-have 2; `event-dead-letter.ts:11-12` |
| D76-15: buffer is opt-in (off by default) | OPEN, operator decision. Criterion 1 holds only when enabled. | Human item 7; `docs/greptime-ledger.md:947` |
| D76-14 / D76-19: buffered `session.end` and steering session | OPEN. Docs match the code (session closed first, note buffered). Owner has not ratified it. | Human item 5; `service.ts:2133`, `:2136`; `docs/greptime-ledger.md:963` |
| HARD-R3 "export queue depth/dead-letter metrics" vs ROADMAP SC2 "reported in /healthz" | OPEN, owner: which wording governs | HARD-R3 cross-check; `.planning/REQUIREMENTS.md:120` |
| R-1: keyed replay after a give-up, Trigger A vs B | OPEN. G3 closed the pending state; the live check is still needed. | Human item 6 |
| R-2: shutdown joins a periodic pass | OPEN. Confirmed by reading. | Human item 4 |
| R-3: in-flight entry abandoned at shutdown | OPEN. Partly reproduced (prior probe C). | Human item 4 |
| Operator rehearsal of the outage limit | OPEN. | Human item 1 |

## Corrections to the previous report (9ee12695 record)

1. **Refusal-branch tests (wrong).** The prior record said no `*.test.ts` asserts `chain tip unreadable`, `APPEND_MODE_UNKNOWN` or `NOT_APPEND_ONLY`. That is incorrect. `service.test.ts:686-702` and `:1648-1680` assert the tip-read refusal, and `:866` and `:879` assert the append-mode refusal. They are not run this pass.
2. **D76-16 wording (resolved).** The prior record flagged a conflict between "breaker refusal" and "pre-send refusals". The owner accepted the broader boundary on 2026-11-03, and `docs/greptime-ledger.md:961` now states it. The code already matched it. The owner-confirmation human item is removed.
3. **ROADMAP.md status (stale; not edited here).** `ROADMAP.md:1313` (Phase 76 Status line) and `:97` (progress row) still say "the owner still confirms the broader boundary". Main should update them to the 2026-11-03 decision.
4. **Outage limit precision (new).** The prior record did not analyse the tip-cache forget at `greptime.ts:1287` or the chain-cache flag. Both are stated above.

## Gaps Summary

No gaps under the accepted scope. SC1 is verified within the owner-accepted pre-send scope (D76-16, 2026-11-03) and applies when the buffer is enabled (D76-15, open). SC2 is passed by the owner's override (D76-13), which stays open for ratification and is not verified. The status is `human_needed` because the operator items (outage rehearsal, dead-letter exhaustion, torn-tail crash, shutdown timing, buffered `session.end` ratification, R-1 live check, D76-15 enable decision, `/healthz` staleness) remain open, and the HARD-R3 metrics wording is an open owner question.

---

_Verified: 2026-11-03T03:02:49Z_
_Verifier: Claude (gsd-verifier, re-verification of phase 76 on gsd/v18-int-all, HEAD 79b3ba32)_
