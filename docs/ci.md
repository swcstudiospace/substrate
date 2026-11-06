# Verification gate and CI

The gate is six checks, run in this order. `bun run verify` runs them locally; `.github/workflows/ci.yml` runs the same commands on GitHub.

| Step | Command | What it proves |
|---|---|---|
| `install` | `bun install --frozen-lockfile` | `bun.lock` matches every `package.json` |
| `types` | `bunx tsc --noEmit` | the whole workspace typechecks |
| `lint` | `bunx biome lint --reporter=summary .` | Biome reports no error and no warning: every rule that used to warn is an error now, and the tree has none left |
| `tests` | `bun test` | the full suite passes |
| `python` | `uv run --no-project --with httpx==0.28.1 --with pytest==9.1.1 python -m pytest packages/miner/tests packages/dispatcher/tests` | the miner and dispatcher Python suites pass, in an ephemeral environment pinned to the versions they were verified with |
| `locks` | `bun run check:phase-close` | the event vocabulary, store lock, audit policy and redaction locks hold |
| `audit` (opt-in) | `bun scripts/audit-gate.ts` | no high or critical advisory in the lockfile, except the accepted risks below; needs the network |

## Run it locally

Prerequisites: Bun 1.4.0 and `uv` on `PATH`. The `python` step runs `uv run`. CI installs the pinned `uv` release and checks its SHA-256 before use, so a local run needs `uv` installed too.

```sh
bun run verify              # install, types, lint, tests, python, locks
bun run verify --audit      # plus the dependency audit
bun run verify --only types,locks
bun run verify --keep-going # do not stop at the first failure
bun run verify --list
```

A passing step prints one line (with the pass/skip/fail counts for the suite). A failing step prints the last 60 lines of its output and the run stops, exit code 1. Exit code 2 means bad usage.

`scripts/biome-config.test.ts` pins the Biome rule levels below, so loosening the gate needs a deliberate test change. `scripts/verify.test.ts` reads `.github/workflows/ci.yml` and fails when the workflow runs different commands from `bun run verify`, when a job loses its `CI_ENABLED` switch, when the report-only `boot-gate` job stops being report-only or limited to `bun install --frozen-lockfile` and `bun run gate:boot`, so the workflow cannot drift apart silently.

### The database-backed tests

About 56 tests (leases, memory, search, graph bindings) skip when `SUBSTRATE_TEST_PG_URL` is unset, and `bun run verify` says so. CI runs them against a scratch Postgres 16 that the `verify` job starts from the runner image's PostgreSQL 16 binaries (see below). To run them locally, use the rehearsal twin ([`rehearsal.md`](rehearsal.md)), which starts a scratch Postgres and GreptimeDB and writes an env file that exports the variable:

```sh
bun run rehearsal up --name local --port 0
( set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/local/consumer.env"; set +a; bun run verify )
bun run rehearsal down --name local
```

Nothing in the suite needs GreptimeDB; the real-store proofs are the rehearsal smokes (`bun run rehearsal smoke`, `bun run smoke:vocabulary`). `bun run parity:check` and the other production checks read the operator's host and are never run by CI.

### Code ratchet

`scripts/code-ratchet.ts` counts risky patterns in every non-test `.ts` file under `packages/` and `scripts/`: explicit `any`, `as unknown as`, TypeScript and lint suppression comments, non-null assertions, empty `catch` blocks, `console.*` calls in `packages/*/src`, `process.exit(` calls outside CLI entrypoints, and `JSON.parse(...) as Type` casts (every type except `unknown` and `const`). Counting is AST-based: each file is parsed once with the TypeScript compiler API and walked by syntax node (`ts.forEachChild`, no token objects), so strings, template text, regex literals and comment text are never mistaken for code. Suppression comments are read by one linear `ts.createScanner` pass over the whole text (so a comment before `else`, `finally` or a closing `)` counts too) that jumps over the string, template and regex literal spans the AST walk recorded, and an empty `catch` that holds an explanatory comment is accepted. A file whose text holds none of the substrings any counter needs is not parsed at all. Only source counters exist in the baseline and only they gate; `*.test.ts` files are skipped unless you pass `--with-tests`, which adds an informational test column to the table. A scanned root that does not exist is skipped; any other unreadable directory fails the scan, so an incomplete scan can never pass.

`bun test` runs `scripts/code-ratchet.test.ts`, which fails when a source counter rises above `scripts/code-ratchet.baseline.json`, and also when one falls below it, so the baseline can only move down. After removing offenders, run `bun scripts/code-ratchet.ts --write` and commit the new baseline. `--write` only ever lowers: when the baseline file exists and any source counter is above its baseline value it prints each offending counter, exits 1 and leaves the file untouched. Raising a baseline means deleting the file deliberately, in a reviewed change, and generating it again. `bun scripts/code-ratchet.ts` prints the table; `--check` exits 1 on a regression; `--with-tests` adds the informational test counts.

A CLI entrypoint may call `process.exit`. A file counts as one when it has a shebang, uses `import.meta.main`, is named `*-run.ts`, `index.ts` or `main.ts`, lives under `scripts/`, or carries a `// ratchet-entrypoint` line comment (put it above the guard that makes the file run).

### Docs lint

`scripts/docs-lint.ts` checks the documents and `bun test` runs it through `scripts/docs-lint.test.ts`, so the CI commands do not change. Two rules apply: every relative markdown link in `docs/`, `.planning/` (archives included), `README.md`, `CONTRIBUTING.md`, `AGENTS.md` and `SECURITY.md` must resolve to a file, and every page under `docs/`, every live `.planning/*.md` file and every file under `.planning/phases/` must have a level-1 title. Archived plans under `.planning/milestones/` are exempt from the title rule only. Link and title checks use Bun's built-in markdown parser, so the lint follows CommonMark: titled, reference, angle-wrapped and percent-encoded link destinations are read as a renderer reads them, and a heading inside code or an HTML comment is not a title. Anchors, absolute paths, URLs, fenced code blocks and inline code are not checked as links; to show an illustrative link without breaking the lint, put it in inline code. Run it alone with `bun test scripts/docs-lint.test.ts`; a failure names the file and the target or title.

### Docs eval

`scripts/docs-eval.ts` scores a self-supervised golden set against a deterministic lexical retriever over `packages/corpus/fixtures/eval/`, and `bun test` runs it through `scripts/docs-eval.test.ts`, so the CI commands do not change. It fails when recall at 5 falls by more than 0.02 or MRR by more than 0.03 against `scripts/docs-eval.baseline.json`, when the set loses questions, or when a group of identical documents is not collapsed to one answer: a change in ranking inputs, de-duplication or the re-rank order. It runs offline in a few seconds. After an intended change, `bun scripts/docs-eval.ts --write-baseline` records the new scores; the guide is [`corpus-eval.md`](corpus-eval.md).

## CI

| Job | Runner | When | Steps |
|---|---|---|---|
| `verify` ("Typecheck, lint, tests and repo locks") | `ubuntu-latest` | same-repo pull request, push to `main`, on demand (never on the schedule) | the six steps above, with a scratch Postgres 16 (the local `scratch-postgres` action) and a full-history checkout (`check:phase-close` diffs against a baseline commit) |
| `dependency-audit` ("Known-vulnerability audit") | `ubuntu-latest` | push to `main`, Mondays 03:17 UTC, on demand (never on a pull request) | `bun install --frozen-lockfile --ignore-scripts`, `bun scripts/audit-gate.ts` |
| `boot-gate` ("Boot and prove (report-only)") | `ubuntu-latest` | same-repo pull request, push to `main`, on demand (never on the schedule); only when `BOOT_GATE` is `true` | `bun install --frozen-lockfile`, `bun run gate:boot` |

Fork pull requests run none of these jobs: each job's `if:` skips a pull request whose head repository is not this repository, because a fork's code would otherwise run on this repository's runners.

Lint is blocking: the `lint` step (`bunx biome lint --reporter=summary .`, also `bun run lint` without the reporter) sits between `Typecheck` and `Tests` in the `verify` job and in `bun run verify`. Biome exits non-zero on errors, and the two rules that used to warn are errors now, so a new non-null assertion or a missed optional chain fails the step; the tree reports no warning. Biome is pinned exactly to 2.6.3 in the root `package.json` with the `recommended` preset; the formatter is off, so nothing is reformatted. Every root devDependency (`@biomejs/biome`, `@types/bun`, `typescript`) is pinned to an exact version, so a fresh install cannot move the toolchain without a reviewed change.

Rule decisions in `biome.json`:

| Rule | Level | Why |
|---|---|---|
| `suspicious/noExplicitAny`, `noProto`, `noPrototypeBuiltins`, `noUselessEscapeInString` | error | real defects or type holes; the tree is clean |
| `correctness/noUnusedImports`, `noUnusedVariables`, `noUnusedFunctionParameters` | error | dead code; the tree is clean |
| `style/useConst`, `useImportType` | error | cheap, mechanical, tree is clean (`useImportType` matches `verbatimModuleSyntax`) |
| `complexity/noCommaOperator`, `useRegexLiterals` | error | obscure constructs; the tree is clean |
| `style/noNonNullAssertion` | error | every use was removed; a new `!` fails the step, and the code ratchet's baseline for source is 0 as a second guard (tests narrow with a `defined` helper) |
| `complexity/useOptionalChain` | error | the existing sites were rewritten where the truthiness test cannot differ; a missed chain fails the step |
| `suspicious/noTemplateCurlyInString` | off | false positives on intentional `${...}` text such as templates and docs strings |
| `complexity/useLiteralKeys` | off | conflicts with `noPropertyAccessFromIndexSignature`-style bracket access on index signatures |
| `style/useTemplate` | off | string concatenation is often clearer; purely stylistic |

The compiler is stricter too: `tsconfig.json` enables `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noUnusedLocals` and `noUnusedParameters` on top of `strict`. Under `exactOptionalPropertyTypes` an optional property is either absent or a value of its type: where `undefined` is a legal value the declaration says `key?: T | undefined`, and a serialized or compared object leaves the key out instead of setting it to `undefined`.

Every job runs on a GitHub-hosted runner (`ubuntu-latest`). Jobs run as an unprivileged user with no Docker and no `sudo`, so there are no service containers. The `verify` job's scratch database comes from [`.github/actions/scratch-postgres`](../.github/actions/scratch-postgres/action.yml): it runs `initdb` and `pg_ctl` from the image's PostgreSQL 16 into `$RUNNER_TEMP`, listening on 127.0.0.1 and a port the kernel reports free for that job (parallel jobs on one runner host never clash), with trust authentication on loopback. It creates `substrate_test` and exports `SUBSTRATE_TEST_PG_URL`. An `if: always()` step of the same action stops the cluster. Both are `uses:` steps, so the job's `run:` lines stay exactly the gate's four commands. The dependency audit runs on pushes to `main`, weekly and on demand, not on pull requests, so a new high or critical advisory fails it until the package is upgraded or listed under the accepted risks below. The weekly scheduled run re-checks the lockfile for advisories published between changes; a red scheduled run is the signal to upgrade.

### The Hindsight lag watcher

`.github/workflows/hindsight-lag.yml` is a second workflow, separate from the gate: it runs on a GitHub-hosted runner (`ubuntu-latest`) and behind the same `CI_ENABLED` switch, on Mondays 04:43 UTC and on demand (never on a pull request), with workflow-level `permissions` limited to `contents: read` (`issues: write` is granted only on the two jobs that open or close issues), and no secret but the run's own `GITHUB_TOKEN`. It runs `bun scripts/hindsight-lag.ts`, which compares `.github/hindsight-pin.json` with the stable releases of the upstream Hindsight and keeps one open issue labelled `hindsight-lag` once the oldest stable release newer than the pin has existed for `lag_alert_days` (the issue names the newest stable release); a second job, `report-failure`, with its own checkout and Bun setup, runs only when the first failed and keeps one issue labelled `hindsight-lag-failed` so a broken watcher is visible even when checkout or Bun setup failed. It opens no pull request and never touches Railway. Run it read-only with `bun scripts/hindsight-lag.ts --dry-run`. The upgrade itself is a manual, operator-only procedure: [runbooks/hindsight-upgrade.md](runbooks/hindsight-upgrade.md).

### Accepted risk and the audit gate

`bun scripts/audit-gate.ts` reads `bun audit --json`, the machine-readable form of the audit. It filters the advisories to `high` and `critical` itself, because `bun audit --audit-level` does not filter the JSON. It fails the job (exit 1) on any high or critical advisory except the ones below. Each accepted advisory must match on GHSA id, package and version, and the lockfile must install that package at exactly that one version. Anything else fails: a new advisory, an upgrade or downgrade of an accepted package, or a second installed version of one. Each entry lives in `.github/audit-accepted-risk.json`. When an accepted advisory's `review_by` date is 30 days away or fewer, the gate still passes and prints a warning naming the advisory, the package and the date (on the `review_by` day itself too). The day after `review_by` the gate fails with `accepted risk <id> expired on <date>: re-review or upgrade`, until the entry is re-reviewed (a new `review_by`) or the package is upgraded.

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

It is opt-in on a second repository variable, because it starts containers. **It has not been run on the GitHub-hosted runner:** the hosted image has a Docker daemon, but the harness's preflight there is unverified. Keep `BOOT_GATE` unset until the rehearsal harness gains a native-process store backend (PostgreSQL 16 and `greptime` binaries are in the runner image; the outage step would pause the ledger process instead of its container). The constraints below describe the Docker harness as it stands:

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

**Status on 2026-10-09: off.** The first run on pull request 27 failed before any step started, with the annotation "The job was not started because recent account payments have failed or your spending limit needs to be increased". The organisation's Actions usage for the month is already large (other repositories), so enabling this is the operator's decision about spend, not a code change. After the account can run jobs: fix billing, run the workflow once by hand (`gh workflow run CI --ref main` after setting the variable, or open a pull request), confirm `verify` is green, and optionally require `CI / Typecheck, lint, tests and repo locks` in branch protection when the repository's plan supports it. The first run on a real runner may expose a setup detail this repository could not test (for example the Postgres service health check); fix it in a small pull request, or clear the variable while you do.

## Editing the workflow

- Pin every third-party action by full commit SHA with the version in a comment; resolve a tag with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` and dereference an annotated tag through `git/tags/<sha>`.
- Keep `permissions: contents: read` and `persist-credentials: false`. No secrets belong in this file; the database password is a scratch value for a container that lives for one job.
- Change a gate command in `scripts/verify.ts` and in the workflow together; the drift test names whichever one you forgot.
- The job and step names are stable on purpose: they are what a branch-protection rule would require.
- The Python suites in `packages/miner/tests` and `packages/dispatcher/tests` run in the `python` step of `verify` and in the `verify` job. Their dependencies come from `uv run --no-project` with exact pins; keep those pins in sync with the packages' declared `httpx>=0.27` and `pytest>=8.0`.
