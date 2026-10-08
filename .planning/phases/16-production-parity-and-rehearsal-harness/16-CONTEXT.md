# Phase 16: Production parity and rehearsal harness - Context

**Gathered:** 2026-10-08
**Status:** Ready for planning
**Mode:** Smart discuss, auto-accepted under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"). One recommendation changes unit behaviour and is listed for the operator under "Open for the operator" below; the plan uses the recommended answer unless the operator overrides it.

<domain>
## Phase Boundary

Two deliverables in one PR on agent-substrate (FOUND-01, FOUND-03):

1. **Rehearsal harness (FOUND-01).** One command starts the checkout's `substrate-mcp` on a scratch loopback port against a scratch Postgres and a scratch GreptimeDB in local Docker containers, with configurable surface tokens. One command tears it down. Every later v1.3 proof sets `SUBSTRATE_URL` from the harness and never touches a production store.
2. **Production parity (FOUND-03).** Retiring the stray process on `127.0.0.1:7410` is the operator's job, in an approved window. The phase delivers a runbook and a read-only parity check that proves `substrate-mcp.service` owns the port and serves `main`, plus the rollback. It also syncs `infra/vps/substrate-mcp.service` with what is installed.

**State at discuss time (read-only `systemctl show`, `ss -ltnp`, `journalctl`, `/proc`, `git -C … log -g`, run 2026-10-08 after 17:14 UTC):**
- The stray pid 3149064 (started 2026-10-01) is gone.
- `substrate-mcp.service` MainPID 1525582 started at 17:14:12 UTC. Its cgroup is `system.slice/substrate-mcp.service`, it owns `127.0.0.1:7410`, and `NRestarts=0` since that start. The previous restart counter reached 119855.
- The journal line reads "listening on http://127.0.0.1:7410 (index + greptime, anonymous, audit in memory, claims fail-closed)".
- The operator checkout is on `main` at `ab62c91`, which equals `origin/main`. Its last HEAD move was at 14:27:38 UTC (`pull origin main: Fast-forward`), before the process started.
- The repo has no record of who retired the stray process. [INFERENCE] The operator did it at about 17:14 UTC: the journal shows a clean start followed by a stop and start within one second.

The live step therefore shrinks to two things: the operator confirms that window, and the read-only check is recorded.

**Out of scope:**
- Surface tokens, the operator token, `SUBSTRATE_HANDOFF_KEY` and `SUBSTRATE_AUDIT_PATH` in production (Phase 20, FOUND-04).
- The code and unit files of the other orphaned units: the herdr and Muse collectors (19), the skills sync and bridge (22), the dispatcher (24) and the host (31).
- Event mapping and `EVENT_KINDS` (Phase 17; unchanged here).
- The UAT scenarios (Phase 20).

</domain>

<decisions>
## Implementation Decisions

### Harness entry point and lifecycle
- **Entry point.** `scripts/rehearsal.ts`, run as `bun run rehearsal <up|down|status|smoke>` through a `package.json` script. This follows `smoke:greptime` and `smoke:chaos`. It is not a `substrate` CLI subcommand, so the CLI surface is unchanged.
- **Named instances.** `--name <instance>`, default `default`, so parallel worktrees can each run a twin.
  - Each instance has its own run directory outside every checkout: `${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/<name>/`, mode 0700.
  - The run directory holds `state.json` (container ids, server pid, ports, checkout path and commit), `server.log`, `consumer.env`, `stores.env` and `tokens/`.
- **`up` sequence:**
  - Preflight: Docker reachable; images present locally (`docker image inspect`); a free-disk floor (refuse below about 2 GB, never prune); requested ports free.
  - Start two containers labelled `substrate.rehearsal=<name>`, with `--rm --pull never`, data on `--tmpfs` and no volumes:
    - `substrate-rehearsal-<name>-pg`, from `postgres:16-alpine`;
    - `substrate-rehearsal-<name>-greptime`, from `greptime/greptimedb:v0.14.4` in standalone mode.
  - Wait for both to be ready.
  - Spawn `bun packages/mcp-server/src/index.ts` from the harness's own checkout, detached, logging to `server.log`.
  - Wait for `GET /healthz` to return 200 with `index: true`, `greptime: true` and `eventsWritable: true`.
  - Print the `consumer.env` path, the URL, the checkout commit, a dirty flag and the image tags. Never print a credential.
- **`down`:**
  - Idempotent.
  - It signals only the pid recorded in its own `state.json`, and only after checking that the pid's `/proc/<pid>/cmdline` is the substrate-mcp entry point, that its cwd is the recorded checkout, and that it is not in `system.slice` and does not own a production port.
  - Then it removes every container carrying the instance label, which also catches orphans from a crashed `up`, and deletes the run directory.
- **`status`:** shows the instance's pid, ports, health, commit and image tags. It is read-only.
- **The code under rehearsal is the checkout the command runs from.** The Phase 16 proof runs it from a checkout of `main`. Later phases rehearse their own branch the same way. Status records the commit, so a proof states exactly which code it rehearsed.

### Isolation, scratch credentials and how consumers point at it
- **Ports.**
  - The scratch MCP port defaults to `127.0.0.1:17410`; any other instance needs `--port N`, or `--port 0` to pick a free port.
  - The harness refuses 7410, 7411 and 6420, and any port already listening.
  - Container ports are published as `127.0.0.1::<container port>`: Docker picks a free host port and the harness reads it back with `docker port`. This cannot collide with the long-lived `substrate-smoke-*` containers (:55432, :54000) or the other projects' :5432 and :4000–4003.
- **Scratch credentials.**
  - Each `up` generates a random Postgres password and a random Greptime static user and password (the planner verifies the `--user-provider` syntax on v0.14.4). This exercises production's Basic-auth path.
  - Each `up` also generates one random bearer token per configured surface, plus an operator token.
  - All of them go only into 0600 files in the run directory. Nothing is printed, and nothing is committed.
- **The server's environment is built from an allowlist, never inherited.**
  - It contains `PATH`, `HOME` and Bun's own variables, plus the harness's scratch values.
  - The harness never reads `/etc/substrate/substrate.env`.
  - It never forwards `LINEAR_API_KEY`, `NOTION_API_KEY`, `OTEL_*` or any inherited store or token variable.
  - Preflight asserts that every store URL it hands the server is loopback and points at its own container ports.
- **Store lock.** `store-lock.test.ts` fails any `.ts` outside `packages/mcp-server/src` (except `scripts/greptime-smoke.ts`) that contains `GREPTIME_`.
  - The function that builds the server's store environment therefore lives inside `packages/mcp-server/src` (e.g. `rehearsal-env.ts`), and `scripts/rehearsal.ts` imports it and never names a `GREPTIME_` key.
  - The store lock is not edited.
  - The harness never sends SQL itself: readiness comes from container health and the server's `/healthz`.
- **Surface tokens are configurable.**
  - `--surfaces a,b,c` sets the surfaces, default `claude-code,cursor,hermes,omp`.
  - `--operator <surface>` names the operator surface, default the first one listed.
  - `--anonymous` runs with no tokens, for proofs that need today's anonymous production shape.
  - The default instance runs with tokens, `SUBSTRATE_AUDIT_PATH` in the run directory and a random `SUBSTRATE_HANDOFF_KEY`. That is the shape production reaches after Phase 20.
- **The consumer contract is `consumer.env`.** Every later proof sources this file and hardcodes nothing. It exports:
  - `SUBSTRATE_URL`;
  - `SUBSTRATE_TOKEN`, the first surface's token;
  - `SUBSTRATE_REHEARSAL_TOKENS_DIR`, one 0600 file per surface, the v1.2 workspace-install pattern;
  - `SUBSTRATE_REHEARSAL_NAME`;
  - `SUBSTRATE_TEST_PG_URL`, so the existing live index tests (`graph-bind`, `index-store.{lease,memory,search}`) run against the scratch Postgres.

  It does **not** export the Greptime keys: clients talk to the ledger only through `SUBSTRATE_URL` (store lock rule 1).
- **`stores.env`.** A separate 0600 file in the run directory holds the scratch Greptime and Postgres connection values. Only proofs that legitimately hold a store client source it, such as `bun run smoke:greptime` and Phase 27/28's anchor job. Nothing sources it by default.
- **Smoke.** `bun run rehearsal smoke` drives criterion 2 over the wire: `POST /brief`, an emit through `POST /events`, and an MCP `graph_register` followed by `graph_claim`.
  - It uses a run-tagged graph id and session (`rh-<name>-<timestamp>`) and asserts success on each.
  - It reads only `consumer.env`, and refuses to run if `SUBSTRATE_URL` resolves to port 7410 or to a non-loopback host.
- **Isolation proof for criterion 2.** Raw production row counts move with live traffic, so they cannot show that this run added nothing. The proof is the run tag's absence plus isolation by construction:
  1. Agent, no approval needed: the server's environment names only loopback scratch hosts, and `ss -tnp` for the harness pid during the smoke shows only loopback peers on the container ports. Only hosts and ports are recorded, never values.
  2. Operator-approved read-only queries: in production Greptime `agent_events` and in the Postgres graph tables, `count(*)` of rows whose graph or session id starts with the run's `rh-` tag is 0.

### Store fidelity: the Greptime version gap
- **Local Greptime v0.14.4 against production v1.1.4 is accepted for the harness.**
  - Pulling v1.1.4 is ruled out: the disk is 95% full, and the harness runs `--pull never`.
  - v0.14.4 is what the v1.1 and v1.2 live proofs used.
  - The server probes the version-sensitive behaviour at runtime: `probeDialect` handles backslash quoting, and `ensureAppendMode` reads `SHOW CREATE TABLE`.
- **The gap is recorded, not hidden.**
  - `status` and `state.json` record the Greptime image tag.
  - `SUBSTRATE_REHEARSAL_GREPTIME_IMAGE` and `SUBSTRATE_REHEARSAL_PG_IMAGE` override the images, if the operator ever loads a v1.x image locally.
  - A later phase whose correctness depends on server-version SQL states the gap in its verification and gets an operator-approved read-only check against production where it matters. This covers Phases 27 and 28 (the anchor DDL, the live `anchors` shape, verify) and any `SHOW CREATE TABLE` parsing. Phase 27's `DESCRIBE anchors` is already planned.
- **Postgres has no gap that matters.** Production is TimescaleDB on pg16 on Railway; locally it is `postgres:16-alpine`. The index uses no Timescale extension: no `create_hypertable` or `CREATE EXTENSION` under `packages/`.

### Production parity check, runbook and rollback
- **Runbook location: `docs/runbooks/production-parity.md`.** This creates the `docs/runbooks/` type directory, beside `docs/adr/` and `docs/receipts/`. Phase 20's identity runbook goes there too.
- **Harness documentation: `docs/rehearsal.md`.** It is a flat topic doc like `observability.md` and states the `consumer.env` contract.
- **Read-only check: `scripts/parity-check.ts`, run as `bun run parity:check`.** It exits 0 or 1, prints PIDs, states and commits, and never prints an environment value. It checks:
  1. `systemctl show substrate-mcp -p MainPID,ActiveState,SubState,NRestarts,ExecMainStartTimestamp`: the unit is active, its `NRestarts` has not grown since the previous check (the runbook records each reading), and its start time is stable.
  2. `ss -ltnp`: the pid that owns `127.0.0.1:7410` equals `MainPID`, and `/proc/<pid>/cgroup` is `system.slice/substrate-mcp.service`.
  3. `GET http://127.0.0.1:7410/healthz` returns 200.
  4. **"From `main`"** holds when all of these are true:
     - `/proc/<pid>/cwd` is the unit's `WorkingDirectory`.
     - The process started after that checkout's last HEAD move, read from the reflog.
     - The checkout has no local modification under the server's code paths (`packages/**`, `package.json`, `bun.lock`).
     - No commit between the checkout's HEAD and `origin/main` (read with `git ls-remote`) changes those paths.

     Every git call runs with `--no-optional-locks` and never fetches, pulls or checks out in the operator checkout (its `.git` is shared with every worktree). `/healthz` carries no commit field, and none is added.
  5. **Warnings, not failures of criterion 3:**
     - a diff between the installed `/etc/systemd/system/substrate-mcp.service` and `infra/vps/substrate-mcp.service`;
     - an inventory of every other `substrate-*` unit (active state, `NRestarts`, whether its `ExecStart` entry point is in `git ls-files`).

     Known now: the dispatcher is at `NRestarts=114888`; the host is inactive with 40 restarts; the skills sync and bridge services are `failed` every 5 minutes; the herdr and Muse collectors run from memory.
- **Unit file.**
  - `infra/vps/substrate-mcp.service` on `main` is ahead of the installed unit: the installed copy lacks the `StateDirectory=substrate` / `StateDirectoryMode=0700` block that Phase 20's `SUBSTRATE_AUDIT_PATH` relies on.
  - The phase keeps `StartLimitIntervalSec=0` and adds `ConditionPathExists=` on the entry point. This is recommended and listed for the operator.
  - The runbook's operator step installs the repo unit at the next approved restart: back up the installed unit outside the repo, copy, `daemon-reload`, restart, run the check.
  - The repo file has no effect until the operator installs it.
- **Rollback.**
  - Main misbehaves in production: the operator checks out the last known-good commit recorded in the runbook in the operator checkout, runs `systemctl restart substrate-mcp`, and re-runs the check. Rollback never starts the server from a user session, because that recreates the stray process.
  - The installed unit file goes wrong: restore the backup, `daemon-reload`, restart, re-run the check.
  - The harness needs no rollback, because `rehearsal down` removes everything it made.
- **Live-effect line for the PR:** "none". No runtime code under `packages/` changes behaviour, and the unit file takes effect only when the operator installs it.

### Operator window and agent boundaries
- **Agents may:**
  - build and run the harness and its smoke on scratch stores;
  - run the host-only reads at any time: `systemctl show`/`status`, `ss -ltnp`, `journalctl` reads, `/proc` reads, read-only git;
  - write repo files in the worktree;
  - run `parity:check`, which includes the production `/healthz` GET, within an operator-approved proof step.
- **Agents never:**
  - signal or kill any process their own harness instance did not start, which includes the stray process and the unit;
  - run `systemctl start|stop|restart|enable|disable|daemon-reload`;
  - edit `/etc/systemd` or `/etc/substrate`;
  - read environment values;
  - write to the operator checkout or its git state;
  - query production stores without approval.
- **The operator, in an approved window:**
  - retires a stray holder of :7410 (identify it with `ss -ltnp` and `/proc/<pid>/cgroup`, signal it, and let `Restart=always` take the port or run `systemctl restart substrate-mcp`);
  - optionally installs the repo unit;
  - approves the read-only production probes: `/healthz` and the `rh-` tag counts.
- **That window has apparently already happened** (about 17:14 UTC on 2026-10-08, see Phase Boundary).
  - The plan asks the operator to confirm it was theirs, records who and when in the runbook, and then records the read-only check as criterion 3's evidence.
  - If a stray process is found at proof time, the runbook's window procedure applies again.
  - The dispatcher kill switch (`SUBSTRATE_DISPATCH_DISABLED=1`) stays as it is; disposing of the orphaned units is not Phase 16's live action.

### Claude's Discretion
- The exact readiness timeouts, the free-disk floor value and the default surface list.
- Whether the server is detached with `Bun.spawn` and `unref` or with `setsid`.
- The format of `state.json`.
- The name and placement of the server-env module inside `packages/mcp-server/src`, as long as the store lock stays unedited.
- Whether the smoke reuses `chaos-smoke.ts`'s HTTP helpers.
- Whether `parity:check` also emits JSON for the runbook log.
- Tests for the harness's pure parts: port refusal, env allowlist, loopback assertion, pid ownership check on `down`. No test needs Docker.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/mcp-server/src/config.ts`: `loadConfig(env)` takes an env record, reading `SUBSTRATE_PORT` (default 7410), `SUBSTRATE_HOST`, `SUBSTRATE_PG_URL`, the Greptime URL, user, password and db keys, `SUBSTRATE_TOKEN_<SURFACE>` (`surfaceToEnvKey`), `SUBSTRATE_OPERATOR_TOKENS`, `SUBSTRATE_AUDIT_PATH`, `SUBSTRATE_HANDOFF_KEY` and `SUBSTRATE_CLAIM_REQUIRE_LEDGER`. With no tokens, `allowAnonymous` is true.
- `packages/mcp-server/src/index.ts`: boots even when degraded, migrates on boot, logs the stores, auth mode and audit state, and handles SIGTERM cleanly (bounded flush). `down` can rely on SIGTERM.
- `GET /healthz` (`server.ts:260`, `service.ts:1467`) returns `index`, `greptime`, `appendOnly`, `quotingDialectKnown`, `eventsWritable`, `auditDurable` and `auditRecords`. Its probes are read-only (`SELECT 1`, `SHOW CREATE TABLE`, `SELECT LENGTH(…)`).
- `scripts/chaos-smoke.ts`: an HTTP-only client of a running substrate (it reads `SUBSTRATE_URL`), and the precedent for scripts that stay outside the store lock.
- `scripts/greptime-smoke.ts`: the one named store-lock exemption. It can run against the harness's `stores.env`.
- `packages/mcp-server/src/http.test.ts`: the in-process test harness pattern (`SUBSTRATE_URL: harness.base`).
- The v1.2 proofs ran the server on 7499, 7512 and 7513 against the long-lived `substrate-smoke-pg` (postgres:16, :55432) and `substrate-smoke-greptime` (v0.14.4, :54000), using untracked `/tmp/pNN-proof.sh` scripts. The harness formalizes this in the repo and leaves those containers alone.

### Established Patterns
- Live tests skip unless `SUBSTRATE_TEST_PG_URL` is set: `graph-bind.test.ts`, `index-store.lease.test.ts`, `index-store.memory.test.ts`, `index-store.search.test.ts`.
- Scripts are Bun TypeScript in `scripts/`, exposed through `package.json` `scripts` entries.
- Unit files in `infra/vps/` carry machine-specific `ExecStart` paths (`command -v bun`) and `WorkingDirectory=/root/src/repos/agent-substrate`.
- No credential is read from the repo or printed; reports name hosts only.
- Docs are flat topic files under `docs/`, with type directories `adr/`, `receipts/` and `research/`.
- Store lock (`store-lock.test.ts`):
  - no `GREPTIME_` outside `packages/mcp-server/src` and the smoke exemption;
  - no tracked Greptime endpoint or credential;
  - no tracked value for a substrate token.

### Integration Points
- `package.json` `scripts`: add `rehearsal` and `parity:check`.
- A new env builder in `packages/mcp-server/src`.
- New docs: `docs/rehearsal.md` and `docs/runbooks/production-parity.md`.
- `infra/vps/substrate-mcp.service`: add `ConditionPathExists`.
- Later phases source `consumer.env`: Phases 17, 19, 20 (scenarios 1, 4, 7 and 8), 21, 23, 24 (`--once --dry-run`), 27, 28 and 30.

</code_context>

<specifics>
## Specific Ideas

- **Operator confirmation to collect in the plan's live step:** the stray pid 3149064 disappeared, and `substrate-mcp.service` (pid 1525582) took `127.0.0.1:7410` at 17:14:12 UTC on 2026-10-08. Was that the operator's approved window? The runbook records the answer.
- **The parity check reproduces the discuss-time reading:**
  - MainPID owns :7410 in `system.slice/substrate-mcp.service`;
  - `NRestarts=0` since 17:14:12 UTC;
  - the checkout is at `ab62c91`, equal to `origin/main`, with its last HEAD move at 14:27:38 UTC, before the process start;
  - `/healthz` returns 200 (to be confirmed in the approved proof step).
- **The harness proof sequence:** `up`, then `smoke` (brief, emit, claim), then the `ss`/environment isolation evidence, then `down`, then `docker ps --filter label=substrate.rehearsal` shows nothing and the run directory is gone. After that, the operator-approved `rh-` tag counts in production must be 0.
- **Naming.** `chaos-smoke.ts` already uses "rehearsal" for `CHAOS_REHEARSAL=1`, a green run against a healthy deployment. The docs must keep the two meanings apart: the harness is a scratch deployment, while `CHAOS_REHEARSAL` is a mode of the chaos smoke. Run against the harness, the chaos smoke can prove Phase 20's scenario 7 on scratch.

</specifics>

<deferred>
## Deferred Ideas

- **A `commit` or `version` field on `/healthz`.** It would make "serves main" a single probe, but it changes a REST response shape. The read-only host facts prove it without the change. Revisit with the operator if the check proves too fragile.
- **A harness subcommand to pause or unpause the scratch stores** for outage scenarios (Phase 20, scenario 7). For now `docker pause` on the labelled container is enough; Phase 20 decides.
- **Pointing the harness at pre-existing scratch stores**, such as the `substrate-smoke-*` containers, instead of starting fresh ones.
- **Unit files with `ConditionPathExists` and `StartLimit*` guards for the orphaned units** (collectors herdr and Muse, skills sync and bridge, dispatcher, host). Each lands with the phase that restores its code (19, 22, 24, 31). Until then they are inventoried as warnings by `parity:check`, and disabling any of them is an operator action the runbook records.
- **A local GreptimeDB v1.1.x image** for exact version parity. It is blocked by the disk gate and the no-pull rule; the image override variable is the hook.

</deferred>

## Open for the operator (user-visible)

- **ConditionPathExists on `substrate-mcp.service`.**
  - *Question:* should `infra/vps/substrate-mcp.service` gain `ConditionPathExists=/root/src/repos/agent-substrate/packages/mcp-server/src/index.ts`, keeping `StartLimitIntervalSec=0`?
  - *Why it is user-visible:* it changes unit behaviour. If the entry point is missing (for example after a checkout switch), the unit is skipped and stays down, with a condition-failed status and no restart loop, where today it crash-loops and fills the journal.
  - *Recommended:* yes. It turns a silent 100k-restart loop into one visible condition failure that `parity:check` reports. It takes effect only when the operator installs the unit.
