# ADR 0001: Integrate Agent Swarm as the SDLC mesh on Agent Substrate

- **Status:** Accepted (design; no adapter code lands with this ADR)
- **Date:** 2026-09-30
- **Tickets:** [SPE-5051](https://linear.app/swcstudio/issue/SPE-5051) under
  [SPE-5050](https://linear.app/swcstudio/issue/SPE-5050)
- **Deciders:** Spectrum Web Co platform
- **Affects:** `swcstudiospace/agent-substrate`, `swcstudiospace/agent-swarm`

## Context

Two systems in this org solve adjacent halves of the same problem and were built
without reference to each other.

[**Agent Swarm**](https://github.com/swcstudiospace/agent-swarm) is a 15-agent SDLC
mesh — A01 `ORCH` through A15 `DOC` — with exactly one accountable single-writer
agent per artifact class, fail-closed quality/review/security gates, bounded
rework (max 2 auto loops), and autonomy ceilings L0–L4. It carries its own
`swarm.v1` signed envelope, a NATS JetStream bus over
`evt./req./offer./ctl./esc.` subjects, a Task Store holding the task DAG and its
lifecycle state machine (`CREATED → … → DONE`), a vector-store memory behind
`memory.write` / `memory.query`, and an OTel telemetry plane. Its correlation
invariant is one business request = one `correlation_id`, from brief to release
record. See its
[01-architecture.md](https://github.com/swcstudiospace/agent-swarm/blob/main/01-architecture.md),
[02-message-protocol.md](https://github.com/swcstudiospace/agent-swarm/blob/main/02-message-protocol.md)
and
[04-integration-plan.md](https://github.com/swcstudiospace/agent-swarm/blob/main/04-integration-plan.md).

**Agent Substrate** — this repo — is the four-plane layer (runtime, memory,
skills, ledger) that every agent on the VPS shares, keyed by the Graph ID
`claude-ultrathink` mints. What it already has, live, with tests:

- an **append-only Greptime events ledger** with a per-session hash chain, behind
  exactly one door (`docs/greptime-ledger.md`);
- **governed memory** that fails closed — default-deny RBAC over surface × scope ×
  kind, quarantine, exactly-once, conflict strategies, trust decay
  (`docs/memory-governance.md`);
- **leases, signed handoff packets and `coord.drift_scan`**
  (`docs/coordination.md`);
- `store-lock.test.ts`, which fails the build if either store grows a second
  write path.

The overlap is exact and unhelpful: both systems have a notion of who holds a
task, both have a memory write, both have a correlation key, both want a
telemetry plane. Run side by side they would produce two event logs nobody can
join, two memory stores that disagree, and two answers to "who is working on
this".

They are not, however, peers. The swarm is a **mesh of roles** — what gets built
and who is accountable for it. The substrate is a **platform** — where the
record of that work lives and how concurrent agents are kept off each other's
work. One runs on the other.

## Decision

**Agent Swarm runs ON Agent Substrate.** The swarm keeps its roster, its gates,
its DAG and its arbitration. The substrate stays the system of record for
everything it is already the system of record for, and the swarm reaches all of
it through `substrate-mcp` and nothing else.

Concretely, five commitments:

1. **Substrate is the SoR for events.** Every swarm-side event lands in the
   Greptime `agent_events` ledger through `events.emit` — and Greptime is reached
   through `substrate-mcp` only. No swarm process, collector or agent gets a
   Greptime client, a Greptime MCP server, or the credential. The hash chain and
   the write-path redactor are on that one door, so a second door would be an
   unchained, unredacted one.
2. **Substrate is the SoR for governed memory.** Swarm `memory.write` resolves to
   substrate `memory_write` and passes the gate. There is no bypass and no
   swarm-local memory store that other agents read. Memory stays fail-closed:
   the contract for anything another agent acts on remains
   `outcome === "accepted" && verified_persisted === true`.
3. **Substrate owns exclusivity: leases and handoffs.** A swarm task executing
   against a repo node holds a substrate **lease** — `graph_claim` /
   `graph_heartbeat` / `graph_complete`, keyed on (surface, `session_id`),
   epoch-CAS'd, TTL-expiring, fenced on release. A01 remains the single writer of
   swarm task *lifecycle state*; the substrate lease decides *who may touch the
   work*. Context crossing an agent boundary goes as a signed
   `coord_handoff` packet.
4. **Graph ID is the substrate-side correlation key.** The swarm's
   `correlation_id` is bound to exactly one Graph ID; the binding is held in the
   index, where it can be looked up both ways, and recorded in the ledger, where
   it cannot be rewritten. Every substrate call the swarm makes carries the Graph
   ID. `correlation_id` keeps working inside the swarm; it is not a second key in
   the substrate.
5. **Substrate observability is the SDLC record; OTel stays the runtime record.**
   The swarm keeps its OTel plane for traces, metrics and A13's SLOs. The
   substrate's ledger holds the auditable, tamper-evident, per-Graph-ID trail.
   They are joined by carrying `trace_id` on emitted events — not by duplicating
   one into the other. Same argument as Langfuse in `.planning/PROJECT.md`.

### The precondition all five rest on

Commitments 1, 3 and 4 assume that a substrate call can be attributed to the
agent that made it. Today that holds for memory and for handoffs, and **not** for
events or claims: `events_emit` and `graph_claim` take a caller-supplied
`surface` ahead of the token's, and `graph_claim` takes `session_id` as an
argument. `mcp.ts` is explicit that this is deliberate — "everywhere else in this
file a caller-supplied `surface` is attribution, and naming another surface is at
worst a mislabelled event."

That reasoning is sound for the collectors it was written for and wrong for this
plan. A mesh whose central invariant is one accountable writer per artifact
cannot rest attribution on a convention: one buggy or compromised agent could
emit as any other, and two callers naming the same (surface, `session_id`) pair
are one lease holder and can renew each other's lease. So the authenticated
surface must win on those two paths, or a mismatch be refused — the hardening
`memory_write` and `coord_handoff` already have. It is **S1 criterion 2**, ahead
of everything that depends on it, and it is a change to this repo rather than to
swarm configuration.

### Why this direction and not the other

The substrate could have been made a swarm subsystem — an A16, or a sink behind
A13. Three things rule that out.

- The substrate's guarantees are **structural, not procedural**: append-only,
  one door, default-deny, fenced. They hold because there is nowhere to forget
  them from. A swarm that treated the substrate as one of its own services would
  be free to route around it, and the store lock would stop being a lock.
- The substrate already serves **eleven surfaces** that are not swarm agents —
  Cursor, Hermes, Omp, Grok Bot and the rest. It cannot be scoped to one mesh's
  lifecycle.
- The swarm's own invariants are about **accountability**, which is a role
  question. The substrate's are about **durability and exclusivity**, which is a
  platform question. Putting the platform question inside the role system makes
  every future mesh re-answer it.

## Plane mapping

The six rows the work order names, plus the rows that turned out to be needed to
make those six honest.

| Swarm plane | Swarm mechanism | Substrate mechanism | Notes |
|---|---|---|---|
| Correlation | `correlation_id` (UUID, one per business request), `trace_id`, `causation_id`, `msg_id` | **Graph ID** `ut-<ts36>-<8hex>` — `graph_id` on every event, memory entry, lease and handoff | 1:1, bound once. `node_id` ← swarm `task_id`; `step` ← `dag_depth` where a step reading exists; `linear_identifier` where the node has a Linear issue. `trace_id` and `causation_id` ride in the event `payload`, not in the key. **The binding needs a row in the index, not only a ledger event**: `events_query` filters on columns and not on `payload`, so a `note` carrying both ids is a record of the binding and not a lookup for it. See S1 |
| Roster | A01–A15 (`ORCH`, `REQ`, … `DOC`), each `agent-id@replica` | **surfaces** — `SURFACES` in `packages/mcp-server/src/types.ts` gains 15 entries, `swarm-a01-orch` … `swarm-a15-doc` | Must be real surfaces, not a single `swarm` surface: memory RBAC is default-deny per surface, `agent-self` scope is self-only, and a shared surface would make all 15 one memory writer and one lease holder. `@replica` maps to `session_id`, so two replicas of a class are two lease holders — the same fix the lease made for two Hermes sessions. **Separate tokens are not yet separate identities**: on `events_emit` and `graph_claim` a caller-supplied `surface` is taken over the token's, and `graph_claim`'s `session_id` is a caller argument. See S1 |
| Task Store | claim / `task.status` progress / `task.result` completion over the lifecycle state machine; `task.assign` carries `lease_s` | `graph_claim` → `graph_heartbeat` → `graph_complete`, plus `graph_release`; `coord_handoff` for the packet | Substrate lease is authoritative for exclusivity; A01 stays authoritative for lifecycle state. The swarm lease becomes an advisory mirror of `lease_id`, not a second authority. `CHANGES_REQUESTED` → release-and-reclaim, not a silent re-run, so the trail shows the rework loop |
| Memory | `memory.write` / `memory.query`, kinds `decision \| retro \| pattern`, "all write, read-all" | `memory_write` / `memory_search` / `memory_brief` through the governance gate | Kind mapping: `decision`→`decision` (versioned, needs `expected_version`), `retro`→`fact`, `pattern`→`fact`. **Read-all is not write-all**: `global` scope is require-review, so a swarm-wide pattern is a *proposal* until a reviewer token releases it. Gate verdicts are `warning`; handoff context is `handoff` |
| Bus / telemetry | `evt.*` durable streams, `agent.heartbeat`, `gate.verdict`, `escalation.request` | `events_emit` (MCP) / `POST /events` (REST, for hooks) → `agent_events`; read back via `events_query` / `events_verify` | The bus is not replaced — see non-goals. Emission is a **tee**, at-least-once on both sides. **The tee is not idempotent for free**: `normalizeEvent` mints `evt_<random>` per call and `msg_id` is only payload, so a republished envelope or a retried tee appends a second row. Idempotent swarm handlers do not make the ledger idempotent — the tee dedupes on `msg_id` itself, or the trail shows one message twice. Swarm `type` maps onto the closed `EVENT_KINDS` set with the specific type in `payload.swarm_type`; the enum is not widened, because `kind` participates in the hash and `drift_scan` keys its findings off particular kinds |
| Observability | OTel collector → traces/metrics/logs; A13 operates, all emit | substrate ledger + `events_verify` + `coord_drift_scan` | No duplication: OTel keeps runtime telemetry, the ledger keeps the auditable SDLC trail. `trace_id` on the event is the join. `drift_scan` compares git HEAD, the trail and the leases held. **`events_verify` chains per `session_id`, not per graph**: it buckets a Graph ID's events by session and verifies each chain separately, so it detects an altered row but attests no single order across agents or replicas. A graph-wide attestation is the Phase 6 Merkle anchor, not this call |
| Gates | A08/A09/A10 conjunction, fail-closed; `gate.verdict` | recorded, **not enforced** — `warning`-kind events and `warning`-kind memory | Deliberate. `graph_claim` does not enforce graph edges either, for the same reason: the index is a cache, and refusing work on a stale record is worse than reporting a disagreement. The swarm's gate conjunction stays the enforcement point. **But `warning` is not a work kind**: `drift.ts`'s `WORK_KINDS` is `commit`, `file.edit`, `shell`, `tool.call`, `pr`, so a verdict emitted only as a `warning` leaves a gate agent looking idle to `lease.idle` and an unclaimed gate action invisible to `work.unclaimed`. A verdict therefore emits its `tool.call` too. See S5 |
| Signing | ed25519 over the `swarm.v1` envelope (required for `task.assign`, gate verdicts, promote/rollback) | HMAC-SHA256 over the handoff packet, key from `SUBSTRATE_HANDOFF_KEY`, `key_id` for rotation | Two schemes, both kept. They sign different things — a message in flight vs. a packet replayed out of an append-only ledger. Unifying them is not in scope |
| Artifact registry | Git + OCI, per-artifact single writer | unchanged | The substrate does not want to hold artifacts. `commit`, `pr` and `file.edit` events reference them |
| Secrets | Vault/KMS, OIDC federation, no long-lived agent credentials | `/etc/substrate/substrate.env` (0600, root), `SUBSTRATE_TOKEN_<SURFACE>` per surface | Compatible by accident and worth stating: a surface token is what names a memory writer, and a caller-supplied name is a caller-supplied permission. 15 new surfaces means 15 new tokens, not one shared one |

## Non-goals

These are the things this ADR exists to refuse. Each one is a shortcut that would
have made S1 smaller and the result worse.

1. **No second Greptime door.** Not a swarm-side Greptime client, not a Greptime
   MCP server for A13, not "just reads". Redaction and the hash chain live on
   `substrate-mcp`'s write path; a second door is an unredacted, unchained one,
   and `store-lock.test.ts` fails the build on the attempt. A13 gets
   `events_query` and `events_verify`, which take filters and never SQL — so no
   swarm seat needs the credential and no seat can reach past the filters it is
   given.
2. **No memory-gate bypass.** No swarm-local memory store that other agents read,
   no ungoverned `insertEntry`, no direct write to `memory_entries`. A swarm
   `memory.write` that is `denied`, `quarantined` or `conflict` has not been
   stored, and the swarm must handle that reply rather than retrying around it.
   `E-POLICY` is the swarm-side code for a `denied`, which its own taxonomy
   already handles fail-closed.
3. **S1 does not require replacing NATS.** The bus keeps carrying
   `evt./req./offer./ctl./esc.`, request/reply, competing bids, consumer groups
   and backpressure — none of which `events.emit` offers or should. Emission is a
   tee alongside the bus. Whether the bus is eventually reduced in scope is a
   later question with its own ticket; making it S1's problem would block the
   correlation work behind a transport migration.
4. **No big-bang delete of the swarm Task Store.** The gradual bridge is the
   plan, not a compromise: the Task Store holds the DAG, budgets, bids,
   arbitration records and the lifecycle state machine, and the substrate models
   none of those. What migrates is the *exclusivity* claim, not the store. The
   swarm's SQLite (the runnable path) and Postgres (the deployed path) both stay
   until each piece of what they hold has somewhere else to be.
5. **No new planning layer, and no re-keying.** The substrate already adopted
   `claude-ultrathink`'s Graph ID unchanged and will not mint a second key for
   swarm work. Equally, `correlation_id` is not retired inside the swarm — it is
   bound.
6. **The substrate does not enforce swarm gates**, does not arbitrate, and does
   not schedule. It records, reports drift, and refuses ungoverned writes.
7. **No Linear or Notion write-back from swarm agents in this arc.** There is
   still no Linear client in this repo (`LINEAR_API_KEY` is read by config and
   used by nothing). Notion and Linear stay the source of truth, reached the way
   they already are.
## Phased plan

Five phases, S1–S5, one per ticket SPE-5052 … SPE-5056. Each ends in a proof that
is **run for real**, in the pattern `.planning/ROADMAP.md` already uses. The
phase order and titles are the tickets' own, not this ADR's — an earlier draft
proposed its own order, put memory at S2 and leases at S3, and omitted the
install/projector phase entirely, which would have sent every owner at the wrong
acceptance criteria.

| | Phase | Ticket |
|---|---|---|
| S1 | Correlation, identity and the event tee | SPE-5052 |
| S2 | Lifecycle bridge: Task Store ↔ leases and handoffs | SPE-5053 |
| S3 | Swarm memory → governed `memory.write` | SPE-5054 |
| S4 | Install / projector: wire `substrate-mcp` into swarm workspaces | SPE-5055 |
| S5 | Gate verdicts as substrate events, and verification | SPE-5056 |

### S1 — Correlation, identity and the event tee (SPE-5052)

**Goal:** one `correlation_id` is one Graph ID, every swarm call is attributed to
the agent that actually made it, and swarm work shows up in the ledger and in
other agents' briefs.

Acceptance criteria — what must be TRUE:

1. `SURFACES` carries `swarm-a01-orch` … `swarm-a15-doc`; each has a
   `SUBSTRATE_TOKEN_*` entry in `.env.example` and boot reports any that is
   missing rather than accepting the caller anonymously.
2. **The token names the caller on the paths this plan leans on.** Today
   `events_emit` and `graph_claim` both take a caller-supplied `surface` ahead of
   the token's, and `graph_claim` takes `session_id` as an argument — so any
   swarm token can emit as, and claim as, any other agent. Either the
   authenticated surface wins on these two paths (as it already does for
   `memory_write` and `coord_handoff`), or a mismatch is refused; a test asserts
   that a token for A05 cannot write an event or hold a lease as A09.
3. A swarm run binds its `correlation_id` to exactly one Graph ID, and the
   binding is **durable and reversible**: a row in the index keyed on
   `correlation_id` with a uniqueness constraint, so a retry holding only the
   `correlation_id` gets the Graph ID back and two runs racing the same
   `correlation_id` resolve to one winner and one reader. The `note` event
   carrying both ids is the record of the binding, not the lookup for it —
   `events_query` filters on columns, never on `payload`.
4. Swarm-originated work with no upstream ultrathink prompt gets a Graph ID by
   the documented minting path — the format `ut-<ts36>-<8hex>` is unchanged, and
   `graph_register` records the node set.
5. Every `swarm.v1` envelope the swarm publishes is teed to `events.emit` with
   `surface` = the emitting agent, **`session_id` derived from the emitter's
   `agent-id@replica`**, `graph_id`, `node_id` = `task_id`, `kind` from the
   documented `type`→`EVENT_KINDS` map, and `trace_id`, `causation_id`, `msg_id`
   and `swarm_type` in `payload`. `session_id` is required, not optional: `prev`
   chains within a session, so events emitted without one all take
   `prev: null` and the chain the S1 proof checks would not exist.
6. **The tee dedupes on `msg_id`.** `normalizeEvent` mints a fresh
   `evt_<random>` per call, so a republished envelope or a retried tee appends a
   second row for one logical message. A dedupe window on
   `msg_id` + emitting surface (the envelope's own 24 h window is the obvious
   one) is tested against a deliberate double-publish.
7. `events_query` on the Graph ID returns the run's events in order, and
   `events_verify` reports an intact chain for every session in it.
8. The tee **fails open**: with `substrate-mcp` stopped the swarm completes a
   full DAG, unbriefed and untraced, and no task fails with `E-DEP`.
9. `store-lock.test.ts` still passes with the swarm bridge in the tree — no new
   file outside `packages/mcp-server/src` names a Greptime table, imports the
   ledger client or reads `GREPTIME_*`.

**Proof:** run `orch_plan` + `swarm_run` against a scratch repo; a Claude Code
prompt in that repo is preceded by a brief naming the swarm agents that just
worked it, `events_verify` on the Graph ID is green, and A05's token is refused
when it tries to emit as A09.

### S2 — Lifecycle bridge: Task Store ↔ leases and handoffs (SPE-5053)

**Goal:** two agents — swarm or otherwise — cannot work the same node; a dead
swarm replica releases its node by doing nothing; and context crossing an agent
boundary is written down and replayable.

Acceptance criteria:

1. A swarm task entering `IN_PROGRESS` against a repo node calls `graph_claim`
   and keeps the `lease_id`; `task.assign`'s `lease_s` is set from the granted
   TTL rather than independently.
2. The executing agent heartbeats well inside the TTL, and **stops on a
   refusal** — `lost` / `expired` / `unheld` each map to a defined swarm
   transition, with `expired` re-claiming rather than beating.
3. `task.result` / `DONE` goes through `graph_complete`, fenced on `lease_id`;
   `CHANGES_REQUESTED` releases and re-claims so the rework loop is visible in
   the trail; `FAILED` / `CANCELLED` release.
4. Two replicas of one agent class are two lease holders — `session_id`
   distinguishes them, and it is derived from the replica rather than chosen by
   the caller (S1 criterion 2) — and racing claims grant exactly one.
5. A killed swarm replica's node reads as **free** in the next brief, the next
   `drift_scan` and to the next claimant, with no reaper on the path.
6. `force: true` is unavailable to swarm agents: it needs an operator token, and
   no swarm surface token is listed in `SUBSTRATE_OPERATOR_TOKENS`.
7. Every producer→consumer boundary in the interaction matrix that changes
   accountable agent writes a `coord_handoff` packet: `goal`, `files`, `dod` from
   the task's `acceptance[]`, `blockers`, and the sender's chain tip read from
   the ledger. The sender is the authenticated caller and the anchor is read from
   the ledger, so a swarm agent cannot sign as another.
8. `coord_handoff_list` replays a Graph ID's packets with a verdict each, and a
   receiving agent reconstructs a task's context from the ledger alone — no bus
   replay, no Task Store read.
9. With `SUBSTRATE_HANDOFF_KEY` unset, packets are recorded **unsigned and say
   so**, and the swarm run still completes. Fail open: an unauthenticated handoff
   beats a refused one.
10. The swarm Task Store still holds the DAG, budgets, bids and arbitration
    records, and nothing is deleted from it. The bridge is additive.

**Proof:** kill an A05 replica mid-task with the host under load; a second A05
claims the node within one TTL, the trail shows the expiry as a `warning`, and no
two replicas ever hold it at once. Then A05 hands a failed gate to A14 with the
swarm bus stopped between them, and A14 reconstructs the task from
`coord_handoff_list` and `events_query` alone.

### S3 — Swarm memory → governed `memory.write` (SPE-5054)

**Goal:** swarm memory is substrate memory, and a refusal is handled rather than
worked around.

Acceptance criteria:

1. Swarm `memory.write` resolves to `memory_write`; the kind map
   (`decision`→`decision`, `retro`→`fact`, `pattern`→`fact`) is implemented and
   tested, and `scope` maps to `graph:<id>` / `repo:<owner/name>` /
   `agent:<swarm surface>` / `global`.
2. `memory.query` resolves to `memory_search`, and A01's run-start context comes
   from `memory_brief`.
3. Each of the four outcomes has a handler with a test:
   `denied`→`E-POLICY` fail-closed, `quarantined`→recorded and surfaced, not
   retried, `conflict / version.required|stale`→re-read and re-submit with
   `expected_version`, `conflict / review.required`→carried as a proposal.
4. Nothing acts on a write unless `accepted && verified_persisted`. A
   `verified_persisted: false` reply is retried with the **same** idempotency
   key, never a fresh one.
5. Every swarm `memory.write` carries an explicit `idempotency_key` derived from
   `(correlation_id, task_id, attempt, content)`, so at-least-once bus delivery
   cannot produce two entries.
6. Default-deny is proven from the outside: a swarm agent writing at a scope it
   has no grant for is refused, and the test asserts the refusal rather than the
   success.
7. **No swarm-side memory store is read by any agent, proven on the swarm
   side.** `store-lock.test.ts` cannot carry this criterion: it scans this
   repository's TypeScript for memory-table SQL and `insertEntry`, and knows
   nothing about the swarm repo or its vector store. The equivalent check — no
   vector-store or local-KV read on any agent's context path — lives in the swarm
   repo's own suite, and this ADR is not satisfied by the substrate test passing
   alone.

**Proof:** A03 records an architecture decision; it appears in Claude Code's and
Hermes's briefs as a standing decision with a version, and A14's attempt to
replace it without `expected_version` is refused with `version.required`.

### S4 — Install / projector: wire `substrate-mcp` into swarm workspaces (SPE-5055)

**Goal:** a swarm workspace is configured for the substrate by the projector, so
no agent is wired by hand and none is wired to a door that should not exist.

Acceptance criteria:

1. `packages/projector` emits, per swarm workspace, the `substrate-mcp` MCP
   server entry and the surface token for that agent, alongside what
   `build_agents.py --install-workspace` already writes for Claude, Grok and omp
   targets — appended to the existing config arrays, never replacing them, the
   same rule Phase 0 established for Cursor's `hooks.json`.
2. **No generated config anywhere names Greptime as an MCP server.** This is
   store-lock rule 3, and `store-lock.test.ts` already scans `.mcp.json` and
   `.cursor/mcp.json` with `dot: true` — so the install path is proven against
   the check that exists rather than by inspection.
3. No generated config carries a Greptime credential or a Railway host; the
   tracked-file secret scan covers whatever the installer commits.
4. Agents that cannot call an MCP tool get the REST doors instead —
   `POST /brief`, `POST /events`, `POST /memory` — because hooks cannot call MCP,
   which is why those routes exist.
5. Each agent's workspace carries **its own** surface token, not a shared one: a
   shared token collapses the 15 identities S1 established.
6. The installer keeps its existing refusals — nothing written inside the swarm
   checkout, at `$HOME`, under `~/.omp`, or through a symlink — and a dry run
   prints the substrate additions as part of the plan.
7. A fresh workspace install is enough for a swarm run to brief, emit, claim and
   write memory with no manual step, and re-running the install is idempotent.

**Proof:** install into an empty workspace, start a swarm run there, and it
appears in the ledger and in another agent's brief without anything having been
edited by hand — while `store-lock.test.ts` stays green against the generated
configs.

### S5 — Gate verdicts as substrate events, and verification (SPE-5056)

**Goal:** the SDLC record for a business request is tamper-evident end to end,
gate verdicts are part of that record, and it joins to the runtime telemetry.

Acceptance criteria:

1. Gate verdicts (`quality`, `review`, `security`) and escalations land in the
   ledger with their findings, and as `warning`-kind memory. The substrate
   records them and enforces nothing.
2. **A verdict is visible to the drift detectors as work.** `drift.ts`'s
   `WORK_KINDS` is `commit`, `file.edit`, `shell`, `tool.call`, `pr` — it
   excludes `warning`, and drift does not read `payload.swarm_type`. So a gate
   agent that emitted only `warning` events would read as `lease.idle` while
   actively producing verdicts, and an unclaimed gate action would raise no
   `work.unclaimed`. A verdict therefore emits a `tool.call` for the gate run as
   well as the `warning` for the finding, and a test asserts a gate agent holding
   a node is not reported idle.
3. `coord_drift_scan` is run per swarm run and its findings are mapped to swarm
   handling — `work.unclaimed` and `lease.orphaned` to A01 arbitration,
   `git.tip_unlogged` to A13 as a collector-down signal, `ledger.silent` to an
   unwired-agent alert.
4. **The tamper proof is `events_verify`, not the drift scan.** `drift_scan`
   compares git, the trail and the leases and checks no hashes at all, so a row
   whose `payload` was altered while its `kind` and commit fields stayed intact
   passes it. CI runs both, and the chain check is the one that gates.
5. `events_verify` over a whole `correlation_id` — via its bound Graph ID —
   flags a single altered row in any of the 15 agents' sessions. Its guarantee is
   stated as what it is: **one chain per `session_id`**, not one chain across the
   graph. Ordering and completeness across agents are attested by the Phase 6
   Merkle anchor, not by this call.
6. `trace_id` on every emitted event resolves to the OTel trace, and A13 can go
   from an SLO burn to the Graph ID and back. Neither plane duplicates the
   other's data.
7. A release record carries its Graph ID, and the chain from `project.brief` to
   that release record is walkable in the ledger with no gaps attributable to the
   bridge.
8. The Phase 6 Merkle anchor covers swarm events with no special case — they are
   ordinary rows in `agent_events`.
9. The `sim` profile exercises the whole bridge with no real Greptime, no real
   Postgres and no real clouds, and says which live tests it skipped rather than
   mocking them.

**Open on this phase:** the ticket also names a *Desk QUALITY* alignment. That
system is not described in this repo and the ticket body was not readable from
this session, so the criteria above cover the gate-verdicts-as-events half only.
The alignment half needs a line from whoever owns Desk before it can be written
as a checkable criterion.

**Proof:** alter one swarm event row in Greptime — `substrate verify <graph_id>`
flags the graph, and the CI chain check fails on the next run while the drift
scan alone would not have.
## Consequences

**Good**

- One trail. A business request is one Graph ID, and the ledger holds every
  surface's view of it — swarm agents, Cursor, Hermes and Claude Code alike. That
  join did not exist in either system.
- One memory, governed. The swarm inherits default-deny RBAC, quarantine,
  exactly-once, versioned decisions and trust decay without building any of it,
  and its patterns and retros become readable by the eleven non-swarm surfaces.
- Exclusivity that survives death. The swarm's `lease_s` in `task.assign` was
  advisory; a substrate lease expires, is epoch-CAS'd, and is fenced on release.
- The tee is honest about failure. `events.emit` fails open and memory fails
  closed, and the swarm's `E-DEP`/`E-POLICY` split already distinguishes exactly
  those two cases.
- Each phase is independently useful. S1 alone gives cross-surface briefing and
  authenticated attribution; S3 alone gives governed memory. Nothing waits on S5.

**Costs, accepted**

- **Fifteen new surfaces and fifteen new tokens.** Not one shared `swarm` token:
  a shared surface would collapse 15 memory writers and 15 lease holders into
  one, which defeats both RBAC and the lease. Provisioning and rotation get
  wider.
- **Two write paths per event, by design.** The bus for control flow, the ledger
  for the record. They can disagree under partition; the ledger is the one that
  is append-only and chained, so it is the one to believe about *what happened*,
  and the bus remains the one to believe about *what is in flight*.
- **Two signature schemes** (ed25519 envelopes, HMAC handoff packets) and two
  clocks. Neither is unified in this arc.
- **A change to `SURFACES` and to the memory grant table is a change to a
  fail-closed policy.** It is a reviewed change to this repo, not swarm
  configuration — which is the point, and which means S1 cannot be delivered from
  the swarm repo alone.

**Risks**

| Risk | Why it is real | Mitigation |
|---|---|---|
| **A token does not yet bind an identity** | `events_emit` and `graph_claim` take a caller-supplied `surface` ahead of the token's, and `graph_claim` takes `session_id` as an argument. `mcp.ts` says so deliberately — "everywhere else in this file a caller-supplied `surface` is attribution, and naming another surface is at worst a mislabelled event" — which is true for one tenant's collectors and false for a single-writer mesh: there, one compromised or buggy agent can emit as, and claim as, another, and two callers naming one holder identity can renew each other's lease | S1 criterion 2 closes it before anything else in the plan relies on it: the authenticated surface wins on both paths, or the mismatch is refused. This is the single change most load-bearing for the whole ADR, which is why it is in S1 rather than deferred |
| **Two authorities for "who holds this"** — A01's `CLAIMED` state and the substrate lease | They can disagree: A01 can believe a task is claimed after the lease expired | The lease is authoritative for exclusivity, full stop. A refused heartbeat is a defined swarm transition (S2 criterion 2), not a warning to log. `drift_scan`'s `lease.orphaned` and `work.unclaimed` are the detector |
| Memory `global` require-review stalls swarm patterns | The swarm's memory model is write-all/read-all; `global` is not | Patterns land at `repo:` scope by default. `global` is a proposal, and with no `SUBSTRATE_MEMORY_REVIEW_TOKENS` configured the queue simply fills — which is the correct default and must be an operator decision, made once, in S3 |
| At-least-once delivery becomes duplicate memory entries | The bus guarantees at-least-once and the swarm's handlers are idempotent; the substrate's memory gate is idempotent only on a key | Explicit `idempotency_key` on every swarm memory write (S3 criterion 5). Appending kinds are exactly where a missing key shows up as two visible entries |
| The same delivery guarantee becomes a duplicated trail | `normalizeEvent` mints a random event id and `msg_id` is only payload, so the ledger has no natural dedupe and one republished envelope is two rows. An append-only store cannot be cleaned up afterwards | S1 criterion 6: the tee dedupes on `msg_id` before emitting, tested against a deliberate double-publish. Idempotent consumers were never the same claim as an idempotent tee |
| `EVENT_KINDS` is closed and the swarm's `type` catalog is not | A type with no good mapping gets forced into `note` and the trail loses meaning | The map is documented and tested, `payload.swarm_type` always carries the exact type, and an unmapped type is a test failure rather than a silent `note`. Widening the enum is a separate, chain-affecting decision |
| The bridge becomes the thing that blocks a swarm run | The substrate's first non-negotiable is fail-open, and a bridge is new code on a hot path | S1 criterion 8 is the test: `substrate-mcp` stopped, full DAG completes. Memory is the deliberate exception, and it is an exception at the *server*, not the client |
| **A green substrate test read as a swarm guarantee** | `store-lock.test.ts` scans *this* repository. It cannot see the swarm repo, so it can pass while a swarm agent still reads its own vector store — and the criterion it appears to prove is exactly the memory-bypass non-goal | S3 criterion 7 puts that check in the swarm repo's own suite and says explicitly that the substrate test passing alone does not satisfy it |
| Greptime and the index are on infrastructure this host cannot see | Both are external Railway endpoints (`.planning/PROJECT.md`) | Unchanged by this ADR, and the reason the `sim` profile in S5 criterion 9 skips rather than mocks |
| Scope creep into replacing NATS | The tee makes it look adjacent and cheap | Non-goal 3, and no S1–S5 criterion mentions the transport |
| The plan drifts from the tickets | An earlier draft of this ADR invented its own S1–S5 order, swapped memory and leases, and dropped the install/projector phase — owners following it would have worked the wrong acceptance criteria | The phase table names the ticket per phase, and the tickets' order is authoritative over this document. A phase this ADR cannot read (see S5's open item) is marked open rather than filled in |

## References

- [`swcstudiospace/agent-swarm`](https://github.com/swcstudiospace/agent-swarm) —
  [README](https://github.com/swcstudiospace/agent-swarm/blob/main/README.md),
  [01-architecture](https://github.com/swcstudiospace/agent-swarm/blob/main/01-architecture.md),
  [02-message-protocol](https://github.com/swcstudiospace/agent-swarm/blob/main/02-message-protocol.md),
  [04-integration-plan](https://github.com/swcstudiospace/agent-swarm/blob/main/04-integration-plan.md)
- [SPE-5050](https://linear.app/swcstudio/issue/SPE-5050) (parent) ·
  [SPE-5051](https://linear.app/swcstudio/issue/SPE-5051) (this ADR) ·
  [SPE-5052](https://linear.app/swcstudio/issue/SPE-5052) (S1) ·
  [SPE-5053](https://linear.app/swcstudio/issue/SPE-5053) (S2) ·
  [SPE-5054](https://linear.app/swcstudio/issue/SPE-5054) (S3) ·
  [SPE-5055](https://linear.app/swcstudio/issue/SPE-5055) (S4) ·
  [SPE-5056](https://linear.app/swcstudio/issue/SPE-5056) (S5)
- This repo: [`docs/greptime-ledger.md`](../greptime-ledger.md),
  [`docs/memory-governance.md`](../memory-governance.md),
  [`docs/coordination.md`](../coordination.md),
  [`.planning/PROJECT.md`](../../.planning/PROJECT.md),
  [`.planning/ROADMAP.md`](../../.planning/ROADMAP.md)
