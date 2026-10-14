# U5-1b — boot-and-prove release gate and report-only CI job

Slice branch `u5/s1b`. Edited only; nothing was run (no tests, tsc, docker, formatter).

## What changed

| File | Change |
| --- | --- |
| `scripts/rehearsal.ts` | New `pause --store ledger\|index` and `unpause --store ledger\|index`; `up --extra-env KEY=VALUE` (repeatable). Exports `PAUSE_STORES`, `parseStore`, `storeContainerName`, `selectStoreContainer`, `flagAll`. `up` now names its containers through `storeContainerName`, so `up` and `pause` cannot drift. `refuseExtraArgs` rejects `--store` outside pause/unpause and `--extra-env` outside `up`. No ledger key name is written in the file. |
| `packages/mcp-server/src/rehearsal-env.ts` | `EXTRA_ENV_ALLOWLIST` (value-validated), `EXTRA_ENV_KEYS`, `parseExtraEnv`; `BuildRehearsalEnvInput.extraEnv` is re-validated by the builder and applied last. |
| `scripts/release-gate.ts` (new) | The gate: `bun run gate:boot`. |
| `scripts/release-gate.test.ts` (new) | Gate tests with injected runner/HTTP/clock/filesystem. No docker. |
| `package.json` | One script line: `"gate:boot": "bun scripts/release-gate.ts"`. |
| `.github/workflows/ci.yml` | Third job `boot-gate`, last, report-only. Header comment updated from "both jobs" to "every job". |
| `scripts/verify.test.ts` | Pins updated in the same change (see Tests). |
| `docs/ci.md`, `docs/rehearsal.md`, `docs/runbooks/release-gate.md` (new) | Docs. The runbook ends with the "Not covered" list. |
| `packages/mcp-server/src/rehearsal-env.test.ts`, `scripts/rehearsal.test.ts` | New tests. |
| `.planning/uplift-5/env-notes/S1b.md` | Env notes: no `.env.example` lines; `BOOT_GATE` is a repository variable. |

## Flags and defaults

- `bun run gate:boot` is opt-in: nothing runs it by itself. It is a command, not a policy, so it has no off/shadow/report mode.
- `rehearsal up` without `--extra-env` builds the same environment as before (test: parent `SUBSTRATE_*` values never leak into the twin).
- CI `boot-gate`: needs repository variables `CI_ENABLED` and `BOOT_GATE` both `true`; `continue-on-error: true`; not run on the weekly schedule.
- `--extra-env` allowlist: `SUBSTRATE_METRICS_HISTORY` (on|off), `SUBSTRATE_BRIEF_PROFILE` (off|shadow|enforce), `SUBSTRATE_CACHE_SWR` (off|shadow|enforce), `SUBSTRATE_SLO_MIN_SAMPLES` (1–999). Refusal rules: `extra-env-format`, `extra-env-key`, `extra-env-value`, `extra-env-duplicate`; checked before the lock and before any docker call.
- `pause`/`unpause` refusal rules: `pause-store` (missing/unknown `--store`), `pause-target` (the container is not found by the instance label AND its exact name `substrate-rehearsal-<name>-ledger|-pg`, or two match, or the listing failed), `pause-state` (the paused flag could not be read back). Under the per-instance lock, local-daemon check first; idempotent; state read back from Docker.

## The gate

`bun scripts/release-gate.ts [--name <id>] [--surfaces a,b] [--window-ms N] [--keep] [--json]`. Exit 0 pass, 1 a check failed (a failed teardown included), 2 unavailable (harness refused to start, name taken, bad args, or interrupted before any check failed). Checks in order: `up`, `consumer`, `livez`, `healthz`, `slo`, `brief.claude-code`, `brief.grok-bot`, `brief.profile-typo`, `emit`, `brief.visibility`, `rehearsal.smoke`, `smoke.grok`, `outage.pause`, `outage.brief`, `outage.chaos`, `outage.unpause`, `recovery.healthz`, `recovery.emit`, `cleanup.down`, `cleanup.residue` (plus `cleanup.unpause`/`gate.internal` only when needed). One receipt row per check with timing, then one `gate-receipt ...` line.

Decisions worth knowing:

- `down` runs in `finally` on pass, failure, throw, SIGINT and SIGTERM; a frozen ledger is thawed first. It is not run when the harness *refused* to start, nor when the name already has a run directory (then the twin is someone else's, and the gate returns 2 before calling `up`). `--keep` skips `down` only.
- A failed `down` or leftover container/run directory (`cleanup.residue`, which lists containers by label after `down`) is exit 1, never 2.
- Children get an explicit minimal environment (`PATH`, `HOME`, `XDG_RUNTIME_DIR`, `TMPDIR`, `DOCKER_*`, `BUN_*`) plus the twin's `SUBSTRATE_URL`/token/tokens dir; the caller's `SUBSTRATE_*` and `CHAOS_*` never reach a proof, and `CHAOS_REHEARSAL` is never set. Bun runs with `--no-env-file`. Tokens are read from the twin's own token files into locals and never printed.
- The twin runs with `SUBSTRATE_BRIEF_PROFILE=shadow` and `SUBSTRATE_SLO_MIN_SAMPLES=3`. The floor is lowered because the chaos smoke requires `emit.success` to read `breached`, which needs observations a 20 s outage window may not reach at the production floor of 20. It is a twin setting only.
- The outage is `docker pause` of the twin's own ledger container, with `chaos-smoke` run for `--window-ms` (default 20 s).
- Recovery wait is 90 s (the ledger write probe re-runs at most every 60 s, plus the 5 s `/healthz` memo).

## Which assertion turns red for an injected regression

- Brief served 5xx while the ledger is paused: `outage.brief` (detail: `HTTP 500 while the ledger was frozen; the brief must fail open`), exit 1; the ledger is still thawed and the twin removed (test `a brief served 5xx while the ledger is paused ...`).
- Brief slower than 1500 ms during the outage: `outage.brief`.
- Emit fail-open or claim fail-closed regression: `outage.chaos` (carries the chaos smoke's own failed-check text).
- A hung proof: `outage.chaos` (timeout = window + 120 s, detail says "something hung").
- Compact brief served under `shadow`: `brief.grok-bot`. A typo'd profile served instead of 400: `brief.profile-typo`.
- Ledger never recovers: `recovery.healthz`; still refusing appends: `recovery.emit`.
- Container or run directory left behind: `cleanup.residue`.

## Tests added and what each proves

- `scripts/release-gate.test.ts`: arg parsing and every usage refusal; `childEnv` never forwards caller `SUBSTRATE_*`/`CHAOS_*`; each judge (livez, healthz, slo, brief, outage brief, emit, profile typo) against good and bad responses; healthy run passes all 20 checks in order with exactly the expected child sequence and nothing left in the fake world; `up` argv (ephemeral port, both surfaces, only allowlisted `--extra-env`); wire order and which surface calls what; the caller's production URL/tokens never reach any child; no bearer in the receipt, JSON or log; each injected regression turns the right check red (and only it); `unavailable` (refusal reasons verbatim, exit 2, no teardown, taken name never torn down); a killed `up` still tears down; teardown ordering (unpause before down, after chaos) on pass, failure, interruption (cleanup calls are non-interruptible) and `--keep`; failed teardown/residue/unlistable docker are exit 1; a failed check is not hidden by an interruption; receipt formatting.
- `scripts/rehearsal.test.ts` (fake `docker` on PATH, no daemon): `parseStore`, container-name mapping, `selectStoreContainer` refuses look-alikes, other instances, other roles, malformed ids, two matches, a failed listing; `flagAll`; per-subcommand flag acceptance; `--extra-env` refusals exit 2 before any docker call; `pause` sends the verb only to the named container of the named instance, reads state back, is idempotent on unpause, refuses a foreign container, refuses under a held lock before docker, and refuses on a dead daemon.
- `packages/mcp-server/src/rehearsal-env.test.ts`: each allowlisted pair accepted; each refusal rule; prototype keys refused; refusal never echoes a refused key's value; allowlist holds no store/token/path/host key; the builder applies the pair and the real `loadConfig` reads it; the builder re-validates for its own callers; no leakage without the flag.
- `scripts/verify.test.ts`: audit job slice now bounded by `boot-gate`; the job list is exactly `verify, dependency-audit, boot-gate`; `boot-gate` run lines are exactly `bun install --frozen-lockfile`, `bun run gate:boot`; `continue-on-error: true`; its `if` needs `CI_ENABLED` and `BOOT_GATE`; no `services:`; the two gating jobs have no `continue-on-error`; exactly 3 `if:` lines, each with `CI_ENABLED`.

## Smoke commands for the orchestrator

No docker needed (all must pass):

```sh
bun test scripts/release-gate.test.ts scripts/rehearsal.test.ts scripts/verify.test.ts packages/mcp-server/src/rehearsal-env.test.ts
bunx tsc --noEmit
bun run check:phase-close
```

Docker unavailable path (expect exit 2, `verdict=unavailable`, a reason such as `docker is unreachable` in the receipt):

```sh
DOCKER_HOST=unix:///nonexistent.sock bun run gate:boot -- --name gate-smoke; echo "exit=$?"
```

Real run (needs the two images present, 2 GiB free, `bun install` done; expect exit 0, 20 PASS rows, one `gate-receipt ... verdict=pass exit=0 ...` line, and an empty `docker ps -a --filter label=substrate.rehearsal`):

```sh
bun run gate:boot; echo "exit=$?"
docker ps -a --filter label=substrate.rehearsal
ls "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/"
```

Manual harness checks: `bun run rehearsal up --name x --port 0 --extra-env SUBSTRATE_BRIEF_PROFILE=shadow` then `bun run rehearsal pause --name x --store ledger`, `... unpause ...`, `... down --name x`; `... up --extra-env SUBSTRATE_PORT=7410` must exit 2 naming `extra-env-key` without touching Docker.

## Operator steps

- Optional: `gh variable set BOOT_GATE --body true --repo swcstudiospace/agent-substrate` (needs `CI_ENABLED` too). Nothing else; no unit, timer, Railway variable or env file changes.
- The images `postgres:16` and `greptime/greptimedb:v0.14.4` must be present locally on whichever host runs it (the harness never pulls).

## Deviations from the brief

1. The `boot-gate` job has **two** `run:` lines (`bun install --frozen-lockfile`, `bun run gate:boot`), not one: the harness refuses a checkout without `node_modules`, so a fresh runner workspace would otherwise always exit 2. `verify.test.ts` pins exactly these two lines.
2. The job's `if` is unwrapped like the other two (`vars.CI_ENABLED == 'true' && vars.BOOT_GATE == 'true' && github.event_name != 'schedule'`): it additionally skips the weekly schedule because it starts containers on the shared runner.
3. `--extra-env` also allows `SUBSTRATE_SLO_MIN_SAMPLES` (integer 1–999), not in the brief's example list; the gate needs it for the chaos smoke's `emit.success` check.
4. The index archive/restore drill from L3 is not implemented (explicitly out of scope per the brief); `pause`/`unpause --store index` exist but the gate only freezes the ledger.
5. Exit 2 for an interruption applies only when no check had failed; otherwise exit 1.
6. Lane L3 said the harness's `smoke` covers only brief/emit/register/claim; confirmed against the code. Lane L3's description of `grok-connector-smoke` bearer resolution is also confirmed: the gate passes the twin's tokens dir, and the `grok-bot` file is read before `SUBSTRATE_TOKEN`.

## Known limits and unknowns

- Nothing was executed. The gate has never run against real Docker: whether `docker pause` on the GreptimeDB container produces exactly the hang `chaos-smoke` expects, whether `emit.success` reaches `breached` inside 20 s with the floor at 3, and whether the outage brief stays under 1500 ms (the server's own brief budget is 1200 ms) are unobserved. If one of them is wrong on the first real run the failing check names itself; `--window-ms` is the first knob.
- Runtime (about 2–5 min) is an estimate. The recovery wait alone can take up to 90 s.
- Disk: the host was at 94% in the recon; the 2 GiB floor refusal will show as exit 2.
- `rehearsal-env.ts` lost my first edit once during the session (the file was found back at its original contents; a sibling or the orchestrator probably reset it) and was re-applied. Check that `packages/mcp-server/src/rehearsal-env.ts` shows in `git status` as modified before committing.
- The deploy hook (`SUBSTRATE_DEPLOY_GATE`) is U5-1a's; the runbook states only the contract it relies on (exit code and `gate-receipt` line).
