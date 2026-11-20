---
phase: 45-railway
verified: 2026-11-12T08:35:59Z
status: human_needed
score: 3/3 must-haves verified in-repo (live Railway proof operator-gated)
behavior_unverified: 0
overrides_applied: 0
covered_files: [".env.example", ".planning/milestones/v1.5-phases/45-railway/PLAN.md", ".planning/milestones/v1.5-phases/45-railway/SUMMARY.md", "docs/config-reference.md", "docs/data-planes.md", "docs/event-vocabulary.md", "docs/observability.md", "packages/audit/src/policy.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/railway-mcp.test.ts", "packages/mcp-server/src/railway.test.ts", "packages/mcp-server/src/railway.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:64892fbbd85914c8967ae30d51a2d35d338b4c7d6a037638d2d9a7086a253fc7"
human_verification:
  - test: "Read one live Railway project: run railway_list and railway_monitor with RAILWAY_API_TOKEN and SUBSTRATE_RAILWAY_PROJECT_IDS set on the server"
    expected: "Projects, environments and services return; monitor returns the latest deployment status"
    why_human: "Requires a live Railway token and project id (operator-held). Not run."
  - test: "On that live read, confirm the units of CPU_USAGE, CPU_LIMIT, MEMORY_USAGE_GB and MEMORY_LIMIT_GB (code assumes vCPU and GB) and run railway_scale_suggest"
    expected: "Units match the assumption; suggestion is ok or insufficient-data with a sane value"
    why_human: "Live metric units cannot be proven from fixtures. Not run."
  - test: "Confirm the unit of estimatedValue from estimatedUsage, then set SUBSTRATE_RAILWAY_PRICE_* from the Railway pricing sheet and run railway_cost and /slo"
    expected: "railwayCost shows priced lines and a projected monthly total against the $50 budget, or unpriced when prices are unset"
    why_human: "Price and unit confirmation is operator-gated. Not run."
  - test: "Gated write path (railway_scale, railway_deploy) in a named window with SUBSTRATE_RAILWAY_WRITES=on and an approval reference"
    expected: "Applied write emits railway.<op>.applied; refused write emits railway.<op>.refused and makes no request"
    why_human: "Live writes are operator-gated. Not run; in-repo refusal and single-call paths are covered by tests (see below)."
---

# Phase 45: Railway Resource Orchestrator Verification Report

**Phase Goal:** Railway services are managed through MCP tools (list, scale, monitor, deploy) using the forwarders, with a basic scale suggestion and a cost report.
**Verified:** 2026-11-12T08:35:59Z
**Status:** human_needed
**Re-verification:** No — initial verification in v1.5-phases. Prior report (2026-10-21, human_needed) was re-checked against current code and is superseded by this one.

Note on the goal text: the ROADMAP goal says "using the forwarders". CONTEXT D45-a and the SUMMARY say control-plane calls go to Railway's public API with a bearer token and never through the Tailscale forwarders. The implementation follows D45-a. The ROADMAP wording is stale; this is recorded, not a gap.

## Goal Achievement

### Observable Truths

Must-haves source: ROADMAP Phase 45 success criteria (3). PLAN.md has no `must_haves` frontmatter, so no further truths were added or removed.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | MCP tool lists Railway resources | ✓ VERIFIED | `packages/mcp-server/src/mcp.ts:2229-2240` registers `railway_list` → `substrate.railway.listResources()`. `railway.ts:923` `RailwayClient.listResources` issues the project/environment/service query. `railway.test.ts` "list maps projects environments and services" and "list without configured projects reads every project" pass. |
| 2 | Basic scale suggestion | ✓ VERIFIED | `mcp.ts:2258-2270` registers `railway_scale_suggest` (advisory, read-only). `railway.ts:609` `suggestScale` is p95 plus headroom, clamped, insufficient-data under 24 samples. `railway.ts:963` `RailwayClient.suggestScale` reads the metrics window. `railway.test.ts` "suggests p95 plus headroom", "suggestion clamps to bounds", "too few samples gives no suggestion", "missing limit gives no suggestion" pass. |
| 3 | Cost report in /slo | ✓ VERIFIED | `server.ts:1122` `const railwayCost = await substrate.railway.costReport().catch(() => null)`; `server.ts:1173` adds `railwayCost` to the `/slo` 200 payload. `breached` (`server.ts:1163-1167`) is built only from catalogue, plane and burn results, so it never includes the railway row. `service.ts:8809` wires `railwayCost`. `railway-mcp.test.ts:146-172` "/slo carries railwayCost and never breaches on it" passes, including the `unavailable` case. |

**Score:** 3/3 truths verified in-repo (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/railway.ts` | Client, pure functions, env parser | ✓ VERIFIED | 1086 lines; exports `railwayFromEnv`, `suggestScale`, `buildCostReport`, `RailwayClient`, write gate. Also contains a `RailwayResourceOrchestrator` class (`railway.ts:122`) and `resolveLightragHostingState` (`:51`) that the Phase 45 PLAN does not describe. Not a gap for this phase; noted for the owner. |
| `packages/mcp-server/src/railway.test.ts` | Unit tests | ✓ VERIFIED | Ran: 49 tests across the two railway test files, 0 fail. |
| `packages/mcp-server/src/railway-mcp.test.ts` | MCP and /slo tests | ✓ VERIFIED | Ran with the file above; write-gate, read-gate and /slo tests pass. |
| `packages/mcp-server/src/mcp.ts` | Six tools registered | ✓ VERIFIED | `railway_list` 2229, `railway_monitor` 2242, `railway_scale_suggest` 2258, `railway_cost` 2276, `railway_scale` 2457, `railway_deploy` 2485. |
| `packages/mcp-server/src/server.ts` | `/slo` railwayCost key | ✓ VERIFIED | 1122, 1173 (report-only). |
| `packages/mcp-server/src/config.ts` | `railway` config field | ✓ VERIFIED | Imports `railwayFromEnv` (`config.ts:24`). |
| `packages/mcp-server/src/service.ts` | `railway` client on Substrate | ✓ VERIFIED | `:1557`, `:1779`, `:8809`. |
| `packages/mcp-server/src/admission.ts` | Tool classes | ✓ VERIFIED | `:261-278`: four reads, two writes. |
| `packages/mcp-server/src/observe.ts` | KNOWN_TOOLS | ✓ VERIFIED | `:681-686`. |
| `packages/audit/src/policy.ts` | Fail-closed writes, fail-open reads | ✓ VERIFIED | Writes `:35-36`; reads `:82-85`. |
| `packages/mcp-server/src/event-sources.ts` | Event rows | ✓ VERIFIED | Applied and refused rows for scale and deploy `:1079-1143`; read silent rows `:1643-1658`. |
| `packages/mcp-server/src/flag-registry.ts` | Flag rows | ✓ VERIFIED | `SUBSTRATE_RAILWAY_WRITES` row at `:821`; 20 RAILWAY matches. |
| `.env.example` | Railway section | ✓ VERIFIED | 19 RAILWAY matches; `:477` writes note. |
| `docs/data-planes.md` | Railway control plane section | ✓ VERIFIED | `:246-247` D45-b and D45-c. |
| `docs/observability.md` | `railwayCost` paragraph | ✓ VERIFIED | `:511`. |
| `docs/event-vocabulary.md` | Event rows | ✓ VERIFIED | `:359`. |
| `docs/config-reference.md` | Regenerated | ✓ VERIFIED | `:62` lists `SUBSTRATE_RAILWAY_WRITES`. Regeneration `--check` not run. |

### Key Link Verification

PLAN.md has no `must_haves.key_links`, so `verify.key-links` returns NO_INPUT (exit 66) and this step is not applicable. Wiring was checked by grep:

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `mcp.ts` railway_list/monitor/scale_suggest/cost | `substrate.railway` | `railwayRead` | ✓ WIRED | `mcp.ts:2229-2277` |
| `server.ts /slo` | `RailwayClient.costReport` | `substrate.railway` | ✓ WIRED | `server.ts:1122` |
| `service.ts` | `RailwayClient(config.railway)` | factory | ✓ WIRED | `service.ts:1779` |
| `config.ts` | `railwayFromEnv` | import | ✓ WIRED | `config.ts:24` |

### Data-Flow Trace (Level 4)

Not run as a separate level. The rendered values (`railwayCost`, the listed resources, the scale suggestion) come from the Railway client, which reads the GraphQL endpoint. The client is covered by the fake-fetch tests above, so data flow is proven against fixtures only, not against Railway.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Railway client, pure functions, MCP tools, /slo row | `bun test packages/mcp-server/src/railway.test.ts packages/mcp-server/src/railway-mcp.test.ts` | 49 pass, 0 fail, 2 files, 670 ms | ✓ PASS |
| Writes refuse without gate, zero requests | same run, "write gate" group | pass | ✓ PASS |
| Live Railway read | none | not run (needs token and project id) | ? SKIP |

### Probe Execution

No probes declared or implied by PLAN/SUMMARY (`scripts/*/tests/probe-*.sh` not referenced). Not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| SOTA-01 | 45-01 | Railway Resource Orchestrator (acceptance: list, scale suggestion, cost in /slo) | ✓ SATISFIED in repo; live proof open | Truths 1-3 above. REQUIREMENTS.md records "Complete in repo; live proof operator-gated". |

No orphaned requirements: REQUIREMENTS.md maps only SOTA-01 to phase 45.

### Anti-Patterns Found

No `TBD`, `FIXME` or `XXX` in any covered file. Nothing blocking.

### Human Verification Required

1. **Live read of one Railway project.** Set `RAILWAY_API_TOKEN` and `SUBSTRATE_RAILWAY_PROJECT_IDS` on the server, then run `railway_list` and `railway_monitor`. Expected: resources and the latest deployment return. Not run.
2. **Metric units and `estimatedValue` unit.** Confirm vCPU and GB on the live read, then run `railway_scale_suggest`. Not run.
3. **Prices and cost report.** Set `SUBSTRATE_RAILWAY_PRICE_*` only from the Railway pricing sheet; run `railway_cost` and `/slo`. Not run.
4. **Gated writes.** `railway_scale` and `railway_deploy` in a named window with `SUBSTRATE_RAILWAY_WRITES=on` and an approval reference. Not run; in-repo gate behavior is tested.

### Gaps Summary

No gaps. All three ROADMAP success criteria are met in the repository and proven against a fake Railway endpoint. Status is `human_needed` because the live Railway proof (reads, metric units, prices, gated writes) is operator-gated and was not run.

Not in this phase: replica scaling (D45-k, owner decision). Not a gap for SOTA-01 because the criteria do not require it.

Scope notes, not gaps:
- The ROADMAP goal says "using the forwarders". D45-a moved control-plane calls to Railway's public API. The ROADMAP wording is stale.
- `railway.ts` contains a `RailwayResourceOrchestrator` class that the PLAN does not describe. Owner should confirm it belongs here.

Checks not run: `bun run check:phase-close`, the policy/admission/event-sources/flag-registry test files, `bunx tsc --noEmit`, `config:reference --check`, the full `bun test` suite, and any live-DB check. Postgres was not used.

---

_Verified: 2026-11-12T08:35:59Z_
_Verifier: Claude (gsd-verifier)_
