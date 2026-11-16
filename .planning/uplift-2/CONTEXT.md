# Uplift 2 — recon context (data planes, VPS, Grok Bot)

**Date:** 2026-10-13 · **Graph:** `ut-mv66gjpd-4d730336` · **Nodes:** n2 [SPE-10662](https://linear.app/swcstudio/issue/SPE-10662) (recon), n3 [SPE-10661](https://linear.app/swcstudio/issue/SPE-10661) (Build Plan index), n7 [SPE-10663](https://linear.app/swcstudio/issue/SPE-10663) (ambiguities)
**Mode:** read-only discovery; every claim below names the file and line it came from. Nothing in this file is a value from `/etc/substrate/substrate.env` — key names only. Hostnames are the placeholders `docs/data-planes.md` uses.

## GSD state

`.planning/ROADMAP.md` v1.3: 18/18 phases complete, archived at `ab0dff1`; STATE.md `Awaiting next milestone`. `gsd-autonomous` phase discovery therefore yields zero incomplete phases. As on 2026-10-12 (`UPLIFT_PROPOSAL.md`, PR #58) this run is a **standalone post-close series** under `.planning/uplift-2/` with STATE.md progress rows — no new ROADMAP milestone. Previous uplift (U1–U7, merged 2026-10-13 as `490e007`) is prior art and is not repeated here.

## Per-service record

| Field | GreptimeDB (ledger) | TimescaleDB (index) | Dragonfly / loopback redis (cache) | Hindsight (memory) | RAGFlow (docs) |
|---|---|---|---|---|---|
| Railway | project **Ultrathink**, `greptime/greptimedb:v1.1.4`, volume **500 MB** `/greptimedb_data` | project **Ultrathink**, `timescale-postgis-ssl:pg16-ts2.13`, volume **500 MB**; `timescaledb@2.13.1` loaded, **0 hypertables** | project **Ultrathink**, `dragonflydb/dragonfly:latest`, 5 GB volume — **unused by production** (see reach) | project **Agent Substrate**, `hindsight-api:0.9.1` + worker + control-plane + llm-bridge + private Postgres 18 | project **Agent Substrate**, `ragflow` (orenaksakal template) + elasticsearch + mysql + minio + redis |
| Reach from VPS | public HTTPS edge (`GREPTIME_URL`); forwarder cutover not done (`docs/railway-tailscale.md` §Cutover) | public **TCP proxy** (`SUBSTRATE_PG_URL`, non-standard port) | `DRAGONFLY_URL` → **127.0.0.1 redis 7.0.15** (data-planes.md L74: 180–310 ms tailnet RTT made the Railway hop unusable) | public HTTPS edge (`HINDSIGHT_URL`) | public HTTPS edge (`RAGFLOW_URL`) |
| Client | `packages/mcp-server/src/greptime.ts` (HTTP `/v1/sql`, form-encoded, Basic auth, `DEFAULT_TIMEOUT_MS=5000` L17) | `packages/mcp-server/src/index-store.ts` `new SQL(url)` L106-108 — **no pool/timeout options**, no `statement_timeout`, no `application_name` | `packages/mcp-server/src/cache.ts` Bun `RedisClient`, `connectionTimeout 800`, `COMMAND_TIMEOUT_MS 800` L93-98, `autoReconnect:false`, no backoff | `packages/mcp-server/src/planes/hindsight.ts` (`/v1/default/banks/{bank}` retain/recall, 4 s / 8 s hard-coded) | `packages/mcp-server/src/planes/ragflow.ts` (`/api/v1/retrieval`, `/datasets`, upload, parse-poll; 4 s / 8 s; no retries) |
| Env keys | `GREPTIME_URL/_USER/_PASSWORD/_DB`, `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER`, `SUBSTRATE_CLAIM_REQUIRE_LEDGER` | `SUBSTRATE_PG_URL` | `DRAGONFLY_URL`, `SUBSTRATE_CACHE` | `HINDSIGHT_URL/_API_KEY/_BANK_PREFIX/_BANKS` (prod has legacy `HINDSIGHT_BANK`, unread; `HINDSIGHT_BANKS` unset) | `RAGFLOW_URL/_API_KEY/_DATASET_ID`, `SUBSTRATE_DOCS_INGEST_ROOTS`, `SUBSTRATE_DOCS_STATE_FILE` (unset in unit) |
| Schema / keys | `agent_events` (append_mode, PK surface/graph_id/repo/kind), `event_ingest`, `anchors`; **no TTL**; stray `agent_events_pre_append_20260930` table still present | `graph_index/nodes/edges/steps/bindings`, `memory_entries/_writes/_quarantine/_reviews`, `skills`; GIN FTS; **no retention, no deletes anywhere** (index-store.ts migrate L111-297) | `substrate:v1:<class>:<sha256(surface,generation,args)>`; classes brief 300 s / memory-search 600 s / graph-view 60 s; gens `gen:memory`, `gen:graphs`, `gen:graph:<id>` | banks `sub-<surface>`; retain forwarded **async, one item/call, no retry** (`memory-retain.ts` L90-194) | datasets per repo (`docs-datasets.ts` L21-29); version store **in-memory** (`server.ts:500`) |
| Call sites | emit (service.ts L910-953: lastHash scan + 2 inserts per event), brief recent-actions (brief.ts L173-180, no time bound), events_query, SSE poll (server.ts L1269-1370) | brief (3 sequential reads), leases, memory gate, governance queue | brief, memory_search, recall, graph_get (service.ts L842-871, L1195-1240, L1297-1307, L1363-1372); heartbeat bumps the **shared** graphs generation (L1829→L1381) | writeMemory forward (L1090-1131), searchMemory merge (L1195-1220, waits for recall), recall (L1290-1310) | searchDocs (L2354-2374; pins never passed), docs_ingest, `POST /docs/merge-trigger` (uplift U6) |
| Failure handling | reads 503/empty; emit `stored:false`; `/healthz` writability is metadata-derived (service.ts L3391) | unbounded waits; `/healthz` `select 1` unbounded | discard client on error, reconnect next call (≤800 ms) | one `memory.retain.failed` warning, memory never reaches Hindsight; recall degraded not cached | `{chunks:[],degraded}`; dataset list fetched per call |
| Breaker / metrics | none / `substrate.emit.total{outcome}` only | none / none | none / `substrate.cache.operations` | none / none | none / none |

Brief composition (`packages/mcp-server/src/brief.ts` `composeBrief` L123-246): four source reads **strictly sequential** (index graph → Greptime recent actions → index open graphs → index memory), each fail-open, **no whole-request deadline**, no ETag, a degraded brief is a plain 200 indistinguishable on the wire (server.ts L657-670). The 1.5 s budget is enforced only client-side (`packages/cli/src/index.ts` L43; `fetchBrief` in collectors).

Observability (`packages/observability/src`): SLO catalogue `brief.p95 ≤ 800 ms`, `emit.success ≥ 99.5 %`, `lease.steal_rate`, `quarantine.rate` (slo.ts L74-141) + burn SLOs (U4). Counters are process-lifetime; **no per-plane latency/error series**; `/healthz` omits Hindsight, RAGFlow and cache from its status decision. `scripts/chaos-smoke.ts` (`bun run smoke:chaos`) covers Greptime only.

## VPS record

Ubuntu 24.04, 8 vCPU, 31 GiB RAM (**swap 12/15 GiB used**), disk **387 GB at 95 % (22 GB free)**. `substrate-mcp.service` (`infra/vps/substrate-mcp.service`): root, `Restart=always`, `StateDirectory=substrate`, hardening set, **no `MemoryMax`/`CPUQuota`/`TasksMax`** on any substrate unit. Live: mcp 53 MB RSS, 0 restarts since 2026-10-10. `substrate-anchor.timer` not installed; `substrate-host` inactive. `deploy-release.sh` health gate polls `/healthz` status only (L344-368). Local redis: `maxmemory 0`, `noeviction`, RDB `save 3600 1 300 100 60 10000`, `appendonly no`, 1 MB used. `/var/lib/substrate` 350 MB (318 MB rivetkit); `mcp-audit.jsonl` 3.4 MB, ≈0.9 MB/day, **no rotation** (`docs/mcp-audit.md` L54-60). Disk pressure is mostly co-tenants (`/root/src` 126 GB, containerd 46 GB, docker 29 GB with ~25 GB reclaimable) — operator territory, recorded in BASELINES.md, not in scope to prune from this repo.

## Grok Bot record

`docs/grok-bot.md`: Grok Bot is a Programming Desk seat; it reaches the desk gateway over HTTPS; the gateway calls `substrate-mcp` over loopback as surface **`grok-bot`** (`SUBSTRATE_TOKEN_GROK_BOT`), and calls Hindsight/RAGFlow directly with its own keys. In this repo the Grok Bot path is therefore the server side of `POST /brief`, `POST /events`, `memory_write/search/recall`, `docs_search` for the `grok-bot` surface. Last 7 days: grok-bot is the second-largest emitter (1,296 events; cursor 1,314; omp 522). `packages/collectors/src/grok.ts` is the **Grok Build** session tail — a different surface (`grok-build`), not the bot. Known drift: `docs/grok-bot.md` L23, L45-47, L53 still say substrate-mcp has no Hindsight/RAGFlow adapter — false since Phases 25/26 (`docs/data-planes.md` L39, L68-76 is current).

## Build Plan citable index (Notion)

Parent: [Agent Substrate — Build Plan](https://app.notion.com/p/3e4bc1a0c7ae81baafffd1ebd773123d) (Draft v0.2, read 2026-10-13). Addendum: [v0.3 SOTA Addendum](https://app.notion.com/p/3ebbc1a0c7ae81b88166e6d28a671e48) (locked 30 Sep 2026). Repo-side policy that supersedes the plan's Data section: `docs/data-planes.md` (revised 2026-09-30).

| Id | Where | Statement used by a proposal |
|---|---|---|
| BP-1 | v0.2 §1 Host | "387 GB disk at 90 percent used (40 GB free)" — the VPS disk constraint |
| BP-2 | v0.2 §2 | `substrate-mcp` on loopback; "Postgres (index) … Railway … the VPS disk is at 90 percent"; GreptimeDB on Railway |
| BP-3.2 | v0.2 §3.2 | "The index (Postgres) … a cache over Notion and Linear … never the source of truth" |
| BP-5.0 | v0.2 §5.0 SYSTEMS-S1 | TimescaleDB system of record for memory; GreptimeDB append-only event log; RAGFlow document corpus; Hindsight "cross-session recall feeding `memory.brief`"; Dragonfly "hot cache only … brief snapshots, graph index cache … never source of truth"; Grok Bots call substrate tools only (no-silo rule) |
| BP-5.1 | v0.2 §5.1 | `docs.search` / `docs.ingest` proxy RAGFlow; `memory.brief` served as `POST /brief` for hooks |
| BP-5.4 | v0.2 §5.4 | the brief and its 1.5 s fail-open `fetchBrief`; `.substrate/BRIEF.md` fallback on every surface |
| BP-7 | v0.2 §7 Ledger | every event to GreptimeDB as a hash chain; hourly Merkle root |
| A-1 | v0.3 §1 | memory governance: "Exactly-once writes: idempotency key + `verified_persisted` ack"; fail-closed on memory other agents act on |
| A-3 | v0.3 §3 | "SLOs: brief p95 < 800ms · emit success ≥ 99.5% · lease-steal rate · quarantine rate"; OTLP latency/errors per surface; hash-chained MCP audit |
| A-4 | v0.3 §4 Grok Bot production loop | "Session open: Required `memory_brief` • etag; repo work needs substrate up or explicit `degraded`"; "Docs: only substrate `docs.search`" |
| A-5 | v0.3 §5 Reliability / security | "Circuit breakers + degraded mode (Dragonfly brief snapshot; write outbox)"; "Chaos smoke in CI: Greptime down 60s → emit fail-open, claim fail-closed"; "Runbooks: substrate red · lease stuck · quarantine spike"; `tenant=swc` |
| A-7 | v0.3 §7 Phase A tickets | #3 "OTLP exporters + SLO dashboards + MCP audit chain"; #5 "Connector smoke: `memory_brief(surface=grok-bot)` against live substrate" |
| DP-ret | `docs/data-planes.md` L24-28 | Events "180 days hot, then export"; Index "Open Graph IDs + 90 days"; Cache TTLs brief 300 s / search 600 s / graph 60 s; Documents "last five versions kept", "Re-ingest on merge" |
| DP-cache | `docs/data-planes.md` L26, L78 | "Rate counters and an idempotency mirror stay a target"; cache covers brief, memory_search, memory_recall, graph_get — "does not cover writes, `events_*` or leases" |
| DP-fail | `docs/data-planes.md` L94-96 | "A substrate outage never blocks a prompt … every Dragonfly, Hindsight or RAGFlow error falls through … with a logged reason" |

Not in the plan (recorded as departures to keep): the private-forwarder cutover (D-T6) remains the operator's networking task; production `DRAGONFLY_URL` is loopback redis, and the Railway Dragonfly has no keep/decommission decision on record.

## Ambiguities resolved from evidence (n7)

| Q | Resolution | Evidence |
|---|---|---|
| q1 "our Grok Bot" | the desk-gateway seat calling as surface `grok-bot`; this repo owns its server side (brief, events, memory, docs). Bot-side code lives in `swcstudiospace/programming-desk`. | `docs/grok-bot.md` L3-11; `packages/mcp-server/src/types.ts` SURFACES; collectors `grok.ts` is `grok-build` |
| q2 live Railway/VPS changes | **repo changes only**; every runtime setting ships as code + `.env.example` + runbook the operator applies. Read-only probes only. | STATE.md L32 ("every live run … waits for operator approval"); PROJECT.md Key Decisions ("Production parity is the operator's action; agents only read") |
| q3 data-reducing policies | **in scope as code, execution deferred**: retention/TTL/prune ship behind opt-in flags that default to off or dry-run; no production row is deleted by this run. Retention policy already exists in `docs/data-planes.md` L24-28. | same rules as q2; DP-ret |
| q4 spend ceiling (non-blocking) | cost-neutral or lower: every item reduces Railway round-trips, rows or disk; nothing adds a service, replica or plan tier. | assumption, stated |
| merge path | PR into `main`, CI `verify` + Greptile 5/5 with no open threads, squash auto-merge via `ultrathink-ship` (`ship.autoMerge=true`); no branch protection on the plan (API 403). PR #58 followed exactly this path. | `gh pr view 58`; `~/.config/ultrathink/config.json`; STATE.md L30 |

## Conventions that bound the work

`bun test` (1 recorded fail = F-01, environment-sensitive, recorded not fixed), `bunx tsc --noEmit`, `bun run check:phase-close` (EVENT_KINDS 12 / SURFACES 27 closed, store lock, redact lock, audit policy lock), `bun run test:py` (dispatcher); `bun run verify` chains the first four. Store lock: SQL only in `greptime.ts`/`brief.ts`; memory tables only via `index-store.ts`/`memory-write.ts`. New events reuse `note`/`warning`; new REST/MCP writes need a `packages/audit/src/policy.ts` entry. Dragonfly stays cache-only (never a queue or lock), so any outbox lives on local disk under `StateDirectory`. No credential or hostname literal in the repo.
