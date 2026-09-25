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
