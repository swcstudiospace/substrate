---
phase: 81-dg-1b-dragonflydb-gate-implement-or-document-decision
verified: 2026-11-28T14:57:44Z
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
covered_digest: "v3:sha256:99b0e617495af337e9bd962783472acba35dd7067a6b0189a7687abeddbc742c"
decision_coverage: { honored: 4, total: 4, not_honored: [] }
behavior_unverified: 1
behavior_unverified_items:
  - truth: "Live L7 gate verdict (healthz cache.readiness / fabric dragonfly row) reads ok as expected once a probe runs"
    test: "Where @substrate/observability is built: capture GET /healthz cache.readiness and the fabric dragonfly row, then record dragonflyGateVerdict under enforce"
    expected: "Verdict ok (docker healthy 2026-11-28); if L7 ever reads unavailable while docker reports healthy, resolve the disagreement before E2 enablement"
    why_human: "L7 path could not be executed in this worktree (unbuilt @substrate/observability dependency; same limitation as 80-SUMMARY.md:14); runtime truth by probes, not intent"
re_verification:
  previous_status: passed
  previous_score: 6/6 must-haves verified (2026-11-28T06:14:40Z)
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 81 Verification: DG-1b DragonflyDB Gate — Implement-or-Document Decision (Re-verification)

**Verified:** 2026-11-28T14:57:44Z
**Worktree:** `<repo-root>`
**HEAD:** `8af8b844f00b44dd7132cae85231913080973fe7` (`docs(86): VERIFICATION + phase complete`)
**Scope:** Re-verification against `81-CONTEXT.md` + `81-PLAN.md` at current HEAD. Read-only; no product code, STATE, or ROADMAP edits. Focused test harness re-run by this verifier (see §5).

## Verdict summary

**Status: `passed`** — Phase 81 shipped the **implement** branch: a registered `SUBSTRATE_DRAGONFLY_GATE` flag (default `off`) plus a synchronous `dragonflyGateVerdict()` consulted per-read at `ReadThroughCache` enablement. All six must-haves hold at HEAD `8af8b844` despite later Phase 82 drift in `cache.ts`/`cache.test.ts` (additive shared-lane surface; gate rule unchanged — see Notes). One item remains behaviour-unverified: the live L7 gate verdict was not re-captured here (see `behavior_unverified_items`).

## Criterion verdicts

| # | Criterion | Verdict | Evidence (file:line at HEAD) |
|---|---|---|---|
| 1 | **Implement, not document-only**, grounded in DG-1a verdict | **passed** | `81-SUMMARY.md:3-5` (Decision: implement; rationale: DG-1a probe `ok`, docker `healthy` 2026-11-28, fakes green); grounding matches `80-SUMMARY.md:18-20`. Enforcement code: `cache.ts:600-604,658-662`; `fabric/dragonfly-readiness.ts:81-89`. |
| 2 | **`SUBSTRATE_DRAGONFLY_GATE` registered + default `off` + junk refused** | **passed** | `flag-registry.ts:620` (mode kind, plane `cache`, default `off`, allowed `off \| enforce`, `readBy: mcp-server/config.ts, cache.ts`, `doc: docs/data-planes.md`); `config.ts:1653-1658` (`dragonflyGateOr`: unset/blank→`off`, case/space-insensitive, else throws `ConfigError` naming the variable); `.env.example:239` (live `SUBSTRATE_DRAGONFLY_GATE=off`); `docs/config-reference.md:165` (regenerated row); tests `flag-registry.test.ts:271-282` (unset→`off`, `ENFORCE`→`enforce`, junk `on` throws, `.env.example` line, defaults-agreement `:215`); `scripts/config-reference.test.ts:152` (row renders `off \| enforce`). |
| 3 | **Gate enforcement** — `enforce` blocks on `unavailable`/`unconfigured` (durable read, counts bypass); `degraded` still serves; `off` unchanged | **passed** | `cache.ts:600-604` (`gateAllows()`: `off`→allow; `enforce`→state must be `ok`/`degraded`); `:658-662` (`getOrLoad` bypass: counts `bypass`, returns `request.load()` — durable, never stale, never throws); peeks return null: `:1027` (`peek`), `:1059` (`peekQuiet`), `:1080` (`peekMany`). Verdict read per call, never baked into `enabled` (`cache.ts:576,584-594`). Tests `cache.test.ts:2241-2330` (DG-1b block: enforce ok serves; enforce degraded serves; enforce unavailable bypasses + snapshots suppressed; enforce no-verdict bypasses; off + unavailable still serves a hit). |
| 4 | **No second `RedisClient`** — gate rides the DG-1a probe path | **passed** | Single `new RedisClient` in the codebase: `cache.ts:395` (inside `bunRedis`); `dragonfly-readiness.ts` module state `lastGateVerdict` (`:64`) with `recordDragonflyGateVerdict`/`resetDragonflyGateVerdict` seams (`:67,72`); `probeDragonflyReadiness` records its verdict (`dragonfly-readiness.ts:147`) so `service.ts`/`healthz` feed the gate with no wiring change and no new client. Write paths (`put`/`putEntry`/`putShared` via `writeKey`) and `redisClient()` untouched by `gateAllows` — all gate call sites are read paths (`cache.ts:658,1027,1059,1080,1157,1197`, the last two being Phase 82 shared-lane reads under the same rule). |
| 5 | **Loop harness green** — tests, `tsc` (re-run by this verifier) | **passed** | This verifier re-ran at HEAD: `bun test packages/mcp-server/src/fabric/dragonfly-readiness.test.ts packages/mcp-server/src/cache.test.ts packages/mcp-server/src/flag-registry.test.ts scripts/config-reference.test.ts` → **255 pass, 0 fail** (1638 expect() calls, 4 files). `bunx tsc --noEmit` (repo root) → 0 errors. Prior wider run recorded in `81-SUMMARY.md:39-47` (330 pass, 0 fail across 8 files incl. `fabric/` dir) is superseded by this narrower re-run; both report 0 failures. |
| 6 | **Docs + SUMMARY** | **passed** | `docs/data-planes.md:265` — DG-1b enforcement paragraph (flag semantics, `dragonflyGateVerdict()`, enforce rule, fail-open/durable-read guarantees, E2 Phase 82 consumption); `docs/config-reference.md:165` — regenerated flag row; `81-SUMMARY.md` — decision, "what shipped" (flag/verdict/enforcement), live-evidence section (docker `healthy` 2026-11-28), full file list, loop-harness results. All files in the SUMMARY's list confirmed present at HEAD with matching content. |

## Decision coverage

All four `81-CONTEXT.md` Implementation Decisions are honored:

| Decision | Status | Evidence |
|---|---|---|
| Implement (not document-only), enforce with fail-open default off | honored | Assumption verified at `cache.ts:600-604` + `dragonfly-readiness.ts:81-89`; `81-SUMMARY.md:3-5`. |
| Flag registration in `flag-registry.ts` + `config.ts` + `.env.example` | honored | `flag-registry.ts:620`; `config.ts:1653-1658`; `.env.example:239`. |
| Non-blocking: cache-off valid; enforcement never throws/503s; degraded still serves | honored | `cache.ts:658-662` bypass is a return, not a throw; `gateAllows()` returns `true` on `degraded` (`:604`). |
| SUMMARY records implement choice + DG-1b rationale + live verdict snapshot | honored | `81-SUMMARY.md:3-19`. |

## Gaps

No code gaps. One behaviour-unverified item (live L7 capture) is recorded in `behavior_unverified_items` above.

## Notes

- **Drift since Phase 81 commit (`69f1e642` → HEAD):** `git diff 69f1e642 HEAD --stat` over the covered files touches only `cache.ts` (+75/-3) and `cache.test.ts` (+129/-…), both from Phase 82 (E2 shared lane). The drift is additive and gate-preserving: `gateAllows()` widened from `private` to public so `SharedContextStore` reuses the single gate rule (comment at `cache.ts:595-599`); new `getShared`/`putShared`/`claimShared` (`cache.ts:1147-1200`) are all gate-checked on reads while writes still bypass the gate for the probe, exactly per the DG-1b rule. No Phase 81 line was weakened.
- Design detail worth keeping: `dragonflyGateVerdict("off")` answers a synthetic `unconfigured` verdict (`fabric/dragonfly-readiness.ts:81-85`), but `gateAllows()` short-circuits before any verdict read when the flag is `off` (`cache.ts:601`) — so `off` behaviour is byte-identical to pre-DG-1b, verified by the `cache.test.ts:2310-2325` test.
- Peek paths (`peek`/`peekQuiet`/`peekMany`) return `null` under a blocked gate without counting a bypass, by design (`cache.ts:1024` comment: the brief this read belongs to already counted one). Only `getOrLoad` counts the bypass (`cache.ts:659`), matching the plan. Phase 82's `getShared` differs deliberately: its fallback read *is* that call, so it counts one bypass (`cache.ts:1157-1162`).
- E2 (Phase 82) consumption is wired through the same `dragonflyGateVerdict()` / `ReadThroughOptions.gateMode` surface; no E2 cache feature was built in this phase, as scoped.
- `covered_files`/`covered_digest` computed via `gsd_run verification fingerprint` over the implementation files above plus the phase PLAN/SUMMARY (auto-included by the command); digests are current for HEAD `8af8b844`. Digest changed since the prior verification (`v3:sha256:9f2a…` → `v3:sha256:99b0e6…`) solely because of the Phase 82 additive drift in `cache.ts`/`cache.test.ts`.

_Verified: 2026-11-28T14:57:44Z — Verifier: GSD verifier (subagent), HEAD 8af8b844_
