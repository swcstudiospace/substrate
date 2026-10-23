# Phase 0 UAT regression

Tracked as UAT-01, UAT-02, UAT-04. Owned by `scripts/uat-phase0.ts`, with the
backfill fixture at `scripts/uat/fixtures/notion-rows.json`.

One command runs any subset of the eight deferred scenarios of
`.planning/milestones/v1.0-phases/00-brief/0-UAT.md` against any
`SUBSTRATE_URL`, with the operator's bearer resolved like the CLI (`SUBSTRATE_TOKEN`,
then the token-file variable, then the tokens dir); a scenario that names another surface sends that surface's own token. The script stays outside
the store lock: no store keys, no store clients. Every write is run-tagged
(`uat-<tag>` in graph, session and repo fields), and reports hold ids,
counts, statuses, booleans and elapsed times only — never a token, never a
raw brief body or event summary, never a non-loopback host.

## Commands

All runs go through the `uat:phase0` package script. The script sources
nothing by itself; proofs source the harness's `consumer.env` first:

```sh
set -a; . <run-dir>/consumer.env; set +a
bun run uat:phase0 --tag <run-tag> [--scenarios 1,3,4,6,7,8] [--report <path>] [--live <approval-ref>] [--graph <gid>]
```

Flags, as built:

- `--tag <run-tag>` (required) — 1–64 chars of `[A-Za-z0-9-]`, starting
  alnum. Every write lands under `uat-<tag>` in its graph, session and
  repo fields, so a run's rows are found and never collide.
- `--scenarios 1,3,4,6,7,8` (default: all allowed for the target) — the
  harness default is `1,3,4,6,7,8`; the production default is the read-only
  set `2,4,5,7`. Scenarios 2 and 5 need seeded data or a live kickoff
  graph, so the harness default leaves them out.
- `--report <path>` — writes the Markdown table to `<path>` and the JSON
  to `<path>.json`.
- `--live <approval-ref>` — required for any write scenario (`1,3,6,8`)
  against a production target. Without it the script refuses before any
  request.
- `--graph <gid>` — the graph scenario 2 reads and scenario 5's live part
  checks. On a scratch run the script uses the graphs it just registered;
  on production the operator passes a real graph id (scenario 5's live
  part only reads it).

A target whose port is `7410`, `7411` or `6420`, or whose host is not
loopback, is production — the same guard as the harness, imported from
`scripts/rehearsal.ts`, never copied. Scenario 7 ignores the target
entirely: it uses its own dead loopback port and its own accept-and-hang
listener, and never stops anything.

## The regression loop

The loop later phases run after any surface, tool, header or hook change:

```sh
bun run rehearsal up --name <n>
set -a; . ${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/<n>/consumer.env; set +a
bun run uat:phase0 --tag <run-tag> --scenarios 1,3,4,6,7,8 --report <path>
bun run rehearsal down --name <n>
```

The harness uses scratch loopback ports by construction, so production
stores receive nothing. Scenario 7 uses only its own ports.

## Where each scenario runs

| Scenario | Harness (scratch twin) | Production (after switch-on, operator approval) |
| --- | --- | --- |
| 1. Both surfaces | probe emit plus register, read-only checks | read-only checks; probe emit only with `--live` |
| 2. Schemas and data | not run (needs seeded rows; SQL step is operator-only) | read-only; anchors SQL step recorded as evidence, never in the script |
| 3. Backfill | `backfill-run` shape over exported fixture rows, then `graph_get` | `graph_get` of graph ids from an operator-approved read-only Notion export |
| 4. Brief in session | installed plugin `fetchBrief` plus prompt-context header, no model quota | same, against production |
| 5. Kickoff registers | not run (needs a real kickoff) | config check read-only; live part reads the kickoff graph with `--graph` |
| 6. Cursor and hook | scratch repo, synthetic envelopes, installed hook, matched by surface, kind, repo and since | real Cursor session and real commit |
| 7. Outage | own dead port plus own hanging listener | own dead port plus own hanging listener (never the target) |
| 8. Cross-surface brief | run-tagged repo, optional on production (rows are permanent) | optional, with `--live` |

## Production live-reference rule

Against production the script runs only read-only checks unless
`--live <approval-ref>` names the operator's approval for the window.
Write scenarios refuse without it, before any request, with exit `2`.
Scenario 5's live part only ever reads the kickoff graph.

## Report format

`--report <path>` writes two files: the Markdown table (`<path>`) with one
evidence line per scenario, and the JSON (`<path>.json`) with the same
verdicts plus the target kind, the plugin version and commit, and the
pass/fail counts. Both hold ids, counts, statuses, booleans and elapsed
times only.

## The consumer contract

The script reads only `SUBSTRATE_URL` (and the bearer inputs) from the
environment — the same six-key `consumer.env` the rehearsal harness
writes. It never reads `stores.env` and never takes a store URL. A scenario naming a non-operator surface sends that surface's own token from `SUBSTRATE_TOKENS_DIR` (or `SUBSTRATE_REHEARSAL_TOKENS_DIR` in a harness run, else the CLI default directory), and `SUBSTRATE_TOKEN` is the operator's bearer only.

## Exits

`0` every selected scenario passed, `1` a scenario failed (recorded as
failed with its evidence, never re-scoped), `2` usage or a refused target.
A refusal happens before any request — health check included.
