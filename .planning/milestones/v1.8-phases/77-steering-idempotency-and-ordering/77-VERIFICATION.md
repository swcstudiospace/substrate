---
phase: 77-steering-idempotency-and-ordering
verified: 2026-11-19T00:00:00Z
status: human_needed
score: 5/8 must-haves verified
covered_files:
  - ".env.example"
  - ".planning/phases/77-steering-idempotency-and-ordering/77-01-PLAN.md"
  - ".planning/phases/77-steering-idempotency-and-ordering/77-01-SUMMARY.md"
  - "docs/config-reference.md"
  - "docs/live-steering.md"
  - "docs/runbooks/rollback-compat.md"
  - "packages/mcp-server/src/config.ts"
  - "packages/mcp-server/src/flag-registry.ts"
  - "packages/mcp-server/src/index-store.migrate-contract.test.ts"
  - "packages/mcp-server/src/index-store.migrate-harness.test.ts"
  - "packages/mcp-server/src/index-store.migrations.digests.json"
  - "packages/mcp-server/src/index-store.ts"
  - "packages/mcp-server/src/live-session-restart.pg.test.ts"
  - "packages/mcp-server/src/mcp.ts"
  - "packages/mcp-server/src/planning/steering-durable.test.ts"
  - "packages/mcp-server/src/planning/steering-idempotency.pg.test.ts"
  - "packages/mcp-server/src/planning/steering-rest.test.ts"
  - "packages/mcp-server/src/planning/steering-rest.ts"
  - "packages/mcp-server/src/planning/steering-store.ts"
  - "packages/mcp-server/src/planning/steering-tools.test.ts"
  - "packages/mcp-server/src/planning/steering-tools.ts"
  - "packages/mcp-server/src/planning/steering-waiters.test.ts"
  - "packages/mcp-server/src/planning/steering-waiters.ts"
  - "packages/mcp-server/src/planning/steering.test.ts"
  - "packages/mcp-server/src/planning/steering.ts"
  - "packages/mcp-server/src/server.steering.test.ts"
  - "packages/mcp-server/src/server.ts"
  - "packages/mcp-server/src/service.ts"
covered_digest: "v3:sha256:a1569c50cb3cbfea477a8b6f916980c0d240f69b2bcf5f3d7724784136f02549"
behavior_unverified: 3
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/8
  previous_verified: 2026-11-18T12:25:01Z
  previous_commit: 357d6b15
  current_commit: ee998735dce82872df0302501e8b0a49c9914648
  gaps_closed: []
  gaps_remaining:
    - "T5: durable replay and sequence through Postgres: PG test skipped, no Postgres in this environment"
    - "T6: audit-plus-claim atomicity through Postgres: unexecuted"
    - "T7 (W2): cross-process single winner through Postgres: unexecuted"
    - "HARD-H1 ownership: REQUIREMENTS.md maps HARD-H1 to phase 77; PLAN 77-01 has no requirements field"
    - "D-1: a concurrent keyed loser still takes a sequence number (owner decision outstanding)"
  regressions: []
behavior_unverified_items:
  - truth: "Keyed replay records and the per-session sequence counter survive a restart through the Postgres steering store (migration 43 and bunSteeringIdempotencyStore)"
    test: "Set SUBSTRATE_TEST_PG_URL, migrate with steering-audit on, then run steering-idempotency.pg.test.ts once. Also queue a keyed command through one process, restart, repeat the key within the retention window, then queue a distinct command."
    expected: "The saved replay is returned exactly by the second instance with no audit row written. The distinct command takes the next number. Expired rows are pruned and rows beyond the cap are deleted."
    why_human: "The restart suite uses MemorySteeringIdempotencyStore as a stand-in. steering-idempotency.pg.test.ts is describe.skip without SUBSTRATE_TEST_PG_URL (steering-idempotency.pg.test.ts:13), and no Postgres is available here. Migration 43 and bunSteeringIdempotencyStore have never executed."
  - truth: "A lost or refused audit reply cannot double-apply a keyed command: the audit row and the replay claim commit or roll back together"
    test: "On Postgres, force an audit insert to fail inside a keyed claim, then retry the same key. Separately, lose the reply after commit and retry."
    expected: "A refused audit leaves no queued row and no replay record, and the retry queues once. A reply lost after commit replays on retry and is never queued twice."
    why_human: "The atomicity is one sql.begin in steering-store.ts:689 with the audit written through tx. The inbox tests use an in-memory store with no transaction to roll back. The PG test 'a claim whose unit fails keeps no replay record' (steering-idempotency.pg.test.ts:93) is skipped here."
  - truth: "Two processes that accept the same keyed command concurrently queue exactly one directive, and both get its reply"
    test: "Run steering-idempotency.pg.test.ts case 'two concurrent keyed commands through two instances queue one directive and both get its reply' against Postgres."
    expected: "One queued audit row for the session. One caller sees replayed false and the other replayed true, with the same directive id."
    why_human: "The single winner rests on insert ... on conflict (scope_key) do nothing (steering-store.ts:694), which only the database can exercise. The test (steering-idempotency.pg.test.ts:122) is skipped here."
coincidental_reliance_items: []
human_verification:
  - test: "Run steering-idempotency.pg.test.ts (4 tests) once against a migrated Postgres database with SUBSTRATE_TEST_PG_URL set."
    expected: "All 4 pass. The afterAll hook deletes only rows whose session starts with the run prefix."
    why_human: "No Postgres in this environment. Covers T5, T6 and T7."
  - test: "Apply migration 43 under the steering-audit opt-in on a restored dump, then reverse it (the migration header requires this rehearsal)."
    expected: "Forward and reverse both succeed; the migration digest in index-store.migrations.digests.json matches; the three objects are present forward and absent after reverse."
    why_human: "Needs a database. Migration 43 has never run."
  - test: "Owner decisions: (a) accept that a losing concurrent keyed caller consumes one sequence number, or move the nextSequence take inside the claim (steering.ts:532, claim at :546); (b) HARD-H1 ownership: add requirements: [HARD-H1] to 77-01-PLAN.md or re-map it; (c) confirm docs/live-steering.md delivery-order rule is the one out-of-order rule."
    expected: "A decision recorded in 77-01-PLAN.md or in REQUIREMENTS.md."
    why_human: "Owner decisions; the verifier cannot make them."
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 77: Steering idempotency and ordering: Verification

**Phase Goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Verified:** 2026-11-19T00:00:00Z
**Status:** human_needed
**Re-verification:** Yes. Prior record (2026-11-18, commit `357d6b15`) re-checked against HEAD `ee998735dce82872df0302501e8b0a49c9914648` on `gsd/autonomous-rerun`. Commit `05cdf2c6` (merge of this phase's branch) remains the lineage point.

## What changed since the prior record

- `git log 357d6b15..HEAD -- packages/mcp-server/src/planning/` is empty: no steering file changed. `steering.ts`, `steering-store.ts`, `steering-rest.ts`, `steering-tools.ts`, `steering-waiters.ts`, migration 43, `server.ts` wait route and `service.ts` steering wiring are unchanged in this phase's logic.
- `git diff 357d6b15 HEAD` touches `index-store.ts` (archive restore identity-column resync, PG_TYPE jsonb), `server.ts` (corpusIngest operator flag) and `service.ts` (corpus root async). None touches steering. No regression in this phase's paths.
- No test, typecheck, lint or build was run in this pass (per assignment); verification is static. Prior targeted run (180 pass, 6 skip, 0 fail) is carried as evidence, not re-derived.
- No gap from the prior record is closed or reopened. The Postgres-gated truths still have no database.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| 1 | SC1: a replayed keyed command returns the original result and writes nothing | ✓ VERIFIED (in-process) | Replay check under the inbox lock after validation/authorisation and before duplicate/rate/audit: `steering.ts:517` (`findReplay`) then `replayOf` (`:572`), returns held record with `replayed: true`, no audit, no token spend, no state change. Caveat: concurrent loser still runs `nextSequence` upsert (`steering.ts:532`) before claim — D-1. |
| 2 | SC2: unkeyed commands keep working unchanged | ✓ VERIFIED | `steering-tools.ts:153`: unkeyed call returns `{status, directive_id, target_session_id, queued_at_ms}` with no `sequence`; keyed branch adds `sequence` (`:155-156`). Unkeyed path audits/queues as before (`steering.ts:537-541` region). Read shape gains `sequence` additively only. |
| 3 | SC3a: a keyed reply exposes its sequence, and a replay returns the same sequence | ✓ VERIFIED | Keyed reply carries `sequence` (`steering-tools.ts:153-156`). Replay restores stored number (`steering.ts:572-580`, `replayOf` takes `held.sequence`). |
| 4 | SC3b: two distinct commands are delivered in sequence order; `restDirective` and wait expose the sequence | ✓ VERIFIED | `queuedFor` sorts by sequence (`steering.ts:456-462`). `restDirective(record, sequence)` includes `sequence` (`steering-rest.ts:82-83`, `:97-107`). Wait route returns `restDirective(waited.record, waited.sequence)` (`server.ts:2350`). |
| 5 | Durable keyed replay and sequence survive restart through Postgres (PLAN D3, D7; HARD-H1 durable replay state) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Present and wired. Migration 43: `planning_steering_sequence`, `planning_steering_replay`, nullable `delivery_sequence` (`index-store.ts:919-938`). `bunSteeringIdempotencyStore` wired via `steeringIdempotency()`. Restart tests use `MemorySteeringIdempotencyStore`; PG test skipped without `SUBSTRATE_TEST_PG_URL`. |
| 6 | W1: lost/refused audit reply cannot double-apply a keyed command | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Code: keyed path takes claim with audit inside (`steering.ts:546`, `claimKeyed` `:582-593`). Adapter runs `queue(tx)` inside `sql.begin` (`steering-store.ts:689`, `:705`). SQL atomicity unexecuted. |
| 7 | W2: two processes accepting same key concurrently queue one directive | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Scope key `JSON[author, session, key]` (`steering.ts:513`), PK on `scope_key` (`index-store.ts:921-925`). Claim is `insert ... on conflict (scope_key) do nothing` (`steering-store.ts:694`). Unexecuted. |
| 8 | Per-session delivery order documented | ✓ VERIFIED | `docs/live-steering.md`: keyed queue returns original reply with `sequence` and writes nothing; delivery order per target session, no order across sessions. Matches `steering.ts:456-462`. |

**Score:** 5/8 truths verified (3 present, behavior-unverified: T5, T6, T7).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planning/steering.ts` | Inbox replay, sequence, claim, settings | ✓ VERIFIED | Keyed path `:503-550`, `replayOf` `:572`, `claimKeyed` `:582`. Wired: `service.ts`, `steering-tools.ts`. |
| `packages/mcp-server/src/planning/steering-store.ts` | Audit sink with unit, Bun idempotency adapter | ✓ VERIFIED (unexecuted SQL) | `sql.begin` `:689`, `on conflict (scope_key)` `:694`. |
| `packages/mcp-server/src/index-store.ts` | Migration 43 | ✓ VERIFIED (unexecuted) | `:919-938`, expand with reversible `down` `:919`. |
| `packages/mcp-server/src/planning/steering-tools.ts` | Queue takes key, returns sequence | ✓ VERIFIED | `:148-156`. Wake only on fresh queue (`freshlyQueued`). |
| `packages/mcp-server/src/planning/steering-rest.ts` | REST shape carries key and sequence | ✓ VERIFIED | `sequence` `:82-83`, `restDirective` `:97-107`. |
| `packages/mcp-server/src/planning/steering-waiters.ts` | Cursor over sequence | ✓ VERIFIED | Unchanged since prior record. |
| `packages/mcp-server/src/server.ts` | Wait route returns sequence | ✓ VERIFIED | `:2350`. |
| `docs/live-steering.md` | Durable keys and ordering rule | ✓ VERIFIED | Idempotency + per-session delivery order paragraphs. |
| `packages/mcp-server/src/config.ts`, `flag-registry.ts` | TTL and cap settings | ✓ VERIFIED | TTL default 86400, cap default 10000. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `steering-tools.ts` queue | `SteeringInbox.enqueueReceipt` | `:148-150` | ✓ WIRED | `replayed` drives `freshlyQueued` |
| `steering-tools.ts` | `onQueued` wake hook | `:163` | ✓ WIRED | only on fresh queue |
| `steering.ts` keyed path | `store.claimReplay` | `:546` → `claimKeyed` `:582` | ✓ WIRED | audit runs inside `unit` |
| `steering-store.ts` claim | `sql.begin` transaction | `:689` | ✓ WIRED (unexecuted) | `queue(tx)` at `:705` |
| `steering-rest.ts` restDirective | `inbox.sequenceOf` | `:155` | ✓ WIRED | |
| `server.ts` wait route | waiter sequence | `:2350` | ✓ WIRED | |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| keyed reply | `sequence` | `inbox.sequenceOf` ← `nextSequence` or `held.sequence` | Yes (memory store in tests; Postgres sequence row in production, unexecuted) | ✓ FLOWING (in-process); ⚠️ DB path unexecuted |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| (static pass; no tests run per assignment) | — | Prior run carried: 180 pass, 6 skip, 0 fail on seven steering files | ? SKIP (this pass) |
| Postgres replay, claim atomicity, concurrent winner | `steering-idempotency.pg.test.ts` with `SUBSTRATE_TEST_PG_URL` | not run (no database) | ? SKIP (human) |

### Probe Execution

No probes declared for this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-H1 | none (PLAN 77-01 has no `requirements` field) | Keyed commands apply once; durable replay state; unkeyed unchanged | ⚠️ ORPHANED (ownership) | `REQUIREMENTS.md:124,139` maps HARD-H1 to phase 77 ("Not started"). Behaviour implemented (truths 1-4, 8); bookkeeping gap for owner. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/planning/steering.ts` | `:532` | `nextSequence` taken before keyed claim | ⚠️ Warning | Concurrent loser consumes a number: gap, never duplicate (D-1). |
| `packages/mcp-server/src/planning/steering.ts` | `:329-355` | `MemorySteeringIdempotencyStore` used by restart suite | ℹ️ Info | Durable claims proven only through port, not DB. |
| `.planning/phases/77-steering-idempotency-and-ordering/77-01-PLAN.md` | D11, R1 | plan text contradicts code | ℹ️ Info | SUMMARY and code agree; plan text stale. |

No `TBD`, `FIXME` or `XXX` markers in the phase's implementation files (carried from prior scan; no steering file changed since).

### Human Verification Required

Carried in frontmatter `human_verification` (3 items): Postgres PG suite, migration 43 forward/reverse rehearsal, owner decisions (D-1, HARD-H1 ownership, out-of-order rule). All remaining items are operator/live-only; no code gap was found at HEAD.

### Gaps Summary

No code gaps. All three ROADMAP success criteria hold in-process code at `ee998735`. The three behavior-unverified truths and three human_verification items are Postgres/live/owner-only, so status is `human_needed` per the ordered decision tree.

---

_Verified: 2026-11-19T00:00:00Z_
_Verifier: Claude (gsd-verifier)_
