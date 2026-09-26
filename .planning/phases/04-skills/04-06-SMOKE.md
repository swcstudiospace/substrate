# 04-06 VM library mount evidence

Recorded from observed output only.

Route from 04-01-SPIKE.md: `mount_route=nested`, so main.ts defaults `SUBSTRATE_SKILL_MOUNTS` to
`nested` (the unit sets neither `SUBSTRATE_SKILL_MOUNTS` nor `SUBSTRATE_LIBRARY_DIR`; the env file
holds 0 of either). Precondition: `GET /tasks` listed 11 tasks, all `turn_in_flight=false`; free
disk 16938704896 bytes.

## Commands

```
sudo systemctl restart substrate-host; curl -s 127.0.0.1:7411/healthz      # {"engine":true,"api":true}
journalctl -u substrate-host --since "$(systemctl show -p ActiveEnterTimestamp --value substrate-host)" | grep library
python3 /tmp/04-06-open.py      # throwaway: graph_register over MCP (no Linear/Notion refs, node n1 unstarted),
                                # dispatcher ensure_worktree(repo_checkout('swcstudiospace/agent-substrate'), <gid>, 'main'),
                                # POST /tasks (identifier TRC-1, synthetic) → 202
journalctl -u substrate-host --since 09:08:49 | grep '<gid>'
sudo systemd-run --quiet --wait --pipe --collect -p WorkingDirectory=/root/src/repos/agent-substrate/packages/host \
  -E HOME=/root /usr/bin/node .probe-04-06.mjs <gid>   # throwaway rivet client on 127.0.0.1:6420, key=value output:
    # filesystem.readdir /home/agentos/.claude/skills vs the host's SKILL.md dirs in /root/agent-skills;
    # vm.exec "sha256sum /home/agentos/.claude/skills/substrate-skill-miner/SKILL.md" vs host sha256;
    # vm.exec "echo smoke > …/substrate-skill-miner/SMOKE.txt"; filesystem.writeFile of the same path
test ! -e /root/agent-skills/substrate-skill-miner/SMOKE.txt; git -C /root/agent-skills status --porcelain | wc -l
curl -s -X POST 127.0.0.1:7411/tasks/<gid>/n1/terminate; curl -s -X POST 127.0.0.1:7411/tasks/<gid>/n1/kill
git -C /root/src/repos/agent-substrate worktree remove --force /var/lib/substrate/worktrees/<gid>
git -C /root/src/repos/agent-substrate branch -D substrate/<gid>
rm -f packages/host/.probe-04-06.mjs /tmp/04-06-open.py
```

Startup line after the restart (09:08:51 UTC):

    [substrate-host] tests route sandbox; model grok-4.6; sandbox published_loopback; skills ultrathink-kickoff,ultrathink-plan,ultrathink-ship,ultrathink-sync; library /root/agent-skills mounts nested

Journal for the throwaway VM (resolveOptions read the library at VM creation):

    09:09:12 [substrate-host] vm skills ut-mui646lx-8f314a85 mounted 41 (nested)
    09:09:13 [substrate-host] vm resolved ut-mui646lx-8f314a85 worktree /var/lib/substrate/worktrees/ut-mui646lx-8f314a85 sandbox published_loopback
    09:09:21 [substrate-host] task opened ut-mui646lx-8f314a85/n1 (TRC-1)

Probe output (verbatim key=value lines):

    library_count=41
    vm_ultrathink_seeded=4
    vm_library_listed=41
    vm_skills_dir_entries=45
    vm_library_missing=none
    vm_read_exit=0
    vm_read_sha_match=true
    vm_api_readfiles=EROFS
    vm_guest_write_exit=1
    vm_guest_write_stderr=error: failed to redirect to /home/agentos/.claude/skills/substrate-skill-miner/SMOKE.txt: Read-only file system (os error 69)
    vm_mounted_write=refused
    vm_mounted_write_msg=An internal error occurred
    vm_after_write_ls=SKILL.md
    host_smoke_txt=false

`/home/agentos/.claude/skills` held 45 entries: the 4 seeded ultrathink skills and all 41 library
skills. The in-VM `sha256sum` printed
`0cab678a909c4409fbb6b3e4ae5ea52ddefddfef1ff72d598d18a55f8c837309`, the same as the host's
`sha256sum /root/agent-skills/substrate-skill-miner/SKILL.md`. The guest shell write was refused
with EROFS ("Read-only file system"); the actor-level `filesystem.writeFile` was refused too
(rivet answered `internal_error`); the directory still listed only `SKILL.md`. On the host, no
SMOKE.txt, and `git -C /root/agent-skills status --porcelain` printed 0 lines.

Cleanup: terminate → exit_code 1, kill → `state=unloaded`, `released=true`; graph_get showed
n1 `claimed_by` None; worktree removed and branch `substrate/ut-mui646lx-8f314a85` deleted
(`git worktree list` has no entry for it); the VM's sandbox container had already auto-removed
(`docker ps -a --filter label=substrate.graph_id=<gid>` empty). The throwaway graph stays in the
substrate index (no Linear or Notion reference, no claim), as in 03-04.

host_restarted_at=2026-09-26T09:08:49Z
startup_library_line=true
mount_route=nested
smoke_graph_id=ut-mui646lx-8f314a85
vm_ultrathink_seeded=4
vm_library_listed=41
library_count=41
vm_read_sha_match=true
vm_mounted_write=erofs
vm_copy_ms=n/a
host_library_clean=true
vm_skills_log_line=[substrate-host] vm skills ut-mui646lx-8f314a85 mounted 41 (nested)
throwaway_cleaned=true

## Gaps

- The VM's Claude runs `--bare` and does not auto-load skills (03-01 `b_skills=no`), so the
  library is available by path (`/home/agentos/.claude/skills/<name>/SKILL.md`), not listed by
  Claude as loaded skills.
- rivet 0.2.21's actor filesystem actions do not read a read-only host_dir mount: `filesystem.readFile`
  and `stat` on `…/substrate-skill-miner/SKILL.md` answered `internal_error` and `readFiles`
  reported `EROFS`, while `readdir` worked and guest processes (`vm.exec` sha256sum) read the
  bytes. Nothing on the host reads library files through the actor API (seed.ts reads back only
  what it writes, outside the mounts), and the model reads through guest processes, so this does
  not affect delivery; `vm_read_sha_match` is therefore measured from inside the guest.
- The library now has 41 skills (04-01's spike mounted 40); 41 nested mounts plus the worktree
  mount worked. No higher mount count was probed.
- The copy route (mount_route none) is covered by unit tests only; it was not exercised live
  because the spike selected nested.
