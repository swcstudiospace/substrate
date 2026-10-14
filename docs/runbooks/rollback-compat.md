# Runbook — what a rollback restores, and what it leaves behind

| | |
| --- | --- |
| Requirement | uplift-5 S1a (release assurance; Build Plan A-5 deploy rollback) |
| Trigger | `deploy-release.sh rollback`, or the automatic restore after a failed health or store check; before rolling back past uplift 3 or 4 |
| Reference release | `9231f43`, production when uplifts 3 and 4 were merged |
| Scope | The persisted shapes an older release reads that a newer release also writes |
| Untouched | Every store's data. Nothing here deletes, migrates or rewrites anything |

## What `rollback` restores

`deploy-release.sh rollback` swaps the `current` symlink back to `previous`, runs `systemctl daemon-reload`, restarts the four release units, waits `SUBSTRATE_UNIT_SETTLE` seconds and health-checks again. A failed deploy runs the same restore by itself. **That is the whole of it: code.**

It does not restore, and nothing in `deploy-release.sh` ever touches:

- unit files, drop-ins and `substrate.slice` under `/etc/systemd/system`: copying them is an operator step in both directions, and a reload only re-reads what is installed;
- `/etc/substrate/*.env`;
- state files under `/var/lib/substrate`;
- cache values in the loopback redis;
- ledger tables, Postgres tables and the remote Hindsight and RAGFlow state.

`previous` is also the only older tree kept: `readlink /opt/agent-substrate/previous` names the release a rollback returns to. Any deploy that replaces a non-empty `current` points `previous` at it, whether or not it restarted (`SUBSTRATE_RELEASE_RESTART=0` only skips the restart, health and store checks, and the prune). Only the very first deploy on a host leaves no `previous`, and `rollback` then exits with `no previous release`.

## What stays after a rollback to `9231f43`, and why the older release tolerates it

Each row names the check that pins it. The tests do not run `9231f43` (its source is not in this tree); they hold the new writers' real output to a frozen copy of what the old readers require, cited by old `file:line`, and feed old-shape fixtures (`fixtures/rollback-9231f43/`) to the new readers.

| What stays | Written by | What `9231f43` does with it | Pinned by |
| --- | --- | --- | --- |
| `docs-ingest.json`, with the optional members `triggers` and `lag` | uplift-4 S7 | Still `version: 2`. Its `loadIngestRecords` reads only `records` and `versions` (`docs-ingest.ts:563-594`) and ignores the rest. Its next save rewrites the file **without** `triggers` and `lag`: the accepted merge-triggers and the lag dedupe are forgotten, and a lag warning may fire once more after the roll-forward. No record, pin or version is lost | `rollback-compat.test.ts`, "docs state file": the real `saveIngestRecords` output meets every old requirement and adds only `triggers` and `lag`; a file stripped of them loads; a `9231f43` file loads whole and survives a save |
| `retain-outbox.jsonl` | `RetainOutbox` | Unchanged since `9231f43` (`git diff 9231f43 HEAD -- packages/mcp-server/src/retain-outbox.ts` is empty). Parked retains are read back by the same `isEntry` check | `rollback-compat.test.ts`, "retain outbox": real enqueue and drain output meets the old line requirements and adds no key; an old file is hydrated and rewritten in a shape the old reader accepts |
| `brief-snapshot` values in redis | uplift-4 S1 and S4 | The envelope gains `sections` and `until`; `text` and `at` keep their meaning. The old `shapeOk` checks only `text` and `at` as strings (`cache.ts:625-628`), and the key is unchanged at default flags, so the old release serves the new snapshot's `text` when a live source is down | `rollback-compat.test.ts`, "brief-snapshot envelope": the stored key equals the frozen old key; the envelope satisfies the old check; a `9231f43` envelope is served as the snapshot by the new code |
| `brief` values in redis | uplift-4 S1 | Stored under a key that includes `shape: "sections-v1"`, so `9231f43` never looks it up. The old `brief` check is only "is a string" (`cache.ts:624`), and the new value is a JSON string: **without that key separation the old release would answer with a JSON document as the brief** | the same file, "the sections-encoded `brief` entry is never under a key `9231f43` reads" |
| `recall-snapshot` values in redis | uplift-4 S5 | A cache class `9231f43` has no code for: nothing asks for those keys, they expire by their own TTL (`SUBSTRATE_BRIEF_RECALL_TTL_S`) | not pinned: no old reader exists to test |
| `slo-checkpoint.json` | uplift-3 N2 | No reader: `git grep -n -i "slo-checkpoint\|SLO_CHECKPOINT" 9231f43` is empty. The file waits for the next release that has one, which restores it under its own version check | `scripts/deploy-preflight.ts` flags a file written by a newer version before a roll-forward |
| `event-spool.jsonl` | the collector event spool, present only on a release that ships it and has it enabled | No reader in `9231f43` (`git grep -n event-spool 9231f43` is empty), so the file is inert after a rollback. Entries wait for the next release that has the spool; the old one never replays them | `scripts/deploy-preflight.ts` parses it when it is there |
| `metric_samples` ledger table | uplift-4 S6, only under `SUBSTRATE_METRICS_HISTORY=on` | Never read or written by `9231f43`; the ledger's own TTL ages the rows out. A rollback does not drop it | not pinned: no old reader exists |
| Index (Postgres) | | **No new table or column** between `9231f43` and this tree (`git diff 9231f43 HEAD -- packages/mcp-server/src/index-store.ts` adds no `add column` and no `create table`). The one persistent change is opt-in: `SUBSTRATE_INDEX_TUNE=apply` sets `fillfactor` and the autovacuum scale factor on `graph_nodes`. They are storage parameters the old code never reads | n/a. If the tune was applied and the operator wants it gone: `alter table graph_nodes reset (fillfactor, autovacuum_vacuum_scale_factor)`, an operator statement; nothing in the code runs it |
| Ledger events | uplifts 3 and 4 | Ordinary rows of the closed vocabularies (`EVENT_KINDS`, `SURFACES` did not change between the two commits); new signals are `note` or `warning` events with a `payload.action` discriminator | n/a |
| Audit chain, collector offsets, skills and projector state | | The packages that write them have no change between `9231f43` and this tree (`git diff 9231f43 HEAD --stat -- packages/audit packages/collectors packages/projector packages/host packages/ledger` is empty) | n/a |
| Unit files and drop-ins | the operator | Whatever is installed stays installed. Ceilings (`MemoryHigh`, `MemoryMax`, `MemorySwapMax=0`, `TasksMax`, `CPUQuota`) and `substrate.slice` are unit settings the old code does not care about. **Two things are the exception: the watchdog drop-in (it stops the old release from starting) and the installed archive, docs-canary and doctor timers (their entries do not exist in the old tree, so they fail on every run)**; both are below | `scripts/deploy-preflight.ts` reports drift between the release's unit and the installed one before a deploy; the entry check is the table below |

## Installed units that a rollback to `9231f43` breaks

A rollback swaps the code under every unit's `WorkingDirectory`. A unit whose `ExecStart` names a file or subcommand the old tree does not have fails on every run until it is disabled. Every `ExecStart` in `infra/vps/` was checked against `git show 9231f43:<entry>`:

| Unit | `ExecStart` entry | In `9231f43`? | After a rollback |
| --- | --- | --- | --- |
| `substrate-mcp.service` | `packages/mcp-server/src/index.ts` | yes | runs. **Except with the watchdog drop-in, below** |
| `substrate-collector-{grok,herdr,muse}.service` | `packages/collectors/src/{grok,herdr,muse}.ts` | yes | runs |
| `substrate-anchor.service`, `substrate-index-sweep.service`, `substrate-skills-sync.service` | `anchor-run.ts`, `index-sweep-run.ts`, `packages/projector/src/skills-sync.ts` | yes | run |
| `substrate-host.service` | `packages/host/src/main.ts` | yes | runs |
| `substrate-dispatcher.service`, `substrate-skills-bridge.service` | `python3 -m substrate_dispatcher`, `-m substrate_miner bridge --once` | both modules exist (`__main__.py`) | run; the bridge's `--once` flag is not checked |
| `substrate-index-archive.service` (+ timer) | `packages/cli/src/index.ts index archive` | the file, **no**: `cmdIndex` accepts only `sweep` (`git show 9231f43:packages/cli/src/index.ts`, `function cmdIndex`) | **fails every night** (exit 2, usage) |
| `substrate-ledger-archive.service` (+ timer) | `packages/cli/src/index.ts ledger archive` | the file, **no**: the old CLI has no `ledger` command | **fails every night** |
| `substrate-docs-canary.service` (+ timer) | `scripts/docs-golden.ts` | **no** | fails every run |
| `substrate-doctor.service` (+ timer) | `scripts/doctor-runtime.ts` | **no** | fails every run |
| `substrate-alert@.service` (installed with the watchdog drop-in) | `scripts/substrate-alert.ts` | **no** | fails when triggered; it is triggered only through the watchdog drop-in, which is removed |

These failures never touch the substrate's data or the serving unit; they are noise (and `OnFailure=` chains where installed) until the timers are disabled. The archive timers matter most: a failed run writes no archive, so the off-box archive stops growing for as long as the rollback lasts. Disable them as the pre-rollback step below says, re-enable them after the roll-forward.

## The watchdog drop-in blocks a rollback past `watchdog.ts`

`watchdog.ts` (the release that introduced `/livez`) is not in `9231f43`. With `20-watchdog.conf` installed the unit is `Type=notify`, `9231f43` never sends `READY=1`, `TimeoutStartSec=60` kills it and `Restart=always` loops: a rollback to `9231f43` with the drop-in present **never serves**. Before rolling back to a release without `watchdog.ts`:

```sh
rm -f /etc/systemd/system/substrate-mcp.service.d/20-watchdog.conf
```

Remove only the drop-in; `deploy-release.sh rollback` runs the `daemon-reload` and the restart itself. Reinstall it after the roll-forward, following the "Hang detection" steps in `infra/vps/README.md`.

## Rolling back to `9231f43`

Operator only, in an approved window.

1. `readlink /opt/agent-substrate/previous` names the tree you are returning to. If it is not `9231f43…`, stop: this runbook's table is about that release.
2. If the watchdog drop-in is installed, remove it (section above).
3. Disable every installed timer whose entry the old tree lacks (section above): `systemctl disable --now substrate-index-archive.timer substrate-ledger-archive.timer substrate-docs-canary.timer substrate-doctor.timer` (ignore "not loaded" for a timer that was never installed). A timer fired between the swap and this step fails once and is harmless; it fails every run until disabled.
4. `deploy-release.sh rollback`. Exit 0 means the old release answered `/healthz` and every unit stayed up through the settle window. The stores are **not** re-gated on a rollback, on purpose: with the stores down a rollback must still be possible.
5. From the checkout, not from `current`: `bun scripts/doctor-runtime.ts` (read-only). Drift it reports against the newer unit files is expected until the units are reinstalled; it is not a rollback failure.
6. To go forward again: `systemctl enable --now` the timers you disabled in step 3 (and reinstall the watchdog drop-in), then `deploy-release.sh <tag>`. Its preflight reads the files the old release wrote — the parts the old release may have rewritten are in the table above.

## What this does not prove

- The old code is never executed. The frozen requirements were read from `git show 9231f43:<path>` and cite the old lines; if the old reader tolerates more than the contract states, the tests are stricter than needed, and if it demands something they did not capture, they are blind to it. Each requirement's citation is in the test, and a test per requirement proves it fires by deleting that key from the real output.
- Only the persisted shapes in the table were enumerated. A shape added later, or one this review did not find, has no test until someone adds one: add it to `rollback-compat.test.ts` with the old `file:line` that reads it.
- Cache values are tolerated because the old release treats an unusable one as a miss; the cost of a miss is a live recompute, not an error. Whether the old release is fast enough on a cold cache under load is not tested.
- `rollback` restores the code; a rollback that fixes a bad unit setting needs the operator to reinstall the old unit file as well.
