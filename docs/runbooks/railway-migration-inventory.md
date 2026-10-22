# Railway migration inventory

**Phase 54 (SOTA-10). Readiness inventory, not a plan to cut over.** This document lists what the substrate depends on today, by role, so a future move of its stores and services to Railway can be judged against evidence. It was built by reading `infra/vps/`, `docs/`, and the non-test sources under `packages/**` and `scripts/**`. Nothing here was taken from memory.

**Out of scope, stated plainly:** there is no cutover in this document, no DNS change, no production deploy, and no change to a live Railway service, a VPS unit, or an environment file. Each follow-up below is a decision for an operator to take later, and none is applied here.

Conventions used below: environment files are named by path and role only; their contents are never read or written here. Railway services are named by their service name only. Loopback addresses are written as "loopback", and ports are given as numbers.

## 1. Host-bound dependencies on the VPS

Every unit runs from the immutable release at `/opt/agent-substrate/current` (`infra/vps/README.md`). The mutable checkout is not a working directory. The env-file column gives the file's path and role. Its keys are not listed here.

| Unit | Role on the host | Env file (path and role) | Loopback port or path role | Schedule |
| --- | --- | --- | --- | --- |
| `substrate-mcp.service` | The only writer to Greptime, Timescale and the cache. Serves the HTTP and MCP API | `/etc/substrate/substrate.env`, the shared server env, via its drop-in | Loopback port 7410 (`/healthz`, `/livez`, `/mcp`). The watchdog drop-in probes `/livez` there | Always (`Restart=always`) |
| `substrate-host.service` | Runs the VM host: sandboxes, approvals, model relay | `/etc/substrate/substrate-host.env`, the host env | Loopback engine port 6420 (shared, unverified). Host API port 7411. State under `/var/lib/substrate/agentos` | Always |
| `substrate-dispatcher.service` | Dispatches Hermes sessions into git worktrees under `/root` | `/etc/substrate/substrate-dispatcher.env`, the dispatcher env (names a kill switch, value not recorded here) | No listening port in the unit | Always |
| `substrate-collector-grok.service` | Tails Grok sessions and posts events | `/etc/substrate/collector-grok.env`. It does not load the shared env | Posts to the MCP loopback port 7410. State `/var/lib/substrate/grok-offsets.json` | Always |
| `substrate-collector-herdr.service` | Reads herdr pane state and posts events | `/etc/substrate/substrate-collector-herdr.env`, the herdr collector env | Reads a Unix socket under `/root/.config/herdr`, not a TCP port. Posts to 7410. State `/var/lib/substrate/herdr-offsets.json` | Always |
| `substrate-collector-muse.service` | Watches repos under `/root/src/repos` and posts briefs | `/etc/substrate/substrate-collector-muse.env`, the muse collector env | Posts to 7410. State `/var/lib/substrate/muse-offsets.json` | Always |
| `substrate-anchor.service` | Anchors the hourly Merkle root to the public devnet | `/etc/substrate/substrate.env` via drop-in. Signer key file under `/etc/substrate` (role only, not read) | Outbound public RPC. Store read through 7410 or Greptime | `substrate-anchor.timer`, hourly, `Persistent=true` |
| `substrate-index-sweep.service` | Index sweep. Dry-run unless the unit's mode is changed | `/etc/substrate/substrate.env` via drop-in | Timescale through the index URL variable | `substrate-index-sweep.timer`, 03:17 UTC |
| `substrate-index-archive.service` | Index snapshot to an off-box archive | `/etc/substrate/substrate.env` via drop-in | Archive mount `/mnt/index-archive` (`RequiresMountsFor`) | `substrate-index-archive.timer`, 03:45 UTC |
| `substrate-ledger-archive.service` | Ledger archive to an off-box directory | `/etc/substrate/substrate.env` via drop-in | Archive mount `/mnt/ledger-archive` | `substrate-ledger-archive.timer`, 03:30 UTC |
| `substrate-doctor.service` | Runtime drift doctor; writes its dedupe record | `/etc/substrate/substrate.env` via drop-in | Reads 7410. State `/var/lib/substrate/doctor-last.json` | `substrate-doctor.timer`, every six hours at :23 UTC |
| `substrate-docs-canary.service` | Live docs golden canary. Refuses a non-loopback base | `/etc/substrate/substrate.env` via drop-in | Reads 7410. State `/var/lib/substrate/docs-canary-last.json` | `substrate-docs-canary.timer`, 04:41 UTC |
| `substrate-alert@.service` (template) | Alert job, one instance per alert | `/etc/substrate/substrate.env` via drop-in | Reads 7410 | Instantiated on demand |
| `substrate-skills-sync.service` | Syncs the skills mirror from the library repo | `/etc/substrate/substrate.env` and `/etc/substrate/substrate-skills-sync.env` | Mirror under `/var/lib/substrate/skills`. Uses a `gh` credential stored under `/root` | `substrate-skills-sync.timer`, five minutes after a two-minute boot delay |
| `substrate-skills-bridge.service` | Posts skill proposals to the MCP `/skills/propose` route | `/etc/substrate/substrate.env` and `/etc/substrate/substrate-bridge.env` | Loopback 7410. Logs under `/var/lib/substrate/miner` | `substrate-skills-bridge.timer`, five minutes after a three-minute boot delay |
| `redis-server.service` (drop-in) | VPS cache. Loopback-only bind, `maxmemory-policy volatile-lru`, no snapshots, no AOF | `/etc/redis/redis-substrate.conf` (config, not an env file) | Loopback bind. The conf names no port, so the redis default applies | Always |

Host-bound items that are not units:

- The git `post-commit` hook installed into checkouts posts to the loopback port 7410 (`packages/collectors/src/install-git-hook.ts`).
- Operator user config for the agent clients (`/root/.claude/settings.json`, `/root/.cursor/hooks.json`) points at the VPS substrate. These are not in this repository.
- The `substrate-mcp` watchdog drop-in (`20-watchdog.conf.example`) probes the loopback `/livez`.

## 2. On-disk state versus Railway-hosted state

Railway project and service names are as `docs/data-planes.md` gives them. The Ultrathink project holds GreptimeDB, TimescaleDB and DragonflyDB. The Agent Substrate project holds Hindsight and RAGFlow. `hindsight-ui` is a Hindsight browser UI in the Agent Substrate project.

| Store | Plane | Where it is today | Railway service (project) | Railway-hosted? | Migration note |
| --- | --- | --- | --- | --- | --- |
| Events ledger (`agent_events`) | Append-only, hash-chained events | GreptimeDB via `GREPTIME_URL` | GreptimeDB (Ultrathink) | Yes | Public domain is removed only after the forwarder is proven. Writes go through `substrate-mcp` only |
| Metrics history (`metric_samples`) | Sampled metric rows, opt-in | GreptimeDB table, written by the metrics writer | GreptimeDB (Ultrathink) | Yes | Stored in the ledger's Greptime, never in `agent_events` |
| Index: graph, leases, governance, memory | Postgres-protocol tables, no hypertables | Via `SUBSTRATE_PG_URL` | TimescaleDB (Ultrathink) | Yes | No separate Railway Postgres service is named in the repo. TimescaleDB is the Postgres store. The CI Postgres is a CI container and is not a Railway service |
| Cache, budget counters, generation counters | Read-through cache | Via `DRAGONFLY_URL`, which points at the VPS loopback redis in production | DragonflyDB (Ultrathink), idle | No (production cache is on the VPS) | Budget counters rely on `volatile-lru`, which Dragonfly does not express. Keep, repurpose or retire is an operator decision |
| Planning presence (session heartbeats) | Dragonfly keys, bounded `SCAN` | Same cache endpoint | DragonflyDB (Ultrathink), idle | No | Presence history is not yet written to Timescale |
| Memory recall (banks) | Hindsight | Server env `HINDSIGHT_URL` and `HINDSIGHT_API_KEY` | Hindsight (Agent Substrate) | Yes | `hindsight-ui` keeps a domain only if browser access without the tailnet is wanted (an access change) |
| Documents | RAGFlow | Server env `RAGFLOW_URL` and `RAGFLOW_API_KEY` | RAGFlow (Agent Substrate) | Yes | Docs state file on local disk, see below |
| Refusal journal | Collector refusals, rotated at 1 MiB by default | `/var/lib/substrate/refused-emits.jsonl` and its `.1` file | None | No: local disk | Needs a volume if collectors move off the host |
| Event spool | Parked events, opt-in | `/var/lib/substrate/event-spool.jsonl` | None | No: local disk | Present only when the spool is enabled and has parked an event |
| Hindsight retain outbox | Pending memory writes | `/var/lib/substrate/retain-outbox.jsonl` | None | No: local disk | Must survive a restart; loss means lost retains |
| MCP audit log | Hash-chained audit of tool calls, segmented | `/var/lib/substrate/mcp-audit.jsonl` and its segments | None | No: local disk | Append-only. Needs a durable volume |
| Transcripts | Cursor stop-hook transcripts | `/var/lib/substrate/transcripts/cursor` | None | No: local disk | Size-capped per file |
| Collector offsets | Resume points for grok, herdr, muse | `/var/lib/substrate/*-offsets.json` | None | No: local disk | Losing them replays events |
| Skills mirror, proposals, governance | Skills plane | `/var/lib/substrate/skills` (`mirror.git`, `propose/`, `approved.json`) | None | No: local disk | Mirror is rebuildable from the library repo; proposals are not |
| AgentOS state | VM sandboxes and approvals | `/var/lib/substrate/agentos` (`sandboxes.json`, `approvals.json`) | None | No: local disk | Approval state is a record of decisions |
| Sandbox worktrees | Dispatcher and sandbox checkouts | `/var/lib/substrate/worktrees` | None | No: local disk | Subject to the disk-pressure runbook |
| SLO checkpoint and runtime state | Doctor, docs canary, SLO | `/var/lib/substrate/slo-checkpoint.json`, `doctor-last.json`, `docs-canary-last.json` | None | No: local disk | Dedupe records. Losing them re-announces drift once |
| Index archive | Off-box snapshot of the index | `/mnt/index-archive` (off-box mount) | None | No | Operator-chosen off-box mount. Archive commands refuse by name when unset |
| Ledger archive | Off-box snapshot of the ledger | `/mnt/ledger-archive`, set by `SUBSTRATE_LEDGER_ARCHIVE_DIR` | None | No | Same refusal rule as the index archive |
| Backups | Cutover and pre-sweep backups | Lane-B cutover backups under the operator's `/root/backups`. Pre-sweep index backup is a manual Railway volume snapshot | Volume snapshot (Railway) | Partly | Snapshot is taken by hand before a sweep apply |
| Operator checkouts and worktrees | Development source trees | `/root/src/repos` and `/root/src/worktrees` | None | No | Not runtime state. Out of scope for migration |
| Anchor signer key | Solana anchor signing | A key file under `/etc/substrate` (role only, not read) | None | No | A secret. It is never copied into the repo or a doc |

## 3. Environment-only configuration check

**Method.** Non-test source under `packages/**` and `scripts/**` was searched for three things: fallback values in environment reads (`env.X ?? "..."`), string constants holding a loopback address, a URL, or an absolute path, and any read of a `PORT` variable. Test files were excluded by reading the match paths. The store URLs (`GREPTIME_URL`, `SUBSTRATE_PG_URL`, `DRAGONFLY_URL`, `HINDSIGHT_URL`, `RAGFLOW_URL`) have no literal default in `packages/mcp-server/src/config.ts`, `greptime.ts`, `cache.ts` or `planes/*.ts`, so they are environment-only already. No code reads `PORT`. This is a sampled census, not an exhaustive one: the broadest pass was paged and not read to the end. Before any cutover, a complete literal census should be run.

**Permitted defaults (no follow-up).**

- Loopback client defaults of the form `SUBSTRATE_URL` falling back to the loopback port 7410. These are in `packages/cli/src/index.ts`, `packages/collectors/src/emit.ts`, `muse.ts`, `cursor-stop.ts`, `packages/host/src/substrate.ts`, `packages/projector/omp/substrate-status.ts`, and in `scripts/` (`cache-stats.ts`, `chaos-smoke.ts`, `doctor-runtime.ts`, `substrate-alert.ts`, `grok-connector-smoke.ts`, `promote-advisor.ts`, `parity-check.ts`). `scripts/docs-golden.ts` refuses a non-loopback base. Each default yields to `SUBSTRATE_URL`.
- Public API bases, fixed in code: Linear, Notion, the Anthropic API, and the public devnet Solana RPC (`SOLANA_RPC_URL` default). The public skills library remote is also a public default.
- VM-internal paths under `/home/agentos` in `packages/host/src/options.ts`. They are inside the sandbox image, not on the host.
- The herdr socket default `/root/.config/herdr/herdr.sock` in `packages/collectors/src/herdr.ts`. It is a VPS collector path, and `HERDR_SOCKET_PATH` overrides it.
- Classifier constants, such as `DEV_CHECKOUT_MARK` in `scripts/doctor-units.ts`. They are not addresses.
- Archive directories (`SUBSTRATE_INDEX_ARCHIVE_DIR`, `SUBSTRATE_LEDGER_ARCHIVE_DIR`). Unset, they refuse by name, so there is no default.

**Follow-ups.** Each row is a decision for an operator. None is changed by this phase.

| ID | Literal in code (file) | What it is | Why it matters on Railway | Follow-up |
| --- | --- | --- | --- | --- |
| F1 | `packages/mcp-server/src/config.ts`: bind host default loopback; `SUBSTRATE_PORT` default 7410 | Server bind and port | No code reads `PORT`, which Railway injects. The server would bind loopback by default | Decide the bind address and how the platform port maps to `SUBSTRATE_PORT` or `PORT` |
| F2 | `packages/mcp-server/src/config.ts`: `publicOrigin` default, a public hostname literal | Public origin of the server | Set wrongly, it advertises the VPS origin after a move | Set `SUBSTRATE_PUBLIC_ORIGIN` per environment. DNS is out of scope |
| F3 | `config.ts` (`DEFAULT_SLO_CHECKPOINT_PATH`, `DEFAULT_SKILLS_STATE`, `DEFAULT_DESKTOP_DIR`); `packages/mcp-server/src/skills/propose.ts` (`SKILLS_STATE`); `packages/collectors/src/emit.ts`, `status.ts`, `muse.ts` (`DEFAULT_STATE_DIR`); `grok.ts`, `herdr-state.ts` (state files); `packages/host/src/telegram.ts` (`DEFAULT_STATE_PATH`); `packages/host/src/sandbox-provider.ts` and `audit.ts` (agentos storage default); `packages/host/src/sandbox-options.ts` (`WORKTREES_ROOT`); `packages/collectors/src/cursor-stop.ts` (`TRANSCRIPTS_DIR`); `scripts/docs-golden.ts` (`DEFAULT_CANARY_STATE`); `scripts/doctor-runtime.ts` (`DEFAULT_STATE_FILE`); `scripts/doctor-vps.ts` (`DEFAULT_STATE_DIR`) | Host-local state under `/var/lib/substrate` | Every one needs a volume or an explicit path per service | Decide a volume per service, and set the path variable explicitly |
| F4 | `packages/host/src/main.ts` (`SUBSTRATE_SKILLS_DIR`, `SUBSTRATE_LIBRARY_DIR`, `SUBSTRATE_ULTRATHINK_CONFIG` defaults under `/root`); `packages/host/src/mcp-proxy.ts` (`DEFAULT_ULTRATHINK_MCP`); `packages/collectors/src/cursor-stop.ts` (`CURSOR_ROOT`); `scripts/skills-doctor.ts` (`LIBRARY_DIR_DEFAULT`, `HOME_DEFAULT`) | Operator home paths under `/root` | A container image has no such home | Require these variables in the environment; remove the `/root` defaults when the host moves |
| F5 | `packages/ledger/src/solana.ts` (`SOLANA_CLI_DEFAULT`); `config.ts` (`SOLANA_CLI` fallback to that path) | Solana CLI install path under `/root` | The path is absent in a container | Pin the CLI in the image or set `SOLANA_CLI` |
| F6 | `config.ts` (`DEFAULT_HERMES_LINEAR_URL`, loopback 8792); `packages/host/src/main.ts` (engine endpoint 6420, MCP base 7410); `packages/host/src/options.ts` (`MODEL_RELAY_URL`, loopback relay) | Loopback sidecars and engine | These run only on the VPS | Give each a private URL through the environment, or keep the sidecar on the host |
| F7 | `packages/cli/src/token.ts`, `packages/host/src/substrate.ts`, `packages/projector/omp/substrate-skills.ts`, `substrate-status.ts` (`DEFAULT_TOKENS_DIR`, `/etc/substrate/tokens`); `packages/collectors/src/muse.ts` (`DEFAULT_TOKEN_FILE`); `scripts/skills-doctor.ts` (`BRIDGE_ENV_DEFAULT`) | Token and env-file defaults under `/etc/substrate` | A Railway service receives its bearer as a service variable, not a file | Decide how the bearer reaches each service. File contents are not read by this phase |
| F8 | `packages/mcp-server/src/ledger-archive.ts` (`RELEASE_ROOT`); `scripts/doctor-runtime.ts` (`RELEASE_ROOT`); `scripts/doctor-units.ts` and `scripts/parity-check.ts` (`RELEASE_CURRENT`); `scripts/skills-doctor.ts` (`OMP_LINK_TARGET`) | Release tree under `/opt/agent-substrate` | These are VPS operator tools, and the release layout is host-specific | Keep them VPS-only, or parameterize them if they run elsewhere |
| F9 | `scripts/rehearsal.ts` (`INDEX_ARCHIVE_MOUNT`, the production archive mount used as a refusal list) | Off-box archive mount path | A Railway archive needs a volume or bucket | Decide the archive target for Railway. The archive commands already refuse when unset |
| F10 | `scripts/rehearsal.ts` (`UNIT_WORKING_DIRECTORY`, the production checkout) | Production checkout constant | The rehearsal must never run against a moved host | Keep the rehearsal off Railway, or parameterize the constant. No change here |

**Follow-up count: 10** (F1 to F10).

## 4. Cutover and DNS

Cutover and DNS are explicitly out of scope for this document and for Phase 54. The following are not done or decided here: moving any store, changing any DNS record, removing any public domain or TCP proxy, changing any environment file, restarting any VPS unit, and deploying anything to production. The forwarder and cutover steps in `docs/railway-tailscale.md` are a separate decision that an operator takes with its own approval.
