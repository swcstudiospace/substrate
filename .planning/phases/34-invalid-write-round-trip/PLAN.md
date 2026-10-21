# Phase 34 plan (written before any code edit)

1. Fix `POST /memory` in `packages/mcp-server/src/server.ts` (~1070-1085): parse the body,
   refuse a non-object (null, array, scalar) with 400 `request body must be a JSON object`
   before `rememberClaim` and before `auditedRest`. Malformed JSON already answers 400 via
   the outer SyntaxError catch and is left alone.
2. Add one line to the `POST /memory` status table in `docs/memory-governance.md` (400 for a
   body that is not a JSON object; no audit record, no gate).
3. Write `packages/mcp-server/src/invalid-write-roundtrip.test.ts`, one `describe` per
   surface. Each invalid case: snapshot the rows of every table the surface writes to,
   send one deliberately invalid payload, assert the documented status and that the row
   counts are unchanged. Each suite also sends one valid control and asserts the count
   moves by one, so a zero delta means something.
   - Docs ingest (no Postgres needed; RagflowFake, `uploads.length`): missing `dataset`,
     `pages` not an array, a page with a numeric `path`, non-object bodies (null, array,
     string, malformed JSON), a valid page followed by an invalid page (proves page 1 is
     not uploaded), and the same through MCP `docs_ingest`. Control: one valid page, 200.
   - Memory (Postgres via `SUBSTRATE_TEST_PG_URL`, skipped otherwise, as the existing
     `index-store.*.test.ts` files do): tables `memory_entries`, `memory_writes`,
     `memory_quarantine`, `memory_reviews`. POST /memory and MCP `memory_write` with
     missing `text`, `kind: 7`, and non-object bodies. Control: `graph:` scope, `fact`,
     explicit idempotency key, 200 and +1 row.
   - Skills propose (Postgres): `skills_registry`, plus the real engine with a spy `skillRun`
     that must receive zero git calls. Invalid cases: missing `name`, `files` as an array,
     no `SKILL.md`, non-object bodies, through POST and MCP. Control: a fake `skills` seam
     answering `opened`, governance `report`, +1 registry row.
   - Skills approve (Postgres): `skills_registry`. Missing `pr_number`, non-string
     `decision`, `decision: "merge"`, non-object bodies, through POST and MCP. No control:
     a valid approve needs `gh`.
   - Isolation: every write uses the run marker `ut-iwr-<RUN>` in its scope, name or
     explicit idempotency key. `afterAll` deletes by marker.
4. Write `.planning/phases/34-invalid-write-round-trip/SUMMARY.md` after the code.
5. Commit on `feat/v14-invalid-write-round-trip`, push with `-u`, return the SHA and files.

Not run here: tests, tsc, lint (per the mid-flight rule).
