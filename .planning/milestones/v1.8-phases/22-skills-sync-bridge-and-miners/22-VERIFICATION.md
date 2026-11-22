---
phase: 22-skills-sync-bridge-and-miners
verified: 2026-11-18T12:22:15Z
status: human_needed
score: 3/5 roadmap success criteria verified in code; 1 present but behavior unverified; 1 live (operator-gated)
covered_files: [".planning/milestones/v1.3-phases/22-skills-sync-bridge-and-miners/22-01-PLAN.md", ".planning/milestones/v1.3-phases/22-skills-sync-bridge-and-miners/22-01-SUMMARY.md", ".planning/milestones/v1.3-phases/22-skills-sync-bridge-and-miners/22-02-PLAN.md", ".planning/milestones/v1.3-phases/22-skills-sync-bridge-and-miners/22-02-SUMMARY.md", ".planning/milestones/v1.3-phases/22-skills-sync-bridge-and-miners/22-03-PLAN.md", ".planning/milestones/v1.3-phases/22-skills-sync-bridge-and-miners/22-03-SUMMARY.md", ".planning/milestones/v1.3-phases/22-skills-sync-bridge-and-miners/22-04-PLAN.md", ".planning/milestones/v1.3-phases/22-skills-sync-bridge-and-miners/22-04-SUMMARY.md", "docs/skills-sync-bridge-miners.md", "infra/vps/substrate-skills-bridge.service", "infra/vps/substrate-skills-bridge.timer", "infra/vps/substrate-skills-sync.service", "infra/vps/substrate-skills-sync.timer", "packages/miner/hermes/substrate-skill-miner-monitor.sh", "packages/miner/skills/substrate-skill-miner/SKILL.md", "packages/miner/src/substrate_miner/bridge.py", "packages/miner/src/substrate_miner/monitor.py", "packages/projector/omp/substrate-skills.ts", "packages/projector/src/skills-sync.ts", "packages/projector/src/skills.ts"]
covered_digest: "v3:sha256:56dff3f64b9eb4fe38d36d381e32f80f2fdad8856050f36dc368c0c635545d15"
behavior_unverified: 1
overrides_applied: 0
behavior_unverified_items:
  - truth: "The hourly Hermes miner skips the model run on an unchanged hour (criterion 4)"
    test: "Let one hourly cron tick pass with no new Cursor transcripts; then one tick with a new transcript"
    expected: "Unchanged hour: no model run (monitor stdout byte-identical to the prior tick). Changed hour: at most 3 proposals; skills.write_approval and memory.write_approval still true"
    why_human: "The repo side is verified (monitor.py output is deterministic and tested). Suppression of the run is Hermes cron behaviour on the host, and the cron entry rebind is OPERATOR-GATED"
human_verification:
  - test: "Run substrate-skills-sync from main on the host, then check /root/agent-skills and the projected links in ~/.claude/skills, ~/.grok/skills, ~/.agents/skills, ~/.config/muse/skills and ~/.openclaw/skills. Also run it once on a dirty or off-branch checkout"
    expected: "Fast-forward to origin/main (or current). Links are projected, with RESTORE.md and backups for any replaced real dir. The dirty or off-branch run exits 0 with one warning event and no merge"
    why_human: "Live host state. Repo logic and the rehearsal twin are verified, but the production checkout and timer were not run here"
  - test: "Confirm the production bridge timer and the Omp and Grok queue drain. Queue one skill proposal in each, wait past the 120 s quiet period, and check the bridge log"
    expected: "Records are proposed after 120 s of quiet and unlinked only on a final reply (opened, existing, unchanged, declined, or 400 rejected). 401 and 5xx keep the record"
    why_human: "Needs the live substrate on 127.0.0.1:7410 and the production timer"
  - test: "Operator-gated host rebinds: skill-autonomy reinstall (installed copy equals pinned source), Omp symlink repair, Hermes cron rebind to main's monitor script, and Hermes skills.write_approval and memory.write_approval both true"
    expected: "Each rebind matches docs/skills-sync-bridge-miners.md with its proof read. Hermes skill_manage output lands in ~/.hermes/pending/skills and reaches the bridge, not a direct write"
    why_human: "Production configuration changes that the phase executor did not run"
  - test: "SKILL-07 live tail: a real Cursor session mines a skill, the proposal opens as a PR, the owner merges it, and within one sync tick (<= 5 min) the skill appears in Claude Code and Grok Build without either agent's config changing. Both timers and the cron run green"
    expected: "PR opened by the bridge path, merged by the owner, projected by the next sync tick, timers and cron green in the journal"
    why_human: "Requires GitHub, the owner's merge, Hermes model quota and production timers. This is the stated Proof for SKILL-07"
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 22: Skills sync, bridge and miners — Verification Report

**Phase Goal:** A skill mined anywhere on the host becomes a PR, never a direct publish, and once the owner merges it every agent sees it within one sync tick, all from code on `main`.
**Verified:** 2026-11-18T12:22:15Z
**Status:** human_needed
**Re-verification:** No — initial verification of the current roadmap section

## Scope note

`.planning/phases/22-skills-sync-bridge-and-miners/` is absent in this worktree. The phase was archived under `.planning/milestones/v1.3-phases/22-skills-sync-bridge-and-miners/`, and its v1.3 record `22-VERIFICATION.md` is left untouched. This record checks the five success criteria in the current `ROADMAP.md` against the code on this branch (`gsd/autonomous-rerun`, HEAD `357d6b15`). SUMMARY claims were checked against the code, not taken as evidence.

## Goal Achievement

### Observable Truths

| # | Truth (roadmap success criterion) | Status | Evidence |
|---|---|---|---|
| 1 | `substrate-skills-sync` fast-forwards `/root/agent-skills` and projects symlinks for Claude Code, Grok Build, `.agents` (Cursor), Muse and OpenClaw, with backup and restore. A dirty, off-branch or diverged checkout is refused with a `warning` event | ✓ VERIFIED | `packages/projector/src/skills-sync.ts`: `decide()` returns `refuse-dirty` (porcelain), `refuse-branch` (not `main`), `refuse-diverged` (not an ancestor of `origin/main`), otherwise `ff`. The ff path runs `git merge --ff-only origin/main`. Each refusal calls `emitWarning` once and exits 0. `packages/projector/src/skills.ts` `ROOTS` (lines 99–116) lists claude, grok, agents, muse, openclaw (repoint-only), openclaw-ws and cursor (flag-gated). Backup-then-link writes to `BACKUP_ROOT` with `RESTORE.md` lines. Tests: `skills-sync.test.ts` (refuse-dirty/branch/diverged, ff argv, current, refresh) and `skills.test.ts` (roots, backup-then-link, RESTORE, `--check`). Systemd timer: `infra/vps/substrate-skills-sync.timer` (OnUnitActiveSec=5min). Targeted run: 56 pass, 0 fail. |
| 2 | The Hermes bridge, every 5 minutes, drains `~/.hermes/pending/skills` and the Omp and Grok queues into `skills_propose` after 120 s of quiet, and deletes a queued record only on a final reply | ✓ VERIFIED | `packages/miner/src/substrate_miner/bridge.py`: `PENDING_SKILLS` (l.42), `QUIET_S = 120` (l.50), `OMP_QUEUE` and `GROK_QUEUE` (l.52–53), `ready()` (l.215). Unlink happens only on `FINAL_STATUSES` = {opened, existing, unchanged, declined} (l.640), and on 400 rejected via `finish()` (l.524). 401 and 5xx keep records. Tests: `packages/miner/tests/test_bridge.py` (`test_ready_waits_for_a_quiet_period`, `test_run_once_opened_…_then_unlinks`, `test_run_once_declined_unlinks…`, `test_run_once_400_unlinks…`, `test_run_once_401_and_5xx_keep_records…`). Timer: `infra/vps/substrate-skills-bridge.timer` (OnUnitActiveSec=5min). `pytest -k "monitor or bridge"`: 52 passed. The live drain is not observed here. See human item 2. |
| 3 | No miner publishes directly: skill-autonomy posts to `/skills/propose` (or stages), the Omp extension intercepts `manage_skill` and `learn`, and Hermes `skill_manage` output goes pending → bridge | ✓ VERIFIED (repo side) | `packages/projector/omp/substrate-skills.ts`: `manage_skill` create/update POSTs to `${url}/skills/propose` then blocks with the PR reason (l.9, l.205, l.249). `learn` with a skill payload proposes and strips the payload (l.10, l.272–275). Deletes pass through. A failed POST queues to `~/.omp/agent/substrate-pending` (l.16). `packages/mcp-server/src/admission.ts` l.187 routes `/skills/propose` as a write. `docs/skills-sync-bridge-miners.md` describes the Hermes staging path, and `bridge.py` reads only `~/.hermes/pending/skills`, never `pending/memory`. Test: `substrate-skills.test.ts` (Omp extension suite, 56 pass across the two targeted files). The installed Omp extension copy and the Hermes-side `skill_manage` staging are host state, OPERATOR-GATED (human items 3). |
| 4 | The hourly Hermes miner runs main's code, skips the model run on an unchanged hour, proposes at most 3 skills, and leaves `skills.write_approval` and `memory.write_approval` true | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `packages/miner/hermes/substrate-skill-miner-monitor.sh` runs `substrate_miner monitor` from `/root/src/repos/agent-substrate/packages/miner/src` (main's checkout). `monitor.py` `monitor_output()` is deterministic: newest 100 transcripts plus the UTC day, no timestamps. Hermes suppresses the run when stdout is unchanged, so that suppression is host behaviour that is not exercised here. `SKILL.md` caps runs at three skills (l.12, l.35) and forbids flipping `skills.write_approval` or `memory.write_approval` (l.67). Repo side is present and wired. The cron rebind is OPERATOR-GATED and was not executed, so the live hour-skip and cap are not proven. Routed to human item 4. |
| 5 | A skill mined from a Cursor session is proposed as a PR, merged by the owner, and appears in Claude Code and Grok Build within one sync tick (≤ 5 min) with no agent config changed; both timers and the cron run green | ? UNCERTAIN (live) | Every link in the chain is present in code (criteria 1–4). The end-to-end proof is the stated `Proof` (SKILL-07): live GitHub PR, owner merge, Hermes model quota, a real Cursor session and production timers. These need operator action and are not run here. Per the verifier rules this is `human_needed`, not a gap. |

**Score:** 3/5 truths verified in code (1, 2, 3). Truth 4 is present but behaviour-unverified. Truth 5 is live and operator-gated.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/projector/src/skills-sync.ts` | ff-only sync gate, refusals, refresh trigger | ✓ VERIFIED | 338 lines; `decide()` and `runSync()` as above |
| `packages/projector/src/skills.ts` | Roots, backup-then-link, RESTORE | ✓ VERIFIED | `ROOTS` l.99–116; RESTORE writes l.313–381 |
| `packages/projector/omp/substrate-skills.ts` | Omp intercept of manage_skill and learn | ✓ VERIFIED | 286 lines |
| `packages/miner/src/substrate_miner/bridge.py` | Bridge drain, 120 s quiet, final-reply unlink | ✓ VERIFIED | 655 lines |
| `packages/miner/src/substrate_miner/monitor.py` | Deterministic precheck | ✓ VERIFIED | 30 lines; deterministic output |
| `packages/miner/skills/substrate-skill-miner/SKILL.md` | ≤3 cap, write_approval never flipped | ✓ VERIFIED | Prompt-enforced cap (no code-level cap); not a runtime guard |
| `infra/vps/substrate-skills-sync.{service,timer}` | Sync every 5 min, ff-only, main | ✓ VERIFIED (repo) | Host install not observed |
| `infra/vps/substrate-skills-bridge.{service,timer}` | Bridge every 5 min | ✓ VERIFIED (repo) | Host install not observed |
| `docs/skills-sync-bridge-miners.md` | Gated runbook (rebinds, live tail) | ✓ VERIFIED | Lists 9 OPERATOR-GATED steps, none executed |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `substrate-skills-sync.service` | `packages/projector/src/skills-sync.ts` | `ExecStart=bun packages/projector/src/skills-sync.ts` | ✓ WIRED | WorkingDirectory=/opt/agent-substrate/current |
| `skills-sync.ts` | skills projector | `project: () => project(defaultOptions())` | ✓ WIRED | Called on every tick that reaches it |
| `bridge.py` | `POST /skills/propose` | `client.post(...)` with the hermes bearer | ✓ WIRED | `/skills/propose` admitted as a write in `admission.ts` |
| Omp extension | `POST /skills/propose` | `endpoint` at `substrate-skills.ts` l.205 | ✓ WIRED | Queues to `substrate-pending` on failure |
| Hermes monitor script | `substrate_miner monitor` | `exec /usr/bin/python3 -m substrate_miner monitor` | ✓ WIRED | Cron binding is host state (gated) |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `bridge.py` | pending records | `load_pending(~/.hermes/pending/skills)` plus Omp and Grok queues | Yes (file reads) | ✓ FLOWING |
| `monitor.py` | transcript list | `/var/lib/substrate/transcripts/cursor/*.jsonl` mtimes | Yes | ✓ FLOWING |
| `skills-sync.ts` | refresh payload | `git rev-parse HEAD^{tree}` after the ff | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Miner precheck and bridge drain tests | `cd packages/miner && python3 -m pytest tests -q -k "monitor or bridge"` | 52 passed | ✓ PASS |
| Sync decisions, refusals, Omp extension, backup-then-link | `bun test packages/projector/src/skills-sync.test.ts packages/projector/omp/substrate-skills.test.ts` | 56 pass, 0 fail, 224 expect() | ✓ PASS |
| Live sync against `/root/agent-skills` | not run | — | ? SKIP (live host, human item 1) |

### Probe Execution

No probe scripts declared for this phase (`scripts/*/tests/probe-*.sh` not referenced). Step 7c: not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| SKILL-02 | 22-01 | Projector and ff-only sync | ✓ SATISFIED (code) | Truth 1 |
| SKILL-03 | 22-02 | Hermes bridge and queue drain | ✓ SATISFIED (code) | Truth 2 |
| SKILL-04 | 22-03 | Miners propose-only, ≤3 cap | ✓ SATISFIED (repo); host rebind gated | Truths 3, 4 |
| SKILL-05 | 22-03 | Omp interception | ✓ SATISFIED (repo); host install gated | Truth 3 |
| SKILL-07 | 22-04 | Rehearsal plus gated live tail | ? NEEDS HUMAN | Truth 5; live Proof required |

REQUIREMENTS.md was not re-read in this pass, so the requirement descriptions are taken from the roadmap's `Requirements:` line. The requirement IDs were not cross-checked for orphans.

### Anti-Patterns Found

No TBD, FIXME or XXX markers in the phase's code files were checked for this record. The `TODO` scan was not run. No stubs or placeholder returns were observed in the files read: `skills-sync.ts`, `bridge.py`, `monitor.py` and `substrate-skills.ts` all contain full implementations.

### Human Verification Required

### 1. Live sync on the host

**Test:** Run `substrate-skills-sync` from `main` on the host. Check `/root/agent-skills` and the projected links in `~/.claude/skills`, `~/.grok/skills`, `~/.agents/skills`, `~/.config/muse/skills` and `~/.openclaw/skills`. Then run once on a dirty or off-branch checkout.
**Expected:** Fast-forward or current. Links are projected, with `RESTORE.md` and backups for any real dir that was replaced. The refused run exits 0 with one `warning` event and no merge.
**Why human:** Production checkout and timer are live state.

### 2. Live bridge drain

**Test:** Queue one proposal in the Omp queue and one in the Grok queue. Wait past 120 s, then read the bridge log.
**Expected:** Each record is proposed and unlinked only on a final reply. 401 and 5xx keep the record.
**Why human:** Needs the live substrate on loopback and the production timer.

### 3. Operator-gated host rebinds

**Test:** Reinstall skill-autonomy (installed copy equals the pinned source). Repair the Omp symlink. Rebind the Hermes cron to main's monitor script. Confirm `skills.write_approval` and `memory.write_approval` are both true.
**Expected:** Each step matches `docs/skills-sync-bridge-miners.md`, with its proof read and rollback. Hermes `skill_manage` output lands in `~/.hermes/pending/skills`.
**Why human:** Production configuration changes that were not executed.

### 4. Hourly miner behaviour

**Test:** Let one cron tick pass with no new transcripts, then one with a new transcript.
**Expected:** The unchanged hour runs no model. The changed hour proposes at most 3 skills, with the write_approval flags still true.
**Why human:** Hermes cron behaviour on the host.

### 5. SKILL-07 live tail

**Test:** Mine a skill from a real Cursor session. Confirm the PR opens, the owner merges it, and the next sync tick (≤ 5 min) projects it into Claude Code and Grok Build with neither agent's config changed. Check that both timers and the cron run green.
**Expected:** As stated in the roadmap Proof.
**Why human:** GitHub, owner merge, Hermes model quota and production timers.

### Gaps Summary

No gaps. No criterion has FAILED evidence in the code. Criteria 1–3 are verified in the repo. Criterion 4 is present, with its host-side hour-skip unverified. Criterion 5 and the host-side parts of 3 and 4 need live operator action, so the phase cannot be `passed` yet.

---

_Verified: 2026-11-18T12:22:15Z_
_Verifier: Claude (gsd-verifier)_
