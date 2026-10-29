# Runbook: corpus ingest (v1.7 phase 63)

The corpus atlas puts the documentation of every repository the owner keeps into the docs plane in bulk, records what it put there in one manifest, and removes what disappeared. This page is for the operator who turns it on, runs it and reads its answers. The design is in `docs/docs-plane.md` (the `corpus` dataset and its citations) and `docs/data-planes.md` (the manifest table); the scan itself is the CLI's (`substrate corpus scan`).

Nothing here runs by itself. The server only answers requests, and it answers none of them until `SUBSTRATE_CORPUS=on`.

## The shape of it

1. `substrate corpus scan` reads the roots on the machine that has the files and prints entries: repo, path, kind, tier, sha256, size, source, commit. It talks to nothing.
2. `substrate corpus plan` sends those entries, without bodies, to `POST /corpus/plan` and prints how many documents the server would add, change, rename or tombstone. It changes nothing.
3. `substrate corpus ingest` is a dry run until `--execute`. With it, the CLI sends the bodies of the documents that must change to `POST /corpus/ingest`, in requests of at most 200 documents and 500 tombstones, and the server puts them into LightRAG in batches.
4. `substrate corpus status` (`GET /corpus/status`, the `corpus_status` tool) reads the manifest's counts.

The same server doors are the MCP tools `corpus_status` (read, fail-open audit) and `corpus_ingest` (write, fail-closed audit). The CLI never talks to LightRAG: only the server does.

## Turn it on

| Variable | Read by | Default | Meaning |
| --- | --- | --- | --- |
| `SUBSTRATE_CORPUS` | server | `off` | `on` opens the three routes and the two tools. Anything else keeps them closed. |
| `SUBSTRATE_CORPUS_ROOTS` | CLI | `/root/src/repos` | Colon separated directories `substrate corpus scan` reads when no `--root` is given. |
| `SUBSTRATE_CORPUS_CONCURRENCY` | server and CLI | `4` | Batches in flight at once, 1 to 16. |
| `SUBSTRATE_CORPUS_BATCH_DOCS` | server and CLI | `20` | Documents per batch, 1 to 200. |
| `SUBSTRATE_CORPUS_BATCH_BYTES` | server and CLI | `1000000` | Bytes per batch, 10000 to 5000000. A document larger than this goes alone. |

A value out of range is clamped into range; a value that is not a whole number is the default. Set the three server values in the unit's environment file and restart. Prerequisites the server checks on every request: the docs backend is LightRAG and configured (`LIGHTRAG_URL`), and the index (Postgres, `SUBSTRATE_PG_URL`) is up with migration step 35 applied (`corpus_documents`; rehearse it on a restored dump first, as for every step in `docs/runbooks/rollback-compat.md`).

With the flag off, every route answers `503` with `reason: "corpus.disabled"` and nothing is read from the manifest or sent to a plane. That is also the state to return to if something goes wrong: set `SUBSTRATE_CORPUS` to anything but `on` and restart. Documents already in the plane stay and stay searchable; only the doors close.

Authentication: every corpus request needs an authenticated surface (`401` without one) and refuses a VM guest (`403`). The body cap is the docs routes' 6,000,000 bytes (`413`).

## First run

```
substrate corpus scan --root /srv/repos            # look at what it finds; nothing leaves the machine
substrate corpus plan --root /srv/repos --tier 2   # counts: add, change, rename, tombstone, unchanged
substrate corpus ingest --root /srv/repos --tier 2             # dry run: prints what it would send
substrate corpus ingest --root /srv/repos --tier 2 --execute   # sends
substrate corpus status
```

Start with the default tiers (tier 2 and below is the default; tier 3 is the bulk and historical material) and one root, read the plan, then widen. On the first run every entry is an `add`. The ingest of a few thousand documents takes a while because each document is parsed by LightRAG; the pipeline wait is once per batch, not once per document.

Read the reply of `ingest --execute`: one result per document and tombstone with a status of `ingested`, `unchanged`, `tombstoned`, `refused` or `failed`, a closed reason for the last two, the counts, and `manifestVersion`. A run that ends with `failed` items is not an error to fix by hand: run it again and only those items are sent.

## Reading status

`GET /corpus/status` answers the totals (`active`, `tombstoned`), the counts by repository, kind and tier (active documents), `lastIngestAt` and `manifestVersion`. The version is the highest `manifest_seq` in the table and only grows; a plan made against an older version is still valid, only less fresh. For a single document, ask the database: `select repo, path, state, sha256, docs_document_id from corpus_documents where repo = '<owner/name>' and path = '<path>'`.

Each ingest request leaves one `note` event (`payload.action: "docs.corpus.ingest"`, counts, `batches`, `orphaned_documents`, `manifest_version`) and one `warning` per refusal reason (`docs.corpus.refused`, the reason, a count and, for `secret-findings`, the rule names). No event carries a document body or a matched secret.

## What a tombstone does, and how to undo one

A document is tombstoned when a plan says so: its row is active, its repository was scanned completely, its tier is within the plan's `maxTier`, its source is among the plan's sources, and the scan did not report it. The server then deletes its plane document (only when no other active row shares that plane document: identical text under two names is one plane document), and marks the row `tombstoned`. The row stays, with `tombstoned_at`, so the history is visible.

A narrower scan never tombstones what it did not cover. These leave the earlier documents untouched, and the plan's counts show it: a `--tier` lower than before, `--max-repos`, `--source`, one `--root` of several, a repository that failed to read, a truncated tree.

A rename (same sha256, same repo, new path) is planned as one `rename`; the CLI sends the document at its new path and a tombstone for the old one. The server runs the tombstones first, so the plane stores the text again under its new name and a search citation names the new path.

To undo a tombstone, restore the file (or fix the scan that missed it) and run the ingest again. The key reappears, the row is an `add` again, a new plane document is made, and the row returns to `active`. Nothing else is needed: the old plane document is gone and is not brought back.

## Stop and resume

Stopping is safe at any moment: stop the CLI, or restart the server. Every document the server finished is already in the manifest (the row is written after LightRAG accepted the document and before the old version of it is deleted), so the next run reports it `unchanged` and sends nothing for it. A killed run resumes with only the documents it had not recorded.

One case needs no action but is worth knowing. If the server dies after LightRAG accepted a document and before the row was written, the plane holds a document the manifest does not know. The next run gets a same-name conflict from LightRAG; the server then clears that stray document, writes it again once and records the row. A conflict that does not clear reports `failed` with `conflict`.

If a superseded plane document could not be deleted (the plane was down at that moment), it stays on the plane unreferenced, the document itself is still `ingested`, and the request's note event counts it in `orphaned_documents`. It is old text of a document that has a newer version; delete it by id through LightRAG if it matters.

A lost manifest (the table dropped, a new database) is rebuilt by running the ingest again: every document is a `conflict` against what the plane still holds, is cleared and written once, so it costs a full re-parse. Plan first and widen slowly.

## Reasons you will see

Whole request, `4xx` or `5xx` with `reason` and a sentence in `error`:

| Status | `reason` | Meaning |
| --- | --- | --- |
| 401 | `unauthenticated` | The caller has no authenticated surface. |
| 403 | `vm-guest` | The server is a VM guest. |
| 503 | `corpus.disabled` | `SUBSTRATE_CORPUS` is not `on`. |
| 503 | `corpus.backend-unavailable` | The docs backend is not a configured LightRAG. Nothing was sent. |
| 503 | `corpus.index-unavailable` | There is no index, or it did not answer. |
| 400 | `bad-request`, `bad-protocol`, `too-many-entries`, `too-many-documents`, `too-many-tombstones`, `empty-request`, `empty-scope`, `bad-scope`, `bad-repo`, `bad-path`, `bad-kind`, `bad-tier`, `bad-sha256`, `bad-bytes`, `bad-source`, `bad-commit`, `bad-body`, `duplicate-entry` | The request is malformed; nothing in it was read further or sent. A plan holds at most 20000 entries and names at least one repo and one source. An ingest holds at most 200 documents and 500 tombstones. |
| 413 | | The body is over 6,000,000 bytes. |

One document, status `refused` (never sent, never recorded; fix the file, then run again):

| `reason` | Meaning |
| --- | --- |
| `too-large` | The body is over 1,000,000 bytes. |
| `empty-document` | The body is empty after remote images are stripped. |
| `sha-mismatch` | The body does not hash to the entry's sha256 (the file changed or is not valid UTF-8 between the scan and the send). Scan again. |
| `unsafe-name` | The plane would alter or refuse the document name built from the repo and path (a parser hint such as `.[docling].md`, or an edge space). Rename the file. |
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
| `delete-failed` | A tombstone's plane document could not be deleted. The row stays `active`, so the retry deletes it again. |

## Related

- `docs/docs-plane.md` — the `corpus` dataset, document names, citations.
- `docs/data-planes.md` — the `corpus_documents` table.
- `docs/runbooks/rollback-compat.md` — migration step 35 and its `down`.
- `docs/event-vocabulary.md` — `docs.corpus.ingest` and `docs.corpus.refused`.
- `docs/mcp-audit.md` — the audit mode of `corpus_ingest` and `corpus_status`.
