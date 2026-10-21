---
phase: 38-mirror
verified: 2026-10-21
status: passed
score: 2 of 2 success criteria proven in the repository. Live Linear and Notion writes and a live server run are not proven, and need operator approval
verified_on: gsd/v13x-38-mirror 4058ffa (code). This record is committed after 4058ffa.
covered_files: ["packages/mcp-server/src/node-artifact.ts", "packages/mcp-server/src/node-artifact.test.ts", "packages/mcp-server/src/node-artifact.read.test.ts", "packages/mcp-server/src/mirror.ts", "packages/mcp-server/src/mirror.test.ts", "packages/mcp-server/src/mirror-edges.test.ts", "packages/mcp-server/src/linear.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/graph-edges.mirror.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/http.test.ts", "packages/mcp-server/src/event-sources.ts", "docs/event-vocabulary.md", "docs/coordination.md"]
---

# 38-VERIFICATION: MIRROR, graph edges into Linear, outcomes into node evidence

Verified on the code at 4058ffa. Requirements B-D1 and B-D3 (REQUIREMENTS.md). Criteria from ROADMAP Phase 38.

## Proven in-repo

| Claim | Evidence |
|---|---|
| Full repository suite passes on a throwaway Postgres 16 (`substrate_test`) | `bun test` on the final tree (4058ffa, with the records): 5733 pass, 2 skip, 0 fail, 5735 tests across 212 files, 138 s, exit 0 |
| The two skips are the same environment gates as before | `cache-conformance.test.ts:127` and `redact.test.ts:813` (the rehearsal round trip) |
| Types clean | `bunx tsc --noEmit` exit 0 on the final code |
| Relation direction and idempotency | `mirror-edges.test.ts` (6) and `graph-edges.mirror.test.ts` (7) pass. Mutation check, run on the B-D1 slice: a reversed direction and a disabled existing-relation check each failed their named Linear-level tests (5 failures), and `mirror.ts` was restored byte for byte |
| Each landed target reports its success; failures do not | `mirror.test.ts` "success reports" (5): a claim on both trackers reports Linear then Notion; a Linear failure is not reported ok while Notion still reports; no Notion page reports Linear alone; no Linear ref reports Notion alone; the swarm comment reports Linear; done reports Notion only |
| Each landed target leaves one mirror note on the node | `service.test.ts` "a claim that lands on each tracker leaves one mirror note per target, on the node" passes; the note carries `status: ok`, the graph id and the node id |
| An approved DoD gate leaves one approved note on the node, with no summary text | `service.test.ts` "an approval leaves one approved dod note on the node, and no summary text" passes, alongside the existing "an approval carries summary_chars and never the summary text" |
| The artifact is one node's steps, in ledger order, read from the whole ledger | `node-artifact.test.ts` (4 pure tests) and `node-artifact.read.test.ts` (3): other nodes and unbound events never reach the artifact; an unreadable ledger is an error; no ledger configured is an error |
| The route returns the artifact on the JSON path, and reports an unreadable ledger | `http.test.ts` POST /evidence: a `node_id` adds `node` with that node's linear and dod steps (new); an unreadable ledger returns `node.error` (new). The full file: 91 pass, 0 fail |
| The catalog and the vocabulary doc agree with the code | `event-sources.test.ts` and `vocabulary-lock.test.ts`: 120 pass after `mirror.ok` and `dod.approved` were added and the silent `mirror` entry and row were removed |
| The "Not done" line that criterion 1 closes is gone | `grep` for "Not done" and the old no-write wording in `docs/` returns nothing |

## Failures met on the way, and their causes

- The first package run had 5 failures. Four pinned the exact context the mirror receives, or counted every `dod` or `mirror` event, and the new notes changed both. The fifth was a 2-second timeout under concurrent load; it passed when run alone. The four tests were aligned to the same assertion meaning (SUMMARY.md, "Test changes").
- The vocabulary lock failed on the doc: the silent `mirror` row was still in the marked table. Removed.
- One later full run failed 5 audit-fault tests in `http.test.ts` with `ENOSPC` on `mkdtemp`. The root filesystem was full, and the disk is shared with other workloads on this host (pytest, vitest and a dotnet compiler were running during the check). `http.test.ts` on its own then passed 91 of 91. The full suite was rerun on the final tree and passed with 0 `ENOSPC` lines. No suite file or product file was changed for this.

## Not proven

- **Live Linear relation writes (CONTEXT G2).** Creating a relation is a live write. The live rollout needs operator approval. No run here wrote to Linear.
- **A live node artifact from real tracker writes.** The artifact reads the events the mirror and the DoD gate record. An end-to-end run needs a running substrate and a graph whose nodes have tracker issues, and the connector for the DoD step. None was run.
- **Known gaps carried forward.** A duplicate relation can result from two registrations racing on the same new edge (G3). A removed edge leaves its Linear relation in place (G4).

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Graph edges mirror into Linear relations, closing "Not done" | PASS in-repo. Live write not run | `mirror-edges` (6) and `graph-edges.mirror` (7), with the mutation check above. The "Not done" wording is gone from `docs/` |
| 2 | One artifact per node shows claim → Linear → Notion → DoD | PASS in-repo. Live artifact not run | `node-artifact` (4), `node-artifact.read` (3), the claim and approval notes in `service.test.ts`, the mirror success reports (5), and the POST /evidence cases (2) |
