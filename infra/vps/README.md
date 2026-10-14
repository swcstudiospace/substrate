# Pinned substrate releases

Production substrate units run from an immutable tree at a recorded commit. The mutable checkout `/root/src/repos/agent-substrate` is not a `WorkingDirectory`. This extends v1.3 Phase 16 (production parity). It does not add Phase 16's rehearsal harness, and it does not copy collector or skills code onto `main`.

Ming approves every operator step below separately, one at a time, and a read-only doctor run follows each one. Nothing in this directory restarts a host, and an agent does not run the steps.

## Layout

`deploy-release.sh <tag>` archives a **git tag whose commit is on `main`** into:

```text
/opt/agent-substrate/releases/<sha>/
/opt/agent-substrate/current   -> releases/<sha>
/opt/agent-substrate/previous  -> releases/<previous sha>
```

The sha is the tag peeled to a commit. `bun install --frozen-lockfile` runs in that directory. `current` is replaced with `mv -T` on a new symlink, so readers see either the old target or the new one. A failed health check points `current` back at the previous target and restarts the units. After a successful health-checked deploy only the new release and one previous directory remain. A deploy with `SUBSTRATE_RELEASE_RESTART=0` does not delete release directories.

Override the root with `SUBSTRATE_RELEASE_ROOT` (tests do; production uses the default). `SUBSTRATE_REPO` is the local git directory the tag is read from. `git archive` exports the commit, not a dirty worktree. `SUBSTRATE_RELEASE_RESTART=0` builds the tree, checks that each unit's entry file is in it, swaps `current`, and does not restart, health-check, or prune. A later deploy with restart enabled prunes down to `current` and one previous only after the units are active and the health check passes.

Before the swap, the script reads `ExecStart` from the unit files beside it and refuses to publish a release that is missing one of those entry files. After `systemctl daemon-reload` and restart it waits `SUBSTRATE_UNIT_SETTLE` seconds (default 2), then requires each unit to still be active, in `SubState=running`, with the same `NRestarts` it had when restart returned. A collector that exits and is started again in that window is a restart loop, and the release is rolled back. `/healthz` only describes the MCP process.

`SUBSTRATE_HEALTH_CMD`, when set, is an absolute executable path with no shell, and a non-zero exit fails the deploy immediately. Otherwise the check polls `SUBSTRATE_HEALTH_URL` (default `http://127.0.0.1:7410/healthz`) until it returns a 2xx or `SUBSTRATE_HEALTH_DEADLINE` seconds pass (default 30). Connection refused is retried. Any other HTTP response fails immediately. A URL with credentials in it is refused. When the server requires a bearer, set `SUBSTRATE_HEALTH_TOKEN_FILE` to an absolute root-only file that contains only that token, or set `SUBSTRATE_HEALTH_CMD`. The script passes the token to curl through a mode-0600 config file and does not print it. A 401 with neither set fails the deploy.

Two more gates, both on by default (uplift-2 R7). **Free disk:** before the tree is built the script reads `df -Pk` on the release root and refuses when fewer than `SUBSTRATE_DEPLOY_MIN_FREE_GB` gigabytes (default 5) are free, naming `docs/runbooks/disk-pressure.md`; `0` disables it for an emergency the operator has judged. **Stores:** `/healthz` answers 200 while the index is down and, with no ledger configured, while nothing is writable, so with `SUBSTRATE_HEALTH_REQUIRE_STORES=1` the script keeps the body of the answer that passed the poll and requires `index` to be `true` when `SUBSTRATE_PG_URL` is set in `SUBSTRATE_HEALTH_ENV_FILE` (default `/etc/substrate/substrate.env`), `eventsWritable` to be `true` when `GREPTIME_URL` is, and — when the body carries a `planes` object — no plane whose `breaker.state` is `open`. The env file is read by name only (`grep -q '^NAME=.'`); no value is read into a variable or printed. A failed store gate rolls back exactly like a failed health check. `SUBSTRATE_HEALTH_REQUIRE_STORES=0` keeps the status-only check, and a custom `SUBSTRATE_HEALTH_CMD` is the whole verdict (no body is read). `rollback` is not store-gated: when the stores are down, rolling back must still be possible.

`deploy-release.sh rollback` swaps `current` back to `previous` and health-checks again.

The script restarts `substrate-mcp.service`, `substrate-collector-grok.service`, `substrate-collector-herdr.service` and `substrate-collector-muse.service`: every unit whose `WorkingDirectory` is the release, so no collector keeps running the old tree after a swap. Set `SUBSTRATE_RELEASE_UNITS` to override the list. The dispatcher and the skills timers are not restarted from here.

## Units

Every service in this directory uses `WorkingDirectory=/opt/agent-substrate/current`. The MCP, herdr and muse units also set `ConditionPathExists` on their entry file under that symlink, so a missing entry skips the start instead of crash-looping. The Grok unit has no such guard. Install the matching drop-in with each unit:

| Unit | Drop-in | EnvironmentFile |
| --- | --- | --- |
| `substrate-mcp.service` | `substrate-mcp.service.d/10-environment.conf` | `/etc/substrate/substrate.env` |
| `substrate-collector-grok.service` | `substrate-collector-grok.service.d/10-environment.conf` | `/etc/substrate/collector-grok.env` |
| `substrate-collector-herdr.service` | `substrate-collector-herdr.service.d/10-environment.conf` | `/etc/substrate/substrate-collector-herdr.env` |
| `substrate-collector-muse.service` | `substrate-collector-muse.service.d/10-environment.conf` | `/etc/substrate/substrate-collector-muse.env` |
| `substrate-anchor.service` (+ `substrate-anchor.timer`) | `substrate-anchor.service.d/10-environment.conf` | `/etc/substrate/substrate.env` |
| `substrate-index-sweep.service` (+ `substrate-index-sweep.timer`, staged: install and enable are operator steps after the dry-run report has been read for a few days) | `substrate-index-sweep.service.d/10-environment.conf` (also carries `Environment=SUBSTRATE_INDEX_SWEEP=dry-run`) | `/etc/substrate/substrate.env` |
| `substrate-ledger-archive.service` (+ `substrate-ledger-archive.timer`, staged: install and enable are operator steps after the off-box archive path is mounted; see *Daily ledger archive*) | `substrate-ledger-archive.service.d/10-environment.conf` (carries `SUBSTRATE_LEDGER_ARCHIVE_DIR` once the operator sets it) | `/etc/substrate/substrate.env` |

The MCP server is the process that needs the shared env file. The Grok collector must not load it. Create `collector-grok.env` (root-owned, mode 0600) with only the names this process reads: `SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, and optionally `GROK_SESSIONS_DIR`. `SUBSTRATE_COLLECTOR_STATE` is already set on the unit. Do not put database URLs, plane keys, handoff keys, or review tokens in that file. No values belong in git.

The same rule holds for the other two collectors. `substrate-collector-herdr.env` holds `SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, and optionally `HERDR_SOCKET_PATH` or `HERDR_SESSION` (the socket defaults to `/root/.config/herdr/herdr.sock`). `substrate-collector-muse.env` holds `SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, and `SUBSTRATE_MUSE_REPOS`. `SUBSTRATE_COLLECTOR_STATE` and `SUBSTRATE_STATE_DIR` are set on the units.

The herdr and muse file names carry the `substrate-` prefix and the Grok one does not. Those are the paths `infra/identity/clients.json` delivers each token to (and the Muse hook's default `tokenFile`), so `bun run identity:check` reads the same file the unit loads. `scripts/doctor-units.test.ts` pins the two together.

### Resource ceilings and the slice

Every `substrate-*` unit carries `Slice=substrate.slice` and its own memory and task ceilings, in the unit file itself (uplift-2 R7). Install `substrate.slice` alongside the units — `cp infra/vps/substrate.slice /etc/systemd/system/substrate.slice`, then `systemctl daemon-reload` — before restarting any unit that names it; a unit whose slice is not installed is still started by systemd (the slice is created implicitly, with no `MemoryLow`), so the order is a matter of getting the protection, not of avoiding a failure. The slice's `MemoryLow=2G` makes reclaim hit the host's co-tenants before any substrate unit. Measured 2026-10-13: substrate-mcp 53 MB RSS, 88 MB peak, 0 restarts, on a host with 12 of 15 GiB swap in use and every `substrate-*` unit at `MemoryMax=infinity`.

| Unit | `MemoryHigh` | `MemoryMax` | `TasksMax` | `CPUQuota` |
| --- | --- | --- | --- | --- |
| `substrate-mcp.service` | 1G | 2G | 512 | 200% |
| `substrate-collector-{grok,herdr,muse}.service` | — | 512M | 256 | — |
| `substrate-dispatcher.service`, `substrate-host.service` | — | 4G | 1024 | — |
| `substrate-anchor.service`, `substrate-index-sweep.service`, `substrate-skills-{sync,bridge}.service` (oneshots) | — | 1G | — | — |
| `substrate-ledger-archive.service` (oneshot) | — | 512M | — | — |

`MemoryHigh` throttles; `MemoryMax` is where the kernel ends the process and `Restart=always` (or the timer's next tick, for a oneshot) brings it back. The dispatcher's and host's cgroups hold the sessions and VM lifecycle they launch, which is why theirs are the large ones. Read the live numbers with `systemctl status substrate.slice` and `systemd-cgtop -1 -k /substrate.slice`. Rollback: reinstall the previous unit files (no `Slice=` line) and `daemon-reload`; the slice file is inert without members.

### Loopback redis

`substrate-mcp` caches in a redis on `127.0.0.1` (`DRAGONFLY_URL`; `docs/data-planes.md`, cache row). The cache tolerates loss by design, so it needs no persistence and must not snapshot to a disk measured at 95 %. `infra/vps/redis-substrate.conf` sets `maxmemory 256mb`, `maxmemory-policy volatile-lru`, `save ""`, `appendonly no` and a loopback-only `bind`; `infra/vps/redis-server.service.d/10-substrate-limits.conf` caps the process at `MemoryMax=768M`. The policy is `volatile-lru` and not `allkeys-lru` on purpose: cached answers and snapshots carry TTLs, the generation counters (`substrate:v1:gen:*`) do not, and a reader treats a missing counter as generation 0 — so an evicted counter would make a generation-0 answer still inside its TTL readable again after a write had invalidated it. Evicting only TTL-bearing keys keeps every bump visible until its entries expire; the file's header spells it out. Operator step, its own window, not automated:

```sh
install -m 0640 -o redis -g redis infra/vps/redis-substrate.conf /etc/redis/redis-substrate.conf
grep -q '^include /etc/redis/redis-substrate.conf' /etc/redis/redis.conf || \
  printf '\ninclude /etc/redis/redis-substrate.conf\n' >> /etc/redis/redis.conf
install -d -m 0755 /etc/systemd/system/redis-server.service.d
cp infra/vps/redis-server.service.d/10-substrate-limits.conf /etc/systemd/system/redis-server.service.d/10-substrate-limits.conf
systemctl daemon-reload && systemctl restart redis-server
redis-cli -h 127.0.0.1 config get maxmemory-policy   # volatile-lru
```

The `include` goes last so it wins over the distro defaults above it. The restart empties the cache; the next brief is served uncached and refills it. Rollback: remove the `include` line and the drop-in, `daemon-reload`, restart.

### Hourly anchor job

`substrate-anchor.timer` fires `substrate-anchor.service` hourly (`OnCalendar=hourly`, `Persistent=true`). The service is `Type=oneshot` with no `Restart=`: a failing run already shows failed, and the next tick retries. It runs `bun packages/mcp-server/src/anchor-run.ts` from the pinned release, so a deploy needs no change — a oneshot reads `current` on every tick — and `deploy-release.sh` does not restart this oneshot.

Trigger it only through `systemctl start substrate-anchor.service`: systemd never runs a second instance of an active oneshot, and the job re-checks the chain for the period immediately before every send, so two triggers cannot double-anchor an hour. Timing: the 5-minute ingest lag lives in the job, so an hour anchors at the second tick after it ends — pending for about 2 h, inside verify's 3 h window.

The production key is used by the production unit only. A memo for some hour signed by that key from any other ledger would make production alarm on that hour, so the rehearsal harness never carries `SOLANA_*` names — check `env`, not values, if a scratch run looks anchored. The doctor covers the anchor unit like the server: `bun scripts/doctor-units.ts --dry-run` must stay green.

### Daily ledger archive

`substrate-ledger-archive.timer` fires `substrate-ledger-archive.service` daily at 03:30 UTC (`Persistent=true`), after the 03:17 sweep and three hours after the day's last anchor tick. The service is `Type=oneshot` with no `Restart=` and runs `bun packages/cli/src/index.ts ledger archive --out ${SUBSTRATE_LEDGER_ARCHIVE_DIR}` from the pinned release: every closed UTC day up to yesterday that has no `manifest-<day>.json` in the directory yet is exported as `events-<day>.ndjson`, `ingest-<day>.ndjson`, `anchors-<day>.ndjson` and the manifest (counts, first/last `(ts, id)`, chain tip, per-hour RFC 6962 roots, SHA-256 of each file), written as `*.part` and renamed, and recorded in the ledger as one `note` per day. `docs/greptime-ledger.md` ("Coverage and archive") has the format, the verify procedure and why this must exist before `SUBSTRATE_LEDGER_TTL` is set.

**Both files are staged, disabled by default.** The archive must leave the box — the root disk is at 94 % and the release prune would take anything under `/opt/agent-substrate` with it — so enabling is an operator step, in this order:

1. Mount the off-box path (an attached volume, an NFS or object-storage mount) somewhere `ProtectSystem=full` leaves writable, such as `/mnt/ledger-archive`, with at least `SUBSTRATE_DEPLOY_MIN_FREE_GB` (5 GB) free; the command refuses a filesystem below that floor, the release root, the checkout, `/` and any directory on the root filesystem — it compares the device (`st_dev`) of the nearest existing ancestor with that of `/` and of the release root before creating anything, so a volume that failed to mount after a reboot is a named refusal (exit 2), never an archive quietly built on the root disk. `SUBSTRATE_LEDGER_ARCHIVE_ALLOW_ROOTFS=1` waives that one gate for a deliberate local test; do not set it on the VPS.
2. Install the unit, timer and drop-in (`cp infra/vps/substrate-ledger-archive.{service,timer} /etc/systemd/system/`, `install -d -m 0700 /etc/systemd/system/substrate-ledger-archive.service.d`, `install -m 0600 infra/vps/substrate-ledger-archive.service.d/10-environment.conf` there) and add `Environment=SUBSTRATE_LEDGER_ARCHIVE_DIR=/mnt/ledger-archive` to the drop-in (or the same name to `substrate.env`). The unit ships `RequiresMountsFor=/mnt/ledger-archive`, so systemd orders it after that mount and fails the start while it is down; if the archive lives elsewhere, add `RequiresMountsFor=<the real path>` to the same drop-in (the directive accumulates). With the name unset the unit starts, refuses by name (exit 2) and writes nothing.
3. `systemctl daemon-reload`, then one run by hand — `systemctl start substrate-ledger-archive.service` — and read `journalctl -u substrate-ledger-archive`; verify it from the checkout with `bun packages/cli/src/index.ts ledger verify-archive /mnt/ledger-archive` (exit 2 on any mismatch).
4. `systemctl enable --now substrate-ledger-archive.timer`. `bun scripts/doctor-units.ts --dry-run` must stay green; `substrate ledger coverage` (and `/healthz.jobs.ledger.lastArchiveDay`) shows the newest archived day.

`note-pending-<day>.json` is written beside a day's manifest before its ledger note is sent and deleted only once the ledger reports it stored. If the ledger refuses the note (or the process dies mid-send) the files stay and the marker remains; the run exits 1 (the unit shows failed) and every later run sends the pending notes first and deletes each marker the ledger takes. Until then `coverage` does not list the day as archived.

Only once every day that a TTL would expire has a verified manifest is `SUBSTRATE_LEDGER_TTL` set — see the ledger doc's *Retention*.

### Root and ProtectHome=false

These two exceptions stay, and they are the reason `User=` is unset (the process runs as root) and `ProtectHome=false` is set:

- `ExecStart` uses the host bun at `/root/.local/share/reflex/bun/bin/bun`. `ProtectHome=true` would hide that interpreter.
- The Grok collector's session logs default to `/root/.grok/sessions`.

`WorkingDirectory` is no longer under `/root`, so the checkout is not a reason for either exception. Moving bun and the session logs off `/root` is a later operator decision, not this change.

## Doctor

`scripts/doctor-units.ts` is read-only. It does not call systemctl and it does not open an absolute `EnvironmentFile` (that file holds host secrets). Relative env files are read only inside the units directory, and only `*_DISABLED` assignments are kept.

```sh
bun scripts/doctor-units.ts --dry-run
```

Exit 0 is no findings. Exit 1 is findings. Exit 2 is a usage or git error. Findings:

- `dev-checkout` — `WorkingDirectory` is unset or contains `/src/repos/` (the mutable checkout).
- `missing-entry` — the `ExecStart` entry is not in the commit (`--repo` and `--commit`, default `HEAD`) or in `--release`.
- `restart-loop` — `Restart=always` while systemd reports the unit disabled or masked (`--enabled-state`), or while the unit's own `Environment=` sets a `*_DISABLED` value of `1`, `true`, or `yes`.
- `shared-env` — a collector's `EnvironmentFile` is `/etc/substrate/substrate.env`, or a substrate unit has no `EnvironmentFile`.

Only `substrate-*.service` units are checked. `--all` lifts that. `--enabled-state` accepts `systemctl list-unit-files` output (`unit state ...`).

On a built release that has no `.git` directory, pass `--release /opt/agent-substrate/current` instead of a commit.

### Runtime doctor

`scripts/doctor-runtime.ts` (`bun run doctor:runtime`) is the other half: it asks the host what is in force and compares that with what this directory declares (uplift-3 N1). It is read-only, calls every command with a fixed argv (no shell), never opens an env file — legacy keys are checked by name through `grep -q '^NAME=.'` exactly as `deploy-release.sh` does — and compares `Environment=` names, never values.

```sh
bun scripts/doctor-runtime.ts          # table
bun scripts/doctor-runtime.ts --json   # the same rows as JSON
```

One row per check, status `ok`, `warn`, `drift` or `unknown`. Exit 0 when nothing drifts, 2 on any drift (`warn` and `unknown` do not fail the run), 1 on a usage error. The checks:

- `units` — for every `substrate-*.service` here that is installed on the host: `Slice`, `MemoryMax`, `TasksMax` from `systemctl show` against the unit file plus its drop-ins, and the `Environment=` names the repo unit declares but the installed unit lacks. A staged unit that is not installed is `unknown`; one of the four release units not installed, or installed but not active, is `drift`.
- `slice` — `substrate.slice` installed, active and at the declared `MemoryLow`.
- `redis` — `redis-cli -h 127.0.0.1 config get` for `maxmemory`, `maxmemory-policy`, `save`, `appendonly` against `redis-substrate.conf`, and `redis-server.service`'s `MemoryMax` against `redis-server.service.d/10-substrate-limits.conf`. An unreachable redis is `unknown`, not drift.
- `timers` — `substrate-anchor.timer`, `substrate-index-sweep.timer`, `substrate-doctor.timer`: installed, enabled, active, last fired within two periods. The anchor timer missing is `drift` (BP-7's hourly root is not scheduled); the two opt-in timers missing are `unknown` and the hint says so.
- `disk` — `df -Pk /opt/agent-substrate` against `SUBSTRATE_DEPLOY_MIN_FREE_GB` (default 5): below the floor `drift`, below twice the floor `warn`.
- `swap` — pages swapped in or out between two reads of `/proc/vmstat` one second apart; any paging is `drift` (`SUBSTRATE_DOCTOR_SWAP_PAGES_PER_S` raises the threshold). Occupancy from `/proc/meminfo` is in the hint and is never alone a drift.
- `env` — `HINDSIGHT_BANK` present in `/etc/substrate/substrate.env` is `drift` with the `HINDSIGHT_BANKS` hint from `config.ts`; the value stays in grep.

**Timer (operator step, disabled by default).** `substrate-doctor.timer` runs `substrate-doctor.service` every six hours (`*-*-* 00/6:23:00 UTC`, `Persistent=true`), a oneshot from the pinned release in `substrate.slice` with `MemoryMax=256M`, loading `/etc/substrate/substrate.env` through `substrate-doctor.service.d/10-environment.conf` like the anchor job. `SuccessExitStatus=2` keeps a drift report from showing as a failed unit. The service runs with `--emit`, which posts one `warning` event per drift class (`units`, `slice`, `redis`, `timers`, `disk`, `swap`, `env`) to `SUBSTRATE_URL/events` as the `substrate` surface with `payload.runtime=doctor` — but only when `SUBSTRATE_DOCTOR_EMIT=1` is set (uncomment the line in the drop-in); otherwise `--emit` prints a hint and posts nothing. The bearer is `SUBSTRATE_TOKEN`, else the shared env's `SUBSTRATE_TOKEN_SUBSTRATE`, else the client resolver's token file or tokens dir for `substrate`; it is never printed. An unchanged drift set is not re-emitted: the last emitted set per class is kept in `SUBSTRATE_DOCTOR_STATE` (`/var/lib/substrate/doctor-last.json`), and a class that clears is forgotten so its next drift is reported again. The brief surfaces `warning` events, which is how a drift reaches the operator.

```sh
cp infra/vps/substrate-doctor.service infra/vps/substrate-doctor.timer /etc/systemd/system/
install -d -m 0755 /etc/systemd/system/substrate-doctor.service.d
install -m 0600 infra/vps/substrate-doctor.service.d/10-environment.conf /etc/systemd/system/substrate-doctor.service.d/10-environment.conf
systemctl daemon-reload
systemctl start substrate-doctor.service && journalctl -u substrate-doctor -n 40   # one run, no timer yet
systemctl enable --now substrate-doctor.timer
```

Rollback: `systemctl disable --now substrate-doctor.timer`, remove the three files, `daemon-reload`. Nothing else changes; the doctor never writes outside its state file.

## Code that reaches main through v1.3, not this PR

herdr and muse are on `main` since Phase 19 (LANEB-01 to LANEB-04) and run from the release like the Grok collector. `skills-sync.ts` and `substrate_miner` are still not on `main`.

- skills-sync and the miner bridge land through Phase 22, from commits `354310c` and `be77187` on `docs/data-planes-tailscale`, with Phase 18's shared redactor. `354310c` also contains herdr and muse; Phase 19 still owns that recovery. Phase 22 owns `skills-sync.ts` and `packages/miner`.

## Operator steps

Each step is its own approved window. After each one, run the doctor read-only (`bun scripts/doctor-units.ts --dry-run` against the unit files just installed, or `--units` pointed at a scratch copy of the host units). Do not batch the steps.

1. **Pause the failing timers until Phase 22.** Stop and disable `substrate-skills-sync.timer` and `substrate-skills-bridge.timer`. Their `ExecStart` targets are not on `main`, and the timers fire every five minutes.
2. **Stop the dispatcher restart loop.** The installed dispatcher uses `Restart=always` and idles on `SUBSTRATE_DISPATCH_DISABLED=1`, so a clean exit is started again every few seconds. Stop and disable `substrate-dispatcher.service`. Leave `SUBSTRATE_DISPATCH_DISABLED=1` set. Do not start it again in this window.
3. **Give the audit chain a durable path.** Set `SUBSTRATE_AUDIT_PATH` in `/etc/substrate/substrate.env`. The name is already in `.env.example`; the unit's `StateDirectory=substrate` is `/var/lib/substrate`. Restart `substrate-mcp` only, then confirm `/healthz` reports the chain as durable.
4. **Move herdr and muse onto the release** (after Phase 19). This needs a published release: `/opt/agent-substrate/current` must already exist, so on a first installation the collectors are moved by step 5 (5b creates their env files and 5c installs their units), and this step is only for a host whose release already exists. Create `substrate-collector-herdr.env` and `substrate-collector-muse.env` (root-owned, mode 0600, the names above), install both units and their drop-ins, `systemctl daemon-reload`, then restart one collector at a time and confirm `ActiveState=active`, `NRestarts=0`, and a second restart that comes back the same way.
5. **Install the first pinned release** (after this PR is merged, still its own window). The units loaded today still use the checkout as `WorkingDirectory`. A deploy that restarts them before the new unit files are loaded health-checks the old code, and a reload that happens only after the script returns starts the new code outside that check.

   a. Build the first tree without restarting production: `SUBSTRATE_RELEASE_RESTART=0 deploy-release.sh <tag>`. This creates `/opt/agent-substrate/current` and leaves every older directory on disk. It does not restart units.
   b. Create `/etc/substrate/collector-grok.env`, `/etc/substrate/substrate-collector-herdr.env` and `/etc/substrate/substrate-collector-muse.env` (root-owned, mode 0600) with only the names each collector reads (above). 5d restarts all three, and a missing `EnvironmentFile` keeps that unit from starting.
   c. Install the unit files and drop-ins from this directory, and `substrate.slice` with them (every unit names it; see "Resource ceilings and the slice").
   d. Run `deploy-release.sh <tag>` again on the same tag. The tree is already built. The script runs `systemctl daemon-reload`, restarts the units in the list above, requires each unit to be active, and polls `/healthz` until it answers. Do not reload again after the script returns. Run the doctor read-only. Confirm `readlink /opt/agent-substrate/current` is `releases/<sha>` for that tag.

   **First-cutover rollback.** The first successful publish has no `previous` symlink, so `deploy-release.sh rollback` exits with `no previous release`. Restore all four unit files from the commit before this change, or from the operator's backup (`WorkingDirectory=/root/src/repos/agent-substrate`, `EnvironmentFile=/etc/substrate/substrate.env`). Remove the herdr and muse `10-environment.conf` drop-ins (`substrate-collector-{herdr,muse}.service.d/`). Keep Grok's: the pre-change Grok unit has no `EnvironmentFile` of its own and gets its URL and token from that drop-in. Then run `systemctl daemon-reload` and restart the four units, so none of them stays on the release being backed out. They run the checkout again, which needs the collectors' entry files there. Leave the release directory in place; the restored units do not use it.

   **Later rollbacks.** Once a previous release exists, rollback is `deploy-release.sh rollback`, then the doctor again.

   When any `SUBSTRATE_TOKEN_*` is set, `/healthz` requires a bearer. Point `SUBSTRATE_HEALTH_TOKEN_FILE` at a root-only file that contains only one token, or set `SUBSTRATE_HEALTH_CMD` to an absolute executable. Do not put the token in the URL or on the command line.
