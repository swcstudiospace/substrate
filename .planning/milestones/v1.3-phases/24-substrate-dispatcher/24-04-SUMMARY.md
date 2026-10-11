# Phase 24 Plan 04: rehearsal proof + docs + gated live tail — Summary

**One-liner:** DISP-08 proven in rehearsal (smoke 20/20, driver exit 0, zero
production contact) with the live proof scripted as explicit OPERATOR-GATED steps.

**Tasks:** 3/3 (tracer smoke, docs+runbook, gated tail+validation).
**Commits:** 96c2495 (seams), d1de97a + 431c8db (driver green), 86ebe2c
(smoke 20/20), 9da0b99 (docs + validation map), plus the Greptile-review
follow-ups below.

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
  matrix, S10 leak sweep. Driver exit 0, zero prod contact asserted.
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

## Greptile review triage (PR #47, 13 comments — 10 fixed, 3 deferred)

Fixed: unit bearer var read first (P1 ship-blocker); lease_id retention +
heartbeat in the prompt (P1 ×2, lease-model call sites per D24-01);
already-claimed honors the lease view + landed-claim expiry check (P1);
one-session-per-graph guard (P1); tokens-dir child passthrough (P1);
unstored-outcome logging (P2); persistence failure logging (P2); runbook
idle-start step (P2); S5 trap-ready + returncode -9 (P2).

Deferred (genuine, out of port scope — plan locks the branch shape):
poll pagination (DISPATCH_QUERY shape locked by 24-01); Linear-write
persistence beyond the label-removal retry queue; worktree branch
re-verification on reuse (registration fails closed per D24-13).

## Verification

`bun run smoke:dispatcher` 20/20, driver exit 0; OPERATOR-GATED nonzero
on all three doc surfaces; no production paths touched. Live effect: none
— every live step stops at an explicit gate.
