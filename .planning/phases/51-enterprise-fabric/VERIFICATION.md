---
phase: 51-enterprise-fabric
verified: 2026-10-22
status: passed
score: 2 of 2 acceptance criteria PASS in-repo; goal-level dashboard check PASS (six resources, with the extended-series caveat in Residual risks)
verified_on: gsd/p51-fabric-impl at b0feacce310f5f26ae0a1468c4e9bfa394a2df1c (re-verification after the fix-ups 4f9468d..b0feacc; first verification at 645c2fe)
covered_files: ["packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/metrics-history.ts", "packages/mcp-server/src/metrics-history.test.ts", "packages/mcp-server/src/fabric-mcp.test.ts", "packages/mcp-server/src/fabric/types.ts", "packages/mcp-server/src/fabric/gather.ts", "packages/mcp-server/src/fabric/compliance.ts", "packages/mcp-server/src/planes/hindsight.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/observe.ts", "packages/audit/src/policy.ts", "packages/observability/src/instruments.ts", "packages/observability/src/index.ts", "scripts/dashboards.ts", "scripts/dashboards.test.ts", "infra/vps/dashboards/substrate-data-planes.json", "docs/observability.md", "docs/data-planes.md"]
---

# 51-VERIFICATION: Enterprise Unified Resource Fabric

## Gates

Not run by the verifier; orchestrator gates pending. The orchestrator reports `tsc` clean and 396 pass, 0 fail across the fabric, dashboards, metrics and observability tests. Those numbers are the orchestrator's; this verifier did not re-run them.

## Acceptance criteria

Criteria are the ROADMAP success criteria for phase 51, verbatim: (1) New MCP tools for fabric status and optimization suggestions. (2) Compliance report.

| criterion | verdict | evidence |
|---|---|---|
| 1. New MCP tools for fabric status and optimization suggestions: registered | PASS | `fabric_status` at `packages/mcp-server/src/mcp.ts:1353-1366`; `fabric_optimize` at `mcp.ts:1368-1383`; both in `createMcpServer` (`mcp.ts:206`) with no conditional. Handlers call `fabricRead()` (`mcp.ts:1348-1351`) and the pure builders `buildFabricStatus` (`fabric/status.ts`) and `buildFabricSuggestions` (`fabric/optimize.ts`). |
| 1. ...reachable | PASS | Admitted and audited: `admission.ts:216-217` (`"read"`), `observe.ts:652-653` (`KNOWN_TOOLS`), `packages/audit/src/policy.ts:71-73` (`FAIL_OPEN_TOOLS`). |
| 1. ...read-only (`readOnlyHint`) | PASS | `annotations: { readOnlyHint: true }` at `mcp.ts:1363` and `mcp.ts:1377`. |
| 1. ...read-only, zero writes on every call including the first | PASS | (a) The fabric never requests a write probe. `service.ts:6085` calls `healthProbes(options.greptimeTimeoutMs, false)`; `service.ts:6052-6053` runs `client.probeWritable(probeWrites ? writeProbeS*1000 : 0)`, and `greptime.ts:1800` returns the cached probe for interval 0 without writing. The only `probeWrites = true` caller is `/healthz`, `service.ts:5938`. (b) Before any `/healthz` probe, the fabric reads no verdict and reports the Greptime row unavailable, not ok: `fabric/gather.ts:76`, `gather.ts:98`, `gather.ts:101` (`health().greptime: no write reading`), `service.ts:6120` (`writeUnread`). (c) The other fabric reads are reads: ping `SELECT 1` (`greptime.ts:1764-1770`), `SHOW CREATE TABLE` (`greptime.ts:1105`, reached from `appendModeEnabled` at `greptime.ts:1072-1075`), `SELECT` dialect probe (`greptime.ts:831-833`), `information_schema` capacity (`greptime.ts:1839-1847`), index `select 1` (index ping), Hindsight `GET /health` (`planes/hindsight.ts`, `probeHealth`), RAGFlow list. DDL (`CREATE`, `ALTER`) runs only from `migrate()`, called at boot from `index.ts:114` and `service.ts:1553-1569`; `alterTtl` is reached only from `greptime.ts:1012` inside `migrate`. (d) Test that records SQL: `fabric-mcp.test.ts:435-458` ("fabric reads never write to Greptime"). It records every statement on the Greptime wire, asserts the first `fabric_status` reads greptime `unavailable` (within `:436-448`), runs `fabric_optimize` and `fabric_compliance`, asserts `statements.length > 0` (`:449`) and that no statement matches `WRITE_STATEMENT` (`:404`, asserted at `:450`). Positive control: `substrate.health()` then does write (`:452-453`). |
| 2. Compliance report exists and is registered | PASS | `fabric_compliance` at `packages/mcp-server/src/mcp.ts:1385-1401`, `readOnlyHint` at `mcp.ts:1394`, returns `buildFabricCompliance({ facts, status, suggestions })` (`mcp.ts:1399`). `fabric/compliance.ts` is unchanged since 645c2fe. |
| 2. States a verdict per check from PASS, FAIL, NOT_APPLICABLE | PASS | Verdict type `FabricCheckStatus = "PASS" \| "FAIL" \| "NOT_APPLICABLE"` (`fabric/types.ts:66`). Checks assembled at `compliance.ts:31-37`, counted at `compliance.ts:38-40`. Per check: `db-endpoints-private` at `compliance.ts:47`, `50`, `52`; `db-endpoint-policy-enforce` at `compliance.ts:59`, `62`, `64`; `audit-policy-fabric-tools` at `compliance.ts:70-72`; `report-redaction` at `compliance.ts:76-85`; `resource-state.<resource>` at `compliance.ts:88-94`. An unconfigured resource is NOT_APPLICABLE, never PASS (`compliance.ts:90-91`). |
| 3 (goal). Data-planes dashboard covers all six resources in `FABRIC_RESOURCES` | PASS | Six panels in `infra/vps/dashboards/substrate-data-planes.json`: `Fabric: dragonfly` (`:128`), `Fabric: timescaledb-index` (`:235`), `Fabric: greptime` (`:347`), `Fabric: ragflow` (`:468`), `Fabric: hindsight` (`:584`), `Fabric: tailscale-proxy` (`:691`), under the row `Fabric resources (phase 51)` (`:22`). The generator maps each resource to a series in `FABRIC_SERIES` (`scripts/dashboards.ts:132-139`) and throws for a resource with no entry (`scripts/dashboards.ts:262-263`). Test: `scripts/dashboards.test.ts:347-360` asserts one panel per `FABRIC_RESOURCES` entry, each reading an allow-listed series. |

## Gate detail for criterion 1 and the goal

- `tailscale-proxy` series: `endpoint.proxy_planes` (`scripts/dashboards.ts:138`; the panel's `value` at `substrate-data-planes.json:677`). It is defined in `metrics-history.ts:144` and `:388`, and backed by `ENDPOINT_PROXY_PLANES_METRIC` (`packages/observability/src/instruments.ts:694`).
- Boot sets the gauge: `packages/mcp-server/src/observe.ts:300` calls `instruments.setEndpointProxyPlanes(...)` with the count of `proxy` classes in `config.dbEndpoints.classes`. `createObservability` is at `observe.ts:278` and is called unconditionally at `packages/mcp-server/src/index.ts:63`. No `return` sits between lines 278 and 300. The setter is at `packages/observability/src/instruments.ts:668-669`.
- S6 contract (`5dc93dd`, `b0feacc`): the constructor no longer sets the gauge (`instruments.ts`, `-3` lines in `b0feacc`), so the row appears only after boot sets it. Production boot still sets it, so the gauge is live in production. The fixture change in `metrics-history.test.ts` (`b0feacc`, `+8`) adds a `bootEndpoints(instruments)` helper that makes the same call as `observe.ts:300` with the empty-environment count, and calls it in `extendedActivity` and one test. It adds setup only; no assertion changed.

## Gaps

None.

## Operator-gated

- Tailscale ACL, forwarder health and allow-list values (phase 48). The fabric reads only the endpoint classes (`service.ts:6136-6147`), so the in-repo part passes without them.
- Live values: the three tools against a deployed server need `RAILWAY_API_TOKEN` and the production data-plane URLs. Not run here.

## Residual risks

- The Greptime row is `unavailable` until a `/healthz` probe has recorded a write verdict since boot (`fabric/gather.ts:76`, `:98`). `fabric_optimize` then emits `unavailable.greptime` and `fabric_compliance` reports FAIL for it. A fabric-only deployment with no `/healthz` poller shows this state.
- The extended-series panels (`Fabric: hindsight`, `Fabric: tailscale-proxy`) are omitted from a core-only history render (`scripts/dashboards.ts:38`, `:147-179`; test `scripts/dashboards.test.ts:134-150`). The committed JSON is the all-series render. With default history mode, four of six fabric panels appear.
- The `Fabric: dragonfly` panel shows the cache hit ratio, not the resource's state. It is a signal panel, not a health panel.
- A configured Dragonfly reads `unavailable` until a cache command connects (the cache client has no ping; `docs/data-planes.md`, fabric section). `fabric_optimize` emits `unavailable.dragonfly` on a fresh boot.
- The fabric still issues live read probes (ping, dialect and append-mode reads, Hindsight and RAGFlow GETs). They are reads, not writes, but CONTEXT.md D51-b said "no new probe".
- `report-redaction` (`compliance.ts:76-85`) tests the report against the same `redact()` that produced its fields.
- Branch base `96d23ef` is a merge into `gsd/p48-ci`. It contains the phase 48 and phase 50 commits, but whether those reached `origin/main` was not checked.
