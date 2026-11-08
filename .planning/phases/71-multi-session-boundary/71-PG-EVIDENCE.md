# Phase 71: Postgres per-file evidence (orchestrator, Run 20)

Scope: Needs Human row 71, "Postgres restart clauses (criteria 3 and 5)". The PG-gated restart tests were run and their result is recorded here.

This is orchestrator evidence. It does not change the 71 verification record. The verifier re-run that changes that record has not been run.

- Branch `gsd/v18-orchestrator-items`, at commit `8ca6aa05`.
- Database: `substrate_test` on the scratch Postgres 16 container, 127.0.0.1:55433, trust auth, no password.
- Command per file: `SUBSTRATE_TEST_PG_URL=postgres://postgres@127.0.0.1:55433/substrate_test bun test <file>`.

| File | Pass | Fail |
|------|------|------|
| `packages/mcp-server/src/live-session-restart.pg.test.ts` | 16 | 0 |
| `packages/mcp-server/src/planning/live-session-authority.pg.test.ts` | 13 | 0 |

The bun summary for each file printed no skip count.
