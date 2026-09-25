# Phase 2: Claims and dispatch - Context

**Gathered:** 2026-09-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Labelling a Linear issue `dispatch:<surface>` starts that agent on that node. Delivers:

- `graph_claim` mirrors to Linear (state `started`, `agent:<surface>` label, one-line session-id comment) and to the Notion Issue row (`Agent`), on top of the existing exclusive index claim.
- `graph_release` and `graph_complete` mirror `ultrathink-sync`'s state table; Done still passes the `hermes-linear-connector` Definition-of-Done gate.
- `substrate-dispatcher` watches `dispatch:<surface>` on unstarted issues and starts a session for that Graph ID in a per-Graph-ID worktree; the dispatch label is removed and `agent:<surface>` added when the claim lands.

Proof: label a real issue `dispatch:hermes` — a Hermes session starts, claims the node, the Notion Issue row shows Agent hermes, and Claude Code's brief shows it within a minute.

Not in this phase: Lane A / rivet-agentos VMs and `dispatch:claude-code` (Phase 3); dispatch for surfaces other than hermes; the Hermes TypeScript engine and Kanban retirement (D-01 of Phase 1, owned by "Ultrathink on Hermes").

</domain>

<decisions>
## Implementation Decisions

### Mirroring claims to Linear and Notion
- **D-01:** Mirroring runs inside `substrate-mcp`'s claim path (TypeScript, `packages/mcp-server/src/service.ts` claim/release/complete), using `LINEAR_API_KEY` and `NOTION_API_KEY` that `config.ts` already loads. — **Reversibility:** costly — moving it later means re-homing the Linear/Notion clients.
- **D-02:** The index claim is authoritative and lands first. Linear/Notion mirroring is best-effort: on failure emit a `warning` event carrying graph_id/node_id and the failed target; the next claim/release on that node retries the mirror. Never roll back the index claim because a mirror failed. — **Reversibility:** reversible.
- **D-03:** `agent:<surface>` is create-or-reuse per team and added additively — never overwrite the issue's other labels. — **Reversibility:** reversible.
- **D-04:** A second claimer gets the existing claim (`claimed:false` plus the node), as today, and triggers no Linear or Notion writes. — **Reversibility:** reversible.

### Release and complete
- **D-05:** `graph_release`: move the Linear issue back to Todo (`unstarted`), remove `agent:<surface>`, clear `Agent` on the Notion Issue row, emit a `release` event. — **Reversibility:** reversible.
- **D-06:** `graph_complete`: move Linear to In Review (`started_review`), then route Done through `hermes-linear-connector`'s DoD gate. Do not re-implement the gate. If DoD has not passed, return `completed:false` with the reason and leave the issue in In Review. — **Reversibility:** costly — bypassing the gate would let unfinished work close.
- **D-07:** `ultrathink-sync` keeps ownership of PR fields (PR URL, PR #, PR State, Repo, Branch). `graph_complete` writes only Notion Status, Linear State and Completed. — **Reversibility:** reversible.
- **D-08:** Add `release` and `complete` to `EVENT_KINDS`; both events carry graph_id, repo and node_id. — **Reversibility:** costly — event kinds are part of the hash-chained log contract.

### substrate-dispatcher
- **D-09:** Python package `packages/dispatcher` in this repo plus a systemd unit under `infra/vps/`, matching PROJECT.md's component table. — **Reversibility:** reversible.
- **D-10:** Poll Linear every 30 s for unstarted issues carrying a `dispatch:*` label. No webhook — no public ingress exists and `hermes-linear-api` has no webhook handler. — **Reversibility:** reversible.
- **D-11:** Phase 2 dispatches `dispatch:hermes` only. Any other `dispatch:<surface>` gets one Linear comment ("surface not dispatchable yet") and is left alone. `dispatch:claude-code` is Phase 3. — **Reversibility:** reversible.
- **D-12:** Worktree at `/var/lib/substrate/worktrees/<graph_id>` via `git worktree add` on branch `substrate/<graph_id>`, reused if present. Refuse to create one when free disk on `/` is under 5 GB (host was at 93%, 30 GB free, on 2026-09-24). — **Reversibility:** reversible.

### Safety and the proof
- **D-13:** Launch Hermes with `hermes chat` directly, cwd = the worktree, prompt = claim first (`graph_claim` for that node, surface hermes) then work. Never use `/root/agent-scripts/dispatch_handoff_to_hermes.sh` (its implement wrapper overrides the goal and can edit the wrong tree). — **Reversibility:** reversible.
  *Amended 2026-09-25 by the owner: dispatched sessions run `hermes chat -m claude-opus-5.5` via `SUBSTRATE_DISPATCH_MODEL` in `/etc/substrate/substrate.env`. Hermes' default `claude-fable-5.1` hit an Anthropic per-model 429 on every 02-08 run ("claude_code unavailable for model claude-fable-5-1; other models stay available"). Unset restores Hermes' default.*
- **D-14:** At most 2 concurrent dispatched sessions, one per issue. If no claim lands within 15 minutes: comment on the issue, remove the `dispatch:` label, no automatic retry. — **Reversibility:** reversible. *Amended 2026-09-25 by the owner (was 10 minutes): in 02-08 Hermes' 600 s backoff after an Anthropic 429 equalled the 600 s timeout, so every rate-limited run timed out before Hermes retried. The timeout now outlasts one backoff plus startup.*
- **D-15:** Kill switch `SUBSTRATE_DISPATCH_DISABLED=1` in `/etc/substrate/substrate.env`, plus stopping the unit. — **Reversibility:** reversible.
- **D-16:** The proof uses a new throwaway issue in the live Linear team on a new graph for `swcstudiospace/agent-substrate`. Resolve the issue via the graph node's `linear_issue_id`; never hardcode a team prefix (`SWC` in the live connector config vs `SPE-` identifiers in backfilled nodes). — **Reversibility:** reversible. *Amended 2026-09-25: the free-plan Linear cap is full (250/250), so re-runs reuse the proof issue SWC-467 and graph `ut-mughkkc0-73909228` (owner decision).*

### Claude's Discretion
- Internal structure of the Linear/Notion client modules in TypeScript, the dispatcher's module layout, and test fixtures.
- Exact Linear GraphQL mutations for label add/remove and comment create, provided D-03 (additive) holds.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/mcp-server/src/index-store.ts:176-206` — exclusive claim on `graph_nodes.claimed_by/claimed_at/claim_session`; loser gets `{claimed:false, node}`.
- `packages/mcp-server/src/service.ts:135-173` — claim/release/complete; claim emits `kind:claim` with repo/branch; release and complete emit nothing; comment at 136-137 defers Linear/Notion mirroring to Phase 2.
- `packages/mcp-server/src/mcp.ts:162-203` — MCP tool registrations `graph_claim`, `graph_release`, `graph_complete`.
- `packages/mcp-server/src/config.ts:58-60` — `linearApiKey`, `notionApiKey`, `notionTaskGraphDataSource`.
- `packages/mcp-server/src/types.ts:19-31` — `EVENT_KINDS` (has `claim`, `handoff`; no `release`/`complete`). `NODE_STATES` mirror the hermes-linear state keys.
- `packages/mcp-server/src/backfill.ts:70-92,139-148` — Notion Linear-State name mapping (Todo→unstarted, In Progress→started, In Review→started_review, Done→completed).
- `hermes-linear-connector` — `sync_engine.py:185-241` DoD gate (`require_dod_for_done: true` live); `webhook_app.py:89-112` `POST /v1/mark-dod`; `api_main` on 127.0.0.1:8792; `factory.py:31-36` state-name map.
- Live Linear state ids in `/root/.config/hermes-linear/config.yaml` (team_key `SWC`): started `ba47bd1b-…`, started_review `ac410939-…`, unstarted `0ec71412-…`, completed `93af3dd7-…`.
- `mcp` `linear_ext.py:310-364` has `labels_list` / `label_create`; nothing attaches a label or filters issues by label.

### Established Patterns
- Hooks and mirrors fail open; a substrate or external outage never blocks the caller (PROJECT.md constraints).
- Redact before emitting (`redact.ts`).
- MCP tool names use underscores (`graph_claim`), not dots.
- systemd units live in `infra/vps/*.service`, read `/etc/substrate/substrate.env` via EnvironmentFile.
- Lane B test gates are two-sided against measured baselines (D-03 of Phase 1): do not repair other sessions' red tests.

### Integration Points
- Claim/release/complete are reached via MCP (`/mcp`) only; there is no REST route. The dispatcher will call MCP `graph_claim` over HTTP, as the 01-10 Hermes proof did with curl.
- `grok-hermes-connector` `substrate_ext.py` forwards brief/write/emit/graph_get only — not claim/release/complete.
- Claude Code's brief (`fetchBrief` in claude-ultrathink) renders "started by <claimed_by>" from the index, so a landed claim appears in the next brief without further wiring.

</code_context>

<specifics>
## Specific Ideas

- Proof target: "within a minute" from label to a Claude Code brief showing Agent hermes — 30 s polling plus claim latency must fit.
- The 01-10 proof showed the production dispatch wrapper launching an implement session and a Telegram ACK; D-13 avoids that path entirely.

</specifics>

<deferred>
## Deferred Ideas

- Dispatch for omp, grok-build, muse and other surfaces — later phase once the hermes path is proven.
- Linear webhook ingress instead of polling.
- Forwarding `graph_claim`/`graph_release`/`graph_complete` through `grok-hermes-connector`.

</deferred>
