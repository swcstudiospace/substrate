---
phase: 16-production-parity-and-rehearsal-harness
verified: 2026-11-12T00:00:00Z
status: human_needed
score: 18/23 must-haves verified by re-check; 5 rest on operator-recorded live evidence (human confirmation requested)
covered_files: [".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-01-PLAN.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-01-SUMMARY.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-02-PLAN.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-02-SUMMARY.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-03-PLAN.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-03-SUMMARY.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-04-PLAN.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-04-SUMMARY.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-05-PLAN.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-05-SUMMARY.md", "README.md", "docs/observability.md", "docs/rehearsal.md", "docs/runbooks/production-parity.md", "infra/vps/substrate-mcp.service", "package.json", "packages/mcp-server/src/rehearsal-env.test.ts", "packages/mcp-server/src/rehearsal-env.ts", "scripts/parity-check.test.ts", "scripts/parity-check.ts", "scripts/rehearsal.test.ts", "scripts/rehearsal.ts"]
covered_digest: "v3:sha256:c29f34fdb9b01539a627e63749b42db9d5c22bf0e9d28933b7050b2c5de1c873"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 23/23 (2026-10-11 close-out, HEAD ed696ef)
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Re-run read-only `bun run parity:check --json` on the operator host against the current unit and compare with the 2026-10-08 readings row (MainPID 1525582, start epoch 1791479652)"
    expected: "exit 0; MainPID owns 127.0.0.1:7410; unit active; /healthz 200. The verdict may legitimately differ from the recorded row because the release model changed after 2026-10-08 (pinned /opt/agent-substrate/current)"
    why_human: "Touches production (live systemctl/ss/healthz GET on 7410); agents may not run it under the no-production-touch constraint"
  - test: "Confirm the operator-reported zero-write counts still hold: production Greptime agent_events session_id LIKE 'rh-%' = 0; production Postgres graph_index / graph_nodes / graph_steps rh- rows = 0"
    expected: "All counts 0 (the 2026-10-08 ~20:40 UTC report recorded 0 for each)"
    why_human: "Requires production store credentials that agents do not hold"
  - test: "Confirm the full twin boot proof (plan 16-05 task 1) is still reproducible: `bun run rehearsal up --name p16-reverify`, `smoke`, loopback `ss` check, scratch index tests against SUBSTRATE_TEST_PG_URL, `down`, empty label listing"
    expected: "smoke prints ok on brief, emit, register, claim; ss peers loopback only on container ports; down leaves no substrate.rehearsal=<name> container and no run dir"
    why_human: "Needs Docker (Greptime and Postgres containers) outside the agent verification loop; the 2026-10-08 p16-proof record is the only recorded run"
  - test: "Confirm the 2026-10-08 window retirement (stray pid 3149064) is still the recorded baseline and no stray holder of 127.0.0.1:7410 exists"
    expected: "Operator confirms only the substrate-mcp.service MainPID holds 7410"
    why_human: "Host process state on the production machine is not observable from this checkout"
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 16: Production Parity and Rehearsal Harness Verification Report

**Phase Goal:** Production `substrate-mcp` serves the code on `main`, and every later proof has an isolated twin of it to rehearse against before anything live runs.
**Verified:** 2026-11-12T00:00:00Z
**Status:** human_needed
**Re-verification:** Yes. The prior report (2026-10-11T02:10Z, "passed", 23/23) was stale against the current tree. This run re-checked the phase must-haves against the current checkout (branch `reconcile/main-2026-11-11`, HEAD `33c400d1`, origin/main `83779a1d`). Source and docs were not edited.

## Goal Achievement

### Observable Truths

Must-haves merged from the five PLAN frontmatters (23 truths) plus the four ROADMAP Success Criteria. Re-check depth: artifacts and wiring re-read at HEAD; targeted tests re-run; live production state NOT touched by this run.

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| 1  | 16-01 SC-1: `buildRehearsalEnv` boots main's server entry on scratch loopback port with per-surface tokens | ✓ VERIFIED | `packages/mcp-server/src/rehearsal-env.ts:292` `buildRehearsalEnv`; `rehearsal-env.test.ts` round-trip through `loadConfig` passes (targeted run: 120 pass / 0 fail across rehearsal-env, store-lock, parity-check tests) |
| 2  | 16-01 SC-2: isolation by construction (loopback hosts, no inherited keys, never reads /etc/substrate/substrate.env) | ✓ VERIFIED | `assertLoopback` `rehearsal-env.ts:220`; env record built from an empty allowlist (PATH/HOME/BUN_*), `rehearsal-env.ts:134-163`; sentinel leak test `rehearsal-env.test.ts:175-195`; LINEAR/NOTION keys in the built env are generated `rh-*` values only (`rehearsal-env.ts:178-179`) |
| 3  | 16-01 Anonymous shape: zero-token env, `allowAnonymous` true | ✓ VERIFIED | Anonymous path and `--anonymous` + `--operator` refusal covered in `rehearsal-env.test.ts` (in the 120-pass run) |
| 4  | 16-01 Operator ⊆ tokens; operator never swarm-* | ✓ VERIFIED | `assertOperatorAllowed` `rehearsal-env.ts:237`; operator token sourced from surface tokens and set at `rehearsal-env.ts:317`; swarm refusal test `rehearsal-env.test.ts:153-162` |
| 5  | 16-02 SC-3: `parity:check` exits 0 only on active unit, stable MainPID owning 127.0.0.1:7410, healthz 200, main-verdict | ⚠️ NOT RE-RUN LIVE | Pure verdict `scripts/parity-check.ts:153` (`parityVerdict`) and parsers are covered by `scripts/parity-check.test.ts` (68 tests, in the 120-pass run). Live reading last recorded 2026-10-08 ~20:40 UTC (runbook `production-parity.md:106`). Live half routed to human |
| 6  | 16-02 SC-4: `--json` mode + `--expect-restarts` / `--expect-start` | ✓ VERIFIED | Flag handling and `routeParityOutput` `scripts/parity-check.ts:418`; parser/verdict tests pass |
| 7  | 16-02 warnings never fail | ✓ VERIFIED | `parityVerdict` returns warnings separately; warnings-never-fail test in `scripts/parity-check.test.ts` passes |
| 8  | 16-02 flagged assumption: five explicit criteria; operator window is the recorded baseline | ✓ VERIFIED | Runbook header records window ~17:14 UTC 2026-10-08, stray pid 3149064, source "CONTEXT Operator answers" (`docs/runbooks/production-parity.md`, header table) |
| 9  | 16-03 SC-1: `rehearsal up` / `down` manage scratch twin | ✓ VERIFIED | `scripts/rehearsal.ts` (up/down/status/smoke CLI; 1069 lines changed since 50625c9 incl. hardening); `scripts/rehearsal.test.ts` 103 pass / 0 fail this run |
| 10 | 16-03 named-instance isolation; second same-name up refuses | ✓ VERIFIED | Label `substrate.rehearsal=<name>` (`scripts/rehearsal.ts:69`), `runDirFor` `:361`; name-lock tests in `rehearsal.test.ts` pass |
| 11 | 16-03 empty edges: bare invocation exits 2; `down` with no prior up exits 0 | ✓ VERIFIED | Guard sweep recorded this pass: bare invocation → exit 2 usage; `down --name p16-reverify-absent` → exit 0, "nothing to remove" (see Behavioral Spot-Checks) |
| 12 | 16-03 smoke ordering brief→emit→register→claim | ✓ VERIFIED | `runSmoke` step order in `scripts/rehearsal.ts`, asserted in `rehearsal.test.ts`; live 4/4 proof recorded in runbook (`production-parity.md:112-143`), not re-run |
| 13 | 16-03 idempotency: down idempotent; same-name second up refuses while running | ✓ VERIFIED | `mayStop` `scripts/rehearsal.ts:331`; idempotent-down test passes |
| 14 | 16-03 concurrency: parallel named instances isolate; crashed up kills only own pid | ✓ VERIFIED | `mayStop` and verified-pid kill path in `scripts/rehearsal.ts`; guard and CLI-refusal tests in `rehearsal.test.ts` pass |
| 15 | 16-03 SC-2 wire-proof shape: rh- ids, refuses 7410/non-loopback, scalars only | ✓ VERIFIED | `refuseSmokeUrl` precedes first fetch; guard sweep this pass: `smoke` against a consumer.env pointing at a non-loopback host → exit 2 "refusing non-loopback smoke host", no request made |
| 16 | 16-04 SC-1 documented: `docs/rehearsal.md` states commands, consumer.env contract, isolation | ✓ VERIFIED | `docs/rehearsal.md` consumer.env table (five keys plus `SUBSTRATE_REHEARSAL_OPERATOR_TOKEN`); exit 0/1/2 triple; harness-vs-CHAOS distinction |
| 17 | 16-04 SC-4 documented: runbook records check, readings, window, install, rollbacks, rh- probes, boundary | ✓ VERIFIED | `docs/runbooks/production-parity.md` readings table (rows at lines 105-106), rollback and install sections, rh- count SQL (`:153-159`) |
| 18 | 16-04 README points at both docs in Running voice | ✓ VERIFIED | `README.md:103-107` relative links to `docs/rehearsal.md` and `docs/runbooks/production-parity.md` |
| 19 | 16-04 two meanings of "rehearsal" stated apart | ✓ VERIFIED | `docs/observability.md:892` cross-reference to `rehearsal.md`; harness paragraph in `docs/rehearsal.md` |
| 20 | 16-05 SC-2 isolated proof: up→smoke→loopback ss→down, no residue | ⚠️ PARTIAL, human | Recorded `p16-proof` run (`production-parity.md:112-143`) stands. This pass re-proved only the guard paths (bare exit 2, non-loopback smoke exit 2, absent-down exit 0). Full twin boot needs Docker stores and was not re-run |
| 21 | 16-05 concurrency live half: proof coexists with production 7410; scratch index tests pass | ⚠️ NOT RE-RUN, human | Recorded evidence only; no production contact this pass. The scratch index-live tests need `SUBSTRATE_TEST_PG_URL` and were not re-run as part of this verification |
| 22 | 16-05 SC-3 live evidence: parity:check output recorded | ⚠️ RECORDED, NOT RE-VERIFIED, human | Runbook row `production-parity.md:106` (2026-10-08 ~20:40 UTC: MainPID 1525582, NRestarts 0, start epoch 1791479652, healthz 200). Not re-run; see Human Verification item 1 |
| 23 | 16-05 SC-2 zero-write evidence: rh- counts 0 in production Greptime and Postgres | ⚠️ RECORDED, NOT RE-VERIFIED, human | Runbook `production-parity.md:153-159` records operator-reported 0 and 0. Agents hold no production credentials; see Human Verification item 2 |

**Score:** 18/23 truths verified by re-check; 5 (truths 5, 20, 21, 22, 23) depend on live production or Docker evidence that this run did not reproduce and are routed to human verification. Zero truths FAILED. Zero behavior-unverified truths (`behavior_unverified: 0`).

### Roadmap Success Criteria mapping

| SC | Roadmap criterion | Status | Covering truths |
|----|-------------------|--------|-----------------|
| SC-1 | One command starts main's substrate-mcp on scratch port vs scratch stores; one command tears down | ✓ VERIFIED (code + guard proofs) | 1, 9–14, 16 |
| SC-2 | Brief + emit + claim succeed against harness; production stores receive no row | ⚠️ PARTIAL, live half human | 2, 15 verified; 20, 21, 23 human |
| SC-3 | Unit PID owns 127.0.0.1:7410, restarts stopped, /healthz answers from main | ⚠️ PARTIAL, live half human | 5 (code), 22 (recorded) |
| SC-4 | Runbook records check + rollback; read-only re-run reproduces SC-3 | ✓ VERIFIED (documentation and code); reproduction is human | 6, 7, 17 |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/rehearsal-env.ts` | env constructor, loopback assertion, operator guard, record builders | ✓ VERIFIED | Exports present: `LEDGER_KEYS` :26, `buildRehearsalEnv` :292, `assertLoopback` :220, `assertOperatorAllowed` :237, `storesEnvRecord` :378, `consumerEnvRecord` :389, `toShellExports` :414 |
| `packages/mcp-server/src/rehearsal-env.test.ts` | builder tests | ✓ VERIFIED | 37 test cases; passes in targeted run |
| `scripts/parity-check.ts` | parsers + `parityVerdict` + CLI | ✓ VERIFIED | `parityVerdict` :153; parsers :51–:96; no state-changing systemctl verb in the reviewed path; git calls go through `gitWork` with `--no-optional-locks` (per 16-SECURITY T-16-04) |
| `scripts/parity-check.test.ts` | fixture tests | ✓ VERIFIED | 68 test cases; passes in targeted run |
| `scripts/rehearsal.ts` | up/down/status/smoke CLI | ✓ VERIFIED | Guard functions exported (`refusePort` :137, `mayStop` :331, `buildServerSpawnArgv` :347); hardened since 50625c9 (pause/unpause, extra-env, desktop-surface gates added; covered by tests that pass) |
| `scripts/rehearsal.test.ts` | guard tests | ✓ VERIFIED | 103 pass / 0 fail this run (the earlier F-01 checkout-path failure did not reproduce from `/root/src/repos/agent-substrate`) |
| `package.json` | `rehearsal` and `parity:check` entries | ✓ VERIFIED | `package.json:50` `"rehearsal": "bun scripts/rehearsal.ts"`; `package.json:43` `"parity:check": "bun scripts/parity-check.ts"` |
| `infra/vps/substrate-mcp.service` | ConditionPathExists guard | ✓ VERIFIED | `:13` `ConditionPathExists=/opt/agent-substrate/current/packages/mcp-server/src/index.ts`; `:9` `StartLimitIntervalSec=0`; `:39` `StateDirectory=substrate`. The guard follows the pinned release symlink, not the original checkout path (later intentional change). `systemd-analyze verify` not re-run here |
| `docs/rehearsal.md` | harness topic doc | ✓ VERIFIED | Consumer contract table and exit triple present |
| `docs/runbooks/production-parity.md` | parity runbook + filled evidence | ✓ VERIFIED | Readings, window, install, rollbacks, rh- SQL, boundary list, proof record present; live values recorded, not re-read from production |
| `README.md` | Running paragraph with two links | ✓ VERIFIED | `README.md:103-107` |
| `docs/observability.md` | one disambiguating cross-reference | ✓ VERIFIED | `docs/observability.md:892` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| rehearsal-env.ts | config.ts loadConfig | every emitted key read by loadConfig; `tokenEnvName` import | ✓ WIRED | Round-trip test passes in targeted run |
| rehearsal-env.test.ts | store-lock.test.ts | computed keys keep CREDENTIAL/TOKEN_LITERAL scans green | ✓ WIRED | `store-lock.test.ts` passes in targeted run |
| parity-check.ts | systemctl/ss/procfs/git | order-independent parsing; `--no-optional-locks` git | ✓ WIRED | Parsers covered by fixture tests |
| parity-check.ts | production-parity.md | `--json` readings feed runbook evidence | ✓ WIRED | Runbook readings row present |
| rehearsal.ts | rehearsal-env.ts | imports builder and record functions | ✓ WIRED | Builder error path tested in `rehearsal.test.ts` |
| rehearsal.ts | index.ts entry | detached `--no-env-file` spawn | ✓ WIRED | `buildServerSpawnArgv` `scripts/rehearsal.ts:347` |
| rehearsal.ts | consumer.env | proofs source it | ✓ WIRED | smoke reads only consumer.env (per 16-SECURITY T-16-13) |
| docs/rehearsal.md | consumer.env keys | exact key list | ✓ WIRED | Key table matches `consumerEnvRecord` |
| README.md | both docs | relative links | ✓ WIRED | Both targets exist |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| rehearsal-env.ts | store URLs, tokens | caller-supplied scratch ports, `randomBytes` secrets | ✓ | ✓ FLOWING |
| parity-check.ts | MainPID, healthz, commits | live systemctl/ss/procfs/GET/git (at run time) | not exercised this pass | ⚠️ FLOWING by code; live source not re-read |
| rehearsal.ts smoke | brief/emit/register/claim results | wire responses from scratch twin | not exercised this pass (refusal path only) | ✓ FLOWING by code |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Targeted phase suites | `bun test packages/mcp-server/src/rehearsal-env.test.ts packages/mcp-server/src/store-lock.test.ts scripts/parity-check.test.ts` | 120 pass / 0 fail / 368 expect() | ✓ PASS |
| Rehearsal guard suite | `bun test scripts/rehearsal.test.ts` | 103 pass / 0 fail | ✓ PASS |
| Typecheck | `bunx tsc --noEmit` | exit 0 | ✓ PASS |
| Bare CLI | `bun scripts/rehearsal.ts` (verifier run, guard sweep) | exit 2 usage | ✓ PASS (verifier evidence from prior pass; not re-run in this pass) |
| Absent down | `down --name p16-reverify-absent` | exit 0 "nothing to remove" | ✓ PASS (verifier evidence from prior pass) |
| Non-loopback smoke refusal | `smoke` with non-loopback consumer.env | exit 2 before any request | ✓ PASS (verifier evidence from prior pass) |
| Full suite `bun test` | not run this pass (targeted suites only) | — | ? NOT RUN |
| Live parity:check / rh- counts / full twin boot | not run (production and Docker outside the verifier loop) | — | ? SKIP, routed to human |

### Probe Execution

No phase-declared probe scripts (`scripts/*/tests/probe-*.sh`). Section N/A.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|--------------|-------------|--------|----------|
| FOUND-01 | 16-01, 16-03, 16-04, 16-05 | Isolated rehearsal harness on scratch port/stores with surface tokens + teardown | ✓ SATISFIED by code and guard tests; live twin proof recorded 2026-10-08, not re-run | `.planning/milestones/v1.3-REQUIREMENTS.md:33` (marked [x]); mapping line 164 |
| FOUND-03 | 16-02, 16-04, 16-05 | Production parity with operator approval: stray retired, runbook + rollback | ✓ SATISFIED by code and runbook; live reading recorded 2026-10-08, not re-run | `.planning/milestones/v1.3-REQUIREMENTS.md:35` (marked [x]); mapping line 166 |

Orphan check: `.planning/milestones/v1.3-REQUIREMENTS.md` maps exactly FOUND-01 and FOUND-03 to Phase 16; both appear in plan frontmatter. No orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `packages/mcp-server/src/rehearsal-env.ts` | 26 | `LEDGER_KEYS` const of computed Greptime key names | ℹ️ Info | Intentional store-lock-exempt pattern; store-lock green |
| — | — | No TBD/FIXME/XXX/TODO/PLACEHOLDER markers in the phase implementation files or docs listed above | — | Clean |

Prohibition spot-checks: builder reads no `/etc/substrate/substrate.env` and forwards no LINEAR/NOTION/OTEL parent values; `parity-check.ts` has no state-changing systemctl verb in the reviewed path; no GREPTIME_ key follows a colon or equals in the scanned `.ts` files beyond the computed-key pattern.

### Human Verification Required

### 1. Read-only parity re-run on the operator host

**Test:** As the operator, run `bun run parity:check --json` on the production host and compare against the runbook readings table.
**Expected:** Exit 0; MainPID owns 127.0.0.1:7410; unit active; `/healthz` 200. The verdict may legitimately differ from the 2026-10-08 row because the release model changed (pinned `/opt/agent-substrate/current`).
**Why human:** Touches production (live systemctl, ss, and a GET on 7410). Agents may not run it under the no-production-touch constraint.

### 2. Zero-write counts still hold

**Test:** Operator runs the two read-only rh- count statements in `docs/runbooks/production-parity.md` against production Greptime `agent_events` and production Postgres graph tables.
**Expected:** Both counts 0 (last reported 2026-10-08 ~20:40 UTC as 0 and 0).
**Why human:** Requires production store credentials that agents do not hold.

### 3. Twin boot still reproducible

**Test:** `bun run rehearsal up --name p16-reverify`, `bun run rehearsal smoke`, loopback `ss` check, scratch index tests against `SUBSTRATE_TEST_PG_URL`, `bun run rehearsal down`, label-filtered `docker ps -a`.
**Expected:** Smoke prints ok on brief, emit, register, claim; ss peers loopback on container ports only; down leaves no `substrate.rehearsal=<name>` container and no run dir.
**Why human:** Needs Docker (Greptime and Postgres containers) outside the agent verification loop.

### 4. No stray holder of 127.0.0.1:7410

**Test:** Operator confirms that only the `substrate-mcp.service` MainPID holds 127.0.0.1:7410.
**Expected:** Single owner equal to MainPID.
**Why human:** Host process state on the production machine is not observable from this checkout.

### Gaps Summary

No gaps. Every code-level must-have is present and wired, and the targeted tests pass (120/120 and 103/103), with `tsc` clean. The status is `human_needed` rather than `passed` because five truths (SC-3 live reading, SC-2 full twin boot and concurrency live half, and the two operator-reported zero-write counts) rest on live production or Docker evidence that this verification did not reproduce. Those items are recorded in the runbook with dates but are not marked as passed here. The earlier "passed" status (2026-10-11) was stale against the current tree.

Notes (not gaps):
- The earlier F-01 test failure in `scripts/rehearsal.test.ts` did not reproduce this run (103 pass, 0 fail).
- `infra/vps/substrate-mcp.service` now points its ConditionPathExists guard at the pinned release symlink rather than the original checkout path. This is an intentional later change, consistent with the runbook's install procedure.

---

_Verified: 2026-11-12T00:00:00Z_
_Verifier: Claude (gsd-verifier)_
_HEAD: 33c400d1 (branch reconcile/main-2026-11-11)_
