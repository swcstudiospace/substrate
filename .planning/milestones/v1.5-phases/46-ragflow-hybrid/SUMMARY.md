---
phase: 46-ragflow (retired)-hybrid
requirements: [SOTA-02]
status: in review (draft PR). In-repo gates green. The live RAGFlow (retired) behaviour is unattested and not exercised
---

# 46-SUMMARY: RAGFlow (retired) hybrid retrieval with Hindsight and Greptime context

## Built

- **Hybrid knobs (U1).** `SUBSTRATE_RAGFLOW (retired)_VECTOR_WEIGHT` (0 to 1, default 0.3) sets the vector share of RAGFlow (retired)'s blend. `SUBSTRATE_RAGFLOW (retired)_RERANK_ID` names a reranker, and unset it sends no `rerank_id`, so the default request is unchanged. A non-numeric or out-of-range RAGFlow (retired) weight is a `ConfigError` that names the variable.
- **Context on `docs_search` (U2).** An optional `context` boolean, default false. With it set, the reply gains `context`: up to 3 Hindsight recall hits for the question (text cut to 400 characters), and up to 5 of the newest ledger rows for the caller's `session_id` (summary cut to 200 characters). The context carries the same untrusted notice as the chunks. Missing sources set `degraded` with a reason: `no-session`, `ledger-not-configured`, `ledger: <message>`, or a recall reason.
- **REST parity.** `POST /docs/search` accepts `context` as a boolean and rejects other types with a 400, as it already does for `datasets` and `session_id`.
- **Cache rule.** Context is attached after the cache, so the cache holds only chunk answers. `searchReplyStorable` refuses any reply with a `context` key, so a session's events are never served to another caller.
- **Docs (U3).** `docs/docs-search-ingest.md` gains a section on hybrid retrieval and context, and the reference table lists `context?`. `docs/docs-plane.md` gets one pointer paragraph. `docs/config-reference.md` is regenerated and checked.

## Decisions

- D46-a to D46-i in CONTEXT.md. Hybrid is RAGFlow (retired)'s own blend, tuned by the weight. Reranking is opt-in. Context is opt-in per call, never cached, and carries untrusted text only.

## Deviations (from the plan, with reasons)

- **Weight precedence.** `SUBSTRATE_DOCS_VECTOR_WEIGHT` already exists, is documented, and is pinned by a test. It keeps precedence, then `SUBSTRATE_RAGFLOW (retired)_VECTOR_WEIGHT`, then 0.3. A blank value counts as unset for both. The plan did not foresee the existing variable.
- **Validation asymmetry.** `SUBSTRATE_DOCS_VECTOR_WEIGHT` keeps its silent fallback (a test pins it). Only the new RAGFlow (retired) variable throws. The docs state both behaviours.
- **Redaction before the cut.** Memory text and event summaries are redacted before they are cut, not only cut. The plan asked only for the cut.
- **Recall path.** Recall uses the service's `recallUncounted`, so the memory cache and the `vm-guest` refusal apply. The plan named `planes/memory-recall.ts`, but the module lives at `src/memory-recall.ts` and is reached through that service path.
- **Timing of the reply.** The chunks are finished before any context leg starts, and the cache stores chunks only. The reply itself does wait for the context legs, bounded by the recall budget (`HINDSIGHT_SEARCH_RECALL_BUDGET_MS`, default 1500 ms) and the 1000 ms ledger budget. The earlier wording "never delays chunks" was too strong; D46-f is corrected to match.
- **Ledger read has no LIMIT.** `GreptimeClient.readEvents` returns the whole session. The 1000 ms budget is the only bound on the read, and the docs say so.
- **REST route added.** The plan did not list `server.ts`. Without it the REST surface would silently drop `context`.

## Verified in-repo

- Typecheck: `bunx tsc --noEmit` exit 0.
- Config reference: regenerated; `bun run config:reference -- --check` up to date.
- Full suite: `bun test` 5905 pass, 2 skip (pre-existing), 0 fail, over 5907 tests in 219 files (the merged tree with main, after the review round).
- Repo locks: `bun run check:phase-close` green.
- Targeted: `docs-search.test.ts`, `server.test.ts` and `planes/ragflow (retired).test.ts` 135 pass, including the context tests, the ledger-timeout test, the anonymous and reason tests, the deadline test, the session-id normalization test, and the REST route tests.

## Not done and open items

- **Live RAGFlow (retired).** The deployed version is unattested (`ragflow (retired).ts` comment). Whether the weight and the reranker id are accepted by the deployment is not proven.
- **Pre-existing doc mismatch, not changed here (D46-i).** `docs-plane.md` describes `query` and `limit` arguments for `docs_search`, while the input schema uses `question`, `datasets`, `session_id` and `context`. Correcting it is a separate docs change.
- **Hindsight relevance.** The context proves the plumbing and the caps, not that the recalled memories help the answer.

## Review round (PR 98)

- **Anonymous callers.** A null caller gets `memories: []` and a degraded reason, with no recall call. The docs context refuses every anonymous caller. `memory_recall` refuses only when no banks are configured, so this is stricter than it when banks are configured. That is a deliberate choice: anonymous docs answers do not carry personal memory.
- **Missing sources are visible.** Any recall reason, including 'hindsight is not configured', is carried into `context.degraded`.
- **One deadline.** A single timer, unref'd and cleared in `finally`, races the whole recall call against the search recall budget, so cache reads and writes count against it.
- **Session id.** The ledger read uses the same normalization the writes use, so an id changed by redaction or the 512-character cap still finds its events.
- **REST tests.** The REST route has tests for context true, false or absent, and for a string or null value, which return 400 without any recall or ledger call.

## Cleanup

- The worktree `/root/pr-fix/v146-rag` stays until close-out, with the other phase worktrees, after the user approves cleanup.
