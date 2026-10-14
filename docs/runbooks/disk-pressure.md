# Runbook — disk pressure on the substrate host

| | |
| --- | --- |
| Requirement | uplift-2 R7 (Build Plan BP-1, BP-2, A-5) |
| Trigger | `deploy-release.sh` refuses with `refusing to build: N GB free … below SUBSTRATE_DEPLOY_MIN_FREE_GB`; `df -h /` above 90 %; a unit logging `ENOSPC`; the rehearsal harness refusing to start |
| Measured | 2026-10-13: `/` 387 GB, **95 % used, 22 GB free**. Co-tenants: an operator checkout tree 126 GB, containerd 46 GB, docker 29 GB with ≈25 GB reclaimable. `/var/lib/substrate` 350 MB (rivetkit 318 MB, audit 3.4 MB). Source: `.planning/uplift-2/BASELINES.md` |
| Scope | What the substrate's own units and tooling put on the disk, and the order to reclaim it |
| Untouched | Other projects' containers, volumes and checkouts on the same host — named below only so they are not pruned by accident |

## What consumes the disk on this host class

Operator only, in an approved window. Every command below is read-only unless
it says otherwise. No command carries a credential, and nothing here touches a
production store.

| What | Where | Grows by | Reclaim |
| --- | --- | --- | --- |
| Release trees | `/opt/agent-substrate/releases/<sha>/` — a git archive plus `node_modules` each | one tree per deployed tag; a health-checked deploy keeps `current` and one `previous` and prunes the rest, a `SUBSTRATE_RELEASE_RESTART=0` publish prunes nothing | step 1 |
| Rivetkit / agentOS storage | `/var/lib/substrate/agentos/` (`RIVETKIT_STORAGE_PATH`), task and lease records beside it | per VM and task the host runs; 318 MB measured | not automatically; see step 5 |
| Audit chain | `/var/lib/substrate/mcp-audit.jsonl`, closed segments `mcp-audit.jsonl.<first>-<last>.jsonl`, `.checkpoint` | ≈0.9 MB/day measured; `SUBSTRATE_AUDIT_ROLLOVER_BYTES` bounds each file, never the total | **never pruned** — `docs/mcp-audit.md` |
| Collector state | `/var/lib/substrate/*-offsets.json`, miner bridge log and held state | a few KB | no |
| Desktop screenshots | `/var/lib/substrate/desktop/<run_id>/` | per `desktop_run` | step 5, with the owner |
| Docker images, build cache, stopped containers | `/var/lib/docker` | sandbox images the host pulls, rehearsal images (`postgres:16-alpine`, `greptime/greptimedb`), image layers from builds | steps 2–3 |
| Docker volumes | `/var/lib/docker/volumes` | **other projects'** stateful containers live here too | step 4, with care |
| Journal | `/var/log/journal` | every unit logs to the journal; `substrate-dispatcher` reached `NRestarts=114888` once and the journal paid for it | step 6 |
| Operator checkouts | `/root/src/repos/…` | not the substrate's to prune | out of scope |

Read the picture first:

```sh
df -h /
du -xsh /opt/agent-substrate/releases/* /var/lib/substrate/* 2>/dev/null | sort -h
docker system df
journalctl --disk-usage
ls -la /var/lib/substrate/mcp-audit.jsonl*
```

## Safe reclaim order

Each step is its own decision. Stop when `df -h /` is above the floor you need.

1. **Old release trees.** The deploy script already keeps only `current` and
   `previous` after a health-checked deploy, so an ordinary health-checked
   deploy of the current tag is the reclaim:

   ```sh
   readlink /opt/agent-substrate/current /opt/agent-substrate/previous
   ls /opt/agent-substrate/releases
   # Re-deploy the tag current points at. The tree is already built, so this
   # restarts the units, health-checks, and prunes every other release directory.
   infra/vps/deploy-release.sh <current tag>
   ```

   Never `rm -rf` a release directory by hand while a unit may be running from
   it; `readlink /proc/<MainPID>/cwd` for each `substrate-*` unit names the tree in
   use. If the disk is *already* below the deploy floor, the deploy refuses
   before it prunes — reclaim with steps 2–3 first, or run that one deploy with
   `SUBSTRATE_DEPLOY_MIN_FREE_GB=0` (the tree is built, so nothing new is written).

2. **Dangling and unused Docker images.** Sandbox and rehearsal images are
   pulled again on demand (`ensureImagePulled`).

   ```sh
   docker image ls
   docker image prune -a      # every image not used by a container; asks first
   ```

3. **Docker build cache.**

   ```sh
   docker builder prune       # dangling build cache; add -a for all of it
   ```

4. **Docker volumes — with the warning.** `docker volume prune` removes every
   volume **not attached to a container**, and this host runs other projects'
   containers whose data may live in volumes that are only attached while they run.
   List first, and remove by name:

   ```sh
   docker volume ls
   docker volume ls --filter dangling=true
   # Only after reading the list, and only the volumes you can name:
   docker volume rm <name>
   ```

   Do not run `docker volume prune` on this host without the owner of every other
   project on it in the window. The substrate itself keeps no Docker volume; the
   rehearsal harness removes its own on `rehearsal down`.

5. **`/var/lib/substrate` contents, with their owners.** Rivetkit storage under
   `agentos/` belongs to `substrate-host` and holds VM state and task records for
   prompts that may resume on the next boot; stop the unit before touching it and
   decide per task record. Desktop screenshots are evidence of a `desktop_run`;
   remove a run directory only once nobody needs it. **The audit chain is never
   reclaimed**: every segment is part of one chain, and `bun run audit:verify`
   reports a removed one as missing history. If the audit directory itself is the
   problem, the answer is moving the segments to larger storage with the service
   stopped, not deleting them.

6. **Journal.**

   ```sh
   journalctl --disk-usage
   journalctl --vacuum-size=500M      # or --vacuum-time=14d
   ```

## The floors

| Floor | Value | Where |
| --- | --- | --- |
| Deploy floor | `SUBSTRATE_DEPLOY_MIN_FREE_GB`, default **5 GB** free on the release filesystem, checked before `build_release`; `0` disables | `infra/vps/deploy-release.sh` |
| Rehearsal floor | **2 GiB** free on Docker's data root (`DISK_FLOOR_BYTES`) and 64 MiB on the run directory; the harness refuses below either and never prunes | `scripts/rehearsal.ts` |
| Sandbox floor | **10 GiB** free on `/` (`DISK_FLOOR_BYTES`, D31-07) before any image build or pull; unreadable `df` refuses too | `packages/host/src/sandbox-provider.ts` |

A deploy refused by the floor has written nothing: no tree, no symlink, no
restart. Reclaim, then run the same command again.

The runtime doctor prints one report-only `docker reclaimable` row (`docker system df`, ten-second bound) so the Docker share of the disk is visible next to the root-disk row; it is the engine's space, mostly not substrate's, and the doctor never prunes it (steps 2-4 stay the operator's).

The runtime doctor reports the deploy reserve before a deploy trips over it:
`bun scripts/doctor-runtime.ts` (`infra/vps/README.md`, "Runtime doctor")
reads `df -Pk /opt/agent-substrate` and prints a `disk` row — `drift` below
`SUBSTRATE_DEPLOY_MIN_FREE_GB`, `warn` below twice it (a release tree plus its
`node_modules` is what takes it the rest of the way), `ok` above. Its `swap`
row says whether the host is paging right now, with the occupancy in the hint.
With `substrate-doctor.timer` installed and `SUBSTRATE_DOCTOR_EMIT=1`, a
`disk` drift arrives on the ledger as one `warning` event, re-sent only when
the drift set changes.

Since uplift-4 S3 the same doctor run also reports, report-only, what could be
reclaimed and by whom: `releases unique bytes` (hardlinks counted once, so a
release is charged only the bytes the newer ones do not share — a plain `du` per
tree overstates the older one, because release trees share one `node_modules`),
`state child …` rows with age (the newest mtime inside a directory, depth 2, at most
200 entries, not the directory's own timestamp) and owner, `journal size` and `audit chain size` with its
average daily growth, against `SUBSTRATE_RETAIN_RELEASE_MAX_GB` (default 6),
`SUBSTRATE_STATE_MAX_GB` (default 1) and `SUBSTRATE_JOURNAL_MAX_MB` (default
400). Over budget adds `would-reclaim …` rows that name bytes and delete nothing,
only for a `phase<N>-baseline` directory with nothing recent inside it — every
path the units write under `/var/lib/substrate` (skills, dispatcher, worktrees,
transcripts, miner, offsets, checkpoints, outboxes, canary and docs state) is
live and never listed, and a name nobody owns shows as `unknown owner`;
the audit chain is never listed. `infra/vps/deploy-release.sh --dry-run` prints
the release directories a health-checked deploy would prune, in both cases: a
redeploy of the current tag keeps `current` and `previous`; the next deploy of a
new tag keeps only the present `current`, so the present `previous` is listed as
removable after it, with its unique bytes. A row that says `N more not measured`
is a lower bound, never `ok`. The journal
cap itself, `infra/vps/journald-substrate.conf` (`SystemMaxUse=400M`), is an
operator-installed drop-in (`infra/vps/README.md`, "VPS runtime hardening"); step
6 above stays the manual vacuum until it is installed.

## Prevention already in place

- the deploy prunes to `current` + `previous` after every health-checked deploy;
- `SUBSTRATE_AUDIT_ROLLOVER_BYTES` keeps any single audit file bounded so a
  move to larger storage is a move of files, not of one growing file;
- the loopback redis takes no snapshots (`infra/vps/redis-substrate.conf`:
  `save ""`, `appendonly no`), so the cache never writes the disk;
- `substrate.slice` and the per-unit `MemoryMax` keep an unbounded process from
  pushing the host into swap, which is the other half of the same pressure.

## What to record

One row per window, newest last. Hosts and values only; never a credential.

| Date (UTC) | Trigger | `df -h /` before → after | Steps taken | Deploy floor at the time |
| --- | --- | --- | --- | --- |
| 2026-10-13 (baseline, no window) | measurement for uplift-2 | 95 % used, 22 GB free → — | none | 5 GB (introduced this wave) |
