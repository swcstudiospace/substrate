---
phase: 66-docs-reflect
verified: 2026-11-05T07:10:01Z
status: human_needed
score: 5/5 must-haves verified
covered_files: [".planning/phases/66-docs-reflect/66-SUMMARY.md", "packages/audit/src/policy.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/reflect.ts", "packages/corpus/src/authority.test.ts", "packages/corpus/src/authority.ts", "packages/corpus/src/reflect.ts", "packages/corpus/src/supersession.test.ts", "packages/corpus/src/supersession.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/authority-index.test.ts", "packages/mcp-server/src/corpus/authority-index.ts", "packages/mcp-server/src/corpus/digest-retain.ts", "packages/mcp-server/src/corpus/rank.test.ts", "packages/mcp-server/src/corpus/rank.ts", "packages/mcp-server/src/corpus/reflect-routes.test.ts", "packages/mcp-server/src/corpus/reflect-service.test.ts", "packages/mcp-server/src/corpus/reflect-service.ts", "packages/mcp-server/src/corpus/reflect-store.test.ts", "packages/mcp-server/src/corpus/reflect-store.ts", "packages/mcp-server/src/corpus/telemetry.test.ts", "packages/mcp-server/src/corpus/telemetry.ts", "packages/mcp-server/src/docs-search.reflect.test.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/planes/hindsight.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:f29ead8a2da87da3323799a4ee052e0f66f62b5e5167afc57a1e8daf654d5397"
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
---

# Phase 66: Docs Reflect Verification Report

**Phase Goal:** The docs RAG improves with use: it remembers what was retrieved, learns what helped, prefers the current document to the one it replaced, writes digests of what it knows and reports what it could not answer.
**Verified:** 2026-11-05T07:10:01Z
**Status:** human_needed
**Re-verification:** Yes. The prior record (66-VERIFICATION.md, HEAD 835a2742, human_needed, 5/5) carries a `gaps:` section (empty), so this run is in re-verification mode. No gap was open. Changes since that head touch two covered files (`service.ts`, `flag-registry.ts`) but none on a phase 66 path; the phase 66 claims were re-checked at HEAD 42e3cf13.

## Scope and method

- Head: `42e3cf13` (integration branch `gsd/v18-int-all`, worktree `/root/src/worktrees/as-gsd-v18-all`). `835a2742`, `c40ffc9a` and `75d2ce56` are ancestors of HEAD. The prior record was at `835a2742`.
- No PLAN.md exists for this phase. Must-haves are the ROADMAP phase 66 success criteria 1 to 5 (Step 2a). REQUIREMENTS.md REFLECT-01 to REFLECT-05 map to them.
- Changes since the prior record's head (`835a2742..42e3cf13`) that touch covered files: `packages/mcp-server/src/service.ts` (+54/-9, five hunks at lines 51, 540, 1639, 2677 and 4498: the in-process last-good brief-snapshot path, `snapshotKey` import, and `briefForgottenAtMs` in `memoryForget`) and `packages/mcp-server/src/flag-registry.ts` (help text of `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S`). None lies on a phase 66 path. The whole `service.ts` diff sits above the phase 66 code, which moved down 45 lines by the same amount (`searchDocsUnmeasured` now at 6351, its `recordRetrieval` call at 6441; `recordRetrieval` now at 6467). `corpus/telemetry.ts` (82 and 92) is unchanged. Earlier changes (`c40ffc9a..835a2742`) were already covered by the prior record.
- Fingerprint: `gsd_run query verification.fingerprint .planning/phases/66-docs-reflect` with the 29 implementation files (the SUMMARY is added automatically; the 29 paths were passed as arguments because the query rejects an empty list). Exit 0. `covered_files` and `covered_digest` copied verbatim from its output. The covered list is the same 30 entries as in the prior record; the digest changed (`4bad9a6b...` to `f29ead8a...`) because `service.ts` and `flag-registry.ts` changed at HEAD.
- Debt-marker scan (TBD, FIXME, XXX, TODO, HACK, PLACEHOLDER) of the 29 implementation files: no match.
- No code was edited. No commits were made. No full suite, tsc, lint or formatter was run.
- Postgres-gated file in the phase: `packages/mcp-server/src/corpus/reflect-store.test.ts` only (`describeLive` on `SUBSTRATE_TEST_PG_URL`). Re-run at HEAD against scratch Postgres 16 at 127.0.0.1:5439, database `substrate_test_v66`, with `TMPDIR=/root/src/worktrees/backups/gate-tmpfs`: 7 pass, 0 fail. The URL is passed through the environment and is not recorded here.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | With `SUBSTRATE_DOCS_TELEMETRY=on` every `docs_search` appends a bounded, redacted row (query hash, capped redacted text, up to ten keys with scores, backend, surface) to `corpus_retrievals`, with retention | ✓ VERIFIED | Code at HEAD: `service.ts` `searchDocsUnmeasured` (6351) calls `recordRetrieval(surface, originalQuestion, chunks, reflected.shadow, prepared !== undefined)`. `recordRetrieval` (6467; the `retrievalRowOf` call with `isPrivate` at 6470) passes `isPrivate` to `retrievalRowOf`. `corpus/telemetry.ts` (82) declares `isPrivate`; (92) sets `queryText: input.isPrivate ? null : queryTextOf(input.question)` and always sets `queryHash`. A steering-session row keeps the hash and no text; non-steering rows are unchanged. Retention: `sweepExpiredRetrievals` as before. Tests: `docs-search.reflect.test.ts` case "a steering-session search writes exactly one row: no query text, only the hash of the question" and the private-row case in `telemetry.test.ts`, both passing in the 8-file non-PG run (170 pass). |
| 2 | `docs_feedback` (MCP tool and REST route) records helpful, unhelpful, stale, wrong or duplicate per document key, audited, admission-limited, idempotent per session and document | ✓ VERIFIED | Regression check. MCP tool `mcp.ts`; REST `server.ts` with `auditedRest(... "docs_feedback")`; `admission.ts` `docs_feedback: "write"`; `audit/src/policy.ts` fail-open list; `reflect-service.ts` `docsFeedbackReply` (active-manifest check gives 404 `unknown-document`); upsert keyed on `(document_key, session_id)` in `reflect-store.ts` `upsertFeedback`. `reflect-routes.test.ts` and `reflect-service.test.ts` pass at HEAD (8-suite non-PG run). Feedback table exercised on scratch Postgres (`reflect-store.test.ts`, 7 pass at HEAD). |
| 3 | `scoreDocument` is pure and tested. `SUBSTRATE_DOCS_RERANK=shadow` records the would-be change, `on` applies it, `off` is the default | ✓ VERIFIED | Regression check. `corpus/src/authority.ts` `scoreDocument` is pure; `config.ts` `loadDocsReflectSettings` is `off` unless `shadow` or `on`; `rank.ts` `reflectCitations` implements the three modes. `authority.test.ts`, `rank.test.ts` and `docs-search.reflect.test.ts` ("off ... byte for byte", shadow and on cases) pass at HEAD. |
| 4 | A document that a newer version, an archive or an explicit marker supersedes is flagged; citations carry `stale` and `superseded_by` | ✓ VERIFIED | Regression check. `corpus/src/supersession.ts` `detectSupersession`: three rules in order (marker, live plus milestone archive, two `local/*` copies with different sha256); cycles flag nothing. `rank.ts` sets `stale` and `superseded_by` on corpus citations in `on` mode only. `supersession.test.ts` and `docs-search.reflect.test.ts` pass at HEAD. Scope: corpus (LightRAG) citations only; RAGFlow answers are not annotated. |
| 5 | `substrate corpus reflect` writes one digest per repository into the docs plane and retains it in Hindsight with `document_id` replace; `corpus status --gaps` lists the queries that returned nothing useful | ✓ VERIFIED (against fakes; live plane not observed) | Regression check. `corpus/src/reflect.ts` `buildDigest` is deterministic; `cli/src/corpus/reflect.ts` is a dry run unless `--execute`; `POST /corpus/reflect` in `server.ts` reaches `corpusReflectReply`, which calls `ingestCorpus` and then `retainDigest`; `lww` for `corpus-digest:` subjects and `update_mode: "replace"` with `document_id` in `planes/hindsight.ts`. `reflect-service.test.ts` and `reflect-routes.test.ts` pass at HEAD. Gaps aggregation by query hash is exercised by `reflect-store.test.ts` on scratch Postgres. Live LightRAG and Hindsight behaviour not observed. |

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
| `packages/mcp-server/src/corpus/telemetry.ts` | Row builder, recorder, sweep | ✓ VERIFIED | Substantive; `isPrivate` at 82, used at 92; wired from `service.ts` (recordRetrieval, retention sweep) |
| `packages/mcp-server/src/corpus/reflect-store.ts` | Bun SQL adapter for tables from step 38 | ✓ VERIFIED | `appendRetrieval`, `sweepRetrievals`, `upsertFeedback`, `feedbackCounts`, `gaps` present; PG test passed (7/7) |
| `packages/mcp-server/src/index-store.ts` | Migration step 38 `corpus_reflect` | ✓ VERIFIED | Tables and indexes present; runs at every boot, no flag |
| `packages/corpus/src/authority.ts` | Pure `scoreDocument` | ✓ VERIFIED | Pure; tested |
| `packages/corpus/src/supersession.ts` | `detectSupersession` | ✓ VERIFIED | Pure; tested |
| `packages/corpus/src/reflect.ts` | `buildDigest` | ✓ VERIFIED | Deterministic; wired through CLI and `corpusReflectReply` |
| `packages/mcp-server/src/corpus/reflect-service.ts` | Feedback, reflect and gaps replies | ✓ VERIFIED | Wired from `server.ts` and `mcp.ts` |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` `searchDocsUnmeasured` | `recordRetrieval` | unconditional call at 6441, `isPrivate = prepared !== undefined` | ✓ WIRED | Steering-session `docs_search` reaches `recordRetrieval` and writes one row with text null |
| `service.ts` `recordRetrieval` | `RetrievalRecorder.record` → `appendRetrieval` | `retrievalRecorder` | ✓ WIRED | Fail-open, budgeted |
| `mcp.ts` `docs_feedback` | `docsFeedback` → `docsFeedbackReply` → `upsertFeedback` | `substrate.docsFeedback` | ✓ WIRED | Invalidates authority feedback cache |
| `server.ts` `/corpus/reflect` | `corpusReflectReply` → `retainDigest` | `substrate.corpusReflect` | ✓ WIRED | Retain through governed write |
| `rank.ts` `reflectCitations` | `service.ts` `reflectAnswer` | `authorityIndex.lookup` | ✓ WIRED | Runs after the docs cache |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `corpus_retrievals` row | `queryHash`, `queryText`, `topScore`, `returned` | `queryHash` from the normalised question; `queryText` null for steering calls; scores from the SearchReply chunks | Yes, when the plane answers. Live LightRAG score field not observed; fixture has no score field | ✓ FLOWING (fake-tested) |
| `corpus_feedback` counts | `feedbackCounts` | Real SQL group-by | Yes; PG test passed (7/7) | ✓ FLOWING |
| Digest text | `buildDigest` | STATE and ROADMAP text from the CLI scan | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Phase 66 non-PG suites (8 files: docs-search.reflect, telemetry, reflect-routes, rank, authority, supersession, reflect-service, authority-index) | Two commands, `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test`: (a) in `packages/mcp-server`, the six mcp-server files; (b) in `packages/corpus`, `src/authority.test.ts` and `src/supersession.test.ts` | (a) 128 pass, 0 fail, 384 expect() calls, 6 files, 3.12 s; (b) 42 pass, 0 fail, 51492 expect() calls, 2 files, 400 ms. Together 170 pass, 0 fail, 51876 expect() calls, 8 files | ✓ PASS |
| Reflect tables against live index (`reflect-store.test.ts`, PG-gated) | `SUBSTRATE_TEST_PG_URL=<scratch URL, database substrate_test_v66> TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/corpus/reflect-store.test.ts` | 7 pass, 0 fail, 22 expect() calls, 1 file, 246 ms. Observed on scratch Postgres 16 (127.0.0.1:5439, database `substrate_test_v66`), not production | ✓ PASS |
| Steering-session `docs_search` records one row with no text | Named test in the 8-file run above: "a steering-session search writes exactly one row: no query text, only the hash of the question" | Passes (part of 170 pass, 0 fail) | ✓ PASS |
| Fingerprint command | `gsd_run query verification.fingerprint .planning/phases/66-docs-reflect <29 files>` | exit 0; digest `v3:sha256:f29ead8a2da87da3323799a4ee052e0f66f62b5e5167afc57a1e8daf654d5397` | ✓ PASS |

The `[substrate] docs telemetry: ... connection lost` and `denied corpus_ingest ... ENOTDIR` lines in the non-PG run come from tests that inject failing stores or paths. They are expected fail-open output, not failures.

### Probe Execution

No probe is declared in the phase's PLAN, SUMMARY or success criteria. Phase 66 is not a probe-based or migration-verification phase by declaration. Skipped.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/service.ts` | 6441 | Recording guard keyed on `prepared` (prior blocker) | ✓ Resolved | No longer skips steering calls; the flag now only sets `isPrivate` |
| `packages/mcp-server/src/service.ts` | 6467 | `recordRetrieval` swallows failures silently | ℹ️ Info | Intended fail-open; the recorder counts drops and failures |

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

None. Truth 1 (REFLECT-01, SC1) remains verified at HEAD `42e3cf13`: the owner decision of 2026-11-04 (75d2ce56) keeps a steering-session `docs_search` row with the query text dropped and the hash kept, and the code (`service.ts` 6441 and 6470, `telemetry.ts` 92) and the two new tests show it. Truths 2 to 5 pass the regression run at this head (170 non-PG pass across the 8 phase suites; 7 PG pass on scratch Postgres 16).

Residual risks from the SUMMARY still apply and are not changed by this verification: verdict stacking across session ids; per-process authority and feedback caches; a failed Hindsight digest leg is not retried by a later unchanged run; the shadow report has no read path; the 5000-key feedback bound. The hash of a steering-session question is kept per the owner decision; a short private question can be guessed by hashing, which the owner accepted.

---

_Verified: 2026-11-05T07:10:01Z_
_Verifier: Claude (gsd-verifier)_
