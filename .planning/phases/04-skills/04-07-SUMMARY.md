---
phase: 04-skills
plan: 07
subsystem: infra
tags: [skills, hermes, write-approval, external-dirs, bridge, miner, cron, systemd, timer, d-05, d-07, d-10, d-13, sc-3, sc-4, sc-5, w2, w3, w4, w5, w6, w11]

requires:
  - phase: 04-skills
    provides: 04-01 04-BASELINE.md and /var/lib/substrate/phase4-baseline; 04-02 clean /root/agent-skills checkout; 04-03 POST /skills/propose, propose key, queued-proposal contract; 04-04 substrate-skills-sync timer and the merged library skill substrate-skill-miner
provides:
  - packages/miner — bridge.py (load_pending, group_by_name, ready, replay, hermes_local_names, classify, proposal_for, base_tree, ProposeClient, run_once, drain_queue, resolve_hint), monitor.py (monitor_output), __main__.py (`bridge --once`, `monitor`), hermes/substrate-skill-miner-monitor.sh, 50 pytest tests
  - infra/vps/substrate-skills-bridge.{service,timer} installed in /etc/systemd/system, timer enabled (OnBootSec=3min, OnUnitActiveSec=5min, AccuracySec=30s)
  - live Hermes config — skills.write_approval=true, memory.write_approval=true (set before) skills.external_dirs=[/root/agent-skills]; 33 shadowing links removed; research/anda-ecosystem moved to the backup
  - Hermes cron job substrate-skill-miner (0c172431cf5b, `0 * * * *`, --skill substrate-skill-miner, --monitor-script substrate-skill-miner-monitor.sh, --workdir the repo)
  - host state — /var/lib/substrate/miner/{bridge-log.jsonl, bridge-held.json}, RESTORE.d/04-07.md and its RESTORE.md index row, snapshot 04-07/20260926T090500Z
  - PR agent-skills#5 (OPEN, one file substrate-skill-miner/SKILL.md) opened by the bridge timer from a gate-staged Hermes write
affects: [04-12]

actuals:
  tokens: 4400       # chars/4 over the added lines of packages/miner, the two units and 04-07-SMOKE.md
  tasks: 3
  commits: 5         # ebaae88, 09000ea, be77187, 558cf8d + this SUMMARY
plan_head_before: feed65f

tech-stack:
  added: []
  patterns:
    - "Close the write window before opening it: write_approval on (epoch recorded) before external_dirs exposes the live checkout; RESTORE clears external_dirs before write_approval"
    - "Bridge scope is a classifier over (library names, Hermes-local names, first record's action/origin): only library skills and new foreground creates are proposed; everything else is held with one logged reason and a resolve hint"
    - "Proposals carry only changed files plus SKILL.md and an explicit remove list, so the 04-03 overlay keeps every file the replay did not touch"
    - "Held state is deduped per (record id, reason) and pruned when the record file disappears, so a 5-minute timer logs each hold once"

key-files:
  created:
    - packages/miner/pyproject.toml
    - packages/miner/src/substrate_miner/__init__.py
    - packages/miner/src/substrate_miner/__main__.py
    - packages/miner/src/substrate_miner/bridge.py
    - packages/miner/src/substrate_miner/monitor.py
    - packages/miner/tests/test_bridge.py
    - packages/miner/tests/test_monitor.py
    - packages/miner/hermes/substrate-skill-miner-monitor.sh
    - infra/vps/substrate-skills-bridge.service
    - infra/vps/substrate-skills-bridge.timer
    - .planning/phases/04-skills/04-07-SMOKE.md
    - /etc/systemd/system/substrate-skills-bridge.{service,timer} (host)
    - /root/.hermes/scripts/substrate-skill-miner-monitor.sh (host, real file)
    - /var/lib/substrate/phase4-baseline/RESTORE.d/04-07.md (host)
  modified:
    - /root/.hermes/config.yaml (skills.external_dirs, skills.write_approval, memory.write_approval)
    - /root/.hermes/cron/jobs.json (job substrate-skill-miner)
    - /root/.hermes/skills (33 links removed, research/anda-ecosystem moved out)
    - /var/lib/substrate/phase4-baseline/RESTORE.md (index row for 04-07)

key-decisions:
  - "Patch replay is exact-match only (Pitfall 6): a miss is held with reason `patch did not apply`, never guessed."
  - "classify also holds `multi-skill-batch` (a batch spanning several names) and `invalid-name` (fails SKILL_NAME_RE) — both cannot become one valid proposal."
  - "A held oversize group is not re-posted on later ticks (every record already held as oversize); a new record in the group changes that."
  - "drain_queue also rejects unreadable JSON and bodies over the 1 MB cap to rejected/ (both would be final 400/413 anyway)."
  - "The held-local probe skill is the first sorted `<category>/<name>` real dir that is not a library name: aceternity-template-sites."

patterns-established:
  - "Host callers of /skills/propose read the key per request and treat 401/unreadable as keep-and-exit-1, 413 as hold/rejected, 200 declined and 400 as final"

requirements-completed: []

coverage:
  - id: D1
    description: "D-05/D-07/W11: write_approval ×2 on (1790413526) before external_dirs set (1790413572); a foreground library patch was staged (c57bb33b) and discarded; 33 links (20 exports + 13 library) removed after a listing backup; anda-ecosystem moved after an empty diff; Hermes lists all 41 library names; checkout clean before and after."
    verification:
      - kind: integration
        ref: "04-07-SMOKE.md Task 1 keys; Task 1 <automated> verify exit 0 (re-run after Task 3: exit 0)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Bridge, queue drain and precheck (D-10, D-13, W2, W3, W4, W11) pinned by pytest: skills-only load, grouping, quiet period, replay of every action, skip reasons, local-name scan, classify, changed-files proposals, every reply disposition, held dedupe/prune, resolve hints (never approve for a library skill), queue drain dispositions and surface check, monitor determinism."
    verification:
      - kind: unit
        ref: "cd packages/miner && python3 -m pytest -q: 50 passed (RED committed first in 09000ea)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Live: gate-staged library patch 0d81c9ec became PR agent-skills#5 (one file, substrate-skill-miner/SKILL.md) on the timer's 09:19:38Z tick; the Hermes-local record 06be4fb3 was held (hermes-local) by the same tick, then discarded through discard_pending; pending memory 3 → 3; no local write; library clean; 0 dirty refusals in the sync journal since plan start."
    verification:
      - kind: e2e
        ref: "04-07-SMOKE.md Task 3 keys; Task 3 <automated> verify exit 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "SC-5 binding (W5): job 0c172431cf5b bound to the monitor shim in jobs.json, created 2026-09-26T19:14:26+10:00, next run 20:00+10:00; no manual cron run."
    verification:
      - kind: integration
        ref: "04-07-SMOKE.md cron_* keys; Task 3 verify reads jobs.json"
        status: pass
    human_judgment: false
  - id: D5
    description: "Root suite, tsc and dispatcher pytest two-sided green against 04-BASELINE.md."
    verification:
      - kind: other
        ref: "Task 2 verify: bun 503 pass / 0 fail (baseline 338), tsc-exit=0, dispatcher 149 passed (baseline 149); no failing-id set differs"
        status: pass
    human_judgment: false

duration: 20m (09:04Z–09:24Z)
completed: 2026-09-26
status: complete
---

# Phase 4 Plan 07: Hermes projection, pending-skill bridge and the hourly miner Summary

**Hermes now reads the library through `skills.external_dirs`, cannot write it (write_approval was on first), and its staged skill writes become library PRs via a 5-minute bridge timer. The first one, agent-skills#5, changed exactly one file.**

- Write window closed before it opened: `write_approval` (skills and memory) on at 1790413526, `external_dirs` set at 1790413572. A foreground `skill_manage` patch on objective-dev-loop (library only) was staged, not written, then discarded.
- 33 shadowing links removed (20 into the docs-scraper exports, 13 into /root/agent-skills); `research/anda-ecosystem` moved to the backup after an empty diff. `hermes skills list`: 160 → 167 local, all 41 library names listed (1854 → 2296 ms).
- `packages/miner`: the bridge proposes only library skills and new foreground creates, sends changed files + SKILL.md + a remove list with the host propose key, and holds everything else with a resolve hint. It also drains the Omp and Grok queues. 50 tests.
- Cron job `substrate-skill-miner` (0c172431cf5b) runs `0 * * * *`, bound to the real-file monitor shim; no manual run.

## Performance

- **Duration:** about 20 min (09:04Z–09:24Z), including a 4.5-minute wait for the bridge timer.
- **Tasks:** 3 (Task 2 TDD).
- **Files:** 11 in the repo plus this SUMMARY; on the host the units, the shim, Hermes config/jobs/skills, RESTORE.d/04-07.md and its index row, the snapshot and the bridge state files.

## Baselines (two-sided, against 04-BASELINE.md)

| Suite | 04-BASELINE | After Task 2 (be77187) |
|---|---|---|
| agent-substrate bun test | 338 pass, 0 fail | 503 pass, 0 fail |
| tsc (normalized) | tsc-exit=0 | tsc-exit=0 |
| dispatcher pytest | 149 passed | 149 passed |
| miner pytest (new) | — | 50 passed, 0 failed |

No failing-id set differs in either direction. Bun's count includes sibling wave-4 plans' tests.

## Task Commits

1. **Task 1: write_approval first, external_dirs, links, anda**: `ebaae88` (docs, SMOKE Task 1)
2. **Task 2: packages/miner bridge, queue drain, precheck, units**: `09000ea` (test, RED), `be77187` (feat)
3. **Task 3: routes, cron job, bridge timer, live PR and held local write**: `558cf8d` (docs, SMOKE Task 3)

## Verify results

- Task 1 `<automated>`: exit 0 (and exit 0 again after Task 3).
- Task 2 `<automated>`: exit 0 — miner 50 passed; tsc set equal; bun failing set empty = baseline, 503 ≥ 338; dispatcher failing set empty = baseline, 149 ≥ 149.
- Task 3 `<automated>`: exit 0 (`systemctl is-active` printed `active`).

## Deviations from Plan

- **Verify runner:** the extracted `<automated>` commands were first run with `set -o pipefail` prepended (my wrapper, not the plan); `hermes config get … | grep -q` then failed on SIGPIPE. Re-run as written (no pipefail): exit 0. No code change.
- **skills_list timing:** the first "before" run was in a narrow terminal (2772 ms, names truncated); the recorded before/after values both use `COLUMNS=250` so names can be matched. Noted in SMOKE.
- **Extra hold reasons** `multi-skill-batch` and `invalid-name` (see key-decisions): beyond the plan's list, both are held, never proposed.

## Issues Encountered

- systemd logs "Failed to add … inotify watch descriptor … No space left on device" when the bridge unit starts (host inotify watch limit). The unit runs and finishes normally; not addressed here.

## Gaps

- PR agent-skills#5 is OPEN for the owner (D-16); never merged here.
- The cron job has not ticked yet; 04-12 Task 1 reads back its scheduled, suppressed ticks.
- The held-local probe was a no-op patch; it proves the hold path, not a real local-skill edit.

## Next

- 04-12: read back the `substrate-skill-miner` scheduled ticks (monitor output `day 2026-09-26` until transcripts exist under /var/lib/substrate/transcripts/cursor from 04-11); PR #5 in the preflight list.

## Self-Check: PASSED

- FOUND: packages/miner/src/substrate_miner/{bridge,monitor,__main__}.py, tests, shim, infra/vps/substrate-skills-bridge.{service,timer}, 04-07-SMOKE.md
- FOUND commits: ebaae88, 09000ea, be77187, 558cf8d
- FOUND host: /etc/systemd/system/substrate-skills-bridge.timer (active), /root/.hermes/scripts/substrate-skill-miner-monitor.sh (regular file), RESTORE.d/04-07.md (routes 1–6)
