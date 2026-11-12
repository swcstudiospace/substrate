---
phase: 22-skills-sync-bridge-and-miners
verified: 2026-11-12T08:26:27Z
status: human_needed
score: 5/8 must-haves verified in repo code; 2 code-verified with operator-gated host steps; 1 live proof gated
covered_files: ["packages/projector/src/skills.ts", "packages/projector/src/skills.test.ts", "packages/projector/src/skills-sync.ts", "packages/projector/src/skills-sync.test.ts", "packages/projector/omp/substrate-skills.ts", "packages/projector/omp/substrate-skills.test.ts", "packages/miner/src/substrate_miner/bridge.py", "packages/miner/src/substrate_miner/monitor.py", "packages/miner/src/substrate_miner/__main__.py", "packages/miner/src/substrate_miner/token.py", "packages/miner/tests/test_bridge.py", "packages/miner/tests/test_monitor.py", "packages/miner/skills/substrate-skill-miner/SKILL.md", "packages/miner/hermes/substrate-skill-miner-monitor.sh", "packages/miner/pyproject.toml", "infra/vps/substrate-skills-sync.service", "infra/vps/substrate-skills-sync.timer", "infra/vps/substrate-skills-bridge.service", "infra/vps/substrate-skills-bridge.timer", "scripts/skills-sync-smoke.ts", "package.json", "docs/skills-sync-bridge-miners.md"]
covered_digest: "v3:sha256:59fc603f9b546d29468a70f8cf1cfd9357cb9906f6e9cff01a4c6856eaee533f"
behavior_unverified: 0
overrides_applied: 0
behavior_unverified_items: []
gaps: []
human_verification:
  - test: "SC5 / SKILL-07 live tail: a Cursor-mined skill is proposed as a real agent-skills PR, the owner merges it, and one substrate-skills-sync tick (<= 5 min) links it into Claude Code and Grok Build with neither agent's config changed"
    expected: "PR opened via POST /skills/propose; after merge the next sync tick prints ff and new symlinks appear in both roots"
    why_human: "Requires GitHub, owner merge, production timers and a real Cursor session. Explicitly operator-gated; not run."
  - test: "SC4 / SKILL-04 host rebind: Hermes substrate-skill-miner cron rebound to main's monitor + SKILL.md; unchanged hour skips the model run; at most 3 proposals; skills.write_approval and memory.write_approval still true"
    expected: "Cron entry points at main's code; an unchanged hour produces no model run; config flags read true"
    why_human: "The model-run skip is a property of the Hermes cron binding, not of repo code (monitor.py only prints the precheck). Rebind is operator-gated; not executed."
  - test: "SC3 / SKILL-05 host rebinds: skill-autonomy reinstall posting to /skills/propose (grok-build bearer) or staging; Omp substrate-skills symlink repaired"
    expected: "skill-autonomy output reaches the propose route or the pending dir; Omp extension loads from main"
    why_human: "Host-config steps (docs/skills-sync-bridge-miners.md) not executed; repo-side interception is verified below."
  - test: "Production restarts of substrate-skills-sync and substrate-skills-bridge, and the dirty-tree cleanup of /root/agent-skills with its .gitignore PR"
    expected: "One tick prints current or ff with zero refused; bridge drains without 401s from the staged token"
    why_human: "Operator-approved production actions; agents do not restart production units. Not run."
---

# Phase 22 verification (repo code, re-run)

**Phase goal:** A skill mined anywhere on the host becomes a PR, never a direct publish, and once the owner merges it every agent sees it within one sync tick, all from code on `main`.
**Verified:** 2026-11-12T08:26:27Z
**Status:** human_needed
**Re-verification:** Yes. Prior `22-VERIFICATION.md` (2026-10-11, `passed`, 12/12) is superseded. Its `passed` status counted rehearsal-only evidence as complete while the live tail (SC5, SKILL-07) and host rebinds are operator-gated, so it cannot stand as `passed` under this verifier's rules.

**Scope note:** `22-*-SECURITY.md` does not exist in the phase directory, so there is no `threats_open` value to check. No blocker was raised on that basis. Operator-gated steps were not executed, and I did not read or modify production state.

## Goal Achievement

### Observable Truths (must-haves: roadmap SC1-SC5 plus PLAN frontmatter)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1: sync fast-forwards `/root/agent-skills`, projects symlinks with backup/restore; dirty, off-branch or diverged is refused with a warning | ✓ VERIFIED | `skills-sync.ts:186-194` `decide()` (dirty → branch≠main → diverged → ff/current); `skills-sync.ts:253-267` fetch + `merge --ff-only`; `skills.ts:98` ROOTS; `skills.ts:158` library scan. `bun test` skills/skills-sync suites: all pass. |
| 2 | SC2: bridge every 5 min drains pending + Omp/Grok queues after 120 s quiet; record deleted only on final reply | ✓ VERIFIED | `bridge.py:50` `QUIET_S = 120`; `bridge.py:60` `FINAL_STATUSES`; `bridge.py:564-574` unlink only on 200-final, 400 rejected, 413 hold, 401 break/keep; `bridge.py:639-650` queue drain same rule; `infra/vps/substrate-skills-bridge.timer` `OnUnitActiveSec=5min`. pytest: `test_ready_waits_for_a_quiet_period`, `test_run_once_400_unlinks_*`, `test_run_once_401_and_5xx_keep_records_*`, `test_drain_queue_keeps_bodies_on_401_and_5xx`. |
| 3 | SC3 (repo side): Omp extension intercepts `manage_skill` / `learn`; Hermes `skill_manage` stages to pending → bridge; no direct publish | ✓ VERIFIED (code) | `packages/projector/omp/substrate-skills.ts` interception; 20 extension tests pass incl. learn payload stripping, 400/413 final block, queue on 401/5xx/timeout; `bridge.py:3-4` staged writes under `skills.write_approval`. Host-side skill-autonomy reinstall and Omp symlink repair are NOT done (see human items). |
| 4 | SC4 (repo side): hourly miner runs main's code; monitor precheck prints newest-100 transcripts + day with no timestamps; ≤3 proposals; write_approval flags never flipped | ✓ VERIFIED (code) | `monitor.py` + `test_monitor.py` pass; `SKILL.md:35` "at most 3"; `SKILL.md:67` never flip `skills.write_approval` / `memory.write_approval`; `packages/miner/hermes/substrate-skill-miner-monitor.sh` present. The "unchanged hour skips the model run" behavior is in the Hermes cron binding, not in repo code, and the rebind is not executed. |
| 5 | SC5 / SKILL-07: live PR, owner merge, one sync tick links into Claude Code and Grok Build | ✗ NOT VERIFIED (gated) | Live-only; 22-04 rehearsal twin only (`scripts/skills-sync-smoke.ts`). Not run here. See human items. |
| 6 | PLAN 22-01: sync child env is the four-key allowlist; no store URL, surface token or handoff key reaches git | ✓ VERIFIED | `skills-sync.ts:149-155` `childEnv()` returns exactly PATH, HOME, GIT_TERMINAL_PROMPT, GH_PROMPT_DISABLED; `execFileRunner` uses `childEnv()` (`skills-sync.ts:168`). Allowlist tests pass. |
| 7 | PLAN 22-01/02: staged sync and bridge units carry the token by name with `ConditionPathExists` guards; no token value in repo; no production unit touched | ✓ VERIFIED (repo content) | `infra/vps/substrate-skills-sync.service:8-9,20` and `substrate-skills-bridge.service:8-9,22` (guards, `EnvironmentFile` by name); grep for `SUBSTRATE_TOKEN_SUBSTRATE=` over `infra/` and `packages/`: no match. Production unit state was not inspected. |
| 8 | PLAN 22-02/03: no propose-key header or key-file path remains in miner or extension code | ✓ VERIFIED | `grep -rn "propose.key\|PROPOSE_KEY\|propose-key" packages/miner/src packages/miner/tests packages/projector/omp packages/projector/src` → no matches. Bearer resolution `bridge.py:402-414`, `token.py` (`SUBSTRATE_TOKEN` → `SUBSTRATE_TOKEN_FILE` → tokens dir). |

**Score:** 5/8 must-haves verified in repo code (truths 1, 2, 6, 7, 8). Truths 3 and 4 are verified in code but their host-side halves are operator-gated. Truth 5 is gated. Behavior-unverified count: 0 (every behavior-dependent invariant above is covered by a passing named test; host cron/skip behavior is routed to human items, not counted here).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/projector/src/skills.ts` | Projector, six roots, five actions, backup/restore | ✓ VERIFIED | exists, substantive, imports `SKILL_NAME_RE` from `mcp-server/src/skills/propose.ts` (line 52), no duplicate literal. |
| `packages/projector/src/skills-sync.ts` | ff-only sync gate, allowlisted env | ✓ VERIFIED | exists, `decide()` + `childEnv()` + `runSync()`. |
| `packages/projector/omp/substrate-skills.ts` | Omp interception extension | ✓ VERIFIED | exists; bun suite passes. |
| `packages/miner/src/substrate_miner/bridge.py` | Bridge: bearer auth, quiet window, final-reply unlink | ✓ VERIFIED | exists, 52 pytest pass in `packages/miner/tests`. |
| `packages/miner/src/substrate_miner/monitor.py` | Precheck, no timestamps | ✓ VERIFIED | exists; `test_monitor.py` passes. |
| `packages/miner/skills/substrate-skill-miner/SKILL.md` | Miner prompt, ≤3, never-write rules | ✓ VERIFIED | exists; lines 35, 46, 67 checked. |
| `infra/vps/substrate-skills-sync.{service,timer}` | Staged units, guards, 5 min | ✓ VERIFIED | `OnUnitActiveSec=5min`; guards and env-by-name present. |
| `infra/vps/substrate-skills-bridge.{service,timer}` | Staged units, guards, 5 min | ✓ VERIFIED | `OnUnitActiveSec=5min`; guards and env-by-name present. |
| `scripts/skills-sync-smoke.ts` | Rehearsal smoke 18/18 (per 22-04) | ✓ EXISTS (not re-run) | Twin proof needs the fixture harness; not run in this verification. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `skills.ts` | `mcp-server/src/skills/propose.ts` | `import { SKILL_NAME_RE }` (line 52) | ✓ WIRED | single literal, used at line 158 |
| `skills-sync.ts` warning | Phase 17 `skills.sync.refused` row, surface `substrate` | `emitWarning` | ✓ WIRED (per 22-01 SUMMARY; sync tests pass) | rule-name-only payload |
| `bridge.py` | `POST /skills/propose` | `client.post` with `Authorization: Bearer` (line 414) | ✓ WIRED | bearer resolved per surface (line 402-411) |
| Omp extension | propose route / pending queue | `manage_skill` / `learn` handlers | ✓ WIRED (extension tests) | 401/5xx/timeout → queue; 400/413 → block |
| `__main__` drain | queued-body surface client | per-surface bearer (22-02 deviation) | ✓ WIRED | pinned by `test_drain_client_resolves_the_queue_surface_bearer` |
| Hermes cron → `monitor.py` | cron entry | host config | ✗ NOT WIRED on host (gated) | `packages/miner/hermes/substrate-skill-miner-monitor.sh` exists; binding not executed |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| SKILL-02 | 22-01 | Sync from main, ff-only, refusals, projection | ✓ SATISFIED (code); live tail gated | truths 1, 6, 7 |
| SKILL-03 | 22-02 | Bridge 5 min, drains after 120 s, final-reply unlink | ✓ SATISFIED (code); live gated | truth 2 |
| SKILL-04 | 22-02, 22-03 | Hourly miner on main's code; skip unchanged hour; ≤3; flags true | ◐ PARTIAL | code (truth 4); cron rebind gated — human item |
| SKILL-05 | 22-03 | All three miners propose | ◐ PARTIAL | repo interceptions verified (truth 3); host rebinds gated — human item |
| SKILL-07 | 22-04 | Live proof: PR, owner merge, sync tick, production timers green | ✗ BLOCKED on operator gate | not run; human item |

Orphaned requirements: none. `v1.3-REQUIREMENTS.md` maps SKILL-02, 03, 04, 05, 07 to Phase 22. SKILL-06 maps to Phase 19 and is out of scope here.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (all phase code files) | — | `TBD` / `FIXME` / `XXX` | — | none found (debt-marker gate passes) |
| `packages/projector/src/skills.ts` | 98 | ROOTS has 7 entries (claude, grok, agents, muse, openclaw, openclaw-ws, cursor) | ℹ️ Info | PLAN text and SC1 say "six roots"; SC1 names five. The extra `openclaw-ws` and `cursor` entries are a superset, so SC1 is still met. Owner should reconcile the wording; not a gap. |
| `packages/projector/src/skills.ts` | 52 | `SKILL_NAME_RE` is imported, not duplicated | ✓ | pinned by 22-01 Task 1 acceptance |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Projector + sync + Omp extension suites | `bun test packages/projector/src/skills.test.ts packages/projector/src/skills-sync.test.ts packages/projector/omp/substrate-skills.test.ts` | 82 pass, 0 fail, 350 expect() | ✓ PASS |
| Miner bridge + monitor suites | `python3 -m pytest packages/miner/tests -q` | 52 passed in 1.40s | ✓ PASS |
| Propose-key absence | `grep -rn "propose.key\|PROPOSE_KEY\|propose-key" <miner/projector paths>` | no matches | ✓ PASS |
| Token value absence in repo | `grep -rn "SUBSTRATE_TOKEN_SUBSTRATE=" infra/ packages/` | no matches | ✓ PASS |
| Rehearsal smoke `smoke:skills-sync` | not run (needs twin fixture harness) | — | ? SKIP — 22-04 SUMMARY claims 18/18 on twin `p22`; not re-verified here |

Not run: `bun run verify`, `bunx tsc --noEmit`, the full `bun test`, and the rehearsal smoke. Only the three targeted suites and the miner pytest suite were run.

### Probe Execution

No `scripts/*/tests/probe-*.sh` files are declared or implied by this phase. Skipped.

### Human Verification Required

### 1. SC5 / SKILL-07 live proof
**Test:** Mine a skill from a Cursor session through the production route, let the owner merge the PR, then run one `substrate-skills-sync` tick.
**Expected:** A real agent-skills PR; after merge, the next tick (≤ 5 min) prints `ff` and symlinks appear in Claude Code and Grok Build with their configs unchanged; both timers and the cron run green on main's code.
**Why human:** GitHub, owner merge, Hermes model quota, real Cursor session and production timers. Operator-approved only.

### 2. SC4 / SKILL-04 host cron rebind
**Test:** Confirm the Hermes `substrate-skill-miner` cron entry points at main's monitor and SKILL.md. Verify an unchanged hour makes no model run, and that `skills.write_approval` and `memory.write_approval` read true.
**Expected:** Cron target matches `packages/miner/hermes/substrate-skill-miner-monitor.sh`; no model run on unchanged hours; flags true.
**Why human:** The skip behavior lives in the cron binding, not in repo code. The rebind is an operator-gated host change.

### 3. SC3 / SKILL-05 host rebinds
**Test:** Reinstall skill-autonomy so its output posts to `/skills/propose` (grok-build bearer) or stages to pending; repair the Omp extension symlink.
**Expected:** skill-autonomy output reaches the propose route or the pending directory; the Omp extension loads from main.
**Why human:** Host configuration per `docs/skills-sync-bridge-miners.md`; not executed.

### 4. Production restarts and dirty-tree cleanup
**Test:** After operator approval, restart `substrate-skills-sync` and `substrate-skills-bridge`; clean untracked caches in `/root/agent-skills` and land the `.gitignore` PR; delete `propose.key` after cutover.
**Expected:** One sync tick prints `current` or `ff` with zero `refused`; the bridge drains without 401s from the staged token.
**Why human:** Production actions an agent must not take unilaterally.

### Gaps Summary

No must-have is FAILED, no artifact is MISSING or STUB, and no key link is broken in repo code. Status is `human_needed`, not `passed`, because the phase's own SC5 (SKILL-07) and the host-side halves of SC3/SC4 are operator-gated, and this verifier does not count gated checks as passed.

The only repo-side note is the "six roots" wording versus the seven ROOTS entries (informational, not a gap).

---

_Verified: 2026-11-12T08:26:27Z_
_Verifier: Claude (gsd-verifier)_
