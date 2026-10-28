# Contributing

This is a private repository with a single maintainer. Cloud agents and humans follow the same rules. [`AGENTS.md`](AGENTS.md) holds the desk rules for cloud agents; [`docs/ci.md`](docs/ci.md) describes the verification gate and CI.

## Setup

- Bun 1.4.0 (`packageManager` in `package.json`; `engines.bun` is `>=1.4.0`, and CI pins 1.4.0).
- System Python 3 for the miner and dispatcher suites. `bun run verify` runs them through `uv run` with pinned `httpx` and `pytest`, so `uv` must be on `PATH`. Without `uv`, `python3 -m pytest packages/miner/tests packages/dispatcher/tests` needs `httpx` and `pytest` installed for system `python3`.
- Postgres 16 for the live index tests (leases, memory, search, graph bindings). They read the connection string from `SUBSTRATE_TEST_PG_URL` and skip, saying so, when it is unset. CI creates a database named `substrate_test` through [`.github/actions/scratch-postgres`](.github/actions/scratch-postgres/action.yml); the user, password and port for the local scratch instance are in [`AGENTS.md`](AGENTS.md) and that action. [`docs/rehearsal.md`](docs/rehearsal.md) describes a scratch twin that writes the variable for you.
- Environment variables are documented in [`.env.example`](.env.example) and [`docs/config-reference.md`](docs/config-reference.md). Never commit a filled-in env file.

## Commands

```sh
bun install --frozen-lockfile
bunx tsc --noEmit                    # typecheck
bun test                             # full suite; set SUBSTRATE_TEST_PG_URL to run the live index tests
python3 -m pytest packages/miner/tests packages/dispatcher/tests
bun run check:phase-close            # event vocabulary, store lock, audit policy and redaction locks
bun run verify                       # the whole gate: install, types, lint, tests, python, locks
bun run verify --only types,locks    # selected steps (ids: install, types, lint, tests, python, locks, audit)
bun run verify --list                # print the steps
bun run verify --audit               # also run the dependency audit (needs the network)
bun run lint                         # Biome; errors block the gate, warnings stay visible
```

`bun run verify` is the gate CI runs; a drift test (`scripts/verify.test.ts`) fails when the workflow and `scripts/verify.ts` disagree. Change a gate command in both together.

## Branches and commits

- Branches: `gsd/<name>` for planned work; other prefixes in the history include `docs/`, `feat/`, `fix/` and `ci/`.
- Commit subjects use a conventional prefix with a scope and the PR number added on squash, for example `fix(cli): ...`, `feat(planning): ...`, `docs(planning): ...`, `ci: ...`, `test: ...`.
- Add a `Tracked:` line to the commit body or PR description that links the ticket.
- Files under `.planning/` change only through a GSD workflow.

## Review and merge

1. Open the PR as a draft against `main`. Cloud agents never merge, enable auto-merge, force-push or delete branches ([`AGENTS.md`](AGENTS.md)).
2. Greptile reviews every PR. It must be at 5/5 with no open threads. A failed, skipped or unavailable review is a blocker, not a pass.
3. CI must be green ([`docs/ci.md`](docs/ci.md)). Fork pull requests run no jobs.
4. The maintainer squash-merges (the history on `main` is one commit per PR).

## Tests

- Test behaviour that can fail: decisions, parsing of untrusted input, locks, ordering and races. A fix ships with a regression test that fails before the fix and passes after it.
- Keep tests deterministic: injected clocks and fakes, no network, no real sleeps beyond a few milliseconds.
- Decision logic is proved against a fake store ([`docs/memory-governance.md`](docs/memory-governance.md)). Behaviour that only a real database can settle (concurrency, unique indexes, ordering) runs against Postgres through `SUBSTRATE_TEST_PG_URL` and skips loudly without it, rather than against a mock ([`docs/coordination.md`](docs/coordination.md)).
- Redaction goes through the single module `packages/mcp-server/src/redact.ts`; `redact-lock.test.ts` fails the suite when another package redacts through anything else ([`docs/redaction.md`](docs/redaction.md)).
- Production checks (`bun run parity:check` and the other `doctor`/`deploy` scripts) read the operator's host and are not part of the gate.

## Generated files

`docs/config-reference.md` and the evidence table in `docs/runbooks/flag-promotion.md` are generated from the flag registry. Regenerate them with `bun scripts/config-reference.ts` (or `bun run config:reference`); `bun scripts/config-reference.ts --check` writes nothing and fails when the committed files differ. `scripts/config-reference.test.ts` runs that check.

## Where things are written down

- [`docs/ci.md`](docs/ci.md): the gate, CI jobs, the audit gate and accepted risk.
- [`docs/adr/`](docs/adr/): architecture decision records. Supersede one with a new file, not an edit.
- [`docs/runbooks/`](docs/runbooks/): operator procedures.
- [`AGENTS.md`](AGENTS.md): desk rules and the cloud-agent development loop.
- [`SECURITY.md`](SECURITY.md): reporting a vulnerability and handling secrets.
