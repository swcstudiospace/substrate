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

## Gaps

- `skills_list_ms_after` includes 41 library skills read from /root/agent-skills (and its `.git`,
  Pitfall 9): +442 ms on one sample each side; not averaged.
