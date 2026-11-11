# Phase 74: Cross-repo compensating actions - Context

**Goal (ROADMAP):** A real operation spanning at least two registered repositories records durable per-repository step state. Partial failure leaves compensated state or explicit needs-attention, never silent partial success; each retry is idempotent.
**Requirement:** HARD-R1.
**Depends on:** Phase 72 (registered repositories, containment, credential-scoped execution via `scopedGit`).

## Discovery (what exists today)

- Registration: `SUBSTRATE_REPO_REGISTRY` (`packages/mcp-server/src/repo-scope.ts`) places each repository's checkouts and worktrees on disk. `SUBSTRATE_REPO_SCOPES` grants surfaces repositories. `scopedGit` (`repo-executor.ts`) is the one entry point that runs git against a registered repository: it checks registration and grant, then spawns with argv (no shell) and `GIT_CEILING_DIRECTORIES`.
- Multi-repo write paths: none. Phase 72's summary records that phase 74 is the first caller of `scopedGit` beyond read-only drift and worktree listing. The corpus service gates cross-repo status and reconcile as refusals (D72-06), it does not compensate them.
- Durable store convention: a port (`WorktreeRegistryStore`), an in-memory adapter (`worktree-registry-fake.ts`), a Postgres adapter built by `IndexStore` over its pool (`PgWorktreeRegistry`), a contract testkit run against both, and a live Postgres test gated on `SUBSTRATE_TEST_PG_URL`. Tables come from numbered migration steps in `index-store.ts`. Adding a step needs the regenerated `index-store.migrations.digests.json` (`scripts/migration-digests.ts`) and, for each new table, a reason in `REAL_ALLOWLISTS.tables` (`index-store.migrate-contract.test.ts`), because the archive's closed table list would otherwise change the hash earlier archives verified against.
- Latest migration step is 42 (`live_session_bindings`).
- git 2.43 on this host. Docker is available, so a live Postgres test is possible.

## The operation chosen (D74-01)

**Branch fan-out:** create the same branch at a named base in each of two or more registered repositories. Each repository is one step. This is the smallest real multi-repo write: `git update-ref` is atomic per repository, its create is create-only (fails when the ref exists), and its undo is a compare-and-delete with a provable inverse. Nothing else in the codebase is a multi-repo write.

## Decisions

- **D74-01** Operation is a branch fan-out across 2 to 16 distinct canonical repositories (`owner/name`). Steps run in request order.
- **D74-02** Durable state is a Postgres table pair (`cross_repo_operations`, `cross_repo_steps`) created by migration step 43, always on (no opt-in: empty tables cost nothing, like step 36). Both tables get a reason in the archive allowlist: the operation log is rebuilt by re-running an operation, not restored from archive. Port, in-memory fake and a contract testkit run against both adapters.
- **D74-03** Every git call goes through `scopedGit` (phase 72). Grant and registration are checked before any spawn. A refused git call returns before the runner runs. The operation never shells out.
- **D74-04** Idempotency key is caller-supplied (`key`, `[A-Za-z0-9._:-]`, at most 128 chars). A fingerprint (SHA-256 of the canonical branch and repo/base set) is stored with it. A retry with the same key and fingerprint resumes the stored operation and never re-resolves bases. A key reused with a different fingerprint is refused (`key-reused`). A new attempt needs a new key.
- **D74-05** Each effect is bracketed by durable state. The step moves `pending`→`applying` (or `compensating` for undo) before the git call. The outcome is read back from the repository's ref, never trusted from the exit code. Create is `update-ref refs/heads/<b> <planned> <zero>` (create-only). Undo is `update-ref -d refs/heads/<b> <planned>` (compare-and-delete). A crash after an effect therefore leaves `applying` with the ref in place, and the retry adopts it instead of creating again.
- **D74-06** Terminal and parked statuses are explicit: `done` (every step applied), `rolled-back` (a step failed and every applied step was undone, nothing parked), `needs-attention` (at least one step is parked, meaning its state cannot be proven safe to leave or undo). `done` is never reported for a partial operation. A `needs-attention` retry re-inspects only the parked and applied steps; a `rolled-back` or `done` operation is never re-driven.
- **D74-07** Compensation never overwrites a ref the operation did not write. A ref whose value differs from the planned sha is parked as `ref-moved` and left alone.
- **D74-08** Persisted reasons are closed codes (`detail`), never git stderr, never paths, never requested values. Refusal messages name the reason only (phase 72 convention).
- **D74-09** Concurrency: step transitions are compare-and-set on the stored state, and the create-only ref is the arbiter for the effect. No lease. A second driver that finds a step held elsewhere returns the current operation with status `running` rather than acting.
- **D74-10** Entry point is the module function `runBranchFanout` with an injected store, runner and clock. No HTTP or MCP route is added in this phase. Wiring an operator-visible route needs admission classification and a gate decision, which is out of this phase's acceptance. Recorded as a deferred item in SUMMARY.md.
- **D74-11** Planning file names follow phases 72 and 73 (`74-CONTEXT.md`, `74-01-PLAN.md`, `74-01-SUMMARY.md`, `74-VERIFICATION.md`).
- **D74-12** The `down` of step 43 is documentary, as for every step (`down` is operator-run documentation, never an automatic rollback).

## Out of scope

- Any production repository, Railway, systemd, /etc, or live store. Tests use temporary git repositories and an in-memory store; the live Postgres test runs against a disposable container only.
- A route, MCP tool, or CLI command (D74-10).
- Git-hook install loop robustness (ROADMAP note, separate).
