---
phase: 68-worktree-fleet
milestone: v1.7
requirements: [FLEET-01, FLEET-02, FLEET-03, FLEET-04, FLEET-05, FLEET-06]
status: merged to main in PRs #178, #185, #188, #189, #190 and #193; partial (see Deviations and What remains); no scheduler runs the report, merge-back does not close the check-then-note race, a repository with no origin trusts local ancestry, no workspace-removal caller in the repository runs the guard
---

# 68-SUMMARY: Worktree Fleet, what the fleet sees, what it may remove, and what it records

Built in edit-only units (no gsd-plan-phase run; ROADMAP "Plans: none written"). Decisions and evidence are in [68-CONTEXT.md](68-CONTEXT.md); the record of what is verified is in [68-VERIFICATION.md](68-VERIFICATION.md). Everything below was read at the last phase 68 merge, commit 286c4fb1 (see the verification record for why that commit, not the older local `main` ref, is the reading point). Operator reference: `docs/worktree-fleet-api.md`, of which this record read the headings and the flag table only.

## What was built

- **`packages/fleet` (`@substrate/fleet`, pure over git and gh).** `inventory.ts` (`discoverRepos`, `listWorktrees` over `git worktree list --porcelain -z`, `inspectWorktree`, `collectInventory`), `classify.ts` (`classifyForPrune`, the prune classes), `ignored.ts` (`findIgnoredWork`, `REGENERABLE_DIRS`), `pr.ts` (`lookupPr`, merged heads with their base branch), `claims.ts` (`claimStatus`, `GET /worktrees/claims`), `conflicts.ts` (`changedFiles`, the `git merge-tree --write-tree` forecast, `suggestMergeOrder`), `disk.ts` (`assertDiskFloor`, `diskPressure`), `report.ts` (`buildReports`), `config.ts` (flag readers). `workspace-guard.ts` arrived in 2815e161 (#188) and is unchanged since.
- **`packages/cli/src/worktree`.** `command.ts` (`list`, `status`, `scan [--report]`, `prune`, `conflicts`, `provision`, `disk`, `guard`, `merge-back`, exit codes 0, 1, 2), `args.ts`, `merge-back.ts` (#193). Tests in `command.test.ts`.
- **Collector and dispatcher.** `packages/collectors/src/worktree-graph.ts` takes its roots from `SUBSTRATE_WORKTREE_ROOTS` (`worktreeRoots`) and falls back to the previously hard-coded root when no absolute entry is set. `packages/dispatcher/src/substrate_dispatcher/worktree.py` reads `SUBSTRATE_WORKTREE_MIN_FREE_GB` (`min_free_gb`, default 5) for creation.
- **Server registry.** Migration steps 36 (`worktrees`, expand, not opt-in), 40 (`changed_files`, `files_truncated`) and 41 (`worktrees_repo_lower_seen_idx`) in `packages/mcp-server/src/index-store.ts`; `worktree-registry.ts` (`PgWorktreeRegistry`, one transaction per report: upsert, then sweep the host's rows last seen before the cutoff); routes `POST /worktrees/report`, `GET /worktrees`, `GET /worktrees/claims` in `server.ts`, classed in `admission.ts`; `worktree-claims.ts`; MCP tool `worktree_list` in `mcp.ts`; the report is REST only, listed as `worktree_report` in `packages/audit/src/policy.ts`. The routes answer 503 `worktrees.disabled` while `SUBSTRATE_WORKTREE_REGISTRY` is off.
- **Ledger vocabulary.** `worktrees.report`, `worktree.prune` and `worktree.merge_back` in `packages/mcp-server/src/event-sources.ts` (phase 68), and one line in `docs/event-vocabulary.md`.
- **Brief overlap (#185, #189).** `packages/mcp-server/src/brief-sessions.ts` `worktreesSection`: other sessions' worktrees of the caller's repository that touch files the caller's own worktrees touch, at most 5 worktrees and 5 named files each, a 24-hour window, a clean merged or closed row left out (f76855a9). Registry-gated; it needs `repo` and `session_id` in the request.
- **Doctor.** `scripts/doctor-runtime.ts` `gatherWorktreeDisk`: a report-only worktree disk row, present only when `SUBSTRATE_WORKTREE_ROOTS` names a root. #190 (4e54ca65) adds report-only primary-checkout rows (`--checkout DIR`).
- **Flags** (`packages/mcp-server/src/flag-registry.ts`, lines 309-314): `SUBSTRATE_WORKTREE_REGISTRY` (default off), `SUBSTRATE_WORKTREE_REGISTRY_TTL_S` (1209600), `SUBSTRATE_WORKTREE_ROOTS` (none), `SUBSTRATE_WORKTREE_MIN_FREE_GB` (5), `SUBSTRATE_WORKTREE_IDLE_DAYS` (14), `SUBSTRATE_SESSION_ID` (none).

## The safety rules as the code states them

- **Prune classes** (`classify.ts`, `classifyForPrune`). `never`: primary checkout, the current directory or a worktree containing it, locked, a live graph claim, dirty (`git status --untracked-files=all` is non-empty, or the status call failed), head not pushed (a head that is a merged pull request's head counts as pushed). `review`: an unverified claim, ignored work, last commit or last file activity inside the idle window, HEAD not proven merged, a branch that advanced after its pull request merged, a missing directory. `safe`: clean, pushed, idle, and HEAD proven merged (an ancestor of the default branch, or the head of a merged pull request whose base is the default branch).
- **Prune execution** (`command.ts`, `commandPrune`). `--execute` removes `safe` worktrees only. Before each removal it reloads head and branch from git, re-inspects, re-classifies, and asks the server for live claims again (lines 356-372). The removal is `git worktree remove <path>` with no `--force` (line 373). The first failed removal stops the run. Each removal emits one `worktree.prune` note; a note that is not stored is said so on stderr.
- **Ignored work** counts as `review`, not `never` (`classify.ts` line 79-84). `--execute` does not remove it. The ignored scan is bounded by entries, files and time (`ignored.ts`, `MAX_IGNORED_*`); anything that cannot be listed counts as work.
- **Merge-back** (`merge-back.ts`). Records one `worktree.merge_back` note per eligible worktree, with `retained: true`, and nothing else. Refused: prunable, dirty, no `origin/HEAD` when an origin remote exists, not pushed (unless a merged pull request has the head), HEAD not proven merged into the default branch, ignored work, a live or unverifiable claim. Before the note, HEAD, branch and detached state are reloaded and compared (`unchangedSince`). The primary checkout is refused. The module contains no `remove`, `branch`, `push`, `merge` or `checkout` call (grep of `merge-back.ts` at 286c4fb1 returns nothing).
- **Guard** (`workspace-guard.ts`, `workspaceGuard`). Read-only by its own comment (lines 8-10). Refuses a workspace when any member has uncommitted changes (untracked included), commits not on any remote, a submodule, or ignored work the primary checkout does not hold identically. Refuses a primary checkout inside the workspace (line 183), any entry outside every member (line 185, loose entries), a `.planning/` directory (line 188). A symbolic link is refused as it stands and never followed (lines 126-129). A probe that fails is a refusal.
- **Live claims** (`claims.ts`). Asked only for a worktree whose first path segment under a configured root is graph-id shaped and that is otherwise `safe` (`command.ts` `classifyAll`). A claim that cannot be checked is `review`, never `safe`.

## Key decisions

- **D68-1 (what exists), partly held.** Claims stay per graph node. The hard-coded root is replaced in the collector (`worktree-graph.ts`), not in the dispatcher, which still creates under its fixed directory (`worktree.py`, `WORKTREES_ROOT`). Changed: the context said nothing removes a worktree; `prune --execute` does now, within the rules above.
- **D68-2 (git discovery), held.** `inventory.ts` finds linked worktrees through `git worktree list`, and `collectInventory` keeps every listed entry, including linked worktrees outside the roots.
- **D68-3 (prune classes), held, with one change.** The context puts ignored work among the facts that make a worktree "not clean". The code classes it as `review`. Either way `--execute` does not remove it.
- **D68-4 (conflict forecast), held.** `conflicts.ts`, `supportsMergeTree`: git 2.38 or newer, otherwise the overlaps are listed without a prediction.
- **D68-5 (registry is a report), held.** The routes store what a reporter sends. The server never touches a worktree. The CLI does the removals.
- **D68-6 (one disk floor), held for the flag.** Both `fleet/config.ts` (`minFreeGbFromEnv`) and `worktree.py` (`min_free_gb`) read `SUBSTRATE_WORKTREE_MIN_FREE_GB`. The dispatcher checks free space on `/` only (`worktree.py` module header and `min_free_bytes` use).

## Deviations from the plan and the commit messages

- **Migration numbers.** The 8f1ce16c message says "migration 35". Step 35 is `corpus_documents` (phase 63). The registry is step 36, and its additions are steps 40 and 41, added in c77750c6 (#185).
- **Tool name.** The 8f1ce16c message names a `worktrees_report` tool. No such name exists in the tree at 286c4fb1 (`git grep`). The report is REST only.
- **Dispatcher accounting.** The 8f1ce16c message says "the dispatcher's disk-floor accounting across roots". The dispatcher checks `/` only and does not read `SUBSTRATE_WORKTREE_ROOTS`; the flag table says so (flag-registry.ts line 311).
- **Squash subjects.** The squash subjects of #187 to #192 (91e88d4a, 4e54ca65, 7570fca8, f76855a9, 2815e161, 1a8de76c) all read "Discover the remaining gsd-autonomous phases, establish how multi-sessi…". The subject does not describe the change; the body does. The records cite the body.
- **Merge date.** The commit 8f1ce16c has author time 2026-10-30 06:04 +1100, which is 2026-10-29 UTC, the date the orchestrator's brief gives for #178. The brief's dates are UTC and this record uses them.

## Findings

Review rounds are visible only in the commit messages, not in the Greptile threads, which this record did not read. 8f1ce16c's message lists fix commits labelled as review rounds 1 to 4 (live claims, head reload, ignored files by name, bounded scans, `conflicts --repo` root handling, linked `--repo`). c77750c6's message describes a fleet-brief review (session labels, redaction order, a capped read counted as incomplete, a lookup index). 286c4fb1's message reports "seven review fixes and the prune base filter" and a fix that makes merge-back refuse a merge proven only against a local default branch.

## What remains

- No scheduler runs `substrate worktree scan --report`. Nothing in the tracked non-markdown files runs it (grep at 286c4fb1). The registry is therefore only as fresh as a human's last run.
- Merge-back narrows the check-then-note race; it does not close it. `unchangedSince` compares HEAD, branch and detached state, not cleanliness, so a file edited after the checks and before the note is not seen.
- A repository with no origin remote trusts local ancestry. `decide` skips the `origin/HEAD` check when there is no origin (merge-back.ts line 95-96), and `resolveDefaultRef` falls back to a local `main` or `master` (`inventory.ts` lines 281-288). Prune's `pushed` fact is then satisfied by local ancestry too.
- Prune's last claim check and its `git worktree remove` are separate steps. A write between them is not detected. Ignored files created in that window would be removed.
- Only the `substrate worktree guard DIR` subcommand calls `workspaceGuard` (grep at 286c4fb1). The guard is a check that a caller must run before any workspace removal; nothing in the repository makes that call before a removal.
- The dispatcher neither reads `SUBSTRATE_WORKTREE_ROOTS` nor checks free space on any root other than `/`.
- The live-claim check runs only for a worktree whose first segment under a root is graph-id shaped. A checkout outside every root is never asked about, by design (merge-back.ts lines 12-13).
- Operator-gated and not done: installing a timer or hook that runs `scan --report` or `prune` on any host; setting `SUBSTRATE_WORKTREE_REGISTRY` in any environment; running `prune --execute` on a real host (this record ran no prune; the context counts 106 directories under the worktree root on this host); the doctor row is report only.
- The REQUIREMENTS.md checkboxes for FLEET-01 to FLEET-06 and the "Planned" table row are unchanged in this worktree. This record does not edit them.
