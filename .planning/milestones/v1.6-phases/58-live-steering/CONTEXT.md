---
phase: 58-live-steering
milestone: v1.6
requirements: [SOTA-14]
discussed: 2026-10-26
status: implemented on gsd/v16-58-live-steering (7edfd79) on top of the unmerged draft stack; partial (criterion 2); not merged
---

# 58-CONTEXT: Live session steering for multi-day GSD-Core sessions

## Goal

Steering directives are durable, are delivered to the target session and are tied to GSD-Core's position, and sessions that run for days stay alive: liveness is decoupled from planning changes and state survives restarts. The roadmap block is ROADMAP.md, Phase 58.

## Why this phase is on another branch

The planning index, session presence, the steering inbox and the `planning_steering_audit` table exist only in the unmerged draft PRs #104, #109, #110 and #111 (phases 52 to 54, on operator Hold). Phase 58 therefore lives on `gsd/v16-58-live-steering` in `/root/src/worktrees/as-v16-58`: commit 7edfd79 on the PR #110 head f1ae7de plus the dependency fix ed61286 (which clears three audit advisories the draft base carried). It cannot land before that stack merges. `gsd/v16-int` contains none of its code.

## Locked decisions

- **DragonflyDB is cache-only (owner decision 2026-09-26).** It carries wake-up hints and ephemeral presence; the durable authority is TimescaleDB plus the ledger. A directive queue in Dragonfly was rejected (D55 correction 3).
- **The durable record is the append-only `planning_steering_audit` table**, which the inbox is rebuilt from at boot; a restore never writes audit rows.
- **Opt-in migration numbering.** Step 33 (the audit table) comes from the draft; phase 58 adds opt-in step 34 (a nullable `reason` column) on its own branch. `gsd/v16-int` adds no index step.
- **Directive bodies never ride hints or ledger notes.** A queued directive publishes one body-free hint note.
- **Join of the two steering mechanisms is deferred to merge time.** The state machine `docs_steering_session` is on main (PR #112), not on the draft branch; the adapter that implements phase 58's state port over it was not written here.

## Links

- Branch: `gsd/v16-58-live-steering`, `/root/src/worktrees/as-v16-58`, commit 7edfd79
- Code (on that branch): `packages/mcp-server/src/planning/{steering-store,steering,steering-delivery,presence,presence-dragonfly,observer,baseline-store,position,read,index}.ts`, `service.ts`, `mcp.ts`
- New env there: `SUBSTRATE_PLANNING_STEERING_ACK_TTL_S`, `SUBSTRATE_PLANNING_STEERING_EXPIRY_SWEEP_S`, `SUBSTRATE_PLANNING_BASELINE_DIR`, `SUBSTRATE_PLANNING_LIVENESS_INTERVAL_MS` (registered and documented there)
- Proposal for the checkpoint trigger on a steering event: `docs/adr/0007-checkpoint-triggers-and-sibling-hooks.md`
- Discovery: `../55-migration-safety/CONTEXT.md`
