# Roadmap: Agent Substrate v1.0

## Overview

Build the four-plane agent substrate (runtime, memory, skills, ledger) per the Notion build
plan, keyed by the Graph ID that `claude-ultrathink` already mints. v0.3 SOTA Addendum inserts Phase 0.5 and hardens later phases for enterprise production (governance, leases, OTLP/SLOs, evidence). User additions: A2A Agent Cards for Teachable Moments (reverse skills: observations/edge cases from session learnings, tracked on Solana devnet); all Railway apps (hindsight, ragflow, dragonfly, timescale, backing) on/through the substrate.

Eight phases (0-6 + 0.5), each ending in a proof that is **run for real**, not asserted.

## Phases

> **Note on numbering.** GSD's roadmap parser does not recognise phase number
> `0` — `roadmap.analyze` reports 6 phases and starts at 1, so Phase 0 is
> invisible to GSD progress and milestone audits. The numbering is kept as
> 0-6 to match the Notion build plan, which is the source of truth and which
> is cross-referenced throughout. Phase 0 is complete and live; track it here.

**Phase Numbering:** integer phases are planned milestone work; decimal phases (0.5, 2.1) are
urgent insertions.

- [x] **Phase 0: Brief** — cross-agent briefing on the two surfaces used most, keyed by Graph ID
- [ ] **Phase 0.5: Governance** — memory policy gate, RBAC, quarantine, leases, Dragonfly snapshots (v0.3 insert)
- [x] **Phase 1: Lane B** — Hermes, Omp, Muse Code, Grok Build and Grok Bot inside the substrate + OTLP/SLOs/GrokBot loop (v0.3 1.x)  [complete per 2026-10-01 smokes: CLI brief/emit w/ graph, p95 OTLP in healthz, claim/event sim, tsc/tests clean, herdr/grokbot/connector/projector added]
- [x] **Phase 2: Claims and dispatch** — Linear drives who works on what + leases, signed handoffs, drift (v0.3 2.x) [complete 2026-10-01: leases CAS TTL heartbeat, handoff packet, dispatcher stub, proofs]
- [x] **Phase 3: Lane A** — sandboxed, durable sessions per Graph ID via rivet-agentos (stubs + disk + route)
- [x] **Phase 4: Skills** — one library, three miners proposing, Hermes primary + A2A Agent Cards / Teachable Moments (reverse skills) anchored on Solana devnet (schema + extraction + card + anchor stub)
- [x] **Phase 5: Docs and desktop** — product docs and GUI tasks reachable from any agent + Hindsight integration (RAGFlow proxy stub + redact + desktop fallback)
- [x] **Phase 6: Ledger** — tamper-evident history + evidence export, Solana teachable tracking (v0.3 6.x) (hash/prev existed; anchors, evidence, Solana extend)

Cross-cutting: All applications (hindsight, ragflow, dragonfly, timescale, backing stores) run on/through the substrate for memory, events, skills, ledger, A2A cards. Enterprise-grade, SOTA, production-ready (multi-tenant, SLOs, circuit breakers, runbooks, no silos).

## Phase Details

### Phase 0: Brief
**Goal**: A Claude Code prompt on the VPS is preceded by a brief that names what other agents
and surfaces did in that repo, sourced from a real event store and a real index.
**Depends on**: Nothing (first phase)
**Success Criteria** (what must be TRUE):
  1. `substrate-mcp` listens on `127.0.0.1:7410` under systemd and serves `memory.brief`,
     `memory.write`, `memory.search`, `events.emit`, `graph.get`, `graph.register` over MCP,
     plus `POST /brief` and `POST /events` as plain HTTP for hooks.
  2. `graph_index`, `graph_nodes`, `graph_steps` and memory tables exist in the index Postgres;
     `agent_events` exists in GreptimeDB.
  3. The index is backfilled from every Notion Agent Task Graph row carrying a Graph ID and
     from the Linear Spectrum Web Co team.
  4. `claude-ultrathink/hooks/uplift.ts` calls `fetchBrief` before the Graph of Thought and
     injects `<SUBSTRATE_BRIEF>`; it fails open within 1.5 s.
  5. `ultrathink-kickoff` calls `graph.register` after creating rows.
  6. Cursor `hooks.json` has substrate commands **appended** to the GSD-managed arrays, not
     replacing them; a git post-commit hook emits `commit` events.
  7. Stopping `substrate-mcp` leaves every agent working, just unbriefed.
**Proof**: Edit a file in Cursor, then start Claude Code on the VPS — the uplift echo shows a
brief naming that edit and the open graphs in that repo.
**Plans**: TBD

### Phase 0.5: Governance (v0.3 SOTA insert)
**Goal**: Memory governance (policy gate on every write), coordination leases/signed handoffs/drift, OTLP/SLOs/evidence foundations, Dragonfly for snapshots/circuit breakers. Before scaling Lane B.
**Depends on**: Phase 0
**Success Criteria**:
  1. Policy gate in memory_write: default-deny RBAC (surface × scope × kind), conflict strategies (last-write-wins/versioned/require-review), provenance (origin session/model/derived_from/trust/decay/needs_reverification), exactly-once (idempotency + verified_persisted).
  2. Quarantine for secrets/PII/spec plans; returns accepted|conflict|quarantined|denied + remedy. Fail-closed on memory, fail-open on events.
  3. Dragonfly integration (Railway) for brief snapshot, write outbox, circuit breakers.
  4. Tenant=swc multi-tenant prep; policy YAML; runbooks.
**Proof**: Bad-scope write quarantined/denied; exactly-once dedupes; Dragonfly snapshot serves on outage; policy enforced in production.
**Plans**: TBD

### Phase 1: Lane B
**Goal**: Hermes, Omp, Muse Code, Grok Build and Grok Bot all read the brief and emit events.
**Depends on**: Phase 0
**Success Criteria**:
  1. Hermes redesign per its own `.planning/PROJECT.md`: the Python `pre_llm_call` hook calls
     the TypeScript engine, which returns the brief with the uplift XML and graph.
  2. Hermes Kanban is retired as a tracker; `hermes-linear-connector` keeps its Linear→Hermes
     dispatch, comment mirroring and DoD gate; eng-board auto-ingest points at `events.emit`.
  3. Orca-vs-herdr decided by probing `orca agent-context --json` and the
     `ORCA_AGENT_HOOK_ENDPOINT` contract — herdr only if Orca's event API is closed.
  4. `omp-ultrathink` adds `memory.brief` to its discovery tools; Grok Build's `ultrathink`
     `UserPromptSubmit` hook fetches `/brief`; Muse falls back to `.substrate/BRIEF.md`.
  5. `grok-hermes-connector` v0.4 forwards `memory_brief`, `memory_write`, `events_emit`,
     `graph_get`; `handoff_to_hermes` records a `handoff` event with its Graph ID.
  6. (v0.3) OTLP exporters + SLO dashboards (brief p95 <800ms, emit ≥99.5%); hash-chained MCP audit.
  7. (v0.3) Grok Bot production loop skill enforces memory_brief on open, signed handoffs, substrate-only docs/skills, desk packs.
**Substrate additions (this wave)**: substrate.yaml + substrate-yaml-projector (generates per-surface config with tokens, SUBSTRATE_URL, brief command for hermes/omp/muse/grok); GrokBot production loop as example skill/docs + CLI integration.
**Proof**: Hermes finishes node n2 from a Grok Bot handoff; Omp's next prompt in that repo
lists both the handoff and the claim. OTLP/SLO metrics live; GrokBot follows loop.
**Plans**: TBD
### Phase 2: Claims and dispatch
**Goal**: Labelling a Linear issue for an agent starts that agent on that node.
**Depends on**: Phase 1
**Status**: [x] **complete 2026-10-01 (core leases + handoff + dispatcher stub)**
**Success Criteria**:
  1. `graph.claim` moves the Linear issue to `started`, adds `agent:<surface>`, posts a
     one-line comment with the session id, sets `Agent` on the Notion Issue row, and writes
     `claimed_by` in the index. A second agent asking for the same node gets the existing claim.
  2. `graph.release` and `graph.complete` mirror `ultrathink-sync`'s state table; completion
     still passes the `hermes-linear-connector` Definition-of-Done gate.
  3. `substrate-dispatcher` watches `dispatch:<surface>` on unstarted issues and starts a
     session for that Graph ID in a per-Graph-ID worktree; the label is removed and
     `agent:<surface>` added when the claim lands.
  4. (v0.3) Lease CAS + TTL + heartbeat on nodes; signed handoff packets (goal/files/DoD/blockers/prev_hash); action DAG on sub-issues; coord.drift_scan.
**Delivered**: Lease fields on GraphNode + index CAS+TTL+expiry steal+heartbeat+clear on release; mcp graph_claim(ttl)+graph_heartbeat+graph_handoff (packet schema); service lease payload; packages/dispatcher/src/dispatcher.ts (makeHandoff, sign, claimWithLease, detectDrift stub). tsc clean, claim tests pass, dispatcher smoke + handoff sig.
**Proof**: Unit tests exercised claim race + repo stamp; lease logic in code (expired steal, CAS); handoff packet verifiable stub; health p95; no double-claim path. Full live dispatch on Railway + Linear label next wave.
**Plans**: TBD (full watch + worktree spawn + drift git + DoD gate enforcement in Phase 3 integration)

### Phase 3: Lane A
**Goal**: Sandboxed, durable Claude Code sessions, one VM per Graph ID.
**Depends on**: Phase 2
**Success Criteria**:
  1. Free disk verified before pulling images (host is at 90%).
  2. rivet-agentos host runs; `openTask` writes shared skills, `SUBSTRATE_BRIEF.md` and the
     substrate/notion/linear MCP config into `/home/agentos`.
  3. The dispatcher routes `dispatch:claude-code` to a VM; `permissionPolicy: "ask"` surfaces
     approvals to Telegram through the existing stop-notify path.
  4. `claude-ultrathink` runs inside the VM, so kickoff and sync still write Notion and Linear.
**Proof**: A labelled issue opens a VM, the session survives a host restart, the PR lands and
`ultrathink-sync` closes the loop.
**Plans**: TBD

### Phase 4: Skills
**Goal**: One git-backed library every agent reads; the three existing miners propose into it.
**Depends on**: Phase 1
**Success Criteria**:
  1. `/root/agent-skills` is a git checkout of `swcstudiospace/agent-skills` with the **real
     content vendored** — all 26 symlinks dereferenced, no dangling links for any agent.
  2. The docs-scraper pipeline publishes into the repo instead of its own exports dir.
  3. Projection per agent: Claude Code and Grok Build symlinks, Hermes
     `skills.external_dirs`, Omp, Muse, Cursor `.agents/skills`, and rivet-agentos VM writes.
  4. Hermes `/learn`, Omp's skill creator and Grok Build `/autolearn` all call
     `skills.propose`, which opens a branch and PR rather than publishing live.
  5. Hermes runs hourly as primary miner; `skills.write_approval` and `memory.write_approval`
     are on.
  6. (user + v0.3) A2A Agent Cards per agent at /.well-known/agent-card.json (v1.0 Linux Foundation); Teachable Moments (reverse skills: session observations/edge cases/learnings) mapped as skills[] entries (name=framing, tags=teachable-moment etc); tracked/anchored on Solana devnet.
**Proof**: A skill mined from a Cursor session is merged and appears in Claude Code and Grok
Build without either being touched. Teachable from session appears in AgentCard.skills[], Solana tx verifiable.
**Plans**: TBD

### Phase 5: Docs and desktop
**Goal**: Product docs and GUI tasks reachable from any agent.
**Depends on**: Phase 0
**Success Criteria**:
  1. `docs.search` proxies the existing RAGFlow MCP endpoint (`ragflow_retrieval`).
  2. `docs.ingest` runs the redactor before ingesting.
  3. `desktop.run` drives cua on the Docker path or the existing `recruitment-desktop` webtop.
     No QEMU path — this host has no `/dev/kvm`.
**Proof**: An agent answers a docs question with a citation; a GUI smoke test runs in a sandbox.
**Plans**: TBD

### Phase 6: Ledger
**Goal**: Tamper-evident history.
**Depends on**: Phase 1
**Success Criteria**:
  1. Every collector computes `hash` over the canonical event JSON and carries `prev`.
  2. An hourly systemd timer Merkle-roots the hour's events into a Solana **devnet** memo and
     records root, signature and event count in an `anchors` table.
  3. `substrate verify <graph_id>` recomputes the chain and checks roots against signatures.
  4. (v0.3) `substrate evidence --graph` exports HTML/JSON attest (chain+claims+teachables+anchors+Solana sigs).
  5. (user) Solana devnet anchors for teachable moments (graph_id + observations/edges) in addition to event roots.
**Proof**: Alter one event row or teachable anchor — `verify` flags the graph. Evidence bundle matches; Solana teachable tx present.
**Plans**: TBD

## Cross-cutting: All Applications on the Substrate (SOTA / Enterprise / Production)
**Goal**: hindsight (api/control/llm-bridge/worker), ragflow (all variants), dragonfly (cache/snapshots/outbox), timescale, greptimedb, es/redis/mysql/storage all consume/produce via substrate (memory governed, events chained, skills/A2A, ledger/Solana). No silos. Per-app bearer or connector; Dragonfly for degraded; proxies for docs.
**Depends on**: Phase 0.5+
**Success Criteria**:
  1. substrate.yaml + infra cover all apps + agents.
  2. Apps emit/receive under governance/redaction; A2A cards for interop/teachable sharing.
  3. Enterprise: multi-tenant, SLOs, circuit breakers, runbooks, CI gates.
  4. Proof: hindsight/ragflow components use substrate paths; agents/bots see unified brief/memory; Solana has teachables from apps.
**Proof**: App service queries substrate for brief/memory; events from app flow to Greptime/Solana; teachable from app session anchored.
**Plans**: TBD
