# U5-2 — VPS sandbox hardening (slice branch `u5/s2`)

**Nothing is installed by code.** The drop-ins are `*.conf.example`; the doctor only reads; the tests only copy files into a scratch directory.

## Files

Created
- `infra/vps/<unit>.service.d/30-sandbox.conf.example` for all 15 `substrate-*.service` (alert@, anchor, collector-grok/herdr/muse, dispatcher, docs-canary, doctor, host, index-archive, index-sweep, ledger-archive, mcp, skills-bridge, skills-sync). Directories for dispatcher, host, skills-bridge and skills-sync are new (they had no `.d/`). `30` because `10-environment.conf` and `20-watchdog.conf.example` are taken.
- `scripts/doctor-sandbox.ts` — exposure and installed-drop-in rows (pure parsers + `gatherHardeningRows`).
- `scripts/doctor-sandbox.test.ts`, `scripts/sandbox-dropins.test.ts`.
- `docs/runbooks/vps-hardening.md`.
- `.planning/uplift-5/env-notes/S2.md`, this file.

Changed
- `scripts/doctor-runtime.ts` — imports; `DeclaredUnit.sandbox?`; `loadDeclaredUnits` attaches the staged example; `DoctorOptions.hardening?` / `dockerReclaim?`; `optionsFromEnv` turns both on; `gatherRows` calls them; `--help` text. Existing rows and their order are unchanged.
- `scripts/doctor-vps.ts` — `gatherDockerReclaim`, `parseDockerDf`, `parseDockerSize`, `DOCKER_DF_ARGV`.
- `scripts/doctor-vps.test.ts` — docker tests appended.
- `infra/vps/README.md` — one new subsection after "Root and ProtectHome=false" and two bullets in "Runtime doctor" (small hunks).
- `docs/runbooks/disk-pressure.md` — one paragraph about the docker row.

## Class split and measured scores

`systemd-analyze security --offline=true` (systemd 255), unit + its real `10-environment.conf` (+ `20-watchdog.conf` for mcp) + the example installed as `30-sandbox.conf`. The base unit scores **8.1** for every one of the 15 files.

| Class | Units | Ceiling | Measured |
| --- | --- | --- | --- |
| A | mcp, anchor, doctor, docs-canary, index-sweep, alert@, collector-grok, index-archive, ledger-archive | 5.0 | 4.7 (mcp with watchdog drop-in: 4.8) |
| B | collector-muse, collector-herdr, skills-sync, skills-bridge | 6.0 | 5.5 |
| B | dispatcher, host | 6.5 | 6.3 |

Class A = `ProtectSystem=strict` + `ProtectHome=read-only`; Class B = `ProtectSystem=strict` + `ProtectHome=false` + `ReadWritePaths=`. All: `ProtectKernelModules/Logs`, `ProtectClock`, `ProtectHostname`, `LockPersonality`, `RestrictRealtime`, `RestrictSUIDSGID`, `SystemCallArchitectures=native`, deny-list `CapabilityBoundingSet=~CAP_…` (keeps `CAP_DAC_OVERRIDE`, `CAP_DAC_READ_SEARCH`, `CAP_FOWNER`, `CAP_CHOWN`, `CAP_SETUID/GID`, `CAP_KILL`), `RestrictNamespaces=true` except dispatcher and host. Archive units add `ReadWritePaths=/mnt/<name>-archive` WITHOUT the `-` prefix (a missing mount must fail the start).

Note: the brief's Class B list was "muse, dispatcher, herdr, host". I also classed `substrate-skills-sync` and `substrate-skills-bridge` as B (they were not in the brief or L1): sync writes `/root/agent-skills` and the projection targets (`packages/projector/src/skills.ts:83-104`), the bridge moves files out of `/root/.hermes`, `/root/.omp`, `/root/.grok` queues (`bridge.py:42-53`). `ReadWritePaths` entries for them carry a `-` prefix so an absent tool home is a no-op.

## Flags and defaults

- `SUBSTRATE_EXPOSURE_MAX` (doctor process env). Unset/empty = report only: every `<unit> exposure` row is `ok`, exit code unchanged. Number 0..10 = a unit above it is `drift` (exit 2; equal is ok). Anything else (`lots`, `11`, `5,5`) = one `warn` row `SUBSTRATE_EXPOSURE_MAX`, still report-only.
- `docker reclaimable` has no flag: it is always `ok` or `unknown`, so it cannot change the exit code. `gatherRows` only runs it when `options.dockerReclaim === true` (set by `optionsFromEnv`), so the existing test callers of `gatherRows` with explicit options are byte-identical.

## Doctor rows (all class `units` except docker = `disk`)

- `<unit> exposure` — `systemd-analyze security <unit> --no-pager` overall score, only for units `systemctl show` reports `LoadState=loaded`; templates (`@`) skipped. First failure of the analyzer (missing binary, non-zero exit) = one `systemd-analyze security` `unknown` row and no further analyzer calls.
- `<unit> sandbox` — only when `/etc/systemd/system/<unit>.d/30-sandbox.conf` is readable: example directives vs `systemctl show` (`ProtectSystem/Home`, the Protect*/Restrict* booleans, `RestrictNamespaces`, `SystemCallArchitectures`, `CapabilityBoundingSet`, `ReadWritePaths`). Extra effective `ReadWritePaths` entries are fine; a property `systemctl show` did not print is skipped; none printed = `unknown`.
- `docker reclaimable` — `timeout 10 docker system df --format '{{json .}}'`; exit 124/127/other/unparseable = `unknown` `unavailable`.

## Tests added (what each proves)

`scripts/sandbox-dropins.test.ts`
- coverage: every `substrate-*.service` has an example with class, ceiling < 8.1, installs as `30-sandbox.conf`.
- denylist: no `MemoryDenyWriteExecute`, `User`, `DynamicUser`, `SystemCallFilter/Log`, `PrivateNetwork`, `IPAddress*`, `PrivateDevices`, no `Exec*`, no "prune"; Class B keeps `ProtectHome=false`, Class A `read-only`; the muse/dispatcher/herdr/host set is B; `CapabilityBoundingSet` is a deny list keeping DAC/FOWNER/CHOWN/SETUID/KILL; `ReadWritePaths` absolute, no system tree, Class A never opens `/root`; archive units open exactly their mount without `-`.
- typo guard: every directive is in the doctor's verifiable set; the `systemd-run -p` list in each header equals the file's directives.
- offline exposure: per unit, score with drop-in ≤ ceiling, < the unit alone, < 8.1 for Class A; `systemd-analyze verify` prints nothing about `30-sandbox.conf`. Skipped with a `console.warn` when the analyzer cannot score offline (never a silent pass).

`scripts/doctor-sandbox.test.ts`: parsing; `SUBSTRATE_EXPOSURE_MAX` parse; exposure ok/drift/unknown boundaries; installed drop-in ok / not reloaded drift / overridden directive / negated and hex capability sets / old systemd unknown; gather: report-only exit 0, ceiling exit 2, fixed argv, template skipped, analyzer missing or too old = one row, unusable max = one warn; drop-in compared only when the file exists; whole-run: flag unset adds only ok rows and every other row is identical.

`scripts/doctor-vps.test.ts` (appended): docker size/JSON parsing incl. control characters, one ok row with the "not substrate-owned / nothing pruned" words, the argv is the bounded read-only command, every failure mode is `unknown`, huge reclaimable never warns, no row unless asked.

## Smoke commands for the orchestrator

```sh
cd <repository root>   # or the merged tree
bun test scripts/sandbox-dropins.test.ts scripts/doctor-sandbox.test.ts scripts/doctor-vps.test.ts scripts/doctor-runtime.test.ts scripts/doctor-units.test.ts
for f in infra/vps/substrate-*.service; do d=$(mktemp -d); u=$(basename $f); mkdir $d/$u.d; cp $f $d/; cp $f.d/*.conf $d/$u.d/; cp $f.d/30-sandbox.conf.example $d/$u.d/30-sandbox.conf; echo -n "$u "; systemd-analyze security --offline=true $d/$u --no-pager | tail -1; done
bun scripts/doctor-runtime.ts | tail -40; echo exit=$?   # unset: exposure rows ok; docker row ok/unknown
SUBSTRATE_EXPOSURE_MAX=5 bun scripts/doctor-runtime.ts >/dev/null; echo exit=$?   # 2 if any installed unit scores above 5 (all 8.1 today)
```
Expected offline scores: see the table (4.7 / 5.5 / 6.3, mcp 4.7). `bun scripts/doctor-units.ts --dry-run` is unaffected (reads `*.conf` only).

Transient startup tests (the orchestrator, NOT run by me): the `systemd-run` command in each example's header, one per unit.

## Operator steps

`docs/runbooks/vps-hardening.md`: transient test, copy, `daemon-reload`, restart, doctor, rollback = remove the file + reload + restart. Optionally set `SUBSTRATE_EXPOSURE_MAX` in the doctor drop-in once units are hardened.

## Deviations, limits, unknowns

- L1 proposed a CI `--threshold` gate; instead the offline ceiling lives in the test and `SUBSTRATE_EXPOSURE_MAX` only in the doctor.
- `RestrictNamespaces=true` is on for Class A and for muse, herdr, skills-sync, skills-bridge (nothing in their code unshares a namespace; for muse it is worth 0.8: 6.3 without, 5.5 with). It is OFF for dispatcher and host (Hermes sessions and the VM/sandbox lifecycle are unmeasured), which is why those two are 6.3.
- Not run (EDIT ONLY): `bun test`, `tsc`, formatter, `systemd-run`. The startup of each hardened unit is unproven here; scores are from the offline analyzer. `tsc` strictness of the new files is unchecked.
- `substrate-mcp` may need `ReadWritePaths=-/root/.config/gh -/root/.docker` (gh/docker client config writes under a read-only `/root`) — unmeasured, not shipped, documented in its header.
- `SystemCallArchitectures=native` assumes the host's bun/node/python3 are native (true on this x86-64 VPS by L1 evidence; not re-verified).
- The `sandbox` row reads only `/etc/systemd/system/<unit>.d/30-sandbox.conf`; an override elsewhere is not seen.
- `docker system df` size text is parsed as decimal units (docker's own); a future format change falls to `unknown`.

## Review round (P1 + P2s) — what changed

- **P1 skills-sync**: the base unit has no `StateDirectory=` and the example granted only `/root` paths, so `/var/lib/substrate` (skills-sync.ts:86, skills.ts:105-106, 90/100, 281-301, 372-377) was read-only under `ProtectSystem=strict`. The example now carries `ReadWritePaths=-/var/lib/substrate` (NOT `StateDirectory=substrate`: that would re-apply the default 0755 to the shared dir). Header "Writes:", the transient `-p` list / `test -w`, and the runbook row updated. Offline score unchanged (5.5).
- **State-dir mode incident**: every transient header command now uses `-p StateDirectory=u5-sandbox-test` + `test -w /var/lib/u5-sandbox-test` + an `rm -rf` line; the runbook says why. Units without a state dir (alert@, skills-sync) carry no `StateDirectory` property at all. Test asserts no header names `StateDirectory=substrate`/`StateDirectoryMode`, and that a throwaway dir is probed and removed.
- **P2 coverage test**: `scripts/sandbox-dropins.test.ts` "writable paths survive ProtectSystem=strict" builds each unit's writable roots from the base unit's (and `.conf` drop-ins') `StateDirectory=/LogsDirectory=/RuntimeDirectory=` plus the example's `ReadWritePaths=` and checks that every `/var/lib|/mnt` path in the unit's `Environment=`/`ExecStart=` and every entry of the code-derived `WRITES` table (below) is inside one. It would FAIL on the pre-fix skills-sync example: base has no `StateDirectory=`, the pre-fix example's roots were `/root/agent-skills /root/.claude ...`, so `/var/lib/substrate/skills/refresh-pending.json`, `/var/lib/substrate/phase4-baseline/projector/run` and `/var/lib/substrate/skills/projector-warned.json` are in no root; a second test re-runs the check on exactly that pre-fix shape and asserts all three are uncovered (and covered by the shipped example). Examples may not use `StateDirectory=`/`StateDirectoryMode=`.
- **P2 analyzer**: `gatherHardeningRows` no longer goes silent after one failure. Absent binary (spawn null) = one `systemd-analyze security` `unknown` row and stop; two failures at the start with no verdict ever read = one row and stop (verb missing); any other non-zero exit = that unit's own `unknown` row, next unit still analysed; cap `MAX_ANALYZER_CALLS`=64 with one row saying so. Tests: unit 1 ok / unit 2 exit 1 / unit 3 above ceiling = drift (exit 2); first unit fails but later verdicts still count; cap; no-verb = one row. Runbook and README sentences fixed.
- **P3 template**: the `@` skip moved below the sandbox block: `substrate-alert@.service` gets its `sandbox` row when its drop-in is installed, still no exposure row and no analyzer call (test).

## Unit → writable paths → source (post-fix audit)

| Unit | Writable under the example | Source |
| --- | --- | --- |
| mcp | `/var/lib/substrate` (base `StateDirectory=substrate`): audit chain, slo-checkpoint, skills/ (mirror, propose, ledger), desktop/, retain outbox, docs-ingest.json | config.ts:433,447,588,646; skills/propose.ts:36-41; desktop/driver.ts:406; unit Environment= |
| anchor | `/var/lib/substrate` (base `StateDirectory`); writes no file itself. Unmeasured: solana CLI under `/root/.config/solana` (read-only /root) | anchor-run.ts; ledger/src/solana.ts:88 |
| doctor | `/var/lib/substrate/doctor-last.json` (base `StateDirectory`) | doctor-runtime.ts DEFAULT_STATE_FILE |
| docs-canary | `/var/lib/substrate/docs-canary-last.json` (base `StateDirectory`) | docs-golden.ts:398,629 |
| index-sweep | `/var/lib/substrate` (base); writes no file | index-sweep-run.ts (no fs writes) |
| alert@ | nothing (no `StateDirectory`; `/tmp` private) | substrate-alert.ts (no fs writes) |
| collector-grok | `/var/lib/substrate/grok-offsets.json` (base) | collectors/src/grok.ts:32 |
| collector-herdr | `/var/lib/substrate/herdr-offsets.json` (base); `-/root/.config/herdr` listed for the socket dir | collectors/src/herdr-state.ts:90, herdr.ts:47-56 |
| collector-muse | `/var/lib/substrate/muse-offsets.json` (base); `-/root/src/repos` (AGENTS.md, `.git/info/exclude`) | collectors/src/muse.ts:38,220,310-331 |
| index-archive | `/var/lib/substrate` (base) + `/mnt/index-archive` (ReadWritePaths, no `-`) | index-archive.ts:422 |
| ledger-archive | `/var/lib/substrate` (base) + `/mnt/ledger-archive` (ReadWritePaths, no `-`) | ledger-archive.ts:434 |
| skills-sync | `-/var/lib/substrate` (ReadWritePaths; NO base StateDirectory), `-/root/agent-skills`, `-/root/.claude .grok .agents .config/muse .openclaw .cursor` | skills-sync.ts:86,225-267; skills.ts:83-106,281-301,372-377 |
| skills-bridge | `/var/lib/substrate` (base `StateDirectory`), `-/root/.hermes -/root/agent-skills -/root/.omp -/root/.grok` | miner/bridge.py:42-53 |
| dispatcher | `/var/lib/substrate` (base) + `/root` (git worktree metadata, Hermes HOME) | worktree.py:21-22,134-147; launcher.py:29,191 |
| host | `/var/lib/substrate` (base) + `-/root` (OAuth store, gh) | host/main.ts:64; sandbox-options.ts:12; mcp-proxy.ts:219-225 |

No unit declares `LogsDirectory=`/`RuntimeDirectory=`, and none writes `/var/log` or `/run` itself (stdout goes to the journal; mcp's `systemd-notify` child uses `NOTIFY_SOCKET`, a send, not a write to a path). `/tmp` is writable via `PrivateTmp=true`. Orchestrator's transient boot test (13/15 units start; the archive units fail 226/NAMESPACE only because the mounts do not exist here; a Class A MCP boot served /healthz and wrote its audit chain) is consistent with this table for bun's own caches. Remaining unmeasured: gh/docker client config under read-only `/root` (mcp), solana CLI config (anchor).
