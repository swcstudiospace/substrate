# Runbook — index disaster recovery: verified export, offline verify, restore to scratch

| | |
| --- | --- |
| Question | Can the archived graph, lease and governed-memory subset be rebuilt if the Postgres volume is lost? This is not a complete security-authority backup. |
| Scope | Read-only against the index; writes only under `SUBSTRATE_INDEX_ARCHIVE_DIR` and one ledger `note` per run |
| Blast radius | None on production. The export is one `REPEATABLE READ READ ONLY` transaction; restore refuses the production database |
| Not covered | `live_session_bindings` (including permanent identity/tombstone security history), historical `steering_sessions`, `planning_steering_audit`, other tables outside the closed graph/memory list; Hindsight, docs datasets, Greptime ledger (see `docs/greptime-ledger.md`), desk tables and Redis |

The release gate does not prove this archive unless `SUBSTRATE_GATE_INDEX_DRILL=1`. That opt-in drill archives the twin's scratch Postgres into a temp directory under the run dir and restores it into a second database on the same loopback server. It does not read or write `/mnt/index-archive`, and it does not set `SUBSTRATE_INDEX_ARCHIVE_DIR`.

Before this existed the only backup was a manual Railway volume snapshot taken
before a sweep apply (`docs/runbooks/quarantine-spike.md`), and nothing ever
proved a snapshot could be restored. This is a second, logical copy, and a way to
check it.

## What the archive holds

`substrate index archive` writes `<SUBSTRATE_INDEX_ARCHIVE_DIR>/index-<UTC stamp>/`:

| File | Content |
| --- | --- |
| `graph_index.ndjson`, `graph_nodes.ndjson`, `graph_edges.ndjson`, `graph_steps.ndjson`, `graph_bindings.ndjson` | The graph and lease tables, one JSON row per line |
| `memory_entries.ndjson`, `memory_writes.ndjson` | Accepted memory and the idempotency ledger |
| `memory_quarantine.ndjson`, `memory_reviews.ndjson` | Parked writes — **without their text** (below) |
| `manifest.json` | Format version, `createdAt`, release sha, Postgres `server_version`, the schema hash, and per table `{file, rows, bytes, sha256, columns, withheld, rowDigest, entryHashDigest}` |

The closed list is the nine graph/memory tables in `index-archive-spec.ts`, **not every table created by `IndexStore.migrate()`**. Its compatibility schema hash remains unchanged by live-authority migration 42. Excluding a table preserves old logical-archive compatibility; it does not provide backup coverage.

`skills_registry` is also excluded. Its `skill.*` events are best-effort trail, not restore source: approvals must be decided again ([skills-propose.md](../skills-propose.md#approving-a-skill)). Unlike rebuildable metadata, live binding/tombstone history cannot safely be decided again from events or legacy rows.
`index-store.archive.test.ts` compares the list
with `information_schema` on a live database, so a column added to `migrate()` and
not to the spec fails CI. Tables are read in key order, in pages of
`--page-size` rows (default 500, at most 5000), through one connection; the
export never holds more than one page in memory and writes each page to disk as it
goes. Timestamps are written to the microsecond in UTC; `lease_epoch` as a
decimal string.

The manifest is renamed into place **last**, so a snapshot directory without
`manifest.json` is an unfinished one: a failed run removes everything it wrote — the `.part` files, any data file already
renamed into place, and the directory — and every reader ignores a directory with no manifest. A run that was killed
(so nothing could clean up) leaves such a directory; the **next run removes it and says so** (`[index] removed N unfinished
snapshot directories …`), but only a directory that is named like this archive's own (`index-<stamp>`), older than one hour
(or twice `SUBSTRATE_INDEX_ARCHIVE_MAX_SECONDS`, if longer) by the stamp in its name, has no `manifest.json`, and holds nothing
but the files an export writes. Anything else in the archive directory is left alone.

### Secrets and personal data — what never leaves the box

`memory_quarantine` holds writes the governance gate classified as **secret**,
**pii** or **speculative**; `memory_reviews` holds proposals awaiting review. The
body in both is only *pattern*-redacted, and personal data is by definition not
something a pattern rewrites, so either table can hold an email address, a phone
number or a card number in clear text. The archive therefore exports, for those two
tables, every column **except `body` and `subject`**: ids, scope, kind, writer,
the content `entry_hash`, the reason, the dates and the review state.

- A row carrying a column the spec does not list (a future column, a stub) makes
  the export fail; it is never written.
- Restore refills `body` with `[withheld by index-archive]` and `subject` with
  NULL. The text of a parked write **cannot be recovered from an archive**; the
  counts and the `entry_hash` of every row still verify.
- `graph_nodes.lease_id` and `memory_writes.holder` are **fencing tokens**: only the holder of a lease or a write claim
  may see them (`lease.ts`), so they are withheld like parked text and restored as NULL. Every other column was checked
  once more: ids, surfaces, session ids, URLs, timestamps and content hashes are already in the ledger or the brief;
  `memory_writes.idempotency_key` is the table's key (a derived hash, or a caller-supplied key redacted on write) and
  cannot be withheld.
- `memory_entries` (accepted memory) is the system of record and is exported whole:
  its text was redacted on write and passed the classifier.
- A restored scratch index is therefore not a copy of production's quarantine
  queue; do not use one to review parked writes.

The ledger note and every report name tables, counts and digests only — never row
contents and never a path.

## Run it

```bash
export SUBSTRATE_INDEX_ARCHIVE_DIR=/mnt/index-archive        # an off-box mount; unset refuses by name (exit 2)
substrate index archive                                       # or: substrate index archive --out DIR [--page-size N] [--json]
substrate index verify-archive /mnt/index-archive            # newest snapshot, or pass a snapshot directory; exit 2 on any mismatch
substrate index restore --scratch "$SCRATCH_URL" /mnt/index-archive
```

Prefer `SUBSTRATE_INDEX_SCRATCH_URL` over `--scratch` when the URL carries a
password: an argument is visible to every user in `ps`.

### Guards (all checked before anything is created)

- **Directory.** Unset or empty → refused by name. The filesystem root, anything
  inside the working tree, anything under `/opt/agent-substrate` and any checkout are refused.
- **Mount.** The `st_dev` of the nearest *existing* ancestor must differ from `/`
  and from the release root's, so a volume that failed to mount after a reboot is a
  named refusal, never an archive quietly built on the root disk. `SUBSTRATE_INDEX_ARCHIVE_ALLOW_ROOTFS=1`
  waives this one gate for a deliberate local test on a one-disk machine; do not set it on the VPS.
- **Free space.** At least `SUBSTRATE_DEPLOY_MIN_FREE_GB` (default 5; `0` disables, like the deploy gate) on that
  filesystem; an unreadable `df` refuses.
- **Bounds.** `SUBSTRATE_INDEX_ARCHIVE_MAX_SECONDS` (default 900) and `SUBSTRATE_INDEX_ARCHIVE_MAX_BYTES`
  (default 1 GiB) end a runaway export; the transaction rolls back and nothing is left behind.

Exit codes: `0` done; `1` a store or filesystem failure, an export bound, or a restore that did
not reproduce the archive; `2` usage or a refusal (directory, mount, floor, an archive that does
not verify, a scratch URL that names production).

A pending ledger note (below) is reported on stderr and does **not** change the exit code: the archive
itself succeeded.

## Verify (offline)

`substrate index verify-archive <dir>` needs no database, no network and no ledger. It checks, in
order: the manifest exists, parses and is this format; its schema hash, table list and column lists
equal this release's; every table file exists with the manifest's size and SHA-256; every line is a
row of its table in exactly the form the export writes; line counts equal the manifest's; and the
row digest and the `entry_hash` digest recomputed from the lines equal the manifest's. The digests
are order-independent, so they still match after a restore into a database that sorts differently.

It prints the closed vocabulary below, with table and file names and counts — never row contents — and
exits 2 on any finding:

| Kind | Meaning |
| --- | --- |
| `missing-file` | A table file (or the manifest) is not there |
| `size` | A file's size differs from the manifest |
| `hash` | The file's SHA-256, its row digest or its `entry_hash` digest differs |
| `rowcount` | The number of lines differs from the manifest |
| `parse` | A line is not JSON, not a row of its table, is over 16 MiB, or the file does not end with a newline |
| `schema` | The manifest was written under another schema hash or column list than this release's |
| `manifest` | The manifest does not parse, is another version, or does not describe these files |

A `schema` mismatch after a release that changed `migrate()` means: restore with the release
that wrote the archive (its sha is in the manifest).

## Restore to scratch — never production

`substrate index restore --scratch <url> <dir>`:

1. **Refuses** unless `SUBSTRATE_PG_URL` is set (so it never guesses which database is production),
   and refuses any URL whose normalised host, port and database equal it. Every spelling of the loopback
   host is one host (`localhost`, the empty host, `127.0.0.0/8` in any `inet_aton` form — `127.1`,
   `2130706433`, `0x7f.0.0.1`, `0177.0.0.1` — `0.0.0.0`, `::`, `::1` and the IPv4-mapped forms such as
   `::ffff:7f00:1`), any other IPv4 address is its dotted quad, a trailing dot and case are ignored, the
   default port 5432 is applied, the database is compared without trailing slashes and with percent-escapes
   decoded, an omitted database falls back to the user name, and a URL whose query string can redirect
   the connection (`host`, `hostaddr`,
   `port`, `dbname`, `service`) is refused because the comparison would be a guess. Exit 2, and the
   message names `host:port/database` only.
2. Verifies the archive offline; a mismatch refuses before the scratch is touched.
3. Runs `migrate()` on the scratch database, requires every archived table to be empty, then loads
   the tables in foreign-key order inside **one transaction**, reads each back through the same keyset
   pages, and compares the row count, the row digest and the `entry_hash` digest with the manifest.
4. Prints a table; any difference throws inside the transaction, which rolls back — a failed
   restore leaves the scratch database empty.

Create the scratch database yourself (`createdb`), on a server that is not the production one, or on
the same server under another name. Drop it afterwards. CI does this with the `postgres:16` service
(`SUBSTRATE_TEST_PG_URL`) in `index-store.archive.test.ts`.

**Disaster recovery from this logical archive is incomplete.** An operator may restore its graph/memory subset into a replacement database and inspect the table results, but must not point live-session serving traffic at that database on the strength of this archive. Parked text is withheld by design; restored graph leases lack `lease_id` and lapse ([lease-stuck.md](lease-stuck.md)). Migration creating an empty authority table is not recovery of live-session identity history.

## Live-session authority — complete native backup and controlled recovery

Mandatory migration 42's `live_session_bindings` contains immutable owner/proof-hash/state/lease records and terminal tombstones. Both active and terminal rows are excluded from the logical archive. Historical migration-37 `steering_sessions` rows, presence, cache, inbox audit and shared ledger do not contain authoritative complete security state; none can recreate lost tombstones, restore a proof or justify ID reuse. Applied old SQL/digests are unchanged.

Before operating the credential cutover, an operator must establish a **complete PostgreSQL-native backup/recovery path** covering all authority records, schema and migration history: for example an access-controlled native base backup with retained WAL/PITR and a documented consistent recovery point. A native logical dump is useful only if its coverage and recovery horizon are security-complete; an old dump missing later issued/closed identities is not. Native backups contain sensitive authority/private data despite hash-only proof storage; encrypt/restrict them and never attach rows/credentials to logs or tickets. This repository's closed archive/verify/drill commands do not implement or certify that path.

On missing, stale, corrupt or uncertain security records:

1. **Quiesce every live-session entry point** on every instance, including MCP lifecycle, private docs/brief and REST, before recovery. Stop serving or gate authenticated ingress through an operator-controlled maintenance boundary. Merely setting `SUBSTRATE_PLANNING_STEERING=off` is insufficient: independent lifecycle MCP/private consumers still exist. Preserve surviving records, backups and WAL; never delete tombstones or automatically run documentary down SQL.
2. Recover complete native PostgreSQL security state into an isolated target. Establish continuity for **all previously issued identities**, not just active rows at one old snapshot. Do not backfill caller-chosen legacy rows or infer ownership/revocation from ledger/cache/presence. Verify backup integrity/coverage and schema/migration compatibility through the operator's native recovery procedure before any re-enable.
3. **Invalidate all restored active bindings before serving again**, retaining their identity records as terminal. This prevents older leases/proofs restored from a snapshot from becoming usable again. Use an approved operator recovery procedure with quiesced authority; there is no automatic bulk-reset/recovery CLI or new API here. Individually reachable active identities can be explicitly closed with an authorized operator, but that is not proof that absent historical tombstones were recovered.
4. Only with complete retained terminal history and an approved recovery decision, re-enable compatible proof-enforcing code and let clients explicitly open new identities. Retarget live handles/private files while keeping historical checkpoint labels. Do not restore lost plaintext proof from public history or reset/re-register an old ID.

**If tombstones/issued-identity history are irretrievably lost or recovery is stale, permanent non-reuse cannot be proven.** Quiescence, active invalidation or a newly empty table does not reconstruct missing evidence. Keep the guarantee uncertified and live access quiesced pending an explicit operator security-recovery decision; never present cache/ledger reconstruction as safe automatic recovery.

No complete native backup, production restore/rehearsal, active invalidation, deployment or live-traffic re-enable was performed for Phase 71. Even a passing logical scratch drill would not prove authority recovery. Old unbound code is not a transparent recovery fallback; see [rollback compatibility](rollback-compat.md).

## The ledger note and its marker

After a successful archive the run emits one `note` on surface `substrate`
(`session_id: index-archive:<snapshot>`, `payload.action: "index.archive"`, counts, sizes and digests per
table). The order matters, because a snapshot is never exported twice:

1. The snapshot and manifest are on disk.
2. `note-pending-<snapshot>.json` is written **before** the emit.
3. The marker is deleted only when the ledger reports the note stored.

An emit that throws, a refused note and a process killed in between all leave the marker. The next run
sends the pending notes first — only the notes; nothing is exported for them — and a note that still cannot be
stored is reported on stderr. A failed note never turns a successful archive into a failure. The same holds when the marker
itself cannot be written or cleared (a full disk): the emit is still attempted and a distinct
`[index] warning: note marker not written …` line says the note may not be retried; the exit code stays 0.

## Health, metric and SLO

With `SUBSTRATE_INDEX_ARCHIVE_DIR` set on the server:

- `GET /healthz` gains `jobs.index = { lastArchiveAt, ageSeconds, snapshot, reason }`, read from the
  directory's manifests (a snapshot counts only when its manifest exists), memoised for 60 s, never awaited
  past the 1 s probe bound; with the variable unset the key is absent and `/healthz` is byte-identical to before.
- `substrate.index.archive.age_seconds` (OTLP gauge, no attributes, not checkpointed) is computed from the newest archive's creation
  time **when the metrics are snapshotted** (each export), not when someone polls `/healthz` or `/slo`; a background read of the
  directory (memoised 60 s) keeps that time current, and an unreadable directory keeps the last time seen, so the age keeps
  growing instead of the series vanishing. It counts a snapshot whose manifest exists; it does not re-verify one (run
  `verify-archive` for that).
- `GET /slo` gains `indexArchive: [ { id: "index.archive.age", … } ]`. It is **report-only** (`status: "report-only"`)
  until `SUBSTRATE_INDEX_ARCHIVE_MAX_AGE_H` is set (26 once the timer is installed); then `ok` at or under the
  ceiling, `breached` above it or with no archive, `insufficient-data` when the directory cannot be read. It is not folded
  into `breached`, like the docs and capacity rows.

The server must see the same directory the timer writes to: set the variable in `substrate.env`, not only
in the drop-in.

## Schedule (staged, not installed)

`infra/vps/substrate-index-archive.{service,timer}` run it daily at 03:45 UTC after the 03:17 sweep and
the 03:30 ledger archive. Installing, enabling and mounting the volume are operator steps
(`infra/vps/README.md`, *Daily index archive*). Nothing in the code installs a unit or a timer, and the code
deletes no archive: old snapshots are the operator's to prune.

## Lease-table bloat — visibility and an opt-in tune

`graph_nodes` takes a heartbeat update on every lease renewal, and `lease_expires_at` is indexed, so
those updates are not HOT (they write a new heap tuple and new index entries). `/healthz.capacity.index.graphNodes`
reports `hotUpdateRatio` (`n_tup_hot_upd / n_tup_upd`) and `deadRatio` (`n_dead_tup / (n_live_tup + n_dead_tup)`),
each `null` while its denominator is zero. At today's size (45 live rows) this is cosmetic.

`SUBSTRATE_INDEX_TUNE=apply` (default off) makes `migrate()` run, once and idempotently,
`alter table graph_nodes set (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.02)`. It only reads
`reloptions` first and issues the `alter` when either option is not already set; it affects new pages only (rewriting
existing ones is an operator `VACUUM FULL`, never code). No index is dropped by code. Roll back with
`alter table graph_nodes reset (fillfactor, autovacuum_vacuum_scale_factor)` and unset the variable.
