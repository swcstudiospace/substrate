---
phase: 74-cross-repo-compensating-actions
verified: 2026-11-05T08:00:19Z
status: gaps_found
score: 0/4 must-haves verified
covered_files: [".planning/phases/74-cross-repo-compensating-actions/74-SUMMARY.md", "packages/cli/src/corpus/ingest.ts", "packages/cli/src/worktree/command.ts", "packages/collectors/src/install-git-hook.test.ts", "packages/collectors/src/install-git-hook.ts", "packages/mcp-server/src/repo-executor.ts"]
covered_digest: "v3:sha256:7e3cd450f8a019002c6dcf89af34b9ffd56c4668a679415c662da0f8914aba4c"
behavior_unverified: 2
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 0/4
  gaps_closed: []
  gaps_remaining:
    - "SC1 and HARD-R1: a real operation across at least two registered repositories persists operation and per-step state before effects, with stable dedupe keys and idempotent per-step retry"
    - "SC2: a forced failure at step N leaves compensated pre-operation state or a durable needs-attention result naming unfinished or failed compensation steps"
    - "SC3: failure and compensation failure are exercised against temporary real repositories; recovery or status exposes the parked result and never overwrites an outside ref change or silently repeats a completed effect"
    - "HARD-R1: absence of an existing transaction path is not delivery; the owner-approved requirement stands"
  regressions: []
gaps:
  - truth: "SC1 and HARD-R1: a real operation across at least two registered repositories persists operation and per-step state before effects, with stable dedupe keys and idempotent per-step retry"
    status: failed
    reason: "No multi-repo operation persists step state. Prune removes each worktree and only then emits its ledger note; no operation id or dedupe key exists. The installer now refuses unregistered paths when SUBSTRATE_REPO_REGISTRY is set, but it still iterates argv paths and writes no step record. Ingest keeps results in memory apart from the server's own row skip. scopedGit, reserved for phase 74, still has no production caller."
    artifacts:
      - path: "packages/cli/src/worktree/command.ts"
        issue: "commandPrune (lines 321-395) runs git worktree remove (line 374), then deps.emit (line 379); no pre-effect step record and no operation id; reads no repository registry"
      - path: "packages/collectors/src/install-git-hook.ts"
        issue: "installRepos iterates raw argv paths (main passes args.filter output); the registry is read only as a refusal gate in locate(); no step state"
      - path: "packages/cli/src/corpus/ingest.ts"
        issue: "executeIngest keeps per-document results in memory; no client-side durable state or operation id"
      - path: "packages/mcp-server/src/repo-executor.ts"
        issue: "scopedGit has no production caller (git grep finds only its own file and its test); phase 74 is not wired to it"
    missing:
      - "A multi-repo operation over registered repositories, run through scopedGit or an equivalent gated path"
      - "A durable operation and step record written before each effect, with stable dedupe keys"
      - "Idempotent per-step retry that consults the step record"
  - truth: "SC2: a forced failure at step N leaves compensated pre-operation state or a durable needs-attention result naming unfinished or failed compensation steps"
    status: failed
    reason: "On failure prune stops and returns 1 with earlier removals kept; its message goes to stderr only. The installer's named failure is stdout only and isolates each repository rather than compensating. Ingest's failed items are printed counts. Nothing compensates and nothing is durable."
    artifacts:
      - path: "packages/cli/src/worktree/command.ts"
        issue: "Failure branch (break, then return 1) stops with earlier removals kept; 'stopped; nothing further was removed' goes to stderr only"
      - path: "packages/collectors/src/install-git-hook.ts"
        issue: "Named failure line is stdout only; no durable record and no compensation"
    missing:
      - "Compensation for each completed step of a failed operation"
      - "A durable needs-attention record naming unfinished or failed compensation steps"
  - truth: "SC3: failure and compensation failure are exercised against temporary real repositories; recovery or status exposes the parked result and never overwrites an outside ref change or silently repeats a completed effect"
    status: failed
    reason: "No recovery or status surface for a parked operation exists. git grep for compensat over non-markdown source has no matches. The temporary-repository tests cover hook installation, registry refusal and linked-worktree gating; none exercises compensation or compensation failure."
    artifacts:
      - path: "packages/collectors/src/install-git-hook.test.ts"
        issue: "Temporary-repository tests exercise installation and registry refusal only"
    missing:
      - "Recovery or status command for a parked operation"
      - "Temporary-repository tests for forced failure and compensation failure"
  - truth: "HARD-R1: absence of an existing transaction path is not delivery; the owner-approved requirement stands"
    status: failed
    reason: "Same root cause as the three truths above. REQUIREMENTS.md:118 is unchecked and :136 records Not started. STATE.md records the HARD-R1 build-or-waive decision as open for the owner and the phase as scheduled after v1.8. Scheduling is not an amendment of the requirement text and not an override with accepted_by and accepted_at, so the requirement stands."
    artifacts:
      - path: ".planning/REQUIREMENTS.md"
        issue: "HARD-R1 is unchecked and not delivered; the table records Not started"
    missing:
      - "Delivery of the multi-repo transaction path, or an owner waiver recorded against the HARD-R1 text"
behavior_unverified_items:
  - truth: "Separate evidence (d65d74fb, install-git-hook robustness): install failure is named with a redacted one-line reason; secret-bearing error text and URL credentials are redacted before printing"
    test: "Make a hook-path read throw with an error whose message contains a token-shaped string and a URL with credentials, then call installRepos and read outcome.errors[0].reason and the printed line"
    expected: "The token and the URL credentials do not appear; the reason is one line and at most 200 characters"
    why_human: "oneLineReason calls redact() and replaces URLs, but no test fixture produces a secret or a URL in an error message (install-git-hook.test.ts uses an EISDIR error); the redaction path is present and wired but not exercised"
  - truth: "Separate evidence (d65d74fb, install-git-hook robustness): a repository is counted once in failures when its corpus step throws after a foreign-hook problem"
    test: "Create a repository with a foreign post-commit hook, then make a later corpus hook step throw (a directory where post-merge belongs), then call installRepos with corpus: true"
    expected: "outcome.failures is 1 for that repository, errors holds one entry for it, and each problem line is printed once"
    why_human: "The finally block in installRepos applies the once-count rule, but no test combines a foreign hook with a throw; 74-SUMMARY.md section 4 records the same gap"
coincidental_reliance_items: []
human_verification:
  - test: "Owner decision on HARD-R1: build the multi-repo transaction path, or record a waiver against the HARD-R1 text"
    expected: "Either a delivered path that satisfies SC1 to SC3, or an amended REQUIREMENTS.md and ROADMAP.md with accepted_by and accepted_at"
    why_human: "The requirement is owner-approved text; only the owner can waive it. Withdrawing D74-1 does not waive it"
  - test: "Rule whether corpus ingest (one remote target, but a plan that can span several registered repositories) counts as a cross-repo write path"
    expected: "A recorded ruling. It does not change the verdict: SC2 and SC3 fail for ingest either way, since no compensation or durable needs-attention record exists"
    why_human: "Classification question for the owner"
  - test: "Rule whether a removed worktree whose ledger note was not recorded (spool off by default) is acceptable under 'a failed undo is recorded, not dropped', or must be tracked"
    expected: "A recorded ruling"
    why_human: "Prune (commandPrune) prints the not-recorded line to stderr only, and a re-run cannot re-emit the note"
  - test: "Add the two behavior_unverified_items tests (redaction of a secret-bearing reason; once-count when a throw follows a foreign hook)"
    expected: "Both pass against the installer as written"
    why_human: "They cover only the separate install fix, not the roadmap truths; no code was edited in this verification"
---

# Phase 74: Cross-repo compensating actions Verification Report

**Phase Goal:** A real operation spanning at least two registered repositories records durable per-repository step state. Partial failure leaves compensated state or explicit needs-attention, never silent partial success; each retry is idempotent. (ROADMAP.md, phase 74 section, build wording; status "Plans: none written".)
**Requirement:** HARD-R1 (`.planning/REQUIREMENTS.md:118`, owner-approved text, commit 23bd0733): "Execute a real operation across at least two registered repositories with a durable per-step transaction log and idempotent retries. Forced failure leaves compensated state or explicit needs-attention state; no silent partial success. Absence of an existing transaction path is not delivery."
**Verified:** 2026-11-05T08:00:19Z
**Status:** gaps_found
**Re-verification:** Yes. The prior 74-VERIFICATION.md (2026-11-02T16:26:19Z, gaps_found, 0/4) carried a `gaps:` list, so this is a full re-verification at HEAD 6e5d766e. The covered digest was stale because the covered installer and its test changed (phase 72 commits 0504e77c, 27778dee, a28ecac8, 500e4fb3) and the ingest tombstone scope changed (77d6b2c8).

## Decision basis

- **HARD-R1 is not built, and not waived.** The owner's scheduling decision ("scheduled after v1.8 closes", ROADMAP.md:1286, STATE.md) defers delivery. It does not amend the requirement text and records no override with `accepted_by` and `accepted_at`. Step 9b finds no later phase in the milestone (phases 75 to 78 do not name cross-repo compensation), so nothing is deferred and the four gaps stay real.
- **D74-1 is withdrawn** in the committed 74-CONTEXT.md ("## Withdrawn"). Withdrawal is not closure.
- **Plans:** none exist in the phase directory, so PLAN `must_haves` are absent. The roadmap success criteria (SC1 to SC3) and HARD-R1 are the must-haves (Step 2a).
- **Separate evidence:** the install-git-hook robustness fix (d65d74fb) and the phase 72 installer gate are evaluated below as their own rows. They are excluded from the score.

## Changes since the prior record checked

Checked: `git diff d65d74fb HEAD` over the five covered files. Four files changed: `install-git-hook.ts` (+116/-14, registry gate in `locate()`, `refused` status), `install-git-hook.test.ts` (+93/-3, five new registry tests), `corpus/ingest.ts` (+2/-1, tombstone requests carry `scope`), `repo-executor.ts` (+1/-1, `located.ok` shape). `command.ts` is unchanged since before d65d74fb. Commits 49b9aece, b4bdd0fc, d1a5e89b, b4fe6bfe and 6e5d766e do not touch any covered file; they were checked for relevance and carried forward. The prior verdict on SC1 to SC3 and HARD-R1 is re-audited against the changed installer and ingest and holds. The prior "installer reads no registry" finding is corrected: the installer now reads `SUBSTRATE_REPO_REGISTRY` as a refusal gate, but still iterates argv paths and keeps no step state.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1: an actual operation across at least two registered repositories persists operation and step state before effects, with stable dedupe keys and idempotent per-step retry | ✗ FAILED | No multi-repo operation persists state. Prune (`packages/cli/src/worktree/command.ts`, `commandPrune`, lines 321-395) runs `git worktree remove` at line 374 and `deps.emit` at line 379; nothing is recorded before the effect and no operation id or dedupe key exists. Prune reads no repository registry (no `SUBSTRATE_REPO_REGISTRY` or `localRegistryScope` reference in `command.ts`). The installer (`install-git-hook.ts`, `installRepos`, `main`) now calls `localRegistryScope` and `localPathGate` in `locate()` and refuses an unregistered path before any git call. It still processes raw argv paths and writes hooks directly; no step state. Corpus ingest (`executeIngest`) sends tombstones, then document batches; the server skips rows it already recorded, but the client keeps no operation state or dedupe key. `scopedGit` has no production caller. |
| 2   | SC2: a forced failure at step N yields compensated pre-operation state or a durable needs-attention result naming unfinished or failed compensation steps; never success for a partial operation | ✗ FAILED | Prune stops at the failing worktree, keeps every earlier removal, returns 1, and prints "stopped; nothing further was removed and nothing was retried" to stderr only (`command.ts`, the `failure !== null` branch). No compensation runs. The installer's named failure (`✗ <repo> — install failed: <reason>`) is stdout only; the new `refused` line is a pre-effect refusal, not compensation. Each repository is isolated, so no multi-step operation exists to compensate. Ingest's failed items are printed counts. None is a durable needs-attention record. |
| 3   | SC3: failure and compensation failure exercised against temporary real repositories; recovery/status exposes the parked result; never overwrites an outside ref change or silently repeats a completed effect | ✗ FAILED | No recovery or status surface for a parked operation exists. `git grep -i compensat -- ':!*.md'` returns no matches. The temporary-repository tests in `install-git-hook.test.ts` (24 in gate r33) cover installation, the registry refusal and linked-worktree gating; none covers forced failure, compensation or compensation failure. |
| 4   | HARD-R1: durable per-step transaction log and idempotent retries; forced failure leaves compensated or needs-attention state; "absence of an existing transaction path is not delivery" | ✗ FAILED | Same evidence as truths 1 to 3. `REQUIREMENTS.md:118` is unchecked; `:136` records "Not started; earlier no-op was not delivery". No plan claims it (ROADMAP: "Plans: none written"). |

**Score:** 0/4 must-haves verified (0 present-behavior-unverified roadmap truths; 4 failed). The two separate-evidence rows below marked present-behavior-unverified are not roadmap truths and are excluded from the score.

### Separate evidence: install-git-hook robustness and registry gate (d65d74fb and phase 72 commits), not roadmap truths, excluded from score

| Behavior | Status | Evidence |
| -------- | ------ | -------- |
| One failing repository does not stop the others; each still gets its hook | ✓ VERIFIED | JUnit gate r33: "one failing repository does not stop the others, which still get their hook" (suite "installRepos keeps going past a failing repository", 5 tests, 0 failures, no skip). |
| Failing repository named in the result with a one-line reason; CLI exits 1 | ✓ VERIFIED (non-secret error) | JUnit gate r33: "the failing repository is named in the result with a one-line reason"; "the CLI exits 1 for a failing repository, names it, and still installs the others". Both use an EISDIR error with no secret. |
| No-failure output unchanged | ✓ VERIFIED | JUnit gate r33: "with no failure the result is unchanged: no errors, the same line per repository". |
| Repository counted once in failures for several foreign-hook problems | ✓ VERIFIED (foreign only) | JUnit gate r33: "a repository with several problems is counted once in failures, not once per problem". |
| Registry gate: a hooks directory outside the registration is refused before any write; an unregistered repository is refused before any git call | ✓ VERIFIED (separate, phase 72) | JUnit gate r33: "a hooks directory outside the registered repository is refused and nothing is written there; an in-repo one still installs"; "with a registry set, an unregistered repository is refused without spawning git, and nothing is written"; linked-worktree primary-registration pair. Refusal is a gate; it is not a transaction. |
| Counted once when a throw follows a foreign-hook problem | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | The `finally` in `installRepos` applies the once-count rule; no test combines a foreign hook with a throw. See behavior_unverified_items[1]. |
| Reason is redacted before printing (`redact` from `packages/mcp-server/src/redact.ts`) and URLs become `<url>` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `oneLineReason` calls `redact` and replaces URLs; no fixture in `install-git-hook.test.ts` produces a secret or URL in an error message. See behavior_unverified_items[0]. |

This evidence does not satisfy SC1 to SC3 or HARD-R1. It has no operation, no step state, no compensation and no durable record. The named failure is stdout text. The registry gate is a correct refusal for unregistered targets; it does not iterate the registry.

### Deferred Items

None. Step 9b: no later phase of v1.8 (75 to 78) names cross-repo compensation or a multi-repo transaction path. The owner's "after v1.8" scheduling is not a phase and is not an override, so no gap is deferred.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/collectors/src/install-git-hook.ts` | Robust per-repository install; registry refusal gate (separate evidence) | ✓ VERIFIED (separate) | Exists, substantive, wired to the CLI and to `render-sync.ts` and `watch-commands.ts`. Not a phase-74 transaction path. |
| `packages/collectors/src/install-git-hook.test.ts` | Tests for the robustness fix and registry gate | ✓ VERIFIED (separate) | 24 tests, 0 failures in gate r33; 36 pass across this file and `repo-executor.test.ts` in the targeted run. |
| `packages/cli/src/corpus/ingest.ts` | Corpus ingest execute half | ✓ WIRED, NOT A TRANSACTION PATH | Exists, substantive (`executeIngest`), wired (`index.ts` ingest command). No client-side durable state; the tombstone request now carries `scope`. SC1 and SC2 unmet. |
| `packages/cli/src/worktree/command.ts` | Prune execute loop | ✓ WIRED, NOT A TRANSACTION PATH | Exists, substantive. Single-target removal then note emit; no step state, no compensation. SC1 and SC2 unmet. |
| `packages/mcp-server/src/repo-executor.ts` | Scoped git executor for phase 74 | ⚠️ ORPHANED | Exists and is correct as a gate; `scopedGit` has no production caller. |
| Transaction log / step state module | Durable per-step record (SC1, HARD-R1) | ✗ MISSING | No such file or symbol exists in the tree. |
| Compensation path | Undo of completed steps (SC2) | ✗ MISSING | No compensation code; `compensat` has no non-markdown source match. |
| Recovery/status surface for a parked operation | (SC3) | ✗ MISSING | None exists. |

### Key Link Verification

Step 5 (PLAN key_links) is not applicable: no PLAN.md. Wiring fallback applied to the cross-phase links the codebase declares.

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `packages/mcp-server/src/repo-executor.ts` (`scopedGit`) | Phase 74 cross-repository steps | Declared in `72-01-PLAN.md:50` (D72-07): "Phase 74 calls `scopedGit`" | ✗ NOT_WIRED | No production caller. `git grep scopedGit` finds only `repo-executor.ts`, `repo-scope.ts` (a comment) and its test. |
| Installer `installRepos` ↔ `SUBSTRATE_REPO_REGISTRY` | Registered repositories (SC1 wording) | `locate()` in `install-git-hook.ts` | ⚠️ PARTIAL | Now WIRED as a refusal gate (unregistered paths refused before git runs; tested). Not NOT_WIRED on the gate, but the operation does not enumerate registered repositories: `main` passes argv paths. SC1 link remains unmet. |
| `commandPrune` ↔ repository registry | Registered repositories | none | ✗ NOT_WIRED | Prune takes worktree roots; it reads no repository registry. |

### Data-Flow Trace (Level 4)

Not applicable: no rendered or user-facing dynamic data in this phase.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Install robustness and registry gate tests (separate evidence, two named files) | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/collectors/src/install-git-hook.test.ts packages/mcp-server/src/repo-executor.test.ts` | 36 pass, 0 fail, 141 expect() calls | ✓ PASS (separate evidence only) |
| A compensation or transaction-log path exists | `git grep -i compensat -- ':!*.md'` | no matches | ✗ FAIL (no behavior to exercise) |
| Prune removal and failure path | not run | prune mutates worktrees; no safe non-mutating run exists in this verification | ? SKIP |

### Probe Execution

| Probe | Command | Result | Status |
| ----- | ------- | ------ | ------ |
| `scripts/*/tests/probe-*.sh` | `find scripts -path '*/tests/probe-*.sh'` | no files; no PLAN or SUMMARY declares a probe | SKIPPED (none declared) |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R1 | none (no PLAN.md; ROADMAP "Plans: none written") | Cross-repo compensating actions with durable per-step log, idempotent retries, and compensated or needs-attention on forced failure | ✗ BLOCKED, ORPHANED | `REQUIREMENTS.md:136` maps HARD-R1 to phase 74 as "Not started". No plan claims it (Step 6c). Evidence per truths 1 to 4. |

### Anti-Patterns Found

Debt-marker gate: no `TBD`, `FIXME` or `XXX` in the covered files. The `PLACEHOLDER` matches are pre-existing hook template constants, not stubs.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/cli/src/worktree/command.ts` | 374-379 | Ledger note emitted after removal; a note that is not recorded is said on stderr only and cannot be re-emitted on re-run (spool off) | ⚠️ Warning | Premise for the owner's ledger ruling. |
| `packages/mcp-server/src/repo-executor.ts` | 86 | `scopedGit` has no production caller | ⚠️ Warning | Phase 72 reserved this for phase 74; the link is unwired. |
| `packages/collectors/src/install-git-hook.ts` | 37, 46-47, 155, 164 | `SRC_PLACEHOLDER`, `CLI_PLACEHOLDER` template constants | ℹ️ Info | Functional path substitution in the hook script; not a stub. |

## Human Verification Required

Status is gaps_found, so these are follow-ups, not the routing decision:

1. **Owner decision on HARD-R1.** Build the multi-repo transaction path, or record a waiver against the HARD-R1 text with `accepted_by` and `accepted_at`. Scheduling after v1.8 does not waive it; withdrawing D74-1 does not waive it.
2. **Corpus ingest classification.** Rule whether ingest (one remote target, with a plan that can span several registered repositories) counts as a cross-repo write path. It does not change the verdict: SC2 and SC3 fail for ingest either way.
3. **Prune ledger gap.** Rule whether a removed worktree whose ledger note was not recorded (spool off, the default) is acceptable under "a failed undo is recorded, not dropped", or must be tracked.
4. **Behavior-unverified items.** Add the two tests in `behavior_unverified_items`. They cover only the separate install fix.

## Gaps Summary

All four must-haves fail with one root cause: no multi-repository operation with persisted per-step state exists on this tree. The three candidate paths the context names (worktree prune, the git hook installer, corpus ingest) are each idempotent or single-target and keep no durable step record. Prune removes worktrees and emits ledger notes after each effect. The installer now refuses unregistered targets against the registry, which is a gate, but it still writes hooks from argv paths and keeps no step state. Ingest keeps results in memory apart from the server's own row skip. Phase 72's `scopedGit` for phase 74 has no caller. Nothing compensates and nothing persists a needs-attention record. The install-git-hook fix (d65d74fb) and the phase 72 registry gate are correct for what they do and are reported as separate evidence only. They do not close any gap.

Stale record for the orchestrator (not edited here): `ROADMAP.md` phase 74 status line (line 1286) and the progress row (line 1422) read `gaps_found`, which matches this record.

_Verified: 2026-11-05T08:00:19Z_
_Verifier: Claude (gsd-verifier)_
