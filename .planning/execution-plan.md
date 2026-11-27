# Execution plan (waves) — Wave 6 (n7 SPE-38290) · 2026-11-26

File-disjoint waves; sequential where dependencies demand. Verification per wave; STOP on red.

- **Wave 1 DONE** — inventory + checkpoint + unknowns (`.planning/audit/*.md`).
- **Wave 2 DONE** — decomposition + pause call (`.planning/audit/phase-decomposition.md`).
- **Wave 3 DONE** — F1–F7 matrix (`.planning/selection-matrix.md`).
- **Wave 4 DONE** — interop/tracking design (`.planning/interoperability-design.md`).
- **Wave 5 DONE** — risk register (`.planning/risks-verification.md`).
- **Wave 6** — apply v50–52 on rehearsed prod dump → verify (rowcount/checksum/latency) → LightRAG: resume 4 pending repos per-batch with retrieval check → P0 baselines (recall@5, TTFB). Files: `index-store.ts` (merge PR), rehearsal logs in `audit/`.
- **Wave 7** — STATE.md + ROADMAP.md update, per-phase CONTEXT/PLAN/SUMMARY, Linear/Notion status reflect true state (after Wave-3 sync gate), milestone acceptance audit.
- **Verify (final):** `bunx tsc --noEmit` (green 2026-11-26) · `bun run verify` (full) · migrate tests 63 pass (2026-11-26) · LightRAG retrieval suite · secret/injection grep.

Blocked-gates: (a) Wave-3 sync writes (Notion DB ID + Linear team), (b) human-verify closes for 8 `human_needed` phases, (c) prod apply needs operator rehearsal window.
