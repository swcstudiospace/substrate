---
phase: 72-repo-allowlist-and-scoped-credentials
verified: 2026-11-02T10:27:30Z
status: human_needed
score: 16/20 must-haves verified
covered_files: [".env.example", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-PLAN.md", ".planning/phases/72-repo-allowlist-and-scoped-credentials/72-01-SUMMARY.md", "docs/worktree-fleet-api.md", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.test.ts", "packages/cli/src/worktree/scope.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-recall.ts", "packages/mcp-server/src/repo-executor.test.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.boundary.test.ts", "packages/mcp-server/src/repo-scope.reads-writes.test.ts", "packages/mcp-server/src/repo-scope.routes.test.ts", "packages/mcp-server/src/repo-scope.test.ts", "packages/mcp-server/src/repo-scope.ts", "packages/mcp-server/src/route-policy.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/worktree-registry-fake.ts", "packages/mcp-server/src/worktree-registry.testkit.ts", "packages/mcp-server/src/worktree-registry.ts"]
covered_digest: "v3:sha256:ca0ef38d90094db8d2329e825d321c589ce0e0ddf02fdd5d1ac4677af63d42f4"
behavior_unverified: 3
overrides_applied: 0
desk_gate: "Desk Quality / Programming Lead review WAIVED by the user on 2026-11-12 (answers what=not_real, needs=greptile_only). Status stays human_needed: the two owner decisions below are not waived."
re_verification:
  previous_status: gaps_found
  previous_score: 13/19
  gaps_closed:
    - "SC2 memory search: a global, person or agent row whose own repo is not granted is dropped from the reply (service.ts memoryReplyInGrant per-entry grant check)"
    - "SC2 memory verify: an entry in an ungranted repository answers as an unknown id before its hash, anchor or content is read (service.ts reader grant and getEntry visibility check)"
    - "SC1 API: POST /drift boundary test (403 repo-not-granted, scan not called, zero git spawns, refusal audited)"
    - "SC2 API: GET /worktrees and GET /corpus/proof boundary tests (named ungranted repo refused before the store or manifest read; unnamed read returns granted rows only)"
  gaps_remaining:
    - "HARD-S2 credential clause (per-repository credential references): human decision 2"
    - "Corpus proof disclosure of other repositories' leaf commitments: UNCERTAIN, human decision 1"
  regressions: []
deferred:
  - truth: "scopedGit has a production caller (PLAN D72-07)"
    addressed_in: "Phase 74"
    evidence: "Phase 74 success criteria name Phase 72's registry and scoped executor as its dependency"
behavior_unverified_items:
  - truth: "SC1 MCP door: drift_scan (mcp.ts:2003) refuses an ungranted repository or path before any git call"
    test: "Call MCP tools/call drift_scan naming a path in owner/b from a surface granted only owner/a, with a spy on Bun.spawnSync."
    expected: "isError refusal; zero git argv calls; one repo.scope-refused warning in the ledger."
    why_human: "The service gate and the REST door are tested. No MCP test exercises drift_scan; drift.test.ts has no scope references."
  - truth: "SC2 Postgres worktree store: the list filter lower(repo) in (select jsonb_array_elements_text(...)) returns only granted rows"
    test: "Run the worktree-registry contract against a Postgres database with rows for owner/a and owner/b, filter repos=[owner/a]."
    expected: "Only owner/a rows; an empty repos list returns no rows; the filter runs in SQL, not after the read."
    why_human: "worktree-registry.pg.test.ts has no repos case, and no database was started for this verification."
  - truth: "SC2 live session issue/transition: updateLiveSession refuses a repo_id outside the grant before authority.issue or transition"
    test: "Call substrate.updateLiveSession as a surface granted owner/a with repo_id owner/b, session_id unset (issue) and set to a owner/b session (transition)."
    expected: "not-found refusal; authority.issue and transition not called; one repo.scope-refused warning."
    why_human: "No test calls updateLiveSession under scoping; the live-session and observe tests have no scope references."
human_verification:
  - test: "Decide whether a granted corpus proof (GET /corpus/proof) discloses another repository's corpus"
    expected: "Decision recorded: accept the whole-corpus root, treeSize and sibling leaf commitments as allowed, or rebuild the proof per repository or withhold foreign siblings"
    why_human: "Leaves are H(repo, path, sha256) commitments over all repositories; the reply carries the whole-corpus root and size. Whether that counts as reading another repository's corpus is a policy call."
  - test: "Decide the credential model for criterion 2 and HARD-S2"
    expected: "Either accept the surface bearer plus its repository grant (D72-03) and amend HARD-S2, or add repository-specific credential references"
    why_human: "config.ts has no per-repository credential. HARD-S2 requires repository-specific references; the roadmap wording can be read either way."
  - test: "Confirm the allowlist unit is the surface, not the session"
    expected: "Confirmation that SUBSTRATE_REPO_SCOPES keys (surfaces) satisfy the roadmap's 'session's allowlist'"
    why_human: "Criterion 1 says session; the code grants per surface."
  - test: "Run the three behavior_unverified_items: MCP drift_scan refusal, Postgres worktree filter, live-session issue/transition gate"
    expected: "Each passes as written in behavior_unverified_items"
    why_human: "Requires a Postgres database for the filter and new tests for the other two."
---

# Phase 72: Repo allowlist and scoped credentials Verification Report

**Phase Goal:** A session can address only the repositories on its allowlist, and each repository's credential is scoped to that repository.
**Verified:** 2026-11-02T10:27:30Z
**Status:** human_needed
**Re-verification:** Yes, after gap closure (commit e855734b on top of c4ea08d4). The prior report (gaps_found, 13/19) is replaced.

Scope: branch gsd/v18-p72-repo-allowlist at HEAD e855734b. Success criteria from the phase 72 entry of origin/main `.planning/ROADMAP.md`, verbatim:
1. A repository outside the session's allowlist is refused at the API and the CLI before any git call runs.
2. A credential scoped to one repository cannot read another repository's worktrees or corpus.

The re-verification counts 20 truths. The prior 19 split truth 2 into REST (2a, now proven) and MCP (2b, still unexercised).

## Verdicts by criterion

| Criterion | Verdict |
| --------- | ------- |
| 1. API and CLI refuse before any git call | ✓ VERIFIED, with one WARNING: the MCP `drift_scan` door is wired but has no test (2b) |
| 2. Scoped credential cannot read another repository's worktrees or corpus | ⚠️ NOT YET CLEAN: worktree and corpus rows are refused in code and tests; the corpus proof disclosure is UNCERTAIN (human decision 1); the credential model is a human decision (human decision 2); the Postgres filter has not been executed (7) |

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1 service: a drift scan naming an ungranted repository, or a path in another repository, is refused before any git call | ✓ VERIFIED | `scopedDriftScan` gate at service.ts:7359-7367; `driftScan` is called only after the gate (7366). Boundary test `repo-scope.boundary.test.ts` passes (run A). |
| 2a  | SC1 REST: `POST /drift` calls the gate, and the refusal precedes the scan and any git call | ✓ VERIFIED | Wiring at server.ts:1584. `repo-scope.routes.test.ts` "POST /drift (repo-keyed door)" passes: 403 `repo-not-granted`, `driftScan` not called, zero `git` spawns, zero ledger reads, refusal audited under route `drift`. |
| 2b  | SC1 MCP: `drift_scan` calls the gate before git | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Wiring at mcp.ts:2003. No MCP test. `drift.test.ts` has no scope references. See behavior_unverified_items. |
| 3   | SC1 API: every route or tool that no declaration names is refused to a scoped caller before its handler | ✓ VERIFIED | Default deny at server.ts:965-970 (REST) and by `toolDeclaration` for MCP (server.ts:2750, prior pass, unchanged). `repo-scope.routes.test.ts` default-deny tests pass (run C). |
| 4   | SC1 CLI: `substrate worktree` refuses an ungranted root, `--repo`, provision target, merge-back path or guard path before any git call, exit 2 | ✓ VERIFIED | `scopeRefusal` at command.ts:557, before the dispatch switch. `packages/cli/src/worktree/scope.test.ts` passes (run A). |
| 5   | Path containment: `..`, symlinks and registered roots are compared after realpath; overlapping registrations are refused at boot | ✓ VERIFIED | `repo-scope.ts` (`resolveContained`, `locateRepoPath`, `parseRepoRegistry` overlap refusal, prior-pass line refs 136-141, 188-226). `repo-scope.test.ts` and the boundary symlink test pass (run A). |
| 6   | SC2 worktrees, fake store: an unfiltered scoped list returns only granted rows; a named ungranted repository is refused before the read | ✓ VERIFIED | `listWorktrees` at service.ts:4844-4869: named refusal 4847-4849; `repos` filter passed to the store 4852-4863. Fake filter at `worktree-registry-fake.ts:56`. `GET /worktrees` tests pass (run C). |
| 7   | SC2 worktrees, Postgres: the list query filters in SQL | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | SQL at `worktree-registry.ts:390-397`. `worktree-registry.pg.test.ts` has no repos case. No database run. |
| 8   | SC2 corpus: plan, ingest and proof refuse an ungranted repository after parse and before any manifest or plane read | ✓ VERIFIED | `repoRefusalOf` at corpus/service.ts:154-163; proof gate runs before `deps.roots.read()` (corpus/service.ts:294-318). The `GET /corpus/proof` test passes with zero store reads (run C); boundary corpus tests pass (run A). |
| 9   | SC2 corpus: status and reconcile are refused to scoped callers; root and anchor are refused by default deny | ✓ VERIFIED | `allReposRefusal` at corpus/service.ts:166-168, used by status (238) and reconcile. Root and anchor are undeclared in route-policy, so default deny refuses them. Routes and boundary tests pass. |
| 10  | SC2 corpus proof disclosure: a granted proof reveals no other repository's digests | ❓ UNCERTAIN (WARNING) | The proof reply carries `root`, `treeSize` and the audit path from `inclusionOf` over the whole-corpus tree (corpus/root.ts:49-60, 84-93). Sibling leaves are `corpusLeafHex(repo, path, sha256)` (packages/corpus/src/leaf.ts:65), so they cover other repositories' documents. No content is disclosed. Human decision 1. |
| 11  | SC2 ledger: a named ungranted repository is refused before the query; rows are filtered to the grant; rows without a repository are dropped | ✓ VERIFIED | `queryEventsFor` gate and `rowsInGrant` (prior-pass refs 6372-6380). Reads-writes and routes ledger tests pass (runs B, C). |
| 12  | SC2 graphs: a graph's repository is read from its row and must be granted before content is read; no resolvable repository is refused | ✓ VERIFIED | `graphRepoOf` and `scopedGraphRefusal` (prior-pass refs 6290-6308). Graph tests in reads-writes pass (run C). |
| 13  | SC2 docs: search and LightRAG query refused to every scoped surface before any retrieval or fallback | ✓ VERIFIED | `scopedDocsRefusal` (prior-pass ref 6321-6323). Docs test passes (run C). |
| 14  | SC2 writes: `events_emit`, `graph_register`, `handoff` refuse an ungranted or absent target before the write | ✓ VERIFIED | `scopedWriteRefusal` (prior-pass ref 6330-6341). Write tests pass (run C). |
| 15  | SC2 lease reaper: an unnamed reap touches only granted repositories; a named ungranted reap reaps nothing | ✓ VERIFIED | `reapExpiredLeases` gate (prior-pass ref 7091-7105). Test passes (run C). |
| 16a | SC2 live sessions, discovery: an unnamed discovery by a scoped caller is refused | ✓ VERIFIED | Gate at service.ts:2050 (prior-pass ref). `repo-scope.routes.test.ts` live discovery test passes (run C). |
| 16b | SC2 live sessions, issue and transition: an ungranted `repo_id` is refused before `authority.issue` or `transition` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Gate at service.ts:1999-2006 (prior-pass ref). Grep finds no scoped test of `updateLiveSession`. See behavior_unverified_items. |
| 17  | SC2 memory search: a scoped caller receives only entries whose scope and own `repo` are both granted (FIXED in e855734b) | ✓ VERIFIED | service.ts:6399-6407 now calls `grantedToCaller(undefined, entry.repo, granted)` for every entry before the scope check. `memoryGrant` at 6420-6425. `grantedToCaller` at memory-policy.ts:428-438. Both MCP paths (mcp.ts:902, 908) call `memoryReplyInGrant`; there is no REST memory-search route. Test "a memory row whose own repository is ungranted is dropped even under a global scope" passes (runs B, C). |
| 18  | SC2 memory verify: a scoped caller gets no verdict for an entry of an ungranted repository (FIXED in e855734b) | ✓ VERIFIED | Reader gate at service.ts:4161-4170; reader built with `granted` at 4175; `getEntry` returns null through `visibleToCaller` at 4183 before any hash, anchor or content read. `visibleToCaller` at memory-policy.ts:445-451. Tests "verifying an entry as an ungranted repository is refused..." and "an entry in an ungranted repository is answered as an unknown id, and its content is never read" pass, with the same not_found message as an unknown id. Positive control passes (runs B, C). |

**Score:** 16/20 truths verified (3 present but behavior-unverified: 2b, 7, 16b; 1 uncertain: 10; 0 failed).

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | `scopedGit` has a production caller (D72-07) | Phase 74 | Phase 74 success criteria name Phase 72's registry and scoped executor as its dependency. |

### Judgements on the open points from the brief

- **(c) Unnamed `GET /worktrees` returns granted rows with 200. Verdict: conforms; not a gap.** The criterion says a scoped credential cannot read another repository's worktrees. The reply is restricted to the granted repositories: the store is asked for `repos: ["owner/a"]` (service.ts:4852-4863), and the route test asserts only `owner/a` rows. A refusal is required for a named ungranted repository, and that path returns 403 before the store is read (service.ts:4847-4849; test passes). PLAN D72-05 and §5 specify filtering for the unnamed case, and §8's refuse-unnamed rule does not list worktrees.
- **Memory fixes (17, 18)** are in the phase goal, not in the literal criterion wording (worktrees or corpus). Verified on their own terms.
- **Default deny** also refuses `POST /memory` and MCP `memory_write` to scoped surfaces (both undeclared in route-policy). This is fail-closed. It is recorded as an operator consequence below, not as a gap.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/repo-scope.ts` | Pure gate, parsers, refusal payload | ✓ VERIFIED | Behaviour covered by run A. |
| `packages/mcp-server/src/repo-executor.ts` | `scopedGit` (Phase 74 entry point) | ✓ VERIFIED (deferred) | Unit tests pass (run A). No production caller until Phase 74. |
| `packages/cli/src/worktree/scope.ts` | CLI gate before git | ✓ VERIFIED | Wired at command.ts:557; tests pass (run A). |
| `packages/mcp-server/src/route-policy.ts` | Default-deny declarations | ✓ VERIFIED | Stale comment at line 51 (Info, below). |
| `packages/mcp-server/src/service.ts` | Gates and filters | ✓ VERIFIED | Fix sites 4161-4183 and 6396-6425 read and tested this pass. |
| `packages/mcp-server/src/corpus/service.ts` | Corpus gates | ✓ VERIFIED | `repoRefusalOf`, `allReposRefusal`, gates on plan, ingest, proof, status and reconcile. |
| `packages/mcp-server/src/worktree-registry*.ts` | `repos` filter in store | ✓ VERIFIED (fake); ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (Postgres, 7) | |
| `packages/mcp-server/src/config.ts` | `repoScope` from env; ConfigError on malformed values | ✓ VERIFIED | Parser tests in `repo-scope.test.ts` pass (run A). |
| `docs/config-reference.md` | Both new flags documented | ✓ VERIFIED | Both flags now present (prior-pass warning cleared). |
| `.planning/REQUIREMENTS.md` HARD-S2 | Requirement text | ⚠️ NOT UPDATED | Still "Not started" (unchanged by e855734b). Human decision 2. |

### Key Link Verification

Step 4 and Step 5 are not applicable: `72-01-PLAN.md` declares no `must_haves.artifacts` or `key_links`. Wiring was checked by reading the code.

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| server.ts `POST /drift` | `scopedDriftScan` | server.ts:1584 | ✓ WIRED | Now exercised by the routes test. |
| mcp.ts `drift_scan` | `scopedDriftScan` | mcp.ts:2003 | ✓ WIRED | Not exercised by any test (2b). |
| server.ts `GET /worktrees` | `listWorktrees(query, surface)` | server.ts | ✓ WIRED | Exercised by the routes test. |
| mcp.ts `worktree_list` | `listWorktrees(query, callerSurface)` | mcp.ts | ✓ WIRED | Code read only. |
| `memoryReplyInGrant` | per-entry repo grant | service.ts:6403 | ✓ WIRED | Fixed; tested. |
| `memoryVerify` reader | grant callback | service.ts:4175 | ✓ WIRED | Fixed; tested. |
| `scopedGit` | production git call sites | repo-executor.ts | ✗ NOT_WIRED (deferred to Phase 74) | Not a gap for this phase. |

### Data-Flow Trace (Level 4)

Not applicable. The phase adds gates and filters, not rendered output.

### Behavioral Spot-Checks

Runs used `bun --no-env-file test` inside a bwrap sandbox: `/etc/substrate` masked with tmpfs, TMPDIR and HOME in an owned directory under `/root/src/worktrees/backups/gate-tmpfs`, minimal environment. No Postgres, no full suite, no typecheck, no lint, no formatters.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| CLI refusals, boundary tests, parsers, executor (4 phase files, whole) | `bun --no-env-file test packages/cli/src/worktree/scope.test.ts packages/mcp-server/src/repo-scope.boundary.test.ts packages/mcp-server/src/repo-scope.test.ts packages/mcp-server/src/repo-executor.test.ts` | 60 pass, 0 fail (4 files) | ✓ PASS (run A) |
| Named new and affected tests | same runner over `repo-scope.reads-writes.test.ts` and `repo-scope.routes.test.ts` with `-t "memory\|POST /drift\|GET /worktrees\|GET /corpus/proof"` | 17 pass, 0 fail | ✓ PASS (run B) |
| Both phase-72 read/write and route files, whole | same runner, no name filter | 86 pass, 0 fail (prior run of the same files: 79 pass; +7 new tests) | ✓ PASS (run C) |
| Debt markers (TBD, FIXME, XXX) in every covered file | grep | no matches | ✓ PASS |
| Postgres worktree filter (7) | not run (no database, per instruction) | n/a | ? SKIP |
| MCP drift_scan refusal (2b), live issue gate (16b) | no test exists | n/a | ? SKIP |

Probe execution: no probes declared or found. Not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-S2 | 72-01-PLAN.md | Registered repositories addressed by identifier; canonical paths; allowed roots enforced; traversal and symlink escape rejected; least-privilege credentials by repository-specific references; repo A credentials cannot authorize repo B; argv-only git | ⚠️ PARTIAL (credential clause is a human decision) / ✓ SATISFIED (paths, traversal, symlinks, argv, grant isolation at the gates) | No per-repository credential type or reference exists (config.ts; D72-03). Argv-only git and the grant isolation are covered by runs A-C. |

No orphaned requirements: HARD-S2 is the only phase-72 mapping in REQUIREMENTS.md.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| packages/mcp-server/src/route-policy.ts | 51 | Comment says memory_search "derived hits are not yet filtered, RS-07". The code filters them (service.ts:6415). | ℹ️ Info | Stale comment, now contradicts the code. |
| packages/mcp-server/src/server.ts | 2336, 2365 | `/worktrees/report` and `/worktrees/claims` are default-denied to every scoped surface | ⚠️ Warning (carried forward) | Intended, but the operator consequence is not in the summary's open risks. |
| memory write (`POST /memory`, MCP `memory_write`) | route-policy | Undeclared, so default-denied to scoped surfaces | ℹ️ Info | Fail-closed. A scoped surface cannot write memory. Operator consequence to document. |
| packages/cli/src/worktree/command.ts | ~487 | `check-ref-format` git call in `deps.cwd` before a `--repo` checkout is used | ℹ️ Info (carried forward) | Low risk, as previously recorded. |
| .planning/ROADMAP.md (branch), REQUIREMENTS.md HARD-S2 | — | Status text still reads "Not started" | ℹ️ Info | Planning state not updated on this branch. |

Debt-marker gate: no TBD, FIXME or XXX markers in any covered file. Passes.

### Human Verification Required

These are decisions and checks outside automated reach. Status is `human_needed`.

1. **Corpus proof disclosure (truth 10).** Decide whether a granted caller receiving the whole-corpus `root`, `treeSize` and audit path (siblings are commitments over other repositories' `(repo, path, sha256)`) counts as reading another repository's corpus. If it does, criterion 2 is not met. The fix is a per-repository tree, or withholding foreign siblings.
   - **Expected:** a recorded decision.
   - **Why human:** a policy reading of "read", not decidable from code.
2. **Credential model (criterion 2, HARD-S2).** Decide whether the surface bearer plus its repository grant (D72-03) is the "credential scoped to one repository". Or require repository-specific credential references, and amend HARD-S2 otherwise.
   - **Expected:** a recorded decision, and HARD-S2 updated to match.
   - **Why human:** the roadmap wording can be read either way; HARD-S2 names repository-specific references explicitly.
3. **Allowlist unit (criterion 1).** The roadmap says "session's allowlist". The code grants per surface (`SUBSTRATE_REPO_SCOPES` keys are surfaces).
   - **Expected:** confirmation that the surface is the intended unit.
   - **Why human:** a design decision.
4. **MCP `drift_scan` refusal (2b).** Run the MCP drift test described in behavior_unverified_items.
5. **Postgres worktree filter (7).** Run the worktree-registry contract against a database with rows for two repositories.
6. **Live-session issue and transition gate (16b).** Add and run the test described in behavior_unverified_items.

### Gaps Summary

No truth FAILED and no artifact is missing or stubbed, so no gap blocks the phase goal. Status is `human_needed`.

- **Criterion 1** is met for the REST door, the service gate, and the CLI, with each refusal before any git call. The MCP `drift_scan` door is wired but untested (2b).
- **Criterion 2** is met for worktree and corpus reads at the gates and in tests, including the memory fixes. Three items keep it from a clean pass: the corpus proof disclosure (decision 1), the credential model (decision 2), and the Postgres filter (7). The live-session issue gate (16b) is also untested.
- The fix commit closed the two prior FAILED truths (17, 18) and the PLAN §8 boundary-test gaps for `/drift`, `/worktrees` and `/corpus/proof`.

---

_Verified: 2026-11-02T10:27:30Z_
_Verifier: Claude (gsd-verifier)_
