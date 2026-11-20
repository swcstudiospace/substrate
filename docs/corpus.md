# Corpus Atlas — the documentation of every repository, in one manifest

Tracked as ATLAS-01 to ATLAS-06 (v1.7 phase 63). The corpus is the documentation of every repository the owner keeps:
the clones on this host, the GitHub accounts and the Greptile knowledge bases. It is discovered and classified where the
files are (the `substrate corpus` commands), recorded in one manifest on the server (`corpus_documents`, keyed by
`(repo, path)`), and put into the docs plane in bulk, with provenance, in the one docs dataset `corpus`. The docs plane is
described in `docs/docs-plane.md`; this page is the corpus around it.

Discovery never runs on the server: the server does not read a path it is given. The CLI sends entries (no bodies) to
plan, and bodies only for the documents the plan says must change.

## What an entry is

Every documentation file is described by one entry. The contract is `packages/corpus/src/protocol.ts`
(`CORPUS_PROTOCOL = 1`; a server refuses a request that names another version, and the CLI refuses an answer that does).

| Field | Meaning |
| --- | --- |
| `repo` | `owner/name` from the origin remote of a GitHub checkout (https, ssh and scp forms, credentials removed, `.git` removed, case kept), else `local/<label of the directory name>` (see Copy collections) |
| `path` | repository-relative path with forward slashes |
| `kind` | what the document is, decided from the path alone (table below) |
| `tier` | 1 authoritative and current, 2 supporting, 3 bulk or historical |
| `sha256` | lowercase hex of the raw bytes |
| `bytes` | size of the raw bytes |
| `source` | `fs`, `github` or `greptile` |
| `commit` | the commit the content was read at, when known (the checkout HEAD, or the branch head for GitHub) |

The document's citation URL is `https://github.com/<owner>/<repo>/blob/<commit>/<path>` for a GitHub origin and
`corpus://<repo>/<path>` for a repository with none.

## Kinds and tiers

Only `.md`, `.mdx`, `.rst` and `.adoc` files (any case) are candidates, and a path with a directory named `node_modules`,
`.git`, `dist`, `build`, `target`, `vendor`, `.venv`, `venv`, `__pycache__`, `.next`, `.cache`, `coverage`,
`site-packages` or `third_party` is never one. The rules run in this order on the lowercased repo-relative path; the first
match wins.

| Rule | Path | Kind | Tier |
| --- | --- | --- | --- |
| 1 | `.planning/STATE.md` | `planning-state` | 1 |
| 1 | `.planning/ROADMAP.md` | `planning-roadmap` | 1 |
| 1 | `.planning/REQUIREMENTS.md` | `planning-requirements` | 1 |
| 1 | `.planning/PROJECT.md` | `planning-project` | 1 |
| 1 | `.planning/MILESTONES.md` | `planning-milestones` | 1 |
| 1 | `.planning/RETROSPECTIVE.md` | `planning-milestones` | 2 |
| 1 | `.planning/milestones/*MILESTONE-AUDIT.md` | `planning-audit` | 2 |
| 1 | any other file under `.planning/milestones/` | `planning-archive` | 3 |
| 1 | `.planning/phases/*-CONTEXT.md` | `planning-context` | 2 |
| 1 | `.planning/phases/*-SUMMARY.md` | `planning-summary` | 2 |
| 1 | `.planning/phases/*-VERIFICATION.md` | `planning-verification` | 2 |
| 1 | `.planning/phases/*-PLAN.md` | `planning-plan` | 3 |
| 1 | `.planning/phases/*-RESEARCH.md`, `.planning/research/**` | `planning-research` | 2 |
| 1 | any other file directly in `.planning/` | `planning-other` | 2 |
| 1 | anything deeper in `.planning/` that matched nothing above | `planning-other` | 3 |
| 2 | `AGENTS.md`, `CLAUDE.md` | `agents` | 1 |
| 2 | `SKILL.md` | `skill` | 1 |
| 3 | `CHANGELOG*`, `HISTORY*`, `RELEASES*` | `changelog` | 1 at the repo root, 2 deeper |
| 4 | a directory named `adr` or `decisions` | `adr` | 1 |
| 4 | a directory named `runbooks` | `runbook` | 1 |
| 5 | `docs/research/**` | `doc` | 2 |
| 5 | everything else under `docs/` | `doc` | 1 |
| 6 | `README*` | `readme` | 1 at the repo root, 2 deeper |
| 7 | every other documentation file | `other` | 3 |

A `.planning` directory may sit at any depth of a monorepo; the rules apply from that directory. The kind `greptile-kb`
(tier 2) is given only by the Greptile adapter. The default scan keeps tier 2 and below; `--tier 3` adds the bulk.

## What a scan does

1. **Discovery.** Every directory below each root (default depth 3) with a `.git` entry (directory or file) is a checkout.
   Git is called with an argument vector, never a shell string.
2. **Collapse.** Linked worktrees that share a git directory become one checkout. Checkouts of the same origin become one:
   the canonical one is on the default branch (`refs/remotes/origin/HEAD`, else `main`, else `master`) with the newest HEAD
   commit, ties going to the shortest path. Checkouts with no origin share a label when their directory names match and
   collapse the same way. Every collapse is listed in the report and its notes.
3. **Copy collections.** A directory with no `.git` that holds documentation is a copy collection and is walked under a
   label derived from its name (`localRepoId`, see below), with the same exclusions. A checkout nested inside one is found by discovery and is not read
   twice, so a collection of worktrees collapses like any other. A root that holds checkouts is a container: loose files
   directly in it are not scanned. A readable directory directly below a root with no checkout and no documentation in it
   (a collection whose last document was deleted) is still a collection: it is read with zero entries, counted as an
   emptied collection in the report, and covered, so its old rows are removed. A checkout with no documentation left is
   covered the same way. **Labels.** A directory name that already satisfies the repository rule keeps `local/<name>`
   unchanged, so rows recorded earlier keep their identity. Any other name (a colon, a slash, a control character, `..`,
   more than 200 characters in all) becomes `local/<slug>-<8 hex of sha256(name)>`: the slug is the name with every
   character outside `A-Za-z0-9._-` replaced by `-`, leading dots and dashes removed (`collection` when nothing is left)
   and cut so the whole label fits the 200-character limit with the hash kept, so two names that slug alike still get
   different labels. **Duplicate labels.** When more than one folder under the roots yields one label (two roots that
   both hold a `notes` folder, or a checkout with no origin and a plain folder of one name), the label is **not covered**:
   there is no coverage pair for it, so nothing recorded under it is judged removed, and the report says
   `duplicate-label` with the last two components of each folder (`a/notes`, `b/notes`, never an absolute path). Every
   such folder is still read: an empty folder never shadows a folder with documents, and when more than one holds a path
   the first folder in root order keeps it and the report counts the paths left unread.
4. **Files.** For a checkout the candidates are the tracked files (`git ls-files -z`); for a collection they are the files
   of the walk. A file is skipped, with a reason, when it is a symlink (`symlink`), empty (`empty`), larger than
   `--max-bytes` (`too-large`, decided from its size before it is read), contains a NUL byte (`binary`), is not valid UTF-8
   (`invalid-utf8`), is tracked but gone from the work tree (`missing`), cannot be read (`unreadable`) or has a path or a
   repository label the server's rules refuse (`bad-path`: a control character, a backslash, an empty segment or more than
   1024 characters), so one odd file name cannot make the server refuse the whole plan.
5. **Identical copies.** Byte-identical files in different `local/*` repositories collapse to the entry with the
   lexically smallest `(repo, path)`. The report lists each kept entry with the copies it stands for
   (`collapsed.identicalCopies`, at most 200 groups of 20 copies, plus the exact totals `identical` and `identicalGroups`),
   so a collapsed copy can be told from a deleted file. When the canonical copy disappears, the next copy (lexically)
   becomes canonical. A rename never crosses repositories, except that a copy in a `local/*` collection may be renamed to
   another `local/*` collection: moving the kept copy from `local/c1` to `local/c2` is a `rename` when `local/c1` is covered
   by the scan (its plan item carries `renamedFromRepo: local/c1`), so the plane holds the text once under the new name.
   Identical files inside one repository, and files of repositories with an origin, are never collapsed.

The scan is deterministic: the same tree gives the same entries, sorted by `(repo, path)` by code unit, and the same
report. It holds one file body at a time.

Each repository in the report says whether it was read **completely**. A read error, a failed `git ls-files` or a
truncated GitHub tree makes it incomplete; a skip rule above does not. The bytes of a file are hashed as they are on disk,
including a leading byte-order mark, and the body sent to the server keeps it, so the hash the server recomputes matches.

## The CLI

```
substrate corpus scan   [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--source fs|github|greptile]...
                        [--greptile-dir DIR] [--github-owner OWNER] [--max-repos N] [--json] [--entries]
substrate corpus plan   (scan options) [--server URL] [--json] [--neardup [--threshold N] [--neardup-max N]]
substrate corpus ingest (plan options) [--execute] [--batch-docs N] [--batch-bytes N] [--json]
substrate corpus status [--server URL] [--json]
substrate corpus sync   [--repo R]... [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--server URL] [--execute] [--fetch] [--json]
substrate corpus watch  [--root DIR]... [--sweep-s N] [--server URL] [--once]
substrate corpus reconcile [--root DIR]... [--server URL] [--execute] [--json]
substrate corpus hook install|uninstall|status --repo DIR
substrate corpus hint   --repo DIR
substrate corpus eval   [--root DIR]... [--tier 1|2|3] [--max-bytes N] [--max-queries N] [--server URL] [--json]
```

- `scan` needs no server. It prints the totals by repository, kind and tier, the bytes, the collapsed counts, the skipped
  reasons and the repositories that were not read completely. `--json` prints `{report}` (with `entries` only when
  `--entries` is given).
- `eval` generates a golden set of questions from the Markdown documents the scan found and, with `--server`, asks them
  of `POST /docs/search` and scores recall, MRR and latency. It is read-only and exits 1 when recall at 5 is under the
  objective; see [`corpus-eval.md`](corpus-eval.md).
- `plan` scans, then asks the server what a bulk ingest would change: it prints the counts, the coverage, the
  (repository, source) pairs that were left out of it with the reason, and the first 20 items of each action. It never
  sends bodies. A scan that read nothing completely still plans its entries, with an empty coverage that tombstones
  nothing.
- `plan --neardup` then compares the documents the plan would add, update, change or rename, and prints the pairs that
  look alike (see [Near-duplicates](#near-duplicates-advisory)). `--threshold` is a number from 0.5 to 1 (the server's
  default, 0.92, when absent) and `--neardup-max` a whole number from 1 to 1000 (default 1000); either one without
  `--neardup` is a usage error, and `ingest` and `status` do not accept `--neardup`.
- `ingest` plans first. Without `--execute` it prints the plan and exits 0: a dry run, and it says so. With `--execute`
  it sends the tombstones first, as requests of their own with `documents: []` (at most 500 each), then reads the bodies
  of the `add`, `change`, `update` and `rename` items and sends them in batches, and prints the count of each status. The
  order matters for a rename: the plane answers an insert of identical text with the document it already holds, so the
  old document must be gone before the new name is inserted. Before it deletes anything, the CLI checks every document it
  is about to send against the same rules the server applies (the repository label and path rules, the plane-safe
  document name, the 1,000,000-byte bound, and a body that is not empty once remote images are stripped; the code is
  shared in `packages/corpus/src/names.ts`, so the two cannot disagree). A rename's old row is removed only when the new
  document passes those checks and its text can be read with the hash that was planned; otherwise the old row stays
  active, nothing is deleted, and the new document is listed as `refused` with the server's reason (`unsafe-name`,
  `too-large`, `empty-document`, `bad-path`, `bad-repo`) or as `failed` (`unreadable`, `changed-since-scan`). The new
  document is sent only when the old row was removed. A replacement that was accepted for sending and then fails (the
  plane is down, a timeout) has already lost its old copy: the next run sees the new path as an `add` and sends it
  again, so nothing is lost silently. It exits 1 when a request failed as a whole or when any document it was asked to
  ingest ended `refused` or `failed` (the summary lists each with its reason); it exits 0 only when every item ended
  `ingested`, `updated`, `unchanged` or `tombstoned`. Re-running is safe: the server skips rows it already recorded, so a run killed half way resumes without
  re-sending them. `--batch-docs` (and `SUBSTRATE_CORPUS_BATCH_DOCS`) above the server limit of 200 documents per
  request is lowered to 200 with a note on stderr.
- `status` prints the manifest summary, including the seconds since the newest manifest write.
- `sync`, `watch`, `reconcile`, `hook` and `hint` keep the docs plane in step with the repositories without anyone running
  `ingest`. `sync --repo R` reads only the named repositories, plans with coverage for those pairs alone, and with
  `--execute` ingests what changed, then sends one `docs.sync` event; `watch` is the long-running loop; `reconcile` compares
  the manifest with the plane; `hook` and `hint` are the opt-in git hooks. They read each checkout through the mirror view
  (a push made elsewhere is found although the checkout did not move) and write nothing into any repository. All of it,
  the four triggers, the mirror, the spool, the flags and troubleshooting, is in [corpus-watch.md](corpus-watch.md).

```
# What is on this host, without a server
substrate corpus scan
substrate corpus scan --root /root/src/repos --root /root/src/archive --tier 3 --json

# What would change, then do it
substrate corpus plan
substrate corpus ingest                      # dry run
substrate corpus ingest --execute

# The GitHub repositories with no local clone, and a Greptile export
substrate corpus plan --source fs,github --github-owner swcstudiospace --max-repos 25
substrate corpus plan --source greptile --greptile-dir /var/lib/substrate/greptile-export
```

Exit codes: 0 done, 1 failed, 2 usage.

| Variable | Meaning | Default |
| --- | --- | --- |
| `SUBSTRATE_CORPUS_ROOTS` | colon-separated default roots when no `--root` is given | `/root/src/repos` |
| `SUBSTRATE_CORPUS_BATCH_DOCS` | documents per ingest request (`--batch-docs` wins; at most 200, a larger value is lowered) | 20 |
| `SUBSTRATE_CORPUS_BATCH_BYTES` | body bytes per ingest request (`--batch-bytes` wins) | 1,000,000 |

The server URL and the bearer are the ones the other commands use (`SUBSTRATE_URL`, and the token from
`SUBSTRATE_TOKEN`, its token file or the per-surface token directory). A batch always holds at least one document, so a
document larger than the byte bound travels alone.

### The plan's coverage

The plan request carries `scope: {coverage, maxTier}` where `coverage` is a list of `{repo, source}` pairs. The server
tombstones a manifest row the scan did not report only when its `(repo, source)` pair is in `coverage` and its tier is at
most `maxTier`. A pair is listed **only when that source read that repository completely**: every eligible file was read
or refused by a documented rule (empty, binary, too large, symlink, invalid UTF-8). A read failure, a truncated GitHub
tree, a failed export read and a repository cut by `--max-repos` leave the pair out, and a repository one source read
completely is not covered for another: after ingesting Greptile documents, a run with `--source fs,greptile --max-repos 1`
covers the Greptile pair only of the first repository, while the local checkouts stay covered. An emptied collection or
checkout is covered with zero entries, so its rows are removed. A repository label that more than one folder under the
roots yields (`duplicate-label`, see Copy collections) is never covered, whatever the folders hold. `maxTier` is the tier of the scan, so a narrower scan
(`--tier 1` after a tier-2 ingest, `--max-repos`, a single `--source`, one `--root`) or a failed one never makes the
server forget what it did not cover. An empty `coverage` is valid: nothing is tombstoned and the entries are still planned
and ingested.

## Sources

### Filesystem

The default. Roots come from `--root` (repeatable) or `SUBSTRATE_CORPUS_ROOTS`.

### Greptile export

`--source greptile --greptile-dir DIR` reads a directory laid out as

```
<DIR>/<owner>/<repo>/<relative path>.md
```

one markdown file per knowledge-base document. Entries have `repo: owner/repo`, `kind: greptile-kb`, tier 2,
`source: greptile` and no commit, and follow the same size, symlink and UTF-8 rules. Files outside that layout and files
that are not `.md` are ignored. `--max-repos` reads the first repositories in name order; `--tier 1` reads none, because
every Greptile document is tier 2.

### GitHub

`--source github --github-owner OWNER` uses the `gh` CLI (no token is read by this code; `gh` holds its own login):

1. `gh repo list OWNER --json nameWithOwner,isArchived,defaultBranchRef -L 1000` lists the repositories. Archived ones, and
   ones the filesystem scan already read from a local clone, are skipped.
2. For the first `--max-repos` (default 50, in name order) the head commit of the default branch is resolved, then
   `gh api repos/<slug>/git/trees/<commit>?recursive=1` lists the tree.
3. Documentation paths that classify at or below the tier are fetched with `gh api repos/<slug>/git/blobs/<sha>`
   (base64), hashed over the decoded bytes, and checked by the same rules. Entries have `source: github` and the head
   commit. Blobs the size or symlink rules refuse are not fetched.

All `gh` calls run with bounded concurrency (4). A repository whose tree or blob cannot be fetched is reported as not
complete and in the skipped list; the scan goes on. Bodies fetched during a scan that will ingest are kept in a temporary
directory named by their hash, not in memory, and removed when the command ends.

## The routes

All four are audited and admitted like the docs tools and need a bearer of an operator surface. A server with the corpus
off answers 503 with `corpus.disabled`; the CLI prints that the server runs with the corpus off. 401 and 403 are reported
as refused credentials and a refused surface. A request that names another `protocol` is refused.

### `POST /corpus/plan`

Request: `{protocol, entries, scope}` where `entries` are the entries above without bodies and `scope` is
`{coverage: [{repo, source: "fs"|"github"|"greptile"}], maxTier: 1|2|3}` (at most 4,000 pairs; 20,000 entries).

A manifest row is identified by `(repo, path)`; its `source` column records which source produced it. An entry that
matches a row with the same sha256, source, kind and tier is `unchanged`; the same sha256 under a different source, kind
or tier is `update` (a manifest-only refresh, the docs plane is not touched); a different sha256 is `change`; no row is
`add`; a tombstone plus an add of one sha256 is `rename` when both are in one repository, or when the tombstone is in one `local/*` copy collection and the add is in another (a rename never crosses any other repository). A row with no matching entry is a
`tombstone` only when its pair is in `coverage` and its tier is at most `maxTier`.

Response: `{protocol, items, counts, manifestVersion}`. Each item is
`{action: "add"|"change"|"update"|"rename"|"tombstone", repo, path, sha256?, renamedFrom?, renamedFromRepo?}`; `renamedFrom` is the manifest
row the document moved from, and `renamedFromRepo` is that row's repository, present only when it differs from `repo`. `counts` has `add`, `change`, `update`, `rename`, `tombstone` and `unchanged` (unchanged rows
are counted and never listed). `manifestVersion` increases whenever the manifest changes.

### `POST /corpus/neardup`

Request: `{protocol, items, threshold?, maxPairs?}` where each item is `{repo, path, text}`. `repo` and `path` follow the
same name and path rules as an entry (a bad one is a 400 with its closed reason, such as `bad-repo` or `bad-path`). At
most 1,000 items (`too-many-items`); `text` is at most 4,000 characters (`text-too-long`; the CLI cuts its excerpt first),
and is a string (`bad-text`); a `(repo, path)` twice is `duplicate-entry`. `threshold` is a finite number from 0.5 to 1,
default 0.92 (`bad-threshold`; 1 means identical vectors); `maxPairs` is a whole number from 1 to 1,000, default 200
(`bad-max-pairs`). The route reads no manifest and needs no database.

Response: `{protocol, model, dimension, compared, pairs, truncated, skipped}`. `pairs` is
`[{a: {repo, path}, b: {repo, path}, similarity}]`, the most similar first, `a` before `b` in `(repo, path)` order and
`similarity` the cosine similarity rounded to four decimals; the answer does not depend on the order of the items.
`truncated` is true when more pairs than `maxPairs` matched. `compared` is the number of items that were embedded; an item
whose text is empty (or only white space) is not embedded and is listed in `skipped` as `{repo, path, reason: "empty"}`
(always present, at most 100 entries). `model` and `dimension` are those of the embedding service, null when no item had
text to embed. The body is capped at about 18.5 MB (a larger one is 413).

The texts are embedded only through the embedding service (`substrate.embeddings`, the TEI client behind the `emb` cache,
[embedding-fabric.md](embedding-fabric.md)). When it cannot answer the route is `503 corpus.embeddings-unavailable` with
one of the client's closed reasons in `detail`: `not-configured` (`TEI_URL` is unset), `breaker-open`, `timeout`,
`unavailable`, `bad-response`, `model-mismatch`, `dim-mismatch`, `input-refused`. Nothing else is said: no text, excerpt or
TEI URL appears in a reply, an audit record, an event or a log line, and the audit record (under `corpus_status`, op
`neardup`) holds the item count only.

### `POST /corpus/ingest`

Request: `{protocol, documents, tombstones}` where `documents` are entries plus `body` (the UTF-8 text) and `tombstones`
are `{repo, path}` rows to remove from the docs plane. `documents: []` with tombstones is a tombstone-only request. The CLI
sends the tombstones first, as requests of their own, then the document batches. Within one request the server removes the
tombstoned rows first, then inserts the documents, and only after all of them are recorded deletes the plane documents
that changed documents superseded; a plane document is deleted only when no active row still holds its id. Ingest
requests on one server are handled one at a time. An `update` document is sent like an add; when the stored sha256 equals
the sent one the server refreshes the row's source, kind, tier and commit without touching the plane and answers `updated`.

Response: `{protocol, results, counts, manifestVersion}`. Each result is
`{repo, path, status: "ingested"|"updated"|"unchanged"|"tombstoned"|"refused"|"failed", reason?, documentId?}`; `reason` is a closed
code such as `secret-findings` or `plane-unavailable`. `counts` has one number per status.

### `GET /corpus/status`

Response: `{protocol, total, active, tombstoned, byRepo, byKind, byTier, lastIngestAt, lagSeconds, manifestVersion}` with
`byRepo: [{repo, active, tombstoned}]`, `byKind: [{kind, count}]`, `byTier: [{tier, count}]`, `lastIngestAt` an ISO
time or null and `lagSeconds` the seconds since the newest manifest write, or null when the manifest is empty.

### `POST /corpus/reconcile`

Request: `{protocol, execute}`. Without `execute` it is a dry run. Response: `{protocol, drift, repaired, manifestVersion}`
with `drift: {missingInPlane: [{repo, path}], orphansInPlane: [name], checked, truncated}` (each list capped at 500; the
counts and `checked` cover everything, and `truncated` is true when a list was cut or the plane listing was not complete)
and `repaired: {requeued, deleted}` (both 0 on a dry run). With `execute` the server marks the active rows whose plane
document is gone as removed, without touching the plane, so the next plan offers them as `add`; and it deletes plane
documents named `corpus:` that no active row owns. The CLI never sends a document through this route.

## Limits

| Limit | Value |
| --- | --- |
| Documentation extensions | `.md`, `.mdx`, `.rst`, `.adoc` |
| File size (`--max-bytes`) | 1,000,000 bytes, decided from the size before the read |
| Default tier | 2 |
| Discovery depth below a root | 3 |
| GitHub repositories per scan (`--max-repos`) | 50 |
| GitHub repository listing (`-L`) | 1,000 |
| `gh` calls at once | 4 |
| Documents per ingest request | 20 by default (`SUBSTRATE_CORPUS_BATCH_DOCS`), at most 200 |
| Body bytes per ingest request | 1,000,000 (`SUBSTRATE_CORPUS_BATCH_BYTES`) |
| Tombstones per request | 500 |
| Request timeout of the CLI | 120 seconds |
| Skipped files listed in a report | 1,000 (the counts per reason are exact) |
| Identical-copy groups listed | 200 groups of 20 copies (the totals are exact) |
| Near-duplicate comparison (`nearDuplicates`) | every pair, so at most 5,000 items per call; it runs without pausing. `nearDuplicatesYielding` is the same comparison with the same result, pausing between blocks of about 2 million multiply-adds |
| Items per `POST /corpus/neardup` request | 1,000. The comparison is still O(n^2) in the item count (499,500 pairs at 1,000 items) but yields to other requests between blocks, so a large request takes longer without stalling the server |
| Characters of text per item | 4,000 |
| Pairs returned (`maxPairs`) | 200 by default, at most 1,000 |
| Pairs the CLI lists | 50 (the rest is a count) |

`nearDuplicates`, `nearDuplicatesYielding`, `cosine` and `normalize` in `@substrate/corpus` are pure vector helpers for
finding near-duplicate documents from embeddings; `POST /corpus/neardup` (through `nearDuplicatesYielding`) and
`substrate corpus plan --neardup` use them.

## Near-duplicates (advisory)

`substrate corpus plan --neardup` prints, after the plan, which documents it would write look like each other, so an
owner can see a pasted copy or a template before it is ingested. **The signal is advisory: no document is dropped,
skipped, tombstoned or changed because of it.** The plan, the coverage and every later ingest are the same with or without
it, and the section's first line says so.

The CLI takes the documents the plan would `add`, `update`, `change` or `rename` that come from a file it can read (the
filesystem and Greptile sources), in `(repo, path)` order and at most `--neardup-max` of them, reads the first 4,000
characters of each (UTF-8, a byte-order mark kept, an invalid sequence replaced) and sends **one** request. Only the
first 16,000 bytes of a file are read for that (a bounded prefix, never the whole file), and a character cut by that
boundary is dropped rather than decoded into a replacement. The scan refused symbolic links, and the excerpt is read after it,
so the reader opens the file without following a link (and without blocking on a pipe) and requires it to still be a regular
file of the size the scan recorded; a document that was swapped for a link or changed since the scan is counted as not
compared and its target is never read. (Where the platform has no `O_NOFOLLOW`, the regular-file and size checks still apply.) Documents from GitHub are not read by a plan, so they are counted ("N documents from
GitHub were not compared"); a file that cannot be read is counted as not compared and never fails the command; when more
candidates exist than the limit the output says "compared the first N of M documents".

```
near-duplicates (advisory: no document is dropped on this signal)
  0.9731  Acme/Alpha:docs/guide.md  ~  Acme/Beta:docs/guide.md
  ... and 3 more
model: <model id>, dimension: <dimension>
compared: 120 documents, skipped (empty text): 0
```

At most 50 pairs are listed and every name is printed with its control characters escaped. An empty candidate list prints
`near-duplicates: nothing to compare` and exits 0. With `--json` the plan's JSON gets one more key, `neardup`, holding the
server's reply plus `notCompared: {github, unreadable, overLimit}` (or `{error}` when the comparison could not run);
without `--neardup` the JSON is unchanged.

When the comparison cannot run (the embedding service is unavailable, the server refused the request, a transport error)
the plan is still printed, one line on stderr names the closed reason (for example `timeout` or `not-configured`), and the
exit code is 1: a comparison that was asked for and could not be answered must not look like success.

**Egress.** The CLI sends the excerpts to the substrate server over its usual connection, and the server sends them to the
configured `TEI_URL` and nowhere else. The fabric compliance check reports a failure when that endpoint is neither loopback
nor an allowed proxy, but it does not block a request: `SUBSTRATE_DB_ENDPOINT_POLICY` defaults to `warn`, which accepts a
direct (possibly public) `TEI_URL`. Point `TEI_URL` at a private endpoint and set the policy to `enforce` so that startup
refuses a direct one. With `TEI_URL` unset the route answers `503 corpus.embeddings-unavailable` (`not-configured`) and
nothing is sent anywhere.
