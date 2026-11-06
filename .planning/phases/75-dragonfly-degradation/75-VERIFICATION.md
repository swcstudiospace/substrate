---
phase: 75-dragonfly-degradation
verified: 2026-11-06T00:45:00Z
status: human_needed
score: 8/8 truths verified (2/2 ROADMAP success criteria verified as declared; truth 4 verified on its tested cases, scope narrowed by the connect cooldown, see O2; live proofs H-2, H-3, H-4a and owner items H-4b (O1), H-5 (O2) remain; HARD-R2 unowned)
covered_files: ["packages/mcp-server/src/admission.test.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/cache-breaker.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/http.admission.test.ts", "packages/mcp-server/src/live-session-consumer.test-support.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/observability/src/instruments.ts", "packages/observability/src/slo.test.ts", "packages/observability/src/slo.ts"]
covered_digest: "v3:sha256:fdb05c6e4f47a3bd16ff2b4c19d277a7b5086b283a35f5755af40fc7874348cb"
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
  - test: 'H-5: Decide the connect-cooldown window for fail-closed classes (open decision O2; CACHE_CONNECT_COOLDOWN_MS, cache.ts:251; owner decision kept NOT FIXED)'
    expected: 'Either accept that a fail-closed class admits as bypass during the 5 s connect cooldown, including the first 5 s of each open cycle that a connect failure starts, or direct a change. Also decide whether the in-process last-good copy stays refused in that same window (truth 4 scope note), or is served while the breaker is open'
    why_human: 'A judgment about the declared rule (a connect error stays bypass in every class), not a defect a grep or a targeted test can settle. The cooldown refusal also reaches the snapshot path (cache.ts:409-412, :906). Owner item O2, kept open.'
---

# Phase 75: DragonflyDB degradation Verification Report

**Phase Goal:** When the cache plane is open or unreachable, reads fall back to the authoritative store without losing state, and admission behaves as declared.
**Verified:** 2026-11-06T00:45:00Z
**Status:** human_needed
**Re-verification:** Yes. Prior record at HEAD `6e5d766e` (covered digest `v3:sha256:0abff5c8...`) is stale by digest: `cache.ts`, `config.ts`, `server.ts`, `service.ts` and `slo.ts` changed after it. Re-audit at HEAD `a46d42c3`, worktree clean. Truth 4 was re-audited after `f0f3c04e` (`cache.ts:706`) and `d1a5e89b` (`cache.ts:906`). Draft at `/root/src/worktrees/backups/records/75-VERIFICATION.md`; nothing written in the worktree or committed.

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `a46d42c3`, `git status` clean.
- Must-haves: the two ROADMAP phase 75 success criteria (`.planning/ROADMAP.md:1298-1312`):
  1. With the cache breaker open, brief and recall return authoritative results. A test proves it.
  2. Admission under an open breaker follows a declared policy per class (fail open or closed), set in flags.
- Owner decision in force (H-1, closed; `6e5d766e`, dated 2026-11-05): the in-process last-good brief serves only while the cache breaker is open. A readable forget mark decides. Any other failed mark read, with the breaker closed, refuses the copy. The trade-off (a forget by another process is not seen during an outage) is documented in `docs/observability.md:230`.
- Other owner decisions in force, not reopened here: the planning-hash default stays off; the tombstone scope is the caller's declaration; the in-flight event is recorded at shutdown; a buffered root is not written again.
- No PLAN.md or SUMMARY.md in the phase directory (`75-CONTEXT.md`, `75-VERIFICATION.md`). Step 4/5 artifact and link checks are manual, below.
- Requirement: HARD-R2 (`.planning/REQUIREMENTS.md:119`, unchecked `[ ]`, mapped to phase 75). Unowned.
- Covered-file fingerprint: `gsd_run query verification.fingerprint .planning/phases/75-dragonfly-degradation <13 covered files>` run read-only at `a46d42c3`. `covered_files` and `covered_digest` above are copied verbatim from that output. The covered list is the same 13 files as the prior record.
- Evidence: gate r36 JUnit `/root/src/worktrees/backups/gate-r36-junit.xml` (12,317 testcases, 0 failures, 2 skipped; the skips are `redact.test.ts:815` and `cache-conformance.test.ts:120`, neither cited). Every cited title below was checked by parsing the XML: one `testcase` with that name, file and line, and no `failure`, `error` or `skipped` child. The file does not record its commit. It contains the `d1a5e89b` test at `cache-breaker.test.ts:242` and the `f0f3c04e` test `http-null-body.test.ts:58`, so the run post-dates both.
- Postgres: none. No Postgres-gated test is named in phase 75.
- Not run in this pass, by assignment: any test, `tsc`, lint, formatters, docker, databases, any edit, any commit. The behavioural evidence is the r36 JUnit; the T1 `bun test` run of the prior record is not repeated here.

### Changes since the `6e5d766e` record (checked)

Commits after `6e5d766e`: `c71a539d`, `403e45f7`, `bb6b38b7`, `884e0753`, `aef8a351`, `b1bb49f2`, `e3914640`, `e958e8b1`, `885e73ce`, `7a1d923a`, `c371cece`, `f0f3c04e`, `9b793653`, `a46d42c3`.

Covered-file diff `6e5d766e..a46d42c3` (`git diff --stat`): `cache.ts` 3 lines, `config.ts` 4 lines, `slo.ts` 1 line, `server.ts` 41 lines, `service.ts` 98 lines. `admission.ts`, `flag-registry.ts`, `instruments.ts`, `admission.test.ts`, `cache-breaker.test.ts`, `http.admission.test.ts`, `slo.test.ts`, `live-session-consumer.test-support.ts` are unchanged. `service-forget.test.ts` is unchanged.

- `d1a5e89b` (fix 75, in scope, already in the prior record's history, re-audited here): `forgetVerdict` (`cache.ts:891`) returns `unreadable` only when the failure is a `BreakerOpenError` (`cache.ts:906`). Every other failed mark read returns `forgotten`. Behaviour change is confined to `inProcessLastGood` (`service.ts:2539`, `=== "unreadable"`). `snapshotSurvivesForget` (`cache.ts:914`) is a boolean on `clear` only, so its result is the same as before for every verdict. `attempt` (`cache.ts:1162`) rejects with the original cause, so `instanceof` sees the breaker's error unchanged (`observability/src/breaker.ts:173`, thrown by `callPlane` at `:225`). The test `cache-breaker.test.ts:242` makes the mark read throw with the breaker closed and asserts `degraded` and `snapshotAt` null. Before `d1a5e89b` that path served the copy, so the test discriminates the fix.
- `f0f3c04e` (in scope for truth 4 only as a reporting change): `withDeadline` (`cache.ts:703-717`) now sends a rejected load to `reportSilent("cache.deadline-load", cause)` (`cache.ts:706`) in the `ms <= 0` branch only. In the positive-budget branch a late rejection is absorbed by `Promise.race` and is not reported. The return value (`TIMED_OUT`, then `onDeadline`) is unchanged. The brief's `getOrLoad` (`service.ts:2626-2699`) passes no `deadlineMs`, so `withDeadline` is not on the brief path. The recall load (`service.ts:3849-3868`, `deadlineMs` at `:3864`) reaches the reporting branch only with a zero budget. No test in the tree names the `cache.deadline-load` site (grep: only `cache.ts:706`), so the report is code-verified, not test-verified. `silent-failures.test.ts` covers `reportSilent` itself (title at :39).
- `884e0753`, `b4bdd0fc`, `9b793653`, `a46d42c3`, `c371cece`, `f0f3c04e` (other `server.ts` and `service.ts` hunks): body-parse guards on `/evidence`, `/handoff`, `/drift`, `/verify` (`server.ts:1214`, `:1499`, `:1579`, `:1609`); the sync-lag gauge moved out of the REST route (`server.ts:1360` removed; read at `service.ts:3016-3018`); `trackRetain` settles with `then(settle, settle)` (`service.ts:3874-3883`); `reportSilent` on emit, bump and claim catches; `queryEventsFor` takes `null` (`service.ts:6867`); the `handleMcp` close catches (`server.ts:2801-2804`). None of these hunks is on the brief, recall, forget, admission or breaker path. `server.ts` loses an import at `:75`, which moves every later anchor by one line.
- `a46d42c3`: `PLANE_AVAILABILITY_ENV` export removed from `slo.ts` (about line 483). No reference remains under `packages/`. The numerator at `slo.ts:360` is unchanged.
- `403e45f7` (`config.ts:333-337`): comment only, the lightrag poll interval doc. No change to `loadAdmissionSettings` or `breakerPolicyOf`.
- `bb6b38b7` (`docs/observability.md:230`): the sentence "A forget mark that cannot be read while the breaker is closed refuses the copy too." is now present. The prior record's documentation gap is closed.

### Correction to the `42e3cf13` record (carried)

The `42e3cf13` truth 4 claimed that a mark read that fails with the breaker closed refuses the copy, and it was marked VERIFIED without a test for that case. At `42e3cf13` the code did not do that. The rule was made true by `d1a5e89b` and is test-backed by `cache-breaker.test.ts:242`.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1 (brief): with the cache breaker open, brief is answered from the index on every call and the cache never answers | ✓ VERIFIED | `cache-breaker.test.ts:73` "brief is composed from the index on every call, and the cache never answers it": pass in r36. Code: `getOrLoad` `cache.ts:546`; the brief's `getOrLoad` at `service.ts:2626` passes no `deadlineMs`. Logic unchanged since `6e5d766e`. |
| 2 | SC1 (recall): with the cache breaker open, recall returns the same reply as a substrate with no cache | ✓ VERIFIED | `cache-breaker.test.ts:98` "recall returns the same reply as a substrate with no cache at all": pass in r36. `recallMemories` `service.ts:3798`, `recallUncounted` `:3826` (moved from `:3782`/`:3810` by hunks above them; those hunks are `.catch` reporting and the sync-lag reading). |
| 3 | Generation keys: a bump the breaker refused keeps reads on the source after it closes, until a bump lands | ✓ VERIFIED | `cache-breaker.test.ts:117` "generation keys: a bump the breaker refused keeps reads on the source after it closes, until a bump lands": pass in r36. `bump` `cache.ts:853` (failure adds the key to `staleGenerations`, `:861`); `getOrLoad` bypasses a stale generation at `:577`. Residual R1. |
| 4 | Degraded brief, H-1 (owner decision): with the cache breaker open and the live source failing, (a) if this process holds a last-good brief for the arguments that is inside the window and not forgotten, it is served as state `snapshot`, with a header naming the failed sources and the body equal to the complete brief; (b) otherwise state is `degraded`, no snapshot text is served, and the brief does not throw. A readable forget mark, an answering cache with no snapshot, or a mark read that fails while the breaker is closed refuses the copy. | ✓ VERIFIED (tested cases; scope note) | (a) `cache-breaker.test.ts:181` "a brief composed with the breaker closed is served as the snapshot once the breaker opens and the source fails": pass; asserts `snapshot`, `failed` `["graph"]`, header and body equal. (b) `:199` "a snapshot older than the cache window is not served": pass; `degraded`, `snapshotAt` null. (c) `:217` readable cache, key absent: pass. (d) `:229` readable cache, newer forget mark: pass. (e) `:242` "a mark read that fails while the breaker is closed refuses the last-good copy: a mark that cannot be read is not 'no forget'": pass. (f) `service-forget.test.ts:688` "a forget that deletes a plane document refuses the in-process last-good brief while the cache breaker is open": pass; this process's own forget is refused by `briefForgottenAtMs` (`service.ts:2534`, set at `:4563`) before the mark is read. Code: `briefDetailed` `service.ts:2482`; `rememberLastGood` `:2509`; `inProcessLastGood` `:2527`, verdict `:2539`; cache-readable path `:2734`; degraded return `:2735-2739`; write `:2605-2606`. **Scope note (new in this pass):** the copy is served only when the mark read is refused by the breaker (`BreakerOpenError`). The connect cooldown is checked before `callPlane` (`cache.ts:409-411`, then `:412`). For the 5 s after a connect failure, which is the usual way a breaker opens (`cache.ts:378-381`, failure threshold 5 and open 30 s per `breaker.ts:51-52`), the mark read rejects with a plain `Error` ("cache connect cooling down"). That is "forgotten" under `cache.ts:906`, so the copy is refused and the brief is `degraded` while the breaker is open. The sequence is shown by `cache.test.ts:1256` "the connect cooldown is reported and expires; a breaker refusal does not start one" (pass in r36; the gated case at `:1274-1280` needs the cooldown to lapse before `BreakerOpenError`). No test in the tree covers a mark read inside the cooldown with the breaker open; `closedGate` in `cache-breaker.test.ts` uses an in-memory store, not `bunRedis`. The outcome is fail-safe (copy refused, never served stale), so truth 4 is kept VERIFIED for the tested cases. Its literal wording "(a) ... is served" holds only once the cooldown has lapsed. Raised under H-5 (O2). [INFERENCE] from code reading; not observed live. |
| 5 | SC2: per class, a fail-closed admission class is refused in `enforce` (503 `cache_unavailable`, `Retry-After`), a fail-open class admits as `bypass`, and neither reaches the plane. With no flag set every class is fail-open (D75-1) | ✓ VERIFIED | `admission.test.ts:325` "with no flag set every class is fail-open: an open breaker admits and counts a bypass, as it did before" and `:334` "a fail-closed class is refused in enforce with the breaker's wait, and the other classes stay fail-open": pass. `cache-breaker.test.ts:145` "admission over the open breaker: a fail-closed class is refused, a fail-open class admits, and neither reaches the plane": pass. `http.admission.test.ts:274` "an open cache breaker is a bypass for a fail-open class and a 503 for a fail-closed one": pass. Enforcement: REST `server.ts:977` (`admission.admit`), MCP `server.ts:2774` (`admitBatch`), `sendBudgetRefusal` `server.ts:632`. None of the changed `server.ts` hunks is on these lines. |
| 6 | A breaker refusal of a fail-closed class is a `bypass` in `shadow` and a `refused` in `enforce` | ✓ VERIFIED | `admission.test.ts:341` "a breaker refusal of a fail-closed class is a bypass in shadow and a refusal in enforce": pass. Code: `admission.ts:386` (breaker-refusal branch, `enforce` only). `admission.ts` unchanged. |
| 7 | Only a breaker refusal is policed: another cache failure (timeout, connect error, malformed reply) stays `bypass` in a fail-closed class | ✓ VERIFIED | `admission.test.ts:350` "only a breaker refusal is policed: another cache failure stays a bypass in a fail-closed class" and `:243` "a cache that fails, refuses, or answers nonsense is a recorded bypass, never a refusal": pass. `outcome.breakerRetryAfterMs` gates the refusal at `admission.ts:386`. A connect-cooldown error is a connect error, so it stays `bypass` here; that is the O2 window. The same instanceof rule governs the mark read in truth 4 (`cache.ts:906`). |
| 8 | Flags: `SUBSTRATE_BUDGET_<CLASS>_BREAKER` parses trimmed and case-insensitively, blank is `fail-open`, and any other value refuses boot with a `ConfigError` naming the variable | ✓ VERIFIED | `admission.test.ts:365` "SUBSTRATE_BUDGET_<CLASS>_BREAKER parses per class, trimmed and case-insensitive; blank is fail-open" and `:375` "an invalid SUBSTRATE_BUDGET_<CLASS>_BREAKER refuses boot and names the variable": pass (assertion that `loadConfig` throws at `:378`). Code: `loadAdmissionSettings` `config.ts:1874` calls `breakerPolicyOf` (`config.ts:1909`), which throws at `:1933`. Registry: `flag-registry.ts:189`, `:219-228`. Unchanged. |

**Score:** 8/8 truths verified. Truth 4 is verified on its tested cases; its scope is narrowed by the connect-cooldown window (O2, H-5). No truth is FAILED.

### Deferred Items

None. No gaps found, so nothing deferred.

### Required Artifacts (manual Levels 1-3)

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/admission.ts` | admission decision, breaker policy | ✓ VERIFIED | Unchanged since `6e5d766e`. Decision branch `:386`; wired `server.ts:977`, `:2774`. |
| `packages/mcp-server/src/cache.ts` | gated read-through, stale generations, peek/put, forget verdict | ✓ VERIFIED | Changed (`f0f3c04e`, 3 lines at `:41`, `:706`). `forgetVerdict` `:891` (instanceof rule `:906`), `snapshotSurvivesForget` `:914`, `getOrLoad` `:546`, `bump` `:853`, `markForget` `:871`, `peek` `:923`, `peekQuiet` `:954`, `writeKey` `:1022`, `snapshotKey` `:300`, `bunRedis` `:342`, connect cooldown check `:409-411`, `callPlane` `:412`, connect cooldown constant `CACHE_CONNECT_COOLDOWN_MS` `:251`, `withDeadline` `:703`, `fail` `:1147`, `attempt` `:1162`. |
| `packages/mcp-server/src/config.ts` | `loadAdmissionSettings`, `breakerPolicyOf` | ✓ VERIFIED | Comment-only change (`:333-337`). `:1874`, `:1909`, `:1929-1933`. |
| `packages/mcp-server/src/flag-registry.ts` | `SUBSTRATE_BUDGET_<CLASS>_BREAKER` family; snapshot TTL row | ✓ VERIFIED | Family `:189`, `:219-228`. Snapshot TTL row `:632`, text unchanged since `42e3cf13`. |
| `packages/observability/src/instruments.ts` | `ADMISSION_CLASSES` | ✓ VERIFIED | `:170`. Unchanged. |
| `packages/observability/src/slo.ts` | numerator excludes `refused` | ✓ VERIFIED | Numerator `decision: "limited"` at `:360`. Unused export `PLANE_AVAILABILITY_ENV` removed (`a46d42c3`), no references remain. |
| `packages/mcp-server/src/service.ts` | in-process last-good brief, cache gate, brief snapshot read | ✓ VERIFIED | Changed (many hunks, none on the truth paths except the anchors listed). Gate `:1948` `planes.gate("cache")`; fields `:1649`, `:1651`; `MAX_IN_PROCESS_BRIEF_SNAPSHOTS` `:545`; `briefDetailed` `:2482`; `rememberLastGood` `:2509`; `inProcessLastGood` `:2527`; write `:2605-2606`; SWR lastGood `:2664-2668`; snapshot read and decision `:2730-2734`; degraded path `:2735-2739`; forget stamp `briefForgottenAtMs` `:4563`, `markForget` `:4567`. `withDeadline` is not called on the brief path. |
| `packages/mcp-server/src/service-forget.test.ts` (outside digest) | forget refuses the in-process copy | ✓ VERIFIED | Test `:688` "a forget that deletes a plane document refuses the in-process last-good brief while the cache breaker is open": pass in r36. File unchanged since `6e5d766e`. |
| `packages/mcp-server/src/cache-breaker.test.ts` (in digest) | H-1 and SC1 tests | ✓ VERIFIED | Nine testcases, all pass in r36 (titles in the table above). Unchanged since `d1a5e89b`. |

### Key Link Verification (manual)

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts:1948` | `cache.ts:342` `bunRedis` → `breaker.ts` `callPlane` | `planes.gate("cache")` | ✓ WIRED | Every cache command is refused before `fn` runs when the breaker is open. The connect-cooldown check (`cache.ts:409`) runs before the gate and is not a breaker refusal. |
| `service.ts:2730-2734` | `cache.ts:923` `peek` | `brief-snapshot` read | ✓ WIRED | A refused read returns null, so the in-process copy path is taken. A readable cache's verdict (`snapshotSurvivesForget`) decides when the snapshot exists. |
| `service.ts:2539` `inProcessLastGood` | `cache.ts:891` `forgetVerdict` | `=== "unreadable"` | ✓ WIRED | The copy is served only for `unreadable`, which is the breaker's refusal alone (`cache.ts:906`). `clear`, `forgotten`, and any non-breaker failure (including the cooldown error) refuse. |
| `service.ts:2605-2606` | `service.ts:2509` `rememberLastGood` | written before `cache.put` | ✓ WIRED | Written whatever the breaker says; gated by window > 0 and cache enabled. |
| `service.ts:4563` | `service.ts:2534` | `briefForgottenAtMs` | ✓ WIRED | A copy saved at or before this process's last forget is not served. Set only when `touched`. |
| `server.ts:977` / `:2774` | `admission.ts` `admit` / `admitBatch` | per-request and batch admission | ✓ WIRED | `sendBudgetRefusal` (`server.ts:632`) renders 429 or 503. |
| `config.ts:1909` | `config.ts:1929` `breakerPolicyOf` | `loadAdmissionSettings` ← `loadConfig` | ✓ WIRED | A bad value throws `ConfigError` and refuses boot. |

### Data-Flow Trace (Level 4)

Not applicable to admission. For the brief under an open breaker, the answer is the index composition (truth 1) or the in-process last-good text (truth 4a). Both are asserted by the tests above. The process-local copy is a bounded map (`MAX_IN_PROCESS_BRIEF_SNAPSHOTS = 256`, `service.ts:545`).

### Behavioral Spot-Checks

No test was run in this pass. Each row is the r36 JUnit testcase, checked for no `failure`, `error` or `skipped` child.

| Behavior | Testcase (file:line) | r36 result | Status |
| -------- | -------------------- | ---------- | ------ |
| T1a brief answered by index, cache never answers | `cache-breaker.test.ts:73` | pass | ✓ PASS |
| T1b recall equals uncached reply | `:98` | pass | ✓ PASS |
| T1c refused bump keeps reads on source until a bump lands | `:117` | pass | ✓ PASS |
| T1d fail-closed refused, fail-open admits, neither reaches plane | `:145` | pass | ✓ PASS |
| T4a breaker open + source down + in-process copy → `snapshot` | `:181` | pass | ✓ PASS |
| T4b breaker open + source down + window elapsed → `degraded`, no throw | `:199` | pass | ✓ PASS |
| T4c readable cache, key absent → copy not served | `:217` | pass | ✓ PASS |
| T4d readable cache, newer forget mark → copy refused | `:229` | pass | ✓ PASS |
| T4e mark read fails, breaker closed → copy refused | `:242` | pass | ✓ PASS |
| T4f forget that deletes a plane document refuses the copy | `service-forget.test.ts:688` | pass | ✓ PASS |
| T4g snapshot saved before a forget never served when a live source fails | `service-forget.test.ts:592` | pass | ✓ PASS |
| T4h SWR does not serve a last-good saved before a forget | `service-forget.test.ts:611` | pass | ✓ PASS |
| T4i snapshot saved after the forget still served | `service-forget.test.ts:626` | pass | ✓ PASS |
| T4j mark cannot be read → snapshot refused (source failing, cache readable) | `service-forget.test.ts:648` | pass | ✓ PASS |
| T4k mark cannot be written → every snapshot refused until a later forget | `service-forget.test.ts:668` | pass | ✓ PASS |
| T4l connect cooldown reported, expires; breaker refusal starts none | `cache.test.ts:1256` | pass | ✓ PASS (sequence evidence for the scope note) |
| T5 default fail-open; fail-closed in enforce; HTTP 503 with integer Retry-After | `admission.test.ts:325,:334`; `http.admission.test.ts:274` | pass | ✓ PASS |
| T6 shadow bypass / enforce refusal | `admission.test.ts:341` | pass | ✓ PASS |
| T7 only a breaker refusal is policed | `admission.test.ts:350,:243` | pass | ✓ PASS |
| T8 flag parse and boot refusal | `admission.test.ts:365,:375` | pass | ✓ PASS |
| T9 flag registry and config reference match | not re-run; `flag-registry.ts` and `docs/config-reference.md` unchanged since `6e5d766e` | carried | ✓ PASS (carried) |

Mutation evidence: the `d1a5e89b` author's record of a mutation of the forget guard is cited as the author's record, not as an observation here.

### Probe Execution

No `scripts/*/tests/probe-*.sh` exists, and the phase declares none. Not a migration or tooling phase. Not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R2 | none (no PLAN.md exists) | Reuse the cache-plane breaker and bounded timeouts; on outage, reads fall back to the documented source or report degradation; writes that cannot be made durable are rejected with retryable errors; no authoritative state lives only in the cache | ? NEEDS HUMAN / ORPHANED (unowned) | The read-fallback clause is evidenced by truths 1 to 4 and 5. The write clause ("reject writes that cannot be made durable with retryable errors") is outside the two ROADMAP criteria and no test in this phase covers it. No plan claims HARD-R2. Requirement stays `[ ]`. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (added lines, covered files and tests) | - | `TODO`, `FIXME`, `XXX`, `HACK`, `PLACEHOLDER`, `TBD` | - | None in the `d1a5e89b`, `f0f3c04e` or `a46d42c3` added lines in covered files. |
| `docs/observability.md:230` | - | Window described without the failed-mark-read rule | resolved | `bb6b38b7` added "A forget mark that cannot be read while the breaker is closed refuses the copy too." The gap in the prior record is closed. The cooldown window is not described there; see R5. |
| `docs/config-reference.md` | snapshot TTL row | double period "at once.." | ℹ️ Info | Cosmetic; generator appends `. See` to a text ending in `.`. File unchanged. Not a gap. |
| `75-CONTEXT.md` | D75-2a, Verified facts, R3 | stale anchors: `config.ts:1849` (now `:1874`), `cache.ts:335` (now `:342`), `slo.ts:359` (now `:360`), `service.ts` ranges | ℹ️ Info | Documentation drift only. Not edited. |

### Human Verification Required

H-1 is CLOSED by the owner decision and the commits `9e6fa1f2`, `9c86ffab`, `e185cd8a`, `42e3cf13`, and `d1a5e89b` (failed-mark-read rule and test). It is no longer a human item.

Open human items (none verifiable by grep or targeted tests):

- **H-2** (operator live proof): stop live Dragonfly with default flags; `POST /brief` and `POST /memory/recall` answer 200 with authoritative content, within the timeout, and cache health reports degraded.
- **H-3** (operator live proof): with `SUBSTRATE_BUDGETS=enforce` and `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed`, a real open breaker yields 503 `cache_unavailable` with integer `Retry-After` and one `refused` increment; first 5 s of each open cycle admitted as bypass (O2).
- **H-4a** (operator live proof): `substrate.admission.decisions{decision="refused"}` is visible in `/metrics`, the OTel/Greptime export and dashboards, with surface and class labels, outside the limited-rate numerator (`slo.ts:360`). Not re-checked in this pass.
- **H-4b** (owner item O1): the operator accepts the fail-closed read policy consequence (CONTEXT D75-2).
- **H-5** (owner item O2): decide the connect-cooldown window for fail-closed classes. Two consequences of the declared rule now appear in this pass, both inside the same 5 s window: a fail-closed class admits as `bypass` (`admission.ts:386` does not see a cooldown error as a breaker refusal), and the in-process last-good copy is refused as "forgotten" (`cache.ts:906`) while the breaker is open. Owner decides whether either changes. Kept NOT FIXED; no code change made here.

HARD-R2 write clause: unowned.

### Gaps Summary

No FAILED truth, no MISSING or STUB artifact, no NOT_WIRED link, no blocker anti-pattern. No `gaps:` block is emitted. Status is `human_needed` by the Step 9 rule: human items exist (H-2, H-3, H-4, H-5), and HARD-R2 is unowned. `passed` is not valid while the live proofs and owner items are open.

The truth 4 scope note (connect cooldown) is not a gap in the sense of the Step 9 rule: the copy is refused, never served stale, and the owner item O2 already covers the cooldown window. It is recorded so that the literal "(a) served while the breaker is open" is not read as holding during the cooldown.

### Residual Risks

- **R1** (carried, predates phase 75 H-1 work): `staleGenerations` lives in the writing process. After a restart or on another replica, a generation key can still hold its old value, and a brief written before the write can be served until its TTL (`CACHE_TTL["brief"]`, 5 minutes). Tests cover one process only. Follow-up.
- **R4** (owner trade-off): while the cache cannot be read (breaker open), this process's in-process last-good brief can outlive a forget made by another process. It is bounded by `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` (default 3600 s), held at most 256 argument sets, and refused at once for this process's own forgets. Once the cache is readable again its forget mark decides. Stated in `docs/observability.md:230` and the flag row (`flag-registry.ts:632`).
- **R5** (new, O2 window): for the 5 s after a connect failure that opens a breaker, the mark read is refused by the cooldown error and the in-process copy is not served (truth 4 scope note). Fail-safe. Not covered by a test that runs `bunRedis` with the breaker open. Owner item O2 / H-5.
- The recall-snapshot leg (`SUBSTRATE_BRIEF_RECALL` enforced) has no in-process copy and no cache-breaker-open test in the tree as far as grep shows. Not claimed as covered.
- Load-failure reporting after a positive budget (`cache.ts:703-717`) is not reported; only the zero-budget branch reports (`cache.ts:706`). No phase 75 truth claims reporting. Noted for completeness.

### Self-check

- Covered list and digest copied verbatim from `verification.fingerprint` at `a46d42c3` (run read-only; `git status` clean before and after).
- Every cited testcase was checked against the r36 JUnit by parsing the XML: one match on name, file and line, no `failure`, `error` or `skipped` child.
- Frontmatter `status: human_needed`, same vocabulary as the prior record.
- Not run: any test, `tsc`, lint, formatters, any edit or commit in the worktree.

---

_Verified: 2026-11-06T00:45:00Z_
_Verifier: Claude (gsd-verifier)_
