# Phase 4 proof — a Cursor-mined skill reaches Claude Code and Grok Build untouched

Recorded from observed output only.

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

## Gaps

## Failed runs
