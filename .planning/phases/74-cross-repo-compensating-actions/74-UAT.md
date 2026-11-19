# Phase 74 UAT — Cross-repo compensating actions

**Phase:** 74-cross-repo-compensating-actions
**Date:** 2026-11-19
**Status:** human_needed (operator gate only)
**Verification:** 74-VERIFICATION.md (3/3 SC verified; SC1 route now exists — prior module-only decision closed)

code review skipped (Greptile unavailable, owner override 2026-11-19 — CI gates apply)

## Owner decision (closed)

Prior human_needed item — "Decide whether module-level delivery satisfies SC1's 'actual operation' wording, or require an operator-visible route/MCP tool first" — is **closed**. Production route and MCP tools exist and wire to `runBranchFanout` (`server.ts:1843`, `service.ts:6974`, `mcp.ts:1681`, `admission.ts:216`, `route-policy.ts:35`). No owner decision remains on SC1.

## Open operator gate

### 1. Migration step 43 rehearsal

**Test:** Rehearse migration step 43 (`cross_repo_operations`, `cross_repo_steps` in `packages/mcp-server/src/index-store.ts`) on a restored dump before production, as steps 33 to 42 were.

**Expected:** Migrate up and down on the restored copy with no error; existing row counts unchanged.

**Why human:** Operator-gated live-data check (74-01-SUMMARY remaining gate 2). Not runnable from the verification workspace against production; production migrations are an operator stop-gate.

**Resume command:** Operator on a quiesced host with a restored dump: run the index-store migrate up then down against the restored copy, confirm no error and unchanged row counts, then record the result here and in ROADMAP/REQUIREMENTS (which still say "Not started"/PARTIAL and need reconciling).

## Sign-off

- [ ] Operator rehearsal recorded (date, dump source, up/down result, row counts)
- [ ] ROADMAP.md / REQUIREMENTS.md HARD-R1 status reconciled
