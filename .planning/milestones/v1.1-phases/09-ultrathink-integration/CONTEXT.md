# Phase 9: claude-ultrathink integration - Context

**Gathered:** 2026-10-07
**Status:** Executing
**Mode:** Auto-accepted (gsd-autonomous).

<domain>
## Phase Boundary

`claude-ultrathink` mints the Graph ID; the substrate adopts it unchanged. On `origin/main` it already fetches the brief fail-open, but `emitEvent` has no production caller. This phase adds one fail-open `note` event after a prompt is planned. Branch `feat/substrate-plan-event` from `origin/main`.

</domain>

<decisions>
## Implementation Decisions

- Event kind `note`, summary `ultrathink planned graph <id> (<n> nodes)`, payload `{ultrathink: "plan", nodes, host, skill?}`, no prompt text.
- Emitted from `runPromptSubmit` only (`src/host/plan.ts` reaches the same function, so emitting there would double-emit), after a successful session write, never for skipped prompts or unknown sessions.
- No graph registration call: registration is the kickoff skill's MCP step and the substrate deliberately has no REST door for it.

</decisions>

<code_context>
## Existing Code Insights

- `src/substrate/brief.ts` (`resolveSubstrate`, `fetchBrief`, `emitEvent`), `src/claude/hook.ts` `HookDeps.brief` seam. 2236 tests pass on the unpushed teach commit; the new branch starts from `origin/main`.

</code_context>

<deferred>
## Deferred Ideas

Hook-side graph registration (would need a REST door the ADR does not allow).
</deferred>
