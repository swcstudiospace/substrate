---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-05T07:59:23Z
status: human_needed
score: "26/27 truth rows verified (row 8 by named JUnit pass in gate r33 at 6e5d766e; row 11 uncertain); criterion 1 verified under scoping with open decisions 3 and 4; criterion 2 partial (row 11, decision 1); HARD-S2 met under scoping, default-off posture kept by owner decision"
covered_files: [".env.example", ".planning/REQUIREMENTS.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-PLAN.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-SUMMARY.md", "docs/config-reference.md", "docs/corpus-watch.md", "docs/worktree-fleet-api.md", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/scope.test.ts", "packages/cli/src/corpus/scope.ts", "packages/cli/src/corpus/watch-commands.ts", "packages/cli/src/index.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.test.ts", "packages/cli/src/worktree/scope.ts", "packages/collectors/src/install-git-hook.test.ts", "packages/collectors/src/install-git-hook.ts", "packages/corpus/src/discover.test.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/gitio.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/live-session-scope.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/repo-executor.test.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/repo-scope.reads-writes.test.ts", "packages/mcp-server/src/repo-scope.routes.test.ts", "packages/mcp-server/src/repo-scope.test.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-registry.ts"]
covered_digest: "v3:sha256:e37dee374e1bfde2cb6389423b4c99d59abb01c6bb091d02290c8d09e6c4aa06"
behavior_unverified: 0
overrides_applied: 0
gaps: []
regressions_closed:
  - "Row 8 (Postgres worktree list filter), gate r33 at 6e5d766e: worktree-registry.pg.test.ts has 13 testcases in 'the worktree registry against a live index', 0 skipped, 0 failed, including 'a listing with a repos filter returns only the rows of the listed repositories, and an empty list returns none'. Earlier scratch Postgres 16 run at 42e3cf13 also 13 pass. No Postgres was started for this record."
re_verification:
  previous_status: human_needed
  previous_score: "26/27 (verified at 42e3cf13, 2026-11-05T07:10:23Z)"
  gaps_closed: []
  gaps_remaining:
    - "Row 11, corpus proof disclosure. Owner decision 1, open. Human item."
    - "Row 3 / criterion 1, allowlist unit (surface versus session). Owner decision 3, open. Human item."
    - "Decision 4, scope of 'the CLI' for collector cwd reads (git-context.ts, muse.ts, cursor-stop.ts). Open. Human item."
    - "Row 19 legacy-row repair (owner data decision: rewrite or leave unmatched). The gate fix does not depend on it. Open. Human item."
  regressions: []
human_verification:
  - test: "Row 11, decision 1: corpus proof disclosure. Decide whether a granted caller receiving root, treeSize, index and the audit path counts as reading another repository's corpus. Options: accept as allowed, rebuild per repository, or withhold foreign siblings, index and treeSize."
    expected: "A recorded owner decision on whether the proof reply is inside criterion 2."
    why_human: "A policy reading of 'read'."
  - test: "Decision 3, allowlist unit (criterion 1). Confirm the surface, not the session, is the intended allowlist unit."
    expected: "A recorded owner decision."
    why_human: "Design decision."
  - test: "Decision 4, scope of 'the CLI' (collectors). Decide whether packages/collectors/src/git-context.ts, muse.ts and cursor-stop.ts cwd reads are inside criterion 1."
    expected: "A recorded owner decision."
    why_human: "Scope of 'the CLI'."
  - test: "Row 19 repair of legacy rows. The gate is correct for legacy rows; the owner decides whether legacy rows with a dangling surrogate in repo are repaired or left unmatched."
    expected: "A recorded owner decision."
    why_human: "Data decision."
---

# Phase 72: Repo allowlist and scoped credentials Verification Report

**Phase Goal:** A session can address only the repositories on its allowlist, and each repository's credential is scoped to that repository.
**Verified:** 2026-11-05T07:59:23Z
**Status:** human_needed
**Re-verification:** Yes. Integration tree gsd/v18-int-all at HEAD 6e5d766e. The prior record (human_needed, 42e3cf13) is replaced.

**Evidence labels.** "Observed" means a command or search run by this verifier at HEAD 6e5d766e. "JUnit" means a named testcase in gate r33 (`/root/src/worktrees/backups/gate-r33-junit.xml`, green at 6e5d766e: 12290 testcases, 0 failures, 2 skipped, neither in phase 72: `redact.test.ts` D-04 and the `cache-conformance.test.ts` live Redis case). "Carried" means evidence from the 42e3cf13 record whose covered code is unchanged between 42e3cf13 and 6e5d766e (`git diff 42e3cf13..6e5d766e -- <file>`, read hunk by hunk). "[INFERENCE]" marks a conclusion no test exercised.

**Criteria source:** `.planning/ROADMAP.md`, Phase 72 section (header at line 1252). The success-criteria text is unchanged: `git diff 42e3cf13..6e5d766e -- .planning/ROADMAP.md` has hunks at lines 1067, 1112, 1202, 1204 and 1224 only (phases 63, 65, 69, 70), and the criteria are at lines 1262-1263.
Criteria (verbatim):
1. A repository outside the session's allowlist is refused at the API and the CLI before any git call runs.
2. A credential scoped to one repository cannot read another repository's worktrees or corpus.

**Requirement source:** `.planning/REQUIREMENTS.md` (HARD-S2, line 113), amended to the surface-bearer model (a147228f), with the identifier clause amended to a path gated to a registration (79b3ba32). Line 113 and the status line 134 are not in any hunk of `git diff 42e3cf13..6e5d766e -- .planning/REQUIREMENTS.md` (hunks at lines 19, 68, 70 and 76: ATLAS-03, PROOF-02, PROOF-04, EVAL-03).

**Owner decisions in force (not reopened here).** Phase 72 default-off posture kept: scoping is off when neither `SUBSTRATE_REPO_SCOPES` nor `SUBSTRATE_REPO_REGISTRY` is set. The corpus CLI and the collector installer accept a registry without scopes only as documented. Recorded as decided, not as a human item. Also in force from the 6e5d766e wave: the tombstone scope is the caller's own declaration, not an access control (docs/corpus.md); the in-process last-good brief serves only while the cache breaker is open; the in-flight event is recorded at shutdown. The open items are decisions 1, 3, 4 and the row 19 data decision, below.

**Question asked of this re-verification.** Do the phase 72 gates still hold at 6e5d766e after the five commits on top of 42e3cf13 (49b9aece, b4bdd0fc, d1a5e89b, b4fe6bfe, 6e5d766e)? Is the Postgres worktree list filter (row 8) still named-passing in gate r33? Does any change in a covered file touch a gate?

**Answer.** Yes on all three. No gate body changed. Row 8 is a named, unskipped JUnit pass at 6e5d766e. Rows 7, 9, 18, 19 and 21 are JUnit passes and were re-run in one targeted non-Postgres command at 6e5d766e (163 pass). Every gate named in the truth table is present at 6e5d766e at the line cited below. Row 11 remains uncertain. Decisions 1, 3 and 4, and the row 19 data decision, remain open.

## Targeted runs at 6e5d766e

1. Non-Postgres, one command: `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/live-session-scope.test.ts packages/mcp-server/src/repo-scope.boundary.test.ts packages/mcp-server/src/memory-policy.test.ts packages/mcp-server/src/worktree-registry.test.ts packages/mcp-server/src/service-event-buffer.test.ts` gives 163 pass, 0 fail, 426 expect() calls, 5 files, exit 0. The per-file counts (4, 15, 42, 84, 18) equal the JUnit testcase counts for the same files. Log: `/tmp/f72_run6e5.log`. The stderr lines (Greptime unreachable, dead-letter EEXIST) come from the telemetry-buffer tests that exercise the buffer by design; they are not failures.
2. Postgres: not run. The gate evidence says not to start a database; row 8 is evidenced by its JUnit names (below).

## JUnit evidence (gate r33, 6e5d766e)

| File | Testcases | Skipped | Failed | Rows |
| ---- | --------- | ------- | ------ | ---- |
| `packages/mcp-server/src/worktree-registry.pg.test.ts` | 13 | 0 | 0 | 8 |
| `packages/mcp-server/src/repo-scope.boundary.test.ts` | 15 | 0 | 0 | 7, 9 |
| `packages/mcp-server/src/worktree-registry.test.ts` | 84 | 0 | 0 | 7 |
| `packages/mcp-server/src/live-session-scope.test.ts` | 4 | 0 | 0 | 18, 21 |
| `packages/mcp-server/src/memory-policy.test.ts` | 42 | 0 | 0 | 19 |

Named testcases relied on:
- Row 8: class "the worktree registry against a live index", file `worktree-registry.pg.test.ts`: "a listing with a repos filter returns only the rows of the listed repositories, and an empty list returns none" (pass, not skipped). The other 12 testcases of that class pass too.
- Row 18: "gate: updateLiveSession issue for a repository the caller's grant does not include is refused and writes nothing" (class "live-session issue under scope, at the service call", pass).
- Row 21: "boundary: REST issue of a session for an ungranted repository is refused before any session is written"; "boundary: MCP docs_steering_session issue for an ungranted repository is refused before any session is written"; "boundary: MCP docs_steering_session transition by a scoped surface is refused before the session authority is read" (all pass).
- Row 9: class "corpus ingest tombstones (ATLAS-04: a tombstone removes only what the request's scope covers)", file `repo-scope.boundary.test.ts`: "a tombstone for a repository the caller is not granted is refused, and the plane deletes nothing" (pass); the tier, source and no-scope refusals and the in-scope apply also pass.
- Row 7: class "worktree list (criterion 2: a credential reads only its own repository's worktrees)", file `repo-scope.boundary.test.ts`: "boundary: an unfiltered scoped list returns only the granted repository's rows, filtered in the store" (pass).
- Row 19: "a repo keeps its exact spelling for visibility: a lone high surrogate is not trimmed into the granted repo", file `memory-policy.test.ts` (pass).

The two skipped testcases of gate r33 are `redact.test.ts` (D-04 fixtures) and `cache-conformance.test.ts` (live loopback Redis, `SUBSTRATE_CONFORMANCE_REDIS_URL` unset). Neither is a phase 72 testcase.

## Changes since 42e3cf13 (audited)

| Commit | Files | Covered by 72? | Effect on phase 72 |
| ------ | ----- | -------------- | ------------------ |
| 49b9aece | `packages/mcp-server/src/event-buffer.ts`, `event-buffer.test.ts` | No | An in-flight entry given up at shutdown is recorded. The buffer only ever holds events that already passed the write gate: `events_emit` (mcp.ts:1188) and `POST /events` (server.ts:1348) call `scopedWriteRefusal` before `substrate.emit`. Row 15 unchanged. |
| b4bdd0fc | `packages/mcp-server/src/service.ts` (hunk `@@ -3005 +3005,2 @@`) | Yes | `emit` now feeds `corpusSlo.recordSyncLag` when the note is stored, buffered or dead-lettered. This is a post-write reading, not a gate. The one-line hunk shifts every service.ts line after 3005 by +1; all cited lines below are re-located. |
| d1a5e89b | `packages/mcp-server/src/cache.ts`, `cache-breaker.test.ts`; `service.ts` reads `forgetVerdict` at 2529 and `snapshotSurvivesForget` at 2658, 2724 (unchanged lines in service.ts) | `cache.ts` No; service.ts read sites already in the 42e3cf13 record | The brief-snapshot degraded path (in-process last-good brief) now refuses on any unreadable forget-mark read except the breaker's. This path is behind the brief gate: `scopedBriefRefusal` is called at server.ts:1249 and mcp.ts:688 before `substrate.brief` (service.ts:2408), and snapshots are keyed by surface and args. Not a repository gate, grant read or refusal. |
| b4fe6bfe | `packages/dispatcher/src/substrate_dispatcher/worktree.py`, `packages/dispatcher/tests/test_worktree.py` | No | The free-space floor for `ensure_worktree` is read at the nearest existing directory above `roots[0]` (`_existing_ancestor`) instead of `/`. This is dispatcher disk-space logic. **It is not a boundary gate:** it reads no repository grant, refuses no repository, and no phase 72 truth or criterion names it. |
| 6e5d766e | `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `docs/corpus.md`, `docs/reconcile.md`, phase records | REQUIREMENTS.md and ROADMAP.md, yes (content checked above); docs/corpus.md, no; docs/reconcile.md, no | REQUIREMENTS.md: ATLAS-03, PROOF-02, PROOF-04 and EVAL-03 wording; HARD-S2 (line 113) and its status (line 134) untouched. ROADMAP.md: phases 63, 65, 69 and 70 wording; the phase 72 section is untouched. docs/corpus.md: adds that a tombstone `scope` is the caller's own declaration, not an access control, and that the bounding grant is the repo grant. Checked against code: `repoRefusalOf` runs before `tombstoneScopeRefusal` (corpus/service.ts:235, then 237), so row 9 holds and the sentence matches. docs/reconcile.md describes the cache repair tool, not `corpus reconcile`; row 10 is not touched. The 42e3cf13 record file is replaced by this one. |

Debt-marker gate: the added lines in the two covered files that changed (`service.ts`, `REQUIREMENTS.md`) contain no TBD, FIXME, XXX, TODO, HACK or PLACEHOLDER marker (scan of the diff, 0 hits).

Line map at 6e5d766e (service.ts lines after 3005 are +1 from 42e3cf13; lines before 3005 are unchanged). Gate bodies unchanged.
- Gates: `updateLiveSession` gate 2237 (unchanged); live-discovery `scopedRepoRefusal` call 2285 (unchanged); `recordSyncLag` call 3006; `memoryVerify` 4627, gate 4632; `listWorktrees` 5310, gate 5314, `grantedRepos` 5318; `scopedDriftScan` 7850, `authorizeRepo` 7852; `queryEventsFor` 6840, named gate 6842; `graphRepoOf` 6758; `scopedGraphRefusal` 6769-6776; `scopedDocsRefusal` 6789; `scopedWriteRefusal` 6798; `memoryReplyInGrant` 6862, repo grant 6870, derived-hit filter 6881; `reapExpiredLeases` 7567, named gate 7576, `grantedRepos` 7579; `corpusFreshness` call 7514, function 7529; `recordRetrieval` call 6442, definition 6468.
- Unchanged files (byte-identical to 42e3cf13, so their lines are unchanged): `server.ts`, `mcp.ts`, `route-policy.ts`, `repo-scope.ts`, `repo-executor.ts`, `config.ts`, `memory-policy.ts`, `worktree-registry.ts` (predicate 401), `corpus/service.ts` (157, 169, 205, 235, 237, 268, 289, 331), `packages/cli/**`, `packages/collectors/**`, `packages/corpus/**`.

Covered digest. `gsd_run query verification.fingerprint` over the 37 implementation entries plus the phase's own PLAN and SUMMARY gives 39 covered entries, the same list as the 42e3cf13 record, and `v3:sha256:e37dee374e1bfde2cb6389423b4c99d59abb01c6bb091d02290c8d09e6c4aa06`. The digest changed because `service.ts` and `REQUIREMENTS.md` changed content.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1 service: a drift scan naming an ungranted repository, or a path in another repository, is refused before any git call | ✓ VERIFIED | `scopedDriftScan` service.ts:7850; `authorizeRepo` at 7852 and `authorizeRepoPath` at 7855, both before `driftScan`. Gate present at 6e5d766e (observed). Carried test. |
| 2a  | SC1 REST: `POST /drift` runs the gate before the scan | ✓ VERIFIED | server.ts:1586 `scopedDriftScan`; route at 1577. server.ts unchanged in range. Carried routes test. |
| 2b  | SC1 MCP: `coord_drift_scan` refuses an ungranted repository before any git call | ✓ VERIFIED | mcp.ts:2014 `scopedDriftScan(request, callerSurface)`. mcp.ts unchanged in range. Carried boundary test. |
| 3   | SC1 API: every REST route or MCP tool with no declaration is refused to a scoped caller before its handler | ✓ VERIFIED | REST default deny server.ts:964-965 (`restDeclaration`, `refuseUndeclared`); MCP batch default deny server.ts:2747; declarations in route-policy.ts (unchanged). Carried. Decision 3 is a human item. |
| 4   | SC1 CLI: `substrate worktree` refuses an ungranted root, `--repo`, provision target, merge-back or guard path before any git call, exit 2 | ✓ VERIFIED | `runWorktree` calls `scopeRefusal` at cli/src/worktree/command.ts:557 before dispatch. cli unchanged in range. Carried `packages/cli/src/worktree/scope.test.ts` (12 JUnit pass). |
| 5   | SC1 CLI: `substrate corpus` refuses an unregistered `--root`, `--repo` directory, or named `--repo` before any git call or hook write, when the registry is set | ✓ VERIFIED (gated commands; default off) | `runCorpus` calls `corpusScopeRefusal` at cli/src/corpus/index.ts:304 before dispatch. Carried (16 JUnit pass in `corpus/scope.test.ts`). `hint` writes a spool file and runs no git (documented; not gated). |
| 5b  | SC1 CLI: the standalone installer refuses an unregistered repository before any git call or hook write, under a registry | ✓ VERIFIED (default off, as row 5) | install-git-hook.ts `locate` (line 111). Carried test (24 JUnit pass). |
| 5c  | HARD-S2 path clause: a hook write stays inside a registered directory, including after `core.hooksPath` resolution | ✓ VERIFIED | install-git-hook.ts `locate` (line 111). Carried test. |
| 5d  | HARD-S2 path clause: a hook write from a registered linked worktree stays inside a registered directory | ✓ VERIFIED (closed; owner decision, a28ecac8) | install-git-hook.ts `locate` (111), `commonGitDir` (79), `primaryCheckout` (87). Carried tests. |
| 6   | SC1/SC2 path containment: `..`, symlinks and registered roots compared after realpath; overlapping registrations refused at boot | ✓ VERIFIED | repo-scope.ts: `contains`, `resolveContained` (211), `locateRepoPath` (247); overlap refusal at parse (`parseRepoRegistry`). repo-scope.ts unchanged in range. Carried. |
| 6b  | SC1/SC2: a checkout nested under an admitted root is refused by name before git | ✓ VERIFIED (closed by a28ecac8) | `nestedCheckoutBetween` (repo-scope.ts:113); `locateRepoPath` `nested-checkout` (259); executor `scopedGit`. Carried. |
| 6c  | SC1/SC2: a checkout nested under a registered directory that has no `.git` of its own is refused by name, and no git runs in it | ✓ VERIFIED (closed by 500e4fb3) | `nestedCheckoutBetween` (no carve-out); `discover.ts` `explore` (207). Carried discover test (36 JUnit pass). |
| 7   | SC2 worktrees, fake store: an unfiltered scoped list returns only granted rows; a named ungranted repository is refused before the read | ✓ VERIFIED (JUnit gate r33; targeted run 1) | `listWorktrees` service.ts:5310 (gate 5314, `grantedRepos` 5318). `repo-scope.boundary.test.ts` "an unfiltered scoped list returns only the granted repository's rows" passes; `worktree-registry.test.ts` 84 pass. |
| 8   | SC2 worktrees, Postgres: the list query filters in SQL, and an empty list matches no row | ✓ VERIFIED (JUnit gate r33: 13 named passes, 0 skipped) | Predicate worktree-registry.ts:401 `(${repos}::text[] is null or lower(repo) = any(${repos}::text[]))` (file unchanged in range). JUnit: `worktree-registry.pg.test.ts`, class "the worktree registry against a live index", 13 testcases, 0 skipped, 0 failed, including "a listing with a repos filter returns only the rows of the listed repositories, and an empty list returns none". Earlier scratch Postgres 16 run at 42e3cf13: 13 pass. |
| 9   | SC2 corpus: plan, ingest and proof refuse an ungranted repository after parse and before any manifest or plane read | ✓ VERIFIED (JUnit gate r33; targeted run 1) | `repoRefusalOf` corpus/service.ts:157 (file unchanged in range); called at 205 (plan), 235 (ingest, before the tombstone check at 237), 331 (proof). JUnit: "a tombstone for a repository the caller is not granted is refused, and the plane deletes nothing" and the other tombstone scope tests in `repo-scope.boundary.test.ts` pass. |
| 10  | SC2 corpus status, reconcile, root and anchor: refused to scoped callers | ✓ VERIFIED (status and reconcile via `allReposRefusal`; root and anchor via route default deny) | `allReposRefusal` corpus/service.ts:169, called at 268 (status) and 289 (reconcile). `/corpus/root` (server.ts:1845) and `/corpus/anchor` (server.ts:1865) have no route-policy entry, so default deny applies. |
| 11  | SC2 corpus proof disclosure: a granted proof reveals no other repository's digests or corpus-wide counts | ? UNCERTAIN (decision 1, open) | Proof reply (corpus/service.ts:325-345) unchanged since 42e3cf13. The inclusion proof is built over the whole-corpus tree, so sibling hashes and `root` commit to other repositories' `(repo, path, sha256)`; `index` and `treeSize` expose corpus-wide position and count. Whether this is "reading another repository's corpus" is a policy reading. |
| 12  | SC2 ledger: a named ungranted repository is refused before the query; rows are filtered to the grant | ✓ VERIFIED | `queryEventsFor` service.ts:6840 (named gate at 6842), then `rowsInGrant`. Carried `repo-scope.reads-writes.test.ts` (20 JUnit pass). |
| 13  | SC2 graphs: a graph's repository is read from its row and must be granted before content is read; no resolvable repository is refused | ✓ VERIFIED | `graphRepoOf` service.ts:6758; `scopedGraphRefusal` service.ts:6769-6776 (`graph-repo-unresolved` when no repo). Carried. |
| 14  | SC2 docs: search and LightRAG query refused to every scoped surface before retrieval or fallback | ✓ VERIFIED | `scopedDocsRefusal` service.ts:6789; called at mcp.ts:1584 and 1802 and server.ts:1626 and 1882 before retrieval; declared GATED in route-policy.ts:63-64. The telemetry call `recordRetrieval` (service.ts:6442, after the answer is built) does not reach a scoped caller. Carried. |
| 15  | SC2 writes: `events_emit`, `graph_register`, `handoff`, `POST /events` refuse an ungranted or absent target before the write | ✓ VERIFIED | `scopedWriteRefusal` service.ts:6798 (server.ts:1348, 1549; mcp.ts:1188, 1332, 1937). Call sites checked at 6e5d766e: each gate precedes `emit`/register/handoff. The 49b9aece buffer change sits after the gate. Carried. |
| 16  | SC2 lease reaper: an unnamed reap touches only granted repositories; a named ungranted reap reaps nothing | ✓ VERIFIED | `reapExpiredLeases` service.ts:7567; named gate `authorizeRepo` at 7576 and `grantedRepos` for the unnamed reap (7579). Carried. |
| 17  | SC2 live sessions, discovery: an unnamed discovery by a scoped caller is refused | ✓ VERIFIED | `scopedRepoRefusal("live_session_discovery", ...)` at service.ts:2285, before `listVisible`. Carried. |
| 18  | SC2 live sessions, issue and transition: an ungranted `repo_id` is refused before `authority.issue` or `transition` | ✓ VERIFIED (JUnit gate r33) | Gate `authorizeRepo(this.config.repoScope, caller.surface, request.repoId)` at service.ts:2237 in `updateLiveSession`, before `authority.issue` and `transition`. JUnit: "gate: updateLiveSession issue for a repository the caller's grant does not include is refused and writes nothing" (pass). |
| 19  | SC2 memory search: a scoped caller receives only entries whose scope and own `repo` are both granted | ✓ VERIFIED (JUnit gate r33; targeted run 1) | `grantedToCaller` memory-policy.ts:441 with `normalizeIdentifier(repo)` at 443; `visibleToCaller` 458-466 (memory-policy.ts unchanged in range). Door `memoryReplyInGrant` service.ts:6862-6883 (repo grant at 6870; derived-hit filter at 6881). JUnit: "a repo keeps its exact spelling for visibility: a lone high surrogate is not trimmed into the granted repo" (pass). |
| 20  | SC2 memory verify: a scoped caller gets no verdict for an entry of an ungranted repository | ✓ VERIFIED | `memoryVerify` service.ts:4627; gate at 4632 before the reader is built; reader repo `normalizeIdentifier(caller.repo)`. Carried. |
| 21  | SC1/SC2 live sessions at the public routes: a scoped caller's live-session issue and transition are refused before any session is read or written | ✓ VERIFIED (by default deny; JUnit gate r33; targeted run 1) | `live-session-scope.test.ts` public-route tests (4 JUnit pass). Live-session routes and `docs_steering_session` are undeclared for scope, so every scoped caller is refused. Consequence: scoped surfaces cannot run live sessions at all. A product consequence, not a leak. |

**Score:** 26 of 27 truth rows verified. Row 11 is uncertain. Behavior-unverified: 0.

### Verdicts by criterion

| Criterion | Verdict |
| --------- | ------- |
| 1. API and CLI refuse before any git call | ✓ VERIFIED under scoping, with open items. Gate names and reason codes unchanged. Open: decision 3 (unit is the surface, not the session); decision 4 (collector cwd reads). The default-off posture is kept by owner decision and is not an open item. |
| 2. Scoped credential cannot read another repository's worktrees or corpus | ⚠️ PARTIAL. VERIFIED for worktree lists (rows 7, 8), corpus plan, ingest, status, reconcile, root, anchor and proof refusal (rows 9-10), ledger (12), graphs (13), docs (14), writes (15), reaper (16), memory search (19), memory verify (20) and live-session routes (17, 18, 21). UNCERTAIN for the corpus proof disclosure (row 11, decision 1). |

**HARD-S2 (REQUIREMENTS.md:113), against the amended text (binding for this record):**
- Repository access may be requested by path only where the path resolves to a registered repository: **MET where a registry is set; default-off posture kept by owner decision.** A server with a registry cannot start without `SUBSTRATE_REPO_SCOPES` (config.ts `repoScopeOrRefuse` 975-976; index.ts:65; both files unchanged in range).
- Canonicalise paths; component-wise roots; traversal and symlink rejection, including after registration: **MET** for the gated doors (repo-scope.ts `contains`, `resolveContained` 211, `locateRepoPath` 247; overlap refusal at parse).
- Repository access granted per surface; every route and tool resolves the caller's surface and refuses an ungranted repository: **MET** for the gated doors (REST default deny, MCP batch default deny, route-policy.ts, `isGranted` 264).
- Repo A credentials cannot authorise repo B: **MET** for the gated doors.
- Argv-only git: **MET** for gated paths (repo-executor.ts `spawnSync("git", [...args])`; discover.ts and gitio.ts argv; install-git-hook.ts argv arrays).

**HARD-S2 against the original 23bd0733 text** ("Resolve least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B"): **UNMET AS WRITTEN.** No repository-specific credential reference exists. The credential is a surface bearer token. This is the owner-amended clause, recorded here, not re-decided.

**Decision status:** Open and owner-held: (1) corpus proof disclosure; (3) allowlist unit (surface versus session); (4) scope of "the CLI". Row 19 legacy-row repair is an owner data decision and does not block the gate. Decided and in force, not reopened: the phase 72 default-off posture (scoping off unless configured; the corpus CLI and collector installer accept a registry without scopes, as documented). Recorded, not re-decided: (2) the credential model, as amended in a147228f. Closed: row 8 (JUnit gate r33 at 6e5d766e; scratch PG 16 at 42e3cf13); row 18 (a51a698c); row 19 regression (exact spelling, 4b84e50c); 6c (500e4fb3); refuse-to-start (500e4fb3); 5d and 6b (a28ecac8).

## What changed since 42e3cf13, and why it matters to the gates

1. **No gate changed.** The covered-file changes are `service.ts` (one hunk, the `emit` sync-lag reading, b4bdd0fc) and `REQUIREMENTS.md` (four wording lines). The `service.ts` hunk is not a repository gate, grant read or refusal; the write gates precede `emit` at every call site.
2. **Brief snapshot path (d1a5e89b).** The degraded brief now uses the in-process copy only while the cache breaker is open. It sits behind the brief gate (server.ts:1249, mcp.ts:688), and the snapshot is per surface and args. Not a phase 72 truth.
3. **Disk floor (b4fe6bfe).** Dispatcher `worktree.py`. Not a boundary gate; no repository grant is read.
4. **Covered digest.** The covered list is the same 39 entries as the 42e3cf13 record; `covered_digest` changed because `service.ts` and `REQUIREMENTS.md` changed content.

## Human Verification Required

1. **Row 11, decision 1 (corpus proof disclosure).** Decide whether a granted caller receiving root, treeSize, index and the audit path counts as reading another repository's corpus. Options: accept as allowed, rebuild per repository, or withhold foreign siblings, index and treeSize. **Why human:** a policy reading of "read".
2. **Decision 3 (allowlist unit, criterion 1).** Confirm the surface, not the session, is the intended allowlist unit. **Why human:** design decision.
3. **Decision 4 (scope of "the CLI", collectors).** Decide whether `packages/collectors/src/git-context.ts`, `muse.ts` and `cursor-stop.ts` cwd reads are inside criterion 1. **Why human:** scope of "the CLI".
4. **Row 19 legacy-row repair (owner, not the gate).** The gate is correct for legacy rows; the owner decides whether legacy rows with a dangling surrogate in repo are repaired or left unmatched. **Why human:** data decision.

## Gaps Summary

Status is `human_needed`. No truth is FAILED, no artifact is missing or a stub, no key link is NOT_WIRED on a stated criterion, and no blocker anti-pattern remains. Rule 2 fires: row 11 is uncertain and decisions 1, 3, 4 and the row 19 data decision are open.

- **Row 8 (JUnit at 6e5d766e).** The Postgres list filter has 13 named, unskipped passes in gate r33.
- **Criterion 1 (verified under scoping, with open items).** Open: decision 3, decision 4.
- **Criterion 2 (partial).** Open: the corpus proof disclosure (decision 1, row 11).
- **HARD-S2 (partial, amended text).** The identifier clause holds wherever a registry is set; the default-off posture is kept by owner decision.
- **HARD-S2 (original text).** Unmet as written. Recorded, not re-decided.

**Warnings and info (not blocking, carried):**
- Row 19 door-level test is absent: the lone-surrogate classes at `memoryReplyInGrant` are covered by the helper test and a probe, not a door test. Warning.
- Scoping is off by default: criteria 1 and 2 hold only when a registry or scopes are set. Owner decision in force (default-off kept).
- `repo-executor.ts:13` says phase 74 calls `scopedGit`; no caller exists. Warning.
- `route-policy.ts:51` says derived hits are not yet filtered; the code filters them (service.ts:6881, the `derived` filter in `memoryReplyInGrant`). Info.
- `live-session-scope.test.ts` public-route test name "refused before the session authority is read" describes default deny, not the repository gate. Info.
- ROADMAP.md phase 72 Status line (the `**Status**` line under the Phase 72 header, ROADMAP.md:1254 area) still carries the 4b84e50c counts ("24 of 27 truth rows"). Not edited here; orchestrator document. Warning.
- The 42e3cf13 record's citations for the docs GATED declarations (route-policy.ts:63-64) are unchanged at 6e5d766e. Info.

---

_Verified: 2026-11-05T07:59:23Z_
_Verifier: Claude (gsd-verifier, phase 72 re-verification at 6e5d766e)_
