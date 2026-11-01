---
phase: 75-dragonfly-degradation
verified: 2026-11-01
status: human_needed
score: 2 of 2 success criteria MET in the repository (by reading the code and tests; nothing run here); live-only items remain
verified_on: worktree /root/src/worktrees/as-gsd-v18-p75 at cd67ce11 (files read; nothing was run by the author of this record)
---

# 75-VERIFICATION: DragonflyDB degradation

## Gates

Not run by the author of this record. The orchestrator reports these results for this branch: `tsc` exit 0; `bun test` 11316 pass, 2 skip, 0 fail; phase-close pass; config reference up to date. This record cites no test result of its own. The config reference is checked on the committed tree by `scripts/config-reference.test.ts` (its header, line 5), so the "up to date" report covers the `SUBSTRATE_BUDGET_<CLASS>_BREAKER` rows added in `docs/config-reference.md`.

Evidence below is file paths, line numbers, and test names read at `cd67ce11`. A PASS here means the in-repo code and test text support the criterion. It does not mean the tests were observed to pass.

## Success criteria

ROADMAP phase 75, success criteria 1 and 2 (`.planning/ROADMAP.md`, Phase 75).

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | With the cache breaker open, brief and recall return authoritative results. A test proves it. | MET | `packages/mcp-server/src/cache.ts:402-413` (open breaker refuses before any socket); `cache.ts:578-580` (a refused read falls through to `request.load()`); `service.ts:2128` (brief `getOrLoad`, load is the live compose); `service.ts:3223` (recall `getOrLoad`, load is `recallMemories`); test `cache-breaker.test.ts` "brief is composed from the index on every call, and the cache never answers it" (lines 73-96), "recall returns the same reply as a substrate with no cache at all" (98-115), "generation keys: a bump the breaker refused keeps reads on the source after it closes, until a bump lands" (117-143) |
| 2 | Admission under an open breaker follows a declared policy per class (fail open or closed), set in flags. | MET | `packages/mcp-server/src/config.ts:1826-1831` (per-class parse of `SUBSTRATE_BUDGET_<CLASS>_BREAKER`), `config.ts:1849-1856` (`breakerPolicyOf`: unset or blank is `fail-open`; any other value besides `fail-open`/`fail-closed` throws `ConfigError` naming the variable); `config.ts:1221` (`loadConfig` calls `loadAdmissionSettings` unguarded, so boot refuses); `admission.ts:49-52` (type and default), `admission.ts:379-383` (refusal only for a breaker refusal, a `fail-closed` class, and `enforce`); `cache.ts:1044` (`breakerRetryAfterMs` set only for `BreakerOpenError`); `server.ts:628` (503 for `refused`, 429 for `limited`, `Retry-After`), `server.ts:908-909` (REST), `server.ts:2647-2650` (MCP batch); test `admission.test.ts` "the cache breaker's refusal, by class policy (phase 75)" (lines 308-360), parse and boot tests (362-376); `http.admission.test.ts` "an open cache breaker is a bypass for a fail-open class and a 503 for a fail-closed one" (264-276); `cache-breaker.test.ts` "admission over the open breaker..." (145-154) |

## Traced path, criterion 1

1. A command to the cache plane goes through `bunRedis.run` (`cache.ts:400-414`). The cooldown check is outside the gate and runs first. Then `callPlane` (`packages/observability/src/breaker.ts:215`) checks the breaker. When it is open, `callPlane` throws `BreakerOpenError` before `fn` runs (`breaker.ts:224-226`). The client is opened inside `fn` (`cache.ts:406`), so no socket is opened and the breaker records no outcome for the refusal.
2. `ReadThroughCache.getOrLoad` reads the generation keys first (`cache.ts:576`). The refusal lands in the `catch`, which calls `fail(cause, true, klass)` and returns `request.load()` (`cache.ts:578-580`). The brief and recall answer from the source.
3. A generation key whose bump the breaker refused is recorded in `staleGenerations` (`cache.ts:852`). `getOrLoad` bypasses any such key (`cache.ts:568-571`) until a bump succeeds (`cache.ts:849`). This holds after the breaker closes.
4. The last-good brief snapshot is read only when a live source failed. That read is `peek` (`service.ts:2232`), and `peek` catches the refusal and returns `null` (`cache.ts:904-931`). The fallback is then a degraded brief (`service.ts:2235-2238`), not a stale one. The recall-snapshot probe is `peekQuiet` (`service.ts:2302`), which returns `cold` on a throw.

## Traced path, criterion 2

1. Each class reads `SUBSTRATE_BUDGET_<CLASS>_BREAKER` (`config.ts:1826-1831`). The value is trimmed and lowercased. Unset or blank is `fail-open`. `fail-open` and `fail-closed` are accepted. Anything else throws `ConfigError` (`config.ts:1849-1856`). Boot refuses, and the message names the variable.
2. `Admission.admit` (`admission.ts:359-401`). `off` skips the eval (`admission.ts:363-365`). A `refused` verdict needs all three: a breaker refusal (`breakerRetryAfterMs` set), a `fail-closed` class, and `enforce` (`admission.ts:379-381`). Every other failure, and every `shadow` case, falls through to `bypass` (`admission.ts:382-383`).
3. `budgetBody` answers `error: "cache_unavailable"` for `refused` (`admission.ts:447-449`). `budgetRefusal` writes the JSON-RPC message for an MCP batch (`admission.ts:456-470`).
4. Metrics: `refused` is a decision (`packages/observability/src/instruments.ts:179`). It is excluded from the admission SLO denominator (`packages/observability/src/slo.ts:366-376`), and it is not `limited`, so it is not in the numerator either. See residual R3.
5. Surfaces: the flag is in `flag-registry.ts:218-230`, documented in `.env.example` (commented), `docs/config-reference.md` (a row in the budget table), and `docs/observability.md` (a paragraph and a row).

## Deviations

- **No PLAN and no SUMMARY.** `.planning/phases/75-dragonfly-degradation/` holds only `75-CONTEXT.md`. No `75-PLAN.md` or `75-SUMMARY.md` was written, and this record does not write them. The code (`63772d5e`, `feat(cache)`) was committed before the decisions were recorded (`e622816c`, `docs(75)`), and before any plan. `ROADMAP.md` still reads "Plans: none written" for phase 75 in this branch. The orchestrator updates ROADMAP and STATE.
- **Verifier definition absent.** `/root/.agents/agents/gsd-verifier.md` does not exist, so the procedure in this record follows the orchestrator's brief. The layout follows `66-VERIFICATION.md`.
- **GSD skills not invoked.** The record is written by hand under the orchestrator's manual-fallback authorization.
- **Config reference wording.** `75-CONTEXT.md` says the reference is "hand-rendered; not yet confirmed against the generator". This record did not re-run the generator. The orchestrator's report and `scripts/config-reference.test.ts` cover it.

## Gaps and scope limits (not failing a criterion)

- **Degraded brief with the breaker open is not tested.** `cache-breaker.test.ts` covers only the case where the live brief composes. No test opens the breaker and also fails a live source, so the `brief-snapshot` refusal and the degraded reply (`service.ts:2232-2238`) run untested with the breaker open. The code path is read above; the outcome is a degraded brief, not a stale one.
- **Cooldown refusals are bypasses in every class.** After a failed connect, `bunRedis` rejects during the cooldown with a plain `Error` (`cache.ts:402-403`), not `BreakerOpenError`. `script` then returns no `breakerRetryAfterMs`, so admission counts a `bypass` even for a `fail-closed` class. The policy applies only once the breaker is open, which is what criterion 2 says. The 75-CONTEXT wording ("only a breaker refusal is policed") agrees with this.
- **`read` fail-closed refuses brief and recall at the door.** With `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` and `SUBSTRATE_BUDGETS=enforce`, an open breaker answers `/brief` and the recall routes with 503 before the handler runs (`server.ts:908-909`). That is the declared policy, but it means criterion 1's "authoritative results" holds under the default `fail-open` admission policy. Under `fail-closed` the answer is a refusal, not a result. The HTTP test (`http.admission.test.ts:264-276`) covers `/brief` only.
- **MCP batch refusal over HTTP is tested only at the admission level.** `admission.test.ts` "a refused batch is refused whole..." (354-360) covers `admitBatch` and `budgetRefusal`. No HTTP test sends a batch against an open breaker.
- **`shadow` with a fail-closed class admits.** The refusal is recorded as `bypass`, not `shadow_limited`, because the cache did not answer (`admission.ts:379-383`). This is the stated design; noted so an operator reading `shadow_limited` does not expect it.

## Residual items

These are not success criteria. They are listed as the orchestrator asked.

- **R1, cross-process staleness after a refused bump (predates this phase).** `staleGenerations` (`cache.ts:494`) lives in the writing process. After a restart, or on another replica, the generation key holds its old value, so a brief written before the write can be served until the brief TTL (`cache.ts:49`, `brief: 300`). The tests cover one process only. This phase does not change it. The follow-up is a durable marker for an unconfirmed bump, or a restart-time generation check.
- **R3, `refused` is outside the admission SLO numerator.** `evaluateAdmissionSlo` (`slo.ts:366-376`) counts `limited` over `allowed + limited + shadow_limited`. A cache outage is the breaker's signal, not a budget breach. `docs/observability.md` says that an outage refusing most traffic can read as `insufficient-data`, and the `refused` series is what shows it. `slo.test.ts:110-112` pins this. Deliberate; the follow-up is an operator alert on `decision="refused"`.
- **R2, resolved in this phase.** An invalid `SUBSTRATE_BUDGET_<CLASS>_BREAKER` now refuses boot (`config.ts:1849-1856`, `admission.test.ts:373-375`). `SUBSTRATE_BUDGETS` keeps its silent fallback to `shadow` (`config.ts:1795`). That is a separate follow-up if the operator wants it changed.

## Human verification (live only)

These items do not change a criterion's status. They need a live Dragonfly, which the repository tests do not start or stop.

1. Stop the live Dragonfly while brief and recall run. Confirm the answers are authoritative, and `/healthz` reports the cache as degraded. The tests use an unreachable port and an in-memory fake, not a live server that goes down with real breaker timing.
2. With `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` and `SUBSTRATE_BUDGETS=enforce`, confirm an open live breaker answers 503 with an integer `Retry-After`. Whether to set this is an operator decision.
3. Confirm the `substrate.admission.decisions` series with `decision="refused"` reaches the live metrics pipeline.

## Planning records

`ROADMAP.md` (phase 75, "Plans: none written") and `STATE.md` are not edited here. The orchestrator updates them after this record is returned.
