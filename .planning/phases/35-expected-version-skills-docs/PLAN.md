# Phase 35 — PLAN (written before any code edit)

Order of steps:

1. Docs record version (`docs-ingest.ts`)
   a. `IngestRecord` gains `version: number`. Loader (`loadIngestRecords`) reads it when it is a
      positive integer, else defaults legacy records to 1.
   b. `IngestPage` gains optional `expected_version?: number`.
   c. `IngestOutcome` refusal gains optional `remedy`, `current_version`, `conflict_with`.
   d. Helper `staleVersion(prior | undefined, expected)` mirroring memory's `versionMismatch`
      (no record + expected 0/undefined → ok; no record + expected>0 → stale with current null;
      record + expected undefined → ok (absent = today); record + mismatch → stale).
   e. Pre-check in `ingestDocs` after dataset resolution, before the results loop: first stale page
      → refuse `version.stale` (page, remedy, current_version, conflict_with, changed false).
   f. In-loop synchronous re-check next to `const prior = seen.get(key)`; refuse the same way with
      `changed: changed()`.
   g. Stored record version: `replacedPrior ? replacedPrior.version + 1 : 1`; unchanged path keeps
      `prior.version`. The unchanged branch does not write.
2. Docs route (`server.ts` ~1247-1292): validate `expected_version` per page (integer >= 0) in
   `pagesValid`; map refusal `reason === "version.stale"` to 409.
3. Docs test: `rollback-compat.test.ts` allow `version` as an optional record addition
   (`NEW_DOCS_RECORD_OPTIONAL`) and assert it. Add three regression tests in `docs-ingest.test.ts`.
4. Skills store (`index-store.ts`)
   a. Migration version 31: `alter table skills_registry add column if not exists version integer not null default 0`.
   b. `upsertProposedSkill`: run in a transaction holding `pg_advisory_xact_lock` on
      `hashtextextended(skillDecisionLockKey(repo,name), 0)` (same key as decisions, so proposals and
      decisions on one name serialize). Insert with
      `version = (select coalesce(max(version),0)+1 from skills_registry where repo=… and name=…)`.
      On conflict the row is untouched (version stays).
   c. New `skillVersion(repo, name): Promise<{ version: number; pr_url: string | null } | null>`:
      max-version row over all states, null if none.
   d. `SkillRegistryRow` gains `version: number`; `toSkillRow` maps it.
5. Skills service (`service.ts`)
   a. `SkillProposalRequest.expected_version?: number`.
   b. New `SkillProposalStale extends Error` (status 409, `current_version`, `conflict_with`, `remedy`).
   c. In `proposeSkill`, after the `skills.problem` gate and before `this.skills.propose`, when
      `request.expected_version !== undefined`: current = null when `skillsGovernance === "off"` or no
      index; else `index.skillVersion(repo, name)` (failure → `ProposeFailed`, 502). Apply the same
      mismatch rule. Refusal emits nothing (matches the method's documented "refusals emit nothing").
6. Skills request/route/MCP (`skills/request.ts`, `server.ts`, `mcp.ts`)
   a. `proposalBodyProblem`: `expected_version` must be an integer >= 0 if present.
   b. `toProposalRequest`: pass it through.
   c. `ProposalFailure`: status union gains 409; body gains `outcome`, `reason`, `remedy`,
      `current_version`, `verified_persisted: false`, `conflict_with?`. `proposalFailure` maps
      `SkillProposalStale`. `error` stays a readable sentence (existing consumers read it).
   d. MCP `skills_propose` zod input gains `expected_version`.
7. Skills tests
   a. `skills-approve.test.ts` FakeRegistry: rows carry `version`; `skillVersion` implemented;
      three regression tests in the proposal section (stale rejected + byte-identical rows + proposer
      never called; matching accepted + version increments; absent unchanged).
   b. `index-store.skills.test.ts`: one Postgres test, unique repo per test, versions monotonic per name.
8. Artifacts: SUMMARY.md, commit, push. Do not run tests, tsc, or formatters.
