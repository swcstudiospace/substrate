# Phase 78: Cross-layer reconciliation - Summary

## What was built

- **`cross-layer-reconcile.ts` (new).** A read-only scheduled reconcile and a separate confirmed repair.
  - `runScheduledReconcile(deps, options)` reads the ledger's `memory.forget` notes in a settled window, the index rows
    those notes name, and the cache forget mark. It returns per-layer counts (ledger notes and named entries; index
    forgotten, superseded, absent, in force; cache state and whether it was checked), the mismatch count, the first
    mismatching key, and the items (capped at 20). It writes nothing.
  - `planRepair(deps, options)` writes one `reconcile.plan` ledger note when there is a repair on a complete read. The
    note's event id is the plan id.
  - `applyRepair(deps, { planId, confirm })` refuses unless `confirm === planId` and the stored plan's digest matches. It
    marks only the planned entries still in force (`markMemoryForgotten`, guarded by `superseded_by is null`), sets the
    cache mark if planned, and records a `reconcile.applied` note.
  - `ledgerFromSubstrate` adapts the Greptime read path and the `Substrate.emit` write path to the ports.
- **`greptime.ts`.** `readEvent(id)`: one event with its payload, by id.
- **`index-store.ts`.** `memoryMarkers(ids)`: `superseded_by` per id, bounded.
- **`cache.ts`.** `readForgetMark()` returning `ForgetMarkRead` (`disabled`, `absent`, `present`). A failed read throws
  (after breaker accounting) and is never reported as absent. `ForgetMarkRead` is exported.
- **`docs/greptime-ledger.md`.** A "Cross-layer reconcile (phase 78)" section.

## Criteria

1. **Met for the forget pair.** Per-layer counts and the first mismatching key are reported. A clean run writes nothing.
2. **Met.** Repair is a separate step: planned into a ledger record, applied only with the plan id as confirmation, limited
   to the planned keys, and it never overwrites or deletes a row.

## Deviations from the brief and why

- **The compared pair is narrower than "ledger, index, cache".** The index stores no ledger event id, and
  `memory_entries.source_event` can be a session id, so there is no precise join across the whole index. The only precise
  shared fact is the `memory.forget` note, so the reconcile judges ledger -> index and ledger -> cache for forgets. Limit:
  an index forget with no ledger note is not judged (D78-02).
- **The cache is judged by invariant, not by count.** Cache generations are counters with no per-write record, so
  comparing them with a count would be a false agreement. The forget mark is the one cache value with a time to compare.
- **The plan record is a ledger note, not a new table.** This avoids an index migration and a digest-file change, and it
  reuses the chained, redacted write path. The 16 KB payload cap bounds the plan at 50 items.
- **Repair does not delete Hindsight documents.** It marks the index row. Recall already drops hits whose entries are
  forgotten (`forgottenEntryIds`). The plane document stays until plane cleanup (D78-14).

## Limits and open items

- The scheduled function is exported but not wired into service startup or a timer, per the brief (no units).
- Index -> ledger drift is not judged (D78-02).
- The three new store read methods (`readEvent`, `memoryMarkers`, `readForgetMark`) are thin wrappers covered only by the
  fakes. They have no test against a real Greptime, Postgres or Redis here.
- Operator gate: a live run against the real ledger, index and cache has not been exercised.
