---
phase: 63-corpus-atlas
verified: 2026-11-05T07:10:41Z
status: human_needed
score: 7/7 must-haves verified (criteria 1 to 7 VERIFIED against the criteria as amended by the owner decisions of 2026-11-04; 0 behavior-unverified)
covered_files: [".env.example", ".planning/phases/63-corpus-atlas/63-SUMMARY.md", "bun.lock", "docs/config-reference.md", "docs/corpus.md", "docs/data-planes.md", "docs/docs-plane.md", "docs/event-vocabulary.md", "docs/mcp-audit.md", "docs/runbooks/corpus-ingest.md", "docs/runbooks/index-archive.md", "docs/runbooks/rollback-compat.md", "package.json", "packages/audit/src/policy.test.ts", "packages/audit/src/policy.ts", "packages/cli/package.json", "packages/cli/src/corpus/bodies.test.ts", "packages/cli/src/corpus/bodies.ts", "packages/cli/src/corpus/client.test.ts", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.test.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/ingest.ts", "packages/cli/src/corpus/inventory.test.ts", "packages/cli/src/corpus/inventory.ts", "packages/cli/src/corpus/render.test.ts", "packages/cli/src/corpus/render.ts", "packages/cli/src/corpus/testkit.ts", "packages/cli/src/index.ts", "packages/corpus/package.json", "packages/corpus/src/adapters/github.test.ts", "packages/corpus/src/adapters/github.ts", "packages/corpus/src/adapters/greptile-export.test.ts", "packages/corpus/src/adapters/greptile-export.ts", "packages/corpus/src/classify.test.ts", "packages/corpus/src/classify.ts", "packages/corpus/src/discover.test.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/guards.ts", "packages/corpus/src/index.ts", "packages/corpus/src/names.test.ts", "packages/corpus/src/names.ts", "packages/corpus/src/protocol.ts", "packages/corpus/src/scan.test.ts", "packages/corpus/src/scan.ts", "packages/corpus/src/similarity.test.ts", "packages/corpus/src/similarity.ts", "packages/corpus/src/test-support.ts", "packages/mcp-server/package.json", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/citations.test.ts", "packages/mcp-server/src/corpus/ingest.test.ts", "packages/mcp-server/src/corpus/ingest.ts", "packages/mcp-server/src/corpus/mutex.test.ts", "packages/mcp-server/src/corpus/mutex.ts", "packages/mcp-server/src/corpus/names.test.ts", "packages/mcp-server/src/corpus/names.ts", "packages/mcp-server/src/corpus/plan.test.ts", "packages/mcp-server/src/corpus/plan.ts", "packages/mcp-server/src/corpus/routes.test.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/settings.test.ts", "packages/mcp-server/src/corpus/store.test.ts", "packages/mcp-server/src/corpus/store.ts", "packages/mcp-server/src/corpus/testkit.ts", "packages/mcp-server/src/corpus/validate.test.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/docs-datasets.ts", "packages/mcp-server/src/docs-ingest.test.ts", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-archive-spec.ts", "packages/mcp-server/src/index-archive-watch.ts", "packages/mcp-server/src/index-archive.test.ts", "packages/mcp-server/src/index-archive.ts", "packages/mcp-server/src/index-store.archive.test.ts", "packages/mcp-server/src/index-store.migrate-contract.test.ts", "packages/mcp-server/src/index-store.migrate-harness.test.ts", "packages/mcp-server/src/index-store.migrations.digests.json", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planes/__fixtures__/lightrag-v1.5.7-routes.json", "packages/mcp-server/src/planes/lightrag-bulk.test.ts", "packages/mcp-server/src/planes/lightrag-bulk.ts", "packages/mcp-server/src/planes/lightrag.contract.test.ts", "packages/mcp-server/src/planes/lightrag.test.ts", "packages/mcp-server/src/planes/lightrag.ts", "packages/mcp-server/src/rollback-compat.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:757f1c2e6a5dc64c4e122c8c5e36045f496be34db9ae32bc8f732f0e5c44aea0"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 7/7
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Live ingest. Run `substrate corpus ingest --execute` against the live corpus with the server on SUBSTRATE_CORPUS=on and a LightRAG backend, after the dry-run plan."
    expected: "Batches report `ingested`; a repeat run reports `unchanged` and sends nothing; no secret refusals on the real corpus."
    why_human: "Operator-gated: needs the live server, the LightRAG backend and the real corpus. Not run here."
  - test: "Greptile export. Ingest a real Greptile knowledge-base export directory."
    expected: "The `<owner>/<repo>/<path>.md` layout is read as tier-2 greptile-kb entries."
    why_human: "The layout is confirmed only against a real export, which is not available to the verifier. The fixture test (greptile-export.test.ts:20) pins the layout as the code reads it."
  - test: "GitHub through gh. Ingest repositories that have no local clone through a logged-in gh."
    expected: "The same entry shape as the Greptile source; bounded by --max-repos and --tier."
    why_human: "Needs a logged-in gh and network access to GitHub. The adapter is tested with a fake gh runner (github.test.ts:150)."
  - test: "Migration step 35 and the archive on production. Apply step 35 to a restored dump and run the rollback check in docs/runbooks/rollback-compat.md. Take a new index archive on this release: the schema hash changed, so an archive written before ebabe6ef fails verify-archive (kind schema)."
    expected: "The step applies and reverses; the new archive passes verify-archive; restoring it reproduces corpus_documents with its manifest_seq values."
    why_human: "Operator action on the production index. Not run here; the scratch round trip is covered by the Postgres tests below."
---

# 63-VERIFICATION: Corpus Atlas (v1.7 phase 63)

**Phase Goal:** The documentation of every repository the owner keeps (the clones on the VPS, the GitHub organisations, the Greptile knowledge bases) is discovered, classified, de-duplicated and recorded in one manifest, and a bulk path puts new and changed documents into the docs plane with provenance and removes the ones that disappeared.
**Verified:** 2026-11-05T07:10:41Z
**Status:** human_needed
**Re-verification:** Yes. The previous record (head 835a2742, status human_needed, 7/7, digest `v3:sha256:04f9f593…`) is replaced. Each corpus criterion was re-checked at head 42e3cf13: the changes in range touch no corpus code (see below), and the three Postgres-gated files and the non-PG set were re-run.

**Head:** 42e3cf13 (integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`)
**Changes since the previous record (835a2742) that touch covered files:** `42e3cf13` range `835a2742..HEAD` changes three covered files: `packages/mcp-server/src/service.ts` (the in-process last-good brief and the brief-snapshot forget mark, `briefForgottenAtMs`), `packages/mcp-server/src/flag-registry.ts` (the `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` help text) and `docs/config-reference.md` (the same row). None of their hunks touches corpus scan, plan, ingest, routes, plane, manifest, migration or archive code (`git diff 835a2742..HEAD` over the three files, filtered for `corpus`, is empty). SC1 to SC7 are therefore carried forward on the same corpus code and re-observed by the runs below. The covered list is unchanged; the digest moves because the content of those three files changed.
**Covered set:** 95 files, from `gsd_run query verification.fingerprint .planning/phases/63-corpus-atlas <files>`. The set is the 89 files of the replaced record plus six phase files changed by `ebabe6ef` and the runbook. The planning-root ROADMAP and REQUIREMENTS edits are inert for the fingerprint.

## Gates

No repository gate was run here (the full suite, tsc, lint and formatters are out of scope for this record). Targeted runs only, observed at head 42e3cf13 on 2026-11-05.

| Run | Files | Result |
|---|---|---|
| `env -u SUBSTRATE_TEST_PG_URL bun test` (non-PG, one command) | 31 phase test files: `packages/audit/src/policy.test.ts`; `packages/cli/src/corpus/{bodies,client,index,inventory,render}.test.ts`; `packages/corpus/src/adapters/{github,greptile-export}.test.ts`; `packages/corpus/src/{classify,discover,names,scan,similarity}.test.ts`; `packages/mcp-server/src/corpus/{citations,ingest,mutex,names,plan,routes,settings,validate}.test.ts`; `packages/mcp-server/src/{docs-ingest,observe,rollback-compat,index-store.migrate-contract,index-store.migrate-harness,index-archive,index-store.archive}.test.ts`; `packages/mcp-server/src/planes/{lightrag-bulk,lightrag.contract,lightrag}.test.ts` | 947 pass, 12 skip, 0 fail (959 tests, 31 files, 4894 expect calls, 14.3 s). The 12 skips are the PG-gated tests, which the Postgres runs below cover. |
| `SUBSTRATE_TEST_PG_URL=<scratch>/substrate_test_v63 bun test packages/mcp-server/src/corpus/store.test.ts` | manifest store (`corpus_documents` reads and writes) | 15 pass, 0 fail, 61 expect calls, 0 skip |
| same, `packages/mcp-server/src/index-archive.test.ts` | archive spec, verifier, gates | 65 pass, 0 fail, 1325 expect calls, 0 skip |
| same, `packages/mcp-server/src/index-store.archive.test.ts` | archive round trip, whitelist test, corpus restore tests | 10 pass, 0 fail, 261 expect calls, 0 skip |

Postgres: scratch Postgres 16.15 container on 127.0.0.1:5439, database `substrate_test_v63`. Not production. Each file ran in its own process, re-run at head 42e3cf13. The connection string is held in a shell variable and not recorded here. No production database and no port 5432 was touched.

## Success criteria

| # | Criterion (as amended) | Status | Evidence |
|---|---|---|---|
| 1 | Scan returns sorted, deterministic entries; clones and worktrees collapse; byte-identical copies collapse with the scan report listing them (bounded); the next copy becomes canonical; a rename is reported only within one repository, and a copy that moves to another collection is an add plus a tombstone; exclusions and size caps hold | VERIFIED | Three levels. Artifact: `packages/mcp-server/src/corpus/plan.ts:68-85` pairs a removed row with a new entry only on `keyOf(repo, sha256)`; a moved copy in another repository is never paired, so it is an add plus a tombstone. Scan side: `packages/corpus/src/scan.ts:80-96` (`IdenticalGroup`, bounded `collapsed` report), `:423` `collapseIdentical`, `:177` `inspectBytes` (empty, too-large, binary rules); `classify.ts:26` `EXCLUDED_SEGMENTS`. Wiring: `planCorpus` is the function behind `POST /corpus/plan`. Behaviour: `plan.test.ts:42` (same text at a new path is one rename), `:49` (renames pair one to one), `:59` "a rename never crosses repositories", `:66` (a change is not a rename candidate). Scan fixtures in `scan.test.ts` and `classify.test.ts` pass in the non-PG run. |
| 2 | `substrate corpus scan`, `plan`, `ingest` and `status` work against a server; `plan` sends entries without bodies and prints counts; `ingest` is a dry run until `--execute` | VERIFIED | CLI: `packages/cli/src/corpus/index.ts:4-13` (usage: `scan`, `plan`, `ingest [--execute]`, `status`), `:730` the dry-run print ends "add --execute to ingest this plan". Server doors: `server.ts:1741` `POST /corpus/plan`, `:1766` `POST /corpus/ingest`, `:1794` `GET /corpus/status`. Behaviour: `routes.test.ts:217` "a plan counts add, change, rename and tombstone against the manifest and writes nothing", `:179` tombstone-only request, `cli/src/corpus/index.test.ts` and `ingest.test.ts` (non-PG and PG run). Not exercised against a live deployed server (see human items). |
| 3 | A migration step creates `corpus_documents` (additive, reversible, digest fixture and rollback-compat doc updated); `POST /corpus/plan`, `POST /corpus/ingest`, `GET /corpus/status`, MCP `corpus_status` (read, fail-open) and `corpus_ingest` (write, fail-closed) are audited and admitted; the table is covered by the index archive and restore spec and its restore is tested | VERIFIED | Three levels. Artifacts: step 35 `index-store.ts:701-727` (`expand`, `create table if not exists`, `down` drops the table, identity `manifest_seq`, three indexes). Digest: `index-store.migrations.digests.json:36` `"35": "afc41214…"`. Rollback doc: `docs/runbooks/rollback-compat.md:48` row for step 35; test pin `rollback-compat.test.ts:636`. Doors and admission: `admission.ts:205-208` (`/corpus/plan` read, `/corpus/status` read, `/corpus/ingest` write), `:252-253` (`corpus_status` read, `corpus_ingest` write); `mcp.ts:1683` `corpus_status`, `:1700` `corpus_ingest`; audit `packages/audit/src/policy.ts:48` (`corpus_ingest` fail-closed) and `:131` (`corpus_status` fail-open). Archive: `index-archive-spec.ts:216` `corpus_documents` (17 columns, primary key `(repo, path)`), listed in the closed whitelist. Restore: `index-store.ts:3062-3063` `advanceIdentity` contract, `:3134` implementation moves each identity sequence past the restored maximum. Tests: `index-archive.test.ts` (whitelist equals `migrate()`, PG 65/65), `index-store.archive.test.ts` (round trip and restored sequence, PG 10/10), `corpus/store.test.ts` (PG 15/15), `rollback-compat.test.ts` and `index-store.migrate-harness.test.ts` (non-PG, pass). |
| 4 | The LightRAG bulk path sends batches through `POST /documents/texts` with bounded concurrency and one pipeline poll per batch, redacts and refuses secrets as `docs_ingest` does, and carries repo and path into the document source; kind, tier and commit stay in the manifest, and the plane document carries name and text | VERIFIED | Three levels. Artifact: `planes/lightrag-bulk.ts:231-236` sends `POST /documents/texts` with `{texts, file_sources}`, one `bulkTimeoutMs` budget; `:276-278` `waitIdle` once per batch; `:92-95` batch bounds (100 documents, 4 MB). Bounded concurrency: `ingest.ts:485` `runBounded(batches, deps.settings.concurrency, …)`. Plane document: `ingest.ts:105-106` and `:260` `toBulk` carries `{name, text}` only; kind, tier, commit and `supersededBy` are recorded in the manifest row (`ingest.ts:303-304`). Secrets: a secret finding refuses that document alone (`ingest.test.ts:70`), and the body must hash to its entry's sha256 before it leaves (`ingest.ts:17-18`). Wiring: `ingestCorpus` is called from the `POST /corpus/ingest` route and the `corpus_ingest` tool. Tests: `lightrag-bulk.test.ts` and `ingest.test.ts` (non-PG); the route fixture `planes/__fixtures__/lightrag-v1.5.7-routes.json` carries `texts`. |
| 5 | A removed or renamed document is tombstoned: its plane document is deleted through `delete_document` only when no other active row shares it; its row says `tombstoned`; a rename (same sha, new path) is a rename only within one repository; a copy that moves to another collection is an add plus a tombstone; a tombstone is created only for a repository the scan covered completely, at the declared scope; narrower scans leave earlier documents untouched | VERIFIED (carried forward, re-observed) | Artifact: `ingest.ts:367-411` phase T: `activeReferences(id) > 0` keeps a shared plane document (`:273`), `deleteDocuments` for the rest (`:396`), row marked `tombstoned` only after confirmed deletion (`:406-411`, `delete-failed` otherwise). Scope: `plan.ts:12-14` and `:65` (a row is a candidate only when its `(repo, source)` is covered and its tier is within `scope.maxTier`; empty coverage tombstones nothing); the server refuses an out-of-scope tombstone with 403 `tombstone-out-of-scope` (`routes.test.ts:203`). Behaviour: `ingest.test.ts:294` (tombstone deletes and marks the row), `:313` (shared plane document never deleted), `:351` (rename leaves one plane document under the new name), `plan.test.ts:59`. |
| 6 | A second identical run reports `unchanged` for every document and sends nothing; a run killed half way resumes without re-sending recorded documents | VERIFIED (carried forward, re-observed) | `ingest.ts:240-243`: a row at the same sha, source, kind, tier and marker is `unchanged` and not sent. Behaviour: `ingest.test.ts:103` (a second identical run sends nothing), `:198` (a run killed after the first batch resumes with only the documents not recorded). Batches record each accepted document (`ingest.ts:296-315`), so a crash between batches leaves only unrecorded documents to send. |
| 7 | Source adapters for a Greptile export directory and for GitHub repositories through `gh` produce the same entries; both are bounded by `--max-repos` and `--tier` | VERIFIED (carried forward, re-observed) | `packages/corpus/src/adapters/greptile-export.ts` reads `<owner>/<repo>/<path>.md` as tier-2 `greptile-kb` entries (`greptile-export.test.ts:20`); a tier bound below 2 reads nothing (`:97`). `adapters/github.ts:29` `DEFAULT_GITHUB_MAX_REPOS = 50`, `:30` `DEFAULT_GITHUB_CONCURRENCY = 4`, `:139-171` bounded limiter; the tier bound drops research before fetching it (`github.test.ts:150`). CLI bounds: `cli/src/corpus/index.ts:211-216` (`--max-repos` positive integer), tier 1 to 3 at `:203`. Both adapters run in the non-PG run. No live Greptile export and no `gh` run (see human items). |

## Required artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/corpus/src/{protocol,scan,classify}.ts` | closed enums, bounds, scan, collapse, caps | VERIFIED | `protocol.ts:57-101` (`DOC_TIERS`, `CORPUS_SOURCES`, `PLAN_ACTIONS`, `MAX_PLAN_ENTRIES`, `MAX_COVERAGE_PAIRS`, `MAX_INGEST_DOCUMENTS` 200, `MAX_INGEST_TOMBSTONES` 500). Scan and classify tests pass. |
| `packages/mcp-server/src/corpus/{plan,ingest,service,store,validate,routes}.ts` | server doors and ingest | VERIFIED | plan, ingest, validate and routes tests pass; `corpus/store.test.ts` 15/15 on scratch Postgres. |
| `packages/cli/src/corpus/{index,ingest,client,inventory}.ts` | CLI commands and client | VERIFIED | `index.ts` usage and flag parsing; `ingest.ts:98-165` tombstones in their own requests, then bounded batches. Tests pass. |
| `packages/mcp-server/src/index-store.ts` step 35 | additive `corpus_documents` | VERIFIED | `:701-727`; digest `index-store.migrations.digests.json:36`; `advanceIdentity` `:3134`. |
| `packages/mcp-server/src/index-archive-spec.ts` `corpus_documents` | archive spec, closed list | VERIFIED | `:216`; whitelist test equals `migrate()`; round trip and restored sequence pass on scratch Postgres. |
| `packages/mcp-server/src/planes/lightrag-bulk.ts` | bulk insert, wait, map, delete | VERIFIED | `:231-236` insert, `:276-278` one wait per batch, `:448-455` delete confirmed only by an idle pipeline. |

## Key link verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `cli/src/corpus/ingest.ts` | `POST /corpus/ingest` | `client.ingest` with `scope` | WIRED | tombstones sent with the plan scope (`ingest.ts:157`). |
| `server.ts:1766` | `substrate.corpusIngest` → `ingestCorpus` | route handler | WIRED | `corpus_ingest` audit (fail-closed) before the call. |
| `ingest.ts` | `planes/lightrag-bulk.ts` | `plane.insertBatch` / `plane.deleteDocuments` | WIRED | `ingest.ts:274-276`, `:396`. |
| `ingest.ts` | `corpus_documents` | `CorpusStore` writes, `manifest_seq` identity | WIRED | `store.ts`; PG tests write and read the table. |
| `index-archive-spec.ts` | `index-store.ts` step 35 | closed whitelist vs `information_schema` | WIRED | `index-archive.test.ts` compares columns on a live database (PG 65/65). |

## Requirements coverage

| Requirement | Status | Evidence |
|---|---|---|
| ATLAS-01 (scan, collapse, rename within one repository, copy as add plus tombstone) | SATISFIED | SC1 evidence; owner decision of 2026-11-04 applied (`plan.ts:68-85`, `plan.test.ts:59`). |
| ATLAS-02 (`plan` reports add, change, rename, tombstone without bodies) | SATISFIED | SC2 evidence; `routes.test.ts:217`. |
| ATLAS-03 (bulk ingest route, repo and path provenance, no serial wait per page, secrets refused) | SATISFIED | SC4 evidence; plane document carries name and text (owner decision of 2026-11-04). |
| ATLAS-04 (tombstone only within a completely covered scan) | SATISFIED | SC5 evidence; `plan.ts:12-14`, `routes.test.ts:203`. |
| ATLAS-05 (second run unchanged, resume after kill) | SATISFIED | SC6 evidence; `ingest.test.ts:103`, `:198`. |
| ATLAS-06 (Greptile and GitHub adapters into the same manifest) | SATISFIED | SC7 evidence; adapter tests pass. Real Greptile export and live `gh` not run: human items. |

**Orphaned requirements:** none. REQUIREMENTS.md maps ATLAS-01 to ATLAS-06 to phase 63, and all six appear in the plan.

## Anti-patterns found

Grep of `packages/corpus/src`, `packages/cli/src/corpus`, `packages/mcp-server/src/corpus` and `planes/lightrag-bulk.ts` for TODO, FIXME, XXX, not-implemented and placeholder. The only match is a test fixture name (`classify.test.ts`, `.planning/TODO.md`). Stub returns were not separately searched beyond the cited code paths, which are real implementations.

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| (none) | - | - | - | - |

## Deferred items

None. Step 9b: later phases do not defer any gap of this phase. Phases 64 to 66, 69 and 70 build on this manifest (per the SUMMARY), which is not a deferral of a phase-63 criterion.

## Advisory (New Scope, Unevidenced)

- The single-flight lock (`mutex.ts`, `ingest.ts:50`) is per server process; two server processes would not exclude each other (SUMMARY "What remains").

## Human verification required

Status is `human_needed` because all seven criteria are verified and the operator-gated items below remain. They are listed in the `human_verification` frontmatter.

1. **Live ingest.** Run `substrate corpus ingest --execute` against the live corpus with the server on `SUBSTRATE_CORPUS=on` and a LightRAG backend. Expected: a dry-run plan first, then batches that report `ingested`, `unchanged` on a repeat, and no secret refusals on the real corpus.
2. **Greptile export.** Ingest a real Greptile knowledge-base export directory. The `<owner>/<repo>/<path>.md` layout is what the code reads and is unconfirmed against a real export.
3. **GitHub through `gh`.** Ingest repositories with no local clone through a logged-in `gh`. Expected: the same entry shape as the Greptile source.
4. **Migration step 35 and the archive on production.** Apply step 35 to a restored dump and run the rollback check (`docs/runbooks/rollback-compat.md`). Take a new index archive on this release: the schema hash changed, so an archive written before `ebabe6ef` fails `verify-archive` (kind `schema`). Accepted by owner decision 3.

## Gaps summary

No gaps. Criteria 1 to 7 are VERIFIED against the criteria as amended by the owner decisions of 2026-11-04 (SC1, SC4) and the amended ATLAS-01 and ATLAS-03. The earlier SC3 archive gap is closed by `ebabe6ef` and re-observed on scratch Postgres (`index-store.archive.test.ts` 10/10, `index-archive.test.ts` 65/65, `corpus/store.test.ts` 15/15).

---

_Verified: 2026-11-05T07:10:41Z_
_Verifier: Claude (gsd-verifier)_
