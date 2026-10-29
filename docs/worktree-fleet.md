# Worktree fleet: inventory, safe pruning, conflict forecasts and a disk floor (phase 68)

Many sessions work in git worktrees of the same repository. Left alone they fill the disk, nobody knows whose worktree is whose, and two of them find out they edited the same lines when the second merge fails. `substrate worktree` is the operator's door to all three, built on the `@substrate/fleet` library (`packages/fleet`). It acts on this host only: the server never touches a worktree (ADR 0005, ADR 0007), and the registry it keeps is a report the CLI posts ([worktree-fleet-api.md](worktree-fleet-api.md)).

Nothing here assumes where worktrees live. The locations are `SUBSTRATE_WORKTREE_ROOTS`; with none configured the commands say so and exit 2.

## Settings

| Flag | Meaning | Default |
|---|---|---|
| `SUBSTRATE_WORKTREE_ROOTS` | Colon-separated absolute directories searched for repositories and their worktrees. Relative entries are ignored. `--root DIR` (repeatable) overrides it for one command. | unset (or no absolute entry): the commands and the doctor assume no location; the commands say so and exit 2 and the doctor adds no row. The collector's graph attribution (`worktreeRoots`) still falls back to the dispatcher directory `/var/lib/substrate/worktrees`, also when no entry is absolute. The dispatcher does not read this variable and always uses that directory. |
| `SUBSTRATE_WORKTREE_MIN_FREE_GB` | The free-disk floor, in GiB. `worktree provision` and the dispatcher's `ensure_worktree` both refuse to create a worktree below it, and the doctor reports against it. A value that is not a positive number falls back to the default (the dispatcher logs it), so a typo never turns the floor off. | 5 |
| `SUBSTRATE_WORKTREE_IDLE_DAYS` | How long a worktree must have been untouched before `prune` may call it safe. `--idle-days N` overrides it for one `prune`. | 14 |

## How worktrees are found

Git is the source of truth, not a path convention. `discoverRepos` looks for a `.git` directory or gitfile up to three levels below each root (never inside `node_modules`), and collapses every linked worktree to its git common dir, so one repository is one entry however many of its worktrees sit under the roots. `git worktree list --porcelain -z` (git 2.36 or newer) is then run for each repository, which also finds linked worktrees that live outside the roots. The listing is NUL-delimited because a worktree path may legally contain a newline. The same worktree reached from two repositories or two roots is reported once.

For each worktree the inventory records: path, `repo` (`owner/name` from `origin`, else `local/<directory>`; a directory name the registry would refuse, such as one with a space, becomes `local/<slug>-<8 hex of sha256 of the name>`, where the slug keeps `[A-Za-z0-9._-]`, replaces everything else with `-` and is cut so the whole label fits), branch, head, `base` (merge base with the default branch), dirty state (untracked files count; a `git status` that fails counts as dirty), ahead and behind the default branch, last commit time, newest file modification time, size, locked, primary and pull-request state.

- **Default branch:** `origin/HEAD`, else `main`, else `master`.
- **Size** counts allocated bytes, each inode once (`dev:ino`), so hardlinked dependency trees are not counted per link; symlinks are not followed. It is the tree's size, not what removing it frees (see *Space freed* below). The walk has an entry cap and a time cap. When a cap is hit the size and the newest-activity time are reported as unknown, never as a partial number.
- **Pull-request state** comes from `gh pr list --head <branch> --state all --json state,headRefOid,number --limit 5`, with bounded concurrency and one answer cached per branch. Any failure (no `gh`, not signed in, no network) is `unknown`, which never makes anything safer.

## Commands

```
substrate worktree list|status [--root DIR]... [--repo R] [--json]
substrate worktree scan [--root DIR]... [--report] [--json]
substrate worktree prune [--root DIR]... [--idle-days N] [--execute] [--json]
substrate worktree conflicts [--repo R | --root DIR...] [--json]
substrate worktree provision --repo DIR --branch B [--base REF] [--path DIR] [--json]
substrate worktree disk [--root DIR]... [--json]
```

Exit codes: 0 done; 1 a removal, report or creation failed; 2 usage, or no worktree root configured. A flag a subcommand does not take is refused before anything runs. `--repo R` is `owner/name` or the directory of the repository's primary checkout. For `conflicts`, a directory named with `--repo` is searched whatever `SUBSTRATE_WORKTREE_ROOTS` holds (a repository outside the roots is not skipped); `--root` entries are added to it, and `owner/name` only filters what the roots hold.

- `list` / `status`: every worktree with its prune class and the numbers above.
- `scan`: the same inventory; with `--report` it is posted to `POST /worktrees/report` (500 worktrees per request) so the registry can answer for other sessions. A report the server refuses or cannot be reached is exit 1. Bodies are cut by row count (500) and by encoded size (the route's 1,000,000-byte limit less a margin), so long paths never push a body over; a single row too large for any body is not sent, is named on stderr and under `skipped` in `--json`, and the rest of the fleet is still reported.
- `disk`: free space on the filesystem of each root (the tightest wins), the floor, and the ten largest linked worktrees.
- `provision`: checks the floor, then runs `git worktree add -b B <path> <base>`. The default path is `<first root>/<branch with / replaced by ->`, the default base is the default branch (else `HEAD`). Below the floor nothing is created and the exit is 1.

## Prune classes

`prune` is a dry run until `--execute`. Each worktree is classified from facts gathered by git, and only `safe` is ever removed.

**`never`**, with the reasons printed:

- the primary checkout;
- the current working directory, or any directory inside the worktree;
- dirty (uncommitted changes or untracked files);
- locked;
- **a live graph claim**: the worktree sits at `<root>/<graph_id>` and the server reports an unexpired lease on a node of that graph (below);
- head not pushed (neither `origin/<branch>` containing HEAD, nor HEAD an ancestor of the default branch, nor HEAD the head commit of a merged pull request), including a detached HEAD whose commits are on no remote branch.

**`safe`** requires all of:

1. clean, and the head pushed as above;
2. idle for at least the threshold, by **both** the last commit time and the newest file modification time (an unknown time is not idle);
3. no ignored files that hold work (below);
   (and, for a graph checkout, the server answered and named no live claim: *Live claims* below)
4. the current HEAD is proven merged: it is an ancestor of the default branch, **or** it equals the head commit of a merged pull request for the branch.

A branch name or a pull-request state alone proves nothing. A branch can gain commits after its pull request merged and still be clean and pushed; such a branch is `review`, never `safe`. A squash merge leaves the branch's HEAD out of the default branch, so the comparison with the merged pull request's head commit is what proves it.

**`review`** is everything else, with the reasons: not idle, not provably merged, an unknown pull-request state, ignored files, `claims-unverified` (the claims lookup could not be answered), or a directory git lists but that is gone (`git worktree prune` drops that record).

### Ignored files

`git worktree remove` refuses a worktree with tracked changes or untracked files, but it deletes **ignored** files without a word, and `.planning/`, `.env*` and local notes live there. So ignored files count as work, except for regenerable directories (`node_modules`, `dist`, `build`, `target`, `.cache`, `coverage`, `__pycache__`, `.venv`, `venv`, `.next`, `vendor`, wherever they appear in a path). Any other ignored file makes the worktree at best `review` with the reason `ignored-files` and the first five paths named, unless the primary checkout holds a byte-identical file at the same path. The exemption is for directories only: an ignored regular file or link that is merely *called* `target` or `dist` (say `.planning/target`) is compared like any other file. A file too large to compare, an unreadable directory, or an ignored tree that exceeds the scan's bounds counts as work. The bounds cover every entry visited (files and directories, so a tree of empty directories cannot stall the walk) and the time spent (10 seconds); the walk is synchronous, so no outer timeout could stop it.

### Live claims

A session may reuse an old, clean, merged checkout and hold a live claim on its graph without changing a file, so git and file times cannot tell it from an abandoned one; only the server can. A worktree whose directory under a root is a graph id (`<root>/<graph_id>`, the same derivation as the report's `graph_id`) is checked with `GET /worktrees/claims?graph_id=` ([worktree-fleet-api.md](worktree-fleet-api.md)):

- a live (unexpired) claim makes it `never`, naming the node, the holder and the expiry;
- a lookup that cannot be answered (no bearer token, server unreachable, refused, unreadable reply) makes it `review` with the reason `claims-unverified`. The rule fails closed: an unanswered question is never read as "no claims";
- a worktree that is not under a root as `<root>/<graph_id>` has no claim concept and is not looked up.

The lookup is made only for worktrees that would otherwise be `safe` (at most four at a time), and `--execute` asks again for each one immediately before removing it. `list`, `status` and `prune --json` carry the answer per worktree as `claims`: `{state: "not-checked" | "none" | "live" | "unverified", graph_id, ...}`.

### `--execute`

Removes only `safe` worktrees, one at a time, with `git worktree remove <path>` (never `--force`). Immediately before each removal the worktree's identity (head, branch, detached) is reloaded from `git worktree list`, never taken from the inventory, then it is inspected and classified again from scratch against that **current** head (a merge proof for an older head says nothing about a commit another session has made since), and the server is asked once more for live claims; one that is no longer `safe`, or that git no longer lists, is skipped and said so. The first removal git refuses stops the run: it is reported (exit 1), not retried, and nothing after it is attempted. Each removal writes one ledger note (`note`, `payload.action` `worktree.prune`: path, head, size and the reasons) through the events route; a note that could not be recorded is reported, the removal is already done. With `--json` every removed worktree carries `ledger`: `stored`, `refused`, `failed` or `spooled` (parked in the event spool for replay, so not recorded yet). A note that is not `stored` is always warned about on stderr, in every mode, so a server outage never looks like a fully recorded run.

### Space freed

`size_bytes` is a worktree's allocated size with each hardlinked inode counted once. Removal does not free an inode that is also linked from outside what is removed (a dependency store, another worktree that stays). `would_free_bytes` (dry run) and `freed_bytes` (`--execute`) are therefore computed from link counts: an inode's blocks count only when its link count equals the number of links found inside the worktrees being removed in this run (across all of them), and single-link files always count. They are a lower bound, written "freeing at least" in the text output; a worktree whose tree could not be walked completely counts as freeing nothing, and a note says so.

## Conflict forecast

`substrate worktree conflicts` works on one repository at a time (or every repository under the roots) and prints:

1. for each worktree, the files it changed against its merge base plus its uncommitted changes (renames count as a delete and an add);
2. each pair of worktrees that changed a common file;
3. for each such pair, `git merge-tree --write-tree --name-only <head1> <head2>`: exit 1 means a textual conflict and the output lists the files. This command needs git 2.38 or newer and never reads or changes either worktree or the index (it writes only tree objects into the object store). With an older git the pair is reported `unavailable` with that reason, never guessed;
4. a suggested merge order: worktrees with no overlaps first, then fewer changed files, ties by path; for a pair that conflicts, the later one is flagged as needing a rebase onto the earlier.

A forecast whose changed files could not be listed (a missing merge base, a failed `git diff` or `git status`) is not shown as clean: each affected worktree prints its warning and reads `changes unknown`, the repository is marked `INCOMPLETE`, "no overlapping files" becomes "no overlap among the files that could be listed", and `--json` carries `incomplete: true` with the notes on every entry.

Limits: the prediction compares committed HEADs, so uncommitted edits count toward the overlap list but not the prediction; a textually clean merge can still break the build; pairs are predicted, not the cumulative result of three merges in a row; at most 300 pairs are predicted per repository (the rest are listed `unavailable`).

## The report and the registry

`scan --report` posts `{protocol: 1, host, reported_at, worktrees: [...]}`. Only the contract's fields are sent: path, repo, branch, head, base, dirty, ahead, behind, last commit time, size, locked, primary, pull-request state and `graph_id` when the path is `<root>/<graph_id>` under a configured root. Ignored file names, merged pull request heads and notes stay on the host. The route, its flag and its audit are in [worktree-fleet-api.md](worktree-fleet-api.md); with the registry off the server answers 503 and `scan --report` exits 1.

`graph_id` attribution (`packages/collectors/src/worktree-graph.ts`) uses the same roots: the first configured root that contains a path decides, and the first segment below it is the id.

## The disk floor

`worktree provision` (this package) and `ensure_worktree` (`packages/dispatcher/src/substrate_dispatcher/worktree.py`) read the same `SUBSTRATE_WORKTREE_MIN_FREE_GB`. The dispatcher checks `/` as before and refuses with the marker `low-disk` before it runs any git command.

`bun run doctor:runtime` adds one report-only row, `worktree disk`, when `SUBSTRATE_WORKTREE_ROOTS` is set: `ok`, or a warning naming the free space, the floor and the three largest worktrees. It never fails the run and changes nothing.

## Recipe: reclaim disk safely

1. `substrate worktree disk`: how much is free and which worktrees are largest.
2. `substrate worktree prune`: the dry run. Read the `safe` list and the bytes it would free; read the `review` reasons for the big ones.
3. `substrate worktree prune --execute`: removes the `safe` ones. A failure stops the run; fix what git said and run it again.
4. For a large `review` worktree, decide by hand: finish or push the branch, copy the ignored notes you want, then remove it with `git worktree remove <path>` yourself. Do not use `--force` on something you have not looked at.
5. A missing directory that git still lists: `git worktree prune` from the repository.
6. `substrate worktree scan --report` to refresh the registry.
