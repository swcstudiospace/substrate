# Phase 16: Production parity and rehearsal harness - Research

**Researched:** 2026-10-08
**Domain:** Local Docker scratch stores + detached Bun process lifecycle (rehearsal harness); read-only systemd / `ss` / `/proc` / git host probes (parity check); systemd unit hygiene
**Confidence:** HIGH (every load-bearing fact below was read from this repo, the installed images, the GreptimeDB v0.14.4 source tag, or a read-only host probe this session)

> **Writing rule for every file this phase adds, including this one.** `.planning/` is tracked, so `store-lock.test.ts` scans it. No line may put a value after a Greptime URL/user/password key, no line may assign a substrate token key a 16+ character value, and no line may name a Railway host. The exact regexes are under "Store lock" below.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Harness entry point and lifecycle
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

#### Isolation, scratch credentials and how consumers point at it
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

#### Store fidelity: the Greptime version gap
- **Local Greptime v0.14.4 against production v1.1.4 is accepted for the harness.**
  - Pulling v1.1.4 is ruled out: the disk is 95% full, and the harness runs `--pull never`.
  - v0.14.4 is what the v1.1 and v1.2 live proofs used.
  - The server probes the version-sensitive behaviour at runtime: `probeDialect` handles backslash quoting, and `ensureAppendMode` reads `SHOW CREATE TABLE`.
- **The gap is recorded, not hidden.**
  - `status` and `state.json` record the Greptime image tag.
  - `SUBSTRATE_REHEARSAL_GREPTIME_IMAGE` and `SUBSTRATE_REHEARSAL_PG_IMAGE` override the images, if the operator ever loads a v1.x image locally.
  - A later phase whose correctness depends on server-version SQL states the gap in its verification and gets an operator-approved read-only check against production where it matters. This covers Phases 27 and 28 (the anchor DDL, the live `anchors` shape, verify) and any `SHOW CREATE TABLE` parsing. Phase 27's `DESCRIBE anchors` is already planned.
- **Postgres has no gap that matters.** Production is TimescaleDB on pg16 on Railway; locally it is `postgres:16-alpine`. The index uses no Timescale extension: no `create_hypertable` or `CREATE EXTENSION` under `packages/`.

#### Production parity check, runbook and rollback
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

#### Operator window and agent boundaries
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

#### Operator answers (2026-10-08)
- **Unit guard:** approved. `infra/vps/substrate-mcp.service` gains `ConditionPathExists=` on the server entry point and keeps `StartLimitIntervalSec=0`; it takes effect when the operator installs the unit.
- **Parity window:** the operator confirmed they retired the stray pid 3149064 at about 17:14 UTC on 2026-10-08. The runbook records the operator as the actor and that time as the window; criterion 3's evidence is the read-only check run after it.
- **Production probes:** approved for this phase's proof: the read-only `GET /healthz` on `127.0.0.1:7410` and the read-only `count(*)` of `rh-`-tagged rows in production Greptime and Postgres (must be 0). Nothing else touches production.

### Claude's Discretion
- The exact readiness timeouts, the free-disk floor value and the default surface list.
- Whether the server is detached with `Bun.spawn` and `unref` or with `setsid`.
- The format of `state.json`.
- The name and placement of the server-env module inside `packages/mcp-server/src`, as long as the store lock stays unedited.
- Whether the smoke reuses `chaos-smoke.ts`'s HTTP helpers.
- Whether `parity:check` also emits JSON for the runbook log.
- Tests for the harness's pure parts: port refusal, env allowlist, loopback assertion, pid ownership check on `down`. No test needs Docker.

### Deferred Ideas (OUT OF SCOPE)
- **A `commit` or `version` field on `/healthz`.** It would make "serves main" a single probe, but it changes a REST response shape. The read-only host facts prove it without the change. Revisit with the operator if the check proves too fragile.
- **A harness subcommand to pause or unpause the scratch stores** for outage scenarios (Phase 20, scenario 7). For now `docker pause` on the labelled container is enough; Phase 20 decides.
- **Pointing the harness at pre-existing scratch stores**, such as the `substrate-smoke-*` containers, instead of starting fresh ones.
- **Unit files with `ConditionPathExists` and `StartLimit*` guards for the orphaned units** (collectors herdr and Muse, skills sync and bridge, dispatcher, host). Each lands with the phase that restores its code (19, 22, 24, 31). Until then they are inventoried as warnings by `parity:check`, and disabling any of them is an operator action the runbook records.
- **A local GreptimeDB v1.1.x image** for exact version parity. It is blocked by the disk gate and the no-pull rule; the image override variable is the hook.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FOUND-01 | An isolated rehearsal harness starts main's `substrate-mcp` on a scratch port against scratch Postgres and GreptimeDB, with configurable surface tokens, and tears it down. Every v1.3 proof can point `SUBSTRATE_URL` at it, and no production store is touched by it. | Exact server env keys (config.ts §1); verified Greptime v0.14.4 flags, auth syntax and unauthenticated `/health` (§6); postgres image VOLUME + readiness facts (§7); `/healthz` needs a bearer once tokens exist (§2 — pitfall 1); Bun `detached`, fd stdio and `--no-env-file` (§9); store-lock regexes that constrain where and how the env builder is written (§4); smoke request shapes from `chaos-smoke.ts` (§3). |
| FOUND-03 | Production parity, with operator approval: the stray process holding `127.0.0.1:7410` is retired so `substrate-mcp.service` serves `main`; a runbook records the check (unit PID owns the port, `/healthz` answers) and the rollback. | Live read-only probes reproducing criterion 3 today (§8): `MainPID=1525582` owns :7410, cgroup `0::/system.slice/substrate-mcp.service`, `NRestarts=0`, process start 1791479652 > last HEAD move 1791469658, `origin/main` = HEAD = `ab62c91`, zero server-path diff; output formats for each parser; unit diff (installed lacks the `StateDirectory` block); `ConditionPathExists` semantics from `systemd.unit(5)`; `systemd-analyze verify` exits 0 on the repo unit. |
</phase_requirements>

## Summary

Nothing in this phase needs a new dependency. The harness is a Bun script driving the local `docker` CLI and spawning the server with `Bun.spawn({ detached: true })`. The parity check is a Bun script that shells out to `systemctl show`, `ss`, and `git --no-optional-locks`, reads `/proc`, and makes one `fetch`. Both images are on the host (`postgres:16-alpine`, i.e. PG 16.15, and `greptime/greptimedb:v0.14.4`). The disk has 20–21 GiB free on the one filesystem that holds `/`, `/tmp` and `/var/lib/docker`, and 16 GiB of RAM is available for tmpfs.

Four facts shape the plan more than anything else.

1. **The store lock bites inside `packages/mcp-server/src` too.** The "no tracked file carries a Greptime endpoint or credential" test scans every tracked file, so the env builder cannot write a Greptime key followed by `:` or `=` and a value on one line, even though it lives in the exempt package. It has to use computed keys.
2. **`/healthz` is behind the bearer gate** once any surface token is configured, so the harness's own readiness poll has to send a token.
3. **Bun autoloads `.env` files from the cwd.** An allowlisted env is not enough on its own: the server has to be spawned with `bun --no-env-file`, or an untracked `.env` in a worktree leaks production values into the scratch server.
4. **Production is already in parity.** Read-only probes this session reproduce criterion 3 exactly (details in §8). `/healthz` is the only probe left, and it waits for the approved proof step.

**Primary recommendation:**
- Put a pure `buildRehearsalEnv()` (and the stores.env/consumer.env record builders) in `packages/mcp-server/src/rehearsal-env.ts`, tested by round-tripping through `loadConfig()`.
- Put the CLI in `scripts/rehearsal.ts` and `scripts/parity-check.ts`. Guard each `main()` with `import.meta.main` and export the pure parsers and guards so `scripts/*.test.ts` can test them without Docker.
- Spawn the server as `[process.execPath, "--no-env-file", "packages/mcp-server/src/index.ts"]`, detached, with stdio going to an fd opened 0600 on `server.log`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Scratch store lifecycle (pg + greptime containers) | Host ops script (`scripts/rehearsal.ts`) | Docker daemon | Only the docker CLI is used; labels make teardown exact |
| Server env construction (store keys, tokens) | `packages/mcp-server/src/rehearsal-env.ts` | — | Store lock: only this package may name Greptime keys; it also owns `loadConfig`, so the builder is testable against it |
| Scratch server process | API / Backend (`packages/mcp-server/src/index.ts`, unchanged) | Host ops script (spawn/signal) | The code under rehearsal is exactly main's entry point |
| Readiness | Container healthchecks + server `/healthz` | — | Locked: the harness never sends SQL |
| Smoke (brief / emit / register / claim) | HTTP client in `scripts/rehearsal.ts` | — | Same wire path as every real client; store lock rule 1 |
| Parity check | Host ops script (`scripts/parity-check.ts`) | systemd, iproute2, procfs, git | All read-only; no store access |
| Unit guard | `infra/vps/substrate-mcp.service` | systemd (operator install) | No effect until the operator installs it |
| Runbook / harness doc | `docs/runbooks/production-parity.md`, `docs/rehearsal.md` | — | Locked locations |

## Standard Stack

### Core
| Tool | Version (verified on host) | Purpose | Why |
|------|---------|---------|-----|
| Bun | 1.4.0 at `/root/.local/share/reflex/bun/bin/bun` [VERIFIED: `bun --version`, `command -v bun`] | Runtime for scripts and the server | Repo standard (`package.json` engines `"bun": ">=1.4.0"`) |
| Docker Engine / CLI | 29.6.2, overlayfs, root dir `/var/lib/docker` [VERIFIED: `docker info`] | Scratch containers | Already used by the v1.2 proofs |
| `postgres:16-alpine` | PG 16.15, id `721873c34ceb`, 420 MB [VERIFIED: `docker image ls`, `pg_isready --version` in image] | Scratch index | Locked |
| `greptime/greptimedb:v0.14.4` | 0.14.4, commit `e46efb3d6ce6`, id `aec8ebf56117`, 677 MB [VERIFIED: `greptime --version` in image] | Scratch ledger | Locked |
| systemd | 255 (255.4-1ubuntu8.17) [VERIFIED: `systemctl --version`] | Parity check reads | — |
| iproute2 `ss` | 6.1.0 [VERIFIED: `ss -V`] | Port-owner reads | — |
| git | 2.43.0 [VERIFIED] | Read-only reflog/diff/ls-remote | — |

### Supporting
| Item | Purpose | When |
|------|---------|------|
| `node:fs` `statfsSync` | Free-disk floor (works in Bun 1.4.0: printed `21 GiB free` for `/var/lib/docker`) [VERIFIED: probe] | Preflight |
| `node:net` `createServer().listen(port, "127.0.0.1")` probe | "Port already listening" + `--port 0` selection | Preflight |
| `crypto.getRandomValues` / `randomBytes(32).toString("hex")` | Scratch passwords, tokens, handoff key | `up` |
| `systemd-analyze verify` | Lint the unit file read-only (exit 0 on current repo unit) [VERIFIED] | Unit-file task verification |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `Bun.spawn({ detached: true })` | `setsid bun …` (`/usr/bin/setsid` exists) | Both are setsid(2). Bun's option is in-process and typed (bun.d.ts:7042-7056); use it |
| Greptime credentials via an in-container file written from an env var | `--user-provider=static_user_provider:cmd:u=p` | `cmd:` puts the password in the container argv, which is world-readable `/proc/<pid>/cmdline` on the host. Upstream docs say to use a file for deployment |
| Fail-closed when origin/main's sha is not local | `gh api repos/swcstudiospace/agent-substrate/compare/<HEAD>...<sha>` (gh 2.45.0 present) | Read-only network fallback; adds an auth dependency. Recommend fail-closed + operator fetch; gh optional |

**Installation:** none. No package is added.

## Package Legitimacy Audit

No external package is installed by this phase (no `package.json` dependency change; the images are already local and `--pull never`).

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| — | — | — | — | — | — | — |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Grounded Facts the Planner Needs

### §1 Server configuration keys — `packages/mcp-server/src/config.ts`

[VERIFIED: packages/mcp-server/src/config.ts:110-113, 120-127, 137-151, 153-191] Verbatim:

```ts
// 111-113
export function tokenEnvName(surface: Surface): string {
	return `SUBSTRATE_TOKEN_${surface.toUpperCase().replace(/-/g, "_")}`;
}
// 154
const greptimeUrl = env.GREPTIME_URL?.trim();
// 159-160
host: env.SUBSTRATE_HOST?.trim() || "127.0.0.1",
port: Number(env.SUBSTRATE_PORT ?? 7410),
// 164-166
user: env.GREPTIME_USER,
password: env.GREPTIME_PASSWORD,
db: env.GREPTIME_DB?.trim() || "public",
// 169
postgresUrl: env.SUBSTRATE_PG_URL?.trim() || undefined,
// 176
allowAnonymous: readTokens(env).size === 0,
// 177-182
operatorTokens: new Set(
	(env.SUBSTRATE_OPERATOR_TOKENS ?? "")
		.split(",")
// 188-189
audit: { path: env.SUBSTRATE_AUDIT_PATH?.trim() || null },
requireRecordedClaims: booleanOrNull(env.SUBSTRATE_CLAIM_REQUIRE_LEDGER),
// 142-145
const active = env.SUBSTRATE_HANDOFF_KEY?.trim();
const activeId = env.SUBSTRATE_HANDOFF_KEY_ID?.trim() || "k1";
```

Consequences:
- `SUBSTRATE_OPERATOR_TOKENS` holds **token values**, comma-separated, and each must also be a `SUBSTRATE_TOKEN_*` value. Otherwise `configWarnings` reports "an operator token is not also a SUBSTRATE_TOKEN_* surface token, so it cannot authenticate at all" (config.ts:291-295).
- A swarm surface is never an operator (config.ts:241-246, `isOperator` returns `!isSwarmSurface(...)`). `--operator` must reject `swarm-*`.
- Valid surfaces are `SURFACES` in `types.ts:30-43`: `"claude-code"`, `"cursor"`, `"hermes"`, `"omp"`, `"muse"`, `"grok-build"`, `"grok-bot"`, `"codex"`, `"opencode"`, `"pi"`, `"rivet-agentos"`, `...SWARM_SURFACES` [VERIFIED: types.ts:30-43]. `--surfaces` should validate against this list (import it; the list lives in the exempt package, but importing `types.ts` is fine from scripts, since it does not name the ledger).
- `SUBSTRATE_CLAIM_REQUIRE_LEDGER` should be **left unset**: with a ledger configured it defaults to fail-closed (config.ts:100-107 doc), which is production's shape.
- `swarmTokenWarnings` (config.ts:323-333) prints a "no token for N swarm surfaces" line at boot for any token-configured instance without swarm tokens. Expected noise in `server.log`; not a failure.
- `SUBSTRATE_AUDIT_PATH` is a **file** path (`.env.example:133` `SUBSTRATE_AUDIT_PATH=/var/lib/substrate/mcp-audit.jsonl`; tests use `join(mkdtempSync(...), "mcp-audit.jsonl")` at http.test.ts:64-66). Use `<rundir>/mcp-audit.jsonl`.
- Observability reads `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `SUBSTRATE_INSTANCE_ID`, `SUBSTRATE_ENV` [VERIFIED: packages/observability/src/config.ts:69-93]. Export is off unless an endpoint is set, so the allowlist alone guarantees no export to a production collector.

### §2 `/healthz` and the auth gate — `packages/mcp-server/src/server.ts`

[VERIFIED: server.ts:254-257] The 401 gate runs **before** any route, `/healthz` included:

```ts
if (!config.allowAnonymous && surface === null) {
	sendJson(res, 401, { error: "unknown or missing bearer token" });
	return;
}
```

[VERIFIED: server.ts:260-277] `/healthz` body is `...health` plus `auditDurable`, `auditRecords`, and `auditMissingHistory` when set. Status comes from `healthStatus` [VERIFIED: server.ts:61-67]:

```ts
if (ledgerConfigured && !health.eventsWritable) return 503;
return health.index || health.greptime ? 200 : 503;
```

[VERIFIED: service.ts:1467-1486] `health()` returns `index`, `greptime`, `appendOnly`, `quotingDialectKnown`, `eventsWritable`, where `eventsWritable: greptime && quotingDialectKnown && (appendOnly === true || this.config.allowDeduplicatingLedger)`.

Consequences:
- The `up` readiness poll must send `authorization: Bearer <first token>` unless `--anonymous`.
- `parity:check` against production gets 200 today (production is anonymous; journal line "anonymous" in CONTEXT). After Phase 20 provisions tokens it will get 401. Design the check to send `SUBSTRATE_TOKEN` from the caller's own environment when set (never printed), and to report 401 as "auth configured; set SUBSTRATE_TOKEN", not as "not answering".
- `appendOnly` on the scratch ledger depends on the server's own `migrate()` creating `agent_events` `WITH ('append_mode' = 'true')` (greptime.ts:380-388). v0.14.4 supports it (the v1.2 proofs ran on it per CONTEXT). The `healthz` predicate already covers it.

### §3 Smoke request shapes (reuse from `scripts/chaos-smoke.ts`)

[VERIFIED: scripts/chaos-smoke.ts:62-73] headers. `/mcp` answers **406** unless both media types are accepted:

```ts
"content-type": "application/json",
accept: "application/json, text/event-stream",
...(token ? { authorization: `Bearer ${token}` } : {}),
```

- [VERIFIED: chaos-smoke.ts:84-102] `parseBody` parses bare JSON, else the last `data:` SSE frame.
- [VERIFIED: chaos-smoke.ts:146-148] A tool call is one stateless JSON-RPC POST, with no `initialize`: `{ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }`. The transport is stateless: `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` [VERIFIED: server.ts:531].
- [VERIFIED: chaos-smoke.ts:162-172] `toolResult` reads `body.result.content[0].text` and parses it as JSON.

Routes and success signals:

| Step | Request | Success | Source |
|------|---------|---------|--------|
| brief | `POST /brief` `{repo, branch, graph_id}` | `200`, `text/markdown; charset=utf-8` | server.ts:316-327 |
| emit | `POST /events` `{surface, kind: "note", summary, graph_id, session_id}` | `202` and `stored: true` (`503` when the ledger refused) | server.ts:330-357 |
| register | MCP `graph_register` `{graph_id, repo, branch, nodes: [{node_id}]}` | `toolResult !== null` | mcp.ts:436-489; chaos-smoke.ts:213-219 |
| claim | MCP `graph_claim` `{graph_id, node_id, session_id}` | `claimed === true` and `decision === "granted"` | mcp.ts:548-572; service.ts:308-321, 990-1002 |

- **Attribution:** for a non-swarm token, a supplied `surface` wins, then the token's own, then `claude-code` (mcp.ts:91-97). Send the first surface's name (or omit it) so the emit is attributed to the token.
- **Do not print the claim reply.** `lease.lease_id` is a capability (service.ts:312, 993-996). Print only `claimed` / `decision` / `action`.
- Chaos-smoke's helpers live in a script with top-level side effects (it runs on import), so they **cannot be imported**. Copy the ~40 lines or lift them into a small shared module (e.g. `scripts/lib/http.ts`); copying is the boring choice and keeps chaos-smoke untouched.

### §4 Store lock — exact rules that constrain file placement and spelling

[VERIFIED: packages/mcp-server/src/store-lock.test.ts:34, 39-41, 72, 75-80, 95, 108-130, 268-278, 324-333] Verbatim:

```ts
const SMOKE_HARNESS = join("scripts", "greptime-smoke.ts");
function mayReachLedger(path: string): boolean {
	return path.startsWith(LEDGER_PACKAGE) || path === SMOKE_HARNESS;
}
const CREDENTIAL = /GREPTIME_(?:URL|USER|PASSWORD)["']?\s*[:=]\s*["']?[^\s"']/i;
const RAILWAY_HOST = /[a-z0-9-]+\.(?:up\.railway\.app|proxy\.rlwy\.net)/i;
const TOKEN_LITERAL = /SUBSTRATE_TOKEN[A-Z0-9_]*["']?[ \t]*[:=][ \t]*["']?(?!process\.env|os\.environ|Bun\.env|env\.)[\w.~+/=-]{16,}/;
```

| Rule (test) | Scope | What it means for this phase |
|---|---|---|
| imports: `/from\s+["'][^"']*greptime(\.ts)?["']\|new\s+GreptimeClient/` (108-114) | every `**/*.ts` outside the package and the smoke | Never import a module whose specifier ends in `greptime`. Name the env module `rehearsal-env.ts`, not `greptime-*` |
| `/(FROM\|INTO\|UPDATE\|TABLE)\s+"?agent_events"?/i` (116-122) | same | Scripts and their tests must not contain the production-count SQL. Keep it in the runbook (`.md` is not scanned by this rule) |
| `/GREPTIME_/` anywhere (124-130) | same | `scripts/rehearsal.ts`, `scripts/parity-check.ts` and **any `scripts/*.test.ts`** must not contain the substring at all, not even in a comment |
| `carriesCredential` = CREDENTIAL or RAILWAY_HOST on any non-comment line (75-80, 268-278) | **every tracked file**, the exempt package and `.planning/` and `docs/` included | Inside `rehearsal-env.ts` and its test, an object literal or assignment that writes a Greptime URL/USER/PASSWORD key directly followed by `:` or `=` and a variable name **fails** (key, then `:`/`=`, then a non-space, non-quote character). This research file cannot even show the bad spelling, because it would fail the same test. Use computed keys (pattern below). In docs, write key names only, never `KEY=value` |
| TOKEN_LITERAL (95, 324-333) | every tracked file, comments **not** exempt | No substrate token key followed by `:`/`=` and 16+ characters of `[\w.~+/=-]` anywhere. This catches a long identifier too: a token key followed by a colon and an identifier such as `firstSurfaceTokenValue` matches. Use short identifiers or computed keys; tests generate tokens at runtime |
| comment exemption `/^\s*(?:#\|\/\/\|\*\|<!--)/` (78) | CREDENTIAL/RAILWAY only | Doc-comments in `.ts` may name keys with example values; markdown table rows and prose are not exempt |

Safe spelling for the env builder, verified against the CREDENTIAL regex by inspection: after the key comes `"` and then `,` or `]`, never `\s*[:=]`.

```ts
// packages/mcp-server/src/rehearsal-env.ts — shape only
const LEDGER_KEYS = { url: "GREPTIME_URL", user: "GREPTIME_USER", password: "GREPTIME_PASSWORD", db: "GREPTIME_DB" } as const;
const env: Record<string, string> = {};
env[LEDGER_KEYS.url] = `http://127.0.0.1:${ports.greptime}`;
env[LEDGER_KEYS.user] = scratch.greptimeUser;
```

### §5 Entry point behaviour — `packages/mcp-server/src/index.ts`

[VERIFIED: index.ts:16, 28-45, 50-65]
- `loadConfig()` reads `process.env` (index.ts:16).
- It migrates on boot (28), then listens and prints `` `[substrate] listening on http://${config.host}:${config.port} ` `` with the stores, the auth mode and the audit state (39-44).
- SIGINT/SIGTERM call `server.close(...)`, a bounded 2 s OTLP flush, then `process.exit(0)` (50-65).
- `down` can SIGTERM and wait. `server.close` waits for open keep-alive sockets, so give `down` a bounded wait (e.g. 10 s). Then SIGKILL **the same verified pid**, re-checking identity first.

### §6 GreptimeDB v0.14.4 standalone (image present locally)

- **Flags** [VERIFIED: `docker run --rm --pull never --network none greptime/greptimedb:v0.14.4 standalone start --help`]: `--http-addr`, `--rpc-bind-addr`, `--mysql-addr`, `--postgres-addr`, `--user-provider <USER_PROVIDER>`, `--data-home <DATA_HOME>`, `--log-dir`, `--env-prefix [default: GREPTIMEDB_STANDALONE]`.
- **Image config** [VERIFIED: `docker image inspect`]: Entrypoint `["sh","-c","exec $TARGET_BIN \"$@\"","--"]`, Env includes `TARGET_BIN=greptime` and `PATH=/greptime/bin/:…`. **No `ExposedPorts`, no `Healthcheck`, no `Volumes`**, WorkingDir `/`. The image ships `/usr/bin/curl` and `bash`, but no `wget` or `nc` [VERIFIED: probe in `--network none` container].
- **Bind address:** the long-lived `substrate-smoke-greptime` runs `["standalone","start","--http-addr","0.0.0.0:4000"]` published as `127.0.0.1:54000->4000/tcp` [VERIFIED: `docker inspect substrate-smoke-greptime`]. The harness must also pass `--http-addr 0.0.0.0:4000` (inside the container) and publish `-p 127.0.0.1::4000`.
- **User provider syntax (v0.14.4 source)** [VERIFIED: greptimedb tag v0.14.4 `src/auth/src/common.rs:38-47`, `src/auth/src/user_provider/static_user_provider.rs:24, 31-51`, `src/auth/src/user_provider.rs:85-89`]:
  - The option is `<provider>:<value>`, with provider `static_user_provider`.
  - The value is `file:<path>` or `cmd:<user=pwd[,user=pwd]>`.
  - File lines are `user=pwd`, split on the first `=`.
  - v0.14.4 has **no** permission-mode suffix and **no** `plain:` prefix parsing; those are v1.1+ per the current docs [CITED: docs.greptime.com/user-guide/deployments-administration/authentication/static].
  - Generate hex-only secrets (no `=`, `,`, `:`).
- **`/health` is unauthenticated** [VERIFIED: greptimedb v0.14.4 `src/servers/src/http/authorize.rs:271-281`]: `need_auth` returns `path.starts_with(HTTP_API_PREFIX)` after the `PUBLIC_APIS` exemptions, and `HTTP_API_PREFIX` is `"/v1/"` (http.rs:111-112). `/health` is mounted at the root (http.rs:703-706, `routing::get(handler::health)`). So `curl -fsS http://127.0.0.1:4000/health` inside the container works with a user provider set, and the harness sends no SQL and no credential to get readiness.
- **Data dir:** `--data-home` exists. Its default for v0.14 is `[ASSUMED]` (`./greptimedb_data` relative to WorkingDir `/`). Set `--data-home /greptimedb_data` explicitly and put `--tmpfs /greptimedb_data` on the same path.
- **Credentials without argv exposure:** upstream warns "Command-line credentials can appear in shell history and process listings; use a credential file for deployment" [CITED: same docs page]. Two compliant shapes:
  - **Recommended (no mount):** `--entrypoint sh` with `-e RH_GT_USERS` (the value comes from the docker CLI process env; the argv carries the name only), and `-c 'umask 077; printf "%s\n" "$RH_GT_USERS" > /tmp/rh-users && exec greptime standalone start --http-addr 0.0.0.0:4000 --data-home /greptimedb_data --user-provider=static_user_provider:file:/tmp/rh-users'`. `/tmp` in the container is on its writable layer, which `--rm` deletes. `[ASSUMED]` that `/tmp` exists and is writable in the image; the planner's first `up` run proves it.
  - **Alternative:** a read-only bind of a 0600 `<rundir>/greptime-users` file. This conflicts with the letter of "no volumes", so prefer the first.

### §7 postgres:16-alpine

- [VERIFIED: `docker image inspect`] `Volumes: {"/var/lib/postgresql/data":{}}` and `PGDATA=/var/lib/postgresql/data`. **Without `--tmpfs /var/lib/postgresql/data`, Docker creates an anonymous volume.** `substrate-smoke-pg` has exactly that: a `Type: volume` mount at that path [VERIFIED: `docker inspect substrate-smoke-pg`]. `--rm` removes anonymous volumes, but `--tmpfs` on that exact path avoids creating one at all.
- [VERIFIED: in-image `/usr/local/bin/docker-entrypoint.sh:297`] The init-time temp server runs with `-c listen_addresses=''`, so it is not reachable over TCP. **Use `pg_isready -h 127.0.0.1 -U postgres`** in the healthcheck, so the container is not reported ready during the init phase (a socket-based `pg_isready` can pass before the final restart).
- [VERIFIED: entrypoint:235-238] `file_env 'POSTGRES_PASSWORD'`, `POSTGRES_USER` defaults to `postgres`, and `POSTGRES_DB` defaults to the user. Pass the password as `-e POSTGRES_PASSWORD` (name only; the value comes from the spawn env) so it is never in the `docker run` argv.
- The precedent healthcheck shape on this host: `{"Test":["CMD-SHELL","pg_isready -U rakazo -d rakazo"],"Interval":5000000000,…}` [VERIFIED: `docker inspect rakazo-postgres-1`].

### §8 Host state and parser formats (all read-only, run this session)

`systemctl show substrate-mcp -p MainPID,ActiveState,SubState,NRestarts,ExecMainStartTimestamp,WorkingDirectory,ExecStart,FragmentPath,ConditionResult,Result` printed **in systemd's own order, not the `-p` order**, so parse it as `key=value` lines into a map [VERIFIED]:

```
MainPID=1525582
Result=success
NRestarts=0
ExecMainStartTimestamp=Thu 2026-10-08 17:14:12 UTC
ExecStart={ path=/root/.local/share/reflex/bun/bin/bun ; argv[]=/root/.local/share/reflex/bun/bin/bun packages/mcp-server/src/index.ts ; … pid=1525582 ; … }
WorkingDirectory=/root/src/repos/agent-substrate
ActiveState=active
SubState=running
FragmentPath=/etc/systemd/system/substrate-mcp.service
ConditionResult=yes
```

- `--timestamp=unix` gives machine timestamps: `ExecMainStartTimestamp=@1791479652`. `ControlGroup=/system.slice/substrate-mcp.service` and `InvocationID=a9c0…` are also available [VERIFIED].
- `ss -ltnpH 'sport = :7410 or …'` [VERIFIED]:
  ```
  LISTEN 0 512 127.0.0.1:7410 0.0.0.0:* users:(("bun",pid=1525582,fd=21))
  ```
  The parser must collect **every** `pid=N` in `users:(…)`, because a forked socket lists several. Pass only when the set is exactly `{MainPID}`. Also match `[::1]:7410` and `*:7410` / `0.0.0.0:7410` as holders. `6420` is held by `docker-proxy` (rivet engine), which is why it is refused.
- `/proc/1525582/cgroup` = `0::/system.slice/substrate-mcp.service` (cgroup v2 single line). `readlink /proc/1525582/cwd` = `/root/src/repos/agent-substrate`. `/proc/1525582/cmdline` (NUL-separated) = `/root/.local/share/reflex/bun/bin/bun packages/mcp-server/src/index.ts` [VERIFIED].
- **Process start time** = `btime` (from `/proc/stat`) + field 22 of `/proc/<pid>/stat` / `CLK_TCK`. Here 1790699914 + 77973817/100 = 1791479652.17, matching `ExecMainStartTimestamp=@1791479652` [VERIFIED]. Parse field 22 after the last `)` in `stat`, because `comm` can contain spaces.
- **Last HEAD move:**
  - `git --no-optional-locks -C /root/src/repos/agent-substrate log -g -n 1 --format='%H %gd %gs' --date=unix HEAD` prints `ab62c918… HEAD@{1791469658} pull origin main: Fast-forward` [VERIFIED]. The reflog timestamp is inside `HEAD@{…}`. `%ct` is the **commit** time, not the move time, so do not use it.
  - Equivalent without git: the last line of `.git/logs/HEAD` has the unix time as the second-to-last field before the tab (`… 1791469658 +0000`) [VERIFIED].
  - Prefer `git log -g`, because it resolves worktree gitdirs.
- 1791479652 (process start) > 1791469658 (HEAD move) ⇒ the process started after the checkout last moved.
- `git --no-optional-locks -C <wd> status --porcelain=v1 -- packages package.json bun.lock` prints nothing (clean) [VERIFIED].
- `git --no-optional-locks -C <wd> ls-remote origin refs/heads/main` prints `ab62c918ff7790a64fb4119e54c54d60a2e0d947	refs/heads/main`. It took 1.2 s over HTTPS (`github.com/swcstudiospace/agent-substrate.git`) and writes nothing to `.git` [VERIFIED].
- **Origin commit present locally?** `git cat-file -e '<sha>^{commit}'` exits 0 when it is, and **128** with `fatal: Not a valid object name` when it is not [VERIFIED]. When present: `git diff --name-only HEAD <sha> -- packages package.json bun.lock` (a tree diff, so it is right even if HEAD has local commits) prints 0 lines today [VERIFIED]. When absent: fail closed with "origin/main <sha> is not in the local object store; fetching is an operator action". Never fetch.
- **Unit diff** [VERIFIED: `cat /etc/systemd/system/substrate-mcp.service` vs `infra/vps/substrate-mcp.service`]: identical except that the installed copy lacks repo lines 21-27, the comment block plus `StateDirectory=substrate` and `StateDirectoryMode=0700`.
- **Other units** [VERIFIED: `systemctl list-units 'substrate-*' --all --no-legend --plain`]:
  - running: `substrate-collector-grok`, `substrate-collector-herdr`, `substrate-collector-muse`, `substrate-dispatcher`, `substrate-mcp`;
  - `inactive dead`: `substrate-host`;
  - `failed`: `substrate-skills-bridge.service`, `substrate-skills-sync.service`;
  - both `.timer`s are `active waiting`.
  - `systemctl show a b -p …` prints blank-line-separated blocks.
- **Agent session cgroup** is `0::/user.slice/user-0.slice/session-457.scope` [VERIFIED: `/proc/self/cgroup`], so a harness-spawned server is in `user.slice`, never `system.slice`. The `down` check "not in system.slice" is meaningful.

### §9 Bun specifics

- `Bun.spawn({ detached: true })` calls `setsid()`. The docs note: "stdio may keep the parent process alive. Pass `stdio: ["ignore", "ignore", "ignore"]`…" [VERIFIED: bun-types@1.4.0 bun.d.ts:7042-7056]. stdout/stderr accept a `number` fd or a `BunFile` (bun.d.ts:7002-7010). Open `server.log` with `openSync(path, "a", 0o600)` and pass the fd for both, then `proc.unref()`.
- **Bun autoloads `.env` files from the cwd.** `bun --help` lists `--no-env-file  Disable automatic loading of .env files` [VERIFIED]. `.gitignore` lines 7-9 ignore `.env` and `.env.*` (except `.env.example`), so any worktree may hold an untracked `.env`. Spawn the server with `--no-env-file`. Neither checkout has a `.env` today [VERIFIED: listing], which is luck, not a guard.
- `node:fs` `statfsSync` works in Bun 1.4.0 [VERIFIED: probe].
- `import.meta.main` is true only for the entry module [CITED: bun.sh/docs/api/import-meta]. Use it so `scripts/rehearsal.ts` and `scripts/parity-check.ts` can export pure functions for tests without running on import (chaos-smoke cannot be imported for exactly this reason).
- **Test discovery:** `bun test` finds `*.test.ts` recursively from the root. All 40 tracked test files are under `packages/*` today (25 in `packages/mcp-server`), and `tsconfig.json` includes `"scripts/**/*.ts"` (line 16). A new `scripts/*.test.ts` is typechecked and run by the existing commands [VERIFIED: tsconfig.json:16; `git ls-files '*.test.ts'`].

## Architecture Patterns

### System Architecture Diagram

```
                     bun run rehearsal up --name N [--port P] [--surfaces …] [--operator s] [--anonymous]
                                              │
                ┌─────────────────────────────▼─────────────────────────────┐
                │ preflight: name ok · docker info · image inspect ×2 ·     │
                │ statfs ≥ floor · port ∉ {7410,7411,6420} & bind-probe ok · │
                │ cwd ≠ unit WorkingDirectory · node_modules present        │
                └─────────────────────────────┬─────────────────────────────┘
                        refuse ◄──fail────────┤
                                              ▼
       random secrets (hex) ──► rundir ${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/N (0700)
                                              │
            ┌─────────────────────────────────┼──────────────────────────────────┐
            ▼                                 ▼                                  │
  docker run --rm --pull never        docker run --rm --pull never               │
   -p 127.0.0.1::5432 --tmpfs PGDATA   -p 127.0.0.1::4000 --tmpfs data-home       │
   --health-cmd pg_isready -h 127…     --health-cmd curl /health                  │
   label substrate.rehearsal=N         label substrate.rehearsal=N                │
            │                                 │                                  │
            └──► docker inspect .State.Health ◄┘  (poll until healthy)            │
                              │ docker port → host ports                         │
                              ▼                                                  │
     buildRehearsalEnv() [packages/mcp-server/src/rehearsal-env.ts]              │
       allowlist(PATH, HOME, BUN_*) + loopback store URLs + tokens + audit path  │
       assertLoopback(urls, ownPorts) ── fail ──► docker rm -f label; refuse     │
                              ▼                                                  │
     Bun.spawn([bun, --no-env-file, packages/mcp-server/src/index.ts],           │
               {cwd: checkout, env, detached, stdio→server.log fd}).unref()      │
                              ▼                                                  │
     poll GET /healthz (Bearer first token) until 200 ∧ index ∧ greptime ∧       │
       eventsWritable ── timeout ──► kill own pid, rm label, keep log, exit 1    │
                              ▼                                                  │
     write state.json, consumer.env, stores.env, tokens/<surface> (0600) ◄───────┘
     print: consumer.env path, URL, commit, dirty, image tags (no secret)

 later proofs: set -a; . consumer.env; set +a ──► SUBSTRATE_URL ──► scratch server ──► scratch stores
 rehearsal smoke: consumer.env → refuse :7410/non-loopback → /brief → /events → graph_register → graph_claim
 rehearsal down: state.json pid → verify cmdline, cwd, starttime, cgroup ∉ system.slice, not on 7410
                 → SIGTERM → wait → (SIGKILL same verified pid) → docker rm -f $(label=N) → rm -rf rundir

 bun run parity:check (read-only):
   systemctl show ─┐
   ss -ltnpH ──────┼─► MainPID == owner(127.0.0.1:7410) ∧ cgroup == system.slice/substrate-mcp.service
   /proc/<pid> ────┤   ∧ active ∧ NRestarts not grown ∧ start stable
   GET /healthz ───┤   ∧ 200
   git (no locks) ─┘   ∧ cwd == WorkingDirectory ∧ start > last HEAD move ∧ clean paths ∧ no path diff to ls-remote main
                       warnings: unit-file diff · other substrate-* units inventory
                       exit 0 | 1
```

### Recommended Project Structure
```
packages/mcp-server/src/
├── rehearsal-env.ts        # pure: buildRehearsalEnv, storesEnvRecord, consumerEnvRecord, assertLoopback (names Greptime keys via computed keys only)
└── rehearsal-env.test.ts   # round-trip through loadConfig/configWarnings; allowlist; no inherited leak
scripts/
├── rehearsal.ts            # CLI up|down|status|smoke; exports pure guards; main() under import.meta.main
├── rehearsal.test.ts       # port refusal, name validation, pid-ownership decision, scratch-URL guard, parse docker port output
├── parity-check.ts         # CLI; exports parsers; main() under import.meta.main
└── parity-check.test.ts    # parseSystemctlShow, parseSsListeners, parseCgroup, procStartSeconds, parseReflogTime, verdict()
docs/
├── rehearsal.md            # consumer.env contract; harness vs CHAOS_REHEARSAL naming
└── runbooks/production-parity.md
infra/vps/substrate-mcp.service   # + ConditionPathExists=/root/src/repos/agent-substrate/packages/mcp-server/src/index.ts
package.json                       # + "rehearsal": "bun scripts/rehearsal.ts", "parity:check": "bun scripts/parity-check.ts"
```
(`scripts/*.test.ts` must never contain the substring `GREPTIME_`.)

### Pattern 1: Pure decisions, thin effects
**What:** Every refusal and verdict is a pure function over parsed inputs. Examples: `refusePort(port, listening)`, `ownsInstance(proc, state)`, `parityVerdict(facts)`. The CLI gathers facts with `Bun.spawnSync`, `/proc` reads and `fetch`, then calls the pure function.
**When:** All of `down`'s pid checks, port refusal, the smoke's scratch-URL guard, and every parity criterion.
**Example (shape):**
```ts
export interface ProcFacts { pid: number; argv: string[]; cwd: string; cgroup: string; startSeconds: number; listensOn: number[] }
export function mayStop(proc: ProcFacts, state: { pid: number; checkout: string; startSeconds: number }): string | null {
	if (proc.pid !== state.pid) return "pid differs from state.json";
	if (proc.startSeconds !== state.startSeconds) return "pid was reused (start time differs)";
	if (!proc.argv.at(-1)?.endsWith("packages/mcp-server/src/index.ts")) return "not the substrate-mcp entry point";
	if (proc.cwd !== state.checkout) return "cwd is not the recorded checkout";
	if (proc.cgroup.includes("/system.slice/")) return "process is in system.slice";
	if (proc.listensOn.some((port) => [7410, 7411, 6420].includes(port))) return "process owns a production port";
	return null;
}
```
The start-time check is a recommended addition to the locked list: it is the only guard against pid reuse after a crash, and it costs one `/proc/<pid>/stat` read.

### Pattern 2: Secrets reach children by name, never by argv
- **Postgres:** `docker run … -e POSTGRES_PASSWORD …` with `env: { ...minimalDockerEnv, POSTGRES_PASSWORD: pw }` on the `Bun.spawn` of the docker CLI.
- **Greptime:** the same with `-e RH_GT_USERS` and the in-container file (§6).
- **Server:** a full env object, with no argv secret.
- **Files:** `writeFileSync(path, body, { mode: 0o600 })` inside a 0700 dir created with `mkdirSync(dir, { recursive: true, mode: 0o700 })`. Then `chmodSync` explicitly, because `mkdirSync`'s mode is masked by the umask.

### Pattern 3: consumer.env is sourceable sh
Use single-quoted `export KEY='value'` lines. Values are hex or URLs and contain no single quote. The PG URL carries the password, which is why the file is 0600. `SUBSTRATE_REHEARSAL_TOKENS_DIR` points at `tokens/` with one file per surface, named by surface, containing only the token.

### Anti-Patterns to Avoid
- **Inheriting `process.env` into the server or the docker CLI.** Build from an allowlist. The docker CLI needs `PATH`, `HOME` (for `~/.docker/config.json`), and `DOCKER_HOST`/`DOCKER_CONFIG` if set.
- **`docker run -e KEY=value`.** It puts the secret in argv, visible in `ps`.
- **Asserting readiness with SQL.** This is locked out. Container health and `/healthz` cover it.
- **Matching containers by name prefix only.** Always filter by `label=substrate.rehearsal=<name>`; never `docker ps -a | grep substrate`, which would hit `substrate-smoke-*` and `substrate-desktop`.
- **`git fetch` / `git status` without `--no-optional-locks`** in the operator checkout. Plain `status` may rewrite the index.
- **Printing `/healthz` JSON wholesale in `parity:check`.** It is fine (no secret), but keep output to PIDs, states, commits and statuses, per the lock.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Waiting for Postgres | TCP connect loop / SQL ping | `--health-cmd 'pg_isready -h 127.0.0.1 -U postgres'` + poll `docker inspect -f '{{.State.Health.Status}}'` | Avoids init-phase false-ready (entrypoint:297) and keeps the harness SQL-free |
| Waiting for Greptime | `SELECT 1` | `--health-cmd 'curl -fsS http://127.0.0.1:4000/health'` (curl is in the image) | Unauthenticated by design (authorize.rs:271-281) |
| Free host ports for containers | port scanner | `-p 127.0.0.1::<port>` + `docker port <ctr> <port>/tcp` | Docker allocates atomically |
| Detaching | double-fork, nohup | `Bun.spawn({ detached: true })` + `unref()` | setsid(2) per bun.d.ts |
| Server config validation | a re-implementation | `loadConfig()` + `configWarnings()` on the built env in tests | Single source of truth |
| Unit file lint | regex | `systemd-analyze verify infra/vps/substrate-mcp.service` | Exit 0 today; read-only |
| Disk free | `df` text parsing | `statfsSync(path).bavail * bsize` | Verified in Bun 1.4.0 |

**Key insight:** every hard part (readiness, port allocation, config semantics, auth semantics) already has an authoritative implementation either in the image or in `packages/mcp-server/src`. The harness only orchestrates.

## Runtime State Inventory

This is a parity/migration-style phase. It also creates runtime state of its own.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Production `agent_events` / graph tables must receive no `rh-` row. Scratch stores are tmpfs and vanish with `--rm` | Operator-approved prefix counts (= 0) recorded in the proof; no migration |
| Live service config | Installed `/etc/systemd/system/substrate-mcp.service` lacks repo lines 21-27 (`StateDirectory` block); the repo unit gains `ConditionPathExists=` | Operator installs in an approved window (runbook); agents never edit `/etc/systemd` |
| OS-registered state | `substrate-mcp.service` MainPID 1525582 since 17:14:12 UTC, `NRestarts=0`. Orphaned/failed units: dispatcher, host, skills-sync, skills-bridge (plus timers), herdr/muse collectors | Read-only inventory as `parity:check` warnings; no action this phase (deferred) |
| Secrets/env vars | `/etc/substrate/substrate.env` is not read by anything in this phase. Scratch secrets live only in the 0600 run-dir files and the server/container env | None; documented by name only |
| Build artifacts | A fresh worktree of `main` needs `node_modules` (`@modelcontextprotocol/sdk` etc.) before `bun packages/mcp-server/src/index.ts` can start. Harness server processes look exactly like the old stray (`bun packages/mcp-server/src/index.ts` outside system.slice) | Preflight refuses with a "run `bun install --frozen-lockfile`" message (the harness does not install). The runbook tells the operator how to tell a harness twin (port ≠ 7410, cwd = worktree, `state.json`) from a stray |

## Common Pitfalls

### Pitfall 1: `/healthz` returns 401 on a token-configured twin
**What goes wrong:** `up` waits forever or reports "unhealthy".
**Why:** server.ts:254-257 gates every route, `/healthz` included.
**How to avoid:** send `Bearer <first surface token>` unless `--anonymous`. `parity:check` uses `SUBSTRATE_TOKEN` if present and reports 401 distinctly.
**Warning signs:** `{"error":"unknown or missing bearer token"}` in the poll.

### Pitfall 2: The store lock fires on the exempt package
**What goes wrong:** `store-lock.test.ts` "no tracked file carries a Greptime endpoint or credential" fails on `rehearsal-env.ts`, its test, `docs/rehearsal.md` or the runbook.
**Why:** CREDENTIAL scans all tracked files, regardless of package; only `#`, `//`, `*`, `<!--` lines are exempt.
**How to avoid:** use computed keys (§4); in tests, assert `env[LEDGER_KEYS.url]`; in docs, name keys without values.
**Warning signs:** a line where a Greptime URL/USER/PASSWORD key is followed by `:` or `=` and a value.

### Pitfall 3: `GREPTIME_` in a scripts test
**What goes wrong:** the "nothing else reads GREPTIME_" test fails on `scripts/rehearsal.test.ts`.
**How to avoid:** test store env content only in `packages/mcp-server/src/rehearsal-env.test.ts`; script tests treat `stores.env` as opaque.

### Pitfall 4: Bun `.env` autoload leaks production values into the twin
**What goes wrong:** a worktree with an untracked `.env` (allowed by `.gitignore`) injects `LINEAR_API_KEY`, `OTEL_*` or production `SUBSTRATE_TOKEN_*` into the server, even though the env object was allowlisted.
**How to avoid:** spawn `bun --no-env-file …`. Add a test asserting that the spawn argv contains `--no-env-file`.

### Pitfall 5: Anonymous Docker volume from the postgres image
**What goes wrong:** the disk fills slowly, and data outlives the run if `--rm` is ever dropped.
**How to avoid:** `--tmpfs /var/lib/postgresql/data` (the image's declared VOLUME path).

### Pitfall 6: pg reported ready during init
**What goes wrong:** the server's `migrate()` races the entrypoint's restart and the index comes up "degraded".
**How to avoid:** `pg_isready -h 127.0.0.1`. Whether a degraded boot migration is retried later was not checked, so `up` must treat a `/healthz` without `index: true` at the deadline as a failed `up` (kill own pid, remove the labelled containers, keep `server.log`).

### Pitfall 7: Greptime bound to container loopback
**What goes wrong:** the published port is unreachable.
**How to avoid:** `--http-addr 0.0.0.0:4000` inside the container, as `substrate-smoke-greptime` does.

### Pitfall 8: pid reuse / killing the wrong process on `down`
**How to avoid:** check the recorded start time (from `/proc/<pid>/stat` at `up`) as well as cmdline, cwd, cgroup and port, and re-check immediately before any SIGKILL. Never signal a negative pid (process group): `detached` makes the child a group leader, but the lock says "only the pid recorded".

### Pitfall 9: The harness becomes the next stray
**What goes wrong:** a crashed `up` or a forgotten instance leaves a detached `bun …/index.ts` running for days. Its signature matches what the operator just retired.
**How to avoid:** `--port` refuses 7410 and the harness refuses to run with cwd equal to the unit's `WorkingDirectory` (`/root/src/repos/agent-substrate`), so a twin never competes for the port and never runs from the operator checkout. A failure inside `up` after spawn kills its own pid and removes its containers. `status` (optionally `status --all`, scanning `${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/*/state.json`) shows leftovers.

### Pitfall 10: `systemctl show` property order
**What goes wrong:** a positional parser reads the wrong field. Output order ≠ `-p` order (observed: MainPID, Result, NRestarts, …).
**How to avoid:** parse `key=value`.

### Pitfall 11: Reflog time vs commit time
**What goes wrong:** using `%ct` or `%cd` measures when the commit was authored or committed, not when HEAD moved.
**How to avoid:** use `%gd` with `--date=unix` (`HEAD@{1791469658}`) or `.git/logs/HEAD`.

### Pitfall 12: origin/main not in the local object store
**What goes wrong:** `git diff HEAD <sha>` errors (exit 128) and the check looks broken.
**How to avoid:** `cat-file -e` first, then fail closed with an explicit "fetch is an operator action" reason. Never fetch: the `.git` is shared with every worktree, including this one.

### Pitfall 13: Naming collision with `CHAOS_REHEARSAL`
**What goes wrong:** readers conflate the harness with chaos-smoke's mode (chaos-smoke.ts:59-60).
**How to avoid:** `docs/rehearsal.md` states both meanings. The harness never sets `CHAOS_*`.

### Pitfall 14: Printing a capability
**What goes wrong:** the smoke logs a claim reply containing `lease.lease_id`, or `status` prints `consumer.env` contents.
**How to avoid:** print booleans and decisions only. Tests assert the smoke's report text contains no token or lease id.

### Pitfall 15: `--operator` names a swarm surface or one not in `--surfaces`
**What goes wrong:** the operator token silently cannot force-release (config.ts:241-246, 291-305).
**How to avoid:** refuse at argument parse. In tests, assert `configWarnings(loadConfig(env))` is `[]`.

## Code Examples

### Container start (shape; values flow through env, not argv)
```ts
// scripts/rehearsal.ts — no Greptime key names in this file
const pg = Bun.spawnSync([
	"docker", "run", "-d", "--rm", "--pull", "never",
	"--name", `substrate-rehearsal-${name}-pg`,
	"--label", `substrate.rehearsal=${name}`,
	"-p", "127.0.0.1::5432",
	"--tmpfs", "/var/lib/postgresql/data",
	"-e", "POSTGRES_PASSWORD",
	"--health-cmd", "pg_isready -h 127.0.0.1 -U postgres",
	"--health-interval", "1s", "--health-retries", "60",
	pgImage,
], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", POSTGRES_PASSWORD: pgPassword } });
// host port: `docker port <ctr> 5432/tcp` → "127.0.0.1:49xxx"
```
Source: §6/§7 verified facts; flags are standard `docker run` options [CITED: docs.docker.com/reference/cli/docker/container/run].

### Server spawn
```ts
const log = openSync(join(runDir, "server.log"), "a", 0o600);
const server = Bun.spawn([process.execPath, "--no-env-file", "packages/mcp-server/src/index.ts"], {
	cwd: checkout, env: serverEnv, detached: true, stdin: "ignore", stdout: log, stderr: log,
});
server.unref();
```
Source: bun.d.ts:7002-7056; `bun --help`.

### Production prefix counts (runbook only; never in a `.ts` file)
```sql
-- Greptime (production), read-only, operator-approved:
SELECT count(*) FROM agent_events WHERE graph_id LIKE 'rh-%' OR session_id LIKE 'rh-%';
-- Postgres (production), read-only, operator-approved:
SELECT (SELECT count(*) FROM graph_index WHERE graph_id LIKE 'rh-%')
     + (SELECT count(*) FROM graph_nodes WHERE graph_id LIKE 'rh-%')
     + (SELECT count(*) FROM graph_bindings WHERE graph_id LIKE 'rh-%');
```
Table and column names come from [VERIFIED: index-store.ts:109-168] (`graph_index (graph_id …)`, `graph_nodes (graph_id …)`, `graph_bindings (… graph_id …)`). The `agent_events` columns `graph_id` and `session_id` are named in the `events_query` schema (mcp.ts:383-384) [VERIFIED]. Their presence as table columns is `[ASSUMED]` from that schema plus migrate() at greptime.ts:350-388, which was not read line by line.

### Unit guard
```ini
[Unit]
…
StartLimitIntervalSec=0
ConditionPathExists=/root/src/repos/agent-substrate/packages/mcp-server/src/index.ts
```
Semantics [CITED: `man systemd.unit`, "Conditions and Asserts", installed v255]:
- A failing condition means the start is "(mostly silently) skipped" and "will not result in the unit being moved into the "failed" state".
- It is checked "at the time the queued start job is to be executed", so a `Restart=always` loop ends at the first skipped start instead of counting restarts.
- The path must be absolute.
- `systemctl show -p ConditionResult` reports it (today `ConditionResult=yes`).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Untracked `/tmp/pNN-proof.sh` against long-lived `substrate-smoke-*` (v1.2) | Tracked `bun run rehearsal` with fresh labelled tmpfs containers | This phase | Reproducible proofs; smoke containers untouched |
| Stray `bun` (pid 3149064) on :7410 while the unit crash-looped (`NRestarts` reached 119855) | Unit MainPID owns :7410, `NRestarts=0` since 17:14:12 UTC | 2026-10-08, operator window | Criterion 3 already holds; this phase records it |
| Greptime auth `user=pwd` only | v1.1+ adds permission modes and hashed verifiers | Greptime v1.1 | Production (v1.1.4) parses the same plain `user=pwd`; the twin uses only that form |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | v0.14.4 standalone default data home is `./greptimedb_data` (we override it anyway with `--data-home`) | §6 | None if `--data-home` + `--tmpfs` on the same path are used |
| A2 | `/tmp` inside the greptime image is writable for the in-container users file | §6 | `up` fails at the Greptime start; fall back to a read-only bind of a 0600 file (needs the operator's view on "no volumes") |
| A3 | `agent_events` has `graph_id` and `session_id` columns | Code Examples (runbook SQL) | Count SQL errors; the operator adjusts the column; no data risk |
| A4 | `import.meta.main` semantics in Bun 1.4.0 as documented | §9 | Tests would run CLI side effects; mitigated by putting pure code in a sibling module |
| A5 | Readiness: pg ≈ 2–5 s, greptime ≈ 3–10 s, server boot+migrate ≈ 2–5 s on this host; 60 s ceilings are generous | Discretion | Only affects timeouts |

## Open Questions

1. **Who executes the production `rh-` prefix counts?**
   - What we know: they are approved (Operator answers). Agents hold no production credentials and must not read `/etc/substrate/substrate.env` values. The store lock forbids a `.ts` outside the package from naming `agent_events` in SQL.
   - What's unclear: whether the operator runs them in their own console or approves an agent-run path.
   - Recommendation: the runbook carries the two SQL statements above; the plan's live step asks the operator to run them and paste the two numbers. The harness smoke prints the exact run tag (`rh-<name>-<ts>`) so exact-match variants are available too.
2. **`NRestarts` / start-time baseline for "has not grown".**
   - Recommendation: `parity:check --json` emits the reading. The runbook keeps a dated table of readings, and the check takes an optional `--expect-restarts N --expect-start @epoch` to compare. Without a baseline it reports the current values and passes on `NRestarts=0`-since-start semantics (MainPID start == `ExecMainStartTimestamp`).
3. **`parity:check` after Phase 20 enables tokens.**
   - Recommendation: send `SUBSTRATE_TOKEN` from the caller's own env if set (never print it). On 401, exit 1 with "auth on; supply a token". Phase 20 updates the runbook.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker daemon + CLI | harness | ✓ | 29.6.2 | — |
| `postgres:16-alpine` | harness | ✓ (local, 420 MB) | 16.15 | `SUBSTRATE_REHEARSAL_PG_IMAGE` (e.g. local `postgres:16`) |
| `greptime/greptimedb:v0.14.4` | harness | ✓ (local, 677 MB) | 0.14.4 | `SUBSTRATE_REHEARSAL_GREPTIME_IMAGE` |
| Free disk on `/` (= `/tmp`, `/var/lib/docker`) | harness preflight | ✓ 20 GiB (`df`), 21 GiB (`statfs`) | 95% used | Refuse below the floor; never prune |
| RAM for tmpfs | containers | ✓ 16 GiB available | — | — |
| `XDG_RUNTIME_DIR` | run dir | ✓ `/run/user/0`, tmpfs 3.2 GB | — | `/tmp` |
| Bun | all scripts | ✓ | 1.4.0 | — |
| systemd / `systemctl` / `systemd-analyze` | parity, unit lint | ✓ | 255 | — |
| `ss` | parity, isolation evidence | ✓ | iproute2 6.1.0 | — |
| git | parity | ✓ | 2.43.0 | — |
| Network to github.com (ls-remote) | parity criterion 4 | ✓ (1.2 s) | — | Fail closed with reason |
| `gh` | optional compare fallback | ✓ | 2.45.0 | — |
| `node_modules` in the harness checkout | server start | ✓ in this worktree | — | Preflight refuses with an install hint |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `bun:test` (Bun 1.4.0), typecheck `bunx tsc --noEmit` (tsconfig includes `packages/**/*.ts`, `scripts/**/*.ts`) |
| Config file | none (no `bunfig.toml`); `tsconfig.json` |
| Quick run command | `bun test packages/mcp-server/src/rehearsal-env.test.ts packages/mcp-server/src/store-lock.test.ts scripts/` |
| Full suite command | `bun test && bunx tsc --noEmit` (baseline at `ab62c91`: 1129 pass / 56 skip / 0 fail across 40 files; tsc clean) |
| Unit lint | `systemd-analyze verify infra/vps/substrate-mcp.service` (exit 0 today) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FOUND-01 | Env built from an allowlist only; inherited `LINEAR_API_KEY`, `NOTION_API_KEY`, `OTEL_*`, Greptime keys and token keys from the parent are absent | unit | `bun test packages/mcp-server/src/rehearsal-env.test.ts` | ❌ Wave 0 |
| FOUND-01 | Built env round-trips: `loadConfig(env)` gives loopback greptime url + PG url on the given ports, `tokens.size === surfaces.length`, `allowAnonymous === false`, operator ⊆ tokens, `audit.path` in the run dir, `handoffKeyId === "k1"`; `configWarnings` is `[]`; `--anonymous` gives `allowAnonymous === true` and no operator tokens | unit | same | ❌ Wave 0 |
| FOUND-01 | `assertLoopback` refuses non-loopback hosts and ports ≠ the instance's container ports | unit | same | ❌ Wave 0 |
| FOUND-01 | Port refusal: 7410/7411/6420 and an in-use port refused; `--port 0` yields a free port | unit | `bun test scripts/rehearsal.test.ts` | ❌ Wave 0 |
| FOUND-01 | `--name` validation; `--operator` swarm or not-in-list refused; `--surfaces` validated against `SURFACES` | unit | same | ❌ Wave 0 |
| FOUND-01 | `down` pid-ownership decision (`mayStop`): wrong cmdline, cwd, start time, system.slice cgroup, or production port → refuse | unit | same | ❌ Wave 0 |
| FOUND-01 | Smoke URL guard: `:7410` or a non-loopback `SUBSTRATE_URL` → refuse before any request | unit | same | ❌ Wave 0 |
| FOUND-01 | Spawn argv contains `--no-env-file` and the entry point; no secret in any docker argv | unit | same | ❌ Wave 0 |
| FOUND-01 | Store lock still green (no Greptime key value / token literal / `GREPTIME_` in scripts) | unit (existing) | `bun test packages/mcp-server/src/store-lock.test.ts` | ✅ |
| FOUND-01 | Live harness: up → smoke (brief 200, emit 202 stored, register ok, claim granted) → `ss -tnp` loopback-only peers → down → no labelled container, run dir gone | manual/live-isolated (needs Docker) | `bun run rehearsal up && bun run rehearsal smoke && bun run rehearsal down; docker ps -a --filter label=substrate.rehearsal` | ❌ proof step |
| FOUND-01 | Live index tests against scratch PG pass | integration | `set -a; . <rundir>/consumer.env; set +a; bun test packages/mcp-server/src/graph-bind.test.ts packages/mcp-server/src/index-store.lease.test.ts` | ✅ (skip without the env) |
| FOUND-03 | `parseSystemctlShow` (order-independent, `@epoch` timestamps), `parseSsListeners` (multi-pid, IPv4/IPv6/wildcard), cgroup v2 line, `procStartSeconds` (comm with spaces), reflog `%gd` parse | unit | `bun test scripts/parity-check.test.ts` | ❌ Wave 0 |
| FOUND-03 | `parityVerdict` fails on: owner ≠ MainPID, wrong cgroup, inactive, healthz ≠ 200, cwd ≠ WorkingDirectory, start ≤ HEAD move, dirty paths, path diff to origin, origin sha missing locally; warnings never fail | unit | same | ❌ Wave 0 |
| FOUND-03 | Unit file lints with the guard | lint | `systemd-analyze verify infra/vps/substrate-mcp.service` | ✅ (file exists) |
| FOUND-03 | Live read-only check reproduces criterion 3 | live, approved | `bun run parity:check` (includes production `/healthz` GET) | ❌ proof step |

### Sampling Rate
- **Per task commit:** the quick run command.
- **Per wave merge:** `bun test && bunx tsc --noEmit`.
- **Phase gate:** full suite green + `systemd-analyze verify` + the isolated harness proof + the approved `parity:check` run, before `/gsd:verify-work`.

### Wave 0 Gaps
- [ ] `packages/mcp-server/src/rehearsal-env.test.ts` covers FOUND-01 (env, round-trip, loopback). Use computed Greptime keys only.
- [ ] `scripts/rehearsal.test.ts` covers FOUND-01 guards. Must not contain `GREPTIME_`.
- [ ] `scripts/parity-check.test.ts` covers FOUND-03 parsers and verdict. Fixtures are the verbatim outputs in §8, with pids/paths as shown (no secrets).
- No framework install needed.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (scratch) | Random 32-byte hex bearer tokens per surface; Greptime Basic auth via static user provider; PG password |
| V3 Session Management | no | Stateless MCP transport |
| V4 Access Control | yes | Operator token ⊆ surface tokens, non-swarm (config.ts:241-305); `down` signals only its own verified pid |
| V5 Input Validation | yes | Validate `--name` (`^[a-z0-9][a-z0-9-]{0,30}$` recommended), `--port` (int 0–65535, refused set), `--surfaces` ∈ `SURFACES` |
| V6 Cryptography | yes | `crypto.randomBytes`/`getRandomValues` only; never `Math.random` for secrets |
| V7 Error Handling and Logging | yes | Never print env values, tokens, lease ids or passwords; `server.log` is 0600 |
| V14 Configuration | yes | Allowlisted env; `--no-env-file`; loopback-only publishes |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Production credentials leaking into the twin (inherited env, `.env` autoload) | Information disclosure / Tampering of production | Allowlist env; `--no-env-file`; never read `/etc/substrate/substrate.env`; loopback assertion on every store URL |
| Twin writing to production stores | Tampering | Store URLs only from the harness's own `docker port`; smoke refuses :7410 and non-loopback; `ss -tnp` evidence; `rh-` prefix counts = 0 |
| Secrets in process listings | Information disclosure | Pass by env name (`-e NAME`); Greptime users file written inside the container; no `cmd:` provider |
| Secrets in the repo | Information disclosure | Run dir outside every checkout; store-lock CREDENTIAL/TOKEN_LITERAL scans stay green |
| Wrong-process kill | Denial of service on production | `mayStop` checks (cmdline, cwd, start time, cgroup, port); no process-group signals; never touch the unit |
| Container cleanup hitting unrelated containers | Denial of service | Filter strictly on `label=substrate.rehearsal=<name>` |
| Exposure beyond loopback | Information disclosure | `-p 127.0.0.1::<port>`; `SUBSTRATE_HOST=127.0.0.1` |
| Shared `.git` corruption | Tampering | `--no-optional-locks` on every git call; no fetch/pull/checkout; `ls-remote` only |

## Sources

### Primary (HIGH confidence)
- Repo files read this session:
  - `packages/mcp-server/src/config.ts` (1-333)
  - `server.ts` (30-75, 195-360, grep 475-531)
  - `service.ts` (1452-1488, 289-321, 990-1002)
  - `mcp.ts` (69-133, 436-574)
  - `index.ts` (1-66)
  - `store-lock.test.ts` (1-362)
  - `greptime.ts` (244-300 + grep)
  - `index-store.ts` (95-200)
  - `types.ts` (11-48)
  - `http.test.ts` (1-66)
  - `scripts/chaos-smoke.ts`
  - `packages/observability/src/config.ts` (grep)
  - `package.json`, `tsconfig.json`, `.env.example` (grep), `.gitignore`
  - `infra/vps/substrate-mcp.service`
- GreptimeDB tag v0.14.4 source: `src/servers/src/http.rs`, `src/servers/src/http/authorize.rs`, `src/auth/src/common.rs`, `src/auth/src/user_provider.rs`, `src/auth/src/user_provider/static_user_provider.rs` (fetched from raw.githubusercontent.com).
- Local image probes (`--rm --pull never --network none`): greptime `standalone start --help`, `--version`, tool presence; postgres entrypoint lines 102-297, `pg_isready --version`; `docker image inspect` ×2; `docker inspect` of `substrate-smoke-*`, `auctioning-greptime-1`, `rakazo-postgres-1`.
- Host read-only probes: `systemctl show` (two forms), `systemctl list-units`/`list-unit-files`, `ss -ltnpH`, `/proc/1525582/{cgroup,cwd,cmdline,stat}`, `/proc/stat` btime, `git --no-optional-locks log -g / status / ls-remote / cat-file / diff`, `.git/logs/HEAD`, `cat /etc/systemd/system/substrate-mcp.service`, `systemd-analyze verify`, `df`, `free`, `docker info`, `bun --help`.
- `man systemd.unit` (installed v255): ConditionPathExists, "Conditions and Asserts".
- bun-types@1.4.0 `bun.d.ts` 7002-7056.

### Secondary (MEDIUM confidence)
- docs.greptime.com Static User Provider page (current docs; the v1.1+ features are noted as not applying to v0.14.4).
- docs.docker.com `docker run` (`-e NAME` inheritance, `--tmpfs`, `--health-*`); bun.sh `import.meta.main`.

### Tertiary (LOW confidence)
- Assumptions A1–A5 above.

The GSD research-plan/cache seam was not used: no docs MCP provider (context7/exa/etc.) is mounted in this session, and every library fact came from local images, the pinned upstream tag, or the repo.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. Every tool and image version was read on the host.
- Architecture: HIGH. Built on locked decisions plus verified code seams (loadConfig, auth gate, store-lock regexes).
- Pitfalls: HIGH. Each one is grounded in a cited line or an observed output; A2 (container `/tmp`) is the one runtime unknown, and the first `up` proves it.

**Research date:** 2026-10-08
**Valid until:** 2026-11-07 for the code facts (stable repo). Host state (§8) is a snapshot; `parity:check` re-reads it at proof time.
