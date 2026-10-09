# Continuous integration

`.github/workflows/ci.yml` is the repository's verification gate. It runs on every pull request, on every push to `main`, on demand (`workflow_dispatch`) and once a week.

## What runs

| Job | When | Steps |
|---|---|---|
| `verify` ("Typecheck, tests and repo locks") | pull request, push to `main`, on demand | `bun install --frozen-lockfile`, `bunx tsc --noEmit`, `bun test`, `bun run check:phase-close` |
| `dependency-audit` ("Known-vulnerability audit") | push to `main`, weekly, on demand (never on a pull request) | `bun install --frozen-lockfile --ignore-scripts`, `bun audit --audit-level=high` |

The audit does not gate pull requests on purpose: advisories appear without any change here. A red scheduled run is the signal to upgrade.

`verify` runs a throwaway Postgres 16 service container and exports `SUBSTRATE_TEST_PG_URL` for the job, so the index tests that skip on a machine without a database (leases, memory, search, graph bindings) run in CI. Locally the full suite is 1500+ passing tests with the database and about 56 skipped without it.

## Reproduce a run locally

```sh
bun install --frozen-lockfile
bunx tsc --noEmit
bun test
bun run check:phase-close
```

To include the database-backed tests without installing Postgres, use the rehearsal twin ([`rehearsal.md`](rehearsal.md)), which starts a scratch Postgres and GreptimeDB and writes an env file that exports `SUBSTRATE_TEST_PG_URL`:

```sh
bun run rehearsal up --name local --port 0
( set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/local/consumer.env"; set +a; bun test )
bun run rehearsal down --name local
```

`bun audit` shows the same advisories the weekly job reports.

## What stays out of CI, and why

- Nothing in the suite needs GreptimeDB: the tests that touch the ledger use fakes, and the real-store proofs live in the rehearsal twin (`bun run rehearsal smoke`) and the smoke scripts, which need Docker images the runner would have to pull on every run.
- The production checks (`bun run parity:check`, the rehearsal's production-facing guards) read the operator's host and are never run by CI.
- No Python tests exist on `main` yet. When the dispatcher and miner land (milestone v1.3), add a `setup-python` step pinned by commit SHA and a `python3 -m pytest` line to `verify`.

## Rules for editing the workflow

- Pin every third-party action by full commit SHA with the version in a comment; resolve a tag with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` and dereference an annotated tag through `git/tags/<sha>`.
- Keep `permissions: contents: read` and `persist-credentials: false`. No secrets belong in this file; the database password is a scratch value for a container that lives for one job.
- The job and step names are stable on purpose: they are what a branch-protection rule would require once the repository's plan supports one.
