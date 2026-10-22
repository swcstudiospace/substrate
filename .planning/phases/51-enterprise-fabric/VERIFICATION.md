---
phase: 51-enterprise-fabric
verified: 2026-10-22
status: gaps_found
score: 1 of 2 acceptance criteria PASS in-repo (criterion 1 FAIL on its read-only sub-check; criterion 2 PASS); goal-level dashboard check FAIL (reported separately, not a criterion)
verified_on: gsd/p51-fabric-impl at 645c2fe1098a1f2c52d845359e18c4152abc5225, base 96d23ef
covered_files: ["packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/observe.ts", "packages/audit/src/policy.ts", "packages/audit/src/policy.test.ts", "packages/mcp-server/src/fabric/types.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/fabric/optimize.ts", "packages/mcp-server/src/fabric/compliance.ts", "packages/mcp-server/src/fabric/gather.ts", "packages/mcp-server/src/fabric-mcp.test.ts", "packages/mcp-server/src/fabric/fixtures.ts", "docs/data-planes.md", "infra/vps/dashboards/substrate-data-planes.json", "infra/vps/dashboards/substrate-slo.json", "scripts/dashboards.ts", ".planning/phases/51-enterprise-fabric/CONTEXT.md", ".planning/phases/51-enterprise-fabric/PLAN.md"]
---

# 51-VERIFICATION: Enterprise Unified Resource Fabric

## Gates

Not run by the verifier; orchestrator gates pending. This verification read the code only. No test, typecheck, lint or install was run.

## Acceptance criteria

Criteria are the ROADMAP success criteria for phase 51, verbatim: (1) New MCP tools for fabric status and optimization suggestions. (2) Compliance report.

| criterion | verdict | evidence |
|---|---|---|
| 1. New MCP tools for fabric status and optimization suggestions: registered | PASS | `fabric_status` registered at `packages/mcp-server/src/mcp.ts:1353-1366`; `fabric_optimize` at `mcp.ts:1368-1383`; both inside `createMcpServer` (`mcp.ts:206`, closes at `mcp.ts:1496`) with no conditional around them. Each handler calls `fabricRead()` (`mcp.ts:1348-1351`) and the pure builders `buildFabricStatus` (`status.ts:69-82`) and `buildFabricSuggestions` (`optimize.ts:31-166`). |
| 1. ...reachable | PASS | Tool names are in the audit and admission tables that gate calls: `admission.ts:216-217` (`"read"`), `observe.ts:652-653` (`KNOWN_TOOLS`), `policy.ts:71-73` (`FAIL_OPEN_TOOLS`), `policy.test.ts:55-56` (asserts fail-open). Registration is unconditional, so the tools are listed and callable. |
| 1. ...read-only (`readOnlyHint`) | PASS | Each of the three registrations sets `annotations: { readOnlyHint: true }` at `mcp.ts:1363`, `mcp.ts:1377`. |
| 1. ...read-only (behaviour) | FAIL | The handlers do not change configuration, Railway, or endpoints, but the read path issues a GreptimeDB write. `fabricSources().health()` (`service.ts:6107-6108`) → `greptimeProbe` (`service.ts:6025`) → `writeProbeReading` (`service.ts:6038`, `6048-6051`) → `probeWritable` (`greptime.ts:1799-1811`) → `writeProbe` runs `INSERT INTO substrate_health ... 'healthz'` (`greptime.ts:1779-1785`). The probe is due every `writeProbeS` seconds, default 60 (`config.ts:1661`). This contradicts D51-a ("No writes", CONTEXT.md) and the tool descriptions "it changes nothing" (`mcp.ts:1361`, `1375`, `1392`). |
| 2. Compliance report exists and is registered | PASS | `fabric_compliance` registered at `packages/mcp-server/src/mcp.ts:1385-1401`, `annotations.readOnlyHint` at `mcp.ts:1394`, returns `buildFabricCompliance({ facts, status, suggestions })` (`mcp.ts:1399`). |
| 2. States a verdict per check from PASS, FAIL, NOT_APPLICABLE | PASS | Verdict type `FabricCheckStatus = "PASS" \| "FAIL" \| "NOT_APPLICABLE"` (`fabric/types.ts:66`). Checks assembled at `compliance.ts:31-37` and counted at `compliance.ts:38-40`. Per check: `db-endpoints-private` NOT_APPLICABLE/FAIL/PASS at `compliance.ts:47`, `50`, `52`; `db-endpoint-policy-enforce` at `compliance.ts:59`, `62`, `64`; `audit-policy-fabric-tools` at `compliance.ts:70-72`; `report-redaction` at `compliance.ts:76-85`; `resource-state.<resource>` NOT_APPLICABLE/PASS/FAIL at `compliance.ts:88-94`. An unconfigured resource is never PASS (`compliance.ts:90-91`). |

## Goal-level check (reported separately, not a criterion)

Question: does the branch provide dashboards covering all six resources (Railway and Tailscale)?

Search run: `grep -n -i "fabric\|tailscale\|dragonfly\|timescale\|ragflow\|greptime\|hindsight" infra/vps/dashboards/*.json scripts/dashboards.ts`, with per-term counts. Results: `fabric` 0; `tailscale` 0; `dragonfly` 0; `timescale` 0; `ragflow` 1 and `greptime` 1 (both in one description at `infra/vps/dashboards/substrate-data-planes.json:258`, which lists the planes "greptime, index, cache, hindsight, ragflow"); `hindsight` 11 (panels at `substrate-data-planes.json:1202`, `1309`, and `scripts/dashboards.ts:119-120`, `261-262`). `docs/` search for `fabric` returns only `docs/data-planes.md:233-243`; `docs/observability.md` has no fabric section.

Verdict: **FAIL**. No dashboard covers the fabric, the Tailscale dimension, or the six resources. The data-planes dashboard covers five data planes by latency only. CONTEXT.md D51-f excludes dashboards from the acceptance criteria, so this is the recorded gap, not a criterion failure.

## Gaps

- Criterion 1, read-only behaviour: the three fabric tools reach a GreptimeDB INSERT into `substrate_health` through the shared health probe (`service.ts:6025-6038`, `greptime.ts:1779-1785`, `1799-1811`), at most once per `writeProbeS` (default 60, `config.ts:1661`). Missing piece: a fabric read that does not issue the write probe (for example, reading the existing probe memo without a new write), or an explicit amendment of D51-a and the three descriptions (`mcp.ts:1361`, `1375`, `1392`) to disclose the health marker write.
- Criterion 1 is FAIL only on the read-only sub-check. Registration, reachability and `readOnlyHint` pass.
- Goal-level (not a criterion): no dashboard for the fabric or the six resources. Missing piece: a dashboard panel set in `infra/vps/dashboards/` or `scripts/dashboards.ts` that reads the fabric status (or the planes plus `tailscale-proxy`), with a test that the six resource names appear.

## Operator-gated

- Tailscale ACL, forwarder health and the allow-list values (phase 48, CONTEXT.md open items). The fabric reads only the endpoint classes (`service.ts:6126-6136`), so the in-repo part passes without these.
- Live values: `fabric_status`, `fabric_optimize` and `fabric_compliance` against a deployed server need `RAILWAY_API_TOKEN` and the production data-plane URLs. Not run here. The in-repo behaviour is not affected by this.

## Residual risks

- The fabric's health reads go through `health()`'s probes (`service.ts:5932-6088`, refactored for this phase). The `/healthz` parity claim rests on the commit messages and was not re-run here.
- A configured Dragonfly reads `unavailable` until a cache command connects, because the cache client has no ping (`docs/data-planes.md:243`). `fabric_optimize` will then emit `unavailable.dragonfly` (`optimize.ts:60-69`) on a fresh boot.
- `report-redaction` (`compliance.ts:76-85`) tests the report against the same `redact()` that produced the report's fields. It catches a secret-shaped string, not a leak through a non-matching field.
- Each fabric call can issue a Railway cost query (`railway.ts:585`), cached 15 minutes per CONTEXT.md.
- Branch base `96d23ef` is a merge of `origin/ci/github-hosted-runners` into `gsd/p48-ci`. It contains the phase 48 and phase 50 commits (`74234c1`, `8cea507`), but whether those reached `origin/main` was not checked.
