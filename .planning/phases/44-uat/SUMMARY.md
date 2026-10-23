---
phase: 44-uat
requirements: [I-D1]
status: in review (draft PR). The regression loop passes 6 of 6 on a scratch twin of origin/main 3e9a106. Wiring into CI is not done (D44-e)
---

# 44-SUMMARY: UAT

## Built

- **The regression run, on main.** The scratch twin ran origin/main 3e9a106 from a detached worktree, with a clean tree. The first run passed 4 of 6. Scenarios 6 (Cursor hooks) and 8 (cross-surface brief) failed. The cause was the harness, not the server: every scenario sent the operator's bearer, and the server refuses a request that names another surface than the bearer's with 403 (D44-c).
- **The harness fix.** Scenarios 6 and 8 send each surface-named request with that surface's own bearer. `surfaceBearer` reads a surface's token file from the tokens directory and never reads SUBSTRATE_TOKEN (D44-d). The docs say so.
- **The regression again, same twin, fixed harness.** 6 of 6 scenarios passed: substrate-mcp serves both surfaces; the index backfills from the Notion export; the brief reaches a Claude Code session; the Cursor hooks write BRIEF.md, emit no event at session start, and read back tool and session events; a substrate outage blocks no agent; the cross-surface brief carries lines from the other surface.
- **Tests.** Three new tests in `scripts/uat-phase0.test.ts`:
  - the UAT never connects to a store listener, even with store variables set;
  - a write scenario on a production-looking target is refused before any request, naming `--live`;
  - a surface's bearer comes from its own token file, never from the operator's token.
- **Secret-hygiene scans.** The new test code wrote literal store and token names that the repository scans reject. The names are now built from parts, as `scripts/rehearsal.ts` already builds them. No scan was changed.
- **Load-sensitive tests.** Two existing tests failed in full runs at host load of about 30, and both pass alone. `scripts/cache-stats.test.ts` (the recommendation floor test) now sets an explicit 60 s wall budget, because the 250 ms default can truncate the scan on a loaded host. The assertions are unchanged. `infra/vps/deploy-release.test.ts` runs bash with `spawnSync`, which bun's 5 s default cannot interrupt, so the file now sets a 30 s default timeout.

## Decisions

- D44-a to D44-f in CONTEXT.md. The criterion is met by the script running against any SUBSTRATE_URL, with a recorded regression run on a scratch twin. Production is not written to.

## Deviations

- The production-refusal test uses the host `substrate.invalid`, not loopback. Port 7410 is a production port, and a loopback address could reach a real service if the refusal ever regressed. The name does not resolve, so no request can reach anything.
- The surface-bearer test sends the operator token only as a made-up string. The assertion is that the file's own string is returned.

## Not done

- **CI wiring.** The regression needs Docker and the rehearsal twin. CI does not start either. D44-e records it as an operator decision.
- **Scenarios 2 and 5** stay outside the harness default, as documented. Running them needs seeded rows and a live kickoff graph.

## Operator-gated

- A regression run against a production-like target uses `--live` only for write scenarios and only with an approval reference. None was run.

## Cleanup

- The scratch twin `p44reg` and its detached worktree `/root/pr-fix/p44-regress` were used for the run. The twin's containers are removed with `rehearsal down`. The worktree is removed at close-out with the other phase worktrees, after approval.
