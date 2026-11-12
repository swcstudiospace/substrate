---
phase: 68-worktree-fleet
verified: 2026-10-30
status: gaps_found
score: "5 of 6 success criteria MET in the repository (2, 3, 4, 5, 6, with caveats), 1 PARTIAL (criterion 1: the dispatcher ignores the roots variable); overall PARTIAL, with the three gaps ROADMAP names (no report scheduler, merge-back race not closed, no-origin repositories trust local ancestry) and the guard without a caller"
verified_on: phase 68 merge commits read at 286c4fb1 (the last of them); the local `main` ref (aa2ed6a0, 2026-10-24) is older and does not contain them; nothing was run by the author of this record
---

# 68-VERIFICATION: Worktree Fleet, what the fleet sees, what it may remove, and what it records

> Closure of the repository-buildable gaps, 2026-11-11: see **Closure (2026-11-11)** at the end. The tables and sections above are the 2026-10-30 reading and are kept as recorded.

## Gates

Not run by the author of this record. Each phase 68 pull request ran the repository's verify job in CI, "Typecheck, lint, tests and repo locks" (`.github/workflows/ci.yml` line 40, at 286c4fb1). The orchestrator reports that Biome, tests and `tsc` were also run in the worktrees before each PR, and that the Greptile merge gate was run by the ship loop; this record has not read those results and cites none. Evidence below is file paths, line numbers and test titles read at 286c4fb1 and the phase's merge commits (8f1ce16c #178, c77750c6 #185, 2815e161 #188, f76855a9 #189, 4e54ca65 #190, 286c4fb1 #193). Line numbers refer to 286c4fb1 unless a file is named with another commit.

## Success criteria

Criteria are the six in ROADMAP.md, Phase 68 (`.planning/ROADMAP.md` lines 1160-1182).

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `SUBSTRATE_WORKTREE_ROOTS` replaces the hard-coded root in `worktree-graph.ts`, and `@substrate/fleet` finds worktrees with `git worktree list --porcelain` from every repository under the configured roots, including linked worktrees outside them | PARTIAL | MET: `packages/fleet/src/inventory.ts` `discoverRepos` (lines 116-177), `listWorktrees` (line 67, `worktree list --porcelain -z`), and `collectInventory` (lines 438-463), which keeps every listed entry of each repository (no root filter); `packages/collectors/src/worktree-graph.ts` `worktreeRoots` reads the variable. PARTIAL: with no absolute entry the collector falls back to the hard-coded `WORKTREE_ROOT`; the dispatcher never reads the variable and uses its own fixed `WORKTREES_ROOT` (`packages/dispatcher/src/substrate_dispatcher/worktree.py` lines 25 and 136; flag-registry.ts line 311 says so). |
| 2 | `POST /worktrees/report` stores the inventory in `worktrees` (its own migration step): path, repo, branch, head, base, dirty, ahead, behind, last commit time, size, session and graph attribution, PR state when known | MET | Migration step 36 `worktrees` (`packages/mcp-server/src/index-store.ts`, expand, no `optIn` key, so it runs on every boot) with the listed columns; `packages/fleet/src/report.ts` lines 32-45 and 71-79 map `base`, `last_commit_at`, `size_bytes`, `pr_state`, `session_id`, `graph_id`; `server.ts` line 2240 `POST /worktrees/report` (401 without a surface, 503 via `worktreeGate` while the flag is off); `worktree-registry.ts` line 353 one transaction per report. Caveat: the report is sent only when `substrate worktree scan --report` runs, and nothing runs it on a schedule (see Residual risks). |
| 3 | `substrate worktree prune` is a dry run until `--execute`, removes only clean, pushed, idle worktrees whose HEAD is proven merged, never the primary checkout or the current directory, and writes one ledger note per removal; tests include a branch that advanced after its merge | MET | `packages/cli/src/worktree/command.ts` `commandPrune` (lines 320-394): dry run unless `args.execute`; re-reload and re-inspect each `safe` worktree (lines 359-372); `git worktree remove` without `--force` (line 373); `emit` one `worktree.prune` note (line 378). `packages/fleet/src/classify.ts` `classifyForPrune` (lines 56-97) is the class rule. Tests: `classify.test.ts` "a branch that gained commits after its pull request merged is review, never safe" (line 82), "a squash-merged branch is safe because HEAD equals the merged pull request head" (line 89), "the current directory, or one inside the worktree, is never" (line 68); `command.test.ts` "a branch that gained a commit after the inventory is not removed on the strength of its old merged pull request" (line 690). Ignored work counts as `review`, not `never` (classify.ts lines 79-84), so it is not removed (see Residual risks on the class name). |
| 4 | `substrate worktree conflicts` lists, for one repository, the changed files per worktree against the merge base, the overlapping pairs, a `git merge-tree` prediction for each pair and a suggested merge order | MET | `packages/fleet/src/conflicts.ts`: `changedFiles` (line 112), `supportsMergeTree` (line 89, needs git 2.38), the `git merge-tree --write-tree --name-only` call (line 142), `suggestMergeOrder` (line 152), `forecastConflicts` (line 179). `command.ts` `commandConflicts` (line 452). Tests: `conflicts.test.ts` "two branches editing the same lines conflict, different regions and files do not, and nothing is touched" (line 40), "an older git reports unavailable and never runs merge-tree" (line 79); `command.test.ts` "names conflicting pairs, the overlap files and a merge order for one repository named by directory" (line 472). Caveat: on git older than 2.38 the forecast lists overlaps with no prediction, and says so. |
| 5 | `SUBSTRATE_WORKTREE_MIN_FREE_GB` is enforced by `substrate worktree provision` and the dispatcher's `ensure_worktree`, and the doctor reports worktree disk use against it | MET | `command.ts` line 494 `assertDiskFloor(target, minFreeGbFromEnv(deps.env), ...)`; `packages/fleet/src/config.ts` lines 40-42 read the variable (default 5); `packages/fleet/src/disk.ts` `assertDiskFloor` (line 46); `worktree.py` `min_free_bytes` and the refusal before any git command (module header, line 6, and the check near line 148). `scripts/doctor-runtime.ts` `gatherWorktreeDisk` (around line 884) is report-only and adds a row only when `SUBSTRATE_WORKTREE_ROOTS` names a root (`worktreeOptionsFromEnv`). Caveat: the dispatcher checks free space on `/` only. |
| 6 | With the registry on, `memory_brief` names other sessions' worktrees that touch files the caller's worktree touches | MET | `packages/mcp-server/src/brief-sessions.ts` `worktreesSection` (line 256) and its bounds (lines 172-177); the gate in `packages/mcp-server/src/service.ts` `liveBriefSections` (line 3541: no section unless the sessions flag or `worktreeRegistry.mode` is on); f76855a9 excludes a clean merged or closed row (`brief-sessions.ts` lines 260-261). Tests, `brief-worktrees.service.test.ts` (c77750c6): "names another session's worktree that shares a file, and only that" (line 87), "registry off: no section and the registry is never read" (line 116), "a registry read that fails drops only this section" (line 135); `brief-sessions.test.ts`: "lists another session's worktree that shares a file" (line 264), "another session's worktree whose pull request is merged or closed is left out" (line 322). Caveat: no live brief was produced; the section depends on `repo` and `session_id` in the request and on reports that carry a file list. |

## Safety rules as the code states them

These are the rules as read, not as the context or the messages describe them.

- **Prune never deletes** a primary checkout, the worktree holding the current directory, a locked worktree, a worktree with a live graph claim (`never`), a dirty worktree (uncommitted or untracked change, or a failed `git status`), or a head that is neither pushed nor a merged pull request's head (`never`, `classify.ts` lines 58-75). A worktree with an unverified claim, ignored work, an idle or unknown activity time, an unproven merge, a branch that advanced after its pull request merged, or a missing directory is `review` and is not removed by `--execute` (`classify.ts` lines 77-95).
- **Prune removes only `safe`**, after the identity is reloaded from git and the claim is asked again just before removal (`command.ts` lines 356-373).
- **Merge-back never deletes.** It emits one `worktree.merge_back` note with `retained: true` per eligible worktree (`merge-back.ts` lines 128-137, 177). It has no `remove`, `branch`, `push`, `merge` or `checkout` call (grep of the file at 286c4fb1 is empty). Its refusals are listed in the module comment (lines 6-14), and a primary checkout is refused (line 83).
- **Guard is read-only** (`workspace-guard.ts` lines 8-10; test "the guard writes nothing: no remove, no branch delete and no other write verb is called", `command.test.ts` line 1011). It refuses on any probe failure. Symbolic links are refused as they stand and their targets are not read (lines 126-129). A primary checkout inside the workspace is refused (line 183); a `.planning/` directory is refused (line 188).
- **Live claims fail closed.** `claims.ts` maps a missing token, an unreachable server, a bad status or an unreadable reply to `unverified`, and `classify.ts` turns `unverified` into `review`.

## Evidence read

- Commits: `git show --stat` for 8f1ce16c (70 files), c77750c6 (38 files), 2815e161 (6 files), f76855a9 (3 files), 286c4fb1 (11 files), and 4e54ca65 (2 files, doctor).
- Files at 286c4fb1: `packages/fleet/src/{classify,inventory,conflicts,claims,ignored,pr,report,disk,config}.ts`, `packages/cli/src/worktree/{command,merge-back}.ts`, `packages/fleet/src/workspace-guard.ts` (blob identical at 2815e161 and 286c4fb1), `packages/collectors/src/worktree-graph.ts`, `packages/mcp-server/src/{index-store,flag-registry,event-sources,brief-sessions,worktree-registry,server,admission}.ts`, `packages/audit/src/policy.ts`, `packages/dispatcher/src/substrate_dispatcher/worktree.py` (the header and the constants), `scripts/doctor-runtime.ts` (the disk and checkout sections), `.github/workflows/ci.yml`, `docs/worktree-fleet-api.md` (headings and flag table only).
- Migration steps read at 286c4fb1: 36 (`worktrees`), 40 (`worktrees_changed_files`), 41 (`worktrees_repo_lower_seen_idx`). None carries an `optIn` key, so none is gated by an opt-in migration flag; the registry routes are gated by `SUBSTRATE_WORKTREE_REGISTRY`.

## Residual risks

- **Ignored work is `review`, not `never`.** Both block removal by `--execute`, but the class name matters to an operator reading the dry run. The context (D68-3) says ignored work makes a worktree "not clean"; the code says `review`.
- **No scheduler.** Nothing in the tracked non-markdown files runs `substrate worktree scan --report` (grep at 286c4fb1, excluding tests and markdown). The registry, the brief section and the claims lookup are only as fresh as the last manual run.
- **Merge-back's check-then-note race is narrowed, not closed.** `decide` reads state, `unchangedSince` (merge-back.ts lines 122-125) reloads HEAD, branch and detached state, and the note then emits. A move of HEAD before the reload is refused; a move after it leaves the note true, because it names the verified commit (lines 117-121). `unchangedSince` does not compare cleanliness, so an edit made after the dirty check and before the note is not seen. The note's payload does not assert cleanliness, but it does assert a merge.
- **Prune's last check and `git worktree remove` are separate steps.** Ignored files written in between are removed with the worktree, because `git worktree remove` deletes ignored files without asking (the header of `ignored.ts` says so). This is the same window as any check-then-act.
- **A repository with no origin trusts local ancestry.** Merge-back's `origin/HEAD` check applies only when an origin remote exists (merge-back.ts lines 94-96); without one, `resolveDefaultRef` falls back to a local `main` or `master` (`inventory.ts` lines 281-288) and a commit that is an ancestor of it is recorded as merged. Commit 476b7dc5 added a test for the origin-but-no-`origin/HEAD` case; no test in the phase 68 test files covers a repository with no origin at all (grep). Prune's `pushed` fact is satisfied by the same local ancestry (`inventory.ts` line 394, `merged`).
- **The guard has no caller in the repository.** `workspaceGuard` is reached only through `substrate worktree guard DIR` (command.ts lines 532-542; grep at 286c4fb1). Nothing in the repository runs the guard before a workspace removal.
- **Dispatcher scope.** The dispatcher checks free space only on `/`, does not read `SUBSTRATE_WORKTREE_ROOTS`, and creates under one fixed root.
- **Live claims only for graph-shaped paths.** A checkout whose first segment under a root is not a graph id is never asked about, so a live claim on it cannot be seen. A checkout outside every root is the same (merge-back.ts lines 12-13).
- **Commit messages that do not match the code.** 8f1ce16c says "migration 35" (it is 36, with 40 and 41 from c77750c6), names a `worktrees_report` tool that does not exist, and says the dispatcher accounts "across roots" (it checks `/` only). The squash subjects of #187 to #192 all read "Discover the remaining gsd-autonomous phases…" and do not describe the change.
- **Git-version dependence.** The conflict prediction needs git 2.38 or newer. This record did not check the git version on any host.
- **The merged-PR proof depends on `gh`.** Without `gh`, `pr_state` is `unknown`, so a squash-merged branch whose HEAD is not in the default branch is `review`. That fails safe, but the prune reports it as unprovable, not as merged.
- **Bounds.** The ignored walk stops at 5,000 files, 50,000 entries or 10 seconds and then counts the rest as work (`ignored.ts` constants). The repository scan stops at 20,000 directories (`inventory.ts` `DEFAULT_DISCOVER_ENTRIES`). Both are fail-safe; a large checkout may show `review` for reasons unrelated to its contents.
- **REQUIREMENTS.md** in this worktree still shows FLEET-01 to FLEET-06 unchecked and the table row "Planned"; this record does not edit it.

## Operator-gated

Installing a timer or hook that runs `substrate worktree scan --report` or `prune` on any host (no timer or hook is in the repository); setting `SUBSTRATE_WORKTREE_REGISTRY=on` in any environment (default off, per flag-registry.ts line 309); setting `SUBSTRATE_WORKTREE_ROOTS` on any host so the doctor row and the collector's attribution use it; running `substrate worktree prune --execute` on a real host (this record ran none); running `merge-back --execute` on a real checkout; calling `substrate worktree guard` from any workspace-removal path; changing `SUBSTRATE_WORKTREE_MIN_FREE_GB` from 5 GB; the doctor's checkout rows (#190) are report only and were not run.

## Closure (2026-11-11)

Scope: the gaps this record and ROADMAP name, closed where the repository can close them. The 2026-10-30 reading above is kept as recorded; only the frontmatter status line changed. Branch `reconcile/main-2026-11-11`; the commit that carries this closure is named in the commit log, not here. Nothing was pushed, deployed, installed on a host, or run against a live server or registry.

### Tests run for this closure

- `python3 -m pytest packages/dispatcher/tests/test_worktree.py packages/dispatcher/tests/test_dispatch.py`: 90 passed.
- `bun test packages/cli/src/worktree/command.test.ts packages/cli/src/worktree/scope.test.ts packages/fleet/src/classify.test.ts packages/fleet/src/inventory.test.ts scripts/worktree-report.test.ts scripts/config-reference.test.ts packages/mcp-server/src/flag-registry.test.ts`: 208 passed, 0 failed, 7 files.
- `bunx tsc --noEmit`: exit 0.
- Mutation check: the two no-origin tests (`inventory.test.ts`, `classify.test.ts`) fail when the `pushed` line is restored to its 2026-10-30 form, and pass with the fix.

### Per criterion

| # | Criterion | 2026-10-30 | Now | Evidence |
|---|---|---|---|---|
| 1 | `SUBSTRATE_WORKTREE_ROOTS` replaces the hard-coded root; the fleet finds worktrees from every root and linked worktrees outside them | PARTIAL: the dispatcher never read the variable | MET | The dispatcher now reads it. `worktree_roots` and `worktree_root` in `packages/dispatcher/src/substrate_dispatcher/worktree.py` (lines 61 and 78) parse the variable the way `worktreeRoots` does (absolute entries in order, normalised, de-duplicated) and fall back to `/var/lib/substrate/worktrees`. `ensure_worktree` takes `root=None` and resolves it at call time; `dispatch.py` line 537 passes no root. Tests in `packages/dispatcher/tests/test_worktree.py`: `test_worktree_root_is_the_first_absolute_entry` (7 cases), `test_worktree_roots_keeps_order_drops_relative_and_duplicates`, `test_worktree_root_reads_the_environment_at_call_time`, `test_ensure_worktree_creates_under_the_configured_root`. The fleet and the collector were already MET. |
| 2 | `POST /worktrees/report` stores the inventory; the CLI sends it | MET, caveat: the report runs only when `scan --report` runs | MET; the caveat is narrowed | A scheduled entry point now exists (gap 2 below). Installing a timer that runs it is operator-gated. |
| 3 | `prune` dry run, safe classes, one note per removal | MET | MET, unchanged | No change to prune's removal rules. The no-origin change below makes a local-only repository's worktrees `never` (see gap 4). |
| 4 | `conflicts` | MET | MET, unchanged | Not touched. |
| 5 | `SUBSTRATE_WORKTREE_MIN_FREE_GB` enforced by `provision` and `ensure_worktree`; doctor reports | MET, caveat: the dispatcher checks `/` only | MET; the caveat is closed | `ensure_worktree` measures the nearest existing ancestor of the root (`_space_probe`, line 88; `probe = _space_probe(root)`, line 187) and refuses with `low-disk` when that filesystem is short. Tests: `test_ensure_worktree_disk_floor` (now asserts the probed path is the root's filesystem, not `/`) and `test_ensure_worktree_floor_is_read_on_the_configured_root_filesystem`, which fails if `/` is read instead. |
| 6 | Registry on: `memory_brief` names other sessions' worktrees that share files | MET | MET, unchanged | Not touched. |

### Per gap

**Gap 1, dispatcher ignores the roots variable (ROADMAP, criterion 1): CLOSED.** See criterion 1.

**Gap 2, no report scheduler (ROADMAP): CLOSED IN THE REPOSITORY; installing the timer is OPERATOR-GATED.**
- Entry point: `scripts/worktree-report.ts` runs `substrate worktree scan --report --keep-sessions` through `runWorktree`, with the same dependencies the CLI uses. The dependencies are factored into `packages/cli/src/worktree/deps.ts` (`worktreeDeps`, `substrateUrl`, `requestTimeoutMs`); `packages/cli/src/index.ts` now calls it, and its `base()` and `timeout()` delegate to the same functions. No unit file was added; the script is called by `ExecStart` the way `infra/vps` units call `scripts/doctor-runtime.ts`.
- Session attribution: the timer would otherwise clear the attribution a session's hook sent (the doc's own warning). `--keep-sessions` (`packages/cli/src/worktree/args.ts`, `command.ts`) carries forward the session the registry holds for each worktree that no live claim and no `--session` names. Precedence is explicit `--session`, then claim, then the kept session. The kept session is read with `GET /worktrees?host=<host>&limit=500` (`httpRegistryLister`, `parseRegistryBody`).
- Fail closed: a failed listing, or one with `truncated: true`, posts nothing and exits 1 with `cannot keep session attribution`. Tests: `command.test.ts`, describe "scan --report --keep-sessions" (7 tests: parse; no read without the flag; usage error without `--report`; kept session applied and other paths ignored; claim beats kept; `--session` beats kept; failed and truncated listings post nothing and exit 1) and describe "httpRegistryLister" (4 tests: host and bearer; no token; refused, malformed, unreachable and timed-out replies are failures; `parseRegistryBody`). `scripts/worktree-report.test.ts`: no root exits 2; an unreadable registry exits 1, posts nothing and says so.
- Exit codes: 0 reported; 1 the listing or the report failed (the server answers 503 while the registry is off, so the run exits 1); 2 no root.
- Operator-gated: adding the host unit that runs `bun scripts/worktree-report.ts` (WorkingDirectory the release, the environment file names `SUBSTRATE_WORKTREE_ROOTS`, `SUBSTRATE_URL` and the claude-code token by name); setting `SUBSTRATE_WORKTREE_REGISTRY=on` on the server.

**Gap 3, the dispatcher checks free space on `/` only (criterion 5 caveat; ROADMAP residual "Dispatcher scope"): CLOSED.** The floor is read on the filesystem that holds the root. Tests as in criterion 5.

**Gap 4, a repository with no origin trusts local ancestry (residual risk, 2026-10-30): CLOSED for prune and merge-back.**
- Cause: `base.pushed = remoteHasHead || base.merged === true` (`packages/fleet/src/inventory.ts`). Without an origin, or without `origin/HEAD`, the default branch is local, so a commit merged into it counted as pushed.
- Fix: `pushed` also needs the default branch to be a remote branch (`defaultIsRemote`, `inventory.ts` lines 393-397). Prune's `pushed` rule (`classify.ts` line 72) and merge-back's `head is not pushed` refusal (`merge-back.ts` line 98) read the same field, so both now refuse such a repository. Its worktrees are `never` for prune and refused for merge-back; nothing is removed or recorded there.
- Tests: `inventory.test.ts` "a repository with no origin never has a commit pushed, even one merged into its local main"; `classify.test.ts` "a repository with no origin is never safe to prune, even when HEAD is merged into its local main" (`never`, "head is not pushed"); `command.test.ts` merge-back "a repository with no origin is refused: ... nothing is recorded". Both fleet tests were run against the 2026-10-30 line and failed; they pass with the fix.
- Behaviour change for operators: a local-only repository no longer has prunable or mergeable worktrees. The fix errs toward refusal.

**Gap 5, the guard has no caller (residual; the record lists it under operator-gated): NOT CLOSED IN THE REPOSITORY; operator-gated.**
- `substrate worktree guard DIR` is a workspace check, and the record already lists "calling `substrate worktree guard` from any workspace-removal path" as operator-gated. The repository has no workspace-removal path of its own.
- Prune is the only removal in the repository, and it removes a worktree, not a workspace. The guard cannot be applied to a worktree: it refuses any root holding a `.planning/` directory (`packages/fleet/src/workspace-guard.ts` line 188, `PLANNING_REFUSAL`), and every worktree of this repository has one (679 tracked files under `.planning/`). Wiring it into prune would refuse every worktree of the repository. Not changed.

**Gap 6, merge-back's check-then-note race (residual): NOT CLOSED; narrowed only as the record says.**
- The window is between the cleanliness check and the ledger write. Closing it needs a lock that external editors and hooks would have to honour, which the repository cannot provide. Comparing cleanliness in `unchangedSince` would narrow the window further, not close it. Not changed, because a partial fix would read as closed.

**Unchanged residual risks (not gaps the record lists as repo-buildable):** ignored work is `review` rather than `never`; prune's last check and `git worktree remove` are separate steps; the bounds on the ignored walk and the repository scan; the conflict prediction needs git 2.38 or newer; the merged-PR proof depends on `gh`; the squash subjects and the "migration 35" wording in commit messages.

### Operator-gated after this closure

- Installing the host timer for `bun scripts/worktree-report.ts`. No timer or unit exists in the repository for it.
- Setting `SUBSTRATE_WORKTREE_ROOTS` on a dispatcher host. That moves where the dispatcher creates new worktrees to the first entry. Worktrees already under `/var/lib/substrate/worktrees` stay where they are; the collector attributes them only if that directory is also in the list.
- Setting `SUBSTRATE_WORKTREE_REGISTRY=on` on a server, and running `prune --execute` or `merge-back --execute` on a real host (unchanged).
- Calling `substrate worktree guard` from a workspace-removal path (gap 5).

### Files changed

- `packages/dispatcher/src/substrate_dispatcher/worktree.py`, `dispatch.py` (refusal text), `tests/test_worktree.py`
- `packages/fleet/src/inventory.ts`, `inventory.test.ts`, `classify.test.ts`, `config.ts` (comment)
- `packages/cli/src/worktree/args.ts`, `command.ts`, `command.test.ts`, `scope.test.ts` (dependency stub), `deps.ts` (new), `packages/cli/src/index.ts`
- `scripts/worktree-report.ts` (new), `scripts/worktree-report.test.ts` (new)
- `packages/mcp-server/src/flag-registry.ts` (text and `readBy`), `docs/config-reference.md` (regenerated by `bun scripts/config-reference.ts`; that run also added five rows that were already in the registry but missing from the committed file: `SUBSTRATE_LEDGER_BUFFER_*`, `SUBSTRATE_LEDGER_DEAD_LETTER_*`, `SUBSTRATE_DOCS_MIGRATE_APPROVED`), `.env.example`
- `docs/worktree-fleet.md` (settings, attribution, the scheduled report, the disk floor), `docs/worktree-fleet-api.md` (flags, setup step 4)
- This record.

ROADMAP and STATE are not edited by this closure; the phase 68 PARTIAL line there is for the main agent to update.

