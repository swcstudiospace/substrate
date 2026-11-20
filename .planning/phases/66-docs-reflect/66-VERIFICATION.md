---
phase: 66-docs-reflect
verified: 2026-11-18T12:22:47Z
status: human_needed
score: 4/5 success criteria verified in code and targeted tests; criterion 5 live digest and gap run is operator-gated
covered_files: [".planning/phases/66-docs-reflect/66-CONTEXT.md", ".planning/phases/66-docs-reflect/66-SUMMARY.md", "docs/corpus-reflect.md", "packages/cli/src/corpus/reflect.ts", "packages/corpus/src/authority.ts", "packages/corpus/src/reflect.ts", "packages/corpus/src/supersession.ts", "packages/mcp-server/src/corpus/authority-index.ts", "packages/mcp-server/src/corpus/digest-retain.ts", "packages/mcp-server/src/corpus/rank.ts", "packages/mcp-server/src/corpus/reflect-service.ts", "packages/mcp-server/src/corpus/reflect-store.ts", "packages/mcp-server/src/corpus/telemetry.ts", "packages/mcp-server/src/docs-search.ts"]
covered_digest: "v3:sha256:e024b76472337d9e7286b19a523f907dcbcbff7900b3b7a55d64040441dc89ba"
behavior_unverified: 0
overrides_applied: 0
gaps: []
re_verification:
  previous_status: gaps_found
  previous_verified: 2026-10-30
  previous_head: 80afb6e5
  current_head: 357d6b15
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Run the reflect loop against a live stack: set SUBSTRATE_CORPUS, the LightRAG backend and Hindsight, then run `substrate corpus reflect --execute`, and confirm one digest document per repository lands in the docs plane and is retained in Hindsight with document_id replace (a second run replaces, not duplicates)."
    expected: "One digest per repository in the docs plane, a corpus-digest retained entry per repository, and no duplicate Hindsight document after a second run."
    why_human: "Needs a live LightRAG and Hindsight (0.9.1 pin) and an operator-approved run (the command is operator-gated; no schedule exists). Not run by the verifier."
  - test: "With the live corpus and a flag set to on, run `substrate corpus status --gaps` after real searches and confirm the gap rows list the queries that returned nothing useful."
    expected: "Rows keyed by query hash, with search count, best score, last asked and redacted text. A query with no citation counts as a gap."
    why_human: "Gap scores depend on a live plane and on SUBSTRATE_DOCS_GAP_SCORE chosen by the operator. The code path is tested with fakes only."
  - test: "Enable SUBSTRATE_DOCS_TELEMETRY=on against a Postgres with migration step 38 applied and confirm one corpus_retrievals row per docs_search and the retention sweep prunes expired rows."
    expected: "Bounded, redacted rows with the query hash, returned keys and scores; expired rows removed after the retention window."
    why_human: "The live-Postgres store test (packages/mcp-server/src/corpus/reflect-store.test.ts) skips unless SUBSTRATE_TEST_PG_URL is set; it was skipped in this verification's environment. The fake-backed tests pass."

## Goal Achievement

**Phase Goal:** The docs RAG improves with use: it remembers what was retrieved, learns what helped, prefers the current document to the one it replaced, writes digests of what it knows and reports what it could not answer.
**Verified:** 2026-11-18T12:22:47Z
**Status:** human_needed
**Re-verification:** Yes, against the earlier record `66-VERIFICATION.md` (2026-10-30, `gaps_found`, HEAD 80afb6e5). That record read files only and cited no run. This one re-checks the five ROADMAP success criteria at HEAD `357d6b15` (branch `gsd/autonomous-rerun`), where the same modules exist, and runs the targeted tests. The earlier `gaps_found` came from criterion 5 being PARTIAL because no live LightRAG, Hindsight or reflect run existed. A live run is an operator action, so under this verifier's rules it is `human_needed`, not a code gap.

### Observable Truths (ROADMAP success criteria)

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | With `SUBSTRATE_DOCS_TELEMETRY=on` every `docs_search` appends a bounded, redacted row (query hash, capped redacted text, returned keys with scores, backend) to `corpus_retrievals` (its own migration step), with retention. | ✓ VERIFIED (code and fake-backed tests) | `packages/mcp-server/src/corpus/telemetry.ts` (`retrievalRowOf`, `queryTextOf`, `returnedOf`, bounded `RetrievalRecorder`); `packages/mcp-server/src/corpus/reflect-store.ts` (`appendRetrieval`, `sweepRetrievals`); `packages/mcp-server/src/index-store.ts` migration step 38 creates `corpus_retrievals` and `corpus_feedback` (lines ~791-810), always run; `packages/mcp-server/src/docs-search.ts` and `flag-registry.ts` line 890 (`SUBSTRATE_DOCS_TELEMETRY`, default off, retention 30 days). Tests: `packages/mcp-server/src/docs-search.reflect.test.ts`, `telemetry.test.ts`. Live Postgres store test skipped here (no `SUBSTRATE_TEST_PG_URL`). |
| 2 | `docs_feedback` (MCP tool and REST route) records helpful, unhelpful, stale, wrong or duplicate against a document key; audited, admission-limited, idempotent per session and document. | ✓ VERIFIED | `packages/mcp-server/src/mcp.ts` line ~1804 (`docs_feedback` tool); `server.ts` line 321 and 1872 (`POST /docs/feedback`); `corpus/reflect-service.ts` `docsFeedbackReply` (unknown document answers 404, one verdict per `surface/session` and document, upsert); audit and admission registered per the prior record. Tests: `packages/mcp-server/src/corpus/reflect-routes.test.ts` passed. |
| 3 | `scoreDocument` is a pure, tested function of tier, kind, recency, supersession and feedback; `SUBSTRATE_DOCS_RERANK=shadow` records what the re-rank would change, `on` applies it, `off` is default. | ✓ VERIFIED | `packages/corpus/src/authority.ts` (`scoreDocument`, pure); `packages/mcp-server/src/corpus/rank.ts` (`reflectCitations` off/shadow/on); `flag-registry.ts` line 892 (`SUBSTRATE_DOCS_RERANK`, default off). Tests passed: `packages/corpus/src/authority.test.ts`, `packages/mcp-server/src/corpus/rank.test.ts`, `packages/mcp-server/src/docs-search.reflect.test.ts`, `authority-index.test.ts`. |
| 4 | Supersession detected for a newer version of the same path, a live document and its milestone archive, and an explicit `superseded-by` marker; citations carry `stale` and `superseded_by`. | ✓ VERIFIED | `packages/corpus/src/supersession.ts` (`detectSupersession`, marker reading); `rank.ts` annotates `stale` and `superseded_by` on corpus citations. Tests passed: `packages/corpus/src/supersession.test.ts`, `docs-search.reflect.test.ts`. |
| 5 | `substrate corpus reflect` writes one digest per repository (current milestone and phase, decisions, open items, deterministic from STATE and ROADMAP) into the docs plane and retains it in Hindsight with `document_id` replace; `corpus status --gaps` lists unanswered queries. | ? HUMAN_NEEDED (live run) / ✓ code and tests | `packages/corpus/src/reflect.ts` (`buildDigest`); `packages/cli/src/corpus/reflect.ts` (`collectDigests`); `reflect-service.ts` `corpusReflectReply` and `corpusGapsReply`; `digest-retain.ts` (governed `corpus-digest:` retain); `reflect-store.ts` `gaps`. Tests passed: `packages/corpus/src/reflect.test.ts`, `packages/mcp-server/src/corpus/digest-retain.test.ts`, `reflect-service.test.ts`, `packages/cli/src/corpus/reflect.test.ts`, and `packages/cli/src/corpus/index.test.ts -t gaps` (5 pass). A live digest write to LightRAG and Hindsight is operator-gated and was not run. |

**Score:** 4/5 criteria verified in code and tests; criterion 5 needs the operator's live run for its docs-plane and Hindsight half.

### Targeted test run (this session)

`bun test` on authority, supersession, reflect (corpus), rank, telemetry, authority-index, reflect-service, reflect-routes, digest-retain, docs-search.reflect and the CLI reflect test: **218 pass, 0 fail**, 52,358 expect() calls. The stderr lines (`cache bypass`, `connection lost`, `ENOTDIR`) are the expected negative-path logs of fail-open tests, not failures. `corpus status --gaps` CLI tests: **5 pass, 0 fail**.

### Not run

- `packages/mcp-server/src/corpus/reflect-store.test.ts` (live Postgres; skipped without `SUBSTRATE_TEST_PG_URL`).
- Live LightRAG, Hindsight and the Postgres index. The verifier did not run the live stack.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/corpus/src/authority.ts` | pure `scoreDocument` | ✓ VERIFIED | present, tested |
| `packages/corpus/src/supersession.ts` | `detectSupersession` | ✓ VERIFIED | present, tested |
| `packages/corpus/src/reflect.ts` | `buildDigest` | ✓ VERIFIED | present, tested |
| `packages/mcp-server/src/corpus/telemetry.ts` | retrieval row builder and recorder | ✓ VERIFIED | present, tested |
| `packages/mcp-server/src/corpus/reflect-service.ts` | feedback, reflect, gaps replies | ✓ VERIFIED | present, tested |
| `packages/mcp-server/src/corpus/reflect-store.ts` | Postgres store | ✓ VERIFIED (fake-tested) | live test conditional |
| `packages/mcp-server/src/corpus/rank.ts` | off/shadow/on re-rank | ✓ VERIFIED | present, tested |
| `packages/mcp-server/src/corpus/authority-index.ts` | per-process snapshot and feedback cache | ✓ VERIFIED | present, tested |
| `packages/mcp-server/src/corpus/digest-retain.ts` | governed digest retain | ✓ VERIFIED | present, tested |
| `packages/cli/src/corpus/reflect.ts` | `substrate corpus reflect` | ✓ VERIFIED | present, tested |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `docs-search.ts` / `service.ts` | `telemetry.ts` `RetrievalRecorder` | `recordRetrieval` after the answer is built, flag-gated | ✓ WIRED | per the code, tested via `docs-search.reflect.test.ts` |
| `mcp.ts` `docs_feedback` and `server.ts` `/docs/feedback` | `reflect-service.ts` `docsFeedbackReply` | handler call | ✓ WIRED | route and tool both present |
| `authority-index.ts` | `reflect-store.ts` `feedbackCounts` | feedback term, 60 s cache | ✓ WIRED | `docsFeedback` invalidates the cache |
| `rank.ts` | `authority.ts` `scoreDocument` | `reflectCitations` | ✓ WIRED | tested |
| `reflect.ts` (CLI) | `reflect-service.ts` `corpusReflectReply` | `POST /corpus/reflect` | ✓ WIRED | route present in `server.ts` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| Retrieval rows | query hash, returned keys, scores | `docs_search` answer | yes, from the live answer path (fake-tested) | ✓ FLOWING (code) |
| Feedback term | helpful and negative counts | `corpus_feedback` table | yes, via `reflect-store.ts` | ✓ FLOWING (code) |
| Digest | repo STATE and ROADMAP | `buildDigest` deterministic read | yes, tested | ✓ FLOWING (code) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Reflect core, authority, supersession, rank, telemetry, routes, digest, docs-search reflect, CLI reflect | `bun test` on 12 targeted files | 218 pass, 0 fail | ✓ PASS |
| `corpus status --gaps` CLI | `bun test packages/cli/src/corpus/index.test.ts -t gaps` | 5 pass, 0 fail | ✓ PASS |
| Live reflect run, live gaps, live Postgres store test | not run | — | ? SKIP (live stack; operator-gated) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` declared for this phase. Skipped.

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| REFLECT-01 | Retrieval telemetry | ✓ SATISFIED (code and fake tests) | criterion 1 |
| REFLECT-02 | `docs_feedback` | ✓ SATISFIED (code and tests) | criterion 2 |
| REFLECT-03 | authority score and re-rank | ✓ SATISFIED (code and tests) | criterion 3 and 4 |
| REFLECT-04 | supersession | ✓ SATISFIED (code and tests) | criterion 4 |
| REFLECT-05 | digest and gaps | ? NEEDS HUMAN for the live run | criterion 5 |

Planning note: `.planning/REQUIREMENTS.md` may still list REFLECT-01..05 unchecked. This record does not edit it.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `docs/corpus-reflect.md` | 141 | says a query that returned nothing "counts as best 0"; the code reports `best: null` (`reflect-routes.test.ts`) | ℹ️ Info | documentation wording only; the SQL counts such a query as a gap either way |

### Known residual risks (not gaps)

- Verdict stacking: feedback is per surface and session, so repeated verdicts from many sessions add weight. Recorded in the prior record; no criterion forbids it.
- Feedback bound: `FEEDBACK_MAX_KEYS` (5000) keeps only the most recently voted documents in the re-rank.
- Column name collision: `corpus_documents.superseded_by` (a repo-relative path) and the citation field `superseded_by` (a document key) share a name with different shapes.
- Nothing in the repository calls `docs_feedback` or schedules `substrate corpus reflect`. The loop closes only when an operator or agent calls them. This is an operator-gated item, not a criterion failure.

### Human Verification Required

1. **Live reflect run.** With `SUBSTRATE_CORPUS`, LightRAG and Hindsight configured, run `substrate corpus reflect --execute`. Expect one digest per repository in the docs plane and a Hindsight retain with `document_id` replace, with no duplicate on a second run.
2. **Live gaps.** After real `docs_search` traffic with telemetry on, run `substrate corpus status --gaps`. Expect rows for unanswered queries with hashes, counts, best score and redacted text.
3. **Live Postgres telemetry.** Run `reflect-store.test.ts` with `SUBSTRATE_TEST_PG_URL` set, or enable telemetry against a Postgres at migration step 38. Expect one bounded row per search and expired rows swept.

### Gaps Summary

No gaps. Criteria 1 to 4 are met in code and by 218 passing targeted tests. Criterion 5 is met in code and tests; its live docs-plane, Hindsight and gap-score evidence needs an operator-approved run, so the status is `human_needed`.

---
# Phase 66 Verification

_Verified: 2026-11-18T12:22:47Z_
_Verifier: Claude (gsd-verifier)_
At 80afb6e5, `.planning/REQUIREMENTS.md` still lists REFLECT-01 to REFLECT-05 unchecked (lines 41 to 45), and the traceability table lists them as "Planned" (line 97). This record does not change either.

## Closure, 2026-11-11 (branch `reconcile/main-2026-11-11`)

Scope: the repo-buildable residual risks and gaps above. Code commit `5f705aab` (phase 66: close the repo-buildable docs reflect gaps); this closure record is its own commit. The 2026-10-30 record above is unchanged. The phase is still PARTIAL: criterion 5 and the live loop need an operator run, listed under Operator-gated below.

Evidence was run here: `bun test` on `corpus/reflect-store`, `corpus/reflect-service`, `corpus/authority-index`, `corpus/reflect-routes`, `corpus/telemetry`, `docs-search.reflect`, and `bunx tsc --noEmit` (exit 0). `corpus/reflect-store.test.ts` ran against a scratch `postgres:16` container (`SUBSTRATE_TEST_PG_URL`, a throwaway container, removed afterwards): 10 of 10 pass, including the three tests this closure adds. No flag, LightRAG, Hindsight or production store was touched.

### Residual risks

| # | Residual risk (above) | Status | Closure and evidence |
|---|---|---|---|
| 1 | Verdict stacking: one surface posts under many session ids | CLOSED | `feedbackCounts` (Postgres: `distinct on (document_key, surface)`, latest verdict; fake: same) counts one vote per surface per document. Tests: `authority-index.test.ts` "one surface cannot mark a document stale by posting under many session ids"; `reflect-store.test.ts` "one surface posting under many sessions counts once"; `docs-search.reflect.test.ts` "one surface posting the same verdict under many sessions does not reach the answer". The three-session seeds became three-surface seeds. Residual by design: three distinct surfaces still count as three readers; the surface is the authenticated caller's (`server.ts` `docs_feedback` route). |
| 2 | Plane score dependence: LightRAG may return no score, so `top_score` is 0 for every answer | OPERATOR-GATED | Needs one captured live `/query` response to see which score field, if any, LightRAG returns. The fallback (what a score-less answer means for the gap report) is a decision that depends on that capture. Not changed here. |
| 3 | Shadow report unreadable | CLOSED | `GET /corpus/gaps` now carries `shadow` (`days`, `searches`, `movedSearches`, `moved`, `largest` of at most 20 with `queryHash`, `text`, `at`, `moved`, `order`), read by `ReflectStore.shadowReport` (`reflect-store.ts`). Tests: `reflect-service.test.ts` "the reply carries the shadow report over the window" and "with no shadow note the report is all zeros"; `reflect-store.test.ts` (live) "the shadow report counts the searches that carry a shadow note and lists the largest moves, never degraded ones". `docs/corpus-reflect.md` "Reading a shadow report" now names this read path. Not done: the CLI `corpus status --gaps` does not render it (packages/cli, outside this closure's paths). |
| 4 | Failed digest retain is not retried | CLOSED | `corpusReflectReply` retains every digest the manifest holds (`ingested`, `updated` or `unchanged`) on each run. A repeat of the same content computes the same memory session (`digestSessionOf`: a function of the sha256), so the governed write replays and adds no second entry; Hindsight replaces by document id. A `stored` or `unchanged` digest reports `hindsight:<reason>` for as long as its leg is owed. Tests: `reflect-service.test.ts` "a repeat of the same digest is unchanged ... retained again under the same memory session", "a Hindsight leg that failed is owed", "digests retain under a session of their content"; `reflect-routes.test.ts` "the same digest again ... its retain is owed again". Caveat: `packages/cli` `corpus reflect` prints warnings only for `stored` results with a reason, so an owed leg on `unchanged` is counted but not printed. A one-line CLI follow-up, outside this closure's paths. |
| 5 | Per-process state (authority snapshot 30 s, feedback counts 60 s) | NOT CLOSED (design) | The cross-process propagation bound is the design: a verdict reaches another server within 60 s, a manifest change within 30 s (`authority-index.ts` constants). Closing it needs a shared cache or per-search reads, a design change beyond this closure. |
| 6 | Feedback bound: the 5000 most recently voted documents | CLOSED | `FEEDBACK_MAX_KEYS` is now 100,000, the manifest's own read cap, and the counts read only documents with an active manifest row (join on `corpus_documents`). A tombstoned or unknown document's votes no longer take a slot. Tests: `reflect-store.test.ts` (live) "a document with no active manifest row is not counted"; "the counts are bounded to the most recently voted documents". |
| 7 | Live Postgres tests conditional on `SUBSTRATE_TEST_PG_URL` | CLOSED for the SQL; CI gating unchanged | The gaps SQL, the feedback upsert, the active-row join, the per-surface counts and the shadow aggregate ran against `postgres:16` here: 10 of 10. CI runs the file only when its scratch-Postgres job exports `SUBSTRATE_TEST_PG_URL` (`.github/workflows/ci.yml`); that wiring was not changed. |
| 8 | No end-to-end test of the loop | CLOSED | `docs-search.reflect.test.ts` "a verdict stored through docs_feedback reaches the next answer: a document three surfaces called stale falls below the one they did not" runs `Substrate.docsFeedback` then `Substrate.searchDocs` with the re-rank on and checks the order and the `stale` flag. |
| 9 | Hindsight scope: Reflect and mental models not used | NOT A GAP | Decision D66-2, accepted. No change. |
| 10 | Column name collision: `corpus_documents.superseded_by` (marker path) and citation `superseded_by` (document key) | NOT CLOSED (outside paths) | Closing it means renaming the column in a new migration step in `packages/mcp-server/src/index-store.ts` (outside this closure's paths) and updating `corpus/store.ts`. Step 38 may already have run where it was deployed, so a rename must be a new step, not an edit. Needs Main's assignment and an operator rehearsal. |

### Criteria

| # | Before | After this closure |
|---|---|---|
| 1 | MET | MET (unchanged) |
| 2 | MET | MET; verdict stacking closed (risk 1) |
| 3 | MET | MET; shadow report readable (risk 3); score fallback still gated (risk 2) |
| 4 | MET | MET (unchanged) |
| 5 | PARTIAL | PARTIAL. Digest retry and the shadow read are closed in repository code. No live LightRAG, Hindsight or reflect run exists; gap scores remain unverified against a live plane (risk 2). |

### Operator-gated (unchanged from above, plus one)

- Setting `SUBSTRATE_DOCS_TELEMETRY`, `SUBSTRATE_DOCS_RERANK` (`shadow`, then `on`), `SUBSTRATE_DOCS_GAP_SCORE`, or the retention. No default changed.
- Enabling `SUBSTRATE_CORPUS` and the LightRAG backend.
- Running `substrate corpus reflect --execute` against a live LightRAG and Hindsight. No schedule exists.
- Wiring an agent, hook or skill to call `docs_feedback`. None exists in the repository.
- Rehearsing migration step 38 on a restored dump (`docs/runbooks/rollback-compat.md`).
- The phase 63 live ingest, which the re-rank depends on.
- Capturing one live LightRAG `/query` response to settle risk 2 (which score field, if any).
- Confirming that the CI scratch-Postgres job runs `corpus/reflect-store.test.ts` (risk 7).

## Closure of residual 10, the column name collision (2026-11-11, branch `reconcile/main-2026-11-11`)

Residual 10 is CLOSED in repository code. Its schema cleanup is a later, operator-gated step. Migration step 46 `corpus_documents_superseded_by_path` (additive, expand, always run) adds `corpus_documents.superseded_by_path`. The marker path is written and read only through that column (`corpus/store.ts`: `toManifestRow`, `refreshMetadata`, `recordIngested`). The citation field `superseded_by`, which holds a document key, no longer shares a name with any column the code uses.

Why this is an expand and not a rename: `ALTER TABLE … RENAME` is not additive, and `rollback-compat.test.ts` requires every step above 32 to be additive. That test is not loosened. So the step adds the new column, and the step-38 column `superseded_by` stays, unread and unwritten, until a later contract step drops it. No backfill is needed: the manifest is rebuilt by the corpus scan, and `plan.ts` treats a row whose stored marker differs from its document's marker as changed, so each row is rewritten on the next ingest.

Evidence: `corpus/store.test.ts` "reads the superseded-by marker…" reads `superseded_by_path`. `corpus/reflect-store.test.ts` and `corpus/reflect-service.test.ts` pass against a disposable `postgres:16` in the narrow set (487 pass, 0 fail, with `SUBSTRATE_TEST_PG_URL` set). `rollback-compat.test.ts` and `index-store.migrate-contract.test.ts` pass with step 46 named in the runbook.

Residuals: the step-38 column stays until its contract step, and the healing ingest runs only while `SUBSTRATE_CORPUS` is on, which production does not set.

Operator gate, not run: rehearse migration step 46 on a restored production dump before production migrates (`docs/runbooks/rollback-compat.md`, the row for step 46). The phase 63 live ingest is still not run, as before.
