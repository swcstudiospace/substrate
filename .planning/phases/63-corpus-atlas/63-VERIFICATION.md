---
phase: 63-corpus-atlas
verified: 2026-11-05T00:14:36Z
status: human_needed
score: 7/7 must-haves verified (criteria 1 to 7 VERIFIED against the criteria as amended by the owner decisions of 2026-11-04; 0 behavior-unverified)
covered_files: [".env.example", ".planning/phases/63-corpus-atlas/63-SUMMARY.md", "bun.lock", "docs/config-reference.md", "docs/corpus.md", "docs/data-planes.md", "docs/docs-plane.md", "docs/event-vocabulary.md", "docs/mcp-audit.md", "docs/runbooks/corpus-ingest.md", "docs/runbooks/index-archive.md", "docs/runbooks/rollback-compat.md", "package.json", "packages/audit/src/policy.test.ts", "packages/audit/src/policy.ts", "packages/cli/package.json", "packages/cli/src/corpus/bodies.test.ts", "packages/cli/src/corpus/bodies.ts", "packages/cli/src/corpus/client.test.ts", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.test.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/ingest.ts", "packages/cli/src/corpus/inventory.test.ts", "packages/cli/src/corpus/inventory.ts", "packages/cli/src/corpus/render.test.ts", "packages/cli/src/corpus/render.ts", "packages/cli/src/corpus/testkit.ts", "packages/cli/src/index.ts", "packages/corpus/package.json", "packages/corpus/src/adapters/github.test.ts", "packages/corpus/src/adapters/github.ts", "packages/corpus/src/adapters/greptile-export.test.ts", "packages/corpus/src/adapters/greptile-export.ts", "packages/corpus/src/classify.test.ts", "packages/corpus/src/classify.ts", "packages/corpus/src/discover.test.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/guards.ts", "packages/corpus/src/index.ts", "packages/corpus/src/names.test.ts", "packages/corpus/src/names.ts", "packages/corpus/src/protocol.ts", "packages/corpus/src/scan.test.ts", "packages/corpus/src/scan.ts", "packages/corpus/src/similarity.test.ts", "packages/corpus/src/similarity.ts", "packages/corpus/src/test-support.ts", "packages/mcp-server/package.json", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/citations.test.ts", "packages/mcp-server/src/corpus/ingest.test.ts", "packages/mcp-server/src/corpus/ingest.ts", "packages/mcp-server/src/corpus/mutex.test.ts", "packages/mcp-server/src/corpus/mutex.ts", "packages/mcp-server/src/corpus/names.test.ts", "packages/mcp-server/src/corpus/names.ts", "packages/mcp-server/src/corpus/plan.test.ts", "packages/mcp-server/src/corpus/plan.ts", "packages/mcp-server/src/corpus/routes.test.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/settings.test.ts", "packages/mcp-server/src/corpus/store.test.ts", "packages/mcp-server/src/corpus/store.ts", "packages/mcp-server/src/corpus/testkit.ts", "packages/mcp-server/src/corpus/validate.test.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/docs-datasets.ts", "packages/mcp-server/src/docs-ingest.test.ts", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-archive-spec.ts", "packages/mcp-server/src/index-archive-watch.ts", "packages/mcp-server/src/index-archive.test.ts", "packages/mcp-server/src/index-archive.ts", "packages/mcp-server/src/index-store.archive.test.ts", "packages/mcp-server/src/index-store.migrate-contract.test.ts", "packages/mcp-server/src/index-store.migrate-harness.test.ts", "packages/mcp-server/src/index-store.migrations.digests.json", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planes/__fixtures__/lightrag-v1.5.7-routes.json", "packages/mcp-server/src/planes/lightrag-bulk.test.ts", "packages/mcp-server/src/planes/lightrag-bulk.ts", "packages/mcp-server/src/planes/lightrag.contract.test.ts", "packages/mcp-server/src/planes/lightrag.test.ts", "packages/mcp-server/src/planes/lightrag.ts", "packages/mcp-server/src/rollback-compat.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:9228d62e49075db8255d9747c9015b022335349d031a8bdb66cd678cababfea3"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/7
  gaps_closed:
    - "SC1: the owner decision of 2026-11-04 is in the criterion (1e17db11, bdc1dc1a). A copy that moves to another collection is an add plus a tombstone; a rename is recognised only within one repository. plan.ts pairs rename candidates on keyOf(repo, sha256), and plan.test.ts 'a rename never crosses repositories' pins that behaviour. The code now matches the criterion."
    - "SC3: corpus_documents is in the index archive spec (index-archive-spec.ts:216), the restore advances its identity sequence (index-store.ts:3134, index-archive.ts:1028), and the restore is tested on scratch Postgres (ebabe6ef). The migrate-contract allowlist no longer excludes the table."
    - "SC4: the owner decision of 2026-11-04 is in the criterion (1e17db11). The plane document carries name and text; repo and path are in the name, and kind, tier and commit stay in the manifest. lightrag-bulk.ts:46-49 and ingest.ts:249 match the criterion."
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Live ingest. Run `substrate corpus ingest --execute` against the live corpus with the server on SUBSTRATE_CORPUS=on and a LightRAG backend, after the dry-run plan."
    expected: "Batches report `ingested`; a repeat run reports `unchanged` and sends nothing; no secret refusals on the real corpus."
    why_human: "Operator-gated: needs the live server, the LightRAG backend and the real corpus. Not run here."
  - test: "Greptile export. Ingest a real Greptile knowledge-base export directory."
    expected: "The `<owner>/<repo>/<path>.md` layout is read as tier-2 greptile-kb entries."
    why_human: "The layout is confirmed only against a real export, which is not available to the verifier."
  - test: "GitHub through gh. Ingest repositories that have no local clone through a logged-in gh."
    expected: "The same entry shape as the Greptile source; bounded by --max-repos and --tier."
    why_human: "Needs a logged-in gh and network access to GitHub."
  - test: "Migration step 35 and the archive. Apply step 35 to a restored dump and run the rollback check in docs/runbooks/rollback-compat.md. Take a new index archive on this release: the schema hash changed, so an archive written before ebabe6ef fails verify-archive (kind schema)."
    expected: "The step applies and reverses; the new archive passes verify-archive; restoring it reproduces corpus_documents with its manifest_seq values."
    why_human: "Operator action on the production index. Not run here; the scratch round trip is covered by the store tests."
---

# 63-VERIFICATION: Corpus Atlas (v1.7 phase 63)

**Head:** c40ffc9a (integration worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`)
**Mode:** re-verification (the previous record at 9e71f263 carried `gaps:` for SC1, SC3 and SC4. Each is re-checked at three levels below. SC2, SC5, SC6 and SC7 get a regression check.)
**Changes since the previous record that touch this phase:** `1e17db11` amends SC1, SC4, ATLAS-01 and ATLAS-03 to the owner decisions of 2026-11-04. `bdc1dc1a` states the rename rule in SC5. `ebabe6ef` puts `corpus_documents` in the index archive, makes its restore advance the identity sequence, and tests both. The other wave 6 commits change files outside this phase's corpus code (config, flag registry, service, dashboards, fleet, collectors, dispatcher). Their corpus tests pass at head (non-PG run below), so SC2, SC5, SC6 and SC7 carry forward.
**Covered set:** the 89 files of the record replaced, plus six phase-63 files that `ebabe6ef` and the runbook changed and the old record did not list: `packages/mcp-server/src/index-archive-spec.ts`, `index-archive-watch.ts`, `index-archive.ts`, `index-archive.test.ts`, `index-store.archive.test.ts` and `docs/runbooks/index-archive.md`. The planning-root ROADMAP and REQUIREMENTS edits are inert for the fingerprint.

## Gates

No repository gate was run here (the orchestrator's r30 gate covers head c40ffc9a). Targeted runs only, observed at head c40ffc9a.

| Run | Files | Result |
|---|---|---|
| `env -u SUBSTRATE_TEST_PG_URL bun test` (non-PG, one command) | 31 phase test files: `packages/audit/src/policy.test.ts`; `packages/cli/src/corpus/{bodies,client,index,inventory,render}.test.ts`; `packages/corpus/src/adapters/{github,greptile-export}.test.ts`, `packages/corpus/src/{classify,discover,names,scan,similarity}.test.ts`; `packages/mcp-server/src/corpus/{citations,ingest,mutex,names,plan,routes,settings,validate}.test.ts`; `packages/mcp-server/src/{docs-ingest,observe,rollback-compat,index-store.migrate-contract,index-store.migrate-harness,index-archive,index-store.archive}.test.ts`; `packages/mcp-server/src/planes/{lightrag-bulk,lightrag.contract,lightrag}.test.ts` | 947 pass, 12 skip, 0 fail (959 tests, 11.9 s). The skips are the PG-gated describe blocks with the URL unset; the 10 tests of `index-store.archive.test.ts` account for 10 of them, and I did not isolate the other two. |
| `SUBSTRATE_TEST_PG_URL=postgres://postgres:…@127.0.0.1:5439/substrate_test_v63 TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test packages/mcp-server/src/index-store.archive.test.ts` | the archive round trip, the whitelist test and the corpus restore tests | 10 pass, 0 fail, 261 expect calls (scratch Postgres at 127.0.0.1:5439, database `substrate_test_v63`, not production) |
| same, `packages/mcp-server/src/index-archive.test.ts` | archive spec, verifier, gates | 65 pass, 0 fail, 1325 expect calls |
| same, `packages/mcp-server/src/corpus/store.test.ts` | manifest store | 15 pass, 0 fail, 61 expect calls |

Each Postgres file ran in its own process against `substrate_test_v63`. No production database and no port 5432 was touched.

## Success criteria

| # | Criterion (as amended) | Status | Evidence |
|---|---|---|---|
| 1 | Scan returns sorted, deterministic entries; collapse rules; the next copy becomes canonical; a rename is reported only within one repository, and a copy that moves to another collection is an add plus a tombstone; exclusions and size caps hold | VERIFIED | Three levels. Artifact: `packages/mcp-server/src/corpus/plan.ts` 68-85 pairs a removed row with a new entry only on `keyOf(repo, sha256)`, so a rename never crosses repositories; a moved copy becomes an add, and the old row a tombstone when its repository is covered. Wiring: the plan feeds `planCorpus` and the CLI print (carried forward). Behaviour: `plan.test.ts` line 42 (same text at a new path is one rename) and line 59 "a rename never crosses repositories" (add 1, tombstone 1, rename 0) pass in the non-PG run. Scan determinism, collapse and caps: `scan.test.ts` passes (carried forward; `scan.ts` unchanged since 9e71f263). |
| 2 | `substrate corpus scan`, `plan`, `ingest` and `status` work against a server; `plan` sends entries without bodies and prints counts; `ingest` is a dry run until `--execute` | VERIFIED (carried forward) | `packages/cli/src/corpus/index.test.ts` passes in the non-PG run. No CLI or route file changed since 9e71f263. Not exercised against a live server. |
| 3 | A migration step creates `corpus_documents` (additive, reversible, digest fixture and rollback-compat doc updated); the corpus doors and MCP tools audited and admitted; the table covered by the index archive and restore spec; its restore tested | VERIFIED | Three levels. Artifacts: step 35 `index-store.ts:700-728` (expand, `if not exists`, `down` drops the table, three indexes, `manifest_seq` identity). Archive spec `index-archive-spec.ts:216` has the 17 columns of steps 35 and 38, `tier` as smallint, `signals` as jsonb, `manifest_seq` as bigint identity, primary key `(repo, path)`. Restore: `index-store.ts:3134` `advanceIdentity` moves each identity sequence past the restored maximum (`coalesce(max, 1)`, `is_called` false on an empty table); `index-archive.ts:1028` calls it after each table's rows are loaded; `index-store.ts:3130` writes jsonb as `text::jsonb`; the export casts jsonb and bigint to text (`index-store.ts:3075-3078`). The migrate-contract allowlist no longer excludes `corpus_documents` (line 62 removed). `index-archive-watch.ts` counts ten archived tables. Wiring: the archive reads `ARCHIVE_TABLES`, which holds the new spec, so the export, manifest, verifier and restore all include the table. Level 4: the export reads the live table through the snapshot reader; the round trip compares restored rows against the file rows (`index-store.archive.test.ts` "archive → verify → restore into a scratch database", the `directRows(corpus, restored)` equality and the tombstone with `superseded_by` and jsonb signals). Behaviour: "after a restore, a plain insert into corpus_documents takes a manifest_seq above every restored one" (`index-store.archive.test.ts:263`) passes on scratch Postgres: the restored sequence does not regress. The whitelist test "the closed whitelist is exactly what migrate() created" passes, so the spec and the migrated table agree on every column, type and key. Docs: `docs/runbooks/index-archive.md` line 29 states that the schema hash changed and a new archive is needed; `docs/runbooks/rollback-compat.md` line 48 names step 35. The corpus doors and MCP tools (`admission.ts`, `mcp.ts`, `packages/audit/src/policy.ts`) are unchanged since the previous record and their tests pass in the non-PG run (carried forward). |
| 4 | The LightRAG bulk path sends batches through `POST /documents/texts` with bounded concurrency and one pipeline poll per batch, redacts and refuses secrets as `docs_ingest` does, and carries repo and path into the document source; kind, tier and commit stay in the manifest, and the plane document carries name and text | VERIFIED | Three levels. Artifacts: `packages/mcp-server/src/planes/lightrag-bulk.ts` 46-49 `BulkTextDocument` is `{name, text}`, as the amended criterion says. The plane document name is `corpusDocumentName(repo, path, sha256)` (`ingest.ts:249`, `packages/corpus/src/names.ts:125`), so repo and path reach the document source. Wiring: `lightrag-bulk.ts` 231-234 posts `{texts, file_sources}` to `/documents/texts` with the names as `file_sources`. Behaviour: `lightrag.contract.test.ts` and `lightrag-bulk.test.ts` pass in the non-PG run; the secret refusal in `ingest.ts` is carried forward. kind, tier and commit reach the manifest row only, as the amended criterion says. Closed by the owner decision of 2026-11-04 (1e17db11). |
| 5 | A removed or renamed document is tombstoned through `delete_document` (only when no other active row shares the plane document); the row says `tombstoned`; a rename within one repository is a rename; a copy that moves to another collection is an add plus a tombstone; tombstones only for a completely scanned repository at the declared scope | VERIFIED (carried forward) | `ingest.test.ts` tombstone, shared-document and failed-delete tests pass in the non-PG run; `plan.test.ts` line 59 pins the add plus tombstone for a cross-repository move. The wording change in `bdc1dc1a` states the rule the code and tests already follow. |
| 6 | A second identical run reports `unchanged` and sends nothing; a run killed half way resumes without re-sending recorded documents | VERIFIED (carried forward) | `ingest.test.ts` and `routes.test.ts` pass in the non-PG run. No file on this path changed since 9e71f263. |
| 7 | Greptile export directory and GitHub through `gh` produce the same entries; both bounded by `--max-repos` and `--tier` | VERIFIED (carried forward) | `adapters/greptile-export.test.ts` and `adapters/github.test.ts` pass in the non-PG run. Adapters unchanged. No live export or `gh` run. |

**Score:** 7/7 criteria verified. Criteria 1 and 4 are verified against the amended text; criterion 3 is verified against its wording, which was not amended.

## Requirements coverage (ATLAS-01 to ATLAS-06)

| Requirement | Status | Evidence |
|---|---|---|
| ATLAS-01 scan lists docs with repo, path, kind, tier, sha256 and size; collapses clones, worktrees and identical copies; a rename only within one repository; a copy that moves is an add plus a tombstone | SATISFIED | SC1 (amended text; `plan.test.ts` lines 42 and 59). Live scan of the VPS not run. |
| ATLAS-02 `plan` reports add, change, rename, tombstone without bodies | SATISFIED | `plan.test.ts`; CLI `index.test.ts` (carried forward). |
| ATLAS-03 bulk route without a serial wait per page; repo and path provenance (kind, tier, commit in the manifest; the plane document carries name and text); refuses secrets | SATISFIED | SC4 (amended text). |
| ATLAS-04 removed or renamed documents tombstoned; narrower scan never tombstones outside its coverage | SATISFIED | SC5 tests (carried forward). |
| ATLAS-05 same run changes nothing; interrupted run resumes | SATISFIED | SC6 tests (carried forward). |
| ATLAS-06 Greptile and GitHub-without-clone enter the same manifest through documented adapters | SATISFIED | SC7 tests (carried forward). |

**ORPHANED requirements:** none. Every ATLAS ID is declared by this phase's ROADMAP entry.

## Required artifacts and key links

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/corpus/src/scan.ts` | scan, collapse, caps | VERIFIED | tests pass (non-PG run). Unchanged. |
| `packages/corpus/src/adapters/github.ts`, `greptile-export.ts` | source adapters | VERIFIED | tests pass. Unchanged. |
| `packages/cli/src/corpus/index.ts`, `ingest.ts`, `client.ts` | CLI commands | VERIFIED | `index.test.ts` passes. |
| `packages/mcp-server/src/corpus/{plan,ingest,service,store,validate,routes}.ts` | server doors and ingest | VERIFIED | plan, ingest and routes tests pass; `corpus/store.test.ts` 15/15 on scratch Postgres. |
| `packages/mcp-server/src/planes/lightrag-bulk.ts` | `/documents/texts` bulk client | VERIFIED | fake-plane tests pass; `{name, text}` as amended. |
| `packages/mcp-server/src/index-store.ts` step 35 | additive `corpus_documents` | VERIFIED | digest and reversibility tests pass; `advanceIdentity` tested on scratch Postgres. |
| `packages/mcp-server/src/index-archive-spec.ts` `corpus_documents` | archive spec, closed list | VERIFIED | whitelist test equals `migrate()`; round trip passes on scratch Postgres. |
| `packages/mcp-server/src/index-archive.ts` restore | identity advance per table | VERIFIED | line 1028; restored-sequence test passes. |

**Key links (wiring):** CLI to `POST /corpus/plan` and `/corpus/ingest` (`client.ts`) WIRED. Routes to `corpusPlanReply` and `corpusIngestReply` WIRED. MCP tools to the same service WIRED. Ingest to the bulk plane (`ingest.ts` to `lightrag-bulk.ts`) WIRED. Ingest to the manifest store (`ingest.ts` to `store.ts`) WIRED. Archive restore to the spec's identity columns (`index-archive.ts:1028` to `index-store.ts:3134`) WIRED.

**Level 4 (data flow):** the manifest read in `corpusPlanReply` and `corpusStatusReply` comes from `store.rowsForRepos`, `manifestVersion` and `newestIngestAt`: real queries, exercised by `corpus/store.test.ts` (15 pass). The archive export reads the live table through the snapshot reader and the round trip compares it with the restored rows. FLOWING.

## Behavioral spot-checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Archive round trip, whitelist, restored sequence (PG) | `SUBSTRATE_TEST_PG_URL=…/substrate_test_v63 bun test packages/mcp-server/src/index-store.archive.test.ts` | 10 pass, 0 fail | ✓ PASS |
| Archive spec, verifier, gates (PG set) | same, `index-archive.test.ts` | 65 pass, 0 fail | ✓ PASS |
| Manifest store (PG) | same, `corpus/store.test.ts` | 15 pass, 0 fail | ✓ PASS |
| Phase 63 targeted, non-PG | `env -u SUBSTRATE_TEST_PG_URL bun test` (31 files) | 947 pass, 12 skip, 0 fail | ✓ PASS |
| Live ingest, live server, live LightRAG, live archive | not run (operator-gated) | n/a | ? SKIP |

## Probe execution

No probes apply: no `scripts/*/tests/probe-*.sh` exists for this phase, and neither the PLAN nor the SUMMARY declares one.

## Anti-patterns found

The added lines of the changed phase files (`ebabe6ef`, `1e17db11`, `bdc1dc1a`) contain no `TBD`, `FIXME`, `XXX`, `TODO`, `HACK` or `PLACEHOLDER` marker. The `placeholders` field in the archive spec is the restore value for withheld columns, not a stub. The earlier scan of the covered implementation files found only guard returns, which are not stubs.

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| (none) | - | - | - | - |

## Deferred items

None. No gap remains to defer. Step 9b checked the later phases; none addresses the archive of `corpus_documents`, which this phase now covers.

## Advisory (New Scope, Unevidenced)

None. Re-verification found no new-scope findings.

## Human verification required

Status is `human_needed` because all seven criteria are verified and the operator-gated items below remain. They are listed in the `human_verification` frontmatter.

1. **Live ingest.** Run `substrate corpus ingest --execute` against the live corpus with the server on `SUBSTRATE_CORPUS=on` and a LightRAG backend. Expected: a dry-run plan first, then batches that report `ingested`, `unchanged` on a repeat, and no secret refusals on the real corpus.
2. **Greptile export.** Ingest a real Greptile knowledge-base export directory. The `<owner>/<repo>/<path>.md` layout is what the code reads and is unconfirmed against a real export.
3. **GitHub through `gh`.** Ingest repositories with no local clone through a logged-in `gh`. Expected: the same entry shape as the Greptile source.
4. **Migration step 35 and the archive.** Apply step 35 to a restored dump and run the rollback check (`docs/runbooks/rollback-compat.md`). Take a new index archive on this release: the schema hash changed, so an archive written before `ebabe6ef` fails `verify-archive` (kind `schema`). Accepted by owner decision 3.

## Gaps summary

No gaps. The three previous gaps are closed:

1. **SC1, cross-repository rename.** Closed by the owner decision of 2026-11-04 in the criterion. The code and `plan.test.ts` match the amended text.
2. **SC3, archive and restore.** Closed by `ebabe6ef`: the table is in the archive spec, the restore advances the sequence, and the restore is tested on scratch Postgres.
3. **SC4, provenance in the plane document.** Closed by the owner decision of 2026-11-04 in the criterion. The plane document carries name and text; kind, tier and commit stay in the manifest.

---

_Verified: 2026-11-05T00:14:36Z_
_Verifier: Claude (gsd-verifier)_
