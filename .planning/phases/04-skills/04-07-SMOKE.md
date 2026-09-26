# 04-07 Hermes projection and miner evidence

Recorded from observed output only.

## Task 1 — write_approval first, then external_dirs; shadowing links and anda-ecosystem

```
H=/var/lib/substrate/phase4-baseline/04-07/20260926T090500Z
sudo cp -a /root/.hermes/config.yaml $H/config.yaml                     # never printed
find /root/.hermes/skills -mindepth 1 -maxdepth 1 -type l -printf '%f\t%l\n' | sort > $H/hermes-links.tsv   # 33 rows
# RESTORE.d/04-07.md written here: whole-file config route, key-by-key route
# (external_dirs '[]' first, then write_approval false ×2), links route, anda route
date +%s                                                                 # plan_start_epoch
git -C /root/agent-skills status --porcelain                             # empty
hermes config set skills.write_approval true
hermes config set memory.write_approval true
hermes config get skills.write_approval; hermes config get memory.write_approval   # true, true
date +%s                                                                 # write_approval_on_epoch
COLUMNS=250 hermes skills list                                           # timed; no objective-dev-loop row
hermes config set skills.external_dirs '["/root/agent-skills"]'
date +%s                                                                 # external_dirs_set_epoch
hermes config get skills.external_dirs                                   # - /root/agent-skills
COLUMNS=250 hermes skills list                                           # objective-dev-loop row present
cd /usr/local/lib/hermes-agent && HOME=/root venv/bin/python -c '… skill_manage(action="patch",
  name="objective-dev-loop", old_string=<first line>, new_string=<same line>) …'   # staged=True pending_id=c57bb33b
git -C /root/agent-skills status --porcelain                             # still empty
HOME=/root venv/bin/python -c '… discard_pending("skills","c57bb33b") …'  # discarded=True; pending/skills empty
# links to remove: top-level link, name in find /root/agent-skills -mindepth 2 -maxdepth 2 -name SKILL.md (41 names),
# target under the docs-scraper exports skills dir or /root/agent-skills/ → $H/hermes-links.removed.tsv (33 rows), then rm each
diff -rq -x __pycache__ -x '*.pyc' /root/.hermes/skills/research/anda-ecosystem /root/agent-skills/anda-ecosystem   # no output
sudo mv /root/.hermes/skills/research/anda-ecosystem $H/hermes-research-anda-ecosystem
COLUMNS=250 hermes skills list                                           # timed; all 41 library names listed
```

The probe record was `origin: foreground`, `action: patch`, payload keys `action, name, new_string,
old_string, replace_all` — Hermes staged it before touching objective-dev-loop, which exists only in
external_dirs. Removed links: 20 into
`/root/.openclaw/workspace/projects/docs-scraper/data/exports/skills/` and 13 into
`/root/agent-skills/`. `hermes skills list` summary line before: `10 hub-installed, 25 builtin,
160 local — 195 enabled`; after: `10 hub-installed, 25 builtin, 167 local — 202 enabled`
(160 − 33 links − anda + 41 library skills). Both timings are the `COLUMNS=250` form (a first,
narrow-terminal run before the change took 2772 ms and truncated names).

plan_start_epoch=1790413523
library_clean_t0=true
write_approval_on_epoch=1790413526
external_dirs_set_epoch=1790413572
write_approval_before_external_dirs=true
foreground_library_write_staged=true
foreground_probe_id=c57bb33b
foreground_probe_discarded=true
external_dirs_set=true
objective_dev_loop_before=absent
objective_dev_loop_after_config=listed
hermes_links_removed=33
hermes_library_links_left=0
anda_moved=true
hermes_lists_all_library=true
skills_list_ms_before=1854
skills_list_ms_after=2296
backup_dir=/var/lib/substrate/phase4-baseline/04-07/20260926T090500Z
library_clean_after_t1=true

## Task 3 — routes, write_approval, cron job, bridge timer, live gate → PR and a held local write

```
sudo cp -a /root/.hermes/cron/jobs.json /var/lib/substrate/phase4-baseline/04-07/20260926T090500Z/jobs.json                     # MANIFEST.sha256 refreshed
# RESTORE.d/04-07.md sections 4 (cron remove), 5 (shim rm), 6 (bridge units) appended here
ls /root/.hermes/pending/memory/*.json | wc -l                           # 3
hermes config get skills.write_approval; hermes config get memory.write_approval   # true, true (not changed here)
install -m 0755 packages/miner/hermes/substrate-skill-miner-monitor.sh /root/.hermes/scripts/
bash /root/.hermes/scripts/substrate-skill-miner-monitor.sh               # "day 2026-09-26" (no transcripts yet)
hermes cron create "0 * * * *" "<prompt from the plan>" --name substrate-skill-miner \
  --skill substrate-skill-miner --monitor-script substrate-skill-miner-monitor.sh \
  --workdir /root/src/repos/agent-substrate                             # Created job: 0c172431cf5b
python3 -c '<jobs.json: name, monitor_script, created_at, next_run_at of the job only>'
sudo install -m 0644 infra/vps/substrate-skills-bridge.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now substrate-skills-bridge.timer
# 09:14:36Z first tick (enable --now): proposed=0 held=0 … key=ok
cd /usr/local/lib/hermes-agent && HOME=/root venv/bin/python -c '… skill_manage(action="patch",
  name="substrate-skill-miner", old_string="reviews and merges it.", new_string=<line + one sentence>)
  … skill_manage(action="patch", name="aceternity-template-sites", old_string=<first line>,
  new_string=<same line>) …'                                            # 09:15:06Z: staged=True 0d81c9ec, staged=True 06be4fb3
# no manual start; the timer's 09:19:38Z tick:
journalctl -u substrate-skills-bridge   # [skills-bridge] proposed=1 rejected=0 held=1 kept=0 waiting=0 … key=ok
sudo cat /var/lib/substrate/miner/bridge-log.jsonl
env -i HOME=/root PATH=/usr/bin:/bin gh pr view https://github.com/swcstudiospace/agent-skills/pull/5 --json changedFiles,files,state,headRefName
HOME=/root venv/bin/python -c '… discard_pending("skills","06be4fb3") …'   # discarded=True
journalctl -u substrate-skills-sync --since @1790413523 | grep -c 'refused.*dirty'   # 0
```

jobs.json binding (job 0c172431cf5b): `monitor_script: substrate-skill-miner-monitor.sh`,
`skills: [substrate-skill-miner]`, schedule expr `0 * * * *`, `workdir` the repo, deliver `local`,
`monitor_state` null (no tick yet). Bridge log lines (verbatim):
`{"id": "06be4fb3", "name": "aceternity-template-sites", "reason": "hermes-local", "resolve": "Hermes-local skill (not in the library): the owner may `/skills approve 06be4fb3` or `/skills reject 06be4fb3`.", "status": "held", "ts": "2026-09-26T09:19:38Z"}`
and `{"ids": ["0d81c9ec"], "name": "substrate-skill-miner", "pr_url": "https://github.com/swcstudiospace/agent-skills/pull/5", "status": "opened", "ts": "2026-09-26T09:19:44Z"}`.
PR #5: OPEN, head `skill/hermes/substrate-skill-miner-20260926T091939684Z-cd08`, files
`["substrate-skill-miner/SKILL.md"]`. Timer LastTriggerUSec `Sat 2026-09-26 09:19:38 UTC`, after
the 09:15:06Z staging; the record was 272 s old. bridge-held.json held `06be4fb3: hermes-local`
after the tick; the held skill's files hash the same before and after (sha256 over every file).
~/.hermes/pending/skills is empty afterwards; no `/root/.hermes/skills/substrate-skill-miner`.

restore_routes_written=true
skills_write_approval=true
memory_write_approval=true
monitor_shim_real_file=true
monitor_last_line_is_day=true
cron_job_id=0c172431cf5b
cron_schedule=0 * * * *
cron_skill=substrate-skill-miner
cron_monitor_bound=substrate-skill-miner-monitor.sh
cron_created_at=2026-09-26T19:14:26.372536+10:00
cron_next_run_at=2026-09-26T20:00:00+10:00
cron_manual_runs=0
bridge_timer_active=active
bridge_units_diff_clean=true
staged_via_gate=true
staged_epoch=1790414106
bridge_run_by_timer=true
bridge_tick_at=2026-09-26T09:19:38Z
bridge_status=opened
bridge_pr_url=https://github.com/swcstudiospace/agent-skills/pull/5
bridge_pr_changed_files=1
bridge_pr_files=substrate-skill-miner/SKILL.md
bridge_group_records_left=0
held_local_name=aceternity-template-sites
held_local_id=06be4fb3
held_local_status=held
held_local_record_kept=true
held_local_discarded=true
pending_skills_other=0
hermes_pending_memory_before=3
hermes_pending_memory_after=3
hermes_local_write=false
library_clean=true
sync_dirty_refusals_since_start=0

## Gaps

- `skills_list_ms_after` includes 41 library skills read from /root/agent-skills (and its `.git`,
  Pitfall 9): +442 ms on one sample each side; not averaged.
- PR #5 stays OPEN for the owner (D-16); the proof's preflight lists it. It is not merged here.
- The cron job has not ticked yet (created 09:14:26Z, next run 10:00Z local 20:00+10:00); 04-12 Task 1 reads its scheduled, suppressed ticks back. No `hermes cron run` was issued.
- The held-local probe was a no-op patch (old = new); it proves the hold path, not a real local-skill edit.
- systemd logged "Failed to add … inotify watch descriptor … No space left on device" at unit start (host inotify limit, not disk); the unit ran and finished normally.
