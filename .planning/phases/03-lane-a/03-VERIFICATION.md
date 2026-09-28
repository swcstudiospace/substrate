---
phase: 03-lane-a
verified: 2026-09-28T01:39:33Z
status: gaps_found
score: 82/91 must-haves verified (82 verified, 1 present but behaviour-unverified, 8 not verified — 7 under the owner's 2026-09-28 acceptance of Phase 3 without 03-10, override recorded, not applied; 1 live regression with no override)
covered_files:
  - .planning/phases/02-claims-and-dispatch/02-LINEAR-ARCHIVED.md
  - .planning/phases/03-lane-a/03-01-PLAN.md
  - .planning/phases/03-lane-a/03-01-SPIKE.md
  - .planning/phases/03-lane-a/03-01-SUMMARY.md
  - .planning/phases/03-lane-a/03-02-PLAN.md
  - .planning/phases/03-lane-a/03-02-SMOKE.md
  - .planning/phases/03-lane-a/03-02-SUMMARY.md
  - .planning/phases/03-lane-a/03-03-PLAN.md
  - .planning/phases/03-lane-a/03-03-SUMMARY.md
  - .planning/phases/03-lane-a/03-03-TRACER.md
  - .planning/phases/03-lane-a/03-04-PLAN.md
  - .planning/phases/03-lane-a/03-04-SMOKE.md
  - .planning/phases/03-lane-a/03-04-SUMMARY.md
  - .planning/phases/03-lane-a/03-05-PLAN.md
  - .planning/phases/03-lane-a/03-05-SUMMARY.md
  - .planning/phases/03-lane-a/03-05-TRACER.md
  - .planning/phases/03-lane-a/03-06-PLAN.md
  - .planning/phases/03-lane-a/03-06-SMOKE.md
  - .planning/phases/03-lane-a/03-06-SUMMARY.md
  - .planning/phases/03-lane-a/03-07-PLAN.md
  - .planning/phases/03-lane-a/03-07-SMOKE.md
  - .planning/phases/03-lane-a/03-07-SUMMARY.md
  - .planning/phases/03-lane-a/03-08-PLAN.md
  - .planning/phases/03-lane-a/03-08-SUMMARY.md
  - .planning/phases/03-lane-a/03-09-PLAN.md
  - .planning/phases/03-lane-a/03-09-SUMMARY.md
  - .planning/phases/03-lane-a/03-10-PLAN.md
  - .planning/phases/03-lane-a/03-BASELINE.md
  - .planning/phases/03-lane-a/03-CONTEXT.md
  - .planning/phases/03-lane-a/03-PROOF.md
  - infra/sandbox/Dockerfile
  - infra/vps/substrate-host.service
  - packages/dispatcher/src/substrate_dispatcher/__main__.py
  - packages/dispatcher/src/substrate_dispatcher/dispatch.py
  - packages/dispatcher/src/substrate_dispatcher/host.py
  - packages/dispatcher/src/substrate_dispatcher/launcher.py
  - packages/dispatcher/tests/test_dispatch.py
  - packages/dispatcher/tests/test_host.py
  - packages/dispatcher/tests/test_launcher.py
  - packages/dispatcher/tests/test_main.py
  - packages/dispatcher/tests/test_sessions.py
  - packages/host/package.json
  - packages/host/src/api.test.ts
  - packages/host/src/api.ts
  - packages/host/src/audit.test.ts
  - packages/host/src/audit.ts
  - packages/host/src/hostfns.test.ts
  - packages/host/src/hostfns.ts
  - packages/host/src/main.ts
  - packages/host/src/mcp-proxy.test.ts
  - packages/host/src/mcp-proxy.ts
  - packages/host/src/options.test.ts
  - packages/host/src/options.ts
  - packages/host/src/sandbox-options.test.ts
  - packages/host/src/sandbox-options.ts
  - packages/host/src/sandbox-provider.ts
  - packages/host/src/seed.test.ts
  - packages/host/src/seed.ts
  - packages/host/src/substrate.ts
  - packages/host/src/sync.test.ts
  - packages/host/src/sync.ts
  - packages/host/src/tasks.test.ts
  - packages/host/src/tasks.ts
  - packages/host/src/telegram.test.ts
  - packages/host/src/telegram.ts
  - packages/host/src/vm.ts
  - packages/mcp-server/src/linear.ts
  - packages/mcp-server/src/mcp.test.ts
  - packages/mcp-server/src/mcp.ts
  - packages/mcp-server/src/mirror.ts
  - packages/mcp-server/src/server.test.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/service.test.ts
  - packages/mcp-server/src/service.ts
covered_digest: "v1:sha256:6df6d5eacad96d4d8c9139a5de9b14f62dd555afdb8f17fdade586274b09e9c5"
covered_files_note: "Computed at HEAD 1806f27 with `query verification.fingerprint`. Covered: every 03-01..03-10 PLAN, every SUMMARY, the observed-evidence files (SPIKE, SMOKE, TRACER, BASELINE, PROOF), 03-CONTEXT (D-01..D-16), 02-LINEAR-ARCHIVED.md (03-09's D-14 record) and every non-.planning file that a `(03-0N)` commit touched (`git log --name-only --grep='(03-0[1-9]'`). Excluded: packages/host/package-lock.json (generated), ROADMAP.md and STATE.md (tracking logs the orchestrator edits), 03-RESEARCH, 03-PATTERNS, 03-VALIDATION, COVERAGE.md and deferred-items.md (not plan, summary or evidence inputs). 03-10-PLAN.md is covered because its must-haves are the undelivered proof folded into gap 3."
behavior_unverified: 1
overrides_applied: 0
owner_accept_overrides_recorded: 4 # on gaps 1–4 below; not applied — see "Why the status is gaps_found"
gaps:
  - truth: "SC3: the dispatcher routes dispatch:claude-code to a VM; permissionPolicy \"ask\" surfaces approvals to Telegram through the existing stop-notify path"
    status: partial
    override: "owner-accept 2026-09-28"
    owner_answer_verbatim: "Accept Phase 3 without 03-10"
    owner_answer_source: "STATE.md § Decisions, 2026-09-28 owner entry; STATE.md § Blockers, [Phase 3] 03-10 blocked by an owner decision (2026-09-26: keep telegram.ts and its wiring, leave approvals off)"
    reason: "The routing half is delivered: dispatch:claude-code is in DISPATCHABLE_SURFACES (dispatch.py:24), make_launch_fn opens the task on the host (dispatch.py:252-271 → host.py:152-175), and 03-05-TRACER observed launch → worktree → POST /tasks → claim as claude-code → a VM waiting on its first approval. That tracer called the launch path directly with a synthetic candidate; the label → 30 s poll → graph_find → tick leg was left to 03-10, which never ran. The approval half is not delivered: permissionPolicy is \"ask\" (tasks.ts:410) and the broker is built and tested, but there is no approval bot (sudo grep -c '^SUBSTRATE_APPROVAL_' = 0) and the live journal says `[substrate-host] telegram approvals off`. A VM permission request stays pending and nothing answers it."
    artifacts:
      - path: "/etc/substrate/substrate.env"
        issue: "0 SUBSTRATE_APPROVAL_* lines, so no bot token, chat or authorised user"
      - path: "substrate-host journal (boot 2026-09-26 15:09:58 UTC)"
        issue: "`telegram approvals off`; 0 `callback authorised` / `answered` lines ever"
    missing:
      - "A real labelled issue picked up by the running dispatcher tick (03-10 Task 1: trap-closed dispatch window, `launched claude-code for <identifier> …` journal line, Linear In Progress with agent:claude-code)"
      - "An approval route: the owner's dedicated bot and the three SUBSTRATE_APPROVAL_* keys (03-08 Task 2), or another route the owner picks"
  - truth: "SC4: claude-ultrathink runs inside the VM, so kickoff and sync still write Notion and Linear"
    status: partial
    override: "owner-accept 2026-09-28"
    owner_answer_verbatim: "Accept Phase 3 without 03-10"
    owner_answer_source: "STATE.md § Decisions, 2026-09-28 owner entry"
    reason: "Only partly true, and never observed end to end. 03-01's probe (b) found that claude-ultrathink's hooks do not fire under the rivet adapter and its skills load only by path (b_hooks=none, b_skills=no, b_skill_by_path=yes, b_claude_json_mcp=no), so the spike chose route b:prompt_hostfn, d11=unmet and tracker_route=host. That is the D-10 deviation: the four ultrathink skills and the tracker locators are seeded into the VM (03-03-TRACER, 03-04-SMOKE), but kickoff's Implementing write was made by the host in 03-09 (kickoff_by=host) and sync goes through the `agentos-substrate sync` host function or the host backstop (sync.ts, tasks.ts:496-529). The Notion/Linear MCP entries in the VM are seeded but inert (vm_tracker_mcp=inert, :7412 unserved). No Notion PR-field PATCH or Linear PR link has ever been written by a session: 03-07 touched both trackers read-only and the first write belonged to 03-10."
    artifacts:
      - path: "packages/host/src/sync.ts, packages/host/src/tasks.ts (backstopSync)"
        issue: "Built and pinned by sync.test.ts (SYNC_WRITABLE only, no issueUpdate/stateId), but never fired live; sync_by never recorded"
      - path: ".planning/phases/03-lane-a/03-PROOF.md"
        issue: "kickoff_by=host recorded; no kickoff_by_final, sync_by, sync_moved_state or notion_terminal_by_sync keys"
    missing:
      - "03-10 Tasks 2–3: the session's PR fields written to the Notion Task row and the PR link on the Linear issue, with sync_by recorded and the D-10 deviation (tracker_route=host, b:prompt_hostfn) written into 03-PROOF.md alongside 03-01's evidence"
  - truth: "Proof: a labelled issue opens a VM, the session survives a host restart, the PR lands and ultrathink-sync closes the loop"
    status: failed
    override: "owner-accept 2026-09-28"
    owner_answer_verbatim: "Accept Phase 3 without 03-10"
    owner_answer_source: "STATE.md § Decisions, 2026-09-28 owner entry; ROADMAP Phase 3 Plans line (03-10 blocked, 2026-09-26)"
    reason: "Not run. 03-PROOF.md has only 03-09's § Setup (SWC-480, graph ut-muhk8v3p-47ae5f1a, pr_lands_decision=i, approvals=off) and an empty `## Gaps`; there is no restart_survived= key and no 03-10 commit. Live: GET 127.0.0.1:7411/tasks lists 12 throwaway tasks, all unloaded, none for ut-muhk8v3p-47ae5f1a and none with a pr_url. Parts of the proof were observed outside it on throwaway graphs: restart survival (03-06-SMOKE restart_survived=true, same session n1, seq 2→4, brief sha equal, `resumed …:n1:resume:1`), the VM commit landing on the host worktree and a dry-run push in the unit's environment (03-07-SMOKE). A real push, a real PR and a Greptile review never happened."
    artifacts:
      - path: ".planning/phases/03-lane-a/03-PROOF.md"
        issue: "Setup only; the proof body and its keys (restart_survived=, sync_by=, answered lines) are absent"
      - path: "packages/host/src/hostfns.ts (git-push, pr-create)"
        issue: "Pinned by hostfns.test.ts; live only as `--dry-run` push; pr-create never invoked"
    missing:
      - "03-10 in full: label SWC-480 inside a trap-closed dispatch window, VM via the dispatcher, `systemctl restart substrate-host` under a waiting turn with the D-07 observations, Approve and Deny round-trips, the real push and pr-create (PR plus Greptile review, pr_lands_decision=i), sync, completion through the DoD gate (D-06/D-07), dispatch back off"
      - "Before any revival: rebuild substrate-sandbox:0.1 and protect it from the daily prune (gap 5)"
  - truth: "03-08 (D-13): the owner's dedicated approval bot is configured (three SUBSTRATE_APPROVAL_* keys once each), the host logs `telegram approvals on (bot @<username>)`, and a live Bot API smoke (getMe, sendMessage with an inline keyboard, 60 s long-poll without 409) passes"
    status: partial
    override: "owner-accept 2026-09-28"
    owner_answer_verbatim: "Accept Phase 3 without 03-10"
    owner_answer_source: "STATE.md § Decisions, 2026-09-28 owner entry; the 03-08 Task 2 checkpoint answer \"skip\" (03-08-SUMMARY.md § Outcome)"
    reason: "03-08 closed partial. Task 1 is delivered and tested (telegram.ts: two-button Approve/Deny, authorised callbacks, single-use keys, the authorised → answered log contract, redaction, token scrubbing; 10 tests pass). Task 2 was skipped by the owner and Task 3 did not run, so 03-08-SMOKE.md does not exist. The approvals-on path (main.ts:237) has never run."
    artifacts:
      - path: ".planning/phases/03-lane-a/03-08-SMOKE.md"
        issue: "does not exist (Task 3 not run)"
      - path: "/etc/substrate/substrate.env"
        issue: "0 SUBSTRATE_APPROVAL_* lines"
    missing:
      - "03-08 Task 2: the owner creates the bot and appends SUBSTRATE_APPROVAL_BOT_TOKEN, _CHAT_ID and _USER_IDS"
      - "03-08 Task 3: guarded restart, `telegram approvals on (bot @…)`, getMe, sendMessage with a keyboard, a 60 s long-poll with no 409"
  - truth: "Derived from the goal, SC2 and D-02 (live): the sandbox image the host names (SANDBOX_IMAGE = substrate-sandbox:0.1) exists on the host, so a new task can start its sandbox"
    status: failed
    reason: "The image is gone. `docker image inspect substrate-sandbox:0.1` returns `No such image`, and so does its base node:24-bookworm-slim. /etc/cron.d/docker-image-prune (root, dated 2026-06-23, predating Phase 3) runs `docker image prune -af --filter \"until=24h\"` daily at 02:29, which removes every image older than 24 h that no container is using. The sandbox image is in use only while a VM runs. VMs still started on 2026-09-26 (04-06 live VM check after the 09:08:49Z restart), so the image was most likely removed at the 2026-09-27 02:29 run [INFERENCE: the removal itself is not in any log I can read]. sandbox-provider.ts creates containers from SANDBOX_IMAGE with no pull or build fallback. Any new session, including a revived 03-10, would fail at sandbox creation until the image is rebuilt. This is not covered by the owner's acceptance, which covers the unrun 03-10 and approvals, not a regression in delivered 03-01..03-09 behaviour."
    artifacts:
      - path: "docker image substrate-sandbox:0.1"
        issue: "absent (built by 03-01 on 2026-09-25, sha256:2063de59…)"
      - path: "/etc/cron.d/docker-image-prune"
        issue: "daily `docker image prune -af --filter until=24h` removes the idle sandbox image"
      - path: "packages/host/src/sandbox-options.ts:8, sandbox-provider.ts:94"
        issue: "SANDBOX_IMAGE is a local tag with no pull or build step"
    missing:
      - "Rebuild the image under D-03's disk gate (03-01-SPIKE § Image command: `docker buildx build --load --build-context ultrathink=/root/.claude/plugins/cache/ultrathink/ultrathink/0.3.0 -t substrate-sandbox:0.1 infra/sandbox`)"
      - "Stop the prune removing it (for example a `--filter label!=…` on the cron line with a label added in infra/sandbox/Dockerfile, or a host-side presence check at boot that fails loudly)"
behavior_unverified_items:
  - truth: "03-03: ensureModelRoute is awaited before sessions.open and before every prompt; it starts the model relay on a:hostfn_proxy and is a no-op otherwise"
    test: "Deploy with SUBSTRATE_HOST_ROUTE on a:hostfn_proxy (or add a test around createEnsureModelRoute with a fake relay), open a task, and restart the host with a task in flight"
    expected: "`[substrate-host] model relay started` before the first prompt and again after a restart, before the resume prompt; the session's first model call reaches the relay"
    why_human: "The ordering is pinned by tasks.test.ts ('ensureModelRoute awaited before sessions.open and every prompt'), but the relay-start branch (vm.ts:347-355) imports rivet, has no test, and never ran live because the deployed route is a:loopback"
---

# Phase 3: Lane A Verification Report

**Phase Goal:** Sandboxed, durable Claude Code sessions, one VM per Graph ID.
**Verified:** 2026-09-28T01:39:33Z (HEAD 1806f27)
**Status:** gaps_found
**Re-verification:** No — initial verification (no earlier 03-VERIFICATION.md)

The goal is delivered in code and was observed working in pieces on throwaway graphs, but the phase
proof never ran. 03-01 to 03-09 built substrate-host (its own unit, rivet engine and API on
127.0.0.1). It claims, briefs, seeds and opens one VM per Graph ID with `permissionPolicy: "ask"`.
The dispatcher routes `dispatch:claude-code` to it. A VM session survived a live host restart. The
VM commits, pushes and opens PRs only through host functions, and sync writes only PR fields. Every
claim below comes from the code, a test I or a worker re-ran, or a key=value line in a
SPIKE/SMOKE/TRACER file.

The owner kept Telegram approvals off (03-08 closed partial, "skip"; STATE Blockers 2026-09-26). On
2026-09-28 the owner answered **"Accept Phase 3 without 03-10"**. Everything that only 03-10 would
have shown is therefore a gap. Each carries `override: owner-accept 2026-09-28`, and none is marked
passed. Those items are: the label → tick leg and Telegram approvals (SC3), in-VM kickoff and sync
writing the trackers (SC4), the end-to-end Proof, and 03-08's bot.

There is one more gap the owner has not accepted. **The sandbox image `substrate-sandbox:0.1` is no
longer on the host.** A daily root cron prunes idle images, so no new Lane A task can start a
sandbox until the image is rebuilt (gap 5, Note N1).

## Why the status is gaps_found

I applied the rule the Phase 5, 6 and 7 verifiers used (07-VERIFICATION.md § Why the status is
gaps_found):

1. **The items are not verified.** 03-10 has no commit and 03-PROOF.md has no proof body. 03-08
   records `status: partial`. Unverified items are gaps, and gsd-verifier Step 9 rule 1 makes any gap
   `gaps_found`.
2. **The overrides guide excludes this case.** An override counts only once it becomes `PASSED
   (override)`. The guide's "When NOT to Use" list names "The implementation is simply incomplete",
   and also warns against overriding more than 2–3 items in bulk. The proof is unrun, not an
   alternative implementation. The owner's words accept the phase *without* 03-10. That is the same
   kind of answer as Phase 6's "Accept gaps, continue", which the orchestrator recorded as
   `phase6-verification=accepted` on top of a `gaps_found` report. It does not declare the proof
   done.
3. **No later phase takes the work (Step 9b).** Phases 4–8 do not mention the Lane A proof,
   approvals, or `dispatch:claude-code` routing. 04-06 only adds read-only skill mounts to new VMs.
   Nothing moves to a deferred list.
4. **Gap 5 has no owner answer at all.** It is a live regression found during this verification,
   after the owner's acceptance.

The owner-accept annotations stay on the gap entries and are not in a top-level `overrides:` list.
Step 3b would otherwise fuzzy-match such a list on re-verification and turn the gaps into `PASSED
(override)`.

## Goal Achievement

### Observable Truths

Truths 1–5 come from the ROADMAP contract. Truth 6 is derived from the goal, SC2 and D-02, checked
live. Truths 7–90 are the must-haves of 03-01 to 03-09 in plan order, and truth 91 is the ROADMAP cross-cutting constraint. 03-01's D-03 disk truth is
merged into SC1 (truth 1), because it restates it. 03-10's nine must-haves are the undelivered proof,
folded into gaps 1–3 under `missing:`.

Status key: ✓ VERIFIED · ✗ NOT VERIFIED (owner-accept 2026-09-28, override recorded, not applied) ·
✗ FAILED (no override) · ⚠️ PRESENT_BEHAVIOR_UNVERIFIED.

**ROADMAP contract**

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | SC1: free disk verified before pulling images (= 03-01 D-03: ≥ 10 GiB before install and before the image build, after-values recorded) | ✓ VERIFIED | 03-01-SPIKE: disk_before=31843188736 (:13), disk_after_install=29634609152 (:36), disk_before_image=29633863680 (:50), disk_after_image=28647456768 (:51), disk_after_cleanup=28535652352 (:286). Every before-value is ≥ 10737418240. Live today: 192440250368 free. |
| 2 | SC2: rivet-agentos host runs; `openTask` writes shared skills, `SUBSTRATE_BRIEF.md` and the substrate/notion/linear MCP config into `/home/agentos` | ✓ VERIFIED (see N1 for today's sandbox image) | Live: `systemctl is-active substrate-host` = active (enabled, up since 2026-09-26 15:09:58 UTC); GET :7411/healthz → `{"engine":true,"api":true}` 200; ss shows 127.0.0.1:7411 and rivet-engine on 127.0.0.1:6420/6421/6430 only. seed.ts:254-290 seedFiles. 03-03-TRACER: seeded_brief=yes, seeded_claude_json=yes, seeded_skills=ultrathink-kickoff,…-plan,…-ship,…-sync, sha256 read-back. 03-04-SMOKE: seeded_mcp_servers=linear,notion,substrate on two VMs, seeded_mcp_headers=none. |
| 3 | SC3: dispatcher routes `dispatch:claude-code` to a VM; `permissionPolicy: "ask"` surfaces approvals to Telegram | ✗ NOT VERIFIED (partial) — owner-accept 2026-09-28 | Routing: dispatch.py:24, :252-271, host.py:152-175. 03-05-TRACER launch_line=`launched claude-code for TRC-2 graph ut-muh32wc1-d14818ff node n1 task …/n1 worktree …`, claim_evidence=claimed_by (synthetic candidate; the label → tick leg was 03-10's). Approvals: tasks.ts:410 `ask`; the journal says `telegram approvals off`; 0 SUBSTRATE_APPROVAL_* keys. Gap 1. |
| 4 | SC4: `claude-ultrathink` runs inside the VM, so kickoff and sync still write Notion and Linear | ✗ NOT VERIFIED (partial) — owner-accept 2026-09-28 | 03-01-SPIKE b_hooks=none, b_skill_by_path=yes → b:prompt_hostfn, tracker_route=host, d11=unmet (D-10 deviation). Skills are seeded into the VM (truth 2). Kickoff was host-written (03-PROOF kickoff_by=host). Sync code is host-side and was never fired live. Gap 2. |
| 5 | Proof: a labelled issue opens a VM, the session survives a host restart, the PR lands, `ultrathink-sync` closes the loop | ✗ NOT VERIFIED — owner-accept 2026-09-28 | 03-10 never ran: no commit, 03-PROOF.md has only § Setup, 0 host tasks for ut-muhk8v3p-47ae5f1a, no pr_url on any task. Restart survival was observed separately on a throwaway graph (truth 57). Gap 3. |
| 6 | Derived (goal + SC2 + D-02, live): `substrate-sandbox:0.1` exists, so a new task can start its sandbox | ✗ FAILED (no override) | `docker image inspect substrate-sandbox:0.1` → No such image. /etc/cron.d/docker-image-prune: `29 2 * * * root docker image prune -af --filter "until=24h"`. sandbox-provider.ts:94 uses SANDBOX_IMAGE with no pull or build. Gap 5, N1. |

**03-01 — D-09 spike, install, sandbox provider and image**

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 7 | D-09: SPIKE answers (a) loopback/control/model, (b) hooks/skills/.claude.json/session MCP, (c) git in VM/sandbox/hostfn, as closed-set keys | ✓ VERIFIED | SPIKE:84-86 a_loopback=yes a_control=denied a_egress_denied=yes; :96-101 probe_model_text="PONG", a_model=yes; :151-155 b_* keys; :224-232 c_vm_git=no, c_sandbox_git=clone_only, c_push_hostfn=yes. |
| 8 | Fallback order a2 → a3 → spike_blocked; no unobserved route_choice written | ✓ VERIFIED | The primary route succeeded: a2_substrate_hostfn=skipped, a2_model_relay=skipped (:102-103). There is no spike_blocked line, and `SUBSTRATE_VM_ANTHROPIC_API_KEY` count is 0. |
| 9 | route_choice derived by the plan's rules; d11=met exactly on s:mcp | ✓ VERIFIED | SPIKE:259-260 `route_choice=a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn`, `d11=unmet`. Re-derived from the probe keys, it matches. The unit's journal prints the same route. |
| 10 | tracker_route=vm_mcp exactly on b:hooks + s:mcp, else host | ✓ VERIFIED | SPIKE:261 tracker_route=host; options.ts:70-72 encodes the same rule; test "vm_mcp exactly for b:hooks + s:mcp … 36 combinations". |
| 11 | tests_route=sandbox when sandbox_tests=yes | ✓ VERIFIED | SPIKE:230 sandbox_tests=yes (12 pass in the container), :262 tests_route=sandbox; the unit has `SUBSTRATE_TESTS_ROUTE=sandbox`. |
| 12 | D-04: asterinas/dev and bold_rosalind intact before and after; no prune/rm on unlabelled data | ✓ VERIFIED (for Phase 3's actions; see N2) | SPIKE:14-15 and :280-285 d04_intact=yes; 03-06-SMOKE d04_intact=yes. The host's boot sweep filters by the `substrate.graph_id` label only (main.ts:113-128), and the journal shows only two removals ever, both labelled sandboxes. Both objects are gone today, and nothing in Phase 3 removed them (N2). |
| 13 | D-02: `substrate-sandbox:0.1` built locally from infra/sandbox/Dockerfile; only node:24-bookworm-slim pulled | ✓ VERIFIED (as built; absent today, truth 6) | Dockerfile FROM node:24-bookworm-slim, bun 1.4.0 sha-pinned, sandbox-agent@0.4.2, COPY --from=ultrathink. SPIKE:41-51: buildx exit 0, only the base was pulled, image sha256:2063de59…, 181055374 B. |
| 14 | D-01: sandboxes only via substrateDocker (127.0.0.1 publish, per-container token, label, own worktree, no privileged or docker.sock); stock docker() never used | ✓ VERIFIED | sandbox-options.ts:82-103 (HostIp 127.0.0.1, --token, label, Binds worktree:/work, Privileged false; docker.sock refused :60-62); sandbox-provider.ts:113-126 creates only through buildContainerSpec, and sandbox-agent is imported as a type only (:12). SPIKE:190-194: unauthenticated /v1/health → 401. |
| 15 | Owner approved the SUS-flagged rivet packages before install; `--workspaces=false`; host lock only | ✓ VERIFIED | The owner reply "approved" is recorded verbatim in 03-01-SUMMARY.md:113 with the approved versions. packages/host/package-lock.json exists and there is no root lock. Pins in package.json: agentos 0.2.21, agentos-sandbox 0.2.21, sandbox-agent 0.4.2. |
| 16 | 03-BASELINE holds the pre-phase keys; root suite and tsc two-sided green after install | ✓ VERIFIED | 03-BASELINE:44-50 head=2df112c, pass=167, fail=0, `tsc-set: tsc-exit=0`, dispatcher 114/0. The latest gates are root 640/0 (07-03), tsc 0 and pytest 149, all ≥ baseline with no failing ids. |
| 17 | Dispatch off during the spike; spike unit, storage, scratch clone, labelled containers and packages/host/spike cleaned up | ✓ VERIFIED | Live: substrate-spike inactive; packages/host/spike absent; no agentos-spike storage; `docker ps -a --filter label=substrate.graph_id` empty; last `SUBSTRATE_DISPATCH_DISABLED=1`. SPIKE:287 orphans_after_cleanup=0. |

**03-02 — WR-05 `issue_get`, Hermes prompt, D-16 note**

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 18 | `issue_get` MCP tool and POST /issue resolve the node's Linear issue, redacted and capped, or `{found:false, reason}` | ✓ VERIFIED | service.ts:220-251 getIssue (title 500, description 20000, redact); mirror.ts:118-129; linear.ts:140. Tests service.test.ts "getIssue (WR-05, D-15)". Info: an index.getGraph error (service.ts:236) propagates instead of returning found:false. |
| 19 | Untrusted field carries the exact notice; prompts stay ids-only | ✓ VERIFIED | service.ts:38 ISSUE_TEXT_NOTICE; test "frames the text with the exact untrusted notice"; test_render_prompt_takes_ids_only_and_no_issue_text; SMOKE issue_get_untrusted=true. |
| 20 | Hermes prompt calls `issue_get` for its own ids and ends with release-and-stop (surface hermes, same session) | ✓ VERIFIED | launcher.py:71-78 step 3, :91-100 step 5; three test_render_prompt_* tests. |
| 21 | D-16 root-trust note above CHILD_ENV_ALLOW | ✓ VERIFIED | launcher.py:39-45, directly above :46. |
| 22 | POST /issue behind the same auth gate; 400 on missing ids or non-JSON | ✓ VERIFIED | server.ts:98-101 gate before :145-154; SyntaxError → 400 (:209-211); server.test.ts:55-71. |
| 23 | substrate-mcp restarted; live `issue_get` found:true with identifier; unknown graph found:false | ✓ VERIFIED | 03-02-SMOKE: restarted_at=2026-09-25T13:42:14Z, healthz=200, issue_get_found=true, issue_get_identifier=SWC-467, http_issue_found=true, unknown_graph_found=false, missing_node_status=400. /healthz on :7410 is 200 today. |
| 24 | Both suites two-sided green above baseline | ✓ VERIFIED | Latest gates 640/0 and 149 against 167/114. Targeted re-runs: mcp-server service/mcp/server tests 93/0; test_launcher.py 22 passed. |

**03-03 — substrate-host unit and host tracer**

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 25 | D-05: its own unit (node src/main.ts, RIVET_RUN_ENGINE=1), storage /var/lib/substrate/agentos 0700, engine 127.0.0.1:6420, API 127.0.0.1:7411; not a dispatcher child | ✓ VERIFIED | infra/vps/substrate-host.service is byte-identical to the installed unit; active, own cgroup; agentos and agentos/tasks are 700; ss shows loopback binds only; journal `engine 127.0.0.1:6420`, `api 127.0.0.1:7411`. |
| 26 | D-06: POST /tasks validates ids and the pinned worktree, claims as claude-code before the prompt, briefs, seeds, opens `ask`, prompts `<gid>:<nid>:1`; 202, existing → 200 | ✓ VERIFIED | tasks.ts:112-125, :349-451 (claim :366, open ask :410, prompt key :441, existing :355-356). tasks.test.ts:208 (order and key), :257 (idempotent). TRACER: idempotent 202/200, prompt_count=1, bad_worktree 400. |
| 27 | GET exit_code null/0/1; terminate cancels; kill cancels, unloads, releases; GET /tasks lists | ✓ VERIFIED | tasks.ts:97-107, :652-690; tests "pollCode", "terminate cancels…exit_code 1", "kill cancels, unloads and releases once each", api.test "GET /tasks lists every task". |
| 28 | SC-2/D-11 seed: brief, four ultrathink skills verbatim, .claude.json with the substrate MCP, tracker locators only | ✓ VERIFIED | seed.ts:254-290; main.ts:81-111. TRACER sha256 read-back; probe_ultrathink_config_keys=["notion","linear"]. |
| 29 | D-08: session env exactly five keys; API key `shunt` off a3; no MCP headers | ✓ VERIFIED | options.ts:141-157; tasks.ts:407-409; tasks.test.ts:219-223. |
| 30 | D-12: default-deny network, D-12 hosts, loopback 3001/7410 exemptions; host functions only substrate and sandbox | ✓ VERIFIED | options.ts:75, :90-128; vm.ts:410-416. TRACER vm_egress_example_com=denied, vm_loopback_7410=200. |
| 31 | D-15 claude-code prompt: host already claimed, `issue_get` via the s: channel, untrusted, complete, release-and-stop | ✓ VERIFIED | seed.ts:116-148; tasks.test.ts:226-227; TRACER hostfn_issue_get=found_false (host-function path end to end). |
| 32 | `ensureModelRoute` awaited before open and every prompt; relay start on a:hostfn_proxy, no-op otherwise | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | The ordering is pinned: tasks.test.ts:214 expects [graphGet, graphClaim, ensureModelRoute, sessions.open, ensureModelRoute, sessions.prompt], and :500 covers resume. The relay-start branch (vm.ts:347-355) has no test and never ran (deployed route a:loopback; TRACER Gaps). See behavior_unverified_items. |
| 33 | GET task returns every stored TaskRecord field plus live fields | ✓ VERIFIED | tasks.ts:638-644; test "status spreads every stored field…"; a live GET of ut-muh1p05f-695a18ee/n1 returned 25 keys. |
| 34 | D-13 floor: with no approval bot a permission_request is logged pending, never answered, exit_code null until terminate | ✓ VERIFIED | vm.ts:463-468 → tasks.ts:586-593; test tasks.test.ts:363. TRACER: `approval pending … (telegram approvals off)`, exit_while_waiting=null. |
| 35 | Live tracer: throwaway graph → POST /tasks → claim as claude-code → seed read back → first model event → terminate exit 1 → kill releases | ✓ VERIFIED | TRACER:40-85 open_status=202, claimed_by=claude-code, claim_session=n1, first_event=approval_pending, exit_after_terminate=1, released_after_kill=true, claimed_by_after_kill=null. |
| 36 | Root suite and tsc two-sided green; host tests import no rivet | ✓ VERIFIED | No `@rivet-dev` or `@agentos-software` import in packages/host/src/*.test.ts. Latest gates 640/0, tsc 0. Re-run: sandbox-options/tasks/api tests 63/0. |

**03-04 — seed/prompt/VM policy, tracker MCP entries, tests route**

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 37 | Seed writes .claude.json with exactly substrate/notion/linear loopback servers (no headers or env), brief, skills, locators, state JSON; no credential | ✓ VERIFIED | seed.ts:254-290; tests "claude.json names exactly…on every route", "no seeded file changes under redact()". SMOKE seeded_tracker_urls=loopback, seeded_mcp_headers=none, seeded_state_file=yes. |
| 38 | trackerRoute: vm_mcp exempts and serves :7412; host neither exempts nor serves it and the host writes (D-10 deviation) | ✓ VERIFIED | options.ts:70-72, :90-106; main.ts:204-205. SMOKE proxy_line=off, vm_proxy_fetch=denied. Live journal `tracker mcp proxy off (tracker route host)`; nothing listens on :7412. |
| 39 | On vm_mcp the prompt runs ultrathink-kickoff with the stateFile; on host there is no kickoff step | ✓ VERIFIED | seed.ts:131-139; tests "kickoff step (stateFile) only on tracker_route vm_mcp…" and "tracker_route host … no kickoff step". |
| 40 | Tracker proxy bridges /mcp/notion and /mcp/linear to ultrathink-mcp children, binds 127.0.0.1, refuses Linear state and Notion terminal writes, logs names only; VM tool calls wait on D-13 | ✓ VERIFIED | mcp-proxy.ts:66-94, :222-244, :281-364; 14 tests pass ("listens on 127.0.0.1:7412 only", "never carries params", both refusals). Host-side smoke against the real children: 45/59 tools, refusals -32001. Inert on the deployed route. Tool calls do wait (permissionPolicy ask, truth 34); nothing answers them, which is gap 1. |
| 41 | Tests route: sandbox → run-command; oneshot → run-tests via `docker --network none`; none → tests_pass false | ✓ VERIFIED | seed.ts:68-77; options.ts:177-191; vm.ts:179-213, :426. Tests "tests step follows testsRoute…", testRunArgv. Only sandbox is live. |
| 42 | sessionEnv: exactly five D-08 keys; anthropic_key needs the supplied key; others use `shunt` | ✓ VERIFIED | options.ts:141-157; three sessionEnv tests. |
| 43 | D-12 egress: five hosts :443, loopback 7410/3001 (7412 only on vm_mcp), anthropic only on a3; host functions substrate and sandbox only | ✓ VERIFIED | options.ts:100-129; vm.ts:412-415; tests "default deny; exactly the five D-12 hosts…", "127.0.0.1:7412 appears only on…". |
| 44 | D-15 renderPrompt: ids only and validated, issue_get before complete, names the s: channel and host claim, ends release-and-stop, forbids `.substrate-*` commits | ✓ VERIFIED | seed.ts:52-58, :116-149; four renderPrompt tests. |
| 45 | b:hooks only: PostToolUse(Bash) + Stop shim; never UserPromptSubmit | ✓ VERIFIED | seed.ts:239-251, :288; test "b:hooks seeds PostToolUse(Bash) and Stop shims only…". Unit-level only (deployed b:prompt_hostfn). |
| 46 | Live: VM reached `issue_get` via the s: channel; VM held three loopback MCP servers; proxy live or inert per tracker_route | ✓ VERIFIED | SMOKE vm_issue_get=found_false_no_ref, vm_issue_get_channel=hostfn, seeded_mcp_servers and task2_seeded_mcp_servers=linear,notion,substrate, vm_tracker_mcp=inert. |
| 47 | Root suite and tsc two-sided green; host tests import no rivet | ✓ VERIFIED | Latest gates 640/0, tsc 0. Re-run: seed 18/0, options 27/0, mcp-proxy 14/0. |

**03-05 — dispatcher RemoteTask route**

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 48 | `dispatch:claude-code` dispatchable; after the worktree, make_launch_fn POSTs /tasks and returns Launched(pid 0, RemoteTask); exact log line | ✓ VERIFIED | dispatch.py:24, :252-271; host.py:152-175; test_make_launch_fn_routes_claude_code_to_open_task_after_the_worktree; TRACER launch_line. |
| 49 | RemoteTask.poll: None while null, host 0/1, 2 after three transport errors; terminate/kill never raise | ✓ VERIFIED | host.py:191-224; test_poll_maps_the_hosts_exit_code[…], test_poll_tolerates_two_transport_failures_then_reports_2…, test_terminate_and_kill_*; TRACER poll_while_waiting=None. |
| 50 | D-14 cap 2 and 900 s claim timeout unchanged; the host's claude-code claim lands via claimed_by | ✓ VERIFIED | sessions.py unchanged since 02-07 (a6e9604); test_unclaimed_remote_task_hits_the_unchanged_claim_timeout…; TRACER claim_evidence=claimed_by, registry_capacity_left=1. |
| 51 | Host refusal or unreachable → one once-only marker comment, no registry entry | ✓ VERIFIED | host.py:29, :101-116; dispatch.py:39-40, :184-188, :214-218; test_host_refused_becomes_one_once_only_comment…, test_host_unreachable_marker_is_retried_next_tick. |
| 52 | D-05: a dispatcher restart leaves the VM task running; re-adoption gap recorded | ✓ VERIFIED | TRACER host_active_since_before=after=`Fri 2026-09-25 14:44:31 UTC`, dispatcher_restart_task_kept=true, dispatcher_restarted_at=15:00:12Z. Re-adoption is under TRACER Gaps (N4). |
| 53 | Live tracer: real HostClient → worktree → host → claim → VM session; poll None; no Linear write | ✓ VERIFIED | TRACER t_launch=14:56:20Z, t_claim_landed=14:56:32Z, worktree_branch=substrate/ut-muh32wc1-d14818ff. The Linear stub raises on any call and was never reached. The label leg is gap 1. |
| 54 | Dispatch stays disabled; `dispatch disabled` after the restart | ✓ VERIFIED | Live: last `SUBSTRATE_DISPATCH_DISABLED=1`; the journal repeats `[substrate-dispatcher] dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)`. |
| 55 | Dispatcher suite two-sided green above baseline | ✓ VERIFIED | 149 against 114. Re-run: test_host 19, test_dispatch 34, test_sessions 29, test_main 11, all pass. |

**03-06 — D-07 resume and containment audit**

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 56 | D-07: VM files under /home/agentos and session history persist in /var/lib/substrate/agentos; after a restart every in-flight task gets exactly one continuation prompt keyed `<gid>:<nid>:resume:<n>` | ✓ VERIFIED | The unit sets RIVETKIT_STORAGE_PATH=/var/lib/substrate/agentos (700, live). tasks.ts:81-83 interruptedTasks, :541-575 resumeInterrupted, key `resume:` at :569, idempotencyKey on sessions.prompt (:457). Test "one interrupted record gets one continuation prompt keyed resume:1…" (tasks.test.ts 36/0 re-run). Live: truth 57. |
| 57 | D-07 live: across `systemctl restart substrate-host` the sessionId is kept, seq ≥ before, brief sha equal, `…:resume:1` journal line, new event after | ✓ VERIFIED | 03-06-SMOKE: session_before=after=n1, seq 2→4, brief_sha_before=after=vm_brief_sha256_live=08d59267…, `resumed ut-muh3nlig-97d72a43/n1 key ut-muh3nlig-97d72a43:n1:resume:1` at 15:13:14Z, post_restart_event=approval_pending, restart_survived=true. |
| 58 | Released, finished or already-resumed tasks never re-prompted; dead-turn approvals cleared and counted stale | ✓ VERIFIED | tasks.ts:81-83, :542-565; tests "one interrupted record gets one continuation prompt keyed resume:1…", "a second call in the same process sends nothing". SMOKE stale_approvals=1. |
| 59 | resumeInterrupted awaits ensureModelRoute per task before its prompt; a failure fails only that task | ✓ VERIFIED | tasks.ts:549-570; main.ts:150; test "ensureModelRoute is awaited once per task before its prompt; a failing route fails that task only". The live journal on the current boot shows `interrupted turns resumed: 0`. |
| 60 | D-08 audit live: storage 700, zero secret-key hits, config keys reported apart | ✓ VERIFIED | audit.ts:16-62, :221-259; SMOKE storage_mode=700, secret_hits_total=0, sanctioned_keys=none; audit.test.ts 11/0. The zero is a floor (RocksDB compression; SMOKE Gaps). |
| 61 | D-01 live: sandbox containers on 127.0.0.1, unprivileged, no docker.sock, own worktree plus read-only binds; container egress recorded as the D-12 deviation | ✓ VERIFIED | SMOKE containers_inspected=1, container_violations=0; container_example_com=reachable listed under Gaps (N3). |
| 62 | D-12 live: fetch to example.com from a VM is denied | ✓ VERIFIED | SMOKE vm_fetch_exit=7, `blocked by network.http policy`, vm_example_com=denied. |
| 63 | D-04: boot sweep removes only `substrate.graph_id` containers; asterinas/dev and bold_rosalind still present | ✓ VERIFIED (at the time; see N2) | main.ts:113-128 label filter; SMOKE d04_intact=yes. |
| 64 | Root suite and tsc two-sided green | ✓ VERIFIED | Latest gates; re-run tasks.test.ts 36/0, audit.test.ts 11/0. |

**03-07 — commit, push, PR host functions and D-10 sync**

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 65 | A VM session can land a PR with no GitHub credential in the VM or container; the host-side git-push and pr-create fix the worktree, branch, repo and base | ✗ NOT VERIFIED (partial) — owner-accept 2026-09-28 | The no-credential half and the fixed argvs are verified: hostfns.ts:44-59, :148-158, vm.ts:249-274; sessionEnv has five keys (truth 42). "Can land a PR" was never exercised: the push was dry-run only and pr-create was never invoked (03-07-SMOKE:5-6, :180-184). Gap 3. |
| 66 | Commit route follows 03-01's c: segment | ✓ VERIFIED | c:hostfn_commit deployed; vm.ts:276-291 registers commit only on that route; SMOKE c_route=hostfn_commit, vm_commit_on_host=true. The vm_git and sandbox_git branches are prompt text only (Info). |
| 67 | pr-create makes one PR per task and records pr_url/pr_number; git-push refuses a wrong branch or origin and never forces | ✓ VERIFIED | hostfns.ts:174-227, pushArgv :46 has no force flag; five hostfns.test.ts tests; 17/0 re-run. |
| 68 | Commits exclude `.substrate-*`; git-push refuses a branch that lists one, before the network | ✓ VERIFIED | hostfns.ts:23, :72, :123-130, :179-183; tests; SMOKE scratch_in_commit=false, push_guard=refused (reason .substrate-hook-input.json). |
| 69 | Push credentials proven in the unit's environment; substrate.env has no GH_TOKEN or GITHUB_TOKEN | ✓ VERIFIED | SMOKE push_env=systemd-run, push_dry_run_exit=0, gh_auth_unit_env=ok, gh_token_in_env_file=0; live counts 0 and 0. |
| 70 | D-10 sync writes only the five PR fields and the Linear PR link and never moves a state | ✓ VERIFIED (test level; the live write is gap 2/3) | sync.ts:16 SYNC_WRITABLE, :116-118 refusal, :196-215 attachLink only; tests "a property outside SYNC_WRITABLE is refused before any request" and "no issueUpdate and no stateId anywhere". sync.test 10/0. |
| 71 | D-10 route per 03-01: model sync by host function on tracker_route=host, host backstop sync_by=host | ✓ VERIFIED | seed.ts:107-113; tasks.ts:465, :479, :496-529; seed and sync tests; journal `sync: notion on, linear on (tracker route host)`; SMOKE sync_hostfn_registered=true. |
| 72 | The sync host function accepts only the PR URL the host recorded | ✓ VERIFIED | sync.ts:340-341; test "rejects a --pr-url that differs…"; SMOKE vm_sync_no_pr refused. |
| 73 | Notion and Linear credentials stay on the host; nothing new enters the VM | ✓ VERIFIED | main.ts:135-137 reads from the unit's EnvironmentFile; sessionEnv five keys; seed redact test; SMOKE: 0 key-shaped journal lines. |
| 74 | Root suite and tsc two-sided green | ✓ VERIFIED | Latest gates 640/0, tsc 0. |

**03-08 — D-13 Telegram approval broker (closed partial)**

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 75 | `permissionPolicy: "ask"`; every permission_request goes to the bot with exactly Approve (allow_once) and Deny (reject_once); answers only through respondPermission after a tap | ✓ VERIFIED (code and test level) | tasks.ts:410; vm.ts:466-480 recordApproval then broker.post; telegram.ts:143-152 exactly two buttons; the only respondPermission call is tasks.ts:609 (reached from main.ts:163). telegram.test.ts 10/0 against a fake Bot API. No real chat exists (gap 4). |
| 76 | Callbacks accepted only from the configured user in the configured chat; `ap:<key>:<i>` ≤ 64 B; single-use; unknown/answered → expired | ✓ VERIFIED | telegram.ts:96-130, :300-317; four named tests. |
| 77 | Log contract: `callback authorised` precedes `answered`; no other writer | ✓ VERIFIED | telegram.ts:310, :313, :324; test "an authorised reject_once callback logs authorised before respond…"; no other writer in the tree. Live: 0 such lines (approvals off). |
| 78 | Message redacted and capped; buttons removed and outcome written after an answer; getUpdates offset persisted | ✓ VERIFIED | telegram.ts:12, :139-142, :328-338, :360-395; tests. |
| 79 | The bot token never appears in logs, errors, evidence or output | ✓ VERIFIED | telegram.ts:164-167, :190; test "TelegramError never contains the bot token or the Bot API URL"; 0 journal matches. |
| 80 | Any key absent → `telegram approvals off`, requests pending; all present → `telegram approvals on (bot @…)` | ✗ NOT VERIFIED (partial) — owner-accept 2026-09-28 | The off half is live: 0 keys and journal `[substrate-host] telegram approvals off`. The on half (main.ts:237) has never run. Gap 4. |
| 81 | The owner created the bot and appended the three keys, each once | ✗ NOT VERIFIED — owner-accept 2026-09-28 | Owner answer "skip" (03-08-SUMMARY § Outcome); `sudo grep -c '^SUBSTRATE_APPROVAL_'` = 0. Gap 4. |
| 82 | Live Bot API smoke: getMe, sendMessage with a keyboard, 60 s long-poll without 409 | ✗ NOT VERIFIED — owner-accept 2026-09-28 | Task 3 did not run; 03-08-SMOKE.md does not exist. Gap 4. |
| 83 | Root suite and tsc two-sided green | ✓ VERIFIED | 03-08-SUMMARY gate at ed8cc94 338/0, tsc 0, pytest 149; latest gates 640/0. |

**03-09 — proof setup**

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 84 | The owner chose what "the PR lands" means | ✓ VERIFIED | 03-PROOF:12 owner answer `i`, :16 pr_lands_decision=i, :108 proof_repo=swcstudiospace/agent-substrate. |
| 85 | D-14: recount, archive exactly max(0, count − 249) from the owner pool, oldest first, each re-checked | ✓ VERIFIED (record level) | 03-PROOF:62-65 active_before=262, archives_needed=13, archived_count=13, active_after=249; 02-LINEAR-ARCHIVED.md:143-206 rule, 13-row table, archive log, unarchive method. No Linear call was made in this verification. |
| 86 | One fresh proof issue in SWC Todo on a NEW graph | ✓ VERIFIED (record level) | 03-PROOF:73-77, :101-104 issue_source=created, SWC-480, linear_state=Todo, graph_id=ut-muhk8v3p-47ae5f1a. SWC-480 was explicitly kept in the 2026-09-26 cleanup (02-LINEAR-ARCHIVED:296). |
| 87 | The proof graph carries the Notion Task row; n1 carries linear_issue_id, identifier and notion_page | ✓ VERIFIED (record level) | 03-PROOF:79-84 both rows HTTP 200, graph_get read-back; :103-107. |
| 88 | D-10 on tracker_route=host: the host set Status Implementing (kickoff_by=host) | ✓ VERIFIED (record level) | 03-PROOF:116-118 tracker_route=host, kickoff_by=host, notion_task_status_before=Implementing. |
| 89 | The `dispatch:claude-code` label exists but is not applied | ✓ VERIFIED (record level) | 03-PROOF:85-86, :109 dispatch_label_id=3dee3876-…, issue_labels_now=(none). Live corroboration: no host task for the proof graph and dispatch is off. |
| 90 | Every keyed call ran under `sudo systemd-run -p EnvironmentFile=…`; no key in output or files | ✓ VERIFIED | 03-PROOF:43-46; a key-shape grep of 03-PROOF.md and 02-LINEAR-ARCHIVED.md returns 0 matches. |

**Cross-cutting constraint (ROADMAP)**

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 91 | Root suite and tsc two-sided green against 03-BASELINE with more passes than agent-substrate-pass | ✓ VERIFIED | Latest root suite 640 pass / 0 fail (07-03) > 167; tsc `tsc-exit=0` = baseline set; dispatcher pytest 149 > 114. There are no failing ids on either side. I did not re-run the full suites. |

**Score:** 82/91 truths verified (1 present, behaviour-unverified; 0 overrides applied; 7 items
not verified under owner-accept gaps 1–4; 1 failure without an override, gap 5)

Not verified: 3, 4, 5, 65, 80, 81 and 82 (owner-accept 2026-09-28) and 6 (no override).
Behaviour-unverified: 32.

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `infra/vps/substrate-host.service` | D-05 unit, storage path, route env | ✓ VERIFIED | Byte-identical to the installed unit; active and enabled |
| `packages/host/src/{main,api,tasks,vm,seed,options,substrate}.ts` | Host engine, API, task service, VM policy, seed and prompt | ✓ VERIFIED | Exercised by 03-03/04/06 live evidence; 63 + 18 + 27 tests re-run green |
| `packages/host/src/{sandbox-options,sandbox-provider}.ts` | D-01 container shape; stock docker() never used | ✓ VERIFIED | 19 sandbox-options tests; create only via buildContainerSpec |
| `packages/host/src/mcp-proxy.ts` | Tracker MCP proxy (vm_mcp) | ✓ VERIFIED (inert on the deployed route) | 14 tests; host-side live smoke; not served on tracker_route=host |
| `packages/host/src/audit.ts` | D-01/D-04/D-08/D-12 audit CLI | ✓ VERIFIED | 11 tests; SMOKE audit block |
| `packages/host/src/{hostfns,sync}.ts` | commit/push/pr-create, D-10 sync | ✓ VERIFIED (code) / ✗ never used live for push, PR or tracker write (gap 3) | 17 + 10 tests |
| `packages/host/src/telegram.ts` | D-13 broker | ✓ VERIFIED (code) | 10 tests; runs off (gap 4) |
| `packages/dispatcher/src/substrate_dispatcher/{host,dispatch,__main__}.py` | HostClient, RemoteTask, claude-code route | ✓ VERIFIED | 93 dispatcher tests re-run across four files |
| `packages/mcp-server/src/{service,mcp,server,mirror,linear}.ts`, `launcher.py` | issue_get, POST /issue, Hermes prompt, D-16 note | ✓ VERIFIED | 93 + 22 tests re-run |
| `infra/sandbox/Dockerfile` | D-02 image recipe | ✓ VERIFIED | Present and correct |
| docker image `substrate-sandbox:0.1` | The runtime sandbox image | ✗ MISSING (gap 5) | Pruned by /etc/cron.d/docker-image-prune |
| `03-BASELINE.md`, `03-01-SPIKE.md`, `03-02-SMOKE.md`, `03-03-TRACER.md`, `03-04-SMOKE.md`, `03-05-TRACER.md`, `03-06-SMOKE.md`, `03-07-SMOKE.md` | Observed evidence | ✓ VERIFIED | Every required key present; each has one `## Gaps` |
| `03-08-SMOKE.md` | Live Bot API smoke | ✗ MISSING (owner-accept, gap 4) | Task 3 not run |
| `03-PROOF.md` | Setup plus the observed proof (`restart_survived=`) | ⚠️ PARTIAL (owner-accept, gap 3) | § Setup complete; proof body absent |
| `02-LINEAR-ARCHIVED.md` § Phase 3 | D-14 archive record | ✓ VERIFIED | :143-206 |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| 03-01-SPIKE.md route_choice | substrate-host | unit `SUBSTRATE_HOST_ROUTE` → parseRoute (main.ts:37-43) | ✓ WIRED | Journal `route a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn` |
| sandbox-provider.ts | sandbox-options.ts | buildContainerSpec | ✓ WIRED | sandbox-provider.ts:13-20, :96, :116-118 |
| vm.ts | sandbox-provider.ts / options.ts | resolveSandboxOptions; network and host-function permissions | ✓ WIRED | vm.ts:41, :410-434 |
| api.ts | tasks.ts | route handlers | ✓ WIRED | api.ts:67-93; main.ts:248 |
| tasks.ts | substrate-mcp graph_claim | SubstrateClient tools/call | ✓ WIRED | Live claimed_by=claude-code (TRACER, 03-05-TRACER) |
| mcp.ts → service.ts → mirror.ts → linear.ts | issue_get | getIssue → issueText → IssueText | ✓ WIRED | Tests plus 03-02-SMOKE live found:true |
| launcher.py | substrate-mcp issue_get | prompt step 3 | ✓ WIRED | launcher.py:73-74 |
| dispatch.py → host.py | substrate-host :7411 | make_launch_fn → HostClient.open_task | ✓ WIRED | 03-05-TRACER live |
| main.ts | tasks.ts resumeInterrupted | boot | ✓ WIRED | Journal `interrupted turns resumed: 0` (current boot); 03-06 live resume |
| vm.ts | hostfns.ts / sync.ts | host-function collection | ✓ WIRED | In-VM list `issue-get,release,complete,git-push,pr-create,commit,sync` (03-07-SMOKE:148) |
| tasks.ts | sync.ts backstop | turn settle → backstopSync | ✓ WIRED (never fired live) | Pinned by sync.test backstop tests |
| vm.ts → telegram.ts → tasks.ts | respondPermission | broker.post → callback → respondApproval | ✓ WIRED (code) | Runs off: post logs "not posted" |
| main.ts | mcp-proxy.ts | startTrackerProxy on vm_mcp only | ✓ WIRED (inert by route) | Journal `tracker mcp proxy off` |
| Linear label on the proof issue | dispatcher tick → POST /tasks | 30 s poll → graph_find → make_launch_fn | ✗ NOT_WIRED live (owner-accept, gap 1) | 03-10 not run; label never applied |
| VM permission_request | owner's Telegram tap → respondPermission | ApprovalBroker | ✗ NOT_WIRED live (owner-accept, gaps 1 and 4) | No bot |
| host pr-create result | Notion Task PR fields and Linear PR link | sync | ✗ NOT_WIRED live (owner-accept, gaps 2 and 3) | Never run |
| SANDBOX_IMAGE | docker image store | createContainer | ✗ NOT_WIRED live (gap 5) | Image absent |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| VM `/home/agentos` seed | brief, skills, .claude.json, locators, state file | substrate-mcp memory_brief/graph_get + /root/.claude skills → seedFiles | Yes (sha256 read-back, 03-03/03-04) | ✓ FLOWING (as observed 2026-09-25) |
| TaskRecord (tasks/<gid>--<nid>.json) | claim, pending_approvals, resumes, pr_url, sync_by | TaskService + rivet session events | Yes, for claim, approvals and resume. pr_url and sync_by are null on all 12 records | ⚠️ PARTIAL (PR and sync fields never populated; gap 3) |
| `issue_get` result | redacted title and description | Linear IssueText via the mirror | Yes (SWC-467 found:true) | ✓ FLOWING |
| Notion Task PR fields / Linear PR link | pr_url, pr_number, state, repo, branch | host pr-create → sync | No writer has run | ✗ DISCONNECTED live (owner-accept, gaps 2–3) |
| Telegram approval | option id | callback_query | No bot | ✗ DISCONNECTED (owner-accept, gap 4) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Host service up | `systemctl is-active substrate-host substrate-mcp substrate-dispatcher`; `systemctl show substrate-host -p ActiveEnterTimestamp -p UnitFileState` | active ×3; `Sat 2026-09-26 15:09:58 UTC`, enabled | ✓ PASS |
| Host health | `curl -s http://127.0.0.1:7411/healthz` | `{"engine":true,"api":true}` 200 (the first 5 s probe timed out; the retry answered in 0.19 s) | ✓ PASS |
| Loopback-only binds | `ss -ltnp` | 7410 (bun), 7411 (node), 6420/6421/6430 (rivet-engine), all 127.0.0.1 | ✓ PASS |
| Current boot log contract | `journalctl -u substrate-host` since the boot | `engine 127.0.0.1:6420`, `api 127.0.0.1:7411`, `route a:loopback,b:prompt_hostfn,c:hostfn_commit,s:hostfn`, `interrupted turns resumed: 0`, `tracker mcp proxy off (tracker route host)`, `telegram approvals off`, `orphan sandboxes removed: 0` | ✓ PASS |
| Dispatch off | last `SUBSTRATE_DISPATCH_DISABLED=` line; dispatcher journal | `1`; `dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)` | ✓ PASS |
| Approvals off | `sudo grep -c '^SUBSTRATE_APPROVAL_' /etc/substrate/substrate.env` | 0 | ✓ PASS (confirms gaps 1 and 4) |
| Proof not run | `GET :7411/tasks` | 12 tasks, all `unloaded`; 0 for ut-muhk8v3p-47ae5f1a; no pr_url | ✓ PASS (confirms gap 3) |
| Sandbox image | `docker image inspect substrate-sandbox:0.1`; `cat /etc/cron.d/docker-image-prune` | No such image; daily `docker image prune -af --filter "until=24h"` | ✗ FAIL (gap 5) |
| No leftover sandboxes | `docker ps --filter label=substrate.graph_id` | none | ✓ PASS |
| Host unit tests (workers) | `SUBSTRATE_DISABLED=1 bun test` on sandbox-options, tasks, api / seed / options / mcp-proxy / audit / hostfns / sync / telegram | 63/0, 18/0, 27/0, 14/0, 11/0, 17/0, 10/0, 10/0 | ✓ PASS |
| mcp-server tests (worker) | `bun test service.test.ts mcp.test.ts server.test.ts` | 93/0 | ✓ PASS |
| Dispatcher tests (workers) | `pytest tests/test_host.py`, `test_dispatch.py`, `test_sessions.py`, `test_main.py`, `test_launcher.py` | 19, 34, 29, 11, 22 passed | ✓ PASS |

Every live check only read state. There was no restart, no POST to :7411 or :7410, no keyed Linear,
Notion or GitHub call, and no substrate.env value was printed. I did not re-run the full root suite,
tsc or full pytest; those numbers are the latest gates (root 640/0 at 07-03, tsc 0, pytest 149).

### Probe Execution

No Phase 3 plan or summary declares a `probe-*.sh`, and none exists. 03-01's probes (a)/(b)/(c)
were throwaway harnesses that ran inside the transient spike unit and were deleted. Their observed
output is in 03-01-SPIKE.md. Step 7c: no probes to run.

### Requirements Coverage

Every plan has `requirements: []`, and there is no .planning/REQUIREMENTS.md. The contract is the
ROADMAP success criteria plus the owner decisions in 03-CONTEXT.

| Decision | Status | Where |
| --- | --- | --- |
| D-01 VM plus Docker sandbox provider | ✓ | truths 14, 60 |
| D-02 local sandbox image | ✓ built / ✗ absent today | truths 13, 6 (gap 5) |
| D-03 disk gate | ✓ | truth 1 |
| D-04 other projects' Docker data untouched | ✓ by Phase 3 (N2) | truths 12, 63 |
| D-05 separate host unit | ✓ | truths 25, 52 |
| D-06 dispatcher → host handle | ✓ (label leg: gap 1) | truths 26, 48–53 |
| D-07 restart survival | ✓ on a throwaway graph / ✗ in the proof (gap 3) | truths 56–59 |
| D-08 minimal VM credentials | ✓ | truths 29, 42, 60, 73 |
| D-09 spike first | ✓ | truths 7–11 |
| D-10 ultrathink in the VM | ⚠️ deviation (host route) — gap 2 | truths 38, 39, 71, 88 |
| D-11 `substrate` MCP in .claude.json | seeded ✓; d11=unmet (session MCP only) — part of gap 2 | truths 9, 28 |
| D-12 egress allowlist | ✓ VM / ⚠️ container deviation (N3) | truths 30, 43, 61, 62 |
| D-13 ask + Telegram Approve/Deny | ✓ code / ✗ live — gaps 1, 4 | truths 34, 75–82 |
| D-14 fresh proof issue | ✓ | truths 85–86 |
| D-15 WR-05 `issue_get` | ✓ | truths 18–23, 31, 44 |
| D-16 root-trust note | ✓ | truth 21 |

There are no orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| all Phase 3 non-test sources | — | TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER/"not yet implemented" | — | 0 hits. The only grep hits are the fake token literal `…OnlyXXXX` in telegram.test.ts fixtures, which is not a marker. |
| packages/host/src/tasks.ts | 522 | backstop sets `synced_at` whatever the tracker halves returned | ⚠️ Warning | A failed Notion or Linear half is visible only in the journal and is never retried (acknowledged in 03-07-SMOKE Gaps). |
| packages/host/src/vm.ts | 347 | relay-start branch with no test | ⚠️ Warning | Truth 32; only matters on a:hostfn_proxy. |
| packages/host/src/tasks.ts | 592 | `recordApproval` always logs "(telegram approvals off)" | ℹ️ Info | Misleading once a bot exists. |
| packages/host/src/main.ts | 239 | a getMe failure logs "approvals off" but leaves the broker enabled | ℹ️ Info | Messages could post with buttons nothing polls. It cannot auto-answer. |
| packages/mcp-server/src/service.ts | 236 | index.getGraph error propagates | ℹ️ Info | 500 instead of found:false on an index outage. |
| packages/host/src/vm.ts | 411 | c:vm_git / c:sandbox_git are prompt text only | ℹ️ Info | Harmless on the deployed c:hostfn_commit route. |
| packages/host/src/substrate.ts | 196 | brief() fails open with "substrate brief unavailable" | ℹ️ Info | By design, but it hides an MCP outage from the seed. |

### Human Verification Required

None as a separate gate. The seven owner-accept items are gaps with the owner's recorded answer. Gap
5 is a gap for the orchestrator. The one behaviour-unverified truth (32) is listed in
`behavior_unverified_items` and does not change the status, which is already `gaps_found`.

### Notes

- **N1 — The sandbox image is gone (⚠️ Warning, gap 5).** `substrate-sandbox:0.1` (and its base
  node:24-bookworm-slim) are absent. The root cron `/etc/cron.d/docker-image-prune`, dated
  2026-06-23 and so older than Phase 3, runs `docker image prune -af --filter "until=24h"` daily at
  02:29. That removes any image older than 24 h that no container uses, and the sandbox image is
  idle whenever no VM runs. VMs still started on 2026-09-26 (04-06's live check), so the image most
  likely went at the 2026-09-27 02:29 run [INFERENCE]. SC2 is verified on its 2026-09-25 evidence.
  Today, though, a new task cannot create its sandbox (sandbox-provider.ts has no pull or build).
  Rebuilding under D-03's gate and exempting the image from the prune closes this. It must be done
  before any 03-10 revival.
- **N2 — D-04's protected objects are gone, and not by Phase 3 (ℹ️ Info).** asterinas/dev and
  bold_rosalind were intact through 03-06 (d04_intact=yes twice). Today the image is absent (the
  same cron prunes unused images) and so is the container (`docker image prune` does not remove
  containers, so something else did). substrate-host's journal shows only two sweep removals ever,
  both labelled sandboxes. D-04 bound Phase 3's own actions, and those held.
- **N3 — The D-12 container-egress deviation (ℹ️ Info).** On `sandbox_net=published_loopback` the
  sandbox container can reach the internet (`container_example_com=reachable`), while the VM cannot.
  03-06 records this as a deviation whose control is that every command reaches the container only
  as a VM tool call waiting on a D-13 tap. With approvals off nothing runs, so it cannot be abused
  today. It becomes live the day an approval route exists.
- **N4 — Re-adoption after a dispatcher restart (ℹ️ Info).** A dispatcher restart keeps the VM task
  running (truth 52), but the new dispatcher does not rebuild its registry entry from `GET /tasks`
  (T-03-05-04, accepted).
- **N5 — Linear free-plan headroom (ℹ️ Info).** 03-09 left the SWC workspace at 250 active issues,
  the Free-plan limit. A 03-10 revival reuses SWC-480 and needs no create. Any other Linear create
  needs an archive first.

### Gaps Summary

Gaps 1–4 share one root cause: there is no approval route. The owner answered "skip" to 03-08's bot
checkpoint and decided on 2026-09-26 to keep approvals off. With `permissionPolicy: "ask"` and no
approver, the proof session would stall at its first permission request, so 03-10 never ran. On
2026-09-28 the owner answered **"Accept Phase 3 without 03-10"**. Everything that only the proof
would have shown is therefore unobserved:

- SC3's label → tick leg and Telegram approvals (gap 1)
- SC4's tracker writes by the session (gap 2)
- the end-to-end Proof, including the real push, PR and Greptile review (gap 3)
- 03-08's bot and live smoke (gap 4)

SC4 also carries a design deviation that 03-10 was only going to record. The spike showed that
claude-ultrathink's hooks and skills do not load natively under the rivet adapter. As a result,
kickoff and sync run through the host (tracker_route=host, D-10), not "inside the VM" as the
criterion reads.

Gap 5 has a different root cause and no owner answer. A pre-existing daily image prune removed the
locally built sandbox image, so Lane A cannot start a new sandbox today.

The orchestrator or owner can proceed in one of two ways:

- **Record Phase 3 as accepted.** Cite the owner's verbatim "Accept Phase 3 without 03-10" and this
  report, the same route Phases 5–7 took (`phase3-verification=accepted` with a verbatim note).
  Decide gap 5 separately: rebuild `substrate-sandbox:0.1` under D-03's gate and exempt it from
  `/etc/cron.d/docker-image-prune`, or record that Lane A is dormant until it is rebuilt.
- **Close the gaps later.** Pick an approval route (03-08 Tasks 2–3 or another), rebuild and protect
  the image, then run 03-10 as planned on SWC-480 and graph ut-muhk8v3p-47ae5f1a.

No code change inside Phase 3 closes gaps 1–4 without the owner's approval route.

---

_Verified: 2026-09-28T01:39:33Z_
_Verifier: Claude (gsd-verifier)_
