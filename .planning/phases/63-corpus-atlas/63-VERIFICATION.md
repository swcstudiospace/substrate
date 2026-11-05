---
phase: 63-corpus-atlas
verified: 2026-11-05T08:00:44Z
status: gaps_found
score: 6/7 must-haves verified (SC4 as amended 2026-11-05 FAILED: the commit does not reach the citation URL; 0 behavior-unverified)
covered_files: [".env.example", ".planning/phases/63-corpus-atlas/63-SUMMARY.md", "bun.lock", "docs/config-reference.md", "docs/corpus.md", "docs/data-planes.md", "docs/docs-plane.md", "docs/event-vocabulary.md", "docs/mcp-audit.md", "docs/runbooks/corpus-ingest.md", "docs/runbooks/index-archive.md", "docs/runbooks/rollback-compat.md", "package.json", "packages/audit/src/policy.test.ts", "packages/audit/src/policy.ts", "packages/cli/package.json", "packages/cli/src/corpus/bodies.test.ts", "packages/cli/src/corpus/bodies.ts", "packages/cli/src/corpus/client.test.ts", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.test.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/ingest.ts", "packages/cli/src/corpus/inventory.test.ts", "packages/cli/src/corpus/inventory.ts", "packages/cli/src/corpus/render.test.ts", "packages/cli/src/corpus/render.ts", "packages/cli/src/corpus/testkit.ts", "packages/cli/src/index.ts", "packages/corpus/package.json", "packages/corpus/src/adapters/github.test.ts", "packages/corpus/src/adapters/github.ts", "packages/corpus/src/adapters/greptile-export.test.ts", "packages/corpus/src/adapters/greptile-export.ts", "packages/corpus/src/classify.test.ts", "packages/corpus/src/classify.ts", "packages/corpus/src/discover.test.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/guards.ts", "packages/corpus/src/index.ts", "packages/corpus/src/names.test.ts", "packages/corpus/src/names.ts", "packages/corpus/src/protocol.ts", "packages/corpus/src/scan.test.ts", "packages/corpus/src/scan.ts", "packages/corpus/src/similarity.test.ts", "packages/corpus/src/similarity.ts", "packages/corpus/src/test-support.ts", "packages/mcp-server/package.json", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/citations.test.ts", "packages/mcp-server/src/corpus/ingest.test.ts", "packages/mcp-server/src/corpus/ingest.ts", "packages/mcp-server/src/corpus/mutex.test.ts", "packages/mcp-server/src/corpus/mutex.ts", "packages/mcp-server/src/corpus/names.test.ts", "packages/mcp-server/src/corpus/names.ts", "packages/mcp-server/src/corpus/plan.test.ts", "packages/mcp-server/src/corpus/plan.ts", "packages/mcp-server/src/corpus/routes.test.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/settings.test.ts", "packages/mcp-server/src/corpus/store.test.ts", "packages/mcp-server/src/corpus/store.ts", "packages/mcp-server/src/corpus/testkit.ts", "packages/mcp-server/src/corpus/validate.test.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/docs-datasets.ts", "packages/mcp-server/src/docs-ingest.test.ts", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-archive-spec.ts", "packages/mcp-server/src/index-archive-watch.ts", "packages/mcp-server/src/index-archive.test.ts", "packages/mcp-server/src/index-archive.ts", "packages/mcp-server/src/index-store.archive.test.ts", "packages/mcp-server/src/index-store.migrate-contract.test.ts", "packages/mcp-server/src/index-store.migrate-harness.test.ts", "packages/mcp-server/src/index-store.migrations.digests.json", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planes/__fixtures__/lightrag-v1.5.7-routes.json", "packages/mcp-server/src/planes/lightrag-bulk.test.ts", "packages/mcp-server/src/planes/lightrag-bulk.ts", "packages/mcp-server/src/planes/lightrag.contract.test.ts", "packages/mcp-server/src/planes/lightrag.test.ts", "packages/mcp-server/src/planes/lightrag.ts", "packages/mcp-server/src/rollback-compat.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:6fee8d0d8f54a29fcfcc1332137e86fe2112518576666c6f4fea616cf26ff1f7"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 7/7
  gaps_closed: []
  gaps_remaining:
    - "SC4 and ATLAS-03 as amended 2026-11-05: the commit reaches the citation URL (not met by the code at 6e5d766e)"
  regressions: []
gaps:
  - truth: "SC4 (amended 2026-11-05): the bulk path carries repo, path and commit into the document source (its citation URL)"
    status: failed
    reason: "The commit is recorded in the manifest and scanned for secrets, but no citation URL a search returns carries it. Plane documents are named corpus:<repo>:<path>@<sha12> (no commit), and every corpus citation is rebuilt with no commit argument, so it names blob/HEAD/<path>."
    artifacts:
      - path: "packages/mcp-server/src/docs-search.ts"
        issue: "withCorpusProvenance (:522-531, called at :1117) sets source_url = corpusSourceUrl(parsed.repo, parsed.path) with no commit; commit field is the constant dataset-pin:corpus:unrecorded."
      - path: "packages/corpus/src/protocol.ts"
        issue: "sourceUrl (:429-437) accepts a commit and emits blob/<commit>/<path>, but its only callers that pass one are the secret scan in ingest.ts (:197, :251)."
      - path: "packages/mcp-server/src/corpus/ingest.ts"
        issue: "toBulk (:259-261) sends {name, text} only; name is corpusDocumentName(repo, path, sha256) (names.ts:125), which holds no commit."
      - path: "packages/mcp-server/src/planes/lightrag-bulk.ts"
        issue: "insertBatch sends file_sources = doc.name (:234), so the plane source carries no commit."
    missing:
      - "Carry the commit to the citation: either the plane source/name includes it (decide the name format; parseCorpusDocumentName and isSafeCorpusName pin it today) or withCorpusProvenance looks up the active manifest row's commit and calls sourceUrl(repo, path, commit)."
      - "A test that a docs_search citation for a GitHub-origin corpus document with a recorded commit names blob/<commit>/<path>. Today names.test.ts:116, citations.test.ts:36 and rank.test.ts:16 pin blob/HEAD, and no test asserts a commit in the citation."
      - "The gate r33 JUnit is green (0 failures) but does not exercise this claim; the criterion is not met even though the suite passes."
  - truth: "ATLAS-03 (amended 2026-11-05): repo, path and commit provenance; the citation URL carries the commit"
    status: failed
    reason: "Same root cause as SC4. The route, bounded concurrency, one poll per batch and secret refusal are present and wired; the commit-in-citation part is not."
    artifacts:
      - path: "packages/mcp-server/src/docs-search.ts"
        issue: "Citation source_url built at HEAD (see SC4)."
    missing:
      - "Same change as SC4."
---

# 63-VERIFICATION: Corpus Atlas (v1.7 phase 63)

**Phase Goal:** The documentation of every repository the owner keeps (the clones on the VPS, the GitHub organisations, the Greptile knowledge bases) is discovered, classified, de-duplicated and recorded in one manifest, and a bulk path puts new and changed documents into the docs plane with provenance and removes the ones that disappeared.
**Verified:** 2026-11-05T08:00:44Z
**Status:** gaps_found
**Re-verification:** Yes. The previous record (head 42e3cf13, status human_needed, 7/7, digest `v3:sha256:757f1c2e…`) is replaced. The criteria were re-checked at head 6e5d766e because commit 6e5d766e amended SC4 and ATLAS-03 (the commit reaches the citation URL). That amendment is not met by the code, so the status moves to gaps_found.

**Head:** 6e5d766e (integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`)

## Changes since the previous record (42e3cf13) that were checked

- `6e5d766e` (docs): ROADMAP SC4 and REQUIREMENTS ATLAS-03 now say the commit reaches the citation URL. Re-audited: NOT MET (SC4 and ATLAS-03 failed, see gaps). Also added a `docs/corpus.md` sentence (line 309): the tombstone `scope` is the caller's declaration, not an access control, and the bounding grant is `SUBSTRATE_REPO_SCOPES`, off by default. Re-audited: consistent with `service.ts:99,116,192-193` (`tombstone-scope-required`, `tombstone-out-of-scope`) and with `flag-registry.ts:326` (default `none`); SC5 holds. The other edits in 6e5d766e (phase 65 and 75 records, `docs/reconcile.md`, the planning-hash default) do not touch phase 63 claims.
- `packages/mcp-server/src/service.ts` (`b4bdd0fc`, docs.sync sync-lag reading): the only hunk is the emit path for docs.sync notes. Its corpus-named lines are the existing `corpusSlo` calls; no corpus scan, plan, ingest, route or archive hunk. Not a phase 63 criterion; carried forward.
- `49b9aece`, `d1a5e89b`, `b4fe6bfe` (phases 76, 75, 68) and `bd5c287a`, `457b2e07` (record refreshes): no phase 63 covered file changed. Checked against `git diff --name-only 42e3cf13 HEAD` intersected with the covered set: only `docs/corpus.md` and `packages/mcp-server/src/service.ts`.
- Owner decisions in force (2026-11-04 and 2026-11-05) applied as written: SC1 rename within one repository; a copy elsewhere is add plus tombstone; the commit reaches the citation URL (SC4, ATLAS-03).

**Covered set:** 95 files, from `gsd_run query verification.fingerprint .planning/phases/63-corpus-atlas <files>` (the 95 files of the replaced record; the set is unchanged, the digest moves because `docs/corpus.md` and `service.ts` changed). The planning-root ROADMAP and REQUIREMENTS are inert for the fingerprint. `covered_files` and `covered_digest` are the command's output, copied verbatim.

## Gates

No repository gate was run here (full suite, tsc, lint and formatters are out of scope). Targeted runs only.

| Run | Files | Result |
|---|---|---|
| `env -u SUBSTRATE_TEST_PG_URL TMPDIR=…/gate-tmpfs bun test --timeout 30000 <33 covered *.test.ts files + docs-search.test.ts>` at 6e5d766e | 33 files, 1065 tests | 1039 pass, 26 skip, 0 fail. All 26 skips are Postgres-gated suites ("index archive against a live index", "the corpus manifest against a live index") with no PG URL set. |
| Postgres-gated suites, named passes in gate r33 JUnit (`/root/src/worktrees/backups/gate-r33-junit.xml`, head 6e5d766e gate) | `index-store.archive.test.ts` 10/10; `index-archive.test.ts` 65/65; `corpus/store.test.ts` 15/15 (manifest suite 12); `planes/lightrag-bulk.test.ts` 33/33 | 0 failures, no `<skipped/>` in these suites. Scratch Postgres was not started in this run. |

## Success criteria

| # | Criterion (as amended) | Status | Evidence |
|---|---|---|---|
| 1 | Scan deterministic; clones and worktrees collapse; identical copies collapse with bounded report; a rename only within one repository; a copy in another collection is an add plus a tombstone; exclusions and size caps | VERIFIED | `packages/mcp-server/src/corpus/plan.ts:68-85` pairs a removed row with a new entry only on `keyOf(repo, sha256)`, so a moved copy in another repository is never paired. JUnit (gate r33): "a rename never crosses repositories" (`plan.test.ts:59`), "the same text at a new path is one rename…" (`:42`), "renames pair one to one…" (`:49`). Scan side: `packages/corpus/src/scan.ts` (`collapseIdentical`, `inspectBytes`), re-observed in the non-PG batch. |
| 2 | `scan`, `plan`, `ingest`, `status` work against a server; `plan` sends no bodies and prints counts; `ingest` is a dry run until `--execute` | VERIFIED | Server doors `server.ts` (`POST /corpus/plan`, `POST /corpus/ingest`, `GET /corpus/status`); JUnit "a plan counts add, change, rename and tombstone against the manifest and writes nothing" (`routes.test.ts:217`); "a tombstone-only request (no documents) is accepted…" (`routes.test.ts:179`). CLI dry run: `packages/cli/src/corpus/index.ts`. Not exercised against a live server (human item 1). |
| 3 | Migration step creates `corpus_documents` (additive, reversible, digest fixture, rollback-compat doc); `POST /corpus/plan`, `POST /corpus/ingest`, `GET /corpus/status`, MCP `corpus_status` (read, fail-open) and `corpus_ingest` (write, fail-closed) audited and admitted; the table is in the index archive and restore spec with its restore tested | VERIFIED | Step 35 `packages/mcp-server/src/index-store.ts` (create table, down drops it, identity `manifest_seq`); digest `index-store.migrations.digests.json` `"35": "afc41214…"` (matches). Archive spec `index-archive-spec.ts:216` (`corpus_documents`). Commit `ebabe6ef` added the table to the archive with the restored sequence. JUnit (gate r33, no `<skipped/>`): "archive → verify → restore into a scratch database: counts and hashes equal…" (`index-store.archive.test.ts:205`); "after a restore, a plain insert into corpus_documents takes a manifest_seq above every restored one" (`:263`); "the closed whitelist is exactly what migrate() created…" (`:162`). Audit/admission: `corpus_ingest` and `corpus_status` in `packages/audit/src/policy.ts` (carried forward). |
| 4 | LightRAG bulk path: batches through `POST /documents/texts` with bounded concurrency and one poll per batch; redacts and refuses secrets as `docs_ingest` does; carries repo, path and **commit** into the document source (its citation URL); kind and tier stay in the manifest, which also records the commit; the plane document carries name and text | **FAILED** (amended wording) | Holds: `packages/mcp-server/src/planes/lightrag-bulk.ts:231-236` (`POST /documents/texts`, one `bulkTimeoutMs` budget), `:276-278` (one `waitIdle` per batch), `:92-95` batch bounds; `ingest.ts:485` `runBounded(batches, deps.settings.concurrency, …)`; secret refusal `ingest.ts:251`; manifest commit `ingest.test.ts:58`. JUnit: `lightrag-bulk.test.ts` 33/33 named passes. **Does not hold:** the commit is not in the document source or in any citation URL. `ingest.ts:259-261` `toBulk` sends `{name, text}`; `name` is `corpus:<repo>:<path>@<sha12>` (`names.ts:125`, no commit); `lightrag-bulk.ts:234` sends `file_sources: docs.map(d => d.name)`. The search citation is rebuilt by `docs-search.ts:522-531` (called `:1117`) as `corpusSourceUrl(repo, path)` with no commit, which `protocol.ts:435` renders as `blob/HEAD/<path>`. Tests pin HEAD: `names.test.ts:116`, `citations.test.ts:36`, `rank.test.ts:16`. |
| 5 | Removed or renamed document tombstoned: plane document deleted through `delete_document` only when no other active row shares it; row `tombstoned`; rename only within one repository; a copy in another collection is an add plus a tombstone; tombstone only for a repository the scan covered completely, at the declared scope; narrower scans leave earlier documents untouched | VERIFIED (carried forward, re-observed) | `ingest.ts:367-411` phase T (`activeReferences(id) > 0` keeps a shared plane document, `deleteDocuments`, row `tombstoned` only after confirmed deletion); scope `plan.ts:12-14`. Refusals `service.ts:99,116,192-193` (`tombstone-scope-required`, `tombstone-out-of-scope`); JUnit "a tombstone outside the request's scope is refused 403 tombstone-out-of-scope and deletes nothing" (`routes.test.ts:203`). `docs/corpus.md:309` (declaration, not access control) matches the code. |
| 6 | Second identical run reports `unchanged` and sends nothing; a killed run resumes without re-sending recorded documents | VERIFIED (carried forward, re-observed) | `ingest.ts:240-243` (same sha, source, kind, tier and marker → `unchanged`, not sent); `ingest.ts:296-315` records each accepted document per batch. Tests `ingest.test.ts:103` and `:198` (named in the previous record; ingest suite in the 0-fail non-PG batch). |
| 7 | Source adapters for a Greptile export directory and for GitHub through `gh` produce the same entries; both bounded by `--max-repos` and `--tier` | VERIFIED (carried forward, re-observed) | `packages/corpus/src/adapters/greptile-export.ts` (`<owner>/<repo>/<path>.md` as tier-2 `greptile-kb`; `greptile-export.test.ts:20`, `:97`); `adapters/github.ts:29-30` defaults, `:139-171` bounded limiter, `github.test.ts:150`. CLI bounds `cli/src/corpus/index.ts:203, :211-216`. Real Greptile export and live `gh` not run (human items 2 and 3). |

**Score:** 6/7 truths verified (0 behavior-unverified). SC4 is FAILED under its amended wording, and ATLAS-03 is BLOCKED on the same point.

## Required artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/corpus/src/{protocol,scan,classify}.ts` | closed enums, bounds, scan, collapse, caps | VERIFIED | `protocol.ts:57-101` bounds; `sourceUrl` at `:429-437` accepts a commit but no plane path passes one (see SC4). |
| `packages/mcp-server/src/corpus/{plan,ingest,service,store,validate,routes}.ts` | server doors and ingest | VERIFIED | plan, ingest, validate and routes tests pass; `corpus/store.test.ts` 15/15 (PG, gate r33). |
| `packages/cli/src/corpus/{index,ingest,client,inventory}.ts` | CLI commands and client | VERIFIED | `index.ts` usage and flags; `ingest.ts:98-165` tombstones, then bounded batches. |
| `packages/mcp-server/src/index-store.ts` step 35 | additive `corpus_documents` | VERIFIED | `:701-727`; digest `…digests.json:36`. |
| `packages/mcp-server/src/index-archive-spec.ts` `corpus_documents` | archive spec, closed list | VERIFIED | `:216`; whitelist test equals `migrate()`; restored sequence passes (gate r33 JUnit). |
| `packages/mcp-server/src/planes/lightrag-bulk.ts` | bulk insert, wait, map, delete | VERIFIED for insert, wait and delete (`:231-236`, `:276-278`, `:448-455`); commit-in-source part FAILED (SC4). |
| `packages/mcp-server/src/docs-search.ts` `withCorpusProvenance` | corpus citation with commit | FAILED | `:522-531`: `source_url` built with no commit (HEAD). |

## Key link verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `cli/src/corpus/ingest.ts` | `POST /corpus/ingest` | `client.ingest` with `scope` | WIRED | tombstones sent with the plan scope (`ingest.ts:157`). |
| `server.ts:1766` | `substrate.corpusIngest` → `ingestCorpus` | route handler | WIRED | `corpus_ingest` audit (fail-closed) before the call. |
| `ingest.ts` | `planes/lightrag-bulk.ts` | `plane.insertBatch` / `plane.deleteDocuments` | WIRED | `ingest.ts:274-276`, `:396`. |
| `ingest.ts` | `corpus_documents` | `CorpusStore` writes, `manifest_seq` identity | WIRED | `store.ts`; PG tests write and read the table. |
| `index-archive-spec.ts` | `index-store.ts` step 35 | closed whitelist vs `information_schema` | WIRED | `index-archive.test.ts` compares columns on a live database (PG 65/65). |
| `ingest.ts` commit | citation URL (`docs_search`) | `sourceUrl(repo, path, commit)` | NOT_WIRED | The commit reaches only the secret scan (`ingest.ts:197, :251`). `docs-search.ts:528` passes no commit. |

## Requirements coverage

| Requirement | Status | Evidence |
|---|---|---|
| ATLAS-01 (scan, collapse, rename within one repository, copy as add plus tombstone) | SATISFIED | SC1; `plan.ts:68-85`; JUnit `plan.test.ts:59`. |
| ATLAS-02 (`plan` reports add, change, rename, tombstone without bodies) | SATISFIED | SC2; `routes.test.ts:217`. |
| ATLAS-03 (bulk route, repo, path and commit provenance with the citation URL carrying the commit; no serial wait; secrets refused) | BLOCKED | Route, wait and secret refusal satisfied (SC4). The commit-in-citation part is not met (`docs-search.ts:528`). |
| ATLAS-04 (tombstone only within a completely covered scan) | SATISFIED | SC5; `plan.ts:12-14`; `routes.test.ts`. |
| ATLAS-05 (second run unchanged, resume after kill) | SATISFIED | SC6; `ingest.test.ts:103`, `:198`. |
| ATLAS-06 (Greptile and GitHub adapters into the same manifest) | SATISFIED | SC7; adapter tests pass. Real export and live `gh` not run. |

**Orphaned requirements:** none. ATLAS-01 to ATLAS-06 map to phase 63 and all appear in the plans.

## Anti-patterns found

Carried forward from the previous record (grep of the phase's source areas for TODO, FIXME, XXX, not-implemented and placeholder; the only match was a test fixture name). None of the 6e5d766e or later hunks adds a marker.

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| (none) | - | - | - | - |

## Deferred items

None. Phases 64 to 66, 69 and 70 build on this manifest; that is not a deferral of a phase 63 criterion.

## Advisory (info, not a new-scope finding)

- The single-flight lock (`mutex.ts`, `ingest.ts:50`) is per server process; two server processes would not exclude each other (SUMMARY "What remains").

## Human verification required (after the gaps close)

These remain open and are not counted in the status while gaps_found governs.

1. **Live ingest.** Run `substrate corpus ingest --execute` against the live corpus with the server on `SUBSTRATE_CORPUS=on` and a LightRAG backend, after the dry-run plan. Expected: batches report `ingested`; a repeat run reports `unchanged` and sends nothing; no secret refusals on the real corpus.
2. **Greptile export.** Ingest a real Greptile knowledge-base export directory. Expected: the `<owner>/<repo>/<path>.md` layout is read as tier-2 `greptile-kb` entries. (`greptile-export.test.ts:20` pins the layout as the code reads it.)
3. **GitHub through `gh`.** Ingest repositories with no local clone through a logged-in `gh`. Expected: the same entry shape as the Greptile source.
4. **Migration step 35 and the archive on production.** Apply step 35 to a restored dump and run the rollback check (`docs/runbooks/rollback-compat.md`). Take a new index archive on this release: the schema hash changed, so an archive written before `ebabe6ef` fails `verify-archive` (kind `schema`). Expected: the step applies and reverses; the new archive passes `verify-archive`; restoring it reproduces `corpus_documents` with its `manifest_seq` values.

## Gaps summary

Criteria 1, 2, 3, 5, 6 and 7 are VERIFIED. Criterion 4 (SC4) is FAILED under the wording amended in `6e5d766e` on 2026-11-05: the commit does not reach the citation URL. ATLAS-03 is BLOCKED on the same point. Root cause: `withCorpusProvenance` (`packages/mcp-server/src/docs-search.ts:522-531`) rebuilds corpus citations with `sourceUrl(repo, path)` and no commit, and the bulk path names plane documents without a commit. The commit reaches the manifest row and the secret scan only. The gate r33 JUnit is green, but no test asserts a commit in a citation, so the green gate does not show this criterion.

The fix is a code change (out of scope for this record): carry the commit to the citation (see `missing` in the frontmatter), add a test that pins `blob/<commit>/<path>`, and re-verify. The other criteria carry forward unchanged.

---

_Verified: 2026-11-05T08:00:44Z_
_Verifier: Claude (gsd-verifier)_
