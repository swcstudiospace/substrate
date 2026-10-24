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
| D-02 | v1.0 audit, tech_debt | Railway apps (hindsight, ragflow, dragonfly) wiring | ADOPTED into phase 46 (migration) | phase 46 |
| D-03 | v1.0 audit, tech_debt | Solana mainnet for anchors | DEFERRED, human-only | none |
| D-04 | v1.0 audit, tech_debt | Nyquist validation not run | DEFERRED, orphan | none |
| D-05 | v1.1 audit, deferred | ADR 0001 S2, S4, S5 | DEFERRED, orphan | none |
| D-06 | v1.1 audit, deferred | Lessons-bank decision | GREY_AREA, awaits the user | user |
| D-07 | v1.2 audit, tech_debt | Phase 0 UAT, eight scenarios acknowledged | DEFERRED until checked against phase 20 evidence | phase 20 evidence |
| D-08 | v1.3 audit | 21 held compound live criteria | ACCEPTED DEBT with v1.3 | v1.3 |
| D-09 | phase 16 review, IN-01 | parity:check --json mixes human lines with JSON | DEFERRED, orphan | none |
| D-10 | phase 16 review, IN-02 | ls-remote failure wording and credential block | DEFERRED, orphan | none |
| D-11 | phase 16 review, IN-04 | duplicated /proc start-time parsing, hard-coded clock tick | FOLD when touched, else DEFERRED | quality program |
| D-12 | phase 16 review, IN-05 | unused or dead params and properties | FOLD when touched (noUnusedParameters) | quality program |
| D-13 | phase 16 review, IN-06 | refuseCheckoutDir exact string comparison | FOLD when touched, else DEFERRED | quality program |
| D-14 | PR #112 residual | docs_search and docs_lightrag_query disagree on degraded semantics | ADOPTED into phase 46 | phase 46 |
| D-15 | PR #112 residual | SearchDeps.hindsight never wired on the RAGFlow path | ADOPTED into phase 46; closes when the RAGFlow path is removed | phase 46 |
| D-16 | PR #112 residual | phase-close ledger-scan timeout is load-sensitive | DEFERRED until measured against the quality baseline | quality program |
| D-17 | quality baseline | noUnusedLocals and noUnusedParameters not enabled | ADOPTED into the quality program, touched code only | quality program |
| D-18 | quality baseline | 34 explicit any | FOLD when touched | quality program |
| D-19 | operator decision | Biome gate, report-only | ADOPTED, approved | quality program |
| D-20 | README.md:91 | documented `bun run check` does not resolve | FOLD, in the README edit this run makes | quality program |
| D-21 | operator decision | rebuild swarm surface pins in server.test.ts | ADOPTED | v1.3 test coverage |
| D-22 | operator decision | /rag/state stays unmetered | CONFIRMED, no change | none |
| D-23 | operator decision | stashes kept, none dropped | CONFIRMED, no change | none |
