---
phase: 03-lane-a
plan: 04
subsystem: infra
tags: [substrate-host, claude-code, mcp-proxy, seed, d-08, d-10, d-11, d-12, d-15, sc-2]

requires:
  - phase: 03-lane-a
    provides: 03-01 route_choice=a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn, tracker_route=host, tests_route=sandbox; 03-03 substrate-host unit, options/seed/tasks/vm/main, hostFunction `<collection>:*` grammar, openTask seed read-back
  - phase: 02-claims-and-dispatch
    provides: D-06/D-07 (Linear Done only through graph_complete; sync owns PR fields), graph_get view, dispatcher worktree layout
provides:
  - options.ts: TRACKER_PROXY_PORT (7412), TrackerRoute/trackerRoute (vm_mcp exactly for b:hooks+s:mcp), route-aware loopbackPorts/networkPermissions, explicit a:anthropic_key sessionEnv branch, testRunArgv (oneshot docker argv)
  - seed.ts: .claude.json with substrate/notion/linear loopback servers on every route (no headers/env), /home/agentos/.substrate/ultrathink-state.json (+.xml) SessionRecord with complete tracking, b:hooks PostToolUse(Bash)+Stop shim (no UserPromptSubmit), kickoff (vm_mcp only), tests-route and no-.substrate-commit prompt steps, substrate tool names on the hostfn wording
  - vm.ts: run-tests host function on tests_route oneshot (execFile, no shell, 600 s, redacted 4 000-char tail), limits.hostFunctions.maxTimeoutMs 600 000
  - mcp-proxy.ts: TRACKERS, linearStateChange, notionTerminalWrite, StdioBridge, createTrackerProxy, startTrackerProxy (127.0.0.1:7412 only), spawnUltrathinkMcp; main.ts serves it only on tracker_route vm_mcp
  - 03-04-SMOKE.md — observed: seed read back from two VMs, VM-side issue_get through hostfn, :7412 unserved and denied from the VM on tracker_route host, the proxy module exercised host-side against the real ultrathink-mcp children
affects: [03-05, 03-06, 03-07, 03-08, 03-09, 03-10]

actuals:
  tokens: 22815      # chars/4 over the b13b098..d2bf1e7 diff (10 files, +1701/-25)
  tasks: 2
  commits: 2
plan_head_before: b13b09876492b443d031c87b71cfaec1fae49604

tech-stack:
  added: []
  patterns:
    - "Route policy is derived, never configured twice: trackerRoute(route) drives loopbackPorts, networkPermissions, the seeded prompt and main.ts's proxy start from the one route string"
    - "Seed files are pure data (seedFiles) with an injected clock; every consumer-visible file is pinned by seed.test.ts across all 54 routes and checked to be a redact() no-op"
    - "The tracker proxy forwards one JSON-RPC message per POST to a lazily spawned stdio child; colliding client ids are aliased on the wire and restored on the reply; guards run before the child sees a tools/call"
    - "Live evidence on the non-selected route: keys the plan reserves for vm_mcp are recorded as `skipped`, and the same module's behaviour observed outside the unit is kept in an indented block so no column-0 key claims what the unit did not do"

key-files:
  created:
    - packages/host/src/options.test.ts
    - packages/host/src/seed.test.ts
    - packages/host/src/mcp-proxy.ts
    - packages/host/src/mcp-proxy.test.ts
    - .planning/phases/03-lane-a/03-04-SMOKE.md
  modified:
    - packages/host/src/options.ts
    - packages/host/src/seed.ts
    - packages/host/src/vm.ts
    - packages/host/src/main.ts
    - packages/host/src/tasks.test.ts

key-decisions:
  - "The hostfn prompt wording names the substrate tool each CLI command maps to (`agentos-substrate complete … (substrate's graph_complete …)`), so the D-15 ordering `issue_get before graph_complete` and the release-and-stop step hold on both s: channels"
  - "The kickoff sentence is appended to step (2) (after the claimed-node/BRIEF sentence) instead of renumbering the steps, keeping the (1)–(6) shape the Hermes template and the tests slice on"
  - "The seeded IssueRef carries empty url/title: the Linear title is issue text and must reach the model only through issue_get (D-15); graph_register ignores linear_url"
  - "Colliding JSON-RPC ids from two clients on the same tracker child are sent under an alias (`substrate-host:<n>`) and answered with the original id — the message is forwarded verbatim whenever no id is in flight"
  - "413 answers with `connection: close` after draining rather than destroying the socket (a destroyed request reset the client before the status was read)"
  - "The oneshot run-tests function is registered from resolveOptions on the substrate collection whatever the s: channel, because `agentos-substrate` is the collection's CLI name"

patterns-established:
  - "Non-selected-route evidence: plan keys reserved for the other route are `skipped` at column 0; the module's real behaviour, observed outside the unit, is recorded indented"

requirements-completed: []

coverage:
  - id: D1
    description: "Seed, prompt, env, egress and host-function scope pinned by pure tests for every route (SC-2, D-08, D-11, D-12, D-15, tests route)"
    verification:
      - kind: unit
        ref: "bun test packages/host/src/seed.test.ts packages/host/src/options.test.ts (29 pass, 0 fail, no rivet import)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A live VM held the three MCP servers with loopback URLs and no credential, the kickoff state file, and reached substrate's issue_get through the spike's channel"
    verification:
      - kind: integration
        ref: "03-04-SMOKE.md § Task 1: seeded_mcp_servers=linear,notion,substrate, seeded_tracker_urls=loopback, seeded_mcp_headers=none, seeded_state_file=yes, vm_issue_get=found_false_no_ref, vm_issue_get_channel=hostfn; Task 1 <automated> verify exit 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "Tracker proxy: routing, guards, child lifecycle, names-only logging and 127.0.0.1-only bind (D-10, D-08)"
    verification:
      - kind: unit
        ref: "bun test packages/host/src/mcp-proxy.test.ts (14 pass, 0 fail, no rivet import)"
        status: pass
      - kind: integration
        ref: "03-04-SMOKE.md § Task 2 indented block: real ultrathink-mcp children answered initialize and listed 45 (notion) / 59 (linear) tools; Linear state change and Notion Status Done refused (-32001); 413 on an oversized body"
        status: pass
    human_judgment: false
  - id: D4
    description: "The proxy is inert on tracker_route host exactly as 03-01 says: journal proxy-off line, nothing on :7412, in-VM fetch denied"
    verification:
      - kind: integration
        ref: "03-04-SMOKE.md: proxy_line=off, vm_tracker_mcp=inert, vm_proxy_fetch=denied (EACCES blocked by network.http policy); Task 2 <automated> verify exit 0"
        status: pass
    human_judgment: false
  - id: D5
    description: "Root suite and tsc two-sided green against 03-BASELINE.md; dispatcher unchanged"
    verification:
      - kind: other
        ref: "bun test 279 pass / 0 fail (baseline 167, re-measured 236 before the first edit); tsc-exit=0; pytest 119 passed"
        status: pass
    human_judgment: false

duration: 19min
completed: 2026-09-25
status: complete
---

# Phase 3 Plan 04: VM policy and tracker route Summary

**Everything the VM receives from substrate-host is now pinned by pure tests for all 54 routes — the `/home/agentos/.claude.json` with `substrate`, `notion` and `linear` loopback servers and no credential, the ultrathink kickoff state file, the ids-only prompt with route-specific kickoff/tests/issue_get steps, the five D-08 env keys, the D-12 allowlist and the `<collection>:*` host-function scope — and a loopback tracker MCP proxy on 127.0.0.1:7412 bridges the VM's notion/linear servers to the host's own `ultrathink-mcp serve` children with DoD-gate guards, served only when 03-01's evidence says `vm_mcp`; on this host's `tracker_route=host` two live VMs held the seed, reached issue_get through the hostfn channel, and were denied at :7412.**

## Performance

- **Duration:** 19 min
- **Started:** 2026-09-25T14:28:40Z
- **Completed:** 2026-09-25T14:47:30Z
- **Tasks:** 2
- **Files modified:** 10 (5 created, 5 modified)

## Baselines (two-sided, against 03-BASELINE.md)

| Suite | 03-BASELINE (2df112c) | Re-measured at b13b098 before the first edit | After Task 1 (6a2efe0) | After Task 2 (d2bf1e7) |
|---|---|---|---|---|
| agent-substrate bun test | 167 pass, 0 fail | 236 pass, 0 fail | 265 pass, 0 fail (+11 options, +18 seed) | 279 pass, 0 fail (+14 mcp-proxy) |
| tsc (normalized) | tsc-exit=0 | tsc-exit=0 | tsc-exit=0 | tsc-exit=0 |
| dispatcher pytest | 114 passed | 119 passed | — | 119 passed |

No failing-id set differed from the baseline in either direction at any gate.

## Accomplishments

- **options.ts:** `TRACKER_PROXY_PORT = 7412`, `trackerRoute` (vm_mcp exactly for b:hooks + s:mcp — all 36 a/b/s combinations pinned), `loopbackPorts` `[7410, 3001, 7412]`/`[7410, 3001]`/`[]`, `networkPermissions` adding `tcp://127.0.0.1:7412` only on vm_mcp, `sessionEnv` throwing `SUBSTRATE_VM_ANTHROPIC_API_KEY required on route a:anthropic_key`, `testRunArgv` (exact `docker run --rm --network none --label substrate.test_run=<gid> --tmpfs /tmp -v <worktree>:/work:ro [-v <node_modules>:/work/node_modules:ro] -w /work substrate-sandbox:0.1 bun test …`, rejecting absolute paths, `..`, non-`.test.ts`, >8 paths and a foreign worktree).
- **seed.ts:** the three MCP servers on every route (type http, no headers/env); `/home/agentos/.substrate/ultrathink-state.json` as a complete-tracking SessionRecord (sessionId = node id, host claude-code, result.xml = the prompt, plan.task ids-only, `tracking.linear.nodes[<nid>]` and `tracking.notion.taskUrl` only when the graph has them, `updatedAt` from the injected clock) with the `.xml` spec beside it; on b:hooks a `settings.json` with PostToolUse(Bash) and Stop shims (`cat > /home/agentos/work/.substrate-hook-input.json; agentos-sandbox run-command --command sh --args -c --args "bun /opt/claude-ultrathink/hooks/<hook>.ts < /work/.substrate-hook-input.json" --cwd /work; rm -f …`) and never a UserPromptSubmit hook; `renderPrompt` adds the kickoff sentence (vm_mcp only, inside step 2, before issue_get), the tests step by tests_route (`agentos-sandbox run-command` | `agentos-substrate run-tests --node <nid> --path …` | "cannot run on this host … tests_pass false and say why") and "never add files whose names start with .substrate- to a commit". Every seeded file is a `redact()` no-op on every route.
- **vm.ts:** `run-tests` on the substrate collection when tests_route is oneshot — graph/node/session through 03-03's `hostCallTarget`, argv from `testRunArgv`, `execFile` without a shell, 600 s, `{ exit_code, output_tail }` with the tail redacted; `limits.hostFunctions.maxTimeoutMs = 600000`.
- **mcp-proxy.ts:** `StdioBridge` (lazy single child per tracker, pending map by id, 120 s default timeout → 504, exit → 502 and respawn, id aliasing on collision), `createTrackerProxy` (POST `/mcp/notion|linear` only: 404/405/400 `-32700`/400 batch/413; notifications 202; guards `linearStateChange` — `state|stateId|statusId` at any depth — and `notionTerminalWrite` — `Completed`, `date:Completed:start|end`, `Status` Merged/Done/Failed/Blocked as string, `{name}` or `{status:{name}}`, also inside JSON strings — answered `-32001` naming graph_complete and the DoD gate), names-only log lines, `startTrackerProxy` bound to 127.0.0.1:7412 (asserted with an injected listen), `spawnUltrathinkMcp` (`SUBSTRATE_ULTRATHINK_MCP` or the 0.3.0 plugin bin, `serve <tracker>`, env `{HOME:/root, PATH}`, stderr ignored). main.ts starts it only on vm_mcp and logs `tracker mcp proxy off (tracker route host)` otherwise; SIGTERM closes it and kills the children.
- **Live (route host):** two throwaway tasks (`ut-muh2ea68-eb8dcf1c`, `ut-muh2o0rz-5fdd249a`) opened 202 with nine seed files each; the in-VM read-back showed `linear,notion,substrate`, loopback URLs, no headers/env, the state file with `plan.graphId` = gid and `tracking.status=complete`; `agentos-substrate issue-get --node n1` → `{"found":false,"reason":"node has no Linear issue reference"}`; `node -e fetch(127.0.0.1:7412)` → `EACCES … blocked by network.http policy`; journal `tracker mcp proxy off (tracker route host)`; `ss` shows nothing on :7412. Host-side, the same module with the real children listed 45 Notion and 59 Linear tools through the host's own logins and refused both guarded calls. Both sessions reached their first permission request, terminate → exit 1, kill → released; both worktrees and branches removed; the second sandbox disposed on VM sleep (0 labelled containers).

## Task Commits

1. **Task 1: Seed, prompt and VM policy pinned by tests; live seed read-back and VM-side issue_get** — `6a2efe0` (feat)
2. **Task 2: Tracker MCP proxy on 127.0.0.1:7412 — live on vm_mcp, inert on host** — `d2bf1e7` (feat)

**Plan metadata:** this SUMMARY commit (docs).

TDD: options.test.ts and seed.test.ts were written first (RED: both files failed to import `trackerRoute`/`testRunArgv`/`TRACKER_PROXY_PORT` and `now`), then options.ts/seed.ts/vm.ts (GREEN: 29 pass; one prompt-wording iteration for `graph_complete` on the hostfn route). mcp-proxy.test.ts was written first (RED: module missing), then mcp-proxy.ts (GREEN after one 413 fix: 14 pass).

## Files Created/Modified

- `packages/host/src/options.ts` — `TRACKER_PROXY_PORT`, `TrackerRoute`/`trackerRoute`, route-aware `loopbackPorts`/`networkPermissions`, explicit a3 `sessionEnv` branch, `TestRunInput`/`testRunArgv`, `TEST_RUN_LABEL`.
- `packages/host/src/seed.ts` — `VM_STATE_FILE`/`VM_STATE_SPEC`/`VM_KICKOFF_SKILL`/`HOOK_INPUT_FILE`, `testsStep`, kickoff sentence, three-server `.claude.json`, `kickoffState`, `hookShim`/`hookSettings`, `SeedFilesInput.graph: GraphView` and `now?`.
- `packages/host/src/vm.ts` — `runTestsCollection`, `HostVmConfig.testsRoute`, `limits.hostFunctions.maxTimeoutMs`.
- `packages/host/src/main.ts` — `trackerProxy` by `trackerRoute(route)`, proxy-off line, close on signal, `testsRoute` passed to `createHostVm`.
- `packages/host/src/mcp-proxy.ts` — the proxy (above).
- `packages/host/src/options.test.ts` (11), `packages/host/src/seed.test.ts` (18), `packages/host/src/mcp-proxy.test.ts` (14) — one test per behavior bullet, no rivet import.
- `packages/host/src/tasks.test.ts` — the openTask seed contract now lists the two state files and the three MCP servers.
- `.planning/phases/03-lane-a/03-04-SMOKE.md` — Task 1 read-back, Task 2 inert evidence and host-side proxy run, cleanup, Retained, Gaps.

## Decisions Made

See key-decisions. None changes a D-05..D-15 contract; the id aliasing and the 413 handling were forced by the tests (colliding VM clients, a reset socket).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] 03-03's openTask contract test pinned the old seed list**
- **Found during:** Task 1 (`tasks.test.ts` failed on the two new state files and the two new MCP servers)
- **Issue:** the seed list and `.claude.json` content are consumer-visible and changed by design (SC-2).
- **Fix:** `tasks.test.ts` expects the nine-file list and the three servers; no `tasks.ts` change.
- **Files modified:** packages/host/src/tasks.test.ts
- **Commit:** 6a2efe0

**2. [Rule 2 - Missing critical] Hostfn prompt did not name the substrate tools**
- **Found during:** Task 1 (behavior bullet "issue_get before graph_complete" and "names graph_release" failed on s:hostfn, where the prompt only had the CLI words)
- **Issue:** on the spike's own channel the model was never told that `agentos-substrate complete` is graph_complete (the only path to Done) or that `release` is graph_release with the same session id.
- **Fix:** each CLI sentence names the substrate tool and the host-supplied claim session in parentheses.
- **Files modified:** packages/host/src/seed.ts
- **Commit:** 6a2efe0

**3. [Rule 1 - Bug] 413 reset the client**
- **Found during:** Task 2 RED→GREEN (`req.destroy()` on overflow made fetch fail with ECONNRESET before reading the status)
- **Fix:** drain with `req.resume()` and answer 413 with `connection: close`; confirmed under node (host-side run: `oversize_status=413`).
- **Files modified:** packages/host/src/mcp-proxy.ts
- **Commit:** d2bf1e7

**4. [Rule 2 - Missing critical] Colliding JSON-RPC ids across VM clients**
- **Found during:** Task 2 design (every Claude Code MCP client counts ids from the same number; two VMs on vm_mcp would collide on one child)
- **Fix:** an in-flight duplicate id is sent under `substrate-host:<n>` and the reply carries the original id back; otherwise the message is forwarded verbatim (pinned by a test).
- **Files modified:** packages/host/src/mcp-proxy.ts
- **Commit:** d2bf1e7

---

**Total deviations:** 4 auto-fixed (Rule 1: 2, Rule 2: 2).
**Impact on plan:** none of the plan's contracts changed; the proxy's live vm_mcp check could not run because 03-01 selected `tracker_route=host` (recorded as `skipped` keys, with the module's host-side behaviour in an indented block and a Gaps entry) — this is the D-10 deviation the plan itself anticipates for 03-10.

## Issues Encountered

- `tracker_route=host` on this VPS means the plan's vm_mcp branch (proxy live, VM listing tools through it, in-VM kickoff) is unobservable here; the proxy was exercised host-side against the real `ultrathink-mcp serve notion|linear` children instead (45 / 59 tools, both guards refusing), never through a VM.
- The default sidecar cap for host-function timeouts was not found in the shipped typings; `limits.hostFunctions.maxTimeoutMs` is set to 600 000 as the plan directs and the unit started and served two tasks with it.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new-endpoint | packages/host/src/mcp-proxy.ts | A new loopback HTTP endpoint (127.0.0.1:7412) that, on tracker_route vm_mcp, lets any process on the host — not only the VM — call Notion and Linear with the owner's logins (the D-13 approval gate is on the VM side). In the plan's threat model (T-03-04-03) as loopback-only; the host-side reachability is the same trust boundary substrate-mcp already has on 127.0.0.1:7410. |

## User Setup Required

None — no external service configuration required. The proxy's children read the host's existing `/root/.config/ultrathink` store.

## Next Phase Readiness

- 03-05's HostClient is unaffected (api.ts untouched); the task record's `seeded` list now has nine entries.
- 03-07 (sync, `.substrate-*` guard) can rely on the prompt sentence and `HOOK_INPUT_FILE`; 03-10 records the D-10 host-side writes with 03-01's evidence and this plan's `vm_tracker_mcp=inert`.
- If a later spike flips `tracker_route` to vm_mcp, no code changes: the unit's route string alone turns on the port exemption, the allow rule, the kickoff prompt step and the proxy.
- Dispatch stayed off throughout; no substrate.env value was read or printed.

## Self-Check: PASSED

- FOUND: packages/host/src/options.ts, seed.ts, vm.ts, main.ts, mcp-proxy.ts, options.test.ts, seed.test.ts, mcp-proxy.test.ts, tasks.test.ts, .planning/phases/03-lane-a/03-04-SMOKE.md
- FOUND: commits 6a2efe0, d2bf1e7 (`git log --grep 03-04`)
- `substrate-host` active, healthz `{"engine":true,"api":true}`, nothing on :7412, journal proxy-off line; both throwaway worktrees gone; 0 labelled containers
- Task 1 and Task 2 `<automated>` verify commands: exit 0 each; root suite 279 pass / 0 fail, tsc-exit=0, dispatcher 119 passed
