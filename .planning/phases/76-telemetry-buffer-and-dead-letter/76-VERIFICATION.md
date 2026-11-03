---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-03T12:51:08Z
status: human_needed
score: "2/2 must-haves verified (SC1 VERIFIED within the owner-accepted pre-send scope, PLAN D76-10; SC2 PASSED by owner override, not verified)"
covered_files: [".env.example", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-PLAN.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-SUMMARY.md", "docs/config-reference.md", "docs/greptime-ledger.md", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-buffer.test.ts", "packages/mcp-server/src/event-buffer.ts", "packages/mcp-server/src/event-dead-letter.test.ts", "packages/mcp-server/src/event-dead-letter.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/reanchor-run.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:c7374ddf09b24ec9df797ce4c947f917f1868535619ddf0609ae8e6485e64a5a"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag."
    reason: "Owner accepted the override on 2026-11-02. The dead-letter store is deliberately unbounded (plan decision D76-13): a bound would have to drop records, the silent loss this phase removes. The buffer is bounded by SUBSTRATE_EVENT_BUFFER_MAX, and the depth of both stores is reported in /healthz. A dead-letter cap is a tracked follow-up."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: "2/2 (f86388cf record, re-issued in 2cbd183f)"
  gaps_closed: []
  gaps_remaining: []
  regressions: []
requirements_orphaned: ["HARD-R3"]
human_verification:
  - test: "Operator item 1. Live GreptimeDB rehearsal of the accepted outage limit: block the ledger and emit for one session; restore. Cover (a) a session whose tip is cached, first write fails; (b) that session's next write while the outage lasts; (c) a write for a session with no cached tip; (d) the same run with SUBSTRATE_LEDGER_CHAIN_CACHE=0, sessioned writes, including a write whose tip read succeeds and whose insert fails; (e) a sessionless write during the outage in a process that confirmed append-mode before the outage; (f) a sessionless write in a process whose first ledger contact is during the outage. Also run (d) in a process that has not confirmed append mode, with the tip read answering and the append-mode probe failing."
    expected: "(a) answers 503 with buffered true and stored false; /healthz eventBuffer.depth rises. (b) and (c) answer stored false with buffered absent, refused at the tip read (service.ts:3126-3129). (d) a sessioned write whose tip read fails is refused; a sessioned write whose tip read succeeds and whose insert fails is buffered (service.ts:3155-3177) when append mode is confirmed in the process; without that confirmation and without SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER set to 1, true or yes it is refused as APPEND_MODE_UNKNOWN before the insert (service.ts:3133-3138). (e) is buffered (no tip read; the cache switch does not apply). (f) is refused as APPEND_MODE_UNKNOWN (service.ts:3134-3137) unless the allow flag is 1, true or yes. After restore each buffered event lands once, in chain order."
    why_human: "Needs a live GreptimeDB and a real outage. The cache-off sentence's sessionless and write-only clauses are code reads and fake-based tests, not live proofs."
  - test: "Operator item 2. Dead-letter exhaustion on a live outage (nominal budget 243 s; 195 to 292 s with jitter)."
    expected: "A dead-letter line is written with its hash (event-dead-letter.ts:102-122, hash at :108, stderr 'dead-lettered' at :119) and the file mode is 0600 (event-dead-letter.ts:149-150). Boot refusal without SUBSTRATE_EVENT_DEAD_LETTER_PATH is covered by config.ts:2604-2618 and service-event-buffer.test.ts:229, not by this item."
    why_human: "Needs a live outage longer than the retry budget. The scratch probes wrote their own files, so 0600 on a service-written file was not exercised."
  - test: "Operator item 3. Restart during an outage with a durable file that may end in a torn line from a real crash (ENOSPC, kill mid-write)."
    expected: "The next boot reports the depth and starts the drain timer (service.ts:2112; tick at service.ts:3256-3260) and drains each entry once. The torn line is counted as malformed at boot and skipped. The next dead-letter write starts on a fresh line (event-dead-letter.ts:148). Boot does not repair the torn line. Confirm no record is lost."
    why_human: "The G1 test injects a torn line; a real partial write on a real disk is not reproduced."
  - test: "Operator item 4 (R-2, R-3). Shutdown under the service manager: index.ts:258 drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true }) after the retain pass at index.ts:255."
    expected: "Finishes within the unit's stop bound with a durable buffer. R-2: drain (event-buffer.ts:287-293) returns an in-flight pass and drops options.all, so shutdown can join a periodic pass and skip entries not yet due. R-3: abandonAll (event-buffer.ts:299-305, called at service.ts:3253) clears the entry in flight; an in-flight entry that lands is recorded abandoned. The bounds stack: retain pass (10 s, index.ts:221), event pass (10 s), transitions (5 s, index.ts:223), flush (2 s, index.ts:219). infra/vps/substrate-host.service:59 sets TimeoutStopSec=15 in the repository unit; the stack can exceed it, so a SIGKILL mid-pass is possible. A buffer that is not durable abandons its entries as warnings, not blockers."
    why_human: "Needs the real service manager and a durable buffer file under a stop. R-2 and R-3 are carried forward from the prior record and were not re-proven in this pass."
  - test: "Operator item 5 (D76-14, D76-19). Buffered session.end on a live steering session."
    expected: "The session is closed first (service.ts:2263 liveSessions.close, service.ts:2265 steeringWaiters.closeSession, then the emit), so steering is closed whether or not the note lands. event_stored is false while the note is buffered and the wake-up hint is withheld (publishHint runs only on a stored event, service.ts:2961; a buffered event publishes only on landing, service.ts:3221). docs/greptime-ledger.md residuals paragraph describes this. PLAN D76-14 and D76-19 say the session stays open until the note lands; the code does not do that, and the doc matches the code. Owner ratification is still open."
    why_human: "Needs a live steering session and the owner's ratification of the behaviour."
  - test: "Operator item 6 (R-1). Keyed replay after a dead-letter record on a live collector spool."
    expected: "Confirm which trigger occurs: Trigger A (one new row with a new id; the dead-letter record is orphaned, the common case) or Trigger B (two rows). The replay of a pending give-up is code-verified (service.ts:3107-3108, event-buffer.ts:195-197, deadLettered true, nothing appended; service-event-buffer.test.ts:334); the live replay after the record has left the buffer is not."
    why_human: "Needs a live collector spool and ledger."
  - test: "Operator item 7 (D76-15). Operator decision to enable the buffer."
    expected: "SC1 holds with SUBSTRATE_EVENT_BUFFER_PATH and SUBSTRATE_EVENT_DEAD_LETTER_PATH set (config.ts:2608-2613 refuses boot when only the buffer path is set). With the buffer unset, a failed write answers stored false and nothing is queued (config.ts:2606 returns null). The operator must make and record this decision."
    why_human: "Configuration and policy decision, not code-verifiable."
  - test: "Operator item 8. /healthz staleness."
    expected: "The body is memoised for SUBSTRATE_HEALTHZ_CACHE_MS (default 5000, config.ts:1217; memo at server.ts:985-991). Pollers see a depth change within that window. Line references are carried from the prior record; spot-checks in this pass matched config.ts:1217."
    why_human: "Needs a running server and a poller."
  - test: "Owner ratification of the three precision points in docs/greptime-ledger.md (see Doc Wording Check below). The doc's sessioned clause carries the stamp 'Owner-accepted, 2026-11-03', but ROADMAP.md Phase 76 status records owner ratification of the exact wording as open. The stamp is not reconciled with the roadmap by any artifact in the worktree."
    expected: "The owner confirms the three precision points and either removes the open flag in ROADMAP.md or records the decision. Until then the wording is open."
    why_human: "A ratification is an owner decision; no verifier can supply it."
---

# Phase 76: Telemetry buffer and dead-letter Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently. (ROADMAP.md, Phase 76)

**Verified:** 2026-11-03T12:51:08Z
**Status:** human_needed
**Re-verification:** No — initial mode (the prior report has no `gaps:` section). The prior report's frontmatter is recorded above for continuity only.
**Worktree / HEAD:** `/root/src/worktrees/as-gsd-v18-all` at 046fbe05. Code as of 6644698e; 046fbe05 changed only `docs/greptime-ledger.md`.

## Goal Achievement

### Observable Truths

| #   | Truth   | Status     | Evidence       |
| --- | ------- | ---------- | -------------- |
| 1   | SC1: A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash. | ✓ VERIFIED (within the owner-accepted pre-send scope, D76-10) | Write failure → `appendChained` catch → `bufferEvent` (service.ts:3169-3177). Bound: `EventBuffer.enqueue` evicts or refuses past `max` (event-buffer.ts:233-250). Backoff: `eventBufferBackoffMs` = base×2^n capped, ±20 % jitter (event-buffer.ts:40-44; schedule 1,2,4,8,16,32,60,60,60 s, nominal 243 s, matches doc). Ceiling: drain drops with `exhausted` at `attempts >= maxAttempts` (event-buffer.ts:335-337). Record: `DeadLetterStore.record` writes `event_hash` (event-dead-letter.ts:102-120). Retries use `insertEvent(entry.event, { mayExist: true })` (service.ts:3214; greptime.ts:1262), so a retry that lands once does not insert twice. Behavioural tests, run this pass: `service-event-buffer.test.ts` 17 pass, 0 fail, including "a failed write is buffered, not dropped, and lands once the ledger is back", "a later event of the session waits behind the buffered one", "a write that landed but lost its reply is not stored a second time on retry", "a write that exhausts its budget is dead-lettered with its hash and its reason". Scope: a write refused before send (chain-tip unreadable, append-mode refusal) is not buffered (service.ts:3126-3138, D76-10). Live-outage evidence is operator item 1 and 2, open. |
| 2   | SC2: Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag. | ✓ PASSED (override) — not verified | Reported: `health().eventBuffer` = `{ enabled: false }` when off, else `{ enabled: true, ...stats, deadLetter: { depth, durable } }` (service.ts:8912). Buffer bound by `SUBSTRATE_EVENT_BUFFER_MAX` (config.ts:2623, default 256); the bound test "the buffer is off unless its path is set, and the bound comes from the flag" passed. Dead-letter store is not bounded (D76-13; `DeadLetterStore` has no cap). The literal SC2 is therefore not met for the dead-letter half. Override carried forward as recorded in frontmatter, owner-accepted 2026-11-02. This verifier did not re-accept it. |

**Score:** 2/2 truths counted (1 VERIFIED, 1 PASSED by override). behavior_unverified: 0.

### Doc Wording Check (docs/greptime-ledger.md, commits 6644698e and 046fbe05)

The assignment named two precision fixes. Each was judged against the code it describes.

| Point | Doc says | Code | Verdict |
| ----- | -------- | ---- | ------- |
| Flag values, sessioned clause | `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` set to `1`, `true` or `yes`; `SUBSTRATE_LEDGER_CHAIN_CACHE=0` turns the cache off; the gate is at service.ts around line 3133 | `config.ts:1194`: `/^(1\|true\|yes)$/i` on the trimmed value, so the three values are accepted, and also in any letter case (`TRUE`, `Yes`). `config.ts:2439`: `chainCache: !/^(0\|false\|no)$/i`, so `0`, `false` and `no` turn the cache off. The gate `appendOnly !== true && !this.config.allowDeduplicatingLedger` is at service.ts:3133-3138, applied to every write, sessioned or not. | **Confirmed.** The three allow values and the `=0` example are correct. Two omissions, neither a contradiction: the matching is case-insensitive and trimmed, and `false`/`no` also switch the cache off. The gate claim "a session write reaches its insert only under one of those two conditions" is correct. |
| Replay appends no event | "a keyed replay answered from the ledger before the tip read appends no event" | Ordering confirmed: the replay lookup runs in `appendChained` at service.ts:3097-3099, before the tip read at 3117 and the tip-unreadable refusal at 3126. A replay hit (`replayOutcome`, service.ts:3056-3089) returns before any `lastHash` call, and a queued or pending keyed replay returns at service.ts:3102-3108 with no write. **But** a hit whose `event_ingest` membership is confirmed missing calls `recordIngest` (service.ts:3080-3081), which appends one ingest record. The doc itself states this at lines 413-416. | **Accurate for `agent_events` only.** No event row is appended. The unqualified word "event" hides one `event_ingest` repair write, and the roadmap's "keyed replays are not writes" is not literally true. Wording stays open for owner ratification. Suggested exact form: "writes no `agent_events` row; a hit whose ingest record is missing gets one `event_ingest` repair write (see Idempotent replay)." Not edited here: no doc edits are in this assignment. |
| Cache-off, sessionless and uncached-session clauses (context for the above) | A session with no cached tip during an outage is refused at the tip read; a sessionless write reads no tip | `chainTips` is null when the switch is off (greptime.ts:798). `lastHash` is called only when `sessionId` is set (service.ts:3113). The tip-unreadable refusal is at service.ts:3126-3128 with no buffering. | **Confirmed by code read.** The outage behaviour is not exercised live (operator item 1). |

Owner stamp: the sessioned clause in the doc ends "Owner-accepted, 2026-11-03." ROADMAP.md Phase 76 status says owner ratification of the exact wording is open. This verifier has no artifact that reconciles them. The stamp is recorded as a discrepancy, and the ratification stays open.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-buffer.ts` | Bounded per-session FIFO, backoff, drop causes, file persistence | ✓ VERIFIED | 514 lines; `eventBufferBackoffMs`, `enqueue`, `runDrain` substantive; wired from service.ts:231 |
| `packages/mcp-server/src/event-dead-letter.ts` | Append-only JSONL dead-letter store with hash, reason, depth, durability | ✓ VERIFIED | 249 lines; `record` writes `event_hash` (:108) and stderr line (:119); wired from service.ts:230 |
| `packages/mcp-server/src/service.ts` | Turn helper, buffering, drain, health, shutdown | ✓ VERIFIED | `withSessionTurn` (:3027), `replayOutcome` (:3056), `appendChained` (:3091), `bufferEvent` (:3185), `deliverBuffered` (:3204, `mayExist: true` at :3214), `drainPendingEvents` (:3248), `eventBuffer` in health (:8912) |
| `packages/mcp-server/src/config.ts` | Six flags; boot refusal on missing dead-letter path or shared file | ✓ VERIFIED | `loadEventBufferSettings` (:2601-2629): `null` unless `SUBSTRATE_EVENT_BUFFER_PATH` set (D76-15); throws `ConfigError` naming `SUBSTRATE_EVENT_DEAD_LETTER_PATH` (D76-16); refuses one shared file |
| `packages/mcp-server/src/reanchor-run.ts` | Isolated config nulls buffer | ✓ VERIFIED | `eventBuffer: null` at :279 |
| `packages/mcp-server/src/index.ts` | Shutdown calls drain | ✓ VERIFIED | `drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })` at :258 |
| `packages/mcp-server/src/greptime.ts` | `insertEvent` with `mayExist`; tip cache | ✓ VERIFIED | `mayExist` at :1248-1272; `chainTips` null when off (:798); `ensureAppendMode` keeps the prior answer on failure (:1183-1192) |
| Debt markers (TBD, FIXME, XXX, TODO, HACK, PLACEHOLDER) in phase files | none allowed unreferenced | ✓ none found | Scan over the twelve implementation and doc files in the fingerprint set |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| service.ts | event-buffer.ts / event-dead-letter.ts | imports, `DeadLetterStore`, `EventBuffer` | ✓ WIRED | service.ts:230-231; constructed at :2093-2111 |
| appendChained | bufferEvent | write failure path | ✓ WIRED | service.ts:3169-3177; queued-behind path at :3143-3151 |
| deliverBuffered | greptime.insertEvent | retry with `mayExist` | ✓ WIRED | service.ts:3214; greptime.ts:1262 |
| index.ts | drainPendingEvents | shutdown | ✓ WIRED | index.ts:258 |
| server.ts `/healthz` | eventBuffer | spread of `substrate.health()` | ✓ WIRED | no server change needed; body spread per PLAN |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `EventBuffer.entries` | buffered event | `build(...)` from the real event normalised on write | ✓ | ✓ FLOWING |
| `/healthz eventBuffer.depth` | `stats().depth` | live `entries` size and `DeadLetterStore.depth()` | ✓ | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Buffered write, retry, exhaustion, ordering, replay, health, boot refusal | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test packages/mcp-server/src/service-event-buffer.test.ts --timeout 30000` | 17 pass, 0 fail, 52 expect() calls | ✓ PASS |

Only this one targeted file was run, per the assignment. The other new suites (`event-buffer.test.ts`, `event-dead-letter.test.ts`) and the `greptime.test.ts` `mayExist` block were not run in this pass. Their claims rest on the prior record and are not re-verified here.

The buffer-test stderr contains a `dead-letter store append failed (EEXIST)` line. It is the expected output of the blocker test, not a failure.

### Probe Execution

No `scripts/*/tests/probe-*.sh` is declared or implied by this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R3 | none (ORPHANED) | Bounded queue with backpressure; failed batches retry with exponential backoff and jitter, then retain payload and error in a durable dead-letter store. REQUIREMENTS.md maps it to Phase 76 with status "Not started". | ✗ ORPHANED | `76-01-PLAN.md` has no frontmatter `requirements:` field, so no plan claims HARD-R3. Code evidence covers most of its text, but the requirement says "each destination" and this phase has one ledger; "backpressure" is a refusal (`stored: false`) when the buffer is full; the dead-letter store is durable only with its path set. The REQUIREMENTS.md "Not started" status is stale. Not edited here. Requires orchestrator decision. |

### Anti-Patterns Found

None blocking. Debt-marker scan returned nothing.

### Human Verification Required

See the frontmatter `human_verification` list: operator items 1–8, plus owner ratification of the doc's three precision points. All are open. None is closed by this pass.

### Deferred Items

None.

### Advisory

None (not a re-verification).

### Gaps Summary

No truth FAILED. No artifact is missing or a stub. No key link is unwired. Status is `human_needed` because the open human items remain, not because any must-have failed.

Open, not closed by this pass:

- **D76-15**: enabling the buffer is an operator decision (item 7).
- **D76-14 and D76-19**: a buffered `session.end` closes steering at once (the code) while PLAN says it stays open until the note lands (item 5). The doc matches the code. Owner ratification is open.
- **R-1, R-2, R-3**: carried forward from the prior record (items 4 and 6). R-2 and R-3 were not re-proven in this pass.
- **Operator items 1–8**: live Greptime outage rehearsal, real exhaustion, torn-line restart, shutdown under the service manager, live steering session, live replay, the enablement decision, and `/healthz` staleness. Each needs a live system.
- **Doc precision points**: the flag values and the cache-off wording are confirmed. The replay wording is accurate for `agent_events` only and omits the `event_ingest` repair write. The doc's "Owner-accepted, 2026-11-03" stamp conflicts with the roadmap's "ratification open". Owner ratification stays open.
- **HARD-R3**: orphaned in REQUIREMENTS.md against Phase 76; no plan claims it.
- **Dead-letter cap**: a tracked follow-up under the override. SC2's literal dead-letter bound is not met.

Not re-verified in this pass, and carried from the prior record: `event-buffer.test.ts`, `event-dead-letter.test.ts`, the `greptime.test.ts` `mayExist` block, `bun run config:reference -- --check`, `flag-registry.test.ts`, `config-reference.test.ts`. Several line references in the carried operator items were not re-checked; the spot-checks above matched.

---

_Verified: 2026-11-03T12:51:08Z_
_Verifier: Claude (gsd-verifier)_
