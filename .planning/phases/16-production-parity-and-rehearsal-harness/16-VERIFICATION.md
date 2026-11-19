---
phase: 16-production-parity-and-rehearsal-harness
verified: 2026-11-18T12:21:13Z
status: human_needed
score: 2/4 success criteria verified (criteria 3 and 4-reproduction need the live operator window)
covered_files: [".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-01-PLAN.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-01-SUMMARY.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-02-PLAN.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-02-SUMMARY.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-03-PLAN.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-03-SUMMARY.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-04-PLAN.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-04-SUMMARY.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-05-PLAN.md", ".planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-05-SUMMARY.md", "docs/runbooks/production-parity.md", "packages/mcp-server/src/rehearsal-env.ts", "scripts/parity-check.ts", "scripts/rehearsal.ts"]
covered_digest: "v3:sha256:63fcc032ca0b42b1cde1b136f167262956cb33f6bedf6952769da4abe52e1782"
behavior_unverified: 0
overrides_applied: 0
gaps: []
human_verification:
  - test: "In the operator's session on the host, run `bun run parity:check` read-only (no flags, or with the --expect-restarts/--expect-start values from the last reading)."
    expected: "Exit 0. substrate-mcp.service is active; NRestarts unchanged between readings; the pid owning 127.0.0.1:7410 equals MainPID and its cgroup is system.slice/substrate-mcp.service; GET http://127.0.0.1:7410/healthz returns 200; the 'from main' check passes for the unit's WorkingDirectory."
    why_human: "Reads live systemd, ss, /proc and the production /healthz. This needs the host and the operator's approved window; the verifier does not run the live stack."
  - test: "Confirm the operator-approved retirement of the stray holder of 127.0.0.1:7410 actually happened after the 2026-10-10 verification."
    expected: "Operator records the window (date, actor, pid retired) and the parity:check reading from it, so criterion 3 is evidenced for the current release, not only the 2026-10-08/10 readings."
    why_human: "docs/runbooks/production-parity.md and the archived 16-VERIFICATION.md cite the 2026-10-08 window and the 2026-10-10 PASS reading. The v1.3 closeout (.planning/milestones/v1.3-CLOSEOUT.md:34, :39, :123) says substrate-mcp still ran the 2026-10-10 process until a parity restart and that the restart is not verified. The live state is outside this verifier's evidence."

## Goal Achievement

**Phase Goal:** Production `substrate-mcp` serves the code on `main`, and every later proof has an isolated twin of it to rehearse against before anything live runs.
**Verified:** 2026-11-18T12:21:13Z
**Status:** human_needed
**Re-verification:** No — initial verification of this phase directory. The phase directory is absent under `.planning/phases/`; the prior verifier record lives at `.planning/milestones/v1.3-phases/16-production-parity-and-rehearsal-harness/16-VERIFICATION.md` (2026-10-10, HEAD `589a27c`). This record re-checks the four ROADMAP success criteria against HEAD `357d6b15` on branch `gsd/autonomous-rerun`.

### Observable Truths (ROADMAP success criteria)

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | One command starts main's `substrate-mcp` on a scratch port against scratch Postgres and GreptimeDB with configurable surface tokens; one command tears it down. | ✓ VERIFIED | `scripts/rehearsal.ts` header (lines 1-14) defines `bun run rehearsal up|down|status|smoke|pause|unpause`; `up` starts the checkout's server on a scratch port (`DEFAULT_MCP_PORT = 17410`) in labelled local Docker containers (`REHEARSAL_LABEL = "substrate.rehearsal"`), and `down` removes them by that label. Per-surface tokens come from `--surfaces` (`DEFAULT_SURFACES_RAW`) and `parseOperator`. Store env is built by `buildRehearsalEnv` in `packages/mcp-server/src/rehearsal-env.ts`. Targeted run this session: `bun test packages/mcp-server/src/rehearsal-env.test.ts scripts/parity-check.test.ts scripts/rehearsal.test.ts` → 187 pass, 0 fail. A live `up`/`down` was not re-run here. |
| 2 | With `SUBSTRATE_URL` pointed at the harness, a brief, an emit and a claim succeed, and production stores receive no row from the run. | ✓ VERIFIED (code path and recorded proof; not re-executed) | `scripts/rehearsal.ts` ~1632-1701: the fixed-order wire proof `smoke` calls `/brief`, `/events` (emit, expects 202 + `stored: true`), and `graph_claim` (expects `decision: granted`), reads only `consumer.env`, and refuses `:7410`. `rehearsal-env.ts` has `assertLoopback`, an allowlisted env (PATH/HOME/BUN_*), and a sentinel leak test that rejects `substrate.env`, `LINEAR_API_KEY`, `NOTION_API_KEY`. No-production-row evidence is the recorded 2026-10-08 proof run in `docs/runbooks/production-parity.md` (tag `rh-p16-proof-mv00v314`): production Greptime `agent_events` = 0; Postgres `graph_index`, `graph_nodes`, `graph_steps` = 0. That run is historical; it was not repeated because the live stack is out of scope for this verifier. |
| 3 | After the operator's approved window, the PID of `substrate-mcp.service` owns `127.0.0.1:7410`, the unit has stopped restarting, and `/healthz` answers from `main`. | ? HUMAN_NEEDED (live operator state) | `infra/vps/substrate-mcp.service` and its drop-ins (`20-watchdog.conf` with `Type=notify`, `WatchdogSec=30`, `StartLimitIntervalSec=0`, `ConditionPathExists` on `/opt/agent-substrate/current`) exist and are documented. `scripts/parity-check.ts` encodes the check (`WATCHED_PORTS = [7410]`, `HEALTHZ_URL`, owner == `MainPID`, `/proc` cgroup). Whether the stray holder was retired and the unit now owns the port on the current release is a live fact. `.planning/milestones/v1.3-CLOSEOUT.md:34, :39, :123` says the parity restart was not verified after the 2026-10-14 correction merge. Not a code gap: the operator's window is the required action. |
| 4 | A runbook records the parity check (unit PID owns the port, `/healthz` answers) and its rollback; running the check read-only reproduces criterion 3. | ✓ VERIFIED (runbook and rollback) / ? HUMAN_NEEDED (reproduction) | `docs/runbooks/production-parity.md` documents the check, exit codes (0 pass, 1 failed criterion, 2 could not ask), `--expect-restarts`/`--expect-start`, the two-mode "from main" rule, and a `## Rollback` section (line 211) for `deploy-release.sh rollback` and the harness `down`. The read-only reproduction against production needs the live host, so it is recorded above as a human item. |

**Score:** 2/4 criteria verified; 2 need the live operator window (criteria 3 and the reproduction half of 4).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `scripts/rehearsal.ts` | Harness `up/down/status/smoke` CLI | ✓ VERIFIED | Present; refuses production ports `[7410, 7411, 6420]`; smoke wire proof at ~1632-1701. |
| `packages/mcp-server/src/rehearsal-env.ts` | Scratch env builder | ✓ VERIFIED | `buildRehearsalEnv`, `assertLoopback`, allowlist, `parseExtraEnv`. |
| `scripts/parity-check.ts` | Read-only parity check | ✓ VERIFIED | 652 lines; read-only systemctl/ss/proc/`/healthz`; `bun run parity:check` in `package.json:43`. |
| `docs/runbooks/production-parity.md` | Runbook with check and rollback | ✓ VERIFIED | Sections: check, parity evidence, isolated harness proof, installing the unit, rollback (line 211), two approved probes, who does what. |
| `infra/vps/substrate-mcp.service` (+ drop-ins) | Unit that owns `:7410` | ✓ VERIFIED (file) / ? HUMAN_NEEDED (live) | Present; live ownership not checked here. |
| Targeted tests | Harness and parity logic | ✓ VERIFIED | `bun test` on `rehearsal-env.test.ts`, `parity-check.test.ts`, `rehearsal.test.ts`: 187 pass, 0 fail (run this session). |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `scripts/rehearsal.ts` | `rehearsal-env.ts` | `buildRehearsalEnv` / `consumerEnvRecord` imports | ✓ WIRED | Imported at the top of `rehearsal.ts`. |
| `scripts/rehearsal.ts` smoke | substrate-mcp `/brief`, `/events`, `graph_claim` | `smokeCall` / `smokeTool` against `SUBSTRATE_URL` from `consumer.env` | ✓ WIRED | Fixed order brief → emit → register → claim. |
| `package.json` | `scripts/parity-check.ts` | `parity:check` script | ✓ WIRED | `package.json:43`. |
| `docs/runbooks/production-parity.md` | `scripts/parity-check.ts` | documented command `bun run parity:check` | ✓ WIRED | Runbook names the command, flags and exit codes. |

### Data-Flow Trace (Level 4)

Not applicable: the phase produces a harness CLI and a read-only check, not rendered dynamic data.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Harness env, parity logic, harness CLI refusals and wiring | `bun test packages/mcp-server/src/rehearsal-env.test.ts scripts/parity-check.test.ts scripts/rehearsal.test.ts` | 187 pass, 0 fail, 548 expect() calls | ✓ PASS |
| Live `up` → smoke → `down` on scratch stores | not run | — | ? SKIP (live stack out of scope; criterion 2 relies on the recorded 2026-10-08 proof) |
| Live `parity:check` on production | not run | — | ? SKIP (live host and operator window) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` declared for this phase. Skipped.

### Requirements Coverage

| Requirement | Source | Description | Status | Evidence |
|-------------|--------|-------------|--------|----------|
| FOUND-01 | v1.3-REQUIREMENTS.md:33 | Isolated rehearsal harness starts main's substrate-mcp on a scratch port, tears down, touches no production store | ✓ SATISFIED (code and targeted tests); live run recorded historically | `scripts/rehearsal.ts`, `rehearsal-env.ts`, tests above |
| FOUND-03 | v1.3-REQUIREMENTS.md:35 | Production parity with operator approval; runbook records check and rollback | ? NEEDS HUMAN | Runbook and rollback present; the live parity restart is unconfirmed (v1.3-CLOSEOUT.md:123) |

### Anti-Patterns Found

None blocking. No TODO/FIXME/placeholder markers were introduced in the covered harness, parity and runbook files for this check.

### Advisory (New Scope)

None.

### Human Verification Required

1. **Read-only parity reading on the host.** Run `bun run parity:check` from the operator session. Expect exit 0 with the unit active, stable `NRestarts`, `:7410` owned by `MainPID` in `system.slice/substrate-mcp.service`, `/healthz` 200, and the "from main" check passing. Record the output (PIDs, states and commits only) beside the runbook's parity evidence.
2. **Confirm the approved window.** The operator confirms the stray holder of `127.0.0.1:7410` was retired and the unit was restarted onto the current release after 2026-10-14 (the closeout says this is not verified). Record the window date, actor and the PID retired.

### Gaps Summary

No gaps. The harness, the scratch env, the parity check and the runbook (with rollback) are present in the codebase, and the targeted tests pass. Criteria 3 and the reproduction half of 4 are live operator facts, so the status is `human_needed`, not `gaps_found`.

---
# Phase 16 Verification

_Verified: 2026-11-18T12:21:13Z_
_Verifier: Claude (gsd-verifier)_
