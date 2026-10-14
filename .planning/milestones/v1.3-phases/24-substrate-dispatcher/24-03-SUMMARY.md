# Phase 24 Plan 03: loop + packaging + staged unit — Summary

**One-liner:** The supervised `python3 -m substrate_dispatcher` loop wired to the
registry, packaged for the host python, with the production unit staged inert.

**Tasks:** 3/3 (loop+tests, packaging+test:py, staged unit).
**Commits:** 5f32e84 (loop), 2269cd4 (pyproject), 958edde (test:py +
smoke entry), c53e2e1 (unit).

## What was built

- `__main__.py` verbatim except one warranted wiring line:
  `SessionRegistry(state_dir=STATE_DIR)` so `given_up.json` is re-read
  before the first tick. (An edit accident once dropped the `launch_fn`
  line, breaking 2 tests; restored and amended — diff vs branch is exactly
  the wiring line.)
- `pyproject.toml` verbatim. Root `test:py` covers miner + dispatcher
  (218 combined green); root `pyproject.toml` `pythonpath` resolves both
  src dirs while single-package runs keep their own ini.
  `smoke:dispatcher` entry fails loudly without its script (verified).
- `infra/vps/substrate-dispatcher.service`: per-unit
  `EnvironmentFile=/etc/substrate/substrate-dispatcher.env` (names only),
  `SUBSTRATE_ENV_FILE` pointed at the same file, `ConditionPathExists` on
  the entry point per the Phase 16 guard convention. Production unit
  untouched; activation is a gated operator step.

## Deviations

- Combined `test:py` needed the root `pyproject.toml` path config — the
  plan's literal "append the path" broke collection (each package's
  `pythonpath` resolves only under its own rootdir). Additive, inert for
  single runs.

## Verification

`test_main.py` 11 green; combined 218 green; unit content greps
(EnvironmentFile ×1, ConditionPathExists, no secret values);
`git status` shows no production paths. Live effect: none.
