---
phase: 52-planning-awareness-core
requirements: [SOTA-08]
status: verified in-repo at 0189469 after the Git parser and settings fixes, all six success criteria PASS (SC6 cadence is `SUBSTRATE_PLANNING_SCAN_INTERVAL_MS`, default 15000 ms; shutdown bound `SHUTDOWN_FLUSH_MS` is internal; see VERIFICATION.md)
---

# 52-SUMMARY: planning index, session presence and change diffs

Delta re-verification at 0189469 (since 9e866eb). Wiring `gsd/p52-wiring` at `01894695c5b20cbb5952aad5a6c3038a30637ed8`; core `gsd/p52-planning-core` at `e13593834c67155ff9b041827b88855c1b82440b`, tree `8a9b1bf` (tree `6bf463576b7b063226b337cdbe80c41837800b7d`). Changes: `0f7647c` (`repoFromGitConfig` follows git's rules: case-insensitive section and key names, whitespace around names ignored, an indented header ends the origin section; test `checkout.test.ts:35`); `76c1fcb` (a malformed `SUBSTRATE_PLANNING_SCAN_INTERVAL_MS` is a boot warning naming its key and never its value; test `config.test.ts:54`; printed at `index.ts:92`); `0189469` (merge of phase 51 doc fixes, no code). Orchestrator-reported: core tsc clean, 120 pass, 0 fail; wiring tsc clean, 355 pass, 0 fail.

## What was executed

Delta re-verification at 9e866eb (since 689e06f). Heads: WIRING `gsd/p52-wiring` at `9e866ebe26f7d04abb1b007e739f9d0f9d4acd1c`; CORE `gsd/p52-planning-core` at `e13593834c67155ff9b041827b88855c1b82440b`, whose tree equals `8a9b1bf` (tree `6bf463576b7b063226b337cdbe80c41837800b7d`). The core history holds a stray merge of wiring, so the core work was checked by tree. Gates were not run by the verifier; orchestrator-reported: core tsc clean, 120 pass, 0 fail; wiring tsc clean, 353 pass, 0 fail.
Review-fix commits since 689e06f: CORE `8202976` (event payload stays within the ledger budget and says how many paths it left out), CORE `8a9b1bf` (fake tree gives each file its own fingerprint and resolved path; merged into WIRING by `6614b06`), WIRING `da3f7de` (a quiet checkout does not read as active, scans never overlap, failures reported once and recovery once), WIRING `25e8213` (an inline comment after the origin URL is not part of the repo), WIRING `097f41b` (shutdown waits for an in-flight planning scan inside `SHUTDOWN_FLUSH_MS`), WIRING `681149f` (docs: the status read walks the documents on every call; the observer's scan is not a read), WIRING merge `9e866eb` (phase 51 review fixes).


Read-only re-verification after the fix-up pass. Heads confirmed with `git rev-parse HEAD`:

- CORE: `gsd/p52-planning-core` at `178a77e5a141569888ba9b93eb70f8ea2c918828`.
- WIRING: `gsd/p52-wiring` at `498c45ea880e2a030bcae4e285b7d5e815b5e1f7`. It merges CORE (`fdbcf66`), so the planning modules on WIRING match CORE in the index, diff and fs modules. `events.ts` differs by the wiring-side publish path (ledger write through the observer).

Gates were not run by the verifier. Orchestrator-reported on these heads: tsc clean; core planning tests 118 pass, 0 fail; wiring planning, fabric, dashboards and metrics tests 345 pass, 0 fail.

The verifier read the planning modules, the wiring service and MCP files, the test names and the docs, and grepped for writes, env reads, literal hosts, ports and paths, and dependency changes. No code was changed by this verification. Verdicts and file:line evidence are in VERIFICATION.md.

## Fix-up commits (since the previous verification at 3126296)

- CORE `d807e90`: index keyed by content hash (`contents[sha256]`, `documents[path]`), with `updatePlanningIndex` an incremental build equal to a full rebuild.
- CORE `4b26952`: diff and event carry the sha256 per changed path as `{ path, before, after }`, never a body.
- CORE `178a77e`: the fs test reads the keyed index through its record view. The seven fs test failures were a stale helper.
- WIRING `913d30d`: `planning_status` and `planning_sessions` write nothing on read. New `checkout.ts`, `observer.ts` (`PlanningObserver`, the only presence writer and the only publisher), and `backend.fixtures.ts`.
- WIRING `453751d`: fix-up decisions recorded in CONTEXT.md.
- WIRING merges that absorb phase 51 fixes (`c39b3eb`, `92e82ce`, `a3f4e8e`, `498c45e`) and the CORE merge `fdbcf66`.

## Phase commits

Merge-base with `origin/main`: `0df730ecd42e8a152fd73f1b6b5db04dc170b413`. The range has 108 commits, 35 of them merges. The list below is `git log --oneline` filtered to subjects that name `phase 52`: 47 commits, newest first. The phase 51 and CI merges are not listed.

```
498c45e merge(gsd/p51-fabric-impl): absorb the S6 gauge fix into phase 52 wiring
a3f4e8e merge(gsd/p51-fabric-impl): absorb the phase 51 metrics fix into phase 52 wiring
178a77e fix(planning): the fs test reads the keyed index through its record view (phase 52, SOTA-08)
92e82ce merge(gsd/p51-fabric-impl): absorb the phase 51 test and dashboard fixes into phase 52 wiring
c39b3eb merge(gsd/p51-fabric-impl): absorb phase 51 fixes into phase 52 wiring
453751d docs(52): record fix-up decisions in CONTEXT (phase 52, SOTA-08)
913d30d fix(planning): planning_status and planning_sessions write nothing on read (phase 52, SOTA-08)
4b26952 fix(planning): planning-change diffs and events carry sha256 per path, never bodies (phase 52, SOTA-08)
d807e90 fix(planning): the index is keyed by content hash with an incremental build equal to a full rebuild (phase 52, SOTA-08)
1a9ce41 docs(52): verification and summary for planning awareness core (phase 52, SOTA-08)
3126296 fix(planning): adopt observePlanningChange for the baseline and the publish (phase 52, SOTA-08)
fc678b1 fix(planning): a failed publish holds the baseline so the change is re-sent (phase 52, SOTA-08)
a680493 fix(planning): every scan becomes the next baseline; only complete diffs publish (phase 52, SOTA-08)
03797dd fix(planning): key outlives the largest freshness window by a margin (phase 52, SOTA-08)
4b8f3ff fix(planning): publish before advancing the baseline; re-send a change whose publish fails (phase 52, SOTA-08)
c3eecbe fix(planning): a diff with an unlisted directory is incomplete, so it is never published (phase 52, SOTA-08)
2cc1394 fix(planning): include truncated in a planning note only when a list was truncated (phase 52, SOTA-08)
85223dd test(planning): read truncated counts without indexed access (phase 52, SOTA-08)
435cb8e fix(planning): listings stat nothing, and links are probed only as far as the cutoff (phase 52, SOTA-08)
cd89bc3 fix(planning): quoted origins, byte-budgeted change notes (phase 52, SOTA-08)
6201930 fix(planning): an unlisted previous directory does not withhold an addition (phase 52, SOTA-08)
9070f70 fix(planning): list phase directories during resolution so a failed listing sorts at its path (phase 52, SOTA-08)
b1bfedc fix(planning): carry unlisted into the status snapshot, gate openRead in the slow-scan test, keep the baseline on transient config failures (phase 52, SOTA-08)
9553a20 fix(planning): stop resolving phase directories at the cutoff, keeping path order (phase 52, SOTA-08)
294f841 fix(planning): heartbeat reads, monotonic baseline, worktree git layout, typed repo reasons (phase 52, SOTA-08)
04f17eb fix(planning): bound every presence reply by the command deadline (phase 52, SOTA-08)
2049405 fix(planning): a failed directory read makes its documents unknown, not removed (phase 52, SOTA-08)
c92e43b test(planning): expect the server-stamped heartbeat in the SCAN dedupe test (phase 52, SOTA-08)
d70ea54 fix(planning): bound stat and probe calls in flight to a fixed limit (phase 52, SOTA-08)
bd50307 fix(planning): keep directory errors in path order under a cutoff (phase 52, SOTA-08)
cee2826 fix(planning): adapt the planning reader to the truncation-aware diff (phase 52, SOTA-08)
ebf6812 fix(planning): explicit null checks for probe narrowing (phase 52, SOTA-08)
421f1c9 fix(planning): add complete to the diff literal in events test (phase 52, SOTA-08)
78e568d Merge origin/gsd/p52-planning-core (679064f) into gsd/p52-wiring (phase 52, SOTA-08)
679064f fix(planning): stop collecting at maxFiles+1 candidates, in path order (phase 52, SOTA-08)
d59ff96 fix(planning): report dangling planning links as error records (phase 52, SOTA-08)
f36f73c fix(planning): read documents through one verified descriptor, capped at maxBytes+1 (phase 52, SOTA-08)
d4597c7 fix(planning): withhold removals from a truncated index diff (phase 52, SOTA-08)
b21fde9 fix(planning): read each presence key once when SCAN repeats it (phase 52, SOTA-08)
cfc5387 fix(planning): accept trailing whitespace after the opening frontmatter fence (phase 52, SOTA-08)
38f8a23 fix(planning): create checkout .git directory in read fixtures (phase 52, SOTA-08)
0f0b860 feat(planning): planning.changed ledger row, docs and wiring status (phase 52, SOTA-08)
23d4503 feat(planning): planning_status and planning_sessions read-only tools (phase 52, SOTA-08)
5c396fd feat(planning): presence backend with bounded enumeration and server-side expiry (phase 52, SOTA-08)
7bc5c1b fix(planning): register SUBSTRATE_PLANNING_* flags (phase 52, SOTA-08)
7449bfa fix(planning): typed test assertions and TTL zero bound (phase 52, SOTA-08)
afa4205 feat(planning): file-first planning index, presence and change diffs (phase 52, SOTA-08)
```

## Deviations from PLAN.md and CONTEXT.md

1. W6, TimescaleDB history: not built. Only `InMemoryHistorySink` exists (`planning/presence.ts:106`). PLAN marks it blocked on an operator-gated migration. CONTEXT D52-b is unmet in production.
2. W6, ledger write from a read: superseded. The `planning.changed` note now comes from the observer's publish path, not from `planning_status` (CONTEXT, fix-up decision "Ledger note"). The reviewer decision that PLAN W6 asked for is not recorded as an acceptance; the fix-up moved the write out of the read, so the open question no longer applies to the read path.
3. Presence semantics: the observer heartbeats a checkout only when it sees a complete change in it (`observer.ts`, fix-up decision "Presence source"). PLAN W5 and CONTEXT D52-h did not describe this. Under it, `active` means a planning document changed within the freshness window, not that the session is alive.
4. Scan cadence: environment configuration, `SUBSTRATE_PLANNING_SCAN_INTERVAL_MS` (default 15000, bounds 1000..3600000; `planning/config.ts:16,22,30,61`), read by the observer through the injected timer seam (`observer.ts:94`). PLAN does not specify a cadence. The SC6 judgement from the earlier verification is closed.
5. Criterion 1 and 3 requirements (content-hash index with incremental equality; per-path hashes on the event) were not in PLAN tasks T2 or T6. They were added by the fix-up pass and are now verified (VERIFICATION.md, rows 1 and 3).
6. Key retention: Dragonfly `EX` removes a session key about 25 h after its last heartbeat (`presence-dragonfly.ts:33-35`). This is recorded as residual retention, not a code deletion (CONTEXT, SC2 residual).
7. `.planning/ROADMAP.md` has no phase 52 entry on any branch checked; the criteria came from the verification assignment.

## New dependencies

None. `git diff 0df730e HEAD` over every `package.json` and lock file shows no change. The presence client uses Bun's built-in `RedisClient` from the `bun` module. `zod` (`^4.6.5`, `packages/mcp-server/package.json`) predates this phase.

## Open items

- TimescaleDB `HistorySink` adapter and migration (operator-gated).
- None blocking. The SC6 cadence is now configured (item 4).
- Residual risks as listed in VERIFICATION.md (key retention, stat-fingerprint reuse window, absolute worktree path in heartbeats and `planning_sessions`, process-local baseline and index cache).
