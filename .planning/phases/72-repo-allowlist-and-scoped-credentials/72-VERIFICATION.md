---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-16T14:07:00Z
status: passed
score: 7/7 must-haves verified
covered_files: [".env.example", ".planning/REQUIREMENTS.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-PLAN.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-SUMMARY.md", "docs/corpus-proofs.md", "docs/worktree-fleet-api.md", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.test.ts", "packages/cli/src/worktree/scope.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/proofs.routes.test.ts", "packages/mcp-server/src/corpus/proofs.test.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/live-session-issue-gate.test.ts", "packages/mcp-server/src/mcp.drift-scope.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-recall.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/repo-executor.test.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/repo-scope.pg.test.ts", "packages/mcp-server/src/repo-scope.reads-writes.test.ts", "packages/mcp-server/src/repo-scope.routes.test.ts", "packages/mcp-server/src/repo-scope.test.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-registry-fake.ts", "packages/mcp-server/src/worktree-registry.testkit.ts", "packages/mcp-server/src/worktree-registry.ts"]
covered_digest: "v3:sha256:8607e5a36f821cb752af95d4f5373d72dc6fde98b44f72e71e3cd4cfe1308312"
behavior_unverified: 0
overrides_applied: 0
decision_coverage:
  honored: null
  total: null
  not_honored: []
  note: "not evaluated — phase directory holds no CONTEXT.md"
owner_decisions_2026_11_16:
  - decision: "Roadmap session allowlist wording"
    owner_answer: "Surface-scoped grants satisfy the roadmap wording. A session-scoped allowlist is not required."
    evidence: "Owner decision for this re-verification. Not re-opened as a gap."
  - decision: "GET /corpus/root disclosure"
    owner_answer: "GET /corpus/root must be grant-scoped."
    evidence: "ec2ced00. Orchestrator ran proofs.test.ts, proofs.routes.test.ts, and repo-scope.routes.test.ts after that commit: 93 pass, 0 fail, together with live-session-issue-gate.test.ts. This verifier did not re-run those tests."
re_verification:
  previous_status: gaps_found
  previous_score: 5/7
  gaps_closed:
    - "Ungranted transition refused before the session binding is read (41752c56)"
    - "GET /corpus/root is grant-scoped (ec2ced00)"
  gaps_remaining: []
  regressions: []
behavior_unverified_items: []
observed_2026_11_16:
  - test: "bun test packages/mcp-server/src/repo-scope.pg.test.ts"
    result: "11 pass, 0 fail, against the disposable PostgreSQL named by SUBSTRATE_TEST_PG_URL. Run by the orchestrator after this report was written."
human_verification: []
advisory: []
---

# Phase 72: Repo allowlist and scoped credentials Verification Report

**Phase Goal:** A session can address only the repositories on its allowlist, and each repository's credential is scoped to that repository.
**Verified:** 2026-11-16T14:07:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | SC1 (API): a path in a repository outside the grant is refused before any git call (drift REST and MCP) | ✓ VERIFIED | `scopedDriftScan` still calls `authorizeRepo` and returns `repoRefusal` before the scan proceeds (`service.ts`). `/drift` and `coord_drift_scan` remain GATED in `route-policy.ts`. Not re-run here. |
| 2 | SC1 (CLI): `substrate worktree` refuses an ungranted repository or root before any git call | ✓ VERIFIED | `scopeRefusal` in `packages/cli/src/worktree/scope.ts` still returns before dispatch when the grant fails. Owner decision: surface-scoped grants satisfy the roadmap session-allowlist wording. |
| 3 | SC2 (worktrees): a credential for repo A cannot read repo B's worktrees, with the filter applied in SQL, not after the read | ✓ VERIFIED | `worktree-registry.ts` filters with `lower(repo) in (select jsonb_array_elements_text(...))`. Orchestrator ran `repo-scope.pg.test.ts`: 11 pass, 0 fail. |
| 4 | SC2 (corpus): a credential cannot read another repository's corpus, including the root | ✓ VERIFIED | `corpusRootReply` refuses a caller granted none, otherwise returns `grantRootOf` over granted repos only. `grantRootOf` drops entries outside the set. `/corpus/root` is GATED. Orchestrator after `ec2ced00`: 93 pass, 0 fail. This verifier did not re-run them. |
| 5 | A transition naming an ungranted repository is refused before the session binding is read | ✓ VERIFIED | `prepareReserved` calls `admitRepo` and returns not-found before authority is consulted (`planning/steering-tools.ts`). `admitLiveRepo` (`service.ts`) calls `authorizeRepo`. Commit `41752c56`. Orchestrator included `live-session-issue-gate.test.ts` in the green set. This verifier did not re-run that test. |
| 6 | HARD-S2 (grant model): a credential is scoped through the surface bearer plus its grant; repo A cannot authorize repo B | ✓ VERIFIED | REQUIREMENTS.md HARD-S2 still states the grant model. Gates still call `authorizeRepo`. Verified against the amended wording only. |
| 7 | Keyed reads and writes refuse ungranted repositories before the read or write | ✓ VERIFIED | `scopedRepoRefusal` remains the pre-touch gate. Route policy still marks the keyed doors GATED, including `/worktrees` and `/corpus/proof`. |

**Score:** 7/7 truths verified

### Deferred Items

| # | Item | Addressed In | Evidence |
| --- | --- | --- | --- |
| 1 | `scopedGit` has a production caller (PLAN D72-07) | Phase 74 | Phase 74 depends on Phase 72's registry and scoped executor. Not a phase-72 gap. |

### Advisory (New Scope, Unevidenced)

None. Debt-marker scan of `repo-scope.ts`, `corpus/service.ts`, and `service.ts` found no TBD, FIXME, or XXX.

### Decision Coverage

Decision coverage: not evaluated (the phase directory holds no CONTEXT.md). Counts are null, not zero.

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `packages/mcp-server/src/service.ts` | Repo gate before live-session binding read and before drift git | ✓ VERIFIED | `admitLiveRepo` wired into the boundary; `scopedDriftScan` still refuses first |
| `packages/mcp-server/src/planning/steering-tools.ts` | `prepareReserved` consults `admitRepo` before authority | ✓ VERIFIED | Early return when `admitRepo` is false |
| `packages/mcp-server/src/corpus/service.ts` | Grant-scoped corpus root | ✓ VERIFIED | `corpusRootReply` uses `grantRootOf` when scoping is on |
| `packages/mcp-server/src/corpus/root.ts` | Root over a repo set | ✓ VERIFIED | `grantRootOf` filters `tree.ordered` by the granted set |
| `packages/mcp-server/src/route-policy.ts` | `/corpus/root` repo-gated | ✓ VERIFIED | GATED entry names `corpusRootReply` |
| `packages/mcp-server/src/worktree-registry.ts` | SQL grant predicate on list | ✓ present | Predicate present; Postgres behavior not executed |
| `packages/cli/src/worktree/scope.ts` | CLI refusal before git | ✓ VERIFIED | `scopeRefusal` still short-circuits |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `service.ts` `admitLiveRepo` | `prepareReserved` | `admitRepo` | WIRED | Boundary calls the dependency before any authority read |
| `corpusRootReply` | `grantRootOf` | granted repo set | WIRED | Scoped reply body is the grant root |
| `route-policy.ts` `/corpus/root` | `corpusRoot` | GATED door | WIRED | Policy names the grant-filtered reply |
| `listWorktrees` | `worktrees.list` SQL | repos JSON predicate | WIRED (presence) | Filter is in the query; live Postgres not run |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| `corpusRootReply` | root, count | `deps.roots.read()` then `grantRootOf` | Yes, restricted to granted repos | ✓ FLOWING |
| `worktree-registry.list` | rows | SQL `from worktrees` with grant predicate | Yes when Postgres is used | present; runtime not re-executed |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Grant-scoped corpus root and routes | orchestrator after ec2ced00: proofs.test.ts, proofs.routes.test.ts, repo-scope.routes.test.ts | 93 pass, 0 fail (cited, not re-run) | ✓ PASS (cited) |
| Ungranted transition does not read the binding | orchestrator: live-session-issue-gate.test.ts with that green set | included (cited, not re-run) | ✓ PASS (cited) |
| Postgres worktree grant filter | bun test packages/mcp-server/src/repo-scope.pg.test.ts | not run | ? SKIP |

### Probe Execution

No phase probe declared. Step 7c skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| HARD-S2 | 72-01 | Least privilege is the surface bearer plus its grant; repo A cannot authorize repo B | ✓ SATISFIED | Amended wording still in REQUIREMENTS.md. Corpus root residual from the prior pass is closed in ec2ced00. |

No orphaned phase-72 requirement IDs beyond HARD-S2.

### Anti-Patterns Found

None new. The prior red ordering test is closed in code (`41752c56`). Not re-run by this verifier.

### Human Verification Required

### 1. Postgres worktree scope filter

**Test:** `bun test packages/mcp-server/src/repo-scope.pg.test.ts` against a disposable PostgreSQL 16.
**Expected:** All tests pass. Repo B rows are excluded by the SQL predicate, not by a post-read filter.
**Why human:** This verification did not execute the suite. Presence of the predicate is not a pass.

Closed items are not human checks. Surface-scoped grants satisfy the roadmap allowlist wording. `GET /corpus/root` is grant-scoped in `ec2ced00`.

### Gaps Summary

No failed truth remains. The prior ordering gap is closed: `admitLiveRepo` runs from `prepareReserved` before the authority read. The prior whole-corpus root disclosure is closed: `corpusRootReply` returns `grantRootOf` for a scoped caller and refuses a caller granted none. Those items are not gaps.

The Postgres worktree filter passed after this report was drafted: 11 pass, 0 fail. Status is `passed`.

---

_Verified: 2026-11-16T14:07:00Z_
_Verifier: Claude (gsd-verifier)_
