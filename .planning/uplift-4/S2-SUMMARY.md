# S2 — Index disaster recovery (summary)

## What changed
Before: the only index backup was a manual Railway volume snapshot; nothing verified one. Now `substrate index archive|verify-archive|restore` exports the nine index tables as NDJSON in one REPEATABLE READ READ ONLY transaction, verifies them offline, and proves a restore into a scratch database with counts and digests.

### Files
New: `packages/mcp-server/src/index-archive-spec.ts` (closed table/column whitelist, schema hash, row coercion), `index-archive.ts` (export, manifest, offline verify, restore, note marker, arg grammar), `index-archive-watch.ts` (archive-age read, SLO row), `index-run.ts` (runner), tests `index-archive.test.ts`, `index-archive-watch.test.ts`, `index-store.archive.test.ts` (live PG, skipped without `SUBSTRATE_TEST_PG_URL`), `packages/cli/src/index-archive.ts` (+ test), `packages/observability/src/gauge.test.ts`, `infra/vps/substrate-index-archive.{service,timer}` + `.service.d/10-environment.conf` (staged), `docs/runbooks/index-archive.md`, env notes.
Small hunks in hot files: `index-store.ts` (export/restore access, `tuneGraphNodes`, `capacity().graphNodes`, `tune` option, an import), `config.ts` (`indexArchive` settings at the end of the ledger block), `service.ts` (archive watch, `jobs.index`, `indexArchiveSlo`, `observer.indexArchiveAge`, `tune` passed to `IndexStore`), `server.ts` (`/slo.indexArchive` spread), `observe.ts` (observer hook), `ledger-archive.ts` (`realish`, `existingAncestor` now exported — no other change), `packages/observability` (`Gauge` instrument, `GaugeSnapshot`, OTLP gauge encoding, checkpoint skips gauges, `setIndexArchiveAge`), `packages/cli/src/index.ts` (dispatch), `scripts/doctor-units.test.ts` (unit list), `docs/observability.md`, `infra/vps/README.md`.

## Flags and defaults
See `env-notes/S2.md`. Everything defaults off: no archive dir → the command refuses by name, `/healthz` has no `jobs.index`, `/slo` no `indexArchive`, no gauge series; `SUBSTRATE_INDEX_TUNE` unset → `migrate()` alters nothing. The one default-on change is additive: `/healthz.capacity.index.graphNodes` (the ratios you asked for).

## Failure behaviour
- Refusals (exit 2, nothing created): unset/empty dir, root fs, working tree, release root, checkout, unproven mount (`st_dev` of the nearest existing ancestor vs `/` and the release root), free space below `SUBSTRATE_DEPLOY_MIN_FREE_GB`, unreadable `df`, a restore URL that names production or an unset `SUBSTRATE_PG_URL`, an archive that fails offline verify.
- Export failure (deadline, byte bound, count mismatch, a row with a column outside the spec, a throw): all `.part` files and the snapshot directory are removed; no manifest exists, so no reader sees the snapshot.
- Note: marker written before the emit, deleted only on `stored: true`; a throwing/refused emit leaves only the marker, is reported on stderr, and does not fail the archive (exit 0). The next run resends pending notes first and exports nothing for them.
- Restore: the whole load and comparison is one transaction; any difference rolls it back (exit 1 with the table).
- Health: the archive-age read is async, memoised 60 s, single-flight, bounded to the 1 s probe; the error code only is exposed.

## Secrets
`memory_quarantine` and `memory_reviews` are exported without `body` and `subject`; a row carrying any column outside the spec aborts the export. Restore writes `[withheld by index-archive]` / NULL; hashes and counts still verify. Documented in the runbook.

## Rollback
Disable/remove the timer and units (operator); unset the env names. Snapshots on disk are left alone (the code deletes nothing). `git revert` removes the code; `/healthz` and `/slo` revert to today's shape. Tune: `alter table graph_nodes reset (fillfactor, autovacuum_vacuum_scale_factor)`.

## Verify (run by the orchestrator; none were run by this lane)
```
bunx tsc --noEmit
bun test packages/mcp-server/src/index-archive.test.ts packages/mcp-server/src/index-archive-watch.test.ts packages/cli/src/index-archive.test.ts packages/observability/src/gauge.test.ts scripts/doctor-units.test.ts
SUBSTRATE_TEST_PG_URL=postgres://… bun test packages/mcp-server/src/index-store.archive.test.ts packages/mcp-server/src/index-store.sweep.test.ts
bun test packages/mcp-server/src/store-lock.test.ts packages/mcp-server/src/vocabulary-lock.test.ts
bun run check:phase-close && bun test
```

## Residual risks
- Nothing was executed here (edit-only lane): the Bun `sql.begin("isolation level repeatable read read only", …)` option string, the `$n::type` casts in `sql.unsafe`, and the restore load are exercised only by the live test; run it first.
- `observe.test`/`otlp`/`metrics` consumers that switch on `metric.kind` now see a third kind (`gauge`); only otlp, checkpoint and metrics did, and all three are handled.
- The live test's restore step needs `create database`; without that privilege it archives and verifies but skips the restore.
- Export holds a REPEATABLE READ snapshot open for the run (seconds at 12 MB); the bounds cap it.
- The index has no `skills` table (the task's list named one); the whitelist is exactly `migrate()`'s nine tables, and a live test compares it with `information_schema`.
- `capacity()` costs one extra statement per uncached `/healthz` read.

## Review round 1 fixes
1. `capacity()` issues its three reads with `Promise.all` (test: `index-store.capacity.test.ts` — three statements open at once).
2. `normalizePgUrl` canonicalises every IPv4 spelling (decimal/octal/hex/short), `127.0.0.0/8`, `0.0.0.0`, `::`, `::1` and IPv4-mapped IPv6 to one `loopback` host; default port, trailing slashes and percent-escapes handled.
3. A failed export removes renamed data files too; the next run sweeps stale manifest-less `index-<stamp>` directories (>1 h, only our file names) and reports them (`onSwept`).
4. `graph_nodes.lease_id` and `memory_writes.holder` are withheld (restored NULL); schema hash changes, so archives written before this are `schema` mismatches (none exist in production).
5. Live test: 3+ rows per table at page size 2 vs a direct ordered select, a real concurrent insert between page reads, drift test against `pg_index`/`information_schema` types and keys.
6. Marker write/clear failures are returned as `markerError` (exit 0, distinct warning); stale runner comment fixed; gauge wording says "complete (manifest present)".
7. The age gauge has an observe callback evaluated at snapshot time (`Substrate` offers `observer.indexArchive` at construction; `IndexArchiveWatch.peekCreatedAt` keeps it current in the background).
