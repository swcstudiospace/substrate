# Phase 22 Plan 03: Omp extension and Hermes miner (SKILL-04/SKILL-05) Summary

**Phase:** 22-skills-sync-bridge-and-miners
**Plan:** 22-03
**Status:** complete
**Base:** gsd/v1.3-p22-execute @ 71aa3d7 (22-01 projector/sync + 22-02 miner bridge verified)
**September source:** commit be77187 (monitor 30 lines, monitor shell 2 lines, `__main__` 51 lines);
Omp extension at 741249b (251 lines + 287-line test); miner SKILL.md at 464b151 (68 lines)

## One-liner

September's Omp skill-creator interception and Hermes miner re-expressed on main: the extension
proposes with the `omp` bearer token (standalone Phase-20-order resolver, 403 now queues), the
monitor reads `SUBSTRATE_TRANSCRIPTS_DIR` when set behind a pinned-release launcher, and the miner
SKILL.md keeps its at-most-3 instruction with both write_approval flags untouched.

## What was ported

- `packages/projector/omp/substrate-skills.ts` (new dir under existing `packages/projector`) —
  September mechanics intact (create/update block with a PR-naming reason, learn strips the skill
  payload but keeps the lesson with the PR in `additionalContext`, delete and other tools pass
  through, 25 s abort, 0600 file in a 0700 dir, session_id provenance, never throws), re-expressed
  for v1.3:
  - D22-15: standalone copied resolver with Phase 20's full order for surface `omp`
    (`SUBSTRATE_TOKEN`, then the `SUBSTRATE_TOKEN_FILE` file, then `<tokens dir>/omp`), 4 KiB cap,
    surface validated, any read problem means no token, never throws, never logs. No import from
    the repo or Omp.
  - The retired `x-substrate-propose-key` header is gone (D21-01): the per-call token goes out
    only as `authorization: Bearer`, so the proposal's surface is the token's surface (D21-03).
  - Reply matrix aligned with the bridge (D22-10): 400/413 final (block, nothing queued); missing
    token, transport errors, timeouts, 401, **403** and 5xx queue the exact body. (September queued
    everything except 400/413/declined only implicitly — 403 fell into a final "answered HTTP"
    branch; here 403 queues as a surface-mismatch configuration error.)
- `packages/projector/omp/substrate-skills.test.ts` — September cases ported onto bearer auth plus
  new coverage: resolver order (direct > token-file > tokens dir, blanks skipped, unreadable means
  null), bearer-header assertion with a negative check for the retired header, 403 queues the exact
  body, missing-token queues without a request, and token-absent reasons/queues throughout.
  Fake fetch and tmp dirs only.
- `packages/miner/src/substrate_miner/monitor.py` — September logic verbatim (no timestamps,
  newest 100 by mtime listed sorted by id, plus `day <UTC date>`) plus `transcripts_dir()`:
  `SUBSTRATE_TRANSCRIPTS_DIR` when set and non-blank (Phase 19 hook convention), else the
  production default. `monitor_output()` takes an explicit dir or resolves the env at call time.
- `packages/miner/hermes/substrate-skill-miner-monitor.sh` (0755, 2 lines) — runs
  `python3 -m substrate_miner monitor` with `PYTHONPATH` under `/opt/agent-substrate/current` and
  `PYTHONDONTWRITEBYTECODE=1`, so Hermes suppresses the model run when the output is byte-identical
  to the previous tick.
- `packages/miner/skills/substrate-skill-miner/SKILL.md` — byte-identical to September (verified
  with diff): at most 3 skills per run through `skill_manage`, staged writes only, both approval
  flags respected, no live-checkout path.
- `packages/miner/tests/test_monitor.py` — September's 4 tests ported plus env-override pins
  (override selects the tmp dir end-to-end through `monitor_output(None, …)`, blank means default,
  default is the production path) and the D22-17 SKILL.md pins (at-most-3 + `skill_manage`
  present; no `/root/src/` or `/opt/agent-substrate` path).
- `packages/miner/src/substrate_miner/__main__.py` — two-line change: `_monitor()` resolves the
  directory through `transcripts_dir()` so the override works through the CLI. Bridge code paths
  untouched.

## Verification (for the parent)

- `python3 -m py_compile` clean on monitor.py, `__main__.py`, test_monitor.py.
- `diff` of the new SKILL.md against September is empty; `diff` of monitor.py against September is
  exactly the documented `transcripts_dir` addition.
- NOT run here per the wave contract: `bun test packages/projector/omp/substrate-skills.test.ts`,
  `bun run test:py`, `bunx tsc --noEmit`, `bun run check:phase-close`. Parent compares against the
  22-01 baseline per the plan.

## Deviations

- `monitor_output()` defaults its directory to `None` (resolve-via-env at call time) instead of
  September's `directory=TRANSCRIPTS` default, because the plan's assignment requires monitor.py
  itself to read `SUBSTRATE_TRANSCRIPTS_DIR` when set. Callers passing an explicit dir see
  September's behavior exactly; the `__main__.py` two-liner is the only caller updated.
- The SKILL.md pin tests live in `test_monitor.py` (the plan's first discretionary option) rather
  than a new `test_skills_md.py`, keeping the plan's file list exact.

## Threat flags

Covered by the plan's register, all tested: T-22-03-01 (never-logged/queued/reasoned token —
bearer header only, queued bodies asserted token-free), T-22-03-02 (block-or-queue on every
skill-writing tool; delete passthrough only), T-22-03-03 (byte-identical suppression +
at-most-3 pin).

## Commits

- feat(22-03): Omp extension with omp-token auth and block-or-queue (1c1d6ef)
- feat(22-03): monitor.py, monitor launcher, and monitor/SKILL.md pins (1256b00)
- feat(22-03): miner SKILL.md and monitor transcripts-dir wiring (02fad9f)

## Untouched by this plan

`packages/projector/src/skills.ts`, `skills.test.ts`, `skills-sync.ts`, `skills-sync.test.ts`
(22-01); `packages/miner/src/substrate_miner/bridge.py`, `token.py` (22-02 — reply behavior
unchanged); skill-autonomy and any Hermes configuration (D22-14/D22-18).
