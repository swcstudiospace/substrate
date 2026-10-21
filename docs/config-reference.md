# Configuration reference

Every environment variable read by TypeScript under `packages/` and `scripts/` (tests excluded), by plane. **Not covered: the Python dispatcher and the infra shell** (`infra/vps/*.sh`); a variable read only there (the dispatcher's `SUBSTRATE_DISPATCH_*` settings, the health-probe settings of the shell units, `BOOT_GATE` and `CI_ENABLED` in the CI workflow) has no row, except the few shell-read operator switches the registry lists on purpose (rows flagged SHELL: the two deploy-hook modes). **Generated** from `packages/mcp-server/src/flag-registry.ts` by `bun run config:reference`; do not edit it by hand (`bun run config:reference -- --check` exits 1 when it has drifted, and `config-reference.test.ts` runs that check). `flag-registry.test.ts` fails when that TypeScript reads a name the registry does not list, so a flag read there cannot ship undocumented; the scanner's remaining blind spots are listed in `flag-registry-scan.ts`.

How to read a row: **Default** is what the code uses when the variable is unset or invalid; **Unset** says what that means in practice; **Read by** is descriptive (the owning reader). **In `.env.example`** says whether `.env.example` carries a `NAME=` line (live or commented). Values are never shown for a secret reference: those variables hold credentials, and the reference names them only.

Which environment a name belongs in is part of the row: the server's shared env file, a unit drop-in (the sweep, the doctor, the watchdog) or a host/client environment. `docs/runbooks/flag-promotion.md` says when a policy flag is safe to flip; the table of promotion policies below is the registry's view of it.

## Identity, tokens and memory governance

| Name | Kind | Default | Allowed | Unset means | Read by | In `.env.example` |
| --- | --- | --- | --- | --- | --- | --- |
| `SUBSTRATE_ALLOW_ANONYMOUS` | toggle | none | 1 \| true \| yes \| 0 \| false \| no (case-insensitive; anything else is unset) | untokened callers are accepted only while no surface token is configured; 1 keeps them alongside tokens, 0 requires a bearer. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_OPERATOR_TOKENS` | secret-ref | none | comma separated tokens | no operator authority; each must also be a surface token. See `docs/memory-governance.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_MEMORY_REVIEW_TOKENS` | secret-ref | none | comma or space separated, 16+ characters | global memories, human-confirmed trust and quarantine release stay closed. See `docs/memory-governance.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_MEMORY_GRANTS` | string | none | JSON array of grants | only the default-deny RBAC policy; malformed entries are dropped with a warning. See `docs/memory-governance.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_HANDOFF_KEY` | secret-ref | none | signing key | signed handoffs are unavailable. See `docs/coordination.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_HANDOFF_KEY_ID` | string | k1 | key id | k1. See `docs/coordination.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_HANDOFF_KEY_PREV` | secret-ref | none | previous signing key | no previous key; packets signed under it stop verifying. See `docs/coordination.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_HANDOFF_KEY_PREV_ID` | string | k0 | key id | k0. See `docs/coordination.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_LEASE_TTL_SECONDS` | number | 900 | 30..86400 (clamped) | 900 s. See `docs/coordination.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_AUDIT_PATH` | path | none | absolute file path | no durable audit chain: the server boots with a warning and fail-closed tools refuse. See `docs/mcp-audit.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_AUDIT_ROLLOVER_BYTES` | number | none | positive integer bytes | the audit chain never rolls. See `docs/mcp-audit.md` | audit/log.ts | yes |
| `SUBSTRATE_TOKEN` | secret-ref | none | one bearer token | the client falls back to SUBSTRATE_TOKEN_FILE, then the tokens directory. See `docs/swarm-workspace.md` | cli/token.ts, host/substrate.ts, scripts | yes |
| `SUBSTRATE_TOKEN_FILE` | path | none | file holding one token | the client falls back to the tokens directory. See `docs/swarm-workspace.md` | cli/token.ts, host/substrate.ts | yes |
| `SUBSTRATE_TOKENS_DIR` | path | /etc/substrate/tokens | directory of per-surface token files | the default directory. See `docs/swarm-workspace.md` | cli/token.ts, host/substrate.ts | yes |
| `SUBSTRATE_TOKEN_<SURFACE>` | secret-ref | none | comma or space separated bearer tokens, 16 characters or more | that surface has no token; with no surface token at all the server accepts untokened callers. See `docs/swarm-workspace.md` | mcp-server/config.ts | yes |

## Server, trackers and desktop

| Name | Kind | Default | Allowed | Unset means | Read by | In `.env.example` |
| --- | --- | --- | --- | --- | --- | --- |
| `SUBSTRATE_HOST` | string | 127.0.0.1 | bind address | loopback | mcp-server/config.ts | yes |
| `SUBSTRATE_PORT` | number | 7410 | port | 7410 | mcp-server/config.ts | yes |
| `SUBSTRATE_URL` | string | http://127.0.0.1:7410 | base URL | clients use the loopback default; a swarm workspace with it unset is off | cli, projector, scripts/doctor-runtime.ts | yes |
| `SUBSTRATE_PUBLIC_ORIGIN` | string | https://substrate.swcstudio.space | https origin | https://substrate.swcstudio.space | mcp-server/config.ts | yes |
| `SUBSTRATE_DESKTOP_SURFACES` | list | none | comma separated known surfaces | nobody may call desktop_run. See `docs/runbooks/desktop.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_DESKTOP_DIR` | path | /var/lib/substrate/desktop | absolute path | the default; a relative value is refused with a boot warning. See `docs/runbooks/desktop.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_SKILLS_REPO` | string | swcstudiospace/agent-skills | owner/repo | the production skills library. See `docs/skills-propose.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_SKILLS_REMOTE_URL` | string | https://github.com/swcstudiospace/agent-skills.git | git remote URL | the production remote. See `docs/skills-propose.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_SKILLS_STATE` | path | /var/lib/substrate/skills | directory | the default state directory. See `docs/skills-propose.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_SKILLS_GH` | string | gh | gh binary | gh from PATH. See `docs/skills-propose.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_SKILLS_GOVERNANCE` | mode | off | off \| report \| enforce (case- and space-insensitive; anything else is off with a boot warning) | off: skills_propose records no registry row, nothing is filtered, and the skills projector makes no fetch (skills_approve and skills_list still exist). See `docs/runbooks/skills-governance.md` | mcp-server/config.ts, projector/skills-governance.ts | yes |
| `LINEAR_API_KEY` | secret-ref | none | Linear API key | Linear sync is off | mcp-server/config.ts, host/sync.ts | yes |
| `LINEAR_API_URL` | string | https://api.linear.app/graphql | URL | the real API; the rehearsal points it at a loopback fake. See `docs/rehearsal.md` | mcp-server/config.ts | yes |
| `NOTION_API_KEY` | secret-ref | none | Notion integration key | Notion sync is off | mcp-server/config.ts, host/sync.ts | yes |
| `NOTION_API_URL` | string | https://api.notion.com | URL | the real API; the rehearsal points it at a loopback fake. See `docs/rehearsal.md` | mcp-server/config.ts | yes |
| `NOTION_TASK_GRAPH_DS` | string | the repo's task-graph data source id | data source id | the built-in id | mcp-server/config.ts, host/sync.ts | yes |
| `HERMES_LINEAR_URL` | string | http://127.0.0.1:8792 | URL | the connector's loopback address | mcp-server/config.ts | yes |
| `SUBSTRATE_DOD_GATE_TIMEOUT_MS` | number | 35000 | positive integer ms | 35000 ms | mcp-server/config.ts | yes |
| `RAILWAY_API_TOKEN` | secret-ref | none | Railway API token, sent as a bearer token to the public API | every railway_* tool reports unconfigured and the writes refuse before any request. See `docs/data-planes.md` | mcp-server/railway.ts | yes |
| `SUBSTRATE_RAILWAY_WRITES` | toggle | off | on | off: railway_scale and railway_deploy refuse with writes-disabled before any request; on still needs an operator and an approval reference. See `docs/data-planes.md` | mcp-server/railway.ts | yes |

## Event ledger (GreptimeDB) and anchors

| Name | Kind | Default | Allowed | Unset means | Read by | In `.env.example` |
| --- | --- | --- | --- | --- | --- | --- |
| `GREPTIME_URL` | secret-ref | none | HTTP SQL base URL | no ledger: events are not recorded and claims are not withdrawn for it. See `docs/greptime-ledger.md` | mcp-server/config.ts | yes |
| `GREPTIME_USER` | secret-ref | none | user | unauthenticated ledger calls. See `docs/greptime-ledger.md` | mcp-server/config.ts | yes |
| `GREPTIME_PASSWORD` | secret-ref | none | password | unauthenticated ledger calls. See `docs/greptime-ledger.md` | mcp-server/config.ts | yes |
| `GREPTIME_DB` | string | public | database name | public. See `docs/greptime-ledger.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` | toggle | false | 1 \| true \| yes (case-insensitive; anything else is off) | appends are refused unless agent_events is provably in append_mode. See `docs/greptime-ledger.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_CLAIM_REQUIRE_LEDGER` | toggle | on when a ledger is configured | 1 \| true \| yes \| 0 \| false \| no (case-insensitive; anything else is unset) | a claim whose event did not reach the ledger is withdrawn when a ledger is configured. See `docs/greptime-ledger.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_LEDGER_CHAIN_CACHE` | toggle | on | 0 \| false \| no turns it off | chain-tip cache on. See `docs/greptime-ledger.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_LEDGER_CHAIN_CACHE_MAX` | number | 10000 | 1..1000000 | 10000 sessions. See `docs/greptime-ledger.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_LEDGER_CHAIN_LOOKBACK_DAYS` | number | 30 | 1..3650 | 30 days. See `docs/greptime-ledger.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_LEDGER_WRITE_PROBE_S` | number | 60 | 0..86400 (0 never probes) | 60 s. See `docs/greptime-ledger.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_LEDGER_TTL` | string | none | Greptime duration (180d, 4320h, 1h30m) | no ALTER: retention is left as the table has it; a malformed value refuses to boot. See `docs/greptime-ledger.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_LEDGER_MAX_UNCOVERED_HOURS` | number | 2 | 0..100000 | 2 hours. See `docs/greptime-ledger.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_LEDGER_ARCHIVE_DIR` | path | none | off-box mount | substrate ledger archive refuses by name unless --out is given. See `docs/greptime-ledger.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_LEDGER_ARCHIVE_ALLOW_ROOTFS` | toggle | false | 1 \| true \| yes (case-insensitive; anything else is off) | an archive on the root filesystem is refused. See `docs/greptime-ledger.md` | mcp-server/ledger-run.ts, index-archive.ts | yes |
| `SOLANA_RPC_URL` | string | https://api.devnet.solana.com | URL | public devnet | mcp-server/config.ts | yes |
| `SOLANA_ANCHOR_KEYPAIR` | path | none | keypair file path | the hourly anchor job is not configured | mcp-server/config.ts | yes |
| `SOLANA_ANCHOR_PUBKEY` | string | none | public key | anchors are not verified against a key | mcp-server/config.ts | yes |
| `SOLANA_CLI` | path | the solana CLI install path | binary | the built-in path | mcp-server/config.ts | yes |
| `SUBSTRATE_VERIFY_TIMEOUT_MS` | number | 30000 | positive ms | 30000 ms | mcp-server/config.ts | yes |
| `SUBSTRATE_EVENT_IDEMPOTENCY` | mode | off | off \| accept \| enforce (case- and space-insensitive; anything else is off with a boot warning) | off: POST /events ignores idempotency_key and the x-substrate-replay header; nothing is stored and responses are unchanged. See `docs/greptime-ledger.md` | mcp-server/config.ts | yes |

## Index (Postgres) and memory lifetime

| Name | Kind | Default | Allowed | Unset means | Read by | In `.env.example` |
| --- | --- | --- | --- | --- | --- | --- |
| `SUBSTRATE_PG_URL` | secret-ref | none | postgres URL | no index: graph, memory and brief sources are unavailable. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_PG_POOL_MAX` | number | 8 | 1..50 (clamped) | 8 | mcp-server/index-store.ts | yes |
| `SUBSTRATE_PG_CONNECT_TIMEOUT_MS` | number | 2000 | 200..60000 (clamped) | 2000 ms | mcp-server/index-store.ts | yes |
| `SUBSTRATE_PG_STATEMENT_TIMEOUT_MS` | number | 5000 | 0..600000 (0 = server default) | 5000 ms | mcp-server/index-store.ts | yes |
| `SUBSTRATE_PG_IDLE_TIMEOUT_S` | number | 300 | 0..86400 (0 = never) | 300 s | mcp-server/index-store.ts | yes |
| `SUBSTRATE_MEMORY_EXPIRY` | mode | report | report \| enforce | report: expired entries are served tagged and counted; anything else is report with a boot warning. See `docs/memory-governance.md` | mcp-server/memory-policy.ts, index-sweep.ts | yes |
| `SUBSTRATE_MEMORY_LIFECYCLE` | mode | report | report \| off | report: the sweep prints lifecycle candidate ids and document ids and deletes nothing; off skips that read; anything else is report with a boot warning. See `docs/memory-governance.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_HASH_VERSION` | mode | v1 | v1 \| v2 | v1: today's hash preimage; anything else that is not v2 is v1, and an unrecognised non-empty value warns at boot. See `docs/memory-governance.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_INDEX_SWEEP` | mode | dry-run | dry-run \| apply \| off | dry-run: report what the documented retention would remove, delete nothing; anything unrecognised is dry-run. See `docs/memory-governance.md` | mcp-server/index-sweep.ts | yes |
| `SUBSTRATE_SWEEP_GRAPHS_DAYS` | number | 90 | 1..3650 | 90 days. See `docs/memory-governance.md` | mcp-server/index-sweep.ts | yes |
| `SUBSTRATE_SWEEP_SUPERSEDED_DAYS` | number | 90 | 1..3650 | 90 days. See `docs/memory-governance.md` | mcp-server/index-sweep.ts | yes |
| `SUBSTRATE_SWEEP_DERIVED_WRITES_DAYS` | number | 7 | 1..3650 | 7 days. See `docs/memory-governance.md` | mcp-server/index-sweep.ts | yes |
| `SUBSTRATE_SWEEP_EXPLICIT_WRITES_DAYS` | number | 30 | 1..3650 | 30 days. See `docs/memory-governance.md` | mcp-server/index-sweep.ts | yes |
| `SUBSTRATE_SWEEP_REVIEWS_DAYS` | number | 30 | 1..3650 | 30 days. See `docs/memory-governance.md` | mcp-server/index-sweep.ts | yes |
| `SUBSTRATE_SWEEP_QUARANTINE_DAYS` | number | 30 | 1..3650 | 30 days. See `docs/memory-governance.md` | mcp-server/index-sweep.ts | yes |
| `SUBSTRATE_SWEEP_BATCH` | number | 500 | 1..5000 | 500 rows per DELETE. See `docs/memory-governance.md` | mcp-server/index-sweep.ts | yes |
| `SUBSTRATE_INDEX_ARCHIVE_DIR` | path | none | dedicated mount | substrate index archive refuses by name and writes nothing; the index.archive.age row is absent. See `docs/runbooks/index-archive.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_INDEX_ARCHIVE_MAX_AGE_H` | number | none | hours | the index.archive.age row is report-only. See `docs/runbooks/index-archive.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_INDEX_ARCHIVE_MAX_SECONDS` | number | 900 | 10..86400 | 900 s. See `docs/runbooks/index-archive.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_INDEX_ARCHIVE_MAX_BYTES` | number | 1073741824 | 1 MiB..1 TiB | 1 GiB. See `docs/runbooks/index-archive.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_INDEX_ARCHIVE_ALLOW_ROOTFS` | toggle | false | 1 \| true \| yes (case-insensitive; anything else is off) | an archive on the root filesystem is refused. See `docs/runbooks/index-archive.md` | mcp-server/index-archive.ts | yes |
| `SUBSTRATE_INDEX_SCRATCH_URL` | secret-ref | none | scratch postgres URL | substrate index restore needs --scratch. See `docs/runbooks/index-archive.md` | mcp-server/index-run.ts | yes |
| `SUBSTRATE_INDEX_TUNE` | mode | off | off \| apply (anything but apply is off) | off: no storage tune; anything but apply is off. See `docs/runbooks/index-archive.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_INDEX_VOLUME_BYTES` | number | none | bytes | no capacity runway row (the ceiling is unknown). See `docs/observability.md` | observability/config.ts | yes |

## Cache (loopback redis)

| Name | Kind | Default | Allowed | Unset means | Read by | In `.env.example` |
| --- | --- | --- | --- | --- | --- | --- |
| `DRAGONFLY_URL` | string | none | loopback redis URL | no cache; a non-loopback URL is refused with a boot warning. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_CACHE` | toggle | on when DRAGONFLY_URL is set | 0 \| false \| no turns it off | on when the URL is set; anything else is unset. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS` | number | 250 | positive ms | 250 ms | mcp-server/config.ts | yes |
| `SUBSTRATE_CACHE_CONNECT_TIMEOUT_MS` | number | 250 | positive ms | 250 ms | mcp-server/config.ts | yes |
| `SUBSTRATE_DB_ENDPOINT_POLICY` | mode | warn | warn \| enforce (case- and space-insensitive; unset or blank is warn; anything else refuses boot) | warn: a direct GREPTIME_URL, SUBSTRATE_PG_URL or DRAGONFLY_URL is reported at boot and the service runs as before. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_DB_PROXY_ALLOW` | list | none | comma-separated host:port entries (host lowercased, port 1 to 65535) | no proxy entries: only loopback endpoints are non-direct. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_CACHE_SWR` | mode | shadow | off \| shadow \| enforce | shadow: count would_serve_stale, serve the live brief exactly as before. See `docs/data-planes.md` | mcp-server/config.ts, cache.ts | yes |
| `SUBSTRATE_CACHE_SWR_WINDOW_S` | number | 30 | 1..300 | 30 s. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_CACHE_BUMP_SCOPE` | mode | legacy | legacy \| narrow (case- and space-insensitive; anything else is legacy, named at boot) | legacy: a Hindsight retain or outbox replay bumps the memory generation (flushes every brief and search, twice per forwarded write) and a heartbeat flushes graph-scoped briefs. See `docs/data-planes.md` | mcp-server/config.ts | yes |

## Brief and recall-in-the-brief

| Name | Kind | Default | Allowed | Unset means | Read by | In `.env.example` |
| --- | --- | --- | --- | --- | --- | --- |
| `SUBSTRATE_BRIEF_BUDGET_MS` | number | 1200 | 0 = no deadline | 1200 ms. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_BRIEF_RECENT_WINDOW_DAYS` | number | 30 | positive integer | 30 days. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` | number | 3600 | 0 = no snapshots | 3600 s. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_HEALTHZ_CACHE_MS` | number | 5000 | 0 = recompute per call | 5000 ms. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S` | number | 0 | 0..300 whole seconds (a fraction is floored with a boot warning; above 300 is capped at 300 with a boot warning; negative or not a number is 0 with a boot warning) | 0: the index size report (capacity.index) is measured on every computed /healthz body. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_BRIEF_GRAPH_READ` | mode | full | full \| lite (case- and space-insensitive; anything else is full, named at boot) | full: a graph-scoped brief reads its graph with four serial statements. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_BRIEF_PROFILE` | mode | shadow | off \| shadow \| enforce | shadow: build the compact text, record bytes saved, serve the full text; anything else is shadow with a boot warning. See `docs/grok-bot.md` | mcp-server/brief-profile.ts | yes |
| `SUBSTRATE_BRIEF_PROFILE_SURFACES` | list | grok-bot,grok-build | comma or space separated known surfaces | grok-bot and grok-build; unknown names are ignored with a boot warning. See `docs/grok-bot.md` | mcp-server/brief-profile.ts | yes |
| `SUBSTRATE_BRIEF_COMPACT_NODES` | number | 12 | 1..200 (clamped) | 12. See `docs/grok-bot.md` | mcp-server/brief-profile.ts | yes |
| `SUBSTRATE_BRIEF_COMPACT_MEMORY_CHARS` | number | 240 | 40..4000 (clamped) | 240. See `docs/grok-bot.md` | mcp-server/brief-profile.ts | yes |
| `SUBSTRATE_BRIEF_COMPACT_BYTES` | number | 3500 | 512..65536 (clamped) | 3500 bytes. See `docs/grok-bot.md` | mcp-server/brief-profile.ts | yes |
| `SUBSTRATE_SERVED_TOKENS_PER_HOUR` | number | none | tokens per rolling hour | the served.tokens_est rows of /slo report unconfigured and are never judged. See `docs/observability.md` | observability/slo.ts | yes |
| `SUBSTRATE_BRIEF_RECALL` | mode | off | off \| shadow \| enforce | off: no prefetcher, no Hindsight traffic, every brief and ETag as before; an unknown value is off with a boot warning. See `docs/data-planes.md` | mcp-server/recall-snapshot.ts | yes |
| `SUBSTRATE_BRIEF_RECALL_INTERVAL_S` | number | 120 | 30..3600 | 120 s. See `docs/data-planes.md` | mcp-server/recall-snapshot.ts | yes |
| `SUBSTRATE_BRIEF_RECALL_TTL_S` | number | 900 | 60..86400 | 900 s. See `docs/data-planes.md` | mcp-server/recall-snapshot.ts | yes |
| `SUBSTRATE_BRIEF_RECALL_BUDGET_MS` | number | 1500 | 100..10000 | 1500 ms. See `docs/data-planes.md` | mcp-server/recall-snapshot.ts | yes |

## Recall plane (Hindsight)

| Name | Kind | Default | Allowed | Unset means | Read by | In `.env.example` |
| --- | --- | --- | --- | --- | --- | --- |
| `HINDSIGHT_URL` | secret-ref | none | Hindsight base URL | no recall plane: memory_search skips Hindsight, retain is not forwarded. See `docs/data-planes.md` | mcp-server/planes/hindsight.ts | yes |
| `HINDSIGHT_API_KEY` | secret-ref | none | API key | no recall plane. See `docs/data-planes.md` | mcp-server/planes/hindsight.ts | yes |
| `HINDSIGHT_BANK_PREFIX` | string | sub- | bank name prefix | sub-. See `docs/data-planes.md` | mcp-server/planes/hindsight.ts | yes |
| `HINDSIGHT_BANKS` | list | none | comma separated bank names | recall reads the caller's own bank only. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `HINDSIGHT_BANK` | string | none | legacy | nothing: set or not, it is unread and only triggers a boot warning (LEGACY: read only to warn at boot). See `docs/data-planes.md` | mcp-server/config.ts, legacy-env.ts | no |
| `HINDSIGHT_RECALL_BUDGET_MS` | number | 4000 | positive integer ms | 4000 ms. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `HINDSIGHT_SEARCH_RECALL_BUDGET_MS` | number | 1500 | positive integer ms | 1500 ms. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `HINDSIGHT_RETAIN_TIMEOUT_MS` | number | 8000 | positive integer ms | 8000 ms. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_RETAIN_OUTBOX_PATH` | path | none | file path | memory-only retain queue. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_RETAIN_OUTBOX_MAX` | number | 10000 | positive integer | 10000 entries. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_RETAIN_MAX_ATTEMPTS` | number | 10 | positive integer | 10 attempts. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_RETAIN_DRAIN_MS` | number | 30000 | positive integer ms | 30000 ms. See `docs/data-planes.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_HINDSIGHT_INVENTORY` | toggle | off | on \| off | off: no probes, no gauges, no /healthz hindsight block; anything else is off with a boot warning. See `docs/data-planes.md` | mcp-server/hindsight-inventory.ts | yes |
| `SUBSTRATE_HINDSIGHT_INVENTORY_INTERVAL_S` | number | 60 | 30..3600 | 60 s. See `docs/data-planes.md` | mcp-server/hindsight-inventory.ts | yes |
| `HINDSIGHT_MENTAL_MODELS` | list | none | bank=id[,id...] entries separated by semicolon; bank must be in HINDSIGHT_BANKS; id matches A-Za-z0-9_- up to 80 characters; at most 20 models | no weekly refresh; no timer starts. See `docs/memory-governance.md` | mcp-server/config.ts | no |

## Documents plane (RAGFlow)

| Name | Kind | Default | Allowed | Unset means | Read by | In `.env.example` |
| --- | --- | --- | --- | --- | --- | --- |
| `RAGFLOW_URL` | string | none | RAGFlow base URL | docs_search answers degraded, docs_ingest refuses. See `docs/docs-search-ingest.md` | mcp-server/planes/ragflow.ts | yes |
| `RAGFLOW_API_KEY` | secret-ref | none | API key | the plane is unconfigured. See `docs/docs-search-ingest.md` | mcp-server/planes/ragflow.ts | yes |
| `RAGFLOW_DATASET_ID` | string | none | dataset id | nothing: no code reads it today (docs_ingest names the dataset after the repo) (UNREAD: no code reads it today). See `docs/docs-search-ingest.md` | none | yes |
| `SUBSTRATE_DOCS_INGEST_ROOTS` | list | docs/, README.md, .planning/PROJECT.md | comma separated path prefixes | the default roots. See `docs/docs-search-ingest.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_AGENT_SKILLS_ROOT` | path | none | absolute path to an agent-skills checkout | the merge-trigger for agent-skills is a noop: no checkout, no version recorded. See `docs/docs-search-ingest.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_VM_GUEST` | toggle | off | 1 | docs_ingest is allowed; 1 refuses it before any network call. See `docs/docs-search-ingest.md` | mcp-server/config.ts, cli/index.ts | yes |
| `SUBSTRATE_DOCS_STATE_FILE` | path | none | file path | ingest records and version pins stay process-local. See `docs/docs-search-ingest.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_DOCS_PRUNE_SUPERSEDED` | toggle | off | 1 | off: every superseded document stays on the plane. See `docs/docs-search-ingest.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_DOCS_SIMILARITY_THRESHOLD` | number | 0.2 | [0, 1] | 0.2. See `docs/docs-search-ingest.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_DOCS_VECTOR_WEIGHT` | number | 0.3 | [0, 1] | 0.3. See `docs/docs-search-ingest.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_DOCS_TOP_K` | number | 1024 | positive integer | 1024. See `docs/docs-search-ingest.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_RAGFLOW_VECTOR_WEIGHT` | number | 0.3 | [0, 1] | 0.3. See `docs/docs-search-ingest.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_RAGFLOW_RERANK_ID` | string | none | reranker model id | no reranker: no rerank_id is sent. See `docs/docs-search-ingest.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_DOCS_SEARCH_BUDGET_MS` | number | 4000 | 0 = no shared deadline | 4000 ms. See `docs/docs-search-ingest.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_DOCS_FRESHNESS_MAX_AGE_H` | number | 168 | 0..8760 (0 reports without judging) | 168 hours. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_DOCS_TRIGGER_LAG_MIN` | number | 15 | 0..10080 (0 stops recording) | 15 minutes. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_DOCS_LAG_CHECK_S` | number | 60 | 15..3600 | 60 s. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_DOCS_CANARY` | toggle | off | 1 | the live golden canary refuses to run. See `docs/docs-search-ingest.md` | scripts/docs-golden.ts | yes |
| `SUBSTRATE_DOCS_CANARY_MANIFEST` | path | none | JSON file with sha256 and dataset_commit | the live canary refuses to run. See `docs/docs-search-ingest.md` | scripts/docs-golden.ts | yes |
| `SUBSTRATE_DOCS_CANARY_STATE` | path | /var/lib/substrate/docs-canary-last.json | file path | the default state file. See `docs/docs-search-ingest.md` | scripts/docs-golden.ts | yes |
| `SUBSTRATE_DOCS_TIMEOUT_MS` | number | 180000 | positive ms | 180000 ms (the CLI's docs ingest and merge-trigger calls). See `docs/docs-search-ingest.md` | cli/docs.ts | yes |

## Admission budgets and circuit breakers

| Name | Kind | Default | Allowed | Unset means | Read by | In `.env.example` |
| --- | --- | --- | --- | --- | --- | --- |
| `SUBSTRATE_BUDGETS` | mode | shadow | off \| shadow \| enforce | shadow: decide and count, never refuse; anything else is shadow. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_BUDGET_ANONYMOUS_RPS` | number | 2 | positive number | 2. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_BUDGET_ANONYMOUS_BURST` | number | 4 | positive integer | 4. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_BREAKER` | toggle | on | 0 \| false \| no turns every breaker off | breakers on. See `docs/observability.md` | observability/breaker.ts | yes |
| `SUBSTRATE_BREAKER_FAILURES` | number | 5 | 1..100 | 5. See `docs/observability.md` | observability/breaker.ts | yes |
| `SUBSTRATE_BREAKER_OPEN_MS` | number | 30000 | 1000..600000 | 30000 ms. See `docs/observability.md` | observability/breaker.ts | yes |
| `SUBSTRATE_BUDGET_<CLASS>_RPS \| _BURST` | number | read 20/40, write 10/20, coordination 30/60 (rps/burst) | positive number (rps) or positive integer (burst) | the class default; per-surface SUBSTRATE_BUDGET_<SURFACE>_<CLASS>_RPS \| _BURST override a half and the half left out is the class value. See `docs/observability.md` | mcp-server/config.ts | yes |

## Observability, SLOs and metrics history

| Name | Kind | Default | Allowed | Unset means | Read by | In `.env.example` |
| --- | --- | --- | --- | --- | --- | --- |
| `SUBSTRATE_RAILWAY_BUDGET_USD` | number | 50 | positive USD per month | 50: the owner's ceiling; a projected monthly total above it reads over-budget. See `docs/data-planes.md` | mcp-server/railway.ts | yes |
| `SUBSTRATE_RAILWAY_PROJECT_IDS` | list | none | comma separated Railway project ids | no project is summed; the cost report has no usage to price. See `docs/data-planes.md` | mcp-server/railway.ts | yes |
| `SUBSTRATE_RAILWAY_PRICE_CPU_USD` | number | none | positive USD per vCPU unit, cents kept | unpriced: a CPU line with usage and no price makes the cost status unpriced; no price is assumed. See `docs/data-planes.md` | mcp-server/railway.ts | yes |
| `SUBSTRATE_RAILWAY_PRICE_MEMORY_GB_USD` | number | none | positive USD per GB of memory, cents kept | unpriced: a memory line with usage and no price makes the cost status unpriced; no price is assumed. See `docs/data-planes.md` | mcp-server/railway.ts | yes |
| `SUBSTRATE_RAILWAY_PRICE_DISK_GB_USD` | number | none | positive USD per GB of disk, cents kept | unpriced: a disk line with usage and no price makes the cost status unpriced; no price is assumed. See `docs/data-planes.md` | mcp-server/railway.ts | yes |
| `SUBSTRATE_RAILWAY_PRICE_NETWORK_TX_GB_USD` | number | none | positive USD per GB sent, cents kept | unpriced: a network line with usage and no price makes the cost status unpriced; no price is assumed. See `docs/data-planes.md` | mcp-server/railway.ts | yes |
| `SUBSTRATE_RAILWAY_SCALE_MIN_VCPUS` | number | 0.25 | positive number of vCPUs | 0.25: the lower bound for a suggestion and for a gated write. See `docs/data-planes.md` | mcp-server/railway.ts | yes |
| `SUBSTRATE_RAILWAY_SCALE_MAX_VCPUS` | number | 4 | positive number of vCPUs, at least the minimum | 4: the upper bound for a suggestion and for a gated write. See `docs/data-planes.md` | mcp-server/railway.ts | yes |
| `SUBSTRATE_RAILWAY_SCALE_MIN_MEMORY_GB` | number | 0.25 | positive number of GB | 0.25: the lower bound for a suggestion and for a gated write. See `docs/data-planes.md` | mcp-server/railway.ts | yes |
| `SUBSTRATE_RAILWAY_SCALE_MAX_MEMORY_GB` | number | 8 | positive number of GB, at least the minimum | 8: the upper bound for a suggestion and for a gated write. See `docs/data-planes.md` | mcp-server/railway.ts | yes |
| `SUBSTRATE_RAILWAY_SCALE_HEADROOM` | number | 0.3 | number from 0 to 1 | 0.3: the fraction added above the p95 usage in a scale suggestion. See `docs/data-planes.md` | mcp-server/railway.ts | yes |
| `SUBSTRATE_RAILWAY_SCALE_WINDOW_SECONDS` | number | 86400 | positive number of seconds | 86400: the window the scale suggestion reads usage over. See `docs/data-planes.md` | mcp-server/railway.ts | yes |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | string | none | OTLP/HTTP base URL | export is off. See `docs/observability.md` | observability/config.ts | yes |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | string | the generic endpoint | URL | the generic endpoint. See `docs/observability.md` | observability/config.ts | yes |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | string | the generic endpoint | URL | the generic endpoint. See `docs/observability.md` | observability/config.ts | yes |
| `OTEL_EXPORTER_OTLP_HEADERS` | secret-ref | none | key=value list | no export headers; the value may carry a token and is never printed. See `docs/observability.md` | observability/config.ts | yes |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | number | 5000 | >= 100 ms | 5000 ms. See `docs/observability.md` | observability/config.ts | yes |
| `OTEL_SERVICE_NAME` | string | substrate-mcp | service name | substrate-mcp. See `docs/observability.md` | observability/config.ts | yes |
| `OTEL_RESOURCE_ATTRIBUTES` | string | none | key=value list | no extra resource attributes. See `docs/observability.md` | observability/config.ts | yes |
| `SUBSTRATE_OTLP_INTERVAL_MS` | number | 30000 | >= 1000 ms | 30000 ms. See `docs/observability.md` | observability/config.ts | yes |
| `SUBSTRATE_TRACE_SAMPLE_RATIO` | number | 1 | 0..1 | 1 (every trace). See `docs/observability.md` | observability/config.ts | yes |
| `SUBSTRATE_TRACE_BUFFER` | number | 2048 | >= 16 spans | 2048. See `docs/observability.md` | observability/config.ts | yes |
| `SUBSTRATE_INSTANCE_ID` | string | the hostname | instance id | the hostname. See `docs/observability.md` | observability/config.ts | yes |
| `SUBSTRATE_ENV` | string | none | deployment environment name | no deployment.environment attribute. See `docs/observability.md` | observability/config.ts | yes |
| `SUBSTRATE_SLO_BRIEF_P95_MS` | number | 800 | a brief histogram bucket bound | 800 ms. See `docs/observability.md` | observability/config.ts | yes |
| `SUBSTRATE_SLO_EMIT_SUCCESS` | number | 0.995 | ratio | 0.995. See `docs/observability.md` | observability/config.ts | yes |
| `SUBSTRATE_SLO_LEASE_STEAL` | number | 0.005 | ratio | 0.005 (provisional). See `docs/observability.md` | observability/config.ts | yes |
| `SUBSTRATE_SLO_QUARANTINE` | number | 0.01 | ratio | 0.01 (provisional). See `docs/observability.md` | observability/config.ts | yes |
| `SUBSTRATE_SLO_MIN_SAMPLES` | number | 20 | count | 20. See `docs/observability.md` | observability/config.ts | yes |
| `SUBSTRATE_SLO_PLANE_AVAILABILITY` | number | 0.99 | ratio | 0.99. See `docs/observability.md` | observability/config.ts | yes |
| `SUBSTRATE_SLO_DOCS_SEARCH_P95_MS` | number | 2000 | a docs histogram bucket bound | 2000 ms. See `docs/observability.md` | observability/config.ts | yes |
| `SUBSTRATE_SLO_RUNWAY_DAYS` | number | 14 | days | 14 days. See `docs/observability.md` | observability/config.ts | yes |
| `SUBSTRATE_SLO_CHECKPOINT` | path | /var/lib/substrate/slo-checkpoint.json when /var/lib/substrate exists | absolute path \| off | the default path when its directory exists, else no checkpoint; a relative value is rejected with a boot warning. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_SLO_CHECKPOINT_S` | number | 60 | 0..86400 (0 writes only at shutdown) | 60 s. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_SLO_NOTIFY` | toggle | off | 1 | off: no transition notifier. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_SLO_NOTIFY_S` | number | 60 | 5..86400 | 60 s. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_SLO_NOTIFY_SUSTAIN_S` | number | 300 | 0..86400 (0 announces at once) | 300 s. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_SLO_WEBHOOK_URL` | secret-ref | none | http(s) URL | no webhook; the URL may carry a token and is never printed. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_BURN_TOKENS_PER_HOUR` | number | none | tokens per rolling hour | the burn.tokens row is unconfigured and never judged. See `docs/observability.md` | observability/burn.ts | yes |
| `SUBSTRATE_BURN_COST_USD_PER_HOUR` | number | none | USD per rolling hour | the burn.cost_usd row is unconfigured and never judged. See `docs/observability.md` | observability/burn.ts | yes |
| `SUBSTRATE_METRICS_HISTORY` | toggle | off | on \| off | off: no sampler, no table, GET /slo/history answers 404; it also needs a ledger. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_METRICS_HISTORY_INTERVAL_S` | number | 60 | 15..3600 | 60 s. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_METRICS_HISTORY_TTL` | string | 14d | 1d..90d whole days | 14d; applied when the table is created. See `docs/observability.md` | mcp-server/config.ts | yes |
| `SUBSTRATE_METRICS_HISTORY_SERIES` | mode | core | core \| extended (any case, trimmed; anything else is core and is named at boot) | core: the 11 core series, sampler and readback unchanged. See `docs/dashboards.md` | mcp-server/config.ts | yes |

## VPS runtime, doctor and disk guardrails

| Name | Kind | Default | Allowed | Unset means | Read by | In `.env.example` |
| --- | --- | --- | --- | --- | --- | --- |
| `SUBSTRATE_DOCTOR_EMIT` | toggle | off | 1 | doctor --emit only prints a hint. See `docs/runbooks/production-parity.md` | scripts/doctor-runtime.ts | yes |
| `SUBSTRATE_DOCTOR_STATE` | path | /var/lib/substrate/doctor-last.json | file path | the default dedupe record. See `docs/runbooks/production-parity.md` | scripts/doctor-runtime.ts | yes |
| `SUBSTRATE_DOCTOR_SWAP_PAGES_PER_S` | number | 0 | non-negative | 0: any page moving in the one-second sample is drift. See `docs/runbooks/production-parity.md` | scripts/doctor-runtime.ts | yes |
| `SUBSTRATE_EXPOSURE_MAX` | number | none | 0..10 (a number; anything else is one warn row and the rows stay report-only) | report only: the doctor prints each unit's systemd-analyze exposure and never changes its exit code. See `docs/runbooks/vps-hardening.md` | scripts/doctor-sandbox.ts | yes |
| `SUBSTRATE_DEPLOY_PREFLIGHT` | mode | report | off \| report \| enforce | report: deploy-release.sh prints the preflight table on stderr and always continues (SHELL: read by the infra shell file named in `Read by`, not by the server). See `infra/vps/README.md` | infra/vps/deploy-release.sh | no |
| `SUBSTRATE_DEPLOY_GATE` | mode | off | off \| report \| enforce | off: deploy-release.sh does not run the boot-and-prove gate (SHELL: read by the infra shell file named in `Read by`, not by the server). See `docs/runbooks/release-gate.md` | infra/vps/deploy-release.sh | no |
| `SUBSTRATE_WATCHDOG` | toggle | off | 1 (only the literal 1) | off: no READY or WATCHDOG notifications. See `docs/runbooks/disk-pressure.md` | mcp-server/watchdog.ts | yes |
| `SUBSTRATE_WATCHDOG_LAG_MS` | number | 5000 | 100..60000 | 5000 ms | mcp-server/watchdog.ts | yes |
| `SUBSTRATE_WATCHDOG_PROBE_MS` | number | 2000 | 100..60000 | 2000 ms | mcp-server/watchdog.ts | yes |
| `SUBSTRATE_WATCHDOG_NOTIFY_MS` | number | 3000 | 100..60000 | 3000 ms | mcp-server/watchdog.ts | yes |
| `SUBSTRATE_ALERT_WAIT_S` | number | 60 | 0..60 (0 posts at once) | 60 s | scripts/substrate-alert.ts | yes |
| `SUBSTRATE_RETAIN_RELEASE_MAX_GB` | number | 6 | non-negative (0 disables the compare) | 6 GB | scripts/doctor-vps.ts | yes |
| `SUBSTRATE_STATE_MAX_GB` | number | 1 | non-negative (0 disables the compare) | 1 GB | scripts/doctor-vps.ts | yes |
| `SUBSTRATE_JOURNAL_MAX_MB` | number | 400 | non-negative (0 disables the compare) | 400 MB | scripts/doctor-vps.ts | yes |
| `SUBSTRATE_DEPLOY_MIN_FREE_GB` | number | 5 | 0..9999 whole gigabytes (0 disables the gate) | 5 GB. See `docs/runbooks/disk-pressure.md` | mcp-server/index-run.ts, ledger-run.ts, scripts/doctor-runtime.ts, scripts/deploy-preflight.ts, infra/vps/deploy-release.sh (set in the shell that runs the script; the preflight and the gate inherit it) | yes |
| `SUBSTRATE_REPO` | path | the checkout of this script | absolute path | the repo the script lives in. See `docs/runbooks/production-parity.md` | scripts/parity-check.ts | yes |
| `SUBSTRATE_SKILLS_LIBRARY` | path | /root/agent-skills | absolute path to the library checkout | /root/agent-skills. See `docs/skills-plane.md` | scripts/skills-doctor.ts | no |
| `SUBSTRATE_SKILLS_BRIDGE_ENV` | path | /etc/substrate/substrate-bridge.env | absolute path to the bridge env file | /etc/substrate/substrate-bridge.env. See `docs/skills-plane.md` | scripts/skills-doctor.ts | no |

## Substrate host (VM sandboxes)

| Name | Kind | Default | Allowed | Unset means | Read by | In `.env.example` |
| --- | --- | --- | --- | --- | --- | --- |
| `SUBSTRATE_HOST_ROUTE` | string | none | route from the 03-01 spike | the host refuses to start. See `docs/runbooks/lane-a-host.md` | host/main.ts | yes |
| `SUBSTRATE_TESTS_ROUTE` | string | none | route from the 03-01 spike | the host refuses to start. See `docs/runbooks/lane-a-host.md` | host/main.ts | yes |
| `SUBSTRATE_HOST_MODEL` | string | grok-4.6 | model id | grok-4.6. See `docs/runbooks/lane-a-host.md` | host/main.ts | yes |
| `SUBSTRATE_HOST_PORT` | number | 7411 | port | 7411. See `docs/runbooks/lane-a-host.md` | host/main.ts | yes |
| `SUBSTRATE_HOST_API_TOKEN` | secret-ref | none | bearer token for the host task API (value never logged) | the host refuses to start. See `docs/runbooks/lane-a-host.md` | host/main.ts | yes |
| `SUBSTRATE_SANDBOX_NET` | mode | published_loopback | published_loopback \| internal | published_loopback; any other value refuses to start. See `docs/runbooks/lane-a-host.md` | host/main.ts | yes |
| `SUBSTRATE_SANDBOX_HOSTFN` | string | sandbox | collection name | sandbox. See `docs/runbooks/lane-a-host.md` | host/main.ts | yes |
| `SUBSTRATE_SANDBOX_EGRESS` | list | none (deny-all) | comma separated host:port | deny-all; a malformed entry refuses naming it. See `docs/runbooks/lane-a-host.md` | host/sandbox-options.ts | yes |
| `SUBSTRATE_SANDBOX_STATE` | path | <storage root>/sandboxes.json | file path | under RIVETKIT_STORAGE_PATH. See `docs/runbooks/lane-a-host.md` | host/sandbox-provider.ts | yes |
| `SUBSTRATE_MCP_URL` | string | http://127.0.0.1:7410/mcp | URL | the loopback MCP endpoint. See `docs/runbooks/lane-a-host.md` | host/main.ts | yes |
| `SUBSTRATE_ENGINE_ENDPOINT` | string | http://127.0.0.1:6420 | URL | the loopback engine endpoint. See `docs/runbooks/lane-a-host.md` | host/main.ts | yes |
| `RIVET_RUN_ENGINE` | toggle | off (share mode) | 1 is REFUSED until the G2 verdict; leave unset | the host runs in shared-engine mode (UNVERIFIED); the literal 1 makes it refuse to boot until 31-SPIKE.md records the G2 verdict. See `docs/runbooks/lane-a-host.md` | host/main.ts | yes |
| `RIVET_RUN_ENGINE_HOST` | string | 127.0.0.1 | host | 127.0.0.1. See `docs/runbooks/lane-a-host.md` | host/main.ts | yes |
| `SUBSTRATE_APPROVAL_TIMEOUT_S` | number | 900 | positive seconds | 900 s; a malformed value logs and uses the default. See `docs/runbooks/lane-a-host.md` | host/tasks.ts | yes |
| `SUBSTRATE_APPROVAL_BOT_TOKEN` | secret-ref | none | Telegram bot token | no Telegram approvals. See `docs/runbooks/lane-a-host.md` | host/telegram.ts | yes |
| `SUBSTRATE_APPROVAL_CHAT_ID` | string | none | chat id | no Telegram approvals. See `docs/runbooks/lane-a-host.md` | host/telegram.ts | yes |
| `SUBSTRATE_APPROVAL_USER_IDS` | list | none | comma separated user ids | no user may approve. See `docs/runbooks/lane-a-host.md` | host/telegram.ts | yes |
| `SUBSTRATE_CHECKOUT` | path | the repo the host runs from | absolute path | the repo checkout | host/main.ts | yes |
| `SUBSTRATE_SKILLS_DIR` | path | the ultrathink plugin skills directory | directory | the built-in directory | host/main.ts | yes |
| `SUBSTRATE_LIBRARY_DIR` | path | /root/agent-skills | git checkout | /root/agent-skills | host/main.ts | yes |
| `SUBSTRATE_SKILL_MOUNTS` | mode | nested | mount route from the 04-01 spike | nested | host/main.ts | yes |
| `SUBSTRATE_ULTRATHINK_CONFIG` | path | /root/.config/ultrathink/config.json | file path | the default config | host/main.ts | yes |
| `SUBSTRATE_ULTRATHINK_MCP` | path | the ultrathink plugin binary | binary | the built-in path | host/mcp-proxy.ts | yes |
| `SUBSTRATE_VM_ANTHROPIC_API_KEY` | secret-ref | none | API key | read only when the route is anthropic_key | host/main.ts | yes |
| `RIVETKIT_STORAGE_PATH` | path | /var/lib/substrate/agentos | directory | /var/lib/substrate/agentos | host/main.ts, audit.ts | yes |

## CLI, collectors and projectors

| Name | Kind | Default | Allowed | Unset means | Read by | In `.env.example` |
| --- | --- | --- | --- | --- | --- | --- |
| `SUBSTRATE_TIMEOUT_MS` | number | 1500 | positive ms | 1500 ms (the CLI's lessons calls) | cli/index.ts | yes |
| `SUBSTRATE_SKILLS_TIMEOUT_MS` | number | 180000 | positive ms | 180000 ms (the CLI's skills calls) | cli/skills.ts | yes |
| `SUBSTRATE_CLI` | path | the CLI entry in the checkout | path | the built-in path | projector/cursor.ts | yes |
| `SUBSTRATE_CURSOR_ROOT` | path | /root/.cursor | directory | /root/.cursor. See `docs/collectors.md` | collectors/cursor-stop.ts | yes |
| `SUBSTRATE_CURSOR_STOP` | path | the stop hook in the checkout | path | the built-in path | projector/cursor.ts | yes |
| `SUBSTRATE_TRANSCRIPTS_DIR` | path | /var/lib/substrate/transcripts/cursor | directory | the default directory. See `docs/collectors.md` | collectors/cursor-stop.ts | yes |
| `SUBSTRATE_COLLECTOR_STATE` | path | /var/lib/substrate/herdr-offsets.json (herdr) or the muse state file | file path | each collector's own default. See `docs/collectors.md` | collectors/herdr-state.ts, muse.ts | yes |
| `SUBSTRATE_STATE_DIR` | path | /var/lib/substrate | directory | /var/lib/substrate. See `docs/collectors.md` | collectors/emit.ts, muse.ts, projector/muse.ts | yes |
| `SUBSTRATE_EVENT_SPOOL` | toggle | off | off \| on | off: a failed event is dropped and counted as before and no spool file is touched. See `docs/collectors.md` | collectors/spool.ts, collectors/emit.ts | yes |
| `SUBSTRATE_EVENT_SPOOL_MAX` | number | 5000 | 1..100000 (not a positive integer: the default; above the ceiling: clamped to it; each with one stderr warning) | 5000 parked lines; over it the oldest is dropped with a visible line. See `docs/collectors.md` | collectors/spool.ts | yes |
| `SUBSTRATE_EVENT_SPOOL_MAX_BYTES` | number | 8388608 | 1024..64 MiB (not a positive integer: the default; below 1024: raised to 1024; above the ceiling: clamped; each with one stderr warning) | 8 MiB spool file. See `docs/collectors.md` | collectors/spool.ts | yes |
| `SUBSTRATE_EVENT_SPOOL_TTL_H` | number | 48 | 1..720 whole hours (not a positive integer: the default; above the ceiling: clamped; each with one stderr warning) | 48 h before an unsent event is dropped with a visible line. See `docs/collectors.md` | collectors/spool.ts | yes |
| `SUBSTRATE_EVENT_SPOOL_MAX_ATTEMPTS` | number | 12 | 1..100 (not a positive integer: the default; above the ceiling: clamped; each with one stderr warning) | 12 delivery attempts per event, the live one included. See `docs/collectors.md` | collectors/spool.ts | yes |
| `SUBSTRATE_REFUSED_EMITS_MAX_BYTES` | number | 1048576 | 4096..64 MiB (not a positive integer: the default; below 4096: raised to 4096; above the ceiling: clamped; each with one stderr warning) | refused-emits.jsonl rotates to a single .1 file at 1 MiB. See `docs/collectors.md` | collectors/emit.ts | yes |
| `SUBSTRATE_MUSE_REPOS` | list | none | colon separated absolute roots | the muse collector refuses: there is no inferred default. See `docs/collectors.md` | collectors/muse.ts | yes |
| `SUBSTRATE_MUSE_TOKEN_FILE` | path | /etc/substrate/substrate-collector-muse.env | file path | the default token file | projector/muse.ts | yes |
| `MUSE_BIN` | path | /root/.local/bin/muse | binary | the default install path | projector/muse.ts | yes |
| `MUSE_PLUGIN_DIR` | path | /var/lib/substrate/muse-plugin | directory | the default bundle directory | projector/muse.ts | yes |
| `SUBSTRATE_BUN_BIN` | path | the reflex bun install | binary | the built-in path | projector/muse.ts | yes |
| `SUBSTRATE_OMP_PENDING_DIR` | path | /root/.omp/agent/substrate-pending | directory | the default directory | projector/omp/substrate-skills.ts | yes |
| `GROK_SESSIONS_DIR` | path | $HOME/.grok/sessions | directory | the default under HOME. See `docs/collectors.md` | collectors/grok.ts | yes |
| `HERDR_SOCKET_PATH` | path | none | socket path | falls through to HERDR_SESSION, then the default socket. See `docs/collectors.md` | collectors/herdr.ts | yes |
| `HERDR_SESSION` | string | none | session name | the default socket under HOME. See `docs/collectors.md` | collectors/herdr.ts | yes |

## Smoke, rehearsal and test harness

| Name | Kind | Default | Allowed | Unset means | Read by | In `.env.example` |
| --- | --- | --- | --- | --- | --- | --- |
| `SUBSTRATE_TEST_PG_URL` | secret-ref | none | scratch postgres URL | the live index tests are skipped. See `docs/ci.md` | scripts/verify.ts, mirror-smoke.ts | yes |
| `SUBSTRATE_SMOKE_REPO` | string | swcstudiospace/agent-substrate | owner/repo | the default repo. See `docs/grok-bot.md` | scripts/grok-connector-smoke.ts | yes |
| `SUBSTRATE_REHEARSAL_OPERATOR_TOKEN` | secret-ref | none | harness-minted token | the dependent smoke falls back to SUBSTRATE_TOKEN. See `docs/rehearsal.md` | scripts/rehearsal.ts, skills-propose-smoke.ts | no |
| `SUBSTRATE_REHEARSAL_PG_IMAGE` | string | postgres:16 | image reference | postgres:16. See `docs/rehearsal.md` | scripts/rehearsal.ts | no |
| `SUBSTRATE_REHEARSAL_SKILLS_GH_STATE` | path | none | harness-owned | the skills smokes refuse to run. See `docs/rehearsal.md` | scripts/skills-sync-smoke.ts, skills-propose-smoke.ts | no |
| `SUBSTRATE_REHEARSAL_SKILLS_ORIGIN` | path | none | harness-owned | the skills smokes refuse to run. See `docs/rehearsal.md` | scripts/skills-sync-smoke.ts, skills-propose-smoke.ts | no |
| `SUBSTRATE_REHEARSAL_SKILLS_REPO` | path | none | harness-owned | the skills smokes refuse to run. See `docs/rehearsal.md` | scripts/skills-sync-smoke.ts, skills-propose-smoke.ts | no |
| `SUBSTRATE_REHEARSAL_SKILLS_STATE` | path | none | harness-owned | the skills smokes refuse to run. See `docs/rehearsal.md` | scripts/skills-sync-smoke.ts, skills-propose-smoke.ts | no |
| `SUBSTRATE_REHEARSAL_TOKENS_DIR` | path | none | harness-owned | the smokes refuse to run. See `docs/rehearsal.md` | scripts/desktop-smoke.ts, skills-sync-smoke.ts | no |
| `SUBSTRATE_REHEARSAL_NAME` | string | none | run name the rehearsal wrote to consumer.env | empty: the run-name comparison is skipped. See `docs/rehearsal.md` | scripts/docs-smoke.ts | no |
| `SUBSTRATE_REHEARSAL_DOCS_STATE_FILE` | path | none | file inside the rehearsal run directory | empty: the docs state is read as absent. See `docs/rehearsal.md` | scripts/docs-smoke.ts | no |
| `SUBSTRATE_RAGFLOW_FIXTURE_URL` | string | none | loopback http URL of the RAGFlow stand-in | empty: the docs smoke refuses the fixture target. See `docs/rehearsal.md` | packages/mcp-server/src/rehearsal-ragflow.ts, scripts/docs-smoke.ts | no |
| `SUBSTRATE_RAGFLOW_FIXTURE_READY` | string | none | 1 once the stand-in answers its health probe | empty: the fixture is not marked ready. See `docs/rehearsal.md` | packages/mcp-server/src/rehearsal-ragflow.ts, scripts/docs-smoke.ts | no |
| `SUBSTRATE_RAGFLOW_FIXTURE_PID` | number | none | process id of the RAGFlow stand-in | empty: the fixture pid check refuses. See `docs/rehearsal.md` | packages/mcp-server/src/rehearsal-ragflow.ts, scripts/docs-smoke.ts | no |
| `RAGFLOW_FIXTURE_KEY` | secret-ref | none | per-run scratch key, at least 32 characters | the stand-in refuses to start (exit 2). See `docs/rehearsal.md` | packages/mcp-server/src/rehearsal-ragflow-server.ts | no |
| `RAGFLOW_FIXTURE_PORT` | number | none | TCP port 1-65535 | the stand-in refuses to start (exit 2). See `docs/rehearsal.md` | packages/mcp-server/src/rehearsal-ragflow-server.ts | no |
| `SUBSTRATE_GATE_INDEX_DRILL` | toggle | off | 1 | off: gate:boot does not archive or restore the scratch index. See `docs/runbooks/release-gate.md` | scripts/rehearsal.ts | no |
| `SUBSTRATE_GATE_CHAOS_PLANES` | toggle | off | 1 | off: the rehearsal does not pause the scratch index or probe the other planes. See `docs/runbooks/release-gate.md` | scripts/chaos-planes.ts | no |
| `CHAOS_REHEARSAL` | toggle | off | 1 \| true \| yes (case-insensitive) | the chaos smoke asserts a degraded deployment. See `docs/observability.md` | scripts/chaos-smoke.ts | yes |
| `CHAOS_TICK_MS` | number | 2000 | ms | 2000 ms. See `docs/observability.md` | scripts/chaos-smoke.ts | yes |
| `CHAOS_TIMEOUT_MS` | number | 10000 | ms | 10000 ms. See `docs/observability.md` | scripts/chaos-smoke.ts | yes |
| `CHAOS_WINDOW_MS` | number | 60000 | ms | 60000 ms. See `docs/observability.md` | scripts/chaos-smoke.ts | yes |
| `CLAUDE_CONFIG_PATH` | path | $HOME/.claude.json | file path | the default under HOME. See `docs/uat.md` | scripts/uat-phase0.ts | yes |
| `SUBSTRATE_REHEARSAL_<NAME>` | string | none | harness-owned | the rehearsal harness refuses to start the dependent smoke. See `docs/rehearsal.md` | scripts/rehearsal.ts | no |

## Promotion policies

The policy flags: the value that preserves today's behaviour or only reports (**safe**), the value that makes the policy bite (**enforcing**), the operator's step and the rollback. Code never performs a flip. A flag with evidence is judged by `bun run advisor:promote` against the PROPOSED thresholds in `docs/runbooks/flag-promotion.md`; a flag without evidence has a manual check instead. Extended-series criteria are judged only when the extended gauge covers the window AND the policy's own series has been recording for at least 90 % of it (a policy records nothing while its flag is off; a series with no points cannot tell not-observed from zero), as `docs/runbooks/flag-promotion.md` states exactly. A flag with BOTH has a manual check that still applies when the advisor says `ready`: the advisor prints it as `also check:` and carries it in its JSON.

| Flag | Safe | Enforcing | Step | Rollback | Evidence |
| --- | --- | --- | --- | --- | --- |
| `SUBSTRATE_SKILLS_GOVERNANCE` | `off` | `enforce` | set report in BOTH the server env and the skills-sync unit env, soak, approve every skill already on the library's main with skills_approve, wait for the skills.sync unapproved warning to stop, then set enforce on the skills-sync unit only | set off in both places; the registry table is additive and nothing is unlinked or deleted by code | manual: the periodic skills.sync warning (reason unapproved) names no skill, and skills_list (operator, state=all) shows every skill on main as approved |
| `SUBSTRATE_LEDGER_TTL` | `unset` | `180d` | export the window first (substrate ledger archive), then set SUBSTRATE_LEDGER_TTL=180d in the unit env and restart | unset it and restart; an ALTER already applied stays until an operator changes the table | manual: substrate ledger coverage exits 0 and /healthz.jobs.ledger reports no uncovered hours (SUBSTRATE_LEDGER_MAX_UNCOVERED_HOURS); every expiring day has a verified archive manifest |
| `SUBSTRATE_EVENT_IDEMPOTENCY` | `off` | `accept` | set SUBSTRATE_EVENT_IDEMPOTENCY=accept in the unit env and restart; confirm /healthz reports idempotency accept, and only then enable a client spool; enforce only after an EXPLAIN of the lookup against the production ledger | set off and restart; stored _ik payload keys are ordinary payload data | manual: /healthz reports idempotency accept; substrate.events.replay{result=deduplicated} counts replays that found their row and {result=lookup_failed} stays at 0 |
| `SUBSTRATE_MEMORY_EXPIRY` | `report` | `enforce` | set SUBSTRATE_MEMORY_EXPIRY=enforce in BOTH the server env and the sweep job env, restart substrate-mcp; the sweep still deletes nothing without SUBSTRATE_INDEX_SWEEP=apply and --apply | set SUBSTRATE_MEMORY_EXPIRY=report and restart; hidden entries come back (nothing is deleted by this flag) | expired entries still served (extended); ALSO manual (applies even when the advisor says ready): substrate index sweep (dry-run) lists no kind=decision entries in entries-ttl-* classes |
| `SUBSTRATE_HASH_VERSION` | `v1` | `v2` | set SUBSTRATE_HASH_VERSION=v2 and restart; new memory writes store the v2 digest and still match a row written under v1 | set v1 and restart; stored v2 digests stay valid and are still matched | manual: a new write under v2 stores a digest that differs from the v1 preimage, and a quarantine or review parked under v1 is reused rather than inserted again |
| `SUBSTRATE_INDEX_SWEEP` | `dry-run` | `apply` | after reading the dry-run report, set SUBSTRATE_INDEX_SWEEP=apply on the sweep unit's drop-in (not the server env); deletion also needs substrate index sweep --apply | set dry-run; rows already deleted are not restored (export first with substrate index archive) | manual: substrate index sweep prints candidate counts per class; deletion is irreversible, so there is no history evidence for it |
| `SUBSTRATE_INDEX_TUNE` | `off` | `apply` | set SUBSTRATE_INDEX_TUNE=apply in the unit env and restart; migrate applies the graph_nodes tune once and idempotently | unset it; the applied storage parameters stay until an operator resets them | manual: /healthz.capacity.index.graphNodes shows the HOT-update and dead-row ratios the tune is meant to move |
| `SUBSTRATE_CACHE_SWR` | `shadow` | `enforce` | set SUBSTRATE_CACHE_SWR=enforce in the unit env and restart substrate-mcp | set SUBSTRATE_CACHE_SWR=off and restart | would-serve-stale share of misses (lower bound) (extended); brief p95 (grok-bot, worst interval) (core) |
| `SUBSTRATE_CACHE_BUMP_SCOPE` | `legacy` | `narrow` | set SUBSTRATE_CACHE_BUMP_SCOPE=narrow in the unit env and restart; watch substrate.cache.operations{class=brief,result=miss} per accepted write | set legacy and restart; cached entries need no flush | manual: brief misses per accepted write fall (one flush instead of two) and a graph-scoped brief still changes on claim, release and complete; staleness bounds are in docs/data-planes.md |
| `SUBSTRATE_BRIEF_GRAPH_READ` | `full` | `lite` | set SUBSTRATE_BRIEF_GRAPH_READ=lite in the unit env and restart; compare the graph.brief and graph.get plane durations and graph-scoped brief p95 | set full and restart | manual: substrate.plane.duration{plane=index,op=graph.brief} stays below the full read's graph.get; the brief text is test-pinned identical |
| `SUBSTRATE_BRIEF_PROFILE` | `shadow` | `enforce` | set SUBSTRATE_BRIEF_PROFILE=enforce in the unit env and restart substrate-mcp; callers may still pass profile=full | set SUBSTRATE_BRIEF_PROFILE=shadow (or off) and restart; cached entries need no flush | bytes saved per brief (extended) |
| `SUBSTRATE_BRIEF_RECALL` | `off` | `enforce` | off to shadow: set SUBSTRATE_BRIEF_RECALL=shadow and restart, soak at least three days; then, if the advisor says ready, set SUBSTRATE_BRIEF_RECALL=enforce and restart (needs the cache) | set SUBSTRATE_BRIEF_RECALL=off and restart | would-include share of briefs (extended); cold plus stale share of briefs (extended); prefetch error share (extended); ALSO manual (applies even when the advisor says ready): brief.p95 must not move while the mode is shadow (compare against the pre-flag week) |
| `SUBSTRATE_HINDSIGHT_INVENTORY` | `off` | `on` | set SUBSTRATE_HINDSIGHT_INVENTORY=on in the unit env and restart; the inventory is read-only against Hindsight | set SUBSTRATE_HINDSIGHT_INVENTORY=off and restart | manual: substrate.hindsight.bank.* gauges (facts, pending_operations, failed_operations, last_write_age_seconds) appear in /metrics under gauges only, never in the history, and /healthz.hindsight carries the drift report |
| `SUBSTRATE_DOCS_PRUNE_SUPERSEDED` | `unset` | `1` | set SUBSTRATE_DOCS_PRUNE_SUPERSEDED=1 in the unit env and restart; a failed delete is logged and recorded, never a refusal | unset it and restart; documents already deleted from RAGFlow are not restored (re-ingest) | manual: the docs_ingest result records pruned and failed per call, and /slo.docs freshness stays within SUBSTRATE_DOCS_FRESHNESS_MAX_AGE_H |
| `SUBSTRATE_BUDGETS` | `shadow` | `enforce` | set SUBSTRATE_BUDGETS=enforce in the unit env and restart substrate-mcp | set SUBSTRATE_BUDGETS=shadow and restart | shadow-limited share of decisions (core); ALSO manual (applies even when the advisor says ready): per surface and class shadow-limited counts from /metrics (substrate.admission.decisions); none for coordination |
| `SUBSTRATE_SLO_NOTIFY` | `unset` | `1` | set SUBSTRATE_SLO_NOTIFY=1 in the unit env and restart; it emits one warning or note per sustained SLO transition | unset it and restart | manual: transition events on the ledger (surface substrate, payload.runtime=slo) are the output; read /slo for the verdicts they announce |
| `SUBSTRATE_METRICS_HISTORY` | `off` | `on` | decide the Greptime volume first (500 MB is recorded in one place and 5 GB in the plan), then set SUBSTRATE_METRICS_HISTORY=on in the unit env and restart; it is the enabler for every history-based criterion | set SUBSTRATE_METRICS_HISTORY=off and restart; the table stays and its rows expire on the TTL | manual: none: this flag is what makes the advisor's evidence exist; before it is on every criterion reads series-unavailable |
| `SUBSTRATE_WATCHDOG` | `unset` | `1` | install infra/vps/substrate-mcp.service.d/20-watchdog.conf.example as the drop-in (it sets Type=notify and SUBSTRATE_WATCHDOG=1 together), then restart; Type=notify with the flag off blocks startup | remove the drop-in and restart | manual: bun run doctor:runtime rows for the unit and GET /livez answering |
| `SUBSTRATE_EVENT_SPOOL` | `off` | `on` | first confirm the server reports idempotency accept (or enforce) on /healthz, then set SUBSTRATE_EVENT_SPOOL=on in one collector's env file and restart it; the client refuses to replay against a server that does not | set off; the spool file is inert and is never read while off | manual: substrate spool status shows depth returning to 0 after an outage, and dropped lines in refused-emits.jsonl stay at 0 |

## Names composed at run time

The scan sees only the prefix of a name the code builds, so each family is registered by pattern and by the members it can read.

| Pattern | Prefix | Members |
| --- | --- | --- |
| `SUBSTRATE_TOKEN_<SURFACE>` | `SUBSTRATE_TOKEN_` | 27 |
| `SUBSTRATE_BUDGET_<CLASS>_RPS \| _BURST` | `SUBSTRATE_BUDGET_` | 168 |
| `SUBSTRATE_REHEARSAL_<NAME>` | `SUBSTRATE_REHEARSAL_` | 1 |

## Names that are not configuration

Read or touched by the code but not Agent Substrate settings; `flag-registry.test.ts` accepts a read of these without a row.

| Name | Why exempt |
| --- | --- |
| `HOME` | platform variable; the code only reads it to build default paths |
| `PATH` | platform variable passed through to child processes |
| `PYTHONPATH` | platform variable the Lane A harness extends for the dispatcher child |
| `XDG_RUNTIME_DIR` | platform variable naming the per-user runtime directory |
| `NOTIFY_SOCKET` | set by systemd for a Type=notify unit; read by the watchdog, never configured |
| `WATCHDOG_USEC` | set by systemd from WatchdogSec; never configured |
| `WATCHDOG_PID` | set by systemd; never configured |
| `SERVICE_RESULT` | set by systemd on OnFailure units; read by substrate-alert, never configured |
| `MONITOR_SERVICE_RESULT` | set by systemd for the monitor unit; never configured |
| `DOCKER_HOST` | the docker client's own variable; the rehearsal harness refuses a remote value rather than configuring it |
| `DOCKER_CONTEXT` | the docker client's own variable; refused when it is not the local context |
| `DOCKER_CONFIG` | the docker client's own variable, passed through to the scratch stack |
| `GIT_OPTIONAL_LOCKS` | written into a child git environment, never read |
| `HERDR_` | prefix scrubbed from the child environment by the Lane B proof; the harness deletes these, it reads none |
| `SUBSTRATE_DASHBOARD_URL` | Grafana-side variable the dashboards generator names in its provisioning example; Grafana reads it, no substrate process does |
| `SUBSTRATE_DASHBOARD_BEARER` | Grafana-side variable the dashboards generator names in its provisioning example; Grafana reads it, no substrate process does |
