# Runbook: corpus ingest (v1.7 phase 63)

The corpus atlas puts the documentation of every repository the owner keeps into the docs plane in bulk, records what it put there in one manifest, and removes what disappeared. This page is for the operator who turns it on, runs it and reads its answers. The design is in `docs/docs-plane.md` (the `corpus` dataset and its citations) and `docs/data-planes.md` (the manifest table); the scan itself is the CLI's (`substrate corpus scan`).

Nothing here runs by itself. The server only answers requests, and it answers none of them until `SUBSTRATE_CORPUS=on`.

## The shape of it

1. `substrate corpus scan` reads the roots on the machine that has the files and prints entries: repo, path, kind, tier, sha256, size, source, commit. It talks to nothing.
2. `substrate corpus plan` sends those entries, without bodies, to `POST /corpus/plan` together with the coverage (the (repository, source) pairs the scan read completely) and prints how many documents the server would add, change, update, rename or tombstone. It changes nothing.
3. `substrate corpus ingest` is a dry run until `--execute`. With it, the CLI sends the tombstones first, as their own request, and then the bodies of the documents that must be added, changed or updated to `POST /corpus/ingest`, in requests of at most 200 documents and 500 tombstones, and the server puts them into LightRAG in batches.
4. `substrate corpus status` (`GET /corpus/status`, the `corpus_status` tool) reads the manifest's counts.
5. `substrate corpus plan --neardup` (optional, advisory) also sends the first 4,000 characters of each local document the plan would write to `POST /corpus/neardup` and prints the pairs that look alike. It needs `TEI_URL` on the server (see `docs/embedding-fabric.md`); without it the command prints the plan, writes `not-configured` to stderr and exits 1. No document is dropped, skipped or changed on that signal, and the excerpts go only to the operator's TEI service. Details and limits are in `docs/corpus.md`.

The same server doors are the MCP tools `corpus_status` (read, fail-open audit) and `corpus_ingest` (write, fail-closed audit). The CLI never talks to LightRAG: only the server does.

## Turn it on

| Variable | Read by | Default | Meaning |
| --- | --- | --- | --- |
| `SUBSTRATE_CORPUS` | server | `off` | `on` opens the four routes and the two tools. Anything else keeps them closed. |
| `SUBSTRATE_CORPUS_ROOTS` | CLI | `/root/src/repos` | Colon separated directories `substrate corpus scan` reads when no `--root` is given. |
| `SUBSTRATE_CORPUS_CONCURRENCY` | server and CLI | `4` | Batches in flight at once, 1 to 16. |
| `SUBSTRATE_CORPUS_BATCH_DOCS` | server and CLI | `20` | Documents per batch, 1 to 200. |
| `SUBSTRATE_CORPUS_BATCH_BYTES` | server and CLI | `1000000` | Bytes per batch, 10000 to 5000000. A document larger than this goes alone. |

A value out of range is clamped into range; a value that is not a whole number is the default. Set the three server values in the unit's environment file and restart. Prerequisites the server checks on every request: the docs backend is LightRAG and configured (`LIGHTRAG_URL`), and the index (Postgres, `SUBSTRATE_PG_URL`) is up with migration step 35 applied (`corpus_documents`; rehearse it on a restored dump first, as for every step in `docs/runbooks/rollback-compat.md`).

With the flag off, every route answers `503` with `reason: "corpus.disabled"` and nothing is read from the manifest or sent to a plane. That is also the state to return to if something goes wrong: set `SUBSTRATE_CORPUS` to anything but `on` and restart. Documents already in the plane stay and stay searchable; only the doors close.

Authentication: every corpus request needs an authenticated surface (`401` without one) and refuses a VM guest (`403`). The body cap is the docs routes' 6,000,000 bytes (`413`); `POST /corpus/neardup` has its own cap of 18,500,000 bytes, which 1,000 excerpts of 4,000 characters fit in.

## First run

```
substrate corpus scan --root /srv/repos            # look at what it finds; nothing leaves the machine
substrate corpus plan --root /srv/repos --tier 2   # counts: add, change, update, rename, tombstone, unchanged
substrate corpus ingest --root /srv/repos --tier 2             # dry run: prints what it would send
substrate corpus ingest --root /srv/repos --tier 2 --execute   # sends
substrate corpus status
```

Start with the default tiers (tier 2 and below is the default; tier 3 is the bulk and historical material) and one root, read the plan, then widen. On the first run every entry is an `add`. The ingest of a few thousand documents takes a while because each document is parsed by LightRAG; the pipeline wait is once per batch, not once per document.

Read the reply of `ingest --execute`: one result per document and tombstone with a status of `ingested`, `updated` (the manifest row was refreshed, LightRAG was not touched), `unchanged`, `tombstoned`, `refused` or `failed`, a closed reason for the last two, the counts, and `manifestVersion`. The command exits 0 only when every item ended `ingested`, `updated`, `unchanged` or `tombstoned`; any `refused` or `failed` item (or a request that failed as a whole) makes it exit 1, and the summary lists each with its reason. A run that ends with `failed` items is not an error to fix by hand: run it again and only those items are sent.

## Reading status

`GET /corpus/status` answers the totals (`active`, `tombstoned`), the counts by repository, kind and tier (active documents), `lastIngestAt` and `manifestVersion`. The version is the highest `manifest_seq` in the table and only grows; a plan made against an older version is still valid, only less fresh. For a single document, ask the database: `select repo, path, state, sha256, docs_document_id from corpus_documents where repo = '<owner/name>' and path = '<path>'`.

Each ingest request leaves one `note` event (`payload.action: "docs.corpus.ingest"`, counts, `batches`, `orphaned_documents`, `manifest_version`) and one `warning` per refusal reason (`docs.corpus.refused`, the reason, a count and, for `secret-findings`, the rule names). No event carries a document body or a matched secret.

## What a tombstone does, and how to undo one

A document is tombstoned when a plan says so: its row is active, the scan did not report it, the pair (its repository, its `source`) is in the plan's coverage, and its tier is within the plan's `maxTier`. The coverage lists a (repository, source) pair only when that source read that repository completely: every eligible file was read, or refused by a documented rule (empty, binary, too large). An unreadable file, a truncated GitHub tree, a failed export read and the `--max-repos` cap leave the pair out. A readable collection directory with no documents left (an emptied collection or checkout) is covered with zero entries, so its rows are tombstoned. The server then deletes the document's plane copy (only when no other active row shares that plane document: identical text under two names is one plane document) and, once the deletion is confirmed, marks the row `tombstoned`. The row stays, with `tombstoned_at`, so the history is visible.

A narrower scan never tombstones what it did not cover. These leave the earlier documents untouched, and the plan's counts show it: a `--tier` lower than before, `--max-repos`, `--source`, one `--root` of several, a repository that failed to read, a truncated tree. A scan with an empty coverage still plans and ingests its readable entries; it only tombstones nothing.

A manifest row is identified by `(repo, path)`; its `source` column records which source produced it. The same bytes read again from another source, or classified under another kind or tier, are an `update`: the CLI sends the document like an add, the server finds the stored sha256 equal, refreshes `source`, `kind`, `tier` and `commit` in the manifest and answers `updated`, and LightRAG is not touched. This keeps the stored source current, so a document first read from GitHub and later from a local clone can be removed by a filesystem-only scan.

A rename (same sha256, same repo, new path) is planned as one `rename`; the CLI sends the tombstone for the old path first and the document at its new path after it. Because the old plane document is deleted before the text is inserted again, the plane stores the text under its new name and a search citation names the new path. The old row is removed only when the new document passes every check the server applies (a safe name and path, the size bound, a non-empty body, the planned hash): a rename to `docs/x.[docling].md` leaves the old row active and reports the new path `refused` with `unsafe-name`. If the new document passes and the plane then fails, the old copy is already gone and the next run plans the new path as an `add`.

## Stop and resume

Stopping is safe at any moment: stop the CLI, or restart the server. Every document the server finished is already in the manifest (the row is written after LightRAG accepted the document, and the document it replaced is deleted only afterwards), so the next run reports it `unchanged` and sends nothing for it. A killed run resumes with only the documents it had not recorded.

One case needs no action but is worth knowing. If the server dies after LightRAG accepted a document and before the row was written, the plane holds a document the manifest does not know. The next run gets a same-name conflict from LightRAG; the server then clears that stray document, writes it again once and records the row. A conflict that does not clear reports `failed` with `conflict`.

If a superseded plane document could not be deleted (the plane was down at that moment), it stays on the plane unreferenced, the document itself is still `ingested`, and the request's note event counts it in `orphaned_documents`. It is old text of a document that has a newer version; delete it by id through LightRAG if it matters. A crash between phase I and phase S (next section) leaves the same kind of orphan, never a row that points at a deleted document.

A lost manifest (the table dropped, a new database) is rebuilt by running the ingest again: every document is a `conflict` against what the plane still holds, is cleared and written once, so it costs a full re-parse. Plan first and widen slowly.

## Order of work inside a request

The server serialises ingest requests: one runs at a time per server process (single flight), and it holds the lock across the whole request, plane deletes included. Inside a request the work has three phases, so a deletion never overlaps an insert that could be handed the document being deleted (LightRAG answers identical text under another name with the existing document's id):

1. **T, tombstones.** For each row the plane document is deleted first, unless another active row that stays shares it; the row is marked `tombstoned` only after the deletion is confirmed (the pipeline went idle). A deletion that fails or is not confirmed leaves the row `active` and answers `failed` with `delete-failed`; the next plan lists it again.
2. **I, inserts and replacements.** Batches may run concurrently (`SUBSTRATE_CORPUS_CONCURRENCY`). Each row is written after the plane accepted its document. Nothing is deleted in this phase; a same-name leftover (the `conflict` case below) is cleared and rewritten one document at a time after every batch has recorded.
3. **S, superseded documents.** Only after every row of the request is recorded, the plane documents that changed documents replaced are deleted, and only when no active row holds their id.

The CLI sends the tombstones first, as their own request (`documents: []`), and only then the document batches, so a rename deletes the old plane document before the same text is inserted under the new name.

## Reasons you will see

Whole request, `4xx` or `5xx` with `reason` and a sentence in `error`:

| Status | `reason` | Meaning |
| --- | --- | --- |
| 401 | `unauthenticated` | The caller has no authenticated surface. |
| 403 | `vm-guest` | The server is a VM guest. |
| 403 | `tombstone-out-of-scope` | A tombstone names a row outside the request's `scope`: its `(repo, source)` pair is not in `coverage`, or its tier is above `maxTier`. Nothing was removed. |
| 503 | `corpus.disabled` | `SUBSTRATE_CORPUS` is not `on`. |
| 503 | `corpus.backend-unavailable` | The docs backend is not a configured LightRAG. Nothing was sent. |
| 503 | `corpus.index-unavailable` | There is no index, or it did not answer. |
| 400 | `bad-request`, `bad-protocol`, `too-many-entries`, `too-many-documents`, `too-many-tombstones`, `empty-request`, `tombstone-scope-required`, `bad-scope`, `bad-repo`, `bad-path`, `bad-kind`, `bad-tier`, `bad-sha256`, `bad-bytes`, `bad-source`, `bad-commit`, `bad-body`, `duplicate-entry` | The request is malformed; nothing in it was read further or sent. A plan holds at most 20000 entries and at most 4000 coverage pairs (an empty coverage is valid: the entries are planned and nothing is tombstoned). An ingest holds at most 200 documents and 500 tombstones; it may hold tombstones only (`documents: []`), but not nothing at all (`empty-request`). A request with tombstones must carry `scope` (`{coverage, maxTier}`); without it the reason is `tombstone-scope-required`. |
| 413 | | The body is over 6,000,000 bytes. |

One document, status `refused` (never sent, never recorded; fix the file, then run again):

| `reason` | Meaning |
| --- | --- |
| `too-large` | The body is over 1,000,000 bytes. |
| `empty-document` | The body is empty after remote images are stripped. |
| `sha-mismatch` | The body does not hash to the entry's sha256 (the file changed or is not valid UTF-8 between the scan and the send). Scan again. |
| `unsafe-name` | The plane would alter or refuse the document name built from the repo and path (a parser hint such as `.[docling].md`, or an edge space). Rename the file. |
| `bad-path` | The path is not in normal form (a backslash, a control character, an empty or `..` segment, or over 1,024 characters). The CLI refuses it before sending, because the server would refuse the whole request. Rename the file. |
| `bad-repo` | The repository label is not `owner/name` or `local/<label>`. The CLI refuses it before sending. |
| `secret-findings` | The redactor found a secret-shaped string. The event names the rule, never the text. Remove the secret from the file. |

One document or tombstone, status `failed` (the plane or the manifest failed; run again and only these are sent):

| `reason` | Meaning |
| --- | --- |
| `plane-unavailable` | LightRAG did not answer, or its breaker is open, or it answered something this client does not understand. |
| `timeout` | The plane or the request ran out of time. |
| `rejected` | LightRAG refused the document (its own validation). |
| `conflict` | A same-name document exists and could not be cleared. |
| `pipeline-failed` | LightRAG accepted the document and failed to process it. |
| `duplicate-content` | The text is a duplicate of a document that itself failed. |
| `manifest-unavailable` | The manifest did not answer. The plane may hold the document; the next run repairs it as above. |
| `delete-failed` | A tombstone's plane document could not be deleted, or the plane started the deletion and did not confirm it (a timeout, a failed poll, a fenced plane). The row stays `active`, so the retry plans it and deletes it again. |

## Related

- `docs/docs-plane.md` — the `corpus` dataset, document names, citations.
- `docs/data-planes.md` — the `corpus_documents` table.
- `docs/runbooks/rollback-compat.md` — migration step 35 and its `down`.
- `docs/event-vocabulary.md` — `docs.corpus.ingest` and `docs.corpus.refused`.
- `docs/mcp-audit.md` — the audit mode of `corpus_ingest` and `corpus_status`.
