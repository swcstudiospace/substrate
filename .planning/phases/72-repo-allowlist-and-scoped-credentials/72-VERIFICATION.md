---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-05T00:13:07Z
status: human_needed
score: "26/27 truth rows verified (row 8 observed at c40ffc9a on scratch Postgres 16; 1 uncertain: row 11); success criteria 1 verified under scoping with open items; criterion 2 partial (row 11 disclosure); HARD-S2 met under scoping, default-off posture open"
covered_files: [".env.example", ".planning/REQUIREMENTS.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-PLAN.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-SUMMARY.md", "docs/config-reference.md", "docs/corpus-watch.md", "docs/worktree-fleet-api.md", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/scope.test.ts", "packages/cli/src/corpus/scope.ts", "packages/cli/src/corpus/watch-commands.ts", "packages/cli/src/index.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.test.ts", "packages/cli/src/worktree/scope.ts", "packages/collectors/src/install-git-hook.test.ts", "packages/collectors/src/install-git-hook.ts", "packages/corpus/src/discover.test.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/gitio.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/live-session-scope.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/repo-executor.test.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/repo-scope.reads-writes.test.ts", "packages/mcp-server/src/repo-scope.routes.test.ts", "packages/mcp-server/src/repo-scope.test.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-registry.ts"]
covered_digest: "v3:sha256:be33ed296a512f3906ae3f791152d20ce61bdd948be6ca71d0f623eac6c40faa"
behavior_unverified: 0
overrides_applied: 0
gaps: []
regressions_closed:
  - "Row 8 (Postgres worktree list filter), observed at c40ffc9a: worktree-registry.pg.test.ts 13 pass, 0 fail, against scratch Postgres 16 (database substrate_test_v72, 127.0.0.1:5439). Carried from the 9e71f263 observation, now re-run at the current head."
re_verification:
  previous_status: human_needed
  previous_score: "26/27 (verified at 9e71f263, 2026-11-04T23:00:35Z)"
  gaps_closed: []
  gaps_remaining:
    - "Row 11, corpus proof disclosure. Owner decision 1, open. Human item."
    - "Row 3 / criterion 1, allowlist unit (surface versus session). Owner decision 3, open. Human item."
    - "Default-off posture: with neither scopes nor registry set, scoping is off; the corpus CLI and the collector installer accept a registry without scopes (documented). Open. Human item."
    - "Decision 4, scope of 'the CLI' for collector cwd reads (git-context.ts, muse.ts, cursor-stop.ts). Not decided. Open. Human item."
    - "Row 19 legacy-row repair (owner data decision: rewrite or leave unmatched). The gate fix does not depend on it. Open. Human item."
  regressions: []
notes: "Re-verified at HEAD c40ffc9a (gsd/v18-int-all). Since 9e71f263 the commits are 2c9ba219, 7a2383dc (docs re-verification records for other phases), 1e17db11, bdc1dc1a, 3c5dcfa0, 11a32402, ebabe6ef, a4a9a8f0, 75d2ce56, db4f98f6, 178db423 and c40ffc9a. Seven covered files changed in that range (git diff --name-only 9e71f263 c40ffc9a intersected with covered_files): .env.example, .planning/REQUIREMENTS.md, docs/config-reference.md, docs/worktree-fleet-api.md, packages/mcp-server/src/config.ts, packages/mcp-server/src/flag-registry.ts, packages/mcp-server/src/service.ts. Their diffs are audited below; none changes a phase 72 gate or a HARD-S2 clause. covered_digest changed from the 9e71f263 record because those files' content changed; the covered list is the same 39 entries."
human_verification:
  - test: "Row 11, decision 1: corpus proof disclosure. Decide whether a granted caller receiving root, treeSize, index and the audit path counts as reading another repository's corpus. Options: accept as allowed, rebuild per repository, or withhold foreign siblings, index and treeSize."
    expected: "A recorded owner decision on whether the proof reply is inside criterion 2."
    why_human: "A policy reading of 'read'."
  - test: "Decision 3, allowlist unit (criterion 1). Confirm the surface, not the session, is the intended allowlist unit."
    expected: "A recorded owner decision."
    why_human: "Design decision."
  - test: "Default-off posture. Decide whether the server's default-off, and the corpus CLI and collector installer accepting a registry without scopes (documented), are acceptable for a deployment that claims criteria 1 and 2."
    expected: "A recorded owner decision."
    why_human: "Deployment posture decision."
  - test: "Decision 4, scope of 'the CLI' (collectors). Decide whether packages/collectors/src/git-context.ts, muse.ts and cursor-stop.ts cwd reads are inside criterion 1."
    expected: "A recorded owner decision."
    why_human: "Scope of 'the CLI'."
  - test: "Row 19 repair of legacy rows. The gate is correct for legacy rows; the owner decides whether legacy rows with a dangling surrogate in repo are repaired or left unmatched."
    expected: "A recorded owner decision."
    why_human: "Data decision."
---

# Phase 72: Repo allowlist and scoped credentials Verification Report

**Phase Goal:** A session can address only the repositories on its allowlist, and each repository's credential is scoped to that repository.
**Verified:** 2026-11-05T00:13:07Z
**Status:** human_needed
**Re-verification:** Yes. Integration tree gsd/v18-int-all at HEAD c40ffc9a. The prior record (human_needed, 9e71f263) is replaced.

**Evidence labels.** "Observed" means a command run by this verifier at HEAD c40ffc9a. "Carried" means evidence from an earlier record whose covered code is unchanged between 9e71f263 and c40ffc9a (checked with `git diff --name-only 9e71f263 c40ffc9a` against covered_files, and by reading the diff of each covered file that did change). "[INFERENCE]" marks a conclusion no test exercised.

**Criteria source:** `.planning/ROADMAP.md`, Phase 72 section. The success-criteria text is unchanged.
Criteria (verbatim):
1. A repository outside the session's allowlist is refused at the API and the CLI before any git call runs.
2. A credential scoped to one repository cannot read another repository's worktrees or corpus.

**Requirement source:** `.planning/REQUIREMENTS.md` (HARD-S2, line 113), amended to the surface-bearer model (a147228f), with the identifier clause amended to a path gated to a registration (79b3ba32). The amended text is binding for this record. The wave-6 edits to REQUIREMENTS.md touch only the ATLAS-01 and ATLAS-03 lines (owner decision, 2026-11-04); line 113 is unchanged.

**Question asked of this re-verification.** Is the Postgres worktree list filter (row 8) still observed at the current head, and does anything in wave 6 (9e71f263 to c40ffc9a) break a gate?

**Answer.** Row 8 is observed at c40ffc9a: the Postgres-gated worktree registry test passes on a live database (13 pass, 0 fail). No phase 72 gate changed. The wave-6 change to `service.ts` is telemetry and a one-line docs ingest hook; the gate functions are unchanged. Row 11 remains uncertain. Decisions 1, 3 and 4, and the default-off posture, remain open.

## Targeted runs at c40ffc9a

1. Postgres (SUBSTRATE_TEST_PG_URL set to scratch Postgres 16, 127.0.0.1:5439, database `substrate_test_v72`; credentials not recorded here; TMPDIR=/root/src/worktrees/backups/gate-tmpfs): `packages/mcp-server/src/worktree-registry.pg.test.ts` gives 13 pass, 0 fail, 42 expect() calls, 13 tests in 1 file, none skipped. This is the only Postgres-gated file in the phase's evidence (row 8). Scratch Postgres, not production. Log: `/tmp/f72-pg-c40ffc9a.log`.
2. `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/live-session-scope.test.ts packages/mcp-server/src/repo-scope.boundary.test.ts` gives 19 pass, 0 fail, 43 expect() calls. Log: `/tmp/f72-cmd1-c40ffc9a.log`.
3. `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/memory-policy.test.ts packages/mcp-server/src/worktree-registry.test.ts` gives 126 pass, 0 fail, 327 expect() calls. Log: `/tmp/f72-cmd2-c40ffc9a.log`.

## Wave 6 diffs to covered files (audited)

| File | Change since 9e71f263 | Effect on phase 72 |
| ---- | ---------------------- | ------------------ |
| `packages/mcp-server/src/service.ts` | (a) line 2961: `corpusSlo.recordSyncLag(...)` added in the docs ingest path; (b) lines 6395 and 6421-6426: `recordRetrieval` is always called and takes an `isPrivate` flag for the telemetry row | None on a gate. Every line after 2960 moves down one: the gates below are cited at their new lines. The telemetry change runs after the answer is built and only writes a row; docs search and LightRAG query are refused to every scoped surface before retrieval (mcp.ts:1584, 1802; route-policy.ts:35-36), and the steering route is undeclared, so default deny applies to scoped callers. |
| `packages/mcp-server/src/flag-registry.ts` | New `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` row; `SUBSTRATE_WORKTREE_ROOTS` description (dispatcher reads it) | None. The `SUBSTRATE_REPO_SCOPES` and `SUBSTRATE_REPO_REGISTRY` rows are unchanged. |
| `packages/mcp-server/src/config.ts` | Comment on `docsSlo` only | None. |
| `.env.example`, `docs/config-reference.md`, `docs/worktree-fleet-api.md` | Documentation of the sync-lag threshold and of the dispatcher reading `SUBSTRATE_WORKTREE_ROOTS` | None. The phase 72 rows (`SUBSTRATE_REPO_SCOPES`, `SUBSTRATE_REPO_REGISTRY`, the default-off text) are unchanged. |
| `.planning/REQUIREMENTS.md` | ATLAS-01 and ATLAS-03 text (owner decision 2026-11-04) | None. HARD-S2 at line 113 is unchanged. |

Files changed since 9e71f263 that are not covered are carried, not re-audited: `packages/mcp-server/src/worktree-registry.ts` is covered and unchanged (row 8 predicate at line 401).

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1 service: a drift scan naming an ungranted repository, or a path in another repository, is refused before any git call | ✓ VERIFIED | `scopedDriftScan` service.ts:7803; repo gate (`authorizeRepo`) and path gate (`authorizeRepoPath`) both before `driftScan`. Carried; the function body is unchanged (wave-6 hunks are at 2961 and 6395-6426 only). |
| 2a  | SC1 REST: `POST /drift` runs the gate before the scan | ✓ VERIFIED | server.ts:1586 `scopedDriftScan`. Carried routes test. server.ts unchanged. |
| 2b  | SC1 MCP: `coord_drift_scan` refuses an ungranted repository before any git call | ✓ VERIFIED | mcp.ts:2014 `scopedDriftScan(request, callerSurface)`. Carried boundary test. mcp.ts unchanged. |
| 3   | SC1 API: every REST route or MCP tool with no declaration is refused to a scoped caller before its handler | ✓ VERIFIED | REST default deny (server.ts:965, `REST_ROUTE_POLICY`); MCP batch default deny; declarations in route-policy.ts. Carried. Decision 3 is a human item. |
| 4   | SC1 CLI: `substrate worktree` refuses an ungranted root, `--repo`, provision target, merge-back or guard path before any git call, exit 2 | ✓ VERIFIED | `runWorktree` calls `scopeRefusal` (cli/src/worktree/command.ts:557) before dispatch. Carried `packages/cli/src/worktree/scope.test.ts`. |
| 5   | SC1 CLI: `substrate corpus` refuses an unregistered `--root`, `--repo` directory, or named `--repo` before any git call or hook write, when the registry is set | ✓ VERIFIED (gated commands; default off) | `runCorpus` calls `corpusScopeRefusal` (cli/src/corpus/index.ts:304) before dispatch. Carried. `hint` writes a spool file and runs no git (documented; not gated). |
| 5b  | SC1 CLI: the standalone installer refuses an unregistered repository before any git call or hook write, under a registry | ✓ VERIFIED (default off, as row 5) | install-git-hook.ts `locate` gate. Carried test. |
| 5c  | HARD-S2 path clause: a hook write stays inside a registered directory, including after `core.hooksPath` resolution | ✓ VERIFIED | install-git-hook.ts `locate`. Carried test. |
| 5d  | HARD-S2 path clause: a hook write from a registered linked worktree stays inside a registered directory | ✓ VERIFIED (closed; owner decision, a28ecac8) | install-git-hook.ts `locate`, `commonGitDir`, `primaryCheckout`. Carried tests. |
| 6   | SC1/SC2 path containment: `..`, symlinks and registered roots compared after realpath; overlapping registrations refused at boot | ✓ VERIFIED | repo-scope.ts: `contains`, `resolveContained`, `locateRepoPath`; overlap refusal at parse (`parseRepoRegistry`). Carried. |
| 6b  | SC1/SC2: a checkout nested under an admitted root is refused by name before git | ✓ VERIFIED (closed by a28ecac8) | `nestedCheckoutBetween` (repo-scope.ts:113-118); `locateRepoPath` `nested-checkout`; executor `scopedGit`. Carried. |
| 6c  | SC1/SC2: a checkout nested under a registered directory that has no `.git` of its own is refused by name, and no git runs in it | ✓ VERIFIED (closed by 500e4fb3) | `nestedCheckoutBetween` (no carve-out); `discover.ts` `explore`. Carried discover test. |
| 7   | SC2 worktrees, fake store: an unfiltered scoped list returns only granted rows; a named ungranted repository is refused before the read | ✓ VERIFIED (observed at c40ffc9a) | `listWorktrees` service.ts:5264 (gate, `grantedRepos`); `worktree-registry.test.ts` passes in targeted run 3. |
| 8   | SC2 worktrees, Postgres: the list query filters in SQL, and an empty list matches no row | ✓ VERIFIED (observed at c40ffc9a, scratch Postgres 16) | Predicate worktree-registry.ts:401 `(${repos}::text[] is null or lower(repo) = any(${repos}::text[]))`. `worktree-registry.pg.test.ts` run 1: 13 pass, 0 fail; the named test "a listing with a repos filter returns only the rows of the listed repositories, and an empty list returns none" passes. Not skipped (`SUBSTRATE_TEST_PG_URL` set). |
| 9   | SC2 corpus: plan, ingest and proof refuse an ungranted repository after parse and before any manifest or plane read | ✓ VERIFIED | `repoRefusalOf` corpus/service.ts:157; called at 205 (plan), 235 (ingest, before the tombstone check), 331 (proof). corpus/service.ts unchanged since 9e71f263. Ingest-tombstone tests in `repo-scope.boundary.test.ts` pass in targeted run 2. |
| 10  | SC2 corpus status, reconcile, root and anchor: refused to scoped callers | ✓ VERIFIED (status and reconcile via `allReposRefusal`; root and anchor via route default deny) | `allReposRefusal` corpus/service.ts:169, called at 268 (status) and 289 (reconcile). `/corpus/root` and `/corpus/anchor` have no route-policy entry, so default deny applies. |
| 11  | SC2 corpus proof disclosure: a granted proof reveals no other repository's digests or corpus-wide counts | ? UNCERTAIN (decision 1, open) | Proof reply (corpus/service.ts:325-345) unchanged since 9e71f263. The inclusion proof is built over the whole-corpus tree, so sibling hashes and `root` commit to other repositories' `(repo, path, sha256)`; `index` and `treeSize` expose corpus-wide position and count. Whether this is "reading another repository's corpus" is a policy reading. |
| 12  | SC2 ledger: a named ungranted repository is refused before the query; rows are filtered to the grant | ✓ VERIFIED | `queryEventsFor` service.ts:6794 (named gate), then `rowsInGrant`. Carried `repo-scope.reads-writes.test.ts`. |
| 13  | SC2 graphs: a graph's repository is read from its row and must be granted before content is read; no resolvable repository is refused | ✓ VERIFIED | `graphRepoOf` service.ts:6712; `scopedGraphRefusal` service.ts:6723-6731 (`graph-repo-unresolved` when no repo). Carried. |
| 14  | SC2 docs: search and LightRAG query refused to every scoped surface before retrieval or fallback | ✓ VERIFIED | `scopedDocsRefusal` service.ts:6743; called at mcp.ts:1584 and 1802 before retrieval; declared GATED in route-policy.ts:35-36. The wave-6 change at service.ts:6395-6426 is telemetry after the answer and does not reach a scoped caller. Carried. |
| 15  | SC2 writes: `events_emit`, `graph_register`, `handoff`, `POST /events` refuse an ungranted or absent target before the write | ✓ VERIFIED | `scopedWriteRefusal` service.ts:6752 (server.ts:1348, 1549; mcp.ts:1188, 1332, 1937). Carried. |
| 16  | SC2 lease reaper: an unnamed reap touches only granted repositories; a named ungranted reap reaps nothing | ✓ VERIFIED | `reapExpiredLeases` service.ts:7520; named gate `authorizeRepo` and `grantedRepos` for the unnamed reap (7521-7534). Carried. |
| 17  | SC2 live sessions, discovery: an unnamed discovery by a scoped caller is refused | ✓ VERIFIED | `scopedRepoRefusal("live_session_discovery", ...)` at service.ts:2275, before `listVisible`. Carried. |
| 18  | SC2 live sessions, issue and transition: an ungranted `repo_id` is refused before `authority.issue` or `transition` | ✓ VERIFIED (observed at c40ffc9a) | Gate `authorizeRepo(this.config.repoScope, caller.surface, request.repoId)` at service.ts:2227 in `updateLiveSession`, before `authority.issue` and `transition`. Named test "gate: updateLiveSession issue for a repository the caller's grant does not include is refused and writes nothing" passes in targeted run 2 (19 pass). |
| 19  | SC2 memory search: a scoped caller receives only entries whose scope and own `repo` are both granted | ✓ VERIFIED (observed at c40ffc9a) | `grantedToCaller` memory-policy.ts:441 with `normalizeIdentifier(repo)` at 443; `visibleToCaller` 458-466. Door `memoryReplyInGrant` service.ts:6816-6836. Named test "a repo keeps its exact spelling for visibility" passes in targeted run 3 (126 pass). |
| 20  | SC2 memory verify: a scoped caller gets no verdict for an entry of an ungranted repository | ✓ VERIFIED | `memoryVerify` service.ts:4581; gate before the reader is built; reader repo `normalizeIdentifier(caller.repo)`. Carried. |
| 21  | SC1/SC2 live sessions at the public routes: a scoped caller's live-session issue and transition are refused before any session is read or written | ✓ VERIFIED (by default deny; observed at c40ffc9a) | `live-session-scope.test.ts` public-route tests pass in targeted run 2. Live-session routes and `docs_steering_session` are undeclared for scope, so every scoped caller is refused. Consequence: scoped surfaces cannot run live sessions at all. A product consequence, not a leak. |

**Score:** 26 of 27 truth rows verified. Row 11 is uncertain. Behavior-unverified: 0.

Line references after service.ts:2960 are shifted by +1 relative to the 9e71f263 record because of the inserted `recordSyncLag` line; the gate bodies are unchanged.

### Verdicts by criterion

| Criterion | Verdict |
| --------- | ------- |
| 1. API and CLI refuse before any git call | ✓ VERIFIED under scoping, with open items. Gate names and reason codes unchanged. Open: the default-off posture; decision 3 (unit is the surface, not the session); decision 4 (collector cwd reads). |
| 2. Scoped credential cannot read another repository's worktrees or corpus | ⚠️ PARTIAL. VERIFIED for worktree lists (rows 7, 8), corpus plan, ingest, status, reconcile, root, anchor and proof refusal (rows 9-10), ledger (12), graphs (13), docs (14), writes (15), reaper (16), memory search (19), memory verify (20) and live-session routes (17, 18, 21). UNCERTAIN for the corpus proof disclosure (row 11, decision 1). |

**HARD-S2 (REQUIREMENTS.md:113), against the amended text (binding for this record):**
- Repository access may be requested by path only where the path resolves to a registered repository: **MET where a registry is set; OPEN under the default-off posture.** A server with a registry cannot start without `SUBSTRATE_REPO_SCOPES` (config.ts `repoScopeOrRefuse`, index.ts).
- Canonicalise paths; component-wise roots; traversal and symlink rejection, including after registration: **MET** for the gated doors (repo-scope.ts `contains`, `resolveContained`, `locateRepoPath`; overlap refusal at parse).
- Repository access granted per surface; every route and tool resolves the caller's surface and refuses an ungranted repository: **MET** for the gated doors (REST default deny, MCP batch default deny, route-policy.ts, `isGranted`).
- Repo A credentials cannot authorise repo B: **MET** for the gated doors.
- Argv-only git: **MET** for gated paths (repo-executor.ts `spawnSync("git", [...args])`; discover.ts and gitio.ts argv; install-git-hook.ts argv arrays).

**HARD-S2 against the original 23bd0733 text** ("Resolve least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B"): **UNMET AS WRITTEN.** No repository-specific credential reference exists. The credential is a surface bearer token. This is the owner-amended clause, recorded here, not re-decided.

**Decision status:** Open and owner-held: (1) corpus proof disclosure; (3) allowlist unit (surface versus session); the default-off posture of scoping, the corpus CLI and the collector installer; (4) scope of "the CLI". Row 19 legacy-row repair is an owner data decision and does not block the gate. Recorded, not re-decided: (2) the credential model, as amended in a147228f. Closed: row 8 (observed at c40ffc9a, PG 16); row 18 (a51a698c); row 19 regression (exact spelling, 4b84e50c); 6c (500e4fb3); refuse-to-start (500e4fb3); 5d and 6b (a28ecac8).

## What changed since 9e71f263, and why it matters to the gates

1. **Row 8 is observed at the current head.** The Postgres run of `worktree-registry.pg.test.ts` passes on a live database at c40ffc9a; the SQL predicate at worktree-registry.ts:401 is unchanged.
2. **No gate changed.** The seven covered files that changed are listed in the wave-6 table above. The `service.ts` hunks are one telemetry call and one inserted docs-ingest hook; neither is a gate. The gate functions named in the truth table are present and called from the same routes.
3. **Covered digest.** The covered list is the same 39 entries as the 9e71f263 record. `covered_digest` changed because the content of the seven files changed.

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/repo-scope.ts` | Pure gate, parsers, local gates, refusal payload, nested-checkout detection | ✓ VERIFIED | Unchanged since 4b84e50c. |
| `packages/mcp-server/src/repo-executor.ts` | `scopedGit` executor | ✓ VERIFIED (unit); NOT WIRED | Unchanged. No production caller. Carried as a warning. |
| `packages/mcp-server/src/config.ts` | `repoScope` from env; boot refusal | ✓ VERIFIED | `RepoScopesRequiredError` 967; `repoScopeOrRefuse` 975. Only a comment changed in wave 6. |
| `packages/mcp-server/src/index.ts` | Entry point refuses with exit 1; shutdown flushes the owed corpus root | ✓ VERIFIED | Refusal lines unchanged; `drainCorpusRoots` added to shutdown (not a gate). |
| `packages/cli/src/corpus/scope.ts`, `index.ts`, `watch-commands.ts` | Corpus CLI gate | ✓ VERIFIED (gated commands; default off) | Unchanged. |
| `packages/cli/src/index.ts` | cwd git reads gated; `drift --path` sends a raw path | ⚠️ PARTIAL | `git()` gated by `localGitPermitted`. `drift --path` relies on the server gate. Default-off posture and decision 4 open. |
| `packages/collectors/src/install-git-hook.ts` | Corpus hook installer and standalone installer gated under the registry | ✓ VERIFIED (default off) | Unchanged. |
| `packages/corpus/src/discover.ts` | Nested-checkout refusal under a registry | ✓ VERIFIED | Unchanged. |
| `packages/mcp-server/src/route-policy.ts` | Default-deny declarations | ✓ VERIFIED | Unchanged. Stale comment at line 51 (info). |
| `packages/mcp-server/src/service.ts` | Gates and filters | ✓ VERIFIED | Gate calls at 2227, 2275, 5264, 6795 region (`queryEventsFor` 6794), 7520 region, 7803 present; no gate removed. Wave-6 hunks at 2961 and 6395-6426 are telemetry and an ingest hook. |
| `packages/mcp-server/src/memory-policy.ts` | Memory row gate (read side) | ✓ VERIFIED | Read comparisons exact at 443, 465. Unchanged since 9e71f263. |
| `packages/mcp-server/src/corpus/service.ts` | Corpus gates | ✓ VERIFIED | 157-169; ingest 235-237; plan 205; status 268; reconcile 289; proof 331. Unchanged. |
| `packages/mcp-server/src/worktree-registry.ts` | `repos` filter in SQL, typed array | ✓ VERIFIED | List predicate at 401 exercised on Postgres 16 (row 8, 13 pass). Unchanged. |
| `packages/mcp-server/src/worktree-registry.pg.test.ts` | Postgres proof of the list filter | ✓ VERIFIED (run at c40ffc9a) | 13 pass, 0 fail, 42 expect() calls on scratch Postgres 16. |
| `packages/mcp-server/src/live-session-scope.test.ts` | Row 18 test | ✓ VERIFIED | Service-level test passes (targeted run 2). |
| `packages/mcp-server/src/repo-scope.boundary.test.ts` | Two-repository boundary; ATLAS-04 tombstone tests | ✓ VERIFIED | Passes (targeted run 2). |
| `.planning/REQUIREMENTS.md` HARD-S2 | Requirement text and status | ✓ VERIFIED (not edited here) | Line 113 text unchanged in wave 6; status column line 134. |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| server.ts `POST /drift` | `scopedDriftScan` | server.ts:1586 | ✓ WIRED | Carried routes test. |
| mcp.ts `coord_drift_scan` | `scopedDriftScan` | mcp.ts:2014 | ✓ WIRED | Carried boundary test. |
| server.ts `GET /worktrees` | `listWorktrees(query, surface)` | server.ts | ✓ WIRED | Carried routes test. |
| mcp.ts `worktree_list` | `listWorktrees(query, callerSurface)` | mcp.ts | ✓ WIRED | Code. |
| `listWorktrees` | SQL repo filter | worktree-registry.ts:401 | ✓ WIRED | Observed on Postgres 16 (row 8). |
| `runWorktree` | `scopeRefusal` | cli/src/worktree/command.ts:557 | ✓ WIRED | Carried CLI tests. |
| `runCorpus` | `corpusScopeRefusal` | cli/src/corpus/index.ts:304 | ✓ WIRED | Carried corpus scope tests. |
| top-level `git()` | `localGitPermitted` | cli/src/index.ts | ✓ WIRED | Carried corpus/scope.test.ts. |
| `memoryReplyInGrant` | per-entry repo grant | service.ts:6823-6835 via memory-policy.ts:443 | ✓ WIRED | Observed; row 19 named test passes. |
| `mergeDerivedHits` | `visibleToCaller` | memory-search.ts | ✓ WIRED | Carried. |
| `updateLiveSession` | `authorizeRepo` before issue or transition | service.ts:2227 | ✓ WIRED | Observed; row 18 test passes. |
| `corpusIngestReply` | `repoRefusalOf` then `tombstoneScopeRefusal` | corpus/service.ts:235, 237 | ✓ WIRED | Carried tests; tombstone tests pass (run 2). |
| `installCorpusHooks` | registry gate on the resolved hooks dir and the primary checkout | install-git-hook.ts | ✓ WIRED | Carried. |
| `loadConfig` | `repoScopeOrRefuse` | config.ts | ✓ WIRED | Entry point refuses with exit 1. |
| `discoverRepos` | nested-checkout refusal | discover.ts -> repo-scope.ts | ✓ WIRED | Carried. |
| `scopedGit` | production git call sites | repo-executor.ts | ✗ NOT_WIRED | No production caller. Not a stated Phase 72 criterion; a WARNING. |

## Data-Flow Trace (Level 4)

Not applicable. The phase adds gates and filters, not rendered output.

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Row 8: Postgres list filter; empty list matches no row | `SUBSTRATE_TEST_PG_URL=<scratch 127.0.0.1:5439/substrate_test_v72> TMPDIR=… bun test --timeout 30000 packages/mcp-server/src/worktree-registry.pg.test.ts` | 13 pass, 0 fail (scratch Postgres 16) | ✓ PASS |
| Row 18: service-level live-session gate refuses an ungranted repo, writes nothing | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=… bun test --timeout 30000 packages/mcp-server/src/live-session-scope.test.ts packages/mcp-server/src/repo-scope.boundary.test.ts` | 19 pass, 0 fail | ✓ PASS |
| Row 7 and row 19: memory visibility keeps exact spelling; worktree list unit tests | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=… bun test --timeout 30000 packages/mcp-server/src/memory-policy.test.ts packages/mcp-server/src/worktree-registry.test.ts` | 126 pass, 0 fail | ✓ PASS |

Debt-marker gate: `git diff --name-only 9e71f263 c40ffc9a` intersected with covered_files is seven files; the added lines in those files contain no TBD, FIXME, XXX, TODO, HACK or PLACEHOLDER marker.

Probe execution: no probes declared in the PLAN or SUMMARY. Nothing to run under Step 7c.

## Human Verification Required

1. **Row 11, decision 1: corpus proof disclosure.** Decide whether a granted caller receiving `root`, `treeSize`, `index` and the audit path counts as reading another repository's corpus. Options: accept as allowed, rebuild per repository, or withhold foreign siblings, index and treeSize. **Why human:** a policy reading of "read".
2. **Decision 3, allowlist unit (criterion 1).** Confirm the surface, not the session, is the intended allowlist unit. **Why human:** design decision.
3. **Default-off posture.** Decide whether the server's default-off, and the corpus CLI and collector installer accepting a registry without scopes (documented), are acceptable for a deployment that claims criteria 1 and 2. **Why human:** deployment posture decision.
4. **Decision 4, scope of "the CLI" (collectors).** Decide whether `packages/collectors/src/git-context.ts`, `muse.ts` and `cursor-stop.ts` cwd reads are inside criterion 1. **Why human:** scope of "the CLI".
5. **Row 19 legacy-row repair (owner, not the gate).** The gate is correct for legacy rows; the owner decides whether legacy rows with a dangling surrogate in repo are repaired or left unmatched. **Why human:** data decision.

## Gaps Summary

Status is `human_needed`. No truth is FAILED, no artifact is missing or a stub, no key link is NOT_WIRED on a stated criterion, and no blocker anti-pattern remains. Rule 2 fires: row 11 is uncertain and the owner decisions above are open. Row 8 is no longer behavior-unverified.

- **Row 8 (observed at c40ffc9a).** The Postgres list filter is exercised on a live database (13 pass).
- **Criterion 1 (verified under scoping, with open items).** Open: the default-off posture, decision 3, and decision 4.
- **Criterion 2 (partial).** Open: the corpus proof disclosure (decision 1, row 11).
- **HARD-S2 (partial, amended text).** The identifier clause holds wherever a registry is set; open under the default-off posture.
- **HARD-S2 (original text).** Unmet as written. Recorded, not re-decided.

**Warnings and info (not blocking, carried):**
- Row 19 door-level test is absent: the lone-surrogate classes at `memoryReplyInGrant` are covered by the helper test and a probe, not a door test. Warning.
- Scoping is off by default: criteria 1 and 2 hold only when a registry or scopes are set.
- `repo-executor.ts:13` says phase 74 calls `scopedGit`; no caller exists. Warning.
- `route-policy.ts:51` says derived hits are not yet filtered; the code filters them (service.ts:6835). Info.
- `live-session-scope.test.ts` public-route test name "refused before the session authority is read" describes default deny, not the repository gate. Info.
- ROADMAP.md phase 72 status line may still carry the 4b84e50c counts. Not re-checked here; orchestrator document, not edited.

---

_Verified: 2026-11-05T00:13:07Z_
_Verifier: Claude (gsd-verifier, phase 72 re-verification at c40ffc9a)_
