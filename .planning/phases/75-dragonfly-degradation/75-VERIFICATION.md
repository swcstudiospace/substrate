---
phase: 75-dragonfly-degradation
verified: 2026-11-05T07:59:06Z
status: human_needed
score: 8/8 truths verified (2/2 ROADMAP success criteria verified as declared; live proofs H-2, H-3, H-4a and owner items H-4b (O1), H-5 (O2) remain; HARD-R2 unowned)
covered_files: ["packages/mcp-server/src/admission.test.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/cache-breaker.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/http.admission.test.ts", "packages/mcp-server/src/live-session-consumer.test-support.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/observability/src/instruments.ts", "packages/observability/src/slo.test.ts", "packages/observability/src/slo.ts"]
covered_digest: "v3:sha256:0abff5c87c017e5757bd2427626f19f055f8eaa3f2e01d3d0afb048cb2c063ad"
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
**Verified:** 2026-11-05T07:59:06Z
**Status:** human_needed
**Re-verification:** Yes. Prior record at HEAD `42e3cf13` (covered digest `v3:sha256:d0472d76...`) is stale by digest: `d1a5e89b` changed `cache.ts` and `cache-breaker.test.ts`, and `b4bdd0fc` changed `service.ts`. Audit scoped to `git diff 42e3cf13..6e5d766e` on covered files and on the phase 75 paths. Overwritten in the worktree only; nothing committed.

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `6e5d766e`. Worktree clean for this phase.
- Must-haves: the two ROADMAP phase 75 success criteria (`.planning/ROADMAP.md:1298-1312`):
  1. With the cache breaker open, brief and recall return authoritative results. A test proves it.
  2. Admission under an open breaker follows a declared policy per class (fail open or closed), set in flags.
- Owner decision in force (H-1, closed; recorded dated 2026-11-05 in `6e5d766e`, earlier record said 2026-11-04): the in-process last-good brief serves only while the cache breaker is open. A readable forget mark decides. Any other failed mark read, with the breaker closed, refuses the copy. The trade-off (a forget by another process is not seen during an outage) is documented.
- No PLAN.md or SUMMARY.md exists in the phase directory (`75-CONTEXT.md`, `75-VERIFICATION.md`). Step 4/5 artifact and link checks are manual, below.
- Requirement: HARD-R2 (`.planning/REQUIREMENTS.md:119`, unchecked `[ ]`, mapped to phase 75). Unowned.
- Covered-file fingerprint: `gsd_run query verification.fingerprint .planning/phases/75-dragonfly-degradation <13 covered files>` run at `6e5d766e`. `covered_files` and `covered_digest` above are copied verbatim from that output. The covered list is the same 13 files as the prior record; the digest changed because `cache.ts`, `cache-breaker.test.ts` and `service.ts` changed.
- Postgres: none. `SUBSTRATE_TEST_PG_URL` is absent from the five test files run in T1 (grep, no match). No Postgres-gated test is named in phase 75. No database was started.
- Commands run (non-PG only, one `bun test` command, `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`): T1 below. Plus read-only `git diff`/`git show`/`git log`, grep, sed reads, JUnit grep of `/root/src/worktrees/backups/gate-r33-junit.xml`, and the fingerprint query. Not run: full suite, `tsc`, lint, formatters, any code edit, any commit, any mutation run.

### Changes since the `42e3cf13` record (checked)

Commits on `gsd/v18-int-all` after `42e3cf13`: `49b9aece` (fix 76), `b4bdd0fc` (fix 70), `d1a5e89b` (fix 75), `b4fe6bfe` (fix 68), `6e5d766e` (docs).

- `d1a5e89b` (fix 75, in scope). `cache.ts` `forgetVerdict` (`:890`): a failed mark read now returns `unreadable` only when `cause instanceof BreakerOpenError`; any other failure (a timeout from `attempt`, a dropped connection, a failed mark write) returns `forgotten`, which refuses. `snapshotSurvivesForget` (`:913`) keeps its boolean (`clear` only). `cache-breaker.test.ts:242` adds "a mark read that fails while the breaker is closed refuses the last-good copy". Audited against truths 4 and 5 below. The breaker refusal is a `BreakerOpenError` thrown by `callPlane` before `fn` runs; `attempt` (`cache.ts:1161`) rejects with the original cause, so the instanceof test sees it unchanged.
- `b4bdd0fc` (fix 70, `service.ts:3002`). Sync-lag reading after a docs.sync note: `recordSyncLag` now also runs for `buffered` and `deadLettered` results. It sits in the docs.sync emit path, not on brief, recall, admission or breaker paths. Not a phase 75 truth; checked only for interference (none found, `service.ts` lines after `:3002` shift by +1, so `:4546` is the forget stamp now). Its test is `service-event-buffer.test.ts`, outside the covered list.
- `49b9aece` (fix 76, `event-buffer.ts`), `b4fe6bfe` (fix 68, `worktree.py`): outside the covered list and not on phase 75 paths. Not audited beyond the stat.
- `6e5d766e` (docs): changes the prior 75 record (H-1 row dated), `docs/corpus.md`, `docs/reconcile.md`. Not phase 75 truths.
- Outside-digest files named by the record (`service-forget.test.ts`, `docs/observability.md`, `docs/config-reference.md`, `flag-registry.ts` snapshot-TTL row text): unchanged since `42e3cf13` (not in the stat), except the flag row text, which is in the covered `flag-registry.ts` and unchanged since `42e3cf13` as well.

### Correction to the `42e3cf13` record

The prior truth 4 row stated that a mark read that fails with the breaker closed refuses the copy, and it was marked VERIFIED without a test for that case. At `42e3cf13` the code did not do that: `forgetVerdict` returned `unreadable` for every failure, so the copy was served. The failed-mark-read rule was made true by `d1a5e89b` and is now test-backed (`cache-breaker.test.ts:242`). Truth 4 is VERIFIED at `6e5d766e` on that evidence, not on the earlier claim.

### Carried forward, not re-audited

Lines of `cache.ts`, `service.ts`, `admission.ts`, `config.ts`, `server.ts` on brief, recall and admission paths not touched by the `d1a5e89b` or `b4bdd0fc` hunks were carried forward from the `42e3cf13` record. The `corpusFreshness` hunk (`service.ts` `:7528-7540` in the earlier record, now one line later) is not on these paths.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1 (brief): with the cache breaker open, brief is answered from the index on every call and the cache never answers | ✓ VERIFIED | `cache-breaker.test.ts:73` passes (T1). Code path `getOrLoad` (`cache.ts:545`, gated reads, catch `:586-588`) and live `load()` unchanged since `42e3cf13`. |
| 2 | SC1 (recall): with the cache breaker open, recall returns the same reply as a substrate with no cache | ✓ VERIFIED | `cache-breaker.test.ts:98` passes (T1). Recall path (`recallMemories` `service.ts:3782`, `recallUncounted` `:3810`) not in the `d1a5e89b` or `b4bdd0fc` diff. |
| 3 | Generation keys: a bump the breaker refused keeps reads on the source after it closes, until a bump lands | ✓ VERIFIED | `cache-breaker.test.ts:117` passes (T1). `bump` (`cache.ts:852`) adds the key to `staleGenerations` on failure (`:857-860`); `getOrLoad` bypasses it (`:576`). Unchanged. Residual R1. |
| 4 | Degraded brief, H-1 (owner decision): with the cache breaker open and the live source failing, (a) if this process holds a last-good brief for the arguments that is inside the window and not forgotten, it is served as state `snapshot`, with a header naming the failed sources and the body equal to the complete brief; (b) otherwise state is `degraded`, no snapshot text is served, and the brief does not throw. A readable forget mark, an answering cache with no snapshot, or a mark read that fails while the breaker is closed refuses the copy. | ✓ VERIFIED | (a) `cache-breaker.test.ts:181` (breaker opened, `getGraph` throws: `state` `snapshot`, `failed` `["graph"]`, header and body checked). (b) `cache-breaker.test.ts:199` (window elapsed: `degraded`, no throw). (c) `:217` (readable cache, key absent: copy not served). (d) `:229` (readable cache, newer forget mark: copy refused). (e) `:242` (mark read throws with the breaker closed: state `degraded`, `snapshotAt` null, breaker still `closed`). (f) `service-forget.test.ts:688` (a forget that deletes a plane document refuses the copy while the breaker is open). Code: `inProcessLastGood` (`service.ts:2517-2529`) serves only when `forgetVerdict` returns `unreadable` (`cache.ts:890`, breaker refusal only). Forget stamp `service.ts:4546` (`briefForgottenAtMs`). All pass in T1 and as named passes in gate r33. |
| 5 | SC2: per class, a fail-closed admission class is refused in `enforce` (503 `cache_unavailable`, `Retry-After`), a fail-open class admits as `bypass`, and neither reaches the plane. With no flag set every class is fail-open (D75-1) | ✓ VERIFIED | `admission.test.ts:325` (default all fail-open), `:334` (fail-closed refused in enforce, others fail-open), `cache-breaker.test.ts:145` (refused fail-closed, admitted fail-open, neither reaches the plane, no breaker failure for the refusals), `http.admission.test.ts:274` (fail-open 200 as bypass, fail-closed 503 with integer `Retry-After`). All pass in T1. Enforcement: `server.ts:978` (REST `admission.admit`), `server.ts:2758` (MCP `admitBatch`), `sendBudgetRefusal` `server.ts:633`. Admission and server files unchanged since `42e3cf13`. |
| 6 | A breaker refusal of a fail-closed class is a `bypass` in `shadow` and a `refused` in `enforce` | ✓ VERIFIED | `admission.test.ts:341` passes (T1). Code: `admission.ts:386-390` (breaker-refusal branch, `enforce` only). See CONTEXT drift note. |
| 7 | Only a breaker refusal is policed: another cache failure (timeout, connect error, malformed reply) stays `bypass` in a fail-closed class | ✓ VERIFIED | `admission.test.ts:350` and `:243` pass (T1). `outcome.breakerRetryAfterMs` gates the refusal branch (`admission.ts:386`). The same instanceof rule now also governs the mark read (truth 4), in `cache.ts:905`. |
| 8 | Flags: `SUBSTRATE_BUDGET_<CLASS>_BREAKER` parses trimmed and case-insensitively, blank is `fail-open`, and any other value refuses boot with a `ConfigError` naming the variable | ✓ VERIFIED | `admission.test.ts:365` and `:375` pass (T1); `:378` asserts `loadConfig` throws. Code: `loadAdmissionSettings` (`config.ts:1874`) calls `breakerPolicyOf` (`config.ts:1909`), which throws at `:1933`. Registry: `flag-registry.ts:189`, `:219-228`. Unchanged files. |

**Score:** 8/8 truths verified. Truth 4 is verified on the `d1a5e89b` change and its test (see Correction above).

### Deferred Items

None. No gaps found, so nothing deferred.

### Required Artifacts (manual Levels 1-3)

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/admission.ts` | admission decision, breaker policy | ✓ VERIFIED | Unchanged since `42e3cf13`. Decision branch `:386-390`; wired `server.ts:978`, `:2758`. |
| `packages/mcp-server/src/cache.ts` | gated read-through, stale generations, peek/put, forget verdict | ✓ VERIFIED | Changed (`d1a5e89b`). `forgetVerdict` `:890` (instanceof rule `:905`), `snapshotSurvivesForget` `:913`, `getOrLoad` `:545`, `bump` `:852`, `markForget` `:870`, `peek` `:922`, `peekQuiet` `:953`, `writeKey` `:1021`, `snapshotKey` `:299`, `bunRedis` `:341`, connect cooldown `:250`, `attempt` `:1161`. |
| `packages/mcp-server/src/config.ts` | `loadAdmissionSettings`, `breakerPolicyOf` | ✓ VERIFIED | Unchanged. `:1874`, `:1909`, `:1929-1933`. |
| `packages/mcp-server/src/flag-registry.ts` | `SUBSTRATE_BUDGET_<CLASS>_BREAKER` family; snapshot TTL row | ✓ VERIFIED | Family `:189`, `:219-228` unchanged. Snapshot TTL row text (`:632`) unchanged since `42e3cf13`. |
| `packages/observability/src/instruments.ts` | `ADMISSION_CLASSES` | ✓ VERIFIED | `:170`. Unchanged. |
| `packages/observability/src/slo.ts` | numerator excludes `refused` | ✓ VERIFIED | `:360`, numerator `decision: "limited"`. Unchanged. |
| `packages/mcp-server/src/service.ts` | in-process last-good brief, cache gate, brief snapshot read | ✓ VERIFIED | Changed (`b4bdd0fc`, `:3002`, off the brief path). Gate `:1945` `planes.gate("cache")`; fields `:1646-1648`; `rememberLastGood` `:2499`; `inProcessLastGood` `:2517`; `briefDetailed` `:2472`; snapshot peek and degraded path `:2721-2724`; write `:2595`; forget stamp `:4546`. |
| `packages/mcp-server/src/service-forget.test.ts` (outside digest) | forget refuses the in-process copy | ✓ VERIFIED | Test `:688` present and named as passed in gate r33 JUnit. File unchanged since `42e3cf13`. |

### Key Link Verification (manual)

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts:1945` | `cache.ts:341` `bunRedis` → `breaker.ts` `callPlane` | `planes.gate("cache")` | ✓ WIRED | Every cache command is refused before `fn` runs when the breaker is open. |
| `service.ts:2721-2724` | `cache.ts:922` `peek` | `brief-snapshot` read | ✓ WIRED | A refused read returns null, so the in-process copy path is taken. A readable cache's verdict (`snapshotSurvivesForget`) decides when the snapshot exists. |
| `service.ts:2529` `inProcessLastGood` | `cache.ts:890` `forgetVerdict` | `=== "unreadable"` | ✓ WIRED | The copy is served only for `unreadable`, which is the breaker's refusal alone (`cache.ts:905`). `clear`, `forgotten`, and any non-breaker failure refuse. |
| `service.ts:2595-2596` | `service.ts:2499` `rememberLastGood` | written before `cache.put` | ✓ WIRED | Written whatever the breaker says; gated by window > 0 and cache enabled. |
| `service.ts:4546` | `service.ts:2524` | `briefForgottenAtMs` | ✓ WIRED | A copy saved at or before this process's last forget is not served. Set only when `touched`. |
| `server.ts:978` / `:2758` | `admission.ts` `admit` / `admitBatch` | per-request and batch admission | ✓ WIRED | `sendBudgetRefusal` (`server.ts:633`) renders 429 or 503. |
| `config.ts:1909` | `config.ts:1929` `breakerPolicyOf` | `loadAdmissionSettings` ← `loadConfig` | ✓ WIRED | A bad value throws `ConfigError` and refuses boot. |

### Data-Flow Trace (Level 4)

Not applicable to admission. For the brief under an open breaker, the answer is the index composition (truth 1) or the in-process last-good text (truth 4a). Both are asserted by the tests above. The process-local copy is a bounded map (`MAX_IN_PROCESS_BRIEF_SNAPSHOTS = 256`, `service.ts:544`).

### Behavioral Spot-Checks

T1 (non-PG, `SUBSTRATE_TEST_PG_URL` unset), run at `6e5d766e`:

`cd /root/src/worktrees/as-gsd-v18-all && env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/cache-breaker.test.ts packages/mcp-server/src/admission.test.ts packages/mcp-server/src/http.admission.test.ts packages/observability/src/slo.test.ts packages/mcp-server/src/service-forget.test.ts`

Result: **313 pass, 0 fail, 4112 expect() calls, 5 files, 2.27 s.** (Prior record at `42e3cf13`: 312 pass. The difference is the new test at `cache-breaker.test.ts:242`.)

Mutation of the forget guard: the commit `6e5d766e` message records that the guard was observed by mutation. That mutation was not re-run in this pass (no code edits permitted). It is cited as the author's record, not as an observation here.

JUnit cross-check, gate r33 (`/root/src/worktrees/backups/gate-r33-junit.xml`, at `6e5d766e`, 0 failures): the testcases below are named passes, with no `<skipped/>` child:
- "a mark read that fails while the breaker is closed refuses the last-good copy: a mark that cannot be read is not 'no forget'" (`cache-breaker.test.ts`, line 242)
- "a brief composed with the breaker closed is served as the snapshot once the breaker opens and the source fails" (line 181)
- "a snapshot older than the cache window is not served: the degraded brief answers" (line 199)
- "with the cache readable and no snapshot for the key, the last-good brief is not served: an answering cache is not an outage" (line 217)
- "with the cache readable, a forget another process made after the brief refuses the last-good copy" (line 229)
- "a forget that deletes a plane document refuses the in-process last-good brief while the cache breaker is open" (`service-forget.test.ts`, line 688)
- "an open cache breaker is a bypass for a fail-open class and a 503 for a fail-closed one" (`http.admission.test.ts`, line 274)

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| T1a brief answered by index, cache never answers | T1, `cache-breaker.test.ts:73` | pass | ✓ PASS |
| T1b recall equals uncached reply | T1, `:98` | pass | ✓ PASS |
| T1c refused bump keeps reads on source until a bump lands | T1, `:117` | pass | ✓ PASS |
| T1d fail-closed refused, fail-open admits, neither reaches plane | T1, `:145` | pass | ✓ PASS |
| T4a breaker open + source down + in-process copy → `snapshot` | T1, `:181` | pass | ✓ PASS |
| T4b breaker open + source down + window elapsed → `degraded`, no throw | T1, `:199` | pass | ✓ PASS |
| T4c readable cache, key absent → copy not served | T1, `:217` | pass | ✓ PASS |
| T4d readable cache, newer forget mark → copy refused | T1, `:229` | pass | ✓ PASS |
| T4e mark read fails, breaker closed → copy refused | T1, `:242` | pass | ✓ PASS |
| T4f forget that deletes a plane document refuses the copy | T1, `service-forget.test.ts:688` | pass | ✓ PASS |
| T5 default fail-open; fail-closed in enforce; HTTP 503 with integer Retry-After | T1, `admission.test.ts:325,:334`, `http.admission.test.ts:274` | pass | ✓ PASS |
| T6 shadow bypass / enforce refusal | T1, `admission.test.ts:341` | pass | ✓ PASS |
| T7 only a breaker refusal is policed | T1, `admission.test.ts:350`, `:243` | pass | ✓ PASS |
| T8 flag parse and boot refusal | T1, `admission.test.ts:365,:375,:378` | pass | ✓ PASS |
| T9 flag registry and config reference match | Not re-run at `6e5d766e`; `flag-registry.ts` and `docs/config-reference.md` unchanged since `42e3cf13`, where T2 gave 38 pass | carried forward | ✓ PASS (carried) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` exists, and the phase declares none. Not a migration or tooling phase. Not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R2 | none (no PLAN.md exists) | Reuse the cache-plane breaker and bounded timeouts; on outage, reads fall back to the documented source or report degradation; writes that cannot be made durable are rejected with retryable errors; no authoritative state lives only in the cache | ? NEEDS HUMAN / ORPHANED (unowned) | The read-fallback clause is evidenced by T1 to T4 and T5. The write clause ("reject writes that cannot be made durable with retryable errors") is outside the two ROADMAP criteria and no test in this phase covers it. No plan claims HARD-R2. Requirement stays `[ ]`. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (added lines, covered files and tests) | - | `TODO`, `FIXME`, `XXX`, `HACK`, `PLACEHOLDER`, `TBD` | - | None in the `d1a5e89b` and `b4bdd0fc` added lines. |
| `docs/observability.md:230`, flag row `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` | - | Window described as "while the cache cannot be read (the breaker is open)" with no statement that a failed mark read with the breaker closed refuses the copy | ℹ️ Info | Documentation omits the `d1a5e89b` rule. The code and test are correct. Wording change is for the owner; not edited here. |
| `docs/config-reference.md` | snapshot TTL row | double period "at once.." | ℹ️ Info | Cosmetic; generator appends `. See` to a text ending in `.`. Not a gap. |
| `75-CONTEXT.md` | 23, 35, 46 | stale statements and anchors | ℹ️ Info | Documentation drift only (shadow refusal wording; `config.ts` anchors now `:1874`/`:1909`). Not edited. |

### Human Verification Required

H-1 is CLOSED by the owner decision and the commits `9e6fa1f2`, `9c86ffab`, `e185cd8a`, `42e3cf13`, and `d1a5e89b` (failed-mark-read rule and test). It is no longer a human item.

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
- **R4** (owner trade-off): while the cache cannot be read (breaker open), this process's in-process last-good brief can outlive a forget made by another process. It is bounded by `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` (default 3600 s), held at most 256 argument sets, and refused at once for this process's own forgets. Once the cache is readable again its forget mark decides. Stated in `docs/observability.md` and the flag row.
- The recall-snapshot leg (`SUBSTRATE_BRIEF_RECALL` enforced) has no in-process copy and no cache-breaker-open test in the tree as far as grep shows. Not claimed as covered.

### Self-check

- Covered list and digest copied verbatim from `verification.fingerprint` at `6e5d766e`.
- Frontmatter `status: human_needed`. The self-check `gsd_run query verification.status <phase dir> --pick status` and a fingerprint recompute are run after writing (see report).

---

_Verified: 2026-11-05T07:59:06Z_
_Verifier: Claude (gsd-verifier)_
