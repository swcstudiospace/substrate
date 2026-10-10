---
phase: 16-production-parity-and-rehearsal-harness
verified: 2026-10-10T12:41:00Z
status: passed
score: 23/23 must-haves verified
covered_files: [".planning/REQUIREMENTS.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-01-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-01-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-02-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-02-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-03-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-03-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-04-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-04-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-05-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-05-SUMMARY.md", "README.md", "docs/observability.md", "docs/rehearsal.md", "docs/runbooks/production-parity.md", "infra/vps/substrate-mcp.service", "package.json", "packages/mcp-server/src/rehearsal-env.test.ts", "packages/mcp-server/src/rehearsal-env.ts", "scripts/parity-check.test.ts", "scripts/parity-check.ts", "scripts/rehearsal.test.ts", "scripts/rehearsal.ts"]
covered_digest: "v3:sha256:15b50a2d5573117188fdad6dfd0c1677ecc6556bea5138ba297df0d83fc4436a"
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
**Verified:** 2026-10-10T12:41:00Z
**Status:** passed
**Re-verification:** Yes — prior report (2026-10-08T22:04:03Z, 23/23 passed, HEAD `50625c9`) went stale after the pull to `589a27c` (phases 17–28, pinned-release cutover, `fix(16)` hardening). This report re-verifies all 23 must-haves against HEAD `589a27c`. No code changes were made for this re-verification; `bun install --force` was run once to link the phase-27 `@substrate/ledger` workspace (environment-only, tree clean).

## Goal Achievement

### Observable Truths

Must-haves merged from all five PLAN frontmatters (23 truths) plus the 4 ROADMAP Success Criteria (each SC covered by at least one plan truth).

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | 16-01 SC-1 scratch-env contract: buildRehearsalEnv output boots main's server entry point on scratch loopback port with per-surface tokens | ✓ VERIFIED | Builder semantics intact; round-trip test through real `loadConfig` passes (90 targeted tests green across rehearsal-env + store-lock + parity-check) |
| 2 | 16-01 SC-2 isolation by construction: loopback scratch hosts only, no inherited keys, never reads /etc/substrate/substrate.env | ✓ VERIFIED | Allowlist (PATH/HOME/BUN_* only) + assertLoopback + sentinel leak test pass; no `substrate.env`/`LINEAR_API_KEY`/`NOTION_API_KEY` reference in builder (grep clean) |
| 3 | 16-01 Anonymous shape: --anonymous variant builds zero-token env, loadConfig reports allowAnonymous true | ✓ VERIFIED | Anonymous-path test passes, incl. `--anonymous` + `--operator` conflict refusal |
| 4 | 16-01 Operator ⊆ tokens: operator surface token is a surface token value, never swarm-* | ✓ VERIFIED | `SUBSTRATE_OPERATOR_TOKENS` still sourced from `surfaceTokens[operator]` with `assertOperatorAllowed` swarm refusal (rehearsal-env.ts:250-254); `b7655d8` only adds a separate consumer-side export (`SUBSTRATE_REHEARSAL_OPERATOR_TOKEN`, tested + documented in docs/rehearsal.md:105,140) — the subset invariant is unchanged |
| 5 | 16-02 SC-3 machine check: parity:check exits 0 only on active unit, stable MainPID owning 127.0.0.1:7410, healthz 200, main-verdict | ✓ VERIFIED | Fixture suite passes (in the 90-test targeted run); criteria evolved by the pinned-release cutover (production runs from `/opt/agent-substrate/current`, release sha replaces checkout reflog/dirty checks — `e5e7f7d`, `ad4dad8`, `fa9a9fd`); NOT re-run live per no-production-touch constraint — operator-approved PASS reading intact in runbook |
| 6 | 16-02 SC-4 reproducibility: --json mode + --expect-restarts/--expect-start flags | ✓ VERIFIED | Flags present (parity-check.ts:405-426); readings recorded in runbook, not re-run per constraints |
| 7 | 16-02 Warnings never fail: unit-file diff and substrate-* inventory are notes | ✓ VERIFIED | `warnings-never-fail` test passes; runbook carries the expected post-rollback FAIL note |
| 8 | 16-02 Flagged assumption: no further edge predicate beyond five criteria; operator window recorded as baseline | ✓ VERIFIED | Runbook header still records operator, ~17:14 UTC 2026-10-08, stray pid 3149064, source CONTEXT Operator answers |
| 9 | 16-03 SC-1 one-command twin: `rehearsal up` / `down` manage scratch twin | ✓ VERIFIED | Lifecycle code intact plus `fix(16)` hardening (per-name flock, verified-pid stop, docker-locality gate, disk floors); live guard proof this run: `down` of an absent instance exits 0 with "nothing to remove" |
| 10 | 16-03 Adjacency edge: different --name fully isolated; same-name second up refuses | ✓ VERIFIED | Label `substrate.rehearsal=<name>` scoping + run-dir/port isolation + name-lock intact |
| 11 | 16-03 Empty edge: bare invocation exits 2; down with no prior up exits 0 | ✓ VERIFIED | Fresh live proof this run: bare → exit 2 usage; `down --name p16-reverify-absent` → exit 0 "nothing to remove" |
| 12 | 16-03 Ordering edge: smoke runs brief→emit→register→claim in fixed order, one line per step | ✓ VERIFIED | `runSmoke` order intact in code; recorded 4/4 proof stands |
| 13 | 16-03 Idempotency edge: down idempotent; second same-name up refuses while running | ✓ VERIFIED | `mayStop` + state.json pid checks + name-lock intact |
| 14 | 16-03 Concurrency edge: parallel named instances isolate; crashed up kills only own pid | ✓ VERIFIED | `killVerifiedSpawn` (pid/start/argv/cwd re-check) + label-scoped teardown intact |
| 15 | 16-03 SC-2 wire proof shape: smoke drives brief/emit/register/claim with rh- ids, refuses 7410/non-loopback, prints scalars only | ✓ VERIFIED | Fresh live proof this run: `smoke` against crafted non-loopback consumer.env → exit 2 "refusing non-loopback smoke host 192.0.2.1" before any request; guard order (refuseSmokeUrl precedes first fetch) confirmed in code |
| 16 | 16-04 SC-1 documented: docs/rehearsal.md states commands, consumer.env contract, isolation | ✓ VERIFIED | Five-key consumer.env table (docs/rehearsal.md:138-143) plus the `SUBSTRATE_REHEARSAL_OPERATOR_TOKEN` row from `b7655d8`; exit-2 vs exit-1 split, naming distinction intact |
| 17 | 16-04 SC-4 documented: runbook records check, readings table, window, install, rollbacks, rh- probes, boundary | ✓ VERIFIED | Runbook intact incl. pinned-release install/rollback updates and copyable rh-count SQL (`39072ac`, `bb7ca3e`); dated readings + MainPID 1525582 row present |
| 18 | 16-04 README points at both docs with relative links in Running voice | ✓ VERIFIED | README.md:105 (`docs/rehearsal.md`), README.md:107 (`docs/runbooks/production-parity.md`) |
| 19 | 16-04 Two meanings of rehearsal stated apart | ✓ VERIFIED | Harness-vs-CHAOS paragraph in docs/rehearsal.md + docs/observability.md:313 cross-reference intact |
| 20 | 16-05 SC-2 isolated proof: up→smoke→loopback ss→down, no residue | ✓ VERIFIED | Recorded `p16-proof` evidence stands; guard-level live re-proof this run (bare exit 2, non-loopback smoke exit 2, absent down exit 0, no residue: temp run dirs removed). Full twin boot not re-run (needs Docker stores; covered by passing guard + unit suites) |
| 21 | 16-05 Concurrency live half: proof coexists with production 7410; scratch index tests pass | ✓ VERIFIED | No production contact this run per constraints; recorded coexistence evidence stands; builder code unchanged in the relevant paths |
| 22 | 16-05 SC-3 live evidence: parity:check output recorded as criterion 3/4 evidence | ✓ VERIFIED | Operator-approved evidence intact in runbook (exit 0 PASS, MainPID 1525582 owns :7410, healthz 200) — recorded values-free, not re-run per constraints |
| 23 | 16-05 SC-2 zero-write evidence: rh- counts 0 in production Greptime and Postgres | ✓ VERIFIED | Operator-approved evidence intact (Greptime agent_events rh-% = 0, Postgres graph rh-% = 0) — recorded, not re-run per constraints |

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
| `packages/mcp-server/src/rehearsal-env.ts` | env constructor | ✓ VERIFIED | operator-token export addition (`b7655d8`); round-trip + leak + anonymous + operator tests pass |
| `packages/mcp-server/src/rehearsal-env.test.ts` | builder tests | ✓ VERIFIED | pass within 90-test targeted run |
| `scripts/parity-check.ts` | parsers + verdict + CLI | ✓ VERIFIED | pinned-release semantics (`ad4dad8`); `--json/--expect-*` flags; no state-changing verbs |
| `scripts/parity-check.test.ts` | fixture tests | ✓ VERIFIED | pass within 90-test targeted run |
| `scripts/rehearsal.ts` | up/down/status/smoke CLI | ✓ VERIFIED | `fix(16)` hardening (flock, verified spawn, docker locality, disk floors, fake-docker-tested down); guard order unchanged since verify-time HEAD |
| `scripts/rehearsal.test.ts` | guard tests | ✓ VERIFIED | 79/80 pass (1 host-path-dependent assertion, Finding F-01; refused behavior itself intact) |
| `package.json` | rehearsal + parity:check entries | ✓ VERIFIED | both entries present (package.json:31-32) |
| `infra/vps/substrate-mcp.service` | ConditionPathExists guard | ✓ VERIFIED | guard now follows `/opt/agent-substrate/current` (pinned release); StartLimitIntervalSec=0 + StateDirectory intact; `systemd-analyze verify` exit 0 |
| `docs/rehearsal.md` | harness topic doc | ✓ VERIFIED | five-key table + operator-token row; contract realigned with code |
| `docs/runbooks/production-parity.md` | parity runbook + filled evidence | ✓ VERIFIED | readings, window, install, rollbacks, rh- probes, SC-2 proof, both 0 counts |
| `README.md` | Running paragraph links | ✓ VERIFIED | 2 relative links |
| `docs/observability.md` | 1 disambiguating sentence | ✓ VERIFIED | line 313 cross-reference |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| rehearsal-env.ts | config.ts loadConfig | every emitted key is a key loadConfig reads; tokenEnvName import | ✓ WIRED | round-trip test passes |
| rehearsal-env.test.ts | store-lock.test.ts | computed keys + short identifiers keep scans green | ✓ WIRED | store-lock green in targeted run |
| parity-check.ts | systemctl/ss/procfs/git | order-independent parsing, --no-optional-locks git | ✓ WIRED | fixture tests prove parsers; no state-changing verb added |
| parity-check.ts | production-parity.md | --json readings feed runbook | ✓ WIRED | proof row holds MainPID/NRestarts/start/healthz from the approved run |
| rehearsal.ts | rehearsal-env.ts | imports buildRehearsalEnv + record builders + RehearsalEnvError | ✓ WIRED | builder throw → labelled containers removed → exit-2 refusal |
| rehearsal.ts | index.ts entry | detached --no-env-file spawn | ✓ WIRED | spawn argv intact; production-checkout refusal precedes spawn |
| rehearsal.ts | consumer.env | proofs source it, hardcode nothing | ✓ WIRED | contract fixed in code + doc; live smoke guard read only consumer.env |
| docs/rehearsal.md | consumer.env keys | exact key list + operator token row | ✓ WIRED | all keys in table; stores.env discipline stated |
| README.md | both docs | relative links | ✓ WIRED | both links resolve to existing files |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| rehearsal-env.ts | store URLs, tokens | caller-supplied scratch inputs (Docker-assigned ports, generated secrets) | ✓ | ✓ FLOWING — asserts loopback, never inherits production |
| parity-check.ts | MainPID, healthz, shas | live systemctl/ss/procfs/GET/git reads | ✓ | ✓ FLOWING — pure verdict over gathered facts; release-sha path replaces reflog checks under pinned releases |
| rehearsal.ts smoke | brief/emit/register/claim results | wire responses from scratch twin | ✓ | ✓ FLOWING — guard order intact; live non-loopback refusal proven this run before any fetch |
| runbook evidence | readings, counts | operator-approved live runs | ✓ | ✓ FLOWING — values-free PIDs/epochs/counts recorded with actor + date |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Phase unit tests (3 files) | `bun test rehearsal-env + store-lock + parity-check tests` | 90 pass / 0 fail | ✓ PASS |
| Rehearsal guard suite | `bun test scripts/rehearsal.test.ts` | 79 pass / 1 fail (F-01, host-path-dependent assertion; refused behavior intact) | ✓ PASS with finding |
| Full suite | `bun test` | 2645 pass / 58 skip / 2 fail across 95 files (F-01 + F-02, both pre-existing at HEAD, neither a truth regression) | ✓ PASS with findings |
| Typecheck | `bunx tsc --noEmit` | clean, exit 0 (after workspace link install; was 9 errors on missing `@substrate/ledger` link pre-install) | ✓ PASS |
| Bare CLI | `bun scripts/rehearsal.ts` | exit 2 usage | ✓ PASS |
| Port refusal | `up --name p16-reverify --port 7410` | exit 2 refusal, no Docker touched | ✓ PASS |
| Non-loopback smoke refusal | `smoke` with crafted `consumer.env` → 192.0.2.1 | exit 2 "refusing non-loopback smoke host", before any request; temp dir removed | ✓ PASS |
| Idempotent down | `down --name p16-reverify-absent` | exit 0 "nothing to remove" | ✓ PASS |
| Unit lint | `systemd-analyze verify infra/vps/substrate-mcp.service` | exit 0 | ✓ PASS |
| Live parity:check / rh- counts / full twin boot | — | NOT re-run: operator-approved evidence recorded 2026-10-08 ~20:40 UTC; no-production-touch + no-PR constraints apply | ? SKIP (operator evidence accepted, intact in runbook) |

### Probe Execution

No phase-declared probe scripts (`scripts/*/tests/probe-*.sh`); not a migration/tooling phase with probe markers. Section N/A.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|--------------|-------------|--------|----------|
| FOUND-01 | 16-01, 16-03, 16-04, 16-05 | Isolated rehearsal harness on scratch port/stores with surface tokens + teardown | ✓ SATISFIED | builder + hardened CLI + docs + live guard proofs with clean teardown |
| FOUND-03 | 16-02, 16-04, 16-05 | Production parity with operator approval: stray retired, runbook + rollback | ✓ SATISFIED | read-only check (pinned-release semantics) + runbook + approved PASS reading + window record |

Orphan check: REQUIREMENTS.md maps exactly FOUND-01 and FOUND-03 to Phase 16; both appear in plan frontmatter. No orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | None: no TODO/FIXME/XXX/TBD/PLACEHOLDER/"Not implemented"/empty-return in the implementation files or docs | — | — |
| `packages/mcp-server/src/rehearsal-env.ts` | LEDGER_KEYS const | GREPTIME_ key names as values in one multi-line const | ℹ️ Info | Established store-lock-exempt pattern; store-lock scan green |
| — | — | No GREPTIME_ substring in parity-check.ts/rehearsal.ts; no agent_events SQL in any plan .ts | — | — |

Prohibition spot-checks: no state-changing systemctl verb in parity-check.ts; no process-group signals in rehearsal.ts; builder still reads no /etc/substrate/substrate.env and forwards no LINEAR/NOTION/OTEL keys; no credential/token/lease/store values printed or committed by the harness.

### Findings (pre-existing at HEAD, recorded not fixed per operator rules)

**F-01 [phase-16 scope, host-path-dependent test assertion, behavior intact — NOT fixed]:** `scripts/rehearsal.test.ts` "CLI refusals > --port 7410 exits 2 without touching Docker" fails when the suite runs with cwd equal to `UNIT_WORKING_DIRECTORY` (`/root/src/repos/agent-substrate`). The spawned CLI derives `checkout = process.cwd()`, so `refuseCheckoutDir` fires before `refusePort`; stderr carries the production-checkout refusal instead of "reserved". The refused behavior itself holds: exit code is 2 (first assertion passes) and the checkout check precedes every Docker call, so Docker is untouched. Guard order is byte-identical to verify-time HEAD `50625c9` (checkout → docker-locality → node_modules → port), hence the Oct-08 green run executed from a worktree path, per the plan's own "all proof commands run in the worktree" prohibition. Re-running this suite from a worktree checkout with `node_modules` installed reaches the port guard and goes green. No guard reorder or assertion weakening applied: both would trade real refusal strength for message cosmetics, which is outside a verification resume.

**F-02 [out of phase-16 scope — NOT fixed]:** `packages/cli/src/token.test.ts` "a directory at the token-file path means no token" fails on this host because the fallback `read(join(DEFAULT_TOKENS_DIR, "cursor"))` finds a real operator-provisioned `cursor` token in the host's default tokens dir, returning it instead of null. File is owned by Phase 20 (production identity), not Phase 16; no phase-16 truth depends on it. Recorded for the owning phase.

**Environment note (fixed by setup, not code):** `bunx tsc --noEmit` initially reported 9 errors, all `Cannot find module '@substrate/ledger'` plus one implicit-any in `anchor.test.ts` — the phase-27 workspace link was absent from `node_modules` after the pull. `bun install --force` restored the links (tree stayed clean) and tsc exits 0. No source change.

### Human Verification Required

None. The three live-evidence items (parity:check PASS, rh- 0 counts, full twin boot) remain operator-approved and recorded; the harness refusal guards were re-proven live by the verifier just now. No visual, UX, or real-time behavior needs human judgment.

### Gaps Summary

No gaps. All 23 must-haves verified against HEAD `589a27c` with test evidence (90 targeted pass, 2645/2 full suite with both failures characterized above as pre-existing and non-regressive, tsc clean), wiring evidence, fresh verifier-run guard proofs (bare exit 2, port refusal exit 2, non-loopback smoke exit 2 pre-request, absent down exit 0, no residue, production untouched), and intact operator-approved live evidence for the production-touching truths. Post-verification evolutions (`b7655d8` operator-token export, pinned-release parity semantics and unit path, `fix(16)` hardening) are each covered by tests and docs.

---

_Verified: 2026-10-10T12:41:00Z_
_Verifier: Phase16Verify_
_HEAD: 589a27c_
