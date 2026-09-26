# 04-01 rivet mount spike evidence

Recorded from observed output only.

Throwaway `packages/host/spike/p4-mounts.ts` (Node 24.18.0 type stripping, never committed, deleted):
one VM from `AgentOs.create({ mounts })` of `@rivet-dev/agentos-core` (0.2.21 tree in
packages/host; no engine, no actor, default permissions, its own default sidecar beside
substrate-host). Mounts: for each of the 40 names from
`find -L /root/agent-skills -mindepth 2 -maxdepth 2 -name SKILL.md`,
`{ path: "/home/agentos/.claude/skills/<name>", plugin: { id: "host_dir", config: { hostPath: realpath(/root/agent-skills/<name>), readOnly: true } } }`,
plus the sibling `{ path: "/home/agentos/agent-skills", plugin: { id: "host_dir", config: { hostPath: "/root/.openclaw/workspace/projects/docs-scraper/data/exports/skills", readOnly: true } } }`.
Probes in order: time the create; `mkdir -p` + `writeFile` of
`/home/agentos/.claude/skills/ultrathink-sync/SKILL.md` and read it back (the seed.ts write path);
`readdir /home/agentos/.claude/skills`; sha256 of the guest read of `dev-flow/SKILL.md` against the
host file; `writeFile dev-flow/SPIKE.txt`; `readdir /home/agentos/agent-skills`;
`writeFile /home/agentos/agent-skills/SPIKE.txt`; `listMounts`; `dispose`.

```
systemctl is-active substrate-host; systemctl show substrate-host -p ActiveEnterTimestamp -p NRestarts
cd /root/src/repos/agent-substrate/packages/host && HOME=/root timeout 600 /usr/bin/node spike/p4-mounts.ts > /tmp/04-01-spike.out 2>&1
rm -rf packages/host/spike /tmp/04-01-spike.out
git -C /root/src/repos/agent-substrate status --porcelain -- packages/host
systemctl is-active substrate-host; systemctl show substrate-host -p ActiveEnterTimestamp -p NRestarts
```

Run exit 0 on the first attempt, so no 20-mount re-run and no `spike_nested_limit`. The sidecar
logged `phase=configure_vm elapsed_ms=507 applied_mounts=186`. Neither write created a host file
(`ls` of the dev-flow and exports dirs showed no SPIKE file). substrate-host stayed active with
`ActiveEnterTimestamp=Fri 2026-09-25 17:51:35 UTC` and `NRestarts=0` before and after; no sidecar
process was left behind.

spike_vm_created=true
spike_create_ms=1286
spike_nested_mounts=40
spike_nested_readdir=41
spike_seed_write_under_mounts=ok
spike_mounted_read_sha_match=true
spike_mounted_write=erofs
spike_sibling_readdir=27
spike_sibling_write=erofs
spike_mounts_listed=187
mount_route=nested
spike_dir_removed=true
host_active_after=active

Derivation: nested requires `spike_nested_readdir=41`, `spike_seed_write_under_mounts=ok`,
`spike_mounted_read_sha_match=true` and `spike_mounted_write=erofs`; all four held.

Supporting lines from the same run: `spike_library_names=40`, `spike_nested_readdir_has_seed=true`,
`spike_nested_readdir_missing=0` (every mounted name listed beside the seeded `ultrathink-sync`),
`spike_mounts_listed_ours=41`, `spike_mounts_listed_kinds=host_dir`, `spike_dispose_ms=240`.
`spike_mounts_listed=187` counts every mount `listMounts` returned for the VM, of which 41 are the
ones added here.

## Supplementary run (top-level readOnly)

The first run's `listMounts` reported `spike_mounts_listed_ours_readonly=0`: with `readOnly` only
inside `plugin.config` (the plan's shape: vm.ts L372's form plus `config.readOnly`), the host_dir plugin still
refused both writes with EROFS, but `MountInfo.readOnly` stayed false. A second run of the same
script with a top-level `readOnly: true` added to the 40 nested mounts (the shape `hostDirMount()`
in host-dir-mount.js builds) recorded:

    spike_create_ms=1402
    spike_nested_readdir=41
    spike_seed_write_under_mounts=ok
    spike_mounted_read_sha_match=true
    spike_mounted_write=erofs
    spike_sibling_write=erofs
    spike_mounts_listed_ours_readonly=40

## Gaps

- The VM's Claude runs `--bare` and does not auto-load skills (03-01 `b_skills=no`), so "the VM sees
  the library" here means each skill is readable at `/home/agentos/.claude/skills/<name>/`, not that
  Claude lists it. 04-06 inherits that meaning.
- The spike used a standalone `AgentOs.create`, not the actor path (`agentOS({ resolveOptions })` +
  `resolveSandboxOptions` in vm.ts) and not `sessions.open`; 04-06's live smoke is the first check of
  the mounts through substrate-host's own VM path.
- `listMounts().readOnly` reflects only the top-level `readOnly` field; enforcement comes from
  `plugin.config.readOnly`. 04-06 should set both (as `hostDirMount()` does) so the listing and the
  enforcement agree.
- 40 nested mounts under a directory that is also written into worked at this count only; no
  mount-count limit was reached or probed beyond 41 host_dir mounts.
