# 07 — R7 VPS guardrails: plan

Proposal: `PROPOSAL.md` §R7. Baselines: `BASELINES.md` (audit 3.55 MB / 0.9 MB/day; mcp 53 MB RSS peak 88 MB; disk 95 % used, 22 GB free; every `substrate-*` unit `MemoryMax=infinity`).

## Files touched

- `infra/vps/substrate.slice` (new) — `MemoryLow=2G`; every `substrate-*` unit gets `Slice=substrate.slice`.
- `infra/vps/substrate-{mcp,collector-grok,collector-herdr,collector-muse,dispatcher,host,anchor,skills-sync,skills-bridge}.service` — `Slice=`, `MemoryHigh/MemoryMax/TasksMax/CPUQuota` per the proposal, with a comment citing today's RSS.
- `infra/vps/redis-substrate.conf` (new), `infra/vps/redis-server.service.d/10-substrate-limits.conf` (new).
- `infra/vps/deploy-release.sh` — free-disk floor before the build; store-aware health gate after the `/healthz` poll. `infra/vps/deploy-release.test.ts` — floor and gate cases (curl stub learns `-o`, new `df` stub).
- `infra/vps/README.md` — ceilings, slice, redis install lines, the two new knobs.
- `packages/audit/src/log.ts` — size-based rollover into closed segments, cross-segment scan/verify, `report()`; `log.test.ts` — rollover cases; `packages/audit/src/index.ts` — exports.
- `scripts/audit-verify.ts` (+ `audit-verify.test.ts`), `package.json` script `audit:verify`.
- `docs/mcp-audit.md` (rotation section), `docs/runbooks/disk-pressure.md` (new), `.planning/uplift-2/env-notes/07.md`, `07-SUMMARY.md`.
- Not touched: `scripts/doctor-units.ts` (it only loads `*.service` files and their `.d` dirs, so the slice and the redis drop-in are invisible to it), `.env.example`, `README.md`, anything under `packages/mcp-server` or `packages/cli`.

## Config knobs

| Name | Default | Read by |
|---|---|---|
| `SUBSTRATE_DEPLOY_MIN_FREE_GB` | 5 (0 disables) | `deploy-release.sh` |
| `SUBSTRATE_HEALTH_REQUIRE_STORES` | 1 | `deploy-release.sh` |
| `SUBSTRATE_HEALTH_ENV_FILE` | `/etc/substrate/substrate.env` | `deploy-release.sh` (presence of `GREPTIME_URL` / `SUBSTRATE_PG_URL` by name only) |
| `SUBSTRATE_AUDIT_ROLLOVER_BYTES` | unset (never roll) | `packages/audit/src/log.ts` |

## Tests (written, not run)

`deploy-release.test.ts`: floor refuses/accepts; gate pass; `index=false` / `eventsWritable=false` with the name configured fail and roll back; unconfigured names are not required; `planes` with an open breaker fails, closed passes, absent is ignored; `SUBSTRATE_HEALTH_REQUIRE_STORES=0` fetches no body. `log.test.ts`: boundary rollover → segment name + 0600, new active first record `prev` = closed tip, verify/stats across 2+ segments, corrupted closed segment reported, null option never rolls, restart after rollover continues the chain. `audit-verify.test.ts`: segment ordering, arg parsing, output shape.

## Rollback

Units: reinstall the previous unit files (no slice line) and `daemon-reload`; the slice file is inert without members. Deploy gate: `SUBSTRATE_HEALTH_REQUIRE_STORES=0`, `SUBSTRATE_DEPLOY_MIN_FREE_GB=0`. Audit: unset `SUBSTRATE_AUDIT_ROLLOVER_BYTES` (closed segments stay readable; the writer still walks them). Redis: remove the `include` line and the drop-in.

## Verification (orchestrator)

`bun test packages/audit infra/vps scripts/audit-verify.test.ts scripts/doctor-units.test.ts`, `bunx tsc --noEmit`, `bun run verify`, `systemd-analyze verify infra/vps/*.service infra/vps/substrate.slice` where available, `bun run audit:verify --path <tmp>`.
