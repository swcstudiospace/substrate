---
phase: 53-steering-conflict-control
requirements: [SOTA-09]
status: core implemented on gsd/p53-steering-core; wiring waits for phase 51 and the phase 52 wiring
---

# 53-CONTEXT: steering inbox, conflict detection and completion checkpoints

## Scope

The steering core, in `packages/mcp-server/src/planning/`. It is a library: an audited steering inbox,
a pure conflict detector over active sessions, and idempotent completion checkpoints with resume. No
MCP tool, flag registration, policy entry, migration or file write is added here. Those are wiring
steps.

## Decisions

- D53-a. Steering is human-only by default. An agent-kind author is always refused. A human author must
  be on the allowlist from `SUBSTRATE_PLANNING_STEERING_PRINCIPALS`; an empty allowlist refuses everyone.
- D53-b. The audit precedes the effect. Every `queued` and `acknowledged` transition is appended to the
  history sink before it takes effect, with a bounded retry of two attempts. If both fail, the directive
  is held: nothing is queued, or an acknowledgement leaves the directive queued.
- D53-c. The steering module never writes files. Records are held in memory. The TimescaleDB history
  table that implements the sink, and the durable directive store, are later steps. Production migration
  needs operator approval.
- D53-d. A directive that conflicts with the target's active plan cannot be acknowledged as `applied`
  without `confirm: true`. Declining needs no confirm.
- D53-e. Each target session has a token bucket, defaulting to ten directives per minute, driven by the
  injected clock. Refused directives are neither queued nor audited.
- D53-f. The enable flag `SUBSTRATE_PLANNING_STEERING` defaults to off. It is parsed, typed, and not
  registered anywhere in this phase.
- D53-g. Conflicts are keyed on the parsed `phase` and `plan` fields of index records, never on paths.
  Two or more known, active sessions on one phase produce one open event that names the phase and the
  plans they share. Nothing is auto-resolved.
- D53-h. A session whose planning view is unknown (no scan, failed scan, truncated scan, unreadable
  record, or a scan older than the threshold) is excluded from detection. Its conflict-sensitive writes
  are refused until a later full scan completes.
- D53-i. A completion is keyed by `sha256(phase, step, fileHash)`. Recording is idempotent. Resume skips
  completed steps and re-runs a step whose file hash changed, flagged; the resume planner writes nothing.

## Acceptance mapping

- Audit order, retry, held-on-failure, authorisation, rate limit, confirm rule and env parsing:
  `steering.test.ts`.
- Conflict keying, one event per phase, no auto-resolve, unknown views and the write gate: `conflicts.test.ts`.
- Completion key, idempotent recording, resume after a changed hash: `checkpoint.test.ts`.
