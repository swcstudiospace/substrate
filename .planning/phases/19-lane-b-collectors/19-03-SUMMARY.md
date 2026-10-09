---
phase: 19-lane-b-collectors
plan: 19-03
subsystem: collectors
tags: [muse, cursor, projector, redact]

requires:
  - phase: 19-02
    provides: shared emit, git-context, herdr collector
provides:
  - Muse brief writer that stores a redacted BRIEF.md and one AGENTS.md pointer and emits nothing
  - Cursor stop hook that copies a redacted transcript and emits session.end
  - Projector stop entry byte-identical to the live hooks.json command
affects: [19-04, 19-05]

tech-stack:
  added: []
  patterns:
    - "Collectors read SUBSTRATE_URL and SUBSTRATE_TOKEN at call time and post through emit.ts"
    - "Transcript copies and brief writes use tmp plus rename with an explicit mode"

key-files:
  created:
    - packages/collectors/src/muse.ts
    - packages/collectors/src/muse.test.ts
    - packages/collectors/src/cursor-stop.ts
    - packages/collectors/src/cursor-stop.test.ts
    - packages/projector/src/cursor.test.ts
  modified:
    - packages/projector/src/cursor.ts

key-decisions:
  - "The brief writer never posts /events. stored, refused and failed stay zero; fetch_failed, no_slug and orphan_pointer are the counters that move."
  - "A ledger that is not greptime true skips every brief for that pass and still ensures the pointer."
  - "Stop copies only a regular file whose realpath stays under the Cursor root. The projector stop command is the live hooks line, not a CLI emit."

patterns-established:
  - "hookPaths() reads SUBSTRATE_CURSOR_ROOT and SUBSTRATE_TRANSCRIPTS_DIR when the hook runs."
  - "A refusing substrate appends one JSON line under the state dir and the hook still exits 0 with empty stdout."

requirements-completed: [LANEB-03, SKILL-06]

coverage:
  - id: D1
    description: "Muse writes a redacted slug-keyed brief, one pointer, and no events; a down ledger or a bad fetch leaves BRIEF.md unchanged"
    requirement: "LANEB-03"
    verification:
      - kind: unit
        ref: "packages/collectors/src/muse.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Cursor stop copies an in-root transcript at 0600, emits session.end, and records a 400 as a refused line with empty stdout"
    requirement: "SKILL-06"
    verification:
      - kind: unit
        ref: "packages/collectors/src/cursor-stop.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Projector --print-desired stop command matches the live hooks entry and --check is already current"
    requirement: "SKILL-06"
    verification:
      - kind: unit
        ref: "packages/projector/src/cursor.test.ts"
        status: pass
      - kind: other
        ref: "bun packages/projector/src/cursor.ts --check against /root/.cursor/hooks.json"
        status: pass
    human_judgment: false

duration: ~40min
completed: 2026-10-09
status: complete
---

# Phase 19 Plan 03: Muse writer and Cursor stop Summary

**Each listed repo gets one redacted brief and one AGENTS.md pointer, and a Cursor stop copies a contained transcript before emitting session.end.**

## Performance

- **Duration:** ~40 min
- **Tasks:** 3/3 complete, 2 commits (2 task; this summary follows)
- **Completed:** 2026-10-09

## Accomplishments

- **Brief writer (462c561).** `muse.ts` requires `SUBSTRATE_MUSE_REPOS`. One `GET /healthz` per pass. `greptime !== true` counts `fetch_failed` with reason `ledger_unavailable` and does not call `/brief`. A missing origin slug counts `no_slug` and skips the repo. A good brief is redacted and written to `<repo>/.substrate/BRIEF.md` by tmp + rename, skipping unchanged bytes. Failed fetches leave that file byte-identical and still ensure the pointer and the exclude line. The pointer collapses to one marker block. An orphan start leaves the file untouched. The writer emits no events.
- **Stop hook (d028a65).** `cursor-stop.ts` accepts a conversation id of 8–128 letters, digits and hyphens, refuses a transcript whose realpath leaves the Cursor root or is not a regular file, caps the copy at 20 MB, and writes `0600` into a `0700` directory. The event is `session.end` with surface `cursor` and actor `human`. Env overrides are read at call time. A 400 from the substrate appends one refused line and the process exits 0 with empty stdout.
- **Projector (d028a65).** `stop` is `bun /root/src/repos/agent-substrate/packages/collectors/src/cursor-stop.ts >/dev/null 2>&1 || true`. `--print-desired` prints that JSON and exits before any file read. `--check` against the live hooks file reports already current and does not write.

## Verification

- `bun test packages/collectors/src/muse.test.ts` — 13 pass
- `bun test packages/collectors/src/cursor-stop.test.ts` — 15 pass
- `bun test packages/projector/src/cursor.test.ts` — 2 pass
- `bun test packages/mcp-server/src/redact-lock.test.ts` — 18 pass
- `bun test packages/mcp-server/src/store-lock.test.ts` — 18 pass
- `bunx tsc --noEmit` — clean
- `bun packages/projector/src/cursor.ts --check` — already current, exit 0, live file untouched

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Correctness] The store lock treated the muse fixture token as a committed secret**
- **Found during:** Task 2 lock rerun
- **Issue:** `SUBSTRATE_TOKEN = "collector-token"` is 16 characters, and restoring with `originalEnv.token` also matches the value pattern.
- **Fix:** The fixture value is `tok`. Restore goes through a short binding.
- **Files modified:** `packages/collectors/src/muse.test.ts`

**2. [Rule 2 - Correctness] Worktree exclude is shared with the main checkout**
- **Found during:** Task 1
- **Issue:** `git rev-parse --git-path info/exclude` in this linked worktree names the common exclude file, and a worktree `.git` is a file, not a directory.
- **Fix:** The writer still uses `--git-path`. The test asserts `.git` is a file, `check-ignore` succeeds, and the exclude line is present, rather than a distinct per-worktree path.
- **Files modified:** `packages/collectors/src/muse.test.ts`

### Plan assumption that did not hold

`docs/collectors.md` does not exist yet. The healthz-then-brief race is noted in `muse.ts` for plan 19-04 to record.

## Decisions Made

- No slug means no pointer and no brief. A failed fetch still ensures both.
- The stop hook swallows emit failures and never writes stdout.
- `--print-desired` exits before the hooks path is opened.

## Known Stubs

None. The degraded-brief race is documented as a comment until `docs/collectors.md` exists in plan 19-04.

## Threat Flags

T-19 stop containment is the realpath check, the regular-file open, the id regex and the size cap, asserted by `cursor-stop.test.ts`. The live hooks file was only read by `--check`.

## Self-Check: PASSED

- Files: `muse.ts`, `muse.test.ts`, `cursor-stop.ts`, `cursor-stop.test.ts`, `cursor.ts`, `cursor.test.ts` present
- Commits: `462c561`, `d028a65` resolve in `git log`
- Verification rerun at summary time: muse 13 pass, cursor-stop 15 pass, cursor projector 2 pass, redact-lock 18 pass, store-lock 18 pass, tsc clean, live `--check` already current
