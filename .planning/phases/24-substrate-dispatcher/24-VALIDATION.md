# Phase 24 validation map (DISP-01..DISP-08)

Rehearsal evidence only. Every live step is OPERATOR-GATED (see
`docs/runbooks/dispatch-proof.md`, all steps NOT RUN).

| Requirement | Proof | Evidence |
| --- | --- | --- |
| DISP-01: 30 s supervised tick under flock; kill switch re-read per tick, defaults on | Unit: `test_main.py` (flock exit-3, `--once` refusal, re-read); smoke C4 (disabled tick contacts nothing) | `bun run smoke:dispatcher` 20/20 |
| DISP-02: every non-dispatch says why, once, from the marker set | Unit: `test_dispatch.py` once-only table; driver S8 (all refusal classes, duplicate tick silent) | driver 30/30 |
| DISP-03: per-Graph-ID worktree, verified origin, 5 GiB floor, reuse-or-create, never deletes | Unit: `test_worktree.py` matrix; driver S1 (real git worktree under tmp, cwd asserted) | driver 30/30 |
| DISP-04: `dispatch:hermes` launches a headless session in the graph worktree | Driver S1 (real argv/cwd/env/prompt assertions); smoke C1/C5 (launch decisions) | driver 30/30, smoke 20/20 |
| DISP-05: dispatcher never claims; session claims with its own hermes token | Structural (no claim/release/complete call in dispatch/sessions) + leak sweep S10 + prompt bearer-path test | unit 166, driver 30/30 |
| DISP-06: given-up set survives a restart | Unit round-trip; driver S3→S4 (give-up, fresh registry re-reads, never resolved) | unit 166, driver 30/30 |
| DISP-07: prompt carries ids only; issue text fetched at runtime as UNTRUSTED | Unit render assertions; driver S1/S10 prompt scans | unit 166, driver 30/30 |
| DISP-08: live proof | OPERATOR-GATED live tail — NOT RUN in this phase | `docs/runbooks/dispatch-proof.md` evidence table: NOT RUN |

## Suite baselines at validation time

- `python3 -m pytest packages/miner/tests packages/dispatcher/tests`: 218 passed
  (52 miner + 166 dispatcher).
- `bun run smoke:dispatcher`: 20/20 checks + driver 30/30 scenarios.
- `bun test`, `bunx tsc --noEmit`, `check:phase-close`: see phase-close report
  (failures at HEAD recorded, not fixed, per v1.3 operator rules).

## Live tail (all OPERATOR-GATED, none run)

1. Provision `/etc/substrate/substrate-dispatcher.env` — NOT RUN.
2. Bounded kill-switch-off window running `docs/runbooks/dispatch-proof.md`
   verbatim, ending with the switch back to `1` — NOT RUN.
3. Production restart of `substrate-dispatcher.service` + manifest flip
   `dormant:24` → `live` — NOT RUN.
4. One-time `/var/lib/substrate/dispatcher/` state review — NOT RUN.
