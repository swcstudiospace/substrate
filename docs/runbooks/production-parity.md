# Runbook — production parity for substrate-mcp

| | |
| --- | --- |
| Requirement | FOUND-03 |
| Window | The operator retired the stray holder of `127.0.0.1:7410`, pid 3149064, at about 17:14 UTC on 2026-10-08. Source: CONTEXT Operator answers dated 2026-10-08. |
| Last known-good commit | `ab62c91` on `main` (equal to `origin/main` at discuss time; the checkout's last HEAD move was 14:27:38 UTC, before the 17:14:12 UTC start) |
| Scope | `substrate-mcp.service` owning `127.0.0.1:7410` and serving `main` |
| Untouched | The herdr and Muse collectors, the skills sync and bridge, the dispatcher, the host, surface tokens and the operator token (Phase 20), event mapping (Phase 17) |

## What this runbook proves, and how

Retiring the stray process is the operator's job, in an approved window. This
runbook delivers the read-only check that proves the unit owns the port and
serves `main`, plus the rollback. Commands as run, from a session on the host.
Nothing below touches a production store except the two approved read-only
`rh-` counts, and no command carries a credential.

The check is `scripts/parity-check.ts`, run as `bun run parity:check`:

```sh
bun run parity:check [--json] [--expect-restarts N] [--expect-start EPOCH]
```

It exits `0` on pass, `1` on a failed criterion, `2` when it could not ask.
It prints PIDs, states and commits — never an environment value. `--json`
emits the readings that fill the evidence table below. `--expect-restarts`
and `--expect-start` pin the current `NRestarts` and start epoch so the next
run notices movement.

It checks, read-only:

1. `systemctl show substrate-mcp`: the unit is active, `NRestarts` has not
   grown since the previous reading, and the start time is stable.
2. `ss -ltnp`: the pid that owns `127.0.0.1:7410` equals `MainPID`, and
   `/proc/<pid>/cgroup` is `system.slice/substrate-mcp.service`.
3. `GET http://127.0.0.1:7410/healthz` returns 200.
4. "From `main`" holds when all of these are true: `/proc/<pid>/cwd` is the
   unit's `WorkingDirectory`; the process started after that checkout's last
   HEAD move, read from the reflog; the checkout has no local modification
   under the server's code paths (`packages/**`, `package.json`, `bun.lock`);
   no commit between the checkout's HEAD and `origin/main` changes those
   paths. Every git call runs with `--no-optional-locks` and never fetches,
   pulls or checks out in the operator checkout.
5. Warnings, never failures: a diff between the installed unit file and
   `infra/vps/substrate-mcp.service`, and an inventory of every other
   `substrate-*` unit.

## A harness twin is not a stray

A twin from `docs/rehearsal.md` and a stray holder of the production port
differ in three places:

- **Port.** A twin never owns `7410`, `7411` or `6420` — `up` refuses them.
  Whatever owns `127.0.0.1:7410` is production or a stray, never a twin.
- **Checkout.** A twin runs from the checkout its `state.json` records, which
  is never the unit's `WorkingDirectory`. Production's cwd is the unit's
  `WorkingDirectory`.
- **`state.json`.** A twin has one, in its run directory, naming its pid,
  ports and commit. A stray has none.

## Identifying a stray holder

Operator only. When something other than `MainPID` answers on the production
port:

```sh
# who owns the port, and which cgroup they belong to
ss -ltnp '( sport = :7410 )'
cat /proc/<pid>/cgroup
readlink /proc/<pid>/cwd
```

A cgroup outside `system.slice/substrate-mcp.service` with no `state.json`
anywhere naming that pid is a stray. The operator signals it and lets
`Restart=always` take the port, or runs `systemctl restart substrate-mcp` —
then re-runs the check. Retiring a stray is never done from an agent session:
starting the server from a session recreates the stray.

## Parity evidence

Dated readings, newest last. The `--json` fields (`mainPid`,
`nRestarts`, `startEpoch`, `headSha`, `originSha`, `healthzStatus`) fill one
row per run.

| Date (UTC) | MainPID | NRestarts | ExecMainStartTimestamp | healthz |
| --- | --- | --- | --- | --- |
| 2026-10-08 ~17:14 (discuss-time read) | 1525582 | 0 | 17:14:12 | pending proof run |
| 2026-10-08 ~20:40 (proof run, plan 16-05) | 1525582 | 0 | 17:14:12 (epoch 1791479652) | 200 |

The discuss-time read also recorded: cgroup
`system.slice/substrate-mcp.service`, the journal line "listening on
`http://127.0.0.1:7410` (index + greptime, anonymous, audit in memory, claims
fail-closed)", and the checkout at `ab62c91` equal to `origin/main`.

The proof run (`bun run parity:check --json`, exit 0, PASS, run by the
orchestrator under operator approval on 2026-10-08 ~20:40 UTC) also
recorded: `:7410` owned by pid 1525582 (equal to `MainPID`), cgroup
`0::/system.slice/substrate-mcp.service`, server entry
`packages/mcp-server/src/index.ts`; operator checkout HEAD `ab62c918`
vs `origin/main` `6417c92f` differing only by PR #21's `.planning` docs,
so the check counted it as serving `main`; `healthz` 200. Non-failing
warnings: the installed unit differs from the repo unit; inventory
`collector-grok`, `collector-herdr`, `collector-muse` and `dispatcher`
active/running, `host` inactive/dead, `skills-bridge` and `skills-sync`
failed, both timers active/waiting. The parity window itself was the
operator at about 17:14 UTC, as in the header.

The previous restart counter had reached 119855 before the window; the
counter starts over at 0 with the clean start above.

## Isolated harness proof (SC-2, plan 16-05 Task 1)

Proven 2026-10-08 from the worktree, instance `p16-proof`, run tag
`rh-p16-proof-mv00v314`. Only hosts, ports, key names and booleans are
recorded here — never values.

- `up`: twin on `http://127.0.0.1:17410`, images
  `postgres:16-alpine` and `greptime/greptimedb:v0.14.4`, checkout commit
  `33bfeb9ffc57a2c4216866f762c3ff387bcd1b0a`.
- `smoke` 4/4: `brief` ok, `emit` ok, `register` ok, `claim` ok
  (`claimed` true, `decision` granted).
- `ss -tnp` for the twin pid during the instance lifetime, hosts and ports
  only: `LISTEN` on `127.0.0.1:17410`; established peers all
  `127.0.0.1` to `127.0.0.1` on the two container host ports (scratch
  Postgres, scratch ledger). No `7410`, no non-loopback host.
- Scratch index live tests against `SUBSTRATE_TEST_PG_URL` (`graph-bind`,
  `index-store.{lease,memory,search}`): 68 pass / 0 fail.
- Targeted harness tests (`rehearsal-env`, `rehearsal`, `store-lock`):
  64 pass / 0 fail. Full `bun test`: 1198 pass / 56 skip / 0 fail
  (baseline 1129 pass held, growth from plans 16-01–16-04 tests).
  `bunx tsc --noEmit`: clean.
- `down`: stopped the twin pid, removed 2 containers. The
  label-filtered `docker ps -a` listing is empty and the run directory is
  gone.
- Zero-write evidence (reported 2026-10-08 ~20:40 UTC; counts run by the
  orchestrator under operator approval; proof run tag
  `rh-p16-proof-mv00v314`, filter `'rh-%'` covering every harness run
  tag): production Greptime `agent_events` rows with `graph_id` or
  `session_id` like `'rh-%'` = 0 (HTTP 200); production Postgres
  `graph_index` (`graph_id` like `'rh-%'`) = 0, `graph_nodes`
  (`graph_id` or `claim_session` like `'rh-%'`) = 0, `graph_steps`
  (`graph_id` like `'rh-%'`) = 0.

## Operator step: installing the repo unit

`infra/vps/substrate-mcp.service` on `main` is ahead of the installed unit:
it carries the `StateDirectory=substrate` block that Phase 20's audit path
relies on, and the approved `ConditionPathExists` guard on the server entry
point. The repo file has no effect until the operator installs it. Operator
only, at the next approved restart:

```sh
# back the installed unit up outside the repo, then install the repo file
cp /etc/systemd/system/substrate-mcp.service /root/substrate-mcp.service.bak-<date>
cp infra/vps/substrate-mcp.service /etc/systemd/system/substrate-mcp.service
systemctl daemon-reload
systemctl restart substrate-mcp
bun run parity:check --json
```

The new row goes in the evidence table above.

## Rollback

Two rollbacks, both operator only:

1. **`main` misbehaves in production.** Check out the last known-good commit
   recorded in the header table in the operator checkout, run
   `systemctl restart substrate-mcp`, and re-run the check. Rollback never
   starts the server from a user session, because that recreates the stray
   process. After a real rollback a FAIL naming only server-path drift from
   `origin/main` is expected: HEAD no longer matches the remote by design.
2. **The installed unit file goes wrong.** Restore the backup taken at
   install time, `daemon-reload`, restart, re-run the check:

```sh
cp /root/substrate-mcp.service.bak-<date> /etc/systemd/system/substrate-mcp.service
systemctl daemon-reload
systemctl restart substrate-mcp
bun run parity:check --json
```

The harness needs no rollback: `bun run rehearsal down` removes everything
it made.

## The two approved production probes

Operator-approved for this phase's proof, and nothing else touches
production. After the harness smoke (`rh-<name>-<timestamp>` ids), both
counts must be 0 — the run tag's absence plus isolation by construction is
the proof the scratch run added nothing to production:

- In production Greptime, `count(*)` over `agent_events` for rows whose
  graph or session id starts with the run's `rh-` tag is 0.
- In the production Postgres graph tables, `count(*)` for rows whose graph
  or session id starts with the run's `rh-` tag is 0.

Raw production row counts move with live traffic, so they cannot show that a
run added nothing; the tag counts can. Record both results beside the proof
row in the evidence table.

Results for the proof run (2026-10-08 ~20:40 UTC; counts run by the
orchestrator under operator approval; proof run tag
`rh-p16-proof-mv00v314`, filter `'rh-%'` covering every harness run
tag): production Greptime `agent_events` = 0; production Postgres
`graph_index` = 0, `graph_nodes` = 0, `graph_steps` = 0. Both probes at
0, so the scratch run added nothing to production.

## Who does what

Agents may: build and run the harness and its smoke on scratch stores; run
the host-only reads at any time (`systemctl show`/`status`, `ss -ltnp`,
`journalctl` reads, `/proc` reads, read-only git); write repo files in the
worktree; run `parity:check`, including the production `/healthz` GET,
within an operator-approved proof step.

Agents never: signal or stop any process their own harness instance did not
start, which includes the stray process and the unit; run state-changing
`systemctl` verbs; edit `/etc/systemd` or `/etc/substrate`; read environment
values; write to the operator checkout or its git state; query production
stores without approval.

The operator, in an approved window: retires a stray holder of `7410`;
optionally installs the repo unit; approves the read-only production probes
(`/healthz` and the `rh-` tag counts).
