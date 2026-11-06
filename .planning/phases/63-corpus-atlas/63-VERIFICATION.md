---
phase: 63-corpus-atlas
verified: 2026-11-06T01:10:45Z
status: human_needed
score: 7/7 must-haves verified (SC4 as amended 2026-11-05 VERIFIED at 0947001e: the manifest commit reaches the citation URL for an active, content-matched row; 0 behavior-unverified)
covered_files: [".env.example", ".planning/phases/63-corpus-atlas/63-SUMMARY.md", "bun.lock", "docs/config-reference.md", "docs/corpus.md", "docs/data-planes.md", "docs/docs-plane.md", "docs/event-vocabulary.md", "docs/mcp-audit.md", "docs/runbooks/corpus-ingest.md", "docs/runbooks/index-archive.md", "docs/runbooks/rollback-compat.md", "package.json", "packages/audit/src/policy.test.ts", "packages/audit/src/policy.ts", "packages/cli/package.json", "packages/cli/src/corpus/bodies.test.ts", "packages/cli/src/corpus/bodies.ts", "packages/cli/src/corpus/client.test.ts", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.test.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/ingest.ts", "packages/cli/src/corpus/inventory.test.ts", "packages/cli/src/corpus/inventory.ts", "packages/cli/src/corpus/render.test.ts", "packages/cli/src/corpus/render.ts", "packages/cli/src/corpus/testkit.ts", "packages/cli/src/index.ts", "packages/corpus/package.json", "packages/corpus/src/adapters/github.test.ts", "packages/corpus/src/adapters/github.ts", "packages/corpus/src/adapters/greptile-export.test.ts", "packages/corpus/src/adapters/greptile-export.ts", "packages/corpus/src/classify.test.ts", "packages/corpus/src/classify.ts", "packages/corpus/src/discover.test.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/guards.ts", "packages/corpus/src/index.ts", "packages/corpus/src/names.test.ts", "packages/corpus/src/names.ts", "packages/corpus/src/protocol.ts", "packages/corpus/src/scan.test.ts", "packages/corpus/src/scan.ts", "packages/corpus/src/similarity.test.ts", "packages/corpus/src/similarity.ts", "packages/corpus/src/test-support.ts", "packages/mcp-server/package.json", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/citations.test.ts", "packages/mcp-server/src/corpus/ingest.test.ts", "packages/mcp-server/src/corpus/ingest.ts", "packages/mcp-server/src/corpus/mutex.test.ts", "packages/mcp-server/src/corpus/mutex.ts", "packages/mcp-server/src/corpus/names.test.ts", "packages/mcp-server/src/corpus/names.ts", "packages/mcp-server/src/corpus/plan.test.ts", "packages/mcp-server/src/corpus/plan.ts", "packages/mcp-server/src/corpus/routes.test.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/settings.test.ts", "packages/mcp-server/src/corpus/store.test.ts", "packages/mcp-server/src/corpus/store.ts", "packages/mcp-server/src/corpus/testkit.ts", "packages/mcp-server/src/corpus/validate.test.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/docs-datasets.ts", "packages/mcp-server/src/docs-ingest.test.ts", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-archive-spec.ts", "packages/mcp-server/src/index-archive-watch.ts", "packages/mcp-server/src/index-archive.test.ts", "packages/mcp-server/src/index-archive.ts", "packages/mcp-server/src/index-store.archive.test.ts", "packages/mcp-server/src/index-store.migrate-contract.test.ts", "packages/mcp-server/src/index-store.migrate-harness.test.ts", "packages/mcp-server/src/index-store.migrations.digests.json", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planes/__fixtures__/lightrag-v1.5.7-routes.json", "packages/mcp-server/src/planes/lightrag-bulk.test.ts", "packages/mcp-server/src/planes/lightrag-bulk.ts", "packages/mcp-server/src/planes/lightrag.contract.test.ts", "packages/mcp-server/src/planes/lightrag.test.ts", "packages/mcp-server/src/planes/lightrag.ts", "packages/mcp-server/src/rollback-compat.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:f6d098e364582bb68272128f5060a34e2954fc7e98e322d79649b4d10480baed"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 6/7 (SC4 and ATLAS-03 failed at 6e5d766e; record of 2026-11-05)
  gaps_closed:
    - "SC4 (amended 2026-11-05): the commit reaches the citation URL. withCorpusProvenance cites blob/<commit>/<path> from the commit the manifest row records, only when the row is active and the chunk's sha12 is a prefix of the row's sha256 (docs-search.ts:597-603, :572-583; service.ts:6421; test citations.test.ts:65)"
    - "ATLAS-03 (amended 2026-11-05): the citation URL carries the commit"
    - "Advisory A1 (old chunk cited at newer commit): fixed by citableCommit (docs-search.ts:601-603); citations.test.ts:80"
    - "Advisory A2 (tombstoned row cited at its commit): fixed by the state check in citableCommit; citations.test.ts:86"
    - "Advisory A3 (no test on the production wiring): covered by 'a docs search through the service cites the commit the corpus manifest records' (docs-search.test.ts:668)"
  gaps_remaining: []
  regressions: []
gaps: []
---

# 63-VERIFICATION: Corpus Atlas (v1.7 phase 63)

**Phase Goal:** The documentation of every repository the owner keeps (the clones on the VPS, the GitHub organisations, the Greptile knowledge bases) is discovered, classified, de-duplicated and recorded in one manifest, and a bulk path puts new and changed documents into the docs plane with provenance and removes the ones that disappeared.
**Verified:** 2026-11-06T01:10:45Z
**Status:** human_needed
**Re-verification:** Yes. The previous record (worktree, head 6e5d766e, status gaps_found, 6/7, digest `v3:sha256:6fee8d0d…`) is replaced. The citation rule was re-audited at head 0947001e, the commit that narrowed the citation to active, content-matched rows (`fix(63)`). The advisories A1 to A3 of the draft pass (head a46d42c3) are closed by that commit and by the test it added or extended.

**Head:** 0947001e (integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`). Gate r37 JUnit at `/root/src/worktrees/backups/gate-r37-junit.xml`: 12,320 testcases, 0 failures, 2 skipped (both outside phase 63: "harness round trip through the rehearsal twin D-04 fixtures…" and "cache conformance live loopback redis…"). Gate r37 is green at 0947001e: 12,318 pass, 0 fail, 2 skip.

## Changes since the previous record that were checked

Covered files changed between a46d42c3 (the draft's head) and 0947001e: three files, all in the covered set.

- `packages/mcp-server/src/docs-search.ts` (0947001e): `citableCommit` (`:597-603`) added; `manifestCommits` (`:555-570`) keeps a full `ManifestCommitRecord` rather than a bare commit; `withCorpusProvenance` (`:572-583`) calls `citableCommit`. Audited below.
- `packages/mcp-server/src/service.ts` (0947001e, one line): `manifestCommit` at `:6421` now returns the whole row (`rowFor(...) ?? null`) instead of `?.commit`, so the state and sha256 reach `citableCommit`. Audited below.
- `packages/mcp-server/src/corpus/citations.test.ts` (0947001e): the cases for A1 and A2 added; the `search` helper passes the record through. Audited below.
- `docs/corpus.md:28-30` (unchanged since a46d42c3): states the rule. Matches the code (see Citation audit).

`docs-search.test.ts` changed in 0947001e too and holds the A3 test; it is not in the frontmatter `covered_files` list (see Unsettled).

## Citation audit (the amendment: the commit reaches the citation URL)

Rule as now in force (`docs/corpus.md:28-30`, `docs-search.ts:597-603`): a corpus chunk is cited at the manifest row's commit only when all hold: the row is `active` (`record.state === "active"`), the row records a full 40-hex commit (`FULL_COMMIT`, `:534`, applied in `manifestCommits` `:568`), and the chunk's name carries the row's content hash (`record.sha256.toLowerCase().startsWith(parsed.sha12)`). Otherwise the chunk is cited at `blob/HEAD/<path>` with `commit: dataset-pin:corpus:unrecorded`.

Code chain at 0947001e:

- `docs-search.ts:534`: `FULL_COMMIT = /^[0-9a-f]{40}$/i`; `:537`: `MANIFEST_COMMIT_DEADLINE_MS = 500`.
- `docs-search.ts:555-570` `manifestCommits`: one lookup per distinct `(repo, path)` per reply, each raced against `withDeadline(…, 500)`; a throw, a rejection, a null, a record without a full commit, or a timeout leaves that document out. The search never fails on it.
- `docs-search.ts:597-603` `citableCommit`: `state` must be `active`, `commit` non-null, and the chunk's `sha12` a prefix of the row's `sha256`.
- `docs-search.ts:572-583` `withCorpusProvenance`: `source_url = corpusSourceUrl(repo, path, recorded)`, `commit = recorded ?? dataset-pin:corpus:unrecorded`, `dataset: corpus`.
- `packages/mcp-server/src/service.ts:6421`: `manifestCommit: async (repo, path) => (await this.corpusStore()?.rowFor(repo, path)) ?? null`, inside `Substrate.searchDocs`. The MCP and REST routes both reach it.
- `packages/mcp-server/src/corpus/store.ts:178-182` `rowFor` returns the row in any state; the state gate is now in `citableCommit`, not in the store.
- `packages/corpus/src/protocol.ts:429-437` `sourceUrl(repo, path, commit?)` emits `blob/<commit or HEAD>/<path>` for a GitHub-origin repo.

Advisories of the draft, now:

- **A1 (old chunk at newer commit): closed.** `citableCommit` compares the chunk's sha12 with the row's sha256. Test "a chunk indexed from an older version is cited at HEAD, not at the newer commit" (`citations.test.ts:80`), passed in r37.
- **A2 (tombstoned row cited at its commit): closed.** `citableCommit` requires `state === "active"`. Test "a tombstoned document is cited at HEAD, not at its commit" (`citations.test.ts:86`), passed in r37. The owner decision the draft asked for is now in code: an active row, content-matched, is the only source of a commit.
- **A3 (no test on the production wiring): closed.** Test "a docs search through the service cites the commit the corpus manifest records" (`docs-search.test.ts:668`, describe "LightRAG search and the RAGFlow plane"). It builds a `Substrate` with a `FakeStore` holding an active row with a recorded commit, serves a LightRAG chunk named with the row's sha, and asserts `source_url` `blob/<commit>/docs/data%20planes.md`, `commit`, and `dataset: corpus`. Passed in r37 (0.010 s). It goes through `Substrate.searchDocs`, so it exercises `service.ts:6421`.

Tests in gate r37 (`corpus citations`, `packages/mcp-server/src/corpus/citations.test.ts`; each testcase has no failure, error or skipped child):

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
| a manifest lookup that never answers is abandoned at its deadline, and the document is cited at HEAD | 148 (0.501399 s) |

Carried over in the same suite: `the corpus dataset` "is searched by default and has a trigger row" (`citations.test.ts:158`).

The test at `citations.test.ts:65` asserts `source_url` = `https://github.com/swcstudiospace/agent-substrate/blob/${COMMIT}/docs/data%20planes.md` and `commit` = `COMMIT` for a full 40-hex recorded commit on an active, content-matched row. That is the test the previous record asked for.

Reading of the criterion: the owner decision is that the commit reaches the citation URL. It does, through the manifest row. The plane document's source still carries only the name (`lightrag-bulk.ts:234`, `file_sources = doc.name`; `ingest.ts:256-257`). The amended SC4 text equates the document source with its citation URL, and the owner decision does not require the plane source to hold the commit. This is recorded as the reading, not as a waiver.

## Success criteria

| # | Criterion (as amended) | Status | Evidence |
|---|---|---|---|
| 1 | Scan deterministic; clones and worktrees collapse; identical copies collapse with bounded report; a rename only within one repository; a copy in another collection is an add plus a tombstone; exclusions and size caps | VERIFIED (carried forward, unchanged code) | `packages/mcp-server/src/corpus/plan.ts:68-85` pairs a removed row with a new entry only on `keyOf(repo, sha256)`. r37: "a rename never crosses repositories", "the same text at a new path is one rename, naming the row it moved from, not an add plus a tombstone", "renames pair one to one: two removed rows and one new copy leave one tombstone" (planCorpus: the six actions). Scan side `packages/corpus/src/scan.ts` unchanged since a46d42c3. |
| 2 | `scan`, `plan`, `ingest`, `status` work against a server; `plan` sends no bodies and prints counts; `ingest` is a dry run until `--execute` | VERIFIED (carried forward) | Server doors `server.ts` (`POST /corpus/plan`, `POST /corpus/ingest`, `GET /corpus/status`). r37: "a plan counts add, change, rename and tombstone against the manifest and writes nothing" (POST /corpus/plan and GET /corpus/status); "a tombstone-only request (no documents) is accepted and removes the row" (POST /corpus/ingest). Not exercised against a live server (human item 1). |
| 3 | Migration step creates `corpus_documents` (additive, reversible, digest fixture, rollback-compat doc); the four routes and MCP tools audited and admitted; the table is in the index archive and restore spec with its restore tested | VERIFIED (carried forward) | Step 35 `packages/mcp-server/src/index-store.ts:701-727` (`create table if not exists corpus_documents`, `down` drops it); digest `packages/mcp-server/src/index-store.migrations.digests.json:36`. Archive spec `index-archive-spec.ts:216`. r37: "after a restore, a plain insert into corpus_documents takes a manifest_seq above every restored one" (index archive against a live index). `docs/runbooks/rollback-compat.md:48` names step 35. |
| 4 | LightRAG bulk path: batches through `POST /documents/texts` with bounded concurrency and one poll per batch; redacts and refuses secrets as `docs_ingest` does; carries repo, path and **commit** into the document source (its citation URL); kind and tier stay in the manifest, which also records the commit; the plane document carries name and text | VERIFIED (amended wording, read as in "Reading of the criterion" above) | Route and bounds: `packages/mcp-server/src/planes/lightrag-bulk.ts:234-235` (`POST /documents/texts`), `:276-278` (one `waitIdle` per batch). Bounded concurrency `ingest.ts:482` `runBounded(batches, deps.settings.concurrency, …)`. Secret refusal `ingest.ts:248`. The citation URL carries the commit through `docs-search.ts:572-583` (see Citation audit). `lightrag-bulk.ts` unchanged since a46d42c3. |
| 5 | Removed or renamed document tombstoned: plane document deleted through `delete_document` only when no other active row shares it; row `tombstoned`; rename only within one repository; a copy in another collection is an add plus a tombstone; tombstone only for a repository the scan covered completely, at the declared scope; narrower scans leave earlier documents untouched | VERIFIED (carried forward, re-observed) | `ingest.ts:270` (`activeReferences(id) > 0` keeps a shared plane document), phase T `ingest.ts:393` (`deleteDocuments`), `:403` (`delete-failed` leaves the row ACTIVE). Scope `plan.ts:12-14`. Refusals `corpus/service.ts:99,116` (`tombstone-scope-required`, `tombstone-out-of-scope`), emitted at `:192`. Unchanged code. |
| 6 | Second identical run reports `unchanged` and sends nothing; a killed run resumes without re-sending recorded documents | VERIFIED (carried forward, re-observed) | `ingest.ts:238-241` (same sha, source, kind, tier and marker → `unchanged`); `ingest.ts:296-315` records each accepted document per batch. r37: "a document already recorded at the same sha is unchanged: nothing is sent, and a second identical run sends nothing" (ingestCorpus: documents); "a run killed after the first batch resumes with only the documents it had not recorded" (ingestCorpus: plane failures and resuming). |
| 7 | Source adapters for a Greptile export directory and for GitHub through `gh` produce the same entries; both bounded by `--max-repos` and `--tier` | VERIFIED (carried forward, re-observed) | `packages/corpus/src/adapters/greptile-export.ts` (`<owner>/<repo>/<path>.md` as tier-2 `greptile-kb`). r37: "reads <owner>/<repo>/<path>.md files as tier-2 greptile-kb entries and ignores everything else" (scanGreptileExport); "a tier bound below 2 reads nothing, since every document is tier 2" (scanGreptileExport). `adapters/github.ts:29-30` defaults, `:139-171` bounded limiter; r37: "the tier bound drops research at tier 1 and brings loose notes at tier 3, without fetching what it drops" (scanGithub). CLI bounds `cli/src/corpus/index.ts`. A real Greptile export and live `gh` not run (human items 2 and 3). |

**Score:** 7/7 truths verified (0 behavior-unverified). SC4 holds under its amended wording at 0947001e.

## Required artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/corpus/src/{protocol,scan,classify}.ts` | closed enums, bounds, scan, collapse, caps; `sourceUrl` with commit | VERIFIED | `protocol.ts:57-101` bounds; `sourceUrl` `:429-437`. |
| `packages/mcp-server/src/corpus/{plan,ingest,service,store,validate,routes}.ts` | server doors and ingest | VERIFIED | r37 (above). `store.ts:178-182` `rowFor` returns the row in any state; `citableCommit` applies the state gate. |
| `packages/cli/src/corpus/{index,ingest,client,inventory}.ts` | CLI commands and client | VERIFIED | Carried forward. |
| `packages/mcp-server/src/index-store.ts` step 35 | additive `corpus_documents` | VERIFIED | `:701-727`; digest `…digests.json:36`. |
| `packages/mcp-server/src/index-archive-spec.ts` `corpus_documents` | archive spec, closed list | VERIFIED | `:216`. |
| `packages/mcp-server/src/planes/lightrag-bulk.ts` | bulk insert, wait, map, delete | VERIFIED | `:234-235`, `:276-278`, delete. Unchanged since a46d42c3. |
| `packages/mcp-server/src/docs-search.ts` `withCorpusProvenance` / `citableCommit` | corpus citation with commit, active and content-matched only | VERIFIED | `:534-537`, `:555-570`, `:572-583`, `:597-603`; `:1150` applied in `searchDocsLightrag`. |
| `packages/mcp-server/src/service.ts` `manifestCommit` | production wiring of the row lookup | VERIFIED | `:6421` (passes the whole row since 0947001e). Exercised by `docs-search.test.ts:668`. |

## Key link verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `cli/src/corpus/ingest.ts` | `POST /corpus/ingest` | `client.ingest` with `scope` | WIRED | Carried forward. |
| `server.ts` (corpus route) | `substrate.corpusIngest` → `ingestCorpus` | route handler | WIRED | `corpus_ingest` audit (fail-closed) before the call. |
| `ingest.ts` | `planes/lightrag-bulk.ts` | `plane.insertBatch` / `plane.deleteDocuments` | WIRED | `ingest.ts:274-276`, `:351`, `:393`. |
| `ingest.ts` | `corpus_documents` | `CorpusStore` writes, `manifest_seq` identity | WIRED | `store.ts`; PG tests write and read the table. |
| `index-archive-spec.ts` | `index-store.ts` step 35 | closed whitelist vs `information_schema` | WIRED | `index-archive.test.ts` on a live database (r37). |
| manifest row commit → `docs_search` citation URL | `sourceUrl(repo, path, commit)` | `store.rowFor` → `service.ts:6421` → `manifestCommits` → `citableCommit` → `withCorpusProvenance` | WIRED | Tests: `citations.test.ts:65`, `docs-search.test.ts:668`. |

## Requirements coverage

| Requirement | Status | Evidence |
|---|---|---|
| ATLAS-01 (scan, collapse, rename within one repository, copy as add plus tombstone) | SATISFIED | SC1; `plan.ts:68-85`; r37 `planCorpus: the six actions`. |
| ATLAS-02 (`plan` reports add, change, rename, tombstone without bodies) | SATISFIED | SC2; r37 "a plan counts add, change, rename and tombstone…". |
| ATLAS-03 (bulk route, repo, path and commit provenance, the citation URL carrying the commit; no serial wait; secrets refused) | SATISFIED | Route, wait and secret refusal (SC4); the citation URL carries the active, content-matched manifest commit (`citations.test.ts:65`, `docs-search.test.ts:668`, `docs-search.ts:597-603`, `service.ts:6421`). |
| ATLAS-04 (tombstone only within a completely covered scan) | SATISFIED | SC5; `plan.ts:12-14`. |
| ATLAS-05 (second run unchanged, resume after kill) | SATISFIED | SC6; r37 "a document already recorded at the same sha is unchanged…", "a run killed after the first batch resumes…". |
| ATLAS-06 (Greptile and GitHub adapters into the same manifest) | SATISFIED | SC7; r37 `scanGreptileExport` and `scanGithub` titles above. Real export and live `gh` not run. |

**Orphaned requirements:** none. ATLAS-01 to ATLAS-06 map to phase 63.

## Anti-patterns found

A grep of the phase 63 covered set for TODO, FIXME, XXX, not-implemented and placeholder returns, over the changed lines since a46d42c3, matches nothing in the three changed files.

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| (none) | - | - | - | - |

## Deferred items

None. Phases 64 to 66, 69 and 70 build on this manifest; that is not a deferral of a phase 63 criterion.

## Advisories (not failures of SC4 or ATLAS-03)

- **A4. f0f3c04e removed the runbook-naming test** in `rollback-compat.test.ts` ("every step added since is named in docs/runbooks/rollback-compat.md"; the commit calls the tests wording-only). The runbook still names step 35 (`rollback-compat.md:48`), so the document evidence for criterion 3 holds. Nothing now fails if a future step is left out of the runbook. Still open at 0947001e.
- **A5. Latency and eval.** A `docs_search` reply can wait up to 500 ms for its slowest manifest lookup; the lookups run in parallel after retrieval (`docs-search.ts:555-570`, `:1150`). The golden eval harness (`docs-golden.ts:203`) does not pass `manifestCommit`, so its corpus citations stay at HEAD. Eval only. Still open.
- **A6. Test count.** `corpus citations` has twelve cases in `citations.test.ts` (lines 40 to 148), and `the corpus dataset` has one (line 158). The 885e73ce message's "six cases" is out of date; not a code issue.

## Unsettled

- `packages/mcp-server/src/docs-search.test.ts` holds the A3 test (`:668`) and was changed in 0947001e, but it is not in the frontmatter `covered_files` list. The list is taken unchanged from the existing record, as instructed. Whether it should be added is for the owner or the next re-verification.
- The `covered_files` value is a single-line flow list in the existing record, not a block list; it was copied as found.

## Human verification required (carried forward; not counted, not observed in this pass)

These remain open. Nothing here observed them.

1. **Live ingest.** Run `substrate corpus ingest --execute` against the live corpus with the server on `SUBSTRATE_CORPUS=on` and a LightRAG backend, after the dry-run plan. Expected: batches report `ingested`; a repeat run reports `unchanged` and sends nothing; no secret refusals on the real corpus.
2. **Greptile export.** Ingest a real Greptile knowledge-base export directory. Expected: the `<owner>/<repo>/<path>.md` layout is read as tier-2 `greptile-kb` entries.
3. **GitHub through `gh`.** Ingest repositories with no local clone through a logged-in `gh`. Expected: the same entry shape as the Greptile source.
4. **Migration step 35 and the archive on production.** Apply step 35 to a restored dump and run the rollback check (`docs/runbooks/rollback-compat.md`). Take a new index archive on this release: an archive written before `ebabe6ef` fails `verify-archive` (kind `schema`). Expected: the step applies and reverses; the new archive passes `verify-archive`; restoring it reproduces `corpus_documents` with its `manifest_seq` values.
5. **Citation on live data.** After item 1, a `docs_search` for a GitHub-origin corpus document shows `blob/<40-hex>/<path>` and a `commit` equal to that path's manifest row, for an active row whose content matches the indexed chunk. Expected: the commit matches the manifest; `HEAD` appears only for a document with no recorded commit, a tombstoned row, or a chunk indexed from an older version.

## Gaps summary

None. SC4 and ATLAS-03 hold at 0947001e. The commit the manifest records for an active, content-matched GitHub-origin corpus document reaches the `docs_search` citation URL (`blob/<commit>/<path>`) and its `commit` field, asserted by `citations.test.ts:65` and `docs-search.test.ts:668` in gate r37, with the 500 ms lookup deadline asserted by `citations.test.ts:148`. Criteria 1 to 3 and 5 to 7 hold as before. Status is `human_needed` because the four human items (five with item 5) remain open. Advisories A4 to A6 are not gaps; A4 and A5 stay open.

---

_Verified: 2026-11-06T01:10:45Z_
_Verifier: gsd-verifier procedure, agent Verify63Final (read-only on the repository; no tests run; gate r37 JUnit read)_
