---
phase: 81-dg-1b-dragonflydb-gate-implement-or-document-decision
verified: 2026-11-28T06:14:40Z
status: passed
score: 6/6 must-haves verified
covered_files:
  - .env.example
  - .planning/phases/81-dg-1b-dragonflydb-gate-implement-or-document-decision/81-PLAN.md
  - .planning/phases/81-dg-1b-dragonflydb-gate-implement-or-document-decision/81-SUMMARY.md
  - docs/config-reference.md
  - docs/data-planes.md
  - packages/mcp-server/src/cache.test.ts
  - packages/mcp-server/src/cache.ts
  - packages/mcp-server/src/config.ts
  - packages/mcp-server/src/fabric/dragonfly-readiness.test.ts
  - packages/mcp-server/src/fabric/dragonfly-readiness.ts
  - packages/mcp-server/src/flag-registry.test.ts
  - packages/mcp-server/src/flag-registry.ts
  - scripts/config-reference.test.ts
covered_digest: "v3:sha256:9f2a482c98fbb80ef2e0b0aa8cc93b39c7b31ece22c1eba18a5d8a0588c25c00"
decision_coverage: { honored: 4, total: 4, not_honored: [] }
behavior_unverified: 1
behavior_unverified_items:
  - truth: "Live L7 gate verdict (healthz cache.readiness / fabric dragonfly row) reads ok as expected once a probe runs"
    test: "Where @substrate/observability is built: capture GET /healthz cache.readiness and the fabric dragonfly row, then record dragonflyGateVerdict under enforce"
    expected: "Verdict ok (docker healthy 2026-11-28); if L7 ever reads unavailable while docker reports healthy, resolve the disagreement before E2 enablement"
    why_human: "L7 path could not be executed in this worktree (unbuilt @substrate/observability dependency; same limitation as 80-SUMMARY.md:14); runtime truth by probes, not intent"
re_verification:
  previous_status: passed
  previous_score: 6/6 must-haves verified (2026-11-28T06:00:00Z)
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 81 Verification: DG-1b DragonflyDB Gate — Implement-or-Document Decision (Re-verification)

**Verified:** 2026-11-28T06:14:40Z
**Worktree:** `/tmp/agent-substrate-wave8`
**HEAD:** `69f1e642554de81448fddbb37373bc84b9e7e605` (`feat(v1.9-p81): DG-1b DragonflyDB Gate implement (enforce fail-open)`)
**Scope:** Re-verification against `81-CONTEXT.md` + `81-PLAN.md` on current HEAD. Read-only; no product code, STATE, or ROADMAP edits. Loop harness not re-run (orchestrator-verified per brief; `81-SUMMARY.md:37-48`).

## Verdict summary

**Status: `passed`** — Phase 81 shipped the **implement** branch: a registered `SUBSTRATE_DRAGONFLY_GATE` flag (default `off`) plus a synchronous `dragonflyGateVerdict()` consulted per-read at `ReadThroughCache` enablement. All six must-haves are met in code and tests at HEAD `69f1e642`. One item remains behaviour-unverified: the live L7 gate verdict was not re-captured here (see `behavior_unverified_items`).

## Criterion verdicts

| # | Criterion | Verdict | Evidence (file:line at HEAD) |
|---|---|---|---|
| 1 | **Implement, not document-only**, grounded in DG-1a verdict | **passed** | `81-SUMMARY.md:3-5` (Decision: implement; rationale: DG-1a probe `ok`, docker `healthy` 2026-11-28, fakes green); grounding matches `80-SUMMARY.md:18-20`. Enforcement code: `cache.ts:588-592,646-650`; `fabric/dragonfly-readiness.ts:81-89`. |
| 2 | **`SUBSTRATE_DRAGONFLY_GATE` registered + default `off` + junk refused** | **passed** | `flag-registry.ts:620` (mode kind, plane `cache`, default `off`, allowed `off \| enforce`, `readBy: mcp-server/config.ts, cache.ts`, `doc: docs/data-planes.md`); `config.ts:1653-1658` (`dragonflyGateOr`: unset/blank→`off`, case/space-insensitive, else throws `ConfigError` naming the variable); `.env.example:239` (live `SUBSTRATE_DRAGONFLY_GATE=off`); `docs/config-reference.md:165` (regenerated row); tests `flag-registry.test.ts:271-282` (unset→`off`, `ENFORCE`→`enforce`, junk `on` throws, `.env.example` line, defaults-agreement `:215`); `scripts/config-reference.test.ts:152` (row renders `off \| enforce`). |
| 3 | **Gate enforcement** — `enforce` blocks on `unavailable`/`unconfigured` (durable read, counts bypass); `degraded` still serves; `off` unchanged | **passed** | `cache.ts:588-592` (`gateAllows()`: `off`→allow; `enforce`→state must be `ok`/`degraded`); `:646-650` (`getOrLoad` bypass: counts `bypass`, returns `request.load()` — durable, never stale, never throws); peeks return null: `:1015` (`peek`), `:1047` (`peekQuiet`), `:1068` (`peekMany`). Verdict read per call, never baked into `enabled` (`cache.ts:568,579-586`). Tests `cache.test.ts:2206-2311`: enforce ok serves; enforce degraded serves; enforce unavailable bypasses + snapshots suppressed; enforce no-verdict (unconfigured) bypasses; off + unavailable still serves a hit. |
| 4 | **No second `RedisClient`** — gate rides the DG-1a probe path | **passed** | Single `new RedisClient` in the codebase: `cache.ts:394` (inside `bunRedis`); `dragonfly-readiness.ts` module state `lastGateVerdict` (`:64`) with `recordDragonflyGateVerdict`/`resetDragonflyGateVerdict` seams (`:67,72`); `probeDragonflyReadiness` records its verdict (`dragonfly-readiness.ts:147`) so `service.ts`/`healthz` feed the gate with no wiring change and no new client. Write paths (`put`/`putEntry`) and `redisClient()` untouched — confirmed by absence of `gateAllows` at write sites (only 4 call sites: `cache.ts:646,1015,1047,1068`, all read paths). |
| 5 | **Loop harness green** — tests, `tsc`, lint, phase-close (orchestrator-verified; not re-run) | **passed** (orchestrator-verified) | Per brief: focused harness green. `81-SUMMARY.md:39-47` records the executor's wider run (330 pass, 0 fail, 1822 expect() calls, 8 files; tsc 0 errors; biome clean, 1873 files; phase-close pass). Re-verifier did not re-run per brief; `git log` confirms HEAD `69f1e642` is the Phase 81 implementation commit, so the recorded run applies to this tree. |
| 6 | **Docs + SUMMARY** | **passed** | `docs/data-planes.md:265` — DG-1b enforcement paragraph (flag semantics, `dragonflyGateVerdict()`, enforce rule, fail-open/durable-read guarantees, E2 Phase 82 consumption); `docs/config-reference.md:165` — regenerated flag row; `81-SUMMARY.md` — decision, "what shipped" (flag/verdict/enforcement), live-evidence section (docker `healthy` 2026-11-28), full file list, loop-harness results. All files in the SUMMARY's list confirmed present at HEAD with matching content. |

## Decision coverage

All four `81-CONTEXT.md` Implementation Decisions are honored:

| Decision | Status | Evidence |
|---|---|---|
| Implement (not document-only), enforce with fail-open default off | honored | Assumption verified at `cache.ts:588-592` + `dragonfly-readiness.ts:81-89`; `81-SUMMARY.md:3-5`. |
| Flag registration in `flag-registry.ts` + `config.ts` + `.env.example` | honored | `flag-registry.ts:620`; `config.ts:1653-1658`; `.env.example:239`. |
| Non-blocking: cache-off valid; enforcement never throws/503s; degraded still serves | honored | `cache.ts:646-650` bypass is a return, not a throw; `gateAllows()` returns `true` on `degraded` (`:591`). |
| SUMMARY records implement choice + DG-1b rationale + live verdict snapshot | honored | `81-SUMMARY.md:3-19`. |

## Gaps

No code gaps. One behaviour-unverified item (live L7 capture) is recorded in `behavior_unverified_items` above. Prior report's 299-vs-330 harness count note: both report 0 failures under different harness scopes; not a discrepancy.

## Notes

- Design detail worth keeping: `dragonflyGateVerdict("off")` answers a synthetic `unconfigured` verdict (`fabric/dragonfly-readiness.ts:81-84`), but `gateAllows()` short-circuits before any verdict read when the flag is `off` (`cache.ts:589`) — so `off` behaviour is byte-identical to pre-DG-1b, verified by the `cache.test.ts:2282-2295` test.
- Peek paths (`peek`/`peekQuiet`/`peekMany`) return `null` under a blocked gate without counting a bypass, by design (`cache.ts:1012-1015` comment: the brief this read belongs to already counted one). Only `getOrLoad` counts the bypass (`cache.ts:647`), matching the plan.
- E2 (Phase 82) consumption is wired through the same `dragonflyGateVerdict()` / `ReadThroughOptions.gateMode` surface; no E2 cache feature was built in this phase, as scoped.
- `covered_files`/`covered_digest` computed via `gsd_run query verification.fingerprint` over the implementation files above plus the phase PLAN/SUMMARY (auto-included by the command); digests are current for HEAD `69f1e642`.

_Verified: 2026-11-28T06:14:40Z — Verifier: GSD verifier (subagent), HEAD 69f1e642_
