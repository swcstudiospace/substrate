# Clone setup notes

## Worktree path placeholder

`.planning/phases/80–86` planning and verification files use `<repo-root>`
wherever the originating ephemeral checkout path appeared (formerly the
literal wave8 worktree path). When following a `cd <repo-root>` step or a
`**Worktree:** \`<repo-root>\`` line, substitute your own checkout root
(e.g. `cd "$(git rev-parse --show-toplevel)"`). Do not commit
machine-specific `/tmp/...` paths back into planning docs.

## Secrets and credentials

- The substrate env lives at `/etc/substrate/substrate.env`, never in-repo.
  `.env`, `.env.*` (except `.env.example`), private keys (`*.pem`, `*.key`,
  `*.p12`, `*.pfx`, `*.jks`, `*.asc`, `*.gpg`, `id_rsa*`, `id_ed25519*`),
  credential bundles (`*credentials*.json`, `secrets.json/yaml/yml`),
  and `.vault-token` are git-ignored. Keep `.env.example` placeholder-only.
- Hygiene audit (2026-11-28, `.planning/HYGIENE_AUDIT.md`): no secrets,
  tailnet names, private keys, or large binaries in the wave diff.

## Infra note (do not change deploy behavior)

- `infra/nginx/substrate.swcstudio.space.conf:25` binds `187.77.130.10:443`.
  Pre-existing (last touched before this wave, outside the wave diff), kept
  as-is. Parameterize via env/`map` include in a follow-up if desired; this
  pass makes no nginx change.

## Prerequisites

- Bun 1.4.0 (pinned in `package.json` `packageManager`; `engines.bun` is
  `>=1.4.0`, CI pins 1.4.0). Check with `bun --version`.
- System Python 3.12 for the miner and dispatcher suites.
- `uv` on `PATH` — `bun run verify` runs the Python suites through `uv run`
  with pinned `httpx` and `pytest`.
- Postgres 16, only for the live index tests (leases, memory, search, graph
  bindings). Without it those tests skip loudly; nothing else needs it.
- Git. TypeScript 5.9.3 and Biome 2.6.3 come from `devDependencies` — no
  separate install.
- Details: `../CONTRIBUTING.md` (setup), `ci.md` (gate and CI jobs).

## Environment variables

The full list lives in `../.env.example` and `config-reference.md`. Never
commit a filled-in env file. For a fresh clone you usually need none; set
these only for the step that reads them. Examples below are placeholders
(loopback or empty), not credentials.

| Variable | Needed for | Placeholder example |
| --- | --- | --- |
| `SUBSTRATE_PG_URL` | local index (`substrate-mcp` on `127.0.0.1:7410`) | `postgresql://localhost:5432/substrate` |
| `SUBSTRATE_TEST_PG_URL` | live index tests under `bun test` | `postgresql://localhost:5432/substrate_test` |
| `GREPTIME_URL` | ledger smoke (`bun run smoke:greptime`); empty skips it | `http://localhost:4000` or empty |
| `DRAGONFLY_URL` | hot cache; empty leaves the cache off | `redis://localhost:6379/0` or empty |

On a deployed host the server env lives at `/etc/substrate/substrate.env`
(root-owned, `chmod 0600`), copied from `.env.example` and then filled in.
Local development does not need that file.

## Setup steps

```sh
git clone <repo-url> && cd agent-substrate
bun install --frozen-lockfile
# Optional: run the live index tests too.
export SUBSTRATE_TEST_PG_URL=postgresql://localhost:5432/substrate_test
```

Without `uv`, the Python suites fall back to system `python3` with `httpx`
and `pytest` installed:
`python3 -m pytest packages/miner/tests packages/dispatcher/tests`.

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

A drift test (`../scripts/verify.test.ts`) fails when the CI workflow and
`../scripts/verify.ts` disagree — change a gate command in both together.
Symptom-level fixes live in `INSTALL_TROUBLESHOOTING.md`.

## Common failures

| Symptom | Fix |
| --- | --- |
| `bun install` wants to update the lockfile | Run `bun install --frozen-lockfile`; if it still fails, re-clone clean or run `bun install` once and inspect the diff — the frozen file is the source of truth. |
| `bun --version` is not 1.4.0 | Install Bun 1.4.0; `engines.bun >=1.4.0` tolerates newer, CI does not. |
| `uv: command not found` during `bun run verify` | Put `uv` on `PATH`, or run the Python suites directly with system `python3` plus `httpx` and `pytest`. |
| Live index tests report skipped | Set `SUBSTRATE_TEST_PG_URL` to a Postgres 16 database (e.g. the placeholder in the table above); unset means skip-by-design. |
| `tsc` errors after pulling | Run `bun install --frozen-lockfile` first — a stale `node_modules` mimics a type break. |
| `GET /healthz` on `127.0.0.1:7410` refuses | Start the server (`bun run mcp`) with `SUBSTRATE_PG_URL` set; the port is server-owned, not part of the clone gate. |

## Update, reset, and help

- Update: `git pull --ff-only` then `bun install --frozen-lockfile`, then
  `bun run verify --only types,locks` as a quick re-check.
- Reset a dirty clone: `git status --short` to inspect, discard only your own
  scratch files, then `rm -rf node_modules && bun install
  --frozen-lockfile` for a clean dependency tree. Never force-push or delete
  branches.
- Help, in order: the `../README.md` Running section, `../CONTRIBUTING.md`
  Commands section, `ci.md` for gate/CI questions,
  `INSTALL_TROUBLESHOOTING.md` for symptom fixes, `rehearsal.md`
  for the scratch twin (`bun run rehearsal up|smoke|down`).
