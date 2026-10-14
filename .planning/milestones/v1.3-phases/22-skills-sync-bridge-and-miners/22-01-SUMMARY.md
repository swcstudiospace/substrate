# Phase 22 Plan 01: sync + projector port — Summary

**Status:** complete. **Live effect:** none — production units untouched, no restarts, no merges.
**Commits:** `870746e` (code), unit-path fixes folded into `0d8f174`.

## Outcomes

- `packages/projector/src/skills.ts` + `skills.test.ts`: September projector ported whole —
  six roots (claude/grok/agents/muse/openclaw/openclaw-ws/cursor), five planner actions,
  enable/disable flags, atomic link replace, RESTORE.md undo, `--check` drift semantics.
  `SKILL_NAME_RE` imported from main's `skills/propose.ts`; no duplicate literal.
  Skip-warn warnings carry rule names only through the Phase 17 event shape.
- `packages/projector/src/skills-sync.ts` + `skills-sync.test.ts`: sync gate ported whole —
  `decide()` order dirty → branch (incl. detached HEAD) → diverged, fetch plus
  `merge --ff-only`, projection on every tick that got that far, `[skills-sync]` log shapes,
  refusal exits 0, git failure exits 1.
- `infra/vps/substrate-skills-sync.{service,timer}` staged: per-unit env file naming
  `SUBSTRATE_TOKEN_SUBSTRATE` by name (value never in repo), `ConditionPathExists` on the
  bun binary and entry point, 5-minute oneshot schedule, `WorkingDirectory` on the release
  tree per the repo unit doctor.
- Tests: projector suite 26 pass, sync suite 14 pass (incl. new child-env allowlist cases).

## Deviations (auto-fixed)

- **[Rule 2] Child-env allowlist:** September spread `process.env` into the git child.
  Extracted `childEnv()` returning exactly `PATH`, `HOME` (inherited, `/root` fallback),
  `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`; pinned by two tests.
- **[Rule 2] Warning shape:** September refusals warned from surface `claude-code` with a
  `{component, reason}` payload. Aligned to the Phase 17 `skills.sync.refused` row:
  surface `substrate`, payload `{action: "skills.sync", runtime: "skills-sync", reason}`.
- **[Rule 2] Release checkout:** repo doctor requires units on `/opt/agent-substrate/current`;
  September pointed at the dev checkout. Fixed in both skills units.
- **GROK_KNOWN_REAL:** no main baseline exists (first port), so the September baseline list
  ships verbatim; any host drift surfaces as `skip-warn`, never a link.

## Verification

`bun test` projector + sync suites green; duplicate-literal, credential-name and token-value
grep gates pass; `deploy-release` + `doctor-units` suites green; `bunx tsc --noEmit` clean.
Failures at HEAD recorded, not fixed (rehearsal `--port` guard is environmental).

## Self-Check: PASSED
