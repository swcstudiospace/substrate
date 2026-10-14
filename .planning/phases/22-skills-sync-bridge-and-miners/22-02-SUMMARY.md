# Phase 22 Plan 02: Miner bridge (SKILL-03) Summary

**Phase:** 22-skills-sync-bridge-and-miners
**Plan:** 22-02
**Status:** complete
**Base:** gsd/v1.3-p22-execute @ 3ea2fad (docs-only verification note on top of 76d0780)
**September source:** commit be77187 (bridge 598 lines, tests 523 lines, `__main__` 51 lines)

## One-liner

September's Hermes pending-skill bridge re-expressed on main: grouping, replay,
120 s quiet and held-record logging intact behind per-surface bearer tokens
(hermes/omp/grok-build), a final-only deletion matrix and a mutating-nothing
dry-run.

## What was ported

- `packages/miner/pyproject.toml` — September packaging verbatim (`pythonpath src`).
- `packages/miner/src/substrate_miner/__init__.py` — package docstring, updated to Phase 22.
- `packages/miner/src/substrate_miner/token.py` (new split, at the plan's discretion) —
  mirrors Phase 20 `packages/cli/src/token.ts` order for the tokens dir only:
  `<SUBSTRATE_TOKENS_DIR or /etc/substrate/tokens>/<surface>`, first line,
  4 KiB cap, surface validated against `^[a-z0-9][a-z0-9-]{0,63}$`, any error
  means no token, values never logged (module has no logging at all).
  `single_token_refusal()` names `SUBSTRATE_TOKEN` / `SUBSTRATE_TOKEN_FILE`
  (never a value) so the bridge can refuse exit 1 while one is set.
- `packages/miner/src/substrate_miner/__main__.py` — September 51-line dispatch
  ported as-is (lazy `monitor` import; `monitor.py` lands in 22-03) plus
  `bridge --once --dry-run`; refusal line goes to stderr naming the variable.
- `packages/miner/src/substrate_miner/bridge.py` — September mechanics kept
  (pending/skills only, never pending/memory; group by name; 120 s quiet;
  library-skill replay onto the library copy; new names need a foreground
  create first; held reasons to `bridge-held.json` / `bridge-log.jsonl`;
  changed-files-plus-SKILL.md plus remove list), re-expressed for v1.3:
  - D22-09: per-surface `Authorization: Bearer` tokens resolved per request;
    `resolve_surface_tokens()` covers hermes/omp/grok-build.
  - D22-10: final replies (200 opened/existing/unchanged/declined, 400 refused
    with rule names) delete; 413/over-cap holds Hermes groups as oversize and
    moves queue files to `rejected/`; transport errors, no token, 401, 403,
    502, 503, other statuses and the `dry_run` status keep everything; 401,
    403 and missing token end the tick with exit 1.
  - D22-11: queue quiet enforced by file mtime.
  - D22-12: dry-run posts `dry_run: true`, prints one line per group/file
    (name, surface, classification, record ids, reply status), writes no log,
    no held state, no deletes/moves.
  - D22-13: hint names the `substrate skills propose` command and the hermes
    token file in prose (no `SUBSTRATE_TOKEN*=<path>` spelling anywhere);
    library skills still never `/skills approve`d.
- `packages/miner/tests/test_bridge.py` — September cases ported onto bearer
  auth plus new tests for D22-09 (per-surface selection, both refusal
  variables, exit 1 without the value), D22-10 (per-status delete/keep matrix
  for ticks and queues, mid-tick token loss), D22-11 (young queue file kept),
  D22-12 (dry-run posts `dry_run: true`, filesystem untouched).
- `package.json` — one-line addition: `"test:py": "python3 -m pytest packages/miner"`.

## Verification (for the parent)

- `python3 -m py_compile` clean on all five Python files; `python3 -m
  substrate_miner --help` dispatches; package.json diff is the one added line.
- NOT run here per the wave contract: `bun run test:py`, `bunx tsc --noEmit`.
  51 tests (plus parametrization) use injected `httpx.MockTransport` and tmp
  dirs only; no test references a production path outside a seam default.

## Deviations

- `__main__.py` keeps September's `monitor` subcommand (lazy import, broken
  only if invoked) even though `monitor.py` lands in 22-03, because 22-03 does
  not touch `__main__.py` — the alternative was a 22-02-only CLI surface that
  22-03 could never extend without an unplanned edit.
- Mid-execution I twice applied test edits at stale line numbers and repaired
  both immediately (`log_lines`/`lib_patch`, two `proposal_for` tests); the
  final file compiles and holds 51 tests. No product-code impact.

## Threat flags

None beyond the plan's register: T-22-02-01 (never-logged per-surface tokens
+ refusal, tested), T-22-02-02 (mtime quiet, tested), T-22-02-03 (final-only
deletion matrix, tested).

## Commits

- 9d798a5 feat(22-02) skeleton/token/entry/test:py
- 1142909 feat(22-02) bridge.py
- 9a6693f feat(22-02) test_bridge.py

## Untouched by this plan

`packages/projector/src/skills.ts`, `skills.test.ts`, `skills-sync.ts`,
`skills-sync.test.ts` (22-01); `monitor.py` and the Omp extension (22-03).
