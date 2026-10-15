# Phase 35 — expected_version for skills and docs ingest

## Gap
Audit row 24 (`.planning/uplift-7/MILESTONE-AUDIT.md`): a stale concurrent update is rejected or
resolved under the documented policy. Memory decisions carry `expected_version`; skills and docs do not.

## Current behaviour (read, with citations)
- Memory contract. `memory-write.ts:856` calls `versionMismatch` (`memory-write.ts:1189-1216`):
  mismatch returns reason `version.stale`; `version.required` when a standing entry exists and the
  field is absent. The reply is `outcome: "conflict"` with `remedy`, `current_version`, `conflict_with`,
  `verified_persisted: false` (`memory-write.ts:858-871`). HTTP status comes from
  `memoryWriteStatus` → `conflict` = 409 (`server.ts:406-418`). `version` is a monotonic int column
  (`memory-write.ts:~899`, `version: standing ? standing.version + 1 : 1`).
- Skills. There is no version anywhere. `Substrate.proposeSkill` (`service.ts:2624-2700`) opens a git PR
  through `skills.propose` and then `recordProposedSkill` (`service.ts:~2735`) calls
  `upsertProposedSkill` (`index-store.ts:1825-1848`). `skills_registry` is keyed `(repo, name, pr_number)`
  (`index-store.ts:504-520`), so there is no per-skill row to version. Refusals are `{error}` bodies
  (`skills/request.ts:70-90`, status 400|401|403|502). The route is `server.ts:~1400-1420`; the MCP tool
  is `mcp.ts:1044-1080`. The assignment's cited "index-store.ts ~1839-1844" is the proposal upsert's
  SQL comment area, not a content write; the real write is `proposeSkill`.
- Docs ingest. `ingestDocs` (`docs-ingest.ts:375`) keys a record `${dataset_id}::${source_url}`
  (`docs-ingest.ts:204-225`, `recordKey` ~line 336). Records persist in the state file (`saveIngestRecords`,
  `docs-ingest.ts:614`) and hold `sha`, `document_id`, `commit`, `superseded`. No version exists.
  The route is `server.ts:1247-1292`; a refusal is `{ok:false, refused:true, reason, page, changed}`
  mapped to 400 (403 for `vm-guest`). `rollback-compat.test.ts:79,188` freezes the record key set.

## Decisions
1. Contract is memory's, verbatim: field `expected_version` (int >= 0); mismatch → reason `version.stale`,
   `remedy`, `current_version` (null when nothing recorded), `verified_persisted: false`, HTTP 409;
   nothing written. Absent → exactly today's behaviour. Expected 0 with nothing recorded is accepted,
   as in memory's `versionMismatch`.
2. **Policy: reject on mismatch** (no merge, no last-write-wins). Stale = refused before any write.
3. Docs: the row is the source URL's record. `expected_version` is per page (a call carries many
   pages; each page's record has its own version). The version is persisted on `IngestRecord` (new
   record 1, replace prior+1, unchanged keeps). Legacy state-file records load as version 1.
   The check runs twice: before any upload (so a stale page leaves the whole call unwritten) and
   synchronously inside the per-page loop (a concurrent writer may have bumped it mid-call).
4. Skills: the version is a monotonic integer per `(repo, name)` stored on each `skills_registry` row,
   assigned at proposal-row creation (max + 1), unchanged on a retry of the same PR. Current version =
   max over that name's rows in any state. The check runs in `proposeSkill` BEFORE git work so a stale
   proposal opens no PR and writes no row. Under governance off, nothing is recorded: current is null.
5. `version.required` is NOT adopted. The assignment makes the field optional; requiring it would break
   existing callers. Recorded as GREY_AREA.
6. Compatibility: a new docs record key `version` is ignored by the old reader (it rebuilds records from
   known keys), so rollback is safe. `rollback-compat.test.ts` is updated to name it as an allowed addition.
