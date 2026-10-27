# Verification gate and CI

The gate is five checks, run in this order. `bun run verify` runs them locally; `.github/workflows/ci.yml` runs the same commands on GitHub.

| Step | Command | What it proves |
|---|---|---|
| `install` | `bun install --frozen-lockfile` | `bun.lock` matches every `package.json` |
| `types` | `bunx tsc --noEmit` | the whole workspace typechecks |
| `tests` | `bun test` | the full suite passes |
| `python` | `uv run --no-project --with httpx==0.28.1 --with pytest==9.1.1 python -m pytest packages/miner/tests packages/dispatcher/tests` | the miner and dispatcher Python suites pass, in an ephemeral environment pinned to the versions they were verified with |
| `locks` | `bun run check:phase-close` | the event vocabulary, store lock, audit policy and redaction locks hold |
| `audit` (opt-in) | `bun scripts/audit-gate.ts` | no high or critical advisory in the lockfile, except the accepted risks below; needs the network |

## Run it locally

Prerequisites: Bun 1.4.0 and `uv` on `PATH`. The `python` step runs `uv run`. CI installs the pinned `uv` release and checks its SHA-256 before use, so a local run needs `uv` installed too.

```sh
bun run verify              # install, types, tests, python, locks
bun run verify --audit      # plus the dependency audit
bun run verify --only types,locks
bun run verify --keep-going # do not stop at the first failure
bun run verify --list
```

A passing step prints one line (with the pass/skip/fail counts for the suite). A failing step prints the last 60 lines of its output and the run stops, exit code 1. Exit code 2 means bad usage.

`scripts/verify.test.ts` reads `.github/workflows/ci.yml` and fails when the workflow runs different commands from `bun run verify`, when a job loses its `CI_ENABLED` switch, when the report-only `boot-gate` job stops being report-only or limited to `bun install --frozen-lockfile` and `bun run gate:boot`, or when the report-only `lint-report` job stops being report-only or limited to the install and `bunx biome lint`, so the workflow cannot drift apart silently.

### The database-backed tests

About 56 tests (leases, memory, search, graph bindings) skip when `SUBSTRATE_TEST_PG_URL` is unset, and `bun run verify` says so. CI runs them against a scratch Postgres 16 that the `verify` job starts from the runner image's PostgreSQL 16 binaries (see below). To run them locally, use the rehearsal twin ([`rehearsal.md`](rehearsal.md)), which starts a scratch Postgres and GreptimeDB and writes an env file that exports the variable:

```sh
bun run rehearsal up --name local --port 0
( set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/local/consumer.env"; set +a; bun run verify )
bun run rehearsal down --name local
```

Nothing in the suite needs GreptimeDB; the real-store proofs are the rehearsal smokes (`bun run rehearsal smoke`, `bun run smoke:vocabulary`). `bun run parity:check` and the other production checks read the operator's host and are never run by CI.

## CI

| Job | Runner | When | Steps |
|---|---|---|---|
| `verify` ("Typecheck, tests and repo locks") | `[self-hosted, linux, x64, omega-ci]` | same-repo pull request, push to `main`, on demand (never on the schedule) | the five steps above, with a scratch Postgres 16 (the local `scratch-postgres` action) and a full-history checkout (`check:phase-close` diffs against a baseline commit) |
| `dependency-audit` ("Known-vulnerability audit") | `[self-hosted, linux, x64, omega-ci]` | push to `main`, Mondays 03:17 UTC, on demand (never on a pull request) | `bun install --frozen-lockfile --ignore-scripts`, `bun scripts/audit-gate.ts` |
| `boot-gate` ("Boot and prove (report-only)") | `[self-hosted, linux, x64, omega-ci]` | same-repo pull request, push to `main`, on demand (never on the schedule); only when `BOOT_GATE` is `true` | `bun install --frozen-lockfile`, `bun run gate:boot` |
| `lint-report` ("Lint (Biome, report-only)") | `[self-hosted, linux, x64, omega-ci]` | same-repo pull request, push to `main`, on demand (never on the schedule) | `bun install --frozen-lockfile`, `bunx biome lint --reporter=summary .` (`continue-on-error`: findings never block) |

Fork pull requests run none of these jobs: each job's `if:` skips a pull request whose head repository is not this repository, because a fork's code would otherwise run on the shared runner pool.

Lint is report-only. `bun run lint` runs `biome lint` (Biome 2.6.2 with the recommended rules; the formatter is off, so nothing is reformatted). The `lint-report` job runs the same command with `continue-on-error`, so its findings are advisory. Making it blocking is a separate decision, taken after the findings are triaged.

Every job runs on the Omega CI runner pool (`[self-hosted, linux, x64, omega-ci]`, [swcstudiospace/Omega-Prime `docs/ci-runners.md`](https://github.com/swcstudiospace/Omega-Prime/blob/main/docs/ci-runners.md)), never on GitHub-hosted runners. Jobs run as an unprivileged user with no Docker and no `sudo`, so there are no service containers. The `verify` job's scratch database comes from [`.github/actions/scratch-postgres`](../.github/actions/scratch-postgres/action.yml): it runs `initdb` and `pg_ctl` from the image's PostgreSQL 16 into `$RUNNER_TEMP`, listening on 127.0.0.1 and a port the kernel reports free for that job (parallel jobs on one runner host never clash), with trust authentication on loopback. It creates `substrate_test` and exports `SUBSTRATE_TEST_PG_URL`. An `if: always()` step of the same action stops the cluster. Both are `uses:` steps, so the job's `run:` lines stay exactly the gate's four commands. The dependency audit runs on pushes to `main`, weekly and on demand, not on pull requests, so a new high or critical advisory fails it until the package is upgraded or listed under the accepted risks below. The weekly scheduled run re-checks the lockfile for advisories published between changes; a red scheduled run is the signal to upgrade.

### The Hindsight lag watcher

`.github/workflows/hindsight-lag.yml` is a second workflow, separate from the gate: it runs on the same Omega CI pool and behind the same `CI_ENABLED` switch, on Mondays 04:43 UTC and on demand (never on a pull request), with `permissions` limited to `contents: read` and `issues: write`, and no secret but the run's own `GITHUB_TOKEN`. It runs `bun scripts/hindsight-lag.ts`, which compares `.github/hindsight-pin.json` with the stable releases of the upstream Hindsight and keeps one open issue labelled `hindsight-lag` once the oldest stable release newer than the pin has existed for `lag_alert_days` (the issue names the newest stable release); a second job, `report-failure`, with its own checkout and Bun setup, runs only when the first failed and keeps one issue labelled `hindsight-lag-failed` so a broken watcher is visible even when checkout or Bun setup failed. It opens no pull request and never touches Railway. Run it read-only with `bun scripts/hindsight-lag.ts --dry-run`. The upgrade itself is a manual, operator-only procedure: [runbooks/hindsight-upgrade.md](runbooks/hindsight-upgrade.md).

### Accepted risk and the audit gate

`bun scripts/audit-gate.ts` reads `bun audit --json`, the machine-readable form of the audit. It filters the advisories to `high` and `critical` itself, because `bun audit --audit-level` does not filter the JSON. It fails the job (exit 1) on any high or critical advisory except the ones below. Each accepted advisory must match on GHSA id, package and version, and the lockfile must install that package at exactly that one version. Anything else fails: a new advisory, an upgrade or downgrade of an accepted package, or a second installed version of one. Each entry lives in `.github/audit-accepted-risk.json`. When an accepted advisory's `review_by` date has passed, the gate still passes and prints a warning.

Accepted by the owner (SomeRandmGuyy, decision of 2026-10-21, review by 2027-01-19):

| Advisory | Package@version | Severity | Reason | Owner | Review by | Removal condition |
|---|---|---|---|---|---|---|
| GHSA-jfgx-wxx8-mp94 (CVE-2026-54328) | `@mariozechner/pi-coding-agent`@0.60.0 | high | Predictable temporary extension install paths allow local privilege escalation on shared Linux hosts. No patched version. Pulled in by `@agentos-software/pi`. | SomeRandmGuyy | 2027-01-19 | the advisory stops appearing in `bun audit` (a fixed release is installed, or the package is removed) |
| GHSA-c475-qrg2-pj4r | `basic-ftp`@5.3.1 | high | Patched in 6.2.1, with no in-range fix. Reached only through the pi-ai and proxy-agent chain (`get-uri`). | SomeRandmGuyy | 2027-01-19 | the chain moves to basic-ftp 6.2.1 or later, or the package is removed |
| GHSA-gpj5-g38j-94v9 | `drizzle-orm`@0.44.7 | high | Patched in 0.45.2. Reached through `rivetkit` 2.3.10, which `agentos` 0.2.21 pins. | SomeRandmGuyy | 2027-01-19 | `rivetkit` and `agentos` accept drizzle-orm 0.45.2 or later |
| GHSA-jmr9-qjv8-65gv | `extract-zip`@2.0.1 | high | No patched version. | SomeRandmGuyy | 2027-01-19 | the advisory stops appearing in `bun audit` |
| GHSA-7pqw-9j4j-h8q3 | `extract-zip`@2.0.1 | high | No patched version. | SomeRandmGuyy | 2027-01-19 | the advisory stops appearing in `bun audit` |

Adding or changing an entry is a reviewed change to `.github/audit-accepted-risk.json`, with the owner's name in `owner`. Remove an entry once its removal condition holds; the gate does not flag unused entries. Removing an exception while its advisory is still reported makes the gate fail again.

### The boot-gate job

`bun run gate:boot` ([runbooks/release-gate.md](runbooks/release-gate.md)) boots the commit under test against scratch Postgres and GreptimeDB containers through the rehearsal harness ([rehearsal.md](rehearsal.md)), proves it over HTTP, freezes the scratch ledger for a real outage and removes everything again. Its exit code is 0 (every check passed), 1 (a check failed) or 2 (the harness refused to start, for example Docker missing or an image absent).

The job is **report-only**: `continue-on-error: true`, so a red or exit-2 run is reported on the run page and never blocks a pull request or turns the workflow red. It has no Postgres service container; the harness starts its own stores.

It is opt-in on a second repository variable, because it starts containers. **On the Omega CI pool it cannot run yet:** the pool has no Docker daemon, so the harness exits 2 at its Docker preflight. Keep `BOOT_GATE` unset until the rehearsal harness gains a native-process store backend (PostgreSQL 16 and `greptime` binaries are in the runner image; the outage step would pause the ledger process instead of its container). The constraints below describe the Docker harness as it stands:

```sh
gh variable set BOOT_GATE --body true --repo swcstudiospace/agent-substrate   # on (also needs CI_ENABLED)
gh variable delete BOOT_GATE --repo swcstudiospace/agent-substrate            # off
```

Host caveats, all of which show as exit 2 rather than a failure:

- It needs a local Docker daemon the runner user may use, and the images `postgres:16` and `greptime/greptimedb:v0.14.4` already present locally. The harness never pulls and never prunes.
- It needs 2 GiB free on Docker's data root (the harness refuses below that; it checks no RAM floor), and it runs two store containers plus the server while it lasts. On a runner that is also production, the host's disk pressure and the daily image prune decide whether it can run at all.
- It runs the real server on a free loopback port and never touches the production ports (`7410`, `7411`, `6420`) or any container it did not label itself. Another run with the same name is refused, not stopped.
- A normal run takes about one to two minutes (one live run with the previous 20 s outage window took 64 s; the default window is now 40 s, and the recovery wait can use up to 90 s when the ledger is slow to come back).
- A cancelled or timed-out job: the gate cleans up on `SIGINT`, `SIGTERM` and `SIGHUP` (a runner's cancel signal), but `SIGKILL` after the runner's grace period cannot be handled and can leave the detached twin and its two containers behind. Sweep them with `bun run rehearsal down --name <gate name>` (printed in the job log as `gate-<time>`) or look with `docker ps -a --filter label=substrate.rehearsal`. The job has no always-run cleanup step on purpose: the job's run lines stay pinned to the install and `bun run gate:boot`, and an extra cleanup command would need `verify.test.ts` to learn it.

### Switching it on

Every job runs only when the repository variable `CI_ENABLED` is `true`; `boot-gate` additionally needs `BOOT_GATE`. While `CI_ENABLED` is unset they are reported as skipped, which is not a failure and uses no runner minutes.

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
- The Python suites in `packages/miner/tests` and `packages/dispatcher/tests` run in the `python` step of `verify` and in the `verify` job. Their dependencies come from `uv run --no-project` with exact pins; keep those pins in sync with the packages' declared `httpx>=0.27` and `pytest>=8.0`.
