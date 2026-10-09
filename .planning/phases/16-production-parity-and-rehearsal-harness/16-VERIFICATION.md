---
phase: 16-production-parity-and-rehearsal-harness
verified: 2026-10-08T22:04:03Z
status: passed
score: 23/23 must-haves verified
covered_files: [".planning/REQUIREMENTS.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-01-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-01-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-02-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-02-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-03-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-03-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-04-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-04-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-05-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-05-SUMMARY.md", "README.md", "docs/observability.md", "docs/rehearsal.md", "docs/runbooks/production-parity.md", "infra/vps/substrate-mcp.service", "package.json", "packages/mcp-server/src/rehearsal-env.test.ts", "packages/mcp-server/src/rehearsal-env.ts", "scripts/parity-check.test.ts", "scripts/parity-check.ts", "scripts/rehearsal.test.ts", "scripts/rehearsal.ts"]
covered_digest: "v3:sha256:4d2678e587681dca5d6cf964e4a6dd77df6667197030666deb550239d10c9b4a"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 23/23
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 16: Production Parity and Rehearsal Harness Verification Report

**Phase Goal:** Production `substrate-mcp` serves the code on `main`, and every later proof has an isolated twin of it to rehearse against before anything live runs.
**Verified:** 2026-10-08T22:04:03Z
**Status:** passed
**Re-verification:** Yes — prior report (2026-10-08T21:50:00Z, 23/23 passed) went stale after 14 review-fix commits (`c576adf`..`50625c9`, WR-01..08 + IN-03/07/08/09). This report re-verifies all 23 must-haves against HEAD `50625c9`.

## Goal Achievement

### Observable Truths

Must-haves merged from all five PLAN frontmatters (23 truths) plus the 4 ROADMAP Success Criteria (each SC covered by at least one plan truth).

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | 16-01 SC-1 scratch-env contract: buildRehearsalEnv output boots main's server entry point on scratch loopback port with per-surface tokens | ✓ VERIFIED | `rehearsal-env.ts` unchanged since prior pass; round-trip test through real `loadConfig` with zero warnings passes (113 targeted tests green). Fresh live proof: `p16-verify` twin booted the checkout entry on 127.0.0.1:17410 |
| 2 | 16-01 SC-2 isolation by construction: loopback scratch hosts only, no inherited keys, never reads /etc/substrate/substrate.env | ✓ VERIFIED | Builder untouched by review fixes; sentinel leak + exact-key-set tests pass; no `substrate.env`/`LINEAR_API_KEY`/`NOTION_API_KEY` reference in builder (grep clean) |
| 3 | 16-01 Anonymous shape: --anonymous variant builds zero-token env, loadConfig reports allowAnonymous true | ✓ VERIFIED | Builder anonymous path + test pass; harness side hardened by IN-07 fix (`parseOperator` now throws on `--anonymous` + `--operator` conflict instead of silently ignoring) |
| 4 | 16-01 Operator ⊆ tokens: operator surface token is a surface token value, never swarm-* | ✓ VERIFIED | `assertOperatorAllowed` + swarm-refusal test pass; WR-02 fix closes the default-operator hole (default first surface now refused when swarm) and converts builder throws to exit-2 refusal with container cleanup |
| 5 | 16-02 SC-3 machine check: parity:check exits 0 only on active unit, stable MainPID owning 127.0.0.1:7410, healthz 200, main-verdict | ✓ VERIFIED | 23 fixture tests + new WR-07 dedup test pass; observed live during this re-verify: `ss` shows pid 1525582 (MainPID) on 127.0.0.1:7410 alongside the scratch twin — production untouched |
| 6 | 16-02 SC-4 reproducibility: --json mode + --expect-restarts/--expect-start flags | ✓ VERIFIED | Flags present in `parity-check.ts` (unchanged); JSON reading recorded in runbook proof row (MainPID 1525582, NRestarts 0, start epoch 1791479652), not re-run per constraints |
| 7 | 16-02 Warnings never fail: unit-file diff and substrate-* inventory are notes | ✓ VERIFIED | `warnings-never-fail` test passes; IN-09 fix documents the expected post-rollback FAIL (server-path drift by design) in the runbook |
| 8 | 16-02 Flagged assumption: no further edge predicate beyond five criteria; operator window recorded as baseline | ✓ VERIFIED | Runbook header still records operator, ~17:14 UTC 2026-10-08, stray pid 3149064, source CONTEXT Operator answers |
| 9 | 16-03 SC-1 one-command twin: `rehearsal up` / `down` manage scratch twin | ✓ VERIFIED | Fresh live proof this run: `up --name p16-verify` → http://127.0.0.1:17410 → `down` stopped pid 2432082, removed 2 containers, run dir gone. WR-01 fix gates `up` on fully healthy twin (`isTwinHealthy`: index+ledger+writable, tested) |
| 10 | 16-03 Adjacency edge: different --name fully isolated; same-name second up refuses | ✓ VERIFIED | Label `substrate.rehearsal=<name>` scoping + run-dir/port isolation intact; `parseName` + label-filter teardown tests pass; fresh run used label `substrate.rehearsal=p16-verify` |
| 11 | 16-03 Empty edge: bare invocation exits 2; down with no prior up exits 0 | ✓ VERIFIED | Guard tests pass; WR-03 fix strengthens this: missing flag values (`down --name` with no value) now refuse instead of falling back to `default` (`flag()` returns null on missing/flag-like value, tested) |
| 12 | 16-03 Ordering edge: smoke runs brief→emit→register→claim in fixed order, one line per step | ✓ VERIFIED | Smoke order in `runSmoke` intact; fresh proof recorded 4/4 ok in order (`brief, emit, register, claim — claimed true decision granted`) |
| 13 | 16-03 Idempotency edge: down idempotent; second same-name up refuses while running | ✓ VERIFIED | `mayStop` + state.json pid checks intact; WR-06 fix adds the stoppability pre-check: `up` now refuses when the twin would not be stoppable (e.g. system.slice inheritance), killing only the verified spawn |
| 14 | 16-03 Concurrency edge: parallel named instances isolate; crashed up kills only own pid | ✓ VERIFIED | Label-scoped `removeLabelledContainers`, verified-pid stop; `c576adf` + WR-06 work replaced blind `killOwn` in up failure paths with `killVerifiedSpawn` (re-checks pid/start/argv/cwd, tested with non-matching pid returning false) |
| 15 | 16-03 SC-2 wire proof shape: smoke drives brief/emit/register/claim with rh- ids, refuses 7410/non-loopback, prints scalars only | ✓ VERIFIED | Fresh smoke used run-tagged id `rh-p16-verify-mv031ow0`; IN-03 fix extends the guard to bracketed IPv6 loopback (`[::1]`) and all production ports (`PRODUCTION_PORTS`, tested); WR-08 fix fails smoke on `isError: true` tool results (`smokeToolResult` now exported + tested) |
| 16 | 16-04 SC-1 documented: docs/rehearsal.md states commands, consumer.env contract, isolation | ✓ VERIFIED | IN-08 fix realigned docs with code: state.json holds container *names*, operator has no separately generated token (own surface bearer token), exit-2 vs exit-1 refusal split documented. Five-key consumer.env table intact |
| 17 | 16-04 SC-4 documented: runbook records check, readings table, window, install, rollbacks, rh- probes, boundary | ✓ VERIFIED | Runbook (226 lines) intact: header, twin-vs-stray, dated readings (17:14 discuss read + 20:40 proof run), operator install, both rollbacks + IN-09 expected-FAIL note, rh- probes, who-does-what |
| 18 | 16-04 README points at both docs with relative links in Running voice | ✓ VERIFIED | `README.md:102,104` relative links intact (untouched by review fixes) |
| 19 | 16-04 Two meanings of rehearsal stated apart | ✓ VERIFIED | Harness-vs-CHAOS_REHEARSAL paragraph + `docs/observability.md:306` cross-reference intact (untouched) |
| 20 | 16-05 SC-2 isolated proof: up→smoke→loopback ss→down, no residue | ✓ VERIFIED | Fresh re-proof this run supersedes the recorded one: tag `rh-p16-verify-mv031ow0`, 4/4 smoke, loopback-only listeners (127.0.0.1:17410 + production 127.0.0.1:7410), label-filtered listing empty after down, run dir gone, port 17410 silent |
| 21 | 16-05 Concurrency live half: proof coexists with production 7410; scratch index tests pass | ✓ VERIFIED | Fresh run coexisted with production 7410 (MainPID 1525582 still owner, untouched); recorded scratch-index live tests stand (not re-run; same builder code) |
| 22 | 16-05 SC-3 live evidence: parity:check output recorded as criterion 3/4 evidence | ✓ VERIFIED | Operator-approved evidence intact in runbook (2026-10-08 ~20:40 UTC): exit 0 PASS, MainPID 1525582 owns :7410, healthz 200 — recorded values-free, not re-run per constraints |
| 23 | 16-05 SC-2 zero-write evidence: rh- counts 0 in production Greptime and Postgres | ✓ VERIFIED | Operator-approved evidence intact: Greptime agent_events rh-% = 0, Postgres graph_index/nodes/steps rh-% = 0 — recorded, not re-run per constraints |

**Score:** 23/23 truths verified (0 present-but-behavior-unverified)

### Roadmap Success Criteria mapping

| SC | Roadmap criterion | Status | Covering truths |
|----|-------------------|--------|-----------------|
| SC-1 | One command starts main's substrate-mcp on scratch port vs scratch stores with configurable tokens; one command tears down | ✓ VERIFIED | 1, 9–14, 16 |
| SC-2 | Brief + emit + claim succeed against harness; production stores receive no row | ✓ VERIFIED | 2, 15, 20, 21, 23 |
| SC-3 | Unit PID owns 127.0.0.1:7410, restarts stopped, /healthz answers from main | ✓ VERIFIED | 5, 22 |
| SC-4 | Runbook records check + rollback; read-only re-run reproduces SC-3 | ✓ VERIFIED | 6, 7, 17, 22 |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/rehearsal-env.ts` | env constructor (220 lines) | ✓ VERIFIED | untouched by review fixes; exports intact |
| `packages/mcp-server/src/rehearsal-env.test.ts` | 14 tests | ✓ VERIFIED | pass within 113-test targeted run |
| `scripts/parity-check.ts` | parsers + verdict + CLI (425 lines) | ✓ VERIFIED | WR-07 one-line dedup (`new Set`); 23+1 fixture tests pass |
| `scripts/parity-check.test.ts` | 24 fixture tests (was 23) | ✓ VERIFIED | new dedup test (one owner, two fds + IPv6 loopback) passes |
| `scripts/rehearsal.ts` | up/down/status/smoke CLI (was 1016, now 1098 lines) | ✓ VERIFIED | 8 warning + 3 info fixes; imports 16-01 builder; --no-env-file spawn; label-scoped teardown; no GREPTIME_ substring outside established LEDGER_KEYS pattern (which lives in rehearsal-env.ts, not here) |
| `scripts/rehearsal.test.ts` | 47 guard tests (was 32) | ✓ VERIFIED | new suites: killVerifiedSpawn, isTwinHealthy, ensurePrivateDir, flag-missing-value, smokeToolResult-isError, IPv6/prod-ports — all pass |
| `package.json` | rehearsal + parity:check entries | ✓ VERIFIED | both entries present, no dependency change |
| `infra/vps/substrate-mcp.service` | ConditionPathExists guard | ✓ VERIFIED | guard line present; StartLimitIntervalSec=0 + StateDirectory unchanged |
| `docs/rehearsal.md` | harness topic doc (157 lines) | ✓ VERIFIED | IN-08 realignment applied; contract table, flags, exits, naming distinction |
| `docs/runbooks/production-parity.md` | parity runbook + filled evidence (226 lines) | ✓ VERIFIED | IN-09 expected-FAIL note added; readings, window, install, rollbacks, rh- probes, SC-2 proof, both 0 counts |
| `README.md` | Running paragraph links | ✓ VERIFIED | 2 relative links |
| `docs/observability.md` | 1 disambiguating sentence | ✓ VERIFIED | +1 line, nothing else |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| rehearsal-env.ts | config.ts loadConfig | every emitted key is a key loadConfig reads; tokenEnvName import | ✓ WIRED | round-trip test passes; fresh twin booted the real entry point |
| rehearsal-env.test.ts | store-lock.test.ts | computed keys + short identifiers keep scans green | ✓ WIRED | store-lock tests pass with both files present (in 113-test run) |
| parity-check.ts | systemctl/ss/procfs/git | order-independent parsing, --no-optional-locks git | ✓ WIRED | 24 fixture tests prove parsers; no new state-changing verbs added (WR-07 touched only Set dedup) |
| parity-check.ts | production-parity.md | --json readings feed runbook | ✓ WIRED | proof row holds MainPID/NRestarts/start/healthz from the approved run |
| rehearsal.ts | rehearsal-env.ts | imports buildRehearsalEnv + record builders (+RehearsalEnvError for WR-02) | ✓ WIRED | builder throw now caught → labelled containers removed → exit-2 refusal |
| rehearsal.ts | index.ts entry | detached --no-env-file spawn | ✓ WIRED | spawn argv builder unchanged; fresh twin booted and answered healthy /healthz |
| rehearsal.ts | consumer.env | later proofs source it, hardcode nothing | ✓ WIRED | five-key contract fixed in code + doc; fresh smoke read only consumer.env |
| docs/rehearsal.md | consumer.env keys | exact five-key list | ✓ WIRED | all five keys in table; stores.env discipline stated |
| README.md | both docs | relative links | ✓ WIRED | both links resolve to existing files |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| rehearsal-env.ts | store URLs, tokens | caller-supplied scratch inputs (Docker-assigned ports, generated secrets) | ✓ | ✓ FLOWING — asserts loopback, never inherits production |
| parity-check.ts | MainPID, healthz, shas | live systemctl/ss/procfs/GET/git reads | ✓ | ✓ FLOWING — pure verdict over gathered facts; WR-07 dedup keeps the exactly-MainPID comparison correct on dual-fd/IPv6 hosts |
| rehearsal.ts smoke | brief/emit/register/claim results | wire responses from scratch twin | ✓ | ✓ FLOWING — fresh 4/4 with claimed/decision scalars; WR-08 closes the isError hole; WR-01 requires full index+ledger+writable health |
| runbook evidence | readings, counts | operator-approved live runs | ✓ | ✓ FLOWING — values-free PIDs/epochs/counts recorded with actor + date |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Phase unit tests (4 files) | `bun test rehearsal-env + store-lock + rehearsal + parity-check tests` | 113 pass / 0 fail (was 99; +15 new review-fix tests, incl. 47-file rehearsal suite) | ✓ PASS |
| Full suite | `bun test` | 1224 pass / 56 skip / 0 fail across 43 files | ✓ PASS |
| Typecheck | `bunx tsc --noEmit` | clean, exit 0 | ✓ PASS |
| Fresh harness proof | `bun run rehearsal up --name p16-verify` → `smoke` → `down` | up 127.0.0.1:17410; smoke 4/4 (`rh-p16-verify-mv031ow0`, claimed true, decision granted); loopback-only ss; 0 labelled containers + no run dir + port silent after down; production 7410 untouched (MainPID 1525582) | ✓ PASS |
| Live parity:check / rh- counts | — | NOT re-run: operator-approved evidence recorded 2026-10-08 ~20:40 UTC; constraints forbid port-7410/production-store contact | ? SKIP (operator evidence accepted, intact in runbook) |

### Probe Execution

No phase-declared probe scripts (`scripts/*/tests/probe-*.sh`); not a migration/tooling phase with probe markers. Section N/A.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|--------------|-------------|--------|----------|
| FOUND-01 | 16-01, 16-03, 16-04, 16-05 | Isolated rehearsal harness on scratch port/stores with surface tokens + teardown | ✓ SATISFIED | builder + hardened CLI + docs + fresh isolated proof with clean teardown |
| FOUND-03 | 16-02, 16-04, 16-05 | Production parity with operator approval: stray retired, runbook + rollback | ✓ SATISFIED | read-only check (dedup fix) + runbook (+expected-FAIL note) + approved PASS reading + window record |

Orphan check: REQUIREMENTS.md maps exactly FOUND-01 and FOUND-03 to Phase 16; both appear in plan frontmatter. No orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | None: no TODO/FIXME/XXX/TBD/PLACEHOLDER/"Not implemented"/empty-return/console.log-only in the three implementation files | — | — |
| `scripts/greptime-smoke.ts` | — | GREPTIME_ substring matches | ℹ️ Info | Pre-existing file, out of phase scope; the 16-02 prohibition covers plan .ts files only (parsers/CLI), which are clean — no GREPTIME_ in parity-check.ts/rehearsal.ts, no agent_events SQL in any plan .ts |
| `packages/mcp-server/src/rehearsal-env.ts:24-27` | — | GREPTIME_ key names in LEDGER_KEYS const | ℹ️ Info | Established store-lock-exempt pattern (keys as values in one multi-line const, no value on the line); store-lock scan green |

Prohibition spot-checks: no state-changing systemctl verb added to parity-check.ts; no process-group signals in rehearsal.ts (killVerifiedSpawn → killOwn only); builder still reads no /etc/substrate/substrate.env and forwards no LINEAR/NOTION/OTEL keys; no credential/token/lease/store values printed or committed by the harness.

### Review-Dispositions (16-REVIEW-DISPOSITION.md, commit 50625c9)

8 warnings fixed (WR-01 healthy-twin gate, WR-02 swarm-operator + env-build containment, WR-03 missing-flag refusal, WR-04 disk-floor fail-closed, WR-05 run-dir hardening, WR-06 stoppability refusal, WR-07 ss dedup, WR-08 smoke isError), 4 info fixed (IN-03 smoke guard, IN-07 anonymous/operator conflict, IN-08 docs alignment, IN-09 rollback FAIL note), 4 info deferred with reasons (IN-01 CLI output-stream contract, IN-02 ls-remote env plumbing, IN-04 /proc parsing refactor, IN-05/IN-06 API/canon decisions). Open: 0. Each fix is covered by at least one new test; none regressed a must-have truth (all 23 re-verified above).

### Human Verification Required

None. The two live-evidence items (parity:check PASS, rh- 0 counts) remain operator-approved and recorded; the harness half was re-proven live by the verifier just now. No visual, UX, or real-time behavior needs human judgment.

### Gaps Summary

No gaps. All 23 must-haves verified against HEAD `50625c9` with test evidence (113 targeted pass, 1224/0 full suite, tsc clean), wiring evidence, a fresh verifier-run harness proof (`p16-verify`: up→smoke 4/4→down, no residue, production untouched), and intact operator-approved live evidence for the three production-touching truths. Review dispositions complete (12 fixed, 4 deferred with reasons, 0 open).

---

_Verified: 2026-10-08T22:04:03Z_
_Verifier: Reverify16_
