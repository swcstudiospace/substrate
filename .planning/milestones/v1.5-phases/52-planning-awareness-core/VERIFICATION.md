---
phase: 52-planning-awareness-core
verified: 2026-11-12T08:39:19Z
status: human_needed
score: 6/6 must-haves verified in code and unit tests; 3 live/operator items not run
behavior_unverified: 0
overrides_applied: 0
covered_files: ["packages/mcp-server/src/planning/index.ts", "packages/mcp-server/src/planning/index.test.ts", "packages/mcp-server/src/planning/fs.ts", "packages/mcp-server/src/planning/tree.fixtures.ts", "packages/mcp-server/src/planning/diff.ts", "packages/mcp-server/src/planning/diff.test.ts", "packages/mcp-server/src/planning/events.ts", "packages/mcp-server/src/planning/events.test.ts", "packages/mcp-server/src/planning/read.ts", "packages/mcp-server/src/planning/read.test.ts", "packages/mcp-server/src/planning/observer.ts", "packages/mcp-server/src/planning/observer.test.ts", "packages/mcp-server/src/planning/checkout.ts", "packages/mcp-server/src/planning/checkout.test.ts", "packages/mcp-server/src/planning/config.ts", "packages/mcp-server/src/planning/config.test.ts", "packages/mcp-server/src/planning/presence.ts", "packages/mcp-server/src/planning/presence.test.ts", "packages/mcp-server/src/planning/presence-dragonfly.ts", "packages/mcp-server/src/planning/presence-dragonfly.test.ts", "packages/mcp-server/src/planning/presence-client.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/service.ts", "packages/audit/src/policy.ts", "docs/config-reference.md", ".env.example"]
covered_digest: "v3:sha256:2b4f7bb0e47021749f200d1a730592f69a75967a01c49debcb8c00116fc89c84"
re_verification: No — initial verification of the v1.5 archived phase (no prior `gaps:` section)
human_verification:
  - test: "Against the operator's scratch Dragonfly: run the planning presence client's TIME, SET ... EX and bounded SCAN, then call planning_sessions."
    expected: "Heartbeat stamped with server TIME; key carries the EX retention; session listed active, then stale past the freshness window, never deleted."
    why_human: "Live Dragonfly required. Not reachable from this environment; not run."
  - test: "Change a planning document in a configured checkout, let the observer scan, and check the GreptimeDB ledger."
    expected: "One planning.changed note (surface substrate, per-path hashes, no bodies) and one six-field bus hint."
    why_human: "Requires the live ledger ingest path; not run."
  - test: "Decide whether the TimescaleDB HistorySink adapter and migration (CONTEXT D52-b) are required before milestone close."
    expected: "Operator decision recorded. Only InMemoryHistorySink exists (packages/mcp-server/src/planning/presence.ts:198)."
    why_human: "Migration is operator-gated; not one of the six roadmap success criteria, so not scored as a gap."
---

# 52-VERIFICATION: GSD-Core planning index and cross-session awareness core

**Phase Goal:** Agents see other sessions' `.planning` state through the substrate, read-only and file-first: no session writes into another session's `.planning`, and every backing service is optional with a file-only fallback.
**Verified:** 2026-11-12T08:39:19Z
**Status:** human_needed
**Re-verification:** No — initial verification of this archived phase directory (the prior record was a 2026-10-28 read-only pass that ran nothing; this one ran unit tests).

Repo HEAD at verification: `708e03e6`. Source of truth: the six Success Criteria in `.planning/milestones/v1.5-ROADMAP.md` (Phase 52) and SOTA-08 in `.planning/milestones/v1.5-REQUIREMENTS.md`. PLAN.md has no `must_haves` frontmatter, so no truths were added or removed. No `*-SECURITY.md` exists for this phase.

## Success criteria

| # | Criterion | Status | Evidence |
| - | --------- | ------ | -------- |
| 1 | Deterministic index keyed by content hash; full rebuild equals incremental | ✓ VERIFIED | `packages/mcp-server/src/planning/index.ts:97` `contents` keyed by sha256; `:99` `documents` by path; `:230` `buildPlanningIndex`; `:239` `updatePlanningIndex`. Passing tests: `index.test.ts:71`, `:117`, `:154` ("after an add, an edit and a delete, the incremental result equals the full rebuild each time"). |
| 2 | Presence uses server-time TTL; stale derived at read time, never deleted | ✓ VERIFIED (code + unit tests); live Dragonfly not run | Server time: `presence-client.ts:130` sends `TIME`; `presence-dragonfly.ts:91-100` stamps the heartbeat with server time and writes `SET ... EX` (retention, `:8`). Read-time derivation: `presence.ts:137-143` `classifySessions` (`ageMs > ttlMs ? "stale" : "active"`); `presence.ts:109-113` `list()` never filters by age. No delete path: no `DEL`/`UNLINK`/delete in the presence modules. Passing tests: `read.test.ts:139`, `presence-dragonfly.test.ts`. |
| 3 | Planning-change diffs publish on the existing bus carrying paths and hashes, never bodies | ✓ VERIFIED (code + unit tests) | Payload holds per-path sha256 `{path, before, after}`: `events.ts:6-7`, `MAX_EVENT_PATHS` `:23`; `planningChangeEvent` throws on a partial diff (`:65`); `emitPlanningChange` returns `incomplete` without publishing (`:141`). Production chain: observer passes `publisher: { publish: this.deps.emit }` (`observer.ts:408`); the emit dep is `this.emit(event, { replay: true })` (`service.ts:1831`); a stored event calls `publishHint` (`service.ts:2791`, defined `:2800`). `busPublisher` (`events.ts:121`) has no production caller. Passing tests: `diff.test.ts` "reports added, removed and changed paths, each sorted, with the hash before and after"; `events.test.ts:169` "the bus receives only the six hint fields". The production chain was verified by reading, not by an end-to-end run. |
| 4 | Read-only MCP tools `planning_status` and `planning_sessions`, each with a policy entry | ✓ VERIFIED | Registered: `packages/mcp-server/src/mcp.ts:2355` (`planning_status`), `:2371` (`planning_sessions`), both `readOnlyHint: true`. Policy: `packages/audit/src/policy.ts:92-93`, fail-open read section with a stated reason. Read path writes nothing: `read.ts:4-6`; passing tests `read.test.ts:296` ("…answers the same on every call and writes nothing") and `:345`. |
| 5 | File-only mode works with every backing service disabled | ✓ VERIFIED | Unset or blank root → `enabled: false`, no default path: `config.ts` `loadPlanningSettings`. `read.ts:125` answers `{ state: "disabled", reason: "root-unset" }`; `read.ts:266` a null presence backend answers `presence-backend-unset` as disabled, not an error. Passing tests: `config.test.ts:23`, `:31`; `read.test.ts:104`. |
| 6 | Configuration environment-only; documented defaults; no hardcoded hosts, ports or paths | ✓ VERIFIED | `config.ts` env names and defaults: `SUBSTRATE_PLANNING_ROOT`, `_PRESENCE_TTL_S` (90), `_MAX_FILES` (500), `_MAX_BYTES` (262144), `_SCAN_INTERVAL_MS` (15000). Grep of non-test planning modules for `localhost`, `127.0.0.1`, a port-bearing `redis://`, or literal ports: no production hits. The only `redis://` string is the redaction regex at `presence-client.ts:41`. The one `process.env` read outside `config.ts` is `checkout.ts:82`, an allowlist passed to the git child (PATH, HOME, git config variables), not planning configuration. Passing test: `config.test.ts:54` "a malformed scan interval is a boot warning that names its key and never its value". |

**Score:** 6/6 truths verified in code and unit tests. The live checks for truths 2 and 3 are under Human Verification and were not run.

## Artifacts and wiring

| Artifact | Status | Details |
| -------- | ------ | ------- |
| `planning/index.ts`, `diff.ts`, `events.ts` | ✓ VERIFIED | Substantive; wired through `read.ts` and `observer.ts`. |
| `planning/presence*.ts` | ✓ VERIFIED (unit) | Live Dragonfly round-trip not run. |
| `planning/config.ts` | ✓ VERIFIED | Typed errors that name a key, never a value. |
| `mcp.ts`, `packages/audit/src/policy.ts` | ✓ VERIFIED | Two read tools registered and policy entries present. |

## Verification run

- `cd packages/mcp-server && bun test src/planning/{index,diff,events,read,config,presence-dragonfly,presence,fs}.test.ts`: 190 pass, 0 fail.
- `bun test src/planning/{observer,checkout,presence-client}.test.ts`: 141 pass, 0 fail.
- Not run: `bun run verify`, `tsc`, the full `bun test` suite, the Postgres-backed `*.pg.test.ts` files (no `SUBSTRATE_TEST_PG_URL`; Postgres TCP refused), and any live Dragonfly or GreptimeDB check.
- No anti-pattern markers (TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER) in the non-test planning modules.

## Residual risks

- TimescaleDB `HistorySink` adapter and migration (CONTEXT D52-b, PLAN W6) are not built; only `InMemoryHistorySink` exists (`presence.ts:198`). Operator-gated.
- Live checks against Dragonfly (TIME, SET EX retention, SCAN) and GreptimeDB ledger rows cannot run in-repo.
- The `planning.changed` ledger note comes from the observer publish path, not from the read (SUMMARY deviation 2).
- Key retention: a session silent past retention drops out of `planning_sessions`; the code never deletes a key.
- Meaning of `active`: the observer heartbeats on a complete change and on a liveness beat, so a quiet live session stays active; a failed heartbeat or a deployment without presence can read as stale.
- Stat-fingerprint reuse: a same-size edit within filesystem timestamp resolution keeps its stored hash until ctime changes.
- Absolute path disclosure: heartbeats store `worktree: root`, and `planning_sessions` returns it to any MCP caller.
- Process-local index cache: a restart rebuilds the index. The baseline survives a restart only with a configured baseline directory (`FileBaselineStore`, `planning/baseline-store.ts`).

## Human Verification Required

### 1. Live Dragonfly presence round-trip
**Test:** Against the operator's Dragonfly, run the presence client's `TIME`, a heartbeat `SET ... EX` and a bounded `SCAN`; then call `planning_sessions`.
**Expected:** Heartbeat stamped with server time; key carries the retention TTL; session listed `active`, and `stale` once past the freshness window; no key deleted.
**Why human:** Needs a live Dragonfly. Not reachable from this environment.

### 2. Ledger write for a real planning change
**Test:** Change a planning document in a configured checkout; let the observer scan; check the GreptimeDB ledger.
**Expected:** One `planning.changed` note (surface `substrate`, per-path hashes, no bodies) and one six-field bus hint.
**Why human:** Needs the live ledger ingest path.

### 3. TimescaleDB history sink decision
**Test:** Decide whether the production `HistorySink` adapter and migration are required before milestone close.
**Expected:** Operator decision recorded.
**Why human:** The migration is operator-gated and the adapter is not built.

## Gaps Summary

No gaps. All six roadmap success criteria are met in code and covered by passing unit tests (190 + 141 pass, 0 fail). The status is `human_needed` because three live or operator-gated checks were not run.

---

_Verified: 2026-11-12T08:39:19Z_
_Verifier: Claude (gsd-verifier)_
