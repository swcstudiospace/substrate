---
phase: 66-docs-reflect
verified: 2026-11-04T23:00:27Z
status: gaps_found
score: 4/5 must-haves verified
covered_files: [".planning/phases/66-docs-reflect/66-SUMMARY.md", "packages/audit/src/policy.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/reflect.ts", "packages/corpus/src/authority.test.ts", "packages/corpus/src/authority.ts", "packages/corpus/src/reflect.ts", "packages/corpus/src/supersession.test.ts", "packages/corpus/src/supersession.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/authority-index.test.ts", "packages/mcp-server/src/corpus/authority-index.ts", "packages/mcp-server/src/corpus/digest-retain.ts", "packages/mcp-server/src/corpus/rank.test.ts", "packages/mcp-server/src/corpus/rank.ts", "packages/mcp-server/src/corpus/reflect-routes.test.ts", "packages/mcp-server/src/corpus/reflect-service.test.ts", "packages/mcp-server/src/corpus/reflect-service.ts", "packages/mcp-server/src/corpus/reflect-store.test.ts", "packages/mcp-server/src/corpus/reflect-store.ts", "packages/mcp-server/src/corpus/telemetry.test.ts", "packages/mcp-server/src/corpus/telemetry.ts", "packages/mcp-server/src/docs-search.reflect.test.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/planes/hindsight.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:042ee0889030fbd53a321bb12199dd4a4bee37d8e2de10be15a316ee524ef611"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/5
  gaps_closed: []
  gaps_remaining:
    - "Truth 1 (REFLECT-01): a steering-session docs_search writes no corpus_retrievals row (service.ts:6395)"
  regressions: []
gaps:
  - truth: "With SUBSTRATE_DOCS_TELEMETRY=on every docs_search appends one bounded, redacted corpus_retrievals row (REFLECT-01, ROADMAP SC1)"
    status: failed
    reason: "A docs_search that names steering_session_id runs through executeLiveCall, so searchDocsMeasured passes a prepared live call to searchDocsUnmeasured. searchDocsUnmeasured records the row only when prepared is undefined (service.ts:6395), so every steering-session search writes no row. The guard came in with d535f8c6 (feat(steering)!: enforce durable per-session credential isolation), after the phase 66 squash. 8ec01492 (ancestor of HEAD) removed only the empty-question guard and did not reach this one. The owner decision on steering-session recording is still open, so this criterion stays FAILED."
    artifacts:
      - path: "packages/mcp-server/src/service.ts"
        issue: "line 6395: `if (prepared === undefined) this.recordRetrieval(surface, originalQuestion, chunks, reflected.shadow);` skips the row for live (steering) calls"
    missing:
      - "Record the retrieval for live (prepared) docs_search calls as well, exactly once per call, with the same redacted row (only after the owner decides the open steering-session question)."
      - "Add a test in docs-search.reflect.test.ts that asks with steering_session_id and expects one row, as the empty-question test does. No such test exists today (grep for steering in that file: 0 hits)."
deferred: []
---

# Phase 66: Docs Reflect Verification Report

**Phase Goal:** The docs RAG improves with use: it remembers what was retrieved, learns what helped, prefers the current document to the one it replaced, writes digests of what it knows and reports what it could not answer.
**Verified:** 2026-11-04T23:00:27Z
**Status:** gaps_found
**Re-verification:** Yes. The prior record (66-VERIFICATION.md, HEAD 504da465, gaps_found, 4/5) carries a `gaps:` section, so this run is in re-verification mode. No gap-closure commit exists since: the gap is still present at HEAD 9e71f263.

## Scope and method

- Head: `9e71f263` (integration branch `gsd/v18-int-all`, worktree `/root/src/worktrees/as-gsd-v18-all`).
- No PLAN.md exists for this phase. Must-haves are the ROADMAP phase 66 success criteria 1 to 5 (Step 2a). REQUIREMENTS.md REFLECT-01 to REFLECT-05 map to them.
- Failed item (truth 1) re-verified at all three levels. Passed items (truths 2 to 5) given a regression check: the targeted suites below still pass at this head.
- Fingerprint: `gsd_run query verification.fingerprint .planning/phases/66-docs-reflect` with the 29 implementation files (SUMMARY added automatically). Exit 0. `covered_files` and `covered_digest` copied verbatim from its output.
- No code was edited. No commits were made. No full suite, tsc, lint or formatter was run.
- Postgres-gated files in the phase: `packages/mcp-server/src/corpus/reflect-store.test.ts` only (`describeLive` on `SUBSTRATE_TEST_PG_URL`). Re-run separately below against scratch Postgres 16.15 at 127.0.0.1:5439, database `substrate_test_v66`. The scratch URL is passed through the environment and is not recorded here.
- Ancestry: `8ec01492` and `d535f8c6` are both ancestors of HEAD `9e71f263`.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | With `SUBSTRATE_DOCS_TELEMETRY=on` every `docs_search` appends a bounded, redacted row (query hash, capped redacted text, up to ten keys with scores, backend, surface) to `corpus_retrievals`, with retention | ✗ FAILED | Holds for every search that does not name `steering_session_id`: `service.ts` `recordRetrieval` (6421) is called after the answer is built (6395) and `retrievalRowOf` / `queryTextOf` / `returnedOf` are in `corpus/telemetry.ts`. The empty question is recorded after 8ec01492 (`docs-search.reflect.test.ts`, "an empty question writes one row with no text and the hash of the empty string", passed in this run). The redaction test "a question holding a credential keeps no text at all" passed. Retention is in `sweepExpiredRetrievals` (batch 1000, 50 batches, 2000 ms) and `reflect-store.ts` `sweepRetrievals`; the retention test passed. Steering path: `searchDocs` (6269) routes a `steering_session_id` search through `executeLiveCall`; `searchDocsMeasured` (6278) passes `prepared` into `searchDocsUnmeasured` (6305); line 6395 is `if (prepared === undefined) this.recordRetrieval(...)`. So a steering-session search writes no row. No test covers that path. |
| 2 | `docs_feedback` (MCP tool and REST route) records helpful, unhelpful, stale, wrong or duplicate per document key, audited, admission-limited, idempotent per session and document | ✓ VERIFIED | MCP tool `mcp.ts` (registered unflagged). REST `server.ts` with `auditedRest(... "docs_feedback")`. `admission.ts` `docs_feedback: "write"`. `audit/src/policy.ts` fail-open list. `reflect-service.ts` `docsFeedbackReply`: active-manifest check gives 404 `unknown-document`; upsert keyed on `(document_key, session_id)` in `reflect-store.ts` `upsertFeedback`. `reflect-routes.test.ts` passed (regression run). |
| 3 | `scoreDocument` is pure and tested. `SUBSTRATE_DOCS_RERANK=shadow` records the would-be change, `on` applies it, `off` is the default | ✓ VERIFIED | `corpus/src/authority.ts` `scoreDocument` is pure over its input. `config.ts` `loadDocsReflectSettings`: `off` unless `shadow` or `on`. `rank.ts` `reflectCitations`: `off` returns input; `shadow` returns input unchanged plus a shadow note stored in the row; `on` annotates and reorders. `authority.test.ts`, `rank.test.ts` and `docs-search.reflect.test.ts` ("off ... byte for byte", shadow and on cases) passed (regression run). |
| 4 | A document that a newer version, an archive or an explicit marker supersedes is flagged; citations carry `stale` and `superseded_by` | ✓ VERIFIED | `corpus/src/supersession.ts` `detectSupersession`: three rules in order (marker, live plus milestone archive, two `local/*` copies with different sha256); cycles flag nothing. `rank.ts` sets `stale` and `superseded_by` on corpus citations, in `on` mode only. `supersession.test.ts` and `docs-search.reflect.test.ts` ("on drops a superseded document ... citation carries stale and superseded_by") passed (regression run). Scope: corpus (LightRAG) citations only; RAGFlow answers are not annotated. |
| 5 | `substrate corpus reflect` writes one digest per repository into the docs plane and retains it in Hindsight with `document_id` replace; `corpus status --gaps` lists the queries that returned nothing useful | ✓ VERIFIED (against fakes; live plane not observed) | `corpus/src/reflect.ts` `buildDigest`: deterministic from STATE and ROADMAP (and PROJECT.md when present). `cli/src/corpus/reflect.ts`: dry run unless `--execute`. `POST /corpus/reflect` in `server.ts` reaches `corpusReflectReply`, which calls `ingestCorpus` and then `retainDigest` (`service.ts`), with `lww` for `corpus-digest:` subjects and `update_mode: "replace"` with `document_id` in `planes/hindsight.ts`. `reflect-service.test.ts` and `reflect-routes.test.ts` passed (regression run). Gaps: `best: null` for a query that returned nothing; counted as a gap in SQL. Live LightRAG and Hindsight were not run. |

**Score:** 4/5 truths verified (truth 1 FAILED; truths 2 to 5 verified, truth 5 against fakes only). `behavior_unverified: 0`.

### Requirements Coverage (REQUIREMENTS.md)

| Requirement | Source | Description | Status | Evidence |
| ----------- | ------ | ----------- | ------ | -------- |
| REFLECT-01 | SUMMARY frontmatter | Every `docs_search` is recorded as a bounded, redacted retrieval event | ✗ BLOCKED for steering-session searches | Non-steering searches recorded (truth 1). Steering-session searches not recorded (`service.ts` 6395). Owner decision on steering-session recording is still open. |
| REFLECT-02 | SUMMARY frontmatter | `docs_feedback` records a verdict per document key, audited, admission-limited, idempotent | ✓ SATISFIED | Truth 2 |
| REFLECT-03 | SUMMARY frontmatter | Authority score and shadow-first re-rank | ✓ SATISFIED | Truth 3 |
| REFLECT-04 | SUMMARY frontmatter | Supersession flagged in citations | ✓ SATISFIED | Truth 4 |
| REFLECT-05 | SUMMARY frontmatter | Digests into docs plane and Hindsight, gaps listed | ✓ SATISFIED against fakes; live run not observed | Truth 5 |

Orphaned requirements: none. All five IDs appear in the SUMMARY frontmatter `requirements` field; no PLAN.md exists to declare them.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/corpus/telemetry.ts` | Row builder, recorder, sweep | ✓ VERIFIED | Substantive; wired from `service.ts` (recordRetrieval, retention sweep) |
| `packages/mcp-server/src/corpus/reflect-store.ts` | Bun SQL adapter for tables from step 38 | ✓ VERIFIED | `appendRetrieval`, `sweepRetrievals`, `upsertFeedback`, `feedbackCounts`, `gaps` present; PG test passed |
| `packages/mcp-server/src/index-store.ts` | Migration step 38 `corpus_reflect` | ✓ VERIFIED | Tables and indexes present; runs at every boot, no flag |
| `packages/corpus/src/authority.ts` | Pure `scoreDocument` | ✓ VERIFIED | Pure; tested |
| `packages/corpus/src/supersession.ts` | `detectSupersession` | ✓ VERIFIED | Pure; tested |
| `packages/corpus/src/reflect.ts` | `buildDigest` | ✓ VERIFIED | Deterministic; wired through CLI and `corpusReflectReply` |
| `packages/mcp-server/src/corpus/reflect-service.ts` | Feedback, reflect and gaps replies | ✓ VERIFIED | Wired from `server.ts` and `mcp.ts` |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` `searchDocsUnmeasured` | `recordRetrieval` | `if (prepared === undefined)` (6395) | ✗ NOT_WIRED for live calls | Steering-session `docs_search` never reaches `recordRetrieval` |
| `service.ts` `recordRetrieval` | `RetrievalRecorder.record` → `appendRetrieval` | `retrievalRecorder` | ✓ WIRED | Fail-open, budgeted |
| `mcp.ts` `docs_feedback` | `docsFeedback` → `docsFeedbackReply` → `upsertFeedback` | `substrate.docsFeedback` | ✓ WIRED | Invalidates authority feedback cache |
| `server.ts` `/corpus/reflect` | `corpusReflectReply` → `retainDigest` | `substrate.corpusReflect` | ✓ WIRED | Retain through governed write |
| `rank.ts` `reflectCitations` | `service.ts` `reflectAnswer` | `authorityIndex.lookup` | ✓ WIRED | Runs after the docs cache |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `corpus_retrievals` row | `topScore`, `returned` | The SearchReply chunks after the plane answers | Yes, when the plane answers. Live LightRAG score field not observed | ✓ FLOWING (fake-tested) |
| `corpus_feedback` counts | `feedbackCounts` | Real SQL group-by | Yes; PG test passed | ✓ FLOWING |
| Digest text | `buildDigest` | STATE and ROADMAP text from the CLI scan | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Phase 66 non-PG suites (8 files: docs-search.reflect, telemetry, reflect-routes, rank, authority, supersession, reflect-service, authority-index) | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 <8 files>` | 168 pass, 0 fail, 51866 expect() calls, 8 files, 2.45 s | ✓ PASS |
| Reflect tables against live index (`reflect-store.test.ts`, PG-gated) | `SUBSTRATE_TEST_PG_URL=<scratch URL, database substrate_test_v66> TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/corpus/reflect-store.test.ts` | 7 pass, 0 fail, 0 skip, 22 expect() calls, 1 file, 696 ms. Observed on scratch Postgres 16.15 (127.0.0.1:5439, database `substrate_test_v66`), not production | ✓ PASS |
| Steering-session `docs_search` records a row | No test exists (`docs-search.reflect.test.ts` has no steering case; `service.test.ts` 6339 and 6346 drive steering searches without asserting a row); code read at `service.ts` 6395 | Guard skips the row for `prepared` calls | ✗ FAIL (code evidence, not a run) |
| Fingerprint command | `gsd_run query verification.fingerprint .planning/phases/66-docs-reflect <29 files>` | exit 0; digest `v3:sha256:042ee088...ef611` | ✓ PASS |

The `[substrate] docs telemetry: ... connection lost` and `denied corpus_ingest ... ENOTDIR` lines in the non-PG run come from tests that inject failing stores or paths. They are expected fail-open output, not failures.

### Probe Execution

No probe is declared in the phase's PLAN, SUMMARY or success criteria. Phase 66 is not a probe-based or migration-verification phase by declaration. Skipped.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/service.ts` | 6395 | Recording guard keyed on `prepared`, which skips steering calls | 🛑 Blocker | Violates "every docs_search is recorded" (REFLECT-01) |
| `packages/mcp-server/src/service.ts` | 6421 | `recordRetrieval` swallows failures silently | ℹ️ Info | Intended fail-open; the recorder counts drops and failures |

Debt-marker scan (TBD, FIXME, XXX, TODO, HACK, PLACEHOLDER) of the 29 implementation files: none.

### Human Verification Required

These cannot be checked from the repository. They do not change the status while truth 1 is FAILED.

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

4. **Operator decisions carried from the SUMMARY** (not blocking this status)
   - Step 38 has no opt-in and must be rehearsed on a restored dump.
   - `docs_feedback` has no caller in the repository.
   - No schedule exists for reflect.

## Gaps Summary

One blocker. REFLECT-01 (truth 1) holds for every search that does not name `steering_session_id`. A search that does name it writes no `corpus_retrievals` row, because `searchDocsUnmeasured` records only when `prepared === undefined` (`service.ts` 6395). That guard came in with d535f8c6, after the phase 66 squash, and 8ec01492 did not cover it. The steering-session exclusion is an open owner decision, so criterion 1 stays FAILED and is not counted as passed. Closing it requires the owner's decision, then the code change and a steering-session test in `docs-search.reflect.test.ts`, then re-verification.

Truths 2 to 5 hold in code and in the targeted tests run at this head (168 non-PG pass; 7 PG pass). Their live behaviour (the live score field, the Hindsight replace, the gaps list) has not been observed in any run.

Residual risks from the SUMMARY still apply and are not changed by this verification: verdict stacking across session ids; per-process authority and feedback caches; a failed Hindsight digest leg is not retried by a later unchanged run; the shadow report has no read path; the 5000-key feedback bound.

---

_Verified: 2026-11-04T23:00:27Z_
_Verifier: Claude (gsd-verifier)_
