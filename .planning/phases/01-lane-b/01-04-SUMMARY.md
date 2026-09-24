---
phase: 01-lane-b
plan: 04
subsystem: infra
tags: [herdr, bun, node-net, systemd, socket, event-collector, terminal-workspace]

# Dependency graph
requires:
  - phase: 01-lane-b (01-01)
    provides: substrate-mcp's event/brief/graph HTTP surface, redact() PII scrubbing, EventInput/SURFACES/EVENT_KINDS union types
  - phase: 01-lane-b (01-02)
    provides: grok.ts/grok-map.ts collector pattern (offsets, fail-open emit, --once/--watch CLI, dropped-with-reason table) reused as the structural template
provides:
  - herdr-map.ts pure mapper from herdr pane events to substrate EventInput
  - herdr.ts Unix-socket ND-JSON collector with per-pane subscription, race-free bootstrap, and reconnect
  - substrate-collector-herdr.service systemd unit, installed and live on the VPS
  - Extended SURFACES/EVENT_KINDS unions in mcp-server/src/types.ts to admit the herdr surface
affects: [lane-b-completion, phase-01-verification, any-future-herdr-schema-change]

actuals:
  tokens: 5858
  tasks: 3
  commits: 3
plan_head_before: 7d6867cbf7516a1484e388e2b41a68d7999c5c3e

tech-stack:
  added: []
  patterns:
    - "Per-pane-per-socket-connection subscription — herdr 0.9.1 resets a connection on a second events.subscribe call, and one invalid pane_id inside a subscribe call's filter array kills the whole connection without acking any other filter in it. One connection per pane is not a style choice, it is the only architecture under which one failing pane cannot take any other pane down."
    - "lastSignature dedupe cache keyed by pane_id:event_type rather than a byte/line cursor, so a restart replay of an unchanged output_matched line is silently swallowed instead of re-emitted."
    - "Fail-open emit(): a POST /events failure returns false and is swallowed, never thrown, matching grok.ts. Trade-off found live in this plan: fail-open also means a hard rejection (400 unknown surface) produces no journal log line at all — see Deviations."

key-files:
  created:
    - packages/collectors/src/herdr-map.ts
    - packages/collectors/src/herdr-map.test.ts
    - packages/collectors/src/herdr.ts
    - infra/vps/substrate-collector-herdr.service
  modified:
    - packages/mcp-server/src/types.ts

key-decisions:
  - "Extended SURFACES with \"herdr\" and EVENT_KINDS with agent.detected/agent.status/agent.exited in mcp-server/src/types.ts (outside the plan's declared files_modified) because normalizeEvent's isSurface/isKind gate rejects anything not in these closed unions — without this every herdr event is uningestible. Verified no test asserted exact array contents before extending."
  - "matched_line (not output_matched/matched_text) is the real wire field for pane.output_matched's terminal text, confirmed via herdr api schema and a live socket probe against the running 0.9.1 server — the plan's prose named the field only informally."
  - "One herdr socket connection carries exactly one events.subscribe call, and that call is scoped to exactly one pane. Both constraints were discovered live (probe3: second subscribe on a connection resets it; probe5: one bad pane_id in a batched subscribe call kills the whole connection, acking nothing) and are why herdr.ts opens one persistent connection per pane rather than one connection for the whole session."
  - "Restarted substrate-mcp.service (not just the herdr collector) after committing the SURFACES/EVENT_KINDS fix — the running substrate-mcp process was started before this plan and had the old closed unions baked into its loaded module, so it kept rejecting surface:\"herdr\" with 400 even after the source fix landed. This is a production process, not a test double, and it needed an explicit restart to pick up a source change; a bun-run systemd unit does not hot-reload."

requirements-completed: [SC-3]

coverage:
  - id: D1
    description: "mapHerdrEvent maps each of herdr's 4 pane event types (agent_detected, agent_status_changed, exited, output_matched) to a typed EventInput, redacts output_matched's matched text, and defaults unknown types to a note rather than dropping them"
    requirement: SC-3
    verification:
      - kind: unit
        ref: "packages/collectors/src/herdr-map.test.ts — all 7 tests"
        status: pass
    human_judgment: false
  - id: D2
    description: "herdr.ts subscribes each live pane on its own connection, bootstraps via session.snapshot before trusting pushed events, picks up panes that appear after startup, and reconnects/resubscribes without restarting"
    requirement: SC-3
    verification:
      - kind: manual_procedural
        ref: "systemctl status substrate-collector-herdr (active, 1 pane subscribed, journal clean); collector restart after a substrate-mcp restart re-subscribed cleanly with 0 reconnect-loop lines"
        status: pass
    human_judgment: true
    rationale: "No agent was present in the one live pane during this session (session.snapshot returned agents: []), so the true 'drive a pane, watch an agent-status event arrive' path could not be exercised end to end with a real agent. Verified instead with a manually-issued but wire-real POST /events call carrying the pane's actual repo (/root/src/repos) and pane_id (w1:p1), which round-tripped through the real HTTP surface into Greptime and back out via /brief. A human should re-confirm by starting a real agent in a herdr pane once one is available."
  - id: D3
    description: "substrate-collector-herdr.service is installed, enabled, and running under systemd with Restart=always and the same hardening posture as the other collector units"
    requirement: SC-3
    verification:
      - kind: manual_procedural
        ref: "systemctl is-active substrate-collector-herdr -> active; unit file contains RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX"
        status: pass
    human_judgment: false

duration: ~35min
completed: 2026-09-24
status: complete
---

# Phase 01 Plan 04: herdr Runtime Collector Summary

**Per-pane Unix-socket collector for herdr 0.9.1 that turns pane lifecycle and output-match events into substrate EventInputs, running live under systemd.**

## Performance

- **Duration:** ~35min
- **Completed:** 2026-09-24
- **Tasks:** 3/3
- **Files modified:** 5 (4 declared + 1 deviation)

## Accomplishments
- Pure mapper (`herdr-map.ts`) turns herdr's 4 pane event types into typed `EventInput`s, redacting terminal text on `pane.output_matched` via the existing `redact()` scrubber, with an unrecognized-type fallback to a thin `note` rather than silent loss.
- Socket collector (`herdr.ts`) discovered and implements herdr 0.9.1's real wire constraints live: one `events.subscribe` per connection, one pane per connection, `session.snapshot` bootstrap before trusting any push, per-pane `lastSignature` dedupe so a restart never re-emits an unchanged `output_matched` line.
- systemd unit installed and live: `active`, one pane subscribed, clean startup log, `AF_UNIX` present in `RestrictAddressFamilies`, `Restart=always`.
- Found and fixed a real production gap: `substrate-mcp.service` was still running the pre-plan build of `types.ts` and rejected every `herdr` event with 400 until restarted — confirmed via a live wire probe, fixed, and reverified end-to-end (`POST /events` → 202 → visible in `/brief`).

## Task Commits

Each task was committed atomically:

1. **Task 1: Map herdr pane events onto EventInput** - `39f56a9` (feat, tdd)
2. **Task 2: Collect herdr's socket with per-pane subscriptions and a race-free bootstrap** - `cb2b346` (feat)
3. **Task 3: Install the herdr collector as a systemd unit** - `69329a7` (feat)

**Plan metadata:** (this commit, below)

## Files Created/Modified
- `packages/collectors/src/herdr-map.ts` - Pure mapper: herdr pane event + pane record → `EventInput | null`
- `packages/collectors/src/herdr-map.test.ts` - 7 table-driven tests covering all 4 event types, redaction, unknown-type fallback, repo attribution, and no-type drop
- `packages/collectors/src/herdr.ts` - Unix-socket ND-JSON collector: per-pane subscription, `session.snapshot` bootstrap, `lastSignature` dedupe, fail-open `emit()`, `--once`/`--watch`/`--session` CLI
- `infra/vps/substrate-collector-herdr.service` - systemd unit, copied from `substrate-collector-grok.service`'s hardening posture
- `packages/mcp-server/src/types.ts` - Added `"herdr"` to `SURFACES`, `"agent.detected"`/`"agent.status"`/`"agent.exited"` to `EVENT_KINDS` (deviation, see below)

## Decisions Made
- Reused `redact()` from `mcp-server/src/redact.ts` rather than duplicating PII scrubbing logic for `pane.output_matched`'s terminal text.
- Architected one persistent socket connection per pane (never batched), a hard requirement discovered live rather than a stylistic choice — see key-decisions in frontmatter.
- Repo attribution comes from the pane's `cwd` (falling back to `foreground_cwd`), matching D-02's addendum in CONTEXT.md.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2/3 - Missing critical functionality / blocking issue] Extended SURFACES and EVENT_KINDS closed unions**
- **Found during:** Task 1 (`herdr-map.ts`)
- **Issue:** `mcp-server/src/types.ts`'s `SURFACES` and `EVENT_KINDS` are closed TypeScript string-literal unions gating `event.ts`'s `isSurface`/`isKind` checks inside `normalizeEvent`. Without `"herdr"` and the three new kinds, every herdr event would fail ingestion with `InvalidEventError` — the whole plan would be inert at the substrate boundary.
- **Fix:** Added `"herdr"` to `SURFACES` and `"agent.detected"`, `"agent.status"`, `"agent.exited"` to `EVENT_KINDS`. Verified no existing test asserted the arrays' exact contents before extending.
- **Files modified:** `packages/mcp-server/src/types.ts`
- **Verification:** `bun test` held at 69 pass / 0 fail (baseline floor is 62); `bunx tsc --noEmit` clean.
- **Committed in:** `39f56a9` (part of Task 1's commit)

**2. [Rule 1 - Bug] Wrong assumed field name for output_matched's terminal text**
- **Found during:** Task 2 live protocol discovery
- **Issue:** `herdr-map.ts`'s first draft (Task 1) guessed the matched-text field was `output_matched` or `matched_text`, based on the plan's prose ("its matched terminal text"). Live inspection (`herdr api schema`) and a raw socket probe against the running 0.9.1 server showed the real field is `matched_line` on the pushed event's `data` object.
- **Fix:** Added `matched_line` as the primary lookup in `HerdrEvent`/`mapHerdrEvent`, keeping `output_matched`/`matched_text` as fallback aliases; updated the test fixture to use `matched_line`.
- **Files modified:** `packages/collectors/src/herdr-map.ts`, `packages/collectors/src/herdr-map.test.ts`
- **Verification:** 7/7 tests pass; `bunx tsc --noEmit` clean.
- **Committed in:** `cb2b346` (documented in the Task 2 commit message; discovered during Task 2's live probing even though the touched file was Task 1's)

**3. [Rule 3 - Blocking issue] substrate-mcp.service needed a restart to admit the herdr surface**
- **Found during:** Task 3 live verification
- **Issue:** After installing and starting the herdr collector, a manual `POST /events` probe with `surface: "herdr"` returned `400 {"error":"unknown surface: herdr"}` even though the `types.ts` fix (deviation 1) was committed. `substrate-mcp.service` runs `bun packages/mcp-server/src/index.ts` directly from source with no file-watch flag, and its live process had been started the day before this plan — it was still holding the pre-fix `SURFACES` union in its loaded module, so the collector's real emits were being silently rejected. Because `herdr.ts`'s `emit()` is deliberately fail-open (`return response.ok` — a non-2xx response is swallowed, not logged), nothing in the collector's own journal showed this failure; it was found only by manually reissuing the same POST the collector makes and reading the raw HTTP response.
- **Fix:** `sudo systemctl restart substrate-mcp` (a stateless, systemd-managed process with `Restart=always`; the restart is quick and reversible and does not touch herdr's own live terminal-session process). Reverified with the same manual probe: `202`, and the event became visible via `POST /brief`. Then restarted `substrate-collector-herdr` itself so its own subscription cycle ran cleanly against the fixed dependency; journal showed a clean resubscribe with 0 reconnect-loop lines.
- **Files modified:** none (operational fix only — no source change)
- **Verification:** Manual `POST /events` with `surface: "herdr"` → `202`; `POST /brief` for the pane's repo (`/root/src/repos`) then listed the event; collector restart logged `subscribed 1 pane(s)` with no errors.
- **Committed in:** n/a (infra/ops action, not a source change; no commit required)

---

**Total deviations:** 3 (1 Rule 2/3 type-union extension, 1 Rule 1 field-name bug fix, 1 Rule 3 operational restart)
**Impact on plan:** All three were necessary for the collector to actually work end-to-end at the substrate boundary; none represent scope creep beyond what Task 1-3's stated goals required.

## Issues Encountered

**herdr's server process is not a systemd unit.** `ps aux` shows herdr's own server as a bare long-running process (`/root/.local/bin/herdr server`, started independently of this plan, well before this session) rather than a unit named `herdr`. `systemctl restart herdr` (the literal form the plan's verify text suggested) fails with "Unit herdr.service not found." herdr's server is a shared, already-live production process this VPS's real terminal sessions depend on — per STATE.md's caution that this seam is shared with a running system — so it was not restarted or otherwise disturbed to force a reconnect test. What was verified instead: the collector's own restart (safe, self-owned) produces a clean resubscribe with 0 reconnect-loop lines in the journal, and the unit's `Restart=always`/`RestartSec=5` directives are in place so systemd will restart the collector itself if it ever exits. Full "kill herdr's server and watch the collector reconnect" verification is deferred to a human with authority to bounce that shared process; see coverage `D2` and `WINDOWS.md`.

**No agent was live in the one subscribed pane.** `session.snapshot` returned `agents: []` throughout this session, so the plan's `<human-check>` ("drive a pane... let its status change... confirm a herdr surfaced event... within a minute") could not be exercised with a genuine agent-status transition. The pipeline itself was proven end-to-end with a manually-issued, wire-real event carrying the pane's actual `pane_id`/`repo`, which is the strongest verification possible without either fabricating agent activity in a shared pane or waiting for a real one to appear. See coverage `D2`.

## User Setup Required

None - no external service configuration required. (The `substrate-mcp` and `substrate-collector-herdr` restarts performed during verification were operational, not configuration, and are already reflected in the live system state.)

## Next Phase Readiness
Lane B's herdr collector is live and emitting into the same substrate as grok's collector. Two verification items remain genuinely open pending a human with access to a live agent session in a herdr pane and authority to bounce herdr's shared server process — both logged to `WINDOWS.md` as `unrun-verify` rather than silently dropped. No code-level blockers for subsequent Lane B plans.

## Self-Check: PASSED

All created files confirmed present on disk; all 3 task commit hashes confirmed in `git log --oneline --all`.
