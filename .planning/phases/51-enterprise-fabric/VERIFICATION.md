---
phase: 51-enterprise-fabric
verified: 2026-10-22
status: passed
score: 2 of 2 acceptance criteria PASS in-repo; goal-level dashboard check PASS (six resources, with the extended-series caveat in Residual risks)
verified_on: gsd/p51-fabric-impl at 91d74c70289c1e7cb2291f52583ecb69244de5a4 (delta re-verification after the review fixes b5123ad and 91d74c7; previous 9f8a1d5, first pass 645c2fe)
covered_files: ["packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/metrics-history.ts", "packages/mcp-server/src/metrics-history.test.ts", "packages/mcp-server/src/fabric-mcp.test.ts", "packages/mcp-server/src/fabric/types.ts", "packages/mcp-server/src/fabric/gather.ts", "packages/mcp-server/src/fabric/compliance.ts", "packages/mcp-server/src/planes/hindsight.ts", "packages/mcp-server/src/admission.ts", "packages/audit/src/policy.ts", "packages/observability/src/instruments.ts", "packages/observability/src/index.ts", "scripts/dashboards.ts", "scripts/dashboards.test.ts", "infra/vps/dashboards/substrate-data-planes.json", "docs/observability.md", "docs/data-planes.md"]
---

# 51-VERIFICATION: Enterprise Unified Resource Fabric

## Gates

Not run by the verifier; orchestrator gates pending. The orchestrator reports `tsc` clean and 398 pass, 0 fail across the fabric, dashboards, metrics and observability tests on this head. Those numbers are the orchestrator's; this verifier did not re-run them.

## Acceptance criteria

Criteria are the ROADMAP success criteria for phase 51, verbatim: (1) New MCP tools for fabric status and optimization suggestions. (2) Compliance report.

| criterion | verdict | evidence |
|---|---|---|
| 1. New MCP tools for fabric status and optimization suggestions: registered | PASS | `fabric_status` at `packages/mcp-server/src/mcp.ts:1353-1366`; `fabric_optimize` at `mcp.ts:1368-1383`; both in `createMcpServer` (`mcp.ts:206`) with no conditional. Handlers call `fabricRead()` (`mcp.ts:1348-1351`), which runs `gatherFabricFacts(substrate.fabricSources())`, then the pure builders `buildFabricStatus` (`fabric/status.ts`) and `buildFabricSuggestions` (`fabric/optimize.ts`). |
| 1. ...reachable | PASS | Admitted and audited: `admission.ts:216-217` (`"read"`), `observe.ts:652-653` (`KNOWN_TOOLS`), `packages/audit/src/policy.ts:71-73` (`FAIL_OPEN_TOOLS`). |
| 1. ...read-only (`readOnlyHint`) | PASS | `annotations: { readOnlyHint: true }` at `mcp.ts:1363` and `mcp.ts:1377`; `fabric_compliance` at `mcp.ts:1394`. |
| 1. ...zero writes on every call, including the first call | PASS | (a) The fabric never requests a write probe. `service.ts:6090` calls `healthProbes(options.greptimeTimeoutMs, false)` from `sharedHealthProbes`; `service.ts:6058` runs `client.probeWritable(probeWrites ? writeProbeS*1000 : 0)`; `greptime.ts:1800` returns the cached probe for interval 0 without writing. The only `probeWrites = true` caller is `/healthz`, `service.ts:5938`. (b) Before any `/healthz` probe with the write probe on, the fabric reads no verdict and reports the Greptime row unavailable, not ok: `service.ts:6126` (`writeUnread: this.config.ledger.writeProbeS > 0 && …`), `fabric/gather.ts:76`, `gather.ts:98`, `gather.ts:101` (`health().greptime: no write reading`). (c) Interval-0 case, from `b5123ad`: with `writeProbeS` at 0 the verdict is metadata-only, so `writeUnread` is false (`service.ts:6126`) and a healthy Greptime reads ok. The fabric still writes nothing, because `probeWrites` is false on the fabric path (`service.ts:6058`). (d) The other fabric reads are reads: ping `SELECT 1` (`greptime.ts:1764-1770`), append-mode `SHOW CREATE TABLE` (`greptime.ts:1105`, via `appendModeEnabled` at `greptime.ts:1072-1075`), dialect `SELECT` (`greptime.ts:831-833`), `information_schema` capacity (`greptime.ts:1839-1847`), index `select 1` (index ping), Hindsight `GET /health` (`planes/hindsight.ts`), RAGFlow list. DDL (`CREATE`, `ALTER`) runs only from `migrate()`, called at boot from `index.ts:114` and `service.ts:1553-1569`; `alterTtl` is reached only from `greptime.ts:1012` inside `migrate`. (e) Tests: `packages/mcp-server/src/fabric-mcp.test.ts:436` ("fabric_status, fabric_optimize and fabric_compliance issue no write, on the first call or after") records every Greptime statement, asserts the first call reads greptime `unavailable`, asserts `statements.length > 0` and no statement matches `WRITE_STATEMENT` (`:404`). `:461` ("a healthy Greptime reads ok at SUBSTRATE_LEDGER_WRITE_PROBE_S=0, and the fabric still issues no write") asserts greptime `ok` with the probe off and no write statement. Positive control in `:436`: `substrate.health()` does write. |
| 2. Compliance report exists and is registered | PASS | `fabric_compliance` at `packages/mcp-server/src/mcp.ts:1385-1401`, returns `buildFabricCompliance({ facts, status, suggestions })` (`mcp.ts:1399`). `fabric/compliance.ts` is unchanged since 645c2fe. |
| 2. States a verdict per check from PASS, FAIL, NOT_APPLICABLE | PASS | Verdict type `FabricCheckStatus = "PASS" \| "FAIL" \| "NOT_APPLICABLE"` (`fabric/types.ts:66`). Checks assembled at `compliance.ts:31-37`, counted at `compliance.ts:38-40`. Per check: `db-endpoints-private` at `compliance.ts:47`, `50`, `52`; `db-endpoint-policy-enforce` at `compliance.ts:59`, `62`, `64`; `audit-policy-fabric-tools` at `compliance.ts:70-72`; `report-redaction` at `compliance.ts:76-85`; `resource-state.<resource>` at `compliance.ts:88-94`. An unconfigured resource is NOT_APPLICABLE, never PASS (`compliance.ts:90-91`). |
| 3 (goal). Data-planes dashboard covers all six resources in `FABRIC_RESOURCES` | PASS | Six panels in `infra/vps/dashboards/substrate-data-planes.json`: `Fabric: dragonfly`, `Fabric: timescaledb-index`, `Fabric: greptime`, `Fabric: ragflow`, `Fabric: hindsight`, `Fabric: tailscale-proxy`, under the row `Fabric resources (phase 51)`. Panel count checked: 6. The generator maps each resource to a series in `FABRIC_SERIES` (`scripts/dashboards.ts:132-139`, six entries) and throws for a resource with no entry (`scripts/dashboards.ts:262-263`). Test: `scripts/dashboards.test.ts:347-360`. |

## Goal detail

- `tailscale-proxy` series: `endpoint.proxy_planes` (`scripts/dashboards.ts:138`; the panel's `value` at `substrate-data-planes.json:677`). Defined in `metrics-history.ts:144` and `:388`, backed by `ENDPOINT_PROXY_PLANES_METRIC` (`packages/observability/src/instruments.ts:694`).

## S6 gauge at boot (production)

- `packages/mcp-server/src/observe.ts:300` calls `instruments.setEndpointProxyPlanes(...)` with the count of `proxy` classes in `config.dbEndpoints.classes`. Unchanged this delta.
- `createObservability` is at `observe.ts:278`; no `return` sits between lines 278 and 300. It is called unconditionally at `packages/mcp-server/src/index.ts:63`.
- The setter is at `packages/observability/src/instruments.ts:668-669`. The constructor no longer sets the gauge (S6 contract, `b0feacc`), so the row appears once boot sets it. Production boot sets it, so the gauge is live.
- The test fixture (`metrics-history.test.ts`, `b0feacc`) adds a `bootEndpoints(instruments)` helper that makes the same call as `observe.ts:300`. Setup only.

## Delta since 9f8a1d5

- `b5123ad` (`service.ts:6126`): `writeUnread` is gated on `writeProbeS > 0`. With interval 0 a healthy Greptime reads ok. Test `fabric-mcp.test.ts:461`.
- `91d74c7` (`service.ts:6006-6014`, `6008`, `6014`): the size read (`ledgerCapacity`) is chained to `greptimeUp`, the ping alone (`greptimePing`, `service.ts:6031`), not to the reads that include the write probe (`greptimeReads`, `service.ts:6036`). The ping is one shared promise, so a stalled write probe does not hold the size read. Test `fabric-mcp.test.ts:483` ("the size read starts when the ping answers: a write probe that stalls does not hold it") asserts the size read starts within `HEALTH_PROBE_MS / 2` of the call while the write probe stalls.

## Gaps

None.

## Operator-gated

- Tailscale ACL, forwarder health and allow-list values (phase 48). The fabric reads only the endpoint classes (`service.ts:6144-6153`), so the in-repo part passes without them.
- Live values: the three tools against a deployed server need `RAILWAY_API_TOKEN` and the production data-plane URLs. Not run here.

## Residual risks

- With the write probe on (`SUBSTRATE_LEDGER_WRITE_PROBE_S > 0`), the Greptime row is `unavailable` until a `/healthz` probe has recorded a write verdict since boot (`service.ts:6126`, `fabric/gather.ts:76`, `:98`). `fabric_optimize` then emits `unavailable.greptime`, and `fabric_compliance` reports FAIL for it. A fabric-only deployment with no `/healthz` poller shows this state.
- The extended-series panels (`Fabric: hindsight`, `Fabric: tailscale-proxy`) are omitted from a core-only history render (`scripts/dashboards.ts:38`, `:147-179`; test `scripts/dashboards.test.ts:134-150`). The committed JSON is the all-series render. With default history mode, four of six fabric panels appear.
- The `Fabric: dragonfly` panel shows the cache hit ratio, not the resource's state. It is a signal panel, not a health panel.
- A configured Dragonfly reads `unavailable` until a cache command connects (the cache client has no ping; `docs/data-planes.md`, fabric section). `fabric_optimize` emits `unavailable.dragonfly` on a fresh boot.
- The fabric still issues live read probes (ping, dialect and append-mode reads, Hindsight and RAGFlow GETs). They are reads, not writes, but CONTEXT.md D51-b said "no new probe".
- `report-redaction` (`compliance.ts:76-85`) tests the report against the same `redact()` that produced its fields.
- Branch base `96d23ef` is a merge into `gsd/p48-ci`. It contains the phase 48 and phase 50 commits, but whether those reached `origin/main` was not checked.
