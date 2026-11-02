---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-02T16:01:05Z
status: human_needed
score: 1/2 must-haves verified, 1/2 passed by owner override (not verified)
tree: gsd/v18-int-all @ 7382ad10
implementation_commit: 327e7c8d (ancestor of 7382ad10)
criteria_source: origin/main .planning/ROADMAP.md, "### Phase 76: Telemetry buffer and dead-letter", Success Criteria 1 and 2
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag."
    reason: "Owner accepted the override on 2026-11-02. The dead-letter store is deliberately unbounded (plan decision D76-13): a bound would have to drop records, the silent loss this phase removes. The buffer is bounded by SUBSTRATE_EVENT_BUFFER_MAX, and the depth of both stores is reported in /healthz. A dead-letter cap is a tracked follow-up."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
human_verification:
  - test: "Live GreptimeDB rehearsal: block the ledger and emit a sequence for one session; restore."
    expected: "503 with buffered: true, stored: false; /healthz eventBuffer.depth rises; after restore each event lands once, in chain order, each with an event_ingest row. Also checks the mayExist exact-ts predicate (greptime.ts:1297-1304) against real timestamp precision."
    why_human: "Needs a live GreptimeDB and a real outage."
  - test: "Dead-letter exhaustion on a live outage (nominal budget 243 s; 195 to 292 s with jitter)."
    expected: "Dead-letter line written (event-dead-letter.ts:109), file mode 0600 (event-dead-letter.ts:125-126)."
    why_human: "Needs a live outage longer than the retry budget. The boot refusal without SUBSTRATE_EVENT_DEAD_LETTER_PATH is covered by a test (service-event-buffer.test.ts:220-222), not by this item."
  - test: "Restart during an outage: stop with entries waiting and a durable file."
    expected: "The next boot reports the depth (service.ts:1972 starts the drain timer when the file holds entries) and drains the entries once."
    why_human: "Needs a process restart against a durable file on a real host."
  - test: "Shutdown under the service manager: index.ts:252 drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })."
    expected: "Finishes within the unit's stop bound with a durable buffer. Check R-2 and R-3 here. The bounds stack: the retain pass (index.ts:249, up to 10 s) runs before the event pass (up to 10 s), then transitions (5 s) and flush (2 s). substrate-host.service:59 sets TimeoutStopSec=15 (staged, operator-gated install). Worst-case stop exceeds 15 s, so SIGKILL can land mid-pass."
    why_human: "Needs the real service manager and its shutdown timing."
  - test: "Buffered session.end on a live steering session (D76-14, D76-19)."
    expected: "The documented behaviour (\"steering stays open until the event lands\") does NOT match the code. The session is closed durably before the event is written (service.ts:2123 closeLiveSession authority.close, then the emit at :2126; updateLiveSession transition then emit at :2098). Confirm the actual outcome: the session is closed; event_stored is false; the wake-up hint is withheld (publishHint runs only on a stored event, service.ts:2821 and deliverBuffered :3059). Decide whether code or doc is right (open decision, see below)."
    why_human: "Needs a live steering session."
  - test: "Keyed replay after a dead-letter record (R-1) on a live collector spool."
    expected: "Confirm which trigger occurs: Trigger A (one new row with a new id; the dead-letter record is orphaned) or Trigger B (two rows)."
    why_human: "Needs a live collector spool and ledger."
  - test: "Operator decision to enable the buffer (D76-15)."
    expected: "Criterion 1 holds only with SUBSTRATE_EVENT_BUFFER_PATH and SUBSTRATE_EVENT_DEAD_LETTER_PATH set. With the buffer unset, a failed write answers stored: false and nothing is queued (service.ts:3021-3023). Operator must make and record this decision."
    why_human: "Configuration and policy decision, not code-verifiable."
  - test: "/healthz staleness."
    expected: "The body is memoised for SUBSTRATE_HEALTHZ_CACHE_MS (default 5000, config.ts:1201, server.ts:991-993). Pollers see a depth change within that window."
    why_human: "Needs a running server and a poller."
---

# Phase 76: Telemetry buffer and dead-letter Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently. (origin/main ROADMAP, Phase 76)
**Verified:** 2026-11-02T16:01:05Z
**Status:** human_needed
**Re-verification:** Yes, fresh record on the integration tree. The 76-VERIFICATION.md on the phase branch was stale: its line numbers do not match this tree, and its claim about buffered `session.end` is contradicted by the code (see Gaps and Warnings).

**Criteria source:** origin/main `.planning/ROADMAP.md`, the section from `### Phase 76` to the next `### Phase`. Two Success Criteria. The ROADMAP's own status line on origin/main still reads "Not started" and "Plans: none written"; that is stale. The phase's PLAN (76-01-PLAN.md) has no `must_haves` frontmatter, so the ROADMAP criteria are the must-haves.

**Integration facts:** Phase 76 does not depend on the live-session facade. Its buffer, dead-letter, drain and health code never reads `liveSessions`. The lazy getter from 634b6171 (`service.ts:1654`) leaves the buffered emit path unchanged. The one place it touches phase 76 is the live close (`service.ts:2118-2129`), which still calls the same authority, now through the getter. The settle() change (live-session-consumer.test-support.ts) is not imported by the phase 76 tests (service-event-buffer.test.ts imports only config, service and types). Both tests were judged on this tree.

**Gates:** not re-run here. The orchestrator's full gate on this tree is GREEN (`/root/src/worktrees/backups/gates-int-r5.log`). Only the targeted commands below were run.

## Goal Achievement

### Observable Truths

| #   | Truth (criterion) | Status | Evidence |
| --- | ----------------- | ------ | -------- |
| 1 | A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash (SC 1) | ✓ VERIFIED (buffer on; enablement is open decision D76-15) | Entry: `service.ts:3019-3025`; with the buffer off, `service.ts:3021-3023` answers `stored: false` and queues nothing. Queue behind an earlier buffered event of the session: `service.ts:2993-3002`, `prev` is the buffered tail (`event-buffer.ts:190`). Bound: `event-buffer.ts:183`, max from `SUBSTRATE_EVENT_BUFFER_MAX`, default 256 (`config.ts:2601`, `flag-registry.ts:358`). Backoff: `event-buffer.ts:37-41`, next retry `:195` and `:257`, delays 1, 2, 4, 8, 16, 32, 60, 60, 60 s (243 s nominal). Drain on a 1 s tick: `service.ts:3090-3096`, delivery `deliverBuffered` `service.ts:3046-3061` with `insertEvent(..., { mayExist: true })` at `:3054`. Budget exhaustion: `event-buffer.ts:253-255` → `dropFrom(…, "exhausted")`. Dead-letter record with hash: `event-dead-letter.ts:92-112` (`event_hash` at `:98`), wired at `service.ts:1961-1971`. Test run this session: `service-event-buffer.test.ts` "a failed write is buffered, not dropped…" (`:70`) and "a write that exhausts its budget is dead-lettered with its hash and its reason" (`:119`), 11 pass in the file. |
| 2 | Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag (SC 2) | ✓ PASSED (override), not verified | **Reported (met, verified):** `service.ts:8667` sets `health().eventBuffer` to `{ enabled, ...stats(), deadLetter: { depth, durable } }`. `stats()` at `event-buffer.ts:161-167`. `/healthz` spreads the health body at `server.ts:1002`. Test "the health body reports the buffer's depth and the dead-letter depth, each with its durability" (`service-event-buffer.test.ts:208`) passes. **Buffer bounded by a flag (met, verified):** `SUBSTRATE_EVENT_BUFFER_MAX` (`config.ts:2601`, `flag-registry.ts:358`), enforced at `event-buffer.ts:183` and on hydrate at `:338`. Tests: the overflow test with `SUBSTRATE_EVENT_BUFFER_MAX: "3"` (`service-event-buffer.test.ts:136`), flag parsing and fallback (`:225-229`), and `event-buffer.test.ts` "over the bound the oldest entry is given up with a record" (`:71`), all pass. **Dead-letter bounded by a flag (not met as written; accepted override):** `event-dead-letter.ts:11-12` states the store is deliberately unbounded (D76-13). No flag exists for it. Override: "Owner accepted the override on 2026-11-02 … A dead-letter cap is a tracked follow-up." — accepted by owner on 2026-11-02. Carried as PASSED (override); it is NOT counted as verified. |

**Score:** 1 verified, 1 passed by override (not verified), 0 failed, 0 present-behaviour-unverified. Must-haves: 2.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-buffer.ts` | bounded per-session FIFO, backoff, drop causes, file persistence | ✓ VERIFIED | 383 lines. `enqueue` `:179-209`, `drain` `:215-221`, `runDrain` `:231-261`, `dropFrom` `:292-304`, `hydrate` `:317-344`, `compact` `:364-377`. Tests: `event-buffer.test.ts` (run: 22 pass across three files, see below). |
| `packages/mcp-server/src/event-dead-letter.ts` | append-only dead-letter store with hash and reason | ✓ VERIFIED | Reasons `:29-30`; record `:92-112`; `flush` 0600 `:120-132`; `durable` `:83-85`. Deliberately unbounded (`:11-12`), accepted as override. |
| `packages/mcp-server/src/service.ts` | wiring, write path, buffering, drain, shutdown, health | ✓ VERIFIED | Construction `:1955-1973`; live-session getter `:1654`; `emit` `:2794-2823`; `withSessionTurn` `:2887-2899`; `replayOutcome` `:2916-2949`; `appendChained` `:2951-3027`; `bufferEvent` `:3033-3039`; `deliverBuffered` `:3046-3061`; `drainEventBuffer` `:3070-3076`; `drainPendingEvents` `:3082-3088`; health `:8667`. |
| `packages/mcp-server/src/greptime.ts` | `insertEvent` with `mayExist` | ✓ VERIFIED | `insertEvent` `:1248-1288`, `mayExist` branch `:1262-1266`, `eventRowPresent` `:1291-1294`, `cellWhere` `:1297-1304`. Test group "insertEvent with mayExist" (`greptime.test.ts:241`) run with `-t` (see below). |
| `packages/mcp-server/src/config.ts` | buffer settings, parsing, boot refusal without dead-letter path | ✓ VERIFIED | `loadEventBufferSettings` `:2584-2606`; refusal `:2592-2597`; defaults `:2601-2604`; wired at `:1226`; `healthzCacheMs` `:1201`. |
| `packages/mcp-server/src/flag-registry.ts` | buffer flag rows | ✓ VERIFIED | `:358-363`. `flag-registry.test.ts` and `scripts/config-reference.test.ts` pass (38 pass). |
| `packages/mcp-server/src/server.ts` | `/healthz` carries the health body | ✓ VERIFIED | Memoised compute `:994-1025`; body spreads `health` at `:1002`. |
| `packages/mcp-server/src/index.ts` | shutdown drains the buffer | ✓ VERIFIED (wiring) / ? (timing, human) | `SHUTDOWN_RETAIN_MS` `:215`; `drainPendingEvents(..., { abandon: true })` `:252`. |
| `packages/mcp-server/src/reanchor-run.ts` | isolated config nulls the buffer | ✓ VERIFIED | `:279` `eventBuffer: null`. |
| `docs/config-reference.md`, `docs/greptime-ledger.md`, `.env.example` | flags documented | ✓ VERIFIED with two inaccuracies | Flags documented: `config-reference.md:80-85`, `greptime-ledger.md:945-989`, `.env.example:38-46`. Inaccurate: `greptime-ledger.md:951` ("about five minutes"; the nominal sum is 243 s, about four minutes) and `greptime-ledger.md:958` (buffered `session.end` residual; see Gaps). |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `appendChained` write failure | `bufferEvent` → `EventBuffer.enqueue` | `service.ts:3019-3025` | ✓ WIRED | |
| `EventBuffer` give-up | `DeadLetterStore.record` | `service.ts:1969` (`onDeadLetter`) | ✓ WIRED | |
| drain pass | `deliverBuffered` → `insertEvent(mayExist)` | `service.ts:3073`, `:3054` | ✓ WIRED | |
| shutdown | `drainPendingEvents` | `index.ts:252` → `service.ts:3082` | ✓ WIRED | |
| `health()` | `/healthz` body | `service.ts:8667` → `server.ts:1002` | ✓ WIRED | |
| `SUBSTRATE_EVENT_BUFFER_MAX` | buffer bound | `config.ts:2601` → `service.ts:1964` → `event-buffer.ts:183` | ✓ WIRED | |
| dead-letter depth | bound flag | none | ✓ ACCEPTED (override) | No bound flag by design (D76-13). Not counted as NOT_WIRED. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `/healthz` `eventBuffer` | depth, max, oldestAt, durable | `EventBuffer.stats()` over the live map | Yes | ✓ FLOWING |
| `/healthz` `eventBuffer.deadLetter` | depth, durable | `DeadLetterStore.depth()` (on file + held) | Yes | ✓ FLOWING |
| dead-letter record | `event_hash` | `event.hash` of the buffered entry | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command (run from the integration worktree, TMPDIR=`/root/src/worktrees/backups/gate-tmpfs`, no Postgres) | Result | Status |
| -------- | ------- | ------ | ------ |
| Command 1 (whole phase-76 service file, 11 tests incl. retry, exhaust, overflow, keyed replay, restart, buffer-off, health, boot refusal, flag bound) | `bun test packages/mcp-server/src/service-event-buffer.test.ts` | 11 pass, 0 fail, 35 expect() | ✓ PASS |
| Command 2 (unit and greptime `mayExist`, by name) | `bun test packages/mcp-server/src/event-buffer.test.ts packages/mcp-server/src/event-dead-letter.test.ts packages/mcp-server/src/greptime.test.ts -t "EventBuffer\|DeadLetterStore\|eventBufferBackoffMs\|insertEvent with mayExist"` | 22 pass, 0 fail, 182 filtered out, 52 expect() | ✓ PASS |
| Command 3 (flag registry and config reference) | `bun test packages/mcp-server/src/flag-registry.test.ts scripts/config-reference.test.ts` | 38 pass, 0 fail, 298 expect() | ✓ PASS |

No PG-gated test was selected; none skipped. Three bun test commands in total, all serial. The full suite, tsc, lint and formatters were not run.

### Probe Execution

Not applicable. No probe is declared in the PLAN or SUMMARY, and the phase is neither a migration nor tooling.

### Requirements Coverage

No requirement IDs in the PLAN (`requirements:` absent). `.planning/REQUIREMENTS.md` has no Phase 76 row.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/event-dead-letter.ts` | 11-12 | dead-letter store deliberately unbounded | ℹ️ Info (accepted override) | Root of must-have 2's dead-letter half; carried as PASSED (override). |
| `packages/mcp-server/src/event-buffer.ts` | 215-221 | R-2: `drain` returns the in-flight pass and drops `options.all` | ⚠️ Warning | Shutdown can join a periodic pass and skip entries not yet due. See R-2. |
| `packages/mcp-server/src/event-buffer.ts` | 224-229 | R-3: `abandonAll` does not exclude the entry in flight (`this.flying`, set at `:237`) | ⚠️ Warning | An entry delivered after its `abandoned` record is written can land while carrying an `abandoned` record. See R-3. |
| `packages/mcp-server/src/service.ts` | 2118-2129, 2092-2098 | Steering session closed durably before the event is written | ⚠️ Warning (doc contradicted) | Contradicts D76-14 / D76-19 / `greptime-ledger.md:958`. See Gaps. |
| `packages/mcp-server/src/service.ts` | 2951-2958, 3004-3006 | R-1: keyed replay after a give-up writes a fresh row (new id) | ⚠️ Warning | Possible second row, not reproduced. See R-1. |
| `docs/greptime-ledger.md` | 951 | "The defaults ride out an outage of about five minutes" | ⚠️ Warning | 243 s nominal (195 to 292 s with jitter): about four minutes. |

Debt markers (`TODO`, `FIXME`, `XXX`, `HACK`, `PLACEHOLDER`) in the phase-76 files: none. `return null` and `=> {}` hits are sentinels, not stubs.

**R-1 (keyed replay after a give-up).** Event ids are random per `normalizeEvent` call (`event.ts:282`, `evt_${randomUUID()}`), and `ts` defaults to now (`event.ts:278`).
- *Trigger A (lands once, new id; record orphaned).* Event E (key K, id X, hash H) is dead-lettered and never lands. A spool replay carries the same key (`x-substrate-replay`, the collector spool, `packages/collectors/src/emit.ts:33`). `replayOutcome` (`service.ts:2916-2949`) finds no ledger row. The buffer no longer holds E, so `findKeyed` (`service.ts:2959-2960`) misses. `appendChained` builds a fresh event (new id, new hash, `prev` = ledger tip, `:2961-2974`) and writes it with `insertEvent(event)`, no `mayExist` (`:3005`). Result: one row, new id and hash. The dead-letter record (X/H) never matches a ledger row.
- *Trigger B (duplicate).* The original write committed after the substrate gave it up, or during the shutdown abandon (`service.ts:3085-3087`). The replay's ledger lookup runs before the commit, and the buffer no longer holds the entry. Then both rows exist with the same `_ik` and different ids.
- *Landed row visible (no duplicate).* When the original landed and the replay carries its `ts`, `findByIdempotencyKey` finds it and the reply is `deduplicated` (`service.ts:2931`).
- *Edge.* `checkReplayTs` refuses a keyed replay without `ts` only when the replay header is set (`event.ts:145-147`, `service.ts:2852`). A keyed request without the header and without `ts` runs the lookup with `ts` = now and misses. Not exercised.

**R-2 (shutdown coalesced into a periodic pass).** Confirmed by reading. `EventBuffer.drain` returns `this.draining` while a pass is in flight and drops `options.all` (`event-buffer.ts:215-221`). The periodic timer calls `drainEventBuffer()` with no options (`service.ts:3090-3096`). The shutdown call with `all: true` (`service.ts:3085`) joins that pass, so entries not yet due are not attempted. With `abandon` and a non-durable buffer, `abandonAll` gives them up with records (`:3087`), so nothing vanishes unrecorded. A durable buffer keeps them for the next boot.

**R-3 (in-flight entry abandoned at shutdown). New in this pass; not reproduced.** `drainPendingEvents` races the drain against `Bun.sleep(timeoutMs)` (`service.ts:3085`), then calls `abandonAll()` for a non-durable buffer (`:3087`). `abandonAll` (`event-buffer.ts:224-229`) clears every entry, including the one `runDrain` is delivering (`flying`, set `:237`). If the delivery is still running after the bound and then lands, the ledger holds the row and the dead-letter file holds an `abandoned` record for the same event. Afterwards `runDrain` may write a second record (`exhausted` via `dropFrom`). The record is then inaccurate about a landed event; nothing is silently lost.

**Gaps (documented behaviour contradicted by code).**
- *Documented residual D76-14 / D76-19 / `greptime-ledger.md:958` is contradicted by the code.* The plan and the doc say a buffered `session.end` "does not close its steering session until it lands". The code closes the session first and writes the event after: `closeLiveSession` calls `this.liveSessions.close` (`service.ts:2123`), clears the waiters (`:2125`), then emits (`:2126`). `updateLiveSession` mutates through the authority and emits afterwards (`:2092-2098`). The buffered event only changes the reply's `event_stored` and withholds the wake-up hint and the docs canary. This is not a criterion failure (the criteria are about event durability), but the residual is stated wrongly, and human item 5's "expected" as written cannot hold. Open decision: fix the code (gate the close on the write) or correct the doc. Not decided here.
- No new criterion failure. The deficit against SC 2 is the dead-letter bound, and it is the accepted override.

**Warnings (not must-have failures):**
- R-1: keyed replay after a give-up can write a fresh row with a new id (Trigger A, the common case, lands once). A second row happens only in Trigger B. Not reproduced.
- R-2: a shutdown pass can join a periodic pass and skip entries not yet due. Nothing vanishes unrecorded for a non-durable buffer.
- R-3: an entry in flight at a shutdown `abandon` can be recorded `abandoned` and still land. Not reproduced.
- Shutdown bound: the retain pass (10 s) and the event pass (10 s) run in sequence (`index.ts:249-252`), before the transition pass (5 s) and flush (2 s). The staged unit sets `TimeoutStopSec=15` (`infra/vps/substrate-host.service:59`). An unsaved buffer that is SIGKILLed mid-pass loses its entries with no record. This is only reachable with a failed save (`unsaved`), since the file is current otherwise. Not reproduced.
- The outage tolerance in `docs/greptime-ledger.md:951` is overstated (about four minutes, not five).

## Deferred Items

None. Phases 77 (steering idempotency) and 78 (cross-layer reconciliation) do not cover the dead-letter bound.

## Open decisions (kept open; none upgraded to verified)

| Decision | State | Where |
| -------- | ----- | ----- |
| D76-15: buffer is opt-in (off by default) | OPEN, operator decision. Criterion 1 holds only when enabled. | Human item 7; `greptime-ledger.md:947` |
| D76-13: dead-letter store unbounded; depth reported, no flag | Owner override recorded 2026-11-02; a tracked follow-up. Carried as PASSED (override), NOT verified. | Must-have 2; `event-dead-letter.ts:11-12` |
| D76-14 / D76-19: buffered `session.end` and steering session | OPEN. Documented behaviour contradicted by the code (see Gaps). | Human item 5; `greptime-ledger.md:958` |
| R-1: keyed replay after a give-up | OPEN. Not reproduced; live check needed. | Human item 6 |
| R-2: shutdown joins a periodic pass | OPEN. Confirmed by reading. | Human item 4 |
| R-3: in-flight entry abandoned at shutdown | OPEN. Not reproduced. | Human item 4 |

## Human Verification Required

Items 1 to 8 in the frontmatter. They route the status to `human_needed`. No truth is FAILED; the dead-letter bound is an accepted override, so the status is not `gaps_found`. The live items are operator proofs and are not counted as verified.

## Gaps Summary

No FAILED truths. Must-have 2's dead-letter bound is not met as written (D76-13), and the owner override is recorded as the single entry under `overrides:`. It is carried as PASSED (override) and not as verified. The override covers no other must-have.

The documented buffered `session.end` residual is contradicted by the code (see Gaps). Status is `human_needed` because the live items above remain, and because the session.end decision is open.

---

_Verified: 2026-11-02T16:01:05Z_
_Verifier: Claude (gsd-verifier, integration pass on gsd/v18-int-all)_
