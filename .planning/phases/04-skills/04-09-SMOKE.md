# 04-09 Grok skill-autonomy evidence

Recorded from observed output only. 2026-09-26 (UTC), skill-autonomy at `394d5ea`, installed copy
`/root/.grok/installed-plugins/skill-autonomy-6d1e8e39`.

## Snapshot and restore route

`/var/lib/substrate/phase4-baseline/04-09/20260926T091357Z/` — `skill-autonomy.rule.md`,
`installed-plugin/`, `registry.json`, `config.toml`, `plugin-data/`, `MANIFEST.sha256`
(`sha256sum -c --quiet` clean). Routes: `RESTORE.d/04-09.md` (rule, plugin, reinstall, queue);
index row added to `RESTORE.md`.

## Reinstall

```
$ grok plugin update skill-autonomy
skill-autonomy-6d1e8e39: local symlink, already live
$ diff -rq -x .git -x .gitignore -x __pycache__ -x .pytest_cache /root/src/repos/skill-autonomy <installed>
(12 differing files, propose.py and test_propose.py only in the source)
```

`grok plugin update` does not recopy this Local install (it treats it as a live symlink, but the
installed path is a directory copy). The README's documented route was used instead:

```
$ grok plugin uninstall skill-autonomy --confirm --keep-data
Uninstalled 1 plugin(s): skill-autonomy (data preserved)
$ grok plugin install /root/src/repos/skill-autonomy --trust
Installed 1 plugin(s) from /root/src/repos/skill-autonomy: skill-autonomy
$ grok plugin enable skill-autonomy
Enabled plugin: skill-autonomy
$ diff -rq -x .git -x .gitignore -x __pycache__ -x .pytest_cache /root/src/repos/skill-autonomy /root/.grok/installed-plugins/skill-autonomy-6d1e8e39
(no output, exit 0)
```

Same registry key and path; `~/.grok/config.toml` byte-identical to its snapshot afterwards;
plugin-data (config.json, catalog-cache.json) kept.

plugin_updated=true
installed_equals_source=true

## Rule

```
$ install -m 0644 /root/src/repos/skill-autonomy/rules/skill-autonomy.md /root/.grok/rules/skill-autonomy.md
$ cmp /root/src/repos/skill-autonomy/rules/skill-autonomy.md /root/.grok/rules/skill-autonomy.md
(exit 0)
```

rule_installed=true

## grok inspect

```
$ cd /tmp && timeout 60 grok inspect
  └ /root/.grok/rules/skill-autonomy.md (global, ~393 tokens)
  └ autolearn                           plugin: skill-autonomy
  └ skill-autonomy (user, enabled)       2 skills, hooks
```

grok_inspect_autolearn=true

## Live propose

Draft `~/.grok/plugin-data/skill-autonomy/drafts/grok-skill-propose/SKILL.md` (name
grok-skill-propose, description, when-to-use, `disable-model-invocation: false`, numbered steps on
proposing with `skill-autonomy propose`, the PR URL and the bridge-drained pending queue).

```
$ /root/.grok/installed-plugins/skill-autonomy-6d1e8e39/bin/skill-autonomy propose ~/.grok/plugin-data/skill-autonomy/drafts/grok-skill-propose --rationale "…"
{
  "status": "opened",
  "pr_url": "https://github.com/swcstudiospace/agent-skills/pull/4"
}
(exit 0, 5.8 s)
$ gh pr view 4 -R swcstudiospace/agent-skills --json state,title,headRefName,files
OPEN  skill(grok-skill-propose): proposal from grok-build  skill/grok-build/grok-skill-propose-20260926T091539058Z-07ce  grok-skill-propose/SKILL.md
```

PR #4 is left open for the owner (D-16). The draft was deleted afterwards.

grok_propose_status=opened
grok_pr_url=https://github.com/swcstudiospace/agent-skills/pull/4

## Pending path (isolated from the live bridge)

```
$ SKILL_AUTONOMY_DATA_DIR=/tmp/04-09-data SKILL_AUTONOMY_SUBSTRATE_URL=http://127.0.0.1:9 <installed>/bin/skill-autonomy propose /tmp/04-09-data/drafts/grok-skill-queue-check
{
  "status": "pending",
  "path": "/tmp/04-09-data/pending/grok-skill-queue-check-20260926T091550737361Z.json",
  "reason": "substrate unreachable: URLError"
}
(exit 0)
file-mode=600  dir-mode=700
key present in the file: no (fixed-string grep of the key file's content, exit 1)
body keys: files, name, rationale, surface; name grok-skill-queue-check; surface grok-build; files SKILL.md
live queue ~/.grok/plugin-data/skill-autonomy/pending: 0 files before, 0 after
$ rm -rf /tmp/04-09-data   (then test ! -e /tmp/04-09-data)
```

grok_pending_status=pending
grok_pending_mode=600
grok_queue_check_removed=true

## No local skill

```
$ find /root/.grok/skills -mindepth 1 -maxdepth 1 ! -type l -newer /tmp/04-09-marker | wc -l
0
```

grok_new_real_skill_dirs=0

## /autolearn dry run on the installed copy

```
$ <installed>/bin/skill-autonomy autolearn --days 30
sessions=44 candidates=2 drafts=2 created=0 skipped=0
  [NEW] user-prompt (9 sessions) — Users keep typing /user-prompt with no matching skill.
  [NEW] ultrathink (3 sessions) — Users keep typing /ultrathink with no matching skill.
dry-run; pass --apply to have these skills proposed as PRs to the shared skills library
```

## Gaps

- The Stop-hook path is model-driven: the hook only returns context telling the model to write a
  draft and run `skill-autonomy propose`. It is covered by `tests/test_hooks.py` plus the live
  propose CLI above; a live Grok model session is not run here.
- `grok plugin update skill-autonomy` is a no-op for this install ("local symlink, already live");
  future source changes need the uninstall `--keep-data` / install `--trust` / enable route.
- SessionEnd auto-create (`improve.auto_create`, default on) now proposes synchronously inside the
  8 s SessionEnd hook budget (about 6 s per new PR, up to `max_new_per_run` = 8). A hook killed
  mid-run loses nothing (unproposed candidates are retried at the next SessionEnd; re-proposals
  answer `existing`), but a slow run can be cut short. [INFERENCE] Slash-gap candidates like the
  two above (`user-prompt`, `ultrathink`) can become library PRs once SessionEnd's session index
  reaches `min_sessions`; the owner reviews or closes them (a closed one answers `declined`).
