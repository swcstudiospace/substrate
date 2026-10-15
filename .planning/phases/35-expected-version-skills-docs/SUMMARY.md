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
