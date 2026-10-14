---
phase: 19-lane-b-collectors
plan: 19-04
subsystem: projector
tags: [muse, redact, collectors, docs]

requires:
  - phase: 19-03
    provides: brief writer, cursor stop hook, shared emit
provides:
  - Muse projector that writes a bundle with a byte-copied redactor and file config
  - docs/collectors.md covering collectors, hooks, state and the two recorded gaps
affects: [19-05]

tech-stack:
  added: []
  patterns:
    - "The Muse hook reads hooks/substrate.json and a token file. It does not read SUBSTRATE_URL from the environment."
    - "The hook template is a string array so the redactor import stays inside a quote."

key-files:
  created:
    - packages/projector/src/muse.ts
    - packages/projector/src/muse.test.ts
    - docs/collectors.md
  modified:
    - README.md
    - packages/collectors/src/muse.ts

key-decisions:
  - "Refusal recording is inline in the hook. The installed bundle cannot import emit.ts."
  - "--check builds in a temp directory, validates that, compares sha256 against the installed cache, and deletes the temp directory."
  - "A token value found in any bundle file refuses the projection before write."

patterns-established:
  - "MUSE_BIN is a stub in tests. The operator Muse binary is never invoked."
  - "substrate.json holds url, tokenFile and stateDir and never a token."

requirements-completed: [LANEB-04]

coverage:
  - id: D1
    description: "The bundle copies redact.ts with a source-commit header, and substrate.json has no token value"
    requirement: "LANEB-04"
    verification:
      - kind: unit
        ref: "packages/projector/src/muse.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "The generated hook emits tool.call from muse with slug, branch and payload, and a 400 appends a refused line"
    requirement: "LANEB-04"
    verification:
      - kind: unit
        ref: "packages/projector/src/muse.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Collectors topic doc names every env var, the herdr table, both gaps, and README links it once"
    requirement: "LANEB-04"
    verification:
      - kind: other
        ref: "docs/collectors.md and README.md"
        status: pass
    human_judgment: false

duration: ~35min
completed: 2026-10-09
status: complete
---

# Phase 19 Plan 04: Muse projector and collectors doc Summary

**The Muse hook ships as a bundle that carries its own redactor and reads its URL from a file, and one topic doc covers every collector.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 3/3 complete, 2 commits (this summary follows)
- **Completed:** 2026-10-09

## Accomplishments

- **Projector (df08396).** `muse.ts` writes `.muse-plugin/plugin.json`, `hooks/post-tool-use.ts`, `hooks/redact.ts` and `hooks/substrate.json`. The redactor file is a header plus the exact bytes of `packages/mcp-server/src/redact.ts`. The header names the commit that last touched that file and the sha256 of those bytes. Projection refuses if the source has an import or require, or if `SUBSTRATE_TOKEN` appears in any bundle file. The hook posts `tool.call` as surface `muse` with actor `agent`, the origin slug, the branch, and payload `tool` plus `outcome`, `duration_ms` and `tool_use_id` when present. Timeout is 1.5 seconds. A 4xx appends one refused line. Stdout stays empty and the process exits 0. Validate must be `valid: true` with no diagnostics before install or update, and approve follows either. `--bundle-only` stops after validate. `--check` exits 0 when the installed copies match and trust is `trusted_enabled`, and exits 1 on drift.
- **Doc (9b876f3).** `docs/collectors.md` covers herdr, the brief writer, the Muse hook, Cursor stop, grok and the git hook. It names the environment variables and state files, repeats the herdr agent table, and records the two gaps: a `/brief` 200 after a healthy `/healthz`, and PostToolUse firing only on success. README links the doc once and the layout line names the collectors.

## Verification

- `bun test packages/projector/src/muse.test.ts` — 6 pass
- `bun test packages/mcp-server/src/redact-lock.test.ts` — 18 pass
- `bun test packages/mcp-server/src/store-lock.test.ts` — 18 pass
- `bunx tsc --noEmit` — clean
- Tests set `MUSE_BIN` to a stub. The operator Muse binary was not run.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Correctness] The hook cannot import the shared emit module**
- **Found during:** Task 1
- **Issue:** Muse installs the bundle into its own cache. A relative import of `emit.ts` would point at the checkout, which the hook is not allowed to need.
- **Fix:** The timeout, the POST and the refused line are in the hook template. The line uses the same keys as `recordRefusal`.
- **Files modified:** `packages/projector/src/muse.ts`

**2. [Rule 1 - Bug] `--check` must not leave a temp bundle behind when validate fails**
- **Found during:** Task 1
- **Issue:** `process.exit` inside the validate gate skips the cleanup that deletes the temp directory.
- **Fix:** Validate failure throws, the `finally` removes the directory, and the process then exits 1.
- **Files modified:** `packages/projector/src/muse.ts`

### Plan assumption that did not hold

None. `redact.ts` has no import or require, so the copy assertion passes on this tree.

## Decisions Made

- The origin slug regex is built with `new RegExp` inside the hook so it stays the same pattern `git-context.ts` uses.
- `--check` validates a temp copy and compares hashes to `list --json` `cache_path`. It does not write `MUSE_PLUGIN_DIR`.

## Known Stubs

None. Install, update and approve are driven through `MUSE_BIN`. Tests stub that binary. Plan 19-05 is the scratch-HOME proof against a real Muse.

## Threat Flags

T-19-13 is the sentinel test: the token value is absent from every bundle file. T-19-14 is the hook test with a scrubbed environment: the URL comes from `substrate.json`. T-19-15 is the byte compare of `hooks/redact.ts` to the source plus header.

## Self-Check: PASSED

- Files: `packages/projector/src/muse.ts`, `packages/projector/src/muse.test.ts`, `docs/collectors.md` present; `README.md` links the doc once
- Commits: `df08396`, `9b876f3` resolve in `git log`
- Verification rerun at summary time: projector 6 pass, redact-lock 18 pass, store-lock 18 pass, tsc clean
