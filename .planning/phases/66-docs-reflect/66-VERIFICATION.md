---
phase: 66-docs-reflect
verified: 2026-11-05T00:13:13Z
status: human_needed
score: 5/5 must-haves verified
covered_files: [".planning/phases/66-docs-reflect/66-SUMMARY.md", "packages/audit/src/policy.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/reflect.ts", "packages/corpus/src/authority.test.ts", "packages/corpus/src/authority.ts", "packages/corpus/src/reflect.ts", "packages/corpus/src/supersession.test.ts", "packages/corpus/src/supersession.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/authority-index.test.ts", "packages/mcp-server/src/corpus/authority-index.ts", "packages/mcp-server/src/corpus/digest-retain.ts", "packages/mcp-server/src/corpus/rank.test.ts", "packages/mcp-server/src/corpus/rank.ts", "packages/mcp-server/src/corpus/reflect-routes.test.ts", "packages/mcp-server/src/corpus/reflect-service.test.ts", "packages/mcp-server/src/corpus/reflect-service.ts", "packages/mcp-server/src/corpus/reflect-store.test.ts", "packages/mcp-server/src/corpus/reflect-store.ts", "packages/mcp-server/src/corpus/telemetry.test.ts", "packages/mcp-server/src/corpus/telemetry.ts", "packages/mcp-server/src/docs-search.reflect.test.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/planes/hindsight.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:42812094d1a327fed97561ffa8563ac6104bdf41f79bd57bca84b07d9b677b13"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/5
  gaps_closed:
    - "Truth 1 (REFLECT-01, ROADMAP SC1): a steering-session docs_search wrote no corpus_retrievals row (service.ts prepared guard). Closed by 75d2ce56 (owner decision 2026-11-04): the row is kept with queryText null and the hash of the question."
  gaps_remaining: []
  regressions: []
gaps: []
deferred: []
---

# Phase 66: Docs Reflect Verification Report

**Phase Goal:** The docs RAG improves with use: it remembers what was retrieved, learns what helped, prefers the current document to the one it replaced, writes digests of what it knows and reports what it could not answer.
**Verified:** 2026-11-05T00:13:13Z
**Status:** human_needed
**Re-verification:** Yes. The prior record (66-VERIFICATION.md, HEAD 9e71f263, gaps_found, 4/5) carries a `gaps:` section, so this run is in re-verification mode. The gap is closed by 75d2ce56, an ancestor of HEAD c40ffc9a.

## Scope and method

- Head: `c40ffc9a` (integration branch `gsd/v18-int-all`, worktree `/root/src/worktrees/as-gsd-v18-all`). `75d2ce56` is an ancestor of HEAD.
- No PLAN.md exists for this phase. Must-haves are the ROADMAP phase 66 success criteria 1 to 5 (Step 2a). REQUIREMENTS.md REFLECT-01 to REFLECT-05 map to them.
- Failed item from the prior record (truth 1) re-verified at all three levels. Passed items (truths 2 to 5) given a regression check: the 8 non-PG targeted suites below pass at this head.
- Fingerprint: `gsd_run query verification.fingerprint .planning/phases/66-docs-reflect` with the 29 implementation files (SUMMARY added automatically). Exit 0. `covered_files` and `covered_digest` copied verbatim from its output. The covered list is the same as in the record replaced; the digest changed because 75d2ce56 touched `service.ts`, `telemetry.ts`, `telemetry.test.ts` and `docs-search.reflect.test.ts`.
- What changed since the prior record (75d2ce56, plus its docs line in `docs/corpus-reflect.md`): `service.ts` 6396 now calls `recordRetrieval(..., prepared !== undefined)`; `telemetry.ts` `retrievalRowOf` takes `isPrivate` and sets `queryText` to null when it is true; two tests added (`docs-search.reflect.test.ts` steering-session case, `telemetry.test.ts` private-row case).
- No code was edited. No commits were made. No full suite, tsc, lint or formatter was run.
- Postgres-gated files in the phase: `packages/mcp-server/src/corpus/reflect-store.test.ts` only (`describeLive` on `SUBSTRATE_TEST_PG_URL`). Re-run separately below against scratch Postgres 16 at 127.0.0.1:5439, database `substrate_test_v66`. The scratch URL is passed through the environment and is not recorded here.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | With `SUBSTRATE_DOCS_TELEMETRY=on` every `docs_search` appends a bounded, redacted row (query hash, capped redacted text, up to ten keys with scores, backend, surface) to `corpus_retrievals`, with retention | ✓ VERIFIED | Code: `service.ts` `searchDocsUnmeasured` (6396) calls `recordRetrieval` on every path that returns an answer, with `prepared !== undefined` as the `isPrivate` argument. `recordRetrieval` (6422) passes it to `retrievalRowOf`. `corpus/telemetry.ts` `retrievalRowOf` (86-95) sets `queryText: input.isPrivate ? null : queryTextOf(input.question)` and always sets `queryHash`, so a steering-session row keeps the hash and no text. Non-steering rows are unchanged. Retention: `sweepExpiredRetrievals` as before. Tests: `docs-search.reflect.test.ts` "a steering-session search writes exactly one row: no query text, only the hash of the question" (asserts one row, `queryText` null, hash of "where is the data plane described?", no "Data Plane" substring in the row) and `telemetry.test.ts` "a private row keeps no query text and the hash of the question" both pass in the regression run. The empty-question, redaction and non-steering row tests also pass. Owner decision (2026-11-04) recorded in 75d2ce56 and `docs/corpus-reflect.md`. |
| 2 | `docs_feedback` (MCP tool and REST route) records helpful, unhelpful, stale, wrong or duplicate per document key, audited, admission-limited, idempotent per session and document | ✓ VERIFIED | Carried forward from the prior record, unchanged by 75d2ce56. MCP tool `mcp.ts`; REST `server.ts` with `auditedRest(... "docs_feedback")`; `admission.ts` `docs_feedback: "write"`; `audit/src/policy.ts` fail-open list; `reflect-service.ts` `docsFeedbackReply` (active-manifest check gives 404 `unknown-document`); upsert keyed on `(document_key, session_id)` in `reflect-store.ts` `upsertFeedback`. `reflect-routes.test.ts` passed in the regression run. |
| 3 | `scoreDocument` is pure and tested. `SUBSTRATE_DOCS_RERANK=shadow` records the would-be change, `on` applies it, `off` is the default | ✓ VERIFIED | Carried forward. `corpus/src/authority.ts` `scoreDocument` is pure; `config.ts` `loadDocsReflectSettings` is `off` unless `shadow` or `on`; `rank.ts` `reflectCitations` implements the three modes. `authority.test.ts`, `rank.test.ts` and `docs-search.reflect.test.ts` ("off ... byte for byte", shadow and on cases) passed in the regression run. |
| 4 | A document that a newer version, an archive or an explicit marker supersedes is flagged; citations carry `stale` and `superseded_by` | ✓ VERIFIED | Carried forward. `corpus/src/supersession.ts` `detectSupersession`: three rules in order (marker, live plus milestone archive, two `local/*` copies with different sha256); cycles flag nothing. `rank.ts` sets `stale` and `superseded_by` on corpus citations in `on` mode only. `supersession.test.ts` and `docs-search.reflect.test.ts` passed in the regression run. Scope: corpus (LightRAG) citations only; RAGFlow answers are not annotated. |
| 5 | `substrate corpus reflect` writes one digest per repository into the docs plane and retains it in Hindsight with `document_id` replace; `corpus status --gaps` lists the queries that returned nothing useful | ✓ VERIFIED (against fakes; live plane not observed) | Carried forward. `corpus/src/reflect.ts` `buildDigest` is deterministic; `cli/src/corpus/reflect.ts` is a dry run unless `--execute`; `POST /corpus/reflect` in `server.ts` reaches `corpusReflectReply`, which calls `ingestCorpus` and then `retainDigest`; `lww` for `corpus-digest:` subjects and `update_mode: "replace"` with `document_id` in `planes/hindsight.ts`. `reflect-service.test.ts` and `reflect-routes.test.ts` passed in the regression run. Live LightRAG and Hindsight behaviour not observed (see human items). |

**Score:** 5/5 truths verified. Truth 5 is verified against fakes; its live behaviour is a human item. `behavior_unverified: 0`.

### Requirements Coverage (REQUIREMENTS.md)

| Requirement | Source | Description | Status | Evidence |
| ----------- | ------ | ----------- | ------ | -------- |
| REFLECT-01 | SUMMARY frontmatter | Every `docs_search` is recorded as a bounded, redacted retrieval event | ✓ SATISFIED | Truth 1, including steering-session searches (hash kept, text dropped) |
| REFLECT-02 | SUMMARY frontmatter | `docs_feedback` records a verdict per document key, audited, admission-limited, idempotent | ✓ SATISFIED | Truth 2 |
| REFLECT-03 | SUMMARY frontmatter | Authority score and shadow-first re-rank | ✓ SATISFIED | Truth 3 |
| REFLECT-04 | SUMMARY frontmatter | Supersession flagged in citations | ✓ SATISFIED | Truth 4 |
| REFLECT-05 | SUMMARY frontmatter | Digests into docs plane and Hindsight, gaps listed | ✓ SATISFIED against fakes; live run not observed | Truth 5 |

Orphaned requirements: none. All five IDs appear in the SUMMARY frontmatter `requirements` field; no PLAN.md exists to declare them.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/corpus/telemetry.ts` | Row builder, recorder, sweep | ✓ VERIFIED | Substantive; `isPrivate` added in 75d2ce56; wired from `service.ts` (recordRetrieval, retention sweep) |
| `packages/mcp-server/src/corpus/reflect-store.ts` | Bun SQL adapter for tables from step 38 | ✓ VERIFIED | `appendRetrieval`, `sweepRetrievals`, `upsertFeedback`, `feedbackCounts`, `gaps` present; PG test passed |
| `packages/mcp-server/src/index-store.ts` | Migration step 38 `corpus_reflect` | ✓ VERIFIED | Tables and indexes present; runs at every boot, no flag |
| `packages/corpus/src/authority.ts` | Pure `scoreDocument` | ✓ VERIFIED | Pure; tested |
| `packages/corpus/src/supersession.ts` | `detectSupersession` | ✓ VERIFIED | Pure; tested |
| `packages/corpus/src/reflect.ts` | `buildDigest` | ✓ VERIFIED | Deterministic; wired through CLI and `corpusReflectReply` |
| `packages/mcp-server/src/corpus/reflect-service.ts` | Feedback, reflect and gaps replies | ✓ VERIFIED | Wired from `server.ts` and `mcp.ts` |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` `searchDocsUnmeasured` | `recordRetrieval` | unconditional call at 6396, `isPrivate = prepared !== undefined` | ✓ WIRED | Steering-session `docs_search` reaches `recordRetrieval` and writes one row with text null |
| `service.ts` `recordRetrieval` | `RetrievalRecorder.record` → `appendRetrieval` | `retrievalRecorder` | ✓ WIRED | Fail-open, budgeted |
| `mcp.ts` `docs_feedback` | `docsFeedback` → `docsFeedbackReply` → `upsertFeedback` | `substrate.docsFeedback` | ✓ WIRED | Invalidates authority feedback cache |
| `server.ts` `/corpus/reflect` | `corpusReflectReply` → `retainDigest` | `substrate.corpusReflect` | ✓ WIRED | Retain through governed write |
| `rank.ts` `reflectCitations` | `service.ts` `reflectAnswer` | `authorityIndex.lookup` | ✓ WIRED | Runs after the docs cache |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `corpus_retrievals` row | `queryHash`, `queryText`, `topScore`, `returned` | `queryHash` from the normalised question; `queryText` null for steering calls; scores from the SearchReply chunks | Yes, when the plane answers. Live LightRAG score field not observed | ✓ FLOWING (fake-tested) |
| `corpus_feedback` counts | `feedbackCounts` | Real SQL group-by | Yes; PG test passed | ✓ FLOWING |
| Digest text | `buildDigest` | STATE and ROADMAP text from the CLI scan | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Phase 66 non-PG suites (8 files: docs-search.reflect, telemetry, reflect-routes, rank, authority, supersession, reflect-service, authority-index) | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 <8 files>` | 170 pass, 0 fail, 51876 expect() calls, 8 files, 774 ms (168 at 9e71f263; the 2 added are the steering-session and private-row tests) | ✓ PASS |
| Reflect tables against live index (`reflect-store.test.ts`, PG-gated) | `SUBSTRATE_TEST_PG_URL=<scratch URL, database substrate_test_v66> TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/corpus/reflect-store.test.ts` | 7 pass, 0 fail, 0 skip, 22 expect() calls, 1 file, 219 ms. Observed on scratch Postgres 16 (127.0.0.1:5439, database `substrate_test_v66`), not production | ✓ PASS |
| Steering-session `docs_search` records one row with no text | Named test in the 8-file run above: "a steering-session search writes exactly one row: no query text, only the hash of the question" | Passes (part of 170 pass, 0 fail) | ✓ PASS |
| Fingerprint command | `gsd_run query verification.fingerprint .planning/phases/66-docs-reflect <29 files>` | exit 0; digest `v3:sha256:42812094d1a327fed97561ffa8563ac6104bdf41f79bd57bca84b07d9b677b13` | ✓ PASS |

The `[substrate] docs telemetry: ... connection lost` and `denied corpus_ingest ... ENOTDIR` lines in the non-PG run come from tests that inject failing stores or paths. They are expected fail-open output, not failures.

### Probe Execution

No probe is declared in the phase's PLAN, SUMMARY or success criteria. Phase 66 is not a probe-based or migration-verification phase by declaration. Skipped.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/service.ts` | 6396 | Recording guard keyed on `prepared` (prior blocker) | ✓ Resolved | No longer skips steering calls; the flag now only sets `isPrivate` |
| `packages/mcp-server/src/service.ts` | 6422 | `recordRetrieval` swallows failures silently | ℹ️ Info | Intended fail-open; the recorder counts drops and failures |

Debt-marker scan (TBD, FIXME, XXX, TODO, HACK, PLACEHOLDER) of the 29 implementation files: none in the prior run. Re-scanned for this run: `service.ts`, `telemetry.ts`, `telemetry.test.ts` and `docs-search.reflect.test.ts` (the files 75d2ce56 touched) contain no marker.

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
   - **Why human:** It needs a live steering session and the live index. The code and the test prove it on fakes and scratch Postgres.

5. **Operator decisions carried from the SUMMARY** (not blocking this status)
   - Step 38 has no opt-in and must be rehearsed on a restored dump.
   - `docs_feedback` has no caller in the repository.
   - No schedule exists for reflect.

## Gaps Summary

None. Truth 1 (REFLECT-01, SC1) is verified: the owner decision of 2026-11-04 (75d2ce56) keeps a steering-session `docs_search` row with the query text dropped and the hash kept, and the code and the two new tests show it. Truths 2 to 5 are carried forward from the prior record and pass the regression run at this head (170 non-PG pass across the 8 phase suites; 7 PG pass on scratch Postgres).

Residual risks from the SUMMARY still apply and are not changed by this verification: verdict stacking across session ids; per-process authority and feedback caches; a failed Hindsight digest leg is not retried by a later unchanged run; the shadow report has no read path; the 5000-key feedback bound. The hash of a steering-session question is kept per the owner decision; a short private question can be guessed by hashing, which the owner accepted.

---

_Verified: 2026-11-05T00:13:13Z_
_Verifier: Claude (gsd-verifier)_
