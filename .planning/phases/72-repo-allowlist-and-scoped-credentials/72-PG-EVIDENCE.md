# Phase 72: Postgres per-file evidence (orchestrator, Run 20)

Scope: Needs Human row 72, "Row 8: Postgres filter has orchestrator evidence only". Row 8 is the worktree list filter in SQL (72-VERIFICATION, row 8: "the list query filters in SQL, and an empty list matches no row"). The PG-gated test for it was run and its result is recorded here.

This is orchestrator evidence. It does not change the 72 verification record.

- Branch `gsd/v18-orchestrator-items`, at commit `8ca6aa05`.
- Database: `substrate_test` on the scratch Postgres 16 container, 127.0.0.1:55433, trust auth, no password.
- Command: `SUBSTRATE_TEST_PG_URL=postgres://postgres@127.0.0.1:55433/substrate_test bun test packages/mcp-server/src/worktree-registry.pg.test.ts`.

| File | Pass | Fail |
|------|------|------|
| `packages/mcp-server/src/worktree-registry.pg.test.ts` | 13 | 0 |

Row 18 (the scoped service gate) is not evidenced by this file.
