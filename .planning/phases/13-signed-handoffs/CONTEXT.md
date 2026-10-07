# Phase 13: Signed handoffs - Context

**Gathered:** 2026-10-07
**Status:** Executing
**Mode:** Auto-accepted. Decisions come from ADR 0001 S2 criteria 7-10 and its proof, REQUIREMENTS HAND-01..03 and PROOF-02, the Phase 11 server contract (`coord_handoff`, `coord_handoff_list`, `coord_handoff_verify` in `packages/mcp-server/src/{mcp,service,handoff}.ts`), the interaction matrix (`04-integration-plan.md` §1, §3) and the Phase 12 lease bridge.

<domain>
## Phase Boundary

agent-swarm side of S2's handoff half (Linear SPE-5053). `scripts/swarm_run.py` and `swarm/results.py` write one `coord_handoff` packet, as its sender, at each producer→consumer boundary that changes the accountable agent. A new `swarm/substrate_handoff.py` rebuilds a receiving agent's task context from the ledger alone. Branch `feat/v1.2-p13-handoffs` from Phase 12's head `f3411b9`. The server half (sender = authenticated caller, anchor read from the ledger, `SUBSTRATE_HANDOFF_KEY` signing, `release_lease` after the append, `lease_handover` instead of the id) is shipped in Phase 11 and is not changed here. Per-agent env files are Phase 14.

</domain>

<decisions>
## Implementation Decisions

### Locked (2026-10-07)
- The sender is the authenticated caller. The runner writes each packet with the sender's own surface token, through the one token-lookup seam Phase 12 uses (`substrate_lease._call`).
- Fail-open: an unreachable substrate records a warning, and the run continues.
- `reconstruct(graph_id, node_id)` lives in a new `swarm/substrate_handoff.py` and reads `coord_handoff_list` and `events_query` only.

### Claude's Discretion
- **Boundaries.** These are derived from the matrix and from code the runner already runs. A boundary is a point where the agent accountable for a node changes:

  | Boundary | Code point | Sender → receiver | `node_id` |
  |---|---|---|---|
  | Dependency: a task is dispatched and a `depends_on` task belongs to another agent. Matrix rows: A02/A03/A04/A07 artifacts → implementers; code (A05/A06/A07) → A08/A09/A10 (gate tasks depend on the code); A14 `patch.task`/`hotfix.task` → A05 (hotfix `rca → patch`, dependency `patch → bump`). | `swarm_run._execute_one`, before the prompt is built | upstream task's agent → dispatched task's agent | the dispatched task |
  | Gate: a gate fails a task and it goes back to the producer for rework (CHANGES_REQUESTED → IN_PROGRESS). Matrix: `gate.verdict:quality` (A08), `review.verdict` (A09) and `security.gate.verdict` (A10) → A05/A06/A07. | `results.reconcile` | the agent that issued the failing verdict (row `agent_id`, else the gate's agent: quality A08, review A09, security A10, release A12) → producer | the failed task |
  | Escalation: the swarm gives up on a task. ESCALATED by the rework cap (`reconcile`) or by `max_attempts` (`dispatchable`). | `results.reconcile`, `swarm_run.dispatchable` | producer → **A14** when a direct upstream task is A14's, else **A01** | the escalated task |

  The escalation owner is A14 when the task carries out an A14 work order, because A14 is the single writer of `patch.task`/`hotfix.task` (matrix §1) and its decision rules own "bump breaks gates" (`03-agents/A14-maintenance.md`). That is the ADR proof's "A05 hands a failed gate to A14". Everything else goes to A01, which arbitrates (§5). `escalation.request` is still emitted as before, so the packet is additive. Not boundaries:
  - APPROVED → DONE: verdicts go to A01, and nothing is handed on.
  - A gate stall: no transition happens, and the producer keeps the node.
  - BLOCKED: the same agent resumes once A01 releases it.
  - Same-agent dependency edges.
  - The `orch_status` in-session path: it holds no leases in this phase either.
- **One packet per boundary.** One per dependency edge, one per failing gate, one per escalation.
- **Where the runner writes.** `swarm_run.handoff_bridge` builds one `HandoffBridge` per run, on exactly when the `LeaseBridge` is: never on `--dry-run`, and off when the integration is off. Every call goes through `substrate_lease._call(tool, args, sender_surface, env)`. That function, and its new sibling `has_own_token(surface, env)`, are the two Phase 14 swaps for the agent's env file. `has_own_token` exists because `coord_handoff` names no surface: on the fallback `SUBSTRATE_TOKEN` (A01's), the packet would be recorded and signed as A01's. So a sender with no token of its own is not sent: `handoff.refused`. A ledger record under another surface than the sender's is reported as `handoff.misattributed`. `substrate_client.own_token` is factored out of `_token` so the two cannot disagree.
- **Field mapping.**
  - `goal`: the dispatched task's title and capability, and what it builds on. For a gate, `Rework <title>: the <gate> gate failed (rework n of 2)`. For an escalation, `Take over <title>: <reason>`.
  - `dod`: the receiving node's `acceptance[]`, one line each, an object as compact JSON.
  - `files`: `outputs[].uri` of the upstream task (dependency) or of the task itself, plus each finding's `file`/`path`.
  - `blockers`: `[]` for a dependency, which claims nothing is known to be in the way. For a gate, one line per finding: `<gate> [<severity>] <summary> (<file>:<line>)`. For an escalation, the failing findings and the reason.
  - `graph_id`: the run's Graph ID.
  - `node_id`: the node the receiver works next.
  - `to`: the receiver's surface.
  - `session_id`: the sender's `<AGENT>@<replica>:<graph_id>`.
  - `to_session_id`: the receiver's, for a dependency or gate, since this runner dispatches it. Omitted for an escalation.
  - `notes`: first line `boundary: <key>`, then a short body: the upstream's `summary_md`, the rework instruction, or the counts.
  - The runner fits each packet under 9 kB itself (files, then blockers, then DoD, the server's order) and says so in `notes`, so the server's 12 kB fitting, which drops `notes` first, never runs and never loses the key.
- **Lease: handed over only at escalation.** A dependency sender's lease is on its own node, held through review until DONE (LEASE-07), so it is kept. A gate agent holds no lease on the failed task, and the producer's rework already releases and re-claims (Phase 12). An escalation by the rework cap happens in review, where the producer still holds the node. That packet carries `lease_id` + `release_lease: true`, so the server releases only once the packet is durable, and the node never reads free without an account. The packet records `lease_handover: true`, never the id. On `lease_released: true`, `LeaseBridge.handed_over(task)` stops beating and mirrors `released` / `handover`. Otherwise `settle` releases as before. A `max_attempts` escalation holds no lease, because FAILED released it.
- **Idempotency.** The key is `<round>/<part>`: `dispatch@T/dep:D`, `rework<n>@T/gate:<gate>`, `escalated-a<attempt>r<loops>@T/<sender>`. Each runner process reads the graph's `coord_handoff_list` once (as A01), and skips a key the ledger holds **from that sender's surface**. It reserves a key before sending, so concurrent sends of one boundary collapse. Keying on the sender means another agent's packet that quotes a boundary cannot suppress the real one. Re-runs, rework or retry re-dispatches, and restarted runners write nothing twice. Two runners reconciling one Task Store cannot both write a gate or escalation packet, because the transition is a compare-and-swap.
- **Fail-open.**
  - No answer, a server error, `stored: false`, an unanswered list, or no Graph ID → `handoff.unsent` (`warning`), once per key. The packet is queued, and `flush()` retries it at the start of each round and after the last one. A retry never hands a lease over.
  - A refusal, or no own token → `handoff.refused` (`warning`), not retried.
  - No bridge method raises into the runner.
- **Unsigned (HAND-03).** With no `SUBSTRATE_HANDOFF_KEY` the server stores `signature: null` and answers `signed: false`. The runner records `handoff.unsigned` once per run, and the run carries on unchanged. `reconstruct` marks such packets `unsigned`, uses them, and the prompt section says *UNSIGNED … unauthenticated*.
- **Reconstruction (HAND-02).** `reconstruct(graph_id, node_id, *, agent, env) -> Context` makes two reads as the receiving agent's surface: `coord_handoff_list {graph_id}` and `events_query {graph_id, node_id, order: desc, limit: 50}`. It reads no Task Store, no run log, no Graph ID cache, and no file. It takes `graph_id` as an argument, so it never looks one up.
  - `packets`: every packet for the node, oldest first, with `from`, `to`, `boundary`, the server's `verdict` and a `trust`. Trust is `verified` for `ok: true`; `unsigned` for `unsigned` or `no-keys-configured`, which the server calls unauthenticated, not forged; and `rejected` for `bad-signature`, `unknown-key`, `unknown-alg` or `malformed`, which is listed and never used.
  - `goal`, `dod`, `sender`, `lease_handover`: the newest usable packet.
  - `blockers`: every usable packet of the newest round, e.g. all gates failed in one review.
  - `files`: every usable packet.
  - `signed`: the newest round all verified.
  - `events`: the node's trail.
  - `status`: `ok`, or the list's outcome.
- **The runner uses it.** `_execute_one` writes the dispatch's dependency packets first, then puts `render(reconstruct(...))` into the assignment as a `## Handoffs (from the substrate ledger)` section after the Task Store's upstream section. A session therefore starts from what its senders wrote, and the Task Store sections stay, so the bridge is additive. An agent outside the runner, such as A14 on an escalated patch, calls `reconstruct` or the same two MCP tools. It is exposed as a function, not a new script.
- **Run-log types.** `handoff.unsent`, `handoff.refused`, `handoff.unsigned` and `handoff.misattributed`, all `warning`, one row each in `TYPE_KINDS`. A packet that lands is not re-emitted, because the server writes its own `handoff` event carrying the packet.
- **Tests.** `tests/test_substrate_handoff.py` extends test_substrate_lease's fake with the three handoff tools, following the server's rules: the sender is the token, HMAC signing over everything but the value, unsigned without a key, a verdict per listed packet, and release only after the append. It proves that no local read took part with an audit hook on `open`/`sqlite3.connect`, the state directory deleted, and `TaskStore.__init__` failing.
- **Live proof.** `/tmp/p13-proof.sh` runs against the Phase 11 server on :7499 (smoke Postgres and GreptimeDB, `SUBSTRATE_HANDOFF_KEY` set). It drives the branch's `LeaseBridge`, `HandoffBridge`, `swarm_run.select_batch`/`execute_one` (agent CLI stubbed), `results.reconcile` and `reconstruct`.
  - (a) A05@r1 holds a node mid-task in its own process with the keeper running, one busy loop per CPU. It is SIGKILLed, and A05@r2 polls its claim and is granted within one TTL. A `graph_get` poller asserts that the holder changes exactly once with no overlap, and the trail shows the `stolen` `warning`.
  - (b) A05 fails the quality gate to the rework cap and hands the patch to A14. No broker process runs, so the swarm bus is the run log. The run log and the Task Store are moved away and set to mode 000. A14, in a separate process holding only its own token and an audit hook, rebuilds the task, verifies the packet and claims the node.

</decisions>

<code_context>
## Existing Code Insights

- `results.reconcile` reads `latest_verdicts` before `transition(CHANGES_REQUESTED)`. The transition sets `verdicts_since`, after which those rows read as stale, so the gate packet must use the rows `reconcile` already holds.
- `taskstore.transition(CHANGES_REQUESTED)` turns into ESCALATED past `MAX_REWORK_LOOPS` (2), with `rework_loops` left at 2, so the escalation key `escalated-a<attempt>r<loops>` is stable.
- `substrate_client._token` falls back to `SUBSTRATE_TOKEN` when the surface's own token is missing. That is harmless for a claim, which the server refuses because the surface argument and the token disagree. For `coord_handoff` it would be a false attribution, since the tool has no surface argument.
- The server's `handoffsForGraph` reads the graph's events from GreptimeDB and verifies each packet. `fitPacket` drops `notes` first above 12 kB.
- `runlog.py` calls itself "the local stand-in for the NATS bus". The local swarm has no broker process.

</code_context>

<deferred>
## Deferred Ideas

Packets on the in-session `orch_status --ingest`/`--transition` path. Per-agent env files and the child's token (Phase 14). Persisting unsent packets across runs. A `handoff_context` CLI for agents that cannot call MCP (none are executors, per ADR S4 criterion 6).
</deferred>
