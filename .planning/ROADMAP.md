# Roadmap: Agent Substrate

## Milestones

- ⚠️ **v1.0 build plan (phases 0-6 + 0.5)** — closed 2026-10-01 with known gaps. Archive: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md) · audit: [milestones/v1.0-MILESTONE-AUDIT.md](milestones/v1.0-MILESTONE-AUDIT.md)
- ✅ **v1.1 Swarm correlation, governed memory and orchestrate integrations** — Phases 7-10 with inserted 8.1, shipped 2026-10-07 (ADR 0001 S1 and S3). Archive: [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md)
- 🚧 **v1.2 Swarm leases, workspace install and lessons bank** — Phases 11-15 (in progress)

## Phases

<details>
<summary>⚠️ v1.0 build plan (Phases 0-6, with 0.5) — CLOSED 2026-10-01 with known gaps</summary>

- [x] Phase 0: Brief — complete and live
- Phase 0.5: Governance — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 1: Lane B — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 2: Claims and dispatch — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 3: Lane A — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 4: Skills — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 5: Docs and desktop — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 6: Ledger — closed in archive; see [MILESTONES.md](MILESTONES.md)

Phase details: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md) · audit: [milestones/v1.0-MILESTONE-AUDIT.md](milestones/v1.0-MILESTONE-AUDIT.md) · phase folders: `milestones/v1.0-phases/`

</details>

<details>
<summary>✅ v1.1 Swarm correlation, governed memory and orchestrate integrations (Phases 7-10, with 8.1) — SHIPPED 2026-10-07</summary>

- [x] Phase 7: Database structures (1/1 plans) — completed 2026-10-07
- [x] Phase 8: Memory structures (1/1 plans) — completed 2026-10-07
- [x] Phase 8.1: Version conflicts carry the standing version (INSERTED) (1/1 plans) — completed 2026-10-07
- [x] Phase 9: claude-ultrathink integration (1/1 plans) — completed 2026-10-07
- [x] Phase 10: Swarm orchestrate integration (1/1 plans) — completed 2026-10-07

Phase details: [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md) · requirements: [milestones/v1.1-REQUIREMENTS.md](milestones/v1.1-REQUIREMENTS.md) · audit: [milestones/v1.1-MILESTONE-AUDIT.md](milestones/v1.1-MILESTONE-AUDIT.md) · phase folders: `milestones/v1.1-phases/`

</details>

### 🚧 v1.2 Swarm leases, workspace install and lessons bank (In Progress)

**Milestone Goal:** Swarm agents work nodes under substrate leases with signed handoffs, every swarm workspace is wired to `substrate-mcp` with one token per agent process, and lessons from finished phases become governed, citable memory.

v1.2 builds ADR 0001 S2 (SPE-5053) and S4 (SPE-5055) and Tier 1 of the lessons bank (SPE-5830). Code lands on branches cut from each repo's `origin/main`, every client still fails open, and each phase ends in a proof that is run for real against a real Postgres and a real GreptimeDB.

Execution order: 11, then 12, then 13 and 14 in parallel. Phase 15 depends on nothing and runs alongside 11-14; running it early lets its `substrate lessons recall` feed the discuss step of a later v1.2 phase, which PROOF-04 needs.

**Phase Numbering:** integer phases continue from v1.1 (last phase 10).

- [ ] **Phase 11: Lease authority** — swarm session shape, holder-only `lease_id` and fenced calls, no swarm operator (agent-substrate)
- [ ] **Phase 12: Swarm lease bridge** — the runner claims, heartbeats, completes and releases each task's node for its agent (agent-swarm)
- [ ] **Phase 13: Signed handoffs** — `coord_handoff` packets at accountable-agent boundaries, context rebuilt from the ledger alone (agent-swarm)
- [ ] **Phase 14: Workspace install** — `substrate-mcp` wired into every swarm workspace runtime, one token per agent process (agent-substrate, agent-swarm)
- [ ] **Phase 15: Lessons bank** — `substrate lessons add | recall | digest` over governed `fact` entries (agent-substrate)

## Phase Details

### Phase 11: Lease authority

**Goal**: The substrate refuses any lease action a swarm agent is not entitled to: a swarm session names its agent, replica and graph, a `lease_id` reaches only its holder, and only the holder's surface can beat, release or complete.
**Depends on**: Nothing
**Repos**: agent-substrate
**Requirements**: [LEASE-01, LEASE-02, LEASE-03, LEASE-04]
**Success Criteria** (what must be TRUE):

  1. A `swarm-a05-be` claim with session `A05@r1:<graph_id>` is granted. A session naming another agent, a replica outside `[A-Za-z0-9._-]` or a graph other than `graph_id` is refused with MCP `isError` and never rewritten, and non-swarm surfaces claim exactly as before.
  2. No reply shows another holder's live `lease_id`: a denied `graph_claim`, a refused `graph_heartbeat` / `graph_release` / `graph_complete`, `graph_get`, `coord_drift_scan`, `/drift`, `coord_reap_leases`, newly written claim, warning and note payloads, and the replayable `coord_handoff` packet. Each still shows holder surface, session, epoch and expiry, and a packet signed earlier with the old field still verifies.
  3. A caller whose token surface is not the holder's is refused with `not-holder` on heartbeat, release and complete, even with the right `lease_id`. Anonymous local runs are not checked and operator `force` is unchanged.
  4. A swarm surface token listed in `SUBSTRATE_OPERATOR_TOKENS` is refused `force` and boot warns naming the surface, with a test for each.
  5. `EVENT_KINDS` is unchanged and `store-lock.test.ts` passes.

**Proof**: On the running server against a real Postgres and GreptimeDB, a node claimed by `swarm-a05-be` is read by `swarm-a09-rev` through every disclosing reply with no `lease_id` in any of them, and `swarm-a09-rev`'s heartbeat with A05's `lease_id` is refused `not-holder`.
**Plans**: TBD

### Phase 12: Swarm lease bridge

**Goal**: Every swarm task is worked under a substrate lease the runner holds for the executing agent, so two replicas never work one node and a dead replica's node frees itself.
**Depends on**: Phase 11
**Repos**: agent-swarm
**Requirements**: [LEASE-05, LEASE-06, LEASE-07, LEASE-08, LEASE-09]
**Success Criteria** (what must be TRUE):

  1. Before a task moves to `CLAIMED`, the runner claims its node as the executing agent's surface, with that agent's token read from the agent's own env file and session `<AGENT>@<replica>:<graph_id>`. It keeps the `lease_id` and sets the assignment's `lease_s` from the granted TTL. A denied claim leaves the task undispatched; an unreachable substrate dispatches unleased and records that it did.
  2. While the agent runs, the runner heartbeats well inside the TTL. A `lost`, `expired` or `unheld` refusal stops the agent's session and applies the transition from a tested table, and `expired` re-claims rather than beating.
  3. `DONE` goes through `graph_complete` fenced on `lease_id`, `CHANGES_REQUESTED` shows in the trail as a release followed by a re-claim, and `FAILED` and `CANCELLED` release.
  4. Two replicas of one agent class racing for a node get exactly one grant, and a killed replica's node reads as free to the next claimant within one TTL with no reaper on the path.
  5. The Task Store keeps the DAG, budgets, bids and arbitration records with nothing deleted, and with the substrate unreachable a swarm run completes as before.

**Proof**: Against the Phase 11 server on a real Postgres and GreptimeDB, two A05 replicas race for one node and exactly one is granted, and a task sent back with `CHANGES_REQUESTED` shows its release and re-claim in the trail.
**Plans**: TBD

### Phase 13: Signed handoffs

**Goal**: Context that crosses an accountable-agent boundary is written down by its sender and can be replayed from the ledger alone.
**Depends on**: Phase 12
**Repos**: agent-swarm
**Requirements**: [HAND-01, HAND-02, HAND-03, PROOF-02]
**Success Criteria** (what must be TRUE):

  1. Every producer→consumer boundary that changes the accountable agent writes one `coord_handoff` packet with `goal`, `files`, `dod` from the task's `acceptance[]`, `blockers`, `graph_id` and `node_id`, sent with the sender's own surface token, so no agent can sign as another.
  2. A receiving agent's task context is rebuilt from `coord_handoff_list` (each packet with its verdict) and `events_query` alone, and a test proves that no bus replay and no Task Store read took part.
  3. With `SUBSTRATE_HANDOFF_KEY` unset, packets are recorded unsigned, say so, and the swarm run still completes.
  4. An A05 replica killed mid-task has its node claimed by a second A05 within one TTL, the trail shows the expiry as a `warning`, and no two replicas ever hold the node at once.
  5. A05 hands a failed gate to A14 with the swarm bus stopped between them, and A14's context is rebuilt from `coord_handoff_list` and `events_query` alone.

**Proof** (PROOF-02): criteria 4 and 5 run end to end against a real Postgres and a real GreptimeDB.
**Plans**: TBD

### Phase 14: Workspace install

**Goal**: A fresh swarm workspace is wired to `substrate-mcp` by the install alone, and each agent process holds only its own token.
**Depends on**: Phase 12
**Repos**: agent-substrate (`packages/projector`, docs, secret scan) and agent-swarm (`build_agents.py --install-workspace`, `swarm_run.py`)
**Requirements**: [INST-01, INST-02, INST-03, INST-04, INST-05, PROOF-03]
**Success Criteria** (what must be TRUE):

  1. The install appends a `substrate-mcp` entry for each runtime it already configures, keeps existing entries, and changes nothing on a second run. Each runtime's child actually sees the substrate tools: Claude children run with cwd = the swarm checkout, so the runner passes `--mcp-config <ws>/.mcp.json` and lists the substrate tools in `--allowedTools`; Grok reads `.grok/config.toml` `[mcp_servers]` once the workspace clears its folder-trust gate without a hand step; omp reads `<ws>/.mcp.json` or `.omp/mcp.json` and its `--tools` allowlist does not hide the substrate tools.
  2. Every generated config names `${SUBSTRATE_TOKEN}` in its headers, never the value. The installer's test finds no Greptime MCP server in any generated file and no token literal in any file under the workspace, and the tracked-file secret scan flags `SUBSTRATE_TOKEN*`.
  3. The install writes one env file per agent outside every git checkout and outside the workspace, mode 0600, holding that agent's `SUBSTRATE_TOKEN` and nothing else. When it cannot, it prints what the operator must create and exits non-zero.
  4. The runner starts each child with only its own `SUBSTRATE_TOKEN`, every other `SUBSTRATE_TOKEN*` stripped, and holds that child's lease with the token from the same agent's env file.
  5. The install refuses a non-MCP runtime as an executing agent and keeps its refusals (inside the swarm checkout, `$HOME`, `~/.omp`, symlinks). A dry run prints the substrate additions and the env files it expects, and the docs record the `substrate.env` split between server and agents and the shared-account limit of 0600.

**Proof** (PROOF-03): install into an empty workspace and start a swarm run there with nothing edited by hand; the run appears in the ledger and in another agent's brief, the brief is non-empty and the claim is granted.
**Plans**: TBD

### Phase 15: Lessons bank

**Goal**: A lesson from a finished phase becomes governed memory that a later phase can recall and cite by id.
**Depends on**: Nothing (runs in parallel with Phases 11-14)
**Repos**: agent-substrate (`packages/cli`)
**Requirements**: [LES-01, LES-02, LES-03, LES-04, LES-05, PROOF-04]
**Success Criteria** (what must be TRUE):

  1. `substrate lessons add` writes each lesson, from text or from a SUMMARY.md lessons section, as one `fact` through `memory_write` / `POST /memory` with subject `lesson:<milestone>/<phase>/<slug>`, a source-and-content idempotency key and the structured header. A lesson counts only when `accepted` and `verified_persisted`, adding it twice yields one entry, and quarantined (hedged) lessons are reported, not retried.
  2. `substrate lessons recall` returns a `## Prior Lessons` block of the top lessons for a query and repo, ranked client-side by recency and keyword/tag match, each citing its entry id, with digested lessons left out.
  3. `substrate lessons digest <milestone>` writes one `fact` with subject `lesson-digest:<milestone>` listing the cited lesson ids, and deletes nothing.
  4. A lesson's success score is computed at read time from appended outcome facts that reference its id, and nothing is mutated in place.
  5. There is no new table, memory kind or write path, and `store-lock.test.ts` still passes.

**Proof** (PROOF-04): against the live substrate, a lesson from an archived v1.1 SUMMARY becomes an accepted, verified `fact` id, is recalled into a later v1.2 phase's CONTEXT.md and is cited in that phase's PLAN. The digest command is proven on a real milestone digest run against the live substrate, writing the v1.2 digest `fact` at the milestone close.
**Plans**: TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 7. Database structures | v1.1 | 1/1 | Complete | 2026-10-07 |
| 8. Memory structures | v1.1 | 1/1 | Complete | 2026-10-07 |
| 8.1. Version conflicts carry the standing version (INSERTED) | v1.1 | 1/1 | Complete | 2026-10-07 |
| 9. claude-ultrathink integration | v1.1 | 1/1 | Complete | 2026-10-07 |
| 10. Swarm orchestrate integration | v1.1 | 1/1 | Complete | 2026-10-07 |
| 11. Lease authority | v1.2 | 0/TBD | Not started | - |
| 12. Swarm lease bridge | v1.2 | 0/TBD | Not started | - |
| 13. Signed handoffs | v1.2 | 0/TBD | Not started | - |
| 14. Workspace install | v1.2 | 0/TBD | Not started | - |
| 15. Lessons bank | v1.2 | 0/TBD | Not started | - |
