# 22-01 SUMMARY — Base gate: READY (Phases 19/20/21 present at 96db88c); projector + sync ported

## Verdict

**READY and executed.** The base is `gsd/v1.3-p22-execute` at `96db88c`
(`feat(v1.3 phase 20): production identity and phase-0 UAT harness proof (#33)`,
tracking `origin/main`). All six Phase 19/20/21 touchpoints are present with
the named symbols — the stale NOT-READY record from before Phase 20 merged no
longer applies. Tasks 2 and 3 are implemented; no plans 22-02–22-06 were touched.

## Base gate evidence (Task 1)

| # | Touchpoint | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `packages/cli/src/token.ts` exporting `resolveBearer` (Phase 20) | PRESENT | `export function resolveBearer(surface, env = process.env, read = firstLine)` at `token.ts:62` |
| 2 | `infra/identity/clients.json` (Phase 20 manifest) | PRESENT | file exists |
| 3 | `packages/mcp-server/src/skills/propose.ts` exporting `SKILL_NAME_RE` (Phase 21) | PRESENT | `export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;` at `propose.ts:51` |
| 4 | `packages/collectors/src/cursor-stop.ts` (Phase 19 hook) | PRESENT | file exists |
| 5 | `docs/skills-propose.md` (Phase 21 doc) | PRESENT | file exists |
| 6 | `scripts/rehearsal.ts` accepting `--skills-fixture` (Phase 21) | PRESENT | bare flag at `:1560`, parsed at `:1610`, fixture builder at `:625` |

No September manifest was merged and `packages/projector/package.json` is untouched.

## D22-28 baseline

Not collected: the execution ticket forbids running `bun test`, `tsc`, lint, or
formatters on this worktree, so no `bun test` / `bunx tsc --noEmit` /
`bun run check:phase-close` / pytest counts were recorded. The gate task modified
no source file. **The main agent MUST run the plan's verification
(`bun test packages/projector/src/skills.test.ts packages/projector/src/skills-sync.test.ts`
plus `tsc --noEmit` and `check:phase-close`) before treating this plan as green.**

## What was built (Tasks 2–3)

September sources re-expressed on main (planner/executor September `8cb0cad`
`skills.ts`, timer September `354310c` `skills-sync.ts`), behind Phase 20
identity and Phase 17 vocabulary:

- `packages/projector/src/skills.ts` — planner and executor with all five
  operations (`link-new`, `repoint`, `backup-then-link`, `remove-own-link`,
  `skip-warn`), atomic link replacement (`.substrate-tmp` + rename),
  `RESTORE.md` / `MANIFEST.sha256` backups, enable/disable flags, `--check`
  and `--root`, and September's roots verbatim (Claude Code, Grok with
  `GROK_KNOWN_REAL`, `.agents` with disable flag, Muse with `create`, two
  repoint-only OpenClaw dirs, flag-gated Cursor). Skip-warn warnings are now
  host-job events (D22-03) via `hostJobWarning()`; the bearer is
  `resolveBearer("substrate", env)` with fail-open 3 s POST (D22-04);
  per-`(root, name, reason)` dedupe kept (D22-05). Seams (D22-07):
  `SUBSTRATE_SKILLS_LIBRARY`, `SUBSTRATE_SKILLS_HOME`, `SUBSTRATE_SKILLS_STATE`
  (shared with Phase 21, default `/var/lib/substrate/skills`),
  `SUBSTRATE_SKILLS_BACKUP`, `SUBSTRATE_URL`.
- `packages/projector/src/skills-sync.ts` — refuse dirty/off-branch before any
  fetch, `git fetch origin main`, refuse non-fast-forward, else
  `git merge --ff-only origin/main`, then project on every tick that got that
  far (D22-01); runner is `execFile` with an argv, never a shell. Dirty check
  is `git status --porcelain --untracked-files=all` ignoring only `??` paths
  with a `__pycache__` segment or `.pyc` suffix (D22-02, `effectivePorcelain()`).
  Refusal warnings are host-job events with hourly `session_id` (D22-03);
  warned state `{reason, beganAt, lastWarned}` under `SUBSTRATE_SKILLS_STATE`
  warns on change or once per UTC day, logs `[skills-sync] cleared <reason>`
  and emits nothing on clear, and only records on accepted post (D22-05).
  Exit codes stay September's: policy refusal 0, failed git step or empty
  library 1 (D22-06); journal lines `ff <old>..<new> | current <sha> |
  refused <reason> | cleared <reason>`.
- `packages/projector/src/skills.test.ts` — September's suite ported (roots,
  planner, apply, dedupe, CLI, sameTree, backups, flags, repoint-only,
  stray-real-dir) with warning expectations moved to `substrate`, plus new
  D22-03/D22-05 row-shape tests and D22-07 seam tests. All filesystem work in
  tmp dirs; production paths appear only as asserted seam defaults.
- `packages/projector/src/skills-sync.test.ts` — September's decide/executor
  suite ported (fake runner, new `--untracked-files=all` argv) plus new
  D22-02 (cache-only output proceeds; any other untracked or any tracked
  change refuses), D22-03 (row fields, no `repo`, hourly session), and D22-05
  (first warn records state; same-day silence; change re-warns; next-day
  re-warns; clear is silent and removes state) tests with injected clock and
  tmp-dir state file.

## Threat dispositions (plan § threat_model)

- T-22-01-01 (git tampering): refuse-before-fetch + ff-only order kept; fake-runner tests prove diverged/dirty never merge.
- T-22-01-02 (bearer/events): resolver bearer, fail-open post, refusals carry reasons never values (redacted tail only on failed git steps).
- T-22-01-03 (warning noise): change-or-daily cadence with tests; success silent per `docs/event-vocabulary.md`.

## Deviations from plan

None in scope — plan executed as written, except Task 1's baseline counts,
which the execution ticket explicitly forbids collecting (recorded above, not
fixed elsewhere). No `skills-env.ts` split file was needed; seams live in the
two modules. No auth gates, no stubs, no new event sources.

## Verification

Recorded after `76d0780` on this branch, with `bun install --frozen-lockfile`:

- `bun test packages/projector/src/skills.test.ts packages/projector/src/skills-sync.test.ts` — 58 pass, 0 fail
- `bunx tsc --noEmit` — clean
- `bun run check:phase-close` — pass (112 pass / 0 fail across the four lock files)

One port bug was fixed before that run: a projector warning the substrate refused was still recorded, so the next run did not retry it. `apply` now keeps September's `if (!accepted) continue`. Full-repo `bun test` and pytest were not part of this plan's verify command.
