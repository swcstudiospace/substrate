# S3 plan (trimmed from the task)

Target: infra/vps/{substrate.slice, substrate-mcp.service (MemorySwapMax only), substrate-mcp.service.d/20-watchdog.conf.example, substrate-alert@.service(+.d), journald-substrate.conf, deploy-release.sh --dry-run, README section}; packages/mcp-server/src/{watchdog.ts,watchdog.test.ts,server.ts /livez + exempt route,index.ts start/stop}; scripts/{doctor-runtime.ts,doctor-units.ts tests,doctor-vps.ts,substrate-alert.ts}+tests; docs/runbooks/{substrate-red,disk-pressure}.md.

Change:
1. substrate.slice CPUWeight=300, IOWeight=300, ManagedOOMPreference=avoid; mcp MemorySwapMax=0; doctor rows declared-vs-effective for CPUWeight, IOWeight, MemorySwapMax; honest IOWeight informational row.
2. Pure GET /livez {ok, uptime_s, loop_lag_ms}, loopback, unauthenticated, no store I/O. Opt-in watchdog SUBSTRATE_WATCHDOG=0|1 (no-op without NOTIFY_SOCKET): READY=1 once listening, WATCHDOG=1 every WatchdogSec/3 only when lag under threshold AND loopback /livez answers; notifier = spawned systemd-notify with hard timeout; timer unref'd, single-flight, cleared on shutdown. Example drop-in (Type=notify, WatchdogSec=30, TimeoutStartSec=60, NotifyAccess=all, OnFailure=substrate-alert@%n.service). substrate-alert@.service runs scripts/substrate-alert.ts: one warning (unit, result), doctor emit path, first token of a list, always exit 0.
3. Report-only disk guardrails: hardlink-aware release unique bytes (ONE du, current first), per-state-child bytes+age, journal, audit chain size + daily growth vs SUBSTRATE_RETAIN_RELEASE_MAX_GB / SUBSTRATE_STATE_MAX_GB / SUBSTRATE_JOURNAL_MAX_MB with would-reclaim lines; journald-substrate.conf SystemMaxUse=400M; deploy-release.sh --dry-run.

Acceptance: watchdog tick tests (lag, /livez fail, READY once, child timeout, timer cleared, flag off no-op); /livez touches no store; doctor rows (declared vs effective, du parsing incl. hardlink); alert posts one warning and exits 0 on post failure; --dry-run deletes nothing.
