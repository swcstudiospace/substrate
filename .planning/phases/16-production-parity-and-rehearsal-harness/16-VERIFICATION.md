---
phase: 16-production-parity-and-rehearsal-harness
verified: 2026-10-08T21:50:00Z
status: passed
score: 23/23 must-haves verified
covered_files: [".planning/REQUIREMENTS.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-01-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-01-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-02-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-02-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-03-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-03-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-04-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-04-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-05-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-05-SUMMARY.md", "README.md", "docs/observability.md", "docs/rehearsal.md", "docs/runbooks/production-parity.md", "infra/vps/substrate-mcp.service", "package.json", "packages/mcp-server/src/rehearsal-env.test.ts", "packages/mcp-server/src/rehearsal-env.ts", "scripts/parity-check.test.ts", "scripts/parity-check.ts", "scripts/rehearsal.test.ts", "scripts/rehearsal.ts"]
covered_digest: "v3:sha256:fa080363f0276e6880cfe6e4343da55a14178be55c0262532e716e5fc33ea133"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 16: Production Parity and Rehearsal Harness Verification Report

**Phase Goal:** Production `substrate-mcp` serves the code on `main`, and every later proof has an isolated twin of it to rehearse against before anything live runs.
**Verified:** 2026-10-08T21:50:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

Must-haves merged from all five PLAN frontmatters (23 truths) plus the 4 ROADMAP Success Criteria (each SC covered by at least one plan truth).

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | 16-01 SC-1 scratch-env contract: buildRehearsalEnv output boots main's server entry point on scratch loopback port with per-surface tokens | ✓ VERIFIED | `rehearsal-env.ts:134-163` emits exactly the keys `loadConfig` reads; round-trip test through real `loadConfig` with zero warnings passes (14 env tests green) |
| 2 | 16-01 SC-2 isolation by construction: loopback scratch hosts only, no inherited keys, never reads /etc/substrate/substrate.env | ✓ VERIFIED | Empty-record start + PATH/HOME/BUN_* allowlist (`:134-163`); `assertLoopback` on both store URLs; sentinel leak + exact-key-set tests pass |
| 3 | 16-01 Anonymous shape: --anonymous variant builds zero-token env, loadConfig reports allowAnonymous true | ✓ VERIFIED | `consumerEnvRecord` anonymous path + test asserting `allowAnonymous` with zero operator tokens (in 14-test suite) |
| 4 | 16-01 Operator ⊆ tokens: operator surface token is a surface token value, never swarm-* | ✓ VERIFIED | `assertOperatorAllowed` (`:91-101`) + swarm-refusal test; `configWarnings` empty asserted |
| 5 | 16-02 SC-3 machine check: parity:check exits 0 only on active unit, stable MainPID owning 127.0.0.1:7410, healthz 200, main-verdict | ✓ VERIFIED | 23-test fixture table (one test per verdict rule) passes; `main` gathers systemctl/ss/procfs/healthz/git read-only |
| 6 | 16-02 SC-4 reproducibility: --json mode + --expect-restarts/--expect-start flags | ✓ VERIFIED | Flags present in `parity-check.ts`; JSON reading recorded in runbook proof row (MainPID 1525582, NRestarts 0, start epoch 1791479652) |
| 7 | 16-02 Warnings never fail: unit-file diff and substrate-* inventory are notes | ✓ VERIFIED | Verdict-table test `warnings-never-fail` passes; proof-run notes record unit diff + collector inventory without flipping PASS |
| 8 | 16-02 Flagged assumption: no further edge predicate beyond five criteria; operator window recorded as baseline | ✓ VERIFIED | Runbook header records operator, ~17:14 UTC 2026-10-08, stray pid 3149064, source CONTEXT Operator answers |
| 9 | 16-03 SC-1 one-command twin: `rehearsal up` / `down` manage scratch twin | ✓ VERIFIED | `scripts/rehearsal.ts` (1016 lines) implements up/down/status/smoke; live proof `p16-proof` up→down recorded in runbook with clean teardown |
| 10 | 16-03 Adjacency edge: different --name fully isolated; same-name second up refuses | ✓ VERIFIED | Label `substrate.rehearsal=<name>` scoping + run-dir/port isolation in code; `parseName` + label-filter teardown tests pass |
| 11 | 16-03 Empty edge: bare invocation exits 2; down with no prior up exits 0 | ✓ VERIFIED | Guard tests pass; SUMMARY records live `bun run rehearsal` exit 2 and `down --name rh-nobody-here` exit 0 with no residue |
| 12 | 16-03 Ordering edge: smoke runs brief→emit→register→claim in fixed order, one line per step | ✓ VERIFIED | Smoke order in `runSmoke` (`:909-959`); proof recorded 4/4 ok in order |
| 13 | 16-03 Idempotency edge: down idempotent; second same-name up refuses while running | ✓ VERIFIED | `mayStop` + state.json pid checks; guard-table + CLI subprocess tests pass |
| 14 | 16-03 Concurrency edge: parallel named instances isolate; crashed up kills only own pid | ✓ VERIFIED | Label-scoped `removeLabelledContainers` (`:348-358`), verified-pid stop with pre-KILL re-verify (`:736-745`); no group signals (grep confirms) |
| 15 | 16-03 SC-2 wire proof shape: smoke drives brief/emit/register/claim with rh- ids, refuses 7410/non-loopback, prints scalars only | ✓ VERIFIED | `refuseSmokeUrl` before any fetch (`:909-910`); run-tagged ids; proof 4/4 with claimed true + decision granted |
| 16 | 16-04 SC-1 documented: docs/rehearsal.md states commands, consumer.env contract, isolation | ✓ VERIFIED | `docs/rehearsal.md` (7525 B) holds five-key consumer.env table (`:118-122`), flags, exit triple, isolation-first |
| 17 | 16-04 SC-4 documented: runbook records check, readings table, window, install, rollbacks, rh- probes, boundary | ✓ VERIFIED | `docs/runbooks/production-parity.md` (10701 B): header, twin-vs-stray, dated readings, operator install, both rollbacks, rh- probes, who-does-what |
| 18 | 16-04 README points at both docs with relative links in Running voice | ✓ VERIFIED | `README.md:102,104` relative links to both docs |
| 19 | 16-04 Two meanings of rehearsal stated apart | ✓ VERIFIED | Harness-vs-CHAOS_REHEARSAL paragraph in `docs/rehearsal.md:152` + cross-reference in `docs/observability.md:306` |
| 20 | 16-05 SC-2 isolated proof: up→smoke→loopback ss→down, no residue | ✓ VERIFIED | Runbook SC-2 section: tag `rh-p16-proof-mv00v314`, 4/4 smoke, loopback-only peers, empty label-filtered listing, run dir gone |
| 21 | 16-05 Concurrency live half: proof coexists with production 7410; scratch index tests pass | ✓ VERIFIED | Scratch index live tests 68/0 against SUBSTRATE_TEST_PG_URL recorded; production untouched (truth 23) |
| 22 | 16-05 SC-3 live evidence: parity:check output recorded as criterion 3/4 evidence | ✓ VERIFIED | Operator-approved evidence (2026-10-08 ~20:40 UTC): exit 0 PASS, MainPID 1525582 owns :7410, healthz 200 — recorded values-free, not re-run |
| 23 | 16-05 SC-2 zero-write evidence: rh- counts 0 in production Greptime and Postgres | ✓ VERIFIED | Operator-approved evidence: Greptime agent_events rh-% = 0, Postgres graph_index/nodes/steps rh-% = 0 — recorded, not re-run |

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
| `packages/mcp-server/src/rehearsal-env.ts` | env constructor (220 lines) | ✓ VERIFIED | exports buildRehearsalEnv, assertLoopback, stores/consumer records, toShellExports, LEDGER_KEYS |
| `packages/mcp-server/src/rehearsal-env.test.ts` | 14 tests | ✓ VERIFIED | round-trip, allowlist leak, refusals, anonymous, operator — all pass |
| `scripts/parity-check.ts` | parsers + verdict + CLI (425 lines) | ✓ VERIFIED | 5 pure parsers + parityVerdict + read-only main under import.meta.main |
| `scripts/parity-check.test.ts` | 23 fixture tests | ✓ VERIFIED | one test per verdict rule, RESEARCH §8 fixtures, all pass |
| `scripts/rehearsal.ts` | up/down/status/smoke CLI (1016 lines) | ✓ VERIFIED | imports 16-01 builder; --no-env-file spawn; label-scoped teardown; no GREPTIME_ substring |
| `scripts/rehearsal.test.ts` | 32 guard tests | ✓ VERIFIED | mayStop table, refusals, spawn argv, CLI subprocess exits — all pass |
| `package.json` | rehearsal + parity:check entries | ✓ VERIFIED | both entries present, no dependency change |
| `infra/vps/substrate-mcp.service` | ConditionPathExists guard | ✓ VERIFIED | guard line present; StartLimitIntervalSec=0 + StateDirectory unchanged |
| `docs/rehearsal.md` | harness topic doc | ✓ VERIFIED | contract table, flags, exits, naming distinction |
| `docs/runbooks/production-parity.md` | parity runbook + filled evidence | ✓ VERIFIED | window, readings (2 rows), install, 2 rollbacks, rh- probes, SC-2 proof, both 0 counts |
| `README.md` | Running paragraph links | ✓ VERIFIED | 2 relative links |
| `docs/observability.md` | 1 disambiguating sentence | ✓ VERIFIED | +1 line, nothing else |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| rehearsal-env.ts | config.ts loadConfig | every emitted key is a key loadConfig reads; tokenEnvName import | ✓ WIRED | `tokenEnvName` imported (`:16`); round-trip test proves the link at runtime |
| rehearsal-env.test.ts | store-lock.test.ts | computed keys + short identifiers keep scans green | ✓ WIRED | 18/18 lock tests pass with both files present |
| parity-check.ts | systemctl/ss/procfs/git | order-independent parsing, --no-optional-locks git | ✓ WIRED | 23 fixture tests prove parsers; grep: 0 state-changing verbs, every git argv has --no-optional-locks |
| parity-check.ts | production-parity.md | --json readings feed runbook | ✓ WIRED | proof row holds MainPID/NRestarts/start/healthz from the approved run |
| rehearsal.ts | rehearsal-env.ts | imports buildRehearsalEnv + record builders | ✓ WIRED | import at `:31`, call at `:623`; no ledger key named in harness |
| rehearsal.ts | index.ts entry | detached --no-env-file spawn | ✓ WIRED | spawn argv builder (`:174`) contains --no-env-file + entry path |
| rehearsal.ts | consumer.env | later proofs source it, hardcode nothing | ✓ WIRED | five-key contract fixed in code + doc; smoke reads only consumer.env |
| docs/rehearsal.md | consumer.env keys | exact five-key list | ✓ WIRED | all five keys in table (`:118-122`); stores.env discipline stated |
| README.md | both docs | relative links | ✓ WIRED | both links resolve to created files |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| rehearsal-env.ts | store URLs, tokens | caller-supplied scratch inputs (Docker-assigned ports, generated secrets) | ✓ | ✓ FLOWING — asserts loopback, never inherits production |
| parity-check.ts | MainPID, healthz, shas | live systemctl/ss/procfs/GET/git reads | ✓ | ✓ FLOWING — pure verdict over gathered facts; proof row shows real values |
| rehearsal.ts smoke | brief/emit/register/claim results | wire responses from scratch twin | ✓ | ✓ FLOWING — proof 4/4 recorded with claimed/decision scalars |
| runbook evidence | readings, counts | operator-approved live runs | ✓ | ✓ FLOWING — values-free PIDs/epochs/counts recorded with actor + date |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Phase unit tests (4 files) | `bun test rehearsal-env + store-lock + rehearsal + parity-check tests` | 99 pass / 0 fail | ✓ PASS |
| Typecheck | `bunx tsc --noEmit` | clean, exit 0 | ✓ PASS |
| Live harness proof / parity:check / rh- counts | — | NOT re-run: operator-approved evidence recorded 2026-10-08 ~20:40 UTC; constraints forbid port-7410/production-store/docker contact | ? SKIP (operator evidence accepted) |

### Probe Execution

No phase-declared probe scripts (`scripts/*/tests/probe-*.sh`); not a migration/tooling phase with probe markers. Section N/A.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|--------------|-------------|--------|----------|
| FOUND-01 | 16-01, 16-03, 16-04, 16-05 | Isolated rehearsal harness on scratch port/stores with surface tokens + teardown | ✓ SATISFIED | builder + CLI + docs + live isolated proof with clean teardown |
| FOUND-03 | 16-02, 16-04, 16-05 | Production parity with operator approval: stray retired, runbook + rollback | ✓ SATISFIED | read-only check + runbook + approved PASS reading + window record |

Orphan check: REQUIREMENTS.md maps exactly FOUND-01 and FOUND-03 to Phase 16; both appear in plan frontmatter (16-01/16-03/16-04/16-05 and 16-02/16-04/16-05 respectively; 16-05 `requirements-completed` lists both). No orphaned requirements. (16-02/16-03/16-04 left `requirements-completed: []` by orchestrator instruction since 16-05 seals the evidence — every ID is still accounted for.)

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | None: no TODO/FIXME/XXX/TBD/PLACEHOLDER/"Not implemented"/empty-return/console.log-only in the three implementation files | — | — |

Review advisory: 16-REVIEW.md reports 0 critical / 8 warning / 9 info, all disposition `open` (recorded, not triaged). The warnings (partial-health accepted, default-operator swarm path, flag-value fallback, disk-floor fail-open, /tmp trust, system.slice stop, pid dedup, register isError) are genuine hardening items but none falsifies a must-have truth or roadmap SC on the evidenced paths — the happy-path proof succeeded and teardown was clean. They are non-blocking advisories for a later hardening pass, not gaps in this phase's goal.

### Human Verification Required

None. The two live-evidence items (parity:check PASS, rh- 0 counts) were operator-approved and recorded 2026-10-08 ~20:40 UTC; no visual, UX, or real-time behavior needs human judgment.

### Gaps Summary

No gaps. All 23 must-haves verified against the codebase with test evidence (99 pass / 0 fail across the four phase test files, tsc clean), wiring evidence (imports, spawn argv, label scoping, read-only git/healthz paths), and recorded operator-approved live evidence for the three production-touching truths. Security 14/14 closed; validation nyquist-compliant; review 0 critical.

---

_Verified: 2026-10-08T21:50:00Z_
_Verifier: Execute16.Verify16_
