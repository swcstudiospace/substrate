---
phase: 74-cross-repo-compensating-actions
verified: 2026-11-06T02:55:41Z
status: human_needed
score: "4 of 4 roadmap criteria PASSED (override); status human_needed: the whole phase is deferred past v1.8 by owner decision 2026-11-06; two human items and two behavior-unverified items remain open"
covered_files: [".planning/REQUIREMENTS.md", ".planning/ROADMAP.md", ".planning/phases/74-cross-repo-compensating-actions/74-SUMMARY.md", "packages/cli/src/corpus/ingest.ts", "packages/cli/src/worktree/command.ts", "packages/cli/src/worktree/scope.ts", "packages/collectors/src/install-git-hook.test.ts", "packages/collectors/src/install-git-hook.ts", "packages/mcp-server/src/redact.ts", "packages/mcp-server/src/repo-executor.ts", "packages/mcp-server/src/repo-scope.ts"]
covered_digest: "v3:sha256:2d0964ae2d1c1ce08893e189b2a6a984f83a534bbfe3fe255c1bd9278116b44b"
behavior_unverified: 2
overrides_applied: 4
overrides:
  - must_have: "HARD-R1: Execute a real operation across at least two registered repositories with a durable per-step transaction log and idempotent retries. Forced failure leaves compensated state or explicit needs-attention state; no silent partial success. Absence of an existing transaction path is not delivery. (REQUIREMENTS.md:118)"
    reason: "HARD-R1 waived for v1.8 and deferred to after v1.8 (owner decision 2026-11-06), as part of the whole-phase deferral with overrides 1 to 3."
    accepted_by: "owner"
    accepted_at: "2026-11-06T00:00:00Z"
  - must_have: "SC1: a real operation across at least two registered repositories persists operation and per-step state before effects, with stable dedupe keys and idempotent per-step retry"
    reason: "Deferred past v1.8: the whole phase is deferred by owner decision 2026-11-06. SC1 is accepted as an override and is not delivered."
    accepted_by: "owner"
    accepted_at: "2026-11-06T00:00:00Z"
  - must_have: "SC2: a forced failure at step N leaves compensated pre-operation state or a durable needs-attention result naming unfinished or failed compensation steps"
    reason: "Deferred past v1.8: the whole phase is deferred by owner decision 2026-11-06. SC2 is accepted as an override and is not delivered."
    accepted_by: "owner"
    accepted_at: "2026-11-06T00:00:00Z"
  - must_have: "SC3: failure and compensation failure are exercised against temporary real repositories; recovery or status exposes the parked result and never overwrites an outside ref change or silently repeats a completed effect"
    reason: "Deferred past v1.8: the whole phase is deferred by owner decision 2026-11-06. SC3 is accepted as an override and is not delivered."
    accepted_by: "owner"
    accepted_at: "2026-11-06T00:00:00Z"
re_verification:
  previous_status: gaps_found
  previous_score: 0/4
  gaps_closed: []
  gaps_remaining:
    - "SC1: a real operation across at least two registered repositories persists operation and per-step state before effects, with stable dedupe keys and idempotent per-step retry"
    - "SC2: a forced failure at step N leaves compensated pre-operation state or a durable needs-attention result naming unfinished or failed compensation steps"
    - "SC3: failure and compensation failure are exercised against temporary real repositories; recovery or status exposes the parked result and never overwrites an outside ref change or silently repeats a completed effect"
  regressions: []
gaps:
  - truth: "SC1: a real operation across at least two registered repositories persists operation and per-step state before effects, with stable dedupe keys and idempotent per-step retry"
    status: passed
    override_ref: "overrides[1]"
    reason: "No multi-repo operation persists step state. Prune removes each worktree and only then emits its ledger note; no operation id or dedupe key exists. The installer refuses unregistered paths when SUBSTRATE_REPO_REGISTRY is set, but it still iterates argv paths and writes no step record. Ingest keeps results in memory apart from the server's own row skip. scopedGit, reserved for phase 74, still has no production caller. Re-verified at HEAD 5e304ef8: no change in these facts."
    artifacts:
      - path: "packages/cli/src/worktree/command.ts"
        issue: "commandPrune (lines 321-395) runs git worktree remove (line 374), then deps.emit (line 379); no pre-effect step record and no operation id; reads no repository registry (no SUBSTRATE_REPO_REGISTRY or localRegistryScope reference)"
      - path: "packages/collectors/src/install-git-hook.ts"
        issue: "installRepos (line 337) iterates raw argv paths (main, lines 390-404, passes the args.filter output); the registry is read only as a refusal gate in locate() (lines 111-134); no step state"
      - path: "packages/cli/src/corpus/ingest.ts"
        issue: "executeIngest (line 98) keeps per-document results in memory; no client-side durable state or operation id"
      - path: "packages/mcp-server/src/repo-executor.ts"
        issue: "scopedGit (line 74) has no production caller (git grep finds only repo-executor.ts, its test, and a comment in repo-scope.ts:193); phase 74 is not wired to it"
    missing:
      - "A multi-repo operation over registered repositories, run through scopedGit or an equivalent gated path"
      - "A durable operation and step record written before each effect, with stable dedupe keys"
      - "Idempotent per-step retry that consults the step record"
  - truth: "SC2: a forced failure at step N leaves compensated pre-operation state or a durable needs-attention result naming unfinished or failed compensation steps"
    status: passed
    override_ref: "overrides[2]"
    reason: "On failure prune stops and returns 1 with earlier removals kept; its message goes to stderr only. The installer's named failure is stdout only and isolates each repository rather than compensating. Ingest's failed items are printed counts. Nothing compensates and nothing is durable. Re-verified at HEAD 5e304ef8."
    artifacts:
      - path: "packages/cli/src/worktree/command.ts"
        issue: "Failure branch (lines 389-393: deps.err at line 391, then return 1) stops with earlier removals kept; 'stopped; nothing further was removed and nothing was retried' goes to stderr only"
      - path: "packages/collectors/src/install-git-hook.ts"
        issue: "Named failure line (line 382) is written through options.write, which defaults to process.stdout (line 341); no durable record and no compensation"
    missing:
      - "Compensation for each completed step of a failed operation"
      - "A durable needs-attention record naming unfinished or failed compensation steps"
  - truth: "SC3: failure and compensation failure are exercised against temporary real repositories; recovery or status exposes the parked result and never overwrites an outside ref change or silently repeats a completed effect"
    status: passed
    override_ref: "overrides[3]"
    reason: "No recovery or status surface for a parked operation exists. git grep -il compensat over non-markdown tracked files returns no files. The temporary-repository tests cover hook installation, registry refusal and linked-worktree gating; none exercises forced failure, compensation or compensation failure. Re-verified at HEAD 5e304ef8."
    artifacts:
      - path: "packages/collectors/src/install-git-hook.test.ts"
        issue: "Temporary-repository tests exercise installation and registry refusal only"
    missing:
      - "Recovery or status command for a parked operation"
      - "Temporary-repository tests for forced failure and compensation failure"
  - truth: "HARD-R1: durable per-step transaction log and idempotent retries; forced failure leaves compensated or needs-attention state; no silent partial success; absence of an existing transaction path is not delivery"
    status: passed
    override_ref: "overrides[0]"
    reason: "Not delivered: same root cause as SC1 to SC3. HARD-R1 passes by structured owner override for v1.8, part of the whole-phase deferral (owner decision 2026-11-06), deferred to after v1.8 as the owner decided. Not evidence of delivery."
    artifacts:
      - path: ".planning/REQUIREMENTS.md"
        issue: "HARD-R1 checkbox at line 118 is unticked and the table row at line 136 reads 'Not started' at HEAD 5e304ef8; this record does not amend the requirement text, and the amendment is applied by the orchestrator"
    missing:
      - "Delivery of the multi-repo transaction path after v1.8, or an amendment that records the override against the HARD-R1 text in REQUIREMENTS.md and ROADMAP.md"
behavior_unverified_items:
  - truth: "Separate evidence (d65d74fb, install-git-hook robustness): install failure is named with a redacted one-line reason; secret-bearing error text and URL credentials are redacted before printing"
    test: "Make a hook-path read throw with an error whose message contains a token-shaped string and a URL with credentials, then call installRepos and read outcome.errors[0].reason and the printed line"
    expected: "The token and the URL credentials do not appear; the reason is one line and at most 200 characters"
    why_human: "oneLineReason (install-git-hook.ts lines 329-334) calls redact() and replaces URLs, but no test fixture produces a secret or a URL in an error message: install-git-hook.test.ts contains no 'redact', no credential-shaped string, and its throw fixture (line 236-237) is a directory where the hook file belongs. The redaction path is present and wired but not exercised"
  - truth: "Separate evidence (d65d74fb, install-git-hook robustness): a repository is counted once in failures when its corpus step throws after a foreign-hook problem"
    test: "Create a repository with a foreign post-commit hook, then make a later corpus hook step throw (a directory where post-merge belongs), then call installRepos with corpus: true"
    expected: "outcome.failures is 1 for that repository, errors holds one entry for it, and each problem line is printed once"
    why_human: "The finally block in installRepos (lines 383-385) applies the once-count rule. The once-count test (title cited below) combines several foreign hooks and no throw; no test combines a foreign hook with a throw. 74-SUMMARY.md section 4 records the same gap"
coincidental_reliance_items: []
human_verification:
  - test: "Rule whether corpus ingest (one remote target, but a plan that can span several registered repositories) counts as a cross-repo write path"
    expected: "A recorded ruling. It does not change the verdict: SC2 and SC3 fail for ingest either way, since no compensation or durable needs-attention record exists"
    why_human: "Classification question for the owner; not decided by the 2026-11-06 waiver"
  - test: "Rule whether a removed worktree whose ledger note was not recorded (spool off by default) is acceptable under 'a failed undo is recorded, not dropped', or must be tracked"
    expected: "A recorded ruling"
    why_human: "Prune (commandPrune) prints the not-recorded line to stderr only, and a re-run cannot re-emit the note"
  - test: "Add the two behavior_unverified_items tests (redaction of a secret-bearing reason; once-count when a throw follows a foreign hook)"
    expected: "Both pass against the installer as written"
    why_human: "They cover only the separate install fix, not the roadmap success criteria. No such test title exists in source at HEAD; no code was edited in this verification"
---

# Phase 74: Cross-repo compensating actions Verification Report

**Phase Goal:** A real operation spanning at least two registered repositories records durable per-repository step state. Partial failure leaves compensated state or explicit needs-attention, never silent partial success; each retry is idempotent. (ROADMAP.md, phase 74 section, build wording; status line: human_needed, deferred past v1.8 by owner decision 2026-11-06; SC1 to SC3 and HARD-R1 pass by override and are not delivered.)
**Requirement:** HARD-R1 (`.planning/REQUIREMENTS.md:118`, owner-approved text, commit 23bd0733): "Execute a real operation across at least two registered repositories with a durable per-step transaction log and idempotent retries. Forced failure leaves compensated state or explicit needs-attention state; no silent partial success. Absence of an existing transaction path is not delivery." **Passed by structured owner override for v1.8 (accepted_by owner, accepted_at 2026-11-06; deferred to after v1.8). Not delivered.**
**Verified:** 2026-11-06T02:55:41Z
**Status:** human_needed
**Re-verification:** Yes. The prior record (2026-11-05T08:00:19Z, gaps_found, 0/4, HEAD 6e5d766e) is superseded. This re-verification is at code HEAD 5e304ef8. `covered_files` and `covered_digest` are the verbatim output of `gsd_run query verification.fingerprint` at HEAD 5e304ef8 over the six prior covered files plus the code and planning files this record now cites (`repo-scope.ts`, `redact.ts`, `cli/src/worktree/scope.ts`, `ROADMAP.md`, `REQUIREMENTS.md`).

## Decision basis

- **Owner decision, 2026-11-06 (binding; accepted by owner): HARD-R1 is accepted for v1.8 by structured override (`overrides:` in frontmatter; accepted_by "owner"; accepted_at "2026-11-06T00:00:00Z"). HARD-R1 is PASSED (override).** Owner text: "HARD-R1 is waived for v1.8 (accepted by owner, 2026-11-06). HARD-R1 is deferred to after v1.8, as the owner decided." The requirement text is not amended in this record, and the override does not mark HARD-R1 delivered. No transaction path exists on this tree.
- **Scope of the override.** Owner decision 2026-11-06 (accepted by owner): the whole phase 74 is deferred past v1.8. SC1, SC2 and SC3 are accepted by structured override (`overrides` entries 1 to 3, accepted_by "owner", accepted_at "2026-11-06T00:00:00Z"), and HARD-R1 by entry 0. Nothing is delivered: no transaction path exists on this tree. The question whether the decision reaches SC1 to SC3 is answered, so it is no longer a human item.
- **Earlier owner scheduling decision, 2026-11-03** (ROADMAP.md:1286, STATE.md): "scheduled after v1.8 closes". It is superseded as to HARD-R1 status by the 2026-11-06 override. It is not, by itself, an override.
- **D74-1 is withdrawn** in the committed 74-CONTEXT.md ("## Withdrawn"). Withdrawal is not closure, and it did not waive HARD-R1.
- **Plans:** none exist in the phase directory, so PLAN `must_haves` are absent. The roadmap success criteria (SC1 to SC3) and HARD-R1 are the must-haves (Step 2a).
- **Separate evidence:** the install-git-hook robustness fix (d65d74fb) and the phase 72 installer gate are evaluated below as their own rows. They are excluded from the score.
- **Deferred items.** The whole phase 74 is deferred past v1.8 by owner decision (2026-11-06). Its four criteria (SC1 to SC3, HARD-R1) pass by structured override only; none is delivered.

## Changes since the prior record checked

Checked: `git diff 6e5d766e HEAD` over the five covered code files and SUMMARY.md, with `git diff -U0` to list every changed line. The commits that touch covered paths in that range are a46d42c3, b8cbdeac, d9d0a401 and 8ec17832. None changes the logic that SC1 to SC3 depend on:

- `packages/cli/src/corpus/ingest.ts`: `IngestInput` and `IngestOutcome` lost `export` (d9d0a401). Executor logic at lines 98-190 is unchanged. Tombstone scope pass-through (line 157) is unchanged.
- `packages/cli/src/worktree/command.ts`: `WORKTREE_USAGE` and `HttpPosterConfig` lost `export` (d9d0a401). `commandPrune` body is unchanged; its removal, note and failure lines are at 374, 379 and 391.
- `packages/collectors/src/install-git-hook.ts`: `CorpusHook`, `HOOK_STATES`, `HookState`, `RepoFailure`, `InstallOptions` and `InstallOutcome` lost `export` (8ec17832). The `locate()` registry gate (111-134), `installRepos` (337-388) and `oneLineReason` (329-334) are unchanged.
- `packages/mcp-server/src/repo-executor.ts`: the `spawnSync` import and `defaultScopedGitRunner` (12 lines) were removed in a46d42c3. `defaultScopedGitRunner` had no reference at 6e5d766e outside its own definition, so no production behaviour is lost. The `export` keywords on `ScopedGitResult`, `ScopedGitRequest`, `ScopedLocation` and `ScopedGitOutcome` were dropped (b8cbdeac). `scopedGit` (74-84) is unchanged.
- `packages/collectors/src/install-git-hook.test.ts` and `74-SUMMARY.md`: no change in the range.
- No importer of a de-exported name exists in `packages/` (checked by grep; `planning-hash-store.test.ts` imports `IngestOutcome` from `docs-ingest.ts`, a different module).
- Behaviour commits named in the brief (e62bc17b, f1266a9c, 14ac787a, a2176f96, 4c576e5e, 66fa97bd) touch none of the covered paths (checked with `git diff-tree`).

Because the covered-file hunks are declaration-only or removals of dead code, the SC1 to SC3 and HARD-R1 evidence was re-derived from HEAD code rather than carried forward on the diff alone. The verdicts below are unchanged for SC1 to SC3. HARD-R1 changes from `failed` to `passed` by structured owner override, not by evidence.

The prior record's "installer reads no registry" finding stands as corrected in the prior pass: the installer reads `SUBSTRATE_REPO_REGISTRY` as a refusal gate in `locate()`, and does not enumerate the registry.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1: an actual operation across at least two registered repositories persists operation and step state before effects, with stable dedupe keys and idempotent per-step retry | ✓ PASSED (override, owner 2026-11-06: whole phase deferred past v1.8). Not delivered | No multi-repo operation persists state at HEAD 5e304ef8. Prune (`packages/cli/src/worktree/command.ts`, `commandPrune`, lines 321-395) runs `git worktree remove` at line 374 and `deps.emit` at line 379; nothing is recorded before the effect and no operation id or dedupe key exists. Prune reads no repository registry (no `SUBSTRATE_REPO_REGISTRY` or `localRegistryScope` reference in `command.ts`). The installer (`install-git-hook.ts`, `installRepos` at 337, `main` at 390-404) calls `localRegistryScope` and `localPathGate` in `locate()` (lines 112 and 116) and refuses an unregistered path before any git call. It still processes argv paths and keeps no step state. Ingest (`executeIngest`, line 98) keeps results in memory. `scopedGit` (`repo-executor.ts:74`) has no production caller. |
| 2   | SC2: a forced failure at step N yields compensated pre-operation state or a durable needs-attention result naming unfinished or failed compensation steps; never success for a partial operation | ✓ PASSED (override, owner 2026-11-06: whole phase deferred past v1.8). Not delivered | Prune stops at the failing worktree, keeps every earlier removal, returns 1 (line 392), and prints "stopped; nothing further was removed and nothing was retried" to stderr only (line 391). No compensation runs. The installer's named failure (`✗ <repo> — install failed: <reason>`, line 382) goes through `options.write`, which defaults to `process.stdout` (line 341). The `refused` line is a pre-effect refusal, not compensation. Each repository is isolated, so no multi-step operation exists to compensate. Ingest's failed items are printed counts. None is a durable needs-attention record. |
| 3   | SC3: failure and compensation failure exercised against temporary real repositories; recovery/status exposes the parked result; never overwrites an outside ref change or silently repeats a completed effect | ✓ PASSED (override, owner 2026-11-06: whole phase deferred past v1.8). Not delivered | No recovery or status surface for a parked operation exists. `git grep -il compensat -- ':!*.md'` returns no files at HEAD. The temporary-repository tests in `install-git-hook.test.ts` cover installation, the registry refusal and linked-worktree gating; none covers forced failure, compensation or compensation failure. |
| 4   | HARD-R1: durable per-step transaction log and idempotent retries; forced failure leaves compensated or needs-attention state; "absence of an existing transaction path is not delivery" | ✓ PASSED (override, owner 2026-11-06, for v1.8) | Not delivered: same evidence as truths 1 to 3. `REQUIREMENTS.md:118` is unchecked and `:136` reads "Not started; earlier no-op was not delivery" at HEAD. Passed by structured override (accepted_by owner, accepted_at 2026-11-06T00:00:00Z) for v1.8; deferred to after v1.8 as the owner decided. It sits with the SC1 to SC3 overrides (entries 1 to 3), all part of the whole-phase deferral. |

**Score:** 4 of 4 roadmap criteria PASSED (override): SC1 to SC3 and HARD-R1 are accepted by structured owner override (2026-11-06) as part of the whole-phase deferral past v1.8; none is delivered (verified in code: 0 of 3 SC criteria). The two separate-evidence rows marked present-behavior-unverified below are not roadmap truths and are excluded from the score.

### Separate evidence: install-git-hook robustness and registry gate (d65d74fb and phase 72 commits), not roadmap truths, excluded from score

| Behavior | Status | Evidence |
| -------- | ------ | -------- |
| One failing repository does not stop the others; each still gets its hook | ✓ VERIFIED | Gate r38 (`gate-r38-junit.xml`, run at 66fa97bd; covered files identical at 66fa97bd and HEAD): "one failing repository does not stop the others, which still get their hook" in "installRepos keeps going past a failing repository" passed. |
| Failing repository named in the result with a one-line reason; CLI exits 1 | ✓ VERIFIED (non-secret error) | Gate r38: "the failing repository is named in the result with a one-line reason" and "the CLI exits 1 for a failing repository, names it, and still installs the others" passed. Both use a directory where the hook file belongs; neither carries a secret. |
| No-failure output unchanged | ✓ VERIFIED | Gate r38: "with no failure the result is unchanged: no errors, the same line per repository" passed. |
| Repository counted once in failures for several foreign-hook problems | ✓ VERIFIED (foreign only) | Gate r38: "a repository with several problems is counted once in failures, not once per problem" passed. The fixture uses foreign hooks only; no throw. |
| Registry gate: a hooks directory outside the registration is refused before any write; an unregistered repository is refused before any git call | ✓ VERIFIED (separate, phase 72) | Gate r38: "a hooks directory outside the registered repository is refused and nothing is written there; an in-repo one still installs" (suite "core.hooksPath under a repository registry"); "with a registry set, an unregistered repository is refused without spawning git, and nothing is written" (suite "a registry is checked before any git call"); linked-worktree pair "a registered linked worktree whose primary is not registered is refused: nothing is written to the primary's hooks and the line names the primary" and "with the primary registered too, the linked worktree installs into the primary's shared hooks". Refusal is a gate; it is not a transaction. |
| Counted once when a throw follows a foreign-hook problem | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | The `finally` in `installRepos` (lines 383-385) applies the once-count rule. No test combines a foreign hook with a throw. See behavior_unverified_items[1]. |
| Reason is redacted before printing (`redact` from `packages/mcp-server/src/redact.ts`) and URLs become `<url>` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `oneLineReason` (lines 329-334) calls `redact` and replaces URLs. No fixture in `install-git-hook.test.ts` produces a secret or URL in an error message. See behavior_unverified_items[0]. |

This evidence does not satisfy SC1 to SC3. It has no operation, no step state, no compensation and no durable record. The named failure is stdout text. The registry gate is a correct refusal for unregistered targets; it does not iterate the registry.

### Deferred Items

None for SC1 to SC3. HARD-R1 is passed by owner override for v1.8 (2026-11-06) and deferred to after v1.8, as the owner decided. The override is not a phase deferral of SC1 to SC3.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/collectors/src/install-git-hook.ts` | Robust per-repository install; registry refusal gate (separate evidence) | ✓ VERIFIED (separate) | Exists, substantive, wired to the CLI and to `render-sync.ts` and `watch-commands.ts`. Not a phase-74 transaction path. |
| `packages/collectors/src/install-git-hook.test.ts` | Tests for the robustness fix and registry gate | ✓ VERIFIED (separate) | Suites cited in the separate-evidence table are present in source and passed in gate r38. |
| `packages/cli/src/corpus/ingest.ts` | Corpus ingest execute half | ✓ WIRED, NOT A TRANSACTION PATH | Exists, substantive (`executeIngest`, line 98), wired (`index.ts` ingest command). No client-side durable state; the tombstone request carries `scope` (line 157). SC1 and SC2 unmet. |
| `packages/cli/src/worktree/command.ts` | Prune execute loop | ✓ WIRED, NOT A TRANSACTION PATH | Exists, substantive. Single-target removal then note emit (374, 379); no step state, no compensation. SC1 and SC2 unmet. |
| `packages/mcp-server/src/repo-executor.ts` | Scoped git executor for phase 74 | ⚠️ ORPHANED | Exists and is correct as a gate; `scopedGit` (line 74) has no production caller. `defaultScopedGitRunner` was deleted in a46d42c3 as dead code. |
| Transaction log / step state module | Durable per-step record (SC1, HARD-R1) | ✗ MISSING | No such file or symbol exists in the tree. |
| Compensation path | Undo of completed steps (SC2) | ✗ MISSING | No compensation code; `git grep -il compensat -- ':!*.md'` returns no files. |
| Recovery/status surface for a parked operation | (SC3) | ✗ MISSING | None exists. |

### Key Link Verification

Step 5 (PLAN key_links) is not applicable: no PLAN.md. Wiring fallback applied to the cross-phase links the codebase declares.

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `packages/mcp-server/src/repo-executor.ts` (`scopedGit`) | Phase 74 cross-repository steps | Declared in `72-01-PLAN.md:50` (D72-07): "Phase 74 calls `scopedGit`" | ✗ NOT_WIRED | No production caller. `git grep scopedGit` finds `repo-executor.ts`, `repo-executor.test.ts`, and a comment in `repo-scope.ts:193`. |
| Installer `installRepos` ↔ `SUBSTRATE_REPO_REGISTRY` | Registered repositories (SC1 wording) | `locate()` in `install-git-hook.ts` | ⚠️ PARTIAL | Wired as a refusal gate (unregistered paths refused before git runs; tested). The operation does not enumerate registered repositories: `main` passes argv paths. SC1 link remains unmet. |
| `commandPrune` ↔ repository registry | Registered repositories | none | ✗ NOT_WIRED | Prune takes worktree roots; it reads no repository registry. |

### Data-Flow Trace (Level 4)

Not applicable: no rendered or user-facing dynamic data in this phase.

### Behavioral Spot-Checks

No tests, tsc, lint or gates were run in this re-verification, per the brief. Evidence is source reads, `git` read-only queries and the existing gate r38 JUnit.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Compensation or transaction-log path exists | `git grep -il compensat -- ':!*.md'` | no files | ✗ FAIL (no behavior to exercise) |
| Scoped executor has a production caller | `git grep -n scopedGit` | only `repo-executor.ts`, its test, and a comment in `repo-scope.ts` | ✗ FAIL (not wired) |
| Prune removal and failure path | not run | prune mutates worktrees; no safe non-mutating run exists in this verification | ? SKIP |

### Probe Execution

| Probe | Command | Result | Status |
| ----- | ------- | ------ | ------ |
| `scripts/*/tests/probe-*.sh` | `find scripts -path '*/tests/probe-*.sh'` | no files; no PLAN or SUMMARY declares a probe | SKIPPED (none declared) |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R1 | none (no PLAN.md; ROADMAP "Plans: none written") | Cross-repo compensating actions with durable per-step log, idempotent retries, and compensated or needs-attention on forced failure | ✓ PASSED (override, owner 2026-11-06, for v1.8); not delivered | `REQUIREMENTS.md:118` unchecked; `:136` "Not started" at HEAD 5e304ef8. No plan claims it. Evidence per truths 1 to 4. |

### Anti-Patterns Found

Debt-marker gate: no `TBD`, `FIXME` or `XXX` in the covered files. The `PLACEHOLDER` matches are pre-existing hook template constants, not stubs.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/cli/src/worktree/command.ts` | 374-379 | Ledger note emitted after removal; a note that is not recorded is said on stderr only and cannot be re-emitted on re-run (spool off) | ⚠️ Warning | Premise for the ledger ruling below. |
| `packages/mcp-server/src/repo-executor.ts` | 74 | `scopedGit` has no production caller | ⚠️ Warning | Phase 72 reserved this for phase 74; the link is unwired. |
| `packages/collectors/src/install-git-hook.ts` | 37, 46-47, 155, 164 | `SRC_PLACEHOLDER`, `CLI_PLACEHOLDER` template constants | ℹ️ Info | Functional path substitution in the hook script; not a stub. |

## Test Evidence

Source of truth for pass or fail: `/root/src/worktrees/backups/gate-r38-junit.xml` (run on 66fa97bd). The covered files are identical at 66fa97bd and HEAD 5e304ef8, so that run is valid for them. Titles only; each title below was grepped in source at HEAD.

In `packages/collectors/src/install-git-hook.test.ts`, all cited titles passed in gate r38:
- "installRepos keeps going past a failing repository" (suite) > "one failing repository does not stop the others, which still get their hook"
- same suite > "the failing repository is named in the result with a one-line reason"
- same suite > "with no failure the result is unchanged: no errors, the same line per repository"
- same suite > "the CLI exits 1 for a failing repository, names it, and still installs the others"
- same suite > "a repository with several problems is counted once in failures, not once per problem"
- "core.hooksPath under a repository registry" > "a hooks directory outside the registered repository is refused and nothing is written there; an in-repo one still installs"
- "a registry is checked before any git call" > "with a registry set, an unregistered repository is refused without spawning git, and nothing is written"
- "a linked worktree's shared hooks need its primary checkout registered" > "a registered linked worktree whose primary is not registered is refused: nothing is written to the primary's hooks and the line names the primary"
- same suite > "with the primary registered too, the linked worktree installs into the primary's shared hooks"

In `packages/mcp-server/src/repo-executor.test.ts`, cited titles passed in gate r38:
- "scopedGit refusals run no git" > "boundary: a path inside no registered repository is refused before the runner is called"
- "scopedGit granted calls" > "a granted path runs git in its resolved target, with discovery ceilinged at the registered directory's parent"
- "scopedGit refuses a nested checkout under a plain registered directory, and an unnamed linked worktree" > "a linked worktree is placed once the registry names it as a checkout of its own"

Gate r38's only failing testcase is "the ratchet is tight: no source counter sits below its baseline" (suite "repository ratchet"), outside this phase's covered files. The brief reports it fixed at code head; that fix was not observed in this re-verification. No pass count is claimed.

**Missing test titles** (behaviour the record asks for, with no title in source):
- A test that installs with a secret-bearing or credential-URL error message and checks the printed reason is redacted and one line (behavior_unverified_items[0]).
- A test that combines a foreign hook with a throw in a later corpus step and checks the once-count (behavior_unverified_items[1]).
- No test exists for forced failure, compensation or compensation failure (SC2, SC3). No title can be cited.

## Owner items open

- Scope of the 2026-11-06 HARD-R1 waiver relative to SC1 to SC3 (the decision as given names HARD-R1 only).
- Corpus ingest classification as a cross-repo write path.
- Prune ledger ruling: a removed worktree whose ledger note was not recorded.
- The two behavior-unverified tests above (work item; no owner ruling needed).

## Human Verification Required

Status is human_needed. These open items remain; the owner's 2026-11-06 scope question is answered (the whole phase is deferred past v1.8), so it is not listed:

1. **Corpus ingest classification.** Rule whether ingest (one remote target, with a plan that can span several registered repositories) counts as a cross-repo write path. It does not change the verdict: SC2 and SC3 fail for ingest either way.
2. **Prune ledger gap.** Rule whether a removed worktree whose ledger note was not recorded (spool off, the default) is acceptable under "a failed undo is recorded, not dropped", or must be tracked.
3. **Behavior-unverified items.** Add the two tests in `behavior_unverified_items`. They cover only the separate install fix.

Planning documents: the HARD-R1 override is a structured `overrides:` entry in this record (accepted_by "owner", accepted_at "2026-11-06T00:00:00Z"). The ROADMAP phase 74 status line and progress row are amended in the same commit to human_needed, deferred past v1.8 by owner decision. The REQUIREMENTS.md lines (118 checkbox, 136 "Not started" row) are unchanged: HARD-R1 is not delivered.

## Gaps Summary

SC1, SC2 and SC3 fail with one root cause: no multi-repository operation with persisted per-step state exists on this tree. The three candidate paths the context names (worktree prune, the git hook installer, corpus ingest) are each idempotent or single-target and keep no durable step record. Prune removes worktrees and emits ledger notes after each effect. The installer refuses unregistered targets against the registry, which is a gate, but still writes hooks from argv paths and keeps no step state. Ingest keeps results in memory apart from the server's own row skip. Phase 72's `scopedGit` has no caller. Nothing compensates and nothing persists a needs-attention record.

HARD-R1 is the same gap, passed by owner override for v1.8 (accepted by owner, 2026-11-06; deferred to after v1.8, as the owner decided). The override is recorded as a structured `overrides:` entry in the frontmatter. It is not evidence of delivery: no transaction path exists on this tree.

_Verified: 2026-11-06T02:55:41Z_
_Verifier: Claude (gsd-verifier)_
