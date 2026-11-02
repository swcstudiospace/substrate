---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-02T02:10:28Z
status: gaps_found
score: 1/2 must-haves verified
covered_files: [".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-PLAN.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-SUMMARY.md", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-buffer.test.ts", "packages/mcp-server/src/event-buffer.ts", "packages/mcp-server/src/event-dead-letter.test.ts", "packages/mcp-server/src/event-dead-letter.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/reanchor-run.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:373e1485d5da17efa70d422f94220b9039d3f4eb505b9c3d8c80e1b3a943ab03"
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag"
    status: failed
    reason: "Buffer depth is reported and bounded by SUBSTRATE_EVENT_BUFFER_MAX. Dead-letter depth is reported but no flag bounds it: the store is deliberately unbounded (plan decision D76-13). No override exists, and none was added."
    artifacts:
      - path: "packages/mcp-server/src/event-dead-letter.ts"
        issue: "Header lines 11-12 state the store is deliberately not bounded. DeadLetterStore (lines 66-162) has no depth limit; depth() (87-89) only reports."
      - path: "packages/mcp-server/src/flag-registry.ts"
        issue: "The buffer flag rows (339-344) include no flag that bounds dead-letter depth."
    missing:
      - "A flag-controlled bound on dead-letter depth, as the must-have text requires. D76-13 argues a bound would have to discard records. That conflict needs an owner decision: a bound with an explicit policy for records at the bound, or an owner-accepted override of criterion 2. Not decided here."
---

# Phase 76: Telemetry buffer and dead-letter Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently. (ROADMAP Phase 76)
**Verified:** 2026-11-02T02:10:28Z
**Status:** gaps_found
**Re-verification:** No, initial verification. The existing 76-VERIFICATION.md (2026-11-01, written without this procedure) was not used as a must-have source and has no `gaps:` section.

**Branch:** gsd/v18-p76-telemetry-dlq. HEAD is f85299eb (docs only: ROADMAP, STATE, and the old VERIFICATION). Phase implementation commit: 327e7c8d.
**Gates:** not re-run here. The orchestrator reports tsc 0, bun test 11413 pass / 2 skip / 0 fail, phase-close 236 pass. Only the two named tests below were run.

## Goal Achievement

### Observable Truths

Must-haves are the ROADMAP Phase 76 success criteria, confirmed verbatim by `gsd_run query roadmap.get-phase 76 --raw`. The PLAN has no `must_haves` frontmatter, so Steps 4 and 5 are not applicable (`verify.artifacts` and `verify.key-links` both exit 66).

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash | ✓ VERIFIED | Entry: `service.ts:2796-2802` (a failed direct write goes to `bufferEvent`); `bufferEvent` at `service.ts:2810-2816`. Bound: `event-buffer.ts:179-209` (`enqueue`, bound check 183-188); size from `SUBSTRATE_EVENT_BUFFER_MAX`, default 256 (`config.ts:2525`, `service.ts:1881`). Backoff: `eventBufferBackoffMs` at `event-buffer.ts:37-41` (base × 2^n, capped, ±20 % jitter), applied at `event-buffer.ts:195` (enqueue) and `:257` (runDrain). Retry: `runDrain` at `event-buffer.ts:231-261`, delivery via `service.ts:2823-2838` with `insertEvent(..., { mayExist: true })` at `:2831`, so the same id is not stored twice. Budget: `event-buffer.ts:251-256` counts attempts and gives the entry up at `maxAttempts` (`exhausted`), cascading to its session's later entries (`dropFrom` 292-304). Dead-letter with hash: `service.ts:1886` (`onDeadLetter` → `deadLetters.record`); `event-dead-letter.ts:92-112` writes `event_hash: event.hash` (line 98) and the reason. Behavioral test: `service-event-buffer.test.ts` "a write that exhausts its budget is dead-lettered with its hash and its reason" **run: 1 pass** (stderr: `dead-lettered (exhausted) after 3 attempt(s), hash d172eea1…`). The buffer is opt-in (D76-15; `service.ts:1874-1876`, `config.ts:2513-2514`). Criterion 1 holds only when the operator sets `SUBSTRATE_EVENT_BUFFER_PATH` (human item 7). |
| 2 | Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag | ✗ FAILED | **Reported (met):** `service.ts:8169` sets `health().eventBuffer` to `{ enabled, ...stats(), deadLetter: { depth, durable } }`. `stats()` is at `event-buffer.ts:161-167`. `server.ts:914-931` spreads `...health` into the `/healthz` body. Behavioral test: `service-event-buffer.test.ts` "the health body reports the buffer's depth and the dead-letter depth, each with its durability" **run: 1 pass**. **Buffer bounded by a flag (met):** `SUBSTRATE_EVENT_BUFFER_MAX` (`config.ts:2525`, `flag-registry.ts:339`), enforced at `event-buffer.ts:183`. Covered by test titles in `event-buffer.test.ts` ("over the bound the oldest entry is given up with a record", line 71) and `service-event-buffer.test.ts` (overflow, line 136), not run here. **Dead-letter depth bounded by a flag (NOT met):** `event-dead-letter.ts:11-12` says "It is deliberately not bounded." `DeadLetterStore` (66-162) has no max. The six buffer flags (`flag-registry.ts:339-344`; `config.ts:2513-2528`) include no dead-letter bound. The store's in-memory `held` list (72, 125-131) also grows without limit while the file is unwritable. Plan decision D76-13 (`76-01-PLAN.md:28`) leaves the store unbounded. `76-01-SUMMARY.md:36` and `STATE.md:684` record this. No later phase defers it (Step 9b; phases 77 and 78, `ROADMAP.md:1324-1350`, do not match). No override in frontmatter (Step 3b). **Status: FAILED (BLOCKER).** |

**Score:** 1/2 truths verified (0 present-behavior-unverified)

### Required Artifacts

Step 4 not applicable: `verify.artifacts` exit 66 (no `must_haves.artifacts`). Checked manually.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-buffer.ts` | bounded FIFO, backoff, drop causes, persistence | ✓ VERIFIED | 383 lines. Imported by `service.ts`. Drain tested by named test above. |
| `packages/mcp-server/src/event-dead-letter.ts` | dead-letter store with hash, reason | ⚠️ PARTIAL | 162 lines. Records carry hash and reason. Not bounded (truth 2). |
| `packages/mcp-server/src/service.ts` | write path, buffering, drain, shutdown, `health()` | ✓ VERIFIED | Wiring at `:1874-1892`, `:2728-2804`, `:2810-2865`, `:8169`. |
| `packages/mcp-server/src/greptime.ts` | `insertEvent` with `mayExist` | ✓ VERIFIED | `:1248-1266`, `:1291-1294`. `findByIdempotencyKey` `:1407-1446`. |
| `packages/mcp-server/src/config.ts` | buffer settings, parsing, refuse boot without dead-letter path | ✓ VERIFIED | `:2508-2530`. |
| `packages/mcp-server/src/flag-registry.ts` | six flag rows | ✓ VERIFIED | `:339-344`. |
| `packages/mcp-server/src/server.ts` | `/healthz` carries the health body | ✓ VERIFIED | `:914-931`. |
| `docs/config-reference.md`, `docs/greptime-ledger.md`, `.env.example` | flags documented | ✓ VERIFIED | `docs/greptime-ledger.md:947-989`. Outage claim overstated; see Anti-Patterns. |

### Key Link Verification

Step 5 not applicable: `verify.key-links` exit 66 (no `must_haves.key_links`). Checked manually.

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `appendChained` write failure | `bufferEvent` → `EventBuffer.enqueue` | `service.ts:2802`, `:2811` | ✓ WIRED | |
| `EventBuffer` give-up | `DeadLetterStore.record` | `onDeadLetter`, `service.ts:1886` | ✓ WIRED | |
| drain pass | `deliverBuffered` → `insertEvent(mayExist)` | `service.ts:2841-2843`, `:2831` | ✓ WIRED | |
| shutdown | `drainPendingEvents` | `index.ts:251` → `service.ts:2859` | ✓ WIRED | |
| `health()` | `/healthz` body | `service.ts:8169` → `server.ts:931` | ✓ WIRED | |
| `SUBSTRATE_EVENT_BUFFER_MAX` | buffer bound | `config.ts:2525` → `service.ts:1881` → `event-buffer.ts:183` | ✓ WIRED | |
| dead-letter depth | bound flag | none | ✗ NOT_WIRED | No bound flag exists (truth 2). |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `/healthz` `eventBuffer` | depth, max, oldestAt, durable | `EventBuffer.stats()` over the live map | Yes | ✓ FLOWING |
| `/healthz` `eventBuffer.deadLetter` | depth, durable | `DeadLetterStore.depth()` (onDisk + held) | Yes | ✓ FLOWING |
| dead-letter record | `event_hash` | `event.hash` from the buffered entry | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Truth 1: budget exhaustion dead-letters with hash (retry → give-up) | `bun test packages/mcp-server/src/service-event-buffer.test.ts -t "a write that exhausts its budget is dead-lettered with its hash and its reason"` | 1 pass, 0 fail | ✓ PASS |
| Truth 2 (reporting): health body reports both depths and durability | `bun test packages/mcp-server/src/service-event-buffer.test.ts -t "the health body reports the buffer's depth and the dead-letter depth, each with its durability"` | 1 pass, 0 fail | ✓ PASS |

Each command is one named test, run once. The full suite was not run here.

### Probe Execution

Step 7c skipped. No probe is declared in the PLAN or SUMMARY, and the phase is neither migration nor tooling.

### Requirements Coverage

No requirement IDs in the PLAN (`requirements:` absent). `.planning/REQUIREMENTS.md` has no Phase 76 row. Nothing to map and no orphans.

### Anti-Patterns Found

Scan of the 16 changed `.ts` files from 327e7c8d. Debt markers (`TBD`, `FIXME`, `XXX`): none, so the debt-marker gate does not fire. `TODO`, `HACK`, `PLACEHOLDER` added by 327e7c8d: none. `return null` / `=> {}` hits are sentinel returns, not stubs.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/event-dead-letter.ts` | 11-12 | Dead-letter store deliberately unbounded | 🛑 Blocker | Truth 2 gap (see gaps). |
| `packages/mcp-server/src/event-buffer.ts` | 215-221 | R-2: `drain` returns an in-flight pass and ignores `options.all` | ⚠️ Warning | Shutdown can join a periodic pass and skip due-later entries. See R-2. |
| `packages/mcp-server/src/service.ts` | 2796-2802, 2693-2706 (path) | R-1: keyed replay after give-up writes a fresh row | ⚠️ Warning | Possible second row. See R-1. Not reproduced. |
| `packages/mcp-server/src/service.ts` | 2625-2630 | Keyed replay lookup in `enforce` without `ts` or replay header | ⚠️ Warning | `ts` falls back to now (`event.ts:278`) and the exact-`ts` lookup misses. See R-1 edge. Read only. |
| `docs/greptime-ledger.md` | 951 | "The defaults ride out an outage of about five minutes" | ⚠️ Warning | Nine waits, 243 s nominal (1, 2, 4, 8, 16, 32, 60, 60, 60 s), 195 to 292 s with jitter. Four minutes is accurate. |

**R-1 (keyed replay after a give-up).** Event ids are random per call (`event.ts:282`), and `ts` defaults to now (`event.ts:278`).

- *Trigger A (lands once, new id; record orphaned).* Event E (key K, id X, hash H) is dead-lettered and never lands. The collector spool replays it on a 503 with `x-substrate-replay: 1` and the same key and `ts` (`collectors/src/emit.ts:575-578`). `replayOutcome` (`service.ts:2693-2706`) finds no ledger row. `findKeyed` (`event-buffer.ts:154-159`; `service.ts:2736-2737`) finds nothing, because the entry left the buffer. So `appendChained` builds a fresh event: new random id, new hash, `prev` = ledger tip (`service.ts:2740-2751`), written with no `mayExist` (`:2781-2782`). Result: `stored: true`, one row, new id and hash. The dead-letter record (X/H) never matches a ledger row, and a hand replay from the record would be a second row.
- *Trigger B (duplicate).* The original write committed after the substrate gave it up, or during the shutdown abandon. The replay's ledger lookup runs before the commit, and the buffer no longer holds the entry. Then both rows exist with the same `_ik` and different ids. The shutdown race is at `service.ts:2862-2864`: `abandonAll` runs after `Promise.race` times out, without checking whether a delivery is in flight.
- *Landed row visible (no duplicate).* When the original write landed and the replay carries its `ts` (a spool replay does), `findByIdempotencyKey` (`greptime.ts:1407-1446`, exact cell, `ts` and key suffix) finds it and the reply is `deduplicated`, `service.ts:2732-2734`.
- *Edge, not dead-letter specific.* `checkReplayTs` refuses a keyed replay without `ts` (`event.ts:145`), but only when the replay header is set (`service.ts:2625-2627`). A keyed request in `enforce` without the header and without `ts` runs the lookup (`:2630`), with `ts` = now, and misses. Not exercised.

**R-2 (shutdown coalesced into a periodic pass).** Confirmed by reading. `EventBuffer.drain` returns `this.draining` when a pass is in flight and drops `options.all` (`event-buffer.ts:215-221`). The periodic timer calls `drainEventBuffer()` with `all: false` (`service.ts:2867-2870`). A shutdown call with `all: true` (`:2847-2853`, `:2862`) therefore joins that pass, and entries not yet due are not attempted. With `abandon` and an unsaved buffer, `abandonAll` (`:2864`) gives them up as `abandoned`, each with a record, so nothing vanishes unrecorded. A durable buffer keeps them for the next boot.

## Deferred Items

None. Step 9b checked phases 77 and 78. Phase 77 is steering idempotency and phase 78 is cross-layer reconciliation. Neither covers the dead-letter bound.

## Human Verification Required

Step 8 items. These do not change the status, because gaps_found takes precedence.

1. **Live GreptimeDB rehearsal.** Block the ledger and emit a sequence for one session. Confirm 503 with `buffered: true`, `stored: false`, and `/healthz` `eventBuffer.depth` rising. Restore. Confirm each event lands once, in chain order, each with an `event_ingest` row. This also checks the `mayExist` exact-`ts` predicate (`greptime.ts:1291-1302`) against real timestamp precision.
2. **Dead-letter exhaustion on a live outage.** Nominal budget is about four minutes (243 s; 195 to 292 s with jitter). Confirm the dead-letter line, mode 0600, and the boot refusal without `SUBSTRATE_EVENT_DEAD_LETTER_PATH`.
3. **Restart during an outage.** Stop with entries waiting and a durable file. The next boot must report the depth and drain the entries once.
4. **Shutdown under the service manager.** `drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })` (`index.ts:251`) must finish within the shutdown bound with a durable buffer. An unsaved buffer leaves an `abandoned` record for each entry. Check R-2 here.
5. **Buffered `session.end` (D76-14, D76-19).** On a live session, the steering session must stay open until the `session.end` lands, and the wake-up hint (`publishHint`, `service.ts:2836`) must appear only then.
6. **Keyed replay after a dead-letter record (R-1).** On a live collector spool, confirm which trigger occurs: Trigger A (one new row, orphaned record) or Trigger B (two rows).
7. **Operator decision to enable the buffer (D76-15).** Criterion 1 holds only with `SUBSTRATE_EVENT_BUFFER_PATH` and `SUBSTRATE_EVENT_DEAD_LETTER_PATH` set.
8. **`/healthz` staleness.** The body is memoised for `SUBSTRATE_HEALTHZ_CACHE_MS` (default 5000, `config.ts:1184`, `server.ts:920`). Confirm pollers see a depth change within that window.

## Gaps Summary

**Gap 1 (BLOCKER): dead-letter depth is not bounded by a flag.** Must-have 2 reads "Buffer and dead-letter depth are reported in /healthz and bounded by a flag." The buffer half is met (`SUBSTRATE_EVENT_BUFFER_MAX`). The dead-letter half is not: the store is unbounded by design (D76-13, `event-dead-letter.ts:11-12`, `76-01-PLAN.md:28`), and no flag bounds it. The plan's reasoning is that a bound would have to discard records, which is the silent loss the phase removes. That is a real conflict with the literal text. Per Step 3b and Step 9 this is FAILED, with no override. The status is gaps_found. Accepting the deviation is an owner decision, recorded as an `overrides:` entry with `accepted_by` and `accepted_at`. I did not add one.

**Warnings (not must-have failures):**
- R-1: keyed replay after a give-up can write a fresh row with a new id (Trigger A, the common case, lands once). A second row for one event happens only in Trigger B, when the ledger lookup misses a commit that lands later. Not reproduced.
- R-2: a shutdown pass can join a periodic pass and skip entries that are not yet due. An unsaved buffer then abandons them with records. Nothing vanishes unrecorded.
- The outage tolerance in `docs/greptime-ledger.md:951` is overstated (about four minutes, not five).

---

_Verified: 2026-11-02T02:10:28Z_
_Verifier: Claude (gsd-verifier)_
