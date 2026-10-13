# N1 — Runtime drift and jobs doctor (summary)

## What changed

- **`scripts/doctor-runtime.ts`** (new). `bun scripts/doctor-runtime.ts [--json] [--emit] [--infra dir]`. Seven check classes, one row each per check: `units` (every installed `substrate-*.service` vs the repo unit + drop-ins: `Slice`, `MemoryMax`, `TasksMax`, missing `Environment=` NAMES; staged-not-installed → `unknown`, release unit not installed or inactive → `drift`), `slice` (`substrate.slice` loaded/active/`MemoryLow`), `redis` (`config get maxmemory|maxmemory-policy|save|appendonly` vs `redis-substrate.conf`, `redis-server.service` `MemoryMax` vs the drop-in; unreachable → `unknown`), `timers` (anchor required → `drift` when not found; index-sweep and doctor opt-in → `unknown` with the hint saying so; enabled/active/last-fired-within-2-periods), `disk` (`df -Pk /opt/agent-substrate` vs `SUBSTRATE_DEPLOY_MIN_FREE_GB`, `warn` below 2× the floor), `swap` (paging rate from two `/proc/vmstat` reads 1 s apart; occupancy from `/proc/meminfo` in the hint only), `env` (`HINDSIGHT_BANK` by NAME via `grep -q '^NAME=.'`). All host access through one injectable `Host.run(argv)` (fixed argv, no shell). Exit 0 / 2 (drift) / 1 (usage).
- **Emit.** `--emit` posts one `warning` per drift class to `SUBSTRATE_URL/events` (surface `substrate`, `payload {action: "doctor", runtime: "doctor", class, checks: [{check, expected, actual}]}`, summary ≤ 200 chars) only when `SUBSTRATE_DOCTOR_EMIT=1`; otherwise prints a hint. Bearer: `SUBSTRATE_TOKEN` → `SUBSTRATE_TOKEN_SUBSTRATE` (shared env) → `resolveBearer("substrate")` token file / tokens dir; never printed. Dedupe: the last emitted check-id set per class is kept in `SUBSTRATE_DOCTOR_STATE` (default `/var/lib/substrate/doctor-last.json`); unchanged set → no POST, changed set → POST, cleared class → forgotten, failed POST → retried next run.
- **`scripts/doctor-runtime.test.ts`** (new): fixtures for every acceptance line and whole runs against a fixture host generated from the repo policy.
- **`infra/vps/substrate-doctor.service`**, **`substrate-doctor.service.d/10-environment.conf`**, **`substrate-doctor.timer`** (new): oneshot from `/opt/agent-substrate/current`, `Slice=substrate.slice`, `MemoryMax=256M`, `TasksMax=64`, `SuccessExitStatus=2`, `Environment=SUBSTRATE_DOCTOR_STATE=/var/lib/substrate/doctor-last.json`, `EnvironmentFile=/etc/substrate/substrate.env` via the drop-in (with the `SUBSTRATE_DOCTOR_EMIT=1` line commented out), `ExecStart … --emit`; timer `*-*-* 00/6:23:00 UTC`, `Persistent=true`. Not installed/enabled by default.
- **`scripts/doctor-units.ts`**: `logicalLines` exported. **`scripts/parity-check.ts`**: `systemdTimestampToEpoch` exported. **`scripts/doctor-units.test.ts`**: pinned unit list + shape assertions for the doctor unit.
- **`packages/mcp-server/src/event-sources.ts`**, **`docs/event-vocabulary.md`**: `doctor.drift` row (closed vocabulary unchanged: `warning` on `substrate`).
- **`packages/mcp-server/src/legacy-env.ts`** (new, no imports): `LEGACY_ENV_KEYS` (`HINDSIGHT_BANK` → `HINDSIGHT_BANKS` with the boot-warning sentence). **`config.ts`**: one import; `hindsightConfigWarnings` pushes that sentence from the table (same text as before). The doctor imports the table so no `HINDSIGHT_` token appears in a `.ts` outside `packages/mcp-server/src`.
- **`infra/vps/README.md`** "Runtime doctor" subsection (checks, install/enable/rollback operator steps). **`docs/runbooks/disk-pressure.md`**: paragraph on the doctor's `disk`/`swap` rows.
- **`.planning/uplift-3/env-notes/01.md`**: `.env.example` block (`SUBSTRATE_DOCTOR_EMIT`, `SUBSTRATE_DOCTOR_STATE`, `SUBSTRATE_DOCTOR_SWAP_PAGES_PER_S`) and the `doctor:runtime` script line.

## Flags and defaults

| Flag | Default | Effect |
| --- | --- | --- |
| `SUBSTRATE_DOCTOR_EMIT` | unset | `--emit` posts nothing and prints a hint; `1` enables the per-class warning |
| `SUBSTRATE_DOCTOR_STATE` | `/var/lib/substrate/doctor-last.json` | dedupe record |
| `SUBSTRATE_DOCTOR_SWAP_PAGES_PER_S` | `0` | paging rate above which `swap` is drift |
| `SUBSTRATE_DEPLOY_MIN_FREE_GB` | `5` (existing) | disk floor; `warn` band at 2× |
| `substrate-doctor.timer` | not installed | operator step in the README |

## How it is measured

`bun scripts/doctor-runtime.ts` on the VPS should report today's three drifts from CONTEXT.md (redis conf/unit, anchor timer not found, `HINDSIGHT_BANK` if set) and `unknown` for the uninstalled index-sweep and doctor timers; `--json` gives the rows for the progress log. With the timer installed and `SUBSTRATE_DOCTOR_EMIT=1`, `warning` events with `payload.runtime=doctor` appear on the ledger once per class until the drift set changes; `journalctl -u substrate-doctor` shows each run's table.

## Rollback

Read-only script; delete `scripts/doctor-runtime*`, `packages/mcp-server/src/legacy-env.ts` (inline the sentence back into `config.ts`) and the three `infra/vps/substrate-doctor*` files, drop the `doctor.drift` row from `event-sources.ts` + `docs/event-vocabulary.md`, and the `substrate-doctor.service` entry from `doctor-units.test.ts`. On the host: `systemctl disable --now substrate-doctor.timer`, remove the unit files, `daemon-reload`, `rm /var/lib/substrate/doctor-last.json`.

## Gates

pending orchestrator
