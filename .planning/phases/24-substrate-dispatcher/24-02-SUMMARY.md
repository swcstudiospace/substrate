# Phase 24 Plan 02: launch + watch + route port — Summary

**One-liner:** September's prompt/registry/tick/host modules on main with runtime
bearer carriage, restart-surviving give-ups, and Phase 17 outcome events.

**Tasks:** 3/3 (launcher+host, sessions+dispatch, four test files).
**Commits:** c05d601 (sources), 4d649b7 (tests).

## What was built

- `launcher.py`: the four prompt curls read the hermes token at session
  runtime via a `cat` of the tokens-dir file with a default-path fallback
  (path asserted against `token.ts`); stored prompt carries the path, never
  a value. Plus `hermes_bin`/`state_dir` routability (24-04 rehearsal need,
  additive).
- `host.py`: `HostClient` sends the substrate bearer on every request.
- `sessions.py`: `given_up.json` load (construction, before first tick) +
  save (0600, atomic replace) via `give_up()`; `_reap_one` give-up paths
  emit `dispatch.failed`.
- `dispatch.py`: `emit_launched`/`emit_failed` on the Phase 17 rows
  (note/warning, surface substrate, ids only, fail-open); tick emits once
  per freshly posted marker, `host-unreachable` emits nothing;
  `_comment_once` returns posted/skip.
- Tests: prompt secrecy (4 bearer curls, no value, no issue text),
  persistence round-trip + 0600, event rows + fail-open + no-double-emit,
  host bearer, planted lease-id leak sweep. Suite: 166 green.

## Deviations

- `make_launch_fn()` routes `state_dir`/`hermes_bin` (24-04 need found
  during rehearsal: without it the driver spawned real hermes into prod
  state — polluting files removed, hole closed).
- Emission helper skips doubles without `events_emit` support
  (`getattr(mcp, "call", None)`) so branch fakes stay untouched.

## Verification

`rg lease_id` clean; claim/release/complete calls exist only in the prompt
template; store-lock greps clean; `Bearer` sites exactly the two call
sites + template. Live effect: none.
