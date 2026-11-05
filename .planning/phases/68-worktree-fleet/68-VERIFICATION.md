---
phase: 68-worktree-fleet
verified: 2026-11-05T00:13:28Z
status: human_needed
score: 7/8 truths verified (1 present-behavior-unverified: dispatcher reuse under a non-first configured root)
covered_files: [".planning/phases/68-worktree-fleet/68-SUMMARY.md", "packages/audit/src/policy.ts", "packages/cli/src/worktree/args.ts", "packages/cli/src/worktree/command.test.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/merge-back.ts", "packages/collectors/src/worktree-graph.test.ts", "packages/collectors/src/worktree-graph.ts", "packages/dispatcher/src/substrate_dispatcher/worktree.py", "packages/dispatcher/tests/test_worktree.py", "packages/fleet/src/claims.test.ts", "packages/fleet/src/claims.ts", "packages/fleet/src/classify.test.ts", "packages/fleet/src/classify.ts", "packages/fleet/src/config.test.ts", "packages/fleet/src/config.ts", "packages/fleet/src/conflicts.test.ts", "packages/fleet/src/conflicts.ts", "packages/fleet/src/disk.test.ts", "packages/fleet/src/disk.ts", "packages/fleet/src/ignored.test.ts", "packages/fleet/src/ignored.ts", "packages/fleet/src/inventory.test.ts", "packages/fleet/src/inventory.ts", "packages/fleet/src/pr.test.ts", "packages/fleet/src/pr.ts", "packages/fleet/src/report.test.ts", "packages/fleet/src/report.ts", "packages/fleet/src/workspace-guard.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/brief-sessions.ts", "packages/mcp-server/src/brief-worktrees.service.test.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-claims.test.ts", "packages/mcp-server/src/worktree-claims.ts", "packages/mcp-server/src/worktree-registry-fake.ts", "packages/mcp-server/src/worktree-registry.http.test.ts", "packages/mcp-server/src/worktree-registry.pg.test.ts", "packages/mcp-server/src/worktree-registry.test.ts", "packages/mcp-server/src/worktree-registry.testkit.ts", "packages/mcp-server/src/worktree-registry.ts", "scripts/doctor-runtime.ts"]
covered_digest: "v3:sha256:e8c23532d4f23792c34e63612a75be5bb129a58184db5c03684cd4a5c97d2150"
behavior_unverified: 1
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 7/7
  gaps_closed:
    - "SC1 (dispatcher ignores SUBSTRATE_WORKTREE_ROOTS): worktree.py now reads it with the fleet reader's parsing and creates new worktrees under the first root (3c5dcfa0; owner decision 2026-11-04, recorded in the ROADMAP SC1 text). Owner-decision human item closed."
    - "Disk-floor and dispatcher wording in .env.example, flag-registry.ts, fleet config, worktree-graph.ts and docs/worktree-fleet-api.md corrected to the implemented behavior (3c5dcfa0)."
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Add and run a dispatcher test that registers a worktree for graph G under the second of two configured roots, then calls ensure_worktree(repo, G, base, run=...) with SUBSTRATE_WORKTREE_ROOTS set to both roots (no root argument)."
    expected: "The existing worktree path under the second root is returned, and no `worktree add` call is made (the `worktree list --porcelain` output carries that path)."
    why_human: "worktree.py `ensure_worktree` (lines 168-186) checks every configured root for a registered worktree, but no test in test_worktree.py exercises a match under a non-first root; the existing reuse test (line 108) uses a pinned root. The verifier does not write tests."
---

# Phase 68: Worktree Fleet Verification Report

**Phase Goal:** Many sessions can work in git worktrees of the same repository without filling the disk, losing track of which worktree is whose, or finding out about conflicts at merge time.
**Verified:** 2026-11-05T00:13:28Z
**Status:** human_needed
**Re-verification:** Yes. Head c40ffc9a (prior record at head 9e71f263 was human_needed, 7/7). The owner-decision item on SC1 is closed by 3c5dcfa0. A new present-behavior-unverified item for reuse under a non-first root is raised here. The covered list is unchanged (47 entries); the fingerprint was regenerated.

## Scope and method

- Head c40ffc9a. The phase directory holds `68-CONTEXT.md`, `68-SUMMARY.md` and this record; there is no `*-PLAN.md`, so must-haves come from the ROADMAP Phase 68 success criteria (Step 2a). Steps 4 and 5 are not applicable (no plan `must_haves`).
- Covered list: the 47 entries of the record this replaces, unchanged. `covered_files` and `covered_digest` are the output of `gsd_run query verification.fingerprint .planning/phases/68-worktree-fleet <47 files>` run at this head.
- Changes since the prior head 9e71f263 that touch covered files (`git diff --name-only 9e71f263 c40ffc9a` intersected with the covered list): `worktree.py`, `test_worktree.py`, `collectors/src/worktree-graph.ts` (comments), `fleet/src/config.ts` (comment), `mcp-server/src/flag-registry.ts` (text and the unrelated wave-6 `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` row), `mcp-server/src/index-store.ts` (archive restore: `smallint`/`jsonb`, `advanceIdentity`), `mcp-server/src/service.ts` (`recordSyncLag` on docs sync, retrieval telemetry `isPrivate`). The two wave-6 hunks in `index-store.ts` and `service.ts` contain no worktree or brief wiring (keyword check on the diff: zero matches), so truths 2-6 are carried forward unchanged, and truth 7 is re-observed at this head by the Postgres run below.
- Not re-run in this pass: `packages/mcp-server/src/flag-registry.test.ts` (the `flag-registry.ts` change is a text change to the worktree row and the unrelated sync-lag row; the non-PG budget for this pass was used by the runs listed below). The non-PG suites for truths 2-6 are carried forward from the 9e71f263 record.
- Postgres: scratch Postgres 16 at 127.0.0.1:5439, database `substrate_test_v68`. Production and port 5432 not touched.
- Debt-marker gate (Step 7): no `TBD`, `FIXME`, `XXX`, `TODO`, `HACK` or `PLACEHOLDER` in the non-test covered implementation files changed in this range. Zero blockers.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1 (fleet and collector): `@substrate/fleet` finds worktrees via `git worktree list --porcelain` from every repository under the configured roots, including linked worktrees outside them; `SUBSTRATE_WORKTREE_ROOTS` replaces the hard-coded root in `worktree-graph.ts` | ✓ VERIFIED | `worktree-graph.ts` `worktreeRoots` (lines 18-31) reads the variable, drops relative entries, and falls back to `WORKTREE_ROOT` only when no absolute entry remains. `inventory.ts` runs `worktree list --porcelain -z`; `collectInventory` keeps every listed non-bare entry with no root filter. `worktree-graph.test.ts` and `config.test.ts` pass (run below: 15 pass). |
| 2 | SC2: `POST /worktrees/report` stores path, repo, branch, head, base, dirty, ahead, behind, last commit time, size, session and graph attribution, PR state in `worktrees` (its own migration step) | ✓ VERIFIED (in-memory contract; Postgres contract observed in truth 7) | Migration step 36 `worktrees` (`index-store.ts`, phase `expand`, no `optIn`) has every listed column. Route `server.ts` line 2336: 401 without a surface, `worktreeGate(true)` refusal, body capped at `WORKTREE_REPORT_MAX_BYTES`, audited, then `reportWorktrees`. `report.ts` builds the contract fields. `worktree-registry.test.ts` and `worktree-registry.http.test.ts` pass (carried forward from 9e71f263). |
| 3 | SC3: `prune` is a dry run until `--execute`; removes only clean, pushed, idle, proven-merged worktrees; never the primary checkout or the current directory; one ledger note per removal; a test covers a branch that advanced after its merge | ✓ VERIFIED (carried forward) | `classify.ts`: `never` for primary, cwd, locked, live claim, dirty, unpushed (unless a merged PR head). `command.ts` `git worktree remove` with no `--force`; one `worktree.prune` note per removal. `classify.test.ts` "a branch that gained commits after its pull request merged is review, never safe" passes (9e71f263 record). |
| 4 | SC4: `conflicts` lists changed files per worktree against the merge base, overlapping pairs, a `git merge-tree --write-tree` prediction per pair, and a suggested merge order | ✓ VERIFIED (carried forward) | `conflicts.ts`: `MIN_MERGE_TREE_VERSION = [2, 38]`, `git merge-tree --write-tree --name-only`, `suggestMergeOrder` and `forecastConflicts` present. `conflicts.test.ts` passes (9e71f263 record). |
| 5 | SC5: `SUBSTRATE_WORKTREE_MIN_FREE_GB` enforced by `provision` and the dispatcher's `ensure_worktree`; doctor reports worktree disk use against it | ✓ VERIFIED (caveat: dispatcher floor reads `/` only) | `command.ts` line 490 `assertDiskFloor(target, minFreeGbFromEnv(...))`; `config.ts` reads the variable, default 5; `worktree.py` `ensure_worktree` refuses before any git command via `min_free_bytes()` (line 174, `disk_usage("/")`). `scripts/doctor-runtime.ts` `gatherWorktreeDisk` adds a row only when roots are set. Caveat: the floor is checked on `/`, not on the root the worktree is created under. Open item 2. `test_worktree.py` passes (32 pass, run below). |
| 6 | With the registry on, `memory_brief` names other sessions' worktrees that touch the caller's files | ✓ VERIFIED (carried forward) | `brief-sessions.ts` `worktreesSection` (line 256) excludes other repositories and clean merged or closed rows. `service.ts` `liveBriefSections` returns no section unless `briefSessions` or `worktreeRegistry.mode === "on"`; the wave-6 `service.ts` hunks do not touch it. `brief-worktrees.service.test.ts` passes (9e71f263 record), including the registry-off case. |
| 7 | FLEET-02 invariant: a scan report that omits `session_id` or `graph_id` keeps the stored value, and one that carries it replaces that value (commit 4ac536e4, ancestor of HEAD) | ✓ VERIFIED (behavioral, scratch Postgres 16, re-run at c40ffc9a) | `worktree-registry.ts` line 381 `session_id = coalesce(excluded.session_id, worktrees.session_id), graph_id = coalesce(excluded.graph_id, worktrees.graph_id)`; `worktree-registry-fake.ts` keeps `session_id ?? previous`. Run: `worktree-registry.pg.test.ts` on `substrate_test_v68` = **13 pass, 0 fail, 42 expect() calls**, including "a report that omits session_id or graph_id keeps the stored value, and one that carries it replaces that value" (test line 79). |
| 8 | Dispatcher honours `SUBSTRATE_WORKTREE_ROOTS` (ROADMAP SC1 as amended by owner decision 2026-11-04): it parses the variable as the fleet does (colon separated, trimmed, absolute only, normalised, de-duplicated), reuses a worktree git already has under any configured root, and creates new ones under the first; unset falls back to the default directory | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (creation under the first configured root ✓ VERIFIED; reuse under a non-first root not exercised) | `worktree.py` `worktree_roots` (lines 62-78) parses as the fleet does; unset returns `[WORKTREES_ROOT]` (line 27). `ensure_worktree` (lines 153-199) passes `roots` into the `_registered` loop (lines 168-186) and creates under `roots[0]` (line 192). Creation under a configured root is exercised by `test_ensure_worktree_creates_under_the_configured_root` (test line 218, passes). The reuse loop over non-first roots has no test: the only reuse test (`test_ensure_worktree_creates_then_reuses`, line 108) uses a pinned `root=`. Present and wired; behavior unexercised. |

**Score:** 7/8 truths verified (1 present-behavior-unverified)

### Deferred Items

None. Later phases (69-78) do not address the worktree-fleet gaps listed below.

### Required Artifacts

Not applicable: no `*-PLAN.md` `must_haves.artifacts` in the phase directory. Artifacts were checked by existence and wiring through the truths above.

### Key Link Verification

Not applicable as plan key links (no `must_haves.key_links`). Wiring checked manually:

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `packages/cli/src/worktree/command.ts` | `POST /worktrees/report` | `postReport` / `httpReportPoster` | WIRED | CLI posts the reports built by `buildReports` |
| `packages/fleet/src/report.ts` | `worktree-registry.ts` | `checkWorktreeRow`, byte and item limits imported from the registry | WIRED | |
| `server.ts` route | `PgWorktreeRegistry.report` | `substrate.reportWorktrees` | WIRED | Postgres path exercised by truth 7 run |
| `service.ts liveBriefSections` | `worktreesSection` | `brief-sessions.ts` line 256 | WIRED | gated by the flag |
| `worktree.py ensure_worktree` | configured roots | `worktree_roots()` (line 168) | WIRED | parsing matches `worktreeRootsFromEnv`; reuse loop covers all roots |
| `worktree.py ensure_worktree` | free-space floor | `min_free_bytes()` | WIRED | `/` only (line 174) |
| `worktree-graph.ts` | `SUBSTRATE_WORKTREE_ROOTS` | `worktreeRoots` | WIRED | fallback to constant when unset |
| `workspaceGuard` | any caller | `command.ts` `guard` subcommand only | NOT_WIRED to removal paths | Not a plan key link and not a ROADMAP criterion; open item 6 |

### Data-Flow Trace (Level 4)

The registry reads and writes real SQL rows (Postgres path, exercised by the truth 7 run) or the in-memory store (contract tests). No UI renders these values. The attribution path in `report.ts` reads real claims (`claims.ts`) and sessions, not literals. The dispatcher root list is read from the process environment at call time (`worktree_roots`).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Dispatcher worktree suite incl. configured-root creation (truths 5, 8) | `python3 -m pytest packages/dispatcher/tests/test_worktree.py -q` | 32 passed | ✓ PASS |
| FLEET-02 attribution kept; PG contract (truth 7) | `cd packages/mcp-server && SUBSTRATE_TEST_PG_URL=postgres://postgres:…@127.0.0.1:5439/substrate_test_v68 TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test src/worktree-registry.pg.test.ts` | 13 pass, 0 fail, 42 expects (scratch Postgres 16) | ✓ PASS |
| Collector root parsing and fleet config (truth 1) | `bun test packages/fleet/src/config.test.ts packages/collectors/src/worktree-graph.test.ts` | 15 pass, 0 fail, 51 expects | ✓ PASS |
| Phase 68 non-PG suites for truths 2-4, 6 | carried forward from the 9e71f263 record | (not re-run in this pass) | carried |

### Probe Execution

No probes declared for this phase.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| FLEET-01 | none (no PLAN files) | Worktree locations configurable; worktrees found through git | ✓ SATISFIED | SC1 truth 1; dispatcher reads the variable (truth 8, creation verified, reuse-under-non-first-root unverified) |
| FLEET-02 | none (no PLAN files) | Registry records path, repo, branch, head, base, dirty, ahead/behind, last activity, size, attributed session or graph | ✓ SATISFIED | SC2 truth 2 plus invariant truth 7 (Postgres observed, 13 pass) |
| FLEET-03 | none | prune removes only clean, pushed, merged, never primary, records each removal | ✓ SATISFIED | SC3 truth 3; targeted runs passed in 9e71f263 record |
| FLEET-04 | none | conflicts predicts textual conflicts and suggests a merge order | ✓ SATISFIED | SC4 truth 4; targeted runs passed in 9e71f263 record |
| FLEET-05 | none | creation refuses below a free-disk floor; doctor reports disk pressure | ✓ SATISFIED (caveat: `/` only) | SC5 truth 5; `test_worktree.py` 32 pass |
| FLEET-06 | none | brief names other sessions' worktrees that touch the same files | ✓ SATISFIED | SC6 truth 6; targeted runs passed in 9e71f263 record |

Orphaned requirements: none. All six IDs are declared on the ROADMAP Phase 68 line; no PLAN file claims them.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/dispatcher/src/substrate_dispatcher/worktree.py` | 174 | Disk floor on `/` only | ⚠️ Warning | Open item 2 |
| `packages/fleet/src/workspace-guard.ts` | — | Guard has no caller in removal paths (`command.ts` guard subcommand only) | ⚠️ Warning | Open item 6 |

No debt markers (`TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER`) in the covered implementation files. No stub patterns in the registry or report code read. No blocker anti-pattern.

### Human Verification Required

1. **Dispatcher reuse under a non-first configured root (truth 8)**
   - Test: Add and run a dispatcher test that registers a worktree for graph G under the second of two configured roots, then calls `ensure_worktree(repo, G, base, run=...)` with `SUBSTRATE_WORKTREE_ROOTS` set to both roots and no `root` argument.
   - Expected: The existing worktree path under the second root is returned, and no `worktree add` call is made.
   - Why human: `ensure_worktree` checks every configured root for a registered worktree (lines 168-186), but no test in `test_worktree.py` exercises a match under a non-first root. The verifier does not write tests.

The owner decision on the dispatcher root (SC1) is recorded in the ROADMAP SC1 text (owner decision, 2026-11-04) and implemented in 3c5dcfa0; it is closed here.

### Gaps Summary

No truth FAILED. No artifact MISSING or STUB. No debt marker. The Postgres attribution invariant (truth 7) is observed on scratch Postgres 16: 13 of 13 pass at c40ffc9a. The dispatcher root decision that kept SC1 PARTIAL is closed by 3c5dcfa0.

Status is `human_needed` because truth 8 is present and wired but its reuse-under-a-non-first-root behavior has no test. Open items, not verifier blockers (owner or operator decisions):

1. The dispatcher's disk floor reads `/` only (`worktree.py` line 174), not the root the worktree is created under.
2. No scheduler runs `substrate worktree scan --report` (carried from SUMMARY "What remains"; the registry is only as fresh as the last manual run). Operator-gated.
3. Merge-back's check-then-note race is narrowed, not closed (carried from SUMMARY).
4. A repository with no origin trusts local ancestry for "merged" and "pushed" (`inventory.ts` default-ref fallback; carried from SUMMARY).
5. The guard has no caller in removal paths: `workspaceGuard` is reached only through `substrate worktree guard` (`command.ts`).
6. Attribution is kept across silent reports by design (4ac536e4). A worktree whose session ended keeps its `session_id` until the row is swept, so the registry can name a finished session.
7. The ROADMAP Phase 68 header and progress row still read "PARTIAL (criterion 1)"; not edited by this verifier. The orchestrator should update them once the human item above is closed.
8. REQUIREMENTS.md still shows FLEET-01 to FLEET-06 unchecked; not edited here.

Operator-gated, not run: installing a timer for `scan --report` or `prune`; setting `SUBSTRATE_WORKTREE_REGISTRY=on`; setting `SUBSTRATE_WORKTREE_ROOTS` on a host; `prune --execute` or `merge-back --execute` on a real checkout.

behavior_unverified_items:
  - truth: "Dispatcher reuses a worktree git already has under any configured root (SUBSTRATE_WORKTREE_ROOTS), not only the first or a pinned root"
    test: "Two configured roots; register a worktree for graph G under the second root; call ensure_worktree with no root argument"
    expected: "The existing path under the second root is returned and no `worktree add` runs"
    why_human: "The reuse loop in worktree.py ensure_worktree (lines 168-186) has no test; the only reuse test (line 108) uses a pinned root"

---

_Verified: 2026-11-05T00:13:28Z_
_Verifier: Claude (gsd-verifier)_
