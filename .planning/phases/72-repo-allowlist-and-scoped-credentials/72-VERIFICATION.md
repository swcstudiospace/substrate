---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-18T00:00:00Z
status: human_needed
score: 5/7 truths verified (2 present but behavior-unverified, 1 uncertain, 0 failed)
covered_files: [".env.example", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-PLAN.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-SUMMARY.md", "docs/worktree-fleet-api.md", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.test.ts", "packages/cli/src/worktree/scope.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-recall.ts", "packages/mcp-server/src/repo-executor.test.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/repo-scope.reads-writes.test.ts", "packages/mcp-server/src/repo-scope.routes.test.ts", "packages/mcp-server/src/repo-scope.test.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-registry-fake.ts", "packages/mcp-server/src/worktree-registry.testkit.ts", "packages/mcp-server/src/worktree-registry.ts"]
covered_digest: "v3:sha256:04baec3b8035dc4f05ea2102b300d38e900cd540a57bb64a8841914a48b27516"
behavior_unverified: 2
overrides_applied: 0
gaps: []
deferred:
  - truth: "scopedGit has a production caller"
    addressed_in: "Phase 74"
    evidence: "Phase 74 consumes the registry and scoped executor from this phase (ROADMAP Phase 74 status line)"
behavior_unverified_items:
  - truth: "SC1 MCP door: drift_scan refuses an ungranted repository or path before any git call"
    test: "Call MCP tools/call drift_scan with a path in owner/b from a surface granted only owner/a, with a spy on the git runner."
    expected: "isError refusal; zero git calls; one repo.scope-refused warning in the ledger."
    why_human: "The service gate and the REST POST /drift door are tested. No test in repo-scope*.test.ts or drift.test.ts names drift_scan under a scope."
  - truth: "SC2 live session: updateLiveSession refuses a repo_id outside the grant before issue or transition"
    test: "Call substrate.updateLiveSession as a surface granted owner/a with repo_id owner/b, once for issue and once for transition."
    expected: "Refusal; authority issue and transition not called; one repo.scope-refused warning."
    why_human: "No test calls updateLiveSession under scoping."
human_verification:
  - test: "Decide whether GET /corpus/proof discloses another repository's corpus"
    expected: "Recorded decision: accept the whole-corpus root, treeSize and sibling leaf commitments as allowed for a granted caller, or rebuild the proof per repository, or withhold foreign siblings."
    why_human: "The inclusion reply carries the whole-corpus root, treeSize and the audit path. Its sibling hashes commit to other repositories' (repo, path, sha256). Whether that is reading another repository's corpus is a policy call (UNCERTAIN, truth 5)."
  - test: "Confirm the owner decision of 2026-11-16 closes the credential clause and the HARD-S2 text"
    expected: "Either HARD-S2 in .planning/REQUIREMENTS.md is amended to surface-scoped grants (it still reads 'repository-specific references' and is still 'Not started'), or per-repository credential references are added."
    why_human: "The code grants per surface (SUBSTRATE_REPO_SCOPES keys are surfaces). ROADMAP Phase 72 records the owner decision that surface-scoped grants satisfy the roadmap wording. The requirement text was not updated."
  - test: "Run the two behavior_unverified_items (MCP drift_scan refusal, live-session issue/transition gate)"
    expected: "Each passes as written above."
    why_human: "Tests for these paths do not exist yet. Presence and wiring alone do not prove the refusal."
---

# Phase 72: Repo allowlist and scoped credentials Verification Report

**Phase Goal:** A session can address only the repositories on its allowlist, and each repository's credential is scoped to that repository.
**Verified:** 2026-11-18
**Status:** human_needed
**Commit under test:** `357d6b15` (branch `gsd/autonomous-rerun`). Re-verification of the 2026-11-02 record at fix commit `e855734b`. 72 commits separate them. The changes since are in `cli/src/worktree/command.ts` (+ scope gate wiring and merge-back nested-worktree skip), `service.ts`, `mcp.ts`, `server.ts`, `config.ts` and `route-policy.ts`.

Scope: code reading plus targeted tests. The live stack and Postgres were not run.

## Goal Achievement

### Observable truths

Truths are the two roadmap success criteria, split by door. Verdicts come from the code at HEAD and targeted tests at HEAD.

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1 CLI: an ungranted repository or path is refused before any git call | ✓ VERIFIED | `packages/cli/src/worktree/command.ts:581` calls `scopeRefusal(args, deps, roots)` before the dispatch `switch`. `scope.ts` `firstRefusal` checks `--repo`, roots, `provision` target and `guard` paths through `authorizeRepo` / `authorizeRepoPath` (`repo-scope.ts`). A refusal exits 2 and runs no git. Tests: `cli/src/worktree/scope.test.ts` and `command.test.ts` (101 pass, 0 fail when run alone). |
| 2 | SC1 API, `POST /drift`: an ungranted repository is refused before the scan | ✓ VERIFIED | `server.ts:1585–1601` calls `substrate.scopedDriftScan(..., surface)`. `service.ts` `scopedDriftScan` runs `authorizeRepo`, then `authorizeRepoPath` with the realpath target, and calls `driftScan` only after both pass. Tests: `repo-scope.routes.test.ts` and `repo-scope.boundary.test.ts` (in the 146-pass targeted run). |
| 3 | SC1 MCP, `drift_scan`: the same gate | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `mcp.ts` calls `scopedDriftScan` (wiring read). No test names `drift_scan` under a scope; `drift.test.ts` has no scope references. See behavior_unverified_items. |
| 4 | SC2 worktrees: a named ungranted repository is refused, and an unnamed read returns granted rows only | ✓ VERIFIED | `service.ts` `listWorktrees` (about 5160–5185): a named repository goes through `authorizeRepo` and is refused with `repoRefusal`; `grantedRepos` passes the granted list to `store.list({ repos })`; a caller with no grants reads nothing. Tests: `repo-scope.boundary.test.ts` and `repo-scope.routes.test.ts`. Postgres filter (`lower(repo) in (select jsonb_array_elements_text(...))`) has no repos case in `worktree-registry*.test.ts`. That part is PRESENT_BEHAVIOR_UNVERIFIED under the fake store only; it is noted in the Human Verification list. |
| 5 | SC2 corpus: plan, ingest, proof and anchor refuse an ungranted repository before any manifest read; status and reconcile refuse under scope | ✓ VERIFIED for refusal; ? UNCERTAIN for disclosure | `corpus/service.ts` `repoRefusalOf` (line 154) runs before reads; `allReposRefusal` (line 166) refuses `GET /corpus/status` and `POST /corpus/reconcile` when scoping is on. `corpus` tests in `repo-scope.boundary.test.ts` pass (describe at line 155). Disclosure: `GET /corpus/proof` returns the whole-corpus `root`, `treeSize` and audit-path sibling commitments, which include other repositories' leaves. That is a policy question, not a refusal failure. Human item 1. |
| 6 | SC2 live session: `updateLiveSession` refuses a repo outside the grant before issue or transition | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `service.ts` `updateLiveSession` (about line 2089) calls `authorizeRepo`. No test calls it under scoping. Human item 2. |
| 7 | Credential scope: a credential for one repository cannot read another repository's data | ✓ VERIFIED against the owner decision; ? UNCERTAIN against HARD-S2 text | Grants are per surface (`SUBSTRATE_REPO_SCOPES`, `repo-scope.ts` `parseRepoScopes`). ROADMAP Phase 72 status records the owner decision of 2026-11-16 that surface-scoped grants satisfy the roadmap wording. `REQUIREMENTS.md` HARD-S2 still says "repository-specific references" and reads "Not started". Human item 2. |

**Score:** 5/7 truths verified (truths 3 and 6 are present but behavior-unverified; truth 5's disclosure part and truth 7's requirement-text part are uncertain). 0 failed.

### Deferred items

| # | Item | Addressed in | Evidence |
|---|------|--------------|----------|
| 1 | `scopedGit` has no production caller | Phase 74 | ROADMAP Phase 74 status: the cross-repo engine ports onto "the surface-grant executor" from this phase. |

### Required artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/repo-scope.ts` | Pure gate, parsers, refusal payload | ✓ VERIFIED | `authorizeRepo`, `authorizeRepoPath`, `isGranted`, `grantedRepos`, `rowsInGrant`, `repoRefusalPayload` |
| `packages/mcp-server/src/repo-executor.ts` | `scopedGit` | ✓ VERIFIED | Gate before the runner; `GIT_CEILING_DIRECTORIES`; argv only. Tests: `repo-executor.test.ts` |
| `packages/cli/src/worktree/scope.ts` | CLI gate before git | ✓ VERIFIED | Wired at `command.ts:581` |
| `packages/mcp-server/src/service.ts` | Gates and filters | ✓ VERIFIED | `scopedDriftScan`, `listWorktrees`, `scopedRepoRefusal`, `scopedGraphRefusal`, memory reply filter |
| `packages/mcp-server/src/corpus/service.ts` | Corpus gates | ✓ VERIFIED | `repoRefusalOf`, `allReposRefusal` |
| `packages/mcp-server/src/route-policy.ts` | Default-deny declarations | ✓ VERIFIED | Declares the scoped routes |
| `packages/mcp-server/src/config.ts` | `repoScope` from env, fail on malformed | ✓ VERIFIED | `repoScopeOrRefuse` at line 960 |
| `.planning/REQUIREMENTS.md` HARD-S2 | Requirement text | ⚠️ NOT UPDATED | Human item 2 |

### Key link verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `server.ts` `POST /drift` | `service.ts` `scopedDriftScan` | line 1594 | ✓ WIRED | Routes test |
| `mcp.ts` `drift_scan` | `service.ts` `scopedDriftScan` | `mcp.ts` | ✓ WIRED | Not exercised by any test (truth 3) |
| `server.ts` `GET /worktrees` and `mcp.ts` `worktree_list` | `service.ts` `listWorktrees(query, surface)` | `server.ts`, `mcp.ts` | ✓ WIRED | Routes and boundary tests |
| `cli/worktree/command.ts` | `scopeRefusal` | line 581 | ✓ WIRED | Scope and command tests |
| `corpus/service.ts` gates | `authorizeRepo` | `repoRefusalOf` | ✓ WIRED | Boundary test |

### Requirements coverage

| Requirement | Source | Status | Evidence |
|-------------|--------|--------|----------|
| HARD-S2 | Phase 72 | ⚠️ NEEDS HUMAN | Truths 1, 2, 4, 5 cover the enforcement. The credential clause depends on the owner decision of 2026-11-16 (truth 7). The requirement text was not updated |

## Tests run (targeted, at HEAD 357d6b15)

| Command | Result |
|---------|--------|
| `bun test` on `repo-scope.test.ts`, `repo-scope.boundary.test.ts`, `repo-scope.routes.test.ts`, `repo-scope.reads-writes.test.ts`, `repo-executor.test.ts`, `cli/src/worktree/scope.test.ts` | 146 pass, 0 fail (6 files) |
| `bun test packages/cli/src/worktree/command.test.ts` (alone) | 101 pass, 0 fail |
| Same seven files run together in one process | 245 pass, 2 fail, 2 errors. Both failures and both errors are in `command.test.ts`: one test hit the 5000 ms timeout, and a `merge-back --execute` assertion (`merged-a` missing) failed under parallel load. Not reproduced alone. Treated as load sensitivity in the merge-back path, which is outside the phase's scope gates. Flagged for an owner rerun |

Not run: the full suite, Postgres (`worktree-registry.pg.test.ts`), the live stack, and the MCP `drift_scan` path (no test exists).

## Anti-patterns

No `TBD`, `FIXME` or `XXX` markers were found in the owned implementation files. The combined-run flake above is recorded, not counted as a gap.

## Human Verification Required

### 1. Corpus proof disclosure

**Test:** Decide whether `GET /corpus/proof` discloses another repository's corpus.
**Expected:** A recorded decision: accept the whole-corpus root, `treeSize` and sibling leaf commitments as allowed for a granted caller; or rebuild the proof per repository; or withhold foreign siblings.
**Why human:** Policy question. Sibling hashes commit to other repositories' `(repo, path, sha256)`.

### 2. Credential model and HARD-S2 text

**Test:** Confirm the owner decision of 2026-11-16 closes the credential clause. Amend HARD-S2 in `.planning/REQUIREMENTS.md` to surface-scoped grants, or add per-repository credential references.
**Expected:** HARD-S2 text matches the chosen model.
**Why human:** The owner decision is recorded in ROADMAP, but the requirement text was not updated.

### 3. Behavior-unverified paths

**Test:** Add and run (a) an MCP `drift_scan` refusal test with a git-runner spy, and (b) an `updateLiveSession` issue and transition refusal test under scoping. Run the Postgres worktree filter against `owner/a` and `owner/b` rows.
**Expected:** Refusals with zero git calls and zero authority writes; the Postgres filter returns only granted rows.
**Why human:** These tests do not exist yet. Presence and wiring alone do not prove the refusal.

---

_Verified: 2026-11-18_
_Verifier: Claude (gsd-verifier)_
