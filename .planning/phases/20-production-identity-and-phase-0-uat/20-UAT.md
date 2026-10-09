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
