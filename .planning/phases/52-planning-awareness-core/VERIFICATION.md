---
phase: 52-planning-awareness-core
verified: 2026-10-22
status: gaps_found
score: 3 of 6 criteria PASS (2, 5, 6); 3 FAIL (1, 3, 4)
verified_on: gsd/p52-wiring at 3126296f7ac58544fc1f2409c96126af70ef5473, based on origin/main 0df730ecd42e8a152fd73f1b6b5db04dc170b413
covered_files: ["packages/mcp-server/src/planning/index.ts", "packages/mcp-server/src/planning/index.test.ts", "packages/mcp-server/src/planning/fs.ts", "packages/mcp-server/src/planning/fs.test.ts", "packages/mcp-server/src/planning/diff.ts", "packages/mcp-server/src/planning/diff.test.ts", "packages/mcp-server/src/planning/config.ts", "packages/mcp-server/src/planning/config.test.ts", "packages/mcp-server/src/planning/presence.ts", "packages/mcp-server/src/planning/presence.test.ts", "packages/mcp-server/src/planning/presence-dragonfly.ts", "packages/mcp-server/src/planning/presence-dragonfly.test.ts", "packages/mcp-server/src/planning/presence-client.ts", "packages/mcp-server/src/planning/presence-client.test.ts", "packages/mcp-server/src/planning/events.ts", "packages/mcp-server/src/planning/events.test.ts", "packages/mcp-server/src/planning/read.ts", "packages/mcp-server/src/planning/read.test.ts", "packages/mcp-server/src/planning/tree.fixtures.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/event-sources.ts", "packages/audit/src/policy.ts", "docs/config-reference.md", "docs/event-vocabulary.md", "docs/data-planes.md", ".env.example"]
---

# 52-VERIFICATION: Planning index, session presence and change diffs (file-first)

## Gates

Not run by the verifier; orchestrator gates pending. Read-only inspection: no tests, typecheck, lint or install were run. Test names below are cited from source and were not executed.

## Acceptance criteria

Criteria are the six success criteria given in the verification assignment. `.planning/ROADMAP.md` on this branch and on origin/main has no phase 52 entry (origin/main lists phases through 51), so the criteria text could not be checked against a roadmap file in the repo.

| Criterion | Verdict | Evidence (file:line) |
|---|---|---|
| 1. Deterministic index of `.planning` artifacts keyed by content hash; full rebuild equals incremental result | FAIL | Deterministic, path-ordered, byte-identical builds: `packages/mcp-server/src/planning/index.ts:50-52`, `index.ts:157-185`; test `index.test.ts:57` "the same files give identical records, in path order, on every build". Each record carries a sha256: `index.ts:28`; test `index.test.ts:65`. Not keyed by content hash: records are keyed by path (`index.ts:25-33`, `index.ts:51`). No incremental build exists: `read.ts:153` runs `buildPlanningIndex` from scratch on every read; no `incremental` or `rebuild` symbol in `planning/`. No test compares a full rebuild with an incremental result. |
| 2. Session presence uses a server-time TTL; stale sessions derived at read time, never deleted | PASS (caveat: server key expiry, see Residual risks) | Server time: heartbeat stamped with `TIME` at `presence-dragonfly.ts:71`; `serverTimeMs` reads TIME at `presence-client.ts:124-133`; `serverNowMs` at `presence-dragonfly.ts:98-100`. Derive at read: `read.ts:186-187` classifies with the server clock; `presence.ts:64-65` sets `status = ageMs > ttlMs ? "stale" : "active"`. No host clock: `read.ts:338-345` returns `unknown` with the reason when TIME fails (`read.ts:196-204`); no `Date`/`performance` use in `planning/`. Never deleted: no `DEL`, `UNLINK`, `EXPIRE` or delete call in non-test `planning/` code; `presence.ts:6` states no store deletes; `presence.ts:90` InMemory store "never expires one". Tests: `presence.test.ts:61` "a session past its TTL is stale in the snapshot and still present in list()"; `presence-dragonfly.test.ts:120` "a session past its freshness window is stale and still listed"; `read.test.ts:273` "listed as stale with its age"; `read.test.ts:288` "when the server clock cannot be read ... listed as unknown". |
| 3. Diffs publish on the existing event bus carrying paths and hashes, never bodies | FAIL | No bodies: payload is paths only, `events.ts:27-36`; builder `events.ts:61-108`; test `events.test.ts:57` "no file text reaches the event: a diff built from documents with a body marker carries only paths". Bus hint carries six fields and no paths: `events.ts:120-135`; test `events.test.ts:151` "the bus receives only the six hint fields". Hashes missing: the payload lists `added`/`removed`/`changed` as `string[]` of paths (`events.ts:31-33`); the diff is paths only (`diff.ts:39`, `diff.ts:27-40`). No before or after sha256 is carried anywhere on the event. |
| 4. Read-only MCP tools `planning_status` and `planning_sessions`, each with a `policy.ts` entry | FAIL | Tools exist: `mcp.ts:1407-1418` (`planning_status`), `mcp.ts:1421-1432` (`planning_sessions`), both `annotations: { readOnlyHint: true }` at `mcp.ts:1416` and `mcp.ts:1429`. Policy entries exist: `packages/audit/src/policy.ts:77-78`, inside `FAIL_OPEN_TOOLS` (declared `policy.ts:54`, closed `policy.ts:97`). Read-only is not true: `planning_sessions` writes a presence heartbeat on every call (`read.ts:182` calls `heartbeat`, `read.ts:222-240` calls `presence.touch`, `presence-dragonfly.ts:72` runs `SET ... EX`, `presence-client.ts:105-107`); `planning_status` writes a heartbeat (`read.ts:152`) and can write a `planning.changed` ledger note (`read.ts:257-263`, emit wired at `service.ts:1446`). The descriptions state the opposite: `mcp.ts:1427` "A read: it changes nothing." and `docs/data-planes.md:247` "Both are read-only". Test `read.test.ts:331` "a session that reads the plane appears in planning_sessions afterwards" confirms the write. |
| 5. File-only mode works with every backing service disabled | PASS (caveat: stubbed ledger, see Residual risks) | Root unset disables everything: `planning/config.ts:61`, `read.ts:148-149`; test `read.test.ts:101` "an absent root answers disabled, never an error". Presence disabled: `service.ts:1244-1248` returns null without `dragonflyUrl`; `read.ts:224` returns `presence-unset`; default reader helper uses `presence: null` (`read.test.ts:70-80`). Index and diff run with presence null: test `read.test.ts:121` "the first read is a baseline, an unchanged read emits nothing, and a changed read emits one planning.changed note". Ledger disabled: `read.ts:264`, `read.test.ts:158` "a ledger that does not store the event is reported as not-stored". Dragonfly outage: `read.test.ts:318` "no Dragonfly endpoint answers unavailable with presence-backend-unset". |
| 6. All configuration environment-only, documented defaults, no hardcoded hosts, ports or paths | PASS | Four env names and defaults: `planning/config.ts:12-15`, `config.ts:17-19` (90, 500, 262144), bounds `config.ts:22-26`. Only env reads in planning code: `config.ts:55` and `config.ts:72`. Documented: `docs/config-reference.md:107-110` (all four rows, defaults `none`, `90`, `500`, `262144`); `flag-registry.ts:496-499`; `.env.example:928-931`. No literal host or port in non-test planning code (see Literal scan below). |

## Literal scan (criterion 6)

Non-test code under `packages/mcp-server/src/planning/`:

- Path: `fs.ts:62` `/proc/self/fd/${handle.fd}` is a Linux kernel interface, not configuration. It is the only absolute path in non-test planning code.
- Path name: `index.ts:19` `PLANNING_DIR = ".planning"`, a fixed directory name.
- Key namespace: `presence-dragonfly.ts:29` `substrate:v1:planning:presence:`, a key prefix, not a host or port.
- Scheme literal: `presence-client.ts:41` `redis://` inside the redaction regex only.
- Constants: `presence-dragonfly.ts:33` margin `3_600` s; `presence-dragonfly.ts:31` takes the TTL ceiling from `config.ts:23`.
- Hosts and ports: none in non-test planning code.

Outside `planning/` but tied to it:

- `event-sources.ts:1143-1152` sample payload: repo `swcstudiospace/agent-substrate`, path `.planning/phases/52-planning-awareness-core/52-CONTEXT.md`. This is a registry sample, not read as configuration.

Test fixtures only (not configuration): `tree.fixtures.ts:13` `/repo`; `config.test.ts:34` `/srv/checkout`; `presence-client.test.ts:48` `redis://127.0.0.1:6379`; `presence-client.test.ts:92` `10.0.0.9:6379` inside a redaction test; `index.test.ts:140` and others `/outside/...`; `presence*.test.ts` `/work/<id>`.

## Gaps

- C1: (a) no incremental index build exists, so "full rebuild equals incremental result" is untested and unimplemented (`read.ts:153` rebuilds from scratch); (b) the index is keyed by path, not by content hash (`index.ts:25-33`); missing: an incremental path keyed by sha256 and a test asserting full rebuild == incremental.
- C3: the planning-change event and diff carry paths only: `events.ts:31-33`, `diff.ts:39`. Missing: before and after sha256 for each changed path in the diff and in the event payload, with a test asserting the hashes and no bodies.
- C4: `planning_status` and `planning_sessions` are not read-only. Missing: either remove the presence heartbeat (`read.ts:152`, `read.ts:182`) and the ledger write (`read.ts:257-263`) from the reads, or re-scope the tools and correct `annotations` (`mcp.ts:1416`, `mcp.ts:1429`), the descriptions (`mcp.ts:1414`, `mcp.ts:1427`) and `docs/data-planes.md:247`. The PLAN W6 reviewer decision on the ledger write is still open (`PLAN.md`, W6 "Reviewer decision").

## Operator-gated

- TimescaleDB history table implementing `HistorySink` (CONTEXT D52-b; PLAN W6 blocked). Only `InMemoryHistorySink` exists (`presence.ts:106`). The migration is operator-gated; no production history adapter is in the repo.
- Live Dragonfly, GreptimeDB and planning-checkout checks (TIME reads, presence key expiry, ledger rows) cannot run in-repo.

## Residual risks

- Server key expiry: `presence-dragonfly.ts:33-35,72` sets `EX` to 86400 + 3600 s, so Dragonfly removes a session key about 25 h after its last heartbeat. Code never deletes, but the server does, which is in tension with "never deleted" wording.
- Absolute path disclosure: each heartbeat stores `worktree: root` (`read.ts:230`, `presence.ts:19`) and `planning_sessions` returns it to any MCP caller.
- Process-local baseline: `read.ts:138-139`. A restart resets the baseline, so changes made while the process was down are not published.
- The ledger write comes from a read tool (see C4); the test at `read.test.ts:158` stubs `emit`, so the real `Substrate.emit` path with GreptimeDB unset is not exercised by a planning test.
- Index cost: every read re-walks up to `maxFiles` (default 500) documents, bounded by `SUBSTRATE_PLANNING_MAX_FILES`.
