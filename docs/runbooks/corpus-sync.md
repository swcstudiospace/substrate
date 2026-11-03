# Runbook: keeping the docs plane in step with documentation (doc watch)

v1.7 phase 65. The corpus atlas (`docs/runbooks/corpus-ingest.md`) puts every repository's documentation into the docs plane
when you run it. The doc watch makes the plane follow a change without anyone running a command. `docs/corpus-watch.md`
describes the CLI side (the watcher, the hooks, the mirrors, the settings); this runbook is the operator's order of work, and
what proves each step.

Everything here is off or staged until you switch it on, and nothing in it writes into a repository: the watcher and the
reconcile are read-only, and git hooks are an opt-in you install for repositories you choose.

## What each trigger does

| Trigger | What it is | Writes into a repository? |
| --- | --- | --- |
| `hook` | A git hook (post-merge, post-checkout, post-rewrite) leaves a bounded `docs.changed` hint in the spool and always exits 0. | Yes: the hook file in that repository's `.git/hooks`, installed only by `substrate corpus hook install`, never over a foreign hook |
| `watch` | `substrate corpus watch` watches the registered roots, waits for quiet (`SUBSTRATE_CORPUS_DEBOUNCE_MS`, at most `SUBSTRATE_CORPUS_MAX_WAIT_MS`) and runs one sync per repository however many edits there were. | No |
| `sweep` | The same command on a timer (`--once`, or the watcher's own interval `SUBSTRATE_CORPUS_SWEEP_S`): reads each repository's Substrate-managed blobless mirror, so a push made from another machine is found although the local checkout has not pulled. | No (it fetches into the mirror directory, never into your clone) |
| `manual` | `substrate corpus sync --repo R`. | No |
| `reconcile` | `substrate corpus reconcile`: compares the server's manifest with the docs plane. | No |

Every sync posts one `docs.sync` note (outcome, trigger, lag, counts) and the server records the lag as the gauge
`substrate.corpus.sync_lag_seconds` (no repository label; the newest reported sync wins).

## 1. Enable the flags

On the server (`/etc/substrate/substrate.env`):

| Flag | Default | Effect |
| --- | --- | --- |
| `SUBSTRATE_CORPUS` | `off` | `on` opens the corpus routes, including `POST /corpus/reconcile`. Off: every corpus route answers `503 corpus.disabled`. |
| `SUBSTRATE_PLANNING_HASH_STORE` | `off` | `on` keeps the server's planning refresh hashes in the index table `planning_page_hashes` (migration step 39), loaded at the first pass. Without an index the hashes stay in memory, as with the flag off. Off: a restart re-ingests every planning page. |
| `SUBSTRATE_CORPUS_FRESH_MAX_AGE_S` | `172800` | While `SUBSTRATE_CORPUS=on`, a corpus whose last ingest is older than this many seconds raises the existing `docs.freshness` warning once, and one note when an ingest clears it. `0` judges nothing. A corpus whose documents never change is as old as its last change, so a quiet corpus warns after the limit; raise the limit for one. |

On the host that runs the CLI, the doc watch flags `SUBSTRATE_CORPUS_MIRROR_DIR`, `SUBSTRATE_CORPUS_SPOOL`,
`SUBSTRATE_CORPUS_DEBOUNCE_MS`, `SUBSTRATE_CORPUS_MAX_WAIT_MS`, `SUBSTRATE_CORPUS_WATCH_MAX` and `SUBSTRATE_CORPUS_SWEEP_S` are
described in `docs/corpus-watch.md`; their defaults are right for a first run.

Restart the server after changing a flag.

**Proof.** `substrate corpus status` prints the manifest counts and `lagSeconds` (the age of the newest manifest write; the
server answers `null` for an empty manifest). With `SUBSTRATE_CORPUS` off the same command reports that the corpus is off.
After the first planning pass with `SUBSTRATE_PLANNING_HASH_STORE=on`, `select count(*) from planning_page_hashes` is the number of
planning pages; restart the server and the next `docs.planning` note names only the pages that changed.

## 2. The first reconcile

Run the dry run first. It reads the plane's document listing and the manifest and changes nothing:

```
substrate corpus reconcile
```

It reports `missingInPlane` (active manifest rows whose plane document is gone), `orphansInPlane` (names of `corpus:` plane
documents no active row owns; never their text) and `checked` (rows compared). The reply is `truncated` when the drift is cut at
500 keys in total (missing rows and orphans together) or the read was incomplete (the plane listing hit its page or time bound, or the manifest has more than 100,000 active rows);
the server does not claim a document missing from a cut listing, nor an orphan when it did not read every row, so a truncated
report can under-report but never invents drift. It never names or touches a plane document whose name does not start with
`corpus:`.

Read the report, then repair:

```
substrate corpus reconcile --execute
```

`--execute` marks each missing row removed without calling the plane (the document is already gone), so the next plan offers
the path as an `add` and the next `substrate corpus sync --execute` puts the document back. It deletes each orphan from the plane with
the ingest's rules: the delete is confirmed by the plane, an orphan an active row holds at that moment is kept, and a delete that
failed or was not confirmed is not counted as repaired (`repaired.deleted` is smaller than the orphans listed; run it again).
At most 500 keys are repaired per run, in total.

The route is `POST /corpus/reconcile` with `{protocol: 1, execute}`. It needs a bearer (401 without one), answers
`503 corpus.disabled` while the corpus is off, `503 corpus.backend-unavailable` without a LightRAG plane,
`503 corpus.index-unavailable` when the manifest does not answer and `503 corpus.plane-unreachable` when the plane cannot list.
A dry run is audited under `corpus_status` (fail-open); `execute` is audited under `corpus_ingest` (fail-closed: an audit chain that
cannot take the record refuses it). It takes the same lock as the ingest, so a repair never overlaps an insert.

**Proof.** Run the dry run again after `--execute` and then a `substrate corpus sync --execute`: `missingInPlane` and the repaired
orphans are gone from the report.

## 3. Install the units

The units are staged in `infra/vps`, not installed:

```
install -m 0644 infra/vps/substrate-corpus-watch.service infra/vps/substrate-corpus-sync.service infra/vps/substrate-corpus-sync.timer /etc/systemd/system/
install -m 0600 /dev/null /etc/substrate/substrate-corpus.env   # then fill in SUBSTRATE_URL, the CLI's token and SUBSTRATE_CORPUS_ROOTS
systemctl daemon-reload
systemctl enable --now substrate-corpus-sync.timer          # a sweep every 15 minutes, a missed one runs at boot
systemctl enable --now substrate-corpus-watch.service       # optional: the live watcher, restarted on failure
```

Both services run at `Nice=15`, `IOSchedulingClass=idle`, `CPUQuota=25%` and `MemoryMax=512M`, with
`NoNewPrivileges=true` and `ProtectSystem=strict`; their only writable paths are `/var/lib/substrate/corpus-mirrors` and
`/var/lib/substrate/corpus-hints`, so no repository is writable for them. The watcher drops to sweep-only when the inotify
watch limit is reached. The timer alone is enough if you do not want a long-running process; the watcher only shortens the
lag from minutes to the debounce.

**Proof.** `systemctl list-timers substrate-corpus-sync.timer` shows the next run; after one run
`journalctl -u substrate-corpus-sync.service` ends in the sweep's per-repository lines, `systemctl show
substrate-corpus-watch.service -p Nice,CPUQuotaPerSecUSec,MemoryMax` shows the ceilings, and `touch` in a registered
repository changes nothing in its `git status`. The sweep's `docs.sync` notes appear in `events_query` with
`payload.action = docs.sync`.

## 4. Git hooks (opt-in)

Only for repositories you choose, and only after you have read `docs/corpus-watch.md`: `substrate corpus hook install --repo
PATH` adds post-merge, post-checkout and post-rewrite hooks beside the existing post-commit collector. A hook leaves a bounded
hint, always exits 0 and never overwrites a foreign hook (it reports it and stops). A hint that is lost is recovered by the next
sweep or reconcile, so hooks are an acceleration, not a requirement.

**Proof.** `git merge` in that repository leaves a hint file in the spool directory, and the watcher or the next sweep consumes
it into a `docs.sync` note with `trigger: hook`.

## 5. Drift repair, day to day

- A `docs.freshness` warning with `dataset: corpus` means the last ingest is older than `SUBSTRATE_CORPUS_FRESH_MAX_AGE_S`.
  Check `substrate corpus status` (`lagSeconds`, `lastIngestAt`), the units' journal, and run `substrate corpus sync --execute`. If the
  documentation really did not change, raise the limit; the note when it clears is the end of the episode.
- Scheduled reconcile: run `substrate corpus reconcile` (dry run) weekly; a non-empty report means the manifest and the plane
  disagreed (a plane restore, a killed run between the plane write and the manifest write). Repair with `--execute`.

## 6. Rollback

- Stop the doc watch: `systemctl disable --now substrate-corpus-watch.service substrate-corpus-sync.timer`. Nothing it did needs
  undoing; the mirrors and the spool under `/var/lib/substrate` can be removed.
- Hooks: remove the hook files `corpus hook install` added (the command lists them); a hook that finds the CLI missing exits 0.
- Server flags: unset `SUBSTRATE_PLANNING_HASH_STORE` (the table stays, unused; `docs/runbooks/rollback-compat.md` has the `down`
  statement) and `SUBSTRATE_CORPUS_FRESH_MAX_AGE_S`. Setting `SUBSTRATE_CORPUS=off` closes every corpus route and the freshness
  check; a standing `corpus` marker clears with one recovery note on the next lag pass.

**Proof.** `systemctl list-units 'substrate-corpus-*'` is empty, and `substrate corpus reconcile` answers `503 corpus.disabled` once the
corpus is off.
