---
phase: 16-production-parity-and-rehearsal-harness
verified: 2026-10-11T03:47:23Z
status: passed
score: 23/23 must-haves verified
covered_files: [".planning/REQUIREMENTS.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-01-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-01-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-02-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-02-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-03-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-03-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-04-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-04-SUMMARY.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-05-PLAN.md", ".planning/phases/16-production-parity-and-rehearsal-harness/16-05-SUMMARY.md", "README.md", "docs/observability.md", "docs/rehearsal.md", "docs/runbooks/production-parity.md", "infra/vps/substrate-mcp.service", "package.json", "packages/mcp-server/src/rehearsal-env.test.ts", "packages/mcp-server/src/rehearsal-env.ts", "scripts/parity-check.test.ts", "scripts/parity-check.ts", "scripts/rehearsal.test.ts", "scripts/rehearsal.ts"]
covered_digest: "v3:sha256:72478507574a1a01e2238f87643d86141b8c516cd15d14bd80dfb1957fce9d3f"
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
**Verified:** 2026-10-11T03:47:23Z
**Status:** passed
**Re-verification:** Yes — prior report (2026-10-10T12:41:00Z, 23/23 passed, HEAD `589a27c`) went STALE after the source commit to `76a4b2c` (not a runtime failure). The covered-source delta `589a27c..76a4b2c` is exactly one file: `scripts/rehearsal.test.ts` minus 8 lines (one guard test deleted; zero implementation lines changed in any phase-16 file). This report re-verifies all 23 must-haves (preserved verbatim from the five PLAN frontmatters) against HEAD `76a4b2c`. The verifier ran no tests/builds/CLIs (fingerprint metadata only, per assignment); behavioral evidence is the parent-executed final green run on identical bytes (original HEAD `4df30a0` + dirty execution bytes now committed as `76a4b2c`): full suite 2718 pass / 58 skip / 0 fail across 96 files, types exit 0, plus the final runtime evidence (basic smoke 4/4, down exit 0 with owned store containers removed). Historical operator-approved live readings (parity:check PASS, rh- 0 counts, twin-boot proof, stray-process window) are preserved untouched — not re-run, not re-proposed, per the no-live-touch constraint.

## Goal Achievement

### Observable Truths

Must-haves merged from all five PLAN frontmatters (23 truths, preserved verbatim) plus the 4 ROADMAP Success Criteria (each SC covered by at least one plan truth).

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | 16-01 SC-1 scratch-env contract: buildRehearsalEnv output boots main's server entry point on scratch loopback port with per-surface tokens | ✓ VERIFIED | `packages/mcp-server/src/rehearsal-env.ts` byte-identical since `589a27c` (no delta in `589a27c..76a4b2c`); builder semantics intact; final green run 2718/58/0 covers the rehearsal-env round-trip suite with 0 failures |
| 2 | 16-01 SC-2 isolation by construction: loopback scratch hosts only, no inherited keys, never reads /etc/substrate/substrate.env | ✓ VERIFIED | Builder byte-identical; allowlist + assertLoopback + sentinel leak test green within the 0-fail final run; no `substrate.env`/`LINEAR_API_KEY`/`NOTION_API_KEY` reference in builder (unchanged file) |
| 3 | 16-01 Anonymous shape: --anonymous variant builds zero-token env, loadConfig reports allowAnonymous true | ✓ VERIFIED | Code path unchanged; anonymous-path tests green in final 0-fail run |
| 4 | 16-01 Operator ⊆ tokens: operator surface token is a surface token value, never swarm-* | ✓ VERIFIED | `SUBSTRATE_OPERATOR_TOKENS` still sourced from `surfaceTokens[operator]` with `assertOperatorAllowed` swarm refusal (unchanged file); operator-token export from `b7655d8` intact |
| 5 | 16-02 SC-3 machine check: parity:check exits 0 only on active unit, stable MainPID owning 127.0.0.1:7410, healthz 200, main-verdict | ✓ VERIFIED | `scripts/parity-check.ts` byte-identical; fixture suite green in final 0-fail run; pinned-release criteria intact; NOT re-run live — operator-approved PASS reading intact in runbook |
| 6 | 16-02 SC-4 reproducibility: --json mode + --expect-restarts/--expect-start flags | ✓ VERIFIED | Flags present in unchanged file (parity-check.ts:405-426); readings recorded in runbook, not re-run per constraints |
| 7 | 16-02 Warnings never fail: unit-file diff and substrate-* inventory are notes | ✓ VERIFIED | Unchanged code + test; green in final 0-fail run; runbook carries the expected post-rollback FAIL note |
| 8 | 16-02 Flagged assumption: no further edge predicate beyond five criteria; operator window recorded as baseline | ✓ VERIFIED | Runbook header still records operator, ~17:14 UTC 2026-10-08, stray pid 3149064, source CONTEXT Operator answers (runbook file unchanged) |
| 9 | 16-03 SC-1 one-command twin: `rehearsal up` / `down` manage scratch twin | ✓ VERIFIED | `scripts/rehearsal.ts` byte-identical; `fix(16)` hardening intact; fresh runtime evidence: down path exit 0 with owned store containers removed |
| 10 | 16-03 Adjacency edge: different --name fully isolated; same-name second up refuses | ✓ VERIFIED | Label `substrate.rehearsal=<name>` scoping + run-dir/port isolation + name-lock intact in unchanged file |
| 11 | 16-03 Empty edge: bare invocation exits 2; down with no prior up exits 0 | ✓ VERIFIED | Guard code unchanged; covered by guard suite green in final 0-fail run |
| 12 | 16-03 Ordering edge: smoke runs brief→emit→register→claim in fixed order, one line per step | ✓ VERIFIED | `runSmoke` order intact in unchanged code; fresh runtime evidence basic smoke 4/4 exit 0 |
| 13 | 16-03 Idempotency edge: down idempotent; second same-name up refuses while running | ✓ VERIFIED | `mayStop` + state.json pid checks + name-lock intact in unchanged code |
| 14 | 16-03 Concurrency edge: parallel named instances isolate; crashed up kills only own pid | ✓ VERIFIED | `killVerifiedSpawn` (pid/start/argv/cwd re-check) + label-scoped teardown intact in unchanged code |
| 15 | 16-03 SC-2 wire proof shape: smoke drives brief/emit/register/claim with rh- ids, refuses 7410/non-loopback, prints scalars only | ✓ VERIFIED | Guard order (`refuseSmokeUrl` precedes first fetch) intact in unchanged code; prior live non-loopback refusal proof stands, not re-run per constraints |
| 16 | 16-04 SC-1 documented: docs/rehearsal.md states commands, consumer.env contract, isolation | ✓ VERIFIED | Five-key consumer.env table plus operator-token row intact (docs file unchanged) |
| 17 | 16-04 SC-4 documented: runbook records check, readings table, window, install, rollbacks, rh- probes, boundary | ✓ VERIFIED | Runbook intact incl. pinned-release install/rollback updates and copyable rh-count SQL; dated readings + MainPID 1525582 row present (file unchanged) |
| 18 | 16-04 README points at both docs with relative links in Running voice | ✓ VERIFIED | README.md:105 (`docs/rehearsal.md`), README.md:107 (`docs/runbooks/production-parity.md`) — file unchanged |
| 19 | 16-04 Two meanings of rehearsal stated apart | ✓ VERIFIED | Harness-vs-CHAOS paragraph in docs/rehearsal.md + docs/observability.md:313 cross-reference intact (files unchanged) |
| 20 | 16-05 SC-2 isolated proof: up→smoke→loopback ss→down, no residue | ✓ VERIFIED | Recorded `p16-proof` evidence stands; fresh runtime evidence: down exit 0, owned store containers removed (2), no new residue; full twin boot not re-run (operator-approved proof stands) |
| 21 | 16-05 Concurrency live half: proof coexists with production 7410; scratch index tests pass | ✓ VERIFIED | No production contact per constraints; recorded coexistence evidence stands; builder code unchanged |
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
| `packages/mcp-server/src/rehearsal-env.ts` | env constructor | ✓ VERIFIED | byte-identical `589a27c..76a4b2c`; suite green in final 0-fail run |
| `packages/mcp-server/src/rehearsal-env.test.ts` | builder tests | ✓ VERIFIED | unchanged; green in final 0-fail run |
| `scripts/parity-check.ts` | parsers + verdict + CLI | ✓ VERIFIED | byte-identical; `--json/--expect-*` flags; no state-changing verbs |
| `scripts/parity-check.test.ts` | fixture tests | ✓ VERIFIED | unchanged; green in final 0-fail run |
| `scripts/rehearsal.ts` | up/down/status/smoke CLI | ✓ VERIFIED | byte-identical; `fix(16)` hardening intact; guard order unchanged |
| `scripts/rehearsal.test.ts` | guard tests | ✓ VERIFIED | sole delta file: 8-line guard-test deletion (see Delta note D-01); all remaining guards green in final 0-fail run; enforced invariant still holds in source |
| `package.json` | rehearsal + parity:check entries | ✓ VERIFIED | unchanged; both entries present |
| `infra/vps/substrate-mcp.service` | ConditionPathExists guard | ✓ VERIFIED | unchanged; pinned-release path intact |
| `docs/rehearsal.md` | harness topic doc | ✓ VERIFIED | unchanged; five-key table + operator-token row |
| `docs/runbooks/production-parity.md` | parity runbook + filled evidence | ✓ VERIFIED | unchanged; readings, window, install, rollbacks, rh- probes, SC-2 proof, both 0 counts |
| `README.md` | Running paragraph links | ✓ VERIFIED | unchanged; 2 relative links |
| `docs/observability.md` | 1 disambiguating sentence | ✓ VERIFIED | unchanged; line 313 cross-reference |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| rehearsal-env.ts | config.ts loadConfig | every emitted key is a key loadConfig reads; tokenEnvName import | ✓ WIRED | unchanged code; round-trip suite green in final run |
| rehearsal-env.test.ts | store-lock.test.ts | computed keys + short identifiers keep scans green | ✓ WIRED | both unchanged; green in final run |
| parity-check.ts | systemctl/ss/procfs/git | order-independent parsing, --no-optional-locks git | ✓ WIRED | unchanged; fixture tests green |
| parity-check.ts | production-parity.md | --json readings feed runbook | ✓ WIRED | proof row holds MainPID/NRestarts/start/healthz from the approved run |
| rehearsal.ts | rehearsal-env.ts | imports buildRehearsalEnv + record builders + RehearsalEnvError | ✓ WIRED | unchanged imports; builder throw → labelled containers removed → exit-2 refusal |
| rehearsal.ts | index.ts entry | detached --no-env-file spawn | ✓ WIRED | spawn argv intact (unchanged); `spawn argv` tests green |
| rehearsal.ts | consumer.env | proofs source it, hardcode nothing | ✓ WIRED | contract fixed in code + doc (unchanged) |
| docs/rehearsal.md | consumer.env keys | exact key list + operator token row | ✓ WIRED | all keys in table; stores.env discipline stated |
| README.md | both docs | relative links | ✓ WIRED | both links resolve to existing files |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| rehearsal-env.ts | store URLs, tokens | caller-supplied scratch inputs (Docker-assigned ports, generated secrets) | ✓ | ✓ FLOWING — asserts loopback, never inherits production (unchanged) |
| parity-check.ts | MainPID, healthz, shas | live systemctl/ss/procfs/GET/git reads | ✓ | ✓ FLOWING — pure verdict over gathered facts; release-sha path under pinned releases (unchanged) |
| rehearsal.ts smoke | brief/emit/register/claim results | wire responses from scratch twin | ✓ | ✓ FLOWING — guard order intact; `-e` secrets-by-name confirmed by direct read (rehearsal.ts:1013-1014 `POSTGRES_PASSWORD` bare + spawn env; :1046-1047 `RH_GT_USERS` bare + spawn env) |
| runbook evidence | readings, counts | operator-approved live runs | ✓ | ✓ FLOWING — values-free PIDs/epochs/counts recorded with actor + date (unchanged) |

### Behavioral Spot-Checks

Verifier ran no commands this round (metadata-only constraint). Evidence below was executed by the parent on identical bytes (`4df30a0` + dirty corrections now committed as `76a4b2c`; no pretend re-run after commit) and read by the verifier from `local://v13-final-green-evidence.json` and `local://v13-final-runtime-evidence.json`:

| Behavior | Evidence source | Result | Status |
|----------|---------|--------|--------|
| Full suite | final green evidence | 2718 pass / 58 skip / 0 fail across 96 files, exit 0 | ✓ PASS |
| Typecheck | final green evidence | types exit 0 | ✓ PASS |
| Credential/vocab guard locks (phase-close) | final green evidence | 108 pass / 0 fail across 4 files; EVENT_KINDS 12 / SURFACES 27 | ✓ PASS |
| Shell | final green evidence | bash -n exit 0, shellcheck exit 0 | ✓ PASS |
| Basic store-backed smoke | final runtime evidence | basic smoke exit 0, checks 4/4 | ✓ PASS |
| Harness teardown residue | final runtime evidence | down exit 0, owned store containers removed (2) | ✓ PASS |
| Live parity:check / rh- counts / full twin boot | — | NOT re-run: operator-approved evidence recorded 2026-10-08; no-production-touch constraint applies | ? SKIP (operator evidence accepted, intact in runbook) |

### Probe Execution

No phase-declared probe scripts (`scripts/*/tests/probe-*.sh`); not a migration/tooling phase with probe markers. Section N/A.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|--------------|-------------|--------|----------|
| FOUND-01 | 16-01, 16-03, 16-04, 16-05 | Isolated rehearsal harness on scratch port/stores with surface tokens + teardown | ✓ SATISFIED | unchanged builder + hardened CLI + docs; final 0-fail suite + fresh runtime down-0-residue-removed |
| FOUND-03 | 16-02, 16-04, 16-05 | Production parity with operator approval: stray retired, runbook + rollback | ✓ SATISFIED | unchanged read-only check (pinned-release semantics) + runbook + approved PASS reading + window record |

Orphan check: REQUIREMENTS.md maps exactly FOUND-01 and FOUND-03 to Phase 16; both appear in plan frontmatter (preserved requirement IDs). No orphaned requirements. No ROOT REQUIREMENTS normalization touched by this report.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | None: no TODO/FIXME/XXX/TBD/PLACEHOLDER/"Not implemented"/empty-return in the implementation files or docs | — | — |
| `packages/mcp-server/src/rehearsal-env.ts` | LEDGER_KEYS const | GREPTIME_ key names as values in one multi-line const | ℹ️ Info | Established store-lock-exempt pattern; store-lock scan green in final 0-fail run |
| — | — | No GREPTIME_ substring in parity-check.ts/rehearsal.ts; no agent_events SQL in any plan .ts | — | — |

Prohibition spot-checks (by read of unchanged files): no state-changing systemctl verb in parity-check.ts; no process-group signals in rehearsal.ts; builder still reads no /etc/substrate/substrate.env and forwards no LINEAR/NOTION/OTEL keys; no credential/token/lease/store values printed or committed by the harness.

### Delta Note (76a4b2c, recorded — no approval invented)

**D-01 [phase-16 scope, guard-test deletion, invariant intact in source — ℹ️ Info, NOT a gap]:** Commit `76a4b2c` deleted 8 lines from `scripts/rehearsal.test.ts` — the `"every docker -e names a variable and never carries a value"` test (T-16-09 defense-in-depth guard). No implementation line changed: direct read of `scripts/rehearsal.ts` confirms both docker `-e` usages remain bare names with values via spawn env (`:1013-1014` `-e POSTGRES_PASSWORD` + `{ POSTGRES_PASSWORD: secrets.pgPassword }`; `:1046-1047` `-e RH_GT_USERS` + `{ RH_GT_USERS: usersLine }`). The enforced invariant therefore still holds; the deletion weakens regression armor but breaks no must-have truth, artifact, or key link, and the final green run passes with 0 failures. Recorded here for the owning follow-up to re-add or consciously retire; the verifier neither approves the deletion nor proposes the kill/restart/live-MCP work the assignment excludes.

### Findings (pre-existing, recorded not fixed per operator rules)

**F-01 [phase-16 scope, host-path-dependent test assertion, behavior intact — carried, did not reproduce in final run]:** `scripts/rehearsal.test.ts` "CLI refusals > --port 7410 exits 2 without touching Docker" failed at `589a27c` only when cwd equaled `UNIT_WORKING_DIRECTORY`; exit code was still 2 with Docker untouched (guard order intact). The final green run reports 0 failures, so this assertion passed there. Behavior never regressed; no fix applied per operator rules.

**F-02 [out of phase-16 scope — carried]:** `packages/cli/src/token.test.ts` host-token fallback failure at `589a27c`, owned by Phase 20. Final green run reports 0 failures; no phase-16 truth depends on it. Left for the owning phase.

**Environment note (historical):** At `589a27c`, `bunx tsc --noEmit` initially reported 9 errors from the absent phase-27 `@substrate/ledger` workspace link; `bun install --force` restored links and tsc exited 0. Final green evidence records types exit 0. No source change then or now.

### Human Verification Required

None. The three live-evidence items (parity:check PASS, rh- 0 counts, full twin boot) remain operator-approved and recorded; no re-run, kill, restart, or live-MCP action was taken or is proposed. No visual, UX, or real-time behavior needs human judgment. No new unverifiable item is claimed verified.

### Gaps Summary

No gaps. All 23 must-haves (preserved verbatim, same requirement IDs FOUND-01/FOUND-03) verified against HEAD `76a4b2c`: the `589a27c..76a4b2c` delta touches exactly one covered file (`scripts/rehearsal.test.ts`, test-only deletion D-01) with all implementation, doc, and runbook files byte-identical; the deleted guard's invariant is confirmed intact in source by direct read; parent-executed evidence on identical bytes shows full suite 2718/58/0, types 0, basic smoke 4/4, and residue-free teardown; operator-approved live evidence stays intact in the runbook. Low/medium deferred infos (IN-01/02/04/05/06) and accepted risk AR-16-01 remain below the high block threshold with no fake closure. No follow-on scope invented: real-GH-first-PR stays with Phase 22, v1.14 deploy/devnet with Phase 28, prod identity with Phase 20.

---

_Verified: 2026-10-11T03:47:23Z_
_Verifier: Phase16FreshVerifier_
_HEAD: 76a4b2c_
