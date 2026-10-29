---
phase: 51-enterprise-fabric
requirements: [SOTA-07]
status: designed on origin/main 2495a14; not yet implemented
---

# 51-CONTEXT: Enterprise unified resource fabric

## Scope (ROADMAP and 7-SOTA plan, item 7)

Goal: one MCP interface covers the six resources on Railway and Tailscale, with cross-resource optimization and compliance reporting.
Success criteria (authoritative):
1. New MCP tools for fabric status and optimization suggestions.
2. Compliance report.

## Resources

The six resources are the five services in `docs/data-planes.md` ("The five services and where they live") plus the Railway control plane:

| Resource | Plane | Source of state | Endpoint class |
|---|---|---|---|
| `railway` | control plane | `RailwayClient.costReport()` (15-minute cache, never rejects) | not applicable |
| `greptime` | ledger / events | `health().greptime` | `dbEndpoints` class for the greptime plane |
| `postgres` | index / coordination | `health().index` | `dbEndpoints` class for the postgres plane |
| `dragonfly` | cache and pub/sub hints | `health().cache`, `health().eventBus` | `dbEndpoints` class for the dragonfly plane |
| `hindsight` | memory / recall | `health().planes.hindsight`, `hindsightInventoryHealth()` | not applicable (HTTP plane, no endpoint policy) |
| `ragflow` | documents | `health().planes.ragflow` | not applicable (HTTP plane, no endpoint policy) |

Tailscale is the network dimension: the endpoint class (`loopback`, `proxy`, `direct`, `unset`) from phase 48 is reported for the three database planes. No separate Tailscale probe exists or is added.

## State on origin/main 2495a14 (scouted)

- `Substrate.health()` returns `SubstrateHealth` with `index`, `greptime`, `appendOnly`, `eventsWritable`, `cache`, `planes: Record<PlaneName, {ok, breaker, lastErrorAt}>`, `capacity`, `jobs`, and (phase 50) `eventBus`. It is the same object `/healthz` uses. It reads breaker and probe state; it performs no new probe for the fabric.
- `RailwayClient.costReport()` returns `{status, budgetUsd, projectedMonthlyUsd, lines, detail, generatedAt}`. Statuses: `ok`, `over-budget`, `unpriced`, `unavailable`, `unconfigured`. It never rejects and is cached for 15 minutes.
- `RailwayClient.suggestScale(ref)` and `monitor(ref)` are per-service reads. They need a service reference, so the fabric does not call them. Scaling suggestions stay with `railway_scale_suggest`.
- `TOOL_CLASSES` (`admission.ts`) must list every registered MCP tool (`admission.test.ts` enforces this). `FAIL_OPEN_TOOLS` and `FAIL_CLOSED_TOOLS` (`packages/audit/src/policy.ts`) must each list every served tool (`policy.test.ts` enforces this). `KNOWN_TOOLS` (`observe.ts`) labels each tool.
- The endpoint policy and classes are phase 48: `config.dbEndpoints` (`policy`, `allow`, and per-plane classes). Boot notes `db.endpoint` already exist.
- `vocabulary-lock.test.ts` closes `EVENT_KINDS` at 12 and `SURFACES` at 27. This phase adds no event kind and no surface.

## Decisions

- D51-a. Read-only tools only: `fabric_status`, `fabric_suggest`, `fabric_compliance`. No writes, no scaling, no endpoint changes. Writes stay with their existing gated tools.
- D51-b. The fabric reuses `health()` and `railway.costReport()`. It adds no new probes, no new event kind, no schema change, and no new config flag, so `docs/config-reference.md` does not change.
- D51-c. Each source read runs under a 1500 ms deadline. A source that misses its deadline gives state `unknown` for its resource and the call still returns. Nothing throws to the MCP caller for a missing source.
- D51-d. The classification and the rules are pure functions over a typed facts object (`fabric/types.ts`), so they are testable without a service. The service builds the facts from `health()`, `config`, and the Railway cost report.
- D51-e. Output never carries a URL, host, port, credential, token, or endpoint text. Endpoint classes and plane names only. Detail strings are fixed phrases, not error text.
- D51-f. "Dashboards" in the phase goal is not an acceptance criterion. The JSON from `fabric_status` is the data a dashboard reads. No UI, no new `/slo` route, and no change to `/slo`. Recorded here so the gap is explicit.
- D51-g. Admission class `read`; audit decision fail-open (reads, as the other MCP reads); `KNOWN_TOOLS` labels added.
- D51-h. Suggestions are deterministic rules with a stable `id`, a `severity` (`info` or `attention`), and a `reference` to an existing docs section. Each rule has a positive and a negative test.

## Acceptance mapping

- New MCP tools for fabric status and optimization suggestions: `fabric_status` returns one row per resource with state and endpoint class; `fabric_suggest` returns the rules that fire over those rows (D51-a, D51-h).
- Compliance report: `fabric_compliance` returns pass, finding, or not-applicable per check, with the counts and no secrets (D51-e).
- Goal coverage: six resources, Tailscale as the endpoint dimension, cross-resource suggestions. Dashboards excluded by D51-f.

## Open items (recorded, not in scope)

- Hint-driven cache invalidation is still not implemented (phase 50 limit).
- Railway replica scaling decision (D45-k) remains an operator decision.
- The fabric does not read Tailscale ACLs or forwarder health; those are operator-gated (phase 48).
