---
phase: 68-worktree-fleet
verified: 2026-11-05T07:59:23Z
status: passed
score: 8/8 truths verified (0 present-behavior-unverified)
covered_files: [".planning/phases/68-worktree-fleet/68-SUMMARY.md", "packages/audit/src/policy.ts", "packages/cli/src/worktree/args.ts", "packages/cli/src/worktree/command.test.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/merge-back.ts", "packages/collectors/src/worktree-graph.test.ts", "packages/collectors/src/worktree-graph.ts", "packages/dispatcher/src/substrate_dispatcher/worktree.py", "packages/dispatcher/tests/test_worktree.py", "packages/fleet/src/claims.test.ts", "packages/fleet/src/claims.ts", "packages/fleet/src/classify.test.ts", "packages/fleet/src/classify.ts", "packages/fleet/src/config.test.ts", "packages/fleet/src/config.ts", "packages/fleet/src/conflicts.test.ts", "packages/fleet/src/conflicts.ts", "packages/fleet/src/disk.test.ts", "packages/fleet/src/disk.ts", "packages/fleet/src/ignored.test.ts", "packages/fleet/src/ignored.ts", "packages/fleet/src/inventory.test.ts", "packages/fleet/src/inventory.ts", "packages/fleet/src/pr.test.ts", "packages/fleet/src/pr.ts", "packages/fleet/src/report.test.ts", "packages/fleet/src/report.ts", "packages/fleet/src/workspace-guard.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/brief-sessions.ts", "packages/mcp-server/src/brief-worktrees.service.test.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-claims.test.ts", "packages/mcp-server/src/worktree-claims.ts", "packages/mcp-server/src/worktree-registry-fake.ts", "packages/mcp-server/src/worktree-registry.http.test.ts", "packages/mcp-server/src/worktree-registry.pg.test.ts", "packages/mcp-server/src/worktree-registry.test.ts", "packages/mcp-server/src/worktree-registry.testkit.ts", "packages/mcp-server/src/worktree-registry.ts", "scripts/doctor-runtime.ts"]
covered_digest: "v3:sha256:41a515df3b31077555ecd9b1798b46860ea52b9d10ef25f325bf771eb2ba2c5a"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 8/8
  gaps_closed: ["dispatcher free-space floor read on / only (prior open item 1), closed by b4fe6bfe"]
  gaps_remaining: []
  regressions: []
---

# Phase 68: Worktree Fleet Verification Report

**Phase Goal:** Many sessions can work in git worktrees of the same repository without filling the disk, losing track of which worktree is whose, or finding out about conflicts at merge time.
**Verified:** 2026-11-05T07:59:23Z
**Status:** passed
**Re-verification:** Yes. Head 6e5d766e (prior record at head 42e3cf13 was passed, 8/8). This pass targets criterion 1 (the dispatcher reads `SUBSTRATE_WORKTREE_ROOTS`, 3c5dcfa0; reuse under a non-first root, 3cadf3e3; the free-space floor read where the worktree lands, b4fe6bfe; the FLEET-02 coalesce invariant). Prior open item 1 (the disk floor read `/` only) is closed by b4fe6bfe. The covered list is unchanged (47 entries); the digest is regenerated.

## Scope and method

- Head 6e5d766e, diff base 42e3cf13. The phase directory holds `68-CONTEXT.md`, `68-SUMMARY.md` and this record; there is no `*-PLAN.md`, so must-haves are the ROADMAP Phase 68 success criteria 1 to 6 (criterion 1 as amended by the owner decision of 2026-11-04). Steps 4 and 5 are not applicable (no plan `must_haves`).
- Covered list: the 47 entries of the record this replaces, unchanged. `covered_files` and `covered_digest` are the output of `gsd_run query verification.fingerprint .planning/phases/68-worktree-fleet <47 files>` at 6e5d766e (`v3:sha256:41aa4f00…c9ef`).
- Covered files changed since 42e3cf13 (`git diff --name-only 42e3cf13..HEAD` intersected with the covered list): `packages/dispatcher/src/substrate_dispatcher/worktree.py` and `packages/dispatcher/tests/test_worktree.py` (b4fe6bfe, re-audited in full below); `packages/mcp-server/src/service.ts` (b4bdd0fc, phase 70: the sync-lag reading after a buffered or dead-lettered note, 2 lines added, 1 removed). The `service.ts` hunk does not touch `liveBriefSections`, `briefSessions` or any worktree path, so truth 6 is carried forward. Commits 49b9aece (76), d1a5e89b (75) and 6e5d766e (docs) touch no covered file.
- Truths 1 to 4 and 6 to 7 are carried forward: none of their covered files changed since 42e3cf13 except as stated above.
- Dispatcher, non-Postgres, at 6e5d766e: `packages/dispatcher`, `TMPDIR=/root/src/worktrees/backups/gate-tmpfs uv run pytest tests/test_worktree.py -q`: **35 passed, 0 failed** (33 at 42e3cf13; b4fe6bfe adds the two tests named in truth 5).
- Root-parsing parity (ad hoc, read-only; no test file touched), inputs `" /a : rel:/b/../c:/a/ :/c//d/"`, `""`, `":"`, `"//x/y"`: Python `worktree_roots` gives `/a /c /c/d`, the default, the default, `/x/y`; TS `worktreeRoots` (collector) gives the same first, default, default, `/x/y`; TS `worktreeRootsFromEnv` (fleet) gives the same first and `[]` for the two unset-like inputs, which is the documented difference (the fleet treats no root as "no location").
- Gate evidence, not rerun (no Postgres started). Gate r33 JUnit `/root/src/worktrees/backups/gate-r33-junit.xml`: testcase `a report that omits session_id or graph_id keeps the stored value, and one that carries it replaces that value`, classname `the worktree registry against a live index`, file `packages/mcp-server/src/worktree-registry.pg.test.ts`; the element is self-closing, with no `<skipped/>` child.
- Mutation check: not run this pass. The disk-floor assertion change is judged by inspection of the old `disk_usage("/")` call (see truth 5).
- Debt-marker gate: no `TBD`, `FIXME`, `XXX`, `TODO`, `HACK` or `PLACEHOLDER` in the added lines of `packages/dispatcher` since 42e3cf13. Zero blockers.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1 (fleet and collector): `@substrate/fleet` finds worktrees via `git worktree list --porcelain` from every repository under the configured roots, including linked worktrees outside them; `SUBSTRATE_WORKTREE_ROOTS` replaces the hard-coded root in `worktree-graph.ts` | ✓ VERIFIED (carried forward) | `packages/collectors/src/worktree-graph.ts` `worktreeRoots` (lines 23-32) reads the variable, drops relative entries, and falls back to `WORKTREE_ROOT` only when no absolute entry remains. `inventory.ts` runs `worktree list --porcelain -z`; `collectInventory` keeps every listed non-bare entry with no root filter. `worktree-graph.test.ts` and `config.test.ts` pass (carried forward). Parsing parity with Python re-run this pass (see Scope). |
| 2 | SC2: `POST /worktrees/report` stores path, repo, branch, head, base, dirty, ahead, behind, last commit time, size, session and graph attribution, PR state in `worktrees` (its own migration step) | ✓ VERIFIED (carried forward; contract observed in truth 7) | Migration step 36 `worktrees` (`index-store.ts`, phase `expand`, no `optIn`) has every listed column. Route `server.ts` line 2336: 401 without a surface, `worktreeGate(true)` refusal, body capped at `WORKTREE_REPORT_MAX_BYTES`, audited, then `reportWorktrees`. `report.ts` builds the contract fields. `worktree-registry.test.ts` and `worktree-registry.http.test.ts` pass (carried forward). |
| 3 | SC3: `prune` is a dry run until `--execute`; removes only clean, pushed, idle, proven-merged worktrees; never the primary checkout or the current directory; one ledger note per removal; a test covers a branch that advanced after its merge | ✓ VERIFIED (carried forward) | `classify.ts`: `never` for primary, cwd, locked, live claim, dirty, unpushed (unless a merged PR head). `command.ts` runs `git worktree remove` with no `--force`; one `worktree.prune` note per removal. `classify.test.ts` "a branch that gained commits after its pull request merged is review, never safe" passes (carried forward). |
| 4 | SC4: `conflicts` lists changed files per worktree against the merge base, overlapping pairs, a `git merge-tree --write-tree` prediction per pair, and a suggested merge order | ✓ VERIFIED (carried forward) | `conflicts.ts`: `MIN_MERGE_TREE_VERSION = [2, 38]`, `git merge-tree --write-tree --name-only`, `suggestMergeOrder` and `forecastConflicts` present. `conflicts.test.ts` passes (carried forward). |
| 5 | SC5: `SUBSTRATE_WORKTREE_MIN_FREE_GB` enforced by `provision` and the dispatcher's `ensure_worktree`; doctor reports worktree disk use against it | ✓ VERIFIED (prior caveat closed by b4fe6bfe) | `worktree.py` `ensure_worktree` (line 183) reads the free space at `_existing_ancestor(roots[0])` (lines 153-158: the nearest existing directory at or above the root, the filesystem a worktree created there lands on) and refuses with `low-disk` before any git command; the refusal names that filesystem. `command.ts` line 490 `assertDiskFloor(target, minFreeGbFromEnv(...))`; `config.ts` reads the variable, default 5. `scripts/doctor-runtime.ts` `gatherWorktreeDisk` adds a row only when roots are set. Tests: `test_ensure_worktree_reads_free_space_where_the_worktree_goes` (the probe is `tmp_path` for a root that does not exist yet), `test_low_disk_refusal_names_the_filesystem_it_checked`, and `test_ensure_worktree_disk_floor` now asserting the probe is `tmp_path` (the old `disk_usage("/")` assertion would fail). Pytest 35 pass. |
| 6 | With the registry on, `memory_brief` names other sessions' worktrees that touch the caller's files | ✓ VERIFIED (carried forward) | `brief-sessions.ts` `worktreesSection` (line 256) excludes other repositories and clean merged or closed rows. `service.ts` `liveBriefSections` returns no section unless `briefSessions` or `worktreeRegistry.mode === "on"`; the phase 70 hunk (b4bdd0fc) does not touch it. `brief-worktrees.service.test.ts` passes (carried forward), including the registry-off case. |
| 7 | FLEET-02 invariant: a scan report that omits `session_id` or `graph_id` keeps the stored value, and one that carries it replaces that value (commit 4ac536e4, ancestor of HEAD) | ✓ VERIFIED (named gate JUnit pass, not rerun) | `worktree-registry.ts` line 381 `session_id = coalesce(excluded.session_id, worktrees.session_id), graph_id = coalesce(excluded.graph_id, worktrees.graph_id)`; `worktree-registry.ts` unchanged since 42e3cf13. Gate r33 JUnit: "a report that omits session_id or graph_id keeps the stored value, and one that carries it replaces that value" (suite "the worktree registry against a live index"), a named pass with no `<skipped/>`. The prior record's scratch-Postgres run at 42e3cf13 (13 pass, 0 fail) stands for the same file. |
| 8 | Dispatcher honours `SUBSTRATE_WORKTREE_ROOTS` (ROADMAP SC1 as amended by owner decision 2026-11-04): it parses the variable as the fleet does (colon separated, trimmed, absolute only, normalised, de-duplicated), reuses a worktree git already has under any configured root, and creates new ones under the first; unset falls back to the default directory | ✓ VERIFIED (re-audited at 6e5d766e; commit 3c5dcfa0) | `worktree.py` `worktree_roots` (lines 62-78) parses as the fleet does; unset or with no absolute entry returns `[WORKTREES_ROOT]`. Parity with the TS parsers checked on four inputs (see Scope). `ensure_worktree` checks every root through `_registered` (lines 193-200) and creates under `roots[0]` (line 202, `mkdir` at 206). Reuse under the second root: `test_ensure_worktree_reuses_a_registered_worktree_under_the_second_root` (3cadf3e3) uses real git: the worktree is registered under `second`, the test asserts no `worktree add` runs, `first` is never created, and the branch is `substrate/<graph id>`. Creation under the first configured root: `test_ensure_worktree_creates_under_the_configured_root` (3c5dcfa0). Pytest 35 pass. |

**Score:** 8/8 truths verified (0 present-behavior-unverified)

### Deferred Items

None. The criterion 1 gap recorded in the prior record (the dispatcher's disk floor on `/` only, and the ROADMAP "PARTIAL (criterion 1)" reason) is resolved in code; the ROADMAP text is stale (open item 1).

### Required Artifacts

Not applicable: no `*-PLAN.md` `must_haves.artifacts` in the phase directory. Artifacts were checked by existence and wiring through the truths above.

### Key Link Verification

Not applicable: no `*-PLAN.md` `must_haves.key_links`. Wiring was checked through the truths above (`ensure_worktree` to `worktree_roots`, `_registered` and `_existing_ancestor`; route to `reportWorktrees`; `inventory.ts` to `worktree list --porcelain`).

## Open Items

Carried from the prior record and new from this pass. None is a must-have of criteria 1 to 8 as written in the ROADMAP.

1. ROADMAP Phase 68 header and progress row still read "PARTIAL (criterion 1)" and REQUIREMENTS.md still shows FLEET-01 to FLEET-06 unchecked. Criterion 1 is now evidenced; the orchestrator should update both. Not edited by this verifier.
2. Resolved 2026-11-05 (comment only): the module docstring of `packages/dispatcher/src/substrate_dispatcher/worktree.py` now names the filesystem the worktree lands on, the nearest existing directory at or above the first root, which is what `ensure_worktree` probes. Verdict unchanged.
3. The Python root parser has no direct unit test; `test_worktree.py` exercises it only through one-entry and two-entry environments. Parity with the TS parsers was checked ad hoc (see Scope), not by a committed test.
4. No scheduler runs `substrate worktree scan --report` (carried from SUMMARY "What remains"; the registry is only as fresh as the last manual run). Operator-gated.
5. Merge-back's check-then-note race is narrowed, not closed (carried from SUMMARY).
6. A repository with no origin trusts local ancestry for "merged" and "pushed" (`inventory.ts` default-ref fallback; carried from SUMMARY).
7. The guard has no caller in removal paths: `workspaceGuard` is reached only through `substrate worktree guard` (`command.ts`).
8. Attribution is kept across silent reports by design (4ac536e4): a worktree whose session ended keeps its `session_id` until the row is swept, so the registry can name a finished session.

Operator-gated, not run: installing a timer for `scan --report` or `prune`; setting `SUBSTRATE_WORKTREE_REGISTRY=on`; setting `SUBSTRATE_WORKTREE_ROOTS` on a host; `prune --execute` or `merge-back --execute` on a real checkout.

---
