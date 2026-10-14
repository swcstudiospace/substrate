# Runbook — index disaster recovery: verified export, offline verify, restore to scratch

| | |
| --- | --- |
| Question | Can the Postgres index (graph, lease and governed-memory tables) be rebuilt if the Railway volume is lost? |
| Scope | Read-only against the index; writes only under `SUBSTRATE_INDEX_ARCHIVE_DIR` and one ledger `note` per run |
| Blast radius | None on production. The export is one `REPEATABLE READ READ ONLY` transaction; restore refuses the production database |
| Not covered | Hindsight banks, RAGFlow datasets, the Greptime ledger (see `docs/greptime-ledger.md`, *Coverage and archive*), the desk's own tables, Redis |

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

The table list is closed: it is `IndexStore.migrate()`'s nine graph and memory tables, held in
`index-archive-spec.ts`, and no table or column name ever comes from input. The
`skills_registry` table (uplift-5) is not archived, and the `skill.*` events in the ledger are a
best-effort trail, not a restore source: a lost table is rebuilt by deciding the pull requests
again ([skills-propose.md](../skills-propose.md#approving-a-skill)).
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

**Disaster recovery from an archive** is a manual, deliberate act: restore into a new Railway
database, check the table, then point `SUBSTRATE_PG_URL` at it (an operator step). Parked-write text is
gone by design; the leases in the archive are as of the snapshot, come back **without their fencing token**
(`lease_id` is NULL, so a restored holder cannot heartbeat it) and have lapsed or will lapse on their own
(`docs/runbooks/lease-stuck.md`).

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
