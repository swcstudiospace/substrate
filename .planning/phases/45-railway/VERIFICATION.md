---
phase: 45-railway
verified: 2026-10-21
status: human_needed
score: 3 of 3 ROADMAP criteria proven in-repo with a fake Railway endpoint
verified_on: gsd/v15-45-railway at its pre-commit tree, based on origin/main 3e9a106
covered_files: ["packages/mcp-server/src/railway.ts", "packages/mcp-server/src/railway.test.ts", "packages/mcp-server/src/railway-mcp.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/event-sources.ts", "packages/audit/src/policy.ts", ".env.example", "docs/config-reference.md", "docs/data-planes.md", "docs/observability.md", "docs/event-vocabulary.md"]
---

> Status detail, kept verbatim from the original frontmatter: passed in-repo. Live Railway proof not run (operator-gated)

# 45-VERIFICATION: Railway resource orchestrator

## Proven in-repo

| Claim | Evidence |
|---|---|
| Typecheck is clean | `bunx tsc --noEmit` exit 0 |
| Railway client and pure functions | `bun test packages/mcp-server/src/railway.test.ts packages/mcp-server/src/railway-mcp.test.ts`: 40 pass, 0 fail, in 2 files |
| Full suite passes | `bun test` on this tree against its own verification database: 5871 pass, 2 skip (pre-existing), 0 fail. 5873 tests in 219 files, 232 s |
| Repo locks pass | `bun run check:phase-close`: 4 lock files green; EVENT_KINDS unchanged at 12 against ab62c91; SURFACES equals baseline plus substrate at 27 |
| Config reference is current | `bun run config:reference` regenerated `docs/config-reference.md`; `--check` reports up to date |
| Writes are refused without the gate | `railway-mcp.test.ts`: write tools refuse without the operator gate and make no request; refuse with writes off |
| A gated write reaches the client once | `railway-mcp.test.ts`: gated write reaches the client once |
| Reads need no gate | `railway-mcp.test.ts`: read tools need no gate |
| `/slo` carries the cost row and never breaches on it | `railway-mcp.test.ts`: `/slo carries railwayCost and never breaches on it` |
| Every Railway tool has an admission class | `railway-mcp.test.ts`: tool classes cover every registered railway tool |
| Suggestion and cost are computed from fixtures | `railway.test.ts`: p95 nearest rank, headroom, clamping, budget comparison, unpriced rather than free |
| Errors never echo the token | `railway.test.ts`: errors never echo the token |

## ROADMAP criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | An MCP tool lists Railway resources | PASS in-repo with a fake endpoint | `railway_list`; `railway.test.ts` list tests |
| 2 | A basic scale suggestion | PASS in-repo | `railway_scale_suggest`; `suggestScale` tests |
| 3 | A cost report in /slo | PASS in-repo | `/slo` `railwayCost` row; `railway-mcp.test.ts` |

## Not proven

- Live reads and writes against Railway. Operator-gated; nothing live was run.
- The metric units and the `estimatedValue` unit. Confirmed only by the first live read.
- Replica scaling. Deferred (D45-k), owner decision needed.
