---
phase: 63-corpus-atlas
milestone: v1.7
requirements: [ATLAS-01, ATLAS-02, ATLAS-03, ATLAS-04, ATLAS-05, ATLAS-06]
status: merged to main in PR #177 (squash a1d6e8f7, with the audit in PR #175); partial (see Deviations); no live ingest, no deploy, no Greptile export directory ingested
---

# 63-SUMMARY: Corpus Atlas, the documentation of every repository in one manifest

Built in one orchestrated wave of edit-only units (no gsd-plan-phase run). Decisions and evidence are in [63-CONTEXT.md](63-CONTEXT.md); the milestone audit and capability matrix are in `.planning/phases/63-corpus-atlas/audit/`. Operator pages: [docs/corpus.md](../../../../docs/corpus.md) and [docs/runbooks/corpus-ingest.md](../../../../docs/runbooks/corpus-ingest.md).

## What was built

- **`packages/corpus` (`@substrate/corpus`, pure, no network).** `protocol.ts` holds the wire contract (`CORPUS_PROTOCOL = 1`, the closed `DOC_KINDS`, `DOC_TIERS`, `CORPUS_SOURCES`, `PLAN_ACTIONS`, the request and response shapes, the per-request bounds `MAX_PLAN_ENTRIES`, `MAX_COVERAGE_PAIRS`, `MAX_INGEST_DOCUMENTS`, `MAX_INGEST_TOMBSTONES`, and the manifest key and source URL helpers). `classify.ts` decides kind and tier from the path alone and applies the extension and excluded-directory rules. `discover.ts` finds checkouts and copy collections, collapses linked worktrees and clones of one origin to one canonical checkout, and labels a directory with no origin. `scan.ts` (`scanRoots`, `inspectBytes`, `loadDocument`, `buildScope`) reads and hashes files, refuses over-size, empty, binary, non-UTF-8, symlinked and unreadable ones with a closed reason, collapses byte-identical copies into a bounded report, and builds the scope from the pairs read completely. `names.ts` is the one rule module the CLI and the server share (repository label, path, plane-safe document name, size bound, remote-image stripping, `documentRefusal`, `localRepoId`).
- **Source adapters.** `adapters/greptile-export.ts` reads a directory laid out `<owner>/<repo>/<path>.md` as tier-2 `greptile-kb` entries; `adapters/github.ts` reads repositories through the `gh` CLI (default-branch tree, blobs fetched at most 4 at once), skipping repositories already read from a local clone.
- **CLI `substrate corpus` (`packages/cli/src/corpus`).** `scan` (no server), `plan`, `ingest` (a dry run until `--execute`) and `status`. `index.ts` parses flags and runs the commands; `inventory.ts` merges the sources into one entry list and the coverage; `client.ts` calls the routes; `ingest.ts` sends tombstones first as their own request, then document batches; `bodies.ts` keeps GitHub bodies in a hash-named temporary directory; `render.ts` prints reports with every control character escaped.
- **Server, `packages/mcp-server/src/corpus`.** `plan.ts` (`planCorpus`, pure), `ingest.ts` (`ingestCorpus`, `corpusGate`; phases tombstones, inserts, superseded deletes under one `AsyncMutex` from `mutex.ts`), `validate.ts` (request parsing with closed reasons), `store.ts` (`CorpusStore`, the `corpus_documents` reads and writes), `service.ts` (the entry the routes and tools call), `names.ts`. Settings come from `loadCorpusSettings` in `config.ts`.
- **LightRAG bulk plane, `packages/mcp-server/src/planes/lightrag-bulk.ts`.** `insertBatch` sends `POST /documents/texts` with `{texts, file_sources}`, one pipeline wait per batch, 409 and 413 handling; `deleteDocuments` calls `DELETE /documents/delete_document` and reports a deletion the pipeline never confirmed as failed. The v1.5.7 route fixture `planes/__fixtures__/lightrag-v1.5.7-routes.json` gained the `texts` route.
- **Migration step 35 `corpus_documents`** in `packages/mcp-server/src/index-store.ts` (`expand`, `down` drops the table, three indexes, `manifest_seq` identity column as the manifest version), its digest in `index-store.migrations.digests.json`, `STEPS_ADDED_SINCE_REFERENCE` in `rollback-compat.test.ts`, and a row in `docs/runbooks/rollback-compat.md`.
- **Doors.** `POST /corpus/plan`, `POST /corpus/ingest`, `GET /corpus/status` (`server.ts`, classes in `admission.ts` `ROUTE_CLASSES`); MCP tools `corpus_status` and `corpus_ingest` (`mcp.ts`; `FAIL_OPEN_TOOLS` and `FAIL_CLOSED_TOOLS` in `packages/audit/src/policy.ts`; `TOOL_CLASSES`; `KNOWN_TOOLS` in `observe.ts`). Dataset `corpus` in `DATASET_TRIGGERS` and `DEFAULT_SEARCH_DATASET_NAMES`; `docs_search` citations of a corpus document carry `repo`, `path` and `dataset`. Events `docs.corpus.ingest` and `docs.corpus.refused` in `event-sources.ts` (no new event kind). Flags `SUBSTRATE_CORPUS`, `SUBSTRATE_CORPUS_ROOTS`, `SUBSTRATE_CORPUS_CONCURRENCY`, `SUBSTRATE_CORPUS_BATCH_DOCS`, `SUBSTRATE_CORPUS_BATCH_BYTES` in `flag-registry.ts`.

## Key decisions

- **D63-1, manifest in Postgres, held.** One row per `(repo, path)`, never deleted: a removal is the state `tombstoned`.
- **D63-2, one dataset `corpus`, held.** The repository travels in the plane document name, not in a per-repository workspace.
- **D63-3, bulk through `POST /documents/texts`, held.** The fixture entry was derived from the upstream v1.5.7 source, not from a running LightRAG.
- **D63-4, discovery in the CLI, held.** The server never reads a path it is given; it gets entries and, for documents that must change, bodies.
- **D63-5, tiers, held.** Default scan is tier 2 and below; `--tier 3` is opt-in.
- **D63-6, canonical checkout, held;** identical-copy collapse is bounded and reported.
- **D63-7, rename by sha, held,** with a changed shape (below): the plane document is deleted before the same text is inserted under its new name.
- **Changed in review: the scope.** The ROADMAP scope `{repos, maxTier, sources}` became `{coverage: [{repo, source}], maxTier}`, one pair per (repository, source) a scan read completely. Why: a repository read from disk was being treated as read for every requested source, so an unread Greptile export lost its rows.
- **Changed in review: plan action `update`.** The same sha256 under another source, kind or tier refreshes the manifest row without a plane upload; otherwise a stale `source` hid the row from a filesystem-only removal.
- **Changed in review: one lock, three phases.** Tombstones, inserts and superseded deletes run as separate phases under one single-flight lock, and a row is tombstoned only after the plane confirmed the deletion.

## Deviations from the plan

- **Scope shape** is `{coverage, maxTier}`, not `{repos, maxTier, sources}` (`packages/corpus/src/protocol.ts`, `CorpusScope`); `--tier` sets `maxTier`.
- **Criterion 1, rename.** The scan makes the next copy canonical when the canonical one disappears, but the planner matches a rename only inside one repository. Moving the kept copy from one `local/*` repository to another is an `add` plus, when the old repository is covered, a `tombstone`, not a `rename` (`docs/corpus.md`, "Identical copies"; test `"a rename never crosses repositories"`).
- **Criterion 3, archive.** Step 35 is not in the index archive's closed table list (`index-archive-spec.ts`); `index-store.migrate-contract.test.ts` allowlists it with the reason that the manifest is rebuilt by re-running scan and ingest. No restore test exists for it. `corpus_ingest` is gated on an authenticated, non-VM-guest surface (`corpusGate`), not on an operator surface.
- **Criterion 4, provenance.** The plane port carries `{name, text}` only. The plane document name carries repo, path and the first 12 hex of the sha256 (`corpus:owner%2Fname:docs%2Fa.md@<sha12>`, `/` and `%` percent-encoded because the plane refuses a `/`); kind, tier and commit live in the manifest. A body that trips the secret scan is refused, not rewritten; only remote images are stripped.
- Commands are `scan`, `plan`, `ingest`, `status`; no flag named in the ROADMAP is missing. Added beyond the ROADMAP: the `SUBSTRATE_CORPUS` toggle (default off, every route answers 503 `corpus.disabled`), 401 for anonymous callers, and tombstones sent before documents.
- A same-name 409 left by a crash is resolved by deleting the document by its derived id and rewriting it once; a plane document shared with another active row is adopted, not deleted.

## Findings

Greptile found 16 inline issues on PR #177 (12 P1, 4 P2); its last summary counts six reviews. The fix commits are labelled review rounds 1 to 4, plus one CI fix. By theme:

- **Absence of evidence (P1).** An unread export lost its rows; a scan with an empty folder or an emptied collection kept old documents; an empty or invalid-label folder blocked the whole plan; an empty folder shadowed a live one of the same label; an invalid path removed before the collapse hid a valid identical copy.
- **Deletes (P1).** Shared plane documents could vanish between the reference count and the delete; a failed or unconfirmed background delete was reported complete; a rename could delete the old copy before the new name passed the server's checks. Fixed by the phases and lock, confirmed deletes, and shared validation in `names.ts`.
- **Renames and updates (P1).** The CLI sent renames without the tombstone, so the plane linked the new name to the old document; a changed source was forgotten (the `update` action).
- **Exit codes (P1).** A skipped path and a refused document did not make the command exit non-zero.
- **CI.** Commit 48afdbdf: the migration harness expected the opt-in steps 33 and 34 to be last; with step 35 present it compares the opt-in list in version order.
- **P2.** A byte-order mark broke the hash of a valid UTF-8 file; a large batch size was refused whole; `docs/corpus.md` promised a rename when the kept copy moves between collections, which the planner does not do (the page now says add plus tombstone); a file name with a terminal escape sequence altered the output (control characters now print as escapes).

## What remains

- A live ingest of the real corpus, a deploy of the server with `SUBSTRATE_CORPUS=on` and a LightRAG backend, and an ingest of a real Greptile knowledge-base export directory were not run (operator-gated). The `<owner>/<repo>/<path>.md` layout is what the code reads; it is unconfirmed against a real export.
- The manifest is not in the index archive: after a lost database it is rebuilt by a full ingest, which re-parses every document.
- The single-flight lock is per server process; two server processes would not exclude each other.
- Phases 64 to 66, 69 and 70 build on this manifest.
