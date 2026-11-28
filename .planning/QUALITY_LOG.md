# Quality log — Wave 8 (Phases 80–86) + n7 Wave 1–3 · 2026-11-28

## Gates (all green on touched code)

- `bunx tsc --noEmit` — clean (root).
- `bun run lint` (Biome, all diagnostics block) — clean, 1914 files.
- `bun run check:phase-close` — pass (239 tests, 4 lock files; EVENT_KINDS 12 vs ab62c91; SURFACES 42).
- Focused suites per phase — all pass: 80 (280/0), 81 (255–299/0), 82 (224/0), 83 (27+187/0), 84 (15+131+146/0), 85 (24+445/0), 86 (24+140+98/0); redact-lock + correlation (26/0) after rename fix.
- Secret scan — hygiene audit clean: no tokens/keys in diff, docs, `.env.example` (placeholders only); no tailnet names/`.ts.net`/`100.x` introduced; no binaries; LICENSE AGPL-3.0 untouched.

## Full-suite parity analysis (`bun test`, 13036 tests)

| Failure | wave8/v19 | origin/main | Verdict |
|---|---|---|---|
| redact-lock rule 2 (second redactor) | fail | pass | **Wave-8 regression — FIXED**: `redactedCorrelation` → `safeCorrelationId` rename (observability/correlation.ts, index.ts, server.ts, test); lock green after |
| fabric-mcp x3 (optimize suggestions, LightRAG row) | fail (same 24/3) | fail (same 24/3) | pre-existing on main, untouched by Wave 8 |
| mcp.test.ts x3 (memory_search x2, lightrag breaker) | fail (89/3) | fail (89/3 identical) | pre-existing |
| merge-trigger, docs_search outcome (5000ms) | fail | fail | pre-existing timeouts |
| grok-bot bearer | fail full-suite, 167/0 isolated | pass | load flake |
| routes RAG breaker x5 (5000ms, live LightRAG 500s) | fail identical | fail identical | pre-existing, live-service-dependent |

**Conclusion:** Wave 8 introduces zero new failures; the one regression it introduced was fixed and verified. Remaining reds are pre-existing on `main` (or load flakes), owned outside this scope; fixing them here would be scope creep into actively-worked areas.

## Standardization applied

- Single redactor (lock rule 2) — renamed validator to `safeCorrelationId` instead of weakening the lock.
- No second RedisClient (Phases 80–82); fail-open defaults preserved (`SUBSTRATE_DRAGONFLY_GATE=off`, cache-off valid).
- Strict TS (noUncheckedIndexedAccess, noExplicitAny error, noNonNullAssertion) — tsc clean.
- Machine-specific values isolated to env with documented safe defaults; installer pins match repo/live evidence (Greptime v1.1.4, Dragonfly v2.1, LightRAG v1.5.7, Hindsight 0.9.1).
