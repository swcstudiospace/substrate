# Uplift 5 — baselines (captured 2026-10-14, read-only)

Live release: `9231f4396be5e38ef00db1313c6fae79ea2aace1` (uplift 2 plus its deploy follow-up). Uplifts 3 and 4 are merged on `main` (`40890e4`) but NOT deployed. Everything below is a read of `/slo`, `/healthz`, `systemctl`, `systemd-analyze security`, `df`, `docker system df`, `journalctl`; nothing was changed.

## substrate-mcp (live)

| signal | observed | target / note |
|---|---|---|
| `brief.p95` | 758.4 ms | objective 800 ms |
| `emit.success` | 1.0 | objective 0.995 |
| cache | 21 hits / 110 misses (16 % hit ratio) | no stale-while-revalidate live (uplift 4 is not deployed) |
| `/healthz` | one `index ping timed out after 1000 ms` seen | budget 1000 ms |
| process | active, RSS about 52 MB, `MemoryMax` 2 G | |

## systemd exposure (`systemd-analyze security <unit> --no-pager`)

| unit | overall exposure |
|---|---|
| `substrate-mcp` | 8.1 EXPOSED |
| `substrate-dispatcher` | 8.1 EXPOSED |
| `substrate-collector-grok` | 8.1 EXPOSED |

Failing checks common to all three: `User=root`, no `CapabilityBoundingSet`, `ProtectKernelModules`/`Logs`, `ProtectClock`, `ProtectHostname`, `RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality`, `PrivateDevices`, `SystemCallArchitectures`, `ProtectSystem=strict`, `ProtectHome`. `MemoryDenyWriteExecute` stays off (bun's JIT needs W+X). systemd 255 supports `systemd-analyze security --offline`, `--threshold` and `--json`.

## Host

| signal | value |
|---|---|
| `/` | 94 % used, about 26 GB free |
| Docker reclaimable | about 22 GB (not substrate's) |
| journal | 329.6 MB |
| images present locally | `postgres:16`, `greptime/greptimedb:v0.14.4`, `timescale/timescaledb:2.17.2-pg16` (the rehearsal harness runs `--pull never`) |

## Repository gates at `40890e4` (clean worktree)

| gate | result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bun test` (scratch Postgres) | 4450 pass / 1 skip / 0 fail, 169 files |
| `bun run check:phase-close` | pass: 4 lock files green, `EVENT_KINDS` 12, `SURFACES` 27 |
| `bun run test:py` | 298 (cycle 1 record) |

Note: in the shared checkout one extra test fails (`CLI refusals > --port 7410 exits 2 without touching Docker`, F-01) because production listens on 7410 there; it passes in isolated worktrees.

## Code-derived counts used in the proposal

| fact | source |
|---|---|
| env names read by code about 223, documented in `.env.example` about 179 | recon lane L2 scan |
| one accepted write bumps the MEMORY generation twice | `service.ts:1786,1806` (and outbox replay `:2319`) |
| `getGraph` is 4 serial statements; the brief uses only status/surface/pr_url/nodes | `index-store.ts:602-616`, `brief.ts` |
| collectors drop events on outage | `packages/collectors/src/emit.ts:10-12` |
| `agent_events` is append-only with PK (surface, repo, graph_id, kind), no ALTER allowed | `greptime.ts:411-415,845-866` |
| `skills_list`/`skills_approve` do not exist; proposal state is a host-local JSONL | `skills/propose.ts:41`, `docs/skills-propose.md` |
