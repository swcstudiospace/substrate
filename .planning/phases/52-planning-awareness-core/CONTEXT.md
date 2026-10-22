---
phase: 52-planning-awareness-core
requirements: [SOTA-08]
status: core implemented on gsd/p52-planning-core; wiring waits for phase 51
---

# 52-CONTEXT: planning index, session presence and change diffs (file-first)

## Scope

The planning plane core, in `packages/mcp-server/src/planning/`. It is a library: an index of
`.planning/`, a diff between two indexes, session presence, and a planning-change event. No MCP
tool, flag, or policy entry is added here. Those are wiring steps after phase 51.

## Decisions

- D52-a. Files are authoritative. The index is built from `.planning/` on disk, and nothing in the
  index is a source of truth for the files.
- D52-b. TimescaleDB holds the planning index and the session history. The history sink is
  append-only; this module never truncates it.
- D52-c. Dragonfly holds presence and cache only. Presence is one key per session with the server's
  own expiry. Nothing else goes there.
- D52-d. GreptimeDB holds events. A planning change is an event on the existing vocabulary (kind
  `note`, surface `substrate`). No kind is added.
- D52-e. Configuration is environment only, with documented defaults. `SUBSTRATE_PLANNING_ROOT`
  unset means disabled, with no default path.
- D52-f. Steering (acting on another session's planning state) is out of scope until phase 53.
- D52-g. No writes into any `.planning/` directory, this checkout's or another session's. The
  index walk is read-only, and symlinks that resolve outside the root are refused.
- D52-h. Presence expiry is the server's TTL on Dragonfly. The adapter reads no host clock for
  expiry, and it cannot report "stale": an expired session is absent.

## Acceptance mapping

- Index: same files, same hashes and order (`index.test.ts`); one bad file is one error record and
  the rest is intact; symlinks outside the root are refused (`index.test.ts`, `fs.test.ts`).
- Diff: add, change, remove by path and hash only, no bodies (`diff.test.ts`).
- Presence: a session past its TTL is stale and still listed; history is never truncated
  (`presence.test.ts`, `presence-dragonfly.test.ts`).
- Events: the payload never holds file text; the summary and payload are redacted (`events.test.ts`).
- Config: an unset root is disabled; malformed numbers are typed errors (`config.test.ts`).

## Fix-up decisions

Recorded by the fix-up pass on criteria 1, 3 and 4 (SOTA-08). `VERIFICATION.md` and `SUMMARY.md` belong to the verifier and are not edited here.

- **Index key (C1).** The index is keyed by content. `contents[sha256]` holds a document's size, its parsed frontmatter and `paths`, every document path whose bytes hash to that key. `documents[path]` names its content by sha256 and carries its kind, phase, plan and stat fingerprint. `errors[path]` holds the error records. Identical bytes at two paths share one content entry. The record view (`indexRecords`) is derived from these maps and sorted by path, so the output is deterministic.
- **Incremental rule (C1).** `updatePlanningIndex(root, deps, previous)` reuses a document's content only when all of these hold: the descriptor's stat fingerprint (device, inode, size, and mtime and ctime in nanoseconds) equals the one stored; the stored content is no larger than the current `maxBytes`; and the previous index holds that content. The fingerprint is read from the same descriptor as the bytes, before any byte is read, so an unchanged document is neither read nor hashed. Every other document is read and hashed exactly as a full rebuild does. Equality with `buildPlanningIndex` is tested after an add, an edit and a delete.
- **Residual, index.** A same-size edit that lands within the filesystem's timestamp resolution after the previous scan keeps the stored fingerprint, so it is not seen until the next write changes ctime. Nanosecond timestamps make the window negligible on the Linux filesystems this runs on.
- **Diff and event (C3).** Each changed path carries `{ path, before, after }`: an added path has `before: null`, a removed path has `after: null`, and a changed path carries both sha256 values. An unreadable side is null. The payload lists these objects and never text; the redactor and the ledger budget apply as before. The bus hint keeps its six fields and carries no paths. The event kind is unchanged.
- **Presence source (C4).** The heartbeat comes from the observer (`observer.ts`, `PlanningObserver`), not from a read and not from a new tool or event kind. The observer runs on a fixed timer started at boot (`Substrate.startPlanning`) and cleared at shutdown. It heartbeats a checkout only when it has observed a complete change in that checkout, so a session is `active` for the freshness window after its last planning change. Why this source: the observer is already the only code that sees changes, and it keeps the reads free of writes. Correction to the brief: no server-side observer existed before this fix. `observePlanningChange` ran only inside the read path, and nothing scheduled a scan. The scheduler is new in this fix.
- **Scan cadence.** A fixed constant, `PLANNING_SCAN_INTERVAL_MS = 15_000`, not an environment setting. A scan is incremental (stat, and no re-read of an unchanged document), so a fixed cadence is cheap, and a new knob would need a documented default that no operator has a reason to change. The timer is unref'd.
- **Ledger note (C4).** The `planning.changed` note moved from `planning_status` to the observer's publish path. Its content is unchanged: one note per complete change, surface `substrate`, session `planning-observer`, through `Substrate.emit`. A read writes no note now, and the read view no longer carries a change state. A change that cannot be published (`not-published`) holds the baseline and is published on the next scan.
- **Read tools (C4).** `planning_status` and `planning_sessions` write nothing on any call. The reader holds no state and performs a full index build on every status read, with no cache. `read.test.ts` records zero writes on the first and on a repeated call against a recording presence backend. `observer.test.ts` shows the observer path still heartbeats an observed change. The `mcp.ts` descriptions and the audit policy comment now say what the code does.
- **Residual risk (SC2).** Dragonfly `EX` expires a session key at retention, which is the largest freshness window (86400 s) plus the one-hour margin: about 25 h after its last heartbeat. That is server-side key retention, not a code deletion; the code still never deletes a key. A session silent for longer than the retention drops out of `planning_sessions`. The TTL is not changed.
- **Unchanged.** The `worktree` field of a session still carries the absolute checkout path, and the process-local baseline still resets on restart. The TimescaleDB history sink stays operator-gated.
