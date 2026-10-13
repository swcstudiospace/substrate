# Uplift 2 — seven data-plane improvements (post-v1.3, series 2)

**Date:** 2026-10-13 · **Graph:** `ut-mv66gjpd-4d730336` · **Nodes:** n5 [SPE-10665](https://linear.app/swcstudio/issue/SPE-10665) (candidates), n6 [SPE-10666](https://linear.app/swcstudio/issue/SPE-10666) (selection), n8 [SPE-10667](https://linear.app/swcstudio/issue/SPE-10667) (execution plan)
**Inputs:** [CONTEXT.md](CONTEXT.md) (recon + Build Plan index `BP-*`/`A-*`/`DP-*`), [BASELINES.md](BASELINES.md) (measured today). Prior art excluded: U1–U7 (PR #58).
**Shape:** one branch `ultrathink/uplift-2` cut from `main`, one commit series per item, each independently revertible (`git revert` of its range), each behind a config switch where feasible, `git diff --stat` matching the declared file scope. Full gate set (`bun run verify` + `bun run test:py`) after every item; red ⇒ fix or revert, never advance.
**Decisions carried (CONTEXT.md §Ambiguities):** repo changes only (operator applies runtime settings from runbooks); data-reducing policies ship as code behind flags that default to off or dry-run — this run deletes nothing in production; cost-neutral; merge via PR + CI + Greptile 5/5 + `ultrathink-ship` auto-merge.

## Why these: the measured problem

The brief SLO is breached today — p95 **3,116 ms** against 800 ms, 4 % of briefs inside target — while the cache hit ratio is **1 %** (8 hits / 793 misses). Every uncached brief pays three sequential Postgres round-trips over the public TCP proxy (172 ms warm, 1 s cold) and one Greptime read over the public edge (≈250 ms), with no deadline, no ETag and no per-plane breaker, so a slow plane makes every caller — including the `grok-bot` seat (second-largest emitter, 1,296 events in 7 days) — wait for the full timeout. None of the five planes has a latency/error series, `/healthz` does not look at three of them, failed Hindsight retains are lost, RAGFlow versions vanish on restart, nothing bounds growth on the two 500 MB Railway volumes, and no substrate unit on a VPS at 95 % disk and 12 GiB swap has a memory ceiling.

## Candidates considered (12) and ranking

Score = Build-Plan alignment × impact ÷ risk (1–5 each). Selected = top 7; the rest go to the backlog note at the end.

| # | Candidate | Align | Impact | Risk | Score | Decision |
|---|---|---|---|---|---|---|
| C1 | Brief fast path: parallel reads, deadline, ETag/304, degraded header, last-good snapshot, targeted invalidation | 5 | 5 | 2 | 12.5 | **R1** |
| C2 | Plane circuit breakers, per-plane metrics/SLOs, dependency-aware `/healthz`, rolling windows, per-plane chaos smoke, runbook substrate-red | 5 | 5 | 2 | 12.5 | **R2** |
| C3 | Hindsight retain outbox with retry, recall breaker/budgets, dedupe, config warnings, doc fixes | 5 | 4 | 2 | 10 | **R3** |
| C4 | TimescaleDB connection hygiene, capacity telemetry, retention sweeper (dry-run default), runbooks lease-stuck / quarantine-spike | 4 | 4 | 2 | 8 | **R4** |
| C5 | GreptimeDB ledger: chain-tip cache + per-session serialisation, bounded reads, write-probe health, capacity telemetry, opt-in TTL | 4 | 4 | 2 | 8 | **R5** |
| C6 | RAGFlow: persistent versions/pins, dataset + search caches, superseded-document retirement, retrieval knobs, unit env, async merge-trigger | 4 | 4 | 2 | 8 | **R6** |
| C7 | VPS guardrails: cgroup limits + slice, store-aware deploy gate + disk floor, redis config, audit-chain segment rollover, disk runbook | 4 | 4 | 2 | 8 | **R7** |
| C8 | Per-surface rate limiting / request budgets in the cache (429 + Retry-After) | 3 | 3 | 3 | 3 | backlog (policy-laden; 527 untokened `/events` refusals are the only storm seen) |
| C9 | `tenant=swc` on every row | 3 | 1 | 4 | 0.75 | backlog (schema touch on three stores, no consumer yet) |
| C10 | Tiered memory promotion/demotion rules (cache → Hindsight → index) with a Grok context budget | 3 | 3 | 4 | 2.25 | backlog (prompt assembly lives in programming-desk, not here) |
| C11 | Timescale hypertables/compression/aggregates for the desk tables | 2 | 2 | 3 | 1.3 | discard (those tables are not in this repo; `docs/data-planes.md` L25 overstates — corrected in R4 docs) |
| C12 | RAG golden-question eval harness in CI | 3 | 3 | 3 | 3 | backlog (needs a live RAGFlow dataset; Phase 25 G1–G4 still gated) |

## The seven

### R1 — Brief fast path and cache effectiveness
**Summary:** make `POST /brief` / `memory_brief` answer inside its own deadline from parallel reads, tell the caller when it is degraded, let the caller skip unchanged briefs with an ETag, serve the last good brief when a store is down, and stop heartbeats from invalidating every brief.
**Build Plan:** BP-5.4 (the brief, 1.5 s fail-open), A-3 ("brief p95 < 800ms"), A-4 ("Required `memory_brief` • etag … explicit `degraded`"), A-5 ("degraded mode (Dragonfly brief snapshot)"), BP-5.0 (Dragonfly "brief snapshots").
**Targets:** Dragonfly/loopback cache · Grok Bot · VPS (fewer Railway round-trips per brief).
**Observed → proposed:** `brief.ts` L123-246 reads four sources sequentially with no request deadline; `server.ts` L657-670 returns a plain 200; `service.ts` L1829 bumps `gen:graphs` on every heartbeat (hit ratio 1 %); `cache.ts` L281-290 reads generation keys serially. → independent reads run under one `AbortSignal` budget (`SUBSTRATE_BRIEF_BUDGET_MS`, default 1200, 0 = off); response carries `ETag` (hash of body) and `X-Substrate-Brief: complete|degraded|snapshot`, honours `If-None-Match` → 304; a complete brief is also stored as `substrate:v1:brief-snapshot:<sha(surface,args)>` (TTL `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S`, default 3600, 0 = off) and served with a dated "snapshot" banner line when any source fails; heartbeat bumps only `gen:graph:<id>`; generation GETs are pipelined (`MGET`); `/healthz` store probes are cached for 5 s so collectors polling health do not hit Railway per call.
**Metric:** `brief.p95` 3,116 ms → ≤ 800 ms (SLO); cache hit ratio 1 % → > 50 % under collector polling; muse mean brief 2,280 ms → < 600 ms (post-deploy).
**Risk / blast radius / rollback:** medium; brief readers on every surface. Snapshot could serve stale data — bounded by TTL, marked in header and body, never served while all stores answer. Rollback: `git revert` the series; or `SUBSTRATE_BRIEF_BUDGET_MS=0` and `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S=0` without redeploy of code.
**Outline:** `brief.ts` (parallel compose, deadline), `service.ts` brief()/heartbeat, `cache.ts` (MGET, snapshot class), `server.ts` (/brief headers, 304, cached healthz probe), `config.ts`, `.env.example`, `docs/data-planes.md` cache row, `docs/observability.md`; tests: compose ordering under injected slow source, deadline fires fail-open, ETag/304 contract, snapshot served only on failure, heartbeat invalidation scope.
**Verify:** new unit tests + `bun run verify`; rehearsal harness smoke `bun run rehearsal smoke` still green; post-deploy `/slo` reads.
**Effort / deps:** M; R2's breaker makes the deadline cheaper but is not required.

### R2 — Plane circuit breakers, per-plane SLOs and a dependency-aware health surface
**Summary:** one small breaker (closed → open → half-open) around every plane client, one histogram and one error counter per plane, `/healthz` and `/slo` that say which plane is unhealthy, rolling-window SLO evaluation, a chaos smoke that can blackhole any plane, and the `substrate red` runbook.
**Build Plan:** A-5 ("Circuit breakers + degraded mode", "Chaos smoke in CI", "Runbooks: substrate red"), A-3 (SLOs, OTLP latency/errors), A-7 #3, DP-fail.
**Targets:** all five planes · Grok Bot (gateway calls degrade in milliseconds instead of timeouts) · VPS.
**Observed → proposed:** no breaker anywhere (`greptime.ts`, `index-store.ts`, `cache.ts` L135-192 reconnects per call, `planes/*.ts`); instruments.ts L14-31 has no per-plane series; `/healthz` ignores cache/Hindsight/RAGFlow and its index ping is unbounded; SLO counters are process-lifetime; `scripts/chaos-smoke.ts` is Greptime-only. → `packages/observability/src/breaker.ts` (`failureThreshold`, `openMs`, half-open probe; env `SUBSTRATE_BREAKER_FAILURES`/`_OPEN_MS`, `SUBSTRATE_BREAKER=0` disables) wired into the five clients; `substrate.plane.duration{plane,op,outcome}` + `substrate.plane.errors{plane,reason}` + breaker state; `/healthz` gains `planes:{greptime,index,cache,hindsight,ragflow}` with `{ok, breaker, lastErrorAt}` (status code rule unchanged: ledger/index decide); `/slo` adds `plane.<name>.availability ≥ 99 %` objectives computed over a rolling 1 h window beside the cumulative view; `bun run smoke:chaos --plane <name>`; `docs/runbooks/substrate-red.md`.
**Metric:** time-to-degraded answer during an outage: 4–5 s → < 50 ms once open; per-plane error rate visible in `/slo`.
**Risk / blast radius / rollback:** medium; every plane call passes a wrapper. A mis-tuned breaker could refuse a healthy plane for `openMs` — defaults generous (5 failures / 30 s), kill switch `SUBSTRATE_BREAKER=0`. Rollback: revert series or kill switch.
**Outline:** observability `breaker.ts`, `instruments.ts`, `slo.ts` (rolling window), `metrics.ts`; mcp-server `greptime.ts`, `index-store.ts`, `cache.ts`, `planes/hindsight.ts`, `planes/ragflow.ts`, `service.ts` health(), `server.ts` /healthz; `scripts/chaos-smoke.ts`; docs `observability.md`, runbook; tests: breaker state machine, half-open single probe, per-plane series emitted, healthz shape, chaos smoke argument parsing.
**Verify:** unit tests + `bun run verify`; chaos smoke against the rehearsal twin for `greptime` and `index`.
**Effort / deps:** M; foundation R3/R5/R6 reuse.

### R3 — Hindsight: durable retain outbox, bounded recall, cleaner config
**Summary:** a failed Hindsight retain is queued on local disk and retried with backoff instead of being lost; recall gets a breaker, an env budget and a shorter leg inside `memory_search`; cross-bank duplicates collapse; stale config warns at boot; stale docs are corrected.
**Build Plan:** A-5 ("write outbox"), A-1 ("Exactly-once writes"), BP-5.0 (Hindsight "feeding `memory.brief`"), A-4 (Grok Bot loop), DP-fail.
**Targets:** Hindsight · Grok Bot (its `memory_write` is forwarded as `sub-grok-bot`; its searches wait on recall today).
**Observed → proposed:** `memory-retain.ts` L166-193 — one warning on timeout/5xx/429, no retry; `memory-recall.ts` L129-140 — fixed 4 s budget, degraded results uncached, `memory_search` waits for the slowest bank (`service.ts` L1214-1217); no dedupe (L145-156); `ensuredBanks` never evicted (hindsight.ts L260); production has legacy `HINDSIGHT_BANK` set and `HINDSIGHT_BANKS` unset; `docs/grok-bot.md` says no adapter exists. → `retain-outbox.ts`: JSONL under `SUBSTRATE_RETAIN_OUTBOX_PATH` (0600, bounded by `SUBSTRATE_RETAIN_OUTBOX_MAX`, default 10 000; unset path = memory-only bounded queue) with exponential backoff + jitter, drained on a timer and at shutdown, entry re-read from the index by id so a stale body is never replayed, final failure keeps today's warning; recall through R2's breaker, `HINDSIGHT_RECALL_BUDGET_MS` (default 4000) and `HINDSIGHT_SEARCH_RECALL_BUDGET_MS` (default 1500) for the search leg; dedupe on `document_id ?? text` keeping the best score; evict + re-ensure on 404; boot warning for `HINDSIGHT_BANK`; docs fixed.
**Metric:** retains that reach Hindsight after a transient error: 0 % → 100 % within the backoff schedule; `memory_search` p95 while Hindsight is slow: ≤ 1.5 s + index time.
**Risk / blast radius / rollback:** low-medium; forward path only (the governed index write is untouched). Rollback: revert; `SUBSTRATE_RETAIN_OUTBOX_PATH` unset keeps today's behaviour plus in-memory retry.
**Outline:** `memory-retain.ts`, new `retain-outbox.ts`, `memory-recall.ts`, `planes/hindsight.ts`, `service.ts`, `index.ts` (drain at shutdown), `config.ts`, `.env.example`, `infra/vps/substrate-mcp.service` (`SUBSTRATE_RETAIN_OUTBOX_PATH` under StateDirectory), `docs/grok-bot.md`, `docs/memory-governance.md`; tests: enqueue on each failure kind, backoff schedule, replay reads current entry, bounded file, dedupe, budgets.
**Verify:** unit tests with the Hindsight fake; `bun run verify`.
**Effort / deps:** M; uses R2 breaker.

### R4 — TimescaleDB: connection hygiene, capacity telemetry, retention sweeper
**Summary:** give the index client a sized pool with timeouts and a name, expose database/table sizes, and add an opt-in sweeper that applies the documented retention (terminal graphs + 90 days, spent idempotency rows, decided reviews/quarantine, superseded versions) — dry-run by default — with the two missing runbooks.
**Build Plan:** BP-3.2 ("Postgres is only an index … a cache"), DP-ret ("Open Graph IDs + 90 days"), BP-2 (500 MB index on Railway because the VPS disk is full), A-5 ("Runbooks: lease stuck · quarantine spike").
**Targets:** TimescaleDB · VPS (19 idle connections, cold connects of 1 s).
**Observed → proposed:** `index-store.ts` L106-108 `new SQL(url)` with no options; 19 idle connections with empty `application_name`; `statement_timeout 0`; no DELETE on any table (migrate L111-297); `graph_nodes` 50 dead / 45 live tuples; docs claim hypertables/retention that do not exist. → `SUBSTRATE_PG_POOL_MAX` (default 8), `SUBSTRATE_PG_CONNECT_TIMEOUT_MS` (2000), `SUBSTRATE_PG_STATEMENT_TIMEOUT_MS` (5000, applied per connection), `SUBSTRATE_PG_IDLE_TIMEOUT_S`, `application_name=substrate-mcp`; `index.capacity()` → `/healthz.index.{databaseBytes, largestTables}`; `index.sweep({apply})` + `substrate index sweep [--apply]` CLI + `substrate-index-sweep.timer` unit (staged, dry-run) with `SUBSTRATE_INDEX_SWEEP=dry-run|apply|off` (default dry-run) emitting one `note` per run on surface `substrate`; `docs/runbooks/lease-stuck.md`, `docs/runbooks/quarantine-spike.md`; `docs/data-planes.md` index row corrected to what exists.
**Metric:** idle connections 19 → ≤ 8; no index query older than 5 s; sweeper dry-run report present in the ledger daily; database size visible in `/healthz`.
**Risk / blast radius / rollback:** low in dry-run; `apply` is the only destructive path and is operator-enabled after a Railway volume snapshot per the runbook. Rollback: revert; env defaults restore today's client.
**Outline:** `index-store.ts` (options, capacity, sweep), new `index-sweep-run.ts`, `packages/cli/src/index.ts`, `config.ts`, `.env.example`, `infra/vps/substrate-index-sweep.{service,timer}`, runbooks, `docs/data-planes.md`; tests: sweep selects exactly the documented classes (DB-backed tests skip without `SUBSTRATE_TEST_PG_URL`, so also pure selection tests), dry-run writes nothing, capacity shape.
**Verify:** `bun run verify`; sweep dry-run against the rehearsal Postgres.
**Effort / deps:** M; none.

### R5 — GreptimeDB ledger: cheaper writes, bounded reads, honest health, opt-in retention
**Summary:** stop scanning the whole ledger on every emit, serialise same-session emits so chains cannot fork, bound the brief and SSE reads in time, make `/healthz` prove writability, expose ledger bytes, and let the operator switch on the documented 180-day TTL.
**Build Plan:** BP-7 (ledger as hash chain), DP-ret ("180 days hot, then export"), A-5 (Greptime chaos expectations), BP-5.0 (GreptimeDB append-only log).
**Targets:** GreptimeDB · VPS (fewer and smaller Railway calls per event).
**Observed → proposed:** `greptime.ts` L756-762 `lastHash` reads up to 10 000 rows by `session_id` (not a key) per emit; concurrent same-session emits fork the chain (read-then-write); brief read L173-180 and SSE `eventsByIds` L859-866 have no `ts` bound; `/healthz` derives writability from metadata so a disk-full store reports 200; no TTL; 9,851-row stale `agent_events_pre_append_20260930` table. → per-session chain-tip LRU seeded once from `lastHash` and a per-session promise chain in `Substrate.emit` (`SUBSTRATE_LEDGER_CHAIN_CACHE=0` disables); `ts >=` bounds on brief (30 d) and SSE lookups (from `event_ts`); a 1-row write probe into `substrate_health` folded into `eventsWritable` (`SUBSTRATE_LEDGER_WRITE_PROBE_S`, default 60); `region_statistics` → `/healthz.ledger.bytes`; `SUBSTRATE_LEDGER_TTL` (unset = no change) applied by `migrate()` as `ALTER TABLE … SET 'ttl'` only when set, with `docs/greptime-ledger.md` export-before-expiry step and the stale-table cleanup step.
**Metric:** Greptime calls per emit 3–4 → 2 (steady state); brief recent-actions query bounded; `/healthz` 503 within 60 s of writes failing; ledger bytes visible.
**Risk / blast radius / rollback:** medium on the emit path (chain correctness) — guarded by existing `events_verify` tests and a fork-prevention test; TTL is opt-in and reversible (`SET 'ttl'=''`). Rollback: revert or env off.
**Outline:** `greptime.ts`, `service.ts` emit()/health(), `server.ts` SSE query bounds, `config.ts`, `.env.example`, `docs/greptime-ledger.md`, `docs/data-planes.md`; tests: chain cache correctness vs ledger, same-session concurrency yields one chain, bounded SQL text, write-probe health transitions, TTL applied only when configured.
**Verify:** `bun run verify`; `bun run smoke:vocabulary`/rehearsal smoke on the scratch Greptime.
**Effort / deps:** M; R2 breaker for the client.

### R6 — RAGFlow docs plane: durable versions, cached reads, bounded growth
**Summary:** persist dataset versions and pins so citations and merge-trigger idempotency survive restarts, cache the dataset list and `docs_search` answers, retire superseded documents so the Railway corpus stops growing, send explicit retrieval knobs, and make the merge trigger asynchronous.
**Build Plan:** BP-5.1 (`docs.search` / `docs.ingest`), DP-ret ("last five versions kept", "Re-ingest on merge"), A-4 ("Docs: only substrate `docs.search`"), DP-cache (cache coverage).
**Targets:** RAGFlow · Grok Bot (its docs path when the gateway falls back to substrate `docs_search`) · VPS.
**Observed → proposed:** version store in-memory (`server.ts:500`); pins never passed to search (`service.ts` L2364-2374) so every citation says `unpinned`; `GET /datasets` on every search/ingest; superseded documents never deleted (`docs-ingest.ts` L17-20); unit does not set `SUBSTRATE_DOCS_STATE_FILE`; merge-trigger runs ingest inline while the skills-sync client times out at 3 s. → versions persisted in the docs state file (`version: 2`), pins + degraded datasets wired into `searchDocs`; dataset list cached 60 s (invalidated on create); `docs-search` cache class (TTL 300 s, `gen:docs` bumped by ingest/refresh); `SUBSTRATE_DOCS_PRUNE_SUPERSEDED=1` deletes the replaced document after the new one parses (default off; endpoint shape verified against the RAGFlow HTTP reference before use, otherwise recorded as unverified and left off); `similarity_threshold`/`top_k` env knobs; merge-trigger answers 202 with a job id and runs in the background; unit `Environment=SUBSTRATE_DOCS_STATE_FILE=…` under StateDirectory.
**Metric:** citations carrying a real commit pin: 0 % → 100 % after one ingest; RAGFlow calls per `docs_search`: 1 + N → N (cached list) and 0 on a cache hit; merge-trigger client errors: always → none.
**Risk / blast radius / rollback:** low-medium; the live RAGFlow endpoint shapes remain unattested (Phase 25 G1–G4 gated) — nothing here depends on an unverified shape except the opt-in prune. Rollback: revert; prune flag off by default.
**Outline:** `docs-datasets.ts`, `docs-search.ts`, `docs-ingest.ts`, `planes/ragflow.ts`, `service.ts`, `server.ts` (merge-trigger), `cache.ts` (class), `config.ts`, `.env.example`, `infra/vps/substrate-mcp.service`, `docs/docs-search-ingest.md`; tests with `RagflowFake`: persistence round-trip, pins reach citations, list cache, search cache keyed by pins, prune only when flag set, 202 contract.
**Verify:** `bun run verify`.
**Effort / deps:** M; R1 cache class pattern.

### R7 — VPS guardrails: resource ceilings, store-aware deploy gate, audit-chain rollover
**Summary:** give every substrate unit a memory/task ceiling inside a `substrate.slice`, make the release health gate check the stores and free disk, document the loopback redis configuration the cache assumes, and roll the MCP audit chain over by size without breaking verification.
**Build Plan:** BP-1/BP-2 (VPS at 90 %+ disk, services moved off-box for that reason), A-3 ("Hash-chained MCP audit"), A-5 (reliability; runbooks).
**Targets:** VPS · Dragonfly/loopback redis.
**Observed → proposed:** every `infra/vps/*.service` has `MemoryMax=infinity`; host swap 12/15 GiB; `deploy-release.sh` L344-368 passes on `/healthz` status alone; local redis `maxmemory 0` + `noeviction` + RDB snapshots on a 95 % disk; `mcp-audit.jsonl` grows 0.9 MB/day with manual, restart-coupled rotation (`docs/mcp-audit.md` L54-60). → `infra/vps/substrate.slice` + `MemoryHigh/MemoryMax/TasksMax/CPUQuota` per unit (mcp 1G/2G, collectors 512M, dispatcher/host 4G) as drop-ins the operator installs with the next release; `deploy-release.sh` gains `SUBSTRATE_HEALTH_REQUIRE_STORES=1` (asserts `index`, `eventsWritable`, and R2 `planes` when present) and a free-disk floor (`SUBSTRATE_DEPLOY_MIN_FREE_GB`, default 5); `infra/vps/redis-substrate.conf` drop-in (`maxmemory 256mb`, `maxmemory-policy allkeys-lru`, `save ""`, `appendonly no` — the cache tolerates loss by design) + runbook step; in-process audit rollover: when the file passes `SUBSTRATE_AUDIT_ROLLOVER_BYTES` (unset = off) the writer closes the segment and starts `mcp-audit-<seq>.jsonl` whose first record carries the previous tip hash, `substrate audit verify` walks segments; `docs/runbooks/disk-pressure.md`.
**Metric:** no substrate unit without a `MemoryMax`; deploy refuses when `< 5 GB` free or a store is not writable; audit segments ≤ configured size with verification passing across the boundary.
**Risk / blast radius / rollback:** low-medium; ceilings too tight could OOM-kill the mcp (defaults 20× today's RSS; `Restart=always` recovers). Rollback: remove drop-ins; env off for rollover and gate.
**Outline:** `infra/vps/*.service` + `.d/` drop-ins, `substrate.slice`, `deploy-release.sh` (+ its test), `infra/vps/README.md`, `packages/audit/src/*` (segmented writer + verify), `packages/cli/src/index.ts` (`audit verify`), `docs/mcp-audit.md`, runbook; tests: deploy gate parsing (existing `deploy-release.test.ts` pattern), rollover boundary + cross-segment verify, drop-in files lint (`systemd-analyze verify` where available).
**Verify:** `bun run verify`; `systemd-analyze verify` on the unit files.
**Effort / deps:** M; R2 for the `planes` field (optional).

## Execution plan (n8)

| Wave | Units (file-disjoint) | Gate |
|---|---|---|
| 0 | this proposal → **user acceptance pause** | accepted / amended |
| 1 | **R2** (observability package + plane clients + healthz) ‖ **R4** (index-store options/capacity/sweep + runbooks) ‖ **R7** (infra units, deploy script, audit package) | `bun run verify`, `test:py` |
| 2 | **R1** (brief/cache/server; consumes R2 series) ‖ **R3** (retain/recall; consumes R2 breaker) ‖ **R5** (greptime/emit/SSE; consumes R2 breaker) | same |
| 3 | **R6** (docs plane; consumes R1 cache class) ‖ docs/env/STATE/HANDOFF | same + `check:phase-close` |
| 4 | secret scan, `bun run verify`, PR via `ultrathink-ship --ignore-gsd`, Greptile 5/5, auto-merge, `ultrathink-sync` | merged |

Shared files touched by more than one item (`service.ts`, `server.ts`, `config.ts`, `.env.example`, `cache.ts`) are edited by one owner per wave; later waves rebase on the merged state of the earlier wave.

## Backlog note (not implemented this series)

C8 per-surface rate limiting; C9 `tenant=swc`; C10 tiered memory promotion with a Grok context budget (programming-desk side); C12 RAG golden-question harness (after Phase 25 G1–G4 live proofs). Operator-only follow-ups surfaced by recon, outside this repo: Railway Dragonfly keep/decommission decision; forwarder cutover (D-T6); `HINDSIGHT_BANKS` set and legacy `HINDSIGHT_BANK` removed in `substrate.env`; docker/containerd prune (~25 GB reclaimable); 9 historic `substrate.env.bak-*` files.

## Progress log

Accepted by the operator on 2026-10-13 ("Accept all 7 and implement"). Gates at the final head: tsc clean · `bun test` 3525 pass / 65 skip / 1 fail (recorded F-01) · `check:phase-close` pass · `test:py` 298 pass · rehearsal twin smoke 4/4 + chaos (ledger paused) proving deadline, degraded header, breaker, honest health. Per-item evidence in each `0N-SUMMARY.md` §Gates.

| Item | Status | Gates | Notes |
|---|---|---|---|
| R1 | done | tsc · suite green mod F-01 · twin: ETag/304 in 8 ms, degraded brief in 1.21 s under a hung ledger | [01-SUMMARY.md](01-SUMMARY.md) — snapshot path unit-tested (twin cache off); production p95 pending deploy |
| R2 | done | tsc · suite green mod F-01 · twin: breaker open after 5 timeouts, emit 503 in 5 ms, healthz 503, `plane.greptime.availability` breached 63 % | [02-SUMMARY.md](02-SUMMARY.md) — gate threaded via `gatedFetch`, not per-function params |
| R3 | done | tsc · suite green mod F-01 (outbox/budget/warning tests) | [03-SUMMARY.md](03-SUMMARY.md) — backoff span ≈ 3 h; outbox stats via `retainOutboxStats()` |
| R4 | done | tsc · suite green mod F-01 · twin: capacity.index live, sweep dry-run deletes nothing | [04-SUMMARY.md](04-SUMMARY.md) — ttl-class entries report-only (reads do not filter on ttl) |
| R5 | done | tsc · suite green mod F-01 · twin: write probe + capacity.ledger live, eventsWritable flips under outage | [05-SUMMARY.md](05-SUMMARY.md) — TTL rollback is `UNSET 'ttl'`; SSE call site passes positions |
| R6 | done | tsc · suite green mod F-01 (documented-shape fake) | [06-SUMMARY.md](06-SUMMARY.md) — live RAGFlow shapes still operator-gated; prune off by default |
| R7 | done | tsc · suite green mod F-01 · twin: `audit:verify` ok | [07-SUMMARY.md](07-SUMMARY.md) — ceilings in unit files; `bun run audit:verify` instead of a CLI subcommand |
