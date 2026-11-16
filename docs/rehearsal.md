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

All six run through the `rehearsal` package script:

```sh
bun run rehearsal up [--name <n>] [--port <N>] [--surfaces a,b] [--operator <s>] [--anonymous] [--skills-fixture] [--extra-env <key>=<value>]...
bun run rehearsal smoke [--name <n>]
bun run rehearsal status [--name <n>]
bun run rehearsal pause --store ledger|index [--name <n>]
bun run rehearsal unpause --store ledger|index [--name <n>]
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
- `--skills-fixture` — also build the skills library fixture for
  `skills_propose` ([skills-propose.md](skills-propose.md)): inside the run
  directory, a throwaway bare repository `skills-fixture/rehearsal/agent-skills.git`
  seeded with one skill on `main` (refusing non-fast-forwards and deletions, logging
  every ref update), the proposer's one-branch `skills/mirror.git`, and a recording
  `gh` that answers only `pr create`, `pr view` and `pr list --head` from a JSON
  state file, with PR URLs under `https://github.com/rehearsal/agent-skills/`. `git`
  runs for real; `consumer.env` gains the four `SUBSTRATE_REHEARSAL_SKILLS_*` paths.
  `bun run smoke:skills-propose` is the proof that drives it. Every instance, with
  or without the flag, sets `SUBSTRATE_SKILLS_STATE` inside its run directory, so a
  twin can never write the host's skills state. `bun run smoke:skills-sync`
  ([skills-sync-bridge-miners.md](skills-sync-bridge-miners.md)) replays the
  mined-to-projected loop on the same fixture: bridge propose, queue drains,
  sync refusals, a simulated owner merge plus ff tick, and projector links.

`up` refuses unless Docker is reachable, both images are present locally, free
disk is above the ~2 GiB floor (it never prunes), and the port is free. It
then starts the two labelled containers, spawns the checkout's own
`packages/mcp-server/src/index.ts` detached with env-file autoload disabled,
waits for `GET /healthz` to report a writable index and ledger, and prints the
`consumer.env` path, the URL, the checkout commit, a dirty flag and the image
tags. Never a credential.

`--extra-env <key>=<value>` (repeatable, `up` only) adds one server setting to the twin's environment. It is a closed list in `packages/mcp-server/src/rehearsal-env.ts` (`EXTRA_ENV_ALLOWLIST`), and every key accepts only the values listed here:

| Key | Accepts |
| --- | --- |
| `SUBSTRATE_METRICS_HISTORY` | `on`, `off` |
| `SUBSTRATE_BRIEF_PROFILE` | `off`, `shadow`, `enforce` |
| `SUBSTRATE_CACHE_SWR` | `off`, `shadow`, `enforce` |
| `SUBSTRATE_SLO_MIN_SAMPLES` | a whole number, 1 to 999 |

Anything else exits `2` before any Docker call, naming the rule: `extra-env-format` (not `<key>=<value>`), `extra-env-key` (not on the list, so no store URL, token, path or host can be injected), `extra-env-value` (a value the key does not take) or `extra-env-duplicate` (the same key twice; the later value never silently wins). A key is added to the list only once the server reads it, with the values the server accepts. `up` prints each accepted pair.

`pause` and `unpause` freeze and thaw one scratch store of one instance with `docker pause` / `docker unpause`: the container keeps its connections open and answers nothing, which is how a dropped-packet outage looks to the server (`index` is the Postgres container, `ledger` the other). They take the same per-instance lock as `down` and the same local-daemon check. The container is found by the instance label **and** its exact name (`substrate-rehearsal-<name>-ledger` or `-pg`); anything else, none or two matches refuse with rule `pause-target` and nothing is paused. A store already in the asked state is reported and left alone (exit `0`), so a cleanup `unpause` is always safe, and the state is read back from Docker after the verb. A paused store does not stop `down`: removal is forced.

`bun run gate:boot` ([runbooks/release-gate.md](runbooks/release-gate.md)) is the driver that uses all of it: boot, prove, freeze the ledger, run the chaos smoke, thaw, `down`.

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
missing `consumer.env`, a production-looking smoke target, a refused `--extra-env`,
`--store` or pause target — refuse with exit
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

## Live-gated docs proof checklist — NOT RUN

The isolated proof (`rehearsal up`, `bun scripts/docs-smoke.ts --name <owned>`, unit
tests) covers every refusal and error path against fakes. The five steps
below touch the live docs plane or the host, so each waits for an explicit
operator approval window. None has run; none is implied to have run.
An unset `LIGHTRAG_URL` leaves search degraded and ingest refused; do not
point these steps at another docs backend.
Until the product slugs confirm (25-CONTEXT.md open question 3), the live
DOCS-03 proof covers `agent-substrate`, `agent-skills` and
`programming-desk` only.

| Step | Approval window | Status |
|---|---|---|
| 1. Read-only: query LightRAG's health and confirm the registry dataset names and the TEI `bge-small` model id | _blank — operator approval required_ | NOT RUN |
| 2. Read-only: confirm the product repo slugs on GitHub, and that the host can fetch each repo | _blank — operator approval required_ | NOT RUN |
| 3. Write: run the first `substrate docs refresh` for each dataset | _blank — operator approval required_ | NOT RUN |
| 4. Write: deploy the release, create `/var/lib/substrate/docs`, and install and enable `substrate-docs-refresh.timer` | _blank — operator approval required_ | NOT RUN |
| 5. Write and read: the live search and ingest proof against the deployed LightRAG, which writes an event and an audit record; then confirm a skills-sync fast-forward triggers the agent-skills refresh | _blank — operator approval required_ | NOT RUN |
