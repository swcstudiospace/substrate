---
phase: 78-cross-layer-reconciliation
verified: 2026-11-02T18:27:55Z
status: human_needed
score: 1/2 must-haves verified in code; SC2 UNCERTAIN (owner decision: repair result units and corpus-rule scope); 4 live proofs human_needed
tree: /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD c7788f9d
criteria_source: this tree's ROADMAP, Phase 78 section. origin/main has identical success-criteria text but different Status and Plans lines, so its section does not match this tree's; reported below
covered_files: [
    ".planning/phases/78-cross-layer-reconciliation/78-01-PLAN.md",
    ".planning/phases/78-cross-layer-reconciliation/78-CONTEXT.md",
    ".planning/phases/78-cross-layer-reconciliation/78-SUMMARY.md",
    "docs/reconcile.md",
    "docs/runbooks/corpus-sync.md",
    "packages/corpus/src/protocol.ts",
    "packages/mcp-server/src/admission.ts",
    "packages/mcp-server/src/cache.ts",
    "packages/mcp-server/src/config.test.ts",
    "packages/mcp-server/src/config.ts",
    "packages/mcp-server/src/corpus/reconcile.ts",
    "packages/mcp-server/src/flag-registry.ts",
    "packages/mcp-server/src/greptime.ts",
    "packages/mcp-server/src/index-store.ts",
    "packages/mcp-server/src/reconcile-main.test.ts",
    "packages/mcp-server/src/reconcile-main.ts",
    "packages/mcp-server/src/reconcile-read.test.ts",
    "packages/mcp-server/src/reconcile-read.ts",
    "packages/mcp-server/src/reconcile-repair.test.ts",
    "packages/mcp-server/src/reconcile-repair.ts",
    "packages/mcp-server/src/reconcile-run.ts",
    "packages/mcp-server/src/reconcile.test.ts",
    "packages/mcp-server/src/reconcile.ts",
    "packages/mcp-server/src/service.test.ts",
    "packages/mcp-server/src/service.ts",
    "scripts/reconcile.ts"
  ]
covered_digest: "v3:sha256:22bfbf767638293cfedc24b5b4f3c44dc93126de2461af56994538a36cfb14a1"
behavior_unverified: 1
overrides_applied: 0
re_verification:
  previous_record: "78-VERIFICATION.md at tree 749e97e3 (re-verification), status human_needed, 1/2 verified, SC2 UNCERTAIN"
  reason: "Re-verification at HEAD c7788f9d. No phase 78 file changed since 749e97e3: the only tree delta in packages, scripts and docs is phase 76 (event-buffer.ts, event-dead-letter.ts and its test, service-event-buffer.test.ts, docs/greptime-ledger.md) and service.ts, which shifted the reconcile block by about 8 lines (tick now service.ts:4067-4072). Every citation is re-read on this tree. SC2 stays UNCERTAIN. The corpus delete rules were compared point by point this pass and show two divergences not in the prior record: a per-run bound and an audit record (W7, W8)."
  gaps_closed:
    - "The prior record's advisory on the memory-window edge is re-read: the audit is awaited after the row insert and before the reply (service.ts:3259, :3289). The prior text said the audit came after the reply; corrected (advisory below)"
  gaps_remaining:
    - "WARNING 1: the repair result sets listed (plan item count, 1 for any repair with orphans) against repaired (keys removed) (reconcile-repair.ts:139, :192-196, :51)"
    - "WARNING 2: the flush removes every answer, counter and mark under substrate:v1:*, not the orphan graphs' keys (reconcile-repair.ts:15, :212-220); recorded as D78-5, kept open"
    - "WARNING 3: no tick test runs a cache-off fixture; the cache-off line is covered by runReport (reconcile-read.test.ts:391) only"
    - "WARNING 7 (new): the corpus rule bounds a run at 500 repairs (packages/corpus/src/protocol.ts:262; corpus/reconcile.ts:171); the flush has no per-run bound on removed keys (scan refusal only, at 1000000 keys)"
    - "WARNING 8 (new): the corpus rule audits execute as corpus_ingest, fail-closed (admission.ts:253); the reconcile repair writes no audit event on any path"
    - "Live-only checks: interval firing and single-flight, Dragonfly SCAN and UNLINK at production counts, GreptimeDB queryEvents in a busy window, a live CLI run"
  regressions: []
behavior_unverified_items:
  - truth: "Single-flight: a scheduled tick that starts while a run is in flight starts no second run (service.ts:4068-4071, reconcilePass ??=)"
    test: "Start the server with SUBSTRATE_RECONCILE_INTERVAL_S=60 over a clean fixture. Start a second tick while the first is in flight (or force one with a slow ledger read)"
    expected: "Exactly one run is in flight. The second tick returns the in-flight promise and writes no second line. Neither run writes to the ledger, the index or the cache"
    why_human: "No test covers the guard. The interval cadence is real time and no test fires setInterval. This is an ordering invariant that presence and wiring cannot show"
advisory:
  - finding: "A write whose memory row is created before the window start but whose audit event is stamped after it is reported as an accepted audit event with no index row (false drift at the window edge)"
    category: other
    reason: "Both sides use one sinceIso (reconcile-run.ts:51). The index side filters memory_entries.created >= sinceIso (index-store.ts:2955); the ledger side filters ts >= since (greptime.ts:1533). The row is written inside governMemoryWrite (service.ts:3259) and its audit is awaited after the insert, before the reply (auditMemoryWrite at service.ts:3289). A write that straddles the window start therefore appears on the ledger side only. Narrow: only writes in the emit latency before the boundary. Not repaired, because the report never repairs memory; it only makes the run unclean"
    evidence_status: "none provided: code read only [INFERENCE from the call order]; not reproduced"
human_verification:
  - test: "Staging host with SUBSTRATE_RECONCILE_INTERVAL_S=60 over a clean fixture: let one interval fire, then start a second tick while the first is in flight. Compare ledger, index and cache write counts before and after"
    expected: "Each tick writes one '[substrate] reconcile {...}' line with clean:true. No ledger, index or cache write. The second tick starts no second run"
    why_human: "The interval cadence is real time and no test fires the interval. The single-flight guard (service.ts:4068-4071) has no test. The tick body is covered by service.test.ts:5871"
  - test: "Live Dragonfly with the server stopped, on a copy of production key counts: repair --plan <file> (dry run), then repair --plan <file> --execute --server-stopped"
    expected: "The dry run writes nothing. The execute removes answers, then generation counters, then the forget mark, and keeps budget: and emb: keys. A prefix above 1000000 keys refuses with nothing removed. <plan>.result.json shows repaired against listed"
    why_human: "Real SCAN and UNLINK cost and behaviour at production counts (H5) cannot be exercised by a unit test"
  - test: "Live GreptimeDB queryEvents for claim, warning and note kinds in a busy window"
    expected: "The lease comparison completes, or reports truncated when a node exceeds LOOKUP_LIMIT (100) rows or the lookup count passes the cap of 200"
    why_human: "Needs a live ledger with real volume"
  - test: "Live CLI run with real stores: report; repair --plan <file> --execute without --server-stopped; a dry run; repair --plan <file> --execute --server-stopped"
    expected: "Exit codes match docs/reconcile.md: report 0 or 1, usage and missing config 2, refused or failed repair 1. Missing --server-stopped exits 2 before any connection. The result file holds executed, refused, repaired, listed and error"
    why_human: "Needs live PG, GreptimeDB and Dragonfly"
---

# Phase 78: Cross-layer reconciliation Verification Report

**Phase goal:** The ledger, the index and the cache agree, and any drift is reported with evidence. No drift is repaired destructively without a confirmed plan.
**Verified:** 2026-11-02T18:27:55Z
**Status:** human_needed
**Re-verification:** Yes, at HEAD c7788f9d (previous record at 749e97e3)
**Scope:** the integration tree at `c7788f9d`. Procedure: gsd-verifier, goal-backward. Live proofs are operator items and stay human_needed. Owner-held decisions stay open.

## Criteria and conflicts

- **Criteria source used:** this tree's ROADMAP, Phase 78 section. The brief's rule uses origin/main only when its phase text matches this tree's. The success criteria match exactly, but the Status and Plans lines do not, so the rule selects this tree. The prior record used origin/main; this pass corrects that. The verdicts do not depend on the choice.
- **Difference reported, not chosen:** origin/main says `Status: Not started` and `Plans: none written`. This tree says `human_needed (verified on gsd/v18-int-all 7382ad10; live items open)` and links 78-01 and 78-CONTEXT. The phase directory holds a plan and a summary, so origin/main's section is stale. The owner should reconcile the ROADMAP.
- **Naming deviation (no criterion failure):** 78-CONTEXT.md D78-6 names the plan's window field `window`. The code writes `window_hours` (reconcile-repair.ts:42, :102).
- **Recorded amendment:** 78-CONTEXT.md D78-5 specifies a whole-prefix delete. The code runs three ordered passes (reconcile-repair.ts:212-220). The amendment is recorded in 78-SUMMARY.md and STATE.md Run 17. CONTEXT is not edited. See Open decisions.
- **Gate evidence (orchestrator, not re-run here):** `/root/src/worktrees/backups/gates-int-r8.log` opens with `PG_READY port=59689 head=c7788f9d`. TSC_EXIT=0 (line 8); LINT_EXIT=0 (line 11); bun test 12051 pass, 2 skip, 0 fail (lines 16738-16740); PY_EXIT=0 (line 16772); phase-close 239 pass, 0 fail (lines 16776-16777); GATES_DONE rc=0 (line 16782).
- **Tree delta since 749e97e3:** the packages, scripts and docs delta is six files, all phase 76 (event-buffer.ts, event-dead-letter.ts and its test, service-event-buffer.test.ts, service.ts, docs/greptime-ledger.md). No phase 78 file changed: `reconcile*.ts`, `cache.ts`, `index-store.ts`, `config.ts`, `flag-registry.ts`, `scripts/reconcile.ts`, `docs/reconcile.md`, `package.json` and the reconcile tests are unchanged. `service.ts` gained lines above the reconcile block, so its citations are re-read.

## Must-haves

| # | Criterion (this tree's ROADMAP) | Verdict | Evidence on this tree |
| - | ------------------------------- | ------- | --------------------- |
| 1 | A scheduled reconcile reports per-layer counts and the first mismatching key, and writes nothing on a clean run | VERIFIED in code and by test; live cadence and single-flight human_needed | Counts: reconcile-run.ts:55-96 (ledger 56, 60; index 64, 75, 80; cache 87-96). First key: reconcile.ts:193-194 (`firstOf`) and :205-209 (`first`). Comparators: reconcile.ts:82-119 (lease), :129-153 (memory), :162-174 (generation). Scheduled line: service.ts:4089-4090 carries `schema`, `generated_at`, `clean`, `counts`, `truncated`, `unchecked_layers`, `first`. Writes per tick: one stdout line (service.ts:4090); stderr only on skip (:4077) and failure (:4092). Read-only path: `runReport` calls `queryEvents` (greptime.ts:1519-1538, a SELECT), index SELECTs only (index-store.ts:2924-2981), and cache SCANs only (cache.ts:1061-1079). `unlinkKeys` has one caller, reconcile-repair.ts:193. Clean-run no-write proof: service.test.ts:5871-5936 (proxies at :5874-5891 throw on any non-read call; asserts one stdout line, `clean:true`, empty stderr and empty `writes` at :5925-5931). Cadence: `startReconcile` is off at interval 0 (service.ts:4052), with one unref'd `setInterval` (:4053-4054); `stopReconcile` clears it (:4061-4064); test service.test.ts:5860. Config: config.ts:1616-1623 (interval min 60, window 1 to 168); flag-registry.ts:986-987 |
| 2 | Repair is a separate confirmed step with a plan record, following the corpus delete rules | UNCERTAIN (owner decision; WARNINGS 1, 2, 7, 8) | Mechanics verified. A separate `repair` subcommand, dry run by default (reconcile-repair.ts:167-176). Execute needs `--server-stopped`, a usage error with exit 2 before any client (reconcile-main.ts:93-94, called at :150 before `loadConfig` at :158; reconcile-repair.ts:177-186). Plan record: `planFromReport` (reconcile-repair.ts:86-106; schema :100, `report_digest` :103), written with `wx` (reconcile-main.ts:190). Digest recheck (reconcile-repair.ts:141-150); orphan recheck and plan-item check (:151-165, `planRefusal` :112-123). Flush: scan once (:199), refuse on truncation (:200-209), three ordered passes (:212-220). Removed count is the server's UNLINK reply (cache.ts:1096-1101); only confirmed removals reach `repaired` (reconcile-repair.ts:192-196). Result file `<plan>.result.json` (reconcile-main.ts:212-220). Corpus-rule conformance is point by point in the next table: most rules hold; the unit mismatch (WARNING 1), the per-run bound (WARNING 7) and the audit record (WARNING 8) do not |

Must-haves: 1 of 2 verified in code. SC2 is UNCERTAIN, with its mechanics verified and its reporting rule and corpus scope held for an owner decision. No truth FAILED. Human items are non-empty, so status is `human_needed`.

## SC2: the corpus delete rules, point by point

The corpus rules are in `docs/runbooks/corpus-sync.md` (§2 lines 60-70 and §5 lines 120-121) and implemented in `packages/mcp-server/src/corpus/reconcile.ts`. The bound is `RECONCILE_MAX_ITEMS = 500` in `packages/corpus/src/protocol.ts:262`.

| # | Corpus rule | Corpus evidence | Reconcile evidence | Verdict |
| - | ----------- | --------------- | ------------------ | ------- |
| R1 | Dry run first; reads and changes nothing | corpus-sync.md:47 and :60; `reconcileCorpus(deps, execute)` (corpus/reconcile.ts:202) | Dry run default (reconcile-repair.ts:167-176); `plan` writes only `--out` (reconcile-main.ts:187-191) | MET |
| R2 | Explicit execute | corpus-sync.md:63 (`--execute`) | `--execute --server-stopped` (reconcile-main.ts:93-94) | MET |
| R3 | Act only on what the plan names; an orphan an active row holds is kept | corpus-sync.md:67-68; `deleteOrphans` keeps ids with `activeReferences > 0` (corpus/reconcile.ts:119) | Plan is pinned by digest and the live orphan set, so a change refuses the whole plan (reconcile-repair.ts:141-165). The flush is by class, not by named key: it removes every counter, including live graphs' counters (:216), and every answer class (:212-215). Divergence, recorded as D78-5 and WARNING 2 | PARTLY MET; owner decision |
| R4 | Delete confirmed by the store; an unconfirmed delete is not counted | corpus-sync.md:68-69; `deleteOrphans` counts `outcome.deleted` filtered to asked ids (corpus/reconcile.ts:127-130) | Count is the server's UNLINK reply (cache.ts:1096-1101), added to `repaired` only per batch (reconcile-repair.ts:192-196) | MET |
| R5 | At most 500 of each repaired per run | corpus-sync.md:70; `RECONCILE_MAX_ITEMS = 500` (packages/corpus/src/protocol.ts:262), applied with `slice` (corpus/reconcile.ts:170-171) | None. The flush removes every key under `substrate:v1:*` it finds, in one run. The only bound is the scan refusal at 1000000 keys (reconcile-repair.ts:18, :200-209) | NOT MET as written (WARNING 7; owner decision on whether the bound applies to a cache flush) |
| R6 | `repaired` is read against the listed orphans; a shortfall means run it again | corpus-sync.md:69; `listed` is `orphansInPlane`, and `repaired.deleted` counts the same unit (corpus/reconcile.ts:190-195) | `listed` is `plan.items.length`, which is 1 for any repair with orphans (reconcile-repair.ts:139, reported at :51). `repaired` is keys removed (:192-196). The units differ, so the shortfall check cannot read as the corpus rule means it (WARNING 1) | NOT MET as written (owner decision on the unit) |
| R7 | Audit: the dry run is audited as `corpus_status` (fail-open); the execute as `corpus_ingest` (fail-closed) | corpus-sync.md:75-76; `corpus_status` read and `corpus_ingest` write (admission.ts:252-253) | No audit call on any repair path (reconcile-main.ts:181-232 and reconcile-repair.ts; `grep` for audit and emit in the reconcile files finds none). The record is the `<plan>.result.json` file only (reconcile-main.ts:212-220) | NOT MET as written (WARNING 8; owner decision on whether the result file is the record) |
| R8 | Serialised with ingest by the corpus lock | corpus-sync.md:76; `withCorpusLock` (corpus/reconcile.ts:202-203) | `--server-stopped` is an operator assertion, not checked (reconcile-main.ts:93-94). Already an open decision | OPEN (operator assertion; recorded) |
| R9 | Re-run is safe: a second run finds nothing | corpus-sync.md:78-79 (proof: dry run again) | Second execute refuses with no orphans left (reconcile-repair.ts:151-160); test "a second execute after the first finds nothing and is a no-op" (reconcile-repair.test.ts:176) | MET |

Reading: R1, R2, R4 and R9 hold as written. R3 holds in its digest form and diverges in its per-key form, which the owner accepted as D78-5. R5, R6 and R7 do not hold as written. Each is a point the owner must settle. This verifier does not downgrade SC2 to FAILED on them, because whether the corpus rules bind a cache flush (where the cache is derived and the deletes are not data loss) is a design question the owner holds. If the owner rules that they bind, SC2 fails on R5 and R7 and the fix is code, not a decision.

## Sub-checks, by test (this pass)

| Sub-check | Verdict | Evidence |
| --------- | ------- | -------- |
| Scheduled tick on a clean fixture logs one clean line and writes nothing | PASS | service.test.ts:5871 (targeted run 1) |
| Interval 0 starts no timer; 60 starts one; stop clears it; start is idempotent | PASS | service.test.ts:5860 (run 1) |
| Dirty fixture reports the first mismatching key per comparison | PASS | reconcile-read.test.ts:362 (run 2) |
| Clean fixture is clean, `unchecked_layers` empty, nothing written | PASS | reconcile-read.test.ts:343 (run 2) |
| Cache off: layer unchecked, absent from counts, classes truncated, run not clean | PASS | reconcile-read.test.ts:391; reconcile.test.ts:188 "unchecked layers are reported as given, and the run is not clean" (run 2) |
| Lease identity only (surface, session, epoch); both free is not drift; epoch not compared while free | PASS | reconcile.test.ts:41, :52, :61, :70, :79, :87 (run 2). Code: reconcile.ts:82-119 |
| A newest release frees the key even when an older grant exists | PASS | reconcile-read.test.ts:236 (run 2). Reader: reconcile-read.ts:135-150, :157-188 |
| A hold granted before the window is found by node, with no time bound | PASS | reconcile-read.test.ts:222 (run 2). Run: reconcile-run.ts:67-72 |
| A latest-lease lookup past its cap is truncated (not clean) | PASS | reconcile-read.test.ts:231 (run 2) |
| A lookup whose rows run out before any transition is truncated | PASS | reconcile-read.test.ts:246 (run 2) |
| A scan that reaches its cap reports truncated and returns at most the cap | PASS | reconcile-read.test.ts:263 (run 2) |
| Unlink runs in batches of at most 500 and returns the count removed; a failed batch keeps earlier batches | PASS | reconcile-read.test.ts:280, :288 (run 2). Code: cache.ts:1087-1102 |
| Dry run writes nothing; digest mismatch refuses; other-match plan item refuses | PASS | reconcile-repair.test.ts:106, :116, :288 (run 2) |
| Orphan gone refuses and writes nothing; plan item with another action refuses | PASS | reconcile-repair.test.ts:130, :300 (run 2) |
| Plan naming an orphan the fresh report does not list refuses | PASS | reconcile-repair.test.ts:312 (run 2) |
| Plan with no generation orphans refuses | PASS | reconcile-repair.test.ts:141 (run 2) |
| Config: interval blank and 0 are off; 1 to 59 clamp to 60; 99999999999 clamps to 2147483; invalid refuses boot; window clamps 0 to 1 and 169 to 168 | PASS | config.test.ts:730-775 (run 3, 9 tests) |

Note: every PASS was run in the three targeted commands below, or read in code and named as such.

## Repair sub-checks

| Sub-check | Verdict | Evidence |
| --------- | ------- | -------- |
| Execute removes answers, then counters, then the mark; budget and emb untouched | PASS | reconcile-repair.test.ts:157 (run 2); classes :21-28; passes :212-220 |
| Second execute is a no-op | PASS | reconcile-repair.test.ts:176 (run 2) |
| Truncated or incomplete scan removes nothing | PASS | reconcile-repair.test.ts:188 (run 2); :200-209 |
| Failure in the answer, counter or mark pass keeps the later keys in place | PASS | reconcile-repair.test.ts:209, :228, :250 (run 2) |
| Failed batch keeps the count of earlier batches; failing scan reports the failure | PASS | reconcile-repair.test.ts:330, :351 (run 2); cache.ts:1087-1102 |
| Execute without `--server-stopped` refuses and removes nothing | PASS | reconcile-repair.test.ts:270 (run 2); reconcile-main.test.ts:104 (exit 2, no client) (run 2) |
| `--server-stopped` with another command exits 2 | PASS | reconcile-main.test.ts:113 (run 2) |
| Failed flush exits 1 and writes the result file with the error | PASS | reconcile-main.test.ts:52 (run 2); reconcile-main.ts:221-224 |
| Only destructive call on this path is `unlinkKeys` | PASS by reading | Single caller reconcile-repair.ts:193, after the server-stopped gate (:177-186). Report and readers call `queryEvents`, index SELECTs and `scanKeys` only |
| Flush excludes `budget:` and `emb:` keys, and any unnamed key | PASS by reading | `FLUSH_ANSWER_CLASSES` :21-28; partition :212-217; `CACHE_CLASSES` (cache.ts:71) lists all nine classes, so an unnamed `substrate:v1` key has `classOf` null (cache.ts:75-82) and is not removed |

## Behavioral spot-checks (Step 7b, re-run this pass)

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Repair `--execute` without `--server-stopped` exits 2 before any connection | `env -u SUBSTRATE_PG_URL -u GREPTIME_URL -u DRAGONFLY_URL -u SUBSTRATE_CACHE bun scripts/reconcile.ts repair --plan /nonexistent.json --execute` | "reconcile: --execute needs --server-stopped", rc 2 | PASS |
| Unknown subcommand exits 2 | `... bun scripts/reconcile.ts bogus` | "unknown subcommand: (positional)", rc 2 | PASS |
| `plan` without `--out` exits 2 | `... bun scripts/reconcile.ts plan` | "plan needs --out <file>", rc 2 | PASS |
| Report with no `SUBSTRATE_PG_URL` exits 2 and reads nothing | `... bun scripts/reconcile.ts report` | "SUBSTRATE_PG_URL is not set; the reconcile reads the index", rc 2 | PASS |
| Live report, scheduled tick against real stores | not run: needs live PG, GreptimeDB, Dragonfly | none | ? SKIP, see human items |

## Targeted tests (run this pass)

Each command ran once, serially, from `packages/mcp-server`, with `TMPDIR=/root/src/worktrees/backups/gate-tmpfs` and `SUBSTRATE_TEST_PG_URL` unset. No Postgres container was started. Three `bun test` commands in total. Each was filtered by name with `-t`.

| # | Command | Result |
| - | ------- | ------ |
| 1 | `bun test service.test.ts -t "scheduled reconcile timer"` | 2 pass, 339 filtered out, 0 fail, 9 expect calls. Covers service.test.ts:5860 and :5871 |
| 2 | `bun test reconcile.test.ts reconcile-read.test.ts reconcile-repair.test.ts reconcile-main.test.ts -t '<names>'`. The name filter lists the comparators, `buildReport`, the readers, `runReport`, the scan and unlink tests, the repair tests and the CLI tests by name | 69 pass, 23 filtered out, 0 fail, 247 expect calls, "Ran 69 tests across 6 files" |
| 3 | `bun test config.test.ts -t "SUBSTRATE_RECONCILE"` | 9 pass, 96 filtered out, 0 fail, 36 expect calls |

Totals across the three commands: 80 pass, 0 fail, 0 skip. No PG-gated test was in these filters. The single-flight guard has no test and was not exercised.

Not run by the verifier (per the brief): the full suite, tsc, lint, formatters, the gate. The gate evidence cited above is the orchestrator's run on this HEAD.

## Known-defect check (cache off makes the report read clean)

Not reproduced on this tree.

- `scanKeys` returns `{keys: [], truncated: true}` when the cache is off (cache.ts:1064).
- `runReport` detects an off cache when every class scan and the generation scan are empty and truncated (reconcile-run.ts:91). A live empty scan is never truncated: the loop runs until the cursor returns to 0 or the key count passes the cap, so a truncated scan always holds keys (cache.ts:1068-1078).
- The counts guard omits every `cache.*` count when off (reconcile-run.ts:93-96). `uncheckedLayers` names `cache` (:97) and reaches the report (:112). `buildReport` is unclean while any `truncated` flag is set (reconcile.ts:195, :210).
- The CLI refuses a cache-off config before reading (reconcile-main.ts:106, :163-167).

## Artifacts

| Artifact | Status | Evidence |
| -------- | ------ | -------- |
| `packages/mcp-server/src/reconcile.ts` | VERIFIED | Comparators :82-174; `buildReport` :186-212 |
| `packages/mcp-server/src/reconcile-run.ts` | VERIFIED | `runReport` :49-115; caps :32; counts :55-96 |
| `packages/mcp-server/src/reconcile-read.ts` | VERIFIED | Window rows :100-111; ledger leases :135-150; latest-lease lookup :157-188; memory :194-206; index leases :212-229 |
| `packages/mcp-server/src/reconcile-repair.ts` | VERIFIED (mechanics); unit, bound and audit held for the owner (SC2, WARNINGS 1, 7, 8) | Plan :86-106; gating :112-123; execute :134-235 |
| `packages/mcp-server/src/reconcile-main.ts` | VERIFIED | Args :74-98 (execute gate :93-94); `missingConfig` :101-108; `openReconcileClients` :111-127; `parsePlan` :130-138; `reconcileMain` :144-232 |
| `packages/mcp-server/src/service.ts` | VERIFIED | `startRecall` :4034-4038; `stopRecall` :4041-4044; `startReconcile` :4050-4058; `stopReconcile` :4061-4064; `reconcileTick` (single flight) :4067-4072; `runScheduledReconcile` :4075-4094 |
| `packages/mcp-server/src/cache.ts` | VERIFIED | `CACHE_CLASSES` :71; `classOf` :75-82; `scanKeys` :1061-1079; `unlinkKeys` :1087-1102 |
| `packages/mcp-server/src/index-store.ts` | VERIFIED | Reconcile SELECTs only :2924-2981 |
| `packages/mcp-server/src/config.ts` | VERIFIED | `ReconcileSettings` :1599-1604; `loadReconcileSettings` :1616-1623; wired at :1238 |
| `packages/mcp-server/src/flag-registry.ts` | VERIFIED | Both `SUBSTRATE_RECONCILE_*` entries :986-987 |
| `scripts/reconcile.ts` | VERIFIED | Thin wrapper, explicit exit. `package.json` script `reconcile` |
| `docs/reconcile.md` | VERIFIED | Line 26 names `unchecked_layers` on the scheduled line; passes :38-44; exit codes :65 |
| `docs/runbooks/corpus-sync.md` | VERIFIED as the rule source | §2 :45-79; §5 :115-121 |
| Test files | VERIFIED | Named tests in the targeted runs above |

## Key links

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `scripts/reconcile.ts` | `reconcileMain` | import and call, `process.exit(code)` | WIRED | scripts/reconcile.ts |
| `reconcileMain` | `parseReconcileArgs` | before `loadConfig` (reconcile-main.ts:150, :158) | WIRED | usage errors exit 2 before config |
| `reconcileMain` (repair) | `executePlan` | with `serverStopped` (reconcile-main.ts:204) | WIRED | |
| `executePlan` | `cache.unlinkKeys` with callback | per pass (reconcile-repair.ts:190-197) | WIRED | |
| `executePlan` | `runReport` | re-run before any write (reconcile-repair.ts:140) | WIRED | |
| `startRecall` | `startReconcile` | service.ts:4036, called from index.ts:196 | WIRED | |
| `stopRecall` | `stopReconcile` | service.ts:4042, called from index.ts:234 | WIRED | |
| `startReconcile` | `reconcileTick` | `setInterval` (service.ts:4053) | WIRED; interval firing untested | |
| `reconcileTick` | `runScheduledReconcile` | single flight `??=` (service.ts:4068) | WIRED; single flight untested | |
| `runScheduledReconcile` | `runReport` | `DEFAULT_RECONCILE_CAPS` (service.ts:4081-4088) | WIRED | |
| `runReport` | `cache.scanKeys` | class and generation scans (reconcile-run.ts:85-90) | WIRED | |
| `service.ts` lease grant | ledger claim event | `emit` with `session_id` and `lease_epoch` (service.ts:5424-5445, `lease_epoch` at :5439); index write `claim_session`, `lease_epoch` (index-store.ts:1426-1435) | WIRED | field names match the reader (reconcile-read.ts:114-127) |

## Data-flow (Level 4)

The report renders live reads: ledger `queryEvents` (greptime.ts:1519-1538), index SELECTs (index-store.ts:2924-2981) and cache SCANs (cache.ts:1061-1079), combined at reconcile-run.ts:55-96. Off cache renders no count. The flush reads the live `substrate:v1:*` keys and removes only those it classifies (reconcile-repair.ts:198-220). No hardcoded result feeds these values.

## Integration facts judged on this tree

- **Tree delta since 749e97e3.** Phase 76 only (see Criteria and conflicts). `service.ts` shifted by about 8 lines above the reconcile block. Judged neutral to phase 78: the reconcile code paths are unchanged, and the scheduled-tick test still passes (run 1).
- **Lazy live-session facade (634b6171).** The tick test's index is a read-only proxy (service.test.ts:5874-5891). It throws on any non-read property, so an eager `liveSessions` read in the constructor would fail the tick test. The reconcile path never reads `liveSessions`, so the change is neutral to the reconcile.

## Anti-patterns (Step 7)

Debt-marker scan (TODO, FIXME, XXX, HACK, PLACEHOLDER, "not yet implemented", "coming soon") over `packages/mcp-server/src/reconcile*.ts`, `scripts/reconcile.ts` and `docs/reconcile.md`, run this pass: no matches. No debt-marker gate fires.

Warning-level findings are listed in Warnings below; none is a stub.

## Probe execution (Step 7c)

No `scripts/*/tests/probe-*.sh` exists for this phase, and no PLAN or SUMMARY declares a probe. Skipped: no probes declared.

## Warnings (non-blocking)

1. **Repair result units differ (SC2, owner decision).** `listed` is `plan.items.length` (reconcile-repair.ts:139, reported at :51), which is 1 for any repair with orphans. `repaired` counts keys removed (:192-196). The corpus compares the same unit on both sides (orphan documents listed, orphan documents deleted: corpus/reconcile.ts:190-195), so the corpus shortfall check reads correctly and this one does not. Owner decision: count `listed` in the unit the flush removes (for example, the orphan counters it expects to remove), or accept the mismatch. Human item 2 expects this comparison; it reads as a count pair, not as a verdict.
2. **Flush scope is the whole prefix (SC2, owner decision).** The plan names `match: substrate:v1:*` and the orphans (reconcile-repair.ts:91-97). The flush selects by class, not by the orphan graph (:212-217). Answer keys carry no graph id (D78-5), so this is the recorded design, not a defect. Under the corpus reading "act only on what the plan names", it is a deliberate divergence. Kept open; see Open decisions.
3. **No tick test runs a cache-off fixture.** The cache-off line is covered by runReport (reconcile-read.test.ts:391), and the scheduled line copies `unchecked_layers` (service.ts:4089). Low risk, since the line copies the report field.
4. **Advisory: index read cost.** `reconcileHolds` reads every `graph_nodes` row of the graphs in a 500-key batch and filters in JS (index-store.ts:2924-2934). Correct, but O(rows of those graphs). H5 covers scan cost; this is the index-side analogue [INFERENCE from the SQL; not measured].
5. **Advisory: the repair is gated on one live generation orphan, not on a clean report.** A truncated report can still produce a plan (reconcile-run.ts:88-90). The flush is fail-closed on its own 1000000-key scan (reconcile-repair.ts:198-209). Recorded as the D78-6 reading.
6. **Advisory: window-edge false drift.** See the advisory frontmatter entry. A write straddling the window start is reported as a ledger-side memory finding. Not tested; code-order reasoning only.
7. **Repair has no per-run bound (SC2, owner decision; new this pass).** The corpus rule caps a run at 500 repairs of each kind (corpus-sync.md:70; `RECONCILE_MAX_ITEMS = 500`, packages/corpus/src/protocol.ts:262; applied at corpus/reconcile.ts:170-171). The flush has no equivalent: it removes every matching key in one run, with only the 1000000-key scan refusal (reconcile-repair.ts:18, :200-209). This is a cache flush, so the bound may not transfer; the owner must say which. Stays open.
8. **Repair leaves no audit record (SC2, owner decision; new this pass).** The corpus runbook says a dry run is audited as `corpus_status` and an execute as `corpus_ingest`, fail-closed (corpus-sync.md:75-76; admission.ts:252-253). No reconcile path emits an audit event; the record is `<plan>.result.json` only (reconcile-main.ts:212-220). The result file is an operator-readable record, but it is not in the audit chain. Owner decision: accept the file as the record, or add an audit event before the flush (fail-closed).

## Open decisions (kept open)

- **Cache layer reported as unchecked, not zero.** Recorded: 78-SUMMARY.md "Decisions carried from the context" (decided in 0d896577, delegated by the owner); STATE.md Run 17 owner decision (2). The code matches the decision (reconcile-run.ts:91-97). This pass checked that the code does what is recorded, not that the choice is right. Stays open for the owner.
- **Memory overlap with `consistency-verify.ts` not converged.** Recorded: 78-SUMMARY.md; docs/reconcile.md:67; STATE.md Run 17 owner decision (3). The report's memory check is the ledger-to-index window comparison (reconcile-run.ts:59-61, :74-77; compareMemory reconcile.ts:129-153). Stays open for the owner.
- **Whole-prefix flush and the ordered three passes (D78-5, amended in ee1c9534).** Recorded in STATE.md Run 17 and 78-SUMMARY.md. Warning 2 above. Stays open for the owner to ratify. This is also the reading of "act only on what the plan names" that SC2 depends on.
- **Repair result units (D78-6 "repaired against listed").** Warning 1 above. Stays open: the owner chooses the unit or accepts the mismatch. SC2 stays UNCERTAIN until then.
- **Which corpus rules bind a cache flush (SC2; new this pass).** The corpus rules include a 500-per-run bound (Warning 7) and an audit record (Warning 8). The reconcile follows neither. The owner must rule: (a) the corpus rules bind and the code must change (add a bound and an audit event), so SC2 would fail on those points until it does; or (b) the corpus rules cover the plan, dry run, explicit execute, confirmed-delete and re-run rules only (R1, R2, R4, R9), and D78-5 and D78-6 are the design of record. The verifier has not chosen.
- **`--server-stopped` as an operator assertion (D78-6, amended).** The code cannot check the server is stopped (reconcile-main.ts:93-94; reconcile-repair.ts:177-186). Same convention as `consistency-run`. Stays open.
- **ROADMAP status line.** origin/main and this tree disagree (see Criteria and conflicts). Not chosen; the owner should reconcile.

## Human Verification Required

1. **Scheduled interval: one clean tick, and single-flight.** Start with `SUBSTRATE_RECONCILE_INTERVAL_S=60` over a clean fixture. Let one interval fire, then start a second tick while the first is in flight. Compare ledger, index and cache write counts before and after. Expected: one clean line per tick, no writes, no second run. Why human: real-time cadence and the single-flight guard (service.ts:4068-4071) have no test. This is also the behavior-unverified item.
2. **Live Dragonfly SCAN and UNLINK at production counts**, server stopped, on a copy of the key counts: `repair --plan <file>` (dry run), then `repair --plan <file> --execute --server-stopped`. Expected as in the frontmatter. Why human: H5 cost and behaviour at scale. The comparison of `repaired` with `listed` is the owner's call (Warning 1).
3. **Live GreptimeDB `queryEvents` in a busy window.** Expected: completes, or reports `truncated` at `LOOKUP_LIMIT` 100 or the lookup cap of 200. Why human: needs live ledger volume.
4. **Live CLI run with real stores.** Expected: exit codes per docs/reconcile.md; missing `--server-stopped` exits 2 before any connection; the result file holds `executed`, `refused`, `repaired`, `listed`, `error`. Why human: needs live PG, GreptimeDB and Dragonfly.

## Gaps Summary

**Blocking gaps: none.** No truth FAILED. No artifact MISSING or STUB. No key link NOT_WIRED. SC1 is verified in code and by the targeted tests. SC2's mechanics are verified in code and by the targeted tests. Its reporting rule ("repaired against listed") is UNCERTAIN for the owner, and its corpus-rule scope has two further points (a per-run bound and an audit record) that the owner must rule on. Whole-prefix scope is also held.

**Status:** `human_needed`, from the four human items. Warnings 1 to 8 do not change the status. Owner-held decisions stay open.

## Summary claims checked (78-SUMMARY.md)

| Claim | Result | Evidence |
| ----- | ------ | -------- |
| Lease comparison is identity only | TRUE | reconcile.ts:82-119 |
| Memory compared both ways over the window | TRUE | reconcile.ts:129-153; reconcile-run.ts:74-77 |
| Generation orphans compare `gen:graph:<id>` with `graph_index` | TRUE | reconcile.ts:162-174; reconcile-run.ts:98-103 |
| Caps `ledgerRows` 500, `ledgerLookups` 200, `indexRows` 5000, `cacheKeys` 10000 | TRUE | reconcile-run.ts:32 |
| Cache off: layer listed in `unchecked_layers`, counts omitted, classes truncated, never clean | TRUE | reconcile-run.ts:91-97, :112; reconcile-read.test.ts:391 |
| `scanKeys` reports `truncated` when off; `unlinkKeys(keys, onBatch?)` | TRUE | cache.ts:1064; cache.ts:1087 |
| Timer off by default; each tick one read-only report and one line with `counts`, `truncated`, `unchecked_layers`, `first`, `clean` | TRUE | service.ts:4052-4053; config.ts:1616-1623; service.ts:4089-4090 |
| Flush: `substrate:v1:*` scanned once, refused when incomplete, three ordered passes, budget and emb never removed | TRUE | reconcile-repair.ts:15, :18, :21-28, :199-220 |
| Execute needs `--server-stopped`; dry run is the default | TRUE | reconcile-main.ts:93-94; reconcile-repair.ts:167-186 |
| Tick test exists and passes | TRUE | service.test.ts:5871; targeted run 1 |
| The scheduled-line doc correction is in | TRUE | docs/reconcile.md:26 |
| Gate results (12051 pass, 2 skip, 0 fail) | Not re-run this pass; orchestrator's log on this HEAD | gates-int-r8.log lines 7 and 16738-16740 (`head=c7788f9d`) |
| "Gate runs were voided once by a full root filesystem" | Not checked; no artifact read beyond the r8 log | [INFERENCE] from the summary text |

---

_Verified: 2026-11-02T18:27:55Z_
_Verifier: Claude (gsd-verifier, re-verification at HEAD c7788f9d)_
