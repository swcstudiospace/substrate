---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-02T02:42:57Z
status: human_needed
score: 2/2 must-haves verified
covered_files: [".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-PLAN.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-SUMMARY.md", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-buffer.test.ts", "packages/mcp-server/src/event-buffer.ts", "packages/mcp-server/src/event-dead-letter.test.ts", "packages/mcp-server/src/event-dead-letter.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/reanchor-run.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:373e1485d5da17efa70d422f94220b9039d3f4eb505b9c3d8c80e1b3a943ab03"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag."
    reason: "Owner accepted the override on 2026-11-02. The dead-letter store is deliberately unbounded (plan decision D76-13): a bound would have to drop records, the silent loss this phase removes. The buffer is bounded by SUBSTRATE_EVENT_BUFFER_MAX, and the depth of both stores is reported in /healthz. A dead-letter cap is a tracked follow-up."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
human_verification:
  - test: "Live GreptimeDB rehearsal: block the ledger and emit a sequence for one session; restore."
    expected: "503 with buffered: true, stored: false; /healthz eventBuffer.depth rises; after restore each event lands once, in chain order, each with an event_ingest row. Also checks the mayExist exact-ts predicate (greptime.ts:1291-1302) against real timestamp precision."
    why_human: "Needs a live GreptimeDB and a real outage."
  - test: "Dead-letter exhaustion on a live outage (nominal budget about 243 s; 195 to 292 s with jitter)."
    expected: "Dead-letter line written, file mode 0600, and boot refused without SUBSTRATE_EVENT_DEAD_LETTER_PATH."
    why_human: "Needs a live outage longer than the retry budget."
  - test: "Restart during an outage: stop with entries waiting and a durable file."
    expected: "The next boot reports the depth and drains the entries once."
    why_human: "Needs a process restart against a durable file on a real host."
  - test: "Shutdown under the service manager: drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true }) (index.ts:251)."
    expected: "Finishes within the shutdown bound with a durable buffer. An unsaved buffer leaves an abandoned record for each entry. Check R-2 here."
    why_human: "Needs the real service manager and its shutdown timing."
  - test: "Buffered session.end (D76-14, D76-19) on a live session."
    expected: "The steering session stays open until session.end lands; the wake-up hint (publishHint, service.ts:2836) appears only then."
    why_human: "Needs a live steering session."
  - test: "Keyed replay after a dead-letter record (R-1) on a live collector spool."
    expected: "Confirm which trigger occurs: Trigger A (one new row, orphaned record) or Trigger B (two rows)."
    why_human: "Needs a live collector spool and ledger."
  - test: "Operator decision to enable the buffer (D76-15)."
    expected: "Criterion 1 holds only with SUBSTRATE_EVENT_BUFFER_PATH and SUBSTRATE_EVENT_DEAD_LETTER_PATH set. Operator must make and record this decision."
    why_human: "Configuration and policy decision, not code-verifiable."
  - test: "/healthz staleness."
    expected: "Body is memoised for SUBSTRATE_HEALTHZ_CACHE_MS (default 5000, config.ts:1184, server.ts:920). Pollers see a depth change within that window."
    why_human: "Needs a running server and a poller."
---

# Phase 76: Telemetry buffer and dead-letter Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently. (ROADMAP Phase 76)
**Verified:** 2026-11-02T02:42:57Z
**Status:** human_needed
**Re-verification:** No, initial verification (brief directs initial mode; the prior 76-VERIFICATION.md on disk was superseded)

**Branch:** gsd/v18-p76-telemetry-dlq. Phase implementation commit: 327e7c8d.
**Gates:** not re-run here. The orchestrator reports tsc 0, bun test 11413 pass / 2 skip / 0 fail, phase-close 236 pass. Only the two named tests below were run in this verification.

## Goal Achievement

### Observable Truths

Must-haves are the ROADMAP Phase 76 success criteria. The PLAN has no `must_haves` frontmatter, so Steps 4 and 5 are not applicable (`verify.artifacts` and `verify.key-links` exit 66).

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash | ✓ VERIFIED | Entry: `service.ts:2796-2802` (failed direct write goes to `bufferEvent`); `bufferEvent` at `service.ts:2810-2816`. Bound: `event-buffer.ts:179-188` (`enqueue`, bound check), size from `SUBSTRATE_EVENT_BUFFER_MAX`, default 256 (`config.ts:2525`, `flag-registry.ts:339`). Backoff and retry in `event-buffer.ts` (`runDrain`, delivery via `service.ts:2823-2838` with `insertEvent(..., { mayExist: true })` at `:2831`). Dead-letter with hash: `event-dead-letter.ts` (`DeadLetterStore.record`, wired by `onDeadLetter`, `service.ts:1886`). Behavioral test: `service-event-buffer.test.ts` "a write that exhausts its budget is dead-lettered with its hash and its reason" **run this session: 1 pass, 0 fail**. Bound test: `event-buffer.test.ts:71` "over the bound the oldest entry is given up with a record, never dropped silently". |
| 2 | Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag | ✓ PASSED (override) | **Reported (met):** `service.ts:8169` sets `health().eventBuffer` to `{ enabled, ...stats(), deadLetter: { depth, durable } }`; `stats()` at `event-buffer.ts:161-167`; `server.ts:914-931` spreads the health body into `/healthz`. Behavioral test: `service-event-buffer.test.ts` "the health body reports the buffer's depth and the dead-letter depth, each with its durability" **run this session: 1 pass, 0 fail**. **Buffer bounded by a flag (met):** `SUBSTRATE_EVENT_BUFFER_MAX` (`config.ts:2525`, `flag-registry.ts:339`), enforced at `event-buffer.ts:183`. **Dead-letter bounded by a flag (not met as written):** `event-dead-letter.ts:11-12` states the store is deliberately unbounded; `DeadLetterStore` has no depth limit and `depth()` only reports. No flag bounds it (`flag-registry.ts` buffer rows at 339-344). **Override:** Override: Owner accepted the override on 2026-11-02 (D76-13; dead-letter store unbounded by design, a bound would drop records). Carried as PASSED (override) under Step 3b; counts toward `verified_truths`. The must-have text is not narrowed. |

**Score:** 2/2 truths verified (1 verified, 1 passed by override; 0 present-behavior-unverified)

### Required Artifacts

Step 4 not applicable: `verify.artifacts` exit 66 (no `must_haves.artifacts`). Checked manually.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-buffer.ts` | bounded FIFO, backoff, drop causes, persistence | ✓ VERIFIED | Imported by `service.ts`. Drain covered by the named test above and by `event-buffer.test.ts`. |
| `packages/mcp-server/src/event-dead-letter.ts` | dead-letter store with hash, reason | ✓ VERIFIED | Records carry hash and reason. Deliberately unbounded; the bound is accepted as an override (truth 2). |
| `packages/mcp-server/src/service.ts` | write path, buffering, drain, shutdown, `health()` | ✓ VERIFIED | Wiring at `:1874-1892`, `:2728-2804`, `:2810-2865`, `:8169`. |
| `packages/mcp-server/src/greptime.ts` | `insertEvent` with `mayExist` | ✓ VERIFIED | `:1248-1266`, `:1291-1294`. `findByIdempotencyKey` `:1407-1446`. |
| `packages/mcp-server/src/config.ts` | buffer settings, parsing, refuse boot without dead-letter path | ✓ VERIFIED | `:2508-2530`. |
| `packages/mcp-server/src/flag-registry.ts` | buffer flag rows | ✓ VERIFIED | `:339-344`. |
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
| dead-letter depth | bound flag | none | ✓ ACCEPTED (override) | No bound flag exists by design (D76-13). Accepted as an override of truth 2; not counted as NOT_WIRED. |

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
| `packages/mcp-server/src/event-dead-letter.ts` | 11-12 | Dead-letter store deliberately unbounded | ℹ️ Info (accepted by override) | Root cause of truth 2; the override carries it as PASSED. Dead-letter cap is a tracked follow-up per the override reason. |
| `packages/mcp-server/src/event-buffer.ts` | 215-221 | R-2: `drain` returns an in-flight pass and ignores `options.all` | ⚠️ Warning | Shutdown can join a periodic pass and skip due-later entries. See R-2. |
| `packages/mcp-server/src/service.ts` | 2796-2802, 2693-2706 (path) | R-1: keyed replay after give-up writes a fresh row | ⚠️ Warning | Possible second row. See R-1. Not reproduced. |
| `packages/mcp-server/src/service.ts` | 2625-2630 | Keyed replay lookup in `enforce` without `ts` or replay header | ⚠️ Warning | `ts` falls back to now (`event.ts:278`) and the exact-`ts` lookup misses. See R-1 edge. Read only. |
| `docs/greptime-ledger.md` | 951 | "The defaults ride out an outage of about five minutes" | ⚠️ Warning | Nine waits, 243 s nominal (1, 2, 4, 8, 16, 32, 60, 60, 60 s), 195 to 292 s with jitter. Four minutes is accurate. |

**R-1 (keyed replay after a give-up).** Event ids are random per call (`event.ts:282`, `evt_${randomUUID()}`), and `ts` defaults to now (`event.ts:278`).

- *Trigger A (lands once, new id; record orphaned).* Event E (key K, id X, hash H) is dead-lettered and never lands. The collector spool replays it on a 503 with `x-substrate-replay: 1` and the same key and `ts` (`collectors/src/emit.ts:575-578`). `replayOutcome` (`service.ts:2693-2706`) finds no ledger row. `findKeyed` (`event-buffer.ts:154-159`; `service.ts:2736-2737`) finds nothing, because the entry left the buffer. So `appendChained` builds a fresh event: new random id, new hash, `prev` = ledger tip (`service.ts:2740-2751`), written with no `mayExist` (`:2781-2782`). Result: `stored: true`, one row, new id and hash. The dead-letter record (X/H) never matches a ledger row, and a hand replay from the record would be a second row.
- *Trigger B (duplicate).* The original write committed after the substrate gave it up, or during the shutdown abandon. The replay's ledger lookup runs before the commit, and the buffer no longer holds the entry. Then both rows exist with the same `_ik` and different ids. The shutdown race is at `service.ts:2862-2864`: `abandonAll` runs after `Promise.race` times out, without checking whether a delivery is in flight.
- *Landed row visible (no duplicate).* When the original write landed and the replay carries its `ts` (a spool replay does), `findByIdempotencyKey` (`greptime.ts:1407-1446`, exact cell, `ts` and key suffix) finds it and the reply is `deduplicated`, `service.ts:2732-2734`.
- *Edge, not dead-letter specific.* `checkReplayTs` refuses a keyed replay without `ts` (`event.ts:145`), but only when the replay header is set (`service.ts:2625-2627`). A keyed request in `enforce` without the header and without `ts` runs the lookup (`:2630`), with `ts` = now, and misses. Not exercised.

**R-2 (shutdown coalesced into a periodic pass).** Confirmed by reading. `EventBuffer.drain` returns `this.draining` when a pass is in flight and drops `options.all` (`event-buffer.ts:215-221`). The periodic timer calls `drainEventBuffer()` with `all: false` (`service.ts:2867-2870`). A shutdown call with `all: true` (`service.ts:2847-2853`, `:2862`) therefore joins that pass, and entries not yet due are not attempted. With `abandon` and an unsaved buffer, `abandonAll` (`service.ts:2864`) gives them up as `abandoned`, each with a record, so nothing vanishes unrecorded. A durable buffer keeps them for the next boot.

## Deferred Items

None. Step 9b checked phases 77 and 78. Phase 77 is steering idempotency and phase 78 is cross-layer reconciliation. Neither covers the dead-letter bound.

## Human Verification Required

Step 8 items. They route the status to `human_needed`. No truth is FAILED, so the status is not `gaps_found`.

1. **Live GreptimeDB rehearsal.** Block the ledger and emit a sequence for one session. Confirm 503 with `buffered: true`, `stored: false`, and `/healthz` `eventBuffer.depth` rising. Restore. Confirm each event lands once, in chain order, each with an `event_ingest` row. This also checks the `mayExist` exact-`ts` predicate (`greptime.ts:1291-1302`) against real timestamp precision.
2. **Dead-letter exhaustion on a live outage.** Nominal budget is about four minutes (243 s; 195 to 292 s with jitter). Confirm the dead-letter line, mode 0600, and the boot refusal without `SUBSTRATE_EVENT_DEAD_LETTER_PATH`.
3. **Restart during an outage.** Stop with entries waiting and a durable file. The next boot must report the depth and drain the entries once.
4. **Shutdown under the service manager.** `drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })` (`index.ts:251`) must finish within the shutdown bound with a durable buffer. An unsaved buffer leaves an `abandoned` record for each entry. Check R-2 here.
5. **Buffered `session.end` (D76-14, D76-19).** On a live session, the steering session must stay open until the `session.end` lands, and the wake-up hint (`publishHint`, `service.ts:2836`) must appear only then.
6. **Keyed replay after a dead-letter record (R-1).** On a live collector spool, confirm which trigger occurs: Trigger A (one new row, orphaned record) or Trigger B (two rows).
7. **Operator decision to enable the buffer (D76-15).** Criterion 1 holds only with `SUBSTRATE_EVENT_BUFFER_PATH` and `SUBSTRATE_EVENT_DEAD_LETTER_PATH` set.
8. **`/healthz` staleness.** The body is memoised for `SUBSTRATE_HEALTHZ_CACHE_MS` (default 5000, `config.ts:1184`, `server.ts:920`). Confirm pollers see a depth change within that window.

## Gaps Summary

No FAILED truths remain. Must-have 2 was failing on the dead-letter half (the store is unbounded by design, D76-13, `event-dead-letter.ts:11-12`, `76-01-PLAN.md:28`). The owner accepted that deviation on 2026-11-02, and it is recorded as the single entry under `overrides:`. Under Step 3b the truth is carried as PASSED (override) and counts toward the score. The must-have text is unchanged. The override does not cover any other must-have.

Status is `human_needed` because the eight live items above remain. No `gaps:` section is emitted.

**Warnings (not must-have failures):**
- R-1: keyed replay after a give-up can write a fresh row with a new id (Trigger A, the common case, lands once). A second row for one event happens only in Trigger B, when the ledger lookup misses a commit that lands later. Not reproduced.
- R-2: a shutdown pass can join a periodic pass and skip entries that are not yet due. An unsaved buffer then abandons them with records. Nothing vanishes unrecorded.
- The outage tolerance in `docs/greptime-ledger.md:951` is overstated (about four minutes, not five).

---

_Verified: 2026-11-02T02:42:57Z_
_Verifier: Claude (gsd-verifier)_
