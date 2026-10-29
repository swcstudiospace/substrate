---
audit_acknowledged:
  milestone: v1.3.x
  at: 2026-10-29
  gap_snapshot: "unknown::scenarios=0"
---

# Phase 20 UAT evidence (plan 20-04)

Repeatable Phase 0 UAT script (`scripts/uat-phase0.ts`, run as
`bun run uat:phase0`) with the fixture
(`scripts/uat/fixtures/notion-rows.json`), the regression doc
(`docs/uat.md`) and the isolated harness proof below. Units:
`bun test scripts/uat-phase0.test.ts` — 25 pass, 0 fail.

## Harness proof (2026-10-09, run uat-p20proof2)

- Harness: `bun run rehearsal up --name p20 --port 0` → twin on
  `http://127.0.0.1:39295` (scratch Postgres + scratch ledger, loopback
  only); consumer.env sourced; script run with
  `--tag p20proof2 --scenarios 1,3,4,6,7,8 --report /tmp/p20-uat-harness.md`;
  exit 0, 6/6 scenarios passing.
- Teardown: `bun run rehearsal down --name p20` → stopped pid 2393622,
  removed 2 containers. Production stores received nothing: the harness
  uses scratch loopback ports by construction, and scenario 7 used only
  its own dead port plus its own accept-and-hang listener.
- Reports: `/tmp/p20-uat-harness.md` (Markdown table) and
  `/tmp/p20-uat-harness.md.json` (JSON). Plugin serving the run:
  0.3.0 @ 85ca1ac. Reports hold ids, counts, statuses, booleans and
  elapsed times only.

| Scenario | Verdict | Evidence |
| --- | --- | --- |
| 1 substrate-mcp serves both surfaces | pass | tools/list 20 tools, 9 v1 names present; /healthz 200; /brief 200; /events 202 stored true; graph_register 1 node; /verify 200 ok true |
| 3 index backfilled from the Notion Agent Task Graph | pass | 2 graphs backfilled from exported rows, 3 nodes, 3 Linear identifiers |
| 4 the brief reaches a Claude Code session | pass | fetchBrief non-empty brief (255 bytes); prompt-context substrate brief header present |
| 6 Cursor hooks and the git post-commit collector are installed | pass | 3 desired entries (sessionStart,postToolUse,stop); BRIEF.md written; no event emitted; stop exit 0 stdout empty; post-commit hook present; 1 commit event matched by surface, kind, repo and since; tool.call read-back 1 row |
| 7 a substrate outage does not block any agent | pass | fetchBrief empty in 1 ms; CLI brief exit 0 empty stdout in 43 ms; hook brief exit 0 stdout empty in 1547 ms |
| 8 phase proof — cross-surface brief | pass | graph_claim decision granted; file.edit emit 202 stored true; brief 200 with cross-surface lines present |

## Production scenarios — live-gated for plan 20-06, never run here

- Scenario 2 (schemas and data): read-only against production; the
  anchors SQL step is operator-approved evidence, never in the script.
- Scenario 5 (ultrathink-kickoff calls graph_register): config check is
  read-only; the live part reads one real kickoff graph (`--graph`).
- Scenarios 1, 3, 6 and 8 write, so on production they refuse without
  `--live <approval-ref>`; scenario 8 stays optional there because its
  rows are permanent. Scenario 7 never touches the target on any run.

## Rehearsal-first proof (2026-10-10, run uat-p2006fresh, plan 20-06)

- Twin: `bun run rehearsal up --name p20 --port 0` from a clean worktree at
  main `1ee0b11` (dirty=false) → twin on `http://127.0.0.1:37703` (scratch
  Postgres + scratch ledger, loopback only); consumer.env sourced; script run
  with `--tag p2006fresh --scenarios 1,3,4,6,7,8 --report
  /tmp/p20-06-uat-harness.md`; exit 0, 6/6 scenarios passing. The persistent
  `:17410` twin was left untouched (it serves sibling Phase 19 worktree commit
  `57eba76`, not main).
- Teardown: `bun run rehearsal down --name p20` → stopped pid 1675010,
  removed 2 containers. Production stores received nothing: the run used
  scratch loopback ports by construction, and scenario 7 used only its own
  dead port plus its own accept-and-hang listener.
- Reports: `/tmp/p20-06-uat-harness.md` (Markdown table) and
  `/tmp/p20-06-uat-harness.md.json` (JSON). Plugin serving the run:
  0.3.0 @ 85ca1ac. Reports hold ids, counts, statuses, booleans and elapsed
  times only.

| Scenario | Verdict | Evidence |
| --- | --- | --- |
| 1 substrate-mcp serves both surfaces | pass | tools/list 23 tools, 9 v1 names present; /healthz 200; /brief 200; /events 202 stored true; graph_register 1 node; /verify 200 ok true |
| 3 index backfilled from the Notion Agent Task Graph | pass | 2 graphs backfilled from exported rows, 3 nodes, 3 Linear identifiers |
| 4 the brief reaches a Claude Code session | pass | fetchBrief non-empty brief (259 bytes); prompt-context substrate brief header present |
| 6 Cursor hooks and the git post-commit collector are installed | pass | 3 desired entries (sessionStart,postToolUse,stop); BRIEF.md written; no event emitted; stop exit 0 stdout empty; post-commit hook present; 1 commit event matched by surface, kind, repo and since; tool.call read-back 1 row; session.end read-back 1 event for the run-tagged conversation |
| 7 a substrate outage does not block any agent | pass | fetchBrief empty in 0 ms; CLI brief exit 0 empty stdout in 41 ms; hook brief exit 0 stdout empty in 1546 ms |
| 8 phase proof — cross-surface brief | pass | graph_claim decision granted; file.edit emit 202 stored true; brief 200 with cross-surface lines present |

## Identity manifest proof (2026-10-10, names-only, no live mutation)

- `bun run identity:check` → exit 0, `PASS`: 49 clients from
  `infra/identity/clients.json`; server `/etc/substrate/substrate.env` 28/29
  names present; every live client delivery present (token files stat-only);
  not-installed/external rows unchanged. Output holds names and verdict words
  only — a token-shape scan over the output finds nothing.
- Values mode (`--values`), provisioning, restart and soak stay
  operator-gated in the 20-06 live window; this run never read a value.

## Token-serving parity proof (2026-10-10, twin :37703, no live mutation)

- Against the rehearsal-first twin with its scratch tokens: anonymous
  `/healthz` → 401; `claude-code` bearer → 200; per-surface `cursor` token-file
  bearer → 200; wrong bearer → 401. Per-surface tokens enforced, unknown
  bearers refused, no value printed by any step.
- Production read-only observation via `bun run parity:check` (targets the
  unit by design): `substrate-mcp.service` active/running, NRestarts=0, owns
  `:7410`, serves checkout `5f495ad` (two docs-only commits behind
  origin/main `1ee0b11`); production `/healthz` answers 401 to the twin bearer
  with the names-only "auth on, token missing" verdict — auth enforced live.

## Production scenarios — live-gated for the operator window, never run here

- Task 1 (switch-on, values mode, restart, soak) and Task 2 (cross-repo push,
  PR, merge, plugin refresh, entry writer, hook installs) were NOT run: every
  step mutates production or another repo and needs explicit operator
  approval. The exact commands are collected in the phase close-out report's
  OPERATOR APPROVAL NEEDED section.
- Scenario 2 (schemas and data): read-only against production; the anchors
  SQL step is operator-approved evidence, never in the script.
- Scenario 5 (ultrathink-kickoff calls graph_register): config check is
  read-only; the live part reads one real kickoff graph (`--graph`).
- Scenarios 1, 3, 6 and 8 write, so on production they refuse without
  `--live <approval-ref>`; scenario 8 stays optional there because its rows
  are permanent. Scenario 7 never touches the target on any run.
