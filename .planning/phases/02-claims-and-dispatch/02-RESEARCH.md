# Phase 2: Claims and dispatch - Research

**Researched:** 2026-09-24
**Domain:** Linear GraphQL + Notion mirroring inside substrate-mcp (TS/bun); new Python poller `substrate-dispatcher`; hermes-linear-connector DoD gate
**Confidence:** HIGH on code/Linear schema (read this session / live introspection); LOW on Notion property types (no Notion credential on host)

## Summary

Most of Phase 2 is small, well-seamed work: `service.ts` claim/release/complete gain a best-effort mirror step, `types.ts` gains two event kinds, and a new Python poller launches `hermes chat`. The Linear schema has all needed primitives (verified by live introspection): additive `issueAddLabel`/`issueRemoveLabel` (or `issueUpdate(addedLabelIds/removedLabelIds)`), `issueLabelCreate(teamId)`, `commentCreate`, `issueUpdate(stateId)`, and label+state-type issue filters.

**Five findings change CONTEXT.md assumptions — resolve before or in Wave 0:**

1. **`LINEAR_API_KEY` and `NOTION_API_KEY` are NOT in `/etc/substrate/substrate.env`** (count 0 each; file keys: GREPTIME_*, SUBSTRATE_PG_URL, SUBSTRATE_HOST/PORT, NOTION_TASK_GRAPH_DS, SUBSTRATE_MUSE_REPOS). D-01 says "config.ts already loads" them — it reads the vars (`config.ts:58-59`) but production never sets them. The Linear key exists in `/root/.config/hermes-linear/connector.env` (used by hermes-linear-api/poller units). **No Notion integration token exists anywhere readable on the host** (searched ~/.config, ~/.hermes, ~/.claude, /etc/substrate, agent-scripts). Agents reach Notion via hosted OAuth MCP only. → Human prerequisite: create a Notion internal integration, share the "🧩 Agent Task Graph" DB with it, add `NOTION_API_KEY` to substrate.env; copy `LINEAR_API_KEY` into substrate.env. Without the Notion token the proof's "Notion Issue row shows Agent hermes" cannot pass.
2. **DoD gate is keyed on Hermes Kanban task ids, not Linear issues.** `POST /v1/mark-dod` takes `kanban_task_id` and, with `mark_done:true`, projects Done with `dod_pass=True` unconditionally (`webhook_app.py` mark_dod → `apply_kanban_status(..., dod_pass=True)`); the gate in `sync_engine.py:185-203` only refuses Done when `dod_pass` is falsy *for a linked Kanban task*. Substrate-created Linear issues have no Kanban link. `POST /v1/ensure-task` would create one but also creates a Hermes Kanban card on board `eng` (side effect). There is **no endpoint that says "move Linear issue X to Done iff DoD passed"**. D-06 needs a concrete routing decision (see Open Questions Q1).
3. **No reverse lookup Linear issue → (graph_id, node_id).** MCP tools are `memory_brief, memory_write, memory_search, events_emit, graph_get, graph_register, graph_claim, graph_release, graph_complete` (`mcp.ts`). The dispatcher sees a Linear issue and must find its node. Needs a new read tool (e.g. `graph_find` by `linear_issue_id`/`linear_identifier`) or index query.
4. **"In Review" is not a Linear state type.** Live team SWC states: `In Review`=type `started` (ac410939), `In Progress`=`started` (ba47bd1b), `Todo`=`unstarted`, `Done`=`completed`, etc. `started_review` is a hermes-linear config *key* (`factory.py:31-36`), so the mirror must resolve states by **name within the issue's team** (Todo / In Progress / In Review / Done) or by the config ids — not by `type`. `started` by type is ambiguous (two states).
5. **The brief only says "started by hermes" when the Claude Code session is scoped to that graph.** For other open graphs in the repo it renders `graph_id (surface, status, N nodes started)` (`brief.ts:134-150`, max 4 graphs), omitting the surface of the claimer. The proof's "brief shows it" will instead be satisfied by the `claim` event line in "Last N agent actions in this repo" (surface `hermes`, summary `claimed <identifier>`), since the claim event carries `repo` (`service.ts:~139-160`). Plan the proof check against that line, or scope the brief to the graph.

Also: backfilled nodes have `linear_issue_id = null` (backfill maps only `linear_identifier`, `backfill.ts:139-148`); the Phase-1 proof graph `ut-mufsocbe-c7ced745` has all Linear/Notion fields null (live `graph_get`). Mirroring must no-op cleanly (with a warning event) when `linear_issue_id`/`notion_page` are null; Linear `issue(id:)` also accepts identifiers like `SWC-12` [ASSUMED — standard Linear API behaviour, not probed], so fallback to `linear_identifier` is possible.

**Primary recommendation:** Wave 0 = credentials + Notion schema read + DoD routing decision + `graph_find`; Wave 1 = TS Linear/Notion mirror clients + service wiring + event kinds (unit-tested with injected fetch); Wave 2 = Python dispatcher + unit; Wave 3 = live proof.

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Mirroring runs inside `substrate-mcp`'s claim path (TypeScript, `packages/mcp-server/src/service.ts` claim/release/complete), using `LINEAR_API_KEY` and `NOTION_API_KEY` that `config.ts` already loads. — costly
- **D-02:** The index claim is authoritative and lands first. Linear/Notion mirroring is best-effort: on failure emit a `warning` event carrying graph_id/node_id and the failed target; the next claim/release on that node retries the mirror. Never roll back the index claim because a mirror failed.
- **D-03:** `agent:<surface>` is create-or-reuse per team and added additively — never overwrite the issue's other labels.
- **D-04:** A second claimer gets the existing claim (`claimed:false` plus the node), as today, and triggers no Linear or Notion writes.
- **D-05:** `graph_release`: move the Linear issue back to Todo (`unstarted`), remove `agent:<surface>`, clear `Agent` on the Notion Issue row, emit a `release` event.
- **D-06:** `graph_complete`: move Linear to In Review (`started_review`), then route Done through `hermes-linear-connector`'s DoD gate. Do not re-implement the gate. If DoD has not passed, return `completed:false` with the reason and leave the issue in In Review. — costly
- **D-07:** `ultrathink-sync` keeps ownership of PR fields (PR URL, PR #, PR State, Repo, Branch). `graph_complete` writes only Notion Status, Linear State and Completed.
- **D-08:** Add `release` and `complete` to `EVENT_KINDS`; both events carry graph_id, repo and node_id. — costly
- **D-09:** Python package `packages/dispatcher` in this repo plus a systemd unit under `infra/vps/`.
- **D-10:** Poll Linear every 30 s for unstarted issues carrying a `dispatch:*` label. No webhook.
- **D-11:** Phase 2 dispatches `dispatch:hermes` only. Any other `dispatch:<surface>` gets one Linear comment ("surface not dispatchable yet") and is left alone.
- **D-12:** Worktree at `/var/lib/substrate/worktrees/<graph_id>` via `git worktree add` on branch `substrate/<graph_id>`, reused if present. Refuse when free disk on `/` < 5 GB.
- **D-13:** Launch Hermes with `hermes chat` directly, cwd = the worktree, prompt = claim first then work. Never use `/root/agent-scripts/dispatch_handoff_to_hermes.sh`.
- **D-14:** At most 2 concurrent dispatched sessions, one per issue. No claim within 10 minutes → comment, remove `dispatch:` label, no retry.
- **D-15:** Kill switch `SUBSTRATE_DISPATCH_DISABLED=1` in `/etc/substrate/substrate.env`, plus stopping the unit.
- **D-16:** Proof uses a new throwaway issue in the live Linear team on a new graph for `swcstudiospace/agent-substrate`. Resolve the issue via the node's `linear_issue_id`; never hardcode a team prefix.

### Claude's Discretion
- Internal structure of Linear/Notion client modules in TS, dispatcher module layout, test fixtures.
- Exact Linear GraphQL mutations for label add/remove and comment create, provided D-03 holds.

### Deferred Ideas (OUT OF SCOPE)
- Dispatch for omp, grok-build, muse, other surfaces; Linear webhook ingress; forwarding claim/release/complete through grok-hermes-connector.

## Project Constraints (from AGENTS.md)
No CLAUDE.md. `AGENTS.md` only directs agents to read `.substrate/BRIEF.md` at start of work (written on a schedule; never edit by hand). No `.claude/skills` or `.agents/skills` in repo.

## Architectural Responsibility Map

| Capability | Tier | Rationale |
|---|---|---|
| Exclusive claim | Postgres index (`index-store.ts:176-199`) | authoritative (D-02) |
| Linear/Notion mirror | substrate-mcp service (`service.ts`) | D-01 |
| Done-gate decision | hermes-linear-connector (8792) | D-06 |
| Issue polling, worktree, process launch | substrate-dispatcher (Python, systemd) | D-09/10/12 |
| Claim call | Hermes session via `curl` to `:7410/mcp` | Hermes has no substrate MCP server configured (`~/.hermes/config.yaml` mcp_servers: filesystem, memory, sequential-thinking, linear, ai-agency, drop, hermes-bridge — no substrate) |

## Findings by Question

### Q1 Linear GraphQL (live introspection, read-only) [VERIFIED: api.linear.app introspection 2026-09-24]
Mutation args:
```
issueAddLabel    (id: String, labelId: String)
issueRemoveLabel (id: String, labelId: String)
issueLabelCreate (input: IssueLabelCreateInput, replaceTeamLabels: Boolean)
issueUpdate      (id: String, input: IssueUpdateInput)
commentCreate    (input: CommentCreateInput)
```
`IssueUpdateInput` includes `labelIds` (overwrites), **`addedLabelIds`, `removedLabelIds`** (additive), `stateId`. `IssueLabelCreateInput`: `id, name, description, color, parentId, isGroup, retiredAt, groupType, teamId`. `CommentCreateInput`: `body, issueId, …, doNotSubscribeToIssue`. `IssueLabelFilter`: `id, createdAt, updatedAt, name, isGroup, creator, team, parent, and, or`.

Recommendation: one `issueUpdate(id, {stateId, addedLabelIds:[agentLabel], removedLabelIds:[dispatchLabel]})` per transition — atomic, additive (satisfies D-03). Never pass `labelIds`. Never pass `replaceTeamLabels:true` to `issueLabelCreate`.

Label create-or-reuse: query `issueLabels(filter:{name:{eq:"agent:hermes"}})` returning `team{id}`; reuse a label whose team is the issue's team **or** is null (workspace label); else `issueLabelCreate({name, teamId})`. Linear rejects a team label whose name duplicates a workspace label [ASSUMED]; handle the error by re-querying. Live: **no `agent:*` or `dispatch:*` labels exist yet** (query returned `[]`) — first claim creates `agent:hermes`; proof operator must create `dispatch:hermes` (team SWC) to label the issue.

Polling filter verified valid (returned `{"nodes":[]}`):
```graphql
issues(first:50, filter:{labels:{name:{startsWith:"dispatch:"}}, state:{type:{eq:"unstarted"}}}){ nodes{ id identifier team{id key} labels{nodes{id name}} } }
```
Rate limits (response headers): `x-ratelimit-requests-limit: 2500` (per hour, API key), `x-ratelimit-complexity-limit: 3000000`. 30 s polling = 120 req/h; fine.

### Q2 Where the node's Linear issue lives [VERIFIED: index-store.ts:52-63]
```
graph_nodes ( graph_id, node_id, linear_issue_id text, linear_identifier text, notion_page text,
              state text, claimed_by text, claimed_at timestamptz, claim_session text, primary key (graph_id,node_id))
```
`graph_register` node input: `{node_id, linear_issue_id?, linear_identifier?, notion_page?, state?}` (`mcp.ts:~135-143`); upsert with `coalesce` (`index-store.ts:121-127`). The claim returns `returning *` so `linear_issue_id`/`notion_page` are available right after the claim without another query.
Live Linear: exactly one team — `SWC` id `5371e279-c76c-4e84-b8df-254bf5fbfc27`, name `spectrumwebco`; states match `/root/.config/hermes-linear/config.yaml` ids. `SPE-` identifiers in backfilled Notion rows come from another/older workspace/team key; since only SWC is visible to this key, `SPE-*` nodes will likely fail to resolve → warning event, not error [INFERENCE]. Recommendation: resolve state ids from `issue{ team{ states{ nodes{id name type} } } }` per issue (one query, cacheable per team) — do not hardcode config ids.

### Q3 Notion [PARTIAL — no credential]
- "Issue row" = a row in the **🧩 Agent Task Graph** data source `be3418f0-d2d8-411b-8677-fa8a95ee63be` (`config.ts:60` default; ultrathink skills) with `Level = "Issue"`, `Item = "[nN] Title"`, `Graph ID`, `Linear URL`, `Issue ID` (kickoff SKILL.md:68). There is no separate Issues DB.
- Node → page: `graph_nodes.notion_page` (backfill stores the row URL, `backfill.ts:139-146`; kickoff "keep page ID/URL"). Mirror must accept URL or bare id (extract 32-hex id).
- `Agent` property: `backfill.ts:18` comment says "Notion's `Agent` is free text"; kickoff writes `"claude-code"` string. Type (rich_text vs select) **unverified** [ASSUMED rich_text or select]. Wave 0 must `GET /v1/data_sources/{id}` once the token exists and pin exact types/options.
- Status/Linear State/Completed: names from ultrathink skills: `Status` (values used: Planning, Implementing, Done, Failed, Blocked, Merged), `Linear State` (Todo/In Progress/In Review/Done), `Completed` (date). Type of `Status` (status vs select) unverified.
- Repo has **no Notion HTTP client** and no `Notion-Version` anywhere (backfill-run reads a JSON file). Data sources require API version `2025-09-03` [CITED: developers.notion.com/docs/upgrade-guide-2025-09-03]; page property updates are `PATCH /v1/pages/{page_id}`.
- **ultrathink-sync state table** (`claude-ultrathink/skills/ultrathink-sync/SKILL.md:18-28`, verbatim):

| Situation | Notion properties to set | Linear mirror |
|---|---|---|
| A pull request was just opened | `PR URL`, `PR #`, `Repo`, `Branch`, `PR State = "Open"` | move the Linear issue(s) for this task to their "In Review" workflow state |
| CI/checks reported | `Checks` (`"Pending"` / `"Passing"` / `"Failing"` / `"Blocked"`) | — |
| Reviewers assigned | `Reviewers` | — |
| The PR was approved | `PR State = "Approved"` | — |
| The PR was merged | `PR State = "Merged"`, `Status = "Merged"`, `Completed` = now | move the Linear issue(s) to "Done" |
| Work stopped without a PR (research/investigation task) | `Status = "Done"` (or `"Failed"`/`"Blocked"` if it didn't finish), `Completed` = now if terminal | move the Linear issue(s) to match |
| Still in progress, just checking in | `Status = "Implementing"` (leave as-is if already there) | — |

"Set `Linear State` on the Notion row to mirror whatever you just set on the actual Linear issue(s)." Note: this table targets the **Task** row and has **no release row**; D-05 (release → Todo) is new behaviour, not a mirror.

### Q4 DoD gate path [VERIFIED: sync_engine.py:169-242, webhook_app.py, config.yaml]
- `apply_kanban_status(kanban_task_id, hermes_status, dod_pass, metadata)`: requires a `store.get_by_kanban` link; for `done` with `require_dod_for_done` (live: true), refuses unless `dod_pass` (or stored meta `dod_pass`) → posts a Linear comment "Hermes card marked done without DoD (tests_pass/summary); Linear stays open until dod_pass is set." and returns False.
- `POST /v1/mark-dod {kanban_task_id, summary, tests_pass, review_pass, role, mark_done}` → records `dod_pass: True` metadata unconditionally, and if `mark_done` projects Done → `{"ok":true,"kanban_task_id":…,"done_projected":bool|null}`. 404 on unknown task.
- `GET /v1/link?linear_issue_id=…` → link + `metadata` (incl. `dod_pass`) or 404.
- `POST /v1/ensure-task {linear_issue_id}` → creates Hermes Kanban task (`created_by="linear-sync"`) + link.
- **Auth: none** on any route; bound to `127.0.0.1:8792` (config `server`). Service `hermes-linear-api.service` active; `GET /health` → `{"ok":true}`.
- Poller (`poller.py`) is Kanban→Linear only, skips unlinked tasks; nothing projects Linear→Hermes automatically (`apply_linear_state` has no caller outside the engine). So no collision with substrate-created issues.
- Practical `completed:false` reasons: `"no hermes-linear link for <issue>"` (GET /v1/link 404), `"dod not passed"` (link metadata `dod_pass` falsy), `"dod gate unreachable: <err>"`.

### Q5 substrate-mcp code [VERIFIED]
- `EVENT_KINDS` (`types.ts:19-35`): `"session.start","prompt","claim","tool.call","file.edit","shell","commit","pr","handoff","session.end","note","warning","agent.detected","agent.status","agent.exited","brief.delivered"`. Only consumers: `mcp.ts:87` (`z.enum`) and `event.ts:43` (`isKind`). `kind` is hashed as a plain string in `canonicalJson` (`event.ts:15-36`), so appending kinds does not alter existing hashes; no other repo mirrors the list (grep of TS/PY across repos found none outside this package). Greptime stores `kind` as a column string.
- `claimNode` emits `claim` only when `claimed:true` (already D-04-compatible). `releaseNode`/`completeNode` emit nothing, take no surface/session, and do **not** check ownership — any caller can release another surface's claim.
- `graph_release`/`graph_complete` return `text(...)`; D-06 needs JSON `{completed:false, reason}` → change return shape.
- HTTP convention: `greptime.ts:37-58` uses global `fetch` with `signal: AbortSignal.timeout(this.timeoutMs)`; follow it (fail-open, short timeouts, e.g. 5 s) so a slow Linear/Notion doesn't block the MCP call. Consider firing the mirror after returning? D-02 says best-effort; synchronous-with-timeout is simpler to test and keeps "within a minute".
- Session id at claim time: required `session_id` arg → stored as `claim_session`; use it in the one-line Linear comment.
- Tests: `bun test` from repo root, `*.test.ts` colocated (`service.test.ts`, etc.). Inject a fetch function into the Linear/Notion clients for unit tests; `Substrate` construction takes `loadConfig()`.
- Auth: substrate.env has **no `SUBSTRATE_TOKEN_*`**, so `allowAnonymous` is true and caller-provided `surface` is trusted (`config.ts`).

### Q6 Dispatcher [VERIFIED]
- No Python package exists yet in agent-substrate (`packages/dispatcher/src` is empty; no pyproject). Host: Python 3.12.3, `uv 0.11.26`. Mirror hermes-linear-connector conventions: `pyproject.toml` (hatchling, `requires-python >=3.11`, `httpx`, dev group `pytest`), `src/` layout, `[tool.pytest.ini_options] pythonpath=["src"]`, `live` marker. Root `bun test` won't collect Python — separate `uv run pytest` gate.
- MCP call: server is stateless streamable HTTP (`server.ts:~120-145`, `sessionIdGenerator: undefined`), so **one POST per call, no initialize handshake**. Verified live read-only:
```
curl -X POST 127.0.0.1:7410/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
 -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"graph_get","arguments":{"graph_id":"…"}}}'
→ event: message\ndata: {"result":{"content":[{"type":"text","text":"{…json…}"}]…}}
```
Response is SSE-framed; parse the `data:` line then `content[0].text` as JSON.
- Hermes launch (from `hermes chat --help`, and 01-10 proof): `/usr/local/bin/hermes chat --query-file <prompt> -Q --pass-session-id [--yolo] [-t terminal,…] --max-turns N --run-budget S --source tool`. `--pass-session-id` puts the id in the system prompt so the model can pass it to `graph_claim`; `-Q` prints `session_id: <id>` on stdout. Do **not** use `--worktree` (Hermes' own worktree) — the dispatcher's worktree is cwd. The prompt must include the exact curl for `graph_claim` (surface `hermes`) since Hermes has no substrate MCP server.
- Claim watch (D-14): poll `graph_get` every ~10 s and check `nodes[node_id].claimed_by == "hermes"`; `claim_session` gives the session id.
- systemd conventions (`infra/vps/substrate-collector-grok.service`): `After/Wants=substrate-mcp.service`, `StartLimitIntervalSec=0`, `EnvironmentFile=/etc/substrate/substrate.env`, `WorkingDirectory=/root/src/repos/agent-substrate`, `Restart=always`, `StateDirectory=substrate`, journal logging, `SyslogIdentifier`, `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, `ProtectHome=false`. Note `ProtectSystem=full` leaves `/var/lib` writable; git worktree writes `.git/worktrees` into `/root/src/repos/<repo>` (ProtectHome=false → OK). Spawned Hermes sessions inherit the unit's cgroup — `KillMode` default (control-group) will kill running sessions on unit stop; that is the D-15 kill switch behaviour.
- Env keys present: `SUBSTRATE_PG_URL` 1, `NOTION_TASK_GRAPH_DS` 1, `LINEAR_API_KEY` **0**, `NOTION_API_KEY` **0**, `SUBSTRATE_DISPATCH_DISABLED` **0**.

### Q7 Worktree [VERIFIED/INFERENCE]
- `graph_index.repo` holds the slug (e.g. `swcstudiospace/agent-substrate`). No slug→path map exists; checkouts are `/root/src/repos/<name>`. Recommend: path = `/root/src/repos/<slug.split('/')[1]>`, require it to be a git repo whose `origin` URL contains the slug, else comment+skip. Optional override map env `SUBSTRATE_REPO_PATHS`.
- `/var/lib/substrate` exists (root, contains collector offsets, `phase1-baseline`); `worktrees/` does not yet. Free disk: `shutil.disk_usage("/").free` (now 30 GB free of 387 GB).
- Pitfall: `git worktree add -b substrate/<gid>` fails if the branch exists; use `-B`? No — reuse: if dir exists and is a registered worktree, reuse; if branch exists but no dir, `git worktree add <dir> substrate/<gid>`.

### Q8 Brief [VERIFIED: brief.ts:67-75,134-150; claude-ultrathink src/substrate/brief.ts:13,55]
No caching: every Claude Code prompt POSTs `/brief` with a 1.5 s timeout. `describeNode` renders `started by <claimed_by> <relative>` only for the scoped graph; other open graphs show `N nodes started` without surface. The claim event (surface hermes, `claimed <identifier>`) appears in the repo's recent-actions list. See finding 5.

### Q9 Baselines (measured 2026-09-24)
- agent-substrate `SUBSTRATE_DISABLED=1 bun test`: **76 pass, 0 fail, 8 files**.
- hermes-linear-connector (`master`) `.venv/bin/python -m pytest -q`: **49 passed, 2 skipped, 0 failed**.
Both green → no Wave-0 baseline-repair plan needed; gates can be one-sided "stay green + new tests pass". If the D-06 decision adds an endpoint to hermes-linear-connector, that repo becomes touched (currently on `master`).

### Q10 Live collision risks
- No other process watches `dispatch:*` labels (grep of agent-scripts, connector, grok-hermes-connector, mcp: none).
- hermes-linear-poller polls every 2 s but only projects linked Kanban tasks → ignores the new issue unless `ensure-task` is called. **Calling `/v1/ensure-task` creates a Hermes Kanban card on board `eng`**, which Hermes' Kanban flow could pick up → possible double work. Avoid ensure-task for dispatched issues unless deliberate.
- The connector's own gate comments on Linear when Done is refused — double comments if substrate also comments.
- ultrathink-sync writes Task-row Status/Linear State; graph_complete writes Issue-row fields — distinct rows, low collision.
- Proof graph must not reuse `ut-mufsocbe-c7ced745` (has claim history, null Linear fields).
- Running dispatcher unit and a manual dispatcher simultaneously → double launch; use a lockfile in `/var/lib/substrate/dispatcher/`.

### Q11 Registering the proof graph
Create issue in team SWC (manual/UI or a one-off script — mutation, so not probed), then:
```json
graph_register {"graph_id":"<new>","repo":"swcstudiospace/agent-substrate","branch":"main","status":"unstarted",
 "nodes":[{"node_id":"n1","linear_issue_id":"<uuid>","linear_identifier":"SWC-<n>","notion_page":"<Issue row page id/url>","state":"unstarted"}]}
```
A Notion Issue row (Level=Issue, Graph ID, Item "[n1] …") must be created first for the Notion part of the proof. Dispatcher also needs the reverse lookup (finding 3).

## Standard Stack
| Piece | Choice | Source |
|---|---|---|
| TS HTTP | global `fetch` + `AbortSignal.timeout` | greptime.ts precedent |
| Linear | raw GraphQL POST `https://api.linear.app/graphql`, header `Authorization: <key>` (no Bearer for personal keys) | connector `linear_client.py`, live probe |
| Notion | REST `PATCH /v1/pages/{id}`, `Notion-Version: 2025-09-03` | [CITED] |
| Python | 3.12, uv, httpx, pytest | host + connector pyproject |
No new npm packages → no package-legitimacy audit needed; Python deps httpx/pytest already used on host.

## Architecture Patterns
```
Linear (dispatch:hermes, Todo) --30s poll--> dispatcher --graph_find--> substrate-mcp
   dispatcher: disk check -> git worktree -> hermes chat --query-file (cwd=worktree)
   hermes --curl graph_claim--> substrate-mcp: index claim (authoritative)
        -> mirror: Linear issueUpdate{stateId=In Progress, added agent:hermes, removed dispatch:hermes} + commentCreate(session)
        -> Notion PATCH Issue row Agent=hermes ; emit claim (failures -> warning event)
   dispatcher watch graph_get claimed_by (<=10 min) else comment + remove dispatch label
```
Note: success criterion 3 says the dispatch label is removed "when the claim lands" — doing it inside the claim mirror (removedLabelIds of any `dispatch:*`) makes it atomic with the state change; the dispatcher only removes it on timeout.

Recommended layout: `packages/mcp-server/src/linear.ts`, `notion.ts`, `mirror.ts` (+ `*.test.ts`); `packages/dispatcher/{pyproject.toml,src/substrate_dispatcher/{__main__,linear,mcp,worktree,launcher}.py,tests/}`; `infra/vps/substrate-dispatcher.service`.

### Anti-patterns
- `issueUpdate(labelIds:[…])` — overwrites labels (violates D-03).
- Resolving "In Review" by `state.type` — two `started` states.
- Hardcoding SWC state ids or team key (D-16).
- Rolling back index claim on mirror failure (D-02).
- Using `/v1/ensure-task` casually (creates Kanban cards).

## Common Pitfalls
1. Missing credentials in substrate.env → mirror silently warns every time; proof fails. Add a startup log line "linear mirror disabled: no key".
2. Retry-on-next-claim (D-02): a same-surface re-claim returns `claimed:true` (`index-store.ts:190` allows `claimed_by = surface`), so the retry path exists naturally; make mirror idempotent (label already present, state already set).
3. SSE-framed MCP responses — parse `data:` line.
4. Hermes non-TTY: `-q` on non-TTY implies oneshot; use `--query-file` to avoid shell quoting.
5. Worktree branch already exists → `git worktree add` error.
6. Brief shows surface only for scoped graph (finding 5).
7. Unit stop kills child Hermes sessions (cgroup) — acceptable for kill switch, but a `Restart=always` restart mid-session also kills them; consider `KillMode=process` only if sessions should survive restarts (then they escape the kill switch — keep default).

## Open Questions (RESOLVED)
1. **D-06 routing (blocking, costly decision).** Options: (a) substrate reads `GET /v1/link?linear_issue_id` and, if linked and `metadata.dod_pass` true, calls `POST /v1/mark-dod {kanban_task_id, mark_done:true, summary, tests_pass}` — but mark-dod *sets* dod_pass itself, so the gate check is effectively in substrate; (b) add a connector endpoint `POST /v1/complete-issue {linear_issue_id, summary, tests_pass, review_pass}` that applies the same `require_dod_for_done` rule (DoD = summary + tests_pass, as in `poller.py`) and moves Linear Done — touches hermes-linear-connector; (c) unlinked issue → always `completed:false, reason:"no DoD record"` (nodes never auto-close). Recommend (b) with graph_complete accepting optional `dod:{summary,tests_pass,review_pass}`. Needs user confirmation. — RESOLVED: option (b) new connector endpoint `POST /v1/complete-issue` + `SyncEngine.complete_issue` reusing an extracted `_done_allowed` predicate from `apply_kanban_status` (plan 02-03); substrate's `DodGate` client is its only caller (plan 02-05). D-06 is locked in CONTEXT.md, so no checkpoint:decision; rated costly (loopback-only internal contract, one caller, no migration).
2. Notion `Agent`/`Status` property types and options — needs token (Wave 0). — RESOLVED: plan 02-02 (human-action checkpoint for NOTION_API_KEY, then a read-only data-source schema read written to 02-NOTION-SCHEMA.md) pins the types consumed by plan 02-06.
3. Should `graph_release` verify caller surface/session owns the claim? Currently no ownership check. — RESOLVED: yes; plan 02-05 checks caller surface + current claim_session before release/complete.
4. Reverse lookup tool name/shape (`graph_find {linear_issue_id|linear_identifier}` → `{graph_id,node_id,repo}`) — adding an MCP tool is in-scope for the dispatcher. — RESOLVED: new read-only MCP tool `graph_find` (by linear_issue_id / linear_identifier → graph_id, node_id, repo) in plan 02-01.

## Environment Availability
| Dependency | Available | Note |
|---|---|---|
| bun `/root/.local/share/reflex/bun/bin/bun` | ✓ | tests green |
| python3 3.12.3, uv 0.11.26 | ✓ | |
| hermes `/usr/local/bin/hermes` | ✓ | flags above |
| substrate-mcp :7410 | ✓ active | anonymous |
| hermes-linear-api :8792 | ✓ active, `/health` ok | no auth |
| LINEAR_API_KEY in substrate.env | ✗ | in connector.env |
| NOTION_API_KEY anywhere | ✗ | **blocking for Notion mirror/proof** |
| Disk | 30 GB free (93%) | > 5 GB threshold |

## Validation Architecture

### Test Framework
| Property | Value |
|---|---|
| TS | `bun test` (root), colocated `packages/mcp-server/src/*.test.ts` |
| Python | pytest via `uv run --project packages/dispatcher pytest -q` (new) |
| Quick run | `bun test packages/mcp-server/src/mirror.test.ts`; `uv run pytest -q packages/dispatcher/tests` |
| Full | `SUBSTRATE_DISABLED=1 bun test` (baseline 76/0) + dispatcher pytest + connector pytest (49 pass/2 skip) if touched |

### Behaviour → Test Map
| Behaviour | Type | Command / check |
|---|---|---|
| Claim mirrors: issueUpdate has stateId(In Progress), addedLabelIds, removedLabelIds dispatch:*, never labelIds; comment includes session id; Notion PATCH Agent=surface | unit (injected fetch) | bun test mirror.test.ts |
| Loser claim → zero Linear/Notion calls (D-04) | unit | service.test.ts |
| Mirror failure → claim still `claimed:true` + `warning` event with target | unit | service.test.ts |
| Label reuse: existing team/workspace label reused; create only when absent | unit | mirror.test.ts |
| State resolution by name per team; "In Review" not by type | unit | mirror.test.ts |
| release → Todo, removedLabelIds agent:*, Notion Agent cleared, `release` event with graph_id/repo/node_id | unit | service.test.ts |
| complete → In Review; DoD fail → `{completed:false, reason}` and no Done; `complete` event | unit (mock 8792) | service.test.ts |
| null linear_issue_id/notion_page → warning, no throw | unit | |
| EVENT_KINDS accepts release/complete; existing hash vectors unchanged | unit | event.test.ts |
| Dispatcher: filter, non-hermes surface → one comment only (idempotent across polls), max 2 concurrent, disk < 5 GB refuse, kill switch, 10-min timeout path, worktree reuse | unit (fake clock, fake Linear/MCP, tmp git repo) | pytest |
| MCP SSE parsing | unit | pytest |
| Live: label `dispatch:hermes` → session, claim, Linear In Progress + agent:hermes + comment, Notion Agent hermes, brief line ≤ 60 s | manual proof, timestamps recorded | 02-PROOF.md |

### Sampling Rate
Per task: targeted test file. Per wave: full bun test + dispatcher pytest. Gate: all green + live proof.

### Wave 0 Gaps
- Credentials: `LINEAR_API_KEY`, `NOTION_API_KEY`, `SUBSTRATE_DISPATCH_DISABLED=0` added to substrate.env (human for Notion integration + DB share).
- Notion data-source schema read (types of Agent/Status/Linear State/Completed).
- D-06 routing decision (Open Q1).
- `packages/dispatcher/pyproject.toml` + `tests/` skeleton; `mirror.test.ts` scaffolding with fetch injection.
- `graph_find` reverse lookup.

## Security Domain (ASVS L1)
| ASVS | Applies | Control |
|---|---|---|
| V2/V4 Auth & access | yes | substrate-mcp is anonymous (no SUBSTRATE_TOKEN_*): any loopback caller can claim/release/complete as any surface, and complete can now move Linear issues. **High**: recommend configuring `SUBSTRATE_TOKEN_HERMES` (+dispatcher token) or at least ownership checks on release/complete. 8792 unauthenticated loopback — acceptable only on loopback. |
| V5 Input validation | yes | zod on MCP args exists; validate `surface` ∈ SURFACES before building `agent:<surface>` label; Linear-issue-derived text (title/description) placed into Hermes prompt is **prompt-injection** input — pass only graph_id/node_id/identifier, never issue body, into the launch prompt; `--yolo` + untrusted issue text = RCE risk. |
| V7 Logging | yes | redact before emit (`redact.ts`); never log API keys; warning events carry target names, not responses with tokens. |
| V8 Data protection | yes | keys only via EnvironmentFile 0600; don't pass keys into Hermes env beyond what it already has. |
| V12 Files | yes | graph_id used in filesystem path `/var/lib/substrate/worktrees/<graph_id>` and branch name → validate `^[A-Za-z0-9._-]+$`, reject `..`/slashes (path traversal / git ref injection). Repo slug → path mapping must be whitelisted to `/root/src/repos/*`. |
| V13 API | yes | who can label `dispatch:hermes` in Linear can start an agent on the VPS: restrict to issues whose node is registered in the index (reverse lookup must succeed) and team SWC. |

Threats: T1 prompt injection via Linear content (high) → template-only prompt; T2 path traversal via graph_id (high) → regex; T3 spoofed surface claims (medium, pre-existing) → tokens; T4 runaway sessions → max 2, `--run-budget`, kill switch; T5 DoD bypass via mark-dod (costly) → Open Q1.

## Sources
Primary (read this session): `packages/mcp-server/src/{types,config,service,index-store,mcp,server,event,brief,backfill,backfill-run,greptime}.ts`; `hermes-linear-connector/src/hermes_linear_connector/{sync_engine,webhook_app,api_main,poller,factory}.py`, `pyproject.toml`; `/root/.config/hermes-linear/config.yaml` (non-secret keys); `claude-ultrathink/skills/ultrathink-{sync,kickoff}/SKILL.md`; `claude-ultrathink/src/substrate/brief.ts`; `infra/vps/*.service`; 01-10-PROOF.md; live Linear introspection + rate headers; live `graph_get`; `hermes chat --help`; systemctl units.
Cited: Notion API version 2025-09-03 data sources (developers.notion.com).

## Metadata
Confidence: code/Linear HIGH; Notion types LOW; DoD routing MEDIUM (facts HIGH, design open). Valid until connector or Notion schema changes (~30 days).
