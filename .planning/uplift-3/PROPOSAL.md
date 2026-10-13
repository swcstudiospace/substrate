# Uplift 3 — seven improvements, proposed 2026-10-13

Scope and rules as in [CONTEXT.md](CONTEXT.md); numbers from [BASELINES.md](BASELINES.md). Every item is additive, flag-gated with a default that preserves today's behaviour (or reports instead of enforcing), independently revertible, and measurable on `/slo`, `/metrics` or `/healthz`. Nothing deletes or expires production data; the two items that touch lifetime (N4) and archive (N6) ship in report/dry-run mode and leave the destructive switch to the operator.

## Why these: the measured problem

Uplift-2 made the brief fast and the planes guarded; what is left is **durability of the evidence and enforcement of the policies the Build Plan already states**: SLO history vanishes on every restart and nothing alerts; memory TTLs are declared but never honoured on read; the ledger has no verified archive, so its 180-day TTL cannot be switched on; anchoring is not scheduled and nobody can see that; the cache still has no admission budgets; RAGFlow retrieval is sequential and unmeasured; the Grok Bot contract (etag + explicit degraded) is not carried through MCP nor proven by a connector smoke; and the host's declared runtime policy (redis limits, timers) drifted from what runs, silently.

## Candidates considered (16) and ranking

Score = Build-Plan alignment × impact ÷ risk (1–5 each). Selected = top 7 under the coverage rule (every plane, the Grok Bot and the VPS runtime touched at least once; no two items share a mechanism).

| # | Candidate | Align | Impact | Risk | Score | Decision |
|---|---|---|---|---|---|---|
| K3 | Restart-durable SLO history + capacity runway + ledger-native breach/breaker notifications | 5 | 4 | 2 | 10 | **N2** |
| K9 | Grok connector contract smoke (A-7 #5) + MCP `memory_brief` metadata (etag/state) + per-surface brief SLO and 304 counters | 5 | 4 | 2 | 10 | **N7** |
| K11 | Runtime drift & jobs doctor (slice/unit/redis/timers/disk/swap vs declared policy), optional timer emitting `warning` events | 3 | 3 | 1 | 9 | **N1** |
| K2 | Per-surface admission budgets (C8): atomic token bucket in redis, 429 + Retry-After, shadow mode first | 4 | 4 | 2 | 8 | **N3** |
| K7 | Docs retrieval: parallel dataset fan-out under one budget, outcome/provenance metrics, offline golden-question harness (C12 two-tier) | 4 | 4 | 2 | 8 | **N5** |
| K1 | Memory lifetime enforcement: one expiry predicate honoured by brief/search/recall-forward, report → enforce | 5 | 4 | 3 | 6.7 | **N4** |
| K4 | Ledger coverage probe (anchors, archive) + verified off-box archive with manifests, before any TTL | 5 | 4 | 3 | 6.7 | **N6** |
| K8 | Hindsight outbox delivery gauges + read-only bank inventory vs `HINDSIGHT_BANKS` | 4 | 3 | 2 | 6 | backlog (N1 reports the legacy key; outbox has never parked an entry) |
| K14 | Generation-keyed concurrent-miss coalescing in the cache | 3 | 3 | 2 | 4.5 | backlog (measure first with N2's per-class cache attribution) |
| K12 | Chaos smoke in CI (A-5) as an isolated rehearsal job | 4 | 3 | 3 | 4 | backlog (CI runs on this VPS: disk 94 %, shared desktop lock port; needs a runner decision) |
| K13 | Usage coverage / per-surface spend views | 3 | 3 | 3 | 3 | backlog (no producer sends `usage`; external) |
| K10 | Budgeted recall-to-brief snapshot (BP-5.0 / C10) | 4 | 3 | 4 | 3 | backlog (prompt assembly is external; brief p95 just recovered) |
| K6 | Snapshot-backed sweep-apply gate (Railway API) | 4 | 3 | 4 | 3 | backlog (needs a Railway token on the host) |
| K15 | Governed-memory lifecycle reconciliation / locator-scoped purge across index + Hindsight | 4 | 3 | 5 | 2.4 | backlog (destructive; after N4) |
| K16 | `tenant=swc` on every row (C9) | 3 | 1 | 4 | 0.75 | backlog |
| K5' | Gateway docs cutover to substrate `docs_search` (A-4) | 5 | 3 | — | — | out of repo (programming-desk); recorded as a dependency in N7's docs |

## The seven

### N1 — Runtime drift and jobs doctor
- **Build Plan:** BP-1 (host constraint), A-5 (runbooks), A-7 #3.
- **Problem / evidence:** the declared runtime policy and the running host disagree silently: redis `maxmemory 0`/`noeviction`/RDB snapshots on a 94 % disk although R7 ships `redis-substrate.conf`; `substrate-anchor.timer` and `substrate-index-sweep.timer` not found; no watchdog or health timer; `scripts/doctor-units.ts` checks unit files only (CONTEXT.md VPS row).
- **Design:** `scripts/doctor-runtime.ts` (`bun run doctor:runtime`), read-only: effective `systemctl show` of every `substrate-*` unit and the slice vs the unit files in `infra/vps/` (Slice, MemoryMax, TasksMax, Environment names), redis `INFO`/`CONFIG GET` vs `redis-substrate.conf` (maxmemory, policy, save, appendonly), timer inventory (expected: anchor, index-sweep; state installed/enabled/last run), disk reserve vs `SUBSTRATE_DEPLOY_MIN_FREE_GB`, swap `si/so` from `/proc/vmstat` deltas, legacy env keys by **name** (`HINDSIGHT_BANK`). Output: table + non-zero exit on drift; `--json`. Optional `substrate-doctor.timer` (6 h, disabled by default) runs it and emits one deduplicated `warning` event per drift class to the ledger (the brief surfaces warnings), gated by `SUBSTRATE_DOCTOR_EMIT=1`. Never prints values of env files or tokens.
- **Resource impact:** none on the request path; makes the R7 redis limits and BP-7 anchoring observable so the operator applies them.
- **Risk / rollback:** read-only; timer off by default; delete the unit to roll back.
- **Verification:** unit tests on parsing/compare with fixture `systemctl show`/`INFO` output; smoke on the VPS reports today's three drifts (redis, anchor timer, sweep timer).
- **Effort:** S/M. No deps.

### N2 — Restart-durable SLO history, capacity runway and ledger-native notifications
- **Build Plan:** A-3 (SLOs), A-7 #3 (SLO dashboards), BP-2 (storage constraint), BP-5.4.
- **Problem / evidence:** every deploy zeroes `brief.p95` (n 0 at 21:33Z) and the plane/burn windows; `/slo.breached` omits plane and burn breaches; no notification exists; capacity is a point read. Exporter has no sink and Greptime OTLP needs protobuf (CONTEXT.md observability row).
- **Design:** (a) `packages/observability` checkpoints histogram/counter aggregates and the plane/burn buckets to `/var/lib/substrate/slo-checkpoint.json` every `SUBSTRATE_SLO_CHECKPOINT_S` (default 60) with a process epoch; on boot it restores and marks series `since`; `/slo` gains `history: {epochs, since}` and a top-level `breached` that includes planes and burn. (b) `capacity.index.runway_days` SLO from a bounded ring of `databaseBytes` samples (bytes/day → days to `SUBSTRATE_INDEX_VOLUME_BYTES` when set) plus `index.pool.wait_p95` from the existing pool timing. (c) a transition evaluator: sustained breach / breaker open / recovery → one `warning` event per transition (kind reused, surface `substrate`, payload with objective, observed, target) with durable dedupe in the checkpoint, behind `SUBSTRATE_SLO_NOTIFY=1`; optional `SUBSTRATE_SLO_WEBHOOK_URL` POST with the same redacted payload.
- **Resource impact:** one small file write per minute; evidence survives restarts, so the 7-day operator rows become readable from the server.
- **Risk / rollback:** checkpoint corruption → start fresh (logged); flags off → today's behaviour.
- **Verification:** tests for checkpoint round-trip across a simulated restart (no false green, no double burn), breached aggregation, transition dedupe; VPS smoke after deploy: `/slo.history.epochs ≥ 2`, pre-restart samples retained.
- **Effort:** M. Feeds N1 (doctor reads the checkpoint age) and N7 (per-surface SLO rows).

### N3 — Per-surface admission budgets (C8), shadow first
- **Build Plan:** DP-cache ("rate counters … a target"), A-5, BP-5.0 (Grok Bots call substrate tools only).
- **Problem / evidence:** no admission control; one noisy surface can spend the brief budget of another; MCP batches are costed as one request (CONTEXT.md cache row).
- **Design:** `packages/mcp-server/src/admission.ts`: token bucket per authenticated surface × class (`read`, `write`, `coordination`), one atomic Lua `EVAL` (refill, check, debit, `PEXPIRE`) through the existing cache client and plane gate; anonymous bridge callers share one bounded bucket; monitor GETs exempt; coordination (heartbeat/release) reserved so heavy reads never cause lease loss; MCP batch cost counted at the parsed pre-audit seam. Decision → `429` + integer `Retry-After` + bounded JSON error, before handler and audit. Cache off/open/down → admit and count `bypass`. Modes `SUBSTRATE_BUDGETS=off|shadow|enforce` (default `shadow`: decide, record, never refuse); limits per class via `SUBSTRATE_BUDGET_<CLASS>_RPS`/`_BURST` with per-surface overrides. Metric `substrate.admission.decisions{surface,class,decision}`; `/slo` row `admission.limited_rate` (insufficient-data until enforce).
- **Resource impact:** < 1 ms per request on loopback; bounds downstream load on all five planes under a storm.
- **Risk / rollback:** shadow by default; `off` restores today; counters always expire.
- **Verification:** Lua bucket tests against a real redis in CI (the scratch container pattern) and the fake; server tests for precedence (401 → 429 → handler), batch rejection, bypass on open breaker; VPS smoke in shadow mode shows decisions for grok-bot/omp.
- **Effort:** M. No deps.

### N4 — Memory lifetime enforcement (report → enforce)
- **Build Plan:** BP-5.3 (`ttl: graph | 30d | permanent`), A-1 (provenance + decay), DP-ret.
- **Problem / evidence:** `30d` and `graph` entries are served forever; the sweeper's `entries-ttl-30d`/`entries-ttl-graph` classes are report-only because nothing agrees on expiry (CONTEXT.md index row).
- **Design:** one predicate `memoryExpiry(entry, graphStatus, now)` in `memory-policy.ts` used by `memoryForBrief`, `memory_search`/`memory_history` and the retain-forward eligibility; mode `SUBSTRATE_MEMORY_EXPIRY=report|enforce` (default `report`: entries still served, counted in `substrate.memory.expired_served{surface,kind}` and listed as `expired` in search results' metadata). In `enforce`, expired entries are excluded from default reads (opt-in `include_expired` for operators), cache refresh deadlines align with the nearest expiry, and the two sweep classes become deletable (still under the existing dry-run default). No row is deleted by this item.
- **Resource impact:** fewer rows in briefs/search for long-lived repos; smaller recall forwards; enables the only index reduction that BP-5.3 allows.
- **Risk / rollback:** `report` by default; `enforce` is one env var; sweep apply stays separately gated.
- **Verification:** policy tests on every TTL class and graph status; DB-backed tests that `enforce` hides and `report` counts; sweep tests that the classes delete only under `enforce`.
- **Effort:** M. No deps (N2 displays the counter).

### N5 — Docs retrieval fan-out, outcome metrics and an offline golden-question harness
- **Build Plan:** A-4 ("Docs: only substrate `docs.search`"), BP-5.1, A-3.
- **Problem / evidence:** retrieval is sequential per dataset (3 datasets = up to 12 s worst case) and the only metric is per-call plane latency; no zero-hit or citation-coverage signal; C12 open (CONTEXT.md RAGFlow row).
- **Design:** (a) `searchDocs` retrieves all datasets concurrently under one shared budget (`SUBSTRATE_DOCS_SEARCH_BUDGET_MS`, default 4000) with per-dataset failure isolation (a timed-out dataset degrades that dataset, not the reply). (b) bounded metrics `substrate.docs.search{surface,outcome=hit|empty|degraded,cached}` and `substrate.docs.citations{provenance=recorded|unrecorded}`; `/slo` row `docs.search.p95`. (c) `scripts/docs-golden.ts` + `fixtures/docs-golden/*.json` (question, datasets, expected source URLs/commits, grades) run offline in `bun test` against `RagflowFake` with question-aware scripted chunks — proving scorer, ordering, scope isolation, redaction, provenance and cache invalidation — and `--live` (opt-in, operator-attested corpus manifest) through substrate `/docs/search` only.
- **Resource impact:** docs p95 bounded by the slowest dataset instead of the sum; zero-hit visibility for the grok-bot surface.
- **Risk / rollback:** concurrency bounded to the dataset count (≤ 3); budget env; harness is test-only.
- **Verification:** fake-backed tests for fan-out/isolation/budget; golden fixtures in CI; VPS smoke on `docs.search.p95` after deploy.
- **Effort:** M. No deps.

### N6 — Ledger coverage probe and verified archive before TTL
- **Build Plan:** BP-7 (hourly Merkle root), DP-ret ("180 days hot, then export"), A-5.
- **Problem / evidence:** anchoring is not scheduled and no surface shows coverage; the export that must precede `SUBSTRATE_LEDGER_TTL` is a manual, unverified runbook (CONTEXT.md ledger row).
- **Design:** `substrate ledger coverage` (and `/healthz.jobs.ledger`): newest anchored closed hour, lag, uncovered eligible hours, last archive window; `substrate ledger archive --until <day> --out <dir>`: exports closed days as NDJSON (events, first-ingest membership, anchor receipts) with a manifest (count, first/last `(ts,id)`, chain tip, per-hour roots) in bounded pages through `greptime.ts` only; `substrate ledger verify-archive <dir>` recomputes hashes, chain continuity and RFC 6962 roots offline. Optional `substrate-ledger-archive.timer` (daily, disabled by default) writing to `SUBSTRATE_LEDGER_ARCHIVE_DIR` (operator-mounted off-box path; refuses the VPS root when free space < floor). TTL remains the operator's switch, now with `coverage` as its precondition.
- **Resource impact:** enables the 180-day TTL (storage on Railway) with proof; VPS writes only to the operator's archive path.
- **Risk / rollback:** read-only + export; timer off by default; archive dir refused below disk floor.
- **Verification:** tests against the Greptime fake for paging/continuation/manifest/verify; rehearsal twin run exporting and verifying one day; coverage probe output on the VPS.
- **Effort:** L. No deps (N1 reports timer presence).

### N7 — Grok connector contract: smoke, MCP brief metadata, per-surface SLO
- **Build Plan:** A-4 (session open: `memory_brief` • etag, explicit degraded), A-7 #5 (connector smoke `memory_brief(surface=grok-bot)`), A-3.
- **Problem / evidence:** MCP `memory_brief` returns text only; the gateway cannot see `etag`/state; no per-surface SLO; no connector smoke; grok-bot briefs 0 in this process (CONTEXT.md Grok row).
- **Design:** (a) MCP `memory_brief` structured content gains `etag`, `state`, `failed_sources`, `snapshot_at` (text unchanged) and accepts `if_none_match` → `not_modified: true` with the etag and no text. (b) `scripts/grok-connector-smoke.ts` (`bun run smoke:grok`), opt-in, read-only, with the grok-bot bearer from `SUBSTRATE_TOKENS_DIR`: MCP `memory_brief(surface=grok-bot)` must answer ≤ 1500 ms with explicit state; REST `/brief` then conditional `/brief` → 304; reports unavailable/degraded/green separately; never writes. (c) per-surface brief rows in `/slo` (`brief.p95{surface}` for surfaces with ≥ 20 samples) and bounded counters `substrate.brief.result{surface,state,result=fresh|not_modified}`. `docs/grok-bot.md` records the gateway adoption steps (conditional POST, header propagation, docs via substrate) as the external dependency.
- **Resource impact:** 304s for the bot save the 20 KB brief transfer per unchanged turn; the SLO shows the bot's own p95 instead of a blend.
- **Risk / rollback:** additive fields; smoke is opt-in; `/slo` rows appear only with data.
- **Verification:** MCP contract tests, smoke tests against the harness, VPS smoke run with the real bearer.
- **Effort:** M. Benefits from N2 (per-surface rows survive restarts).

## Execution plan

Wave A (file-disjoint, parallel): N1 (`scripts/doctor-runtime*`, `infra/vps/substrate-doctor.*`), N3 (`admission.ts`, server seam), N4 (`memory-policy.ts`, `index-store.ts` reads, sweep classes), N5 (`docs-search.ts`, `planes/ragflow.ts`, golden fixtures), N6 (`packages/cli` ledger commands, `greptime.ts` paging seams). Wave B (after A, both touch `/slo`, `observe.ts`, `instruments.ts`): N2 then N7 (N7 reads N2's per-surface series). Verification per wave: `bunx tsc --noEmit`, `bun test` with a scratch Postgres, `bun run check:phase-close`, `bun run test:py`; a rehearsal twin only for N6's archive run. Then PR → CI → Greptile 5/5 → `ultrathink-ship` merge → tag → `deploy-release.sh` → post-deploy readings into BASELINES.md.

## Backlog note (not implemented this series)

K8 outbox gauges + bank inventory, K14 miss coalescing, K12 chaos in CI, K13 usage coverage, K10 recall-to-brief, K6 snapshot-backed sweep gate, K15 lifecycle purge, K16 `tenant=swc`; gateway docs cutover (programming-desk). Operator rollout debt surfaced by recon and reported by N1: install the R7 redis conf/drop-in, install and enable `substrate-anchor.timer` (needs the devnet ledger file already present in `/etc/substrate`), install `substrate-index-sweep.timer` in dry-run, set `HINDSIGHT_BANKS`.

## Progress log

| Item | Status | Gates | Notes |
|---|---|---|---|
| proposal | presented 2026-10-13 | — | awaiting acceptance |
