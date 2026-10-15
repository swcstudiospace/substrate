# Wave execution plan and outcome (uplift-7, node n7)

Each node is one Linear issue under graph `ut-mv9377hx-a66cb8e4`. Status is as of 2026-10-15, after PRs #70 to #75.

## Status by node

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
| Closeout | CLEANUP | none | Done after merge | This run's worktrees, scratch clones, containers, and temporary files were removed. Archives and legacy material were not touched. |
| Closeout | Closeout report | none | Done | The chat report, with the same numbers as `MILESTONE-AUDIT.md`, and the content listed below. |

## Deviations from the n4 spec

- The window and the last-seen time use the viewer's poll clock, not the event source's clock. `/metrics` has no event times. Decision: keep, at closeout.
- Six of the seven UI states are implemented. STALE is not, because it needs an event time.
- The three accessibility rules that fit a terminal host are waived by you. Keyboard, announcements, and motion have no terminal equivalent; WCAG contrast depends on the user's theme.
- Event capture uses attributed counters, not event rows. Unattributed signals are flagged and never counted.

## Remaining units, in order

Verification commands come from `package.json`: `bun test`, `bunx tsc --noEmit`, `bun run check:phase-close`, and `bun run gate:boot`. Each unit is gated by one PAUSE_POLICY category. A blocked unit stops only its dependents.

| Unit | Files it owns | Change | Verification | Pause |
| --- | --- | --- | --- | --- |
| U1 Substrate: invalid-write round trip | `packages/mcp-server/src/memory-write.ts`, `memory-write.test.ts` | A rejected write persists nothing, proven in an isolated namespace | `bun test packages/mcp-server/src/memory-write.test.ts`; the PG suite with `SUBSTRATE_TEST_PG_URL` | GREY_AREA_ACCEPTANCE: fix now, or accept with a date |
| U2 Substrate: expected-version for skills and docs | `packages/mcp-server/src/index-store.ts` (skills path), `docs-ingest.ts` | A versioned write path, with a two-client race test | the PG suite | GREY_AREA_ACCEPTANCE |
| U3 Substrate: degraded-mode queue | `packages/mcp-server` queue (new), its tests | Queued writes apply exactly once when the substrate returns | `bun test`; one chaos check on the scratch twin | GREY_AREA_ACCEPTANCE: design first |
| U4 Omp latency test | none in the repo; a scratch twin | One write, then one poll, and the footer moves | the rehearsal twin, then the footer | DEFAULT_PROCEED (scratch, approved) |
| U5 Omp STALE state | `packages/projector/omp/substrate-status.ts`, its tests | Only if you choose `POST /events/query` for a server clock | `bun test packages/projector/omp/` | GREY_AREA_ACCEPTANCE |
| U6 Operator steps | none (operator) | Fund the key; install and enable the timer; ANCHOR-06 proof; deploy `main`; skills timers; Cursor rotation; a live write check | the operator reports; I verify read-only | EXTERNAL_EFFECT |
| U7 Audit regrade and MILESTONE_COMPLETE | `.planning/uplift-7/MILESTONE-AUDIT.md` | Regrade after U1 to U6 | no unresolved FAIL | VALIDATION_REQUEST (your approval) |
| U8 CLEANUP | this run's temporary files and worktrees only | Remove after the merges | `git worktree list` and `git status` | DEFAULT_PROCEED |

## Closeout content

- SVM on Railway: no. The documented layout needs three separate disks, 2.5 TB in total. Railway allows one volume per service: 1 TB self-serve on Pro, and a 5 TB maximum on Enterprise. The devnet anchor is CONDITIONAL_GO.
- VALIDATION_REQUEST: confirm devnet as the target cluster, and approve the operator steps (fund the key, install the timer, run the ANCHOR-06 proof).
- Pauses and defaults. Answered: the panel host (the Omp TUI); the last-seen clock (keep the viewer's); cross-agent visibility (private). SCOPE_CHANGE: the workstreams are records, not roadmap phases (default). Defaults applied: the known-client list (the token files); routines reported, not built; the Task row points at the latest PR; ledger role anchor; devnet; a $50 per month budget at test scale; retention inherits the substrate's controls.
- Open questions: (1) do you want STALE from `POST /events/query`? (2) do the three substrate gaps get fixed now, or accepted with a date? (3) approve MILESTONE_COMPLETE once U1 to U6 are settled. (4) confirm the defaults in `BLOCKING-UNKNOWNS.md`.
- Client coverage. Ten known clients come from the token files. Six are observed: omp, claude-code, cursor, grok-bot, hermes, and muse. Four are NOT_INSTRUMENTED: codex, grok-build, opencode, and pi. Two counted surfaces are unregistered: unattributed and unknown. The Omp TUI is the only panel host.
- Where the panel lives and how to read its headline. It lives in the Omp TUI: the footer is the headline, the widget shows the last three omp changes, and `/substrate` shows the full view. `IN_USE` means an omp change was seen in the last five minutes by this viewer's clock. `NOT_OBSERVED_IN_WINDOW` means none was seen in that window; it does not mean the client is inactive, and `/substrate` shows coverage. `ERROR` means the last probe failed, and the footer shows when the last good poll was. `ACCESS_DENIED` means the token was refused, and no counts are shown.
