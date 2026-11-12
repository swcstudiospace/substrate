---
phase: 76-telemetry-buffer-dead-letter
verified: 2026-11-12T07:48:35Z
status: human_needed
score: 2/2 ROADMAP success criteria verified in code and tests; 3 human items (2 operator gates, 1 scope decision)
overrides_applied: 0
behavior_unverified: 0
covered_files:
  - .env.example
  - .planning/phases/76-telemetry-buffer-dead-letter/CONTEXT.md
  - .planning/phases/76-telemetry-buffer-dead-letter/PLAN.md
  - .planning/phases/76-telemetry-buffer-dead-letter/SUMMARY.md
  - docs/greptime-ledger.md
  - packages/mcp-server/src/config.ts
  - packages/mcp-server/src/event-buffer.test.ts
  - packages/mcp-server/src/event-buffer.ts
  - packages/mcp-server/src/event-idempotency.test.ts
  - packages/mcp-server/src/flag-registry.ts
  - packages/mcp-server/src/greptime.ts
  - packages/mcp-server/src/index.ts
  - packages/mcp-server/src/ledger-chain.test.ts
  - packages/mcp-server/src/outbox-file.ts
  - packages/mcp-server/src/retain-outbox.ts
  - packages/mcp-server/src/service-event-buffer.test.ts
  - packages/mcp-server/src/service.test.ts
  - packages/mcp-server/src/service.ts
covered_digest: "v3:sha256:a332c83406d362e6cffca6f7d51f51dd0b632c2e239e6555004c51d1082cf303"
human_verification:
  - test: "Set SUBSTRATE_LEDGER_BUFFER_PATH and SUBSTRATE_LEDGER_DEAD_LETTER_PATH in the production substrate-mcp unit (a StateDirectory path), then restart with a parked event and inspect /healthz."
    expected: "The buffer and dead-letter files exist 0600 under the state directory; after restart /healthz.eventBuffer reports pending >= 1 with durable true and deadLetters.durable true."
    why_human: "The repo's infra/vps/substrate-mcp.service and its .d drop-ins set neither variable, so production runs memory-only (CONTEXT D76-11). Changing the unit is an operator gate outside this phase's scope."
  - test: "Decide what happens to a held claim whose buffered event is lost (memory-only restart or crash) or never lands."
    expected: "A recorded decision: the reconcile path (phase 78) or an operator procedure that releases or re-emits the claim."
    why_human: "Since commit e20f3634 a parked claim is recorded and kept (service.ts claimNode, decideClaim with recorded = stored || buffered). Withdrawal happens only for dead-lettered or refused events. A claim whose buffered event disappears in a memory-only restart therefore stays held with no ledger event behind it. This is an operator policy choice, not a code defect."
  - test: "Decide whether a refusal before the write (chain tip unreadable, append-mode unknown) should be buffered, or documented as accepted loss during a long ledger outage."
    expected: "A recorded decision on D76-01. Either buffering that input with the hash computed at drain time, or an explicit accepted-loss statement that also covers long outages."
    why_human: "The ROADMAP goal says no event is dropped silently. D76-01 excludes these refusals from the buffer and docs/greptime-ledger.md ('Not covered') names only the tip and append-only cases. See Warning W2."
---

# Phase 76: Telemetry buffer and dead-letter - Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently.
**Verified:** 2026-11-12T07:48:35Z
**Status:** human_needed
**Re-verification:** No. The hand-written VERIFICATION.md (preserved in git history) was treated as a set of leads only. Its counts are stale (see "Stale claims").

## Goal Achievement

### ROADMAP Success Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash. | ✓ VERIFIED (scoped per D76-01, see W2) | Code: `service.ts` `appendChained` catch on `insertEvent` failure calls `parkEvent(event, error, true)`, which calls `EventBuffer.enqueue`. `event-buffer.ts` `enqueue` parks with `attempts: 1` and `next_at = now + outboxBackoffMs(0, {base 2000, cap 300000})`. `runDrain` spends one attempt per transient failure, `next_at` doubles, and at `attempts >= maxAttempts` it calls `DeadLetterStore.add(deadLetterOf(entry, "exhausted", ...))`. The dead letter carries `hash: entry.event.hash`. `service.ts` `deliverBufferedEvent` checks `greptime.eventStored(id)` before each retry (`greptime.ts` `eventStored`, a single-row SELECT). Tests (run 2026-11-12): `event-buffer.test.ts` "a transient answer spends one attempt and waits out the next, longer backoff"; "an event that spends its budget is dead-lettered with its hash, and its session's later events with it". `service-event-buffer.test.ts` "retry then success: the first write fails, the retry stores the same event"; "retry exhausted: the event is written to the dead-letter file with its hash, and healthz counts it" (file record `hash === result.event.hash`, `cause: exhausted`, `attempts: 2`). |
| 2 | Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag. | ✓ VERIFIED | Health: `service.ts` `eventBufferHealth()` (around line 8760) is spread into the health body at line 8637 as `eventBuffer: {pending, max, oldestAt, durable, deadLetters: {depth, max, durable, evicted}}`. Test "retry exhausted ... healthz counts it" asserts the full block. "a full buffer dead-letters the new event at once, and healthz reports the depth" asserts `pending 1`, `max 1`, `deadLetters.depth 1`. Flags: `config.ts` lines 1233-1239 read `SUBSTRATE_LEDGER_BUFFER_PATH`, `_BUFFER_MAX` (1000), `_BUFFER_MAX_ATTEMPTS` (10), `_DEAD_LETTER_PATH`, `_DEAD_LETTER_MAX` (10000). `flag-registry.ts` lines 356-360 carry all five rows, documented in `docs/greptime-ledger.md` and `.env.example`. The bound is exercised by "over the buffer bound a new event goes straight to the dead letters" (`event-buffer.test.ts`), "a full buffer dead-letters the new event at once" and "the dead-letter store is bounded: the oldest record is evicted and the eviction is counted". |

### Named test runs (this verification)

| File | Command | Result |
|------|---------|--------|
| `packages/mcp-server/src/event-buffer.test.ts`, `service-event-buffer.test.ts` | `bun test` | 26 pass, 0 fail |
| `packages/mcp-server/src/service.test.ts` | `bun test -t "healthz separates\|insert that fails before\|parked\|buffer"` | 5 pass, 0 fail |
| `packages/mcp-server/src/flag-registry.test.ts`, `config.test.ts` | `bun test` | 95 pass, 0 fail (the registry lock test passes) |

Not run: full `bun test`, `bunx tsc --noEmit`, `rollback-compat.test.ts`, `soak-multiday.test.ts`, lint. Nothing was run against a live GreptimeDB; every ledger in these tests is a fake or the `ledger-chain` HTTP fake.

### Behavior checks beyond the criteria

| Behavior | Evidence |
|----------|----------|
| Success is stored, never parked | `service-event-buffer.test.ts` "a write that succeeds at once is stored, not parked" |
| Chain order: a session's later event parks behind the parked tail and both land in order | `service-event-buffer.test.ts` "a session's later event waits behind the parked one"; `event-buffer.test.ts` "a session's events are delivered in chain order" |
| Keyed replay of a parked event answers with it and writes nothing | `service-event-buffer.test.ts` "a keyed replay of a parked event answers with it and writes nothing" |
| Breaker held on the drain path: no attempt spent, pass stops | `event-buffer.test.ts` "a held delivery (the ledger's breaker is open) stops the pass and spends no attempt" |
| Parked claim is kept (recorded); dead-lettered and refused claims are withdrawn | `service.test.ts` "a parked claim is not withdrawn", "a dead-lettered claim is withdrawn", "a refused claim is withdrawn as before" (names from enumeration; the 3 claim tests were not in the run above) |
| Shutdown: memory-only buffer moves parked events to dead letters as `abandoned`; durable file kept | `service-event-buffer.test.ts` "parked events survive a restart when a buffer path is set"; `event-buffer.test.ts` "abandonAll moves every parked event to the dead letters as abandoned" |
| File-backed buffer and dead letters survive a restart; 0600; malformed line skipped | `event-buffer.test.ts` file-backed group (three tests) |
| Settle before a write chains onto a session's parked events; a write parks behind the tip past one call's budget | `service-event-buffer.test.ts` "a session's later write settles the parked event first once the ledger is back"; "a ledger that never answers holds a write for one call's budget at most" |
| `RetainOutbox` after extraction into `outbox-file.ts` | `retain-outbox.test.ts` (listed as unchanged in PLAN; not in this run) |

### Code checks

- `event-buffer.ts`, `outbox-file.ts` and the two new test files contain no `TBD`, `FIXME`, `XXX`, `TODO`, `HACK` or `PLACEHOLDER` markers.
- Required artifacts exist: `outbox-file.ts`, `event-buffer.ts`, `event-buffer.test.ts`, `service-event-buffer.test.ts`, `greptime.ts` `eventStored`, `config.ts` `eventBuffer`, five rows in `flag-registry.ts`, `.env.example`, `docs/greptime-ledger.md` "Write buffer and dead letters (phase 76)".
- Key links verified by reading: `appendChained` → `parkEvent` → `EventBuffer.enqueue`; `drainEventBuffer` → `EventBuffer.drain` → `deliverBufferedEvent` → `eventStored` / `insertEvent`; `index.ts` line 254 → `drainPendingEvents(SHUTDOWN_EVENT_MS, { abandon: true })`; `service.ts` `eventBufferHealth` → health body.
- Probe execution: none declared by the phase. Behavioral spot-checks are the named test runs above.

## Warnings (not criteria failures; no gap)

- **W1. The direct path spends an attempt on a breaker refusal.** `service.ts` `appendChained` catches any `insertEvent` error and calls `parkEvent(event, error, true)`. A `GreptimeBreakerOpen` from the direct path therefore counts as a spent attempt. CONTEXT D76-10 says a breaker answer is "held: no attempt is spent", and the drain path (`deliverBufferedEvent`) honours that, but the direct path does not. No test covers a breaker refusal on the direct path. Effect: each first event of a session during an open breaker uses one of its 10 attempts without reaching the ledger, so outage tolerance is shorter than the documented ~13.5 min.
- **W2. Refusals before the write are not buffered, and that matters in a long outage.** `service.ts` `appendChained` returns `stored: false` with no buffer and no dead letter when (a) `greptime.lastHash` throws (`chain tip unreadable`, line ~2956) and (b) `ensureAppendMode()` resolves to `null` (`APPEND_MODE_UNKNOWN`, line ~2965). `lastHash` is read only when the session has no parked events and no cached tip. The cache is cleared on a failed insert and is empty after a session's parked events are all dead-lettered. So once the buffer for a session empties during an outage that also fails reads, the next event is refused rather than buffered. D76-01 and docs `greptime-ledger.md` "Not covered" document the decision, but name only the tip and "not append-only" cases, not the unknown-append-mode case or the consequence in a sustained outage. This is the one place the ROADMAP goal sentence ("No event is dropped silently") is not met by the code. It is a scope decision, so it goes to human review, not to gaps.
- **W3. The existing-row retry branch has no test.** `deliverBufferedEvent` takes the `eventStored === true` path (write only the ingest record) at `service.ts` lines 4110-4112 (`deliverBufferedEvent`). No test in the named files makes `eventStored` return true for a parked event. The branch is short and reads correctly, but it is unexercised.
- **W4. Shutdown race (accepted in commit 49b9aece).** `drainPendingEvents` races the pass against `Bun.sleep(timeoutMs)` (`service.ts` ~4139) and does not cancel it. `abandonAll` then dead-letters the in-flight entry as `abandoned`. If that delivery lands after the record, the event is in both places under the same id and hash. This is at-least-once and detectable, as the commit records, and is not a drop. An operator re-appending the dead letter would duplicate it.
- **W5. Memory-only is the default.** Both paths default to unset in `config.ts` and in the repo's systemd units. A process crash loses parked events with no record. A clean shutdown dead-letters them, and the dead-letter store is then lost at exit with only a stderr line. The phase names this (CONTEXT D76-11) and it is the first human item. It is an operator gate.

## Human Verification Required

### 1. Production buffer and dead-letter paths (operator gate)

**Test:** Set `SUBSTRATE_LEDGER_BUFFER_PATH` and `SUBSTRATE_LEDGER_DEAD_LETTER_PATH` under the unit's `StateDirectory`, restart with a parked event, and read `/healthz`.
**Expected:** Files exist at mode 0600 under the state directory. After restart, `/healthz.eventBuffer` shows `pending >= 1`, `durable: true`, and `deadLetters.durable: true`.
**Why human:** Repo units (`infra/vps/substrate-mcp.service` and `substrate-mcp.service.d/`) set neither variable. Changing the unit and confirming on the host is outside this phase's scope.

### 2. Held-claim policy (operator gate)

**Test:** Decide what happens to a claim held for a parked event whose event is lost (memory-only restart or crash) or never lands.
**Expected:** A recorded decision, with reconciliation or an operator procedure to release or re-emit the claim.
**Why human:** Since commit `e20f3634` a parked claim is recorded and kept (`service.ts` `claimNode`: `recorded = emitted.stored || emitted.buffered === true`). Withdrawal happens only for dead-lettered or refused events. A lost parked event leaves a held claim with no event behind it. This is a policy choice.

### 3. Scope of the write-failure criterion (W2)

**Test:** Decide between buffering a refused input (hash computed at drain once the tip is known) and recording the accepted loss for long ledger outages.
**Expected:** A written decision on D76-01, reflected in `docs/greptime-ledger.md` "Not covered".
**Why human:** This is a scope call against the goal sentence "No event is dropped silently".

## Stale claims in the hand-written VERIFICATION.md and SUMMARY.md

- SUMMARY residual 1 ("claim withdrawal not fixed") is superseded by commit `e20f3634`. Parked claims are now recorded (see item 2 above).
- SUMMARY residual 6 ("registry lock test fails at HEAD") is superseded. `SUBSTRATE_DOCS_MIGRATE_APPROVED` now has a registry row and `.env.example` line. `flag-registry.test.ts` and `config.test.ts` pass (95 pass, 0 fail).
- The hand-written counts (617 pass, 1 fail, 9 files) predate the later `fix(76)` commits (`067f094b`, `e20f3634`, `b3591743`, `7a1d923a`, `49b9aece`). They are not used here.

## Gaps Summary

No ROADMAP success criterion is unmet, so there are no gaps. Status is `human_needed` because the production effect of the goal depends on operator-gated changes (W5 and human items 1 and 2) and because the write-refusal scope (W2) needs a decision.

---

_Verified: 2026-11-12T07:48:35Z_
_Verifier: Claude (gsd-verifier)_
