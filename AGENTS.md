<!-- substrate-brief:start -->
Read `.substrate/BRIEF.md` at the start of your work in this repo. It is
the current substrate brief — a record of what other agents did here.
Substrate writes this file on a schedule; do not edit it by hand.
<!-- substrate-brief:end -->

## Desk rules for cloud agents

Cursor cloud agents in this repository follow the rules below. Grok Bot is the `grok-bot` surface; how that surface reaches substrate data is [`docs/grok-bot.md`](docs/grok-bot.md).

- **Draft PR only.** Open a draft pull request into the default branch. No merge: do not merge, enable auto-merge, force-push, or delete branches.
- **No secrets.** Never print, commit, or echo tokens, keys, passphrases, or bus secrets. Reference environment variables by name only. Do not write tailnet names or internal hostnames into the repo, the pull request, or the session transcript.
- **Greptile gate via Desk Quality.** Every pull request goes through the Greptile merge gate run by Desk Quality via Programming Lead. Do not claim merge-ready while any Greptile finding is unaddressed. A FAILED, SKIPPED, or unavailable review is a blocker to report, never a pass.

## Cursor Cloud specific instructions

The development loop is Bun 1.4.0 (the version CI pins) plus system Python 3.12 and `uv`. `bun` and `bunx` are on `/usr/local/bin`. `bun run verify` runs the Python suites through `uv run` with pinned httpx and pytest, so `uv` must be on `PATH`.

Scratch Postgres 16 is started on boot. Use the same user and password as `SUBSTRATE_TEST_PG_URL` in `.github/workflows/ci.yml`, on `127.0.0.1:5432`:

- `SUBSTRATE_PG_URL` points at database `substrate`. `substrate-mcp` is already listening on `127.0.0.1:7410` with that index, so `GET /healthz` is 200 and `POST /brief` returns the markdown brief.
- `SUBSTRATE_TEST_PG_URL` points at database `substrate_test`. Set it before `bun test` so the live index tests (leases, memory, search, graph bindings) run.

Checks, from the repo root: `bun run verify` is the gate CI runs: frozen install, `bunx tsc --noEmit`, `bun test`, the Python suites through `uv`, and the repo locks, which include `bun run check:phase-close`. Set `SUBSTRATE_TEST_PG_URL` before `bun test` so the live index tests run. A quick Python run without `uv` (`python3 -m pytest packages/miner/tests packages/dispatcher/tests`) needs httpx and pytest installed for system `python3`.

`commit.gpgsign` is false here. `bun test` creates many temporary repositories, and SSH-signing each of those commits through the host agent overruns the suite's 5 second timeout. Desktop-container tests and the rehearsal twin stay skipped; they need Docker images that are outside this loop.
