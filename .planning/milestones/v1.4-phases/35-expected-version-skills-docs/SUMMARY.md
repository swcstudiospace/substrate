# Phase 35 — SUMMARY

## What changed
Optional `expected_version` on the skill proposal and on docs ingest, with memory's contract:
mismatch → reason `version.stale`, `remedy`, `current_version` (null when nothing recorded),
`verified_persisted: false`, HTTP 409, nothing written. Absent → unchanged behaviour.

Docs (`docs-ingest.ts`, `server.ts`):
- `IngestRecord.version`: 1 on first ingest, +1 per replacement; legacy records load as 1.
- `IngestPage.expected_version`, checked for every page before any upload and again at each page's store point.
- Route validates it (integer >= 0) and maps `version.stale` to 409.

Skills (`index-store.ts`, `skills/registry.ts`, `skills/request.ts`, `service.ts`, `server.ts`, `mcp.ts`):
- Migration 31: `skills_registry.version` (default 0). `upsertProposedSkill` and the approval-created insert take max+1 under the per-name advisory lock.
- `skillVersion(repo, name)`: highest version in any state, or null.
- `proposeSkill` checks `expected_version` before any git work; a stale proposal opens no PR and writes no row.
- `SkillProposalStale` (409) mapped in `proposalFailure`, body carries memory's conflict fields; MCP `skills_propose` declares the field.

## Tests added (not run)
- `docs-ingest.test.ts`: stale refused, nothing written, record JSON byte-identical; matching accepted, version 1→2; absent keeps behaviour.
- `skills-approve.test.ts`: stale refused before git, rows JSON byte-identical, no event; matching accepted, new PR takes version 2; absent reads no version.
- `index-store.skills.test.ts` (live Postgres): version monotonic per name; retry keeps version; approval-created row takes next; read returns highest. Uses its own repo and deletes it.
- Updated for the new record field: `rollback-compat.test.ts` (allowed `version` key; legacy load = 1), `skills/registry.test.ts`, `skills-approve.test.ts` (FakeRegistry, seeded rows).

## GREY_AREA decisions (for review)
1. Policy: reject on mismatch. `version.required` (memory's) not adopted: the spec makes the field optional.
2. Skills check is advisory at proposal time, not atomic with the PR. Two concurrent proposals that both pass the check each open a PR; the registry assigns both the next version. The atomic point would be approval. Not closed here.
3. Governance off (or no index): nothing is recorded, so any `expected_version` > 0 is refused as stale with current_version null.
4. A retry carrying the same `expected_version` after a newer proposal is refused (no idempotency keying on skills).
5. Docs `expected_version` is per page, not per call.
6. Successful skill and docs replies do not carry the new version; only conflicts do.

NOT verified by me: tests, tsc. No test, typecheck, lint or formatter was run.

## Addendum: audit-found changes (2026-10-24)

Two commits after this phase's verification changed behavior: `c74fa07` (skills) and `7cf8d44` (docs). One correction to the text above.

**Correction.** The migration that adds `skills_registry.version` is version 32, not 31 as written under "What changed". See `packages/mcp-server/src/index-store.ts:575-577`. Version 31 is `memory_entries_repo_idx` (`index-store.ts:571`).

**Commit `c74fa07`: the skills staleness check runs after validation and the ledger replay.**
- The check moved out of `Substrate.proposeSkill` (`packages/mcp-server/src/service.ts:3192`) into a `beforeWork` hook (`service.ts:3225-3238`, passed at `:3264`). `proposeSkill` runs it after the ledger replay and before the mirror fetch, clone and push (`packages/mcp-server/src/skills/propose.ts:97`, `:970`).
- Order is now: validate, mirror check, per-content lock, ledger replay, `beforeWork`, then git work.
- Behavior changes:
  - An invalid body is refused before the stale check (`propose.ts:939`).
  - A missing mirror, or a mirror whose origin names another library, is refused before the stale check (`propose.ts:947-956`).
  - An identical versioned retry is answered from the ledger, not 409 (see the Phase 36 addendum).
  - The version-read failure path is not changed by this commit. It throws `ProposeFailed` ("could not read the skill's version; nothing was proposed", `service.ts:3233`), which records a `warning` event (`service.ts:3298-3306`). That event already existed; this commit did not add it.
- Files changed: `packages/mcp-server/src/service.ts`, `packages/mcp-server/src/skills/propose.ts`, `packages/mcp-server/src/skills/propose.test.ts`, `packages/mcp-server/src/skills-approve.test.ts`, `packages/mcp-server/src/http.test.ts`.

**Commit `7cf8d44`: the docs stale refusal carries `outcome: "conflict"`.**
- The `version.stale` refusal body from `ingestDocs` carries `outcome: "conflict"`, as memory and skills do (`packages/mcp-server/src/docs-ingest.ts:462-463`, `:776`, `:799`, `:809`). The docs route still answers 409 (`packages/mcp-server/src/server.ts:1552`).
- The module docstring at `docs-ingest.ts:17-22` previously promised a per-page re-check inside the loop, which the loop never performs. It now states that every page's expected version is checked against the whole call's version plan before the first upload, under the dataset's in-process ingest lock.
- HTTP 409 test for the docs route: `packages/mcp-server/src/server.test.ts:495`. The stale-docs test in `packages/mcp-server/src/docs-ingest.test.ts:609` asserts `outcome: "conflict"` and no upload.
- Files changed: `packages/mcp-server/src/docs-ingest.ts`, `packages/mcp-server/src/docs-ingest.test.ts`, `packages/mcp-server/src/server.test.ts`.

## Tests added (not run in this addendum)
- `skills/propose.test.ts:500-528`: ledger idempotence. A versioned retry of an open proposal is answered from the ledger before `beforeWork` runs (`:517`). A refused `beforeWork` opens nothing (`:528`).
- `http.test.ts:1424`: a stale `expected_version` on the skills route is a 409 conflict, and nothing is proposed.
- `server.test.ts:495` and `docs-ingest.test.ts:609`: docs stale refusal (see above).

## Rollback
Revert `7cf8d44` and `c74fa07`. Neither commit changes the schema. Migration 32 comes from the original phase commit, not from these two, so reverting them leaves the column in place.
