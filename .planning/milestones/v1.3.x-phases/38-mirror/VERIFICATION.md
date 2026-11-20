---
phase: 38-mirror
verified: 2026-11-12T08:36:22Z
status: human_needed
score: 2/2 ROADMAP success criteria verified in the repository; live Linear relation write and live node artifact not run (operator-gated)
covered_files: ["packages/mcp-server/src/node-artifact.ts", "packages/mcp-server/src/node-artifact.test.ts", "packages/mcp-server/src/node-artifact.read.test.ts", "packages/mcp-server/src/mirror.ts", "packages/mcp-server/src/mirror.test.ts", "packages/mcp-server/src/mirror-edges.test.ts", "packages/mcp-server/src/linear.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/graph-edges.mirror.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/http.test.ts", "packages/mcp-server/src/event-sources.ts", "docs/event-vocabulary.md", "docs/coordination.md"]
covered_digest: "v3:sha256:85e10f9100515aa5eeb45bb5aedf057f27c166e801894457cb5a62027a66a98d"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Create one live Linear `blocks` relation from a registered graph edge (operator-approved write)"
    expected: "Relation appears on the blocker's Linear issue, pointing at the waiting issue; a `mirror.relation.ok` note lands on the waiting node"
    why_human: "Creating a relation is a live write to an external tracker; no run here wrote to Linear (CONTEXT G2)"
  - test: "Produce a node artifact from a running substrate for a graph whose nodes have Linear issues and a DoD approval"
    expected: "POST /evidence with node_id returns node.artifact with claim, linear, notion and dod steps in time order"
    why_human: "Needs a running server, real tracker writes and the DoD connector; the in-repo tests use stubs and an in-memory ledger"
---

# 38-VERIFICATION: MIRROR, graph edges into Linear, outcomes into node evidence

**Phase Goal:** Graph edges mirror into Linear relations, and mirror outcomes land in each node's evidence.
**Verified:** 2026-11-12T08:36:22Z
**Status:** human_needed
**Re-verification:** Yes — re-run at HEAD af4c4278. Prior record: 2026-10-21 at 3aea2d0.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | Graph edges (`requires` / `blocks` / `gated_by`) mirror into Linear `blocks` relations (SC1, B-D1) | ✓ VERIFIED (in-repo; live write not run) | `mirror.ts:437-462` `relateEdges`: blocker→waiter direction, reads existing relations first (`existing` skips the write), per-edge try/catch, never throws. `linear.ts:292-301` `createIssueRelation`. `service.ts:5108-5150` `mirrorEdges` maps `requires`/`gated_by` to blocker→waiter and emits one event per created/failed edge on the waiting node. Passed this run: `mirror-edges.test.ts`, `graph-edges.mirror.test.ts` |
| 2 | "Not done" line in `coordination.md` closed (SC1) | ✓ VERIFIED | `grep -rn "Not done" docs/` finds no coordination line (only unrelated `embedding-fabric.md:70`, `data-planes.md:145`) |
| 3 | Each landed Linear/Notion target leaves a `mirror` success note on the node (B-D3) | ✓ VERIFIED (code this run; `service.test.ts` not re-run) | `mirror.ts:323,343,361` `ctx.report`; `service.ts` emits `action: "mirror"` success notes in `mirror:<graph>:<node>` sessions. `mirror.test.ts` "success reports" (5) passed this run. The `service.test.ts` per-target note test is cited from the 2026-10-21 record, not re-run |
| 4 | An approved DoD gate leaves one `dod` approved note, no summary text (B-D3) | ✓ VERIFIED (code this run; `service.test.ts` not re-run) | `service.ts:5854` `payload: { action: "dod", status: "approved", already_done }` in `dod:<graph>:<node>` session; no summary field |
| 5 | One node's artifact shows claim → Linear → Notion → DoD in time order from the whole ledger (SC2, B-D3) | ✓ VERIFIED (in-repo; live artifact not run) | `node-artifact.ts` pure `nodeArtifact`; `service.ts:3061-3068` `nodeArtifactOf` filters the whole ledger by `node_id`; `server.ts:1215-1229` `POST /evidence` with `node_id` adds `node`. Passed this run: `node-artifact.test.ts` (8), `node-artifact.read.test.ts` (4), `http.test.ts` (113) |
| 6 | Relation outcomes and the catalog agree with the code | ✓ VERIFIED | `event-sources.ts:631-680` lists `mirror.ok`, `mirror.relation.ok`, `mirror.relation.failed`, `dod.approved`; silent `mirror` entry gone. `vocabulary-lock.test.ts` passed (2) |

**Score:** 2/2 ROADMAP success criteria verified in the repository. 0 behavior-unverified truths: every behavior-dependent truth has a passing named test.

### Deferred Items

None.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/linear.ts` | `issueRelations`, `createIssueRelation` | ✓ VERIFIED | `linear.ts:271`, `:292` |
| `packages/mcp-server/src/mirror.ts` | `relateEdges`, `ctx.report` | ✓ VERIFIED | `mirror.ts:437`, `:323/343/361` |
| `packages/mcp-server/src/service.ts` | `mirrorEdges`, DoD/mirror notes, `nodeArtifactOf` | ✓ VERIFIED | `:5108`, `:5854`, `:3061` |
| `packages/mcp-server/src/node-artifact.ts` | pure `nodeArtifact` | ✓ VERIFIED | Tested by `node-artifact.test.ts` and `.read.test.ts` |
| `packages/mcp-server/src/server.ts` | `POST /evidence` `node_id` | ✓ VERIFIED | `server.ts:1215-1229` |
| `packages/mcp-server/src/event-sources.ts` | catalog rows | ✓ VERIFIED | `:631-680` |
| `docs/coordination.md`, `docs/event-vocabulary.md` | updated text | ✓ VERIFIED | "Not done" removed; vocabulary-lock passes |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` registerGraph | `mirror.ts` relateEdges | `mirrorEdges` → `mirror.relateEdges(relations)` (`service.ts:5134`) | ✓ WIRED | |
| `mirror.ts` relateEdges | `linear.ts` | `issueRelations` / `createIssueRelation` (`mirror.ts:446-452`) | ✓ WIRED | |
| `service.ts` mirrorEdges | ledger | `emit` with `node_id` = waiting node, `action: "mirror"` (`service.ts:5140-5150`) | ✓ WIRED | |
| `server.ts` POST /evidence | `nodeArtifactOf` | `server.ts:1228` | ✓ WIRED | |
| `nodeArtifactOf` | `nodeArtifact` | `service.ts:3068` | ✓ WIRED | |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| node artifact | `events` | ledger rows via `rowToLedgerEvent` (`service.ts:3061-3067`) | Yes in tests (in-memory ledger); not against a live ledger | ✓ FLOWING (in-repo) |
| relation outcomes | `outcomes` | `linear.issueRelations` / `createIssueRelation` | Yes against stubbed Linear; live not run | ✓ FLOWING (in-repo) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Edge mirror, graph refresh order, mirror success reports, node artifact, catalog | `bun test mirror-edges.test.ts graph-edges.mirror.test.ts mirror.test.ts node-artifact.test.ts event-sources.test.ts` (in `packages/mcp-server/src`) | 240 pass, 0 fail, exit 0 | ✓ PASS |
| Node artifact read from ledger | `bun test node-artifact.read.test.ts` | 4 pass, 0 fail, exit 0 | ✓ PASS |
| Vocabulary lock | `bun test vocabulary-lock.test.ts` | 2 pass, 0 fail, exit 0 | ✓ PASS |
| POST /evidence node_id route and related HTTP cases | `bun test http.test.ts` | 113 pass, 0 fail, exit 0 | ✓ PASS |

Not run in this re-verification: the full repository suite (`bun test` with `SUBSTRATE_TEST_PG_URL`), `service.test.ts`, and `bunx tsc --noEmit`. The Postgres at 127.0.0.1:5432 refuses TCP, so live-DB tests were not run. The 2026-10-21 record shows the full suite and tsc passing at 3aea2d0; this run did not re-prove them at HEAD.

### Probe Execution

No probe scripts declared for this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| B-D1 | 38-PLAN.md | Graph edges mirror into Linear relations | ✓ SATISFIED (in-repo); live write needs human | `mirror.ts:437`, `service.ts:5108`, `mirror-edges` and `graph-edges.mirror` tests pass |
| B-D3 | 38-PLAN.md | One artifact per node shows claim → Linear → Notion → DoD | ✓ SATISFIED (in-repo); live artifact needs human | `node-artifact` and `http` tests pass |

No orphaned requirements: REQUIREMENTS.md maps only B-D1 and B-D3 to phase 38.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (modified files) | — | `TBD` / `FIXME` / `XXX` grep | — | None found |

No blocker anti-patterns found.

### Known Gaps (carried forward, not blockers)

- **G3:** Two registrations racing on the same new edge can both create the Linear relation (duplicate). Not closed by this phase.
- **G4:** A removed edge leaves its Linear relation in place (CONTEXT decision 7).
- The `mirror.failed` warnings are emitted in the holder's session (pre-existing); one session can hold two graphs' failures.

### Human Verification Required

### 1. Live Linear relation write

**Test:** Register a graph with an edge between two Linear-linked nodes, once operator approval is given.
**Expected:** A `blocks` relation appears on the blocker issue pointing at the waiter; a `mirror.relation.ok` note lands on the waiting node.
**Why human:** Live write to an external tracker; operator-gated (CONTEXT G2).

### 2. Live node artifact

**Test:** With a running substrate, call `POST /evidence` with `graph_id` and `node_id` for a node that has Linear and DoD activity.
**Expected:** `node.artifact` lists claim, linear, notion and dod steps in time order.
**Why human:** Needs a running server, real tracker writes and the DoD connector.

### Gaps Summary

No gaps block the phase goal. Both ROADMAP success criteria are satisfied in the repository by the tests listed above. Status is `human_needed` because the live Linear relation write and the live node artifact have not been run; both are operator-gated.

---

_Verified: 2026-11-12T08:36:22Z_
_Verifier: Claude (gsd-verifier)_
