<!-- substrate-brief:start -->
Read `.substrate/BRIEF.md` at the start of your work in this repo. It is
the current substrate brief — a record of what other agents did here.
Substrate writes this file on a schedule; do not edit it by hand.
<!-- substrate-brief:end -->

## Review Summary (2026-10-19)

**Per docs-updates-plan self-contained research report, .planning/STATE.md, ROADMAP.md, 7-SOTA-ENHANCEMENTS.md (grounded reads of AGENTS.md, README, data-planes.md, config-reference.md, grok-bot.md, types.ts, multiple planning docs):**

- **Milestone & execution:** v1.3 Build plan completion (phases 16–33) archived 2026-10-11 at 100% (18 phases / 76 plans). Post-close uplifts 1–5 (U/R/N/S/U5 series, 35+ items) all green on tsc, `bun test`, `check:phase-close`, py tests; evidence in uplift-*/SUMMARIES + BASELINES/HANDOFF. Current: awaiting next milestone (STATE last 2026-10-11).
- **Gate / PR status:** Multiple open drafts (e.g. 80,81,82+) UNSTABLE. Greptile reviews contain unaddressed findings (example 0/1); no PRs at 5/5. Per Desk rules + pr-merge-preflight-gates SKILL.md (read pre-edit): draft PRs only; no merge, auto-merge, force-push or delete; Greptile (or FAILED/SKIPPED/unavailable review) is hard blocker—report, never claim ready. Read AGENTS.md + parent in every repo.
- **Docs gaps pre-this-update:** AGENTS.md was 32 lines, desk + cursor only; no review summary, no 7 enhancements coverage, no resource utility/mappings, no Claude Code parity section, no operational notes tying to planes. Cross-gaps in README (no enh utility), data-planes.md (no enh section), config-ref (narrative missing). Full targeted review performed (no full-file beyond ranges + grep/glob).
- **7 SOTA context:** Post-v1.3 initiative to activate idle resources (Railway, RAGFlow, Hindsight, Tailscale, GreptimeDB, DragonflyDB) for SOTA capabilities. See 7-SOTA-ENHANCEMENTS.md. All enh follow desk (draft, Greptile 5/5, flags opt-in/shadow first, preserve contracts).
- **Non-negotiables (reaffirmed):** Store lock (Greptime append-only via mcp only); fail-open except memory (gate + verified_persisted); redact before emit; append-only fail-closed. Cloud agents: loopback only.

**Next:** This edit + follow-on make AGENTS production-grade with required elements. Always start work by reading `.substrate/BRIEF.md`.

## Desk rules for cloud agents

Cursor cloud agents in this repository follow the rules below. Grok Bot is the `grok-bot` surface; how that surface reaches substrate data is [`docs/grok-bot.md`](docs/grok-bot.md).

- **Draft PR only.** Open a draft pull request into the default branch. No merge: do not merge, enable auto-merge, force-push, or delete branches.
- **No secrets.** Never print, commit, or echo tokens, keys, passphrases, or bus secrets. Reference environment variables by name only. Do not write tailnet names or internal hostnames into the repo, the pull request, or the session transcript.
- **Greptile gate via Desk Quality.** Every pull request goes through the Greptile merge gate run by Desk Quality via Programming Lead. Do not claim merge-ready while any Greptile finding is unaddressed. A FAILED, SKIPPED, or unavailable review is a blocker to report, never a pass.

## Cursor Cloud specific instructions

The development loop is Bun 1.4.0 (the version CI pins) plus system Python 3.12. `bun` and `bunx` are on `/usr/local/bin`. `httpx` and `pytest` are installed for system `python3`, so the Python suites run as `python3 -m pytest packages/miner/tests packages/dispatcher/tests`.

Scratch Postgres 16 is started on boot. Use the same user and password as `SUBSTRATE_TEST_PG_URL` in `.github/workflows/ci.yml`, on `127.0.0.1:5432`:

- `SUBSTRATE_PG_URL` points at database `substrate`. `substrate-mcp` is already listening on `127.0.0.1:7410` with that index, so `GET /healthz` is 200 and `POST /brief` returns the markdown brief.
- `SUBSTRATE_TEST_PG_URL` points at database `substrate_test`. Set it before `bun test` so the live index tests (leases, memory, search, graph bindings) run.

Checks, from the repo root: `bun install --frozen-lockfile`, `bunx tsc --noEmit`, `bun test` with `SUBSTRATE_TEST_PG_URL` set, `python3 -m pytest packages/miner/tests packages/dispatcher/tests`, and `bun run check:phase-close`. `bun run verify` is the same gate as CI and reinstalls from the lockfile.

`commit.gpgsign` is false here. `bun test` creates many temporary repositories, and SSH-signing each of those commits through the host agent overruns the suite's 5 second timeout. Desktop-container tests and the rehearsal twin stay skipped; they need Docker images that are outside this loop.
## Claude Code Surface Instructions

Claude Code (`claude-code` surface; first in SURFACES from `packages/mcp-server/src/types.ts`) reaches substrate via MCP (`.mcp.json` projected via swarm workspace projector; expands `${SUBSTRATE_URL}` and token). Graph ID (`ut-...` from claude-ultrathink) keys leases (`graph_claim` etc. with session_id), handoffs, events, governed memory. Lane A: one VM per Graph ID (approvals gated). Never direct DBs/Tailscale creds (see data-planes.md + railway-tailscale.md). Brief/recall via `memory_brief`/`memory_*`; writes pass full gate (memory fail-closed). Cloud: loopback MCP only.

See non-negotiables and operational notes below. Cross with `docs/grok-bot.md`, `docs/swarm-workspace.md`, `docs/coordination.md`.

## Resource Utilities and Mappings

Resources (planes + infra) are reached **only** through substrate-mcp (store lock). No direct clients, no second doors. Planes are derived (Hindsight from index+ledger; cache from access patterns).

Core resource mappings (6 + index; tied to 7 enhancements):

- **Railway**: hosting, dynamic services, forwarders (enh1 orchestrator, enh7 fabric, enh4 secure).
- **RAGFlow**: docs search/ingest with citations + redaction (enh2 advanced hybrid RAG).
- **Hindsight**: derived cross-surface memory recall + banks (enh5 graph memory).
- **Tailscale (TailscaleDB proxy)**: zero-trust secure private access, ACLs, unified layer (enh4 secure proxy, enh1 forwarders, enh7 fabric).
- **GreptimeDB**: append-only event ledger + hash chain + anchors (Solana); predictive analytics (enh3 predictive, enh6 pubsub, enh7 fabric).
- **DragonflyDB**: high-perf cache (briefs, searches, invalidation) + realtime pub/sub (enh3 predictive cache, enh6 pubsub, enh7).
- **Index (Timescale/Postgres)**: source-of-record for leases, memory, graphs (cross-cutting; supports enh5/7).

Agent view: via MCP tools only (`memory_*`, `docs_*`, events, graph). Operator view: env (0600), Railway console, Tailscale admin. Failure modes: lost trail (Greptime fail-open), stale (Dragonfly), RBAC deny (memory fail-closed). See full wiring, budgets, flags in `docs/data-planes.md` and generated `docs/config-reference.md`.

## The 7 SOTA Enhancements (2026-10-19)

Full code delivered in this PR for the 7 enhancements.

1. **Railway Resource Orchestrator** (enh1-railway-orchestrator)
   - **SOTA**: Cloud resource management with auto-optimization, cost attribution, dynamic scaling.
   - **Utility**: Direct MCP tools for Railway services (scale, monitor, deploy) using forwarders.
   - **Resource mappings**: Railway (primary orchestration), Tailscale (private forwarders for access).
   - **Target/Changes**: New MCP tools (`packages/mcp-server/src/railway.ts`), integration with config/infra, docs updates.
   - **Acceptance**: MCP tool lists Railway resources; basic scale suggestion; cost report in /slo.
   - **Operational**: Operator-provisioned; agents consume via substrate MCP only. Does not bypass store lock.

2. **RAGFlow Advanced Hybrid RAG with Hindsight Context** (enh2-ragflow-advanced)
   - **SOTA**: Hybrid search, reranking, memory-augmented retrieval.
   - **Utility**: Context from Hindsight + Greptime events for personalized, cited docs answers.
   - **Resource mappings**: RAGFlow (core), Hindsight (augmentation), Greptime (event context).
   - **Target/Changes**: Extend `planes/ragflow.ts` retrieval + hindsight recall integration; `docs/docs-plane.md`.
   - **Acceptance**: `docs_search` returns context-augmented results; hybrid tests.

3. **GreptimeDB + Dragonfly Predictive Analytics & Cache** (enh3-greptime-dragonfly-predictive)
   - **SOTA**: Time-series forecasting, predictive caching, anomaly detection.
   - **Utility**: Predict SLO burn; pre-warm Dragonfly from Greptime patterns; activate idle Railway Dragonfly.
   - **Resource mappings**: GreptimeDB (forecast/ledger), DragonflyDB (predictive cache).
   - **Target/Changes**: Forecasting in ledger/greptime code; predictive logic in `cache.ts`; observability.
   - **Acceptance**: /slo has predictive rows; cache preloads based on patterns.

4. **TailscaleDB Secure Unified Proxy Layer** (enh4-tailscaledb-secure)
   - **SOTA**: Zero-trust DB access with RBAC, audit, pooling.
   - **Utility**: Unified secure access for Greptime, Dragonfly, Timescale via Tailscale (no public endpoints).
   - **Resource mappings**: Tailscale/TailscaleDB (secure proxy layer), Greptime/Dragonfly/Timescale (proxied DBs).
   - **Target/Changes**: Proxy layer/config enhancements; `docs/railway-tailscale.md`; data-planes.
   - **Acceptance**: All DBs accessed via secure proxy; audit events for access.

5. **Hindsight Graph Memory with Greptime Events** (enh5-hindsight-graph)
   - **SOTA**: Graph-based long-term memory, causal inference from events.
   - **Utility**: Build graphs from Greptime ledger for advanced recall in Hindsight.
   - **Resource mappings**: Hindsight (graph memory), Greptime (events for causal).
   - **Target/Changes**: Graph structures in `planes/hindsight.ts`; event correlation in memory/greptime.
   - **Acceptance**: `memory_search` returns graph-linked results; recall uses causal paths.

6. **Dragonfly Pub/Sub for Real-time Events** (enh6-dragonfly-pubsub)
   - **SOTA**: Real-time pub/sub, event-driven cache invalidation.
   - **Utility**: Pub/sub on Dragonfly for propagating Greptime events to planes in real-time.
   - **Resource mappings**: DragonflyDB (pub/sub), Greptime (source events).
   - **Target/Changes**: Pub/sub support in `cache.ts`; integration with event emit code.
   - **Acceptance**: Real-time notifications for events via Dragonfly; tests.

7. **Enterprise Unified Resource Fabric** (enh7-unified-fabric)
   - **SOTA**: Cross-resource control plane for observability, compliance, auto-optimization, cost.
   - **Utility**: Single MCP interface and dashboards for all 6 resources on Railway + Tailscale.
   - **Resource mappings**: All six (Railway, RAGFlow, Hindsight, Tailscale, GreptimeDB, DragonflyDB) + index via unified fabric.
   - **Target/Changes**: New `fabric/` module in mcp-server; aggregating MCP tools; observability + docs.
   - **Acceptance**: New MCP tools for fabric status, optimization suggestions; compliance report.

Implementation: draft PRs, flag-gated, docs updates, existing + plane-specific verification. enh7 is cross-cutting (must not violate store-lock).

## Operational Notes (per docs-updates-plan)

- **Mandatory start:** Read `.substrate/BRIEF.md` at the start of your work in this repo (see marker block above; immutable; substrate writes on schedule).
- **Desk / gate rules (SKILLs read pre-edit):** Draft PR only into default branch. No merge, enable auto-merge, force-push, delete. No secrets (env var names only; no tailnets, hostnames, tokens in repo/PR/transcript). Greptile gate via Desk Quality (Programming Lead): every PR through it; do not claim merge-ready while any finding unaddressed. A FAILED, SKIPPED, or unavailable review is a blocker to report, never a pass. See pr-merge-preflight-gates SKILL.md and greptile-review-fix-loop SKILL.md for procedures.
- **Non-negotiables (store lock, from README + review):** Greptime append-only via substrate-mcp exclusively (no direct clients). Fail-open except memory (write must pass full governance gate + verified_persisted). Redact before emit. Append-only fail-closed. Enhancements must preserve these (enh4/7 in particular: no bypasses/second doors created).
- **Enhancement discipline:** Before planning/using enh1–7 read `docs/data-planes.md` (utility matrix, wiring, access paths, failure modes) + plane-specific docs (railway-tailscale.md, docs-plane.md, etc.) + `docs/config-reference.md`. Check breakers, budgets, SLOs, event vocab, lease contracts. Opt-in flags (shadow first); nothing on by default that alters behavior.
- **Cloud agent constraints:** Cursor/Claude/Grok/swarm use loopback MCP only. No direct `substrate-mcp` calls from cloud. Production paths via VPS + Tailscale forwarders. Reference env vars by name only.
- **Surface & coordination:** `claude-code` for Lane A (ultrathink Graph IDs, approvals). Separate tokens/leases per surface (swarm-*, grok-bot via gateway). Leases: surface+session_id, fenced, TTL. Handoffs signed/replayable. See `docs/coordination.md`, `docs/memory-governance.md`.
- **Docs hygiene & updates:** Update this AGENTS.md (and CLAUDE.md when present) when adding rules for new features or enhancements. Keep generated config-ref in sync. Consistent cross-refs to README, data-planes, observability, event-vocabulary. No CLAUDE.md at review time (gap noted).
- **PR / review hygiene:** Address findings in worktree per greptile SKILL; push normal (no force); re-trigger review; re-fetch to confirm addressed + CI green before reporting. Current baseline (planning): open drafts unstable with open Greptile items.
- **Production-grade invariants:** All enh additive or behind flags. Preserve v1.3 contracts and 4-plane model. Operator steps (deploys, installs) separate from agent code changes. Read full planning/ for context.

Update this file when rules or enh details change. All work follows the Desk rules, review summary, and operational notes above.
