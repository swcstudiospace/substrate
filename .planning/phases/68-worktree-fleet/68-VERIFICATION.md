---
phase: 68-worktree-fleet
verified: 2026-11-15T00:00:00Z
status: human_needed
score: 2/6 must-haves verified (SC1, SC6 VERIFIED; SC2, SC3, SC5 present and wired, behavior not exercised by execution; SC4 UNCERTAIN, prediction bounded at 300 pairs); 0 FAILED
covered_files:
  - .planning/phases/68-worktree-fleet/68-SUMMARY.md
  - packages/cli/src/worktree/args.ts
  - packages/cli/src/worktree/command.test.ts
  - packages/cli/src/worktree/command.ts
  - packages/cli/src/worktree/merge-back.ts
  - packages/cli/src/worktree/scope.ts
  - packages/collectors/src/worktree-graph.ts
  - packages/dispatcher/src/substrate_dispatcher/dispatch.py
  - packages/dispatcher/src/substrate_dispatcher/worktree.py
  - packages/dispatcher/tests/test_worktree.py
  - packages/fleet/src/claims.ts
  - packages/fleet/src/classify.test.ts
  - packages/fleet/src/classify.ts
  - packages/fleet/src/config.ts
  - packages/fleet/src/conflicts.test.ts
  - packages/fleet/src/conflicts.ts
  - packages/fleet/src/disk.test.ts
  - packages/fleet/src/disk.ts
  - packages/fleet/src/ignored.ts
  - packages/fleet/src/inventory.test.ts
  - packages/fleet/src/inventory.ts
  - packages/fleet/src/pr.ts
  - packages/fleet/src/report.ts
  - packages/fleet/src/workspace-guard.ts
  - packages/mcp-server/src/brief-sessions.ts
  - packages/mcp-server/src/brief-worktrees.service.test.ts
  - packages/mcp-server/src/flag-registry.ts
  - packages/mcp-server/src/index-store.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/service.ts
  - packages/mcp-server/src/worktree-registry.pg.test.ts
  - packages/mcp-server/src/worktree-registry.ts
  - scripts/doctor-runtime.test.ts
  - scripts/doctor-runtime.ts
  - scripts/worktree-report.ts
covered_digest: "v3:sha256:004d2c030612868ca33603010f3dde3a78bbe5e3e20ed9c1a3eae40973e95ab4"
behavior_unverified: 3
overrides_applied: 0
behavior_unverified_items:
  - truth: "SC2 (FLEET-02): POST /worktrees/report upserts the reporting host's rows and sweeps that host's expired rows in one transaction"
    test: "packages/mcp-server/src/worktree-registry.pg.test.ts against a live Postgres: report, then an empty report with a far-future seenAt"
    expected: "the host's rows last seen before the cutoff are deleted, other hosts' rows are untouched, and the upserts and the sweep commit together"
    why_human: "The sweep ordering inside one transaction needs a running Postgres. Source shows sql.begin wrapping both steps (worktree-registry.ts:351-385), but that is presence, not an executed invariant."
  - truth: "SC3 (FLEET-03): prune --execute reloads head and branch, re-inspects, re-asks live claims, runs the workspace guard, then runs git worktree remove with no --force, and emits one note per removal"
    test: "packages/cli/src/worktree/command.test.ts: '--execute removes only the safe worktrees, without --force, and writes one ledger note each' (line 185); 'a worktree inside the current directory is never removed'; 'prune --execute does not remove a worktree the guard refuses; SUBSTRATE_WORKTREE_GUARD_ALLOW removes it as before' (line 1069). Also packages/fleet/src/classify.test.ts 'a branch that gained commits after its pull request merged is review, never safe' (line 82) and the real-git case at line 138"
    expected: "all named tests pass; each removal happens only after every check, and the ledger note follows the removal"
    why_human: "The invariant is an ordering across git and HTTP steps (command.ts:401-430). Confirming it means running the named tests, which this verification did not do."
  - truth: "SC5 (FLEET-05): provision and the dispatcher's ensure_worktree refuse below SUBSTRATE_WORKTREE_MIN_FREE_GB and create nothing"
    test: "packages/cli/src/worktree/command.test.ts: 'refuses below the free-disk floor and creates nothing' (provision describe block); packages/dispatcher/tests/test_worktree.py: the ensure_worktree low-disk cases"
    expected: "both refuse before any git worktree add or directory creation; the TypeScript refusal exits 1 and the Python one raises WorktreeRefused with reason low-disk"
    why_human: "'Creates nothing' is an ordering invariant (floor check before creation: command.ts:540 before the add; worktree.py:213-220 before mkdir and add). Presence is shown; execution is not."
human_verification:
  - test: "Run packages/mcp-server/src/worktree-registry.pg.test.ts against a live Postgres (SUBSTRATE_PG_URL)."
    expected: "The reporting host's rows last seen before the cutoff are deleted; other hosts' rows are untouched; upserts and sweep commit together."
    why_human: "Needs a running Postgres; not executed here."
  - test: "Run the named prune tests in packages/cli/src/worktree/command.test.ts (lines 185, 1069, and 'a worktree inside the current directory is never removed') and packages/fleet/src/classify.test.ts (lines 82, 138)."
    expected: "All pass; removal argv is exactly ['worktree','remove',<path>]; one worktree.prune note per removal; the advanced-branch case is review, never safe."
    why_human: "Ordering across git and HTTP steps; confirmed only by an executed test."
  - test: "Run the provision refusal test in packages/cli/src/worktree/command.test.ts and the ensure_worktree low-disk cases in packages/dispatcher/tests/test_worktree.py."
    expected: "Refusal with no git worktree add and no directory created."
    why_human: "'Creates nothing' is an ordering invariant; confirmed only by an executed test."
---

# Phase 68: Worktree Fleet Verification Report

**Phase Goal:** Many sessions can work in git worktrees of the same repository without filling the disk, losing track of which worktree is whose, or finding out about conflicts at merge time.
**Verified:** 2026-11-15
**Status:** human_needed
**Re-verification:** No. Initial verification of this phase record; the prior report had no `gaps:` section, so no gap closure was checked.

**Method:** Goal-backward. Truths come from ROADMAP.md Phase 68 success criteria SC1 to SC6 (always loaded), cross-checked with 68-CONTEXT.md decisions D68-1 to D68-6 and 68-SUMMARY.md. The phase has no PLAN.md files (plan_count 0), so the PLAN frontmatter must-haves contribute nothing. `68-SUMMARY.md` was read as a claim and checked against source. No test suite, tsc, lint, or formatter was run, and no server or service was started. Criteria that only an executed test could confirm are marked as such.

## Goal Achievement

### Observable Truths

| # | Truth (ROADMAP SC) | Status | Evidence |
|---|---|---|---|
| SC1 | `SUBSTRATE_WORKTREE_ROOTS` governs graph attribution; `@substrate/fleet` finds worktrees with `git worktree list --porcelain` from every repository under the roots, including linked worktrees outside them | ✓ VERIFIED | `packages/collectors/src/worktree-graph.ts` `worktreeRoots()` reads the env var and falls back to `WORKTREE_ROOT` (`/var/lib/substrate/worktrees`) only when no absolute entry exists. `packages/fleet/src/inventory.ts:116` `discoverRepos` finds `.git` entries under the roots; `:66-69` `listWorktrees` runs `git worktree list --porcelain -z` with no root filter, so linked worktrees outside the roots are kept; `:441` `collectInventory` lists and inspects each once. The hard-coded value remains only as the unset default. |
| SC2 | `POST /worktrees/report` stores the inventory in `worktrees` (own migration step): path, repo, branch, head, base, dirty, ahead, behind, last commit time, size, session and graph attribution, PR state | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Schema: `packages/mcp-server/src/index-store.ts:748-775` (version 36, `worktrees`), `:872-878` (version 40, `changed_files`, `files_truncated`), `:883-890` (version 41, lower(repo) index). Fields validated in `worktree-registry.ts:223-265` and built in `packages/fleet/src/report.ts:36-78`. Route: `packages/mcp-server/src/server.ts:2432-2453` (401 without a surface, `substrate.worktreeGate(true)` first, `validateWorktreeReport`, write audit, store). `worktrees.disabled` 503 body built in `service.ts:5136-5146`. Route classed as a write in `admission.ts:206`. Flag default off in `flag-registry.ts:323`. Upsert then host-scoped sweep in one `sql.begin` (`worktree-registry.ts:351-385`); the sweep's ordering needs a live Postgres to exercise. |
| SC3 | `prune` is a dry run until `--execute`; removes only clean, pushed, idle worktrees whose HEAD is an ancestor of the default branch or equals a merged PR head; never the primary checkout or the current directory; one ledger note per removal; a test covers a branch that advanced after its merge | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Classes: `packages/fleet/src/classify.ts` `classifyForPrune` (`never`: primary, cwd containment, locked, live claim, dirty, unpushed; `review`: ignored work, idle, unproven HEAD, unknown claim; `safe` only when none apply, with proof `merged` or `pr_merged_heads`). Ignored work counts as review and is refused by the guard; `REGENERABLE_DIRS` (`ignored.ts:18`) is the only exemption. Execute path `packages/cli/src/worktree/command.ts` `commandPrune`: dry run unless `--execute` (~line 383); per candidate `reloadWorktree` (401), re-inspect (406), claim recheck (409-410), `workspaceGuard` (418), `git worktree remove <path>` with no `--force` (424), `emitNote` (430) after removal. First failure stops the run (426-427). Advanced-branch tests: `classify.test.ts:82` and real-git case `:138`. |
| SC4 | `conflicts` lists, for one repository, changed files per worktree against the merge base, the overlapping pairs, a `git merge-tree` prediction for each pair, and a suggested merge order | ? UNCERTAIN (WARNING) | Implemented: `packages/fleet/src/conflicts.ts` `changedFiles` (`:112`), prediction via `git merge-tree --write-tree --name-only` (`:145`, gated at git 2.38 by `supportsMergeTree`), `suggestMergeOrder` (`:158-167`). `command.ts` `commandConflicts` groups worktrees per repository and renders each pair (`:449-527`). Literal criterion not met above the bound: `DEFAULT_MAX_PAIRS = 300` (`conflicts.ts:79`); pairs past it are reported `unavailable` with note `pair limit reached` (`:204-206`). The bound is disclosed in the output, but "for each pair" is not satisfied for more than 300 overlapping pairs. This is a human decision (see Human Verification). |
| SC5 | `SUBSTRATE_WORKTREE_MIN_FREE_GB` is enforced by `provision` and the dispatcher's `ensure_worktree`; the doctor reports worktree disk use against it | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | TypeScript: `command.ts:540` `assertDiskFloor(target, minFreeGbFromEnv(...))` runs before `git worktree add` (following line); `packages/fleet/src/disk.ts` `assertDiskFloor`; default 5 in `packages/fleet/src/config.ts`. Python: `packages/dispatcher/src/substrate_dispatcher/worktree.py` `min_free_bytes` (`:57-59`) and `ensure_worktree` checks `disk_usage(...).free` against it (`:213-220`) before any `mkdir` or git call (`:233`, `:242`). Doctor: `scripts/doctor-runtime.ts` `compareWorktreeDisk` (`:796-799`), `worktreeOptionsFromEnv` (`:880-882`, row only when roots are configured), wired at `:915`. Tests exist: provision refusal "creates nothing" in `command.test.ts`; `test_worktree.py` low-disk cases. Not executed. |
| SC6 | With the registry on, `memory_brief` names other sessions' worktrees that touch files the caller's worktree touches | ✓ VERIFIED | `packages/mcp-server/src/service.ts:3909` returns no sections when both the sessions flag and the registry are off; `:3943` builds the worktrees source only when `repo` and `session_id` are named; `worktreeAccess` (`:5136`) gates on `SUBSTRATE_WORKTREE_REGISTRY`. `packages/mcp-server/src/brief-sessions.ts` `worktreesSection` (`:256-312`): the caller's files are the union of its own rows' `files`; another session's row must name another session, not be primary, not be a clean merged or closed row (`finished`), be seen within 24 hours (`BRIEF_WORKTREE_WINDOW_MS`, `:177`), and share a file. At most 5 worktrees (`:173`) and 5 named files each (`:175`). A failed read becomes a note (`composeLiveSections`, `:357-382`). Tests: `brief-worktrees.service.test.ts:86-150`; not executed here, but this is an output-selection rule, not an ordering invariant. |

**Score:** 2/6 truths verified (SC1, SC6). 3 present and wired but behavior not exercised by execution (SC2, SC3, SC5). 1 uncertain (SC4). 0 FAILED.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/fleet/src/inventory.ts` | Git discovery and listing, `collectInventory` | ✓ VERIFIED | Lines 66-69, 116, 441. |
| `packages/collectors/src/worktree-graph.ts` | Roots from `SUBSTRATE_WORKTREE_ROOTS` | ✓ VERIFIED | `worktreeRoots()`; hard-coded value is the unset fallback only. |
| `packages/mcp-server/src/index-store.ts` | Migrations 36, 40, 41 | ✓ VERIFIED | `:748-775`, `:872-890`. |
| `packages/mcp-server/src/worktree-registry.ts` | Validation, one-transaction report, listing | ✓ VERIFIED (structure) | `:223-265`, `:351-385`. Sweep ordering not executed. |
| `packages/mcp-server/src/server.ts` | `POST /worktrees/report`, `GET /worktrees`, `GET /worktrees/claims` | ✓ VERIFIED | `:2432-2453`, `:2461`, `:2482`. |
| `packages/fleet/src/classify.ts` | Prune classes | ✓ VERIFIED (logic) | `classifyForPrune`; tests at `classify.test.ts:82, :138`. |
| `packages/fleet/src/workspace-guard.ts` | Guard used before removal | ✓ VERIFIED | `workspaceGuard` (`:193`); `probe` (`:151-172`) refuses dirty, unpushed, submodule, ignored work; `planningReasons` (`:~180`). Fail closed. Caller is `commandPrune` (`command.ts:418`) and `guard` (`command.ts:583`). |
| `packages/cli/src/worktree/command.ts` | Prune execute path, conflicts, provision | ✓ VERIFIED (wiring) | Prune `:401-430`; conflicts `:449-527`; provision floor `:540`. |
| `packages/fleet/src/conflicts.ts` | merge-tree forecast, merge order | ⚠️ present; bound at 300 pairs | `:145`, `:158-167`, `:79`, `:204-206`. |
| `packages/fleet/src/disk.ts`, `config.ts` | Floor and pressure | ✓ VERIFIED (logic) | `assertDiskFloor`, `diskPressure`, `minFreeGbFromEnv`. |
| `packages/dispatcher/src/substrate_dispatcher/worktree.py` | Floor before creation; roots | ✓ VERIFIED (wiring) | `worktree_roots` (`:62-78`), `ensure_worktree` floor (`:213-220`). |
| `scripts/doctor-runtime.ts` | Worktree disk row | ✓ VERIFIED (wiring) | `:796-799`, `:880-882`, `:915`. |
| `packages/mcp-server/src/brief-sessions.ts` | Overlap section | ✓ VERIFIED (logic) | `:256-312`, `:357-382`. |
| `packages/mcp-server/src/service.ts` | Brief source and registry access | ✓ VERIFIED (wiring) | `:3909`, `:3943`, `:5136-5146`. The uncommitted diff does not touch these (see Covered Input Note). |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `commandPrune` | `reloadWorktree` and `inspectWorktree` | git re-read before classify | ✓ WIRED | `command.ts:401`, `:406`. |
| `commandPrune` | `workspaceGuard` | guard call before removal | ✓ WIRED | `command.ts:418`; a refusal stops the run (`:419-421`). |
| `commandPrune` | `git worktree remove` | argv without `--force` | ✓ WIRED | `command.ts:424`; test asserts the exact argv (`command.test.ts:185`). |
| `commandPrune` | `POST /events` ledger note | `emitNote` after removal | ✓ WIRED | `command.ts:430`; notes only after a successful remove. |
| `claimStatus` | `GET /worktrees/claims` | prune claim check | ✓ WIRED | `command.ts:172`, `:410`; route at `server.ts:2461`. |
| `worktreesSection` | `WorktreeRegistryStore.candidates` | brief source | ✓ WIRED | `service.ts:3943` to `brief-sessions.ts:256`. |
| `POST /worktrees/report` | `PgWorktreeRegistry.report` | `substrate.reportWorktrees` | ✓ WIRED | `server.ts:2446-2452`; store at `worktree-registry.ts:351`. |
| `ensure_worktree` | floor check | before `mkdir` and `git worktree add` | ✓ WIRED | `worktree.py:213-220`, `:233`, `:242`. |
| `provision` | `assertDiskFloor` | before `git worktree add` | ✓ WIRED | `command.ts:540`, then add. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `GET /worktrees` listing | rows | `worktrees` table (`list`, `worktree-registry.ts:388-405`) | Yes, from reported inventory | ✓ FLOWING |
| Brief `worktrees` section | `rows` | `candidates()` (`worktree-registry.ts:411-417`) | Yes, from stored `changed_files` | ✓ FLOWING |
| Doctor worktree row | `pressure` | `diskPressure` over real `statfsSync` and git | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

Step 7b: SKIPPED. The assignment forbids running the test suite and starting services. The named tests are routed to Human Verification.

### Probe Execution

No probe is declared in 68-CONTEXT.md or 68-SUMMARY.md. Not searched further.

### Requirements Coverage

Every FLEET ID in REQUIREMENTS.md (lines 58-63) is accounted for. Each maps to one roadmap success criterion.

| Requirement | Maps to SC | Source Plan | Description (abridged) | Status | Evidence |
|---|---|---|---|---|---|
| FLEET-01 | SC1 | none (no PLAN) | Worktree locations configurable; every worktree found through git | ✓ SATISFIED | `inventory.ts:66-69`, `:116`; `worktree-graph.ts` `worktreeRoots()`; `fleet/src/config.ts` `worktreeRootsFromEnv`; `command.ts` `--root` and env. |
| FLEET-02 | SC2 | none | Registry records path, repo, branch, head, base, dirty, ahead/behind, last activity, size, attribution | ⚠️ SATISFIED WITH WARNINGS | All fields present in schema and report, except "last activity": only `last_commit_at` is stored. File-activity time (`last_activity_at`) is computed for prune but not reported (see Warning W7). Sweep ordering unexecuted (H1). |
| FLEET-03 | SC3 | none | Prune only clean, pushed, merged-HEAD worktrees, never primary; records each removal | ⚠️ NEEDS EXECUTION | Logic and wiring verified in source (`classify.ts`, `command.ts:355-448`, guard at `:418`). Ordering and removal argv confirmed only by the named tests (H2). |
| FLEET-04 | SC4 | none | Conflicts predicted for active worktrees with suggested merge order | ? UNCERTAIN | Implemented via `merge-tree`, but predictions stop at 300 pairs (`conflicts.ts:79`, `:204-206`). Human decision (D1). |
| FLEET-05 | SC5 | none | Creation refuses below floor; doctor reports disk pressure | ⚠️ NEEDS EXECUTION | Floor in `command.ts:540`, `worktree.py:213-220`, doctor row `doctor-runtime.ts:796-799`. "Creates nothing" confirmed only by tests (H3). |
| FLEET-06 | SC6 | none | Brief names other sessions' worktrees touching the same files | ✓ SATISFIED | `brief-sessions.ts:256-312`; `service.ts:3943`. Tests present, not executed. |

**Orphaned requirements:** None. Every FLEET ID is claimed by SC1 to SC6.

**Traceability note:** REQUIREMENTS.md line 99 reads "audit: 4 MET, 2 PARTIAL" and the checkboxes at lines 58-63 are unchecked. This verification does not edit either. It reports 2 verified, 3 needing execution, and 1 uncertain.

### Anti-Patterns Found

Debt-marker scan (`TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER|not implemented`) over the phase-68 implementation files: no matches. No debt-marker gate blocker.

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `packages/fleet/src/conflicts.ts` | 79 | Hard prediction bound of 300 pairs | ⚠️ Warning | Disclosed in output; criterion is literal "each pair" (SC4). |
| `packages/fleet/src/workspace-guard.ts` | 3, 9 | Read-only guard, called before removal | ℹ️ Info | Not an anti-pattern. Noted for W4. |

### Human Verification Required

1. **Postgres sweep ordering (SC2 / FLEET-02).** Run `packages/mcp-server/src/worktree-registry.pg.test.ts` against a live Postgres. Expect the reporting host's rows older than the cutoff to be deleted, other hosts untouched, and upserts and sweep to commit together.
2. **Prune ordering and removal argv (SC3 / FLEET-03).** Run the named tests: `command.test.ts` lines 185 and 1069 and "a worktree inside the current directory is never removed"; `classify.test.ts` lines 82 and 138. Expect all to pass, the argv to be exactly `['worktree','remove',<path>]`, one `worktree.prune` note per removal, and the advanced-branch case to be `review`.
3. **Floor refusal creates nothing (SC5 / FLEET-05).** Run the provision refusal test in `command.test.ts` and the `ensure_worktree` low-disk cases in `packages/dispatcher/tests/test_worktree.py`. Expect refusal before any `git worktree add` or directory creation.

**Decisions for the owner (not verification items):**

- **D1 (SC4 / FLEET-04).** Accept the 300-pair bound as the criterion's meaning, or lift it so every overlapping pair gets a prediction. Until decided, SC4 stays UNCERTAIN.
- **D2 (FLEET-02).** Accept `last_commit_at` as "last activity", or add the file-activity time that prune already computes to the report.

### Gaps Summary

No BLOCKER. No truth is FAILED and no artifact is missing or a stub. The status is `human_needed` because three truths are present and wired but unexecuted (SC2 sweep, SC3 ordering, SC5 ordering), and SC4 is uncertain at the 300-pair bound.

**Warnings (not criteria; they do not change the status):**

1. **No scheduler runs the fleet report (W1).** `scripts/worktree-report.ts` says it is "for a host timer", but no `.timer` or `.service` in the tracked tree runs `scan --report` or `prune`. `infra/vps/substrate-host.service` runs only `packages/host/src/main.ts`. Operator-gated.
2. **Merge-back race narrowed, not closed (W2).** `merge-back.ts` `unchangedSince` compares HEAD, branch and detached state, not cleanliness.
3. **Merge-back trusts local ancestry when there is no origin (W3).** `resolveDefaultRef` falls back to a local `main` or `master` (`inventory.ts:281-288`). Prune is not affected: the guard's `rev-list --count HEAD --not --remotes` fails closed for a repository with no remotes, and classify treats an unpushed head as `never`.
4. **Prune window between checks and removal (W4).** `command.ts:410-424`: a write after the claim recheck and guard, and before `git worktree remove`, is not detected.
5. **Conflict predictions bounded at 300 pairs (W5).** Same as D1.
6. **Dispatcher refuses an existing worktree on low disk (W6, new in this pass).** `worktree.py` runs the floor check (`:213-220`) before the reuse branch (`:221-225`). An already-registered worktree is refused with `low-disk` when disk is low, though nothing would be created. Stricter than the criterion requires. Owner should confirm this is intended.
7. **FLEET-02 wording (W7).** See D2.
8. **Fallback root (W8).** With `SUBSTRATE_WORKTREE_ROOTS` unset, the collector and dispatcher use `/var/lib/substrate/worktrees`. SC1 is met whenever the variable is set.

## Reconciliation with the prior record

| Prior item | Now |
|---|---|
| SC1 VERIFIED | Still VERIFIED. |
| SC4 VERIFIED | **Changed to UNCERTAIN.** The literal "each pair" criterion is not met above 300 overlapping pairs. The earlier verdict did not weigh the bound. |
| SC6 VERIFIED | Still VERIFIED. |
| SC2, SC3, SC5 present, not executed | Unchanged. |
| Guard has no caller | Resolved: `command.ts:418` (prune) and `command.ts:583` (`guard`). |
| Dispatcher ignores `SUBSTRATE_WORKTREE_ROOTS` | Resolved: `worktree.py` `worktree_roots()`. |
| No scheduler runs `scan --report` | Still open (W1). |
| Merge-back race not closed | Still open (W2). |
| Digest stale (`service.ts` edited) | Resolved: fingerprint recomputed. `service.ts` has an uncommitted diff (below). |
| ROADMAP line 133 "PARTIAL (criterion 1)" | Out of date for criterion 1; ROADMAP is not edited here. |

## Covered Input Note

`packages/mcp-server/src/service.ts` has an uncommitted diff (43 insertions, 8 deletions) that does not concern worktrees. It adds a graph-claim prerequisite check (`claimNode`, around line 5508 to 5536, returning `prerequisite-open`) and changes cycle detection in `assertGraphEdges` (lines 1008-1060). The worktree paths relied on by SC6 (`:3909`, `:3943`) and SC2 (`:5136-5146`) are outside those hunks. The digest covers the current file contents as read, which is why it differs from the prior record.

---

_Verified: 2026-11-15_
_Verifier: Claude (gsd-verifier)_
