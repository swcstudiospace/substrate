---
status: partial
phase: 00-brief
source: .planning/milestones/v1.0-ROADMAP.md (Phase 0 success criteria) — no SUMMARY.md exists; Phase 0 was built directly from the approved plan rather than through plan-phase/execute-phase
updated: 2026-10-10T14:05:00Z
audit_acknowledged:
  milestone: v1.3.x
  at: 2026-10-29
  gap_snapshot: "partial::scenarios=0"
---

## Current Test

[testing — 6 of 8 passing against main HEAD 1ee0b11 on a fresh twin (Phase 20 plan 20-06 rehearsal-first, run uat-p2006fresh); scenarios 2 and 5 are live-gated for the operator-approved production window]

## Tests

### 1. substrate-mcp serves both surfaces

expected: MCP tools/list contains the 9 named v1.0 tools among today's set (not "exactly 9"); GET /healthz 200, POST /brief 200, POST /events 202, POST /verify 200
result: [pass]
evidence: "twin uat-p2006fresh @1ee0b11: tools/list 23 tools with 9 v1 names present; /healthz 200, /brief 200, /events 202 stored true, graph_register 1 node, /verify 200 ok true"

### 2. Schemas exist and hold real data

expected: /healthz reports index, greptime, appendOnly true; events_query, a graph read and memory_search return rows through the API only (anchors shape and raw row counts are an operator-approved read-only SQL step recorded as evidence, never in the script)
result: [pass]
evidence: "production live 2026-10-10 (uat-p20live25): /healthz index+ledger+appendOnly true; graph uat-p20live1-s1 read with nodes; memory_search 5 rows — all through the API; anchors SQL step recorded separately, never in the script"

### 3. Index backfilled from the Notion Agent Task Graph

expected: on the harness, backfill-run shape over exported Notion rows then graph_get shows graphs with Linear identifiers; on production, graph_get of graph ids from an operator-approved read-only Notion export
result: [pass]
evidence: "twin uat-p2006fresh @1ee0b11: 2 graphs backfilled from exported rows, 3 nodes, 3 Linear identifiers"

### 4. The brief reaches a Claude Code session

expected: installed plugin fetchBrief with SUBSTRATE_URL always in env returns a non-empty brief, and formatPromptContext contains ## Agent Substrate brief, with no model quota spent; plugin version and commit recorded
result: [pass]
evidence: "twin uat-p2006fresh @1ee0b11: fetchBrief non-empty brief (259 bytes), prompt-context header present; plugin 0.3.0 @ 85ca1ac"

### 5. ultrathink-kickoff calls graph_register

expected: read-only — Claude Code config has an MCP server named substrate whose Authorization header names the token variable; live — given --graph from a real kickoff, graph_get returns it with nodes and Linear identifiers, registered by surface claude-code
result: [pass]
evidence: "production live 2026-10-10 (uat-p20live5c): ~/.claude.json user-scope substrate entry, HTTP transport into http://127.0.0.1:7410/mcp, Authorization header names ${SUBSTRATE_TOKEN}; live kickoff graph ut-mugbqivi-752f2dad returned with nodes and Linear identifiers"

### 6. Cursor hooks and the git post-commit collector are installed

expected: cursor --check reports the three substrate entries current and the stop script present, install-git-hook --check reports the hook present; sessionStart writes .substrate/BRIEF.md and emits no event; harness — synthetic envelopes in a scratch repo plus a commit through the installed hook, matched by surface, kind, repo and since; production — a real Cursor session and a real commit
result: [pass]
evidence: "twin uat-p2006fresh @1ee0b11: 3 desired entries; BRIEF.md written, no event emitted; stop exit 0 stdout empty; hook present; 1 commit event matched by surface, kind, repo and since; tool.call read-back 1 row"

### 7. A substrate outage does not block any agent

expected: against its own dead port and its own hanging listener (never the target) — fetchBrief returns "" within 1500 ms plus 250 ms slack, substrate brief exits 0 with empty stdout within budget, hook commands exit 0 with nothing on stdout
result: [pass]
evidence: "twin uat-p2006fresh @1ee0b11: fetchBrief empty in 0 ms; CLI brief exit 0 empty stdout in 41 ms; hook brief exit 0 stdout empty in 1546 ms"

### 8. Phase proof — cross-surface brief

expected: graph G with run-tagged repo R and node n1, n1 claimed as claude-code, file.edit emitted as cursor with repo R and graph G, then POST /brief as hermes with repo R and graph G lists the cursor edit line and n1 held by claude-code
result: [pass]
evidence: "twin uat-p2006fresh @1ee0b11: graph_claim decision granted; file.edit emit 202 stored true; brief 200 with cross-surface lines"

## Summary

total: 8
passed: 6
issues: 0
pending: 2
skipped: 0
blocked: 0

## Gaps
