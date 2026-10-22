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
- D53-g.1 (2026-10-22). Amends D53-g to the phase 53 success criterion 2, which reads "two sessions touching the same parsed phase or plan id emit a conflict event" (quoted in VERIFICATION.md, criterion 2). Two or more known, active sessions that share a parsed plan id under different active phases produce one open event for that plan id, naming the phases. Same-phase keying is unchanged. A plan id shared inside one phase is covered by that phase's event and gets no second event. D53-g is kept as written.
- D53-j (2026-10-22). A conflict event is `kind: "warning"` on the `substrate` surface, with payload `kind: "planning.conflict"`. `EVENT_KINDS` is unchanged (phase 17). Summary and payload are redacted; the repo is named only when the origin is known. A conflict is announced once while it stays open. A conflict that stops being detected leaves the open set, so its return is announced again. A conflict the ledger did not store is retried on the next read.
- D53-k (2026-10-22). The detector reads the presence snapshot (PLAN W5). Each session's planning report rides in its presence record as the optional `planning` field: `known`, with the phases its index holds and the plan ids under each, or `unknown`, with a reason. A checkout writes its report on each `planning_status` read. `planning_sessions` judges each report against the server clock. A report older than the presence TTL is `scan-stale` (D53-h). A record with no report is `no-scan`.
- D53-l (2026-10-22). A watcher gap is an incomplete observation: a truncated index, or one with unlisted directories. It makes the report unknown (`scan-truncated` or `scan-unlisted`) and is held by the reader. A complete scan clears it. A failed scan keeps an open gap, since it proves nothing either way. The phase 52 observer already publishes nothing from a partial scan.
- D53-m (2026-10-22). Checkpoints are durable when `SUBSTRATE_PLANNING_CHECKPOINT_DIR` names an absolute directory. The store is one append-only file, `completions.jsonl`, with one JSON record per line. Each insert rewrites the file through a temporary file in the same directory: write, fsync, rename, then fsync the directory. Opening loads every key and refuses a corrupt file or a repeated key. One process writes a directory at a time; no cross-process lock is taken. Unset means in memory, and `planning_status` reports `durable: false` with `checkpoint-dir-unset`.
- D53-n (2026-10-22). Sessions carry their touched phases and plans, so conflicts occur in production. Each presence record
  carries `touched`, a list of `{phase, plan, observedAtMs}`. `plan` is null for a document that names none. The observer
  derives it from each complete observation: for each document the scan added or changed, the phase and plan are read from
  that scan's index; for each document it removed, they are read from the baseline the removal left. Each pair is dated by
  the server clock and kept in the checkout's process-local state, and written on each heartbeat. A complete change to a
  document the checkout already touched re-dates its pair. A pair stays while `now - observedAtMs <= TTL`, where the TTL is
  the presence freshness window (`SUBSTRATE_PLANNING_PRESENCE_TTL_S`). A later complete change to other documents keeps it.
  Detection counts a session's pairs only while they are inside the TTL, so an older pair does not conflict even while its
  record is still held. An incomplete observation adds nothing and removes nothing (the gap rule). A complete change that
  would take the list past `MAX_REPORT_ENTRIES` is not cut: the report reads `report-limit` until a complete change fits.
  A complete change the server clock cannot date records nothing. A change that starts inside a watcher gap is not recorded,
  because the first complete diff after a gap is withheld, as the event is. The active phase is no longer a claim: D53-g and
  D53-g.1 read "active phase" as the touched phases this decision defines. `activePhase` on the record is kept and stays null.

## Acceptance mapping

- Audit order, retry, held-on-failure, authorisation, rate limit, confirm rule and env parsing:
  `steering.test.ts`.
- Conflict keying, one event per phase, no auto-resolve, unknown views and the write gate: `conflicts.test.ts`.
- Completion key, idempotent recording, resume after a changed hash: `checkpoint.test.ts`.
