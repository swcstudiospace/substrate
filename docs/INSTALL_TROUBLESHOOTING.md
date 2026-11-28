# Install troubleshooting

Companion to `CLONE_SETUP.md`. Same prerequisites, setup, and verify steps;
this file adds symptom-level fixes. All examples are placeholders
(loopback or empty) — no credentials, tokens, or hostnames.

## Prerequisites

- Bun 1.4.0 (`package.json` `packageManager`; `engines.bun >=1.4.0`, CI pins
  1.4.0). Check with `bun --version`.
- System Python 3.12 for the miner and dispatcher suites.
- `uv` on `PATH` — `bun run verify` runs the Python suites through `uv run`
  with pinned `httpx` and `pytest`.
- Postgres 16, only for the live index tests. Without it those tests skip
  loudly; nothing else needs it.
- Git. TypeScript 5.9.3 and Biome 2.6.3 come from `devDependencies`.
- Full setup: `CLONE_SETUP.md`. Gate and CI: `ci.md`.
  Contributing rules: `../CONTRIBUTING.md`.

## Environment variables

Full list: `../.env.example` and `config-reference.md`. Never commit a
filled-in env file. The clone gate needs none of these except where noted;
set each only for the step that reads it.

| Variable | Needed for | Placeholder example |
| --- | --- | --- |
| `SUBSTRATE_PG_URL` | local index (`substrate-mcp` on `127.0.0.1:7410`) | `postgresql://localhost:5432/substrate` |
| `SUBSTRATE_TEST_PG_URL` | live index tests under `bun test` | `postgresql://localhost:5432/substrate_test` |
| `GREPTIME_URL` | ledger smoke (`bun run smoke:greptime`); empty skips it | `http://localhost:4000` or empty |
| `DRAGONFLY_URL` | hot cache; empty leaves the cache off | `redis://localhost:6379/0` or empty |

On a deployed host the server env lives at `/etc/substrate/substrate.env`
(root-owned, `chmod 0600`), copied from `../.env.example` and then filled in.
Local development does not need that file.

## Setup steps

```sh
git clone <repo-url> && cd agent-substrate
bun install --frozen-lockfile
# Optional: run the live index tests too.
export SUBSTRATE_TEST_PG_URL=postgresql://localhost:5432/substrate_test
```

Without `uv`, run the Python suites with system `python3` plus `httpx` and
`pytest`:

```sh
python3 -m pytest packages/miner/tests packages/dispatcher/tests
```

## Verify

From the repo root:

```sh
bun run verify
```

That is the gate CI runs: frozen install, `bunx tsc --noEmit`, blocking
Biome lint, the full `bun test` suite, the Python suites through `uv`, and
the repo locks (including `bun run check:phase-close`). Narrower checks:

```sh
bunx tsc --noEmit
bun test                                  # add SUBSTRATE_TEST_PG_URL for live index tests
bun run verify --only types,locks         # ids: install, types, lint, tests, python, locks, audit
bun run verify --list
```

## Failure table

| Symptom | Cause | Fix |
| --- | --- | --- |
| `bun install` wants to update the lockfile | Dependencies drifted from the frozen lockfile | Run `bun install --frozen-lockfile`. If it still fails, re-clone clean; running plain `bun install` rewrites the lockfile, so inspect that diff before keeping it. |
| `bun --version` is not 1.4.0 | Wrong toolchain | Install Bun 1.4.0. Newer versions satisfy `engines.bun` but differ from what CI pins. |
| `uv: command not found` during `bun run verify` | `uv` missing from `PATH` | Put `uv` on `PATH`, or run the Python suites directly with system `python3` plus `httpx` and `pytest`. |
| Python suites fail with missing `httpx` / `pytest` | System `python3` lacks deps and `uv` is absent | Install `httpx` and `pytest` for system `python3`, or restore `uv` so `bun run verify` provisions the pinned versions itself. |
| Live index tests report skipped | `SUBSTRATE_TEST_PG_URL` unset | Set it to a Postgres 16 database (placeholder in the table above). Skipping with it unset is by design. |
| Live index tests fail to connect | Postgres down or wrong connection string | Start Postgres 16, confirm the host/port/database in `SUBSTRATE_TEST_PG_URL`, and retry `bun test`. The scratch twin in `rehearsal.md` writes the variable for you. |
| `tsc` errors right after pulling | Stale `node_modules` | Run `bun install --frozen-lockfile` first, then `bunx tsc --noEmit`. A stale tree mimics a type break. |
| Biome lint blocks the gate | New or edited file breaks style | Run `bun run lint`, fix every diagnostic (no warnings are left to ignore), and re-run `bun run verify`. |
| `bun run check:phase-close` fails | Vocabulary, store-lock, or audit-policy drift | Fix the named drift; the redaction locks also run inside `bun test`. See `ci.md`. |
| `bun scripts/config-reference.ts --check` fails | Generated docs stale | Regenerate with `bun scripts/config-reference.ts` (or `bun run config:reference`) and commit the result. |
| `scripts/verify.test.ts` drift failure | Gate command changed in one place only | Change it in both the CI workflow and `../scripts/verify.ts` together. |
| `GET /healthz` on `127.0.0.1:7410` refuses | Server not running or index unconfigured | Start the server with `bun run mcp` and `SUBSTRATE_PG_URL` set. Not part of the clone gate. |
| `bun run smoke:greptime` fails | Ledger unreachable or misconfigured | Confirm `GREPTIME_*` in the environment; the smoke test prints no credential. Empty `GREPTIME_URL` means local development without a ledger. |
| Port `7410` already in use | Another server instance holds it | Stop the other instance; only one owner serves that loopback port (`bun run parity:check` asserts this in production). |

## Update

```sh
git pull --ff-only
bun install --frozen-lockfile
bun run verify --only types,locks
```

## Reset

```sh
git status --short                 # inspect first
rm -rf node_modules
bun install --frozen-lockfile
bun run verify --only types,locks
```

Discard only your own scratch files. Never force-push, never delete
branches, never commit a filled-in env file or machine-specific paths.

## Help

In order: `CLONE_SETUP.md` for the happy path, the `../README.md` Running
section, `../CONTRIBUTING.md` Commands section, `ci.md` for gate/CI
questions, `rehearsal.md` for the scratch twin
(`bun run rehearsal up|smoke|down`).
