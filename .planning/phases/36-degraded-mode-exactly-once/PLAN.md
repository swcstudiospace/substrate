# Phase 36 PLAN: degraded-mode-exactly-once

Written before any code edit. Scope is uplift-7 gap 3 (MILESTONE-AUDIT rows 23-25 item 3).

## Step 1 — investigation (read only, done)
1. Locate every 503 on the memory and skill write paths (CONTEXT.md, "503 sources").
2. Identify in-repo clients that call memory or skill writes and would see that 503 (CONTEXT.md, "Clients").
3. Record file:line for each.

## Step 2 — server-side exactly-once
2a. Memory writes: the explicit `idempotency_key` field already exists on `MemoryWriteRequest`
    (types.ts:324) and is claimed atomically in the index DB (`memory_writes`, memory-write.ts
    claim/insert fencing, index-store.ts:1377). No production code change is needed for memory.
    Work: add regression tests that pin the required behaviour on top of existing coverage:
    - T1 (memory-write.test.ts, new describe): same explicit key twice -> one row; second reply
      has `deduplicated: true` and the same entry id, text, scope, kind and idempotency key.
    - T2 (memory-write.test.ts): a keyless write of NEW text writes each time; a keyless identical
      retry still dedupes on content as today (behaviour unchanged, asserted, not altered).
    - T3 (memory-write.test.ts): outage after the row commits (`failAfterInsert`), then recovery
      with the same key after the in-flight timeout -> exactly one row, the original entry id.
    - T4 (server.test.ts, memoryWriteStatus describe): an index outage through
      `Substrate.writeMemory` (throwing claim; and `index: null`) maps to HTTP 503 via
      `memoryWriteStatus`, not 403.
2b. Skill writes: NO new key store. Reasons (recorded as GREY_AREA in SUMMARY):
    - `/skills/approve` is already exactly-once on its natural key (repo, name, pr_number) inside
      one Postgres transaction under a row lock (index-store.ts:1856-1923); a repeat answers
      `exists` with no second row and no event (skills-approve.test.ts:357).
    - `/skills/propose` is idempotent by content hash through the local proposal ledger and
      `gh pr view` / `gh pr list --head` (skills/propose.ts:811-892). It cannot keep a key in the
      index DB atomically because it writes git, gh and a JSONL ledger, not Postgres.
    - A literal key store for approve would add a migration, a response snapshot and a second
      mechanism with no in-repo caller. Deferred, flagged as a decision.

## Step 3 — client queue
3. The only in-repo memory-write client is the lessons CLI (`packages/cli/src/lessons.ts`).
   It has no queue and no degraded state. A queue needs choices the spec does not make: where
   it persists, what triggers drain on recovery (the CLI is one-shot), queue bounds, and how
   an outage is surfaced. STOP here. Report as a GREY_AREA decision request with a default.
   The skill propose queue already exists (`packages/projector/omp/substrate-skills.ts:205-240`,
   drained by the bridge), so it is not built again.

## Output
- One commit with tests plus `.planning/phases/36-degraded-mode-exactly-once/` artifacts.
- Push `feat/v14-degraded-mode-exactly-once`. No PR. No test, tsc or lint run by me.
