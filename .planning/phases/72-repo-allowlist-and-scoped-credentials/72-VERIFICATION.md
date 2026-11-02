---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-02T16:07:11Z
status: human_needed
score: 16/20 must-haves verified
covered_files: [".env.example", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-PLAN.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-SUMMARY.md", "docs/worktree-fleet-api.md", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.test.ts", "packages/cli/src/worktree/scope.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/repo-executor.test.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/repo-scope.reads-writes.test.ts", "packages/mcp-server/src/repo-scope.routes.test.ts", "packages/mcp-server/src/repo-scope.test.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-registry-fake.ts", "packages/mcp-server/src/worktree-registry.ts"]
covered_digest: "v3:sha256:b21da51af545783e002cddcec7562b308ad94b8a754e218dd20831c3b4fdc095"
behavior_unverified: 3
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 16/20
  gaps_closed: []
  gaps_remaining:
    - "Corpus proof disclosure of other repositories' leaf commitments, index and treeSize: UNCERTAIN, decision 1 (open)"
    - "Credential model (surface bearer plus repository grants): decision 2 (open, owner to confirm; HARD-S2 not amended in REQUIREMENTS.md)"
    - "Allowlist unit (surface, not session): decision 3 (open, owner to confirm)"
  regressions: []
  notes: "Re-verified on integration tree gsd/v18-int-all at 7382ad10, which contains the fix commit e855734b and later commits (phase 71, 73, 74, 75, 76, 77, 78 merges, and 634b6171). Prior record was at e855734b on its own branch. Prior MCP tool name 'drift_scan' is corrected to the registered name 'coord_drift_scan'. New finding: the `substrate corpus` CLI runs git without a scope check (truth 5)."
deferred:
  - truth: "scopedGit has a production caller (PLAN D72-07)"
    addressed_in: "Phase 74"
    evidence: "NOT SUPPORTED on this tree. origin/main ROADMAP Phase 74 has 'Depends on: none' and its success criteria do not name Phase 72's registry or scoped executor. No production file imports repo-executor.ts (grep: only repo-executor.test.ts). Phase 72 criteria do not require scopedGit, so this is not a Phase 72 gap, but the deferral has no criteria basis now."
behavior_unverified_items:
  - truth: "SC1 MCP door: coord_drift_scan (mcp.ts:2003-2008) refuses an ungranted repository or path before any git call"
    test: "Call MCP tools/call coord_drift_scan with repo owner/b (or a path inside owner/b's checkout) from a surface granted only owner/a, with a spy on Bun.spawnSync and Bun.spawn."
    expected: "isError true with error repo-not-granted or path-not-registered; zero git argv calls; one repo.scope-refused warning in the ledger."
    why_human: "The service gate (service.ts:7606-7614) and the REST door (repo-scope.routes.test.ts:368) are tested. No test calls the MCP tool under scoping; drift.test.ts has no scope references."
  - truth: "SC2 Postgres worktree store: the list filter lower(repo) in (select jsonb_array_elements_text(...)) returns only granted rows"
    test: "Run the worktree-registry contract against a Postgres database with rows for owner/a and owner/b and a list call with repos=[owner/a]; then with repos=[]."
    expected: "Only owner/a rows; an empty repos list returns no rows; the filter runs in SQL."
    why_human: "worktree-registry.pg.test.ts is skipped without SUBSTRATE_TEST_PG_URL (line 18). No test in any file passes a non-null repos filter to the store. No database was started for this verification."
  - truth: "SC2 live session issue/transition: updateLiveSession refuses a repo_id outside the grant before authority.issue or transition"
    test: "Call substrate.updateLiveSession as a surface granted owner/a with repo_id owner/b, session_id unset (issue) and set to an owner/b session (transition), with a spy on authority.issue and authority.transition."
    expected: "not-found refusal; issue and transition not called; one repo.scope-refused warning."
    why_human: "The gate at service.ts:2087-2091 is code-verified. No test calls updateLiveSession under scoping: live-session-boundary.test.ts and live-session-isolation.test.ts have no scope references (run 2 passed both, unscoped)."
human_verification:
  - test: "Decision 1: does a granted corpus proof (GET /corpus/proof) disclose another repository's corpus?"
    expected: "A recorded owner decision: accept the reply as allowed, or rebuild the proof per repository, or withhold foreign siblings, index and treeSize."
    why_human: "The reply carries root (whole-corpus, corpus/root.ts:49-60), treeSize, index and the audit path. Sibling leaves are corpusLeafHex(repo, path, sha256) over other repositories (corpus/leaf.ts:65). The whole-corpus root itself is refused to scoped callers (GET /corpus/root is default-denied, route-policy.ts has no entry), so the proof door returns a value the root door withholds. Whether that counts as reading another repository's corpus is a policy reading."
  - test: "Decision 2: is the surface bearer plus its repository grant the 'credential scoped to one repository'?"
    expected: "Owner confirms the model and amends HARD-S2 (REQUIREMENTS.md:113), or requires repository-specific credential references."
    why_human: "HARD-S2 says 'Resolve least-privilege credentials by repository-specific references'. No per-repository credential type exists (config.ts; PLAN D72-03). docs/worktree-fleet-api.md:161 records the model as an open decision. STATE.md (uncommitted, Run 18) records it as the orchestrator's choice under delegated authority, open for owner confirmation."
  - test: "Decision 3: is the surface the intended allowlist unit, not the session?"
    expected: "Owner confirms that SUBSTRATE_REPO_SCOPES keys (surfaces, repo-scope.ts:27, parseRepoScopes at :149) satisfy the roadmap's 'session's allowlist'."
    why_human: "Criterion 1 says session. A live session binds one repo_id (PLAN section 1, SUMMARY section 5). The code grants per surface. STATE.md records this as the orchestrator's choice, open for owner confirmation."
  - test: "Decision 4: is the `substrate corpus` CLI inside criterion 1's 'the CLI'?"
    expected: "Owner decides. If yes, the corpus CLI git calls gain the scope gate before discovery, mirror or view. If no, the scope is recorded as the worktree CLI only."
    why_human: "PLAN D72-06 and the PLAN discovery table name only `substrate worktree` as an ungated CLI. The roadmap says 'the CLI'. See truth 5."
  - test: "Run the three behavior_unverified items: MCP coord_drift_scan refusal, Postgres worktree filter, live-session issue and transition gate"
    expected: "Each passes as written above"
    why_human: "Requires new tests and a Postgres database. Not run here (no test was added, per the brief; no database)."
---

# Phase 72: Repo allowlist and scoped credentials Verification Report

**Phase Goal:** A session can address only the repositories on its allowlist, and each repository's credential is scoped to that repository.
**Verified:** 2026-11-02T16:07:11Z
**Status:** human_needed
**Re-verification:** Yes. Re-run on the integration tree gsd/v18-int-all at 7382ad10. The earlier record (human_needed, 16/20) was written at e855734b on branch gsd/v18-p72-repo-allowlist and is replaced.

**Criteria source:** origin/main `.planning/ROADMAP.md`, Phase 72 section, verbatim:
1. A repository outside the session's allowlist is refused at the API and the CLI before any git call runs.
2. A credential scoped to one repository cannot read another repository's worktrees or corpus.

Roadmap conflict noted, not decided: this tree's working-copy ROADMAP.md (uncommitted) rewrites the Phase 72 Status line to `human_needed` and lists the three decisions. origin/main still reads "Not started". The success criteria text is identical in both, so no criterion conflict. The PLAN's own discovery and D72-05 wording also differ from the code in two small places (see Anti-Patterns).

**Decision status:** the three decisions (credential model, allowlist unit, corpus proof disclosure) are recorded in STATE.md Run 18 as the orchestrator's choices under delegated owner authority, open for owner confirmation. They are reported here as decisions, not as verified facts. The record does not show owner confirmation.

## Verdicts by criterion

| Criterion | Verdict |
| --------- | ------- |
| 1. API and CLI refuse before any git call | ✓ VERIFIED for the REST door, the service gate and `substrate worktree`. ⚠️ PRESENT_BEHAVIOR_UNVERIFIED for the MCP door (2b). ? UNCERTAIN for the `substrate corpus` CLI, which runs git with no gate (truth 5, decision 4). Allowlist unit is decision 3. |
| 2. Scoped credential cannot read another repository's worktrees or corpus | ✓ VERIFIED for worktree, corpus status, plan, ingest and root reads at the gates and in tests. ? UNCERTAIN for the corpus proof disclosure (decision 1). ⚠️ PRESENT_BEHAVIOR_UNVERIFIED for the Postgres worktree filter (8). Credential model is decision 2. |

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| 1 | SC1 service: a drift scan naming an ungranted repository, or a path in another repository, is refused before any git call | ✓ VERIFIED | `scopedDriftScan` at service.ts:7606-7614. The gate (7608, 7611) returns before `driftScan` (7610, 7613). Test `repo-scope.boundary.test.ts` passes (run 1). |
| 2a | SC1 REST: `POST /drift` calls the gate, and the refusal precedes the scan and any git call | ✓ VERIFIED | server.ts:1584-1598 calls `scopedDriftScan`. Test "POST /drift (repo-keyed door)" at repo-scope.routes.test.ts:368 passes (run 1): 403 `repo-not-granted`, scan not called, zero git spawns, refusal audited. |
| 2b | SC1 MCP: `coord_drift_scan` calls the gate before git | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Tool registered at mcp.ts:1976-2008 under the name `coord_drift_scan`, not `drift_scan` as the prior record said. Handler calls `scopedDriftScan(request, callerSurface)` at mcp.ts:2005 and returns `isError` on refusal. Only other mention is a comment at drift.test.ts:247. No test exercises it under scoping. See behavior_unverified_items. |
| 3 | SC1 API: every route or tool that no declaration names is refused to a scoped caller before its handler | ✓ VERIFIED | REST default deny at server.ts:965-970, before admission and handlers. MCP batch default deny at server.ts:2749-2757 (`toolDeclaration`), before any member runs. Declarations at route-policy.ts:21-79. Default-deny tests in repo-scope.routes.test.ts (describe at :280) pass (run 1). |
| 4 | SC1 CLI: `substrate worktree` refuses an ungranted root, `--repo`, provision target, merge-back path or guard path before any git call, exit 2 | ✓ VERIFIED | `runWorktree` calls `scopeRefusal` at command.ts:557, before the dispatch switch. `scopeRefusal` is scope.ts:95; `firstRefusal` is scope.ts:61. `roots()` (command.ts:109) and `parseWorktreeArgs` run no git. `packages/cli/src/worktree/scope.test.ts` passes 12 tests (run 1). |
| 5 | SC1 CLI, `substrate corpus` (scan, plan, sync, watch, eval, inventory, reconcile, hook): git calls run with no scope check | ? UNCERTAIN (WARNING, decision 4) | Roots come from `--root` or `SUBSTRATE_CORPUS_ROOTS` (packages/cli/src/corpus/index.ts:172-175). `discoverRepos(roots)` runs git through `defaultGitRunner` (packages/corpus/src/discover.ts:29-30, 337-346). Mirror and view runs use `defaultGitBytesRunner` (packages/corpus/src/gitio.ts:36). sync.ts:231, 335 and 355 use them. No reference to `repoScope`, `authorizeRepo` or the registry in packages/cli/src/corpus (grep). PLAN D72-06 and its discovery table scope the CLI gate to `substrate worktree` only. Criterion 1 says "the CLI" unqualified. If the corpus CLI is in scope, this truth is FAILED. |
| 6 | SC1/SC2 path containment: `..`, symlinks and registered roots are compared after realpath; overlapping registrations are refused at boot | ✓ VERIFIED | `resolveContained` (repo-scope.ts:~150-165), `locateRepoPath` (repo-scope.ts:~206-226), overlap refusal in `parseRepoRegistry` (repo-scope.ts:~138-141). Tests RS-14 and the boundary symlink and dot-dot tests pass (run 1). |
| 7 | SC2 worktrees, fake store: an unfiltered scoped list returns only granted rows; a named ungranted repository is refused before the read | ✓ VERIFIED | `listWorktrees` at service.ts:5091-5110: named refusal at 5095-5096, `grantedRepos` at 5099, `repos` passed to `store.list` at 5103. Fake filter at worktree-registry-fake.ts:56. `GET /worktrees` tests at repo-scope.routes.test.ts:388-411 pass (run 1), including the assertion `list.mock.calls[0][0]` has `repos: ["owner/a"]`. MCP `worktree_list` passes `callerSurface` at mcp.ts:2155. |
| 8 | SC2 worktrees, Postgres: the list query filters in SQL | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | SQL at worktree-registry.ts:390-397: `lower(repo) in (select jsonb_array_elements_text(...))`, with `null` passing every row and `[]` matching none. `worktree-registry.pg.test.ts` is skipped without `SUBSTRATE_TEST_PG_URL` (line 18). No test in the registry suites passes a non-null `repos` (grep over worktree-registry.testkit.ts, .test.ts, .http.test.ts). No database run. |
| 9 | SC2 corpus: plan, ingest and proof refuse an ungranted repository after parse and before any manifest or plane read | ✓ VERIFIED | `repoRefusalOf` at corpus/service.ts:154-163. Gates: plan at :177 (after parse at :176, before `store.rowsForRepos`), ingest at :207, proof at :301 (before `deps.roots.read()` at :304). `corpusProofReply` is at :295. Test "a proof for an ungranted repository is refused before the corpus manifest is read" (repo-scope.routes.test.ts:414) passes (run 1). `corpusDeps` passes `repoScope` (service.ts:6701). |
| 10 | SC2 corpus status, reconcile, root and anchor: refused to scoped callers | ✓ VERIFIED | `allReposRefusal` at corpus/service.ts:166-168, used by status (:238) and reconcile (:259). `/corpus/root` and `/corpus/anchor` have no entry in `REST_ROUTE_POLICY` (route-policy.ts:21-79), so default deny refuses them at server.ts:965-970. |
| 11 | SC2 corpus proof disclosure: a granted proof reveals no other repository's digests or corpus-wide counts | ? UNCERTAIN (WARNING, decision 1) | The reply (corpus/service.ts:306-313) carries `root`, `treeSize`, `index` and the audit path from `inclusionOf` over the whole-corpus tree (corpus/root.ts:49-60). Siblings are `corpusLeafHex(repo, path, sha256)` (corpus/leaf.ts:65), so they commit to other repositories' documents. `index` and `treeSize` reveal corpus-wide counts. No document content is disclosed. The same root is withheld by `GET /corpus/root` (truth 10). |
| 12 | SC2 ledger: a named ungranted repository is refused before the query; rows are filtered to the grant; rows without a repository are dropped | ✓ VERIFIED | `queryEventsFor` at service.ts:6621 (gate before the query), `rowsInGrant` at :6627. Tests in repo-scope.reads-writes.test.ts:90-118 pass (run 1). `POST /events/query` declared at route-policy.ts:34. |
| 13 | SC2 graphs: a graph's repository is read from its row and must be granted before content is read; no resolvable repository is refused | ✓ VERIFIED | `graphRepoOf` at service.ts:6539, `scopedGraphRefusal` at :6550-6556. Tests repo-scope.reads-writes.test.ts:47-72 pass (run 1). |
| 14 | SC2 docs: search and LightRAG query refused to every scoped surface before any retrieval or fallback | ✓ VERIFIED | `scopedDocsRefusal` at service.ts:6570-6572. Declared as GATED at route-policy.ts:35-36 and :63-64. Test repo-scope.reads-writes.test.ts:81 passes (run 1). |
| 15 | SC2 writes: `events_emit`, `graph_register`, `handoff`, `POST /events` refuse an ungranted or absent target before the write | ✓ VERIFIED | `scopedWriteRefusal` at service.ts:6579-6589. Tests at repo-scope.reads-writes.test.ts:220-232 and :258-270 pass (run 1). |
| 16 | SC2 lease reaper: an unnamed reap touches only granted repositories; a named ungranted reap reaps nothing | ✓ VERIFIED | `reapExpiredLeases` at service.ts:7341-7355. Test repo-scope.reads-writes.test.ts:236 passes (run 1). |
| 17 | SC2 live sessions, discovery: an unnamed discovery by a scoped caller is refused | ✓ VERIFIED | Gate `scopedRepoRefusal("live_session_discovery", ...)` at service.ts:2135. Test repo-scope.routes.test.ts:218-226 passes (run 1). |
| 18 | SC2 live sessions, issue and transition: an ungranted `repo_id` is refused before `authority.issue` or `transition` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Gate `authorizeRepo(this.config.repoScope, caller.surface, request.repoId)` at service.ts:2087-2091, before `authority.issue` / `authority.transition` (service.ts:2096-2097). Store defence: `transition` returns `notFound()` when `input.repoId !== current.repo_id` (planning/steering-sessions-store.ts:323). No test calls `updateLiveSession` under scoping. |
| 19 | SC2 memory search: a scoped caller receives only entries whose scope and own `repo` are both granted | ✓ VERIFIED | `memoryReplyInGrant` at service.ts:6643-6665 applies `grantedToCaller` to each entry's `repo` (6650) and filters derived hits (6662). `grantedToCaller` at memory-policy.ts:428-438. Test "a memory row whose own repository is ungranted is dropped even under a global scope" (repo-scope.reads-writes.test.ts:162) passes (run 1). Both MCP paths call it (mcp.ts:902, 908). |
| 20 | SC2 memory verify: a scoped caller gets no verdict for an entry of an ungranted repository | ✓ VERIFIED | Reader gate at service.ts:4411-4420. Reader built with the grant at 4422. `getEntry` returns null through `visibleToCaller` at 4430 before any hash, anchor or content read. `visibleToCaller` at memory-policy.ts:445-451. Tests at repo-scope.reads-writes.test.ts:172 and :187 pass (run 1). |

**Score:** 16/20 truths verified (3 present but behavior-unverified: 2b, 8, 18; 2 uncertain: 5 and 11; 0 failed).

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | `scopedGit` has a production caller (D72-07) | Phase 74 (basis no longer holds) | origin/main Phase 74 says "Depends on: none" and does not name Phase 72's registry or executor. No production file imports `repo-executor.ts`. Not a Phase 72 criterion; deferral has no criteria basis on this tree. |

### Judgements on the open points

- **Unnamed `GET /worktrees` returns granted rows with 200.** Conforms. The store is asked for `repos: ["owner/a"]` (service.ts:5099-5103) and the route test checks it (repo-scope.routes.test.ts:389-399). A named ungranted repository is refused before the store is read (service.ts:5095-5096; test at :401-411).
- **Memory fixes (19, 20)** are beyond the literal wording of criterion 2 (worktrees and corpus). Verified on their own terms.
- **Default deny** also refuses `POST /memory`, MCP `memory_write`, `/worktrees/report`, `/worktrees/claims`, `/skills/*` and `/corpus/neardup` to scoped surfaces. This is fail-closed. It is an operator consequence, not a gap.
- **Interaction with 634b6171 (lazy live-session facade).** The live-session gates depend on it only through `authority`. The facade getter is at service.ts:1654-1657. Its builder is `this.index?.liveSessions({ leaseSeconds })` at service.ts:1886, which creates the authority and reads no repository data. The repository gate at service.ts:2087 runs before any `authority` call in `updateLiveSession`, so the lazy build does not reorder the gate. The `settle()` change (3-second wall-clock wait, live-session-consumer.test-support.ts) affects test timing only. Live-session boundary and isolation tests pass on this tree (run 2: 90 pass across three files with drift.test.ts).
- **Scoping off by default.** Criterion 1 holds only when `SUBSTRATE_REPO_SCOPES` is set (repo-scope.ts:9-11). Unset means every caller may address every repository. config.ts:960-963 refuses a malformed value at boot, but nothing warns when scoping is off. PLAN D72-02 says "with a boot warning". No such warning exists (grep over non-test sources).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/repo-scope.ts` | Pure gate, parsers, refusal payload | ✓ VERIFIED | Behaviour covered by run 1. |
| `packages/mcp-server/src/repo-executor.ts` | `scopedGit` (executor entry point) | ✓ VERIFIED (unit); not wired | Unit tests pass (run 1). No production caller on this tree. |
| `packages/cli/src/worktree/scope.ts` | CLI gate before git | ✓ VERIFIED | Wired at command.ts:557; tests pass (run 1). |
| `packages/cli/src/corpus/*` | Corpus CLI git paths | ✗ NOT GATED (truth 5, decision 4) | See truth 5. |
| `packages/mcp-server/src/route-policy.ts` | Default-deny declarations | ✓ VERIFIED | Stale comment at line 51 (Info). |
| `packages/mcp-server/src/service.ts` | Gates and filters | ✓ VERIFIED | Gate sites 2087, 4411-4430, 5091-5110, 6289-6640, 6643-6665, 7341-7355, 7606-7614. |
| `packages/mcp-server/src/corpus/service.ts` | Corpus gates | ✓ VERIFIED | `repoRefusalOf` 154-163, `allReposRefusal` 166-168, proof 295-318. |
| `packages/mcp-server/src/worktree-registry.ts` | `repos` filter in SQL | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (Postgres, 8) | SQL at 390-397. |
| `packages/mcp-server/src/config.ts` | `repoScope` from env; ConfigError on malformed values | ✓ VERIFIED | `repoScopeOrRefuse` at config.ts:960-963, used at :1258. |
| `docs/config-reference.md`, `docs/worktree-fleet-api.md` | Both flags documented; credential model stated | ✓ VERIFIED | config-reference.md:27, :390. worktree-fleet-api.md:148-149 and :161 (credential model as open decision). |
| `.planning/REQUIREMENTS.md` HARD-S2 | Requirement text | ⚠️ NOT AMENDED | Line 113 still says "repository-specific references". Line 134 says "Not started". Decision 2. |

### Key Link Verification

PLAN `72-01-PLAN.md` declares no `must_haves` frontmatter, so the verifier's link checks were done by reading code.

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| server.ts `POST /drift` | `scopedDriftScan` | server.ts:1586 | ✓ WIRED | Exercised by routes test. |
| mcp.ts `coord_drift_scan` | `scopedDriftScan` | mcp.ts:2005 | ✓ WIRED | Not exercised by any test (2b). |
| server.ts `GET /worktrees` | `listWorktrees(query, surface)` | server.ts:2404 | ✓ WIRED | Exercised by routes test. |
| mcp.ts `worktree_list` | `listWorktrees(query, callerSurface)` | mcp.ts:2155 | ✓ WIRED | Code read only. |
| `runWorktree` | `scopeRefusal` | command.ts:557 | ✓ WIRED | Exercised by CLI tests. |
| `memoryReplyInGrant` | per-entry repo grant | service.ts:6650 | ✓ WIRED | Exercised by reads-writes test. |
| `memoryVerify` reader | grant callback | service.ts:4422 | ✓ WIRED | Exercised by reads-writes test. |
| `corpus` CLI git calls | scope gate | — | ✗ NOT_WIRED | Truth 5. |
| `scopedGit` | production git call sites | repo-executor.ts | ✗ NOT_WIRED (not a Phase 72 criterion) | See deferred item. |

### Data-Flow Trace (Level 4)

Not applicable. The phase adds gates and filters, not rendered output.

### Behavioral Spot-Checks

Three targeted runs, all with `TMPDIR=/root/src/worktrees/backups/gate-tmpfs`, no `SUBSTRATE_TEST_PG_URL`, run through `bwrap --bind / / --tmpfs /etc/substrate` (the host has secret files under /etc/substrate), minimal environment, from `/root/src/worktrees/as-gsd-v18-all`. `bun --no-env-file test` (bun 1.4.0). No other commands were run.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Phase 72 files, whole (run 1) | `bun --no-env-file test packages/cli/src/worktree/scope.test.ts packages/mcp-server/src/repo-scope.boundary.test.ts packages/mcp-server/src/repo-scope.test.ts packages/mcp-server/src/repo-executor.test.ts packages/mcp-server/src/repo-scope.reads-writes.test.ts packages/mcp-server/src/repo-scope.routes.test.ts` | 146 pass, 0 fail (6 files) | ✓ PASS |
| Live-session and drift tests on the lazy facade (run 2) | `bun --no-env-file test packages/mcp-server/src/live-session-boundary.test.ts packages/mcp-server/src/live-session-isolation.test.ts packages/mcp-server/src/drift.test.ts` | 90 pass, 0 fail (3 files) | ✓ PASS |
| Scope-adjacent memory, brief, service and worktree-registry tests (run 3) | `bun --no-env-file test packages/mcp-server/src/service-tandem-scope.test.ts packages/mcp-server/src/brief-recall-fanout.test.ts packages/mcp-server/src/memory-recall.test.ts packages/mcp-server/src/worktree-registry.test.ts packages/mcp-server/src/worktree-registry.http.test.ts` | 160 pass, 0 fail (5 files) | ✓ PASS |
| Postgres worktree filter (8) | not run (no database) | n/a | ? SKIP |
| Postgres live-session restart test | not run (`live-session-restart.pg.test.ts` needs a database) | n/a | ? SKIP |
| MCP `coord_drift_scan` refusal (2b), live issue and transition gate (18) | no test exists | n/a | ? SKIP |
| Corpus CLI scope (5) | no test exists; static reading only | n/a | ? SKIP |

Three bun test commands were used, the brief's maximum. The record's pass counts are on this tree at 7382ad10. They match the prior run's counts at e855734b (146 = 60 + 86 for the first six files).

Probe execution: no probes declared or found. Not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-S2 | 72-01-PLAN.md | Registered repositories addressed by identifier; canonical paths; allowed roots enforced; traversal and symlink escape rejected; least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B; argv-only git | ⚠️ PARTIAL (credential clause is decision 2) / ✓ SATISFIED (identifiers, paths, traversal, symlinks, grant isolation at the gates, argv-only git) | No per-repository credential type exists. Argv-only git confirmed: repo-executor.ts:51 `spawnSync("git", [...args])`, and the CLI and corpus git runners take argv arrays. The corpus CLI gap is in truth 5. |

No orphaned requirements: HARD-S2 is the only phase-72 mapping in REQUIREMENTS.md.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| packages/mcp-server/src/route-policy.ts | 51 | Comment: memory_search "derived hits are not yet filtered, RS-07". The code filters them (service.ts:6662). | ℹ️ Info | Stale comment, contradicts the code. |
| packages/mcp-server/src/server.ts | 2336, 2365 | `/worktrees/report` and `/worktrees/claims` default-denied to scoped surfaces | ⚠️ Warning (carried forward) | Intended; the operator consequence is not in the summary's open risks. |
| packages/cli/src/corpus/* | — | git on `SUBSTRATE_CORPUS_ROOTS` with no scope check | ⚠️ Warning (truth 5) | See truth 5. |
| docs and PLAN D72-05 | — | "Corpus root and anchor are not gated ... a decision" | ℹ️ Info | PLAN says not gated; code default-denies both to scoped callers (route-policy.ts has no entry). The code is stricter, and it is fail-closed. Not chosen silently here; the code behaviour is what is verified. |
| PLAN D72-06 | — | "every root must be a registered `worktrees` directory" | ℹ️ Info | repo-scope.ts:215-221 places a root in either `checkouts` or `worktrees` of a granted repository. Same repository, so no cross-repository reach. |
| PLAN D72-02 | — | "unset means ... with a boot warning" | ℹ️ Info | No boot warning exists. |
| .planning/REQUIREMENTS.md HARD-S2 | — | Status text still "Not started" | ℹ️ Info | Planning state not updated. |
| packages/cli/src/worktree/command.ts | ~485 | `check-ref-format` git call in `deps.cwd` before `--repo` is validated (`commandProvision`, runs after the scope gate at :557) | ℹ️ Info (carried forward) | Runs after the gate, so no refused command reaches it. Recorded for completeness. |

Debt-marker gate: no TBD, FIXME or XXX markers in the covered files that I read. Not a full scan.

### Human Verification Required

1. **Decision 1, corpus proof disclosure (truth 11).** Decide whether a granted caller receiving `root`, `treeSize`, `index` and the audit path (sibling commitments over other repositories' `(repo, path, sha256)`) counts as reading another repository's corpus. **Expected:** a recorded decision. **Why human:** a policy reading of "read".
2. **Decision 2, credential model (criterion 2, HARD-S2).** Decide whether the surface bearer plus its repository grant (D72-03) is the "credential scoped to one repository", or whether repository-specific credential references are required. **Expected:** a recorded decision, and HARD-S2 amended to match either way. **Why human:** the roadmap and HARD-S2 wording can be read either way.
3. **Decision 3, allowlist unit (criterion 1).** The roadmap says "session's allowlist". The code grants per surface. **Expected:** owner confirmation that the surface is the intended unit. **Why human:** a design decision.
4. **Decision 4, `substrate corpus` CLI (truth 5).** Decide whether "the CLI" in criterion 1 includes the corpus CLI. If yes, add the scope gate before discovery, mirror and view, and verify it. If no, record that the criterion covers the worktree CLI only. **Why human:** the PLAN scoped the gate to `substrate worktree`, and the roadmap says "the CLI".
5. **Behavioral test for 2b (MCP `coord_drift_scan`).** **Expected:** isError refusal, zero git calls, one `repo.scope-refused` warning. **Why human:** no test exists.
6. **Postgres worktree filter (8).** Run the registry contract against a database with rows for two repositories and a non-null `repos` filter. **Why human:** needs a database.
7. **Live-session issue and transition gate (18).** Add and run a test as described in behavior_unverified_items. **Why human:** no test exists.

### Gaps Summary

No truth FAILED on the evidence I checked. Status is `human_needed` because of the open decisions and the behavior-unverified items. Two truths are UNCERTAIN with human decisions requested.

- **Criterion 1** is met for the REST door, the service gate and `substrate worktree`, each refusing before any git call. The MCP door (2b) is wired but untested. The `substrate corpus` CLI runs git with no scope check (truth 5). Whether that counts is decision 4. If it does, criterion 1 is FAILED. The allowlist unit is decision 3.
- **Criterion 2** is met for worktree, corpus plan, ingest, status, reconcile and root reads at the gates and in tests, and for the ledger, graphs, docs, writes, reaper and memory reads. Three items keep it from a clean pass: the corpus proof disclosure (decision 1), the credential model (decision 2) and the Postgres filter (8). The live-session issue and transition gate (18) is code-verified but untested.
- The integration tree carries the fix commit e855734b and the later merges. The unit and route tests that were green at e855734b are still green on this tree (run 1: 146 pass; run 3: 160 pass). The live-session facade change (634b6171) does not alter the gate ordering. Live-session tests pass (run 2).

---

_Verified: 2026-11-02T16:07:11Z_
_Verifier: Claude (gsd-verifier)_
