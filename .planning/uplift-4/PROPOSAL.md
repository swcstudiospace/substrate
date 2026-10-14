# Uplift 4 — seven improvements, proposed 2026-10-14

Graph `ut-mv7ciy6p-4429f130` (Notion task https://app.notion.com/p/3f9bc1a0c7ae81d7839bdda1bf8b91be; nodes n1 SPE-11083 … n8 SPE-11090). Recon: 8 read-only lanes (A Timescale · B Greptime · C cache · D Hindsight+RAGFlow · E VPS · F Grok Bot · G Build Plan gap audit · H Greptile history), reports kept in the session; every claim below cites a file:line the lanes read, a probe run on 2026-10-14, or is marked [INFERENCE].

Standing rules (unchanged since uplift-2): every policy ships behind a flag whose default preserves today's behaviour or only reports; nothing deletes production data; Railway variables, units, timers and live mutations are operator steps; cost-neutral (no new service, replica or plan tier); EVENT_KINDS 12 / SURFACES 27 stay closed; Greptime SQL only in `greptime.ts`/`brief.ts`; memory tables only via `index-store.ts`/`memory-write.ts`.

## Why these: the measured problem

Uplift-1..3 delivered the guard rails (breakers, budgets, archive, SLO history, drift doctor) — PR #61 (uplift-3) is still being landed. What the Build Plan still lacks is **use of each plane for what it is for, on this VPS, for the Grok Bot**:
- The Grok Bot's brief has **no total cap** (memory text up to 8 × 4,000 B plus an unbounded `Nodes:` line; the gateway cuts blindly at 20,000 chars), the gateway sends `repo=None` so the bot never sees recent actions or other graphs, and it **drops the `X-Substrate-Brief` state and ETag**, so a degraded brief reads as a healthy one (`brief.ts`, `upstreams.py:388-403` of the sibling desk gateway).
- The TimescaleDB index is the **system of record for memory** (BP-5.0) with **no verified backup** — only a manual Railway volume snapshot before a sweep (`docs/runbooks/quarantine-spike.md:119-121`); 500 MB volume (`.planning/uplift-2/CONTEXT.md:14`).
- One `memory_write` bumps `gen:memory`, which changes **every** brief key for every surface and argument set; each miss re-runs four source reads under a 1,200 ms deadline, with no single-flight and no stale-while-revalidate (`cache.ts` getOrLoad, `service.ts:1150-1190`). Live 2026-10-14: `brief.p95` 759 ms against the 800 ms SLO (n 67, the verdict rests on the 400–800 ms bucket) and cache hits 20 / misses 47 (30 %).
- BP-5.0 "Hindsight cross-session recall feeding memory.brief" is **not implemented** (the brief has four sources, none Hindsight; `brief.ts:41,156-166`), and Hindsight has no inventory, no outbox gauge, no drift report.
- Metrics history lives only in a local checkpoint; the OTLP exporter is JSON-only and Greptime's OTLP endpoint needs protobuf (`otlp.ts:1-5`), so no SLO history is queryable off the box (A-3, A-7 #3).
- RAGFlow has a golden harness that proves the pipeline offline but nothing detects a **stale corpus** or a merge-trigger that fired without an ingest (`docs-datasets.ts`, `docs-golden.ts`).
- The VPS runs at load 10 on 8 vCPU with 12.8 GiB of swap held by co-tenant `omp` processes, equal CPU/IO weight for every cgroup (`CPUWeight`/`IOWeight` unset), no watchdog (`WatchdogUSec=0`), a 330 MB uncapped journal and 94 % disk (all probed 2026-10-14).

## The seven (ranked by impact ÷ risk)

### S1 — Grok brief contract: compact, state-carrying profile and an estimated-spend SLI
- **Resource:** Grok Bot (`grok-bot`, `grok-build`) · **Build Plan:** A-4 session open (`memory_brief` + etag, explicit degraded), A-3 (tokens/cost per surface), BP-5.4.
- **Design:** `BRIEF_PROFILES = {full, compact}`, chosen from the bearer's surface (no gateway change). Compact: priority-ordered sections (state line, graph status, Warnings, Decisions, live/held Nodes ≤ 12, recent actions, other graphs), per-line clip, hard cap `SUBSTRATE_BRIEF_COMPACT_BYTES` (default 3,500 B ≈ 900 tokens), whole-line deterministic truncation with a final `…omitted: …` line, a first line `[brief: degraded; failed: memory]` so the state survives a header-dropping gateway, ETag per profile. Mode `SUBSTRATE_BRIEF_PROFILE=off|shadow|enforce`, default **shadow**: compute the compact variant, record `substrate.brief.profile_bytes_saved{surface}`, serve full. New separate counter `substrate.served.tokens_est{surface,tool}` (bytes/4, labelled estimated, never added to the model-reported `substrate.tokens`) and a `served.tokens_est` row per surface on `/slo`.
- **Evidence → target:** worst case ≈ 32 KB + unbounded Nodes line, blindly cut at 20 KB → compact p95 ≤ 3.5 KB (≥ 80 % smaller worst case), degraded state visible to the model; the `/slo` row gives the bot's own cost per hour (today `substrate.tokens` has 0 points).
- **Failure / security:** profile errors fall back to full text; no new auth surface; redaction path unchanged. **Rollback:** `SUBSTRATE_BRIEF_PROFILE=off`.
- **Files:** `brief.ts`, `service.ts`, `mcp.ts`, `server.ts`, `packages/observability/src/instruments.ts`, `slo.ts`, `docs/grok-bot.md`. **Effort:** M · **Risk:** low (shadow first) · **Depends on:** S4 merged for the `briefDetailed` call site.

### S2 — Index disaster recovery: verified logical export, offline verify, restore-to-scratch
- **Resource:** TimescaleDB (index) · **Build Plan:** BP-5.0a/BP-3.2 (system of record for memory), A-5 reliability, DP-ret "export".
- **Design:** new `index-archive.ts`: `substrate index archive` streams every governed and graph table as NDJSON in one REPEATABLE READ transaction (key-ordered pages) to the operator's mounted archive path, writes a manifest last (table counts, sha256, schema hash, `migrate()` column list, server version, release sha) and a ledger `note`; `substrate index verify-archive` is offline (hashes, counts, parse); `substrate index restore --scratch <url>` refuses the production URL, runs `migrate()` on the scratch database, loads in FK order and compares counts and the `entry_hash` row-hash. Reuses uplift-3 N6 patterns (mount guard, disk floor, closed mismatch vocabulary). Plus visibility only for lease-table bloat: `hot_update_ratio` and dead-row ratio in `/healthz.capacity`; the `fillfactor`/autovacuum DDL ships behind `SUBSTRATE_INDEX_TUNE=apply` (off).
- **Evidence → target:** verified backups today: **0**; target: restore-to-scratch passes (counts + hash) in CI and `substrate.index.archive.age` ≤ 26 h once the staged timer is installed. Hypertables, continuous aggregates and compression were evaluated and **rejected on evidence**: no table has a time column in its key, `graph_nodes` is an FK target, and the whole index is 11.9 MB (`index-store.ts:307-465`, `BASELINES.md:25`).
- **Failure / security:** read-only against production; refuses an archive path on the root filesystem; no credentials in archives beyond what the tables hold (memory text is already redacted on write). **Rollback:** uninstall the staged timer.
- **Files:** `index-archive.ts` (+test), `index-store.ts`, `packages/cli/src/index.ts`, `infra/vps/substrate-index-archive.{service,timer}`, `docs/runbooks`. **Effort:** M · **Risk:** low · **Depends on:** PR #61 merged (N6 helpers).

### S3 — VPS runtime hardening: priority and swap isolation, hang detection, disk guardrails
- **Resource:** VPS · **Build Plan:** BP-1 (host constraint), BP-2, A-5 runbooks, N-OPS (watchdog missing).
- **Design:** (a) `substrate.slice` `CPUWeight=300`, `IOWeight=300`, `ManagedOOMPreference=avoid`; `substrate-mcp` `MemorySwapMax=0` (RSS ≈ 53 MB while co-tenants hold 12.8 GiB of swap); doctor rows compare declared vs effective. (b) pure `GET /livez` (event-loop lag + uptime, no store I/O) and an opt-in `watchdog.ts` that sends `READY=1`/`WATCHDOG=1` only when the loop heartbeat and a loopback `/livez` agree; shipped as a **drop-in example** (`Type=notify`, `WatchdogSec=30`, `OnFailure=substrate-alert@%n`), never in the main unit; the alert unit lands one `warning` ledger event through the doctor's emit path. (c) disk: hardlink-aware release accounting (a plain `du` mis-charges shared inodes — probed: both releases show `node_modules` 2.9 G, the second only 26 M when counted once), a journald cap drop-in (329.6 MB uncapped today), per-state-dir budgets with `would-reclaim` lines and `deploy-release.sh --dry-run`. Nothing is deleted by code.
- **Evidence → target:** `CPUWeight`/`IOWeight`/`MemorySwapMax` unset; `WatchdogUSec=0`; journal uncapped; `/` 94 % used (26 GB free vs a 5 GB deploy floor) → declared values equal effective values on the doctor, a hung loop restarts the unit within 30 s and lands one `warning`, and the disk report names reclaimable bytes per owner.
- **Failure / security:** `/livez` is loopback-only and store-free (a Railway blip cannot restart a healthy process, which is why `/healthz` is not the gate); `IOWeight` only bites under BFQ/io.cost [INFERENCE, not verified live]. **Rollback:** remove the drop-ins, `daemon-reload`.
- **Files:** `infra/vps/substrate.slice`, `infra/vps/substrate-mcp.service.d/*` (examples), `infra/vps/journald-substrate.conf`, `scripts/doctor-runtime.ts`, `packages/mcp-server/src/watchdog.ts` + `server.ts` (`/livez`). **Effort:** M · **Risk:** low (opt-in, operator-installed) · **Depends on:** none.

### S4 — Cache: single-flight, stale-while-revalidate and per-class metrics on the loopback redis
- **Resource:** DragonflyDB / loopback redis · **Build Plan:** A-5 (degraded mode, brief SLO), DP-cache, BP-5.0e.
- **Design:** inside `getOrLoad`, an in-process `Map<key, Promise>` single-flight (identical concurrent misses → one load; always on, behaviour-preserving) and a **stale-while-revalidate** window (`SUBSTRATE_CACHE_SWR=off|shadow|enforce`, default shadow): after a generation bump, serve the last-good value younger than the window immediately and refresh in the background (one refresh per key), advertised by an additive `x-substrate-brief-age` header / `age_s` (the `complete|degraded|snapshot` vocabulary is untouched). Class-labelled metrics `substrate.cache.operations{class,result=hit|miss|coalesced|stale|refresh}`; `substrate cache stats` (bounded SCAN, `STRLEN`-portable) reports key-class counts, bytes and ratios and a data-driven `maxmemory` recommendation. The idle Railway Dragonfly is documented as unused (operator decision to decommission); the repo's `volatile-lru` invariant for generation and budget counters is **not expressible on Dragonfly**, so the VPS cache stays redis (`redis-substrate.conf:19-30`).
- **Evidence → target:** one write invalidates every surface's brief; each miss = 4 source reads ≤ 1,200 ms; live `brief.p95` 759 ms (n 67) and cache 20 hits / 47 misses → under an injected 8-surface bump storm, stale-served p95 ≤ 50 ms and loads per distinct key = 1; shadow numbers `would_serve_stale` readable before enforcing, then a live hit ratio above today's 30 %.
- **Failure / security:** staleness bounded by the window, read-your-writes preserved while `shadow`/`off`; cache errors stay fail-open. **Rollback:** `SUBSTRATE_CACHE_SWR=off`.
- **Files:** `cache.ts`, `service.ts` (call-site options), `packages/observability/src/instruments.ts`, `scripts/cache-stats.ts`, `docs/data-planes.md`. **Effort:** M · **Risk:** low–medium · **Depends on:** none.

### S5 — Cross-session recall in the brief (BP-5.0): warm snapshot plus Hindsight inventory and gauges
- **Resource:** Hindsight · **Build Plan:** BP-5.0d "Hindsight cross-session recall feeding memory.brief", A-4.
- **Design:** a bounded prefetcher (timer + post-retain hook `afterLiveRetain`) runs one `recallBank` on the surface's **own** bank only (`budget: low`, `max_tokens ≤ 400`, query from repo + decision/warning subjects, post-filtered by `metadata.scope`, redacted, ≤ 3 hits) into a generation-free cache class `recall-snapshot` (TTL ≈ 900 s). `composeBrief` receives an injected `peekRecall` (cache read only) and appends a "Recalled context (derived, Hindsight, age …)" section — so `brief.ts` still never imports the plane and the existing gate in `memory-recall.test.ts` stays true. Read-only inventory: `listBanks`/`bankStats`/`bankConfig` GETs on a 60 s probe, gauges `retain_outbox{size,oldest_age_seconds}` and per-bank `fact_count`/`pending_operations`/`failed_operations`, and a drift report (`HINDSIGHT_BANKS` entries missing upstream, `sub-*` banks upstream but unconfigured, extraction mode ≠ `chunks`). Mode `SUBSTRATE_BRIEF_RECALL=off|shadow|enforce`, default shadow (compute and count, do not append).
- **Evidence → target:** recall is explicit-only today (`mcp.ts:417-433`, `server.ts:941`, `service.ts:1561`), no `listBanks` exists, outbox stats are not exported → `substrate.brief.recall{surface,result=included|cold|stale|disabled}` ≥ 80 % `included` for active surfaces after warm-up with `brief.p95` unchanged (peek adds a cache read, no plane call).
- **Failure / security:** a cold or failing snapshot simply omits the section; bank isolation is structural (own bank only, never `HINDSIGHT_BANKS` fan-out); plan mode writes nothing to Hindsight. **Rollback:** `SUBSTRATE_BRIEF_RECALL=off`.
- **Files:** `recall-snapshot.ts` (new), `brief.ts`, `service.ts`, `planes/hindsight.ts`, `observe.ts`/`server.ts` (gauges, `/healthz` extra). **Effort:** M · **Risk:** medium · **Depends on:** S1 and S4 merged (profile cap must include the new section; cache class).

### S6 — GreptimeDB: durable, queryable metrics history with a TTL
- **Resource:** GreptimeDB · **Build Plan:** A-3, A-7 #3 (OTLP + SLO dashboards), BP-7.
- **Design:** a `metric_samples` table (`ts` TIME INDEX, name, labels, kind, value, count; `append_mode`, `'ttl'='14d'` in `CREATE`) written from `greptime.ts` as one multi-row `INSERT` per interval (default 60 s) for an allow-list of ~12 SLO/plane series, breaker-gated and fail-open with a counted drop; bounded readback `GET /slo/history?series=&window=` (aggregated, unauthenticated like `/slo`). Chosen over an OTLP protobuf encoder (Greptime requires protobuf; JSON is not accepted) and Prometheus remote-write (snappy) because it keeps the store lock, needs no dependency and no wire-format risk. `SUBSTRATE_METRICS_HISTORY=off|on`, default off.
- **Evidence → target:** SLO windows reset to `n 0` on every restart (`BASELINES.md:18`), exporter has no sink → 7–14 days of `brief.p95`, plane availability and cache ratios readable after any restart; ≈ 17 k rows/day (≈ 240 k rows at 14 d, estimated 10–25 MB) on a volume recorded as 500 MB in one place and 5 GB in the Notion plan (**conflict flagged for the operator**).
- **Failure / security:** Greptime down → samples dropped and counted, no request-path cost; no labels beyond the existing bounded set (no prompt or payload text). **Rollback:** env off; `DROP TABLE` stays an operator action.
- **Files:** `greptime.ts` (+test), `observe.ts`, `config.ts`, `server.ts`, `docs/observability.md`. **Effort:** M · **Risk:** low · **Depends on:** PR #61 merged (N2 snapshot hook).

### S7 — RAGFlow: docs freshness SLI, trigger-lag detection and an opt-in live golden canary
- **Resource:** RAGFlow · **Build Plan:** BP-5.1, DP-docs ("re-ingest on merge"), A-4 docs path, A-3.
- **Design:** `docs.freshness_seconds{dataset}` from the persisted `versions[].ingested_at` (offline, no RAGFlow call) with a report-only staleness threshold; `POST /docs/merge-trigger` records `received_at`, so "trigger accepted but ingest not recorded within N minutes" becomes the true lag SLI (HEAD is not knowable in-process; only the hook sees it); `/slo` row `docs.freshness`; a `warning` event on first breach per dataset; an opt-in **live** canary (`SUBSTRATE_DOCS_CANARY=1`, operator-attested corpus manifest) that runs the golden questions through `POST /docs/search` on a staged timer and emits `warning` on regression. The offline harness stays a CI proof of the pipeline, not of relevance.
- **Evidence → target:** only `plane.duration{ragflow}` exists; a silent merge-trigger failure is invisible → freshness visible per dataset, a missed ingest flagged within the threshold, canary pass-rate recorded.
- **Failure / security:** all reads local; the canary is read-only against RAGFlow with the existing breaker; no new keys. **Rollback:** env off, uninstall the timer.
- **Files:** `docs-datasets.ts`, `service.ts`, `server.ts` (trigger bookkeeping), `slo.ts`, `scripts/docs-golden.ts`, `infra/vps/substrate-docs-canary.{service,timer}`. **Effort:** S/M · **Risk:** low · **Depends on:** none.

## Sequencing

Base: `main` after PR #61 (uplift-3) merges. Worktrees per item under `~/src/repos/.wt/u4-*`, integration branch `ultrathink/uplift-4`; subagents edit only, the orchestrator verifies once per wave.
- **Wave 1 (parallel):** S1, S2, S3, S4, S6, S7. Shared seams (`service.ts`, `server.ts`, `observe.ts`, `instruments.ts`, `slo.ts`, `.env.example`) are small hunks; every item writes its env block to `.planning/uplift-4/env-notes/NN.md` instead of editing `.env.example`/STATE.
- **Wave 2:** S5 (needs S1's profile cap and S4's cache class).
- **PRs:** A = infra and data planes (S2, S3, S6, S7); B = brief pipeline (S4, S1, S5). Each: CI `verify` → Greptile 5/5, no open threads → `ultrathink-ship` squash.
- **Gates:** `bunx tsc --noEmit`, `bun test` with the scratch Postgres (`SUBSTRATE_TEST_PG_URL`; F-01 recorded), `bun run check:phase-close`, `bun run test:py`; each item adds fault-injection tests and a smoke it names in its SUMMARY.

## Not selected (alternates in order) and operator decisions

Alternates: (1) durable event spool for collector and CLI emits (Build Plan A-5 "write outbox") — **not safe yet**: `EventInput` carries no client idempotency key, ids are assigned on ingest and the ledger is append-only, so a replay after a timed-out success would duplicate rows; needs a server-side idempotency key in the insert path first; (2) Greptime Flow rollups for the brief's recent-actions read (flownode availability on the Railway image unverified); (3) `skills_list`/`skills_approve` audit trail (A-4d, missing); (4) redis + Dragonfly docker conformance suite; (5) `tenant=swc` on every row (A-5f, missing — touches the hash, needs hash versioning), enforcement of `requires/blocks/gated_by` (A-2c, optional in the plan), chaos smoke in CI (runner decision).
Operator decisions surfaced, not made by code: the Railway Dragonfly (5 GB volume, unused, 180–310 ms RTT) — keep, repurpose or decommission; the Greptime volume size (500 MB vs the plan's 5 GB); installing the redis drop-in, anchor, index-sweep, doctor and archive timers (the doctor is dark until its timer exists).

## Acceptance and execution (as run)

| Step | Record |
|---|---|
| proposal | presented 2026-10-14 at the operator's "Approve proposals first" gate |
| acceptance | **all seven accepted** 2026-10-14 ("Accept all 7 and implement"); the same answer set **land PR #61 first** (uplift-3) |
| base | uplift-3 tip (`76c3f39`, later `45b5aba`) while #61 was in review; the series is rebased onto `main` once #61 squash-merges |
| branches | one worktree per item (`u4/s1` … `u4/s7`), two integration branches and two PRs: **A** `ultrathink/uplift-4a` = S2, S3, S6, S7 (infra and data planes, this folder's docs); **B** `ultrathink/uplift-4b` = S4, S1, S5 (brief pipeline, STATE and HANDOFF) |
| method | edit-only implementation agents; the orchestrator ran tsc, the full suite and the lock tests per item and committed; an independent read-only review of every item against the Greptile preflight (the defect classes of PRs 58-61) ran before merge and its findings were fixed |
| gates per item | `bunx tsc --noEmit` clean, `bun test` with a scratch Postgres, `bun run check:phase-close` |

## Progress log

| Item | Status | Gates | Notes |
|---|---|---|---|
| S1 | merged into PR B | see S1-SUMMARY.md | shadow by default; integrated with S4 (sections-encoded cache value, snapshot `{text, at, sections, until}`) |
| S2 | in PR A | tsc clean · bun test 3955 pass / 1 skip / 0 fail · live roundtrip against a scratch Postgres | staged timer, nothing installed |
| S3 | in PR A | see S3-SUMMARY.md | main unit gains `MemorySwapMax=0`; watchdog is an opt-in example drop-in |
| S4 | in PR B | tsc clean · bun test 3925 pass / 1 skip / 0 fail | single-flight always on; SWR shadow |
| S5 | in PR B | pending | after S1 and S4 |
| S6 | in PR A | tsc clean · bun test 3930 pass / 1 skip / 0 fail · SQL smoke against a scratch GreptimeDB | off by default |
| S7 | in PR A | tsc clean · bun test 3922 pass / 1 skip / 0 fail | report-only; canary off |
