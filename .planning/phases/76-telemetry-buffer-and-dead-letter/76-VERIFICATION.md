---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-18T12:25:00Z
status: human_needed
score: 2/2 truths verified (criterion 2 carried as PASSED (override), owner-accepted 2026-11-02)
behavior_unverified: 0
overrides_applied: 1
covered_files: [".env.example", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-PLAN.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-SUMMARY.md", "docs/config-reference.md", "docs/greptime-ledger.md", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-buffer.test.ts", "packages/mcp-server/src/event-buffer.ts", "packages/mcp-server/src/event-dead-letter.test.ts", "packages/mcp-server/src/event-dead-letter.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/reanchor-run.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:6ac52ed5ed458ab87096bab2191e2769a78d427a1f91df7db9093fd2953f4a79"
overrides:
  - must_have: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag."
    reason: "Owner accepted the override on 2026-11-02. The dead-letter store is deliberately unbounded (plan decision D76-13): a bound would have to drop records, the silent loss this phase removes. The buffer is bounded by SUBSTRATE_EVENT_BUFFER_MAX, and the depth of both stores is reported in /healthz. A dead-letter cap is a tracked follow-up."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
gaps: []
advisory: []
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: "Live GreptimeDB rehearsal: block the ledger and emit a sequence for one session; restore."
    expected: "503 with buffered: true, stored: false; /healthz eventBuffer.depth rises; after restore each event lands once, in chain order, each with an event_ingest row. Also checks the mayExist exact-ts predicate (greptime.ts insertEvent / eventRowPresent) against real timestamp precision."
    why_human: "Needs a live GreptimeDB and a real outage."
  - test: "Dead-letter exhaustion on a live outage (nominal budget 243 s, 195 to 292 s with jitter)."
    expected: "Dead-letter line written with the event hash, file mode 0600; boot refused without SUBSTRATE_EVENT_DEAD_LETTER_PATH when SUBSTRATE_EVENT_BUFFER_PATH is set."
    why_human: "Needs a live outage longer than the retry budget."
  - test: "Restart during an outage: stop with entries waiting and a durable file."
    expected: "The next boot reports the depth in /healthz and drains the entries once."
    why_human: "Needs a process restart against a durable file on a real host."
  - test: "Shutdown under the service manager: drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true }) (index.ts:252)."
    expected: "Finishes within the shutdown bound with a durable buffer. An unsaved buffer leaves an abandoned record for each entry. See warning R-2."
    why_human: "Needs the real service manager and its shutdown timing."
  - test: "Buffered session.end (D76-14, D76-19) on a live session."
    expected: "The steering session stays open until session.end lands; the wake-up hint (publishHint, called from deliverBuffered) appears only then."
    why_human: "Needs a live steering session."
  - test: "Keyed replay after a dead-letter record (R-1) on a live collector spool."
    expected: "Confirm which trigger occurs: Trigger A (one new row, orphaned dead-letter record) or Trigger B (two rows)."
    why_human: "Needs a live collector spool and ledger."
  - test: "Operator decision to enable the buffer (D76-15)."
    expected: "Criterion 1 holds only in a deployment that sets SUBSTRATE_EVENT_BUFFER_PATH and SUBSTRATE_EVENT_DEAD_LETTER_PATH. The buffer is off by default."
    why_human: "Deployment configuration is an operator decision."
  - test: "/healthz staleness."
    expected: "The body is memoised for SUBSTRATE_HEALTHZ_CACHE_MS (default 5000, server.ts healthz cache). Pollers see a depth change within that window."
    why_human: "Needs a live poller against the running service."
---

# Phase 76: Telemetry buffer and dead-letter — Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently.
**Verified:** 2026-11-18T12:25:00Z
**Status:** human_needed
**Re-verification:** Yes — the prior record (2026-11-02, human_needed, owner override for criterion 2) was re-checked against the code at this checkout (HEAD 357d6b15, which contains the defect-fix commits dbf25466 and b023d2a0). Earlier findings were re-read from the code, not from that record.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash | ✓ VERIFIED | Buffer: `event-buffer.ts` `EventBuffer` (bounded by `max`; `enqueue` evicts the oldest non-flying entry with `overflow`, or refuses with `buffer-full`). Backoff: `eventBufferBackoffMs` (`base × 2^attempt`, cap, ±20 % jitter) used in `enqueue` and `runDrain`. Budget: `runDrain` gives up with `exhausted` when `attempts >= maxAttempts`. Dead letter: `event-dead-letter.ts` `DeadLetterStore.record` writes `event_hash`, `reason`, `attempts`, `last_reason` and the whole event as 0600 JSONL. Service wiring: `service.ts` `appendChained` buffers a failed direct write (`bufferEvent`), parks later events of the session behind it (`hasSession`), and `deliverBuffered` retries through `greptime.insertEvent(entry.event, { mayExist: true })`. Targeted tests pass (see Behavioral Spot-Checks). |
| 2 | Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag | ✓ VERIFIED (PASSED override for the dead-letter half) | `/healthz` body: `service.ts` `health()` returns `eventBuffer` = `{ enabled: false }` or `{ enabled: true, depth, max, oldestAt, durable, deadLetter: { depth, durable } }`; `server.ts` `/healthz` spreads `substrate.health()`. Buffer bound: `SUBSTRATE_EVENT_BUFFER_MAX` (default 256) via `config.ts` `loadEventBufferSettings`. Dead-letter store is unbounded by design (D76-13, `event-dead-letter.ts` header), accepted by the owner on 2026-11-02 as override. The health-body test is in `service-event-buffer.test.ts`. |

**Score:** 2/2 truths verified (1 directly; 1 with the owner-accepted dead-letter override).

### Deferred Items

None.

### Advisory (New Scope, Unevidenced)

None.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-buffer.ts` | Bounded per-session FIFO, backoff, overflow cascade, JSONL persistence | ✓ VERIFIED | 0600 JSONL, compaction, in-flight protection, `drainSession` for the write-path settle |
| `packages/mcp-server/src/event-dead-letter.ts` | Append-only dead-letter store with hash and reason | ✓ VERIFIED | Reasons: exhausted, overflow, buffer-full, predecessor-dead-lettered, abandoned; memory mode reports `durable: false` |
| `packages/mcp-server/src/service.ts` | Buffering, delivery, drain, shutdown, health | ✓ VERIFIED | `appendChained`, `bufferEvent`, `deliverBuffered`, `settleParked`, `drainEventBuffer`, `drainPendingEvents`, `health().eventBuffer` |
| `packages/mcp-server/src/greptime.ts` | `insertEvent(event, { mayExist })` without a second row | ✓ VERIFIED | `eventRowPresent` check, `recordIngest` repair when missing; default path unchanged (no extra read) |
| `packages/mcp-server/src/config.ts` | Six flags; boot refuses a buffer with no dead-letter path | ✓ VERIFIED | `loadEventBufferSettings` throws `ConfigError` naming `SUBSTRATE_EVENT_DEAD_LETTER_PATH` |
| `packages/mcp-server/src/index.ts` | Shutdown drains the buffer | ✓ VERIFIED | `index.ts:252` `drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })` |
| `packages/mcp-server/src/flag-registry.ts`, `.env.example`, `docs/config-reference.md`, `docs/greptime-ledger.md` | Flags documented | ✓ VERIFIED | Registry rows present (`flag-registry.ts:359-363`); `.env.example:38-46`; config-reference rows at lines 80-81 |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `appendChained` failed write | `EventBuffer.enqueue` | `bufferEvent` | ✓ WIRED | `service.ts` ~3000-3040 |
| `EventBuffer.runDrain` exhaustion | `DeadLetterStore.record` | `onDeadLetter` option | ✓ WIRED | `service.ts` ~1971; `dropFrom` |
| `EventBuffer.drain` | `deliverBufferedInTurn` | `drainEventBuffer` / `EVENT_BUFFER_TICK_MS` timer | ✓ WIRED | `service.ts` ~3128-3135, `ensureEventDrainTimer` |
| `Substrate.health()` | `/healthz` body | spread in `server.ts` | ✓ WIRED | `service.ts` ~8769 |
| `SUBSTRATE_EVENT_BUFFER_PATH` | `EventBuffer` construction | `loadConfig` → `config.eventBuffer` → `Substrate` constructor | ✓ WIRED | `service.ts` ~1959-1973; `null` when unset |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `/healthz.eventBuffer` | depth, max, oldestAt, durable, deadLetter.depth | `EventBuffer.stats()` and `DeadLetterStore.depth()` | Yes (in-memory state of the live stores) | ✓ FLOWING |
| Dead-letter record | `event_hash`, `attempts`, `last_reason`, `event` | `candidate` from `runDrain` / `enqueue` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Buffer, dead-letter, service buffering, health body, boot refusal, and the `mayExist` insert | `bun test packages/mcp-server/src/event-buffer.test.ts packages/mcp-server/src/event-dead-letter.test.ts packages/mcp-server/src/service-event-buffer.test.ts packages/mcp-server/src/greptime.test.ts` | 221 pass, 0 fail (912 expect calls) | ✓ PASS |
| Flag registry and its rows stay in step with the code | `bun test packages/mcp-server/src/flag-registry.test.ts` | 26 pass, 0 fail | ✓ PASS |
| Retry budget nominal total | Sum of waits for attempts 1 to 9 at defaults: 1+2+4+8+16+32+60+60+60 s | 243 s nominal, matching the plan | ✓ PASS (arithmetic) |

Named service tests that exercise the invariants (`service-event-buffer.test.ts`): "buffered, not dropped" (failed write buffered and lands once); "a later event … waits behind the buffered one" (chain order); "a write that exhausts its budget is dead-lettered with its hash and its reason"; "overflow dead-letters the oldest buffered event and its session's later events"; "a restart re-reads the buffer"; "with the buffer unset … stored false"; "the health body reports the buffer's depth and the dead-letter depth"; "a buffer with no dead-letter path refuses boot".

### Probe Execution

No `scripts/*/tests/probe-*.sh` in this repository. Step 7c: SKIPPED.

### Requirements Coverage

No requirement IDs are declared for phase 76 in ROADMAP.md (the phase lists success criteria only). Skipped.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `docs/greptime-ledger.md` | 951 | States the outage tolerance as "about five minutes" | ⚠️ Warning | Nominal budget is 243 s (about four minutes), or 195 to 292 s with jitter. Still overstated, as the prior record noted. Doc fix only. |
| `packages/mcp-server/src/service.ts` | `drainEventBuffer` / `EventBuffer.drain` | `drain()` returns an in-flight pass and ignores its `all` option, so a shutdown pass can join a periodic pass and skip entries not yet due | ⚠️ Warning (R-2) | With a durable buffer those entries are kept for the next boot. With a memory or unsaved buffer `abandonAll()` writes a dead-letter record for each, so nothing vanishes unrecorded. Carried from the prior record. |
| `packages/mcp-server/src/greptime.ts` | `insertEvent` with `mayExist` | Keyed replay after a dead-letter record may write a second row when the ledger lookup misses a commit that lands later (Trigger B) | ⚠️ Warning (R-1) | Not reproduced. Trigger A, the common case, lands once. Carried from the prior record; live check in human verification item 6. |
| `packages/mcp-server/src/event-dead-letter.ts` | — | Dead-letter store unbounded | ℹ️ Info | Owner override (2026-11-02). A cap is a tracked follow-up. |

### Human Verification Required

#### 1. Live GreptimeDB rehearsal
**Test:** Block the ledger and emit a sequence for one session; restore.
**Expected:** 503 with `buffered: true, stored: false`; `/healthz` `eventBuffer.depth` rises; after restore each event lands once, in chain order, each with an `event_ingest` row. Also checks the `mayExist` predicate against real timestamp precision.
**Why human:** Needs a live GreptimeDB and a real outage.

#### 2. Dead-letter exhaustion on a live outage
**Test:** Hold an outage longer than the retry budget (243 s nominal; 195 to 292 s with jitter).
**Expected:** A dead-letter line with the event hash; file mode 0600; boot refused without `SUBSTRATE_EVENT_DEAD_LETTER_PATH` when the buffer path is set.
**Why human:** Needs a live outage.

#### 3. Restart during an outage
**Test:** Stop the process with entries waiting and a durable file.
**Expected:** The next boot reports the depth and drains the entries once.
**Why human:** Needs a restart against a durable file on a real host.

#### 4. Shutdown under the service manager
**Test:** `drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })` at `index.ts:252`.
**Expected:** Finishes within the shutdown bound with a durable buffer; an unsaved buffer leaves an abandoned record per entry. Check R-2 here.
**Why human:** Needs the real service manager and its shutdown timing.

#### 5. Buffered `session.end`
**Test:** On a live session, buffer a `session.end`.
**Expected:** The steering session stays open until `session.end` lands; the wake-up hint appears only then.
**Why human:** Needs a live steering session.

#### 6. Keyed replay after a dead-letter record (R-1)
**Test:** On a live collector spool, replay a keyed event after its dead-letter record.
**Expected:** Confirm which trigger occurs: Trigger A (one new row, orphaned dead-letter record) or Trigger B (two rows).
**Why human:** Needs a live spool and ledger.

#### 7. Operator decision to enable the buffer (D76-15)
**Test:** Decide whether a deployment sets `SUBSTRATE_EVENT_BUFFER_PATH` and `SUBSTRATE_EVENT_DEAD_LETTER_PATH`.
**Expected:** Criterion 1 holds only in a deployment that sets both. The buffer is off by default.
**Why human:** An operator configuration decision.

#### 8. `/healthz` staleness
**Test:** Poll `/healthz` during a depth change.
**Expected:** The body is memoised for `SUBSTRATE_HEALTHZ_CACHE_MS` (default 5000); pollers see the change within that window.
**Why human:** Needs a live poller against the running service.

## Gaps Summary

No FAILED truths. Both success criteria are implemented in code, wired end to end, and covered by passing targeted tests. Criterion 2's dead-letter half is unbounded by design and carried as the owner-accepted override recorded above. The override does not cover any other truth.

Status is `human_needed` because the eight live items above remain. No `gaps:` section is emitted.

**Warnings (not must-have failures):**
- R-1 (keyed replay, Trigger B) and R-2 (shutdown pass joining a periodic pass) are unchanged from the prior record and remain open live checks.
- `docs/greptime-ledger.md:951` says "about five minutes"; the nominal budget is 243 s.

---

_Verified: 2026-11-18T12:25:00Z_
_Verifier: Claude (gsd-verifier)_
