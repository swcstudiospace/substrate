# Phase 34 summary: invalid-write round trip

NOT verified by me: tests, tsc. Nothing in this phase was executed. The orchestrator runs
`bun test invalid-write-roundtrip` (with `SUBSTRATE_TEST_PG_URL` for the memory and skills
suites) and `bunx tsc --noEmit` once, after all three branches land.

## What this is
The round trip the audit row said was never run. For each client-input write surface, an
invalid payload is sent through the real door (REST over a socket, or MCP over an in-memory
transport), and the whole table the surface would write to is counted before and after.
Each suite also sends one valid control first, so a zero delta is shown to come from a
counter that moves. Isolation: every write carries `ut-iwr-<RUN>` in its scope, skill name or
idempotency key, and `afterAll` deletes by that marker.

## Surfaces covered and what each test asserts
| Surface | Refusal asserted | Tables counted |
|---|---|---|
| POST /memory | 403 for shape (documented "denied by policy"); 400 for non-object or malformed body | memory_entries, memory_writes, memory_quarantine, memory_reviews |
| MCP memory_write | protocol refusal (isError or thrown) | same |
| POST /skills/propose | 400; the real engine runs with a spy `skillRun` that must see zero git calls | skills_registry |
| MCP skills_propose | protocol or tool refusal; zero git calls | skills_registry |
| POST /skills/approve | 400 | skills_registry |
| MCP skills_approve | protocol or tool refusal | skills_registry |
| POST /docs/ingest | 400; zero RAGFlow uploads (RagflowFake) | uploads (no DB) |
| MCP docs_ingest | refusal; zero uploads | uploads |

Each suite covers a missing required field, a wrong type, and a non-object body. Docs also
covers a valid page followed by an invalid one, so a page that would have uploaded first is
caught.

## Partial persistence found
- **POST /memory, non-object body (server.ts ~1070).** Before this phase, `null` wrote the
  `memory_write` audit record and then threw on `body.writer`, answering 500. No table row
  was written. Arrays, strings and numbers reached the gate and came back as a policy 403.
  **Fixed:** the body is parsed and refused with 400 before the audit and the gate. Same
  change as the other REST write routes.
- No other surface was found to write a table row before refusing. Reading the code: the
  memory gate's shape checks (memory-write.ts:448-491) run before `claimWrite` (:671); the
  skills engine validates before any git call (propose.ts:936-945); approval validates before
  the index (service.ts:2799-2805); docs ingest refuses every page before the first upload
  (docs-ingest.ts:386-404). These are read-verified, not run-verified.

## Files changed
- `packages/mcp-server/src/server.ts`: the `POST /memory` parse-then-refuse change.
- `docs/memory-governance.md`: one row added to the `POST /memory` status table (400).
- `packages/mcp-server/src/invalid-write-roundtrip.test.ts`: new (the round-trip suites).
- `.planning/phases/34-invalid-write-round-trip/{CONTEXT,PLAN,SUMMARY}.md`: new.

## Tests added
`invalid-write-roundtrip.test.ts` (about 60 cases, one `describe` per door). Memory: REST
and MCP, each with one valid control, four shape refusals (403 REST, protocol MCP) and a
non-object list (400 REST, protocol MCP). Skills propose: REST and MCP, with the real engine
and a git spy that must see no calls, plus a fake-seam control that moves the registry by one.
Skills approve: REST and MCP, with five value refusals and a non-object list. Docs ingest:
REST and MCP, with a valid control, seven refusals (including a valid page followed by an
invalid one) and five non-object bodies, counted by RAGFlow (retired, superseded by LightRAG) uploads. The Postgres suites are
skipped without `SUBSTRATE_TEST_PG_URL`; the docs suite is not.
PR #72's oversize tests are not duplicated: no body here is near the size cap.

## Left alone, flagged as GREY_AREA
1. **Audit lines for refused but object-shaped bodies.** POST /memory, POST /skills/propose,
   POST /skills/approve and MCP tool calls are audited before their value checks. Kept on
   purpose: docs/skills-propose.md:77 says the chain records those that reach it, the http
   test at http.test.ts:383 pins it, and the memory trail records denials (service.ts:1924).
   Not counted as partial persistence, because it is an attempt record, not a write to the
   target table. Recommended default: keep.
2. **Optional wrong-typed memory fields on REST are coerced, not refused.** `subject: 42`
   becomes a subject-less write (memory-write.ts `typeof … === "string" ? … : null`). MCP
   refuses the same input through zod. Changing this changes what existing callers get
   back. Recommended default: refuse non-string optional fields on REST; decide before a
   follow-up.
3. **Shape refusals on /memory answer 403, not 400.** That is the documented status
   ("denied by policy"), so it is kept and asserted.

Also noticed, not changed: a multi-page docs ingest can upload page 1 and then fail on
page 2 at parse time. That is a plane failure after valid input, not a validation gap, so
it is out of scope here.

## Addendum: audit-found changes (2026-10-24)

Commit `76f2707` (`fix(mcp-server): refuse a LightRAG docs batch with an invalid page before any write`) was made after this phase's verification. It closes criterion 34.1 on the LightRAG plane. The read-verified claim under "Partial persistence" that docs ingest refuses every page before the first upload held for RAGFlow only. Before this commit, LightRAG recorded an invalid page as `failed` and uploaded the rest.

**Behavior change.** A LightRAG docs ingest batch with one invalid page now returns the same refusal as RAGFlow and persists nothing: no LightRAG request, and the state file is unchanged. An upstream write failure still reports per page.

## Files changed
- `packages/mcp-server/src/docs-ingest.ts`: `ingestDocs` runs the per-page gates on both planes before the first write (comment at line 843). The LightRAG `rejected` list is removed, and `failed` in `ingestDocsLightrag` counts only upstream write failures.
- `packages/mcp-server/src/invalid-write-roundtrip.test.ts`: LightRAG case added (`lightragRecorder` at line 868; test at line 879).

## Tests added
- `invalid-write-roundtrip.test.ts:879`: a LightRAG batch with an invalid second page is refused, with no LightRAG request and an unchanged state file. Not run in this addendum.

## Schema
None. No migration in this commit.

## Rollback
Revert `76f2707`. The LightRAG batch then goes back to per-page `failed` with the valid pages kept. No data or schema change to undo.
