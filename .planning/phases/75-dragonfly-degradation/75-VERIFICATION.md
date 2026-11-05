---
phase: 75-dragonfly-degradation
verified: 2026-11-05T07:12:19Z
status: human_needed
score: 8/8 truths verified (2/2 ROADMAP success criteria verified as declared; live proofs H-2, H-3, H-4a and owner items H-4b (O1), H-5 (O2) remain; HARD-R2 unowned)
covered_files: ["packages/mcp-server/src/admission.test.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/cache-breaker.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/http.admission.test.ts", "packages/mcp-server/src/live-session-consumer.test-support.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/observability/src/instruments.ts", "packages/observability/src/slo.test.ts", "packages/observability/src/slo.ts"]
covered_digest: "v3:sha256:d0472d76141b59a92b5fda40c0db09a0427efe2025c1306e1320d25ef1c87c04"
behavior_unverified: 0
overrides_applied: 0
overrides: []
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: 'H-2: With the full stack running and default flags (nothing set), stop the live Dragonfly, then call POST /brief and POST /memory/recall'
    expected: 'Both answer 200 with authoritative source content; each returns within the command timeout (no hang); cache health reports degraded'
    why_human: 'In-process tests inject an open breaker or use an unreachable port (cache-breaker.test.ts openCache, closedGate). A real outage with real sockets, timeouts and breaker transition is not observed. Operator live proof, kept open.'
  - test: 'H-3: Set SUBSTRATE_BUDGETS=enforce and SUBSTRATE_BUDGET_READ_BREAKER=fail-closed. Stop the live Dragonfly, drive connect failures to open the breaker, then call POST /brief'
    expected: 'HTTP 503, body {"error":"cache_unavailable","class":"read","retry_after_s":N}, Retry-After equal to N as an integer, and one substrate.admission.decisions{decision="refused"} increment. Requests in the first 5 s of each open cycle are admitted as bypass (open decision O2)'
    why_human: 'http.admission.test.ts "an open cache breaker is a bypass for a fail-open class and a 503 for a fail-closed one" (:274) injects a breaker-open outcome. The real breaker opening and closing under a live Dragonfly is not observed. Operator live proof, kept open.'
  - test: 'H-4: (a) Check /metrics, the OTel/Greptime export and any dashboard for substrate.admission.decisions{decision="refused"}; (b) operator confirms the fail-closed read policy (open decision O1)'
    expected: '(a) the refused series exists with surface and class labels and is outside the admission limited-rate numerator (slo.ts:360); (b) the operator accepts that with SUBSTRATE_BUDGET_READ_BREAKER=fail-closed and the breaker open, /brief and /memory/recall answer 503 before the authoritative source is consulted'
    why_human: 'Delivery to live exporters and dashboards is not in code (operator live proof, H-4a). The read-policy consequence is a declared decision (CONTEXT D75-2) that a human must accept (H-4b, owner item O1). Kept open.'
  - test: 'H-5: Decide the connect-cooldown window for fail-closed classes (open decision O2; CACHE_CONNECT_COOLDOWN_MS, cache.ts:250; owner decision kept NOT FIXED)'
    expected: 'Either accept that a fail-closed class admits as bypass during the 5 s connect cooldown, including the first 5 s of each open cycle that a connect failure starts, or direct a change'
    why_human: 'A judgment about the declared rule (a connect error stays bypass in every class), not a defect a grep or a targeted test can settle. Owner item O2, kept open.'
---

# Phase 75: DragonflyDB degradation Verification Report

**Phase Goal:** When the cache plane is open or unreachable, reads fall back to the authoritative store without losing state, and admission behaves as declared.
**Verified:** 2026-11-05T07:12:19Z
**Status:** human_needed
**Re-verification:** Yes. Prior record at HEAD `ca9d02ec` (covered digest `v3:sha256:f3e885d1...`) is stale by digest because the H-1 change (commits `9e6fa1f2`, `9c86ffab`, `e185cd8a`, `42e3cf13`) touched covered files. Audit scoped to `git diff ca9d02ec..HEAD` (equivalently `835a2742..HEAD` for covered files; the two agree). Overwritten in the worktree only; nothing committed.

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `42e3cf13`. Worktree clean for this phase (peer edits to other phases' records are not part of this record).
- Must-haves: the two ROADMAP phase 75 success criteria (`.planning/ROADMAP.md:1298-1312`):
  1. With the cache breaker open, brief and recall return authoritative results. A test proves it.
  2. Admission under an open breaker follows a declared policy per class (fail open or closed), set in flags.
- No PLAN.md or SUMMARY.md exists in the phase directory (`75-CONTEXT.md`, `75-VERIFICATION.md`). Step 4/5 artifact and link checks are manual, below.
- Requirement: HARD-R2 (`.planning/REQUIREMENTS.md:119`, unchecked `[ ]`, mapped to phase 75). Unowned.
- Covered-file fingerprint: `node /root/.agents/gsd-core/bin/gsd-tools.cjs query verification.fingerprint .planning/phases/75-dragonfly-degradation <13 covered files>` run at `42e3cf13`. `covered_files` and `covered_digest` above are copied verbatim from that output (digest changed from `f3e885d1` because `cache.ts`, `service.ts`, `flag-registry.ts`, `cache-breaker.test.ts` changed).
- Postgres: none. No Postgres-gated file in phase 75. `SUBSTRATE_TEST_PG_URL` is absent from the five covered test files and from `service-forget.test.ts` (grep, exit 1). No PG run was made; no scratch-database counts to cite.
- Commands run (non-PG targeted only, two `bun test` commands, `env -u SUBSTRATE_TEST_PG_URL`, `TMPDIR=/root/src/worktrees/backups/gate-tmpfs`): T1 and T2 below. Plus read-only `git diff`/`git show`, grep, and the fingerprint query. Not run: full suite, `tsc`, lint, formatters, any edit or commit.

### Drift since the `ca9d02ec` record

`git diff ca9d02ec..HEAD` touches four covered files and no others (the other nine covered files are byte-identical since `ca9d02ec`: `admission.test.ts`, `admission.ts`, `config.ts`, `http.admission.test.ts`, `live-session-consumer.test-support.ts`, `server.ts`, `instruments.ts`, `slo.test.ts`, `slo.ts`).

- `cache.ts` (+8 net, hunk at `:881`): `snapshotSurvivesForget` (`:911`) is now a wrapper over the new `forgetVerdict` (`:889`, returns `clear | forgotten | unreadable`). Boolean behaviour of `snapshotSurvivesForget` is unchanged (true only for `clear`). Lines before `:881` are unchanged (so `bunRedis :341`, `CACHE_CONNECT_COOLDOWN_MS :250`, `getOrLoad :545/:576/:586-588`, `bump :852`, `markForget :870` keep their anchors). Lines after `:881` shift by +8 (`peek` now `:920`, `peekQuiet` `:951`, `writeKey` `:1019`).
- `service.ts` (+53/-8): imports `snapshotKey`; `MAX_IN_PROCESS_BRIEF_SNAPSHOTS = 256` (`:543`); fields `briefLastGood` and `briefForgottenAtMs` (`:1643-1648`); `rememberLastGood` (`:2499`); `inProcessLastGood` (`:2517`, async); `briefUncounted` writes `rememberLastGood` before `cache.put` (`:2595-2596`); the degraded path consults `inProcessLastGood` only when `peek` returned null (`:2721-2726`); `memoryForget` sets `briefForgottenAtMs = Date.now()` when `touched` (`:4545`). The `corpusFreshness` hunk from the earlier drift is now at `:7528-7540` (not re-audited here, not on the brief/recall/admission/breaker paths; carried forward as before).
- `flag-registry.ts` (1 line, same line count): the `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` row (`:632`) text now describes the in-process last-good window. The `SUBSTRATE_BUDGET_<CLASS>_BREAKER` family (`:189`, `:219-228`) is unchanged.
- `cache-breaker.test.ts` (+89 at end, imports changed in place): four new tests at `:181`, `:199`, `:217`, `:229`. Existing tests at `:73`, `:98`, `:117`, `:145` unchanged.
- Outside the covered list (not in the 13-file digest): `service-forget.test.ts` (new test `:688`), `docs/observability.md` (+2 lines), `docs/config-reference.md` (regenerated row). Audited below as part of truth 4.

Wave-7 and later commits outside the covered list (other phases' records, planning docs) do not touch any covered file. Carried forward; not re-audited.

### Context drift (Info, not a gap)

- `75-CONTEXT.md` line 23 says that in `shadow`, a `fail-closed` breaker refusal records `shadow_limited`. The code does not: commit `c71d4409` changed it. `admission.ts:386` returns `refused` only in `enforce` and otherwise falls through to `bypass`. `admission.test.ts:341` asserts the new behaviour. Code and tests are correct; CONTEXT is stale. CONTEXT not edited.
- CONTEXT line 46 (R2) and 35 anchors are stale: `loadAdmissionSettings` is `config.ts:1874`, `breakerPolicyOf` `config.ts:1929`. CONTEXT's `config.ts:1849`/`:1794` are wrong.
- CONTEXT D75-4 / Residual R1 (cross-process generation staleness) is unchanged by this phase's H-1 work.
- `docs/config-reference.md` row for `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` reads "...at once.. See `docs/observability.md`" (double period: the flag text ends in `.` and the row renderer appends `. See`). Cosmetic. Not edited (no edits in this pass).
- `ROADMAP.md:1298-1312` still reads "5 of 6 truths verified". Not edited; orchestrator's file.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1 (brief): with the cache breaker open, brief is answered from the index on every call and the cache never answers | ✓ VERIFIED | `cache-breaker.test.ts:73` passes (T1). Unchanged test; code path `getOrLoad` (`cache.ts:545`, gated reads, catch `:586-588`) and live `load()` unchanged since `ca9d02ec`. Carried forward, re-run at `42e3cf13`. |
| 2 | SC1 (recall): with the cache breaker open, recall returns the same reply as a substrate with no cache | ✓ VERIFIED | `cache-breaker.test.ts:98` passes (T1). Carried forward. Recall path (`recallMemories` `service.ts:3781`, `recallUncounted` `:3809`) is not in the H-1 diff. |
| 3 | Generation keys: a bump the breaker refused keeps reads on the source after it closes, until a bump lands | ✓ VERIFIED | `cache-breaker.test.ts:117` passes (T1). Code: `bump` (`cache.ts:852`) adds the key to `staleGenerations` on failure (`:857-860`); `getOrLoad` bypasses it (`:576`). Unchanged. Residual R1. |
| 4 | Degraded brief, H-1 (owner decision 2026-11-05): with the cache breaker open and the live source failing, (a) if this process holds a last-good brief for the arguments that is inside the window and not forgotten, it is served as state `snapshot`, with a header naming the failed sources and the body equal to the complete brief; (b) otherwise state is `degraded`, no snapshot text is served, and the brief does not throw. A readable forget mark, an answering cache with no snapshot, or a mark read that fails while the breaker is closed refuses the copy. | ✓ VERIFIED | (a) `cache-breaker.test.ts:181` (breaker opened, `getGraph` throws: `state` `snapshot`, `failed` `["graph"]`, header line and body checked). (b) `cache-breaker.test.ts:199` (window elapsed, breaker open, source down: `degraded`, `snapshotAt` null, no throw). (c) `cache-breaker.test.ts:217` (cache readable, key absent: copy not served). (d) `cache-breaker.test.ts:229` (cache readable, a forget mark newer than the brief: copy refused). (e) `cache-breaker.test.ts:242` (the mark read fails with the breaker closed: copy refused, state `degraded`). (f) `service-forget.test.ts:688` (a forget that deletes a plane document refuses the in-process copy while the breaker is open; with the forget clause removed for one run on 2026-11-05 this test failed with Expected `degraded`, Received `snapshot`, and the clause was restored). Code: `briefUncounted` (degraded branch), `inProcessLastGood`, `memoryForget`, and `ReadThroughCache.forgetVerdict` in `cache.ts` (only `BreakerOpenError` is `unreadable`). Owner note: the earlier restated expectation "no brief-snapshot text is served" is superseded for case (a) by the in-force decision that the in-process copy serves while the cache cannot be read. Case (b) keeps that expectation. |
| 5 | SC2: per class, a fail-closed admission class is refused in `enforce` (503 `cache_unavailable`, `Retry-After`), a fail-open class admits as `bypass`, and neither reaches the plane. With no flag set every class is fail-open (D75-1) | ✓ VERIFIED | `admission.test.ts:325` (default all fail-open), `:334` (fail-closed refused in enforce, others fail-open), `cache-breaker.test.ts:145` (refused fail-closed, admitted fail-open, neither reaches the plane, no breaker failure for the refusals), `http.admission.test.ts:274` (fail-open 200 as bypass, fail-closed 503 with integer `Retry-After`). All pass in T1. Enforcement: `server.ts:978` (REST `admission.admit`), `server.ts:2758` (MCP `admitBatch`), `sendBudgetRefusal` `server.ts:633`. Unchanged files. |
| 6 | A breaker refusal of a fail-closed class is a `bypass` in `shadow` and a `refused` in `enforce` | ✓ VERIFIED | `admission.test.ts:341` passes (T1). Code: `admission.ts:386-390` (breaker-refusal branch, `enforce` only). Commit `c71d4409`. See CONTEXT drift note. |
| 7 | Only a breaker refusal is policed: another cache failure (timeout, connect error, malformed reply) stays `bypass` in a fail-closed class | ✓ VERIFIED | `admission.test.ts:350` and `:243` pass (T1). `outcome.breakerRetryAfterMs` gates the refusal branch (`admission.ts:386`). |
| 8 | Flags: `SUBSTRATE_BUDGET_<CLASS>_BREAKER` parses trimmed and case-insensitively, blank is `fail-open`, and any other value refuses boot with a `ConfigError` naming the variable | ✓ VERIFIED | `admission.test.ts:365` and `:375` pass (T1); `:378` asserts `loadConfig` throws. Code: `loadAdmissionSettings` (`config.ts:1874`) calls `breakerPolicyOf` (`config.ts:1909`), which throws at `:1933`. Registry: `flag-registry.ts:189`, `:219-228`. Unchanged files. |

**Score:** 8/8 truths verified. Truth 4 moved from PRESENT_BEHAVIOR_UNVERIFIED to VERIFIED under the owner-decided H-1 form (case (a) and case (b) both have a passing test).

### Deferred Items

None. No gaps found, so nothing deferred.

### Required Artifacts (manual Levels 1-3)

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/admission.ts` | admission decision, breaker policy | ✓ VERIFIED | Unchanged since `ca9d02ec`. Decision branch `:386-390`; wired `server.ts:978`, `:2758`. |
| `packages/mcp-server/src/cache.ts` | gated read-through, stale generations, peek/put, forget verdict | ✓ VERIFIED | Changed (H-1). `forgetVerdict` `:889`, `snapshotSurvivesForget` `:911` (boolean kept), `getOrLoad` `:545`, `bump` `:852`, `markForget` `:870`, `peek` `:920`, `peekQuiet` `:951`, `writeKey` `:1019`, `snapshotKey` `:299`, `bunRedis` `:341`, connect cooldown `:250`. |
| `packages/mcp-server/src/config.ts` | `loadAdmissionSettings`, `breakerPolicyOf` | ✓ VERIFIED | Unchanged. `:1874`, `:1909`, `:1929-1933`. |
| `packages/mcp-server/src/flag-registry.ts` | `SUBSTRATE_BUDGET_<CLASS>_BREAKER` family; snapshot TTL row | ✓ VERIFIED | Family `:189`, `:219-228` unchanged. Snapshot TTL row `:632` text changed (in-process window). `flag-registry.test.ts` and `scripts/config-reference.test.ts` pass (T2). |
| `packages/observability/src/instruments.ts` | `ADMISSION_CLASSES` | ✓ VERIFIED | `:170`. Unchanged. |
| `packages/observability/src/slo.ts` | numerator excludes `refused` | ✓ VERIFIED | `:360`, numerator `decision: "limited"`. Unchanged. |
| `packages/mcp-server/src/service.ts` | in-process last-good brief, cache gate, brief snapshot read | ✓ VERIFIED | Changed (H-1). Gate `:1945` `planes.gate("cache")`; fields `:1643-1648`; `rememberLastGood` `:2499`; `inProcessLastGood` `:2517`; `briefDetailed` `:2472`; snapshot peek `:2720-2721`; forget stamp `:4545`. |
| `packages/mcp-server/src/service-forget.test.ts` (outside digest) | forget refuses the in-process copy | ✓ VERIFIED | New test `:688`; file passes 150/150 in T1. |

### Key Link Verification (manual)

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts:1945` | `cache.ts:341` `bunRedis` → `breaker.ts` `callPlane` | `planes.gate("cache")` | ✓ WIRED | Every cache command is refused before `fn` runs when the breaker is open. |
| `service.ts:2720-2721` | `cache.ts:920` `peek` | `brief-snapshot` read | ✓ WIRED | A refused read returns null, so the in-process copy path is taken. A readable cache's verdict (`snapshotSurvivesForget`, `forgetVerdict`) decides when the snapshot exists. |
| `service.ts:2517` `inProcessLastGood` | `cache.ts:889` `forgetVerdict` | `=== "unreadable"` | ✓ WIRED | The copy is served only when the verdict is `unreadable`. `clear` and `forgotten` refuse it. |
| `service.ts:2595-2596` | `service.ts:2499` `rememberLastGood` | written before `cache.put` | ✓ WIRED | Written whatever the breaker says; gated by window > 0 and cache enabled. |
| `service.ts:4545` | `service.ts:2524` | `briefForgottenAtMs` | ✓ WIRED | A copy saved at or before this process's last forget is not served. Set only when `touched`. |
| `server.ts:978` / `:2758` | `admission.ts` `admit` / `admitBatch` | per-request and batch admission | ✓ WIRED | `sendBudgetRefusal` (`server.ts:633`) renders 429 or 503. |
| `config.ts:1909` | `config.ts:1929` `breakerPolicyOf` | `loadAdmissionSettings` ← `loadConfig` | ✓ WIRED | A bad value throws `ConfigError` and refuses boot. |

### Data-Flow Trace (Level 4)

Not applicable to admission. For the brief under an open breaker, the answer is the index composition (cases in truth 1) or the in-process last-good text (truth 4a). Both are asserted by the tests above; no static fallback is involved beyond the process-local copy, which is a bounded map (`MAX_IN_PROCESS_BRIEF_SNAPSHOTS = 256`).

### Behavioral Spot-Checks

T1 (non-PG, `SUBSTRATE_TEST_PG_URL` unset), run at `42e3cf13`:

`cd /root/src/worktrees/as-gsd-v18-all && env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/cache-breaker.test.ts packages/mcp-server/src/admission.test.ts packages/mcp-server/src/http.admission.test.ts packages/observability/src/slo.test.ts packages/mcp-server/src/service-forget.test.ts`

Result: **312 pass, 0 fail, 4108 expect() calls, 5 files, 3.17 s.** (Prior record: 158 pass over four files. 158 + 4 new cache-breaker tests + 150 in service-forget = 312.)

T2 (non-PG, `SUBSTRATE_TEST_PG_URL` unset), run at `42e3cf13`:

`cd /root/src/worktrees/as-gsd-v18-all && env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/flag-registry.test.ts scripts/config-reference.test.ts`

Result: **38 pass, 0 fail, 298 expect() calls, 2 files, 947 ms.**

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| T1a brief answered by index, cache never answers | T1, `cache-breaker.test.ts:73` | pass | ✓ PASS |
| T1b recall equals uncached reply | T1, `:98` | pass | ✓ PASS |
| T1c refused bump keeps reads on source until a bump lands | T1, `:117` | pass | ✓ PASS |
| T1d fail-closed refused, fail-open admits, neither reaches plane | T1, `:145` | pass | ✓ PASS |
| T4a breaker open + source down + in-process copy → `snapshot` | T1, `cache-breaker.test.ts:181` | pass | ✓ PASS |
| T4b breaker open + source down + window elapsed → `degraded`, no throw | T1, `:199` | pass | ✓ PASS |
| T4c readable cache, key absent → copy not served | T1, `:217` | pass | ✓ PASS |
| T4d readable cache, newer forget mark → copy refused | T1, `:229` | pass | ✓ PASS |
| T4e forget that deletes a plane document refuses the copy | T1, `service-forget.test.ts:688` | pass | ✓ PASS |
| T5 default fail-open; fail-closed in enforce; HTTP 503 with integer Retry-After | T1, `admission.test.ts:325,:334`, `http.admission.test.ts:274` | pass | ✓ PASS |
| T6 shadow bypass / enforce refusal | T1, `admission.test.ts:341` | pass | ✓ PASS |
| T7 only a breaker refusal is policed | T1, `admission.test.ts:350`, `:243` | pass | ✓ PASS |
| T8 flag parse and boot refusal | T1, `admission.test.ts:365,:375,:378` | pass | ✓ PASS |
| T9 flag registry and config reference match | T2 | 38 pass | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` exists, and the phase declares none. Not a migration or tooling phase. Not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R2 | none (no PLAN.md exists) | Reuse the cache-plane breaker and bounded timeouts; on outage, reads fall back to the documented source or report degradation; writes that cannot be made durable are rejected with retryable errors; no authoritative state lives only in the cache | ? NEEDS HUMAN / ORPHANED (unowned) | The read-fallback clause is evidenced by T1 to T4 and T5. The write clause ("reject writes that cannot be made durable with retryable errors") is outside the two ROADMAP criteria and no test in this phase covers it. No plan claims HARD-R2. Requirement stays `[ ]`. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (added lines, covered and outside-digest files) | - | `TODO`, `FIXME`, `XXX`, `HACK`, `PLACEHOLDER`, `TBD` | - | None in the added lines of `cache.ts`, `service.ts`, `flag-registry.ts`, the two test files and the docs. |
| `docs/config-reference.md` | snapshot TTL row | double period "at once.." | ℹ️ Info | Cosmetic; generator appends `. See` to a text ending in `.`. Not a gap. |
| `75-CONTEXT.md` | 23, 35, 46 | stale statements and anchors | ℹ️ Info | Documentation drift only. |

### Human Verification Required

H-1 is CLOSED by commits `9e6fa1f2` (feat), `9c86ffab` (test), `e185cd8a` and `42e3cf13` (docs), and is no longer a human item. Its restated expectation is decided by the in-force owner decision of 2026-11-04 (the in-process copy serves only while the cache cannot be read; a readable forget mark decides; the trade-off is documented in `docs/observability.md`).

Open human items (none verifiable by grep or targeted tests):

- **H-2** (operator live proof): stop live Dragonfly with default flags; `POST /brief` and `POST /memory/recall` answer 200 with authoritative content, within the timeout, and cache health reports degraded.
- **H-3** (operator live proof): with `SUBSTRATE_BUDGETS=enforce` and `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed`, a real open breaker yields 503 `cache_unavailable` with integer `Retry-After` and one `refused` increment; first 5 s of each open cycle admitted as bypass (O2).
- **H-4a** (operator live proof): `substrate.admission.decisions{decision="refused"}` is visible in `/metrics`, the OTel/Greptime export and dashboards, with surface and class labels, outside the limited-rate numerator (`slo.ts:360`).
- **H-4b** (owner item O1): the operator accepts the fail-closed read policy consequence (CONTEXT D75-2).
- **H-5** (owner item O2): decide whether a connect error during the 5 s `CACHE_CONNECT_COOLDOWN_MS` (`cache.ts:250`) for a fail-closed class stays bypass (current rule, kept NOT FIXED) or changes.

HARD-R2 write clause: unowned.

### Gaps Summary

No FAILED truth, no MISSING or STUB artifact, no NOT_WIRED link, no blocker anti-pattern. No `gaps:` block is emitted. Status is `human_needed` by the Step 9 rule: human items exist (H-2, H-3, H-4, H-5), and HARD-R2 is unowned. `passed` is not valid while the live proofs and owner items are open.

### Residual Risks

- **R1** (carried, predates phase 75 H-1 work): `staleGenerations` lives in the writing process. After a restart or on another replica, a generation key can still hold its old value, and a brief written before the write can be served until its TTL (`CACHE_TTL["brief"]`, 5 minutes). Tests cover one process only. Follow-up.
- **R4** (new, documented owner trade-off): while the cache cannot be read, this process's in-process last-good brief can outlive a forget made by another process. It is bounded by `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` (default 3600 s), held at most 256 argument sets, and refused at once for this process's own forgets. Once the cache is readable again its forget mark decides. Stated in `docs/observability.md` and the flag row.
- The recall-snapshot leg (`SUBSTRATE_BRIEF_RECALL` enforced) has no in-process copy and no cache-breaker-open test in the tree as far as grep shows. Not claimed as covered.

### Self-check

- Covered list and digest copied verbatim from `verification.fingerprint` at `42e3cf13`.
- Frontmatter `status: human_needed`; self-check command `gsd_run query verification.status <phase dir> --pick status` is run after writing (see the report).

---

_Verified: 2026-11-05T07:12:19Z_
_Verifier: Claude (gsd-verifier)_
