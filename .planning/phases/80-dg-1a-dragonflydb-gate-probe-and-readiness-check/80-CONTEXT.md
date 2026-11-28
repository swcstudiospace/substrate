# Phase 80: DG-1a DragonflyDB Gate probe and readiness check - Context

**Gathered:** 2026-11-28
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped — infrastructure phase)

<domain>
## Phase Boundary

DG-1a probe/gate DragonflyDB readiness before any E2 shared-context cache work. Deliver a deterministic readiness probe that reports whether DragonflyDB is running, healthy, and within capacity (memory/eviction), with live evidence from the VPS (docker health + L7 probe). DG-1b (implement-or-document decision) is the follow-on phase; this phase does not create the E2 cache itself.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Decisions anchored in codebase patterns:

- **Probe surface**: single `probeDragonflyReadiness()` function in `packages/mcp-server/src/fabric/` (or planes) returning a structured `{ok, reasons, metrics}` verdict. No HTTP route changes; consumed by fabric status and CLI output.
- **Readiness criteria**: (1) reachable PING→PONG on `DRAGONFLY_URL`, (2) Docker health `healthy` for `substrate-prod-dragonfly`, (3) capacity: used memory/eviction headroom (Dragonfly INFO), (4) loopback/TLS endpoint policy satisfied (reuse `loadConfig` endpoint policy), (5) `healthz` cache `connected`.
- **Fail-closed gate**: probe verdict `ok:false` blocks E2 cache enablement in DG-1b; probe never fabricates success — missing endpoint or error yields `ok:false` with reason.
- **Evidence**: live probe run recorded in `80-SUMMARY.md` (docker health + INFO) — runtime truth by probes (baseline §4).
- **DG-1b handoff**: Phase 80 SUMMARY records the gate outcome + recommendation for DG-1b (implement blocking gate vs document-only).

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/mcp-server/src/fabric/` — `buildFabricStatus` pure builders over facts (idempotent, deterministic)
- `packages/mcp-server/src/planes/dragonfly.ts` (or cache plane) — existing Dragonfly client on Bun `RedisClient`
- `packages/mcp-server/src/config.ts` — `loadConfig`, endpoint policy (`DRAGONFLY_URL`), `bootRefusal`
- `.planning/audit/baseline.md` — live probe + fabric compliance gates

### Established Patterns
- Fabric builders: pure functions over facts, deterministic, side-effect free
- `callPlane` + circuit breakers; fail-open/fail-closed per audit
- Live evidence via docker/L7, never by intent

### Integration Points
- `fabric_status` (FABRIC) — read-only view over Dragonfly resource row
- `healthz` cache `connected` state
- E2 (Phase 82) consumes the gate verdict before cache-aside enablement

</code_context>

<commentary>
## Specific Ideas

No specific requirements — infrastructure phase. Refer to `.planning/execution-plan.md` Lane A (DG-1a probe/gate + DG-1b implement-or-document; gates E2/E4) and `.planning/enhancement-design.md` (Dragonfly specialty: in-memory LM + eviction; hot shared-context cache; volatile by default — rebuild from durable stores).

</commentary>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. DG-1b decision (Phase 81) and E2 cache implementation (Phase 82) are separate phases, not deferred ideas.

</deferred>
