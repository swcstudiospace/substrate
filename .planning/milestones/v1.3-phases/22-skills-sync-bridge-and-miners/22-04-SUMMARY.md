# Phase 22 Plan 04: rehearsal proof + live runbook — Summary

**Status:** complete short of the named gates. **Live effect:** none — twin only.
**Commit:** `0d8f174`.

## Outcomes

- `scripts/skills-sync-smoke.ts` + `smoke:skills-sync` entry + `scripts/skills-sync-smoke-bridge.py`
  driver: 18/18 checks green from a detached worktree against twin `p22` (`--skills-fixture`,
  port 17422, surfaces extended with grok-build) — (a) past-quiet group opened + unlinked with PR
  URL in the bridge log while the fresh group waited; (b) omp + grok bodies drained to
  opened and deleted, 401 body kept; (c) dirty/off-branch/diverged checkouts refused with
  exit 0, one log line + one warning each; (d) simulated owner merge → one tick `ff` →
  new-skill symlinks in claude + grok fixture roots holding only links; (e) all refusal
  warnings on surface `substrate` with rule-name-only payloads. Production-port/path grep
  gate clean; scratch removed in `finally`; twin torn down with containers removed.
- `docs/skills-sync-bridge-miners.md`: hygiene section (gated cache cleanup + ignore rule
  via owner PR + Phase 25 RAGFlow hook note) and the SKILL-07 live tail (real PR, owner
  merge + first tick, restarts + cron rebind, key deletion) — 9 OPERATOR-GATED markers,
  each with proof read and rollback. `docs/rehearsal.md` smoke list updated.
- `22-VALIDATION.md`: every SKILL-02..05/07 clause mapped to a real plan task or a named gate.

## Deviations (auto-fixed during the proof)

- **[Rule 2] Per-surface drain auth** (bridge `__main__` + driver `--surface` + smoke
  per-drain bearers): rehearsal proved a hermes-authed drain of an omp body answers 403.
- **Smoke robustness:** diverged fixture is local-only (never moves the fixture origin);
  `creates` asserted relative; PR lookup scoped to the run tag; expected roots derived
  from the library (reused twins accumulate merges); sorted-key assertion order fixed.
- **[Rule 2] Repo-gate compliance:** new units run from the release tree; doctor roster
  extended with per-unit env assertions; allowlist test fixture avoids scanner-tripping
  names (absence pinned by the source grep gate instead).

## Rehearsal evidence

Twin `p22` on 17422, fixture `rehearsal/agent-skills`, branch
`skill/hermes/smoke-mined-af9d51-…` opened → merged → `ff` → linked. Full 18-line
pass log in the phase report; run dir and containers removed.

## Gated-step inventory (all OPERATOR-GATED, none executed)

Real agent-skills PR; owner merge; production restarts (sync + bridge) + Hermes cron
rebind; skill-autonomy reinstall; Omp symlink repair; `/root/agent-skills` cleanup +
`.gitignore` PR; `/var/lib/substrate/skills/propose.key` deletion post-cutover.

## Self-Check: PASSED
