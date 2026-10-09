# Verification gate and CI

The gate is four checks, run in this order. `bun run verify` runs them locally; `.github/workflows/ci.yml` runs the same commands on GitHub.

| Step | Command | What it proves |
|---|---|---|
| `install` | `bun install --frozen-lockfile` | `bun.lock` matches every `package.json` |
| `types` | `bunx tsc --noEmit` | the whole workspace typechecks |
| `tests` | `bun test` | the full suite passes |
| `locks` | `bun run check:phase-close` | the event vocabulary, store lock, audit policy and redaction locks hold |
| `audit` (opt-in) | `bun audit --audit-level=high` | no known high or critical advisory in the lockfile; needs the network |

## Run it locally

```sh
bun run verify              # install, types, tests, locks
bun run verify --audit      # plus the dependency audit
bun run verify --only types,locks
bun run verify --keep-going # do not stop at the first failure
bun run verify --list
```

A passing step prints one line (with the pass/skip/fail counts for the suite). A failing step prints the last 60 lines of its output and the run stops, exit code 1. Exit code 2 means bad usage.

`scripts/verify.test.ts` reads `.github/workflows/ci.yml` and fails when the workflow runs different commands from `bun run verify`, or when a job loses its `CI_ENABLED` switch, so the two cannot drift apart silently.

### The database-backed tests

About 56 tests (leases, memory, search, graph bindings) skip when `SUBSTRATE_TEST_PG_URL` is unset, and `bun run verify` says so. CI runs them against a scratch Postgres 16. To run them locally, use the rehearsal twin ([`rehearsal.md`](rehearsal.md)), which starts a scratch Postgres and GreptimeDB and writes an env file that exports the variable:

```sh
bun run rehearsal up --name local --port 0
( set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/local/consumer.env"; set +a; bun run verify )
bun run rehearsal down --name local
```

Nothing in the suite needs GreptimeDB; the real-store proofs are the rehearsal smokes (`bun run rehearsal smoke`, `bun run smoke:vocabulary`). `bun run parity:check` and the other production checks read the operator's host and are never run by CI.

## CI

| Job | When | Steps |
|---|---|---|
| `verify` ("Typecheck, tests and repo locks") | pull request, push to `main`, on demand | the four steps above, with a Postgres 16 service container and a full-history checkout (`check:phase-close` diffs against a baseline commit) |
| `dependency-audit` ("Known-vulnerability audit") | push to `main`, Mondays 03:17 UTC, on demand (never on a pull request) | `bun install --frozen-lockfile --ignore-scripts`, `bun audit --audit-level=high` |

The audit does not gate pull requests on purpose: advisories appear without any change here. A red scheduled run is the signal to upgrade.

### Switching it on

Both jobs run only when the repository variable `CI_ENABLED` is `true`. While it is unset they are reported as skipped, which is not a failure and uses no runner minutes.

```sh
gh variable set CI_ENABLED --body true --repo swcstudiospace/agent-substrate   # on
gh variable delete CI_ENABLED --repo swcstudiospace/agent-substrate            # off (kill switch)
```

**Status on 2026-10-09: off.** The first run on pull request 27 failed before any step started, with the annotation "The job was not started because recent account payments have failed or your spending limit needs to be increased". The organisation's Actions usage for the month is already large (other repositories), so enabling this is the operator's decision about spend, not a code change. After the account can run jobs: fix billing, run the workflow once by hand (`gh workflow run CI --ref main` after setting the variable, or open a pull request), confirm `verify` is green, and optionally require `CI / Typecheck, tests and repo locks` in branch protection when the repository's plan supports it. The first run on a real runner may expose a setup detail this repository could not test (for example the Postgres service health check); fix it in a small pull request, or clear the variable while you do.

## Editing the workflow

- Pin every third-party action by full commit SHA with the version in a comment; resolve a tag with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` and dereference an annotated tag through `git/tags/<sha>`.
- Keep `permissions: contents: read` and `persist-credentials: false`. No secrets belong in this file; the database password is a scratch value for a container that lives for one job.
- Change a gate command in `scripts/verify.ts` and in the workflow together; the drift test names whichever one you forgot.
- The job and step names are stable on purpose: they are what a branch-protection rule would require.
- The dispatcher is TypeScript on Bun tested by `bun test`. No Python tests exist on `main` yet. When the miner lands (milestone v1.3), add a `setup-python` step pinned by commit SHA and a pytest step to `verify` for the miner only, and mirror it in `scripts/verify.ts`.
