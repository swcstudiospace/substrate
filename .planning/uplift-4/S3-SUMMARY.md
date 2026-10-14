# S3 summary: VPS runtime hardening

## What changed
- **Priority and swap**: `infra/vps/substrate.slice` gains `CPUWeight=300`, `IOWeight=300`, `ManagedOOMPreference=avoid`; `substrate-mcp.service` gains `MemorySwapMax=0` (only change to that unit). Doctor rows: `substrate-mcp.service` now compares `MemorySwapMax` (declared vs `systemctl show`); `substrate.slice CPUWeight` / `IOWeight` compare declared vs effective (drift when different); a matching `IOWeight` becomes a `warn` row worded `NOT enforced` (or `enforcement unknown`) when the io controller / BFQ / io.cost evidence says the kernel will not honour it. Nothing claims it works.
- **Hang detection**: `GET /livez` in `server.ts` (loopback peers only via `isLocalPeer`, answered before the bearer check, reads only `LoopLagMonitor` and `process.uptime()`; added to `MONITOR_ROUTES`, `KNOWN_ROUTES`, `ANONYMOUS_ROUTES`, header comment). `watchdog.ts`: `LoopLagMonitor` (fixed ring, 250 ms samples, 10 s window), `Watchdog` (single-flight tick; READY=1 first, retried until delivered; WATCHDOG=1 only when lag <= threshold and loopback `/livez` ok and its reported lag <= threshold), `createSystemdNotifier` (spawns `systemd-notify`, hard timeout, kills a stuck child, abort-aware), `createLoopbackProbe` (bounded body, timeout). `index.ts` creates it, `start()` inside the listen callback, `stop()` awaited inside the shutdown race. Example drop-in `substrate-mcp.service.d/20-watchdog.conf.example` (not installed; `.example` is skipped by every `*.conf` reader). `substrate-alert@.service` (+ `.d/10-environment.conf`) runs `scripts/substrate-alert.ts %i`.
- **Disk guardrails (report-only)**: new `scripts/doctor-vps.ts` wired into `gatherRows`: release unique bytes (one `du`, current, previous, then newest first), state children with age and owner, journal, audit chain size and average daily growth; `would-reclaim` rows only when over budget; never `drift`, so exit codes are unchanged. `infra/vps/journald-substrate.conf` (`SystemMaxUse=400M`, not installed). `deploy-release.sh --dry-run`.
- Docs: README section, one paragraph each in `disk-pressure.md` and `substrate-red.md`.

## Files
New: `packages/mcp-server/src/watchdog.ts`, `watchdog.test.ts`; `scripts/doctor-vps.ts`, `doctor-vps.test.ts`, `substrate-alert.ts`, `substrate-alert.test.ts`; `infra/vps/substrate-alert@.service`, `substrate-alert@.service.d/10-environment.conf`, `substrate-mcp.service.d/20-watchdog.conf.example`, `journald-substrate.conf`.
Edited (small hunks): `infra/vps/substrate.slice`, `substrate-mcp.service`, `deploy-release.sh`, `deploy-release.test.ts`, `README.md`; `server.ts`, `index.ts`, `admission.ts` (one monitor route), `observe.ts` (one known route); `scripts/doctor-runtime.ts` (declared `memorySwapMax`/`sliceWeights`, props, `DoctorOptions.disk`, `postEvent` exported with `body: object`), `doctor-runtime.test.ts`, `doctor-units.test.ts`; two runbooks.

## Flags and defaults
See `env-notes/S3.md`. `SUBSTRATE_WATCHDOG` default 0: no timer, child or request. Budgets default 6 GB / 1 GB / 400 MB (0 disables a compare).

## Failure behaviour
`/livez` cannot fail on a store. Notifier spawn failure / non-zero / timeout is a withheld ping (systemd then restarts the unit after WatchdogSec). READY=1 failure is retried each tick. A failing log sink or lag source never throws (a throwing lag source fails closed). The alert always exits 0 and POSTs once (never retried); its `/livez` wait is bounded. Disk commands missing or failing give `unknown` rows.

## Rollback
Remove the drop-ins / reinstall prior unit files and `daemon-reload`; unset the flag. Nothing code-side deletes data.

## Verify (orchestrator)
```sh
bunx tsc --noEmit
bun test packages/mcp-server/src/watchdog.test.ts packages/mcp-server/src/admission.test.ts packages/mcp-server/src/http.admission.test.ts packages/mcp-server/src/http.test.ts
bun test scripts/doctor-vps.test.ts scripts/doctor-runtime.test.ts scripts/doctor-units.test.ts scripts/substrate-alert.test.ts infra/vps/deploy-release.test.ts
bun scripts/doctor-units.ts --dry-run     # needs the new files committed: missing-entry reads git HEAD
bun scripts/doctor-runtime.ts --infra infra/vps
```

## Residual risks
- Nothing was run. The `/livez` socket test uses a Proxy store; if `new Substrate` touches a store at construction the harness may need a plain stub.
- `systemd-notify` as a non-main child needs `NotifyAccess=all` (in the example); behaviour on the host's systemd 255 is `[INFERENCE]`, unverified live.
- `ExecStopPost=` alert path: the alert reads `Result` with `systemctl show` (no `MONITOR_*` variables outside OnFailure=); a deploy restart reads `success` and posts nothing. Unverified live.
- `IOWeight` evidence reads `/sys/fs/cgroup/substrate.slice/io.weight` and `lsblk`; hosts without them report `unknown`/`warn`, never `ok`.
- `du` over many releases is bounded to 64 paths; a state directory with more children is truncated.
- `substrate-alert@.service` appears in `doctor-units`/`doctor-runtime` unit lists as a non-release unit: `unknown` until installed.
- The doctor's new rows are dark until `substrate-doctor.timer` is installed (operator step).

## Review round 1 fixes (head 4a703d0)
- Alert wait capped at 60 s (`MAX_WAIT_S`); `substrate-alert@.service` `TimeoutStartSec=120`; a test pins the unit's timeout above show + wait + probe + poll + POST.
- `deploy-release.sh --dry-run` prints both prune cases (redeploy of the current tag; next new-tag deploy, which also removes the present previous) with unique bytes; usage, header, disk-pressure.md, doctor hint and the test updated.
- Doctor: du cap cuts (releases keep the newest; state children ranked newest first) and unreadable entries are reported as `N more not measured`, status `unknown` (or `warn` when the measured part already exceeds the budget), never `ok`.
- Alert takes the result from the caller (`<unit>:<result>` instance suffix or a second argument) before the environment and `systemctl show`; the example drop-in's `ExecStopPost=` passes `${SERVICE_RESULT}`; only exactly `success` skips. The drop-in states that `OnFailure=` alone never fires for a restarted hang.
- Docs: `/livez` added to the unaudited/unmetered route sentences (server.ts, mcp-audit.md); substrate-red.md no-drop-in sentence fixed; README and the drop-in header state the precondition (a release with watchdog.ts must be current first).
- Unverified: systemd accepting `substrate-alert@substrate-mcp.service:watchdog.service` as an instance name, and `${SERVICE_RESULT}` expansion inside a word in ExecStopPost (both per systemd.service(5) as I read it, not run).
