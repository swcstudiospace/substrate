# Phase 46 (ragflow (retired)-hybrid) summary

Plan: `46-PLAN.md`. Branch: `reconcile/main-2026-11-11`. Date: 2026-11-12 (UTC).

## Status

Partially executed. Offline tasks T1 to T5 are already landed in branch history. This run verified them and made no further edits. Tasks T6 to T8 and checkpoints C1 to C7 are not run. They need operator decisions D1 to D4 and draft PRs, and nothing in this run merged, pushed or committed.

## Offline tasks (landed earlier, re-verified here)

| Task | Commit (reachable from HEAD) | Verified this run |
|---|---|---|
| T1 trim SC1 LightRAG tests | 5732b3b1 | docs-search and server tests: 188 pass, 0 fail |
| T2 freeze 10-query sample | 8a55bdf5 | anchors `## What is checked, and in what order` and `## Duplicates` present in `docs/skills-propose.md` |
| T3 PARITY_GATE comparator | 4ad7dc7e | parity-gate tests: 43 pass, 0 fail. CLI without `LIGHTRAG_URL` exits 2 |
| T4 probe tests and `probe:lightrag` | 0011d77b | probe tests: 15 pass, 0 fail. CLI without `LIGHTRAG_URL` exits 2 |
| T5 cutover record and docs-plane | eb071794 | secret and host grep on `docs/runbooks/lightrag-cutover.md` found no match |

D1 to D6 were recorded as agent defaults in 32fcde58, pending operator. This run did not change them.

## Commands and exit codes

- `bun test packages/mcp-server/src/docs-search.test.ts packages/mcp-server/src/server.test.ts` → 0 (188 pass)
- `bun test packages/mcp-server/src/parity-gate.test.ts` → 0 (43 pass)
- `env -u LIGHTRAG_URL bun scripts/parity-gate.ts --part A` → 2 (no socket opened)
- `bun test scripts/lightrag-probe.test.ts` → 0 (15 pass)
- `env -u LIGHTRAG_URL bun scripts/lightrag-probe.ts` → 2 (no socket opened)
- `git grep -n -i -E "tailnet|ts\.net|Bearer |sk-" -- docs/runbooks/lightrag-cutover.md` → 1 (no match, as required)
- `grep -n "What is checked, and in what order\|^## Duplicates" docs/skills-propose.md` → 0

Not run: `bunx tsc --noEmit` and the full `bun test` (not required for the offline tasks; T6 onward requires them). `bun run check:phase-close` and `bun run config:reference -- --check` were not run.

## Live steps (not run, operator-gated)

- C1 timed probe (`bun run probe:lightrag` against LightRAG): not run
- C2 archive: not run (D1 pending)
- C3 parity Part A against production: not run
- C4 parity Part B and delta pass: not run
- C5 to C7 (RAG-dependent gate, production env, storage deletion): not run

## Changed files

- `.planning/phases/46-ragflow (retired)-hybrid/SUMMARY.md` (new)

No other files were edited. `STATE.md` and `VERIFICATION.md` were not touched. No commits, pushes or staging.

## Decisions needed (operator)

- D1 archive path: (a) volume-level archive, (b) attestation, or (c) keep as debt and retire `docs-archive.ts`. Plan default is (c).
- D2 parity source: LightRAG records (default) or waive as not applicable to the empty source.
- D3 sample and threshold: 10 queries at 100 percent (default) or 20 at 0.85.
- D4 reversibility: accept that RAGFlow (retired) reversal is impossible (default), which the cutover record does not yet state as decided.
- D5 hybrid in production: stay naive until an LLM route exists (default).
- D6 RAG-dependent gate and removal: waive or re-scope phases 25, 40, 42; exclude 34; approve removing `ragflow (retired)` from FABRIC_RESOURCES as a phase 51 contract change; keep the folder name or rename.
- Approval for each live checkpoint C1 to C7, recorded in STATE.md before it runs.
- Whether the plan's commit-per-task rule still applies. This run did not commit.
