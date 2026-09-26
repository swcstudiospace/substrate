---
phase: 04-skills
plan: 04
subsystem: infra
tags: [skills, projector, sync, systemd, timer, symlink, claude-code, grok-build, d-04, d-05, d-06, d-16, d-21, sc-3, tracer]

requires:
  - phase: 04-skills
    provides: 04-01 04-BASELINE.md (bun 338/0, tsc-exit=0, dispatcher 149 passed), /var/lib/substrate/phase4-baseline (RESTORE.md index, RESTORE.d per plan); 04-02 /root/agent-skills clean checkout on main @ 3ac8572; 04-03 SKILL_NAME_RE (propose.ts) and the tracer PR agent-skills#1 (pr_url in 04-03-TRACER.md)
  - phase: 03-lane-a
    provides: cursor.ts --check / already-current / backup shape; hostfns.ts Runner shape
provides:
  - packages/projector/src/skills.ts — ROOTS (claude, grok), LIBRARY_DIR, EXPORTS_DIR, libraryNames, inventory, plan (pure), apply (tmp+rename, RESTORE.md per action, warning dedupe), CLI `bun packages/projector/src/skills.ts [--check] [--root <id>]`
  - packages/projector/src/skills-sync.ts — decide (refuse-dirty | refuse-branch | refuse-diverged | current | ff), executor (fetch, merge --ff-only origin/main, then the projector), log lines `[skills-sync] ff|current|refused`
  - infra/vps/substrate-skills-sync.{service,timer} installed in /etc/systemd/system, timer enabled (OnBootSec=2min, OnUnitActiveSec=5min, AccuracySec=30s)
  - host state — /var/lib/substrate/skills/projector-warned.json (0600, 10 grok real-dir keys), /var/lib/substrate/phase4-baseline/projector/20260926T072758Z (70 undo lines), RESTORE.d/04-04.md and its RESTORE.md index row, snapshot 04-04/20260926T072735Z
  - live projection — 40 library links in ~/.claude/skills, 30 in ~/.grok/skills (41 and 31 after the tracer arrived), 10 real Grok dirs skipped
  - tracer far end — agent-skills#1 merged by the owner (34b32e2) reached Claude Code and Grok Build on the timer alone in 71 s
affects: [04-05, 04-06, 04-07, 04-08, 04-09, 04-10, 04-11, 04-12]

actuals:
  tokens: 10940      # chars/4 over the added lines of 46ef835..ba10ada in packages/, infra/ and 04-04-TRACER.md (7 files, +1041)
  tasks: 3
  commits: 3         # 1ccf5a7, 354310c, ba10ada (2bcaa3b is the orchestrator's STATE.md halt commit)
plan_head_before: 46ef835

tech-stack:
  added: []
  patterns:
    - "Projection is a pure plan over (library names, root inventory, exports dir) plus an executor that only runs link-new and repoint actions; skip-warn entries are never drift"
    - "Every link change goes through <name>.substrate-tmp and rename, so a repointed name is never missing, and appends its own undo line to the run's RESTORE.md before the change"
    - "Warnings are deduped per (root, name, reason) in a state file, so a 5-minute timer does not re-emit the same warning"
    - "The live library checkout is written only by the sync, and only by a fast-forward of a clean main whose HEAD is an ancestor of origin/main"

key-files:
  created:
    - packages/projector/src/skills.ts
    - packages/projector/src/skills.test.ts
    - packages/projector/src/skills-sync.ts
    - packages/projector/src/skills-sync.test.ts
    - infra/vps/substrate-skills-sync.service
    - infra/vps/substrate-skills-sync.timer
    - .planning/phases/04-skills/04-04-TRACER.md
    - /etc/systemd/system/substrate-skills-sync.{service,timer} (host, copies of infra/vps)
    - /var/lib/substrate/phase4-baseline/RESTORE.d/04-04.md (host, not in git)
    - /var/lib/substrate/skills/projector-warned.json (host, not in git)
  modified:
    - /var/lib/substrate/phase4-baseline/RESTORE.md (index row for 04-04)
    - /root/.claude/skills, /root/.grok/skills (links into /root/agent-skills)

key-decisions:
  - "Real Grok dirs with a library name (docs-scraper and nine parallel-*) are skip-warn (real-dir) here; backup-then-link is 04-05's job."
  - "Actions are applied in name order within a root, so the log for a root mixes repoint and link-new lines by name."
  - "The first live run was the timer's own tick on `enable --now` (boot was more than 2 min earlier); the plan's explicit `systemctl start` became the second, idempotence, run."

patterns-established:
  - "Wave-4 roots (04-05: agents, muse, openclaw) are added to ROOTS; the plan/apply contract, log lines and the dedupe state file do not change"

requirements-completed: []

coverage:
  - id: D1
    description: "Projector (D-05, D-06 Grok part): libraryNames, inventory, plan → link-new / repoint / skip-warn (real-dir, foreign-link), non-library names untouched; apply via <name>.substrate-tmp + rename with RESTORE.md lines (rm for link-new, ln -sfn <old> for repoint); warnings deduped per (root, name, reason) with the root's surface; --check exits 1 on pending link-new/repoint and writes nothing, exits 0 with an already-current line otherwise."
    verification:
      - kind: unit
        ref: "SUBSTRATE_DISABLED=1 bun test packages/projector/src/skills.test.ts packages/projector/src/skills-sync.test.ts: 25 pass, 0 fail, 97 expect() (RED committed first in 1ccf5a7)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Sync gate (D-04): decide refuses dirty, non-main and diverged trees with one warning event and no fetch/merge as specified; ff runs `git -C /root/agent-skills merge --ff-only origin/main`; the projector runs only on current and ff."
    verification:
      - kind: unit
        ref: "packages/projector/src/skills-sync.test.ts (fake Runner), part of the 25 pass above"
        status: pass
    human_judgment: false
  - id: D3
    description: "Live install: units identical to infra/vps, timer enabled and active; first run 70 actions (40 claude link-new, 7 grok link-new, 23 grok repoint) with 10 real-dir warnings; second run 0 actions and 0 warnings; --check exit 0; 70 undo lines; no .substrate-tmp or dangling link; Grok's non-library names equal the t0 listing."
    verification:
      - kind: integration
        ref: "04-04-TRACER.md Task 1 keys and the Task 1 executor's run of /tmp/04-04-verify1.sh (suite outputs in /tmp/04-04-t1-*.txt); not re-run at close-out"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-16/D-21: the owner reviewed and merged the tracer PR at the blocking checkpoint."
    verification:
      - kind: manual_procedural
        ref: "Owner answer \"merged\"; env -i HOME=/root PATH=/usr/bin:/bin gh pr view https://github.com/swcstudiospace/agent-skills/pull/1 --json state,mergedAt,mergeCommit → MERGED, 2026-09-26T08:57:08Z, 34b32e27870c49d84e166830033b42f011eaf96e"
        status: pass
    human_judgment: false
  - id: D5
    description: "Tracer far end (SC-3): the merged skill reached Claude Code and Grok Build on the timer alone — the 08:58:18Z tick fast-forwarded 3ac8572..34b32e2 and linked substrate-skill-miner into both roots at 08:58:19Z (71 s after the merge); grok inspect lists it; Claude Code's init slash_commands and skills list it; manual_sync_after_merge=false."
    verification:
      - kind: e2e
        ref: "04-04-TRACER.md Task 3 keys; Task 3 <automated> verify (/tmp/04-04-verify3.sh, identical to the plan's command): exit 0"
        status: pass
    human_judgment: false
  - id: D6
    description: "Root suite and tsc two-sided green against 04-BASELINE.md with more passes than agent-substrate-pass; dispatcher pytest two-sided green."
    verification:
      - kind: other
        ref: "bun test: 450 pass, 0 fail across 25 files (baseline 338; 425 after 04-03); tsc-exit=0 on both sides; dispatcher pytest 149 passed (baseline 149); no failing-id set differs in either direction"
        status: pass
    human_judgment: false

duration: 1h36m (07:22Z–07:30Z build, owner checkpoint 07:30Z–08:57Z, 08:58Z–09:02Z far end)
completed: 2026-09-26
status: complete
---

# Phase 4 Plan 04: Skills sync timer, Claude/Grok projector and the tracer's far end Summary

**A 5-minute systemd timer now fast-forwards `/root/agent-skills` from `origin/main` and links every library skill into `~/.claude/skills` and `~/.grok/skills`. The owner-merged tracer skill `substrate-skill-miner` reached both agents 71 s after the merge, with nobody touching either tool.**
- `substrate-skills-sync` refuses a dirty tree, a branch other than main and diverged history. It emits one warning event and does not merge.
- The projector is a pure plan plus an executor. Each change is a tmp+rename, backed up with one RESTORE.md line. Real dirs are never touched, and warnings are deduped.
- First live run: 70 actions (40 Claude links, 7 new Grok links, 23 Grok links repointed from the docs-scraper exports). The second run did nothing.
- Owner merged [agent-skills#1](https://github.com/swcstudiospace/agent-skills/pull/1) at 08:57:08Z. The 08:58:18Z tick printed `ff 3ac8572..34b32e2` and linked the skill into both roots. `grok inspect` and Claude Code's init `slash_commands` both list it.

## Performance

- **Duration:** about 1h36m wall, most of it the owner checkpoint. Build was 07:22Z–07:30Z; the far end ran 08:58Z–09:02Z.
- **Started:** 2026-09-26T07:22Z
- **Completed:** 2026-09-26T09:02Z
- **Tasks:** 3 (Task 1 TDD, Task 2 human-action checkpoint, Task 3 tracer)
- **Files modified:** 7 in the repo, plus this SUMMARY. On the host: the two units in /etc/systemd/system, RESTORE.d/04-04.md and its index row, the snapshot, the projector backup dir, the dedupe state file and the links in both roots.

## Baselines (two-sided, against 04-BASELINE.md)

| Suite | 04-BASELINE (44bad2d) | After 04-03 (73415c0) | After Task 1 (354310c) |
|---|---|---|---|
| agent-substrate bun test | 338 pass, 0 fail | 425 pass, 0 fail | 450 pass, 0 fail (25 files) |
| tsc (normalized) | tsc-exit=0 | tsc-exit=0 | tsc-exit=0 |
| dispatcher pytest | 149 passed | — | 149 passed |

No failing-id set differs from the baseline in either direction. Targeted: `skills.test.ts` + `skills-sync.test.ts` 25 pass, 0 fail, 97 expect() (re-run at close-out, same result).

## Accomplishments

- **Projector (`skills.ts`).**
  - ROOTS are `claude` (`/root/.claude/skills`, surface claude-code) and `grok` (`/root/.grok/skills`, surface grok-build). The library is `/root/agent-skills`, and names must match SKILL_NAME_RE and have a SKILL.md.
  - The Grok rules:
    - a link into the exports dir is repointed;
    - a link already pointing at the library is left alone;
    - a real dir with a library name is skip-warn (real-dir);
    - any other link is skip-warn (foreign-link);
    - a non-library name is untouched.
  - `apply` writes `<name>.substrate-tmp` and renames it over the target. Before each change it appends an undo line (`rm` or `ln -sfn '<old>'`) to `projector/<ts>/RESTORE.md`; the dir is 0700 and is created only when an action runs. Warnings are deduped in `projector-warned.json`.
  - `--check` exits 1 when a link-new or repoint is pending and writes nothing. Otherwise it exits 0 and prints `already current`.
- **Sync (`skills-sync.ts`).** A pure `decide`. The executor uses a hostfns-shaped Runner (HOME=/root, 120 s) and runs these steps in order:
  - status and branch checks;
  - fetch;
  - is-ancestor check;
  - rev-parse;
  - `merge --ff-only origin/main`;
  - the projector.
  
  Library-level refusals emit a claude-code warning with `{component: "skills-sync", reason}`.
- **Units.** `substrate-skills-sync.service` is oneshot and runs `bun packages/projector/src/skills-sync.ts`. `.timer` has OnBootSec=2min, OnUnitActiveSec=5min and AccuracySec=30s. Both are installed identical to `infra/vps`, and the timer is enabled and active. The owner-merge tick came exactly on the 5-minute cadence (08:43:18, 08:48:18, 08:53:18, 08:58:18).
- **Rollback.** RESTORE.d/04-04.md has five routes: disable the timer, remove the units, delete the library links, restore Grok's old targets from the snapshot listing, and use the per-run projector RESTORE.md files.
- **Tracer far end (Task 3).** The owner merged at 08:57:08Z (34b32e2).
  - The first timer tick after the merge (08:58:18Z) printed `[skills-sync] ff 3ac8572…..34b32e2…`, `[projector] claude link-new substrate-skill-miner`, `[projector] grok link-new substrate-skill-miner` and `actions=2 warnings=0`, in 08:58:19Z.
  - Both links point at `/root/agent-skills/substrate-skill-miner`, and the checkout is clean at the merge commit.
  - `grok inspect` lists the skill as a `user` skill.
  - Claude Code's init event (255 slash_commands, 204 skills) contains it in both arrays.
  - No sudo command naming the sync or projector appears in the journal after the merge.

## Task Commits

1. **Task 1: Sync timer and the Claude/Grok projector (D-04, D-05, D-06 Grok part)**: `1ccf5a7` (test, RED), `354310c` (feat, incl. the Task 1 tracer evidence)
2. **Task 2: Owner reviews and merges the tracer PR (D-16, D-21)**: no commit (human-action checkpoint)
   - Owner's answer, verbatim: **"merged"** (the owner re-invoked `/gsd-autonomous` after merging).
   - Evidence: `env -i HOME=/root PATH=/usr/bin:/bin gh pr view https://github.com/swcstudiospace/agent-skills/pull/1 --json state,mergedAt,mergeCommit` → `{"mergeCommit":{"oid":"34b32e27870c49d84e166830033b42f011eaf96e"},"mergedAt":"2026-09-26T08:57:08Z","state":"MERGED"}`.
3. **Task 3: Tracer far end — the merged skill reaches Claude Code and Grok Build on the timer alone**: `ba10ada` (docs, tracer evidence)

**Plan metadata:** this SUMMARY commit (docs). The orchestrator's `2bcaa3b` recorded the checkpoint halt in STATE.md.

## Files Created/Modified

- `packages/projector/src/skills.ts`, `skills.test.ts`: the projector and its tests.
- `packages/projector/src/skills-sync.ts`, `skills-sync.test.ts`: the ff-only sync gate, executor and tests.
- `infra/vps/substrate-skills-sync.service`, `.timer`: the units.
- `.planning/phases/04-skills/04-04-TRACER.md`: Task 1 install/projection evidence and Task 3 far-end keys.
- Host only:
  - `/etc/systemd/system/substrate-skills-sync.{service,timer}`;
  - `/var/lib/substrate/phase4-baseline/{04-04/20260926T072735Z, projector/20260926T072758Z, RESTORE.d/04-04.md, RESTORE.md row}`;
  - `/var/lib/substrate/skills/projector-warned.json`;
  - the links in `/root/.claude/skills` and `/root/.grok/skills`.

## Decisions Made

- The real Grok dirs are skipped with a deduped warning; 04-05 adds backup-then-link.
- Actions in a root are applied and logged in name order.
- `sync_journal_line` records the Claude link-new line. The Grok line from the same run is in the tracer prose.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] RED test pinned a log order the plan does not specify**
- **Found during:** Task 1 (GREEN)
- **Issue:** The RED test expected `link-new fresh` before `repoint exp`. The plan fixes no order, and the executor applies actions in name order.
- **Fix:** The assertion now expects the name order (`repoint exp`, `link-new fresh`).
- **Files modified:** packages/projector/src/skills.test.ts
- **Verification:** targeted tests 25 pass, 0 fail
- **Committed in:** 354310c

---

**Total deviations:** 1 auto-fixed (test expectation)
**Impact on plan:** None on behavior; no scope change.

## Issues Encountered

- The first live run was the timer's own tick on `enable --now`: boot was more than 2 min earlier, so OnBootSec had already elapsed. The plan's `systemctl start` therefore became the second, idempotence, run. Both runs are in the journal (recorded under Gaps in 04-04-TRACER.md).
- Task 3: `grok inspect` was run twice, both read-only (once to count matches, once to see the matching line). Both list probes were true, so there is no A1 gap.
- The warning events were accepted by the substrate but not read back from the event store.

## User Setup Required

None. The owner's merge (Task 2) was the only human action.

## Next Phase Readiness

- The path from owner merge to both agents on the timer alone works end to end. Wave-4 plans (04-05 onward) can fan out on it.
- 04-05 extends `skills.ts` ROOTS (agents, muse, openclaw) and adds backup-then-link for the 10 real Grok dirs. It must keep the plan/apply contract, the log lines and the dedupe state file.

---
*Phase: 04-skills*
*Completed: 2026-09-26*
