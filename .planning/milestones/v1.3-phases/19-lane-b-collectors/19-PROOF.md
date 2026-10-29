> Recovered 2026-10-29 from commit 76a4b2c3.
> Written 2026-10-11 to 2026-10-12 during the v1.3 autonomous integration; it describes that run and was not re-verified against main.
> Its paths and line references point at the 2026-10-11 tree, not at main.

# Phase 19 LANEB-07 real-runtime proof (parent-observed)

| | |
| --- | --- |
| Date (UTC) | 2026-10-10 |
| Proof tag | `p19-mv2i83ok` |
| Observer | Parent (main agent). Evidence source: `local://v13-phase19-real-runtime-evidence.json`. This record transcribes parent-observed results; no checks were re-run while writing it. |
| Scope | `scripts/laneb-proof.ts` (`proof:laneb`) against a proof-owned harness twin; `infra/vps/substrate-collector-herdr.service`, `infra/vps/substrate-collector-muse.service` static-unit lint; targeted suite + types. |
| Status | **Observed proof, not a phase verdict.** The whole phase is NOT labelled passed/complete here. Remaining gates and operator items are listed at the end and stay pending. |

## What this supersedes (WR-01 / G19-07)

The original `19-05` executor run (2026-10-09, 27/27) was fixture-scoped:
a loopback snapshot stub stood in for a real herdr server, and the Muse
hook file was executed directly with `bun` instead of the
installed/approved `muse plugins hook test` path. Those two substitutions
are preserved as historical evidence in `19-05-SUMMARY.md` but are
superseded by the proof below. The `Known Stubs: None` / "sealed"
assertions attached to the fixture-only run are withdrawn there.

## Observed checks

- Twin lifecycle: `rehearsal up` exit 0 → `bun run proof:laneb` exit 0 →
  `rehearsal down` exit 0, with the proof's own cleanup completed
  (proof-owned session stopped/deleted, temp dirs removed in `finally`).
- `bun run proof:laneb` — **41/41 checks passed**:
  - Real named herdr (`herdr 0.9.1`); proof-owned `substrate-proof-*`
    session only (pane `w1:p1`). The live default session was never
    connected; the pre-existing global `p19` twin was left untouched.
  - Actions observed: `workspace.create`, `pane.report_agent` working, own
    watching-collector stop/restart with saved state, `pane.report_agent`
    idle, `pane.close`.
  - Time bound: start/note/end/tool.call each observed within ten seconds
    measured from its own action.
  - Muse: actual scratch-HOME `validate` / `install-or-update` / `approve` /
    `inspect` (`trusted_enabled`), installed redactor/config readback, real
    installed hook-test CLI — no model turns.
  - Target guard: installed-config URL equality checked before hook
    execution.
  - `collectors:status` reports **zero refused emits**; operator Muse cache
    paths **unchanged** before/after.
- Static-unit lint: `systemd-analyze verify` on both current unit files —
  exit 0 (parent, 2026-10-10).
- Types: types check — exit 0 (parent, 2026-10-10).
- Targeted suite before the last test correction: **84 pass / 1 fail
  across 6 files**. The single failure is an incidental exact `/healthz`
  request count in scheduled health-disconnect (Bun retries the idempotent
  disconnected GET). The corrective slice — owned by its original parked
  agent — deletes the attempt-count assertions only: no implementation
  change, no weakening of BRIEF/pointer/counter/timeouts. **No final
  full-suite green is claimed until the parent re-verifies after that
  correction.**

## Exact proof commands (current script lineage)

Run from the worktree root (`/root/src/worktrees/agent-substrate-v13-autonomous`),
under caller-owned `HOME` / `XDG_*` / `TMPDIR` that do not collide with the
operator scope or the pre-existing global `p19` twin. Names only — no file
here holds an environment value, and no secret value appears in this record.

```sh
# 0. Isolate the run. Use a fresh proof-owned twin name (never the
#    pre-existing global `p19`); all scratch state lands under the owned
#    TMPDIR and the proof's own scratch HOME.
export HOME="<owned-proof-home>" XDG_CONFIG_HOME="<owned-proof-home>/.config" \
  XDG_DATA_HOME="<owned-proof-home>/.local/share" TMPDIR="<owned-proof-tmpdir>"
cd /root/src/worktrees/agent-substrate-v13-autonomous

# 1. Bring up a proof-owned twin (parent observed: exit 0).
bun run rehearsal up --surfaces claude-code,cursor,hermes,omp,muse --name <proof-owned-twin>

# 2. Run the real-runtime proof (parent observed: 41/41, exit 0, tag `p19-mv2i83ok`).
bun run proof:laneb

# 3. Tear the proof-owned twin down (parent observed: exit 0).
bun run rehearsal down --name <proof-owned-twin>

# 4. Static-unit lint on the current unit lineage (parent observed: exit 0).
systemd-analyze verify \
  /root/src/worktrees/agent-substrate-v13-autonomous/infra/vps/substrate-collector-herdr.service \
  /root/src/worktrees/agent-substrate-v13-autonomous/infra/vps/substrate-collector-muse.service
```

Notes on the current lineage the commands exercise: the proof script spawns
`herdr --session substrate-proof-* server` on its own socket, runs the real
watching collector child with persisted v2 state (kill-and-restart between
working and idle), and drives the installed Muse hook via `muse plugins
hook test` under the scratch HOME with `HERDR_*`/`XDG_*` stripped from
child envs. Guard paths refuse a stray argument, port 7410, and
non-loopback hosts with exit 2 before any request.

## Provenance and boundaries

- Concurrent source-`main` and production changes were observed during the
  proof window, but the parent performed **no** production restart, cutover,
  or plugin install. Existing operator runbook receipts keep their recorded
  actor/date; nothing in this record claims our run installed or restarted
  anything in production.
- The root Cursor credential disclosure is contained in the test fixture
  only. Actual rotation remains an operator action and is **not** marked
  done or accepted here.
- Not performed by the parent: production probes or store writes, service
  restarts, user-scope hook/plugin installs, Cursor credential rotation,
  model turns, PR merges.

## Remaining gates / operator items (pending)

- Final full-suite green after the parked agent's attempt-count correction
  (parent re-verification; union with enforcing security/validation/verifier
  results). The phase stays unverified/closed until then.
- Operator-only, post-merge window per `docs/runbooks/lane-b-collectors.md`:
  production collector install/restart, user-scope Muse projection and
  `/root/.cursor/hooks.json` edits, per-event identity follow-ups, and the
  global Cursor credential rotation.
- Issues: [SPE-9999](https://linear.app/swcstudio/issue/SPE-9999/n6-establish-verification-and-recovery-safeguards),
  [SPE-10000](https://linear.app/swcstudio/issue/SPE-10000/n5-define-remaining-phase-work-units).
