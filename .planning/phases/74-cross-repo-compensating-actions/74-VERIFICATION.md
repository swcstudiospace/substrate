# Phase 74 Verification

Evidence is named test cases, all in `packages/mcp-server/src/`. Git-backed cases create temporary repositories with `git init` and run the production `defaultScopedGitRunner` (or a wrapper that records or injects a fault at a named call). Postgres cases run against `postgres:16-alpine` in a disposable container, with `SUBSTRATE_TEST_PG_URL` set.

## Criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | An actual operation across at least two registered repositories persists operation and step state before effects, with stable dedupe keys and idempotent per-step retry. | Met | `cross-repo-ops.test.ts`: "a branch is cut in every repository and each step is recorded applied with its planned sha"; "a retry with the same key runs no effect and returns the stored operation"; "a request under a stored key with a different branch is refused and writes nothing"; "a crash after the create landed is adopted on retry, not created again"; "a crash before the create ran leaves the step applying, and the retry creates it once". `cross-repo-ops.pg.test.ts`: "a crash after a create lands is resumed by a fresh index over the same database, with no second create" (durable across a new `IndexStore`). Store: `cross-repo-store.testkit.ts` cases "create stores the operation running, with every step pending in index order", "create under a stored key returns the stored operation and stores nothing new", "moveStep moves a step only from a state the caller names". |
| 2 | A forced failure at step N yields compensated pre-operation state or a durable needs-attention result naming unfinished or failed compensation; never success for a partial operation. | Met | `cross-repo-ops.test.ts`: "a failed create at the second repository undoes the first and reports rolled-back, never done"; "a failure at the first repository stops the run: the second is never attempted and stays pending"; "a rolled-back operation is terminal: a retry performs no git call"; "a ref moved by an outside change is parked and left alone; the retry neither deletes it nor repeats a create" (status `needs-attention`, detail `ref-moved`); "a failed compensating delete parks the step, and a retry completes the rollback" (`undo-failed` then `rolled-back`). |
| 3 | Exercised against temporary real repositories; recovery and status expose the parked result, and cannot overwrite an outside ref change or silently repeat a completed effect. | Met | Real git: every test in `cross-repo-ops.test.ts` and `cross-repo-ops.pg.test.ts`. Outside change not overwritten: "a ref moved by an outside change is parked and left alone"; "a branch that already sits at the planned sha is not adopted: it is refused, and the rollback leaves it in place". No repeat of a completed effect: "a retry with the same key runs no effect"; "a crash after the create landed is adopted on retry, not created again". Status: "a parked step is visible to the surface that drove it, with its reason"; "a surface not granted every repository of the operation sees nothing, as for an unknown key"; "an unknown or malformed key names no operation". Parked result read by a fresh index: "a parked compensation is read back by a fresh index, and the ref an outside change moved is left as it is". |

Refusals run no git and write nothing (ROADMAP criterion 1, the phase 72 gate): "a surface not granted a repository is refused before any git call or store write"; "an anonymous caller is refused when scoping is enforced"; "a repository with no registration is refused"; "a base that names no commit in a repository is refused before the store is written"; "a branch name git rejects is refused before the store is written"; "malformed requests are refused with a message that names the field and not the value".

Store contract, against the in-memory adapter (`cross-repo-store.test.ts`) and Postgres (`cross-repo-store.pg.test.ts`, 8 cases, all passing live): the same eight cases in `cross-repo-store.testkit.ts`.

Migration: `index-store.migrate-contract.test.ts` (step 43 satisfies the contract, its two tables are allowlisted with reasons, the digest fixture matches). `rollback-compat.test.ts`: "every step added since is named in docs/runbooks/rollback-compat.md", which passes after the step 43 row was added.

## Commands and results

| Command | Result |
|---|---|
| `bun test` on `cross-repo-ops.test.ts`, `cross-repo-store.test.ts`, `index-store.migrate-contract.test.ts` (no database) | 80 pass, 10 skip (the Postgres cases), 0 fail |
| The same set plus `cross-repo-store.pg.test.ts` and `cross-repo-ops.pg.test.ts` with `SUBSTRATE_TEST_PG_URL` pointing at the disposable container | 90 pass, 0 fail |
| Wider set with `index-store.migrate*.test.ts`, `index-archive*.test.ts`, `index-store.archive.test.ts`, `index-store.memory.test.ts`, `rollback-compat.test.ts`, `live-session-restart.pg.test.ts`, `planning/live-session-authority.pg.test.ts`, with the Postgres URL set | 247 pass, 0 fail, across 12 files |
| `bunx tsc --noEmit` | No errors in files changed by this phase. Exit is non-zero from two errors in untracked `scripts/docs-migrate.ts` and `scripts/docs-migrate.test.ts` (unused identifiers), which this phase did not touch. |
| `bunx biome check` on the changed TypeScript files | Clean (after `import type` fixes) |

The full `bun test` suite was not run, per the assignment.

## Not verified

- A production Postgres. The live run used a disposable container only.
- Any route, MCP tool or CLI path. None exists (D74-10), so no HTTP or MCP behaviour is claimed.
- Concurrent drivers racing on the same key. The design relies on compare-and-set and the create-only ref; no test interleaves two live drivers.
