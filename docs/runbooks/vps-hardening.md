# VPS sandbox hardening

**This change installs nothing.** It stages one example drop-in per substrate unit
(`infra/vps/<unit>.service.d/30-sandbox.conf.example`), adds report-only doctor rows,
and adds a test. The `.example` suffix keeps each file out of systemd, which reads
`*.conf` only. `scripts/doctor-runtime.ts` does read and parse the staged examples: it
treats them as the declared spec and compares them with systemd's effective values
only for a unit whose `/etc/systemd/system/<unit>.service.d/30-sandbox.conf` is
installed. No script, unit, timer or test copies, enables or restarts anything; the
steps below are the operator's, one unit at a time.

## Why

`systemd-analyze security` scores every `substrate-*.service` at **8.1 EXPOSED**
(measured on the VPS on 2026-10-14 for `substrate-mcp`, `substrate-dispatcher` and
`substrate-collector-grok`; `systemd-analyze security --offline=true` gives 8.1 for all
fifteen unit files here, because they carry one identical block). That block is `NoNewPrivileges`,
`PrivateTmp`, `ProtectSystem=full`, `ProtectHome=false`, `ProtectKernelTunables`,
`ProtectControlGroups` and `RestrictAddressFamilies`. The drop-ins add the rest of
the cheap, reversible restrictions and nothing that changes what a unit does.

Every unit still runs as root: bun lives under `/root/.local`
(`infra/vps/README.md`, "Root and ProtectHome=false"), and moving it is a separate
operator decision.

## Classes

| Class | Who | What changes | What stays |
| --- | --- | --- | --- |
| **A** | units that write only their own state under `/var/lib/substrate` (or an archive mount) | `ProtectSystem=strict`, **`ProtectHome=read-only`**, `RestrictNamespaces=true`, the kernel and ABI restrictions, a deny-list `CapabilityBoundingSet` | root, the bun binary readable and executable under `/root`, network families |
| **B** | units that write inside operator git repos or tool homes under `/root` | `ProtectSystem=strict`, the kernel and ABI restrictions, a deny-list `CapabilityBoundingSet`, `RestrictNamespaces=true` except dispatcher and host | **`ProtectHome=false`**, and `ReadWritePaths=` lists what they write |

`ProtectSystem=strict` makes the whole file system read-only except `/dev`, `/proc`,
`/sys`, the unit's `StateDirectory=` and its `ReadWritePaths=`. `/tmp` stays private
and writable (`PrivateTmp=true` is in the base unit).

The directives every example shares, and why each is safe for these units:

- `ProtectKernelModules`, `ProtectKernelLogs`, `ProtectClock`, `ProtectHostname`: no
  unit loads modules, reads `dmesg`, sets the clock or renames the host.
- `LockPersonality`, `RestrictRealtime`, `RestrictSUIDSGID`: no unit changes its ABI
  personality, takes a realtime class or creates setuid files.
- `SystemCallArchitectures=native`: bun, node and python3 are native binaries.
- `RestrictNamespaces=true`: nothing in a Class A unit unshares a namespace. It is
  left off dispatcher and host on purpose (below).
- `CapabilityBoundingSet=~CAP_…`: a **deny list** of the capabilities no unit needs
  (`CAP_SYS_ADMIN`, `CAP_SYS_PTRACE`, `CAP_NET_ADMIN`, `CAP_BPF`, `CAP_SYS_BOOT`,
  `CAP_MKNOD`, …). It keeps `CAP_DAC_OVERRIDE`, `CAP_DAC_READ_SEARCH`, `CAP_FOWNER`,
  `CAP_CHOWN`, `CAP_SETUID`, `CAP_SETGID` and `CAP_KILL`: a root unit reads files it
  does not own (docker-group sockets, operator checkouts) through `CAP_DAC_OVERRIDE`.
  Class B keeps `CAP_SYS_ADMIN`, `CAP_SYS_PTRACE`, `CAP_NET_ADMIN`, `CAP_NET_RAW` and
  `CAP_MKNOD` too, because a Hermes session or a sandbox VM may use them.

## Per unit

Scores are `systemd-analyze security --offline=true` with the unit and its real
`10-environment.conf` plus the example installed as `30-sandbox.conf`, on systemd 255.
The ceiling is what `scripts/sandbox-dropins.test.ts` enforces; an unmeasured
change that raises a score above it fails the test.

| Unit | Class | Ceiling | Offline score | Writable besides `/tmp` |
| --- | --- | --- | --- | --- |
| `substrate-mcp` | A | 5.0 | 4.7 (4.8 with the watchdog drop-in installed) | `/var/lib/substrate` |
| `substrate-anchor` | A | 5.0 | 4.7 | `/var/lib/substrate` |
| `substrate-doctor` | A | 5.0 | 4.7 | `/var/lib/substrate` |
| `substrate-docs-canary` | A | 5.0 | 4.7 | `/var/lib/substrate` |
| `substrate-index-sweep` | A | 5.0 | 4.7 | `/var/lib/substrate` |
| `substrate-cross-layer-reconcile` | A | 5.0 | 4.7 | none (read-only; `/var/lib/substrate` not opened) |
| `substrate-alert@` | A | 5.0 | 4.7 | nothing |
| `substrate-collector-grok` | A | 5.0 | 4.7 | `/var/lib/substrate` |
| `substrate-index-archive` | A | 5.0 | 4.7 | `/var/lib/substrate`, `/mnt/index-archive` |
| `substrate-ledger-archive` | A | 5.0 | 4.7 | `/var/lib/substrate`, `/mnt/ledger-archive` |
| `substrate-collector-muse` | B | 6.0 | 5.5 | `/var/lib/substrate`, `-/root/src/repos` |
| `substrate-collector-herdr` | B | 6.0 | 5.5 | `/var/lib/substrate`, `-/root/.config/herdr` |
| `substrate-skills-sync` | B | 6.0 | 5.5 | `/var/lib/substrate` (through `ReadWritePaths=`: the base unit has no `StateDirectory=`), the library checkout and the tool homes it projects into (list in the example) |
| `substrate-skills-bridge` | B | 6.0 | 5.5 | `/var/lib/substrate`, the Hermes, Omp and Grok queues and the library (list in the example) |
| `substrate-dispatcher` | B | 6.5 | 6.3 | `/var/lib/substrate`, `/root` |
| `substrate-host` | B | 6.5 | 6.3 | `/var/lib/substrate`, `-/root` |

A `-` prefix on a `ReadWritePaths=` entry means "skip it if it does not exist". The
archive units use no prefix on purpose: a missing mount must fail the start (status
`226/NAMESPACE`), exactly as `RequiresMountsFor=` does, and never fall back to a
read-only root. Each example's header names the code that writes each path.

Why dispatcher and host score highest: dispatcher's Hermes sessions and host's
VM/sandbox lifecycle write under `/root` (`git worktree add` inside
`/root/src/repos/<repo>/.git`, `HOME=/root`, the OAuth store the host refreshes), and
neither writable set is enumerable from this repo, so `/root` stays writable and
`RestrictNamespaces` stays off (a tool they spawn may create user or mount
namespaces). Narrow them only after measuring a real session.

The scores are offline estimates of the directives, not a proof the units start. The
startup proof is the transient test below.

## Procedure (per unit, one at a time, in its own window)

Do the units in order of risk: `substrate-alert@`, a oneshot such as
`substrate-index-sweep`, `substrate-doctor`, the collectors, `substrate-mcp`, then
Class B.

1. **Read the header of the unit's example**
   (`infra/vps/<unit>.service.d/30-sandbox.conf.example`): writable paths, what it
   reads, and anything marked *Unmeasured*.
2. **Transient test.** Copy the `systemd-run --pipe --wait --collect -p … ` command
   from the example's header and run it. It starts a throw-away unit with the same
   properties (it changes no unit file) and checks that the interpreter runs, that
   a throwaway state directory is writable and, for Class A, that `/root` is not.
   **The transient test uses `-p StateDirectory=u5-sandbox-test`, never
   `StateDirectory=substrate`**: systemd re-applies its default mode (0755) to a state
   directory it is asked for, and `/var/lib/substrate` holds the audit chain and is 0700
   (`StateDirectoryMode=0700` in the base units). Remove the throwaway directory
   afterwards (`rm -rf /var/lib/u5-sandbox-test`). Class A shape:

   ```sh
   systemd-run --pipe --wait --collect \
     -p ProtectSystem=strict -p ProtectHome=read-only -p StateDirectory=u5-sandbox-test \
     /bin/sh -c '/root/.local/share/reflex/bun/bin/bun --version && test -w /var/lib/u5-sandbox-test && ! test -w /root'
   ```

   (the real command carries every property of the example; this is the shape.)
   Class B uses `ProtectHome=false` and a `ReadWritePaths=` for the first writable
   path, and checks `test -w <that path> && ! test -w /usr`.

   Success prints a version and exits 0. Failure looks like:
   - `Read-only file system` or `Permission denied` naming a path: the unit writes
     there. Add that path to `ReadWritePaths=` only if the code really needs it.
   - exit status `226/NAMESPACE`: a `ReadWritePaths=` path without a `-` prefix does
     not exist.
   - exit status `218/CAPABILITIES` or `EPERM` from a privileged call: a denied
     capability is needed; remove it from the deny list.
   - the process killed by `SIGSYS`: a non-native syscall architecture.

   A property that systemd does not know is logged and ignored, so a clean run also
   needs `systemd-analyze verify` to print nothing for the drop-in (the test suite
   does this offline).
3. **Install the drop-in** (the example's header has the exact lines):

   ```sh
   install -d -m 0755 /etc/systemd/system/<unit>.service.d
   install -m 0644 infra/vps/<unit>.service.d/30-sandbox.conf.example \
     /etc/systemd/system/<unit>.service.d/30-sandbox.conf
   systemctl daemon-reload && systemctl restart <unit>.service
   ```

   For a oneshot, `systemctl start <unit>.service` instead of a restart, then
   `journalctl -u <unit> -n 50`.
4. **Check.** `systemctl is-active <unit>`, the unit's own health (`curl -s
   http://127.0.0.1:7410/livez` for the MCP server), then `bun scripts/doctor-runtime.ts`:
   the `<unit> sandbox` row is `ok` ("as declared") and `<unit> exposure` shows the new
   score. `systemd-analyze security <unit> --no-pager` lists what is still open.
5. **Rollback.** `rm /etc/systemd/system/<unit>.service.d/30-sandbox.conf`,
   `systemctl daemon-reload`, `systemctl restart <unit>.service`. The unit is back to
   the base file; no state was changed by the drop-in.

Rollback restores the unit's sandbox settings only. It does not undo anything the
unit wrote while running, and it is unrelated to the code release (`deploy-release.sh`
rollback).

Do not install a drop-in on a unit whose transient test failed. Do not edit the
`.example` to add a path the test did not need.

## Doctor rows

`bun scripts/doctor-runtime.ts` (`infra/vps/README.md`, "Runtime doctor") reads, for each
unit systemd has loaded:

- `<unit> exposure` — the overall score of `systemd-analyze security <unit> --no-pager`.
  It exits 0 and is `ok` while `SUBSTRATE_EXPOSURE_MAX` is unset (report only, the hint
  names the staged drop-in). Set to a number from 0 to 10, a unit **above** it is `drift`
  (exit 2); a score equal to it is `ok`. A value that is not such a number is one `warn`
  row and the rows stay report-only.
- `<unit> sandbox` — only when `/etc/systemd/system/<unit>.d/30-sandbox.conf` exists:
  the example's directives against `systemctl show`. It is `drift` when the file is on
  disk but not in force (no `daemon-reload` since the copy, or a later drop-in
  overrides it), naming the directive. Entries added to `ReadWritePaths=` beyond the
  example are not drift.
- `systemd-analyze security` — a single `unknown` row when `systemd-analyze` is missing
  or fails on its first two units without ever printing a verdict (no `security` verb);
  no per-unit rows follow it. A non-zero exit on a later unit is that unit's own
  `unknown` row and the next unit is still analysed, so one flaky call cannot hide a
  unit above the ceiling. At most 64 analyzer calls are made per run.
- A template (`substrate-alert@.service`) gets the `sandbox` row when its drop-in is
  installed, and never an exposure row (there is no instance to analyse).
- `docker reclaimable` — see `docs/runbooks/disk-pressure.md`. Report-only: the sum of
  `docker system df`'s reclaimable column, through `timeout 10`, with `unavailable`
  when docker is absent, slow or denied. It is the Docker engine's space, shared with
  other tenants of the host and not substrate's, and the doctor never prunes it.

`SUBSTRATE_EXPOSURE_MAX` is read by the doctor process, so set it where the doctor
runs: in `substrate-doctor.service.d/10-environment.conf` for the timer, or in the
shell for a manual run. Leave it unset until the units are hardened; then set it to the
highest class ceiling you accept (6.5 covers every example).

## Rejected directives

None of these appears in any example, and `scripts/sandbox-dropins.test.ts` fails if
one does.

| Directive | Why not |
| --- | --- |
| `MemoryDenyWriteExecute=` | bun's JIT needs writable and executable pages; the process would crash at start |
| `User=` / `DynamicUser=` | the bun binary is under `/root/.local`; a non-root user cannot execute it. Moving bun is a separate operator decision |
| empty or allow-list `CapabilityBoundingSet=` | a root unit would lose `CAP_DAC_OVERRIDE` and stop reading files it does not own (docker-group sockets, operator checkouts). Revisit only after measuring |
| `SystemCallFilter=` / `SystemCallLog=` | the bun, node and python3 syscall sets are unmeasured and a wrong filter kills the process; there is no shadow mode without audit logging |
| `PrivateNetwork=` / `IPAddressDeny=` / `IPAddressAllow=` | units reach Railway, Greptile and Tailscale endpoints |
| `PrivateDevices=` | the host unit's docker socket and device paths are unmeasured, and the score gain is small |
| `ProtectHome=read-only` on a Class B unit | muse writes `.git/info/exclude` inside operator repos, the dispatcher runs `git worktree add` there, skills sync merges into `/root/agent-skills` |
| any `Exec*=`, any docker command or prune | a sandbox drop-in only restricts. Substrate reports Docker space; it never frees it |

## Known limits

- The numbers are offline scores. The startup of each hardened unit is verified by the
  transient test in step 2, which this repository's tests do not run.
- `substrate-mcp` may need `ReadWritePaths=-/root/.config/gh -/root/.docker` if `gh` or
  the docker client write their own config under a read-only `/root`. That is
  unmeasured and is not shipped; the mcp example's header says how to recognise it.
- `substrate-anchor` spawns the solana CLI with `HOME=/root`; any config or cache it writes
  under `/root/.config/solana` is unmeasured (header names the follow-up line).
- `SUBSTRATE_AUDIT_PATH` lives in the env file this repository never reads. The mcp unit
  declares `StateDirectory=substrate`; an audit path outside `/var/lib/substrate` needs its
  own `ReadWritePaths=` line.
- A units directory other than `/etc/systemd/system` (a `systemctl edit` override under
  `/run`, a distro path) is not seen by the `sandbox` row.
