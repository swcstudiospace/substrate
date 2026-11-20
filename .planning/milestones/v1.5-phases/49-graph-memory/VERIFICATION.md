---
phase: 49-graph-memory
verified: 2026-11-12T08:38:54Z
status: human_needed
score: 5/5 must-haves verified in-repo; live ledger proof not run (human)
behavior_unverified: 0
overrides_applied: 0
covered_files: [".planning/milestones/v1.5-phases/49-graph-memory/PLAN.md", ".planning/milestones/v1.5-phases/49-graph-memory/SUMMARY.md", "docs/memory-governance.md", "packages/mcp-server/src/mcp.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/memory-graph.test.ts", "packages/mcp-server/src/memory-graph.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:381d42a7622255e6926275d5a9a541c2da4b7d81565a6696803adab3f099424e"
human_verification:
  - test: "Run memory_search with graph_linked: true and causal: true against the live Greptime agent_events ledger for a graph and session with known events."
    expected: "graph_links lists each returned graph's five newest events (newest first); causal_chain lists up to five preceding session events (nearest first); no read times out under the 1000 ms budget."
    why_human: "Only the ledger stub was exercised in-repo. Live ledger results and latency are operator-gated and were not run here; Postgres 127.0.0.1:5432 was not contacted."
---

# 49-VERIFICATION: Graph-linked memory and causal recall from Greptime events

**Phase Goal:** Hindsight memory is graph-structured and built from Greptime events, with causal recall.
**Verified:** 2026-11-12T08:38:54Z
**Status:** human_needed
**Re-verification:** No (initial verification of this phase directory; supersedes the 2026-10-21 record, which had no `gaps:` section)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| 1 | `memory_search` returns graph-linked results (ROADMAP SC1) | ✓ VERIFIED | `mcp.ts:886-889` declares `graph_linked`; `service.ts:1307-1332` reads one ledger graph per distinct `graph_id` and adds `graph_links`; `mcp.test.ts:714-730` passed. |
| 2 | Recall uses causal (ROADMAP SC2) | ✓ VERIFIED | `mcp.ts:890-893` declares `causal`; `service.ts:1334-1338` attaches `causal_chain` from one session read per session; `memory-graph.ts:77-83`; `mcp.test.ts:734-753` passed (notice says "not proof of cause"). |
| 3 | Pure helpers: summary cut at 200, newest five per graph, nearest-first causal chain capped at five, empty for unknown source (PLAN U1) | ✓ VERIFIED | `memory-graph.ts:14-16` (LINKED_EVENTS=5, CAUSAL_WINDOW=200), `:47-57` reduceEvent redacts then cuts, `:60-72` graphLinks, `:77-83` causalChain returns `[]` when source absent; `memory-graph.test.ts` passed. |
| 4 | Wiring: no new keys without options; hanging ledger read released at its budget with a reason (PLAN U2) | ✓ VERIFIED | Default-off: `mcp.test.ts:703-709` asserts no `graph_links`/`causal_chain` keys; budget race `service.ts:1262-1277` (`readLedgerBounded`, 1000 ms); `mcp.test.ts:768-780` passed. |
| 5 | Docs describe the two options, budgets, causal caveat, no schema change (PLAN U3) | ✓ VERIFIED | `docs/memory-governance.md:581-590`. |

**Score:** 5/5 truths verified; 0 present-but-behavior-unverified. The one live check is under Human Verification.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/memory-graph.ts` | pure helpers (U1) | ✓ VERIFIED | 84 lines; exports reduceEvent, graphLinks, causalChain, LINKED_EVENTS, CAUSAL_WINDOW |
| `packages/mcp-server/src/memory-graph.test.ts` | helper tests | ✓ VERIFIED | Run; passes (101 tests across this file and mcp.test.ts, 0 fail) |
| `packages/mcp-server/src/mcp.ts` | `memory_search` options | ✓ VERIFIED | zod params 886-893; passed through at 917 |
| `packages/mcp-server/src/service.ts` | ledger reads, links, degraded reasons | ✓ VERIFIED | `readLedgerBounded` 1262-1277; `ledgerLinks` 1296-1345; paged merge 3330/3360 |
| `packages/mcp-server/src/mcp.test.ts` | wiring tests | ✓ VERIFIED | Run; passes |
| `docs/memory-governance.md` | docs (U3) | ✓ VERIFIED | Section at 581-590 |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `mcp.ts` memory_search | `service.ts` memory search | `{ graphLinked, causal }` (mcp.ts:917) | ✓ WIRED | Options reach the service |
| `service.ts` ledgerLinks | `GreptimeClient.readRecentEvents` | `readLedgerBounded` (service.ts:1273) | ✓ WIRED | One read per distinct graph/session |
| `service.ts` | `memory-graph.ts` | import (service.ts:145), used at 1326 and 1338 | ✓ WIRED | |
| `memory-graph.ts` reduceEvent | `redact` | memory-graph.ts:1, :55 | ✓ WIRED | Summary redacted before cut |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `graph_links` | `eventsByGraph` | `greptime.readRecentEvents` | Yes in code; proven against stub only | ✓ FLOWING (in-repo) |
| `causal_chain` | `rowsBySession` | `greptime.readRecentEvents` | Yes in code; proven against stub only | ✓ FLOWING (in-repo) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Helpers and memory_search option wiring, including the hanging-read budget (`mcp.test.ts:768`) | `bun test packages/mcp-server/src/memory-graph.test.ts packages/mcp-server/src/mcp.test.ts` | 101 pass, 0 fail, 470 expect() calls | ✓ PASS |

### Probe Execution

No probes declared or implied for this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| SOTA-05 | PLAN.md | Graph-structured Hindsight memory from Greptime events, with causal recall | ✓ SATISFIED (in-repo) | Truths 1-5; live ledger not exercised |

No orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `service.ts` | 1262-1277 | 1000 ms budget is a race; the HTTP read continues to the client timeout (SUMMARY "Limitation kept visible") | ℹ️ Info | Documented; bounded by read caps (8 graphs / 8 sessions) |
| `CONTEXT.md` | frontmatter | status still reads "designed… not yet implemented" | ℹ️ Info | Stale planning doc, not a code gap |

No TBD, FIXME or XXX markers in the phase's files. No stub returns or hardcoded-empty data reach output.

### Human Verification Required

### 1. Live ledger graph and causal reads

**Test:** With the live Greptime `agent_events` ledger, call `memory_search` with `graph_linked: true, causal: true` for a graph and session with known events.
**Expected:** `graph_links` shows that graph's five newest events, newest first; `causal_chain` shows up to five preceding session events, nearest first; no read is degraded by timeout.
**Why human:** In-repo proof uses a ledger stub. The live ledger was not contacted (Postgres 127.0.0.1:5432 refuses TCP; Greptime is operator-gated). ROADMAP already records "live ledger proof open".

### Gaps Summary

No code gaps. The two ROADMAP success criteria and the three PLAN units are present, wired and covered by passing tests. Status is `human_needed` only because the live ledger check was not run.

Not run here: `bunx tsc --noEmit`, full `bun test`, `check:phase-close`, live Postgres/Greptime checks. No `*-SECURITY.md` exists in this phase directory, so the security gate does not block.

---

_Verified: 2026-11-12T08:38:54Z_
_Verifier: Claude (gsd-verifier)_
