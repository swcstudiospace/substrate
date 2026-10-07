---
status: partial
phase: 00-brief
source: .planning/milestones/v1.0-ROADMAP.md (Phase 0 success criteria) — no SUMMARY.md exists; Phase 0 was built directly from the approved plan rather than through plan-phase/execute-phase
started: 2026-09-23T18:55:00Z
updated: 2026-09-23T18:55:00Z
audit_acknowledged:
  milestone: v1.1
  at: 2026-10-07
  gap_snapshot: "partial::scenarios=8"
---

## Current Test

[testing paused — 8 items outstanding; superseded by /gsd-autonomous]

Test 1 was presented with live evidence (9 MCP tools, 4 REST routes all
answering) but never answered — the session moved to autonomous execution.
Evidence for tests 1-3 is recorded below and can be re-confirmed cheaply.

## Tests

### 1. substrate-mcp serves both surfaces

expected: 9 MCP tools listed; GET /healthz, POST /brief, POST /events, POST /verify all answer
result: [pending]
evidence: "9 tools live (memory_brief/write/search, events_emit, graph_get/register/claim/release/complete); /healthz 200, /brief 200, /events 202, /verify 200" 

### 2. Schemas exist and hold real data

expected: graph_index/graph_nodes/graph_steps/memory_entries in Postgres, agent_events/anchors in Greptime, all on Railway
result: [pending]
evidence: "postgres: graph_index(6 rows), graph_nodes(15), graph_steps, memory_entries(1); greptime: agent_events(8 rows), anchors" 

### 3. Index backfilled from the Notion Agent Task Graph

expected: real graphs and nodes from the live database, with Linear identifiers
result: [pending]

### 4. The brief reaches a Claude Code session

expected: fetchBrief runs before the Graph of Thought and injects the brief into prompt context
result: [pending]

### 5. ultrathink-kickoff calls graph_register

expected: a newly tracked Task registers itself in the index automatically
result: [pending]

### 6. Cursor hooks and the git post-commit collector are installed

expected: a Cursor session writes .substrate/BRIEF.md; a commit emits a commit event
result: [pending]

### 7. A substrate outage does not block any agent

expected: with substrate-mcp stopped, prompts proceed normally, just unbriefed
result: [pending]

### 8. Phase proof — cross-surface brief

expected: work done on one surface appears in another surface's brief, keyed by Graph ID
result: [pending]

## Summary

total: 8
passed: 0
issues: 0
pending: 8
skipped: 0
blocked: 0

## Gaps
