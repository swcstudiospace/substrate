# Phase 22 Plan 02: bridge + monitor port — Summary

**Status:** complete. **Live effect:** none — production units untouched, no restarts.
**Commits:** `42cc713` (code), drain-auth fix + unit paths folded into `0d8f174`.

## Outcomes

- `packages/miner/src/substrate_miner/bridge.py` + `tests/test_bridge.py`: September bridge
  ported whole — pending-only reads, grouping by skill name, `QUIET_S` 120, propose-only
  repayable library skills in `created_at` order plus new-name foreground creates,
  hold-with-reason, differing-files-plus-SKILL.md payloads with remove lists,
  unlink-only-on-final (200 `opened|existing|unchanged|declined` or 400),
  keep on 401/5xx/transport/413/oversize, Omp + Grok drains, held-state + JSONL log.
- Auth rewritten to the token.ts order (`SUBSTRATE_TOKEN`, `SUBSTRATE_TOKEN_FILE`,
  tokens-dir per-surface file) with `Authorization: Bearer` per request, never logged,
  queued or placed in reasons. Zero `propose.key`/`PROPOSE_KEY` strings in the package.
- `monitor.py` + `test_monitor.py` ported verbatim (newest-100 transcripts + day, no
  timestamps). `__main__.py` ported with bearer wording.
- Root `test:py` script (`python3 -m pytest packages/miner/tests`, no venv): 52 pass.
- `infra/vps/substrate-skills-bridge.{service,timer}` staged with token-by-name carriage
  (`/etc/substrate/substrate-bridge.env`), path guards, release checkout, 5-minute schedule.
- `packages/miner/hermes/substrate-skill-miner-monitor.sh` ported (minor addition: the cron
  entry point the 22-03 rebind binds to).

## Deviations (auto-fixed)

- **[Rule 2] Per-surface drain auth (found in 22-04 rehearsal):** September's single key
  carried no surface, so one client drained every queue. Main's route answers 403 when the
  body surface differs from the token's (proven live against the twin). `__main__` now
  drains each queue with a client of the queued body's surface (pending groups stay
  `hermes`); pinned by `test_drain_client_resolves_the_queue_surface_bearer`.
- **[Rule 2] Release checkout + restored `PYTHONPATH`** (dropped in the first port,
  caught by the repo doctor): fixed in the bridge unit.

## Verification

`bun run test:py` 52 pass; propose-key grep gate clean over `src/` and `tests/`;
token-value grep clean; `bunx tsc --noEmit` clean (no TS touched).

## Self-Check: PASSED
