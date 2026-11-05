---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-05T07:11:05Z
status: human_needed
score: "2/2 must-haves verified (SC1 VERIFIED within the owner-accepted pre-send scope, PLAN D76-10, with the buffer enabled per D76-15; SC2 PASSED by owner override, not verified). No gap open in code. W-L2-TIP-ORDER for handoff() is closed in code at a9e477e2; its owner ratification is not recorded."
covered_files: [".env.example", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-PLAN.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-SUMMARY.md", "docs/config-reference.md", "docs/greptime-ledger.md", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-buffer.test.ts", "packages/mcp-server/src/event-buffer.ts", "packages/mcp-server/src/event-dead-letter.test.ts", "packages/mcp-server/src/event-dead-letter.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/handoff.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/reanchor-run.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:f59bd6e5a3461dc940bd1ec4bede646ec9b7807b8ffd9c2d743803cc117c5ce2"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag."
    reason: "Owner accepted the override on 2026-11-02. The dead-letter store is deliberately unbounded (plan decision D76-13): a bound would have to drop records, the silent loss this phase removes. The buffer is bounded by SUBSTRATE_EVENT_BUFFER_MAX, and the depth of both stores is reported in /healthz. A dead-letter cap is a tracked follow-up."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: "2/2 (prior record 76-VERIFICATION.md verified 2026-11-05T01:26:32Z at 835a2742)"
  mode: "re-verification at 42e3cf13 (branch gsd/v18-int-all). The prior record's digest was stale after the H-1 commits (9e6fa1f2, 9c86ffab, e185cd8a, 42e3cf13). Three covered files changed in the range: service.ts, flag-registry.ts and docs/config-reference.md. Each was checked against this phase's criteria; no truth changed. Changes are listed under Changed Since Prior Record."
  gaps_closed: []
  gaps_remaining: []
  regressions: []
warnings:
  - id: HARD-R3-ORPHANED
    truth: "REQUIREMENTS.md HARD-R3 maps to Phase 76."
    status: "ORPHANED. No plan frontmatter declares requirements for 76-01-PLAN.md. REQUIREMENTS.md line 138 still reads 'Not started' at 42e3cf13 (checked). The H-1 commits do not touch HARD-R3."
  - id: HANDOFF-TIP-OUTSIDE-TURN
    truth: "Chain-tip reads for a session run inside that session's turn, so no append interleaves with them."
    status: "OPEN (info). handoff() reads lastHash at service.ts:7693 outside withSessionTurn; its emit at service.ts:7724 reaches appendChained, which takes the turn at service.ts:3065. A concurrent emit for the same session can land between the two, so the packet's prev_event_hash can differ from the stored event's prev. [INFERENCE from code read; not exercised.]"
  - id: R-3-UNSETTLED-AT-EXIT
    truth: "An entry given up by abandonAll() while its delivery is in flight is recorded once that delivery settles."
    status: "Residual (info). If the process exits before the in-flight delivery settles and the buffer's file was not saved, that entry gets no record in this process. A durable file keeps it as live for the next boot. [INFERENCE; not exercised.]"
  - id: SYNC-LAG-BUFFERED-NOT-RECORDED
    truth: "A stored docs.sync note updates the corpus sync-lag gauge (phase 70 SC3)."
    status: "OPEN (info, since c40ffc9a). The hook service.ts:3005 (corpusSlo.recordSyncLag) runs only in emit() on the stored branch, as noteDocsCanary does (D76-14; service.ts:3004). A docs.sync note that is buffered and later drained by deliverBuffered does not reach the hook, so the gauge keeps its previous value until the next stored docs.sync note. grep finds one call site (service.ts:3005). Unchanged at 42e3cf13. [INFERENCE from code read; not exercised. Owner decision whether it matters.]"
human_verification:
  - test: "Operator item 1. Live GreptimeDB rehearsal of the accepted outage limit: block the ledger and emit for one session; restore. Cover (a) a session whose tip is cached, first write fails; (b) that session's next write while the outage lasts; (c) a write for a session with no cached tip; (d) the same run with SUBSTRATE_LEDGER_CHAIN_CACHE=0, sessioned writes, including a write whose tip read succeeds and whose insert fails; (e) a sessionless write during the outage in a process that confirmed append-mode before the outage; (f) a sessionless write in a process whose first ledger contact is during the outage."
    expected: "(a) answers 503 with buffered true and stored false; /healthz eventBuffer.depth rises. (b) and (c) answer stored false with buffered absent, refused at the tip read (service.ts:3166-3177). (d) a sessioned write whose tip read fails is refused; one whose tip read succeeds and whose insert fails is buffered when append mode is confirmed; without that confirmation and without SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER=1|true|yes it is refused as APPEND_MODE_UNKNOWN before the insert (gate at service.ts:3181-3185). (e) is buffered. (f) is refused as APPEND_MODE_UNKNOWN unless the allow flag is set. After restore each buffered event lands once."
    why_human: "Needs a live GreptimeDB and a real outage. The sessionless and write-only clauses are code reads and fake-based tests, not live proofs."
  - test: "Operator item 2. Dead-letter exhaustion on a live outage (nominal budget 243 s; 195 to 292 s with jitter)."
    expected: "A dead-letter line is written with its hash (event-dead-letter.ts record(), hash from event.hash) and the file mode is 0600. Boot refusal without SUBSTRATE_EVENT_DEAD_LETTER_PATH is covered by config.ts:2607-2612 and service-event-buffer.test.ts:229, not by this item."
    why_human: "Needs a live outage longer than the retry budget. Scratch probes wrote their own files, so 0600 on a service-written file was not exercised."
  - test: "Operator item 3. Restart during an outage with a durable file that may end in a torn line from a real crash."
    expected: "The next boot reports the depth, starts the drain timer, and drains each entry once. The torn line is counted as malformed and skipped. The next dead-letter write starts on a fresh line. No record is lost."
    why_human: "The tests inject a torn line; a real partial write on a real disk is not reproduced."
  - test: "Operator item 4 (R-3 residual). Shutdown under the service manager: index.ts:260 drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })."
    expected: "Finishes within the unit's stop bound with a durable buffer. The bounds stack (retain pass, event pass, transitions, flush) can exceed infra/vps/substrate-host.service TimeoutStopSec=15, so a SIGKILL mid-pass is possible; confirm that a durable buffer survives it. A non-durable buffer's in-flight entry is recorded only if its delivery settles before exit (see R-3-UNSETTLED-AT-EXIT)."
    why_human: "Needs the real service manager and a durable buffer file under a stop."
  - test: "Operator item 5 (D76-14, D76-19). Buffered session.end on a live steering session."
    expected: "The session closes first (service.ts:2273 liveSessions.close, :2275 steeringWaiters.closeSession, then the emit at :2276), so steering is closed whether or not the note lands. The code does not keep the session open until the note lands, as PLAN D76-14 and D76-19 say; docs/greptime-ledger.md describes the code."
    why_human: "Needs a live steering session and the owner's ratification of the behaviour."
  - test: "Operator item 6 (R-1). Keyed replay after a dead-letter record on a live collector spool."
    expected: "Confirm which trigger occurs: one new row with a new id (the dead-letter record is orphaned, the common case), or two rows. The replay of a pending give-up is code-verified (service.ts:3141-3157; service-event-buffer.test.ts:334, passing); the live replay after the record has left the buffer is not."
    why_human: "Needs a live collector spool and ledger."
  - test: "Operator item 7 (D76-15). Operator decision to enable the buffer."
    expected: "SC1 holds with SUBSTRATE_EVENT_BUFFER_PATH and SUBSTRATE_EVENT_DEAD_LETTER_PATH set (config.ts:2605-2619 refuses boot when only the buffer path is set). With the buffer unset, a failed write answers stored false and nothing is queued (config.ts:2606 returns null)."
    why_human: "Configuration and policy decision, not code-verifiable."
  - test: "Operator item 8. /healthz staleness."
    expected: "The body is memoised for SUBSTRATE_HEALTHZ_CACHE_MS (default 5000, config.ts:1217; memo in server.ts). Pollers see a depth change within that window."
    why_human: "Needs a running server and a poller."
  - test: "Owner ratification (W-L2-TIP-ORDER, handoff). Commit a9e477e2 moved handoff()'s text refusal and graph-id check before placeOf and lastHash, as the recorded W-L2 rule requires. The owner confirms this as the decided behaviour and records it."
    expected: "The owner records the ratification in ROADMAP.md or the phase record. If the owner wants a different rule, the handoff path is the only one affected."
    why_human: "An owner decision on write ordering; no verifier can supply it."
  - test: "Owner ratification of the doc precision points in docs/greptime-ledger.md. (1) The replay-effect sentence ('a keyed replay answered from the ledger ... appends no event') is accurate for agent_events only; the event_ingest repair write is not named. (2) The cache-off sentence 'every session write reads the tip first' does not name a sessioned write refused for a lone surrogate, which is refused before the read."
    expected: "The owner confirms or amends both sentences and records the decision."
    why_human: "A ratification is an owner decision; no verifier can supply it."
  - test: "Owner decision on HARD-R3. No plan claims it. REQUIREMENTS.md still reads 'Not started'."
    expected: "The owner either maps HARD-R3 to 76-01 and updates its status, or records why it stays orphaned."
    why_human: "Traceability is an owner decision."
  - test: "Owner decision on SYNC-LAG-BUFFERED-NOT-RECORDED (info). A buffered docs.sync note that drains later does not update the sync-lag gauge."
    expected: "The owner decides whether a drained docs.sync note should reach corpusSlo.recordSyncLag (phase 70 SC3), or accepts the gap as the D76-14 precedent."
    why_human: "Whether the gauge must follow buffered notes is an owner decision on phase 70 and 76 scope."
---

# Phase 76: Telemetry buffer and dead-letter Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently. (ROADMAP.md, Phase 76)

**Verified:** 2026-11-05T07:11:05Z
**Status:** human_needed
**Re-verification:** Yes. Prior record at 835a2742 (verified 2026-11-05T01:26:32Z). The prior digest was stale after the H-1 commits. Prior verdicts carried forward where the changes do not touch them.
**Worktree / HEAD:** `/root/src/worktrees/as-gsd-v18-all` (branch gsd/v18-int-all) at 42e3cf13. Covered files are at HEAD; other records in the worktree carry uncommitted edits from parallel workers and are outside this phase's covered list.
**Line references:** Re-anchored at 42e3cf13. In service.ts, lines up to 2484 are as at 835a2742 plus 10; lines from 2485 to 2554 are plus 47 (not in the phase path); lines from 2555 to 2680 are plus 43; lines from 2681 to 4500 are plus 44; lines after 4500 are plus 45. config.ts, event-buffer.ts, event-dead-letter.ts, greptime.ts, server.ts, index.ts and handoff.ts are unchanged in the range. The test files cited (service-event-buffer.test.ts, service.test.ts, event-buffer.test.ts) are unchanged in the range.

## Goal Achievement

### Observable Truths

| #   | Truth   | Status     | Evidence       |
| --- | ------- | ---------- | -------------- |
| 1   | SC1: A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash. | ✓ VERIFIED (within the owner-accepted pre-send scope, D76-10; with the buffer enabled, D76-15) | Write failure → `appendChained` catch → `bufferEvent` (call sites service.ts:3193 and 3226; definition 3234). Bound: `EventBuffer.enqueue` evicts or refuses past `max` (event-buffer.ts:~229-263). Backoff: base×2^n capped, ±20 % jitter (event-buffer.ts:40-44). Ceiling: `runDrain` dead-letters with `exhausted` at `attempts >= maxAttempts`. Record: `DeadLetterStore.record` writes `event_hash` (event-dead-letter.ts record()). Retries use `insertEvent(entry.event, { mayExist: true })` (service.ts:3263; greptime.ts:1262). Unchanged in the H-1 range. |
| 2   | SC2: Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag. | ✓ PASSED (override), not verified | `health().eventBuffer` is `{ enabled: false }` when off, else `{ enabled: true, ...stats, deadLetter: { depth, durable } }` (service.ts:8987). `server.ts` spreads `health` into the `/healthz` body (server.ts:995-1002). Buffer bound by `SUBSTRATE_EVENT_BUFFER_MAX` (config.ts:2623, default 256). Dead-letter store is not bounded (D76-13). The health body test and the overflow test pass at 42e3cf13. The literal SC2 is not met for the dead-letter half. Override carried forward, owner-accepted 2026-11-02. This verifier did not re-accept it. |

**Score:** 2/2 truths counted (1 VERIFIED, 1 PASSED by override). behavior_unverified: 0. Warnings above do not change the score.

### Changed Since Prior Record (835a2742 to 42e3cf13)

Every covered file was compared with `git diff 835a2742..42e3cf13`. Three covered files changed. Their diffs were read in full.

| File | Change | Phase 76 effect |
| ---- | ------ | --------------- |
| `packages/mcp-server/src/service.ts` | Seven hunks, all in the brief-snapshot and forget paths of the H-1 change (commits 9e6fa1f2, 9c86ffab, e185cd8a): an import of `snapshotKey` (line 54); the constant `MAX_IN_PROCESS_BRIEF_SNAPSHOTS` (543); the `briefLastGood` map and `briefForgottenAtMs` field (1642); the `rememberLastGood` and `inProcessLastGood` methods (2495); the brief-snapshot write, now through `rememberLastGood` (2594 region); the degraded brief's read, which falls back to `inProcessLastGood` only when the cache cannot be read (2723); and `memoryForget` setting `briefForgottenAtMs` (4545). Numstat +53, -8. | None on phase 76. The H-1 code calls only the cache (`put`, `peek`, `snapshotSurvivesForget`, `forgetVerdict`, `health`) and its own in-memory map. It does not reach `emit`, `appendChained`, `bufferEvent`, `deliverBuffered`, the drain functions, the chain-tip reads, the handoff refusal, `session.end` or `health()`'s event-buffer block. Those paths are unchanged in content; only their line numbers moved (see the header). `corpusFreshness` (wave 7 hunk at 835a2742) is unchanged in the range. |
| `packages/mcp-server/src/flag-registry.ts` | One row changed, `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` (line 632, brief plane). The `unset` text now describes the in-process last-good window. | None. The phase 76 rows (`SUBSTRATE_EVENT_*`, lines 358-363) are unchanged. |
| `docs/config-reference.md` | One row changed, the same `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` row (line 164, regenerated in commit 42e3cf13). | None. The phase 76 rows are unchanged. `scripts/config-reference.test.ts` re-run at 42e3cf13: 12 pass (see Behavioral Spot-Checks). `docs/greptime-ledger.md` is not in the range. |

Other changes in the range are not in the covered list and do not bear on phase 76: `packages/mcp-server/src/cache.ts` (`forgetVerdict`; `snapshotSurvivesForget` keeps its boolean behaviour), `cache-breaker.test.ts` and `service-forget.test.ts` (H-1 tests), `docs/observability.md`, the VERIFICATION records of phases 63, 64, 66, 71, 72, 73, 76 (this file, rewritten in this run) and 77. ROADMAP.md and REQUIREMENTS.md are not in the 835a2742..42e3cf13 diff (REQUIREMENTS.md line 138 still reads "Not started" for HARD-R3).

Carried forward unchanged: every phase 76 source and test file's verdict from the 835a2742 record. None of those files changed in the range except through the three files above, and the two of them that carry phase 76 code (service.ts, flag-registry.ts) were re-checked for every claim above. The covered test suites were re-run at 42e3cf13 (below), so the carried verdicts are backed by a run at HEAD, not only at 835a2742.

### W-L2 Write-Path Ordering (re-checked at 42e3cf13)

Question: does the surrogate refusal of the six write text fields, and the graph id check, happen before any chain-tip read, buffer or insert on a sessioned write?

| Write shape | Refusal reached at | Tip read before refusal? | Verdict |
| ----------- | ------------------ | ------------------------ | ------- |
| Keyed, replay lookup, via `emit` | service.ts:3138 (`assertWriteTextFields`), 3140 (`normalizeGraphId`), before `replayOutcome` (call at 3147) | No | ✓ refused before lookup, tip, buffer, insert |
| Sessioned, via `emit` / `appendChained`, keyed or unkeyed | service.ts:3138, 3140, before `lastHash` at 3166 | No | ✓ CONFIRMED (named tests passing in the run below; code unchanged) |
| Sessionless, keyed or unkeyed | service.ts:3138 | No tip read exists | ✓ |
| Sessioned, via `handoff()`, then `emit` | service.ts:7675 (`normalizeGraphId(probe)`) and the `assertWriteTextFields` call at 7676-7683, before `placeOf` (7684) and `lastHash` (7693) | No | ✓ CONFIRMED (test "refuses a lone surrogate in the handoff summary before it reads the chain tip", service.test.ts:1669, passing in the run below) |

Coverage note (info): `handoff()` runs its refusal on the probe built from the caller's input. A `repo` that the place lookup fills in (`place.repo`, service.ts:7684) is not in the probe. That value comes from a graph row written under the same rules, so it cannot hold a lone surrogate. [INFERENCE]

Result: the W-L2 rule holds for every sessioned write path. The W-L2-TIP-ORDER warning is closed in code. Ratification is a human item.

### Doc Wording Check (docs/greptime-ledger.md)

`docs/greptime-ledger.md` is unchanged in the range. The wording verdicts from the 9e71f263 record stand.

| Point | Doc says | Code | Verdict |
| ----- | -------- | ---- | ------- |
| Flag values, sessioned clause | `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` set to `1`, `true` or `yes`; `SUBSTRATE_LEDGER_CHAIN_CACHE=0` turns the cache off | config.ts accepts `1\|true\|yes`; cache off for `0\|false\|no`. Gate at service.ts:3181-3185. | **Confirmed**, unchanged. |
| Replay appends no event | "a keyed replay answered from the ledger before the tip read appends no event" | Replay lookup at service.ts:3147 (`replayOutcome`), before the tip read. An ingest-membership repair write can still happen. | **Accurate for `agent_events` only.** Open (human item 10). |
| Cache-off, sessionless and uncached-session clauses | A session with no cached tip during an outage is refused at the tip read; a sessionless write reads no tip | `chainTips` null when the switch is off. `lastHash` only when `sessionId` is set. | **Confirmed by code read**, unchanged. Live outage not exercised (operator item 1). |
| Cache-off, "every session write reads the tip first" | As above | A sessioned write with a lone surrogate is refused before the read. | **Precision point for the owner** (human item 10). Not an edit. |

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-buffer.ts` | Bounded per-session FIFO, backoff, drop causes, in-flight protection, file persistence | ✓ VERIFIED | Changed at a0572cf7 (follow-up pass, abandon in-flight). Unchanged since. Wired from service.ts (`EventBuffer` at 2108). Tests pass (787-pass run below). |
| `packages/mcp-server/src/event-dead-letter.ts` | Append-only JSONL dead-letter store with hash, reason, depth, durability | ✓ VERIFIED | Unchanged since 4b84e50c. Wired from service.ts:2107. 0600 on create and on append (lines 149-150). |
| `packages/mcp-server/src/service.ts` | Turn helper, buffering, drain, health, shutdown | ✓ VERIFIED | `appendChained` 3136, `bufferEvent` 3234, `deliverBuffered` 3253, `drainPendingEvents` 3297, `ensureEventDrainTimer` 3305, `eventBuffer` in health 8987. The H-1 hunks (brief snapshot and forget paths) do not touch phase 76 paths. |
| `packages/mcp-server/src/greptime.ts` | `insertEvent(event, { mayExist })` | ✓ VERIFIED | greptime.ts:1243-1270. Unchanged in the range. greptime.test.ts passes in the run below. |
| `packages/mcp-server/src/config.ts` | Six flags, boot refusal when the dead-letter path is missing | ✓ VERIFIED | config.ts:2600-2627 (unchanged in range). |
| `packages/mcp-server/src/index.ts` | Shutdown calls `drainPendingEvents` | ✓ VERIFIED | index.ts:260 (unchanged). |
| `packages/mcp-server/src/server.ts` | `/healthz` spreads `health()` | ✓ VERIFIED | server.ts:995-1002 (unchanged). |
| `packages/mcp-server/src/flag-registry.ts`, `.env.example`, `docs/config-reference.md` | Six flags documented | ✓ VERIFIED | flag-registry.ts:358-363 (phase 76 rows unchanged; the brief row at 632 changed text only); .env.example:38-46 (unchanged); docs/config-reference.md re-checked by `scripts/config-reference.test.ts` (12 pass at 42e3cf13). The brief row (line 164) changed in the range and still matches the registry. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `appendChained` catch | `EventBuffer.enqueue` | `bufferEvent` | ✓ WIRED | service.ts:3234-3246 and the call sites at 3193 and 3226 |
| `drainEventBuffer` | `deliverBufferedInTurn` | `EventBuffer.drain` | ✓ WIRED | service.ts:3279 (`deliverBufferedInTurn`), 3288 (`drain`) |
| `deliverBuffered` | `insertEvent(…, { mayExist: true })` | direct call | ✓ WIRED | service.ts:3263; greptime.ts:1262 |
| `drainPendingEvents` | `abandonAll` | `options.abandon && !durable` | ✓ WIRED | service.ts:3297-3303; index.ts:260 |
| `onDeadLetter` | `DeadLetterStore.record` | constructor closure | ✓ WIRED | service.ts:2115-2118 |
| `health()` | `/healthz` body | spread | ✓ WIRED | service.ts:8987; server.ts:1002 |

### Data-Flow Trace (Level 4)

Not applicable to a UI. The buffered event's data path is the real `insertEvent` row write and the dead-letter file record, both traced in the artifact table. No static fallback was found.

### Behavioral Spot-Checks

Run at 42e3cf13 with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Phase 76 covered mcp-server suites (service emit path incl. the wave-6 hook, service-level buffering, config flags, flag-registry lock, handoff tip-order refusal, event-buffer incl. R-2 and R-3 named tests, event-dead-letter, event, greptime `mayExist`) | `cd packages/mcp-server && bun test --timeout 30000 src/service.test.ts src/service-event-buffer.test.ts src/config.test.ts src/flag-registry.test.ts src/handoff.test.ts src/event-buffer.test.ts src/event-dead-letter.test.ts src/event.test.ts src/greptime.test.ts` | 787 pass, 0 fail, 3060 expect() calls, 9 files, 9.36 s | ✓ PASS |
| Config reference document vs registry (the brief row changed in the range) | `bun test --timeout 30000 scripts/config-reference.test.ts` (repo root) | 12 pass, 0 fail, 77 expect() calls | ✓ PASS |
| `appendChained` tip-order refusal, handoff tip-order refusal | named tests in service.test.ts (inside the 787-pass run) | passed | ✓ PASS |
| R-2 (`all` during a pass) | named test "a drain with all during a running pass still delivers the entries that pass skipped as not yet due" (event-buffer.test.ts, inside the 787-pass run) | passed | ✓ PASS |
| R-3 (abandon during delivery) | named tests "abandoning the buffer during a delivery keeps the in-flight entry pending until that delivery fails" and "an in-flight entry that lands after the buffer was abandoned is not recorded as abandoned" (inside the 787-pass run) | passed | ✓ PASS |
| Handoff surrogate refused before tip read | "refuses a lone surrogate in the handoff summary before it reads the chain tip" (service.test.ts:1669, inside the 787-pass run) | passed | ✓ PASS |
| Not run here | tsc, lint, the full suite, `config:reference --check` script, the orchestrator gate | not run, by assignment | ? SKIP (routed to the orchestrator gate) |

Postgres evidence: none. No covered test file gates on `SUBSTRATE_TEST_PG_URL`. Checked at 42e3cf13 by grep over every covered test file on this path (`service.test.ts`, `service-event-buffer.test.ts`, `config.test.ts`, `flag-registry.test.ts`, `handoff.test.ts`, `event-buffer.test.ts`, `event-dead-letter.test.ts`, `event.test.ts`, `greptime.test.ts`) and `scripts/config-reference.test.ts`: no match. Both runs above unset the variable. No scratch Postgres run was made, and database `substrate_test_v76` was neither used nor created. PG counts per file: none.

### Probe Execution

No conventional probes exist (`find scripts -path '*/tests/probe-*.sh'` returns none), and no PLAN declares one. Step 7c does not apply.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R3 | none | Bounded queue, backoff with jitter, durable dead-letter with payload and error, per-record dedupe, depth metrics, chain ordering, truthful acks | ORPHANED | REQUIREMENTS.md line 138 reads "Not started" at 42e3cf13. 76-01-PLAN.md declares no `requirements:`. The delivered code covers most of the description: bounded buffer, backoff, dead-letter with the payload, `mayExist` dedupe, depths in /healthz, chain ordering through the per-session FIFO, and truthful `stored: false` replies. The dead-letter bound is not covered (override). |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| all phase 76 source, test and doc files | — | TBD / FIXME / XXX / TODO / HACK / PLACEHOLDER | none | Debt-marker scan over the files, and over every added line of the three changed covered files in 835a2742..42e3cf13 (service.ts, flag-registry.ts, config-reference.md): 0 matches. |

### Human Verification Required

See the `human_verification` frontmatter: operator items 1 to 8 (live GreptimeDB outage, dead-letter exhaustion, torn-line restart, shutdown under the service manager, live steering session, live replay, the enablement decision, /healthz staleness), plus owner items for the handoff reorder ratification, the D76-14/19 ratification, the two doc sentences, HARD-R3 traceability, and the SYNC-LAG-BUFFERED-NOT-RECORDED decision.

### Gaps Summary

No blocking gap. Both roadmap truths are satisfied: SC1 within the owner-accepted pre-send scope, SC2 by owner override. The status is `human_needed` because the live items and the owner decisions above are open.

Open items that remain (carried from the prior record, updated):
- Operator items 1 to 8 (live).
- D76-15: operator decision to enable the buffer.
- D76-14 and D76-19: a buffered `session.end` closes steering before its note lands; PLAN says it should stay open. Owner ratification open.
- R-1: live keyed replay after a dead-letter record. Code path tested, live not.
- R-2 and R-3: closed in code (a0572cf7), tests pass at 42e3cf13. Shutdown behaviour under the service manager is still operator item 4. R-3 residual above.
- Dead-letter cap: a tracked follow-up under the override. SC2's literal dead-letter bound is not met.
- HARD-R3: orphaned in REQUIREMENTS.md; status line stale.
- Handoff tip read outside the session turn (info): service.ts:7693 vs the turn at 3065 (appendChained, reached from the emit at 7724). Not exercised.
- Doc precision points (human item 10).
- Buffered `docs.sync` note does not reach the sync-lag hook when drained (human item 12).

Deferred items (Step 9b): none taken. The dead-letter bound is an owner override, not a deferral to a later phase.

---

_Verified: 2026-11-05T07:11:05Z_
_Verifier: Claude (gsd-verifier)_
