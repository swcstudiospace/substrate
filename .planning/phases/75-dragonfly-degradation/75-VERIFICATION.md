---
phase: 75-dragonfly-degradation
verified: 2026-11-03T16:05:00Z
status: human_needed
score: 5/6 truths verified (2/2 ROADMAP success criteria verified as declared; 1 truth behavior-unverified)
covered_files: ["packages/mcp-server/src/admission.test.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/cache-breaker.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/http.admission.test.ts", "packages/mcp-server/src/live-session-consumer.test-support.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/observability/src/instruments.ts", "packages/observability/src/slo.test.ts", "packages/observability/src/slo.ts"]
covered_digest: "v3:sha256:968ed9d3a06d2bebd89579c83b185b0b3e9e47adf55c2315949d161c00daa260"
behavior_unverified: 1
overrides_applied: 0
overrides: []
behavior_unverified_items:
  - truth: 'Degraded brief with the cache breaker open and the live source failing: the refused snapshot read leaves the brief in state degraded, no stale snapshot is served, and the brief does not throw'
    test: 'Open the cache breaker (failureThreshold 1 via PlaneRegistry, as cache-breaker.test.ts openCache does), make the brief live source throw (getGraph), call briefDetailed for the same repo and graph'
    expected: 'state is degraded; no brief-snapshot text is served; the cache answers nothing; the brief does not throw'
    why_human: 'No test combines an open cache breaker with a failing live source. cache-breaker.test.ts:77 has a succeeding getGraph; brief-fast-path.test.ts:374 has a down cache with no breaker object; service-forget.test.ts:303 opens the Hindsight breaker on the forget path. The refused and failing paths share the same catch branches (cache.ts:586-588, 931-933), so the residual is a missing test, not a different branch'
coincidental_reliance_items: []
human_verification:
  - test: 'H-1: Open the cache breaker with PlaneRegistry (failureThreshold 1), make the brief live source throw (getGraph), call briefDetailed for the same repo and graph. Extend the case to a brief with SUBSTRATE_BRIEF_RECALL enforced (recall-snapshot leg, service.ts:2810), which no phase-75 test exercises (see D6)'
    expected: 'state is degraded; no brief-snapshot text is served; the cache answers nothing; the brief does not throw'
    why_human: 'The test gap is real: no test on this tree combines an open breaker with a failing source. Owner-held test gap, kept open (STATE.md phase 75 rows "H-1" and "Live Dragonfly runs")'
  - test: 'H-2: With the full stack running and default flags (nothing set), stop the live Dragonfly, then call POST /brief and POST /memory/recall'
    expected: 'Both answer 200 with authoritative source content; each returns within the command timeout (no hang); cache health reports degraded'
    why_human: 'In-process tests inject an open breaker or use an unreachable port (cache-breaker.test.ts:17). A real outage with real sockets, real timeouts and a real breaker transition is not observed. Operator live proof, kept open'
  - test: 'H-3: Set SUBSTRATE_BUDGETS=enforce and SUBSTRATE_BUDGET_READ_BREAKER=fail-closed. Stop the live Dragonfly, drive enough connect failures to open the breaker, then call POST /brief'
    expected: 'HTTP 503, body {"error":"cache_unavailable","class":"read","retry_after_s":N}, Retry-After equal to N as an integer, and one substrate.admission.decisions{decision="refused"} increment. Requests in the first 5 s of each open cycle are admitted as bypass (open decision O2)'
    why_human: 'http.admission.test.ts:274-287 injects a breaker-open outcome into a fake redis. The real breaker opening and closing under a live Dragonfly is not observed. Operator live proof, kept open'
  - test: 'H-4: (a) Check /metrics, the OTel/Greptime export and any dashboard for substrate.admission.decisions{decision="refused"}; (b) operator confirms the fail-closed read policy (open decision O1)'
    expected: '(a) the refused series exists with surface and class labels and is outside the admission.limited_rate numerator (slo.ts:360); (b) the operator accepts that with SUBSTRATE_BUDGET_READ_BREAKER=fail-closed and the breaker open, /brief and /memory/recall answer 503 before the authoritative source is consulted'
    why_human: 'Delivery to live exporters and dashboards is not in code (operator live proof). The read-policy consequence is a declared decision (CONTEXT D75-2) that a human must accept: owner item O1, kept open'
  - test: 'H-5: Decide the connect-cooldown window for fail-closed classes (open decision O2, the phase 75 cooldown; owner decision kept NOT FIXED)'
    expected: 'Either accept that a fail-closed class admits as bypass during the 5 s connect cooldown (CACHE_CONNECT_COOLDOWN_MS, cache.ts:250), including the first 5 s of each open cycle that a connect failure starts, or direct a change'
    why_human: 'The behaviour is a judgment about the declared rule (CONTEXT line 23: a connect error stays bypass in every class), not a defect a grep or a targeted test can settle. Owner item O2, kept open'
---

# Phase 75: DragonflyDB degradation Verification Report

**Phase Goal:** When the cache plane is open or unreachable, reads fall back to the authoritative store without losing state, and admission behaves as declared.
**Verified:** 2026-11-03T16:05:00Z
**Status:** human_needed
**Re-verification:** No. Fresh pass at HEAD `4b84e50c`. The prior record in this worktree (HEAD `8a604455`, covered digest `v3:sha256:9d61bf13...`) carried no `gaps:` block, so Step 0 routes to initial mode. The file is overwritten in the worktree only.

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `4b84e50c`. Covered-file changes are the only working-tree edits present in the phase-75 directory (the orchestrator's other `*-VERIFICATION.md` edits are not in this phase's scope).
- Must-haves: the two ROADMAP phase 75 success criteria (`.planning/ROADMAP.md:1298-1312`), verbatim and unchanged since `8a604455` (`git diff --stat 8a604455 4b84e50c -- .planning` is empty):
  1. With the cache breaker open, brief and recall return authoritative results. A test proves it.
  2. Admission under an open breaker follows a declared policy per class (fail open or closed), set in flags.
- Requirement: HARD-R2 (`.planning/REQUIREMENTS.md:119`, text unchanged; mapped to phase 75 at `:137`, "Preliminary edits validated; not complete"). See Requirements Coverage.
- No PLAN.md and no SUMMARY.md exist for this phase. The phase directory holds `75-CONTEXT.md` and this file only. Steps 4 and 5 are manual Level 1-3 checks.
- Covered-file fingerprint: `node ~/.agents/gsd-core/bin/gsd-tools.cjs query verification.fingerprint .planning/phases/75-dragonfly-degradation <13 covered files>` run at `4b84e50c`. Output copied verbatim into the frontmatter. The digest differs from the `8a604455` record (`9d61bf13...`) only because `service.ts` changed.
- Full gates were not re-run (the owner of the gate is the orchestrator). No full suite, `tsc`, lint or formatters were run. No Postgres container was started; `SUBSTRATE_TEST_PG_URL` was unset for the one command. Exactly one targeted `bun test` command was run (see Behavioral Spot-Checks).

### Changes since the `8a604455` record

- `git diff --stat 8a604455 4b84e50c` over the 13 covered paths: only `packages/mcp-server/src/service.ts` changed, `4 insertions, 4 deletions`, no line shift. `cache.ts`, `admission.ts`, `server.ts`, `config.ts`, `flag-registry.ts`, `instruments.ts`, `slo.ts`, `live-session-consumer.test-support.ts` and all phase-75 test files are byte-identical in that range. `docs/config-reference.md`, `scripts/config-reference.ts` and `.env.example` are also unchanged in that range.
- The four `service.ts` hunks in commit `4b84e50c` (access/visibility comparisons reverted to exact `normalizeIdentifier`):
  - `:2501` brief `recallRepo`. Feeds `readRecall` and `recallBriefOptions` only. The brief `cache.getOrLoad` key (`args`, `:2560`) uses the raw `request.repo`, so the brief cache key is unchanged.
  - `:3647` `memoryRead` `callerRepo`.
  - `:3735` `recallMemories` passes `normalizeIdentifier(callerRepo)` to `recallUncounted`. This is the key `repo: callerRepo` at `:3788` of the recall `memory-search` cache entry.
  - `:4592` memory verify `reader.repo`. Not on a phase-75 path.
- Effect on phase 75: the recall cache key changes only for a repo string whose trailing high surrogate is dropped by `normalizeKey` (`event.ts:216-218`) and not by `normalizeIdentifier` (`event.ts:207-209`), after the 512-unit cap. Both the breaker-open and breaker-closed paths build the key the same way, so T2 is unaffected. No phase-75 assertion uses such a repo string.
- Non-covered files changed in the same commit (`memory-policy.ts`, `index-store.ts`, `memory-write.ts`, `session-context.ts`, `types.ts`, `packages/cli/src/capsule.ts`): they govern memory visibility and the index's `memoryForBrief` repo normalisation. They are outside the covered set and no phase-75 test uses a repo with a surrogate, so no phase-75 claim depends on them. `memory-policy.test.ts` gained 20 lines (the regression for the lone-surrogate repo); it is in the targeted run below and passes.
- The `4b84e50c` commit touches no `.planning` file, so the ROADMAP criteria, HARD-R2 text and the STATE owner rows (O1, O2, H-1, live runs) are as recorded at `8a604455`.

### Line anchors at HEAD `4b84e50c`

Anchors were re-read at `4b84e50c` (not copied from the prior record). The `service.ts` line count is unchanged by commit `4b84e50c`, so the `8a604455` anchors still hold for every `service.ts` line outside the four hunks above.

| Anchor | HEAD (`4b84e50c`) |
| --- | --- |
| Cache gate construction `gate: this.planes.gate("cache")` | `service.ts:1935` |
| Brief `cache.getOrLoad({ klass: "brief" ...})` | `service.ts:2573-2574` |
| Brief `args` (raw `request.repo`) | `service.ts:2559-2560` |
| Brief `store` predicate | `service.ts:2597` |
| Brief failure branch `if (failed.length === 0)` | `service.ts:2669` |
| Brief snapshot `peek("brief-snapshot")` | `service.ts:2678` |
| Brief `snapshotSurvivesForget` | `service.ts:2680` |
| Brief degraded branch (`state "degraded"`) | `service.ts:2681-2684` (`snapshot === null` at `:2681`, `servedBrief(... "degraded" ...)` at `:2682`) |
| Recall snapshot leg `getOrLoad({ klass: "recall-snapshot" })` (brief recall, recall off by default) | `service.ts:2810-2822` |
| `recallMemories` load and key | `service.ts:3777-3783` (load), `:3785-3786` (`getOrLoad`), `:3788` (`repo: callerRepo`) |
| `cacheScript` | `service.ts:8809-8811` |
| `cache.ts` `CACHE_CONNECT_COOLDOWN_MS` / connect cooldown start / cooldown gate / `callPlane` | `:250` / `:377-379` / `:408-410` / `:411` |
| `cache.ts` `getOrLoad` stale-generation bypass / catch | `:576-579` / `:586-588` |
| `cache.ts` `bump` / `peek` / `script` | `:852-862` / `:912-935` / `:1040-1054` (`breakerRetryAfterMs` at `:1052`) |
| `breaker.ts` `callPlane` refusal before `fn` | `:223-225` |
| `admission.ts` `ROUTE_CLASSES` / refused branch / bypass branch / `isRefusal` / `admitBatch` | `:173-178` / `:386-388` / `:390` / `:421` / `:434` |
| `config.ts` `loadAdmissionSettings` / breaker map / `breakerPolicyOf` / throw / `loadConfig` call | `:1874` / `:1907-1909` / `:1929-1934` / `:1933` / `:1262` |
| `server.ts` `sendBudgetRefusal` / REST admit / MCP batch admit | `:633-635` / `:978-981` / `:2758-2760` |
| `flag-registry.ts` `CLASS_BREAKER_NAMES` | `:189` |
| `slo.ts` numerator (`decision: "limited"`) | `:360` (file unchanged since `8a604455`) |

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| T1  | Must-have 1, brief: with the cache breaker open, brief returns the authoritative (index) result | ✓ VERIFIED | Brief reads go through `cache.getOrLoad({ klass: "brief", ..., load })` at `packages/mcp-server/src/service.ts:2573-2574`. Each cache command goes through `run()` (`cache.ts:406-419`), which checks the connect cooldown outside the gate and then calls `callPlane(gate, ...)` (`cache.ts:411`). `callPlane` refuses before `fn` when `breaker.allow()` is false (`packages/observability/src/breaker.ts:223-225`), so no socket is opened. The refused `readAll` falls into the catch at `cache.ts:586-588`, which calls `fail` and returns `request.load()`, the live compose. Test: `cache-breaker.test.ts:73` "brief is composed from the index on every call, and the cache never answers it" asserts the index value changes between two calls (`active` then `blocked`), `state.reads` is 2, `hits: 0`, `mode: "degraded"`, and the breaker holds exactly one failure (the setup's). Ran: pass. Scope note: the test runs with `SUBSTRATE_BRIEF_RECALL` at its default (`off`, `config.ts:836`); the brief's recall leg is not exercised (see D6). |
| T2  | Must-have 1, recall: with the cache breaker open, recall returns the authoritative (Hindsight) result | ✓ VERIFIED | `recallUncounted` (`service.ts:3762`) builds `load` (`recallMemories`, Hindsight) at `:3777-3783` and calls `cache.getOrLoad({ klass: "memory-search", ..., load })` at `:3785-3786`. A refused read takes the catch path (`cache.ts:586-588`) and returns the live Hindsight answer. Test: `cache-breaker.test.ts:98` "recall returns the same reply as a substrate with no cache at all" asserts `answered` equals `plain` (uncached), `plain.degraded` is false, 2 results, `hits: 0`. The test passes no `callerRepo`, so the `4b84e50c` normalizer change is not on its path. Ran: pass. |
| T3  | Generation keys: a bump the breaker refused keeps reads on the source after the breaker closes, until a bump lands (no state lost, no stale answer) | ✓ VERIFIED | `bump` adds the key to `staleGenerations` on failure (`cache.ts:860`) and clears it on success (`cache.ts:857`). `getOrLoad` bypasses a stale generation before any read (`cache.ts:576-579`). Test: `cache-breaker.test.ts:117` asserts the pre-write answer (`before`) is not served after the breaker closes (`after`), `hits: 0`, `mode: "degraded"`; after a later bump, `landed` is served and a subsequent read is a hit. Ran: pass. Residual R1 (cross-process) stays open. |
| T4  | Must-have 2, admission: under an open breaker the policy is declared per class; fail-open admits as bypass; fail-closed refuses in enforce; shadow admits as bypass | ✓ VERIFIED | `script()` returns `breakerRetryAfterMs` only for `BreakerOpenError` (`cache.ts:1052`). `Admission.admit` refuses only when the class is `fail-closed` AND mode is `enforce` (`packages/mcp-server/src/admission.ts:386-388`, decision `refused`); otherwise the `reply === null` branch records `bypass` (`admission.ts:389-390`), so shadow records `bypass` (`admission.test.ts:341`). Enforced at REST (`server.ts:978-981`, `isRefusal`) and for MCP batches (`server.ts:2758-2760`; `admitBatch` `admission.ts:434`). `sendBudgetRefusal` (`server.ts:633-635`) sends 503 for `refused` and 429 for `limited`, with `retry-after` = `retryAfterSeconds`, an integer `>= 1` (`admission.ts:160-162`). Tests: `cache-breaker.test.ts:145` (fail-closed refused, fail-open bypass, no breaker failure recorded for the refusals); `http.admission.test.ts:274-287` (fail-open 200 with `bypass`, fail-closed 503, `retry-after` `2`, body `{"error":"cache_unavailable","class":"read","retry_after_s":2}`). Ran: pass. |
| T5  | Must-have 2: the policy is declared per class in flags, defaults fail-open, and an invalid value refuses boot naming the variable | ✓ VERIFIED | `SUBSTRATE_BUDGET_<CLASS>_BREAKER` per `ADMISSION_CLASSES` (`config.ts:1907-1909`; classes `packages/observability/src/instruments.ts:170`). `breakerPolicyOf` (`config.ts:1929-1934`): blank is `fail-open`; anything but the two values throws `ConfigError` naming the variable (`:1933`; see D11 on the value echo). `loadAdmissionSettings` (`config.ts:1874`) is called from `loadConfig`'s return object (`config.ts:1262`), so an invalid value refuses boot (asserted by `admission.test.ts:372-378`: `loadAdmissionSettings({})` is all `fail-open`; an invalid value throws `ConfigError` naming `SUBSTRATE_BUDGET_WRITE_BREAKER`; `loadConfig` refuses too). Registry family `CLASS_BREAKER_NAMES` (`flag-registry.ts:189`, family `:218-230`). Generated docs rows (see D7). Ran: pass. |
| T6  | Degraded brief with the cache breaker open and the live source failing: state is degraded, no stale snapshot served, the brief does not throw | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Presence and wiring: the failure branch (`if (failed.length === 0)` at `service.ts:2669`) falls through to the snapshot peek (`:2678`) and `snapshotSurvivesForget` (`:2680`) only when a live source failed. Under an open breaker `peek` is refused, caught and returns null (`cache.ts:912-935`, catch `:931-933`), so `found` is null, `snapshot === null`, and the brief takes the degraded branch (`service.ts:2681-2684`, `state: "degraded"`). The live path's `getOrLoad` also takes its catch (`cache.ts:586-588`) and its `store` predicate (`service.ts:2597`) keeps the degraded answer out of the cache. No test combines an open cache breaker with a failing live source (see D6). Route to H-1. |

**Score rule:** 5 of 6 truths VERIFIED. T6 is excluded from `verified_truths` and reported as `behavior_unverified: 1`. Both ROADMAP success criteria are VERIFIED as declared (criterion 1 = T1 and T2; criterion 2 = T4 and T5).

**Must-have caveats (not failures):**
- Criterion 1 holds under the default read policy (fail-open). Under an operator-set `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` in `enforce`, `/brief` and `/memory/recall` are refused with 503 before the source is consulted (`admission.ts:173-178` `ROUTE_CLASSES` `read`, `admission.ts:386-388`; `server.ts:978-981`). That is the declared D75-2 policy, recorded as open decision O1. It is not a defect, but it means criterion 1 as written does not hold for an operator who sets the read class to fail-closed. The operator must accept or reject that.
- Criterion 2 holds as declared (CONTEXT line 23: a connect error stays `bypass` in every class). The connect-cooldown window in which a fail-closed class admits as `bypass` is open decision O2 (owner decision, NOT FIXED). See D2. Read adversarially: if the owner reads "under an open breaker" to cover the cooldown window, criterion 2 fails and the status becomes `gaps_found`. That reading is the O2 decision and is not made here.

### Required Artifacts (manual Levels 1-3; no PLAN artifacts list)

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/cache.ts` | Breaker-aware read-through; refused generation bumps; script outcome carries the breaker wait | ✓ VERIFIED | Exists; byte-identical since `8a604455`. Substantive: `bunRedis` connect cooldown `:377-379`, cooldown gate `:408-410`, `callPlane` `:411`, `getOrLoad` stale-generation bypass `:576-579`, `bump` `:852-862`, `peek` `:912`, `script` `:1040-1052`, `CACHE_CONNECT_COOLDOWN_MS` `:250`. Wired: `service.ts:1935` `gate: this.planes.gate("cache")`; `service.ts:8809` `cacheScript`. |
| `packages/mcp-server/src/admission.ts` | Per-class decision with `refused` | ✓ VERIFIED | Byte-identical since `8a604455`. `ROUTE_CLASSES` `:173-178`; refused branch `:386-388`; bypass branch `:390`; `isRefusal` `:421`; `admitBatch` `:434`; `budgetBody` `:454`. Wired at `server.ts:978-981`, `:2758-2760`. |
| `packages/mcp-server/src/config.ts` | Parse and refuse boot | ✓ VERIFIED | `loadAdmissionSettings` `:1874`; breaker map `:1907-1909`; `breakerPolicyOf` `:1929-1934`; wired `loadConfig:1262`. Byte-identical since `97defd59`. |
| `packages/mcp-server/src/flag-registry.ts` | Registry family | ✓ VERIFIED | `CLASS_BREAKER_NAMES` `:189`; family `:218-230`. Byte-identical since `97defd59`. |
| `packages/mcp-server/src/server.ts` | 503 with integer Retry-After | ✓ VERIFIED | Byte-identical since `8a604455`. `sendBudgetRefusal` `:633-635`; REST call `:978-981`; MCP batch `:2758-2760`. |
| `packages/mcp-server/src/service.ts` | Brief degrades to source; snapshot refused under open breaker degrades cleanly | ✓ VERIFIED | Brief `getOrLoad` `:2573-2574`; snapshot peek `:2678`; degraded `:2682`; recall `getOrLoad` `:3785-3786`; gate `:1935`; `cacheScript` `:8809`. The `4b84e50c` hunks are the four `normalizeIdentifier` swaps listed above; none is on a phase-75 body and none changes a line count. |
| `packages/observability/src/instruments.ts` | `refused` decision label | ✓ VERIFIED | Byte-identical since `8a604455`. `ADMISSION_CLASSES` `:170`; `ADMISSION_DECISIONS` includes `refused` `:179`; `recordAdmission` `:585`. |
| `packages/observability/src/slo.ts` | SLO numerator excludes refused | ✓ VERIFIED | Byte-identical since `8a604455`. Numerator `where: { decision: "limited" }` at `:360`; denominator comment `:366-369` excludes `bypass` and `refused`. |
| `packages/mcp-server/src/cache-breaker.test.ts` | New phase test file | ✓ VERIFIED | Byte-identical since `8a604455`. Tests at `:73`, `:98`, `:117`, `:145`. Ran: pass. |
| `admission.test.ts`, `http.admission.test.ts`, `observability/src/slo.test.ts` | Policy, flag and HTTP tests | ✓ VERIFIED | Byte-identical since `8a604455`. Ran in the targeted command: pass. |

### Key Link Verification (manual; no PLAN key_links)

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` brief | `cache.ts` getOrLoad | `klass: "brief"` at `service.ts:2574` | ✓ WIRED | Refused read falls to `request.load()` (`cache.ts:586-588`) |
| `service.ts` recall | `cache.ts` getOrLoad | `klass: "memory-search"` at `service.ts:3786` | ✓ WIRED | Load is Hindsight recall (`service.ts:3777-3783`) |
| `service.ts` brief recall leg | `cache.ts` getOrLoad | `klass: "recall-snapshot"` at `service.ts:2810` | ✓ WIRED (structural) | Refused read falls to `fanOut()` (`service.ts:2818-2821`, `:2823-2828`). Not exercised under an open breaker by any test (see D6) |
| `server.ts` REST | `admission.ts` admit | `isRefusal` then `sendBudgetRefusal` at `server.ts:978-981` | ✓ WIRED | 503 for `refused`, 429 for `limited` (`server.ts:633-635`) |
| `admission.ts` | `cache.ts` script | Admission script → `substrate.cacheScript` (`server.ts:831-834`) → `this.cache.script` (`service.ts:8810`) → `breakerRetryAfterMs` (`cache.ts:1052`) | ✓ WIRED | Gated service cache at `service.ts:1935` |
| `cache.ts` script | `cache.ts` run | `script` → `attempt` → `redis.eval` → `run` (`cache.ts:406-419`) | ✓ WIRED | A connect-cooldown refusal is a plain `Error` (D2) |
| `observe.ts` / `server.ts` | `instruments.ts` | `observer.admission` → `recordAdmission` (`instruments.ts:585`) | ✓ WIRED | Decision label passed through unfiltered |
| `config.ts` loadConfig | `breakerPolicy` | `loadAdmissionSettings(env)` at `config.ts:1262` | ✓ WIRED | `ConfigError` aborts boot (`admission.test.ts:372-378`) |

### Data-Flow Trace (Level 4)

Not applicable to rendered UI. The brief and recall answers come from the index (the brief's live compose) and Hindsight (`recallUncounted`). `cache-breaker.test.ts:73-96` shows the index value reaching the reply; `:98-115` shows the recall reply equal to the uncached one.

### Behavioral Spot-Checks (Step 7b)

One targeted `bun test` command was run, from the worktree, with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs` and `--timeout 30000`. It is the prior record's six files plus `memory-policy.test.ts`, which carries the `4b84e50c` regression.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Brief from index with breaker open (T1), recall equals uncached reply (T2), generation keys (T3), admission over the real gated cache (T4), admission policy matrix and flag parsing incl. invalid value refusing boot (T4, T5), HTTP 503 and bypass (T4), SLO refused excluded, connect cooldown and refusal reporting (D2), no-breaker degraded brief (T6 nearest evidence), lone-surrogate repo regression (`memory-policy.test.ts`) | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/cache-breaker.test.ts packages/mcp-server/src/admission.test.ts packages/mcp-server/src/http.admission.test.ts packages/observability/src/slo.test.ts packages/mcp-server/src/cache.test.ts packages/mcp-server/src/brief-fast-path.test.ts packages/mcp-server/src/memory-policy.test.ts` | 417 pass, 0 fail, 4628 expect() calls across 7 files (2.42 s). The `8a604455` run over the six files without `memory-policy.test.ts` was 375 pass, 0 fail; the difference is consistent with that one added file `[INFERENCE]`, since the per-file count was not taken. Stderr lines are the tests' own logged output (`[substrate] ...`), not failures | ✓ PASS (T1 to T5 re-confirmed) |
| Degraded brief with breaker open and live source failing (T6) | none (no such test exists; checked by reading `cache-breaker.test.ts`, `brief-fast-path.test.ts`, `brief-recall.test.ts`, `recall-snapshot.test.ts`, `service-forget.test.ts`, `service.test.ts`, see D6) | not run | ? SKIP → H-1 |
| `bun scripts/config-reference.ts --check` (generator check) | not re-run at `4b84e50c`: a second `bun` command, outside the one-command budget. Its inputs (`flag-registry.ts`, `config.ts`, `docs/config-reference.md`, `scripts/config-reference.ts`) are unchanged in `97defd59..4b84e50c`, and it passed at `97defd59` (D7) | carried | carried from `97defd59` |
| Live Dragonfly stop, real 503, real recovery | requires a running server and Dragonfly | not run | ? SKIP → H-2, H-3, H-4(a) |

Probe execution (Step 7c): SKIPPED. Not a migration or tooling phase; no PLAN, SUMMARY or success criterion mentions probes.

### Requirements Coverage

No PLAN exists, so there is no plan `requirements:` field. The ROADMAP Phase 75 section declares no requirement IDs.

- **HARD-R2** (`.planning/REQUIREMENTS.md:119`; text unchanged; still `[ ]`): "Reuse the existing cache-plane circuit breaker and bounded timeouts. On outage, private authority remains durable; reads fall back to the documented source or report degradation. Reject writes that cannot be made durable with retryable errors. No authoritative state exists only in the cache or an in-memory fallback." `REQUIREMENTS.md:137` maps it to phase 75 with "Preliminary edits validated; not complete" (left as the owner wrote it).
  - Read-fallback and degradation clauses: evidenced by T1, T2, T3 and T6 (T6 behavior-unverified).
  - Reuse of the cache-plane breaker and bounded timeouts: evidenced by `cache.ts:335-411`, `breaker.ts:223-225`, `cache.ts:377-379`.
  - "Reject writes that cannot be made durable with retryable errors": not a phase-75 success criterion and not evaluated as one. The only retryable write refusal in this phase is the `refused` 503 with `Retry-After` for a fail-closed class (`server.ts:633-635`), which is a cache-plane outage refusal, not a durability check.
  - Status: **ORPHANED** under Step 6c. HARD-R2 is mapped to phase 75 in REQUIREMENTS.md but no PLAN declares it, because the phase has no PLAN (D1). Recorded for the orchestrator; it adds no gap to Step 9, which uses the two ROADMAP criteria as must-haves.

### Anti-Patterns Found

Scan of the 13 covered files at `4b84e50c` for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER|.skip(|.only(|not yet implemented`: no matches. The four changed `service.ts` lines add none. No debt-marker gate applies.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/cache.ts` | 377-379, 408-409 | Connect-cooldown refusal rejects with a plain `Error` before `callPlane`, so it is not a `BreakerOpenError` even when the breaker is open (see D2) | ⚠️ Warning | A fail-closed class admits as bypass during the cooldown (O2) |
| `packages/mcp-server/src/cache.ts` | 502, 857-860 | `staleGenerations` is an in-process `Set` (see R1) | ℹ️ Info | Residual, documented in CONTEXT R1 |
| `packages/mcp-server/src/config.ts` | 1933 | `ConfigError` echoes the rejected value (`JSON.stringify(raw)`) along with the variable name | ℹ️ Info | Not a must-have failure (CONTEXT D75-2a asks for the variable name). The value is a policy word, not a secret (D11) |
| `packages/mcp-server/src/cache.test.ts` | 1630 | Waiter-deadline bound relaxed from 500 ms to 2 s in commit `4600d2a2` (outside covered set; not re-run in isolation beyond the targeted command, which passes) | ℹ️ Info | A slow finite wait is detected less tightly; the no-hang property the test names is unaffected |

### Decision Coverage

Not evaluated: the phase directory holds no PLAN or SUMMARY, so `check.decision-coverage-verify` has no decisions to check. Recorded as not evaluated, not as zero decisions. Status impact: none. The CONTEXT decisions D75-1 to D75-4 are judged against the code in the truths above: D75-1 (defaults unchanged) by T1, T2, `admission.test.ts`; D75-2 and D75-2a by T4, T5; D75-3 by T1, T2; D75-4 by T3.

### Human Verification Required

H-1 is the behavior-unverified truth (T6, owner-held test gap). H-2 to H-4(a) are live-only operator proofs. H-4(b) is open decision O1. H-5 is open decision O2. All are kept open. Nothing in this verification closes them.

**H-1. Degraded brief with the breaker open and the live source failing (T6)**
**Test:** Open the cache breaker (`PlaneRegistry` with `failureThreshold: 1`, as `cache-breaker.test.ts` `openCache` does). Make the live source throw (`getGraph`). Call `briefDetailed` for the same repo and graph. Extend to a brief with `SUBSTRATE_BRIEF_RECALL` enforced, so the recall-snapshot leg is on the path (D6).
**Expected:** `state` is `degraded`; no `brief-snapshot` text is served; the cache answers nothing; the brief does not throw.
**Why human:** No test combines an open cache breaker with a failing source. The refused and failing paths run the same catch branches, so this is a test gap rather than a different code path, but the gap is real and no test on this tree closes it. Kept open (owner-held test gap; STATE.md phase 75 rows "H-1" and "Live Dragonfly runs").

**H-2. Live stop of Dragonfly while brief and recall run**
**Test:** Full stack up, default flags (nothing set). Stop the live Dragonfly. Call `POST /brief` and `POST /memory/recall`.
**Expected:** 200 with authoritative source content; each returns within the command timeout (no hang); cache health reports degraded.
**Why human:** In-process tests use an unreachable port (`cache-breaker.test.ts:17`) or an injected open breaker. A real outage with real sockets, timeouts and a breaker transition is not observed. Operator live proof, kept open.

**H-3. Live fail-closed 503 with Retry-After**
**Test:** `SUBSTRATE_BUDGETS=enforce`, `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed`. Stop Dragonfly and drive connect failures until the breaker opens. Call `POST /brief`.
**Expected:** HTTP 503, body `{"error":"cache_unavailable","class":"read","retry_after_s":N}`, `Retry-After: N` as an integer, and one `substrate.admission.decisions{decision="refused"}` increment. Requests in the first 5 s of each open cycle are admitted as bypass (O2).
**Why human:** `http.admission.test.ts:274-287` injects a breaker-open outcome into a fake redis; the real breaker transition is not observed. Operator live proof, kept open.

**H-4. Refused-decision metric in the real pipeline; operator acceptance of the fail-closed read policy**
**Test:** (a) Check `/metrics`, the OTel/Greptime export and any dashboard for `substrate.admission.decisions{decision="refused"}`. Confirm it is outside `admission.limited_rate` (`slo.ts:360`, R3). (b) Confirm the operator accepts that with `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` and the breaker open, `/brief` and `/memory/recall` answer 503 and do not reach the authoritative source (O1).
**Expected:** (a) the series exists with surface and class labels; (b) the operator confirms this is the intended policy.
**Why human:** Delivery to live exporters and dashboards is not in code (operator live proof). The read-policy consequence is a declared decision (D75-2) that a human must accept. O1 stays open.

**H-5. Cooldown window for fail-closed classes (O2)**
**Test:** Decide whether a fail-closed class may admit as bypass during the 5 s connect cooldown (`CACHE_CONNECT_COOLDOWN_MS`, `cache.ts:250`), both while the breaker is closed and while it is open after a connect-failure trip or half-open probe.
**Expected:** Accept the window under the CONTEXT rule "a connect error stays bypass in every class", or direct a change. The owner has recorded this as NOT FIXED (`STATE.md`, the phase 75 owner row). Nothing in this verification changes that.
**Why human:** A judgment about the declared rule, not a defect that a grep or a targeted test can settle.

### Open Decisions (kept open; not upgraded)

- **O1. Fail-closed read policy (D75-2).** Under `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` in `enforce`, `/brief` and `/memory/recall` are refused (503) before the authoritative source is consulted. Criterion 1 therefore holds under the default read policy, not under a fail-closed read policy. Open for the operator (H-4b).
- **O2. The 75 connect cooldown (owner decision, NOT FIXED).** See D2. Kept open (H-5, H-3). This is the only owner-held cooldown item for phase 75.
- **R1. Cross-process staleness after a refused bump (predates this phase).** `staleGenerations` lives in one process (`cache.ts:857-860`). After a restart, or on another replica, a generation key can hold its old value, and a cached brief written before the write can be served until its TTL (`CACHE_TTL["brief"]`, 5 minutes). Follow-up, not in scope here.
- **R3. `refused` is outside the admission SLO numerator (`slo.ts:360`, `:366-369`).** A cache outage is the breaker's signal, not a budget breach. Accepted by design; restated.
- **Operator items (phase 75):** the live proofs H-2, H-3 and H-4(a), and the H-1 degraded-brief test (owner/operator rows in STATE.md). Not closed by any code or test on this tree.

### Deviations and Gaps

**D1. No PLAN and no SUMMARY (deviation, recorded).** `75-CONTEXT.md` is the only phase artifact. With no PLAN, the must-haves are the two ROADMAP criteria, and Steps 4 and 5 are manual checks. This leaves HARD-R2 unclaimed (see Requirements Coverage).

**D2. Cooldown refusals are plain `Error`, and the window can occur with the breaker open (warning, unchanged in code; O2 open).**
- `run()` checks `cooldownUntil` before `callPlane` (`packages/mcp-server/src/cache.ts:408-410`). A refusal in the window is `Error("cache connect cooling down ...")` (`cache.ts:409`), not `BreakerOpenError`, whether or not the breaker is open.
- The cooldown starts on a failed connect (`cache.ts:377-379`) inside `open()`, which is called from the gated `fn` in `run()` (`cache.ts:411-412`), so the connect failure is charged to the breaker like any command. A connect failure that trips the breaker (or fails a half-open probe) leaves the breaker open and the cooldown active for `CACHE_CONNECT_COOLDOWN_MS` = 5 s (`cache.ts:250`), within the open window (`SUBSTRATE_BREAKER_OPEN_MS`, `breaker.ts`).
- `script()` maps it to `{ ok: false }` without `breakerRetryAfterMs` (`cache.ts:1052`), so `admission.ts:386` does not refuse and `admission.ts:390` records `bypass`, even in `enforce` with a fail-closed class. `attempt()` passes the cause through unchanged (`cache.ts:1151-1160`), so the `instanceof BreakerOpenError` test sees the plain error.
- Consequence in a sustained connect-refused outage: fail-closed classes admit roughly the first 5 s of each open cycle and refuse the rest. This is code-derived, re-read at `4b84e50c`, and not executed. No test asserts the window: `cache.test.ts:1276-1279` advances past the cooldown (`now += 100`) before it asserts `BreakerOpenError`.
- Classification: not a must-have failure as declared, because CONTEXT line 23 says a connect error stays `bypass` in every class and the cooldown refusal is a connect-cooldown refusal, not a breaker refusal. Whether that reading is right for a fail-closed class during the window is the owner's O2 decision. It stays NOT FIXED and is not decided here.

**D3. The refused-generation-bump residual R1 is in-process only.** `staleGenerations` (`cache.ts:857-860`) is added on a failed bump, cleared on a successful one, and checked before a read (`cache.ts:576-579`). See R1.

**D4. Fail-closed read policy (O1).** See O1 and H-4(b).

**D5. CONTEXT is stale in four places (documentation drift, not a code defect; unchanged at `4b84e50c`).** CONTEXT line 23 says a fail-closed refusal in `shadow` "records `shadow_limited`". The code records `bypass` (`admission.ts:386-390`; `admission.test.ts:341`; `docs/config-reference.md:279`). CONTEXT line 40 repeats the stale `shadow_limited` test description. CONTEXT lines 12 and 35 cite `config.ts:1849`, now `config.ts:1874` (`loadAdmissionSettings`) and `:1929` (`breakerPolicyOf`). CONTEXT line 47 cites `slo.ts:359`, now `slo.ts:360`. CONTEXT should be corrected by its owner. This verification did not edit it.

**D6. Degraded brief path has no test with the breaker open, and the brief's recall leg is also untested under an open breaker (warning).** See T6 and H-1.
- Checked at `4b84e50c`: the test files that name a breaker and a brief or recall path are `cache-breaker.test.ts` (its `getGraph` at `:77` succeeds; brief recall off by default), `cache.test.ts` (breaker tests at `:1276-1279`, `:1376-1379`; no brief), `service-forget.test.ts:303` (Hindsight breaker on the forget path, not the cache breaker), `brief-recall.test.ts:800-812` (Hindsight prefetch breaker, not the cache breaker) and `docs-search.test.ts` (RAGFlow). The degraded-brief test `brief-fast-path.test.ts:374` has no breaker object (its cache is a `FakeRedis` with `fail = true`, `substrateWith` at `:223-226`).
- New at this record: with `SUBSTRATE_BRIEF_RECALL` enforced, the brief's recall fan-out is a `getOrLoad` (`recall-snapshot`, `service.ts:2810-2822`). A refused read falls through to `fanOut()` by the same catch (`cache.ts:586-588`), so the code is structurally the same, but no test runs a brief with recall on under an open breaker. H-1 is extended to cover it.
- The `4b84e50c` `service.ts` hunks add no breaker or brief-degraded case, so the gap is unchanged.

**D7. Docs generation.** `docs/config-reference.md` is generated by `scripts/config-reference.ts` (`bun run config:reference`) from `flag-registry.ts`, and `scripts/config-reference.test.ts` runs its `--check` on the committed tree. The `97defd59` check printed `config reference: up to date` and exited 0. Its inputs are unchanged in `97defd59..4b84e50c` (`git diff --stat` empty for `docs/config-reference.md`, `scripts/config-reference.ts`, `flag-registry.ts`, `config.ts`), so the result is carried, not re-run here (see Behavioral Spot-Checks). The rows at `docs/config-reference.md:279` and `:493` are generated, not hand-rendered. CONTEXT's "hand-rendered" note is stale.

**D8. `.env.example` and docs are excluded from the fingerprint (judgment call, same as the prior record).** They are configuration and documentation, not code.

**D9. Stale status lines (documentation drift).** `.planning/ROADMAP.md:1298-1312` status reads `human_needed: 5 of 6 truths; 2 of 2 criteria as declared; O1 and O2 open; H-1 test gap; operator items H-2 to H-4`, consistent with this record. The ROADMAP progress-table row (`ROADMAP.md:145`) and the STATE owner rows are not part of this verdict and were not edited.

**D10. Phase 72/73 changes to shared files do not touch phase-75 paths (recorded, no finding).** `service.ts` at `4b84e50c` carries the phase 73 surrogate and key-normalisation changes from `8a604455` and `4b84e50c`'s access-comparison revert. The brief, recall, snapshot, gate and live-session bodies are unchanged in substance. `config.ts` carries phase 72's `RepoScopesRequiredError` with no effect on admission parsing.

**D11. The invalid-value `ConfigError` echoes the value (info).** `config.ts:1933` builds the message as `` `${name}=${JSON.stringify(raw)} is not fail-open or fail-closed; ...` ``, so the rejected value is echoed. The test at `admission.test.ts:372-378` asserts the variable name only. CONTEXT D75-2a requires naming the variable, which holds. Not a must-have failure. Whether the echo is wanted is a judgment, not decided here.

**D12. Prior record correction carried forward (info).** The `97defd59` record stated that `flag-registry.ts` and `config.ts` changed after `c7788f9d`; they changed before `97defd59` (phase 72 description strings and `RepoScopesRequiredError`). The phase-75 family and admission parsing are unaffected, and both files are byte-identical from `97defd59` to `4b84e50c`.

### Gaps Summary

No FAILED truth, no MISSING or STUB artifact, no NOT_WIRED link, no blocker anti-pattern. No `gaps:` block is emitted. Warnings: D2 (cooldown, O2, owner-held), D6 (H-1 test gap, now including the brief recall leg), the HARD-R2 orphan note, and the D11 info note. Status is `human_needed` by Step 9 rule 2: human items exist (H-1 to H-5), and T6 is a present-but-behavior-unverified truth. `passed` is not valid. Step 9b deferral is not needed: there are no gaps to defer.

Changes since the `8a604455` record: the covered digest changed (`9d61bf13...` to `968ed9d3...`) only because of the `4b84e50c` edits to `service.ts`, which touch no phase-75 control-flow body (four `normalizeKey`→`normalizeIdentifier` swaps on repo keys in the brief recall leg, `memoryRead`, `recallMemories` and memory verify). The targeted run (417 pass, 0 fail, 7 files) re-confirms T1 to T5. T6 and H-1 are unchanged apart from the D6 scope note. O1, O2 and the operator items (H-2, H-3, H-4(a), and the H-1 test) stay open.

---

_Verified: 2026-11-03T16:05:00Z_
_Verifier: Claude (gsd-verifier)_
