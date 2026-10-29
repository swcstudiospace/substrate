---
phase: 53-steering-conflict-control
requirements: [SOTA-09]
status: core tasks done on gsd/p53-steering-core; wiring tasks W1-W5 wait for phase 51 and phase 52 wiring
---

# 53-PLAN: steering inbox, conflicts and checkpoints

## Tasks (done in this phase)

- T1. `planning/steering.ts`: strict directive schema, human-only allowlist, audit-before-effect with two
  attempts, held on failure, per-session token bucket, confirm rule for conflicting plans, env loader
  with typed errors. `SUBSTRATE_PLANNING_STEERING` parsed, default off, not registered.
- T2. `planning/conflicts.ts`: pure detector keyed on parsed phase and plan ids; one open event per
  conflicting phase; unknown views for missing, failed, truncated, unreadable or stale scans; write gate.
- T3. `planning/checkpoint.ts`: `sha256(phase, step, fileHash)` key, `CompletionStore` port with
  `putIfAbsent`, in-memory store, idempotent `recordCompletion`, pure `planResume`.

## Acceptance

- Each module has a test beside it, asserting behaviour only, on deterministic fakes.
- The steering module imports no filesystem module and writes nothing.
- No edit to `mcp.ts`, `server.ts`, `packages/audit/src/policy.ts`, `flag-registry.ts`, `ROADMAP.md` or `STATE.md`.

## Wiring (later)

- W1. A TimescaleDB history table implementing `SteeringHistorySink`. Migration needs operator approval.
- W2. A durable directive store behind `SteeringInbox`, with the same audit-before-effect order.
- W3. Register the steering tools in `mcp.ts`, reading `loadSteeringSettings(process.env)`, gated on `enabled`.
- W4. Policy entries in `packages/audit/src/policy.ts`, and a flag-registry row for the four steering variables.
- W5. Feed `detectConflicts` from the phase 52 presence snapshot and per-session index scans.
