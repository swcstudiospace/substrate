---
phase: 04-skills
plan: 12
subsystem: infra
tags: [skills, omp, proof, provenance, session_id, sync-timer, projection, d-16, d-21, d-22, sc-3, sc-4, sc-5]

requires:
  - phase: 04-skills
    provides: 04-03 POST /skills/propose (session_id in prBody); 04-04 substrate-skills-sync timer + projector; 04-05 agents/muse fan-out; 04-07 substrate-skills-bridge Omp queue drain; 04-08 Omp tool_call extension (symlinked); 04-12 Setup section (commit 8113f8c)
provides:
  - packages/projector/omp/substrate-skills.ts — OmpContext, sessionIdOf (method call, trimmed, 200-char cap, never throws), ProposeBody.session_id; handler signature (event, ctx?)
  - packages/projector/omp/substrate-skills.test.ts — 4 new tests (18 total), incl. a class with a #private getter
  - 04-PROOF.md — Omp route: Baseline, Omp session, Arrival; proof_result=pass
  - host — RESTORE.d/04-12.md routes 2 (repo revert 741249b) and 3 (key lists), route 1 applied; RESTORE.md 04-12 row; /var/lib/substrate/phase4-baseline/04-12/omp-route/ (key names only)
  - GitHub — agent-skills#7 substrate-skills-sync-audit, MERGED 2026-09-27T03:26:59Z (df0db4e)
affects: [phase-4-verification]

actuals:
  tasks: 5
  commits: 5         # 9a88aa7 741249b 6e803b6 b39c444 46dff86 (before this SUMMARY commit)
  files: 3

tech-stack:
  added: []
  patterns:
    - "Provenance read from the host runtime's ctx inside the hook (never model input) and omitted, not blanked, when unknown"
    - "A shared-checkout test gate is measured against its own pre-measure, with a two-worktree fallback when a foreign change lands"

key-files:
  created:
    - .planning/phases/04-skills/04-12-SUMMARY.md
    - /var/lib/substrate/phase4-baseline/04-12/omp-route/{claude-settings,grok-config}.keys (host, not in git)
  modified:
    - packages/projector/omp/substrate-skills.ts
    - packages/projector/omp/substrate-skills.test.ts
    - .planning/phases/04-skills/04-PROOF.md
    - /var/lib/substrate/phase4-baseline/RESTORE.d/04-12.md, RESTORE.md (host, not in git)

key-decisions:
  - "session_id is read by calling ctx.sessionManager.getSessionId() as a method: Omp's getter reads a #private field, so a detached reference would throw and silently drop provenance."
  - "Queued-path `existing` accepted (plan W3): the propose outran the 25 s client timeout, the server opened PR #7, and the bridge re-post was answered existing; createdAt after t_omp_start and the body's session_id tie it to the session."
  - "Merge delegated by the owner (one-time D-16 exception), recorded as owner_merge=delegated with the answer verbatim and under ## Gaps."

requirements-completed: []

coverage:
  - id: T1
    description: "Omp extension forwards the calling session id as session_id, direct and queued; absent on no ctx, blank or throwing getter; #private getter survives"
    verification:
      - kind: unit
        ref: "substrate-skills.test.ts 18 pass 0 fail (RED 9a88aa7: 15 pass / 3 fail); Task 1 <automated> exit 0 — pre 530 pass/0 fail/tsc-exit=0, post 534 pass/0 fail/tsc-exit=0, fail and tsc sets equal"
        status: pass
  - id: T2
    description: "Omp-route baseline: services, extension live with getSessionId, Omp config read-backs, empty queue, clean library, key lists 0700/0600, marker removed via route 1, SC-5 binding re-read"
    verification:
      - kind: integration
        ref: "Task 2 <automated> exit 0 (verbatim)"
        status: pass
  - id: T3
    description: "Real Omp session (fixed prompt, timeout 900) made 14 task tool calls and one blocked manage_skill create; PR #7 names session 01a0dfe8-61c8-7625-abd2-071abece07e1"
    verification:
      - kind: integration
        ref: "Task 3 <automated> exit 0 (verbatim)"
        status: pass
  - id: T5
    description: "Merged skill arrived in Claude Code (init slash_commands) and Grok Build (grok inspect 0→1) via the timer alone, 126 s after mergedAt; config files untouched; SC-3 Cursor at file level (42/42 agents links, no D-20 flag)"
    verification:
      - kind: e2e
        ref: "Task 5 <automated> exit 0 (verbatim); 04-PROOF.md proof_result=pass"
        status: pass

duration: ~4h40m wall (mostly the owner checkpoint)
completed: 2026-09-27
status: complete
---

# Phase 4 Plan 12: Phase 4 proof (Omp route) Summary

**Proof passed.** A skill that a real Omp session's own skill creator wrote was merged into the library. It then appeared in Claude Code and Grok Build 126 s after the merge. The substrate-skills-sync timer delivered it on its own, and neither config file was touched.

- A real Omp session (`01a0dfe8-61c8-7625-abd2-071abece07e1`) received the fixed prompt, which dictates no skill content. It ran 14 read-only tool calls on the sync chain, then called `manage_skill create substrate-skills-sync-audit`.
- The 04-08 extension blocked that call and proposed the skill. The PR, [agent-skills#7](https://github.com/swcstudiospace/agent-skills/pull/7), carries `surface: omp` and `session_id: 01a0dfe8-…`. That id is the same one on the `type: session` line of Omp's own session file.
- PR #7 was merged at 03:26:59Z. The orchestrator did the merge, under a one-time exception to D-16 that the owner authorized (see Gaps).
- The timer ticked at 03:28:56Z, fast-forwarded to `df0db4e` and created the claude, grok, agents and muse links at 03:29:05Z.
- `grok inspect` found the name 0 times before the merge and once after. Claude Code's init event lists the skill in both `slash_commands` and `skills`.
- The config mtimes after the merge (claude 1790356194, grok 1790447779) are both at or before the merge epoch 1790479619, and both equal the Omp-route baseline.

## Performance

- **Started:** 2026-09-26, Task 1 pre-measure (before the 22:45:02Z Omp-route t0) · **Completed:** 2026-09-27T03:38Z
- **Tasks:** 5. Task 1 was TDD. Task 4 was the owner checkpoint.
- **Files:** 3 in the repo. On the host: the RESTORE routes and the key lists. On GitHub: PR #7, merged.

## Gate (Task 1, two-sided against its own pre-measure at PRE_HEAD c3aced8)

| | Pre (c3aced8) | Post (741249b) |
|---|---|---|
| bun test (root) | 530 pass, 0 fail | 534 pass, 0 fail |
| tsc (normalized) | tsc-exit=0 | tsc-exit=0 |
| failing ids | none | none |

The fast path held: no foreign change tripped the widened guard, so no worktree re-measure was needed.

## Key evidence (04-PROOF.md)

| Key | Value |
|---|---|
| omp_session_id | 01a0dfe8-61c8-7625-abd2-071abece07e1 |
| proof_skill | substrate-skills-sync-audit |
| proof_pr_url / status | …/agent-skills/pull/7 / existing (queued path, bridge re-post) |
| owner_merge_answer / owner_merge | merged / delegated |
| t_merged / merge_sha | 2026-09-27T03:26:59Z / df0db4e18b2837a1907d4fd4ddb86c3b825310f1 |
| t_timer_trigger / t_projected | 03:28:56Z / 03:29:05Z |
| delta_merge_to_projection_s | 126 |
| manual_sync_after_merge | false |
| claude_grok_touched / same_as_omp_route | false / true |
| grok_inspect_count_pre → after | 0 → 1 |
| claude_init_lists | true |
| agents_link / cursor_flags_absent / 42 = 42 | true / true / sc3_cursor_file_level=true |
| muse_link / hermes_lists / omp_lists | true / true / true |
| proof_result | pass |

## Task Commits

1. **Task 1 RED:** `9a88aa7` test(04-12): Omp extension forwards the ctx session id as session_id (RED)
2. **Task 1 GREEN:** `741249b` feat(04-12): Omp extension forwards session_id
3. **Task 2:** `6e803b6` docs(04-12): Omp-route baseline for the Phase 4 proof
4. **Task 3:** `b39c444` docs(04-12): real Omp session proposes the proof skill (PR #7, session 01a0dfe8)
5. **Task 5:** `46dff86` docs(04-12): Phase 4 proof — Omp-mined skill arrives in Claude Code and Grok Build (pass)

## Verify results

Tasks 1, 2, 3 and 5 all ran their `<automated>` blocks, and each exited 0. Tasks 2 and 3 were run verbatim from the plan and re-run after the Task 5 evidence was appended, still exiting 0. Task 1 ran with the checker fixes listed under Deviations.

## Deviations from Plan

1. **Plan-check warnings N1–N3 applied to the Task 1 verify.** These came from Check0412r2 as one-line fixes:
   - N1: a trap plus a pre-clean for the scratch worktrees.
   - N2: the foreign-change guard now covers every path outside `packages/projector/omp` and `.planning`, and the `find` no longer filters on `-name '*.ts'`.
   - N3: `test -n` on both pass counts.
   - The Task 3 extractor skips non-JSON stdout lines (checker info item).
2. **Task 4 merge was delegated.** The first relayed "merged" arrived while gh still showed PR #7 OPEN, polled from 02:50Z to 03:02Z. The executor stopped and reported. The owner then authorized a one-time D-16 exception, and the orchestrator ran `gh pr merge 7 --squash`. It is recorded verbatim as `owner_merge=delegated` and under `## Gaps`. The executor did not merge.
3. **The Claude probe exited 124.** It hit the 180 s stop, but only after writing the init event, and the arrival check reads only that event. The temp paths were removed.
4. **Hermes listing.** The default `hermes skills list` table truncates the name column, so the plain grep counted 0. With `COLUMNS=250` the count is 1. Both results are recorded, and this key is supporting only.

## Issues Encountered

- Omp start-up printed that the MCP servers `ktui` and `aio` were not ready after 30 s. The task did not use them.
- The propose took longer than the extension's 25 s client timeout, so the proposal took the queued path. The bridge drained it within 2 minutes and got `existing` back with PR #7.

## Gaps

These are recorded in 04-PROOF.md `## Gaps`:
- D-16/D-21: the merge was delegated, not done by the owner in person.
- On the queued path, the session file names the queue file rather than the PR. The bridge-log line ties that queue file to PR #7.

## Self-Check: PASSED

- Commits 9a88aa7, 741249b, 6e803b6, b39c444 and 46dff86 are present in `git log`.
- `04-PROOF.md` has `proof_result=pass`. RESTORE.d/04-12.md has routes 1 (applied), 2 and 3.
- No `/tmp/04-12-*` or probe temp paths remain.
