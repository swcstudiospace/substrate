# Phase 24 Plan 04: Dial-Only Claude-Code Branch, Dispatcher Unit, Bun Docs — Summary

**Commit:** `775d5ef` — `feat(24-04): dial-only claude-code branch, dispatcher unit, Bun docs`
**Date:** 2026-10-09. **Requirement:** DISP-04. **Status:** complete.

## One-liner

`dispatch:claude-code` is now a connect-only TCP dial of 127.0.0.1:7411 that
sends nothing, the dispatcher ships an installable systemd unit with its own
env file that the doctor accepts, and `docs/ci.md` names Bun instead of pytest.

## What was built

**Dial-only launcher** (`packages/dispatcher/src/launch-claude-code.ts`).
`dialClaudeCodeHost` dials 127.0.0.1:7411 with a 1000 ms budget through an
injectable `ClaudeCodeConnect`, so tests never open real sockets. It sends
zero bytes and drops anything the peer writes. ECONNREFUSED or timeout is
`host-unreachable`; an accepted dial (only a test double can answer today)
is `host-refused`. No `/tasks` route, no HTTP body, no `openTask`, no
Docker, no rivet, nothing under `packages/host/src`.

**Tick wiring** (`packages/dispatcher/src/tick.ts`). `dispatchIssue` answers
`dispatch:claude-code` via a new `dispatchClaudeCode` step right after the
given-up check: dial, post the once-only marker through the plan 24-01
machinery, emit the vocabulary-closed failure event keyed by Linear
identifier. Both outcomes skip the given-up set, keep the label, and touch
no worktree, no spawn, no `graph_find`. All other non-hermes surfaces still
defer silently. `TickDeps.dialClaudeCode` is required, so a missing seam is
a compile error rather than a surprise real socket.

**Entry** (`packages/dispatcher/src/index.ts`). The smallest runnable unit
the service ExecStarts: re-reads the kill switch from
`/etc/substrate/dispatcher.env` via `isDispatchDisabled`, takes the
in-process flock, runs one tick. Disabled and lock-busy return for an
exit-0; only a thrown tick error exits non-zero (`Restart=on-failure`).
Production `buildProductionDeps` parses the five env names, constructs the
Linear/substrate clients, the `/var/lib/substrate` worktree gate, the
Hermes config read, and a detached-spawn wrapper. `runDispatcherOnce`
takes every host seam as an argument.

**Unit** (`infra/vps/substrate-dispatcher.service` +
`substrate-dispatcher.service.d/10-environment.conf`). Modelled on
`substrate-mcp.service`: `WorkingDirectory=/opt/agent-substrate/current`,
`ExecStart` the host bun on `packages/dispatcher/src/index.ts` (no
`/usr/bin/flock` wrapper — the lock is in-process, and a lock path in that
slot would read as a `missing-entry`), `ProtectHome=false`,
`StateDirectory=substrate`, `Restart=on-failure`, no
`Environment=SUBSTRATE_DISPATCH_DISABLED` anywhere. The drop-in carries
only `EnvironmentFile=/etc/substrate/dispatcher.env`; no values in the repo,
nothing written to `/etc/substrate`, no unit restarted.

**Doctor** (`scripts/doctor-units.test.ts`). The repo-units case now expects
`substrate-dispatcher.service`, asserts its entry resolves to
`packages/dispatcher/src/index.ts`, its env files are exactly
`[/etc/substrate/dispatcher.env]` (never the shared file), its environment
map is empty, and `Restart` is `on-failure`. The python
`substrate_dispatcher` fixtures stay as negative tests. Collector env names
(`substrate-collector-herdr.env`, `substrate-collector-muse.env`) untouched.

**Docs** (`docs/ci.md`). The line-65 sentence now states the dispatcher is
TypeScript on Bun tested by `bun test`; the `setup-python`/pytest note is
scoped to the miner only. Workflow and `verify.ts` untouched.

## Tests

- `launch-claude-code.test.ts`: refused/timeout → `host-unreachable`,
  answered double → `host-refused`, loopback double receives zero bytes
  (server-side close as the deterministic signal, no sleeps), closed port
  through the real transport → `host-unreachable`, plus a source
  self-audit asserting no `/tasks`, `fetch(`, `openTask`,
  `packages/host`, `POST`, `Docker`, or `rivet` outside comments.
- `tick.test.ts`: new `claude-code dial` block (refused → marked without
  give-up/worktree/spawn/graph calls; answered → `host-refused` with label
  kept; seeded marker → once-only, still not given up). The old defer test
  now uses the `substrate` surface.
- `index.test.ts`: disabled returns before lock/build/tick; busy lock
  returns without build/tick and releases; enabled run ticks once with the
  built deps and releases; defaults pin the unit-contract paths.
- Full run at HEAD: `bun test packages/dispatcher
  scripts/doctor-units.test.ts` → **145 pass, 0 fail**;
  `bunx tsc --noEmit` clean. `git show --stat` names nothing under
  `packages/host/src`; `grep -r tasks packages/dispatcher/src` matches only
  the test's forbidden-token list.

## Deviations from plan

None — plan executed as written, plus the assignment-directed extras the
plan's ExecStart required: `packages/dispatcher/src/index.ts` (+
`index.test.ts`) and the `TickDeps.dialClaudeCode` seam with its tick wiring
(the silent defer it replaces). Two post-commit type errors in
`index.test.ts` (missing `worktree`/`readHermesConfig` stubs, a
`TickDeps | null` narrowing) were fixed and amended into the same commit;
suite and `tsc` re-verified green at the final SHA.

## Threat flags

None beyond the plan's register: T-24-04a (dial-only, self-audit test),
T-24-04b (`on-failure`, no DISABLED line, doctor assertion), T-24-04c (own
env file, values never in repo), T-24-04d (sentence-scope docs fix).
No new network, auth, or schema surface: the dial speaks no protocol.

## Not done / left for later

Live Linear dispatch was not started; phases 31–33 still own the listener,
`POST /tasks`, and `openTask`. ROADMAP and REQUIREMENTS untouched per
instructions. No push performed.
