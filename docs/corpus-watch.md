# Doc Watch — the docs plane follows the repositories

Tracked as WATCH-01 to WATCH-05 (v1.7 phase 65). When documentation changes in a registered repository, the docs plane
follows without anyone running `substrate corpus ingest`, and a restart of the server re-ingests nothing that has not
changed while `SUBSTRATE_PLANNING_HASH_STORE` is on, which it is by default (set it to a value other than `on` to turn it off; see the planning refresh below). The
commands are `substrate corpus sync`, `watch`, `reconcile`, `hook` and `hint`; the manifest, the plan and the ingest they
drive are described in [corpus.md](corpus.md), and the docs plane itself in [docs-plane.md](docs-plane.md).

## Four triggers, one sync

Every trigger ends in the same function, the one `corpus sync --execute` runs: scan the repository, plan against the
server, ingest what the plan says must change, report one `docs.sync` event. A sync is idempotent, because the manifest
(`corpus_documents`, on the server) is the only state: a document whose sha256 is already recorded is `unchanged` and is
never sent again, so a trigger that fires twice, or a restart, costs a plan and nothing else.

| Trigger | `trigger` in the event | What it notices | Needs |
| --- | --- | --- | --- |
| `corpus sync --repo R` | `manual` | whatever the operator asks for | nothing |
| the filesystem watcher of `corpus watch` | `watch` | an edit in a watched directory of a checkout | the watch limit of the host (below) |
| a git hook (`post-merge`, `post-checkout`, `post-rewrite`) through the hint spool | `hook` | a merge, a checkout or a rebase | the opt-in hook installer |
| the sweep timer of `corpus watch` (every `SUBSTRATE_CORPUS_SWEEP_S`), or `corpus watch --once` under a systemd timer | `sweep` | everything, including a push made from another machine | nothing |
| `corpus reconcile` | `reconcile` | the manifest and the docs plane disagreeing | the server's reconcile route |

The server's own planning refresh, the design's fourth trigger, runs inside the server and is not a CLI command. Its per-page
hashes live in the index table `planning_page_hashes` when `SUBSTRATE_PLANNING_HASH_STORE=on`, so a restart of the server
re-ingests nothing unchanged. With the flag off (`SUBSTRATE_PLANNING_HASH_STORE` set to a value other than `on`), they are kept in memory only and every restart re-ingests every
planning page. They are not in the corpus manifest (`corpus_documents`).

Only the sweep and the reconcile go to the network (they fetch the mirrors, below). A sync that a watch event or a hint
starts reads the mirror as it is.

### Coalescing

`corpus watch` feeds every signal into one coalescer per repository:

- A burst costs one sync per repository. The burst ends when the repository has been quiet for the debounce
  (`SUBSTRATE_CORPUS_DEBOUNCE_MS`, 2,000 ms), or when it has lasted the maximum wait (`SUBSTRATE_CORPUS_MAX_WAIT_MS`,
  30,000 ms), so a steady stream of edits still syncs.
- One sync runs at a time. A signal that arrives while a repository syncs becomes exactly one more sync of it, however
  many signals arrive.
- At most 4,096 repositories are tracked; a signal beyond that folds into a single "every repository" sweep.
- The loop reads the hint spool and looks at the clock about once a second, so a hint starts a sync within about a second
  of the debounce.
- The first sweep runs one debounce after start. `SIGTERM` and `SIGINT` stop the loop after the sync in flight; a sync
  that has not started is not started.

The `lag_s` of an event is the time from the first signal of the burst to the end of the sync.

## The read-only guarantee

The default triggers write nothing into any repository: not the watcher, not the sweep, not the reconcile, not a sync.

| Command | Writes, and where |
| --- | --- |
| `sync`, `watch`, `reconcile` | the docs plane through the server (only with `--execute`, or always for `watch`, whose purpose it is), the mirror directory, and one `docs.sync` event per sync. Nothing inside a repository. |
| `hint` | one file in the hint spool directory |
| `hook install`, `hook uninstall` | the three hook files in the `hooks` directory of the repository you name (that is, inside its `.git`, or in `core.hooksPath` when set). Run by an operator for chosen repositories, never by a trigger. |

The commands that look inside a repository run `git` with `GIT_OPTIONAL_LOCKS=0` (a read never rewrites the index),
`GIT_NO_LAZY_FETCH=1` (a missing object is reported and not fetched into the repository), `GIT_TERMINAL_PROMPT=0` and no
file-system monitor, and the only command that touches its configuration is `git remote get-url origin`. The objects of
the mirror reach those commands through `GIT_ALTERNATE_OBJECT_DIRECTORIES`, an environment variable of the child process,
so no object is copied into the repository. The tests hash the `.git` and the tree of every checkout before and after
`watch --once` and `reconcile --execute` and require them to be equal.

## The mirror and the view

A fetch moves refs and not the working tree, so a push made elsewhere leaves a checkout unchanged, and a scan of the
working tree would keep reporting no change. A fetch inside the checkout would write into its `.git`. So Substrate keeps
its own bare, blobless mirror of each origin (`git clone --mirror --filter=blob:none`, then `git fetch --prune` inside it)
under `SUBSTRATE_CORPUS_MIRROR_DIR`, named `<slug>-<12 hex of the origin hash>` so it never changes for one origin. The
origin URL is read from the checkout's own remote configuration (a relative path is resolved against the checkout). The
mirror directory is created readable by its owner only, because the origin URL it records may carry a credential.

What a sync reads for a repository is one view, decided from git state alone:

1. The mirror's default-branch tree is the base (`git ls-tree -r -l`, bodies by `git cat-file --batch`; the documentation
   blobs a blobless mirror lacks are fetched from the origin in batches, once).
2. The checkout's own documentation changes are laid over it, path by path. A path whose working-tree content differs from
   the merge base of the checkout's HEAD and the mirror's tip (committed beyond it, uncommitted, or untracked) takes the
   working-tree bytes; a path deleted locally is removed; every other path takes the mirror's content.

So a local edit never hides an unrelated push, a push never overwrites a local edit, and there is never a second view of
one `(repo, path)`: reading it twice, or alternating local edits and remote-only pushes without pulling, changes only the
paths that changed, and a file that did not change is never ingested again. Every entry passes the same rules as a plain
scan (tier, size, binary, UTF-8 with the byte-order mark kept, symlink, bad path), so it is identical in shape.

Fallbacks, each reported in the output and in `--json`:

- **No mirror yet.** `sync`, `hint`-triggered and `watch`-triggered syncs never create one. A repository that has never
  had a mirror (and any repository without an `origin` remote) is read from its working tree alone, as `corpus scan` reads
  it. The sweep, `reconcile` and `sync --fetch` create the mirror (a clone can take minutes for a large repository; it is
  made under a temporary name and renamed, so an interrupted clone leaves nothing that looks like a mirror).
- **`mirror-stale`.** A fetch that fails (offline, the origin is gone, a timeout) leaves the mirror at its last successful
  state, and the view keeps reading it, so an offline sync never replaces newer indexed text with an older checkout and
  never uploads it again when the origin recovers. The output says `mirror-stale <repo>: fetch-failed` (or
  `fetch-timeout`); the sync's outcome is still `ok`, and no row changes for it.
- **A mirror that could not be made** (`clone-failed`, `clone-timeout`, `mirror-dir-unusable`) is reported as `mirror`; the
  repository is read from its working tree alone.
- **An origin nobody has pushed to** has a mirror with no commit; the checkout is read from its working tree alone.
- **A checkout that shares no history with the mirror's default branch** (an orphan branch, a repository re-initialised)
  has no merge base: every local document counts as changed, the mirror still supplies the paths the checkout lacks, and the
  repository is read as incomplete.
- **Incomplete reads never remove anything.** A repository whose read was incomplete (a failed `git diff`, a blob the
  mirror cannot supply, no merge base) is left out of the plan's coverage, so none of its manifest rows is tombstoned; the
  output lists it under "not read completely".

## Hooks and the hint spool

A hook tells the watcher that a repository moved. It is an opt-in, installed for chosen repositories only. The three hint
hooks sit beside `post-commit`, the collector, which they never change:

```
substrate corpus hook install   --repo DIR     # post-merge, post-checkout, post-rewrite
substrate corpus hook status    --repo DIR
substrate corpus hook uninstall --repo DIR
bun packages/collectors/src/install-git-hook.ts --corpus DIR   # the same, beside the post-commit collector
```

Each hook file is `#!/bin/sh` followed by one block between `# >>> substrate corpus hint >>>` and
`# <<< substrate corpus hint <<<`. The block starts `substrate corpus hint --repo "$(git rev-parse --show-toplevel)"` in
the background, under `timeout 10` when the host has it, with its output sent nowhere, and the hook always exits 0, so it
can never fail or delay the user's git command. It runs `substrate` when that is on the `PATH`, else `bun` with this
checkout's `packages/cli/src/index.ts` (the path is written into the hook at install time, and not at all when it contains
a shell metacharacter), else nothing. `SUBSTRATE_HOOK_WAIT=1` runs it in the foreground, as the post-commit hook allows.

An existing hook file that is not ours (no marker, a symlink, a damaged block) is reported and left alone, and the other
hooks are still installed; `install` exits 1 for it. `install` on an installed hook refreshes the block in place.
`uninstall` removes only our block: a file left with nothing but a shebang is deleted, any other line is kept.

`corpus hint` writes one JSON file (`{v, dir, at}`, at most 4 KiB) into `SUBSTRATE_CORPUS_SPOOL`: a temporary dot file,
then a rename, so a reader never sees half of one. The spool holds at most 1,000 hints; a hint that does not fit
(`spool-full`, `bad-directory`, `too-large`, `spool-unwritable`) is dropped with its reason on stderr and the exit code is
still 0. `corpus watch` reads the spool about once a second, removes what it read (a malformed or oversized file of ours is
removed and counted; any other file in the directory is left alone) and signals the repository. A hint for a directory
below none of the roots is ignored with a line on stderr. Lost hints are recovered by the sweep.

A hint has no kind of its own: nothing called `docs.changed` is written or read. The sync that a hint starts is the `hook` trigger in the table above.

## Flags

All six are read in `packages/cli/src/corpus/watch-settings.ts`; the library below `packages/corpus` takes its directories
and numbers as parameters. A value that is not a plain integer takes its default; an integer outside its range is clamped
to the nearest bound. `<state>` is `$XDG_STATE_HOME/substrate` when `XDG_STATE_HOME` is an absolute path, else
`$HOME/.local/state/substrate`.

| Variable | Default | Range | Meaning |
| --- | --- | --- | --- |
| `SUBSTRATE_CORPUS_MIRROR_DIR` | `<state>/corpus-mirrors` | any directory | where the blobless mirrors live |
| `SUBSTRATE_CORPUS_SPOOL` | `<state>/corpus-hints` | any directory | where `corpus hint` writes and `corpus watch` reads |
| `SUBSTRATE_CORPUS_DEBOUNCE_MS` | 2000 | 100 to 60000 | quiet time that ends a burst |
| `SUBSTRATE_CORPUS_MAX_WAIT_MS` | 30000 | 1000 to 600000, never below the debounce | longest a burst may last before it syncs |
| `SUBSTRATE_CORPUS_WATCH_MAX` | 2000 | 10 to 20000 | most directories watched; the rest are left to the sweep |
| `SUBSTRATE_CORPUS_SWEEP_S` | 900 | 30 to 86400 | seconds between sweeps (`--sweep-s` overrides it and must be in range) |

The roots are `--root` (repeatable), else `SUBSTRATE_CORPUS_ROOTS` (colon-separated), else `/root/src/repos`; the tier and
size limits are `--tier` and `--max-bytes`, as for `scan`. The hook and the watcher must see the same spool: set
`SUBSTRATE_CORPUS_SPOOL` in both environments or in neither.

## What the watcher watches

The repository roots and the directory of every eligible document, found by the last sweep (so a new directory is watched
after the next sweep), at most `SUBSTRATE_CORPUS_WATCH_MAX` of them. An event only marks its repository dirty; it never
reads a file. Events about files that are not documentation (a `.swp` file, a build artefact) are ignored; an event with
no file name, or for a bare name with no extension (a directory), counts. When the host refuses a watch with `ENOSPC` (the
inotify limit) or `EMFILE`, every watch is closed, the command says so once on stderr, and it carries on with the sweep
alone; any other watch failure leaves just that directory to the sweep.

## The `docs.sync` event

Each `sync --execute`, each watch-loop sync, and each reconcile that ingests posts one `note` through `POST /events`. The body names
no surface (the server attributes the event to the surface of the token the CLI presents) and carries
`payload.runtime: "corpus-sync"` (see [event-vocabulary.md](event-vocabulary.md)):

```
payload: { action: "docs.sync", runtime: "corpus-sync", repo, trigger, outcome, lag_s,
           added, changed, updated, tombstoned, refused, failed, duration_ms }
```

`repo` is the label, or `*` when the sync covered several repositories; the event carries no top-level `repo`.
`trigger` is `manual`, `watch`, `hook`, `sweep` or `reconcile`. `outcome` is `ok`, `partial` (some document was refused or
failed, or a repository was too large to plan), `failed` (the plan or an ingest request failed as a whole) or `skipped`
(no repository matched). `added`, `changed` (changes and renames) and `updated` come from the plan; `tombstoned`,
`refused` and `failed` from the ingest. A dry run changes nothing and sends no event. A failed post never fails the sync:
the output says `docs.sync event not delivered (<reason>)`.

## `corpus reconcile`

The manifest and the plane are a dual write, so they can drift (a plane document deleted by hand, a crash between the two
writes). `reconcile` reads every repository (fetching the mirrors), plans what a sync would do, then asks the server where
the two disagree and prints it: the active rows whose plane document is gone, and the plane documents no active row owns.
It is a dry run until `--execute`, which has the server requeue the missing rows (so the next plan offers them as `add`) and
delete the orphans, then runs the sync that ingests what changed. The route is `POST /corpus/reconcile` in
[corpus.md](corpus.md).

## Exit codes

`sync`, `reconcile` and `watch --once` exit 0 when nothing asked for was refused or failed, 1 when a request failed, a
document ended `refused` or `failed`, or a repository named with `--repo` was not found, and 2 for a usage error. `hint`
exits 0 whatever happens. `hook install` and `uninstall` exit 1 for a foreign hook or a directory that is not a
repository. The long-running `watch` exits 0 when it is stopped by a signal.

## Troubleshooting

- **Nothing syncs.** Run `substrate corpus sync --repo R` (a dry run): `repo-not-found` means R is not below the roots, and
  `corpus.disabled` means the server runs with the corpus off.
- **The watcher says the inotify limit was reached.** Raise `fs.inotify.max_user_watches` on the host, or lower
  `SUBSTRATE_CORPUS_WATCH_MAX`; until then the sweep (`SUBSTRATE_CORPUS_SWEEP_S`) is the only trigger.
- **A push from another machine does not show up.** Only the sweep and the reconcile fetch; wait for the next sweep, or run
  `substrate corpus sync --fetch --repo R`. `mirror-stale` means the fetch failed: check that the origin is reachable from
  the host (a private origin needs credentials `git` can use without a prompt).
- **Hooks do nothing.** Check `substrate corpus hook status --repo DIR`; check that the hook and the watcher use the same
  `SUBSTRATE_CORPUS_SPOOL`; a repository whose directory is below none of the roots is ignored.
- **`spool-full`.** The watcher is not running; hints wait in the spool up to 1,000 files.
- **A repository is listed under "not read completely".** Its rows were not judged removed; the reason is on the line
  (for example no merge base). It is retried at every sync.
- **Events do not arrive.** `docs.sync event not delivered (http-403)` means the token's surface may not post it; the sync
  itself is unaffected.

## Limits

| Limit | Value |
| --- | --- |
| Hint spool | 1,000 files of at most 4 KiB; directory at most 2,048 bytes |
| Repositories tracked by the coalescer | 4,096, the rest fold into one sweep |
| Watched directories | `SUBSTRATE_CORPUS_WATCH_MAX`, at most 20,000 |
| Blobs per `git cat-file --batch` call | 500 or 64 MiB, whichever comes first |
| Object ids asked of the origin per fetch | 1,000 |
| Clone / fetch timeout | 600 s / 120 s |
| A sweep's plans | grouped by repository to stay within 20,000 entries and 4,000 coverage pairs per request; a repository larger than that is reported and not planned |
