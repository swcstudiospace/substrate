---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-19T13:23:15Z
status: human_needed
score: 2/2 truths verified (criterion 2 carried as PASSED (override), owner-accepted 2026-11-02)
behavior_unverified: 0
overrides_applied: 1
covered_files: [".env.example", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-PLAN.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-SUMMARY.md", "docs/config-reference.md", "docs/greptime-ledger.md", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-buffer.test.ts", "packages/mcp-server/src/event-buffer.ts", "packages/mcp-server/src/event-dead-letter.test.ts", "packages/mcp-server/src/event-dead-letter.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/reanchor-run.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:61bc4f3db4edb80075ce05304d30b2d379066d1d9e4496a1b38058b49ba1d16a"
overrides:
  - must_have: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag."
    reason: "Owner accepted the override on 2026-11-02. The dead-letter store is deliberately unbounded (plan decision D76-13): a bound would have to drop records, the silent loss this phase removes. The buffer is bounded by SUBSTRATE_EVENT_BUFFER_MAX, and the depth of both stores is reported in /healthz. A dead-letter cap is a tracked follow-up."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: 2/2
  gaps_closed: []
  gaps_remaining: []
  regressions: []
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
    why_human: "Needs a live spool and ledger."
  - test: "Operator decision to enable the buffer (D76-15)."
    expected: "Decide whether a deployment sets SUBSTRATE_EVENT_BUFFER_PATH and SUBSTRATE_EVENT_DEAD_LETTER_PATH. Criterion 1 holds only in a deployment that sets both; the buffer is off by default."
    why_human: "An operator configuration decision."
  - test: "/healthz staleness: poll /healthz during a depth change."
    expected: "The body is memoised for SUBSTRATE_HEALTHZ_CACHE_MS (default 5000); pollers see the change within that window."
    why_human: "Needs a live poller against the running service."
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 76: Telemetry buffer and dead-letter Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently.
**Verified:** 2026-11-19T13:23:15Z
**Status:** human_needed
**Re-verification:** Yes — refreshed at HEAD ee998735dce82872df0302501e8b0a49c9914648 (prior record 2026-11-18T12:25:00Z, human_needed, 2/2)
**Commit verified:** ee998735dce82872df0302501e8b0a49c9914648

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash. | ✓ VERIFIED | `service.ts:1959-1973` builds `EventBuffer` + `DeadLetterStore` when `config.eventBuffer` set, `onDeadLetter: deadLetters.record`; `service.ts` `appendChained`/`bufferEvent`/`deliverBuffered`/`drainPendingEvents` (3140) wire failed writes into the buffer; `event-buffer.ts:34,189,233,284,334,373` implements bounded FIFO, overflow, cascade `predecessor-dead-lettered`, `eventBufferBackoffMs` (base×2^attempt capped, ±20% jitter), `maxAttempts` exhausted → dead-letter; `event-dead-letter.ts` `record()` writes hash/reason/attempts/event as JSONL; `greptime.ts:1253,1296` `insertEvent({mayExist})`/`eventRowPresent` makes retries idempotent; `mcp.ts:1201-1202` and `server.ts:1384-1385` surface `buffered`/`deadLettered`; `index.ts:252` shutdown drain. Tests present: `event-buffer.test.ts`, `event-dead-letter.test.ts`, `service-event-buffer.test.ts`, `greptime.test.ts` mayExist block. |
| 2 | Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag. | ✓ VERIFIED (PASSED (override) for dead-letter bound) | `service.ts:8766` `eventBuffer: enabled:false` when off, else `{enabled:true, ...buffer.stats(), deadLetter:{depth,durable}}` flowing into `/healthz` via `health()`; `config.ts:2585-2607` `loadEventBufferSettings` reads `SUBSTRATE_EVENT_BUFFER_MAX` (default 256), maxAttempts, backoff caps, and throws `ConfigError` naming `SUBSTRATE_EVENT_DEAD_LETTER_PATH` when buffer set without it; `flag-registry.ts:358-363`, `.env.example:40-46`, `docs/config-reference.md:80-85` document the flags. Dead-letter depth reported but unbounded by design (D76-13) — owner-accepted override 2026-11-02. |

**Score:** 2/2 truths verified (1 present, 1 PASSED (override))

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/event-buffer.ts` | Bounded per-session FIFO, backoff+jitter, overflow/cascade, JSONL persistence | ✓ VERIFIED | Exists at HEAD, substantive (17.2K), wired in `service.ts` |
| `packages/mcp-server/src/event-dead-letter.ts` | Append-only JSONL dead-letter store with hash | ✓ VERIFIED | Exists, `record()` carries `event_hash`, reason, attempts |
| `packages/mcp-server/src/service.ts` | Buffer construction, queue-behind-tail, drain in session turn, health depths | ✓ VERIFIED | Lines 1959-1973, 2882-3141, 8766 |
| `packages/mcp-server/src/config.ts` | Opt-in buffer settings, boot refusal without DL path | ✓ VERIFIED | `loadEventBufferSettings` 2585-2607 |
| `packages/mcp-server/src/greptime.ts` | `mayExist` retry idempotency | ✓ VERIFIED | `insertEvent` 1253, `eventRowPresent` 1296 |
| `packages/mcp-server/src/mcp.ts` / `server.ts` | Surface `buffered`/`deadLettered` | ✓ VERIFIED | mcp.ts:1201-1202, server.ts:1384-1385 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `Substrate.appendChained` | `EventBuffer` | `bufferEvent` on failed write | WIRED | service.ts bufferEvent path |
| `EventBuffer` exhausted | `DeadLetterStore.record` | `onDeadLetter` callback | WIRED | service.ts:1971 |
| `health()` | `/healthz` | spread in `server.ts` | WIRED | `eventBuffer` field at service.ts:8766 |
| `index.ts` shutdown | `drainPendingEvents` | await with abandon | WIRED | index.ts:252 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| service.ts health | `eventBuffer.depth`, `deadLetter.depth/durable` | `buffer.stats()` / `deadLetters.depth()` live counters | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

SKIPPED per assignment (do not run tests/tsc/biome/knip/formatters). Code inspection only; targeted test files exist (`service-event-buffer.test.ts` etc.) but were not executed in this re-verification.

### Probe Execution

None declared for this phase.

### Requirements Coverage

Roadmap Phase 76 success criteria (ROADMAP.md:1315-1326) are the two truths above; both verified in code. No separate REQUIREMENTS IDs mapped to this phase in PLAN.

### Anti-Patterns Found

No `TODO/FIXME/XXX/placeholder/console.log` in `event-buffer.ts` / `event-dead-letter.ts` at HEAD (grep clean).

### Human Verification Required

See frontmatter `human_verification` (8 items, all operator/live-only): live Greptime outage rehearsal, dead-letter exhaustion timing, restart with durable file, service-manager shutdown timing, buffered `session.end` on live session, keyed replay after dead-letter (R-1), operator decision to enable buffer paths (D76-15, off by default), `/healthz` cache staleness.

### Gaps Summary

No FAILED truths, no missing artifacts, no unwired links. Both success criteria hold in code at HEAD ee998735; criterion 2's dead-letter half is unbounded by design under the owner-accepted override. Status is `human_needed` solely because the eight live/operator items above cannot be proven by code inspection.

**Warnings (not must-have failures):**
- R-1 (keyed replay Trigger B) and R-2 (shutdown pass joining a periodic pass) unchanged from prior record; remain live checks.
- `docs/greptime-ledger.md` "about five minutes" vs nominal 243 s budget (doc nit, prior record).

---

_Verified: 2026-11-19T13:23:15Z_
_Verifier: Claude (gsd-verifier)_
