---
phase: 68-worktree-fleet
verified: 2026-11-04T23:06:59Z
status: human_needed
score: 7/7 truths verified (behavior-verified on scratch Postgres 16)
covered_files: [".planning/phases/68-worktree-fleet/68-SUMMARY.md", "packages/audit/src/policy.ts", "packages/cli/src/worktree/args.ts", "packages/cli/src/worktree/command.test.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/merge-back.ts", "packages/collectors/src/worktree-graph.test.ts", "packages/collectors/src/worktree-graph.ts", "packages/dispatcher/src/substrate_dispatcher/worktree.py", "packages/dispatcher/tests/test_worktree.py", "packages/fleet/src/claims.test.ts", "packages/fleet/src/claims.ts", "packages/fleet/src/classify.test.ts", "packages/fleet/src/classify.ts", "packages/fleet/src/config.test.ts", "packages/fleet/src/config.ts", "packages/fleet/src/conflicts.test.ts", "packages/fleet/src/conflicts.ts", "packages/fleet/src/disk.test.ts", "packages/fleet/src/disk.ts", "packages/fleet/src/ignored.test.ts", "packages/fleet/src/ignored.ts", "packages/fleet/src/inventory.test.ts", "packages/fleet/src/inventory.ts", "packages/fleet/src/pr.test.ts", "packages/fleet/src/pr.ts", "packages/fleet/src/report.test.ts", "packages/fleet/src/report.ts", "packages/fleet/src/workspace-guard.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/brief-sessions.ts", "packages/mcp-server/src/brief-worktrees.service.test.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-claims.test.ts", "packages/mcp-server/src/worktree-claims.ts", "packages/mcp-server/src/worktree-registry-fake.ts", "packages/mcp-server/src/worktree-registry.http.test.ts", "packages/mcp-server/src/worktree-registry.pg.test.ts", "packages/mcp-server/src/worktree-registry.test.ts", "packages/mcp-server/src/worktree-registry.testkit.ts", "packages/mcp-server/src/worktree-registry.ts", "scripts/doctor-runtime.ts"]
covered_digest: "v3:sha256:aa9a4bc34de9712dcc430fb94eddd1cdf97c5419c961e97f3cee079927c87c53"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 7/7
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Owner decision: does SC1 close with the dispatcher honouring SUBSTRATE_WORKTREE_ROOTS, or is the ROADMAP PARTIAL label kept?"
    expected: "Decision recorded. Closing requires dispatcher/src/substrate_dispatcher/worktree.py to read SUBSTRATE_WORKTREE_ROOTS in place of the fixed WORKTREES_ROOT (line 25). Keeping the label leaves SC1 PARTIAL."
    why_human: "The dispatcher root is an owner-held open decision (binding decision list). The code path is observable but the scope call is not a code fact."
---

# Phase 68: Worktree Fleet Verification Report

**Phase Goal:** Many sessions can work in git worktrees of the same repository without filling the disk, losing track of which worktree is whose, or finding out about conflicts at merge time.
**Verified:** 2026-11-04T23:06:59Z
**Status:** human_needed
**Re-verification:** Yes — re-run at HEAD 9e71f263. Same status and score as the record it replaces; the covered list was re-derived and the fingerprint rewritten.

## Scope and method

- Head 9e71f263. The phase directory holds `68-CONTEXT.md`, `68-SUMMARY.md` and this record; there is no `*-PLAN.md`, so must-haves come from the ROADMAP Phase 68 success criteria (Step 2a). Steps 4 and 5 are not applicable (no plan `must_haves`).
- Covered list re-derived from `68-SUMMARY.md` "What was built" (every named file resolved to a repository path that exists at HEAD), plus the phase's own test files for those modules. The list is 47 entries (the record it replaces listed 34; it omitted `ignored.ts`, `pr.ts`, `args.ts`, `worktree-claims.ts`, `admission.ts`, `mcp.ts`, `policy.ts`, `event-sources.ts`, `flag-registry.ts`, the `dispatcher/tests/test_worktree.py` file, and the fleet, collector and claims tests). The fingerprint was produced by `gsd_run query verification.fingerprint`; `covered_files` and `covered_digest` are copied from its output.
- Digest note: the replaced record's own list (34 entries) was re-run through `verification.fingerprint` at this head and reproduced its digest `v3:sha256:75a940e9…`. The new digest covers the wider list and is the one recorded above. The fingerprint is deterministic: two runs gave the same digest.
- Code change check since 504da465: `git diff --name-only 504da465 9e71f263` lists 7 files (corpus runbook, reconcile drop-in example, `corpus/proofs.test.ts`, `fabric/status.ts`, `fabric/status.test.ts`, `fabric/types.ts`, `service.test.ts`). None is in the covered list, so the phase-68 implementation evidence from the 504da465 audit still describes this head and is carried forward. `git status` shows no modified covered file.
- Spot-checked at this head: `worktree.py` line 25 (`WORKTREES_ROOT`) and line 147 (`disk_usage("/")`); `worktree-registry.ts` line 381 (`coalesce` on `session_id`, `graph_id`); `worktree-registry.pg.test.ts` line 79; `worktree-graph.ts` `worktreeRoots` (lines 18-31); `command.ts` line 490 (`assertDiskFloor`); `server.ts` line 2336 (`POST /worktrees/report`); `brief-sessions.ts` line 256 (`worktreesSection`).
- Postgres: scratch Postgres 16 at 127.0.0.1:5439, database `substrate_test_v68`. Production and port 5432 not touched.
- Debt-marker gate (Step 7): no `TBD`, `FIXME`, `XXX`, `TODO`, `HACK` or `PLACEHOLDER` in the non-test covered implementation files. Zero blockers.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: `SUBSTRATE_WORKTREE_ROOTS` replaces the hard-coded root in `worktree-graph.ts`; `@substrate/fleet` finds worktrees via `git worktree list --porcelain` from every repository under the roots, including linked worktrees outside them | ✓ VERIFIED (literal wording; dispatcher caveat routed to human) | `worktree-graph.ts` `worktreeRoots` (lines 18-31) reads the variable and falls back to `WORKTREE_ROOT` only when it is unset or holds no absolute entry. `inventory.ts` runs `worktree list --porcelain -z`; `collectInventory` keeps every listed non-bare entry with no root filter. The dispatcher (`worktree.py` line 25) uses a fixed `WORKTREES_ROOT` and never reads `SUBSTRATE_WORKTREE_ROOTS`. SC1's wording does not name the dispatcher, so the literal criterion holds; the ROADMAP PARTIAL label is kept pending the owner decision (human item 1). |
| 2 | SC2: `POST /worktrees/report` stores path, repo, branch, head, base, dirty, ahead, behind, last commit time, size, session and graph attribution, PR state in `worktrees` (its own migration step) | ✓ VERIFIED (in-memory contract; Postgres contract observed in truth 7) | Migration step 36 `worktrees` (`index-store.ts`, phase `expand`, no `optIn`) has every listed column. Route `server.ts` line 2336: 401 without a surface, `worktreeGate(true)` refusal, body capped at `WORKTREE_REPORT_MAX_BYTES`, audited, then `reportWorktrees`. `report.ts` builds the contract fields. `worktree-registry.test.ts` and `worktree-registry.http.test.ts` pass (run below). |
| 3 | SC3: `prune` is a dry run until `--execute`; removes only clean, pushed, idle, proven-merged worktrees; never the primary checkout or the current directory; one ledger note per removal; a test covers a branch that advanced after its merge | ✓ VERIFIED | `classify.ts`: `never` for primary, cwd, locked, live claim, dirty, unpushed (unless a merged PR head). `command.ts` `git worktree remove` with no `--force`; one `worktree.prune` note per removal. `classify.test.ts` "a branch that gained commits after its pull request merged is review, never safe" passes (run below). |
| 4 | SC4: `conflicts` lists changed files per worktree against the merge base, overlapping pairs, a `git merge-tree --write-tree` prediction per pair, and a suggested merge order | ✓ VERIFIED | `conflicts.ts`: `MIN_MERGE_TREE_VERSION = [2, 38]`, `git merge-tree --write-tree --name-only`, `suggestMergeOrder` and `forecastConflicts` present. `conflicts.test.ts` passes (run below). |
| 5 | SC5: `SUBSTRATE_WORKTREE_MIN_FREE_GB` enforced by `provision` and the dispatcher's `ensure_worktree`; doctor reports worktree disk use against it | ✓ VERIFIED (caveat: dispatcher floor reads `/` only) | `command.ts` line 490 `assertDiskFloor(target, minFreeGbFromEnv(...))`; `config.ts` reads the variable, default 5; `worktree.py` refuses before any git command via `min_free_bytes()`. `scripts/doctor-runtime.ts` `gatherWorktreeDisk` adds a row only when roots are set. Caveat: the dispatcher checks free space on `disk_usage("/")` (line 147), not on the root it creates under. Open item 2. `test_worktree.py` passes (run below). |
| 6 | With the registry on, `memory_brief` names other sessions' worktrees that touch the caller's files | ✓ VERIFIED | `brief-sessions.ts` `worktreesSection` (line 256) excludes other repositories and clean merged or closed rows. `service.ts` `liveBriefSections` returns no section unless `briefSessions` or `worktreeRegistry.mode === "on"`. `brief-worktrees.service.test.ts` passes (run below), including the registry-off case. |
| 7 | FLEET-02 invariant: a scan report that omits `session_id` or `graph_id` keeps the stored value, and one that carries it replaces that value (commit 4ac536e4, ancestor of HEAD) | ✓ VERIFIED (behavioral, scratch Postgres 16) | `worktree-registry.ts` line 381 `session_id = coalesce(excluded.session_id, worktrees.session_id), graph_id = coalesce(excluded.graph_id, worktrees.graph_id)`; `worktree-registry-fake.ts` keeps `session_id ?? previous`. Run: `worktree-registry.pg.test.ts` on `substrate_test_v68` = **13 pass, 0 fail, 42 expect() calls**, including "a report that omits session_id or graph_id keeps the stored value, and one that carries it replaces that value" (test line 79). |

**Score:** 7/7 truths verified (0 present-behavior-unverified)

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
| `worktree.py ensure_worktree` | free-space floor | `min_free_bytes()` | WIRED | `/` only |
| `worktree-graph.ts` | `SUBSTRATE_WORKTREE_ROOTS` | `worktreeRoots` | WIRED | fallback to constant when unset |
| `workspaceGuard` | any caller | `command.ts` `guard` subcommand only | NOT_WIRED to removal paths | Not a plan key link and not a ROADMAP criterion; open item 6 |

### Data-Flow Trace (Level 4)

The registry reads and writes real SQL rows (Postgres path, exercised by the truth 7 run) or the in-memory store (contract tests). No UI renders these values. The attribution path in `report.ts` reads real claims (`claims.ts`) and sessions, not literals.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| FLEET-02 attribution kept; PG contract passes (truth 7) | `SUBSTRATE_TEST_PG_URL=postgres://…@127.0.0.1:5439/substrate_test_v68 TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/worktree-registry.pg.test.ts` | 13 pass, 0 fail, 42 expects, 428 ms (scratch Postgres 16) | ✓ PASS |
| Phase 68 non-PG suites (truths 1-6 and in-memory contract) | `TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/fleet/src/ packages/cli/src/worktree/command.test.ts packages/collectors/src/worktree-graph.test.ts packages/mcp-server/src/brief-worktrees.service.test.ts packages/mcp-server/src/worktree-registry.test.ts packages/mcp-server/src/worktree-registry.http.test.ts packages/mcp-server/src/worktree-claims.test.ts` | 357 pass, 0 fail, 1085 expects, 17 files, 54.6 s. One stderr line is the expected ENOTDIR audit-failure negative case | ✓ PASS |
| Dispatcher worktree tests (truth 5 caveat, `min_free_bytes`) | `cd packages/dispatcher && PYTHONPATH=src python3 -m pytest tests/test_worktree.py -q -p no:cacheprovider` | 31 passed | ✓ PASS |
| CLI invoked directly (`substrate worktree ...`) | not run: no server or host state changed | — | ? SKIP |

Full suite not run (per assignment). Each command ran once.

### Probe Execution

No probes declared in any phase file; no `scripts/*/tests/probe-*.sh` for this phase. Step 7c: no probes to run.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| FLEET-01 | none (no PLAN files) | Worktree locations configurable; worktrees found through git | ✓ SATISFIED | SC1 truth; `inventory.ts`, `worktree-graph.ts`. Dispatcher gap open (open item 1) |
| FLEET-02 | none (no PLAN files) | Registry records path, repo, branch, head, base, dirty, ahead/behind, last activity, size, attributed session or graph | ✓ SATISFIED | SC2 truth plus invariant truth 7 (Postgres observed, 13 pass) |
| FLEET-03 | none | prune removes only clean, pushed, merged, never primary, records each removal | ✓ SATISFIED | SC3 truth; targeted runs pass |
| FLEET-04 | none | conflicts predicts textual conflicts and suggests a merge order | ✓ SATISFIED | SC4 truth; targeted runs pass |
| FLEET-05 | none | creation refuses below a free-disk floor; doctor reports disk pressure | ✓ SATISFIED (caveat: `/` only) | SC5 truth; `test_worktree.py` passes |
| FLEET-06 | none | brief names other sessions' worktrees that touch the same files | ✓ SATISFIED | SC6 truth; targeted runs pass |

Orphaned requirements: none. All six IDs are declared on the ROADMAP Phase 68 line; no PLAN file claims them.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/dispatcher/src/substrate_dispatcher/worktree.py` | 25, 147 | Fixed root and `/`-only disk floor | ⚠️ Warning | Open items 1 and 2 |
| `packages/fleet/src/workspace-guard.ts` | — | Guard has no caller in removal paths (`command.ts` guard subcommand only) | ⚠️ Warning | Open item 6 |

No debt markers (`TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER`) in covered implementation files. No stub patterns in the registry or report code read. No blocker anti-pattern.

### Human Verification Required

1. **Owner decision: SC1 closure (dispatcher root)**
   - Test: Decide whether the dispatcher must honour `SUBSTRATE_WORKTREE_ROOTS` before SC1 counts as closed, or keep the ROADMAP PARTIAL label.
   - Expected: Closing means `worktree.py` reads `SUBSTRATE_WORKTREE_ROOTS` in place of the fixed `WORKTREES_ROOT` (line 25) and checks free space on the root it creates under. Keeping it leaves criterion 1 PARTIAL.
   - Why human: The dispatcher root is an owner-held open decision. The code state is observed; the scope call is not a code fact.

### Gaps Summary

No truth FAILED. No artifact MISSING or STUB. No debt marker. The Postgres attribution invariant (truth 7) is observed on scratch Postgres 16: 13 of 13 pass.

Status is `human_needed` because the owner-held decision on the dispatcher root (SC1 PARTIAL per ROADMAP) is still open. Open items, not verifier blockers (owner or operator decisions per the binding list):

1. The dispatcher ignores `SUBSTRATE_WORKTREE_ROOTS` and creates under the fixed `/var/lib/substrate/worktrees` (`worktree.py` line 25). This is why the ROADMAP labels criterion 1 PARTIAL. Owner decision.
2. The dispatcher's disk floor reads `/` only (`worktree.py` line 147), not the root being created under.
3. No scheduler runs `substrate worktree scan --report` (carried from SUMMARY "What remains"; the registry is only as fresh as the last manual run). Operator-gated.
4. Merge-back's check-then-note race is narrowed, not closed (carried from SUMMARY).
5. A repository with no origin trusts local ancestry for "merged" and "pushed" (`inventory.ts` default-ref fallback; carried from SUMMARY).
6. The guard has no caller in removal paths: `workspaceGuard` is reached only through `substrate worktree guard` (`command.ts`).
7. Attribution is kept across silent reports by design (4ac536e4). A worktree whose session ended keeps its `session_id` until the row is swept, so the registry can name a finished session.
8. REQUIREMENTS.md still shows FLEET-01 to FLEET-06 unchecked and the ROADMAP progress row as "Shipped with PARTIAL"; not edited here.

Operator-gated, not run: installing a timer for `scan --report` or `prune`; setting `SUBSTRATE_WORKTREE_REGISTRY=on`; setting `SUBSTRATE_WORKTREE_ROOTS` on a host; `prune --execute` or `merge-back --execute` on a real checkout.

---

_Verified: 2026-11-04T23:06:59Z_
_Verifier: Claude (gsd-verifier)_
