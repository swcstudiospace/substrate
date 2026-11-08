# Phase 78 context: cross-layer reconciliation

Recorded by the orchestrator on 2026-11-02 under the manual GSD fallback, because the GSD skills cannot be invoked from this session. Base: `gsd/v18-int-73-75-76` at `0a1f7c68` (phases 73, 75 and 76, plus 76's owner override). Line numbers are in that tree.

## Goal and success criteria (ROADMAP Phase 78, verbatim)

Goal: The ledger, the index and the cache agree, and any drift is reported with evidence. No drift is repaired destructively without a confirmed plan.

1. A scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run.
2. Repair is a separate confirmed step with a plan record, following the corpus delete rules.

Depends on: phases 73, 75, 76. ROADMAP discovery says `substrate_coord_drift_scan` does not compare GreptimeDB against TimescaleDB. In this codebase the index is Postgres (`index-store.ts`), so this phase compares against Postgres. The "TimescaleDB" wording is stale and is not used here.

## Verified facts (file:line, integration tree)

Ledger events (GreptimeDB `agent_events`, written through `service.ts`):
- Claim: `service.ts:5096-5130`. Kind `claim`, or `warning` when the action is `stolen`. Payload `{ action: granted|reclaimed|stolen, lease_epoch, ttl_seconds, expires_at, evicted? }`. A renewal is silent (`5096-5099`).
- Heartbeat: `service.ts:5224-5242`. Emits nothing. It only bumps the graph generation.
- Release: `service.ts:5289-5321`. Kind `note`, or `warning` when forced. Payload `{ action: decision.action, lease_epoch: observed_epoch, evicted?, dod? }`. The holder comes from the decision (`5293`).
- Reap (expiry): `service.ts:6876-6887`. Kind `warning`. Payload `{ action: "expired", lease_epoch, expired_at, evicted? }`.
- Memory audit: `service.ts:3107-3152`. Kind `note` when the write is accepted and verified, else `warning`. Payload `{ outcome, scope, kind, entry_id (accepted only), strategy?, review_id?, quarantine_id? }`. The emit swallows failures (`3151`).
- Claim emit failures are tracked (`service.ts:5129`, `recorded = emitted?.stored === true`). The release and memory emits swallow failures (`5320`, `3151`).

Index (Postgres, `index-store.ts`), authoritative for current state:
- `graph_nodes` (`376-395`): `claimed_by` (surface, `383`), `claimed_at`, `claim_session`, `lease_id`, `lease_expires_at`, `lease_heartbeat_at` (v5, `394`), `lease_epoch bigint not null default 0` (v6, `395`). Key `(graph_id, node_id)`.
- Grant and release writes: `index-store.ts:1344-1351` (grant sets `lease_epoch`, `claimed_by`, `claim_session`, `lease_id`); `1563-1580` (release clears the hold, keeps `lease_epoch`).
- Reaper: `index-store.ts:1600-1648`.
- `memory_entries` (`440-472`): `id`, `scope`, `kind`, `subject`, `writer`, `body`, `superseded_by` (`469`; a forget marker `forgotten:<id>` at `2077-2098`), `entry_hash` (`470`), `idempotency_key` (`472`), `created`.

Cache (Dragonfly, `cache.ts`), derived only:
- Prefix `substrate:v1` (`CACHE_PREFIX`). Key builders: `cacheKey` `282-285` (hash of surface, generation, args), `snapshotKey` `293-295`, `digestKey` `302-303`.
- Generation counters: `MEMORY_GENERATION_KEY` `84`, `RECALL_GENERATION_KEY` `93`, `GRAPHS_GENERATION_KEY` `96`, `graphGenerationKey(id)` = `gen:graph:<id>` `98-100`, `DOCS_GENERATION_KEY` `107`. `FORGET_MARK_KEY` `115` is a timestamp, not a generation.
- `classOf` `74-80`. Client surface `416-424` (get, mget, set, incr, eval). No SCAN, KEYS or DBSIZE in non-test source.
- Bump `844-851` (INCR). Forget mark `860-870`.

Ledger readers: `queryEvents` `greptime.ts:1511` (match filters, limit, order; used at `service.ts:4190-4194`). `readEvents` `1664` is unbounded with no kind filter. `readRecentEvents` `1676` is bounded to 200. Exact signatures are confirmed in U2.

## Decisions

D78-1 Scope. The reconcile is read-only. It has three comparisons: lease identity (ledger against index), memory writes (ledger audit against index rows), and cache generation orphans (cache against index). Deferred: answer-level cache verification (it would need recomposition), any rebuild of leases from the ledger (not possible, see D78-2), and anchors (covered by phase 73).

D78-2 Leases compare identity, never expiry. The ledger holds the grant, release and expiry transitions, each with `lease_epoch`. It has no heartbeats (`5224-5242`). For each node, the latest transition gives the ledger's view: held by (surface, session, epoch), or free. The index view is `claimed_by`, `claim_session` and `lease_epoch`, or free. Drift is: ledger held and index free; index held and ledger free; or both held and (surface, session, epoch) differ. An expired hold that has not been reaped yet is not drift. Both sides free is not drift, and the epoch is not compared while free.

D78-3 Memory writes compare in both directions over a window. The window is `SUBSTRATE_RECONCILE_WINDOW_HOURS` (default 24, maximum 168). The index side is `memory_entries` rows created in the window. The ledger side is audit events in the window that carry `payload.entry_id` with `outcome = accepted`. An index row with no event is drift. An event with no row is drift. Rows older than the window are counted as unchecked, not as drift. The first mismatching key is the entry id, in sorted order.

D78-4 Cache generations. The cache is enumerated read-only with a new `scanKeys(match, limit)` (SCAN with MATCH and COUNT, capped). Keys are counted per class. Drift is a `gen:graph:<id>` key whose graph is absent from `graph_index`. The first mismatching key is that orphan key. Truncated scans report `truncated: true` and never claim a clean result.

D78-5 Repair is a whole derived-cache flush of the `substrate:v1` prefix, behind a confirmed plan. Answer keys are hashes with no graph id, so they cannot be selected per graph. Deleting a generation counter alone is unsafe: an answer built while the counter was absent can become reachable again and revive a stale answer. Counters and answers therefore go together. Snapshots and the forget mark are cache too, and go with them. The repair never touches the ledger or the index. It is safe because the cache is derived; the cost is a cold cache.

D78-6 Plan record. `plan` is a dry run. It writes a JSON file: `{ schema: "substrate.reconcile.plan.v1", created_at, window, report_digest, items }`, where `items` lists each action. `repair --plan <file>` without `--execute` is a dry run that prints what it would do. `repair --plan <file> --execute` checks the digest, re-runs the drift check, and refuses if the drift no longer holds. It flushes, then writes `<file>.result.json`. Re-running is safe, because a second run finds nothing to repair. This follows the corpus rules: dry run first, explicit execute, act only on what the plan names, and report repaired against listed.

D78-7 Schedule. `SUBSTRATE_RECONCILE_INTERVAL_S` defaults to 0, which is off. When it is above 0, the server runs the report on that interval. Each run writes one JSON log line and writes nothing to the ledger, the index or the cache. A clean run reports zero findings, and a test asserts that it writes nothing.

D78-8 Surface. `scripts/reconcile.ts`, run as `bun run reconcile -- report|plan|repair`. It follows the pattern of `scripts/cache-stats.ts`.

D78-9 Per-layer counts. Ledger: lease transitions and memory audit events in the window. Index: `graph_nodes` rows with a hold, `graph_index` rows, and `memory_entries` rows in the window. Cache: keys per class, from the capped scan.

## Hazards and residual risks

H1 The memory audit emit swallows failures (`service.ts:3151`), so an index row without a ledger event is a real drift class. The reconcile reports it. It does not repair it.
H2 The release emit swallows failures (`service.ts:5320`), so the ledger can show a hold that the index has released. Reported, not repaired.
H3 Silent renewals and expiry are invisible to the ledger (D78-2). The design makes no claim about them.
H4 The flush repair is only safe because the cache is derived (D78-5). It also removes snapshots and the forget mark. That is correct only because the snapshots are cache too.
H5 SCAN is O(keys). The scan is capped, the schedule is off by default, and truncation is reported.
H6 Verifier R-1 and R-2 (phase 76, recorded NOT FIXED) can produce ledger events that the memory and lease comparisons will report. That is the intended behaviour, not a reason to change the comparisons.

## Out of scope

Answer-level cache verification. Any repair of the ledger or the index. TimescaleDB, which the ROADMAP discovery text names but which this codebase does not use for the index. Live Dragonfly and live GreptimeDB runs, which are operator steps and are listed as human verification.
