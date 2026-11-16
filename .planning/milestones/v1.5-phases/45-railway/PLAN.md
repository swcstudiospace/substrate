---
phase: 45-railway
plan: 01
type: execute
parallel_units: 2
depends_on: []
files_modified:
  - packages/mcp-server/src/railway.ts
  - packages/mcp-server/src/railway.test.ts
  - packages/mcp-server/src/config.ts
  - packages/mcp-server/src/flag-registry.ts
  - .env.example
  - packages/mcp-server/src/mcp.ts
  - packages/mcp-server/src/service.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/observe.ts
  - packages/mcp-server/src/admission.ts
  - packages/audit/src/policy.ts
  - packages/mcp-server/src/event-sources.ts
  - packages/mcp-server/src/railway-mcp.test.ts
  - docs/event-vocabulary.md
  - docs/data-planes.md
  - docs/observability.md
---

# 45-PLAN: RAILWAY MCP CONTROL

Decisions D45-a to D45-o are in `CONTEXT.md` and bind both units. Worktree: `/root/pr-fix/v145-railway`. Absolute paths only.

Two units run in parallel. Unit A owns `railway.ts` and `railway.test.ts`. Unit B owns everything else and codes against the exact interface in the next section, without waiting for A's file. No unit edits the other's files. Neither unit runs tests, builds, lint or formatters, and neither runs git add, commit, push or stash.

## Shared interface (exact; A provides, B consumes)

Module `packages/mcp-server/src/railway.ts`, all exports below. Names and shapes are fixed.

```ts
export const RAILWAY_API_URL = "https://backboard.railway.app/graphql/v2";
export const RAILWAY_DEFAULT_BUDGET_USD = 50;
export const RAILWAY_COST_CACHE_MS = 900_000;
export const RAILWAY_SCALE_MIN_SAMPLES = 24;
export const RAILWAY_SCALE_QUANTUM = 0.25;
export const COST_MEASUREMENTS = ["CPU_USAGE", "MEMORY_USAGE_GB", "DISK_USAGE_GB", "NETWORK_TX_GB"] as const;
export type CostMeasurement = (typeof COST_MEASUREMENTS)[number];

export interface ScaleBounds {
	readonly minVcpus: number;
	readonly maxVcpus: number;
	readonly minMemoryGb: number;
	readonly maxMemoryGb: number;
}

export interface RailwayConfig {
	readonly apiToken: string | null; // RAILWAY_API_TOKEN, trimmed; null when unset
	readonly writesEnabled: boolean; // SUBSTRATE_RAILWAY_WRITES === "on" exactly
	readonly budgetUsd: number; // SUBSTRATE_RAILWAY_BUDGET_USD, default RAILWAY_DEFAULT_BUDGET_USD
	readonly projectIds: readonly string[]; // SUBSTRATE_RAILWAY_PROJECT_IDS, comma list, trimmed, empty dropped
	readonly prices: Readonly<Partial<Record<CostMeasurement, number>>>; // USD per unit; unset key = unpriced
	readonly scale: ScaleBounds & { readonly headroom: number; readonly windowSeconds: number };
}

/** Reads the 16 SUBSTRATE_RAILWAY_* names and RAILWAY_API_TOKEN from `env` (default process.env). Never throws. */
export function railwayFromEnv(env?: Record<string, string | undefined>): RailwayConfig;

export interface ServiceRef {
	readonly environmentId: string;
	readonly serviceId: string;
}

export interface RailwayResources {
	readonly projects: readonly {
		readonly id: string;
		readonly name: string;
		readonly environments: readonly { readonly id: string; readonly name: string; readonly isEphemeral: boolean }[];
		readonly services: readonly { readonly id: string; readonly name: string }[];
	}[];
}

export interface RailwayMonitor {
	readonly environmentId: string;
	readonly serviceId: string;
	readonly serviceName: string | null;
	readonly numReplicas: number | null;
	readonly region: string | null;
	readonly latestDeployment: { readonly id: string; readonly status: string; readonly createdAt: string } | null;
}

export type ScaleStatus = "ok" | "insufficient-data";
export interface ScaleSuggestion {
	readonly status: ScaleStatus;
	readonly current: { readonly vCPUs: number | null; readonly memoryGB: number | null };
	readonly p95: { readonly vCPUs: number | null; readonly memoryGB: number | null };
	readonly suggested: { readonly vCPUs: number; readonly memoryGB: number } | null;
	readonly samples: number;
	readonly windowSeconds: number;
	readonly detail: string;
}

export type WriteRefusal = "writes-disabled" | "operator-required" | "approval-ref-missing" | "unconfigured" | "out-of-bounds";
export interface WriteGate {
	readonly isOperator: boolean;
	readonly approvalRef: string | null;
}
export interface WriteLimits {
	readonly vCPUs: number;
	readonly memoryGB: number;
}
export type WriteOutcome = { readonly applied: true } | { readonly applied: false; readonly refusal: WriteRefusal };

/** Gate checks in this order: unconfigured (no token), writes-disabled, operator-required, approval-ref-missing. Null = pass. */
export function writeRefusal(config: RailwayConfig, gate: WriteGate): WriteRefusal | null;
/** "out-of-bounds" when a value is outside the scale bounds (inclusive); null = pass. */
export function boundsRefusal(bounds: ScaleBounds, limits: WriteLimits): WriteRefusal | null;
/** True when the ref matches ^[A-Za-z0-9._:/#-]{1,128}$. */
export function approvalRefValid(ref: string): boolean;

/** Nearest-rank p95; null for an empty input. */
export function p95(values: readonly number[]): number | null;
/** Ceil to a multiple of `quantum` (default RAILWAY_SCALE_QUANTUM); tolerant of float error (ceil(x/q - 1e-9) * q). */
export function roundUpToQuantum(value: number, quantum?: number): number;

export interface SuggestScaleInput {
	readonly cpu: readonly number[]; // CPU_USAGE samples
	readonly memoryGb: readonly number[]; // MEMORY_USAGE_GB samples
	readonly currentVcpus: number | null; // newest CPU_LIMIT sample
	readonly currentMemoryGb: number | null; // newest MEMORY_LIMIT_GB sample
	readonly scale: ScaleBounds & { readonly headroom: number; readonly windowSeconds: number };
}
/** Pure. insufficient-data when either series has < RAILWAY_SCALE_MIN_SAMPLES or a limit is null; never guesses. */
export function suggestScale(input: SuggestScaleInput): ScaleSuggestion;

export type CostStatus = "ok" | "over-budget" | "unpriced" | "unavailable" | "unconfigured";
export interface CostLine {
	readonly measurement: CostMeasurement;
	readonly estimatedValue: number; // summed over projects
	readonly unitPriceUsd: number | null;
	readonly costUsd: number | null;
}
export interface CostReport {
	readonly status: CostStatus;
	readonly budgetUsd: number;
	readonly projectedMonthlyUsd: number | null;
	readonly lines: readonly CostLine[];
	readonly detail: string;
	readonly generatedAt: string | null;
}
/** Pure. Rows whose measurement is not in COST_MEASUREMENTS are skipped. Any line with value > 0 and no price => unpriced (lines kept, projectedMonthlyUsd null). over-budget when total > budgetUsd. */
export function buildCostReport(input: {
	readonly usage: readonly { readonly measurement: string; readonly estimatedValue: number }[];
	readonly prices: Readonly<Partial<Record<CostMeasurement, number>>>;
	readonly budgetUsd: number;
	readonly configured: boolean;
	readonly generatedAt: string;
}): CostReport;

export class RailwayRequestError extends Error {
	readonly kind: "not-configured" | "transport" | "graphql" | "shape";
}

export type RailwayFetch = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class RailwayClient {
	constructor(config: RailwayConfig, options?: { readonly fetch?: RailwayFetch; readonly now?: () => Date });
	/** Rejects RailwayRequestError on failure. */
	listResources(): Promise<RailwayResources>;
	monitor(ref: ServiceRef): Promise<RailwayMonitor>;
	/** Reads CPU_USAGE, MEMORY_USAGE_GB, CPU_LIMIT, MEMORY_LIMIT_GB for the window, then suggestScale. */
	suggestScale(ref: ServiceRef): Promise<ScaleSuggestion>;
	/** Never rejects. Cached RAILWAY_COST_CACHE_MS in process. Errors become status "unavailable" with a detail. */
	costReport(): Promise<CostReport>;
	/** Order: boundsRefusal, then writeRefusal, then one serviceInstanceLimitsUpdate call. Refusals make NO request. Rejects on transport/graphql/shape failure after the gate passes. */
	setServiceLimits(ref: ServiceRef, limits: WriteLimits, gate: WriteGate): Promise<WriteOutcome>;
	/** Order: writeRefusal, then one serviceInstanceRedeploy call. Refusals make NO request. */
	redeployService(ref: ServiceRef, gate: WriteGate): Promise<WriteOutcome>;
}
```

Unit B consumes `railwayFromEnv`, `RailwayConfig`, `RailwayClient`, `WriteGate`, `WriteLimits`, `WriteOutcome`, `WriteRefusal`, `approvalRefValid`, `ServiceRef`, and the return types of the client methods. Unit B does not consume the pure helpers except through the client.

## Unit A: client, pure functions, tests

Files: `packages/mcp-server/src/railway.ts` (new), `packages/mcp-server/src/railway.test.ts` (new). Nothing else.

Implement the interface above exactly.

Implementation requirements:
1. `railwayFromEnv`: mirror the parse behaviour of `positiveRateOr` (config.ts ~1077) for prices and vCPU and memory (keep fractions, reject non-finite or <= 0 with the fallback) and `unitIntervalOr` (config.ts ~1010) for headroom in [0, 1]. Do NOT import from `config.ts` (it would create an import cycle, and its helpers are not exported). Keep the small parsers local to `railway.ts`, one line each. Integer-only parsing is not used for these values because `boundedInt` and `positiveOr` floor fractions.
2. `RailwayClient` uses `options.fetch ?? fetch` and POSTs `{ query, variables }` as JSON to `RAILWAY_API_URL` with headers `content-type: application/json` and `authorization: Bearer <token>`. The token is read from `config.apiToken` at call time only. It is never put into an error, a log, or a returned object.
3. A missing token makes listResources, monitor, suggestScale and the writes fail or refuse with kind `not-configured` (writes refuse via writeRefusal `unconfigured` with no request). costReport returns status `unconfigured`.
4. GraphQL `errors` in a 200 response, a non-2xx status, or a transport throw become `RailwayRequestError` with kind `graphql` or `transport`. The message carries only the GraphQL `message` and `traceId` (or the HTTP status). It never carries the request body or the headers.
5. Mutation responses: `data.serviceInstanceLimitsUpdate` and `data.serviceInstanceRedeploy` must be exactly `true` for `applied: true`. Any other value (`false`, `null`, a non-boolean, or a missing field) throws kind `shape`. A `false` is never reported as a successful write and never as a silent refusal.
6. Query text (confirmed by introspection in CONTEXT.md):
   - listResources: `{ projects(first: 100) { edges { node { id name environments(first: 100) { edges { node { id name isEphemeral } } } services(first: 100) { edges { node { id name } } } } } } }`, one query per configured project id via `project(id:)`, so `projectIds` scopes it. If projectIds is empty, use `projects(first: 100)`.
   - monitor: `serviceInstance(environmentId:, serviceId:) { serviceId serviceName environmentId numReplicas region latestDeployment { id status createdAt } }`.
   - suggestScale: `metrics(measurements: [CPU_USAGE, MEMORY_USAGE_GB, CPU_LIMIT, MEMORY_LIMIT_GB], environmentId:, serviceId:, startDate:, endDate:, sampleRateSeconds: 300, averagingWindowSeconds: 300) { measurement values { ts value } }`, with startDate = now - scale.windowSeconds and endDate = now. Take the latest value of each LIMIT series (last by ts) for current limits.
   - costReport: `estimatedUsage(measurements: [CPU_USAGE, MEMORY_USAGE_GB, DISK_USAGE_GB, NETWORK_TX_GB], projectId:) { measurement estimatedValue projectId }`, one call per projectId, summed.
   - setServiceLimits: `mutation($input: ServiceInstanceLimitsUpdateInput!) { serviceInstanceLimitsUpdate(input: $input) }` with `input = { environmentId, serviceId, vCPUs, memoryGB }`.
   - redeployService: `mutation($environmentId: String!, $serviceId: String!) { serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId) }`.
7. Caching: costReport memoises its last successful or failed result for RAILWAY_COST_CACHE_MS using `now()`. Other methods are not cached.
8. No `await import()`, no inline `as` casts used for member access (type the JSON with small type-guard functions), tabs, no TODO, no "follow-up", "v1", "MVP" wording, no stubs.
9. Errors never include `config.apiToken`.

`railway.test.ts` (A), tests of consumer-visible behaviour only. Use a recording fake `fetch` that returns canned JSON. Do not pin source text or wording of messages beyond a stable kind.
- `railwayFromEnv` with empty env: budgetUsd is 50, writesEnabled false, apiToken null, prices empty, headroom 0.3, windowSeconds 86400. Name: "defaults: budget 50, writes off, no token".
- `railwayFromEnv`: SUBSTRATE_RAILWAY_WRITES "true" or "ON" does not enable writes; "on" does. Name: "writes enabled only by exactly on".
- `railwayFromEnv`: budget "0", "abc", "-3" fall back to 50; "72.5" is kept. Name: "invalid budget falls back to fifty".
- `railwayFromEnv`: price "0.05" is kept as 0.05 (not floored). Name: "prices keep cents".
- `writeRefusal` and client write path: with writes off, `setServiceLimits` and `redeployService` return applied false, refusal `writes-disabled`, and the fake fetch records ZERO calls. Name: "writes off makes no request".
- Operator missing: refusal `operator-required`, zero requests. Approval null: `approval-ref-missing`, zero requests. No token: `unconfigured`, zero requests.
- `boundsRefusal`: vCPUs above max is `out-of-bounds` with zero requests even when writes are on and gate passes. Values equal to a bound pass.
- `approvalRefValid`: accepts "UAT-2026.10/ref_1#a", rejects "", a 129-char string, and a string with a space.
- Successful write: with writes on, operator, valid ref, `setServiceLimits` sends exactly one request whose body's variables carry environmentId, serviceId, vCPUs and memoryGB, and the response `true` gives applied true. Name: "gated write sends one limits mutation".
- A `false` response from the mutation throws kind `shape` and does not return `applied: true`. Name: "boolean false is not applied".
- Token never leaks: a fake fetch returning HTTP 500 with a body containing the token string makes the thrown error's message not contain the token. Name: "errors never echo the token". Use a token value like "test-token-abc123" in the fixture only.
- `monitor` returns the latest deployment status and numReplicas from a canned response. Name: "monitor maps the latest deployment".
- `listResources` maps edges to environments and services for one configured project. Name: "list maps projects environments and services".
- `p95`: 20 values 1..20 gives 19; empty gives null. Name: "p95 is nearest rank".
- `roundUpToQuantum(1.0000000001, 0.25)` is 1.0, and `roundUpToQuantum(1.01, 0.25)` is 1.25. Name: "rounds up without float drift".
- `suggestScale`: 30 CPU samples of 0.5 and 30 memory samples of 0.2 with limits 2 and 1, headroom 0.3: suggested vCPUs 0.75 (0.5 × 1.3 = 0.65, rounded up to 0.75) and memory 0.5 (0.2 × 1.3 = 0.26, rounded up to 0.5). Name: "suggests p95 plus headroom".
- `suggestScale` clamps to max: CPU p95 10 with maxVcpus 4 gives suggested 4. Clamps to min: CPU p95 0.01 with minVcpus 0.25 gives 0.25. Name: "suggestion clamps to bounds".
- `suggestScale` with 23 samples: status insufficient-data, suggested null. Name: "too few samples gives no suggestion".
- `suggestScale` with a null limit: insufficient-data. Name: "missing limit gives no suggestion".
- `buildCostReport`: priced totals and over-budget (sum > 50 gives over-budget); missing price on a nonzero line gives unpriced with projectedMonthlyUsd null and the line kept; zero-value unpriced line does NOT make it unpriced; unknown measurement is skipped; configured false gives unconfigured. Names: "priced total against budget", "missing price never invents a total", "unknown measurement skipped".
- `costReport` never rejects: a fake fetch that throws gives status unavailable. Name: "cost report fails open".
- `costReport` caches: two calls within the TTL make one request; a call after advancing `now` past RAILWAY_COST_CACHE_MS makes a second. Name: "cost report cached for fifteen minutes".

Acceptance for A: every export above exists with the exact name and shape; tests exist with the names above; no test calls the real Railway URL (the fake fetch is always injected).

## Unit B: wiring, tools, policy, /slo, events, docs, tests

Files (all may be edited by B; B must not touch railway.ts or railway.test.ts):

1. `packages/mcp-server/src/config.ts`: import `railwayFromEnv` and `type RailwayConfig` from `./railway.ts`. Add `readonly railway: RailwayConfig;` to the config type with a doc comment naming D45-a. In `loadConfig`, add `railway: railwayFromEnv(env),` next to the `ragflow (retired)` line (~692). Do NOT reuse the private helpers in config.ts for Railway values.

2. `packages/mcp-server/src/flag-registry.ts`: add one row per name in `FLAGS` for each of the 16 names: `RAILWAY_API_TOKEN` (kind `secret-ref`, documented true), `SUBSTRATE_RAILWAY_WRITES` (toggle, default off), `SUBSTRATE_RAILWAY_BUDGET_USD` (number, default 50), `SUBSTRATE_RAILWAY_PROJECT_IDS` (list), the four `SUBSTRATE_RAILWAY_PRICE_*_USD` (number, unset = unpriced), the four `SUBSTRATE_RAILWAY_SCALE_MIN/MAX_*` (number), `SUBSTRATE_RAILWAY_SCALE_HEADROOM` (number 0..1, default 0.3), `SUBSTRATE_RAILWAY_SCALE_WINDOW_SECONDS` (number, default 86400). `readBy: "railway.ts"`. `plane` must be a value in `FLAG_PLANES`; use `"observability"` for the budget, prices, project ids and scale rows, and `"server"` for the writes toggle and the token. `documented: true` for every row, `doc: "docs/data-planes.md"`. Read the surrounding row shape before writing so the fields match exactly.

3. `.env.example`: add a section `# ── Railway control plane (Phase 45) ──` with each of the 16 names, empty values, and a comment that the token is the owner's and never committed. No real values.

4. `packages/mcp-server/src/service.ts`: add `readonly railway: RailwayClient;` to the `Substrate` interface, and set it in the factory with `new RailwayClient(config.railway)`. Find every test fixture or fake that builds a `Substrate` object (`grep` the test files for `Substrate` fakes) and add the field so the type still holds. No inline `as` casts.

5. `packages/mcp-server/src/mcp.ts`: register six tools with `server.registerTool`, following `skills_approve` and `skills_list` (lines ~1127 and ~1163). Tool names and input schemas (zod, descriptions in plain words; no wording about "follow-up"):
   - `railway_list`: `{}`. Read. `annotations: { readOnlyHint: true }`. Handler `substrate.railway.listResources()`.
   - `railway_monitor`: `{ environment_id: z.string(), service_id: z.string() }`. Read. Handler `substrate.railway.monitor({ environmentId, serviceId })`.
   - `railway_scale_suggest`: `{ environment_id, service_id }`. Read. Handler `substrate.railway.suggestScale({ environmentId, serviceId })`. Advisory; the description must say it never applies a change.
   - `railway_cost`: `{}`. Read. Handler `substrate.railway.costReport()`.
   - `railway_scale`: `{ environment_id, service_id, vcpus: z.number(), memory_gb: z.number(), approval_ref: z.string().optional() }`. Write, `destructiveHint: true, openWorldHint: true`. Handler: `const gate = { isOperator, approvalRef: approval_ref !== undefined && approvalRefValid(approval_ref) ? approval_ref : null }`; `const outcome = await substrate.railway.setServiceLimits({ environmentId, serviceId }, { vCPUs: vcpus, memoryGB: memory_gb }, gate)`. Return `json(outcome)`; if `applied` is false return `{ ...json(outcome), isError: true }`.
   - `railway_deploy`: `{ environment_id, service_id, approval_ref: z.string().optional() }`. Write, same gate, `substrate.railway.redeployService`.
   - `isOperator` and `callerSurface` come from the `createMcpServer` scope (line ~202). Reads never take the gate.
   - Emit an event for each write outcome through the same emit path `skills_approve` uses for `skill.approve.refused` (`server.ts` ~289-1614; locate and reuse, do not invent a new path). Applied: source row `railway.<op>.applied`. Refused or failed: `railway.<op>.refused`. Payload: `{ action: "railway.scale" | "railway.deploy", runtime: "railway", status: "applied" | "refused", refusal?: WriteRefusal, environment_id, service_id, approval_ref? }`. Never the token. Never the request body. The approval ref may be included; it is a reference.

6. `packages/mcp-server/src/server.ts` `/slo` handler (~899-968): add `railwayCost` to the 200 payload: `const railwayCost = await substrate.railway.costReport();` (costReport never rejects; still wrap in `.catch` returning `null` so a regression cannot 500 the route). Add it as a report-only key `railwayCost`. Do NOT add it to `breached`. The key is always present (status `unconfigured` when no token).

7. `packages/audit/src/policy.ts`: add `railway_scale` and `railway_deploy` to `FAIL_CLOSED_TOOLS` with a comment citing D45-h. Add `railway_list`, `railway_monitor`, `railway_scale_suggest` and `railway_cost` to `FAIL_OPEN_TOOLS`. Update `packages/audit/src/policy.test.ts` only if it pins a count or a list the new names change.

8. `packages/mcp-server/src/admission.ts` `TOOL_CLASSES`: `railway_list: "read"`, `railway_monitor: "read"`, `railway_scale_suggest: "read"`, `railway_cost: "read"`, `railway_scale: "write"`, `railway_deploy: "write"`.

9. `packages/mcp-server/src/observe.ts` `KNOWN_TOOLS`: add the six names in the tool section (after `desktop_run`).

10. `packages/mcp-server/src/event-sources.ts`: add four `EVENT_SOURCES` rows (one kind per row):
    - `railway.scale.applied`: `phase: 45`, `kind: "note"`, `surface: { fixed: "substrate" }`, `runtime: "railway"`, `actions: ["railway.scale"]`, sample `payload: { action: "railway.scale", runtime: "railway", status: "applied" }`.
    - `railway.scale.refused`: `kind: "warning"`, same surface and runtime, `actions: ["railway.scale"]`, sample `payload: { action: "railway.scale", runtime: "railway", status: "refused", refusal: "writes-disabled" }`.
    - `railway.deploy.applied` and `railway.deploy.refused`: the same two shapes for `railway.deploy`.
    - Add the six read tools to `SILENT_SOURCES` with `reason` stating reads emit nothing (D45-b). Use ids `railway.list`, `railway.monitor`, `railway.scale_suggest`, `railway.cost`.
    - Match the existing row shape exactly (read `event-sources.ts` lines 60-150 first). Samples must pass `normalizeEvent` (`event-sources.test.ts` enforces it).

11. `docs/event-vocabulary.md`: add the same four rows and six silent rows, matching the drift test (`event-sources.test.ts` asserts the document and the table agree). Read the file first to match its table format.

12. `docs/data-planes.md`: add a section `## Railway control plane (Phase 45)` after `## Environment keys`. State D45-a (public API, bearer token from `RAILWAY_API_TOKEN` by name, never through the forwarders), D45-c (writes off by default; operator plus approval reference plus `SUBSTRATE_RAILWAY_WRITES=on`), D45-d (cost report from estimated usage and operator prices; the budget default; unpriced when unset), and D45-e (scale suggestion is advisory). Link `docs/railway-tailscale.md`. No hostnames, no tailnet names.

13. `docs/observability.md`: add one paragraph under the `/slo` section describing the `railwayCost` key: report-only, never in `breached`, cached 15 minutes, `unavailable` on Railway error.

14. Tests, new file `packages/mcp-server/src/railway-mcp.test.ts`. Read `mcp.test.ts` and `server.test.ts` first and follow their harness. Consumer-visible behaviour only:
    - "write tools refuse without the operator gate and make no request": with writes on and a non-operator caller, `railway_scale` returns isError and the recording fake fetch saw zero calls. Use a `RailwayClient` constructed with the recording fetch.
    - "write tools refuse with writes off": same, refusal `writes-disabled`, zero calls.
    - "gated write reaches the client once": operator, writes on, valid ref, one mutation call.
    - "read tools need no gate": `railway_list` and `railway_cost` succeed with a non-operator caller and writes off.
    - "/slo carries railwayCost and never breaches on it": the `/slo` response has `railwayCost`, `breached` does not contain a railway id, and a fetch that throws still gives status 200 with `unavailable`.
    - "tool classes cover every registered railway tool": each of the six names is in TOOL_CLASSES and in KNOWN_TOOLS.

Acceptance for B: all listed files changed as described; no edit to `railway.ts` or `railway.test.ts`; no new `EVENT_KINDS` value; no `await import()`; no inline `as` casts for member access; tabs; no TODO; no secret values anywhere.

## Main agent (after both units land; not in either unit)

1. Regenerate `docs/config-reference.md` with `scripts/config-reference.ts` (the rows changed).
2. Run `bun test packages/mcp-server/src/railway.test.ts packages/mcp-server/src/railway-mcp.test.ts packages/mcp-server/src/event-sources.test.ts packages/mcp-server/src/flag-registry.test.ts packages/mcp-server/src/admission.test.ts packages/audit/src/policy.test.ts`, then `bun run check:phase-close`, then the package typecheck. Fix any failure in the owning unit's files.
3. Write `SUMMARY.md` and `VERIFICATION.md` for phase 45 (the records convention). The live proof is recorded as operator-gated, not as passed.

## Out of scope (repeated from CONTEXT)

Replica changes (D45-k), `deploymentRedeploy` (D45-m), reading `serviceInstanceLimits` (D45-e), any live Railway call in tests, any write to the operator's own checkout, and any change to the forwarders or the tailnet ACL.
