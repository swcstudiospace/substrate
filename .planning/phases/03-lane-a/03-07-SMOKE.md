# 03-07 PR and sync smoke evidence

Recorded from observed output only. Column-0 `key=value` lines are the plan's closed set; raw
probe output and the extra guard exercise are indented four spaces so every key keeps exactly one
column-0 line. No GitHub write happened in this plan: the push ran with `--dry-run` only and
`pr-create` was never invoked (03-10 runs both first).

## Task 1 — commit through the c-route, push guard, credential path (D-08, T-03-07-01/07/08)

Route of the unit: `a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn` (03-01-SPIKE.md
`route_choice`), so the commit is the `agentos-substrate commit` host function; the other two
c-routes' branches (npm install of `@agentos-software/git`, the sandbox git shim) did not run and
`packages/host/package.json` is unchanged.

```
sudo systemctl restart substrate-host && curl -sf 127.0.0.1:7411/healthz      # 15:38:55Z → {"engine":true,"api":true}
PYTHONPATH=packages/dispatcher/src python3 /tmp/03-07-open.py open SMK-7      # throwaway (deleted): graph_register over MCP
                                                                              # (no Linear/Notion refs, n1 unstarted), dispatcher
                                                                              # ensure_worktree(repo_checkout(...), <gid>, 'main'), POST /tasks
PYTHONPATH=packages/dispatcher/src python3 /tmp/03-07-open.py wait-event <gid> 90
sudo systemd-run --quiet --wait --pipe --collect -p WorkingDirectory=/root/src/repos/agent-substrate/packages/host \
  -E HOME=/root /usr/bin/node .probe-03-07.mjs smoke <gid>   # throwaway rivet client on 127.0.0.1:6420 (deleted): in the VM,
                                                             # node -e writes /home/agentos/work/smoke-03-07.txt and
                                                             # .substrate-hook-input.json, then agentos-substrate commit --node n1 …
git -C /var/lib/substrate/worktrees/<gid> log -1 --format=%s; git -C … show --name-only --format= HEAD | grep -c '\.substrate-'
sudo systemd-run … /usr/bin/node .probe-03-07.mjs guard <gid>   # imports src/hostfns.ts, checkScratch({graphId, base:"main", run: execFileRunner})
sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env -E HOME=/root \
  /usr/bin/git -C /var/lib/substrate/worktrees/<gid> push --dry-run origin substrate/<gid> > /dev/null 2>&1; echo $?
sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env -E HOME=/root \
  /usr/bin/gh auth status > /dev/null 2>&1; echo $?
sudo grep -c '^GH_TOKEN=' /etc/substrate/substrate.env; sudo grep -c '^GITHUB_TOKEN=' /etc/substrate/substrate.env
curl -s -X POST 127.0.0.1:7411/tasks/<gid>/n1/kill; git worktree remove --force /var/lib/substrate/worktrees/<gid>; git branch -D substrate/<gid>
```

Open: POST /tasks 202 at `t_open=2026-09-25T15:39:33Z`, nine seed files; first model event
(`permission_request`, tool Read, `state=waiting`) at 15:40:01Z. The probe ran while that request
was pending (the model never touched the worktree; every file below is the probe's):

    vm_write=exit=0 stdout="" stderr=""
    vm_ls=exit=0 stdout=".\n..\n.env.example\n.git\n.gitignore\n.planning\n.substrate-hook-input.json\nAGENTS.md\nREADME.md\nbun.lock\ninfra\nnode_modules\npackage.json\npackages\nsmoke-03-07.txt\ntsconfig.json\n" stderr=""
    vm_commit=exit=0 stdout="{\"ok\":true,\"result\":{\"committed\":true,\"sha\":\"7e8883543673ff71523830a3d0c073e4289bb39a\"}}" stderr=""
    vm_commit_bad_node=exit=0 stdout="{\"ok\":true,\"result\":{\"error\":\"no task for node n9 in this VM\"}}" stderr=""
    vm_pr_create_help=exit=1 stdout="" stderr="Unknown flag: --help\n"

On the host, read from the worktree after the VM's commit call:

    host_log_1=03-07 smoke
    host_head_sha=7e8883543673ff71523830a3d0c073e4289bb39a
    host_branch=substrate/ut-d09f05d6smk-62523d4b
    commit_files=smoke-03-07.txt,
    scratch_in_commit_count=0
    worktree_status=?? .substrate-hook-input.json,
    commit_author=substrate claude-code <claude-code@substrate.local>

The journal carries `[substrate-host] commit ut-d09f05d6smk-62523d4b/n1 7e8883543673` between
`task opened` and `task killed`. The `add -A -- . :(exclude,glob)**/.substrate-*` step left the
scratch file untracked, so the commit holds only the payload; the guard then read the diff against
`origin/main` and found no scratch path.

c_route=hostfn_commit
smoke_graph_id=ut-d09f05d6smk-62523d4b
vm_commit_on_host=true
scratch_in_commit=false
push_guard=clear

The guard's refusal was exercised on the same throwaway branch, on the host, without any push: the
scratch file was force-staged (`git add -f`) and committed as "03-07 scratch (never pushed)", the
guard script ran again, and the branch was reset to the smoke commit (`git reset --hard HEAD~1`,
working tree clean afterwards):

    forced_commit_files=.substrate-hook-input.json,
    push_guard=refused
    push_guard_reason="branch contains substrate scratch files: .substrate-hook-input.json"
    after_reset_head=03-07 smoke
    after_reset_status=

Credential path, proven in a transient unit that carries only substrate.env and HOME=/root (no
inherited shell `GH_TOKEN`; `/usr/bin/env` inside the same prefix printed 0 lines matching
`^(GH_TOKEN|GITHUB_TOKEN)=`), at 15:40:34Z. The dry run negotiated with GitHub through gh's stored
credential helper (`credential.https://github.com.helper = !/usr/bin/gh auth git-credential`) and
wrote nothing: `git ls-remote --heads origin substrate/<gid>` listed 0 refs afterwards.

push_env=systemd-run
push_dry_run_exit=0
gh_auth_unit_env=ok
gh_token_in_env_file=0

Kill at `t_kill=2026-09-25T15:40:45Z`: `{"kill":"accepted"}` → `released=True`; `graph_get` →
`claimed_by=None`. The worktree and the `substrate/<gid>` branch were then removed
(`Deleted branch substrate/ut-d09f05d6smk-62523d4b (was 7e88835)`); `git worktree list` shows main
(`b77f428`) plus Phase 2's `ut-mugbqivi-752f2dad` and `ut-mughkkc0-73909228`; the main checkout
stayed on `main`.

smoke_worktree_removed=true

## Task 2 — sync (D-10) on tracker_route host: read-only tracker checks, host function registered

03-01 recorded `tracker_route=host` and `b:prompt_hostfn`, so the sync route here is the model's
`agentos-substrate sync --node <nid> --pr-url <url>` host function (sync_by model) with the
turn-settle backstop (sync_by host); the in-VM ultrathink-sync branch (vm_mcp, sync_by model_mcp)
is pinned by tests only.

```
sudo systemctl restart substrate-host && curl -sf 127.0.0.1:7411/healthz     # 15:50:13Z → 15:50:14Z {"engine":true,"api":true}
journalctl -u substrate-host --since <ActiveEnterTimestamp> -o cat | grep -c -E 'ntn_|lin_api_|Bearer |Authorization'   # key material
sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env \
  -p WorkingDirectory=/root/src/repos/agent-substrate/packages/host -E HOME=/root \
  /usr/bin/node .sync-check-03-07.mjs ut-mucem4mc-ec70360f [verify]   # throwaway (deleted): NotionSync.findTaskRow (one
                                                                     # data-source query), LinearLink.attachMutation (one
                                                                     # __type introspection); with `verify`, HostSync.verifyModelSync
PYTHONPATH=packages/dispatcher/src python3 /tmp/03-07-open.py open SMK-8; … wait-event <gid> 90
sudo systemd-run … /usr/bin/node .probe-03-07.mjs sync <gid>   # in the VM: agentos-substrate sync --node n1 --pr-url …/pull/0,
                                                              # --node n9, and agentos list-host-functions substrate
curl -s -X POST 127.0.0.1:7411/tasks/<gid>/n1/kill; git worktree remove --force …; git branch -D substrate/<gid>
```

The first restart with the new module failed to boot (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`: a
constructor parameter property in `SyncError`, the very trap the plan's read_first names for
notion.ts); fixed to an assigned field, second restart clean at 15:50:13Z. The boot journal shows
`[substrate-host] sync: notion on, linear on (tracker route host)` and `tracker mcp proxy off`;
0 lines of the journal since that boot match a key prefix, `Bearer` or `Authorization`.

Read-only checks at 15:50:20Z, inside the transient unit (only closed-set keys printed; no
environment value leaves the unit), verbatim:

    notion_configured=true
    linear_configured=true
    notion_task_row_found=true
    notion_task_row_pr_url=null
    linear_attach_mutation=attachmentLinkURL

The Task row of the backfilled graph `ut-mucem4mc-ec70360f` (02-NOTION-SCHEMA.md) answered the
`Level = Task, Graph ID = <gid>` query with one result whose `PR URL` is null; Linear's Mutation
type lists `attachmentLinkURL`, so `LinearLink.attachLink` uses it (`attachmentCreate` is the
fallback). No PATCH and no mutation was sent.

tracker_route is host, so the plan's vm_mcp-only verification key is skipped; the same read-only
method was nevertheless run once with a PR URL the row cannot hold (`…/pull/0`, node without a
Linear reference) and answered false on both halves — indented so the column-0 key stays `skipped`:

    verify_model_sync=false_as_expected

Second throwaway task `ut-8a6b17d8smk-6e810294` (SMK-8): POST /tasks 202 at 15:50:37Z, first
`Read` approval pending at 15:50:55Z. In its VM, verbatim:

    vm_sync_no_pr=exit=0 stdout="{\"ok\":true,\"result\":{\"error\":\"no pull request recorded for this task yet (run pr-create first)\"}}" stderr=""
    vm_sync_bad_node=exit=0 stdout="{\"ok\":true,\"result\":{\"error\":\"no task for node n9 in this VM\"}}" stderr=""
    hostfns=issue-get,release,complete,git-push,pr-create,commit,sync
    git-push: --node
    pr-create: --node --title --body
    commit: --node --message
    sync: --node --pr-url

(`hostfns=` and the flag lines are parsed from `agentos list-host-functions substrate`'s JSON reply
in the VM.) The sync function refused before touching a tracker: no `pr_url` is recorded for the
task, so nothing was written to Notion or Linear. Kill at 15:51:12Z → `released=True`, `graph_get`
`claimed_by=None`; worktree and branch removed (`Deleted branch substrate/ut-8a6b17d8smk-6e810294
(was 40f0d7b)`); `git worktree list` shows main plus Phase 2's two graphs; the switch's last line
is still `=1`.

b_route=prompt_hostfn
tracker_route=host
notion_task_row_found=true
linear_attach_mutation=attachmentLinkURL
verify_model_sync=skipped
sync_hostfn_registered=true

## Retained

Graphs `ut-d09f05d6smk-62523d4b` and `ut-8a6b17d8smk-6e810294` stay in the substrate index (no
Linear or Notion reference, `claimed_by` null) and their VM actors stay in
`/var/lib/substrate/agentos` (kill unloads, never deletes); their task records under
`/var/lib/substrate/agentos/tasks/` are kept (`released=true`, `pr_url` null, `synced_at` null).
The smoke commit `7e88835` is unreachable once its branch was deleted. Nothing else was created:
no image, no network, no substrate.env change (the switch's last line is still `=1`), no push, no
PR, no Notion or Linear write.

## Gaps

- The real push and `pr-create` run first in the proof (03-10): this plan never pushed
  (`--dry-run` only, `ls-remote` shows no `substrate/<gid>` on origin) and never ran
  `gh pr create`; `pr-create` is pinned by hostfns.test.ts (argv, one-PR-per-task, URL recording,
  gh failure) and its live registration is shown by `agentos list-host-functions substrate` from
  inside the VM (`pr-create: --node --title --body`).
- Sync never wrote live: `syncPr` (Notion PATCH of the five fields, Linear `attachmentLinkURL`) and
  the turn-settle backstop are pinned by sync.test.ts only; live, the trackers were only read (one
  data-source query, one introspection, one `verifyModelSync`) and the sync host function refused
  for want of a recorded PR. 03-10 observes the first real write and records `sync_by`.
- The backstop sets `synced_at` after one run whatever the trackers answered (so a later settle
  never repeats it); a failed half is visible only in the journal (`sync result … notion …, linear …`),
  not in the record.
- `tracker_route=host` on this VPS means the vm_mcp branch (in-VM ultrathink-sync through 03-04's
  proxy, `sync_by=model_mcp` after the read-only verification) is unobservable here; the prompt
  sentence and the backstop's verify-then-sync order are pinned by seed.test.ts and sync.test.ts.
- `git-push` was not invoked through the VM (it would push); its guards ran host-side through the
  same module (`checkScratch` with the real runner: clear, then refused) and the fixed push argv is
  pinned by tests. The dry run used the identical argv with `--dry-run` inserted, under the unit's
  environment.
- The other two c-routes are not exercised on this host: `c:vm_git` would need
  `@agentos-software/git@0.3.3`, whose binaries 03-01 found unexecutable (mode 0644); `c:sandbox_git`
  would need a `git` shim the VM accepts as a command, and 03-01 showed a file placed under the VM is
  not a registered command (`command not found`). The prompt sentences for both routes exist and are
  pinned by seed.test.ts; no shim is seeded and no package was installed (`package.json` unchanged).
- The model was waiting on its first `Read` approval throughout (03-08 answers those); the commit
  was driven by the probe's `agentos-substrate commit` call in the VM, the same channel the prompt
  tells the model to use, not by the model itself.
