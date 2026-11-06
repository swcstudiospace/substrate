---
phase: 63-corpus-atlas
verified: 2026-11-06T06:11:52Z
status: human_needed
score: 7/7 truths verified at df31c749 (SC4 as amended 2026-11-05 holds; the SC2 ingest route and SC5 lock-ordered scope check pass in r43); owner items open
covered_files: [".env.example", ".planning/phases/63-corpus-atlas/63-SUMMARY.md", "bun.lock", "docs/config-reference.md", "docs/corpus.md", "docs/data-planes.md", "docs/docs-plane.md", "docs/event-vocabulary.md", "docs/mcp-audit.md", "docs/runbooks/corpus-ingest.md", "docs/runbooks/index-archive.md", "docs/runbooks/rollback-compat.md", "package.json", "packages/audit/src/policy.test.ts", "packages/audit/src/policy.ts", "packages/cli/package.json", "packages/cli/src/corpus/bodies.test.ts", "packages/cli/src/corpus/bodies.ts", "packages/cli/src/corpus/client.test.ts", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.test.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/ingest.ts", "packages/cli/src/corpus/inventory.test.ts", "packages/cli/src/corpus/inventory.ts", "packages/cli/src/corpus/render.test.ts", "packages/cli/src/corpus/render.ts", "packages/cli/src/corpus/testkit.ts", "packages/cli/src/index.ts", "packages/collectors/src/emit.ts", "packages/corpus/package.json", "packages/corpus/src/adapters/github.test.ts", "packages/corpus/src/adapters/github.ts", "packages/corpus/src/adapters/greptile-export.test.ts", "packages/corpus/src/adapters/greptile-export.ts", "packages/corpus/src/classify.test.ts", "packages/corpus/src/classify.ts", "packages/corpus/src/discover.test.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/guards.ts", "packages/corpus/src/index.ts", "packages/corpus/src/names.test.ts", "packages/corpus/src/names.ts", "packages/corpus/src/protocol.ts", "packages/corpus/src/scan.test.ts", "packages/corpus/src/scan.ts", "packages/corpus/src/similarity.test.ts", "packages/corpus/src/similarity.ts", "packages/corpus/src/test-support.ts", "packages/mcp-server/package.json", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/citations.test.ts", "packages/mcp-server/src/corpus/ingest.test.ts", "packages/mcp-server/src/corpus/ingest.ts", "packages/mcp-server/src/corpus/mutex.test.ts", "packages/mcp-server/src/corpus/mutex.ts", "packages/mcp-server/src/corpus/names.test.ts", "packages/mcp-server/src/corpus/names.ts", "packages/mcp-server/src/corpus/plan.test.ts", "packages/mcp-server/src/corpus/plan.ts", "packages/mcp-server/src/corpus/reflect-service.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/routes.test.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/settings.test.ts", "packages/mcp-server/src/corpus/store.test.ts", "packages/mcp-server/src/corpus/store.ts", "packages/mcp-server/src/corpus/testkit.ts", "packages/mcp-server/src/corpus/validate.test.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/docs-datasets.ts", "packages/mcp-server/src/docs-golden.ts", "packages/mcp-server/src/docs-ingest.test.ts", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/docs-search.test.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-archive-spec.ts", "packages/mcp-server/src/index-archive-watch.ts", "packages/mcp-server/src/index-archive.test.ts", "packages/mcp-server/src/index-archive.ts", "packages/mcp-server/src/index-store.archive.test.ts", "packages/mcp-server/src/index-store.migrate-contract.test.ts", "packages/mcp-server/src/index-store.migrate-harness.test.ts", "packages/mcp-server/src/index-store.migrations.digests.json", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planes/__fixtures__/lightrag-v1.5.7-routes.json", "packages/mcp-server/src/planes/lightrag-bulk.test.ts", "packages/mcp-server/src/planes/lightrag-bulk.ts", "packages/mcp-server/src/planes/lightrag.contract.test.ts", "packages/mcp-server/src/planes/lightrag.test.ts", "packages/mcp-server/src/planes/lightrag.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/rollback-compat.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:fcf73e2429a24ddde0746758c84b390eaa555a75c03d1cabb79b735e05475bf5"
head_refresh: "ad7073c6: service.ts readPointerChecks and judgePointer now run under the verify budget (Greptile P1, 39023247): the anchor pointer path, the hunk family this record already cites for 3ce87f63. Outside this record's truths; verdict unchanged. Earlier, 06d0a5d6 and c37d194a: text-only changes (emit stderr wording, reconcile comment, flag-registry readBy, regenerated config doc) refreshed at c37d194a. covered_digest refreshed from verification.fingerprint; gate r46 on ad7073c6 is the run of record for the tests."
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 7/7 (re-verified at 4637a9b7, 2026-11-06T04:09:30Z; 0 behavior-unverified)
  gaps_closed: []
  gaps_remaining: []
  regressions: []
gaps: []
---

# 63-VERIFICATION: Corpus Atlas (v1.7 phase 63)

**Phase Goal:** The documentation of every repository the owner keeps (the clones on the VPS, the GitHub organisations, the Greptile knowledge bases) is discovered, classified, de-duplicated and recorded in one manifest, and a bulk path puts new and changed documents into the docs plane with provenance and removes the ones that disappeared.
**Verified:** 2026-11-06T06:11:52Z
**Status:** human_needed
**Re-verification:** Yes. The record at head 4637a9b7 (status human_needed, 7/7) is re-verified at head df31c749 over the window 4637a9b7 to df31c749 (see Changes). The window changes the corpus tombstone path: `fd4a305f` moves the scope check under the corpus lock (`corpus/service.ts`, `corpus/ingest.ts`). Criteria 1, 3, 4, 6 and 7 keep their verdicts: no change to their code paths beyond an export keyword and comments. Criteria 2 and 5 reach the changed block: their r38 titles on that block are not counted at df31c749, and their titles pass in r43. The citation rule (SC4) is unchanged: `docs-search.ts`, `corpus/store.ts` and `docs/corpus.md` are not in the window, and `service.ts` `manifestCommit` moved by line shift only.

**Head:** df31c749 (integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`). Recorded head 4637a9b7. Test evidence: gate r38 JUnit at `/root/src/worktrees/backups/gate-r38-junit.xml` (run on 66fa97bd): 12,322 testcases, 1 failure, 2 skipped. The failure ("repository ratchet: the ratchet is tight") is outside phase 63 and was addressed at 5e304ef8; the two skips are outside phase 63. r38 is the run of record for every cited title whose code path is unchanged since 66fa97bd. Gate r43 on df31c749 is in progress and writes `/root/src/worktrees/backups/gate-r43-junit.xml` when it finishes; it is the run of record for the pending titles on the changed path, and no result is claimed for it here. The gate r42 JUnit (`gate-r42-junit.xml`, run on 4637a9b7) exists and is not cited by this record.

## Changes since the previous record that were checked

Window 4637a9b7 to df31c749: eight commits. `fd4a305f` changes criterion code (the scope check moves under the corpus lock). `0556dfd3`, `6245863c`, `d928e995`, `3ce87f63`, `7f6338c2` and `df31c749` touch covered files or their neighbours but no criterion path (listed below). `700d9b5c` changes `.planning/` and `ROADMAP.md` only.

Hunk-by-hunk check of the covered files in the window (`git diff 4637a9b7 df31c749`, every hunk read; a grep of the added lines finds no TODO, FIXME, XXX or placeholder):

- **Tombstone scope under the corpus lock (criteria 2 and 5; a fix, not an owner decision):** `packages/mcp-server/src/corpus/service.ts` `corpusIngestReply` (`:244-250`) now runs `tombstoneScopeRefusal` and `runIngest` in one `withCorpusLock` hold; before, it ran the check and then called `ingestCorpus`. The check still precedes every plane write. Its body and `emitRefusal` (`:179-196`) are unchanged; its doc comment (`:173-178`) now says it runs under the lock. `reflect-service.ts:251` still calls `ingestCorpus` with `tombstones: []`, so it never reaches the check.
- **`corpus/ingest.ts` (criteria 4, 5, 6):** `runIngest` is exported (`:474`) with a doc comment that its caller holds `withCorpusLock`. `ingestCorpus` (`:466-467`) is unchanged. Every other hunk is a comment. Phase T, plan, batch and resume code is unchanged: `:238-241`, `:248`, `:256-257`, `:270`, `:296-315`, `:351`, `:393`, `:403` keep their numbers; the bounded send moved from `:482` to `:486`.
- **`packages/mcp-server/src/service.ts` (`3ce87f63`; not a corpus path):** adds `namedBySignerSet` (`:854`), changes `readPointerChecks`'s rule for a rotated signer, and gives the brief composer `this.briefIndex(request.surface)` (a private method at `:6940`, beside `repoScopeFilter`). The corpus methods are unchanged. `manifestCommit` moved from `:6421` to `:6436` (line shift only). The `corpusIngestReply` wiring (`:7079`) is unchanged.
- **`packages/mcp-server/src/config.ts` (`6245863c`):** `loadEventBufferSettings` compares the buffer and dead-letter files by real destination (`destinationOf`, `linkTargetOf`). No corpus setting is read there, and no criterion reads it.
- **`packages/mcp-server/src/repo-scope.boundary.test.ts` (`fd4a305f`; now in the covered set):** one test added at `:272`, named under criterion 5. Its comment at `:280` says the scope check runs while the other ingest holds the lock; the code waits for the lock (Advisory A7).
- **Not on a criterion path:** `packages/mcp-server/src/cache.ts` and `cache.test.ts` (`0556dfd3`); `config.test.ts`; `reconcile-read.ts`, `reconcile-repair.ts` and their tests (`d928e995`); `service.test.ts` (`3ce87f63`); the host files and `tasks.test.ts` (`7f6338c2`); `packages/dispatcher/tests/test_worktree.py` (`df31c749`). `docs-search.ts`, `corpus/store.ts` and `docs/corpus.md` are not in the window.

Behaviour-neutral: the `runIngest` export and the comments. A refused tombstone request now touches the root keeper (Advisory A8).

## Emit path check (4ac770af; window 5e304ef8 to 4637a9b7)

Commits in the window that touch code: `4ac770af` (`packages/cli/src/index.ts`, +6 −1, all in `cmdEmit`) and `e2e4cba4` (`packages/mcp-server/src/skills/propose.ts` and `propose.test.ts`; not in this covered set). The docs-only commits `b577f5be`, `cebd76df` and `4637a9b7` change `.planning/` and `ROADMAP.md` only. The covered-code change is `4ac770af`: when `post("/events")` returns null and the spool is off, `cmdEmit` writes one stderr line naming the kind (`packages/cli/src/index.ts:235-239`). Its only caller is the `emit` subcommand (`index.ts:672-673`); a grep of `packages/` for `cmdEmit` finds no other reference.

Grep of the criteria code paths for `cmdEmit` and `/events` (at df31c749; unchanged in the window 4637a9b7 to df31c749):

- No criterion of phase 63 reaches `cmdEmit`. The `emit` subcommand is not in the path of `scan`, `plan`, `ingest`, `status`, or the server's corpus routes.
- `/events` is reached from the corpus CLI in two places, neither of which is `cmdEmit`:
  - `createHttpEmitter` (`packages/cli/src/corpus/events.ts:78`) posts a `docs.sync` note. It is wired at `packages/cli/src/corpus/index.ts:381` into `sync`, `watch` and `reconcile` only (`watchFamily`, `corpus/index.ts:360-402`). These are not criterion commands.
  - `deps.audit` (`packages/cli/src/corpus/index.ts:304`) reaches `corpusScopeRefusal` (`packages/cli/src/corpus/scope.ts:49`), which posts a refusal warning through `postEvent` (`packages/collectors/src/emit.ts:400-419`, `POST ${base}/events`); `postEvent` is wired at `packages/cli/src/index.ts:836`. This runs for any corpus subcommand, but only when the registry scope refuses a local target (Phase 72). `postEvent` is not in the `4ac770af` hunk.
- The server side of the corpus routes (criteria 2 and 3: `packages/mcp-server/src/server.ts:1762-1822`, the corpus methods of `service.ts`, `corpus/*`, `planes/lightrag-bulk.ts`, `index-store.ts`, `docs-search.ts`, `docs-ingest.ts`) contains no `/events` reference. Those routes audit through `auditedRest` (`server.ts:1768`, `:1795`). The one `/events` string in `service.ts` (line 6878) is the doc comment of the ledger read `events_query`, not a corpus path. `service.ts:1073` is a comment on the idempotent `POST /events` outcome, also not a corpus path.

Result: `4ac770af` changes no code on a phase 63 criterion path. Its behaviour change is confined to the `emit` hook path, which is outside phase 63. Criteria 1 to 7 keep their verdicts. The owner items are unchanged.

## Citation audit (the amendment: the commit reaches the citation URL)

Rule in force (`docs/corpus.md:28-30`, `docs-search.ts:597-604` doc comment `:594-600`): a corpus chunk is cited at the manifest row's commit only when all hold: the row is `active` (`record.state === "active"`), the row records a full 40-hex commit (`FULL_COMMIT`, `:534`, applied in `manifestCommits` `:568`), and the chunk's name carries the row's content hash (`record.sha256.toLowerCase().startsWith(parsed.sha12)`). Otherwise the chunk is cited at `blob/HEAD/<path>` with `commit: dataset-pin:corpus:unrecorded`.

Code chain at df31c749 (line numbers are the code lines; the cited `docs-search.ts` and `corpus/store.ts` lines are unchanged since 4637a9b7, and `service.ts` `manifestCommit` moved from 6421 to 6436 by line shift only):

- `docs-search.ts:534` `FULL_COMMIT`; `:537` `MANIFEST_COMMIT_DEADLINE_MS = 500`.
- `docs-search.ts:555-571` `manifestCommits`: one lookup per distinct `(repo, path)` per reply, each raced against `withDeadline(…, 500)`; a throw, a rejection, a null, a record without a full commit, or a timeout leaves that document out. The search never fails on it.
- `docs-search.ts:583-594` `withCorpusProvenance`: `source_url = corpusSourceUrl(repo, path, recorded)`, `commit = recorded ?? dataset-pin:corpus:unrecorded`, `dataset: corpus`.
- `docs-search.ts:601-604` `citableCommit`: `state` must be `active`, `commit` non-null, and the chunk's `sha12` a prefix of the row's `sha256`.
- `docs-search.ts:1151-1152` `searchDocsLightrag` calls `manifestCommits`, then `withCorpusProvenance` on each chunk.
- `packages/mcp-server/src/service.ts:6436`: `manifestCommit: async (repo, path) => (await this.corpusStore()?.rowFor(repo, path)) ?? null`, inside `Substrate.searchDocs`. The MCP and REST routes both reach it.
- `packages/mcp-server/src/corpus/store.ts:178-182` `rowFor` returns the row in any state; the state gate is in `citableCommit`, not in the store.
- `packages/corpus/src/protocol.ts:429-437` `sourceUrl(repo, path, commit?)` emits `blob/<commit or HEAD>/<path>` for a GitHub-origin repo.

Advisories of the previous draft, now:

- **A1 (old chunk at newer commit): closed.** `citableCommit` compares the chunk's sha12 with the row's sha256. Test "a chunk indexed from an older version is cited at HEAD, not at the newer commit" (`citations.test.ts:80`), passed in r38.
- **A2 (tombstoned row cited at its commit): closed.** `citableCommit` requires `state === "active"`. Test "a tombstoned document is cited at HEAD, not at its commit" (`citations.test.ts:86`), passed in r38.
- **A3 (no test on the production wiring): closed.** Test "a docs search through the service cites the commit the corpus manifest records" (`docs-search.test.ts:668`, describe "LightRAG search and the RAGFlow plane"). It goes through `Substrate.searchDocs`, so it exercises `service.ts:6421`. Passed in r38 (0.00174 s).

Tests cited for this audit (gate r38, each testcase passed; `corpus citations`, `packages/mcp-server/src/corpus/citations.test.ts`):

| Title (as in the JUnit) | line |
|---|---|
| a result whose file path is a corpus document name cites its repo and path, dataset corpus, and keeps LightRAG's heading | 40 |
| a corpus name given only as the document name is recognised, and a local repo gets a corpus:// URL | 52 |
| a result that is not a corpus document is cited exactly as before, with no dataset member | 58 |
| a corpus document whose manifest row records a commit cites that commit, not HEAD | 65 |
| a chunk indexed from an older version is cited at HEAD, not at the newer commit | 80 |
| a tombstoned document is cited at HEAD, not at its commit | 86 |
| a corpus document whose manifest row records no commit cites HEAD | 91 |
| a recorded value that is not a full 40-character commit name cites HEAD | 96 |
| a manifest lookup that throws or rejects still answers the search, with the document cited at HEAD | 103 |
| the same path in another repository is not cited at this repository's commit | 115 |
| a document with several chunks is looked up once per reply | 130 |
| a manifest lookup that never answers is abandoned at its deadline, and the document is cited at HEAD | 148 (0.500601 s in r38) |

Carried over in the same suite: `the corpus dataset` "is searched by default and has a trigger row" (`citations.test.ts:158`).

The test at `citations.test.ts:65` asserts `source_url` = `https://github.com/swcstudiospace/agent-substrate/blob/${COMMIT}/docs/data%20planes.md` and `commit` = `COMMIT` for a full 40-hex recorded commit on an active, content-matched row. The plane document's source still carries only the name (`lightrag-bulk.ts:234`, `file_sources = doc.name`; `ingest.ts:256-257`). The amended SC4 text equates the document source with its citation URL, and the owner decision does not require the plane source to hold the commit. This is recorded as the reading, not as a waiver.

## Success criteria

| # | Criterion (as amended) | Status | Evidence |
|---|---|---|---|
| 1 | Scan deterministic; clones and worktrees collapse; identical copies collapse with bounded report; a rename only within one repository; a copy in another collection is an add plus a tombstone; exclusions and size caps | VERIFIED (cited files unchanged since 4637a9b7; checked at df31c749) | `packages/mcp-server/src/corpus/plan.ts:68-85` pairs a removed row with a new entry only on `keyOf(repo, sha256)`; `plan.ts:12-14` scope. The only change to `plan.ts` since 0947001e is an export keyword (1 line). Scan side `packages/corpus/src/scan.ts`: export keyword only. r38: "a rename never crosses repositories", "the same text at a new path is one rename, naming the row it moved from, not an add plus a tombstone", "renames pair one to one: two removed rows and one new copy leave one tombstone" (describe "planCorpus: the six actions"). |
| 2 | `scan`, `plan`, `ingest`, `status` work against a server; `plan` sends no bodies and prints counts; `ingest` is a dry run until `--execute` | VERIFIED in code; the ingest route's titles pass in r43 at df31c749 | Server doors `server.ts:1762` (`POST /corpus/plan`), `:1787` (`POST /corpus/ingest`), `:1815` (`GET /corpus/status`), unchanged. r38: "a plan counts add, change, rename and tombstone against the manifest and writes nothing" (describe "POST /corpus/plan and GET /corpus/status"). The ingest route reaches `corpusIngestReply`, which `fd4a305f` changed (the scope check and the ingest now share one `withCorpusLock` hold, `corpus/service.ts:244-250`); no r38 title that exercises that block is counted at df31c749. Pending r43: "a tombstone-only request (no documents) is accepted and removes the row" (describe "POST /corpus/ingest", `corpus/routes.test.ts`). Not exercised against a live server (human item 1). |
| 3 | Migration step creates `corpus_documents` (additive, reversible, digest fixture, rollback-compat doc); the four routes and MCP tools audited and admitted; the table is in the index archive and restore spec with its restore tested | VERIFIED (cited files unchanged since 4637a9b7; checked at df31c749) | Step 35 `packages/mcp-server/src/index-store.ts:701-727` (`name` at 702; `create table if not exists corpus_documents` at 706; `down` drops it at 704), unchanged apart from a comment. Digest `packages/mcp-server/src/index-store.migrations.digests.json:36`. Archive spec `index-archive-spec.ts:216`. r38: "after a restore, a plain insert into corpus_documents takes a manifest_seq above every restored one" (describe "index archive against a live index"). `docs/runbooks/rollback-compat.md:48` names step 35. |
| 4 | LightRAG bulk path: batches through `POST /documents/texts` with bounded concurrency and one poll per batch; redacts and refuses secrets as `docs_ingest` does; carries repo, path and **commit** into the document source (its citation URL); kind and tier stay in the manifest, which also records the commit; the plane document carries name and text | VERIFIED (amended wording, read as in "Reading of the criterion" above; cited files unchanged since 4637a9b7 except `corpus/ingest.ts` (export keyword and comment on `runIngest`, `:474`); checked at df31c749) | Route and bounds: `packages/mcp-server/src/planes/lightrag-bulk.ts:234-235` (`POST /documents/texts`), `:276-278` (one `waitIdle` per batch); file unchanged since 0947001e. Bounded concurrency `corpus/ingest.ts:486` `runBounded(batches, deps.settings.concurrency, …)`. Secret refusal `corpus/ingest.ts:248`. Plane text and name `corpus/ingest.ts:256-257`. The citation URL carries the commit through `docs-search.ts:583-594` and `:601-604` (see Citation audit). r38: "a manifest lookup …" and "a tombstoned …" titles above; "a docs search through the service cites the commit the corpus manifest records". |
| 5 | Removed or renamed document tombstoned: plane document deleted through `delete_document` only when no other active row shares it; row `tombstoned`; rename only within one repository; a copy in another collection is an add plus a tombstone; tombstone only for a repository the scan covered completely, at the declared scope; narrower scans leave earlier documents untouched | VERIFIED in code; the lock-ordered scope check's titles pass in r43 at df31c749 (scope rule is an owner item, see Human items 6) | Shared-document guard `corpus/ingest.ts:270` (`activeReferences(id) > 0` keeps the plane document); phase T `corpus/ingest.ts:351`, `:393` (`deleteDocuments`), `:403` (`delete-failed` leaves the row ACTIVE); plane delete `planes/lightrag.ts:892` (`delete_document`). Scope: `plan.ts:12-14`. Server-side scope check, added after the v1.7 audit's finding F1 (`.planning/milestones/v1.7-REQUIREMENTS-AUDIT.md:123`): `validate.ts:185` refuses tombstones without a `scope` (`tombstone-scope-required`); `corpus/service.ts:179-196` `tombstoneScopeRefusal` refuses a tombstone whose row is not in `scope.coverage` or whose tier is above `maxTier` (403 `tombstone-out-of-scope`, emitted at `:192`), before any plane write. Since `fd4a305f` the check runs under the corpus lock in the same hold as `runIngest` (`corpus/service.ts:244-250`; `withCorpusLock`, `corpus/ingest.ts:56`), so a row that another ingest moved out of scope while this request waited is judged as it now stands. Messages `corpus/service.ts:99,116`. Cited from r38 (the refusal's path is unchanged): "a tombstone for a repository the caller is not granted is refused, and the plane deletes nothing" (refused before the lock, `repoRefusalOf`), "a tombstone request without a scope is refused, and the plane deletes nothing" (refused by `validate.ts:185` before the lock), "tombstones without a scope are refused tombstone-scope-required" (`validate.test.ts:118`). The titles below pass in r43 (the path through the lock changed in `fd4a305f`): "a tombstone of a document whose tier is above the request's maxTier is refused, and the plane deletes nothing", "a tombstone of a document whose source the request does not cover is refused, and the plane deletes nothing" (describe "corpus ingest tombstones (ATLAS-04 …)", `repo-scope.boundary.test.ts:217-256`); "a tombstone outside the request's scope is refused 403 tombstone-out-of-scope and deletes nothing" (`routes.test.ts:203`); and the new "a tombstone whose row another ingest moves out of scope while it waits for the lock is refused, and the plane deletes nothing" (`repo-scope.boundary.test.ts:272`). |
| 6 | Second identical run reports `unchanged` and sends nothing; a killed run resumes without re-sending recorded documents | VERIFIED (cited files unchanged since 4637a9b7; `ingestCorpus` and the resume code unchanged; checked at df31c749) | `corpus/ingest.ts:238-241` (same sha, source, kind, tier and marker → `unchanged`); `ingest.ts:296-315` records each accepted document per batch. r38: "a document already recorded at the same sha is unchanged: nothing is sent, and a second identical run sends nothing" (describe "ingestCorpus: documents"); "a run killed after the first batch resumes with only the documents it had not recorded" (describe "ingestCorpus: plane failures and resuming"). |
| 7 | Source adapters for a Greptile export directory and for GitHub through `gh` produce the same entries; both bounded by `--max-repos` and `--tier` | VERIFIED (cited files unchanged since 4637a9b7; checked at df31c749) | `packages/corpus/src/adapters/greptile-export.ts:130` (`kind: "greptile-kb"`, tier 2). `adapters/github.ts:29-30` defaults (`DEFAULT_GITHUB_MAX_REPOS = 50`, concurrency 4), `:139-171` bounded limiter. r38: "reads <owner>/<repo>/<path>.md files as tier-2 greptile-kb entries and ignores everything else" and "a tier bound below 2 reads nothing, since every document is tier 2" (describe "scanGreptileExport"); "the tier bound drops research at tier 1 and brings loose notes at tier 3, without fetching what it drops" (describe "scanGithub"). CLI bounds `cli/src/corpus/index.ts`. A real Greptile export and live `gh` were not run (human items 2, 3). |

**Score:** 7/7 truths verified at df31c749; the SC2 ingest route and SC5 lock-ordered scope check pass in r43. SC4 holds under its amended wording at df31c749.

## Required artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/corpus/src/{protocol,scan,classify}.ts` | closed enums, bounds, scan, collapse, caps; `sourceUrl` with commit | VERIFIED | `protocol.ts:57-101` bounds (`MAX_INGEST_TOMBSTONES` at `:101`); `sourceUrl` `:429-437`. Changes since 0947001e: export keyword only. |
| `packages/mcp-server/src/corpus/{plan,ingest,service,store,validate,routes}.ts` | server doors and ingest | VERIFIED (ingest route and scope check: titles pass in r43) | r38 titles above. `store.ts:178-182` `rowFor`; `corpus/service.ts:179-196` tombstone scope; `validate.ts:185`; `corpus/service.ts:244-250` lock hold (`fd4a305f`). |
| `packages/cli/src/corpus/{index,ingest,client,inventory}.ts` | CLI commands and client | VERIFIED | Changes since 0947001e: export keyword only. `cli/src/index.ts` handoff hunks and the `cmdEmit` stderr line (4ac770af) are outside the corpus commands; see the emit path check. |
| `packages/mcp-server/src/index-store.ts` step 35 | additive `corpus_documents` | VERIFIED | `:701-727`; digest `packages/mcp-server/src/index-store.migrations.digests.json:36`. |
| `packages/mcp-server/src/index-archive-spec.ts` `corpus_documents` | archive spec, closed list | VERIFIED | `:216`. |
| `packages/mcp-server/src/planes/lightrag-bulk.ts` | bulk insert, wait, map, delete | VERIFIED | `:234-235`, `:276-278`, `:892` (delete in `lightrag.ts`). Unchanged since 0947001e. |
| `packages/mcp-server/src/docs-search.ts` `withCorpusProvenance` / `citableCommit` | corpus citation with commit, active and content-matched only | VERIFIED | `:534`, `:537`, `:555-571`, `:583-594`, `:601-604`; `:1151-1152` applied in `searchDocsLightrag`. Unchanged since 0947001e apart from a logger import and two catch sites. |
| `packages/mcp-server/src/service.ts` `manifestCommit` | production wiring of the row lookup | VERIFIED | `:6436` (passes the whole row since 0947001e; line shift from 6421). Exercised by `docs-search.test.ts:668`. |

## Key link verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `cli/src/corpus/ingest.ts` | `POST /corpus/ingest` | `client.ingest` with `scope` | WIRED | Carried forward; `client.ts` changed by export keyword only. |
| `server.ts` (corpus route) | `substrate.corpusIngest` → `corpusIngestReply` → `withCorpusLock` → `runIngest` | route handler | WIRED | `corpus_ingest` audit (fail-closed) before the call; `server.ts:1787`. |
| `corpus/service.ts` | `withCorpusLock` → `tombstoneScopeRefusal` → `runIngest` | `:244-250` (`fd4a305f`) | WIRED | The scope check and the ingest share one lock hold; a refusal emits `tombstone-out-of-scope` and returns before any plane write. |
| `ingest.ts` | `planes/lightrag-bulk.ts` | `plane.insertBatch` / `plane.deleteDocuments` | WIRED | `ingest.ts:271`, `:351`, `:393`. |
| `ingest.ts` | `corpus_documents` | `CorpusStore` writes, `manifest_seq` identity | WIRED | `store.ts`; PG tests write and read the table. |
| `index-archive-spec.ts` | `index-store.ts` step 35 | closed whitelist vs `information_schema` | WIRED | `index-store.archive.test.ts` on a live database (r38). |
| manifest row commit → `docs_search` citation URL | `sourceUrl(repo, path, commit)` | `store.rowFor` → `service.ts:6436` → `manifestCommits` → `citableCommit` → `withCorpusProvenance` | WIRED | Tests: `citations.test.ts:65`, `docs-search.test.ts:668`. |

## Requirements coverage

| Requirement | Status | Evidence |
|---|---|---|
| ATLAS-01 (scan, collapse, rename within one repository, copy as add plus tombstone) | SATISFIED | SC1; `plan.ts:68-85`; r38 `planCorpus: the six actions`. |
| ATLAS-02 (`plan` reports add, change, rename, tombstone without bodies) | SATISFIED | SC2; r38 "a plan counts add, change, rename and tombstone…". |
| ATLAS-03 (bulk route, repo, path and commit provenance, the citation URL carrying the commit; no serial wait; secrets refused) | SATISFIED | SC4; the citation URL carries the active, content-matched manifest commit (`citations.test.ts:65`, `docs-search.test.ts:668`, `docs-search.ts:601-604`, `service.ts:6436`). |
| ATLAS-04 (tombstone only within a completely covered scan) | SATISFIED in code; lock-ordered path's title passes in r43; owner item open | SC5; scope refusals at `corpus/service.ts:179-196`, `validate.ts:185`; r38 titles above. Whether this is the owner's accepted scope rule is open (Human items 6). |
| ATLAS-05 (second run unchanged, resume after kill) | SATISFIED | SC6; r38 "a document already recorded at the same sha is unchanged…", "a run killed after the first batch resumes…". |
| ATLAS-06 (Greptile and GitHub adapters into the same manifest) | SATISFIED | SC7; r38 `scanGreptileExport` and `scanGithub` titles above. Real export and live `gh` not run. |

**Orphaned requirements:** none. ATLAS-01 to ATLAS-06 map to phase 63.

## Anti-patterns found

A grep of the phase 63 covered set for TODO, FIXME, XXX, not-implemented and placeholder returns, over the lines changed since 0947001e and over the added lines of the window 4637a9b7 to df31c749, matches nothing in the changed hunks.

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| (none) | - | - | - | - |

## Deferred items

None. Phases 64 to 66, 69 and 70 build on this manifest; that is not a deferral of a phase 63 criterion.

## Advisories (not failures of SC4, ATLAS-03 or the other criteria)

- **A4. f0f3c04e removed the runbook-naming test** in `rollback-compat.test.ts` ("every step added since is named in docs/runbooks/rollback-compat.md"; the commit calls the tests wording-only). Checked at df31c749: that title is absent from `packages/` and `docs/`, and the runbook still names step 35 (`rollback-compat.md:48`), so the document evidence for criterion 3 holds. A similarly named test ("every step added since is additive …", `rollback-compat.test.ts:671`) is not the removed one. Nothing now fails if a future step is left out of the runbook. Still open (owner item).
- **A5. Latency and eval.** A `docs_search` reply can wait up to 500 ms for its slowest manifest lookup; the lookups run in parallel after retrieval (`docs-search.ts:555-571`, `:1151`). The golden eval harness `docs-golden.ts` (`searchDocs` call near `:203`) does not pass `manifestCommit`, so its corpus citations stay at HEAD. Eval only. Still open (owner item).
- **A6. Test count.** `corpus citations` has twelve cases in `citations.test.ts` (lines 40 to 148), and `the corpus dataset` has one (line 158). Not a code issue.
- **A7. Test comment (`repo-scope.boundary.test.ts`, `fd4a305f`).** The comment at `:280` says the request's scope check runs while another ingest holds the lock. The code waits for the lock (`corpus/service.ts:244`), so the check runs after that ingest releases it. The assertion (refused, plane deletes nothing) is the behaviour the test is meant to show. Whether the test separates the pre-fix order from the fixed one depends on the request reaching its check within the test's 40-turn wait; not verified by a run. Not a criterion failure; the test file is not edited by this pass.
- **A8. Refused tombstone requests now touch the root keeper (`fd4a305f`).** A refused request calls `writeStarted()` before the lock and `writeSettled(false)` after the refusal; before, it returned before either. That bumps the root generation, and while the request waits for the lock the cached root is unavailable, as it already was for an ingest queued behind another. It writes no manifest row, plane document or root event: `writeSettled(false)` schedules nothing unless an event was already owed (`corpus/root.ts:271-286`). No criterion depends on it.

## Owner items (no owner decision for phase 63 on 2026-11-06)

The owner made decisions on 2026-11-06 for phases 67, 74 and 75 only. For phase 63 there is no owner decision, so the owner items below stay open. No override is recorded (`overrides_applied: 0`); code changes are recorded as fixes with their tests, not as decisions:

- ATLAS-04 tombstone scope: whether the server-side scope rule at `POST /corpus/ingest` (`corpus/service.ts:179-196`, `validate.ts:185`) is the accepted rule. Open. The change of `fd4a305f` (the check under the corpus lock) is a recorded fix with its test, not a decision.
- A4 (runbook-naming test removed): open.
- A5 (500 ms lookup latency; golden eval without `manifestCommit`): open.

## Unsettled

- `packages/mcp-server/src/docs-search.test.ts` holds the A3 test (`:668`). It is now listed in `covered_files`, because the A3 evidence cites it and the fingerprint covers files that evidence cites. `packages/mcp-server/src/docs-golden.ts` is listed for A5 for the same reason.
- `packages/mcp-server/src/greptime.ts` changed since 0947001e (silent-site reporting). It is not in this record's covered set and no criterion of phase 63 cites it. It is left out of scope here.
- `covered_files` and `covered_digest` are the values returned by `gsd_run query verification.fingerprint` at head df31c749 over the covered set, plus `packages/collectors/src/emit.ts` (cited by the emit path check) and the three files this pass cites that the record did not list: `packages/mcp-server/src/repo-scope.boundary.test.ts`, `packages/mcp-server/src/corpus/root.ts`, `packages/mcp-server/src/corpus/reflect-service.ts`. Not hand-computed.

## Human verification required (carried forward; not counted, not observed in this pass)

These remain open. Nothing here observed them.

1. **Live ingest.** Run `substrate corpus ingest --execute` against the live corpus with the server on `SUBSTRATE_CORPUS=on` and a LightRAG backend, after the dry-run plan. Expected: batches report `ingested`; a repeat run reports `unchanged` and sends nothing; no secret refusals on the real corpus.
2. **Greptile export.** Ingest a real Greptile knowledge-base export directory. Expected: the `<owner>/<repo>/<path>.md` layout is read as tier-2 `greptile-kb` entries.
3. **GitHub through `gh`.** Ingest repositories with no local clone through a logged-in `gh`. Expected: the same entry shape as the Greptile source.
4. **Migration step 35 and the archive on production.** Apply step 35 to a restored dump and run the rollback check (`docs/runbooks/rollback-compat.md`). Take a new index archive on this release: an archive written before `ebabe6ef` fails `verify-archive` (kind `schema`). Expected: the step applies and reverses; the new archive passes `verify-archive`; restoring it reproduces `corpus_documents` with its `manifest_seq` values.
5. **Citation on live data.** After item 1, a `docs_search` for a GitHub-origin corpus document shows `blob/<40-hex>/<path>` and a `commit` equal to that path's manifest row, for an active row whose content matches the indexed chunk. Expected: the commit matches the manifest; `HEAD` appears only for a document with no recorded commit, a tombstoned row, or a chunk indexed from an older version.
6. **Owner item: ATLAS-04 tombstone scope.** The owner decides whether the scope rule at `POST /corpus/ingest` is the accepted behaviour. Expected decision: accept, or name the change required. Open. The fix of `fd4a305f` (the scope check under the corpus lock) does not decide the rule.
7. **Owner items A4 and A5.** Open (see Advisories).

## Gaps summary

None of the criteria fails. Criteria 2 (ingest route) and 5 (lock-ordered scope check) hold in code at df31c749; their behaviour at this head passes in r43 (`/root/src/worktrees/backups/gate-r43-junit.xml`). Criteria 1, 3, 4, 6 and 7 hold at df31c749 on the r38 evidence. The commit the manifest records for an active, content-matched GitHub-origin corpus document reaches the `docs_search` citation URL (`blob/<commit>/<path>`) and its `commit` field, asserted by `citations.test.ts:65` and `docs-search.test.ts:668` (r38 titles), with the 500 ms lookup deadline asserted by `citations.test.ts:148`. Status is `human_needed` because the owner items (human items 6 and 7, and the human-verification items 1 to 5) remain open.

---

_Verified: 2026-11-06T06:11:52Z_
_Verifier: gsd-verifier procedure, agent V63-3 (read-only on the worktree; no tests run; gate r38 JUnit read; fingerprint via `gsd_run query verification.fingerprint` at df31c749)_
