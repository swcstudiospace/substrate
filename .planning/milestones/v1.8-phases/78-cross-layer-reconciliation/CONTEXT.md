# Phase 78: Cross-layer reconciliation - Context

Goal (ROADMAP): the ledger, the index and the cache agree, and any drift is reported with evidence. No drift is repaired
destructively without a confirmed plan. Depends on 73 (ledger tamper evidence), 75 (cache breaker), 76 (telemetry buffer).

## Discovery

- **Ledger.** `agent_events` in GreptimeDB, hash-chained (`prev`, `hash`). Reads: `GreptimeClient.queryEvents` (kind filter,
  ts bounds, 500-row cap, no offset). Writes: `Substrate.emit`, the only redacting, chained path.
- **Index.** TimescaleDB `index-store.ts`. `memory_entries` holds `source_event`, `created`, `superseded_by`. It stores no
  ledger event id. `source_event` may be a caller's session id, so it is not a join key.
- **Cache.** Dragonfly `cache.ts`. Answers are keyed by generation counters (`gen:memory`, `gen:recall`, `gen:graphs`,
  `gen:docs`) and the forget mark (`gen:forgotten`, a time, set with a TTL by `markForget`). A counter carries no per-write
  record, so it cannot be compared with a count.
- **Existing drift scan.** `substrate_coord_drift_scan` (`drift.ts`) compares git HEAD, the ledger and leases. It is not
  duplicated here, and it never compares Greptime with Timescale or Dragonfly.
- **Forget path.** `Substrate.memoryForget` (`memory-forget.ts`): index mark, then ONE `memory.forget` note (payload:
  `forget_id`, `entry_ids` (first 50), `entry_count`, `counts.marked`), then recall and memory generation bumps and
  `markForget`. This is the only path where the three layers record a shared fact with a precise key.
- **Scheduling convention.** Injected-deps class with an unref'd interval and single-flight passes (`docs-lag-timer.ts`);
  entries such as `ledger-run.ts`. This phase exports a function and adds no unit.
- **Delete rules.** `corpus/plan.ts` and `corpus/reconcile.ts`: a plan is pure; tombstones only inside a complete coverage
  scope and a tier ceiling; digests are never tombstoned; a removal is a state change, never a row delete; the plan is
  re-checked before each action; the ingest lock is held for the whole run.

## Decisions

- **D78-01 The compared pair is the forget.** A `memory.forget` note is the only shared fact with a precise key across the
  three layers. Ledger -> index: each named entry must not still be in force. Ledger -> cache: the forget mark must be at or
  after the latest forget that marked rows, while the mark is meant to live.
- **D78-02 Not judged: index -> ledger.** An index forget with no ledger note is not seen. The index has no window to read
  it by, and adding a ledger id to the index is a schema change outside this phase. Named as a limit.
- **D78-03 Consistent states.** An entry the index no longer has (`absent`), one superseded by something else, or one
  forgotten by another forget is consistent with the forget. Only an entry still in force is a mismatch. A note with
  `counts.marked = 0` does not require a cache mark, because `memoryForget` sets the mark only when it marked a row.
- **D78-04 Settle margin.** A note is judged only when older than `settleMs`. A write the telemetry buffer (phase 76)
  parked is not drift until it has had its retries.
- **D78-05 Read-only default.** `runScheduledReconcile` writes nothing on any run. Repair is planned and applied by
  separate functions.
- **D78-06 The plan record is a ledger note.** `planRepair` emits one `reconcile.plan` note through `Substrate.emit`, so it
  is redacted and hash-chained. Its event id is the plan id. There is no new table, so no index migration and no digest
  file change. The payload stays under the 16 KB cap (`RECONCILE_PLAN_MAX_ITEMS` = 50).
- **D78-07 Apply refuses without confirmation.** `applyRepair` refuses unless `confirm === planId` and the stored plan is
  a `reconcile.plan` whose items match its `itemsSha256`. A plan id that is not a stored plan is refused.
- **D78-08 Planned keys only.** Apply re-reads each planned entry and marks only those still in force (`superseded_by`
  null). `markMemoryForgotten` is itself guarded (`superseded_by is null`), so an entry another writer holds is never
  overwritten. Rows are never deleted: a forget keeps the row for audit.
- **D78-09 Scope gate (corpus rule).** Repairs are planned only on a complete read: no truncated ledger page, no key set past
  `RECONCILE_MAX_KEYS` (200), no malformed or partial forget note. An incomplete read is reported with its mismatches and
  plans nothing.
- **D78-10 Idempotent apply.** A repeat apply finds the entries already marked and marks nothing new. The cache mark is
  refreshed, which is safe: it only makes saved briefs refuse.
- **D78-11 Failures are values.** Each layer's failure returns `{ ok: false, reason, detail }`, with the detail redacted.
  Bugs are not caught. Options are validated (`RangeError`).
- **D78-12 No flags, no units.** The window, settle margin and mark TTL are options supplied by the caller. The
  scheduled run is exported as a function. No `.env.example` or flag-registry row is needed, and no systemd unit is added.
- **D78-13 Stores are structural ports.** `IndexStore` and `ReadThroughCache` satisfy the ports directly. The ledger needs
  an adapter (`ledgerFromSubstrate`) because reads go to `GreptimeClient` and writes to `Substrate.emit`.
- **D78-14 Hindsight documents.** Repair marks the index row, which is what recall reads (`forgottenEntryIds` drops a
  Hindsight hit whose entry is forgotten). It does not call the plane delete. The plane document stays until the
  operator's plane cleanup removes it. Named as a limit.
