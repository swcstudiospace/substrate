---
phase: 44-uat
verified: 2026-10-21
status: passed
score: 1 of 1 criterion proven in-repo (I-D1)
verified_on: gsd/v13x-44-uat on its final tree, against origin/main 3e9a106 for the regression
covered_files: ["scripts/uat-phase0.ts", "scripts/uat-phase0.test.ts", "scripts/cache-stats.test.ts", "infra/vps/deploy-release.test.ts", "docs/uat.md"]
---

> Status detail, kept verbatim from the original frontmatter: passed in-repo. Regression loop green on a scratch twin of origin/main 3e9a106. CI wiring is an operator decision, not done

# 44-VERIFICATION: UAT

## Regression evidence

| Run | Harness | Twin | Result |
|---|---|---|---|
| 1 | original (one operator bearer for every scenario) | scratch twin, commit 3e9a106, clean tree | 4 of 6 passed. Scenario 6 and 8 failed: the server refused the operator bearer for another surface (403), so BRIEF.md was not written and the cross-surface brief was refused |
| 2 | surface-named requests use that surface's bearer | same twin, same commit | 6 of 6 passed (scenarios 1, 3, 4, 6, 7 and 8) |

The report of run 2 holds ids, counts, statuses, booleans and elapsed times only. It lives outside the repository.

## Proven in-repo

| Claim | Evidence |
|---|---|
| The UAT test file passes, including the three new tests | `bun test scripts/uat-phase0.test.ts`: 53 pass, 0 fail (before the load-timeout edits); the three edited files together: 122 pass, 0 fail |
| Typecheck is clean | `bunx tsc --noEmit` exit 0 on the final tree |
| Full suite passes | `bun test` on the final tree against this phase's verification database: 5826 pass, 2 skip (pre-existing: `cache-conformance.test.ts:127`, `redact.test.ts:813`), 0 fail. 5828 tests in 217 files |
| Repo locks pass | `bun run check:phase-close`: 4 lock files green; EVENT_KINDS unchanged at 12 against ab62c91; SURFACES equals baseline plus substrate at 27 |
| No store URL is contacted | `uat-phase0.test.ts`: the UAT never connects to a store listener, even with store variables set |
| A production write is refused before any request | `uat-phase0.test.ts`: refused, naming `--live`, zero requests |
| A surface's bearer is its own file | `uat-phase0.test.ts`: each surface's bearer comes from its file, never from the operator token |

## Load-sensitive tests (not caused by this phase)

- `scripts/cache-stats.test.ts`, recommendation floor: the collector's 250 ms wall budget truncated a 1005-key scan on a host at load of about 30 (total came back as 800 bytes instead of 1311720). It passes alone (24 of 24). The test now sets a 60 s budget explicitly.
- `infra/vps/deploy-release.test.ts`: `spawnSync` against bash exceeded bun's 5 s default under load. Passes alone (45 of 45). The file now sets a 30 s default timeout.

## Not proven

- CI wiring. The regression needs Docker and the rehearsal twin, which CI does not run (D44-e).
- Scenarios 2 and 5 against any target. They are outside the harness default by design.
- A regression run against production. Production was not targeted.
