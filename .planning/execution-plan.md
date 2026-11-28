# Execution plan (Wave 5, SPE-39535) — Wave 7→8 follow-on

## Order (dependency-respecting)
1. **Lane A — DG readiness** (unblocks E2 cache + cross-resource degradation proofs): DG-1a probe/gate + DG-1b implement-or-document. Decide FIRST; it gates E2/E4 work.
2. **Lane B — E2 Dragonfly shared-context cache**: cache-aside, TTLs, Lua atomic slots; fallback tests.
3. **Lane C — E1 Live Steering multi-worktree**: SessionRegistry + live-session bindings; single-operator CLI.
4. **Lane D — E3 unified memory fabric + E6 episodic**: Hindsight bank owner; LightRAG provenance-only.
5. **Lane E — E4 orchestration handoffs + E7 Leader fencing**: namespace + permission model, TTL queueing, dead-letter surfacing.
6. **Lane F — E5 observability + E8 replay/audit**: correlation IDs, dashboards/alerts; append-only audit with replay-to-checkpoint.

## Parallel lanes: A, B, C concurrent; D after B; E after C; F last.
## Gate at each step: live probe green + `bun run verify` + fabric compliance PASS.
## Deferred: nothing — all 8 enhancements scoped; Leader version/image confirmation is a discovery task within Lane A (not a blocker for others).
