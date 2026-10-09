# 25-04 Summary: docs doors (Substrate methods, REST routes, MCP tools, registration)

**Wave:** 3 · **Plans:** DOCS-01/DOCS-02 seam — three doors per tool · **Live proof:** EXPLICITLY NOT RUN (no network calls; see §5)

## 1. What was built

- **Task 1 — `Substrate.docsSearch`/`docsIngest`** (`service.ts` + test): both methods call the injected `RagflowClient` through a new `DocsClient` (`DocsRagflow & SearchRagflow`) seam; the constructor takes an optional `ragflow` store override and otherwise builds from `config.ragflow` (null/problem/missing-key → null, answering `not-configured`). `docsSearch`: anonymous → `unauthenticated` with no client call and no event; every authenticated search emits exactly one event — note (`docs.search` + `dataset_ids`/deduped `urls`/`count`) or warning (`docs.search` + `reason`) — both matching the Phase 17 rows, fail-open emit, query text never in the event (at most `query_sha256`/`query_len`). `docsIngest`: writer rule on the token's surface only (anonymous 401, non-substrate/non-operator 403 with the D25-07 message, event surface never from the body); `finalize: true` bodies cut a version via `finalize()`; `dry_run` reports with zero RAGFlow calls, zero manifest writes, no event; D25-13 mapping (200/400/401/403/502 redacted-200-char/503); every other attributable outcome emits one fail-open event. `service.test.ts`: 13 new cases with a fake client (success/failure events, anonymous short-circuit, writer matrix, dry_run freedom, secret refusal, 502 cap, 503, malformed, finalize).
- **Task 2 — REST routes** (`server.ts` + test): `POST /docs/search` (always 200, audited as `docs_search` fail-open) and `POST /docs/ingest` (401 anonymous before the body is read — even an oversize body 401s first — audited as `docs_ingest` fail-closed → 503, then the D25-13 matrix from the service). Both paths added to `KNOWN_ROUTES`; the typed 413 stays ingest-scoped (`/skills/propose` + `/docs/ingest`). `server.test.ts`: `serve()` gained a `ragflow` injection (existing calls unaffected; `ledger`/`serve` hoisted to module level), 10 new route tests: tokened search 200, anonymous search 200-`unauthenticated` with zero fake calls, anonymous 401 pre-body, agent 403, substrate 200-uploaded, 413 shape, 400 refusal pair, 502 capped message, 503 not-configured, and unwritable-audit 503-ingest with search still 200.
- **Task 3 — MCP tools** (`mcp.ts` + test): `docs_search` (D25-02 JSON as text, never `isError`; `readOnlyHint:true, openWorldHint:true`) and `docs_ingest` (same JSON, `isError` on every non-200; `destructiveHint:false, openWorldHint:true`), both via `registerTool` delegating to the Task 1 methods with the caller's surface; refusals mirror the route semantics with the D25-07 message. Both names added to `KNOWN_TOOLS` (MCP section; REST audit names are covered by the same entries per the file's convention). `mcp.test.ts`: `connect()` gained `ragflow`+`env` params; 4 new tests (live annotation assertions, search text-shape, anonymous no-`isError`, ingest `isError` matrix + writer upload).
- **Task 4 — registration/audit/event tests** (new `docs-doors.test.ts`, 8 tests): `registerTool` presence, `toolLabel`, `auditedRest`-under-own-name source pins + `KNOWN_ROUTES` membership, explicit fail-open/fail-closed modes, live annotation check, and per-search success/failure events asserted kind+action against `EVENT_SOURCES`. Phase 17 scan guard + policy tests pass unmodified.

## 2. Must-haves, observable

- D25-05: `bun test …/service.test.ts -t "docsSearch"` — one note / one warning, `query_sha256`+`query_len` only, fail-open emit proven by a throwing ledger.
- D25-06: anonymous search `results:[]` + `unauthenticated`, `fake.totalCalls() === 0` (service + route levels).
- D25-07: writer matrix 401/403/200/200; event surface is the token's; 401 precedes the body read (oversize-anonymous → 401).
- D25-13: full status matrix at route level (200/400/401/403/413/502-capped/503 ×2); MCP `isError` on every non-200, never on search.
- D25-26: doors suite pins registerTool, KNOWN_TOOLS, auditedRest names, KNOWN_ROUTES, both audit modes, both annotations, and both event rows.
- Fake client everywhere; `grep -c http` fixtures are runtime-assembled (`"https://" + …`); no secret, URL, key, or raw body in diffs or replies.

## 3. Verification (run once at end, per plan)

- `bun test packages/mcp-server/src/ packages/audit/src/` → **1617 pass, 0 fail** (47 files; +35 new: 13 service + 10 server + 4 mcp + 8 doors).
- `bunx tsc --noEmit` → **clean, exit 0**. Note: the 3 `@substrate/ledger` baseline errors from 25-01–25-03 are gone — the worktree's `packages/mcp-server/node_modules/@substrate/ledger` symlink was missing (ledger added as a dep after the last install here); recreating it by hand (no network, what `bun install` does) fixed both `bun test service.test.ts` and tsc. `node_modules` is uncommitted environment, not repo content.
- Phase 17 scan guard (`policy.test.ts` “every served tool and REST route…”) green unmodified — it now also covers the four new registrations.

## 4. Files

Modified: `packages/mcp-server/src/{service.ts,service.test.ts,server.ts,server.test.ts,mcp.ts,mcp.test.ts,observe.ts}`.
New: `packages/mcp-server/src/docs-doors.test.ts`.
Not touched: `observe.test.ts` (no existing expectation needed a change), `policy.ts`/`event-sources.ts` (Phase 17 rows/entries already on base), CLI/refresh (25-05).

## 5. Live proof — NOT RUN

No `RAGFLOW_URL` traffic was made: all doors run against in-process fakes. Operator live step 5 (search + ingest against the deployed RAGFlow, writing an event and an audit record) is still outstanding; 25-05 owns the CLI/refresh half.

## 6. Open / risks

- `detail` (D25-03, extra field from 25-03) passes through the route/MCP mapping verbatim with the rest of the search JSON — kept, not dropped.
- `finalize` with an empty version (no ingested paths) cuts an empty version at this layer; 25-05 must exit 1 without calling it when every page was refused (25-02 open item, unchanged).
- Service `docsSearch` re-validates input for the success event's `dataset_ids` (one extra in-process pass, zero extra RAGFlow calls when ids are static; one extra `listDatasets` when resolved by name).
