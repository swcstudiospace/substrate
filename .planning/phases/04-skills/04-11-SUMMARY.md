---
phase: 04-skills
plan: 11
subsystem: collectors
tags: [cursor, hooks, transcripts, redaction, fail-open, projector, d-15, t-04-11-01, t-04-11-02, t-04-11-03, t-04-11-05]

requires:
  - phase: 04-skills
    provides: 04-01 04-BASELINE.md (bun 338/0, tsc-exit=0) and /var/lib/substrate/phase4-baseline (RESTORE.md index, RESTORE.d per plan); 04-04 done (SUMMARY 96eda37)
  - phase: 03-lane-a
    provides: packages/projector/src/cursor.ts (substrate-managed entries, --check, backup); redact() in packages/mcp-server/src/redact.ts
provides:
  - packages/collectors/src/cursor-stop.ts — TRANSCRIPTS_DIR, CURSOR_ROOT, MAX_TRANSCRIPT_BYTES, parseStopInput, safeConversationId, transcriptSource, copyTranscript, runStop, stdin runner (5 s stdin timeout, 1.5 s POST /events, exit 0 always, no stdout)
  - packages/projector/src/cursor.ts — STOP_SCRIPT (env SUBSTRATE_CURSOR_STOP), script(), DESIRED.stop → cursor-stop.ts, --print-desired
  - event contract — session.end (surface cursor, actor human, session_id conversation_id) payload { conversation_id, transcript_ref, status } plus reason when there is no copy
  - live — /root/.cursor/hooks.json substrate-managed stop entry runs cursor-stop.ts; /var/lib/substrate/transcripts/cursor (0700, empty) for the 04-07 miner monitor
affects: [04-07, 04-12]

actuals:
  tokens: 5154       # chars/4 over the added lines of c29e8c5 and f48e26c (4 files, +529)
  tasks: 2
  commits: 3         # c29e8c5, f48e26c, plus this SUMMARY
plan_head_before: d6c3cd3

tech-stack:
  added: []
  patterns:
    - "A hook that must never break the host turn: pure exported helpers, one runStop that catches everything and returns a result, and an import.meta.main runner that always exits 0 and never writes stdout"
    - "Path containment by realpath first, then prefix check against the realpath of the root plus '/', then lstat of the resolved path — symlink escapes and prefix-sibling dirs are refused"
    - "Transcript files are named only from a validated id ([A-Za-z0-9-]{8,128}) and written tmp-<pid> + rename, 0600 in a 0700 dir"

key-files:
  created:
    - packages/collectors/src/cursor-stop.ts
    - packages/collectors/src/cursor-stop.test.ts
    - .planning/phases/04-skills/04-11-SMOKE.md
    - /var/lib/substrate/phase4-baseline/04-11/20260926T090800Z/{hooks.json,MANIFEST.sha256} (host, not in git)
    - /var/lib/substrate/phase4-baseline/RESTORE.d/04-11.md (host, not in git)
    - /var/lib/substrate/transcripts/cursor/ (host, 0700, empty)
  modified:
    - packages/projector/src/cursor.ts
    - /root/.cursor/hooks.json (substrate-managed stop entry only; projector refreshed hooks.json.substrate-backup)
    - /var/lib/substrate/phase4-baseline/RESTORE.md (index row for 04-11)

key-decisions:
  - "runStop emits session.end even for an invalid id or malformed envelope (no session_id, conversation_id null, reason set), so every Cursor stop is still visible in the substrate"
  - "Reasons are fixed strings: no transcript_path, transcript not found, transcript outside <root>, transcript not a regular file, invalid conversation_id, malformed envelope, too large, copy failed, hook error"
  - "The size cap is checked on stat and again on the bytes read, so a transcript growing between the two cannot slip past 20 MB"

requirements-completed: []

duration: ~15min
completed: 2026-09-26
---

# Phase 4 Plan 11: Cursor stop hook keeps a redacted transcript copy for the miner Summary

**Cursor's substrate stop hook now reads the stop envelope, copies an in-root transcript redact()ed to /var/lib/substrate/transcripts/cursor/<id>.jsonl (0600, dir 0700, ≤ 20 MB) and emits session.end naming it, failing open on every path (D-15).**

## Performance

- Tasks: 2 of 2, both autonomous; no checkpoint (the live Cursor session is 04-12's).
- Commits: c29e8c5 (Task 1), f48e26c (Task 2), plus this SUMMARY.

## Baselines (two-sided, against 04-BASELINE.md)

| Gate | Baseline | Now | Result |
|---|---|---|---|
| bun test (root, SUBSTRATE_DISABLED=1) | 338 pass / 0 fail | 503 pass / 0 fail, 27 files | failing-id diff empty, pass count grew |
| tsc normalized set | tsc-exit=0 | tsc-exit=0 | diff empty |
| cursor-stop.test.ts | new | 13 pass / 0 fail, 38 expect() | — |

The first Task 1 gate runs failed on sibling work in progress, not on this plan's files: run 1 had
13 TS errors in `packages/projector/src/skills.test.ts` (tsc-exit=nonzero), run 2 had one failing test
in the same file (`backup-then-link (D-06) > an identical real dir is backed up …`, 502/1). Neither
file is in 04-11's files_modified; the final re-run (after the sibling landed) exited 0 with
503 pass / 0 fail and tsc-exit=0.

## Accomplishments

- **cursor-stop.ts (T-04-11-01/02/03).** BOM-stripped envelope parse; id regex; realpath
  containment under /root/.cursor/ (symlink escape and `/root/.cursor-evil` prefix-sibling refused);
  redact() then tmp-<pid> + rename to 0600 in a 0700 dir; 20 MB cap; emit bounded at 1.5 s; stdin
  bounded at 5 s; every path exits 0 and prints nothing.
- **cursor.ts.** `stop` is now `bun /root/src/repos/agent-substrate/packages/collectors/src/cursor-stop.ts >/dev/null 2>&1 || true`
  (substrate-managed, stdin inherited, overridable with SUBSTRATE_CURSOR_STOP); sessionStart and
  postToolUse byte-identical; `--print-desired` prints DESIRED as JSON and touches no file.
- **Live projection (T-04-11-05).** `--check` 1 (`~ stop`) → projector `~ stop` → `--check` 0;
  gsd-managed 6 before and after; a JSON diff against the snapshot shows only the `stop` list changed,
  and within it only the substrate-managed entry.
- **Live fail-open.** null path, `/etc/hostname`, and `not json` each exited 0 with 0 bytes of
  stdout and stderr in 289–499 ms; the transcripts dir stayed empty and 0700 (no synthetic
  transcript, D-15).

## Task Commits

1. **Task 1: cursor-stop.ts + tests + projector stop entry** — `c29e8c5` (feat)
2. **Task 2: project hooks.json, live fail-open evidence** — `f48e26c` (docs)

## Verify results

- Task 1 `<verify>`: exit 0 (final run). Tail: `13 pass / 0 fail` (cursor-stop.test.ts); python
  `ok`; tsc diff empty; failing-id diff empty; `503 pass` > `agent-substrate-pass=338`.
- Task 2 `<verify>`: exit 0. Tail: `[projector] /root/.cursor/hooks.json already current (6 gsd-managed entries untouched)`.

## Files Created/Modified

- `packages/collectors/src/cursor-stop.ts` — the stop hook module and runner.
- `packages/collectors/src/cursor-stop.test.ts` — 13 tests over every behavior bullet.
- `packages/projector/src/cursor.ts` — STOP_SCRIPT, script(), --print-desired, docblock.
- `.planning/phases/04-skills/04-11-SMOKE.md` — projection and fail-open evidence with the column-0 keys.

## Decisions Made

See key-decisions in the frontmatter.

## Deviations from Plan

None in scope. Additions the plan implies but does not spell out: the RESTORE.md index row for 04-11
(following 04-04's convention), and tests for a prefix-sibling root (`<root>-evil`) and for the
invalid-id / malformed-envelope emit.

## Issues Encountered

- Sibling-owned `packages/projector/src/skills.test.ts` briefly broke tsc and one test mid-wave;
  attributed above, not touched.
- The posted `session.end` events were not read back (no HTTP event-read route); acceptance is
  inferred from the anonymous `/healthz` 200 behind the same auth gate as `/events` [INFERENCE].

## User Setup Required

None here. The first real transcript copy needs the owner's Cursor session in 04-12.

## Next Phase Readiness

- 04-07's monitor can list `/var/lib/substrate/transcripts/cursor/*.jsonl`; the dir exists (0700, empty).
- 04-12: when a Cursor session ends with transcripts enabled, expect `<conversation_id>.jsonl`
  mode 600 there and a session.end with a non-null transcript_ref. If transcript_path is null
  (Cursor transcripts off), the event carries reason `no transcript_path` and nothing is copied.

## Self-Check: PASSED

- Files exist: cursor-stop.ts, cursor-stop.test.ts, 04-11-SMOKE.md; cursor.ts modified.
- Commits exist: c29e8c5, f48e26c.
- Live: hooks.json stop entry runs cursor-stop.ts; `cursor.ts --check` exit 0; RESTORE.d/04-11.md has the hooks.json route.
