---
phase: 03-lane-a
plan: 07
subsystem: infra
tags: [substrate-host, claude-code, git, gh, notion, linear, ultrathink-sync, d-08, d-10, hostfns, sync]

requires:
  - phase: 03-lane-a
    provides: 03-01 route_choice=a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn, tracker_route=host, c_push_hostfn=yes; 03-03 hostCallTarget, TaskRecord/TaskStore/TaskService, substrate collection in vm.ts, worktreeFor; 03-04 trackerRoute, seeded ultrathink-state.json, HOOK_INPUT_FILE, the proxy's guards on vm_mcp; 03-06 withResumeDefaults pattern for older records
  - phase: 02-claims-and-dispatch
    provides: 02-NOTION-SCHEMA.md (data source be3418f0…, Level/Graph ID, PR URL/PR #/PR State/Repo/Branch types), D-06/D-07 (Done only via graph_complete; sync owns the PR fields), dispatcher _origin_matches rule
provides:
  - hostfns.ts: commitArgv (add -A with `:(exclude,glob)**/.substrate-*`), pushArgv, prCreateArgv, scratchPaths, originMatches, checkScratch, execFileRunner; executors gitPush (branch/origin/scratch guards, never --force), prCreate (one PR per task, pr_url/pr_number recorded), commit; PR_TITLE_MAX 256, PR_BODY_MAX 20 000, COMMIT_MESSAGE_MAX 2 000
  - vm.ts: `agentos-substrate git-push | pr-create | sync` on every route and `commit` on c:hostfn_commit, all through hostCallTarget, run on the host with execFile (no shell, 120 s, HOME=/root)
  - sync.ts: SYNC_WRITABLE, NotionSync (Task-row query + PATCH limited to the five PR fields), LinearLink (attachmentLinkURL after a one-time read-only introspection, attachmentCreate fallback), HostSync.syncPr / verifyModelSync, syncTask (the sync host function's executor)
  - tasks.ts: TaskRecord.pr_url / pr_number / synced_at / sync_by (withRecordDefaults for older records), HostSyncLike, TaskService.backstopSync on turn settle (vm_mcp: verify → model_mcp else host; host: host; once per task)
  - seed.ts: prompt step (4) names the c-route commit, git-push, pr-create and the tracker-route sync sentence (vm_mcp: in-VM ultrathink-sync through the notion/linear servers; host + b:hooks/prompt_hostfn: agentos-substrate sync; b:host_after_turn: none)
  - main.ts: HostSync built from the unit's NOTION_API_KEY / LINEAR_API_KEY (journal line `sync: notion on, linear on`)
  - 03-07-SMOKE.md — observed: VM commit landed on the host worktree with the scratch file untracked, guard clear then refused, dry-run push and gh auth in the unit's environment without GH_TOKEN, Notion Task row found and Linear attachmentLinkURL present (read-only), all seven substrate host functions listed from inside a VM, sync refusing without a recorded PR
affects: [03-08, 03-09, 03-10]

actuals:
  tokens: 25195      # chars/4 over the b77f428..2ffec9f diff (12 files, +1754/-7)
  tasks: 2
  commits: 2         # git rev-list --count b77f4280a85c5301fb81bfaf5dd000b66b4cec49..HEAD
plan_head_before: b77f4280a85c5301fb81bfaf5dd000b66b4cec49

tech-stack:
  added: []
  patterns:
    - "Host functions that spend a credential are pure argv builders plus an executor with an injected runner; the guest supplies only text within a length limit, and worktree, branch, remote, repo and base come from the actor key and graph_get"
    - "Guards run before the network: HEAD branch, origin URL (the dispatcher's rule) and the scratch-file diff against origin/<base> each refuse with a reason before any push argv exists"
    - "Tracker writes on the host are a closed property set (SYNC_WRITABLE) checked before any request, the Linear half is the one attachment mutation, and both halves report their own outcome so a Notion failure never blocks the Linear link"
    - "sync_by names who wrote the PR fields (model | model_mcp | host); the backstop runs once per task on turn settle and verifies read-only before it writes on vm_mcp"

key-files:
  created:
    - packages/host/src/hostfns.ts
    - packages/host/src/hostfns.test.ts
    - packages/host/src/sync.ts
    - packages/host/src/sync.test.ts
    - .planning/phases/03-lane-a/03-07-SMOKE.md
  modified:
    - packages/host/src/vm.ts
    - packages/host/src/tasks.ts
    - packages/host/src/seed.ts
    - packages/host/src/main.ts
    - packages/host/src/seed.test.ts
    - packages/host/src/tasks.test.ts
    - packages/host/src/api.test.ts

key-decisions:
  - "git-push, pr-create and sync are registered on `agentos-substrate` whatever the s: channel (03-04's run-tests precedent): no MCP path exists for them, and `substrate:*` already admits them"
  - "The push guard refuses when the diff against origin/<base> cannot be computed, not only when it lists a scratch path — an unknown branch state never pushes"
  - "pr-create records pr_url/pr_number only from a URL gh printed for the graph's own repo; the sync host function accepts exactly that URL (T-03-07-04)"
  - "The backstop sets synced_at after one run whatever the trackers answered, so a later settle never repeats it; a failed half is logged as `sync result … notion …, linear …`"
  - "The c:vm_git install and the c:sandbox_git shim did not run on this host's c:hostfn_commit route: 03-01 showed the git package's binaries unexecutable and a file placed under the VM not a registered command, so both branches need their own spike before they can be seeded"
  - "SyncError assigns its status in the constructor body: a parameter property is not erasable and the first redeploy died on it (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX)"

patterns-established:
  - "Live evidence for a write-capable host function without the write: exercise its guards host-side through the same module with the real runner, run the credentialed command with --dry-run inside the unit's own transient environment, and list the registered functions from inside the VM"

requirements-completed: []

coverage:
  - id: D1
    description: "Argv builders and executors for commit, push and PR: fixed worktree/branch/remote/repo/base, length limits, scratch exclusion, branch/origin/scratch guards before any push, one PR per task with pr_url/pr_number recorded, node-without-record refused"
    verification:
      - kind: unit
        ref: "bun test packages/host/src/hostfns.test.ts (17 pass, 0 fail, no rivet import)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A VM session's commit reaches the host worktree through `agentos-substrate commit` with the scratch file left untracked; the push guard clears the clean branch and refuses a forced scratch commit; the dry-run push and `gh auth status` succeed in a transient unit carrying only substrate.env and HOME=/root (no GH_TOKEN/GITHUB_TOKEN in the file or the unit's environment); the smoke worktree and branch are removed"
    verification:
      - kind: integration
        ref: "03-07-SMOKE.md § Task 1: vm_commit_on_host=true, scratch_in_commit=false, push_guard=clear (indented: refused on the forced commit), push_env=systemd-run, push_dry_run_exit=0, gh_auth_unit_env=ok, gh_token_in_env_file=0, smoke_worktree_removed=true; Task 1 <automated> verify exit 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "Sync module: one Task-row query + one PATCH of exactly the five PR fields; no_task_row / failed:<status> with the Linear half still running; one attachment mutation, never issueUpdate or stateId; SYNC_WRITABLE enforced before any request; keys never in results, logs or errors; verifyModelSync read-only; sync host function rejects a foreign URL and records sync_by model; backstop on vm_mcp (verify → model_mcp else host) and host (host), once per task"
    verification:
      - kind: unit
        ref: "bun test packages/host/src/sync.test.ts (10 pass, 0 fail, no rivet import)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Prompt step (4) names the c-route commit, then git-push and pr-create before graph_complete, and the tracker-route sync sentence (vm_mcp: SKILL.md + stateFile + notion/linear servers, PR fields only, never Done, no agentos-substrate sync; host: SKILL.md + agentos-substrate sync --node on b:hooks/prompt_hostfn; nothing on b:host_after_turn) on all 54 routes"
    verification:
      - kind: unit
        ref: "bun test packages/host/src/seed.test.ts (21 pass, 0 fail; 3 new)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Live on tracker_route host: the unit boots with sync on for both trackers and no key material in its journal; the backfilled graph's Notion Task row is found by the Level/Graph ID query; Linear's Mutation type exposes attachmentLinkURL; `agentos list-host-functions substrate` inside a VM lists git-push, pr-create, commit and sync with their flags; `agentos-substrate sync` refuses without a recorded PR; no tracker write"
    verification:
      - kind: integration
        ref: "03-07-SMOKE.md § Task 2: notion_task_row_found=true, linear_attach_mutation=attachmentLinkURL, b_route=prompt_hostfn, tracker_route=host, verify_model_sync=skipped (indented false_as_expected), sync_hostfn_registered=true; Task 2 <automated> verify exit 0"
        status: pass
    human_judgment: false
  - id: D6
    description: "Root suite and tsc two-sided green against 03-BASELINE.md; dispatcher unchanged"
    verification:
      - kind: other
        ref: "bun test 328 pass / 0 fail (baseline 167, re-measured 298 before the first edit); tsc-exit=0; pytest 149 passed"
        status: pass
    human_judgment: false

duration: 22min
completed: 2026-09-25
status: complete
---

# Phase 3 Plan 07: Commit, push, PR and sync host functions Summary

**A VM session can now commit, push and open a PR without any GitHub credential leaving the host — `agentos-substrate commit | git-push | pr-create` run `git`/`gh` on the host worktree with the owner's stored credential helper, every target fixed by the actor key and `graph_get`, `.substrate-*` scratch files excluded from the commit and refused by the push guard — and after the PR opens the host writes only PR URL, PR #, PR State (Open), Repo and Branch on the Notion Task row and the PR link on the Linear issue (D-10 on `tracker_route=host`: the model's `agentos-substrate sync` or the turn-settle backstop, `sync_by` recorded), with Done still coming only from `graph_complete`; live, a throwaway VM's commit landed on the host worktree with the scratch file untracked, the guard cleared it and refused a forced scratch commit, the dry-run push and `gh auth status` succeeded in a transient unit carrying only substrate.env (no GH_TOKEN anywhere), the Notion Task row and Linear's `attachmentLinkURL` were confirmed read-only, and a VM listed all seven substrate host functions.**

## Performance

- **Duration:** 22 min
- **Started:** 2026-09-25T15:30:12Z
- **Completed:** 2026-09-25T15:52:35Z
- **Tasks:** 2
- **Files modified:** 12 (5 created, 7 modified)

## Baselines (two-sided, against 03-BASELINE.md)

| Suite | 03-BASELINE (2df112c) | Re-measured at b77f428 before the first edit | After Task 1 (40f0d7b) | After Task 2 (2ffec9f) |
|---|---|---|---|---|
| agent-substrate bun test | 167 pass, 0 fail | 298 pass, 0 fail | 316 pass, 0 fail (+17 hostfns, +1 seed) | 328 pass, 0 fail (+10 sync, +2 seed) |
| tsc (normalized) | tsc-exit=0 | tsc-exit=0 | tsc-exit=0 | tsc-exit=0 |
| dispatcher pytest | 114 passed | 149 passed | — | 149 passed (no Python touched) |

No failing-id set differed from the baseline in either direction at any gate.

## Accomplishments

- **hostfns.ts (T-03-07-01/05/07):** `pushArgv` is exactly `git -C <worktree> push origin substrate/<gid>`; `prCreateArgv` is `gh pr create --repo <graph repo> --head substrate/<gid> --base <graph branch> --title … --body …` with the 256/20 000 limits and slug/base validation; `commitArgv` is `git add -A -- . :(exclude,glob)**/.substrate-*` then `git -c user.name=… -c user.email=… commit -m …` (2 000 limit, no leading `-`); `scratchPaths` keeps paths whose last segment starts with `.substrate-`; `checkScratch` runs `git diff --name-only origin/<base>...HEAD` and refuses with "branch contains substrate scratch files: …" (or with the diff's own failure). `gitPush` checks HEAD, origin (`originMatches`, the dispatcher's rule) and the scratch diff before the push; `prCreate` returns the recorded URL without running gh, else records the URL gh printed for the graph's repo; `commit` runs the two argvs and returns the sha. `execFileRunner` is execFile with an argv, 120 s, HOME=/root; results carry only exit codes, a redacted 400-char tail and the URL/sha.
- **vm.ts:** `gitCollection` registers `git-push`, `pr-create` (and `commit` on c:hostfn_commit) and `sync` on the `substrate` collection whatever the s: channel, each through `hostCallTarget` with a 130 s timeout; the guest passes only `--node`, `--title`, `--body`, `--message`, `--pr-url` (Zod-limited).
- **sync.ts (T-03-07-03/04/06):** `NotionSync.findTaskRow` (POST `/v1/data_sources/<ds>/query`, `Level = Task ∧ Graph ID = gid`, page_size 1; Notion-Version 2025-09-03) and `updateTaskRow` (PATCH with only SYNC_WRITABLE, refused before any request otherwise); `LinearLink.attachMutation` (one cached `__type(name: "Mutation")` read), `attachments` (read-only), `attachLink` (`attachmentLinkURL`, else `attachmentCreate`; identifier → id resolved read-only); `HostSync.syncPr` never throws and reports `updated | no_task_row | failed:<status>` and `attached | no_issue_ref | failed:<status>`; `verifyModelSync` reads both trackers and never writes; `syncTask` refuses a `--pr-url` that is not the recorded one and, after a run with no failed half, records `synced_at` and `sync_by: "model"`. Keys never appear in results, logs or messages (bodies are redacted and capped at 200 characters).
- **tasks.ts:** `TaskRecord.pr_url / pr_number / synced_at / sync_by` (older records default through `withRecordDefaults`); `backstopSync` runs from both settle paths of `startPrompt`: pr_url set and synced_at null → on vm_mcp `verifyModelSync` first (both true → `sync by model (mcp) for <gid>/<nid>`, no write), otherwise/on host `syncPr` once (`sync by host for <gid>/<nid>` + a result line); a second settle is a no-op.
- **seed.ts:** step (4) now reads `<tests> <commit per c-route>; never add files whose names start with .substrate- to a commit. Then push with agentos-substrate git-push --node … and open the pull request with agentos-substrate pr-create --node … --title … --body … (…once…)` followed by the sync sentence: vm_mcp → read `/home/agentos/.claude/skills/ultrathink-sync/SKILL.md`, run it with `stateFile=/home/agentos/.substrate/ultrathink-state.json` and `prUrl=<the PR URL>` through the notion and linear MCP servers, PR fields only, no Linear state change, never Done; host + b:hooks/prompt_hostfn → apply the same SKILL through `agentos-substrate sync --node <nid> --pr-url <url>`; b:host_after_turn → nothing.
- **Live (route `c:hostfn_commit`, `tracker_route=host`):** graph `ut-d09f05d6smk-62523d4b`: the probe wrote `smoke-03-07.txt` and `.substrate-hook-input.json` in the VM's `/home/agentos/work` and ran `agentos-substrate commit --node n1 --message "03-07 smoke"` → `{"committed":true,"sha":"7e88835…"}`; on the host `git log -1` printed `03-07 smoke`, the commit held only `smoke-03-07.txt`, the scratch file stayed `??`; `checkScratch` with the real runner: `clear`, then `refused` ("branch contains substrate scratch files: .substrate-hook-input.json") after a forced `git add -f` commit (reset afterwards); `git push --dry-run` exit 0 and `gh auth status` exit 0 under `systemd-run -p EnvironmentFile=/etc/substrate/substrate.env -E HOME=/root` (GH_TOKEN/GITHUB_TOKEN lines in substrate.env: 0 + 0; the unit's `env` had none); `ls-remote` showed no `substrate/<gid>` on origin. Graph `ut-8a6b17d8smk-6e810294`: `agentos list-host-functions substrate` from the VM listed `issue-get, release, complete, git-push, pr-create, commit, sync`; `agentos-substrate sync --node n1 --pr-url …/pull/0` → "no pull request recorded for this task yet (run pr-create first)"; `--node n9` → hostCallTarget's refusal. In the unit's environment: `notion_task_row_found=true` for `ut-mucem4mc-ec70360f` (PR URL null), `linear_attach_mutation=attachmentLinkURL`, `verifyModelSync` false on both halves for `…/pull/0`. Both tasks killed, both worktrees and branches removed, 0 labelled containers, journal since the boot free of key material, switch's last line `=1`.

## Task Commits

1. **Task 1: Commit, push and PR host functions per the c-route, and the prompt steps that use them** — `40f0d7b` (feat)
2. **Task 2: Sync (D-10) by the evidence-selected route — host-side sync, PR fields and the Linear PR link only** — `2ffec9f` (feat)

**Plan metadata:** this SUMMARY commit (docs).

TDD: hostfns.test.ts was written first (RED: `Cannot find module './hostfns.ts'`, 0 pass / 1 fail), then hostfns.ts + the TaskRecord fields (GREEN: 17 pass on the first run). sync.test.ts was written first (RED: module missing), then sync.ts, tasks.ts's backstop, vm.ts and seed.ts (GREEN: 89 pass across the five host test files on the first run). One live iteration each: Task 1's verify needed the literal `"commit"` registration key in vm.ts; Task 2's first redeploy died on a non-erasable parameter property in `SyncError`.

## Files Created/Modified

- `packages/host/src/hostfns.ts` — the argv builders, guards, runner and executors (above).
- `packages/host/src/hostfns.test.ts` — 17 tests: builders, scratch guard, gitPush (clean push, wrong branch, wrong origin, no record / no graph, failed push), prCreate (record, idempotent, limits, gh failure / wrong-repo URL), commit (two argvs + sha, limits / failure).
- `packages/host/src/sync.ts` — `SYNC_WRITABLE`, `syncProperty`, `NotionSync`, `LinearLink`, `HostSync`, `syncTask`, `SyncError`.
- `packages/host/src/sync.test.ts` — 10 tests: the six syncPr bullets, verifyModelSync, the sync host function, the vm_mcp and host backstops (through a real `TaskService` with fakes).
- `packages/host/src/vm.ts` — `gitCollection` (git-push, pr-create, commit, sync), `HostVmConfig.sync`.
- `packages/host/src/tasks.ts` — record fields, `withRecordDefaults`, `SyncBy`, `HostSyncLike`, `TaskServiceDeps.sync`, `backstopSync`.
- `packages/host/src/seed.ts` — `commitStep`, `pushAndPrStep`, `syncStep`, `VM_SYNC_SKILL`.
- `packages/host/src/main.ts` — `HostSync` from `NOTION_API_KEY` / `LINEAR_API_KEY`, passed to the service and the VM; boot line `sync: notion on|off, linear on|off`.
- `packages/host/src/seed.test.ts` (+3), `tasks.test.ts`, `api.test.ts`, `hostfns.test.ts` — fixtures carry the four new record fields.
- `.planning/phases/03-lane-a/03-07-SMOKE.md` — Task 1 and Task 2 evidence, Retained, Gaps.

## Decisions Made

See key-decisions. None changes a D-05..D-16 contract; the c:vm_git / c:sandbox_git branches stayed unexecuted by the plan's own route rule ("c:hostfn_commit → only the host function") and are recorded in the SMOKE Gaps with the 03-01 findings that make them non-trivial.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `pr_url` / `pr_number` landed with Task 1**
- **Found during:** Task 1 (prCreate must record the PR on the task record; the plan lists the fields under Task 2)
- **Fix:** `TaskRecord.pr_url` / `pr_number` (+ `withRecordDefaults`, renamed from `withResumeDefaults`) in Task 1; `synced_at` / `sync_by` in Task 2 as planned. The three record fixtures (tasks.test.ts, api.test.ts, hostfns.test.ts) carry the fields (tsc would fail otherwise, as in 03-06).
- **Files modified:** packages/host/src/tasks.ts, tasks.test.ts, api.test.ts
- **Committed in:** 40f0d7b (Task 1), 2ffec9f (Task 2)

**2. [Rule 1 - Bug] `SyncError` used a constructor parameter property**
- **Found during:** Task 2 redeploy (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX … strip-only mode`; the unit stayed `activating` and exited 1)
- **Fix:** the status is assigned in the constructor body; both modules load under `node --experimental-strip-types`; second restart clean (`sync: notion on, linear on`).
- **Files modified:** packages/host/src/sync.ts
- **Committed in:** 2ffec9f

**3. [Rule 1 - Bug] `commit` registration key not greppable**
- **Found during:** Task 1 `<automated>` verify (`grep -q '"commit"' packages/host/src/vm.ts` failed on `functions.commit = …`)
- **Fix:** `functions["commit"] = …` with the CLI name in a comment; the same function, same name.
- **Files modified:** packages/host/src/vm.ts
- **Committed in:** 40f0d7b

---

**Total deviations:** 3 auto-fixed (Rule 1: 2, Rule 3: 1).
**Impact on plan:** no contract changed. The D-10 deviation the plan anticipates (host-side sync on `tracker_route=host`) is what this host runs; 03-10 records it as `sync_by`.

## Issues Encountered

- `agentos-substrate pr-create --help` inside the VM answers `Unknown flag: --help` (the sidecar's flag parser, not a registration failure); `agentos list-host-functions substrate` is the reliable listing and was used for `sync_hostfn_registered`.
- The first `systemctl restart` after Task 2's code took the 40 s health loop with no answer because the unit crash-looped on the parameter property (deviation 2); the second restart answered `/healthz` in 1 s.
- The harness shell's builtin `grep` drops output for `-oE '^ *[0-9]+ pass$'` (03-06), so both `<automated>` blocks were extracted verbatim to `/tmp/03-07-t{1,2}-verify.sh` and run under `/bin/bash`: exit 0 each.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: credentialed-hostfn | packages/host/src/hostfns.ts | git-push and pr-create spend the owner's PAT (admin:org, delete_repo) on the host at the guest's request; scope is pinned by fixed argvs, the branch/origin/scratch guards and Zod limits (T-03-07-01), and the first real push/PR is the proof's (03-10). |
| threat_flag: sync-once | packages/host/src/tasks.ts | The backstop marks a task synced after one run even when a tracker half failed (visible in the journal only); the PR fields can then be missing until the proof or an operator re-syncs. Recorded in SMOKE Gaps. |

## User Setup Required

None — substrate.env already holds NOTION_API_KEY and LINEAR_API_KEY (counted, not read); gh's stored credential answers git and gh from HOME=/root.

## Next Phase Readiness

- 03-10's proof can run `agentos-substrate git-push --node n1` then `pr-create` in the VM; the first real push and PR happen there, and the task record's `pr_url`, `pr_number`, `synced_at`, `sync_by` (expected `model` from the prompt's `agentos-substrate sync`, else `host` from the backstop on turn settle) are what it reads.
- The Notion write is one PATCH of the five PR fields on the Task row found by `Level = Task ∧ Graph ID`; the Linear write is one `attachmentLinkURL` — nothing else moves, so the DoD gate (graph_complete) stays the only path to Done.
- If `tracker_route` ever flips to vm_mcp, no code changes: the prompt names the in-VM sync, the backstop verifies read-only first and records `model_mcp`.
- Dispatch stayed off throughout; STATE.md and ROADMAP.md untouched by this plan (orchestrator-owned); `.planning/config.json`, `.planning/state.json` and `issues/` left unstaged.

## Self-Check: PASSED

- FOUND: packages/host/src/hostfns.ts, hostfns.test.ts, sync.ts, sync.test.ts, vm.ts, tasks.ts, seed.ts, main.ts, seed.test.ts, tasks.test.ts, api.test.ts, .planning/phases/03-lane-a/03-07-SMOKE.md
- FOUND: commits 40f0d7b, 2ffec9f (`git log --oneline --all`)
- Task 1 and Task 2 `<automated>` verify commands re-run on the committed tree under /bin/bash: exit 0 each; root suite 328 pass / 0 fail, tsc-exit=0, dispatcher 149 passed
- `substrate-host` active (last boot 15:50:13Z, `sync: notion on, linear on`), healthz `{"engine":true,"api":true}`, 0 labelled containers, both throwaway worktrees and branches gone (`git worktree list`: main + Phase 2's two), probe, sync-check and opener deleted, main checkout on `main`, switch's last line `=1`, no push, no PR, no Notion or Linear write, `.planning/config.json`, `.planning/state.json` and `issues/` left unstaged
