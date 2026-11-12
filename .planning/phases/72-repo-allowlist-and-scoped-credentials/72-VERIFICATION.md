---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-12T08:39:35Z
status: gaps_found
score: 5/7 truths verified
covered_files: [".env.example", "docs/worktree-fleet-api.md", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.test.ts", "packages/cli/src/worktree/scope.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/live-session-issue-gate.test.ts", "packages/mcp-server/src/mcp.drift-scope.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-recall.ts", "packages/mcp-server/src/repo-executor.test.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/repo-scope.pg.test.ts", "packages/mcp-server/src/repo-scope.reads-writes.test.ts", "packages/mcp-server/src/repo-scope.routes.test.ts", "packages/mcp-server/src/repo-scope.test.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-registry-fake.ts", "packages/mcp-server/src/worktree-registry.testkit.ts", "packages/mcp-server/src/worktree-registry.ts"]
covered_digest: "v3:sha256:02c29f12659fa4dbe18cacb167f9d0d0d958a7b7aff3cd7b39d216a532fd7783"
behavior_unverified: 1
overrides_applied: 0
desk_gate: "Desk Quality / Programming Lead review WAIVED by the user on 2026-11-12 (answers what=not_real, needs=greptile_only). Waiver does not clear the gap below."
owner_decisions_2026_11_12:
  - decision: "Corpus proof disclosure (truth 4)"
    owner_answer: "Build a per-repository proof tree so a granted proof reveals nothing about other repositories"
    evidence: "commit 9613e302 (per-repository tree); proof and root tests pass in this run (117 pass, 0 fail)"
    trade_off: "A granted caller cannot verify a served proof against the whole-corpus anchored root. Documented in docs/corpus-proofs.md."
    open_follow_up: "GET /corpus/root is not repo-scoped and still exposes whole-corpus root and count to granted callers (pre-existing)."
  - decision: "Credential model (HARD-S2)"
    owner_answer: "Grant model: surface bearer plus its repository grant (D72-03); HARD-S2 amended in REQUIREMENTS.md:113"
    evidence: "REQUIREMENTS.md:113 amended 2026-11-12. Verified against the amended wording only."
observed_results_2026_11_12:
  - item: "Postgres scope filter"
    result: "Owner-recorded PASS (repo-scope.pg.test.ts 11 pass on PostgreSQL 16.15, after fix 73c86985). Not re-run in this verification: 127.0.0.1:5432 refuses TCP."
re_verification:
  previous_status: human_needed
  previous_score: 16/20
  gaps_closed:
    - "MCP drift_scan refusal now has a test (mcp.drift-scope.test.ts, 2 pass, zero git argv calls)"
  gaps_remaining:
    - "Live-session transition ordering: the named test fails (truth 5)"
    - "Postgres worktree filter not exercised in this run (truth 3)"
  regressions: []
deferred:
  - truth: "scopedGit has a production caller (PLAN D72-07)"
    addressed_in: "Phase 74"
    evidence: "Phase 74 success criteria and dependency name Phase 72's registry and scoped executor"
gaps:
  - truth: "A transition naming an ungranted repository is refused before the session binding is read"
    status: failed
    reason: "updateLiveSession runs liveBoundary.prepare, which reads the session binding, before the repo gate in the effect. The named test fails: authority.read was called 2 times, expected 0. Issue and transition are not reached, and the caller gets not-found, so no disclosure was observed. The roadmap success criteria are not affected."
    artifacts:
      - path: "packages/mcp-server/src/live-session-issue-gate.test.ts:147"
        issue: "expect(read).not.toHaveBeenCalled() fails: received 2 calls"
      - path: "packages/mcp-server/src/service.ts:2023-2044"
        issue: "executeLiveCall calls this.liveBoundary.prepare(invocation) before any repo gate; the repo gate is in the effect at service.ts:2057"
    missing:
      - "Move the repo gate ahead of the boundary read for transitions (service.ts updateLiveSession / executeLiveCall), or record a decision to narrow the requirement to the issue path and amend 72-01-PLAN.md"
behavior_unverified_items:
  - truth: "SC2 Postgres worktree store: the list filter lower(repo) in (select jsonb_array_elements_text(...)) returns only granted rows"
    test: "Run repo-scope.pg.test.ts against a disposable PostgreSQL with rows for owner/a and owner/b, filter repos=[owner/a]"
    expected: "Only owner/a rows; an empty grant returns no rows; the filter runs in SQL"
    why_human: "Live database check; not run here (127.0.0.1:5432 refuses TCP)"
human_verification:
  - test: "Run repo-scope.pg.test.ts against a disposable PostgreSQL 16"
    expected: "All pass, including granted-filter cases"
    why_human: "Live database check; not run in this verification"
  - test: "Confirm the allowlist unit is the surface, not the session"
    expected: "Confirmation that SUBSTRATE_REPO_SCOPES keys (surfaces) satisfy the roadmap wording 'session's allowlist'"
    why_human: "Roadmap criterion 1 says session; the code grants per surface. Not recorded as accepted."
---

# Phase 72: Repo allowlist and scoped credentials Verification Report

**Phase Goal:** A session can address only the repositories on its allowlist, and each repository's credential is scoped to that repository.
**Verified:** 2026-11-12T08:39:35Z
**Status:** gaps_found
**Re-verification:** Yes. A fresh run at HEAD 33c400d1 (branch reconcile/main-2026-11-11) replaces the 2026-11-02 report (human_needed, 16/20).

Must-haves: the two ROADMAP success criteria for phase 72, the amended HARD-S2 credential clause (REQUIREMENTS.md:113), and the live-session ordering invariant pinned by the phase's named test. 72-01-PLAN.md declares no `must_haves` frontmatter.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1 (API): a path in a repository outside the grant is refused before any git call (drift REST and MCP) | ✓ VERIFIED | `scopedDriftScan` at service.ts:7577 gates before `readGitTip`; route-policy.ts:26 and :66 mark `/drift` and `coord_drift_scan` GATED. repo-scope.boundary.test.ts, repo-scope.routes.test.ts and mcp.drift-scope.test.ts pass (zero git argv calls on refusal) |
| 2 | SC1 (CLI): `substrate worktree` refuses an ungranted repository or root before any git call | ✓ VERIFIED | cli/src/worktree/scope.ts gate, run before dispatch in command.ts; cli scope.test.ts passes (provision, list, list --repo, merge-back, guard, symlink, malformed registry, audit digest) |
| 3 | SC2 (worktrees): a credential for repo A cannot read repo B's worktrees, with the filter applied in SQL, not after the read | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Fake-store path verified (repo-scope.boundary.test.ts worktree list). Postgres filter at worktree-registry.ts:397 and :415 is present, but the Postgres test was not run here. See behavior_unverified_items |
| 4 | SC2 (corpus): a credential cannot read another repository's corpus (proof, plan, ingest, status, reconcile) | ✓ VERIFIED | corpus/service.ts `repoRefusalOf` and `allReposRefusal`; corpus root.test.ts, proofs.test.ts, proofs.routes.test.ts and repo-scope.routes.test.ts: 117 pass, 0 fail. Residual: `GET /corpus/root` exposes whole-corpus root and count to granted callers (pre-existing, recorded) |
| 5 | A transition naming an ungranted repository is refused before the session binding is read | ✗ FAILED | live-session-issue-gate.test.ts:147 fails: `authority.read` called 2 times, expected 0 (re-run here). Issue and transition refusal assertions in the same file pass |
| 6 | HARD-S2 (amended 2026-11-12, grant model): a credential is scoped to one repository through the surface bearer plus its grant; repo A credentials cannot authorize repo B | ✓ VERIFIED | config.ts `repoScope`; repo-scope.ts `repoScopeFromEnv` and `authorizeRepo`; gate calls at service.ts:2057 and :7579; repo-scope.test.ts pass. Verified against the amended wording only, not the original per-repository-reference wording |
| 7 | Keyed reads and writes (ledger, memory, graph, docs, writes, lease reaper, live discovery, `/worktrees`, `/corpus/proof`) refuse ungranted repositories before the read or write | ✓ VERIFIED | Gates at service.ts:6498 (`scopedRepoRefusal`), :2105 (live discovery), and the reads-writes and routes suites. repo-scope.reads-writes.test.ts and repo-scope.routes.test.ts pass as part of the 148-test run |

**Score:** 5/7 truths verified (1 behavior-unverified, 1 failed)

### Deferred Items

| # | Item | Addressed In | Evidence |
| - | ---- | ------------ | -------- |
| 1 | `scopedGit` production caller (D72-07) | Phase 74 | Phase 74 depends on Phase 72's registry and scoped executor |

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/repo-scope.ts` | Registry, grants, pure gate, containment | ✓ VERIFIED | repo-scope.test.ts passes |
| `packages/mcp-server/src/repo-executor.ts` | `scopedGit` (Phase 74 entry point) | ✓ VERIFIED (deferred) | repo-executor.test.ts passes; no production caller until Phase 74 |
| `packages/cli/src/worktree/scope.ts` | CLI gate before git | ✓ VERIFIED | cli scope.test.ts passes |
| `packages/mcp-server/src/worktree-registry.ts` | Granted-only list in SQL | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Filter at :397 and :415; Postgres not run here |
| `packages/mcp-server/src/service.ts` | Gates and filters | ✓ VERIFIED except live transition ordering | Live transition ordering FAILED (truth 5) |
| `packages/mcp-server/src/corpus/service.ts` | Corpus gates | ✓ VERIFIED | Corpus test files pass |
| `.planning/REQUIREMENTS.md` HARD-S2 | Requirement text | ✓ VERIFIED (amended) | Amended 2026-11-12 at line 113 |

### Key Link Verification

Step 4 and Step 5 tooling is not applicable: 72-01-PLAN.md declares no `must_haves.artifacts` or `key_links`. Wiring was checked by reading the code.

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| server.ts `POST /drift` | `scopedDriftScan` | route call | ✓ WIRED | Exercised by routes test |
| mcp.ts `coord_drift_scan` | `scopedDriftScan` | tool call | ✓ WIRED | mcp.drift-scope.test.ts passes |
| CLI `worktree` command | `scopeRefusal` | before dispatch | ✓ WIRED | scope.test.ts passes |
| `updateLiveSession` | `authorizeRepo` | effect at service.ts:2057 | ✗ NOT ORDERED | Wired, but after `liveBoundary.prepare` (service.ts:2023-2044) reads the binding (truth 5) |
| `listWorktrees` | store `repos` filter | query | ⚠️ PARTIAL | Wired in code; not exercised against Postgres |

### Data-Flow Trace (Level 4)

Not applicable. The phase adds gates and filters, not rendered output.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Gates, boundary, routes, reads-writes, executor, drift MCP, CLI refusals | `bun test` on repo-scope.test.ts, repo-executor.test.ts, repo-scope.boundary.test.ts, repo-scope.routes.test.ts, repo-scope.reads-writes.test.ts, mcp.drift-scope.test.ts, cli/src/worktree/scope.test.ts | 148 pass, 0 fail (7 files) | ✓ PASS |
| Corpus root and proof gates | `bun test` on corpus/root.test.ts, corpus/proofs.test.ts, corpus/proofs.routes.test.ts, repo-scope.routes.test.ts | 117 pass, 0 fail (4 files) | ✓ PASS |
| Live-session issue and transition gate | `bun test packages/mcp-server/src/live-session-issue-gate.test.ts` | 2 pass, 1 fail: "a transition … does not read that session before it refuses" at :147 (2 reads, expected 0) | ✗ FAIL |
| Postgres scope filter | `bun test packages/mcp-server/src/repo-scope.pg.test.ts` | Not run: 127.0.0.1:5432 refuses TCP | ? SKIP (live DB) |

Probe execution: no probes declared or found. Not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-S2 | 72-01-PLAN.md | Registered repositories addressed by identifier; canonical paths; allowed roots enforced; traversal and symlink escape rejected; least-privilege credentials by the surface bearer plus its grant; repo A credentials cannot authorize repo B; argv-only git | ✗ BLOCKED on truth 5 | Paths, traversal, symlinks, argv and grant isolation at the gates are covered by passing tests. The live-session transition ordering is FAILED. Owner amended the credential clause on 2026-11-12 |

No orphaned requirements: HARD-S2 is the only phase-72 mapping in REQUIREMENTS.md.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| packages/mcp-server/src/live-session-issue-gate.test.ts | 147 | Red test left failing (committed in 22657739) | ⚠️ Warning | Known and recorded; the only red test in the scope set |
| packages/mcp-server/src/route-policy.ts | 51 | Comment says memory_search "derived hits are not yet filtered, RS-07"; the code filters them | ℹ️ Info | Stale comment (carried forward) |

Debt-marker gate: grep for TBD, FIXME and XXX found no matches in repo-scope.ts, repo-executor.ts, cli scope.ts, service.ts, corpus/service.ts, or worktree-registry.ts. Passes.

### Human Verification Required

1. **Run the Postgres scope filter.** Test: `bun test packages/mcp-server/src/repo-scope.pg.test.ts` against a disposable PostgreSQL 16. Expected: all pass. Why human: live database, not run here.
2. **Confirm the allowlist unit is the surface, not the session.** Test: review the roadmap's "session's allowlist" wording against `SUBSTRATE_REPO_SCOPES` (keyed by surface). Expected: a recorded decision. Why human: policy wording.

### Gaps Summary

One blocker: a transition naming an ungranted repository reads the session binding before it is refused (truth 5). The named test pins the required ordering and fails deterministically (2 reads, expected 0). Issue and transition are not reached, and the caller gets `not-found`, so no disclosure was observed. The roadmap success criteria themselves are met by the gates in truths 1, 2, 4 and 7. Fix: move the repo gate ahead of `liveBoundary.prepare` for transitions, or record a decision to narrow the requirement to the issue path.

The Postgres scope filter (truth 3) is unexercised in this run. The owner's 2026-11-12 result is recorded above, not re-run.

---

_Verified: 2026-11-12T08:39:35Z_
_Verifier: Claude (gsd-verifier)_
