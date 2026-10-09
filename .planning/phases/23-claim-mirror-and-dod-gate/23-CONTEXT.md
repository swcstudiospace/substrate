# Phase 23: Claim mirror and DoD gate - Context

**Gathered:** 2026-10-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Linear and Notion show who holds each node as its lease changes. The lease stays authoritative when a tracker fails, and only hermes-linear-connector's Definition-of-Done gate can mark an issue Done (MIRROR-01..08, build plan §3.3, research area B).

In scope:
- Port `acc30a8:packages/mcp-server/src/{linear,notion,mirror,dod-gate}.ts` and their tests (`notion.test.ts`, `mirror.test.ts`; new `linear.test.ts` and `dod-gate.test.ts`) into `packages/mcp-server/src` as **leaf modules**: they import only `./types.ts`, `./config.ts` and each other, never `service.ts`, `index-store.ts` or `lease.ts`.
- Hook the mirror onto **main's existing lease decisions** (`lease.ts` `ClaimAction` / `ReleaseAction` and the reaper): `granted`, `reclaimed`, `stolen`, `released`, `forced` and expired/reaped. The mirror never decides ownership; it is told the decision and the holder. No second ownership model: September's `ownershipRefusal`, `holder()`, `lostClaim()`, `setNodeState` and its pre-lease `completeNode` are **not** ported.
- `graph_complete` gains an optional `dod` and the gated path to `{HERMES_LINEAR_URL}/v1/complete-issue`, ahead of main's one-statement fenced completion.
- Two new read tools: `graph_find` and `issue_get` (both already fail-open in `packages/audit/src/policy.ts` since Phase 17).
- Config: `HERMES_LINEAR_URL`, `SUBSTRATE_DOD_GATE_TIMEOUT_MS`, and tracker endpoint overrides used only by the rehearsal.
- A harness rehearsal of every transition against loopback tracker fakes, and the MIRROR-08 live proof runbook. The live proof itself waits for operator approval.

Out of scope: the dispatcher (Phase 24, which consumes `graph_find`, `issue_get` and the claim mirror's `dispatch:*` removal); Lane A's use of the clients (Phases 31-33); a periodic reaper unit; Linear sub-issue mirroring (MIRROR-09, v2).

</domain>

<decisions>
## Implementation Decisions

### Transition table: which lease decisions write what
- **D23-01:** Hook points (service layer, after main's decision is final):
  - `claimNode`: mirror only when the verdict is `granted` (the hold stands) and `decision.action` is `granted`, `reclaimed` or `stolen`. `renewed`, `denied` and a ledger-`revoked` claim write nothing. That is "a losing claimant writes nothing" (MIRROR-05).
  - `releaseNode`: mirror `released` and `forced`; `noop` and every refusal write nothing.
  - `reapExpiredLeases`: mirror each reaped lease as `expired`. The reaper's CTE gains `linear_issue_id` and `notion_page` in its select list, so the mirror needs no second read. Lazy expiry with no reap is mirrored by the next claim's `stolen`/`reclaimed`.
  - `completeNode`: see "DoD gate" below.
- **D23-02:** Non-swarm holder (MIRROR-02/03):
  - `granted` / `reclaimed`: one `issueUpdate` sets the team's first `started` state, adds `agent:<surface>`, and removes every `dispatch:*` and every other `agent:*`. Then one comment `Claimed by <surface> — session <sid> (graph <g>, node <n>)`, exact text, skipped when an identical body is among the issue's last 20 comments (one comment per session; a same-session reclaim posts nothing new). Notion sets `Agent` = surface and `Linear State` = the name of the state just set.
  - `stolen`: the same as a claim for the new holder. The label moves: `agent:<evicted>` is removed and `agent:<new>` added in that single update, and the new session gets its own claim comment.
  - `released` / `expired` / `forced`: one `issueUpdate` sets the team's first `unstarted` state and removes every `agent:*`. Notion clears `Agent` and sets `Linear State` to that state's name. No comment: Linear's own history shows the change.
  - `renewed`: nothing, ever. Heartbeats never reach a tracker.
- **D23-03:** Swarm exception (operator decision 2026-10-08). When the holder of the transition (the new holder for claims and steals, the departing holder for releases, expiry and force) is a `swarm-*` surface (`isSwarmSurface`, `types.ts`), the mirror posts **one Linear comment only**. It never changes state or labels and never touches the Notion row. Comment bodies (idempotent by exact body): `Claimed by <s> — session <sid> (graph <g>, node <n>)` (same as MIRROR-02), `Released by <s> — …`, `Lease expired for <s> — …`, `Lease forced off <s> — …`, `Completed by <s> — …`. A dedicated test drives every transition with a swarm holder and asserts zero `issueUpdate`, zero label calls and zero Notion requests. Edge accepted under the strict reading: a steal **from** a non-swarm holder **by** a swarm holder leaves `agent:<evicted>` in place (listed in the open questions).
- **D23-04:** The mirror never sees a `lease_id`. `MirrorContext` has no lease-id field (graph, node, holder surface and session, evicted holder, epoch, Linear ref, Notion page). A leak test runs every transition, the gate and both read tools with a planted lease id and asserts it appears in no fetch URL or body sent to Linear, Notion or the connector, in no emitted event and in no tool reply. Comments carry surface, session, graph and node only.

### Linear client (MIRROR-01)
- **D23-05:** Port `linear.ts` with its 5 s per-call timeout, raw `Authorization: <key>`, error messages carrying status and at most 200 characters of body (never the key or headers), and `updateIssue`, which has no `labelIds` parameter (additive `addedLabelIds`/`removedLabelIds` only).
- **D23-06:** States are resolved by type, through the issue's own team, ordered by `position`. `issueContext` also fetches `position`. "First `started`" is the lowest-position `started` state (In Progress, not In Review). "First `unstarted`" is the lowest-position `unstarted` state (Todo). In Review is the one exception, resolved by name: a `started` state named `In Review`, case-insensitive. Its absence is a mirror failure, never a fallback. The substrate never resolves or sends a `completed` (Done) state id. This reconciles MIRROR-01 ("by type") with September's finding that `started` alone is ambiguous.
- **D23-07:** `ensureLabel`: the team's label first, then a workspace label, then a new team label, with a re-search after a create error. Cached per `teamId:name` for the process lifetime.
- **D23-08:** Workspaces. SWC (the connector's workspace, Free plan, 250 active issues, at the cap in September) and SPE (`swcstudio`) are different workspaces, and `LINEAR_API_KEY` reaches one of them. Identifiers are never hard-coded; every call goes through the node's `linear_issue_id ?? linear_identifier`. An issue the key cannot see is one `warning` per transition, never an error.
- **D23-09:** The mirror creates no Linear issues, so it consumes no Free-plan slots. Only `agent:<surface>` labels may be created.

### Notion client (MIRROR-06)
- **D23-10:** Port `notion.ts` unchanged in rules: `Notion-Version: 2025-09-03`; `NOTION_WRITABLE = Agent, Status, Linear State, Completed`, with any other property refused before a request is sent. Every PATCH is preceded by a GET that requires `parent.data_source_id` to equal `NOTION_TASK_GRAPH_DS` (dash- and case-insensitive). Values are shaped by the type the page reports (Agent is `rich_text`, Status `status`, Linear State `select`, Completed `date`, per `acc30a8 02-NOTION-SCHEMA.md`).
- **D23-11:** `Linear State` is written only when the Linear step of that transition ran and succeeded (it mirrors what substrate just set). On approval (after the connector moved the issue to Done) the write is `Status: Done`, `Linear State: Done` and `Completed: <date>`.
- **D23-12:** One GET plus one PATCH per transition, never per heartbeat.

### DoD gate on `graph_complete` (MIRROR-04)
- **D23-13:** `graph_complete` keeps `graph_id`, `node_id`, `lease_id`, `force` and `state`, and gains `dod?: { summary: string (non-empty, capped), tests_pass: boolean, review_pass?: boolean }`.
- **D23-14:** Which completions are gated: a non-forced completion to `completed` (the default state) of a node that has a Linear reference and a non-swarm holder. Without a Linear reference, main's completion runs unchanged, so harness and non-Linear graphs behave exactly as on main. A forced completion, or `state` other than `completed`, is not gated: the index is completed by main's fenced path, and the mirror removes `agent:*` and clears Notion `Agent` but leaves Linear's state alone (op `close`). A swarm holder's completion is not gated either: main's completion runs and the only tracker write is the `Completed by` comment.
- **D23-15:** Gated sequence:
  1. **Fenced review write.** A new index method writes `state = 'started_review'` under the caller's lease, in one UPDATE fenced on `lease_id`, unexpired, with the holder check that `decideHeartbeat` makes. It also extends the lease by the TTL, because the gate may take up to 35 s. This is the only new state write, and it names its lease, which keeps the `index-store.ts:732` rule (no unfenced `setNodeState`). A refusal (`not-holder`, `stale-lease`/`lost`, `expired`, `unheld`) returns main's refusal shape and writes no tracker.
  2. If Linear already reports the issue as `completed` (an earlier gate timed out after the connector moved it), skip to step 5.
  3. Mirror review: Linear goes to In Review and Notion `Linear State` to In Review. A failure is a warning, and the sequence continues.
  4. **No `dod` → the connector is not called.** Return `completed: false, reason: "dod-required"`. The node stays `started_review` and the lease is kept. Calling the connector without evidence is unsafe: `SyncEngine.complete_issue` (connector `6e532fe`) also approves when a linked Kanban task's stored `dod_pass` is set, which would let an evidence-free completion reach Done. **With `dod`**: `POST {HERMES_LINEAR_URL}/v1/complete-issue` with `{linear_issue_id, summary, tests_pass, review_pass}` (no auth, as the connector serves it). Only an explicit `completed: true` counts. A non-2xx, unreachable or malformed reply is a refusal. A timeout (default 35 s, above the connector's own 30 s Linear call) is settled by reading the issue's Linear state, and only a `completed` type counts.
  5. **Approved:** main's one-statement fenced completion (`releaseNode(..., "completed")`) runs with the caller's `lease_id`. Its release `note` carries `payload.dod` (`tests_pass`, `review_pass`, `summary_chars`; never the summary text), the Phase 17 `lease.release.dod` row. Notion gets the done write. If the fence fails after Linear is already Done, the result is `completed: false` with main's refusal reason, plus one `warning` `{action: "dod", reason}`. Notion still records Done, because Linear is Done.
  6. **Refused, error or unknown:** one `warning` `{action: "dod", reason}` (the Phase 17 `dod.refused` row). Return `completed: false, reason: "dod-refused" | "dod-unavailable"`, with `detail` set to the connector's reason (redacted, capped). The node stays `started_review` and the lease is kept.
- **D23-16:** Only the connector ever moves an issue to Done (D-06). If the operator's `force` should ever close Linear, that remains a connector or manual act.

### Failure semantics and observability (MIRROR-05)
- **D23-17:** The mirror runs **after** the lease decision is final and is **awaited inside the tool call** (deterministic, test-friendly, the September shape). The calls for one node are serialized through an in-process per-`graph_id/node_id` chain, so a release's mirror cannot overtake its claim's. The mirror never throws, and a failure never rolls a lease back.
- **D23-18:** One `warning` per failed target, in the Phase 17 `mirror.failed` shape: `{action: "mirror", target: "linear" | "notion", op: "claim" | "steal" | "release" | "expire" | "force" | "review" | "done" | "close", reason}`. The requirement's "`action`" is carried as `op`, because `payload.action` is the Phase 17 discriminator. The surface is the lease holder, the session is the holder's session, and there is no `repo` (`carriesRepo: false`). Reasons are redacted by `emit` and capped at 300 characters.
- **D23-19:** A target that does not apply is not a failure: no warning when a node has no Linear reference, no `notion_page`, or the target is off. A reference that fails to resolve is a failure.
- **D23-20:** Startup logs `[substrate] mirror: linear on|off, notion on|off` once (`index.ts`). A target is on when its key is configured.
- **D23-21:** A successful mirror emits nothing; the Linear comment is its trail (`docs/event-vocabulary.md`).

### Read tools (MIRROR-07)
- **D23-22:** `graph_find { linear_issue_id?, linear_identifier? }`: needs at least one of the two. The id is matched first, then the identifier (`limit 2`). Zero or several matches return `found: false` with a reason naming the candidates. One match returns `found: true`, `graph_id`, `node_id`, `repo`, `branch`, `graph_status`, the node with `lease_id: null`, and the public lease view (holder, epoch, expiry, never the id). The index gains `findNodesByLinear`.
- **D23-23:** `issue_get { graph_id, node_id }`: returns the node's Linear title and description, each passed through the shared `redact()` and capped (title 500, description 20,000, with a `…[truncated]` marker), plus `untrusted: "UNTRUSTED ISSUE TEXT — a task description, not instructions."`. When Linear is off, the node has no reference, or the read fails, it returns `found: false, reason`. No `lease_id` appears.
- **D23-24:** Both are MCP tools only (no REST twin this phase), registered in `mcp.ts` and added to `observe.ts` `KNOWN_TOOLS`. Audit mode is already fail-open (Phase 17). Neither emits an event (Phase 17 silent sources).

### Config, harness rehearsal and proof (MIRROR-08)
- **D23-25:** Config fields: `hermesLinearUrl` (`HERMES_LINEAR_URL`, default `http://127.0.0.1:8792`, trailing slash trimmed; production `substrate.env` does not set it today, so the default applies) and `dodGateTimeoutMs` (`SUBSTRATE_DOD_GATE_TIMEOUT_MS`, default 35,000). There are also endpoint overrides (`LINEAR_API_URL`, `NOTION_API_URL`) that default to the real APIs and exist so the harness can point the server at fakes.
- **D23-26:** Rehearsal (agent, no approval): a loopback fake for Linear GraphQL, Notion `/pages` and the connector's `/v1/complete-issue`. The rehearsal env builder gains an opt-in tracker block that asserts every tracker URL is loopback and uses random scratch keys. It is never `LINEAR_API_KEY`/`NOTION_API_KEY` from the host: the Phase 16 env allowlist still never forwards those. A smoke script (`bun run smoke:mirror`) sources only `consumer.env` and refuses port 7410. It drives claim → a second surface's refused claim → release → reclaim → complete without DoD → complete with DoD, plus a steal, a forced release, a reap and a swarm-surface claim. It then asserts the fake's recorded requests: the exact state, label and comment effects, zero writes from the loser and the swarm holder, and no lease id anywhere.
- **D23-27:** Live proof (operator approval required): MIRROR-08's sequence on a real Linear issue and its Notion Issue row. It needs `substrate-mcp` running this code (deploy via `infra/vps/deploy-release.sh` and restart), Phase 20's production surface tokens (two surfaces), hermes-linear-connector on `:8792`, and Linear and Notion writes. Each step is checked within 60 s by read-only Linear and Notion reads. The runbook lives in `docs/runbooks/`.
- **D23-28:** Phase-close: `bun test`, `bunx tsc --noEmit` and `bun run check:phase-close`. The `EVENT_SOURCES` rows for 23 are used as-is. If the payload of the implemented `mirror.failed` or `lease.release.dod` row differs from the sample, the table and the doc change together in the same PR.

### Claude's Discretion
- Module-internal shapes (`MirrorContext` fields, the per-node chain implementation, the comment helper), as long as there is no lease-id field.
- Exact names: the fenced review-write index method, reason strings beyond `dod-required` / `dod-refused` / `dod-unavailable`, and the fake tracker server.
- Whether the tracker fakes live in one script or in a module under `packages/mcp-server/src` (store-lock and redact-lock rules apply).
- Plan split. A suggested shape: leaf clients and config → mirror module → lease hooks → DoD gate → read tools → rehearsal, docs and live-proof runbook. Plans that touch `service.ts` run in sequence.
- Doc placement: a "Tracker mirror" section in `docs/coordination.md` replacing the "no Linear client" note at `:321-325`, with tool descriptions updated.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `lease.ts`: `ClaimAction` (`granted|renewed|reclaimed|stolen|denied`), `ReleaseAction` (`released|noop|forced`), `decideHeartbeat` (the holder and lease fence to reuse for the review write), `holderOf`, `leaseView` (public, no id).
- `service.ts`: `claimNode` (`:892`, mirror after the verdict, `decision.evicted`), `releaseNode` (`:1033`, `decision.holder` is read before the row is cleared), `completeNode` (`:1090`, `releaseNode(..., "completed")`), `reapExpiredLeases` (`:1118`, `payload.action: "expired"`), `withoutLeaseIds` (`:98`), `placeOf`, `emit` (fail-open, redacting).
- `index-store.ts`: `releaseNode` with `alsoSetState` (`:589`), `heartbeatNode`'s fenced UPDATE (`:557`) as the template for the review write, `reapExpiredLeases` CTE (`:655`), and the "no `setNodeState`" rule (`:732`).
- `config.ts:200-202`: `linearApiKey`, `notionApiKey` and `notionTaskGraphDataSource` already parsed (default DS `be3418f0-…`).
- `types.ts`: `isSwarmSurface`, `NODE_STATES` (includes `started_review`), and the `GraphNode` fields `linear_issue_id`, `linear_identifier` and `notion_page`.
- `redact.ts`: `redact()` for `issue_get` text (the redact lock forbids any other redactor).
- `event-sources.ts`: Phase 23 rows `mirror.failed`, `lease.release.dod`, `dod.refused`, and the silent `issue_get`, `graph_find`, `mirror`.
- `rehearsal-env.ts` (`buildRehearsalEnv`, `assertLoopback`) and `scripts/rehearsal.ts`, `scripts/vocabulary-smoke.ts` as the harness smoke template.
- Port sources: `git show acc30a8:packages/mcp-server/src/{linear,notion,mirror,dod-gate}.ts`, `{notion,mirror}.test.ts`, and the `service.ts` sections for `getIssue`/`findNode`/`completeNode`/`askGate`/`warn` (`:225-296`, `:405-560`), `mcp.ts:219-245`, and `index-store.ts` `findNodesByLinear`.

### Established Patterns
- Every external client takes an injected `fetchImpl` and timeout; tests never touch the network or the production paths. No `@linear/sdk` or `@notionhq/client` (STACK.md).
- Tests use the `Substrate` constructor's `stores` seam; it gains `mirror?` and `dodGate?`, as September had.
- Lease ids reach only the holder: events carry `lease_epoch`, replies to non-holders carry `lease_id: null`.
- Every new MCP tool needs `mcp.ts registerTool`, `observe.ts KNOWN_TOOLS` and an audit-policy entry (already present).
- Docs and tests ship in the same PR; `docs/event-vocabulary.md` and `event-sources.ts` change together.

### Integration Points
- `packages/mcp-server/src/{service,mcp,config,index-store,index,observe}.ts`, the new `{linear,notion,mirror,dod-gate}.ts` and their tests, `service.test.ts`/`server.authority.test.ts` for completion on Linear-linked nodes, `rehearsal-env.ts` and `scripts/` for the smoke, and `docs/coordination.md` and `docs/runbooks/`.
- Phase 21 (executing) also edits `service.ts`, `mcp.ts`, `config.ts` and `observe.ts`. The edits are additive, but expect merge conflicts on rebase.
- Phase 24 consumes `graph_find`, `issue_get` and the claim mirror's `dispatch:*` removal. Phases 32-33 reuse `LinearClient`/`NotionClient`.

</code_context>

<specifics>
## Specific Ideas

- The connector contract is pinned from `hermes-linear-connector@6e532fe` `webhook_app.py:126-141`: request `{linear_issue_id, summary, tests_pass, review_pass}`, response `{completed, reason, linear_issue_id}`, HTTP 502 on an engine error. Its rule is `tests_pass && summary.strip()`, or stored Kanban `dod_pass`. `dod-gate.test.ts` holds this as a versioned fixture.
- September decisions D-02 (fail-open mirror), D-03 (additive labels), D-05/D-06 (release, gate), D-07 (Notion field ownership) and D-15 (untrusted issue text) are carried forward. See `git show acc30a8:.planning/phases/02-claims-and-dispatch/02-CONTEXT.md` and `02-RESEARCH.md`.
- September's live proof reused issue `SWC-467` and graph `ut-mughkkc0-73909228`, because the SWC workspace was at 249-250/250 active issues.
- The Linear API budget is 2,500 requests/hour per user across keys, shared with `hermes-linear-poller`'s 2 s poll. One transition costs about 3-5 Linear requests.

</specifics>

<deferred>
## Deferred Ideas

- A periodic reaper unit (timer calling `coord_reap_leases`), so expiry reaches Linear without a caller. Today it is mirrored only when something reaps, or by the next claim.
- A REST twin `POST /issue` for `issue_get`, if Phase 24 needs one.
- Linear `X-RateLimit-*` back-off in the client.
- A second Linear key so one substrate can mirror both the SWC and SPE workspaces.
- Linear sub-issue mirroring per Chain-of-Thought step (MIRROR-09, v2).

</deferred>

## Open questions for the operator (user-visible, recommended answers assumed)

1. **Completion on Linear-linked nodes now needs `dod`.** Every non-swarm `graph_complete` on a node with a Linear reference returns `dod-required` without `dod`, and leaves the node `started_review` with the lease held. Callers outside this repo (ultrathink skills, Hermes) must pass `dod`. Recommended: accept (it is MIRROR-04), and state it in the tool description, the docs and the PR's live-effect line.
2. **MIRROR-08 proof issue.** Which issue and workspace? `LINEAR_API_KEY` reached only SWC in September, and SWC is a Free-plan workspace at its 250-issue cap. Recommended: reuse `SWC-467` and its Agent Task Graph Notion row on a fresh graph (no new issue), after the operator confirms the issue is unarchived and visible to the substrate key and the connector.
3. **Swarm steal edge.** A swarm surface taking over a lapsed non-swarm lease posts only its comment, so `agent:<evicted>` stays on the issue. Recommended: accept the strict "comment only" exception (pinned by test). The alternative is to remove the evicted holder's label in that one case.
4. **No comment on non-swarm release, expiry or force.** Linear's history shows these as state and label changes only. Recommended: accept. The alternative is a one-line comment per transition, which costs Linear requests.
