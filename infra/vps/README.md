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

The sha is the tag peeled to a commit. `bun install --frozen-lockfile` runs in that directory. `current` is replaced with `mv -T` on a new symlink, so readers see either the old target or the new one. A failed health check points `current` back at the previous target and restarts the units. After a successful deploy only the new release and one previous directory remain.

Override the root with `SUBSTRATE_RELEASE_ROOT` (tests do; production uses the default). `SUBSTRATE_REPO` is the local git directory the tag is read from. `git archive` exports the commit, not a dirty worktree. `SUBSTRATE_RELEASE_RESTART=0` builds the tree and does not restart or health-check. `SUBSTRATE_HEALTH_CMD`, when set, is an absolute executable path with no shell. Otherwise the check is `curl -fsS` of `SUBSTRATE_HEALTH_URL` (default `http://127.0.0.1:7410/healthz`) and a URL with credentials in it is refused.

`deploy-release.sh rollback` swaps `current` back to `previous` and health-checks again.

The script restarts only `substrate-mcp.service` and `substrate-collector-grok.service`. herdr, muse, the dispatcher, and the skills timers are not restarted from here.

## Units

Both units in this directory use `WorkingDirectory=/opt/agent-substrate/current`. Install the matching drop-in with the unit:

| Unit | Drop-in | EnvironmentFile |
| --- | --- | --- |
| `substrate-mcp.service` | `substrate-mcp.service.d/10-environment.conf` | `/etc/substrate/substrate.env` |
| `substrate-collector-grok.service` | `substrate-collector-grok.service.d/10-environment.conf` | `/etc/substrate/collector-grok.env` |

The MCP server is the process that needs the shared env file. The Grok collector must not load it. Create `collector-grok.env` (root-owned, mode 0600) with only the names this process reads: `SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, and optionally `GROK_SESSIONS_DIR`. `SUBSTRATE_COLLECTOR_STATE` is already set on the unit. Do not put database URLs, plane keys, handoff keys, or review tokens in that file. No values belong in git.

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

This PR does not copy `herdr.ts`, `muse.ts`, `skills-sync.ts`, or `substrate_miner`.

- herdr and muse land through Phase 19 (LANEB-01 to LANEB-04). Do not restart `substrate-collector-herdr` or `substrate-collector-muse` before that code is on `main`. Their entry files are not on `main` today; a restart would fail closed on a missing module.
- skills-sync and the miner bridge land through Phase 22, from commits `354310c` and `be77187` on `docs/data-planes-tailscale`, with Phase 18's shared redactor. `354310c` also contains herdr and muse; Phase 19 still owns that recovery. Phase 22 owns `skills-sync.ts` and `packages/miner`.

## Operator steps

Each step is its own approved window. After each one, run the doctor read-only (`bun scripts/doctor-units.ts --dry-run` against the unit files just installed, or `--units` pointed at a scratch copy of the host units). Do not batch the steps.

1. **Pause the failing timers until Phase 22.** Stop and disable `substrate-skills-sync.timer` and `substrate-skills-bridge.timer`. Their `ExecStart` targets are not on `main`, and the timers fire every five minutes.
2. **Stop the dispatcher restart loop.** The installed dispatcher uses `Restart=always` and idles on `SUBSTRATE_DISPATCH_DISABLED=1`, so a clean exit is started again every few seconds. Stop and disable `substrate-dispatcher.service`. Leave `SUBSTRATE_DISPATCH_DISABLED=1` set. Do not start it again in this window.
3. **Give the audit chain a durable path.** Set `SUBSTRATE_AUDIT_PATH` in `/etc/substrate/substrate.env`. The name is already in `.env.example`; the unit's `StateDirectory=substrate` is `/var/lib/substrate`. Restart `substrate-mcp` only, then confirm `/healthz` reports the chain as durable.
4. **Do not restart herdr or muse.** Wait until Phase 19 has put their code on `main`.
5. **Install the first pinned release** (after this PR is merged, still its own window). This is the cutover Phase 16's parity runbook calls: install the unit files and drop-ins, run `deploy-release.sh` on a tag of `main`, then `systemctl daemon-reload` and restart only `substrate-mcp` and `substrate-collector-grok`. Run the doctor read-only. Confirm `/healthz` answers and that `readlink /opt/agent-substrate/current` is `releases/<sha>` for that tag. Rollback is `deploy-release.sh rollback` (the previous symlink), then the doctor again.

Create `/etc/substrate/collector-grok.env` before the collector restart in step 5. A missing `EnvironmentFile` keeps that unit from starting.
