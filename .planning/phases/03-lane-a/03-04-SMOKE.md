# 03-04 VM policy and tracker route evidence

Recorded from observed output only.

Route values below are copied from 03-01-SPIKE.md (`route_choice`, `tracker_route`, `tests_route`);
everything else is the stdout of the throwaway scripts named in each section, run against the
`substrate-host` unit after `sudo systemctl restart substrate-host` (healthz `{"engine":true,"api":true}`).

route=a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn
tracker_route=host
tests_route=sandbox

## Task 1 — seed read-back and VM-side issue_get

```
sudo systemctl restart substrate-host && curl -s 127.0.0.1:7411/healthz     # {"engine":true,"api":true}
python3 /tmp/03-04-open.py          # throwaway: graph_register over MCP (no Linear/Notion refs, node n1 unstarted),
                                    # dispatcher ensure_worktree(repo_checkout(...), <gid>, 'main'), POST /tasks
sudo systemd-run --quiet --wait --pipe --collect -p WorkingDirectory=/root/src/repos/agent-substrate/packages/host \
  -E HOME=/root /usr/bin/node .probe-03-04.mjs <gid>   # throwaway rivet client on 127.0.0.1:6420: readFile the seed,
                                                       # execFile agentos-substrate issue-get --node n1, node -e fetch :7412
curl -s -X POST 127.0.0.1:7411/tasks/<gid>/n1/terminate; curl -s -X POST 127.0.0.1:7411/tasks/<gid>/n1/kill
```

Open (POST /tasks 202 at 14:37:11Z, claim session n1); the host reported nine seeded files, each
written with `filesystem.writeFile`, read back and hashed:

```
/home/agentos/SUBSTRATE_BRIEF.md
/home/agentos/.claude/skills/ultrathink-kickoff/SKILL.md
/home/agentos/.claude/skills/ultrathink-plan/SKILL.md
/home/agentos/.claude/skills/ultrathink-ship/SKILL.md
/home/agentos/.claude/skills/ultrathink-sync/SKILL.md
/home/agentos/.claude.json
/home/agentos/.config/ultrathink/config.json
/home/agentos/.substrate/ultrathink-state.json
/home/agentos/.substrate/ultrathink-state.xml
```

smoke_graph_id=ut-muh2ea68-eb8dcf1c
open_status=202
seeded_mcp_servers=linear,notion,substrate
seeded_tracker_urls=loopback
seeded_mcp_headers=none
seeded_substrate_url=http://127.0.0.1:7410/mcp
seeded_state_file=yes
seeded_state_tracking=complete
vm_issue_get=found_false_no_ref
vm_issue_get_channel=hostfn

The probe's `.claude.json` read-back (keys sorted, values as seeded): `linear` →
`http://127.0.0.1:7412/mcp/linear`, `notion` → `http://127.0.0.1:7412/mcp/notion`, `substrate` →
`http://127.0.0.1:7410/mcp`, all `type: http`, no `headers`, no `env`. The state file's
`plan.graphId` equalled the gid and `tracking.status` was `complete`.
`agentos-substrate issue-get --node n1` from inside the VM answered
`{"found":false,"reason":"node has no Linear issue reference"}` (the s:hostfn channel end to end).
The session had reached its first model event before terminate (`state=waiting`, one pending
approval); terminate → exit_code 1, kill → `state=unloaded`, `released=true`, `claimed_by` null.

task1_first_event=approval_pending
task1_exit_after_terminate=1
task1_released_after_kill=true
