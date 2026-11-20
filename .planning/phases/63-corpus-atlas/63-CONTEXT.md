# Phase 63: Corpus Atlas - Context

**Gathered:** 2026-10-29 (Run 14)
**Status:** Decisions fixed by the orchestrator from the Run 14 scout evidence; the owner's request is in `.planning/STATE.md` (Run 14).

## Phase boundary
Discover, classify, de-duplicate and record the documentation of every repository the owner keeps, and put new and changed documents into the docs plane in bulk with provenance and deletes. It does not decide what the RAG ranks first (phase 66), does not watch for changes (phase 65) and does not change LightRAG's embedding (locked to its data, `docs/runbooks/lightrag-storage-topology.md:141-150`).

## Decisions
- **D63-1:** the manifest lives in Postgres (`corpus_documents`, its own migration step, numbered when it merges), not in a state file. The docs ingest state is a per-dataset JSON file (`SUBSTRATE_DOCS_STATE_FILE`, `docs-ingest.ts:483-492`) and the planning refresh keeps `planningHashes` in memory, which is null at start, so every restart re-ingests everything (`service.ts:5641-5733`).
- **D63-2:** one docs dataset `corpus`. LightRAG has one workspace and ignores dataset scope on the wire (`docs-search.ts` ~1020-1025), so `dataset` is a record-key label and the repository travels in the document source.
- **D63-3:** bulk goes through `POST /documents/texts` (LightRAG v1.5.7 `document_routes.py:5585`, `InsertTextsRequest` :865, `texts` and `file_sources` lists). The client today uploads, scans, polls the pipeline and reads the track status per page, serially (`planes/lightrag.ts:533-578`, `:655-800`); thousands of pages would take days at the write budget of 10 requests per second. The route fixture (`planes/__fixtures__/lightrag-v1.5.7-routes.json`) lists eight routes and not `/documents/texts`, so the unit adds it from the upstream source.
- **D63-4:** discovery runs in the CLI, where the files are; the server never reads a path it is given. It receives entries for planning and bodies only for the documents that must change.
- **D63-5:** tiers. Tier 1: README, `docs/**`, ADRs, runbooks, `AGENTS.md`, changelogs, and the planning state documents (STATE, ROADMAP, PROJECT, REQUIREMENTS, MILESTONES, RETROSPECTIVE, milestone audits). Tier 2: phase CONTEXT, SUMMARY and VERIFICATION, research. Tier 3: phase PLAN files, milestone archives, everything else. The default ingest is tier 2 and below, the owner can ask for tier 3.
- **D63-6:** clones and linked worktrees of one origin collapse to one canonical checkout (the default branch with the newest HEAD); directories with no origin are de-duplicated by content hash, and the scan report keeps a bounded list of the collapsed copies so a copy is never mistaken for a deleted file (when the canonical copy disappears the next copy becomes canonical and the plan reports a rename). The scan of this host found 44 origins in 72 checkouts and three copy collections holding 31,465 of the 63,063 files.
- **D63-7:** rename detection is by sha. `docs_ingest` has no delete and treats a rename as a new source URL, so the old document stays (`docs-ingest.ts:676`, `:1568-1580`); the bulk path owns tombstones through `delete_document` (`planes/lightrag.ts:892`).

## Canonical references
- `docs/docs-plane.md`, `docs/docs-search-ingest.md`, `docs/runbooks/lightrag-storage-topology.md`
- `packages/mcp-server/src/docs-ingest.ts` (`IngestPage`, `scanIngestPages`, `batchPagesForIngest`, redaction and secret findings), `docs-datasets.ts:28-36` (`DATASET_TRIGGERS`), `docs-search.ts:76` (`DEFAULT_SEARCH_DATASET_NAMES`), `server.ts:1506` (`POST /docs/ingest`, 6,000,000-byte cap at :279), `server.ts:1736` (`POST /docs/merge-trigger`), `mcp.ts:1660` (`docs_ingest`)
- `packages/audit/src/policy.ts` (fail-open and fail-closed lists), `packages/mcp-server/src/admission.ts` (tool classes), `packages/mcp-server/src/index-store.ts:350` (`MIGRATION_STEPS`, latest is 34)

## Deferred
Graph-mode entity extraction (needs an LLM route), one LightRAG workspace per repository, deleting the legacy RAG-backend code.
