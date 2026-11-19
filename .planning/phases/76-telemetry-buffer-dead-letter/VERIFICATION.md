---
phase: 76-telemetry-buffer-dead-letter
verified: 2026-11-19T12:00:00Z
status: human_needed
score: 2/2 ROADMAP success criteria verified in repo code and tests; 3 human items (2 operator gates, 1 scope decision)
re_verification:
  previous_status: human_needed
  previous_score: 2/2 ROADMAP success criteria verified in code and tests; 3 human items (2 operator gates, 1 scope decision)
  gaps_closed: []
  gaps_remaining: []
  regressions: []
overrides_applied: 0
behavior_unverified: 0
covered_files:
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
covered_digest: "v3:sha256:506659ae36478fd1b427b34f5254e07b166abd251a2692ab2b665bd69441fd50"
human_verification:
  - test: "Set SUBSTRATE_LEDGER_BUFFER_PATH and SUBSTRATE_LEDGER_DEAD_LETTER_PATH in the production substrate-mcp unit (a StateDirectory path), then restart with a parked event and inspect /healthz."
    expected: "The buffer and dead-letter files exist 0600 under the state directory; after restart /healthz.eventBuffer reports pending >= 1 with durable true and deadLetters.durable true. Resume: edit infra/vps/substrate-mcp.service (or a .d drop-in) to set both variables, systemctl daemon-reload && systemctl restart substrate-mcp, then curl /healthz."
    why_human: "Operator gate. At HEAD, infra/vps/substrate-mcp.service and substrate-mcp.service.d/ set neither variable (grep finds no SUBSTRATE_LEDGER_BUFFER_PATH or SUBSTRATE_LEDGER_DEAD_LETTER_PATH under infra/), so production runs memory-only (CONTEXT D76-11). Changing the unit and confirming on the host is out of repo scope."
  - test: "Decide what happens to a held claim whose buffered event is lost (memory-only restart or crash) or never lands."
    expected: "A recorded decision: the reconcile path (phase 78) or an operator procedure that releases or re-emits the claim. Resume: record the decision in CONTEXT/SUMMARY and, if needed, a follow-up plan."
    why_human: "Operator policy choice, not a code defect. Since commit e20f3634 a parked claim is recorded and kept (service.ts:5607 recorded = emitted.stored || emitted.buffered === true); withdrawal happens only for dead-lettered or refused events. A claim whose buffered event disappears in a memory-only restart stays held with no ledger event behind it."
  - test: "Decide whether a refusal before the write (chain tip unreadable, append-mode unknown) should be buffered, or documented as accepted loss during a long ledger outage."
    expected: "A recorded decision on D76-01. Either buffering that input with the hash computed at drain time, or an explicit accepted-loss statement that also covers long outages, reflected in docs/greptime-ledger.md 'Not covered'. Resume: update CONTEXT D76-01 and docs, then re-verify."
    why_human: "Scope call against the goal sentence 'No event is dropped silently'. D76-01 excludes these refusals from the buffer; docs/greptime-ledger.md names only the tip and append-only cases."
---

# Phase 76: Telemetry buffer and dead-letter - Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently.
**Verified:** 2026-11-19T12:00:00Z
**Status:** human_needed
**Re-verification:** Yes — after the prior `human_needed` verification of 2026-11-12. No `gaps:` section existed; this pass re-checked every prior item against current HEAD.
**code review skipped (Greptile unavailable, owner override 2026-11-19 — CI gates apply)**

This report separates **repo-verified parts** (code, config, docs, tests — verified below with `file:line` evidence) from **operator gates** (systemd unit changes, claim-withdrawal policy, D76-01 scope decision — deferred to `76-UAT.md` with resume commands).

## Repo-verified parts

### Success Criterion 1 — bounded buffer, retry with backoff, dead-letter with hash

| Claim | Evidence |
|-------|----------|
| Failed `insertEvent` parks the event instead of returning `stored: false` alone | `packages/mcp-server/src/service.ts:3050` (`return this.parkEvent(event, error, true)`) from `appendChained` (`service.ts:2979`); `parkEvent` at `service.ts:3059` enqueues and answers `{ stored: false, buffered: true, error: ...; buffered for retry }` (`service.ts:3066`). |
| Bounded buffer with overflow dead-letter | `EventBuffer` class `packages/mcp-server/src/event-buffer.ts:207`; bound from `config.eventBuffer.max` (`service.ts:2007`, read from `SUBSTRATE_LEDGER_BUFFER_MAX` at `config.ts:1222`); overflow dead-letters only the new event (`event-buffer.ts`, cause `overflow`, `event-buffer.ts:49`). |
| Exponential backoff with jitter | `outboxBackoffMs` in `packages/mcp-server/src/outbox-file.ts:39` (base × 2^attempt, capped, ±20% jitter, `outbox-file.ts:36`); buffer schedules `next_at` with it (`event-buffer.ts:283`, `event-buffer.ts:373`). |
| Retry budget → dead-letter record carrying the hash | `DeadLetterRecord.hash` (`event-buffer.ts:54`, comment at `event-buffer.ts:51`); exhaustion cascade with `chain-blocked` (`event-buffer.ts:384`); `DeadLetterStore` class (`event-buffer.ts:131`); budget from `SUBSTRATE_LEDGER_BUFFER_MAX_ATTEMPTS` (`config.ts:1223`). |
| Ambiguous writes checked before retry | `GreptimeClient.eventStored(id)` — single-row existence read (`packages/mcp-server/src/greptime.ts:1338`); used by `deliverBufferedEvent` (`service.ts:4192`). |
| Chain order preserved | `appendChained` chains behind the parked tail (`service.ts:3005` `tipOf`, `service.ts:3019` park-behind); keyed replay of a parked event answers without writing (`service.ts:2989` `find`, `service.ts:2998`). |
| Shutdown gives one due pass, then abandons to dead letters | `packages/mcp-server/src/index.ts:255` — `substrate.drainPendingEvents(SHUTDOWN_EVENT_MS, { abandon: true })`; `abandonAll()` at `event-buffer.ts:328`; `drainPendingEvents` at `service.ts:4232`. |
| Tests cover the four required cases | `packages/mcp-server/src/event-buffer.test.ts` (14 `test(` cases — buffer/dead-letter unit behaviour) and `packages/mcp-server/src/service-event-buffer.test.ts` (13 cases — park/retry/exhaust/overflow/health). Retain-outbox refactor still covered by `packages/mcp-server/src/retain-outbox.test.ts`. Per assignment, no test suite was run in this pass (SKIP gates); test presence and case composition were observed, not executed [INFERENCE: current pass state relies on the 2026-11-12 verifier's test runs plus unchanged behaviour since — see Drift]. |

### Success Criterion 2 — `/healthz` depth, bounded by flag

| Claim | Evidence |
|-------|----------|
| Buffer and dead-letter depth in `/healthz` | `health()` spreads `eventBuffer: this.eventBufferHealth()` (`service.ts:8910`); `eventBufferHealth()` at `service.ts:9028` reports `pending`, `max`, `oldestAt`, and the dead-letter block (`depth`, `max`, `durable`, `evicted`). Health does not change HTTP status (CONTEXT D76-12). |
| Bounded by flags (5 variables, registry + `.env.example` + docs) | `config.ts:1221-1225` reads all five (`SUBSTRATE_LEDGER_BUFFER_PATH`, `SUBSTRATE_LEDGER_BUFFER_MAX`, `SUBSTRATE_LEDGER_BUFFER_MAX_ATTEMPTS`, `SUBSTRATE_LEDGER_DEAD_LETTER_PATH`, `SUBSTRATE_LEDGER_DEAD_LETTER_MAX`); registry rows `packages/mcp-server/src/flag-registry.ts:360-364`; `.env.example:44-51`; flag table `docs/greptime-ledger.md:1049-1053` and buffer section `docs/greptime-ledger.md:954-966`. Defaults: 1000 / 10 / 10000 (`flag-registry.ts:361-364`). |
| Requirement HARD-R3 (REQUIREMENTS.md) | `HARD-R3` at `.planning/REQUIREMENTS.md` ("Telemetry buffer/dead-letter (Phase 76): bounded queue with backpressure, exponential backoff and jitter, durable dead-letter store retaining payload and error, per-record dedupe, export queue depth, preserve event-chain ordering and truthful write acknowledgements") — each clause is satisfied by the evidence above: bounded queues (`event-buffer.ts:207`, `event-buffer.ts:131`), backoff+jitter (`outbox-file.ts:39`), durable dead-letter with hash (`event-buffer.ts:54`), per-record dedupe via keyed replay + `eventStored` (`service.ts:2989`, `greptime.ts:1338`), depth export (`service.ts:8910`), chain ordering (`service.ts:3005`), truthful acknowledgements (`service.ts:3066`). |

### Anti-pattern scan

`grep` for `TODO|FIXME|XXX|console.log` over `event-buffer.ts` and `outbox-file.ts` found no hits. No stub returns observed in the phase's new code (`parkEvent`, `deliverBufferedEvent`, `outboxBackoffMs` all perform their described work). No blockers.

### Drift since the 2026-11-12 verification

`git log --since=2026-11-12` on the phase files shows unrelated later work touching `service.ts` (RAGFlow-backend removal `ab1fc338`, docs ingest naming `848de624`, Linear DAG validation `5e5062d1`, `7ad2b204`, phases 67/74/handoff `8b8521b9`) — none of it modifies the event-buffer paths, and the phase-76 symbols cited above were re-grep'd at current HEAD so the line numbers in this report are current. The infra gate is unchanged: `grep` for `SUBSTRATE_LEDGER_BUFFER_PATH` / `SUBSTRATE_LEDGER_DEAD_LETTER_PATH` under `infra/` returns no matches.

## Operator gates (deferred — see 76-UAT.md)

1. **Systemd paths (operator gate).** `infra/vps/substrate-mcp.service` and its `.d` drop-ins set neither buffer nor dead-letter path, so production runs memory-only (CONTEXT D76-11). Needs an operator to set both variables in the unit and confirm `/healthz.eventBuffer` reports durable files after a restart with a parked event.
2. **Claim-withdrawal policy (operator gate).** Parked claims are recorded and kept (`service.ts:5607`); a claim whose buffered event is lost in a memory-only restart stays held with no ledger event behind it. Needs a recorded decision (phase-78 reconcile path or an operator procedure).
3. **D76-01 scope decision.** Refusals before the write (chain tip unreadable, append-mode unknown) stay unbuffered. Needs a recorded decision on whether that is accepted loss or buffered-with-late-hash.

## Gaps Summary

No ROADMAP success criterion is unmet in repo code — both verified above with `file:line` evidence. Status is `human_needed` solely because the production effect depends on operator-gated changes (gates 1 and 2) and the D76-01 scope decision (gate 3). Steps for each, with resume commands, are in `76-UAT.md`.

---

_Verified: 2026-11-19T12:00:00Z_
_Verifier: Claude (gsd-verifier)_
