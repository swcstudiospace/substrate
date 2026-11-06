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

The report lists per-layer counts: ledger lease transitions and memory writes in the window; index holds, memory rows in the window and graphs; cache keys per class. `first` names the first mismatching key of each comparison, in sorted order. When the cache is off, no `cache.*` count is reported. `unchecked_layers` names `cache`, the way `unchecked_memory_rows` counts the memory rows the window does not check, and every cache class stays `truncated`, so the run is never clean. The scheduled log line carries `counts`, `truncated`, `unchecked_layers`, `first` and `clean`, so an operator sees the unchecked layer in the log.

## Report and exit codes

```
bun run reconcile -- report
```

`report` (also the default with no subcommand) prints the report as JSON. It writes nothing. Exit 0 when the report is clean. Exit 1 when it is not, including when a scan was truncated.

## Repair

Repair is a derived-cache flush of the `substrate:v1` prefix, behind a confirmed plan. It is never a per-key or per-graph delete. Answer keys are hashes with no graph id, so they cannot be selected per graph. A counter alone is unsafe to delete, because an answer built while the counter was absent can become reachable again and revive a stale answer. So the flush removes keys in three ordered passes, and never removes a counter or the forget mark while a key that depends on it may still exist:

1. **Answers and snapshots** (`brief`, `memory-search`, `graph-view`, `brief-snapshot`, `recall-snapshot`, `docs-search`). Each is derived from a counter or the forget mark, so they go first.
2. **Generation counters** (`gen:*`, except the forget mark). They go only after every answer and snapshot has gone.
3. **The forget mark** (`gen:forgotten`). It goes last. `snapshotSurvivesForget` reads it to decide whether a saved brief written before a forget may still be served. Removing it while a saved brief remains would let that brief serve forgotten memory.

Budget keys (`budget:`, live rate-limit state) and embedding keys (`emb:`, content-keyed and never stale) are never removed. Neither is any key the classifier does not name.

The flush removes at most 500 keys per run. That is `RECONCILE_MAX_ITEMS` in `packages/corpus/src/protocol.ts`, the same bound the corpus reconcile lists use. The counts are keys throughout: `planned` is the keys the plan's flush names in the run's scan, `removed` the keys this run removed, and `remaining` their difference. A plan's items count actions, not keys, and the report never compares the two. When the plan names more than 500 keys the run stops at the bound and reports `truncated: true` with `remaining` set. The order holds across runs, because each run takes a prefix of the same ordered list: every answer goes before any counter, and every counter before the mark. A scan that cannot complete, because the cache is off or the prefix holds more than 1000000 keys (a fail-closed bound), refuses with nothing removed. A flush that fails part way keeps every counter it has not reached: a failure in the first pass leaves every counter and the mark in place, and a failure in the second leaves the mark in place. The repair never touches the ledger or the index. The cost of a flush is a cold cache until it refills.

The whole-prefix flush and the three ordered passes above are ratified as the design of record (D78-5), owner, 2026-11-03.

Safety rules:

- **Plan first.** `plan --out <file>` runs the report and writes one plan file, and nothing else. It refuses to overwrite an existing file, so a plan in use is never replaced.
- **Dry run first.** `repair --plan <file>` re-runs the report, checks the plan's digest, and reads the cache keys with a read-only scan. It prints the planned keys, how many one run would remove, and what would be left. It writes nothing, and needs no server flag.
- **Server stopped.** `repair --plan <file> --execute` without `--server-stopped` is a usage error (exit 2), and nothing is read or removed. A live server can write a snapshot between the passes. If the forget mark were removed before that snapshot is written, the snapshot would survive the forget and could serve forgotten memory. So the server must be stopped for the whole flush.
- **Confirmed execute.** `repair --plan <file> --execute --server-stopped` re-checks the digest and the orphan condition, then removes up to 500 keys. It writes `<file>.result.json` with the result and a timestamp, whatever the outcome. It refuses when the findings or the cache counters have changed since the plan was made.
- **Audited.** Each execute appends one record to the MCP audit chain (see [Audit record](#audit-record)). An execute refuses, and flushes nothing, when that chain is not durable: `SUBSTRATE_AUDIT_PATH` is unset, or the file cannot be opened.
- **Re-run continues.** A run that reports `truncated: true` removed its bound and left `remaining` keys. Run `repair --execute --server-stopped` again. A run that stops among the answers leaves every counter in place, so the same plan still matches and removes the next bound. A run that reaches the counters removes some of them, so the digest no longer matches: re-run `plan`, then repair from the new plan. A repair that finds nothing left to remove is refused.

Operator procedure:

1. Stop the server.
2. `bun run reconcile -- plan --out plan.json`
3. `bun run reconcile -- repair --plan plan.json` (dry run; writes nothing)
4. `bun run reconcile -- repair --plan plan.json --execute --server-stopped`
5. Restart the server.
6. `bun run reconcile -- report`

Exit codes for `repair`: 0 for a dry run or an executed flush, including a run that stopped at the bound (its JSON says `truncated: true`); 1 for a refused or unreadable plan, a refused scan, a flush that failed part way (the reason is printed, and `<plan>.result.json` records the keys removed before the failure), or an audit record that could not be written after the flush; 2 for usage errors, including `repair --execute` without `--server-stopped`, and for an execute whose audit chain is not durable, which flushes nothing. `report` and `plan` exit 0 when they write their output (`report` exits 1 when not clean). Every command exits 2 when `SUBSTRATE_PG_URL` or `GREPTIME_URL` is unset, or when the cache is off: a scan of an off cache is incomplete, so a report without it must not read as clean.

**What else compares these stores.** Memory across the index, the Hindsight bank and the ledger is compared by `consistency-run` (`consistency-verify.ts`), which this report does not replace. `coord_drift_scan` checks lease health (expired, idle, orphaned) and does not compare index holds with ledger transitions, which this report does.

## Audit record

Each `repair --execute` appends one record to the MCP audit chain, the file at `SUBSTRATE_AUDIT_PATH` that `substrate-mcp` writes. It is recorded under tool `reconcile_repair`, surface `operator` and transport `internal`:

- `decision` is `allowed` when the flush was let run, and `denied` when the plan was refused.
- `reason` carries the outcome (`executed`, `truncated`, `failed` or `refused`), the counts (`planned`, `removed`, `remaining`, `limit`), `plan_digest` (the sha256 of the plan file's bytes) and `report_digest` (the digest the plan pinned). The stored reason is redacted and capped like every audit record. The chain stores the arguments only as a digest, so the counts are read from `reason`.

The record is written after the flush, because it carries the outcome. So the chain is checked durable before the flush begins, and an execute on a chain that is not durable exits 2 and flushes nothing. If the record cannot be written after the flush, the flush has already run: the run exits 1 with the reason, and `<plan>.result.json` still holds the result.

The server is the chain's writer. A repair execute is the one other writer, and it runs only with the server stopped, which the flush already requires. Its append rewrites the chain's checkpoint, so the next server start verifies the record like any other.

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
