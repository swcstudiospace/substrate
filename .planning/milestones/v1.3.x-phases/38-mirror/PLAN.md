---
phase: 38-mirror
requirements: [B-D1, B-D3]
branch: gsd/v13x-38-mirror
base: a1b7152 (origin/main, the merge of PR #89)
---

# 38-PLAN: MIRROR, graph edges into Linear, outcomes into node evidence

Context and decisions: `CONTEXT.md`. Goal and criteria: ROADMAP.md, Phase 38.

## Success criteria (ROADMAP)

1. Graph edges (`requires` / `blocks` / `gated_by`) mirror into Linear relations, closing the `coordination.md` "Not done" line.
2. One artifact per node shows claim → Linear → Notion → DoD.

## Tasks

| # | Task | Files |
|---|---|---|
| 1 | Linear client: read an issue's relations; create a `blocks` relation between two issues | `packages/mcp-server/src/linear.ts` |
| 2 | Mirror `relateEdges`: map each edge to a blocker → waiter `blocks` relation; read existing relations first; isolate failures per edge; never throw | `packages/mcp-server/src/mirror.ts` |
| 3 | Registration: `registerGraph` relates the view's edges; each created or failed edge leaves one outcome on the waiting node, in its own session | `packages/mcp-server/src/service.ts` |
| 4 | Success reports: `MirrorContext.report` is called with each target that wrote cleanly, for every lease op | `packages/mcp-server/src/mirror.ts` |
| 5 | Success notes: each landed target leaves a `mirror` note (`status: "ok"`) on the node; an approved DoD gate leaves a `dod` note (`status: "approved"`, `already_done`) and no summary text | `packages/mcp-server/src/service.ts` |
| 6 | Node artifact: pure `nodeArtifact(events, nodeId)`; `Substrate.nodeArtifactOf` reads the whole ledger and keeps the node's events; `POST /evidence` with `node_id` adds `node` to the JSON reply | `packages/mcp-server/src/node-artifact.ts`, `service.ts`, `server.ts` |
| 7 | Relation outcomes join the mirror action (`action: "mirror"`, `op: "relate"`, `status: "ok"` or `"failed"`), so the waiting node's artifact shows its Linear relation | `packages/mcp-server/src/service.ts` |
| 8 | Catalog and docs: add `mirror.ok` and `dod.approved`; remove the silent `mirror` entry; update the vocabulary table and prose and the `coordination.md` graph-edges and tracker-mirror text | `packages/mcp-server/src/event-sources.ts`, `docs/event-vocabulary.md`, `docs/coordination.md` |

## Verification plan

- Targeted suites for each task: `mirror-edges`, `graph-edges.mirror`, `mirror`, `service`, `node-artifact`, `node-artifact.read`, `http` (POST /evidence), `event-sources`, `vocabulary-lock`.
- A mutation check on the relation direction and on the existing-relation check (B-D1).
- The full repository suite on a throwaway Postgres 16 (`substrate_test`).
- `bunx tsc --noEmit`.
- Results go to `VERIFICATION.md`.

## Out of scope

- Deleting a Linear relation when its edge leaves the graph (CONTEXT decision 7).
- A live Linear relation write, and a live server run. Both need operator approval.
- Notion relations. Notion has no relation to mirror here.
