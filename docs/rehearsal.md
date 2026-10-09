# Scratch rehearsal harness

Tracked as FOUND-01. Owned by `scripts/rehearsal.ts`, with the server-environment
constructor in `packages/mcp-server/src/rehearsal-env.ts`.

One command stands up this checkout's `substrate-mcp` on a scratch loopback port
against a scratch Postgres and a scratch ledger in local Docker containers, with
configurable surface tokens. One command tears it down. Every later v1.3 proof
sources the harness's `consumer.env` and never touches a production store.

## Isolation

The twin is isolated by construction, not by discipline:

- Both scratch stores run in local containers on loopback only. Container ports
  are published as `127.0.0.1::<container port>` — Docker picks a free host
  port and the harness reads it back — so a twin cannot collide with the
  long-lived smoke containers or with any other project's ports.
- The server's environment is built from an allowlist (`PATH`, `HOME`, Bun's
  own variables, plus the harness's scratch values). It never inherits the
  caller's store or token variables, and it never reads the production env
  file. Preflight asserts every store URL it hands the server is loopback and
  points at its own container ports.
- Each instance lives outside every checkout in its own run directory,
  `${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/<name>/`, mode 0700:
  - `state.json` — container names, server pid, ports, checkout path and commit;
  - `server.log` — the twin's stdout and stderr;
  - `consumer.env` — the six-key contract every proof sources (below);
  - `stores.env` — the scratch store connection values, for store clients only;
  - `tokens/` — one 0600 file per surface, the v1.2 workspace-install pattern.

`stores.env` is sourced only by proofs that legitimately hold a store client,
such as `bun run smoke:greptime` and the anchor job. Nothing sources it by
default; clients reach the ledger only through `SUBSTRATE_URL`.

## Commands

All four run through the `rehearsal` package script:

```sh
bun run rehearsal up [--name <n>] [--port <N>] [--surfaces a,b] [--operator <s>] [--anonymous]
bun run rehearsal smoke [--name <n>]
bun run rehearsal status [--name <n>]
bun run rehearsal down [--name <n>]
```

Flags, as built:

- `--name <n>` (default `default`) — the instance. Parallel worktrees each run
  their own named twin; teardown filters strictly on the instance label, so one
  instance never touches another's containers.
- `--port <N>` (default `17410`) — the scratch MCP port. `--port 0` picks a
  free loopback port. The harness refuses `7410`, `7411` and `6420`, and any
  port already listening.
- `--surfaces a,b` (default `claude-code,cursor,hermes,omp`) — the surfaces
  that get a bearer token each.
- `--operator <s>` (default: the first surface listed) — the operator surface.
  It must be one of `--surfaces` and never a swarm surface.
- `--anonymous` — no tokens at all, for proofs that need today's anonymous
  production shape. Forces empty surfaces and a null operator.

`up` refuses unless Docker is reachable, both images are present locally, free
disk is above the ~2 GiB floor (it never prunes), and the port is free. It
then starts the two labelled containers, spawns the checkout's own
`packages/mcp-server/src/index.ts` detached with env-file autoload disabled,
waits for `GET /healthz` to report a writable index and ledger, and prints the
`consumer.env` path, the URL, the checkout commit, a dirty flag and the image
tags. Never a credential.

`down` is idempotent. It signals only the pid recorded in its own `state.json`,
and only after checking that pid's command line is the server entry point,
that its cwd is the recorded checkout, and that it is neither a system unit
nor holding a production port — then it removes every container carrying the
instance label (which also catches orphans from a crashed `up`) and deletes
the run directory.

`status` is read-only: pid, ports, health, commit and image tags for the
instance.

`smoke` drives the fixed-order wire proof over the twin — `POST /brief`, an
emit through `POST /events`, then MCP `graph_register` followed by
`graph_claim` — under run-tagged ids (`rh-<name>-<timestamp>` for both the
graph and the session). It reads only `consumer.env` and refuses to run when
`SUBSTRATE_URL` resolves to port `7410` or to a non-loopback host, before any
request — health check included. It prints one `ok`/`FAIL` line per step plus
the claim's `claimed`/`decision` scalars only, and exits non-zero unless every
step passes. Claim success needs `claimed` true **and** `decision` granted.

Each `up` generates a random Postgres password, a random ledger user and
password (which exercises production's Basic-auth path), one random bearer
token per surface and a random handoff key. The operator authenticates with
its own surface's bearer token; there is no separately generated operator
token. `consumer.env` still exports that operator token separately (as
`SUBSTRATE_REHEARSAL_OPERATOR_TOKEN`, for the smoke to drive) so
`SUBSTRATE_TOKEN` stays the first non-swarm surface's token. All of them go
only into 0600 files in the run directory. Nothing is printed, and nothing is
committed.

The default instance runs with tokens, an audit path inside the run directory
and a random handoff key — the shape production reaches after Phase 20.

Image overrides, for the day the operator loads a newer ledger image locally:

| Variable | Default | |
| --- | --- | --- |
| `SUBSTRATE_REHEARSAL_PG_IMAGE` | `postgres:16` | |
| `SUBSTRATE_REHEARSAL_GREPTIME_IMAGE` | `greptime/greptimedb:v0.14.4` | Standalone mode |

The host's daily `docker-image-prune` job removes images no container references.
`postgres:16` and this ledger tag stay because the v1.2 scratch containers
(`substrate-smoke-pg`, `substrate-smoke-greptime`) still reference them. Keep those
containers, or give the prune a label filter, before removing them.

Local ledger v0.14.4 against production v1.1.4 is accepted: pulling v1.1.4 is
ruled out by the disk gate and the no-pull rule, v0.14.4 is what the v1.1 and
v1.2 live proofs used, and the server probes the version-sensitive behaviour
at runtime. `status` and `state.json` record the image tags, so a proof states
exactly what it rehearsed. Postgres has no gap that matters — the index uses
no Timescale extension.

## The consumer contract

Every later proof sources `consumer.env` and hardcodes nothing:

| Key | Value |
| --- | --- |
| `SUBSTRATE_URL` | The twin's loopback URL |
| `SUBSTRATE_TOKEN` | The first non-swarm surface's bearer token (empty under `--anonymous`) |
| `SUBSTRATE_REHEARSAL_OPERATOR_TOKEN` | The operator surface's bearer token, which the smoke drives (empty under `--anonymous`) |
| `SUBSTRATE_REHEARSAL_TOKENS_DIR` | One 0600 file per surface |
| `SUBSTRATE_REHEARSAL_NAME` | The instance name |
| `SUBSTRATE_TEST_PG_URL` | The scratch Postgres URL, so the existing live index tests run against scratch |

It does not export the ledger keys: clients talk to the ledger only through
`SUBSTRATE_URL`.

```sh
set -a; . <run-dir>/consumer.env; set +a
bun run rehearsal smoke --name <n>
```

## Exits

`0` pass, `1` failed, `2` usage or refused. Unreachable preconditions — a
missing `consumer.env`, a production-looking smoke target — refuse with exit
`2` before proving anything. Scratch stores or a twin that never reach
healthy stay exit `1`: the harness ran, and the proof failed.

## Named instances, tmpfs, no pull

- `--name` isolates parallel twins: own run directory, own labelled
  containers, own ports, own tokens.
- Container data lives on `--tmpfs`, with no volumes: `down` leaves nothing
  behind, and there is no harness rollback because `down` removes everything
  it made.
- The harness runs every container with `--pull never`: a missing image is a
  refusal, never a download.

## Which "rehearsal" this is

Two meanings share the word. This harness is a **scratch deployment**: a twin
of the server on loopback against scratch stores. `CHAOS_REHEARSAL=1` is a
**mode of the chaos smoke** (`docs/observability.md`): it downgrades the
outage-only checks to notes so the script can be tested against a healthy
deployment, and its report says so. A rehearsal of the script is never a
proof; a twin from this harness is where proofs run.
