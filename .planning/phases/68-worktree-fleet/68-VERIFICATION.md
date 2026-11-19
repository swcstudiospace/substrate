---
phase: 68-worktree-fleet
verified: 2026-11-19T00:53:27Z
status: passed
score: 6/6 success criteria verified
covered_files: [".planning/phases/68-worktree-fleet/68-CONTEXT.md", ".planning/phases/68-worktree-fleet/68-SUMMARY.md", "packages/fleet/src/inventory.ts", "packages/fleet/src/classify.ts", "packages/fleet/src/conflicts.ts", "packages/fleet/src/disk.ts", "packages/fleet/src/ignored.ts", "packages/fleet/src/report.ts", "packages/cli/src/worktree/command.ts", "packages/collectors/src/worktree-graph.ts", "packages/dispatcher/src/substrate_dispatcher/worktree.py", "packages/dispatcher/tests/test_worktree.py", "packages/host/src/worktree-root.ts", "packages/host/src/sandbox-options.ts", "packages/host/src/sandbox-options.test.ts", "packages/host/src/audit.ts", "packages/host/src/audit.test.ts", "packages/host/src/vm.ts", "packages/host/src/hostfns.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/brief-sessions.ts", "scripts/doctor-runtime.ts"]
covered_digest: "v4:sha256:c97c99a1776274024880df184c7e33493db1f087d01b0fb2a36185bef50f9440"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found (2026-11-18 record, read at 357d6b15)
  previous_score: "5 of 6 MET, criterion 1 PARTIAL (host bound the hard-coded root while the dispatcher created under the configured root)"
  gaps_closed:
    - "One source of truth for the worktree root on the host: packages/host/src/worktree-root.ts worktreeRoot() resolves SUBSTRATE_WORKTREE_ROOTS (first absolute entry, else /var/lib/substrate/worktrees). sandbox-options.ts worktreeFor() and audit.ts now resolve through it, so vm.ts and hostfns.ts bind the same root the dispatcher creates under."
    - "Non-default root test on both sides: sandbox-options.test.ts runs the dispatcher's creation_root() under SUBSTRATE_WORKTREE_ROOTS=/srv/wt-a:/srv/wt-b and asserts it equals the host worktreeFor(); audit.test.ts asserts a bind under the configured non-default root is the graph's own worktree."
  gaps_remaining: []
  regressions: []
---

# Phase 68: Worktree Fleet Verification Report

**Phase Goal:** Many sessions can work in git worktrees of the same repository without filling the disk, losing track of which worktree is whose, or finding out about conflicts at merge time.
**Verified:** 2026-11-19 against the working tree of `/root/src/worktrees/as-autonomous` (branch `gsd/autonomous-rerun`, uncommitted gap-closure changes)
**Status:** passed
**Re-verification:** Yes — the 2026-11-18 record found criterion 1 PARTIAL because the host still bound `/var/lib/substrate/worktrees/<gid>` while the dispatcher created `<root>/<gid>`. This pass re-read the code and ran the named host tests.

## Gates

Targeted checks run in this pass (one invocation each, not the full suite):

| Command | Result |
|---------|--------|
| `bun test packages/host/src/sandbox-options.test.ts packages/host/src/audit.test.ts --timeout 60000` | 48 pass, 0 fail, 152 expect() calls, 2 files |

Not run in this pass: the dispatcher's `test_worktree.py` (its non-default-root cases were read, not executed), the fleet and CLI worktree suites, and any live-host check. The criterion 2–6 verdicts below rest on the 2026-11-18 run plus anchors re-confirmed by grep in this pass.

## Goal Achievement

### Observable Truths

| #   | Truth   | Status     | Evidence       |
| --- | ------- | ---------- | -------------- |
| 1   | `SUBSTRATE_WORKTREE_ROOTS` is the one source of the worktree root, and the host and the dispatcher name the same path for a graph | ✓ VERIFIED | `packages/host/src/worktree-root.ts` L11-19: `worktreeRoot(env)` returns `resolve()` of the first absolute, trimmed, non-empty entry, else `DEFAULT_WORKTREES_ROOT`. Dispatcher `packages/dispatcher/src/substrate_dispatcher/worktree.py` L61-84: `worktree_roots` (same split, trim, absolute-only filter) and `creation_root` returns `roots[0]` else `WORKTREES_ROOT`. `ensure_worktree` L199 defaults `root` to `creation_root()`, and `dispatch.py` L540 calls `ensure(repo_path, gid, branch)` with no root override. Host side: `sandbox-options.ts` L43-46 `worktreeFor` = `join(worktreeRoot(env), graphId)`; `vm.ts` L209 and L425 bind `worktreeFor(...)`; `audit.ts` L95 and L134 use `worktreeFor(graphId, env)` and `worktreeRoot(env)`. The two rules agree on empty, relative-only, and whitespace-padded values (both fall back to the default). |
| 2   | `POST /worktrees/report` stores the inventory in `worktrees` (its own migration step): path, repo, branch, head, base, dirty, ahead, behind, last commit time, size, session and graph attribution, PR state when known | ✓ VERIFIED | Migration `worktrees` at `packages/mcp-server/src/index-store.ts` L738-765 (create table and `worktrees_repo_seen_idx` index L764); later migration `worktrees_changed_files` at L862. Route `packages/mcp-server/src/server.ts` L2400 (`/worktrees/report`), L330 listed in the route table. Carried from the 2026-11-18 record; anchors re-confirmed. |
| 3   | `substrate worktree prune` is a dry run until `--execute`, removes only clean, pushed, idle worktrees whose HEAD is proven merged, never the primary checkout or the current directory, and writes one ledger note per removal; tests include a branch that advanced after its merge | ✓ VERIFIED | `packages/cli/src/worktree/command.ts` `commandPrune` dry-runs unless `args.execute`; each `safe` item is re-inspected from git before removal; one `deps.emit` per removal. `packages/fleet/src/classify.ts` L56-97 yields `never` for the primary checkout and the cwd, `review` for ignored work and for a merged PR whose HEAD moved past the merged head. Carried from the 2026-11-18 record. |
| 4   | `substrate worktree conflicts` lists per-worktree changed files against the merge base, overlapping pairs, a `git merge-tree` prediction per pair, and a suggested merge order | ✓ VERIFIED | `packages/fleet/src/conflicts.ts`: `git merge-tree --write-tree --name-only` (L142), git 2.38 gate (L140), `suggestMergeOrder` (L152), `forecastConflicts` (L179). Carried from the 2026-11-18 record. |
| 5   | `SUBSTRATE_WORKTREE_MIN_FREE_GB` is enforced by `substrate worktree provision` and the dispatcher's `ensure_worktree`, and the doctor reports worktree disk use against it | ✓ VERIFIED | `packages/cli/src/worktree/command.ts` L514 `assertDiskFloor(target, minFreeGbFromEnv(...))`. Dispatcher `worktree.py` `ensure_worktree` checks the floor on the first root's filesystem when roots are set, else on `/`. Doctor `scripts/doctor-runtime.ts` L773-796 and `gatherWorktreeDisk` L884. Carried from the 2026-11-18 record. |
| 6   | With the registry on, `memory_brief` names other sessions' worktrees that touch files the caller's worktree touches | ✓ VERIFIED | `packages/mcp-server/src/brief-sessions.ts` `worktreesSection` (L256) and its call in brief composition (L378). Carried from the 2026-11-18 record. |

**Score:** 6/6 truths verified (0 present-behavior-unverified)

### Criterion 1 detail: why it now holds

- **Single rule, two implementations, one shared test seam.** The TypeScript `worktreeRoot()` and the Python `creation_root()` implement the same rule. `sandbox-options.test.ts` (test "the host and the dispatcher resolve the same non-default worktree root from SUBSTRATE_WORKTREE_ROOTS") spawns `python3` against `substrate_dispatcher.worktree.creation_root` with `SUBSTRATE_WORKTREE_ROOTS=/srv/wt-a:/srv/wt-b` and asserts it returns `/srv/wt-a` and equals `worktreeFor(graphId, env)`. That test passed in this run.
- **The dispatcher's default-root path is covered too.** `packages/dispatcher/tests/test_worktree.py` L225-250 and L330-333 set `SUBSTRATE_WORKTREE_ROOTS` to two roots and assert `ensure_worktree` (no `root=` argument) creates under the first. Those tests were not re-run in this pass; they were read.
- **The host's container spec and audit both follow the root.** `buildContainerSpec` compares `opts.worktree` against `worktreeFor(graphId)` (sandbox-options.ts L74) using `process.env`, which is the same environment `vm.ts` passes into `worktreeFor`. `audit.test.ts` "a bind under a non-default root from SUBSTRATE_WORKTREE_ROOTS is the graph's own worktree; with no root set it is foreign" passed in this run.
- **Audit change reviewed.** `containerViolations` now uses `isValidGraphId` instead of `graphId !== ""` to choose `ownWorktree`. An invalid or missing label already adds a `label` violation (audit.ts L93), so the verdict is unchanged for those containers.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/host/src/worktree-root.ts` | Single resolver of the worktree root | ✓ VERIFIED | 19 lines, Node built-ins only; exports `DEFAULT_WORKTREES_ROOT`, `worktreeRoot`. Imported by `sandbox-options.ts` L9 and `audit.ts` L15. |
| `packages/host/src/sandbox-options.ts` | `worktreeFor` resolves through the shared root | ✓ VERIFIED | L9, L15-19 (`WORKTREES_ROOT` now alias of the default), L43-46. |
| `packages/host/src/audit.ts` | Ownership check resolves through the shared root | ✓ VERIFIED | L14-15, L95, L134. |
| `packages/dispatcher/src/substrate_dispatcher/worktree.py` | `creation_root` honours the roots variable | ✓ VERIFIED | L61-84; `ensure_worktree` L181-210. Unchanged from HEAD. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `sandbox-options.ts` `worktreeFor` | `worktree-root.ts` `worktreeRoot` | import L9, call L45 | ✓ WIRED | |
| `audit.ts` | `worktree-root.ts` `worktreeRoot` | import L15, call L134 | ✓ WIRED | |
| `vm.ts` L209, L425 | `sandbox-options.ts` `worktreeFor` | import L38, call | ✓ WIRED | Bind path now follows `SUBSTRATE_WORKTREE_ROOTS`. |
| `dispatch.py` `make_launch_fn` | `worktree.py` `ensure_worktree` → `creation_root` | L540, default root | ✓ WIRED | |
| Host test | Dispatcher `creation_root` | `Bun.spawnSync` python3 (sandbox-options.test.ts) | ✓ WIRED | Executed and green in this run. |

### Data-Flow Trace (Level 4)

Not applicable: the criterion is a path resolution, not rendered data.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Host and dispatcher agree on a non-default root; audit treats a bind under it as own | `bun test packages/host/src/sandbox-options.test.ts packages/host/src/audit.test.ts --timeout 60000` | 48 pass, 0 fail | ✓ PASS |

### Probe Execution

No probe scripts are declared for this phase.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| FLEET-01 | none (phase built without plans) | Roots variable replaces the hard-coded root | ✓ SATISFIED | Truth 1 and the criterion 1 detail above. |
| FLEET-02 to FLEET-06 | none | Criteria 2–6 | ✓ SATISFIED | Truths 2–6, carried from the 2026-11-18 record. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/flag-registry.ts` | 325 | Registry `unset` text says "the dispatcher does not read this variable and always uses that directory". The code reads it (`worktree.py` `worktree_roots`, `creation_root`). | ⚠️ Warning | Documentation contradicts the shipped behaviour and the single-source-of-truth claim. Outside this assignment's files; not edited here. |
| `.env.example` | 1127 | Same false statement: "the dispatcher does not read it and always uses that directory". | ⚠️ Warning | Operator-facing doc is wrong about the dispatcher. Not edited here. |
| `.planning/ROADMAP.md` | 133, 1168 | Phase 68 status line still says "PARTIAL: the dispatcher ignores `SUBSTRATE_WORKTREE_ROOTS`". | ℹ️ Info | Stale status text; the criterion itself does not mention the dispatcher. |
| `packages/collectors/src/worktree-graph.ts` | 11-31 | Its own `WORKTREE_ROOT` constant and root reader (keeps all absolute roots, for attribution; comment says "keep in step with worktree.py"). | ℹ️ Info | Third copy of the rule. It agrees on the default and on attribution; it is not used for creation or binding. |
| `packages/host/src/worktree-root.ts` | — | No dedicated unit test file. | ℹ️ Info | Covered through `sandbox-options.test.ts` and `audit.test.ts`, which passed in this run. |
| `packages/dispatcher/src/substrate_dispatcher/worktree.py` | 26 | Fixed `WORKTREES_ROOT` kept as fallback. | ℹ️ Info | Intended fallback. |

Debt-marker scan (TBD/FIXME/XXX) over the changed files was not run in this pass.

### Human Verification Required

None required for the criteria. The live-host check (sandbox and VM bound to a non-default root on a real Docker host) was not run; it is recorded as an advisory item below.

### Advisory (New Scope, Unevidenced)

| # | Finding | Category | Why Advisory |
|---|---------|----------|--------------|
| 1 | Live-host confirmation that `ensure_worktree` and the sandbox/VM bind agree under a real non-default `SUBSTRATE_WORKTREE_ROOTS` | other | Needs Docker and a running VM host; code-level agreement is proven by the tests above. Not counted in the score. |
| 2 | Roadmap open items outside the six criteria: no scheduler runs the fleet report; merge-back check-then-note race; no-origin repositories trust local ancestry; the workspace guard has no caller | other | Listed in ROADMAP.md Phase 68 status; not success criteria; not re-checked in this pass. |

### Gaps Summary

No blocking gaps. Criterion 1, the one open at the 2026-11-18 record, now holds: the host resolves the worktree root through `worktree-root.ts`, the dispatcher's `creation_root` applies the same rule, and the named tests cover a non-default root on both sides. Remaining items are documentation drift (`flag-registry.ts` L325, `.env.example` L1127, ROADMAP status text) and are reported as warnings; they do not change the criterion verdicts.

---

_Verified: 2026-11-19T00:53:27Z_
_Verifier: Claude (gsd-verifier)_
