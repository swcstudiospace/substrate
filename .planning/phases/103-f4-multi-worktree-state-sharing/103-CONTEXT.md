# Phase 103: F4 multi-worktree/project state sharing - Context

**Gathered:** 2026-11-28
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped — infrastructure phase)

<domain>
## Phase Boundary

SessionRegistry exposes a snapshot read API so other agents/sessions read live state across worktrees and projects in realtime, with freshness metadata and credential-safe, labeled degradation.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion
- **API shape**: read-only `session_snapshot` (session/graph/worktree → state digest + freshness + source run); no mutation surface.
- **Cross-project**: path-scoped reads honoring repo allowlist (Phase 72); secrets never cross the boundary (redactor enforced).
- **Degraded**: stale/unreachable snapshots labeled with age + reason, never presented as fresh.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/mcp-server/src/session-registry.ts` (Phase 83), repo allowlist (Phase 72), worktree fleet (Phase 68)

### Established Patterns
- Single operator via CLI; lease-holder checks; fake-only tests

### Integration Points
- F5 steering reads snapshots; consumed by CLI Agents (Omp/Grok Bot) and future cross-machine link

</code>

<specifics>
## Specific Ideas

User intent: states for multiple worktrees and projects connected together, read and understood by other agents in realtime using events.

</specifics>

<deferred>
## Deferred Ideas

None. Cross-machine transport reuses the link module (tools/substrate-link); state sync over link is v2 (F8).

</deferred>
