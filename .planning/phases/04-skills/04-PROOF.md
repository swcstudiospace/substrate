# Phase 4 proof — an Omp-mined skill reaches Claude Code and Grok Build untouched

Recorded from observed output only.
Re-scoped to an Omp session by D-22 (2026-09-26). The Setup section was recorded for the Cursor route (04-12 before the revision) and is kept as recorded; its services, Hermes cron and SC-5 keys are reused.

## Setup

Recorded by plan 04-12 Task 1 on 2026-09-26, 11:06Z. Every step was read-only apart from the t0 marker.
RESTORE.d/04-12.md (marker route) was written before the marker was created.

### Commands

```
date -u +%FT%TZ                                                          → 2026-09-26T11:06:17Z
systemctl is-active substrate-mcp substrate-host substrate-skills-sync.timer substrate-skills-bridge.timer
                                                                         → active ×4
git -C /root/agent-skills rev-parse HEAD                                 → 34b32e27870c49d84e166830033b42f011eaf96e
git -C /root/agent-skills status --porcelain | wc -l                     → 0
hermes cron list                                                         → 0c172431cf5b [active] substrate-skill-miner, Schedule 0 * * * *,
                                                                           Monitor substrate-skill-miner-monitor.sh
hermes config get skills.write_approval; hermes config get memory.write_approval   → true, true
~/.cursor/hooks.json hooks.stop, substrate-managed entry                 → 1 entry:
    bun /root/src/repos/agent-substrate/packages/collectors/src/cursor-stop.ts >/dev/null 2>&1 || true
find /root/.cursor-server /root/.local/share/cursor-agent -name cursor-agent -type f | sort -V | tail -1
    → .../anysphere.cursor-agent-worker/agent-cli/.local/share/cursor-agent/versions/2026.09.26-dd393fe/cursor-agent
<it> status                                                              → Not logged in   (D-15: owner route)
find /var/lib/substrate/transcripts/cursor -name '*.jsonl' | wc -l       → 0
file counts: ~/.hermes/pending/skills, ~/.omp/agent/substrate-pending, ~/.grok/plugin-data/skill-autonomy/pending → 0, 0, 0
stat -c %Y /root/.claude/settings.json /root/.grok/config.toml           → 1790356194, 1790311878
env -i HOME=/root PATH=/usr/bin:/bin gh pr list --repo swcstudiospace/agent-skills --state open --json url,title → 4 PRs (below)
sudo touch /var/lib/substrate/transcripts/.p4-proof-t0                   → 2026-09-26 11:06:34Z
```

proof_t0=2026-09-26T11:06:34Z
services_active=true
library_head_t0=34b32e27870c49d84e166830033b42f011eaf96e
library_clean_t0=true
cron_job_id=0c172431cf5b
cron_schedule=0 * * * *
write_approval_on=true
stop_entry_script=true
cursor_agent_status=not_logged_in
transcripts_t0=0
hermes_pending_skills_t0=0
omp_queue_t0=0
grok_queue_t0=0
claude_settings_mtime_t0=1790356194
grok_config_mtime_t0=1790311878
open_prs_t0=4

open_pr: https://github.com/swcstudiospace/agent-skills/pull/5 skill(substrate-skill-miner): proposal from hermes
open_pr: https://github.com/swcstudiospace/agent-skills/pull/4 skill(grok-skill-propose): proposal from grok-build
open_pr: https://github.com/swcstudiospace/agent-skills/pull/3 skill(omp-skill-propose): proposal from omp
open_pr: https://github.com/swcstudiospace/agent-skills/pull/2 skill(docs-scraper): proposal from docs-scraper

### Scheduled miner ticks since 04-07 (SC-5, checker W5)

These were read before any manual cron run in this plan. 04-07 made no manual run (cron_manual_runs=0).
The job was created at 2026-09-26T19:14:26.372536+10:00 (09:14:26Z).

```
jobs.json, substrate-skill-miner job, monitor_script                     → substrate-skill-miner-monitor.sh
find /root/.hermes/cron/output/0c172431cf5b -name '*.md' -newermt "2026-09-26T19:14:26.372536+10:00"
    10:02Z  2026-09-26_20-02-30.md   first run: no stored hash, so the agent ran (monitor.py check_monitor, first_run)
    11:00Z  2026-09-26_21-00-43.md   **Status:** no_change (agent run suppressed)
grep -c 'no_change (agent run suppressed)' per doc                        → 0, 1
grep "monitor output unchanged — suppressing agent run" ~/.hermes/logs/agent.log* | grep -c 0c172431cf5b → 1
```

The monitor printed only `day 2026-09-26` at both ticks, with no transcripts in the directory. The
second hourly tick was therefore unchanged and suppressed before any agent machinery ran.

cron_monitor_bound_t0=substrate-skill-miner-monitor.sh
sched_ticks_since_create=2
sched_docs_off_schedule=0
sched_suppressed_ticks=1
sched_suppressed_example=/root/.hermes/cron/output/0c172431cf5b/2026-09-26_21-00-43.md
sched_suppressed_log_line=true

## Omp route

### Baseline

Recorded by plan 04-12 Task 2 (Omp route, D-22) on 2026-09-26 from 22:45Z, after Task 1's GREEN
commit 741249b made session forwarding live through the extension symlink. Read-only apart from the
key lists, RESTORE.d/04-12.md and route 1 (the unused Cursor-route marker).

```
date -u +%FT%TZ                                                          → 2026-09-26T22:45:02Z
omp --version                                                            → omp/18.3.1
/usr/bin/time -f %e -o /tmp/04-12-startup.txt omp --version              → 15.09 (file removed)
systemctl is-active substrate-mcp substrate-host substrate-skills-sync.timer substrate-skills-bridge.timer
                                                                         → active ×4
readlink /root/.omp/agent/extensions/substrate-skills.ts                 → /root/src/repos/agent-substrate/packages/projector/omp/substrate-skills.ts
grep -c getSessionId <that file>                                         → 4
omp config get skills.customDirectories                                  → ["/root/agent-skills"]
omp config get autolearn.enabled; … autolearn.autoContinue               → true, false
omp config get memory.backend                                            → off
control.json skipOnce (json.dumps)                                       → false
test -e /root/.omp/agent/managed-skills                                  → absent
test -s /var/lib/substrate/skills/propose.key                            → present (presence only, never read)
git -C /root/agent-skills rev-parse HEAD                                 → 34b32e27870c49d84e166830033b42f011eaf96e
git -C /root/agent-skills status --porcelain | wc -l                     → 0
stat -c %Y /root/.claude/settings.json /root/.grok/config.toml           → 1790356194, 1790447779
keys-only lister (interfaces) over both files, umask 077 → /var/lib/substrate/phase4-baseline/04-12/omp-route/
    claude-settings.keys, grok-config.keys (0600, dir 0700)              → 52, 46 lines
env -i HOME=/root PATH=/usr/bin:/bin gh pr list --repo swcstudiospace/agent-skills --state open --json url,title → 5 PRs (below)
ls /root/.omp/agent/substrate-pending/*.json | wc -l                     → 0 (dir present)
ls /root/.omp/agent/sessions/-tmp/*.jsonl | wc -l                        → 3
grep -c substrate-skill-miner-monitor.sh /root/.hermes/cron/jobs.json    → 1
rm -f /var/lib/substrate/transcripts/.p4-proof-t0 (route 1)              → 2026-09-26T22:47:32Z, gone
```

Grok's config.toml mtime moved since Setup (1790311878 → 1790447779; the unattributed writer noted in
the plan objective, before this route started). The gating "untouched" window is merge → projection
(Task 5); this comparison is supporting only.

omp_route_t0=2026-09-26T22:45:02Z
omp_version=omp/18.3.1
omp_startup_s=15.09
omp_services_active=true
omp_extension_link=/root/src/repos/agent-substrate/packages/projector/omp/substrate-skills.ts
omp_extension_session_id=true
omp_custom_directories=["/root/agent-skills"]
omp_autolearn_enabled=true
omp_autolearn_autocontinue=false
omp_memory_backend=off
omp_ultrathink_skip_pending=false
omp_managed_skills_absent=true
omp_route_propose_key_present=true
omp_route_library_head=34b32e27870c49d84e166830033b42f011eaf96e
omp_route_library_clean=true
omp_route_claude_mtime=1790356194
omp_route_grok_mtime=1790447779
omp_route_setup_mtimes_match=false
omp_route_keys_dir=/var/lib/substrate/phase4-baseline/04-12/omp-route
omp_route_claude_keys=52
omp_route_grok_keys=46
omp_route_open_prs=5
omp_route_queue_files=0
omp_route_sessions_before=3
sc5_monitor_bound_live=true
cursor_route_marker_removed=true

open_pr_omp_route: https://github.com/swcstudiospace/agent-skills/pull/6 skill(vps-cpu-memory-lsp-triage): proposal from omp
open_pr_omp_route: https://github.com/swcstudiospace/agent-skills/pull/5 skill(substrate-skill-miner): proposal from hermes
open_pr_omp_route: https://github.com/swcstudiospace/agent-skills/pull/4 skill(grok-skill-propose): proposal from grok-build
open_pr_omp_route: https://github.com/swcstudiospace/agent-skills/pull/3 skill(omp-skill-propose): proposal from omp
open_pr_omp_route: https://github.com/swcstudiospace/agent-skills/pull/2 skill(docs-scraper): proposal from docs-scraper

### Omp session

Run by plan 04-12 Task 3 with the fixed prompt (byte for byte from the plan) and the 04-08 invocation
(04-08-SMOKE.md:51), one declared deviation `timeout 900` (plan objective). No flag added, no model,
Omp config, ultrathink control file or propose key touched.

```
date -u +%FT%TZ                                                          → 2026-09-26T22:48:32Z
( umask 077 && cd /tmp && timeout 900 omp -p --mode json "/ultrathink-skip" "<PROMPT>" > /tmp/04-12-omp.json ); echo "exit=$?"
    stderr: MCP servers "ktui" and "aio" not ready after 30000ms (their tools unavailable; not used by the task)
                                                                         → exit=0
date -u +%FT%TZ                                                          → 2026-09-26T22:52:40Z
python3 over /tmp/04-12-omp.json (non-JSON lines skipped; fixed fields only)
    type: session id                                                     → 01a0dfe8-61c8-7625-abd2-071abece07e1
    tool_execution_end, toolName != manage_skill                         → 14 (bash ×9, grep ×2, read ×2, eval ×1)
    tool_execution_end, toolName == manage_skill                         → 1, isError true, outcome:
    The substrate was unreachable; the proposal is queued at /root/.omp/agent/substrate-pending/substrate-skills-sync-audit-20260926T225221Z.json and will be opened as a PR automatically. Nothing was written locally.
bridge-log.jsonl, "queue": "omp" line for that file (polled every 60 s; found on the 3rd poll)
    {"file": "substrate-skills-sync-audit-20260926T225221Z.json", "name": "substrate-skills-sync-audit", "pr_url": "https://github.com/swcstudiospace/agent-skills/pull/7", "queue": "omp", "status": "existing", "ts": "2026-09-26T22:54:32Z"}
ls /root/.omp/agent/substrate-pending/                                   → empty (drained)
systemctl show substrate-mcp -p NRestarts -p ActiveEnterTimestamp        → 0, Sat 2026-09-26 19:31:28 UTC (no restart)
ls /root/.omp/agent/sessions/-tmp/*_01a0dfe8-61c8-7625-abd2-071abece07e1.jsonl
    → 2026-09-26T22-49-03-688Z_01a0dfe8-61c8-7625-abd2-071abece07e1.jsonl; line 1 type title; type: session id → 01a0dfe8-61c8-7625-abd2-071abece07e1
test -e /root/.omp/agent/managed-skills                                  → absent
control.json skipOnce (json.dumps)                                       → false (consumed)
rm -f /tmp/04-12-omp.json                                                → gone
env -i HOME=/root PATH=/usr/bin:/bin gh pr view <proof_pr_url> --json files,body,headRefName,createdAt
    files → substrate-skills-sync-audit/SKILL.md; createdAt → 2026-09-26T22:52:20Z
    body lines → "surface: omp", exactly one "session_id: 01a0dfe8-61c8-7625-abd2-071abece07e1"
    headRefName → skill/omp/substrate-skills-sync-audit-20260926T225202692Z-3c2a
git -C /root/agent-skills cat-file -e 34b32e2…:substrate-skills-sync-audit/SKILL.md → fails (not in the library at the Omp-route head)
~/.claude/skills, ~/.grok/skills, ~/.agents/skills, ~/.config/muse/skills /substrate-skills-sync-audit → absent ×4
cd /tmp && timeout 60 grok inspect 2>&1 | grep -cE '(^|[^A-Za-z0-9_-])substrate-skills-sync-audit([^A-Za-z0-9_-]|$)' → 0
```

The propose outlived the extension's 25 s client timeout: the server opened PR #7 at 22:52:20Z
(branch stamped 22:52:02.692Z) after the extension had queued the same body at 22:52:21Z; the bridge's
re-post at 22:54:32Z was answered `existing` with that PR (the plan's W3 slow-propose case). The PR
was created after t_omp_start and its body names this session, so `existing` is accepted. The
session file does not hold the PR URL on this path (the tool result names the queue file); the bridge
log line ties the queue file to the PR.

omp_prompt=On this VPS, work out how a change merged into the shared skills library (/root/agent-skills, a git checkout of swcstudiospace/agent-skills) reaches the agents: when the substrate-skills-sync timer last ran and what that run logged, which command it runs, and whether the skill links it maintains for Claude Code (/root/.claude/skills) and Grok Build (/root/.grok/skills) have drifted from the library. Stay read-only: do not edit or create files, do not start, stop or restart any service or timer, and run the projector only in its --check mode. Report what you found. Then, if the steps you took form a procedure worth reusing, save it as a new skill with your skill creator (the manage_skill tool, action create), choosing the name, description and steps yourself from what you actually ran, and report the tool result verbatim.
omp_timeout_s=900
t_omp_start=2026-09-26T22:48:32Z
t_omp_end=2026-09-26T22:52:40Z
omp_run_exit=0
omp_session_id=01a0dfe8-61c8-7625-abd2-071abece07e1
omp_session_file=/root/.omp/agent/sessions/-tmp/2026-09-26T22-49-03-688Z_01a0dfe8-61c8-7625-abd2-071abece07e1.jsonl
omp_task_tool_calls=14
omp_skill_calls=1
extra_skill_calls=0
omp_skill_tool=manage_skill
omp_tool_blocked=true
omp_propose_path=queued
t_bridge=2026-09-26T22:54:32Z
omp_managed_skill_written=false
omp_ultrathink_skip_consumed=true
omp_output_removed=true
proof_pr_url=https://github.com/swcstudiospace/agent-skills/pull/7
proof_pr_status=existing
proof_pr_created_at=2026-09-26T22:52:20Z
proof_skill=substrate-skills-sync-audit
proof_pr_files=substrate-skills-sync-audit/SKILL.md
proof_pr_session_line=true
proof_pr_surface_line=true
proof_pr_head=skill/omp/substrate-skills-sync-audit-20260926T225202692Z-3c2a
proof_skill_new=true
grok_inspect_count_pre=0

### Arrival

Recorded by plan 04-12 Task 5. Nothing was started, no projector was run and no sudo was used; the
only calls against Claude Code and Grok Build were the two read-only probes.

Merge (Task 4): at the checkpoint the owner answered "merged" (relayed by the orchestrator) while gh
still reported PR #7 OPEN (polled 02:50:08Z–03:02:06Z, mergedAt null, origin main 34b32e2); the
executor stopped and reported. The owner then re-confirmed "merged (done now)", and the orchestrator
merged the PR under an explicit one-time owner authorization (see ## Gaps, D-16).
Owner answer (verbatim): "Authorize agent to merge #7"; option text (verbatim): "You authorize a one-time exception to D-16: I run `gh pr merge 7 --squash` and the proof records `owner_merge=delegated` with your answer verbatim."

```
env -i HOME=/root PATH=/usr/bin:/bin gh pr view 7 -R swcstudiospace/agent-skills --json state,mergedAt,mergeCommit
    (polled every 30 s from 03:12Z)                                      → 03:27:09Z MERGED, mergedAt 2026-09-27T03:26:59Z, mergeCommit df0db4e18b2837a1907d4fd4ddb86c3b825310f1
read-only poll every 30 s: library SKILL.md + claude/grok links          → 03:27:15Z … 03:28:45Z waiting, 03:29:16Z projected
stat -c %Y /root/.claude/settings.json /root/.grok/config.toml (at the observation, before the probes)
                                                                         → 1790356194, 1790447779 (merge epoch 1790479619)
journalctl -u substrate-skills-sync --since "2026-09-27 03:26:59" -o short-iso-precise
    2026-09-27T03:28:56.189653+00:00 systemd[1]: Starting substrate-skills-sync.service …
    2026-09-27T03:29:05.388915+00:00 [skills-sync] ff 34b32e27870c49d84e166830033b42f011eaf96e..df0db4e18b2837a1907d4fd4ddb86c3b825310f1
    2026-09-27T03:29:05.393949+00:00 [projector] claude link-new substrate-skills-sync-audit
    2026-09-27T03:29:05.394928+00:00 [projector] grok link-new substrate-skills-sync-audit
    2026-09-27T03:29:05.395092+00:00 [projector] agents link-new substrate-skills-sync-audit
    2026-09-27T03:29:05.395173+00:00 [projector] muse link-new substrate-skills-sync-audit
    2026-09-27T03:29:05.395173+00:00 [projector] actions=4 warnings=0
    2026-09-27T03:29:05.587193+00:00 systemd[1]: Finished substrate-skills-sync.service …
journalctl -u substrate-skills-sync --since "2026-09-27 03:00" | grep Starting
                                                                         → 03:03:53, 03:08:54, 03:13:54, 03:18:55, 03:23:55, 03:28:56 (5-min cadence)
journalctl --since "2026-09-27 03:26:59" | grep -iE 'sudo.*(skills-sync|skills\.ts)|COMMAND=.*skills' | wc -l → 0
readlink + stat -c %Y/%y (no -L) of the four links
    /root/.claude/skills/substrate-skills-sync-audit   → /root/agent-skills/substrate-skills-sync-audit, 1790479745 (03:29:05.393Z)
    /root/.grok/skills/substrate-skills-sync-audit     → /root/agent-skills/substrate-skills-sync-audit, 1790479745 (03:29:05.394Z)
    /root/.agents/skills/substrate-skills-sync-audit   → /root/agent-skills/substrate-skills-sync-audit
    /root/.config/muse/skills/substrate-skills-sync-audit → /root/agent-skills/substrate-skills-sync-audit
git -C /root/agent-skills rev-parse HEAD; status --porcelain | wc -l     → df0db4e18b2837a1907d4fd4ddb86c3b825310f1, 0
cd /tmp && timeout 60 grok inspect 2>&1 | grep -cE '(^|[^A-Za-z0-9_-])substrate-skills-sync-audit([^A-Za-z0-9_-]|$)' → 1
    (matching line: `└ substrate-skills-sync-audit  user`)
mkdir -p /tmp/p4-claude-probe && cd /tmp/p4-claude-probe && timeout 180 claude -p ok --output-format stream-json --verbose --max-turns 1 > /tmp/04-12-claude.jsonl 2>/dev/null
                                                                         → exit 124 (the 180 s stop hit after the init event was written)
python3: type system, subtype init                                       → claude_code_version present, 243 slash_commands, 205 skills;
                                                                           substrate-skills-sync-audit in slash_commands and in skills
rm -f /tmp/04-12-claude.jsonl; rm -rf /tmp/p4-claude-probe               → gone
test -e /var/lib/substrate/skills/{disable-agents-root,enable-cursor-root} → absent, absent
find /root/.agents/skills -mindepth 1 -maxdepth 1 -type l -lname '/root/agent-skills/*' | wc -l → 42
find -L /root/agent-skills -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l → 42
hermes skills list | grep -c substrate-skills-sync-audit                 → 0 (the default table width truncates the name column);
COLUMNS=250 hermes skills list | grep -c substrate-skills-sync           → 1 (`substrate-skills-sync-audit … local … enabled`)
bun /tmp/04-12-load.ts (scratch, removed): loadSkills({ cwd: "/tmp", customDirectories: ["/root/agent-skills"] }),
    name match with realpath under /root/agent-skills/                   → 1
```

The timer's first tick after the merge (03:28:56Z, 117 s later, on the 5-minute cadence) fast-forwarded
the checkout to the merge commit and created all four links at 03:29:05Z. D = 1790479745 − 1790479619 = 126 s.
Both config files kept the mtimes recorded at the Omp-route baseline, earlier than the merge, so neither
was written in the merge → observation window and no keys-only diff was needed.

owner_merge_answer=merged
owner_merge=delegated
owner_merge_note=Authorize agent to merge #7 (option: You authorize a one-time exception to D-16: I run `gh pr merge 7 --squash` and the proof records `owner_merge=delegated` with your answer verbatim.)
t_merged=2026-09-27T03:26:59Z
merge_sha=df0db4e18b2837a1907d4fd4ddb86c3b825310f1
t_timer_trigger=2026-09-27T03:28:56Z
t_projected=2026-09-27T03:29:05Z
delta_merge_to_projection_s=126
sync_journal_line=2026-09-27T03:29:05.393949+00:00 [projector] claude link-new substrate-skills-sync-audit
manual_sync_after_merge=false
claude_link=true
grok_link=true
claude_settings_mtime_after=1790356194
grok_config_mtime_after=1790447779
claude_grok_touched=false
claude_grok_same_as_omp_route=true
grok_inspect_count_after=1
grok_inspect_lists=true
claude_init_lists=true
agents_link=true
cursor_flags_absent=true
agents_library_links=42
library_skill_count=42
sc3_cursor_file_level=true
muse_link=true
hermes_lists=true
omp_lists=true
proof_result=pass

## Gaps

- D-16 / D-21 (merge checkpoint): the owner did not click merge on PR #7. The orchestrator merged it
  with `gh pr merge 7 --squash` under the owner's explicit one-time authorization, recorded above as
  owner_merge=delegated with the answer verbatim. Before that, a relayed "merged" answer arrived while
  gh still reported the PR OPEN (02:50Z–03:02Z). The merge was not done by the executor.
- Task 3 direct-path tie: the proposal took the queued path (slow propose, `existing` from the bridge
  re-post), so the Omp session file holds the queue path, not the PR URL. The bridge-log omp line ties
  the queue file to PR #7, and the PR body's session_id equals the session file's id.

## Failed runs
