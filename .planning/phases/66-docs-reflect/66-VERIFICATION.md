---
phase: 66-docs-reflect
verified: 2026-11-05T07:58:55Z
status: human_needed
score: 5/5 must-haves verified
covered_files: [".planning/phases/66-docs-reflect/66-SUMMARY.md", "packages/audit/src/policy.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/reflect.ts", "packages/corpus/src/authority.test.ts", "packages/corpus/src/authority.ts", "packages/corpus/src/reflect.ts", "packages/corpus/src/supersession.test.ts", "packages/corpus/src/supersession.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/authority-index.test.ts", "packages/mcp-server/src/corpus/authority-index.ts", "packages/mcp-server/src/corpus/digest-retain.ts", "packages/mcp-server/src/corpus/rank.test.ts", "packages/mcp-server/src/corpus/rank.ts", "packages/mcp-server/src/corpus/reflect-routes.test.ts", "packages/mcp-server/src/corpus/reflect-service.test.ts", "packages/mcp-server/src/corpus/reflect-service.ts", "packages/mcp-server/src/corpus/reflect-store.test.ts", "packages/mcp-server/src/corpus/reflect-store.ts", "packages/mcp-server/src/corpus/telemetry.test.ts", "packages/mcp-server/src/corpus/telemetry.ts", "packages/mcp-server/src/docs-search.reflect.test.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/planes/hindsight.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:525150198c0098ea793496fced527b557e978a90fc78b8d7356232a5a65bc708"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/5
  gaps_closed: []
  gaps_remaining: []
  regressions: []
gaps: []
deferred: []
human_verification:
  - test: "Run a live LightRAG docs_search with SUBSTRATE_DOCS_TELEMETRY=on and read corpus_retrievals.top_score for the new row"
    expected: "A non-null score for an answered search (the fixture has no score field)"
    why_human: "Needs a live docs plane; the code and tests run on fakes"
  - test: "Run substrate corpus reflect --execute against live LightRAG and Hindsight 0.9.1, then run it again"
    expected: "One digest stored; the second run answers unchanged; the Hindsight entry is replaced, not duplicated"
    why_human: "External services"
  - test: "Run substrate corpus status --gaps after a few searches, some with no answer"
    expected: "The unanswered queries are listed, most searched first"
    why_human: "Needs a populated index"
  - test: "With SUBSTRATE_DOCS_TELEMETRY=on, run a steering-session docs_search against the live index and read the new corpus_retrievals row"
    expected: "One row; query_text null; query_hash equal to the sha256 of the normalised question"
    why_human: "Needs a live steering session and the live index; the code and the tests prove it on fakes and scratch Postgres"
---

# Phase 66: Docs Reflect Verification Report

**Phase Goal:** The docs RAG improves with use, the way Hindsight does: it remembers what was retrieved, learns what helped, prefers the current document to the one it replaced, writes digests of what it knows and reports what it could not answer.
**Verified:** 2026-11-05T07:58:55Z
**Status:** human_needed
**Re-verification:** Yes. The prior record (66-VERIFICATION.md, HEAD 42e3cf13, human_needed, 5/5, empty `gaps:`) puts this run in re-verification mode. No gap was open.

## Scope and method

- Head: `6e5d766e` (integration branch `gsd/v18-int-all`, worktree `/root/src/worktrees/as-gsd-v18-all`). The prior record was at `42e3cf13`, an ancestor of HEAD. The phase's two named commits are ancestors of HEAD: `8ec01492` (fix(66): every docs_search is recorded, including an empty question) and `75d2ce56` (fix(66): a steering-session docs_search keeps its retrieval row, query text dropped, hash kept, SC1).
- No PLAN.md exists for this phase. Must-haves are the ROADMAP phase 66 success criteria 1 to 5 (Step 2a). REQUIREMENTS.md REFLECT-01 to REFLECT-05 map to them. ROADMAP and REQUIREMENTS changes since `42e3cf13` amend only ATLAS, PROOF and EVAL rows; no phase 66 row changed.
- Changes since `42e3cf13` (`bd5c287a`, `49b9aece`, `b4bdd0fc`, `d1a5e89b`, `b4fe6bfe`, `6e5d766e`), checked against the phase's claims:
  - `packages/mcp-server/src/service.ts` (`b4bdd0fc`, one hunk at line 3002, +2/-1): the sync-lag reading after a `docs.sync` note (`emit`). It sits above the phase 66 code and on a different path from `searchDocs`. Every phase 66 line number moved down by one (`searchDocsUnmeasured` 6352, the `recordRetrieval` call 6442, `recordRetrieval` 6468, `isPrivate` in the `retrievalRowOf` call 6471). The phase 66 claims were re-read at HEAD and hold.
  - Other covered files: unchanged since `42e3cf13`. `corpus/telemetry.ts` (82 and 92), `flag-registry.ts`, `config.ts`, `reflect-store.ts`, `reflect-service.ts`, `server.ts` and `mcp.ts` are the same content.
  - Not covered by the fingerprint: `cache.ts`, `event-buffer.ts`, `dispatcher/worktree.py`, `docs/corpus.md`, `docs/reconcile.md`, the other phase records. None is a phase 66 path.
- Fingerprint: `gsd_run query verification.fingerprint .planning/phases/66-docs-reflect` with the 29 implementation files (the SUMMARY is added automatically). Exit 0. `covered_files` and `covered_digest` are copied verbatim from its output. The covered list is the same 30 entries as the prior record. The digest changed from `f29ead8a...` to `254e41ae...` because `service.ts` changed at HEAD.
- Debt-marker scan (TBD, FIXME, XXX, TODO, HACK, PLACEHOLDER) of the 29 implementation files: no match.
- Gate evidence (not rerun): gate r33 at `6e5d766e`, JUnit `/root/src/worktrees/backups/gate-r33-junit.xml` (12290 testcases). Every test title in the nine phase 66 test files (177 titles) matches a passing JUnit testcase with no `<skipped/>` and no failure child. That covers the non-Postgres suites and the Postgres-gated `reflect-store.test.ts` (7 named passes: "a retrieval row round-trips with its returned keys, scores, shadow note and degraded flag", "a null query text and a null shadow note are stored as null", "the sweep deletes only rows older than the retention, oldest first, and never more than the batch", "the gap aggregate lists a query whose best score was none or low, leaves out answered, degraded and old searches, and orders by searches", "feedback is one verdict per document and session, the latest wins, and the counts are grouped per document", "the counts are bounded to the most recently voted documents", "a verdict outside the closed list is refused by the table").
- Targeted run at HEAD (one non-Postgres command, `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 src/docs-search.reflect.test.ts src/corpus/telemetry.test.ts` in `packages/mcp-server`): 43 pass, 0 fail, 120 expect() calls, 2 files.
- No Postgres or docker was started. No code was edited. No commits were made. No full suite, tsc, lint or formatter was run.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | With `SUBSTRATE_DOCS_TELEMETRY=on` every `docs_search` appends a bounded, redacted row (query hash, capped redacted text, up to ten keys with scores, backend, surface) to `corpus_retrievals`, with retention | ✓ VERIFIED | Every `docs_search` reaches `searchDocs` (MCP `mcp.ts` 1596, REST `server.ts` 1647; the only other caller is the eval harness). `service.ts` `searchDocsUnmeasured` (6352) calls `recordRetrieval` unconditionally at 6442 with `isPrivate = prepared !== undefined`. The empty-question guard is gone (`8ec01492`): `recordRetrieval` (6468) checks only the telemetry flag, and a blank question writes one row with `queryText` null and the hash of the empty string. `prepared` is set only on the `steering_session_id` path (6316-6320), so a steering-session row keeps the hash and drops the text (`75d2ce56`). `corpus/telemetry.ts` declares `isPrivate` (82) and sets `queryText: input.isPrivate ? null : queryTextOf(input.question)` (92); `queryHash` is always set. Retention: `sweepExpiredRetrievals` at `service.ts` 6584. Named passes: "one search appends exactly one row…", "a question holding a credential keeps no text at all…", "a long question is cut to the text limit", "an empty question writes one row with no text and the hash of the empty string", "a steering-session search writes exactly one row: no query text, only the hash of the question", "with the flag off nothing is written, counted or swept", "retention drains every expired batch in one pass…". |
| 2 | `docs_feedback` (MCP tool and REST route) records helpful, unhelpful, stale, wrong or duplicate per document key, audited, admission-limited, idempotent per session and document | ✓ VERIFIED | Regression check. MCP tool `mcp.ts` 1748; REST `server.ts` 1816 `auditedRest(... "docs_feedback")`; `admission.ts` 254 `docs_feedback: "write"`; `audit/src/policy.ts` 134 fail-open list; `reflect-service.ts` `docsFeedbackReply` (unknown document gives 404); `reflect-store.ts` `upsertFeedback` (126). Named passes: "the audit record is written under docs_feedback with the document and the verdict, never the note" (POST /docs/feedback), "feedback is one verdict per document and session, the latest wins…" (PG, 7 pass). |
| 3 | `scoreDocument` is pure and tested. `SUBSTRATE_DOCS_RERANK=shadow` records the would-be change, `on` applies it, `off` is the default | ✓ VERIFIED | Regression check. `corpus/src/authority.ts` 114 `scoreDocument` is pure; `config.ts` 1604-1608 reads `shadow` or `on`, otherwise `off`; `rank.ts` `reflectCitations` implements the three modes. `service.ts` `reflectAnswer` (6452) returns untouched for `off`. Named passes: "off, and a flag left unset, answer byte for byte…", "shadow answers byte for byte what off answers, and records on the telemetry row what on would have changed", "on re-orders the corpus citations by score times (0.5 + 0.5 * authority)…", "on re-orders by score times authority…" (reflectCitations). |
| 4 | A document that a newer version, an archive or an explicit marker supersedes is flagged; citations carry `stale` and `superseded_by` | ✓ VERIFIED | Regression check. `corpus/src/supersession.ts` 150 `detectSupersession`: three rules (marker, live plus milestone archive, two `local/*` copies with different sha256); cycles flag nothing. `rank.ts` sets `stale` and `superseded_by` on corpus citations in `on` mode only. Named pass: "on drops a superseded document below the document that replaced it, and its citation carries stale and superseded_by". All 26 `supersession.test.ts` titles pass. Scope: corpus (LightRAG) citations only; RAGFlow answers are not annotated. |
| 5 | `substrate corpus reflect` writes one digest per repository into the docs plane and retains it in Hindsight with `document_id` replace; `corpus status --gaps` lists the queries that returned nothing useful | ✓ VERIFIED (against fakes; live plane not observed) | Regression check. `corpus/src/reflect.ts` 151 `buildDigest` is deterministic and returns null without STATE or ROADMAP; `cli/src/corpus/reflect.ts` is a dry run unless `--execute`; `POST /corpus/reflect` (`server.ts` 1821) reaches `corpusReflectReply`, which calls `ingestCorpus` and then `retainDigest`; `digest-retain.ts` uses the `corpus-digest:` subject prefix; `planes/hindsight.ts` 557 sends `update_mode: "replace"`. Gaps aggregate by query hash in `reflect-store.ts` (PG named pass "the gap aggregate lists a query whose best score was none or low…"). All 33 `reflect-service.test.ts` and 23 `reflect-routes.test.ts` titles pass. |

**Score:** 5/5 truths verified. Truth 5 is verified against fakes; its live behaviour is a human item. `behavior_unverified: 0`.

### Requirements Coverage (REQUIREMENTS.md)

| Requirement | Source | Description | Status | Evidence |
| ----------- | ------ | ----------- | ------ | -------- |
| REFLECT-01 | SUMMARY frontmatter | Every `docs_search` is recorded as a bounded, redacted retrieval event | ✓ SATISFIED | Truth 1, including steering-session searches (hash kept, text dropped) and blank questions (one row, hash of the empty string) |
| REFLECT-02 | SUMMARY frontmatter | `docs_feedback` records a verdict per document key, audited, admission-limited, idempotent | ✓ SATISFIED | Truth 2 |
| REFLECT-03 | SUMMARY frontmatter | Authority score and shadow-first re-rank | ✓ SATISFIED | Truth 3 |
| REFLECT-04 | SUMMARY frontmatter | Supersession flagged in citations | ✓ SATISFIED | Truth 4 |
| REFLECT-05 | SUMMARY frontmatter | Digests into docs plane and Hindsight, gaps listed | ✓ SATISFIED against fakes; live run not observed | Truth 5 |

Orphaned requirements: none. All five IDs appear in the SUMMARY frontmatter `requirements` field; no PLAN.md exists to declare them.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/corpus/telemetry.ts` | Row builder, recorder, sweep | ✓ VERIFIED | Substantive; `isPrivate` at 82, used at 92; wired from `service.ts` (recordRetrieval 6468, sweep 6584) |
| `packages/mcp-server/src/corpus/reflect-store.ts` | Bun SQL adapter for tables from step 38 | ✓ VERIFIED | `upsertFeedback` (126) and the other operations present; 7 PG named passes in gate r33 |
| `packages/mcp-server/src/index-store.ts` | Migration step 38 `corpus_reflect` | ✓ VERIFIED | `corpus_retrievals` and indexes at 802-821; runs at every boot, no flag |
| `packages/corpus/src/authority.ts` | Pure `scoreDocument` | ✓ VERIFIED | Pure (114); 16 titles pass |
| `packages/corpus/src/supersession.ts` | `detectSupersession` | ✓ VERIFIED | Pure (150); 26 titles pass |
| `packages/corpus/src/reflect.ts` | `buildDigest` | ✓ VERIFIED | Deterministic (151); wired through CLI and `corpusReflectReply` |
| `packages/mcp-server/src/corpus/reflect-service.ts` | Feedback, reflect and gaps replies | ✓ VERIFIED | Wired from `server.ts` and `mcp.ts`; 33 titles pass |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` `searchDocsUnmeasured` | `recordRetrieval` | unconditional call at 6442, `isPrivate = prepared !== undefined` | ✓ WIRED | Steering-session `docs_search` writes one row with text null; a blank question writes one row |
| `service.ts` `recordRetrieval` | `RetrievalRecorder.record` → `appendRetrieval` | `retrievalRecorder` (1938) | ✓ WIRED | Fail-open, budgeted |
| `mcp.ts` `docs_feedback` | `docsFeedback` → `docsFeedbackReply` → `upsertFeedback` | `substrate.docsFeedback` | ✓ WIRED | Invalidates authority feedback cache |
| `server.ts` `/corpus/reflect` | `corpusReflectReply` → `retainDigest` | `substrate.corpusReflect` | ✓ WIRED | Retain through governed write |
| `rank.ts` `reflectCitations` | `service.ts` `reflectAnswer` | `authorityIndex.lookup` | ✓ WIRED | Runs after the docs cache |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `corpus_retrievals` row | `queryHash`, `queryText`, `topScore`, `returned` | `queryHash` from the normalised question; `queryText` null for steering-session calls; scores from the SearchReply chunks | Yes, when the plane answers. Live LightRAG score field not observed; fixture has no score field | ✓ FLOWING (fake-tested) |
| `corpus_feedback` counts | `feedbackCounts` | Real SQL group-by | Yes; PG named passes (7) | ✓ FLOWING |
| Digest text | `buildDigest` | STATE and ROADMAP text from the CLI scan | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| SC1: telemetry rows (search, blank question, steering session, credential, long text, flag off) | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 src/docs-search.reflect.test.ts src/corpus/telemetry.test.ts` in `packages/mcp-server` | 43 pass, 0 fail, 120 expect() calls, 2 files, 285 ms | ✓ PASS |
| Phase 66 test titles (9 files, 177 titles) | JUnit match against gate r33 (no run) | 177 titles matched; 0 skipped, 0 failed | ✓ PASS |
| Reflect tables against a live index (`reflect-store.test.ts`, PG-gated) | JUnit match against gate r33 (no Postgres started) | 7 named passes, no `<skipped/>` | ✓ PASS |
| Fingerprint command | `gsd_run query verification.fingerprint .planning/phases/66-docs-reflect <29 files>` | exit 0; digest `v3:sha256:254e41ae4855056b09a961a793586c0c1e93586f5f5a201b8a357fb17ae03a54` | ✓ PASS |

The `[substrate] docs telemetry: ... connection lost` and `cache bypass` lines in the targeted run come from tests that inject failing stores. They are expected fail-open output, not failures.

### Probe Execution

No probe is declared in the phase's PLAN, SUMMARY or success criteria. Phase 66 is not a probe-based or migration-verification phase by declaration. Skipped.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/service.ts` | 6425-6431 | Empty question skips the cache (served by `load()` directly) | ℹ️ Info | Intended; the row is written in all cases by 6442 |
| `packages/mcp-server/src/service.ts` | 6468-6475 | `recordRetrieval` swallows failures to stderr | ℹ️ Info | Intended fail-open; the recorder counts drops and failures |

No TBD, FIXME, XXX, TODO, HACK or PLACEHOLDER marker in the 29 implementation files.

### Human Verification Required

These cannot be checked from the repository. They do not change the status of truths 1 to 4; they keep the phase at `human_needed`.

1. **Live retrieval score field**
   - **Test:** Run a live LightRAG `docs_search` with `SUBSTRATE_DOCS_TELEMETRY=on` and read the `corpus_retrievals.top_score` value.
   - **Expected:** A non-null score for an answered search. The fixture has no score field.
   - **Why human:** It needs a live plane.

2. **Live digest and Hindsight retain**
   - **Test:** Run `substrate corpus reflect --execute` against a live LightRAG and Hindsight 0.9.1, then run it again.
   - **Expected:** One digest stored; a second run answers `unchanged`; the Hindsight entry is replaced, not duplicated.
   - **Why human:** External services.

3. **Gaps list**
   - **Test:** Run `substrate corpus status --gaps` after a few searches, some with no answer.
   - **Expected:** The unanswered queries are listed, most searched first.
   - **Why human:** It needs a populated index.

4. **Steering-session row in a live index**
   - **Test:** With `SUBSTRATE_DOCS_TELEMETRY=on`, run a steering-session `docs_search` against the live index and read the new `corpus_retrievals` row.
   - **Expected:** One row; `query_text` null; `query_hash` equal to the sha256 of the normalised question.
   - **Why human:** It needs a live steering session and the live index. The code and the tests prove it on fakes and scratch Postgres.

5. **Operator decisions carried from the SUMMARY** (not blocking this status)
   - Step 38 has no opt-in and must be rehearsed on a restored dump.
   - `docs_feedback` has no caller in the repository.
   - No schedule exists for reflect.

## Gaps Summary

None. Truth 1 (REFLECT-01, SC1) holds at HEAD `6e5d766e`: a `docs_search` is recorded in every path, including a blank question (`8ec01492`), and a steering-session search keeps its row with the query text dropped and the hash kept (`75d2ce56`, owner decision of 2026-11-04). The code (`service.ts` 6442 and 6471, `telemetry.ts` 82 and 92) and the named tests show it. Truths 2 to 5 pass the regression run at this head through the gate r33 JUnit names (177 titles across nine files, no skips) and the targeted run (43 pass).

Residual risks from the SUMMARY still apply and are not changed by this verification: verdict stacking across session ids; per-process authority and feedback caches; a failed Hindsight digest leg is not retried by a later unchanged run; the shadow report has no read path; the 5000-key feedback bound. The hash of a steering-session question is kept per the owner decision; a short private question can be guessed by hashing, which the owner accepted.

---

_Verified: 2026-11-05T07:58:55Z_
_Verifier: Claude (gsd-verifier)_
