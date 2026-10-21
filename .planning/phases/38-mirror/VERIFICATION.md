---
phase: 38-mirror
verified: 2026-10-21
status: passed
score: 2 of 2 success criteria proven in the repository. Live Linear and Notion writes and a live server run are not proven, and need operator approval
verified_on: gsd/v13x-38-mirror d01252a (code, after the PR #90 review fixes). This record is committed after d01252a.
covered_files: ["packages/mcp-server/src/node-artifact.ts", "packages/mcp-server/src/node-artifact.test.ts", "packages/mcp-server/src/node-artifact.read.test.ts", "packages/mcp-server/src/mirror.ts", "packages/mcp-server/src/mirror.test.ts", "packages/mcp-server/src/mirror-edges.test.ts", "packages/mcp-server/src/linear.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/graph-edges.mirror.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/http.test.ts", "packages/mcp-server/src/event-sources.ts", "docs/event-vocabulary.md", "docs/coordination.md"]
---

# 38-VERIFICATION: MIRROR, graph edges into Linear, outcomes into node evidence

Verified on the code at d01252a. Requirements B-D1 and B-D3 (REQUIREMENTS.md). Criteria from ROADMAP Phase 38.

## Proven in-repo

| Claim | Evidence |
|---|---|
| Full repository suite passes on a throwaway Postgres 16 (`substrate_test`) | `bun test` on d01252a: 5745 pass, 2 skip, 0 fail, 5747 tests across 212 files, 127 s, exit 0, no `ENOSPC` line |
| The two skips are the same environment gates as before | `cache-conformance.test.ts:127` and `redact.test.ts:813` (the rehearsal round trip) |
| Types clean | `bunx tsc --noEmit` exit 0 on d01252a |
| Relation direction and idempotency | `mirror-edges.test.ts` and `graph-edges.mirror.test.ts` pass. Mutation check on the B-D1 slice: a reversed direction and a disabled existing-relation check each failed their named Linear-level tests, and `mirror.ts` was restored byte for byte |
| Registration refreshes the graph before any Linear wait | `graph-edges.mirror.test.ts` "while a Linear relation is still being written, reads already show the registered graph" reads through a real read-through cache after the index write. Mutation check: with the relation written before the refresh it fails (exit 1); `service.ts` restored byte for byte, and it passes again (exit 0) |
| An edge-less, node-status-only update writes no relation | `graph-edges.mirror.test.ts` "a request that names no edges writes no relation, so a status-only update touches no tracker" |
| A node that gains a Linear reference relates its saved edges | `graph-edges.mirror.test.ts` "a node that gains a Linear reference relates the graph's saved edges, though the request names none" |
| Each landed target reports its success; failures do not | `mirror.test.ts` "success reports" (5): a claim on both trackers reports Linear then Notion; a Linear failure is not reported ok while Notion still reports; no Notion page reports Linear alone; no Linear ref reports Notion alone; the swarm comment reports Linear; done reports Notion only |
| Each landed target leaves one mirror note on the node, in its own graph-scoped session | `service.test.ts` "a claim that lands on each tracker leaves one mirror note per target, on the node": each note is on the node, carries `status: ok`, and its session is not the holder's and names the graph |
| An approved DoD gate leaves one approved note on the node, in its own session, with no summary text | `service.test.ts` "an approval leaves one approved dod note on the node, and no summary text" |
| The artifact is one node's steps, in time order, from the whole ledger | `node-artifact.test.ts` (8 pure tests): lease decisions are the claim steps with or without a tracker; relation outcomes keep their blocker and edge kind; other nodes and unbound events never reach the artifact; a failed target keeps its reason; the DoD statuses; events in one millisecond follow the chain links between them, and unlinked ones keep the given order. `node-artifact.read.test.ts` (4): the whole-ledger read, a long node id matched in its stored form, an unreadable ledger as an error, no ledger as an error |
| The route returns the artifact on the JSON path, and reports an unreadable ledger | `http.test.ts` POST /evidence: a `node_id` adds `node` with the linear and dod steps (the linear step carries the new fields); an unreadable ledger returns `node.error`. The full file passes |
| The catalog and the vocabulary doc agree with the code | `event-sources.test.ts` and `vocabulary-lock.test.ts` pass. `dod.approved` carries the repo; `mirror.relation.ok` and `mirror.relation.failed` are listed with the substrate surface |
| The "Not done" line that criterion 1 closes is gone | `grep` for "Not done" and the old no-write wording in `docs/` returns nothing |

## PR #90 review: eight findings, all fixed

Greptile raised seven unresolved threads on 0f3ec19; they were fixed in d1aad36. Greptile raised an eighth on 0da10af; it was fixed in d01252a. Each was checked against the code before the change. Each thread has a reply that cites its fixing commit, and each is resolved.

| Finding | Fix | Test |
|---|---|---|
| Success notes reuse the holder's session, so two graphs can interleave in one chain (P1) | Success notes use `mirror:<graph>:<node>`; the approved DoD note uses `dod:<graph>:<node>` (d1aad36) | the claim-note and approval tests assert the session is not the holder's and names the graph |
| Cache refresh waits for Linear; a status-only update rechecks every edge (P1) | Refresh before the relations; relations only when the request carried edges (d1aad36) | the read-through test (mutation-checked); "a request that names no edges writes no relation" |
| Claims vanish without a tracker | Claim steps are the lease decisions the ledger recorded (d1aad36) | "a node's lease decisions are its claim steps even when no tracker is bound" |
| Long node ids lose history (the ledger stores the cleaned id) | The node is matched in its stored form (d1aad36) | "a node id is matched in the form the ledger stored it, so a long id keeps its history" |
| Equal timestamps scramble steps | Time order, with same-millisecond events in chain order where linked (d1aad36) | "events in one millisecond follow the chain that links them"; "... that the chain does not link keep the order they were given" |
| Relation steps lose their blocker | Linear steps carry `blocker_node` and `edge_kind` (d1aad36) | "a relation outcome keeps its blocker and edge kind on the Linear step, and a failed one keeps its reason" |
| Catalog disagrees with emitted notes | `dod.approved` carries the repo; relation outcomes have their own substrate rows (d1aad36) | `event-sources.test.ts` and `vocabulary-lock.test.ts` pass |
| A node that gains a Linear reference leaves its saved edges unrelated (P2) | A node update that sets `linear_issue_id` or `linear_identifier` relates the saved edges; a status-only update stays silent (d01252a) | "a node that gains a Linear reference relates the graph's saved edges, though the request names none" |

## Failures met on the way, and their causes

- The first package run had 5 failures. Four pinned the exact context the mirror receives, or counted every `dod` or `mirror` event, and the new notes changed both. The fifth was a 2-second timeout under concurrent load; it passed when run alone. The four were aligned to the same assertion meaning (SUMMARY.md, "Test changes").
- The vocabulary lock failed on the doc: the silent `mirror` row was still in the marked table. Removed.
- One full run failed 5 audit-fault tests in `http.test.ts` with `ENOSPC` on `mkdtemp`. The root filesystem was full, and the disk is shared with other workloads on this host. `http.test.ts` on its own then passed, and the full suite was rerun with no `ENOSPC`. No suite or product file was changed for this.
- The read-through test first read the cache before the index write's bump had run; it now waits for the index write and one event-loop turn. The first version also had a stub without `nodes`, which `withoutLeaseIds` reads. Both were test-side.

## Not proven

- **Live Linear relation writes (CONTEXT G2).** Creating a relation is a live write. The live rollout needs operator approval. No run here wrote to Linear.
- **A live node artifact from real tracker writes.** The artifact reads the events the mirror and the DoD gate record. An end-to-end run needs a running substrate and a graph whose nodes have tracker issues, and the DoD connector. None was run.
- **Known gaps carried forward.** A duplicate relation can result from two registrations racing on the same new edge (G3). A removed edge leaves its Linear relation in place (G4). The `mirror.failed` warnings are emitted in the holder's session, as they were before this phase, so one holder's session can still hold two graphs' failures. That is the same interleaving the review raised for success notes. It predates this phase, and changing it moves an existing session assertion, so it is recorded here and not changed.

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Graph edges mirror into Linear relations, closing "Not done" | PASS in-repo. Live write not run | `mirror-edges` and `graph-edges.mirror`, with the mutation check above. The "Not done" wording is gone from `docs/` |
| 2 | One artifact per node shows claim → Linear → Notion → DoD | PASS in-repo. Live artifact not run | `node-artifact` (8), `node-artifact.read` (4), the claim and approval notes in `service.test.ts`, the mirror success reports (5), and the POST /evidence cases |
