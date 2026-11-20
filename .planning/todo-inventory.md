# TODO inventory

Graph ut-mvlknrx6-2849044e. Recorded 2026-10-23 from read-only scans. No marker was edited or removed.

## Scan result

- Real TODO or FIXME markers, repo-wide: 0.
- Code and docs literal hits, QUOTED_OR_FIXTURE: 5. They are placeholder literals, not work items: packages/cli/src/lessons.test.ts:1302 and :1310; packages/mcp-server/src/lesson-content.ts:35 and :57; packages/mcp-server/src/memory-write.test.ts:428.
- Planning prose hits: 13, all verification or summary lines that report no TODO was found. No action.
- Research docs quoting a "TODO-chain" string: 2. No action.
- Backlog-named files: none. ROADMAP TODO references: none.
- UNTRUSTED_REPO_TEXT, flagged and not followed: 7. Historical PLAN and VALIDATION directives, for example "Do not run tests, tsc, or formatters" at .planning/phases/35-expected-version-skills-docs/PLAN.md:52. They are recorded here for the final report only.
- CREDENTIAL_LIKE: none found.

## Debt register as TODO sources

Each item has exactly one disposition, decided under the uplift's routing rules (q1: touched code only; q2: fold when touched, else defer).

| ID | Source | Item | Disposition | Target |
|----|--------|------|-------------|--------|
| D-01 | v1.0 audit, tech_debt | Full live cross-surface handoff proof | DEFERRED, operator-gated, accepted as debt | v1.0 debt |
| D-02 | v1.0 audit, tech_debt | Railway apps (hindsight, RAG-backend, dragonfly) wiring | ADOPTED into phase 46 (migration) | phase 46 |
| D-03 | v1.0 audit, tech_debt | Solana mainnet for anchors | DEFERRED, human-only | none |
| D-04 | v1.0 audit, tech_debt | Nyquist validation not run | DEFERRED, orphan | none |
| D-05 | v1.1 audit, deferred | ADR 0001 S2, S4, S5 | DEFERRED, orphan | none |
| D-06 | v1.1 audit, deferred | Lessons-bank decision | DONE: decided 2026-10-07 (each lesson is one governed `fact` entry) and shipped in phase 15 (`packages/cli/src/lessons.ts`, `docs/lessons-bank.md`); the realtime tier stays a candidate in PROJECT.md (checked 2026-10-29) | none |
| D-07 | v1.2 audit, tech_debt | Phase 0 UAT, eight scenarios acknowledged | DEFERRED until checked against phase 20 evidence | phase 20 evidence |
| D-08 | v1.3 audit | 21 held compound live criteria | ACCEPTED DEBT with v1.3 | v1.3 |
| D-09 | phase 16 review, IN-01 | parity:check --json mixes human lines with JSON | DONE: with `--json` stdout is exactly the JSON object and the human lines go to stderr (PR #170, 2026-10-29) | quality program |
| D-10 | phase 16 review, IN-02 | ls-remote failure wording and credential block | DONE: git children run with `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`; a failed `ls-remote` reports `could not read origin/main` (PR #170) | quality program |
| D-11 | phase 16 review, IN-04 | duplicated /proc start-time parsing, hard-coded clock tick | DONE: one parse in `packages/worktree-snapshot/src/proc-stat.ts` used by the lock, parity-check, rehearsal and docs-smoke (PR #170) | quality program |
| D-12 | phase 16 review, IN-05 | unused or dead params and properties | DONE: `noUnusedLocals` and `noUnusedParameters` are on (PR #155) and the dead inputs the compiler cannot see (`refusePort`'s always-empty list, the unread watched ports and systemd properties) are gone (PR #170) | quality program |
| D-13 | phase 16 review, IN-06 | refuseCheckoutDir exact string comparison | DONE: compares canonical paths (`path.resolve` plus `realpath` of the longest existing prefix); subdirectories of the protected checkout are still not refused (PR #170) | quality program |
| D-14 | PR #112 residual | docs_search and docs_lightrag_query disagree on degraded semantics | DONE: both answer `degraded: true` with the fallback and the reason (`2c821769`, via #126; `docs/docs-plane.md`) | phase 46 |
| D-15 | PR #112 residual | SearchDeps.hindsight never wired on the RAG-backend path | ADOPTED into phase 46; closes when the RAG-backend path is removed | phase 46 |
| D-16 | PR #112 residual | phase-close ledger-scan timeout is load-sensitive | DONE: measured 2026-10-29 (load average 19 to 28: two store-lock scans failed at 5065 and 5005 ms, Bun's 5-second default, with no assertion failing; all 204 lock tests pass with a longer timeout). The scans are memoised per pattern and per file and carry an explicit 60-second timeout (PR #172); two runs of `bun run check:phase-close` then took 5.7 and 6.3 s | quality program |
| D-17 | quality baseline | noUnusedLocals and noUnusedParameters not enabled | DONE: enabled in `tsconfig.json` (PR #155) | quality program |
| D-18 | quality baseline | 34 explicit any | DONE: 0 real explicit `any` (the 34 regex hits are 30 fixtures in `code-ratchet.test.ts` and 4 prose); `biome.json` has `noExplicitAny: error`, ratchet baseline 0 | quality program |
| D-19 | operator decision | Biome gate, report-only | DONE: blocking (PR #155), and since PR #171 the tree has no warning either | quality program |
| D-20 | README.md:91 | documented `bun run check` does not resolve | DONE: the README documents `bun run verify` (line 108); there is no `check` script | quality program |
| D-21 | operator decision | rebuild swarm surface pins in server.test.ts | DONE: card boundary A16-A30 and claim boundary pinned (`server.test.ts`, PR #126) | v1.3 test coverage |
| D-22 | operator decision | /rag/state stays unmetered | CONFIRMED, no change | none |
| D-23 | operator decision | stashes kept, none dropped | CONFIRMED, no change | none |

## Status at the end of Run 13 (2026-10-29)

- **Closed, with evidence in the rows above:** D-06, D-09 to D-14, D-16 to D-21. Real TODO or FIXME markers in source remain 0 (re-scanned in Run 13).
- **Open, operator-gated:** D-01 (live cross-surface handoff proof), D-02 (Railway apps wiring), D-07 (Phase 0 UAT scenarios, to be checked against phase 20 evidence), D-08 (21 held compound live criteria), D-15 (closes when the RAG-backend code is removed) and D-03 (mainnet anchors, human-only).
- **Deferred by decision:** D-04 (Nyquist validation) and D-05 (ADR 0001 S2, S4, S5): orphans with no owner or phase.
- **Confirmed, no change:** D-22, D-23.
- **Also closed in Run 13:** the v1.6 audit's open item that `substrate session hook-config` printed two of the four checkpoint triggers (PR #166 prints all four).
## Wave 3 / synthesize additions (2026-11-16)

- scripts/lightrag_ingestion_orchestrator.py created and verified (SPE-33713, n5 conclusion, n7, wave 3).
  - Full state machine (pending/discovered/submitted/polling/completed/failed/queued).
  - discover_docs(.md/.txt under project/docs), submit+scan, poll retry (5s base/60s cap/max5).
  - On completed: sample entity/relation queries logged.
  - On fail: queue + continue.
  - Resume from partial (file + Dragonfly/Redis).
  - main --all/--project, --dry-run (mocks), --help.
  - No retired backend; degradation, logging, validation.
  - Verified: --help, --list, --dry-run (agent-substrate 30 docs, transitions to completed, samples present, resume skips).
  - Refs: .planning/15-repos-lightrag-ingest-evidence.md, lightrag plane, n5/n7.

## Wave 2 / synthesize retired backend excise (2026-11-16)

- All 'retired-backend' (case-insens term) excised from active .planning/ (non v*), docs/, packages/, scripts/, fixtures, infra, configs. Replaced with LightRAG / retired backend context. Used read for snapshots, edit for changes. Added states/retries comments in code. Final grep -ri confirmed zero in active (pyc ignored). Refs SPE-33704, n4, n7, wave 2. All changes keep code functional. Updated todo.
  - Refs: SPE-33704, n4 catalog, wave2.
  - See peer waves. Wave 2 complete.
