---
phase: 66-docs-reflect
verified: 2026-11-06T06:10:11Z
status: human_needed
score: 5/5 must-haves verified
covered_files: [".planning/phases/66-docs-reflect/66-SUMMARY.md","packages/audit/src/policy.ts","packages/cli/src/corpus/index.ts","packages/cli/src/corpus/reflect.test.ts","packages/cli/src/corpus/reflect.ts","packages/corpus/src/authority.test.ts","packages/corpus/src/authority.ts","packages/corpus/src/reflect.test.ts","packages/corpus/src/reflect.ts","packages/corpus/src/supersession.test.ts","packages/corpus/src/supersession.ts","packages/mcp-server/src/admission.ts","packages/mcp-server/src/cache.ts","packages/mcp-server/src/config.ts","packages/mcp-server/src/corpus/authority-index.test.ts","packages/mcp-server/src/corpus/authority-index.ts","packages/mcp-server/src/corpus/citations.test.ts","packages/mcp-server/src/corpus/digest-retain.ts","packages/mcp-server/src/corpus/ingest.ts","packages/mcp-server/src/corpus/rank.test.ts","packages/mcp-server/src/corpus/rank.ts","packages/mcp-server/src/corpus/reflect-routes.test.ts","packages/mcp-server/src/corpus/reflect-service.test.ts","packages/mcp-server/src/corpus/reflect-service.ts","packages/mcp-server/src/corpus/reflect-store.test.ts","packages/mcp-server/src/corpus/reflect-store.ts","packages/mcp-server/src/corpus/root.ts","packages/mcp-server/src/corpus/service.ts","packages/mcp-server/src/corpus/telemetry.test.ts","packages/mcp-server/src/corpus/telemetry.ts","packages/mcp-server/src/docs-search.reflect.test.ts","packages/mcp-server/src/docs-search.ts","packages/mcp-server/src/flag-registry.ts","packages/mcp-server/src/index-store.ts","packages/mcp-server/src/index-sweep.ts","packages/mcp-server/src/mcp.ts","packages/mcp-server/src/memory-retain.ts","packages/mcp-server/src/memory-write.ts","packages/mcp-server/src/planes/hindsight.ts","packages/mcp-server/src/server.ts","packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:153bd2a5c61321b20f943f13345d761729c2d2b8983c36ae3c35074e3c403c4d"
head_refresh: "c37d194a: text-only changes in covered files (packages/cli/src/index.ts emit stderr wording; packages/mcp-server/src/reconcile-run.ts comment; packages/mcp-server/src/flag-registry.ts readBy; docs/config-reference.md regenerated from the registry). covered_digest refreshed from verification.fingerprint; verdict, title list and behaviour unchanged; gate r45 on c37d194a is the run of record for the tests."
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
**Verified:** 2026-11-06T06:10:11Z
**Status:** human_needed
**Re-verification:** Yes. The prior record (66-VERIFICATION.md, recorded at head 5e304ef8, human_needed, 5/5, empty `gaps:`) puts this run in re-verification mode. No gap was open.

## Scope and method

- Head: `df31c749` (integration branch, worktree `/root/src/worktrees/as-gsd-v18-all`). The record head is `5e304ef8`, an ancestor of head (`git merge-base --is-ancestor` confirmed). Thirteen commits lie between them: `cebd76df` (records at 5e304ef8), `b577f5be` (ROADMAP status), `e2e4cba4` (skills propose), `4ac770af` (substrate emit stderr line), `4637a9b7` and `700d9b5c` (docs), `0556dfd3` (cache SCAN bound), `6245863c` (config buffer and dead-letter guard), `fd4a305f` (corpus tombstone scope under the ingest lock), `d928e995` (reconcile), `3ce87f63` (brief memory grants and rotated-signer pointers), `7f6338c2` (host worktree roots), `df31c749` (dispatcher test). Each one is classified below. The phase's named commits `8ec01492` (every docs_search is recorded, including an empty question) and `75d2ce56` (steering-session docs_search keeps its row, query text dropped, hash kept) are still ancestors of head.
- No PLAN.md exists for this phase. Must-haves are the ROADMAP phase 66 success criteria 1 to 5. REQUIREMENTS.md REFLECT-01 to REFLECT-05 map to them. `git diff 5e304ef8 HEAD -- .planning/ROADMAP.md` changes only the status lines and criteria of phases 67, 71, 77 and 78; the phase 66 section is unchanged, so the must-haves stand.
- Diff check, `git diff --name-only 5e304ef8 HEAD` against `covered_files`. Of the 35 files the prior record covered, three changed: `cache.ts`, `config.ts`, `service.ts`. None of the nine phase 66 test files changed. Every hunk in the three was read against the criteria (see the change list below). Six files are added to `covered_files` by this run because this run cites them. Three were cited by the prior record but were not in its list (`packages/cli/src/corpus/reflect.test.ts`, `packages/corpus/src/reflect.test.ts`, `packages/mcp-server/src/corpus/citations.test.ts`); three are new in this run (`packages/mcp-server/src/corpus/ingest.ts` and `corpus/service.ts`, both changed by `fd4a305f`, and `packages/mcp-server/src/corpus/root.ts`, read for the ingest write bracket).
- Change list since 5e304ef8, each classified against the phase 66 criteria:
  - `0556dfd3` `cache.ts` (`scanKeys`, lines 1087 to 1105): a SCAN walk also stops after `MAX_SCAN_ROUNDS` (200) rounds and reports `truncated`. Callers are `reconcile-run.ts` (87, 89) and `reconcile-repair.ts` (129, 270). None is on a docs or corpus-reflect path. No truth is affected. The file moves in the digest. `cache.ts` lines after 256 move by +2.
  - `6245863c` `config.ts` (`loadEventBufferSettings` at 2615; new helpers `destinationOf` and `linkTargetOf` at 2638 to 2651): the buffer and dead-letter guard compares real destinations. The only caller is `loadEventBufferSettings`. `loadDocsReflectSettings` (1604 to 1610) and `breakerPolicyOf` (1930 to 1936) are unchanged in body. `config.ts` lines after 8 move by +1, and every line number in this record that cites `config.ts` is remapped.
  - `fd4a305f` `corpus/service.ts` (`corpusIngestReply` at 221; `withCorpusLock` and `runIngest` at 244 to 253) and `corpus/ingest.ts` (`withCorpusLock` at 56, `ingestCorpus` at 466, `runIngest` exported at 474, body unchanged): the tombstone scope check runs under the ingest lock. Read against the reflect path (see Truth 5). Not on any other truth path.
  - `d928e995` `reconcile-repair.ts`, `reconcile-read.ts` (and their tests): a truncated graph list refuses repair; replay events are excluded from the ledger memory read. Not on a phase 66 path.
  - `3ce87f63` `service.ts`: three hunks in the anchor path (`namedBySignerSet` at 854, `judgePointer` at 893 and 901, `readPointerChecks` at 922; callers at 967, 8488 and 8859, all graph anchor verification) and one brief hunk (`composeBriefSections` call at 2595 now receives `this.briefIndex(request.surface)`; `briefIndex` at 6940 to 6947). The brief path reads `briefIndex` and nothing else on the phase 66 paths: `grep` finds `briefIndex(` at 2595 and 6940 only, and `composeBriefSections(` is called from the brief composer. No docs or corpus criterion reads a brief, a grant filter or a signer pointer. Checked against Truths 1 to 5.
  - `7f6338c2` host files (`packages/host/*`) and `df31c749` (`packages/dispatcher/tests/test_worktree.py`): outside every phase 66 path.
  - `4ac770af` `cli/src/index.ts` (emit stderr line): the top-level emit command, not `cli/src/corpus/*`. `e2e4cba4` `skills/propose.ts` (and its test): outside. `b577f5be`, `4637a9b7`, `700d9b5c`, `cebd76df`: docs only; no phase 66 criterion depends on them.
  - Line shift in `service.ts`: every line after 2580 moved by +15 (hunks at 850 to 919 add 15 lines above 2580). Every `service.ts` citation below is remapped to head. The phase 66 functions (`searchDocs` 6346 through `sweepRetrievals` 6631) are not in any hunk of this window. `manifestCommit` (now at 6436, commit `0947001e`) changed before the prior record; it was read then and is not in this window's diff.
- Test files changed in the window and not in `covered_files` (`cache.test.ts`, `config.test.ts`, `reconcile-read.test.ts`, `reconcile-repair.test.ts`, `repo-scope.boundary.test.ts`, `service.test.ts`, `skills/propose.test.ts`, host `tasks.test.ts`) are not phase 66 test files and are not cited as evidence here.
- Fingerprint: `covered_files` (41 entries) and `covered_digest` are the verbatim output of `gsd_run query verification.fingerprint .planning/phases/66-docs-reflect` at df31c749, run from the worktree with the 35 prior entries plus the six added above. The prior digest was `v3:sha256:2e509432920afe5a5ec80b0ffd7d5f7aa2cdc4b69b66da685a2ae442a2e23b54`. The change is expected: `cache.ts`, `config.ts` and `service.ts` changed, and six files were added.
- Gate evidence: the gate run of record for this head is `/root/src/worktrees/backups/gate-r43-junit.xml`. It passes (12,332 pass, 0 fail, 2 skip), and it is the run of record for it here. For the titles below, the code is unchanged since 5e304ef8, so the earlier run named in the prior record is cited: `/root/src/worktrees/backups/gate-r38-junit.xml` (run on `66fa97bd`). Its single failure is `scripts/code-ratchet.test.ts` "the ratchet is tight: no source counter sits below its baseline", which 5e304ef8 addresses. The two skipped testcases are `packages/mcp-server/src/redact.test.ts:815` and `packages/mcp-server/src/cache-conformance.test.ts:120`; neither is a phase 66 title.
- Test titles this run: 29 (file, title) pairs cited in this record were grepped in their named test files at df31c749; all 29 are present. The same titles were matched by exact name to r38 JUnit testcases with no `failure`, `error` or `skipped` child.
- Owner decisions: the six owner decisions dated 2026-11-06 contain no phase 66 item. No owner decision is recorded here on the owner's behalf. The steering-session hash acceptance carried from the prior record is not one of those six, so it is not treated as decided; it stays open (owner item 5).
- Debt-marker scan (TBD, FIXME, XXX, TODO, HACK, PLACEHOLDER) of the six changed implementation files in this window (`cache.ts`, `config.ts`, `service.ts`, `corpus/service.ts`, `corpus/ingest.ts`, `corpus/root.ts`): no match.
- No test, tsc, lint, formatter, gate or verification writer was run. Only read-only git, file reads, grep, `gsd_run query verification.fingerprint` and a read of the r38 JUnit XML were used. No file under the worktree or `/root/src/repos` was written. The only write is this draft.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | With `SUBSTRATE_DOCS_TELEMETRY=on` every `docs_search` appends a bounded, redacted row (query hash, capped redacted text, up to ten keys with scores, backend, surface) to `corpus_retrievals`, with retention | ✓ VERIFIED (answered searches; a search that throws writes no row) | Path unchanged in the window. MCP `docs_search` at `mcp.ts:1597` and REST at `server.ts:1652` (`auditedRest`) → `:1668` `substrate.searchDocs`. `service.ts` `searchDocs` (6346) → `searchDocsMeasured` (6366) → `searchDocsUnmeasured` (6393). The row is written at 6484, `recordRetrieval(surface, originalQuestion, chunks, reflected.shadow, prepared !== undefined)`, after `load()` or `cached()` (6473) and `reflectAnswer` (call at 6475). An empty question reaches 6484 through `load()` (6473). `recordRetrieval` (6510) checks `config.docsReflect.telemetry` (6511, set from `config.ts:1607`, on only). `corpus/telemetry.ts` `retrievalRowOf` (86): `queryHash` (91), `queryText` null when `isPrivate` (92), `returnedOf` (67, at most ten, key from `corpusKeyOf` or `source_url`), `topScore` from the finite citation scores. Retention: `sweepExpiredRetrievals` (208), `startRetrievalSweep` (6604), `sweepRetrievals` (6622 to 6631). Changed hunk on this path in the earlier window: `manifestCommit` (6436, `0947001e`). It changes a citation's `commit` and `source_url` only. Row keys come from `corpusKeyOf` (`rank.ts:54`, dataset and title only), so the row is unaffected. The window's changes to `service.ts` (6346 to 6631 untouched) and to `config.ts` (the telemetry flag line is unchanged) do not alter the row path. Named passes: "one search appends exactly one row: the query hash, the redacted capped text, at most ten returned keys with scores, the backend and the surface" (docs-search.reflect.test.ts); "a steering-session search writes exactly one row: no query text, only the hash of the question" (docs-search.reflect.test.ts); "an empty question writes one row with no text and the hash of the empty string" (docs-search.reflect.test.ts); "a question holding a credential keeps no text at all, only its hash" (docs-search.reflect.test.ts); "retention drains every expired batch in one pass, and only rows older than the retention window" (docs-search.reflect.test.ts); "a retention sweep against a store that fails deletes nothing and does not throw" (docs-search.reflect.test.ts); "with the flag off nothing is written, counted or swept" (docs-search.reflect.test.ts). Qualification: `recordRetrieval` runs after the answer is built, so a search that throws before its reply writes no row. The recorder is fail-open. The SC1 wording "every `docs_search`" is read here as every answered search. Not a gap. |
| 2 | `docs_feedback` (MCP tool and REST route) records helpful, unhelpful, stale, wrong or duplicate per document key, audited, admission-limited, idempotent per session and document | ✓ VERIFIED (default admission policy) | Path unchanged in the window. MCP tool `mcp.ts:1749`, handler `mcp.ts:1767` → `Substrate.docsFeedback` (`service.ts:6579`, invalidates the authority feedback cache) → `docsFeedbackReply` (`reflect-service.ts:163`) → `upsertFeedback` (`reflect-store.ts:126`). REST `POST /docs/feedback` at `server.ts:1829`, audited under `docs_feedback` at 1837; the note is excluded from the audit fields (comment 1835, fields 1836). `admission.ts:254` `docs_feedback: "write"`; `audit/src/policy.ts:134` fail-open. Changes checked: `policy.ts` and `admission.ts` unchanged in the window. `cache.ts` (`f1266a9c`, earlier): a cooldown refusal carries `breakerRetryAfterMs`, and `admission.ts:386` acts on it only when the class's breaker policy is `fail-closed` in enforce mode. The default for every class is `fail-open` (`config.ts` `breakerPolicyOf`, 1930 to 1936; the empty value returns `fail-open` at 1932), so default behaviour is unchanged. The window's `cache.ts` change (`0556dfd3`, `scanKeys`) is not on this path. Under an operator opt-in (`SUBSTRATE_BUDGET_WRITE_BREAKER=fail-closed`) a `docs_feedback` during the 5 s connect cooldown is refused, where before it was bypassed. Recorded as an operator-visible change, not a gap. Named passes: "the audit record is written under docs_feedback with the document and the verdict, never the note" (reflect-routes.test.ts); "it is registered, a write in admission, and fail-open in the audit policy" (reflect-routes.test.ts); "one verdict per session and document: a repeat replaces it, another session adds one" (reflect-service.test.ts); "feedback is one verdict per document and session, the latest wins, and the counts are grouped per document" (reflect-store.test.ts). |
| 3 | `scoreDocument` is pure and tested. `SUBSTRATE_DOCS_RERANK=shadow` records the would-be change, `on` applies it, `off` is the default | ✓ VERIFIED | Unchanged path. `corpus/src/authority.ts:114` `scoreDocument` is pure (file not changed in the window). `config.ts` `loadDocsReflectSettings` (1604 to 1610) reads `shadow` or `on`, otherwise `off` (rerank line 1609). `service.ts` `reflectAnswer` (6494) returns the reply untouched when `mode === "off"`, when degraded, or when no citation has a corpus key (6496). `corpus/rank.ts:80` `reflectCitations` returns the chunks unchanged for `off` (81), returns a shadow note for `shadow`, and annotates and re-sorts for `on` (88). Changes checked: `rank.ts`, `authority.ts` unchanged in the window; `config.ts` change (`6245863c`) is outside `loadDocsReflectSettings`; `service.ts` change (`3ce87f63`) is outside 6346 to 6631. The score sort that `on` relies on (`docs-search.ts:1153`) is unchanged. Named passes: "off, and a flag left unset, answer byte for byte what a service with none of the new flags answers" (docs-search.reflect.test.ts); "shadow answers byte for byte what off answers, and records on the telemetry row what on would have changed" (docs-search.reflect.test.ts); "off returns the very citations it was given and never consults the lookup" (rank.test.ts); "on re-orders by score times authority, annotates each corpus citation and reports the positions moved" (rank.test.ts); "on re-orders the corpus citations by score times (0.5 + 0.5 * authority), keeps every other citation in place, and says what it did" (docs-search.reflect.test.ts); "on keeps the plane's order between documents of equal authority and equal score, and reports no moved position" (docs-search.reflect.test.ts); "more helpful feedback never lowers the score and, next to a negative, strictly raises it" (authority.test.ts). The `on` ordering is `score × authority`. A citation without a plane score carries score 0 (see Truth 5 and owner item 1), so `on` cannot reorder such citations. |
| 4 | A document that a newer version, an archive or an explicit marker supersedes is flagged; citations carry `stale` and `superseded_by` | ✓ VERIFIED | Unchanged path. `corpus/src/supersession.ts:150` `detectSupersession` (unchanged in the window): marker, live plus milestone archive, and two `local/*` copies with different content. `corpus/rank.ts:88` sets `stale` and `superseded_by` on corpus citations, in `on` mode only; `corpusKeyOf` (54) returns null for any dataset other than the corpus, so RAGFlow answers are not annotated. Citation fields: `docs-search.ts:109` (`stale`) and `:111` (`superseded_by`). `withCorpusProvenance` (`docs-search.ts:583-594`) spreads `...citation` before it sets `title`, `source_url`, `commit` and `dataset`, so both fields survive. The `0947001e` change alters `commit` and `source_url` only. Named passes: "on drops a superseded document below the document that replaced it, and its citation carries stale and superseded_by" (docs-search.reflect.test.ts); "a superseded document drops below the document that replaces it, and its citation names the replacement" (rank.test.ts); "a superseded document scores strictly lower than the same document not superseded" (authority.test.ts); "an archived file under a milestone directory is superseded by the live file with the same remainder" (supersession.test.ts); "flags a document whose marker names an existing row of the same repository" (supersession.test.ts); "the older copy is superseded by the newer one when the two differ" (supersession.test.ts). |
| 5 | `substrate corpus reflect` writes one digest per repository into the docs plane and retains it in Hindsight with `document_id` replace; `corpus status --gaps` lists the queries that returned nothing useful | ✓ VERIFIED (against fakes; live plane not observed). Gap list correctness depends on the plane's score field: owner item 1 | Digest path unchanged. `corpus/src/reflect.ts:151` `buildDigest` is deterministic (unchanged in the window). CLI `cli/src/corpus/reflect.ts` unchanged. `POST /corpus/reflect` (`server.ts:1842`) → `Substrate.corpusReflect` (`service.ts:6586`, bumps the docs generation after a stored digest) → `corpusReflectReply` (`reflect-service.ts:233`) → the digest documents are stored through `ingestCorpus` (`reflect-service.ts:251`, `ingest.ts:466`, under `ingestLock`, `ingest.ts:50`, `withCorpusLock` at 56) → `retainDigest` (`service.ts:6545`, split by `splitDigestRetain`) → `retainDigestOutcome` (`corpus/digest-retain.ts:128`, subject prefix `corpus-digest:` at 19) → `writeMemoryWithLeg`. `planes/hindsight.ts:557` sends `update_mode: "replace"` (unchanged). Changes checked on this path: `memory-write.ts` (`e62bc17b`, earlier) two silent catches, same return values; `memory-retain.ts` and `index-sweep.ts` (`a2176f96`, earlier), type-only narrowing, same `document_id`. Window change `fd4a305f` (see the fd4a305f note below). Gaps: `GET /corpus/gaps` (`server.ts:1854`) → `corpusGaps` (`service.ts:6596`) → `corpusGapsReply` (`reflect-service.ts:333`) → the gap aggregate (`reflect-store.ts` 160-170): `where … and not degraded`, grouped by `query_hash`, `having max(top_score) is null or max(top_score) < gapScore`. `top_score` is `max` of the citation scores, and `cite()` (`docs-search.ts:526`, used by the LightRAG corpus path at 1152) sets a missing plane score to `0`. So an answered corpus query whose plane returns no score is stored with `top_score` 0 and listed as a gap, and `on` mode scores it 0 too. Whether the live LightRAG reply carries a score is not observed (human item 1). Named passes: "a query is a gap when its best score over the 30 days is below the gap score; degraded searches and older searches do not count" (reflect-routes.test.ts); "the gap aggregate lists a query whose best score was none or low, leaves out answered, degraded and old searches, and orders by searches" (reflect-store.test.ts); "contains no time: the last_updated stamp and a changed one leave the digest byte-identical" (packages/corpus/src/reflect.test.ts); "writes the fixed sections in order with the position, decisions newest first, open items and project" (packages/corpus/src/reflect.test.ts); "sends repo, text and sha256 only and counts each answer" (packages/cli/src/corpus/reflect.test.ts). The last two files are cited, not in the prior `covered_files`; they are added now.

  **fd4a305f on the reflect path.** `corpusReflectReply` does not call `corpusIngestReply`, and nothing in the reflect path takes `withCorpusLock` itself. It calls `ingestCorpus` (`ingest.ts:466`), which runs `runIngest` under `ingestLock`. `withCorpusLock` is `ingestLock.run` (`ingest.ts:56` to 57), so the corpus service's new hold (`corpus/service.ts:244`) and the reflect path's hold are the same single-flight lock and are never nested. The reflect path is entered from `service.ts` `corpusReflect` (6586) and not from inside a lock. `runIngest` is exported (474) and its body is unchanged. Reflect requests carry `tombstones: []`, so the tombstone scope check that moved under the lock does not run on this path. Observed effect, not a truth: on a refused out-of-scope tombstone, `corpusIngestReply` now calls `roots.writeStarted()` before the scope check and `writeSettled(false)` after it (`root.ts:272` to 284). Previously the refusal returned before the bracket. The effect is two generation bumps and an emptied root cache for the refusal's duration, with no root event owed (`changed` is false). No truth reads that generation. Recorded under residuals. |

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
| `packages/mcp-server/src/corpus/telemetry.ts` | Row builder, recorder, sweep | ✓ VERIFIED | Unchanged in the window. `retrievalRowOf` 86, `returnedOf` 67, `sweepExpiredRetrievals` 208, `RETRIEVAL_SWEEP_INTERVAL_MS` 33 |
| `packages/mcp-server/src/corpus/reflect-store.ts` | Bun SQL adapter for tables from step 38 | ✓ VERIFIED | `upsertFeedback` 126; gap aggregate 160-170 (`group by query_hash` at 166); unchanged in the window |
| `packages/mcp-server/src/index-store.ts` | Migration step 38 `corpus_reflect` | ✓ VERIFIED | Step name at 802, down migration at 804, `corpus_retrievals` create at 807; unchanged in the window in its phase 66 lines |
| `packages/corpus/src/authority.ts` | Pure `scoreDocument` | ✓ VERIFIED | Pure (114); unchanged in the window |
| `packages/corpus/src/supersession.ts` | `detectSupersession` | ✓ VERIFIED | Pure (150); unchanged in the window |
| `packages/corpus/src/reflect.ts` | `buildDigest` | ✓ VERIFIED | Deterministic (151); unchanged in the window |
| `packages/mcp-server/src/corpus/reflect-service.ts` | Feedback, reflect and gaps replies | ✓ VERIFIED | `docsFeedbackReply` 163, `corpusReflectReply` 233 (ingest call 251), `corpusGapsReply` 333; unchanged in the window |
| `packages/mcp-server/src/docs-search.ts` | Citation build, carries `stale`/`superseded_by` | ✓ VERIFIED | Unchanged in this window; changed earlier by `0947001e` (citation commit rule, `citableCommit` 601) and `e62bc17b` (`reportSilent` in the tandem leg). `stale` 109 and `superseded_by` 111 intact; `withCorpusProvenance` 583 spreads `...citation`; score sort 1153. Covered since the prior run |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` `searchDocsUnmeasured` | `recordRetrieval` | unconditional call at 6484, `isPrivate = prepared !== undefined` | ✓ WIRED | Steering-session `docs_search` writes one row with text null; a blank question writes one row. A throw before 6484 writes none |
| `service.ts` `recordRetrieval` | `RetrievalRecorder.record` → `appendRetrieval` | `retrievalRecorder` (1941), call at 6513 | ✓ WIRED | Fail-open, budgeted |
| `mcp.ts` `docs_feedback` | `docsFeedback` → `docsFeedbackReply` → `upsertFeedback` | `substrate.docsFeedback` | ✓ WIRED | Invalidates authority feedback cache |
| `server.ts` `/corpus/reflect` | `corpusReflectReply` → `retainDigest` | `substrate.corpusReflect` | ✓ WIRED | Retain through governed write |
| `corpusReflectReply` | `ingestCorpus` | `reflect-service.ts:251`, same `ingestLock` as `withCorpusLock` | ✓ WIRED | Not nested under any other hold; `fd4a305f` does not change this edge |
| `rank.ts` `reflectCitations` | `service.ts` `reflectAnswer` | `authorityIndex.lookup` | ✓ WIRED | Runs after the docs cache |
| `docs-search.ts` `manifestCommits` | `withCorpusProvenance` | `manifestCommit` dep (352), wired at `service.ts:6436` | ✓ WIRED | ATLAS-03 citation commit; not a phase 66 truth; no effect on rows, reranking or supersession |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `corpus_retrievals` row | `queryHash`, `queryText`, `topScore`, `returned` | `queryHash` from the normalised question; `queryText` null for steering-session calls; scores from the SearchReply chunks, a missing plane score becomes 0 | Yes for hash, text and keys. `topScore` is real only when the plane returns a score; live LightRAG score field not observed | ✓ FLOWING (fake-tested); score source is human item 1 |
| `corpus_feedback` counts | `feedbackCounts` | Real SQL group-by | Yes; PG named pass (reflect-store.test.ts) | ✓ FLOWING |
| Digest text | `buildDigest` | STATE and ROADMAP text from the CLI scan | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

No command was run in this pass. Checks were made by reading the head source, reading the diffs since `5e304ef8`, grepping the source, grepping the cited test titles in their named files, and matching the titles to the gate r38 JUnit XML.

| Behavior | Source | Result | Status |
| -------- | ------ | ------ | ------ |
| Cited test titles, all 29 (file, title) pairs | grep of each title in its named test file at df31c749 | 29 of 29 present | ✓ PASS (per title) |
| Cited test titles against gate r38 JUnit | exact name match, testcase without `failure`, `error` or `skipped` child | matched (r38 is the earlier run named in the prior record; code unchanged since 5e304ef8) | ✓ PASS (per title) |
| Telemetry titles (docs-search.reflect.test.ts) | JUnit file and name match | Each cited title matched; no failure, error or skipped child | ✓ PASS (per title) |
| Citation-commit titles (corpus/citations.test.ts, changed by `885e73ce` and `0947001e`) | JUnit file and name match | Six titles matched in the prior run; not re-listed here | ✓ PASS (per title, prior run) |
| Reflect tables (`reflect-store.test.ts`, PG-gated) | JUnit file match | Seven testcases; none carries a `skipped` child | ✓ PASS |
| Removed helpers | grep of `parseScopedDataset`, `DocsSearchBreaker`, `DocsBreakerState` under `packages/` | No match at head | ✓ PASS |
| Brief and anchor changes off the docs path | grep of `briefIndex(`, `judgePointer(`, `readPointerChecks(`, `judgeSigner(` | `briefIndex(` at 2595 and 6940 only; pointer judges at 967, 8488, 8859 (graph anchors) | ✓ PASS (no phase 66 caller) |
| Ingest lock is single-flight, not nested | grep of `withCorpusLock`, `ingestLock`, `ingestCorpus(`, `runIngest(` | `withCorpusLock` = `ingestLock.run` (ingest.ts 56 to 57); callers corpus/service.ts 244, reconcile.ts 207 and ingest.ts 467 (`ingestCorpus`) | ✓ PASS |

### Probe Execution

No probe is declared in the phase's SUMMARY or success criteria. Skipped.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/service.ts` | 6473 | Empty question skips the cache (served by `load()` directly) | ℹ️ Info | Intended; the row is written in all cases that reach 6484 |
| `packages/mcp-server/src/service.ts` | 6510 to 6517 | `recordRetrieval` swallows failures to stderr (6515) | ℹ️ Info | Intended fail-open; the recorder counts drops and failures |
| `packages/mcp-server/src/service.ts` | 6622 to 6631 | `sweepRetrievals` reads the store inside the `try` | ℹ️ Info | Null store returns 0; a throwing store is logged and returns 0. Placement predates `a46d42c3` |
| `packages/mcp-server/src/docs-search.ts` | 526 | `score: chunk.score ?? 0` for every citation | ⚠️ Warning | A missing plane score reads as 0 in the telemetry row, the gap list and the `on` ordering. See owner item 1 |

No TBD, FIXME, XXX, TODO, HACK or PLACEHOLDER marker in the changed implementation files of this window.

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

None. Truths 1 to 5 hold at head `df31c749` against the code lines cited and the test titles listed above. The changes since `5e304ef8` that touch this phase do not alter the recording path, the verdict path, supersession citations, the re-rank or the digest path. Their effects are recorded under Scope, Truth 2, Truth 5 (fd4a305f) and Residual risks.

Owner items, open, not decided here:
1. **Score default.** `cite()` (`docs-search.ts:526`) sets a citation's score to `0` when the plane supplies none. The telemetry `top_score` is then 0, the gap predicate (`having max(top_score) is null or max(top_score) < gapScore`) lists the query, and the `on` ordering (`score × authority`) cannot move the citation. If the live LightRAG reply carries no score, `corpus status --gaps` lists every answered corpus query, and truth 5 is not met as written; the status would then be `gaps_found`. Decide: (a) a missing score is a gap, as the code does today, or (b) a missing score is excluded from the gap list and from the `on` ordering. The code is unchanged here. No owner decision dated 2026-11-06 covers it.
2. Operator-visible change from `f1266a9c`: under `SUBSTRATE_BUDGET_WRITE_BREAKER=fail-closed` or `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed`, enforce mode now refuses a request during the 5 s connect cooldown, where before it was bypassed. Defaults are `fail-open`, so no default behaviour changed. Recorded as an operator-visible change, not an owner decision.
3. `recordRetrieval` runs after the answer. A `docs_search` that throws before its reply writes no row. SC1 is read as answered searches; the owner may want a row for failed searches.
4. The `sweepRetrievals` try placement has no dedicated title. The behaviour it changes (a throwing `reflectStore()`) is not one of the named sweep tests. The placement predates `a46d42c3`.
5. Owner decisions for phase 66 dated 2026-11-06: none. The six owner decisions of that date contain no phase 66 item. The steering-session hash acceptance carried from the prior record is not among them and is not treated as decided; it stays open.

Residual risks from the SUMMARY still apply and are not changed by this verification: verdict stacking across session ids; per-process authority and feedback caches; a failed Hindsight digest leg is not retried by a later unchanged run; the shadow report has no read path; the 5000-key feedback bound. The hash of a steering-session question is kept by the implementation (`75d2ce56`); a short private question can be guessed by hashing. That property is an open owner item (5), not an accepted one.

Residuals added by this run (not gaps):
- `fd4a305f`: a refused out-of-scope tombstone now opens and settles the root write bracket (`writeStarted`, `writeSettled(false)`, `root.ts:272` to 284) before it returns. The root cache is emptied and the generation advances twice for that request. No root event is owed, and no phase 66 truth reads the generation.
- `0556dfd3`: the SCAN walk stops after 200 rounds and reports `truncated`. Callers are reconcile only. No phase 66 effect.

---

_Verified: 2026-11-06T06:10:11Z_
_Verifier: Claude (gsd-verifier, re-verification)_
