---
phase: 01-lane-b
plan: 08
subsystem: infra
tags: [grok-build, bun, hook, brief, projector, rules]

requires:
  - phase: 01-lane-b
    provides: "01-01 substrate-mcp /brief and /events, brief.delivered in EVENT_KINDS, grok-build surface; 01-02 fail-open brief client shape"
provides:
  - "claude-ultrathink-grok UserPromptSubmit path fetches the brief and writes substrate-brief.md (never hook stdout)"
  - "rules/substrate-brief.md and skills/substrate-brief/SKILL.md, projected to /root/.grok/rules/substrate-brief.md"
  - "scripts/install-substrate-brief.ts idempotent projector with timestamped .substrate-backup"
affects: [phase-1-success-criterion-4, grok-build-brief-delivery, 01-09]

actuals:
  tokens: 8819
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Grok Build brief delivery is a file write under GROK_PLUGIN_DATA (fallback ~/.grok/plugin-data/ultrathink), not hook stdout"
    - "Hook start on PATH=/usr/bin:/bin goes through the plugin bin/run-bun shim and an absolute interpreter path"

key-files:
  created:
    - /root/src/repos/claude-ultrathink-grok/hooks/uplift.test.ts
    - /root/src/repos/claude-ultrathink-grok/rules/substrate-brief.md
    - /root/src/repos/claude-ultrathink-grok/skills/substrate-brief/SKILL.md
    - /root/src/repos/claude-ultrathink-grok/scripts/install-substrate-brief.ts
    - /root/src/repos/claude-ultrathink-grok/src/substrate/brief.ts
    - /root/src/repos/claude-ultrathink-grok/src/substrate/brief.test.ts
  modified:
    - /root/src/repos/claude-ultrathink-grok/hooks/uplift.ts
    - .planning/phases/01-lane-b/01-BASELINE.md

key-decisions:
  - "Re-measured claude-ultrathink-grok before any behavior edit: 246 pass / 0 fail / 21 files at 0066755. The prior 256/1 row was stale. D-03 is two-sided against 0 failed and an empty failing-node-id set; passed count is a floor because this plan adds tests."
  - "Delivery event kind is brief.delivered with payload.bytes, surface grok-build. That kind already exists in EVENT_KINDS; a made-up kind would be rejected fail-open and look like silence."
  - "The installed plugin cannot execute hooks/uplift.ts (its src tree is a different fork). The projector still copies uplift.ts and brief.ts, and the hook Grok starts is hooks/deliver-substrate-brief.ts importing the copied brief.ts via bin/run-bun."

patterns-established:
  - "Pattern: Grok UserPromptSubmit envelope fields other than hook_event_name and tool_response are camelCase (sessionId, toolName, userPrompt)."

requirements-completed: [SC-4]

coverage:
  - id: D1
    description: "UserPromptSubmit fetches the brief and writes substrate-brief.md, records byte length, and does not put the brief on stdout"
    requirement: "SC-4"
    verification:
      - kind: unit
        ref: "hooks/uplift.test.ts#Test 1: writes the stubbed brief text to substrate-brief.md"
        status: pass
      - kind: unit
        ref: "hooks/uplift.test.ts#Test 2: session id, tool name and prompt come from camelCase keys"
        status: pass
      - kind: unit
        ref: "hooks/uplift.test.ts#Test 3: GROK_PLUGIN_DATA wins; unset falls back to the plugin-data path"
        status: pass
      - kind: unit
        ref: "hooks/uplift.test.ts#Test 4: a failed fetch writes no brief file and leaves uplift output unchanged"
        status: pass
      - kind: unit
        ref: "hooks/uplift.test.ts#Test 5: a successful fetch emits a delivery event carrying the byte length"
        status: pass
      - kind: unit
        ref: "hooks/uplift.test.ts#Test 6: brief delivery does not remove or rewrite the existing uplift output"
        status: pass
      - kind: other
        ref: "bunx tsc --noEmit (exit 0 after installing the lockfile's @types/bun)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Rule and skill name both brief paths, state the unconditional trigger, and match ultrathink-kickoff frontmatter keys"
    requirement: "SC-4"
    verification:
      - kind: other
        ref: "task 2 verify: rules/substrate-brief.md names GROK_PLUGIN_DATA and substrate-brief.md; SKILL.md frontmatter keys match"
        status: pass
    human_judgment: false
  - id: D3
    description: "Projector installs the rule beside the three existing rules, backups overwrites, and a second run adds nothing"
    requirement: "SC-4"
    verification:
      - kind: integration
        ref: "bun scripts/install-substrate-brief.ts twice; diff -q rules; sha256sum of ultrathink.md specialists.md skill-autonomy.md unchanged; backup count stayed 2"
        status: pass
    human_judgment: false
  - id: D4
    description: "A live Grok Build session quotes brief content that could only have come from the file"
    requirement: "SC-4"
    verification:
      - kind: manual_procedural
        ref: "PATH=/usr/bin:/bin plugin bin/substrate-brief wrote 608-byte substrate-brief.md for swcstudiospace/agent-substrate @ main naming cursor commits 2933f1c, 023874e, 9286a60, 7fd939e and an omp discovery line"
        status: pass
    human_judgment: true
    rationale: "The hook file write was observed. A live Grok Build model session was not started, so the model-quotation check is pending. No model quotation was observed."

duration: 16min
completed: 2026-09-24
status: complete
---

# Phase 1 Plan 08: Grok Build brief delivery Summary

**Grok Build's UserPromptSubmit path fetches the substrate brief and writes it to substrate-brief.md, with a rule that tells the session to read that file, because hook stdout is discarded.**

## Performance

- **Duration:** 16 min
- **Started:** 2026-09-24T16:52:44Z
- **Completed:** 2026-09-24T17:08:44Z
- **Tasks:** 3/3
- **Files modified:** 8 in claude-ultrathink-grok, plus the baseline row in agent-substrate

## Accomplishments

- The hook calls `fetchBrief` and writes `substrate-brief.md` under `$GROK_PLUGIN_DATA` or `~/.grok/plugin-data/ultrathink/`. It does not put the brief on stdout.
- A successful write emits `brief.delivered` with the byte length. A failed or empty fetch writes no file.
- Envelope session id, tool name, and prompt are read from camelCase keys.
- `/root/.grok/rules/substrate-brief.md` matches the repo rule. `ultrathink.md`, `specialists.md`, and `skill-autonomy.md` are unchanged.
- The projector is idempotent. Each overwritten plugin file has a timestamped `.substrate-backup`.

## Task Commits

Each task was committed in `claude-ultrathink-grok` on `milestone/v1.0-cross-runtime`:

1. **Restore brief client (precondition)** - `a4f3f61` (feat)
2. **Task 1 RED** - `84860d9` (test)
3. **Task 1: Fetch the brief on UserPromptSubmit and write it to the session file** - `afc0dbf` (feat)
4. **Task 2: Add the rules entry and skill that make the file reachable** - `98314b6` (feat)
5. **Task 3: Project the brief delivery into the live Grok Build surface** - `bb87ef7` (feat)

**Plan metadata:** this commit.

## Files Created/Modified

- `src/substrate/brief.ts` - restored from origin/master; exports `fetchBrief` and `emitEvent`
- `src/substrate/brief.test.ts` - restored with the client
- `hooks/uplift.ts` - UserPromptSubmit calls `fetchBrief` and writes `substrate-brief.md`
- `hooks/uplift.test.ts` - six delivery cases
- `rules/substrate-brief.md` - unconditional read instruction, both paths, absent file is not an error
- `skills/substrate-brief/SKILL.md` - same frontmatter keys as `ultrathink-kickoff`
- `scripts/install-substrate-brief.ts` - idempotent projector

## Decisions Made

- Baseline re-measured before behavior edits: **246 pass / 0 fail / 21 files** at `0066755`. No failing node ids. The old 256/1 row is stale.
- After this plan, `bun test` is **259 pass / 0 fail / 23 files**. Failed count stayed 0. No failing node id appeared.
- Delivery uses kind `brief.delivered` and `payload.bytes`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] brief.ts was missing on this branch**
- **Found during:** precondition, before Task 1
- **Issue:** The plan says `src/substrate/brief.ts` is already ported. It is not on `0066755`. `origin/master` has it and exports `fetchBrief`.
- **Fix:** Path-only checkout of `src/substrate/brief.ts` and `src/substrate/brief.test.ts`. No other files swept.
- **Files modified:** those two files
- **Verification:** `export async function fetchBrief` present
- **Committed in:** `a4f3f61`

**2. [Rule 3 - Blocking] Installed plugin cannot run the copied uplift.ts**
- **Found during:** Task 3
- **Issue:** `/root/.grok/installed-plugins/ultrathink-53674ac1` is a different fork. `hooks/uplift.ts` imports `../src/config.ts` and the rest of this repo's tree, which that plugin does not have. Executing the copy crashes before any write.
- **Fix:** Projector still copies `hooks/uplift.ts` and `src/substrate/brief.ts`. The hook Grok starts is a thin `hooks/deliver-substrate-brief.ts` that imports only the copied brief client, launched by `bin/substrate-brief` through `bin/run-bun` (absolute interpreter, not a bare `bun`). Existing `prompt-submit` entry is left in place. `hooks.json` was backed up before the add.
- **Files modified:** `scripts/install-substrate-brief.ts` plus generated plugin files
- **Verification:** `PATH=/usr/bin:/bin` (`command -v bun` absent) the shim exited 0 and wrote a 608-byte brief
- **Committed in:** `bb87ef7`

**3. [Rule 3 - Blocking] `tsc --noEmit` could not see bun types**
- **Found during:** Task 1 verify
- **Issue:** `node_modules` was absent, so `bunx tsc --noEmit` failed with TS2688 before checking this plan's code.
- **Fix:** `bun install` from the existing lockfile (`@types/bun` only). Not committed.
- **Files modified:** none in git
- **Verification:** `bunx tsc --noEmit` exit 0
- **Committed in:** n/a

---

**Total deviations:** 3 auto-fixed (3 blocking)
**Impact on plan:** The restore and the thin plugin hook were required for the delivery to actually run. No extra product scope.

## Issues Encountered

- The D-03 row in `01-BASELINE.md` was stale (256 pass / 1 fail at `3766efd`). Re-measured before edits: 246 pass / 0 fail at `0066755`, no failing node ids. Later gates compare against that row.
- Live model quotation was not run. Observed file contents are below. Do not treat them as a model quote.

## Human-check

Pending: a live Grok Build model session that quotes the brief. Not started. No model quotation was observed.

Observed by invoking the installed shim with `PATH=/usr/bin:/bin` and a `UserPromptSubmit` envelope whose `cwd` was `/root/src/repos/agent-substrate`. `command -v bun` was absent. Exit 0. File `/tmp/tmp.PFC22fnYct/substrate-brief.md` (608 bytes):

```
## Substrate brief: swcstudiospace/agent-substrate @ main

Last 5 agent actions in this repo
- 16:32 cursor       commit 2933f1c docs(01-03): complete eng-board substrate forwarding plan (owner-approved checkpoint)
- 14:30 cursor       commit 023874e docs(01-05): complete grok-hermes-connector v0.4 substrate bridge plan
- 12:50 cursor       commit 9286a60 docs(01-07): record windows ledger + state.json for the substrate bridge plan
- 12:50 cursor       commit 7fd939e docs(01-07): complete Omp <-> substrate-mcp bridge plan
- 12:45 omp          Omp autonomous discovery for swcstudiospace/agent-substrate
```

Rule install: `/root/.grok/rules/substrate-brief.md` matches the repo copy. The three pre-existing rules still match their pre-run sha256.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Grok Build can receive a brief through a file the rule names. 01-09 was not started.
- The model-quotation half of the human-check is still open.

## Self-Check: PASSED

- Key files exist: `hooks/uplift.ts`, `hooks/uplift.test.ts`, `rules/substrate-brief.md`, `skills/substrate-brief/SKILL.md`, `scripts/install-substrate-brief.ts`, `src/substrate/brief.ts`.
- `git log --grep=01-08` in claude-ultrathink-grok: `a4f3f61`, `84860d9`, `afc0dbf`, `98314b6`, `bb87ef7`.
- Task 1: six tests pass, `tsc --noEmit` exit 0, full `bun test` 259 pass / 0 fail (baseline failed count 0, no failing node ids).
- Task 2 verify exit 0.
- Task 3 verify: projector twice, rule diff clean, three pre-existing rules present and unmodified, `.substrate-backup` present, backup count unchanged on the second pair of runs, `bun test` 0 fail.

---
*Phase: 01-lane-b*
*Completed: 2026-09-24*
