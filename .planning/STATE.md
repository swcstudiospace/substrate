---
gsd_state_version: "1.0"
milestone: v1.5
milestone_name: SOTA (phases 45-54)
status: "v1.5 in progress: phases 45, 46, 47, 49, 50 complete on main; 48 in review (draft PR #102); 51 in progress; 52-54 defined, not started. v1.3.x phases 37-39 and 41-44 complete on main; phase 40 code complete on main with open follow-ups (retirement restore drill D-D3, D-D4 acceptance); phase 41 has no residual"
stopped_at: "phase 48 in review as draft PR #102; PR #99 merged 2026-10-21; CI audit gate to re-verify on PR #102"
last_updated: "2026-10-22"
last_activity: 2026-10-22
last_activity_desc: "roadmap and state reconciled with merged PRs #89-#103; phases 52-54 defined (SOTA-08..10)"
state_head: bdda262de1569c04b582b2ade159a9dc0825a0e3
progress:
  total_phases: 10
  completed_phases: 5
  total_plans: 5
  completed_plans: 5
  percent: 50
current_phase: 48
current_phase_name: tailscaledb-proxy-layer
---

# State

## Current

- **v1.3 closed 2026-10-21 with accepted debt.** v1.2 shipped 2026-10-08 (archived in `.planning/milestones/v1.2-*`).
- **v1.3.x phases 37-39 and 41-44 complete on main; phase 40 code complete on main** (open follow-ups: retirement restore drill (D-D3) and D-D4 acceptance); phase 41 complete with no residual.
- **v1.5 SOTA phases 45-47 and 49-50 complete on main.**
- **Phase 48 in review on draft PR #102** (PR #99 merged 2026-10-21; CI audit gate to re-verify on PR #102).
- **Phase 51 in progress on branch `gsd/p51-fabric-impl`** (not yet on origin).
- **Phases 52-54 planned** (defined in ROADMAP.md, not started).

## Historical v1.3 decisions (operator, 2026-10-08)

- Scope: finish the build plan — every unfinished area, in build-plan order, plus the deferred Phase 0 UAT.
- Shipping: one PR per phase, each cut from `main`; the milestone-definition docs ship first. `ultrathink-ship` runs with `--ignore-gsd` per phase (the operator's explicit choice), Greptile 5/5 with no open threads, auto-merge.
- Defaults accepted for user-visible choices: swarm-surface claims add only a note in Linear (no label or state change); Lane A claims as `claude-code`; the data planes are reached only through the substrate and Hindsight retains only gate-accepted memories; teachables are tagged governed facts, anchored by hash only; `desktop_run` is fail-closed to operator-listed surfaces; production tokens are provisioned in Phase 20 after the collectors carry them; the stray process on `:7410` is stopped in an operator-approved window in Phase 16.
- Run rules: grey areas auto-accept unless they change a user-visible contract; every live run (production service, real stores, Linear or Notion writes, devnet, GitHub PRs on other repos, model quota) waits for operator approval; failures already present at HEAD are recorded, not fixed.
- Baseline at `ab62c91`: `bun test` 1129 pass / 56 skip / 0 fail across 40 files; `bunx tsc --noEmit` clean.

## Historical v1.0 execution record

The following implementation notes predate v1.2. They are retained as history, not current deployment or pending-work assertions.

Phase 0 (Brief) is **complete and live on production infrastructure**.
`substrate-mcp` runs under systemd against GreptimeDB v1.1.4 and TimescaleDB,
both on Railway. The local dev containers have been deleted and the service
remains healthy, which is the proof it no longer depends on them.

Done:

- `substrate-mcp` on `127.0.0.1:7410` — MCP at `/mcp` plus `POST /brief`,
  `/events`, `/verify` and `GET /healthz`. Tools: `memory_brief`,
  `memory_write`, `memory_search`, `events_emit`, `graph_get`,
  `graph_register`, `graph_claim`, `graph_release`, `graph_complete`.
  (Underscores, not the doc's dots — Anthropic tool names must match
  `^[a-zA-Z0-9_-]{1,64}$`.)
- Postgres index + Greptime `agent_events` schemas, with the hash chain
  computed on ingest so Phase 6 has a correct chain from row one.
- Redaction on the write path, ported from the connector's `redactor.py`.
- `fetchBrief` in `claude-ultrathink` on branch `feat/substrate-brief`,
  fetched alongside uplift and awaited before the Graph of Thought.
- `substrate` CLI, git post-commit collector, Cursor hook projector,
  systemd unit.
- Index backfilled from 6 real Agent Task Graph graphs / 15 nodes.

**Proof met:** a brief fetched from inside `claude-ultrathink` named a Cursor
edit, a Hermes test run, another agent's open graph and a warning — 14 ms,
inside the 1.5 s budget.

Verified in production: chained events written to Railway Greptime and read
back, `substrate verify` confirming the hash chain intact, the index backfilled
from 6 real Agent Task Graph graphs, and three surfaces (hermes, omp,
grok-build) holding claims that a fourth (muse) sees in its brief. The service
survives SIGKILL and is restarted by systemd.

Not done: a reachable Postgres URL for the index; `graph_register` call inside
the `ultrathink-kickoff` skill; git post-commit hook and Cursor hooks are
written but still only dry-run.

## Historical implementation context

**Decisions**

- `agent-substrate` is its own git repo. Before `git init` it was an empty dir inside
  `/root/src/repos`, so GSD resolved upward to that repo's `.planning/` — an unrelated
  "Voice stream and desk wiring" milestone. The local `.git` scopes GSD correctly.
- RAGFlow and GreptimeDB live on a Railway account this MCP connection cannot see. Both are
  consumed as **external endpoints** from `/etc/substrate/substrate.env`; the substrate never
  provisions them.
- The index Postgres is assumed to be on that same account. Fallback is the connected Supabase
  project. It does **not** go on this VPS — disk is at 90%.
- Phase 4 vendors the real content of `/root/agent-skills` (dereferencing all 26 symlinks)
  rather than committing links or using submodules.
- Execution is full-autonomous, including live phase proofs and cross-repo PRs.

**Corrections found while building**

- Linear team is **swcstudio** with the **`SPE-`** prefix. The Notion plan's
  examples say `SWC-123`; real rows are `SPE-119`. Anything matching on the
  identifier must not hardcode `SWC`.
- MCP tool names cannot contain dots, so `memory.brief` is `memory_brief`.
- Greptime reserves `id` as a column name — all identifiers are quoted.
- Greptime returns TIMESTAMP columns as integer epochs, not ISO strings.
- Bun's SQL binds a JS array for `in ${sql(arr)}`, but `= any(${arr})` emits a
  malformed array literal.

**Corrections to the Notion plan, found on the VPS**

- `claude-ultrathink` is enabled (`"ultrathink@ultrathink": true`), not disabled. Phase 0's
  "re-enable the plugin" task is already satisfied.
- `/root/agent-skills` is not a git checkout: 14 real dirs + 26 symlinks.
- Ports 7410 and 6420 are free; `auctioning-greptime-1` on :4000 belongs to another project.

### Roadmap Evolution

- Phase 8.1 inserted after Phase 8: Gap closure: a version conflict now reports the decision's current version, so a swarm rewrite works when the decision is not in the newest 100 entries (MEM-02) (URGENT)

## Historical blocker notes

_(No open blockers. Credential rotation was considered and declined by the
owner — recorded here so it is not re-raised.)_

## Historical pending work

- Review and merge claude-ultrathink PR #1 (`substrate/brief` → `master`).

## Historical publication record

- `swcstudiospace/agent-substrate` (private) — `main` pushed.
- `swcstudiospace/claude-ultrathink` PR #1 — the `fetchBrief` integration,
  branched cleanly from `master`, 5 files, 256 tests green.

**Lesson recorded:** `git add <file>` on a file another session had already
modified swept four of their hunks into my commit (a 3→15 Sub-Issue assertion
and a `<thinking>`→`<rationale>` fixture change). It only surfaced because the
clean branch failed against `master`. In a shared checkout, stage hunks or
verify the diff against the target branch before pushing — not just the file
list.

## Historical investigation notes

- Notion §12 unknowns, each probed at the start of the phase that needs it: Orca's session/event
  query API, Muse's plugin API, Omp's skills directory, which Cursor hooks fire for the CLI,
  rivet-agentos `openSession` option names and the Codex adapter package name.

## Historical deployment record

`substrate-mcp` runs under systemd — `systemctl status substrate-mcp`,
`journalctl -u substrate-mcp -f`. Credentials at `/etc/substrate/substrate.env`
(0600, root). Both stores are on Railway; no local containers remain.

Railway networking, learned the hard way: `.railway.internal` and
`DATABASE_PRIVATE_URL` resolve only from inside Railway. A consumer outside it
needs the TCP proxy (`…proxy.rlwy.net:PORT`), which must be enabled per service
under Settings → Networking. HTTP services get a public domain automatically,
which is why Greptime worked immediately and Postgres did not.

## Current Position

Phase: 48 (TailscaleDB secure proxy layer) in review as draft PR #102; 51 in progress; 52-54 defined, not started
Plan: —
Status: v1.5 SOTA in progress: 5 of 10 phases complete on main (45, 46, 47, 49, 50)
Last activity: 2026-10-22 — roadmap and state reconciled with merged PRs #89-#103 (see Reconciliation 2026-10-22)

## Reconciliation 2026-10-22

- Merged to main 2026-10-21 (UTC; mergedAt and merge SHAs read with `gh pr view`): #89 (37, a1b7152), #90 (38, 1d4e4aa), #91 (39, acb6767), #92 (40, 6b7c4f2), #93 (41, 3466c50), #94 (42, 3e9a106), #95 (44, 92ef7c2), #96 (45, 93acd8a), #97 (43, f2138e1), #98 (46, 4c2c48e), #100 (47, d8accda), #101 (49, 2495a14), #103 (50, bdda262 = origin/main).
- Open: #102 draft (48, branch gsd/v15-48-proxy, head 4b660f1, docs-only fix); PR #99 (chore/known-vuln-accepted-risk) merged 2026-10-21; CI audit gate to re-verify on PR #102 (no pass recorded).
- Phase 40: code complete on main via #92; open follow-ups: retirement restore drill (D-D3) and D-D4 acceptance (`.planning/phases/40-docs-memory/VERIFICATION.md` on origin/main, status partial). Phase 41: complete on main via #93 with no residual.
- Phase 51: no PR; origin holds gsd/v15-51-fabric at 87c2bdc (plan commit only); gsd/p51-fabric-impl is not on origin yet.
- Phases 52-54 defined in ROADMAP.md (SOTA-08 to SOTA-10), not started; phases 48 and 51-54 have no plans on main.
- Docs-only change: no gate or test was run for this reconciliation.

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| uat_gaps | milestones/v1.0-phases/00-brief/0-UAT.md | partial (8 scenarios pending) | 2026-10-07 | v1.1 |

## Operator Next Steps

- Start the next milestone with /gsd-new-milestone

## Session Continuity

Last session: 2026-10-08T21:29:12Z
Stopped at: Phase 18 complete, ready to plan Phase 19
Resume file: None

## Performance Metrics

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 16 P16-01 | 15min | 2 tasks | 2 files |
| Phase 16 P16-02 | 9min | 3 tasks | 4 files |
| Phase 16 P16-03 | 14min | 3 tasks | 3 files |
| Phase 16 P16-04 | 5min | 3 tasks | 4 files |

## Decisions

- [Phase 16]: 16-01: rehearsal-env builder is pure with caller-supplied secrets; operator checks precede token materialization
- [Phase 16]: 16-02: parity startEpoch from ExecMainStartTimestamp (@unix); /proc start is a disagree-warning only
- [Phase 16]: 16-02: originShaKnown null fails closed with its own reason, distinct from sha-absent
- [Phase 16]: 16-03: ledger image override key composed at runtime so the store-lock substring scan stays green
- [Phase 16]: 16-03: smoke reads only consumer.env and refuses :7410/non-loopback before any request; claim needs claimed true plus granted
- [Phase 16]: 16-03: requirements-completed left empty, FOUND-01 stays open until the 16-05 live proof
- [Phase 16]: 16-04: docs carry key names only, no connection-string shapes; production-mutating steps framed operator-only

## Post-milestone uplift (graph ut-mv5r71hp-65f7b012, 2026-10-12)

Standalone post-close series on branch `ultrathink/uplift-7` — proposal: [UPLIFT_PROPOSAL.md](UPLIFT_PROPOSAL.md). Operator pre-authorized autonomous selection (engineering mix); no new milestone.

| Item | Status | Evidence |
|------|--------|----------|
| U5 gate verdicts as events (memory plane) | done | [uplift/01-SUMMARY.md](uplift/01-SUMMARY.md) — mcp-server 0 fail, phase-close pass, tsc clean |
| U4 quota-burn SLOs + dispatch storm-breaker | done | [uplift/02-SUMMARY.md](uplift/02-SUMMARY.md) — test:py 272 pass, obs/mcp 0 fail, tsc clean |
| U2 host VM re-adoption after restart | done | [uplift/03-SUMMARY.md](uplift/03-SUMMARY.md) — host 244 pass, tsc clean, full suite green mod F-01 |
| U1 sandbox egress allowlist | done | [uplift/04-SUMMARY.md](uplift/04-SUMMARY.md) — host 281 pass, tsc clean, full suite green mod F-01 |
| U3 signed dispatch handoffs + drift gate | done | [uplift/05-SUMMARY.md](uplift/05-SUMMARY.md) — test:py 293 pass, tsc clean |
| U6 knowledge freshness automation | done | [uplift/06-SUMMARY.md](uplift/06-SUMMARY.md) — projector+mcp 0 fail, phase-close pass, tsc clean |
| U7 loopback SSE event stream | done | [uplift/07-SUMMARY.md](uplift/07-SUMMARY.md) — mcp 0 fail, phase-close pass, tsc clean, full suite green mod F-01 |

## Post-milestone uplift 2 (graph ut-mv66gjpd-4d730336, 2026-10-13)

Second standalone post-close series on branch `ultrathink/uplift-2` — proposal: [uplift-2/PROPOSAL.md](uplift-2/PROPOSAL.md) (recon [CONTEXT.md](uplift-2/CONTEXT.md), measurements [BASELINES.md](uplift-2/BASELINES.md)). Operator accepted all seven on 2026-10-13; repo changes only, data-reducing policies behind opt-in flags (nothing deleted in production); no new milestone. Measured driver: `brief.p95` 3,116 ms against the 800 ms SLO with a 1 % cache hit ratio.

| Item | Status | Evidence |
|------|--------|----------|
| R1 brief fast path + cache effectiveness | done | [uplift-2/01-SUMMARY.md](uplift-2/01-SUMMARY.md) — twin: ETag/304 8 ms, degraded brief 1.21 s under a hung ledger |
| R2 plane breakers, per-plane SLOs, dependency-aware healthz, chaos per plane, substrate-red runbook | done | [uplift-2/02-SUMMARY.md](uplift-2/02-SUMMARY.md) — twin: breaker open after 5 timeouts, emit fails closed in 5 ms, healthz 503 |
| R3 Hindsight retain outbox, bounded recall, config hygiene | done | [uplift-2/03-SUMMARY.md](uplift-2/03-SUMMARY.md) — unit evidence; production pending deploy |
| R4 index pool/timeouts, capacity, dry-run sweeper, lease-stuck + quarantine-spike runbooks | done | [uplift-2/04-SUMMARY.md](uplift-2/04-SUMMARY.md) — twin: capacity live, sweep dry-run deletes nothing |
| R5 ledger chain cache, bounded reads, write-probe health, opt-in TTL | done | [uplift-2/05-SUMMARY.md](uplift-2/05-SUMMARY.md) — twin: write probe + capacity.ledger live |
| R6 RAGFlow documented shapes, durable pins, caches, opt-in prune, async trigger | done | [uplift-2/06-SUMMARY.md](uplift-2/06-SUMMARY.md) — fake-enforced; live RAGFlow still operator-gated |
| R7 VPS ceilings + slice, store-aware deploy gate, redis config, audit rollover, disk runbook | done | [uplift-2/07-SUMMARY.md](uplift-2/07-SUMMARY.md) — twin: `audit:verify` ok |

Gates at the final head: tsc clean · `bun test` 3525 pass / 65 skip / 1 fail (recorded F-01) · `check:phase-close` pass · `test:py` 298. Operator steps after merge: `infra/vps/deploy-release.sh` (new unit ceilings, `substrate.slice`, env lines), then read `/slo` and `/healthz` for the post-deploy rows in BASELINES.md; optional flags documented in `.env.example` (`SUBSTRATE_INDEX_SWEEP=apply`, `SUBSTRATE_LEDGER_TTL`, `SUBSTRATE_DOCS_PRUNE_SUPERSEDED`, `SUBSTRATE_AUDIT_ROLLOVER_BYTES`) stay off until chosen.

Deployed 2026-10-13T21:02Z (`release-20261013-91487e7`) and, after the post-deploy follow-up PR #60, `release-20261013-9231f43`: `brief.p95` 700 ms, all five plane breakers closed, `parity:check` PASS. Record: [uplift-2/HANDOFF.md](uplift-2/HANDOFF.md), [uplift-2/BASELINES.md](uplift-2/BASELINES.md).

## Post-milestone uplift 3 (graph ut-mv78nh8v-aa49a98b, 2026-10-13)

Third standalone post-close series on branch `ultrathink/uplift-3` — proposal: [uplift-3/PROPOSAL.md](uplift-3/PROPOSAL.md) (recon [CONTEXT.md](uplift-3/CONTEXT.md), live baseline [BASELINES.md](uplift-3/BASELINES.md)). Operator chose the series after the same prompt returned a fourth time and accepted all seven on 2026-10-13; same rules as uplift-2: repo changes plus the VPS deploy, every policy behind a flag that preserves today's behaviour, nothing deleted in production. Measured driver: evidence and policy are not durable — SLOs reset on every restart, memory TTLs are declared but not honoured, the ledger has no verified archive and anchoring is not scheduled, redis runtime policy drifted from the R7 config, no admission budgets, sequential RAGFlow retrieval, no Grok connector contract.

| Item | Status | Evidence |
|------|--------|----------|
| N1 runtime drift and jobs doctor | done | [uplift-3/01-SUMMARY.md](uplift-3/01-SUMMARY.md) |
| N2 restart-durable SLO history, capacity runway, ledger-native notifications | done | [uplift-3/02-SUMMARY.md](uplift-3/02-SUMMARY.md) |
| N3 per-surface admission budgets (shadow first) | done | [uplift-3/03-SUMMARY.md](uplift-3/03-SUMMARY.md) |
| N4 memory lifetime enforcement (report → enforce) | done | [uplift-3/04-SUMMARY.md](uplift-3/04-SUMMARY.md) |
| N5 docs retrieval fan-out, metrics, offline golden harness | done | [uplift-3/05-SUMMARY.md](uplift-3/05-SUMMARY.md) |
| N6 ledger coverage probe and verified archive | done | [uplift-3/06-SUMMARY.md](uplift-3/06-SUMMARY.md) |
| N7 Grok connector contract: smoke, MCP brief metadata, per-surface SLO | done | [uplift-3/07-SUMMARY.md](uplift-3/07-SUMMARY.md) |

Gates at the final head: tsc clean · `bun test` 3845 pass / 1 skip / 1 fail (recorded F-01) · `check:phase-close` pass · `test:py` 298. Every new policy ships in its reporting/shadow/off default: `SUBSTRATE_BUDGETS=shadow`, `SUBSTRATE_MEMORY_EXPIRY=report`, `SUBSTRATE_SLO_NOTIFY` unset, the doctor and ledger-archive timers staged but not installed, `SUBSTRATE_LEDGER_ARCHIVE_DIR` unset. Operator steps after merge and deploy: [uplift-3/HANDOFF.md](uplift-3/HANDOFF.md).

## Post-milestone uplift 4 (graph ut-mv7ciy6p-4429f130, 2026-10-14)

Fourth standalone post-close series — proposal: [uplift-4/PROPOSAL.md](uplift-4/PROPOSAL.md) (recon [CONTEXT.md](uplift-4/CONTEXT.md), live baseline [BASELINES.md](uplift-4/BASELINES.md)). Operator accepted all seven on 2026-10-14 at the proposal gate and chose to land uplift-3 (PR #61) first; same rules as uplift-2 and 3: repo changes only, every policy behind a flag whose default preserves today's behaviour or only reports, nothing deleted in production, no new service or plan tier. Two PRs: **A** S2, S3, S6, S7 (data planes and VPS); **B** S4, S1, S5 (the brief pipeline) — handoff and operator steps: [uplift-4/HANDOFF.md](uplift-4/HANDOFF.md). Measured driver: the Grok Bot's brief is uncapped and drops its own state, the index has no verified backup, the cache re-composes every brief after any write, BP-5.0 recall is not in the brief, SLO history lives only in a local checkpoint, a stale or lagging docs corpus is invisible, and the VPS runs at equal cgroup weight with no watchdog and a 330 MB uncapped journal.

| Item | Status | Evidence |
|------|--------|----------|
| S2 index disaster recovery (verified export, offline verify, restore-to-scratch, lease-bloat visibility) | done in PR A | [uplift-4/S2-SUMMARY.md](uplift-4/S2-SUMMARY.md) |
| S3 VPS runtime hardening (slice priority and swap isolation, `/livez` and opt-in watchdog, disk guardrails) | done in PR A | [uplift-4/S3-SUMMARY.md](uplift-4/S3-SUMMARY.md) |
| S6 durable metrics history in GreptimeDB | done in PR A | [uplift-4/S6-SUMMARY.md](uplift-4/S6-SUMMARY.md) |
| S7 docs freshness SLI, trigger lag, live golden canary | done in PR A | [uplift-4/S7-SUMMARY.md](uplift-4/S7-SUMMARY.md) |
| S4 cache single-flight, stale-while-revalidate, per-class metrics | done in PR B | [uplift-4/S4-SUMMARY.md](uplift-4/S4-SUMMARY.md) |
| S1 Grok brief contract: compact profile, state line, estimated-spend SLI | done in PR B | [uplift-4/S1-SUMMARY.md](uplift-4/S1-SUMMARY.md) |
| S5 cross-session recall in the brief, Hindsight inventory and gauges | done in PR B | [uplift-4/S5-SUMMARY.md](uplift-4/S5-SUMMARY.md) |

Every new policy ships in its off or report/shadow default: `SUBSTRATE_METRICS_HISTORY` off, `SUBSTRATE_INDEX_ARCHIVE_DIR` unset (the archive refuses by name), `SUBSTRATE_INDEX_TUNE` off, `SUBSTRATE_WATCHDOG` off with the watchdog drop-in shipped as an example, the docs canary refusing without its opt-in, and the freshness and lag rows report-only. The one default-on change is additive: `capacity()` also reports `graph_nodes` HOT-update and dead-row ratios, read concurrently with the existing statements.

PR B's defaults: `SUBSTRATE_BRIEF_PROFILE=shadow` (serves the full text, counts what the compact one would save), `SUBSTRATE_CACHE_SWR=shadow` (serves live, counts `would_serve_stale`), `SUBSTRATE_BRIEF_RECALL=off`, `SUBSTRATE_HINDSIGHT_INVENTORY=off`. Default-on and additive: identical concurrent cache misses share one load (single-flight); the brief answer carries `x-substrate-brief-profile` and, over MCP, `profile`; brief cache entries move to shape `sections-v1` (one cold start on deploy); a brief lists at most 1000 nodes (then says how many it left out); `/healthz.cache` gains `coalesced`, `stale`, `wouldServeStale`, `refreshes`; the three retain-outbox gauges and the per-class cache counters are always present.

## Post-milestone uplift 5 (graph ut-mv7mtq2j-b41cedcc, 2026-10-14)

Fifth standalone post-close series — proposal: [uplift-5/PROPOSAL.md](uplift-5/PROPOSAL.md) (recon [CONTEXT.md](uplift-5/CONTEXT.md), live baseline [BASELINES.md](uplift-5/BASELINES.md)). Operator accepted all seven on 2026-10-14 at the proposal gate and chose **merge only; the operator deploys**; same rules as uplift-2 to 4: repo changes only, every policy behind a flag whose default preserves today's behaviour or only reports, nothing deletes production data, units, timers, drop-ins and Railway variables are operator steps staged as files, cost-neutral. Two PRs: **A** (release assurance, VPS sandbox hardening, dashboards, promotion advisor) and **B** (request path, durable events, skills governance).

| Item | Status | Evidence |
|------|--------|----------|
| U5-1 release assurance: deploy preflight, rollback-compatibility tests, opt-in boot-and-prove gate, report-only CI job | done in PR A | [uplift-5/S1a-SUMMARY.md](uplift-5/S1a-SUMMARY.md), [uplift-5/S1b-SUMMARY.md](uplift-5/S1b-SUMMARY.md) |
| U5-2 VPS sandbox hardening: staged drop-ins per unit class, doctor exposure rows, offline exposure test | done in PR A | [uplift-5/S2-SUMMARY.md](uplift-5/S2-SUMMARY.md) |
| U5-6 SLO dashboards as code and opt-in extended history series | done in PR A | [uplift-5/S6-SUMMARY.md](uplift-5/S6-SUMMARY.md) |
| U5-7 promotion advisor, flag registry and config reference | done in PR A | [uplift-5/S7-SUMMARY.md](uplift-5/S7-SUMMARY.md) |
| U5-3 request-path efficiency: lite brief graph read, narrow cache invalidation, `/healthz` single-flight | done in PR B | [uplift-5/S3-SUMMARY.md](uplift-5/S3-SUMMARY.md) |
| U5-4 durable events: idempotent replay key and bounded collector spool | done in PR B | [uplift-5/S4a-SUMMARY.md](uplift-5/S4a-SUMMARY.md), [uplift-5/S4b-SUMMARY.md](uplift-5/S4b-SUMMARY.md) |
| U5-5 skills governance: registry, operator-only approve, approval-gated projection | done in PR B | [uplift-5/S5a-SUMMARY.md](uplift-5/S5a-SUMMARY.md), [uplift-5/S5b-SUMMARY.md](uplift-5/S5b-SUMMARY.md) |

PR A's defaults: `SUBSTRATE_DEPLOY_PREFLIGHT=report` (prints a table, never changes a deploy), `SUBSTRATE_DEPLOY_GATE=off`, `SUBSTRATE_EXPOSURE_MAX` unset (the doctor only reports exposure), `SUBSTRATE_METRICS_HISTORY_SERIES=core`; the sandbox drop-ins ship as `.example` files and nothing installs them; the `boot-gate` CI job needs both `vars.CI_ENABLED` and `vars.BOOT_GATE`. The one runtime-visible change in PR A is the `SUBSTRATE_METRICS_HISTORY_SERIES` parser (default core, byte-identical); everything else is scripts, infra examples, tests and docs.

PR B's defaults: `SUBSTRATE_BRIEF_GRAPH_READ=full`, `SUBSTRATE_CACHE_BUMP_SCOPE=legacy`, `SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S=0`, `SUBSTRATE_EVENT_IDEMPOTENCY=off`, `SUBSTRATE_EVENT_SPOOL=off`, `SUBSTRATE_SKILLS_GOVERNANCE=off`. Default-on and additive: concurrent `/healthz` probes share one computation; `/healthz` carries an `idempotency` field; `refused-emits.jsonl` rotates to one `.1` file at 1 MiB; the skills projector resolves its bearer the way its fetch does (surface token first, first entry of a list); `skills_registry` is created at boot; `skills_approve` and `skills_list` exist (operator-only and approved-only by default). Handoff and operator steps: [uplift-5/HANDOFF.md](uplift-5/HANDOFF.md). Nothing was deployed.
