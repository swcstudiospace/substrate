# Phase 40 — DOCS-MEMORY: one memory plane, cross-surface recall, weekly reflect

## Gap
- D-D1 (REQUIREMENTS.md:29-31): cross-surface recall in the brief, a bounded, cached fan-out over the `sub-*` banks. Decision 2026-10-21 amends DOCS-04 (ROADMAP.md:553).
- D-D3 (REQUIREMENTS.md:32-33): one memory plane. Retire Claude Code's global `hindsight` stdio MCP and Hermes supermemory once the `sub-*` banks answer, with restore routes recorded first.
- D-D4 (REQUIREMENTS.md:34-35): a weekly `reflect` per bank. Mental models replace stale detail (`data-planes.md:27,39`).
- Success criteria (ROADMAP.md:563-565): (1) D-D1 as above; (2) the two MCPs retired once the banks answer, restore routes recorded first; (3) a weekly reflect per bank.

## Decisions (operator, 2026-10-21)
1. **The 1.5 s brief budget does not apply to recall.** Recall is exempt and may run past 1.5 s, in that case only. The rest of the brief keeps its budget.
2. **Retirement is planned in this phase and executed only after a restore drill.** The restore routes are recorded first. Execution needs the operator's approval, so the retirement itself is not part of this phase's code change.

## Open, to settle from the code map
- The fan-out bounds: which banks, the per-bank timeout, the cache TTL and the generation key that invalidates it.
- The weekly reflect mechanism: an existing timer, or a new one.
- Where the two MCP registrations live, and what a restore route for each is.

## Out of scope in this phase
- Executing the retirement of either MCP (needs the restore drill and operator approval).
