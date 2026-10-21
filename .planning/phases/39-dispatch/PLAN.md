---
phase: 39-dispatch
requirements: [C-D2, C-D4]
branch: gsd/v13x-39-dispatch
base: 1d4e4aa (origin/main, the merge of PR #90)
---

# 39-PLAN: DISPATCH, verification and records

Context and decisions: `CONTEXT.md`. Goal and criteria: ROADMAP.md, Phase 39.

## Tasks

| # | Task | Files |
|---|---|---|
| 1 | Verify criterion 2 (drift scan before launch, stale-brief warning) against the existing tests | `packages/dispatcher/tests/test_handoff.py` |
| 2 | Verify criterion 1 (signed packet, replay from the ledger) against the existing tests | `packages/dispatcher/tests/test_handoff.py`, `packages/mcp-server/src/handoff.test.ts` |
| 3 | Confirm no product code changed since the full-suite run (3aea2d0) | `git diff` over `packages` and `docs` |
| 4 | Record the C-D2 wording decision (issue identifier, DISP-07) | `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md` |
| 5 | Post-merge corrections: phases 37 and 38 are merged (PR #89, PR #90) in STATE, ROADMAP and REQUIREMENTS | `.planning/STATE.md`, `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md` |
| 6 | Records: CONTEXT, PLAN, SUMMARY, VERIFICATION | `.planning/phases/39-dispatch/` |

## Verification plan

- Dispatcher suite: `python3 -m pytest packages/dispatcher/tests -q`, all pass.
- Handoff suite: `bun test packages/mcp-server/src/handoff.test.ts`, all pass.
- The full repository suite ran on 3aea2d0 (5746 pass, 2 skip, 0 fail). No file under `packages` or `docs` changed after it, which the diff check shows.

## Out of scope

- Issue prose in the packet (DISP-07).
- Setting `SUBSTRATE_HANDOFF_KEY` on a host, and a live drift run on Lane B.
