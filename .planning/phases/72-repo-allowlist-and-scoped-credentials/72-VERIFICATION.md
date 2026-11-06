---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-06
status: human_needed
score: "26/27 truth rows verified (row 11 uncertain); criterion 1 verified under scoping with open decisions 3 and 4; criterion 2 partial (row 11, decision 1); scoping is off unless configured (code posture, not an owner decision); scoped git executor NOT_WIRED, refusal behaviour unchanged"
covered_files: [".env.example", ".planning/REQUIREMENTS.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-PLAN.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-SUMMARY.md", "docs/config-reference.md", "docs/corpus-watch.md", "docs/worktree-fleet-api.md", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/scope.test.ts", "packages/cli/src/corpus/scope.ts", "packages/cli/src/corpus/watch-commands.ts", "packages/cli/src/index.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.test.ts", "packages/cli/src/worktree/scope.ts", "packages/collectors/src/install-git-hook.test.ts", "packages/collectors/src/install-git-hook.ts", "packages/corpus/src/discover.test.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/gitio.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/live-session-scope.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/memory-policy.test.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/repo-executor.test.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/repo-scope.reads-writes.test.ts", "packages/mcp-server/src/repo-scope.routes.test.ts", "packages/mcp-server/src/repo-scope.test.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-registry.pg.test.ts", "packages/mcp-server/src/worktree-registry.ts"]
covered_digest: "v3:sha256:d4762a676cb30dc74c82d7c00a0244fa142519f2ccd0dcf2c481c2353b345dbf"
behavior_unverified: 0
overrides_applied: 0
gaps: []
regressions_closed:
  - "Row 8 (Postgres worktree list filter) evidenced by gate r38 (run on 66fa97bd): the title 'a listing with a repos filter returns only the rows of the listed repositories, and an empty list returns none' passes in class 'the worktree registry against a live index'. Earlier evidence: gate r33 at 6e5d766e; scratch Postgres 16 at 42e3cf13. No Postgres was started for this record."
re_verification:
  previous_status: human_needed
  previous_score: "26/27 (verified at a46d42c3, 2026-11-06T00:44:18Z)"
  gaps_closed: []
  gaps_remaining:
    - "Row 11, corpus proof disclosure. Decision 1, open. Human item."
    - "Row 3 / criterion 1, allowlist unit (surface versus session). Decision 3, open. Human item."
    - "Decision 4, scope of 'the CLI' for collector cwd reads (git-context.ts, muse.ts, cursor-stop.ts). Open. Human item."
    - "Row 19 legacy-row repair (rewrite or leave unmatched). Open. Human item."
  regressions: []
human_verification:
  - test: "Row 11, decision 1: corpus proof disclosure. Decide whether a granted caller receiving root, treeSize, index and the audit path counts as reading another repository's corpus. Options: accept as allowed, rebuild per repository, or withhold foreign siblings, index and treeSize."
    expected: "A recorded owner decision on whether the proof reply is inside criterion 2."
    why_human: "A policy reading of 'read'. No owner decision exists for this phase (2026-11-06 scope note)."
  - test: "Decision 3, allowlist unit (criterion 1). Confirm the surface, not the session, is the intended allowlist unit."
    expected: "A recorded owner decision."
    why_human: "Design decision. Open."
  - test: "Decision 4, scope of 'the CLI' (collectors). Decide whether packages/collectors/src/git-context.ts, muse.ts and cursor-stop.ts cwd reads are inside criterion 1."
    expected: "A recorded owner decision."
    why_human: "Scope of 'the CLI'. Open."
  - test: "Row 19 repair of legacy rows. The gate is correct for legacy rows; the owner decides whether legacy rows with a dangling surrogate in repo are repaired or left unmatched."
    expected: "A recorded owner decision."
    why_human: "Data decision. Open."
---

# Phase 72: Repo allowlist and scoped credentials Verification Report

**Phase Goal:** A session can address only the repositories on its allowlist, and each repository's credential is scoped to that repository.
**Verified:** 2026-11-06
**Status:** human_needed
**Re-verification:** Yes. Code head 5e304ef8 (worktree `gsd/v18-int-all`). The prior record (human_needed, a46d42c3) is replaced. This record re-audits every covered-file hunk between a46d42c3 and 5e304ef8 (14 commits) and re-locates each gate at the new head.

**Evidence labels.** "Observed" means a command or search run by this verifier at 5e304ef8 (read-only git, grep, read, and the `gsd_run query verification.fingerprint` query). "JUnit" means a named testcase in gate r38 (`/root/src/worktrees/backups/gate-r38-junit.xml`, run on 66fa97bd). "[INFERENCE]" marks a conclusion no test exercised. No test, tsc, lint, Postgres or Docker was run for this record.

**Test evidence.** Test titles only. Source of truth for pass or fail: gate r38 JUnit. Its one failing testcase is the repository ratchet (`ratchet is tight`, `as_unknown_as` at 22 against a baseline of 23); it is not a phase 72 testcase and is fixed at the code head (5e304ef8 lowers the baseline). Its two skipped testcases (`redact.test.ts` D-04 and the live-Redis `cache-conformance` case) are not phase 72 testcases. A second run, r39, on the current head is in progress and writes `/root/src/worktrees/backups/gate-r39-junit.xml`; that file was absent when this draft was written. No pass count is claimed here. Every title below was grepped in source at 5e304ef8 and matched in the r38 JUnit with status pass. Two titles (the corpus route titles) are generated by a template literal, see row 10.

**Criteria source:** `.planning/ROADMAP.md`, Phase 72 section. The success-criteria text is unchanged.
Criteria (verbatim):
1. A repository outside the session's allowlist is refused at the API and the CLI before any git call runs.
2. A credential scoped to one repository cannot read another repository's worktrees or corpus.

**Requirement source:** `.planning/REQUIREMENTS.md` HARD-S2 (line 113). Its text is not in any hunk changed since a46d42c3 (`git diff -U0 a46d42c3 5e304ef8 -- .planning/REQUIREMENTS.md` changes only lines 58-63, 99, 133 and 139: FLEET checkboxes and status-table rows for phases 68, 71 and 77).

**Scoping posture.** Scoping is off unless `SUBSTRATE_REPO_SCOPES` or `SUBSTRATE_REPO_REGISTRY` is set (config.ts `repoScopeOrRefuse`, lines 975-976; `localRegistryScope`, repo-scope.ts:306). Criteria 1 and 2 hold only when scoping is configured. This is the code's current posture. It is not recorded here as an owner decision: the 2026-11-06 owner decisions cover phases 67, 74 and 75 only, so no owner decision exists for phase 72.

**Open owner items (not decided here).** Decision 1 (corpus proof disclosure, row 11), decision 3 (allowlist unit: surface or session), decision 4 (scope of "the CLI" for collector cwd reads), and the row 19 legacy-row repair. Each stays open. No `overrides:` entry exists for this phase, and none is written here.

**Question asked of this re-verification.** Do the scoped refusals still hold at 5e304ef8? Is the scoped git path still not wired, and is its refusal behaviour unchanged? Are rows 8 and 18 still evidenced at the head?

**Answer.** Yes on the first two. Every gate cited in the truth table is present at 5e304ef8, at the line given. Lines shifted only where a check or an import was added above them: +5 after server.ts:1507 (the new `/handoff` `to` check), +1 in repo-scope.ts at 104 and 233, +1 in mcp-server index.ts at 50, +1 in worktree-registry.ts at 453. Each is re-located below. Each gate body is unchanged in order relative to its read or write. The covered-file hunks changed since a46d42c3 are: the new REST `/handoff` refusal of a `to` outside SURFACES (400, before any write, ahead of the existing write gate), `reportSilent` in a shutdown catch, comments, the CLI `handoff` exit status, a `manifestCommit` dependency type from phase 63, and removals of `export` keywords. No grant, refusal reason or gate order changed. The scoped git executor is still not wired: `scopedGit` has no production caller, and its body is unchanged. Row 8 is evidenced by r38. Row 18 remains VERIFIED. Row 11 remains uncertain. Decisions 1, 3 and 4, and the row 19 repair, remain open.

## Changes since a46d42c3 (audited at 5e304ef8)

Covered files that changed (`git diff --numstat a46d42c3 5e304ef8` over the 42 covered files in the frontmatter). Each file's diff was filtered by stripping `export ` from each removed and added line; only the hunks below differ in more than the keyword.

| File | Commit(s) | Effect on phase 72 |
| ---- | --------- | ------------------ |
| `packages/mcp-server/src/server.ts` | 14ac787a | `/handoff`: a `to` that is not a string in SURFACES is answered 400 at lines 1508-1511, before `rememberClaim` (1512), the surface-claim check, the audit (1522) and the write gate (1560). It writes nothing. The write gate itself is unchanged. Net shift: +5 lines for every line after 1507. The null-body 400s on `/drift`, `/evidence` and `/verify` were already present at a46d42c3 (carried, not changed in this range). |
| `packages/cli/src/index.ts` | 14ac787a | `cmdHandoff` returns an exit status: 1 when the server refuses (stderr names the refusal), 0 when it cannot be reached. The command dispatch (switch at 681) changes for `handoff` only. `runWorktree` and `runCorpus` dispatch is unchanged. Not a phase 72 gate. |
| `packages/mcp-server/src/service.ts` | 0947001e | Gate bodies unchanged; no line count change. `manifestCommit` (6421) now returns the row, not `.commit`, per 0947001e (phase 63, docs citations); not a refusal and not a phase 72 gate. |
| `packages/mcp-server/src/repo-scope.ts` | e62bc17b | Two comment lines (at 104 and 233). No code change. Shifts `nestedCheckoutBetween` to 114, `resolveContained` to 212, `locateRepoPath` to 249, `isGranted` to 266. |
| `packages/mcp-server/src/worktree-registry.ts` | e62bc17b | One comment line at 453. The SQL predicate stays at 401. |
| `packages/mcp-server/src/index.ts` | e62bc17b | `reportSilent` import (50) and the shutdown exporter-flush catch (273). Not a gate. Shifts `RepoScopesRequiredError` refusal to 66. |
| `packages/mcp-server/src/mcp.ts`, `corpus/root.ts`, `corpus/service.ts`, `route-policy.ts`, `config.ts`, `flag-registry.ts`, `repo-executor.ts`, `packages/cli/src/corpus/*`, `packages/cli/src/worktree/command.ts`, `packages/collectors/src/install-git-hook.ts`, `packages/corpus/src/discover.ts`, `gitio.ts` | b8cbdeac, d9d0a401, 4c576e5e, 8ec17832, 66fa97bd, 5e304ef8 (none of these had a non-keyword hunk) | `export` keyword removals only. `config.ts` also loses `export` on `DEFAULT_LIGHTRAG_PLANNING_ROOTS` (5e304ef8). No line count change in these files. |
| `.planning/REQUIREMENTS.md` | not attributed | Checkbox and status-table rows only (lines 58-63, 99, 133, 139). HARD-S2 text (line 113) unchanged. |

Covered files that did not change in this range: `repo-scope.boundary.test.ts`, `repo-scope.routes.test.ts`, `repo-scope.reads-writes.test.ts`, `repo-scope.test.ts`, `repo-executor.test.ts`, `live-session-scope.test.ts`, `config.test.ts`, `memory-policy.ts`, `memory-policy.test.ts`, `worktree-registry.pg.test.ts`, `cli/src/worktree/scope.ts`, `cli/src/corpus/scope.ts`, `cli/src/corpus/scope.test.ts`, `cli/src/worktree/scope.test.ts`, `collectors/src/install-git-hook.test.ts`, `corpus/src/discover.test.ts`. Changes outside the covered list that matter here: none. `cache.ts` (f1266a9c, connect cooldown), `memory-retain.ts` and `index-sweep.ts` (a2176f96, retainDocumentId), and the silent-failure sites of e62bc17b outside the covered files are not phase 72 files and are not cited.

Covered digest. `gsd_run query verification.fingerprint` at 5e304ef8 over the phase directory and the 42 files above (the 39 files of the prior record plus `memory-policy.ts`, `memory-policy.test.ts` and `worktree-registry.pg.test.ts`, which the cited titles need) returns `v3:sha256:d4762a676cb30dc74c82d7c00a0244fa142519f2ccd0dcf2c481c2353b345dbf`. The frontmatter carries the returned list and digest verbatim.

## Scoped git executor (the NOT_WIRED item)

Question: is `scopedGit` still not wired, and is its refusal behaviour unchanged?

- **Not wired (Observed).** `git grep -n "scopedGit\|defaultScopedGitRunner\|repo-executor\|ScopedGitRunner" 5e304ef8 -- ':!.planning'` finds one importer of `repo-executor.ts`: `packages/mcp-server/src/repo-executor.test.ts:5`. No production module imports it. `defaultScopedGitRunner` and the `spawnSync` import are gone (removed in a46d42c3); `repo-executor.ts` contains no spawn.
- **Refusal behaviour unchanged (Observed + JUnit).** `scopedGit` (repo-executor.ts:74-84) is unchanged since a46d42c3. Its refusals return before `run` is called: `repo-not-registered` (76), `repo-not-granted` (80), `path-repo-mismatch` (81), and the `locate` refusals (60-66). The r38 titles in "scopedGit refusals run no git" pass (see row list).
- **Warning: the runner is still an injected function, and nothing supplies a real one.** `ScopedGitRunner` (repo-executor.ts:26) is the only spawn seam. The removed default runner had set `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=true`; no code applies them to the executor now. `scopedGit` passes `GIT_CEILING_DIRECTORIES` in `env` (line 82). Whichever phase wires the path must supply a runner that applies the three settings.
- **Warning: the header still names a caller that does not exist.** `repo-executor.ts:13` says "Phase 74 calls this entry point for cross-repository steps." That is still a plan, not code.
- **Plan drift (info).** `72-01-PLAN.md` D72-07 names `scopedGit(scope, identity, target, args, runner)`; the code is `scopedGit(request, run)`. The code is the shipped contract.

HARD-S2 bullet "Argv-only git": the executor file contains no spawn, so the argv claim for the executor is a property of the injected runner, which no production code supplies. The argv claim still holds for the git-spawning modules that the gates use: `packages/corpus/src/discover.ts`, `gitio.ts` and `packages/collectors/src/install-git-hook.ts` spawn `git` with argv arrays.

## Observable truths (re-located at 5e304ef8)

Line numbers are at 5e304ef8. Gate bodies are unchanged in order.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1 service: a drift scan naming an ungranted repository, or a path in another repository, is refused before any git call | ✓ VERIFIED | `scopedDriftScan` service.ts:7882; `authorizeRepo` 7884, `authorizeRepoPath` 7887, both before `driftScan`. JUnit: "boundary: a drift scan of an ungranted repository is refused before the scan and before any git call" (pass). |
| 2a  | SC1 REST: `POST /drift` runs the gate before the scan | ✓ VERIFIED | server.ts:1588 route; non-object 400 at 1591-1594; `rememberClaim` 1596; `scopedDriftScan` call 1602. JUnit: "boundary: a drift scan of an ungranted repository is refused before the scan and before any git call" (pass). |
| 2b  | SC1 MCP: `coord_drift_scan` refuses an ungranted repository before any git call | ✓ VERIFIED | mcp.ts:2015 `scopedDriftScan(request, callerSurface)`. JUnit: "boundary: coord_drift_scan of an ungranted repository is refused before the scan and before any git call" (pass). |
| 3   | SC1 API: every REST route or MCP tool with no declaration is refused to a scoped caller before its handler | ✓ VERIFIED | REST default deny server.ts:964-966 (`restDeclaration`, `refuseUndeclared` at 966); MCP batch default deny server.ts:2772-2773. `/evidence`, `/verify`, `/corpus/root`, `/corpus/anchor` have no entry in route-policy.ts, so default deny refuses scoped callers before their handlers and their new null-body checks. Declarations unchanged (route-policy.ts, 3-line export change only). Decision 3 is a human item. |
| 4   | SC1 CLI: `substrate worktree` refuses an ungranted root, `--repo`, provision target, merge-back or guard path before any git call, exit 2 | ✓ VERIFIED | `runWorktree` calls `scopeRefusal` at cli/src/worktree/command.ts:557 before dispatch; refusal is `usageError`, exit 2 (command.ts:542-554). JUnit: "boundary: list --repo naming an ungranted repository is refused and runs no git" (pass); "boundary: provision into another repository's checkout is refused and runs no git" (pass). |
| 5   | SC1 CLI: `substrate corpus` refuses an unregistered `--root`, `--repo` directory, or named `--repo` before any git call or hook write, when the registry is set | ✓ VERIFIED (gated commands; off unless configured) | `runCorpus` calls `corpusScopeRefusal` at cli/src/corpus/index.ts:304 before dispatch. JUnit: "boundary: reflect --repo naming an unregistered repository spawns no git and exits 2" (pass); "boundary: scan over an unregistered --root spawns no git and exits 2 naming the path" (pass). `hint` writes a spool file and runs no git (documented; not gated). |
| 5b  | SC1 CLI: the standalone installer refuses an unregistered repository before any git call or hook write, under a registry | ✓ VERIFIED (off unless configured, as row 5) | install-git-hook.ts `locate` (111). JUnit: "with a registry set, an unregistered repository is refused without spawning git, and nothing is written" (pass, install-git-hook.test.ts); "boundary: hook install with an unregistered --repo writes no hook" (pass, cli/src/corpus/scope.test.ts). |
| 5c  | HARD-S2 path clause: a hook write stays inside a registered directory, including after `core.hooksPath` resolution | ✓ VERIFIED | install-git-hook.ts `locate` (111). JUnit: "a hooks directory outside the registered repository is refused and nothing is written there; an in-repo one still installs" (pass). |
| 5d  | HARD-S2 path clause: a hook write from a registered linked worktree stays inside a registered directory | ✓ VERIFIED (fix with test, a28ecac8) | install-git-hook.ts `locate` (111), `commonGitDir` (79), `primaryCheckout` (87). JUnit: "a registered linked worktree whose primary is not registered is refused: nothing is written to the primary's hooks and the line names the primary" (pass). |
| 6   | SC1/SC2 path containment: `..`, symlinks and registered roots compared after realpath; overlapping registrations refused at boot | ✓ VERIFIED | repo-scope.ts (export keywords only): `contains` (122), `resolveContained` (212), `locateRepoPath` (249); overlap refusal in `parseRepoRegistry` at 162-163. JUnit: "RS-14: two registrations that name the same directory through a symlink are refused at boot" (pass); "boundary: a symlink inside a granted directory that points into another repository is refused" (pass, repo-scope.test.ts). |
| 6b  | SC1/SC2: a checkout nested under an admitted root is refused by name before git | ✓ VERIFIED (fix with test, a28ecac8) | `nestedCheckoutBetween` (repo-scope.ts:114); `locateRepoPath` `nested-checkout` (261); executor `scopedGit` (repo-executor.ts:74) for the executor path (no runner in production). JUnit: "boundary: a nested checkout under a registered directory is refused by name, and the registered checkout is placed" (pass); "a checkout nested under a registered checkout is refused by name before the runner is called, and the outer checkout still runs" (pass). |
| 6c  | SC1/SC2: a checkout nested under a registered directory that has no `.git` of its own is refused by name, and no git runs in it | ✓ VERIFIED (fix with test, 500e4fb3) | `nestedCheckoutBetween` (no carve-out); `discover.ts` `explore` (207). JUnit: "a nested checkout under a registered plain directory is skipped with a note that names it, and no git runs in it" (pass). |
| 7   | SC2 worktrees, fake store: an unfiltered scoped list returns only granted rows; a named ungranted repository is refused before the read | ✓ VERIFIED (JUnit) | `listWorktrees` service.ts:5333 (gate 5337, `grantedRepos` 5341). JUnit: "boundary: an unfiltered scoped list returns only the granted repository's rows, filtered in the store" (pass); "boundary: naming another repository is refused at the door, with no rows read" (pass). |
| 8   | SC2 worktrees, Postgres: the list query filters in SQL, and an empty list matches no row | ✓ VERIFIED (JUnit r38) | Predicate worktree-registry.ts:401 `(${repos}::text[] is null or lower(repo) = any(${repos}::text[]))`. JUnit r38: "a listing with a repos filter returns only the rows of the listed repositories, and an empty list returns none" in class "the worktree registry against a live index" (pass). Earlier: r33 at 6e5d766e; scratch PG 16 at 42e3cf13. No Postgres was started for this record. |
| 9   | SC2 corpus: plan, ingest and proof refuse an ungranted repository after parse and before any manifest or plane read | ✓ VERIFIED (JUnit r38) | `repoRefusalOf` corpus/service.ts:157 (unchanged body); called at 205 (plan), 235 (ingest, before the tombstone check at 237), 331 (proof). JUnit: "a tombstone for a repository the caller is not granted is refused, and the plane deletes nothing" (pass); "boundary: the proof of another repository's document is refused before the corpus tree is read" (pass). |
| 10  | SC2 corpus status, reconcile, root and anchor: refused to scoped callers | ✓ VERIFIED (status and reconcile via `allReposRefusal`; root and anchor via route default deny) | `allReposRefusal` corpus/service.ts:169, called at 268 (status) and 289 (reconcile). `/corpus/root` server.ts:1866 and `/corpus/anchor` server.ts:1886 have no route-policy entry, so default deny (966) applies first. JUnit: "boundary: the cross-repository status is refused to a scoped caller, with no manifest read" (pass). The route titles "boundary: /corpus/root is refused before its handler runs, and nothing outside the grant is read or written" and the `/corpus/anchor` twin (pass) are generated by `test(\`boundary: ${path} ...\`)` at repo-scope.routes.test.ts:282 from the list at lines 247-251; they exist in source as that template. |
| 11  | SC2 corpus proof disclosure: a granted proof reveals no other repository's digests or corpus-wide counts | ? UNCERTAIN (decision 1, open) | Proof reply (corpus/service.ts:325-345; gate at 331) unchanged since a46d42c3. The inclusion proof is built over the whole-corpus tree, so sibling hashes and `root` commit to other repositories' `(repo, path, sha256)`; `index` and `treeSize` expose corpus-wide position and count. The positive control "boundary: the proof of a granted repository's document reads the tree" (pass) shows the granted read reaches the tree. Whether this is "reading another repository's corpus" is a policy reading, open. |
| 12  | SC2 ledger: a named ungranted repository is refused before the query; rows are filtered to the grant | ✓ VERIFIED | `queryEventsFor` service.ts:6867 (named gate at 6871), then `rowsInGrant` at 6875. A `null` body maps to `{}` (6868-6869) so the named gate runs for it. Route `/events/query` server.ts:1384-1398. JUnit: "boundary: a named repository outside the grant is refused, and the ledger is not queried" (pass); "boundary: a named query returns only rows of granted repositories; rows with no repository are dropped" (pass). |
| 13  | SC2 graphs: a graph's repository is read from its row and must be granted before content is read; no resolvable repository is refused | ✓ VERIFIED | `graphRepoOf` service.ts:6785; `scopedGraphRefusal` service.ts:6796-6803 (`graph-repo-unresolved` at 6800). JUnit: "boundary: a graph whose repository is not granted is refused, and only its row is read" (pass); "boundary: a graph with no resolvable repository is refused under scope" (pass). |
| 14  | SC2 docs: search and LightRAG query refused to every scoped surface before retrieval or fallback | ✓ VERIFIED | `scopedDocsRefusal` service.ts:6816; called at mcp.ts:1585 and 1803 and server.ts:1647 and 1903 before retrieval; declared GATED in route-policy.ts (`/docs/search`, `/docs/lightrag/query`). The telemetry call `recordRetrieval` (service.ts:6469, definition 6495) runs after the answer is built and does not reach a scoped caller. JUnit: "boundary: docs search is refused to a scoped surface, named or not, and the Hindsight fallback with it" (pass). |
| 15  | SC2 writes: `events_emit`, `graph_register`, `handoff`, `POST /events` refuse an ungranted or absent target before the write | ✓ VERIFIED | `scopedWriteRefusal` service.ts:6825; server.ts:1353 (`POST /events`), 1560 (`POST /handoff`); mcp.ts:1189 `events_emit`, 1333 `graph_register`, 1938 `handoff`. Each gate precedes `emit`/register/handoff. The new `/handoff` `to` check (1508) runs before this gate and writes nothing. JUnit: "boundary: an event naming an ungranted repository is refused before the ledger write" (pass); "boundary: a handoff naming an ungranted repository writes no packet" (pass); "boundary: an event or graph registration naming an ungranted repository is refused" (pass). |
| 16  | SC2 lease reaper: an unnamed reap touches only granted repositories; a named ungranted reap reaps nothing | ✓ VERIFIED | `reapExpiredLeases` service.ts:7596; named gate `authorizeRepo` at 7605 (refusal at 7606-7607 before any reap); `grantedRepos` for the unnamed reap at 7608; `index.reapExpiredLeases` at 7610, after the gate. The reaper's emit (7615) follows the reap. JUnit: "boundary: a named repository outside the grant reaps nothing, and an unnamed reap reaps only granted repositories" (pass). |
| 17  | SC2 live sessions, discovery: an unnamed discovery by a scoped caller is refused | ✓ VERIFIED | `scopedRepoRefusal("live_session_discovery", ...)` at service.ts:2295, before `listVisible`. JUnit: "boundary: the discovery gate refuses an unnamed discovery to a scoped surface, and audits it under its route" (pass). |
| 18  | SC2 live sessions, issue and transition: an ungranted `repo_id` is refused before `authority.issue` or `transition` | ✓ VERIFIED (fix with test, a51a698c) | Gate `authorizeRepo(this.config.repoScope, caller.surface, request.repoId)` at service.ts:2241 in `updateLiveSession` (2233), before `authority.issue` (2247) and `transition`. JUnit: "gate: updateLiveSession issue for a repository the caller's grant does not include is refused and writes nothing" (pass). |
| 19  | SC2 memory search: a scoped caller receives only entries whose scope and own `repo` are both granted | ✓ VERIFIED (JUnit r38) | `grantedToCaller` memory-policy.ts:441 with `normalizeIdentifier(repo)` at 443; `visibleToCaller` 458-466 (memory-policy.ts unchanged since a46d42c3). Door `memoryReplyInGrant` service.ts:6891 (repo grant at 6899; derived-hit filter at 6910). JUnit: "a repo keeps its exact spelling for visibility: a lone high surrogate is not trimmed into the granted repo" (pass, memory-policy.test.ts). Warning: no door-level title exists for this row (see warnings). |
| 20  | SC2 memory verify: a scoped caller gets no verdict for an entry of an ungranted repository | ✓ VERIFIED | `memoryVerify` service.ts:4644; gate at 4649 before the index is read; reader repo `normalizeIdentifier(caller.repo)` (4658). JUnit: "boundary: verifying an entry as an ungranted repository is refused as an unknown id, and the index is not touched" (pass); "boundary: an entry in an ungranted repository is answered as an unknown id, and its content is never read" (pass). |
| 21  | SC1/SC2 live sessions at the public routes: a scoped caller's live-session issue and transition are refused before any session is read or written | ✓ VERIFIED (by default deny; JUnit r38) | Live-session routes and `docs_steering_session` are undeclared for scope, so every scoped caller is refused. JUnit: "boundary: REST issue of a session for an ungranted repository is refused before any session is written" (pass); "boundary: MCP docs_steering_session issue for an ungranted repository is refused before any session is written" (pass); "boundary: MCP docs_steering_session transition by a scoped surface is refused before the session authority is read" (pass). Consequence: scoped surfaces cannot run live sessions at all. A product consequence, not a leak. |

**Score:** 26 of 27 truth rows verified. Row 11 is uncertain. Behavior-unverified: 0.

### Verdicts by criterion

| Criterion | Verdict |
| --------- | ------- |
| 1. API and CLI refuse before any git call | ✓ VERIFIED under scoping, with open items. Gate names and reason codes unchanged. Open: decision 3 (unit is the surface, not the session); decision 4 (collector cwd reads). Scoping is off unless configured; this is the code's posture, not an owner decision, and not an open item. |
| 2. Scoped credential cannot read another repository's worktrees or corpus | ⚠️ PARTIAL. VERIFIED for worktree lists (rows 7, 8), corpus plan, ingest, status, reconcile, root, anchor and proof refusal (rows 9-10), ledger (12), graphs (13), docs (14), writes (15), reaper (16), memory search (19), memory verify (20) and live-session routes (17, 18, 21). UNCERTAIN for the corpus proof disclosure (row 11, decision 1). |

**HARD-S2 (REQUIREMENTS.md:113), against the committed text:**
- Repository access may be requested by path only where the path resolves to a registered repository: **MET where a registry is set.** With no registry and no scopes, scoping is off (config.ts 975-976; index.ts:66 refuses to start when the registry is set without its scopes).
- Canonicalise paths; component-wise roots; traversal and symlink rejection, including after registration: **MET** for the gated doors (repo-scope.ts `contains`, `resolveContained` 212, `locateRepoPath` 249; overlap refusal at 162-163).
- Repository access granted per surface; every route and tool resolves the caller's surface and refuses an ungranted repository: **MET** for the gated doors (REST default deny server.ts:966, MCP batch default deny server.ts:2773, route-policy.ts, `isGranted` 266).
- Repo A credentials cannot authorise repo B: **MET** for the gated doors.
- Argv-only git: **MET** for the gated doors that spawn git (`discover.ts`, `gitio.ts`, `install-git-hook.ts`). `repo-executor.ts` spawns nothing; its argv property is a contract on the injected runner, and no production runner exists. The executor is not wired.

**HARD-S2 against the original text** (23bd0733, "Resolve least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B"): **UNMET AS WRITTEN.** No repository-specific credential reference exists; the credential is a surface bearer token. The committed text in REQUIREMENTS.md (a147228f, 79b3ba32) is the surface-bearer model. The commit is recorded here; no owner decision on it is recorded for this phase.

**Decision status (2026-11-06 scope note: no owner decision exists for this phase).**
- Open: (1) corpus proof disclosure (row 11); (3) allowlist unit, surface versus session (criterion 1); (4) scope of "the CLI" for collector cwd reads (criterion 1); row 19 legacy-row repair (data decision).
- Not an owner decision: scoping is off unless configured (code posture, config.ts 975-976).
- Code fixes with tests (not decisions): row 8 (r38 title pass; earlier r33 at 6e5d766e; scratch PG 16 at 42e3cf13); row 18 (a51a698c; r38 title pass); row 19 regression (exact spelling, 4b84e50c; r38 title pass); 6c (500e4fb3); refuse-to-start (500e4fb3); 5d and 6b (a28ecac8).

## What changed since a46d42c3, and why it matters to the gates

1. **No gate changed.** Gate bodies, grant reads, refusal reason codes and the order of gate before read or write are as in the a46d42c3 record. Every covered-file hunk changed since a46d42c3 is one of: the new `/handoff` `to` refusal ahead of the existing write gate (writes nothing, grants nothing); a reporting catch after a write; a comment; a removed unreferenced symbol; a type change in the phase 63 docs dependency.
2. **`/handoff` now refuses a `to` outside SURFACES with 400 (14ac787a).** It is checked before the claim is remembered and before the scope gate. A scoped caller naming a bad `to` is told the `to` is wrong, not that the repository is ungranted. No test title in r38 covers this 400 path; it is not a phase 72 criterion. [INFERENCE: the response precedence change does not alter any grant.]
3. **CLI `handoff` exits 1 on a server refusal (14ac787a).** Not a phase 72 gate; the phase 72 CLI gates are `worktree` and `corpus` (rows 4, 5), whose dispatch is unchanged.
4. **Null body reaches the event query gate (f0f3c04e, carried from before a46d42c3).** `queryEventsFor` maps `null` to `{}`, so `scopedRepoRefusal("events_query", …, required: true)` runs for a `null` body as it does for `{}`. The change makes the refusal reachable, not looser.
5. **Scoped git executor (a46d42c3).** Dead code removed. `scopedGit` unchanged. Still not wired. The removed runner's env settings must be restored by whichever phase wires it.
6. **Covered digest.** Recomputed at 5e304ef8 (see Changes). The prior record's digest values (`459ef7fa…` in frontmatter, `e37dee37…` in body) are superseded.

## Human Verification Required

1. **Row 11, decision 1 (corpus proof disclosure).** Decide whether a granted caller receiving root, treeSize, index and the audit path counts as reading another repository's corpus. Options: accept as allowed, rebuild per repository, or withhold foreign siblings, index and treeSize. **Why human:** a policy reading of "read". Open; no owner decision exists for this phase.
2. **Decision 3 (allowlist unit, criterion 1).** Confirm the surface, not the session, is the intended allowlist unit. **Why human:** design decision. Open.
3. **Decision 4 (scope of "the CLI", collectors).** Decide whether `packages/collectors/src/git-context.ts` (spawnSync git at 16, 26), `muse.ts` (313, 315) and `cursor-stop.ts` (318) cwd reads are inside criterion 1. None of the three imports the registry gate (`localRegistryScope`, `localPathGate`, `localRepoGate`, `repoScopeFromEnv`); the only importers are `cli/src/corpus/scope.ts`, `cli/src/worktree/scope.ts`, `collectors/src/install-git-hook.ts`, `corpus/src/discover.ts` and `config.ts`. **Why human:** scope of "the CLI". Open.
4. **Row 19 repair of legacy rows (owner data decision, not the gate).** The gate is correct for legacy rows; the owner decides whether legacy rows with a dangling surrogate in `repo` are repaired or left unmatched. **Why human:** data decision. Open.

## Gaps Summary

Status is `human_needed`. No truth is FAILED on the evidence read here. Rule 2 fires: row 11 is uncertain and decisions 1, 3, 4 and the row 19 repair are open.

- **Row 8 (JUnit r38).** The Postgres list filter has its named title passing in r38.
- **Scoped git executor (NOT_WIRED, unchanged).** No production caller; refusal behaviour unchanged; its refusal titles pass in r38.
- **Criterion 1 (verified under scoping, with open items).** Open: decision 3, decision 4.
- **Criterion 2 (partial).** Open: the corpus proof disclosure (decision 1, row 11).
- **HARD-S2 (committed text).** The identifier clause holds wherever a registry is set; scoping is off when unconfigured.
- **HARD-S2 (original text).** Unmet as written. Recorded, not re-decided.

**Warnings and info (not blocking):**
- **The removed runner's env settings are applied by no code.** `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`, and the `GIT_CEILING_DIRECTORIES` value passed by `scopedGit` (repo-executor.ts:82). The phase that wires `scopedGit` must supply a runner that applies them.
- **`repo-executor.ts:13` says phase 74 calls `scopedGit`; no caller exists.**
- **Stale comment on the registry gate (repo-scope.ts:301).** It says the registry gates "the top-level CLI's cwd reads". No such importer exists at 5e304ef8 (see decision 4). Relevant to decision 4; the comment is not a gate.
- **`route-policy.ts:51` says derived hits are not yet filtered (RS-07).** The code filters them (service.ts:6910, the `derived` filter in `memoryReplyInGrant`). Stale comment.
- **Row 19 door-level title is absent.** The lone-surrogate classes at `memoryReplyInGrant` are covered by the helper title above and not by a door test.
- **`live-session-scope.test.ts` public-route title "refused before the session authority is read" describes default deny, not the repository gate.**
- **ROADMAP.md Phase 72 status line (line 1256) now carries the 26-of-27 count dated 2026-11-06.** The prior warning is resolved.
- **Info: `72-01-PLAN.md` D72-07 signature differs from the shipped `scopedGit(request, run)`.**
- **Info: the prior frontmatter digest (`459ef7fa…`) did not reproduce; the body value (`e37dee37…`) did. Both superseded by the 5e304ef8 digest above.**
- **Info: r38 ran at 66fa97bd; 66fa97bd..5e304ef8 changes only `config.ts` (an `export` keyword on `DEFAULT_LIGHTRAG_PLANNING_ROOTS`, no code change), `hindsight-canary-run.ts` (not covered) and the ratchet baseline.** No cited title exercises them [INFERENCE]. r39 is the gate for 5e304ef8 and is pending.

---

_Verified: 2026-11-06_
_Verifier: Claude (gsd-verifier, phase 72 re-verification at 5e304ef8; draft, read-only on the repository)_
