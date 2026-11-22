---
phase: 19-lane-b-collectors
verified: 2026-11-18T12:21:49Z
status: human_needed
score: 3/5 roadmap success criteria verified (2 present and wired, behavior not exercised on this tree)
covered_files: [".planning/milestones/v1.3-phases/19-lane-b-collectors/19-01-PLAN.md", ".planning/milestones/v1.3-phases/19-lane-b-collectors/19-01-SUMMARY.md", ".planning/milestones/v1.3-phases/19-lane-b-collectors/19-02-PLAN.md", ".planning/milestones/v1.3-phases/19-lane-b-collectors/19-02-SUMMARY.md", ".planning/milestones/v1.3-phases/19-lane-b-collectors/19-03-PLAN.md", ".planning/milestones/v1.3-phases/19-lane-b-collectors/19-03-SUMMARY.md", ".planning/milestones/v1.3-phases/19-lane-b-collectors/19-04-PLAN.md", ".planning/milestones/v1.3-phases/19-lane-b-collectors/19-04-SUMMARY.md", ".planning/milestones/v1.3-phases/19-lane-b-collectors/19-05-PLAN.md", ".planning/milestones/v1.3-phases/19-lane-b-collectors/19-05-SUMMARY.md", "infra/vps/substrate-collector-herdr.service", "infra/vps/substrate-collector-muse.service", "packages/collectors/src/cursor-stop.ts", "packages/collectors/src/emit.ts", "packages/collectors/src/herdr-map.ts", "packages/collectors/src/herdr-state.ts", "packages/collectors/src/herdr.ts", "packages/collectors/src/muse.ts", "packages/collectors/src/status.ts", "packages/projector/src/cursor.ts", "packages/projector/src/muse.ts", "scripts/laneb-proof.ts"]
covered_digest: "v3:sha256:4fd7b8f08f2437140a8dd58b4b1a8b8ea0af339c72438d1378e01e085525d3c8"
behavior_unverified: 2
overrides_applied: 0
behavior_unverified_items:
  - truth: "SC1: a herdr pane going working -> idle in repo R appears in events_query(repo=R) within 10 s as a note with payload.status and runtime herdr (detection and exit as session.start / session.end)"
    test: "Run the isolated rehearsal and proof on this HEAD: rehearsal up p19; bun run proof:laneb; rehearsal down"
    expected: "events_query(repo=R) returns the note, session.start and session.end, each observed within 10 s of its action; proof reports 27/27 or more with zero refused emits"
    why_human: "The 10 s end-to-end timing exists only in the archived 2026-10-10 proof run (41/41 on an earlier tree). Unit tests cover the mapping and transport, not the live query path on this tree."
  - truth: "SC3: R's .substrate/BRIEF.md lists both the herdr note and the Muse tool call on its next 5-minute refresh"
    test: "Same proof run as SC1; read BRIEF.md after the next writer pass"
    expected: "BRIEF.md contains the herdr note and the muse tool call and the rehearsal slug (proof checks 14-15)"
    why_human: "The listing depends on the live /brief server, which is outside this phase's code. The writer behaviour (300 s cadence, byte-identical on failed fetch, single pointer) is covered by passing unit tests; the listing itself was only observed in the archived run."
overrides: []
re_verification:
  previous_status: passed (archived v1.3 record, 2026-10-11, HEAD 5f495ad / ed696ef)
  previous_score: 28/28 must-haves
  gaps_closed: []
  gaps_remaining: []
  regressions: []
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 19: Lane B collectors Verification Report

**Phase Goal:** What herdr panes, Muse and Cursor sessions do on this host reaches the event log under main's vocabulary from code on `main`, and every Muse repo carries a fresh, redacted brief.
**Verified:** 2026-11-18T12:21:49Z
**Status:** human_needed
**Checkout:** `/root/src/worktrees/as-autonomous`, branch `gsd/autonomous-rerun`, HEAD `357d6b15`
**Scope note:** The active `.planning/phases/` tree has no PLAN or SUMMARY for phase 19. Those artifacts, and the archived v1.3 verification, live in `.planning/milestones/v1.3-phases/19-lane-b-collectors/`. This report verifies the current code against the roadmap success criteria. It does not rely on the archived SUMMARY claims.

## Method

- Roadmap contract read with `gsd-tools query roadmap.get-phase 19` (5 success criteria).
- Code evidence read directly: `packages/collectors/src/{herdr-map,herdr,herdr-state,emit,status,muse,cursor-stop}.ts`, `packages/projector/src/{muse,cursor}.ts`, `infra/vps/substrate-collector-{herdr,muse}.service`, `scripts/laneb-proof.ts`.
- Targeted test run on this HEAD in an isolated env (`env -i`, owned temp HOME and TMPDIR, `bun --no-env-file test`, no `SUBSTRATE_*` variables, no host `/etc/substrate` credentials): 9 files, **114 pass, 0 fail**. Files: `herdr-map`, `herdr`, `herdr-state`, `muse`, `cursor-stop`, `emit`, `status` (collectors) and `muse`, `cursor` (projector).
- Not run: the live rehearsal stack and `bun run proof:laneb`, per the assignment. The archived proof is cited but not re-observed.

## Goal Achievement

### Observable Truths

| # | Truth (roadmap success criterion) | Status | Evidence |
|---|---|---|---|
| 1 | Herdr pane working → idle in repo R reaches `events_query(repo=R)` within 10 s as `note` with `payload.status`, `runtime: herdr`, surface herdr detected, R's origin slug; detection and exit as `session.start` / `session.end` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `herdr-map.ts:125-153`: `runtime: "herdr"` in payload; `herdr.agent_detected`→`session.start`, `herdr.status_changed`→`note` with `payload.status`, `herdr.pane_exited`→`session.end`; surface and repo carried from transition. Tests: `herdr-map` "transition conformance > each herdr row keeps kind, surface, runtime and repo" PASS; `herdr` "two near-simultaneous pushes yield one session.start" PASS. Poll `POLL_MS=5000` + `DEBOUNCE_MS=150` (`herdr.ts:28-29`, `:208`). The 10 s end-to-end query on this tree was not observed. Archived run (19-PROOF.md) observed it on 2026-10-10 on an earlier tree. |
| 2 | Muse tool call in R appears as `tool.call` from surface `muse`, with repo and branch from git, emitted by a hook importing the redactor from a stable installed path | ✓ VERIFIED | `projector/src/muse.ts:101-110, 183` (`tool.call`, `surface: muse`, `muse.tool_call` source); `:27-28, 265-307` copies `packages/mcp-server/src/redact.ts` into the installed plugin as `hooks/redact.ts` and refuses any import in it; hook line `:106` `import { redact, redactValue } from "./redact.ts"`. Tests: projector `muse` "generated muse hook > emits tool.call from muse with the origin slug, branch and payload" PASS; "--bundle-only writes the redactor bytes and a config with no token value" PASS. |
| 3 | R's `.substrate/BRIEF.md` lists both events on its next 5-minute refresh; `AGENTS.md` keeps exactly one pointer; a failed `/brief` fetch leaves the last good file | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Cadence: `muse.ts:34` `POLL_MS = 300_000`. Writer: `fetchBrief` `:196-212` (non-2xx/empty/network → `ok:false`); `:405-421` writes only on success via `writeIfChanged` (tmp+rename, `:215`). Pointer: `ensurePointer` `:262-298` single block, orphan marker left alone. Tests PASS: "every failed fetch leaves BRIEF.md byte-identical and still ensures the pointer", "duplicate blocks collapse at the first", "an unchanged brief is not rewritten", "a down ledger writes no brief". The claim that the listing includes both events depends on the live `/brief` server, outside this phase's code. The proof script asserts it (`scripts/laneb-proof.ts:303`), but the run was not repeated here. |
| 4 | A stopped substrate never blocks herdr, Muse or Cursor; collectors resume from saved offsets after restart; refused emits counted and visible; zero in proof run | ✓ VERIFIED | Non-blocking: `emit.ts:62-66` `HOOK_TIMEOUT_MS=1500`, `COLLECTOR_TIMEOUT_MS=3000`. Tests PASS: projector muse "a dead url exits 0 with empty stdout", "an open stdin cannot hold the turn", "a collector that never answers cannot hold the turn past the budget". Resume: `herdr-state.ts:175-202` load/save by tmp+rename; test "state file > version 2 round-trips ... and a restart stays silent" PASS; "a graph named at start stays on the pane record" PASS. Visibility: `status.ts` aggregates refused counters and `refused-emits.jsonl`; tests "summarize counters", "refused lines", "collectors:status CLI" PASS. Zero refused in the proof run is archived (27/27 on 2026-10-10, 41/41 later); not re-run here. |
| 5 | Cursor `stop` hook, run from `main`, copies a redacted transcript to `/var/lib/substrate/transcripts/cursor` and emits `session.end` | ✓ VERIFIED | `cursor-stop.ts:32` `TRANSCRIPTS_DIR`; `:168-` `copyTranscript` writes through `redact()` (0600 file, 0700 dir, tmp+rename, `O_NOFOLLOW`, 20 MB cap); `session.end` posted via `postEvent`. `projector/src/cursor.ts:29, 38, 74` wires `stop: script(STOP_SCRIPT)` to `packages/collectors/src/cursor-stop.ts` (overridable by `SUBSTRATE_CURSOR_STOP`). Tests PASS: cursor-stop "copies an in-root transcript and emits session.end naming it", "writes a redacted 0600 copy into a 0700 dir through a tmp name", "refuses a source over the size cap", projector cursor tests. |

**Score:** 3/5 truths verified (criteria 2, 4, 5). Criteria 1 and 3 are present and wired; their live behavior is not exercised on this tree.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/collectors/src/herdr-map.ts` | mapping to main vocabulary | ✓ VERIFIED | `transitionToEvent` with `runtime: herdr`; tests pass |
| `packages/collectors/src/herdr.ts`, `herdr-state.ts` | poll, transport, offset state | ✓ VERIFIED | v2 state file, tmp+rename save; tests pass |
| `packages/collectors/src/emit.ts` | `postEvent` never throws; 202/4xx/5xx classification | ✓ VERIFIED | tests "postEvent outcomes" PASS |
| `packages/collectors/src/status.ts` | counters and refused lines | ✓ VERIFIED | tests PASS |
| `packages/collectors/src/muse.ts` | brief writer and pointer | ✓ VERIFIED (code) / ⚠️ live listing unverified | tests PASS |
| `packages/collectors/src/cursor-stop.ts` | redacted copy and `session.end` | ✓ VERIFIED | tests PASS |
| `packages/projector/src/muse.ts` | bundle with hook and redactor copy | ✓ VERIFIED | tests PASS |
| `packages/projector/src/cursor.ts` | `stop` hook wiring | ✓ VERIFIED | `stop: script(STOP_SCRIPT)` at `:74` |
| `infra/vps/substrate-collector-herdr.service`, `…-muse.service` | units present | ✓ VERIFIED | files present on this HEAD; `systemd-analyze verify` was archived, not re-run |
| `scripts/laneb-proof.ts` | isolated LANEB-07 proof | ✓ VERIFIED (present) | not executed here |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| herdr collector | `postEvent` → `/events` | `emit.ts` | ✓ WIRED | used by herdr and cursor-stop paths |
| Muse hook bundle | `redact.ts` | copied to `hooks/redact.ts`, import `./redact.ts` | ✓ WIRED | `projector/src/muse.ts:106, 292, 307` |
| `muse.ts` writer | `/brief` and `AGENTS.md` / `BRIEF.md` | `fetchBrief`, `ensurePointer`, `writeIfChanged` | ✓ WIRED | tests PASS |
| Cursor `hooks.json` stop | `cursor-stop.ts` | `projector/src/cursor.ts:74` | ✓ WIRED | |

### Requirements Coverage

Roadmap requirements `LANEB-01, LANEB-02, LANEB-03, LANEB-04, LANEB-05, LANEB-07, SKILL-06` map to criteria 1–5 above. LANEB-03 (fresh redacted brief plus one pointer) is code-verified. LANEB-07 (isolated proof) is present in the script, and its run is recorded only in the archive. No orphaned requirements were found in `.planning/REQUIREMENTS.md` for this phase.

### Anti-Patterns Found

None blocking. No TODO, FIXME, or XXX markers were found in the phase 19 collector files listed above. Known failures F-01 (`scripts/rehearsal.test.ts`) and F-02 (`packages/cli/src/token.test.ts`) recorded in the archive are outside this phase's files and were not re-run.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Targeted phase 19 collector and projector tests | `bun --no-env-file test` on 9 named files, isolated env | 114 pass, 0 fail | ✓ PASS |
| Live herdr → events_query within 10 s; BRIEF lists events | `rehearsal up p19; bun run proof:laneb; rehearsal down` | not run (live stack, out of scope) | ? SKIP |

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes are declared for this phase. Skipped.

## Human Verification Required

### 1. Isolated live proof on this HEAD

**Test:** From the repo root, `rehearsal up p19`, then `bun run proof:laneb`, then `rehearsal down`. Run under the owned, non-production HOME and TMPDIR described in `docs/runbooks/lane-b-collectors.md`.
**Expected:** Proof reports all checks passing (at least the 27 recorded in v1.3). It shows the herdr `session.start`, `note` and `session.end` in `events_query(repo=R)` within 10 s of each action. `BRIEF.md` lists the herdr note and the Muse tool call. `collectors:status` shows zero refused emits.
**Why human:** This needs the rehearsal harness and a real herdr 0.9.1 server. The 10 s timing and the brief listing are proven only in the archived run, which used an earlier tree (HEAD `5f495ad` / `ed696ef`). Verification here was static and unit-level only, per the assignment.

### 2. Operator-gated production steps (not a success criterion)

Production collector unit restart onto `main`, user-scope Muse projection, `/root/.cursor/hooks.json` edits, and Cursor credential rotation are operator actions. The roadmap excludes them from the proof. They are listed here so the human can track them. They do not change this verdict.

## Gaps Summary

No gaps. Every criterion has code and passing tests on this HEAD. Two criteria (1 and 3) have their live end-to-end behavior (10 s query, brief listing both events) proven only in the archived 2026-10-10 run. Those are routed to human verification and do not count toward the score.

---

_Verified: 2026-11-18T12:21:49Z_
_Verifier: Claude (gsd-verifier)_
