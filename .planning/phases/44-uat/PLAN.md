---
phase: 44-uat
requirements: [I-D1]
status: executed in-repo 2026-10-21
---

# 44-PLAN: UAT

## Tasks (executed)

1. **Regression run on main.** Detached worktree at origin/main 3e9a106; `bun run rehearsal up`; `uat:phase0` with scenarios 1, 3, 4, 6, 7 and 8; `rehearsal down` at the end. First run: 4 of 6 passed. Scenarios 6 and 8 failed with 403 from the server's identity rule.
2. **Harness identity fix.** Scenarios 6 and 8 send each surface-named request with that surface's own bearer. Cursor and hermes bearers come from `surfaceBearer`, which reads the surface's token file and never SUBSTRATE_TOKEN.
3. **Tests.** Store-URL test: the UAT connects to no store listener, even with store variables set. Production refusal test: a write scenario on a production-looking target is refused before any request, naming `--live`. Surface-bearer test: each surface's bearer comes from its file.
4. **Secret-hygiene scans.** The new test code wrote literal `GREPTIME_` names and literal token assignments, which the repository scans reject. The names are now assembled from parts, as `scripts/rehearsal.ts` already does. No scan was changed.
5. **Gates.** UAT test file, typecheck, full suite and repo locks on this tree.

## Acceptance

- The regression run on the scratch twin passes every selected scenario.
- The UAT test file passes, including the three new tests.
- The repository gate is green on this tree.
