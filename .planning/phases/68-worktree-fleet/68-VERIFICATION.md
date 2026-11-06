---
phase: 68-worktree-fleet
verified: 2026-11-06T00:42:41Z
status: passed
score: 8/8 truths verified (0 present-behavior-unverified)
covered_files: [".planning/phases/68-worktree-fleet/68-SUMMARY.md", "packages/audit/src/policy.ts", "packages/cli/src/worktree/args.ts", "packages/cli/src/worktree/command.test.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/merge-back.ts", "packages/collectors/src/worktree-graph.test.ts", "packages/collectors/src/worktree-graph.ts", "packages/dispatcher/src/substrate_dispatcher/worktree.py", "packages/dispatcher/tests/test_worktree.py", "packages/fleet/src/claims.test.ts", "packages/fleet/src/claims.ts", "packages/fleet/src/classify.test.ts", "packages/fleet/src/classify.ts", "packages/fleet/src/config.test.ts", "packages/fleet/src/config.ts", "packages/fleet/src/conflicts.test.ts", "packages/fleet/src/conflicts.ts", "packages/fleet/src/disk.test.ts", "packages/fleet/src/disk.ts", "packages/fleet/src/ignored.test.ts", "packages/fleet/src/ignored.ts", "packages/fleet/src/inventory.test.ts", "packages/fleet/src/inventory.ts", "packages/fleet/src/pr.test.ts", "packages/fleet/src/pr.ts", "packages/fleet/src/report.test.ts", "packages/fleet/src/report.ts", "packages/fleet/src/workspace-guard.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/brief-sessions.ts", "packages/mcp-server/src/brief-worktrees.service.test.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-claims.test.ts", "packages/mcp-server/src/worktree-claims.ts", "packages/mcp-server/src/worktree-registry-fake.ts", "packages/mcp-server/src/worktree-registry.http.test.ts", "packages/mcp-server/src/worktree-registry.pg.test.ts", "packages/mcp-server/src/worktree-registry.test.ts", "packages/mcp-server/src/worktree-registry.testkit.ts", "packages/mcp-server/src/worktree-registry.ts", "scripts/doctor-runtime.ts"]
covered_digest: "v3:sha256:020d22569f50032f6f31dbe61c3b2019befb419db952e6b41c658d9556ce1b33"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 8/8
  gaps_closed: ["the Python root parser had no direct unit test (prior open item 3), closed by e958e8b1: five test functions, seven pytest items, packages/dispatcher/tests/test_worktree.py lines 282-302"]
  gaps_remaining: []
  regressions: []
---

# Phase 68: Worktree Fleet Verification Report

**Phase Goal:** Many sessions can work in git worktrees of the same repository without filling the disk, losing track of which worktree is whose, or finding out about conflicts at merge time.
**Verified:** 2026-11-06T00:42:41Z
**Status:** passed
**Re-verification:** Yes. Head a46d42c3 (prior record at head 6e5d766e, passed, 8/8). This pass covers the 14 commits in 6e5d766e..a46d42c3. It closes prior open item 3 (the Python root parser's direct unit test, e958e8b1). Criteria 1 to 8 still hold.

## Scope and method

- Head a46d42c3 (clean tree, `git status --porcelain` empty), diff base 6e5d766e. The phase directory holds `68-CONTEXT.md`, `68-SUMMARY.md` and the prior record; there is no `*-PLAN.md`, so must-haves are the ROADMAP Phase 68 success criteria 1 to 6 (criterion 1 as amended by the owner decision of 2026-11-04) plus truths 7 and 8 as carried from the prior record. Steps 4 and 5 are not applicable.
- Covered list: the same 47 entries as the prior record (set and order checked). `covered_digest` is the output of `gsd_run query verification.fingerprint .planning/phases/68-worktree-fleet <47 files>` run from the worktree at a46d42c3: `v3:sha256:23303253d41871f360982d27a3672106a0a44d558ca6e6327858dca7e04fee0d`. The prior record's Scope section quoted `v3:sha256:41aa4f00…c9ef` for the same list while its frontmatter carried `41a515df…`; this pass does not reconcile that and takes the digest from the tree.
- Covered files changed in the range (`git diff --name-only 6e5d766e..HEAD` intersected with the covered list): `packages/dispatcher/src/substrate_dispatcher/worktree.py` (docstring only, +2 -2, no code line changed); `packages/dispatcher/tests/test_worktree.py` (e958e8b1, +25); `packages/mcp-server/src/mcp.ts`, `server.ts`, `service.ts` (f0f3c04e, 884e0753, and later commits, all in the range). The mcp-server hunks were read in full: none touches the `/worktrees/report` route body, `reportWorktrees`'s store call, `liveBriefSections`, or `worktree-registry.ts` (unchanged in the range). The only worktree-related hunk in `service.ts` changes a `.catch` on the worktree-report note emit to `reportSilent("emit.worktree-report", cause)`; the store path and the 503 path are unchanged.
- Dispatcher, r36 gate (`/root/src/worktrees/backups/gates-int-r36.log`, `head=a46d42c3` at line 5): the pytest block `python3 -m pytest packages/miner/tests packages/dispatcher/tests` reports `341 passed in 2.54s`, `PY_EXIT=0`. Its `packages/dispatcher/tests/test_worktree.py` line holds 42 result marks, all `.` (no F, E or s). 42 = 35 items the prior record counted at 6e5d766e + 7 added by e958e8b1. The "239 pass" line in the same log is `scripts/phase-close-check.ts` (four lock and policy test files), not the dispatcher suite. The dispatcher's pytest results are not in the bun JUnit, so Python titles below are evidenced by the log, not by the JUnit.
- Gate r36 JUnit `/root/src/worktrees/backups/gate-r36-junit.xml`: `tests=12317 failures=0 skipped=2`; parsed as XML. Titles cited below were located as `testcase` elements with no `failure`, `error` or `skipped` child.
- Carried-forward claims (truths 1, 2, 4, 6) rest on the covered files being unchanged in the range (the intersection above) and on the r36 bun run having 0 failures. Not rerun: no test, tsc, lint or database was run in this pass.
- Debt-marker gate: no `TBD`, `FIXME`, `XXX`, `TODO`, `HACK` or `PLACEHOLDER` in the added lines of `packages/dispatcher` since 6e5d766e. Zero blockers.
- Mutation check: not run this pass.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1 (fleet and collector): `@substrate/fleet` finds worktrees via `git worktree list --porcelain` from every repository under the configured roots, including linked worktrees outside them; `SUBSTRATE_WORKTREE_ROOTS` replaces the hard-coded root in `worktree-graph.ts` | ✓ VERIFIED (carried forward) | `packages/collectors/src/worktree-graph.ts` `worktreeRoots` (lines 23-32) reads the variable, drops relative entries, and falls back to the default only when no absolute entry remains. File unchanged in the range. r36 JUnit testcase "defaults to the dispatcher directory when unset, empty or holding no absolute entry" (classname `worktreeRoots`, `packages/collectors/src/worktree-graph.test.ts` line 54), no failure child. |
| 2 | SC2: `POST /worktrees/report` stores path, repo, branch, head, base, dirty, ahead, behind, last commit time, size, session and graph attribution, PR state in `worktrees` (its own migration step) | ✓ VERIFIED (carried forward; route moved to server.ts line 2352) | Migration step 36 `worktrees` in `index-store.ts` (unchanged in range) has every listed column. Route `packages/mcp-server/src/server.ts` line 2352 (was 2336 at 6e5d766e): 401 without a surface, `worktreeGate(true)` refusal, body cap, audit, then `reportWorktrees` (`service.ts` line 5306). The range's `server.ts` hunks do not touch this route. r36 JUnit: every suite of `worktree-registry.http.test.ts`, `worktree-registry.test.ts`, `worktree-registry.pg.test.ts` and `brief-worktrees.service.test.ts` reports `failures="0" skipped="0"`. |
| 3 | SC3: `prune` is a dry run until `--execute`; removes only clean, pushed, idle, proven-merged worktrees; never the primary checkout or the current directory; one ledger note per removal; a test covers a branch that advanced after its merge | ✓ VERIFIED (carried forward) | `packages/fleet/src/classify.ts` unchanged in range; `command.ts` runs `git worktree remove` without `--force`. r36 JUnit testcase "a branch that gained commits after its pull request merged is review, never safe" (classname `classifyForPrune`, `packages/fleet/src/classify.test.ts`), present, no failure, error or skipped child. |
| 4 | SC4: `conflicts` lists changed files per worktree against the merge base, overlapping pairs, a `git merge-tree --write-tree` prediction per pair, and a suggested merge order | ✓ VERIFIED (carried forward) | `packages/fleet/src/conflicts.ts` (`MIN_MERGE_TREE_VERSION = [2, 38]`, `forecastConflicts`, `suggestMergeOrder`) unchanged in range. Covered by the r36 bun run (failures 0). |
| 5 | SC5: `SUBSTRATE_WORKTREE_MIN_FREE_GB` enforced by `provision` and the dispatcher's `ensure_worktree`; doctor reports worktree disk use against it | ✓ VERIFIED (carried forward) | `packages/dispatcher/src/substrate_dispatcher/worktree.py` `ensure_worktree` (line 183) reads free space at `_existing_ancestor(roots[0])` (lines 153-158) and refuses with `low-disk` before any git command. The range changed only its docstring. `command.ts` line 490 `assertDiskFloor(...)` (file unchanged). Python tests: `test_ensure_worktree_reads_free_space_where_the_worktree_goes` (`packages/dispatcher/tests/test_worktree.py` line 220) and `test_low_disk_refusal_names_the_filesystem_it_checked` (line 232); both in the 42 passing `test_worktree.py` items of the r36 pytest block. |
| 6 | With the registry on, `memory_brief` names other sessions' worktrees that touch the caller's files | ✓ VERIFIED (carried forward) | `brief-sessions.ts` `worktreesSection` unchanged in range. `service.ts` `liveBriefSections` (line 4152) has no hunk in the range; the range's `service.ts` hunks touch only `reportSilent` catches, the event-query default and the sync-lag reading. r36 JUnit: every suite of `brief-worktrees.service.test.ts` reports `failures="0" skipped="0"` (6 and 6 tests). |
| 7 | FLEET-02 invariant: a scan report that omits `session_id` or `graph_id` keeps the stored value, and one that carries it replaces that value (commit 4ac536e4, ancestor of HEAD) | ✓ VERIFIED (r36 JUnit named pass) | `packages/mcp-server/src/worktree-registry.ts` unchanged since 6e5d766e; the `coalesce(excluded.session_id, worktrees.session_id)` / `coalesce(excluded.graph_id, worktrees.graph_id)` upsert is at line 381 at 6e5d766e. r36 JUnit testcase "a report that omits session_id or graph_id keeps the stored value, and one that carries it replaces that value" (classname `the worktree registry against a live index`, file `packages/mcp-server/src/worktree-registry.pg.test.ts`), present, no failure, error or skipped child. This replaces the r33 citation of the prior record. |
| 8 | Dispatcher honours `SUBSTRATE_WORKTREE_ROOTS` (ROADMAP SC1 as amended by owner decision 2026-11-04): it parses the variable as the fleet does (colon separated, trimmed, absolute only, normalised, de-duplicated), reuses a worktree git already has under any configured root, and creates new ones under the first; unset falls back to the default directory | ✓ VERIFIED (parser unchanged; direct unit tests now present) | `worktree.py` `worktree_roots` (lines 62-78): `ROOTS_ENV` at line 31, `WORKTREES_ROOT` at line 27; the parser code is unchanged in the range. Direct unit tests added by e958e8b1 in `packages/dispatcher/tests/test_worktree.py`: `test_worktree_roots_defaults_when_env_unset` (line 282), `test_worktree_roots_single_entry` (287), `test_worktree_roots_two_entries_keep_their_order` (291), `test_worktree_roots_trims_entries_and_drops_empty_or_relative_segments` (295; input `"  /a  :  ::/b/c/ : relative :/x/../y:/a"` expects `/a, /b/c, /y`), and `test_worktree_roots_blank_value_falls_back_to_default` (300-302, parametrised over `""`, `"   "`, `" : : "`). Expected values were checked by reading the parser, not by execution here. Reuse under a non-first root: `test_ensure_worktree_reuses_a_registered_worktree_under_the_second_root` (line 264). All are in the 42 passing `test_worktree.py` items of the r36 pytest block. |

**Score:** 8/8 truths verified (0 present-behavior-unverified)

### Deferred Items

None. The criterion 1 gap recorded earlier (the dispatcher's disk floor on `/` only) is resolved in code (b4fe6bfe). The ROADMAP text that still says so is stale (open item 1).

### Required Artifacts

Not applicable: no `*-PLAN.md` `must_haves.artifacts` in the phase directory. Artifacts were checked by existence and wiring through the truths above.

### Key Link Verification

Not applicable: no `*-PLAN.md` `must_haves.key_links`. Wiring was checked through the truths above (`ensure_worktree` to `worktree_roots`, `_registered` and `_existing_ancestor`; route to `reportWorktrees`; `inventory.ts` to `worktree list --porcelain`).

## Open Items

1. `.planning/ROADMAP.md` line 1168 still reads "PARTIAL (criterion 1): the dispatcher ignores `SUBSTRATE_WORKTREE_ROOTS`". The code closed it (3c5dcfa0, 3cadf3e3, b4fe6bfe; truth 8). The orchestrator should update the ROADMAP text. Not edited by this verifier. REQUIREMENTS.md was not re-read in this pass.
2. Resolved (docstring only): `worktree.py` now says the filesystem a worktree lands on is the one checked. The `6e5d766e..HEAD` diff replaces the `/` sentence with that wording, although the prior record listed the change as done at 6e5d766e. Verdict unchanged.
3. Resolved in this pass (e958e8b1): the Python root parser has direct unit tests (truth 8; seven pytest items, lines 282-302). Still open within the same item: parity with the TypeScript parsers was checked ad hoc at 6e5d766e and is not a committed cross-language test.
4. No scheduler runs `substrate worktree scan --report` (carried from SUMMARY "What remains"; the registry is only as fresh as the last manual run). Operator-gated.
5. Merge-back's check-then-note race is narrowed, not closed (carried from SUMMARY).
6. A repository with no origin trusts local ancestry for "merged" and "pushed" (`inventory.ts` default-ref fallback; carried from SUMMARY).
7. The guard has no caller in removal paths: `workspaceGuard` is reached only through `substrate worktree guard` (`command.ts`).
8. Attribution is kept across silent reports by design (4ac536e4): a worktree whose session ended keeps its `session_id` until the row is swept, so the registry can name a finished session.

Operator-gated, not run: installing a timer for `scan --report` or `prune`; setting `SUBSTRATE_WORKTREE_REGISTRY=on`; setting `SUBSTRATE_WORKTREE_ROOTS` on a host; `prune --execute` or `merge-back --execute` on a real checkout.

---
