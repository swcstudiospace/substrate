---
phase: 74-cross-repo-compensating-actions
verified: 2026-11-02T10:14:40Z
status: human_needed
score: 1/2 must-haves verified
covered_files: [".planning/phases/74-cross-repo-compensating-actions/74-SUMMARY.md", "packages/cli/src/corpus/ingest.ts", "packages/cli/src/worktree/command.ts", "packages/collectors/src/install-git-hook.test.ts", "packages/collectors/src/install-git-hook.ts"]
covered_digest: "v3:sha256:a42531db742276d74b9e1d4a35e54614098c51ef3f531baee1ce288254b74bd7"
behavior_unverified: 2
overrides_applied: 0
behavior_unverified_items:
  - truth: "Install failure is named with a redacted one-line reason: secret-bearing error text is redacted before it is printed (D74-2)"
    test: "Make a hook-path read throw with an error whose message contains a token-shaped string and a URL with credentials, then call installRepos and read outcome.errors[0].reason and the printed line"
    expected: "The token and the URL credentials do not appear; the reason is one line and at most 200 characters"
    why_human: "Tests cover only the one-line and no-URL parts (install-git-hook.test.ts:247-258). No fixture produces a secret, so redact() (install-git-hook.ts:235) is present and wired but not exercised"
  - truth: "A repository is counted once in failures when its corpus step throws after a foreign-hook problem (D74-2)"
    test: "Create a repository with a foreign post-commit hook, then make a later corpus hook step throw (for example a directory where post-merge belongs), and call installRepos with corpus: true"
    expected: "outcome.failures is 1 for that repository, errors holds one entry for it, and each problem line is printed once"
    why_human: "The finally block (install-git-hook.ts:281-283) and the catch (276-280) both apply, but no test combines a foreign hook with a throw. install-git-hook.test.ts:282-292 covers foreign hooks only. 74-SUMMARY.md section 4 records the same gap"
coincidental_reliance_items: []
deferred: []
human_verification:
  - test: "Owner re-decides D74-1 (74-CONTEXT.md) on the corrected premise, and records who accepted it and when"
    expected: "Either D74-1 is reversed and a new phase is opened for a multi-repo write path, or D74-1 is kept and the premise is corrected in the ROADMAP status text and 74-CONTEXT.md to name worktree prune and the git hook installer as multi-repo, multi-step writes. An accepted_by and accepted_at are recorded"
    why_human: "Criterion 1 is an owner decision. The verifier cannot accept it, and the repository holds no delegation record beyond the words owner-delegated, 2026-11-02"
  - test: "Owner rules on corpus ingest (cli/src/corpus/ingest.ts executeIngest)"
    expected: "A ruling whether a multi-request, multi-step write to one remote corpus server, from input spanning many repositories, counts as a cross-repo write path"
    why_human: "The definition of cross-repo write path is a judgement. Ingest writes to one remote target, not to several repositories"
  - test: "Owner accepts or rejects the prune ledger gap found in the premise check"
    expected: "A ruling whether a worktree removed by prune with its ledger note dropped (SUBSTRATE_EVENT_SPOOL off, the default) and not repaired by re-running is acceptable under this phase's goal, or should be tracked"
    why_human: "The goal sentence says a failed undo is recorded, not dropped. Whether this applies to a removal that cannot be undone is a judgement"
  - test: "Add the two behavioral tests listed in behavior_unverified_items"
    expected: "Both pass against install-git-hook.ts"
    why_human: "Owner decides whether they block closing this phase or follow it"
---

# Phase 74: Cross-repo compensating actions Verification Report

**Phase Goal:** A multi-repo operation that fails partway undoes its completed steps, and a failed undo is recorded, not dropped.
**Verified:** 2026-11-02T10:14:40Z
**Status:** human_needed
**Re-verification:** No — initial verification against the origin/main criteria

**Criteria source.** The success criteria are the Phase 74 entry in `.planning/ROADMAP.md` at `origin/main` (current tip b1b42f92; the entry's status text cites 9b482207, which is an ancestor of it). Section taken: `### Phase 74` to the next `### Phase`. Criterion 1 and criterion 2 match `74-CONTEXT.md` word for word. Step 0 found a prior 74-VERIFICATION.md with a `gaps:` section. Its gaps came from the branch ROADMAP's SC1 to SC3 and HARD-R1, not from these criteria, so they are not carried forward. This report is an initial verification, as the brief directed. The prior file is overwritten.

**Scope of the code under review.** Phase commits d65d74fb and 3d94dcf9 touch only `install-git-hook.ts`, `install-git-hook.test.ts`, `74-CONTEXT.md` and `74-SUMMARY.md`. Prune (`cli/src/worktree/command.ts:321-395`) and ingest (`cli/src/corpus/ingest.ts:98-204`) are unchanged on the branch relative to origin/main. Both are read as they are on origin/main.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: the owner decides whether a cross-repo write path is built first, and no compensation is built against a path that does not exist | ? UNCERTAIN (WARNING, human decision requested) | Half holds: no compensation, rollback or undo code in the phase diff (`git grep` over installer and test is empty; phase commits touch no other code). The other half cannot be verified by code: D74-1 records the decision as owner-delegated on 2026-11-02, with no accepted_by or accepted_at in the repository. Its stated premise is contradicted by the code, see the premise check below. The verifier does not accept the decision. |
| 2 | SC2: the install-git-hook robustness gap is fixed or tracked separately, and is not a compensation case | ✓ VERIFIED | `installRepos` (install-git-hook.ts:241-286) wraps each repository in `try`/`catch` (249, 276-280); the loop continues. Test at install-git-hook.test.ts:228-245 proves it: a failing repository does not stop the other two, which are installed. `bun test packages/collectors/src/install-git-hook.test.ts` run once in this worktree: 20 pass, 0 fail. No compensation code is present (see truth 1). Scope: the fix is on branch commit d65d74fb, which is not an ancestor of origin/main, so origin/main still has the unguarded loop. |
| 3 | SC2 sub-truth: the failing repository is named with a redacted one-line reason (D74-2) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `oneLineReason` (install-git-hook.ts:233-238) applies `redact`, keeps the first line, replaces URLs with `<url>`, caps at 200. Test 247-258 checks one line and no `://`. No test exercises secret redaction (behavior_unverified_items[0]). |
| 4 | SC2 sub-truth: a repository is counted once in failures (D74-2) | ✓ VERIFIED (covered path) | `finally` at install-git-hook.ts:281-283 increments once per repository. Test 282-292 (one repository, two foreign corpus hooks) gives `failures: 1`. The throw-plus-foreign combination is not covered (behavior_unverified_items[1]). |
| 5 | SC2 sub-truth: with no failure, output and exit code are unchanged | ✓ VERIFIED | Lines match the pre-phase strings (`✓ … installed/refreshed/present`, `○ … not installed`). Test 260-270 asserts `{failures:0, errors:[]}` and the exact lines. Exit is `outcome.failures > 0 ? 1 : 0` (install-git-hook.ts:300); pre-phase `main()` exited 0 on success. |

**Score:** 1/2 must-haves verified (SC2). SC1 is UNCERTAIN, awaiting the owner. 2 sub-truths are present but behavior-unverified.

### Criterion 1 premise check (D74-1), file by file

Test applied: does the path write to more than one repository in one operation, with more than one step? The ROADMAP status text and 74-CONTEXT.md both say no such path exists on main, and both list these paths as checked and rejected. Each row was checked against the code.

| Path | Location (origin/main = branch, unchanged) | Multi-repo write? | Multi-step? | Durable per-repo step state? | Partial failure | Repaired by re-running? |
| --- | --- | --- | --- | --- | --- | --- |
| Worktree prune | cli/src/worktree/command.ts:321-395 | **Yes.** `gather` covers all discovered repositories (326); each safe worktree is removed in its own repository via `deps.git(["worktree","remove",path], info.repo_dir)` (374) | **Yes.** Remove (374), then ledger note via `deps.emit` (379), per worktree | No. In-memory `removed`/`failure` arrays. The ledger note is the only trace, and only if stored or spooled | Loop breaks at the first removal failure (376-377); stderr says nothing further was removed and nothing was retried (391); returns 1 | **Removal part: yes** (by code reading: a re-run re-inventories from git at 326 and reloads each worktree at 360; removed worktrees are gone, and the failed one is retried if still safe). **Ledger part: no.** A failed emit (not stored, not spooled) is dropped and counted (emit.ts:15-16 with SUBSTRATE_EVENT_SPOOL off, the default). A removed worktree is no longer listed, so a re-run cannot re-emit its note. Only the stderr line records it. Not tested by experiment, since that would remove real worktrees |
| Git hook installer | collectors/src/install-git-hook.ts:241-286 (writeHook 40-45; installCorpusHooks 170-191) | **Yes.** One loop over argv repositories (247) | **Yes.** post-commit write (267), then up to three corpus hook writes per repository (271) | No. In-memory `{failures, errors}` and stdout lines | Before the phase: an exception aborted the loop (no try/catch on origin/main). Now: caught per repository (276-280) | **Yes, for thrown errors.** Scratch experiment in /tmp (repository code not edited): a directory where post-commit belongs fails run 1, and after removal run 2 installs it. A directory where post-merge belongs fails run 1, and after removal run 2 installs post-merge and refreshes the others. **No, for foreign hooks by design:** a foreign post-commit is left alone (case C: still foreign after re-run) and needs the owner |
| Corpus ingest | cli/src/corpus/ingest.ts:98-204 (called from corpus/index.ts:706, corpus/sync.ts:396) | **Borderline.** Input spans many repositories (entries, 124). Every write goes to **one** remote corpus server (`input.client.ingest`, 156 and 169). No repository is written | **Yes.** Tombstone requests (153-159), then document batches (164-201). A rename removes the old row before the new insert (185-189) | No (the server holds state; the client keeps counts) | A failed request sets `state.fatal` (119-122) and stops later requests (154, 176, 197, 201). Completed tombstones and batches stand, and nothing is undone | Probably, by inference: each run sends the current inventory to the server for a fresh plan (planRequest, index.ts:613, used at ~690) and runs that plan. Not tested. Server-side planning is outside this checkout |
| Worktree provision | command.ts:487-512 | No (one `git worktree add`) | No | No | n/a | n/a |
| Snapshot restore, session rollback | worktree-snapshot/src/restore.ts, cli/src/session/rollback.ts | No (one worktree) | Yes | Yes (journal) | Journal | Single repository; not a cross-repo path |
| Skills propose, host commit and push | mcp-server/src/skills/propose.ts, host/src/hostfns.ts | No (one repository each) | Yes | Ledger or task record | n/a | Single repository; not a cross-repo path |
| Corpus mirror fetch, steer | corpus/src/mirror.ts, cli/src/steer/repo.ts | No (each repository independent, or no git write) | n/a | n/a | n/a | Not a cross-repo write |

**Result of the premise check.** The premise "no multi-repo, multi-step write path exists on main" is **false** for worktree prune and the git hook installer, both of which exist on origin/main as shown above. Under the plain reading of the test, both are cross-repo multi-step writes. Neither has durable step state. Ingest is multi-step and multi-input, but writes to one remote target; it is the owner's call. The definition of cross-repo write path is a judgement, so the verifier does not rule on that. The factual error, however, is not a judgement, and D74-1 and the ROADMAP status text rest on it.

**Why criterion 1 is UNCERTAIN and not VERIFIED or FAILED.** The criterion asks for an owner decision. The verifier cannot verify that one exists beyond the record, and cannot accept a record whose stated premise the code contradicts. The owner must re-decide on the corrected premise (human item 1). This is a WARNING with a human decision requested, not a BLOCKER on code.

### Deferred Items

Step 9b checked the Phase 75 to 78 entries of origin/main ROADMAP.md (DragonflyDB degradation, Telemetry buffer and dead-letter, Steering idempotency and ordering, Cross-layer reconciliation). None addresses cross-repo compensation. The only other match is the progress table row for Phase 74 itself. Deferred: none.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/collectors/src/install-git-hook.ts` | installRepos with per-repository isolation, once-counted failures, redacted one-line reason, unchanged no-failure output | ✓ VERIFIED | Exists; substantive (installRepos 241-286, oneLineReason 233-238, MAX_REASON_CHARS 38); wired (main calls installRepos at 299). No compensation code. |
| `packages/collectors/src/install-git-hook.test.ts` | Five installRepos tests for criterion 2 | ✓ VERIFIED | Lines 227-293. The file passes 20/20 (one run). Two sub-truths are not exercised (see behavior_unverified_items). |
| `packages/cli/src/worktree/command.ts` | Prune path, premise evidence | ✓ VERIFIED (read only) | Prune at 321-395 is unchanged on the branch versus origin/main. Read as premise evidence; not part of this phase's diff. |
| `packages/cli/src/corpus/ingest.ts` | Ingest path, premise evidence | ✓ VERIFIED (read only) | executeIngest at 98-204 is unchanged on the branch versus origin/main. Read as premise evidence. |
| `.planning/phases/74-…/74-CONTEXT.md` | Decisions D74-1, D74-2; criteria quoted | ✓ present, premise contradicted | Criteria match origin/main verbatim. D74-1's premise is false (premise check above). |
| `.planning/phases/74-…/74-SUMMARY.md` | Summary | ✓ present | Its test and tsc/lint/phase-close figures were reported by Main, not observed here. Section 4 records the two untested paths, which this report confirms. |

### Key Link Verification

Step 5 is not applicable: no PLAN.md exists for this phase, so there are no `must_haves.key_links`.

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `main()` | `installRepos` | direct call (install-git-hook.ts:299) | ✓ WIRED | The CLI exit code follows `outcome.failures` |
| `installRepos` | `writeHook` / `installCorpusHooks` | direct calls (261, 267, 271) | ✓ WIRED | Inside the per-repository `try` |

### Data-Flow Trace (Level 4)

Not applicable. The installer writes hook files and prints lines; it renders no dynamic data.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Installer test file, criterion 2 | `bun test packages/collectors/src/install-git-hook.test.ts` | 20 pass, 0 fail, 93 expect() calls | ✓ PASS |
| A repository that fails does not stop the loop; re-run repairs it | Scratch script in /tmp that imports `installRepos` (no repo edits); run 1 with an obstacle, remove it, run 2 | Failing repo reports `EISDIR` (failures 1); run 2 installs it (failures 0); case B repaired; case C (foreign) not repaired | ✓ PASS |
| Full suite, typecheck, lint, formatters | not run | not run | ? SKIP (per brief) |

### Probe Execution

No probes declared or implied by this phase. Skipped.

### Requirements Coverage

Step 6 is not applicable: no PLAN.md `requirements:` field. REQUIREMENTS.md HARD-R1 is mentioned only in the branch ROADMAP, which is not the criteria source. It is not evaluated here.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `install-git-hook.ts` | 235 | `redact()` is called but no test exercises it | ⚠️ Warning | Redaction is unproven (behavior_unverified_items[0]) |
| `install-git-hook.ts` | 281-283 | `finally` once-count combined with a throw is untested | ℹ️ Info | behavior_unverified_items[1] |
| `command.ts` | 379-385 | Ledger note dropped on failed emit with the spool off; re-run cannot re-emit it | ⚠️ Warning | Premise evidence; the goal's "recorded, not dropped" clause is at stake here (human item 3) |

No TODO, FIXME, placeholder or stub markers in the reviewed files. No `TBD`/`FIXME`/`XXX` debt markers, so the debt-marker gate does not fire.

### Human Verification Required

#### 1. Owner re-decision on D74-1

**Test:** Read the premise check above. Decide whether to reverse D74-1 (open a new phase for a multi-repo write path) or keep it.
**Expected:** If kept, the ROADMAP status text and 74-CONTEXT.md name worktree prune and the git hook installer as multi-repo, multi-step writes, and the decision records accepted_by and accepted_at.
**Why human:** Criterion 1 is an owner decision. The repository holds no delegation record beyond the words "owner-delegated, 2026-11-02".

#### 2. Corpus ingest classification

**Test:** Rule on whether a multi-request, multi-step write to one remote corpus server, from input spanning many repositories, is a cross-repo write path.
**Expected:** A ruling, recorded with the decision in item 1.
**Why human:** The definition is a judgement. Ingest writes to one target.

#### 3. Prune ledger gap

**Test:** Rule on whether a removed worktree whose ledger note was dropped (spool off, the default) is acceptable under "a failed undo is recorded, not dropped", or should be tracked.
**Expected:** A ruling. If it is tracked, the item goes to a named follow-up.
**Why human:** A removal cannot be undone, so the goal sentence does not settle this without a judgement.

#### 4. Behavioral tests

**Test:** Add the two tests in behavior_unverified_items.
**Expected:** Both pass against install-git-hook.ts.
**Why human:** The owner decides whether they block closing this phase or follow it.

### Gaps Summary

Criterion 2 is met. The installer gap is fixed on the phase branch, its per-repository isolation is proven by a test that passes, and no compensation was built. Redaction and the throw-plus-foreign count are implemented but not proven by any test.

Criterion 1 is not verifiable as the record stands. Its stated premise, that no multi-repo, multi-step write exists on main, is false: worktree prune and the git hook installer both are. A partial failure in the installer is repaired by re-running. In prune, the removal is repaired by re-running, but a dropped ledger note is not. Ingest is multi-step, but writes to one remote target. The owner must re-decide D74-1 on the corrected premise before this phase can close.

**Notes on method.**
- One `bun test` run of `install-git-hook.test.ts` (20/20). One scratch script in /tmp for the re-run experiment, with no repository edits. No full suite, typecheck, lint, formatter, or commit.
- The Step 1 call `gsd_run query roadmap.get-phase` was not used for criteria, because it reads the worktree's branch ROADMAP. Criteria come from `origin/main` as directed.
- Prune and ingest re-run behavior is by code reading, not by experiment (a prune experiment would remove real worktrees; server-side ingest planning is outside this checkout).

---

_Verified: 2026-11-02T10:14:40Z_
_Verifier: Claude (gsd-verifier)_
