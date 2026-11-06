---
phase: 68-worktree-fleet
verified: 2026-11-06T02:57:23Z
status: passed
score: 8/8 truths verified (0 present-behavior-unverified)
covered_files: [".planning/phases/68-worktree-fleet/68-SUMMARY.md", "packages/audit/src/policy.ts", "packages/cli/src/worktree/args.ts", "packages/cli/src/worktree/command.test.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/merge-back.ts", "packages/collectors/src/worktree-graph.test.ts", "packages/collectors/src/worktree-graph.ts", "packages/dispatcher/src/substrate_dispatcher/worktree.py", "packages/dispatcher/tests/test_worktree.py", "packages/fleet/src/claims.test.ts", "packages/fleet/src/claims.ts", "packages/fleet/src/classify.test.ts", "packages/fleet/src/classify.ts", "packages/fleet/src/config.test.ts", "packages/fleet/src/config.ts", "packages/fleet/src/conflicts.test.ts", "packages/fleet/src/conflicts.ts", "packages/fleet/src/disk.test.ts", "packages/fleet/src/disk.ts", "packages/fleet/src/ignored.test.ts", "packages/fleet/src/ignored.ts", "packages/fleet/src/inventory.test.ts", "packages/fleet/src/inventory.ts", "packages/fleet/src/pr.test.ts", "packages/fleet/src/pr.ts", "packages/fleet/src/report.test.ts", "packages/fleet/src/report.ts", "packages/fleet/src/workspace-guard.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/brief-sessions.ts", "packages/mcp-server/src/brief-worktrees.service.test.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-claims.test.ts", "packages/mcp-server/src/worktree-claims.ts", "packages/mcp-server/src/worktree-registry-fake.ts", "packages/mcp-server/src/worktree-registry.http.test.ts", "packages/mcp-server/src/worktree-registry.pg.test.ts", "packages/mcp-server/src/worktree-registry.test.ts", "packages/mcp-server/src/worktree-registry.testkit.ts", "packages/mcp-server/src/worktree-registry.ts", "scripts/doctor-runtime.test.ts", "scripts/doctor-runtime.ts"]
covered_digest: "v3:sha256:0a8c263e1fbe488d4bc09383fad4dc8c9c44b717910c376d1d372156e33ef881"
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
**Verified:** 2026-11-06T02:57:23Z
**Status:** passed
**Re-verification:** Yes. Head 5e304ef8 (prior record at head a46d42c3, passed, 8/8). This pass covers the 14 commits in a46d42c3..5e304ef8. Criteria 1 to 8 still hold. Open item 1 of the prior record is closed in ROADMAP. The r39 gate was not yet complete when this draft was written (see Scope).

## Scope and method

- Head 5e304ef8 (`git status --porcelain` empty), diff base a46d42c3 (the prior record's head). The phase directory holds `68-CONTEXT.md`, `68-SUMMARY.md` and the prior record; there is no `*-PLAN.md`, so must-haves are the ROADMAP Phase 68 success criteria 1 to 6 (criterion 1 as amended by the owner decision of 2026-11-04) plus truths 7 and 8 as carried from the prior record. Steps 4 and 5 are not applicable.
- Covered list: the 47 entries of the prior record plus `scripts/doctor-runtime.test.ts`, which holds the "worktree disk row" titles cited under criterion 5. `covered_digest` is the output of `gsd_run query verification.fingerprint .planning/phases/68-worktree-fleet <48 files>` run from the worktree at 5e304ef8 (read-only): `v3:sha256:0a8c263e1fbe488d4bc09383fad4dc8c9c44b717910c376d1d372156e33ef881`. The `covered_files` frontmatter is the list that query returned.
- Covered files changed in the range (`git diff --name-only a46d42c3 5e304ef8` intersected with the covered list). Every hunk was read. None changes behaviour.
  - Export keyword removed only (commits b8cbdeac, d9d0a401, 4c576e5e, 8ec17832, 66fa97bd, 5e304ef8): `packages/audit/src/policy.ts`; `packages/cli/src/worktree/args.ts`; `packages/cli/src/worktree/command.ts`; `packages/fleet/src/{config,conflicts,disk,ignored,inventory,pr,report,workspace-guard}.ts`; `packages/mcp-server/src/{admission,brief-sessions,event-sources,flag-registry,index-store,mcp,server,service,worktree-claims,worktree-registry}.ts`. Declarations that code outside their file imported were not affected: a grep of every `import` of the removed names across `packages/` and `scripts/` found no importer of a covered name (the `Inventory` hits are `packages/cli/src/corpus/inventory.ts`, a different module).
  - Comment lines added only: `packages/fleet/src/ignored.ts` (`sameContent`), `packages/fleet/src/pr.ts` (`parsePrList`), `packages/mcp-server/src/index-store.ts` (`/healthz` probe), `packages/mcp-server/src/worktree-registry.ts` (`filesFromText`).
  - `packages/mcp-server/src/server.ts`: a five-line REST `/handoff` check inserted at line 1507 (commit 14ac787a). It is outside the `/worktrees/report` route and does not touch the worktree path. The route moved from line 2352 to 2357 because of that insertion; its body is unchanged.
  - `packages/mcp-server/src/service.ts`: the only non-export change is the `manifestCommit` lambda at line 6421 (corpus, phase 63 scope). No worktree-related hunk is in the range.
- Covered files NOT changed in the range: `worktree-graph.ts` and its test; `classify.ts`; `claims.ts`; `conflicts.ts` logic; `merge-back.ts`; `dispatcher/src/substrate_dispatcher/worktree.py` (its docstring change was at 6e5d766e..a46d42c3, already in the prior record); `dispatcher/tests/test_worktree.py`; `scripts/doctor-runtime.ts`; `brief-worktrees.service.test.ts`; the `worktree-registry` test files; `worktree-claims.ts` logic.
- Test evidence. The source of truth for bun pass/fail is `/root/src/worktrees/backups/gate-r38-junit.xml`, run at 66fa97bd. Between 66fa97bd and 5e304ef8 the only changed files are `packages/mcp-server/src/config.ts`, `packages/mcp-server/src/hindsight-canary-run.ts` and `scripts/code-ratchet.baseline.json` (commit 5e304ef8). None is covered, so the r38 results for the covered files hold at HEAD. The r38 JUnit has `tests=12322 failures=1 skipped=2`. The single failure is `scripts/code-ratchet.test.ts`, "the ratchet is tight: no source counter sits below its baseline", which commit 5e304ef8 is recorded as fixing (baseline lowered); this verifier did not rerun it, and it is outside this phase. None of the titles cited below has a failure, error or skipped child. Suite totals for the covered files are 0 failures and 0 skipped.
- Python titles (`packages/dispatcher/tests/test_worktree.py`) are not in a bun JUnit. Their pass evidence is the r36 pytest block (`/root/src/worktrees/backups/gates-int-r36.log`, `PG_READY ... head=a46d42c3` at line 5, `packages/dispatcher/tests/test_worktree.py` marks at line 16418, `341 passed in 2.54s`, `PY_EXIT=0` at lines 16421-16422). These files have not changed since a46d42c3 except the `worktree.py` docstring, which is not behaviour. The r39 gate has not yet written `/root/src/worktrees/backups/gate-r39-junit.xml`; no pass count is claimed here.
- Owner decisions: none dated 2026-11-06 apply to phase 68 (the owner's 2026-11-06 decisions cover phases 67, 74 and 75 only). The recorded decision carried here is the 2026-11-04 amendment of criterion 1 (truth 8). All owner items for this phase stay open; no structured override exists for them. See Open Items.
- Debt-marker gate: no `TBD`, `FIXME`, `XXX`, `TODO`, `HACK` or `PLACEHOLDER` in the lines added in `a46d42c3..5e304ef8` to the covered files. Zero blockers.
- Mutation check: not run this pass.
- Not run: no test, tsc, lint, gate or verification writer was run in this pass. Read-only git, grep and `gsd_run query verification.fingerprint` only.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1 (fleet and collector): `@substrate/fleet` finds worktrees via `git worktree list --porcelain` from every repository under the configured roots, including linked worktrees outside them; `SUBSTRATE_WORKTREE_ROOTS` replaces the hard-coded root in `worktree-graph.ts` | ✓ VERIFIED (carried forward) | `packages/collectors/src/worktree-graph.ts` `worktreeRoots` (lines 23-32) reads the variable, drops relative entries, and falls back to the default only when no absolute entry remains. Neither the file nor its test changed in the range. r38 JUnit testcase "defaults to the dispatcher directory when unset, empty or holding no absolute entry" (classname `worktreeRoots`, `packages/collectors/src/worktree-graph.test.ts` line 54), no failure, error or skipped child. |
| 2 | SC2: `POST /worktrees/report` stores path, repo, branch, head, base, dirty, ahead, behind, last commit time, size, session and graph attribution, PR state in `worktrees` (its own migration step) | ✓ VERIFIED (carried forward; route at server.ts line 2357) | Migration `version: 36`, `name: "worktrees"` in `packages/mcp-server/src/index-store.ts` (line 736; step body unchanged in range) has every listed column. Route `packages/mcp-server/src/server.ts` line 2357 (was 2352 at a46d42c3, shifted by the 14ac787a insertion at line 1507): 401 without a surface (2358-2361), `worktreeGate(true)` refusal, `validateWorktreeReport` with the contract's body cap, 400 `worktrees.invalid`, `auditedRest`, then `substrate.reportWorktrees` (`service.ts` line 5306, unchanged). The range's `server.ts` hunks do not touch the route body. r38 JUnit: `worktree-registry.http.test.ts` (42 tests), `worktree-registry.pg.test.ts` (26), `worktree-registry.test.ts` (168) and `brief-worktrees.service.test.ts` (12) all report `failures="0" skipped="0"`. |
| 3 | SC3: `prune` is a dry run until `--execute`; removes only clean, pushed, idle, proven-merged worktrees; never the primary checkout or the current directory; one ledger note per removal; a test covers a branch that advanced after its merge | ✓ VERIFIED (carried forward) | `packages/fleet/src/classify.ts` (`classifyForPrune`, line 56) unchanged in range. `packages/cli/src/worktree/command.ts` line 374 runs `git worktree remove` with no `--force`; the range changed only the export keyword and `WORKTREE_USAGE`. r38 JUnit testcase "a branch that gained commits after its pull request merged is review, never safe" (classname `classifyForPrune`, `packages/fleet/src/classify.test.ts` line 82), no failure, error or skipped child. |
| 4 | SC4: `conflicts` lists changed files per worktree against the merge base, overlapping pairs, a `git merge-tree --write-tree` prediction per pair, and a suggested merge order | ✓ VERIFIED (carried forward; export keyword removed in range) | `packages/fleet/src/conflicts.ts`: `forecastConflicts` (line 179), `suggestMergeOrder` (line 152), `MIN_MERGE_TREE_VERSION = [2, 38]` (line 78, now module-private). The range changed only export keywords and type declarations. r38 JUnit testcases, `packages/fleet/src/conflicts.test.ts`, no failure, error or skipped child: "two branches editing the same lines conflict, different regions and files do not, and nothing is touched" and "an older git reports unavailable and never runs merge-tree" (`forecastConflicts`, lines 40 and 79); "no overlaps first, then fewer files, ties by path" and "the later of a conflicting pair is flagged for a rebase" (`suggestMergeOrder`, lines 107 and 124). The file's suite totals are 20 tests, 0 failures. |
| 5 | SC5: `SUBSTRATE_WORKTREE_MIN_FREE_GB` enforced by `provision` and the dispatcher's `ensure_worktree`; doctor reports worktree disk use against it | ✓ VERIFIED (carried forward) | `packages/dispatcher/src/substrate_dispatcher/worktree.py`: `ensure_worktree` (def line 161) reads free space at `_existing_ancestor(roots[0])` (def lines 153-158; probe line 183) and refuses with `low-disk` (lines 186-190) before `repo = Path(repo)` and any git command. The file is unchanged since a46d42c3. `packages/cli/src/worktree/command.ts` line 490 `assertDiskFloor(target, minFreeGbFromEnv(...))` (logic unchanged). Doctor: `scripts/doctor-runtime.ts` (worktree disk row, line 796) unchanged in range; r38 JUnit "worktree disk row" testcases in `scripts/doctor-runtime.test.ts` (lines 614, 631, 650): "below the floor it warns, naming free space, the floor and the three largest worktrees, and never fails the run", "at or above the floor it is ok, and a failed scan is unknown, not drift", "the row exists only when SUBSTRATE_WORKTREE_ROOTS is set, and takes its floor from SUBSTRATE_WORKTREE_MIN_FREE_GB"; all pass. Python tests `test_ensure_worktree_reads_free_space_where_the_worktree_goes` (`packages/dispatcher/tests/test_worktree.py` line 220) and `test_low_disk_refusal_names_the_filesystem_it_checked` (line 232): source present; pass evidence is the r36 pytest block (head a46d42c3, unchanged since). |
| 6 | With the registry on, `memory_brief` names other sessions' worktrees that touch the caller's files | ✓ VERIFIED (carried forward) | `packages/mcp-server/src/brief-sessions.ts` `worktreesSection` (line 256) logic unchanged in range (range change: `BRIEF_*` constants un-exported). `packages/mcp-server/src/service.ts` `liveBriefSections` (line 4152) has no hunk in the range. r38 JUnit: suites "memory_brief with the worktree registry on" (`brief-worktrees.service.test.ts`, 6 tests) and the second suite in the same file (6 tests), `failures="0" skipped="0"`. |
| 7 | FLEET-02 invariant: a scan report that omits `session_id` or `graph_id` keeps the stored value, and one that carries it replaces that value (commit 4ac536e4, ancestor of HEAD) | ✓ VERIFIED (r38 JUnit named pass) | `packages/mcp-server/src/worktree-registry.ts` upsert `session_id = coalesce(excluded.session_id, worktrees.session_id), graph_id = coalesce(excluded.graph_id, worktrees.graph_id)` at line 381, unchanged in line and text since a46d42c3. The range changed the file only by removing one export keyword (line 24) and adding one comment (line 453). r38 JUnit testcase "a report that omits session_id or graph_id keeps the stored value, and one that carries it replaces that value" (classname `the worktree registry against a live index`, file `packages/mcp-server/src/worktree-registry.pg.test.ts` line 79), no failure, error or skipped child. |
| 8 | Dispatcher honours `SUBSTRATE_WORKTREE_ROOTS` (ROADMAP SC1 as amended by owner decision 2026-11-04): it parses the variable as the fleet does (colon separated, trimmed, absolute only, normalised, de-duplicated), reuses a worktree git already has under any configured root, and creates new ones under the first; unset falls back to the default directory | ✓ VERIFIED (parser unchanged; direct unit tests present) | `packages/dispatcher/src/substrate_dispatcher/worktree.py`: `WORKTREES_ROOT` (line 27), `ROOTS_ENV` (line 31), `worktree_roots` (lines 62-78) — unchanged since a46d42c3. Direct unit tests added by e958e8b1 in `packages/dispatcher/tests/test_worktree.py`: `test_worktree_roots_defaults_when_env_unset` (line 282), `test_worktree_roots_single_entry` (287), `test_worktree_roots_two_entries_keep_their_order` (291), `test_worktree_roots_trims_entries_and_drops_empty_or_relative_segments` (295; input `"  /a  :  ::/b/c/ : relative :/x/../y:/a"` expects `/a, /b/c, /y`), `test_worktree_roots_blank_value_falls_back_to_default` (300-302, parametrised over `""`, `"   "`, `" : : "`). Reuse under a non-first root: `test_ensure_worktree_reuses_a_registered_worktree_under_the_second_root` (line 264); creation under the first root: `test_ensure_worktree_creates_under_the_configured_root` (line 242). All are pytest items: source confirmed by grep; pass evidence is the r36 pytest block (341 passed, PY_EXIT=0, head a46d42c3), with no change to these lines since. Expected values were checked by reading the parser, not by execution in this pass. |

**Score:** 8/8 truths verified (0 present-behavior-unverified)

### Verdicts

| Criterion | Before (a46d42c3) | After (5e304ef8) | Reason |
| --- | --- | --- | --- |
| 1 SC1 | passed | passed | Files and test unchanged in range; r38 pass. |
| 2 SC2 | passed | passed | Route body unchanged; line 2352 → 2357 from the 14ac787a insertion; r38 pass. |
| 3 SC3 | passed | passed | Logic unchanged; r38 pass. |
| 4 SC4 | passed | passed | Export keyword only; r38 titles now cited. |
| 5 SC5 | passed | passed | Parser and guard unchanged; doctor titles now cited from r38. |
| 6 memory_brief | passed | passed | Logic unchanged; r38 pass. |
| 7 FLEET-02 | passed | passed | Upsert line 381 unchanged; r38 pass. |
| 8 dispatcher roots | passed | passed | Parser unchanged; unit tests unchanged since a46d42c3. |

### Deferred Items

None. The criterion 1 gap recorded earlier (the dispatcher's disk floor on `/` only) is resolved in code (b4fe6bfe). The ROADMAP text that said otherwise is updated (open item 1).

### Required Artifacts

Not applicable: no `*-PLAN.md` `must_haves.artifacts` in the phase directory. Artifacts were checked by existence and wiring through the truths above.

### Key Link Verification

Not applicable: no `*-PLAN.md` `must_haves.key_links`. Wiring was checked through the truths above (`ensure_worktree` to `worktree_roots`, `_registered` and `_existing_ancestor`; route to `reportWorktrees`; `inventory.ts` to `worktree list --porcelain`).

## Changed From Previous Record

- Head a46d42c3 → 5e304ef8; covered digest recomputed (see frontmatter).
- Route line 2352 → 2357 (server.ts, REST `/handoff` check inserted above it, commit 14ac787a). Route body unchanged.
- Export keywords removed from covered declarations (no behaviour change); two comment lines added to covered files.
- `worktree-registry.ts` is no longer "unchanged since 6e5d766e": it changed only by an export keyword and one comment. The upsert at line 381 is unchanged.
- Test citations moved from the r36 JUnit to the r38 JUnit (source of truth; run at 66fa97bd, identical for covered files at 5e304ef8). Criterion 4 and criterion 5 (doctor) now cite titles.
- ROADMAP line 1168 now reads "criterion 1 is closed in code", so prior open item 1 is resolved.

## Open Items

1. Resolved: ROADMAP Phase 68 status now reads that criterion 1 is closed in code (the prior record's open item 1).
2. Resolved (prior): `worktree.py` docstring wording (done at 6e5d766e..a46d42c3).
3. Resolved (prior): direct unit tests for the Python root parser (e958e8b1).
4. Still open within item 3: parity with the TypeScript parsers was checked ad hoc and is not a committed cross-language test.
5. The Python titles' pass result rests on the r36 pytest block, not on a pytest run at 5e304ef8. The r39 gate's pytest output, when it lands, is the evidence to cite.
6. No scheduler runs `substrate worktree scan --report` (carried from SUMMARY "What remains"; the registry is only as fresh as the last manual run). Operator-gated.
7. Merge-back's check-then-note race is narrowed, not closed (carried from SUMMARY).
8. A repository with no origin trusts local ancestry for "merged" and "pushed" (`inventory.ts` default-ref fallback; carried from SUMMARY).
9. The guard has no caller in removal paths: `workspaceGuard` is reached only through `substrate worktree guard` (`command.ts`).
10. Attribution is kept across silent reports by design (4ac536e4): a worktree whose session ended keeps its `session_id` until the row is swept, so the registry can name a finished session.
11. No owner decision of 2026-11-06 applies to phase 68; every owner item for this phase stays open. No structured `overrides:` entry (accepted_by "owner", accepted_at "2026-11-06T00:00:00Z") exists for this phase, so nothing is marked PASSED by override.

Operator-gated, not run: installing a timer for `scan --report` or `prune`; setting `SUBSTRATE_WORKTREE_REGISTRY=on`; setting `SUBSTRATE_WORKTREE_ROOTS` on a host; `prune --execute` or `merge-back --execute` on a real checkout.

---
