# Skills sync, bridge and miners

Tracked as SKILL-02 through SKILL-05 plus SKILL-07 (v1.3 Phase 22). The clients of the
Phase 21 propose route: every miner path ends in `POST /skills/propose` with a surface
bearer, or in a 0600 queued body the bridge drains.

- Sync + projector: `packages/projector/src/skills.ts`, `packages/projector/src/skills-sync.ts`
  (SKILL-02). The sync timer is the only writer of `/root/agent-skills`.
- Bridge + monitor: `packages/miner/src/substrate_miner/bridge.py`,
  `packages/miner/src/substrate_miner/monitor.py` (SKILL-03, SKILL-04 precheck).
- Omp extension + miner prompt: `packages/projector/omp/substrate-skills.ts`,
  `packages/miner/skills/substrate-skill-miner/SKILL.md` (SKILL-04, SKILL-05).
- Rehearsal proof + live tail: `scripts/skills-sync-smoke.ts`, `22-VALIDATION.md` (SKILL-07).

## Miners propose-only and the host rebinds

No miner publishes directly. Three interceptions, all in this phase's code:

1. skill-autonomy (Grok plugin) posts to `POST /skills/propose` with the `grok-build`
   bearer, or stages 0600 bodies in its pending dir when the substrate is unreachable.
2. The Omp extension (`packages/projector/omp/substrate-skills.ts`) proposes on
   `manage_skill` create/update then blocks with the PR reason; `learn` with a skill
   payload proposes, strips the payload so the memory lesson still lands, and names the
   PR in `additionalContext`. Deletes and other tools pass through untouched.
3. Hermes `skill_manage` output stages to pending under `skills.write_approval` and the
   bridge is the only path to a PR. The miner prompt
   (`packages/miner/skills/substrate-skill-miner/SKILL.md`) caps runs at 3 skills,
   forbids direct library writes and self-approval, and treats an empty run as correct.

The hourly Hermes miner runs main's code: the monitor precheck
(`packages/miner/hermes/substrate-skill-miner-monitor.sh`, newest-100 transcripts plus
the day, no timestamps) skips unchanged hours, and the prompt proposes at most 3 skills
with `skills.write_approval` and `memory.write_approval` left true.

### OPERATOR-GATED: skill-autonomy reinstall

Reinstall skill-autonomy from its pinned source with its output pointed at
`POST /skills/propose` carrying the `grok-build` bearer, falling back to staging 0600
bodies in its pending dir when the substrate is unreachable. Proof read: the
installed copy equals the pinned source, plus a live rule and one 0600 queued body
drained by the bridge (September 04-09 evidence shape). Rollback: restore the previous
plugin copy. NOT executed by the phase executor; the operator runs it and pastes the
proof into the phase report.

### OPERATOR-GATED: Hermes miner cron rebind

Rebind the existing `substrate-skill-miner` cron entry to main's monitor script and
SKILL.md paths. Assert `skills.write_approval` true and `memory.write_approval` true
before and after the rebind; neither flag is ever flipped by this phase. Proof read:
one hourly tick runs the new monitor (byte-identical output suppresses the model run on
an unchanged hour) and a changed hour proposes at most 3 skills. Rollback: point the
cron entry back at the previous paths. NOT executed by the phase executor.

### OPERATOR-GATED: Omp extension symlink repair

Re-point the dangling `~/.omp/agent/extensions/substrate-skills.ts` symlink at the
ported `packages/projector/omp/substrate-skills.ts`. Proof read: one Omp session
proposes through the route (or queues a 0600 body that the bridge drains unchanged)
with `learn` still landing its memory lesson. Rollback: restore the previous link
target. NOT executed by the phase executor.

## Library hygiene: the one-time dirty-tree cleanup

The production checkout `/root/agent-skills` refuses every sync tick while it is dirty
(research PITFALLS 12: untracked `__pycache__`). The sync never ignores dirt to go green —
that would hide a real divergence — so the host is cleaned once, by the operator, and the
ignore rule lands through the normal owner-reviewed agent-skills PR path, never a direct push.

### OPERATOR-GATED: untracked-cache cleanup plus ignore rule

1. Re-derive the removal list live with `git status --porcelain` in `/root/agent-skills`
   (never a hardcoded list that could delete real work) and remove the untracked cache
   files it names.
2. Propose `__pycache__/` plus `*.pyc` in the library `.gitignore` through an
   owner-reviewed agent-skills PR, so the refusal cannot recur.
3. Proof read: one production sync tick prints `current` or `ff` with zero `refused`.
   Rollback: restore the removed files from backup; revert the `.gitignore` PR before merge.
   NOT executed by the phase executor.

Phase 25 hook point: after each sync fast-forward, the RAGFlow `agent-skills` dataset
refresh trigger runs (docs plane). This phase only documents the hook; Phase 25 owns it.

## SKILL-07 live tail: the gated cutover sequence

The rehearsal smoke (`bun run smoke:skills-sync`, 18 checks green in a detached worktree)
proves the loop against the fixture library. The live tail replays exactly the rehearsed
order against production. Every step below is OPERATOR-GATED: the executor stops, the
operator approves and runs it, and the proof read lands in the phase report before the
next step. No production restart, merge, PR or host write happens without that approval.

### OPERATOR-GATED: real mined skill proposed as a production PR

A real Cursor session mines a skill and stages it (or the Omp-route fallback when no
Cursor session is available, September 04-12 shape). The production bridge proposes the
real agent-skills PR. Proof read: the PR number and URL, branch `skill/<surface>/…`.
Rollback: close the PR unmerged.

### OPERATOR-GATED: owner merge plus first production tick

The owner merges the PR. Within one sync tick (≤ 5 min) the skill appears as links in
Claude Code and Grok Build with neither agent config changed. Proof read: one production
sync tick prints `ff` and the two links resolve into `/root/agent-skills`. Rollback:
revert the merge.

### OPERATOR-GATED: production restarts and cron rebind

Restart `substrate-skills-sync` and `substrate-skills-bridge` onto main's code, rebind
the Hermes `substrate-skill-miner` cron entry, and retire the dormant:22 expected-401
counts in the identity runbook. Proof read: timers tick `current`/`ff` with zero
`refused`, hourly miner runs the new monitor with both write_approval flags true.
Rollback: restart the previous release units; point the cron entry back.

### OPERATOR-GATED: propose-key file deletion

Delete `/var/lib/substrate/skills/propose.key` only after the cutover proof above.
No code references it (verified: no `propose.key` string in `packages/miner/src`,
`packages/projector`, or the miner prompt). Proof read: the file is gone and one
bridge tick still proposes. Rollback: none needed — the file is unread by everything.
