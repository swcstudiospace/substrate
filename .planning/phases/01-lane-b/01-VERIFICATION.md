---
phase: 01-lane-b
verified: 2026-09-24T18:33:06Z
status: passed
score: 10/10 must-haves verified (2 accepted by owner human validation 2026-09-24)
human_validation: "Owner selected 'All good — continue' on 2026-09-24. Accepted: Hermes claim of n2 by session 20260924_182534_fe7fa2 counts as the finish; live Omp, Grok Bot, Grok Build and Muse model sessions not run."
overrides_applied: 0
behavior_unverified: 0
covered_files:
  - .planning/ROADMAP.md
  - .planning/phases/01-lane-b/01-01-PLAN.md
  - .planning/phases/01-lane-b/01-01-SUMMARY.md
  - .planning/phases/01-lane-b/01-02-PLAN.md
  - .planning/phases/01-lane-b/01-02-SUMMARY.md
  - .planning/phases/01-lane-b/01-03-PLAN.md
  - .planning/phases/01-lane-b/01-03-SUMMARY.md
  - .planning/phases/01-lane-b/01-04-PLAN.md
  - .planning/phases/01-lane-b/01-04-SUMMARY.md
  - .planning/phases/01-lane-b/01-05-PLAN.md
  - .planning/phases/01-lane-b/01-05-SUMMARY.md
  - .planning/phases/01-lane-b/01-06-PLAN.md
  - .planning/phases/01-lane-b/01-06-SUMMARY.md
  - .planning/phases/01-lane-b/01-07-PLAN.md
  - .planning/phases/01-lane-b/01-07-SUMMARY.md
  - .planning/phases/01-lane-b/01-08-PLAN.md
  - .planning/phases/01-lane-b/01-08-SUMMARY.md
  - .planning/phases/01-lane-b/01-09-PLAN.md
  - .planning/phases/01-lane-b/01-09-SUMMARY.md
  - .planning/phases/01-lane-b/01-10-PLAN.md
  - .planning/phases/01-lane-b/01-10-PROOF.md
  - .planning/phases/01-lane-b/01-10-SUMMARY.md
  - .planning/phases/01-lane-b/01-BASELINE.md
  - .planning/phases/01-lane-b/01-PROOF.md
  - .planning/phases/01-lane-b/CONTEXT.md
  - packages/collectors/src/herdr-map.ts
  - packages/collectors/src/herdr.ts
  - packages/collectors/src/muse.ts
  - packages/mcp-server/src/brief.ts
  - packages/mcp-server/src/types.ts
  - packages/projector/src/muse.ts
covered_digest: "v1:sha256:a63ae9f3be274b8b6624b911f602583d53a666f0403d40756985f4ce93e34772"
re_verification:
  previous_status: gaps_found
  previous_score: 6/10
  gaps_closed:
    - "A handoff event is visible to a repo-scoped brief"
    - "Muse .substrate/BRIEF.md in the proof repo is a current brief"
    - "Hermes claims node n2 from a Grok Bot handoff; POST /brief as omp names both the handoff and the claim (code and live data)"
    - "Integrations exist, events land, and the brief the surfaces read now carries the handoff (code and live data)"
  gaps_remaining: []
  regressions: []
gaps: []
human_verification:
  - test: "Decide whether a claim-only Hermes session satisfies 'Hermes finishes node n2', or have Hermes mark n2 completed"
    expected: "Either a human accepts claimed_by=hermes / claim_session=20260924_182534_fe7fa2 as the finish, or graph_get shows n2 state=completed by hermes"
    why_human: "A real Hermes model session (claude-fable-5-1, 2 API calls, 1 terminal tool call) claimed n2 at 18:26:16Z without editing the tree. graph_get still shows n2 state=unstarted. 'Finish' versus 'claim' is a scope judgment."
  - test: "Start Omp in the proof repo and send an implementation-shaped prompt"
    expected: "Discovery calls memory_brief and the model's context names both '18:24 grok-bot Handoff to Hermes ... (n2)' and '18:26 hermes claimed node (n2)'"
    why_human: "The /brief text Omp would inject was observed live and names both facts. No Omp model session ran; the earlier pi -e launch failed to load the extension."
  - test: "From a Grok Bot model session, call memory_brief, then handoff_to_hermes with graph_id, repo and node_id"
    expected: "The model states work another surface did, and the new handoff row carries graph_id, repo and node_id"
    why_human: "The 01-10 handoff was made through the connector's authenticated MCP API, not by a Grok Bot model."
  - test: "Start a Grok Build session in swcstudiospace/agent-substrate and ask what other agents did"
    expected: "The model quotes the session brief file, including the handoff and the hermes claim"
    why_human: "Grok Build discards hook stdout. The session file /root/.grok/plugin-data/ultrathink/substrate-brief.md was last written 17:21Z, before the handoff and claim existed. No Grok Build session ran."
  - test: "Start Muse in the proof repo, ask it to quote .substrate/BRIEF.md, and run one tool"
    expected: "The model quotes the current collector-written brief, and a muse tool.call event lands"
    why_human: "The file is current (collector rewrote it at 18:32:07Z) but no Muse model session ran. Note: the file is keyed by checkout path, so it does not list the slug-keyed handoff and claim; a human should decide whether that is acceptable for the Muse surface."
---

# Phase 1: Lane B Verification Report

**Phase Goal:** Hermes, Omp, Muse Code, Grok Build and Grok Bot all read the brief and emit events.
**Verified:** 2026-09-24T18:33:06Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (01-10)

All four code-and-live gaps from the 17:37Z report are closed on live observation. No regressions. What remains is model-session evidence: no Grok Bot, Omp, Muse or Grok Build model session ran, and Hermes claimed n2 rather than completing it. Those items are human verification, not gaps. D-01's TypeScript-engine bridge and Kanban retirement are out of scope and not counted.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Hermes, Omp, Muse Code, Grok Build and Grok Bot all read the brief and emit events | ? HUMAN NEEDED | Every surface has events in the store (grok-bot handoff 2, grok-build 6, herdr 133, hermes 6, muse 383, omp 2). The repo-scoped brief now carries the handoff and the claim. The Muse file is current. No model quotation of a brief by Omp, Muse, Grok Build or Grok Bot was observed. |
| 2 | Hermes reads the brief and emits events additively on `on_pre_llm_call`, no TS engine bridge (D-01) | ✓ VERIFIED (regression) | `hook.py` still references `fetch_brief`/`emit_event`/`SUBSTRATE_BRIEF`. |
| 3 | `hermes_kanban_create` unchanged; connector dispatch untouched; eng-board calls `events_emit` | ✓ VERIFIED (regression) | `__init__.py:244` still passes `create_task=hermes_kanban_create`. `hooks_session.py` still has `emit_event` and `work_unit_store`. |
| 4 | herdr `events.subscribe` collector on the 0.9.1 contract | ✓ VERIFIED (regression) | `herdr.ts` unchanged in shape; `substrate-collector-herdr` active; herdr rows now 114 `agent.status` + 19 `note`. |
| 5 | Omp `memory_brief`; Grok Build file + rule; Muse `.substrate/BRIEF.md` fallback | ✓ VERIFIED (regression) | `swe.ts` calls `memory_brief`/`events_emit`. Installed rule is byte-identical to the repo copy (`cmp` exit 0). `uplift.ts` calls `deliverSubstrateBrief`/`fetchBrief`. |
| 6 | Connector v0.4 forwards four tools; `handoff_to_hermes` records a handoff with its Graph ID | ✓ VERIFIED (regression) | `server.py` registers `memory_brief`, `memory_write`, `events_emit`, `graph_get`. New handoff row has `graph_id=ut-mufsocbe-c7ced745`. |
| 7 | Hermes finishes node n2 from a Grok Bot handoff; Omp's next prompt lists both the handoff and the claim | ? HUMAN NEEDED | Live: `graph_get` n2 `claimed_by=hermes`, `claimed_at=2026-09-24T18:26:16.407Z`, `claim_session=20260924_182534_fe7fa2`, `state=unstarted`. `POST /brief` as omp names `18:26 hermes claimed node (n2)` and `18:24 grok-bot Handoff to Hermes ... (n2)`. Open: claim versus finish, and no Omp or Grok Bot model session. |
| 8 | A handoff event is visible to a repo-scoped brief | ✓ VERIFIED | mcp `63fd450` adds `repo`/`node_id` to `handoff_to_hermes` and forwards both on `substrate_ext.emit` (working tree `server.py:620-621`). Connector restarted 18:21:33Z, after the 18:21:28Z commit. Row `evt_1ddb0a2c572849ce86b2616b77bc0589`: `repo=swcstudiospace/agent-substrate`, `node_id=n2`. The two handoff tests pass (`2 passed in 1.41s`). The row appears in the omp brief. |
| 9 | Muse `.substrate/BRIEF.md` in the proof repo is a current brief | ✓ VERIFIED | `SUBSTRATE_MUSE_REPOS` is a single line with five roots including `/root/src/repos/agent-substrate` (read with `sudo grep`, values not printed beyond paths; file still `600 root root`). Collector journal: `delivered briefs to 5 repo(s)`. File mtime `18:32:07Z`, 406 bytes, lists muse deliveries at 18:21 and 18:27. |
| 10 | Every Lane B service and collector is active under systemd | ✓ VERIFIED (regression) | All seven units `active` at 18:31Z. `GET /healthz` → `{"index":true,"greptime":true}` HTTP 200. |

**Score:** 8/10 truths verified. 2 need human verification. 0 failed.

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `/root/src/repos/mcp/src/grok_hermes_connector/server.py` | Handoff emit with graph_id, repo, node_id | ✓ EXISTS + SUBSTANTIVE + WIRED | `63fd450` is an ancestor of mcp HEAD; working tree still forwards both args; the running process started after the commit. |
| `/root/src/repos/mcp/tests/test_handoff_pack.py` | Pass-through test | ✓ EXISTS + PASSING | `test_handoff_to_hermes_emits_repo_and_node_id` and the graph_id test: `2 passed`. |
| `/etc/substrate/substrate.env` | Proof repo on the Muse list | ✓ EXISTS + WIRED | One `SUBSTRATE_MUSE_REPOS=` line, five `/root/src/repos/` roots, proof repo present. |
| `/root/src/repos/agent-substrate/.substrate/BRIEF.md` | Current collector-written brief | ✓ CURRENT | Rewritten 18:32:07Z by the collector; no longer the 11:48 stub. Gitignored by `.gitignore:14`. |
| `.planning/phases/01-lane-b/01-10-PROOF.md` | Observed proof | ✓ EXISTS | Every live fact it records was re-observed here (rows, graph_get, brief text, session export). |
| Phase 1 artifacts from the initial report | Unchanged | ✓ No regression | `brief.ts` and `muse.ts` last touched by earlier plans; not modified by 01-10. |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `handoff_to_hermes` | Greptime `agent_events` | `substrate_ext.emit(repo, node_id, graph_id)` | ✓ WIRED | Row carries all three. |
| repo-scoped brief | handoff row | `brief.ts` repo filter | ✓ WIRED | Handoff line appears in `POST /brief` for `swcstudiospace/agent-substrate`. |
| Hermes session | `graph_claim` | terminal `curl` to `:7410/mcp` | ✓ WIRED | Session export shows one `terminal` call with `graph_claim` for n2, surface hermes, own session id; tool output `claimed: true`. |
| claim | omp brief | `claim` event with repo and graph_id | ✓ WIRED | Row `evt_f3cc3d13277e489cab0632a00b78f723`; brief line `hermes claimed node (n2)` and `n2 started by hermes`. |
| muse collector | proof-repo `BRIEF.md` | `SUBSTRATE_MUSE_REPOS` | ✓ WIRED | Five repos delivered; file refreshed on the 5-minute cycle. |
| earlier key links (hook.py, eng-board, herdr, swe.ts, uplift.ts) | - | - | ✓ No regression | Quick greps as in truths 2-5. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| --- | --- | --- | --- | --- |
| Omp brief text | recent actions | Greptime rows filtered by repo slug | Yes: handoff and claim rows for the proof graph | ✓ REAL |
| `graph_get` n2 | claim fields | substrate index after `graph_claim` | Yes: `claimed_by=hermes`, session `20260924_182534_fe7fa2` | ✓ REAL |
| Proof-repo `BRIEF.md` | brief body | muse collector, keyed by checkout path | Yes: current path-keyed history | ✓ REAL; does not include slug-keyed events (see human item 5) |
| Grok session file | brief body | installed shim | Written 17:21Z, before the proof events | ⚠️ Not refreshed since; refreshed only on a Grok Build prompt |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| health | `GET :7410/healthz` | `{"index":true,"greptime":true}` 200 | pass |
| omp brief | `POST :7410/brief` `{"repo":"swcstudiospace/agent-substrate","graph_id":"ut-mufsocbe-c7ced745","surface":"omp"}` | 200. `Nodes: n1 unstarted · n2 started by hermes 5 min ago`; lines `18:26 hermes claimed node (n2)` and `18:24 grok-bot Handoff to Hermes: Lane B 01-10 proof claim n2 ut-mufsocbe-c7ced745 (n2)` | pass |
| verify | `POST :7410/verify` graph_id | `{"ok":true,"events":3}` | pass |
| graph_get | MCP `tools/call` `graph_get` on `:7410/mcp` | n1 unstarted/unclaimed; n2 unstarted, `claimed_by=hermes`, `claimed_at=2026-09-24T18:26:16.407Z`, `claim_session=20260924_182534_fe7fa2` | pass (claim, not completion) |
| handoff row | Greptime SQL on graph_id | old 01-09 row still `repo=null`; new row `surface=grok-bot kind=handoff repo=swcstudiospace/agent-substrate node_id=n2 session_id=20260924T182453Z-bb506df2` | pass |
| Hermes attribution | `hermes sessions export --format jsonl --session-id 20260924_182534_fe7fa2 -` | source `oneshot`, model `claude-fable-5-1`, cwd proof repo, `api_call_count=2`, `output_tokens=249`, `tool_call_count=1` (terminal curl `graph_claim` n2), final reply `session_id=20260924_182534_fe7fa2 claimed=true claimed_by=hermes`; started 18:25:38Z, ended 18:27:13Z | pass |
| mcp commit | `git show 63fd450` | +`repo`/`node_id` params; `node_id=node_id, repo=repo` on the handoff emit; ancestor of HEAD | pass |
| handoff tests | `pytest -q` on the two handoff tests | `2 passed in 1.41s` | pass |
| Muse list | `sudo grep` on `/etc/substrate/substrate.env` | 1 line, 5 roots, proof repo listed; 600 root root | pass |
| Muse file | `stat` + read `.substrate/BRIEF.md` | mtime 18:32:07Z, 406 bytes, collector text | pass |
| systemd | `systemctl is-active` on seven units | all active | pass |

Tree safety for the Hermes run is taken from 01-10-PROOF.md (ReadOnlyPaths sandbox, unchanged porcelain and content hashes). This verifier observed the agent-substrate porcelain now matches the pre-proof snapshot listed there.

### Probe Execution

No probe scripts are declared for this phase.

### Requirements Coverage

No `.planning/REQUIREMENTS.md`. Coverage is against ROADMAP Phase 1.

| Requirement | Status | Blocking Issue |
| --- | --- | --- |
| SC1 additive Hermes brief and events; no TS engine | ✓ SATISFIED | - |
| SC2 Kanban unchanged; connector dispatch untouched; eng-board `events_emit` | ✓ SATISFIED | - |
| SC3 herdr collector on 0.9.1 | ✓ SATISFIED | - |
| SC4 Omp `memory_brief`, Grok file+rule, Muse `BRIEF.md` | ✓ SATISFIED | Proof repo now on the Muse list. |
| SC5 four connector tools; handoff carries Graph ID | ✓ SATISFIED | Handoff also carries repo and node_id. |
| ROADMAP proof | ? HUMAN NEEDED | Claim observed, not completion; Omp brief text observed, no Omp model prompt. |
| Phase goal: all five read and emit | ? HUMAN NEEDED | Events from all five; brief text current; no model quotations. |

### Decision Coverage

D-01 holds: no TypeScript-engine bridge, Kanban create still wired. D-02 holds: herdr collector active. D-03 holds: 01-10 did not touch the two mcp baseline failures (per 01-10-SUMMARY; not re-run here).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| `/tmp/hermes-handoffs/jobs/grok-hermes-20260924T182453Z-bb506df2.status` | - | status stays `running` because the wrapper was SIGKILLed | Info | Proof artifact only; the live handoff path still launches the implement wrapper by design. |

The two blockers from the initial report are resolved.

## Human Verification Required

### 1. Hermes finish of n2

**Test:** Decide whether the claim-only session counts as "finishes", or have Hermes mark n2 completed.
**Expected:** Acceptance of `claimed_by=hermes` / `claim_session=20260924_182534_fe7fa2`, or `graph_get` n2 `state=completed`.
**Why human:** A real Hermes model session claimed n2 without editing the tree. The node is claimed, not completed.

### 2. Omp live discovery

**Test:** Start Omp in the proof repo and send an implementation-shaped prompt.
**Expected:** Discovery names both the grok-bot handoff and the hermes claim of n2.
**Why human:** The brief text was observed live; no Omp model session ran.

### 3. Grok Bot session

**Test:** From a Grok Bot model session, call `memory_brief`, then `handoff_to_hermes` with `graph_id`, `repo` and `node_id`.
**Expected:** The model states work another surface did; the handoff row carries all three fields.
**Why human:** The 01-10 handoff came from the connector API, not a Grok Bot model.

### 4. Grok Build model quotation

**Test:** Start Grok Build in the proof repo and ask what other agents did.
**Expected:** The model quotes the session brief, including the handoff and the claim.
**Why human:** Hook stdout is discarded; the session file predates the proof events; no session ran.

### 5. Muse model quotation

**Test:** Start Muse in the proof repo, ask it to quote `.substrate/BRIEF.md`, and run one tool.
**Expected:** The model quotes the current collector-written brief and a muse `tool.call` lands.
**Why human:** No Muse model session ran. The file is keyed by checkout path and does not list the slug-keyed handoff and claim; whether that is acceptable for this surface is a judgment call.

## Gaps Summary

No code or live-data gaps remain. The previous four gaps are closed:

1. **Handoff attribution** — closed by mcp `63fd450`; live row has repo and node_id.
2. **ROADMAP proof data** — a real Hermes session claimed n2; the omp brief names the handoff and the claim.
3. **Muse proof-repo brief** — proof repo on the list; file current.
4. **Five-surface read (code and data)** — the brief the surfaces read now contains the cross-surface facts; model-read evidence moved to human verification.

Not gaps: the TypeScript-engine bridge and Kanban retirement (D-01), and the two pre-existing mcp baseline failures.

---

_Verified: 2026-09-24T18:33:06Z_
_Verifier: gsd-verifier (re-verification)_
