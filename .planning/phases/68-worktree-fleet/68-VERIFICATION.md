---
phase: 68-worktree-fleet
verified: 2026-11-05T01:18:19Z
status: passed
score: 8/8 truths verified (0 present-behavior-unverified)
covered_files: [".planning/phases/68-worktree-fleet/68-SUMMARY.md", "packages/audit/src/policy.ts", "packages/cli/src/worktree/args.ts", "packages/cli/src/worktree/command.test.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/merge-back.ts", "packages/collectors/src/worktree-graph.test.ts", "packages/collectors/src/worktree-graph.ts", "packages/dispatcher/src/substrate_dispatcher/worktree.py", "packages/dispatcher/tests/test_worktree.py", "packages/fleet/src/claims.test.ts", "packages/fleet/src/claims.ts", "packages/fleet/src/classify.test.ts", "packages/fleet/src/classify.ts", "packages/fleet/src/config.test.ts", "packages/fleet/src/config.ts", "packages/fleet/src/conflicts.test.ts", "packages/fleet/src/conflicts.ts", "packages/fleet/src/disk.test.ts", "packages/fleet/src/disk.ts", "packages/fleet/src/ignored.test.ts", "packages/fleet/src/ignored.ts", "packages/fleet/src/inventory.test.ts", "packages/fleet/src/inventory.ts", "packages/fleet/src/pr.test.ts", "packages/fleet/src/pr.ts", "packages/fleet/src/report.test.ts", "packages/fleet/src/report.ts", "packages/fleet/src/workspace-guard.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/brief-sessions.ts", "packages/mcp-server/src/brief-worktrees.service.test.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-claims.test.ts", "packages/mcp-server/src/worktree-claims.ts", "packages/mcp-server/src/worktree-registry-fake.ts", "packages/mcp-server/src/worktree-registry.http.test.ts", "packages/mcp-server/src/worktree-registry.pg.test.ts", "packages/mcp-server/src/worktree-registry.test.ts", "packages/mcp-server/src/worktree-registry.testkit.ts", "packages/mcp-server/src/worktree-registry.ts", "scripts/doctor-runtime.ts"]
covered_digest: "v3:sha256:8867059647bbcab5039a1f71232eb36187357086037941e0fd8007a37bc69b80"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 7/8
  gaps_closed:
    - "Truth 8 (behavior): dispatcher reuse of a worktree registered under a non-first configured root. Test added at 3cadf3e3 (`test_ensure_worktree_reuses_a_registered_worktree_under_the_second_root`); 33 pass at head ca9d02ec. Mutation check: restricting the reuse loop to the first root makes this test fail, so the test discriminates."
  gaps_remaining: []
  regressions: []
---

# Phase 68: Worktree Fleet Verification Report

**Phase Goal:** Many sessions can work in git worktrees of the same repository without filling the disk, losing track of which worktree is whose, or finding out about conflicts at merge time.
**Verified:** 2026-11-05T01:18:19Z
**Status:** passed
**Re-verification:** Yes. Head ca9d02ec (prior record at head c40ffc9a was human_needed, 7/8). The only open human item (reuse under a non-first configured root) is closed by the test at 3cadf3e3. The covered list is unchanged (47 entries); the fingerprint was regenerated.

## Scope and method

- Head ca9d02ec. The phase directory holds `68-CONTEXT.md`, `68-SUMMARY.md` and this record; there is no `*-PLAN.md`, so must-haves come from the ROADMAP Phase 68 success criteria (Step 2a). Steps 4 and 5 are not applicable (no plan `must_haves`).
- Covered list: the 47 entries of the record this replaces, unchanged. `covered_files` and `covered_digest` are the output of `gsd_run query verification.fingerprint .planning/phases/68-worktree-fleet <47 files>` run at this head.
- Changes since the prior head c40ffc9a that touch covered files (`git diff --name-only c40ffc9a ca9d02ec` intersected with the covered list): `packages/dispatcher/tests/test_worktree.py` (3cadf3e3, new test only), `packages/mcp-server/src/service.ts` and `packages/mcp-server/src/flag-registry.ts` (wave-7 docs sync-lag freshness hunks; keyword check for `worktree` or `brief` in those hunks: zero matches). `worktree.py` is unchanged since c40ffc9a, so the line references in truth 8 still hold. Truths 2 to 6 are carried forward unchanged.
- Dispatcher run (non-PG): `packages/dispatcher`, `uv run pytest tests/test_worktree.py -q` at ca9d02ec: **33 passed, 0 failed**.
- Mutation check (in a temporary copy outside the repository, deleted afterwards): the reuse loop in `ensure_worktree` restricted to `roots[:1]` makes `test_ensure_worktree_reuses_a_registered_worktree_under_the_second_root` fail with `'substrate/ut-mufsocbe-c7ced745' is already used by worktree at ...`. The original code passes it.
- Postgres: scratch Postgres 16 at 127.0.0.1:5439, database `substrate_test_v68`, `TMPDIR=/root/src/worktrees/backups/gate-tmpfs`. `packages/mcp-server/src/worktree-registry.pg.test.ts`: **13 pass, 0 fail, 42 expect() calls**, the same count as the prior record. Production and port 5432 not touched.
- Debt-marker gate (Step 7): no `TBD`, `FIXME`, `XXX`, `TODO`, `HACK` or `PLACEHOLDER` in the new test. Zero blockers.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1 (fleet and collector): `@substrate/fleet` finds worktrees via `git worktree list --porcelain` from every repository under the configured roots, including linked worktrees outside them; `SUBSTRATE_WORKTREE_ROOTS` replaces the hard-coded root in `worktree-graph.ts` | ✓ VERIFIED | `worktree-graph.ts` `worktreeRoots` (lines 18-31) reads the variable, drops relative entries, and falls back to `WORKTREE_ROOT` only when no absolute entry remains. `inventory.ts` runs `worktree list --porcelain -z`; `collectInventory` keeps every listed non-bare entry with no root filter. `worktree-graph.test.ts` and `config.test.ts` pass (carried forward). |
| 2 | SC2: `POST /worktrees/report` stores path, repo, branch, head, base, dirty, ahead, behind, last commit time, size, session and graph attribution, PR state in `worktrees` (its own migration step) | ✓ VERIFIED (in-memory contract; Postgres contract observed in truth 7) | Migration step 36 `worktrees` (`index-store.ts`, phase `expand`, no `optIn`) has every listed column. Route `server.ts` line 2336: 401 without a surface, `worktreeGate(true)` refusal, body capped at `WORKTREE_REPORT_MAX_BYTES`, audited, then `reportWorktrees`. `report.ts` builds the contract fields. `worktree-registry.test.ts` and `worktree-registry.http.test.ts` pass (carried forward). |
| 3 | SC3: `prune` is a dry run until `--execute`; removes only clean, pushed, idle, proven-merged worktrees; never the primary checkout or the current directory; one ledger note per removal; a test covers a branch that advanced after its merge | ✓ VERIFIED (carried forward) | `classify.ts`: `never` for primary, cwd, locked, live claim, dirty, unpushed (unless a merged PR head). `command.ts` `git worktree remove` with no `--force`; one `worktree.prune` note per removal. `classify.test.ts` "a branch that gained commits after its pull request merged is review, never safe" passes (carried forward). |
| 4 | SC4: `conflicts` lists changed files per worktree against the merge base, overlapping pairs, a `git merge-tree --write-tree` prediction per pair, and a suggested merge order | ✓ VERIFIED (carried forward) | `conflicts.ts`: `MIN_MERGE_TREE_VERSION = [2, 38]`, `git merge-tree --write-tree --name-only`, `suggestMergeOrder` and `forecastConflicts` present. `conflicts.test.ts` passes (carried forward). |
| 5 | SC5: `SUBSTRATE_WORKTREE_MIN_FREE_GB` enforced by `provision` and the dispatcher's `ensure_worktree`; doctor reports worktree disk use against it | ✓ VERIFIED (caveat: dispatcher floor reads `/` only) | `command.ts` line 490 `assertDiskFloor(target, minFreeGbFromEnv(...))`; `config.ts` reads the variable, default 5; `worktree.py` `ensure_worktree` refuses before any git command via `min_free_bytes()` (line 174, `disk_usage("/")`). `scripts/doctor-runtime.ts` `gatherWorktreeDisk` adds a row only when roots are set. Caveat: the floor is checked on `/`, not on the root the worktree is created under. Open item 1. `test_worktree.py` passes (33 pass, run above). |
| 6 | With the registry on, `memory_brief` names other sessions' worktrees that touch the caller's files | ✓ VERIFIED (carried forward) | `brief-sessions.ts` `worktreesSection` (line 256) excludes other repositories and clean merged or closed rows. `service.ts` `liveBriefSections` returns no section unless `briefSessions` or `worktreeRegistry.mode === "on"`; the wave-7 `service.ts` hunks do not touch it. `brief-worktrees.service.test.ts` passes (carried forward), including the registry-off case. |
| 7 | FLEET-02 invariant: a scan report that omits `session_id` or `graph_id` keeps the stored value, and one that carries it replaces that value (commit 4ac536e4, ancestor of HEAD) | ✓ VERIFIED (behavioral, scratch Postgres 16, re-run at ca9d02ec) | `worktree-registry.ts` line 381 `session_id = coalesce(excluded.session_id, worktrees.session_id), graph_id = coalesce(excluded.graph_id, worktrees.graph_id)`; `worktree-registry-fake.ts` keeps `session_id ?? previous`. Run: `worktree-registry.pg.test.ts` on `substrate_test_v68` = **13 pass, 0 fail, 42 expect() calls**, including "a report that omits session_id or graph_id keeps the stored value, and one that carries it replaces that value". |
| 8 | Dispatcher honours `SUBSTRATE_WORKTREE_ROOTS` (ROADMAP SC1 as amended by owner decision 2026-11-04): it parses the variable as the fleet does (colon separated, trimmed, absolute only, normalised, de-duplicated), reuses a worktree git already has under any configured root, and creates new ones under the first; unset falls back to the default directory | ✓ VERIFIED | `worktree.py` `worktree_roots` (lines 62-78) parses as the fleet does; unset returns `[WORKTREES_ROOT]` (line 78 fallback). `ensure_worktree` checks every root through the `_registered` loop (lines 168-186) and creates under `roots[0]` (line 192). Reuse under the second root: `test_ensure_worktree_reuses_a_registered_worktree_under_the_second_root` (3cadf3e3) sets `SUBSTRATE_WORKTREE_ROOTS=first:second`, registers `second/<gid>` with git, calls `ensure_worktree` with no root argument, and asserts the path is `second/<gid>`, no `worktree add` runs, `first` is not created and the branch is `substrate/<gid>`. Passes at ca9d02ec; fails when the loop is restricted to the first root (mutation check above). Creation under the first root: `test_ensure_worktree_creates_under_the_configured_root`. |

**Score:** 8/8 truths verified (0 present-behavior-unverified)

### Deferred Items

None. Later phases (69-78) do not address the worktree-fleet gaps listed below.

### Required Artifacts

Not applicable: no `*-PLAN.md` `must_haves.artifacts` in the phase directory. Artifacts were checked by existence and wiring through the truths above.

### Key Link Verification

Not applicable: no `*-PLAN.md` `must_haves.key_links`. Wiring was checked through the truths above (`ensure_worktree` to `worktree_roots` and `_registered`; route to `reportWorktrees`; `inventory.ts` to `worktree list --porcelain`).

## Open Items

Carried from the prior record. None is a must-have of criterion 1 to 8 as written in the ROADMAP; each is an owner or operator decision, and none is closed by this pass:

1. The dispatcher's disk floor reads `/` only (`worktree.py` line 174), not the root the worktree is created under.
2. No scheduler runs `substrate worktree scan --report` (carried from SUMMARY "What remains"; the registry is only as fresh as the last manual run). Operator-gated.
3. Merge-back's check-then-note race is narrowed, not closed (carried from SUMMARY).
4. A repository with no origin trusts local ancestry for "merged" and "pushed" (`inventory.ts` default-ref fallback; carried from SUMMARY).
5. The guard has no caller in removal paths: `workspaceGuard` is reached only through `substrate worktree guard` (`command.ts`).
6. Attribution is kept across silent reports by design (4ac536e4). A worktree whose session ended keeps its `session_id` until the row is swept, so the registry can name a finished session.
7. The ROADMAP Phase 68 header and progress row still read "PARTIAL (criterion 1)"; not edited by this verifier. The orchestrator should update them now that truth 8 is verified.
8. REQUIREMENTS.md still shows FLEET-01 to FLEET-06 unchecked; not edited here.

Operator-gated, not run: installing a timer for `scan --report` or `prune`; setting `SUBSTRATE_WORKTREE_REGISTRY=on`; setting `SUBSTRATE_WORKTREE_ROOTS` on a host; `prune --execute` or `merge-back --execute` on a real checkout.

---

_Verified: 2026-11-05T01:18:19Z_
_Verifier: Claude (gsd-verifier)_
