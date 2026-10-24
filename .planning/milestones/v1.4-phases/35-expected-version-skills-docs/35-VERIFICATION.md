---
phase: 35-expected-version-skills-docs
verified: 2026-10-21T06:17Z
status: passed
score: 3/3 success criteria proven by tests (skills propose and docs ingest)
verified_on: origin/main efa3ee4 (code tree b8f8331; PR #80 merged as ed5cb93)
covered_files: [".planning/phases/35-expected-version-skills-docs/PLAN.md", ".planning/phases/35-expected-version-skills-docs/SUMMARY.md", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/docs-ingest.test.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/index-store.skills.test.ts", "packages/mcp-server/src/skills/registry.ts", "packages/mcp-server/src/skills/registry.test.ts", "packages/mcp-server/src/skills/request.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/skills-approve.test.ts", "packages/mcp-server/src/rollback-compat.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/mcp.test.ts", "packages/mcp-server/src/server.ts"]
---

# 35-VERIFICATION: expected_version for skills and docs

Verified by the orchestrator on 2026-10-21, against final main.

## Proven in-repo

| Claim | Evidence |
|---|---|
| Suites pass on a throwaway Postgres 16 | `bun test` over docs-ingest, index-store.skills, skills-approve, skills/registry, skills/request, rollback-compat, mcp: 283 pass, 0 fail, 7 files, 0 skip, 0 todo |
| Types clean | `bunx tsc --noEmit` exit 0 on efa3ee4 |
| Full suite on the same code | CI SUCCESS on PR #80 head d2bc79f. Same code tree as efa3ee4 |

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | A skill or docs write with a stale expected_version is rejected with the memory path's error, and the stored row is unchanged | PASS | Docs: refused with `reason: "version.stale"`, `current_version`, `conflict_with`; uploads unchanged; stored record byte-identical; warning logged (`docs-ingest.test.ts:459`). Skills: refused before git with `SkillProposalStale`; no proposal, registry rows, or events change (`skills-approve.test.ts:729`). The reason string matches memory's `version.stale` (memory-write.ts:1251, :1267). These tests do not assert the HTTP status code |
| 2 | A matching expected_version is accepted and the version increments | PASS | Docs: accepted and version incremented (`docs-ingest.test.ts:484`); all-matching batch (`:552`); later page checked against the version an earlier page leaves (`:571`); chained versions on one URL (`:625`). Skills: accepted and takes the next version (`skills-approve.test.ts:745`); version monotonic per name (`index-store.skills.test.ts:247`) |
| 3 | A write without the field behaves exactly as it does today | PASS | Docs: `docs-ingest.test.ts:502`. Skills: `skills-approve.test.ts:762`: no version read, and a retry changes no row |

## Not proven

- No concurrent-writer test was in this run. The tests are single-process and sequential.
- The HTTP status for the stale refusal is not asserted by these tests.
