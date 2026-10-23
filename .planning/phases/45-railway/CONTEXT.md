---
phase: 45-railway
requirements: [RW-LIST, RW-SCALE-SUGGEST, RW-COST-SLO]
depends_on: [docs/railway-tailscale.md, docs/data-planes.md]
status: planned on origin/main 3e9a106. Not built. The live write proof is operator-gated.
---

# 45-CONTEXT: RAILWAY MCP CONTROL

## Scope (ROADMAP, verbatim)

> Railway services are managed through MCP tools (list, scale, monitor, deploy) using the forwarders, with a basic scale suggestion and a cost report. Acceptance: 1. an MCP tool lists Railway resources; 2. a basic scale suggestion; 3. a cost report in /slo. Budget ceiling $50 per month at test scale (decided by the project owner).

"Using the forwarders" is reconciled in D45-a: the forwarders carry data-plane traffic only. The control plane is the Railway public GraphQL API.

## Railway API facts (introspected 2026-10-21)

Method: `POST https://backboard.railway.app/graphql/v2`, `__type` and `__schema` introspection only, no token, no mutation sent. Reads also probed with no token: every probe passed schema validation (field names and argument types exist) and then returned `Not Authorized` or `Project not found`. Those probes confirm the names; they do not confirm return values.

Confirmed signatures (exact):

Reads
- `Query.metrics(measurements: [MetricMeasurement!]!, serviceId: String, environmentId: String, projectId: String, workspaceId: String, startDate: DateTime!, endDate: DateTime, sampleRateSeconds: Int, averagingWindowSeconds: Int, groupBy: [MetricTag!], includeDeleted: Boolean, volumeId: String, volumeInstanceExternalId: String) -> [MetricsResult!]!`
- `MetricsResult { measurement: MetricMeasurement!, tags: MetricTags!, values: [Metric!]! }`
- `Metric { ts: Int!, value: Float! }`
- `Query.estimatedUsage(measurements: [MetricMeasurement!]!, projectId: String, workspaceId: String, includeDeleted: Boolean) -> [EstimatedUsage!]!`
- `EstimatedUsage { measurement: MetricMeasurement!, estimatedValue: Float!, projectId: String! }`
- `Query.serviceInstance(environmentId: String!, serviceId: String!) -> ServiceInstance!`
- `ServiceInstance` carries `numReplicas: Int`, `region: String`, `serviceName: String!`, `serviceId: String!`, `environmentId: String!`, `latestDeployment: Deployment`, `activeDeployments: [Deployment!]!`. It has NO vCPU or memory field.
- `Deployment { id: ID!, status: DeploymentStatus!, createdAt: DateTime!, updatedAt: DateTime!, environmentId: String!, serviceId: String, projectId: String! }`. `DeploymentStatus` = BUILDING, CRASHED, DEPLOYING, FAILED, INITIALIZING, NEEDS_APPROVAL, QUEUED, REMOVED, REMOVING, SKIPPED, SLEEPING, SUCCESS, WAITING.
- `Query.project(id: String!) -> Project!`. `Project { id: ID!, name: String!, environments(first: Int, ...) -> ProjectEnvironmentsConnection!, services(first: Int, ...) -> ProjectServicesConnection!, workspaceId: String }`. Edges are `{ cursor, node }`; `Environment.node` has `id`, `name`, `isEphemeral`, `projectId`. `Service.node` has `id`, `name`, `projectId`.
- `Query.projects(first: Int, after: String, workspaceId: String, includeDeleted: Boolean, ...) -> QueryProjectsConnection!`, edges `{ cursor, node: Project! }`.
- `Query.serviceInstanceLimits(environmentId: String!, serviceId: String!) -> ServiceInstanceLimit!`. `ServiceInstanceLimit` is a SCALAR. Its JSON shape is NOT confirmed (a token is needed to read it). Not used by this phase (D45-e).
- `Query.serviceInstanceLimitOverride(environmentId: String!, serviceId: String!) -> ServiceInstanceLimit`. Same caveat.

Writes
- `Mutation.serviceInstanceLimitsUpdate(input: ServiceInstanceLimitsUpdateInput!) -> Boolean!`
  - `ServiceInstanceLimitsUpdateInput { environmentId: String!, serviceId: String!, vCPUs: Float, memoryGB: Float }`
  - CORRECTION to the brief: the arguments are one `input` object, not flat arguments.
- `Mutation.serviceInstanceRedeploy(environmentId: String!, serviceId: String!) -> Boolean!`. Chosen as the deploy write (D45-m).
- `Mutation.deploymentRedeploy(id: String!, usePreviousImageTag: Boolean) -> Deployment!`. Known, not used.
- `Mutation.serviceInstanceUpdate(environmentId: String, input: ServiceInstanceUpdateInput!, serviceId: String!) -> Boolean!`. `ServiceInstanceUpdateInput` has `numReplicas: Int` (the replica count) and `multiRegionConfig: JSON`. Replicas are out of scope (D45-k).

Other write-side names seen and not used: `serviceInstanceDeploy`, `serviceInstanceDeployV2`, `deploymentRestart`.

Unconfirmed by introspection (not guessed; each has a decision that handles it):
1. The `ServiceInstanceLimit` scalar's JSON shape.
2. The unit and period of `estimatedUsage.estimatedValue`. The introspection does not say whether it is a monthly projection.
3. The unit of `CPU_USAGE`, `CPU_LIMIT` (vCPU assumed), `MEMORY_USAGE_GB` and `MEMORY_LIMIT_GB` (GB assumed).
4. The `Metric.ts` unit (seconds or milliseconds). The phase only orders samples, so it does not need the unit.
5. The auth header for project-scoped tokens. Introspection says nothing. Only the bearer form is used (D45-a). A project token that needs another header is an operator-side check at the first live read.
6. The mutation return values are Boolean by type only. Whether `true` means applied is confirmed live.

## Measurement enum (confirmed)

`MetricMeasurement` includes: `CPU_USAGE`, `CPU_USAGE_2`, `CPU_LIMIT`, `MEMORY_USAGE_GB`, `MEMORY_LIMIT_GB`, `DISK_USAGE_GB`, `EPHEMERAL_DISK_USAGE_GB`, `NETWORK_RX_GB`, `NETWORK_TX_GB`, `BACKUP_USAGE_GB`, plus `AGENT_*` and `AGENT_SPEND_USD`. `MetricTag` includes `SERVICE_ID`, `ENVIRONMENT_ID`, `PROJECT_ID`, `DEPLOYMENT_ID`, `REGION`.

## Repo facts (read-only, worktree 3e9a106)

- Config helpers, `packages/mcp-server/src/config.ts`:
  - `positiveOr` (~line 1004): a float is floored. It is NOT safe for prices (0.05 becomes 0).
  - `positiveRateOr` (~line 1077): keeps a float > 0. Use for prices and vCPU.
  - `unitIntervalOr` (~line 1010): a float in [0, 1]. Use for headroom.
  - `boundedInt` (~line 1507): floors. Use only for integers.
  - `positiveIntOr` (~line 1677): a positive integer string.
  - `nonNegativeOr` (~line 998).
  - There is NO `boundedNumber`. The brief's name does not exist.
  - All of these are module-private (not exported). The RAGFlow block is `ragflow: ragflowFromEnv(env)` (config.ts ~line 692), and `ragflowFromEnv` is exported from `packages/mcp-server/src/planes/ragflow.ts:65`. That is the precedent for a plane config read from a helper module.
- Tool declaration, `packages/mcp-server/src/mcp.ts`:
  - `createMcpServer(substrate: Substrate, caller)` (line 200). Tools are `server.registerTool(name, { title, description, inputSchema: { ...zod }, annotations }, async (request) => { try { return json(await substrate.X(...)) } catch (cause) { ... return { ...json(...), isError: true } } })`.
  - Precedents: `skills_approve` (line ~1127, annotations `destructiveHint: false, openWorldHint: true`, operator-only) and `skills_list` (line ~1163, `readOnlyHint: true`).
  - Caller identity: `isOperator` and `callerSurface` are in scope (line ~202).
- Policy classes, `packages/audit/src/policy.ts` (the brief's `policy.ts`):
  - `FAIL_CLOSED_TOOLS` lists writes that must be audited before they run (e.g. `skills_approve`, `docs_ingest`, `desktop_run`).
  - `FAIL_OPEN_TOOLS` lists reads. An unlisted name is fail-closed by default.
  - `policy.test.ts` pins that every served tool has a decision.
- Admission class, `packages/mcp-server/src/admission.ts` `TOOL_CLASSES` (~line 191): `read` or `write` or `coordination` per tool. `admission.test.ts` reads `mcp.ts` and fails on a registered name missing here.
- Known tools, `packages/mcp-server/src/observe.ts` (`KNOWN_TOOLS`, ~line 620-645): a registered tool must be listed for metrics labels.
- `/slo` composition, `packages/mcp-server/src/server.ts` (~line 899-968): `observability.evaluate()` results, `breached` built from the catalogue, planes and burn only. Report-only keys follow: `docs`, `surfaces`, `capacity` (`observability.evaluateCapacity()`, ~line 937), `served`, and `...(indexArchive !== null ? { indexArchive: [indexArchive] } : {})` (~line 966). The Railway key follows the `indexArchive` pattern: a report-only key, never folded into `breached`, and fail-open (a catch yields a row, never a 500).
- Event vocabulary:
  - `EVENT_KINDS` (`packages/mcp-server/src/types.ts:54-67`) has 12 entries, locked by `scripts/phase-close-check.ts` against the v1.2 baseline (`check:phase-close`).
  - `EVENT_SOURCES` (`packages/mcp-server/src/event-sources.ts:69`) rows have `id`, `phase`, `kind` (one of EVENT_KINDS), `surface` (`{ fixed: Surface }`, `"caller"`, etc.), `actions?`, `runtime?`. `SILENT_SOURCES` (line 1050) holds reads that emit nothing.
  - `event-sources.test.ts` asserts every row's sample survives `normalizeEvent` and that `docs/event-vocabulary.md` names the same sources, kinds and surfaces.
- Flag registry, `packages/mcp-server/src/flag-registry.ts`: `FLAGS` entries are object literals `{ name, kind, plane, default, allowed, unset, readBy, documented, doc }` (e.g. `SUBSTRATE_SERVED_TOKENS_PER_HOUR` at ~line 634). `plane` must be in `FLAG_PLANES`. `flag-registry.test.ts` fails when code reads a name with no row (`flag-registry-scan.ts`), and when a `documented: true` row is missing from `.env.example`.
- Forwarder boundary, `docs/railway-tailscale.md`: the tailnet ACL grants only `tag:vps` and `tag:admin` to forwarder ports (4000-4003, 5432, 6379, 8888, 9380, 80). The forwarders carry database and service traffic, not the Railway API.
- No Railway code exists in `packages/mcp-server` yet (`railway` appears only in `.env.example` comments and `docs/`).
- `--live <approval-ref>` precedent: `docs/uat.md` and `scripts/uat-phase0.ts:39-104`. Write scenarios refuse against production before any request without it. The `skills_approve` precedent (`server.ts:289-291`) refuses an anonymous or non-operator caller.

## Decisions

- **D45-a. Control plane is the Railway public API, not the forwarders.** Control calls go to `https://backboard.railway.app/graphql/v2` with a bearer token from the environment variable `RAILWAY_API_TOKEN` (name only; the value is never logged, stored, put in an event, or echoed in an error). They do not go through the Tailscale forwarders. Reason: `docs/railway-tailscale.md` defines the forwarders as data-plane bridges for database and service ports, and their ACL does not name the Railway API. The API is reached over HTTPS from the substrate host. The project-token header form is unconfirmed (see Unconfirmed item 5); only the bearer form is built.

- **D45-b. Reads need no approval; the scale suggestion is advisory.** `railway_list`, `railway_monitor`, `railway_scale_suggest` and `railway_cost` are read-only. They make no change and need no approval reference. `railway_scale_suggest` returns a recommendation and never applies it. Reason: reads are inspection, and a suggestion that applies itself would be an unreviewed write.

- **D45-c. Writes are refused by default, and need three things.** `railway_scale` and `railway_deploy` act only when ALL of these hold: (1) `SUBSTRATE_RAILWAY_WRITES` is exactly `on`; (2) the caller is an operator (`isOperator`, the same gate `skills_approve` uses); (3) the call carries a non-empty `approval_ref` matching `^[A-Za-z0-9._:/#-]{1,128}$`, the same shape as the UAT `--live <approval-ref>`. Any failure refuses BEFORE any network request, with one of the refusal codes `writes-disabled`, `operator-required`, `approval-ref-missing`, `unconfigured`, `out-of-bounds`. Reason: a mutation on a live project is the operator's decision, and refusing before the request means a refused call can never change anything. The approval reference is recorded in the event payload; it is a reference, not a secret, and the length and charset bound stop it carrying one. The live proof (a real write to the Agent Substrate project) is operator-gated and is not part of this phase's automated tests.

- **D45-d. Cost report: estimated usage times operator-set unit prices; never an invented price.**
  - Read with `estimatedUsage(measurements: [CPU_USAGE, MEMORY_USAGE_GB, DISK_USAGE_GB, NETWORK_TX_GB], projectId)`, summed over `SUBSTRATE_RAILWAY_PROJECT_IDS`.
  - Unit prices come from `SUBSTRATE_RAILWAY_PRICE_CPU_USD`, `SUBSTRATE_RAILWAY_PRICE_MEMORY_GB_USD`, `SUBSTRATE_RAILWAY_PRICE_DISK_GB_USD`, `SUBSTRATE_RAILWAY_PRICE_NETWORK_TX_GB_USD`. Unset means unpriced.
  - If any measurement with a value above zero has no price, the report's status is `unpriced`. Its lines still show the raw measurement and value. No price is ever assumed.
  - The budget is `SUBSTRATE_RAILWAY_BUDGET_USD`, default `50` (the owner's decided ceiling). A projected monthly total above the budget gives `over-budget`.
  - Because the period and unit of `estimatedValue` are unconfirmed (Unconfirmed item 2), the operator confirms them on the first live read before setting any price. The report prints the raw value so a unit mistake is visible.
  - Reason: the owner set a ceiling; a cost figure built on a guessed price would be a false number.

- **D45-e. Scale suggestion: p95 with headroom, clamped to configured bounds, and not via `serviceInstanceLimits`.**
  - Current limits come from the latest sample of `CPU_LIMIT` and `MEMORY_LIMIT_GB` (`metrics`), both confirmed enum members with the confirmed `Metric` shape. Reason: `serviceInstanceLimits` returns an unconfirmed scalar, so it is not used.
  - Usage is the p95 (nearest rank) of `CPU_USAGE` and `MEMORY_USAGE_GB` over `SUBSTRATE_RAILWAY_SCALE_WINDOW_SECONDS` (default `86400`), sampled at 300-second averaging.
  - Suggested value = `clamp(roundUp(p95 * (1 + headroom), 0.25), min, max)`. `headroom` is `SUBSTRATE_RAILWAY_SCALE_HEADROOM` (0 to 1, default `0.3`). Bounds are `SUBSTRATE_RAILWAY_SCALE_MIN_VCPUS` (default 0.25), `..._MAX_VCPUS` (default 4), `..._MIN_MEMORY_GB` (default 0.25), `..._MAX_MEMORY_GB` (default 8).
  - Fewer than 24 samples, or a missing limit series, gives `insufficient-data` with no suggestion. A guess is never made.
  - Reason: p95 ignores the single spikes that a max would chase, headroom absorbs bursts, and bounds stop a bad series from proposing an unbounded size. The defaults are proposals for the operator to set.

- **D45-f. No new `EVENT_KINDS`.** Write outcomes use existing kinds. A write that is applied emits `note`. A refused or failed write emits `warning`. The source rows are `railway.scale` and `railway.deploy` in `event-sources.ts`, with `surface: { fixed: "substrate" }` and `runtime: "railway"`. Reads emit nothing, so they sit in `SILENT_SOURCES`. Reason: `check:phase-close` locks `EVENT_KINDS`; the write-path fact is carried by the action, as the Phase 17 host jobs already do.

- **D45-g. `/slo` cost row is report-only and fail-open.** One key, `railwayCost`, on the `/slo` payload, following the `indexArchive` pattern. It is never folded into `breached`. Its status is one of `ok`, `over-budget`, `unpriced`, `unavailable`, `unconfigured`. A Railway error gives `unavailable` in the row; `/slo` still returns 200. The cost report is cached for 900 seconds, so a monitor's scrape frequency does not reach the Railway API. Reason: `breached` drives the storm-breaker and runbook, and a cost overrun should be visible without paging on a slow hour. Failure must never take `/slo` down.

- **D45-h. Policy classes follow the write/read split.** Read tools (`railway_list`, `railway_monitor`, `railway_scale_suggest`, `railway_cost`) go in `FAIL_OPEN_TOOLS` and get admission class `read`. Write tools (`railway_scale`, `railway_deploy`) go in `FAIL_CLOSED_TOOLS` and get admission class `write`. `KNOWN_TOOLS` in `observe.ts` lists all six. Reason: a write must be audited before it runs; a read must not be blocked by an unwritable audit file (`packages/audit/src/policy.ts` header).

- **D45-i. Pure logic and I/O are split; `fetch` is injected.** `railway.ts` exports pure functions (`p95`, `suggestScale`, `buildCostReport`, `writeRefusal`, `railwayFromEnv`) and one `RailwayClient` class whose constructor takes a `fetch` implementation. Tests inject a recording fake fetch and never reach Railway. Reason: the write refusal and the cost arithmetic must be checkable without a network, and a test that makes a live call would spend the owner's account.

- **D45-j. Redaction.** The client never logs, stores, or puts in an error or event: the token, the Authorization header, or the raw request body. A Railway failure is reported as the GraphQL `message` and `traceId` only. Reason: `docs/redaction.md` and the desk rule "no secrets".

- **D45-k. Replicas are out of scope.** `numReplicas` and `multiRegionConfig` are confirmed but not changed by this phase. The scale write covers vCPU and memory only. Reason: the ROADMAP acceptance says "scale suggestion" and one limit write; replica changes alter instance count and failure behaviour and need their own decision. Recorded here so it is not silently dropped.

- **D45-l. Project and service identifiers are explicit.** Every tool takes `environment_id` and `service_id` (and `project_id` where needed) as arguments. Nothing is inferred from names. The only configured identifiers are `SUBSTRATE_RAILWAY_PROJECT_IDS` for the cost report. Reason: a write must name its target; name matching across projects is ambiguous.

- **D45-m. The deploy write is `serviceInstanceRedeploy`.** It takes `(environmentId, serviceId)` and returns Boolean, so it matches the scale write's shape. `deploymentRedeploy` needs a deployment id and returns a new `Deployment`, which adds a lookup step for no acceptance benefit. Reason: fewer moving parts on a live write.

- **D45-n. Limits are applied with one mutation call.** `setServiceLimits` calls `serviceInstanceLimitsUpdate({ input: { environmentId, serviceId, vCPUs, memoryGB } })`. It checks bounds first (`out-of-bounds`), then the write gate, then sends. A `false` or non-boolean response is a failure. Reason: one call, one confirmed shape.

- **D45-o. Cache for the cost report only.** `RailwayClient.costReport()` memoises for 900 seconds in process. Other reads are not cached. Reason: only the scrape-driven read has a frequency problem.

## Environment (names only; values never written to the repo)

Read through `railwayFromEnv` and documented in `.env.example` (documented rows) and `flag-registry.ts`:

`RAILWAY_API_TOKEN` (secret ref), `SUBSTRATE_RAILWAY_WRITES` (`on` or unset), `SUBSTRATE_RAILWAY_BUDGET_USD` (default 50), `SUBSTRATE_RAILWAY_PROJECT_IDS` (comma list), `SUBSTRATE_RAILWAY_PRICE_CPU_USD`, `SUBSTRATE_RAILWAY_PRICE_MEMORY_GB_USD`, `SUBSTRATE_RAILWAY_PRICE_DISK_GB_USD`, `SUBSTRATE_RAILWAY_PRICE_NETWORK_TX_GB_USD`, `SUBSTRATE_RAILWAY_SCALE_MIN_VCPUS`, `SUBSTRATE_RAILWAY_SCALE_MAX_VCPUS`, `SUBSTRATE_RAILWAY_SCALE_MIN_MEMORY_GB`, `SUBSTRATE_RAILWAY_SCALE_MAX_MEMORY_GB`, `SUBSTRATE_RAILWAY_SCALE_HEADROOM` (default 0.3), `SUBSTRATE_RAILWAY_SCALE_WINDOW_SECONDS` (default 86400).

## Out of scope

- The live write proof, the live cost read, and setting any real price. Operator-gated, as the Phase 42 precedent records for live proofs.
- Replica changes (D45-k), `deploymentRedeploy` (D45-m), and the `serviceInstanceLimits` scalar (D45-e).
- Creating the Railway token or any Railway project, service or forwarder.
- Any change to the forwarders, the tailnet ACL, or `docs/railway-tailscale.md`.

## Open items for the operator (checked live, not here)

1. The first live `railway_cost` read: confirm the unit and period of `estimatedValue` (Unconfirmed 2) before setting any price.
2. The first live `railway_monitor` read: confirm `CPU_LIMIT` and `MEMORY_LIMIT_GB` units (Unconfirmed 3).
3. The auth form for the token type the operator issues (Unconfirmed 5).
4. The first refused write without the gate, and then, under operator approval, one gated write. Each is recorded with its approval reference.
