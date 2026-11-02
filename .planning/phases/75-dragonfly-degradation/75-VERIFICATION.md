---
phase: 75-dragonfly-degradation
verified: 2026-11-02T18:28:00Z
status: human_needed
score: 5/6 truths verified (2/2 ROADMAP success criteria verified as declared; 1 truth behavior-unverified)
covered_files: ["packages/mcp-server/src/admission.test.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/cache-breaker.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/http.admission.test.ts", "packages/mcp-server/src/live-session-consumer.test-support.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/observability/src/instruments.ts", "packages/observability/src/slo.test.ts", "packages/observability/src/slo.ts"]
covered_digest: "v3:sha256:00de08d89c0263a33bbffb94823c8cbf317610d1c6a3d189a0c0a6c05dce313e"
behavior_unverified: 1
overrides_applied: 0
behavior_unverified_items:
  - truth: "Degraded brief with the cache breaker open and the live source failing: the refused snapshot read leaves the brief in state degraded, no stale snapshot is served, and the brief does not throw"
    test: "Open the cache breaker (failureThreshold 1 via PlaneRegistry, as cache-breaker.test.ts openCache does), make the brief's live source throw (getGraph), call briefDetailed for the same repo and graph"
    expected: "state is degraded; no brief-snapshot text is served; the cache answers nothing; the brief does not throw"
    why_human: "No test combines an open breaker with a failing live source. cache-breaker.test.ts:73 has a succeeding getGraph; brief-fast-path.test.ts:374 has a down cache with no breaker object. The refused and failing paths share the same catch branches (cache.ts:586-589, 609-612, 931-934), so the residual is a missing test, not a different branch"
coincidental_reliance_items: []
human_verification:
  - test: "H-1: Open the cache breaker with PlaneRegistry (failureThreshold 1), make the brief's live source throw (getGraph), call briefDetailed for the same repo and graph"
    expected: "state is degraded; no brief-snapshot text is served; the cache answers nothing; the brief does not throw"
    why_human: "The test gap is real: no test on this tree combines an open breaker with a failing source. Owner-held test gap, kept open"
  - test: "H-2: With the full stack running and default flags (nothing set), stop the live Dragonfly, then call POST /brief and POST /memory/recall"
    expected: "Both answer 200 with authoritative source content; each returns within the command timeout (no hang); cache health reports degraded"
    why_human: "In-process tests inject an open breaker or use an unreachable port (cache-breaker.test.ts:17). A real outage with real sockets, real timeouts and a real breaker transition is not observed"
  - test: "H-3: Set SUBSTRATE_BUDGETS=enforce and SUBSTRATE_BUDGET_READ_BREAKER=fail-closed. Stop the live Dragonfly, drive enough connect failures to open the breaker, then call POST /brief"
    expected: "HTTP 503, body {\"error\":\"cache_unavailable\",\"class\":\"read\",\"retry_after_s\":N}, Retry-After equal to N as an integer, and one substrate.admission.decisions{decision=\"refused\"} increment. Requests in the first 5 s of each open cycle are admitted as bypass (open decision O2)"
    why_human: "http.admission.test.ts:274-287 injects a breaker-open outcome into a fake redis. The real breaker opening and closing under a live Dragonfly is not observed"
  - test: "H-4: (a) Check /metrics, the OTel/Greptime export and any dashboard for substrate.admission.decisions{decision=\"refused\"}; (b) operator confirms the fail-closed read policy (open decision O1)"
    expected: "(a) the refused series exists with surface and class labels and is outside the admission.limited_rate numerator (slo.ts:360); (b) the operator accepts that with SUBSTRATE_BUDGET_READ_BREAKER=fail-closed and the breaker open, /brief and /memory/recall answer 503 before the authoritative source is consulted"
    why_human: "Delivery to live exporters and dashboards is not in code. The read-policy consequence is a declared decision (CONTEXT D75-2) that a human must accept"
  - test: "H-5: Decide the connect-cooldown window for fail-closed classes (open decision O2, the phase 75 cooldown; owner decision kept NOT FIXED)"
    expected: "Either accept that a fail-closed class admits as bypass during the 5 s connect cooldown (CACHE_CONNECT_COOLDOWN_MS, cache.ts:250), including the first 5 s of each open cycle that a connect failure starts, or direct a change"
    why_human: "The behaviour is a judgment about the declared rule (CONTEXT line 23: a connect error stays bypass in every class), not a defect a grep or a targeted test can settle"
---

# Phase 75: DragonflyDB degradation Verification Report

**Phase Goal:** When the cache plane is open or unreachable, reads fall back to the authoritative store without losing state, and admission behaves as declared.
**Verified:** 2026-11-02T18:28:00Z
**Status:** human_needed
**Re-verification:** No. The prior 75-VERIFICATION.md (recorded at 749e97e3) had no `gaps:` block and was overwritten, as the brief directs. This is a fresh initial run on HEAD c7788f9d.

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `c7788f9d`. The brief named `996e8e4a` or later; `c7788f9d` descends from it (the assignment named `c7788f9d`).
- Criteria source: origin/main ROADMAP (`git -C /root/src/repos/agent-substrate show origin/main:.planning/ROADMAP.md`, origin/main at `b1b42f92`), the `### Phase 75` section. The two Success Criteria are word-for-word identical to this tree's ROADMAP section. The two lines that differ are not criteria: origin/main says `**Status**: Not started` and `**Plans**: none written`; this tree says `**Status**: human_needed (verified on gsd/v18-int-all 7382ad10; live items open)` and `**Plans**: none written (context in 75-CONTEXT.md).` Neither status line is used as a verdict: origin/main's is stale, and the tree's names 7382ad10, not c7788f9d.
- Brief correction applied: the phase-75 owner-held item is the cooldown (O2) only. W2 is not a phase 75 item. It is phase 73's adoption-path warning (STATE.md:778, "W2 adoption path NOT FIXED (owner decision)"). This record does not attribute W2 to phase 75 and keeps no W2 open here. The discrepancy noted in the prior record is resolved by this correction.
- Requirement: HARD-R2 (REQUIREMENTS.md:119, text identical at commit 23bd0733). REQUIREMENTS.md:137 maps it to phase 75 with the note "Preliminary edits validated; not complete". See Requirements Coverage.
- Must-haves: the two ROADMAP phase 75 success criteria, verbatim. No PLAN.md exists for this phase, so there are no PLAN frontmatter artifacts or key links. Steps 4 and 5 are manual Level 1-3 checks.
- Phase directory holds only `75-CONTEXT.md` and this file. No PLAN, no SUMMARY.
- Phase-75 code changes since the prior record (749e97e3): `c7788f9d` changed `service.ts` only in the Greptime live-event buffer path (`service.ts:2969-2981`, phase 76 G2/G3). That hunk shifts later lines in `service.ts` by +8, which is why the recall line numbers below differ from the prior record. It does not touch the brief, recall, cache-breaker or admission paths. `cache.ts`, `admission.ts`, `config.ts`, `flag-registry.ts`, `server.ts`, `instruments.ts`, `slo.ts` and the phase-75 test files are unchanged since 749e97e3.
- Covered files: the 13 files of the phase's code commits `63772d5e`, `b45ba5d1`, `c71d4409` and `634b6171` (`56c0c2c1` is docs only). Docs and `.env.example` are excluded from the fingerprint (D8). Fingerprint: `gsd_run query verification.fingerprint /root/src/worktrees/as-gsd-v18-all/.planning/phases/75-dragonfly-degradation <13 files>`, output copied verbatim above. The digest differs from the 749e97e3 record (`56ac85ad...`) because `service.ts` and `config.ts` changed for phases 73 and 76.
- Full gates were run by the orchestrator on this tree. Not re-run here. No full suite, tsc, lint or formatters were run. No Postgres container was started; `SUBSTRATE_TEST_PG_URL` was unset for every command.

### Integration facts judged from the code

- **634b6171 (lazy live-session facade).** `Substrate.liveSessions` is a memoised getter (`packages/mcp-server/src/service.ts:1660-1663`). The brief path reads the live-session authority only in `liveBriefSections` (`service.ts:3955-3957`), and only when `SUBSTRATE_BRIEF_SESSIONS` or the worktree registry is on. It does not touch the cache, so the live sections are independent of the breaker.
- **c7788f9d (phase 76 G1-G3).** Changes only the ledger buffer write path in `service.ts`. Not on any phase-75 path.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| T1  | Must-have 1, brief: with the cache breaker open, brief returns the authoritative (index) result | ✓ VERIFIED | Brief reads go through `cache.getOrLoad({ klass: "brief", ..., load })` at `packages/mcp-server/src/service.ts:2443-2444`. Every cache command goes through `run()` (`cache.ts:406-420`), which checks the connect cooldown (`cache.ts:408-410`) and then `callPlane(gate, ...)` (`cache.ts:411`). `callPlane` refuses before calling `fn` when `breaker.allow()` is false (`packages/observability/src/breaker.ts:223-225`), so no socket is opened. The refused `readAll` falls into the catch at `cache.ts:586-589`, which returns `request.load()`, the live compose. Test: `cache-breaker.test.ts:73` "brief is composed from the index on every call, and the cache never answers it" (asserts both answers come from the index, `hits: 0`, and the breaker records only the setup failure). Ran: test 1, pass. |
| T2  | Must-have 1, recall: with the cache breaker open, recall returns the authoritative (Hindsight) result | ✓ VERIFIED | `recallMemories` → `recallUncounted` (`service.ts:3630`) → `cache.getOrLoad({ klass: "memory-search", ..., load })` at `service.ts:3653-3654`, whose `load` is `recallMemories` (Hindsight) at `service.ts:3645-3651`. A refused read takes the same catch path (`cache.ts:586-589`). Test: `cache-breaker.test.ts:98` "recall returns the same reply as a substrate with no cache at all" (asserts `answered` toEqual `plain`, 2 results, `hits: 0`). Ran: test 1, pass. |
| T3  | Generation keys: a bump the breaker refused keeps reads on the source after the breaker closes, until a bump lands (no state lost, no stale answer) | ✓ VERIFIED | `bump` adds the key to `staleGenerations` on failure (`cache.ts:860`) and clears it on success (`cache.ts:857`). `getOrLoad` bypasses a stale generation before any read (`cache.ts:576-580`). Test: `cache-breaker.test.ts:117` (the pre-write answer under generation 0 is not served after the plane answers again; a later bump lands and the new value is served). Ran: test 1, pass. Residual R1 (cross-process) stays open. |
| T4  | Must-have 2, admission: under an open breaker the policy is declared per class; fail-open admits as bypass; fail-closed refuses in enforce; shadow admits as bypass | ✓ VERIFIED | `script()` returns `breakerRetryAfterMs` only for `BreakerOpenError` (`cache.ts:1052`). `Admission.admit` refuses only when the class is `fail-closed` AND mode is `enforce` (`admission.ts:386-388`, decision `refused`); otherwise a `bypass` (`admission.ts:389-390`), so shadow records `bypass`. Enforced at REST before the handler (`server.ts:976-981`) and for MCP batches (`server.ts:2758-2760`; `admitBatch` at `admission.ts:434`). Refusal response: `sendBudgetRefusal` sends 503 for `refused` and 429 for `limited`, with integer `Retry-After` and body `{error, class, retry_after_s}` (`server.ts:633-635`, `admission.ts:454-456`). Tests: `admission.test.ts:325` (default all fail-open, bypass), `:334` (fail-closed refused in enforce, others fail-open), `:341` (fail-closed bypass in shadow, refused in enforce); `http.admission.test.ts:274-287` (fail-open 200, fail-closed 503 with `retry-after: 2`, body, one `refused` decision); `cache-breaker.test.ts:145` (real gated cache). Ran: tests 1 and 2, all pass. |
| T5  | Must-have 2: the policy is declared per class in flags, defaults fail-open, and an invalid value refuses boot naming the variable | ✓ VERIFIED | `SUBSTRATE_BUDGET_<CLASS>_BREAKER` per `ADMISSION_CLASSES` (`packages/mcp-server/src/config.ts:1891-1896`; classes `instruments.ts:170`). `breakerPolicyOf` (`config.ts:1914-1919`): blank is `fail-open`; anything but the two values throws `ConfigError` naming the variable and not the value. `loadAdmissionSettings` is called in `loadConfig`'s return object (`config.ts:1247`), so an invalid value refuses boot. Registry family `CLASS_BREAKER_NAMES` (`packages/mcp-server/src/flag-registry.ts:189`) and the family (`flag-registry.ts:218-230`). Documented at `docs/config-reference.md:279` and `:493`, `.env.example:280-282`. Tests: `admission.test.ts:375` "an invalid SUBSTRATE_BUDGET_<CLASS>_BREAKER refuses boot and names the variable" (asserts `loadAdmissionSettings` and `loadConfig` throw `ConfigError`), and the defaults test at `:325`. Ran: test 2, pass. |
| T6  | Degraded brief with the cache breaker open and the live source failing: state is degraded, no stale snapshot served, the brief does not throw | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Presence and wiring: the snapshot peek (`service.ts:2548`) and `snapshotSurvivesForget` (`service.ts:2550`) run only on the failure branch (`if (failed.length === 0)` at `service.ts:2539`; success returns earlier). Under an open breaker `peek` is refused, caught and returns null (`cache.ts:931-934`), so `snapshot === null` and the brief takes the degraded branch (`service.ts:2551-2555`, `state: "degraded"`). No test combines an open breaker with a failing live source (grep of all `packages/` test files for breaker opening: `cache-breaker.test.ts:20-25, 118-127, 146`, and `cache.test.ts:1274-1277`, none with a failing `getGraph`). The nearest tests are `brief-fast-path.test.ts:374` (down cache, no breaker object; ran in test 3, pass) and `cache-breaker.test.ts:73` (healthy source). Behavioral proof is absent. Routes to H-1. |

**Score rule:** 5 of 6 truths VERIFIED. T6 is excluded from `verified_truths` and reported as `behavior_unverified: 1`. Both ROADMAP success criteria are VERIFIED as declared (criterion 1 = T1 and T2; criterion 2 = T4 and T5).

**Must-have caveats (not failures):**
- Criterion 1 holds under the default read policy (fail-open). Under an operator-set `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` in `enforce`, `/brief` and `/memory/recall` are refused with 503 before the source is consulted (`admission.ts:173-178` ROUTE_CLASSES `read`, `admission.ts:386-388`; `server.ts:976-981`). That is the declared D75-2 policy, recorded as open decision O1. It is not a defect, but it means criterion 1 as written ("with the cache breaker open, brief and recall return authoritative results") does not hold for an operator who sets the read class to fail-closed. The operator must accept or reject that.
- Criterion 2 holds as declared (CONTEXT line 23). A connect-cooldown window in which a fail-closed class admits as bypass is open decision O2 (owner decision, NOT FIXED). See D2.

### Required Artifacts (manual Levels 1-3; no PLAN artifacts list)

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/cache.ts` | Breaker-aware read-through; refused generation bumps; script outcome carries the breaker wait | ✓ VERIFIED | Exists; substantive (`bunRedis` `:341`, connect cooldown start `:377-379`, cooldown gate `:408-410`, `getOrLoad` `:545`, stale-generation bypass `:576-580`, `bump` `:852-863`, `peek` `:912`, `script` `:1040-1054`, `CACHE_CONNECT_COOLDOWN_MS` `:250`); wired (`service.ts:1805` `gate: this.planes.gate("cache")`; `service.ts:8601-8603` `cacheScript`) |
| `packages/mcp-server/src/admission.ts` | Per-class decision with `refused` | ✓ VERIFIED | `ROUTE_CLASSES` `:173-178`; decision branch `:386-390`; `isRefusal` `:421`; `admitBatch` `:434`; `budgetBody` `:454`; wired at `server.ts:831-834`, `:976-981`, `:2758-2760` |
| `packages/mcp-server/src/config.ts` | Parse and refuse boot | ✓ VERIFIED | `loadAdmissionSettings` `:1859`; breaker map `:1891-1896`; `breakerPolicyOf` `:1914-1919`; wired `loadConfig:1247` |
| `packages/mcp-server/src/flag-registry.ts` | Registry family | ✓ VERIFIED | `CLASS_BREAKER_NAMES` `:189`; family `:218-230` |
| `packages/mcp-server/src/server.ts` | 503 with integer Retry-After | ✓ VERIFIED | `sendBudgetRefusal` `:633-635`; REST call `:976-981`; MCP batch `:2758-2760`; Admission built `:831-834` with `substrate.cacheScript` |
| `packages/mcp-server/src/service.ts` | Brief degrades to source; snapshot refused under open breaker degrades cleanly | ✓ VERIFIED | `briefDetailed` brief `getOrLoad` `:2443-2444`; snapshot peek `:2548`; degraded `:2551-2555`; recall `getOrLoad` `:3653-3654`; lazy live-session getter `:1660-1663` |
| `packages/observability/src/instruments.ts` | `refused` decision label | ✓ VERIFIED | `ADMISSION_DECISIONS` includes `refused` at `:179`; `recordAdmission` `:585-587` |
| `packages/observability/src/slo.ts` | SLO numerator excludes refused | ✓ VERIFIED | Statement `:359`; numerator `where: { decision: "limited" }` at `:360`; denominator is the whole metric (`:361`), whose decided set excludes `bypass` and `refused` per the comment at `:341-345` |
| `packages/mcp-server/src/cache-breaker.test.ts` | New phase test file | ✓ VERIFIED | 155 lines, 4 tests (`:73`, `:98`, `:117`, `:145`); run: 4 pass |
| `admission.test.ts`, `http.admission.test.ts`, `observability/src/slo.test.ts` | Policy, flag and HTTP tests | ✓ VERIFIED | Run: 154 pass across the three files |

### Key Link Verification (manual; no PLAN key_links)

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` brief | `cache.ts` getOrLoad | `klass: "brief"` at `service.ts:2444` | ✓ WIRED | Refused read falls to `request.load()` (`cache.ts:586-589`) |
| `service.ts` recall | `cache.ts` getOrLoad | `klass: "memory-search"` at `service.ts:3654` | ✓ WIRED | Load is Hindsight recall (`service.ts:3645-3651`) |
| `server.ts` REST | `admission.ts` admit | `isRefusal` then `sendBudgetRefusal` at `server.ts:978-981` | ✓ WIRED | 503 for `refused`, 429 for `limited` (`server.ts:633-635`) |
| `admission.ts` | `cache.ts` script | `Admission` script → `substrate.cacheScript` (`server.ts:832`) → `this.cache.script` (`service.ts:8602`) → `breakerRetryAfterMs` (`cache.ts:1052`) | ✓ WIRED | Gated service cache at `service.ts:1805` |
| `observe.ts` / `server.ts` | `instruments.ts` | `observer.admission` → `recordAdmission` (`observe.ts:400`) | ✓ WIRED | Decision label passed through unfiltered; `server.ts:834` |
| `config.ts` loadConfig | `breakerPolicyOf` | `loadAdmissionSettings(env)` at `config.ts:1247` | ✓ WIRED | `ConfigError` aborts boot (asserted by `admission.test.ts:378`) |

### Data-Flow Trace (Level 4)

Not applicable to rendered UI. The brief and recall answers come from the index (the brief's live compose) and Hindsight (`recallUncounted`). `cache-breaker.test.ts:84-92` shows the index value reaching the reply; `:109` shows the recall reply equal to the uncached one.

### Behavioral Spot-Checks (Step 7b)

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Brief answers from the index with the breaker open (T1), recall equals the uncached reply (T2), generation keys (T3), admission over the real gated cache (T4) | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test packages/mcp-server/src/cache-breaker.test.ts` | 4 pass, 0 fail, 20 expect() calls (581 ms) | ✓ PASS |
| Admission policy matrix, flag parsing and invalid breaker value refusing boot (T4, T5), HTTP 503 and bypass (T4), SLO refused excluded (`slo.test.ts:110-115`) | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test packages/mcp-server/src/admission.test.ts packages/mcp-server/src/http.admission.test.ts packages/observability/src/slo.test.ts` | 154 pass, 0 fail, 3024 expect() calls across 3 files (3.23 s). Stderr shows logged refusals from tests that exercise an unwritable audit chain (ENOTDIR); these are the tests' own expected output, not failures | ✓ PASS |
| Connect cooldown expiry and refusal reporting (supports D2 reading) and the no-breaker degraded brief (`brief-fast-path.test.ts:374`, the nearest T6 evidence) | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test packages/mcp-server/src/cache.test.ts packages/mcp-server/src/brief-fast-path.test.ts -t "cooldown\|a cache that is down never fails"` | 2 pass, 0 fail, 215 filtered out, 11 expect() calls (611 ms). Test `cache.test.ts:1256` "the connect cooldown is reported and expires; a breaker refusal does not start one" and `brief-fast-path.test.ts:374` "a cache that is down never fails the brief, snapshot or not" | ✓ PASS |
| Degraded brief with breaker open and live source failing (T6) | none (no such test exists) | not run | ? SKIP → H-1 |
| Live Dragonfly stop, real 503 | requires a running server and Dragonfly | not run | ? SKIP → H-2, H-3 |

Probe execution (Step 7c): SKIPPED. Not a migration or tooling phase; no PLAN, SUMMARY or success criterion mentions probes.

### Requirements Coverage

No PLAN exists, so there is no plan `requirements:` field. The ROADMAP Phase 75 section declares no requirement IDs.

- **HARD-R2** (REQUIREMENTS.md:119; owner-approved text at 23bd0733, identical on this tree): "Reuse the existing cache-plane circuit breaker and bounded timeouts. On outage, private authority remains durable; reads fall back to the documented source or report degradation. Reject writes that cannot be made durable with retryable errors. No authoritative state exists only in the cache or an in-memory fallback." REQUIREMENTS.md:137 maps it to phase 75 with "Preliminary edits validated; not complete" (left as the owner wrote it).
  - Read-fallback and degradation clauses: evidenced by T1, T2, T3 and T6 (T6 behavior-unverified).
  - Reuse of the cache-plane breaker and bounded timeouts: evidenced by `cache.ts:341-420`, `breaker.ts:223-225`, `cache.ts:231-250`.
  - "Reject writes that cannot be made durable with retryable errors": not a phase-75 success criterion and not evaluated as one. The only retryable write refusal in this phase is the `refused` 503 with `Retry-After` for a fail-closed class (`server.ts:633-635`), which is a cache-plane outage refusal, not a durability check.
  - Status: **ORPHANED** under Step 6c. HARD-R2 is mapped to phase 75 in REQUIREMENTS.md but no PLAN declares it, because the phase has no PLAN (D1). Recorded here for the orchestrator; it adds no gap to Step 9, which uses the two ROADMAP criteria as must-haves.

### Anti-Patterns Found

Scan of the 13 covered files for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER|.skip(|.only(|not yet implemented`: no matches. No debt-marker gate applies.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/cache.ts` | 377-379, 408-409 | Connect-cooldown refusal rejects with a plain `Error` before `callPlane`, so it is not a `BreakerOpenError` even when the breaker is open (see D2) | ⚠️ Warning | A fail-closed class admits as bypass during the cooldown (O2) |
| `packages/mcp-server/src/cache.ts` | 857-860 | `staleGenerations` is an in-process `Set` (see R1) | ℹ️ Info | Residual, documented in CONTEXT R1 |

### Decision Coverage

Not evaluated: the phase directory holds no PLAN or SUMMARY, so `check.decision-coverage-verify` has no decisions to check. Recorded as not evaluated, not as zero decisions. Status impact: none. The CONTEXT decisions D75-1 to D75-4 are judged against the code in the truths above: D75-1 (defaults unchanged) by T1, T2, `admission.test.ts:325`; D75-2 and D75-2a by T4, T5; D75-3 by T1, T2; D75-4 by T3.

### Human Verification Required

H-1 is the behaviour-unverified truth (T6). H-2 to H-4 are live-only proofs. H-4(b) is open decision O1. H-5 is open decision O2.

**H-1. Degraded brief with the breaker open and the live source failing (T6)**
**Test:** Open the cache breaker (`PlaneRegistry` with `failureThreshold: 1`, as `cache-breaker.test.ts` `openCache` does). Make the live source throw (`getGraph`). Call `briefDetailed` for the same repo and graph.
**Expected:** `state` is `degraded`; no `brief-snapshot` text is served; the cache answers nothing; the brief does not throw.
**Why human:** No test combines an open breaker with a failing source. The refused and failing paths run the same catch branches, so this is a test gap rather than a different code path, but the gap is real and no test on this tree closes it. Kept open (owner-held test gap, the phase-75 H-1 item).

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
**Why human:** Delivery to live exporters and dashboards is not in code. The read-policy consequence is a declared decision (D75-2) that a human must accept.

**H-5. Cooldown window for fail-closed classes (O2)**
**Test:** Decide whether a fail-closed class may admit as bypass during the 5 s connect cooldown (`CACHE_CONNECT_COOLDOWN_MS`, `cache.ts:250`), both while the breaker is closed and while it is open after a connect-failure trip or half-open probe.
**Expected:** Accept the window under the CONTEXT rule "a connect error stays bypass in every class", or direct a change. The owner has recorded this as NOT FIXED (`STATE.md:780`, the phase 75 row). Nothing in this verification changes that.
**Why human:** A judgment about the declared rule, not a defect that a grep or a targeted test can settle.

### Open Decisions (kept open; not upgraded)

- **O1. Fail-closed read policy (D75-2).** Under `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` in `enforce`, `/brief` and `/memory/recall` are refused (503) before the authoritative source is consulted. Criterion 1 therefore holds under the default read policy, not under a fail-closed read policy. Open for the operator (H-4b).
- **O2. The 75 connect cooldown (owner decision, NOT FIXED).** See D2. Kept open (H-5, H-3). This is the only owner-held item for phase 75.
- **R1. Cross-process staleness after a refused bump (predates this phase).** `staleGenerations` lives in one process (`cache.ts:857-860`). After a restart, or on another replica, a generation key can hold its old value, and a cached brief written before the write can be served until its TTL (`CACHE_TTL["brief"]`, 5 minutes). Follow-up, not in scope here.
- **R3. `refused` is outside the admission SLO numerator (`slo.ts:360`, `:361`).** A cache outage is the breaker's signal, not a budget breach. Accepted by design; restated.

### Deviations and Gaps

**D1. No PLAN and no SUMMARY (deviation, recorded).** `75-CONTEXT.md` is the only phase artifact. With no PLAN, the must-haves are the two ROADMAP criteria, and Steps 4 and 5 are manual checks. This leaves HARD-R2 unclaimed (see Requirements Coverage).

**D2. Cooldown refusals are plain `Error`, and the window can occur with the breaker open (warning).**
- `run()` checks `cooldownUntil` before `callPlane` (`packages/mcp-server/src/cache.ts:408-410`). A refusal in the window is `Error("cache connect cooling down ...")` (`cache.ts:409`), not `BreakerOpenError`, whether or not the breaker is open.
- The cooldown starts on a failed connect (`cache.ts:377-379`) inside the same gated flight that charges the breaker (`callPlane` in `run`, `cache.ts:411`; `open()` is called inside `fn` at `cache.ts:412`). So a connect failure that trips the breaker (or fails a half-open probe) leaves the breaker open and the cooldown active for `CACHE_CONNECT_COOLDOWN_MS` = 5 s (`cache.ts:250`), within the 30 s open window (`SUBSTRATE_BREAKER_OPEN_MS` default, `breaker.ts:52`).
- `script()` maps it to `{ ok: false }` without `breakerRetryAfterMs` (`cache.ts:1052`), so `admission.ts:386` does not refuse and `admission.ts:390` records `bypass`, even in `enforce` with a fail-closed class. `attempt()` passes the cause through unchanged (`cache.ts:1161-1163`), so the `instanceof BreakerOpenError` test sees the plain error.
- Consequence in a sustained connect-refused outage: fail-closed classes admit roughly the first 5 s of each open cycle and refuse the rest. This is code-derived, not executed. No test asserts it: `cache.test.ts:1274-1279` advances past the cooldown before it asserts `BreakerOpenError`.
- Classification: not a must-have failure as declared, because CONTEXT line 23 says a connect error stays `bypass` in every class and the cooldown refusal is a connect-cooldown refusal, not a breaker refusal. Whether that reading is right for a fail-closed class during the window is the owner's O2 decision. It stays NOT FIXED and is not decided here.

**D3. The refused-generation-bump residual R1 is in-process only.** `staleGenerations` (`cache.ts:857-860`) is added on a failed bump, cleared on a successful one, and checked before a read (`cache.ts:576`). See R1.

**D4. Fail-closed read policy (O1).** See O1 and H-4(b).

**D5. CONTEXT is stale in three places (documentation drift, not a code defect).** CONTEXT line 23 says a fail-closed refusal in `shadow` "records `shadow_limited`". The code records `bypass` (`admission.ts:386-390`, `admission.test.ts:341` "a breaker refusal of a fail-closed class is a bypass in shadow", `docs/config-reference.md:279`), per commit `c71d4409`. CONTEXT line 40 repeats the stale `shadow_limited` test description. CONTEXT line 47 cites `slo.ts:359` and `config.ts:1849`, which are now `slo.ts:360` and `config.ts:1914` (`breakerPolicyOf`) and `config.ts:1859` (`loadAdmissionSettings`). CONTEXT should be corrected by its owner. This verification did not edit it.

**D6. Degraded brief path has no test with the breaker open (warning).** See T6 and H-1.

**D7. Docs generation not confirmed (not checked).** CONTEXT says `docs/config-reference.md` is hand-rendered. The rows at `docs/config-reference.md:279` and `:493` are present. No generator check was run.

**D8. `.env.example` and docs are excluded from the fingerprint (judgment call, same as the prior record).** They are configuration and documentation, not code.

**D9. Stale status lines (documentation drift).** origin/main ROADMAP says `Not started` (stale; see Inputs). This tree's ROADMAP status line names 7382ad10, not c7788f9d. Neither is used as a verdict.

### Gaps Summary

No FAILED truth, no MISSING or STUB artifact, no NOT_WIRED link, no blocker anti-pattern. No `gaps:` block is emitted. Warnings: D2 (cooldown, O2, owner-held), D6 (H-1 test gap), and the HARD-R2 orphan note. Status is `human_needed` by Step 9 rule 2: human items exist (H-1 to H-5), and T6 is a present-but-behavior-unverified truth. `passed` is not valid. Step 9b deferral is not needed: there are no gaps to defer.

---

_Verified: 2026-11-02T18:28:00Z_
_Verifier: Claude (gsd-verifier)_
