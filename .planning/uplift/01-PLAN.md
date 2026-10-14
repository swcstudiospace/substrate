# Uplift 01 PLAN — Gate verdicts as events (ADR S5, SPE-5056)

**Graph:** `ut-mv5r71hp-65f7b012` · **Proposal:** `.planning/UPLIFT_PROPOSAL.md` §U5 · **Refs:** SPE-10477 (execution), SPE-5056 (recorded goal)

## Scope (files)

- `packages/mcp-server/src/memory-write.ts` — emit one event per governance verdict
- `packages/mcp-server/src/event-sources.ts` — register the new event-source rows
- `packages/mcp-server/src/memory-write.test.ts` — verdict→event tests
- `packages/mcp-server/src/event-sources.test.ts` — row coverage follows the existing pattern

## Change

1. Where `memory-write.ts` finalizes a gate verdict, emit one event, following the `memory-retain.ts` emission idiom (same deps-injected emit, `surface` = the writer's surface, `session_id` threaded like retain does):
   - `accepted` → `kind: "note"`, summary `memory write accepted: <subject>`
   - `conflict` → `kind: "note"`, summary `memory write conflict: <subject> (<reason>)`
   - `quarantined` → `kind: "warning"`, summary `memory write quarantined: <subject>`
   - `denied` → `kind: "warning"`, summary `memory write denied: <subject>`
   - `payload: { action: "memory.write", verdict, reason?, kind: <memory kind>, scope }` — never the entry text, never the full body; `subject` is an identifier and is allowed.
2. `event-sources.ts`: add rows for the four verdict events (note ×2, warning ×2), `surface: "caller"` convention matching the `skills.propose` rows, `runtime` unset, `carriesRepo: false`, `periodic: false`. Include write-path-proof samples shaped like the existing rows.
3. Tests:
   - `memory-write.test.ts`: for each verdict, assert the emitted event's `kind`, `payload.verdict`, `payload.action === "memory.write"`, and that the serialized event does **not** contain the written text (leak test, mirroring the mcp.test.ts `not.toContain("worth keeping")` precedent).
   - `event-sources.test.ts`: extend the existing table-driven pattern for the new rows.
4. No changes to `types.ts` EVENT_KINDS/SURFACES (vocabulary is closed; the emit uses existing kinds `note`/`warning` and the caller's existing surface).

## Acceptance (orchestrator-verified; subagent edits only, no gates)

- `bun run check:phase-close` green (EVENT_SOURCES coverage vs. emit sites)
- `bun test packages/mcp-server` green including new tests
- `bunx tsc --noEmit` clean
- `bun test` full suite no new failures beyond the recorded F-01
