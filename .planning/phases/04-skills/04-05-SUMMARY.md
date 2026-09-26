---
phase: 04-skills
plan: 05
subsystem: infra
tags: [skills, projector, symlink, cursor, muse, openclaw, grok-build, backup, d-05, d-06, d-20, sc-3, pitfall-12]

requires:
  - phase: 04-skills
    provides: 04-01 04-BASELINE.md (bun 338/0, tsc-exit=0, root-inventory and grok-real-entry lines); 04-04 skills.ts (ROOTS, plan/apply, RESTORE.md per run, dedupe state), substrate-skills-sync timer, 04-04-TRACER.md claude_init_lists=true
provides:
  - packages/projector/src/skills.ts — roots agents (cursor surface, disableFlag), muse (create), openclaw and openclaw-ws (repoint-only), cursor (enableFlag); GROK_KNOWN_REAL on the grok root; actions backup-then-link and remove-own-link; warning reasons real-dir-differs, stray-real-dir; sameTree, activeRoots
  - live projection — 41 library links in ~/.agents/skills and in ~/.config/muse/skills (created 0755), 2×20 OpenClaw links repointed from the docs-scraper exports to the library, Grok's 10 identical real copies backed up and replaced by links
  - host state — RESTORE.d/04-05.md and its RESTORE.md index row, snapshot 04-05/20260926T090925Z, projector run dir projector/20260926T090952Z (10 Grok copies, MANIFEST.sha256 of 22 files, 133 undo lines)
affects: [04-06, 04-07, 04-08, 04-09, 04-10, 04-11, 04-12]

actuals:
  tokens: 8307       # chars/4 over the added lines of 581b34e..7573830 in skills.ts, skills.test.ts and 04-05-SMOKE.md (3 files, +666)
  tasks: 2
  commits: 3         # d6c3cd3, 8cb0cad, 7573830
plan_head_before: 581b34e

tech-stack:
  added: []
  patterns:
    - "A root's behaviour is data: mode (link | repoint-only), create, disableFlag, enableFlag, knownReal; flags are read with existsSync at run time, so the 5-minute tick follows a flag without a code change"
    - "A real dir is replaced only when its tree equals the library copy (relative entries and file bytes, __pycache__/ and *.pyc ignored), re-checked at apply time, after a hash-verified copy to <run>/<root-id>/<name>/ and a RESTORE line"
    - "A missing root is skipped unless marked create; a created root gets an `rmdir` undo line ahead of its link lines"

key-files:
  created:
    - .planning/phases/04-skills/04-05-SMOKE.md
    - /var/lib/substrate/phase4-baseline/RESTORE.d/04-05.md (host, not in git)
    - /var/lib/substrate/phase4-baseline/04-05/20260926T090925Z/{roots.listing.tsv,MANIFEST.sha256} (host)
    - /var/lib/substrate/phase4-baseline/projector/20260926T090952Z (host, projector run dir)
    - /root/.config/muse/skills (host, 41 links)
  modified:
    - packages/projector/src/skills.ts
    - packages/projector/src/skills.test.ts
    - /var/lib/substrate/phase4-baseline/RESTORE.md (index row for 04-05)
    - /root/.agents/skills, /root/.openclaw/skills, /root/.openclaw/workspace/skills, /root/.grok/skills (links)

key-decisions:
  - "repoint-only differs from link only in never adding a link for an absent name; identical real dirs, differing real dirs and foreign links are handled as in link mode (OpenClaw has none today)."
  - "With the disable flag present, remove-own-link covers every entry <name> whose link resolves to <LIBRARY_DIR>/<name> (also names since removed from the library); nothing else is planned for that root."
  - "A root that does not exist and is not marked create gets no actions (04-04 would have failed at symlink time); this keeps an uninstalled agent from breaking a tick."
  - "backup-then-link swaps via <name>.substrate-old: the tmp link is made first, the dir is renamed aside, the link renamed in, the old dir removed — the name is missing only between two renames."
  - "stray-real-dir warnings are only for roots with knownReal (Grok); plain files (README.md) never warn."

patterns-established:
  - "New agent roots are added as ROOTS entries with the optional fields; plan/apply, log lines and the dedupe state file stay unchanged"

requirements-completed: []

coverage:
  - id: D1
    description: "Projector (D-05, D-06, D-20, Pitfall 12): the five new roots; backup-then-link for an identical real dir (copy, MANIFEST line per file, RESTORE `rm && cp -a` line, link via rename) and skip-warn real-dir-differs for a differing one (nothing copied or removed); agents link-new only for absent names, remove-own-link only for own links under the disable flag; muse root created 0755; repoint-only repoints exports links and adds none; cursor root active only with the enable flag; grok stray-real-dir deduped; --check counts backup-then-link and remove-own-link as drift and writes nothing."
    verification:
      - kind: unit
        ref: "SUBSTRATE_DISABLED=1 bun test packages/projector/src/skills.test.ts: 26 pass, 0 fail, 126 expect() (RED d6c3cd3: 0 pass, 1 fail — missing activeRoots export); with skills-sync.test.ts 38 pass, 0 fail"
        status: pass
    human_judgment: false
  - id: D2
    description: "Live projection: first run 132 actions (41 agents link-new, 41 muse link-new, 20 + 20 OpenClaw repoint, 10 grok backup-then-link) and 0 warnings; second run 0; --check exit 0; agents 41 links + 80 real untouched; muse 41 links; OpenClaw 0 exports links left, 30 links before and after; Grok 0 library-named real dirs, 10 backups with a verifying manifest; timer re-enabled and its first tick already current."
    verification:
      - kind: integration
        ref: "04-05-SMOKE.md keys; Task 2 <automated> verify (/tmp/0405-verify2.sh, identical to the plan's command): exit 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "Muse lists every library skill from ~/.config/muse/skills."
    verification:
      - kind: e2e
        ref: "timeout 60 muse-bin-1.4.0-R4161.1 skills list --source user --json: 123 skills, all 41 library ids with path $CONFIG_DIR/skills/<name>/SKILL.md; muse_lists_library=true"
        status: pass
    human_judgment: false
  - id: D4
    description: "Root suite and tsc two-sided green against 04-BASELINE.md with more passes than agent-substrate-pass."
    verification:
      - kind: other
        ref: "Task 1 <automated> verify (/tmp/0405-verify1.sh, identical to the plan's command): exit 0; bun test 503 pass, 0 fail (baseline 338/0); tsc-exit=0 both sides; failing-id sets equal (both empty)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Cursor does not list each library skill twice (research Q2 duplicate risk)."
    verification:
      - kind: manual_procedural
        ref: "Deferred to the owner's proof (Cursor / menu); D-20 flags ready: disable-agents-root, enable-cursor-root"
        status: pending
    human_judgment: true

duration: about 12 min (09:00Z–09:12Z)
completed: 2026-09-26
status: complete
---

# Phase 4 Plan 05: Cursor, Muse and OpenClaw projection; Grok identical copies Summary

**Cursor (through `~/.agents/skills`), Muse (`~/.config/muse/skills`, created) and both OpenClaw dirs now read the 41 library skills through links the 5-minute timer maintains; Grok's ten byte-identical real copies were backed up with a verifying manifest and replaced by links. Nothing an agent authored was overwritten.**
- One live run made 132 changes with 0 warnings; the second run and the timer's first tick were already current.
- Muse's own CLI lists all 41 library skills from its config dir.
- D-20 flags (`disable-agents-root`, `enable-cursor-root`) switch the Cursor roots without a code change; both are absent.

## Performance

- **Duration:** about 12 min
- **Started:** 2026-09-26T09:00Z
- **Completed:** 2026-09-26T09:12Z
- **Tasks:** 2 (Task 1 TDD, Task 2 live)
- **Files modified:** 3 in the repo plus this SUMMARY; on the host the route file, index row, snapshot, projector run dir and the links in five roots.

## Baselines (two-sided, against 04-BASELINE.md)

| Suite | 04-BASELINE (44bad2d) | After Task 1 (8cb0cad) |
|---|---|---|
| agent-substrate bun test | 338 pass, 0 fail | 503 pass, 0 fail |
| tsc (normalized) | tsc-exit=0 | tsc-exit=0 |

No failing-id set differs in either direction. Targeted: `skills.test.ts` 26 pass, 0 fail (with `skills-sync.test.ts` 38 pass).

## Accomplishments

- **Roots.** `agents` (`/root/.agents/skills`, cursor, disableFlag `/var/lib/substrate/skills/disable-agents-root`), `muse` (`/root/.config/muse/skills`, muse, create), `openclaw` and `openclaw-ws` (claude-code surface, repoint-only; payload.root names them), `cursor` (`/root/.cursor/skills`, enableFlag `/var/lib/substrate/skills/enable-cursor-root`). The grok root carries `GROK_KNOWN_REAL` (the ten 04-01 real entries that are not library names).
- **Actions.**
  - `backup-then-link`: identical real dir → `cp` to `<run>/<root-id>/<name>/`, every file hash-checked against its source, one `MANIFEST.sha256` line per file, RESTORE `rm '<path>' && cp -a '<backup>' '<path>'`, then the link. Identity is re-checked at apply time; a dir that changed in between is logged `changed-underfoot` and left alone.
  - `remove-own-link`: with the disable flag, links `<name>` → `<LIBRARY_DIR>/<name>` are removed (RESTORE `ln -sfn`), nothing else.
  - `skip-warn` reasons: `real-dir-differs` (replaces 04-04's `real-dir`), `foreign-link`, `stray-real-dir` (Pitfall 12).
- **Live.** Snapshot `04-05/20260926T090925Z` (198 rows, manifest OK) and RESTORE.d/04-05.md were written before the run. Run dir `projector/20260926T090952Z` holds 133 undo lines (82 rm, 40 ln -sfn, 10 rm && cp -a, 1 rmdir).

## Task Commits

1. **Task 1: Projector roots, backup-then-link, D-20 flags, Grok stray-dir warning**: `d6c3cd3` (test, RED), `8cb0cad` (feat, GREEN)
   - verify: `/tmp/0405-verify1.sh` (plan command verbatim) exit 0; tail `26 pass / 0 fail`; root suite 503 pass 0 fail; tsc set `tsc-exit=0` equal to baseline.
2. **Task 2: Live projection; timer back on**: `7573830` (docs, 04-05-SMOKE.md)
   - verify: `/tmp/0405-verify2.sh` (plan command verbatim) exit 0; tail `[projector] already current (claude, grok, agents, muse, openclaw, openclaw-ws)`, `active`.

**Plan metadata:** this SUMMARY commit (docs).

## Files Created/Modified

- `packages/projector/src/skills.ts`: new roots, modes, flags, actions, `sameTree`, `activeRoots`, `GROK_KNOWN_REAL`.
- `packages/projector/src/skills.test.ts`: one test per behaviour bullet plus the updated 04-04 tests.
- `.planning/phases/04-skills/04-05-SMOKE.md`: live evidence keys.
- Host only: RESTORE.d/04-05.md, RESTORE.md row, `04-05/20260926T090925Z`, `projector/20260926T090952Z`, `/root/.config/muse/skills`, links in `~/.agents/skills`, both OpenClaw dirs and `~/.grok/skills`.

## Decisions Made

See key-decisions above. In short: repoint-only only suppresses link-new; missing non-create roots are skipped; the disable flag removes only own links.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] RED test compared a sorted MANIFEST with an unsorted expectation**
- **Found during:** Task 1 (GREEN)
- **Issue:** the expected MANIFEST lines were in path order, the received ones sorted by hash.
- **Fix:** the expectation is sorted the same way.
- **Files modified:** packages/projector/src/skills.test.ts
- **Verification:** targeted tests 26 pass, 0 fail
- **Committed in:** 8cb0cad

**2. [Rule 2 - Missing] Existing 04-04 tests updated for the replaced behaviour**
- **Issue:** 04-04 tests pinned `real-dir` for identical real dirs and a two-root ROOTS list; this plan replaces both.
- **Fix:** identical dirs now expect `backup-then-link`; the warning/CLI tests use a differing Grok copy (`real-dir-differs`); the ROOTS test lists all seven roots.
- **Committed in:** d6c3cd3

---

**Total deviations:** 2 (test expectations)
**Impact on plan:** none on behaviour; no scope change.

## Issues Encountered

- The service tick after `systemctl start` of the timer logged systemd's `Failed to add … inotify watch descriptor … No space left on device` for the unit cgroup (inotify limit, not disk). The run finished successfully; the message predates this plan (10 lines for the unit, 843 host-wide earlier today).
- The 04-04 dedupe state keeps its 10 `grok:<name>:real-dir` keys; they are inert now.

## User Setup Required

None. The owner checks the Cursor `/` menu for duplicates in the proof; `touch /var/lib/substrate/skills/disable-agents-root` is the fallback (D-20).

## Next Phase Readiness

- Cursor, Muse, OpenClaw, Claude Code and Grok Build all follow the library on the timer. 04-07 (Hermes) and 04-08 (Omp) cover the config-based agents.

---
*Phase: 04-skills*
*Completed: 2026-09-26*
