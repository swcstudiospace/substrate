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

`deploy-release.sh rollback` swaps `current` back to `previous` and health-checks again.

The script restarts `substrate-mcp.service`, `substrate-collector-grok.service`, `substrate-collector-herdr.service` and `substrate-collector-muse.service`: every unit whose `WorkingDirectory` is the release, so no collector keeps running the old tree after a swap. Set `SUBSTRATE_RELEASE_UNITS` to override the list. The dispatcher and the skills timers are not restarted from here.

## Units

All four units in this directory use `WorkingDirectory=/opt/agent-substrate/current`. The MCP, herdr and muse units also set `ConditionPathExists` on their entry file under that symlink, so a missing entry skips the start instead of crash-looping. The Grok unit has no such guard. Install the matching drop-in with each unit:

| Unit | Drop-in | EnvironmentFile |
| --- | --- | --- |
| `substrate-mcp.service` | `substrate-mcp.service.d/10-environment.conf` | `/etc/substrate/substrate.env` |
| `substrate-collector-grok.service` | `substrate-collector-grok.service.d/10-environment.conf` | `/etc/substrate/collector-grok.env` |
| `substrate-collector-herdr.service` | `substrate-collector-herdr.service.d/10-environment.conf` | `/etc/substrate/collector-herdr.env` |
| `substrate-collector-muse.service` | `substrate-collector-muse.service.d/10-environment.conf` | `/etc/substrate/collector-muse.env` |

The MCP server is the process that needs the shared env file. The Grok collector must not load it. Create `collector-grok.env` (root-owned, mode 0600) with only the names this process reads: `SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, and optionally `GROK_SESSIONS_DIR`. `SUBSTRATE_COLLECTOR_STATE` is already set on the unit. Do not put database URLs, plane keys, handoff keys, or review tokens in that file. No values belong in git.

The same rule holds for the other two collectors. `collector-herdr.env` holds `SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, and optionally `HERDR_SOCKET_PATH` or `HERDR_SESSION` (the socket defaults to `/root/.config/herdr/herdr.sock`). `collector-muse.env` holds `SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, and `SUBSTRATE_MUSE_REPOS`. `SUBSTRATE_COLLECTOR_STATE` and `SUBSTRATE_STATE_DIR` are set on the units.

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

## Code that reaches main through v1.3, not this PR

herdr and muse are on `main` since Phase 19 (LANEB-01 to LANEB-04) and run from the release like the Grok collector. `skills-sync.ts` and `substrate_miner` are still not on `main`.

- skills-sync and the miner bridge land through Phase 22, from commits `354310c` and `be77187` on `docs/data-planes-tailscale`, with Phase 18's shared redactor. `354310c` also contains herdr and muse; Phase 19 still owns that recovery. Phase 22 owns `skills-sync.ts` and `packages/miner`.

## Operator steps

Each step is its own approved window. After each one, run the doctor read-only (`bun scripts/doctor-units.ts --dry-run` against the unit files just installed, or `--units` pointed at a scratch copy of the host units). Do not batch the steps.

1. **Pause the failing timers until Phase 22.** Stop and disable `substrate-skills-sync.timer` and `substrate-skills-bridge.timer`. Their `ExecStart` targets are not on `main`, and the timers fire every five minutes.
2. **Stop the dispatcher restart loop.** The installed dispatcher uses `Restart=always` and idles on `SUBSTRATE_DISPATCH_DISABLED=1`, so a clean exit is started again every few seconds. Stop and disable `substrate-dispatcher.service`. Leave `SUBSTRATE_DISPATCH_DISABLED=1` set. Do not start it again in this window.
3. **Give the audit chain a durable path.** Set `SUBSTRATE_AUDIT_PATH` in `/etc/substrate/substrate.env`. The name is already in `.env.example`; the unit's `StateDirectory=substrate` is `/var/lib/substrate`. Restart `substrate-mcp` only, then confirm `/healthz` reports the chain as durable.
4. **Move herdr and muse onto the release** (after Phase 19). This needs a published release: `/opt/agent-substrate/current` must already exist, so on a first installation run step 5 first. Create `collector-herdr.env` and `collector-muse.env` (root-owned, mode 0600, the names above), install both units and their drop-ins, `systemctl daemon-reload`, then restart one collector at a time and confirm `ActiveState=active`, `NRestarts=0`, and a second restart that comes back the same way.
5. **Install the first pinned release** (after this PR is merged, still its own window). The units loaded today still use the checkout as `WorkingDirectory`. A deploy that restarts them before the new unit files are loaded health-checks the old code, and a reload that happens only after the script returns starts the new code outside that check.

   a. Build the first tree without restarting production: `SUBSTRATE_RELEASE_RESTART=0 deploy-release.sh <tag>`. This creates `/opt/agent-substrate/current` and leaves every older directory on disk. It does not restart units.
   b. Create `/etc/substrate/collector-grok.env` (root-owned, mode 0600) with only the names the collector reads. A missing `EnvironmentFile` keeps that unit from starting.
   c. Install the unit files and drop-ins from this directory.
   d. Run `deploy-release.sh <tag>` again on the same tag. The tree is already built. The script runs `systemctl daemon-reload`, restarts the units in the list above, requires each unit to be active, and polls `/healthz` until it answers. Do not reload again after the script returns. Run the doctor read-only. Confirm `readlink /opt/agent-substrate/current` is `releases/<sha>` for that tag.

   **First-cutover rollback.** The first successful publish has no `previous` symlink, so `deploy-release.sh rollback` exits with `no previous release`. Restore all four unit files from the commit before this change, or from the operator's backup (`WorkingDirectory=/root/src/repos/agent-substrate`, `EnvironmentFile=/etc/substrate/substrate.env`). Remove the `10-environment.conf` drop-ins of the three collectors (`substrate-collector-{grok,herdr,muse}.service.d/`). Then run `systemctl daemon-reload` and restart the four units, so none of them stays on the release being backed out. They run the checkout again, which needs the collectors' entry files there. Leave the release directory in place; the restored units do not use it.

   **Later rollbacks.** Once a previous release exists, rollback is `deploy-release.sh rollback`, then the doctor again.

   When any `SUBSTRATE_TOKEN_*` is set, `/healthz` requires a bearer. Point `SUBSTRATE_HEALTH_TOKEN_FILE` at a root-only file that contains only one token, or set `SUBSTRATE_HEALTH_CMD` to an absolute executable. Do not put the token in the URL or on the command line.
