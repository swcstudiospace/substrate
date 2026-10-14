# Runbook — the boot-and-prove release gate

| | |
| --- | --- |
| Command | `bun run gate:boot` (`scripts/release-gate.ts`) |
| Needs | Docker (local daemon), `postgres:16` and `greptime/greptimedb:v0.14.4` present locally (or the images named by `SUBSTRATE_REHEARSAL_PG_IMAGE` and the ledger image override of [../rehearsal.md](../rehearsal.md), which the gate forwards to the harness and to nothing else), 2 GiB free on Docker's data root, `bun install --frozen-lockfile` done in the checkout |
| Touches | Only scratch containers and a run directory it creates itself, on a free loopback port. Never the production ports (`7410`, `7411`, `6420`), units, stores or env files |
| Opt-in | Nothing runs it by itself. CI runs it report-only when `BOOT_GATE` is `true` ([../ci.md](../ci.md)); `deploy-release.sh` can call it before the symlink swap through `SUBSTRATE_DEPLOY_GATE` (`off` by default; see [../../infra/vps/README.md](../../infra/vps/README.md), "Pre-swap preflight and release gate") |

## What it is for

Today the stores are checked only after the production swap. This gate boots the release candidate against **real** stores (a scratch Postgres and a scratch GreptimeDB, in Docker, through the rehearsal harness — [../rehearsal.md](../rehearsal.md)), drives it over HTTP the way clients and monitors do, causes a real ledger outage, and proves the service degrades and recovers. Run it from the **new release's tree** before the swap.

## Run it

```sh
bun run gate:boot                                  # human receipt on stdout, progress on stderr
bun run gate:boot -- --json                        # one JSON receipt on stdout
bun run gate:boot -- --keep                        # leave the twin up; prints the `down` command
bun run gate:boot -- --name pre-deploy --window-ms 30000
```

Options: `--name <id>` (default `gate-<time>`; a name that already has a run directory is refused, never torn down), `--surfaces a,b` (default `claude-code,grok-bot`; both must stay in the list), `--window-ms N` (the outage window, 5000 to 300000, default 40000), `--keep`, `--json`.

## Exit codes

| Exit | Meaning | What to do |
| --- | --- | --- |
| `0` | Every check passed and nothing is left running | Proceed |
| `1` | A check failed — or the teardown left a container or the run directory behind | Read the receipt: the `FAIL` rows name the assertion. Do not deploy |
| `2` | No answer: the harness refused to start (Docker missing or not local, an image missing under `--pull never`, the disk floor, a port refusal, the production checkout, no `node_modules`), the name is taken, bad arguments, or the run was interrupted before any check had failed (a check that had already failed keeps the exit at `1`) | Fix the reason in the `unavailable=` field, then run again. A `2` proves nothing either way; a deploy hook must not treat it as green |

## The checks

One named check per row, each with its timing, then one line a log search or a deploy hook can key on:

```text
gate-receipt name=<id> commit=<sha12> verdict=pass|fail|unavailable exit=<0|1|2> checks=N pass=N fail=N skip=N notes=N failed=<ids|-> unavailable=<reason|-> kept=<bool> ms=N
```

| Check | Proves | Turns red when |
| --- | --- | --- |
| `up` | The harness started the twin: both stores healthy, the server answering `/healthz` with a writable index and ledger | `rehearsal up` fails or times out (a refusal is exit 2, not a failure) |
| `consumer` | `consumer.env` names a scratch twin (never a production port or a non-loopback host) and both driven surfaces have a token file | The URL is a production one, or a token file is missing |
| `livez` | The process answers `GET /livez` without a bearer | No answer, or not `ok: true` |
| `healthz` | `GET /healthz` is 200 with `index`, `greptime` and `eventsWritable` all true | Either store down, ledger writes refused |
| `slo` | `GET /slo` is 200 with the four catalogue objectives (`brief.p95`, `emit.success`, `lease.steal_rate`, `quarantine.rate`) each present once with a known status, and `planes`, `burn` and `breached` well-formed. **Shape only**: a `breached` objective on the fresh twin is a `NOTE` row (and counted in `notes=`), never a failure | A missing or duplicated objective, an unknown status, a missing array, a non-200 |
| `brief.claude-code` | `POST /brief` is a 200 of full markdown, state `complete`, profile `full` | Any 4xx/5xx, a degraded brief against healthy stores, the wrong profile |
| `brief.grok-bot` | The `SUBSTRATE_BRIEF_PROFILE=shadow` contract: as `grok-bot`, the full text is served whether or not `profile: "compact"` is asked | A compact brief served under `shadow`, or a non-200 |
| `brief.profile-typo` | An unknown `profile` is refused with 400, never served | Anything but 400 |
| `emit` | `POST /events` is 202 with `stored: true` and an id | The ledger refused the append |
| `brief.visibility` | The event just emitted appears in the next brief within 15 s | It never shows |
| `rehearsal.smoke` | The harness's own smoke: brief, emit, register, claim | Any step fails |
| `smoke.grok` | `bun run smoke:grok` against the twin as `grok-bot`; exit 0 and exit 1 (degraded: the contract held, a plane was not fully up) both pass, exit 2 fails. An exit 1 prints an explicit `NOTE` row under the check and is counted in `notes=` on the receipt line | The connector contract breaks |
| `outage.pause` | `rehearsal pause --store ledger` froze the twin's own ledger container | The pause is refused or fails (the outage checks are then skipped) |
| `outage.brief` | While the ledger is frozen, `POST /brief` is still a 200 with the brief text, within 1500 ms (the hook's budget) | A 5xx, a hang, or an answer over the budget |
| `outage.chaos` | `bun run smoke:chaos` against the frozen twin with `CHAOS_WINDOW_MS` set: every emit is answered (stored or reported dropped), at least one append refused with 503, claims withdrawn (none granted), the audit chain still verifies, `emit.success` reports breached | Any chaos check fails, or it does not finish inside the window plus two minutes (a hang). `CHAOS_REHEARSAL` is never set. The smoke runs with `CHAOS_TIMEOUT_MS=25000` (see "Why 25 s") |
| `outage.unpause` | `rehearsal unpause --store ledger` thawed it | The unpause fails (cleanup tries again) |
| `recovery.healthz` | `/healthz` reports both stores and ledger writes ok again within 90 s | Still unhealthy after 90 s |
| `recovery.emit` | An emit is stored again, polled every 2 s for up to 90 s like `recovery.healthz` | The ledger still refuses appends after 90 s |
| `cleanup.down` | `rehearsal down` ran | It fails — the twin may still be running |
| `cleanup.residue` | No container carries the instance label and the run directory is gone | Either is left behind |

A check that could not run because an earlier one it depends on failed is `SKIP`, never `PASS`; the receipt counts them.

Teardown is unconditional. `down` runs after the last check on a pass, on a failed check, on an unexpected error, and on `SIGINT`/`SIGTERM`/`SIGHUP` (the signal stops the proofs, then thaws the ledger if frozen and removes the instance). A check that had already failed, or that failed while the signal arrived, keeps the exit at `1`.

- When the harness *refuses* to start (exit 2 from `rehearsal up`) it has usually created nothing, but it creates the run directory and token files before some of its refusals and removes none of them. The gate therefore runs the label-scoped `down` and the residue check whenever a run directory is present after a refused `up`, except when the refusal is contention (`already running`, `locked by another operation`, an unverifiable live pid): then the name belongs to someone else and nothing is touched. A name whose run directory already exists is refused before `up` is called and never torn down.
- `--keep` skips `down` only; a frozen ledger is still thawed.
- **`SIGKILL` cannot be handled.** A CI runner that cancels a job sends `SIGTERM`/`SIGHUP` and, after its grace period, `SIGKILL`; a dropped ssh session sends `SIGHUP`. The first two are cleaned up; if the gate is killed outright the detached twin and its two containers survive. Sweep them with `bun run rehearsal down --name <gate name>` (the name is in the receipt and the progress log, `gate-<time>` by default) or list leftovers with `docker ps -a --filter label=substrate.rehearsal`.

## How the outage is made, and why

`rehearsal pause --store ledger` runs `docker pause` on the twin's own labelled ledger container. The store keeps accepting connections and answers nothing, which is what a dropped-packet outage looks like to the server and the failure `scripts/chaos-smoke.ts` is written for (it asks for DROP, not REJECT). The twin's `SUBSTRATE_SLO_MIN_SAMPLES` is set to 3 for this run (an allowlisted `--extra-env`) so that the few emits a short window can attempt are enough for `emit.success` to be judged; it changes nothing in production.

### Why 25 s (and why a 40 s window)

With the ledger frozen the server answers an emit only after its ledger client times out: one 5 s statement timeout (`DEFAULT_TIMEOUT_MS` in `packages/mcp-server/src/greptime.ts`) when the session's chain tip is cached, two (tip lookup, then insert, 10.0 s) for a fresh session. Measured against a frozen scratch ledger: 5.0 s and 10.0 s. A chaos-smoke request timeout of 10 s sits exactly on that boundary and aborts a request the server is about to answer, which reads as "emit not answered". The gate therefore gives the chaos smoke `CHAOS_TIMEOUT_MS=25000` (`CHAOS_REQUEST_TIMEOUT_MS`), more than twice the worst case, and `release-gate.test.ts` pins it above twice the ledger statement timeout. The default window is 40 s so it holds at least three ticks of (up to 10 s emit + 2 s tick). `--window-ms` shorter than that proves less, not more.

### Why the pre-outage SLO verdict is informational

The twin runs with `SUBSTRATE_SLO_MIN_SAMPLES=3` so that the few emits a short outage window can attempt are enough for `emit.success` to be judged `breached` (the chaos smoke requires it). At that floor the first three observations decide the verdict, and on freshly started stores those are cold-start errors and slow first calls (table creation, container warm-up, the harness's own readiness probes): a live run reported `brief.p95`, `emit.success` and `plane.greptime.availability` breached before any traffic, another reported none. A gate that flakes on boot noise is worse than none, so `slo` checks only that the endpoint answers with a well-formed catalogue and prints any breach as a note. What the SLOs say under a real outage is proven by `outage.chaos`.

## Not covered

The gate does not prove, and its green must not be read as proving:

- **Production configuration and host state.** It runs a fresh twin with a generated environment: no production env file, unit hardening, slices, redis/Dragonfly, swap, timers or file permissions. `bun run doctor:runtime` and `bun run parity:check` read the host and are separate.
- **The cache plane.** The twin configures no redis, so cache behaviour (single-flight, stale-while-revalidate, generations) is not exercised. `SUBSTRATE_CACHE_SWR` can be set on the twin but has no cache to act on.
- **Hindsight and RAGFlow.** Neither is configured on the twin; recall, the docs search and their breakers are not exercised.
- **The index outage.** `rehearsal pause --store index` exists, but the gate only freezes the ledger. Postgres loss and recovery are not proven here.
- **The index archive and restore drill** (`docs/runbooks/index-archive.md`). Out of scope for this gate.
- **Production data volume, retention and latency.** Scratch stores run on tmpfs and are empty; the brief and SLO timings say nothing about production load. The GreptimeDB image is the local v0.14.4, not production's version (see [../rehearsal.md](../rehearsal.md)).
- **The metrics history writer and the Grok connector against production gateways.** `SUBSTRATE_METRICS_HISTORY` is not turned on by the gate, and `smoke:grok` runs against the twin only.
- **Concurrency and soak.** One caller at a time, for a short window.
- **The production swap itself.** Nothing here runs `deploy-release.sh`, restarts a unit or checks rollback.
- **A different commit from the one checked out.** The twin runs the working tree's code; a dirty tree is run as it is (`rehearsal up` prints the dirty flag).

## Wiring it into a deploy

`infra/vps/deploy-release.sh` runs the gate from the new release tree before the swap when `SUBSTRATE_DEPLOY_GATE` is `report` or `enforce` (default `off`; [../../infra/vps/README.md](../../infra/vps/README.md) has the hook's exact semantics). The contract it relies on: run `bun scripts/release-gate.ts` in the release tree, read the exit code (`0` pass, `1` fail, `2` unavailable) and the `gate-receipt` line. An unavailable gate under `enforce` is the deploy's decision, not the gate's. The release tree a deploy builds is a `git archive` export without `.git`, so the gate's own receipt reads `commit=unknown` there; the hook prints its own `gate-receipt mode=… release=<sha>` line, which names the release.

## If it leaves something behind

A crashed run (power loss, `kill -9`) can leave scratch containers and a run directory. They are labelled and named for the instance:

```sh
bun run rehearsal down --name <id>          # label-scoped removal; idempotent
docker ps -a --filter label=substrate.rehearsal   # what is left, if anything
```

`down` removes only containers carrying that instance's label.
