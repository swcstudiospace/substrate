---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-03T03:04:39Z
status: gaps_found
score: 23/27 truth rows verified (2 present but behavior-unverified, 1 uncertain, 1 failed); success criteria 1 partial, 2 partial; HARD-S2 partial as amended
covered_files: [".planning/REQUIREMENTS.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-PLAN.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-SUMMARY.md", "docs/corpus-watch.md", "docs/worktree-fleet-api.md", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/scope.test.ts", "packages/cli/src/corpus/scope.ts", "packages/cli/src/corpus/watch-commands.ts", "packages/cli/src/index.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.test.ts", "packages/cli/src/worktree/scope.ts", "packages/collectors/src/install-git-hook.test.ts", "packages/collectors/src/install-git-hook.ts", "packages/corpus/src/discover.test.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/gitio.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/live-session-scope.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/repo-executor.test.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/repo-scope.reads-writes.test.ts", "packages/mcp-server/src/repo-scope.routes.test.ts", "packages/mcp-server/src/repo-scope.test.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-registry.ts"]
covered_digest: "v3:sha256:ef93799ac0a9c239e72dee6e0a41bf2574b43f8f309639fdda3343d7738c1a78"
behavior_unverified: 2
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: "21/26 (integration HEAD 27778dee, verified 2026-11-03T02:10:57Z)"
  gaps_closed:
    - "Truth 5d: a registered linked worktree's shared hooks are refused unless its primary checkout is registered (a28ecac8). Named test \"a linked worktree's shared hooks need its primary checkout registered\" (both tests) passes at 79b3ba32; probe P4 confirms it."
    - "Truth 6b, decision-6 cases: a checkout nested under a registered checkout that has its own .git, and a checkout nested under a registered worktrees directory, are refused by name with no git run (a28ecac8). Named tests pass (repo-executor.test.ts; discover.test.ts); probes P3 and P3b confirm it. The plain-directory case is split out as 6c."
  gaps_remaining:
    - "Truth 6c (new row, split from 6b): under a registered directory that has no .git of its own, an unregistered nested checkout is admitted and git runs in it (probe P1b). Owner decision 6 as recorded refuses nested checkouts under an admitted root. The implementer's commit asks the owner to confirm a container reading. Not decided here."
    - "Truth 11, corpus proof disclosure. Owner decision 1, open."
    - "Truth 3, allowlist unit (surface versus session). Owner decision 3, open."
    - "Truth 18, service-level live-session repository gate: still not exercised under scope."
    - "Truth 8, Postgres repos filter: orchestrator evidence only; not run at HEAD."
    - "HARD-S2 identifier clause, as amended: met when SUBSTRATE_REPO_SCOPES is set; not met when only SUBSTRATE_REPO_REGISTRY is set (probe P3). Open under the default-off posture."
    - "Scoping and corpus registry default-off posture. Open."
  regressions: []
  notes: "Re-verified at integration HEAD 79b3ba32 (gsd/v18-int-all). Commits since 27778dee: 80755acb (docs only), a28ecac8 (install-git-hook.ts, discover.ts, repo-scope.ts, repo-executor.ts and their tests), 79b3ba32 (REQUIREMENTS.md, ROADMAP.md and docs). Because repo-scope.ts changed, the carried 4600d2a2 evidence is not reused for rows that depend on it: those rows were re-exercised by the two test commands at HEAD (see Behavioral Spot-Checks). The row set grows from 26 to 27: row 6 is split into 6b (VERIFIED for the decision-6 cases) and 6c (FAILED)."
gaps:
  - truth: "Truth 6c: a nested checkout under a registered directory that has no .git of its own is checked as its own repository"
    status: failed
    reason: "With SUBSTRATE_REPO_REGISTRY set, nestedCheckoutBetween returns false when the registered checkout has no .git (repo-scope.ts:114), so an unregistered repository nested under that directory is admitted to the registration. discoverRepos reads it: git runs in it, it is reported as a checkout, and no note is written (probe P1b at 79b3ba32). Owner decision 6, as recorded, refuses nested checkouts under an admitted root. The implementer's commit a28ecac8 states this case as a container reading and asks the owner to confirm it."
    artifacts:
      - path: "packages/mcp-server/src/repo-scope.ts"
        issue: "nestedCheckoutBetween line 114 returns false for a checkout root with no .git, so any nested .git under it is admitted."
      - path: "packages/corpus/src/discover.ts"
        issue: "explore (209-219) refuses only reason nested-checkout; a container admits the nested checkout, and inspectCheckout then runs git in it."
    missing:
      - "Owner decision: either refuse a nested .git under a registered directory that has no .git (remove the line-114 carve-out, with named registry-set tests in discover.test.ts and repo-executor.test.ts), or record the container reading as an accepted exception. Not made here."
---

# Phase 72: Repo allowlist and scoped credentials Verification Report

**Phase Goal:** A session can address only the repositories on its allowlist, and each repository's credential is scoped to that repository.
**Verified:** 2026-11-03T03:04:39Z
**Status:** gaps_found
**Re-verification:** Yes. Integration tree gsd/v18-int-all at HEAD 79b3ba32. The prior record (gaps_found, 27778dee) is replaced.

**Evidence labels.** "Verified" means a command, a test run or a probe this verifier ran at HEAD 79b3ba32, or a read of code at that HEAD. "Orchestrator evidence" means a claim the orchestrator supplied, cited with its source and not re-run here. "[INFERENCE]" marks a conclusion not exercised by a test or probe.

**Criteria source:** `.planning/ROADMAP.md`, Phase 72 section (lines 1252-1263). The success-criteria text is unchanged from the 27778dee record.

Criteria (verbatim):
1. A repository outside the session's allowlist is refused at the API and the CLI before any git call runs.
2. A credential scoped to one repository cannot read another repository's worktrees or corpus.

**Requirement source:** `.planning/REQUIREMENTS.md:113` (HARD-S2), amended to the surface-bearer model (a147228f), with the identifier clause amended to a path gated to a registration (79b3ba32, owner decision 2026-11-03). The amended text is binding for this record.

**Owner decisions judged here (binding for this record, from the orchestrator):**

| Owner decision | Judgment at 79b3ba32 |
| -------------- | -------------------- |
| 5d: a linked worktree's shared hooks are refused without its primary checkout registered; nothing is written to the primary (a28ecac8) | ✓ CLOSED by code, named tests and probe P4 |
| 6b: a checkout nested under an admitted root is refused by name, with no git run for it (a28ecac8), for the decision-6 cases | ✓ CLOSED for a nested checkout under a registered checkout with its own `.git`, and under a registered worktrees directory. The plain-directory case is not closed: row 6c, FAILED |
| HARD-S2 identifier clause, amended to "a raw path gated to a registration" (79b3ba32) | PARTIAL as amended: met when `SUBSTRATE_REPO_SCOPES` is set; not met when only `SUBSTRATE_REPO_REGISTRY` is set (probe P3). The second configuration sits under the open default-off posture |
| Decision 1 (corpus proof disclosure) | OPEN, unchanged |
| Decision 3 (allowlist unit, surface or session) | OPEN, unchanged |
| Row 18 (service-level live-session gate under scope) | OPEN, unchanged; no test reaches it under scope |
| Scoping and corpus-registry default-off posture | OPEN, unchanged |

## Verdicts by criterion

| Criterion | Verdict |
| --------- | ------- |
| 1. API and CLI refuse before any git call | ⚠️ PARTIAL. VERIFIED for the REST drift door, the service gate, the MCP batch default deny, the MCP `coord_drift_scan` door, the live-session public routes (default deny), `substrate worktree`, and `substrate corpus` (gated commands, when `SUBSTRATE_REPO_REGISTRY` is set). The standalone installer refuses an unregistered repository before any git call under a registry (5b). Hook writes are gated on the resolved hooks directory (5c), and on the primary checkout of a linked worktree (5d, closed in a28ecac8). Nested checkouts under a registered checkout with `.git` and under a registered worktrees directory are refused before git (6b, closed in a28ecac8). Not met: a registered directory with no `.git` admits an unregistered nested checkout, and git runs in it (6c, FAILED). Default off when the registry is unset. |
| 2. Scoped credential cannot read another repository's worktrees or corpus | ⚠️ PARTIAL. VERIFIED for worktree lists (service and store filter), corpus plan, ingest, status, reconcile, ledger, graphs, docs, writes, reaper, memory and the public live-session routes. UNCERTAIN for the corpus proof disclosure (decision 1). The Postgres worktree filter is orchestrator evidence only (row 8). Row 6c: a local CLI read of an unregistered nested repository under a plain registration; [INFERENCE] the server door `authorizeRepoPath` would admit a path inside that repository for the registration's grant, which no test exercises. |

**HARD-S2 (REQUIREMENTS.md:113), against the amended text (binding for this record):**
- Repository access may be requested by path only where the path resolves to a registered repository; `POST /drift`, `substrate drift --path` and `--root` accept a raw path gated to a registration. **PARTIAL.** Under `SUBSTRATE_REPO_SCOPES` (enforced): `POST /drift` gates the path to a registration of a granted repository (service.ts:7647-7649; probe P3: `/etc` refused `path-not-registered`; a path inside a nested checkout refused `nested-checkout`). `substrate drift --path` sends the raw path to that gate (cli/src/index.ts:313-322), so it is gated server-side. `--root` is gated by the registry on the CLI (corpus/index.ts:175-198 `resolveRoots` and `localTargets`; corpus/scope.ts), whether or not scopes are set. Under `SUBSTRATE_REPO_REGISTRY` alone (scopes unset), `authorizeRepoPath` returns ok without consulting the registry (repo-scope.ts:299, `if (!scope.enforced) return ok`), so `POST /drift` and `substrate drift --path` accept an unregistered raw path (probe P3: `/etc` returns `{"ok":true}` with scopes unset). That configuration is part of the open default-off posture. Recorded as a WARNING, not a FAILED truth.
- Canonicalize paths; component-wise roots; traversal and symlink rejection, including after registration: MET for the gated doors (repo-scope.ts:124-126 `contains` with separator; 214-229 `resolveContained` realpath per call; 251-270 `locateRepoPath`; overlap refusal at parse, repo-scope.ts:162-168). Hook directories pass the same containment (install-git-hook.ts:121-125), and the linked-worktree common directory is now gated on the primary (126-135).
- Repository access granted per surface; every route and tool resolves the caller's surface and refuses an ungranted repository: MET (server.ts:965-970 REST default deny; server.ts:2748-2757 MCP batch default deny; route-policy.ts:21-79; repo-scope.ts:273-276 `isGranted`).
- Repo A credentials cannot authorize repo B: MET for the gated doors (surface bearer maps to one surface, config.ts:398-399, 981-1006; grants per surface, repo-scope.ts:273-276). A surface holding several grants is not "scoped to one repository"; D72-03 allows a single-grant surface.
- Argv-only git: MET for gated paths (repo-executor.ts:51 `spawnSync("git", [...args])`; corpus/src/discover.ts:30 and gitio.ts:36 argv; install-git-hook.ts:53, 67, 69, 80, 88 argv arrays).

**HARD-S2 against the original 23bd0733 text** ("Resolve least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B"): UNMET AS WRITTEN. No repository-specific credential reference exists in `packages/mcp-server/src`, `packages/cli/src` or `packages/fleet/src` (non-test). The credential is a surface bearer token. This is the owner-amended clause, so it is recorded here, not re-decided.

**Decision status:** Open and owner-held: (1) corpus proof disclosure; (3) allowlist unit (surface versus session); row 18 (service-level gate under scope); the identifier clause's registry-only configuration; the default-off posture of scoping and the corpus registry; decision 4 (the scope of "the CLI" for collectors' cwd reads); the nested-checkout reading for a registered directory with no `.git` (row 6c, decision 6). Recorded, not re-decided: (2) the credential model, as amended in a147228f and relayed by the orchestrator. Closed by a28ecac8 and judged here: the 5d linked-worktree refusal, and the 6b refusal for nested checkouts under a registered checkout with `.git` and under a registered worktrees directory.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| 1 | SC1 service: a drift scan naming an ungranted repository, or a path in another repository, is refused before any git call | ✓ VERIFIED | `scopedDriftScan` service.ts:7642. Repo gate 7644-7645; path gate 7647-7648, before the scan at 7649. Re-exercised at 79b3ba32: command 2 (repo-scope.routes.test.ts, repo-scope.boundary.test.ts) passes. Probe P3 (scopes set): unregistered path refused `path-not-registered`, nested path refused `nested-checkout`. |
| 2a | SC1 REST: `POST /drift` runs the gate before the scan | ✓ VERIFIED | server.ts:1585-1597 (audit with no git, then `scopedDriftScan`, then refusal). Route test passes (command 2). |
| 2b | SC1 MCP: `coord_drift_scan` refuses an ungranted repository before any git call | ✓ VERIFIED | Test "MCP coord_drift_scan ... boundary" in repo-scope.routes.test.ts passes (command 2): spies on `driftScan` and `Bun.spawnSync`; asserts `repo-not-granted`, zero scan calls, zero git argv calls. Caveat: the spies do not cover `node:child_process` (repo-executor.ts:51), which is not on this path. |
| 3 | SC1 API: every REST route or MCP tool with no declaration is refused to a scoped caller before its handler | ✓ VERIFIED | REST default deny server.ts:965-970; MCP batch default deny server.ts:2748-2757; declarations route-policy.ts:21-79. "default deny" tests pass (command 2). Decision 3 (allowlist unit) is open and is a human item, not a status change for this row. |
| 4 | SC1 CLI: `substrate worktree` refuses an ungranted root, `--repo`, provision target, merge-back or guard path before any git call, exit 2 | ✓ VERIFIED | `runWorktree` calls `scopeRefusal` at cli/src/worktree/command.ts:557 before the dispatch switch. `packages/cli/src/worktree/scope.test.ts` passes (command 1). |
| 5 | SC1 CLI: `substrate corpus` refuses an unregistered `--root`, `--repo` directory, or named `--repo` before any git call or hook write, when the registry is set | ✓ VERIFIED (gated commands; default off) | `runCorpus` calls `corpusScopeRefusal` (cli/src/corpus/index.ts:304-307) before any dispatch. `localTargets` (index.ts:184-198) covers `scan`, `plan`, `ingest`, `eval`, `reflect`, `sync`, `watch`, `reconcile`, and `hook` (resolved `--repo`). `resolveRoots` (175-178) takes roots from `--root`, `SUBSTRATE_CORPUS_ROOTS` or the default, so all roots are gated. `hint` writes a spool file and runs no git (documented). Command 1 corpus scope and index tests pass. |
| 5b | SC1 CLI: the standalone installer refuses an unregistered repository before any git call or hook write, under a registry | ✓ VERIFIED (default off, as row 5) | `inspect` (install-git-hook.ts:140) calls `locate` (111). `locate` reads the registry (112), applies the registration gate (115-118), and only then calls `hooksDir` (119), the first git call (`rev-parse --git-path hooks`, line 53). The refusal writes nothing (install-git-hook.ts:353-356). Named test "a registry is checked before any git call > with a registry set, an unregistered repository is refused without spawning git, and nothing is written" passes (command 1). |
| 5c | HARD-S2 path clause: a hook write stays inside a registered directory, including after `core.hooksPath` resolution | ✓ VERIFIED (core.hooksPath case) | `locate` 121-125: the resolved hooks directory must lie within `ownLocations(repo)` (65-76). Applied in `inspect`, `installCorpusHooks` and `uninstallCorpusHooks`. Named test "core.hooksPath under a repository registry > a hooks directory outside the registered repository is refused and nothing is written there; an in-repo one still installs" passes (command 1). |
| 5d | HARD-S2 path clause: a hook write from a registered linked worktree stays inside a registered directory | ✓ VERIFIED (closed by a28ecac8) | `locate` 126-135: when the hooks directory lies in the common git directory (`commonGitDir` 79-84), `primaryCheckout` (87-94) is resolved and must pass `localPathGate` for the local surface, else the write is refused with "primary checkout ... is not registered, and hooks directory ... is shared through it". The named tests "a linked worktree's shared hooks need its primary checkout registered" (refused: exit 1, nothing written to the primary; both registered: installs) pass (command 1). Probe P4 at 79b3ba32: linked-only registry, exit 1, "nothing was written", no hooks in the primary's `.git/hooks`; both registered, exit 0, hooks written to `primary/.git/hooks`. |
| 6 | SC1/SC2 path containment: `..`, symlinks and registered roots compared after realpath; overlapping registrations refused at boot | ✓ VERIFIED | repo-scope.ts:124-126 `contains`; 214-229 `resolveContained`; 251-270 `locateRepoPath`; overlap refusal at parse (`parseRepoRegistry`, 162-168). Re-exercised at 79b3ba32: repo-scope.test.ts (command 1) and the boundary symlink and dot-dot tests (command 2) pass. |
| 6b | SC1/SC2: a checkout nested under an admitted root, where the admitted root is a registered checkout with `.git` or a registered worktrees directory, is refused by name before git | ✓ VERIFIED (closed by a28ecac8 for the decision-6 cases) | `nestedCheckoutBetween` (repo-scope.ts:113-121) finds a `.git` strictly below a checkout, or below a worktrees directory other than a linked worktree directly in it. `locateRepoPath` (251-270) returns `nested-checkout`; the deepest registration wins, and a checkout beats a worktrees directory on a tie (the checkout loop runs first and the comparison is strict). Executor: `scopedGit` refuses before the runner, named test "a checkout nested under a registered checkout is refused by name before the runner is called, and the outer checkout still runs" passes (command 1). Discovery: `explore` (discover.ts:209-219) skips the nested checkout with a note and runs no git in it; named test "a standalone checkout inside a registered worktrees directory is skipped with a note that names it, runs no git, and the linked worktree beside it is still found" passes (command 1). Probe P3 (checkout with `.git`): nested path refused `nested-checkout`; probe P3b (worktrees directory): nested clone noted and not git-run, linked checkout found. A walk never enters a directory that holds `.git` (explore 209-218), so no discovery note appears under a checkout with `.git` (probe P2b). |
| 6c | SC1/SC2: a checkout nested under a registered directory that has no `.git` of its own is checked as its own repository | ✗ FAILED (BLOCKER; owner decision 6, reading open) | `nestedCheckoutBetween` line 114 returns false for a checkout root with no `.git`, so the nested checkout is admitted to the registration. Probe P1b at 79b3ba32, registry set: `plain/nested/lib` (an unregistered clone) is reported as a checkout of `owner/plain`, with no note; with no registry the result is the same. The only existing container test (discover.test.ts:276-278) runs with no registry, so no test covers the registry-set case. Commit a28ecac8 describes the refusal as applying "under a registered checkout that has no .git of its own" and also says "a plain registered directory with no .git is still a container of repositories"; the code follows the second statement. The implementer asks the owner to confirm the reading. Under the owner decision as recorded, the case is refused, so the row fails until the owner decides. [INFERENCE] `authorizeRepoPath` (repo-scope.ts:298-305) would accept a path inside such a nested repository for the registration's grant, and `scopedGit` (repo-executor.ts:72-78) would run git in it; neither is exercised. |
| 7 | SC2 worktrees, fake store: an unfiltered scoped list returns only granted rows; a named ungranted repository is refused before the read | ✓ VERIFIED | `listWorktrees` service.ts:5127-5135; fake filter worktree-registry-fake.ts:56. Re-exercised at 79b3ba32 by command 2 (repo-scope.reads-writes.test.ts, repo-scope.routes.test.ts) and passes. |
| 8 | SC2 worktrees, Postgres: the list query filters in SQL, and an empty list matches no row | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (ORCHESTRATOR EVIDENCE ONLY) | worktree-registry.ts:390 `repos` is a typed array; line 397 predicate `(${repos}::text[] is null or lower(repo) = any(${repos}::text[]))`. Last changed at 9ee12695; not changed by a28ecac8 or 79b3ba32. `SUBSTRATE_TEST_PG_URL` is unset, so `worktree-registry.pg.test.ts` skipped its 14 entries (command 2). Orchestrator evidence: `/root/src/worktrees/backups/t-r10c-pg-registry.log`, 12 pass, 0 fail, 12 tests across 1 file. The log is not tied to HEAD by its own content. Not run at HEAD. |
| 9 | SC2 corpus: plan, ingest and proof refuse an ungranted repository after parse and before any manifest or plane read | ✓ VERIFIED | `repoRefusalOf` corpus/service.ts:154-163; plan 177; ingest; proof before `deps.roots.read()`. Test "a proof for an ungranted repository is refused before the corpus manifest is read" passes (command 2). |
| 10 | SC2 corpus status, reconcile, root and anchor: refused to scoped callers | ✓ VERIFIED (status and reconcile via `allReposRefusal`; root and anchor via route default deny) | `allReposRefusal` corpus/service.ts:166-168. `/corpus/root` and `/corpus/anchor` have no REST_ROUTE_POLICY entry (route-policy.ts:21-79), so default deny applies (server.ts:965-970). Root and anchor are ungated by design for unscoped callers (D72-05). |
| 11 | SC2 corpus proof disclosure: a granted proof reveals no other repository's digests or corpus-wide counts | ? UNCERTAIN (decision 1, open) | Unchanged since 4600d2a2. Reply at corpus/service.ts:309-313 carries `root`, `treeSize`, `index`, `leaf`, `sha256` and the audit `path`. `inclusionOf` (mcp-server/src/corpus/root.ts:84-93) builds the proof over the whole-corpus tree, so sibling hashes and `root` commit to other repositories' `(repo, path, sha256)` (packages/corpus/src/leaf.ts:65-69). `index` and `treeSize` expose corpus-wide position and count. No document content is disclosed. Whether this is "reading another repository's corpus" is a policy reading. |
| 12 | SC2 ledger: a named ungranted repository is refused before the query; rows are filtered to the grant | ✓ VERIFIED | `queryEventsFor` service.ts:6657-6663; `rowsInGrant` (repo-scope.ts:360-363). Command 2 (repo-scope.reads-writes.test.ts) passes. |
| 13 | SC2 graphs: a graph's repository is read from its row and must be granted before content is read; no resolvable repository is refused | ✓ VERIFIED | `graphRepoOf` service.ts:6575-6582; `scopedGraphRefusal` 6586-6592. Command 2 passes. |
| 14 | SC2 docs: search and LightRAG query refused to every scoped surface before retrieval or fallback | ✓ VERIFIED | `scopedDocsRefusal` service.ts:6606; declared GATED at route-policy.ts:35-36. Command 2 passes. |
| 15 | SC2 writes: `events_emit`, `graph_register`, `handoff`, `POST /events` refuse an ungranted or absent target before the write | ✓ VERIFIED | `scopedWriteRefusal` service.ts:6615. Command 2 passes. |
| 16 | SC2 lease reaper: an unnamed reap touches only granted repositories; a named ungranted reap reaps nothing | ✓ VERIFIED | `reapExpiredLeases` service.ts:7377; named gate 7384-7389; unnamed reap targets `grantedRepos`. Command 2 passes. |
| 17 | SC2 live sessions, discovery: an unnamed discovery by a scoped caller is refused | ✓ VERIFIED | Gate `scopedRepoRefusal("live_session_discovery", ...)` at service.ts:2145, before `listVisible`. Command 2 passes. |
| 18 | SC2 live sessions, issue and transition: an ungranted `repo_id` is refused before `authority.issue` or `transition` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (the service-level gate; open) | Gate `authorizeRepo` at service.ts:2097-2101, before `authority.issue`/`transition` (2103). Unchanged. The public door refuses first: `live-session-scope.test.ts` asserts `not-declared-for-scope` for REST `POST /steering/sessions` and for MCP `docs_steering_session` issue and transition. That is default deny, not the repository gate. No test in the repository reaches service.ts:2097 under scope. Open. |
| 19 | SC2 memory search: a scoped caller receives only entries whose scope and own `repo` are both granted | ✓ VERIFIED | `memoryReplyInGrant` service.ts:6679-6700; derived hits filtered at 6698. Command 2 passes. The comment at route-policy.ts:51 ("derived hits are not yet filtered, RS-07") is stale. |
| 20 | SC2 memory verify: a scoped caller gets no verdict for an entry of an ungranted repository | ✓ VERIFIED | Gate `authorizeRepo` service.ts:4448-4455; reader grant at 4457-4458. Command 2 passes. |
| 21 | SC1/SC2 live sessions at the public routes: a scoped caller's live-session issue and transition are refused before any session is read or written | ✓ VERIFIED (by default deny; consequence below) | live-session-scope.test.ts (3 tests) passes (command 2). Live-session routes and `docs_steering_session` are undeclared for scope (route-policy.ts; absent from `MCP_TOOL_POLICY`), so every scoped caller is refused. Consequence: scoped surfaces cannot run live sessions at all. A product consequence, not a leak. |

**Score:** 23 of 27 truth rows verified. Two are present but behavior-unverified (8, 18). One is uncertain (11). One failed on evidence (6c). The prior count (21 of 26) is not directly comparable: row 6 is split into 6b and 6c.

### Deferred Items

None. Step 9b checked the later phases in the milestone. Phase 73 (ledger tamper evidence), phase 74 (HARD-R1 cross-repo compensating actions, goal and success criteria at ROADMAP.md:1282-1294), phases 75-78 do not name nested checkouts, discovery or the plain-directory reading. No gap is deferred.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/repo-scope.ts` | Pure gate, parsers, local gates, refusal payload, nested-checkout detection | ⚠️ PARTIAL | Gates 298-305 and 322-327; local gates; containment 124-126 and 214-229; nested detection 113-121 (line 114 is row 6c); locate 251-270. |
| `packages/mcp-server/src/repo-executor.ts` | `scopedGit` executor | ✓ VERIFIED (unit); NOT WIRED | Argv spawn at line 51 via `node:child_process`; `locate` 72-78 handles nested checkouts (row 6b). No production caller. Interface for Phase 74 per D72-07; the Phase 74 roadmap text does not name it. |
| `packages/cli/src/worktree/scope.ts` | CLI gate before git | ✓ VERIFIED | Dispatch call at command.ts:557. |
| `packages/cli/src/corpus/scope.ts` | Corpus CLI gate; cwd-git permit | ✓ VERIFIED (gated commands) | `corpusScopeRefusal` and `localGitPermitted`. Default off when the registry is unset. |
| `packages/cli/src/corpus/index.ts` | Targets per command, gate before dispatch | ✓ VERIFIED (gated commands) | `resolveRoots` 175-178; `localTargets` 184-198; gate 304-307. |
| `packages/cli/src/corpus/watch-commands.ts` | Hook command passes env and refuses `refused` | ✓ VERIFIED | `runHookCommand` passes the environment to the installer and returns exit 1 on `refused`. |
| `packages/cli/src/index.ts` | cwd git reads gated; `drift --path` sends a raw path | ⚠️ PARTIAL | `git()` gated by `localGitPermitted`. `drift --path` at 313-322 relies on the server gate (identifier clause, WARNING under registry-only). |
| `packages/collectors/src/install-git-hook.ts` | Corpus hook installer and standalone installer gated under the registry; registration before git; linked-worktree primary check | ✓ VERIFIED (default off, as row 5) | Registration before git 111-119; containment 121-125; linked-worktree primary 126-135 (row 5d closed); `commonGitDir` 79-84; `primaryCheckout` 87-94. |
| `packages/collectors/src/install-git-hook.test.ts` | Named hooks-path, ordering and linked-worktree tests | ✓ VERIFIED (command 1) | Named tests pass in command 1 (223 of 223 across its eight files, 0 fail). |
| `packages/corpus/src/discover.ts` | Nested-checkout refusal under a registry | ⚠️ PARTIAL | `explore` 209-219 refuses `nested-checkout` only; a registered directory with no `.git` admits a nested checkout (row 6c). |
| `packages/corpus/src/discover.test.ts` | Named nested-checkout test; existing container test | ✓ VERIFIED (command 1) | Named test at 312-313 (discover.test.ts "discoverRepos under a registry refuses a nested checkout") passes. The container test at 276-278 runs with no registry. |
| `packages/collectors/src/git-context.ts`, `muse.ts`, `cursor-stop.ts` | Collector git reads in the session cwd | ℹ️ NOT GATED (not caller-named) | Open under decision 4 if "the CLI" includes collectors. |
| `packages/mcp-server/src/route-policy.ts` | Default-deny declarations | ✓ VERIFIED | Corpus entries 28-32; drift 26; `coord_drift_scan` 66; worktrees 27. Stale comment at line 51. |
| `packages/mcp-server/src/service.ts` | Gates and filters | ✓ VERIFIED | 2097, 2145, 4448-4458, 5127-5135, 6563-6617, 6657-6698, 7377-7389, 7642-7649. |
| `packages/mcp-server/src/corpus/service.ts` | Corpus gates | ✓ VERIFIED | 154-168; proof reply 309-313 (decision 1). |
| `packages/mcp-server/src/worktree-registry.ts` | `repos` filter in SQL, typed array | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | 390 and 397 (last changed 9ee12695). See row 8. |
| `packages/mcp-server/src/config.ts` | `repoScope` from env; boot refusal on malformed values | ✓ VERIFIED | `repoScopeOrRefuse` 961-965 (`repoScopeFromEnv`, which returns enforced false when `SUBSTRATE_REPO_SCOPES` is unset). |
| `docs/worktree-fleet-api.md` | Both flags documented; credential model; gaps | ⚠️ STALE | Line 159 still lists 5d and 6b as open, and does not describe the linked-worktree primary rule or the nested-checkout rule. Line 163 (credential model) is an open decision. Reported for the orchestrator to fix; not edited here. |
| `docs/corpus-watch.md` | Exit codes for hook commands | ✓ VERIFIED | Lines 194-195 name the registry refusal for `hook install|uninstall`. |
| `.planning/REQUIREMENTS.md` HARD-S2 | Requirement text | ✓ AMENDED (79b3ba32), partial as amended | Line 113 carries the identifier clause amended to a registration-gated path. Table line 134 still reads "Not started" (stale). |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| server.ts `POST /drift` | `scopedDriftScan` | server.ts:1586 | ✓ WIRED | Exercised by the routes test (command 2). |
| mcp.ts `coord_drift_scan` | `scopedDriftScan` | mcp.ts | ✓ WIRED | Exercised under scope by the new test (2b). |
| server.ts `GET /worktrees` | `listWorktrees(query, surface)` | server.ts | ✓ WIRED | Exercised by the routes test. |
| mcp.ts `worktree_list` | `listWorktrees(query, callerSurface)` | mcp.ts | ✓ WIRED (code) | Not separately exercised. |
| `runWorktree` | `scopeRefusal` | command.ts:557 | ✓ WIRED | Exercised by CLI tests (command 1). |
| `runCorpus` | `corpusScopeRefusal` | corpus/index.ts:304 | ✓ WIRED | Exercised by corpus scope tests (command 1). |
| `runHookCommand` | `installCorpusHooks` / `uninstallCorpusHooks` with registry env | watch-commands.ts | ✓ WIRED | `locate` reads the same env. |
| top-level `git()` | `localGitPermitted` | cli/src/index.ts:127-130 | ✓ WIRED | Unit-tested by corpus/scope.test.ts (command 1). |
| `memoryReplyInGrant` | per-entry repo grant | service.ts:6679-6698 | ✓ WIRED | Exercised by reads-writes test. |
| `updateLiveSession` | `authorizeRepo` before issue or transition | service.ts:2097 | ✓ WIRED (code) | NOT reachable for scoped callers through the public routes (default deny first); not exercised under scope (row 18). |
| `installCorpusHooks` | registry gate on the resolved hooks dir and the primary checkout | install-git-hook.ts:121-135 | ✓ WIRED | Covers `core.hooksPath` (5c) and linked worktrees (5d). |
| standalone installer `main()` | registration gate before git | install-git-hook.ts:372 → 318 → 111-119 | ✓ WIRED | Registration (115-118) precedes the first git call (119). Tested by the ordering test (command 1) and probe P4. |
| `discoverRepos` | nested-checkout refusal | discover.ts:209-219 → repo-scope.ts:251-270 | ✓ WIRED | Refuses only under a registered worktrees directory or a registered checkout with `.git`; not under a registered directory with no `.git` (row 6c). |
| `scopedGit` | production git call sites | repo-executor.ts | ✗ NOT_WIRED | No production caller. Not a stated Phase 72 criterion; a WARNING. |

### Data-Flow Trace (Level 4)

Not applicable. The phase adds gates and filters, not rendered output.

### Behavioral Spot-Checks

Commands run from `/root/src/worktrees/as-gsd-v18-all` at HEAD 79b3ba32, with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun --no-env-file test`. No test was added or edited. No database was started. No formatter, tsc, lint or full suite was run. Two test commands were used.

| Behavior | Command (files) | Result | Status |
| -------- | --------------- | ------ | ------ |
| Installer ordering, hooks path, linked-worktree primary, nested-checkout executor and discovery, corpus and worktree CLI scope, repo-scope unit (command 1) | `packages/collectors/src/install-git-hook.test.ts packages/corpus/src/discover.test.ts packages/mcp-server/src/repo-executor.test.ts packages/mcp-server/src/repo-scope.test.ts packages/cli/src/corpus/scope.test.ts packages/cli/src/worktree/scope.test.ts packages/cli/src/corpus/watch-commands.test.ts packages/cli/src/corpus/index.test.ts` | 223 pass, 0 fail, 787 expect() calls, 8 files. JUnit at `/tmp/r13probe/cmd1.xml` shows 0 failure elements and names each of the named tests above. | ✓ PASS |
| MCP scope routes, live-session scope, boundary, reads-writes, worktree registry (command 2) | `packages/mcp-server/src/repo-scope.routes.test.ts packages/mcp-server/src/live-session-scope.test.ts packages/mcp-server/src/repo-scope.boundary.test.ts packages/mcp-server/src/repo-scope.reads-writes.test.ts packages/mcp-server/src/worktree-registry.test.ts packages/mcp-server/src/worktree-registry.http.test.ts packages/mcp-server/src/worktree-registry.pg.test.ts` | 204 pass, 14 skip, 0 fail, 574 expect() calls, 7 files (218 tests). All 14 skips are in worktree-registry.pg.test.ts (`SUBSTRATE_TEST_PG_URL` unset). The JUnit file was not written by this run; the console summary is the evidence. | ✓ PASS |
| Installer refuses an unregistered primary of a linked worktree; installs when both are registered (probe P4) | `bun packages/collectors/src/install-git-hook.ts --corpus <linked>` with `SUBSTRATE_REPO_REGISTRY` listing only the linked worktree, then listing both; scratch repositories under `/root/src/worktrees/backups/gate-tmpfs` | Linked-only: exit 1, "refused: primary checkout ... is not registered ...; nothing was written"; primary `.git/hooks` has no hooks. Both registered: exit 0, four corpus hooks and post-commit in primary `.git/hooks`. | ✓ PROBED (not a test) |
| Discovery: plain registered directory with no `.git` admits an unregistered nested clone (probe P1b) | `discoverRepos([plain], { env: { SUBSTRATE_REPO_REGISTRY: {"owner/plain": {checkouts: [plain]}} } })`, nested clone at `plain/nested/lib` | Result: `plain/nested/lib` reported as a checkout; notes empty. With no registry: same result. | ✓ PROBED (not a test); row 6c FAILED |
| Discovery: checkout with `.git` (probe P2b) | registry lists `c2`; nested clone at `c2/nested/lib` | Result: only `c2`; notes empty (discovery does not enter a directory that holds `.git`). | ✓ PROBED (not a test) |
| Discovery: nested clone under a registered worktrees directory (probe P3b) | registry: checkout `outer/checkout`, worktrees `outer/worktrees`; clone at `outer/worktrees/clone` | Result: `outer/checkout` only; note names `outer/worktrees/clone` as refused, no git run in it. | ✓ PROBED (not a test) |
| Server path gate with and without scopes (probe P3) | `repoScopeFromEnv` with registry only and with registry plus scopes; `authorizeRepoPath` on `/etc` and on a nested clone | Registry only: `enforced: false`; `/etc` → `{"ok":true}`. Scopes set (surface `omp`): `/etc` → `path-not-registered`; nested clone → `nested-checkout`. | ✓ PROBED (not a test); identifier clause WARNING under registry-only |
| Service-level live-session gate under scope (row 18) | no test reaches service.ts:2097 under scope | n/a | ? SKIP (open) |

Probe execution: no probes declared in the PLAN or SUMMARY. The probes above are fact checks by this verifier, not probes in the Step 7c sense. Scratch files live under `/tmp/r13probe` and `/root/src/worktrees/backups/gate-tmpfs/r13-probe*`, outside the repository, and were not committed.

Debt-marker gate: `git show a28ecac8` adds no TODO, FIXME, XXX or HACK in the diff of the four code files (checked by reading the diff; the nested-checkout and linked-worktree additions carry explanatory comments only).

Fingerprint: `node /root/.agents/gsd-core/bin/gsd-tools.cjs query verification.fingerprint .planning/phases/72-repo-allowlist-and-scoped-credentials` with the 33 files of the prior record plus `packages/corpus/src/discover.test.ts` (changed by a28ecac8), run at HEAD 79b3ba32. `covered_files` and `covered_digest` are copied from its output.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-S2 (amended, 79b3ba32) | 72-01-PLAN.md | Identifier addressing by a path gated to a registration; canonical paths; traversal and symlink rejection; per-surface grants; no repository-specific credential reference required; argv-only git | ⚠️ PARTIAL | Containment, grants and argv MET for gated doors (rows 1-7, 9-17, 19-21). Hook directories: `core.hooksPath` (5c) and linked-worktree primary (5d) MET. Nested: decision-6 cases MET (6b); plain-directory case FAILED (6c). Identifier clause: met when scopes are set; not met under registry-only (probe P3; WARNING). |
| HARD-S2 (original, 23bd0733) | 72-01-PLAN.md | Same, plus "resolve least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B" | ✗ UNMET AS WRITTEN | No repository-specific credential reference (config.ts:398-399, 981-1006; repo-scope.ts:273-276). |

No orphaned requirements: HARD-S2 is the only phase-72 mapping in REQUIREMENTS.md.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| packages/mcp-server/src/repo-scope.ts | 114 | `nestedCheckoutBetween` returns false when the registered checkout has no `.git`, so a nested unregistered checkout under a plain registered directory is admitted. | ⚠️ Warning (BLOCKER via row 6c) | Local read of an unregistered repository under a registration. |
| packages/corpus/src/discover.test.ts | 276-278 | The only container test runs with no registry; no test covers a registry-set plain directory. | ⚠️ Warning | The registry-set container reading is untested. |
| git log a28ecac8 (commit message) | body | Says nested refusal applies "under a registered checkout that has no .git of its own" and, in the next sentence, that "a plain registered directory with no .git is still a container". The code follows the second sentence and its own comment. | ℹ️ Info | The commit message is internally inconsistent; the owner confirmation it requests is row 6c. |
| packages/mcp-server/src/repo-executor.ts | 13 | Comment: "Phase 74 calls this entry point". No caller exists; Phase 74 text does not name it. | ⚠️ Warning | Carried forward. |
| packages/mcp-server/src/service.ts | 7647-7649 | `authorizeRepoPath` returns ok when `!scope.enforced` (repo-scope.ts:299), so with only `SUBSTRATE_REPO_REGISTRY` set, `POST /drift` accepts an unregistered raw path. | ⚠️ Warning | Identifier clause not met in the registry-only configuration (default-off posture; open). |
| packages/cli/src/index.ts | 313-322 | `substrate drift --path` sends a raw path to the server; no local registration gate. | ⚠️ Warning | Gated only when `SUBSTRATE_REPO_SCOPES` is set on the server. |
| docs/worktree-fleet-api.md | 159 | Still lists 5d and 6b as open and omits the linked-worktree and nested-checkout rules. | ⚠️ Warning | Doc must match the code; reported for the orchestrator. |
| packages/mcp-server/src/route-policy.ts | 51 | Comment: memory_search "derived hits are not yet filtered, RS-07". Code filters them (service.ts:6698). | ℹ️ Info | Stale comment contradicts the code. |
| packages/mcp-server/src/live-session-scope.test.ts | 52 | Test name says "refused before the session authority is read"; the refusal is default deny (`not-declared-for-scope`), not the repository gate. | ℹ️ Info | The name overstates the mechanism. Row 18 remains open. |
| packages/mcp-server/src/repo-scope.routes.test.ts | 404-422 | The coord_drift_scan test spies `Bun.spawnSync` and `driftScan`, not `node:child_process`. | ℹ️ Info | Adequate for the drift path; not a general no-git proof. |
| packages/mcp-server/src/service.ts | 281-292, ~320 | `corpusRootReply` and `corpusAnchorReply` have no repository gate; protection is the route default deny only. | ℹ️ Info | Fail-closed today. |
| packages/mcp-server/src/server.ts | 2336, 2365 | `/worktrees/report` and `/worktrees/claims` default-denied to scoped surfaces. | ⚠️ Warning | Intended fail-closed; operator consequence. |
| packages/cli/src/corpus/watch-commands.ts | hint path | `corpus hint` writes a spool entry for an unregistered path with no git call. | ℹ️ Info | The watch loop ignores hints outside its roots. Not gated at the CLI. |
| packages/mcp-server/src/planning/observer.ts | 370, 615 | Background git reads on the operator-configured planning root. | ℹ️ Info | Not on a request path. |
| .planning/ROADMAP.md | 1256 | Phase 72 status line still lists 5d and 6b as open and says 21 of 26. | ℹ️ Info | Orchestrator document; stale. |
| .planning/REQUIREMENTS.md | 134 | HARD-S2 status "Not started". | ℹ️ Info | Orchestrator document; stale. |
| packages/mcp-server/src/cache.test.ts; planning/observer.test.ts | 1630; 1 | Test time budgets raised (4600d2a2, 48fb961c). | ℹ️ Info | Not phase 72; not judged. |

### Advisory (New Scope, Unevidenced)

None. The changes since 27778dee (a28ecac8) are judged under rows 5d, 6b and 6c with test or probe evidence.

### Warnings (not roadmap criteria)

- **Scoping is off by default.** Criteria 1 and 2 hold only when `SUBSTRATE_REPO_SCOPES` is set (repo-scope.ts:9-11; config.ts:961-965). PLAN D72-02 said "with a boot warning"; none exists.
- **The corpus CLI gate and the standalone installer gate are off by default.** They hold only when `SUBSTRATE_REPO_REGISTRY` is set (cli/src/corpus/scope.ts; install-git-hook.ts:93 `localRegistryScope` returns null when unset).
- **Registry-only configuration.** With `SUBSTRATE_REPO_REGISTRY` set and `SUBSTRATE_REPO_SCOPES` unset, the corpus CLI, the installer and discovery are gated, but the server's `POST /drift` and `drift --path` are not gated to a registration (probe P3).
- **Live sessions are unusable by scoped surfaces.** Consequence of row 21's default deny (a product consequence; no leak).
- **Allowlist unit.** Criterion 1 says "the session's allowlist". Grants are per surface (repo-scope.ts:273-276). Decision 3.
- **Operational prerequisite (PLAN D72-06).** Under scoping, every `SUBSTRATE_WORKTREE_ROOTS` entry must be registered, or every `substrate worktree` command exits 2.
- **Executor not wired.** `scopedGit` has no production caller; Phase 74 does not name it (row list above).

### Human Verification Required

1. **Row 6c, the nested checkout under a registered directory with no `.git` (decision 6).** Decide whether such a directory is a container whose nested repositories are admitted (then record it as an accepted exception, and the row becomes VERIFIED on re-verification), or whether a nested `.git` under any admitted root must be refused (then remove the carve-out at repo-scope.ts:114 and add named registry-set tests in discover.test.ts and repo-executor.test.ts). **Why human:** the owner decision text and the implementer's reading differ; the commit asks the owner to confirm. The probe is P1b.
2. **Decision 1, corpus proof disclosure (row 11).** Decide whether a granted caller receiving `root`, `treeSize`, `index` and the audit path counts as reading another repository's corpus. Options: accept as allowed, rebuild per repository, or withhold foreign siblings, index and treeSize. **Why human:** policy reading of "read".
3. **Decision 3, allowlist unit (criterion 1).** Confirm the surface, not the session, is the intended allowlist unit. **Why human:** design decision.
4. **Row 18, service-level live-session gate.** Add a test that reaches service.ts:2097 under scope, or accept the route-level default deny as the criterion's evidence. **Why human:** test-design choice; also a product consequence.
5. **Identifier clause, registry-only configuration.** Decide whether `POST /drift` and `substrate drift --path` must gate on the registry when scopes are unset. Currently they do not (probe P3). **Why human:** owner-held requirement reading and default-off posture.
6. **Scoping and corpus registry defaults.** Decide whether default-off is acceptable for a deployment that claims criteria 1 and 2. **Why human:** deployment posture decision.
7. **Decision 4, scope of "the CLI" (collectors).** Decide whether `packages/collectors/src/git-context.ts`, `muse.ts` and `cursor-stop.ts` cwd reads are inside criterion 1. **Why human:** scope of "the CLI".
8. **Owner confirmation of 5d's form.** a28ecac8 refuses an unregistered primary rather than letting a registration of the linked worktree cover it. The owner's first option (registration covers the primary) was not taken. Confirm the refusal form. **Why human:** registry-model choice.
9. **Postgres worktree filter (row 8).** Run `worktree-registry.pg.test.ts` against a database at HEAD 79b3ba32 and record the commit with the run. **Why human:** database not started here.

### Gaps Summary

Status is `gaps_found` by the decision tree's first rule: one truth FAILED on evidence (6c). It is the only blocking item in this record.

- **Criterion 1 (partial).** The API doors and the `substrate worktree` and `substrate corpus` CLIs refuse before git when their variables are set. The installer checks the registration before any git call and before any write under a registry (5b). Hook writes are gated on the resolved hooks directory (5c), and on the primary checkout of a linked worktree (5d, closed in a28ecac8). Nested checkouts are refused by name under a registered checkout with `.git` and under a registered worktrees directory (6b, closed in a28ecac8). Not met: a registered directory with no `.git` admits an unregistered nested checkout, and git runs in it (6c, FAILED).
- **Criterion 2 (partial).** Worktrees, corpus, ledger, graphs, docs, writes, reaper, memory and live-session routes are verified. The corpus proof disclosure is open (decision 1). The Postgres worktree filter has orchestrator evidence only. The local read under a plain registration (6c) is a leak of the local CLI's reads; the server-side gates would attribute a path inside such a repository to that registration's grant [INFERENCE].
- **HARD-S2 (partial, amended text).** Containment, grants and argv hold for the gated doors. The identifier clause holds when scopes are set and not under registry-only (probe P3). Hook-directory containment holds for `core.hooksPath` (5c), for the installer's ordering (5b) and for the linked-worktree primary (5d). Nested checkouts are refused for the decision-6 cases (6b) and not for a plain registered directory (6c).
- **HARD-S2 (original text).** Unmet as written: no repository-specific credential reference exists. Recorded, not re-decided, since the owner amendment is binding for this record.

Suggested closing order (for `/gsd:plan-phase --gaps`, no action taken here): (a) owner decision on 6c (accept the container reading as a recorded exception, or refuse nested `.git` under a plain registered directory with named tests); (b) decision 1 and decision 3; (c) row 18 test or acceptance; (d) the identifier clause posture under registry-only; (e) refresh docs/worktree-fleet-api.md lines 159 and 163, ROADMAP.md line 1256 and REQUIREMENTS.md line 134 (orchestrator).

Not touched here: a peer's uncommitted change to `.planning/phases/76-telemetry-buffer-and-dead-letter/76-VERIFICATION.md` in the same worktree.

---

_Verified: 2026-11-03T03:04:39Z_
_Verifier: Claude (gsd-verifier, R13Verify72)_
