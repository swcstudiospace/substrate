# Requirements: Agent Substrate — v1.3.x and v1.5 programs

**Defined:** 2026-10-21
**Core Value:** Every agent on the host shares one brief, one event log, one governed memory plane, one skills library and one Graph ID.

## Sources

- `.planning/research/SUMMARY.md` lines 64–72: must-have (64–66), should-have (68), defer (70), anti-features to hold (72).
- `.planning/research/FEATURES.md` Differentiators table, rows for the 15 v1.3.x IDs at lines 197–222 (table header at line 195).
- `.planning/milestones/v1.3-REQUIREMENTS.md` line 85 (DOCS-04), cited only for the D-D1 conflict.
- `.planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements)`: the seven SOTA enhancements, lines 12–59.

Column mapping. The FEATURES.md Differentiators header is `| ID | Area | Feature | Value Proposition | Complexity | Notes |` (line 195). This file uses: Item = Feature; Outcome = Value Proposition; Notes = the FEATURES.md Notes column, verbatim; it sometimes names a dependency and sometimes gives a rationale. Where Notes is empty, the value is "not stated".

## v1.3.x should-have requirements

Source for all entries: `.planning/research/FEATURES.md` lines 197–222 and `.planning/research/SUMMARY.md` line 68. Phase mapping is set by the program plan, not by the sources.

- [ ] **A-D1**: Lane B events reach the graph's brief and evidence without agents passing ids
  - Item: Infer the graph from the per-Graph-ID worktree path for herdr and Muse events. Area: A (Lane B collectors). Complexity: LOW. Notes: Needs C-T3. Phase: 37. Source: FEATURES.md:197
- [ ] **B-D1**: Closes `coordination.md:321` "Not done"
  - Item: Mirror graph edges (`requires` / `blocks` / `gated_by`) into Linear relations. Area: B (claim mirror). Complexity: MEDIUM. Notes: not stated. Phase: 38. Source: FEATURES.md:200
- [ ] **B-D3**: One artifact shows claim → Linear → Notion → DoD
  - Item: Put mirror outcomes in `substrate evidence` per node. Area: B (claim mirror). Complexity: LOW. Notes: M6. Phase: 38. Source: FEATURES.md:202
- [ ] **C-D2**: The dispatched context can be replayed from the ledger (v0.3 §2)
  - Item: Dispatch as a signed handoff packet (goal from the issue, DoD lines, files). Area: C (dispatcher). Complexity: LOW-MEDIUM. Notes: M2. Phase: 39. Source: FEATURES.md:204
- [ ] **C-D4**: A stale-brief warning before acting (v0.3 §2)
  - Item: Run `coord_drift_scan` on the worktree before launch. Area: C (dispatcher). Complexity: LOW. Notes: M2. Phase: 39. Source: FEATURES.md:206
- [ ] **D-D1**: `data-planes.md:34`
  - Item: Cross-surface recall in the brief: a bounded, cached fan-out over the `sub-*` banks. Area: D (docs plane). Complexity: MEDIUM. Notes: `agentId:"*"` is an Agentmemory idiom, and Hindsight banks are isolated ([docs](https://docs.hindsight.vectorize.io/memory-banks/)). Phase: 40. Source: FEATURES.md:207
  - DECISION PENDING. It conflicts with DOCS-04 (`.planning/milestones/v1.3-REQUIREMENTS.md:85`: "recall is a tool (or derived-marked `memory_search` results) and never runs inside the brief's 1.5 s budget") and with the anti-feature "recall inside the synchronous brief" (`.planning/research/SUMMARY.md:72`).
- [ ] **D-D3**: One memory plane (the §5.0 no-silo rule)
  - Item: Retire Claude Code's global `hindsight` stdio MCP and Hermes supermemory once the `sub-*` banks answer, with restore routes recorded first. Area: D (docs plane). Complexity: MEDIUM. Notes: P10. Phase: 40. Source: FEATURES.md:209
- [ ] **D-D4**: Mental models replace stale detail (`data-planes.md:27,39`)
  - Item: A weekly `reflect` per bank. Area: D (docs plane). Complexity: LOW. Notes: not stated. Phase: 40. Source: FEATURES.md:210
- [ ] **E-D1**: PR and incident evidence anyone can check outside the system (v0.3 6.x)
  - Item: Anchors in the evidence bundle: a tx signature and an explorer link per hour. Area: E (ledger anchor). Complexity: LOW. Notes: M6. Phase: 41. Source: FEATURES.md:211
- [ ] **E-D2**: A user addition carried in the brief's area E
  - Item: Anchor teachable moments (graph id plus an observation digest). Area: E/F (as written in source). Complexity: MEDIUM. Notes: Needs F-D2 and E-T4. Phase: 41. Source: FEATURES.md:212
- [ ] **F-D3**: §5.1; v0.3 "4.x Skill approve audit"
  - Item: `skills_list` and an approve/decline audit trail. Area: F (skills plane). Complexity: LOW-MEDIUM. Notes: In September, approval meant the owner merging the PR (D-16). How `declined` is reported was left unspecified. Phase: 42. Source: FEATURES.md:215
- [ ] **F-D4**: Skills become searchable through `docs_search`
  - Item: Re-ingest the `agent-skills` dataset after each fast-forward. Area: F/D (as written in source). Complexity: LOW. Notes: D-T3. Phase: 42. Source: FEATURES.md:216
- [ ] **H-D1**: September N3: the container could reach example.com
  - Item: An enforced egress allowlist for the sandbox container. Area: H (Lane A). Complexity: MEDIUM. Notes: not stated. Phase: 43. Source: FEATURES.md:219
- [ ] **H-D3**: No orphaned VMs
  - Item: Re-adopt running tasks after a dispatcher restart (N4). Area: H (Lane A). Complexity: LOW-MEDIUM. Notes: not stated. Phase: 43. Source: FEATURES.md:221
- [ ] **I-D1**: A regression check for every later phase
  - Item: The UAT as a repeatable script run against any `SUBSTRATE_URL`. Area: I (Phase 0 UAT). Complexity: LOW-MEDIUM. Notes: not stated. Phase: 44. Source: FEATURES.md:222

## v1.5 SOTA requirements

Source for all entries: `.planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements)`. The Acceptance and Target files lines are copied verbatim.

- [ ] **SOTA-01**: Railway Resource Orchestrator. Phase: 45. Source: .planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements):12–17
  - Acceptance: MCP tool lists Railway resources, basic scale suggestion, cost report in /slo.
  - Target files: packages/mcp-server/src (new railway.ts), docs/data-planes.md, config-reference.md
- [ ] **SOTA-02**: RAGFlow Advanced Hybrid RAG with Hindsight Context. Phase: 46. Source: .planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements):19–24
  - Acceptance: docs_search returns context-augmented results; tests for hybrid.
  - Target files: packages/mcp-server/src/planes/ragflow.ts, planes/hindsight.ts, docs/docs-plane.md
- [ ] **SOTA-03**: GreptimeDB + Dragonfly Predictive Analytics & Cache. Phase: 47. Source: .planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements):26–31
  - Acceptance: /slo has predictive rows; cache preloads based on patterns.
  - Target files: packages/mcp-server/src/cache.ts, greptime code, observability, data-planes.md
- [ ] **SOTA-04**: TailscaleDB Secure Unified Proxy Layer. Phase: 48. Source: .planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements):33–38
  - Acceptance: All DBs accessed via secure proxy; audit events for access.
  - Target files: docs/railway-tailscale.md, data-planes.md, config for DBs
- [ ] **SOTA-05**: Hindsight Graph Memory with Greptime Events. Phase: 49. Source: .planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements):40–45
  - Acceptance: memory_search returns graph-linked results; recall uses causal.
  - Target files: packages/mcp-server/src/planes/hindsight.ts, memory code, greptime
- [ ] **SOTA-06**: Dragonfly Pub/Sub for Real-time Events. Phase: 50. Source: .planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements):47–52
  - Acceptance: Real-time notifications for events via Dragonfly; tests.
  - Target files: packages/mcp-server/src/cache.ts, event emit code
- [ ] **SOTA-07**: Enterprise Unified Resource Fabric. Phase: 51. Source: .planning/7-SOTA-ENHANCEMENTS.md (branch feature/7-sota-enhancements):54–59
  - Acceptance: New MCP tools for fabric status, optimization suggestions; compliance report.
  - Target files: packages/mcp-server/src (new fabric/), observability, docs, config-reference

## Out of scope and deferred

Defer (v2+), from `.planning/research/SUMMARY.md` line 70:

**Defer (v2+):** A-D2 herdr-hosted dispatch, A-D3 Orca tee, B-D2 Linear Agent Sessions, C-D3 extra launchers, D-D2 ingest on merge, G-D1 cua, H-D2 Codex/OpenCode/Pi VMs.

Anti-features, from `.planning/research/SUMMARY.md` line 72:

**Anti-features to hold:** substrate sending Done itself; `labelIds` overwrite; rolling back a lease on tracker failure; dispatcher claiming for the agent; issue text in prompts; RAGFlow MCP as backend; Hindsight as store of record; Dragonfly as queue/lock; recall inside the synchronous brief; event contents on chain; porting `chain.ts`; auto-merging skills; stopping production for UAT scenario 7; proof rows in the production ledger.

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| A-D1 | 37 | Pending |
| B-D1 | 38 | Pending |
| B-D3 | 38 | Pending |
| C-D2 | 39 | Pending |
| C-D4 | 39 | Pending |
| D-D1 | 40 | Pending |
| D-D3 | 40 | Pending |
| D-D4 | 40 | Pending |
| E-D1 | 41 | Pending |
| E-D2 | 41 | Pending |
| F-D3 | 42 | Pending |
| F-D4 | 42 | Pending |
| H-D1 | 43 | Pending |
| H-D3 | 43 | Pending |
| I-D1 | 44 | Pending |
| SOTA-01 | 45 | Pending |
| SOTA-02 | 46 | Pending |
| SOTA-03 | 47 | Pending |
| SOTA-04 | 48 | Pending |
| SOTA-05 | 49 | Pending |
| SOTA-06 | 50 | Pending |
| SOTA-07 | 51 | Pending |

---
*Requirements defined: 2026-10-21*
