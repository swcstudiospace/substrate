---
phase: 63-corpus-atlas
verified: 2026-11-04T23:01:09Z
status: gaps_found
score: 4/7 must-haves verified (criteria 2, 5, 6, 7 VERIFIED; criteria 1, 3, 4 PARTIAL, each with one failed clause)
covered_files: [".env.example", ".planning/phases/63-corpus-atlas/63-SUMMARY.md", "bun.lock", "docs/config-reference.md", "docs/corpus.md", "docs/data-planes.md", "docs/docs-plane.md", "docs/event-vocabulary.md", "docs/mcp-audit.md", "docs/runbooks/corpus-ingest.md", "docs/runbooks/rollback-compat.md", "package.json", "packages/audit/src/policy.test.ts", "packages/audit/src/policy.ts", "packages/cli/package.json", "packages/cli/src/corpus/bodies.test.ts", "packages/cli/src/corpus/bodies.ts", "packages/cli/src/corpus/client.test.ts", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.test.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/ingest.ts", "packages/cli/src/corpus/inventory.test.ts", "packages/cli/src/corpus/inventory.ts", "packages/cli/src/corpus/render.test.ts", "packages/cli/src/corpus/render.ts", "packages/cli/src/corpus/testkit.ts", "packages/cli/src/index.ts", "packages/corpus/package.json", "packages/corpus/src/adapters/github.test.ts", "packages/corpus/src/adapters/github.ts", "packages/corpus/src/adapters/greptile-export.test.ts", "packages/corpus/src/adapters/greptile-export.ts", "packages/corpus/src/classify.test.ts", "packages/corpus/src/classify.ts", "packages/corpus/src/discover.test.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/guards.ts", "packages/corpus/src/index.ts", "packages/corpus/src/names.test.ts", "packages/corpus/src/names.ts", "packages/corpus/src/protocol.ts", "packages/corpus/src/scan.test.ts", "packages/corpus/src/scan.ts", "packages/corpus/src/similarity.test.ts", "packages/corpus/src/similarity.ts", "packages/corpus/src/test-support.ts", "packages/mcp-server/package.json", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/citations.test.ts", "packages/mcp-server/src/corpus/ingest.test.ts", "packages/mcp-server/src/corpus/ingest.ts", "packages/mcp-server/src/corpus/mutex.test.ts", "packages/mcp-server/src/corpus/mutex.ts", "packages/mcp-server/src/corpus/names.test.ts", "packages/mcp-server/src/corpus/names.ts", "packages/mcp-server/src/corpus/plan.test.ts", "packages/mcp-server/src/corpus/plan.ts", "packages/mcp-server/src/corpus/routes.test.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/settings.test.ts", "packages/mcp-server/src/corpus/store.test.ts", "packages/mcp-server/src/corpus/store.ts", "packages/mcp-server/src/corpus/testkit.ts", "packages/mcp-server/src/corpus/validate.test.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/docs-datasets.ts", "packages/mcp-server/src/docs-ingest.test.ts", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.migrate-contract.test.ts", "packages/mcp-server/src/index-store.migrate-harness.test.ts", "packages/mcp-server/src/index-store.migrations.digests.json", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planes/__fixtures__/lightrag-v1.5.7-routes.json", "packages/mcp-server/src/planes/lightrag-bulk.test.ts", "packages/mcp-server/src/planes/lightrag-bulk.ts", "packages/mcp-server/src/planes/lightrag.contract.test.ts", "packages/mcp-server/src/planes/lightrag.test.ts", "packages/mcp-server/src/planes/lightrag.ts", "packages/mcp-server/src/rollback-compat.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:9d6df4ccd6e29012d5966925802b6b3cb8ce85940d5ba8836ff7cd9f800d8b0f"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/7
  gaps_closed: []
  gaps_remaining:
    - "SC1: when the canonical copy disappears, the next copy becomes canonical and the plan reports a rename"
    - "SC3: the new table is covered by the index archive and restore spec, and its restore is tested"
    - "SC4: the bulk path carries repo, path, kind, tier and commit into the document source"
  regressions: []
gaps:
  - truth: "SC1: when the canonical copy disappears, the next copy becomes canonical and the plan reports a rename"
    status: failed
    reason: "The planner pairs a removed row with a new entry only inside one repository (the candidate map is keyed on repo and sha256). When the next copy sits in another repository (another local/* collection), the plan reports add plus tombstone, not a rename."
    artifacts:
      - path: "packages/mcp-server/src/corpus/plan.ts"
        issue: "Rename candidates are matched on keyOf(repo, sha256) (lines 68-85); a cross-repository move is never a rename."
      - path: "packages/mcp-server/src/corpus/plan.test.ts"
        issue: "'a rename never crosses repositories' pins the behaviour the criterion excludes for moved identical copies."
    missing:
      - "Owner decision: accept add plus tombstone for a copy that moves between collections, and amend SC1 and ATLAS-01 to say so; or implement a cross-repository rename by sha256 with the tombstone rule kept."
  - truth: "SC3: the new table is covered by the index archive and restore spec, and its restore is tested"
    status: failed
    reason: "corpus_documents is excluded from the index archive's closed table list by design (index-store.migrate-contract.test.ts REAL_ALLOWLISTS.tables.corpus_documents records that archiving it is a separate change), and no test restores it."
    artifacts:
      - path: "packages/mcp-server/src/index-store.migrate-contract.test.ts"
        issue: "The corpus_documents allowlist entry (line 62) records the exclusion; no restore test for the table exists."
      - path: "docs/runbooks/rollback-compat.md"
        issue: "Documents step 35 only (line 48); no restore procedure for the manifest."
    missing:
      - "Add corpus_documents to the index archive spec and test its restore, or record the owner decision that the manifest stays outside the archive (operator-gated per the phase record)."
  - truth: "SC4: the bulk path carries repo, path, kind, tier and commit into the document source"
    status: failed
    reason: "The plane port sends {name, text} only. The plane document carries repo, path and the first 12 hex of sha256 in its name; kind, tier and commit stay in the manifest and are not carried into the plane document."
    artifacts:
      - path: "packages/mcp-server/src/planes/lightrag-bulk.ts"
        issue: "BulkTextDocument is {name, text} (lines 46-49); the file_sources sent are the names (line 234)."
      - path: "packages/mcp-server/src/corpus/ingest.ts"
        issue: "The GitHub source URL is used only as input to the secret scan (lines 197, 251); kind, tier and commit reach the manifest row (line 302), not the plane."
    missing:
      - "Carry kind, tier and commit into the plane document source, or amend SC4 and ATLAS-03 by owner decision."
---

# 63-VERIFICATION: Corpus Atlas (v1.7 phase 63)

**Head:** 9e71f263 (integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`)
**Mode:** re-verification (the previous record, at 504da465, carries a `gaps:` section; all three carried-forward gaps are re-checked at three levels below; the four passed criteria get a regression check).
**Scope:** the covered files above. `git diff 504da465 9e71f263` touches none of them (the four commits since are phase 64, 69, 78 and 65 work: `4d142247`, `3139c948`, `94f4bc8e`, `9e71f263`, which touch `packages/mcp-server/src/corpus/proofs.test.ts` and `docs/runbooks/corpus-sync.md`, neither in the covered set). The covered digest is identical to the digest recorded at 504da465, so the phase's code evidence carries over unchanged.
**Owner constraint in force:** `corpus_documents` is not in the index archive and no restore test covers it. Criterion 3 stays not verified.

## Gates

No repository gate was run here (the orchestrator's r28 gate covers head 9e71f263). Targeted runs only.

| Run | Files | Result |
|---|---|---|
| `env -u SUBSTRATE_TEST_PG_URL bun test` (non-PG, one command) | 29 phase test files: `packages/audit/src/policy.test.ts`; `packages/cli/src/corpus/{bodies,client,index,inventory,render}.test.ts`; `packages/corpus/src/{adapters/github,adapters/greptile-export,classify,discover,names,scan,similarity}.test.ts`; `packages/mcp-server/src/corpus/{citations,ingest,mutex,names,plan,routes,settings,validate}.test.ts`; `packages/mcp-server/src/{docs-ingest,observe,rollback-compat,index-store.migrate-contract,index-store.migrate-harness}.test.ts`; `packages/mcp-server/src/planes/{lightrag-bulk,lightrag.contract,lightrag}.test.ts` | 882 pass, 0 fail, 0 skip (3570 expect calls, 9.3 s) |
| `SUBSTRATE_TEST_PG_URL=postgres://postgres:…@127.0.0.1:5439/substrate_test_v63 TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test packages/mcp-server/src/corpus/store.test.ts` | `store.test.ts` (the only PG-gated covered file; `index-store.migrate-harness.test.ts` mentions the variable in a comment only) | 15 pass, 0 fail, 0 skip (61 expect calls; scratch Postgres 16.15, database `substrate_test_v63`, not production) |

The non-PG run's `[substrate] denied …` and `rag-state` lines are the expected stderr of denial-path tests, not failures. No live LightRAG, live GitHub (`gh`), Greptile export or live server run was observed.

## Success criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Scan returns sorted, deterministic entries; clones and linked worktrees collapse; byte-identical copies collapse with a bounded report; a copy is never mistaken for a deleted file; when the canonical copy disappears the next copy becomes canonical **and the plan reports a rename**; exclusions and size caps hold | PARTIAL | VERIFIED (scan, run 1): `scan.test.ts` determinism, sort, size-cap, clone and linked-worktree collapse, and identical-copy collapse tests pass. FAILED clause (3 levels): `plan.ts` 68-85 matches a rename on `keyOf(repo, sha256)`, so a kept copy that moves to another repository is add plus tombstone; `plan.test.ts` "a rename never crosses repositories" pins it (passes in run 1). Documented as a deviation in SUMMARY.md and `docs/corpus.md`. |
| 2 | `substrate corpus scan`, `plan`, `ingest` and `status` work against a server; `plan` sends entries without bodies and prints add, change, rename, tombstone counts; `ingest` is a dry run until `--execute` | MET | VERIFIED (run 1, stub server): `packages/cli/src/corpus/index.test.ts` "sends the entries without bodies, the coverage the scan read completely, and prints the counts", "without --execute it prints the plan, says it is a dry run and sends nothing but the plan", "prints the inventory without contacting a server", "a plan with nothing to do sends no ingest request", "prints the manifest summary, and --json the raw answer". Not exercised against a live server. |
| 3 | Migration step creates `corpus_documents` (additive, reversible, digest fixture and rollback-compat doc updated); `POST /corpus/plan`, `POST /corpus/ingest`, `GET /corpus/status`, MCP `corpus_status` (read, fail-open) and `corpus_ingest` (write, fail-closed) audited and admitted; the table covered by the index archive and restore spec, restore tested | PARTIAL | VERIFIED for the create/digest/doors clauses: step 35 in `index-store.ts` (`phase: "expand"`, `if not exists`, `down` drops the table); `index-store.migrate-contract.test.ts` digest and reversibility tests pass (run 1); `docs/runbooks/rollback-compat.md` line 48 names step 35; admission classes in `admission.ts`; MCP tools in `mcp.ts`, `corpus_ingest` denial path exercised in run 1. FAILED clause (3 levels): `index-store.migrate-contract.test.ts` line 62 allowlists `corpus_documents` as outside the archive's closed table list ("archiving it is a separate change"); no test restores it; `rollback-compat.md` documents no restore for the manifest. Owner constraint: stays not verified. |
| 4 | LightRAG bulk path sends batches through `POST /documents/texts` with bounded concurrency and one pipeline poll per batch; redacts and refuses secrets as `docs_ingest` does; carries repo, path, kind, tier and commit into the document source | PARTIAL | VERIFIED for route, concurrency, poll and secret refusal: `lightrag-bulk.ts` 231-234 (`/documents/texts`, `{texts, file_sources}`); `lightrag.contract.test.ts` and `lightrag-bulk.test.ts` pass (run 1); `ingest.ts` secret scan at 197 and 251. FAILED clause (3 levels): `lightrag-bulk.ts` 46-49 `BulkTextDocument` is `{name, text}`; the plane document name carries repo, path and the first 12 hex of sha256 (`corpus:<repo>:<path>@<sha12>`); kind, tier and commit reach the manifest row only (`ingest.ts` 302). |
| 5 | Removed or renamed document is tombstoned through `delete_document` (only when no other active row shares it); row says `tombstoned`; rename is a rename; tombstones only for a completely scanned repository at the declared tiers and sources; narrower scans, failed repositories and truncated trees leave earlier documents untouched | MET | VERIFIED (behaviour, state transitions and ordering; run 1): `ingest.test.ts` "a tombstone deletes the plane document and marks the row tombstoned", "a plane document shared with another active row is never deleted; the row is still tombstoned", "a plane delete that fails leaves the row active so a retry deletes again", "a changed document is written under its new name and recorded BEFORE the old plane document is deleted"; scope refusal tests in `plan.test.ts` and `ingest.test.ts`. |
| 6 | Second identical run reports `unchanged` for every document and sends nothing; a run killed half way resumes without re-sending recorded documents | MET | VERIFIED (behaviour; run 1): `ingest.test.ts` "a document already recorded at the same sha is unchanged: nothing is sent, and a second identical run sends nothing", "a run killed after the first batch resumes with only the documents it had not recorded", "a crash between the plane write and the manifest write leaves a state the next run repairs"; `routes.test.ts` second-identical-request case. |
| 7 | Greptile export directory and GitHub through `gh` produce the same entries; both bounded by `--max-repos` and `--tier` | MET | VERIFIED per adapter (run 1): `adapters/greptile-export.test.ts` "reads <owner>/<repo>/<path>.md files as tier-2 greptile-kb entries and ignores everything else", "maxRepos reads the first repositories in name order and says how many were left", "a tier bound below 2 reads nothing"; `adapters/github.test.ts` "reads documentation blobs of the default branch into entries and hands each body to onBody", "the tier bound drops research at tier 1 and brings loose notes at tier 3, without fetching what it drops", "maxRepos reads the first repositories by name and notes the rest". Both adapters emit the shared `CorpusEntry` shape. No live export or `gh` run. |

**Score:** 4/7 criteria verified (2, 5, 6, 7). 3 partial (1, 3, 4), each with one failed clause listed under `gaps`.

## Requirements coverage (ATLAS-01 to ATLAS-06)

| Requirement | Status | Evidence |
|---|---|---|
| ATLAS-01 scan lists docs with repo, path, kind, tier, sha256, size; collapses clones, worktrees, identical copies | SATISFIED (fixture and unit tests) | `scan.test.ts` (run 1); live scan of the VPS not run. |
| ATLAS-02 `plan` reports add, change, rename, tombstone without bodies | SATISFIED | `plan.test.ts`; CLI `index.test.ts`. Rename is same-repository only (see SC1). |
| ATLAS-03 bulk route without a serial wait per page; repo, path, kind, tier, commit provenance; refuses secrets | PARTIAL | Route, poll and concurrency verified (SC4). Provenance clause FAILED (SC4 gap). OPEN per owner. |
| ATLAS-04 removed or renamed documents tombstoned; narrower scan never tombstones outside its coverage | SATISFIED | SC5 tests (run 1); scope refusal at head. |
| ATLAS-05 same run changes nothing; interrupted run resumes | SATISFIED | SC6 tests (run 1). |
| ATLAS-06 Greptile and GitHub-without-clone enter the same manifest through documented adapters | SATISFIED (adapter tests; same entry type) | SC7 tests (run 1); no live export or `gh` run. |

**ORPHANED requirements:** none. Every ATLAS ID is declared by this phase's ROADMAP entry.

## Required artifacts and key links

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/corpus/src/scan.ts` | scan, collapse, caps | VERIFIED | tests pass (run 1). |
| `packages/corpus/src/adapters/github.ts`, `greptile-export.ts` | source adapters | VERIFIED | tests pass (run 1). |
| `packages/cli/src/corpus/index.ts`, `ingest.ts`, `client.ts` | CLI commands | VERIFIED | `index.test.ts` passes (run 1). |
| `packages/mcp-server/src/corpus/{plan,ingest,service,store,validate,routes}.ts` | server doors and ingest | VERIFIED | plan, ingest, routes tests pass (run 1); `store.test.ts` 15/15 on scratch Postgres. |
| `packages/mcp-server/src/planes/lightrag-bulk.ts` | `/documents/texts` bulk client | VERIFIED (behaviour); provenance FAILED | fake-plane tests pass (run 1). |
| `packages/mcp-server/src/index-store.ts` step 35 | additive `corpus_documents` | VERIFIED | digest and reversibility tests pass (run 1). |

**Key links (wiring):** CLI to `POST /corpus/plan` and `/corpus/ingest` (`client.ts`) WIRED (`index.test.ts` stub-server tests). Routes to `corpusPlanReply` and `corpusIngestReply` (`server.ts` to `service.ts`) WIRED. MCP tools to the same service (`mcp.ts`) WIRED. Ingest to the bulk plane (`ingest.ts` to `lightrag-bulk.ts`) WIRED. Ingest to the manifest store (`ingest.ts` to `store.ts`) WIRED.

**Level 4 (data flow):** the manifest read in `corpusPlanReply` and `corpusStatusReply` comes from `store.rowsForRepos`, `manifestVersion` and `newestIngestAt`. Real queries; `store.test.ts` exercises them against live Postgres (15 pass). FLOWING.

## Behavioral spot-checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Scan determinism, collapse, caps | `env -u SUBSTRATE_TEST_PG_URL bun test` (run 1, 882 pass) | pass | ✓ PASS |
| Plan actions and coverage | run 1 (`plan.test.ts`) | pass | ✓ PASS |
| Ingest ordering, tombstones, resume | run 1 (`ingest.test.ts`) | pass | ✓ PASS |
| CLI plan and ingest dry run | run 1 (`index.test.ts`) | pass | ✓ PASS |
| Manifest store against live Postgres | `SUBSTRATE_TEST_PG_URL=…/substrate_test_v63 bun test packages/mcp-server/src/corpus/store.test.ts` | 15 pass, 0 fail | ✓ PASS |
| Live ingest, live server, live LightRAG | not run (operator-gated) | n/a | ? SKIP |

## Probe execution

No probes apply: no `scripts/*/tests/probe-*.sh` exists in the tree, and neither the PLAN nor the SUMMARY declares one.

## Anti-patterns found

Scanned the phase's covered implementation files at head for `TBD`, `FIXME`, `XXX`, `TODO`, `HACK` and `PLACEHOLDER` (non-test files). No matches. The `return null` hits in `names.ts`, `classify.ts`, `scan.ts` and `github.ts` are guard returns, not stubs.

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| (none) | - | - | - | - |

## Deferred items

None. Step 9b checked the later phases (64 to 66, 68 to 70, 71 to 78) in the ROADMAP. Phase 65 (doc watch) and phase 69 (doc proofs) do not address cross-repository renames, archiving or restoring `corpus_documents`, or kind, tier and commit in the plane document. The gaps stay real.

## Advisory (New Scope, Unevidenced)

None. Re-verification found no new-scope findings.

## Human verification required

Operator-gated; not part of `human_verification`, because the status is `gaps_found`.

1. **Live ingest.** Run `substrate corpus ingest --execute` against the live corpus with the server on `SUBSTRATE_CORPUS=on` and a LightRAG backend. Expected: a dry-run plan first, then batches that report `ingested`, `unchanged` on a repeat, and no secret refusals on the real corpus.
2. **Greptile export.** Ingest a real Greptile knowledge-base export directory. The `<owner>/<repo>/<path>.md` layout is what the code reads and is unconfirmed against a real export.
3. **GitHub through `gh`.** Ingest repositories with no local clone through a logged-in `gh`. Expected: the same entry shape as the Greptile source.
4. **Migration step 35 rehearsal.** Apply step 35 to a restored dump and run the rollback check (`docs/runbooks/rollback-compat.md`).
5. **Archive decision.** Owner decides whether `corpus_documents` joins the index archive (closes SC3).

## Gaps summary

Three criteria are partial. Each has one clause that the code does not meet, and each is listed under `gaps` with its evidence.

1. **SC1, cross-repository rename.** The rename is same-repository only. A copy that moves to another collection is add plus tombstone. This needs an owner decision and a criterion amendment, or a code change.
2. **SC3, archive and restore.** `corpus_documents` is excluded from the index archive by design, and no restore is tested. This needs the owner decision recorded in the phase record, or a code and test change. Stays not verified.
3. **SC4, provenance in the plane document.** The plane carries repo and path in the name, and kind, tier and commit only in the manifest. This needs an owner decision, or a change to carry them into the plane document.

Criteria 2, 5, 6 and 7 are verified by the targeted runs and by code inspection. The remaining evidence is operator-gated (the list above).

---

_Verified: 2026-11-04T23:01:09Z_
_Verifier: Claude (gsd-verifier)_
