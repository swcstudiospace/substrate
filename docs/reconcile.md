# Cross-layer reconcile

The reconcile checks that the ledger, the index and the cache agree. It reports drift with evidence. It repairs only through a confirmed plan.

## Success criteria

1. A scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run.
2. Repair is a separate confirmed step with a plan record, following the corpus delete rules.

## The three comparisons

Each comparison is read-only. The ledger is GreptimeDB (`agent_events`), the index is Postgres (`index-store.ts`) and the cache is Dragonfly (`substrate:v1`). The index is authoritative for current state. The cache is derived.

**Leases (ledger against index).** Identity only. The ledger's latest lease transition for each `graph_id/node_id` gives the ledger's view. The index's view is `claimed_by`, `claim_session` and `lease_epoch`. Drift is one of these:

- the ledger shows a hold and the index shows it free;
- the index shows a hold and the ledger shows it free;
- both show a hold and the surface, session or epoch differ.

Heartbeats and expiry are not compared. Renewals are silent in the ledger, and an expired hold that has not been reaped yet is not drift. Both sides free is not drift, and the epoch is not compared while free.

**Memory writes (ledger against index), both directions.** The window is `SUBSTRATE_RECONCILE_WINDOW_HOURS`. The index side is `memory_entries` rows created in the window. The ledger side is audit events in the window that carry an accepted `entry_id`. Drift is an index row with no event, or an event with no row. Rows older than the window are counted as unchecked, not as drift. The key is the entry id.

**Cache generations (cache against index).** The cache is enumerated with a capped, read-only `SCAN`. Keys are counted per class. Drift is a `gen:graph:<id>` key whose graph is absent from `graph_index`. That key is the finding. A capped scan reports `truncated` and is never clean.

The report lists per-layer counts: ledger lease transitions and memory writes in the window; index holds, memory rows in the window and graphs; cache keys per class. `first` names the first mismatching key of each comparison, in sorted order.

## Report and exit codes

```
bun run reconcile -- report
```

`report` (also the default with no subcommand) prints the report as JSON. It writes nothing. Exit 0 when the report is clean. Exit 1 when it is not, including when a scan was truncated.

## Repair

Repair is a whole derived-cache flush of the `substrate:v1` prefix, behind a confirmed plan. It is never a per-key or per-graph delete. Answer keys are hashes with no graph id, so they cannot be selected per graph. A counter alone is unsafe to delete, because an answer built while the counter was absent can become reachable again and revive a stale answer. Counters, answers, snapshots and the forget mark all go together.

The repair never touches the ledger or the index. It is safe because the cache is derived. The cost is a cold cache until it refills.

Safety rules:

- **Plan first.** `plan --out <file>` runs the report and writes one plan file, and nothing else. It refuses to overwrite an existing file, so a plan in use is never replaced.
- **Dry run first.** `repair --plan <file>` re-runs the report, checks the plan's digest, and prints what it would do. It writes nothing.
- **Confirmed execute.** `repair --plan <file> --execute` re-checks the digest and the orphan condition, then flushes. It writes `<file>.result.json` with the result and a timestamp. It refuses when the findings have changed since the plan was made.
- **Re-run is safe.** A second execute finds nothing to repair.

```
bun run reconcile -- plan --out plan.json
bun run reconcile -- repair --plan plan.json
bun run reconcile -- repair --plan plan.json --execute
```

**Partial flush.** The flush scan is capped. A truncated flush removes only part of the prefix, and that includes generation counters. Removing counters changes the live findings. So the same plan file then refuses on digest mismatch. The operator must run `plan` again to make a new plan. The second run does not reuse the old plan.

Exit codes for `repair`: 0 for a dry run or an executed flush; 1 for a refused or unreadable plan, or a flush that failed part way (the reason is printed, and `<plan>.result.json` records the keys removed before the failure); 2 for usage errors. `report` and `plan` exit 0 when they write their output (`report` exits 1 when not clean). Every command exits 2 when `SUBSTRATE_PG_URL` or `GREPTIME_URL` is unset, or when the cache is off: a scan of an off cache is incomplete, so a report without it must not read as clean.

## Scheduled report

The server can run the report on an interval. Each run writes one JSON log line and writes nothing to the ledger, the index or the cache.

| Setting | Default | Meaning |
| --- | --- | --- |
| `SUBSTRATE_RECONCILE_INTERVAL_S` | `0` (off) | Seconds between runs. A value above 0 is at least 60. |
| `SUBSTRATE_RECONCILE_WINDOW_HOURS` | `24` | Hours of ledger and index history each run compares, from 1 to 168. |

With the interval at 0 the timer is not started.

## Hazards

- **H1** The memory audit emit swallows failures, so an index row can exist with no ledger event. The reconcile reports it and does not repair it.
- **H2** The release emit swallows failures, so the ledger can show a hold the index has released. Reported, not repaired.
- **H3** Silent renewals and expiry are invisible to the ledger, so the lease comparison makes no claim about them.
- **H4** The flush is safe only because the cache is derived. It also removes snapshots and the forget mark, which is correct only because those are cache too.
- **H5** `SCAN` costs O(keys). The scan is capped, the schedule is off by default, and truncation is reported.
- **H6** Verifier findings R-1 and R-2 from phase 76 (recorded as not fixed) can produce ledger events that the memory and lease comparisons report. That is intended.

## Out of scope

Answer-level cache verification. Any repair of the ledger or the index. Live Dragonfly and GreptimeDB runs, which are operator steps.
