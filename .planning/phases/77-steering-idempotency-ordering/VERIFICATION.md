---
phase: 77-steering-idempotency-ordering
verified: 2026-11-12T08:41:46Z
status: human_needed
score: 5/6 must-haves verified in process (restart durability not observed here)
overrides_applied: 0
behavior_unverified: 1
covered_files: [".planning/phases/77-steering-idempotency-ordering/PLAN.md", ".planning/phases/77-steering-idempotency-ordering/SUMMARY.md", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/planning/steering-idempotency.pg.test.ts", "packages/mcp-server/src/planning/steering-idempotency.test.ts", "packages/mcp-server/src/planning/steering-idempotency.ts", "packages/mcp-server/src/planning/steering-rest.test.ts", "packages/mcp-server/src/planning/steering-rest.ts", "packages/mcp-server/src/planning/steering-store.ts", "packages/mcp-server/src/planning/steering-tools.test.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/planning/steering.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:04f4e69d43812f4a8859c17e0d591e9badde638fcd477d49790c716665924eaa"
behavior_unverified_items:
  - truth: "Replay after a restart returns the original result and writes nothing; delivery sequence survives a restart"
    test: "Run packages/mcp-server/src/planning/steering-idempotency.pg.test.ts against a disposable Postgres (SUBSTRATE_TEST_PG_URL set)"
    expected: "Six restart cases pass, including keyed queue and keyed acknowledgement replayed after restart with the same reply and no second row"
    why_human: "Code present and wired, but the Postgres suite was not run here (127.0.0.1:5432 refuses TCP)"
human_verification:
  - test: "Rehearse migrations 44 (planning_steering_audit_delivery) and 45 (planning_steering_movements) on a restored production dump, following docs/runbooks/rollback-compat.md. Then run packages/mcp-server/src/planning/steering-idempotency.pg.test.ts against a disposable Postgres."
    expected: "Migrations apply and roll back as documented. Six of six restart cases pass."
    why_human: "Operator-gated: production migrations and restored-dump rehearsal are not run by an agent. Postgres suite not run by this verifier."
  - test: "Owner reading of criterion 1 'writes nothing': a replayed keyed command still writes one access-audit row (auditPreparedBatch runs before the effect, service.ts ~L2040). Confirm this means no steering or session transition, not no access-audit row."
    expected: "Owner accepts the reading, or opens a separate decision to skip the access-audit write on replay (not a fix in this phase)."
    why_human: "ROADMAP wording against the house audit-before-effect rule is a policy call."
  - test: "Before SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE is enabled in production, confirm migrations 44 and 45 ran and the durable replay path is live (service.ts L1859-1862 selects the durable sink only when the flag is on)."
    expected: "Operator approval recorded; no flag change performed by an agent."
    why_human: "Production flag and migration change; operator gate."
---

# Phase 77: Steering idempotency and ordering — Verification Report

**Phase Goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Verified:** 2026-11-12T08:41:46Z
**Status:** human_needed
**Re-verification:** No — initial verification of this phase document set (the earlier VERIFICATION.md was used as leads only; every claim below was checked against code or a named test in this run).

## Scope of this verification

- ROADMAP `### Phase 77` success criteria 1–3 and REQUIREMENTS HARD-H1 (L124).
- Named in-process test files run here: `steering-idempotency.test.ts`, `steering-tools.test.ts`, `steering-rest.test.ts` → **60 pass, 0 fail, 273 expect() calls** (`bun test`, packages/mcp-server, ~0.6 s).
- **Not run:** `steering-idempotency.pg.test.ts` (live Postgres). 127.0.0.1:5432 refuses TCP in this environment; no credentials were guessed. Restart-durability claims are **not re-observed**; they rest on the SUMMARY's prior report.
- Not run: `bunx tsc --noEmit`, lint, full `bun test`, the migration rehearsal.
- No `*-SECURITY.md` exists for this phase, so the security gate does not apply.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A replayed keyed command returns the original result and writes no steering or session transition (in process) | ✓ VERIFIED | `steering-tools.ts` L157 `wiring.idempotency.serialize(...)` → `keyedQueue` (L171): a held directive under the derived id is fingerprint-matched and answered from the inbox (L176–179) with no enqueue. `applyAcknowledgement` (L210–226): a recalled or durable reply is returned before `run()`. Tests: "a replayed keyed queue returns the original reply and writes nothing"; "a replayed keyed acknowledgement returns the stored reply and writes no second row"; "a replayed keyed acknowledgement that moved the session does not move it again" (port called once). **See W1.** |
| 2 | Unkeyed commands keep working unchanged (owner decision 2026-10-30) | ✓ VERIFIED | Unkeyed queue path is `enqueueDirective(..., wiring.newDirectiveId?.() ?? randomUUID())`; unkeyed acknowledgement is `recordSession(wiring, await run())` (steering-tools.ts L213). Test "an unkeyed queue keeps its reply shape and a fresh id, and is never deduplicated" passes. **Info I1:** `recordSession` writes a movement row only when the durable opt-in is on; reply shape is unchanged. |
| 3 | A keyed reply exposes its sequence; a replay returns the same sequence (in process) | ✓ VERIFIED | `keyedQueue` L178 and L186 return `sequence`; `applyAcknowledgement` L224 stores `sequence` on the kept reply and L225 remembers it. Test "a replay keeps its sequence after later commands are queued". |
| 4 | Two distinct keyed commands are delivered in sequence order; a replay does not reorder them (in process) | ✓ VERIFIED | `nextQueuedDirective` (`steering-waiters.ts`) yields first, then second, then null. Test "two distinct keyed commands are delivered in sequence order, and a replay does not reorder them". |
| 5 | `restDirective`, the REST listing and the `/steering/wait` reply expose the sequence (`null` when the inbox does not hold it) | ✓ VERIFIED | `steering-rest.ts` L97 `restDirective(record, sequence)`; L155 `listRestDirectives` passes `inbox.sequenceOf`; `server.ts` L2286 wait reply passes `sequenceOf(...) ?? null`. Test "a directive carries its delivery sequence, and one the inbox does not hold has none" passes. |
| 6 | Replay after a restart returns the original result and writes nothing; delivery sequence survives a restart | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Code present and wired: `steering-store.ts` `savedKeyedQueue` (L530) / `savedKeyedAcknowledgement` (L545) read the migration 44/45 columns; `readSequenceFloor` (L335) seeds the counter via `seedSequence` (L586–588, L621–623); `service.ts` L1877 `resolveDurableDirective`. The durable sink is selected only when `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` is on (`service.ts` L1859–1862). The restart suite is not run here. Behavior-dependent (replay after restart), so not VERIFIED on presence alone. Routed to human item 1. |

**Score:** 5/6 truths verified in process. Truth 6 is not counted.

### Roadmap success criteria

| Criterion | Status | Evidence |
|-----------|--------|----------|
| 1. Replayed keyed command returns original result and writes nothing | ✓ VERIFIED in process; restart case ⚠️ human | Truths 1 and 6. |
| 2. Unkeyed commands keep working unchanged | ✓ VERIFIED | Truth 2. |
| 3. Keyed reply exposes sequence; replay returns same sequence; distinct commands delivered in sequence order; `restDirective` exposes sequence | ✓ VERIFIED in process | Truths 3, 4, 5. |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/planning/steering-idempotency.ts` | Key-derived id, fingerprints, per-key lanes, bounded reply index | ✓ VERIFIED | `keyedDirectiveId` = `idem-` + sha256 (68 chars, matches the directive id grammar per the test). `SteeringIdempotency.serialize/recall/remember` implemented; bound `STEERING_IDEMPOTENCY_MAX_ENTRIES` = 10,000. |
| `packages/mcp-server/src/planning/steering-tools.ts` | `idempotency_key` on both inputs; keyed branches | ✓ VERIFIED | L22 `STEERING_IDEMPOTENCY_KEY_INPUT` = `IDEMPOTENCY_KEY_PATTERN`; L26 and L28 strict schemas carry it. |
| `packages/mcp-server/src/planning/steering.ts` | `idempotency-conflict` refusal; sequence assignment; `seedSequence` | ✓ VERIFIED | Refusal union L227. |
| `packages/mcp-server/src/planning/steering-rest.ts` | Body parsers accept key; 409 mapping; sequence on REST shape | ✓ VERIFIED | `restDirective` L97; `idempotency-conflict` → 409 at L291. |
| `packages/mcp-server/src/planning/steering-store.ts` | Durable key/sequence reads; sequence floor | ✓ VERIFIED (code); restart behaviour human | L124/L195/L309 interface and delegates, L335 `readSequenceFloor`, L530 `savedKeyedQueue`. |
| `packages/mcp-server/src/index-store.ts` | Migrations 44 and 45 | ✓ VERIFIED (code); applied only under opt-in | `version: 44` L945, `version: 45` L978; `optIn: "steering-audit"`. Production run is operator-gated. |
| `packages/mcp-server/src/server.ts` | Wait reply carries sequence | ✓ VERIFIED | L2286. |
| `packages/mcp-server/src/service.ts` | One `SteeringIdempotency` per process; durable resolver | ✓ VERIFIED | L1887 `new SteeringIdempotency<SteeringAcknowledgeReply>()`; L1877 `resolveDurableDirective`. |
| `packages/mcp-server/src/mcp.ts` | Tool descriptions name key, replay, sequence | ✓ VERIFIED | L2404–2406 (queue), L2429 (acknowledge). Not in the fingerprinted set. |
| `docs/live-steering.md` | Field rows, idempotency section, limits | ✓ VERIFIED with stale line (W2) | L70–71 field rows; L79 idempotency section. L33 still says "Queue/ack remain **unkeyed**" (stale). |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `queueSteering` (keyed) | `SteeringIdempotency.serialize` | `wiring.idempotency.serialize(surface, key, …)` | ✓ WIRED | steering-tools.ts L157 |
| `keyedQueue` | durable queued row | `wiring.durable?.savedKeyedQueue` | ✓ WIRED | steering-tools.ts L180 |
| `applyAcknowledgement` | session port | `run()` only when no stored reply | ✓ WIRED | Replays return before `run()` (L218–221); test asserts port called once |
| `applyAcknowledgement` (kept reply) | index | `wiring.idempotency.remember` | ✓ WIRED | steering-tools.ts L224–225 |
| `restore` | sequence counter | `seedSequence(readSequenceFloor)` | ✓ WIRED | steering-store.ts L586–588, L621–623 |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Phase 77 in-process suites (keyed replay, conflict, sequence, REST shape) | `bun test src/planning/steering-idempotency.test.ts src/planning/steering-tools.test.ts src/planning/steering-rest.test.ts` (packages/mcp-server) | 60 pass, 0 fail, 273 expects | ✓ PASS |
| Restart durability (six pg cases) | `SUBSTRATE_TEST_PG_URL=… bun test src/planning/steering-idempotency.pg.test.ts` | Not run: 127.0.0.1:5432 refused | ? SKIP → human item 1 |

### Probe Execution

No probes declared for this phase. Skipped.

### Requirements Coverage

HARD-H1 (REQUIREMENTS.md L124) is the requirement this phase delivers. Its durable-replay clause is only partly met in process: restart durability depends on the operator-gated opt-in migrations 44/45 and is covered by human item 1. The unkeyed-commands clause is met (truth 2).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `docs/live-steering.md` | 33 | Stale "Queue/ack remain **unkeyed**" | ⚠️ Warning | Contradicts L70–85 of the same doc. Doc-only follow-up. |
| `packages/mcp-server/src/planning/steering-idempotency.ts` | header comment | Says a replay after eviction "reads the durable log" | ℹ️ Info | True only when the durable sink is on. Without it, an evicted key is refused `already-acknowledged`. |
| `packages/mcp-server/src/planning/steering-tools.ts` | `applyAcknowledgement` | Eviction branch has no direct test | ℹ️ Info | Not re-verified in this run. |

No `TODO`, `FIXME` or placeholder markers in the keyed paths.

## Warnings

- **W1 — "writes nothing" vs the access audit.** A replayed keyed call still runs `executeLiveCall` → `auditPreparedBatch` before the effect (service.ts ~L2040). Steering and session state are not written. Met only under the "no transition" reading; owner decision (human item 2).
- **W2 — stale doc line.** `docs/live-steering.md` L33 contradicts the new optional key. Doc-only.
- **W3 — durable-only restart guarantees.** L77-01 to L77-03 closure depends on the opt-in durable sink. With `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` off (default), a restart loses the in-memory index; keyed replay across restart is refused, not repeated. These are the accepted limits in CONTEXT.md, not new gaps.
- **W4 — L77-04 eviction.** In-memory mode, past 10,000 keyed acknowledgements, an evicted key is refused `already-acknowledged`. Eviction branch not directly tested.
- **W5 — CLI not updated.** `packages/cli/src/steer/client.ts` does not send `idempotency_key`. Declared non-goal in SUMMARY; additive.

## Human Verification Required

### 1. Rehearse migrations 44 and 45, then run the Postgres restart suite

**Test:** On a restored production dump, apply and roll back migrations 44 and 45 per `docs/runbooks/rollback-compat.md`. Then run `packages/mcp-server/src/planning/steering-idempotency.pg.test.ts` with `SUBSTRATE_TEST_PG_URL` set to a disposable Postgres.
**Expected:** Both migrations apply and roll back as documented. Six of six restart cases pass.
**Why human:** Operator-gated rehearsal on production-shaped data; Postgres unreachable from this verifier.

### 2. Owner reading of "writes nothing"

**Test:** Confirm that a replayed keyed command writing one access-audit row is acceptable under criterion 1.
**Expected:** Owner accepts the reading, or opens a separate decision to skip the access-audit write on replay.
**Why human:** ROADMAP wording against the house audit-before-effect rule.

### 3. Production flag enablement

**Test:** Before `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` is enabled in production, confirm migrations 44 and 45 are applied and the durable path is live.
**Expected:** Operator approval recorded. No flag change or migration performed by this verifier.
**Why human:** Production change; operator gate.

## Gaps Summary

No blocking gaps. Every in-process criterion is observed in code and by named passing tests (60/60). Restart durability (truth 6) depends on migrations 44 and 45, which are operator-gated and whose Postgres suite was not run here. That makes the status `human_needed`, not `passed`.

## Checks the main agent should run

- `bunx tsc --noEmit` from the repo root, once.
- `bun test packages/mcp-server/src/planning/steering-idempotency.pg.test.ts` with `SUBSTRATE_TEST_PG_URL` set, when a disposable Postgres is reachable.
- Fix the stale `docs/live-steering.md` L33 line (W2).

---

_Verified: 2026-11-12T08:41:46Z_
_Verifier: Claude (gsd-verifier)_
