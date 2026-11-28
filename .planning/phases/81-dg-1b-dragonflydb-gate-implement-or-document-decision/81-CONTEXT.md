# Phase 81: DG-1b DragonflyDB Gate implement-or-document decision - Context

**Gathered:** 2026-11-28
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped — infrastructure phase)

<domain>
## Phase Boundary

DG-1b implement-or-document decision grounded in DG-1a's probe verdict. Phase 80 built the probe (`probeDragonflyReadiness` → ok/degraded/unavailable/unconfigured, fabric row + healthz body). Phase 81 implements enforcement for E2/E4 work (block enablement on unavailable/unhealthy) or documents why enforcement stays advisory. No E2 cache feature itself (Phase 82).

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
All implementation choices are at Claude's discretion — pure infrastructure phase. Decisions anchored in codebase patterns:
- **Implement (not document-only)**: DG-1a gate is `ok` on the shipped probe (docker healthy 2026-11-28, fakes green). Enforcement is cheap and correct: a `SUBSTRATE_DRAGONFLY_GATE` flag (`off` default? — see below) plus a synchronous `dragonflyGateVerdict()` consulted by `ReadThroughCache` enablement. Chosen: **enforce with fail-open default off** — when the flag is `enforce` and the verdict is `unavailable`/`unconfigured`, the E2 cache consumer reads durable (no cache serving); when `off`, today's behavior is unchanged (advisory only).
- **Flag registration**: register `SUBSTRATE_DRAGONFLY_GATE` in `flag-registry.ts` + `config.ts` + `.env.example` (registered-flag path; flag-registry discipline — verify with grep at execution).
- **Non-blocking**: cache-off is valid (baseline §8). Enforcement never throws/503s; degraded still serves (headroom/eviction only degrades).
- **SUMMARY** records the implement choice + DG-1b rationale + live verdict snapshot.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 80: `fabric/dragonfly-readiness.ts` (`probeDragonflyReadiness`, verdict type), `service.ts:9548 dragonflyReadiness()`, `gather.ts` probe source, `server.ts:1034 healthz cache.readiness`
- `flag-registry.ts` + `config-reference.test.ts` / `flag-registry.test.ts` — registered-flag discipline
- `createReadThroughCache` in `cache.ts` — enablement point

### Established Patterns
- Flags default off; strict TS (no any/non-null); tests fake-only (no live server)

### Integration Points
- E2 (Phase 82) consumes `dragonflyGateVerdict()`; fabric/healthz unchanged this phase

</code_context>

<specifics>
## Specific Ideas

Refer to `.planning/execution-plan.md` Lane A (DG-1b gates E2/E4) and `80-SUMMARY.md` § DG-1b recommendation (E2 only behind green `ok`; `unavailable` blocks; `degraded` names follow-up).

</specifics>

<deferred>
## Deferred Ideas

None. E2 cache implementation is Phase 82.

</deferred>
