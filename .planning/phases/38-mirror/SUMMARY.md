---
phase: 38-mirror
requirements: [B-D1, B-D3]
status: code and tests complete; live effects await operator approval
---

# 38-SUMMARY: MIRROR

## Built

- **B-D1, edges into Linear.** `LinearClient.issueRelations` and `createIssueRelation(issueId, relatedIssueId, "blocks")`. `Mirror.relateEdges` maps `requires` and `gated_by` to a blocker → waiter relation and `blocks` to the same direction the edge already has (`drift.ts`). It reads the blocker's relations first, so a relation already present is not written again. Each edge stands alone: a failure is recorded for that edge, and `relateEdges` never throws. `registerGraph` relates the view's edges. A created or failed edge leaves one outcome on the waiting node, in its own session `relation:<graph>:<blocker>:<waiter>:<kind>`.
- **B-D3, one artifact per node.** `MirrorContext.report` is called with each target that wrote cleanly, for every lease op (claim, steal, release, expire, force, review, done, close), including the swarm comment path. Each landed target leaves a `mirror` note with `status: "ok"`. An approved DoD gate leaves a `dod` note with `status: "approved"` and `already_done`; it carries no summary text. `nodeArtifact` (pure, `node-artifact.ts`) groups one node's events into `claim`, `linear`, `notion` and `dod` steps, in ledger order. `Substrate.nodeArtifactOf` reads the graph's whole ledger, not a browse window, and returns `{artifact}` or `{error}`. `POST /evidence` with `node_id` adds `node` to the JSON reply. The HTML form and the evidence bundle type are unchanged.
- **Catalog and docs.** `event-sources.ts` lists `mirror.ok` and `dod.approved`, and no longer lists the silent `mirror` entry. `docs/event-vocabulary.md` table and silent-sources prose match. `docs/coordination.md` describes the Linear relations, the `mirror.ok` note and the node artifact.

## Decisions taken during the phase

- **Scope of B-D3 (operator choice).** The operator chose to build the artifact in this phase, not to defer it. CONTEXT.md records it.
- **Relation outcomes join the mirror action.** CONTEXT.md did not name the payload. Relation outcomes now carry `action: "mirror"`, `target: "linear"`, `op: "relate"`, and `status: "ok"` (created) or `status: "failed"` with a reason. The artifact reads mirror events, so without the action a waiting node's Linear relation would be missing from its own artifact. The mirror's own outcome type still says `created`; only the event payload uses the mirror vocabulary.
- **One status vocabulary.** A landed target is `ok`. A failed target is a `mirror.failed` warning, or a relation outcome with `status: "failed"`. The artifact reads `ok` as landed and anything else as failed.
- **Removed edges keep their Linear relations** (CONTEXT decision 7). Recorded as a known gap, not a change.

## Test changes that came with the code

The new notes changed what some existing tests counted or compared. Each fix keeps the assertion's meaning:

- `service.test.ts`, the two claim-mirror tests compared the whole context handed to the mirror. The context now also carries `report`, so they assert the same holder, session, epoch, refs and op with `toMatchObject`.
- `service.test.ts`, `dodWarnings` and `mirrorWarnings` counted every event with `action` `dod` or `mirror`, which now includes the success notes. Both helpers now count warnings only, which is what their names say.
- `service.test.ts`, the release-note assertion took the first `note` event. That is now a mirror success, so it selects the note that carries the `dod` payload.
- `graph-edges.mirror.test.ts`, the created-relation assertion pinned `status: "created"`. It now pins `action: "mirror"` and `status: "ok"`.

## Known gaps carried forward

- Live Linear relation writes have not run. Creating a relation is a live write, so the live rollout waits for operator approval (CONTEXT G2).
- Two registrations racing on the same new edge can both create the relation (CONTEXT G3).
- A removed edge leaves its Linear relation in place (CONTEXT G4).
- No live run has produced a node artifact from real Linear and Notion writes. The end-to-end check needs a running substrate and a graph with tracker issues.
