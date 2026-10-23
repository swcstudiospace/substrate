---
phase: 45-railway
requirements: [SOTA-01]
status: in review (draft PR). In-repo acceptance met with a fake Railway endpoint. Live reads, writes and the cost units are operator-gated and not run. Replica scaling is deferred (D45-k) and needs the owner's decision
---

# 45-SUMMARY: Railway resource orchestrator

## Built

- **Client** `packages/mcp-server/src/railway.ts`. Talks to the Railway public GraphQL endpoint with a bearer token from `RAILWAY_API_TOKEN`. The token is never written to errors, logs or results. Reads: projects, environments and services (`list`), the latest deployment (`monitor`), metrics and estimated usage. Pure functions: `suggestScale` and `buildCostReport`. Writes: `serviceInstanceLimitsUpdate` (scale) and `serviceInstanceRedeploy` (deploy).
- **Config and flags.** A `railway` block in `config.ts`, built from 14 environment names (the names listed in CONTEXT, not the 16 the plan's count said). Each name is in `flag-registry.ts` and `.env.example`, and the generated `docs/config-reference.md` was regenerated and checked.
- **MCP tools** in `mcp.ts`: `railway_list`, `railway_monitor`, `railway_scale_suggest`, `railway_cost` (reads), and `railway_scale`, `railway_deploy` (writes).
- **Write gate.** Writes are refused unless `SUBSTRATE_RAILWAY_WRITES=on`, the caller is the operator, and the call carries a valid approval reference. Bounds are checked before the gate. Each refusal and each applied write emits one event. Failures return `isError`.
- **`/slo` row.** `railwayCost` is a report-only key. It is never added to `breached`. The client caches the cost read for 15 minutes, and a failure reports `unavailable` without taking `/slo` down.
- **Policy and admission.** Writes are fail-closed and reads fail-open, in `packages/audit/src/policy.ts`. Every tool has a class in `admission.ts`.
- **Event catalog.** Four `EVENT_SOURCES` rows for applied and refused writes, and four `SILENT_SOURCES` rows for reads. No new `EVENT_KINDS` entry, so the vocabulary lock still passes.
- **Docs.** `docs/data-planes.md` (Railway control plane section), `docs/observability.md` (cost report under SLOs), `docs/event-vocabulary.md`.

## Decisions

Recorded in CONTEXT.md as D45-a to D45-o. The ones that change behaviour:

- Control-plane calls go to Railway's public API with a token. They never go through the Tailscale forwarders, which carry data traffic only (D45-a).
- Reads need no approval. The scale suggestion is advisory and never applies anything (D45-b).
- Writes need `SUBSTRATE_RAILWAY_WRITES=on`, the operator, and an approval reference. The default is refuse (D45-c).
- The cost report multiplies measured usage by operator-set prices. With no prices it reports `unpriced` and never invents one. The budget defaults to 50 USD a month (D45-d).
- Scale suggestion: p95 of CPU and memory usage over the window, plus headroom, clamped to configured bounds (D45-e).

## Deviations from the plan

1. **Replica scaling is deferred (D45-k).** Introspection confirmed `numReplicas` only on `ServiceInstance` and a JSON `multiRegionConfig` on `ServiceInstanceUpdateInput`, with no confirmed input shape for writing replicas. The write implemented is vCPU and memory limits through `serviceInstanceLimitsUpdate`. Replica writes need the owner's decision and a live read to confirm the shape.
2. **Environment name count.** The plan said 16 names. CONTEXT lists 14, and the implementation uses those 14.
3. **Files outside the plan's list.** `service.ts` (the `railway` client field and injection), `server.ts` (the `/slo` key), `observe.ts` (`KNOWN_TOOLS`), and `docs/observability.md` and `docs/event-vocabulary.md` were needed to compile, to list the tools, and to pass the vocabulary-drift test.
4. **Cost report needs a project id.** With a token but no `SUBSTRATE_RAILWAY_PROJECT_IDS`, the report is `unconfigured` and makes no request.
5. **Path collision in the operator's checkout.** The operator's checkout has an untracked `packages/mcp-server/src/railway.ts`, a stub that returns success with empty data. Pulling this phase's `railway.ts` will refuse to overwrite it. The stub must be moved aside first. Nothing in this repository depends on the stub.

## Not proven

- Live reads and writes against Railway. They need `RAILWAY_API_TOKEN`, a project id, and an operator approval reference. Nothing live was run.
- The units of `CPU_USAGE`, `CPU_LIMIT`, `MEMORY_USAGE_GB` and `MEMORY_LIMIT_GB`. The code assumes vCPU and GB. The first live read must confirm it.
- The unit and period of `estimatedValue` from `estimatedUsage`. The cost report shows the raw values, and prices are operator-set.
- `ServiceInstanceLimit` has no confirmed shape, so it is not used.
- Replica scaling (see deviation 1).

## Operator-gated steps

- Set `RAILWAY_API_TOKEN` and `SUBSTRATE_RAILWAY_PROJECT_IDS` on the server. Read one live `railway_list` and `railway_monitor`.
- Confirm the metric units on that read, then set `SUBSTRATE_RAILWAY_PRICE_*` only from the Railway pricing sheet.
- Enable writes only for a named window, with `SUBSTRATE_RAILWAY_WRITES=on` and an approval reference per call.
