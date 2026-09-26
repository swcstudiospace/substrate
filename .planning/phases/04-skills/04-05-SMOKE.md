# 04-05 projection evidence

Recorded from observed output only.

## Timer stopped for the edit (Task 1 precondition)

```
grep -c '^claude_init_lists=true' .planning/phases/04-skills/04-04-TRACER.md    # 1
sudo systemctl stop substrate-skills-sync.timer
systemctl is-active substrate-skills-sync.timer substrate-skills-sync.service   # inactive, inactive
```

Before the edit, `diff -rq -x __pycache__ -x '*.pyc' /root/.grok/skills/<name> /root/agent-skills/<name>`
reported all ten library-named real Grok dirs identical (docs-scraper and parallel-{chat, common,
extract, findall, monitor, responses, search, stock-deep-research, task}). No other root holds a real
dir or a non-library link under a library name.

## Snapshot and routes before any live write

```
P=/var/lib/substrate/phase4-baseline/04-05/20260926T090925Z
find /root/.agents/skills /root/.openclaw/skills /root/.openclaw/workspace/skills /root/.grok/skills -mindepth 1 -maxdepth 1 -printf '%p\t%y\t%l\n' | sort > $P/roots.listing.tsv
sha256sum roots.listing.tsv > MANIFEST.sha256 && sha256sum -c MANIFEST.sha256    # in $P: OK
# then RESTORE.d/04-05.md (agents/muse links, OpenClaw targets, Grok dirs, flags, per-run routes) and its RESTORE.md index row
```

The listing holds 198 rows: ~/.agents/skills 80 real dirs; ~/.grok/skills 19 dirs, 1 file, 31 links;
~/.openclaw/skills 5 dirs, 30 links; ~/.openclaw/workspace/skills 2 dirs, 30 links. A read-only
`bun packages/projector/src/skills.ts --check` before the run exited 1 with 41 `link-new agents`,
41 `link-new muse`, 20 `repoint openclaw`, 20 `repoint openclaw-ws` and 10 `backup-then-link grok`.

snapshot_dir=/var/lib/substrate/phase4-baseline/04-05/20260926T090925Z

## The two runs and --check

```
bun packages/projector/src/skills.ts            # first run
bun packages/projector/src/skills.ts            # second run
bun packages/projector/src/skills.ts --check; echo $?
```

First run (exit 0): `[projector] muse created /root/.config/muse/skills`, 41 `agents link-new`,
41 `muse link-new`, 20 `openclaw repoint`, 20 `openclaw-ws repoint`, 10 `grok backup-then-link`,
then `[projector] actions=132 warnings=0`. Second run: `[projector] actions=0 warnings=0` and
`[projector] already current (claude, grok, agents, muse, openclaw, openclaw-ws)`. `--check` printed
the same already-current line and exited 0. The cursor root is absent from the list: its enable
flag does not exist.

first_run_actions=132
second_run_actions=0
check_exit=0

## Projection counts

```
names = the /root/agent-skills subdirs holding a SKILL.md
find /root/.agents/skills -maxdepth 1 -lname '/root/agent-skills/*' | wc -l
find /root/.agents/skills -mindepth 1 -maxdepth 1 ! -type l | wc -l
find /root/.config/muse/skills -maxdepth 1 -lname '/root/agent-skills/*' | wc -l; stat -c '%a %U' /root/.config/muse/skills
find <openclaw dir> -mindepth 1 -maxdepth 1 -lname '*docs-scraper/data/exports/*' -printf '%f\n' | grep -cxFf <names>
find <openclaw dir> -mindepth 1 -maxdepth 1 -type l | wc -l
find /root/.grok/skills -mindepth 1 -maxdepth 1 ! -type l -printf '%f\n' | grep -cxFf <names>
find <the five roots> -maxdepth 1 \( -name '*.substrate-tmp' -o -name '*.substrate-old' -o -xtype l \) | wc -l
```

~/.agents/skills: 41 library links and its 80 real skills (the 04-01 count) untouched.
~/.config/muse/skills: created 0755 root, 41 entries, all library links. OpenClaw: in each dir 0
links left into the exports dir (the 20 were all library names), 30 library links, total links
30 before and 30 after, real dirs unchanged (5 and 2). Grok: 41 library links, no library-named
real dir left; its remaining real entries are exactly GROK_KNOWN_REAL (README.md,
autonogrammer-operating, companion-clis, flash, runpod, runpod-mcp, runpod-migrate,
runpod-templates, runpod-usage, runpodctl), so no stray-real-dir warning. No `.substrate-tmp`,
`.substrate-old` or dangling link in any of the five roots.

library_count=41
agents_library_links=41
agents_real_entries=80
muse_library_links=41
openclaw_export_links_left=0
openclaw_ws_export_links_left=0
openclaw_total_links_unchanged=true
grok_library_real_dirs_left=0

## Muse lists the library

```
cd /tmp && timeout 60 /root/.local/bin/muse-bin-1.4.0-R4161.1 skills list --source user --json > /tmp/0405-muse.json   # exit 0
python3: ids of .skills[] ∩ names; path prefix of those entries
```

123 user skills listed; all 41 library names are among them, each with path
`$CONFIG_DIR/skills/<name>/SKILL.md` (activation on, provenance null). The 78 diagnostics are all
`skill-shadowed` for gsd-* entries of ~/.claude/skills; none names a library skill.

muse_lists_library=true

## Grok backups

```
R=/var/lib/substrate/phase4-baseline/projector/20260926T090952Z
sudo ls -1 $R/grok | wc -l                                                     # 10
sudo sh -c "cd $R && sha256sum -c --quiet MANIFEST.sha256" && wc -l < $R/MANIFEST.sha256   # OK, 22 files
sudo stat -c %a $R                                                            # 700
sudo grep -c "^rm '/root/.grok/skills/.*' && cp -a " $R/RESTORE.md             # 10
sudo grep -cE '^(rm |ln -sfn |rmdir )' $R/RESTORE.md                          # 133
diff -rq -x __pycache__ -x '*.pyc' $R/grok/<name> /root/agent-skills/<name>   # silent for all 10
git -C /root/agent-skills status --porcelain | wc -l                          # 0
```

The run dir holds the ten Grok copies (including parallel-common's `__pycache__`), a
MANIFEST.sha256 that verifies (22 files), and 133 undo lines: 82 `rm` for the new links, 40
`ln -sfn` for the repoints, 10 `rm … && cp -a …` for the Grok dirs, 1 `rmdir` for the Muse root.

grok_backups=10
backup_dir=/var/lib/substrate/phase4-baseline/projector/20260926T090952Z

## Timer back on

```
sudo systemctl start substrate-skills-sync.timer
systemctl is-active substrate-skills-sync.timer     # active
journalctl -u substrate-skills-sync --since '2026-09-26 09:10:20'
```

Starting the timer ran the service at once (09:10:25Z; the last activation was more than 5 min
earlier): `[skills-sync] current 34b32e27…`, `[projector] actions=0 warnings=0`,
`[projector] already current (claude, grok, agents, muse, openclaw, openclaw-ws)`, Finished. Next
tick listed at 09:15:25Z.

timer_active=active

## Gaps

- Cursor duplicate risk (research Q2, Pitfall 8): with third-party extensibility on, Cursor may list
  each library skill twice, via ~/.claude/skills and ~/.agents/skills (same realpath). Not checked
  here; the owner checks the Cursor `/` menu in the proof. If it shows duplicates,
  `touch /var/lib/substrate/skills/disable-agents-root` makes the next tick remove only the
  projector's links there; if Cursor ignores ~/.agents/skills,
  `touch /var/lib/substrate/skills/enable-cursor-root` adds the ~/.cursor/skills root. Both flags are
  absent now.
- Muse was probed with the CLI list only; a running Muse session picks the links up after
  `/skills reload` or a new session (research Q3, not exercised).
- The systemd tick after the re-enable logged `Failed to add … inotify watch descriptor … No space
  left on device` for the unit's cgroup (the inotify watch limit, not the disk: / had 16 GB free);
  the service still ran and finished successfully. It predates this plan: 10 such lines for this unit
  and 843 host-wide in the journal between 00:00Z and 09:10Z today.
- The 04-04 dedupe state keeps its 10 `grok:<name>:real-dir` keys; the reason no longer exists and the
  keys are inert.
