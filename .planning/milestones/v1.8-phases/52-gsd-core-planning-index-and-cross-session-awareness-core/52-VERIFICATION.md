---
phase: 52-gsd-core-planning-index-and-cross-session-awareness-core
verified: 2026-11-18T12:22:38Z
status: passed
score: 6/6 must-haves verified
behavior_unverified: 0
overrides_applied: 0
covered_files: [".env.example", ".planning/milestones/v1.5-phases/52-planning-awareness-core/CONTEXT.md", ".planning/milestones/v1.5-phases/52-planning-awareness-core/PLAN.md", ".planning/milestones/v1.5-phases/52-planning-awareness-core/SUMMARY.md", "docs/config-reference.md", "packages/audit/src/policy.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/planning/config.ts", "packages/mcp-server/src/planning/diff.ts", "packages/mcp-server/src/planning/events.ts", "packages/mcp-server/src/planning/fs.ts", "packages/mcp-server/src/planning/index.ts", "packages/mcp-server/src/planning/observer.ts", "packages/mcp-server/src/planning/presence-client.ts", "packages/mcp-server/src/planning/presence-dragonfly.ts", "packages/mcp-server/src/planning/presence.ts", "packages/mcp-server/src/planning/read.ts"]
covered_digest: "v3:sha256:09164d477142bbb76219477b01af45ea7bab4e04b7eb1e1c7caafc410810e27d"
---

# Phase 52: GSD-Core planning index and cross-session awareness core — Verification Report

**Phase Goal:** Agents see other sessions' `.planning` state through the substrate, read-only and file-first: no session writes into another session's `.planning`, and every backing service is optional with a file-only fallback.
**Verified:** 2026-11-18T12:22:38Z
**Status:** passed
**Re-verification:** No — initial verification of this phase directory. A prior verification record exists at `.planning/milestones/v1.5-phases/52-planning-awareness-core/VERIFICATION.md` (2026-10-28, main at 31a9bb36). This record re-reads the code at branch head `357d6b15` (branch `gsd/autonomous-rerun`) and does not rely on that record's claims.

**Scope of checks:** Code was read directly. Five targeted named tests were run one at a time, not the suite. Nothing outside this file was edited, and no commit was made.

## Goal Achievement

### Observable Truths (ROADMAP success criteria)

| # | Truth (ROADMAP SC) | Status | Evidence |
|---|---|---|---|
| 1 | Deterministic index of `.planning` artifacts keyed by content hash; full rebuild equals incremental result | ✓ VERIFIED | `packages/mcp-server/src/planning/index.ts:97` `contents: Record<string, PlanningContent>` keyed by sha256; `:99` `documents` names content by sha256; `:230` `buildPlanningIndex` (full rebuild); `:239` `updatePlanningIndex` reuses a document only when its stat fingerprint, stored size and held content all still match (CONTEXT C1); `:316` `indexRecords` sorted by path. Test `packages/mcp-server/src/planning/index.test.ts` "after an add, an edit and a delete, the incremental result equals the full rebuild each time" run: **1 pass, 0 fail**. |
| 2 | Session presence uses a server-time TTL; stale session derived at read time, never deleted | ✓ VERIFIED | Server clock: `presence-dragonfly.ts:98` heartbeat stamped `lastHeartbeatMs: await this.backend.serverTimeMs()`; `presence-client.ts:129-131` `serverTimeMs` issues Redis `TIME`. Read-time derivation: `presence.ts:137` `classifySessions`, `:143` `status: ageMs > ttlMs ? "stale" : "active"`; `read.ts:233` classifies on each read. Store `presence.ts:113`/`:192` `list()` returns held records unfiltered by age; `presence-dragonfly.ts:124` `list()` throws rather than truncating. No delete/unlink/remove call exists in the presence, observer or read path (grep). Test "a session past its freshness window is stale with its age, and a fresh one is active" (`read.test.ts`) run: **1 pass, 0 fail**; it asserts the stale session is returned, not removed. Residual, not a code deletion: Dragonfly `EX` expires the key at `presenceRetentionS` (`presence-dragonfly.ts:58`), recorded in CONTEXT D52 "Residual risk (SC2)". See Advisory. |
| 3 | Planning-change diffs publish on the existing event bus carrying paths and hashes, never bodies | ✓ VERIFIED | `events.ts:61` `planningChangeEvent` payload is `{kind, repo, sessionId, added, removed, changed, truncated?}`, where each entry is `{path, before, after}` sha256 with no file text; `:102` `kind: "note"`, `surface: "substrate"` (existing vocabulary; `types.ts:69` `EVENT_KINDS` is the frozen 12-entry list, `note` included, no new kind). `:23` `MAX_EVENT_PATHS = 100`; budgeting against `MAX_PAYLOAD_BYTES`. `:121` `busPublisher` forwards only the `v, id, kind, surface, graph_id, ts` hint fields. Production wiring: `service.ts:1839` observer `emit` = `this.emit(event, { replay: true })`; `service.ts:2823` `if (result.stored) this.publishHint(result.event)`; `service.ts:2832` `publishHint` builds a six-field hint. Tests "no file text reaches the event" and "the bus receives only the six hint fields: the summary and payload never cross" (`events.test.ts`) run: **both pass, 0 fail**. |
| 4 | Read-only MCP tools `planning_status` and `planning_sessions` exist, each with an entry in `packages/audit/src/policy.ts` | ✓ VERIFIED | `packages/mcp-server/src/mcp.ts:2422` registers `planning_status` (`readOnlyHint: true`, handler `substrate.planning.status()`); `:2438` registers `planning_sessions` (`readOnlyHint: true`, handler `substrate.planning.sessions()`). `packages/audit/src/policy.ts:98-99` lists both in the phase 52 read-only, fail-open block. Reads write nothing: `read.ts` holds no state; grep finds no write, rename, unlink or mkdir in `fs.ts`, `index.ts`, `read.ts`, `observer.ts` or `checkout.ts`. Zero-write behaviour is covered by the `read.test.ts` tests for the read path. |
| 5 | File-only mode works with every backing service disabled | ✓ VERIFIED | Presence is optional: `service.ts:1821` `planningPresence` is `productionPresence(config)`, which returns `null` when no Dragonfly URL is set or the URL is refused (`service.ts:1444-1447`). With `presence: null`, `read.ts:209` answers `{state:"unavailable", code:"presence-backend-unset"}`, while `status()` still returns `state: "ok"` from the file index (`read.test.ts` "a truncated index says so and holds the first documents by path" runs with `presence: null` and asserts ok). Test "with no cache endpoint, sessions answer unavailable with presence-backend-unset" (`read.test.ts`) run: **1 pass, 0 fail**. Observer with `presence: null` and no cache endpoint: `observer.test.ts:2297` "with no cache endpoint there is nothing to write, and the scan says so". Event bus optional: `service.ts:2833` `if (bus === null) return`. Metrics fall back to stdout: `observer.ts:483` `fallback ?? stdoutMetricSink()`. Liveness disabled when no presence: `service.ts:1854`. Root unset means disabled, nothing read (`config.ts` header; `read.test.ts:109`). |
| 6 | All configuration environment-only, documented defaults, no hardcoded hosts/ports/paths | ✓ VERIFIED | `planning/config.ts:12-16` env names (`SUBSTRATE_PLANNING_ROOT`, `_PRESENCE_TTL_S`, `_MAX_FILES`, `_MAX_BYTES`, `_SCAN_INTERVAL_MS`); `:18-22` defaults 90 s, 500, 262144, 15000 ms; `PLANNING_BOUNDS` for each; malformed values produce typed errors naming the key only (`planningConfigWarnings`). Documented: `docs/config-reference.md:128-133` lists all five with defaults and bounds; `.env.example:1114-1119` lists them. Hardcoded-host grep over the non-test planning files (`localhost`, `127.0.0.1`, `redis://` with ports, absolute home paths): **no hits**. Root has no default path (unset `PLANNING_ROOT_ENV` means disabled). |

**Score:** 6/6 truths verified (0 present-but-behavior-unverified, 0 overrides)

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/mcp-server/src/planning/index.ts` | Content-hash index, full and incremental builds | ✓ VERIFIED | Substantive (scan, incremental, records, positions); wired via `read.ts` and `observer.ts`. |
| `packages/mcp-server/src/planning/presence.ts` | Presence model, classification at read time | ✓ VERIFIED | `classifySessions`, `PresenceStore`, append-only `InMemoryHistorySink`. Wired into `read.ts`, `observer.ts`. |
| `packages/mcp-server/src/planning/presence-dragonfly.ts` | Server-time heartbeat, retention key | ✓ VERIFIED | Uses `TIME` through `presence-client.ts`; `EX` retention via `presenceRetentionS`. Wired at `service.ts:1821`. |
| `packages/mcp-server/src/planning/events.ts` | Hash-only planning.changed event | ✓ VERIFIED | Event builder, publisher, observe-and-baseline logic. Wired via `observer.ts:408` and `service.ts:1839`. |
| `packages/mcp-server/src/planning/config.ts` | Env-only settings with defaults | ✓ VERIFIED | Five env names, bounds, typed errors. |
| `packages/mcp-server/src/mcp.ts` | `planning_status`, `planning_sessions` tools | ✓ VERIFIED | Registered at `:2422` and `:2438`. |
| `packages/audit/src/policy.ts` | Policy entries for both tools | ✓ VERIFIED | `:98-99`. |
| `docs/config-reference.md`, `.env.example` | Documented config | ✓ VERIFIED | `docs/config-reference.md:128-133`; `.env.example:1114-1119`. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `service.ts` (planning observer construction) | `observer.ts` `emit` | `emit: this.emit(event, { replay: true })` (`service.ts:1839`) | ✓ WIRED | Observer publishes through the ledger emit path. |
| `service.ts` `emit` | event bus | `publishHint` after `result.stored` (`service.ts:2823`, `:2832`) | ✓ WIRED | Only the six hint fields cross. |
| `observer.ts` | `events.ts` | `observePlanningChange` (`observer.ts:403`) with `publisher: { publish: this.deps.emit }` (`:408`) | ✓ WIRED | A failed publish holds the previous baseline (`events.ts:170-176`). |
| `mcp.ts` tools | `PlanningReader` | `substrate.planning.status()` / `.sessions()` (`mcp.ts:2422-2438`) | ✓ WIRED | Handlers return typed JSON. |
| `productionPresence` | `DragonflyPresenceStore` | `service.ts:1444-1447` | ✓ WIRED | `null` when unset, which drives the file-only path. |

### Data-Flow Trace (Level 4)

Not applicable in the UI sense. The planning reads return data from the file index (`index.ts`) and the presence listing (`presence-dragonfly.ts` `listWithin`). Both are fed from real sources and exercised by the tests above.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Incremental update equals full rebuild after add, edit, delete | `bun test src/planning/index.test.ts -t "after an add, an edit and a delete"` | 1 pass, 0 fail | ✓ PASS |
| Stale session listed with age, not removed | `bun test src/planning/read.test.ts -t "past its freshness window is stale"` | 1 pass, 0 fail | ✓ PASS |
| Event carries no file text | `bun test src/planning/events.test.ts -t "no file text reaches the event"` | 1 pass, 0 fail | ✓ PASS |
| Bus receives only hint fields | `bun test src/planning/events.test.ts -t "the bus receives only the six hint fields"` | 1 pass, 0 fail | ✓ PASS |
| File-only: sessions unavailable with no presence backend | `bun test src/planning/read.test.ts -t "no cache endpoint, sessions answer unavailable"` | 1 pass, 0 fail | ✓ PASS |

Only these single named tests were run. The full suite was not run.

### Probe Execution

No `scripts/*/tests/probe-*.sh` is declared or implied for this phase. Skipped.

### Requirements Coverage

| Requirement | Source | Description | Status | Evidence |
|---|---|---|---|---|
| SOTA-08 | ROADMAP phase 52 `**Requirements**` | Planning index, presence and read-only planning tools | ✓ SATISFIED | Truths 1-6 above. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| The 10 planning modules, `mcp.ts`, `policy.ts` in the covered set | — | Grep for `TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER` | — | No matches. No debt-marker gate triggered. |

### Human Verification Required

None. None of the six success criteria requires a live operator action. Live Dragonfly, GreptimeDB and TimescaleDB checks are operator-gated residuals and are not part of these criteria.

### Gaps Summary

No gaps. All six ROADMAP success criteria are met in code at `357d6b15`, and the targeted tests named above pass.

### Advisory (non-blocking, not a gap)

- **SC2 retention tension.** The code never deletes a presence key, but Dragonfly `EX` expires it at `presenceRetentionS` (freshness window plus margin, at most about 25 h). After that, a silent session drops out of `planning_sessions`. This was accepted in phase 52 CONTEXT ("Residual risk (SC2)") and the TTL was left unchanged. The owner should confirm that server-side expiry satisfies "never deleted" as the roadmap intends.
- **No TimescaleDB history adapter.** `HistorySink` has only `InMemoryHistorySink` (`presence.ts`). CONTEXT D52-b makes the production adapter operator-gated. No criterion requires it.
- **Phase directory provenance.** The phase's PLAN and SUMMARY live under `.planning/milestones/v1.5-phases/52-planning-awareness-core/`, not under this phase directory. This record is written here per the phase init and cites those files as covered.

---

_Verified: 2026-11-18T12:22:38Z_
_Verifier: Claude (gsd-verifier)_
