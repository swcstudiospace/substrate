# Phase 22 Plan 04: Units, read-only doctor, identity rows and skills-plane docs Summary

**Phase:** 22-skills-sync-bridge-and-miners
**Plan:** 22-04
**Status:** complete
**Base:** gsd/v1.3-p22-execute @ c370812 (22-03 miner and Omp extension verified)
**September source:** commit acc30a8 (sync service 29 lines + timer 12 lines, bridge service 34 lines + timer 12 lines)

## One-liner

September's skills units re-expressed on the pinned release with per-unit
drop-ins, a read-only six-area skills doctor behind `bun run skills:doctor`,
the sync/bridge/omp-extension identity rows moved live, and the skills-plane
doc plus README/propose edits that make the L1-L8 cutover mechanical.

## What was built

- `infra/vps/substrate-skills-sync.service` + `.timer` — September mechanics
  intact (oneshot tick, dirty/branch/diverged refusals, ff-only merge, then
  projection; `HOME=/root` for gh's stored credential), re-expressed per
  D22-19: `WorkingDirectory=/opt/agent-substrate/current`,
  `ConditionPathExists` on the release `skills-sync.ts` entry,
  `StartLimitIntervalSec=0`, no `substrate.env` load; timer keeps
  `OnUnitActiveSec=5min`, `AccuracySec=30s`, `OnBootSec=2min`.
- `infra/vps/substrate-skills-bridge.service` + `.timer` — same treatment for
  `python3 -m substrate_miner bridge --once`, plus release `PYTHONPATH` and
  `PYTHONDONTWRITEBYTECODE=1` (a release tree is immutable) and the
  `ConditionPathExists` guard on the miner `__main__`; timer keeps the 5 min
  tick with `OnBootSec=3min`.
- Two drop-ins (`*.service.d/10-environment.conf`) pointing at
  `/etc/substrate/skills-sync.env` and `/etc/substrate/skills-bridge.env`
  (root-owned, mode 0600, names only in the README); the bridge drop-in states
  the no-single-token rule.
- `scripts/doctor-units.ts` — `shared-env` now covers every non-`substrate-mcp`
  unit (previously collectors only), so a skills tick loading the shared
  server env is a finding (T-22-04-02). `python3 -m` entry handling already
  covered the bridge module shape.
- `scripts/doctor-units.test.ts` — the repo-units test keeps all four release
  units (mcp, grok, herdr, muse assertions intact) and adds both skills
  services with their env files and release `PYTHONPATH`; a new `skills units`
  block covers the bun and `python3 -m` entries, the shared-env finding with
  drop-in reset, the bridge no-single-token-variable assertion over the repo
  files, and the timers' 5 min/30 s/boot-delay pins.
- `scripts/skills-doctor.ts` (`bun run skills:doctor`, wired in
  `package.json` with a one-line diff) — six read-only areas per D22-21:
  library checkout (clean modulo D22-02, on `main`, ahead/behind local
  `origin/main` refs, no fetch ever), projection drift via `skills.ts --check`
  (argv, never a shell), the Omp link target, both Hermes approval flags from
  `~/.hermes/config.yaml`, the monitor script copy against the release file,
  and the bridge env-file rule. Never calls systemd, GitHub or the substrate,
  never prints a value, exits 1 on any finding. Seams: the existing
  `SUBSTRATE_SKILLS_LIBRARY` override plus `HOME` and
  `SUBSTRATE_SKILLS_BRIDGE_ENV`.
- `scripts/skills-doctor.test.ts` — tmp fixture repos with no remote (any
  fetch would fail, proving local-refs-only), tmp HOME fixtures, planted
  secrets proving findings name variables/flags/paths but never values, and
  exit-code coverage (0 green, 2 usage).
- `infra/identity/clients.json` — `skills-sync` and `bridge` moved
  dormant-to-live keeping the base's env-file row shapes; the bridge evidence
  records the no-single-token rule; new live `omp-extension` tokens-dir row
  for surface `omp`. `miner` stays dormant (not a D22-22 row).
- `docs/skills-plane.md` — flow, roots table, refusal/warning rules,
  final/non-final replies, token sources per client, state files, overrides,
  units/env section, and the L1-L8 cutover/rollback runbook.
- `infra/vps/README.md` — six-unit table with both skills drop-ins, skills env
  file names (bridge file never defines a single-token variable),
  timers-follow-current with rollback and no timer restart on deploy, and the
  Code paragraph resolved (skills code is on `main` via plans 22-01–22-03).
- `docs/skills-propose.md` — new Clients section (bridge surfaces, Omp
  extension, skill-autonomy staging). `docs/collectors.md` untouched: it never
  names the transcripts consumer.

## Verification (for the parent)

- NOT run here per the assignment contract: `bun test
  scripts/doctor-units.test.ts scripts/skills-doctor.test.ts`, `bunx tsc
  --noEmit`, `bun run check:phase-close`. Parent runs these and compares
  against the 22-01 baseline per the plan.
- Checked by inspection instead: all four unit entries resolve to files
  tracked in HEAD (`skills-sync.ts`, miner `__main__.py`); `git diff`
  confirms `deploy-release.sh`, the projector/bridge/omp sources and the
  forbidden files below are untouched; `package.json` diff is exactly the one
  added line; no doc spells a token variable as an assignment with a path
  (grep-clean); nothing pushed (branch ahead by 3, no push performed).

## Deviations

- One accidental edit landed on the main checkout
  (`/root/src/repos/agent-substrate/scripts/doctor-units.ts`, relative-path
  resolution in the edit tool) and was reverted immediately with `git
  checkout`; the worktree carries the intended change. Lesson for this
  worktree: always use absolute paths in edit patch headers.
- `bridgeEnvFindings` takes the env-file path as an explicit argument rather
  than only reading `paths.bridgeEnvFile`, so the rule is unit-testable
  without a paths struct; `doctor()` wires the real path.

## Threat flags

Covered by the plan's register, all tested: T-22-04-01 (names-only env files;
never-prints-a-value doctor with planted-secret tests; spelling-rule grep);
T-22-04-02 (per-unit env files, no `substrate.env` load, shared-env finding
covers the new units).

## Commits

- feat(22-04): skills sync and bridge units with drop-ins and doctor coverage (a48beac)
- feat(22-04): read-only skills doctor with tests and npm script (2f87193)
- feat(22-04): live identity rows plus skills-plane and README edits (941ec6f)

## Untouched by this plan

`packages/projector/src/skills.ts`, `skills-sync.ts` (22-01);
`packages/miner/src/substrate_miner/bridge.py`, `token.py`,
`packages/projector/omp/substrate-skills.ts` (22-02/22-03);
`infra/vps/deploy-release.sh` (default unit list and `-m` handling unchanged);
22-05 (smoke) and 22-06 (live runbook) not started. No live system touched: no
`/etc/substrate` files created, no systemctl calls, no docs-refresh hook.
