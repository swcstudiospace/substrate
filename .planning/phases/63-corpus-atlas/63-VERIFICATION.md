---
phase: 63-corpus-atlas
verified: 2026-11-19T00:56:41Z
status: human_needed
score: 6/7 success criteria verified in code and by the corpus test run; criterion 3 restore test and the live Postgres store tests are human_needed
covered_files: [".planning/phases/63-corpus-atlas/63-CONTEXT.md", ".planning/phases/63-corpus-atlas/63-SUMMARY.md", "package.json", "packages/audit/src/policy.ts", "packages/cli/package.json", "packages/cli/src/corpus/bodies.ts", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/ingest.ts", "packages/cli/src/corpus/inventory.ts", "packages/cli/src/corpus/render.ts", "packages/cli/src/corpus/testkit.ts", "packages/cli/src/index.ts", "packages/corpus/package.json", "packages/corpus/src/adapters/github.ts", "packages/corpus/src/adapters/greptile-export.ts", "packages/corpus/src/classify.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/guards.ts", "packages/corpus/src/index.ts", "packages/corpus/src/names.ts", "packages/corpus/src/protocol.ts", "packages/corpus/src/scan.ts", "packages/corpus/src/similarity.ts", "packages/corpus/src/test-support.ts", "packages/mcp-server/package.json", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/ingest.ts", "packages/mcp-server/src/corpus/mutex.ts", "packages/mcp-server/src/corpus/names.ts", "packages/mcp-server/src/corpus/plan.ts", "packages/mcp-server/src/corpus/reconcile.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/store.ts", "packages/mcp-server/src/corpus/testkit.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/docs-datasets.ts", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-archive-spec.ts", "packages/mcp-server/src/index-store.migrations.digests.json", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planes/__fixtures__/lightrag-v1.5.7-routes.json", "packages/mcp-server/src/planes/lightrag-bulk.ts", "packages/mcp-server/src/planes/lightrag.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v4:sha256:ab0fc6f6b664d169636f79e107759a04e2c41b9cf623a2afffbfdc6d4fcc9c45"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/7
  gaps_closed:
    - "Criterion 1 (rename on canonical move): plan.ts pairs a removed row with a new entry across local/* copy collections when the sha256 matches; PlanItem carries renamedFromRepo (protocol.ts); the CLI removes the old row from that repository (cli/src/corpus/ingest.ts renamedFromRow). Within-repository pairing runs first."
    - "Criterion 3 (archive and operator surface): corpus_documents is no longer in the migrate-contract exclusion list (only corpus_retrievals and corpus_feedback are); index-archive-spec.ts carries it with signals as jsonb and manifest_seq as the identity restore moves past; corpus_ingest runs through corpusIngestReply with operatorOnly, refusing a non-operator with 403 operator-required (routes.test.ts), and the MCP tool and route pass isOperator."
    - "Criterion 4 (document source fields): the plane document name is corpusDocumentName(repo, path, sha256, facts), carrying kind, tier and commit, and it is the file_sources entry sent to /documents/texts (names.ts; lightrag-bulk.ts)."
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Run SUBSTRATE_TEST_PG_URL=<scratch-capable server> bun test packages/mcp-server/src/index-store.archive.test.ts (archive, verify, restore of corpus_documents)"
    expected: "Equal counts and hashes after restore into a scratch database; next manifest_seq above the restored values"
    why_human: "Needs Postgres; the restore test skips without it"
  - test: "Run bun test packages/mcp-server/src/corpus/store.test.ts and reflect-store.test.ts with SUBSTRATE_TEST_PG_URL set"
    expected: "The 23 skipped live-Postgres tests pass"
    why_human: "They skip without Postgres"
  - test: "Send one document to a live LightRAG with the corpus name as file_sources"
    expected: "The stored file path equals corpus:<repo>:<path>@<sha12>.<kind>.<tier>.<commit>"
    why_human: "Upstream acceptance of the longer name is inferred from v1.5.7 source, not observed"
  - test: "Owner decision: plane name after a metadata-only refresh (same bytes, new kind, tier, source or commit)"
    expected: "Accept that the plane name records facts as of first send (fix names.ts header, docs/docs-plane.md:168, docs/runbooks/docs-rag-operations.md:170) or re-send on a fact change"
    why_human: "Cost versus currency decision for the owner"
  - test: "Carried forward: live deploy with SUBSTRATE_CORPUS=on, live ingest with dry run and --execute, LightRAG route diff, Greptile export layout, gh adapter, migration step 35 rehearsal"
    expected: "As listed in body item 5"
    why_human: "Needs live services and credentials"
---

# Phase 63: Corpus Atlas Verification Report

**Phase Goal:** The documentation of every repository the owner keeps (the clones on the VPS, the GitHub organisations, the Greptile knowledge bases) is discovered, classified, de-duplicated and recorded in one manifest, and a bulk path puts new and changed documents into the docs plane with provenance and removes the ones that disappeared.
**Verified:** 2026-11-19T00:56:41Z
**Status:** human_needed
**Re-verification:** Yes, after gap closure (previous record: gaps_found, criteria 1, 3 and 4 failed)

## Scope of this run

- Code read in the worktree `/root/src/worktrees/as-autonomous` (uncommitted gap-closure changes).
- Test run, once: `bun test --timeout 60000 packages/mcp-server/src/corpus/` (25 files). Result: 410 pass, 23 skip, 0 fail, 433 tests, 22.8 s. The 23 skips are the live-Postgres blocks in `corpus/store.test.ts` and `corpus/reflect-store.test.ts`, gated on a Postgres URL that this run does not have.
- Not run (outside the assigned folder, static reading only): `packages/corpus/src/names.test.ts`, `packages/cli/src/corpus/*.test.ts`, `packages/mcp-server/src/index-archive*.test.ts`, `packages/mcp-server/src/index-store.archive.test.ts` (live), `packages/mcp-server/src/rollback-compat.test.ts`.

## Goal Achievement

### Observable Truths

| #   | Truth   | Status     | Evidence       |
| --- | ------- | ---------- | -------------- |
| 1   | Scan collapses clones, worktrees and byte-identical copies; a canonical copy that disappears is replaced by the next copy and the plan reports a rename, including a move between copy collections | ✓ VERIFIED | Scan, collapse, bounds and exclusions were verified in the prior run and `scan.ts` is unchanged. Rename: `mcp-server/src/corpus/plan.ts` lines 71-115 pair removed rows with adds first within one repository, then across `local/*` collections only (`COLLECTION_PREFIX`), and emit `renamedFromRepo` when the repository differs. Tests pass in the run: `plan.test.ts` "a canonical copy that moves between copy collections is one rename, naming its old collection", "within one repository a rename pairs before any cross-collection pair", "a copy collection and a checkout never pair". `docs/corpus.md:103-105` and `:262` describe the same rule. |
| 2   | `scan`, `plan`, `ingest` and `status` work against a server; plan sends no bodies; ingest is a dry run until `--execute` | ✓ VERIFIED | Unchanged by the gap closure. Covered by the prior run's CLI and route tests, and the `corpus` run above (`routes.test.ts`, `plan.test.ts`). |
| 3   | Migration step creates `corpus_documents`; `/corpus/plan`, `/corpus/ingest`, `/corpus/status` and the MCP tools `corpus_status` (read) and `corpus_ingest` (write, operator) are audited; the table is covered by the index archive and its restore is tested | ⚠️ human_needed (static parts ✓) | Migration step 35 in `index-store.ts:696-729`, unchanged. Archive: `index-archive-spec.ts:213-241` lists `corpus_documents` with `signals` as jsonb, `manifest_seq` as the identity, and `key: [repo, path]`; `index-store.ts:3167-3170` moves the identity sequence past restored rows. The migrate-contract exclusion list now names only `corpus_retrievals` and `corpus_feedback` (`index-store.migrate-contract.test.ts:65-66`). Operator gate: `service.ts:128-137` (`gateOf` with `operatorOnly`), `service.ts:200-201` (`corpusIngestReply`), `server.ts:1774-1785` and `mcp.ts:1765-1802` pass `isOperator`; `routes.test.ts:119` "an authenticated surface that is not an operator is refused 403 operator-required" passed in the run. Restore test: `index-store.archive.test.ts` inserts into `corpus_documents` and restores into a scratch database, but that file needs `SUBSTRATE_TEST_PG_URL` and was not run. Human item 1. |
| 4   | LightRAG bulk path sends `POST /documents/texts` batches with bounded concurrency, one poll per batch, secret refusal, and carries repo, path, kind, tier and commit into the document source | ✓ VERIFIED (send path) with WARNING, see item 4 | The source the plane receives is `file_sources: docs.map((doc) => doc.name)` (`planes/lightrag-bulk.ts:234`). The name is `corpusDocumentName(repo, path, sha256, document)` (`corpus/ingest.ts:255`), which is `corpus:<repo>:<path>@<sha12>.<kind>.<tier>.<commit or ->` (`names.ts:143-149`). `ingest.test.ts` "a new document is sent under its corpus name" checks the plane stores the text under that name; `names.test.ts` "a name with facts carries the kind, the tier and the commit". The WARNING is the refresh path (`refreshMetadata`, `ingest.ts:220-250`), which updates kind, tier, source and commit on the row only and leaves the plane document name unchanged. |
| 5   | Removed or renamed documents are tombstoned through `delete_document`, only when no other active row shares the plane document; a narrower scan leaves earlier rows alone | ✓ VERIFIED | Unchanged by the gap closure. The run above includes `ingest.test.ts` tombstone and shared-document tests and `plan.test.ts` scope tests. |
| 6   | A second identical run reports `unchanged` and sends nothing; a killed run resumes | ✓ VERIFIED | Unchanged. `ingest.test.ts` "a document already recorded at the same sha is unchanged", "a run killed after the first batch resumes" passed in the run. |
| 7   | Greptile export and GitHub adapters produce the same entries, bounded by `--max-repos` and `--tier` | ✓ VERIFIED | Unchanged. Adapter tests are in `packages/corpus/src/adapters/*.test.ts`, which was not run in this pass; the prior run passed them. |

**Score:** 6/7 criteria verified. Criterion 3 is human_needed because its restore test is live-only. No criterion is FAILED.

### Gap closure, checked against code

- **Gap A (criterion 1).** Closed. The planner pairs across copy collections, `PlanItem.renamedFromRepo` is declared in `packages/corpus/src/protocol.ts:135`, `client.ts:99-100` validates it, and `cli/src/corpus/ingest.ts:91-96` removes the old row from `renamedFromRepo`, falling back to the new repository. `render.ts:112` prints the qualified name.
- **Gap B (criterion 3).** Closed in code. Archive, identity reset and operator gate are all present. The restore test is pending a live database (human item 1).
- **Gap C (criterion 4).** Closed for the send path. See truth 4 and item 4.

### Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/corpus/plan.ts` | cross-collection rename pairing | ✓ VERIFIED | Two-pass pairing, `renamedFromRepo` |
| `packages/corpus/src/protocol.ts` | `PlanItem.renamedFromRepo` | ✓ VERIFIED | Line 135 |
| `packages/cli/src/corpus/ingest.ts` | rename removes the old row in its own repository | ✓ VERIFIED | `renamedFromRow` |
| `packages/mcp-server/src/index-archive-spec.ts` | `corpus_documents` spec, jsonb signals, identity `manifest_seq` | ✓ VERIFIED | Lines 213-241 |
| `packages/mcp-server/src/index-store.migrate-contract.test.ts` | `corpus_documents` not excluded | ✓ VERIFIED | Exclusion list has only retrievals and feedback |
| `packages/mcp-server/src/corpus/service.ts` | `corpus_ingest` operator-only | ✓ VERIFIED | `gateOf` `operatorOnly`, 403 `operator-required` |
| `packages/corpus/src/names.ts` | name carries kind, tier, commit | ✓ VERIFIED | `corpusDocumentName` with facts, `parseCorpusDocumentName` reads them back |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `plan.ts` rename item | CLI tombstone | `renamedFrom` + `renamedFromRepo` | ✓ WIRED | `cli/src/corpus/ingest.ts:144-148` |
| `ingest.ts` | plane | `corpusDocumentName(..., document)` → `file_sources` | ✓ WIRED | `ingest.ts:255`, `lightrag-bulk.ts:234` |
| `server.ts` `/corpus/ingest` | `corpusIngestReply` | `caller.isOperator` | ✓ WIRED | `server.ts:1783` |
| `mcp.ts` `corpus_ingest` | `corpusIngestReply` | `isOperator` | ✓ WIRED | `mcp.ts:1798` |
| restore | `manifest_seq` sequence | `setval` on identity | ✓ WIRED | `index-store.ts:3167-3170` |

### Requirements Coverage

ATLAS-01 to ATLAS-06 map to criteria 1 to 7 as in the prior record. ATLAS-01 (criterion 1) ✓ SATISFIED. ATLAS-02 ✓ SATISFIED. ATLAS-03 (criterion 3) ⚠️ human_needed (restore). ATLAS-04 (criterion 4) ✓ SATISFIED on the send path, with item 4. ATLAS-05 ✓ SATISFIED. ATLAS-06 ✓ SATISFIED.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `docs/docs-plane.md` | 168 | describes the sha-only document name `corpus:<repo>:<path>@<sha12>` | ⚠️ Warning | Stale after gap C. Not updated by this change. |
| `docs/runbooks/docs-rag-operations.md` | 170 | same stale name format | ⚠️ Warning | Stale after gap C. |
| `packages/corpus/src/names.ts` | header | says "a change to any of them is a new name: the plane takes the document again", which is false for the refresh path | ⚠️ Warning | Ties to item 4. |
| `packages/mcp-server/src/corpus/plan.test.ts` | 59 | test title "a rename never crosses repositories" covers only non-collection checkouts | ℹ️ Info | Title narrower than the rule; assertion is correct. |

No `TBD`, `FIXME` or `XXX` marker was found in the phase 63 changed source files.

## Human Verification Required

1. **Live archive restore of `corpus_documents`.** Run `SUBSTRATE_TEST_PG_URL=<scratch-capable server> bun test packages/mcp-server/src/index-store.archive.test.ts`. Expected: archive, verify and restore into a scratch database with equal counts and hashes, and the next `manifest_seq` above the restored values. Why human: needs Postgres; the restore test skips without it.
2. **Live store tests.** Run `bun test packages/mcp-server/src/corpus/store.test.ts packages/mcp-server/src/corpus/reflect-store.test.ts` with `SUBSTRATE_TEST_PG_URL` set. Expected: the 23 skipped tests pass. Why human: they skip without Postgres.
3. **Plane acceptance of the longer name.** Send one document to a live LightRAG and confirm the `file_sources` name `corpus:<repo>:<path>@<sha12>.<kind>.<tier>.<commit>` is stored unchanged. Expected: the document's file path reads back equal to the name. Why human: upstream acceptance of the longer name is inferred from v1.5.7 source, not observed.
4. **Plane name after a metadata-only refresh (owner decision).** When the same bytes arrive with a different kind, tier, source or commit, the row is refreshed and the plane document keeps the name it had at first send (`refreshMetadata`, `ingest.ts:220-250`). Either accept that the plane name records the facts as of the first send, and fix the `names.ts` header and docs-plane.md:168 and docs-rag-operations.md:170 to say so, or send the document again on a fact change. Why human: this is a cost-versus-currency decision for the owner.
5. **Carried forward from the prior record.** Live deploy with `SUBSTRATE_CORPUS=on` (`GET /corpus/status`; anonymous `corpus_ingest` refused with 401); live ingest (plan, dry run, `--execute`, then every document `unchanged`); LightRAG route diff for `/documents/texts` and `/documents/delete_document` against `planes/__fixtures__/lightrag-v1.5.7-routes.json`; Greptile export layout; `gh` adapter with `--max-repos` and `--tier`; migration step 35 rehearsal on a restored dump. Why human: need live services and credentials.

## Gaps Summary

No blocking gap remains. The three gaps from the prior record are closed in code and the corpus test suite passes (410 pass, 0 fail). Status is `human_needed`, not `passed`, because criterion 3's restore test and the live store tests need Postgres, and item 4 needs an owner decision.

---

_Verified: 2026-11-19T00:56:41Z_
_Verifier: Claude (gsd-verifier)_
