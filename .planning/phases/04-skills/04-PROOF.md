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

## Gaps

## Failed runs
