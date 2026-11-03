---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-03T11:26:38Z
status: human_needed
score: "2/2 must-haves verified (SC1 VERIFIED within the owner-accepted pre-send scope, PLAN D76-10; SC2 PASSED by owner override, not verified)"
covered_files: [".env.example", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-PLAN.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-SUMMARY.md", "docs/config-reference.md", "docs/greptime-ledger.md", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-buffer.test.ts", "packages/mcp-server/src/event-buffer.ts", "packages/mcp-server/src/event-dead-letter.test.ts", "packages/mcp-server/src/event-dead-letter.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.test.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/ledger-chain.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:4c1ae8958e69d6fc8bfd483e51c4f839ebd2b9a770389f6d6f8c2ad1a7e8897f"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag."
    reason: "Owner accepted the override on 2026-11-02. The dead-letter store is deliberately unbounded (plan decision D76-13): a bound would have to drop records, the silent loss this phase removes. The buffer is bounded by SUBSTRATE_EVENT_BUFFER_MAX, and the depth of both stores is reported in /healthz. A dead-letter cap is a tracked follow-up."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: "2/2 (97defd59 record)"
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Operator item 1. Live GreptimeDB rehearsal of the accepted outage limit: block the ledger and emit for one session; restore. Cover (a) a session whose tip is cached, first write fails; (b) that session's next write while the outage lasts; (c) a write for a session with no cached tip; (d) the same run with SUBSTRATE_LEDGER_CHAIN_CACHE=0, sessioned writes, including a write whose tip read succeeds and whose insert fails; (e) a sessionless write during the outage in a process that confirmed append-mode before the outage; (f) a sessionless write in a process whose first ledger contact is during the outage. Also run (d) in a process that has not confirmed append mode, with the tip read answering and the append-mode probe failing."
    expected: "(a) answers 503 with buffered true and stored false; /healthz eventBuffer.depth rises. (b) and (c) answer stored false with buffered absent, refused at the tip read (service.ts:3126-3129). (d) a sessioned write whose tip read fails is refused; a sessioned write whose tip read succeeds and whose insert fails is buffered (service.ts:3155-3177) when append mode is confirmed in the process; without that confirmation and without SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER it is refused as APPEND_MODE_UNKNOWN before the insert (service.ts:3133-3138). (e) is buffered (no tip read; the cache switch does not apply). (f) is refused as APPEND_MODE_UNKNOWN (service.ts:3134-3137) unless SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER is 1, true or yes. After restore each buffered event lands once, in chain order, each with an event_ingest row. Also check the mayExist exact-ts predicate (greptime.ts:1299-1312) against real timestamp precision."
    why_human: "Needs a live GreptimeDB and a real outage. The cache-off sentence's sessionless and write-only clauses are code reads and fake-based tests, not live proofs."
  - test: "Operator item 2. Dead-letter exhaustion on a live outage (nominal budget 243 s; 195 to 292 s with jitter)."
    expected: "A dead-letter line is written with its hash (event-dead-letter.ts:102-122, hash at :108, stderr 'dead-lettered' at :119) and the file mode is 0600 (event-dead-letter.ts:149-150). Boot refusal without SUBSTRATE_EVENT_DEAD_LETTER_PATH is covered by config.ts:2604-2618 and service-event-buffer.test.ts:229, not by this item."
    why_human: "Needs a live outage longer than the retry budget. The scratch probes wrote their own files, so 0600 on a service-written file was not exercised."
  - test: "Operator item 3. Restart during an outage with a durable file that may end in a torn line from a real crash (ENOSPC, kill mid-write)."
    expected: "The next boot reports the depth and starts the drain timer (service.ts:2112; tick at service.ts:3256-3260) and drains each entry once. The torn line is counted as malformed at boot and skipped. The next dead-letter write starts on a fresh line (event-dead-letter.ts:148). Boot does not repair the torn line. Confirm no record is lost."
    why_human: "The G1 test injects a torn line; a real partial write on a real disk is not reproduced."
  - test: "Operator item 4 (R-2, R-3). Shutdown under the service manager: index.ts:258 drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true }) after the retain pass at index.ts:255."
    expected: "Finishes within the unit's stop bound with a durable buffer. R-2: drain (event-buffer.ts:287-293) returns an in-flight pass and drops options.all, so shutdown can join a periodic pass and skip entries not yet due. R-3: abandonAll (event-buffer.ts:299-305, called at service.ts:3253) clears the entry in flight; an in-flight entry that lands is recorded abandoned. The bounds stack: retain pass (10 s, index.ts:221), event pass (10 s), transitions (5 s, index.ts:223), flush (2 s, index.ts:219). infra/vps/substrate-host.service:59 sets TimeoutStopSec=15 in the repository unit file (operator-gated install; the installed unit was not inspected). Worst-case stop exceeds 15 s, so SIGKILL can land mid-pass."
    why_human: "Needs the real service manager and its shutdown timing. R-2 and R-3 are open warnings, not blockers."
  - test: "Operator item 5 (D76-14, D76-19). Buffered session.end on a live steering session."
    expected: "The session is closed first (service.ts:2263 liveSessions.close, service.ts:2265 steeringWaiters.closeSession, then the emit), so steering is closed whether or not the note lands. event_stored is false while the note is buffered and the wake-up hint is withheld (publishHint runs only on a stored event, service.ts:2961; a buffered event publishes only on landing, service.ts:3221). docs/greptime-ledger.md:979 describes this. PLAN D76-14 and D76-19 say the session stays open until the note lands; the code does not do that, and the doc matches the code. Owner ratification is still open."
    why_human: "Needs a live steering session and the owner's ratification of the behaviour."
  - test: "Operator item 6 (R-1). Keyed replay after a dead-letter record on a live collector spool."
    expected: "Confirm which trigger occurs: Trigger A (one new row with a new id; the dead-letter record is orphaned, the common case) or Trigger B (two rows). The replay of a pending give-up is code-verified (service.ts:3107-3108, event-buffer.ts:195-197, deadLettered true, nothing appended; service-event-buffer.test.ts:334); the live replay after the record has left the buffer is not."
    why_human: "Needs a live collector spool and ledger."
  - test: "Operator item 7 (D76-15). Operator decision to enable the buffer."
    expected: "SC1 holds with SUBSTRATE_EVENT_BUFFER_PATH and SUBSTRATE_EVENT_DEAD_LETTER_PATH set (config.ts:2607-2618 refuses boot when only the buffer path is set; docs/greptime-ledger.md:963 states the buffer is off by default). With the buffer unset, a failed write answers stored false and nothing is queued. The operator must make and record this decision."
    why_human: "Configuration and policy decision, not code-verifiable."
  - test: "Operator item 8. /healthz staleness."
    expected: "The body is memoised for SUBSTRATE_HEALTHZ_CACHE_MS (default 5000, config.ts:1217; memo at server.ts:985-991). Pollers see a depth change within that window."
    why_human: "Needs a running server and a poller."
---

# Phase 76: Telemetry buffer and dead-letter Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently. (ROADMAP.md, Phase 76)
**Verified:** 2026-11-03T11:26:38Z, on `gsd/v18-int-all` at HEAD `f86388cf`, worktree `/root/src/worktrees/as-gsd-v18-all`.
**Status:** human_needed
**Re-verification:** Yes. The prior record (97defd59) is replaced. It has no `gaps:` section, so Step 0 selects initial mode, and every truth was checked on this tree.

**Criteria source:** ROADMAP.md `### Phase 76`, Success Criteria 1 and 2. The criteria text is unchanged.
**Requirement cross-check:** REQUIREMENTS.md:120 is HARD-R3 "Telemetry buffer/dead-letter (Phase 76)". 76-01-PLAN declares no requirements (no `requirements:` field, no `must_haves`), so under Step 6c HARD-R3 is ORPHANED. It is reported below and not counted. The status row at REQUIREMENTS.md:138 still reads "Not started".

**Gates:** Two targeted `bun test` commands, run from the worktree with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs` and `--timeout 30000`. Command 1: 6 pass. Command 2: 5 pass. The full suite, tsc, lint, formatters and any Postgres test were not run.

## Scope: what changed since 97defd59

`git diff --stat 97defd59 f86388cf` touches five files, two commits (`62a25181`, `f86388cf`):

- `docs/greptime-ledger.md`: line 977 only (the "Not buffered" bullet, corrected in `f86388cf`).
- `packages/mcp-server/src/event.ts`: `GraphIdNulError` (`:215`) and a refusal of a graph id with a NUL byte in `normalizeGraphId` (`:230`), before the 512-byte check. Scoped to phase 73 by commit message, but on this phase's write path (see Anti-Patterns).
- `packages/mcp-server/src/anchor.ts`: a NUL refusal in `pointerPlans` (`:553`; the check is `:556`, `graphId.includes("\0")`), before any hour transaction. Its caller at `:961` answers `send-failed` at `:964`, and the comment at `:953-958` now names the NUL case.
- `packages/mcp-server/src/event.test.ts` (`:309`) and `packages/mcp-server/src/anchor.test.ts` (`:1519`): tests for the NUL refusal.

`service.ts`, `service.test.ts`, `greptime.ts`, `config.ts`, `event-buffer.ts`, `event-dead-letter.ts`, `index.ts`, `server.ts`, `mcp.ts`, `flag-registry.ts`, `observe.ts`, `service-event-buffer.test.ts`, `ledger-chain.test.ts`, `event-buffer.test.ts`, `event-dead-letter.test.ts`, `ROADMAP.md`: unchanged since 97defd59 (`git diff --quiet` exit 0). Prior line citations in those files hold, and the spot checks below re-read the ones this record depends on.

**Line correction.** The `abandonAll` call in `drainPendingEvents` is at `service.ts:3253` (the prior record cited 3252). Everything else in the write path is unchanged: `appendChained` `:3091`, tip read `:3113-3121`, tip refusal `:3126-3129`, append-mode refusal `:3133-3138`, buffer-behind `:3143-3152`, live insert `:3155`, catch and buffer `:3157-3177`, `bufferEvent` `:3185`.

## Scope decision (PLAN D76-10): carried as owner-accepted 2026-11-03

The record and the doc say the owner accepted this on 2026-11-03 (`docs/greptime-ledger.md:977`; ROADMAP.md:1317). I did not independently confirm that acceptance and carry it as recorded.

**Accepted scope.** A write is refused, not buffered, when either of these fails before the send:

- the chain-tip read, for any error (`service.ts:3116-3120` sets `tipError`; `:3126-3129` answers `stored: false`, `chain tip unreadable`);
- the append-mode probe, for any failure that leaves no confirmed answer (`service.ts:3133-3138`, refused as `APPEND_MODE_UNKNOWN` or `NOT_APPEND_ONLY` unless `allowDeduplicatingLedger` is set).

Both refusals run before the buffer decision (`hasSession` branch at `:3143`, insert at `:3155`, `bufferEvent` at `:3177`). The append-mode gate at `:3133` is not conditioned on `sessionId`, so it applies to sessioned writes as well as sessionless ones.

## Cache-off statement check (docs/greptime-ledger.md:977, at f86388cf)

The owner asked for the cache-off fact to be confirmed against the code. The corrected sentence now reads, in its cache-off part:

> With `SUBSTRATE_LEDGER_CHAIN_CACHE=0` every session write reads the tip first, and a failed tip read refuses that write rather than buffering it; a session write whose tip is readable but whose insert fails is still buffered. With the cache on (code read, not tested), a session's first write during an outage can be buffered and its next write is refused until the tip is readable. A sessionless write reads no tip; it is buffered during an outage once append mode is confirmed in this process, or when `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` is set, with the cache on or off.

(The sentence continues with the names of the switch, the cache and the refusal branch. Those names resolve, as checked below.)

Claim by claim, at f86388cf:

| # | Claim | Code at f86388cf | Verdict |
| - | ----- | ---------------- | ------- |
| 1 | Cache off: every session write reads the tip first | `service.ts:3113-3121` calls `lastHash(sessionId)` on every sessioned `appendChained` that reaches the write path. The keyed replays answered at `:3097-3108` return before it; they are replies, not writes. `config.ts:2439` `chainCache` is false on `SUBSTRATE_LEDGER_CHAIN_CACHE=0`. `greptime.ts:798` sets `chainTips` to null when off. `lastHash` (`greptime.ts:1483-1499`): `this.chainTips?.get` is `undefined` at `:1484`, so the SELECT runs (`:1487-1497`). Test `ledger-chain.test.ts:207` PASS (command 1). | ✓ CONFIRMED |
| 2 | A failed tip read refuses that write, not buffers it | `appendChained` catches any error from `lastHash` (`service.ts:3117-3120`), sets `tipError`, and answers `stored: false` (`:3126-3129`) before any `bufferEvent` call. The only `bufferEvent` calls are `:3144` (buffer-behind) and `:3177` (insert failure). Test `service.test.ts:686` PASS (command 1). The fake throws; no real-client read failure is tested. | ✓ CONFIRMED (fake-based) |
| 3 | A session write whose tip is readable but whose insert fails is buffered | Insert `:3155`; catch `:3157-3177`; `bufferEvent` `:3177` with `attempts` 1, or 0 for a breaker refusal (`:3176`). With the buffer off, `stores` is null and the write is refused (`:3171-3173`). Test `service-event-buffer.test.ts:79` PASS (command 2; write-only failure, fake `lastHash`). **Precondition not stated:** the append-mode gate at `:3133-3138` runs first for sessioned writes too. In a process that has not confirmed `agent_events` append mode, whose probe fails at that moment, and without `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER`, the write is refused as `APPEND_MODE_UNKNOWN` before the insert. | ✓ CONFIRMED, precondition missing (see wording points) |
| 4 | An append-mode refusal answers `stored: false` without queueing | `service.ts:3133-3138` (`appendOnly !== true && !allowDeduplicatingLedger`), before `bufferEvent`. | ✓ CONFIRMED |
| 5 | Cache on: a session's first write during an outage can be buffered; its next write is refused until the tip is readable (code read, not tested) | Cache hit: `lastHash` returns the cached tip with no read (`greptime.ts:1484-1485`). Insert fails; `insertEvent`'s catch forgets that session's tip (`greptime.ts:1287`) before rethrow. Buffered at `service.ts:3177`. Next write: cache miss, SELECT fails, refused (`service.ts:3126-3129`). If the session has no cached tip, the first write's SELECT fails and it is refused, which the preceding sentence ("for a session whose tip is not cached, the buffer does not hold the event") already states. Buffer-behind (`:3143`) applies only once a tip read answers. No test. | ✓ CONFIRMED by code read |
| 6 | A sessionless write reads no tip | `service.ts:3113` guard `this.greptime && sessionId`; `prev` stays null. Test `ledger-chain.test.ts:328` PASS (command 1), happy path only. | ✓ CONFIRMED |
| 7 | A sessionless write is buffered during an outage once append mode is confirmed in this process, or with `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` set, cache on or off | `ensureAppendMode` (`greptime.ts:1183-1192`): within `APPEND_MODE_TTL_MS` (30 s, `:297`) it returns the cached value with no probe; outside the TTL it probes (`liveAppendMode`, `:1233-1240`, `SHOW CREATE TABLE`); on a failed probe it returns `this.appendMode`, which keeps a confirmed `true` (`:1191`). `appendModeEnabled` (`:1201-1205`) stores `appendMode` only on a non-null answer. Boot `migrate()` calls it (`:1090`); an unreachable boot logs "could not confirm" (`:1097`). `service.ts:3133-3138` refuses when `appendOnly !== true` and the allow flag is off. The allow flag is `allowDeduplicatingLedger` (`config.ts:1194`, `^(1\|true\|yes)$`, case-insensitive). Insert failure then buffers (`:3155-3177`) with the cache on or off. No test covers a sessionless outage. | ✓ CONFIRMED by code read; wording nuance on the flag (see below) |
| 8 | (Owner fact) The cache-off clause "no session event is buffered during an outage" from the prior wording | Removed in `f86388cf`. The corrected clause is claim 3. | ✓ CLOSED by the rewrite |

**Verdict on the corrected sentence.** The mechanism and every refusal it names match the code at f86388cf. The overbroad clause from 97defd59 (claim 5 of the prior check) is fixed. Three wording points remain for the owner. I have not edited the doc.

1. **Sessioned insert-failure clause omits the append-mode gate.** "a session write whose tip is readable but whose insert fails is still buffered" is true once append mode is confirmed in the process (or `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` is on). It is refused as `APPEND_MODE_UNKNOWN` before the insert otherwise (`service.ts:3133-3138`). The sessionless clause states this precondition; the sessioned one should too. Suggested: "a session write whose tip is readable but whose insert fails is buffered once append mode is confirmed in this process, or with `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` set".
2. **The allow flag is a value, not a presence test.** "`SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` is set" should read "is set to `1`, `true` or `yes`" (`config.ts:1194`). Any other value, including `0` or `false`, does not allow the write.
3. **"every session write reads the tip first" is exact for writes only.** A keyed replay answered from the ledger or from the buffer (`service.ts:3097-3108`) returns before the read. These are replies, not writes, so the claim stands; the qualifier is optional.

Two further points for the owner, not wording of this bullet:

- The corrected sentence is tagged "Owner-accepted, 2026-11-03". I could not confirm that the owner accepted this exact text, which differs from the text 97defd59 recorded. Ratification of the corrected text is open.
- ROADMAP.md:1317 and :1424 still carry the overbroad sentence ("nothing is buffered during an outage"), and their cites are stale: the switch is `config.ts:2439` (the ROADMAP cites `:2424`, the TTL check); the refusal is `service.ts:3126-3129` (ROADMAP cites `:2996-2999`); `greptime.ts:776` is the comment on the null case. The owner updates ROADMAP.

**Tests covering these branches (targeted, this run).** Command 1: 6 pass (`service.test.ts:686, 866, 879, 1648`; `ledger-chain.test.ts:207, 328`). Command 2: 5 pass (`service-event-buffer.test.ts:79, 198, 319`; `event.test.ts:309` NUL refusal; `anchor.test.ts:1519` NUL refusal). No test covers: a real `GreptimeClient` read failure with the cache off; a sessionless write during an outage; a cache-on first write during an outage; a write-only failure with the cache off on the real client; a sessioned write in a process without confirmed append mode during an outage.

**NUL graph id on the write path (code read, plus the two tests above).** `normalizeEvent` runs in `build` (`service.ts:3123`) before the tip-error check and outside the `try` at `:3157`, and for keyed events at `:3103`. `GraphIdNulError` extends `InvalidEventError` and propagates out of `appendChained`. It is refused, not buffered and not stored, and nothing reaches `insertEvent`. No service-level write test covers it; the event and anchor tests cover the refusal at the normaliser and the pointer plan.

## Goal Achievement

### Observable Truths

| #   | Truth (criterion) | Status | Evidence |
| --- | ----------------- | ------ | -------- |
| 1   | A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash (SC 1) | ✓ VERIFIED within the accepted pre-send scope (PLAN D76-10). Holds only when the buffer is enabled (D76-15, open). | **Insert path.** `insertEvent` `service.ts:3155`; catch `:3157`; buffered `:3176-3177`. Enqueue `event-buffer.ts:229-281`; overflow evicts the oldest evictable entry `:233-239`. Backoff `eventBufferBackoffMs` `event-buffer.ts:40-44` (base 1 s, doubling, cap 60 s, ±20 % jitter). **Retry.** `drainEventBuffer` `service.ts:3236` → `drain` `event-buffer.ts:287-293` → `runDrain` `:307`; `deliverBuffered` `service.ts:3204`, `insertEvent(..., { mayExist: true })` `:3214`. **Give-up.** Dead-letter write `event-dead-letter.ts:102-122` through `onDeadLetter` `service.ts:2105`. |
| 2   | Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag (SC 2) | ✓ PASSED (override), not verified | **Reported.** `health()` `service.ts:8849`; `eventBuffer` at `:8912` (`enabled`, `EventBuffer.stats()` depth, max, oldestAt, durable, pending, and `deadLetter: { depth, durable }`). `/healthz` spreads the health body (`server.ts:985-1004`), memoised for `SUBSTRATE_HEALTHZ_CACHE_MS` (`config.ts:1217`). **Buffer bound by flag.** `SUBSTRATE_EVENT_BUFFER_MAX` (`config.ts:2623`; `flag-registry.ts:358`), enforced at `event-buffer.ts:229-233`. **Dead-letter bound:** none, by design (D76-13, owner override; `event-dead-letter.ts:11-12`). |

**Score:** 2/2 truths (1 VERIFIED within the accepted scope, 1 PASSED by owner override). Behaviour-unverified truths: 0.

**Behaviour-dependence.** SC1 is a state transition (queued, retried, given up with a record). Its behavioural evidence at f86388cf: command 2 ran `service-event-buffer.test.ts:79` (the SC1 insert-path test), `:198` (buffer unset, nothing queued) and `:319` (breaker-refused write keeps its budget). The wider set (`:97`, `:115`, `:128`, `:145`, `:164`, `:181`, G1 `event-dead-letter.test.ts:78`, G2 `:319`, G3 `:334`) passed at 97defd59. Those files are unchanged since, so the earlier pass carries over by content, not by a rerun at this commit.

**Coincidental-reliance (Step 3, 5c).** None flagged. The buffered tail's `prev` is fixed at queue time (`event-buffer.ts:12-16`, `:241`), not by fixture order.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-buffer.ts` | bounded per-session FIFO, backoff, give-up with write-ahead, file persistence, pending entries | ✓ VERIFIED with warnings | Enqueue `:229-281`; findKeyed `:190-192`; findPendingKeyed `:195-197`; drain `:287-293` (R-2, re-read); runDrain `:307`; abandonAll `:299-305` (R-3, re-read); hydrate `:438-465`; append 0600; compact 0600. Unchanged since 97defd59. |
| `packages/mcp-server/src/event-dead-letter.ts` | append-only dead-letter store, hash and reason, torn-tail safe write | ✓ VERIFIED (G1 closed) | `record` `:102-122` (hash `:108`, re-read; stderr `:119`); `writeHeld` `:136-156` (lead `:148`, re-read; mode 0600 `:149`, fresh-file chmod `:150`); `depth` `:92-94`. Deliberately unbounded (`:11-12`, re-read). Unchanged since 97defd59. |
| `packages/mcp-server/src/service.ts` | wiring, write path, buffering, drain, shutdown, health | ✓ VERIFIED (accepted scope D76-10 applies to the refusals) | Stores `:2095-2112` (`onDeadLetter` `:2105`; boot `ensureEventDrainTimer` `:2112`). `appendChained` `:3091`: keyed answers `:3096-3109`; tip read and refusal `:3113-3129`; append-mode refusal `:3133-3138`; buffer-behind `:3143-3152`; live write `:3155`; catch and buffer `:3157-3177`; `bufferEvent` `:3185`. `deliverBuffered` `:3204`. `drainEventBuffer` `:3236`. `drainPendingEvents` `:3248` (`abandonAll` `:3253`). `ensureEventDrainTimer` `:3256`. `closeLiveSession` `:2258` (close `:2263`, closeSession `:2265`, re-read). Emit gates `:2961`. Health `:8849`, eventBuffer `:8912`. |
| `packages/mcp-server/src/greptime.ts` | `insertEvent` with `mayExist`, breaker mapping, tip read, append-mode | ✓ VERIFIED (phase-76 lines unchanged) | `APPEND_MODE_TTL_MS` `:297`; `chainTips` `:798`; `sql` `:872`, `send` `:878`, breaker mapping `:907-908`; `probeDialect` `:949`; `ensureAppendMode` `:1183-1192`; `appendModeEnabled` `:1201-1205`; `migrate` append check `:1090`; `liveAppendMode` `:1233`; `insertEvent` `:1248-1296` (tip forget on INSERT error `:1287`); `eventRowPresent` `:1299`; `lastHash` `:1483-1501`. |
| `packages/mcp-server/src/config.ts` | buffer settings, boot refusals, chain-cache switch | ✓ VERIFIED | `loadEventBufferSettings` `:2604-2628`: refusal without a dead-letter path `:2608-2612`, refusal when both paths name one file `:2614-2618`, bounds `:2623-2624`. `loadLedgerSettings` `:2422`; chain-cache switch `:2439` (re-read); `ledger` wired `:1227` (re-read); allow-dedup flag `:1194` (re-read, `^(1\|true\|yes)$`); healthz cache `:1217`. |
| `packages/mcp-server/src/flag-registry.ts` | buffer flag rows | ✓ VERIFIED | `SUBSTRATE_EVENT_BUFFER_MAX` `:358`, `SUBSTRATE_EVENT_BUFFER_MAX_ATTEMPTS` `:360`. |
| `packages/mcp-server/src/server.ts` | `/healthz` body; `/events` carries `buffered` and `deadLettered` | ✓ VERIFIED | Memoised compute and body spread `:985-1004` (memo re-read `:985-991`); `buffered` and `deadLettered` `:1376-1377` (from the 9ab6f111 record; unchanged since 97defd59). |
| `packages/mcp-server/src/mcp.ts` | `events_emit` reply carries `buffered` and `deadLettered` | ✓ VERIFIED | `:1190-1202` (carried; unchanged since 97defd59). |
| `packages/mcp-server/src/index.ts` | shutdown drains the buffer | ✓ VERIFIED (wiring) / ? (timing, operator item 4) | Retain pass `drainPendingRetains` `:255` (re-read); `drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })` `:258` (re-read). Constants: flush 2 s `:219`, retain 10 s `:221`, transitions 5 s `:223` (re-read). |
| `packages/mcp-server/src/observe.ts` | (not phase-76 behaviour) | ✓ NOT IN PHASE-76 PATH | No buffer or dead-letter import. Listed in `covered_files` because it is on the tree. |
| `packages/mcp-server/src/event.ts` | payload wrap (PR 204); graph-id cap (phase 73); NUL refusal (`62a25181`) | ✓ VERIFIED (code); scalar payload wrap tested for arrays only | `asPayloadRecord` `:220-224`. `normalizeGraphId` `:227-233`: NUL refused (`GraphIdNulError`, `:215`, at `:230`), then the 512-byte cap. See Anti-Patterns. |
| `packages/mcp-server/src/anchor.ts` | pointer plans refuse a NUL graph id before the hour transaction (`62a25181`) | ✓ VERIFIED (code, phase-73 path); not a phase-76 write path | NUL check in `pointerPlans` `:556` (re-read), called at `:961` inside the refusal at `:964`; comment `:953-958`. Test `anchor.test.ts:1519` PASS (command 2). |
| `docs/greptime-ledger.md` (phase 76 section, `:961-979`) | flags and behaviour documented | ✓ VERIFIED with three wording points | Off by default `:963`; dead letters `:969`; standalone jobs `:974`; "not buffered" `:977` (corrected in `f86388cf`; the mechanism matches the code; wording points above); buffered `session.end` `:979`. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `appendChained` live write failure (insert) | `bufferEvent` → `EventBuffer.enqueue` | `service.ts:3157-3177` | ✓ WIRED | Breaker refusal enters with `attempts: 0` (G2, `:3176`). |
| `appendChained` tip read or append-mode probe refused | `bufferEvent` | none | ✓ NOT WIRED, BY OWNER-ACCEPTED SCOPE | Returns `stored: false` before the send (`service.ts:3126-3129`, `:3133-3137`). Recorded as accepted (PLAN D76-10). |
| `EventBuffer` give-up | `DeadLetterStore.record` | `service.ts:2105` (`onDeadLetter`) | ✓ WIRED | Return value is the store's `durable`. |
| drain pass | `deliverBuffered` → `insertEvent(mayExist)` | `service.ts:3236` → `:3204` (`insertEvent` `:3214`) | ✓ WIRED | Breaker `skipped` is not an attempt (`:3217`). |
| shutdown | `drainPendingEvents` | `index.ts:258` → `service.ts:3248` | ✓ WIRED | Timing is operator item 4 (R-2, R-3). |
| `/events` and `events_emit` | `buffered`, `deadLettered` reply keys | `server.ts:1376-1377`, `mcp.ts:1190-1202` | ✓ WIRED | Keys appear only when the buffer is on. |
| `health()` | `/healthz` body | `service.ts:8912` → `server.ts:985-1004` | ✓ WIRED | |
| `SUBSTRATE_EVENT_BUFFER_MAX` | buffer bound | `config.ts:2623` → `service.ts:2095-2110` → `event-buffer.ts:229` | ✓ WIRED | |
| dead-letter depth | bound flag | none | ✓ ACCEPTED (override) | No bound flag by design (D76-13). |
| buffer and dead-letter depth | metrics export (HARD-R3 wording) | none | ✗ NOT WIRED | Only `/healthz` carries depth. Open wording question (HARD-R3 cross-check). Not counted. |
| `lastHash` (cache off) | SELECT per sessioned write | `greptime.ts:1484` (`chainTips` null, `:798`) → `:1487` | ✓ WIRED | Test `ledger-chain.test.ts:207` PASS. |
| `ensureAppendMode` (every write's gate) | sessioned and sessionless writes | `service.ts:3133` → `greptime.ts:1183` | ✓ WIRED | Applies to both paths; the cache-off sentence states it for the sessionless path only. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `/healthz` `eventBuffer` | depth, max, oldestAt, durable, pending | `EventBuffer.stats()` over the live map (`event-buffer.ts:209-217`) | Yes | ✓ FLOWING |
| `/healthz` `eventBuffer.deadLetter` | depth, durable | `DeadLetterStore.depth()` (on file plus held, `event-dead-letter.ts:92-94`) | Yes | ✓ FLOWING |
| dead-letter record | `event_hash` | `event.hash` of the buffered entry (`event-dead-letter.ts:108`) | Yes | ✓ FLOWING |

### Step 4, Step 5 and Step 6 mechanical checks

- Step 4, `verify.artifacts`: not applicable. 76-01-PLAN declares no `must_haves` (grep count 0), so the verb's NO_INPUT (66) applies. Artifact status was taken from the Level 1 to 3 reads above.
- Step 5, `verify.key-links`: not applicable, same reason. Wiring was taken from the reads above.
- Step 2b: no `must_haves` in the PLAN. The must-haves are the two ROADMAP Success Criteria.
- Step 6: 76-01-PLAN declares no `requirements:`. HARD-R3 is ORPHANED (Requirements Coverage).

### Behavioral Spot-Checks

Run from the worktree, `TMPDIR=/root/src/worktrees/backups/gate-tmpfs`, `SUBSTRATE_TEST_PG_URL` unset, `--timeout 30000`. Two `bun test` commands.

| Command | Result | Status |
| ------- | ------ | ------ |
| `bun test --timeout 30000 -t "unreadable previous hash\|unreadable tip refuses\|not append-only\|append_mode cannot be confirmed\|CHAIN_CACHE=0\|sessionless events never wait" packages/mcp-server/src/service.test.ts packages/mcp-server/src/ledger-chain.test.ts` | 6 pass, 0 fail, 21 expect(), 2.11 s. Covers `service.test.ts:686, 866, 879, 1648` and `ledger-chain.test.ts:207, 328`. | ✓ PASS |
| `bun test --timeout 30000 -t "a failed write is buffered\|with the buffer unset\|a live write the breaker refused\|graph id with a NUL byte" packages/mcp-server/src/service-event-buffer.test.ts packages/mcp-server/src/event.test.ts packages/mcp-server/src/anchor.test.ts` | 5 pass, 0 fail, 22 expect(), 1.09 s. Covers `service-event-buffer.test.ts:79, 198, 319`, `event.test.ts:309`, `anchor.test.ts:1519`. | ✓ PASS |

Stderr lines in both runs are the expected logs from the refusal and buffer tests, not failures.

### Probe Execution

No probe is declared in 76-01-PLAN or 76-01-SUMMARY, and the phase is not a migration or tooling phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R3 (REQUIREMENTS.md:120) | none (ORPHANED: mapped to phase 76, not claimed by 76-01) | See cross-check below | ORPHANED, reported, not counted | Partly met; the metrics clause is not met as written. |

### HARD-R3 cross-check (not counted; owner wording decision open)

| Clause | Verdict | Evidence |
| ------ | ------- | -------- |
| Bounded queue with backpressure | Met as code (bounded; a full buffer refuses with `stored: false`) | `event-buffer.ts:229-281`, `service.ts:3189` |
| Exponential backoff and jitter | Met (per event, not per batch) | `event-buffer.ts:40-44` |
| Retain payload and error in a durable store | Met with the buffer on; durable only when saved | `event-dead-letter.ts:102-122` |
| Per-record dedupe makes replay idempotent | Partly. `mayExist` and the keyed replay cover a known id. R-1 (fresh row after a give-up) and keyless resends leave gaps. | `service.ts:3214` (`mayExist`); `:3102-3109` |
| Export queue depth and dead-letter metrics | ✗ NOT MET AS WRITTEN. Depth is in `/healthz` only. ROADMAP SC2 says "reported in /healthz", so the two texts differ. | `service.ts:8912`, `server.ts:985-1004` |
| Ordering and truthful acknowledgements | Met for ordering (`prev` fixed at queue time). Acknowledgements are truthful for the paths above, including the pre-send refusals (`stored: false`). | `event-buffer.ts:12-16`, `service.ts:3126-3129`, `:3133-3137` |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/service.ts` | 3113-3129, 3133-3137 | Every failed tip read and every failed append-mode probe is refused, not buffered | ⚠️ Warning (scope) | Owner-accepted 2026-11-03 (PLAN D76-10). Outage limit above. |
| `docs/greptime-ledger.md` | 977 | Sessioned insert-failure clause omits the append-mode precondition (`service.ts:3133` applies to sessioned writes) | ⚠️ Warning (doc) | Owner decides wording (wording point 1). |
| `docs/greptime-ledger.md` | 977 | `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` "is set" where the code reads a value of `1`, `true` or `yes` | ⚠️ Warning (doc) | Owner decides wording (wording point 2). |
| `docs/greptime-ledger.md` | 977 | "every session write reads the tip first" omits keyed replays that return before the read | ℹ️ Info (doc) | Writes only; optional qualifier (wording point 3). |
| `.planning/ROADMAP.md` | 1317, 1424 | "nothing is buffered during an outage" repeats the overbroad claim; cites `service.ts:2996-2999`, `config.ts:2424`, `greptime.ts:776` | ⚠️ Warning (doc) | Stale: the refusal is at `service.ts:3126-3129`, the switch at `config.ts:2439`. Owner decides and updates. |
| `packages/mcp-server/src/greptime.ts` | 1287 | A failed event-row insert forgets that session's cached tip | ⚠️ Warning (outage limit) | Intended (a timed-out insert may have landed). With the cache on, the session's next write is refused during an outage. Now stated in the doc's cache-on clause. |
| `packages/mcp-server/src/greptime.ts` | 1191 | A failed append-mode check returns the previous confirmed value | ℹ️ Info | Lets sessionless writes buffer during an outage once append-mode is confirmed (30 s TTL, `:297`). |
| `packages/mcp-server/src/event.ts` (via `service.ts:3123` `build`) | — | A graph id over 512 bytes or with a NUL byte throws (`GraphIdTooLongError`, `GraphIdNulError`) before the buffer catch | ℹ️ Info | Refused as an invalid event, not buffered and not stored. Phase 73 cap and `62a25181`; not a phase 76 loss path. |
| `event-buffer.ts` | 287-293 | R-2: `drain` returns the in-flight pass and drops `options.all` | ⚠️ Warning | Shutdown can join a periodic pass and skip entries not yet due. Open. Operator item 4. |
| `event-buffer.ts` | 299-305 | R-3: `abandonAll` clears the entry in flight; an in-flight entry that lands is recorded `abandoned` | ⚠️ Warning | Open. Reached only when the buffer is not durable (`service.ts:3253`). Duplicate, not loss. Operator item 4. |
| `docs/greptime-ledger.md` | 979 | buffered `session.end` residual | ⚠️ Warning | Docs match the code. PLAN D76-14 and D76-19 wording differs (operator item 5). Owner ratification open. |
| `packages/mcp-server/src/service.test.ts`, `ledger-chain.test.ts` | — | No buffer-on test of the refusal branches; no real-client cache-off outage test; no sessionless outage test; no sessioned append-mode-unconfirmed outage test | ℹ️ Info | The refusal tests are fake-based and passed. |
| `packages/mcp-server/src/event.ts` | 220-224 | Scalar payload wrap not directly tested (arrays only) | ℹ️ Info | Note only. |

Debt markers (`TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER`) in the phase-76 implementation and test files: none in the files changed since 97defd59 (`event.ts`, `anchor.ts`, `event.test.ts`, `anchor.test.ts`, `docs/greptime-ledger.md`). The Step 7 debt-marker gate is clean for the covered set.

**Residuals (at-least-once duplicates), documented in code:** `event-dead-letter.ts:99-100` (`record`), `:133-134` (`writeHeld`); `event-buffer.ts:350-353` (`settlePending`). Both copies carry the same event id and hash.

**Warnings (not must-have failures; kept open):**

- R-1: keyed replay after a give-up. Trigger A (one new row with a new id) is the common case and lands once. Trigger B (two rows) is not reproduced. G3 closes the pending-state answer only (operator item 6).
- R-2: `drain` joins an in-flight pass and drops `options.all` (`event-buffer.ts:287-293`; periodic tick `service.ts:3256-3260`; shutdown `service.ts:3248-3253`).
- R-3: an in-flight entry abandoned at shutdown can be recorded `abandoned` and still land (`event-buffer.ts:299-305`, called at `service.ts:3253`).
- `abandonAll` on an unsaved buffer (`service.ts:3253`): the abandoned entries are not compacted out of the file, so they can return at the next boot. Not reproduced.
- Shutdown bound: the retain pass (10 s, `index.ts:255`) and the event pass (10 s, `index.ts:258`, only when the buffer holds entries) run in sequence, before the transition pass (5 s) and the flush (2 s).
- Outage limit (D76-10): see the scope section and the cache-off check.

## Deferred Items

None. Phases 77 and 78 do not mention dead-letter, buffer, torn-write or breaker behaviour in their ROADMAP text.

## Advisory (New Scope, Unevidenced)

None. Initial mode; no new-scope findings.

## Human Verification Required

Items 1 to 8 in the frontmatter, which are operator items 1 to 8. They are operator proofs and owner decisions, and none is counted as verified. Item 1 now also carries a sessioned write in a process that has not confirmed append mode, because the append-mode gate applies to sessioned writes too.

**Why human_needed.** No must-have is FAILED. No artifact is missing or a stub, and no key link required by the in-scope SC1 path is unwired. No blocker anti-pattern remains. Human items exist, so the decision tree routes the status to `human_needed`. The doc wording points are warnings, not blockers: the behaviour is correct under the accepted scope, and the wording is the owner's to fix.

## Open decisions (kept open; none upgraded to verified)

| Decision | State | Where |
| -------- | ----- | ----- |
| PLAN D76-10: pre-send refusals (any tip-read failure, any append-mode probe failure) are not buffered | Recorded as accepted by the owner on 2026-11-03 as the SC1 boundary (not independently confirmed here). The cache-off sentence's three wording points are the owner's to decide. | `service.ts:3113-3138`; `docs/greptime-ledger.md:977`; PLAN 76-01 D76-10 |
| Cache-off sentence (`f86388cf`): sessioned write reads the tip, failed read refused, insert failure buffered, cache-on first write, sessionless buffered once append mode is confirmed or allowed | Mechanism CONFIRMED at f86388cf. Wording needs the owner's ratification of the exact text and three precision points (sessioned append-mode precondition; allow flag value; replays are not writes). This record does not edit docs. | `docs/greptime-ledger.md:977`; `ROADMAP.md:1317, 1424` |
| D76-13: dead-letter store unbounded; depth reported, no flag | Owner override recorded 2026-11-02, a tracked follow-up. Carried as PASSED (override), NOT verified. KEPT OPEN for ratification. | Must-have 2; `event-dead-letter.ts:11-12` |
| D76-15: buffer is opt-in (off by default) | OPEN, operator decision. Criterion 1 holds only when enabled. | Operator item 7; `docs/greptime-ledger.md:963` |
| D76-14 / D76-19: buffered `session.end` and steering session | OPEN. Code closes the session first and buffers the note; PLAN wording (session stays open until the note lands) differs from the code. Owner has not ratified. | Operator item 5; `service.ts:2263-2265`; `docs/greptime-ledger.md:979` |
| HARD-R3 "export queue depth/dead-letter metrics" vs ROADMAP SC2 "reported in /healthz" | OPEN, owner: which wording governs | HARD-R3 cross-check; `.planning/REQUIREMENTS.md:120` |
| R-1: keyed replay after a give-up, Trigger A vs B | OPEN. G3 closed the pending state; the live check is still needed. | Operator item 6 |
| R-2: shutdown joins a periodic pass | OPEN. Confirmed by reading at f86388cf. | Operator item 4 |
| R-3: in-flight entry abandoned at shutdown | OPEN. Confirmed by reading at f86388cf. | Operator item 4 |
| Operator rehearsal of the outage limit (including the sessionless, write-only, and sessioned append-mode-unconfirmed cases) | OPEN. | Operator item 1 |
| Operator items 2 to 8 | OPEN. | Human verification items 2 to 8 |

## Corrections to the previous report (97defd59 record)

1. **`abandonAll` call site.** `service.ts:3253` (the prior record said 3252). The `drainPendingEvents` signature is `:3248`; `abandonAll` is on the line after the `stopEventDrain` call.
2. **Cache-off sentence.** The 97defd59 wording's claim 5 ("no session event is buffered during an outage") is replaced at `f86388cf` by the write-only buffering statement, which matches the code. The sessioned append-mode precondition is still missing (wording point 1).
3. **Sessionless precondition.** Unchanged from the prior record: a sessionless write buffers during an outage only once append mode is confirmed in this process, or with the allow flag set to `1`, `true` or `yes`.
4. **Append-mode gate scope.** The gate at `service.ts:3133` applies to sessioned writes too. The prior cache-off discussion (claim 5) did not state that precondition for a sessioned write.
5. **Outage rule (cached tip).** Unchanged: a session with a cached tip buffers its first write when the insert fails; its next write is refused until a tip read answers.
6. **Test run.** The 97defd59 run was 6 + 3 tests. This run is 6 + 5 tests at f86388cf: the 97defd59 set plus `event.test.ts:309` and `anchor.test.ts:1519` (NUL refusal, `62a25181`).

## Gaps Summary

No gaps under the accepted scope. SC1 is verified within the owner-accepted pre-send scope (PLAN D76-10) and applies when the buffer is enabled (D76-15, open). SC2 is passed by the owner's override (D76-13), which stays open for ratification and is not verified. The status is `human_needed` because the operator items remain open (outage rehearsal including the write-only, sessionless and append-mode-unconfirmed cases; dead-letter exhaustion; torn-tail crash; shutdown timing; buffered `session.end` ratification; R-1 live check; D76-15 enable decision; `/healthz` staleness), and because the cache-off sentence needs the owner's ratification and three wording points. The HARD-R3 metrics wording is an open owner question.

## Self-check

- Status matches the decision tree: no FAILED truth, no missing or stub artifact, no unwired in-scope key link, no debt marker in the changed files. Human items exist, so `human_needed`, and `passed` is not valid.
- `covered_files` and `covered_digest` are copied from `gsd_run query verification.fingerprint .planning/phases/76-telemetry-buffer-and-dead-letter <files>` output at f86388cf, run from the worktree root, not hand-written. The file list passed to the command was the prior `covered_files` minus the two phase-76 PLAN/SUMMARY entries (the command adds those itself), plus `anchor.ts` and `anchor.test.ts`, which this run executed.
- Targeted tests: exactly two `bun test` commands, both recorded above with pass counts (6 and 5). No full suite, tsc, lint or formatter was run. No Postgres test was run.
- No code, test, ROADMAP or doc change was made, and no commit. The only file written is this VERIFICATION.md, in the worktree.
- Citations re-read at f86388cf in this run: `service.ts` 2263-2265, 2961, 3091-3253, 3256, 8912; `greptime.ts` 297, 798, 1183-1205, 1233, 1268-1287, 1483-1499; `config.ts` 1194, 1227, 2439, 2604-2624; `event-buffer.ts` 287-293, 299-305; `event-dead-letter.ts` 11-12, 102-108, 148-150; `index.ts` 219-223, 255-258; `server.ts` 985-991; `event.ts` 215-233; `anchor.ts` 553-556, 961-964; `docs/greptime-ledger.md` 961-979 via `git show f86388cf`. Other citations are carried from 97defd59 for files with an empty `git diff` since then.
- Open items kept open: D76-13, D76-15, D76-14/19, R-1, R-2, R-3, operator items 1 to 8, and the owner's ratification of the corrected cache-off text.
