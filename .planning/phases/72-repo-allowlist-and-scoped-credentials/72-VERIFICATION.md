---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-03T10:26:33Z
status: human_needed
score: 24/27 truth rows verified (2 present but behavior-unverified: rows 8, 18; 1 uncertain: row 11; 0 failed); success criteria 1 verified under scoping with open items, 2 partial; HARD-S2 met under scoping, default-off posture open
covered_files: [".env.example", ".planning/REQUIREMENTS.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-PLAN.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-SUMMARY.md", "docs/config-reference.md", "docs/corpus-watch.md", "docs/worktree-fleet-api.md", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/scope.test.ts", "packages/cli/src/corpus/scope.ts", "packages/cli/src/corpus/watch-commands.ts", "packages/cli/src/index.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.test.ts", "packages/cli/src/worktree/scope.ts", "packages/collectors/src/install-git-hook.test.ts", "packages/collectors/src/install-git-hook.ts", "packages/corpus/src/discover.test.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/gitio.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/live-session-scope.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/repo-executor.test.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/repo-scope.reads-writes.test.ts", "packages/mcp-server/src/repo-scope.routes.test.ts", "packages/mcp-server/src/repo-scope.test.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-registry.ts"]
covered_digest: "v3:sha256:8482692d0d609a5209cf93b12ba37968fdb8b18a3c6e10d37d5f23f24c1fdedc"
behavior_unverified: 2
behavior_unverified_items:
  - truth: "Row 8: Postgres repos filter in worktree-registry.ts (SQL predicate, line 397); orchestrator evidence only, not run at HEAD"
    test: "Run packages/mcp-server/src/worktree-registry.pg.test.ts with SUBSTRATE_TEST_PG_URL set to a live database, at HEAD 97defd59"
    expected: "All worktree-registry Postgres tests pass; an empty repos list matches no row; the run is recorded with its commit"
    why_human: "This verifier ran with SUBSTRATE_TEST_PG_URL unset: 14 tests skipped. No database was started here."
  - truth: "Row 18: service-level live-session repository gate (service.ts:2227, authorizeRepo inside updateLiveSession) under scope"
    test: "Issue and transition a live session whose repo_id is not granted, with SUBSTRATE_REPO_REGISTRY and SUBSTRATE_REPO_SCOPES set, calling updateLiveSession directly (not through the public route)"
    expected: "Refused before authority.issue or transition; no session row written"
    why_human: "No test reaches service.ts:2227 under scope. The public routes refuse first by default deny (live-session-scope.test.ts), so the repository gate is never the one that refuses."
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: "24/27 (verified at 9ab6f111, 2026-11-03T08:46:19Z)"
  gaps_closed: []
  gaps_remaining:
    - "Truth 11, corpus proof disclosure. Owner decision 1, open. Human item."
    - "Truth 3, allowlist unit (surface versus session). Owner decision 3, open. Human item."
    - "Truth 18, service-level live-session repository gate under scope: not reached by any test. Open. Human item."
    - "Truth 8, Postgres repos filter: orchestrator evidence only; not run at HEAD (14 entries skipped, SUBSTRATE_TEST_PG_URL unset). Open. Human item."
    - "Default-off posture: with neither scopes nor registry set, scoping is off; the corpus CLI and the collector installer accept a registry without scopes (documented: docs/worktree-fleet-api.md:158-159, cli/src/corpus/scope.ts:6, install-git-hook.ts:112). Open. Human item."
    - "Decision 4, scope of 'the CLI' for collector cwd reads (git-context.ts, muse.ts, cursor-stop.ts). Not decided. Open. Human item."
  regressions: []
  notes: "Re-verified at HEAD 97defd59 (gsd/v18-int-all). Since 9ab6f111 the commits are phase 73 (9ab6f111, 97defd59), phase 78 (d05ae871) and the corpus docs. None touches a phase 72 gate file: `git diff --name-only 9ab6f111 97defd59` over the covered implementation files lists only packages/mcp-server/src/service.ts, and its hunks are phase 73 anchor, pointer and Solana-guard code (judgePointer ~866-900; the verify guard ~8016-8025). service.test.ts changes are the phase 73 SOLANA guard test. The 500e4fb3, a28ecac8 and 9ab6f111 named commits are ancestors of HEAD. Gate sites in service.ts moved by one to a few lines from the 9ab6f111 numbering (authorizeRepo updateLiveSession 2226 to 2227; scopedDriftScan 7773 to 7774; listWorktrees 5258 to 5259; reapExpiredLeases 7508 to 7509); bodies unchanged. Targeted tests and grep only. Probes P1 to P5 from 9ab6f111 are carried, not re-run: their code is unchanged. Not a full gate."
gaps: []
---

# Phase 72: Repo allowlist and scoped credentials Verification Report

**Phase Goal:** A session can address only the repositories on its allowlist, and each repository's credential is scoped to that repository.
**Verified:** 2026-11-03T10:26:33Z
**Status:** human_needed
**Re-verification:** Yes. Integration tree gsd/v18-int-all at HEAD 97defd59. The prior record (human_needed, 9ab6f111) is replaced.

**Evidence labels.** "Verified" means a test run this verifier ran at HEAD 97defd59 (two targeted commands, output saved outside the repository), or a read of code at that HEAD. "Carried" means evidence from the 9ab6f111 record whose code is unchanged since (checked by `git diff`). "Orchestrator evidence" means a claim the orchestrator supplied, not re-run here. "[INFERENCE]" marks a conclusion no test or probe exercised.

**Criteria source:** `.planning/ROADMAP.md`, Phase 72 section. The success-criteria text is unchanged.
Criteria (verbatim):
1. A repository outside the session's allowlist is refused at the API and the CLI before any git call runs.
2. A credential scoped to one repository cannot read another repository's worktrees or corpus.

**Requirement source:** `.planning/REQUIREMENTS.md:113` (HARD-S2), amended to the surface-bearer model (a147228f), with the identifier clause amended to a path gated to a registration (79b3ba32). The amended text is binding for this record.

**Owner decisions judged here (binding, from the orchestrator, 2026-11-03):**

| Owner decision | Judgment at 97defd59 |
| -------------- | -------------------- |
| 6c, strict: any nested `.git` below a registered root is refused by name; each repository and each linked worktree must be named (500e4fb3) | ✓ CLOSED by code (repo-scope.ts:113-118, 247-261; discover.ts:207-219; repo-executor.ts:72-78), named tests and the unchanged 9ab6f111 probes |
| Refuse-to-start: server refuses when `SUBSTRATE_REPO_REGISTRY` is set without `SUBSTRATE_REPO_SCOPES` (500e4fb3; config.ts, index.ts, config.test.ts) | ✓ CLOSED by code (config.ts:967-980, 1274; index.ts:65-69), named tests and the spawned entry-point test (passed here) |
| 5d: a linked worktree's shared hooks are refused without its primary checkout registered (a28ecac8) | ✓ CLOSED by code (install-git-hook.ts:126-135) and named tests (passed here) |
| 6b: a checkout nested under an admitted root is refused by name, no git run (a28ecac8) | ✓ CLOSED by code (repo-scope.ts:113-118, 259; repo-executor.ts:86) and named tests (passed here) |
| Decision 1 (corpus proof disclosure) | OPEN, unchanged |
| Decision 3 (allowlist unit, surface or session) | OPEN, unchanged |
| Row 18 (service-level live-session gate under scope) | OPEN, unchanged; no test reaches it under scope |
| Row 8 (Postgres repos filter) | OPEN; orchestrator evidence only, not run at HEAD |
| Default-off posture of scoping, the corpus CLI and the collector installer (both accept a registry without scopes, documented) | OPEN, unchanged |
| Decision 4 (scope of "the CLI" for collector cwd reads) | OPEN, not decided |

## Verdicts by criterion

| Criterion | Verdict |
| --------- | ------- |
| 1. API and CLI refuse before any git call | ✓ VERIFIED under scoping, with open items. Under `SUBSTRATE_REPO_SCOPES`: REST `POST /drift`, MCP `coord_drift_scan`, the worktree routes and `substrate worktree` refuse before git (rows 1-4). Under `SUBSTRATE_REPO_REGISTRY` (the server now also requires scopes): `substrate corpus` (row 5), the standalone installer (5b), hook writes on the resolved hooks directory (5c) and on a linked worktree's primary (5d), and discovery's nested-checkout refusal (6, 6b, 6c). Open: the default-off posture (no registry and no scopes disables the gates; the corpus CLI and installer accept a registry without scopes); decision 3 (unit is the surface, not the session); row 18 (no test reaches the service-level gate under scope). |
| 2. Scoped credential cannot read another repository's worktrees or corpus | ⚠️ PARTIAL. VERIFIED for worktree lists (row 7), corpus plan, ingest, status, reconcile, root, anchor and proof refusal (rows 9-10), ledger (12), graphs (13), docs (14), writes (15), reaper (16), memory (19-20) and the public live-session routes (21). UNCERTAIN for the corpus proof disclosure (row 11, decision 1). The Postgres worktree filter is orchestrator evidence only (row 8). Row 6c is closed: a nested unregistered repository is refused, so the local CLI no longer reads it. |

**HARD-S2 (REQUIREMENTS.md:113), against the amended text (binding for this record):**
- Repository access may be requested by path only where the path resolves to a registered repository; `POST /drift`, `substrate drift --path` and `--root` accept a raw path gated to a registration. **MET where a registry is set; OPEN under the default-off posture.** A server with a registry cannot start without `SUBSTRATE_REPO_SCOPES` (config.ts:976, index.ts:65-69). Under scopes: `POST /drift` gates the path (server.ts:1586, service.ts:7774 `scopedDriftScan`). Carried probe P4 (9ab6f111, code unchanged): `/etc` refused `path-not-registered`, a nested clone refused `nested-checkout`.
- Canonicalise paths; component-wise roots; traversal and symlink rejection, including after registration: MET for the gated doors (repo-scope.ts:121-123 `contains` with separator; 211-229 `resolveContained` realpath per call; 247-261 `locateRepoPath`; overlap refusal at parse, repo-scope.ts:139-168). Hook directories pass the same containment (install-git-hook.ts:121-125); the linked-worktree common directory is gated on the primary (126-135).
- Repository access granted per surface; every route and tool resolves the caller's surface and refuses an ungranted repository: MET (server.ts REST default deny; MCP batch default deny; route-policy.ts; repo-scope.ts:264-267 `isGranted`).
- Repo A credentials cannot authorise repo B: MET for the gated doors (surface bearer maps to one surface; grants per surface). A surface holding several grants is not "scoped to one repository"; D72-03 allows a single-grant surface.
- Argv-only git: MET for gated paths (repo-executor.ts:51 `spawnSync("git", [...args])`; corpus/src/discover.ts and gitio.ts argv; install-git-hook.ts argv arrays).

**HARD-S2 against the original 23bd0733 text** ("Resolve least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B"): UNMET AS WRITTEN. No repository-specific credential reference exists. The credential is a surface bearer token. This is the owner-amended clause, recorded here, not re-decided.

**Decision status:** Open and owner-held: (1) corpus proof disclosure; (3) allowlist unit (surface versus session); row 18 (service-level gate under scope); the default-off posture of scoping, the corpus CLI and the collector installer; (4) scope of "the CLI". Recorded, not re-decided: (2) the credential model, as amended in a147228f. Closed and judged here: 6c (strict rule), refuse-to-start, 5d and 6b.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| 1 | SC1 service: a drift scan naming an ungranted repository, or a path in another repository, is refused before any git call | ✓ VERIFIED | `scopedDriftScan` service.ts:7774; repo gate at 7776 (`authorizeRepo`), then the path gate, both before the scan. Cmd 2 (repo-scope.routes.test.ts, repo-scope.boundary.test.ts) passes at 97defd59. Carried probe P4. |
| 2a | SC1 REST: `POST /drift` runs the gate before the scan | ✓ VERIFIED | server.ts:1586 `scopedDriftScan`, then refusal. Route test passes (cmd 2). |
| 2b | SC1 MCP: `coord_drift_scan` refuses an ungranted repository before any git call | ✓ VERIFIED | mcp.ts:2005 `scopedDriftScan(request, callerSurface)`. Boundary test passes (cmd 2): spies `driftScan` and `Bun.spawnSync`; asserts `repo-not-granted`, zero scan calls. Caveat: the spies do not cover `node:child_process` (repo-executor.ts:51), which is not on this path. |
| 3 | SC1 API: every REST route or MCP tool with no declaration is refused to a scoped caller before its handler | ✓ VERIFIED | REST default deny (server.ts `REST_ROUTE_POLICY`), MCP batch default deny; declarations route-policy.ts. "default deny" tests pass (cmd 2). Decision 3 is a human item, not a status change for this row. |
| 4 | SC1 CLI: `substrate worktree` refuses an ungranted root, `--repo`, provision target, merge-back or guard path before any git call, exit 2 | ✓ VERIFIED | `runWorktree` calls `scopeRefusal` at cli/src/worktree/command.ts:557 before the dispatch switch. `packages/cli/src/worktree/scope.test.ts` passes (cmd 1). |
| 5 | SC1 CLI: `substrate corpus` refuses an unregistered `--root`, `--repo` directory, or named `--repo` before any git call or hook write, when the registry is set | ✓ VERIFIED (gated commands; default off) | `runCorpus` calls `corpusScopeRefusal` (cli/src/corpus/index.ts:304) before dispatch. Cmd 1 (corpus/scope.test.ts, corpus/index.test.ts, watch-commands.test.ts) passes. `hint` writes a spool file and runs no git (documented; carried, not gated). |
| 5b | SC1 CLI: the standalone installer refuses an unregistered repository before any git call or hook write, under a registry | ✓ VERIFIED (default off, as row 5) | install-git-hook.ts `locate` 111-119: `localRegistryScope` (112), registration gate (116-117), then `hooksDir` (119), the first git call. Test "a registry is checked before any git call > with a registry set, an unregistered repository is refused without spawning git, and nothing is written" (install-git-hook.test.ts:329-347) passes: exit 1, `refused` line, no git shim call logged, no hook written. |
| 5c | HARD-S2 path clause: a hook write stays inside a registered directory, including after `core.hooksPath` resolution | ✓ VERIFIED | install-git-hook.ts `locate` 121-125: the resolved hooks directory must lie within `ownLocations(repo)`. Test "core.hooksPath under a repository registry" (install-git-hook.test.ts:303-326) passes: an outside hooks directory is refused and stays empty; an in-repo one installs. |
| 5d | HARD-S2 path clause: a hook write from a registered linked worktree stays inside a registered directory | ✓ VERIFIED (closed; owner decision, a28ecac8) | install-git-hook.ts `locate` 126-135: when the hooks directory lies in the common git directory (`commonGitDir` 79-84), `primaryCheckout` (87-94) must pass `localPathGate`. Tests (install-git-hook.test.ts:350-382, both) pass: an unregistered primary is refused, the line names the primary, and nothing is written to the primary's hooks; with the primary registered, the linked worktree installs into the shared hooks. |
| 6 | SC1/SC2 path containment: `..`, symlinks and registered roots compared after realpath; overlapping registrations refused at boot | ✓ VERIFIED | repo-scope.ts:121-123 `contains`; 211-229 `resolveContained`; 247-261 `locateRepoPath`; overlap refusal at parse (`parseRepoRegistry`, 139-168; carried line numbers 162-168). Cmd 1 (repo-scope.test.ts) and cmd 2 (boundary symlink and dot-dot tests) pass. Carried probe P3b: a different-name nested registration is refused at parse, "two repositories share or nest a directory", with zero git runs. |
| 6b | SC1/SC2: a checkout nested under an admitted root is refused by name before git | ✓ VERIFIED (closed by a28ecac8; strengthened by 500e4fb3) | `nestedCheckoutBetween` (repo-scope.ts:113-118) refuses any `.git` strictly below the matched root (`hasGitEntry` 99-106); `locateRepoPath` returns `nested-checkout` at repo-scope.ts:259. Executor: `scopedGit` (repo-executor.ts:86-96) refuses before the runner, via `locate` 72-78. Test repo-executor.test.ts:131-145 "a checkout nested under a registered checkout is refused by name before the runner is called, and the outer checkout still runs" passes (cmd 1). |
| 6c | SC1/SC2: a checkout nested under a registered directory that has no `.git` of its own is refused by name, and no git runs in it | ✓ VERIFIED (closed by 500e4fb3, owner decision 2026-11-03: strict rule) | `nestedCheckoutBetween` (repo-scope.ts:113-118) has no carve-out for a root without `.git`: the loop refuses on any `.git` from the target up to, not including, the root. `discover.ts` `explore` (207-219) refuses with a note and runs no git. Named tests (cmd 1 pass): discover.test.ts:313-335 "a nested checkout under a registered plain directory is skipped with a note that names it, and no git runs in it" (asserts the note names the clone and no call has `cwd === clone`); the registered repository itself is still run in (discover.test.ts, next test, asserts it is discovered and run); repo-executor.test.ts:149-161 "a nested checkout (a .git directory) under a registered plain directory is refused by name, and no git runs in it" (zero runner calls; the registered parent still runs). |
| 7 | SC2 worktrees, fake store: an unfiltered scoped list returns only granted rows; a named ungranted repository is refused before the read | ✓ VERIFIED | `listWorktrees` service.ts:5259-5266 (gate 5263, `grantedRepos` filter); fake filter worktree-registry-fake.ts. Cmd 2 (repo-scope.reads-writes.test.ts, repo-scope.routes.test.ts) passes. |
| 8 | SC2 worktrees, Postgres: the list query filters in SQL, and an empty list matches no row | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (ORCHESTRATOR EVIDENCE ONLY; open) | worktree-registry.ts:397 predicate `(${repos}::text[] is null or lower(repo) = any(${repos}::text[]))`; `repos` typed at 390. The only file in cmd 2 gated on the database is worktree-registry.pg.test.ts (`SUBSTRATE_TEST_PG_URL`, read at line 16); it ran with the variable unset: 14 tests skipped. Orchestrator evidence: `/root/src/worktrees/backups/t-r10c-pg-registry.log`, 12 pass, 0 fail, not tied to HEAD. Not run at HEAD 97defd59. |
| 9 | SC2 corpus: plan, ingest and proof refuse an ungranted repository after parse and before any manifest or plane read | ✓ VERIFIED | `repoRefusalOf` corpus/service.ts:154-163; called at 177 (plan), 207 (ingest), 301 (proof). Test "a proof for an ungranted repository is refused before the corpus manifest is read" passes (cmd 2). |
| 10 | SC2 corpus status, reconcile, root and anchor: refused to scoped callers | ✓ VERIFIED (status and reconcile via `allReposRefusal`; root and anchor via route default deny) | `allReposRefusal` corpus/service.ts:166-168, called at 238 (status) and 259 (reconcile). `/corpus/root` and `/corpus/anchor` have no route-policy entry, so default deny applies (carried; corpus/service.ts unchanged since 9ab6f111). |
| 11 | SC2 corpus proof disclosure: a granted proof reveals no other repository's digests or corpus-wide counts | ? UNCERTAIN (decision 1, open) | Unchanged at 97defd59 (corpus/service.ts unchanged since 9ab6f111). The proof reply (corpus/service.ts:305-313, carried) carries `root`, `treeSize`, `index`, `leaf`, `sha256` and the audit `path`. The inclusion proof is built over the whole-corpus tree (mcp-server/src/corpus/root.ts), so sibling hashes and `root` commit to other repositories' `(repo, path, sha256)`. `index` and `treeSize` expose corpus-wide position and count. No document content is disclosed. Whether this is "reading another repository's corpus" is a policy reading. |
| 12 | SC2 ledger: a named ungranted repository is refused before the query; rows are filtered to the grant | ✓ VERIFIED | `queryEventsFor` service.ts:6789 (named gate 6791); `rowsInGrant` (repo-scope.ts, carried 351). Cmd 2 (repo-scope.reads-writes.test.ts) passes. |
| 13 | SC2 graphs: a graph's repository is read from its row and must be granted before content is read; no resolvable repository is refused | ✓ VERIFIED | `graphRepoOf` (service.ts, just above) and `scopedGraphRefusal` service.ts:6718. Cmd 2 passes. |
| 14 | SC2 docs: search and LightRAG query refused to every scoped surface before retrieval or fallback | ✓ VERIFIED | `scopedDocsRefusal` service.ts:6738; declared GATED in route-policy.ts. Cmd 2 passes. |
| 15 | SC2 writes: `events_emit`, `graph_register`, `handoff`, `POST /events` refuse an ungranted or absent target before the write | ✓ VERIFIED | `scopedWriteRefusal` service.ts:6747 (called from server.ts and mcp.ts write doors). Cmd 2 passes. |
| 16 | SC2 lease reaper: an unnamed reap touches only granted repositories; a named ungranted reap reaps nothing | ✓ VERIFIED | `reapExpiredLeases` service.ts:7509; named gate at 7518 (`authorizeRepo`); unnamed reap against `grantedRepos`. Cmd 2 passes. |
| 17 | SC2 live sessions, discovery: an unnamed discovery by a scoped caller is refused | ✓ VERIFIED | Gate `scopedRepoRefusal("live_session_discovery", ...)` at service.ts:2275, before `listVisible`. Cmd 2 passes. |
| 18 | SC2 live sessions, issue and transition: an ungranted `repo_id` is refused before `authority.issue` or `transition` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (the service-level gate; open) | Gate `authorizeRepo(this.config.repoScope, caller.surface, request.repoId)` at service.ts:2227 in `updateLiveSession` (declared 2219), before `authority.issue` and `transition`. The public door refuses first: `live-session-scope.test.ts` asserts `not-declared-for-scope` for REST `POST /steering/sessions` and for MCP `docs_steering_session` issue and transition. That is default deny, not the repository gate. The tests that call `updateLiveSession` (live-session-boundary, live-session-isolation, live-session-restart.pg, observe, steering-session-gate, steering-tools) carry no repository scope configuration; the one "scoped" match in steering-tools.test.ts is a test title. No test reaches service.ts:2227 under scope. Open. |
| 19 | SC2 memory search: a scoped caller receives only entries whose scope and own `repo` are both granted | ✓ VERIFIED | Grant helpers service.ts:6802-6838 (`memoryReplyInGrant` and the grant closure); derived hits filtered. Cmd 2 passes. The comment at route-policy.ts:51 ("derived hits are not yet filtered, RS-07") is stale; the code filters them. |
| 20 | SC2 memory verify: a scoped caller gets no verdict for an entry of an ungranted repository | ✓ VERIFIED | Gate `authorizeRepo` service.ts:4581. Cmd 2 passes. |
| 21 | SC1/SC2 live sessions at the public routes: a scoped caller's live-session issue and transition are refused before any session is read or written | ✓ VERIFIED (by default deny; consequence below) | live-session-scope.test.ts (3 tests) passes (cmd 2). Live-session routes and `docs_steering_session` are undeclared for scope (route-policy.ts; absent from the MCP policy), so every scoped caller is refused. Consequence: scoped surfaces cannot run live sessions at all. A product consequence, not a leak. |

**Score:** 24 of 27 truth rows verified. Two are present but behavior-unverified (8, 18). One is uncertain (11). None failed. Rows 6b, 6c and 5d are closed and verified; refuse-to-start is closed and verified.

### Deferred Items

None. Step 9b checked the later phases in the milestone. Phase 74 (HARD-R1, cross-repository compensating actions) and phases 75-78 do not name nested checkouts, discovery, the plain-directory reading, or the proof disclosure. No gap is deferred.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/repo-scope.ts` | Pure gate, parsers, local gates, refusal payload, nested-checkout detection | ✓ VERIFIED | Strict nested rule 113-118 and 247-261; `isGranted` 264-267; `authorizeRepoPath` 289-296 (ok when scoping is off, line 290: the default-off posture); `localRegistryScope` 304 (no scopes requirement); `localPathGate` 313; `localRepoGate` 324. |
| `packages/mcp-server/src/repo-executor.ts` | `scopedGit` executor | ✓ VERIFIED (unit); NOT WIRED | Argv spawn at line 51; `locate` 72-78 refuses nested checkouts before the runner; `scopedGit` 86-96. No production caller. Carried as a warning. |
| `packages/mcp-server/src/config.ts` | `repoScope` from env; boot refusal | ✓ VERIFIED | `RepoScopesRequiredError` 967-972; `repoScopeOrRefuse` 975-980 (throws when the registry is non-blank and the scopes variable is unset or blank); `repoScope: repoScopeOrRefuse(env)` at 1274. |
| `packages/mcp-server/src/index.ts` | Entry point prints the refusal and exits 1 | ✓ VERIFIED | Lines 65-69: `RepoScopesRequiredError` prints `[substrate] refused — ...` and exits 1; the config error exit 78 is unchanged. |
| `packages/mcp-server/src/config.test.ts` | Loader and entry-point tests | ✓ VERIFIED (cmd 2) | Loader tests 794-831 (registry without scopes refused; empty and blank scopes refused; both set loads; neither set loads; blank registry unset). Entry-point spawn test 838-863 "the process prints the refusal naming both variables and exits 1" passes. |
| `packages/cli/src/corpus/scope.ts` | Corpus CLI gate; cwd-git permit | ✓ VERIFIED (gated commands; default off) | `corpusScopeRefusal` and `localRegistryScope`. The CLI does not require scopes (documented). |
| `packages/cli/src/corpus/index.ts` | Targets per command, gate before dispatch | ✓ VERIFIED (gated commands) | `corpusScopeRefusal` at 304, before dispatch. |
| `packages/cli/src/corpus/watch-commands.ts` | Hook command passes env and refuses `refused` | ✓ VERIFIED | Unchanged since 79b3ba32. |
| `packages/cli/src/index.ts` | cwd git reads gated; `drift --path` sends a raw path | ⚠️ PARTIAL | `git()` gated by `localGitPermitted`. `drift --path` relies on the server gate, which is active when a registry is set (the server requires scopes). Default-off posture open. |
| `packages/collectors/src/install-git-hook.ts` | Corpus hook installer and standalone installer gated under the registry; registration before git; linked-worktree primary check | ✓ VERIFIED (default off, as row 5) | `locate` 111-138: registration before git (116-119), containment (121-125), linked-worktree primary (126-135); `commonGitDir` 79-84; `primaryCheckout` 87-94. Unchanged since a28ecac8 apart from a comment. |
| `packages/corpus/src/discover.ts` | Nested-checkout refusal under a registry | ✓ VERIFIED (cmd 1) | `explore` 207-219 refuses `nested-checkout` with a note and runs no git. `discoverRepos` 349-354 parses the registry and throws on a malformed one. |
| `packages/corpus/src/discover.test.ts` | Named nested-checkout tests | ✓ VERIFIED (cmd 1) | 313-335 (plain directory, 6c) and 336 onward (standalone checkout and linked worktree inside a registered worktrees directory). |
| `packages/collectors/src/git-context.ts`, `muse.ts`, `cursor-stop.ts` | Collector git reads in the session cwd | ℹ️ NOT GATED (not caller-named) | Open under decision 4 if "the CLI" includes collectors. |
| `packages/mcp-server/src/route-policy.ts` | Default-deny declarations | ✓ VERIFIED | Corpus entries, drift, `coord_drift_scan`, worktrees. Stale comment at line 51. |
| `packages/mcp-server/src/service.ts` | Gates and filters | ✓ VERIFIED | 2219-2227 (updateLiveSession), 2275, 4581, 5259-5266, 6695-6838, 7509-7518, 7774-7776 (97defd59 numbering). |
| `packages/mcp-server/src/corpus/service.ts` | Corpus gates | ✓ VERIFIED | 154-168; proof reply 305-313 (decision 1). Unchanged since 9ab6f111. |
| `packages/mcp-server/src/worktree-registry.ts` | `repos` filter in SQL, typed array | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | 390 and 397. See row 8. Unchanged since 79b3ba32. |
| `packages/mcp-server/src/flag-registry.ts`, `docs/config-reference.md`, `.env.example` | Flag descriptions; config reference | ✓ VERIFIED | Changed by 500e4fb3. |
| `docs/worktree-fleet-api.md` | Both flags documented; refusal; strict rule; credential model; gaps | ✓ VERIFIED | Line 149 (scopes and refuse-to-start), 158-159 (corpus CLI and installer accept a registry without scopes), 163 (credential model: recorded open decision). |
| `.planning/REQUIREMENTS.md` HARD-S2 | Requirement text and status | ✓ AMENDED | Line 113 identifier clause amended; identifier clause closed under scopes with the server refuse-to-start. Consistent with MET-where-registry-set; the default-off posture stays open. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| server.ts `POST /drift` | `scopedDriftScan` | server.ts:1586 | ✓ WIRED | Exercised by the routes test (cmd 2). |
| mcp.ts `coord_drift_scan` | `scopedDriftScan` | mcp.ts:2005 | ✓ WIRED | Exercised under scope by the boundary test (cmd 2). |
| server.ts `GET /worktrees` | `listWorktrees(query, surface)` | server.ts:2404 | ✓ WIRED | Exercised by the routes test. |
| mcp.ts `worktree_list` | `listWorktrees(query, callerSurface)` | mcp.ts:2155 | ✓ WIRED | Code. |
| `runWorktree` | `scopeRefusal` | cli/src/worktree/command.ts:557 | ✓ WIRED | Exercised by CLI tests (cmd 1). |
| `runCorpus` | `corpusScopeRefusal` | cli/src/corpus/index.ts:304 | ✓ WIRED | Exercised by corpus scope tests (cmd 1). |
| `runHookCommand` | `installCorpusHooks` / `uninstallCorpusHooks` with registry env | watch-commands.ts | ✓ WIRED | `locate` reads the same env. |
| top-level `git()` | `localGitPermitted` | cli/src/index.ts | ✓ WIRED | Unit-tested by corpus/scope.test.ts (cmd 1). |
| `memoryReplyInGrant` | per-entry repo grant | service.ts:6802-6838 | ✓ WIRED | Exercised by reads-writes test. |
| `updateLiveSession` | `authorizeRepo` before issue or transition | service.ts:2227 | ✓ WIRED (code) | Not reachable for scoped callers through the public routes (default deny first); not exercised under scope (row 18). |
| `installCorpusHooks` | registry gate on the resolved hooks dir and the primary checkout | install-git-hook.ts:121-135 | ✓ WIRED | Covers `core.hooksPath` (5c) and linked worktrees (5d). |
| standalone installer `main()` | registration gate before git | install-git-hook.ts:116-119 | ✓ WIRED | Tested by the ordering test (cmd 1). |
| `loadConfig` | `repoScopeOrRefuse` | config.ts:1274 | ✓ WIRED | Entry point `index.ts:56-69` refuses with exit 1 (test at config.test.ts:838-863). Job runners that call `loadConfig()` also throw `RepoScopesRequiredError` under the same env; they are not the server [INFERENCE: not run]. |
| `discoverRepos` | nested-checkout refusal | discover.ts:207-219 → repo-scope.ts:247-261 | ✓ WIRED | Refuses any nested `.git` under a registration (6c). |
| `scopedGit` | production git call sites | repo-executor.ts | ✗ NOT_WIRED | No production caller. Not a stated Phase 72 criterion; a WARNING. |

### Data-Flow Trace (Level 4)

Not applicable. The phase adds gates and filters, not rendered output.

### Behavioral Spot-Checks

Run from `/root/src/worktrees/as-gsd-v18-all` at HEAD 97defd59, with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun --no-env-file test <files> --timeout 30000`. No test was added or edited. No database was started. No formatter, tsc, lint or full suite was run. Two test commands were used. Output saved at `/root/src/worktrees/backups/gate-tmpfs/f72-cmd1-97defd59.log` and `f72-cmd2-97defd59.log` (outside the repository).

| Behavior | Command (files) | Result | Status |
| -------- | --------------- | ------ | ------ |
| Installer ordering, hooks path, linked-worktree primary (5b-5d), nested-checkout executor and discovery (6, 6b, 6c), corpus and worktree CLI scope, repo-scope unit (cmd 1) | `packages/collectors/src/install-git-hook.test.ts packages/corpus/src/discover.test.ts packages/mcp-server/src/repo-executor.test.ts packages/mcp-server/src/repo-scope.test.ts packages/cli/src/corpus/scope.test.ts packages/cli/src/worktree/scope.test.ts packages/cli/src/corpus/watch-commands.test.ts packages/cli/src/corpus/index.test.ts` | 231 pass, 0 fail, 807 expect() calls, 8 files, 231 tests [19.80s] | ✓ PASS |
| Server scope routes, live-session scope, boundary, reads-writes, worktree registry (in-memory and HTTP), loader and entry-point config, flag registry (cmd 2) | `packages/mcp-server/src/config.test.ts packages/mcp-server/src/flag-registry.test.ts packages/mcp-server/src/repo-scope.routes.test.ts packages/mcp-server/src/live-session-scope.test.ts packages/mcp-server/src/repo-scope.boundary.test.ts packages/mcp-server/src/repo-scope.reads-writes.test.ts packages/mcp-server/src/worktree-registry.test.ts packages/mcp-server/src/worktree-registry.http.test.ts packages/mcp-server/src/worktree-registry.pg.test.ts` | 314 pass, 14 skip, 0 fail, 1099 expect() calls, 9 files, 328 tests [17.52s]. All 14 skips are in worktree-registry.pg.test.ts (`SUBSTRATE_TEST_PG_URL` unset). | ✓ PASS (row 8 skip open) |
| Refuse-to-start, registry without scopes (entry point) | config.test.ts:838-863, spawned `index.ts`: registry set, scopes unset | Exit 1; stderr names both variables and `refused` (cmd 2) | ✓ PASS (test) |
| Refuse-to-start, blank scopes | config.test.ts:804-811 (`""`, `"   "`) | `RepoScopesRequiredError` (cmd 2) | ✓ PASS (test) |
| P1-P5 (nested-checkout probes, parse refusal, server path gate) | Scratch scripts at 9ab6f111, outside the repository | Carried. Code unchanged since 9ab6f111 (checked by git diff); not re-run here (no third bun command). | ✓ CARRIED |
| Row 18 under scope | no test reaches service.ts:2227 under scope | n/a | ? SKIP (open) |
| Row 8 at HEAD | `worktree-registry.pg.test.ts`, `SUBSTRATE_TEST_PG_URL` unset | 14 skipped | ? SKIP (open; orchestrator evidence only) |

Fingerprint: `node /root/.agents/gsd-core/bin/gsd-tools.cjs query verification.fingerprint .planning/phases/72-repo-allowlist-and-scoped-credentials <37 files>`, computed at HEAD 97defd59. The 39 covered files are the prior record's 39 (the phase's PLAN and SUMMARY auto-added). `covered_files` and `covered_digest` are copied from its output.

Debt-marker gate: no TBD, FIXME or XXX in the phase 72 code files (repo-scope.ts, repo-executor.ts, cli worktree/corpus scope.ts, install-git-hook.ts, discover.ts, config.ts, cli corpus/index.ts, corpus/service.ts). No TODO, HACK or PLACEHOLDER in those files; the `PLACEHOLDER` hits in install-git-hook.ts are the hook-template substitution tokens (`__SUBSTRATE_COLLECTORS_SRC__`, `__SUBSTRATE_CLI__`), not stubs.

Probe execution: no probes declared in the PLAN or SUMMARY. The carried P1-P5 are fact checks from 9ab6f111, not Step 7c probes, and were not re-run here.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-S2 (amended, 79b3ba32; identifier clause closed under scopes, 500e4fb3) | 72-01-PLAN.md | Identifier addressing by a path gated to a registration; canonical paths; traversal and symlink rejection; per-surface grants; no repository-specific credential reference required; argv-only git | ⚠️ PARTIAL (default-off posture open) | Containment, grants and argv MET for gated doors (rows 1-7, 9-17, 19-21). Hook directories: `core.hooksPath` (5c) and linked-worktree primary (5d) MET. Nested: decision-6 cases (6b) and plain-directory case (6c) MET. Identifier clause: MET wherever a registry is set (refuse-to-start forces scopes; config.test.ts:794-863). Not MET under the default-off posture (neither variable set): open. |
| HARD-S2 (original, 23bd0733) | 72-01-PLAN.md | Same, plus "resolve least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B" | ✗ UNMET AS WRITTEN | No repository-specific credential reference (surface bearer; config.ts surface token mapping; repo-scope.ts:264-267). |

No orphaned requirements: HARD-S2 is the only phase-72 mapping in REQUIREMENTS.md.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| packages/mcp-server/src/repo-executor.ts | 13 | Comment: "Phase 74 calls this entry point for cross-repository steps". No caller exists; Phase 74 text does not name it. | ⚠️ Warning | Carried forward. |
| packages/mcp-server/src/route-policy.ts | 51 | Comment: memory_search "derived hits are not yet filtered, RS-07". Code filters them (service.ts:6802-6838). | ℹ️ Info | Stale comment contradicts the code. |
| packages/mcp-server/src/live-session-scope.test.ts | 52 | Test name says "refused before the session authority is read"; the refusal is default deny (`not-declared-for-scope`), not the repository gate. | ℹ️ Info | The name overstates the mechanism. Row 18 remains open. |
| packages/mcp-server/src/service.ts | 281-292, ~320 | `corpusRootReply` and `corpusAnchorReply` have no repository gate; protection is the route default deny only. | ℹ️ Info | Fail-closed today. |
| packages/mcp-server/src/server.ts | `/worktrees/report`, `/worktrees/claims` | Default-denied to scoped surfaces. | ⚠️ Warning | Intended fail-closed; operator consequence. |
| packages/cli/src/corpus/watch-commands.ts | hint path | `corpus hint` writes a spool entry for an unregistered path with no git call. | ℹ️ Info | The watch loop ignores hints outside its roots. Not gated at the CLI. |
| packages/mcp-server/src/config.ts callers | job runners (anchor-run.ts, index-run.ts, consistency-run.ts, backfill-run.ts, ...) | `loadConfig()` throws `RepoScopesRequiredError` under registry-without-scopes; the job runners do not catch it. | ℹ️ Info | They fail closed with an uncaught error, not the server's exit-1 message [INFERENCE: not run]. |
| .planning/ROADMAP.md | 1256, 1420 | Phase 72 status line still reads gaps_found, "Open: 6c (BLOCKER ...)", and 23 of 27 at 79b3ba32. | ⚠️ Warning | Orchestrator document; stale against 97defd59. Not edited by this verifier. |
| packages/mcp-server/src/repo-scope.ts | 113-118 | The strict rule refuses a nested `.git` of any repository. P3b shows a different-name nested repository cannot be registered under a registered parent, because the parser refuses the overlap. | ℹ️ Info | Intended by the registry's nesting rule. Owner awareness: a nested repository can be placed only under the same repository name. |

### Advisory (New Scope, Unevidenced)

None. The phase 72 code is unchanged since 9ab6f111. The change since then in the covered files (service.ts) is phase 73 and is judged under that phase.

### Warnings (not roadmap criteria)

- **Scoping is off by default.** Criteria 1 and 2 hold only when a registry or scopes are set. With neither set, the gates are off (repo-scope.ts:290; config.ts `repoScopeOrRefuse`).
- **The corpus CLI and the standalone installer accept a registry without scopes (documented, open).** They gate on the registry alone (`localRegistryScope`, repo-scope.ts:304; install-git-hook.ts:112; cli/src/corpus/scope.ts:40). The server does not: it refuses to start. Documented in docs/worktree-fleet-api.md:158-159 and cli/src/corpus/scope.ts:6.
- **Live sessions are unusable by scoped surfaces.** Consequence of row 21's default deny (a product consequence; no leak).
- **Allowlist unit.** Criterion 1 says "the session's allowlist". Grants are per surface (repo-scope.ts:264-267). Decision 3.
- **Operational prerequisite (PLAN D72-06).** Under scoping, every `SUBSTRATE_WORKTREE_ROOTS` entry must be registered, or every `substrate worktree` command exits 2.
- **Executor not wired.** `scopedGit` has no production caller; Phase 74 does not name it.

### Human Verification Required

1. **Row 11, decision 1: corpus proof disclosure.** Decide whether a granted caller receiving `root`, `treeSize`, `index` and the audit path counts as reading another repository's corpus. Options: accept as allowed, rebuild per repository, or withhold foreign siblings, index and treeSize. **Why human:** a policy reading of "read".
2. **Decision 3, allowlist unit (criterion 1).** Confirm the surface, not the session, is the intended allowlist unit. **Why human:** design decision.
3. **Row 18, service-level live-session gate.** Add a test that reaches service.ts:2227 under scope, or accept the route-level default deny as the criterion's evidence. **Why human:** test-design choice; also a product consequence.
4. **Row 8, Postgres worktree filter.** Run `worktree-registry.pg.test.ts` against a live database at HEAD 97defd59 and record the commit with the run. The orchestrator log (`t-r10c-pg-registry.log`, 12 pass) is not tied to HEAD. **Why human:** database not started here.
5. **Default-off posture.** Decide whether the server's default-off (neither variable set), and the corpus CLI and collector installer accepting a registry without scopes (documented), are acceptable for a deployment that claims criteria 1 and 2. The identifier clause is met wherever a registry is set and is open only under the default-off posture. **Why human:** deployment posture decision.
6. **Decision 4, scope of "the CLI" (collectors).** Decide whether `packages/collectors/src/git-context.ts`, `muse.ts` and `cursor-stop.ts` cwd reads are inside criterion 1. **Why human:** scope of "the CLI".

### Gaps Summary

Status is `human_needed`. No truth is FAILED and no artifact is missing, stub or unwired on the phase's gates. The decision tree's first rule does not fire. Items 1-6 above are human items, not gaps, and keep the status off `passed`: row 11 is uncertain, rows 8 and 18 are present but behavior-unverified.

- **Criterion 1 (verified under scoping, with open items).** The API doors, the `substrate worktree` and `substrate corpus` CLIs, the installer, hook writes (5b-5d) and discovery (6, 6b, 6c) refuse before git when their variables are set. Open: the default-off posture, decision 3, and row 18's service-level gate under scope.
- **Criterion 2 (partial).** Worktrees, corpus, ledger, graphs, docs, writes, reaper, memory and live-session routes are verified. The corpus proof disclosure is open (decision 1). The Postgres worktree filter has orchestrator evidence only. Row 6c is closed: the local CLI no longer reads an unregistered nested repository.
- **HARD-S2 (partial, amended text).** Containment, grants and argv hold for the gated doors. The identifier clause holds wherever a registry is set (refuse-to-start); open under the default-off posture.
- **HARD-S2 (original text).** Unmet as written: no repository-specific credential reference exists. Recorded, not re-decided, since the owner amendment is binding for this record.
- **Closed at 97defd59, with evidence:** 6c (500e4fb3), refuse-to-start (500e4fb3), 5d and 6b (a28ecac8).

Suggested closing order (for the owner; no action taken here): (a) decisions 1 and 3; (b) row 18 test or acceptance; (c) row 8 run at HEAD with a live Postgres; (d) the default-off posture of the server, the corpus CLI and the installer; (e) decision 4; (f) orchestrator documents: ROADMAP.md:1256 and 1420 status lines; the stale comments at repo-executor.ts:13 and route-policy.ts:51.

Not touched here: no code, test or commit changes; scratch files live outside the repository under `/root/src/worktrees/backups/gate-tmpfs/`.

---

_Verified: 2026-11-03T10:26:33Z_
_Verifier: Claude (gsd-verifier, phase 72 re-verification at 97defd59)_
