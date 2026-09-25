---
phase: 03-lane-a
plan: 01
subsystem: infra
tags: [rivet, agentos, sandbox-agent, docker, spike, d-09]

requires:
  - phase: 02-claims-and-dispatch
    provides: substrate-mcp on 127.0.0.1:7410, dispatcher worktree layout (worktree.py), 02-BASELINE.md format
provides:
  - 03-BASELINE.md (agent-substrate 167/0, tsc clean, dispatcher 114/0 at 2df112c)
  - packages/host deps pinned exactly (@rivet-dev/agentos 0.2.21, agentos-sandbox 0.2.21, sandbox-agent 0.4.2, zod 4.6.5, dockerode 4.0.12) with its own package-lock.json
  - sandbox-options.ts (pure container spec) + tests, sandbox-provider.ts (substrateDocker)
  - infra/sandbox/Dockerfile and local image substrate-sandbox:0.1; docker network substrate-sandbox (internal)
  - 03-01-SPIKE.md with route_choice=a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn, d11=unmet, tracker_route=host, tests_route=sandbox
affects: [03-02, 03-03, 03-04, 03-05, 03-06, 03-07, 03-08, 03-09, 03-10]

actuals:
  tokens: 86474      # chars/4 over all 8 changed files; 9559 without the generated package-lock.json
  tasks: 3
  commits: 2
plan_head_before: 2df112c2dbbbd6a4025558867bf86b473a582680

tech-stack:
  added: ["@rivet-dev/agentos 0.2.21", "@rivet-dev/agentos-sandbox 0.2.21", "sandbox-agent 0.4.2", "zod 4.6.5", "dockerode 4.0.12", "substrate-sandbox:0.1 image (node 24, bun 1.4.0, git, gh, sandbox-agent 0.4.2, claude-ultrathink 0.3.0)"]
  patterns:
    - "Pure option builder (no imports) owns the whole docker createContainer body; the provider only calls it"
    - "Sandbox token handed to sandboxAgentProvider through provider.getToken(), read back from the container's Cmd"
    - "npm --workspaces=false inside packages/host so the lock and node_modules stay local to the package"

key-files:
  created:
    - .planning/phases/03-lane-a/03-BASELINE.md
    - .planning/phases/03-lane-a/03-01-SPIKE.md
    - packages/host/package-lock.json
    - packages/host/src/sandbox-options.ts
    - packages/host/src/sandbox-options.test.ts
    - packages/host/src/sandbox-provider.ts
    - infra/sandbox/Dockerfile
  modified:
    - packages/host/package.json
    - .planning/WINDOWS.md

key-decisions:
  - "Route chosen by evidence: a:loopback (VM reaches host 127.0.0.1:7410/:3001 via loopbackExemptPorts; PONG via shunt grok-4.6)"
  - "b:prompt_hostfn and tracker_route=host: hooks, skills and .claude.json MCP servers do not load under claude-code 0.2.7; SKILL.md read by path works"
  - "c:hostfn_commit: VM git unusable (0.3.3 ships 0644 binaries); sandbox git only on a plain clone, not the D-12 worktree"
  - "s:hostfn, d11=unmet: session MCP servers are renamed mcp-N and .claude.json is ignored"
  - "sandbox_net=published_loopback: the 0.2.21 sidecar rejects a non-https, non-localhost sandbox baseUrl, so the internal network cannot be used; open container egress recorded as the D-12 deviation"
  - "03-03 must run one sidecar pool per VM, pre-expand sandbox options in resolveOptions, and dispose the sandbox from onVmDisposed (three 0.2.21 defects)"

patterns-established:
  - "Evidence files: closed-set key=value at column 0, verbatim probe output in fenced blocks, one ## Gaps"

requirements-completed: []

coverage:
  - id: D1
    description: "Two-sided baselines measured before the first Phase 3 edit"
    verification:
      - kind: other
        ref: ".planning/phases/03-lane-a/03-BASELINE.md (agent-substrate-pass=167, tsc-exit=0, dispatcher-pass=114)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Pure container spec: 127.0.0.1-only publish or internal network, per-container token, graph label, worktree bind, no privileged, no docker socket, refusals"
    verification:
      - kind: unit
        ref: "bun test packages/host/src/sandbox-options.test.ts (19 pass, 0 fail)"
        status: pass
    human_judgment: false
  - id: D3
    description: "substrateDocker starts the only sandboxes; live container publishes 127.0.0.1 only and rejects unauthenticated calls"
    verification:
      - kind: integration
        ref: "03-01-SPIKE.md § Sandbox (docker inspect, /v1/health 401, public/tailscale IP refused)"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-02 image substrate-sandbox:0.1 built locally under the D-03 gate"
    verification:
      - kind: other
        ref: "docker image inspect substrate-sandbox:0.1 (sha256:2063de59…); disk_before_image=29633863680"
        status: pass
    human_judgment: false
  - id: D5
    description: "D-09 answers (a), (b), (c), durability and route_choice with closed-set keys; host cleaned"
    verification:
      - kind: other
        ref: "Task 2 and Task 3 <automated> verify commands from 03-01-PLAN.md (exit 0)"
        status: pass
    human_judgment: false

duration: 32min
completed: 2026-09-25
status: complete
---

# Phase 3 Plan 01: D-09 spike Summary

**rivet agentOS 0.2.21 runs Claude Code in a VM that reaches shunt and substrate-mcp on host loopback (PONG), with a token-protected 127.0.0.1-only Docker sandbox; the adapter ignores hooks, skills and .claude.json, so route_choice=a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn**

## Performance

- **Duration:** 32 min
- **Started:** 2026-09-25T11:13:38Z
- **Completed:** 2026-09-25T11:45:30Z
- **Tasks:** 3 (Task 1 resolved by the owner before this run)
- **Files modified:** 9 (8 plan files + .planning/WINDOWS.md)

## Task 1 owner reply (verbatim)

Owner reply, 2026-09-25: "approved"

Approved versions: @rivet-dev/agentos@0.2.21, @rivet-dev/agentos-sandbox@0.2.21, sandbox-agent@0.4.2,
@agentos-software/claude-code@0.2.7 (transitive), rivetkit@2.3.10 (transitive),
@agentos-software/git@0.3.3 (--no-save, spike only, pruned afterwards). Installed versions matched
exactly (`npm ls`): agentos 0.2.21, agentos-sandbox 0.2.21, sandbox-agent 0.4.2, claude-code 0.2.7,
rivetkit 2.3.10, git 0.3.3 (removed at cleanup).

## Accomplishments

- Baseline before the first edit: agent-substrate 167 pass / 0 fail, tsc clean, dispatcher 114 passed (HEAD 2df112c).
- rivet packages installed into packages/host only (own package-lock.json, no root lock), pinned exactly.
- `buildContainerSpec` + 19 bun tests; `substrateDocker` provider; the stock `docker()` provider never ran.
- Image substrate-sandbox:0.1 (181 MB) built locally; only node:24-bookworm-slim was pulled.
- Spike answers: a_loopback=yes, a_control=denied, a_egress_denied=yes, a_model=yes (grok-4.6);
  b_hooks=none, b_skills=no, b_skill_by_path=yes, b_claude_json_mcp=no, b_session_mcp_names=mcp-N,
  b_sandbox_bun=yes; c_vm_git=no, c_sandbox_git=clone_only, sandbox_tests=yes, c_push_hostfn=yes;
  durability=yes; engine_bind=127.0.0.1; rss_mb=147.
- Host back to its pre-spike state except the kept image, network and node_modules.

## Key answers (03-01-SPIKE.md)

| Key | Value |
|---|---|
| route_choice | a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn |
| d11 | unmet |
| tracker_route | host |
| tests_route | sandbox (tests_oneshot=skipped) |
| (a) | a_loopback=yes, a_control=denied, a_egress_denied=yes, a_model_name=grok-4.6, a_model=yes, a2_*=skipped |
| (b) | b_hooks=none, b_skills=no, b_skill_by_path=yes, b_claude_json_mcp=no, b_session_mcp_names=mcp-N, b_sandbox_bun=yes |
| (c) | c_vm_git=no, c_sandbox_git=clone_only, sandbox_tests=yes, c_push_hostfn=yes |
| sandbox | sandbox_net=published_loopback, sandbox_egress=open (D-12 deviation in Gaps), hostfn_sandbox_collection=sandbox |
| durability | durability=yes (file:same, session:same, seq:2->2, answer:yes), rss_mb=147 |
| extra | sidecar_pool=per_vm, hostfn_cli=/bin/agentos-substrate, fs_write_api=filesystem.writeFile |

## Disk and baselines

| Point | Bytes free on / |
|---|---|
| disk_before (Step 1) | 31843188736 |
| immediately before npm install | 31842811904 |
| disk_after_install | 29634609152 |
| disk_before_image | 29633863680 |
| disk_after_image | 28647456768 |
| before the --no-save git install | 28451700736 |
| disk_after_cleanup | 28535652352 |

| Suite | Before (2df112c) | After (36ef566) |
|---|---|---|
| agent-substrate bun test | 167 pass, 0 fail | 186 pass, 0 fail (+19 sandbox-options tests) |
| tsc (normalized) | tsc-exit=0 | tsc-exit=0 |
| dispatcher pytest | 114 passed | 114 passed |

D-04: asterinas/dev:0.18.1-20260901 (sha256:5211b0c1…) and bold_rosalind present before and after
(d04_intact=yes); orphans_after_cleanup=0. Dispatch stayed off throughout (last
SUBSTRATE_DISPATCH_DISABLED line =1, checked before Task 2, Task 3 and after cleanup).

## Task Commits

1. **Task 1: owner package-legitimacy checkpoint** — no commit (resolved by the owner: "approved").
2. **Task 2: spike tracer** — `890f318` (feat)
3. **Task 3: probes, route_choice, cleanup** — `36ef566` (feat)

**Plan metadata:** this SUMMARY commit (docs).

## Files Created/Modified

- `packages/host/package.json` — main src/main.ts, engines node >=22, exact deps.
- `packages/host/package-lock.json` — local lock (npm --workspaces=false).
- `packages/host/src/sandbox-options.ts` — pure dockerode createContainer body builder.
- `packages/host/src/sandbox-options.test.ts` — 19 bun tests, one per property and refusal.
- `packages/host/src/sandbox-provider.ts` — substrateDocker SandboxProvider (create/destroy/getUrl/getToken).
- `infra/sandbox/Dockerfile` — D-02 image.
- `.planning/phases/03-lane-a/03-BASELINE.md`, `03-01-SPIKE.md` — evidence.
- `.planning/WINDOWS.md` — D-12 sandbox-egress deviation entry.

## Decisions Made

See key-decisions. The derivation followed the plan's rules; nothing in route_choice was chosen by hand.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Exact version pins and an explicit dockerode dependency**
- **Found during:** Task 2 Step 2
- **Issue:** npm saved `^0.2.21`-style ranges (T-03-01-SC requires exact pins); sandbox-provider.ts imports dockerode, which was only transitive.
- **Fix:** re-ran the same install with `--save-exact` (no new download, same versions) and declared `dockerode@4.0.12` (the already-installed version). dockerode ships no types, so it is loaded through `createRequire` behind a narrow local `DockerClient` type.
- **Files modified:** packages/host/package.json, package-lock.json
- **Committed in:** 890f318

**2. [Rule 2 - Security] `--no-telemetry` on the sandbox command server**
- **Found during:** Task 2 Step 4 (`sandbox-agent server --help` lists it)
- **Fix:** appended to the Cmd built by buildContainerSpec, with a test.
- **Committed in:** 890f318

**3. [Rule 2 - Security] Plugin-local state excluded from the image**
- **Found during:** Task 2 Step 4
- **Issue:** the ultrathink plugin cache holds gitignored local state (.claude/settings.local.json, .planning, .hermes, issues, sessions).
- **Fix:** `COPY --from=ultrathink --exclude=…` so only the plugin itself lands in /opt/claude-ultrathink.
- **Committed in:** 890f318

**4. [Rule 3 - Blocking] Spike harness workarounds for three rivet 0.2.21 defects**
- **Found during:** Task 2 Step 5 and Task 3 (c)
- **Issue:** (i) one host-callback handler per sidecar process, so host functions routed to the last-booted VM (`Unknown host function "substrate:healthz"`); (ii) `AgentOs.create` drops the `sandbox` host-function collection; (iii) the pre-expanded options lose their sandbox dispose hooks (3 containers survived a unit stop).
- **Fix (harness only, recorded for 03-03):** `sidecar: { kind: "shared", pool: "vm-<key>" }`; `resolveSandboxOptions` inside `resolveOptions`; dispose hooks run from `onVmDisposed`. Each fix re-verified live (host function 200 after a second VM boot; `agentos-sandbox` present; 0 containers after stop).
- **Files modified:** packages/host/spike/spike.ts (throwaway, deleted)

**5. [Rule 1 - Bug] substrateDocker.destroy failed on 409**
- **Found during:** Task 3 (c), internal-network attempt
- **Issue:** AutoRemove starts removing the container when stop() returns; the explicit remove got HTTP 409 and destroy threw.
- **Fix:** destroy accepts 404 and 409 from remove.
- **Files modified:** packages/host/src/sandbox-provider.ts
- **Committed in:** 36ef566

**6. [Rule 3 - Blocking] Plain-clone sandbox probe and VM git identity**
- **Found during:** Task 3 (c)
- **Issue:** the plan binds /tmp/spike-repo at /work for the clone probe, but buildContainerSpec only accepts `/var/lib/substrate/worktrees/<graph_id>`.
- **Fix:** a plain `git clone --local` at /var/lib/substrate/worktrees/spike-c-<ts>-clone under its own graph id, so every container still came from substrateDocker; VM commits passed `-c user.name/-c user.email` so a missing identity could not mask the result.

**7. [Rule 3 - Blocking] `npm prune --workspaces=false` left @agentos-software/git in place**
- **Found during:** Task 3 cleanup (fix attempt 1: prune; 2: `npm uninstall --no-save`; both exit 0, package still "extraneous")
- **Fix (attempt 3):** removed `packages/host/node_modules/@agentos-software/git` directly; `npm ls` shows it gone; package.json and package-lock.json sha256 unchanged.

**8. [Rule 3 - Blocking] Spike runtime scratch in /tmp**
- **Issue:** the spike unit (no PrivateTmp) left 23 agentos-*/rivet-actor-runtime.* entries (139M) in /tmp.
- **Fix:** removed only entries newer than this plan's start marker; noted in Gaps for the production unit.

### Plan-sanctioned deviation

- **D-12: sandbox container egress open** (sandbox_net=published_loopback because the 0.2.21 sidecar rejects the internal network's http baseUrl). Written to 03-01-SPIKE.md Gaps as the plan requires and to `.planning/WINDOWS.md` (kind deviation).

**Total deviations:** 8 auto-fixed (Rule 1: 1, Rule 2: 3, Rule 3: 4) + 1 plan-sanctioned D-12 deviation.
**Impact on plan:** no route was assumed; every closed-set key comes from observed output. The three rivet defects change how 03-03 must wire vm.ts.

## Issues Encountered

- `process.exec` returns only `{exitCode, outcome}` unless called with `{ output: { capture: "all" } }`; the first probe (a) run printed `undefined` and a fetch without a timeout hung, so it was re-run with capture and a 20 s abort.
- The tool shell's builtin `grep -o` printed nothing, so both plan verify commands were run from a clean `/bin/bash --noprofile --norc`; both exit 0.
- A throwaway `docker run --rm --network none --entrypoint sh substrate-sandbox:0.1` checked the image contents (no sandbox server, no port, no label); it is not a sandbox and exited immediately.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: egress | packages/host/src/sandbox-provider.ts | published_loopback containers have unrestricted outbound egress on Docker's default bridge (D-12 deviation; T-03-01-11 re-check in 03-06) |

## User Setup Required

None.

## Next Phase Readiness

- 03-03 reads route_choice=a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn and must: use one sidecar pool per VM, pre-expand the sandbox with `resolveSandboxOptions` in `resolveOptions` and dispose it from `onVmDisposed`, pass `output: { capture: "all" }` to exec, use sandbox_net=published_loopback, and route substrate calls and commits through host functions.
- tracker_route=host: the host does the Notion/Linear sync (D-10 deviation, selected by this evidence).

## Self-Check: PASSED

- FOUND: .planning/phases/03-lane-a/03-BASELINE.md, 03-01-SPIKE.md
- FOUND: packages/host/src/sandbox-options.ts, sandbox-options.test.ts, sandbox-provider.ts
- FOUND: infra/sandbox/Dockerfile, packages/host/package.json, packages/host/package-lock.json (no root package-lock.json)
- FOUND: commits 890f318, 36ef566
- FOUND: image substrate-sandbox:0.1
- Task 2 and Task 3 automated verify commands: exit 0 after cleanup
