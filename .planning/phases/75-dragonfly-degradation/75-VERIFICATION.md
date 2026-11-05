---
phase: 75-dragonfly-degradation
verified: 2026-11-05T00:13:33Z
status: human_needed
score: 7/8 truths verified (2/2 ROADMAP success criteria verified as declared; 1 truth behavior-unverified)
covered_files: ["packages/mcp-server/src/admission.test.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/cache-breaker.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/http.admission.test.ts", "packages/mcp-server/src/live-session-consumer.test-support.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/observability/src/instruments.ts", "packages/observability/src/slo.test.ts", "packages/observability/src/slo.ts"]
covered_digest: "v3:sha256:42c7addcc631227100034efd56f80295802473398c0f19d3c8937f111a4f0180"
behavior_unverified: 1
overrides_applied: 0
overrides: []
behavior_unverified_items:
  - truth: 'Degraded brief with the cache breaker open and the live source failing: the refused snapshot read leaves the brief in state degraded, no brief-snapshot text is served, and the brief does not throw'
    test: 'Open the cache breaker (PlaneRegistry failureThreshold 1), seed a brief-snapshot while the breaker is still closed, open the breaker, make the brief live source throw (getGraph), call briefDetailed for the same repo and graph'
    expected: 'state is degraded; no brief-snapshot text is served; the brief does not throw'
    why_human: 'No test combines an open cache breaker with a failing live source and a stored snapshot. The spec as written (open breaker, no seed) cannot prove the refusal: the snapshot lives in the breaker-gated cache, so it cannot be written while open. See H-1 below. Owner-held test gap, kept open.'
coincidental_reliance_items: []
human_verification:
  - test: 'H-1: Restate and then write the degraded-brief test. Seed a brief-snapshot with the cache breaker closed, open the breaker (PlaneRegistry failureThreshold 1), make the brief live source throw (getGraph), call briefDetailed for the same repo and graph. Extend to SUBSTRATE_BRIEF_RECALL enforced (recall-snapshot leg).'
    expected: 'state is degraded; no brief-snapshot text is served; the cache answers nothing; the brief does not throw'
    why_human: 'Spec conflict, kept open. The owner has not yet restated the spec. The stated setup has no stored snapshot, so a degraded result is produced whether or not the refusal happens (vacuous). The snapshot is in the breaker-gated cache: peek is refused and returns null, and put is refused and returns false while the breaker is open. A valid proof needs a seed written before the breaker opens, which the spec does not describe. Owner must confirm that sequence.'
  - test: 'H-2: With the full stack running and default flags (nothing set), stop the live Dragonfly, then call POST /brief and POST /memory/recall'
    expected: 'Both answer 200 with authoritative source content; each returns within the command timeout (no hang); cache health reports degraded'
    why_human: 'In-process tests inject an open breaker or use an unreachable port (cache-breaker.test.ts openCache). A real outage with real sockets, timeouts and breaker transition is not observed. Operator live proof, kept open.'
  - test: 'H-3: Set SUBSTRATE_BUDGETS=enforce and SUBSTRATE_BUDGET_READ_BREAKER=fail-closed. Stop the live Dragonfly, drive connect failures to open the breaker, then call POST /brief'
    expected: 'HTTP 503, body {"error":"cache_unavailable","class":"read","retry_after_s":N}, Retry-After equal to N as an integer, and one substrate.admission.decisions{decision="refused"} increment. Requests in the first 5 s of each open cycle are admitted as bypass (open decision O2)'
    why_human: 'http.admission.test.ts "an open cache breaker is a bypass ... and a 503" injects a breaker-open outcome. The real breaker opening and closing under a live Dragonfly is not observed. Operator live proof, kept open.'
  - test: 'H-4: (a) Check /metrics, the OTel/Greptime export and any dashboard for substrate.admission.decisions{decision="refused"}; (b) operator confirms the fail-closed read policy (open decision O1)'
    expected: '(a) the refused series exists with surface and class labels and is outside the admission limited-rate numerator (slo.ts:360); (b) the operator accepts that with SUBSTRATE_BUDGET_READ_BREAKER=fail-closed and the breaker open, /brief and /memory/recall answer 503 before the authoritative source is consulted'
    why_human: 'Delivery to live exporters and dashboards is not in code (operator live proof). The read-policy consequence is a declared decision (CONTEXT D75-2) that a human must accept. Owner item O1, kept open.'
  - test: 'H-5: Decide the connect-cooldown window for fail-closed classes (open decision O2; CACHE_CONNECT_COOLDOWN_MS, cache.ts:250; owner decision kept NOT FIXED)'
    expected: 'Either accept that a fail-closed class admits as bypass during the 5 s connect cooldown, including the first 5 s of each open cycle that a connect failure starts, or direct a change'
    why_human: 'A judgment about the declared rule (a connect error stays bypass in every class), not a defect a grep or a targeted test can settle. Owner item O2, kept open.'
---

# Phase 75: DragonflyDB degradation Verification Report

**Phase Goal:** When the cache plane is open or unreachable, reads fall back to the authoritative store without losing state, and admission behaves as declared.
**Verified:** 2026-11-05T00:13:33Z
**Status:** human_needed
**Re-verification:** No. Initial-mode pass at HEAD `c40ffc9a` (the prior record at HEAD `504da465`, digest `bc5c793f...`, carried no `gaps:` block, so Step 0 routes to initial mode). This file is overwritten in the worktree only; nothing is committed.

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `c40ffc9a`.
- Must-haves: the two ROADMAP phase 75 success criteria (`.planning/ROADMAP.md:1298-1312`), verbatim:
  1. With the cache breaker open, brief and recall return authoritative results. A test proves it.
  2. Admission under an open breaker follows a declared policy per class (fail open or closed), set in flags.
- No PLAN.md or SUMMARY.md exists in the phase directory (only `75-CONTEXT.md` and the prior `75-VERIFICATION.md`). Step 4 `verify.artifacts` and Step 5 `verify.key-links` therefore return NO_INPUT; Levels 1-3 and the links were checked by hand below.
- Requirement: HARD-R2 (`.planning/REQUIREMENTS.md:119`, unchecked `[ ]`, mapped to phase 75).
- Covered-file fingerprint: `node /root/.agents/gsd-core/bin/gsd-tools.cjs query verification.fingerprint .planning/phases/75-dragonfly-degradation <13 covered files>` run at `c40ffc9a`. The covered list is the one in the prior record (the 13 files are unchanged in name); `covered_files` and `covered_digest` above are copied verbatim from that command's output.
- Postgres: none. Phase 75 has no Postgres-gated files. `SUBSTRATE_TEST_PG_URL` is absent from all five covered test files (`admission.test.ts`, `cache-breaker.test.ts`, `http.admission.test.ts`, `live-session-consumer.test-support.ts`, `slo.test.ts`), so no PG run was made. No scratch database was used.
- Commands run: two non-PG targeted `bun test` commands (below). Not run: full suite, `tsc`, lint, formatters.

### Drift since the `504da465` record

`git diff 504da465 c40ffc9a` touches three covered files; the other ten are byte-identical.

- `config.ts` (2 lines, comment only): the docs-plane SLO doc comment now names `SUBSTRATE_DOCS_SLO_SYNC_LAG_S`. Line numbers unchanged. Admission settings (`loadAdmissionSettings` `:1874`, `breakerPolicyOf` `:1929`) untouched.
- `flag-registry.ts` (5 lines): adds the `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` row (docs plane) and a `SUBSTRATE_WORKTREE_ROOTS` text update (dispatcher reads it). The `SUBSTRATE_BUDGET_<CLASS>_BREAKER` family (`:189`, `:219-228`) is unchanged.
- `service.ts` (7 lines): `emit` (`:2961`) now calls `corpusSlo.recordSyncLag` on a stored `docs.sync`; `searchDocsUnmeasured` (`:6396`, `:6422`) passes an `isPrivate` flag to `recordRetrieval`. Neither is on the brief path (`briefDetailed` `:2462`, snapshot peek `:2678`), the recall path (`recallMemories` `:3737`, `recallFanout` `:2772`), admission (`server.ts:978`, `:2758`) or the breaker. Re-audited: no effect on truths 1 to 8.

Wave-6 commits outside the covered list (`ebabe6ef` index-archive, `63`/`65`/`66`/`68`/`70` corpus, dashboards, `docs/*`) do not touch any covered file. Carried forward; not re-audited.

### Context drift found (Info, not a gap)

- `75-CONTEXT.md` line 23 says that in `shadow`, a `fail-closed` breaker refusal records `shadow_limited`. The code does not: commit `c71d4409` (`fix(admission): a fail-closed refusal in shadow is a bypass, not a shadow refusal`) changed it. `admission.ts:386` returns `refused` only in `enforce` and otherwise falls through to `bypass`. `admission.test.ts:341` asserts the new behaviour. The code and tests are correct; CONTEXT is stale. CONTEXT was not edited.
- CONTEXT line anchors are stale. `loadAdmissionSettings` is `config.ts:1874` (CONTEXT said 1794) and `breakerPolicyOf` is `config.ts:1929` (CONTEXT said 1849).
- `ROADMAP.md:1298-1312` still reads "5 of 6 truths verified". Not edited; it belongs to the orchestrator.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1 (brief): with the cache breaker open, brief is answered from the index on every call and the cache never answers | ✓ VERIFIED | `cache-breaker.test.ts:73` passes (targeted run T1). With the breaker open, `getOrLoad` reads generations through the gated redis, the refusal is caught (`cache.ts` getOrLoad catch, `:586-588`), and `load()` (the live compose) runs. The test asserts the index is read each call. |
| 2 | SC1 (recall): with the cache breaker open, recall returns the same reply as a substrate with no cache | ✓ VERIFIED | `cache-breaker.test.ts:98` passes (T1). |
| 3 | Generation keys: a bump the breaker refused keeps reads on the source after it closes, until a bump lands | ✓ VERIFIED | `cache-breaker.test.ts:117` passes (T1). State-transition invariant, so the named test is the evidence. Code: `bump` (`cache.ts:852`) adds the key to `staleGenerations` on failure (`:857-860`); `getOrLoad` bypasses any such key (`:576`); only a successful bump clears it. Residual R1 below. |
| 4 | Degraded brief: with the cache breaker open and the live source failing, state is `degraded`, no brief-snapshot text is served, and the brief does not throw | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Code present and wired: the snapshot read is `this.cache.peek("brief-snapshot", ...)` (`service.ts:2678`); a refused read returns null (`cache.ts` peek catch, `:912-935`), so `snapshot === null` and the brief is `servedBrief(..., "degraded", ...)` (`service.ts:2680-2684`). No test exercises an open breaker together with a failing source and a stored snapshot. Adjacent evidence only: `service-forget.test.ts` "a mark that cannot be read refuses the snapshot: the brief is degraded" passes (targeted run T2), but it refuses the snapshot through an unreadable forget mark with the breaker closed, so it does not discharge this truth. H-1 stays open (see Human Verification). Not counted in `verified_truths`. |
| 5 | SC2: per class, a fail-closed admission class is refused in `enforce` (503 `cache_unavailable`, `Retry-After`), a fail-open class admits as `bypass`, and neither reaches the plane. With no flag set every class is fail-open (default unchanged, D75-1) | ✓ VERIFIED | `admission.test.ts:325` (default all fail-open), `:334` (fail-closed refused in enforce, others fail-open), `cache-breaker.test.ts:145` (refused fail-closed, admitted fail-open, neither reaches the plane, no breaker failure recorded for the refusals), `http.admission.test.ts` "when the cache cannot answer" (`:274`: fail-open 200 as bypass, fail-closed 503 with an integer `Retry-After`). All pass in T1. Enforcement: `server.ts:978` (REST `admission.admit`), `server.ts:2758` (MCP `admitBatch`), `sendBudgetRefusal` (`server.ts:633`) renders 429 or 503. |
| 6 | A breaker refusal of a fail-closed class is a `bypass` in `shadow` and a `refused` in `enforce` | ✓ VERIFIED | `admission.test.ts:341` passes (T1). Code: `admission.ts:386` breaker-refusal branch (`enforce` only), commit `c71d4409`. See the CONTEXT drift note. |
| 7 | Only a breaker refusal is policed: another cache failure (timeout, connect error, malformed reply) stays `bypass` in a fail-closed class | ✓ VERIFIED | `admission.test.ts:350` and `:243` pass (T1). `outcome.breakerRetryAfterMs` gates the refusal branch in `admission.ts:386`. |
| 8 | Flags: `SUBSTRATE_BUDGET_<CLASS>_BREAKER` parses trimmed and case-insensitively, blank is `fail-open`, and any other value refuses boot with a `ConfigError` naming the variable | ✓ VERIFIED | `admission.test.ts:365` and `:375` pass (T1). `loadConfig` throws `ConfigError` (`admission.test.ts:378`). Code: `loadAdmissionSettings` (`config.ts:1874`) calls `breakerPolicyOf` (`config.ts:1909`, `:1929-1933`), which throws `ConfigError` naming the variable. Registry members: `flag-registry.ts:189`, `:219-228`. |

**Score:** 7/8 truths verified (1 present, behavior unverified: truth 4)

### Deferred Items

None. Step 9b found no gaps to defer.

### Advisory (New Scope, Unevidenced)

Not applicable: this is an initial-mode pass.

### Required Artifacts (manual Levels 1-3; no PLAN `must_haves.artifacts`)

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/admission.ts` | admission decision, breaker policy | ✓ VERIFIED | Unchanged since `504da465`. `admit` decision branch substantive (`:386`); wired via `server.ts:978` and `:2758`. |
| `packages/mcp-server/src/cache.ts` | gated read-through, stale generations, peek/put | ✓ VERIFIED | Unchanged since `504da465`. `getOrLoad` (`:576`), `bump` (`:852`), `peek` (`:912`), `peekQuiet` (`:943`), `writeKey` (`:1011`), connect cooldown (`:250`); wired through `bunRedis` (`:341`). |
| `packages/mcp-server/src/config.ts` | `loadAdmissionSettings`, `breakerPolicyOf` | ✓ VERIFIED | Substantive: `:1874`, `:1929-1933`; called from `loadConfig` (`:1909`). Only a comment changed since `504da465`. |
| `packages/mcp-server/src/flag-registry.ts` | `SUBSTRATE_BUDGET_<CLASS>_BREAKER` family | ✓ VERIFIED | `:189`, `:219-228`. Documented members match `ADMISSION_CLASSES`. New `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` row is outside this phase. |
| `packages/observability/src/instruments.ts` | `ADMISSION_CLASSES` | ✓ VERIFIED | `:170`. Unchanged. |
| `packages/observability/src/slo.ts` | numerator excludes `refused` | ✓ VERIFIED | `:360`, numerator is `decision: "limited"`. Unchanged. |
| `packages/mcp-server/src/service.ts` | cache gate construction, brief snapshot read | ✓ VERIFIED | `:1935` `gate: this.planes.gate("cache")`; brief snapshot peek `:2678`. Wave-6 hunks at `:2961` and `:6396` are outside the brief and recall paths. |

### Key Link Verification (manual)

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts:1935` | `cache.ts:341` `bunRedis` → `breaker.ts:215` `callPlane` | `planes.gate("cache")` | ✓ WIRED | Every cache command is refused before `fn` runs when the breaker is open. |
| `service.ts:2678` | `cache.ts:912` `peek` | `brief-snapshot` read | ✓ WIRED | A refused read returns null, so the brief goes `degraded`. A forget-mark guard (`snapshotSurvivesForget`) also refuses the snapshot; it is a separate path. |
| `server.ts:978` / `:2758` | `admission.ts` `admit` / `admitBatch` | per-request and batch admission | ✓ WIRED | `sendBudgetRefusal` (`server.ts:633`) renders 429 or 503. |
| `config.ts:1909` | `config.ts:1929` `breakerPolicyOf` | `loadAdmissionSettings` ← `loadConfig` | ✓ WIRED | A bad value throws `ConfigError` and refuses boot. |

### Data-Flow Trace (Level 4)

Not applicable to these artifacts. The brief answer under an open breaker is the index composition, which `cache-breaker.test.ts:73` asserts by counting index reads on every call. No static fallback is involved.

### Behavioral Spot-Checks

Targeted run T1, one command (non-PG, `SUBSTRATE_TEST_PG_URL` unset):

`cd /root/src/worktrees/as-gsd-v18-all && env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/cache-breaker.test.ts packages/mcp-server/src/admission.test.ts packages/mcp-server/src/http.admission.test.ts packages/observability/src/slo.test.ts`

Result: **158 pass, 0 fail, 3044 expect() calls, 4 files, 1.02 s.** The stderr lines (`ENOTDIR` on `substrate-live-policy-*/file/audit.jsonl`, `cache bypass: cache off`) come from live-session denial tests that deliberately break the audit path. All tests passed.

Targeted run T2, one command (adjacent evidence for truth 4, not counted):

`env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/service-forget.test.ts -t "a mark that cannot be read refuses the snapshot"`

Result: **1 pass, 0 fail, 148 filtered out, 5 expect() calls.**

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| T1 brief answered by index, cache never answers | T1, `cache-breaker.test.ts:73` | pass | ✓ PASS |
| T2 recall equals uncached reply | T1, `:98` | pass | ✓ PASS |
| T3 refused bump keeps reads on source until a bump lands | T1, `:117` | pass | ✓ PASS |
| T4 degraded brief, open breaker plus failing source | no test exists; adjacent T2 (forget-mark refusal, breaker closed) passes | not run for this spec | ? SKIP (H-1) |
| T5 fail-closed refused, fail-open admits, default fail-open | T1, `admission.test.ts:325,:334`, `cache-breaker.test.ts:145`, `http.admission.test.ts:274` | pass | ✓ PASS |
| T6 shadow bypass / enforce refusal | T1, `admission.test.ts:341` | pass | ✓ PASS |
| T7 only a breaker refusal is policed | T1, `admission.test.ts:350` | pass | ✓ PASS |
| T8 flag parse and boot refusal | T1, `admission.test.ts:365,:375` | pass | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` exists, and the phase declares none. It is not a migration or tooling phase. Not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R2 | none (no PLAN.md exists) | Reuse the cache-plane breaker and bounded timeouts; on outage, reads fall back to the documented source or report degradation; writes that cannot be made durable are rejected with retryable errors; no authoritative state lives only in the cache | ? NEEDS HUMAN / ORPHANED | The read-fallback clause is evidenced by T1 to T3 and T5. The write clause ("reject writes that cannot be made durable with retryable errors") is outside the two ROADMAP criteria and no test covers it. No plan claims HARD-R2 (Step 6c). The requirement stays `[ ]`. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (covered non-test files) | - | `TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER` | - | None found in the covered non-test files. No debt-marker gate triggered. |
| `75-CONTEXT.md` | 23 | stale statement (`shadow_limited` for a breaker refusal) | ℹ️ Info | Documentation drift only. Code and tests are correct. |
| `75-CONTEXT.md` | anchors | stale line numbers (`config.ts:1794`, `:1849`) | ℹ️ Info | Documentation drift only. |

### Human Verification Required

**H-1 is kept open. The spec conflicts with the code; the owner has not yet restated it.** Reasons:

1. The stated setup (`openCache()`: `PlaneRegistry` with `failureThreshold 1` and `bunRedis(UNREACHABLE)`) has no store. No snapshot exists to be refused, so a `degraded` outcome occurs whether or not the refusal path is taken. As written, the assertion "no brief-snapshot text is served" cannot distinguish the refusal from absence.
2. The snapshot is in the breaker-gated cache. With the breaker open, `peek` is refused and returns null (`cache.ts:912-935`), and `writeKey` is refused and returns false (`cache.ts:1011-1027`). So a snapshot cannot be written after the breaker opens. A valid proof needs a seed written while the breaker is closed (`GatedMapRedis`, `cache-breaker.test.ts:29`, supports `set`), then the breaker opened, then the source throws. The spec does not describe that sequence.
3. The code's outcome matches the spec's expected state (`service.ts:2678-2684`). The residual is the missing proof, not a different branch. Writing the test needs the owner to confirm the seed-then-open sequence and whether the recall-snapshot leg is in scope. No test was written in this pass (no code edits).

**H-2 to H-5:** as listed in the frontmatter. Operator live proofs (H-2, H-3, H-4a) and owner decisions (H-4b = O1, H-5 = O2) remain open. STATE.md rows: `75 | O1`, `75 | O2`, `75 | H-1`, `75 | Live Dragonfly runs`.

### Gaps Summary

No FAILED truth, no MISSING or STUB artifact, no NOT_WIRED link, no blocker anti-pattern. No `gaps:` block is emitted. Status is `human_needed` by Step 9 rule 2: human items exist, and truth 4 is present but behavior-unverified. `passed` is not valid.

Residual risk R1, from CONTEXT and unchanged: `staleGenerations` lives in the writing process. After a restart or on another replica, a generation key can still hold its old value, and a brief written before the write can be served until its TTL (`CACHE_TTL["brief"]`, 5 minutes). The tests cover one process only. This is a follow-up, not a gap of this phase.

---

_Verified: 2026-11-05T00:13:33Z_
_Verifier: Claude (gsd-verifier)_
