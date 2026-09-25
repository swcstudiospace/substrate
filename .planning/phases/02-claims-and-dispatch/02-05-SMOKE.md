# 02-05 live smoke: release, ownership refusal, refused complete, gated Done

Everything here was recorded from observed output only.

The substrate-mcp restart at 2026-09-25T02:03:12Z (after commits 3036c23 and c1816ec) came back `active`. `/healthz` returned
`{"index":true,"greptime":true}`, and the journal showed `[substrate] mirror: linear on`. I coordinated the restart with
Exec0204, which makes no live :7410 calls.

Run: `sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env /usr/bin/python3 /tmp/02-05-smoke.py <graph> <issue> <tracer session>`.
MCP calls went to `POST 127.0.0.1:7410/mcp`. Linear was read with `issue(id: <linear_issue_id>)` inside the
same process, so systemd supplied the key and nothing printed it.

graph_id=ut-mugb3vwa-c57eb6ac
linear_issue_id=6dff6e82-7b59-44c6-ab7f-50e53fedd96c
linear_identifier=SWC-465
tracer_session=02-01-tracer-20260925T015316Z
smoke_session=02-05-smoke-20260925T020326Z

## 0. Before (02:03:15Z)

Linear showed `In Progress` with labels `[agent:claude-code]` and `updatedAt 2026-09-25T01:53:20.091Z`. Node n1 was `started`, claimed by
`claude-code`, session `02-01-tracer-20260925T015316Z`.

## 1. graph_release as omp, session 02-05-intruder (02:03:19Z)

```
{"released": false, "reason": "node is claimed by claude-code session 02-01-tracer-20260925T015316Z; only that session can release it", "node": {..., "state": "started", "claimed_by": "claude-code", "claim_session": "02-01-tracer-20260925T015316Z"}}
```

Linear after the call showed `In Progress`, labels `[agent:claude-code]`, and `updatedAt 2026-09-25T01:53:20.091Z`, the same value as before. Nothing was written.

ownership_refused=true

## 2. graph_release as claude-code, tracer session (02:03:25Z)

```
{"released": true, "node": {..., "state": "unstarted", "claimed_by": null, "claimed_at": null, "claim_session": null}}
```

Linear after the call showed `Todo` with labels `[]`, so `agent:claude-code` was removed. `updatedAt` was 2026-09-25T02:03:22.984Z.

release_state=Todo

## 3. graph_claim as claude-code, session 02-05-smoke-20260925T020326Z (02:03:32Z)

```
{"claimed": true, "node": {..., "claimed_by": "claude-code", "claimed_at": "2026-09-25T02:03:26.788Z", "claim_session": "02-05-smoke-20260925T020326Z"}}
```

Linear after the call showed `In Progress` with labels `[agent:claude-code]`, plus a new comment
`2026-09-25T02:03:30.057Z Claimed by claude-code — session 02-05-smoke-20260925T020326Z (graph ut-mugb3vwa-c57eb6ac, node n1)`.
`graph_get` n1 showed `started`, held by the smoke session.

## 4. graph_complete, smoke session, no dod (02:03:37Z)

```
{"completed": false, "reason": "dod not passed: tests_pass true and a non-empty summary are required", "node": {..., "state": "started_review", "claimed_by": "claude-code", "claim_session": "02-05-smoke-20260925T020326Z"}}
```

Linear after the call showed `In Review` with labels `[agent:claude-code]` and `updatedAt` 2026-09-25T02:03:34.209Z. `graph_get` n1 showed `started_review`, still
claimed by claude-code in the smoke session.

refused_state=In Review
refused_reason=dod not passed: tests_pass true and a non-empty summary are required

## 5. graph_complete, smoke session, dod {"summary": "02-05 smoke: gate check, no code change", "tests_pass": true} (02:03:43Z)

```
{"completed": true, "reason": null, "node": {..., "state": "completed", "claimed_by": null, "claimed_at": null, "claim_session": null}}
```

Linear after the call showed `Done`, with `updatedAt` 2026-09-25T02:03:39.897Z. The connector's `complete_issue` moved it there; substrate only sent
the In Review state id. The issue keeps the label `[agent:claude-code]`, because the plan's complete transition does not remove it.
`graph_get` n1 showed `completed` with `claimed_by null`.

done_state=Done

## 6. POST /verify {"graph_id": "ut-mugb3vwa-c57eb6ac"} (02:03:44Z)

```
{"ok": true, "events": 5}
```

The five events are:

- the 02-01 claim
- the release
- the re-claim
- the refused complete
- the completing complete

The hash chain holds with the new `release` and `complete` kinds.

verify_ok=true

## 7. graph_register {"graph_id": "ut-mugb3vwa-c57eb6ac", "status": "Done"} (02:03:45Z)

The response returned `status: "Done"`. The throwaway graph is now terminal and leaves every repo brief.

## GitHub twin (observed, not changed)

SWC-465 is mirrored to https://github.com/swcstudiospace/agent_runtime/issues/325 by the workspace's Linear↔GitHub
sync. A read-only `gh api repos/swcstudiospace/agent_runtime/issues/325` at 2026-09-25T02:04:14Z returned
`{"state":"closed","state_reason":"completed","closed_at":"2026-09-25T02:03:40Z","closed_by":"SomeRandmGuyy"}`.
The sync closed the GitHub issue one second after Linear reached Done. This plan made no GitHub call.

github_325_state=closed
