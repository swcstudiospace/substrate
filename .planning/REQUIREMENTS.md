# Requirements: Agent Substrate

**Defined:** 2026-10-07
**Core Value:** Every agent on the host shares one brief, one event log, one governed memory plane and one Graph ID.

Source of truth for this milestone:
- ADR 0001 `docs/adr/0001-agent-swarm-as-sdlc-mesh-on-substrate.md` on `origin/main` (accepted design), phases S2 (Linear SPE-5053) and S4 (SPE-5055).
- The approved Tier 1 of the self-improving lessons bank (SPE-5830). The research is in `docs/research/memory-bank-realtime-event-proposal.md` and `docs/research/self-improving-memory-bank-proposal.md`. Storage decision 2026-10-07: lessons are governed `fact` entries written through `memory_write`.

Decisions confirmed with the milestone summary (2026-10-07):
- **Who holds the lease.** The swarm runner holds each task's lease on the executing agent's behalf, using that agent's surface token. Agent prompts don't change, and the heartbeat dies with the process that holds it.
- **Claim outcomes.** A denied claim skips dispatch. An unreachable substrate dispatches unleased and logs it.

## v1.2 Requirements

### Lease authority (repo `agent-substrate`, SPE-5053)

- [ ] **LEASE-01**: A swarm surface's `graph_claim` carries a `session_id` of the form `<AGENT>@<replica>:<graph_id>`. The agent must match the token's surface, the replica uses only `[A-Za-z0-9._-]`, and the graph must equal `graph_id`. Any other session is refused (MCP `isError`), never rewritten. Other surfaces keep today's behavior.
- [ ] **LEASE-02**: A `lease_id` is disclosed only to its holder. Every reply that today can carry another holder's live `lease_id` stops carrying it: a denied `graph_claim`, a refused `graph_heartbeat` / `graph_release` / `graph_complete`, `graph_get`, `coord_drift_scan` and `/drift`, and `coord_reap_leases`. So do the claim, warning and note event payloads written from now on, and the replayable `coord_handoff` packet. Holder surface, session, epoch and expiry still show. Packets already signed with the old field still verify.
- [ ] **LEASE-03**: `graph_heartbeat`, `graph_release` and `graph_complete` act only for the holder. A caller whose token surface is not the holder's surface is refused with a `not-holder` reason, even when it presents the right `lease_id`. Anonymous local runs (no tokens configured) are not checked, and operator `force` is unchanged.
- [ ] **LEASE-04**: A swarm surface's token is never an operator. Even when listed in `SUBSTRATE_OPERATOR_TOKENS` it is refused `force` (fail-closed), and boot warns, naming the surface. Tests prove both.

### Swarm lease bridge (repo `agent-swarm`, SPE-5053)

- [ ] **LEASE-05**: Before a task moves to `CLAIMED`, the runner calls `graph_claim` for the task's node as the executing agent's surface, with session `<AGENT>@<replica>:<graph_id>`. It keeps the `lease_id` and sets the assignment's `lease_s` from the granted TTL. A denied claim leaves the task undispatched. An unreachable substrate dispatches unleased and records that it did (fail-open).
- [ ] **LEASE-06**: While the agent runs, the runner heartbeats well inside the TTL. A `lost`, `expired` or `unheld` refusal stops the agent's session and applies a defined transition from a tested table; `expired` re-claims rather than beating.
- [ ] **LEASE-07**: `DONE` goes through `graph_complete`, fenced on `lease_id`. `CHANGES_REQUESTED` releases and re-claims, so the rework loop is visible in the trail. `FAILED` and `CANCELLED` release.
- [ ] **LEASE-08**: When two replicas of one agent class race for a node, exactly one is granted. A killed replica's node reads as free to the next claimant within one TTL, with no reaper on the path.
- [ ] **LEASE-09**: The bridge is additive. The Task Store keeps the DAG, budgets, bids and arbitration records, and nothing is deleted from it. With the substrate unreachable, swarm runs complete as before.

### Handoffs (repo `agent-swarm`, SPE-5053)

- [ ] **HAND-01**: Every producer→consumer boundary that changes the accountable agent writes a `coord_handoff` packet: `goal`, `files`, `dod` from the task's `acceptance[]`, `blockers`, `graph_id` and `node_id`. It is sent with the sender's own surface token, so no agent can sign as another.
- [ ] **HAND-02**: A receiving agent's task context can be rebuilt from `coord_handoff_list` (each packet with its verdict) and `events_query` alone, with no bus replay and no Task Store read. A test proves it.
- [ ] **HAND-03**: With `SUBSTRATE_HANDOFF_KEY` unset, packets are recorded unsigned and say so, and the swarm run still completes.

### Workspace install (repos `agent-substrate` and `agent-swarm`, SPE-5055)

- [ ] **INST-01**: `packages/projector` emits the `substrate-mcp` server entry, per swarm workspace, for each runtime that `build_agents.py --install-workspace` already configures (Claude Code, Grok Build, omp). Entries are appended to existing config, never replacing it, and re-running the install is idempotent.
- [ ] **INST-02**: No generated file names Greptime as an MCP server, and no workspace artifact contains a token literal: configs name the token's environment variable only. The installer's own test proves this over every generated file. The tracked-file secret scan covers `SUBSTRATE_TOKEN*`.
- [ ] **INST-03**: Each agent's token reaches only its own process. The install writes a per-agent env file outside every git checkout and outside the workspace, mode 0600, holding that agent's `SUBSTRATE_TOKEN` and nothing else. When it cannot write the file, it prints what the operator must create and exits non-zero. The runner starts each agent with only its own `SUBSTRATE_TOKEN` and strips every other `SUBSTRATE_TOKEN*` from the child's environment.
- [ ] **INST-04**: The install refuses to wire a non-MCP runtime as an executing agent. It keeps its existing refusals (inside the swarm checkout, `$HOME`, `~/.omp`, symlinks), and a dry run prints the substrate additions and the env files it expects.
- [ ] **INST-05**: The docs record the `substrate.env` split: which variables the server needs, which the agents need, and who owns each. They also record the shared-account limit: 0600 separates OS accounts, not processes of one account.

### Lessons bank (repo `agent-substrate`, SPE-5830)

- [ ] **LES-01**: A lesson is one governed `fact` written through `memory_write` / `POST /memory`. It has subject `lesson:<milestone>/<phase>/<slug>`, an idempotency key derived from its source and content, and a structured header (milestone, phase, outcome, tags, source path). It is used only when `accepted` and `verified_persisted`. There is no new table, kind or write path, and `store-lock.test.ts` still passes.
- [ ] **LES-02**: `substrate lessons add` writes lessons from text or from a SUMMARY.md lessons section. Quarantined lessons (hedged wording) are reported, not retried.
- [ ] **LES-03**: `substrate lessons recall` returns the top lessons for a query and repo, ranked client-side by recency and keyword/tag match, as a `## Prior Lessons` block that cites each entry id.
- [ ] **LES-04**: `substrate lessons digest <milestone>` writes one `fact` with subject `lesson-digest:<milestone>`, listing the cited lesson ids. Originals are never deleted, and digested lessons are left out of recall.
- [ ] **LES-05**: A lesson's success score is computed at read time from appended outcome facts that reference its id. Nothing is mutated in place.

### Proof (cross-repo)

- [ ] **PROOF-02**: S2 proof, against a real Postgres and a real GreptimeDB:
  - Kill an A05 replica mid-task. A second A05 claims the node within one TTL, the trail shows the expiry as a `warning`, and no two replicas ever hold the node at once.
  - A05 then hands a failed gate to A14 with the swarm bus stopped between them, and A14's context is rebuilt from `coord_handoff_list` and `events_query` alone.
- [ ] **PROOF-03**: S4 proof: install into an empty workspace and run the swarm. The run appears in the ledger and in another agent's brief, the brief is non-empty, and the claim is granted.
- [ ] **PROOF-04**: Lessons proof. A lesson from an archived v1.1 SUMMARY becomes an accepted, verified `fact` id. It is recalled into a v1.2 phase CONTEXT.md and cited in that phase's PLAN, and a digest `fact` is written at the v1.2 close.

## Future Requirements

- Lessons bank Tier 2: phase lifecycle events (as `note` events with `payload.lifecycle_type`), realtime delivery, an outbox, and automatic injection at the GSD discuss step.
- ADR 0001 S5 (gate verdict events, SPE-5056).

## Out of Scope

| Feature | Reason |
|---------|--------|
| REST routes for `graph_claim/heartbeat/release/complete` | Executing agents are MCP-capable; INST-04 refuses non-MCP executors (ADR 0001 S4 criterion 6) |
| Agent-held leases (the agent session calls `graph_claim` itself) | Decision 2026-10-07: the runner holds the lease on the agent's behalf |
| A `lessons` table, a new memory kind, new `EVENT_KINDS`, Dragonfly, a `phase_lifecycles` table | store-lock forbids a second memory write path; `EVENT_KINDS` is closed; Tier 2 is not approved |
| Process isolation between agents in one OS account | ADR 0001 risk table: token separation is not process isolation; documented, not fixed (INST-05) |
| Changing the installed GSD workflows | GSD is installed tooling, not owned here; v1.2 runs `substrate lessons recall` at discuss time by hand |
| Deleting or migrating the swarm Task Store | ADR 0001 non-goal 4: the bridge is additive |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|

**Coverage:** 25 requirements; mapping is filled in by the roadmap.

---
*Requirements defined: 2026-10-07*
