---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-03T16:04:41Z
status: human_needed
score: "24/27 truth rows verified (row 19 closed at 4b84e50c; 2 present but behavior-unverified: rows 8, 18; 1 uncertain: row 11); success criteria 1 verified under scoping with open items; criterion 2 partial (row 11 disclosure, row 8 Postgres run not at HEAD); HARD-S2 met under scoping, default-off posture open"
covered_files: [".env.example", ".planning/REQUIREMENTS.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-PLAN.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-SUMMARY.md", "docs/config-reference.md", "docs/corpus-watch.md", "docs/worktree-fleet-api.md", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/scope.test.ts", "packages/cli/src/corpus/scope.ts", "packages/cli/src/corpus/watch-commands.ts", "packages/cli/src/index.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.test.ts", "packages/cli/src/worktree/scope.ts", "packages/collectors/src/install-git-hook.test.ts", "packages/collectors/src/install-git-hook.ts", "packages/corpus/src/discover.test.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/gitio.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/live-session-scope.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/repo-executor.test.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/repo-scope.reads-writes.test.ts", "packages/mcp-server/src/repo-scope.routes.test.ts", "packages/mcp-server/src/repo-scope.test.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-registry.ts"]
covered_digest: "v3:sha256:8d03758d5a5a4d0340404263107578f777af8fb63f6575e09998db54e96f7ca9"
behavior_unverified: 2
behavior_unverified_items:
  - truth: "Row 8: Postgres repos filter in worktree-registry.ts (SQL predicate, line 397); orchestrator evidence only, not run at HEAD"
    test: "Run packages/mcp-server/src/worktree-registry.pg.test.ts with SUBSTRATE_TEST_PG_URL set to a live database, at HEAD 4b84e50c"
    expected: "All worktree-registry Postgres tests pass; an empty repos list matches no row; the run is recorded with its commit"
    why_human: "This verifier ran with SUBSTRATE_TEST_PG_URL unset: 14 tests skipped. No database was started here."
  - truth: "Row 18: service-level live-session repository gate (service.ts:2227, authorizeRepo inside updateLiveSession) under scope"
    test: "Issue and transition a live session whose repo_id is not granted, with SUBSTRATE_REPO_REGISTRY and SUBSTRATE_REPO_SCOPES set, calling updateLiveSession directly (not through the public route)"
    expected: "Refused before authority.issue or transition; no session row written"
    why_human: "No test reaches service.ts:2227 under scope. The public routes refuse first by default deny (live-session-scope.test.ts), so the repository gate is never the one that refuses."
overrides_applied: 0
gaps: []
regressions_closed:
  - "Truth 19 at 8a604455 (normalizeKey in grantedToCaller, memory-policy.ts:431; visibleToCaller row side 452-453). Closed at 4b84e50c by exact normalizeIdentifier on both sides. Named regression test passes."
re_verification:
  previous_status: gaps_found
  previous_score: "23/27 (verified at 8a604455, 2026-11-03T15:39:40Z)"
  gaps_closed:
    - "Truth 19 (memory read gate, legacy lone-surrogate repo rows): closed at 4b84e50c."
  gaps_remaining:
    - "Truth 11, corpus proof disclosure. Owner decision 1, open. Human item."
    - "Truth 3, allowlist unit (surface versus session). Owner decision 3, open. Human item."
    - "Truth 18, service-level live-session repository gate under scope: not reached by any test. Open. Human item."
    - "Truth 8, Postgres repos filter: orchestrator evidence only; not run at HEAD (14 entries skipped, SUBSTRATE_TEST_PG_URL unset). Open. Human item."
    - "Default-off posture: with neither scopes nor registry set, scoping is off; the corpus CLI and the collector installer accept a registry without scopes (documented: docs/worktree-fleet-api.md:158-159, cli/src/corpus/scope.ts, install-git-hook.ts:112). Open. Human item."
    - "Decision 4, scope of 'the CLI' for collector cwd reads (git-context.ts, muse.ts, cursor-stop.ts). Not decided. Open. Human item."
    - "Row 19 legacy-row repair (owner data decision: rewrite or leave unmatched). The gate fix does not depend on it. Open. Human item."
  regressions: []
notes: "Re-verified at HEAD 4b84e50c (gsd/v18-int-all). The commit changes memory-policy.ts (6 lines, identifier swaps), memory-policy.test.ts (one added test), index-store.ts (2 lines), memory-write.ts (1 line), session-context.ts (2 lines), types.ts (doc), capsule.ts (2 lines), and service.ts at 2501, 3647, 3735 and 4592 (identifier swaps only; no gate call line changed). Covered-file changes since 8a604455: service.ts only. The 18 other test files of the phase 72 command were carried from the 8a604455 run and not re-run at 4b84e50c."
gaps_summary: "No gaps. Status is human_needed: rows 8, 11 and 18 are unresolved, and the owner decisions listed under human_verification are open."
---

# Phase 72: Repo allowlist and scoped credentials Verification Report

**Phase Goal:** A session can address only the repositories on its allowlist, and each repository's credential is scoped to that repository.
**Verified:** 2026-11-03T16:04:41Z
**Status:** human_needed
**Re-verification:** Yes. Integration tree gsd/v18-int-all at HEAD 4b84e50c. The prior record (gaps_found, 8a604455) is replaced.

**Evidence labels.** "Verified" means the single targeted bun test command this verifier ran at HEAD 4b84e50c (log at `/root/src/worktrees/backups/gate-tmpfs/f72-cmd-4b84e50c.log`, outside the repository), a scratch probe run in that same command (`/root/src/worktrees/backups/gate-tmpfs/f72-probe-4b84e50c.test.ts`, outside the repository), a fingerprint computed at HEAD, or a read of code at that HEAD. "Carried" means evidence from the 8a604455 record whose code is unchanged at 4b84e50c (checked by `git diff 8a604455 4b84e50c --name-only`). "Orchestrator evidence" means a claim the orchestrator supplied, not re-run here. "[INFERENCE]" marks a conclusion no test or probe exercised.

**Criteria source:** `.planning/ROADMAP.md`, Phase 72 section. The success-criteria text is unchanged.
Criteria (verbatim):
1. A repository outside the session's allowlist is refused at the API and the CLI before any git call runs.
2. A credential scoped to one repository cannot read another repository's worktrees or corpus.

**Requirement source:** `.planning/REQUIREMENTS.md:113` (HARD-S2), amended to the surface-bearer model (a147228f), with the identifier clause amended to a path gated to a registration (79b3ba32). The amended text is binding for this record.

**Question asked of this re-verification.** Is the row 19 memory-search regression closed at 4b84e50c (exact-spelling visibility), with the named regression test, and do the open items remain open?

**Answer.** Yes. `grantedToCaller` (memory-policy.ts:429-436) and the row side of `visibleToCaller` (memory-policy.ts:452-453) now compare the exact repo spelling via `normalizeIdentifier`. A stored repo ending in a lone high surrogate is no longer trimmed into its granted neighbour, and a repo that is only a lone surrogate is no longer read as "no repo". The SQL predicate that filters agent rows by repo (index-store.ts:2662) is exact equality, so it agrees. Row 19 is VERIFIED for the input class. The open items are unchanged: rows 8, 11 and 18, decisions 1, 3 and 4, the default-off posture, and the owner's legacy-row repair decision.

## What changed since 8a604455, and why it matters to the gates

1. **The row 19 regression is closed by the comparison, not by the gate.** The gate closure (`authorizeRepo`, which parses through `scopeRepoId`) was never changed, and it already refuses a lone surrogate. The regression was the trim applied to the stored row before the closure was asked. At 4b84e50c the stored value reaches the closure untrimmed, so the closure refuses it.
2. **The door is unchanged in shape.** `memoryReplyInGrant` (service.ts:6813-6835) still calls `grantedToCaller(undefined, entry.repo, granted)` (6820), the `repo:` scope check through `authorizeRepo` (6822), and the derived-hit filter `grantedToCaller(hit.scope, hit.repo, granted)` (6832). `granted` is `memoryGrant(surface)` (`authorizeRepo` wrapper). Only the helper's internal comparison changed.
3. **Keys stay on `normalizeKey` where a trimmed match cannot grant access.** Changes at 4b84e50c: `recallRepo` (service.ts:2501), `callerRepo` (3647), the `recallUncounted` argument (3735) and the memory-verify `reader.repo` (4592) now use `normalizeIdentifier`. The remaining `normalizeKey` sites (queryEvents filter 3296, sessionContext stored key 3973, liveBriefSections 4095, driftScan stored repo 7803) sit behind their gates and do not decide access for a stored row (see row 12, row 20, anti-patterns).
4. **Gate inputs are still parsed by `scopeRepoId`.** `scopeRepoId` (event.ts:650) accepts only `^[a-z0-9._-]+/[a-z0-9._-]+$` after trim and lowercase. A repo with a lone surrogate or non-ASCII yields `""` and is refused by `authorizeRepo`, `authorizeRepoPath`, `localRepoGate`, `scopedRepoRefusal` and the rest. This record's gate verdicts do not depend on the normaliser.
5. **`session_id` is not a gate input.** The session key change affects no scope decision.

## Refusal names at 4b84e50c

The reason codes are unchanged. `REPO_REFUSAL_MESSAGES` (repo-scope.ts) is byte-identical to 8a604455, and `repo-scope.ts`, `repo-executor.ts`, `config.ts`, `route-policy.ts`, `server.ts`, `mcp.ts`, the CLI scope files, `install-git-hook.ts`, `discover.ts` and `corpus/service.ts` are not in the 4b84e50c diff.

| Reason code | Where it is raised | Status vs 8a604455 |
| ----------- | ------------------ | ------------------ |
| `repo-not-granted` | repo-scope.ts:280, 293, 316, 327 (via `isGranted`); `repo-executor.ts:92` | Unchanged |
| `repo-not-registered` | repo-scope.ts:327 (`localRepoGate`) | Unchanged |
| `path-not-registered` | repo-scope.ts `locateRepoPath` | Unchanged |
| `nested-checkout` | repo-scope.ts:113-118, 247-261 | Unchanged |
| `path-repo-mismatch` | repo-scope.ts:294 | Unchanged |
| `all-repos-not-granted` | service.ts `allReposRefusal` (corpus/service.ts:166-168) | Unchanged |
| `graph-repo-unresolved`, `graph-repo-mismatch` | service.ts:6709-6725 (`graphRepoOf`, `scopedGraphRefusal`) | Unchanged |
| `not-declared-for-scope` | server.ts `REST_ROUTE_POLICY`, MCP batch default deny | Unchanged |

Service.ts line numbers are unchanged from 8a604455: the commit swaps identifiers in place (4 insertions, 4 deletions in service.ts). The `memory-policy.ts` change is 6 for 6.

## Verdicts by criterion

| Criterion | Verdict |
| --------- | ------- |
| 1. API and CLI refuse before any git call | ✓ VERIFIED under scoping, with open items. Gate names and reason codes unchanged. Under `SUBSTRATE_REPO_SCOPES`: REST `POST /drift`, MCP `coord_drift_scan`, the worktree routes and `substrate worktree` refuse before git (rows 1-4). Under `SUBSTRATE_REPO_REGISTRY` (the server now also requires scopes): `substrate corpus` (row 5), the standalone installer (5b), hook writes (5c, 5d), discovery's nested-checkout refusal (6, 6b, 6c). Open: the default-off posture; decision 3 (unit is the surface, not the session); row 18 (no test reaches the service-level gate under scope). |
| 2. Scoped credential cannot read another repository's worktrees or corpus | ⚠️ PARTIAL. VERIFIED for worktree lists (row 7), corpus plan, ingest, status, reconcile, root, anchor and proof refusal (rows 9-10), ledger (12), graphs (13), docs (14), writes (15), reaper (16), memory search (19, closed at 4b84e50c), memory verify (20) and the public live-session routes (21). UNCERTAIN for the corpus proof disclosure (row 11, decision 1). The Postgres worktree filter is orchestrator evidence only (row 8). Memory is not a corpus or worktree read, so the literal criterion wording was not broken at 8a604455 either; the grant rule the phase states for memory now holds. |

**HARD-S2 (REQUIREMENTS.md:113), against the amended text (binding for this record):**
- Repository access may be requested by path only where the path resolves to a registered repository: **MET where a registry is set; OPEN under the default-off posture.** A server with a registry cannot start without `SUBSTRATE_REPO_SCOPES` (config.ts:976, index.ts:65-69).
- Canonicalise paths; component-wise roots; traversal and symlink rejection, including after registration: **MET** for the gated doors (repo-scope.ts:121-123 `contains`; 211-229 `resolveContained`; 247-261 `locateRepoPath`; overlap refusal at parse, repo-scope.ts:139-168).
- Repository access granted per surface; every route and tool resolves the caller's surface and refuses an ungranted repository: **MET** for the gated doors (REST default deny, MCP batch default deny, route-policy.ts, repo-scope.ts:264-267 `isGranted`), including the memory door at 4b84e50c.
- Repo A credentials cannot authorise repo B: **MET** for the gated doors, including the row 19 class at 4b84e50c.
- Argv-only git: **MET** for gated paths (repo-executor.ts:51 `spawnSync("git", [...args])`; corpus/src/discover.ts and gitio.ts argv; install-git-hook.ts argv arrays).

**HARD-S2 against the original 23bd0733 text** ("Resolve least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B"): **UNMET AS WRITTEN.** No repository-specific credential reference exists. The credential is a surface bearer token. This is the owner-amended clause, recorded here, not re-decided.

**Decision status:** Open and owner-held: (1) corpus proof disclosure; (3) allowlist unit (surface versus session); row 18 (service-level gate under scope); the default-off posture of scoping, the corpus CLI and the collector installer; (4) scope of "the CLI". The legacy-row repair decision for row 19 (rewrite or leave unmatched) is owner-held and does not block the gate. Recorded, not re-decided: (2) the credential model, as amended in a147228f. Closed and judged earlier, unchanged: 6c (500e4fb3), refuse-to-start (500e4fb3), 5d and 6b (a28ecac8). Closed at 4b84e50c: row 19 regression (exact spelling in visibility and access comparisons).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| 1 | SC1 service: a drift scan naming an ungranted repository, or a path in another repository, is refused before any git call | ✓ VERIFIED | `scopedDriftScan` service.ts:7776; repo gate at 7778 (`authorizeRepo`), then the path gate, both before the scan. Carried from the 8a604455 run; service.ts:7776-7778 unchanged at 4b84e50c. |
| 2a | SC1 REST: `POST /drift` runs the gate before the scan | ✓ VERIFIED | server.ts:1586 `scopedDriftScan`, then refusal (server.ts unchanged). Carried route test. |
| 2b | SC1 MCP: `coord_drift_scan` refuses an ungranted repository before any git call | ✓ VERIFIED | mcp.ts:2005 `scopedDriftScan(request, callerSurface)` (mcp.ts unchanged). Carried boundary test: spies `driftScan` and `Bun.spawnSync`; asserts `repo-not-granted`, zero scan calls. Caveat: the spies do not cover `node:child_process` (repo-executor.ts:51), which is not on this path. |
| 3 | SC1 API: every REST route or MCP tool with no declaration is refused to a scoped caller before its handler | ✓ VERIFIED | REST default deny (server.ts `REST_ROUTE_POLICY`), MCP batch default deny; declarations route-policy.ts (unchanged). Carried "default deny" tests. Decision 3 is a human item. |
| 4 | SC1 CLI: `substrate worktree` refuses an ungranted root, `--repo`, provision target, merge-back or guard path before any git call, exit 2 | ✓ VERIFIED | `runWorktree` calls `scopeRefusal` at cli/src/worktree/command.ts:557 before the dispatch switch (file unchanged). Carried `packages/cli/src/worktree/scope.test.ts`. |
| 5 | SC1 CLI: `substrate corpus` refuses an unregistered `--root`, `--repo` directory, or named `--repo` before any git call or hook write, when the registry is set | ✓ VERIFIED (gated commands; default off) | `runCorpus` calls `corpusScopeRefusal` (cli/src/corpus/index.ts:304) before dispatch. Carried `corpus/scope.test.ts`, `corpus/index.test.ts`, `watch-commands.test.ts`. `hint` writes a spool file and runs no git (documented; not gated). |
| 5b | SC1 CLI: the standalone installer refuses an unregistered repository before any git call or hook write, under a registry | ✓ VERIFIED (default off, as row 5) | install-git-hook.ts `locate` 111-119: `localRegistryScope` (112), registration gate (116-117), then `hooksDir` (119). Carried test "with a registry set, an unregistered repository is refused without spawning git, and nothing is written". |
| 5c | HARD-S2 path clause: a hook write stays inside a registered directory, including after `core.hooksPath` resolution | ✓ VERIFIED | install-git-hook.ts `locate` 121-125. Carried test "core.hooksPath under a repository registry". |
| 5d | HARD-S2 path clause: a hook write from a registered linked worktree stays inside a registered directory | ✓ VERIFIED (closed; owner decision, a28ecac8) | install-git-hook.ts `locate` 126-135, `commonGitDir` 79-84, `primaryCheckout` 87-94. Carried tests pass. |
| 6 | SC1/SC2 path containment: `..`, symlinks and registered roots compared after realpath; overlapping registrations refused at boot | ✓ VERIFIED | repo-scope.ts:121-123 `contains`; 211-229 `resolveContained`; 247-261 `locateRepoPath`; overlap refusal at parse (`parseRepoRegistry`, 139-168). Carried tests. |
| 6b | SC1/SC2: a checkout nested under an admitted root is refused by name before git | ✓ VERIFIED (closed by a28ecac8; strengthened by 500e4fb3) | `nestedCheckoutBetween` (repo-scope.ts:113-118); `locateRepoPath` returns `nested-checkout` at repo-scope.ts:259. Executor: `scopedGit` (repo-executor.ts:86-96). Carried test. |
| 6c | SC1/SC2: a checkout nested under a registered directory that has no `.git` of its own is refused by name, and no git runs in it | ✓ VERIFIED (closed by 500e4fb3, owner decision 2026-11-03: strict rule) | `nestedCheckoutBetween` (repo-scope.ts:113-118, no carve-out for a root without `.git`); `discover.ts` `explore` (207-219). Carried discover.test.ts:313-335. |
| 7 | SC2 worktrees, fake store: an unfiltered scoped list returns only granted rows; a named ungranted repository is refused before the read | ✓ VERIFIED | `listWorktrees` service.ts:5261 (gate 5265, `grantedRepos` 5269); fake filter worktree-registry-fake.ts (unchanged). Carried tests. |
| 8 | SC2 worktrees, Postgres: the list query filters in SQL, and an empty list matches no row | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (ORCHESTRATOR EVIDENCE ONLY; open) | worktree-registry.ts:397 predicate `(${repos}::text[] is null or lower(repo) = any(${repos}::text[]))` (file unchanged). `worktree-registry.pg.test.ts` ran at 4b84e50c with `SUBSTRATE_TEST_PG_URL` unset: 14 tests skipped. Orchestrator evidence from an earlier run is not tied to HEAD. |
| 9 | SC2 corpus: plan, ingest and proof refuse an ungranted repository after parse and before any manifest or plane read | ✓ VERIFIED | `repoRefusalOf` corpus/service.ts:154-163; called at 177 (plan), 207 (ingest), 301 (proof). corpus/service.ts is not in the 4b84e50c diff. Carried test "a proof for an ungranted repository is refused before the corpus manifest is read". |
| 10 | SC2 corpus status, reconcile, root and anchor: refused to scoped callers | ✓ VERIFIED (status and reconcile via `allReposRefusal`; root and anchor via route default deny) | `allReposRefusal` corpus/service.ts:166-168, called at 238 (status) and 259 (reconcile). `/corpus/root` and `/corpus/anchor` have no route-policy entry, so default deny applies. |
| 11 | SC2 corpus proof disclosure: a granted proof reveals no other repository's digests or corpus-wide counts | ? UNCERTAIN (decision 1, open) | Unchanged at 4b84e50c. The proof reply (corpus/service.ts:305-313) carries `root`, `treeSize`, `index`, `leaf`, `sha256` and the audit `path`. The inclusion proof is built over the whole-corpus tree, so sibling hashes and `root` commit to other repositories' `(repo, path, sha256)`. `index` and `treeSize` expose corpus-wide position and count. Whether this is "reading another repository's corpus" is a policy reading. |
| 12 | SC2 ledger: a named ungranted repository is refused before the query; rows are filtered to the grant | ✓ VERIFIED | `queryEventsFor` service.ts:6791 (named gate 6793), then `rowsInGrant` (repo-scope.ts:351-354) on the raw stored value. `rowsInGrant` is unchanged and fails closed on a lone surrogate (probe: `ledgerRowsInGrant 0` for every surrogate class, `1` for `owner/name`). The `queryEvents` repo filter uses `normalizeKey` (service.ts:3296) after the gate. Test `repo-scope.reads-writes.test.ts` carried. |
| 13 | SC2 graphs: a graph's repository is read from its row and must be granted before content is read; no resolvable repository is refused | ✓ VERIFIED | `graphRepoOf` service.ts:6709, `graphGranted` 6802, `scopedGraphRefusal` service.ts:6720 (gate 6725). `graphRepoOf` returns the index row's stored repo, which is checked by `authorizeRepo` (regex), so a legacy repo with a lone surrogate is refused. Carried tests. |
| 14 | SC2 docs: search and LightRAG query refused to every scoped surface before retrieval or fallback | ✓ VERIFIED | `scopedDocsRefusal` service.ts:6740; declared GATED in route-policy.ts. Carried test. |
| 15 | SC2 writes: `events_emit`, `graph_register`, `handoff`, `POST /events` refuse an ungranted or absent target before the write | ✓ VERIFIED | `scopedWriteRefusal` service.ts:6749 (called from server.ts and mcp.ts write doors). New writes cannot carry a lone surrogate in repo (`assertWriteTextFields`, service.ts:3091; event.ts). Carried tests. |
| 16 | SC2 lease reaper: an unnamed reap touches only granted repositories; a named ungranted reap reaps nothing | ✓ VERIFIED | `reapExpiredLeases` service.ts:7511; named gate at 7520 (`authorizeRepo`); unnamed reap against `grantedRepos`. Carried test. |
| 17 | SC2 live sessions, discovery: an unnamed discovery by a scoped caller is refused | ✓ VERIFIED | Gate `scopedRepoRefusal("live_session_discovery", ...)` at service.ts:2275, before `listVisible`. Carried test. |
| 18 | SC2 live sessions, issue and transition: an ungranted `repo_id` is refused before `authority.issue` or `transition` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (the service-level gate; open) | Gate `authorizeRepo(this.config.repoScope, caller.surface, request.repoId)` at service.ts:2227 in `updateLiveSession` (declared 2219), before `authority.issue` and `transition`. The public door refuses first: `live-session-scope.test.ts` asserts `not-declared-for-scope` for the public routes. That is default deny, not the repository gate. No test reaches service.ts:2227 under scope. |
| 19 | SC2 memory search: a scoped caller receives only entries whose scope and own `repo` are both granted | ✓ VERIFIED at 4b84e50c (regression at 8a604455 closed) | Helper and door: `grantedToCaller` memory-policy.ts:429-436 now uses `normalizeIdentifier(repo)` at 431; `visibleToCaller` 446-453 compares `normalizeIdentifier` on both sides for agent rows. Door `memoryReplyInGrant` service.ts:6813-6835 (calls 6820, 6832; unchanged shape). SQL agent-row predicate index-store.ts:2662 is exact `repo = ${agentRepo}`, with `agentRepo` from `normalizeIdentifier` (2650). Named test: `memory-policy.test.ts` "a repo keeps its exact spelling for visibility: a lone high surrogate is not trimmed into the granted repo" passes at 4b84e50c. Scratch probe with the real `authorizeRepo` closure (surface `claude-code` granting `owner/name`), 4 repo classes x 5 scopes: every row with a lone surrogate in repo is refused by `grantedToCaller` and `visibleToCaller` under undefined, `global`, `repo:owner/name`, `repo:owner/name\uD800`, and `agent:claude-code`; `owner/name` is granted under undefined, `global`, `repo:owner/name` and `agent:claude-code`; `repo:owner/name\uD800` scope is refused. Ledger `rowsInGrant` agrees on every class. Door-level coverage is carried (see Warnings). |
| 20 | SC2 memory verify: a scoped caller gets no verdict for an entry of an ungranted repository | ✓ VERIFIED | Gate `authorizeRepo` service.ts:4583 before the reader is built; the reader's repo is `normalizeIdentifier(caller.repo)` (4592) after the gate, and the caller repo is regex-valid when the gate passes. Carried test. |
| 21 | SC1/SC2 live sessions at the public routes: a scoped caller's live-session issue and transition are refused before any session is read or written | ✓ VERIFIED (by default deny; consequence below) | Carried `live-session-scope.test.ts` (3 tests). Live-session routes and `docs_steering_session` are undeclared for scope, so every scoped caller is refused. Consequence: scoped surfaces cannot run live sessions at all. A product consequence, not a leak. |

**Score:** 24 of 27 truth rows verified. Row 19 is VERIFIED at 4b84e50c. Rows 8 and 18 are present but behavior-unverified. Row 11 is uncertain.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/repo-scope.ts` | Pure gate, parsers, local gates, refusal payload, nested-checkout detection | ✓ VERIFIED | Not in the 4b84e50c diff. Gates and reason codes as in the table above. |
| `packages/mcp-server/src/repo-executor.ts` | `scopedGit` executor | ✓ VERIFIED (unit); NOT WIRED | Unchanged. No production caller. Carried as a warning. |
| `packages/mcp-server/src/config.ts` | `repoScope` from env; boot refusal | ✓ VERIFIED | `RepoScopesRequiredError` 967-972; `repoScopeOrRefuse` 975-980; `repoScope: repoScopeOrRefuse(env)` at 1274. Unchanged. |
| `packages/mcp-server/src/index.ts` | Entry point prints the refusal and exits 1 | ✓ VERIFIED | Lines 65-69. Unchanged. |
| `packages/mcp-server/src/config.test.ts` | Loader and entry-point tests | ✓ VERIFIED (carried) | Loader tests 794-831; entry-point spawn test 838-863. |
| `packages/cli/src/corpus/scope.ts` | Corpus CLI gate; cwd-git permit | ✓ VERIFIED (gated commands; default off) | Unchanged. The CLI does not require scopes (documented). |
| `packages/cli/src/corpus/index.ts` | Targets per command, gate before dispatch | ✓ VERIFIED (gated commands) | `corpusScopeRefusal` at 304. Unchanged. |
| `packages/cli/src/corpus/watch-commands.ts` | Hook command passes env and refuses `refused` | ✓ VERIFIED | Unchanged. |
| `packages/cli/src/index.ts` | cwd git reads gated; `drift --path` sends a raw path | ⚠️ PARTIAL | `git()` gated by `localGitPermitted`. `drift --path` relies on the server gate. Default-off posture open. |
| `packages/collectors/src/install-git-hook.ts` | Corpus hook installer and standalone installer gated under the registry | ✓ VERIFIED (default off, as row 5) | Unchanged. |
| `packages/corpus/src/discover.ts` | Nested-checkout refusal under a registry | ✓ VERIFIED | `explore` 207-219. Unchanged. |
| `packages/mcp-server/src/route-policy.ts` | Default-deny declarations | ✓ VERIFIED | Unchanged. Stale comment at line 51 (see anti-patterns). |
| `packages/mcp-server/src/service.ts` | Gates and filters | ✓ VERIFIED | Gate call lines identical to 8a604455. The four 4b84e50c identifier swaps (2501, 3647, 3735, 4592) are not gate calls. The memory door (6813-6835) is unchanged in shape. |
| `packages/mcp-server/src/memory-policy.ts` | Memory row gate `grantedToCaller`, `visibleToCaller` (not in the covered list; read for row 19) | ✓ VERIFIED | Exact `normalizeIdentifier` on the row and caller sides at 431, 452-453. The 8a604455 regression is reverted. |
| `packages/mcp-server/src/memory-policy.test.ts` | Named regression test for row 19 | ✓ VERIFIED (named test passes at 4b84e50c) | Test at lines 358-375. |
| `packages/mcp-server/src/index-store.ts` | Agent-row and repo predicates | ✓ VERIFIED | `agentRepo` 2650 `normalizeIdentifier`; SQL predicate 2662 exact equality; `normalizedRepo` 2682 `normalizeIdentifier`. |
| `packages/mcp-server/src/event.ts` | `scopeRepoId`, `normalizeKey`, write refusals | ✓ VERIFIED | `scopeRepoId` 650-654 unchanged. `normalizeKey` 216-218 (session keys, write keys, post-gate reads). `assertWriteTextFields` on write. Owner items open (see below). |
| `packages/mcp-server/src/corpus/service.ts` | Corpus gates | ✓ VERIFIED | 154-168; proof reply 305-313 (decision 1). Not in the 4b84e50c diff. |
| `packages/mcp-server/src/worktree-registry.ts` | `repos` filter in SQL, typed array | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | 390 and 397. See row 8. Unchanged. |
| `packages/mcp-server/src/flag-registry.ts`, `docs/config-reference.md`, `.env.example` | Flag descriptions; config reference | ✓ VERIFIED | Unchanged. |
| `docs/worktree-fleet-api.md` | Both flags documented; refusal; strict rule; credential model; gaps | ✓ VERIFIED | Lines 149, 158-159, 163. Unchanged. |
| `.planning/REQUIREMENTS.md` HARD-S2 | Requirement text and status | ✓ VERIFIED (not edited here) | Line 134 (status column). |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| server.ts `POST /drift` | `scopedDriftScan` | server.ts:1586 | ✓ WIRED | Exercised by the carried routes test. |
| mcp.ts `coord_drift_scan` | `scopedDriftScan` | mcp.ts:2005 | ✓ WIRED | Exercised under scope by the carried boundary test. |
| server.ts `GET /worktrees` | `listWorktrees(query, surface)` | server.ts:2404 | ✓ WIRED | Carried routes test. |
| mcp.ts `worktree_list` | `listWorktrees(query, callerSurface)` | mcp.ts:2155 | ✓ WIRED | Code. |
| `runWorktree` | `scopeRefusal` | cli/src/worktree/command.ts:557 | ✓ WIRED | Carried CLI tests. |
| `runCorpus` | `corpusScopeRefusal` | cli/src/corpus/index.ts:304 | ✓ WIRED | Carried corpus scope tests. |
| `runHookCommand` | `installCorpusHooks` / `uninstallCorpusHooks` with registry env | watch-commands.ts | ✓ WIRED | `locate` reads the same env. |
| top-level `git()` | `localGitPermitted` | cli/src/index.ts | ✓ WIRED | Carried corpus/scope.test.ts. |
| `memoryReplyInGrant` | per-entry repo grant | service.ts:6813-6832 via memory-policy.ts:431 | ✓ WIRED | Row side now exact; the repo-scope and derived checks are unchanged. Behavior: see row 19. |
| `mergeDerivedHits` | `visibleToCaller` | memory-search.ts:46 | ✓ WIRED | Row side and caller side both exact at 4b84e50c. |
| `updateLiveSession` | `authorizeRepo` before issue or transition | service.ts:2227 | ✓ WIRED (code) | Not reachable for scoped callers through the public routes (default deny first); not exercised under scope (row 18). |
| `installCorpusHooks` | registry gate on the resolved hooks dir and the primary checkout | install-git-hook.ts:121-135 | ✓ WIRED | Covers `core.hooksPath` (5c) and linked worktrees (5d). |
| standalone installer `main()` | registration gate before git | install-git-hook.ts:116-119 | ✓ WIRED | Carried ordering test. |
| `loadConfig` | `repoScopeOrRefuse` | config.ts:1274 | ✓ WIRED | Entry point `index.ts:56-69` refuses with exit 1. Job runners that call `loadConfig()` also throw `RepoScopesRequiredError` under the same env; they are not the server [INFERENCE: not run]. |
| `discoverRepos` | nested-checkout refusal | discover.ts:207-219 -> repo-scope.ts:247-261 | ✓ WIRED | Refuses any nested `.git` under a registration (6c). |
| `scopedGit` | production git call sites | repo-executor.ts | ✗ NOT_WIRED | No production caller. Not a stated Phase 72 criterion; a WARNING. |

### Data-Flow Trace (Level 4)

Not applicable. The phase adds gates and filters, not rendered output.

### Behavioral Spot-Checks

One targeted command was run, from `/root/src/worktrees/as-gsd-v18-all` at HEAD 4b84e50c:
`env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun --no-env-file test packages/mcp-server/src/memory-policy.test.ts /root/src/worktrees/backups/gate-tmpfs/f72-probe-4b84e50c.test.ts -t "a repo keeps its exact spelling for visibility|probe 4b84e50c" --timeout 30000`.

Result: **2 pass, 41 filtered out, 0 fail, 33 expect() calls.** The two selected tests: the named regression test in `memory-policy.test.ts` and the scratch probe. The probe output is at the log path above.

Probe (scratch file outside the repository; `repoScopeFromEnv` with `SUBSTRATE_REPO_SCOPES={"claude-code":["owner/name"]}`; grant closure = `authorizeRepo(scope, "claude-code", repo).ok`; caller `{ surface: "claude-code", repo: "owner/name" }`):

| Raw repo | grantedToCaller, any scope | visibleToCaller, agent scope | Ledger `rowsInGrant` |
| -------- | -------------------------- | ---------------------------- | -------------------- |
| `owner/name\ud800` | refused (undef, global, `repo:owner/name`, `repo:owner/name\ud800`, `agent:claude-code`) | refused | 0 |
| `\ud800` | refused (all five scopes) | refused | 0 |
| `other/repo\ud800` | refused (all five scopes) | refused | 0 |
| `owner/name` | granted (undef, global, `repo:owner/name`, `agent:claude-code`); refused under `repo:owner/name\ud800` | granted | 1 |

Probe assertions held. The 8a604455 failure rows (`owner/name\ud800` and `\ud800` granted under global scope) are now refused.

**Not re-run at 4b84e50c** (one-command limit for this pass): the 18 other test files of the phase 72 command (config, repo-executor, repo-scope and its boundary, routes, reads-writes and live-session-scope tests; flag-registry; worktree-registry, http and pg tests; cli worktree and corpus scope tests; corpus watch-commands and index tests; install-git-hook; discover; event.test.ts). Their results are carried from the 8a604455 record. Changes at 4b84e50c that touch those tests' subjects are the identifier swaps listed above; none is a gate call line.

**Named test fails before the fix [INFERENCE]:** before the fix, `grantedToCaller` used `normalizeKey`, which trims the lone high surrogate of `owner/name\uD83D` to `owner/name`. With the equality grant closure in the test, `granted("owner/name")` is true, so `grantedToCaller("repo:owner/name", legacy, granted)` returns true and the test's `toBe(false)` assertion fails. This was not re-run against 8a604455 in this pass.

Fingerprint: `node /root/.agents/gsd-core/bin/gsd-tools.cjs query verification.fingerprint .planning/phases/72-repo-allowlist-and-scoped-credentials <39 covered files>` at HEAD 4b84e50c; output `/root/src/worktrees/backups/gate-tmpfs/f72-fingerprint-4b84e50c.json`. `covered_digest` is copied from it. The covered list is the 8a604455 list (39 files). The only covered file changed since 8a604455 is `service.ts`.

Debt-marker gate: `git show 4b84e50c` adds no TBD, FIXME, XXX, TODO, HACK or PLACEHOLDER line. The phase 72 code files carry none (as in 8a604455).

Probe execution: no probes declared in the PLAN or SUMMARY. The carried P1-P5 are fact checks from 9ab6f111, not Step 7c probes, and were not re-run here (code unchanged).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-S2 (amended, 79b3ba32; identifier clause closed under scopes, 500e4fb3) | 72-01-PLAN.md | Identifier addressing by a path gated to a registration; canonical paths; traversal and symlink rejection; per-surface grants; no repository-specific credential reference required; argv-only git | ⚠️ PARTIAL (default-off posture open; row 11 and row 8 unresolved) | Containment, grants and argv MET for gated doors (rows 1-7, 9-17, 19-21). Hook directories 5c and 5d MET. Nested 6b and 6c MET. Identifier clause MET wherever a registry is set. Row 19 (memory grant for legacy lone-surrogate rows) MET at 4b84e50c. |
| HARD-S2 (original, 23bd0733) | 72-01-PLAN.md | Same, plus "resolve least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B" | ✗ UNMET AS WRITTEN | No repository-specific credential reference (surface bearer; config.ts surface token mapping; repo-scope.ts:264-267). |

No orphaned requirements: HARD-S2 is the only phase-72 mapping in REQUIREMENTS.md.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| packages/mcp-server/src/memory-policy.ts | 431, 452-453 | Row-side repo compared after `normalizeKey` at 8a604455 | ✓ Resolved at 4b84e50c | Exact `normalizeIdentifier` on both sides. |
| packages/mcp-server/src/memory-policy.test.ts; repo-scope.reads-writes.test.ts | n/a | The named test (equality grant closure) covers `owner/name\uD83D` at the helper level. No test runs a lone-surrogate row, or a repo that is only a lone surrogate, through `memoryReplyInGrant` with the real `authorizeRepo` closure. | ⚠️ Warning | Door-level coverage for the row 19 class is by code reading and the helper-level probe [INFERENCE]. The recommended door test (a legacy `owner/name\ud800` row and a global `\ud800` row, both refused to a caller granted `owner/name`) is not in the repository. |
| packages/mcp-server/src/service.ts | 3296, 3973, 4095, 7803 | `normalizeKey` on read-side keys and stored keys after their gates | ℹ️ Info | Each sits behind a gate that refuses a lone surrogate before the key is used for access (queryEventsFor 6791-6795 via rowsInGrant; sessionContext door 3970s; liveBriefSections guarded by `scopeRepoId`; driftScan behind 7778). |
| packages/mcp-server/src/service.ts | 7803 (`?? repo`), 3973 (`?? request.repoId`) | `normalizeKey(x) ?? x` keeps a raw value when normalisation yields null | ℹ️ Info | Checked: both sit behind gates that refuse a lone surrogate (regex). No unrefused path. |
| packages/mcp-server/src/repo-executor.ts | 13 | Comment: "Phase 74 calls this entry point for cross-repository steps". No caller exists. | ⚠️ Warning | Carried forward. |
| packages/mcp-server/src/route-policy.ts | 51 | Comment: memory_search "derived hits are not yet filtered, RS-07". Code filters them (service.ts:6832). | ℹ️ Info | Stale comment contradicts the code. |
| packages/mcp-server/src/live-session-scope.test.ts | 52 | Test name says "refused before the session authority is read"; the refusal is default deny (`not-declared-for-scope`), not the repository gate. | ℹ️ Info | The name overstates the mechanism. Row 18 remains open. |
| packages/mcp-server/src/service.ts | 281-292, ~320 | `corpusRootReply` and `corpusAnchorReply` have no repository gate; protection is the route default deny only. | ℹ️ Info | Fail-closed today. |
| packages/mcp-server/src/server.ts | `/worktrees/report`, `/worktrees/claims` | Default-denied to scoped surfaces. | ⚠️ Warning | Intended fail-closed; operator consequence. |
| packages/cli/src/corpus/watch-commands.ts | hint path | `corpus hint` writes a spool entry for an unregistered path with no git call. | ℹ️ Info | The watch loop ignores hints outside its roots. Not gated at the CLI. |
| packages/mcp-server/src/config.ts callers | job runners (anchor-run.ts, index-run.ts, consistency-run.ts, backfill-run.ts, ...) | `loadConfig()` throws `RepoScopesRequiredError` under registry-without-scopes; the job runners do not catch it. | ℹ️ Info | They fail closed with an uncaught error, not the server's exit-1 message [INFERENCE: not run]. |
| packages/mcp-server/src/repo-scope.ts | 113-118 | The strict rule refuses a nested `.git` of any repository. | ℹ️ Info | Intended by the registry's nesting rule. |
| .planning/ROADMAP.md | Phase 72 status lines | Still reads gaps_found and the 8a604455 counts. | ⚠️ Warning | Orchestrator document; stale. Not edited by this verifier. |

### Advisory (New Scope, Unevidenced)

None.

### Warnings (not roadmap criteria)

- **Row 19 door-level test is absent.** The verdict rests on the named helper test, the probe with the real grant closure, and the code read of `memoryReplyInGrant` and the SQL predicate. Add the door-level test the 8a604455 gap recommended. This is a warning, not a blocker: the code path that decides access now refuses the class.
- **Scoping is off by default.** Criteria 1 and 2 hold only when a registry or scopes are set. With neither set, the gates are off (repo-scope.ts:290; config.ts `repoScopeOrRefuse`).
- **The corpus CLI and the standalone installer accept a registry without scopes (documented, open).** They gate on the registry alone (`localRegistryScope`, repo-scope.ts:304; install-git-hook.ts:112; cli/src/corpus/scope.ts). The server does not: it refuses to start.
- **Live sessions are unusable by scoped surfaces.** Consequence of row 21's default deny (a product consequence; no leak).
- **Allowlist unit.** Criterion 1 says "the session's allowlist". Grants are per surface (repo-scope.ts:264-267). Decision 3.
- **Operational prerequisite (PLAN D72-06).** Under scoping, every `SUBSTRATE_WORKTREE_ROOTS` entry must be registered, or every `substrate worktree` command exits 2.
- **Executor not wired.** `scopedGit` has no production caller.
- **Owner items from the 4b84e50c commit, open and not re-decided.** `event.ts` keeps the trimmed repo in ledger rows written with scope off (an over-long repo cut at the 512-unit cap can leave a dangling high surrogate, which is then stored trimmed). [INFERENCE] A trimmed value of 511 units or more cannot equal a granted name shorter than 511 units, so no current grant is reached by this path. Pre-existing straddling rows (session_id, repo, branch, node_id, linear_identifier) remain open data items. branch, node_id and linear_identifier still cut at 512 units without the trim (W-L3b). Checkpoint_verify session_id is not normalised (W-K1). graph_index.repo raw write (W-K3, Postgres). Commit-body wording on the tip read for graph_id on unkeyed sessioned writes (W-O1). The transport stores a lone high surrogate as U+FFFD in the URLSearchParams path, and such rows already fail verifyChain. None of these is a phase 72 row, and none is closed here.

### Human Verification Required

1. **Row 11, decision 1: corpus proof disclosure.** Decide whether a granted caller receiving `root`, `treeSize`, `index` and the audit path counts as reading another repository's corpus. Options: accept as allowed, rebuild per repository, or withhold foreign siblings, index and treeSize. **Why human:** a policy reading of "read".
2. **Decision 3, allowlist unit (criterion 1).** Confirm the surface, not the session, is the intended allowlist unit. **Why human:** design decision.
3. **Row 18, service-level live-session gate.** Add a test that reaches service.ts:2227 under scope, or accept the route-level default deny as the criterion's evidence. **Why human:** test-design choice; also a product consequence.
4. **Row 8, Postgres worktree filter.** Run `worktree-registry.pg.test.ts` against a live database at HEAD 4b84e50c and record the commit with the run. **Why human:** database not started here.
5. **Default-off posture.** Decide whether the server's default-off, and the corpus CLI and collector installer accepting a registry without scopes (documented), are acceptable for a deployment that claims criteria 1 and 2. **Why human:** deployment posture decision.
6. **Decision 4, scope of "the CLI" (collectors).** Decide whether `packages/collectors/src/git-context.ts`, `muse.ts` and `cursor-stop.ts` cwd reads are inside criterion 1. **Why human:** scope of "the CLI".
7. **Row 19 repair of legacy rows (owner, not the gate).** The gate is correct at 4b84e50c for legacy rows; the owner decides whether legacy rows with a dangling surrogate in repo are repaired (rewritten to their normalised form, or left unmatched) or left as they are. **Why human:** data decision; the gate fix does not depend on it.

### Gaps Summary

Status is `human_needed`. No truth is FAILED, no artifact is missing or a stub, no key link is NOT_WIRED on a stated criterion, and no blocker anti-pattern remains. Rule 2 fires: rows 8 and 18 are present but behavior-unverified, row 11 is uncertain, and the owner decisions above are open.

- **Row 19 (closed at 4b84e50c).** The 8a604455 regression is reverted: `grantedToCaller` and the row side of `visibleToCaller` compare exact repo spellings, so a legacy row with a lone high surrogate on its repo is refused to a caller granted the trimmed name, and a repo that is only a lone surrogate is refused under global scope. The named test passes at HEAD, and the probe with the real grant closure agrees.
- **Criterion 1 (verified under scoping, with open items).** The API doors, the `substrate worktree` and `substrate corpus` CLIs, the installer, hook writes (5b-5d) and discovery (6, 6b, 6c) refuse before git when their variables are set, by the same reason codes as at 8a604455. Open: the default-off posture, decision 3, and row 18's service-level gate under scope.
- **Criterion 2 (partial).** Worktrees, corpus, ledger, graphs, docs, writes, reaper, memory search, memory verify and live-session routes are verified. Open: the corpus proof disclosure (decision 1) and the Postgres worktree filter (row 8, not run at HEAD).
- **HARD-S2 (partial, amended text).** Containment, grants and argv hold for the gated doors, including the memory door. The identifier clause holds wherever a registry is set; open under the default-off posture.
- **HARD-S2 (original text).** Unmet as written: no repository-specific credential reference exists. Recorded, not re-decided.
- **Closed at 4b84e50c, with evidence:** row 19 (exact spelling in visibility and access comparisons). Earlier closures unchanged: 6c (500e4fb3), refuse-to-start (500e4fb3), 5d and 6b (a28ecac8).

Suggested next steps (for the owner and orchestrator; no action taken here): (a) add the door-level memory test for the lone-surrogate classes (warning above); (b) decisions 1 and 3; (c) row 18 test or acceptance; (d) row 8 run at HEAD with a live Postgres; (e) the default-off posture of the server, the corpus CLI and the installer; (f) decision 4; (g) row 19 legacy-row repair decision; (h) orchestrator documents: ROADMAP.md phase 72 status lines and the stale comments at repo-executor.ts:13 and route-policy.ts:51.

Not touched here: no code, test or commit changes; the probe and logs live outside the repository under `/root/src/worktrees/backups/gate-tmpfs/`. Sibling VERIFICATION.md files that appear modified in the worktree (phases 71, 73, 75, 76, 77, 78) are other agents' writes and were not touched.

---

_Verified: 2026-11-03T16:04:41Z_
_Verifier: Claude (gsd-verifier, phase 72 re-verification at 4b84e50c)_
