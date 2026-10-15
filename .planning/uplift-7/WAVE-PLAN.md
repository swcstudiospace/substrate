# Wave execution plan and outcome (uplift-7, node n7)

Each node is one Linear issue under graph `ut-mv9377hx-a66cb8e4`. Status is as of 2026-10-15, after PRs #70 to #75.

| Wave | Node | Linear | Status | Evidence |
| --- | --- | --- | --- | --- |
| 1 | n1 read planning state and legacy phases | SPE-13157 | Done | `PLANNING-INVENTORY.md` and `LEGACY-DISPOSITION.md` (PRs #70, #71) |
| 1 | n2 map the Agent Substrate baseline | SPE-13156 | Done | `SUBSTRATE-HEALTH.md` (PR #71). Fixes in PRs #72 and #73. |
| 2 | n3 list blocking unknowns | SPE-13158 | Done | `BLOCKING-UNKNOWNS.md` (PR #75) |
| 2 | n4 choose Omp UI event capture and host | SPE-13160 | Decision done; node open until the latency test | Host: the Omp TUI, your answer. Capture: attributed counters (PR #70). Contract: `docs/panel-event-contract.md` (PR #75). The latency test is listed under OMP_UI. |
| 2 | n5 compare SVM hosting verdicts | SPE-13159 | Done | `SOLANA-FEASIBILITY.md` (PR #71), with its sources checked against the primary pages in PR #75 |
| 3 | n6 register run risks and guards | SPE-13161 | Done | `RISKS-AND-GUARDS.md` (PR #75) |
| 4 | n7 synthesize the wave plan | SPE-13162 | Done | This file (PR #75) |
| 4 | SUBSTRATE_HARDENING | none | Partly done | Fixed: oversize `/memory` returns 413 (PR #72); truncated memory is flagged (PR #72); cross-agent visibility (PR #73). Open: invalid writes; expected-version for skills and docs; degraded-mode queue. |
| 4 | OMP_UI | none | Partly done | Done: host; states LOADING, SUCCESS, EMPTY_WINDOW, PARTIAL_COVERAGE, ERROR, ACCESS_DENIED; coverage; usage definition; event contract. Waived by you: keyboard, announcements and motion, WCAG contrast. Open: STALE, which needs an event time; the write-to-footer latency test. |
| 4 | SOLANA_LEDGER_FEASIBILITY | none | Done | Verdicts checked against the primary pages. CONDITIONAL_GO for the devnet anchor. The validator is NOT_FEASIBLE_NOW. |
| Closeout | Ship PR 70 and sync tracking | none | Done | PR #70 merged as `9cd6bf9`. The Notion row and Linear were updated. |
| Closeout | Fund the anchor key on devnet | none | Blocked | Every airdrop attempt was rate-limited, the latest one included. The key holds 0 SOL. Operator step. |
| Closeout | MILESTONE_COMPLETE | none | Blocked on your approval | Eight criteria FAIL (`MILESTONE-AUDIT.md`). It needs your approval and no unresolved FAIL. |
| Closeout | CLEANUP | none | Done | This run's worktrees, scratch clones, containers, and temporary files were removed. Archives and legacy material were not touched. |
| Closeout | Closeout report | none | Done | The chat report, with the same numbers as `MILESTONE-AUDIT.md`. |

## Remaining, by owner

- Operator: fund the anchor key; install and enable the anchor timer; run the ANCHOR-06 proof; deploy `main`; enable the skills timers; rotate the Cursor credential; make one write through Omp and check the footer.
- You: decide the STALE option (`POST /events/query`, which gives server timestamps); decide the three remaining substrate gaps; approve MILESTONE_COMPLETE once the FAILs are cleared or waived; confirm the defaults in `BLOCKING-UNKNOWNS.md`.
- This run, if you approve it: the Omp latency test on a scratch twin. That is approved non-production work, and it would close one FAIL.
