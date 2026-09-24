# Phase 1 Lane B — 01-10 gap-closure proof

Recorded 2026-09-24 by plan 01-10. This file only records output that was observed. A surface that did not show what the ROADMAP proof needs is listed as a gap.

## Identifiers

- graph_id: `ut-mufsocbe-c7ced745` (reused from 01-09; nodes `n1`, `n2`)
- repo: `swcstudiospace/agent-substrate`, branch `main`
- target node: `n2`
- new handoff: handoffId `20260924T182453Z-bb506df2`, idempotency key `01-10-proof-ut-mufsocbe-c7ced745-n2` (not the deduping 01-09 key)
- Hermes claim session: `20260924_182534_fe7fa2` (a real `hermes chat` session, not a proxy claim)

Health before the proof: `GET :7410/healthz` returned `{"index":true,"greptime":true}`. `GET :8788/health` returned `{"status":"ok","service":"grok-hermes-connector","version":"0.4.0",...}`.

## Task 1 — emit pass-through is live

mcp commit `63fd450` `fix(01-10): attribute handoff events to repo and node`. `grok-hermes-connector` was restarted at 18:21:33Z (new pid 202217, `v0.4.0`, no traceback) and `systemctl is-active` returned `active`.

```
$ .venv/bin/python -m pytest -q tests/test_handoff_pack.py::test_handoff_to_hermes_emits_one_handoff_event_with_graph_id tests/test_handoff_pack.py::test_handoff_to_hermes_emits_repo_and_node_id
2 passed in 1.47s
```

## Task 2 — Muse list and collector-written brief

The live line is now the four existing roots in their original order, plus the proof checkout, on one line. `grep -c '^SUBSTRATE_MUSE_REPOS='` returns `1`. The file is still mode `600 root root`.

```
SUBSTRATE_MUSE_REPOS=/root/src/repos/hermes-plugin:/root/src/repos/omp-ultrathink:/root/src/repos/hermes-engineering-board:/root/src/repos/hermes-linear-connector:/root/src/repos/agent-substrate
```

`substrate-collector-muse` was restarted at 18:21:55Z and is `active`. The journal since the restart shows no usage exit:

```
18:22:00 [muse-collector] delivered briefs to 5 repo(s)
18:22:00 [muse-collector] watching 5 repo(s) every 300000ms
```

`.substrate/BRIEF.md` was rewritten by the watch pass at startup, so no `--once` pass was needed. mtime is `2026-09-24 18:21:59.79` (epoch 1790274119, later than the 11:48:50 stub's 1790250530). Size is 334 bytes. Nobody edited it by hand. Observed body:

```
## Substrate brief: /root/src/repos/agent-substrate @ main

Last 4 agent actions in this repo
- 16:08 herdr        herdr pane_agent_detected on pane w6:p1
- 11:59 muse         muse called substrate_probe_tool
- 11:52 muse         muse called substrate_probe_tool
- 11:48 muse         delivered brief to /root/src/repos/agent-substrate
```

This brief is keyed by the checkout path. The proof events are keyed by the slug, so they do not appear in it. That is the current path-keyed text, as the plan expected. `.substrate/` is in `.gitignore` (`.gitignore:14`), so this file cannot be committed without force-adding it.

## Task 3 — ROADMAP proof re-run

### Porcelain before (18:24:53Z, taken right before the handoff)

agent-substrate:
```
 M .planning/ROADMAP.md
 M .planning/config.json
 M .planning/state.json
?? .planning/milestone.lock
?? issues/
```

mcp: 9 modified files (`docs/grok-oauth-setup.md`, `skills/grok-handoff-hermes/SKILL.md`, `src/grok_hermes_connector/{__init__,handoff_pack,hermes_backend,oauth,server}.py`, `tests/test_handoff_pack.py`, `tests/test_oauth.py`) and 9 untracked entries (`docs/V04_TWO_WAY.md`, `review.json`, `skills/grok-share-ingest/`, `src/grok_hermes_connector/{agent_bus_ext.py,cors.py,oauth.py.bak.publicfix,server.py.bak.agent_bus,share_url.py}`, `tests/test_share_url.py`). All of these were already dirty before this plan started and belong to other sessions.

### Step 1 — attributed handoff through the updated handoff_to_hermes

Command: `POST http://127.0.0.1:8788/mcp`, JSON-RPC `tools/call` `handoff_to_hermes`, Bearer `CONNECTOR_TOKEN` (value not printed). Arguments were `graph_id=ut-mufsocbe-c7ced745`, `repo=swcstudiospace/agent-substrate`, `node_id=n2`, `idempotency_key=01-10-proof-ut-mufsocbe-c7ced745-n2`, and a claim-only goal. The call returned HTTP 200 with `handoffId=20260924T182453Z-bb506df2`, `status=submitted`, `deduped=false`, and `dispatchPid=207619`.

The connector journal at 18:24:54 shows `POST http://127.0.0.1:7410/events "HTTP/1.1 202 Accepted"`.

A kill-watcher started before the call. It SIGKILLed the implement wrapper, and no `hermes chat` implement child ever started:

```
2026-09-24T18:24:53.940Z KILL pattern=[dispatch_handoff_to_hermes\.sh]
207619 bash /root/agent-scripts/dispatch_handoff_to_hermes.sh /var/lib/grok-hermes/handoffs/20260924T182453Z-bb506df2.md grok-hermes-20260924T182453Z-bb506df2
2026-09-24T18:24:54.053Z KILL pattern=[hermes send --to .*\[Hermes\]]
207634 .../hermes send --to telegram:<home channel> --subject [Hermes] ACK — starting handoff job ...
```

The job log `/tmp/hermes-handoffs/jobs/grok-hermes-20260924T182453Z-bb506df2.log` is 0 bytes. Its `.status` file still says `running` because the wrapper was killed before its watcher could update it. The dispatch script was not edited.

Greptime rows for the graph (`SELECT ... FROM agent_events WHERE graph_id='ut-mufsocbe-c7ced745' ORDER BY ts`):

```
ts=1790270281110 surface=grok-bot kind=handoff repo=null node_id=null session_id=20260924T171800Z-3fb834d5   (old 01-09 event)
ts=1790274294173 surface=grok-bot kind=handoff repo=swcstudiospace/agent-substrate node_id=n2 graph_id=ut-mufsocbe-c7ced745 session_id=20260924T182453Z-bb506df2 id=evt_1ddb0a2c572849ce86b2616b77bc0589 summary="Handoff to Hermes: Lane B 01-10 proof claim n2 ut-mufsocbe-c7ced745"
ts=1790274377219 surface=hermes kind=claim repo=swcstudiospace/agent-substrate branch=main node_id=n2 graph_id=ut-mufsocbe-c7ced745 session_id=20260924_182534_fe7fa2 id=evt_f3cc3d13277e489cab0632a00b78f723 summary="claimed node"
```

The new handoff row has `repo=swcstudiospace/agent-substrate` and `node_id=n2`.

### Step 2 — claim-only Hermes finish (real Hermes session)

This was a real `hermes chat` session. Its only toolset was `terminal`. It ran as a transient systemd unit with both working trees mounted read-only, so it could not edit either tree:

```
systemd-run --unit=proof-0110-hermes-claim --wait --pipe --collect \
  -p ReadOnlyPaths=/root/src/repos/agent-substrate -p ReadOnlyPaths=/root/src/repos/mcp \
  -p RuntimeMaxSec=300 -p WorkingDirectory=/root/src/repos/agent-substrate -E HOME=/root -E PATH=... \
  /usr/local/bin/hermes chat --query-file /tmp/0110_claim_prompt.md -t terminal -Q --pass-session-id --max-turns 4 --run-budget 240
```

The prompt told Hermes to run one `curl` to `graph_claim` on `:7410/mcp` for `n2` with `surface=hermes` and its own session id. It also told Hermes not to edit files and not to run any other command. The implement wrapper was not used. Observed stdout, with exit 0 and a runtime of 1min 57s:

```
⚠️  Normalized model 'claude-fable-5.1' to 'claude-fable-5-1' for anthropic.
session_id: 20260924_182534_fe7fa2
session_id=20260924_182534_fe7fa2 claimed=true claimed_by=hermes
```

The session came from `hermes sessions export --format jsonl --session-id 20260924_182534_fe7fa2`. Its fields were source `oneshot`, model `claude-fable-5-1`, cwd `/root/src/repos/agent-substrate`, `tool_call_count=1`, and `message_count=4`. The only tool call was `terminal` with this `curl ... "name":"graph_claim","arguments":{"graph_id":"ut-mufsocbe-c7ced745","node_id":"n2","surface":"hermes","session_id":"20260924_182534_fe7fa2"}`. The tool output was `"claimed": true ... "claimed_by": "hermes", "claimed_at": "2026-09-24T18:26:16.407Z", "claim_session": "20260924_182534_fe7fa2"`. The single line quoted above is the model's own final reply in that session. It is not paraphrased.

graph_get after the claim (`graph_get` via `:7410/mcp`):

```
graph_id=ut-mufsocbe-c7ced745 repo=swcstudiospace/agent-substrate branch=main status=unstarted
n1 state=unstarted claimed_by=null claimed_at=null claim_session=null
n2 state=unstarted claimed_by=hermes claimed_at=2026-09-24T18:26:16.407Z claim_session=20260924_182534_fe7fa2
```

n2 is claimed by hermes. It was not marked completed, because the finish was claim-only by design.

### Porcelain after (18:28:21Z)

`git status --porcelain` for both repos is byte-identical to the pre-claim snapshot (`diff -q` reports no difference). A content hash covers `git diff` plus the sha256 of every untracked file. It was the same at 18:26:42Z, during the sandboxed run, and at 18:28:21Z:

```
55f6844c7cfda2dbec2659857cdaa3d8d7174843771b885d2c726ff822156a6d  agent-substrate content-hash
ef79cf8edbaac0782a1ce3bf8358d1eac3295b53ca79eb891af0a166d5a9c837  mcp content-hash
```

### Step 3 — POST /brief as omp

Command: `POST http://127.0.0.1:7410/brief` `{"repo":"swcstudiospace/agent-substrate","surface":"omp","graph_id":"ut-mufsocbe-c7ced745"}` at 18:28:37Z. Exact body (HTTP 200):

```
## Substrate brief: swcstudiospace/agent-substrate — ut-mufsocbe-c7ced745
unstarted · Agent grok-bot · PR none yet
Nodes: n1 unstarted · n2 started by hermes 2 min ago

Last 5 agent actions in this repo
- 18:26 hermes       claimed node (n2)
- 18:24 grok-bot     Handoff to Hermes: Lane B 01-10 proof claim n2 ut-mufsocbe-c7ced745 (n2)
- 18:19 cursor       commit 5a1a5fa docs(01-10): plan gap closure for handoff attribution and muse brief
- 17:45 cursor       commit 158983c docs(01): phase 1 verification
- 17:25 cursor       commit 72615c1 docs(01-09): complete cross-surface proof plan
```

The body names both facts. The handoff line is `grok-bot Handoff to Hermes ... (n2)` and the claim line is `hermes claimed node (n2)`. The node line also reads `n2 started by hermes`. `POST /verify {"graph_id":"ut-mufsocbe-c7ced745"}` returned `{"ok":true,"events":3}`.

## Remaining human gaps (no model quotation invented)

- Grok Bot: the executor made the handoff through the connector's authenticated MCP API. No Grok Bot model session made it.
- Omp: no live Omp model session ran. The body above is the substrate text the Omp discovery path would inject. No Omp model quoted it.
- Muse and Grok Build: no model sessions were started. The Muse file is collector-written and keyed by the checkout path, so it does not list the slug-keyed proof events.
- Hermes: a real Hermes session claimed n2. The node was not marked completed. If "finishes" has to mean `state=completed`, that is still open.
- The dispatched ACK `hermes send` (pid 207634) was killed about 113 ms after it started. Whether a Telegram ACK went out was not observed.
