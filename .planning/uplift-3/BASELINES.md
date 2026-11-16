# Uplift 3 — baselines (captured 2026-10-13T21:35–21:50Z, read-only)

Live release: `9231f43` (tag `release-20261013-9231f43`, uplift-2 + its deploy follow-up), `substrate-mcp` up since 21:32:58Z, 0 restarts. Everything here is a read of `/slo`, `/metrics`, `/healthz`, `systemctl`, `redis-cli` and `df`/`free` on the VPS; nothing was changed. Values are process-lifetime unless the row says otherwise — the rolling windows restarted with the process, which is itself one of the findings.

## substrate-mcp (`127.0.0.1:7410`)

| Measure | Value | Source |
|---|---|---|
| `brief.p95` | **700 ms** vs 800 target (n 10, `insufficient-data` until 20) — was 3,115 ms on the pre-uplift-2 release | `/slo` |
| `emit.success` | 1.0 (n 7) | `/slo` |
| plane availability (rolling hour) | greptime 1.0 (n 16), index 1.0 (n 4), cache 1.0 (n 5), hindsight 1.0 (n 1), ragflow 1.0 (n 1) | `/slo.planes` |
| breakers | all five `closed`; one `plane.errors{plane=index}` since start | `/healthz.planes`, `/metrics` |
| cache | enabled, connected, hits 8 · misses 2 (first complete briefs were cached and served at 3 ms) | `/healthz.cache` |
| `/healthz` | 704 ms cold, 1 ms from the 5 s memo | curl |
| brief by surface (lifetime) | omp 10, muse 2, **grok-bot 0** (grok-bot in this process: `/events` 3, `/mcp` 4 ok + 1 4xx, tools `events` 3 / `memory_write` 1) | `/metrics` `substrate.brief.duration`, `substrate.request.total`, `substrate.tool.calls` |
| `substrate.tokens` / `substrate.cost.usd` | **0 points** — the instruments exist, no producer sends `usage` | `/metrics` |
| OTLP export | `degraded — no OTLP endpoint configured; metrics are collected and served but not exported` at every boot; no listener on 4317/4318 | journal, `ss -lnt` |
| SLO durability | catalogue objectives are process-lifetime aggregates, plane/burn windows in-memory; a restart zeroes all of them (`n 0` right after each deploy today) | `packages/observability/src/slo.ts:210-239,330-341`, `burn.ts:103-164` |
| audit chain | active file 3.75 MB, 0 closed segments (rollover threshold unset) | `stat`, `/healthz.auditRecords` |

## Stores

| Store | Measure | Value |
|---|---|---|
| TimescaleDB (index) | `capacity.index.databaseBytes` 11.9 MB; largest `memory_entries` 410 KB (65 live rows); `graph_nodes` 45 live / 50 dead | `/healthz.capacity` |
| TimescaleDB (index) | sweeper timer **not installed** (`substrate-index-sweep.timer` LoadState=not-found); `30d`/`graph` TTL classes are report-only because reads do not honour TTL | `systemctl show`, `index-sweep.ts:19-25` |
| GreptimeDB (ledger) | `ledger.writable: true`, write probe ok; `substrate-anchor.timer` **not installed** → BP-7 hourly Merkle anchoring is not scheduled on this host; `SUBSTRATE_LEDGER_TTL` unset; export is a manual runbook (`docs/greptime-ledger.md:605-624`) | `/healthz.ledger`, `systemctl list-timers` |
| loopback redis (cache) | `used_memory` 1.07 MiB; **`maxmemory 0`, policy `noeviction`, RDB `save 3600 1 300 100 60 10000` still on, `appendonly no`, unit `MemoryMax=infinity`** — the R7 redis drop-in and conf are not installed (rollout debt, HANDOFF step 3) | `redis-cli info memory`, `config get save`, `systemctl show redis-server` |
| Hindsight (recall) | boot warning `HINDSIGHT_BANK is set but legacy and unread; recall fans out over HINDSIGHT_BANKS`; retain outbox file absent (nothing parked yet); no outbox/backlog gauge exported | journal, `stat /var/lib/substrate/retain-outbox.jsonl` |
| RAGFlow (docs) | no docs_search in this process; per-dataset retrieval runs **sequentially**, each under its own 4 s timeout (`docs-search.ts:146-174`, `planes/ragflow.ts:223-247`) | code |

## VPS

| Measure | Value |
|---|---|
| RAM | 32,094 MiB total, 17,841 MiB available; `substrate.slice` 64 MiB current / 65 MiB peak (MemoryLow 2 GiB) |
| swap | 16,383 MiB total, **12,659 MiB used** (two 8 GiB files); `vmstat` `si=0 so=0` — occupied, not thrashing; owner not attributed |
| disk | 387 GiB, **94 % used, 27 GiB free**; docker nominal reclaim ≈ 11.2 GB (images 3.4, volumes 7.8) — not an approved reclaim |
| load | 10.1 / 7.9 / 6.6 on 8 vCPU |
| units | mcp, three collectors, dispatcher in `substrate.slice` with ceilings; `substrate-host` inactive; no health/watchdog timer (`WatchdogUSec=0`); skills timers installed but disabled |

## How "after" is measured

Each item's SUMMARY repeats the row(s) it claims to move. Lifetime and rolling figures are read from `/slo`, `/metrics` and `/healthz` after the operator deploys the uplift-3 release; the deploy procedure is the one HANDOFF.md of uplift-2 records (`infra/vps/deploy-release.sh <tag>` with `SUBSTRATE_HEALTH_TOKEN_FILE`).
