# Phase 22 validation map

Rehearsal-proven on the fixture twin (smoke 18/18 green, detached worktree, port 17422);
live steps are named gates with no evidence yet.

| Requirement clause | Proven by | Status |
|---|---|---|
| SKILL-02 sync gate ff-only + projector six roots | 22-01 Task 1, Task 2 (bun suites 26 + 14) | proven |
| SKILL-02 staged sync units, token-by-name, guards | 22-01 Task 3 + doctor-units roster test | proven |
| SKILL-03 bridge propose/quiet/grouping/queue drains | 22-02 Task 1 (51→52 py tests), smoke (a)+(b) | proven |
| SKILL-04 monitor precheck + hourly miner on main's code | 22-02 Task 2, 22-03 Task 2 + Task 3 cron rebind spec | code proven; rebind gated |
| SKILL-05 propose-only miners (autonomy, extension, Hermes stage) | 22-03 Task 1 (20 bun tests), Task 2, Task 3 rebind specs | code proven; rebinds gated |
| SKILL-07 rehearsal loop propose→PR→merge→sync→links | 22-04 Task 1 smoke 18/18 | proven |
| SKILL-07 dirty-tree cleanup + ignore rule via owner PR | 22-04 Task 2 hygiene spec | gated |
| SKILL-07 real PR, owner merge, production tick | 22-04 Task 3 live tail steps 1–2 | gated |
| SKILL-07 production restarts, cron rebind, key deletion | 22-04 Task 3 live tail steps 3–4 | gated |

Gated steps retire in order; each names its proof read and rollback in
`docs/skills-sync-bridge-miners.md`. Nothing below the gate line ran: no production
restart, merge, PR, host write, or key deletion occurred in this phase.
