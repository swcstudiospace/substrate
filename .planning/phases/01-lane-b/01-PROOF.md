# Phase 1 Lane B — cross-surface proof

Recorded 2026-09-24 by plan 01-09. Observed output only. A surface that did not show what the ROADMAP proof requires is a gap, not a pass.

## Identifiers

- graph_id: `ut-mufsocbe-c7ced745`
- repo: `swcstudiospace/agent-substrate`
- branch: `main`
- nodes: `n1`, `n2` (target of the handoff was n2)
- handoff_id: `20260924T171800Z-3fb834d5`
- session key: `hermes:grok-handoff:20260924T171800Z-3fb834d5`

## Task 1 — regression sweep

Measured 2026-09-24T17:11Z against `.planning/phases/01-lane-b/01-BASELINE.md`. Pass condition used here, per the execution assignment: passed count at or above the baseline row; failed count must not differ in either direction; failing node ids must match the baseline set. Passed-count rises that match tests Lane B added are not treated as repairs.

systemd (`systemctl is-active` then `systemctl show`):

```
substrate-mcp                 active  running  enabled
substrate-collector-grok      active  running  enabled
substrate-collector-herdr     active  running  enabled
substrate-collector-muse      active  running  enabled
grok-hermes-connector         active  running  enabled
hermes-linear-api             active  running  enabled
hermes-linear-poller          active  running  enabled
```

All seven named units reported `active`.

Suite comparison:

| Repo | Command | Baseline row | Observed | Failed-count gate |
|---|---|---|---|---|
| hermes-plugin | `python3 -m pytest -q` | 234 passed / 0 failed | `239 passed in 26.09s` | 0 == 0. Pass. +5 matches 01-02. |
| hermes-engineering-board | `.venv/bin/python -m pytest -q` | 76 passed / 0 failed | `82 passed, 1 warning in 6.83s` | 0 == 0. Pass. +6 matches 01-03. |
| hermes-linear-connector | `.venv/bin/python -m pytest -q` | 49 passed / 0 failed (2 skipped) | `49 passed, 2 skipped in 0.71s` | exact match. Pass. |
| mcp | `.venv/bin/python -m pytest -q` | 99 passed / 2 failed | `2 failed, 112 passed in 6.18s` (exit 1) | 2 == 2. Same two node ids. Pass. +13 matches 01-05. |
| omp-ultrathink | `bun run test` | no row | `58 pass / 0 fail` across 10 files | no baseline row to differ from. Failed count 0. See note. |
| claude-ultrathink-grok | `bun test` | 246 passed / 0 failed at `0066755` (floor once 01-08 adds tests) | `259 pass / 0 fail` across 23 files | 0 == 0. No failing node id. Pass. Matches 01-08's post-edit count, not used as the baseline. |
| agent-substrate | `bun test` | 62 passed / 0 failed (floor) | `76 pass / 0 fail` across 8 files | 0 == 0. Pass. |
| claude-ultrathink | `bun test` (validation table, not in the plan's `&&` chain) | 279 passed / 5 failed | `286 pass / 5 fail` across 25 files (exit 1) | 5 == 5. Same five node ids. Pass under the at-or-above rule. |

mcp failing node ids, unchanged:

1. `tests/test_dedupe_waiter.py::test_wait_for_hermes_job_tracks_status_file` — `assert 'failed' == 'completed'`
2. `tests/test_tasks_skills.py::test_health_lists_new_capabilities` — `'0.4.0'.startswith('0.3')` is false

claude-ultrathink failing node ids, unchanged:

1. `src/think/pipeline.test.ts > runThink > calls complete once for the graph then each node in order; later call sees earlier conclusion` — expected length 4, received 6
2. `src/think/pipeline.test.ts > runThink > node throw uses the question and continues` — expected `Q2`, received the subproblem question
3. `src/think/pipeline.test.ts > runThink concurrency > fills independent nodes together but never before their predecessors` — expected 2, received 1
4. `src/claude/hook.test.ts > runPromptSubmit > uplift + think + track: additionalContext carries the kickoff instruction, record carries the plan` — expected length 3, received 5
5. `src/claude/hook.test.ts > runPromptSubmit > no git remote detected: repo/branch stay undefined, tracking still proceeds` — expected length 3, received 5

The plan's single `&&` verify chain cannot exit 0: mcp pytest exits 1 on those two pre-existing failures, which the two-sided gate requires to remain. That is a verify-harness fact, not a new regression, and those tests were not repaired.

omp-ultrathink note: `01-BASELINE.md` has no row. `bun run test` (the plan command) observed 58 pass / 0 fail. STATE.md's post-01-07 note said 62 pass / 0 fail. Failed count did not appear. This drop is recorded, not repaired.

## Task 2 — ROADMAP proof

Health before the proof:

```
GET http://127.0.0.1:7410/healthz
{"index":true,"greptime":true}
HTTP 200

GET http://127.0.0.1:8788/health
{"status":"ok","service":"grok-hermes-connector","version":"0.4.0",...}
HTTP 200
```

### Step 1 — mint the graph

Command: `POST http://127.0.0.1:7410/mcp` JSON-RPC `tools/call` `graph_register` with `graph_id=ut-mufsocbe-c7ced745`, `repo=swcstudiospace/agent-substrate`, `branch=main`, `surface=grok-bot`, nodes `n1` and `n2` state `unstarted`.

Observed: HTTP 200, both nodes stored, `claimed_by` null, `created` `2026-09-24T17:17:18.092Z`.

### Step 2 — handoff_to_hermes

Command: `POST http://127.0.0.1:8788/mcp` JSON-RPC `tools/call` `handoff_to_hermes` with Bearer `CONNECTOR_TOKEN` (not printed), `graph_id=ut-mufsocbe-c7ced745`, idempotency key `01-09-proof-ut-mufsocbe-c7ced745`, goal text telling Hermes to claim node n2 and not edit files.

Unauthenticated call first returned HTTP 401 `invalid_token`. Authenticated call returned HTTP 200:

```
handoffId: 20260924T171800Z-3fb834d5
status: submitted
briefPath: /var/lib/grok-hermes/handoffs/20260924T171800Z-3fb834d5.md
hermes.pid: 103498
hermes.dispatch: /root/agent-scripts/dispatch_handoff_to_hermes.sh
```

Connector journal at 17:18:01: `POST http://127.0.0.1:7410/events "HTTP/1.1 202 Accepted"`.

Greptime row for this graph_id (one row):

```
ts=1790270281110 surface=grok-bot kind=handoff repo=null
graph_id=ut-mufsocbe-c7ced745 node_id=null
session_id=20260924T171800Z-3fb834d5
summary=Handoff to Hermes: Lane B proof claim n2 ut-mufsocbe-c7ced745
```

`POST /verify` `{"graph_id":"ut-mufsocbe-c7ced745"}` returned `{"ok":true,"events":1}`.

The handoff event landed and carries this graph_id. It does not carry `repo` or `node_id`. The dispatch script's own prompt overrides the claim-only goal and tells Hermes to implement code. That wrapper was not edited.

### Step 3 — Hermes finish / claim

The dispatch child was pid 103762 (`hermes chat -q`), status file `/tmp/hermes-handoffs/jobs/grok-hermes-20260924T171800Z-3fb834d5.status` read `completed` while the process was still alive. Log file was 81 bytes:

```
⚠️  Normalized model 'claude-fable-5.1' to 'claude-fable-5-1' for anthropic.
```

After about three minutes the process was sleeping on `futex_wait_queue`. `graph_get` still showed n1 and n2 `unstarted`, `claimed_by` null. No claim event. The process was killed (`kill -9`) so the implement-wrapper would not start editing `/root`. A live Hermes model session did not finish node n2.

GAP: Hermes did not claim node n2 of graph_id `ut-mufsocbe-c7ced745`. Index claim is absent.

### Step 4 — Omp discovery

Live Omp session was not started. Command:

```
pi -ne -e /root/src/repos/omp-ultrathink/index.ts -p "implement a no-op comment for graph ut-mufsocbe-c7ced745"
```

Observed:

```
Error: Failed to load extension "/root/src/repos/omp-ultrathink/index.ts": Failed to load extension: The "path" argument must be of type string. Received undefined
```

Real HTTP brief the discovery path would inject (`POST /brief` and MCP `memory_brief`, repo `swcstudiospace/agent-substrate`, graph_id `ut-mufsocbe-c7ced745`, surface `omp`):

```
## Substrate brief: swcstudiospace/agent-substrate @ main — ut-mufsocbe-c7ced745
unstarted · Agent grok-bot · PR none yet
Nodes: n1 unstarted · n2 unstarted

Last 5 agent actions in this repo
- 17:09 cursor       commit 7f10f57 docs(01-08): complete Grok Build brief delivery plan
- 17:08 grok-build   delivered substrate brief (608 bytes)
- 16:32 cursor       commit 2933f1c docs(01-03): complete eng-board substrate forwarding plan (owner-approved checkpoint)
- 14:30 cursor       commit 023874e docs(01-05): complete grok-hermes-connector v0.4 substrate bridge plan
- 12:50 cursor       commit 9286a60 docs(01-07): record windows ledger + state.json for the substrate bridge plan
```

That text names the graph and two unstarted nodes. It does not name the handoff (the event's `repo` is null, and the brief's recent-action query filters on repo). It does not name a claim.

GAP: Omp discovery does not name both the handoff and the claim. No live Omp model session ran.

### Step 5 — Muse brief file

`SUBSTRATE_MUSE_REPOS` is `hermes-plugin:omp-ultrathink:hermes-engineering-board:hermes-linear-connector`. `swcstudiospace/agent-substrate` is not in that list.

`.substrate/BRIEF.md` in `/root/src/repos/agent-substrate` (mtime 2026-09-24 11:48:50, 135 bytes):

```
## Substrate brief: /root/src/repos/agent-substrate @ main
No substrate history for this repo yet. You are the first muse session here.
```

That file is not current. A Muse model session was not started and did not quote it.

`/root/src/repos/hermes-plugin/.substrate/BRIEF.md` and `/root/src/repos/omp-ultrathink/.substrate/BRIEF.md` were refreshed by the muse collector (last lines are `muse delivered brief` at 17:13 and 17:18). Neither file names this graph_id, the handoff, or a claim.

GAP: Muse brief for the proof repo is stale, and no Muse session quoted a brief that names the handoff and the claim.

### Step 6 — Grok Build session file

No model quotation was observed. Do not treat the file below as a model quote.

The installed shim was invoked for real:

```
PATH=/usr/bin:/bin /root/.grok/installed-plugins/ultrathink-53674ac1/bin/substrate-brief
stdin: UserPromptSubmit cwd=/root/src/repos/agent-substrate
shim_exit=0
```

Wrote `/root/.grok/plugin-data/ultrathink/substrate-brief.md` (651 bytes, 2026-09-24 17:21:36):

```
## Substrate brief: swcstudiospace/agent-substrate @ main

Last 5 agent actions in this repo
- 17:09 cursor       commit 7f10f57 docs(01-08): complete Grok Build brief delivery plan
- 17:08 grok-build   delivered substrate brief (608 bytes)
- 16:32 cursor       commit 2933f1c docs(01-03): complete eng-board substrate forwarding plan (owner-approved checkpoint)
- 14:30 cursor       commit 023874e docs(01-05): complete grok-hermes-connector v0.4 substrate bridge plan
- 12:50 cursor       commit 9286a60 docs(01-07): record windows ledger + state.json for the substrate bridge plan

Other open graphs here: ut-mufsocbe-c7ced745 (grok-bot, unstarted)
```

The file is current for repo actions and names this graph_id as an open graph. It does not name the handoff event or a claim. A Grok Build model session was not started and did not state what the other agents did.

GAP: no Grok Build model quoted the brief. The session file does not name the handoff or the claim.

## Gaps (verbatim)

1. Hermes did not claim node n2 of graph_id `ut-mufsocbe-c7ced745`. Index claim is absent. The dispatched `hermes chat` slept after a model-normalization line; the status file read `completed` with no claim. Process killed so the implement wrapper would not edit the tree.
2. The handoff event landed (`kind=handoff`, `graph_id=ut-mufsocbe-c7ced745`, `session_id=20260924T171800Z-3fb834d5`) but `repo` and `node_id` are null, so the repo-scoped brief does not list it.
3. Omp discovery does not name both the handoff and the claim. `pi -e` failed to load the extension (`path` argument undefined). No live Omp model session ran.
4. Muse `.substrate/BRIEF.md` in the proof repo is stale (`No substrate history for this repo yet`) because that repo is not in `SUBSTRATE_MUSE_REPOS`. No Muse session quoted the handoff or the claim.
5. No Grok Build model quoted the brief. The shim-written session file names the open graph and does not name the handoff or the claim.
