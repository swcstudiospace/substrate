---
phase: 74-cross-repo-compensating-actions
verified: 2026-11-02T16:26:19Z
status: gaps_found
score: 0/4 must-haves verified
covered_files: [".planning/phases/74-cross-repo-compensating-actions/74-SUMMARY.md", "packages/cli/src/corpus/ingest.ts", "packages/cli/src/worktree/command.ts", "packages/collectors/src/install-git-hook.test.ts", "packages/collectors/src/install-git-hook.ts", "packages/mcp-server/src/repo-executor.ts"]
covered_digest: "v3:sha256:0e2842836ce8b48a636079dcae8d2d01afb1846c3b6b9c947e5973e9ff2d8df2"
behavior_unverified: 2
overrides_applied: 0
behavior_unverified_items:
  - truth: "Separate evidence (d65d74fb): install failure is named with a redacted one-line reason; secret-bearing error text and URL credentials are redacted before printing"
    test: "Make a hook-path read throw with an error whose message contains a token-shaped string and a URL with credentials, then call installRepos and read outcome.errors[0].reason and the printed line"
    expected: "The token and the URL credentials do not appear; the reason is one line and at most 200 characters"
    why_human: "The tests use an EISDIR message with no secret and no URL (install-git-hook.test.ts, 'the failing repository is named...'), so oneLineReason's redact() call and URL replacement are present and wired but not exercised"
  - truth: "Separate evidence (d65d74fb): a repository is counted once in failures when its corpus step throws after a foreign-hook problem"
    test: "Create a repository with a foreign post-commit hook, then make a later corpus hook step throw (a directory where post-merge belongs), then call installRepos with corpus: true"
    expected: "outcome.failures is 1 for that repository, errors holds one entry for it, and each problem line is printed once"
    why_human: "The finally block (install-git-hook.ts installRepos) is a cleanup invariant. The once-count test covers foreign hooks only; no test combines a foreign hook with a throw. 74-SUMMARY.md section 4 records the same gap"
coincidental_reliance_items: []
gaps:
  - truth: "SC1 and HARD-R1: a real operation across at least two registered repositories persists operation and per-step state before effects, with stable dedupe keys and idempotent per-step retry"
    status: failed
    reason: "No multi-repo operation persists step state. Prune removes worktrees then emits the ledger note; the installer writes hooks from argv paths, not the registry; ingest keeps results in memory. scopedGit, reserved for phase 74, has no production caller."
    artifacts:
      - path: "packages/cli/src/worktree/command.ts"
        issue: "Prune removes each worktree and emits its ledger note after the effect; no pre-effect step record and no operation id"
      - path: "packages/collectors/src/install-git-hook.ts"
        issue: "installRepos takes raw argv paths (main, line 292), not SUBSTRATE_REPO_REGISTRY; no step state"
      - path: "packages/cli/src/corpus/ingest.ts"
        issue: "executeIngest keeps per-document results in memory; no durable state"
      - path: "packages/mcp-server/src/repo-executor.ts"
        issue: "scopedGit has no production caller; phase 74 is not wired to it"
    missing:
      - "A multi-repo operation over registered repositories, run through scopedGit or an equivalent gated path"
      - "A durable operation and step record written before each effect, with stable dedupe keys"
      - "Idempotent per-step retry that consults the step record"
  - truth: "SC2: a forced failure at step N leaves compensated pre-operation state or a durable needs-attention result naming unfinished or failed compensation steps"
    status: failed
    reason: "On failure prune stops and returns 1 with earlier removals kept; the installer's named failure is stdout only; ingest's failed items are in memory. Nothing compensates and nothing is durable."
    artifacts:
      - path: "packages/cli/src/worktree/command.ts"
        issue: "Failure branch stops with earlier removals kept; message goes to stderr only"
      - path: "packages/collectors/src/install-git-hook.ts"
        issue: "Named failure is stdout only; no durable record and no compensation"
    missing:
      - "Compensation for each completed step of a failed operation"
      - "A durable needs-attention record naming unfinished or failed compensation steps"
  - truth: "SC3: failure and compensation failure are exercised against temporary real repositories; recovery or status exposes the parked result and never overwrites an outside ref change or silently repeats a completed effect"
    status: failed
    reason: "No recovery or status surface for a parked operation; no test exercises compensation or compensation failure; temporary-repository tests cover only hook installation."
    artifacts:
      - path: "packages/collectors/src/install-git-hook.test.ts"
        issue: "Temporary-repository tests exercise installation only"
    missing:
      - "Recovery or status command for a parked operation"
      - "Temporary-repository tests for forced failure and compensation failure"
  - truth: "HARD-R1: absence of an existing transaction path is not delivery; the owner-approved requirement stands"
    status: failed
    reason: "Same root cause as the three truths above. REQUIREMENTS.md:136 records Not started. D74-1 is withdrawn in the working-copy 74-CONTEXT.md, and no recorded owner waiver of HARD-R1 exists."
    artifacts:
      - path: ".planning/REQUIREMENTS.md"
        issue: "HARD-R1 is unchecked and not delivered; the table records Not started"
    missing:
      - "Delivery of the multi-repo transaction path, or an owner waiver recorded against the HARD-R1 text"

---

# Phase 74: Cross-repo compensating actions Verification Report

**Phase Goal:** A real operation spanning at least two registered repositories records durable per-repository step state. Partial failure leaves compensated state or explicit needs-attention, never silent partial success; each retry is idempotent. (ROADMAP.md, phase 74 section, build wording; status "Plans: none written".)
**Requirement:** HARD-R1 (`.planning/REQUIREMENTS.md:118`, owner-approved text, commit 23bd0733): "Execute a real operation across at least two registered repositories with a durable per-step transaction log and idempotent retries. Forced failure leaves compensated state or explicit needs-attention state; no silent partial success. Absence of an existing transaction path is not delivery."
**Verified:** 2026-11-02T16:26:19Z
**Status:** gaps_found
**Re-verification:** No. The prior 74-VERIFICATION.md had no `gaps:` section, so this is an initial verification that supersedes it. The prior report (human_needed, 1/2) treated criterion 1 as an owner human item. It predates the uncommitted 74-CONTEXT.md withdrawal of D74-1 and does not close HARD-R1.

## Decision basis

- D74-1 is not closure. The committed 74-CONTEXT.md (HEAD, d65d74fb) still records D74-1 as decided. The working-tree copy (uncommitted, `M` in git status) withdraws it: "Decision for the owner (not made here)". Neither version waives HARD-R1, and "absence of an existing transaction path is not delivery" stands.
- Separate evidence: commit d65d74fb (install-git-hook robustness, D74-2). It is evaluated below as its own item and does not count toward the four must-haves.
- Plans: none exist in the phase directory, so PLAN `must_haves` are absent. The roadmap success criteria (SC1 to SC3) and HARD-R1 are the must-haves, per Step 2a.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | SC1: an actual operation across at least two registered repositories persists operation and step state before effects, with stable dedupe keys and idempotent per-step retry | ✗ FAILED | No multi-repo operation persists state. Prune (`packages/cli/src/worktree/command.ts`, `commandPrune`, about lines 321-395) runs `git worktree remove` and then `deps.emit` for the ledger note; nothing is recorded before the effect and no operation id or dedupe key exists. The installer (`packages/collectors/src/install-git-hook.ts`, `installRepos` lines 241-290; `main` at line 292 takes `args.filter` raw paths) writes hooks directly from argv paths. It reads no registry: `REPO_REGISTRY_ENV` / `repoScopeFromEnv` are referenced in neither `packages/collectors` nor `packages/cli/src/corpus`. Ingest (`packages/cli/src/corpus/ingest.ts`, `executeIngest` from line 98) keeps counts and a `Map` in memory only. The repo-executor that phase 72 reserved for phase 74 has no production caller (`git grep 'scopedGit('` outside tests matches only its definition, `packages/mcp-server/src/repo-executor.ts:86`). |
| 2   | SC2: a forced failure at step N yields compensated pre-operation state or a durable needs-attention result naming unfinished or failed compensation steps; never success for a partial operation | ✗ FAILED | Prune stops at the failing worktree, keeps every earlier removal, returns 1 and prints "stopped; nothing further was removed and nothing was retried" to stderr only (`command.ts`, the `failure !== null` branch). No compensation runs. The installer's named failure (`✗ <repo> — install failed: <reason>`) is stdout only, and the exit code is 1 with no compensation, which the roadmap's origin text calls "not a compensation case". Ingest's failed items are in-memory counts. None of these is a durable needs-attention record. |
| 3   | SC3: failure and compensation failure exercised against temporary real repositories; recovery/status exposes the parked result; never overwrites an outside ref change or silently repeats a completed effect | ✗ FAILED | No recovery or status surface for a parked operation exists. `git grep -i compensat` over non-markdown source has no matches. The only temporary-repository tests are install tests (`install-git-hook.test.ts`, lines about 226-292), which cover hook installation, not compensation or compensation failure. |
| 4   | HARD-R1: durable per-step transaction log and idempotent retries; forced failure leaves compensated or needs-attention state; "absence of an existing transaction path is not delivery" | ✗ FAILED | Same evidence as truths 1 to 3. `REQUIREMENTS.md:136` records "Not started; earlier no-op was not delivery". No plan claims HARD-R1 (no PLAN.md; ROADMAP "Plans: none written"). |

**Score:** 0/4 must-haves verified (0 present-behavior-unverified, 4 failed).

### Separate evidence: install-git-hook fix (d65d74fb, D74-2), not a roadmap truth, excluded from score

| Behavior | Status | Evidence |
| -------- | ------ | -------- |
| One failing repository does not stop the others; each still gets its hook | ✓ VERIFIED | `install-git-hook.test.ts` "one failing repository does not stop the others...". Targeted run: 20 pass, 0 fail, 93 expect() calls. |
| Failing repository named in the result with a one-line reason; CLI exits 1 | ✓ VERIFIED (non-secret error) | Tests "the failing repository is named in the result..." and "the CLI exits 1 for a failing repository...". Both use an EISDIR error with no secret. |
| No-failure output unchanged | ✓ VERIFIED | Test "with no failure the result is unchanged...". |
| Repository counted once in failures for several foreign-hook problems | ✓ VERIFIED (foreign only) | Test "a repository with several problems is counted once...". |
| Counted once when a throw follows a foreign-hook problem | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `finally` at `installRepos` applies the once-count; no test combines a foreign hook with a throw. See behavior_unverified_items[1]. |
| Reason is redacted before printing (`redact` from `packages/mcp-server/src/redact.ts`) and URLs become `<url>` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `oneLineReason` calls `redact`; no fixture yields a secret or URL in the error text. The `not.toMatch(/:\/\//)` assertion runs on an EISDIR message with no URL, so it does not exercise URL replacement. See behavior_unverified_items[0]. |

This fix does not satisfy SC1 to SC3 or HARD-R1. It has no operation, no step state, no compensation, and no durable record. Its named failure is stdout text. It is correct as a robustness fix for one loop, and the owner may keep it as such.

### Deferred Items

None. Step 9b: the goals of phases 75 (DragonflyDB degradation), 76 (telemetry buffer and dead-letter), 77 (steering idempotency and ordering) and 78 (cross-layer reconciliation) do not name cross-repo compensation or a multi-repo transaction path. No gap is deferred.

### Required Artifacts

No PLAN.md exists, so `verify.artifacts` returns NO_INPUT and Step 4 is not applicable. The artifacts below are the phase's claimed code, checked by reading.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/collectors/src/install-git-hook.ts` | Robust per-repository install (separate evidence) | ✓ VERIFIED (separate) | Exists, substantive, wired to CLI `main`. Not a phase-74 transaction path. |
| `packages/collectors/src/install-git-hook.test.ts` | Tests for the robustness fix | ✓ VERIFIED (separate) | 20 pass, 0 fail in the targeted run. |
| Transaction log / step state module | Durable per-step record for a multi-repo operation (SC1, HARD-R1) | ✗ MISSING | No such file or symbol exists in the tree. |
| Compensation path | Undo of completed steps (SC2) | ✗ MISSING | No compensation code; `compensat` has no source match. |
| Recovery/status surface for a parked operation | (SC3) | ✗ MISSING | None exists. |

### Key Link Verification

Step 5 (PLAN key_links) is not applicable: no PLAN.md. Wiring fallback applied to the one cross-phase link the codebase declares.

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `packages/mcp-server/src/repo-executor.ts` (`scopedGit`) | Phase 74 cross-repository steps | Declared in `72-01-PLAN.md:50` (D72-07): "Phase 74 calls `scopedGit`" | ✗ NOT_WIRED | No production caller. `repo-executor.ts:13` says phase 74 calls it; no code does. |
| Installer `installRepos` | `SUBSTRATE_REPO_REGISTRY` (registered repositories) | Success criterion 1 wording, "registered repositories" | ✗ NOT_WIRED | Raw argv paths; no registry read in collectors or corpus CLI. |

### Data-Flow Trace (Level 4)

Not applicable: no rendered or user-facing dynamic data in this phase.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Install robustness tests run (separate evidence, one named file) | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test packages/collectors/src/install-git-hook.test.ts` | 20 pass, 0 fail, 93 expect() calls | ✓ PASS (separate evidence only) |
| A compensation or transaction-log test exists | `git grep -i -E 'compensat\|transaction log\|step_state'` over non-markdown source | no matches | ✗ FAIL (no behavior to exercise) |

### Probe Execution

| Probe | Command | Result | Status |
| ----- | ------- | ------ | ------ |
| `scripts/*/tests/probe-*.sh` | `find scripts -path '*/tests/probe-*.sh'` | no files; no PLAN or SUMMARY declares a probe | SKIPPED (none declared) |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R1 | none (no PLAN.md; ROADMAP "Plans: none written") | Cross-repo compensating actions with durable per-step log, idempotent retries, and compensated or needs-attention on forced failure | ✗ BLOCKED, ORPHANED | `REQUIREMENTS.md:136` maps HARD-R1 to phase 74 as "Not started". No plan claims it (Step 6c). Evidence per truths 1 to 4. |

### Anti-Patterns Found

Debt-marker gate: no `TBD`, `FIXME` or `XXX` in the touched files. The `PLACEHOLDER` matches are the pre-existing hook template constants, not stubs.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/cli/src/worktree/command.ts` | prune execute loop | Ledger note emitted after removal; a failed emit is said on stderr only and cannot be re-emitted on re-run (spool off) | ⚠️ Warning | Premise evidence for the owner's human item; the "recorded, not dropped" wording is at stake. |
| `packages/mcp-server/src/repo-executor.ts` | 86 | `scopedGit` has no production caller | ⚠️ Warning | Phase 72 reserved this for phase 74; the link is unwired. |
| `packages/collectors/src/install-git-hook.ts` | 32, 41-42, 71, 80 | `SRC_PLACEHOLDER`, `CLI_PLACEHOLDER` template constants | ℹ️ Info | Functional path substitution in the hook script; not a stub. |

## Human Verification Required

Status is gaps_found, so these are follow-ups, not the routing decision:

1. **Owner re-decision on the requirement.** HARD-R1 is owner-approved text. An owner waiver has to be recorded against HARD-R1 itself, with accepted_by and accepted_at. Withdrawing D74-1 (uncommitted in 74-CONTEXT.md) does not waive it. Either build the path, or record a waiver.
2. **Corpus ingest classification.** Ingest writes to one remote target. Rule whether a multi-request write to one server counts as a cross-repo write path. It does not change the verdict: HARD-R1 needs a registered-repository operation, and none exists.
3. **Prune ledger gap.** Rule whether a removed worktree whose ledger note was dropped (spool off, the default) is acceptable under "a failed undo is recorded, not dropped", or should be tracked.
4. **Behavior-unverified items.** Add the two tests in `behavior_unverified_items`. They cover only the separate install fix.

## Gaps Summary

All four must-haves fail with one root cause: no multi-repository operation with persisted per-step state exists on this tree. The three candidate paths the context names (worktree prune, the git hook installer, corpus ingest) are each idempotent or single-target and keep no durable step record. Prune removes worktrees and emits ledger notes after each effect. The installer writes hooks from argv paths. Ingest keeps results in memory. Phase 72's `scopedGit` for phase 74 has no caller. Nothing compensates and nothing persists a needs-attention record. The install-git-hook fix (d65d74fb) is correct for what it does and is reported as separate evidence only. It does not close any gap.

Stale record for the orchestrator (not edited here): `ROADMAP.md` phase 74 status line (around line 1283) and the progress row (line 1422) still read `human_needed`, and the working-tree `74-CONTEXT.md` is uncommitted.

_Verified: 2026-11-02T16:26:19Z_
_Verifier: Claude (gsd-verifier)_
