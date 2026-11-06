---
phase: 66-docs-reflect
verified: 2026-11-06T02:58:49Z
status: human_needed
score: 5/5 must-haves verified
covered_files: [".planning/phases/66-docs-reflect/66-SUMMARY.md","packages/audit/src/policy.ts","packages/cli/src/corpus/index.ts","packages/cli/src/corpus/reflect.ts","packages/corpus/src/authority.test.ts","packages/corpus/src/authority.ts","packages/corpus/src/reflect.ts","packages/corpus/src/supersession.test.ts","packages/corpus/src/supersession.ts","packages/mcp-server/src/admission.ts","packages/mcp-server/src/cache.ts","packages/mcp-server/src/config.ts","packages/mcp-server/src/corpus/authority-index.test.ts","packages/mcp-server/src/corpus/authority-index.ts","packages/mcp-server/src/corpus/digest-retain.ts","packages/mcp-server/src/corpus/rank.test.ts","packages/mcp-server/src/corpus/rank.ts","packages/mcp-server/src/corpus/reflect-routes.test.ts","packages/mcp-server/src/corpus/reflect-service.test.ts","packages/mcp-server/src/corpus/reflect-service.ts","packages/mcp-server/src/corpus/reflect-store.test.ts","packages/mcp-server/src/corpus/reflect-store.ts","packages/mcp-server/src/corpus/telemetry.test.ts","packages/mcp-server/src/corpus/telemetry.ts","packages/mcp-server/src/docs-search.reflect.test.ts","packages/mcp-server/src/docs-search.ts","packages/mcp-server/src/flag-registry.ts","packages/mcp-server/src/index-store.ts","packages/mcp-server/src/index-sweep.ts","packages/mcp-server/src/mcp.ts","packages/mcp-server/src/memory-retain.ts","packages/mcp-server/src/memory-write.ts","packages/mcp-server/src/planes/hindsight.ts","packages/mcp-server/src/server.ts","packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:2e509432920afe5a5ec80b0ffd7d5f7aa2cdc4b69b66da685a2ae442a2e23b54"
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
    expected: "A score taken from the plane's own score field for an answered search. A 0 with no score field in the raw reply is the default the code applies (docs-search.ts cite, score ?? 0), not a score"
    why_human: "Needs a live docs plane; the code and tests run on fakes, and the fixture has no score field"
  - test: "Run substrate corpus reflect --execute against live LightRAG and Hindsight 0.9.1, then run it again"
    expected: "One digest stored; the second run answers unchanged; the Hindsight entry is replaced, not duplicated"
    why_human: "External services"
  - test: "Run substrate corpus status --gaps after a few searches, some with no answer"
    expected: "The unanswered queries are listed, most searched first. Answered queries whose plane returns no score are also listed, because the gap predicate counts a null or zero best score as a gap (see owner item 1)"
    why_human: "Needs a populated index"
  - test: "With SUBSTRATE_DOCS_TELEMETRY=on, run a steering-session docs_search against the live index and read the new corpus_retrievals row"
    expected: "One row; query_text null; query_hash equal to the sha256 of the normalised question"
    why_human: "Needs a live steering session and the live index; the code and the tests prove it on fakes and scratch Postgres"
---

# Phase 66: Docs Reflect Verification Report

**Phase Goal:** The docs RAG improves with use, the way Hindsight does: it remembers what was retrieved, learns what helped, prefers the current document to the one it replaced, writes digests of what it knows and reports what it could not answer.
**Verified:** 2026-11-06T02:58:49Z
**Status:** human_needed
**Re-verification:** Yes. The prior record (66-VERIFICATION.md, recorded at HEAD a46d42c3, human_needed, 5/5, empty `gaps:`) puts this run in re-verification mode. No gap was open.

## Scope and method

- Head: `5e304ef8` (integration branch, worktree `/root/src/worktrees/as-gsd-v18-all`). The prior record was written at `a46d42c3`, an ancestor of head. Every commit since is read below; the phase's named commits `8ec01492` (every docs_search is recorded, including an empty question) and `75d2ce56` (steering-session docs_search keeps its row, query text dropped, hash kept) are still ancestors of head.
- No PLAN.md exists for this phase. Must-haves are the ROADMAP phase 66 success criteria 1 to 5. REQUIREMENTS.md REFLECT-01 to REFLECT-05 map to them.
- Diff check, `git diff -U0 a46d42c3 5e304ef8` on the 30 files the prior record covered. 19 of them changed. Each hunk was classified mechanically (the removed line with `export ` stripped must equal the added line):
  - Export-keyword removals only, no other change (16 files): `audit/src/policy.ts`, `cli/src/corpus/index.ts`, `cli/src/corpus/reflect.ts`, `corpus/src/reflect.ts`, `corpus/src/supersession.ts`, `mcp-server/src/admission.ts`, `config.ts`, `corpus/authority-index.ts`, `corpus/digest-retain.ts`, `corpus/rank.ts`, `corpus/reflect-service.ts`, `corpus/reflect-store.ts`, `corpus/telemetry.ts`, `flag-registry.ts`, `mcp.ts`, `planes/hindsight.ts`.
  - `index-store.ts`: export removals plus one comment line at 2785 (`healthz` ping returns a boolean). No behaviour change.
  - `server.ts`: export removals plus the REST `/handoff` `to` check at 1507-1511 (commit `14ac787a`). Not a phase 66 route. No line of `docs_search` (1647-1668), `/docs/feedback` (1829-1840), `/corpus/reflect` (1842-1852) or `/corpus/gaps` (1854-1862) changed.
  - `service.ts`: export removals plus one non-export hunk, the `manifestCommit` wiring at 6421 (commit `0947001e`). It now returns the manifest row, not only its commit. It feeds docs-search citations only (see Truth 1 and Truth 4). The phase 66 functions are otherwise unchanged. The `sweepRetrievals` try placement (6607-6616) is older than `a46d42c3` and is not in this diff.
- Files changed in the same window that sit on phase 66 paths and are added to `covered_files` by this record (5 files). Each was read by hand:
  - `packages/mcp-server/src/docs-search.ts` (`0947001e`, `e62bc17b`; `885e73ce` was before `a46d42c3`). The citation commit rule changed (`citableCommit`, 601); `withCorpusProvenance` (583) keeps `...citation`, so `stale` and `superseded_by` survive. Tandem `hindsightRecall` and fallback gained `reportSilent`. Covered now, so a later edit moves the digest.
  - `packages/mcp-server/src/cache.ts` (`f1266a9c`): connect-cooldown refusals now carry `breakerRetryAfterMs`. Consumed only by `admission.ts:386`, see Truth 2.
  - `packages/mcp-server/src/memory-write.ts` (`e62bc17b`): two silent catches now call `reportSilent`. Return values are the same as before (`finish-orphan` returns undefined; `verifySourceEvent` returns false).
  - `packages/mcp-server/src/memory-retain.ts` and `index-sweep.ts` (`a2176f96`): `retainDocumentId` parameter narrowed to `{ scope, kind, subject }`. Its body reads only those three fields and is unchanged, so `document_id` values are unchanged. The sweep passes the same three fields.
  - Test files changed in the window but not in `covered_files`: `corpus/citations.test.ts` (`0947001e`, `885e73ce`), `docs-search.test.ts`, `cache.test.ts`. None of the nine phase 66 test files changed in the window.
- Gate evidence (not rerun): `/root/src/worktrees/backups/gate-r38-junit.xml` (run on `66fa97bd`). Its single failure is `scripts/code-ratchet.test.ts` "the ratchet is tight: no source counter sits below its baseline" (`as_unknown_as` 22 against baseline 23), which `5e304ef8` addresses. The two skipped testcases are `packages/mcp-server/src/redact.test.ts:815` and `packages/mcp-server/src/cache-conformance.test.ts:120`; neither is a phase 66 title. Every title cited below was matched by file and exact name to a JUnit testcase with no `failure`, `error` or `skipped` child. The nine phase 66 test files have the same number of titles in source as they have JUnit entries in r38. `gate-r39-junit.xml` did not exist when this record was written. If r39 disagrees with any title below, this record must be re-checked.
- Fingerprint: `covered_files` (35 entries) and `covered_digest` are the verbatim output of `gsd_run query verification.fingerprint` at 5e304ef8. Five files cited by this record were added to the list: `docs-search.ts`, `memory-write.ts`, `memory-retain.ts`, `index-sweep.ts`, `cache.ts`.
- Owner decisions: none dated 2026-11-06 for phase 66 was found in the sources read (`.planning/STATE.md`, `.planning/ROADMAP.md`, `backups/exec-briefs`, `backups/verify-briefs`, `backups/records`). The steering-session hash acceptance cited in the residual risks below comes from the prior record, which gives no date. No owner decision is recorded here on the owner's behalf. Owner items stay open (see Gaps Summary).
- Debt-marker scan (TBD, FIXME, XXX, TODO, HACK, PLACEHOLDER) of the 29 implementation files: no match.
- No test, tsc, lint, formatter, gate or verification writer was run. Only read-only git, file reads, grep and a read of the JUnit XML were used. No file under the worktree or `/root/src/repos` was written.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | With `SUBSTRATE_DOCS_TELEMETRY=on` every `docs_search` appends a bounded, redacted row (query hash, capped redacted text, up to ten keys with scores, backend, surface) to `corpus_retrievals`, with retention | ✓ VERIFIED (answered searches; a search that throws writes no row) | Path unchanged in the window. MCP `docs_search` at `mcp.ts:1597` and REST at `server.ts:1652` (`auditedRest`) → `:1668` `substrate.searchDocs`. `service.ts` `searchDocs` (6331) → `searchDocsMeasured` (6351) → `searchDocsUnmeasured` (6378). The row is written at 6469, `recordRetrieval(surface, originalQuestion, chunks, reflected.shadow, prepared !== undefined)`, after `load()` or `cached()` (6458) and `reflectAnswer`. An empty question reaches 6469 through `load()` (6458). `recordRetrieval` (6495) checks `config.docsReflect.telemetry` (6496, set from `config.ts:1606`, on only). `corpus/telemetry.ts` `retrievalRowOf` (86): `queryHash` (91), `queryText` null when `isPrivate` (92), `returnedOf` (67, at most ten, key from `corpusKeyOf` or `source_url`), `topScore` from the finite citation scores. Retention: `sweepExpiredRetrievals` (208), `startRetrievalSweep` (6588-6595), `sweepRetrievals` (6607-6616). Changed hunk on this path: `manifestCommit` (6421, `0947001e`). It changes a citation's `commit` and `source_url` only. Row keys come from `corpusKeyOf` (`rank.ts:54`, dataset and title only), so the row is unaffected. Named passes: "one search appends exactly one row: the query hash, the redacted capped text, at most ten returned keys with scores, the backend and the surface" (docs-search.reflect.test.ts); "a steering-session search writes exactly one row: no query text, only the hash of the question" (docs-search.reflect.test.ts); "an empty question writes one row with no text and the hash of the empty string" (docs-search.reflect.test.ts); "a question holding a credential keeps no text at all, only its hash" (docs-search.reflect.test.ts); "retention drains every expired batch in one pass, and only rows older than the retention window" (docs-search.reflect.test.ts); "a retention sweep against a store that fails deletes nothing and does not throw" (docs-search.reflect.test.ts); "with the flag off nothing is written, counted or swept" (docs-search.reflect.test.ts). Qualification: `recordRetrieval` runs after the answer is built, so a search that throws before its reply writes no row. The recorder is fail-open. The SC1 wording "every `docs_search`" is read here as every answered search. Not a gap. |
| 2 | `docs_feedback` (MCP tool and REST route) records helpful, unhelpful, stale, wrong or duplicate per document key, audited, admission-limited, idempotent per session and document | ✓ VERIFIED (default admission policy) | Path unchanged in the window. MCP tool `mcp.ts:1749`, handler `mcp.ts:1767` → `Substrate.docsFeedback` (`service.ts:6564`, invalidates the authority feedback cache) → `docsFeedbackReply` (`reflect-service.ts:163`) → `upsertFeedback` (`reflect-store.ts:126`). REST `POST /docs/feedback` at `server.ts:1829`, audited under `docs_feedback` at 1837; the note is excluded from the audit fields (comment 1835, fields 1836). `admission.ts:254` `docs_feedback: "write"`; `audit/src/policy.ts:134` fail-open. Changes checked: `policy.ts` and `admission.ts` export-only. `cache.ts` (`f1266a9c`): a cooldown refusal now carries `breakerRetryAfterMs`, and `admission.ts:386` acts on it only when the class's breaker policy is `fail-closed` in enforce mode. The default for every class is `fail-open` (`config.ts` `breakerPolicyOf`, 1929-1935), so default behaviour is unchanged. Under an operator opt-in (`SUBSTRATE_BUDGET_WRITE_BREAKER=fail-closed`) a `docs_feedback` during the 5 s connect cooldown is now refused, where before it was bypassed. Recorded as an operator-visible change, not a gap. Named passes: "the audit record is written under docs_feedback with the document and the verdict, never the note" (reflect-routes.test.ts); "it is registered, a write in admission, and fail-open in the audit policy" (reflect-routes.test.ts); "one verdict per session and document: a repeat replaces it, another session adds one" (reflect-service.test.ts); "feedback is one verdict per document and session, the latest wins, and the counts are grouped per document" (reflect-store.test.ts). |
| 3 | `scoreDocument` is pure and tested. `SUBSTRATE_DOCS_RERANK=shadow` records the would-be change, `on` applies it, `off` is the default | ✓ VERIFIED | Unchanged path. `corpus/src/authority.ts:114` `scoreDocument` is pure (file not changed in the window). `config.ts` `loadDocsReflectSettings` (1603-1609) reads `shadow` or `on`, otherwise `off` (1608). `service.ts` `reflectAnswer` (6479) returns the reply untouched when `mode === "off"`, when degraded, or when no citation has a corpus key (6480-6481). `corpus/rank.ts:80` `reflectCitations` returns the chunks unchanged for `off` (81), returns a shadow note for `shadow`, and annotates and re-sorts for `on` (88). Changes checked: `rank.ts`, `authority.ts` export-only. The score sort that `on` relies on (`docs-search.ts:1153`) is unchanged. Named passes: "off, and a flag left unset, answer byte for byte what a service with none of the new flags answers" (docs-search.reflect.test.ts); "shadow answers byte for byte what off answers, and records on the telemetry row what on would have changed" (docs-search.reflect.test.ts); "off returns the very citations it was given and never consults the lookup" (rank.test.ts); "on re-orders by score times authority, annotates each corpus citation and reports the positions moved" (rank.test.ts); "on re-orders the corpus citations by score times (0.5 + 0.5 * authority), keeps every other citation in place, and says what it did" (docs-search.reflect.test.ts); "on keeps the plane's order between documents of equal authority and equal score, and reports no moved position" (docs-search.reflect.test.ts); "more helpful feedback never lowers the score and, next to a negative, strictly raises it" (authority.test.ts). The `on` ordering is `score × authority`. A citation without a plane score carries score 0 (see Truth 5 and owner item 1), so `on` cannot reorder such citations. |
| 4 | A document that a newer version, an archive or an explicit marker supersedes is flagged; citations carry `stale` and `superseded_by` | ✓ VERIFIED | Unchanged path. `corpus/src/supersession.ts:150` `detectSupersession` (export-only change in the window): marker, live plus milestone archive, and two `local/*` copies with different content. `corpus/rank.ts:88` sets `stale` and `superseded_by` on corpus citations, in `on` mode only; `corpusKeyOf` (54) returns null for any dataset other than the corpus, so RAGFlow answers are not annotated. Citation fields: `docs-search.ts:109` (`stale`) and `:111` (`superseded_by`). `withCorpusProvenance` (`docs-search.ts:583-594`) spreads `...citation` before it sets `title`, `source_url`, `commit` and `dataset`, so both fields survive. The `0947001e` change alters `commit` and `source_url` only. Named passes: "on drops a superseded document below the document that replaced it, and its citation carries stale and superseded_by" (docs-search.reflect.test.ts); "a superseded document drops below the document that replaces it, and its citation names the replacement" (rank.test.ts); "a superseded document scores strictly lower than the same document not superseded" (authority.test.ts); "an archived file under a milestone directory is superseded by the live file with the same remainder" (supersession.test.ts); "flags a document whose marker names an existing row of the same repository" (supersession.test.ts); "the older copy is superseded by the newer one when the two differ" (supersession.test.ts). |
| 5 | `substrate corpus reflect` writes one digest per repository into the docs plane and retains it in Hindsight with `document_id` replace; `corpus status --gaps` lists the queries that returned nothing useful | ✓ VERIFIED (against fakes; live plane not observed). Gap list correctness depends on the plane's score field: owner item 1 | Digest path unchanged. `corpus/src/reflect.ts:151` `buildDigest` is deterministic (export-only change). CLI `cli/src/corpus/reflect.ts` export-only. `POST /corpus/reflect` (`server.ts:1842`) → `Substrate.corpusReflect` (`service.ts:6571`, bumps the docs generation after a stored digest) → `corpusReflectReply` (`reflect-service.ts:233`) → `retainDigest` (`service.ts:6530`, split by `splitDigestRetain`) → `retainDigestOutcome` (`corpus/digest-retain.ts:128`, subject prefix `corpus-digest:` at 19) → `writeMemoryWithLeg`. `planes/hindsight.ts:557` sends `update_mode: "replace"` (export-only change). Changes checked on this path: `memory-write.ts` (`e62bc17b`) two silent catches, same return values; `memory-retain.ts` and `index-sweep.ts` (`a2176f96`), type-only narrowing, same `document_id`. Gaps: `GET /corpus/gaps` (`server.ts:1854`) → `corpusGaps` (`service.ts:6581`) → `corpusGapsReply` (`reflect-service.ts:333`) → the gap aggregate (`reflect-store.ts` 160-170): `where … and not degraded`, grouped by `query_hash`, `having max(top_score) is null or max(top_score) < gapScore`. Qualification found in this run: `top_score` is `max` of the citation scores, and `cite()` (`docs-search.ts:526`, used by the LightRAG corpus path at 1152) sets a missing plane score to `0`. So an answered corpus query whose plane returns no score is stored with `top_score` 0 and listed as a gap, and `on` mode scores it 0 too. Whether the live LightRAG reply carries a score is not observed (human item 1). Named passes: "a query is a gap when its best score over the 30 days is below the gap score; degraded searches and older searches do not count" (reflect-routes.test.ts); "the gap aggregate lists a query whose best score was none or low, leaves out answered, degraded and old searches, and orders by searches" (reflect-store.test.ts); "contains no time: the last_updated stamp and a changed one leave the digest byte-identical" (packages/corpus/src/reflect.test.ts); "writes the fixed sections in order with the position, decisions newest first, open items and project" (packages/corpus/src/reflect.test.ts); "sends repo, text and sha256 only and counts each answer" (packages/cli/src/corpus/reflect.test.ts). The last two files are outside `covered_files`; they were read for this truth. |

**Score:** 5/5 truths verified at head. Truth 5 is verified against fakes; its live behaviour, and the score default it depends on, are human items. `behavior_unverified: 0`.

### Requirements Coverage (REQUIREMENTS.md)

| Requirement | Source | Description | Status | Evidence |
| ----------- | ------ | ----------- | ------ | -------- |
| REFLECT-01 | SUMMARY frontmatter | Every `docs_search` is recorded as a bounded, redacted retrieval event | ✓ SATISFIED (answered searches) | Truth 1 |
| REFLECT-02 | SUMMARY frontmatter | `docs_feedback` records a verdict per document key, audited, admission-limited, idempotent | ✓ SATISFIED | Truth 2 |
| REFLECT-03 | SUMMARY frontmatter | Authority score and shadow-first re-rank | ✓ SATISFIED | Truth 3 |
| REFLECT-04 | SUMMARY frontmatter | Supersession flagged in citations | ✓ SATISFIED | Truth 4 |
| REFLECT-05 | SUMMARY frontmatter | Digests into docs plane and Hindsight, gaps listed | ✓ SATISFIED against fakes; live run not observed; gap list depends on owner item 1 | Truth 5 |

Orphaned requirements: none. All five IDs appear in the SUMMARY frontmatter `requirements` field; no PLAN.md exists to declare them.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/corpus/telemetry.ts` | Row builder, recorder, sweep | ✓ VERIFIED | Export-only change in the window. `retrievalRowOf` 86, `returnedOf` 67, `sweepExpiredRetrievals` 208, `RETRIEVAL_SWEEP_INTERVAL_MS` 33 |
| `packages/mcp-server/src/corpus/reflect-store.ts` | Bun SQL adapter for tables from step 38 | ✓ VERIFIED | `upsertFeedback` 126; gap aggregate 160-170 (`group by query_hash` at 166); export-only change |
| `packages/mcp-server/src/index-store.ts` | Migration step 38 `corpus_reflect` | ✓ VERIFIED | Step name at 802, down migration at 804, `corpus_retrievals` create at 807; export and one comment line (2785) changed |
| `packages/corpus/src/authority.ts` | Pure `scoreDocument` | ✓ VERIFIED | Pure (114); file not changed in the window |
| `packages/corpus/src/supersession.ts` | `detectSupersession` | ✓ VERIFIED | Pure (150); export-only change |
| `packages/corpus/src/reflect.ts` | `buildDigest` | ✓ VERIFIED | Deterministic (151); export-only change |
| `packages/mcp-server/src/corpus/reflect-service.ts` | Feedback, reflect and gaps replies | ✓ VERIFIED | `docsFeedbackReply` 163, `corpusReflectReply` 233, `corpusGapsReply` 333; export-only changes |
| `packages/mcp-server/src/docs-search.ts` | Citation build, carries `stale`/`superseded_by` | ✓ VERIFIED (outside covered_files) | Changed by `0947001e` (citation commit rule, `citableCommit` 601) and `e62bc17b` (`reportSilent` in the tandem leg). `stale` 109 and `superseded_by` 111 intact; `withCorpusProvenance` 583 spreads `...citation`; score sort 1153. Not fingerprinted |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` `searchDocsUnmeasured` | `recordRetrieval` | unconditional call at 6469, `isPrivate = prepared !== undefined` | ✓ WIRED | Steering-session `docs_search` writes one row with text null; a blank question writes one row. A throw before 6469 writes none |
| `service.ts` `recordRetrieval` | `RetrievalRecorder.record` → `appendRetrieval` | `retrievalRecorder` (1941) | ✓ WIRED | Fail-open, budgeted |
| `mcp.ts` `docs_feedback` | `docsFeedback` → `docsFeedbackReply` → `upsertFeedback` | `substrate.docsFeedback` | ✓ WIRED | Invalidates authority feedback cache |
| `server.ts` `/corpus/reflect` | `corpusReflectReply` → `retainDigest` | `substrate.corpusReflect` | ✓ WIRED | Retain through governed write |
| `rank.ts` `reflectCitations` | `service.ts` `reflectAnswer` | `authorityIndex.lookup` | ✓ WIRED | Runs after the docs cache |
| `docs-search.ts` `manifestCommits` | `withCorpusProvenance` | `manifestCommit` dep (352), wired at `service.ts:6421` | ✓ WIRED | ATLAS-03 citation commit; not a phase 66 truth; no effect on rows, reranking or supersession |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `corpus_retrievals` row | `queryHash`, `queryText`, `topScore`, `returned` | `queryHash` from the normalised question; `queryText` null for steering-session calls; scores from the SearchReply chunks, a missing plane score becomes 0 | Yes for hash, text and keys. `topScore` is real only when the plane returns a score; live LightRAG score field not observed | ✓ FLOWING (fake-tested); score source is human item 1 |
| `corpus_feedback` counts | `feedbackCounts` | Real SQL group-by | Yes; PG named pass (reflect-store.test.ts) | ✓ FLOWING |
| Digest text | `buildDigest` | STATE and ROADMAP text from the CLI scan | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

No command was run in this pass. Checks were made by reading the head source, reading the diffs since `a46d42c3`, grepping the source, and matching titles against the gate r38 JUnit XML.

| Behavior | Source | Result | Status |
| -------- | ------ | ------ | ------ |
| Telemetry titles (docs-search.reflect.test.ts) | JUnit file and name match | Each cited title matched; no failure, error or skipped child | ✓ PASS (per title) |
| Citation-commit titles (corpus/citations.test.ts, changed by `885e73ce` and `0947001e`) | JUnit file and name match | Six cited titles matched; no failure, error or skipped child | ✓ PASS (per title) |
| Reflect tables (`reflect-store.test.ts`, PG-gated) | JUnit file match | Seven testcases; none carries a `skipped` child | ✓ PASS |
| Removed helpers | grep of `parseScopedDataset`, `DocsSearchBreaker`, `DocsBreakerState` under `packages/` | No match at head | ✓ PASS |

### Probe Execution

No probe is declared in the phase's SUMMARY or success criteria. Skipped.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/service.ts` | 6458 | Empty question skips the cache (served by `load()` directly) | ℹ️ Info | Intended; the row is written in all cases that reach 6469 |
| `packages/mcp-server/src/service.ts` | 6495-6502 | `recordRetrieval` swallows failures to stderr | ℹ️ Info | Intended fail-open; the recorder counts drops and failures |
| `packages/mcp-server/src/service.ts` | 6607-6616 | `sweepRetrievals` reads the store inside the `try` | ℹ️ Info | Null store returns 0; a throwing store is logged and returns 0. Placement predates `a46d42c3` |
| `packages/mcp-server/src/docs-search.ts` | 526 | `score: chunk.score ?? 0` for every citation | ⚠️ Warning | A missing plane score reads as 0 in the telemetry row, the gap list and the `on` ordering. See owner item 1 |

No TBD, FIXME, XXX, TODO, HACK or PLACEHOLDER marker in the 29 implementation files.

### Human Verification Required

These cannot be checked from the repository. They do not change the status of truths 1 to 4; they keep the phase at `human_needed`.

1. **Live retrieval score field**
   - **Test:** Run a live LightRAG `docs_search` with `SUBSTRATE_DOCS_TELEMETRY=on`. Read the raw reply's score field and the `corpus_retrievals.top_score` value.
   - **Expected:** A `top_score` equal to the plane's own score. A 0 with no score field in the raw reply is the default `cite()` applies (`docs-search.ts:526`), and it is not a score.
   - **Why human:** It needs a live plane. The fixture has no score field, so the test cannot tell a real 0 from the default.

2. **Live digest and Hindsight retain**
   - **Test:** Run `substrate corpus reflect --execute` against a live LightRAG and Hindsight 0.9.1, then run it again.
   - **Expected:** One digest stored; a second run answers `unchanged`; the Hindsight entry is replaced, not duplicated.
   - **Why human:** External services.

3. **Gaps list**
   - **Test:** Run `substrate corpus status --gaps` after a few searches, some with no answer.
   - **Expected:** The unanswered queries are listed, most searched first. Answered queries are not listed, unless their plane score is missing or zero (owner item 1).
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

None. Truths 1 to 5 hold at head `5e304ef8` against the code lines cited and the gate r38 JUnit titles listed above. The changes since `a46d42c3` that touch this phase do not alter the recording path, the verdict path, supersession citations, the re-rank or the digest path. Their effects are recorded under Scope, Truth 2 and Truth 4.

Owner items, open, not decided here:
1. **Score default (new in this run).** `cite()` (`docs-search.ts:526`) sets a citation's score to `0` when the plane supplies none. The telemetry `top_score` is then 0, the gap predicate (`having max(top_score) is null or max(top_score) < gapScore`) lists the query, and the `on` ordering (`score × authority`) cannot move the citation. If the live LightRAG reply carries no score, `corpus status --gaps` lists every answered corpus query, and truth 5 is not met as written; the status would then be `gaps_found`. Decide: (a) a missing score is a gap, as the code does today, or (b) a missing score is excluded from the gap list and from the `on` ordering. The code is unchanged here.
2. Operator-visible change from `f1266a9c`: under `SUBSTRATE_BUDGET_WRITE_BREAKER=fail-closed` or `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed`, enforce mode now refuses a request during the 5 s connect cooldown, where before it was bypassed. Defaults are `fail-open`, so no default behaviour changed.
3. `recordRetrieval` runs after the answer. A `docs_search` that throws before its reply writes no row. SC1 is read as answered searches; the owner may want a row for failed searches.
4. The `sweepRetrievals` try placement has no dedicated title. The behaviour it changes (a throwing `reflectStore()`) is not one of the named sweep tests. The placement predates `a46d42c3`.
5. Owner decisions for phase 66 dated 2026-11-06: none located. The steering-session hash acceptance is carried from the prior record without a date.

Residual risks from the SUMMARY still apply and are not changed by this verification: verdict stacking across session ids; per-process authority and feedback caches; a failed Hindsight digest leg is not retried by a later unchanged run; the shadow report has no read path; the 5000-key feedback bound. The hash of a steering-session question is kept per the owner decision; a short private question can be guessed by hashing, which the owner accepted.

---

_Verified: 2026-11-06T02:58:49Z_
_Verifier: Claude (gsd-verifier, re-verification)_
