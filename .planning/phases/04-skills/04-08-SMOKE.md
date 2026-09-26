# 04-08 Omp extension evidence

Recorded from observed output only. Omp 18.3.1, 2026-09-26 (UTC), host `/root`, repo HEAD after
`1e163f4` (Task 1). Snapshot and undo route: `/var/lib/substrate/phase4-baseline/04-08/20260926T090611Z/`
(`config.yml`, `extensions.listing`, `MANIFEST.sha256`) and `RESTORE.d/04-08.md` (config route,
symlink removal), both written before the first live edit.

## Install and config

```
ln -s /root/src/repos/agent-substrate/packages/projector/omp/substrate-skills.ts /root/.omp/agent/extensions/substrate-skills.ts
readlink /root/.omp/agent/extensions/substrate-skills.ts   # → /root/src/repos/agent-substrate/packages/projector/omp/substrate-skills.ts
omp config set skills.customDirectories '["/root/agent-skills"]'   # "Set skills.customDirectories = ["/root/agent-skills"]", rc 0
omp config set autolearn.enabled true                               # "Set autolearn.enabled = true", rc 0
omp config get skills.customDirectories                             # ["/root/agent-skills"]
omp config get autolearn.enabled                                    # true
```

The JSON array parsed on the CLI (research A5 held); no hand edit of config.yml. A key-level diff of
the live config against the snapshot (python3 + yaml, values never printed) changed exactly
`autolearn.enabled` and `skills.customDirectories`.

omp-ultrathink: `/root/.omp/plugins/omp-plugins.lock.json` still has `"omp-ultrathink"` with
`enabled` false (read before and after; the file was not touched, D-17).

extension_symlink=true
omp_ultrathink_enabled=false
custom_directories=/root/agent-skills
autolearn_enabled=true

## Library through Omp's own loader

`bun /tmp/04-08-load.ts` (scratch, removed) imports `loadSkills` from the installed
`@oh-my-pi/pi-coding-agent/src/extensibility/skills.ts` and calls it with
`{ cwd: "/tmp", customDirectories: ["/root/agent-skills"] }`; it counts distinct loaded skills whose
realpath is under `/root/agent-skills/`. Library count:
`find -L /root/agent-skills -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l` (41; also 41 tracked
`*/SKILL.md`, 0 top-level links, library HEAD `34b32e2`).

Printed (one line per key, shown inline here so each evidence key below stays unique):
`total_loaded=237`, `omp_library_loaded=41`, `raw_path_under_library=41`, `warnings=0`.

library_count=41
omp_library_loaded=41

## Live interception (model session, print mode)

Accepted run (the third attempt; see Failed runs):

```
cd /tmp && timeout 300 omp -p --mode json "/ultrathink-skip" "Use the manage_skill tool now with action create, name omp-skill-propose, description '…', and a body of four numbered steps … Then report the tool result verbatim." > /tmp/04-08-omp.json
```

`/ultrathink-skip` is the live `ultrathink` extension's own one-shot opt-out (sets `skipOnce` in
`/root/.omp/agent/ultrathink/control.json`; read back `false` after the run, so it was consumed by
this prompt and cannot swallow a later one). No extension was disabled: ours loaded by discovery
from the symlink.

Observed `tool_execution_end` for `manage_skill` (`isError: true`, i.e. blocked by the tool_call handler):

```
Proposed to the shared skills library as https://github.com/swcstudiospace/agent-skills/pull/3 (opened); it appears in every agent after the owner merges. Nothing was written locally.
```

`gh pr view 3 -R swcstudiospace/agent-skills`: OPEN, base `main`, head
`skill/omp/omp-skill-propose-20260926T090935613Z-a026`, files `["omp-skill-propose/SKILL.md"]`.
Not merged (D-16: the owner merges). `ls /root/.omp/agent/managed-skills` → no such directory.
Session wall time 24 s.

omp_blocked_with_pr=true
omp_pr_url=https://github.com/swcstudiospace/agent-skills/pull/3
omp_managed_skill_written=false

## Queue path (isolated from the live bridge, checker I5)

```
cd /tmp && SUBSTRATE_URL=http://127.0.0.1:9 SUBSTRATE_OMP_PENDING_DIR=/tmp/04-08-queue timeout 300 omp -p --mode json "/ultrathink-skip" "Use the manage_skill tool now with action create, name omp-skill-queue-check, …"
```

Observed `tool_execution_end` for `manage_skill` (`isError: true`):

```
The substrate was unreachable; the proposal is queued at /tmp/04-08-queue/omp-skill-queue-check-20260926T091027Z.json and will be opened as a PR automatically. Nothing was written locally.
```

- `/tmp/04-08-queue` mode 700; the file mode 600, 861 bytes, keys `files, name, rationale, surface`
  (surface `omp`, name `omp-skill-queue-check`); `grep -c <key>` over it → 0 (key never printed).
- `/root/.omp/agent/substrate-pending` did not exist before or after (nothing reached the live queue);
  no managed-skills directory.
- `rm -rf /tmp/04-08-queue`, then `test ! -e /tmp/04-08-queue` → removed (a mechanics check; nothing
  for the bridge to propose). `/tmp/04-08-omp*.json` deleted.

omp_queue_file_written=true
omp_queue_file_mode=600
omp_queue_check_removed=true

## Failed runs

1. The plan's prompt as written (`omp -p --mode json "Use the manage_skill tool now …"`): the model
   did not call the tool. The live `ultrathink` extension (not omp-ultrathink) injected its
   `ultrathink-pending` message ("Ultrathink is still planning this prompt …"), which holds the
   agent read-only until a plan arrives; in print mode none arrived. The model called `wait`
   ("No running background jobs to wait for.") and ended without a mutation. No managed skill, no
   request to the substrate.
2. `omp -p --mode json "/ultrathink-quick <prompt>"`: the command handler re-sends the message via
   `sendUserMessage`, but print mode exited after the command (output: `session` and
   `advisor_cost_changed` events only, 159 bytes); no model turn ran.
3. Accepted: `"/ultrathink-skip"` as the first message and the prompt as the second (above).

## Gaps

- `learn` is covered by the unit tests only (strip the skill, keep the lesson, additionalContext
  names the PR): the `learn` tool needs a memory backend, and `omp config get memory.backend` on
  this host is `off`.
- PR agent-skills#3 stays OPEN for the owner (D-16); it is real proposal content, not a fixture.
