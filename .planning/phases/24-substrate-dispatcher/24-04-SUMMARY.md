# Phase 24 Plan 04: rehearsal proof + docs + gated live tail — Summary

**One-liner:** DISP-08 proven in rehearsal (smoke 20/20 + driver 30/30, zero
production contact) with the live proof scripted as explicit OPERATOR-GATED steps.

**Tasks:** 3/3 (tracer smoke, docs+runbook, gated tail+validation).
**Commits:** 96c2495 (seams), d1de97a + 431c8db (driver 30/30), 86ebe2c
(smoke 20/20), 9da0b99 (docs + validation map).

## What was built

- `scripts/dispatcher-smoke.ts` (`bun run smoke:dispatcher`): CLI layer —
  real `--once --dry-run` against loopback Linear/MCP fakes (C1 decisions +
  wire auth, C2 refusal classes, C3 WR-04 refusal + zero contact, C4 kill
  switch + zero contact, C5 dual-label) — then the driver. Guards: tmp-only
  run dir, ephemeral ports (7410/7411 refused via `refuseTarget`), random
  scratch keys.
- `scripts/dispatcher-driver.py`: real tick/reap/launch, real git
  worktrees, real hermes spawn into a shell-script fake, MockTransport
  fakes — S1 launch argv/cwd/env/prompt, S2 landed success, S3
  exit-unclaimed, S4 restart persistence, S5 timeout→SIGKILL, S6 slow
  claim (02-08), S7 invalid-ids, S8 marker vocabulary, S9 double-launch
  matrix, S10 leak sweep. 30/30, zero prod contact asserted.
- Docs: `docs/dispatcher.md`, `docs/runbooks/dispatch-proof.md`
  (evidence NOT RUN), production-identity live tail (staged, not applied),
  `24-VALIDATION.md` (DISP-01..08 bindings).

## Deviations (approved)

- Dedicated loopback fakes instead of the Phase 16 harness twin
  (mirror-smoke precedent): the dispatcher's only externals are Linear
  GraphQL + MCP JSON-RPC; the harness's Postgres + real MCP add weight
  without covering the Linear half. Twin-port/detached/fakes-only intent
  fully honored.
- Rehearsal seams (additive, defaults identical): `SUBSTRATE_LINEAR_URL`
  (origin), `SUBSTRATE_STATE_DIR`, `hermes_bin`/`state_dir` routing.
- One real-hermes-into-prod-state incident during driver development
  (missing routing); polluting files removed, September files untouched,
  hole closed by the seams; driver asserts tmp-only roots.

## Verification

`bun run smoke:dispatcher` 20/20 + driver 30/30; OPERATOR-GATED nonzero
on all three doc surfaces; no production paths touched. Live effect: none
— every live step stops at an explicit gate.
