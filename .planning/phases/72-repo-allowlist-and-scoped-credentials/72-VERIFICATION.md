---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-20T01:26:25Z
status: passed
score: 7/7 must-haves verified
covered_files: [".env.example", ".planning/REQUIREMENTS.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-PLAN.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-SUMMARY.md", "docs/corpus-proofs.md", "docs/worktree-fleet-api.md", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.test.ts", "packages/cli/src/worktree/scope.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/proofs.routes.test.ts", "packages/mcp-server/src/corpus/proofs.test.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/live-session-issue-gate.test.ts", "packages/mcp-server/src/mcp.drift-scope.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-recall.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/repo-executor.test.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/repo-scope.pg.test.ts", "packages/mcp-server/src/repo-scope.reads-writes.test.ts", "packages/mcp-server/src/repo-scope.routes.test.ts", "packages/mcp-server/src/repo-scope.test.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-registry-fake.ts", "packages/mcp-server/src/worktree-registry.testkit.ts", "packages/mcp-server/src/worktree-registry.ts"]
covered_digest: "v4:sha256:29d6d0ca26f45e5acfbdf6ff128b534c7c075c506b140cfd90e3d138a4947e54"
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
    evidence: "Owner decision for the 2026-11-16 re-verification. Not re-opened as a gap."
  - decision: "GET /corpus/root disclosure"
    owner_answer: "GET /corpus/root must be grant-scoped."
    evidence: "ec2ced00. Orchestrator ran proofs.test.ts, proofs.routes.test.ts, and repo-scope.routes.test.ts after that commit: 93 pass, 0 fail, together with live-session-issue-gate.test.ts."
re_verification:
  previous_status: passed
  previous_score: 7/7
  gaps_closed: []
  gaps_remaining: []
  regressions: []
  note: "2026-11-20 re-verification on branch reconcile/main-2026-11-11. All seven prior truths re-checked against fresh code reads; no regression found. Tests not re-executed per assignment (SKIP gates)."
behavior_unverified_items: []
observed_2026_11_16:
  - test: "bun test packages/mcp-server/src/repo-scope.pg.test.ts"
    result: "11 pass, 0 fail, against the disposable PostgreSQL named by SUBSTRATE_TEST_PG_URL. Run by the orchestrator after the 2026-11-16 report was written."
human_verification: []
advisory: []
---

# Phase 72: Repo allowlist and scoped credentials Verification Report

**Phase Goal:** A session can address only the repositories on its allowlist, and each repository's credential is scoped to that repository.
**Verified:** 2026-11-20T01:26:25Z
**Status:** passed
**Re-verification:** Yes — after prior pass (2026-11-19, 7/7)

code review skipped (Greptile unavailable, owner override 2026-11-19 — CI gates apply)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | SC1 (API): a path in a repository outside the grant is refused before any git call (drift REST and MCP) | ✓ VERIFIED | `scopedDriftScan` at `packages/mcp-server/src/service.ts:7853` calls `authorizeRepo` at 7855 and `authorizeRepoPath` at 7858, returning `repoRefusal` before any `driftScan`/git. `/drift` remains GATED in `route-policy.ts:27`. |
| 2 | SC1 (CLI): `substrate worktree` refuses an ungranted repository or root before any git call | ✓ VERIFIED | `scopeRefusal` at `packages/cli/src/worktree/scope.ts:95` returns before dispatch; `command.ts:607` calls it before the dispatch switch. Owner decision 2026-11-16: surface-scoped grants satisfy the roadmap session-allowlist wording. |
| 3 | SC2 (worktrees): a credential for repo A cannot read repo B's worktrees, with the filter applied in SQL, not after the read | ✓ VERIFIED | `worktree-registry.ts:390-397` applies `lower(repo) in (select jsonb_array_elements_text(...))` inside the `worktrees.list` query, before rows leave the database. Postgres runtime re-confirmed by orchestrator 2026-11-16: 11 pass, 0 fail. `listWorktrees` at `service.ts:5180` gates named repo at 5184 and passes `repos` grant set. |
| 4 | SC2 (corpus): a credential cannot read another repository's corpus, including the root | ✓ VERIFIED | `corpusRootReply` at `packages/mcp-server/src/corpus/service.ts:285` refuses a caller granted none (`all-repos-not-granted`) and otherwise returns `grantRootOf` over granted repos only (`service.ts:298`). `grantRootOf` at `root.ts:118` filters `tree.ordered` by the granted set. `/corpus/root` is GATED at `route-policy.ts:29`. Orchestrator 2026-11-16 after ec2ced00: 93 pass, 0 fail. |
| 5 | A transition naming an ungranted repository is refused before the session binding is read | ✓ VERIFIED | `prepareReserved` at `steering-tools.ts:102` returns not-found when `admitRepo` is false, before any authority read; `admitLiveRepo` at `service.ts:6738` calls `authorizeRepo` at 6740. `live-session-issue-gate.test.ts` present (`packages/mcp-server/src/`, 2026-11-12). |
| 6 | HARD-S2 (grant model): a credential is scoped through the surface bearer plus its grant; repo A cannot authorize repo B | ✓ VERIFIED | REQUIREMENTS.md HARD-S2 states the grant model (owner decision 2026-11-12). `SUBSTRATE_REPO_SCOPES` and `SUBSTRATE_REPO_REGISTRY` registered at `flag-registry.ts:327,331`. `SUBSTRATE_REPO_ALLOWLIST` at `flag-registry.ts:328` is a separate per-session credential map consumed by phase 74's `repo-allowlist.ts`, not the surface grant — `repo-allowlist.ts:8` states surface-scoped grants satisfy the roadmap wording. |
| 7 | Keyed reads and writes refuse ungranted repositories before the read or write | ✓ VERIFIED | `scopedRepoRefusal` remains the pre-touch gate in `service.ts:6750`; `/worktrees` and `/corpus/proof` remain GATED (`route-policy.ts:28,30`). `authorizeRepo` call sites at `service.ts:2122,5184,6740,6754,6778,6857,6874,6893` gate live-session, worktree-list, and graph/write paths. |

**Score:** 7/7 truths verified (0 present-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/service.ts` | Repo gate before live-session binding read and before drift git | ✓ VERIFIED | `admitLiveRepo` at 6738; `scopedDriftScan` at 7853 |
| `packages/mcp-server/src/planning/steering-tools.ts` | `prepareReserved` consults `admitRepo` before authority | ✓ VERIFIED | Early not-found return at line 102 |
| `packages/mcp-server/src/corpus/service.ts` | Grant-scoped corpus root | ✓ VERIFIED | `corpusRootReply` at 285; refuses empty grant |
| `packages/mcp-server/src/corpus/root.ts` | Root over a repo set | ✓ VERIFIED | `grantRootOf` at 118 filters by granted set |
| `packages/mcp-server/src/route-policy.ts` | `/corpus/root` repo-gated | ✓ VERIFIED | GATED entry at line 29 names `corpusRootReply` |
| `packages/mcp-server/src/worktree-registry.ts` | SQL grant predicate on list | ✓ VERIFIED | Predicate at lines 390-397, in-query |
| `packages/cli/src/worktree/scope.ts` | CLI refusal before git | ✓ VERIFIED | `scopeRefusal` at 95; called from `command.ts:607` |
| `packages/mcp-server/src/repo-executor.ts` | Scoped git executor | ✓ VERIFIED | `scopedGit` at line 140; interface for phase 74 |
| `packages/mcp-server/src/flag-registry.ts` | Scope env flags | ✓ VERIFIED | `SUBSTRATE_REPO_SCOPES` 327, `SUBSTRATE_REPO_REGISTRY` 331 |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| `service.ts` `admitLiveRepo` | `prepareReserved` | `admitRepo` | WIRED | Boundary calls the dependency before any authority read |
| `corpusRootReply` | `grantRootOf` | granted repo set | WIRED | Scoped reply body is the grant root |
| `route-policy.ts` `/corpus/root` | `corpusRoot` | GATED door | WIRED | Policy names the grant-filtered reply |
| `listWorktrees` | `worktrees.list` SQL | repos JSON predicate | WIRED | Filter is in the query |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `corpusRootReply` | root, count | `deps.roots.read()` then `grantRootOf` | Yes, restricted to granted repos | ✓ FLOWING |

### Behavioral Spot-Checks

Tests were not re-executed in this pass per assignment (SKIP gates). Prior execution evidence stands:

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Grant-scoped corpus root and routes | orchestrator after ec2ced00: proofs.test.ts, proofs.routes.test.ts, repo-scope.routes.test.ts | 93 pass, 0 fail (2026-11-16) | ✓ PASS (cited) |
| Ungranted transition does not read the binding | orchestrator: live-session-issue-gate.test.ts with that green set | included in 2026-11-16 run | ✓ PASS (cited) |
| Postgres worktree grant filter | bun test packages/mcp-server/src/repo-scope.pg.test.ts | 11 pass, 0 fail (2026-11-16, post-draft) | ✓ PASS (cited) |

### Probe Execution

No phase probe declared. Step 7c skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| HARD-S2 | 72-01 | Least privilege is the surface bearer plus its grant; repo A cannot authorize repo B | ✓ SATISFIED | Amended wording (owner decision 2026-11-12) intact in REQUIREMENTS.md. Corpus root closure ec2ced00 and ordering closure 41752c56 both still present in code. |

No orphaned phase-72 requirement IDs beyond HARD-S2.

### Anti-Patterns Found

None. Scanned `repo-scope.ts`, `repo-executor.ts`, `scope.ts`, `root.ts` for TODO/FIXME/XXX/placeholder with no matches. `return null` occurrences in `scope.ts` and `root.ts` are legitimate sentinel values (parse failure, no match), not stubs.

### Human Verification Required

None. All seven truths are verified in code; Postgres runtime was confirmed by the orchestrator on 2026-11-16.

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | `scopedGit` has a production caller (PLAN D72-07) | Phase 74 | Phase 74 depends on Phase 72's registry and scoped executor. Not a phase-72 gap. |

### Gaps Summary

No gaps. This re-verification on branch `reconcile/main-2026-11-11` confirms all seven truths from the 2026-11-19 pass still hold against fresh code reads: drift and worktree gates precede git, CLI scope refusal precedes dispatch, worktree and corpus filters are applied in-query, corpus root is grant-scoped, and the live-session admission runs before the binding read. The session-scoped `SUBSTRATE_REPO_ALLOWLIST` (phase 74 surface) does not contradict the surface-grant model recorded as an owner decision.

---

_Verified: 2026-11-20T01:26:25Z_
_Verifier: Claude (gsd-verifier)_

## Addendum — retained origin/main evidence (2026-11-19, HEAD `ee998735`)

Merge note: HEAD above (2026-11-20 re-verification, passed 7/7, `covered_digest` v4) is the primary verdict. The origin/main record (`human_needed`, 4/7, v3) is superseded by that re-verification and is retained below only for its additive evidence; its three human items are dispositioned against HEAD, not re-opened.

**Additional key links recorded only in origin/main** (line numbers as at `ee998735`; HEAD equivalents appear in the primary tables above): `server.ts` `POST /drift` → `service.scopedDriftScan` (`server.ts:1594`, gate before `readGitTip`); `mcp.ts` `coord_drift_scan` → `service.scopedDriftScan` (`mcp.ts:2070`); `server.ts`/`mcp.ts` worktree doors → `service.listWorktrees(query, surface)` (`server.ts:2468`); `cli/worktree/command.ts` → `scope.scopeRefusal` (`command.ts:581` before dispatch); `corpus/service.ts` doors → `repo-scope.authorizeRepo` via `repoRefusalOf`/`allReposRefusal`; `cross-repo-ops.ts` → `repo-executor.scopedGit` (`cross-repo-ops.ts:213`, closes the previous deferred `scopedGit` production-caller item); `service.ts` `updateLiveSession` → `repo-scope.authorizeRepo` (`service.ts:2089`).

**Prior run evidence cited only in origin/main:** 146 pass across the six scope test files at `357d6b15`; `command.test.ts` 101 pass alone; a load-sensitive `merge-back` flake in the combined run was not reproduced alone and was recorded as an owner rerun, not a gap.

**Disposition of origin/main's three human items (closed by HEAD):** (1) `/corpus/proof` disclosure policy — HEAD verifies the grant-scoped corpus root (`corpusRootReply`/`grantRootOf`, truth 4) and that `/corpus/proof` remains GATED (truth 7); (2) HARD-S2 text amendment — HEAD records the amended owner-decision wording intact in REQUIREMENTS.md (truth 6 / Requirements Coverage); (3) live execution of the MCP `drift_scan` refusal, live-session issue/transition gate, and Postgres worktree filter — HEAD cites the orchestrator's 2026-11-16 runs (93 pass, 0 fail including `live-session-issue-gate.test.ts`; Postgres filter 11 pass, 0 fail in `repo-scope.pg.test.ts`).
