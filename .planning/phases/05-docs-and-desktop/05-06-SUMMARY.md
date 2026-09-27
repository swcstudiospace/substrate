---
phase: 05-docs-and-desktop
plan: 06
subsystem: planning-evidence
tags: [wave-4, proof, d-14, d-16, d-19, sc3, claude-code, strict-mcp-config, headers-helper, desktop-run, owner-skip, t-05-06-01, t-05-06-02, t-05-06-03]

requires:
  - phase: 05-docs-and-desktop
    provides: 05-01 gate-* baseline (503/0/27, tsc-exit=0, dispatcher 149) and recruitment-desktop StartedAt; 05-03 substrate-desktop + desktop_run (D-19 guard); 05-02 owner-skip (docs half stops)
provides:
  - 05-PROOF.md — desktop-half proof keys, agent answer, Failed runs, Skipped (owner skip), final gate, Gaps, Evidence index; proof_result=partial
  - /var/lib/substrate/phase5-baseline/RESTORE.d/05-06.md (host, 0600 root) — proof-files and desktop-run routes
  - /var/lib/substrate/proof/ (host, 0700) — 0600 session transcripts and the diagnostic reply, key-free
affects: [phase-5-verification, 06-ledger]

actuals:
  tokens: 4700       # chars/4 over 05-PROOF.md (~15.9k chars) and this SUMMARY
  tasks: 3           # Task 1 skipped (owner); Task 2 desktop half run, fixture part skipped; Task 3 run minus fixture cleanup
  commits: 2         # f17abd7 + this SUMMARY
plan_head_before: c6b86c8

tech-stack:
  added: []
  patterns:
    - "Agent route proof: claude -p --mcp-config <0600 session file> --strict-mcp-config --allowedTools <one tool>; the propose key reaches the server only through a 0700 headersHelper, never a config or transcript"
    - "Owner-skipped plan parts are listed under ## Skipped (owner skip) and never given pass values; proof_result=partial"

key-files:
  created:
    - .planning/phases/05-docs-and-desktop/05-PROOF.md
    - /var/lib/substrate/phase5-baseline/RESTORE.d/05-06.md (host, 0600)
  modified: []

key-decisions:
  - "The plan's 05-05 precondition is superseded by the owner skip; only the desktop half and the final gate ran"
  - "proof_result=partial, sc1_evidence=sc2_evidence=skipped-owner: the docs clause is not claimed"
  - "Run 2 used settle_ms 5000 (vocabulary max) and timeout 120 after run 1 typed into the previously focused terminal; the plan allows one retry"
  - "Run 2 passed --settings '{\"disableAllHooks\":true}' (session-scoped) after the owner's global hooks held run 1 for ~6.8 min and past its outer timeout"
  - "The title read by xdotool is the pass evidence; the xwd PNG of this display lags window content (Gaps 2), which the agent itself flagged"

requirements-completed: []

coverage:
  - id: P1
    description: "D-14 part 2 / SC3: a real Claude Code session drives substrate-desktop through desktop_run with the propose key from a headersHelper; 4 desktop.action events; recruitment container unchanged"
    verification:
      - kind: e2e
        ref: "05-PROOF.md gui_run_id=dr-20260927T055519Z-002e8a (Task 2 <verify> desktop keys, exit 0)"
        status: pass
    human_judgment: false
  - id: P2
    description: "D-14 part 4: final root suite, tsc and dispatcher pytest two-sided green against gate-*"
    verification:
      - kind: other
        ref: "05-PROOF.md final_gate_bun_pass=534 (>503), final_gate_tsc_diff=0, final_gate_dispatcher_pass=149, failing-id diffs 0"
        status: pass
    human_judgment: false
  - id: P3
    description: "D-14 parts 1 and 3 (docs_search citation, redaction fixture re-check)"
    verification:
      - kind: other
        ref: "05-PROOF.md ## Skipped (owner skip); 05-02-SPIKE.md spike_fail_reason=owner-skip"
        status: skipped
    human_judgment: true

duration: ~26min
completed: 2026-09-27
status: partial
---

# Phase 5 Plan 06: Phase proof, desktop half Summary

**A real Claude Code session reached substrate-mcp through a session-scoped MCP config and drove the sandboxed desktop with one `desktop_run` call. It passed the host propose key only through a headersHelper. Run `dr-20260927T055519Z-002e8a` ended with the title `Terminal - substrate-smoke-6155f173` and left 4 `desktop.action` events (surface `claude-code`), none containing the typed command. The final gate is green in both directions: bun 534 against a gate of 503, tsc 0, pytest 149. The docs half was skipped by the owner and is not claimed, so proof_result=partial.**

## Performance

- Duration: ~26 min (05:40Z → 06:06Z). Task 1 skipped (owner). Task 2: desktop part in 2 agent runs (1 failed, 1 passed), fixture part skipped. Task 3: gate and cleanup; fixture cleanup skipped (nothing to remove).
- Commits: f17abd7 (05-PROOF.md), plus this SUMMARY.

## Accomplishments

- **Restore first.** RESTORE.d/05-06.md (0600 root) was written before any live change. It names two routes: `rm -rf /var/lib/substrate/proof` for the proof files, and the desktop run dirs and windows. The RESTORE.md index sha256 bf326959… is unchanged.
- **Agent route (T-05-06-02).** `claude -p --mcp-config /var/lib/substrate/proof/gui-mcp.json --strict-mcp-config --allowedTools mcp__substrate__desktop_run` was used, and ~/.claude.json was not edited. The init line shows `substrate connected`, and there was one `tool_use mcp__substrate__desktop_run`. Its input equals the prompt's JSON, and it ran 4/4 ok with a text and image/png result. The final answer quotes the run_id and the title.
- **Key hygiene (T-05-06-01).** The helper printed the header JSON, and no refusal came back, so mcp_header_route=helper. The helper and the config were removed afterwards. The propose key was scanned for in /var/lib/substrate/proof/ and in ~/.claude/projects/ and matched 0 times.
- **Audit (T-05-06-03).** Greptime shows 4 `desktop.action` rows for the run, surface `claude-code`, with 0 containing `PS1=` or `PROMPT_COMMAND`. recruitment-desktop StartedAt still equals the 05-BASELINE value.
- **Gate.** The run was at HEAD 63d5397: bun 534 pass / 0 fail / 29 files, normalized tsc `tsc-exit=0`, pytest 149 passed. The failing-id diffs are empty on both sides.

## Task Commits

1. **Tasks 2-3: desktop proof, final gate, Skipped section** — `f17abd7` (docs)

## Verify results

- Task 1 `<verify>`: not run. Every key it checks belongs to the skipped docs session.
- Task 2 `<verify>`, restricted to its desktop keys (mcp_header_route … recruitment_unchanged, Failed runs heading, live recruitment StartedAt, transcript 0600 containing desktop_run) under `/usr/bin/env bash`: `task2_desktop_verify=0`. The fixture_recheck_* checks were not run (skipped).
- Task 3 `<verify>`, restricted to what exists (gate diffs, configs and helper absent, no `.values`, propose-key scan, Gaps count 1, Evidence index, D-03/D-16 note): `task3_desktop_verify=0`. `proof_result=pass` and `fixture_values_removed=true` are deliberately absent, and the RAGFlow-key scan has nothing to scan (substrate.env has 0 RAGFLOW_API_KEY lines).

## Files Created/Modified

- `.planning/phases/05-docs-and-desktop/05-PROOF.md` — evidence (see provides).
- `/var/lib/substrate/phase5-baseline/RESTORE.d/05-06.md` — host only, 0600 root.

## Decisions Made

See key-decisions in the frontmatter.

## Deviations from Plan

1. **Precondition superseded (owner skip).** Task 1 requires 05-05 to be complete. The owner skipped the docs half at 05-02 (8b88030, bb1c4b3; ROADMAP c6b86c8), so Task 1, the fixture re-check, sc1/sc2 evidence and the fixture-values cleanup were not run. They are listed under `## Skipped (owner skip)` in 05-PROOF.md, never as passed, and proof_result=partial.
2. **Typed text.** `unset PROMPT_COMMAND; ` was added to the plan's text, as in 05-03 Gaps 1.
3. **Retry input.** Run 1 used the plan's settle 2500 and timeout 60. The new terminal had not taken focus when typing began, so the text went into the older, focused 05-03 terminal. Run 2 (the plan's one allowed retry) used settle_ms 5000 and timeout 120.
4. **Hooks disabled for run 2.** Run 1 was held ~6.8 min by the owner's global SessionStart/UserPromptSubmit hooks and was ended by the outer `timeout 480` (exit 124) just after its tool result arrived. Run 2 passed `--settings '{"disableAllHooks":true}'`, which is session-scoped and edits no settings file.
5. **Diagnostic screenshot.** One keyed JSON-RPC `desktop_run [{type:screenshot}]` (run dr-20260927T055741Z-a93dcf, 1 event) was made to check the agent's pixel-mismatch flag. It is recorded as a diagnostic under Gaps 2 and is not proof.
6. **tool.call.** No `tool.call` events exist for this route. Only docs_search (skipped) was to emit them; `desktop_run`'s record is its `desktop.action` events.
7. **Commits carry both trailers,** `Refs SPE-3576` and `Refs SPE-3970`.

## Issues Encountered

- The xwd screenshot of substrate-desktop currently shows stale contents for the newest window, even though the X server reports it active and topmost with the smoke title. The agent flagged the mismatch in its answer. The cause is inferred to be repaint starvation under ~70% CPU steal and was not investigated further (05-PROOF Gaps 2). If a later phase needs pixel-level GUI checks, this needs a follow-up.
- In run 1, the owner's prompt-uplift hook reported "Tracking · 5 issues · 31 sub-issues linked" for the proof prompt. Any Linear side effect comes from that global hook, not this plan, and was not inspected.

## User Setup Required

None.

## Next Phase Readiness

- Phase 5 verification can accept the desktop half (SC3 and the GUI-smoke clause of the Proof). The docs half stays owner-skipped.
- substrate-desktop now has 7 terminal windows, 2 of them from this plan. RESTORE.d/05-06.md names how to close them.

## Self-Check: PASSED

- Files exist: 05-PROOF.md (committed f17abd7); RESTORE.d/05-06.md is `600 root`; /var/lib/substrate/proof is 0700 and its files are 0600.
- Removed: gui-mcp.json, propose-header.sh, events-count.ts. Never written: docs-mcp.json, gui-mcp-file.json, fixture values.
- Commit exists: f17abd7.
