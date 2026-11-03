---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-02T22:18:40Z
status: human_needed
score: 2/2 must-haves verified (SC1 VERIFIED within the accepted pre-send scope, D76-16; SC2 PASSED by owner override, not verified)
covered_files: [".env.example", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-PLAN.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-SUMMARY.md", "docs/config-reference.md", "docs/greptime-ledger.md", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-buffer.test.ts", "packages/mcp-server/src/event-buffer.ts", "packages/mcp-server/src/event-dead-letter.test.ts", "packages/mcp-server/src/event-dead-letter.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:1952ed30258f46d59f883ceeb499c703148f4f576132f3757463e3489822e2e9"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag."
    reason: "Owner accepted the override on 2026-11-02. The dead-letter store is deliberately unbounded (plan decision D76-13): a bound would have to drop records, the silent loss this phase removes. The buffer is bounded by SUBSTRATE_EVENT_BUFFER_MAX, and the depth of both stores is reported in /healthz. A dead-letter cap is a tracked follow-up."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: 2/2 (75f5112d record)
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Live GreptimeDB rehearsal: block the ledger and emit a sequence for one session; restore. Include one write for a session whose chain tip is not cached, and one write during a non-breaker outage (connect timeout before the breaker opens)."
    expected: "Writes during the outage answer 503 with buffered: true, stored: false; /healthz eventBuffer.depth rises; after restore each event lands once, in chain order, each with an event_ingest row. Writes refused at the chain-tip read or the append-mode probe answer stored: false with buffered absent (the accepted pre-send scope; see Open decisions, D76-16 wording). Also checks the mayExist exact-ts predicate (greptime.ts:1299-1312, cited from the prior pass) against real timestamp precision."
    why_human: "Needs a live GreptimeDB and a real outage."
  - test: "Dead-letter exhaustion on a live outage (nominal budget 243 s; 195 to 292 s with jitter)."
    expected: "Dead-letter line written (event-dead-letter.ts record path, stderr 'dead-lettered'), file mode 0600 (flush, fresh-file chmod at event-dead-letter.ts:149-150). Boot refusal without SUBSTRATE_EVENT_DEAD_LETTER_PATH is covered by config.ts:2589-2612 and service-event-buffer.test.ts, not by this item."
    why_human: "Needs a live outage longer than the retry budget. The 0600 mode was not exercised by the scratch probes (they wrote their own files)."
  - test: "Restart during an outage with a durable file that may end in a torn line from a real crash (ENOSPC, kill mid-write)."
    expected: "The next boot reports the depth and starts the drain timer (service.ts:3126-3132) and drains each entry once. The torn line is counted as malformed at boot (stderr note) and is skipped. The next dead-letter write starts on a fresh line (G1 fix, event-dead-letter.ts:148). Boot does not repair the torn line; it stays in the file. Confirm no record is lost."
    why_human: "The G1 test injects a torn line; a real partial write on a real disk is not reproduced."
  - test: "Shutdown under the service manager: index.ts:252 drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true }). Check R-2 and R-3 here."
    expected: "Finishes within the unit's stop bound with a durable buffer. R-2: drain (event-buffer.ts:287-293) returns an in-flight pass and drops options.all, so shutdown can join a periodic pass and skip entries not yet due. R-3: abandonAll (event-buffer.ts:299-305) clears the entry in flight; an in-flight entry that lands is recorded abandoned. The bounds stack: the retain pass (index.ts:249, up to 10 s) runs before the event pass (index.ts:252, up to 10 s), then transitions (5 s) and flush (2 s). infra/vps/substrate-host.service:59 sets TimeoutStopSec=15 (staged, operator-gated install; cited from the prior pass). Worst-case stop exceeds 15 s, so SIGKILL can land mid-pass."
    why_human: "Needs the real service manager and its shutdown timing. R-2 and R-3 are open warnings, not blockers."
  - test: "Buffered session.end on a live steering session (D76-14, D76-19)."
    expected: "The session is closed first (service.ts:2133 liveSessions.close, then the emit at :2136), so steering is closed whether or not the note lands. event_stored is false while the note is buffered and the wake-up hint is withheld (publishHint runs only on a stored event, service.ts:2831). docs/greptime-ledger.md:963 describes this. Owner ratification of this behaviour is still open."
    why_human: "Needs a live steering session and the owner's ratification of the behaviour."
  - test: "Keyed replay after a dead-letter record (R-1) on a live collector spool."
    expected: "Confirm which trigger occurs: Trigger A (one new row with a new id; the dead-letter record is orphaned, the common case) or Trigger B (two rows). The G3 answer for a replay of a pending give-up is code-verified (deadLettered: true, nothing appended, service-event-buffer.test.ts:334); the live replay after the record has left the buffer is not."
    why_human: "Needs a live collector spool and ledger."
  - test: "Operator decision to enable the buffer (D76-15)."
    expected: "SC1 holds with SUBSTRATE_EVENT_BUFFER_PATH and SUBSTRATE_EVENT_DEAD_LETTER_PATH set (config.ts:2589-2612 refuses boot when only the buffer path is set; docs/greptime-ledger.md:947 states the buffer is off by default). With the buffer unset, a failed write answers stored: false and nothing is queued. The operator must make and record this decision."
    why_human: "Configuration and policy decision, not code-verifiable."
  - test: "/healthz staleness."
    expected: "The body is memoised for SUBSTRATE_HEALTHZ_CACHE_MS (default 5000, config.ts:1202). Pollers see a depth change within that window."
    why_human: "Needs a running server and a poller."
  - test: "Owner confirmation of the D76-16 wording (decision, not a runtime check)."
    expected: "The owner states whether the accepted scope is 'pre-send refusals' (the orchestrator's decision text: covers every failed chain-tip read and append-mode probe) or 'breaker refusals only' (the wording quoted in the prior record). Under the first, this record stands. Under the second, the non-breaker tip and probe refusals are outside the accepted scope and the status becomes gaps_found."
    why_human: "The two wordings differ and the code follows the broader one; only the owner can choose."
---

# Phase 76: Telemetry buffer and dead-letter Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently. (origin/main ROADMAP, Phase 76)
**Verified:** 2026-11-02T22:18:40Z, re-verification on `gsd/v18-int-all` at HEAD `9ee12695`.
**Status:** human_needed
**Re-verification:** Yes. The prior record (75f5112d) is replaced. This pass re-read the code on this tree and re-ran two targeted test commands.

**Criteria source:** origin/main `.planning/ROADMAP.md`, `### Phase 76: Telemetry buffer and dead-letter`, Success Criteria 1 and 2. This tree's ROADMAP has the identical criteria text. The only differences are the Status line (origin/main "Not started", this tree "gaps_found: SC1 not verified pending owner decision D76-16; G1 to G3 closed in c7788f9d; SC2 by owner override") and the Plans line (origin/main "none written", this tree a link to 76-01). Neither is a criterion, so no criterion was chosen silently.

**Requirement cross-check:** `.planning/REQUIREMENTS.md:120` is HARD-R3 "Telemetry buffer/dead-letter (Phase 76)". It is not binding for this pass and is reported below, not counted.

**Gates:** the full gate is the orchestrator's run on this tree. This verifier did not run the full suite, tsc, lint, or formatters. No Postgres test was run by this verifier.

## What changed since the 75f5112d record, and what this pass checked

- Phase 76 implementation and test files are unchanged since c7788f9d. `git diff --name-only c7788f9d HEAD` lists none of `event-buffer.ts`, `event-dead-letter.ts`, `service.ts`, `greptime.ts`, `event.ts`, `config.ts`, `flag-registry.ts`, `server.ts`, `index.ts`, or the phase-76 test files. `git diff --stat 75f5112d HEAD -- docs/greptime-ledger.md` is empty.
- Code changed on the tree since 75f5112d, in `packages/mcp-server`: `observe.ts` (7 lines, `openAuditLog(config)` factory for the audit chain), `reconcile-main.ts`, `reconcile-repair.ts`, `repo-scope.ts`, `worktree-registry.ts`, and their tests. This pass checked the import graph: `event-buffer.ts` and `event-dead-letter.ts` are imported only by `config.ts`, `event-buffer.ts` and `service.ts`. None of the changed files imports them, and `observe.ts` imports only types from `config.ts` and `service.ts`. The `observe.ts` change is outside phase 76 and does not alter its behaviour. It is listed in `covered_files` because it is a changed file on the tree.
- `observe.ts` was read as a diff only (the audit-log construction moved into a factory). It does not touch the buffer, dead-letter, or write path.

## Scope decision (D76-16)

**The accepted scope, as recorded by the orchestrator for this pass:** "pre-send refusals accepted as SC1 scope." The prior record quoted the decision more narrowly as "a breaker refusal during the chain-tip read or the append-mode probe is answered `stored: false`, not buffered, because an event has no hash without its tip."

**Discrepancy, reported not resolved here.** The code refuses every failure of those two reads, not only breaker refusals:

- Chain-tip read: `service.ts:2986-2990` catches any error from `this.greptime.lastHash(...)` into `tipError`. `lastHash` (`greptime.ts:1483-1501`) reads through `sql` → `send`, whose transport catch at `greptime.ts:905-908` maps a non-breaker failure (connect timeout, 5xx) to `GreptimeUnavailable`. Only `BreakerOpenError` becomes `GreptimeBreakerOpen` (`:907`). Then `service.ts:2996-2999` returns `stored: false`.
- Append-mode probe: `service.ts:3003` is `ensureAppendMode().catch(() => null)`. Any probe failure becomes `appendOnly === null` and is refused at `:3004-3008` with `APPEND_MODE_UNKNOWN`.

So a connect timeout at the tip read, before the breaker opens, is answered `stored: false` and is not buffered. Under the orchestrator's wording ("pre-send refusals") that is within the accepted scope, and this record judges SC1 on that basis. Under the narrower breaker-only wording quoted in the prior record it is outside the accepted scope, and SC1 would be a gap for those refusals (status `gaps_found`). Only the owner can choose; see the human item "Owner confirmation of the D76-16 wording".

**No test covers these refusal branches.** The strings `chain tip unreadable`, `APPEND_MODE_UNKNOWN`, and `NOT_APPEND_ONLY` are not asserted in any `*.test.ts`. The behaviour of the accepted path is verified by code reading only. This is noted and not counted.

The owner's acceptance of D76-16 is the binding scope. The verifier does not find it acceptable or unacceptable.

## Fix verification (G1, G2, G3 from c7788f9d)

| Gap | Named test (file:line) | Code on 9ee12695 | Verdict |
| --- | ---------------------- | ---------------- | ------- |
| G1 torn dead-letter tail | `DeadLetterStore torn tail > a record written after a torn last line is readable: the torn line is skipped and the record is not glued to it` (`event-dead-letter.test.ts:77-88`) | `flush` `event-dead-letter.ts:141-156` sets `lead = "\n"` when `endsMidLine` (`:159-170`) reports the file does not end in a newline (`:148`). The torn line is malformed on read and skipped (`read` `:221-240`, `countOnFile` `:177-219`). | **CLOSED.** Named test passes (run 1). |
| G2 live write refused by the breaker spent an attempt | `a live write the breaker refused is buffered with its full budget, not given up at once` (`service-event-buffer.test.ts:319-332`) | `appendChained` `service.ts:3046`: `attempts = cause instanceof GreptimeBreakerOpen ? 0 : 1`; `:3047` buffers. `enqueue` `event-buffer.ts:229-281` with `attempts: 0` sets `next_at = at` and does not exhaust at once (`:231`). The drain treats `skipped` as no attempt (`event-buffer.ts:331-332`, `service.ts:3087`). | **CLOSED on the insert path.** Named test passes (run 1). |
| G3 keyed replay of a pending give-up answered as buffered | `a keyed replay of a pending give-up is refused as a give-up, not answered as buffered, and appends nothing` (`service-event-buffer.test.ts:334-349`) | `findKeyed` returns live entries only (`event-buffer.ts:190-192`); `findPendingKeyed` returns pending ones (`:195-197`); `appendChained` answers `deadLettered: true` for a pending match before any write (`service.ts:2976-2978`). | **CLOSED.** Named test passes (run 1). |

The probes from the prior pass (A, E, G, and others) were not re-run for this record and are not counted.

## Goal Achievement

### Observable Truths

| # | Truth (criterion) | Status | Evidence |
| - | ----------------- | ------ | -------- |
| 1 | A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash (SC 1) | ✓ VERIFIED within the accepted pre-send scope (D76-16) | **Insert path.** Live write fails: `service.ts:3024-3048`. Entry: `:3047` (`attempts: 1`), breaker refusal `:3046` (`attempts: 0`, G2). Bounded enqueue `event-buffer.ts:229-281`; over the bound the oldest live entry is given up (`:233-239`), or the new event is refused and not recorded (`:250-276`, `service.ts:3057-3062`). Backoff `eventBufferBackoffMs` `event-buffer.ts:40-44` (base 1 s, doubling, cap 60 s, ±20 % jitter). **Retry.** `drainEventBuffer` → `drain` `event-buffer.ts:287-293` → `runDrain` `:307-343`; delivery `deliverBuffered` `service.ts:3074-3093` with `insertEvent(..., { mayExist: true })` at `:3084`; `skipped` at `:3087` is not an attempt. **Budget exhausted.** `event-buffer.ts:335-337` → `dropFrom(..., "exhausted")` `:402-425` → `onDeadLetter` → `DeadLetterStore.record` `event-dead-letter.ts:102-122` (`event_hash` at `:108`). **Write-ahead.** A give-up whose record is not on disk stays pending: `enqueue` `:263-272`, `settlePending` `:354-368`, `findPendingKeyed` `:195-197`. **Out of this truth (accepted scope):** refusals at the chain-tip read and the append-mode probe, `service.ts:2996-2999`, `:3003-3008` (see Scope decision). |
| 2 | Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag (SC 2) | ✓ PASSED (override), not verified | **Reported:** health body carries `eventBuffer` (`service.ts:8706`: `enabled`, `EventBuffer.stats()` depth/max/oldestAt/durable/pending, and `deadLetter: { depth, durable }`). `/healthz` spreads the health body (`server.ts:984-1004`). Memoised for `SUBSTRATE_HEALTHZ_CACHE_MS` (`config.ts:1202`). **Buffer bound by flag:** `SUBSTRATE_EVENT_BUFFER_MAX` (`config.ts:2589-2612`, `flag-registry.ts:358`), enforced at `event-buffer.ts:229-233` and on hydrate `:460-463`. **Dead-letter bound:** none, by design (D76-13, owner override). |

**Score:** 2/2 must-haves verified: 1 VERIFIED within the accepted pre-send scope, 1 PASSED by owner override (not verified). Behaviour-unverified truths: 0.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-buffer.ts` | bounded per-session FIFO, backoff, give-up with write-ahead, file persistence, pending entries | ✓ VERIFIED with warnings | Enqueue `:229-281`; findKeyed `:190-192`, findPendingKeyed `:195-197`; drain `:287-293` (R-2); runDrain `:307-343`; settlePending `:354-368`; abandonAll `:299-305` (R-3); file save `append` `:467-488`, `compact` `:490-508` (0600 at `:483`, `:502`). |
| `packages/mcp-server/src/event-dead-letter.ts` | append-only dead-letter store, hash and reason, torn-tail safe write | ✓ VERIFIED (G1 closed) | `record` `:102-122`; `flush` with torn-tail lead `:141-156` (lead `:148`); `endsMidLine` `:159-170`; `countOnFile` `:177-219`; `read` `:221-240`. Deliberately unbounded (override). |
| `packages/mcp-server/src/service.ts` | wiring, write path, buffering, drain, shutdown, health | ✓ VERIFIED (accepted scope D76-16 applies to the refusals) | `appendChained` `:2961-3049`: keyed answer `:2974-2978`; tip refusal `:2982-2999`; append-mode refusal `:3003-3008`; live write and breaker attempts `:3024-3048`. `bufferEvent` `:3055-3067`; `deliverBuffered` `:3074-3093`; `drainEventBuffer` `:3106-3112`; `drainPendingEvents` `:3118-3124`; periodic tick `:3126-3132`. `closeLiveSession`: close `:2133`, emit `:2136`. Health `:8706`. |
| `packages/mcp-server/src/greptime.ts` | `insertEvent` with `mayExist`, breaker mapping, tip read | ✓ VERIFIED | `sql` `:872` → `send` `:~880-915`; transport catch and breaker mapping `:905-908`; `ensureAppendMode` `:1183-1192`; `lastHash` `:1483-1501`. Not re-read beyond these lines this pass. |
| `packages/mcp-server/src/event.ts` | payload wrap (PR 204) | ✓ VERIFIED (code); wrap tested for arrays only | `asPayloadRecord` `:220-224` wraps a scalar or array as `{ _payload }`. No test in `event.test.ts` covers a scalar payload (grep: none). Note only. |
| `packages/mcp-server/src/config.ts` | buffer settings, boot refusals | ✓ VERIFIED | `loadEventBufferSettings` `:2589-2612`: refusal without a dead-letter path, refusal when both paths name one file, bounds. |
| `packages/mcp-server/src/flag-registry.ts` | buffer flag rows | ✓ VERIFIED | `SUBSTRATE_EVENT_BUFFER_MAX` `:358`, `SUBSTRATE_EVENT_DEAD_LETTER_PATH` `:363` (prior pass), `SUBSTRATE_HEALTHZ_CACHE_MS` `:633`. |
| `packages/mcp-server/src/server.ts` | `/healthz` carries the health body | ✓ VERIFIED | Memoised compute and body spread of `health` `:984-1004`. |
| `packages/mcp-server/src/index.ts` | shutdown drains the buffer | ✓ VERIFIED (wiring) / ? (timing, human item 4) | `drainPendingRetains` `:249`; `drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })` `:252`. |
| `packages/mcp-server/src/observe.ts` | (not phase-76 behaviour) | ✓ NOT IN PHASE-76 PATH | `openAuditLog` factory; no buffer or dead-letter import. Changed since 75f5112d; no effect on this phase. |
| `docs/greptime-ledger.md` (phase 76 section) | flags and behaviour documented | ✓ VERIFIED (read) | Off by default `:947`; budget and backoff `:951`; boot refusal `:957`; not buffered `:961`; buffered `session.end` `:963`. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `appendChained` live write failure (insert) | `bufferEvent` → `EventBuffer.enqueue` | `service.ts:3046-3047` | ✓ WIRED | Breaker refusal enters with `attempts: 0` (G2). |
| `appendChained` tip read or append-mode probe refused | `bufferEvent` | none | ✓ NOT WIRED BY ACCEPTED SCOPE | Returns `stored: false` before the send (`service.ts:2996-2999`, `:3003-3008`). Owner-accepted under D76-16 as "pre-send refusals" per the orchestrator's decision text; the narrower wording would make the non-breaker case a gap (see Scope decision). |
| `EventBuffer` give-up | `DeadLetterStore.record` | `service.ts` `onDeadLetter` wiring (`:1963-1981`) | ✓ WIRED | Return value is the store's `durable`. |
| drain pass | `deliverBuffered` → `insertEvent(mayExist)` | `service.ts:3112`, `:3084` | ✓ WIRED | Breaker `skipped` is not an attempt (`:3087`). |
| shutdown | `drainPendingEvents` | `index.ts:252` → `service.ts:3118` | ✓ WIRED | Timing is human item 4 (R-2, R-3). |
| `health()` | `/healthz` body | `service.ts:8706` → `server.ts:984-1004` | ✓ WIRED | |
| `SUBSTRATE_EVENT_BUFFER_MAX` | buffer bound | `config.ts:2589-2612` → `service.ts:1963-1971` → `event-buffer.ts:229` | ✓ WIRED | |
| dead-letter depth | bound flag | none | ✓ ACCEPTED (override) | No bound flag by design (D76-13). |
| buffer and dead-letter depth | metrics export (HARD-R3 wording) | none | ✗ NOT WIRED | Only `/healthz` carries depth; no buffer or dead-letter gauge in `packages/mcp-server/src` (grep). Open wording question (HARD-R3 cross-check). Not counted. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `/healthz` `eventBuffer` | depth, max, oldestAt, durable, pending | `EventBuffer.stats()` over the live map (`event-buffer.ts:209-217`) | Yes | ✓ FLOWING |
| `/healthz` `eventBuffer.deadLetter` | depth, durable | `DeadLetterStore.depth()` (on file + held, `event-dead-letter.ts:92-94`) | Yes | ✓ FLOWING |
| dead-letter record | `event_hash` | `event.hash` of the buffered entry (`event-dead-letter.ts:108`) | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

Run from `/root/src/worktrees/as-gsd-v18-all`, `TMPDIR=/root/src/worktrees/backups/gate-tmpfs`, `SUBSTRATE_TEST_PG_URL` unset, no Postgres. Two targeted `bun test` commands, both run by this verifier.

| Command | Result | Status |
| ------- | ------ | ------ |
| Run 1: `bun test packages/mcp-server/src/service-event-buffer.test.ts packages/mcp-server/src/event-dead-letter.test.ts` (17 + 6 tests; includes G1 at `event-dead-letter.test.ts:77-88`, G2 at `service-event-buffer.test.ts:319-332`, G3 at `:334-349`) | 23 pass, 0 fail, 66 expect(), 23 tests across 2 files, 3.41 s | ✓ PASS |
| Run 2: `bun test packages/mcp-server/src/event-buffer.test.ts packages/mcp-server/src/flag-registry.test.ts scripts/config-reference.test.ts` | 65 pass, 0 fail, 372 expect(), 65 tests across 3 files, 7.10 s | ✓ PASS |

The run totals are the counts of every test in the named files. The per-test names are not in the summary output.

### Probe Execution

No probe is declared in the PLAN or SUMMARY. The scratch probes from the prior pass were not re-run for this record and are not counted.

### Requirements Coverage

HARD-R3 is the phase-76 requirement. It is not binding for this pass; cross-check below.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/service.ts` | 2986-2999, 3003-3008 | Every failed tip read and every failed append-mode probe is refused, not buffered; the code is broader than "breaker refusals" | ⚠️ Warning (scope) | Within the orchestrator's "pre-send refusals" decision. Outside the narrower wording quoted earlier. Owner decision open. |
| `packages/mcp-server/src/service.ts` | 2986-2999, 3003-3008 | No test asserts the tip-unreadable or append-mode refusal | ℹ️ Info | Accepted-scope behaviour verified by code reading only. |
| `packages/mcp-server/src/event-buffer.ts` | 287-293 | R-2: `drain` returns the in-flight pass and drops `options.all` | ⚠️ Warning | Shutdown can join a periodic pass and skip entries not yet due. Open. Human item 4. |
| `packages/mcp-server/src/event-buffer.ts` | 299-305 | R-3: `abandonAll` clears the entry in flight; an in-flight entry that lands is recorded `abandoned` | ⚠️ Warning | Open. Prior probe C: the landed event is in the ledger with an `abandoned` record. Duplicate, not loss. Human item 4. |
| `docs/greptime-ledger.md` | 963 | buffered `session.end` residual | ⚠️ Warning | Docs match the code (session closed first, note buffered). Owner ratification open (D76-14 / D76-19). Human item 5. |

Debt markers (`TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER`) in the phase-76 implementation and test files: none (grep, this pass).

**Residuals (at-least-once duplicates), documented in code:** `event-dead-letter.ts:99-100` (`record`), `:133-134` (`writeHeld`); `event-buffer.ts:350-353` (`settlePending`). A store write that fails partway and is retried can write a record twice; a crash between a store write and compaction hands a pending entry to the store again after boot. Both copies carry the same event id and hash.

**Warnings (not must-have failures; kept open):**
- R-1: keyed replay after a give-up. Trigger A (one new row with a new id) is the common case and lands once; Trigger B (two rows) is not reproduced. G3 closes the pending-state answer only (human item 6).
- R-2: `drain` joins an in-flight pass and drops `options.all` (`event-buffer.ts:287-293`; periodic tick `service.ts:3128-3131`; shutdown `service.ts:3121`).
- R-3: an in-flight entry abandoned at shutdown can be recorded `abandoned` and still land (`event-buffer.ts:299-305`).
- `abandonAll` on an unsaved buffer (`service.ts:3123`, `event-buffer.ts:299-305`): the abandoned entries are not compacted out of the file, so they can return at the next boot. Not reproduced.
- Shutdown bound: the retain pass (10 s) and the event pass (10 s) run in sequence (`index.ts:249-252`), before the transition pass (5 s) and flush (2 s).
- Payload wrap for a scalar payload is not directly tested (arrays only).

## Deferred Items

None. Phases 77 and 78 do not mention dead-letter, buffer, torn-write or breaker behaviour in their ROADMAP text (grep, this pass).

## HARD-R3 cross-check (not binding for this pass; reported, not counted)

HARD-R3: "Each destination has a bounded queue with backpressure. Failed batches retry with exponential backoff and jitter, then retain original payload and error in a durable dead-letter store. Per-record dedupe makes replay idempotent; export queue depth/dead-letter metrics. Preserve event-chain ordering and truthful write acknowledgements."

| Clause | Verdict | Evidence |
| ------ | ------- | -------- |
| Bounded queue with backpressure | Met as code (bounded; a full buffer refuses with `stored: false`) | `event-buffer.ts:229-281`, `service.ts:3057-3062` |
| Exponential backoff and jitter | Met (per event, not per batch) | `event-buffer.ts:40-44` |
| Retain payload and error in a durable store | Met with buffer on (record holds the event and `last_reason`); durable only when saved | `event-dead-letter.ts:102-122` |
| Per-record dedupe makes replay idempotent | Partly: `mayExist` and the keyed replay cover a known id. R-1 (fresh row after a give-up) and keyless resends leave gaps. | `service.ts:3084`, `:2974-2978` |
| Export queue depth / dead-letter metrics | ✗ NOT MET AS WRITTEN: depth is in `/healthz` only; no buffer or dead-letter gauge in `packages/mcp-server/src`. ROADMAP SC2 says "reported in /healthz", so the two texts differ. | `service.ts:8706`, `server.ts:984-1004` |
| Ordering and truthful acknowledgements | Met for ordering (`prev` fixed at queue time, `event-buffer.ts:12-16`); acknowledgements are truthful for the paths above, and refusals at the tip and append-mode reads are truthful (`stored: false`) | `service.ts:2996-2999`, `:3003-3008` |

## Open decisions (kept open; none upgraded to verified)

| Decision | State | Where |
| -------- | ----- | ----- |
| D76-16: live writes refused before the send (chain-tip read, append-mode probe) are not buffered | ACCEPTED by the owner on 2026-11-02 as the scope of SC1, recorded by the orchestrator as "pre-send refusals". Wording conflict with the earlier "breaker refusal" text; the code follows the broader reading. Owner to confirm. Not a verifier finding. | `service.ts:2996-2999`, `:3003-3008`; `docs/greptime-ledger.md:961`; human item 9 |
| D76-15: buffer is opt-in (off by default) | OPEN, operator decision. Criterion 1 holds only when enabled. | Human item 7; `docs/greptime-ledger.md:947` |
| D76-13: dead-letter store unbounded; depth reported, no flag | Owner override recorded 2026-11-02; a tracked follow-up. Carried as PASSED (override), NOT verified. | Must-have 2; `event-dead-letter.ts:11-12` |
| D76-14 / D76-19: buffered `session.end` and steering session | OPEN. Docs match the code (session closed first, note buffered). Owner has not ratified it. | Human item 5; `service.ts:2133`, `:2136`; `docs/greptime-ledger.md:963` |
| HARD-R3 "export queue depth/dead-letter metrics" vs ROADMAP SC2 "reported in /healthz" | OPEN, owner: which wording governs | HARD-R3 cross-check; `.planning/REQUIREMENTS.md:120` |
| R-1: keyed replay after a give-up, Trigger A vs B | OPEN. G3 closed for the pending state; the live check is still needed. | Human item 6 |
| R-2: shutdown joins a periodic pass | OPEN. Confirmed by reading. | Human item 4 |
| R-3: in-flight entry abandoned at shutdown | OPEN. Partly reproduced (prior probe C). | Human item 4 |

## Human Verification Required

Items 1 to 9 in the frontmatter. They are operator proofs and owner decisions, and they are not counted as verified. Item 9 is new in this pass: the owner must confirm which D76-16 wording governs.

**Why human_needed.** No must-have is FAILED under the accepted scope. No artifact is missing or a stub, and no key link required by the in-scope SC1 path is unwired. No blocker anti-pattern remains. The warnings (R-1, R-2, R-3, the scope wording, the untested refusal branches) are not blockers under the orchestrator's scope. Human items exist, so rule 2 of the decision tree routes the status to `human_needed`.

## Corrections to the previous report (75f5112d record)

- The previous record quoted D76-16 as "a breaker refusal during the chain-tip read or the append-mode probe". The orchestrator's decision for this pass is "pre-send refusals accepted as SC1 scope". The code matches the second. The record now states the discrepancy and asks the owner to confirm (human item 9).
- The previous record said the tip-read and probe refusals were "breaker refusal" only; the code refuses any failure of those reads (see Scope decision).
- The previous record's statement that phase-76 code under `packages/mcp-server` was unchanged since c7788f9d is still true for the phase-76 files. The `packages/mcp-server` tree changed in `observe.ts` and the reconcile, repo-scope, and worktree-registry files, none of which is in the phase-76 path.

## Gaps Summary

No gaps under the accepted scope. SC1 is verified within the pre-send scope (D76-16 as recorded by the orchestrator). SC2 is passed by the owner's override (D76-13). The status is `human_needed` because the operator items (live rehearsal, dead-letter exhaustion, torn-tail crash, shutdown timing, buffered `session.end` ratification, R-1 live check, D76-15 enable decision, `/healthz` staleness) and the D76-16 wording confirmation remain open.

---

_Verified: 2026-11-02T22:18:40Z_
_Verifier: Claude (gsd-verifier, re-verification of phase 76 on gsd/v18-int-all, HEAD 9ee12695)_
