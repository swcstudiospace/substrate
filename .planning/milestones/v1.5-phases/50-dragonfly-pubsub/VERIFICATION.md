---
phase: 50-dragonfly-pubsub
verified: 2026-11-12T08:38:56Z
status: human_needed
score: 2/2 must-haves verified in-repo (wake-up hints proven against fakes, with tests); live Dragonfly subscription and measured wake-up latency are human_needed (operator-gated, not run)
behavior_unverified: 0
overrides_applied: 0
covered_files: [".env.example", ".planning/milestones/v1.5-phases/50-dragonfly-pubsub/PLAN.md", ".planning/milestones/v1.5-phases/50-dragonfly-pubsub/SUMMARY.md", "docs/config-reference.md", "docs/data-planes.md", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-bus.test.ts", "packages/mcp-server/src/event-bus.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/server.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:7fb2c80ff110442e02498e508b08a17e630a0e1992d9d7f67bb95c707e00688c"
re_verification:
  previous_status: human_needed
  previous_score: 1 of 1 acceptance criterion proven in-repo
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Run substrate-mcp with SUBSTRATE_EVENT_BUS=on against a live Dragonfly (DRAGONFLY_URL accepted by the endpoint policy). Open GET /events/stream, emit one event, and time the frame's arrival."
    expected: "The subscriber receives a six-field hint on substrate:v1:events; the stream delivers the new event from the ledger well before STREAM_IDLE_MS; /healthz.eventBus.published increments and failed stays 0."
    why_human: "A live Dragonfly subscription and a measured wake-up latency need a running cache and an operator-approved environment; the repo proves the path only against fakes."
---

> Re-verification of the archived phase 50 (SOTA-06). The previous VERIFICATION.md (2026-10-21) had status human_needed; this run checked the current code against the same criteria. No gaps.

# 50-VERIFICATION: Dragonfly pub/sub for real-time event notifications

**Phase Goal:** Dragonfly pub/sub propagates Greptime events to the planes in real time (ROADMAP success criteria: 1. real-time notifications for events via Dragonfly; 2. tests). Event-driven cache invalidation is named in the goal but was narrowed out of scope by the owner (D50-e, 2026-10-22); it is not a must-have here.
**Verified:** 2026-11-12T08:38:56Z
**Status:** human_needed
**Re-verification:** Yes — re-run against current code; prior result unchanged

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | Emit publishes a six-field wake-up hint after the ledger write; no summary, payload or text on the wire | ✓ VERIFIED | `service.ts:2791` calls `publishHint` after `result.stored`; `service.ts:2800-2804` builds `{v,id,kind,surface,graph_id,ts}` and fire-and-forgets `bus.publish`. `event-bus.ts` `publish` rebuilds the message from the six named fields. `service.test.ts:817` ("exactly one hint… no summary and no payload") passes. |
| 2 | Real-time: a hint wakes an idle `/events/stream` reader, which reads the ledger before its idle timeout | ✓ VERIFIED | `server.ts:2659-2667` `wake()` → `tick()`; `bus.subscribe(() => wake())`; `setInterval(tick, pollMs)`. `server.test.ts` "a hint wakes an idle stream…" (60 s poll and idle) passes; "a hint that arrives during a ledger read…" passes; "releases it when the response closes" passes. |
| 3 | Publish failure is counted and never fails the emit | ✓ VERIFIED | `event-bus.ts` `publish` returns false and never throws (catch → `dropPublisher`, `publishFailed`); `service.test.ts:844` ("a publish failure does not fail the emit") passes. |
| 4 | Subscription reconnects with 1 s → 30 s backoff; oversize hints dropped, not truncated; malformed ignored | ✓ VERIFIED | `event-bus.ts` `RECONNECT_MIN_MS=1000`, `RECONNECT_MAX_MS=30000`, `MAX_HINT_BYTES=1024`; `event-bus.test.ts` backoff, oversize and malformed tests pass (20/20 in file). |
| 5 | Bus off by default; on without an accepted endpoint is off with a reason; bad value refuses boot | ✓ VERIFIED | `config.ts:1687-1700` `loadEventBusSettings`; `service.test.ts:858-876` passes; `flag-registry.ts:603` row present; `event-bus.ts` `createEventBus` returns null when disabled or URL blank. |
| 6 | Cache stays closed (no pub/sub in `cache.ts`) | ✓ VERIFIED | `cache-conformance.test.ts` passes (5 tests); `cache.ts` is not in covered files. |
| 7 | Live Dragonfly subscription and wake-up latency | ? UNCERTAIN (human) | Not run: no live Dragonfly was started and `127.0.0.1:5432` refuses TCP. See Human Verification. |

**Score:** 2/2 must-haves verified in-repo (SC 1 and SC 2 each proven against fakes; the live half of SC 1 is human_needed). `behavior_unverified: 0`: every behavior-dependent truth (reconnect, stop, unsubscribe-on-close, wake-during-read) has a passing named test.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event-bus.ts` | Bus: publish, subscribe, backoff, stop | ✓ VERIFIED | 306 lines; exports `createEventBus`, `EVENT_BUS_CHANNEL`, `MAX_HINT_BYTES`, `PUBLISH_DEADLINE_MS`, `RECONNECT_*` |
| `packages/mcp-server/src/event-bus.test.ts` | Bus tests with fake client | ✓ VERIFIED | 512 lines; 20 pass, 0 fail (SUMMARY says 18; the file now has 20) |
| `packages/mcp-server/src/service.ts` | Emit publishes; production bus | ✓ VERIFIED | `publishHint` :2800; `productionEventBus` :1427; `eventBusHealth` :8752 |
| `packages/mcp-server/src/server.ts` | `/events/stream` wakes on hint | ✓ VERIFIED | :2659-2667; `cleanup` unsubscribes on close (:2545) |
| `packages/mcp-server/src/config.ts` | `SUBSTRATE_EVENT_BUS` parse | ✓ VERIFIED | `loadEventBusSettings` :1687 |
| `packages/mcp-server/src/flag-registry.ts` | Flag row | ✓ VERIFIED | :603 |
| `docs/data-planes.md` | Pub/sub statement revised; wake-up hints section | ✓ VERIFIED | :28 (revised cache row); :212-224 "Event wake-up hints" |
| `docs/config-reference.md` | Regenerated | ✓ VERIFIED | `config:reference -- --check` → "up to date" |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` emit | `event-bus.ts` publish | `publishHint` after `result.stored` | ✓ WIRED | `service.ts:2791, 2800-2804` |
| `server.ts` `/events/stream` | `event-bus.ts` subscribe | `bus.subscribe(() => wake())` | ✓ WIRED | `server.ts:2667`; unsubscribed in `cleanup` (:2545) |
| `service.ts` productionEventBus | `createEventBus` | `config.eventBus` | ✓ WIRED | `service.ts:1427-1440` |
| `config.ts` | `service.ts` | `config.eventBus` | ✓ WIRED | `config.ts:770, 1303` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `server.ts` stream tick | `positions` / `rows` | `greptime.eventIdsAfter` / `eventsByIds` (ledger) | Yes. Hints carry no data; the ledger is read | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Bus unit tests (publish fields, backoff, oversize, malformed, stop, off gives null) | `cd packages/mcp-server && bun test src/event-bus.test.ts` | 20 pass, 0 fail | ✓ PASS |
| Emit wiring (one hint after write, publish failure safe, bus off, env values) | `bun test packages/mcp-server/src/service.test.ts -t "event bus"` | 7 pass, 0 fail | ✓ PASS |
| Stream wake (hint wakes idle stream; wake during read; release on close; bus off polls) | `bun test packages/mcp-server/src/server.test.ts -t "stream"` | 20 pass, 0 fail | ✓ PASS |
| Cache conformance (cache command set stays closed) | `bun test packages/mcp-server/src/cache-conformance.test.ts` | 5 pass, 0 fail | ✓ PASS |
| Config reference is current | `bun run config:reference -- --check` | "config reference: up to date" | ✓ PASS |
| Config tests for the bus | `bun test packages/mcp-server/src/config.test.ts -t "event bus\|EVENT_BUS"` | 0 tests matched; the bus settings tests live in `service.test.ts`, run above | ? SKIP (no matching tests in that file) |

Not run: the full `bun test` suite and `bun run check:phase-close` (not required for this re-verification; the prior run recorded them green). No live Dragonfly or Postgres was used.

### Probe Execution

No probe scripts declared or found for this phase (`scripts/*/tests/probe-*.sh`: none). Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| SOTA-06 | 50-PLAN.md | Dragonfly Pub/Sub for Real-time Events | ✓ SATISFIED (in repo) | Truths 1-6 above; REQUIREMENTS.md line 179: "Complete in repo; live proof operator-gated" |

No orphaned requirements: SOTA-06 is the only requirement mapped to phase 50.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (all covered files) | — | TBD / FIXME / XXX | — | None found |

### Human Verification Required

### 1. Live Dragonfly wake-up path and latency

**Test:** Run `substrate-mcp` with `SUBSTRATE_EVENT_BUS=on` against a live Dragonfly whose `DRAGONFLY_URL` the endpoint policy accepts. Open `GET /events/stream`, emit one event, and time the arrival of its frame.
**Expected:** The subscriber receives a six-field hint on `substrate:v1:events`; the stream delivers the event from the ledger well before `STREAM_IDLE_MS`; `/healthz.eventBus.published` increments and `failed` stays 0.
**Why human:** Needs a running cache and an operator-approved environment. The repo proves the path only against fakes.

### Gaps Summary

No gaps. Both roadmap success criteria are met in the repository and their tests pass. The status is `human_needed` only because the live Dragonfly subscription and measured latency are operator-gated and were not run. Event-driven cache invalidation (named in the goal) is out of scope per D50-e and is not counted as a gap.

---

_Verified: 2026-11-12T08:38:56Z_
_Verifier: Claude (gsd-verifier)_
