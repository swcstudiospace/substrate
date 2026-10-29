# Phase 38 — MIRROR: graph edges into Linear relations, outcomes into evidence

## Gap
- B-D1 (REQUIREMENTS.md:21-22): mirror graph edges (`requires` / `blocks` / `gated_by`) into Linear relations.
  UPLIFT_PROPOSAL.md:69 (A2) names the route: the existing Linear client (`mcp-server/src/linear.ts`) and `mirror.ts`.
- B-D3 (REQUIREMENTS.md:23-24): one artifact per node shows claim → Linear → Notion → DoD. Mirror outcomes go into `substrate evidence` per node.
- Depends on M6 (the claim mirror, phases 23 and onward).

## Current behaviour (read, with citations)
- Edges. `graph_edges` holds `(graph_id, from_node, to_node, kind)` (`index-store.ts:352-360`). `registerGraph` replaces the set in one transaction (`index-store.ts:754-760`). `drift.ts:469-489` reads each edge from both ends: `requires` and `gated_by` are written from the waiting node, `blocks` from the blocking one.
- Linear. `LinearClient` had no relation call before this phase. The claim mirror writes state, labels and comments only (`mirror.ts`). It reads an issue by identifier or UUID (`issueContext`, `issueText`).
- Mirror outcomes today. A failed claim-mirror target becomes one `warning` event carrying `graph_id` (`service.ts` `emitMirrorFailures`). Successful writes leave no event.
- Evidence. `buildGraphEvidence` lists the graph's chain-verified events (`observe.ts`, `chains.app_events.records`). Each event may carry `node_id`.
- Docs. `docs/coordination.md` "Graph edges" said edges mirror the Linear sub-issue relations the nodes already carry, and that Linear is the source of truth. No edge was written to Linear.

## Decisions (B-D1)
1. Direction. `requires` and `gated_by` make `from_node` wait on `to_node`. `blocks` makes `to_node` wait on `from_node`. This is the reading `drift.ts` already uses.
2. The Linear relation is `blocks`, from the blocking issue to the waiting one (`issueRelationCreate`: `issueId` = blocker, `relatedIssueId` = waiter).
3. `gated_by` maps to `blocks`. Linear has no gate. The strict reading shows the waiting issue as blocked, which is the conservative choice. The edge kind is kept in the outcome payload, so evidence still says "gate".
4. Idempotent per direction. The blocker's own `relations` are read first. A relation already present is `existing`: no write, and no event.
5. Each edge stands alone. A refused or failed edge never stops the rest. `relateEdges` never throws. Registration never fails because of Linear.
6. Outcome events. A `created` or `failed` edge leaves one event on the waiting node (`node_id`): `note` when created, `warning` when failed. Each has its own session (`relation:<graph>:<blocker>:<waiter>:<kind>`), so no chain spans two relations. This is the lesson of the phase 37 P1 review. Surface is `substrate`, the server's own. `existing` and `skipped` record nothing.
7. Removed edges. When an edge leaves the graph, its Linear relation stays. Linear cannot tell a relation this mirror made from one a person made, so deleting it could destroy a human's link. Deletion is out of scope here and is recorded as a gap.

## B-D3 scope (criterion 2): decided
The operator chose to build the artifact in this phase, not to defer it. The claim mirror reports each target it landed, the DoD gate reports approvals, and `POST /evidence` takes `node_id` (see SUMMARY.md).

## Grey areas (auto-accepted where the STATE.md run rules allow)
- G1. `gated_by` as `blocks` (decision 3). Conservative and reversible.
- G2. Linear writes happen at registration, not only at claim. Creating a relation is a live Linear write, so the live rollout waits for operator approval (STATE.md run rules). The code merges with tests only.
- G3. Two registrations racing on the same new edge can both create the relation. Linear then holds a duplicate. Not closed here; registration is infrequent.
- G4. Removed edges leave their Linear relations in place (decision 7).

## Out of scope
- Deleting Linear relations (decision 7).
- Notion relations. Notion has no relation to mirror here.
- The live Linear rollout. It needs operator approval.
