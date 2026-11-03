---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-03T02:10:57Z
status: gaps_found
score: 21/26 truth rows verified (2 present but behavior-unverified, 1 uncertain, 2 failed on evidence); success criteria 1 partial, 2 partial; HARD-S2 partial (amended text) and unmet as originally written
covered_files: [".planning/REQUIREMENTS.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-PLAN.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-SUMMARY.md", "docs/corpus-watch.md", "docs/worktree-fleet-api.md", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/scope.test.ts", "packages/cli/src/corpus/scope.ts", "packages/cli/src/corpus/watch-commands.ts", "packages/cli/src/index.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.test.ts", "packages/cli/src/worktree/scope.ts", "packages/collectors/src/install-git-hook.test.ts", "packages/collectors/src/install-git-hook.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/gitio.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/live-session-scope.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/repo-executor.test.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/repo-scope.reads-writes.test.ts", "packages/mcp-server/src/repo-scope.routes.test.ts", "packages/mcp-server/src/repo-scope.test.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-registry.ts"]
covered_digest: "v3:sha256:beb49ca7eb06f04bac9bf1ff6563699fd0d98c7a95cd6a6375eeba217aecdaf8"
behavior_unverified: 2
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: "20/26 (prior record at integration HEAD 4600d2a2, verified 2026-11-03T01:19:38Z)"
  gaps_closed:
    - "Truth 5b ordering: under a registry the standalone installer checks the registration before any git call. Commit 27778dee. install-git-hook.ts:318 calls inspect, which calls locate (92); the registration gate (96-99) precedes hooksDir (100), the first git call (53). Named test 'a registry is checked before any git call > with a registry set, an unregistered repository is refused without spawning git, and nothing is written' passes (command 1, JUnit). Probe at 27778dee: zero git calls, nothing written."
  gaps_remaining:
    - "Truth 5d: a registered linked worktree's shared hooks land in the unregistered main checkout's common git directory (.git/hooks), accepted as 'own' (install-git-hook.ts:69, 104). Probe reproduces at 27778dee. Owner decision; not decided here."
    - "Truth 6b: nested checkouts under an admitted root are attributed to the outer repository (repo-scope.ts:214-226; discover.ts:195-208). Owner decision 6; open."
    - "HARD-S2 identifier clause: raw paths at POST /drift, substrate drift --path and --root. Owner decision; open."
    - "Truth 11, corpus proof disclosure. Owner decision 1, open."
    - "Truth 3 allowlist unit, surface versus session (criterion 1). Owner decision 3, open."
    - "Truth 18, service-level live-session repo gate: still not exercised under scope; the public routes default-deny scoped callers first."
    - "Truth 8, Postgres repos filter: orchestrator evidence only (labelled as such); not run at HEAD."
    - "Scoping and the corpus registry gate are both default off. Criteria hold only when the variables are set."
  regressions: []
  notes: "Re-verified at integration HEAD 27778dee (gsd/v18-int-all). The only commit since 4600d2a2 is 27778dee, which touches packages/collectors/src/install-git-hook.ts and its test. Every other covered file is byte-identical to the 4600d2a2 record (git diff 4600d2a2..HEAD is empty for them), so rows 1-4, 6-17, 19-21 carry their 4600d2a2 evidence and were re-exercised by the command 2 test run at HEAD. Rows 5, 5b, 5c and 5d were re-evaluated against 27778dee. Row 6b is unchanged. docs/worktree-fleet-api.md:159 still says the standalone installer is not gated by the registry; that is stale under a registry (0504e77c, 27778dee) and is reported for the orchestrator to fix. Phase 76 and phase 78 files are not judged here."
gaps:
  - truth: "Truth 5d: a hook write from a registered linked worktree stays inside a registered directory"
    status: failed
    reason: "For a linked worktree git's hooks directory is the main checkout's common .git/hooks. ownLocations() accepts --git-common-dir, so a write there is accepted, although the main checkout is not registered. The probe wrote four hooks into the unregistered main checkout."
    artifacts:
      - path: "packages/collectors/src/install-git-hook.ts"
        issue: "ownLocations (65-76) includes the common git directory (69); within/containment at 104 accepts any target under it."
    missing:
      - "Owner decision: either the common git directory belongs to the registration (record it), or refuse a hooks directory whose checkout is unregistered (a code change, not made here)."
  - truth: "Truth 6b: a nested checkout under an admitted root is checked as its own repository"
    status: failed
    reason: "locateRepoPath returns the deepest registered directory containing a path; it does not check the path's own git toplevel. Local discovery therefore reads a nested, unregistered repository under the outer repository's admission. Server-side gates decide by the nested repository's own identity, so the leak is local, not into the server store."
    artifacts:
      - path: "packages/mcp-server/src/repo-scope.ts"
        issue: "locateRepoPath (214-226) matches by containment only."
      - path: "packages/corpus/src/discover.ts"
        issue: "Collects every nested .git under an admitted root (195-208) and runs inspectCheckout in each (242-268)."
    missing:
      - "Owner decision 6: a nested repository must be registered itself, or discovery must refuse nested .git directories under an admitted root."
---

# Phase 72: Repo allowlist and scoped credentials Verification Report

**Phase Goal:** A session can address only the repositories on its allowlist, and each repository's credential is scoped to that repository.
**Verified:** 2026-11-03T02:10:57Z
**Status:** gaps_found
**Re-verification:** Yes. Integration tree gsd/v18-int-all at HEAD 27778dee. The prior record (gaps_found, 4600d2a2) is replaced.

**Evidence labels.** "Verified by this verifier" means a command or a read this verifier ran on this tree. "Carried from 4600d2a2" means the evidence recorded by the prior verifier on files that are byte-identical at 27778dee; the tests named under them were re-run at HEAD. "Orchestrator evidence" means a claim the orchestrator supplied, cited with its source and not re-run here.

**Criteria source:** this tree's `.planning/ROADMAP.md`, Phase 72 section (lines 1252-1262). The two success-criteria texts match the 4600d2a2 record.

Criteria (verbatim):
1. A repository outside the session's allowlist is refused at the API and the CLI before any git call runs.
2. A credential scoped to one repository cannot read another repository's worktrees or corpus.

**Requirement source:** `.planning/REQUIREMENTS.md:113` (HARD-S2), amended by commit a147228f to the surface-bearer model. The amendment is binding for this record as the orchestrator instructed. This verifier did not see a separate owner record of the decision.

## Verdicts by criterion

| Criterion | Verdict |
| --------- | ------- |
| 1. API and CLI refuse before any git call | ⚠️ PARTIAL. VERIFIED for the REST drift door, the service gate, the MCP batch default deny, the MCP `coord_drift_scan` door, the live-session public routes (default deny), `substrate worktree`, and `substrate corpus` (gated commands, when `SUBSTRATE_REPO_REGISTRY` is set). The standalone installer now refuses an unregistered repository before any git call under a registry (row 5b, fixed in 27778dee). Hook writes are gated on the resolved hooks directory (row 5c). Not met: (a) a registered linked worktree writes hooks into an unregistered main checkout's common git directory (row 5d); (b) git runs in nested checkouts under an admitted root before any per-repository check (row 6b). Default off when the registry is unset. |
| 2. Scoped credential cannot read another repository's worktrees or corpus | ⚠️ PARTIAL. VERIFIED for worktree lists (service and store filter), corpus plan, ingest, status, reconcile, ledger, graphs, docs, writes, reaper, memory and the public live-session routes. UNCERTAIN for the corpus proof disclosure (decision 1). The Postgres worktree filter is orchestrator evidence only (row 8). Row 6b: local CLI discovery reads a nested repository under the outer repository's admission; the server-side gates still decide by that nested repository's own identity, so the leak is local, not into the server store. |

**HARD-S2 (REQUIREMENTS.md:113), against the amended text (binding for this record):**
- Address registered repositories by identifier, not raw paths: PARTIAL. `POST /drift` accepts `path` (service.ts:7647-7649), `substrate drift --path` sends it (cli/src/index.ts:318-319), and `--root` takes a raw path (corpus/index.ts:177). Each raw path is gated to a registration, so none reaches another repository. The identifier clause is still open (owner decision, not decided here).
- Canonicalize paths; component-wise roots; traversal and symlink rejection, including after registration: MET for the gated doors (repo-scope.ts:98-100 `contains` with separator; 188-203 `resolveContained` realpath per call; 214-226 `locateRepoPath`; overlap refusal at parse, `parseRepoRegistry` repo-scope.ts:116). Hook directories pass the same containment (install-git-hook.ts:102-106), except the linked-worktree case in row 5d.
- Repository access granted per surface; every route and tool resolves the caller's surface and refuses an ungranted repository: MET (server.ts:965-970 REST default deny; server.ts:2748-2757 MCP batch default deny; route-policy.ts:21-79 declarations; repo-scope.ts:229-232 `isGranted`).
- Repo A credentials cannot authorize repo B: MET for the gated doors (surface bearer maps to one surface, config.ts:398-399, 981-1006; grants are per surface, repo-scope.ts:229-261). A surface holding several grants is not "scoped to one repository"; D72-03 allows a single-grant surface.
- Argv-only git: MET for gated paths (repo-executor.ts:51 `spawnSync("git", [...args])`; discover.ts:30; gitio.ts:36; install-git-hook.ts:53, 67, 69 argv arrays).

**HARD-S2 against the original 23bd0733 text** ("Resolve least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B"): UNMET AS WRITTEN. No repository-specific credential reference exists in `packages/mcp-server/src`, `packages/cli/src` or `packages/fleet/src` (non-test). The credential is a surface bearer token. This is the owner-amended clause, so it is recorded here, not re-decided.

**Decision status:** Open and owner-held: (1) corpus proof disclosure; (3) allowlist unit (surface versus session); the identifier clause of HARD-S2; the scope of "the CLI" for the collectors' cwd reads (decision 4; the installer ordering part is now closed); the common git directory of a registered linked worktree (row 5d; decision 4 or a new owner call); nested checkouts (decision 6). Recorded, not re-decided: (2) the credential model, as amended in a147228f and relayed by the orchestrator. Decision 4's corpus CLI gate and installer gate are implemented; their scope beyond those is open. Decision 6 and the D76-16 refusals belong to other phases and are not judged here.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| 1 | SC1 service: a drift scan naming an ungranted repository, or a path in another repository, is refused before any git call | ✓ VERIFIED | Carried from 4600d2a2. `scopedDriftScan` service.ts:7642. Repo gate 7644-7645; path gate 7647-7648, before the scan at 7649. Tests in repo-scope.routes.test.ts and repo-scope.boundary.test.ts pass (command 2). |
| 2a | SC1 REST: `POST /drift` runs the gate before the scan | ✓ VERIFIED | Carried from 4600d2a2. server.ts:1585-1596 (audit with no git, then `scopedDriftScan`, then refusal). Route test passes (command 2). |
| 2b | SC1 MCP: `coord_drift_scan` refuses an ungranted repository before any git call | ✓ VERIFIED | Carried from 4600d2a2. Test "MCP coord_drift_scan ... boundary" in repo-scope.routes.test.ts (lines 404-422) calls `tools/call coord_drift_scan` as a surface granted only owner/name, with spies on `driftScan` and `Bun.spawnSync`. Asserts `repo-not-granted`, zero `driftScan` calls, zero git argv calls, zero reads, and one `drift` refusal in the ledger. Passes (command 2). Caveat: the spies cover `Bun.spawnSync` and `driftScan` only. `repo-executor.ts:51` uses `node:child_process` and is not on this path. |
| 3 | SC1 API: every REST route or MCP tool with no declaration is refused to a scoped caller before its handler | ✓ VERIFIED | Carried from 4600d2a2. REST default deny server.ts:965-970; MCP batch default deny server.ts:2748-2757; declarations route-policy.ts:21-79 and `MCP_TOOL_POLICY`. "default deny" describe in repo-scope.routes.test.ts passes (command 2). |
| 4 | SC1 CLI: `substrate worktree` refuses an ungranted root, `--repo`, provision target, merge-back or guard path before any git call, exit 2 | ✓ VERIFIED | Carried from 4600d2a2. `runWorktree` calls `scopeRefusal` at cli/src/worktree/command.ts:557 before the dispatch switch. `packages/cli/src/worktree/scope.test.ts` passes (command 1). |
| 5 | SC1 CLI: `substrate corpus` refuses an unregistered `--root`, `--repo` directory, or named `--repo` before any git call or hook write, when the registry is set | ✓ VERIFIED (gated commands; default off) | `runCorpus` calls `corpusScopeRefusal(sub, deps.env, localTargets(...), deps.audit)` at cli/src/corpus/index.ts:304 and returns 2 at 305-307, before any dispatch. `localTargets` (index.ts:184-199) covers `scan`, `plan`, `ingest`, `eval`, `reflect`, `sync`, `watch`, `reconcile`, and `hook` (resolved `--repo`). `status`, `prove`, `verify` run no local git. `hint` writes a spool file and runs no git (documented, docs/worktree-fleet-api.md:158). `hook` dispatch threads `deps.env` (index.ts:357) so the hooks directory gate reads the same registry (watch-commands.ts:219-225). Carried from 4600d2a2 (cli files unchanged); command 1 passes. |
| 5b | SC1 CLI: the standalone installer `packages/collectors/src/install-git-hook.ts` refuses an unregistered repository before any git call or hook write | ✓ VERIFIED under a registry (default off, as row 5) | Order under a registry: `installRepos` (308) calls `inspect` (318) before any other step; `inspect` (111-113) calls `locate` (92); `locate` parses the registry from env (93), applies the registration gate `localPathGate(scope, LOCAL_SURFACE, resolve(repo))` (96-99), and only then calls `hooksDir` (100), the first git call (`rev-parse --git-path hooks`, line 53). `main` (361-374) makes no git call before `installRepos` (372). The refusal writes nothing (324-328). Named test "a registry is checked before any git call > with a registry set, an unregistered repository is refused without spawning git, and nothing is written" (install-git-hook.test.ts:328-346) passes (command 1, JUnit, no failure; the git shim recorded no call). Probe at 27778dee (this verifier; `/tmp/r12probe/unreg`, a git shim on PATH logging every call; registry names another checkout): exit 1, `✗ … — refused: the path is not inside a directory registered for any repository; nothing was written`, git calls logged 0, no non-sample hook file. Control, registry unset: `installed`, exit 0, one git call logged. That is the unchanged default-off behaviour, and it is the same default-off caveat as row 5. |
| 5c | HARD-S2 path clause: a hook write stays inside a registered directory, including after `core.hooksPath` resolution | ✓ VERIFIED (core.hooksPath case) | `locate` 102-106: with a registry set, the resolved hooks directory (`resolveContained(dir)`, 103) must lie within `ownLocations(repo)` (65-76), else refused (104-105). Applied in `inspect` (111-113), `installCorpusHooks` (225-226) and `uninstallCorpusHooks` (254-255). Named test "core.hooksPath under a repository registry > a hooks directory outside the registered repository is refused and nothing is written there; an in-repo one still installs" (install-git-hook.test.ts:304-325) passes (command 1). |
| 5d | HARD-S2 path clause: a hook write from a registered linked worktree stays inside a registered directory | ✗ FAILED (literal clause; owner may decide the common git directory belongs to the registration) | `ownLocations` (install-git-hook.ts:65-76) includes `--git-common-dir` (line 69), and `within` (79-82) accepts any target beneath it (containment check at 104). For a linked worktree, git's hooks directory is the main checkout's common `.git/hooks`. Probe at 27778dee (this verifier; `/tmp/r12probe/main` with linked worktree `/tmp/r12probe/wt`; registry lists only `/tmp/r12probe/wt`): `--corpus /tmp/r12probe/wt` exit 0; `post-commit`, `post-merge`, `post-checkout`, `post-rewrite` written to `/tmp/r12probe/main/.git/hooks`, where `main` is not registered. 27778dee states this residual as unchanged. |
| 6 | SC1/SC2 path containment: `..`, symlinks and registered roots compared after realpath; overlapping registrations refused at boot | ✓ VERIFIED | Carried from 4600d2a2. repo-scope.ts:188-203 `resolveContained`; 214-226 `locateRepoPath`; 98-100 `contains`; overlap refusal at parse (`parseRepoRegistry`, repo-scope.ts:116). Tests RS-14 and the boundary symlink and dot-dot tests pass (command 2). |
| 6b | SC1/SC2: a nested checkout under an admitted root is checked as its own repository | ✗ FAILED (known gap; disclosed by the implementer; owner decision 6) | `locateRepoPath` (repo-scope.ts:214-226) returns the deepest registered directory that contains the path. It does not check that the path's own git toplevel is that registration. Corpus discovery walks each root and collects every nested `.git` (discover.ts:195-208), then runs `inspectCheckout` (`git remote`, `rev-parse`, `log`) in each (discover.ts:242-268). Consequence: the local CLI reads a nested, unregistered repository under the outer repository's admission. The server-side gates (`repoRefusalOf`, corpus/service.ts:154-163) decide by the nested repository's own identity, so the leak is local, not into the server store. Unchanged since 4600d2a2. |
| 7 | SC2 worktrees, fake store: an unfiltered scoped list returns only granted rows; a named ungranted repository is refused before the read | ✓ VERIFIED | Carried from 4600d2a2. `listWorktrees` service.ts:5127-5135 (access check, named gate, `grantedRepos` at 5135); fake filter worktree-registry-fake.ts:56. Tests in repo-scope.reads-writes.test.ts and repo-scope.routes.test.ts pass (command 2). |
| 8 | SC2 worktrees, Postgres: the list query filters in SQL, and an empty list matches no row | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (by this verifier) | Carried from 4600d2a2. worktree-registry.ts:390 `repos` is a typed array (`this.sql.array([...filter.repos], "TEXT")`); line 397 predicate `(${repos}::text[] is null or lower(repo) = any(${repos}::text[]))`. Unchanged since 9ee12695 (`git diff 9ee12695..HEAD` is empty for the file). The case at worktree-registry.pg.test.ts:51 exists. Not run here: `SUBSTRATE_TEST_PG_URL` is unset, so the file's 14 skipped entries (12 named tests and 2 unnamed) were not run (see command 2). Orchestrator evidence: `/root/src/worktrees/backups/t-r10c-pg-registry.log`, 12 pass, 0 fail, 40 expect() calls, 12 tests across 1 file. The log names no commit or command, and its mtime (2026-11-02 21:18:57 UTC) precedes commit 9ee12695 (21:23:58 UTC). Timestamp caveat in behavior_unverified_items. |
| 9 | SC2 corpus: plan, ingest and proof refuse an ungranted repository after parse and before any manifest or plane read | ✓ VERIFIED | Carried from 4600d2a2. `repoRefusalOf` corpus/service.ts:154-163; plan 177; ingest; proof before `deps.roots.read()`. Test "a proof for an ungranted repository is refused before the corpus manifest is read" passes (command 2). |
| 10 | SC2 corpus status, reconcile, root and anchor: refused to scoped callers | ✓ VERIFIED (status and reconcile via `allReposRefusal`; root and anchor via route default deny) | Carried from 4600d2a2. `allReposRefusal` corpus/service.ts:166-168. `/corpus/root` and `/corpus/anchor` have no REST_ROUTE_POLICY entry (route-policy.ts:21-79), so default deny applies (server.ts:965-970). |
| 11 | SC2 corpus proof disclosure: a granted proof reveals no other repository's digests or corpus-wide counts | ? UNCERTAIN (decision 1, open) | Carried from 4600d2a2. Reply at corpus/service.ts:309-313 carries `root`, `treeSize`, `index`, `leaf`, `sha256` and the audit `path`. `inclusionOf` (mcp-server/src/corpus/root.ts:84-93) builds the proof over the whole-corpus tree (root.ts:48-61), so sibling hashes on the audit path and `root` commit to other repositories' `(repo, path, sha256)` (packages/corpus/src/leaf.ts:65-69). `index` and `treeSize` expose corpus-wide position and count. No document content is disclosed. Whether this is "reading another repository's corpus" is a policy reading. docs/worktree-fleet-api.md states corpus root and anchor are not gated. |
| 12 | SC2 ledger: a named ungranted repository is refused before the query; rows are filtered to the grant | ✓ VERIFIED | Carried from 4600d2a2. `queryEventsFor` service.ts:6657-6663; `rowsInGrant` (repo-scope.ts:316-319). Tests in repo-scope.reads-writes.test.ts pass (command 2). |
| 13 | SC2 graphs: a graph's repository is read from its row and must be granted before content is read; no resolvable repository is refused | ✓ VERIFIED | Carried from 4600d2a2. `graphRepoOf` service.ts:6575-6582; `scopedGraphRefusal` 6586-6592. Tests pass (command 2). |
| 14 | SC2 docs: search and LightRAG query refused to every scoped surface before retrieval or fallback | ✓ VERIFIED | Carried from 4600d2a2. `scopedDocsRefusal` service.ts:6606; declared GATED at route-policy.ts:35-36. Test passes (command 2). |
| 15 | SC2 writes: `events_emit`, `graph_register`, `handoff`, `POST /events` refuse an ungranted or absent target before the write | ✓ VERIFIED | Carried from 4600d2a2. `scopedWriteRefusal` service.ts:6615. Tests pass (command 2). |
| 16 | SC2 lease reaper: an unnamed reap touches only granted repositories; a named ungranted reap reaps nothing | ✓ VERIFIED | Carried from 4600d2a2. `reapExpiredLeases` service.ts:7377; named gate 7384-7389; unnamed reap targets `grantedRepos` (7389). Test passes (command 2). |
| 17 | SC2 live sessions, discovery: an unnamed discovery by a scoped caller is refused | ✓ VERIFIED | Carried from 4600d2a2. Gate `scopedRepoRefusal("live_session_discovery", ...)` at service.ts:2145, before `listVisible`. Test passes (command 2). |
| 18 | SC2 live sessions, issue and transition: an ungranted `repo_id` is refused before `authority.issue` or `transition` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (the service-level gate) | Carried from 4600d2a2. Gate `authorizeRepo` at service.ts:2097-2101, before `authority.issue`/`transition` (2103). The public door refuses before the service: `live-session-scope.test.ts` (3 tests, command 2) asserts `not-declared-for-scope` for REST `POST /steering/sessions` and for MCP `docs_steering_session` issue and transition. That refusal is default deny, not the repo gate. No test reaches service.ts:2097 under scope. |
| 19 | SC2 memory search: a scoped caller receives only entries whose scope and own `repo` are both granted | ✓ VERIFIED | Carried from 4600d2a2. `memoryReplyInGrant` service.ts:6679-6700; derived hits filtered at 6698. Tests pass (command 2). The comment at route-policy.ts:51 ("derived hits are not yet filtered, RS-07") is stale. |
| 20 | SC2 memory verify: a scoped caller gets no verdict for an entry of an ungranted repository | ✓ VERIFIED | Carried from 4600d2a2. Gate `authorizeRepo` service.ts:4448-4455; reader grant at 4457-4458. Tests pass (command 2). |
| 21 | SC1/SC2 live sessions at the public routes: a scoped caller's live-session issue and transition are refused before any session is read or written | ✓ VERIFIED (by default deny; consequence below) | Carried from 4600d2a2. live-session-scope.test.ts (3 tests) pass (command 2). Live-session routes and `docs_steering_session` are undeclared (route-policy.ts: no `/steering/` entry; absent from `MCP_TOOL_POLICY`), so every scoped caller is refused. Consequence: scoped surfaces cannot run live sessions at all. A product consequence, not a leak. |

**Score:** 21 of 26 truth rows verified. Two are present but behavior-unverified (8, 18). One is uncertain (11). Two failed on evidence (5d, 6b). Row 5b moved from failed to verified (27778dee). The prior count (20 of 26) is directly comparable: same 26 rows.

### Deferred Items

None. The prior deferral of `scopedGit` to "Phase 74" stays withdrawn (this phase's own D72-07 is the basis; Phase 74's wording does not name it).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/repo-scope.ts` | Pure gate, parsers, local gates, refusal payload | ✓ VERIFIED | Gates 229-261; local gates 269-294 (`localRegistryScope` 269, `localPathGate` 278, `localRepoGate` 289); containment 188-226. |
| `packages/mcp-server/src/repo-executor.ts` | `scopedGit` executor | ✓ VERIFIED (unit); NOT WIRED | Argv spawn at line 51 via node:child_process. No production caller. |
| `packages/cli/src/worktree/scope.ts` | CLI gate before git | ✓ VERIFIED | Dispatch call at command.ts:557. |
| `packages/cli/src/corpus/scope.ts` | Corpus CLI gate; cwd-git permit | ✓ VERIFIED (gated commands) | `corpusScopeRefusal` 39-60; `localGitPermitted` 62-68. Default off when the registry is unset. |
| `packages/cli/src/corpus/index.ts` | Targets per command, gate before dispatch | ✓ VERIFIED (gated commands) | `localTargets` 184-199; gate 304-307; hook env threaded at 357. |
| `packages/cli/src/corpus/watch-commands.ts` | Hook command passes env and refuses `refused` | ✓ VERIFIED | `runHookCommand` 219-225 (env at 220; `refused` state at 223 returns exit 1 at 225). |
| `packages/cli/src/index.ts` | cwd git reads gated | ✓ VERIFIED | `git()` 127-130 returns "" unless `localGitPermitted`. Callers at 135, 141, 319, 622, 683, 778. |
| `packages/collectors/src/install-git-hook.ts` | Corpus hook installer and standalone installer gated under the registry, registration before any git call | ⚠️ PARTIAL | Registration before git and before write: `locate` 92-109 (gate 96-99, `hooksDir` 100), entry `inspect` 111-113, `installRepos` 308-318, `main` 372. Containment 102-106; `installCorpusHooks` 225-226; `uninstallCorpusHooks` 254-255. Linked-worktree common directory accepted (65-76, 104): row 5d FAILED. |
| `packages/collectors/src/install-git-hook.test.ts` | Named hooks-path test; named ordering test | ✓ VERIFIED (command 1) | Hooks-path test at 304-325; ordering test at 328-346. The file passed 22 of 22 with 0 fail, 0 skip. |
| `packages/collectors/src/git-context.ts`, `muse.ts`, `cursor-stop.ts` | Collector git reads in the session cwd | ℹ️ NOT GATED (not caller-named) | `git -C cwd` reads (git-context.ts:16, 26; muse.ts:312-314; cursor-stop.ts:315). Run from agent hooks in the session cwd, not from `substrate corpus`. Open under decision 4 if "the CLI" includes collectors. |
| `packages/mcp-server/src/route-policy.ts` | Default-deny declarations | ✓ VERIFIED | Corpus entries 28-32; drift 26; `coord_drift_scan` 66; worktrees 27. Stale comment at line 51. |
| `packages/mcp-server/src/service.ts` | Gates and filters | ✓ VERIFIED | 2097, 2145, 4448-4458, 5127-5135, 6563-6617, 6657-6698, 7377-7389, 7642-7649. |
| `packages/mcp-server/src/corpus/service.ts` | Corpus gates | ✓ VERIFIED | 154-168; proof reply 309-313 (decision 1). |
| `packages/mcp-server/src/worktree-registry.ts` | `repos` filter in SQL, typed array | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (by this verifier) | 390 and 397 (unchanged since 9ee12695). See row 8. |
| `packages/mcp-server/src/config.ts` | `repoScope` from env; boot refusal on malformed values | ✓ VERIFIED | `repoScopeOrRefuse` 961-965; `tokenConfig` 981-1006. Scoping off unless `SUBSTRATE_REPO_SCOPES` is set. |
| `docs/worktree-fleet-api.md` | Both flags documented; credential model; corpus CLI gate and gaps | ⚠️ STALE | Corpus CLI bullet at 158 is current. Line 159 says the standalone installer is "not gated by this registry", and that its `--corpus` hooks are "gated only when installed through `substrate corpus hook`". Both are stale under a registry (0504e77c, 27778dee). The hooks-directory gate (5c) and its linked-worktree residual (5d) are undocumented. Credential model at 163 still an open decision. Reported for the orchestrator to fix. |
| `docs/corpus-watch.md` | Exit codes for hook commands | ✓ VERIFIED | Lines 194-195 updated in 0504e77c to name the registry refusal for `hook install|uninstall`. |
| `.planning/REQUIREMENTS.md` HARD-S2 | Requirement text | ✓ AMENDED (a147228f), partial on identifier clause | Line 113 carries the amended text. The original text is in 23bd0733. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| server.ts `POST /drift` | `scopedDriftScan` | server.ts:1586 | ✓ WIRED | Exercised by routes test. |
| mcp.ts `coord_drift_scan` | `scopedDriftScan` | mcp.ts:2005 | ✓ WIRED | Exercised under scope by the new test (2b). |
| server.ts `GET /worktrees` | `listWorktrees(query, surface)` | server.ts | ✓ WIRED | Exercised by routes test. |
| mcp.ts `worktree_list` | `listWorktrees(query, callerSurface)` | mcp.ts | ✓ WIRED (code) | Not separately exercised. |
| `runWorktree` | `scopeRefusal` | command.ts:557 | ✓ WIRED | Exercised by CLI tests. |
| `runCorpus` | `corpusScopeRefusal` | corpus/index.ts:304 | ✓ WIRED | Exercised by corpus scope tests (command 1). |
| `runHookCommand` | `installCorpusHooks` / `uninstallCorpusHooks` with registry env | watch-commands.ts:219-225 | ✓ WIRED | `locate` reads the same env (install-git-hook.ts:225-226, 254-255). |
| top-level `git()` | `localGitPermitted` | cli/src/index.ts:128 | ✓ WIRED | Unit-tested by corpus/scope.test.ts (cwd tests, 179-196). |
| `memoryReplyInGrant` | per-entry repo grant | service.ts:6679-6698 | ✓ WIRED | Exercised by reads-writes test. |
| `updateLiveSession` | `authorizeRepo` before issue or transition | service.ts:2097 | ✓ WIRED (code) | NOT reachable for scoped callers through the public routes (default deny first); not exercised under scope (row 18). |
| `installCorpusHooks` | registry gate on the resolved hooks dir | install-git-hook.ts:102-106, 225-226 | ✓ WIRED | Covers `core.hooksPath` (row 5c); not the linked-worktree common dir (row 5d). |
| standalone installer `main()` | registration gate before git | install-git-hook.ts:372 → 318 → 92-100 | ✓ WIRED | Registration (96-99) precedes the first git call (100); refusal writes nothing (324-328). Tested by the ordering test (command 1) and the probe. |
| `scopedGit` | production git call sites | repo-executor.ts | ✗ NOT_WIRED | No production caller. Not a stated Phase 72 criterion. |

### Data-Flow Trace (Level 4)

Not applicable. The phase adds gates and filters, not rendered output.

### Behavioral Spot-Checks

Commands run from `/root/src/worktrees/as-gsd-v18-all` at HEAD 27778dee, each as `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun --no-env-file test --reporter=junit --reporter-outfile=/tmp/r12probe/<name>.xml <files>`. The JUnit output was read for per-test names and failure elements. No test was added or edited. No database was started. No formatter, tsc, lint or full suite was run. Two test commands were used, the brief's maximum.

| Behavior | Command (files) | Result | Status |
| -------- | --------------- | ------ | ------ |
| Installer ordering and hooks-path tests, corpus and worktree CLI scope (command 1) | `packages/collectors/src/install-git-hook.test.ts packages/cli/src/corpus/scope.test.ts packages/cli/src/worktree/scope.test.ts packages/cli/src/corpus/watch-commands.test.ts packages/cli/src/corpus/index.test.ts` | 149 pass, 0 fail, 0 skip, 611 expect() calls, 5 files. JUnit names both named tests ("with a registry set, an unregistered repository is refused without spawning git, and nothing is written"; "a hooks directory outside the registered repository is refused and nothing is written there; an in-repo one still installs") with no failure element. | ✓ PASS |
| MCP scope routes, live-session scope, boundary, reads-writes, executor, worktree registry (command 2) | `packages/mcp-server/src/repo-scope.routes.test.ts packages/mcp-server/src/live-session-scope.test.ts packages/mcp-server/src/repo-scope.boundary.test.ts packages/mcp-server/src/repo-scope.test.ts packages/mcp-server/src/repo-scope.reads-writes.test.ts packages/mcp-server/src/repo-executor.test.ts packages/mcp-server/src/worktree-registry.test.ts packages/mcp-server/src/worktree-registry.http.test.ts packages/mcp-server/src/worktree-registry.pg.test.ts` | 242 pass, 14 skip, 0 fail, 634 expect() calls, 9 files (256 tests). All 14 skips are in worktree-registry.pg.test.ts (12 named tests and 2 unnamed describe-level entries, no assertions), because `SUBSTRATE_TEST_PG_URL` is unset. The earlier record's "2 others not identified" are these two unnamed entries. | ✓ PASS (14 skips = Postgres file) |
| Postgres worktree repos filter (row 8) | not run by this verifier (URL unset) | Orchestrator evidence: `t-r10c-pg-registry.log`, 12 pass, 0 fail, 40 expect() calls, 12 tests across 1 file. Not tied to HEAD by its own content; see behavior_unverified_items. | ? ORCHESTRATOR EVIDENCE ONLY |
| Standalone installer refuses an unregistered repository before any git call (5b) | shell probe: `bun packages/collectors/src/install-git-hook.ts --corpus /tmp/r12probe/unreg` with `SUBSTRATE_REPO_REGISTRY` (JSON) naming another checkout; `PATH` holds a git shim that logs every call | exit 1; `refused: the path is not inside a directory registered for any repository; nothing was written`; git calls logged 0; no hook written. Control with the registry unset: installed, exit 0, one git call logged (default-off behaviour). | ✓ PROBED (not a test) |
| Linked worktree hooks location (5d) | shell probe: `git worktree add /tmp/r12probe/wt` from `/tmp/r12probe/main`; registry lists only `/tmp/r12probe/wt`; `bun ... --corpus /tmp/r12probe/wt` | exit 0; four hooks written to `/tmp/r12probe/main/.git/hooks`, a path of the unregistered main checkout | ✓ PROBED (not a test) |
| Live-session service gate (row 18) | no test exists under scope | n/a | ? SKIP |

Probe execution: no probes declared in PLAN or SUMMARY. The shell probes above are fact checks by this verifier, not probes in the Step 7c sense. Scratch directory `/tmp/r12probe` is outside the repository and was not committed.

Debt-marker gate: the 27778dee diff adds no TBD, FIXME, XXX, TODO or HACK (grep of the commit's added lines returns 0). The `*_PLACEHOLDER` identifiers in install-git-hook.ts predate the commit and are code names, not debt markers.

Fingerprint: `gsd-tools query verification.fingerprint .planning/phases/72-repo-allowlist-and-scoped-credentials` over the 33 covered files above, run at HEAD 27778dee. `covered_files` and `covered_digest` are copied from its output.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-S2 (amended, a147228f) | 72-01-PLAN.md | Identifier addressing; canonical paths; traversal and symlink rejection; per-surface grants; no repository-specific credential reference required; argv-only git | ⚠️ PARTIAL | Containment, grants and argv MET for gated doors (rows 1-7, 9-17, 19-21). Hook-directory containment: `core.hooksPath` closed (5c); registration before git closed (5b); linked-worktree common directory FAILED (5d). Identifier clause OPEN: raw paths at `POST /drift`, `substrate drift --path`, `--root`. Nested attribution FAILED (6b). |
| HARD-S2 (original, 23bd0733) | 72-01-PLAN.md | Same, plus "resolve least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B" | ✗ UNMET AS WRITTEN | No repository-specific credential reference (config.ts:398-399, 981-1006; repo-scope.ts:229-232). |

No orphaned requirements: HARD-S2 is the only phase-72 mapping in REQUIREMENTS.md.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| packages/mcp-server/src/repo-executor.ts | 13 | Comment: "Phase 74 calls this entry point". No caller exists; Phase 74 text does not name it. | ⚠️ Warning | Carried forward. |
| packages/collectors/src/install-git-hook.ts | 52-53, 100 | `hooksDir` runs `git rev-parse --git-path hooks`. Under a registry it runs after the registration gate (96-99). With the registry unset it runs with no gate, as before. | ℹ️ Info | Row 5b closed under a registry (27778dee). Default-off, like every gate here. |
| packages/collectors/src/install-git-hook.ts | 69, 104 | Common git directory of a linked worktree accepted as "own" without checking the main checkout's registration. | ⚠️ Warning | Row 5d. |
| docs/worktree-fleet-api.md | 159 | Installer described as "not gated by this registry"; stale under a registry (0504e77c, 27778dee). | ⚠️ Warning | Doc must match the code; the 5c/5d residual is undocumented. Reported for the orchestrator to fix. |
| packages/mcp-server/src/route-policy.ts | 51 | Comment: memory_search "derived hits are not yet filtered, RS-07". Code filters them (service.ts:6698). | ℹ️ Info | Stale comment contradicts the code. |
| packages/mcp-server/src/live-session-scope.test.ts | 52 | Test name says "refused before the session authority is read"; the refusal is default deny (`not-declared-for-scope`), not the repo gate. | ℹ️ Info | The name overstates the mechanism. The service gate (row 18) is still unexercised. |
| packages/mcp-server/src/repo-scope.routes.test.ts | 404-422 | The coord_drift_scan test spies `Bun.spawnSync` and `driftScan`, not `Bun.spawn` or `node:child_process`. | ℹ️ Info | Adequate for the drift path; not a general no-git proof. |
| packages/mcp-server/src/service.ts | 281-292, ~320 | `corpusRootReply` and `corpusAnchorReply` have no repository gate; protection is the route default deny only. | ℹ️ Info | Fail-closed today. |
| packages/mcp-server/src/server.ts | 2336, 2365 | `/worktrees/report` and `/worktrees/claims` default-denied to scoped surfaces. | ⚠️ Warning | Intended fail-closed; operator consequence. |
| packages/cli/src/index.ts | 318-319 | `substrate drift --path` sends a raw path to the server. | ℹ️ Info | Gated server-side to a registration; identifier clause. |
| packages/cli/src/corpus/watch-commands.ts | hint path | `corpus hint` writes a spool entry for an unregistered path with no git call. | ℹ️ Info | The watch loop ignores hints outside its roots (watch-loop.ts:180-184). Not gated at the CLI. |
| packages/mcp-server/src/planning/observer.ts | 370, 615 | Background git reads on the operator-configured planning root. | ℹ️ Info | Not on a request path. |
| packages/mcp-server/src/server.ts | 415 | `checkoutHead(skillsCheckout)` on the operator skills checkout. | ℹ️ Info | Operator-configured library, not a registered repository. |
| packages/mcp-server/src/cache.test.ts; planning/observer.test.ts | 1630; 1 | Test time budgets raised (4600d2a2, 48fb961c). | ℹ️ Info | Not phase 72; not judged. |

### Advisory (New Scope, Unevidenced)

None. The only change since 4600d2a2 is 27778dee, and its finding is judged under row 5b with evidence.

### Warnings (not roadmap criteria)

- **Scoping is off by default.** Criteria 1 and 2 hold only when `SUBSTRATE_REPO_SCOPES` is set (repo-scope.ts:9-11; config.ts:961-965). PLAN D72-02 said "with a boot warning"; none exists.
- **The corpus CLI gate and the standalone installer gate are off by default.** They hold only when `SUBSTRATE_REPO_REGISTRY` is set (cli/src/corpus/scope.ts:39-43 returns null when unset; install-git-hook.ts:93 `localRegistryScope` returns null when unset; docs/worktree-fleet-api.md:158). The phase text says "refuses"; an operator who does not set the variable gets the prior behaviour, including the installer's git call before any write.
- **Live sessions are unusable by scoped surfaces.** Consequence of row 21's default deny (a product consequence; no leak).
- **Allowlist unit.** Criterion 1 says "the session's allowlist". Grants are per surface (repo-scope.ts:27, 147). Decision 3.
- **Operational prerequisite (PLAN D72-06).** Under scoping, every `SUBSTRATE_WORKTREE_ROOTS` entry must be registered, or every `substrate worktree` command exits 2.

### Human Verification Required

1. **Decision 1, corpus proof disclosure (row 11).** Decide whether a granted caller receiving `root`, `treeSize`, `index` and the audit path counts as reading another repository's corpus. Options: accept as allowed, rebuild per repository, or withhold foreign siblings, index and treeSize. **Why human:** policy reading of "read".
2. **Identifier clause of HARD-S2 (raw paths at `POST /drift`, `substrate drift --path`, `--root`).** Decide whether addressing by identifier only is required now, and if so, the change to those doors. **Why human:** owner-held requirement reading.
3. **Decision 3, allowlist unit (criterion 1).** Confirm the surface, not the session, is the intended allowlist unit. **Why human:** design decision.
4. **Decision 4, scope of "the CLI" (collectors).** The corpus CLI gate and the installer's ordering are in place (27778dee closed the installer ordering). Decide whether `packages/collectors/src/git-context.ts`, `muse.ts` and `cursor-stop.ts` cwd reads are inside criterion 1. **Why human:** scope of "the CLI".
5. **Linked-worktree common git directory (row 5d).** Decide whether the common git directory of a registered worktree belongs to the registration. If not, a code change is needed to refuse a hooks directory whose checkout is unregistered (not made here). **Why human:** registry-model choice; the impact needs repository write access and affects the main checkout's commits.
6. **Nested checkouts under an admitted root (row 6b).** Decide whether a nested repository must be registered itself, or whether discovery must refuse nested `.git` directories under an admitted root. **Why human:** policy and data-model choice.
7. **Decision 2, credential model (HARD-S2 amended).** Recorded as the owner decision in a147228f and relayed by the orchestrator. Confirm the amendment matches the owner's decision, and update docs/worktree-fleet-api.md:159 and :163 to match the code and the decision. **Why human:** owner-held requirement text.
8. **Postgres worktree filter (row 8).** Run `worktree-registry.pg.test.ts` against a database at HEAD 27778dee and record the commit with the run. The orchestrator's log predates the last recorded write to worktree-registry.ts. **Why human:** database not started here.
9. **Service-level live-session gate (row 18).** Add a test that reaches service.ts:2097 under scope, or accept the route-level default deny as the criterion's evidence. **Why human:** test-design choice; also a product consequence.
10. **Scoping and corpus registry defaults.** Decide whether default-off is acceptable for a deployment that claims criteria 1 and 2. **Why human:** deployment posture decision.

### Gaps Summary

Status is `gaps_found` by the decision tree's first rule: failed truths 5d and 6b remain on this tree. Each is a real gap, and each is an owner decision that this record does not make.

- **Criterion 1 (partial).** The API doors and the `substrate worktree` and `substrate corpus` CLIs refuse before git when their variables are set. The installer now checks the registration before any git call and before any write under a registry (5b, closed in 27778dee). The hook write gate closes `core.hooksPath` (5c). Not met: a registered linked worktree writes hooks into an unregistered main checkout's common git directory (5d); nested checkouts (6b).
- **Criterion 2 (partial).** Worktrees, corpus, ledger, graphs, docs, writes, reaper, memory and live-session routes are verified. The corpus proof disclosure is open (decision 1). The Postgres worktree filter has orchestrator evidence only. Nested checkouts (6b) are a local-read gap.
- **HARD-S2 (partial, amended text).** Containment, grants and argv hold for the gated doors. The identifier clause is open. Hook-directory containment holds for `core.hooksPath` (5c) and for the installer's ordering (5b); it fails for linked worktrees (5d).
- **HARD-S2 (original text).** Unmet as written: no repository-specific credential reference exists. Recorded, not re-decided, since the owner amendment is binding for this record.

Suggested closing order (for `/gsd:plan-phase --gaps`, no action taken here): (a) done in 27778dee (registration before git in the installer); (b) owner decision on 5d, then either refuse a common git directory whose checkout is unregistered or record the decision; (c) owner decision on 6b; (d) refresh docs/worktree-fleet-api.md:159 and :163 (orchestrator).

---

_Verified: 2026-11-03T02:10:57Z_
_Verifier: Claude (gsd-verifier, R12Verify72)_
