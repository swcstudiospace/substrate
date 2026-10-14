# Uplift 5 — seven improvements, proposed 2026-10-14

Graph `ut-mv7mtq2j-b41cedcc` (Notion task https://app.notion.com/p/3f9bc1a0c7ae81eeaccbc39783bef373; nodes n1 SPE-11977 … n8 SPE-11984). Recon: nine read-only lanes (L1 VPS hardening · L2 flag promotion · L3 release gate · L4 skills governance · L5 dashboards · L6 durable events · L7 claim dependencies · L8 request path · L9 first-deploy risk); every claim below cites a file:line the lanes read, a probe run on 2026-10-14, or is marked [INFERENCE]. The auto-generated plan for this graph was partly boilerplate ("planning degraded"); where it differs from the repository, the repository wins.

Standing rules (unchanged since uplift 2): every policy ships behind a flag whose default preserves today's behaviour or only reports; nothing deletes production data; Railway variables, units, timers, drop-ins and live mutations are operator steps; cost-neutral (no new service, replica, plan tier or dependency); `EVENT_KINDS` 12 / `SURFACES` 27 stay closed; Greptime SQL only in `greptime.ts`/`brief.ts`; memory tables only via `index-store.ts`/`memory-write.ts`.

## Why these: the measured problem

Uplifts 1-4 delivered the guard rails (breakers, budgets, archive, SLO history, drift doctor, single-flight cache, recall in the brief). Uplifts 3 and 4 are **merged but not deployed**: production runs release `9231f43` (uplift 2). What remains is making the next deploy safe, making the shadow policies promotable on evidence, and tightening the three paths that still lose or waste work:
- **The next deploy ships two uplifts at once and nothing proves it first.** `deploy-release.sh` never runs the new tree's config loader before swapping `current`; stores are checked only after the swap; rollback restores code only and no test names rollback compatibility (`deploy-release.sh:630-647`, L9).
- **Every substrate unit scores 8.1 EXPOSED** on `systemd-analyze security` (probed 2026-10-14 for `substrate-mcp`, `substrate-dispatcher`, `substrate-collector-grok`): root, no capability bound, no kernel/namespace/realtime/SUID restrictions. The doctor does not look at exposure.
- **About 20 policies sit in shadow/report/off** and no tool says when a flip is safe; env names read by code (~223) have drifted from `.env.example` (~179).
- **SLO history exists (`/slo/history`) but nothing renders it**; the OTLP exporter is JSON-only and off.
- **The brief path is near its objective**: `brief.p95` 758 ms against 800 ms, cache 21 hits / 110 misses (16 %); every accepted write flushes every brief **twice** (accept + after the Hindsight retain), heartbeats flush graph-scoped briefs although the brief never prints a lease expiry, `getGraph` is four serial statements and `/healthz` is not single-flight (one index-ping timeout seen live).
- **Collectors drop events on a ledger outage** and the ledger cannot dedupe a replay (`emit.ts:10-12`; `EventInput` has no key; ids are minted on every call).
- **Skill approval is implicit in a merge** to agent-skills `main`; the substrate keeps no approved/retired state and no audit trail (Build Plan v0.3 §4, A-4d MISSING).

## The seven (ranked by impact ÷ risk)

### U5-1 — Release assurance: deploy preflight, rollback-compat proof, opt-in boot-and-prove gate
- **Resource:** VPS + all planes · **Build Plan:** A-5c (chaos smoke in CI), A-7 #5, N-OPS.
- **Design:** (a) `scripts/deploy-preflight.ts <release-dir>` runs the NEW tree's `loadConfig` and every `*ConfigWarnings` against the unit's env files, checks state-file tolerance (docs state, SLO checkpoint, retain outbox, event spool), installed-vs-repo unit drift and disk, prints names and verdicts only, no network; wired into `deploy-release.sh` before the swap with `SUBSTRATE_DEPLOY_PREFLIGHT=off|report|enforce` (default report). (b) rollback-compat tests: a frozen contract of what release `9231f43`'s readers require (docs state v2, `brief-snapshot` envelope, retain-outbox lines) against the REAL new writers, plus frozen old-shape fixtures read by the new readers. (c) `bun run gate:boot` boots the rehearsal twin (scratch Postgres + GreptimeDB, loopback, refuses 7410/7411/6420, `--pull never`) and proves `/healthz`, brief for `claude-code` + `grok-bot`, emit→brief, smoke, `smoke:grok`, a ledger outage via new `rehearsal pause/unpause --store`, recovery and a clean `down`; `SUBSTRATE_DEPLOY_GATE=off|report|enforce` (default off) lets the deploy call it pre-swap. (d) a report-only third CI job `boot-gate` (needs `vars.CI_ENABLED` and `vars.BOOT_GATE`).
- **Evidence → target:** zero pre-swap proof today → a first deploy that surfaces misconfiguration before the swap; an injected regression turns the gate red.
- **Failure / security:** read-only; the gate runs only isolated stores; never pulls images. **Rollback:** modes `off`; delete the CI job.
- **Files:** `scripts/deploy-preflight.ts`, `scripts/release-gate.ts`, `scripts/rehearsal.ts`, `infra/vps/deploy-release.sh`, `.github/workflows/ci.yml`, `scripts/verify.test.ts`, rollback-compat tests/fixtures, runbooks. **Effort:** M+M · **Risk:** low.

### U5-2 — VPS sandbox hardening: staged drop-ins per unit class, doctor exposure rows, offline test
- **Resource:** VPS · **Build Plan:** BP-1/BP-2 host constraints, A-5 runbooks.
- **Design:** `infra/vps/<unit>.service.d/*-sandbox.conf.example` for every unit in two classes (A: read-only `$HOME`, `ProtectSystem=strict`, kernel/namespace/realtime/SUID/personality restrictions, native syscall arch; B: muse, dispatcher, herdr, host keep `ProtectHome=false` because they write inside operator repos and run `git worktree add`); doctor rows for the `systemd-analyze security` score vs `SUBSTRATE_EXPOSURE_MAX` (unset = report only) and effective-vs-declared for installed drop-ins; a report-only Docker-reclaimable row; an offline test (`systemd-analyze security --offline`) pinning each unit's score ceiling and a denylist. Rejected on evidence: `MemoryDenyWriteExecute` (bun JIT needs W+X), non-root `User=`, empty `CapabilityBoundingSet`, `SystemCallFilter`, `PrivateNetwork`, any automatic docker prune.
- **Evidence → target:** 8.1 on three probed units (and on all fifteen unit files offline) → at or below each declared ceiling measured offline: Class A (mcp, anchor, doctor, docs-canary, index-sweep, alert, grok collector, the two archive units) 4.7 against a ceiling of 5.0; muse and herdr collectors, skills-sync and skills-bridge 5.5 (ceiling 6.0); dispatcher and host 6.3 (ceiling 6.5); every drop-in also started under a transient `systemd-run` on the VPS except the two archive units, whose mounts do not exist there (they fail 226/NAMESPACE by design); nothing installed by code.
- **Failure / security:** the operator tests each class with a transient `systemd-run` first (runbook); a drop-in that breaks a unit is removed with `daemon-reload`. **Rollback:** remove the drop-in.
- **Files:** `infra/vps/*.service.d/*`, `scripts/doctor-*.ts`, `scripts/sandbox-dropins.test.ts`, `docs/runbooks/vps-hardening.md`. **Effort:** M · **Risk:** low (operator-installed).

### U5-3 — Request-path efficiency: lite brief graph read, narrow cache invalidation, `/healthz` single-flight
- **Resource:** loopback redis cache + TimescaleDB index · **Build Plan:** A-3 (brief SLO), BP-5.0d, A-5 health.
- **Design:** `SUBSTRATE_BRIEF_GRAPH_READ=full|lite` (concurrent nodes-only read, byte-identical text); `SUBSTRATE_CACHE_BUMP_SCOPE=legacy|narrow` (a separate `recall` generation for the post-retain bump; heartbeat flushes only the graph-view key, not briefs; per-class key-completeness proof); single-flight `/healthz` and `SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S` (default 0).
- **Evidence → target:** one accepted write flushes briefs twice today (`service.ts:1786,1806`); 4 serial statements per graph read (`index-store.ts:602-616`) → one flush, 2 concurrent statements, identical text.
- **Failure / security:** staleness bounded by the generation design and proven per class; every flag defaults to today. **Rollback:** unset the flags.
- **Files:** `cache.ts`, `service.ts`, `brief.ts`, `index-store.ts`, `server.ts`, `config.ts`. **Effort:** M · **Risk:** medium (cache keys).

### U5-4 — Durable events: server idempotency key + bounded collector spool
- **Resource:** GreptimeDB ledger + collectors · **Build Plan:** A-5b (write outbox), A-5c, DP Greptime fail-open.
- **Design:** `POST /events` accepts an optional `idempotency_key` stored as reserved payload `_ik` (no schema change); a replay-marked request does one bounded lookup inside the per-session emit gate (hit ⇒ 202 `deduplicated:true`, nothing written; lookup error ⇒ 503, nothing written); `SUBSTRATE_EVENT_IDEMPOTENCY=off|accept|enforce` (default off); `/healthz.idempotency` advertises capability. Client: a 0600 bounded JSONL spool (`SUBSTRATE_EVENT_SPOOL=off|on`, caps/TTL/attempts, redact-before-write, drop visibility), first-attempt `ts` + deterministic key, replay only against a server that advertises idempotency, `substrate spool status|flush`, a cap on `refused-emits.jsonl`.
- **Evidence → target:** collectors drop events during an outage (`emit.ts:10-12`) → a 60 s ledger outage loses nothing and duplicates nothing once both flags are on.
- **Failure / security:** never spools 4xx, fail-closed writes, unredacted bodies or tokens; dedupe only for marked replays in the same PK cell (documented). **Rollback:** both flags off; `_ik` is inert payload data.
- **Files:** `greptime.ts`, `service.ts`, `server.ts`, `event.ts`, `packages/collectors/src/{emit,spool}.ts`, `packages/cli`. **Effort:** M+M · **Risk:** medium.

### U5-5 — Skills governance: registry, operator-only approve, approved-only list, report-first projection
- **Resource:** TimescaleDB index + audit trail · **Build Plan:** v0.3 §4 ("never auto-enable"), §6 "4.x skill approve audit", A-4d.
- **Design:** `skills_registry` table (idempotent `migrate()`), a state machine `proposed → approved|declined → retired` (never DELETE), operator-only `skills_approve` (authority → validate → `gh pr view` merge check → upsert → emit) and `skills_list` (approved only by default) as MCP tools and REST twins with every companion registry row; `SUBSTRATE_SKILLS_GOVERNANCE=off|report|enforce` (default off); the projector consults `GET /skills?state=approved`: report = warn once, enforce = no NEW links for unapproved skills, never unlink.
- **Evidence → target:** approval is implicit in a merge and unrecorded → every approval carries `merge_sha`, decider and an event; `report` shows drift before `enforce`.
- **Failure / security:** operator-only (swarm and `substrate` are never operators); `gh` failure ⇒ no row/no event; bootstrap risk documented (grandfather existing skills before `enforce`). **Rollback:** flag off; the table is additive.
- **Files:** `skills/registry.ts`, `index-store.ts`, `service.ts`, `mcp.ts`, `server.ts`, audit/admission/observe/event-sources rows, `packages/projector/src/skills*.ts`. **Effort:** M+M · **Risk:** medium (many pinned registries).

### U5-6 — SLO dashboards as code over `/slo/history` + opt-in extended evidence series
- **Resource:** GreptimeDB (metrics history) · **Build Plan:** A-3, A-7 #3, BP-7.
- **Design:** `scripts/dashboards.ts` renders Grafana JSON from `sloCatalogue()`, `METRIC` and the history allow-list (`--check` drift mode; deterministic), committed under `infra/vps/dashboards/` with Infinity-datasource provisioning examples (no literal tokens/hosts); `SUBSTRATE_METRICS_HISTORY_SERIES=core|extended` adds the SWR/profile/recall/admission/expiry evidence series (default core = unchanged).
- **Evidence → target:** zero dashboards, no evidence series in the history → importable dashboards that cannot drift from the catalogue, and the promotion evidence available off-box.
- **Failure / security:** read-only over the bearer-gated feed; `extended` is opt-in because the Greptime volume size is unresolved (500 MB recorded vs 5 GB in the plan). **Rollback:** flag back to core.
- **Files:** `scripts/dashboards.ts`, `infra/vps/dashboards/**`, `metrics-history.ts`, `docs/dashboards.md`. **Effort:** M · **Risk:** low.

### U5-7 — Promotion advisor + flag registry + config reference
- **Resource:** all planes (operability) · **Build Plan:** A-3/A-5, BP-7.
- **Design:** `packages/mcp-server/src/flag-registry.ts` — every env var the code reads with kind/default/safe/enforcing value and, for policy flags, a PROPOSED evidence threshold; a lock test fails on an unregistered env read (the scan excludes tests); `.env.example` drift fixed; `scripts/promote-advisor.ts` reads `/slo/history` + `/slo` and reports `ready | hold | insufficient-data | series-unavailable` per flag (read-only, GET-only, never flips anything); generated `docs/config-reference.md` (`--check`) and `docs/runbooks/flag-promotion.md`.
- **Evidence → target:** ~20 flags with no promotion criteria; 223 names read vs 179 documented → every read name registered and documented, promotion verdicts computed from the metrics instead of from memory. Thresholds are PROPOSALS [INFERENCE], stated as such.
- **Failure / security:** advisor is read-only; registry holds names and defaults only. **Rollback:** delete the script; the lock test is the only coupling.
- **Files:** `flag-registry.ts`, `scripts/promote-advisor.ts`, `scripts/config-reference.ts`, `.env.example`, docs. **Effort:** M · **Risk:** low.

## Sequencing

Base: `main` at `40890e4` (uplift 4 merged). One worktree per slice, integration branches `ultrathink/uplift-5a` and `ultrathink/uplift-5b`; subagents edit only, the orchestrator verifies once per wave.
- **Wave 1 (parallel, ten slices):** U5-1a preflight + rollback compat, U5-1b boot gate + CI, U5-2, U5-6, U5-7 (PR A); U5-3, U5-4a server, U5-4b spool, U5-5a server, U5-5b projector (PR B).
- **PRs:** A = U5-1, U5-2, U5-6, U5-7 (scripts, infra, docs, one flag in `metrics-history`); B = U5-3, U5-4, U5-5 (runtime paths). A merges first; B is cut from the new `main` (no stacked PRs). Each: CI `verify` → Greptile 5/5, no open threads → `ultrathink-ship` squash.
- **Gates:** `bunx tsc --noEmit`, `bun test` with a scratch Postgres (`SUBSTRATE_TEST_PG_URL`), `bun run check:phase-close`, `bun run test:py`; each item names its smoke in its SUMMARY.

## Not selected, and operator decisions

Alternates: (1) **enforcement of `requires/blocks/gated_by` at `graph_claim` (A-2c)** — contradicts the documented design ("index is a cache; refusing on a stale record is worse than reporting", `docs/coordination.md:315-318`, ADR 0001) and canceled/duplicate dependencies would deadlock; (2) guarded/lock-timeout `migrate()` (L9-B) — no new Postgres DDL shipped in uplifts 3/4, so the first-deploy risk it addresses is unevidenced; (3) cgroup-limit re-sizing (RSS ≈ 52 MB against 1G/2G), Greptime Flow rollups (flownode availability unverified), `tenant=swc` on every row (A-5f; touches the hash, needs hash versioning), Prometheus remote-write/OTLP protobuf.

Operator decisions surfaced, not made by code: **deploy** of uplifts 3+4+5 together (tag on `main`, `deploy-release.sh`; run `bun run deploy:preflight` first); installing the staged sandbox drop-ins (test each class with a transient unit first), the doctor/archive/anchor timers; the Railway Dragonfly (5 GB volume, unused, 180–310 ms RTT) — keep, repurpose or decommission; the Greptime volume size (500 MB vs 5 GB) before `SUBSTRATE_METRICS_HISTORY=on` / `extended`; promoting shadow policies through the advisor; grandfathering existing skills before `SUBSTRATE_SKILLS_GOVERNANCE=enforce`.

## Acceptance and execution (as run)

| Step | Record |
|---|---|
| proposal | presented 2026-10-14 at the operator's "approve proposals first" gate |
| acceptance | **all seven accepted** 2026-10-14 ("Accept all 7 and implement") with **"Merge only; operator deploys"** — nothing is deployed to the VPS by this series |
| base | `main` at `40890e4` |
| branches | one worktree per slice (`u5/s1` … `u5/s7`, plus `s1b`, `s4b`, `s5b`), two integration branches and two PRs: **A** `ultrathink/uplift-5a` = U5-1, U5-2, U5-6, U5-7; **B** `ultrathink/uplift-5b` = U5-3, U5-4, U5-5 |
| method | edit-only implementation agents; the orchestrator ran tsc, the full suite and the lock tests per item and committed; an independent read-only review of every item against the Greptile preflight ran before opening each PR and its findings were fixed |
| baseline gates | tsc clean · `bun test` 4450 pass / 1 skip / 0 fail (169 files, clean worktree) · `check:phase-close` pass (EVENT_KINDS 12, SURFACES 27) |

## Progress log

| Item | Status | Gates | Notes |
|---|---|---|---|
| U5-1 | done in PR A | tsc clean · `bun test` 4794 pass / 1 skip / 0 fail on the integrated tree · live `bun run gate:boot` 20/20 twice (about 59 s) · live preflight on the VPS: config ok, 3 unit-drift warnings (the pending uplift-4 unit changes) | gate flaked once on a cold-start SLO verdict and once on a chaos timeout boundary during development; both fixed, see S1b-SUMMARY |
| U5-2 | done in PR A | same suite · transient `systemd-run` startup of 13/15 units and a sandboxed MCP boot serving `/healthz` and storing an event | an independent review caught a missing writable path for skills-sync; fixed and covered by an offline test |
| U5-3 | PR B | | |
| U5-4 | PR B | | |
| U5-5 | PR B | | |
| U5-6 | done in PR A | same suite · live `/slo/history` for core and extended series against a scratch ledger, 401 without a bearer | dashboards never rendered in a live Grafana |
| U5-7 | done in PR A | same suite · live advisor against that server: all five policies `insufficient-data` (minutes of history), no token in any log | thresholds are proposals |
