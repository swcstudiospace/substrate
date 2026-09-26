---
phase: 02-claims-and-dispatch
verified: 2026-09-26T00:23:44Z
status: passed
score: 65/65 must-haves verified (60 verified, 5 passed by owner override)
covered_files:
  - .planning/phases/02-claims-and-dispatch/02-01-PLAN.md
  - .planning/phases/02-claims-and-dispatch/02-01-SUMMARY.md
  - .planning/phases/02-claims-and-dispatch/02-01-TRACER.md
  - .planning/phases/02-claims-and-dispatch/02-02-PLAN.md
  - .planning/phases/02-claims-and-dispatch/02-02-SUMMARY.md
  - .planning/phases/02-claims-and-dispatch/02-03-BASELINE.md
  - .planning/phases/02-claims-and-dispatch/02-03-PLAN.md
  - .planning/phases/02-claims-and-dispatch/02-03-SUMMARY.md
  - .planning/phases/02-claims-and-dispatch/02-04-PLAN.md
  - .planning/phases/02-claims-and-dispatch/02-04-SUMMARY.md
  - .planning/phases/02-claims-and-dispatch/02-05-PLAN.md
  - .planning/phases/02-claims-and-dispatch/02-05-SMOKE.md
  - .planning/phases/02-claims-and-dispatch/02-05-SUMMARY.md
  - .planning/phases/02-claims-and-dispatch/02-06-PLAN.md
  - .planning/phases/02-claims-and-dispatch/02-06-SMOKE.md
  - .planning/phases/02-claims-and-dispatch/02-06-SUMMARY.md
  - .planning/phases/02-claims-and-dispatch/02-07-PLAN.md
  - .planning/phases/02-claims-and-dispatch/02-07-SUMMARY.md
  - .planning/phases/02-claims-and-dispatch/02-08-PLAN.md
  - .planning/phases/02-claims-and-dispatch/02-08-SUMMARY.md
  - .planning/phases/02-claims-and-dispatch/02-09-PLAN.md
  - .planning/phases/02-claims-and-dispatch/02-09-SUMMARY.md
  - .planning/phases/02-claims-and-dispatch/02-09-TRACER.md
  - .planning/phases/02-claims-and-dispatch/02-BASELINE.md
  - .planning/phases/02-claims-and-dispatch/02-CONTEXT.md
  - .planning/phases/02-claims-and-dispatch/02-NOTION-SCHEMA.md
  - .planning/phases/02-claims-and-dispatch/02-PROOF.md
  - infra/vps/substrate-dispatcher.service
  - packages/dispatcher/pyproject.toml
  - packages/dispatcher/src/substrate_dispatcher/__init__.py
  - packages/dispatcher/src/substrate_dispatcher/__main__.py
  - packages/dispatcher/src/substrate_dispatcher/dispatch.py
  - packages/dispatcher/src/substrate_dispatcher/launcher.py
  - packages/dispatcher/src/substrate_dispatcher/linear.py
  - packages/dispatcher/src/substrate_dispatcher/mcp.py
  - packages/dispatcher/src/substrate_dispatcher/sessions.py
  - packages/dispatcher/src/substrate_dispatcher/worktree.py
  - packages/mcp-server/src/config.ts
  - packages/mcp-server/src/dod-gate.ts
  - packages/mcp-server/src/index-store.ts
  - packages/mcp-server/src/index.ts
  - packages/mcp-server/src/linear.ts
  - packages/mcp-server/src/mcp.ts
  - packages/mcp-server/src/mirror.ts
  - packages/mcp-server/src/notion.ts
  - packages/mcp-server/src/service.ts
  - packages/mcp-server/src/types.ts
covered_digest: "v1:sha256:e90da44cbd3211078af877d49c467549345d98ceca53befafd3b2b16d29e6105"
covered_files_note: "Same list as the 2026-09-25 report; the digest is recomputed at HEAD fb6ffa0 with `query verification.fingerprint`. Excluded: ROADMAP.md and 02-LINEAR-ARCHIVED.md (tracking logs that later phases append to — Phase 3 D-14 records its archives there); 02-RESEARCH/PATTERNS/VALIDATION/REVIEW and COVERAGE.md (not plan, summary or evidence inputs); Phase 3 files that Phase 2 code now imports (packages/dispatcher/src/substrate_dispatcher/host.py, packages/mcp-server/src/server.ts /issue route, redact.ts), which Phase 3's own verification covers. The four hermes-linear-connector files (sync_engine.py, webhook_app.py and their tests) live in another repository and cannot be fingerprinted root-relative; that repository's HEAD is still 6e532fe, so they are unchanged since the original verification."
re_verification:
  date: "2026-09-26"
  reason: "verification.status reported stale: Phase 3 commits changed covered implementation files after the 2026-09-25 digest (55b4521)."
  previous_status: passed
  previous_score: 65/65
  previous_digest: "v1:sha256:f63511444e78c67751724d74285595f88646f463db4192b88b2b8fc8dc24b994"
  commits_touching_covered_files:
    - "7926c0b feat(03-02): issue_get service path — linear.ts, mirror.ts, service.ts (additive only)"
    - "71f06ef feat(03-02): issue_get MCP tool — mcp.ts (additive only; server.ts is not covered)"
    - "dda3758 feat(03-02): Hermes prompt uses issue_get and gains a release-and-stop step — launcher.py"
    - "41e1ed7 feat(03-05): dispatch:claude-code routed to substrate-host — dispatch.py (host.py new, not covered)"
    - "98cf59d feat(03-05): HostClient wired into the loop — __main__.py"
  gaps_closed: []
  gaps_remaining: []
  regressions: []
  superseded_as_planned:
    - "Truth 61 (D-11): dispatch:claude-code now launches (Phase 3 D-06, commit 41e1ed7), which D-11 itself deferred to Phase 3. Every other surface still gets the once-only not-dispatchable comment and keeps its label."
behavior_unverified: 0
overrides_applied: 5
overrides:
  - must_have: "Proof: Claude Code's brief shows the hermes claim within a minute of labelling the issue dispatch:hermes"
    reason: "Label → brief measured 65 s (delta_label_to_brief_s=65, within_60s=false): 24.5 s poll wait plus 40.1 s launch → claim, of which about 31 s is Hermes' pre_llm_call hook timeout. 02-09 predicted the miss (tracer_projected_within_60s=false). D-10's 30 s poll and the proof wording were locked, so the miss was recorded, not retried. Owner accepted it in 02-PROOF.md (owner_verified=approved 2026-09-25)."
    accepted_by: owner
    accepted_at: "2026-09-25"
  - must_have: "The dispatched Hermes session works the node it claimed and completes it itself through graph_complete and the DoD gate"
    reason: "The dispatched model claimed n1 but had no way to read the issue text (no Linear tool under -t terminal,file; its own LINEAR_API_KEY belongs to another workspace, both lookups returned Entity not found), so it stopped after the claim. The operator completed n1 with graph_complete as surface hermes with the claim session and DoD evidence (completion=operator); the connector's gate moved Linear to Done. 02-08 Task 1 allows this path and labels it. Owner accepted it in 02-PROOF.md."
    accepted_by: owner
    accepted_at: "2026-09-25"
  - must_have: "D-13: the launch argv is the hermes binary followed by chat --query-file <prompt>, cwd is the worktree, fixed-template prompt, graph_claim (surface hermes) before any work, never --yolo, never dispatch_handoff_to_hermes.sh"
    reason: "Model switch: Hermes' default claude-fable-5-1 hit an Anthropic per-model 429 on proof runs 2-4, so run 5 dispatched with SUBSTRATE_DISPATCH_MODEL=claude-opus-5.5 (be5e34d appends -m <model> to the planned argv; D-13 amended in 02-CONTEXT.md). Owner accepted it in 02-PROOF.md."
    accepted_by: owner
    accepted_at: "2026-09-25"
  - must_have: "D-16: the proof ran on a Linear issue created for it in the live team and on a graph minted for it; a repeated run uses a NEW throwaway issue and graph"
    reason: "SWC-467 and graph ut-mughkkc0-73909228 were created for the proof, but the Linear free-plan cap (249-250/250) allowed no new issue, so all five runs reused them (D-16 amended in 02-CONTEXT.md). Owner accepted it in 02-PROOF.md."
    accepted_by: owner
    accepted_at: "2026-09-25"
  - must_have: "substrate-dispatcher is left watching dispatch:<surface> labels after the proof (02-08 plan: dispatch_switch_final=0)"
    reason: "Owner directed 'keep dispatch off except during the proof': SUBSTRATE_DISPATCH_DISABLED=1 was appended at 06:54:08Z, so the live loop logs 'dispatch disabled' every tick (dispatch_switch_final=1). The watch mechanism itself was exercised live in run 5 and is verified separately. Owner accepted it in 02-PROOF.md."
    accepted_by: owner
    accepted_at: "2026-09-25"
gaps: []
---

# Phase 2: Claims and dispatch Verification Report

**Phase Goal:** Labelling a Linear issue for an agent starts that agent on that node.
**Verified:** 2026-09-26T00:23:44Z (re-verification; initial 2026-09-25T07:12:09Z)
**Status:** passed
**Re-verification:** Yes — covered files changed after the original verification (the digest went stale), not a gap closure

I checked the live systems myself (read-only) and ran the suites once. Labelling SWC-467 `dispatch:hermes` started a real Hermes session in the per-graph worktree. That session claimed n1 as hermes, and the claim reached the index, Linear, Notion and POST /brief. Completion went through the hermes-linear-connector DoD gate. Five owner-accepted deviations are carried as overrides. There are no other failures and no open human items.

## Re-verification 2026-09-26

`verification.status` reported `stale` because five Phase 3 commits changed covered implementation files after the 2026-09-25 digest (55b4521, 07:27:49Z). I re-checked every truth against HEAD `fb6ffa0`. All 65 still hold. The five owner overrides and the owner-approved live proof (02-PROOF.md, `owner_verified=approved 2026-09-25`) are carried forward unchanged, and I did not re-run any live Linear or Notion proof.

`git log --oneline 55b4521..HEAD -- <covered files>` lists nine commits. Four of them (8dcc7d2, 3f65046, 9b27d7d, 70e6c11) touch only `02-LINEAR-ARCHIVED.md`, which is not a covered file. The other five touch covered code:

| Commit | Covered files | Change | Phase 2 truths affected | Verdict |
| --- | --- | --- | --- | --- |
| 7926c0b feat(03-02) | `linear.ts` +12, `mirror.ts` +18, `service.ts` +50 (all `-0`) | New read-only `LinearClient.issueText`, `Mirror.issueText` and `Substrate.getIssue` (redacted, capped, framed as untrusted). `getIssue` emits no event and writes nothing to the index. `Mirror.issueText` makes one Linear GraphQL read and never calls Notion | 1–3, 10–14, 32–41 (claim/release/complete, mirror, D-06 gate, D-07) | Intact. The diff is additions only: `claimNode`, `releaseNode`, `completeNode`, `askGate` and `Mirror.run` are byte-for-byte unchanged; only their line numbers moved (+50) |
| 71f06ef feat(03-02) | `mcp.ts` +12 | Registers the `issue_get` tool | 14 (graph_find), MCP tool surface | Intact. Additions only; the graph_claim/release/complete/find registrations are unchanged |
| dda3758 feat(03-02) | `launcher.py` +25/−1 | Step (3) now fetches the issue with `issue_get` instead of "your Linear tool" (fixes WR-05, the root cause behind override 2); new step (5) releases as hermes with the claim session and stops; D-16 root-trust comment beside `CHILD_ENV_ALLOW` | 29, 30, 31 (D-13 argv/prompt, step 4 completes as hermes, child env allowlist) | Intact. `build_argv` is unchanged; the claim is still step (1); step (4) still completes as hermes with the claim session; `CHILD_ENV_ALLOW` is unchanged. Tests `test_render_prompt_orders_claim_then_issue_get_then_complete`, `test_render_prompt_step4_completes_as_hermes_with_the_claim_session` and `test_child_env_keeps_allowlist_and_drops_secrets` pass |
| 41e1ed7 feat(03-05) | `dispatch.py` +32/−10 | `DISPATCHABLE_SURFACES = {"hermes","claude-code"}`; `make_launch_fn` sends claude-code to `open_task` (substrate-host) after the same D-12 worktree step and keeps the hermes path; a `HostRefused` becomes a once-only comment | 4, 27, 48, 60–63 (label routing, graph_find before launch, D-12 worktree, D-11, D-14 cap) | Intact, with truth 61 superseded as planned: D-11 says "`dispatch:claude-code` is Phase 3", and Phase 3 D-06 now makes it launch. Other surfaces still get the once-only `not-dispatchable` comment and keep the label (`test_non_hermes_surface_comments_once_and_leaves_label`, surface `omp`). The hermes path still goes checkout → `ensure_worktree` → `launcher.launch` |
| 98cf59d feat(03-05) | `__main__.py` +7/−2 | Builds one `HostClient` and passes `open_task=host.launch` to `make_launch_fn`; closes it on exit | 45–49 (poll interval, switch, unit, launch path, lock) | Intact. `POLL_INTERVAL_SECONDS = 30`, and the lock and switch code are unchanged; `test_held_lock_exits_3_without_any_client` and the D-15 switch tests pass |

Nothing else changed. The covered planning files, `infra/vps/substrate-dispatcher.service`, `pyproject.toml`, `sessions.py`, `worktree.py`, `linear.py` (dispatcher), `mcp.py`, `config.ts`, `dod-gate.ts`, `index-store.ts`, `index.ts`, `notion.ts` and `types.ts` are identical to 55b4521. The hermes-linear-connector (DoD gate, truths 21–25) is still at `6e532fe`, with no commit since.

### Tests run for this re-verification (HEAD fb6ffa0)

| Command | Verbatim result |
| --- | --- |
| `SUBSTRATE_DISABLED=1 /root/.local/share/reflex/bun/bin/bun test packages/mcp-server` | `155 pass` / `0 fail` / `521 expect() calls` / `Ran 155 tests across 9 files. [564.00ms]` |
| `cd packages/dispatcher && python3 -m pytest -q` | `149 passed in 3.23s` |
| `bun test packages/mcp-server -t '<22 Phase 2 claim/ownership/gate/mirror/Notion test-name patterns>'` | `35 pass` / `0 fail` / `Ran 35 tests across 9 files. [432.00ms]` |
| `python3 -m pytest -q -k '<the 24 dispatcher tests this report cites by name>'` | `41 passed, 108 deselected in 0.38s` |

The original run recorded 128/0 (mcp-server) and 108 passed (dispatcher), then 114 after the review fix pass. The increases come from the Phase 3 tests for issue_get, the claude-code route, HostClient and RemoteTask. Every test this report cites by name still exists (checked against the `def test_` names in `packages/dispatcher/tests/*.py`) and passes. I did not re-run `tsc --noEmit` or the connector suite (the connector is unchanged).

### Live read-only checks (2026-09-26 00:22Z)

| What | Command | Observed |
| --- | --- | --- |
| Unit file | `diff infra/vps/substrate-dispatcher.service /etc/systemd/system/substrate-dispatcher.service` | identical |
| Services | `systemctl is-active substrate-mcp substrate-dispatcher substrate-host hermes-linear-api` | `active` ×4 |
| Switch | `sudo grep -c '^SUBSTRATE_DISPATCH_DISABLED=' …`; last matching line | 7 lines; last `SUBSTRATE_DISPATCH_DISABLED=1` (override 5 still describes the live state) |
| Dispatcher | `journalctl -u substrate-dispatcher -n 3` | `dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)` at 00:21:15, 00:21:45, 00:22:15 (30 s ticks) |

The "Live observations" table below is the original 2026-09-25 record and is kept as it was.

## Live observations (original verification, 2026-09-25 07:07–07:12Z)

| What | How | Observed |
| --- | --- | --- |
| Services | `systemctl is-active substrate-mcp substrate-dispatcher hermes-linear-api` | `active` ×3; dispatcher MainPID 1586416 since 06:48:56Z, `enabled` |
| Dispatcher | `journalctl -u substrate-dispatcher -n 5` | `dispatch disabled (SUBSTRATE_DISPATCH_DISABLED=1)` every 30 s, 07:05:30 → 07:07:30 |
| Switch / keys | `sudo grep -c` only; no value printed except the switch and model lines | last `SUBSTRATE_DISPATCH_DISABLED=1` (7 appended lines); `SUBSTRATE_DISPATCH_MODEL=claude-opus-5.5`; `LINEAR_API_KEY` ×1, `NOTION_API_KEY` ×1; file `600 root` |
| Graph | MCP `graph_get ut-mughkkc0-73909228` | graph `status Done`, repo `swcstudiospace/agent-substrate`; n1 `state completed`, `linear_issue_id 3378743f-…`, `SWC-467`, `notion_page 3e6bc1a0-…f812`, claim cleared |
| Linear SWC-467 | `sudo systemd-run … -p EnvironmentFile=/etc/substrate/substrate.env python3 /tmp/02-verify-read.py` (no key printed) | state `Done` (completed); labels `["agent:hermes"]`; comment `Claimed by hermes — session 20260925_065059_f7cea2 (graph ut-mughkkc0-73909228, node n1)` at 06:51:40.859Z; history 06:51:40.452Z Todo→In Progress `+agent:hermes −dispatch:hermes`, 06:53:39.619Z In Progress→In Review, 06:53:41.378Z In Review→Done |
| Notion row 3e6bc1a0-c7ae-8102-8a05-f31661fbc812 | same script, GET only | `Agent hermes`, `Status Done`, `Linear State Done`, `Completed 2026-09-25`, `Graph ID ut-mughkkc0-73909228`, `Issue ID SWC-467`; PR URL / PR # / PR State null, Repo / Branch empty |
| Events | same script, Greptime SQL on `agent_events` for the graph | `claim` hermes session 20260925_065059_f7cea2 n1 "claimed SWC-467" (ts 1790319098722 = 06:51:38.722Z); `complete` hermes same session "completed SWC-467" (06:53:43.683Z) |
| Hash chain | `POST /verify {graph_id}` | `{"ok":true,"events":2}` |
| Brief | `POST /brief {repo, surface claude-code}` scoped and unscoped | scoped: `Done · PR none yet`, `Nodes: n1 SWC-467 done`, `- 06:53 hermes completed SWC-467 (n1)`. The claim line (`06:51 hermes claimed SWC-467 (n1)`) has since dropped out of the 5-row recent-actions window because four later commits followed. The proof watch saw the claim in the brief at 06:51:38.154Z (`Nodes: n1 SWC-467 started by hermes just now`), and the 06:53:55Z brief in 02-PROOF.md shows both the claim and the completion |
| Hermes session | `hermes sessions export --redact --session-id 20260925_065059_f7cea2` | `source substrate-dispatcher`, `model claude-opus-5-5`, 7 tool calls; the first is the `graph_claim` curl with `"surface":"hermes"`; no `graph_complete` call |
| Worktree / main | `git worktree list`, `git branch --show-current`, `df` | `/var/lib/substrate/worktrees/ut-mughkkc0-73909228 f8133f0 [substrate/ut-mughkkc0-73909228]`; main checkout on `main`; 30G free |
| Lock | `sudo python3 -m substrate_dispatcher --once` while the unit runs | `Another substrate-dispatcher holds /var/lib/substrate/dispatcher/dispatcher.lock`, exit 3 |
| DoD route | `POST 127.0.0.1:8792/v1/complete-issue {}` | 422 (the route exists and rejects the body before any Linear call) |

## Goal Achievement

### Observable Truths

Roadmap success criteria and proof (the contract), then plan must-haves. Where a plan truth restates a roadmap criterion, it is folded into the roadmap row.

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | SC-1: `graph.claim` moves the Linear issue to started, adds `agent:<surface>`, posts a one-line comment with the session id, sets `Agent` on the Notion Issue row and writes `claimed_by` in the index | ✓ VERIFIED | Live: SWC-467 Todo→In Progress with `+agent:hermes`, claim comment carrying session 20260925_065059_f7cea2, Notion Agent `hermes`, claim event. 02-PROOF `graph_get_n1_at_claim` claimed_by hermes. `service.ts:245-300` (was 195-243; unchanged apart from the line shift) calls `this.mirror.claim` (line 273) only when `result.claimed`. mirror.test "moves to In Progress by name…", "posts one comment carrying the session id", "claim with Linear ok: one PATCH of exactly Agent and Linear State In Progress" pass |
| 2 | SC-1: a second agent asking for the same node gets the existing claim (D-04: no Linear/Notion writes, no event) | ✓ VERIFIED | Test "a losing claimer causes no Linear request, no event and no state write (D-04)" passes. 02-01-TRACER live loser: `graph_claim` as omp returned `{"claimed":false,"node":{…"claimed_by":"claude-code",…}}` with `loser_linear_unchanged=true` (updatedAt and comment count unchanged) |
| 3 | SC-2: `graph.release` and `graph.complete` mirror ultrathink-sync's state table; completion passes the hermes-linear-connector DoD gate | ✓ VERIFIED | Release goes to Todo and drops the agent label; complete goes to In Review and then the gate (`service.ts:339` mirror.release, `:397` mirror.review, `:445` dodGate.completeIssue, `:429` mirror.done; was 280/327/332/343). Tests: "the holder's release sends Linear to Todo…", "the holder with passing evidence: In Review, then the gate…", "a gate refusal…" pass (2026-09-26). 02-05-SMOKE: `release_state=Todo`, `refused_state=In Review`, `done_state=Done`. Live SWC-467: In Review at 06:53:39.619Z (substrate), then Done at 06:53:41.378Z (connector) |
| 4 | SC-3: substrate-dispatcher watches `dispatch:<surface>` on unstarted issues and starts a session for that Graph ID in a per-Graph-ID worktree; the label is removed and `agent:<surface>` added when the claim lands | ✓ VERIFIED | Run-5 journal: `tick: 1 candidate` → `launched hermes for SWC-467 graph ut-mughkkc0-73909228 node n1 … worktree /var/lib/substrate/worktrees/ut-mughkkc0-73909228` → `claim landed for SWC-467 (claimed_by, session 20260925_065059_f7cea2)`. The worktree is on `substrate/ut-mughkkc0-73909228`. The label swap is in the live Linear history. Dispatcher pytest 149 passed (2026-09-26). Since 41e1ed7, `dispatch:claude-code` also goes through the same worktree step before substrate-host (Phase 3), which widens this criterion without changing the hermes path |
| 5 | substrate-dispatcher is left watching dispatch:<surface> labels after the proof (02-08 plan: dispatch_switch_final=0) | PASSED (override) | Override: dispatch left off by owner direction (`SUBSTRATE_DISPATCH_DISABLED=1`; live journal `dispatch disabled`) — accepted by owner on 2026-09-25 |
| 6 | Proof: labelling a real issue `dispatch:hermes` starts a Hermes session that claims the node | ✓ VERIFIED | Live export of 20260925_065059_f7cea2: source substrate-dispatcher, first tool call `graph_claim` with surface hermes. The dispatcher launched it 24.5 s after the label (02-PROOF timeline); its cwd was the worktree (`/proc` in 02-PROOF) |
| 7 | Proof: the Notion Issue row shows Agent hermes | ✓ VERIFIED | Live GET: `Agent hermes`. The watch saw it at 06:51:43.586Z, 5.4 s after the claim |
| 8 | Proof: Claude Code's brief shows the hermes claim within a minute of labelling the issue dispatch:hermes | PASSED (override) | The brief showed `n1 SWC-467 started by hermes just now` at 06:51:38.154Z, 65 s after the label. Override: 65 s, not within 60 s — accepted by owner on 2026-09-25 |
| 9 | The dispatched Hermes session works the node it claimed and completes it itself through graph_complete and the DoD gate | PASSED (override) | The live export has no `graph_complete` call. The model could not read the issue: prompt step (3) said "with your Linear tool" (then `launcher.py:64`), but the session runs `-t terminal,file`. The operator completed n1 as hermes with the claim session. Override accepted by owner on 2026-09-25. Since dda3758 (Phase 3, 03-02) step (3) fetches the issue with `issue_get` (`launcher.py:71-74`), which removes this root cause for future runs; the override stands for the Phase 2 proof run |
| 10 | 02-01 D-01: the Linear mirror runs inside substrate-mcp's claimNode via a Mirror built from config.linearApiKey; LINEAR_API_KEY is in substrate.env exactly once | ✓ VERIFIED | `service.ts:273` calls `mirror.claim`; `mirror.ts` has `createMirror(config)`; `sudo grep -c` → 1; the journal shows `mirror: linear on, notion on` |
| 11 | 02-01 SC-1 detail: In Progress is resolved by name in the issue's team, `agent:<surface>` is added and every `dispatch:*` label is removed in the same issueUpdate, with one comment line | ✓ VERIFIED | mirror.test "moves to In Progress by name, never the other started state", "removes every dispatch:* label and leaves other labels alone", "a team with no state named In Progress fails the target instead of guessing" pass. Live history row 06:51:40.452Z does the state change, the add and the remove in one row |
| 12 | 02-01 D-02: the index claim lands first and is never rolled back; a Linear failure emits one warning (target linear); a same-session re-claim does not comment twice | ✓ VERIFIED | Tests "Linear answering 500 still claims, and leaves exactly one warning naming the target (D-02)", "a node with no Linear reference warns without calling Linear", "a same-session re-claim … does not comment twice" pass. 02-06-SMOKE events show the warning target linear |
| 13 | 02-01 D-03: `agent:<surface>` is reused or created on the team and applied with addedLabelIds; never labelIds or replaceTeamLabels | ✓ VERIFIED | mirror.test "reuses the team's own agent label", "reuses a workspace label (team null)", "creates the agent label … without replaceTeamLabels", "never sends labelIds…" pass |
| 14 | 02-01 graph_find resolves a Linear issue to exactly one node, or returns found:false (ambiguous/unknown) | ✓ VERIFIED | service tests "one node owning the issue id resolves…", "falls back to the identifier…", "two owning nodes are reported as ambiguous", "an issue on no node is reported as unregistered" pass; 02-01-TRACER live `find_found=true`; the dispatcher resolved SWC-467 live |
| 15 | 02-01 measured baseline recorded before the first edit; gates two-sided | ✓ VERIFIED | 02-BASELINE.md `agent-substrate-pass=76`, `agent-substrate-fail=0`, `tsc-exit=0`. Originally mcp-server `bun test` 128 pass / 0 fail and root `tsc --noEmit` exit 0; on 2026-09-26 `bun test packages/mcp-server` 155 pass / 0 fail (tsc not re-run) |
| 16 | 02-02 D-01: NOTION_API_KEY is present exactly once in substrate.env (0600 root) and was never printed | ✓ VERIFIED | `sudo grep -c '^NOTION_API_KEY='` → 1; `stat` → `600 root` |
| 17 | 02-02 02-NOTION-SCHEMA.md carries exactly one gap marker | ✓ VERIFIED | Only `notion_skipped=false` (line 6); 02-06-SMOKE mirrors it |
| 18 | 02-02 the integration can read the Agent Task Graph data source (HTTP 200) | ✓ VERIFIED | 02-NOTION-SCHEMA `data_source_http=200`, `page_read_http=200`; my live page GET succeeded |
| 19 | 02-02 observed types recorded for Agent, Status, Linear State, Completed, Level, Item, Graph ID, Issue ID, Linear URL | ✓ VERIFIED | 02-NOTION-SCHEMA table lines 58-66 (Agent rich_text, Status status, Linear State select, Completed date, …) |
| 20 | 02-02 D-07: PR-owned properties recorded only so later plans can prove they are never written | ✓ VERIFIED | 02-NOTION-SCHEMA lines 74-81; live row PR fields still null/empty after completion |
| 21 | 02-03 D-06: POST /v1/complete-issue is the only substrate Done path and decides through the shared `_done_allowed` predicate | ✓ VERIFIED | `sync_engine.py:195-199` (apply_kanban_status) and `:233-257` (complete_issue) both call `_done_allowed`; `webhook_app.py:126`; the route is live (422 on an empty body) |
| 22 | 02-03 a request without evidence and without a linked dod_pass returns completed:false with no Linear write or comment | ✓ VERIFIED | `test_complete_issue_refused_without_evidence_makes_no_linear_call`, `…whitespace_summary_is_refused`, `…summary_without_tests_pass_is_refused`, `…linked_without_dod_pass_is_refused`, `test_webhook_app::test_complete_issue_refused_without_evidence` all PASSED |
| 23 | 02-03 an allowed request makes exactly one issue_update to the completed state and returns completed:true | ✓ VERIFIED | `test_complete_issue_with_evidence_moves_issue_to_done_once` PASSED; live, SWC-467 went In Review→Done in one history row |
| 24 | 02-03 apply_kanban_status behaviour unchanged | ✓ VERIFIED | `test_apply_kanban_done_updates_linear`, `test_apply_kanban_done_refused_without_dod`, `test_mark_dod_then_done` PASSED |
| 25 | 02-03 connector suite two-sided against 02-03-BASELINE.md | ✓ VERIFIED | Baseline `connector-pass=49 fail=0 skip=2`; this run 60 passed, 2 skipped, 0 failed |
| 26 | 02-04 D-09: packages/dispatcher is a src-layout Python package with pytest tests on the system python3 | ✓ VERIFIED | `pyproject.toml` (unchanged); `python3 -m pytest -q` → 149 passed (2026-09-26); the unit runs `/usr/bin/python3 -m substrate_dispatcher` |
| 27 | 02-04 D-10: dispatch_candidates asks for unstarted issues carrying a `dispatch:`-prefixed label, one Candidate per label | ✓ VERIFIED | `test_dispatch_candidates_sends_poll_filter_and_splits_dispatch_labels` passes; `linear.py` has `startsWith` |
| 28 | 02-04 D-12: worktree `/var/lib/substrate/worktrees/<graph_id>` on `substrate/<graph_id>`, reused, refused under 5 GiB, graph_id validated | ✓ VERIFIED | `MIN_FREE_BYTES = 5 * 1024**3`; `test_ensure_worktree_disk_floor[…]` and `test_validate_graph_id_rejects[…]` pass; live worktrees on `substrate/<graph_id>` |
| 29 | D-13: the launch argv is the hermes binary followed by chat --query-file <prompt>, cwd is the worktree, fixed-template prompt, graph_claim (surface hermes) before any work, never --yolo, never dispatch_handoff_to_hermes.sh | PASSED (override) | The planned shape holds (`test_build_argv_shape_without_yolo_or_handoff_wrapper`, `test_render_prompt_carries_ids_and_claim_first`; live argv has no `--yolo` or wrapper). Run 5 added `-m claude-opus-5.5` (`test_build_argv_passes_the_dispatch_model_last`). Override: model switch — accepted by owner on 2026-09-25 |
| 30 | 02-04 the prompt's graph_complete step passes `"surface":"hermes"` and the same session id used for graph_claim | ✓ VERIFIED | `test_render_prompt_step4_completes_as_hermes_with_the_claim_session` passes (now slices step (4) up to the new step (5)); `launcher.py:80-82`. The live operator completion used those same arguments and passed the ownership check |
| 31 | 02-04 the Hermes child environment is an allowlist excluding LINEAR/NOTION keys, SUBSTRATE_PG_URL and GREPTIME_* | ✓ VERIFIED | `CHILD_ENV_ALLOW = ("HOME","PATH","LANG","LC_ALL","USER","LOGNAME","SHELL")`; `test_child_env_keeps_allowlist_and_drops_secrets` passes; the only Linear key the run-5 model found could see only workspace `swcstudio`/team `SPE` (Hermes' own), not substrate's SWC key |
| 32 | 02-05 D-08: EVENT_KINDS has release and complete; the events carry graph_id, repo, node_id; /verify stays ok | ✓ VERIFIED | `types.ts:36-37`; the live complete event has graph_id and node_id and appears in the repo-scoped brief; `POST /verify` → `{"ok":true,"events":2}` |
| 33 | 02-05 D-05: release by the holder sets Linear Todo, removes the agent label with removedLabelIds, clears the claim, sets unstarted and emits one release event | ✓ VERIFIED | Tests "the holder's release sends Linear to Todo, drops agent:<surface>, clears the claim and logs one release event" and "an issue without the agent label gets a state change only" pass; 02-05-SMOKE `release_state=Todo` |
| 34 | 02-05 D-06: complete by the holder sets In Review and started_review, then asks /v1/complete-issue; substrate never sends Done itself | ✓ VERIFIED | Test "a gate refusal … substrate only ever sent In Review" passes; `dod-gate.ts` posts to `/v1/complete-issue`; the live Done row came after substrate's In Review row |
| 35 | 02-05 D-06: refusal or unreachable gate → completed:false with reason, In Review stays, claim stays; allow → completed, released, completed:true | ✓ VERIFIED | Tests for the unreachable gate, a 502, a 200 without the flag, a timeout and a refusal all pass; 02-05-SMOKE `refused_reason=dod not passed…`; live proof response `{"completed": true, …, "claimed_by": null}` |
| 36 | 02-05 ownership: a release or complete from another surface or session is refused with zero Linear, connector or Notion requests and no event | ✓ VERIFIED | Tests "another surface is refused…", "the same surface in another session is refused…", "anyone on an unclaimed node is refused…" (release and complete) pass; 02-05-SMOKE `ownership_refused=true` |
| 37 | 02-05 D-02: a Linear failure during release or review emits a warning and never blocks the index change | ✓ VERIFIED | Tests "Linear answering 500 still releases… linear/release (D-02)" and "Linear failing on In Review warns (linear/review) and still reaches the gate (D-02)" pass |
| 38 | 02-06 D-05: graph_release clears Agent on the Notion Issue row | ✓ VERIFIED | mirror.test "release clears Agent and sets Linear State Todo (D-05)"; 02-06-SMOKE `claim_agent=claude-code` → `release_agent=` (empty) on a real row |
| 39 | 02-06 D-07: complete writes only Status, Linear State and Completed; no Notion request names a PR property; the writer refuses anything outside the four | ✓ VERIFIED | notion.test "NOTION_WRITABLE is exactly Agent, Status, Linear State, Completed" and "refuses <name> before any request"; mirror.test "no request … names a PR-owned property (D-07)"; the live row's PR fields are unchanged |
| 40 | 02-06 D-02: a Notion failure emits a warning (target notion) and never affects the claim or the Linear step | ✓ VERIFIED | mirror.test "a Notion error becomes a notion failure; the Linear step is unaffected", "a node with no notion_page…", "a page outside the Agent Task Graph is never PATCHed…" pass |
| 41 | 02-06 Notion Linear State mirrors what substrate just set on Linear, only after that Linear step succeeded | ✓ VERIFIED | mirror.test "claim with a Linear failure still sets Agent but leaves Linear State alone", "review after a Linear failure makes no Notion request at all"; live Notion `Linear State In Progress` at claim, then `Done` |
| 42 | 02-06 the live Notion smoke follows the single 02-02 marker | ✓ VERIFIED | `notion_skipped=false` in both files; 02-06-SMOKE observed Agent set and then cleared on a real row, `pr_fields_unchanged=true`, `row_trashed=true` |
| 43 | 02-07 D-14: at most 2 sessions, one per issue; a session ending without a claim gets one `[claim-timeout]` or `[exited-unclaimed]` comment, its label is removed, and it is added to given_up (timeout per the D-14 amendment: 15 min, 900 s) | ✓ VERIFIED | `CLAIM_TIMEOUT_SECONDS = 900` matches D-14 as amended in 02-CONTEXT.md (the plan's 600 s predates it). Tests `test_claim_timeout_outlasts_one_hermes_rate_limit_backoff`, `test_timeout_comments_removes_label_terminates_and_holds_slot`, `test_unclaimed_exit_comments_once_removes_label_and_gives_up`, `test_registry_cap_and_one_per_issue`, `test_given_up_issue_is_not_resolved_or_launched` pass. Live runs 1-3 posted `[exited-unclaimed]` and `[claim-timeout]` comments (02-PROOF) |
| 44 | 02-07 landed-claim evidence rule; unread evidence defers the decision | ✓ VERIFIED | `test_exit_with_landed_claim_found_at_exit_time_is_removed_quietly`, `test_not_evidence_makes_the_exit_unclaimed[6 cases]`, `test_unread_evidence_defers_the_decision_to_the_next_reap[…]` pass. Live: `claim landed … (claimed_by …)`, then `exited (code 0) after its claim` with no comment |
| 45 | 02-07 D-10: the loop polls every 30 s | ✓ VERIFIED | `POLL_INTERVAL_SECONDS = 30  # D-10`; live journal ticks 30 s apart |
| 46 | 02-07 D-15: appending SUBSTRATE_DISPATCH_DISABLED=1 stops launches on the next tick without a restart; `systemctl stop` ends the loop and its children | ✓ VERIFIED | Live: `=1` appended at 06:54:08Z; `dispatch disabled` at 06:54:30Z under the same MainPID 1586416. `test_disabled_env_file_makes_no_client_call` and `test_env_file_value_wins_over_process_env` pass. The unit keeps the default KillMode=control-group with `TimeoutStopSec=15`. Stopping the unit while a child ran was not exercised; it rests on systemd's control-group semantics (see Info) |
| 47 | 02-07 D-09: the repo unit is installed, reads the EnvironmentFile, runs `/usr/bin/python3 -m substrate_dispatcher`, and is active | ✓ VERIFIED | `diff` of the repo unit against `/etc/systemd/system/substrate-dispatcher.service` is identical; `active`, `enabled` |
| 48 | 02-07 D-12/D-13 on the live path: the loop launches only via make_launch_fn (repo_checkout → ensure_worktree → launcher.launch) | ✓ VERIFIED | `__main__.py:144 launch_fn=make_launch_fn(log=log, open_task=host.launch)`; `dispatch.py:237` onward: hermes candidates still go checkout → `ensure` → `launch`, and claude-code candidates take the same worktree step before `open_task` (Phase 3 D-06); the run-5 launch line names the per-graph worktree |
| 49 | 02-07 only one process can hold dispatcher.lock; a second real-mode run exits 3 without polling | ✓ VERIFIED | Live run of `--once` at 07:10Z → `Another substrate-dispatcher holds …dispatcher.lock`, exit 3; `test_held_lock_exits_3_without_any_client` passes (now `main([])`). Since WR-04 (41c5089) `--once` without `--dry-run` exits 2 before the lock, so the real-mode lock probe is the no-flag run |
| 50 | D-16: the proof ran on a Linear issue created for it in the live team and on a graph minted for it; a repeated run uses a NEW throwaway issue and graph | PASSED (override) | SWC-467 and ut-mughkkc0-73909228 were created for the proof. Every Linear read went through graph_get's `linear_issue_id`. Runs 2-5 reused them. Override: one issue reused across runs — accepted by owner on 2026-09-25 |
| 51 | 02-08 proof timing: UTC timestamps for label, launch, claim, Linear In Progress, Notion Agent and brief, with delta_label_to_brief_s and within_60s; a miss is recorded, not retried | ✓ VERIFIED | 02-PROOF result lines `t_label … t_brief`, `delta_label_to_brief_s=65`, `within_60s=false`, each exactly once at column 0 |
| 52 | 02-08 tracer prediction consumed before the switch flip | ✓ VERIFIED | 02-PROOF `tracer_projected_within_60s=false`, `tracer_delta_launch_to_claim_s=48` in Setup; Gaps 1 names the confirmed miss |
| 53 | 02-08 with notion_skipped=false the observed Notion outcomes are the SC-1/SC-2 ones | ✓ VERIFIED | Live row: Agent hermes, Status Done, Linear State Done, Completed 2026-09-25, PR fields unchanged |
| 54 | 02-08 D-12: free disk ≥ 5 GB recorded before the worktree was created | ✓ VERIFIED | `free_disk_gb_before=29`; live `df` 30G |
| 55 | 02-08 credential rule: substrate.env only probed with `grep -c` and only appended to; keyed calls run under systemd-run EnvironmentFile; no key printed | ✓ VERIFIED | 7 appended switch lines, last one wins (tested), plus the owner-authorized model line; no key appears in any phase file. My reads used the same pattern |
| 56 | 02-08 nothing asserted that was not observed; model vs operator actions labelled | ✓ VERIFIED | 02-PROOF quotes the export and labels `completion=operator`. My live export confirms no model `graph_complete` |
| 57 | 02-08 one column-0 line per verify key; failed runs indented under `## Failed runs` | ✓ VERIFIED | Each of 27 keys counts 1 at column 0; one `## Gaps` heading |
| 58 | 02-09 dispatch tracer: one real Hermes session launched through tick → make_launch_fn → … → launch on a throwaway issue and graph, and it claimed n1 as hermes | ✓ VERIFIED | 02-09-TRACER: SWC-466 / ut-mugbqivi-752f2dad, `claim_evidence=claimed_by`, `claim_session=20260925_021057_7310e5` = export id; its worktree still exists on `substrate/ut-mugbqivi-752f2dad` |
| 59 | 02-09 label-to-claim latency measured before the proof | ✓ VERIFIED | `delta_label_to_claim_s=49`, `delta_launch_to_claim_s=48`, `projected_within_60s=false` |
| 60 | 02-09 D-10: a tick polls dispatch candidates and resolves each through graph_find before deciding | ✓ VERIFIED | `test_valid_unclaimed_hermes_candidate_launches_once` passes; `dispatch.py` calls `graph_find`; live launches |
| 61 | 02-09 D-11: only dispatch:hermes can launch; other surfaces get one once-only comment and keep the label | ✓ VERIFIED (superseded as planned) | D-11 reads "Phase 2 dispatches `dispatch:hermes` only … `dispatch:claude-code` is Phase 3". Phase 3 D-06 (41e1ed7) added claude-code to `DISPATCHABLE_SURFACES` (`dispatch.py:24`), as D-11 anticipated. Every other surface still gets one once-only `not-dispatchable` comment and keeps its label: `test_non_hermes_surface_comments_once_and_leaves_label` (surface `omp`) passes; the comment text now names both launchable surfaces |
| 62 | 02-09 a launch needs exactly one registered, unclaimed node; otherwise one once-only comment | ✓ VERIFIED | Decision-table tests in `test_dispatch.py` pass (149/0 suite, 2026-09-26) |
| 63 | 02-09 D-14 cap and tracer bound | ✓ VERIFIED | `test_registry_cap_and_one_per_issue`, `test_at_capacity_skips_and_decides_again_next_tick` pass; the tracer supervised a single session |
| 64 | 02-09 D-15: last-line-wins switch; disabled tick makes no Linear/MCP call | ✓ VERIFIED | `test_disabled_env_file_makes_no_client_call`, `test_env_file_value_wins_over_process_env`, `test_process_env_decides_when_file_lacks_key`, `test_unreadable_env_file_falls_back_to_process_env` pass; live `dispatch disabled` with the last line `=1` |
| 65 | 02-09 D-12 on the live path: disk recorded ≥ 5 GB, main checkout stayed on main | ✓ VERIFIED | 02-09-TRACER disk record; live `git branch --show-current` → `main` |

**Score:** 65/65 truths verified (60 verified, 5 passed by override; 0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `packages/mcp-server/src/linear.ts` | LinearClient, `issueUpdate` | ✓ VERIFIED | 201 lines; used by mirror |
| `packages/mcp-server/src/mirror.ts` | claim/release/review/done, Linear + Notion | ✓ VERIFIED | `addedLabelIds`, `In Review`, `updatePage`; built in `createMirror` |
| `packages/mcp-server/src/notion.ts` | NotionClient, NOTION_WRITABLE, 2025-09-03 | ✓ VERIFIED | used by mirror when `notionApiKey` is set; journal `notion on` |
| `packages/mcp-server/src/dod-gate.ts` | POST /v1/complete-issue, never throws | ✓ VERIFIED | called at `service.ts:445` (unchanged file) |
| `packages/mcp-server/src/service.ts` | claim/release/complete with ownership, mirror, gate, events | ✓ VERIFIED | `this.mirror.claim`, `kind: "release"`, `dodGate.completeIssue` |
| `packages/mcp-server/src/index-store.ts`, `mcp.ts` | findNodesByLinear, graph_find, graph_release/complete args | ✓ VERIFIED | graph_find in the live `tools/list` |
| `packages/mcp-server/src/types.ts`, `config.ts` | release/complete kinds; hermesLinearUrl | ✓ VERIFIED | lines 36-37; config test passes |
| `packages/dispatcher/src/substrate_dispatcher/*.py` | linear, mcp, worktree, launcher, dispatch, sessions, __main__ | ✓ VERIFIED | 149 tests pass (2026-09-26); the live service runs this code |
| `infra/vps/substrate-dispatcher.service` | EnvironmentFile, SUBSTRATE_ENV_FILE | ✓ VERIFIED | identical to the installed unit |
| hermes-linear-connector `sync_engine.py`, `webhook_app.py` | `complete_issue`, `/v1/complete-issue` | ✓ VERIFIED | 16 targeted tests pass; route live |
| Phase evidence docs (02-BASELINE, 02-03-BASELINE, 02-01-TRACER, 02-05-SMOKE, 02-NOTION-SCHEMA, 02-06-SMOKE, 02-09-TRACER, 02-PROOF) | the plans' `contains` markers | ✓ VERIFIED | markers present (`agent-substrate-pass=`, `connector-pass=`, `linear_issue_id=`, `done_state=`, `notion_skipped=`, `delta_label_to_claim_s=`, `delta_label_to_brief_s=`) |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| service.ts claimNode | mirror.ts | `this.mirror.claim` only when claimed | ✓ WIRED | `service.ts:248,273` |
| mirror.ts | linear.ts | one `updateIssue` per transition | ✓ WIRED | live single history row for state + labels |
| mcp.ts graph_find | index-store.ts | `findNodesByLinear` | ✓ WIRED | the dispatcher resolved SWC-467 live |
| service.ts completeNode | dod-gate.ts → connector | `dodGate.completeIssue` → POST /v1/complete-issue | ✓ WIRED | live In Review → Done by the connector |
| connector route | SyncEngine.complete_issue → `_done_allowed` | shared predicate | ✓ WIRED | `sync_engine.py:199,257` |
| mirror.ts | notion.ts | `updatePage` after `getPage` | ✓ WIRED | live Notion writes |
| dispatcher tick | graph_find, make_launch_fn → ensure_worktree → launch | Popen in the worktree | ✓ WIRED | run-5 journal and /proc cwd |
| sessions.py reap | graph_get + Linear `Claimed by` comments | landed-claim rule | ✓ WIRED | live `claim landed … (claimed_by …)` |
| unit | substrate.env switch | EnvironmentFile + SUBSTRATE_ENV_FILE re-read every tick | ✓ WIRED | live switch flip without a restart |
| Hermes graph_claim | Linear, Notion, POST /brief | claimNode → Mirror.claim → claim event | ✓ WIRED | all three observed |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| brief node line | `claimed_by` | Postgres index `graph_nodes` | yes: `started by hermes`, then `done` | ✓ FLOWING |
| brief recent actions | claim/complete events | Greptime `agent_events` | yes: live rows for session 20260925_065059_f7cea2 | ✓ FLOWING |
| Notion Agent / Status / Linear State / Completed | mirror writes | Notion API PATCH | yes: live GET | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| mcp-server suite (2026-09-26) | `SUBSTRATE_DISABLED=1 bun test packages/mcp-server` | 155 pass, 0 fail (originally 128/0) | ✓ PASS |
| Type check | `bunx tsc --noEmit` | exit 0 (2026-09-25; not re-run) | ✓ PASS |
| Claim, ownership, gate and Notion tests (2026-09-26) | `bun test packages/mcp-server -t '<22 patterns>'` | 35 pass, 0 fail | ✓ PASS |
| Dispatcher suite (2026-09-26) | `python3 -m pytest -q` (packages/dispatcher) | 149 passed (originally 108) | ✓ PASS |
| Cited dispatcher tests (2026-09-26) | `python3 -m pytest -q -k '<24 names>'` | 41 passed, 108 deselected | ✓ PASS |
| Connector suite | `python3 -m pytest -q` (hermes-linear-connector) | 60 passed, 2 skipped (2026-09-25; repo unchanged at 6e532fe) | ✓ PASS |
| Connector gate tests | `pytest -rA -k 'complete or apply_kanban_done or mark_dod_then_done'` | 16 PASSED (2026-09-25) | ✓ PASS |
| Lock exclusivity | `sudo python3 -m substrate_dispatcher --once` | exit 3, lock held (2026-09-25) | ✓ PASS |
| DoD route live | `curl -X POST :8792/v1/complete-issue -d '{}'` | 422 (2026-09-25) | ✓ PASS |

### Probe Execution

No probes are declared in the phase plans, and none exist under `scripts/*/tests/probe-*.sh`. Step 7c: SKIPPED.

### Requirements Coverage

Every plan declares `requirements: []`, and there is no `.planning/REQUIREMENTS.md`. The roadmap success criteria are the contract and are covered as truths 1-9.

### Anti-Patterns Found

No TBD, FIXME, XXX, TODO, HACK or placeholder markers appear in any changed implementation file (agent-substrate `git diff 585f06d HEAD -- packages infra`, non-test files; connector `sync_engine.py`, `webhook_app.py`).

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| `packages/dispatcher/src/substrate_dispatcher/launcher.py` | 64 (at 55b4521) | Prompt step (3) said "read issue … with your Linear tool", but the session has no Linear tool (`-t terminal,file`), and Hermes' own key is for another workspace | ⚠️ Warning (owner-accepted, truth 9) — resolved by dda3758 (03-02, `issue_get`, now `launcher.py:71-74`) | The Phase 2 proof run could claim but could not learn the task; future dispatched runs can read it through `issue_get` |

Re-verification anti-pattern scan: no TBD, FIXME, XXX, TODO, HACK or placeholder markers in the five changed covered files at HEAD.

### Info (not gaps)

- The 30 s Hermes `pre_llm_call` hook timeout accounts for about 31 s of the 40 s launch → claim time. [INFERENCE: name match only] The enabled langfuse plugin defines `on_pre_llm_call`. This is the main reason the proof missed 60 s.
- Linear history shows `dispatch:hermes` re-added at 06:51:42.643Z and removed at 06:51:43.215Z, after the claim mirror. The source was not identified. The model's tool calls contain no label writes, and the final labels are `["agent:hermes"]`.
- Run 1's `prompt_toolkit.document` import crash is unexplained and did not reproduce.
- D-15 `systemctl stop` with a live child was not exercised. The unit keeps the default KillMode=control-group, and Hermes is a Popen child in the unit's cgroup (its parent was MainPID in run 5), so a stop kills it. [INFERENCE: systemd semantics, not observed.]
- The live brief no longer lists the 06:51 claim, because it fell out of the 5-row recent-actions window after later commits. The claim event persists in Greptime, and the proof observed it in the brief at the time.
- The 02-06 smoke graph `ut-mufsocbe-c7ced745` n1 still points `notion_page` at the trashed smoke row. That harmless leftover would produce a notion warning if it were ever claimed.

### Human Verification Required

None. The owner's checkpoint (02-08 Task 3) is recorded as `owner_verified=approved 2026-09-25`, and every Phase 2 truth was observed live or exercised by a passing test in this run.

### Gaps Summary

There are no gaps. Five truths pass by owner override, all recorded in 02-PROOF.md on 2026-09-25:
1. Label → brief took 65 s, not within a minute.
2. The operator, not the dispatched model, completed n1 through the DoD gate, because the model could not read the issue.
3. The dispatch model was switched to claude-opus-5.5.
4. SWC-467 and its graph were reused across the five runs.
5. Dispatch was left off after the proof.

Of the two root causes behind overrides 1 and 2, Phase 3 (03-02, dda3758) fixed the prompt's missing Linear tool with `issue_get`. The Hermes `pre_llm_call` hook timeout is still open; 03-CONTEXT lists it under deferred ideas.

Re-verification 2026-09-26: no regressions and no new gaps. Truth 61 is superseded as planned by Phase 3 D-06; see "Re-verification 2026-09-26" above.

---

_Verified: 2026-09-25T07:12:09Z; re-verified 2026-09-26T00:23:44Z at fb6ffa0_
_Verifier: Claude (gsd-verifier)_
