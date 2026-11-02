---
phase: 75-dragonfly-degradation
verified: 2026-11-02T02:09:23Z
status: human_needed
score: 4/5 truths verified (2/2 ROADMAP must-haves; 1 truth behavior-unverified)
covered_files: ["packages/mcp-server/src/admission.test.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/cache-breaker.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/http.admission.test.ts", "packages/mcp-server/src/server.ts", "packages/observability/src/instruments.ts", "packages/observability/src/slo.test.ts", "packages/observability/src/slo.ts"]
covered_digest: "v3:sha256:65c936142ea1089754d0d9b41c97b0373cd415d0a1f3105353dd4efc86d2997b"
behavior_unverified: 1
overrides_applied: 0
behavior_unverified_items:
  - truth: "Degraded brief with the cache breaker open: the live source fails, the refused snapshot read leaves the brief in state degraded, and no stale answer is served from the cache"
    test: "Open the cache breaker (failureThreshold 1, or a real plane failure), make the brief's live source throw (for example getGraph), call briefDetailed for the same repo and graph"
    expected: "state is degraded; no brief-snapshot text is served; the cache answers nothing; the brief does not throw"
    why_human: "The degraded path is covered only with a healthy or merely failing FakeRedis (brief-fast-path.test.ts:261 and :362). No test opens the breaker and fails the live source together, so the snapshot-refusal branch under an open breaker is unexercised"
coincidental_reliance_items: []
human_verification:
  - test: "With the full stack running, stop the live Dragonfly, then call POST /brief and POST /memory/recall with default flags (nothing set)"
    expected: "Both answer 200 with authoritative source content, the answer returns within the command timeout (no hang), and cache health reports degraded"
    why_human: "The in-process tests inject an open breaker or point at an unreachable port (cache-breaker.test.ts:17, :20-27). They do not exercise a live outage with real sockets, real timeouts and a real breaker transition"
  - test: "Set SUBSTRATE_BUDGETS=enforce and SUBSTRATE_BUDGET_READ_BREAKER=fail-closed. Stop the live Dragonfly and drive enough cache failures to open the breaker. Call POST /brief"
    expected: "HTTP 503, body {\"error\":\"cache_unavailable\",\"class\":\"read\",\"retry_after_s\":N}, a Retry-After header equal to N as an integer, and a substrate.admission.decisions{decision=\"refused\"} increment"
    why_human: "http.admission.test.ts:264-279 injects BreakerOpenError into a fake redis; the real breaker opening and closing under a live Dragonfly is not observed"
  - test: "With the refused decision in use, check the metric in the real pipeline: /metrics, the OTel/Greptime export, and any dashboard that reads substrate.admission.decisions"
    expected: "decision=\"refused\" series appears with the class and surface labels; it is not counted in the admission.limited_rate SLO numerator (refused is outside limited)"
    why_human: "recordAdmission (observability/src/instruments.ts:585-587) is verified in code and by the in-process HTTP test, but delivery to the live exporter and dashboards is not"
  - test: "Operator decision on policy: with SUBSTRATE_BUDGET_READ_BREAKER=fail-closed and the breaker open, /brief and /memory/recall (both class read, admission.ts:174,178) are refused 503 before the authoritative source is consulted"
    expected: "Confirm this is the intended declared policy for read (D75-2) and that ROADMAP criterion 1 is understood as holding under the default and the write/coordination policies, not under a fail-closed read policy"
    why_human: "The policy choice is declared (D75-2), but the operator must accept that brief and recall are then refused, not authoritative, under that flag"
  - test: "Decide whether a fail-closed class may admit during the 5 s connect cooldown while the breaker is still closed (see Deviations, item D2)"
    expected: "Either accept the window as the connect-error rule in CONTEXT, or direct a change so cooldown refusals of fail-closed classes are refused"
    why_human: "The behaviour is a judgment about the declared rule, not a defect the grep or test checks can settle"
---

# Phase 75: DragonflyDB degradation Verification Report

**Phase Goal:** When the cache plane is open or unreachable, reads fall back to the authoritative store without losing state, and admission behaves as declared.
**Verified:** 2026-11-02T02:09:23Z
**Status:** human_needed
**Re-verification:** No — initial verification (the existing 75-VERIFICATION.md was written without this procedure and is treated as no valid prior verification)

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-p75`, branch `gsd/v18-p75-dragonfly-degradation`.
- Must-haves: the two ROADMAP Phase 75 success criteria, verbatim. No PLAN.md exists for this phase (see Deviations D1), so no PLAN frontmatter must-haves, artifacts or key_links were available. Steps 4 and 5 (`verify.artifacts`, `verify.key-links`) are therefore not applicable: they need a PLAN. Level 1-3 checks were done by hand on the files named below.
- Changed implementation files (`git diff --name-only origin/main...HEAD`, code only; `.planning/*` and `docs/*` dropped): 11 files, fingerprint computed with `gsd_run query verification.fingerprint`.
- Full gates were run by the orchestrator (tsc 0; bun test 11316 pass, 2 skip, 0 fail; phase-close 236 pass). Not re-run here.
- Step 7b behavioural spot-checks: one named test per behaviour-dependent truth (listed under each truth below). Full suite not run.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1a  | Must-have 1, brief: with the cache breaker open, brief returns the authoritative (index) result | ✓ VERIFIED | Code: brief reads go through `cache.getOrLoad({ klass: "brief", ... load })` at `packages/mcp-server/src/service.ts:2128`. A refused read takes the catch branch and returns `request.load()` (the source) at `packages/mcp-server/src/cache.ts:568-580`; the cache plane gate refuses before any socket is opened (`cache.ts:335`, `packages/observability/src/breaker.ts:215-225`). Test: `packages/mcp-server/src/cache-breaker.test.ts:73` "brief is composed from the index on every call, and the cache never answers it". Step 7b run: `bun test packages/mcp-server/src/cache-breaker.test.ts -t "brief is composed from the index on every call"` → 1 pass, 0 fail. The test asserts the answer changes when the index changes and `cache.health().hits === 0` |
| 1b  | Must-have 1, recall: with the cache breaker open, recall returns the authoritative (Hindsight) result | ✓ VERIFIED | Code: recall's cache read is `klass: "memory-search"` at `service.ts:3020`, whose load is `recallUncounted` (`service.ts:3042`, `:3208`); a refused read falls through to the source (`cache.ts:568-580`). Test: `packages/mcp-server/src/cache-breaker.test.ts:98` "recall returns the same reply as a substrate with no cache at all". Step 7b run: `bun test ... -t "recall returns the same reply as a substrate with no cache"` → 1 pass, 0 fail. Asserts `answered` deep-equals the no-cache reply and `hits: 0` |
| 1c  | Brief degraded path (sub-truth from the brief's check, not a ROADMAP wording): breaker open and live source failing, the refused snapshot read leaves the brief degraded with no stale serve | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Presence: snapshot peek and `snapshotSurvivesForget` at `service.ts:2231-2234`; a null snapshot returns state `degraded` at `service.ts:2236-2239`; a served snapshot carries the banner at `service.ts:2241`. No test opens the breaker and fails the live source together: `brief-fast-path.test.ts:261` ("snapshot: ... served with a banner once the live compose degrades") uses a healthy `FakeRedis`, and `brief-fast-path.test.ts:362` ("a cache that is down never fails the brief") uses a failing `FakeRedis` with no breaker. Routed to Human Verification item H-1. Not counted in `verified_truths` |
| 2a  | Must-have 2: admission under an open breaker follows the declared policy per class (fail-open admits as bypass; fail-closed refuses in enforce, shadow admits as bypass) | ✓ VERIFIED | Code: breaker refusal detected from `ScriptOutcome.breakerRetryAfterMs` (`cache.ts:1044`, set only for `BreakerOpenError`); `Admission.admit` refuses as `refused` only when policy is `fail-closed` AND mode is `enforce` (`admission.ts:379-381`), otherwise bypass (`admission.ts:383`). Enforcement: REST `server.ts:908-909`, MCP batch `server.ts:2649`; 503 with integer `Retry-After` and bounded body at `server.ts:628-630` and `admission.ts:447`. Test: `packages/mcp-server/src/cache-breaker.test.ts:145` "admission over the open breaker: a fail-closed class is refused, a fail-open class admits, and neither reaches the plane". Step 7b run: `bun test ... -t "admission over the open breaker"` → 1 pass, 0 fail. Also covered (not run): `admission.test.ts:308-340` (policy matrix, shadow → bypass, batch body), `http.admission.test.ts:264-279` (HTTP 503 + `Retry-After: 2`, `decision=refused` counted) |
| 2b  | Must-have 2: the policy is declared per class in flags, defaults fail-open, and an invalid value refuses boot naming the variable | ✓ VERIFIED | Code: `SUBSTRATE_BUDGET_<CLASS>_BREAKER` parsed per `ADMISSION_CLASSES` at `packages/mcp-server/src/config.ts:1828`; `breakerPolicyOf` at `config.ts:1849-1853` (blank → `fail-open`; anything but `fail-open`/`fail-closed` throws `ConfigError` naming the variable). `loadAdmissionSettings` is called unguarded from `loadConfig` (`config.ts:1077`, `:1221`), so boot refuses. Registry: `flag-registry.ts:189` (`CLASS_BREAKER_NAMES`), `:219-228` (family pattern and members). Documented: `docs/config-reference.md:270`, `docs/observability.md:173` and `:987`, `.env.example:271-273`. Test: `packages/mcp-server/src/admission.test.ts:372` "an invalid SUBSTRATE_BUDGET_<CLASS>_BREAKER refuses boot and names the variable". Step 7b run: `bun test packages/mcp-server/src/admission.test.ts -t "an invalid SUBSTRATE_BUDGET_<CLASS>_BREAKER refuses boot"` → 1 pass, 0 fail. Default-all-fail-open is asserted at `admission.test.ts:322` (not run) |

**Score:** 4/5 truths verified (2/2 ROADMAP must-haves) (1c behavior-unverified, excluded from `verified_truths` per Step 9)

Must-have status:
- Must-have 1 (brief and recall authoritative with the breaker open, proven by a test): **VERIFIED** as worded, by 1a and 1b. Caveat: under an operator-set `fail-closed` read policy the same requests are refused (503) rather than answered; see Deviations D4 and H-4.
- Must-have 2 (admission under an open breaker follows a declared per-class policy in flags): **VERIFIED** by 2a and 2b.

### Required Artifacts (manual Levels 1-3; no PLAN artifacts list)

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/cache.ts` | Breaker-aware read-through; refused generation bumps | ✓ VERIFIED | Exists; substantive (refusal fallthrough `:568-580`, `bump` `:844-856`, `script` `:1032-1045`); wired (`service.ts:1704` `gate: this.planes.gate("cache")`) |
| `packages/mcp-server/src/admission.ts` | Per-class decision with `refused` | ✓ VERIFIED | Exists; `:379-383` decision branch; `isRefusal` `:414`; `budgetBody` `:447`; wired into `server.ts:908`, `:2647` |
| `packages/mcp-server/src/config.ts` | Parse and refuse boot | ✓ VERIFIED | `loadAdmissionSettings` `:1794`, `breakerPolicyOf` `:1849`; wired via `loadConfig:1221` |
| `packages/mcp-server/src/flag-registry.ts` | Registry family | ✓ VERIFIED | `:189`, `:219-228` |
| `packages/mcp-server/src/server.ts` | 503 with Retry-After | ✓ VERIFIED | `sendBudgetRefusal` `:628-630`; called `:909` and `:2649` |
| `packages/observability/src/instruments.ts` | `refused` decision label | ✓ VERIFIED | `ADMISSION_DECISIONS` includes `refused` at `:179`; `recordAdmission` `:585-587` |
| `packages/observability/src/slo.ts` | SLO excludes refused (R3) | ✓ VERIFIED | `numerator: { where: { decision: "limited" } }` at `:360` |
| `packages/mcp-server/src/cache-breaker.test.ts` | New phase test file | ✓ VERIFIED | 155 lines, 4 tests (`:73`, `:98`, `:117`, `:145`) |
| `packages/mcp-server/src/admission.test.ts`, `http.admission.test.ts`, `observability/src/slo.test.ts` | Policy, flag and HTTP tests | ✓ VERIFIED | Tests enumerated at `admission.test.ts:308-375`, `http.admission.test.ts:233-279`; not run by this verifier |

### Key Link Verification (manual; no PLAN key_links)

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` brief | `cache.ts` getOrLoad | `klass: "brief"` at `service.ts:2128` | ✓ WIRED | Refused read falls to `request.load()` (`cache.ts:575-580`) |
| `service.ts` recall | `cache.ts` getOrLoad | `klass: "memory-search"` at `service.ts:3020` | ✓ WIRED | Load is `recallUncounted` (`service.ts:3208`) |
| `server.ts` REST | `admission.ts` admit | `isRefusal` then `sendBudgetRefusal` at `server.ts:908-909` | ✓ WIRED | 503 for `refused`, 429 for `limited` (`server.ts:628-630`) |
| `admission.ts` | `cache.ts` script | `this.script(...)` → `ScriptOutcome.breakerRetryAfterMs` (`cache.ts:1044`) | ✓ WIRED | |
| `config.ts` loadConfig | `breakerPolicyOf` | `loadAdmissionSettings(env)` at `config.ts:1221` | ✓ WIRED | Unguarded; `ConfigError` aborts boot |

### Data-Flow Trace (Level 4)

Not applicable: the phase's artifacts are server-side request paths reading a real store or a real cache. No rendered UI values. The brief and recall answers come from `index` / Hindsight calls (`service.ts:3042`, `brief-fast-path` and `cache-breaker.test.ts:84-92` show the index value reaching the reply).

### Behavioral Spot-Checks (Step 7b)

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Brief answers from the index with the breaker open (1a) | `bun test packages/mcp-server/src/cache-breaker.test.ts -t "brief is composed from the index on every call"` | 1 pass, 0 fail | ✓ PASS |
| Recall equals the uncached reply with the breaker open (1b) | `bun test packages/mcp-server/src/cache-breaker.test.ts -t "recall returns the same reply as a substrate with no cache"` | 1 pass, 0 fail | ✓ PASS |
| Admission policy per class over an open breaker (2a) | `bun test packages/mcp-server/src/cache-breaker.test.ts -t "admission over the open breaker"` | 1 pass, 0 fail | ✓ PASS |
| Invalid breaker flag refuses boot (2b) | `bun test packages/mcp-server/src/admission.test.ts -t "an invalid SUBSTRATE_BUDGET_<CLASS>_BREAKER refuses boot"` | 1 pass, 0 fail | ✓ PASS |
| Degraded brief with breaker open (1c) | none (no such test exists) | not run | ? SKIP → H-1 |
| Live Dragonfly stop, real 503 | requires a running server and Dragonfly | not run | ? SKIP → human |

Probe execution (Step 7c): SKIPPED. Not a migration or tooling phase; no PLAN, SUMMARY or success criterion mentions probes; no `scripts/*/tests/probe-*.sh` declared.

### Requirements Coverage

No PLAN exists, so no plan `requirements:` field. `.planning/REQUIREMENTS.md` was not checked for Phase 75 IDs; the phase has no declared requirement IDs in ROADMAP.md. Not evaluated beyond this note.

### Anti-Patterns Found

Scan of the added lines (`git diff origin/main...HEAD` on the 11 code files) for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER|placeholder|coming soon|not yet implemented|.skip|.todo|.only`: no matches. No skipped tests in `cache-breaker.test.ts`, `admission.test.ts`, `http.admission.test.ts`, `slo.test.ts`. No debt-marker blockers.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/cache.ts` | 494 | `staleGenerations` is an in-process `Set` (see R1) | ℹ️ Info | Residual, documented in CONTEXT R1 |
| `packages/mcp-server/src/cache.ts` | 402-403 | Cooldown refusal rejects with a plain `Error`, not `BreakerOpenError` (see D2) | ⚠️ Warning | A fail-closed class admits during the connect cooldown while the breaker is closed |

### Decision Coverage

`check.decision-coverage-verify` could not evaluate: the phase directory holds no PLAN or SUMMARY files (`total: null`, `honored: null`, `not_honored: []`). Recorded as not evaluated, not as zero decisions. Status impact: none (warning-only gate).

### Human Verification Required

Items H-1 to H-5 below are the human-verification list. H-1 is the behavior-unverified truth; H-2 to H-4 are the live-only items; H-5 is the policy decision on the cooldown window.

**H-1. Degraded brief with the breaker open (behaviour-unverified, 1c)**
**Test:** Open the cache breaker (`failureThreshold: 1`, or a real plane failure). Make the live source throw (`getGraph`). Call `briefDetailed` for the same repo and graph.
**Expected:** `state` is `degraded`; no `brief-snapshot` text is served; the brief does not throw; the cache answers nothing.
**Why human:** The degraded path has tests only with a healthy or merely failing fake cache, never with an open breaker and a failing live source together. Presence and wiring at `service.ts:2231-2239` do not prove the refused snapshot read degrades cleanly at runtime.

**H-2. Live stop of Dragonfly while brief and recall run**
**Test:** Full stack up, default flags (nothing set). Stop the live Dragonfly. Call `POST /brief` and `POST /memory/recall`.
**Expected:** 200 with authoritative source content; each returns within the command timeout (no hang); cache health reports degraded.
**Why human:** In-process tests use an unreachable port (`cache-breaker.test.ts:17`) or an injected open breaker. A real outage with real sockets, timeouts and a breaker transition is not observed.

**H-3. Live fail-closed 503 with Retry-After**
**Test:** `SUBSTRATE_BUDGETS=enforce`, `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed`. Stop Dragonfly and drive failures until the breaker opens. Call `POST /brief`.
**Expected:** HTTP 503, body `{"error":"cache_unavailable","class":"read","retry_after_s":N}`, `Retry-After: N` as an integer, and one `substrate.admission.decisions{decision="refused"}` increment.
**Why human:** `http.admission.test.ts:264-279` injects a `BreakerOpenError` into a fake redis.

**H-4. Refused-decision metric in the real pipeline; operator acceptance of the fail-closed read policy**
**Test:** (a) Check `/metrics`, the OTel/Greptime export and any dashboard for `substrate.admission.decisions{decision="refused"}` (`instruments.ts:585-587`). Confirm it is outside `admission.limited_rate` (`slo.ts:360`, R3). (b) Confirm the operator accepts that with `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` and the breaker open, `/brief` and `/memory/recall` (class `read`, `admission.ts:174` and `:178`) answer 503 and do not reach the authoritative source.
**Expected:** (a) the series exists with class and surface labels; (b) the operator confirms this is the intended policy.
**Why human:** Delivery to live exporters and dashboards is not in code. The read-policy consequence is a declared decision (D75-2) that a human must accept.

**H-5. Cooldown window for fail-closed classes**
**Test:** Decide whether a fail-closed class may admit during the 5 s connect cooldown (`cache.ts:402-403`) while the breaker is still closed.
**Expected:** Accept it under the CONTEXT rule "a connect error stays bypass in every class", or direct a change.
**Why human:** A judgment about the declared rule. See Deviations D2.

### Deviations and Gaps

**D1. No PLAN and no SUMMARY (deviation, recorded).** `75-CONTEXT.md` is the only phase artifact. The code was committed before a plan existed. No PLAN or SUMMARY was written, per the brief. With no PLAN, the must-haves are the two ROADMAP criteria, and Steps 4 and 5 are not applicable.

**D2. Cooldown refusals are plain `Error`, so a fail-closed class admits during the connect cooldown with the breaker closed (warning; documented-by-implication, not named).**
- Code: `cache.ts:402-403` rejects with `new Error("cache connect cooling down ...")`, not `BreakerOpenError`. The cooldown starts on a failed connect at `cache.ts:373`. `script()` maps it to `{ ok: false }` with no `breakerRetryAfterMs` (`cache.ts:1044`), so `admission.ts:379` does not refuse and `admission.ts:383` records `bypass`. The breaker is not necessarily open here: the connect failure counts once against it, and `failureThreshold` defaults to 5 (`flag-registry.ts:929`).
- CONTEXT: Does not name cooldown refusals. It states "Only a breaker refusal is policed: a timeout, a connect error or a malformed reply stays `bypass` in every class" (75-CONTEXT.md, Flags section). A cooldown refusal is the consequence of a connect error, so the rule reads as deliberate. The name is missing, and the 5 s window is not stated.
- Tests: none. `grep cooldown|cooling` in `*.test.ts` hits only `cache.test.ts:1229-1270`, which does not involve an admission class.
- Classification: not a must-have failure (the breaker is closed in that window, so must-have 2's "open breaker" condition does not hold). Routed to H-5 for a decision.

**D3. The refused-generation-bump residual R1 is in-process only.** `staleGenerations` is a `Set` on the `ReadThroughCache` instance (`cache.ts:494`). It is added on a failed bump (`cache.ts:852`), cleared on a successful one (`cache.ts:849`), and checked before a read (`cache.ts:568`). After a restart, or on another replica, the set is empty and the old generation may be read until the brief TTL (`CACHE_TTL` at `cache.ts:48`, five minutes per CONTEXT). Matches CONTEXT R1. The one-process test is `cache-breaker.test.ts:117`; the rule's test is `cache.test.ts:328` (not run here). Not a must-have failure. Not deferred: the only later phase that mentions cache is Phase 78 ("Cross-layer reconciliation: the ledger, the index and the cache agree"), which is tangential and does not name a durable marker or restart check, so it is not treated as deferral.

**D4. A fail-closed read policy refuses brief and recall rather than answering them (interaction, human decision).** `/brief` and `/memory/recall` are class `read` (`admission.ts:174`, `:178`; `TOOL_CLASSES` `memory_brief`, `memory_recall` at `:227-229`). With `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` in enforce, they return 503 before the source is consulted (`admission.ts:379`, `server.ts:908-909`). This is the declared policy (D75-2), so it is not a defect. It means must-have 1 holds under the default and write/coordination policies, not under a fail-closed read policy. Routed to H-4.

**D5. Stale statement in CONTEXT (documentation drift, not a code defect).** CONTEXT's Flags section says that in `shadow` a fail-closed breaker refusal "records `shadow_limited`". The code, `admission.test.ts:338` ("a breaker refusal of a fail-closed class is a bypass in shadow"), `docs/config-reference.md:270`, `docs/observability.md:173` and `:987`, and ROADMAP all say `bypass`. Commit `c71d4409` made the change. CONTEXT should be corrected by its owner; this verifier did not edit it.

**D6. Degraded brief path has no test with the breaker open (warning).** See 1c and H-1.

**D7. Docs generation not confirmed (not checked).** CONTEXT says `docs/config-reference.md` is hand-rendered and not confirmed against the generator. This verifier did not run a generator check. The rows at `docs/config-reference.md:270` and `:481` are present.

**D8. `.env.example` excluded from the fingerprint (judgment call).** `git diff --name-only origin/main...HEAD` includes `.env.example`. It is configuration, not code, and the brief said to keep code files and drop `.planning` and docs. It was excluded from `covered_files`. If the orchestrator wants it covered, rerun `verification.fingerprint` with it added and update `covered_files` and `covered_digest`.

**D9. Reference files.** All referenced `~/.claude/gsd-core/references/*` files resolved (the path exists and was readable). No reference was missing, so the brief's fallback clause was not needed.

**D10. Prior verification overwritten.** The previous `75-VERIFICATION.md` (frontmatter `verified: 2026-11-01`, no `covered_digest`) was replaced, as the brief directed. Its prior content is not preserved here.

### Gaps Summary

No FAILED truth, no MISSING or STUB artifact, no NOT_WIRED link, no blocker anti-pattern. No `gaps:` block is emitted. Status is `human_needed` by Step 9 rule 2: human verification items exist (H-1 to H-5), so `passed` is not valid. Deferred items: none (see Step 9b note under D3).

---

_Verified: 2026-11-02T02:09:23Z_
_Verifier: Claude (gsd-verifier)_
