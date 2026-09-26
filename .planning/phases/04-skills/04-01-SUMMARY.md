---
phase: 04-skills
plan: 01
subsystem: infra
tags: [baseline, rollback, restore, git, skill-autonomy, docs-scraper, rivet, agentos, host_dir, mounts, d-08, d-12, d-14]

requires:
  - phase: 03-lane-a
    provides: 03-BASELINE.md shape and tsc normalization pipeline; 03-01 spike conventions (throwaway packages/host/spike, key=value evidence, b_skills=no); vm.ts host_dir mount form (L372); seed.ts skill write path (L254-266)
  - phase: 01-lane-b
    provides: /var/lib/substrate/phase1-baseline/RESTORE.md structure (read only; no Phase 1 file touched)
provides:
  - 04-BASELINE.md — two-sided gate contract at 44bad2d: bun 338 pass / 0 fail / 22 files, tsc-exit=0, dispatcher 149, skill-autonomy 25, library 41/26/40, nine-root inventory, 20 grok-real-entry lines, 0 dangling links, hermes-pending-memory=3, disk-avail-before, phase4-baseline-t0; plus skill-autonomy-git-head, skill-autonomy-gitignore-sha256, skill-autonomy-tracked-files=42, docs-scraper-baseline-commit
  - /var/lib/substrate/phase4-baseline/ (0700) — RESTORE.md index (plan routes → RESTORE.d/04-NN.md, projector → projector/<ts>/RESTORE.md), RESTORE.d/04-01.md, t0/20260926T033909Z (6 live files cp -a, 9 skill-root listings, MANIFEST.sha256 verifies), latest → t0
  - skill-autonomy git baseline — `main` @ 54972bf (42 non-ignored files, .grok-plugin/ included, .gitignore byte-identical, porcelain empty, equals the installed Grok copy)
  - docs-scraper baseline — first commit ab5652e in /root/.openclaw/workspace (82 files, projects/docs-scraper/ only)
  - 04-01-SPIKE.md — mount_route=nested (40 read-only nested host_dir mounts + a seeded sibling dir: readdir 41, sha match, EROFS)
affects: [04-02, 04-03, 04-04, 04-05, 04-06, 04-07, 04-08, 04-09, 04-10, 04-11, 04-12]

actuals:
  tokens: 3109       # chars/4 over the 44bad2d..d711d4e diff (2 files, +241)
  tasks: 3
  commits: 3         # git rev-list --count 44bad2d6036990f74b7670047db2ea6a5e333e15..HEAD (before this SUMMARY commit)
plan_head_before: 44bad2d6036990f74b7670047db2ea6a5e333e15

tech-stack:
  added: []
  patterns:
    - "Phase rollback area: 0700 root, RESTORE.md index, one RESTORE.d/04-NN.md per plan, t0 snapshot with cp -a + MANIFEST.sha256, never printing a snapshotted config"
    - "Baseline a repo with no history from git's own untracked-non-ignored list (ls-files -z --others --exclude-standard), staged by explicit path, porcelain empty right after"
    - "Path-scoped first commit in a shared repo (`git commit -- projects/docs-scraper`) with a tracked-outside count of 0 as the check"

key-files:
  created:
    - .planning/phases/04-skills/04-BASELINE.md
    - .planning/phases/04-skills/04-01-SPIKE.md
    - /var/lib/substrate/phase4-baseline/RESTORE.md (host, not in git)
    - /var/lib/substrate/phase4-baseline/RESTORE.d/04-01.md (host, not in git)
    - /root/src/repos/skill-autonomy/.git (host, baseline commit 54972bf)
  modified:
    - /root/.openclaw/workspace git history (first commit ab5652e, projects/docs-scraper only)

key-decisions:
  - "mount_route=nested: 40 per-skill read-only host_dir mounts under /home/agentos/.claude/skills coexist with a seeded ultrathink-sync dir (readdir 41, guest read sha256 = host, write EROFS); 04-06 takes per-skill nested mounts, not the sibling mount or the copy route"
  - "04-06 should set readOnly both inside plugin.config (enforcement, EROFS) and at the mount's top level (what listMounts reports), as hostDirMount() does — observed: config-only gave listMounts readOnly=0/41 while writes were still refused; with both, 40/40"
  - "skill-autonomy gates must parse counts from `python3 -m pytest -p no:cacheprovider` (pyproject addopts already -q); the plan's `-q -p no:cacheprovider` runs at -qq and prints no count line"
  - "The t0 snapshot includes /root/.openclaw/openclaw.json as reference only (it is in the plan's interfaces list); RESTORE.md marks it not edited by Phase 4"

patterns-established:
  - "Mount spikes run a standalone AgentOs.create beside substrate-host (own default sidecar, 600 s timeout), check ActiveEnterTimestamp/NRestarts before and after, and confirm no sidecar process is left"

requirements-completed: []

coverage:
  - id: D1
    description: "04-BASELINE.md: every key once (agent-substrate head/pass/fail/files, dispatcher, skill-autonomy, library entries/links/SKILL.md, dangling-links-before, hermes-pending-memory, disk-avail-before, phase4-baseline-t0), tsc-set and grok-real-entry lines, library-links=26 and library-skill-md=40; the two-sided comparison rules with skill-autonomy added and the new miner suite at 0 failed"
    verification:
      - kind: other
        ref: "Task 1 <automated> verify (/tmp/04-01/t1-verify.sh under /bin/bash): exit 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "Rollback area /var/lib/substrate/phase4-baseline mode 700 with RESTORE.md, RESTORE.d/04-01.md, latest → t0/20260926T033909Z, 6 live files copied with cp -a (Hermes config and cron jobs, Omp config, Cursor hooks, Grok skill-autonomy rule, OpenClaw config as reference) and 9 root listings; MANIFEST.sha256 (15 entries) verifies; no snapshotted file printed"
    verification:
      - kind: other
        ref: "Task 1 <automated> verify: sudo sha256sum -c --quiet MANIFEST.sha256, stat 700, readlink latest, Hermes config and Cursor hooks snapshot non-empty — exit 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "D-12: skill-autonomy on main @ 54972bf tracks all 42 non-ignored files (.gitignore, .grok-plugin/plugin.json, .grok-plugin/marketplace.json included; no bytecode/cache path); porcelain --untracked-files=all empty; .gitignore sha256 a2c5d1b1… and 4 lines unchanged; diff -rq against ~/.grok/installed-plugins/skill-autonomy-6d1e8e39 empty; undo removes only .git"
    verification:
      - kind: other
        ref: "Task 2 <automated> verify (/tmp/04-01/t2-verify.sh): exit 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-14: /root/.openclaw/workspace first commit ab5652e holds only projects/docs-scraper/ (82 files), nothing staged; OpenClaw persona/memory files stay untracked; undo route in RESTORE.d/04-01.md"
    verification:
      - kind: other
        ref: "Task 2 <automated> verify: ls-files outside projects/docs-scraper = 0, diff --cached empty, both commit subjects carry Refs SPE-2734 Refs SPE-3576, both undo routes present — exit 0"
        status: pass
    human_judgment: false
  - id: D5
    description: "D-08 spike: one throwaway VM with 40 nested read-only host_dir mounts plus a sibling mount; seed write under the mounts ok, readdir 41, sha match, mounted and sibling writes EROFS, 187 mounts listed; mount_route=nested; spike dir and output removed; substrate-host active and not restarted"
    verification:
      - kind: integration
        ref: "04-01-SPIKE.md; Task 3 <automated> verify (/tmp/04-01/t3-verify.sh): exit 0"
        status: pass
    human_judgment: false

duration: 9min
completed: 2026-09-26
status: complete
---

# Phase 4 Plan 01: Wave 0 baselines, rollback area, git baselines and the rivet mount spike Summary

**Every later Phase 4 gate now diffs against a measured baseline at `44bad2d` (bun 338/0 across 22 files, tsc clean, dispatcher 149, skill-autonomy 25; library 41 entries / 26 links / 40 SKILL.md; no dangling link in the nine skill roots), every live config Phase 4 edits has a `cp -a` copy and a restore command under the new 0700 `/var/lib/substrate/phase4-baseline/`, skill-autonomy and docs-scraper each have a restorable git starting point that swept in nothing else, and a throwaway VM showed that rivet accepts 40 read-only `host_dir` mounts nested under the seeded `~/.claude/skills` dir — so 04-06 uses `mount_route=nested`.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-09-26T03:36:48Z
- **Completed:** 2026-09-26T03:45:34Z
- **Tasks:** 3
- **Files modified:** 2 in the repo (04-BASELINE.md, 04-01-SPIKE.md) + this SUMMARY; outside: the rollback area, skill-autonomy `.git`, the OpenClaw workspace's first commit

## Baselines (measured, before any Phase 4 edit)

| Suite | 04-CONTEXT (9eef1ee) | Measured at 44bad2d |
|---|---|---|
| agent-substrate bun test | 338 pass, 0 fail, 22 files | 338 pass, 0 fail, 22 files (5844 expect() calls) |
| tsc (normalized) | exit 0 | `tsc-exit=0` |
| dispatcher pytest | 149 passed | 149 passed |
| skill-autonomy pytest | 25 passed (research Q8) | 25 passed |

No failing ids in any suite, so no `*-failing-id:` lines. Library: 41 entries, 26 links (25 into the docs-scraper exports, 1 to Hermes' `research/anda-ecosystem`), 40 SKILL.md — D-02's premise holds. Roots: Claude 74 real, Grok 20 real + 23 export links, `~/.agents` 80 real, Cursor 72 real, Hermes 34 real + 33 links (20 exports, 13 library), Omp 4 library links, OpenClaw 5+30 and workspace 2+30 (20 exports, 10 library each). `hermes-pending-memory=3`, `disk-avail-before=19997605888`.

## Accomplishments

- **04-BASELINE.md** in 03-BASELINE.md's shape: commands, the tsc pipeline, verbatim summary lines, the machine-readable block, the two-sided rules (skill-autonomy added; miner new → 0 failed), and the Task 2 git keys.
- **Rollback area:** `/var/lib/substrate/phase4-baseline/` (0700) with `RESTORE.md` (purpose, the RESTORE.d/projector rules, a restore table with the restart note per file, the no-Phase-1-file note), `RESTORE.d/04-01.md` (both undo routes), `t0/20260926T033909Z/` (files/ + listings/ + MANIFEST.sha256, 15 entries, verifies), `latest` → t0. Each copy was `cmp`-checked against the live file; none was displayed.
- **skill-autonomy (D-12):** `git init -b main`; the 42 paths from `ls-files -z --others --exclude-standard` staged by explicit path; commit `54972bf`. `.gitignore` untouched (sha256 `a2c5d1b1…` before and after, 4 lines); the tree still equals the installed Grok copy.
- **docs-scraper (D-14):** `git add -- projects/docs-scraper` + path-limited commit `ab5652e` on the workspace's `master`; 82 tracked files, all under `projects/docs-scraper/`; the 13 untracked OpenClaw entries (AGENTS.md, SOUL.md, memory/, …) stay untracked and unstaged.
- **Spike (D-08, A3):** `AgentOs.create` with 40 nested mounts + 1 sibling: create 1286 ms (sidecar `applied_mounts=186`), `mkdir -p` + write of `ultrathink-sync/SKILL.md` ok and read back, `readdir` 41 (no mounted name missing), guest `dev-flow/SKILL.md` sha256 = host, write under a nested mount → EROFS, sibling readdir 27 and write → EROFS, 187 mounts listed, dispose 240 ms. `mount_route=nested`.

## Task Commits

1. **Task 1: Measured baselines, live inventory and the phase4-baseline rollback area** — `7d98d69` (docs)
2. **Task 2: Git baselines for skill-autonomy (git init) and docs-scraper (path-scoped commit)** — `b146112` (docs) in agent-substrate; `54972bf` in skill-autonomy; `ab5652e` in /root/.openclaw/workspace
3. **Task 3: rivet nested read-only mount spike** — `d711d4e` (docs)

**Plan metadata:** this SUMMARY commit (docs).

## Files Created/Modified

- `.planning/phases/04-skills/04-BASELINE.md` — the Phase 4 gate contract (above).
- `.planning/phases/04-skills/04-01-SPIKE.md` — spike command, keys, derivation, supplementary top-level-readOnly run, Gaps.
- `/var/lib/substrate/phase4-baseline/{RESTORE.md, RESTORE.d/04-01.md, t0/20260926T033909Z/, latest}` — host only.
- `/root/src/repos/skill-autonomy/.git` — new; baseline commit `54972bf`.
- `/root/.openclaw/workspace` — first commit `ab5652e`.
- `packages/host/spike/p4-mounts.ts` — throwaway, deleted; `git status --porcelain -- packages/host` empty.

## Decisions Made

See key-decisions. None changes a D-01..D-21 contract: D-08's "prefer a read-only mount if the probe shows it works" is now answered by observation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] skill-autonomy's plan command prints no count line**
- **Found during:** Task 1 (measuring skill-autonomy)
- **Issue:** `python3 -m pytest -q -p no:cacheprovider` in skill-autonomy printed 25 dots and exit 0 but no `N passed` line: its `pyproject.toml` has `addopts = "-q"`, so the command runs at `-qq`.
- **Fix:** the count line came from the same suite as `python3 -m pytest -p no:cacheprovider` (`25 passed in 1.80s`); 04-BASELINE.md records both forms and tells every skill-autonomy gate to parse the single-`-q` form (or add `-rfE`).
- **Files modified:** .planning/phases/04-skills/04-BASELINE.md
- **Verification:** Task 1 verify exit 0; `skill-autonomy-pass=25`
- **Committed in:** 7d98d69

**2. [Rule 2 - Missing critical] Spike's read-only flag not visible in listMounts**
- **Found during:** Task 3 (first spike run)
- **Issue:** with `readOnly` only in `plugin.config` (the plan's shape), writes were refused (EROFS), but `listMounts` reported `readOnly=false` for all 41 added mounts; 04-06 would otherwise build mounts whose listing contradicts their enforcement.
- **Fix:** one extra run of the same throwaway script with a top-level `readOnly: true` on the 40 nested mounts (hostDirMount()'s shape): same results, listing 40/40 read-only. Recorded under `## Supplementary run` (indented, so the column-0 keys stay the first run's) and in Gaps; the recorded `mount_route` comes from the plan's shape.
- **Files modified:** .planning/phases/04-skills/04-01-SPIKE.md
- **Verification:** Task 3 verify exit 0
- **Committed in:** d711d4e

---

**Total deviations:** 2 auto-fixed (Rule 3: 1, Rule 2: 1).
**Impact on plan:** no contract changed; both add evidence later plans need (04-09's gate parsing, 04-06's mount shape).

## Issues Encountered

- The plan's `<automated>` blocks were extracted verbatim to `/tmp/04-01/t{1,2,3}-verify.sh` and run under `/bin/bash` (the 03-06/03-07 precedent): exit 0 each, and all three re-run after the last commit: exit 0 each.
- `/root/.openclaw/workspace` is on `master`, not `main`; the plan names no branch for it, so the commit landed on the repo's existing branch.

## Threat Flags

None beyond the plan's register. T-04-01-01 (snapshotted configs 0700, never printed), T-04-01-02 (both write probes EROFS, no host file created), T-04-01-03 (0 tracked paths outside projects/docs-scraper), T-04-01-04 (substrate-host `NRestarts=0`, same `ActiveEnterTimestamp`, no leftover sidecar) and T-04-01-05 (porcelain empty, `.gitignore` hash unchanged, undo removes only `.git`) all held as observed.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Every later plan reads `B=.planning/phases/04-skills/04-BASELINE.md` for its two-sided gate and writes its routes to `RESTORE.d/04-NN.md` before its first live edit.
- 04-06: `mount_route=nested` — per-skill `{ path: /home/agentos/.claude/skills/<name>, plugin: { id: "host_dir", config: { hostPath, readOnly: true } }, readOnly: true }`; the ultrathink seed still writes beside them. Its live smoke is the first check through substrate-host's actor path.
- 04-09 edits skill-autonomy on top of `54972bf`; 04-10 edits docs-scraper on top of `ab5652e`.
- STATE.md and ROADMAP.md untouched (orchestrator-owned); `.planning/config.json`, `.planning/state.json`, `06-CONTEXT.md`, the phase 5/6 planning files and `issues/` left unstaged.

## Self-Check: PASSED

- FOUND: .planning/phases/04-skills/04-BASELINE.md, .planning/phases/04-skills/04-01-SPIKE.md, /var/lib/substrate/phase4-baseline/{RESTORE.md, RESTORE.d/04-01.md, latest}
- FOUND: commits 7d98d69, b146112, d711d4e (agent-substrate), 54972bf (skill-autonomy), ab5652e (/root/.openclaw/workspace)
- Task 1, 2 and 3 `<automated>` verifies re-run on the committed tree under /bin/bash: exit 0 each; packages/host/spike absent; substrate-host active
