---
phase: 44-uat
requirements: [I-D1]
status: decided and executed in-repo 2026-10-21. The regression run is against a scratch twin, not production
---

# 44-CONTEXT: UAT

## Scope (ROADMAP)

The Phase 0 UAT runs as a repeatable script against any SUBSTRATE_URL, a regression check for every later phase (I-D1).

## State on origin/main 3e9a106 (verified before the phase)

- `scripts/uat-phase0.ts` exists and reads only SUBSTRATE_URL and the bearer inputs (docs/uat.md, consumer contract). It classifies the target, refuses writes on production without `--live`, and runs eight scenario runners. Its unit tests cover the classifier, the live guard and the argument parsing.
- Scenarios 2 and 5 are outside the harness default by design: scenario 2 needs seeded rows, scenario 5 needs a real kickoff graph (docs/uat.md, scenario table).
- No CI workflow runs `uat:phase0`. The regression loop in docs/uat.md needs the rehearsal twin, which needs local Docker images.

## Decisions

- D44-a. The criterion is met by the script running against any SUBSTRATE_URL and by a recorded regression run against a scratch twin. Production is never written to by this phase.
- D44-b. The regression is the scratch twin (`bun run rehearsal up`), built from the commit under test. The phase ran it from a detached worktree at origin/main 3e9a106, so the evidence is about main, not about this branch.
- D44-c. Identity follows the bearer. The server refuses a request whose body names a surface other than the bearer's surface (403, "this token is X and cannot act as Y"; rule introduced in cc65cf9, SPE-5052). Every request that names a surface therefore uses that surface's own token. The harness previously sent the operator token for every scenario. That was a harness error, not a server regression, and the first run on main caught it (4 of 6 passed).
- D44-d. A surface's token comes from its own file in the tokens directory, never from SUBSTRATE_TOKEN, which is the operator's bearer. The tokens directory is SUBSTRATE_TOKENS_DIR, else SUBSTRATE_REHEARSAL_TOKENS_DIR, else the CLI default.
- D44-e. Not wired into CI. The loop needs Docker and the rehearsal twin, which CI does not start. Wiring it is an operator decision and is recorded as such.
- D44-f. Scenarios 2 and 5 stay out of the harness default, as documented. Making them runnable needs seeded data and a live kickoff graph.

## Out of scope

- Wiring the regression into CI (D44-e).
- Changing the server's identity rule (D44-c).
