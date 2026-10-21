---
phase: 38-mirror
requirements: [B-D1, B-D3]
status: code and tests complete; PR #90 review addressed in d1aad36 and d01252a; live effects await operator approval
---

# 38-SUMMARY: MIRROR

## Built

- **B-D1, edges into Linear.** `LinearClient.issueRelations` and `createIssueRelation(issueId, relatedIssueId, "blocks")`. `Mirror.relateEdges` maps `requires` and `gated_by` to a blocker → waiter relation, and `blocks` to the direction the edge already has (`drift.ts`). It reads the blocker's relations first, so a relation already present is not written again. Each edge stands alone: a failure is recorded for that edge, and `relateEdges` never throws. `registerGraph` relates the view's edges, for a request that carried edges or gave a node a Linear reference. A created or failed edge leaves one outcome on the waiting node, in its own session `relation:<graph>:<blocker>:<waiter>:<kind>`.
- **B-D3, one artifact per node.** `MirrorContext.report` is called with each target that wrote cleanly, for every lease op, including the swarm comment path. Each landed target leaves a `mirror` note with `status: ok`, in the session `mirror:<graph>:<node>`. An approved DoD gate leaves a `dod` note with `already_done` and no summary text, in the session `dod:<graph>:<node>`. `nodeArtifact` (pure, `node-artifact.ts`) groups one node's events into `claim`, `linear`, `notion` and `dod` steps, in time order. `claim` is every lease decision the ledger recorded for the node. `linear` carries the relation outcomes with their blocker and edge kind. `Substrate.nodeArtifactOf` reads the graph's whole ledger, not a browse window, and returns `{artifact}` or `{error}`. `POST /evidence` with `node_id` adds `node` to the JSON reply. The HTML form and the evidence bundle type are unchanged.
- **Catalog and docs.** `event-sources.ts` lists `mirror.ok`, `dod.approved`, `mirror.relation.ok` and `mirror.relation.failed`, and no longer lists the silent `mirror` entry. `docs/event-vocabulary.md` table and silent-sources prose match. `docs/coordination.md` describes the Linear relations, the `mirror.ok` note and the node artifact.

## Decisions taken during the phase

- **Scope of B-D3 (operator choice).** The operator chose to build the artifact in this phase, not to defer it. CONTEXT.md records it.
- **Relation outcomes join the mirror action.** CONTEXT.md did not name the payload. Relation outcomes carry `action: "mirror"`, `target: "linear"`, `op: "relate"`, `blocker_node`, `edge_kind`, and `status: "ok"` (created) or `status: "failed"` with a reason. The artifact reads mirror events, so without the action a waiting node's Linear relation would be missing from its own artifact. The mirror's own outcome type still says `created`; only the event payload uses the mirror vocabulary.
- **One status vocabulary.** A landed target is `ok`. A failed target is a `mirror.failed` warning, or a relation outcome with `status: "failed"`. The artifact reads `ok` as landed and anything else as failed.
- **Removed edges keep their Linear relations** (CONTEXT decision 7). Recorded as a known gap, not a change.

## Decisions taken in the PR #90 review (d1aad36, d01252a)

- **Graph-scoped sessions for the notes.** A holder's session can span graphs, so a note in that session could sit between another graph's events and break that graph's chain. The success and approval notes take their own sessions, named for the graph and node, the same way relation outcomes already do.
- **The cache is refreshed before the Linear wait.** `registerGraph` refreshes the graph cache right after the index write, in the `finally`, and then writes relations.
- **Relations follow the tracker, not only the edges.** A request that carried edges, or that gave a node a Linear reference, relates the graph's saved edges. A saved edge may have waited for a link, so a node that gains one must relate them. A status-only update that does neither writes no relation.
- **Claims come from the lease decisions.** A claim step used to come from mirror outcomes, so a node without a tracker showed no claims. Now every lease decision the ledger recorded for the node is a claim step.
- **Time order with chain tie-break.** Events in one millisecond are placed in chain order where the chain links them, and keep the ledger's order where it does not.
- **Node ids match the stored form.** The ledger stores an identifier as `normalizeIdentifier` cleans it (redacted and truncated to 512 characters). The read matches that form.

## Test changes that came with the code

The new notes and the review fixes changed what some tests counted, compared or set up. Each change keeps the assertion's meaning:

- `service.test.ts`, the two claim-mirror tests compared the whole context handed to the mirror. The context now also carries `report`, so they assert the same holder, session, epoch, refs and op with `toMatchObject`.
- `service.test.ts`, `dodWarnings` and `mirrorWarnings` counted every event with `action` `dod` or `mirror`, which now includes the success notes. Both count warnings only, which their names say.
- `service.test.ts`, the release-note assertion took the first `note` event. That is now a mirror success, so it selects the note that carries the `dod` payload.
- `graph-edges.mirror.test.ts`, the created-relation assertion pinned `status: "created"`. It now pins `action: "mirror"` and `status: "ok"`.
- `graph-edges.mirror.test.ts`, the registrations that expect relations now pass the view's edges, because a relation is written only for a request that carried edges or gave a node a Linear reference.
- `graph-edges.mirror.test.ts`, the cache-order check reads through a real read-through cache with an in-memory Redis stand-in, after the index write, instead of reaching into the substrate's private cache.
- `node-artifact.test.ts` and `node-artifact.read.test.ts`, the claim step is now `{ts, action}` from the lease decision, and the Linear step carries `blocker_node` and `edge_kind`.
- `http.test.ts`, the Linear step in the `node_id` reply carries `blocker_node` and `edge_kind`.

## Known gaps carried forward

- Live Linear relation writes have not run. Creating a relation is a live write, so the live rollout waits for operator approval (CONTEXT G2).
- Two registrations racing on the same new edge can both create the relation (CONTEXT G3).
- A removed edge leaves its Linear relation in place (CONTEXT G4).
- The `mirror.failed` warnings are emitted in the holder's session, as they were before this phase. One holder's session can still hold two graphs' failures. Changing it moves an existing session assertion, so it is recorded and not changed here.
- No live run has produced a node artifact from real Linear and Notion writes. The end-to-end check needs a running substrate and a graph with tracker issues.
