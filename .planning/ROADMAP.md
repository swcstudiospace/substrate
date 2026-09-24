# Roadmap: Agent Substrate v1.0

## Overview

Build the four-plane agent substrate (runtime, memory, skills, ledger) per the Notion build
plan, keyed by the Graph ID that `claude-ultrathink` already mints. Seven phases, each ending
in a proof that is **run for real**, not asserted.

## Phases

> **Note on numbering.** GSD's roadmap parser does not recognise phase number
> `0` — `roadmap.analyze` reports 6 phases and starts at 1, so Phase 0 is
> invisible to GSD progress and milestone audits. The numbering is kept as
> 0-6 to match the Notion build plan, which is the source of truth and which
> is cross-referenced throughout. Phase 0 is complete and live; track it here.

**Phase Numbering:** integer phases are planned milestone work; decimal phases (2.1) are
urgent insertions.

- [x] **Phase 0: Brief** — cross-agent briefing on the two surfaces used most, keyed by Graph ID
- [ ] **Phase 1: Lane B** — Hermes, Omp, Muse Code, Grok Build and Grok Bot inside the substrate
- [ ] **Phase 2: Claims and dispatch** — Linear drives who works on what
- [ ] **Phase 3: Lane A** — sandboxed, durable sessions per Graph ID via rivet-agentos
- [ ] **Phase 4: Skills** — one library, three miners proposing, Hermes primary
- [ ] **Phase 5: Docs and desktop** — product docs and GUI tasks reachable from any agent
- [ ] **Phase 6: Ledger** — tamper-evident history

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

### Phase 1: Lane B
**Goal**: Hermes, Omp, Muse Code, Grok Build and Grok Bot all read the brief and emit events.
**Depends on**: Phase 0
**Success Criteria**:
  1. **Re-scoped by decision D-01 (CONTEXT.md D1).** Hermes reads the brief and emits events
     through an **additive** `/brief` call and `events_emit` injected into the existing
     `on_pre_llm_call` path without restructuring it. The original wording — "Hermes redesign
     per its own `.planning/PROJECT.md`: the Python `pre_llm_call` hook calls the TypeScript
     engine" — cites a shipped v0.3.0 milestone that does not contain that redesign; the real
     TypeScript-engine bridge belongs to the "Ultrathink on Hermes" v1.0 milestone. Lane B does
     not build it and must not claim it.
  2. **Re-scoped by D-01.** Hermes Kanban retirement is **deferred** to that same milestone;
     Lane B asserts only that `hermes_kanban_create` behaviour is *unchanged*.
     `hermes-linear-connector` keeps its Linear→Hermes dispatch, comment mirroring and DoD gate,
     untouched; eng-board auto-ingest additionally points at `events_emit`.
  3. **Settled by D-02.** herdr is the Lane B persistent runtime, already installed and verified
     live (0.9.1); Orca stays alongside as the IDE surface and a collector. This phase stands up
     the herdr `events.subscribe` collector against the corrected 0.9.1 wire contract.
  4. `omp-ultrathink` adds `memory.brief` to its discovery tools; Grok Build's `ultrathink`
     `UserPromptSubmit` hook fetches `/brief` and delivers it via a session file plus a rules
     entry, since Grok Build discards hook stdout; Muse falls back to `.substrate/BRIEF.md`.
  5. `grok-hermes-connector` v0.4 forwards `memory_brief`, `memory_write`, `events_emit`,
     `graph_get`; `handoff_to_hermes` records a `handoff` event with its Graph ID.
**Proof**: Hermes finishes node n2 from a Grok Bot handoff; Omp's next prompt in that repo
lists both the handoff and the claim.
**Plans**: 9 plans

Plans:
- [ ] 01-01-PLAN.md — Wave 0 rollback safety baseline: git baselines, live-file snapshots, measured test baselines (D-04)
- [ ] 01-02-PLAN.md — Phase tracer: Hermes reads the brief and emits one event, additively and fail-open (D-01)
- [ ] 01-03-PLAN.md — eng-board auto-ingest forwards session start, tool calls and finalize to `events_emit`
- [ ] 01-04-PLAN.md — herdr socket collector: per-pane subscriptions, race-free bootstrap, systemd unit (D-02)
- [ ] 01-05-PLAN.md — grok-hermes-connector v0.4: four substrate tools and a Graph ID on `handoff_to_hermes`
- [ ] 01-06-PLAN.md — Muse: `.substrate/BRIEF.md` writer, AGENTS.md pointer, PostToolUse event hook
- [ ] 01-07-PLAN.md — Omp: substrate-mcp registered as a second MCP endpoint, `memory_brief` in discovery
- [ ] 01-08-PLAN.md — Grok Build: brief fetched on UserPromptSubmit, delivered by session file plus rules entry
- [ ] 01-09-PLAN.md — Cross-surface proof, full regression sweep, and the STATE.md correction

### Phase 2: Claims and dispatch
**Goal**: Labelling a Linear issue for an agent starts that agent on that node.
**Depends on**: Phase 1
**Success Criteria**:
  1. `graph.claim` moves the Linear issue to `started`, adds `agent:<surface>`, posts a
     one-line comment with the session id, sets `Agent` on the Notion Issue row, and writes
     `claimed_by` in the index. A second agent asking for the same node gets the existing claim.
  2. `graph.release` and `graph.complete` mirror `ultrathink-sync`'s state table; completion
     still passes the `hermes-linear-connector` Definition-of-Done gate.
  3. `substrate-dispatcher` watches `dispatch:<surface>` on unstarted issues and starts a
     session for that Graph ID in a per-Graph-ID worktree; the label is removed and
     `agent:<surface>` added when the claim lands.
**Proof**: Label a real issue `dispatch:hermes` — a Hermes session starts, claims the node, the
Notion Issue row shows Agent hermes, and Claude Code's brief shows it within a minute.
**Plans**: TBD

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
**Proof**: A skill mined from a Cursor session is merged and appears in Claude Code and Grok
Build without either being touched.
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
**Proof**: Alter one event row — `verify` flags the graph.
**Plans**: TBD
