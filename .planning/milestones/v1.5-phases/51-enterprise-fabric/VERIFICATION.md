---
phase: 51-enterprise-fabric
verified: 2026-11-12T08:39:31Z
status: human_needed
score: 2/2 must-haves verified in repository (live checks pending)
behavior_unverified: 0
overrides_applied: 0
covered_files: [".planning/milestones/v1.5-phases/51-enterprise-fabric/PLAN.md", ".planning/milestones/v1.5-phases/51-enterprise-fabric/SUMMARY.md", "docs/data-planes.md", "docs/observability.md", "infra/vps/dashboards/substrate-data-planes.json", "packages/audit/src/policy.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/fabric-mcp.test.ts", "packages/mcp-server/src/fabric/compliance.test.ts", "packages/mcp-server/src/fabric/compliance.ts", "packages/mcp-server/src/fabric/fixtures.ts", "packages/mcp-server/src/fabric/gather.test.ts", "packages/mcp-server/src/fabric/gather.ts", "packages/mcp-server/src/fabric/optimize.test.ts", "packages/mcp-server/src/fabric/optimize.ts", "packages/mcp-server/src/fabric/status.test.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/fabric/types.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/service.ts", "scripts/dashboards.test.ts", "scripts/dashboards.ts"]
covered_digest: "v3:sha256:2dcd50dac13c3cf5f75b6c0147968b7ffdf8ff2664197053cf63c9389cfc5ef0"
---

# Phase 51: Enterprise Unified Resource Fabric Verification Report

**Phase Goal:** One MCP interface and set of dashboards covers all six resources on Railway and Tailscale, with cross-resource optimization and compliance reporting. Roadmap success criteria (authoritative): (1) New MCP tools for fabric status and optimization suggestions. (2) Compliance report.
**Verified:** 2026-11-12T08:39:31Z
**Status:** human_needed
**Re-verification:** Yes — fresh re-run of the verifier. Prior record (2026-10-28, status passed, "nothing was run") was overwritten.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | Fabric status tool is registered, read-only, and returns one row per resource | ✓ VERIFIED | `fabric_status` registered at `packages/mcp-server/src/mcp.ts:2300` with `annotations: { readOnlyHint: true }` (`:2310`); handler built from `fabricRead()` (`:2294-2297`), which calls `gatherFabricFacts(substrate.fabricSources())` then `buildFabricStatus` (`fabric/status.ts`). Nine resources in `FABRIC_RESOURCES` (`fabric/types.ts:9-18`). |
| 2   | Optimization suggestions tool is registered, read-only, evidence-gated | ✓ VERIFIED | `fabric_optimize` at `mcp.ts:2316`, `readOnlyHint` at `:2324`; calls `buildFabricSuggestions` (`fabric/optimize.ts:31`), pure over `(status, facts)`. Tests: `fabric/optimize.test.ts` (firing and silence cases); `fabric-mcp.test.ts:92` ("names an over-budget Railway cost with its figures") and `:114` ("with nothing configured emits no suggestion"). |
| 3   | Compliance report tool is registered, read-only, never passes an unconfigured resource | ✓ VERIFIED | `fabric_compliance` at `mcp.ts:2333`, `readOnlyHint` set; `buildFabricCompliance` pure at `fabric/compliance.ts:25`. Checks: endpoints private, endpoint policy, TEI endpoint, audit fail-open (`compliance.ts:85-87`), secret-free report, one check per resource. Tests: `fabric-mcp.test.ts:121` ("marks unconfigured resources not applicable, never pass, and carries no token"); `fabric/compliance.test.ts:20`, `:81`, `:100`. |
| 4   | Fabric reads issue no Greptime write | ✓ VERIFIED | `sharedHealthProbes` calls `healthProbes(options.greptimeTimeoutMs, false)` (`service.ts:8741`); `writeProbeReading` passes interval 0 when `probeWrites` is false (`service.ts:8709`). Behavioral test records the Greptime wire: `fabric-mcp.test.ts:618` ("issue no write, on the first call or after") and `:643` (interval 0 case). Both passed in this run. |
| 5   | Each tool is admitted and audited | ✓ VERIFIED | Admission class `"read"` for all three (`admission.ts:265-267`); audit fail-open (`packages/audit/src/policy.ts:86-89`); `KNOWN_TOOLS` labels (`observe.ts:687-688`). |
| 6   | Six-resource dashboard panels exist | ✓ VERIFIED (presence) | `FABRIC_SERIES` entries (`scripts/dashboards.ts:139`); `fabricItems()` emits one `Fabric:` panel per resource (`scripts/dashboards.ts:268-271`); `infra/vps/dashboards/substrate-data-planes.json` contains `Fabric:` panels. Dashboard test `scripts/dashboards.test.ts` not run in this pass. Dashboards are not an acceptance criterion (CONTEXT D51-f); the rendered result is human-checked below. |

**Score:** 5/5 truths verified (0 present-but-behavior-unverified). Roadmap criteria: 2/2 met in repository.

### Deferred Items

None. No later milestone phase was needed to close a gap.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/fabric/{types,status,optimize,compliance,gather,fixtures}.ts` | Pure builders plus gather under deadline | ✓ VERIFIED | `FABRIC_SOURCE_DEADLINE_MS = 1500` (`gather.ts:13`); `gatherFabricFacts` (`gather.ts:54`) never throws; `within` (`gather.ts:28`). |
| `packages/mcp-server/src/mcp.ts` | Three tool registrations | ✓ VERIFIED | `:2300`, `:2316`, `:2333`. |
| `packages/mcp-server/src/service.ts` | `fabricSources()` | ✓ VERIFIED | `fabricSources` at `:8776`; `writeUnread` gate at `:8789`. |
| `packages/mcp-server/src/admission.ts`, `observe.ts`, `packages/audit/src/policy.ts` | Registration rows | ✓ VERIFIED | `admission.ts:265-267`, `observe.ts:687-688`, `policy.ts:86-89`. |
| Fabric test files | Unit and MCP-level tests | ✓ VERIFIED | Run in this pass (see below). |
| `docs/observability.md`, `docs/data-planes.md` | Fabric sections | ✓ VERIFIED (presence) | `observability.md:1005` "## The unified resource fabric (phase 51)"; `data-planes.md:253` "## Unified resource fabric (Phase 51)". |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `mcp.ts` tool handlers | `gatherFabricFacts` | `fabricRead()` at `mcp.ts:2294-2297` | ✓ WIRED | |
| `gatherFabricFacts` | `Substrate` health and cost | `substrate.fabricSources()` at `service.ts:8776` | ✓ WIRED | |
| `fabricSources` | shared health probes (no write) | `sharedHealthProbes` `service.ts:8735-8741` | ✓ WIRED | |
| Tool registration | admission and audit | `admission.ts:265-267`, `policy.ts:86-89` | ✓ WIRED | |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `fabric_status` | `resources[].state` | `health()` probes, Railway cost report, TEI, corpus | Yes in code; fixture-tested | ✓ FLOWING |
| `fabric_optimize` | `suggestions` | `buildFabricSuggestions(status, facts)` | Yes | ✓ FLOWING |
| `fabric_compliance` | `checks` | `buildFabricCompliance({facts, status, suggestions})` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Fabric unit tests (status, optimize, compliance, gather) | `bun test packages/mcp-server/src/fabric/` | 78 pass, 0 fail | ✓ PASS |
| MCP tool tests incl. zero-write and compliance | `bun test packages/mcp-server/src/fabric-mcp.test.ts` | 27 pass, 0 fail | ✓ PASS |
| Admission, audit policy, observe lock tests | `bun test` on `policy.test.ts`, `admission.test.ts`, `observe.test.ts` alongside fabric-mcp (4 files) | 170 pass, 0 fail | ✓ PASS |
| Live tools against a deployed server | not run | — | ? SKIP (operator-gated) |

`SUBSTRATE_TEST_PG_URL` was unset in this run, so these tests ran without the live Postgres index tests.

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes are declared for this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| SOTA-07 | PLAN.md (51-enterprise-fabric) | Enterprise Unified Resource Fabric | ✓ SATISFIED (in repository) | `REQUIREMENTS.md:97`, tracker `:180`. Truths 1-5 above. Live deployment check pending. |

No orphaned requirements: SOTA-07 is the only ID mapped to phase 51.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/fabric/*.ts`, `fabric-mcp.test.ts` | — | TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER grep | — | None found. |

### Plan Deviations (info, not gaps)

The ROADMAP criteria are met, but the code differs from `PLAN.md`/`CONTEXT.md` pins. These are recorded, not blocking:

- Tool name `fabric_optimize` (`mcp.ts:2316`), not the PLAN's `fabric_suggest`. The roadmap's wording ("optimization suggestions") fits either.
- Nine resources, not six. Later phases added `tei` (phase 64) and `corpus` (phase 70); Railway feeds suggestions and is not a row. `tailscale-proxy` is a row.
- States are `ok, degraded, unavailable, unconfigured` (no `unknown`). Compliance verdicts are `PASS, FAIL, NOT_APPLICABLE`.
- CONTEXT D51-b said "no new probe". The fabric still issues live read probes (ping, dialect and append-mode reads, Hindsight and RAGFlow (retired) GETs). They are reads, not writes.
- The PLAN's `service.ts` scope grew beyond one `fabricSources()` method. This is the `/healthz` path (`service.ts:8581-8790` area).

## Human Verification Required

### 1. Live fabric tools on a deployed server

**Test:** With `RAILWAY_API_TOKEN` and the production data-plane URLs configured, call `fabric_status`, `fabric_optimize`, and `fabric_compliance` once each.
**Expected:** Nine rows in `fabric_status`; no URL, host, port, or token appears in any output; `fabric_compliance` reports the Greptime row as FAIL until a `/healthz` write verdict exists.
**Why human:** Needs live services and credentials. Operator-gated; not run here.

### 2. Dashboard render

**Test:** Load the data-planes dashboard in Grafana and check the six `Fabric:` panels.
**Expected:** Six panels with data. The extended-series panels (`Fabric: hindsight`, `Fabric: tailscale-proxy`) appear only in the all-series render.
**Why human:** Visual check against a live Grafana/Prometheus. `scripts/dashboards.test.ts` was not run in this pass.

### 3. Greptime row with write probe on

**Test:** With `SUBSTRATE_LEDGER_WRITE_PROBE_S > 0`, call `fabric_status` before and after the first `/healthz` poll.
**Expected:** Greptime row is `unavailable` before the first write verdict, then `ok` (when healthy).
**Why human:** Depends on live timing of the poller and a live Greptime.

## Gaps Summary

No blocking gaps. Both ROADMAP success criteria are met in the repository, and the fabric tests that ran pass.

Not run in this pass (and therefore not claimed): `bunx tsc --noEmit`, the full `bun test` suite, `bun run check:phase-close`, `scripts/dashboards.test.ts`, `bun run config:reference -- --check`, the Greptile review, and any live or operator-gated check. The status is `human_needed` because the live checks above are open.

---

_Verified: 2026-11-12T08:39:31Z_
_Verifier: Claude (gsd-verifier)_
