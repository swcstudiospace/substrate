# Uplift 3 — recon record (read-only)

**Date:** 2026-10-13 · **Graph:** `ut-mv78nh8v-aa49a98b` (Notion task [3f8bc1a0c7ae81838ff8c0b2e783d482](https://app.notion.com/p/3f8bc1a0c7ae81838ff8c0b2e783d482); nodes n1 [SPE-10912](https://linear.app/swcstudio/issue/SPE-10912) frame · n2 [SPE-10913](https://linear.app/swcstudio/issue/SPE-10913) discovery · n3 [SPE-10914](https://linear.app/swcstudio/issue/SPE-10914) candidates · n4 [SPE-10915](https://linear.app/swcstudio/issue/SPE-10915) unknowns · n5 [SPE-10916](https://linear.app/swcstudio/issue/SPE-10916) select seven · n6 [SPE-10918](https://linear.app/swcstudio/issue/SPE-10918) blueprint/implement · n7 [SPE-10917](https://linear.app/swcstudio/issue/SPE-10917) validation + merge gating · n8 [SPE-10919](https://linear.app/swcstudio/issue/SPE-10919) waves) · **Mode:** read-only discovery by eight parallel scouts (Build Plan delta, observability, Hindsight, RAGFlow, cache, index + ledger, Grok Bot path, VPS runtime), every claim with its file:line or command; no value from `/etc/substrate/*.env`, key names only; hostnames never recorded. Live numbers are in [BASELINES.md](BASELINES.md). The planner's HITL items resolved from evidence: Build Plan via the session's Notion MCP (q1); acceptance pause (q2, done); Railway documented only (q3); this repository only (q4).

## GSD state

`.planning/ROADMAP.md` v1.3 18/18 complete and archived; uplift-1 (U1–U7, PR #58) and uplift-2 (R1–R7, PR #59, follow-up PR #60) are merged and **deployed** (`9231f43`). As before, this run is a standalone post-close series under `.planning/uplift-3/` — no new ROADMAP milestone. The operator chose it explicitly ("Start uplift-3: 7 new items") after the same prompt returned a fourth time.

## What is delivered and must not be re-proposed

Brief fast path, ETag/304, snapshots, breakers + per-plane SLOs + `/healthz.planes/capacity`, chaos CLI, Hindsight outbox + recall budgets + dedupe, index pool/timeouts/sweeper (dry-run) + runbooks, ledger chain-tip cache + write probe + opt-in TTL, RAGFlow pins/caches/prune/async trigger, unit ceilings + `substrate.slice` + deploy gates + audit rollover (`.planning/uplift-2/PROPOSAL.md:132-142`, `HANDOFF.md:13-23`).

## Per-plane record (delta since uplift-2)

| Plane | What the scouts established | Evidence |
|---|---|---|
| Cache (loopback redis / Dragonfly) | Rate counters and an idempotency mirror are still "a target"; C8 undelivered. The admission seam is after token resolution and the 401 decision, before route handlers; MCP batches are parsed before audit, so one request token alone leaves a batch-cost loophole. Bun 1.4's `RedisClient` declares `eval`/`evalsha`/`script` — an atomic Lua bucket needs no dependency; Dragonfly compatibility is not attested. Generation counters are plain `INCR` without TTL by design (`volatile-lru` protects them). Request metrics keep status **class** only, so 401/403/429 are indistinguishable. Concurrent misses each run their own loader (no flight map). | `server.ts:536-606,1458-1488`; `cache.ts:95-104,287-292,407-452,472-483`; `instruments.ts:296-307`; `docs/data-planes.md:26` |
| TimescaleDB (index) | `30d` and `graph` TTL classes are report-only because reads never check expiry; the sweeper is staged (timer not installed). Capacity is a point-in-time read (`/healthz.capacity`), no trend, no pool-wait metric. | `index-sweep.ts:19-25,396-422`; `index-store.ts:1606-1620`; `infra/vps/README.md:42` |
| GreptimeDB (ledger) | Anchoring code, unit and timer exist but **the timer is not installed** (LoadState=not-found) — BP-7's hourly root is not scheduled here. Ledger export before TTL is a manual read/write procedure; expiry breaks recomputation from the live ledger. | `infra/vps/substrate-anchor.timer:5-12`; `anchor-run.ts:34-56`; `docs/greptime-ledger.md:605-624` |
| Hindsight (recall) | Banks are configured, never discovered; upstream documents `GET /v1/default/banks` but the client has no `listBanks`. Recall emits nothing (no contribution evidence). Outbox stats exist in-process; no backlog/age gauge is exported. No consolidation, pruning or locator-scoped purge path; PII is quarantined, not purged. Grok has two copies (`pd-*` gateway bank, `sub-grok-bot` governed) by current policy. | `planes/hindsight.ts:57-90,276-379,471-522`; `memory-recall.ts:7-9,70-132`; `memory-retain.ts:106-207`; `docs/grok-bot.md:29-58` |
| RAGFlow (docs) | Datasets are retrieved **sequentially**, each with a 4 s timeout — N sequential waits, not one budget. Knobs: threshold 0.2, vector weight 0.3, topK 1024; no rerank. Only `plane.duration{ragflow}` exists — no result-count/zero-hit/citation-coverage metric. `RagflowFake` is a contract fixture (returns fixture order, ignores the question), so an offline harness can prove scorer/provenance/redaction logic, not relevance. Merge-trigger for non-local datasets acknowledges a truthful `no-configured-ingest-root` noop. The sibling desk-gateway checkout retrieves RAGFlow directly (policy divergence from A-4; external repo). | `docs-search.ts:146-174`; `planes/ragflow.ts:100-138,223-247`; `ragflow-fake.ts:152-156,213-254`; `server.ts:1153-1188` |
| Observability / SLO | Exporter exists but no endpoint is configured; catalogue SLOs are process-lifetime aggregates, plane/burn windows in-memory: every restart zeroes them. `/slo.breached` lists catalogue breaches only. No breach/breaker notification exists (the dispatcher's `[quota-burn]` marker is the only alert, for token burn). `substrate.tokens`/`cost.usd` have zero points — no producer sends `usage`. | `observe.ts:165-201,285-289`; `slo.ts:210-239,283-341`; `burn.ts:103-164`; `server.ts:648-677`; `instruments.ts:15-25,267-293` |
| Grok Bot (`grok-bot` surface) | `/brief` returns ETag + `X-Substrate-Brief` state; MCP `memory_brief` returns text only (no etag/state). The sibling gateway checkout POSTs briefs without conditional headers and drops response headers, so state/ETag are lost at that boundary (deployed revision UNKNOWN). No per-surface SLO verdict; A-7 #5's connector smoke does not exist (chaos smoke calls brief as grok-bot but is an outage harness). | `server.ts:405-420,716-743`; `mcp.ts:205-224`; `slo.ts:84-111,210-224`; `scripts/chaos-smoke.ts:156-244,475-540`; programming-desk `upstreams.py:250-256,318-322,385-404` |
| VPS runtime | Ceilings and slice are live (64 MiB used). **Redis R7 settings never reached runtime** (`maxmemory 0`, `noeviction`, RDB snapshots on, unit `MemoryMax=infinity`). No health/watchdog timer; anchor and sweep timers not found. Disk 94 %, swap 12.7 GiB occupied (no paging now), load ≈ 10 on 8 vCPU; docker reclaim is operator-owned. Doctor checks unit files only, not the slice or redis. | `redis-cli info memory`, `config get save`; `systemctl list-timers`; `infra/vps/README.md:63-72,111`; `docs/runbooks/disk-pressure.md:43-127` |

## Build Plan citable index — delta (same ids as uplift-2 CONTEXT.md L39-57, plus)

Both Notion pages re-read 2026-10-13 (v0.2 last edited 2026-09-30T02:08Z, v0.3 Addendum 2026-09-30T04:36Z; unchanged since uplift-2).

| Id | Where | Statement not yet covered |
|---|---|---|
| BP-5.3 | v0.2 §5.3 | `"ttl": "graph \| 30d \| permanent"` — reads do not honour it |
| BP-5.0 | v0.2 §5.0 | "Cross-session recall feeding `memory.brief`" — the brief has only index/ledger sources |
| BP-7 | v0.2 §7 | hourly Merkle root — timer not scheduled on the host; coverage not observable |
| DP-ret | `docs/data-planes.md` L24 | "180 days hot, then export" — export is manual, unverified |
| DP-cache | `docs/data-planes.md` L26 | "Rate counters … stay a target" — C8 |
| A-3 / A-7 #3 | v0.3 §3, §7 | OTLP + SLO dashboards: no sink, no history, no alert |
| A-4 / A-7 #5 | v0.3 §4, §7 | session-open `memory_brief` + etag, explicit degraded; connector smoke `memory_brief(surface=grok-bot)` |
| A-5 | v0.3 §5 | "Chaos smoke in CI" — CI runs tests/locks only; `tenant=swc` (C9) still open |
| A-1 | v0.3 §1 | "Seats must handle all four verdicts", provenance/decay — decay exists; lifetime does not |

## Ambiguities resolved from evidence

| Q | Resolution | Evidence |
|---|---|---|
| Build Plan source | Notion via the session's MCP (both pages fetched); `docs/data-planes.md` supersedes the plan's Data section | fetch ids above; `docs/data-planes.md:3-6` |
| Grok Bot code | external (programming-desk desk-gateway, grok-hermes-connector); this repo owns the server side of the `grok-bot` surface. Bot-side items are limited to the substrate boundary: contracts, metadata, smoke, docs | `docs/grok-bot.md:3-11` |
| Railway authority | repo changes + VPS runtime operations the operator asked for (deploy); Railway dashboard/variables stay operator steps | uplift-2 decision, deploy session 2026-10-13 |
| Validation environment | production read-only for baselines; scratch Postgres 16 container for DB-backed tests; rehearsal twin only if an item needs a live Greptime | uplift-2 practice |
| Tie-break | balanced per baseline: the live measurements above (not a single dimension) order the seven | BASELINES.md |
| Destructive changes | none in this series; every data-reducing or enforcing policy ships behind an opt-in flag whose default preserves today's behaviour and reports instead | PROPOSAL.md per item |

## Conventions that bound the work

Unchanged from uplift-2 (`.planning/uplift-2/CONTEXT.md:69-71`): `bunx tsc --noEmit`, `bun test` (F-01 recorded), `bun run check:phase-close`, `bun run test:py`; store lock (Greptime SQL only in `greptime.ts`/`brief.ts`; memory tables only via `index-store.ts`/`memory-write.ts`); EVENT_KINDS 12 / SURFACES 27 closed (new signals reuse `note`/`warning`); new REST/MCP writes need a `packages/audit/src/policy.ts` entry; no `GREPTIME_`/`HINDSIGHT_` tokens in `.ts` outside `packages/mcp-server/src`; merge path PR → CI `verify` → Greptile 5/5 → `ultrathink-ship` squash; deploy via `infra/vps/deploy-release.sh`.
