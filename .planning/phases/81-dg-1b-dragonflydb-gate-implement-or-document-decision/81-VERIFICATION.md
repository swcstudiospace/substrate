---
phase: 81-dg-1b-dragonflydb-gate-implement-or-document-decision
verified: 2026-11-28T06:00:00Z
status: passed
score: 6/6 must-haves verified
behavior_unverified: 1
decision_coverage: { honored: 4, total: 4, not_honored: [] }
covered_files:
  - .planning/phases/81-dg-1b-dragonflydb-gate-implement-or-document-decision/81-CONTEXT.md
  - .planning/phases/81-dg-1b-dragonflydb-gate-implement-or-document-decision/81-PLAN.md
  - .planning/phases/81-dg-1b-dragonflydb-gate-implement-or-document-decision/81-SUMMARY.md
  - .planning/phases/80-dg-1a-dragonflydb-gate-probe-and-readiness-check/80-SUMMARY.md
  - packages/mcp-server/src/flag-registry.ts
  - packages/mcp-server/src/config.ts
  - packages/mcp-server/src/cache.ts
  - packages/mcp-server/src/fabric/dragonfly-readiness.ts
  - packages/mcp-server/src/cache.test.ts
  - packages/mcp-server/src/fabric/dragonfly-readiness.test.ts
  - packages/mcp-server/src/flag-registry.test.ts
  - scripts/config-reference.test.ts
  - docs/data-planes.md
  - docs/config-reference.md
  - .env.example
---

# Phase 81 Verification: DG-1b DragonflyDB Gate — Implement-or-Document Decision

**Verified:** 2026-11-28
**Worktree:** `/tmp/agent-substrate-wave8`
**Scope:** Goal-backward check against `81-CONTEXT.md` + `81-PLAN.md`. Read-only; no product code, STATE, or ROADMAP edits. Loop harness not re-run (orchestrator-verified per brief).

## Verdict summary

**Status: `passed`** — Phase 81 shipped the **implement** branch: a registered `SUBSTRATE_DRAGONFLY_GATE` flag (default `off`) plus a synchronous `dragonflyGateVerdict()` consulted per-read at `ReadThroughCache` enablement. All six assignment criteria are met in code and tests. One item remains behaviour-unverified: the live L7 gate verdict (`healthz`/`fabric` capture) was not re-captured here — the same unbuilt-dependency limitation recorded in Phase 80 (`80-SUMMARY.md:14`).

## Criterion verdicts

| # | Criterion | Verdict | Evidence (file:line) |
|---|---|---|---|
| 1 | **Implement, not document-only**, grounded in DG-1a verdict — decision recorded, enforcement shipped | **passed** | `81-SUMMARY.md:3-5` (Decision: implement; rationale: DG-1a probe `ok`, docker `healthy` 2026-11-28, fakes green); grounding matches `80-SUMMARY.md:18-20` (E2 only behind green `ok`; `unavailable` blocks; `degraded` names follow-up). Enforcement code: `cache.ts:588-592,646-650`; `fabric/dragonfly-readiness.ts:81-89`. |
| 2 | **`SUBSTRATE_DRAGONFLY_GATE` registered + default `off` + junk refused** | **passed** | `flag-registry.ts:620` (mode kind, plane `cache`, default `off`, allowed `off \| enforce`, `readBy: mcp-server/config.ts, cache.ts`, `doc: docs/data-planes.md`); `config.ts:1653-1658` (`dragonflyGateOr`: unset/blank→`off`, case/space-insensitive, else throws `ConfigError` naming the variable); `.env.example:239` (live `SUBSTRATE_DRAGONFLY_GATE=off`); `docs/config-reference.md:165` (regenerated row); tests `flag-registry.test.ts:271-282` (unset→`off`, `ENFORCE`→`enforce`, junk `on` throws, `.env.example` line, defaults-agreement `:215`); `scripts/config-reference.test.ts:152` (row renders `off \| enforce`). |
| 3 | **Gate enforcement** — `enforce` blocks on `unavailable`/`unconfigured` (durable read, counts bypass); `degraded` still serves; `off` unchanged | **passed** | `cache.ts:588-592` (`gateAllows()`: `off`→allow; `enforce`→state must be `ok`/`degraded`); `:646-650` (`getOrLoad` bypass: counts `bypass`, returns `request.load()` — durable, never stale, never throws); peeks return null: `:1015` (`peek`), `:1047` (`peekQuiet`), `:1068` (`peekMany`). Verdict read per call, never baked into `enabled` (`cache.ts:568,579-586`). Tests `cache.test.ts:2216-2311`: enforce ok serves (loads=1, hits=1); enforce degraded serves; enforce unavailable bypasses + snapshots suppressed (bypasses=1, errors=0); enforce no-verdict (unconfigured) bypasses; off + unavailable still serves a hit. `fabric/dragonfly-readiness.test.ts:139-180`: off→`unconfigured` even after ok probe; enforce/no-verdict→`unconfigured`; last verdict ok/unavailable/degraded tracked; record+reset seams. |
| 4 | **No second `RedisClient`** — gate rides the DG-1a probe path | **passed** | Single `new RedisClient` in the codebase: `cache.ts:394` (inside `bunRedis`); `dragonfly-readiness.ts:267` ("never a second `RedisClient`"); `probeDragonflyReadiness` records its verdict (`dragonfly-readiness.ts:142-149`) so `service.ts`/`healthz` feed the gate with no wiring change and no new client. Write paths (`put`/`putEntry`) and `redisClient()` untouched — confirmed by absence of `gateAllows` at write sites (only 4 call sites: `cache.ts:646,1015,1047,1068`, all read paths). |
| 5 | **Loop harness green** — tests, `tsc`, lint, phase-close (orchestrator-verified 299/0; not re-run) | **passed** (orchestrator-verified) | Per brief: 299 pass / 0 fail, `tsc --noEmit`, `bun run lint`, `bun run check:phase-close` all green. `81-SUMMARY.md:39-47` records the executor's wider run (330 pass, 0 fail, 1822 expect() calls, 8 files; tsc 0 errors; biome clean, 1873 files; phase-close pass). The 299 vs 330 count difference is harness scope (brief's focused set vs SUMMARY's whole `fabric/` dir), not a result difference — both report 0 failures. Verifier did not re-run per brief. |
| 6 | **Docs + SUMMARY** | **passed** | `docs/data-planes.md:265` — DG-1b enforcement paragraph (flag semantics, `dragonflyGateVerdict()`, enforce rule, fail-open/durable-read guarantees, E2 Phase 82 consumption); `docs/config-reference.md:165` — regenerated flag row; `81-SUMMARY.md` — decision, "what shipped" (flag/verdict/enforcement), live-evidence section (docker `healthy` 2026-11-28), full file list, loop-harness results. All files in the SUMMARY's list were confirmed present with matching content. |

## Gaps

1. **Live L7 gate verdict not captured (behaviour-unverified, not a code defect).** Runtime truth by probes, not intent (baseline §4): `81-SUMMARY.md:17` states the expected verdict is `ok` "once a probe runs" — an expectation, not a captured `healthz` `cache.readiness` body or fabric `dragonfly` row. The executor worktree lacks the built `@substrate/observability` dependency (same limitation as `80-SUMMARY.md:14`), so the L7 path could not be executed here. **Human needed:** re-run where dependencies are installed; capture `GET /healthz` `cache.readiness` and the fabric `dragonfly` row. If L7 ever reads `unavailable` while docker reports `healthy`, resolve that disagreement before E2 enablement (`80-SUMMARY.md:20`).
2. **Harness count reconciliation (informational).** Brief says 299/0; `81-SUMMARY.md` says 330 pass / 1822 expects. Both are consistent with a 0-failure green run under different harness scopes. No action required; recorded so the number isn't mistaken for a discrepancy in results.

## Notes

- Design detail worth keeping: `dragonflyGateVerdict("off")` answers a synthetic `unconfigured` verdict (`fabric/dragonfly-readiness.ts:81-84`), but `gateAllows()` short-circuits before any verdict read when the flag is `off` (`cache.ts:589`) — so `off` behaviour is byte-identical to pre-DG-1b, verified by the `cache.test.ts:2282-2295` test.
- Peek paths (`peek`/`peekQuiet`/`peekMany`) return `null` under a blocked gate without counting a bypass, by design (`cache.ts:1012-1015` comment: the brief this read belongs to already counted one). Only `getOrLoad` counts the bypass (`cache.ts:647`), matching the plan.
- E2 (Phase 82) consumption is wired through the same `dragonflyGateVerdict()` / `ReadThroughOptions.gateMode` surface; no E2 cache feature was built in this phase, as scoped.
