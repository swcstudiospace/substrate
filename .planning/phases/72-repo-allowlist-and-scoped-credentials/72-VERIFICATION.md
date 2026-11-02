---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-02T18:28:07Z
status: gaps_found
score: 16/21 truths verified (3 present but behavior-unverified, 2 uncertain, 0 failed on evidence); success criteria 0/2 fully verified; HARD-S2 unmet as written
covered_files: [".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-PLAN.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-SUMMARY.md", "docs/worktree-fleet-api.md", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/reflect.ts", "packages/cli/src/corpus/sync.ts", "packages/cli/src/index.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.ts", "packages/collectors/src/install-git-hook.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/gitio.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-registry.ts"]
covered_digest: "v3:sha256:5f700eeea6203e8c4807e9a36758ebf333836f9a3ccfbba6ac3e117f96ad9c7a"
behavior_unverified: 3
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: "16/21 (prior record at integration tree 749e97e3, verified 2026-11-02T17:55:20Z)"
  gaps_closed: []
  gaps_remaining:
    - "HARD-S2 credential clause (repository-specific references; repo A credentials cannot authorize repo B): UNMET AS WRITTEN. Owner decision 2."
    - "substrate corpus CLI runs git with no scope gate (truth 5), and now also writes git hooks into a named repository (truth 5, new evidence). Possible criterion 1 failure. Owner decision 4."
    - "Corpus proof disclosure (truth 11). Owner decision 1."
    - "Allowlist unit, surface versus session (criterion 1). Owner decision 3."
    - "Behavior-unverified: MCP coord_drift_scan (2b), Postgres worktree filter (8), live-session issue and transition gate (18)."
  regressions: []
  notes: "Re-verified on integration tree gsd/v18-int-all at HEAD c7788f9d. Scope code is unchanged since 749e97e3: `git diff 749e97e3 HEAD` over packages/mcp-server/src, packages/cli/src/worktree, packages/cli/src/corpus, packages/corpus/src, docs/worktree-fleet-api.md and this phase directory changes only the phase 76 event-buffer hunks in service.ts and event-buffer/dead-letter files. Line references below are re-read on c7788f9d. The prior deferral of scopedGit to Phase 74 is still withdrawn, with a correction to its stated basis (see Deferred Items). Prior decisions are re-reported as open, not decided here."
behavior_unverified_items:
  - truth: "SC1 MCP door: coord_drift_scan refuses an ungranted repository or path before any git call"
    test: "Call MCP tools/call coord_drift_scan with repo owner/b (or a path inside owner/b's checkout) from a surface granted only owner/a, with a spy on Bun.spawnSync and Bun.spawn."
    expected: "isError true with error repo-not-granted or path-not-registered; zero git argv calls; one repo.scope-refused warning in the ledger."
    why_human: "The gate is code-verified (mcp.ts:2004-2006 calls scopedDriftScan before any git). drift.test.ts has no scoped test. The REST door and service gate are tested; no test runs the MCP tool under scoping."
  - truth: "SC2 Postgres worktree store: the list filter lower(repo) in (select jsonb_array_elements_text(...)) returns only granted rows"
    test: "Run the worktree-registry contract against a Postgres database with rows for owner/a and owner/b and a list call with repos=[owner/a]; then with repos=[]."
    expected: "Only owner/a rows; an empty repos list returns no rows; the filter runs in SQL."
    why_human: "worktree-registry.pg.test.ts is skipped without SUBSTRATE_TEST_PG_URL. No test in the registry suites passes a non-null repos filter to the store. No database was started in this verification."
  - truth: "SC2 live session issue or transition: updateLiveSession refuses a repo_id outside the grant before authority.issue or transition"
    test: "Call substrate.updateLiveSession as a surface granted owner/a with repo_id owner/b, session_id unset (issue) and set to an owner/b session (transition), with a spy on authority.issue and authority.transition."
    expected: "not-found refusal; issue and transition not called; one repo.scope-refused warning."
    why_human: "The gate at service.ts:2097-2101 precedes authority.issue and authority.transition (2103) and is code-verified. No test calls updateLiveSession with repoScope set."
---

# Phase 72: Repo allowlist and scoped credentials Verification Report

**Phase Goal:** A session can address only the repositories on its allowlist, and each repository's credential is scoped to that repository.
**Verified:** 2026-11-02T18:28:07Z
**Status:** gaps_found
**Re-verification:** Yes. Integration tree gsd/v18-int-all at HEAD c7788f9d. The prior record (gaps_found, 749e97e3) is replaced.

**Criteria source:** origin/main `.planning/ROADMAP.md`, Phase 72 section. The two success-criteria texts are identical to this tree's ROADMAP. The Status and Plans lines differ and are reported, not chosen between:
- origin/main: `**Status**: Not started. Discovery: ...`; `**Plans**: none written`.
- this tree (committed): `**Status**: human_needed (verified on gsd/v18-int-all 7382ad10; live items open)`; `**Plans**: 72-01 ... Manual fallback for the plan step, owner-approved (STATE Run 18)`.
- The progress table at this tree's ROADMAP.md:154 reads "16 of 20 must-haves verified"; this report counts 21 truth rows. The table count is stale.

Criteria (verbatim):
1. A repository outside the session's allowlist is refused at the API and the CLI before any git call runs.
2. A credential scoped to one repository cannot read another repository's worktrees or corpus.

**Requirement source:** `.planning/REQUIREMENTS.md:113` (HARD-S2), owner-approved text from commit 23bd0733, confirmed present at that commit. Binding. Verdict: UNMET AS WRITTEN on the credential clause.

**Decision status:** Four decisions are open and owner-held: (1) corpus proof disclosure, (2) credential model, (3) allowlist unit, (4) whether `substrate corpus` is inside criterion 1's "the CLI". STATE.md Run 18 records the first three as orchestrator choices under delegated authority. This report does not decide any of them, and it does not treat those records as owner decisions.

## Verdicts by criterion

| Criterion | Verdict |
| --------- | ------- |
| 1. API and CLI refuse before any git call | ⚠️ PARTIAL. VERIFIED at the REST drift door, the service gate, the MCP batch and route default deny, the `substrate worktree` CLI, and the corpus routes. PRESENT_BEHAVIOR_UNVERIFIED at the MCP `coord_drift_scan` door (2b) and the live-session issue/transition gate (18). For `substrate corpus` the absence of any scope check is VERIFIED as fact (truth 5); whether that CLI is inside "the CLI" is open decision 4. If it is, criterion 1 FAILS. Allowlist unit is decision 3. |
| 2. Scoped credential cannot read another repository's worktrees or corpus | ⚠️ PARTIAL. VERIFIED for worktree lists, corpus plan, ingest, status, reconcile and root reads, ledger, graphs, docs, writes, reaper and memory. UNCERTAIN for the corpus proof disclosure (decision 1). PRESENT_BEHAVIOR_UNVERIFIED for the Postgres worktree filter (8). The credential model is UNMET AS WRITTEN against HARD-S2 (decision 2). |

**HARD-S2 (REQUIREMENTS.md:113): UNMET AS WRITTEN.** The credential clause requires "least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B". The code has no repository-specific credential reference. Searches over `packages/mcp-server/src`, `packages/cli/src` and `packages/fleet/src` (non-test) for credential, per-repo and repo-specific terms find only comments about secrets in logs. The credential is a surface bearer token: `tokenConfig` (config.ts:981-1006) maps each token to a surface, and `tokens` is typed `Map<string, Surface>` (config.ts:398-399). Authority is a per-surface grant set: `isGranted` (repo-scope.ts:229-232) and `grantedRepos` (repo-scope.ts:235-240). `docs/worktree-fleet-api.md:161` states: "The scoped credential is the surface bearer plus its grant. No per-repository secret exists; that is a recorded open decision." Grant isolation between repositories holds at the gates (repo-scope.ts:242-261). That is not the repository-specific reference the text names. Clause by clause:
- Registered repositories addressed by identifier, not raw paths: PARTIAL. The REST `/drift` body accepts a `path` that must lie inside a registration (service.ts:7647-7649), and the CLI `--repo` accepts a directory that must lie inside a registration (scope.ts:80-81).
- Canonical paths, component-wise roots, traversal and symlink rejection, including after registration: MET (repo-scope.ts:98-100 `contains` with separator; 188-203 `resolveContained` realpath per request; 214-226 `locateRepoPath`; 136-142 overlap refusal at parse).
- Least-privilege credentials by repository-specific references: NOT MET (see above).
- Repo A credentials cannot authorize repo B: grant isolation holds at the gates (repo-scope.ts:242-261). The credential is one surface token that may hold several grants (D72-03 permits "a surface granted exactly one repository" as the scoped form), so this clause is not met as written. Decision 2.
- Argv-only git: MET for the gated paths (repo-executor.ts:51 `spawnSync("git", [...args])`; corpus discover.ts:30 and gitio.ts:36 are argv arrays). The ungated corpus CLI and the hook installer also use argv arrays; the gap there is scope, not argv.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| 1 | SC1 service: a drift scan naming an ungranted repository, or a path in another repository, is refused before any git call | ✓ VERIFIED | `scopedDriftScan` signature service.ts:7642. Repo gate `authorizeRepo` 7644, return 7645. Path gate `authorizeRepoPath` 7647, return 7648, before the scan at 7649. Tests "POST /drift (repo-keyed door)" (repo-scope.routes.test.ts) and repo-scope.boundary.test.ts pass (run 1). |
| 2a | SC1 REST: `POST /drift` runs the gate before the scan | ✓ VERIFIED | server.ts:1585 audits (no git); 1586 calls `scopedDriftScan(..., surface)`; 1594-1596 return the refusal. Route test passes (run 1). |
| 2b | SC1 MCP: `coord_drift_scan` calls the gate before git | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Registered as `coord_drift_scan` at mcp.ts:1977-1978. Handler calls `scopedDriftScan(request, callerSurface)` at mcp.ts:2005 and returns `isError` on refusal (2006). Route policy declares it GATED (route-policy.ts:66). No scoped test. See behavior_unverified_items. |
| 3 | SC1 API: every REST route or MCP tool no declaration names is refused to a scoped caller before its handler | ✓ VERIFIED | REST default deny server.ts:965-970 (`restDeclaration(url.pathname) === undefined` under enforcement), before the handler dispatch. MCP batch default deny server.ts:2748-2757, before any member runs. Declarations route-policy.ts:21-79. Describe "default deny" in repo-scope.routes.test.ts passes (run 1). |
| 4 | SC1 CLI: `substrate worktree` refuses an ungranted root, `--repo`, provision target, merge-back or guard path before any git call, exit 2 | ✓ VERIFIED | `runWorktree` parses, then calls `scopeRefusal` at command.ts:557 and returns `usageError` at 558, before the dispatch switch at 559. `scopeRefusal` scope.ts:95-108; `firstRefusal` scope.ts:61-89. `roots()` command.ts:109-112 runs no git. `packages/cli/src/worktree/scope.test.ts` passes (run 1). |
| 5 | SC1 CLI: `substrate corpus` (and the corpus-side CLI commands) run git with no scope check | ? UNCERTAIN (WARNING; possible FAILURE; decision 4). The fact is VERIFIED: no scope symbol exists in `packages/cli/src/corpus` or `packages/corpus/src` outside tests. Git calls found: (a) roots from `--root` or `SUBSTRATE_CORPUS_ROOTS` (cli/src/corpus/index.ts:172-175); discovery `discoverRepos` runs `git` in each found directory through `defaultGitRunner` (corpus/src/discover.ts:29-30, 252, 268, 337-338), called from sync.ts:231 and reflect.ts:122; (b) mirror and view git calls via `defaultGitBytesRunner` (corpus/src/gitio.ts:35-36), wired at index.ts:350 for watch, sync and reconcile; (c) NEW: `substrate corpus hook install|uninstall|status --repo DIR` (index.ts:322-328, watch-commands.ts:219-224) calls `installCorpusHooks`/`uninstallCorpusHooks` in packages/collectors/src/install-git-hook.ts, which runs `git -C DIR rev-parse --git-path hooks` (install-git-hook.ts:48) and writes hook files into that repository's hooks directory (install-git-hook.ts:170-190). Neither the hook install nor the discovery consults a grant. The server ingest gate (corpus/service.ts:207) runs after these local reads. Under the phase text "refuses before git", these are not refused before git. PLAN D72-06 scopes the CLI gate to `substrate worktree` only; the plan's threat model does not mention `substrate corpus`. |
| 6 | SC1/SC2 path containment: `..`, symlinks and registered roots compared after realpath; overlapping registrations refused at boot | ✓ VERIFIED | repo-scope.ts:188-203 `resolveContained`; 214-226 `locateRepoPath`; 98-100 `contains`; 136-142 overlap refusal in `parseRepoRegistry`. Tests RS-14 and boundary symlink and dot-dot tests pass (run 1). |
| 7 | SC2 worktrees, fake store: an unfiltered scoped list returns only granted rows; a named ungranted repository is refused before the read | ✓ VERIFIED | `listWorktrees` service.ts:5127: access check 5128-5129; named gate 5130-5133 (`authorizeRepo`, refusal via `repoRefusal`); `grantedRepos` and `store.list` with `repos` follow (after 5134). Fake filter worktree-registry-fake.ts:56. Route tests pass (run 1), including `list.mock.calls[0][0]` carrying `repos: ["owner/a"]`. `worktree_list` passes the caller surface (mcp.ts:2155, prior record). |
| 8 | SC2 worktrees, Postgres: the list query filters in SQL | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | worktree-registry.ts:390-397: `(${reposJson}::text is null or lower(repo) in (select jsonb_array_elements_text(${reposJson}::jsonb)))`. `null` passes every row, `[]` matches none. `worktree-registry.pg.test.ts` is skipped without `SUBSTRATE_TEST_PG_URL`. No registry test passes a non-null `repos` to the store. The orchestrator's `/root/src/worktrees/backups/pg-targeted.log` (44 pass) names no file and is labelled for phase 77; it is not cited here. |
| 9 | SC2 corpus: plan, ingest and proof refuse an ungranted repository after parse and before any manifest or plane read | ✓ VERIFIED | `repoRefusalOf` corpus/service.ts:154-163 (grant check per repository; audit with the reason only). Plan: parse, then `repoRefusalOf` on `planRepos` before `store.rowsForRepos`. Ingest: `repoRefusalOf` on document and tombstone repositories before the store is written. Proof: `repoRefusalOf(deps, surface, [repo])` before `deps.roots.read()`. Test "a proof for an ungranted repository is refused before the corpus manifest is read" passes (run 1). |
| 10 | SC2 corpus status, reconcile, root and anchor: refused to scoped callers | ✓ VERIFIED (status and reconcile via `allReposRefusal`; root and anchor via route default deny) | `allReposRefusal` corpus/service.ts:166-168 is used by status and reconcile. `/corpus/root` (server.ts:1845) and `/corpus/anchor` (server.ts:1865) have no REST_ROUTE_POLICY entry (route-policy.ts:21-79; grep finds none), so the default deny at server.ts:965-970 refuses them under enforcement. `corpusRootReply` (service.ts:281-292) and `corpusAnchorReply` (~320) carry no repository gate of their own. |
| 11 | SC2 corpus proof disclosure: a granted proof reveals no other repository's digests or corpus-wide counts | ? UNCERTAIN (WARNING; decision 1) | Reply at corpus/service.ts:309-313 carries `root`, `treeSize`, `index`, `leaf`, `sha256` and the audit `path`. `inclusionOf` (mcp-server/src/corpus/root.ts:84-93) builds the proof over the whole-corpus tree from `buildCorpusTree` (root.ts:48-61), which includes every repository's rows. The sibling hashes on the audit path and `root` commit to other repositories' `(repo, path, sha256)` through `corpusLeafHex` (packages/corpus/src/leaf.ts:65-69). `index` and `treeSize` expose corpus-wide position and count. No document content is disclosed. Whether this is "reading another repository's corpus" is a policy reading. |
| 12 | SC2 ledger: a named ungranted repository is refused before the query; rows are filtered to the grant | ✓ VERIFIED | `queryEventsFor` service.ts:6657-6663: scope read, named gate, then the query; `rowsInGrant` (6663) filters the rows that remain. Tests repo-scope.reads-writes.test.ts pass (run 1). |
| 13 | SC2 graphs: a graph's repository is read from its row and must be granted before content is read; no resolvable repository is refused | ✓ VERIFIED | `graphRepoOf` service.ts:6575-6582 reads the graph's row; `scopedGraphRefusal` service.ts:6586-6592 refuses before content is read, `graph-repo-unresolved` when the repository cannot be resolved under scope. Tests repo-scope.reads-writes.test.ts pass (run 1). |
| 14 | SC2 docs: search and LightRAG query refused to every scoped surface before any retrieval or fallback | ✓ VERIFIED | `scopedDocsRefusal` service.ts:6606 (refused to every scoped surface while enforced). Declared GATED at route-policy.ts:35-36 and :63-64. Test repo-scope.reads-writes.test.ts passes (run 1). |
| 15 | SC2 writes: `events_emit`, `graph_register`, `handoff`, `POST /events` refuse an ungranted or absent target before the write | ✓ VERIFIED | `scopedWriteRefusal` service.ts:6615. Tests repo-scope.reads-writes.test.ts pass (run 1). |
| 16 | SC2 lease reaper: an unnamed reap touches only granted repositories; a named ungranted reap reaps nothing | ✓ VERIFIED | `reapExpiredLeases` service.ts:7377; named gate 7384-7389 (a named ungranted repository reaps nothing and is audited); an unnamed reap under scope uses `grantedRepos`. Test repo-scope.reads-writes.test.ts passes (run 1). |
| 17 | SC2 live sessions, discovery: an unnamed discovery by a scoped caller is refused | ✓ VERIFIED | Gate `scopedRepoRefusal("live_session_discovery", ...)` at service.ts:2145, before `listVisible`. Test repo-scope.routes.test.ts passes (run 1). |
| 18 | SC2 live sessions, issue and transition: an ungranted `repo_id` is refused before `authority.issue` or `transition` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Gate `authorizeRepo(this.config.repoScope, caller.surface, request.repoId)` at service.ts:2097-2101, before `authority.issue`/`transition` (2103). Store defence: `transition` returns not-found when `input.repoId !== current.repo_id` (planning/steering-sessions-store.ts:323, prior record). No test calls `updateLiveSession` with scoping set. |
| 19 | SC2 memory search: a scoped caller receives only entries whose scope and own `repo` are both granted | ✓ VERIFIED | `memoryReplyInGrant` service.ts:6679-6700: row `repo` grant, `repo:` scope via `authorizeRepo`, `graph:` scope via `graphGranted`; derived hits filtered at 6698 by `grantedToCaller`. Test repo-scope.reads-writes.test.ts passes (run 1). The comment at route-policy.ts:51 ("derived hits are not yet filtered, RS-07") is stale; the code filters them. |
| 20 | SC2 memory verify: a scoped caller gets no verdict for an entry of an ungranted repository | ✓ VERIFIED | Gate `authorizeRepo` on the caller's repo at service.ts:4448-4455; reader grant built with `memoryGrant` (4457-4458); `getEntry` reads as absent to the reader before any hash, anchor or content read. Tests repo-scope.reads-writes.test.ts pass (run 1). |

**Score:** 16/21 truth rows verified. Three are present but behavior-unverified (2b, 8, 18). Two are uncertain (5, 11). None failed on the evidence checked as a per-truth FAILED. Truth 5's absence of a gate is a fact; its consequence for criterion 1 is decision 4.

Status is `gaps_found` for a requirement-level reason, not a truth-level FAILED: HARD-S2's credential clause is binding and unmet as written (requirement gap, decision 2). Truth 5 is a possible criterion-1 failure pending decision 4.

### Deferred Items

None. The prior deferral of `scopedGit` to "Phase 74" is withdrawn, with a corrected basis:
- origin/main Phase 74 (Status: "Not applicable"; criteria: owner decision on a cross-repo write path, and the install-git-hook robustness gap) does not name Phase 72, the registry or `scopedGit`.
- This tree's Phase 74 (ROADMAP.md, Phase 74 goal and criteria) does not name them either.
- The prior record said the only basis was a code comment. That was incomplete. This phase's own plan states it: `72-01-PLAN.md:50` (D72-07, "Phase 74 calls `scopedGit`; it does not re-implement checks"), and `72-01-SUMMARY.md` §1 and §5 say the same. The code comment at repo-executor.ts:13 repeats it. Phase 74's verification artifact (`74-VERIFICATION.md:34, 130, 163`) carries it forward as a missing item.
- So the claim has no basis in phase 74's build wording. Its only source is this phase's own unmet intention. It is not a Phase 72 criterion. It is recorded as an unwired plan commitment (see Key Link) and is not counted as a gap.

Step 9b (later phases): no later phase's goal or criteria address the HARD-S2 credential clause or the `substrate corpus` CLI scope. Phase 74's goal mentions "per-repository step state", which is not a credential reference. Nothing is deferred.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/repo-scope.ts` | Pure gate, parsers, refusal payload | ✓ VERIFIED | Gates 229-261; parsers 116-181; containment 188-226. |
| `packages/mcp-server/src/repo-executor.ts` | `scopedGit` executor | ✓ VERIFIED (unit); NOT WIRED | Argv spawn at line 51. No production caller (grep over packages and scripts: only repo-executor.test.ts). |
| `packages/cli/src/worktree/scope.ts` | CLI gate before git | ✓ VERIFIED | Dispatch call at command.ts:557. Local surface `claude-code` (scope.ts:34). |
| `packages/cli/src/corpus/*`, `packages/corpus/src/{discover,gitio}.ts`, `packages/collectors/src/install-git-hook.ts` | Corpus CLI git paths gated | ✗ NOT GATED (truth 5, decision 4) | No scope reference. See truth 5. |
| `packages/mcp-server/src/route-policy.ts` | Default-deny declarations | ✓ VERIFIED | Corpus entries 28-32; drift 26; `coord_drift_scan` 66; worktrees 27. Stale comment at line 51. |
| `packages/mcp-server/src/service.ts` | Gates and filters | ✓ VERIFIED | Sites: 2097, 2145, 4448-4458, 5127-5133, 6563-6617, 6657-6698, 7377-7389, 7642-7649. |
| `packages/mcp-server/src/corpus/service.ts` | Corpus gates | ✓ VERIFIED | 154-168; plan, ingest, proof gates; status and reconcile via `allReposRefusal`. Proof reply 309-313 (decision 1). |
| `packages/mcp-server/src/worktree-registry.ts` | `repos` filter in SQL | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | SQL 390-397; no database run (truth 8). |
| `packages/mcp-server/src/config.ts` | `repoScope` from env; boot refusal on malformed values | ✓ VERIFIED | `repoScopeOrRefuse` 961-965; `tokenConfig` 981-1006. Scoping off unless `SUBSTRATE_REPO_SCOPES` is set (see Warnings). |
| `docs/config-reference.md`, `docs/worktree-fleet-api.md` | Both flags documented; credential model stated | ✓ VERIFIED | worktree-fleet-api.md:148-161 (credential at :161, "open decision"). |
| `.planning/REQUIREMENTS.md` HARD-S2 | Requirement text | ✗ UNMET AS WRITTEN (credential clause) | Line 113 unchanged; status "Not started" at line 134. Decision 2. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| server.ts `POST /drift` | `scopedDriftScan` | server.ts:1586 | ✓ WIRED | Exercised by routes test. |
| mcp.ts `coord_drift_scan` | `scopedDriftScan` | mcp.ts:2005 | ✓ WIRED | Not exercised under scope (2b). |
| server.ts `GET /worktrees` | `listWorktrees(query, surface)` | server.ts (prior: ~2404) | ✓ WIRED | Exercised by routes test. |
| mcp.ts `worktree_list` | `listWorktrees(query, callerSurface)` | mcp.ts:2155 (prior record) | ✓ WIRED | Code read; not separately exercised. |
| `runWorktree` | `scopeRefusal` | command.ts:557 | ✓ WIRED | Exercised by CLI tests. |
| `memoryReplyInGrant` | per-entry repo grant | service.ts:6679-6698 | ✓ WIRED | Exercised by reads-writes test. |
| `memoryVerify` reader | grant callback | service.ts:4457 | ✓ WIRED | Exercised by reads-writes test. |
| `updateLiveSession` | `authorizeRepo` before issue or transition | service.ts:2097 | ✓ WIRED (code) | Not exercised under scope (18). |
| `corpus` CLI git calls (sync, watch, reconcile, reflect, hook) | scope gate | none | ✗ NOT_WIRED | Truth 5, decision 4. |
| `scopedGit` | production git call sites | repo-executor.ts | ✗ NOT_WIRED | No production caller. Not a stated Phase 72 criterion; the deferral's basis is this phase's own D72-07. |

### Data-Flow Trace (Level 4)

Not applicable. The phase adds gates and filters, not rendered output.

### Behavioral Spot-Checks

Three targeted `bun test` commands, from `/root/src/worktrees/as-gsd-v18-all`, `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`. No test was added or edited. No database was started.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Phase 72 gate and boundary tests (run 1) | `bun --no-env-file test packages/cli/src/worktree/scope.test.ts packages/mcp-server/src/repo-scope.boundary.test.ts packages/mcp-server/src/repo-scope.test.ts packages/mcp-server/src/repo-executor.test.ts packages/mcp-server/src/repo-scope.reads-writes.test.ts packages/mcp-server/src/repo-scope.routes.test.ts` | 146 pass, 0 fail, 389 expect() calls, 6 files | ✓ PASS |
| Live-session and drift, unscoped (run 2) | `bun --no-env-file test packages/mcp-server/src/live-session-boundary.test.ts packages/mcp-server/src/live-session-isolation.test.ts packages/mcp-server/src/drift.test.ts` | 90 pass, 0 fail, 854 expect() calls, 3 files | ✓ PASS |
| Scope-adjacent memory, brief, service and worktree-registry tests (run 3) | `bun --no-env-file test packages/mcp-server/src/service-tandem-scope.test.ts packages/mcp-server/src/brief-recall-fanout.test.ts packages/mcp-server/src/memory-recall.test.ts packages/mcp-server/src/worktree-registry.test.ts packages/mcp-server/src/worktree-registry.http.test.ts` | 160 pass, 0 fail, 468 expect() calls, 5 files | ✓ PASS |
| Postgres worktree filter (8) | not run (`worktree-registry.pg.test.ts` skipped without `SUBSTRATE_TEST_PG_URL`) | n/a | ? SKIP |
| Postgres live-session restart | not run (needs a database) | n/a | ? SKIP |
| MCP `coord_drift_scan` refusal (2b); live issue and transition gate (18) | no test exists | n/a | ? SKIP |
| Corpus CLI scope (5); corpus hook install scope | no test exists; static reading only | n/a | ? SKIP |

Three test commands used, the brief's maximum. Totals: 146 + 90 + 160 = 396 pass, 0 fail, 14 files.

Probe execution: no probes declared or found. Not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-S2 | 72-01-PLAN.md | Registered repositories addressed by identifier; canonical paths; allowed roots enforced; traversal and symlink escape rejected; least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B; argv-only git | ✗ UNMET AS WRITTEN (credential clause; decision 2) | Path, containment and argv clauses MET (repo-scope.ts:98-226; repo-executor.ts:51). Credential clause NOT MET: surface bearer (config.ts:398-399, 981-1006) plus per-surface grant (repo-scope.ts:229-232); docs/worktree-fleet-api.md:161 names it an open decision. Corpus CLI argv-only but ungated (truth 5). |

No orphaned requirements: HARD-S2 is the only phase-72 mapping in REQUIREMENTS.md.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| packages/mcp-server/src/route-policy.ts | 51 | Comment: memory_search "derived hits are not yet filtered, RS-07". Code filters them (service.ts:6698). | ℹ️ Info | Stale comment contradicts the code. |
| packages/mcp-server/src/repo-executor.ts | 13 | Comment: "Phase 74 calls this entry point". No caller exists; Phase 74 text does not name it. | ⚠️ Warning | The comment, with D72-07 and SUMMARY §1, is the basis of the stated deferral. Remove or make true. |
| packages/cli/src/corpus/*, packages/corpus/src/discover.ts, gitio.ts, packages/collectors/src/install-git-hook.ts | — | git on corpus roots and `--repo` directories with no scope check; hook install writes into the named repository's hooks dir | ⚠️ Warning (truth 5) | See truth 5. |
| packages/cli/src/index.ts | 122-135, 313, 616, 677, 772 | CLI helper `git()` runs in `process.cwd()` before server calls: `repoSlug`, `branch`, `git rev-parse HEAD` in `cmdDrift` (313, before `POST /drift`), toplevel reads for sessions and lessons | ℹ️ Info (decision 4) | Reads the operator's own cwd checkout, not a caller-named repository; the server gate runs after. Recorded so decision 4 covers it. |
| packages/mcp-server/src/service.ts | 281-292, ~320 | `corpusRootReply` and `corpusAnchorReply` have no repository gate; protection is the route default deny only | ℹ️ Info | Fail-closed today; a future route or tool that reuses these replies would bypass it. |
| packages/mcp-server/src/server.ts | 2336, 2365 | `/worktrees/report` and `/worktrees/claims` default-denied to scoped surfaces (prior record) | ⚠️ Warning (carried forward) | Intended fail-closed; operator consequence. |
| packages/mcp-server/src/planning/observer.ts | 370, 615 | Background git reads (`spawnGit`, checkout.ts:79) on the operator-configured planning root; no caller chooses it | ℹ️ Info | Not on a request path; no surface-chosen repository. |
| packages/mcp-server/src/server.ts | 415 | `checkoutHead(skillsCheckout)` on the operator skills checkout | ℹ️ Info | Operator-configured library, not a registered repository. |
| packages/cli/src/worktree/command.ts | ~485 | `check-ref-format` git call in `deps.cwd` in `commandProvision` | ℹ️ Info | Runs after the scope gate at :557. |
| docs/worktree-fleet-api.md | 161 | Credential model recorded as open decision | ℹ️ Info | Consistent with this report. |
| .planning/ROADMAP.md (this tree) | 154 | Progress row "16 of 20 must-haves verified" | ℹ️ Info | Stale: this phase has 21 truth rows. |

Debt-marker gate: no TBD, FIXME or XXX markers in the files read. Not a full scan.

### Warnings (not roadmap criteria)

- **Scoping is off by default.** Criteria 1 and 2 hold only when `SUBSTRATE_REPO_SCOPES` is set (repo-scope.ts:9-11; config.ts:961-965 refuses a malformed value, and an unset value is not refused). PLAN D72-02 says "with a boot warning"; no such warning exists (grep of `SUBSTRATE_REPO_SCOPES` over non-test sources: only documentation, flag registry and parsers).
- **Allowlist unit.** Criterion 1 says "the session's allowlist". Grants are per surface (repo-scope.ts:27, parseRepoScopes at 147). A live session binds one `repo_id`. Decision 3.
- **Raw paths still accepted by the API.** HARD-S2 says "address registered repositories by identifier, not user-supplied raw paths". `POST /drift` accepts `path`, gated to a registration. Reported as a reading of the clause, not as a separate failure.
- **Gate line numbers corrected.** The prior record's drift gate lines (7636-7640) are now 7644-7649; the reap gate is 7384-7389 (function at 7377), not ~7380. The prior record's line references were stale; the code is unchanged.
- **Operational prerequisite (PLAN D72-06 / SUMMARY §5).** Under scoping, every `SUBSTRATE_WORKTREE_ROOTS` entry must be registered, or every `substrate worktree` command exits 2.

### Human Verification Required

1. **Decision 1, corpus proof disclosure (truth 11).** Decide whether a granted caller receiving `root`, `treeSize`, `index` and the audit path (sibling commitments over other repositories' `(repo, path, sha256)`) counts as reading another repository's corpus. Options named in the record: accept as allowed, rebuild per repository, or withhold foreign siblings, index and treeSize. **Why human:** policy reading of "read".
2. **Decision 2, credential model (HARD-S2 credential clause).** Decide whether the surface bearer plus its repository grant is "credential scoped to one repository", or whether repository-specific credential references are required. Either way HARD-S2 should be amended to match the decision. **Why human:** owner-held requirement text; this report does not decide it. Note: the phase's own plan (D72-03) takes the first reading; the requirement text takes the second.
3. **Decision 3, allowlist unit (criterion 1).** Owner confirms whether the surface, rather than the session, is the intended allowlist unit. **Why human:** design decision.
4. **Decision 4, `substrate corpus` CLI (truth 5).** Decide whether "the CLI" in criterion 1 includes the corpus CLI. If yes, add the scope gate before discovery, mirror, view, reflect and the hook installer (corpus/src/discover.ts:29, 252, 268; sync.ts:231; reflect.ts:122; index.ts:350; collectors install-git-hook.ts:48, 170-190), and verify it. The gate must also cover `hook install|uninstall|status --repo`, which writes into the named repository. If no, record that criterion 1 covers the worktree CLI only, and record that the corpus CLI's local reads and hook writes are outside the phase. Also decide whether the top-level CLI's cwd git reads (index.ts:122-135, 313) are in scope. **Why human:** the PLAN scoped the gate to `substrate worktree`; the roadmap says "the CLI". If yes, criterion 1 FAILS.
5. **Behavioral test for 2b (MCP `coord_drift_scan`).** Expected: isError refusal, zero git calls, one `repo.scope-refused` warning. No test exists.
6. **Postgres worktree filter (8).** Run the registry contract against a database with rows for two repositories and a non-null `repos` filter. Needs a database; none was started.
7. **Live-session issue and transition gate (18).** Add and run the test in behavior_unverified_items. No test exists.
8. **Scoping default (Warnings).** Decide whether scoping off by default, with no boot warning, is acceptable for a deployment that claims criteria 1 and 2. **Why human:** deployment posture decision.

### Gaps Summary

Status is `gaps_found` for two reasons, both pending owner decisions:

- **HARD-S2 credential clause is unmet as written.** No repository-specific credential reference exists. The implementation is a surface bearer with per-surface grants, which the phase's own docs name an open decision. Not decided here. Decision 2.
- **Criterion 1 is not met for the `substrate corpus` CLI** if that CLI is inside "the CLI". Its git calls run before any scope check, and the corpus hook installer writes into a named repository's hooks directory with no scope check. The server's ingest gate runs after the local reads. Decision 4. This is a possible failure, not a verified one.

Criterion 2 is met for every read door except the corpus proof disclosure (decision 1), with the Postgres filter (8) and the credential clause (decision 2) not closed. Criterion 1 is met at the REST drift door, the service gate, the MCP batch default deny and the `substrate worktree` CLI. The MCP drift door (2b) and the live-session issue and transition gate (18) are code-verified but no test exercises them under scope.

The scope code is unchanged since 749e97e3 (HEAD c7788f9d changes only phase 76 event-buffer code in service.ts). The unit and route tests are green on this tree (146, 90 and 160 pass, no fail).

---

_Verified: 2026-11-02T18:28:07Z_
_Verifier: Claude (gsd-verifier)_
