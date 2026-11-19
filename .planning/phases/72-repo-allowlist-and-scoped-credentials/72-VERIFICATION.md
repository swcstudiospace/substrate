---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-19T00:00:00Z
status: human_needed
score: 4/7 truths verified (2 present but behavior-unverified, 1 uncertain, 0 failed)
covered_files: [".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-PLAN.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-SUMMARY.md", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/cross-repo-ops.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:49fdca8ac2eedeaafc2adf09b7fb479995b7d7797218abf46415a2cb2734626a"
behavior_unverified: 2
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/7
  gaps_closed:
    - "scopedGit has a production caller — now packages/mcp-server/src/cross-repo-ops.ts:213 (Phase 74)"
  gaps_remaining: []
  regressions: []
gaps: []
behavior_unverified_items:
  - truth: "SC1 MCP door: drift_scan refuses an ungranted repository or path before any git call"
    test: "Call MCP coord_drift_scan with a path in owner/b from a surface granted only owner/a, with a spy on the git runner."
    expected: "Refusal; zero git calls; one repo.scope-refused warning in the ledger."
    why_human: "Wired at packages/mcp-server/src/mcp.ts:2070 via substrate.scopedDriftScan, but no test in repo-scope*.test.ts or drift.test.ts names drift_scan under a scope (checked at HEAD ee998735). Presence and wiring alone do not prove the refusal."
  - truth: "SC2 live session: updateLiveSession refuses a repo_id outside the grant before issue or transition"
    test: "Call substrate.updateLiveSession as a surface granted owner/a with repo_id owner/b, once for issue and once for transition."
    expected: "Refusal; authority issue and transition not called; one repo.scope-refused warning."
    why_human: "Gate present at packages/mcp-server/src/service.ts:2089 (authorizeRepo before issue/transition), but no test calls updateLiveSession under scoping (checked at HEAD ee998735)."
human_verification:
  - test: "Decide whether GET /corpus/proof discloses another repository's corpus"
    expected: "Recorded decision: accept the whole-corpus root, treeSize and sibling leaf commitments as allowed for a granted caller, or rebuild the proof per repository, or withhold foreign siblings."
    why_human: "corpusProofReply (packages/mcp-server/src/corpus/service.ts:301) gates the named repo via repoRefusalOf, but the reply body still carries the whole-corpus root and treeSize (inclusionOf result). Whether that is reading another repository's corpus is a policy call, not decidable from code."
  - test: "Confirm the owner decision of 2026-11-16 closes the credential clause and amend HARD-S2"
    expected: "HARD-S2 in .planning/REQUIREMENTS.md amended to surface-scoped grants (it still reads 'repository-specific references' and its row still reads 'Not started'), or per-repository credential references added."
    why_human: "Code grants per surface via SUBSTRATE_REPO_SCOPES (packages/mcp-server/src/repo-scope.ts). ROADMAP Phase 72 records the owner decision that surface-scoped grants satisfy the roadmap wording, but the requirement text was not updated — operator action."
  - test: "Run the two behavior_unverified_items (MCP drift_scan refusal, live-session issue/transition gate) and the Postgres worktree filter live"
    expected: "Each passes as written above; the Postgres list filter returns only granted rows for owner/a vs owner/b."
    why_human: "Tests for the two named doors do not exist yet, and the Postgres worktree-registry list query was not run against a live database in this phase. Operator/live execution only."
---

# Phase 72: Repo allowlist and scoped credentials Verification Report

**Phase Goal:** A session can address only the repositories on its allowlist, and each repository's credential is scoped to that repository.
**Verified:** 2026-11-19
**Status:** human_needed
**Re-verification:** Yes — after Phase 74 ported the scoped executor (previous record 2026-11-18, HEAD 357d6b15; this pass at HEAD ee998735, no tests run per assignment)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1 API: `POST /drift` refuses a repository/path outside the surface grant before any git call | ✓ VERIFIED | `service.ts` `scopedDriftScan` gates via `authorizeRepoPath`; `server.ts:1594` calls it. Registry/scope unit + boundary tests cover the service and REST doors (prior run 146 pass, recorded in previous verification; not re-run here). |
| 2 | SC1 CLI: `substrate worktree` refuses an ungranted repository/path before any git call | ✓ VERIFIED | `packages/cli/src/worktree/scope.ts` `scopeRefusal` (realpath containment, grant check) wired at `command.ts:581` before dispatch; `scope.test.ts` + `command.test.ts` cover it. |
| 3 | SC1 MCP: `coord_drift_scan` refuses an ungranted repository/path before any git call | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Wired `mcp.ts:2070` → `scopedDriftScan`, but no test exercises this door under a scope. See Human Verification. |
| 4 | SC2 worktrees: a surface granted one repository cannot list another's worktrees | ✓ VERIFIED | `service.ts:5165` `listWorktrees(query, callerSurface)` refuses via `authorizeRepo` when a repo is named; `worktree-registry.ts` `repos` filter restricts the Postgres list. Routes + boundary tests cover REST and MCP doors; Postgres execution itself is an operator/live item below. |
| 5 | SC2 corpus: a surface granted one repository cannot read another's corpus | ⚠️ UNCERTAIN | `corpus/service.ts` `repoRefusalOf` gates plan/ingest/proof after parse and before any read; `allReposRefusal` refuses status/reconcile to scoped callers. But `GET /corpus/proof` returns the whole-corpus `root`/`treeSize` for a granted caller — disclosure policy undecided (operator). |
| 6 | SC2 live session: `updateLiveSession` refuses a `repo_id` outside the grant before issue/transition | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Gate at `service.ts:2089` (`authorizeRepo` → `repoRefusal`), but no test calls it under scoping. See Human Verification. |
| 7 | Credential model: the surface bearer plus its `SUBSTRATE_REPO_SCOPES` grant is the scoped credential; `scopedGit` decides before spawning and has a production caller | ✓ VERIFIED | `repo-scope.ts` grant resolution; `repo-executor.ts` `scopedGit` decides-then-spawns (zero runner calls on refusal, per its unit tests); production caller now `cross-repo-ops.ts:213` (Phase 74) — the previous deferred item is closed. HARD-S2 text amendment is operator-only (below). |

**Score:** 4/7 truths verified (2 present but behavior-unverified, 1 uncertain)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/repo-scope.ts` | Registry, grants, pure gate, containment | ✓ VERIFIED | Present, substantive (parse + authorize + realpath containment + audit digest). |
| `packages/mcp-server/src/repo-executor.ts` | `scopedGit` decide-then-spawn | ✓ VERIFIED | Present; production caller `cross-repo-ops.ts:213`. |
| `packages/cli/src/worktree/scope.ts` | CLI gate before dispatch | ✓ VERIFIED | `scopeRefusal` wired at `command.ts:581`. |
| `packages/mcp-server/src/config.ts` + `flag-registry.ts` + `.env.example` | `SUBSTRATE_REPO_REGISTRY` / `SUBSTRATE_REPO_SCOPES` parsing | ✓ VERIFIED | Present; malformed value refuses boot. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `server.ts` `POST /drift` | `service.scopedDriftScan` | direct call, `server.ts:1594` | ✓ WIRED | Gate before `readGitTip`. |
| `mcp.ts` `coord_drift_scan` | `service.scopedDriftScan` | direct call, `mcp.ts:2070` | ✓ WIRED | Not exercised by any test (truth 3). |
| `server.ts` / `mcp.ts` worktree doors | `service.listWorktrees(query, surface)` | surface passed, `server.ts:2468` | ✓ WIRED | Grant filter in query. |
| `cli/worktree/command.ts` | `scope.scopeRefusal` | `command.ts:581` before dispatch | ✓ WIRED | Exits before git. |
| `corpus/service.ts` doors | `repo-scope.authorizeRepo` | `repoRefusalOf` / `allReposRefusal` | ✓ WIRED | Before manifest reads. |
| `cross-repo-ops.ts` | `repo-executor.scopedGit` | `cross-repo-ops.ts:213` | ✓ WIRED | Closes previous deferred gap. |
| `service.ts` `updateLiveSession` | `repo-scope.authorizeRepo` | `service.ts:2089` | ✓ WIRED | Not exercised by any test (truth 6). |

### Data-Flow Trace (Level 4)

No rendered dynamic data in scope for this phase; refusals carry reason codes only (never the requested path; audit records a keyed digest via `repoRefusalPayload`). ✓

### Behavioral Spot-Checks

SKIPPED per assignment (no tests run in this pass). Prior verification recorded targeted runs at HEAD 357d6b15: 146 pass across the six scope test files; `command.test.ts` 101 pass alone. Combined seven-file run showed a load-sensitive `merge-back` flake in `command.test.ts` (not reproduced alone), recorded as an owner rerun, not a gap.

### Requirements Coverage

| Requirement | Source | Status | Evidence |
|-------------|--------|--------|----------|
| HARD-S2 | Phase 72 | ⚠️ NEEDS HUMAN | Enforcement truths 1, 2, 4, 7 verified in code. Credential clause rests on the 2026-11-16 owner decision recorded in ROADMAP; REQUIREMENTS.md still reads "Not started" / "repository-specific references" — operator amendment. |

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO` markers in the owned implementation files at HEAD ee998735.

### Human Verification Required

Listed in frontmatter `human_verification` (3 items): (1) corpus-proof disclosure policy, (2) HARD-S2 text amendment confirming the owner decision, (3) live execution of the two behavior-unverified doors plus the Postgres worktree filter.

No code gaps: every API/CLI/MCP/corpus/live-session door names a concrete gate and call site above, and `scopedGit` now has its Phase 74 production caller.

---

_Verified: 2026-11-19_
_Verifier: Claude (gsd-verifier)_
