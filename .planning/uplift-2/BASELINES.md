# Uplift 2 — baselines (captured 2026-10-13, read-only)

n4 [SPE-10664](https://linear.app/swcstudio/issue/SPE-10664). Every number below was read from the running production service or stores with read-only calls; nothing was written. Values that could not be measured are marked **unknown** rather than estimated. Hosts are masked.

## substrate-mcp (`127.0.0.1:7410`, process up since 2026-10-10T14:23Z)

| Measure | Value | Source |
|---|---|---|
| `GET /slo` → `brief.p95` | **breached**: p95 **3,116 ms** vs 800 ms target; 4.08 % of 785 briefs ≤ 800 ms | `/slo` |
| `emit.success` | ok: 396/396 | `/slo` |
| brief duration by surface (count · mean) | muse 739 · **2,280 ms**; hermes 10 · 1,669 ms; omp 27 · 736 ms; claude-code 5 · 318 ms; grok-bot 3 · 292 ms | `/metrics` `substrate.brief.duration` |
| `/healthz` duration | muse 739 calls · mean 598 ms (one Greptime `SELECT 1` over the public edge + one Postgres ping per call); single probe today 545 ms | `/metrics` `substrate.request.duration`, curl |
| cache (`/healthz.cache`) | enabled, connected, mode on; **hits 8 · misses 793** (≈1 % hit ratio), bypasses 1, errors 1 | `/healthz` |
| `/events` refused | 527 untokened `4xx` on `/events` (unattributed caller) | `/metrics` |
| audit chain | 7,018 records, 3.55 MB, ≈1,770 records/day ≈ 0.9 MB/day, no rotation | `/healthz.auditRecords`, file size |
| process | 53 MB RSS, peak 88 MB, 0 restarts | `systemctl show` |

## Round trips from the VPS

| Target | Measure | Value |
|---|---|---|
| GreptimeDB public edge | TLS connect / TTFB on `/health` | 40 ms / **223 ms** |
| Hindsight public edge | TLS connect / TTFB on `/health` | 40 ms / **218 ms** |
| RAGFlow public edge | TLS connect / TTFB on `/health` | 41 ms / **253 ms** |
| TimescaleDB public TCP proxy | `select 1` cold / warm (Bun SQL) | **1,057 ms** cold (first connect), **172 ms** warm |
| loopback redis | — | sub-millisecond (same host) |

Implication: an uncached brief costs 3 sequential Postgres reads (≈520 ms warm) + 1 Greptime read (≈250 ms) + up to 4 cache round-trips before any source is read; the observed muse mean of 2.3 s is consistent with cold Postgres connects and the 5 s Greptime timeout on slow days.

## Stores

| Store | Measure | Value |
|---|---|---|
| GreptimeDB `agent_events` | rows · disk | 14,302 rows · 1.28 MB (SST 1.25 MB) |
| GreptimeDB `agent_events_pre_append_20260930` | rows · disk | 9,851 rows · 1.29 MB — stale pre-append table, never read |
| GreptimeDB `event_ingest` / `anchors` | rows | 1,074 / 0 (anchor timer not installed) |
| GreptimeDB ledger span | min–max `ts` | 2026-09-23 → 2026-10-13 (≈700 events/day) |
| GreptimeDB kinds | top | `brief.delivered` 9,051 (legacy September kind, refused by today's vocabulary), `tool.call` 1,886, `commit` 1,591, `agent.status` 911, `note` 630, `warning` 103 |
| GreptimeDB surfaces, last 7 d | count | cursor 1,314 · **grok-bot 1,296** · omp 522 · claude-code 11 · hermes 2 · substrate 1 |
| GreptimeDB TTL | table option | none (`SHOW CREATE TABLE`: only `append_mode='true'`) |
| TimescaleDB | database size | 11 MB of a 500 MB volume |
| TimescaleDB | largest relations | `memory_entries` 400 kB (64 live), `memory_writes` 104 kB (58 live / 12 dead), `graph_nodes` 64 kB (45 live / **50 dead**, never autovacuumed), `graph_index` 48 kB |
| TimescaleDB | connections from this service | 19 idle + 1 active, `application_name` empty; `max_connections` 100 |
| TimescaleDB | server settings | `statement_timeout 0`, `idle_in_transaction_session_timeout 0`, `shared_buffers 128 MB`, `work_mem 4 MB`, `tcp_keepalives_idle 7200` |
| TimescaleDB | hypertables / policies | 0 / none |
| loopback redis | memory · keys · config | 1.0 MB used, peak 1.0 MB · 8 keys · `maxmemory 0`, `noeviction`, RDB save on, AOF off, keyspace hits 388 / misses 192 |
| Railway Dragonfly | use | **unused by production** (5 GB volume provisioned) |
| Hindsight | retain/recall volumes, tokens injected per prompt | **unknown** (no per-plane metric exists; see R2) |
| RAGFlow | datasets, chunk/embedding settings, retrieval p95 | **unknown** (no live ingest attested; Phase 25 G1–G4 gated; no per-plane metric) |

## VPS

| Measure | Value |
|---|---|
| CPU / RAM | 8 vCPU; 31 GiB total, 18.9 GiB available, **swap 12 / 15 GiB used** |
| Disk | `/` 387 GB, **95 % used, 22 GB free** (co-tenants: `/root/src` 126 GB, containerd 46 GB, docker 29 GB with ≈25 GB reclaimable) |
| `/var/lib/substrate` | 350 MB (rivetkit 318 MB, audit 3.4 MB) |
| substrate units | `MemoryMax=infinity`, `CPUQuota` unset, `TasksMax=38467` (kernel default) on every `substrate-*` unit; `redis-server` likewise |

## How "after" is measured

Each item's SUMMARY repeats the row(s) it claims to move. `brief.p95`, cache hit ratio, `/healthz` duration and per-plane series are read from `/slo`, `/metrics` and `/healthz` after the operator deploys the release (`infra/vps/deploy-release.sh`); until then the SUMMARY states "post-deploy measurement pending" and records the unit/rehearsal evidence instead.
