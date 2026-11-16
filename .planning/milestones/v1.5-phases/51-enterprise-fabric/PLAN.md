---
phase: 51-enterprise-fabric
requirements: [SOTA-07]
depends_on: [45, 48, 50]
---

# 51-PLAN: Enterprise unified resource fabric

## Sequencing

Code starts only after PR 102 (phase 48) and PR 103 (phase 50) are merged to `origin/main`, because the fabric reads `config.dbEndpoints` (phase 48) and `health().eventBus` (phase 50). Until then this branch holds the records only.

## Module layout

All new code lives under `packages/mcp-server/src/fabric/`. Existing files change only where a registration list needs a row.

| File | Role |
|---|---|
| `fabric/types.ts` | Types only: resource names, states, endpoint classes, `FabricFacts`, `FabricStatus`, `FabricSuggestion`, `FabricCompliance`, `FabricSources`. |
| `fabric/status.ts` | `buildFabricStatus(facts: FabricFacts): FabricStatus`. Pure. |
| `fabric/suggest.ts` | `buildFabricSuggestions(status: FabricStatus, facts: FabricFacts): FabricSuggestion[]`. Pure. |
| `fabric/compliance.ts` | `buildFabricCompliance(facts: FabricFacts): FabricCompliance`. Pure. |
| `fabric/gather.ts` | `gatherFabricFacts(sources: FabricSources): Promise<FabricFacts>`. The only I/O, and every source read runs under `FABRIC_SOURCE_DEADLINE_MS = 1500`. |
| `fabric/fabric.test.ts` | Pure unit tests for status, suggestions, compliance, and gather with stub sources. |
| `mcp.ts` | Registers `fabric_status`, `fabric_suggest`, `fabric_compliance` with `annotations: { readOnlyHint: true }`. Each handler calls `gatherFabricFacts(sources)` and then the matching pure builder. |
| `service.ts` | One method `fabricSources(): FabricSources` that returns functions over `this.health()`, `this.railway.costReport()`, `this.hindsightInventoryHealth()`, and the config view. No new state. |
| `admission.ts` | `TOOL_CLASSES` gains the three tools as `"read"`. |
| `packages/audit/src/policy.ts` | `FAIL_OPEN_TOOLS` gains the three tools (reads). |
| `observe.ts` | `KNOWN_TOOLS` gains the three tools as labels. |
| `docs/observability.md` | New section "### Unified resource fabric (phase 51)" after "### Railway cost report (Phase 45)". |
| `docs/data-planes.md` | New short section "## Unified resource fabric (Phase 51)" that maps the six resources to their planes and states the endpoint dimension. |

No event kind, no surface, no flag, no schema, no route. `docs/config-reference.md` and `docs/event-vocabulary.md` do not change.

## Types (pinned)

```ts
export type FabricResourceName = "railway" | "greptime" | "postgres" | "dragonfly" | "hindsight" | "ragflow (retired)";
export type FabricState = "ok" | "degraded" | "down" | "unconfigured" | "unknown";
export type FabricEndpoint = "loopback" | "proxy" | "direct" | "unset" | "not-applicable";
export type RailwayCostStatus = "ok" | "over-budget" | "unpriced" | "unavailable" | "unconfigured" | "unknown";
export type DbPlaneName = "greptime" | "postgres" | "dragonfly";
export type HttpPlaneName = "hindsight" | "ragflow (retired)";

export interface FabricPlaneFact {
  configured: boolean;   // a URL or endpoint is set; a refused URL counts as configured
  ok: boolean | null;    // null: no answer in time
  breakerOpen: boolean;
}

export interface FabricFacts {
  checkedAt: string;     // ISO 8601
  planes: Record<DbPlaneName | HttpPlaneName, FabricPlaneFact>;
  endpoints: Record<DbPlaneName, "loopback" | "proxy" | "direct" | "unset">;
  endpointPolicy: "warn" | "enforce";
  cacheMode: "off" | "on" | "degraded" | "unknown";
  busEnabled: boolean;
  hindsightOutboxBacklog: boolean | null;
  railway: { status: RailwayCostStatus; projectedMonthlyUsd: number | null; budgetUsd: number | null };
  railwayWritesOn: boolean;
  authConfigured: boolean;   // presence only, never a value
}

export interface FabricResource {
  resource: FabricResourceName;
  state: FabricState;
  endpoint: FabricEndpoint;
  detail: string;            // one fixed phrase per (resource, state); never an error text or a URL
}

export interface FabricStatus {
  checkedAt: string;
  resources: FabricResource[];   // exactly six, in the order railway, greptime, postgres, dragonfly, hindsight, ragflow (retired)
  counts: Record<FabricState, number>;
}

export interface FabricSuggestion {
  id: string;                    // stable, for example "endpoint-direct.greptime"
  resource: FabricResourceName;
  severity: "info" | "attention";
  message: string;
  reference: string;             // an existing docs heading, for example "docs/observability.md#railway-cost-report-phase-45"
}

export interface FabricCheck {
  id: string;
  status: "pass" | "finding" | "not-applicable";
  evidence: string;              // names and counts only
  reference: string;
}

export interface FabricCompliance {
  checkedAt: string;
  checks: FabricCheck[];
  findings: number;
}

export interface FabricSources {
  health(): FabricHealthView;                         // structural view of Substrate.health()
  railwayCost(): Promise<{ status: RailwayCostStatus; projectedMonthlyUsd: number | null; budgetUsd: number | null }>;
  hindsightOutboxBacklog(): Promise<boolean | null>;
  config: FabricConfigView;
  now(): string;
}
```

`FabricHealthView` and `FabricConfigView` are structural views defined in `types.ts`. `service.ts` passes `this` projections so `types.ts` does not import `service.ts`.

## Rules (pinned)

Resource state, evaluated in this order for each resource:
1. Not configured: `unconfigured`. For a DB plane the endpoint is `unset`; for HTTP planes and railway it is `not-applicable`.
2. `ok === null` or the source deadline passed: `unknown`.
3. `ok === false` or `breakerOpen`: `down`.
4. Resource-specific degradation: dragonfly `cacheMode === "degraded"`; hindsight `hindsightOutboxBacklog === true`; railway `over-budget` or `unpriced`. Result `degraded`.
5. Railway `unavailable`: `down`. Railway `unconfigured`: `unconfigured`. Railway `unknown`: `unknown`.
6. Otherwise `ok`.

Suggestions (each rule fires on its own, stable id):
- `endpoint-direct.<plane>` (attention): a DB plane whose endpoint is `direct`. Reference `docs/data-planes.md#endpoint-policy`.
- `cache-degraded` (attention): dragonfly `degraded` or `down` while configured. Reference `docs/observability.md#plane-circuit-breakers`.
- `ledger-or-index-down` (attention): greptime or postgres `down`. Reference `docs/observability.md#per-plane-availability`.
- `railway-over-budget` (attention): railway `degraded` with `over-budget`. Reference `docs/observability.md#railway-cost-report-phase-45`.
- `railway-unpriced` (info): railway `degraded` with `unpriced`. Same reference.
- `hindsight-outbox-backlog` (attention): hindsight `degraded` by backlog. Reference `docs/observability.md#hindsight-outbox-gauges-inventory-and-drift-uplift-4-s5`.
- `pubsub-hints-off` (info): dragonfly `ok` and `busEnabled` false. Reference `docs/data-planes.md#current-wiring`.

Compliance checks:
- `db-endpoints-private`: pass when every configured DB plane is `loopback` or `proxy`; finding naming the `direct` planes; not-applicable when no DB plane is configured.
- `db-endpoint-enforced`: pass when `endpointPolicy` is `enforce`; finding when `warn`. Reference `docs/data-planes.md#endpoint-policy`.
- `railway-writes-gated`: pass when `railwayWritesOn` is false; finding when true (writes need an operator identity and an approval reference). Reference `docs/observability.md#railway-cost-report-phase-45`.
- `auth-configured`: pass when `authConfigured`; finding otherwise. Reference `docs/observability.md#fail-open-fail-closed`.

## Units (disjoint files)

- Unit A, code: `fabric/types.ts`, `fabric/status.ts`, `fabric/suggest.ts`, `fabric/compliance.ts`, `fabric/gather.ts`, `fabric/fabric.test.ts`, `mcp.ts` (three registrations only), `service.ts` (the `fabricSources()` method only), `admission.ts`, `packages/audit/src/policy.ts`, `observe.ts`, and one MCP test file `fabric-mcp.test.ts`. One integration owner.
- Unit B, docs: `docs/observability.md` and `docs/data-planes.md`, only the new sections. Reads the pinned names above and the final code.

## Gates

- `bunx tsc --noEmit` exit 0.
- Targeted: `fabric/fabric.test.ts`, `fabric-mcp.test.ts`, `admission.test.ts`, `policy.test.ts`, `observe.test.ts`, `mcp.test.ts`.
- Full `bun test` against `substrate_test_p51`, repo locks `bun run check:phase-close`. Config reference: not expected to change; run `bun run config:reference -- --check` to confirm.
- Smoke: start the MCP server over the existing test harness and call each of the three tools once; observe the six resources and the check list.

## Tests (what they must catch)

- Each resource state branch (unconfigured, unknown, down, degraded, ok) for each resource, with a positive and a negative case.
- Each suggestion rule fires on its trigger and stays silent otherwise.
- Each compliance check passes and fails on its trigger. A DB plane with `direct` makes `db-endpoints-private` a finding and names the plane.
- A source that misses its deadline gives `unknown` for its resource; the call still returns six resources.
- Output contains no URL, host, port, or credential when the config view carries neutral values (asserted on the built output, not on source text).
- The three tools are registered with `readOnlyHint: true`, and the admission and audit lock tests still pass.

## Deferred (recorded)

- Dashboards UI (D51-f).
- Scaling suggestions per service stay with `railway_scale_suggest`; the fabric does not read per-service monitors.
- Tailscale ACL and forwarder health: operator-gated (phase 48).
