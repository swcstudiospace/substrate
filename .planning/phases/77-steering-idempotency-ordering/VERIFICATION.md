---
phase: 77-steering-idempotency-ordering
verified: 2026-11-19T12:00:00Z
status: human_needed
score: 5/6 must-haves verified in process (restart durability not observed here)
overrides_applied: 0
behavior_unverified: 1
covered_files: [".planning/phases/77-steering-idempotency-ordering/CONTEXT.md", ".planning/phases/77-steering-idempotency-ordering/PLAN.md", ".planning/phases/77-steering-idempotency-ordering/SUMMARY.md", "docs/live-steering.md", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/planning/steering-idempotency.pg.test.ts", "packages/mcp-server/src/planning/steering-idempotency.test.ts", "packages/mcp-server/src/planning/steering-idempotency.ts", "packages/mcp-server/src/planning/steering-rest.test.ts", "packages/mcp-server/src/planning/steering-rest.ts", "packages/mcp-server/src/planning/steering-store.ts", "packages/mcp-server/src/planning/steering-tools.test.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/planning/steering.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v4:sha256:9a74665ed500e39b9d89713bd81609527b4d1b4a0512497cbc8dca4af8d4c3de"
behavior_unverified_items:
  - truth: "Replay after a restart returns the original result and writes nothing; delivery sequence survives a restart"
    test: "Run packages/mcp-server/src/planning/steering-idempotency.pg.test.ts against a disposable Postgres (SUBSTRATE_TEST_PG_URL set)"
    expected: "Six restart cases pass, including keyed queue and keyed acknowledgement replayed after restart with the same reply and no second row (steering-idempotency.pg.test.ts:166,184,208,223,239,254)"
    why_human: "Code present and wired (migrations 44/45, savedKeyedQueue, readSequenceFloor), but no Postgres was run by this verifier; the pg suite was not executed in this session."
human_verification:
  - test: "Rehearse migrations 44 (planning_steering_audit_delivery) and 45 (planning_steering_movements) on a restored production dump, per docs/runbooks/rollback-compat.md. Then run packages/mcp-server/src/planning/steering-idempotency.pg.test.ts with SUBSTRATE_TEST_PG_URL set to a disposable Postgres."
    expected: "Migrations apply and roll back as documented. Six of six restart cases pass."
    why_human: "Operator-gated: production migrations and restored-dump rehearsal are not run by an agent. No Postgres available to the verifier."
  - test: "Owner reading of criterion 1 'writes nothing': a replayed keyed command still writes one access-audit row (audit-before-effect in executeLiveCall). Confirm this means no steering or session transition, not no access-audit row."
    expected: "Owner accepts the reading, or opens a separate decision to skip the access-audit write on replay."
    why_human: "ROADMAP wording against the house audit-before-effect rule is a policy call."
  - test: "Before SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE is enabled in production, confirm migrations 44 and 45 ran and the durable replay path is live (durable sink selected only when the flag is on; steering-store.ts:47)."
    expected: "Operator approval recorded; no flag change performed by an agent."
    why_human: "Production flag and migration change; operator gate."
re_verification:
  previous_status: human_needed
  previous_score: 5/6
  gaps_closed: []
  gaps_remaining:
    - "Replay after a restart returns the original result and writes nothing; delivery sequence survives a restart (behavior-unverified, pg suite not run)"
  regressions: []
---

# Phase 77: Steering idempotency and ordering — Verification Report

**Phase Goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Verified:** 2026-11-19T12:00:00Z
**Status:** human_needed
**Re-verification:** Yes — prior VERIFICATION.md (human_needed, 5/6) re-checked against current code. This run re-inspected code paths and named tests; gates/formatters skipped per assignment (no `bunx tsc --noEmit`, no test runs, no lint). code review skipped (Greptile unavailable, owner override 2026-11-19 — CI gates apply).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A replayed keyed command returns the original result and writes no steering or session transition (in process) | ✓ VERIFIED | `packages/mcp-server/src/planning/steering-tools.ts:167-169` — keyed queue routes through `wiring.idempotency.serialize`; `keyedQueue` (:183-201) answers a held directive from the inbox (no enqueue) or from `savedKeyedQueue` (:192-197). `applyAcknowledgement` (:222-238) returns a recalled/durable reply before `run()`, and `run()` executes only on a miss. Tests exist: `steering-tools.test.ts:224` "a replayed keyed queue returns the original reply and writes nothing", :272 "a replayed keyed acknowledgement returns the stored reply and writes no second row", :283 "does not move it again", :303 concurrent identical acks apply once. |
| 2 | Unkeyed commands keep working unchanged (owner decision 2026-10-30) | ✓ VERIFIED | `steering-tools.ts:168` — `key === undefined` takes the pre-existing `enqueueDirective` path with a fresh id; unkeyed acknowledgement is `recordSession(wiring, await run())` (:224). `keyedAcknowledgementOf` (:241-248) returns `undefined` unkeyed. Test `steering-tools.test.ts:262` "an unkeyed queue keeps its reply shape and a fresh id, and is never deduplicated". REST shape test `steering-rest.test.ts:319-320` confirms unkeyed body gains no `idempotency_key`. |
| 3 | A keyed reply exposes its sequence; a replay returns the same sequence (in process) | ✓ VERIFIED | `keyedQueue` returns `sequence: deliverySequence(inbox, id)` (:189, :197, :201); `deliverySequence` (:210-214) reads `inbox.sequenceOf` and throws rather than guessing. `applyAcknowledgement` keeps `{ ...reply, sequence }` (:236-237). Test `steering-tools.test.ts:235` "a replay keeps its sequence after later commands are queued" asserts equality with the first reply. |
| 4 | Two distinct keyed commands are delivered in sequence order; a replay does not reorder them (in process) | ✓ VERIFIED | `steering-tools.test.ts:323-333` "two distinct keyed commands are delivered in sequence order, and a replay does not reorder them" — asserts strictly increasing sequences and a stable order across a replay. Wiring unchanged: `nextQueuedDirective` cursor (per CONTEXT D77-08). |
| 5 | `restDirective`, the REST listing and the `/steering/wait` reply expose the sequence (`null` when the inbox does not hold it) | ✓ VERIFIED | `packages/mcp-server/src/planning/steering-rest.ts:97` `restDirective(record, sequence)`; `:155` `listRestDirectives` passes `inbox.sequenceOf`; `packages/mcp-server/src/server.ts:2378` wait reply passes `sequenceOf(...) ?? null`. Test `steering-rest.test.ts:329-335` asserts `sequence: 2` held and `null` not held. |
| 6 | Replay after a restart returns the original result and writes nothing; delivery sequence survives a restart | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Code present and wired: migration 44 `planning_steering_audit_delivery` (`index-store.ts:960-991`, `optIn: "steering-audit"`), migration 45 `planning_steering_movements` (`index-store.ts:993+`), `savedKeyedQueue` (`steering-store.ts:124,195,309,530`), `readSequenceFloor` (`steering-store.ts:335,586,666`), durable read in `keyedQueue`/`durableAcknowledgementOf` (`steering-tools.ts:192,237`). Six restart cases exist: `steering-idempotency.pg.test.ts:166,184,208,223,239,254`. But the pg suite was not run in this session (no disposable Postgres; gates skipped per assignment), so the restart behavior is present, not observed. See `behavior_unverified_items`. |

**Score:** 5/6 truths verified (1 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/planning/steering-idempotency.ts` | Key-derived id, fingerprints, per-key lanes, bounded reply index | ✓ VERIFIED | `keyedDirectiveId` = `idem-` + sha256 over `steering.queue.v1\0surface\0key` (:29-31); `STEERING_IDEMPOTENCY_MAX_ENTRIES` = 10,000; module docblock describes durable replay after restart via migrations 44/45. |
| `packages/mcp-server/src/planning/steering-tools.ts` | `idempotency_key` on both inputs; keyed branches | ✓ VERIFIED | `STEERING_QUEUE_INPUT`/`STEERING_ACKNOWLEDGE_INPUT` carry `idempotency_key` (:26, :28); `SteeringWiring.idempotency` (:154); keyed/unkeyed split at :168. |
| `packages/mcp-server/src/planning/steering.ts` | `idempotency-conflict` refusal vocabulary | ✓ VERIFIED | `steering.ts:229` includes `"idempotency-conflict"`. |
| `packages/mcp-server/src/planning/steering-rest.ts` | Body parsers accept key; sequence on REST shape | ✓ VERIFIED | `QUEUES_FIELDS`/`ACKNOWLEDGE_FIELDS` include `idempotency_key` (:179-180); parsers pass it through (:213, :230); `restDirective(record, sequence)` (:97). |
| `packages/mcp-server/src/planning/steering-store.ts` | Durable key/sequence reads; sequence floor | ✓ VERIFIED (code); restart behaviour human | `savedKeyedQueue` (interface :124, impl :195, :309, :530); `readSequenceFloor` (:335); env flag `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` (:47). |
| `packages/mcp-server/src/index-store.ts` | Migrations 44 and 45 | ✓ VERIFIED (code); applied only under opt-in | `version: 44` :960 `planning_steering_audit_delivery`, `version: 45` :993 `planning_steering_movements`, both `optIn: "steering-audit"`. Comments say "OPERATORS: rehearse on a restored dump before production". |
| `packages/mcp-server/src/server.ts` | Wait reply carries sequence | ✓ VERIFIED | :2378 `restDirective(waited.record, ...sequenceOf(...) ?? null)`. |
| `packages/mcp-server/src/service.ts` | One `SteeringIdempotency` per process | ✓ VERIFIED | :1953 `idempotency: new SteeringIdempotency<SteeringAcknowledgeReply>()`; migration opt-ins wired at :1812. |
| `packages/mcp-server/src/mcp.ts` | Tool descriptions name key, replay, sequence | ✓ VERIFIED | :2473-2475 (queue), :2498 (acknowledge). |
| `docs/live-steering.md` | Field rows, idempotency section, limits | ✓ VERIFIED with stale line | Field rows :70-71, idempotency section :79-82. :33 still says "Queue/ack remain **unkeyed**" (stale, non-blocking). |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `queueSteering` (keyed) | `SteeringIdempotency.serialize` | `wiring.idempotency.serialize(surface, key, …)` | ✓ WIRED | `steering-tools.ts:169` |
| `keyedQueue` (restart) | durable queued row | `wiring.durable?.savedKeyedQueue` | ✓ WIRED | `steering-tools.ts:192-197` |
| `applyAcknowledgement` | session port | `run()` only when no stored reply | ✓ WIRED | returns stored before `run()` at :233; `run()` at :235 |
| `applyAcknowledgement` (kept reply) | index | `wiring.idempotency.remember` | ✓ WIRED | `steering-tools.ts:237` |
| `restore` | sequence counter | `readSequenceFloor` | ✓ WIRED | `steering-store.ts:586,666` |

### Behavioral Spot-Checks

Not run this session — gates skipped per assignment. Prior run (2026-11-12) observed 60/60 passing across `steering-idempotency.test.ts`, `steering-tools.test.ts`, `steering-rest.test.ts`.

### Probe Execution

No probes declared. Skipped.

### Requirements Coverage

Phase success criteria 1–3 map to truths 1–6 above. Criteria 1 and 3 hold in process; the across-restart half is truth 6 (behavior-unverified). Criterion 2 fully holds (truth 2).

### Anti-Patterns Found

None in the fingerprinted files this run. Note: `docs/live-steering.md:33` stale line (carried W2, non-blocking).

### Human Verification Required

See `human_verification` frontmatter and `77-UAT.md`. Restart durability (truth 6) remains the one unverified MUST-HAVE; migrations 44/45 rehearsal is operator-gated.

### Gaps Summary

No blocking gaps. Every in-process criterion is present, substantive, and wired, with named tests. Restart durability is code-complete but behavior-unverified: the six pg restart cases have not been observed by this verifier. Status `human_needed`, not `passed`, solely for that reason.

---

_Verified: 2026-11-19T12:00:00Z_
_Verifier: Claude (gsd-verifier)_
