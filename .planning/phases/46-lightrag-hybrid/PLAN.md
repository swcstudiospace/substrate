---
phase: 46-lightrag-hybrid
milestone: v1.5
requirements: [SOTA-02]
rescoped: 2026-10-23
status: planned; T1 and T2 in progress elsewhere; T3 recorded here; T4 deferred; T5 to T8 HARD_STOP
---

# 46-PLAN: LightRAG hybrid RAG with Hindsight context and the RAGFlow migration

Governing decisions: `46-lightrag-hybrid/CONTEXT.md` (D46-1 to D46-5). The RAG-hybrid plan in `46-ragflow-hybrid/` is superseded (D46-4).

## Success criteria (ROADMAP Phase 46, verbatim)

1. docs_search answers from LightRAG with hybrid search and Hindsight context, with tests.
2. The RAGFlow dataset is archived, with a verified checksum, before any deletion.
3. LightRAG is deployed to Agent Substrate production and passes a timed health probe.
4. The migration job and parity comparator pass PARITY_GATE before any ingestion. PARITY_GATE checks, in order: every migrated record keeps its dataset, source URL and version (zero mismatches allowed); a fixed sample of queries, listed in the phase 46 PLAN, returns citations from the same source documents at the match rate the PLAN sets before the run.
5. Cutover is a logged, reversible switch with a delta pass. RAGFlow code and service are removed only after cutover, after criteria 1 to 4 pass, and after every other RAG-dependent phase passes. The RAG-dependent phases are 25 and 42, plus any other phase whose VERIFICATION names a live RAGFlow call (the phase 46 PLAN confirms that list before cutover). Storage deletion needs its own approval.
6. Every live step (deploy, ingestion, cutover, storage deletion) runs only after the operator approves it for that run.

## Criteria to tasks and verification

| Criterion | Tasks | Verification | Status in this run |
|---|---|---|---|
| 1 | T1 (tests), T2 (docs) | `bun test packages/mcp-server/src/docs-search.test.ts` on the success-path context tests, run by the orchestrator once | Pending T1 and T2 (in progress elsewhere). Default mode is `hybrid` at `planes/lightrag.ts:40`, unchanged. |
| 2 | T5 | Archive checksum recorded and matched before any deletion | HARD_STOP. Not run. |
| 3 | T6 | Timed health probe of the production LightRAG endpoint | HARD_STOP. Not run. |
| 4 | T3 (sample and rate, recorded here), T4 (comparator, deferred), T7 (migration job and gate, live) | Zero dataset, source URL and version mismatches; sampled queries return citations from the same source documents at 100 percent | T3 recorded. T4 deferred. T7 HARD_STOP. Criterion 4 is NOT met in this run. |
| 5 | T8 | Logged cutover with delta pass; RAGFlow removal only after 1 to 4 and the RAG-dependent phases | HARD_STOP. Not run. Blocked by 2, 3, 4 and the phase list below. |
| 6 | T5, T6, T7, T8 | Operator approval recorded for each run before the run | Each live task carries its own approval gate. |

## Tasks

### T1 — LightRAG success-path context tests (in progress elsewhere)

- Files: `packages/mcp-server/src/docs-search.test.ts` (existing).
- Change: tests that a successful LightRAG answer carries a `context` block with recalled memories when `context: true` is passed (D46-3), that the reply has no `context` key without the flag, that `no-session` is reported when no session is given, that a recall failure keeps the chunks, and that a context reply is not stored in the cache. Fakes only.
- Verification: the orchestrator runs `bun test packages/mcp-server/src/docs-search.test.ts` once after T1 and T2 land.
- Commit boundary: one commit with T2 or on its own, as the orchestrator decides.
- Rollback: revert the test commit. No runtime code depends on these tests.

### T2 — Docs for the LightRAG hybrid and context options (in progress elsewhere)

- Files: `docs/docs-plane.md`, `docs/docs-search-ingest.md` (both exist).
- Change: describe the LightRAG default mode `hybrid` (`lightrag.ts:40`), the `mix` option, and the opt-in `context` block with its sources, budgets and untrusted labelling (D46-2, D46-3).
- Verification: the docs match what T1 pins. Read check by the orchestrator. No generated reference is involved.
- Commit boundary: one docs commit.
- Rollback: revert the docs commit.

### T3 — PARITY_GATE fixed query sample and match rate (recorded in this PLAN)

Match rate, set before any run (D46-5): 100 percent. Every sampled query must return citations from the same source documents as its expected set. Fail closed: any miss fails PARITY_GATE, and no ingestion runs.

The sample: ten fixed queries. Each expected source document is a file in this repository's `docs/` directory. Each path was checked with a glob of `docs/*.md` in this worktree on 2026-10-24, and all ten exist.

| # | Query | Expected source document |
|---|---|---|
| Q1 | Which LightRAG query mode does docs_search use by default? | `docs/docs-plane.md` |
| Q2 | How does docs ingest refuse secrets or unsourced pages? | `docs/docs-search-ingest.md` |
| Q3 | How is Hindsight memory governed for retained memories? | `docs/memory-governance.md` |
| Q4 | How are Greptime ledger events stored and read? | `docs/greptime-ledger.md` |
| Q5 | What is the closed event vocabulary? | `docs/event-vocabulary.md` |
| Q6 | How does the redactor treat secrets in output? | `docs/redaction.md` |
| Q7 | How does the substrate dispatcher start a Hermes session? | `docs/dispatcher.md` |
| Q8 | How does the skills propose flow check expected versions? | `docs/skills-propose.md` |
| Q9 | How does the Railway service connect over Tailscale? | `docs/railway-tailscale.md` |
| Q10 | What does the MCP audit log record? | `docs/mcp-audit.md` |

Limit of this check: the glob confirmed each path exists. The query-to-file pairing was chosen from file names and has not been confirmed by reading each file's content. Before T7 runs, each pairing must be confirmed against the file content. That confirmation is part of T3's acceptance.

Content check, 2026-10-24 (read-only; each sample document was read at its opening and searched for the fact its query asks about):
- CONFIRMED, 9 of 10: Q1 docs-plane.md:90 (default query mode `hybrid`); Q2 docs-search-ingest.md, "The six ingest refusals"; Q3 memory-governance.md:594-618 (Hindsight holds a derived copy, forwarded on accept); Q4 greptime-ledger.md:32 (reads through `events_query`) and "The store lock" (storage); Q5 event-vocabulary.md (closed vocabulary, both enums); Q6 redaction.md (publication paths and the 39-rule table); Q7 dispatcher.md (Linear label to Hermes session in a per-Graph-ID worktree); Q9 railway-tailscale.md (forwarder per project); Q10 mcp-audit.md (one hash-chained record per call, allowed or denied).
- FAILED, Q8: docs/skills-propose.md has no expected-version concept (no "version" or "expected" in the file, case-insensitive). expected_version is enforced on skill approval and docs ingest (phase 35 tests) and on memory decisions (memory-governance.md:200-239), never on the propose flow.
- Result: T3 acceptance is NOT met. Proposed amendment, awaiting operator approval because the sample is fixed before any run: Q8 becomes "What does the skills propose flow check before it opens a pull request?", with expected source docs/skills-propose.md (sections "What is checked, and in what order" and "Duplicates"). Not applied; the sample above is unchanged.

- Files: this PLAN (no separate sample file is created).
- Verification: glob of `docs/*.md` (done), plus the content confirmation above before T7.
- Commit boundary: part of the PLAN commit.
- Rollback: revert the PLAN commit. The sample has no runtime effect.

### T4 — Parity comparator (BLOCKED)

- Status: BLOCKED. Reclassified from DEFERRED on 2026-10-24, because only the user can defer a task. Unblock: the operator approves T5, and a read-only export of the RAGFlow dataset is captured.
- Reason: the comparator must be checked against the live RAGFlow dataset. A fixture-level design is out of this run's budget, and a fixture design would not prove PARITY_GATE against the real dataset anyway.
- Unblock step: (1) T5 archive completes with a verified checksum (operator approval); (2) a read-only export of the RAGFlow dataset's document list (dataset, source URL, version) is captured for the comparator; (3) the comparator is written against that export and tested against the export; (4) the comparator is then reviewed before T7.
- Files when unblocked: to be set in a follow-up PLAN, not this one.

### T5 — Archive the RAGFlow dataset with a verified checksum (HARD_STOP)

- Approval: the operator must approve this run in writing before it starts. Not approved.
- Change: export the RAGFlow dataset to archive storage and record a checksum; re-read the archive and match the checksum before any deletion.
- Verification: checksum match recorded in the phase folder.
- Commit boundary: none in repo; the evidence is recorded in the phase folder.
- Rollback: the archive is not deleted by this task. Restoring from it is a separate operator action.

### T6 — Deploy LightRAG to production and pass a timed health probe (HARD_STOP)

- Approval: the operator must approve this run in writing. Not approved.
- Change: deploy LightRAG to Agent Substrate production; run a timed health probe against the deployed endpoint.
- Verification: probe result, with its time, recorded.
- Commit boundary: deployment configuration commit, if any, is separate.
- Rollback: undeploy the LightRAG service. RAGFlow is still in place, so docs search keeps answering from it.

### T7 — Migration job and parity gate before ingestion (HARD_STOP)

- Approval: the operator must approve this run in writing. Not approved.
- Prerequisites: T4 comparator unblocked and reviewed; T3 content confirmation done; T5 and T6 complete.
- Change: run the migration job, then PARITY_GATE in its two checks, in order: (1) zero mismatches on dataset, source URL and version; (2) the ten T3 queries return citations from the expected documents at 100 percent. No ingestion runs unless both pass.
- Verification: the PARITY_GATE result recorded in the phase folder, with the mismatch count and per-query results.
- Commit boundary: none in repo for the live run.
- Rollback: LightRAG ingestion is not used until cutover, so a failed gate leaves RAGFlow serving.

### T8 — Cutover and RAGFlow removal (HARD_STOP)

- Approval: the operator must approve cutover and approve removal separately. Storage deletion needs its own approval (criterion 5). Not approved.
- Preconditions (all required):
  1. Criteria 1 to 4 pass.
  2. RAG-dependent phases pass. Confirmed list for this PLAN, from the phase VERIFICATION files and the ROADMAP:
     - Phase 25 (named in criterion 5; ROADMAP line 299 onwards). No phase folder or VERIFICATION exists in this worktree. Blocker, see Blockers.
     - Phase 42 (named in criterion 5): `.planning/phases/42-skill-card/VERIFICATION.md` line 40 records that the RAGFlow `agent-skills` dataset and the live fast-forward are not run.
     - Phase 40 (`.planning/phases/40-docs-memory/VERIFICATION.md` line 30): live TCP reachability to RAGFlow.
     - Phase 51 (`.planning/phases/51-enterprise-fabric/VERIFICATION.md` line 61): live RAGFlow GET probes; also a RAGFlow panel (line 28).
     - Phase 34 (`.planning/phases/34-invalid-write-round-trip/VERIFICATION.md` line 34) names RAGFlow only as a fake and is NOT a live dependency, so it is excluded from the list. This exclusion is a judgement, to be confirmed by the operator.
  3. A logged, reversible cutover switch with a delta pass.
- Change: switch the default docs backend to LightRAG with a logged switch; run the delta pass; then remove the RAGFlow code and service in a separate commit after cutover.
- Verification: delta pass recorded; RAGFlow references removed; `store-lock` and config tests still pass (run by the orchestrator).
- Commit boundary: cutover switch commit, then a separate removal commit.
- Rollback: the switch is reversible until removal. After removal, rollback means restoring the RAGFlow code and service from the archive (T5).

## Risks

- Criterion 4 is not met in this run. The comparator is deferred (T4), so no ingestion can start yet.
- The ten-query sample is small. A 100 percent rate fails closed on any single miss, so a poor sample would block the gate. Pairings are unconfirmed by content (T3 limit).
- Phase 25 has no in-repo evidence of passing other than its ROADMAP entry, so criterion 5 cannot be checked from the repo.
- The list of RAG-dependent phases was built from VERIFICATION text search. A phase that names RAGFlow in another file would be missed; the operator should confirm the list before T8.
- Hindsight context is per call and not cached. Its latency is bounded by `searchRecallBudgetMs` (`service.ts:238-239` margin, `docs-search.ts:248-249` ledger budget). A slow recall adds latency to context answers.
- D46-3 (success-path context) and D46-5 (rate) are flagged for review. Both are reversible.

## Blockers

1. Criterion 4 comparator (T4) is deferred. Unblock: T5 archive with checksum (operator approval), then the read-only export and the comparator as described in T4.
2. Live steps T5 to T8 wait for explicit operator approval for each run. Unblock: the operator approves each run in writing.
3. Phase 25 pass evidence is not in this worktree (no `.planning/phases/25-*` folder). Unblock: the operator or the phase 25 owner supplies its VERIFICATION or confirms the ROADMAP completion, and the live G1-G4 tail is recorded.
4. T1 and T2 are in progress elsewhere. Unblock: those tasks land, and the orchestrator runs the gates once.
5. The T3 query-to-file pairing needs a content read of each expected document. Unblock: read each of the ten files before T7.
