---
phase: 04-skills
plan: 06
subsystem: host
tags: [skills, library, rivet, agentos, host_dir, read-only-mount, copy-route, d-08, sc-3]

requires:
  - phase: 04-skills
    provides: 04-01 mount_route=nested (04-01-SPIKE.md) and 04-BASELINE.md (bun 338/0, tsc-exit=0, head 44bad2d); 04-02 git-backed /root/agent-skills; 04-04 the sync timer that keeps /root/agent-skills at origin/main
  - phase: 03-lane-a
    provides: vm.ts resolveOptions (worktree host_dir mount), seed.ts ultrathink seed, throwaway-task procedure (03-04 Task 1)
provides:
  - packages/host/src/options.ts — MountRoute (nested | sibling | copy), VM_SKILLS_DIR, VM_LIBRARY_DIR, LIBRARY_HEAD_MARKER, HostDirMount, LibraryCopyTarget, listLibrary, skillMounts, parseMountRoute (none → copy), libraryCopyPlan, copyLibraryInto
  - packages/host/src/vm.ts — HostVmConfig.libraryDir / mountRoute / reservedSkills; library mounts appended after the unchanged worktree mount in resolveOptions (fresh read per VM wake); onVmStart copy route (copy only); log lines `vm skills <gid> mounted <n> (<route>)`, `copied <n> files in <ms> ms (copy)`, `current (copy)`, `partial <k> failed (copy)`, `unavailable: <error name>`
  - packages/host/src/main.ts — env SUBSTRATE_LIBRARY_DIR (default /root/agent-skills), SUBSTRATE_SKILL_MOUNTS (default nested, rejected at startup if invalid); startup log `… library <dir> mounts <route>`
  - live — substrate-host restarted 2026-09-26T09:08:49Z; every new VM gets 41 read-only nested mounts under /home/agentos/.claude/skills beside the 4 seeded ultrathink skills
affects: [04-12]

actuals:
  tokens: 6600       # chars/4 over the added lines of 338f280..da65bf3 (5 files, +530)
  tasks: 2
  commits: 3         # 338f280, 581b34e, da65bf3
plan_head_before: feed65f

tech-stack:
  added: []
  patterns:
    - "Library delivery is a pure builder (skillMounts / libraryCopyPlan) in options.ts plus a thin rivet wiring in vm.ts; tests never import rivet"
    - "Every host_dir library mount sets readOnly at both levels: plugin.config.readOnly (what host_dir enforces) and top-level readOnly (what listMounts reports), per 04-01-SPIKE.md Gaps"
    - "Copy route integrity: the head marker is emptied before a copy and written only when every BatchWriteResult succeeded, so a partial copy is retried at the next boot"

key-files:
  created:
    - .planning/phases/04-skills/04-06-SMOKE.md
  modified:
    - packages/host/src/options.ts
    - packages/host/src/options.test.ts
    - packages/host/src/vm.ts
    - packages/host/src/main.ts

key-decisions:
  - "HostDirMount carries a top-level `readOnly: true` in addition to the interface block's `plugin.config.readOnly` (04-01-SPIKE.md Gaps: set both so listing and enforcement agree)."
  - "listLibrary ignores dot-dirs and symlinked dirs (only real subdirectories with SKILL.md), so a link in the library cannot mount a path outside it."
  - "The copy route filters the plan to regular files (lstat) at copy time, so a tracked symlink cannot pull a non-library host file into a guest; a tracked-but-deleted file is skipped rather than failing the whole copy."
  - "vm_read_sha_match is measured from inside the guest (vm.exec sha256sum), because rivet's actor filesystem.readFile/stat fail on a read-only host_dir mount (see Issues)."
  - "vm_mounted_write=erofs records the guest shell's EROFS refusal; the actor-level writeFile was also refused (internal_error)."

patterns-established:
  - "New VM-visible host content goes through options.ts builders confined to one host directory, with a test that every produced hostPath stays inside it"

requirements-completed: []

duration: ~30 min
completed: 2026-09-26
---

# Phase 4 Plan 06: Library in every new rivet-agentos VM Summary

**Every VM substrate-host creates now carries the whole current skill library as read-only
host_dir mounts under /home/agentos/.claude/skills (nested route from 04-01), beside the
unchanged ultrathink seed; D-08's copy route is implemented and unit-tested for mount_route none.**

## Performance

- Tasks: 2 (1 TDD auto, 1 live auto), both verify commands exit 0
- Commits: 338f280 (RED), 581b34e (GREEN), da65bf3 (smoke evidence)
- Live VM create with 41 library mounts: `vm skills … mounted 41` → `vm resolved` in ~1 s, task opened 9 s later (sandbox start dominates, as in Phase 3)

## Baselines (two-sided, against 04-BASELINE.md)

- Root bun suite: 503 pass / 0 fail across 27 files (baseline 338/0/22); no failing id on either side; pass count grew (the 04-06 share is +19 tests in options.test.ts, the rest are sibling wave-4 plans).
- tsc normalized set: `tsc-exit=0` (identical to baseline).
- Targeted: options.test.ts + seed.test.ts + tasks.test.ts 81 pass / 0 fail.
- seed.ts, seed.test.ts, tasks.ts, tasks.test.ts: `git diff --quiet 44bad2d` exit 0.
- Transient: a first mid-flight root run (09:07) saw 1 unhandled error and 13 tsc errors, all in packages/projector/src/skills.test.ts (a sibling's RED state, not in this plan's files); the re-run after it landed was green as above.

## Accomplishments

- Pure builders in options.ts: skillMounts (nested per-skill mounts, sorted, reserved and invalid names skipped; sibling single mount; copy → []), listLibrary, parseMountRoute, libraryCopyPlan (git-tracked `<valid name>/<rel>` only, no `..`/`.`/empty/`.git` segment), copyLibraryInto (marker skip, clear-first, sorted recursive mkdirs before writes, batches ≤ 200, per-entry failure collection, marker only on full success).
- vm.ts wiring: library mounts appended after the worktree mount inside resolveOptions (fail open with one log line); onVmStart copy route reading `git rev-parse HEAD` and `git ls-files -z` via execFileSync argv (30 s timeout), failing open.
- main.ts: library dir and mount route from env, reserved names = the loaded ultrathink skills, startup log extended.
- Live proof (04-06-SMOKE.md): throwaway graph ut-mui646lx-8f314a85's VM listed 45 entries (4 ultrathink + all 41 library skills), in-guest sha256 of substrate-skill-miner/SKILL.md equals the host's, guest write refused with EROFS, host library clean; task terminated/killed, node released, worktree and branch removed.

## Task Commits

1. Task 1 RED — `338f280` test(04-06): failing tests for library mounts and the D-08 copy route
2. Task 1 GREEN — `581b34e` feat(04-06): library in every new VM — read-only mounts or the D-08 copy route (D-08)
3. Task 2 — `da65bf3` docs(04-06): VM library mount evidence — nested read-only mounts in a live VM (D-08)

## Files Created/Modified

- `packages/host/src/options.ts` — library types, constants and builders (+129)
- `packages/host/src/options.test.ts` — 19 tests over every behavior bullet, no rivet import (+220)
- `packages/host/src/vm.ts` — HostVmConfig fields, libraryMounts in resolveOptions, onVmStart copy route (+71)
- `packages/host/src/main.ts` — env wiring, reservedSkills, startup log (+15)
- `.planning/phases/04-skills/04-06-SMOKE.md` — live VM evidence

## Decisions Made

See key-decisions above. No live file outside the repo was edited (only `systemctl restart
substrate-host`), so no RESTORE.d route was needed.

## Deviations from Plan

- **Top-level `readOnly: true` on HostDirMount** (interface block showed only `plugin.config.readOnly`): added per 04-01-SPIKE.md's Gaps recommendation; tests assert both.
- **Guest-side read for vm_read_sha_match**: the plan implied reading through the VM; the actor API read failed (rivet defect below), so the read ran as `vm.exec sha256sum` inside the guest, which is also how the VM's model reads files.
- **Verify run environment**: the harness shell's `grep` is a builtin whose `-o` with an anchored ERE prints nothing, which made the Task 1 pass-count test fail spuriously; both verify commands were re-run verbatim under `env -i PATH=/usr/bin:/bin bash --norc` (GNU grep) and exited 0. Reported via report_issue.

## Issues Encountered

- rivet 0.2.21 actor filesystem actions on a read-only host_dir mount: `readFile` and `stat` answer `internal_error`, `readFiles` reports `EROFS`; `readdir` works and guest processes read normally. No host code reads library files through the actor API, so delivery is unaffected; recorded in 04-06-SMOKE.md Gaps.
- The library has 41 skills now (spike: 40); 41 nested mounts worked.

## User Setup Required

None.

## Next Phase Readiness

- 04-12 (phase proof) can cite 04-06-SMOKE.md for SC-3 "rivet-agentos VM" delivery.
- The copy route is exercised only by unit tests (the spike selected nested); switching needs only `SUBSTRATE_SKILL_MOUNTS=copy` (or `none`) in the unit env and a restart.
- Gap carried: the VM's Claude runs `--bare` (03-01 b_skills=no), so skills are available by path, not auto-loaded.

## Self-Check: PASSED

- Files exist: options.ts, options.test.ts, vm.ts, main.ts, 04-06-SMOKE.md.
- Commits exist: 338f280, 581b34e, da65bf3.
- Task 1 verify exit 0 (GNU grep); Task 2 verify exit 0.
