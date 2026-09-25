---
phase: 03-lane-a
plan: 03
subsystem: infra
tags: [rivet, agentos, substrate-host, systemd, claude-code, d-05, d-06, d-08, d-11, d-12, d-13, d-15]

requires:
  - phase: 03-lane-a
    provides: 03-01 route_choice=a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn, sandbox_net=published_loopback, hostfn_sandbox_collection=sandbox, tests_route=sandbox, the three 0.2.21 workarounds, substrateDocker + buildContainerSpec, image substrate-sandbox:0.1; 03-02 issue_get / POST /issue
  - phase: 02-claims-and-dispatch
    provides: substrate-mcp graph_register/get/claim/release/complete on 127.0.0.1:7410, dispatcher id patterns and worktree layout, unit structure
provides:
  - substrate-host systemd unit (infra/vps/substrate-host.service), installed, enabled, active — engine 127.0.0.1:6420, API 127.0.0.1:7411, storage /var/lib/substrate/agentos (0700)
  - packages/host/src: options.ts (Route grammar, D-12 network policy, hostFunction scope, D-08 sessionEnv), seed.ts (ids-only claude-code prompt, seedFiles), substrate.ts (SubstrateClient), tasks.ts (TaskRecord/TaskStore/TaskService, pollCode, validateOpenRequest, hostCallTarget), api.ts (POST/GET /tasks, terminate, kill, healthz), vm.ts (agentOS definition, substrate host functions, approval recorder, ensureModelRoute), main.ts
  - Host API contract for 03-05's HostClient: 202 new | 200 existing | 400 | 409 | 502; GET status spreads every stored field + state/latest_sequence/history_events; terminate/kill 202
  - 03-03-TRACER.md — observed evidence: claim as claude-code, seven seed files read back, first model event (permission_request Read, pending, never answered), terminate → exit 1, kill → released, claimed_by null; in-VM probe of host functions, sandbox, egress
affects: [03-04, 03-05, 03-06, 03-07, 03-08, 03-09, 03-10]

actuals:
  tokens: 25305      # chars/4 over the 8f1af85..57a892f diff (11 files, +2309)
  tasks: 2
  commits: 2
plan_head_before: 8f1af85de5457c450f36c934f59b2f51c8ca5b56

tech-stack:
  added: []
  patterns:
    - "Rivet imports only in vm.ts and main.ts; api/tasks/substrate/seed/options take collaborators as arguments, so host tests never load rivet"
    - "resolveOptions returns resolveSandboxOptions({ sidecar: per-VM pool, mounts, sandbox, hostFunctions }) — the actor layer's shallow spread means every per-VM option, including the host-function collections, must come out of that one call; dispose hooks kept per actorId and run from onVmDisposed"
    - "Host functions close over c.key and go through hostCallTarget(key, argv, store lookup) before any substrate call; hostFunction permission patterns are <collection>:*"
    - "openTask verifies each seed file by reading it back from the VM and hashing it; the record stores {path, sha256, bytes}"
    - "Un-awaited prompt tracked in TaskService.turns so tests await settlement instead of timers"
    - "Evidence: closed-set key=value at column 0, failed runs indented 4 spaces, one ## Gaps"

key-files:
  created:
    - packages/host/src/options.ts
    - packages/host/src/seed.ts
    - packages/host/src/substrate.ts
    - packages/host/src/tasks.ts
    - packages/host/src/api.ts
    - packages/host/src/vm.ts
    - packages/host/src/main.ts
    - packages/host/src/tasks.test.ts
    - packages/host/src/api.test.ts
    - infra/vps/substrate-host.service
    - .planning/phases/03-lane-a/03-03-TRACER.md
  modified: []

key-decisions:
  - "hostFunction permission patterns are `substrate:*` and `sandbox:*`: the sidecar names the resource <collection>:<command> (live refusal 'blocked by hostFunction.invoke policy for substrate:issue-get'); bare collection names deny everything"
  - "sandboxAgentProvider gets no token option: substrateDocker hands the container token through getToken() (03-01 contract); passing one left the sandbox permanently unhealthy (Token Invalid)"
  - "The substrate host-function collection is built inside resolveOptions (closing over c.key) and passed through resolveSandboxOptions, because the actor layer spreads the resolved options over the base ones"
  - "openTask reads every seed file back and hashes it; a mismatch fails the open (claim released, 502) — the seeded list in the record is observed, not assumed"
  - "Status reads the live session (sessions.get + readHistory) on every call; released tasks report state unloaded without waking the VM"
  - "registry.startAndWait() and registry.shutdown() on SIGTERM instead of bare start(); a unit restart disposes VMs and their containers (observed: vm disposed reason=sleep sandboxes=1, 0 containers)"
  - "Tests were written before the live run (tasks.test.ts, api.test.ts) and committed with Task 2; no tasks.ts/api.ts change was needed in Task 2"

patterns-established:
  - "Host tracer evidence: unit binds from ss, tracer keys from the throwaway script's stdout, in-VM probe through a second rivet client on 127.0.0.1:6420"

requirements-completed: []

coverage:
  - id: D1
    description: "substrate-host runs as its own systemd unit: active, enabled, engine and API bound to 127.0.0.1 only, storage 0700"
    verification:
      - kind: integration
        ref: ".planning/phases/03-lane-a/03-03-TRACER.md § Unit (api_bind=127.0.0.1:7411, engine_bind=127.0.0.1:6420); Task 1 <automated> verify exit 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "POST /tasks claims the node as claude-code (session id = node id) before any prompt, seeds /home/agentos (brief, four ultrathink skills, .claude.json substrate MCP, tracker locators), opens the session with permissionPolicy ask and reaches the first model event"
    verification:
      - kind: integration
        ref: "03-03-TRACER.md run 3: claim_session=n1, seeded_* = yes, first_event=approval_pending (tool Read, never answered), exit_after_terminate=1 (cancelled), released_after_kill=true, claimed_by_after_kill=null"
        status: pass
    human_judgment: false
  - id: D3
    description: "openTask/API contract: validation naming the field, idempotent 200, 409 paths, release-once-then-502 on failure, un-awaited idempotent first prompt, ensureModelRoute before open and prompt, kill side effects, full-record status, hostCallTarget guard"
    verification:
      - kind: unit
        ref: "bun test packages/host/src/tasks.test.ts packages/host/src/api.test.ts (36 pass, 0 fail)"
        status: pass
      - kind: integration
        ref: "03-03-TRACER.md § Task 2: idempotent_second_status=200, idempotent_prompt_count=1, bad_worktree_status=400"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-12 inside the VM: egress to example.com denied, host loopback 7410 reachable; host functions issue-get and sandbox run-command invocable, hostCallTarget refuses a foreign node"
    verification:
      - kind: integration
        ref: "03-03-TRACER.md § In-VM probe (vm_egress_example_com=denied, vm_loopback_7410=200, hostfn_issue_get=found_false, hostfn_bad_node=refused, sandbox_bun=1.4.0)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Root suite and tsc two-sided green against 03-BASELINE.md; dispatcher unchanged"
    verification:
      - kind: other
        ref: "bun test 236 pass / 0 fail (baseline 167, re-measured 200 before the first edit); tsc-exit=0; pytest 119 passed"
        status: pass
    human_judgment: false

duration: 37min
completed: 2026-09-25
status: complete
---

# Phase 3 Plan 03: Host tracer Summary

**substrate-host is a live systemd unit (rivet engine 127.0.0.1:6420, API 127.0.0.1:7411, storage /var/lib/substrate/agentos 0700) and one loopback `POST /tasks` claimed a throwaway node as claude-code, seeded /home/agentos with the brief, the four ultrathink skills, a `substrate` MCP entry and the tracker locators, opened a Claude Code session in the graph's VM under `permissionPolicy: "ask"` and reached its first model event — a `Read` permission request that stayed pending until terminate (exit 1) and kill (claim released).**

## Performance

- **Duration:** 37 min
- **Started:** 2026-09-25T13:46:00Z
- **Completed:** 2026-09-25T14:23:00Z
- **Tasks:** 2
- **Files modified:** 11 (all created)

## Baselines (two-sided, against 03-BASELINE.md)

| Suite | 03-BASELINE (2df112c) | Re-measured at 8f1af85 before the first edit | After (57a892f) |
|---|---|---|---|
| agent-substrate bun test | 167 pass, 0 fail | 200 pass, 0 fail | 236 pass, 0 fail (+28 tasks, +8 api) |
| tsc (normalized) | tsc-exit=0 | tsc-exit=0 | tsc-exit=0 |
| dispatcher pytest | 114 passed | 119 passed | 119 passed |

No failing-id set differed from the baseline in either direction at any gate.

## Accomplishments

- **Unit (D-05):** `infra/vps/substrate-host.service` installed at 14:11:28Z, `active`/`enabled`; `ss` shows only `127.0.0.1:6420/6421/6430` (rivet-engine) and `127.0.0.1:7411` (node); `/var/lib/substrate/agentos` and `tasks/` are 0700; journal carries `engine 127.0.0.1:6420`, `api 127.0.0.1:7411`, `route a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn`, `telegram approvals off`.
- **Tracer (run 3, the committed code):** graph `ut-muh1p05f-695a18ee` registered over MCP with no Linear/Notion reference; POST /tasks 202 at 14:17:32Z; `claimed_by=claude-code claim_session=n1` at 14:17:43Z; seven seed files written and read back (sha256 + bytes in the record); first model event at 14:17:48Z — `permission_request` for tool `Read`, `state=waiting`, `latest_sequence=2`, exit_code null, never answered (journal: `approval pending … (telegram approvals off)`); terminate → `stop=cancelled`, exit_code 1 at 14:17:51Z; kill → `released=true`, `state=unloaded`, `claimed_by=null`.
- **In-VM probe (throwaway rivet client):** `agentos-substrate issue-get --node n1` → `{"found":false,"reason":"node has no Linear issue reference"}` (the host-function path end to end); `--node n9` → `no task for node n9 in this VM` (hostCallTarget); `agentos-sandbox run-command bun --version` → `1.4.0` (sandbox healthy, node_modules bound read-only); `https://example.com` → EACCES blocked by network policy; `http://127.0.0.1:7410/healthz` → 200; skills dir lists the four skills; `.claude.json` still names `substrate`.
- **Contract (Task 2, graph `ut-muh1trcj-90066f6e`):** POST twice → 202 then 200 with `prompt_count=1` and one claim session; worktree `/tmp/x` → 400 `worktree must be /var/lib/substrate/worktrees/<gid>`; terminate → exit 1; kill → released, claimed_by null. 36 pure tests cover every behavior bullet without a rivet import.
- **Three 0.2.21 workarounds carried:** per-VM sidecar pool `vm-<gid>`; `resolveSandboxOptions` inside `resolveOptions`; dispose hooks kept per actor and run from `onVmDisposed` (observed `vm disposed … reason=sleep sandboxes=1`, 0 labelled containers after a unit restart; boot sweep `orphan sandboxes removed: 0`). The stock `docker()` provider is never imported.
- Cleanup: the four throwaway worktrees and `substrate/<gid>` branches of this plan removed (two failed-run ones at the end of Task 1, the two named by `graph_id`/`contract_graph_id` in Task 2); `git worktree list` shows main plus Phase 2's two graphs; the main checkout stayed on main.

## Task Commits

1. **Task 1: Host tracer — unit, task API, claim → seed → VM session → first model event** — `46bb8cd` (feat)
2. **Task 2: openTask contract tests, live idempotency/validation check, cleanup** — `57a892f` (test)

**Plan metadata:** this SUMMARY commit (docs).

TDD: tasks.test.ts and api.test.ts were written before the live run (RED against the untested
service: one failure — the fake session state did not follow the prompt lifecycle — then GREEN);
Task 1's tracer verify was the live RED/GREEN (no unit → verify fails; unit up → exit 0).

## Files Created/Modified

- `packages/host/src/options.ts` — `Route`, `parseRoute`/`formatRoute`, `parseTestsRoute`, `D12_HOSTS`, `loopbackPorts`, `networkPermissions`, `hostFunctionPermissions`, `sessionEnv` (exactly five keys), URL constants; re-exports `worktreeFor`.
- `packages/host/src/seed.ts` — id patterns (NODE_ID_RE, IDENTIFIER_RE, REPO_SLUG_RE), `ADDITIONAL_INSTRUCTIONS`, `renderPrompt` (steps 1–6, s:mcp vs s:hostfn wording), `seedFiles`.
- `packages/host/src/substrate.ts` — `SubstrateClient` (`call` with SSE/JSON parsing, `graphGet/Claim/Release/Complete`, `issueGet`, fail-open `brief`), `SubstrateError`, `sseMessages`.
- `packages/host/src/tasks.ts` — `TaskRecord`, `TaskStore` (0600, temp+rename) and `MemoryTaskStore`, `pollCode`, `validateOpenRequest`, `hostCallTarget`, `VmHandle` slice, `TaskService` (`openTask`, `status`, `list`, `terminate`, `kill`, `recordApproval`, `resolveApproval`, `turns`).
- `packages/host/src/api.ts` — `createApiServer` with the routes 03-05 consumes.
- `packages/host/src/vm.ts` — `createHostVm` (agentOS definition + registry), `substrate` host functions (issue-get, release, complete; model-fetch on a:hostfn_proxy), `createEnsureModelRoute`, approval recorder.
- `packages/host/src/main.ts` — env config (exit 2 on a bad route or tests route), 0700 storage, skills and tracker locators loaded from the host, D-04 orphan sweep by label, `registry.startAndWait()`, client, API, signal handling.
- `packages/host/src/tasks.test.ts`, `packages/host/src/api.test.ts` — 36 bun tests, no rivet import.
- `infra/vps/substrate-host.service` — the unit (installed copy identical).
- `.planning/phases/03-lane-a/03-03-TRACER.md` — observed evidence, failed runs, probe, contract, cleanup, gaps.

## Decisions Made

See key-decisions. Two were forced by live observation (hostFunction pattern grammar, sandbox token option); the rest follow the plan's D-05/D-06/D-08/D-12/D-13 text.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Sandbox token passed twice**
- **Found during:** Task 1, tracer run 1 (journal `sandbox-agent at http://127.0.0.1:32774 is not healthy after 30531ms; still waiting (Token Invalid)`)
- **Issue:** the plan's vm.ts sketch passes `{ token: randomUUID() }` to `sandboxAgentProvider`, but 03-01's `substrateDocker` already hands the container's token through `getToken()`; the two never matched, so the sandbox stayed unhealthy and `agentos-sandbox` would have failed.
- **Fix:** no token option; the provider's `getToken()` is the single source (as sandbox-provider.ts documents).
- **Verification:** run 2/3 `vm resolved` in 4 s with no health warning; probe `agentos-sandbox run-command bun --version` → 1.4.0.
- **Committed in:** 46bb8cd

**2. [Rule 1 - Bug] hostFunction permission patterns**
- **Found during:** Task 1, in-VM probe after run 2 (`blocked by hostFunction.invoke policy for substrate:issue-get`, `… for sandbox:run-command`)
- **Issue:** the plan allows patterns `["substrate", <sandbox collection>]`; the sidecar names the resource `<collection>:<command>`, so nothing matched and every host function — including the sandbox — was denied.
- **Fix:** `hostFunctionPermissions` allows `substrate:*` and `<sandbox collection>:*` (still only those two collections; `operations: ["invoke"]` confirmed by the refusal text).
- **Verification:** probe after restart: issue-get 200-path reply, run-command 1.4.0, foreign node refused by hostCallTarget.
- **Committed in:** 46bb8cd

**3. [Rule 2 - Missing critical] Host functions must be passed through resolveOptions**
- **Found during:** Task 1, reading `ensureVm` in @rivet-dev/agentos 0.2.21 (`{...options, ...resolved}` shallow spread)
- **Issue:** a `hostFunctions` collection on the base definition is replaced by the resolved options' `hostFunctions` (which carry the sandbox collection), so the `substrate` collection would vanish exactly when the sandbox is present.
- **Fix:** the collections are built inside `resolveOptions` (closing over `c.key` for hostCallTarget) and passed into `resolveSandboxOptions`.
- **Verification:** probe `/bin` lists `agentos-sandbox` and `agentos-substrate`; both invocable.
- **Committed in:** 46bb8cd

**4. [Rule 3 - Blocking] Worktree count for Task 2's cleanup**
- **Found during:** Task 1 (three tracer runs instead of one)
- **Issue:** the plan's `throwaway_worktrees_removed=2` assumes one throwaway per task; runs 1 and 2 (defective host) left two more.
- **Fix:** the two failed-run worktrees/branches were removed at the end of Task 1 and recorded under `## Failed runs` (`failed_run_worktrees_removed=2`, indented); Task 2 removed exactly `graph_id` and `contract_graph_id` (count 2, honest).
- **Committed in:** 46bb8cd / 57a892f

---

**Total deviations:** 4 auto-fixed (Rule 1: 2, Rule 2: 1, Rule 3: 1).
**Impact on plan:** deviations 1–3 are what makes the sandbox and the host functions actually work; nothing in the D-05..D-15 contract changed. 03-04's options.test.ts must pin `substrate:*` / `sandbox:*` patterns, not bare names.

## Issues Encountered

- Run 1's terminate settled through `last_error` (`session_storage_error: actor SQLite UDS request timed out after 30000ms`) rather than a `cancelled` stop reason while the sandbox health loop was spinning; with the token fix, runs 2 and 3 and the contract run all settled `stop=cancelled` within 3 s. Recorded in TRACER.md Failed runs; not reproduced on the fixed host.
- Claude Code rewrites `/home/agentos/.claude.json` on first start (adds firstStartTime, userID, migration flags); the `substrate` entry survives but a later hash read-back of that file would not match the seeded sha256 (Gaps).
- The pattern grammar of the `hostFunction` scope is undocumented; learned from the sidecar's refusal message.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: hostfn-return-shape | packages/host/src/vm.ts | Host functions return substrate replies verbatim to the guest (issue text framed untrusted by 03-02's redact/cap; release/complete replies name the claim session, which is public). No new secret reaches the VM. |

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 03-04 pins seed/prompt/env/egress with tests: `seedFiles`, `renderPrompt`, `sessionEnv`, `networkPermissions`, `hostFunctionPermissions` (patterns `substrate:*`, `sandbox:*`) are pure and exported; `seedFiles` already receives graph, nodeId, route and prompt.
- 03-05's HostClient can target the contract in api.ts header: 202/200/400/409/502, GET spreads the record, terminate/kill 202, `/healthz` `{engine, api}`.
- Live facts for later plans: the first model event arrives ~5 s after open; a session under `ask` blocks on its first `Read` until an approver answers (03-08); `GET /tasks/<gid>/<nid>` wakes the VM (sessions.get + readHistory) on every poll.
- Dispatch stayed off throughout (the dispatcher was never touched; no substrate.env value was read or printed).

## Self-Check: PASSED

- FOUND: packages/host/src/{options,seed,substrate,tasks,api,vm,main}.ts, tasks.test.ts, api.test.ts, infra/vps/substrate-host.service, .planning/phases/03-lane-a/03-03-TRACER.md
- FOUND: commits 46bb8cd, 57a892f (`git log --grep 03-03`)
- Installed unit byte-identical to infra/vps/substrate-host.service; `substrate-host` active; binds 127.0.0.1:6420 and 127.0.0.1:7411 only; 0 labelled containers; both throwaway worktrees gone
- Task 1 and Task 2 `<automated>` verify commands re-run after the SUMMARY was written: exit 0 each; root suite 236 pass / 0 fail, tsc-exit=0, dispatcher 119 passed
- Dispatch stayed off: last `SUBSTRATE_DISPATCH_DISABLED` line is `=1` (count of `=1` lines 4, unchanged)
