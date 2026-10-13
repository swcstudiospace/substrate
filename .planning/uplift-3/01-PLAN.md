# N1 — Runtime drift and jobs doctor (plan)

**What.** A read-only doctor that compares the HOST (systemd, redis, df, /proc, the shared env by key NAME) with the DECLARED policy in `infra/vps/`, prints one row per check (`ok|warn|drift|unknown`, expected, actual, hint), exits 2 on drift, and — on an opt-in 6 h timer — posts one deduplicated `warning` event per drift class to the ledger so the brief surfaces it.

**Where.**
- `scripts/doctor-runtime.ts` — pure compare functions per class (`compareUnit`, `compareSlice`, `compareRedis`, `compareTimer`, `compareDisk`, `compareSwap`, `compareLegacyKey`), one `gatherRows` that is the only host-touching function through an injectable `Host { run(argv), readText, sleep, now }`, `emitDrift` with injectable `EmitIo`, thin `main()` behind `import.meta.main`. Reuses `logicalLines`/`isSubstrateUnit`/`SHARED_ENV_FILE` from `doctor-units.ts` (one `export` added), `parseSystemctlShow`/`systemdTimestampToEpoch` from `parity-check.ts` (one `export` added), `resolveBearer` from `packages/cli/src/token.ts`.
- `scripts/doctor-runtime.test.ts` — fixtures per acceptance line plus whole runs against a fixture host built from the repo policy.
- `infra/vps/substrate-doctor.service`, `substrate-doctor.service.d/10-environment.conf`, `substrate-doctor.timer` — oneshot from `/opt/agent-substrate/current`, `Slice=substrate.slice`, `MemoryMax=256M`, `TasksMax=64`, `SuccessExitStatus=2`, env via the anchor-style drop-in, `--emit` on the ExecStart; `OnCalendar=*-*-* 00/6:23:00 UTC`, `Persistent=true`; disabled by default (README operator step).
- `packages/mcp-server/src/event-sources.ts` + `docs/event-vocabulary.md` — `doctor.drift` row (surface `substrate`, kind `warning`, action/runtime `doctor`, periodic) so the new producer is in the closed vocabulary table the test pins.
- `packages/mcp-server/src/legacy-env.ts` (new, side-effect-free) — the `HINDSIGHT_BANK → HINDSIGHT_BANKS` table with the boot-warning sentence; `config.ts` `hindsightConfigWarnings` reads the sentence from it, and the doctor imports the table because `HINDSIGHT_` may be spelled only under `packages/mcp-server/src` (store-lock.test.ts).
- `scripts/doctor-units.test.ts` — pinned unit list gains `substrate-doctor.service`.
- `infra/vps/README.md` "Runtime doctor" subsection; `docs/runbooks/disk-pressure.md` one paragraph.

**Flags (defaults preserve today).** `SUBSTRATE_DOCTOR_EMIT` (unset → `--emit` prints a hint, posts nothing); `SUBSTRATE_DOCTOR_STATE` (default `/var/lib/substrate/doctor-last.json`); `SUBSTRATE_DOCTOR_SWAP_PAGES_PER_S` (default 0); `SUBSTRATE_DEPLOY_MIN_FREE_GB` (existing, default 5). Timer not installed by default.

**Locks respected.** No new kind/surface (`warning` on `substrate`); no Greptime/Hindsight token outside `packages/mcp-server/src`; no new REST/MCP write (POSTs the existing `/events`, so no `policy.ts` entry); no hostnames or secret values; env vars by name only; `grep -q '^NAME=.'` presence pattern from `deploy-release.sh`.

**Tests (what each proves).**
- units: `MemoryMax=infinity` vs `2G` → drift naming the unit; missing `Environment` name → drift listing the NAME only and no path value in any row; release unit not-found/inactive → drift; staged unit not-found → unknown.
- redis: today's host (`0`/`noeviction`/`save 3600 1 …`) vs the repo conf → exactly three drift rows; unreachable → four unknown rows, exit 0; `config get` parsing incl. empty `save`.
- timers: anchor not-found → drift; sweep not-found → unknown with "opt-in"; disabled/inactive/stale → drift; never-fired → ok.
- disk: 27/4/9 GB vs floor 5 → ok/drift/warn, warn exits 0, floor 0 disables.
- swap: 12 GiB occupied, zero paging → ok with occupancy in hint; paging → drift.
- env: present → drift with the `HINDSIGHT_BANKS` hint; absent → ok; unreadable → unknown.
- emit: one POST per drift class; same set twice → one POST; `actual` moving alone → no re-emit; grown set → one POST for that class; cleared then returned → emitted again; `--emit` without `SUBSTRATE_DOCTOR_EMIT=1` → no POST and a hint; no bearer → no POST; failed POST → retried next run; body never contains the env-file sentinel or the bearer.
- whole run: a host exactly as declared is all-ok exit 0 and every command is a fixed argv; today's VPS fixture → drift in `redis, timers, env`, exit 2; `main` table/`--json`/usage exit codes.
