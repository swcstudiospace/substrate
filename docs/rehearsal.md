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
  - `consumer.env` — the contract every proof sources (below);
  - `stores.env` — the scratch store connection values, for store clients only;
  - `tokens/` — one 0600 file per surface, the v1.2 workspace-install pattern.

`stores.env` is sourced only by proofs that legitimately hold a store client,
such as `bun run smoke:greptime` and the anchor job. Nothing sources it by
default; clients reach the ledger only through `SUBSTRATE_URL`.

## Commands

All four run through the `rehearsal` package script:

```sh
bun run rehearsal up [--name <n>] [--port <N>] [--surfaces a,b] [--operator <s>] [--anonymous] [--skills-fixture] [--ragflow-fixture]
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
- `--ragflow-fixture` — also start the owned RAGFlow stand-in for the
  docs-ingest/search proofs (below): a loopback HTTP process over the
  recording fake with uploads served as chunks, pointed at by the twin's
  random scratch key. `consumer.env` gains the three
  `SUBSTRATE_RAGFLOW_FIXTURE_*` locator names (never the plane key).
  `bun run smoke:docs` is the proof that drives it.

`up` refuses unless Docker is reachable, both images are present locally, free
disk is above the ~2 GiB floor (it never prunes), and the port is free. It
then starts the two labelled containers, spawns the owned RAGFlow stand-in
first when `--ragflow-fixture` is set (verifying its pid, entry point,
checkout and start time before anything else runs), spawns the checkout's own
`packages/mcp-server/src/index.ts` detached with env-file autoload disabled,
waits for the fixture's own health gate and then for `GET /healthz` to report
a writable index and ledger, and prints the `consumer.env` path, the URL, the
checkout commit, a dirty flag and the image tags. Never a credential.

`down` is idempotent. It signals only the pids recorded in its own `state.json`
(the twin, then the fixture when one was recorded), and only after checking
each pid's command line is the expected entry point, that its cwd is the
recorded checkout, and that it is neither a system unit nor holding a
production port — then it removes every container carrying the instance label
(which also catches orphans from a crashed `up`) and deletes the run
directory. A foreign or reused pid refuses and keeps the run directory for
repair; an occupied listener is never stopped.

`status` is read-only: pid, ports, health, commit and image tags for the
instance, plus the fixture endpoint, pid and readiness when one is recorded
(off otherwise).

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
| `SUBSTRATE_RAGFLOW_FIXTURE_URL` | The owned stand-in's loopback URL (`--ragflow-fixture` only) |
| `SUBSTRATE_RAGFLOW_FIXTURE_READY` | `1` when the fixture answered its health gate (`--ragflow-fixture` only) |
| `SUBSTRATE_RAGFLOW_FIXTURE_PID` | The stand-in's pid, for locator lines (`--ragflow-fixture` only) |
| `SUBSTRATE_REHEARSAL_DOCS_STATE_FILE` | The fixture's own docs manifest path (`docs-state.json` in the run dir; `--ragflow-fixture` only; the path only, never a key) |
It does not export the ledger keys: clients talk to the ledger only through
`SUBSTRATE_URL`.

It never exports the plane key: the RAGFlow scratch key lives in the twin's
server env only, and proofs reach the stand-in's control routes by the
locator names above.

## The RAGFlow stand-in

`--ragflow-fixture` starts an owned RAGFlow stand-in next to the twin for the
docs-ingest/search proofs. It is a loopback-only Bun process
(`packages/mcp-server/src/rehearsal-ragflow-server.ts`) over the recording
`ragflow-fake.ts` with uploads served as chunks — the same fake the unit
proofs drive — so a pin over real uploads matches served chunks. No new real
RAGFlow door opens: agents still reach RAGFlow only through `substrate-mcp`,
and the twin reads the stand-in through its ordinary `RAGFLOW_URL` /
`RAGFLOW_API_KEY` server settings, pointed at scratch.

Ownership follows the existing scratch model, not discipline:

- The stand-in binds `127.0.0.1` on a picked free port; the harness refuses a
  production port or an already-listening port before spawning. The scratch
  key is random per run and travels by child env only — never a CLI arg, a
  log line or a consumer export — and the child inherits no store, token or
  home variables. It never reads a real env file or a production credential.
- `up` refuses when a previous state still owns a live fixture, even when the
  twin itself is gone: the fixture is checked independently (pid, start time,
  entry point, checkout) before any container removal or state overwrite, so
  a dead twin never orphans its live stand-in. An unverifiable live fixture
  also refuses and keeps its stores.
 - `state.json` is saved before the first spawn. Each actual child PID and
   captured birth time is recorded as soon as it is born, before qualification;
   no PID is invented. A slot is null while that child has not spawned.
   Entry qualification is bounded by the existing readiness deadline and
   must retain the same PID/birth identity before listener or network checks.
   `down` and every failure/interrupt cleanup signal only verified own
   identities. A captured live child with an unverified birth is preserved,
   never signalled or forgotten. Only proven-gone children and removed
   containers permit deleting recovery state; foreign or reused PIDs refuse.
   `status` reports pending/unverified children without contacting replacements.
   A state file an older `up` wrote simply has no fixture entry.
 - Readiness is the stand-in's own health gate over HTTP (`GET
   /__fixture/health` answering `{ ok: true }`) with redirects rejected
   (`redirect: error`), not merely an open port, and the listener is
   re-verified as ours before the state is finalised. Fixture control URLs
   must be plain `http` loopback with an explicit scratch port and no
   credentials, query, fragment, or unexpected path.
 - Control routes live only on the owned stand-in: `GET /__fixture/counts`
   answers `{ requests, retrievals, uploads, documents }` (numbers only, never
   keys or bodies), `POST /__fixture/reset` clears recorded requests, uploads,
   seeds, and injected failures, `POST /__fixture/fail-retrieval` takes only
   `{ status: 500 | 502 | 503 | null }`, `POST /__fixture/parse` takes only
   `{ behavior: "done" | "never" }`, and `POST /__fixture/seed-chunks` takes
   only `{ dataset, chunks: [{ content, document_id, source_url?,
   heading_path?, score?, dataset? }] }` with at most 20 bounded synthetic
   chunks, served after uploads under serveUploadsAsChunks and never counted
   as uploads or documents. Dataset names resolve to the fake's actual
   dataset ids (per-chunk override included) before any seed is stored: an
   unknown name is a 400 with nothing stored, and the count names only
   actually accepted seeds. Control bodies are streamed with a 64 KiB UTF-8
   byte cap enforced before buffering (413 names the status only); the cap
   applies per control reader only, so authenticated `/api/*` uploads keep
   their page/call allowance and the docs transport. The `/api/*` doors need
   the scratch bearer; anything else is a 401 that names the status only.
 - `status` names the fixture endpoint, pid and readiness (or `off`) only
   after verifying the recorded twin and fixture still own their ports;
   a mismatched, gone, or unverifiable child reports not ready without
   contacting a replacement listener.
   `consumer.env` names the endpoint, the readiness marker and the pid by
   name. Proofs refuse before any effect unless the recorded fixture is
   enabled, the marker reads `1`, the twin answers `/healthz`, and — for the
   docs smoke — its own consumer guard re-verifies both pids against reuse,
   entry point, checkout, and listeners before any network, subprocess, or
   control effect. The twin's docs manifest lives at `docs-state.json` in
   the run dir (the server's `SUBSTRATE_DOCS_STATE_FILE`); proofs read their
   own pins through `SUBSTRATE_REHEARSAL_DOCS_STATE_FILE` with no RAG keys.

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
