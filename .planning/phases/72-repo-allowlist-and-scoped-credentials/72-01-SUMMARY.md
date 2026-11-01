# Phase 72: Repo allowlist and scoped credentials - Summary 01

**Status:** implemented and written; not verified by execution (see section 4). Per the brief, the orchestrator runs every gate.

## 1. What changed

New
- `packages/mcp-server/src/repo-scope.ts`: registry and grant parsers (`parseRepoRegistry`, `parseRepoScopes`, `repoScopeFromEnv`), the pure gate (`authorizeRepo`, `authorizeRepoPath`, `locateRepoPath`, `isGranted`, `grantedRepos`), `resolveContained` (symlinks and nearest existing ancestor), `RepoScopeRefusal`, and the audit payload `repoRefusalPayload` (digest only).
- `packages/mcp-server/src/repo-executor.ts`: `scopedGit`, the one entry point phase 74 calls. Decides, then spawns through an injected runner; `cwd` is the resolved target, `GIT_CEILING_DIRECTORIES` is the parent of the registered root.
- `packages/cli/src/worktree/scope.ts`: CLI gate (`scopeRefusal`, `provisionTarget`), run before any command.
- Tests: `packages/mcp-server/src/repo-scope.test.ts`, `repo-executor.test.ts`, `repo-scope.boundary.test.ts`, `packages/cli/src/worktree/scope.test.ts`.

Changed
- `packages/mcp-server/src/config.ts`: `SubstrateConfig.repoScope`, parsed in `loadConfig`; a malformed value throws `ConfigError`.
- `packages/mcp-server/src/flag-registry.ts`, `.env.example`: rows and commented lines for `SUBSTRATE_REPO_REGISTRY` and `SUBSTRATE_REPO_SCOPES`.
- `packages/mcp-server/src/service.ts`: `scopedDriftScan` (new), `listWorktrees(query, callerSurface)`, `repoRefusal` (audit), the live-session issue/transition gate in `updateLiveSession`, `repoScope` in `corpusDeps`.
- `packages/mcp-server/src/server.ts`, `mcp.ts`: `/drift` and `drift_scan` call `scopedDriftScan`; `/worktrees` and `worktree_list` pass the caller's surface.
- `packages/mcp-server/src/worktree-registry.ts`: `WorktreeStoreFilter.repos`; Postgres `list` filters in the query. `worktree-registry-fake.ts` and `worktree-registry.testkit.ts` updated to match.
- `packages/mcp-server/src/corpus/service.ts`: optional `repoScope` in `CorpusServiceDeps`; `repoRefusalOf` gates plan, ingest and proof after parse and before any read; `allReposRefusal` gates status and reconcile.
- `packages/cli/src/worktree/command.ts`: `scopeRefusal` before the dispatch switch; provision target now from `provisionTarget`.
- `docs/worktree-fleet-api.md`: "Repository scope (phase 72)" section.

## 2. Decisions (one line each)

- D72-01 Registry is an operator JSON table of checkouts and worktrees per repository; the only way a path is placed. Overlap refused at boot.
- D72-02 Scoping is off when `SUBSTRATE_REPO_SCOPES` is unset (today's behaviour). Set, a missing surface and anonymous callers get nothing.
- D72-03 The "credential scoped to one repository" is the existing surface bearer plus its grant. No per-repository secret was added.
- D72-04 The gate runs before every git spawn; the executor's tests assert zero runner calls on refusal.
- D72-05 Drift and worktree list are gated in the service, so REST and MCP share the decision. Corpus doors are gated in `corpus/service.ts`.
- D72-06 Corpus status and reconcile are refused to a scoped surface (cross-repository). Corpus root and anchor are left open: digests, no content. Reconcile was added beyond the PLAN.
- D72-07 Live-session issue for an ungranted repository returns the same `not-found` an unknown session gets. The PLAN named a new refusal; I kept phase 71's closed refusal union unchanged instead.
- D72-08 The executor always requires a registration, even with scoping off. The API path gate does not (today's behaviour for `/drift`).
- D72-09 The ledger audit runs only for an authenticated surface. Anonymous refusals are recorded by the route audit, which runs before every handler. The PLAN said "every refusal"; this narrows it.
- D72-10 The CLI runs as surface `claude-code` and reads the same two variables. Under scoping, every root must be a granted registered directory, or the command exits 2.
- D72-11 `--repo` is a name if it parses as `owner/name`, else a directory.
- D72-12 Path gates return the resolved target; drift scans that target, not the string sent.

## 3. Discovery (confirmed, recorded in 72-01-PLAN.md)

Git calls are argv-only; no `shell: true` in packages or scripts. No per-session allowlist existed (a live session binds one `repo_id`). No repository registry existed. Credentials are surface bearers only. Ungated git on a caller-named path existed at `/drift` and in the CLI's `provision`, `merge-back`, `guard` and `--root`.

## 4. Not verified

- Nothing was executed. I did not run `tsc`, `bun test`, lint, formatters or builds, per the brief. Type-level correctness is by reading only; expect the orchestrator's typecheck to find small errors.
- The Postgres list query (`lower(repo) in (select jsonb_array_elements_text(...::jsonb))`) was not run against a database. The shared contract in `worktree-registry.testkit.ts` covers the fake only.
- The `Bun.spawnSync` spy in `repo-scope.boundary.test.ts` assumes the drift path reaches git only through `Bun.spawnSync`.
- The CLI tests use a stub git runner. The "not refused" tests assert the absence of a refusal, not the completion of the command.
- `docs/config-reference.md` was not regenerated (`scripts/config-reference.ts`). New flags are missing from it until someone runs the script.

## 5. Open risks

- Not gated, and they name a repository: live-session list and metadata by `repo_id` (`listVisible`, `listMetadata`), `/brief` `repo`, memory recall `repo`, handoff `repo`, and `session_context` `repo_id`. These are ledger and brief reads, not git, worktree or corpus reads. A scoped credential can still see their metadata. Record as the next gap, not closed here.
- Corpus root reports `count` across all repositories, a small cross-repository figure.
- No per-repository credential. A surface granted one repository still holds a bearer that works on every route the gate does not cover (see above).
- Refusal reasons distinguish "path not registered" from "repo not granted", so a caller can learn whether a path sits in a registration. The CLI is local; the API answers the same way for drift.
- CLI symlink race: the gate checks the real path, but the command later runs git on the named string, so a swap between check and use is possible on the same account. Same-account compromise is outside the guarantee.
- Operational: under scoping, every `SUBSTRATE_WORKTREE_ROOTS` entry must be registered, or every `substrate worktree` command exits 2. Deployments must register their roots before turning scoping on.
- `scopedGit` has no production caller yet; phase 74 is its first. It is covered only by its unit tests.
- Live-session refusals reuse `not-found`. That is indistinguishable by design, but an operator debugging a grant sees "not found", not "not granted". The ledger warning carries the real reason.

## 6. Follow-up: route gates added after review

The open-risk bullet on live-session list, brief, memory recall, handoff and session context is superseded. Those five are now gated at their doors (PLAN section 8), with `repo-scope.routes.test.ts`. Still open, per PLAN section 8: graph-keyed reads (`handoffsForGraph`, `graph_get`, brief `graph_id`), the `docs_search` Hindsight fallback, and `memory_search`, `memory_verify`, `events_query`, `graph_register`, `events_emit` and `reapExpiredLeases`, which were found but not assessed.
