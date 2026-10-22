---
phase: 52-planning-awareness-core
verified: 2026-10-22
status: passed
score: 6 of 6 criteria PASS
verified_on: gsd/p52-wiring at c3d6e3ec9577d3e90b4347f9ca75055738e11c3a (wiring); core gsd/p52-planning-core at 178a77e5a141569888ba9b93eb70f8ea2c918828, merged into wiring by fdbcf66
covered_files: ["packages/mcp-server/src/planning/index.ts", "packages/mcp-server/src/planning/index.test.ts", "packages/mcp-server/src/planning/fs.ts", "packages/mcp-server/src/planning/diff.ts", "packages/mcp-server/src/planning/events.ts", "packages/mcp-server/src/planning/events.test.ts", "packages/mcp-server/src/planning/read.ts", "packages/mcp-server/src/planning/read.test.ts", "packages/mcp-server/src/planning/observer.ts", "packages/mcp-server/src/planning/observer.test.ts", "packages/mcp-server/src/planning/checkout.ts", "packages/mcp-server/src/planning/config.ts", "packages/mcp-server/src/planning/config.test.ts", "packages/mcp-server/src/planning/presence.ts", "packages/mcp-server/src/planning/presence-dragonfly.ts", "packages/mcp-server/src/planning/presence-client.ts", "packages/mcp-server/src/planning-mcp.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/event-sources.ts", "packages/audit/src/policy.ts", "docs/config-reference.md", "docs/event-vocabulary.md", "docs/data-planes.md", ".env.example"]
---

# 52-VERIFICATION: Planning index, session presence and change diffs (file-first)

## Gates

Not run by the verifier; orchestrator gates pending on c3d6e3e. Test names below are cited from source and were not executed. The orchestrator reported the 178a77e-era counts (core 118 pass; wiring 345 pass); these were not re-run for the scan-cadence fix.

## Acceptance criteria

Criteria are the six success criteria from the verification assignment. `.planning/ROADMAP.md` has no phase 52 entry on any branch checked, so they were not checked against a roadmap file.

| Criterion | Verdict | Evidence (file:line) |
|---|---|---|
| 1. Deterministic index keyed by content hash; full rebuild equals incremental result | PASS | Keyed by content: `planning/index.ts:78` `contents: Record<string, PlanningContent>` keyed by sha256; `index.ts:80` `documents` keyed by path, each naming its content by sha256; `index.ts:284` `indexRecords` is the record view. Identical bytes at two paths share one entry: test `index.test.ts:109` "identical bytes at two paths share one content entry, and the entry lists both paths", describe `index.test.ts:108` "keyed by content hash". Incremental: `index.ts:211` `updatePlanningIndex` reuses content only when the stat fingerprint matches, the stored content fits the current `maxBytes`, and the previous index holds it (`index.ts:531`); fingerprint is device, inode, size, mtime and ctime in ns (`fs.ts:77-78`). Equality test: `index.test.ts:146` "after an add, an edit and a delete, the incremental result equals the full rebuild each time". Also `index.test.ts:174` "an unchanged tree is an update that reads no document bytes at all". |
| 2. Session presence on a server-time TTL; stale derived at read time, never deleted | PASS (caveat: server key retention, see Residual risks) | Server-time stamp: `planning/presence-dragonfly.ts:71` (`lastHeartbeatMs: await this.backend.serverTimeMs()`), written with `SET ... EX` at `presence-dragonfly.ts:72`; server TIME read at `presence-client.ts:124-133`; `presence-dragonfly.ts:98-99` `serverNowMs`. Derive at read: `read.ts:142` classifies with `clock.nowMs`; `presence.ts:65` `status: ageMs > ttlMs ? "stale" : "active"`. When TIME fails, `read.ts:157-158` lists sessions with `ageMs: null` and `status: "unknown"`; `read.ts:200-202` `readClock`. No delete: no `DEL`, `UNLINK`, `EXPIRE` or `rm` call in non-test `planning/` code; `presence.ts:5-6` states it. Tests: `read.test.ts:87` "a session past its freshness window is stale with its age, and a fresh one is active"; `read.test.ts:101` "when the server clock cannot be read, sessions are listed as unknown". |
| 3. Diffs publish on the existing event bus, carrying paths and sha256 before and after, never bodies | PASS | Per-path hashes: `planning/diff.ts:34` `PathChange`, `diff.ts:36-37` `before: string \| null`, `after: string \| null`. Event payload: `planning/events.ts:27-33` lists `PathChange[]`. No bodies: test `events.test.ts:65` "an edit, an add and a removal each carry the sha256 before and after, and no file text reaches the event" asserts the exact payload `{ path, before, after }` for one add, one removal and one change, and `JSON.stringify(event)` does not contain the body marker. Real observer path: `observer.test.ts:73` "an edit is published once, with the sha256 before and after, and the observed checkout heartbeats". The bus carries only the hint fields (`events.ts` `busPublisher`). |
| 4. Read-only MCP tools `planning_status` and `planning_sessions`, each with a `policy.ts` entry; they write nothing, on any call | PASS | Tools: `mcp.ts:1408-1416` (`planning_status`, description "A read: it writes nothing and changes no file, and it sends no heartbeat", `readOnlyHint` at `mcp.ts:1416`); `mcp.ts:1422-1430` (`planning_sessions`, "A read: it writes nothing and sends no heartbeat", `readOnlyHint` at `mcp.ts:1430`). Descriptions are true: the read path has no `touch`, `setWithTtl`, `emit` or heartbeat call (`planning/read.ts`, header lines 4-5; grep finds none). Policy: `packages/audit/src/policy.ts:75-78`, both in `FAIL_OPEN_TOOLS` (declared `policy.ts:54`). Only presence writer: `planning/observer.ts:163` `await presence.touch(record, ttlMs)`; `presence.ts:79` `recordHeartbeat` is called only from tests. Ledger writers: `observer.ts:127` `observePlanningChange`, with `publisher: { publish: this.deps.emit }` at `observer.ts:132`. Zero-write test: `read.test.ts:138` "planning_status and planning_sessions write nothing on the first call or on a repeated one" (`expect(backend.writes).toEqual([])` after two calls of each). Ledger test: `planning-mcp.test.ts:100` "status reads write nothing to the ledger: a change reaches it only through the planning observer's scan". |
| 5. File-only mode works with every backing service disabled | PASS | Root unset: `planning/config.ts:69` returns `enabled: false`; `read.test.ts:62` "an unset root answers disabled, never an error". Cache endpoint unset: `service.ts:1246` `productionPresence` returns null without a Dragonfly URL; `read.test.ts:112` "with no cache endpoint, sessions answer unavailable with presence-backend-unset"; `read.test.ts:154` "with no presence backend a status read answers the same on every call and writes nothing". Observer with no presence: `observer.test.ts:158` "without a cache endpoint a change is still published, and the heartbeat says presence is unset". Scheduler refused while disabled: `observer.test.ts:192` (the cadence test's last assertion) and `observer.ts:91-93`. Ledger disabled is the `emit` port returning false, covered by the publish-failure tests that hold the baseline (`observer.test.ts:129`). |
| 6. All configuration environment-only, documented defaults, no hardcoded hosts, ports or paths | PASS | Cadence is environment configuration: name `planning/config.ts:16` `PLANNING_SCAN_INTERVAL_ENV = "SUBSTRATE_PLANNING_SCAN_INTERVAL_MS"`; default `config.ts:22` `DEFAULT_SCAN_INTERVAL_MS = 15_000`; bounds `config.ts:30` `scanIntervalMs: { min: 1_000, max: 3_600_000 }`; parse `config.ts:61` `integerSetting(env, PLANNING_SCAN_INTERVAL_ENV, DEFAULT_SCAN_INTERVAL_MS, PLANNING_BOUNDS.scanIntervalMs, errors)`, which refuses a non-integer or out-of-range value with a typed error (`config.ts` `integerSetting`). Limits carry it at `config.ts:68`. The observer reads it from the resolved settings: `observer.ts:94` `this.timers.setInterval(() => void this.scan(), resolved.limits.scanIntervalMs)`. Documented: `docs/config-reference.md:111` (default 15000, bounds 1000..3600000, read by `mcp-server/planning/config.ts`); `flag-registry.ts:500`; `.env.example:932`; `docs/data-planes.md:251`. The other three planning variables are unchanged: `config.ts:12-14`, defaults `config.ts:18-20`, rows `docs/config-reference.md:107-110`. Env reads in planning code: only `config.ts:55` and `config.ts:72`. Literal scan of the scan path (see below): no host, port, or absolute path. |

## Scan-path literals (criterion 6)

Operator-facing behaviour is environment configuration. The remaining literals in the scan path are internal bounds and identifiers. None is a host, port or path, and none is a setting an operator tunes:

- `planning/observer.ts:27` `PLANNING_OBSERVER_SESSION = "planning-observer"`: a ledger session id.
- `planning/checkout.ts:14` `wt-` prefix on the checkout session id.
- `planning/observer.ts:124` and `read.ts` `presenceTtlS * 1000`: a unit conversion.
- `planning/index.ts:328` `PROBE_CONCURRENCY = 4`; `fs.ts:18` `READ_CHUNK = 65_536`: fixed concurrency and read chunk size.
- `planning/presence-client.ts:22` `SCAN_COUNT = 100`; `:24` `MAX_SCAN_ROUNDS = 1000`: SCAN paging bounds.
- `planning/presence-dragonfly.ts:29` `PRESENCE_KEY_PREFIX = "substrate:v1:planning:presence:"`: a key namespace.
- `planning/presence-dragonfly.ts:33` `PRESENCE_RETENTION_MARGIN_S = 3_600`; `:37` `PRESENCE_MAX_SESSIONS = 256`: retention margin and listing bound, both documented in CONTEXT.
- `planning/events.ts:23` `MAX_EVENT_PATHS = 100`: the ledger payload path bound.
- `planning/presence-client.ts:41` `redis://` in the redaction regex only.
- `planning/index.ts:24` `.planning` directory name; `fs.ts:64` `/proc/self/fd/` kernel interface (not configuration).

These are code-level safety bounds, so they are not operator configuration. They are listed for the record; none is a SC6 literal.

Test-only literals (fixtures, not configuration): `127.0.0.1:6379` (`presence-client.test.ts:48`), `/repo` (`tree.fixtures.ts`), `/srv/checkout` (`config.test.ts`).

## Gaps

- None.

## Operator-gated

- TimescaleDB history table implementing `HistorySink` (CONTEXT D52-b). Still only `InMemoryHistorySink` (`planning/presence.ts:106`); a production adapter and migration are operator-gated.
- Live checks against Dragonfly (TIME, SET EX retention, SCAN) and GreptimeDB ledger rows cannot run in-repo.

## Residual risks

- Server key retention: `planning/presence-dragonfly.ts:33-35` sets `EX` to 86400 + 3600 s, so Dragonfly removes a session key about 25 h after its last heartbeat. Server retention, not a code deletion (CONTEXT, SC2 residual).
- Changed meaning of `active`: the observer heartbeats a checkout only when it sees a complete change in it (`observer.ts:163`). `active` means "changed a planning document within the freshness window", not "is alive". A quiet session reads `stale`.
- Stat-fingerprint reuse: a same-size edit within filesystem timestamp resolution after the previous scan keeps its stored hash until the next write changes ctime (CONTEXT residual).
- Absolute path disclosure: heartbeats store `worktree: root` and `planning_sessions` returns it to any MCP caller.
- Process-local baseline and index cache: a restart resets both, so changes made while the process was down are not published.
- The cadence test injects its own timer, so `unref` for the production timer is only asserted in `GLOBAL_TIMERS` (`observer.ts:41`), not by a test.
