# Phase 104: F5 Live Session Steering injection v2 - Context

**Gathered:** 2026-11-28
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped — infrastructure phase)

<domain>
## Phase Boundary

Event-driven TODO injection into live sessions (Omp steering): subscription filters select steering-worthy events; injections are idempotent and ordered per session; failures visible with retry; never duplicates.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
- **Filters**: per-session subscription (event kinds + path/graph scope); default-off for noise (explicit opt-in per session).
- **Idempotency**: injection keys (event id + session id) deduped; ordering by (occurred_at, seq) per session.
- **Builds on**: existing steering path + Phase 83 registry + Phase 77 keyed idempotency; no new coordination store.
- **Safety (enterprise hardening)**: allowlisted TODO mutations + size limits; validation for instruction-injection; consent-gated auto-apply (default propose-only); one-step revert + audit trail; per-session rate limit + kill switch; loop guards against self-triggering steers.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- Steering paths (Phase 58/67), `session-registry.ts`, steering idempotency keys (Phase 77), Phase 102 refresh events as a source

### Established Patterns
- Keyed commands, fail-open reads, per-agent audit (Phase 85 precedent)

### Integration Points
- F7 proves the loop end-to-end

</code>

<specifics>
## Specific Ideas

User intent: Omp injects updates into sessions' TODOs using events — improve it now that repos are ingested and states update in realtime.

</specifics>

<deferred>
## Deferred Ideas

None. Fair-queue priorities beyond TTL expiry stay deferred (Wave 8 decision).

</deferred>
