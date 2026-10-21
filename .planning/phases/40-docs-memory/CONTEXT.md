# Phase 40 — DOCS-MEMORY: one memory plane, cross-surface recall, weekly reflect

## Gap
- D-D1 (REQUIREMENTS.md:29-31): cross-surface recall in the brief, a bounded, cached fan-out over the `sub-*` banks. Decision 2026-10-21 amends DOCS-04 (ROADMAP.md:553).
- D-D3 (REQUIREMENTS.md:32-33): one memory plane. Retire Claude Code's global `hindsight` stdio MCP and Hermes supermemory once the `sub-*` banks answer, with restore routes recorded first.
- D-D4 (REQUIREMENTS.md:34-35): a weekly `reflect` per bank. Mental models replace stale detail (`data-planes.md:27,39`).
- Success criteria (ROADMAP.md:563-565): (1) D-D1 as above; (2) the two MCPs retired once the banks answer, restore routes recorded first; (3) a weekly reflect per bank.

## Decisions (operator, 2026-10-21)
1. **Recall is exempt from the brief budget, capped at 3000 ms.** The brief budget (1200 ms) still governs the rest of the brief. Recall alone may run past it, and never past 3000 ms.
2. **Retirement is planned in this phase and executed only after a restore drill.** The restore routes are recorded first. Execution needs the operator's approval, so the retirement itself is not part of this phase's code change.

## Map facts (read-only, with citations)
- The brief budget defaults to 1200 ms (`packages/mcp-server/src/config.ts:715`, `SUBSTRATE_BRIEF_BUDGET_MS`). The 1500 ms figure is the recall prefetch budget (`recall-snapshot.ts:40`, `DEFAULT_RECALL_BUDGET_MS`). The 1.5 s wording in DOCS-04 therefore matches the prefetch budget, not the brief budget.
- Recall enters the brief only under `SUBSTRATE_BRIEF_RECALL=enforce`, through `BriefOptions.recall` (`brief.ts:39-50`, `brief.ts:285-289`). A cold or stale snapshot omits the section (`brief.ts:386-395`). Recall is off by default (`config.ts:463-466`, `recall-snapshot.ts:86-101`).
- The current recall refresh reads one bank, the surface's own. It is never a fan-out (`docs/memory-governance.md:606-608`, `recall-snapshot.ts` refresh path).
- Cache TTLs: `brief` 300 s, `recall-snapshot` 1800 s (`cache.ts:42-49`). `recall-snapshot` is generation-free (`cache.ts:28-31`).
- Nothing in the repo implements `reflect` or mental models (no Hindsight API use under `packages/mcp-server/src`, `packages/host/src`, `packages/miner/src` or `docs`).
- No config file for the Claude Code global hindsight MCP or the Hermes supermemory integration is in the repo. Only prose mentions exist.

## Open, for the plan
- The fan-out bounds inside the 3000 ms cap: the bank list and its source, a per-bank timeout, and the cache key and invalidation.
- The weekly reflect mechanism: an existing timer or a new one, and how it is started.
- The restore-route format for each MCP, and the restore drill that gates execution.

## Out of scope in this phase
- Executing the retirement of either MCP (needs the restore drill and operator approval).
