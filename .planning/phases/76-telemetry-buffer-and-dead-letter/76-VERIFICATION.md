---
phase: 76-telemetry-buffer-and-dead-letter
verified: 2026-11-03T14:55:03Z
status: human_needed
score: "2/2 must-haves verified (SC1 VERIFIED within the owner-accepted pre-send scope, PLAN D76-10; SC2 PASSED by owner override, not verified). Warning: the W-L2 refusal does not precede the chain-tip read on sessioned writes (see warnings)."
covered_files: [".env.example", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-PLAN.md", ".planning/phases/76-telemetry-buffer-and-dead-letter/76-01-SUMMARY.md", "docs/config-reference.md", "docs/greptime-ledger.md", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-buffer.test.ts", "packages/mcp-server/src/event-buffer.ts", "packages/mcp-server/src/event-dead-letter.test.ts", "packages/mcp-server/src/event-dead-letter.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/reanchor-run.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-event-buffer.test.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:36380c2c77ab8f89d087ce47cae5c71e0ce327f64476121c97f5ee7fd51d0fcd"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "Buffer and dead-letter depth are reported in /healthz and bounded by a flag."
    reason: "Owner accepted the override on 2026-11-02. The dead-letter store is deliberately unbounded (plan decision D76-13): a bound would have to drop records, the silent loss this phase removes. The buffer is bounded by SUBSTRATE_EVENT_BUFFER_MAX, and the depth of both stores is reported in /healthz. A dead-letter cap is a tracked follow-up."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: "2/2 (046fbe05 record, carried from 76-VERIFICATION.md before this pass)"
  mode: "initial mode: the prior record has no gaps: section; re-checked at 3e26a5c1 for the W-L2 write-path change"
  gaps_closed: []
  gaps_remaining: []
  regressions: []
warnings:
  - id: W-L2-TIP-ORDER
    truth: "The W-L2 surrogate refusal (summary, session_id, repo) happens before any tip read, buffer or insert."
    status: "NOT CONFIRMED for the tip read; buffer, insert, replay lookup and append-mode probe confirmed"
    evidence: "service.ts:3117 lastHash runs before service.ts:3124 build (normalizeEvent, which refuses) on every sessioned write that does not take the keyed replay lookup (3098) or the keyed buffer check (3103). The buffer (3143, bufferEvent 3185), ensureAppendMode (3133) and insertEvent (3155) all follow the refusal."
    decision: "Owner decision. Options: refuse before the tip read on the sessioned path, and add a service-level test that a refused write calls neither lastHash nor insertEvent. No code was changed by this pass."
human_verification:
  - test: "Operator item 1. Live GreptimeDB rehearsal of the accepted outage limit: block the ledger and emit for one session; restore. Cover (a) a session whose tip is cached, first write fails; (b) that session's next write while the outage lasts; (c) a write for a session with no cached tip; (d) the same run with SUBSTRATE_LEDGER_CHAIN_CACHE=0, sessioned writes, including a write whose tip read succeeds and whose insert fails; (e) a sessionless write during the outage in a process that confirmed append-mode before the outage; (f) a sessionless write in a process whose first ledger contact is during the outage. Also run (d) in a process that has not confirmed append mode, with the tip read answering and the append-mode probe failing."
    expected: "(a) answers 503 with buffered true and stored false; /healthz eventBuffer.depth rises. (b) and (c) answer stored false with buffered absent, refused at the tip read (service.ts:3126-3129). (d) a sessioned write whose tip read fails is refused; a sessioned write whose tip read succeeds and whose insert fails is buffered (service.ts:3155-3177) when append mode is confirmed in the process; without that confirmation and without SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER set to 1, true or yes it is refused as APPEND_MODE_UNKNOWN before the insert (service.ts:3133-3138). (e) is buffered (no tip read; the cache switch does not apply). (f) is refused as APPEND_MODE_UNKNOWN (service.ts:3134-3137) unless the allow flag is 1, true or yes. After restore each buffered entry lands once, in order per session."
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
  - test: "Owner ratification of the doc precision points in docs/greptime-ledger.md (see Doc Wording Check). Status changed since the prior record: ROADMAP.md (Phase 76 status and progress row) now records owner ratification of the cache-off wording on 2026-11-03, and the doc paragraph at docs/greptime-ledger.md:979 carries the matching stamp. The replay-effect sentence (the prior record's point 2, about the event_ingest repair write) has no ratification recorded in any artifact, and the doc is unchanged there since 046fbe05."
    expected: "The owner confirms the replay-effect sentence, including whether the unqualified word 'event' is accepted, and records the decision. The cache-off ratification is recorded; it is not reopened by this pass."
    why_human: "A ratification is an owner decision; no verifier can supply it."
---

# Phase 76: Telemetry buffer and dead-letter Verification Report

**Phase Goal:** An event that fails to write to GreptimeDB is buffered, retried and dead-lettered with a record. No event is dropped silently. (ROADMAP.md, Phase 76)

**Verified:** 2026-11-03T14:55:03Z
**Status:** human_needed
**Re-verification:** No — initial mode (the prior record has no `gaps:` section). Prior frontmatter is carried for continuity.
**Worktree / HEAD:** `/root/src/worktrees/as-gsd-v18-all` at 3e26a5c1 (branch gsd/v18-int-all). Phase-76 code as of 046fbe05. Since the prior record, 3e26a5c1 changed only `packages/mcp-server/src/event.ts` and `event.test.ts`. `service.ts` and `greptime.ts` have zero diff since 046fbe05, so the service.ts line references in the prior record still hold (spot-checked below). Worktree was clean before this pass.

## Goal Achievement

### Observable Truths

| #   | Truth   | Status     | Evidence       |
| --- | ------- | ---------- | -------------- |
| 1   | SC1: A failed event write enters a bounded buffer, is retried with backoff, and after the retry budget is written to a dead-letter store with its hash. | ✓ VERIFIED (within the owner-accepted pre-send scope, D76-10) | Write failure → `appendChained` catch → `bufferEvent` (service.ts:3169-3177). Bound: `EventBuffer.enqueue` evicts or refuses past `max` (event-buffer.ts:233-250). Backoff: base×2^n capped, ±20 % jitter (event-buffer.ts:40-44). Ceiling: drain dead-letters with `exhausted` at `attempts >= maxAttempts` (event-buffer.ts:335-337). Record: `DeadLetterStore.record` writes `event_hash` (event-dead-letter.ts:102-120). Retries use `insertEvent(entry.event, { mayExist: true })` (service.ts:3214). The W-L2 change in 3e26a5c1 does not touch this path. |
| 2   | SC2: Buffer and dead-letter depth are reported in `/healthz` and bounded by a flag. | ✓ PASSED (override) — not verified | `health().eventBuffer` is `{ enabled: false }` when off, else `{ enabled: true, ...stats, deadLetter: { depth, durable } }` (service.ts:8912). Buffer bound by `SUBSTRATE_EVENT_BUFFER_MAX` (config.ts:2623, default 256). Dead-letter store is not bounded (D76-13). The literal SC2 is not met for the dead-letter half. Override carried forward, owner-accepted 2026-11-02. This verifier did not re-accept it. |

**Score:** 2/2 truths counted (1 VERIFIED, 1 PASSED by override). behavior_unverified: 0. One WARNING (W-L2-TIP-ORDER, below) does not change the score.

### W-L2 Write-Path Ordering (3e26a5c1)

Question: does the surrogate refusal of `summary`, `session_id` and `repo` happen before any tip read, buffer or insert?

Refusal sites: `normalizeEvent` calls `refuseLoneSurrogate` at event.ts:371-373, before any hash or store work. `normalizeEvent` is reached from `appendChained` at four points, listed in call order below.

| Write shape | Refusal reached at | Tip read (`lastHash`) | Replay lookup / buffer check | Buffer, append-mode probe, insert | Verdict |
| ----------- | ------------------ | --------------------- | ---------------------------- | --------------------------------- | ------- |
| Keyed, replay lookup on (`accept` with replay marker, or `enforce`) | service.ts:3060 inside `replayOutcome`, called at 3098 | Not reached (refusal throws first) | Not reached (`findByIdempotencyKey` at 3063 follows the refusal) | Not reached | ✓ refused before lookup, tip, buffer, insert |
| Keyed, buffer on, no lookup | service.ts:3103 | Not reached | Not reached (`findKeyed` 3104, `findPendingKeyed` 3107 follow) | Not reached | ✓ |
| Sessionless, no key | service.ts:3124 (`build`) | Not applicable (no session, 3113 skipped) | Not applicable | Not reached (`ensureAppendMode` 3133, buffer 3143, insert 3155 follow) | ✓ |
| Sessioned, unkeyed, or keyed with buffer off and no lookup | service.ts:3124 (`build`) | **Reached first**: `lastHash` at 3117 runs before the refusal | Not reached | Not reached | ✗ tip read precedes refusal |

Details:

- **Tip read before refusal (sessioned path).** `appendChained` reads `prev = await this.greptime.lastHash(sessionId)` at service.ts:3117, then calls `build(prev)` at 3124. The refusal is inside `build`. So a sessioned write with a lone surrogate in `summary`, `session_id` or `repo` issues one tip read (answered from `chainTips` when warm, otherwise a SQL SELECT on `agent_events`, greptime.ts:1483-1490) before it is refused. No write follows.
- **Tip failure does not change the outcome.** If `lastHash` throws, `tipError` is set, but `build(prev)` at 3124 still runs and throws before the `tipError` check at 3126. The refusal wins, and the "chain tip unreadable" answer is not returned for these inputs.
- **Greptime absent.** `build` at 3124 precedes the `GREPTIME_URL is not set` check at 3125. The refusal wins.
- **Turn wait before refusal.** `append` runs `withSessionTurn` (service.ts:3020, 3027-3039) before `appendChained`. A refused sessioned write waits for the session's earlier turn, which can include a buffered delivery holding the Greptime write timeout (the prior record's risk item). The refusal then comes after that wait. Information only.
- **Replay lookup ordering.** Where the replay lookup runs, `normalizeEvent` at 3060 refuses before `findByIdempotencyKey` (3063) and before `cursorPosition` (3074) and `recordIngest` (3081). Confirmed.
- **Commit wording.** Commit 3e26a5c1 says "Refused now, before any hash or store write". That is accurate. It does not claim "before any read", and the ordering the assignment asked about does not hold for the tip read.
- **No test covers the ordering.** `event.test.ts` tests `normalizeEvent` alone. `service-event-buffer.test.ts` has no surrogate case. The ordering is confirmed by code read only.
- **[INFERENCE] wire encoding.** The tip read passes the raw `session_id` as a SQL literal (`this.q`, greptime.ts:859-861). A lone surrogate in a JS string is encoded as U+FFFD on the wire, so the read may key on a different session. Read-only: no write, no hash, no insert. Not tested.

Result: the requested claim is **not confirmed for the tip read**. It is confirmed for the buffer, the insert, the append-mode probe and the replay lookup. This is recorded as WARNING W-L2-TIP-ORDER. Making it a gap, or fixing it, is an owner decision. No code was changed by this pass.

### Doc Wording Check (docs/greptime-ledger.md)

| Point | Doc says | Code | Verdict |
| ----- | -------- | ---- | ------- |
| Flag values, sessioned clause | `SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER` set to `1`, `true` or `yes`; `SUBSTRATE_LEDGER_CHAIN_CACHE=0` turns the cache off | `config.ts:1194` accepts `1\|true\|yes` case-insensitively on the trimmed value; `config.ts:2439` turns the cache off for `0\|false\|no`. Gate at service.ts:3133-3138. | **Confirmed.** Two omissions, neither a contradiction: case-insensitive and trimmed matching; `false`/`no` also switch the cache off. |
| Replay appends no event | "a keyed replay answered from the ledger before the tip read appends no event" | Replay lookup at service.ts:3097-3099, before the tip read at 3117. A hit returns before any `lastHash` call (replayOutcome 3056-3089). A queued or given-up keyed replay returns at 3102-3108 with no write. **But** a hit whose `event_ingest` membership is missing calls `recordIngest` (service.ts:3080-3081), one ingest record. The doc states this at lines ~413-416. | **Accurate for `agent_events` only.** The unqualified word "event" hides the `event_ingest` repair write. Open. |
| Cache-off, sessionless and uncached-session clauses | A session with no cached tip during an outage is refused at the tip read; a sessionless write reads no tip | `chainTips` is null when the switch is off (greptime.ts:798). `lastHash` is called only when `sessionId` is set (service.ts:3113). Tip-unreadable refusal at service.ts:3126-3128, no buffering. | **Confirmed by code read.** Outage behaviour not exercised live (operator item 1). |

Owner stamp: the paragraph at docs/greptime-ledger.md:979 ends "Owner-accepted, 2026-11-03", and ROADMAP.md (Phase 76 status and progress row) records "the cache-off wording is ratified (owner, 2026-11-03)". This reconciles the stamp with the roadmap for the cache-off paragraph only. The replay-effect sentence has no recorded ratification. Stays open (operator item 9 in frontmatter).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-buffer.ts` | Bounded per-session FIFO, backoff, drop causes, file persistence | ✓ VERIFIED | Unchanged since 046fbe05; wired from service.ts:231 |
| `packages/mcp-server/src/event-dead-letter.ts` | Append-only JSONL dead-letter store with hash, reason, depth, durability | ✓ VERIFIED | Unchanged since 046fbe05; wired from service.ts:230 |
| `packages/mcp-server/src/service.ts` | Turn helper, buffering, drain, health, shutdown | ✓ VERIFIED | Unchanged since 046fbe05. `appendChained` 3091, `bufferEvent` 3185, `deliverBuffered` 3204, `drainPendingEvents` 3248, `eventBuffer` in health 8912 |
| `packages/mcp-server/src/event.ts` | Write-time refusal (W-L2) and phase-76 event normalisation | ✓ VERIFIED | Changed at 3e26a5c1: `FieldLoneSurrogateError` and `refuseLoneSurrogate` (:249-264), `withoutDanglingHigh` (:190-197), refusal calls (:371-374), summary cut (:392). Ordering: see W-L2 table above. |
| `packages/mcp-server/src/config.ts` | Six flags; boot refusal on missing dead-letter path or shared file | ✓ VERIFIED | Unchanged since 046fbe05; `loadEventBufferSettings` (:2601-2629) |
| `packages/mcp-server/src/reanchor-run.ts` | Isolated config nulls buffer | ✓ VERIFIED | `eventBuffer: null` at :279 |
| `packages/mcp-server/src/index.ts` | Shutdown calls drain | ✓ VERIFIED | `drainPendingEvents(SHUTDOWN_RETAIN_MS, { abandon: true })` at :258 |
| `packages/mcp-server/src/greptime.ts` | `insertEvent` with `mayExist`; tip cache | ✓ VERIFIED | Unchanged since 046fbe05; `mayExist` at :1248-1272; `chainTips` null when off (:798) |
| Debt markers (TBD, FIXME, XXX, TODO, HACK, PLACEHOLDER) in phase files | none allowed unreferenced | ✓ none found | Grep over `event.ts`, `event.test.ts`, `service.ts`, `event-buffer.ts`, `event-dead-letter.ts`, `config.ts`, `docs/greptime-ledger.md` returned no matches |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| service.ts | event-buffer.ts / event-dead-letter.ts | imports, `DeadLetterStore`, `EventBuffer` | ✓ WIRED | service.ts:230-231; constructed at :2093-2111 |
| appendChained | bufferEvent | write failure path | ✓ WIRED | service.ts:3169-3177; queued-behind path at :3143-3151 |
| appendChained | normalizeEvent (W-L2 refusal) | `build` at 3124 | ✓ WIRED, ordering ✗ for tip read | see W-L2 table |
| deliverBuffered | greptime.insertEvent | retry with `mayExist` | ✓ WIRED | service.ts:3214; greptime.ts:1262 |
| index.ts | drainPendingEvents | shutdown | ✓ WIRED | index.ts:258 |
| server.ts `/healthz` | eventBuffer | spread of `substrate.health()` | ✓ WIRED | no server change needed |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `EventBuffer.entries` | buffered event | `build(...)` from the real event normalised on write | ✓ | ✓ FLOWING |
| `/healthz eventBuffer.depth` | `stats().depth` | live `entries` size and `DeadLetterStore.depth()` | ✓ | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Buffered write, retry, exhaustion, ordering, replay, health, boot refusal; and the W-L2 `normalizeEvent` refusal cases (summary, session_id, repo by name; astral accept; cap cut) | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test packages/mcp-server/src/service-event-buffer.test.ts packages/mcp-server/src/event.test.ts --timeout 30000` | 86 pass, 0 fail, 220 expect() calls (17 in service-event-buffer.test.ts, 69 in event.test.ts). Stderr contains the expected blocker-test line `dead-letter store append failed (EEXIST)`. | ✓ PASS |

One targeted run, as assigned. Not run in this pass: `event-buffer.test.ts`, `event-dead-letter.test.ts`, the `greptime.test.ts` `mayExist` block, `service.test.ts`, `bun run config:reference -- --check`, `flag-registry.test.ts`, `config-reference.test.ts`. Their claims rest on the prior record and are not re-verified here.

### Probe Execution

No `scripts/*/tests/probe-*.sh` is declared or implied by this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R3 | none (ORPHANED) | Bounded queue with backpressure; failed batches retry with exponential backoff and jitter, then retain payload and error in a durable dead-letter store. REQUIREMENTS.md:120 and the traceability row at :138 map it to Phase 76 with "Not started". | ✗ ORPHANED | `76-01-PLAN.md` has no frontmatter `requirements:` field, so no plan claims HARD-R3. Code evidence covers most of its text, but the requirement says "each destination" and this phase has one ledger; "backpressure" is a refusal (`stored: false`) when the buffer is full; the dead-letter store is durable only with its path set. The REQUIREMENTS.md "Not started" status is unchanged. Not edited here. Requires orchestrator decision. |

### Anti-Patterns Found

- None blocking. Debt-marker scan returned nothing.
- ℹ️ Info: `refuseLoneSurrogate` checks the whole redacted summary before the 2,000-unit cap (event.ts:263 call site, comment above :261). A lone surrogate beyond the cap is refused even though the stored summary would drop it. The comment's phrase "which is what gets stored" is loose: it is the pre-cap redacted text. Behaviour matches the stated "before the length cap" rule.
- ⚠️ Warning: W-L2-TIP-ORDER (above).

### Human Verification Required

See the frontmatter `human_verification` list: operator items 1–8, plus owner ratification of the doc's replay-effect sentence. All are open. None is closed by this pass.

### Deferred Items

None.

### Advisory

None (not a re-verification).

### Gaps Summary

No truth FAILED. No artifact is missing or a stub. No key link is unwired. Status is `human_needed` because the open human items remain, and a WARNING is open. It is not `passed`.

Open, not closed by this pass:

- **W-L2-TIP-ORDER (WARNING)**: on sessioned writes the chain-tip read (service.ts:3117) runs before the surrogate refusal (service.ts:3124). The buffer, insert, append-mode probe and replay lookup are after the refusal. The owner decides whether to move the check ahead of the read and add a service-level test.
- **W-L2 open item (session_id and repo at 512 units)**: `normalizeIdentifier` = `clean(value, 512)` (event.ts:210-211, `slice(0, MAX_FIELD)` in `clean` at :180-184). The refusal runs on the raw input (event.ts:372-373), so a surrogate pair cut at 512 stores a lone high surrogate. Read and write use the same cut, so they agree. Trimming on write alone would split them. Still open: the owner decides between a shared `normalizeKey` at every site and leaving it.
- **W-L2 open item (branch, node_id, linear_identifier)**: they accept lone surrogates on write. `node_id` and `linear_identifier` use `normalizeIdentifier` (event.ts:384-385), and `branch` uses `clean` (event.ts:389), with no refusal call. Outside the owner's list. Still open.
- **D76-15**: enabling the buffer is an operator decision (item 7).
- **D76-14 and D76-19**: a buffered `session.end` closes steering at once (the code) while PLAN says it stays open until the note lands (item 5). The doc matches the code. Owner ratification is open.
- **R-1, R-2, R-3**: carried forward from the prior record (items 4 and 6). R-2 and R-3 were not re-proven in this pass.
- **Operator items 1–8**: live Greptime outage rehearsal, real exhaustion, torn-line restart, shutdown under the service manager, live steering session, live replay, the enablement decision, and `/healthz` staleness. Each needs a live system.
- **Doc precision points**: flag values and cache-off wording are ratified (ROADMAP, stamp at greptime-ledger.md:979). The replay-effect sentence is accurate for `agent_events` only and its ratification is not recorded. Open.
- **HARD-R3**: orphaned in REQUIREMENTS.md against Phase 76; no plan claims it.
- **Dead-letter cap**: a tracked follow-up under the override. SC2's literal dead-letter bound is not met.

---

_Verified: 2026-11-03T14:55:03Z_
_Verifier: Claude (gsd-verifier)_
