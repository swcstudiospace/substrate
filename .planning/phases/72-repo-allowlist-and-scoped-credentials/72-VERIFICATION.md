---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-06T00:44:18Z
status: human_needed
score: "26/27 truth rows verified (row 8 by named JUnit pass in gate r36 at a46d42c3; row 11 uncertain); criterion 1 verified under scoping with open decisions 3 and 4; criterion 2 partial (row 11, decision 1); HARD-S2 met under scoping, default-off posture kept by owner decision; scoped git executor NOT_WIRED, refusal behaviour unchanged"
covered_files: [".env.example", ".planning/REQUIREMENTS.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-PLAN.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-SUMMARY.md", "docs/config-reference.md", "docs/corpus-watch.md", "docs/worktree-fleet-api.md", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/scope.test.ts", "packages/cli/src/corpus/scope.ts", "packages/cli/src/corpus/watch-commands.ts", "packages/cli/src/index.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.test.ts", "packages/cli/src/worktree/scope.ts", "packages/collectors/src/install-git-hook.test.ts", "packages/collectors/src/install-git-hook.ts", "packages/corpus/src/discover.test.ts", "packages/corpus/src/discover.ts", "packages/corpus/src/gitio.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/live-session-scope.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/repo-executor.test.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/repo-scope.reads-writes.test.ts", "packages/mcp-server/src/repo-scope.routes.test.ts", "packages/mcp-server/src/repo-scope.test.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-registry.ts"]
covered_digest: "v3:sha256:d605f2eb61802a2d6b83ed6c980cecca90d21754f3742935bec87f3fcbeb8374"
behavior_unverified: 0
overrides_applied: 0
gaps: []
regressions_closed:
  - "Row 8 (Postgres worktree list filter) re-evidenced by gate r36 at a46d42c3: worktree-registry.pg.test.ts has 13 testcases in 'the worktree registry against a live index', 0 skipped, 0 failed, including 'a listing with a repos filter returns only the rows of the listed repositories, and an empty list returns none'. Earlier evidence: gate r33 at 6e5d766e; scratch Postgres 16 at 42e3cf13. No Postgres was started for this record."
re_verification:
  previous_status: human_needed
  previous_score: "26/27 (verified at 6e5d766e, 2026-11-05T07:59:23Z)"
  gaps_closed: []
  gaps_remaining:
    - "Row 11, corpus proof disclosure. Owner decision 1, open. Human item."
    - "Row 3 / criterion 1, allowlist unit (surface versus session). Owner decision 3, open. Human item."
    - "Decision 4, scope of 'the CLI' for collector cwd reads (git-context.ts, muse.ts, cursor-stop.ts). Open, not closed by any record. Human item."
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
**Verified:** 2026-11-06T00:44:18Z
**Status:** human_needed
**Re-verification:** Yes. Integration tree at HEAD a46d42c3 (worktree clean). The prior record (human_needed, 6e5d766e) is replaced. This record re-audits the scoped refusals after the 14 commits from 6e5d766e to a46d42c3, and re-audits the scoped git executor after a46d42c3 removed `defaultScopedGitRunner`.

**Evidence labels.** "Observed" means a command or search run by this verifier at a46d42c3. "JUnit" means a named testcase in gate r36 (`/root/src/worktrees/backups/gate-r36-junit.xml`, 12,317 testcases, 0 failures, 0 errors, 2 skipped; the skipped ones are `redact.test.ts` D-04 and the `cache-conformance.test.ts` live Redis case, neither a phase 72 testcase). "Carried" means evidence from the 6e5d766e record whose covered code is unchanged between 6e5d766e and a46d42c3 (`git diff 6e5d766e a46d42c3 -- <file>`, read hunk by hunk). "[INFERENCE]" marks a conclusion no test exercised. No test, tsc, lint or database was run for this record; the gate r36 JUnit is the only test evidence.

**Criteria source:** `.planning/ROADMAP.md`, Phase 72 section (header at line 1252). The success-criteria text is unchanged (lines 1262-1263). The ROADMAP status line at line 1256 still carries the 4b84e50c counts; see warnings.
Criteria (verbatim):
1. A repository outside the session's allowlist is refused at the API and the CLI before any git call runs.
2. A credential scoped to one repository cannot read another repository's worktrees or corpus.

**Requirement source:** `.planning/REQUIREMENTS.md` (HARD-S2, line 113), amended to the surface-bearer model (a147228f), with the identifier clause amended to a path gated to a registration (79b3ba32). `REQUIREMENTS.md` is in the covered list; its hunks since 6e5d766e are not in the HARD-S2 text (verified by `git diff 6e5d766e a46d42c3 -- .planning/REQUIREMENTS.md`, no change in this range). [INFERENCE: no change in that range, confirmed by the stat, not by re-reading the whole file.]

**Owner decisions in force (not reopened here).** Phase 72 default-off posture kept: scoping is off when neither `SUBSTRATE_REPO_SCOPES` nor `SUBSTRATE_REPO_REGISTRY` is set. The corpus CLI and the collector installer accept a registry without scopes only as documented. Also in force: the in-process last-good brief serves only while the cache breaker is open; a readable forget mark decides; the tombstone scope is the caller's own declaration, not an access control; the planning-hash default stays off; the in-flight event is recorded at shutdown; a buffered root is not written again. Open and not re-decided here: decisions 1, 3 and 4, and the row 19 legacy-row repair (below).

**Question asked of this re-verification.** Do the scoped refusals still hold at a46d42c3? Is the scoped git path (the record's NOT_WIRED item) still not wired, and is its refusal behaviour unchanged after `defaultScopedGitRunner` was removed? Are row 8 and row 18 still evidenced?

**Answer.** Yes on the first two. Every gate cited in the truth table is present at a46d42c3 at the line given. Each gate that sits in a changed hunk is unchanged in body and in order relative to its read or write (re-located below). Changes in covered files are either reporting, null-body refusals ahead of an existing gate, a retry in the corpus root keeper, or the removal of unreferenced code; no grant, refusal reason or gate order changed. The scoped git executor is still not wired: `scopedGit` has no production caller, and its body is byte-identical to 6e5d766e. Row 8 is evidenced by r36. Row 18 remains VERIFIED. Row 11 remains uncertain. Decisions 1, 3 and 4, and the row 19 data decision, remain open.

## Changes since 6e5d766e (audited)

Covered files that changed (`git diff --numstat 6e5d766e a46d42c3`, checked against the 39-entry covered list):

| File | Commit(s) | Effect on phase 72 |
| ---- | --------- | ------------------ |
| `packages/mcp-server/src/repo-executor.ts` | a46d42c3 (−12 lines) | Removes `import { spawnSync }` and `defaultScopedGitRunner`. `scopedGit` (lines 74-84) is byte-identical. The default runner had no reference at 6e5d766e either (one definition, no caller), so no production behaviour is lost. See "Scoped git executor" below. |
| `packages/mcp-server/src/config.ts` | a46d42c3 (doc comment, 2 lines) | Comment on `lightragPollMs` only. `repoScopeOrRefuse` (975-976) unchanged. |
| `packages/mcp-server/src/server.ts` | f0f3c04e (null bodies), 884e0753 (sync-lag gauge moved) | `/evidence`, `/handoff`, `/drift` and `/verify` now answer 400 to a non-object JSON body before their handlers. Each of these routes was already behind the default-deny check at server.ts:964-966 (for a scoped caller), and each gate still precedes its read or write (re-located below). The `/events` sync-lag gauge (removed from the route, moved to `Substrate.emit`) is not a gate; the write gate at 1353 still precedes `emit` at 1358. |
| `packages/mcp-server/src/service.ts` | f0f3c04e, 884e0753 | `.catch(() => undefined)` replaced by `reportSilent(...)` at many emit sites (post-write). `queryEventsFor` takes `raw: EventQueryInput \| null` and maps `null` to `{}` before the same named gate (6867-6871), so a `null` body now reaches the gate and is treated as no repository. `sweepRetrievals` moves `reflectStore()` inside `try`. `docs_search` deps gain `manifestCommit`. `trackRetain` uses `then(settle, settle)`. No gate line changed; every gate listed below is at the new line in the same body. |
| `packages/mcp-server/src/mcp.ts` | f0f3c04e | `reportSilent` import (line 33) and one `.catch` in the Railway write note. No gate. All MCP gate lines after line 33 move by +1 (recorded below). |
| `packages/mcp-server/src/corpus/root.ts` | e3914640 | Root keeper retries a refused root with backoff (`rootRetryMs`, 5 s to 60 s), reports the refusal code once. It emits `surface: "substrate"` notes exactly as before and reads no grant. Not a repository gate. Row 10 is unaffected: `/corpus/root` is still default-denied to scoped callers (route-policy.ts has no `corpus/root` entry). |

Covered files that did not change in this range (checked by `git diff --quiet 6e5d766e a46d42c3 -- <file>`): `repo-scope.ts`, `repo-scope.boundary.test.ts`, `repo-scope.routes.test.ts`, `repo-scope.reads-writes.test.ts`, `repo-scope.test.ts`, `repo-executor.test.ts`, `route-policy.ts`, `worktree-registry.ts`, `worktree-registry.pg.test.ts`, `worktree-registry.test.ts`, `live-session-scope.test.ts`, `memory-policy.ts`, `memory-policy.test.ts`, `corpus/service.ts`, `flag-registry.ts`, `index.ts`, `config.test.ts`, all `packages/cli/src/corpus/*` and `packages/cli/src/worktree/*` covered files, `packages/cli/src/index.ts`, `packages/collectors/src/install-git-hook.ts` and its test, `packages/corpus/src/discover.ts`, `discover.test.ts`, `gitio.ts`. Non-covered changes in `packages/cli` (`capsule.ts`, `corpus/testkit.ts`), `packages/collectors` (`grok.ts`) and in other packages are outside the covered list and are not gate code for phase 72. The decision 4 files (`packages/collectors/src/git-context.ts`, `muse.ts`, `cursor-stop.ts`) did not change in this range.

Changes outside the covered list that matter here: none. `packages/mcp-server/src/event-buffer.ts`, `cache.ts`, `fabric.ts` (deleted) and `docs-ingest.ts` are not covered by phase 72; `fabric.ts` had no importer (a46d42c3).

Covered digest. `gsd_run query verification.fingerprint .planning/phases/72-repo-allowlist-and-scoped-credentials <39 covered files>` at a46d42c3 gives 39 covered entries, the same list as the 6e5d766e record, and `v3:sha256:ea30b3958404df1f2d556904c34a512ec33d43df4a20c7ff7e0d377ccc00973b`. It changed because `repo-executor.ts`, `config.ts`, `mcp.ts`, `server.ts`, `service.ts` and `corpus/root.ts` changed content.

Digest correction. The prior record's frontmatter carried `459ef7fa…` while its body carried `e37dee37…` for the 6e5d766e digest. Reproduced from `git archive 6e5d766e` (a copy under /tmp; the repository was not written), the 39-file fingerprint at 6e5d766e is `v3:sha256:e37dee374e1bfde2cb6389423b4c99d59abb01c6bb091d02290c8d09e6c4aa06`. The body value is the correct one; the frontmatter value was stale.

## Scoped git executor (the NOT_WIRED item)

Question: after `defaultScopedGitRunner` was deleted, is `scopedGit` still not wired, and is its refusal behaviour unchanged?

- **Not wired (Observed).** `git grep -n "scopedGit\|defaultScopedGitRunner\|repo-executor\|ScopedGitRunner" a46d42c3 -- ':!.planning'` finds one importer of `repo-executor.ts`: `packages/mcp-server/src/repo-executor.test.ts:5`. No production module imports it, and nothing outside `.planning/` constructs a runner. `defaultScopedGitRunner` has zero references at a46d42c3 and at 6e5d766e outside its own definition (its one reference at 6e5d766e was the definition at line 50). The planning docs (`72-01-PLAN.md`, `72-01-SUMMARY.md`) still say `scopedGit` has no production caller; `72-01-SUMMARY.md` says so in its own words.
- **Refusal behaviour unchanged (Observed + JUnit).** `scopedGit` (repo-executor.ts:74-84) is byte-identical to 6e5d766e. Its refusals return before `run` is called: `repo-not-registered` (line 76), `repo-not-granted` (line 80), `path-repo-mismatch` (line 81), and the `locate` refusals (lines 60-66, from `locateRepoPath`). In r36, all 12 `repo-executor.test.ts` testcases pass, including the five in "scopedGit refusals run no git" (lines 59, 67, 75, 83, 91), which assert that the recorder is never called.
- **Warning: the runner is still an injected function, and nothing supplies a real one.** `ScopedGitRunner` (repo-executor.ts:26) is the only spawn seam. The removed default runner had also set `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=true`; those settings and the `GIT_CEILING_DIRECTORIES` value that `scopedGit` passes in `env` (line 82) are now applied by no code. Phase 74, when it wires the path, must supply a runner that applies them.
- **Warning: the header still names a caller that does not exist.** `repo-executor.ts:13` says "Phase 74 calls this entry point for cross-repository steps." That is still a plan, not code. Open since 42e3cf13.
- **Plan drift (info).** `72-01-PLAN.md` D72-07 names `scopedGit(scope, identity, target, args, runner)`; the code is `scopedGit(request, run)`. The code is the shipped contract.

HARD-S2 bullet "Argv-only git" (amended below): the executor file no longer contains a spawn, so the argv claim for the executor is now a property of the injected runner, which no production code supplies. The argv claim still holds for the git-spawning modules that the gates use: `packages/corpus/src/discover.ts`, `gitio.ts` and `packages/collectors/src/install-git-hook.ts` spawn `git` with argv arrays (unchanged in this range).

## Targeted runs at a46d42c3

None. This record is a JUnit and static re-audit only; no test, tsc, lint, formatter, Postgres or Docker was run, per the assignment.

## JUnit evidence (gate r36, a46d42c3)

Totals (`/root/src/worktrees/backups/gate-r36-junit.xml`): 12,317 testcases, 0 `failure` children, 0 `error` children, 2 `skipped` children (`redact.test.ts` D-04 and `cache-conformance.test.ts`). Neither skip is a phase 72 testcase. Counts below were parsed from the XML per file; all have zero failed and zero skipped.

| File | Testcases | Skipped | Failed | Rows |
| ---- | --------- | ------- | ------ | ---- |
| `packages/mcp-server/src/worktree-registry.pg.test.ts` | 13 | 0 | 0 | 8 |
| `packages/mcp-server/src/repo-scope.boundary.test.ts` | 15 | 0 | 0 | 7, 9 |
| `packages/mcp-server/src/worktree-registry.test.ts` | 84 | 0 | 0 | 7 |
| `packages/mcp-server/src/live-session-scope.test.ts` | 4 | 0 | 0 | 18, 21 |
| `packages/mcp-server/src/memory-policy.test.ts` | 42 | 0 | 0 | 19 |
| `packages/mcp-server/src/repo-executor.test.ts` | 12 | 0 | 0 | executor (not a truth row) |
| `packages/mcp-server/src/repo-scope.routes.test.ts` | 67 | 0 | 0 | carried routes test (row 2a, per the 6e5d766e record) |
| `packages/mcp-server/src/repo-scope.reads-writes.test.ts` | 20 | 0 | 0 | 12 (carried) |
| `packages/mcp-server/src/repo-scope.test.ts` | 31 | 0 | 0 | not mapped to a row here |
| `packages/mcp-server/src/config.test.ts` | 167 | 0 | 0 | not mapped to a row here |
| `packages/collectors/src/install-git-hook.test.ts` | 24 | 0 | 0 | 5b, 5c, 5d |
| `packages/corpus/src/discover.test.ts` | 36 | 0 | 0 | 6c |
| `packages/cli/src/corpus/scope.test.ts` | 16 | 0 | 0 | 5 |
| `packages/cli/src/worktree/scope.test.ts` | 12 | 0 | 0 | 4 |
| `packages/mcp-server/src/corpus/proofs.test.ts` | 15 | 0 | 0 | not mapped to a row here (row 11 is uncertain) |

Named testcases relied on (each matched in the r36 XML by exact name; status `pass`: no `failure`, `error` or `skipped` child):
- Row 8: class "the worktree registry against a live index", `worktree-registry.pg.test.ts` line 51: "a listing with a repos filter returns only the rows of the listed repositories, and an empty list returns none". The other 12 testcases of that class also pass (13 of 13).
- Row 18: class "live-session issue under scope, at the service call", `live-session-scope.test.ts` line 67: "gate: updateLiveSession issue for a repository the caller's grant does not include is refused and writes nothing".
- Row 21: `live-session-scope.test.ts` line 34: "boundary: REST issue of a session for an ungranted repository is refused before any session is written"; line 42: "boundary: MCP docs_steering_session issue for an ungranted repository is refused before any session is written"; line 52: "boundary: MCP docs_steering_session transition by a scoped surface is refused before the session authority is read".
- Row 9: class "corpus ingest tombstones (ATLAS-04: a tombstone removes only what the request's scope covers)", `repo-scope.boundary.test.ts` line 217: "a tombstone for a repository the caller is not granted is refused, and the plane deletes nothing".
- Row 7: class "worktree list (criterion 2: a credential reads only its own repository's worktrees)", `repo-scope.boundary.test.ts` line 90: "boundary: an unfiltered scoped list returns only the granted repository's rows, filtered in the store".
- Row 19: `memory-policy.test.ts` line 359: "a repo keeps its exact spelling for visibility: a lone high surrogate is not trimmed into the granted repo".
- Executor (not a truth row; supports the NOT_WIRED and refusal findings): class "scopedGit refusals run no git", `repo-executor.test.ts` line 59: "boundary: a path inside no registered repository is refused before the runner is called"; line 67: "boundary: a surface not granted the repository is refused before the runner is called"; line 75: "boundary: a named repository that is not registered is refused before the runner is called"; line 83: "boundary: a path that belongs to a repository other than the one named is refused before the runner is called"; line 91: "boundary: with scoping off, an unregistered path is still refused, because a cross-repository step needs a registration"; class "scopedGit granted calls", line 101: "a granted path runs git in its resolved target, with discovery ceilinged at the registered directory's parent".

Comparison with r33 (6e5d766e): the same five phase 72 files have the same testcase counts (13, 15, 84, 4, 42). Total testcases rose from 12,290 to 12,317 from other phases' tests; no phase 72 testcase was removed or skipped.

## Observable truths (re-located at a46d42c3)

Line numbers below are at a46d42c3. Changes from the 6e5d766e record are the result of the `service.ts` (+6 before 2241, +27 before 6469, +30 before 7596 and so on), `server.ts` (+7 before 1353 and +21 before 1642 from the null-body checks) and `mcp.ts` (+1 from line 33) edits. Gate bodies are unchanged in order.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1 service: a drift scan naming an ungranted repository, or a path in another repository, is refused before any git call | ✓ VERIFIED | `scopedDriftScan` service.ts:7882; `authorizeRepo` 7884, `authorizeRepoPath` 7887, both before `driftScan`. Carried test. |
| 2a  | SC1 REST: `POST /drift` runs the gate before the scan | ✓ VERIFIED | server.ts:1583 route; new null-body 400 at 1585-1589 precedes `rememberClaim`; `scopedDriftScan` call at 1597. Carried routes test (r36: 67 pass). |
| 2b  | SC1 MCP: `coord_drift_scan` refuses an ungranted repository before any git call | ✓ VERIFIED | mcp.ts:2015 `scopedDriftScan(request, callerSurface)`. Carried boundary test. |
| 3   | SC1 API: every REST route or MCP tool with no declaration is refused to a scoped caller before its handler | ✓ VERIFIED | REST default deny server.ts:964-966 (`restDeclaration`, `refuseUndeclared` at 966); MCP batch default deny server.ts:2768. `/evidence` and `/verify` have no route-policy declaration, so default deny refuses scoped callers before their (new) null-body checks. Declarations in route-policy.ts (unchanged). Decision 3 is a human item. |
| 4   | SC1 CLI: `substrate worktree` refuses an ungranted root, `--repo`, provision target, merge-back or guard path before any git call, exit 2 | ✓ VERIFIED | `runWorktree` calls `scopeRefusal` at cli/src/worktree/command.ts:557 before dispatch. Covered CLI files unchanged in range. r36: `worktree/scope.test.ts` 12 pass. |
| 5   | SC1 CLI: `substrate corpus` refuses an unregistered `--root`, `--repo` directory, or named `--repo` before any git call or hook write, when the registry is set | ✓ VERIFIED (gated commands; default off) | `runCorpus` calls `corpusScopeRefusal` at cli/src/corpus/index.ts:304 before dispatch. r36: `corpus/scope.test.ts` 16 pass. `hint` writes a spool file and runs no git (documented; not gated). |
| 5b  | SC1 CLI: the standalone installer refuses an unregistered repository before any git call or hook write, under a registry | ✓ VERIFIED (default off, as row 5) | install-git-hook.ts `locate` (line 111, unchanged). r36: 24 pass. |
| 5c  | HARD-S2 path clause: a hook write stays inside a registered directory, including after `core.hooksPath` resolution | ✓ VERIFIED | install-git-hook.ts `locate` (111). Carried test; r36: 24 pass. |
| 5d  | HARD-S2 path clause: a hook write from a registered linked worktree stays inside a registered directory | ✓ VERIFIED (closed; owner decision, a28ecac8) | install-git-hook.ts `locate` (111), `commonGitDir` (79), `primaryCheckout` (87). Carried tests. |
| 6   | SC1/SC2 path containment: `..`, symlinks and registered roots compared after realpath; overlapping registrations refused at boot | ✓ VERIFIED | repo-scope.ts (unchanged): `contains`, `resolveContained` (211), `locateRepoPath` (247); overlap refusal at parse. Carried. |
| 6b  | SC1/SC2: a checkout nested under an admitted root is refused by name before git | ✓ VERIFIED (closed by a28ecac8) | `nestedCheckoutBetween` (repo-scope.ts:113); `locateRepoPath` `nested-checkout` (259); executor `scopedGit` (repo-executor.ts:74) for the executor path (no runner in production; see executor section). Carried. |
| 6c  | SC1/SC2: a checkout nested under a registered directory that has no `.git` of its own is refused by name, and no git runs in it | ✓ VERIFIED (closed by 500e4fb3) | `nestedCheckoutBetween` (no carve-out); `discover.ts` `explore` (207). r36: `discover.test.ts` 36 pass. |
| 7   | SC2 worktrees, fake store: an unfiltered scoped list returns only granted rows; a named ungranted repository is refused before the read | ✓ VERIFIED (JUnit r36) | `listWorktrees` service.ts:5333 (gate 5337, `grantedRepos` 5341). r36: "boundary: an unfiltered scoped list returns only the granted repository's rows, filtered in the store" (pass); `worktree-registry.test.ts` 84 pass. |
| 8   | SC2 worktrees, Postgres: the list query filters in SQL, and an empty list matches no row | ✓ VERIFIED (JUnit r36: 13 named passes, 0 skipped) | Predicate worktree-registry.ts:401 `(${repos}::text[] is null or lower(repo) = any(${repos}::text[]))` (file unchanged since 6e5d766e). JUnit r36: `worktree-registry.pg.test.ts`, class "the worktree registry against a live index", 13 testcases, 0 skipped, 0 failed, including "a listing with a repos filter returns only the rows of the listed repositories, and an empty list returns none". Earlier evidence: gate r33 at 6e5d766e; scratch Postgres 16 at 42e3cf13. No Postgres was started for this record. |
| 9   | SC2 corpus: plan, ingest and proof refuse an ungranted repository after parse and before any manifest or plane read | ✓ VERIFIED (JUnit r36) | `repoRefusalOf` corpus/service.ts:157 (file unchanged); called at 205 (plan), 235 (ingest, before the tombstone check at 237), 331 (proof). r36: "a tombstone for a repository the caller is not granted is refused, and the plane deletes nothing" (pass). |
| 10  | SC2 corpus status, reconcile, root and anchor: refused to scoped callers | ✓ VERIFIED (status and reconcile via `allReposRefusal`; root and anchor via route default deny) | `allReposRefusal` corpus/service.ts:169, called at 268 (status) and 289 (reconcile). `/corpus/root` server.ts:1861 and `/corpus/anchor` server.ts:1881 have no route-policy entry, so default deny (966) applies before the handler. |
| 11  | SC2 corpus proof disclosure: a granted proof reveals no other repository's digests or corpus-wide counts | ? UNCERTAIN (decision 1, open) | Proof reply (corpus/service.ts:325-345) unchanged since 6e5d766e. The inclusion proof is built over the whole-corpus tree, so sibling hashes and `root` commit to other repositories' `(repo, path, sha256)`; `index` and `treeSize` expose corpus-wide position and count. Whether this is "reading another repository's corpus" is a policy reading. |
| 12  | SC2 ledger: a named ungranted repository is refused before the query; rows are filtered to the grant | ✓ VERIFIED | `queryEventsFor` service.ts:6867 (named gate at 6871), then `rowsInGrant` at 6875. Changed in f0f3c04e: a `null` body now maps to `{}`, so the named gate runs for it too (scoped callers with no `repo` are refused by `scopedRepoRefusal(..., required: true)`). Carried `repo-scope.reads-writes.test.ts` (r36: 20 pass). |
| 13  | SC2 graphs: a graph's repository is read from its row and must be granted before content is read; no resolvable repository is refused | ✓ VERIFIED | `graphRepoOf` service.ts:6785; `scopedGraphRefusal` service.ts:6796-6803 (`graph-repo-unresolved` at 6800 when no repo). Carried. |
| 14  | SC2 docs: search and LightRAG query refused to every scoped surface before retrieval or fallback | ✓ VERIFIED | `scopedDocsRefusal` service.ts:6816; called at mcp.ts:1585 and 1803 and server.ts:1642 and 1898 before retrieval; declared GATED in route-policy.ts:35-36 and :63-64. The telemetry call `recordRetrieval` (service.ts:6469, definition 6495) runs after the answer is built and does not reach a scoped caller. Carried. |
| 15  | SC2 writes: `events_emit`, `graph_register`, `handoff`, `POST /events` refuse an ungranted or absent target before the write | ✓ VERIFIED | `scopedWriteRefusal` service.ts:6825 (server.ts:1353 `/events`, 1555 `/handoff`; mcp.ts:1189 `events_emit`, 1333 `graph_register`, 1938 `handoff`). Each gate precedes `emit`/register/handoff. The 884e0753 and f0f3c04e changes sit after the gate. Carried. |
| 16  | SC2 lease reaper: an unnamed reap touches only granted repositories; a named ungranted reap reaps nothing | ✓ VERIFIED | `reapExpiredLeases` service.ts:7596; named gate `authorizeRepo` at 7605 (refusal at 7606-7607 before any reap); `grantedRepos` for the unnamed reap at 7608; `index.reapExpiredLeases` at 7610, after the gate. The reaper's emit (7615) follows the reap. Carried. |
| 17  | SC2 live sessions, discovery: an unnamed discovery by a scoped caller is refused | ✓ VERIFIED | `scopedRepoRefusal("live_session_discovery", ...)` at service.ts:2295, before `listVisible`. Carried. |
| 18  | SC2 live sessions, issue and transition: an ungranted `repo_id` is refused before `authority.issue` or `transition` | ✓ VERIFIED (JUnit r33; also r36) | Gate `authorizeRepo(this.config.repoScope, caller.surface, request.repoId)` at service.ts:2241 in `updateLiveSession` (2233), before `authority.issue` and `transition`. JUnit: "gate: updateLiveSession issue for a repository the caller's grant does not include is refused and writes nothing" (pass in r33 and in r36, `live-session-scope.test.ts` line 67). |
| 19  | SC2 memory search: a scoped caller receives only entries whose scope and own `repo` are both granted | ✓ VERIFIED (JUnit r36) | `grantedToCaller` memory-policy.ts:441 with `normalizeIdentifier(repo)` at 443; `visibleToCaller` 458-466 (memory-policy.ts unchanged). Door `memoryReplyInGrant` service.ts:6891 (repo grant at 6899; derived-hit filter at 6910). r36: "a repo keeps its exact spelling for visibility: a lone high surrogate is not trimmed into the granted repo" (pass). |
| 20  | SC2 memory verify: a scoped caller gets no verdict for an entry of an ungranted repository | ✓ VERIFIED | `memoryVerify` service.ts:4644; gate at 4649 before the reader is built; reader repo `normalizeIdentifier(caller.repo)`. Carried. |
| 21  | SC1/SC2 live sessions at the public routes: a scoped caller's live-session issue and transition are refused before any session is read or written | ✓ VERIFIED (by default deny; JUnit r36) | `live-session-scope.test.ts` public-route tests (4 pass in r36). Live-session routes and `docs_steering_session` are undeclared for scope, so every scoped caller is refused. Consequence: scoped surfaces cannot run live sessions at all. A product consequence, not a leak. |

**Score:** 26 of 27 truth rows verified. Row 11 is uncertain. Behavior-unverified: 0.

### Verdicts by criterion

| Criterion | Verdict |
| --------- | ------- |
| 1. API and CLI refuse before any git call | ✓ VERIFIED under scoping, with open items. Gate names and reason codes unchanged. Open: decision 3 (unit is the surface, not the session); decision 4 (collector cwd reads). The default-off posture is kept by owner decision and is not an open item. |
| 2. Scoped credential cannot read another repository's worktrees or corpus | ⚠️ PARTIAL. VERIFIED for worktree lists (rows 7, 8), corpus plan, ingest, status, reconcile, root, anchor and proof refusal (rows 9-10), ledger (12), graphs (13), docs (14), writes (15), reaper (16), memory search (19), memory verify (20) and live-session routes (17, 18, 21). UNCERTAIN for the corpus proof disclosure (row 11, decision 1). |

**HARD-S2 (REQUIREMENTS.md:113), against the amended text (binding for this record):**
- Repository access may be requested by path only where the path resolves to a registered repository: **MET where a registry is set; default-off posture kept by owner decision.** A server with a registry cannot start without `SUBSTRATE_REPO_SCOPES` (config.ts `repoScopeOrRefuse` 975-976; index.ts:65; both unchanged in range).
- Canonicalise paths; component-wise roots; traversal and symlink rejection, including after registration: **MET** for the gated doors (repo-scope.ts `contains`, `resolveContained` 211, `locateRepoPath` 247; overlap refusal at parse).
- Repository access granted per surface; every route and tool resolves the caller's surface and refuses an ungranted repository: **MET** for the gated doors (REST default deny server.ts:966, MCP batch default deny server.ts:2768, route-policy.ts, `isGranted` 264).
- Repo A credentials cannot authorise repo B: **MET** for the gated doors.
- Argv-only git: **MET** for the gated doors that spawn git (`discover.ts`, `gitio.ts`, `install-git-hook.ts`; argv arrays, unchanged). **Amended in this record:** `repo-executor.ts` no longer spawns anything (a46d42c3), so the executor's argv property is a contract on the injected runner, not code in the file, and no production runner exists. Not a regression of a gate; the executor is not wired.

**HARD-S2 against the original 23bd0733 text** ("Resolve least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B"): **UNMET AS WRITTEN.** No repository-specific credential reference exists. The credential is a surface bearer token. This is the owner-amended clause, recorded here, not re-decided.

**Decision status:** Open and owner-held: (1) corpus proof disclosure; (3) allowlist unit (surface versus session); (4) scope of "the CLI". The fourth item is carried as the prior record carried it: no record in the repository closes it, and the assignment did not list it. Row 19 legacy-row repair is an owner data decision and does not block the gate. Decided and in force, not reopened: the phase 72 default-off posture. Recorded, not re-decided: (2) the credential model, as amended in a147228f. Closed: row 8 (JUnit r36 at a46d42c3; r33 at 6e5d766e; scratch PG 16 at 42e3cf13); row 18 (a51a698c; r36 title passes); row 19 regression (exact spelling, 4b84e50c); 6c (500e4fb3); refuse-to-start (500e4fb3); 5d and 6b (a28ecac8).

## What changed since 6e5d766e, and why it matters to the gates

1. **No gate changed.** Gate bodies, grant reads, refusal reason codes and the order of gate before read/write are as in the 6e5d766e record. Every changed covered-file hunk is one of: a reporting `.catch` after a write; a null-body refusal ahead of a gate that already existed; a retry in the root keeper; a removed unreferenced symbol; a comment.
2. **Null body reaches the event query gate (f0f3c04e).** `queryEventsFor` now maps `null` to `{}`, so `scopedRepoRefusal("events_query", …, required: true)` runs for a `null` body as it does for `{}`. Before the change a `null` body threw before the gate. The change makes the refusal reachable, not looser.
3. **Scoped git executor (a46d42c3).** Dead code removed (`defaultScopedGitRunner`, `spawnSync` import). `scopedGit` unchanged. Still not wired. The removed runner's env settings must be restored by whichever phase wires it (warning below).
4. **Covered digest.** Changed because six covered files changed content. The prior frontmatter digest was stale (see the digest correction).

## Human Verification Required

1. **Row 11, decision 1 (corpus proof disclosure).** Decide whether a granted caller receiving root, treeSize, index and the audit path counts as reading another repository's corpus. Options: accept as allowed, rebuild per repository, or withhold foreign siblings, index and treeSize. **Why human:** a policy reading of "read".
2. **Decision 3 (allowlist unit, criterion 1).** Confirm the surface, not the session, is the intended allowlist unit. **Why human:** design decision.
3. **Decision 4 (scope of "the CLI", collectors).** Decide whether `packages/collectors/src/git-context.ts`, `muse.ts` and `cursor-stop.ts` cwd reads are inside criterion 1. **Why human:** scope of "the CLI".
4. **Row 19 legacy-row repair (owner, not the gate).** The gate is correct for legacy rows; the owner decides whether legacy rows with a dangling surrogate in repo are repaired or left unmatched. **Why human:** data decision.

## Gaps Summary

Status is `human_needed`. No truth is FAILED on the evidence read here. Rule 2 fires: row 11 is uncertain and decisions 1, 3, 4 and the row 19 data decision are open.

- **Row 8 (JUnit r36 at a46d42c3).** The Postgres list filter has 13 named, unskipped passes.
- **Scoped git executor (NOT_WIRED, unchanged).** No production caller; refusal behaviour unchanged; 12 of 12 executor testcases pass in r36.
- **Criterion 1 (verified under scoping, with open items).** Open: decision 3, decision 4.
- **Criterion 2 (partial).** Open: the corpus proof disclosure (decision 1, row 11).
- **HARD-S2 (partial, amended text).** The identifier clause holds wherever a registry is set; the default-off posture is kept by owner decision.
- **HARD-S2 (original text).** Unmet as written. Recorded, not re-decided.

**Warnings and info (not blocking, carried or new):**
- **New, warning: the removed runner's env settings are now applied by no code.** `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=true`, and the `GIT_CEILING_DIRECTORIES` value passed by `scopedGit` (repo-executor.ts:82). The phase that wires `scopedGit` must supply a runner that applies them.
- **Carried, warning: `repo-executor.ts:13` says phase 74 calls `scopedGit`; no caller exists.**
- **New, warning: the ROADMAP.md Phase 72 status line (line 1256) still carries the 4b84e50c counts ("24 of 27 truth rows verified at 4b84e50c") and does not name the r36 evidence.** Orchestrator document; not edited here.
- Row 19 door-level test is absent: the lone-surrogate classes at `memoryReplyInGrant` are covered by the helper test and a probe, not a door test. Warning, carried.
- Scoping is off by default: criteria 1 and 2 hold only when a registry or scopes are set. Owner decision in force (default-off kept).
- Carried info: `route-policy.ts:51` says derived hits are not yet filtered; the code filters them (service.ts:6910, the `derived` filter in `memoryReplyInGrant`).
- Carried info: `live-session-scope.test.ts` public-route test name "refused before the session authority is read" describes default deny, not the repository gate.
- Info: `72-01-PLAN.md` D72-07 signature differs from the shipped `scopedGit(request, run)`.
- Info: the prior frontmatter digest (`459ef7fa…`) did not reproduce; the body value (`e37dee37…`) did. Corrected here.

---

_Verified: 2026-11-06T00:44:18Z_
_Verifier: Claude (gsd-verifier, phase 72 re-verification at a46d42c3; draft, read-only on the repository)_
