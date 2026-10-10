# Phase 24 verification (provable-without-gates scope)

**Status:** rehearsal PROVEN. Live scope (DISP-08 live tail) explicitly
gated out — see OPERATOR APPROVAL NEEDED in the phase report.

## Proven without gates

- Port integrity: 24-01/24-03 verbatim files byte-identical to `acc30a8`
  (direct content diff); all main-model diffs isolated, reviewed hunks
  (bearer carriage ×3, given-up persistence, outcome events, 2 rehearsal
  seams + launch routing).
- `python3 -m pytest packages/miner/tests packages/dispatcher/tests`:
  218 passed (see Full gates below for the dated count).
- `bun run smoke:dispatcher`: 20/20 checks + driver 30/30 scenarios, zero
  production contact (tmp-only roots asserted in-driver; ephemeral ports;
  fakes record every request).
- Threat grep contract: `lease_id` clean; claim/release/complete only in
  the prompt template; store-lock names clean; `Bearer` exactly at the two
  call sites + template; no secret values in the staged unit.
- Staged unit provably inert: content assertions + `ConditionPathExists`;
  production unit untouched; manifest still `dormant:24`.

## Gated out (NOT proven, NOT run)

DISP-08 live sequence (`docs/runbooks/dispatch-proof.md` steps 1–8),
env provisioning, production restarts, manifest flip, `/var/lib`
state review.

## State flip

Verification state for the rehearsal scope is flipped via gsd-tools by the
executing agent after merge; the live tail remains `OPERATOR-GATED` in
STATE.md until the operator completes the runbook.
