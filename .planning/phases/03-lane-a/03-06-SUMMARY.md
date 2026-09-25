---
phase: 03-lane-a
plan: 06
subsystem: infra
tags: [substrate-host, rivet, agentos, durability, audit, docker, d-01, d-04, d-07, d-08, d-12]

requires:
  - phase: 03-lane-a
    provides: 03-01 route_choice=a:loopback,…, sandbox_net=published_loopback, durability=yes, sandbox_egress=open; 03-03 TaskRecord/TaskStore/TaskService, startPrompt, ensureModelRoute, main.ts boot order, substrate-host unit; 03-04 sessionEnv exact-key test, seed of NOTION_TASK_GRAPH_DS into the VM; 03-05 GET /tasks contract the dispatcher polls
provides:
  - tasks.ts: TaskRecord.resumes / stale_approvals (older records read as 0), interruptedTasks, RESUME_TEXT, TaskService.resumeInterrupted (one continuation prompt per interrupted task per boot, key <gid>:<nid>:resume:<n>, ensureModelRoute first, per-task failure isolation), TaskService.beginShutdown (prompt rejections during SIGTERM leave the record in flight)
  - main.ts: resumeInterrupted after the engine and client are ready, before the API listens; beginShutdown in the signal handler
  - audit.ts: containerViolations, secretKey, secretHits, auditTotals, formatAudit and the `node src/audit.ts --sandbox-net … [--sanctioned NAME]` CLI (names, modes, integers only)
  - 03-06-SMOKE.md: observed restart survival (session n1 kept, seq 2→4, brief sha equal on disk and in the VM, resumed key :n1:resume:1, new approval after the restart) and the live audit (storage 700, secret_hits_total=0, one labelled container with 0 violations, VM egress denied, container egress reachable = D-12 deviation, D-04 intact)
affects: [03-07, 03-08, 03-09, 03-10]

actuals:
  tokens: 14229      # chars/4 over the 0797ce8..8f09b89 diff (7 files, +994/-3)
  tasks: 2
  commits: 2         # git rev-list --count 0797ce83711a891949c0e5b843d91610356ac427..HEAD
plan_head_before: 0797ce83711a891949c0e5b843d91610356ac427

tech-stack:
  added: []
  patterns:
    - "Boot-time recovery is a pure selection (interruptedTasks over the store) plus the same un-awaited startPrompt path the first prompt uses; the only new state is a counter in the record, so an idempotency key can name each continuation"
    - "Shutdown is signalled into the service before the registry stops: rejections that arrive while stopping are the shutdown's, not the turn's"
    - "Audit output is a pure formatter over a report object (formatAudit) so the names-and-counts-only contract is a unit test, and the CLI is a thin reader of env, storage bytes and docker inspect"

key-files:
  created:
    - packages/host/src/audit.ts
    - packages/host/src/audit.test.ts
    - .planning/phases/03-lane-a/03-06-SMOKE.md
  modified:
    - packages/host/src/tasks.ts
    - packages/host/src/tasks.test.ts
    - packages/host/src/main.ts
    - packages/host/src/api.test.ts

key-decisions:
  - "resumeInterrupted increments resumes before the prompt and keys it from the stored value, so a restart during the continuation itself gets resume:2 on the next boot rather than replaying resume:1"
  - "A failing ensureModelRoute or a synchronous vmFor error marks that task failed (exit_code 1, last_error) and the loop continues; the prompt's own rejection settles through startPrompt's catch exactly like the first prompt"
  - "beginShutdown (Rule 2): without it a prompt rejection delivered during SIGTERM would flip the record to exit_code 1 and the task would never be resumed — the live restart only avoided this because rivet lost the websocket before the rejection reached the host"
  - "containerViolations reports at most one violation per bind (docker.sock wins over writable_bind) and, when the label is missing, still accepts a writable bind under WORKTREES_ROOT at /work so a missing label is one violation, not two"
  - "Sanctioned names are removed from secret_keys and reported under sanctioned_keys / sanctioned_hits_<NAME>; a sanctioned name absent from the environment reads 0"
  - "The audit CLI adds containers_inspected=<n> (an integer, inside the names/modes/integers contract) so sandbox_container_seen is read from the audit's own output"

patterns-established:
  - "Evidence with two throwaway tasks: raw status dumps indented four spaces, one column-0 line per closed-set key across both tasks, one ## Gaps"

requirements-completed: []

coverage:
  - id: D1
    description: "Resume-on-boot contract: interruptedTasks selection, one prompt keyed resume:<n>, stale approvals, once per process, next-boot key increments, released/finished/idle records untouched, per-task failure isolation for prompt and model route, legacy records read as 0, shutdown-preserves-in-flight"
    verification:
      - kind: unit
        ref: "bun test packages/host/src/tasks.test.ts (36 pass, 0 fail; 8 new tests, no rivet import)"
        status: pass
    human_judgment: false
  - id: D2
    description: "D-07 observed live: substrate-host restarted while task ut-muh3nlig-97d72a43/n1 waited on its first Read approval; after the restart the session id was unchanged, latest_sequence 2→4, the brief's sha256 equal in the record and when read from the VM, journal `resumed … key …:n1:resume:1`, a new permission_request 7 s after the resume, stale_approvals=1; kill released the claim"
    verification:
      - kind: integration
        ref: ".planning/phases/03-lane-a/03-06-SMOKE.md restart_survived=true, session_before=session_after=n1, seq 2→4, brief_sha_before=brief_sha_after=vm_brief_sha256_live, post_restart_event=approval_pending; Task 1 <automated> verify exit 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "Audit pure functions: containerViolations shape checks (each named violation once, network_mode on internal only), secretKey by segment, secretHits by label with the 12-char floor, auditTotals with sanctioned names, formatAudit names/modes/integers only"
    verification:
      - kind: unit
        ref: "bun test packages/host/src/audit.test.ts (11 pass, 0 fail; imports only ./audit.ts and ./sandbox-options.ts)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Live containment: storage_mode=700, secret_hits_total=0 over GREPTIME_PASSWORD/LINEAR_API_KEY/NOTION_API_KEY, config hits reported by name (NOTION_TASK_GRAPH_DS=1548, the seeded locator), one substrate.graph_id container with container_violations=0, vm_example_com=denied, container_example_com=reachable recorded as the D-12 deviation, d04_intact=yes, throwaway_worktrees_removed=2"
    verification:
      - kind: integration
        ref: "03-06-SMOKE.md § Task 2 (audit CLI output verbatim under systemd-run with EnvironmentFile); Task 2 <automated> verify exit 0"
        status: pass
    human_judgment: false
  - id: D5
    description: "Root suite and tsc two-sided green against 03-BASELINE.md; dispatcher unchanged"
    verification:
      - kind: other
        ref: "bun test 298 pass / 0 fail (baseline 167, re-measured 279 before the first edit); tsc-exit=0; pytest 149 passed"
        status: pass
    human_judgment: false

duration: 21min
completed: 2026-09-25
status: complete
---

# Phase 3 Plan 06: Durability and containment audit Summary

**substrate-host now resumes every turn a restart cut short — exactly once per boot, keyed `<gid>:<nid>:resume:<n>`, with the dead turn's approvals counted as stale and the model route re-established first — and a real `systemctl restart substrate-host` under a task waiting on its first approval kept session `n1`, its history (sequence 2→4) and `/home/agentos` (brief sha equal on disk and read back from the VM), then raised a new permission request 7 s after the continuation prompt; a new `audit.ts` CLI, run under `systemd-run` with substrate.env as EnvironmentFile, showed the live host keeps rivet storage at 0700 with zero matches of any secret-named value, runs one locked-down `substrate.graph_id` container (0 violations), denies `https://example.com` from the VM, leaves the sandbox container's own egress open on `published_loopback` (the known D-12 deviation, recorded), and never touched `asterinas/dev` or `bold_rosalind`.**

## Performance

- **Duration:** 21 min
- **Started:** 2026-09-25T15:06:38Z
- **Completed:** 2026-09-25T15:27:30Z
- **Tasks:** 2
- **Files modified:** 7 (3 created, 4 modified)

## Baselines (two-sided, against 03-BASELINE.md)

| Suite | 03-BASELINE (2df112c) | Re-measured at 0797ce8 before the first edit | After Task 1 (625f3e8) | After Task 2 (8f09b89) |
|---|---|---|---|---|
| agent-substrate bun test | 167 pass, 0 fail | 279 pass, 0 fail | 287 pass, 0 fail (+8 tasks) | 298 pass, 0 fail (+11 audit) |
| tsc (normalized) | tsc-exit=0 | tsc-exit=0 | tsc-exit=0 | tsc-exit=0 |
| dispatcher pytest | 114 passed | 149 passed | — | 149 passed (no Python touched) |

No failing-id set differed from the baseline in either direction at any gate.

## Accomplishments

- **Resume on boot (D-07):** `TaskRecord` carries `resumes` and `stale_approvals` (03-03 records without them read as 0 through `withResumeDefaults` in `TaskStore.get/list`); `interruptedTasks` selects `turn_in_flight && !released && exit_code === null`; `resumeInterrupted` runs once per process, awaits `ensureModelRoute` per task, moves `pending_approvals` into the `stale_approvals` count, bumps `prompt_count`/`resumes`, sends `RESUME_TEXT` un-awaited through the same `startPrompt` path as the first prompt with key `<gid>:<nid>:resume:<resumes>` and logs `[substrate-host] resumed <gid>/<nid> key <key>`. main.ts calls it after `registry.startAndWait()` and `createClient`, before `server.listen`, and logs `interrupted turns resumed: <n>`.
- **Live restart (graph `ut-muh3nlig-97d72a43`):** POST /tasks 202 at 15:12:26Z; first `Read` approval pending at 15:12:47Z (`latest_sequence=2`); `systemctl restart` at 15:12:57Z; API back at 15:13:15Z; journal `resumed ut-muh3nlig-97d72a43/n1 key ut-muh3nlig-97d72a43:n1:resume:1` at 15:13:14Z; rivet `restored session isolate from_snapshot=true`; new `permission_request` (`a5186b9c…`, tool Read) at 15:13:21Z; status: `session_id=n1`, `latest_sequence=4`, `history_events=4`, `prompt_count=2`, `resumes=1`, `stale_approvals=1`, the old request gone from `pending_approvals`; the brief read from the VM after the restart hashed to the same `08d59267…` the record stored at open. Kill → `released=true`, `graph_get claimed_by=None`.
- **Audit module (D-01, D-08):** `containerViolations` (label, `port_binding` for any HostIp other than 127.0.0.1, `network_mode` on `internal` when NetworkMode ≠ `substrate-sandbox` or a port is published, `privileged`, `token` for `--no-token`/missing `--token`, `writable_bind` for any writable mount other than the graph's own worktree at `/work`, `docker_sock` from Binds or Mounts), `secretKey` (underscore-segment set KEY/KEYS/TOKEN/TOKENS/SECRET/SECRETS/PASSWORD/PASSWD/PAT/CREDENTIAL/CREDENTIALS/PRIVATE/COOKIE), `secretHits` (non-overlapping byte matches per label, values under 12 chars skipped), `auditTotals`, `formatAudit`; the CLI reads every env var ≥ 12 chars not starting with `/`, walks every regular file under the storage dir, then `docker ps -q --filter label=substrate.graph_id` + `docker inspect`.
- **Live audit (graph `ut-muh424n5-667ff591`):** in-VM `agentos-sandbox run-command git --version` → `git version 2.39.5` (container `5aa36b601b8d awesome_sutherland`, `127.0.0.1:32785->3000/tcp`); VM `fetch https://example.com` → `EACCES … blocked by network.http policy`; container `curl` → exit 0. Audit CLI: `storage_mode=700`, `secret_keys=GREPTIME_PASSWORD,LINEAR_API_KEY,NOTION_API_KEY` all 0, `secret_hits_total=0`, `sanctioned_keys=none`, `config_hits_NOTION_TASK_GRAPH_DS=1548` (the seeded locator; every other config key 0), `containers_inspected=1`, `container_violations=0`. Inspected shape: PortBindings `127.0.0.1`, `privileged=false`, `autoremove=true`, binds worktree `/work` + node_modules `:ro`, label set, `--token` present, image `substrate-sandbox:0.1`. D-04: `asterinas/dev:0.18.1-20260901` sha unchanged, `bold_rosalind` still listed.
- Cleanup: both throwaway worktrees and `substrate/<gid>` branches removed (`throwaway_worktrees_removed=2`); `git worktree list` shows main plus Phase 2's two graphs; the probe (`packages/host/.probe-03-06.mjs`) and opener (`/tmp/03-06-open.py`) deleted; 0 labelled containers; switch's last line still `=1`; no substrate.env value read or printed.

## Task Commits

1. **Task 1: Resume interrupted turns on boot and observe a real restart survival (D-07)** — `625f3e8` (feat)
2. **Task 2: Containment audit — D-08, D-01, D-12, D-04** — `8f09b89` (feat)

**Plan metadata:** this SUMMARY commit (docs).

TDD: Task 1's eight tests were written first and failed on the missing exports (`interruptedTasks` not found; 0 pass / 1 fail), then passed after tasks.ts/main.ts (one test iteration: the fake's pending prompt must not be awaited for the task that is meant to stay in flight). The `beginShutdown` test was added RED after the live restart exposed the gap, then GREEN. Task 2's audit.test.ts was written against the absent module (import error) and passed on the first run of audit.ts after two semantic fixes made while writing it (one violation per bind; missing label is one violation).

## Files Created/Modified

- `packages/host/src/tasks.ts` — `TaskRecord.resumes`/`stale_approvals`, `withResumeDefaults`, `interruptedTasks`, `RESUME_TEXT`, `TaskService.resumedThisBoot`/`stopping`, `beginShutdown`, `resumeInterrupted`, shutdown-aware `startPrompt` catch.
- `packages/host/src/main.ts` — `resumeInterrupted()` after the client is ready; `service.beginShutdown()` first thing in the signal handler.
- `packages/host/src/tasks.test.ts` — typed `prompts`/`sequence` recorders in the harness, `promptRejectsFor`/`modelRouteThrowsFor`, `taskRecord` factory, `interruptedTasks` and `resumeInterrupted` suites (8 tests incl. the legacy-record TaskStore test and the shutdown test).
- `packages/host/src/api.test.ts` — status fixture carries the two new fields (type error otherwise).
- `packages/host/src/audit.ts` — the audit module and CLI.
- `packages/host/src/audit.test.ts` — 11 tests over the pure functions and the formatter.
- `.planning/phases/03-lane-a/03-06-SMOKE.md` — Task 1 restart evidence, Task 2 audit evidence, Retained, Gaps.

## Decisions Made

See key-decisions. None changes a D-05..D-16 contract; `beginShutdown` and the two `containerViolations` semantics were forced by observation (the restart's journal; the "one named violation each" behavior bullets).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] api.test.ts status fixture no longer typed as TaskStatus**
- **Found during:** Task 1 (tsc: the literal lacked `resumes`/`stale_approvals`)
- **Fix:** the fixture carries both fields at 0.
- **Files modified:** packages/host/src/api.test.ts
- **Verification:** tsc-exit=0
- **Committed in:** 625f3e8

**2. [Rule 2 - Missing critical] Prompt rejections during shutdown must not fail the task**
- **Found during:** Task 1, reading the restart's journal: rivet logged `agent-os prompt action failed sessionId=n1 error=SidecarProcessExited` and `websocket not available for sending` at SIGTERM. The host never received that rejection, so the record stayed in flight and was resumed — but had it arrived, `startPrompt`'s catch would have written `exit_code=1` and D-07's "every interrupted task gets one continuation" would silently fail.
- **Fix:** `TaskService.beginShutdown()` sets `stopping`; the catch logs `prompt interrupted by shutdown` and leaves the record untouched while stopping. main.ts calls it before `server.close()`/`registry.shutdown()`.
- **Files modified:** packages/host/src/tasks.ts, packages/host/src/main.ts, packages/host/src/tasks.test.ts (one test: rejected after beginShutdown → still in flight; without it → exit_code 1)
- **Verification:** tasks.test.ts 36 pass; the flag was set on the live restart (handler ran) but no rejection was delivered to exercise it end to end (recorded in SMOKE Gaps).
- **Committed in:** 625f3e8

---

**Total deviations:** 2 auto-fixed (Rule 1: 1, Rule 2: 1).
**Impact on plan:** no contract changed; deviation 2 closes a D-07 hole the plan's own must-have describes.

## Issues Encountered

- **Clean stop does not complete under an in-flight turn.** `registry.shutdown()` hung (`stopping all actors due to envoy lost threshold` after 15 s) until systemd's `TimeoutStopSec=15` SIGKILLed the unit (`Failed with result 'timeout'`); the sandbox container outlived the process and the boot sweep removed it by label (`orphan sandboxes removed: 1`). Restart took 16 s instead of ~2 s. The unit file is 03-03's and unchanged here; logged to deferred-items.md.
- **Kill of a resumed session settles through a storage error.** The continuation prompt of the restart task rejected during `kill`'s cancel/unload with `session_storage_error: … transaction lease is invalid`; the record was already being marked released and ended `released=true`, `exit_code=1`, `last_stop_reason=killed`, claim released. The second task's kill (not restarted) behaved as in 03-03/03-04.
- **The harness shell's builtin `grep` drops output for `-oE '^ *[0-9]+ pass$'`.** The plan's `<automated>` commands were therefore run verbatim under `/bin/bash` (extracted from the PLAN lines to `/tmp/03-06-t{1,2}-verify.sh`); both exit 0.

## Threat Flags

None beyond the plan's register. audit.ts holds substrate.env values in memory only inside the transient unit (T-03-06-03) and its output is a formatter pinned by a test to `key=value` names, modes and integers; the CLI runs `docker ps`/`docker inspect` read-only.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- 03-08 (approvals) can answer the new `permission_request` a resumed turn raises; `stale_approvals` tells the approver how many requests died with the old turn, and `pending_approvals` holds only live ones (T-03-06-02).
- 03-10's proof restart step can reuse the Task 1 procedure: expect `[substrate-host] resumed <gid>/n1 key <gid>:n1:resume:1` within ~1 s of the API coming up and a new event within ~10 s; budget ~16 s for the restart itself while the unit's stop timeout stands.
- The audit CLI is rerunnable for the proof: `sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env -p WorkingDirectory=…/packages/host -E HOME=/root /usr/bin/node src/audit.ts --sandbox-net published_loopback`; once `SUBSTRATE_APPROVAL_BOT_TOKEN` lands in substrate.env it is scanned automatically (TOKEN segment).
- Dispatch stayed off throughout; STATE.md and ROADMAP.md untouched by this plan (orchestrator-owned).

## Self-Check: PASSED

- FOUND: packages/host/src/tasks.ts, tasks.test.ts, main.ts, api.test.ts, audit.ts, audit.test.ts, .planning/phases/03-lane-a/03-06-SMOKE.md
- FOUND: commits 625f3e8, 8f09b89 (`git log --oneline --all`)
- Task 1 and Task 2 `<automated>` verify commands re-run on the committed tree under /bin/bash: exit 0 each; root suite 298 pass / 0 fail, tsc-exit=0, dispatcher 149 passed
- `substrate-host` active (restarted twice by this plan, last boot 15:13:13 UTC), `substrate-dispatcher` active, 0 labelled containers, both throwaway worktrees and branches gone, probe and opener deleted, main checkout on `main`, switch's last line `=1`, `.planning/config.json`, `.planning/state.json` and `issues/` left unstaged
