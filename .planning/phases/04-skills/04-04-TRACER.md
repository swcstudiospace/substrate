# 04-04 skills tracer evidence (far end)

Recorded from observed output only.

## Snapshot and routes before any live write

```
P=/var/lib/substrate/phase4-baseline/04-04/20260926T072735Z
find /root/.claude/skills /root/.grok/skills -mindepth 1 -maxdepth 1 -printf '%p\t%y\t%l\n' | sort > $P/roots.listing.tsv
sha256sum roots.listing.tsv > MANIFEST.sha256 && sha256sum -c MANIFEST.sha256    # in $P
# then RESTORE.d/04-04.md (timer, units, links, Grok targets, per-run routes) and its RESTORE.md index row
```

The listing held 117 rows (74 Claude, 43 Grok), 23 of them links (all Grok, all into the
docs-scraper exports dir); the manifest verified; both dirs are 0700. A read-only
`bun packages/projector/src/skills.ts --check` before the install exited 1 with 40 `link-new claude`,
7 `link-new grok` and 23 `repoint grok` lines and wrote nothing (no projector/ dir, no state file).

snapshot_dir=/var/lib/substrate/phase4-baseline/04-04/20260926T072735Z

## Install and the two runs

```
sudo install -m 0644 infra/vps/substrate-skills-sync.service infra/vps/substrate-skills-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now substrate-skills-sync.timer
sudo systemctl start substrate-skills-sync.service          # second run
journalctl -u substrate-skills-sync --since '2026-09-26 07:27:56'
diff infra/vps/substrate-skills-sync.service /etc/systemd/system/substrate-skills-sync.service
diff infra/vps/substrate-skills-sync.timer /etc/systemd/system/substrate-skills-sync.timer
systemctl is-enabled substrate-skills-sync.timer
bun packages/projector/src/skills.ts --check; echo $?
```

`enable --now` at 07:27:57Z started the service at once (the host booted at 07:02, so
`OnBootSec=2min` had already elapsed): that timer-started tick is the first run. The first run
printed `[skills-sync] current 3ac857273e02a9dfe2d35383a9ccbbc3f16ed7ec` (the tracer PR is not
merged, so main was unchanged), 40 `[projector] claude link-new <name>`, 7 `grok link-new`,
23 `grok repoint`, 10 `grok skip-warn <name> (real-dir)` (docs-scraper and the nine real
parallel-* dirs), then `[projector] actions=70 warnings=10`; Result=success, exit 0. The second run
(`systemctl start`, 07:28:14Z) printed `[skills-sync] current 3ac8572…`,
`[projector] actions=0 warnings=0` and `[projector] already current (claude, grok)`. Next tick
listed at 07:33:14Z (5 min after the last activation).

sync_units_diff_clean=true
timer_enabled=enabled
first_run_result=current
first_run_actions=70
second_run_actions=0
check_exit=0
warnings_first_run=10
warnings_second_run=0

## Projection counts

```
find /root/.claude/skills -mindepth 1 -maxdepth 1 -type l -lname '/root/agent-skills/*' | wc -l
find /root/.grok/skills -mindepth 1 -maxdepth 1 -type l -lname '/root/agent-skills/*' | wc -l
find /root/.grok/skills -mindepth 1 -maxdepth 1 -type l -lname '*/docs-scraper/data/exports/*' | wc -l
find /root/.grok/skills -mindepth 1 -maxdepth 1 ! -type l -printf '%f\n' | grep -Fxf <library names> | wc -l
diff <(cut -f2 t0/20260926T033909Z/listings/_root_.grok_skills.tsv | grep -vFxf <library names> | sort) \
     <(ls -A /root/.grok/skills | grep -vFxf <library names> | sort)
find /root/.claude/skills /root/.grok/skills -maxdepth 1 -name '*.substrate-tmp' | wc -l
find /root/.claude/skills /root/.grok/skills -maxdepth 1 -xtype l | wc -l
```

Claude: 40 links into the library, its 74 own entries unchanged. Grok: 30 links into the library
(23 repointed + 7 new), 0 links left into the exports dir, the 10 real library-named dirs untouched.
Grok's non-library names (README.md, autonogrammer-operating, companion-clis, flash, runpod,
runpod-mcp, runpod-migrate, runpod-templates, runpod-usage, runpodctl) equal the 04-01 t0
listing's. No `.substrate-tmp` entry and no dangling link in either root.

claude_library_links=40
grok_library_links=30
grok_exports_links_left=0
grok_real_skipped=10
grok_non_library_unchanged=true

## Backups and warning state

```
sudo stat -c %a /var/lib/substrate/phase4-baseline/projector/20260926T072758Z
sudo grep -c "^rm \|^ln -sfn " /var/lib/substrate/phase4-baseline/projector/20260926T072758Z/RESTORE.md
sudo stat -c %a /var/lib/substrate/skills/projector-warned.json
```

One projector run dir (the first run; the second made no change and created none), mode 700, whose
RESTORE.md holds 70 undo lines (40 + 7 `rm '<root>/<name>'`, 23 `ln -sfn '<exports target>'
'<root>/<name>'`). The dedupe state is 0600 with 10 keys (grok:<name>:real-dir).
`/root/agent-skills` porcelain stayed empty.

projector_backup_dir=/var/lib/substrate/phase4-baseline/projector/20260926T072758Z
projector_restore_lines=70
warned_state_keys=10
library_porcelain_empty=true

## Gaps

- The first run was started by the timer on `enable --now` (boot was more than 2 min earlier), not
  by the plan's explicit `systemctl start`; the `systemctl start` became the second run. Both runs
  are in the journal with their own start lines.
- The 10 identical real Grok dirs are skipped with a warning here by design; backup-then-link for
  them arrives in 04-05.
- The warning events were accepted by the substrate (the projector counts only accepted POSTs);
  they were not read back from the event store.
