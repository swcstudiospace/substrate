# Phase 67: Live Steering GA - Context

**Gathered:** 2026-10-29 (Run 14)
**Status:** Decisions fixed by the orchestrator from the Run 14 scout evidence; the owner's request is in `.planning/STATE.md` (Run 14).

## Phase boundary
Make the v1.6 steering visible and usable, and add the missing cross-session context. Agents still do not author directives.

## Decisions
- **D67-1 (what exists):** two mechanisms share the session registry. `docs_steering_session` stores a state machine (ACTIVE, CONTEXT_REFRESH, PAUSED, RESUMED) per surface and session in process memory, capped at 1000, with no TTL (`planning/session-state.ts:26,32`, `mcp.ts:1587-1661`). The directive inbox (`steering_queue`, `steering_acknowledge`, `steering_list`, registered only while `SUBSTRATE_PLANNING_STEERING` is on, `mcp.ts:2308-2371`) takes human authors on the allow-listed principals, 10 per minute per target session, and is durable only with `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE`.
- **D67-2 (what is missing, with evidence):** there is no CLI command (`cli/src/index.ts:629-731`) and no REST route for steering or planning in `server.ts`; delivery is pull-only through `docs_search` with a `session_id`; `memory_brief` has no steering, handoff or planning section (`brief.ts:312-426`); presence is per server checkout, not per agent session (`planning/checkout.ts:13`); `checkpoint_hint` has no reader (STATE.md:210); no hook is installed in any host; the phase 58 SUMMARY says delivery to a real session was never run.
- **D67-3:** the context digest is built from sources that exist: presence records (session, worktree, branch, repo, heartbeat: `planning/presence.ts:64-89`), graph claims (`graph_nodes` holder and lease), recent ledger events, `coord_handoff_list` (`mcp.ts:1828,1904`) and `planning.changed` notes. It is bounded and redacted, and every line carries its source and age.
- **D67-4:** session state moves to a Postgres table only behind an opt-in flag, following the precedent of `planning_steering_audit`; Dragonfly stays cache-only by the owner's decision (`cache.ts:6-7`).
- **D67-5:** operator-only directive authorship, the rate limit and the audit-before-queue order do not change.

## Canonical references
`docs/coordination.md`, `docs/runbooks/session-rollback.md`, `.planning/milestones/v1.6-phases/58-live-steering/`, `packages/cli/src/session/` (hooks), `packages/mcp-server/src/planning/steering*.ts`
