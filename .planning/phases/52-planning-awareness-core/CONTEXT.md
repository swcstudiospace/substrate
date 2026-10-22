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
