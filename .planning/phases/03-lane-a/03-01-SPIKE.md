# 03-01 D-09 spike evidence

Recorded from observed output only.

## D-03 / D-04 before the install

```
df --output=avail -B1 / | tail -n 1
docker image inspect asterinas/dev:0.18.1-20260901 --format '{{.Id}}'
docker ps -a --filter name=^bold_rosalind$ --format '{{.Names}}'
```

disk_before=31843188736
d04_before_asterinas_id=sha256:5211b0c1afdf8c51dd42528009da562d2308959b1979f5764ea431db4a64d0f6
d04_before_bold_rosalind=bold_rosalind

The same gate read 31842811904 bytes in the shell that ran the npm install, immediately before it.

## Install (packages/host, npm 11.16.0, node v24.18.0)

```
npm install --no-audit --no-fund --workspaces=false @rivet-dev/agentos@0.2.21 @rivet-dev/agentos-sandbox@0.2.21 sandbox-agent@0.4.2
npm install --no-audit --no-fund --workspaces=false --save-exact @rivet-dev/agentos@0.2.21 @rivet-dev/agentos-sandbox@0.2.21 sandbox-agent@0.4.2 zod@4.6.5
npm install --no-audit --no-fund --workspaces=false --save-exact dockerode@4.0.12
npm ls --workspaces=false @agentos-software/claude-code rivetkit
```

Observed: `added 572 packages in 3m`; packages/host/package-lock.json exists, no root
package-lock.json; `@rivet-dev/agentos@0.2.21`, `@rivet-dev/agentos-sandbox@0.2.21`,
`sandbox-agent@0.4.2`, `@agentos-software/claude-code@0.2.7` (under agentos-core@0.2.21),
`rivetkit@2.3.10`, `zod@4.6.5`, `dockerode@4.0.12`. `du -sh packages/host/node_modules` = 1.5G.
`@agentos-software/runtime-core` types host-function inputs with Zod
(`HostFunction.inputSchema: ZodType`, host-functions.d.ts), so zod is declared.

zod_declared=yes
disk_after_install=29634609152

## Image (D-02)

```
docker buildx build --load --build-context ultrathink=/root/.claude/plugins/cache/ultrathink/ultrathink/0.3.0 -t substrate-sandbox:0.1 /root/src/repos/agent-substrate/infra/sandbox
```

Observed: build exit 0; only `docker.io/library/node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`
was pulled; image `sha256:2063de595afdfe7a1378b64827ac1df7f3ed1400b2685e7e29093273fb305843`,
181055374 bytes, ENTRYPOINT `["sandbox-agent"]`, WORKDIR /work. A `--rm --network none`
content check printed node v24.21.0, bun 1.4.0, git 2.39.5, gh 2.101.0, sandbox-agent 0.4.2 and
the plugin tree under /opt/claude-ultrathink without its local .claude/.planning/.hermes/issues/sessions.

disk_before_image=29633863680
disk_after_image=28647456768

## Spike server (transient unit)

```
sudo mkdir -m 0700 /var/lib/substrate/agentos-spike
sudo systemd-run --unit=substrate-spike --collect -p WorkingDirectory=/root/src/repos/agent-substrate/packages/host -E HOME=/root -E RIVET_RUN_ENGINE=1 -E RIVET_RUN_ENGINE_HOST=127.0.0.1 -E RIVETKIT_STORAGE_PATH=/var/lib/substrate/agentos-spike /usr/bin/node spike/spike.ts serve
ss -ltnupH   (filtered to the pids in the unit's cgroup)
```

Journal: `RivetKit 2.3.10 (Engine - Serverful)`, `Endpoint: http://127.0.0.1:6420 (local native)`.
Every listener of the unit (node MainThread, rivet-engine, two agentos-sidecar processes):
`tcp 127.0.0.1:6420`, `tcp 127.0.0.1:6421`, `tcp 127.0.0.1:6430` — the engine uses 6430, not 6422,
for its third port; nothing is bound to another address.

engine_bind=127.0.0.1

## (a) VM → host loopback → shunt

VM keys: `spike-a-20260925112700` (`loopbackExemptPorts: [7410, 3001]`) and
`spike-ctl-20260925112700` (same rules, no exemption). Network policy on both: default deny;
allow `listen` on `tcp://**`, `unix:**`; allow `*` on `tcp://127.0.0.1:7410`,
`tcp://127.0.0.1:3001` and `dns://`+`tcp://…:443` for mcp.notion.com, mcp.linear.app,
api.greptile.com, github.com, api.github.com. Probe: `handle.process.execFile("node", ["-e", <fetch with a 20 s abort>])`.

```
probe_a_healthz=S 200
probe_a_models=S 200
probe_ctl_healthz=E fetch failed EACCES
probe_ctl_models=E fetch failed EACCES
probe_a_example_com=E fetch failed EACCES
```

a_loopback=yes
a_control=denied
a_egress_denied=yes

Model: `/root/.config/shunt/shunt.toml` `[[routes]]` names (the `model` key; nothing else read):
grok-4.7, grok-4.7-xhigh, grok-4.6, grok-4.5, grok-build-0.1. grok-4.6 is the route the host's own
Claude Code uses (`/root/.claude/settings.json` `ANTHROPIC_CUSTOM_MODEL_OPTION` and
`ANTHROPIC_SMALL_FAST_MODEL`), so it is the Claude-Code-capable pick.
`sessions.open({ sessionId: "spike-model", agent: "claude", cwd: "/home/agentos", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3001", ANTHROPIC_API_KEY: "shunt", ANTHROPIC_MODEL: "grok-4.6" }, permissionPolicy: "allow_all" })`, prompt "Reply with the word PONG":

```
probe_model_stop_reason=end_turn
probe_model_text="PONG"
probe_model_ms=5446
```

a_model_name=grok-4.6
a_model=yes
a2_substrate_hostfn=skipped
a2_model_relay=skipped

## Host functions and the VM file API

`agentos-substrate healthz` on spike-a (collection `substrate`, function `healthz` fetching
http://127.0.0.1:7410/healthz on the host):

- First run, both VMs on the default shared sidecar pool, spike-ctl booted after spike-a:
  `1 Unknown host function "substrate:healthz"`, and `agentos-substrate --help` →
  `unknown host function callback substrate:--help`. Cause (read in
  @rivet-dev/agentos-core@0.2.21 dist/agent-os.js `_installSidecarRequestHandler` and
  agentos-runtime-core protocol-client.js `setSidecarRequestHandler`): one sidecar process serves
  a pool and holds a single host-callback handler, which each booting VM overwrites, so host
  functions (and js-bridge / ACP ext callbacks) route to the last-booted VM.
- After `sidecar: { kind: "shared", pool: "vm-<key>" }` per VM and a unit restart, spike-a first,
  then spike-ctl booted, then spike-a again: `0 {"ok":true,"result":{"status":200}}` both times.

sidecar_pool=per_vm
hostfn_cli=/bin/agentos-substrate
fs_write_api=filesystem.writeFile

`process.exec` / `execFile` return only `{exitCode, outcome}` unless called with
`{ output: { capture: "all" } }`; every probe above uses that option.

## (b) Adapter loading under @agentos-software/claude-code 0.2.7 (D-10, D-11)

On spike-a, written with `filesystem.writeFile` before `sessions.open`:
/home/agentos/.claude/settings.json (hooks.UserPromptSubmit → `touch /home/agentos/hook-user-settings`),
/home/agentos/scratch/.claude/settings.json (same hook → `touch /home/agentos/hook-project-settings`),
/home/agentos/.claude/skills/spike-marker/SKILL.md (name spike-marker, body MARKER-7f3a),
/home/agentos/.claude.json (`mcpServers.substrate = { type: "http", url: "http://127.0.0.1:7410/mcp" }`).
Session `spike-b`: cwd /home/agentos/scratch, session `mcpServers: [{ type: "http", name: "substrate", url: "http://127.0.0.1:7410/mcp", headers: [] }]`,
model grok-4.6, `permissionPolicy: "allow_all"`.

```
probe_b_reply1={"tools":["mcp__mcp-1__events_emit",…,"mcp__mcp-1__memory_write"],"skills":[]}
probe_b_reply2="I'll read that skill file and extract the marker word.MARKER-7f3a"
probe_b_hook_user=false
probe_b_hook_project=false
probe_b_available_commands=[]
probe_b_event_types=["user_message_chunk","agent_message_chunk","tool_call","tool_call_update"]
probe_b_tool_calls=["Read","Read"]
```

No hook marker exists, no skill is listed and readHistory holds no `available_commands_update`;
the model reads SKILL.md by path; only the session server appears, renamed `mcp-1`; no
`mcp__substrate__*` tool exists although /home/agentos/.claude.json names `substrate`.

b_hooks=none
b_skills=no
b_skill_by_path=yes
b_claude_json_mcp=no
b_session_mcp_names=mcp-N
b_reply={"tools":["mcp__mcp-1__events_emit","mcp__mcp-1__graph_claim","mcp__mcp-1__graph_complete","mcp__mcp-1__graph_find","mcp__mcp-1__graph_get","mcp__mcp-1__graph_register","mcp__mcp-1__graph_release","mcp__mcp-1__memory_brief","mcp__mcp-1__memory_search","mcp__mcp-1__memory_write"],"skills":[]}

## Sandbox (substrateDocker) and (c) git on the D-12 layout

Scratch layout (never the live checkout):

```
git clone --local /root/src/repos/agent-substrate /tmp/spike-repo
git -C /tmp/spike-repo worktree add /var/lib/substrate/worktrees/spike-c-20260925112700 -b substrate/spike-c-20260925112700
cat /var/lib/substrate/worktrees/spike-c-20260925112700/.git   → gitdir: /tmp/spike-repo/.git/worktrees/spike-c-20260925112700
git clone --local /tmp/spike-repo /var/lib/substrate/worktrees/spike-c-20260925112700-clone   (plain clone, its own graph id, so the provider's worktree rule still holds)
npm install --no-save --no-audit --no-fund --workspaces=false @agentos-software/git@0.3.3   (D-03 gate read 28451700736 first; package.json and package-lock.json sha256 unchanged)
```

VM `spike-c-20260925112700`: software [claude, git], host_dir mounts worktree → /home/agentos/work and
/tmp/spike-repo → /home/agentos/clone, sandbox `sandboxAgentProvider(substrateDocker({ graphId, worktree, network, readOnlyBinds: ["/root/src/repos/agent-substrate/node_modules:/work/node_modules"] }))` at /mnt/sandbox.

Network "internal": the VM failed to boot. Sidecar error, verbatim:
`plugin_error: EINVAL: sandbox_agent mount baseUrl must use https unless it targets localhost`
(getUrl returned `http://<container IP on substrate-sandbox>:3000`). The docker network
`substrate-sandbox` (Internal=true, 172.16.9.0/24) was created and is kept. Switched to
"published_loopback".

Two 0.2.21 defects found on the way, both worked around in the harness only:
- `AgentOs.create` resolves `hostFunctions` before it expands `sandbox`, so the `sandbox` collection is
  dropped (`agentos-sandbox: command not found`). Workaround: `resolveSandboxOptions(...)` inside
  `resolveOptions`, after which /bin lists `agentos agentos-sandbox agentos-substrate`.
- The expanded options carry their sandbox dispose hooks on a non-enumerable symbol, which the actor
  layer's object spread drops: after `systemctl stop` 3 labelled containers survived. Workaround:
  `getSandboxDisposeHooks(expanded)` kept per actor id and run from `onVmDisposed`; re-checked: one
  container running, `systemctl stop` → journal `spike sandbox disposed … reason=sleep`, 0 containers.
- `substrateDocker.destroy` treated a 409 "removal already in progress" (AutoRemove racing the explicit
  remove) as an error; fixed in packages/host/src/sandbox-provider.ts to accept 404 and 409.

Container as created by substrateDocker (`docker inspect`, token redacted):
`ports={"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":""}]} privileged=false autoremove=true binds=["/var/lib/substrate/worktrees/spike-c-20260925112700:/work","/root/src/repos/agent-substrate/node_modules:/work/node_modules:ro"] label=spike-c-20260925112700 network=bridge image=substrate-sandbox:0.1`,
`cmd=['server','--token','<redacted len=43>','--host','0.0.0.0','--port','3000','--no-telemetry']`,
`docker port` → `3000/tcp -> 127.0.0.1:32770`. Unauthenticated `GET http://127.0.0.1:32770/v1/health` → 401;
the same port on 187.77.130.10 and 100.90.229.45 → curl exit 7 (refused). No docker.sock bind.

```
probe_c_sandbox_bun=exit=0 {"ok":true,"result":{"stdout":"1.4.0\n","stderr":"","exitCode":0,…}}
probe_c_sandbox_egress=exit=0 {"ok":true,"result":{"stdout":"","stderr":"","exitCode":0,"timedOut":false,"durationMs":318}}   (curl -sS -m 10 -o /dev/null https://example.com)
probe_c_sandbox_git_worktree=… "stderr":"fatal: not a git repository: /tmp/spike-repo/.git/worktrees/spike-c-20260925112700\n","exitCode":128 …
probe_c_sandbox_git_clone=… "stdout":"On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean\n" … "exitCode":0 …
probe_c_vm_git_status=exit=126 error: failed to execute command 'git': Permission denied (os error 2)
probe_c_vm_git_commit=exit=126 error: failed to execute command 'git': Permission denied (os error 2)
probe_c_vm_git_clone_status=exit=126 error: failed to execute command 'git': Permission denied (os error 2)
probe_c_vm_git_clone_commit=exit=126 error: failed to execute command 'git': Permission denied (os error 2)
```

VM git cause: /opt/agentos/pkgs/git/current → 0.3.0-rc.2, and `bin/git`, `bin/git-remote-http(s)` ship
mode 0644; a 0755 copy under /home/agentos is not a registered command (`command not found`).
Host check after the commit attempt: `git -C /var/lib/substrate/worktrees/spike-c-20260925112700 log -1 --format=%s`
→ `docs(03): create phase plan` (no `spike` commit).

Sandbox tests (`agentos-sandbox run-command --command bun --args test --args packages/mcp-server/src/redact.test.ts --cwd /work`,
node_modules bound read-only): result exitCode 0, ` 12 pass`, ` 0 fail`, `Ran 12 tests across 1 file.`

Host-function push: `git init --bare /tmp/spike-remote.git`, `git -C /tmp/spike-repo remote add spike-remote /tmp/spike-remote.git`,
host function `substrate.gitPush` runs `git -C <worktree from the actor key> push spike-remote substrate/<key>` (no guest input):

```
probe_c_push=exit=0 {"ok":true,"result":{"pushed":"substrate/spike-c-20260925112700","out":""}}
probe_c_hostfn_paths=/bin/agentos-substrate /bin/agentos-sandbox
git -C /tmp/spike-remote.git rev-parse substrate/spike-c-20260925112700 → 2df112c2dbbbd6a4025558867bf86b473a582680 (rc 0)
```

b_sandbox_bun=yes
sandbox_net=published_loopback
sandbox_egress=open
hostfn_sandbox_collection=sandbox
c_vm_git=no
c_sandbox_git=clone_only
sandbox_tests=yes
tests_oneshot=skipped
c_push_hostfn=yes

## Durability (D-07)

```
before: {"nonce":"779ced5bdf80a12fe2003d27","sessionId":"spike-model","latestSequence":2,"historyEvents":2}
sudo systemctl stop substrate-spike; <identical systemd-run command>
after:  {"content":"779ced5bdf80a12fe2003d27","sessionId":"spike-model","latestSequence":2,"historyEvents":2,"stopReason":"end_turn","answer":"PONG"}
```

Prompt after the restart: "What word did you reply with before?" → `PONG`.

durability=yes
durability_detail=file:same,session:same,seq:2->2,answer:yes

Before the stop (spike-a, spike-ctl, two spike-c VMs, spike-c-…-clone; 3 containers):
`ps -o rss` node serve MainPID 2284460 = 150736 KiB; rivet-engine 135852 KiB; agentos-sidecar
492692 / 281764 / 39644 KiB; cgroup memory.current 924278784 bytes.
`du -sh /var/lib/substrate/agentos-spike` → `61M	/var/lib/substrate/agentos-spike`.

rss_mb=147

## Route

A = loopback (a_loopback=yes, a_model=yes). B = prompt_hostfn (b_hooks=none; b_skill_by_path=yes).
C = hostfn_commit (c_vm_git=no; c_sandbox_git=clone_only counts as no). S = hostfn (b_claude_json_mcp=no).

route_choice=a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn
d11=unmet
tracker_route=host
tests_route=sandbox

## Cleanup

```
sudo systemctl stop substrate-spike                       → inactive, no substrate-spike unit listed
git -C /root/src/repos/agent-substrate worktree list      → main + ut-mugbqivi-752f2dad + ut-mughkkc0-73909228 (no spike-c)
sudo rm -rf /var/lib/substrate/agentos-spike /tmp/spike-repo /tmp/spike-remote.git
sudo rm -rf /var/lib/substrate/worktrees/spike-c-20260925112700 /var/lib/substrate/worktrees/spike-c-20260925112700-clone
docker ps -aq --filter label=substrate.graph_id / label=substrate.test_run   → none left to remove
npm prune --no-audit --no-fund --workspaces=false         → exit 0, but @agentos-software/git@0.3.3 stayed ("extraneous")
npm uninstall --no-save --no-audit --no-fund --workspaces=false @agentos-software/git → exit 0, still "extraneous"
rm -rf packages/host/node_modules/@agentos-software/git   → npm ls @agentos-software/git: (empty); package.json / package-lock.json sha256 unchanged
rm -rf packages/host/spike
/tmp: 23 agentos-native-sidecar-*, agentos-node-import-cache-roots-*, agentos-uds-*, rivet-actor-runtime.* entries (139M), all newer than this plan's start, removed
```

Kept: image substrate-sandbox:0.1 (sha256:2063de59…), docker network substrate-sandbox (Internal=true),
packages/host/node_modules. After cleanup: `asterinas/dev:0.18.1-20260901` →
sha256:5211b0c1afdf8c51dd42528009da562d2308959b1979f5764ea431db4a64d0f6, `bold_rosalind` listed; no
docker prune, rm or rmi ran against anything without this plan's label; the last
SUBSTRATE_DISPATCH_DISABLED line is =1.

d04_intact=yes
disk_after_cleanup=28535652352
orphans_after_cleanup=0

## Gaps

- D-12 deviation: sandbox container egress is open. `sandbox_net=internal` cannot be used with
  @rivet-dev/agentos 0.2.21 (the sidecar rejects a non-https sandbox baseUrl that is not localhost),
  so the container sits on Docker's default bridge with its command port published on 127.0.0.1 only,
  and `curl https://example.com` from inside it exits 0. D-12 covers the VM, whose egress is denied
  (a_egress_denied=yes). Every command reaches the container only as a VM tool call through
  `agentos-sandbox`, which waits on an owner tap under D-13 (`permissionPolicy: "ask"`); the container
  holds no credential (no env, no docker socket, only the worktree and a read-only node_modules bind,
  token-protected command port: unauthenticated /v1/health → 401). 03-06 re-checks it live
  (container_example_com). [INFERENCE, untested] A user-defined bridge with IP masquerade disabled
  would keep the 127.0.0.1 publish and drop outbound egress.
- Upstream 0.2.21 defects 03-03 must carry (worked around only in the spike harness): one host-callback
  handler per sidecar process (use one sidecar pool per VM, `sidecar_pool=per_vm`); the `sandbox`
  host-function collection is dropped unless `resolveSandboxOptions` runs in `resolveOptions`; the
  sandbox dispose hooks are then lost to the actor layer's spread and must run from `onVmDisposed`.
  `process.exec` needs `{ output: { capture: "all" } }` to return stdout/stderr.
- VM git: @agentos-software/git 0.3.3 ships its git binaries mode 0644 (npm description "(planned)"),
  so the VM cannot run git at all; clone vs worktree could not be separated inside the VM.
- Sandbox git on the D-12 worktree fails because the worktree's `.git` file names
  /tmp/spike-repo/.git/worktrees/… outside the bind. [INFERENCE, untested] Binding the main
  checkout's `.git` at the same absolute path would likely make it work; the derivation counts
  clone_only as no, so c:hostfn_commit stands.
- The b probe's tool and skill lists come from the model's own reply (grok-4.6 via shunt); the adapter
  exposed no tool list in readHistory. Hooks, skills and `.claude.json` MCP servers all did not load,
  consistent with the adapter's `--bare` / `settingSources: ["project"]` flags (adapter.js L302-329).
- The spike processes wrote their runtime scratch into the shared /tmp (no PrivateTmp); the production
  unit should set PrivateTmp or a TMPDIR under /var/lib/substrate.
- The durability check restarted the unit with a clean stop; a hard kill mid-turn (Pitfall 5) was not
  exercised. `latestSequence` is the value read before the post-restart prompt (2 → 2).
- `agentos list-host-functions` printed nothing in the VM; the collection name comes from /bin
  (`agentos-sandbox`) and resolveSandboxOptions (`hostFunctions.sandbox`).
