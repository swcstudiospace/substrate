# 04-10 docs-scraper publish evidence

Recorded from observed output only.

No crawl was run (a batch run, even `--dry-run`, rewrites the pipeline's state file; crawl
scheduling is deferred). The script's own `_propose_skill` was loaded from
`scripts/batch_docs_skills.py` (workspace commit `0d7c2d6`) through the venv importlib pattern,
without monkeypatching, and called on real directories.

## Unchanged re-publish

```
diff -rq -x __pycache__ -x '*.pyc' /root/.openclaw/workspace/projects/docs-scraper/data/exports/skills/docs-python /root/agent-skills/docs-python   # no output
cd /root/.openclaw/workspace/projects/docs-scraper && .venv/bin/python -B -c "…m._propose_skill(Path('data/exports/skills/docs-python').resolve(), 'docs-python', pages=0, source_id='04-10-unchanged')"
```

docs-python has 0 skill_redactions and 0 skill_findings in 04-02-SCAN.md. Output:
`{"propose_status": "unchanged", "pr_url": null}`, exit 0, no PR.

unchanged_export=docs-python
unchanged_status=unchanged

## Doc examples (D-18), dry run, no PR

```
bun packages/cli/src/index.ts skills propose --dir /root/agent-skills/docs-fastapi --surface docs-scraper --dry-run
bun packages/cli/src/index.ts skills propose --dir /root/agent-skills/docs-fastapi --surface docs-scraper --allow-doc-examples pem,jwt --dry-run
```

Without the flag: exit 1, `finding=references/037-OAuth2-with-Password-and-hashing-Bearer-with-JWT-tokens-Fast.md:20 jwt`,
`status=refused`, stderr "secret-like content in 1 place(s)…"; no value printed.
With the flag: exit 0, `status=dry_run`, `redactions=181`, `diff_added=0`, `diff_changed=9`,
`diff_deleted=0`, `event_status=none`. (181 counts every redacted span of the whole dir, the
04-02-SCAN over-redaction of auth-header scheme words included, not only the JWT example.)

docfastapi_without_flag_exit=1
docfastapi_without_flag_rule=jwt
docfastapi_with_flag_status=dry_run
docfastapi_with_flag_redactions=181

## Corrected docs-scraper skill (checker B1)

```
C="$(sudo mktemp -d /var/lib/substrate/skills/04-10-skill.XXXXXX)"
git -C /root/agent-skills archive --format=tar HEAD docs-scraper | sudo tar -x -C "$C"
realpath "$C/docs-scraper/SKILL.md"; find "$C" -type l | wc -l      # under $C/, 0
python3 (rewrite only "## Shared install (this VPS)" up to "## Status")
.venv/bin/python -B -c "…m._propose_skill(Path(C) / 'docs-scraper', 'docs-scraper', pages=0, source_id='docs-scraper-skill')"
env -i HOME=/root PATH=/usr/bin:/bin gh pr view <url> --json files --jq '[.files[].path] | join(",")'
env -i HOME=/root PATH=/usr/bin:/bin gh pr diff <url> | grep -cE '^\+.*skills propose'
sudo rm -rf "$C"
```

The scratch copy held one regular file (SKILL.md), 0 symlinks, realpath under the scratch dir.
The rewritten section says the library is `swcstudiospace/agent-skills` (owner merges, sync timer
updates `/root/agent-skills`), that `batch_docs_skills.py` proposes each export with
`substrate skills propose … --surface docs-scraper --allow-doc-examples pem,jwt --replace`, that it
no longer symlinks into agent dirs or rewrites the library README, and that agents read the library
through the substrate projection and Hermes `external_dirs` / OpenClaw `extraDirs`. Everything
outside that section is byte-identical to `HEAD:docs-scraper/SKILL.md`.
`_propose_skill` returned `{"propose_status": "opened", "pr_url": "https://github.com/swcstudiospace/agent-skills/pull/2"}`.
PR read-back: files `docs-scraper/SKILL.md`, state OPEN, 1 added line containing "skills propose";
body: surface docs-scraper, tree mode replace, removed paths none, redacted spans none.

skill_copy_outside_checkout=true
docs_scraper_skill_status=opened
docs_scraper_pr_url=https://github.com/swcstudiospace/agent-skills/pull/2
docs_scraper_pr_files=docs-scraper/SKILL.md
docs_scraper_pr_has_text=true
scratch_removed=true

## Live checkouts and links

```
readlink /root/.openclaw/workspace/projects/docs-scraper/skills/docs-scraper
git -C /root/.openclaw/workspace status --porcelain -- projects/docs-scraper/skills projects/docs-scraper/scripts
git -C /root/agent-skills status --porcelain
find /root/.hermes/skills /root/.openclaw/skills /root/.openclaw/workspace/skills /root/agent-skills -maxdepth 1 -newer /tmp/04-10-start -type l | wc -l
git -C /root/.openclaw/workspace ls-files | grep -vc '^projects/docs-scraper/'
```

Link `/root/agent-skills/docs-scraper`; both porcelain outputs empty; 0 new symlinks
(`/tmp/04-10-start` touched at the start of Task 2 and deleted at its end); 0 tracked paths outside
`projects/docs-scraper/`. The PR URL is appended to `RESTORE.d/04-10.md`.

workspace_skill_link=/root/agent-skills/docs-scraper
no_symlink_writes=true
library_clean=true

## Gaps

- No crawl was run: scheduling the docs-scraper crawl is deferred (CONTEXT § Deferred), so the
  full `process_one` path (crawl → export → `_propose_skill` → state `propose_status`/`pr_url`) is
  exercised only by the Task 1 venv check (monkeypatched subprocess) and the direct
  `_propose_skill` calls above.
- PR #2 stays OPEN: merging it is the owner's step (D-16). Until then the workspace link still
  shows the old "Shared install" text; after the merge the sync timer updates the library and the
  link shows the corrected skill.
- The docs-fastapi flagged dry run proposed nothing; no docs export has yet been opened as a PR
  with doc-example redactions listed in its body.
