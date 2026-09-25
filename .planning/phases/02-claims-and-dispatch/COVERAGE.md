# API Coverage — Phase 2 (Linear GraphQL, Notion REST, hermes-linear-connector HTTP, Hermes CLI)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Plans: 02-01 (claim → Linear, graph_find), 02-02 (Notion credential + schema read, or the notion_skipped gap), 02-03 (connector DoD route),
> 02-04 (dispatcher clients, worktree, launcher), 02-09 (tick + live dispatch tracer), 02-07 (loop, D-14 watch, unit), 02-05 (release/complete + DoD gate client), 02-06 (Notion mirror), 02-08 (proof).

| capability | decision | reason |
|---|---|---|
| Linear issue read — team, states, labels, last comments | INTEGRATE | 02-01 LinearClient.issueContext via `issue(id:)` (UUID or identifier); states resolved by name per team (D-16, research finding 4) |
| Linear issueUpdate stateId — In Progress on claim | INTEGRATE | 02-01 Mirror.claim (SC-1) |
| Linear issueUpdate stateId — Todo on release | INTEGRATE | 02-05 Mirror.release (D-05) |
| Linear issueUpdate stateId — In Review on complete | INTEGRATE | 02-05 Mirror.review (D-06) |
| Linear Done transition | INTEGRATE | only through hermes-linear-connector POST /v1/complete-issue (02-03); substrate never sends a Done stateId (D-06) |
| Linear issueUpdate addedLabelIds — agent:<surface> | INTEGRATE | 02-01 claim; additive only (D-03) |
| Linear issueUpdate removedLabelIds — dispatch:* and agent:<surface> | INTEGRATE | dispatch:* on claim (02-01), agent:<surface> on release (02-05), dispatch:<surface> on D-14 timeout or unclaimed session exit (02-07); 02-09's tracer applies the same removal to its own session |
| Linear issueLabels query by name + issueLabelCreate(teamId) — create-or-reuse | INTEGRATE | 02-01 ensureLabel (D-03); 02-09 tracer and 02-08 ensure dispatch:hermes |
| Linear commentCreate — claim session line | INTEGRATE | 02-01 (SC-1), idempotent per session; read back by 02-07's claim watch and 02-09's tracer as landed-claim evidence (matched by surface, graph, node, session id) |
| Linear commentCreate — dispatcher notices | INTEGRATE | 02-09 / 02-07, once per marker (D-11, D-12, D-14): not dispatchable, no node, already claimed, low disk, claim timeout, unclaimed exit |
| Linear issues filter — dispatch:* label + unstarted state (poll) | INTEGRATE | 02-04 dispatch_candidates (label name startsWith dispatch: + state type unstarted), called by 02-09's tick, every 30 s from 02-07 (D-10) |
| Linear issue history read (state transitions) | INTEGRATE | 02-08 proof evidence only |
| Linear issueCreate | INTEGRATE | throwaway tracer/proof issues only (02-01, 02-09, 02-08, D-16); not a runtime capability of substrate |
| Linear teams query | INTEGRATE | team resolution at run time for throwaway issues (no typed prefix, D-16) |
| Linear issueUpdate labelIds (overwrite) | OPT-OUT | overwrites every label on the issue — violates D-03's additive rule |
| Linear issueLabelCreate replaceTeamLabels | OPT-OUT | would rewrite the team's labels — violates D-03 |
| Linear issueAddLabel / issueRemoveLabel single mutations | OPT-OUT | not needed — one issueUpdate with addedLabelIds/removedLabelIds keeps each transition atomic |
| Linear webhooks | OPT-OUT | explicitly out of scope — deferred per CONTEXT Deferred Ideas; D-10 polls (no public ingress) |
| Notion page read — property types (`GET /v1/pages/{id}`) | INTEGRATE | 02-06 shapes every write by the page's own types |
| Notion page update — Agent | INTEGRATE | 02-06 set on claim, cleared on release (SC-1, D-05) |
| Notion page update — Status | INTEGRATE | 02-06 Done on gated completion (D-07) |
| Notion page update — Linear State | INTEGRATE | 02-06 mirrors the Linear state substrate just set (ultrathink-sync rule) |
| Notion page update — Completed | INTEGRATE | 02-06 date on gated completion (D-07) |
| Notion data source read (`GET /v1/data_sources/{id}`) | INTEGRATE | 02-02 schema read, no writes |
| Notion page create (Issue row) | INTEGRATE | throwaway smoke/proof rows only (02-06, 02-08), skipped and recorded as a gap when 02-02 records notion_skipped=true; not a runtime capability of substrate |
| Notion page trash (`in_trash` / `archived`) | INTEGRATE | cleanup of the 02-06 smoke row only |
| Notion page update — PR URL, PR #, PR State, Repo, Branch | OPT-OUT | explicitly out of scope — D-07: ultrathink-sync owns the PR fields; enforced by NOTION_WRITABLE |
| Notion Task-row updates | OPT-OUT | explicitly out of scope — ultrathink-sync owns the Task row; substrate writes Issue rows only |
| Notion search / query data source for rows | OPT-OUT | not needed — the node's notion_page gives the row id directly |
| hermes-linear-connector POST /v1/complete-issue | INTEGRATE | new in 02-03; the D-06 Done gate, called by substrate's DodGate (02-05) |
| hermes-linear-connector GET /health | INTEGRATE | smoke checks in 02-03 |
| hermes-linear-connector POST /v1/mark-dod | OPT-OUT | not needed — it sets dod_pass unconditionally; using it from substrate would move the DoD decision into substrate (D-06) |
| hermes-linear-connector POST /v1/ensure-task | OPT-OUT | explicitly out of scope — creates a Hermes Kanban card on board eng (double-work risk, research Q10) |
| hermes-linear-connector GET /v1/link | OPT-OUT | not needed — complete_issue reads link metadata inside the connector |
| hermes-linear-connector POST /v1/ensure-issue | OPT-OUT | not needed — issues come from ultrathink kickoff or the proof, not from Kanban |
| Hermes CLI `hermes chat --query-file` launch (no --yolo, cwd = worktree) | INTEGRATE | 02-04 launcher / 02-09 tick and live tracer / 02-07 loop (D-13) |
| Hermes CLI `hermes sessions export` | INTEGRATE | 02-08 proof evidence (read-only) |
| /root/agent-scripts/dispatch_handoff_to_hermes.sh | OPT-OUT | explicitly out of scope — D-13 forbids it (implement wrapper overrides the goal and can edit the wrong tree) |
| Dispatch for non-hermes surfaces (dispatch:claude-code, omp, grok-build, muse) | OPT-OUT | not needed yet — D-11 / Deferred Ideas; claude-code is Phase 3 |
