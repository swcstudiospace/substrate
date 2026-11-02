---
phase: 75-dragonfly-degradation
verified: 2026-11-02T16:02:51Z
status: human_needed
score: 5/6 truths verified (2/2 ROADMAP must-haves verified; 1 truth behavior-unverified)
covered_files: ["packages/mcp-server/src/admission.test.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/cache-breaker.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/http.admission.test.ts", "packages/mcp-server/src/live-session-consumer.test-support.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/observability/src/instruments.ts", "packages/observability/src/slo.test.ts", "packages/observability/src/slo.ts"]
covered_digest: "v3:sha256:19f94924cccf9a73d281091a3fb91edf71227744f486755d1a991eb26865e668"
behavior_unverified: 1
overrides_applied: 0
behavior_unverified_items:
  - truth: "Degraded brief with the cache breaker open and the live source failing: the refused snapshot read leaves the brief in state degraded, no stale snapshot is served, and the brief does not throw"
    test: "Open the cache breaker (failureThreshold 1 via PlaneRegistry, as cache-breaker.test.ts openCache does), make the brief's live source throw (getGraph), call briefDetailed for the same repo and graph"
    expected: "state is degraded; no brief-snapshot text is served; the cache answers nothing; the brief does not throw"
    why_human: "No test combines an open breaker with a failing live source. brief-fast-path.test.ts:374 covers a failing store with no breaker object, and brief-fast-path.test.ts:262 covers a healthy store. The refused and failing paths share the same catch branches (cache.ts:583-589, 594-605, 912-929), so the residual is a missing test, not a different branch"
coincidental_reliance_items: []
human_verification:
  - test: "With the full stack running and default flags (nothing set), stop the live Dragonfly, then call POST /brief and POST /memory/recall"
    expected: "Both answer 200 with authoritative source content; each returns within the command timeout (no hang); cache health reports degraded"
    why_human: "In-process tests inject an open breaker or use an unreachable port (cache-breaker.test.ts:17, :21-25). A real outage with real sockets, real timeouts and a real breaker transition is not observed"
  - test: "Set SUBSTRATE_BUDGETS=enforce and SUBSTRATE_BUDGET_READ_BREAKER=fail-closed. Stop the live Dragonfly, drive enough connect failures to open the breaker, then call POST /brief"
    expected: "HTTP 503, body {\"error\":\"cache_unavailable\",\"class\":\"read\",\"retry_after_s\":N}, Retry-After equal to N as an integer, and one substrate.admission.decisions{decision=\"refused\"} increment. Note the cooldown window (decision D2 below): requests in the first 5 s of each open cycle are admitted as bypass, not refused"
    why_human: "http.admission.test.ts:274-289 injects BreakerOpenError into a fake redis. The real breaker opening and closing under a live Dragonfly is not observed"
  - test: "Check the refused decision in the real pipeline: /metrics, the OTel/Greptime export, and any dashboard that reads substrate.admission.decisions"
    expected: "decision=\"refused\" series appears with surface and class labels; it is not in the admission.limited_rate numerator (slo.ts:360)"
    why_human: "recordAdmission (observability/src/instruments.ts:585-587, wired at observe.ts:400 and server.ts:831) is verified in code and by the in-process HTTP test. Delivery to the live exporter and dashboards is not"
  - test: "Operator decision on the read policy (D75-2, see Open decisions O1): with SUBSTRATE_BUDGETS=enforce, SUBSTRATE_BUDGET_READ_BREAKER=fail-closed and the breaker open, /brief and /memory/recall (class read, admission.ts:174,178) answer 503 before the authoritative source is consulted"
    expected: "Operator confirms this is the intended declared policy for read, and that ROADMAP criterion 1 is understood as holding under the default and write/coordination policies, not under a fail-closed read policy"
    why_human: "The policy is declared in CONTEXT (D75-2). Whether brief and recall may be refused rather than answered is a judgment the operator must accept"
  - test: "Decide the connect-cooldown window for fail-closed classes (O2, the 75 cooldown, owner decision kept NOT FIXED)"
    expected: "Either accept that a fail-closed class admits as bypass during the 5 s connect cooldown, including the first 5 s of each open cycle that a connect failure starts, or direct a change"
    why_human: "The behaviour is a judgment about the declared rule, not a defect that a grep or a targeted test can settle"
---

# Phase 75: DragonflyDB degradation Verification Report

**Phase Goal:** When the cache plane is open or unreachable, reads fall back to the authoritative store without losing state, and admission behaves as declared.
**Verified:** 2026-11-02T16:02:51Z
**Status:** human_needed
**Re-verification:** No. The prior 75-VERIFICATION.md (written on branch `gsd/v18-p75-dragonfly-degradation`) had no `gaps:` block and is overwritten, as the brief directs. This is a fresh run on the integration tree.

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `7382ad10`.
- Criteria source: origin/main ROADMAP (`git show origin/main:.planning/ROADMAP.md`, origin/main at `b1b42f92`), the `### Phase 75` section. It is present there. Its two success criteria are word-for-word identical to this tree's ROADMAP section. The origin/main section's `**Status**: Not started` line is stale text and is not used as a verdict. The working-tree `.planning/ROADMAP.md` and `.planning/STATE.md` carry uncommitted edits by someone else; they are not covered and not edited here.
- Must-haves: the two ROADMAP Phase 75 success criteria, verbatim. No PLAN.md exists for this phase (D1), so there are no PLAN frontmatter artifacts or key links. Steps 4 and 5 are manual Level 1-3 checks.
- Covered files: the phase's code commits (`63772d5e`, `b45ba5d1`, `c71d4409`) plus `634b6171`, the integration fix that made the live-session facade lazy in `service.ts` and changed `settle()` in `live-session-consumer.test-support.ts`. Docs and `.env.example` are excluded, the same convention as the prior record (D8). Fingerprint: `gsd_run query verification.fingerprint .planning/phases/75-dragonfly-degradation <13 files>`.
- No CONTEXT or PLAN conflicts with the criteria were found on the criteria themselves. CONTEXT's wording conflicts with the code on one point (D5). Both are reported below. Nothing was chosen silently.
- Full gates were run by the orchestrator on this tree. Not re-run here. No full suite, tsc, lint or formatters were run.

### Integration facts judged from the code

- **634b6171 (lazy live-session facade).** `Substrate.liveSessions` is now a memoised getter (`service.ts:1655-1659`). The constructor stores a thunk (`service.ts:1884-1886`) and never reads the index. The brief path reads the live-session authority only in `liveBriefSections` (gate at `service.ts:3919-3925`; metadata read at `service.ts:3824-3825`), and only when `SUBSTRATE_BRIEF_SESSIONS` or the worktree registry is on. `liveBriefSections` does not touch the cache, so the live sections are authoritative and independent of the breaker. The cache-breaker tests construct `Substrate` with an index that has no `liveSessions` method. They pass on this tree (Step 7b, below), which confirms that the lazy getter makes them safe.
- **634b6171 (settle).** `settle()` is used by live-session tests only. Phase 75's targeted tests do not depend on it.
- **Phase 71 steering design.** Phase 75's brief and recall paths do not depend on the steering layer when their flags are off. The brief's live sections, when on, do not go through the cache.

### Test runs (targeted; three `bun test` commands in total; no Postgres)

Environment for each: `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`, run from the worktree, serially.

| # | Command | Result |
| - | ------- | ------ |
| 1 | `bun test packages/mcp-server/src/cache-breaker.test.ts` | 4 pass, 0 fail, 20 expect() calls |
| 2 | `bun test packages/mcp-server/src/admission.test.ts packages/mcp-server/src/http.admission.test.ts packages/observability/src/slo.test.ts` | 154 pass, 0 fail, 3024 expect() calls. Stderr shows logged refusals from tests that exercise an unwritable audit chain (ENOTDIR); these are the tests' own expected output, not failures |
| 3 | `bun test packages/mcp-server/src/cache.test.ts -t "cooldown"` | 1 pass, 184 filtered out, 0 fail |

Tests not run (no targeted command was spent on them): `brief-fast-path.test.ts:262` and `:374`. Their presence and names were read, not executed, in this run.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| T1  | Must-have 1, brief: with the cache breaker open, brief returns the authoritative (index) result | ✓ VERIFIED | Brief reads go through `cache.getOrLoad({ klass: "brief", ..., load })` at `packages/mcp-server/src/service.ts:2433-2434`. The breaker gate sits in `bunRedis` (`cache.ts:341`, `run` at `:406-411`, `callPlane` at `:411`). `callPlane` refuses before calling `fn` (`packages/observability/src/breaker.ts:223-225`), so no socket is opened. The refused `readAll` falls into the catch at `cache.ts:583-589`, which calls `request.load()`, the live compose. Test: `cache-breaker.test.ts:73` "brief is composed from the index on every call, and the cache never answers it". Ran: test 1, pass. |
| T2  | Must-have 1, recall: with the cache breaker open, recall returns the authoritative (Hindsight) result | ✓ VERIFIED | `POST /memory/recall` → `server.ts:1493` → `substrate.recallMemories` (`service.ts:3567`) → `recallUncounted` → `cache.getOrLoad({ klass: "memory-search", ... load })` (`service.ts:3617-3627`). A refused read takes the same catch path (`cache.ts:583-589`) and loads from Hindsight. Test: `cache-breaker.test.ts:98` "recall returns the same reply as a substrate with no cache at all" (asserts `answered` equals `plain`, `hits: 0`). Ran: test 1, pass. |
| T3  | Generation keys: a bump the breaker refused keeps reads on the source after the breaker closes, until a bump lands (no state lost, no stale answer) | ✓ VERIFIED | `bump` marks the key stale on failure (`cache.ts:852-862`). `getOrLoad` bypasses a stale generation (`cache.ts:576-580`). A successful bump clears it (`cache.ts:857`). Test: `cache-breaker.test.ts:117`. Ran: test 1, pass. |
| T4  | Must-have 2, admission: under an open breaker the policy is declared per class; fail-open admits as bypass; fail-closed refuses in enforce; shadow admits as bypass | ✓ VERIFIED | `script()` returns `breakerRetryAfterMs` only for `BreakerOpenError` (`cache.ts:1052`). `Admission.admit` refuses only when the class is `fail-closed` AND mode is `enforce` (`admission.ts:386-388`), otherwise bypass (`admission.ts:390`). Enforced at REST before the handler (`server.ts:978-981`) and for MCP batches (`server.ts:2757-2760`, `admitBatch` at `admission.ts:440-452`). 503 with integer `Retry-After` and body `{error, class, retry_after_s}` (`server.ts:633-635`, `admission.ts:454-456`). Tests: `cache-breaker.test.ts:145` (real gated client, fail-closed write refused, fail-open read bypass, one breaker failure from setup only); `admission.test.ts:334-349` (enforce refused, shadow bypass, other classes bypass); `http.admission.test.ts:274-289`. Ran: tests 1 and 2, all pass. |
| T5  | Must-have 2: the policy is declared per class in flags, defaults fail-open, and an invalid value refuses boot naming the variable | ✓ VERIFIED | `SUBSTRATE_BUDGET_<CLASS>_BREAKER` per `ADMISSION_CLASSES` (`config.ts:1890-1895`). `breakerPolicyOf` (`config.ts:1913-1918`): blank is `fail-open`; anything but the two values throws `ConfigError` naming the variable and never the value. `loadAdmissionSettings` is called unguarded from `loadConfig` (`config.ts:1246`), so boot refuses. Registry family at `flag-registry.ts:215-228`. Documented at `docs/config-reference.md:279` and `:493`, `docs/observability.md:173` and `:987`, `.env.example:280-282`. Tests: `admission.test.ts:325` (default fail-open), `:365` (parse), `:375` (invalid refuses boot). Ran: test 2, pass. |
| T6  | Degraded brief with the cache breaker open and the live source failing: state is degraded, no stale snapshot served, the brief does not throw | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Presence and wiring: the snapshot peek (`service.ts:2538`) and `snapshotSurvivesForget` (`:2540`) run only after a live failure (`failed.length === 0` is the success branch at `:2529`, the failure path follows). Under an open breaker `peek` is refused, caught and returns null (`cache.ts:912-929`, its catch calls `fail`), so the brief takes the degraded branch (`service.ts:2541-2545`, `state: "degraded"`). No test combines an open breaker with a failing live source. `brief-fast-path.test.ts:374` ("a cache that is down never fails the brief") uses a failing `FakeRedis` with no breaker object, and the same catch branches. Presence is not proof of runtime behaviour; see H-1. Not run. |

**Score rule:** 5 of 6 truths VERIFIED. T6 is excluded from `verified_truths` and reported as `behavior_unverified: 1`. Both ROADMAP must-haves are VERIFIED (must-have 1 = T1 and T2; must-have 2 = T4 and T5).

**Must-have caveats (not failures):**
- Must-have 1 holds under the default read policy (fail-open). Under an operator-set `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` in `enforce`, `/brief` and `/memory/recall` are refused with 503 before the source is consulted (`admission.ts:174`, `:178`; `server.ts:978-981`). That is the declared D75-2 policy, recorded as open decision O1. It is not a defect.
- Must-have 2 holds for the open-breaker condition as declared. A connect-cooldown window in which a fail-closed class admits as bypass is open decision O2 (the 75 cooldown, owner-kept NOT FIXED). Its window can also fall while the breaker is open. See D2, where the earlier framing is corrected.

### Required Artifacts (manual Levels 1-3; no PLAN artifacts list)

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/cache.ts` | Breaker-aware read-through; refused generation bumps; script outcome carries the breaker wait | ✓ VERIFIED | Exists; substantive (`getOrLoad` `:545`, stale-generation bypass `:576-580`, `bump` `:852-862`, `peek` `:912`, `script` `:1040-1054`); wired (`service.ts:1799` `gate: this.planes.gate("cache")`) |
| `packages/mcp-server/src/admission.ts` | Per-class decision with `refused` | ✓ VERIFIED | `ROUTE_CLASSES` `:173-178`; decision branch `:386-390`; `isRefusal` `:421`; `admitBatch` `:440-452`; `budgetBody` `:454`; wired at `server.ts:831`, `:978`, `:2759` |
| `packages/mcp-server/src/config.ts` | Parse and refuse boot | ✓ VERIFIED | `loadAdmissionSettings` `:1858`; breaker map `:1890-1895`; `breakerPolicyOf` `:1913`; wired `loadConfig:1246` |
| `packages/mcp-server/src/flag-registry.ts` | Registry family | ✓ VERIFIED | `CLASS_BREAKER_NAMES` `:189`; family `:215-228` |
| `packages/mcp-server/src/server.ts` | 503 with integer Retry-After | ✓ VERIFIED | `sendBudgetRefusal` `:633-635`; REST call `:978-981`; MCP batch `:2757-2760` |
| `packages/mcp-server/src/service.ts` | Brief degrades to source; snapshot refused under open breaker degrades cleanly | ✓ VERIFIED | `briefDetailed` `:2322`; brief `getOrLoad` `:2433`; snapshot peek `:2538`; degraded `:2541-2545`; lazy live-session getter `:1655-1659` (634b6171) |
| `packages/observability/src/instruments.ts` | `refused` decision label | ✓ VERIFIED | `ADMISSION_DECISIONS` includes `refused` at `:179`; `recordAdmission` `:585-587` |
| `packages/observability/src/slo.ts` | SLO numerator excludes refused | ✓ VERIFIED | Numerator `where decision: "limited"` at `:360`; denominator `allowed`+`limited`+`shadow_limited` at `:374` |
| `packages/mcp-server/src/cache-breaker.test.ts` | New phase test file | ✓ VERIFIED | 155 lines, 4 tests (`:73`, `:98`, `:117`, `:145`); run: 4 pass |
| `admission.test.ts`, `http.admission.test.ts`, `observability/src/slo.test.ts` | Policy, flag and HTTP tests | ✓ VERIFIED | Run: 154 pass across the three files |

### Key Link Verification (manual; no PLAN key_links)

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` brief | `cache.ts` getOrLoad | `klass: "brief"` at `service.ts:2434` | ✓ WIRED | Refused read falls to `request.load()` (`cache.ts:583-589`) |
| `service.ts` recall | `cache.ts` getOrLoad | `klass: "memory-search"` at `service.ts:3618` | ✓ WIRED | Load is Hindsight recall (`service.ts:3617-3627`) |
| `server.ts` REST | `admission.ts` admit | `isRefusal` then `sendBudgetRefusal` at `server.ts:978-981` | ✓ WIRED | 503 for `refused`, 429 for `limited` (`server.ts:633-635`) |
| `admission.ts` | `cache.ts` script | `this.script(...)` → `breakerRetryAfterMs` (`cache.ts:1052`) | ✓ WIRED | Gated service cache at `service.ts:1799`, `cacheScript` `service.ts:8562` |
| `observe.ts` / `server.ts` | `instruments.ts` | `observer.admission` → `recordAdmission` (`observe.ts:400`) | ✓ WIRED | Decision label passed through unfiltered |
| `config.ts` loadConfig | `breakerPolicyOf` | `loadAdmissionSettings(env)` at `config.ts:1246` | ✓ WIRED | Unguarded; `ConfigError` aborts boot |

### Data-Flow Trace (Level 4)

Not applicable to rendered UI. The brief and recall answers come from the index (the brief's live load) and Hindsight (`recallUncounted`). `cache-breaker.test.ts:84-92` shows the index value reaching the reply, and `:126-135` shows the recall reply equal to the uncached one.

### Behavioral Spot-Checks (Step 7b)

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Brief answers from the index with the breaker open (T1), recall equals the uncached reply (T2), generation keys (T3), admission over the real gated cache (T4) | `bun test packages/mcp-server/src/cache-breaker.test.ts` | 4 pass, 0 fail | ✓ PASS |
| Admission policy matrix, flag parsing and invalid breaker value refusing boot (T4, T5), HTTP 503 and bypass (T4), SLO refused excluded (`slo.test.ts`) | `bun test packages/mcp-server/src/admission.test.ts packages/mcp-server/src/http.admission.test.ts packages/observability/src/slo.test.ts` | 154 pass, 0 fail | ✓ PASS |
| Connect cooldown expiry and refusal reporting (supports D2 reading) | `bun test packages/mcp-server/src/cache.test.ts -t "cooldown"` | 1 pass, 0 fail (184 filtered) | ✓ PASS |
| Degraded brief with breaker open and live source failing (T6) | none (no such test exists) | not run | ? SKIP → H-1 |
| Live Dragonfly stop, real 503 | requires a running server and Dragonfly | not run | ? SKIP → human |

Probe execution (Step 7c): SKIPPED. Not a migration or tooling phase; no PLAN, SUMMARY or success criterion mentions probes.

### Requirements Coverage

No PLAN exists, so there is no plan `requirements:` field. The ROADMAP Phase 75 section declares no requirement IDs. Not evaluated beyond this note.

### Anti-Patterns Found

Scan of the added lines in `63772d5e`, `b45ba5d1`, `56c0c2c1`, `c71d4409`, `634b6171` (packages and docs) for `TODO|FIXME|XXX|HACK|placeholder|not yet implemented|.skip|.todo|.only`: no matches.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/cache.ts` | 502 | `staleGenerations` is an in-process `Set` (see R1) | ℹ️ Info | Residual, documented in CONTEXT R1 |
| `packages/mcp-server/src/cache.ts` | 408-410 | Connect-cooldown refusal rejects with a plain `Error` before `callPlane`, so it is not a `BreakerOpenError` even when the breaker is open (see D2) | ⚠️ Warning | A fail-closed class admits as bypass during the cooldown |

### Decision Coverage

Not evaluated: the phase directory holds no PLAN or SUMMARY, so `check.decision-coverage-verify` has no decisions to check. This is recorded as not evaluated, not as zero decisions. Status impact: none.

### Human Verification Required

H-1 is the behaviour-unverified truth. H-2 to H-4 are live-only proofs. H-5 is the cooldown decision (O2). The read-policy decision is O1, listed under H-4(b).

**H-1. Degraded brief with the breaker open and the live source failing (T6)**
**Test:** Open the cache breaker (`PlaneRegistry` with `failureThreshold: 1`, as `cache-breaker.test.ts` `openCache` does). Make the live source throw (`getGraph`). Call `briefDetailed` for the same repo and graph.
**Expected:** `state` is `degraded`; no `brief-snapshot` text is served; the cache answers nothing; the brief does not throw.
**Why human:** No test combines an open breaker with a failing source. The refused and failing paths run the same catch branches, so this is a test gap rather than a different code path, but the gap is real and no test on this tree closes it.

**H-2. Live stop of Dragonfly while brief and recall run**
**Test:** Full stack up, default flags (nothing set). Stop the live Dragonfly. Call `POST /brief` and `POST /memory/recall`.
**Expected:** 200 with authoritative source content; each returns within the command timeout (no hang); cache health reports degraded.
**Why human:** In-process tests use an unreachable port (`cache-breaker.test.ts:17`) or an injected open breaker. A real outage with real sockets, timeouts and a breaker transition is not observed.

**H-3. Live fail-closed 503 with Retry-After**
**Test:** `SUBSTRATE_BUDGETS=enforce`, `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed`. Stop Dragonfly and drive connect failures until the breaker opens. Call `POST /brief`.
**Expected:** HTTP 503, body `{"error":"cache_unavailable","class":"read","retry_after_s":N}`, `Retry-After: N` as an integer, and one `substrate.admission.decisions{decision="refused"}` increment. Requests in the first 5 s of each open cycle are admitted as bypass (O2).
**Why human:** `http.admission.test.ts:274-289` injects a `BreakerOpenError` into a fake redis; the real breaker transition is not observed.

**H-4. Refused-decision metric in the real pipeline; operator acceptance of the fail-closed read policy**
**Test:** (a) Check `/metrics`, the OTel/Greptime export and any dashboard for `substrate.admission.decisions{decision="refused"}`. Confirm it is outside `admission.limited_rate` (`slo.ts:360`, R3). (b) Confirm the operator accepts that with `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` and the breaker open, `/brief` and `/memory/recall` answer 503 and do not reach the authoritative source (O1).
**Expected:** (a) the series exists with surface and class labels; (b) the operator confirms this is the intended policy.
**Why human:** Delivery to live exporters and dashboards is not in code. The read-policy consequence is a declared decision (D75-2) that a human must accept.

**H-5. Cooldown window for fail-closed classes (O2)**
**Test:** Decide whether a fail-closed class may admit as bypass during the 5 s connect cooldown (`CACHE_CONNECT_COOLDOWN_MS`, `cache.ts:250`), both while the breaker is closed and while it is open after a connect-failure trip or probe.
**Expected:** Accept the window under the CONTEXT rule "a connect error stays bypass in every class", or direct a change. The owner has recorded this as NOT FIXED (`STATE.md` lines 757 and 774; `ROADMAP.md` Phase 75 status). Nothing in this verification changes that.
**Why human:** A judgment about the declared rule, not a defect that a grep or a targeted test can settle.

### Open Decisions (kept open; not upgraded)

- **O1. Fail-closed read policy (D75-2).** Under `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` in `enforce`, `/brief` and `/memory/recall` are refused (503) before the authoritative source is consulted. Criterion 1 therefore holds under the default read policy, not under a fail-closed read policy. Open for the operator (H-4b).
- **O2. The 75 cooldown (owner decision, NOT FIXED).** See D2. Kept open.
- **R1. Cross-process staleness after a refused bump (predates this phase).** `staleGenerations` lives in one process (`cache.ts:502`). After a restart, or on another replica, a generation key can hold its old value, and a cached brief written before the write can be served until its TTL (`CACHE_TTL["brief"]`, 5 minutes). Follow-up, not in scope here.
- **R3. `refused` is outside the admission SLO numerator (`slo.ts:360`, `:374`).** A cache outage is the breaker's signal, not a budget breach. Accepted by design; restated.

### Deviations and Gaps

**D1. No PLAN and no SUMMARY (deviation, recorded).** `75-CONTEXT.md` is the only phase artifact. With no PLAN, the must-haves are the two ROADMAP criteria, and Steps 4 and 5 are manual checks.

**D2. Cooldown refusals are plain `Error`, and the window can occur with the breaker open (warning; corrects the prior framing).** The earlier record said the breaker is closed in this window. The code shows it is not limited to that:
- `run()` checks `cooldownUntil` before `callPlane` (`cache.ts:408-410`). A refusal in the window is `Error("cache connect cooling down ...")`, not `BreakerOpenError`, whether or not the breaker is open.
- The cooldown starts on a failed connect (`cache.ts:379`) inside the same gated flight that charges the breaker. So a connect failure that trips the breaker (or fails a half-open probe) leaves the breaker open and the cooldown active for `CACHE_CONNECT_COOLDOWN_MS` = 5 s (`cache.ts:250`), within a 30 s open window (`SUBSTRATE_BREAKER_OPEN_MS` default, `breaker.ts:52`).
- `script()` maps it to `{ ok: false }` without `breakerRetryAfterMs` (`cache.ts:1052`), so `admission.ts:386` does not refuse and `admission.ts:390` records `bypass`, even in `enforce` with a fail-closed class.
- Consequence in a sustained connect-refused outage: fail-closed classes admit roughly the first 5 s of each open cycle and refuse the rest. This is code-derived, not executed. No test asserts it: `cache.test.ts:1275-1281` advances past the cooldown before it asserts `BreakerOpenError`.
- Classification: not a must-have failure, because the declared rule in CONTEXT says a connect error stays `bypass` in every class. It is the owner's O2 decision and stays NOT FIXED.

**D3. The refused-generation-bump residual R1 is in-process only.** `staleGenerations` (`cache.ts:502`) is added on a failed bump (`:860`), cleared on a successful one (`:857`), and checked before a read (`:576`). See R1.

**D4. Fail-closed read policy (O1).** See O1 and H-4(b).

**D5. CONTEXT is stale in three places (documentation drift, not a code defect).** CONTEXT line 23 says a fail-closed refusal in `shadow` "records `shadow_limited`". The code records `bypass` (`admission.ts:386-390`, `admission.test.ts:341` "a breaker refusal of a fail-closed class is a bypass in shadow", `docs/config-reference.md:279`, `docs/observability.md:173`, `:987`), per commit `c71d4409`. CONTEXT line 40 repeats the stale `shadow_limited` test description. CONTEXT line 47 cites `slo.ts:359` and `config.ts:1849`, which have moved to `slo.ts:360` and `config.ts:1913`. CONTEXT should be corrected by its owner. This verification did not edit it.

**D6. Degraded brief path has no test with the breaker open (warning).** See T6 and H-1.

**D7. Docs generation not confirmed (not checked).** CONTEXT says `docs/config-reference.md` is hand-rendered. The rows at `docs/config-reference.md:279` and `:493` are present. No generator check was run.

**D8. `.env.example` and docs are excluded from the fingerprint (judgment call, same as the prior record).** They are configuration and documentation, not code. The brief asked for code files only.

### Gaps Summary

No FAILED truth, no MISSING or STUB artifact, no NOT_WIRED link, no blocker anti-pattern. No `gaps:` block is emitted. Status is `human_needed` by Step 9 rule 2: human items exist (H-1 to H-5). `passed` is not valid.

---

_Verified: 2026-11-02T16:02:51Z_
_Verifier: Claude (gsd-verifier)_
