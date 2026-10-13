# N2 — Restart-durable SLO history, capacity runway and ledger-native notifications (summary)

## What changed

- **`packages/observability/src/checkpoint.ts`** (new). The versioned SLO checkpoint: `{v: 1, epoch, writtenAt, since, metrics[], planes, burn, capacity, notify}`. `snapshotCheckpoint(instruments, planes, burn, epoch, {since, capacity, notify, now})` copies every merged counter/histogram point with attributes plus the plane buckets, burn samples, capacity ring and the notifier's last state per objective; `restoreCheckpoint(json)` refuses anything over 4 MB before parsing, narrows by hand (`CheckpointError` names the field), and cuts every ring to its cap keeping the newest. `checkpoint.test.ts` (new).
- **`metrics.ts`**: each instrument has a `prior` layer seeded from a checkpoint (`Counter.seed`, `Histogram.seed`, `MetricRegistry.seed`) and every snapshot is `prior + live`. Seeding replaces the layer — restoring the same file twice cannot double-count — and a histogram whose bounds moved, or a metric the release no longer records, is skipped and its name returned. **`slo.ts`**: `PlaneWindow` takes prior buckets and exports them; `PlaneCountSample` exported; `runwayDays` threshold; new capacity section (`CapacityRing`, `evaluateCapacitySlos`). **`burn.ts`**: `BurnLedger` takes prior samples and exports them; `BURN_MAX_SAMPLES` exported. **`config.ts`**: `SUBSTRATE_SLO_RUNWAY_DAYS`, `SUBSTRATE_INDEX_VOLUME_BYTES`.
- **`packages/mcp-server/src/observe.ts`**: at construction the checkpoint at `config.sloCheckpointPath` is read synchronously; the registry starts at the history's `since` (so `/metrics.startedAt` and the OTLP start time cover what the points cover), instruments/windows/ledger/ring/notify map are seeded, `epoch = prior + 1`. A missing file is silent; a corrupt, oversized or unreadable one is **one** boot warning (`degraded — slo checkpoint … starts fresh`). `checkpoint()` writes `<path>.part` then renames, one write in flight, failures logged once per reason, > 4 MB refused; `start()` schedules it every `SUBSTRATE_SLO_CHECKPOINT_S`; `index.ts` awaits it on `SIGTERM` inside the existing 2 s flush bound. New: `evaluateBurn()` (the burn ledger is now the observability's own rather than the module-shared one, which is what makes it restorable), `evaluateCapacity()`, `history()`, `notifyRecords`, observer `capacity`.
- **`server.ts` `/slo`**: `breached` = catalogue + plane + burn breaches (that order; per-array detail unchanged; admission/docs/capacity still not folded in); new `capacity` array and `history: {epoch, since, checkpointAt}`. **`service.ts`**: `health()` reports each in-time index size read through `observer.capacity`.
- **`slo-notify.ts`** (new): `SloNotifier` judges catalogue + planes + burn + capacity + breaker snapshots every `SUBSTRATE_SLO_NOTIFY_S`; a condition (`breached`, or breaker `open`/`half-open`) held for `SUBSTRATE_SLO_NOTIFY_SUSTAIN_S` → one `warning` via `Substrate.emit` as `substrate` with `payload {action: "slo.transition", runtime: "slo", objective, state, observed, target}`, summary ≤ 200 chars, `session_id: "slo:notify"`; the condition clear for the same sustain → one `note` with `state: "recovered"`. The last emitted state per objective is `Observability.notifyRecords`, saved in the checkpoint, so a restart never re-emits. Optional `SUBSTRATE_SLO_WEBHOOK_URL` POST of the same payload (+ `summary`, `at`), 5 s, one attempt, failures logged once per reason without the URL. Whole notifier behind `SUBSTRATE_SLO_NOTIFY=1`. `slo-notify.test.ts` (new).
- **`config.ts`** (mcp-server): `sloCheckpointPath` (`SUBSTRATE_SLO_CHECKPOINT`; unset → `/var/lib/substrate/slo-checkpoint.json` only when that directory exists, asked of a `directoryExists` probe that only `index.ts` supplies; `off`/relative → disabled, relative named at boot by `sloConfigWarnings`), `sloCheckpointS`, `sloNotify`. `loadConfig(env, probes)`.
- **`event-sources.ts`** + **`docs/event-vocabulary.md`**: `slo.transition` (warning) and `slo.recovered` (note) rows; `slo.transition` action and `slo` runtime added to the rules text.
- **`docs/observability.md`**: "History across restarts", "Capacity runway", "Notifications" sections; routes and configuration tables. **`docs/runbooks/substrate-red.md`**: step 3 reads `history`/`capacity`, and a table of the warning events an operator will see.
- **`slo-history.test.ts`** (new): the real-socket restart harness. `http.test.ts`: one stale comment on `breached`.

## Flags and defaults

| Flag | Default | Effect |
| --- | --- | --- |
| `SUBSTRATE_SLO_CHECKPOINT` | `/var/lib/substrate/slo-checkpoint.json` when the directory exists (deployed host), else disabled | where the checkpoint is restored from and written to |
| `SUBSTRATE_SLO_CHECKPOINT_S` | `60` | write cadence; `0` = shutdown only |
| `SUBSTRATE_INDEX_VOLUME_BYTES` | unset | runway stays `insufficient-data` with the reason until set |
| `SUBSTRATE_SLO_RUNWAY_DAYS` | `14` | runway floor |
| `SUBSTRATE_SLO_NOTIFY` | unset | nothing scheduled; `1` schedules the evaluator |
| `SUBSTRATE_SLO_NOTIFY_S` | `60` (floor 5) | evaluation cadence |
| `SUBSTRATE_SLO_NOTIFY_SUSTAIN_S` | `300` | hold time both ways |
| `SUBSTRATE_SLO_WEBHOOK_URL` | unset | one bounded POST per transition |

Unconditional visible changes: `/slo` gains `capacity` and `history`; `/slo.breached` lists plane and burn breaches after the catalogue's.

## Skipped on purpose

`index.pool.wait_p95`: `IndexStore` measures nothing about pool acquisition — `grep wait|acquire` in `index-store.ts` finds only statement timeouts (`withTimeout`, `INDEX_PING_TIMEOUT_MS`) and the plane gate's per-statement duration, not the time a caller waits for a connection. The row is not invented from a number that is not measured; it needs a pool-acquire timing seam first.

## Design notes

- The capacity ring lives in `observe.ts` (`CapacityRing` from the observability package) and `service.ts` feeds it through the observer port, the same way brief/emit/plane samples travel — the checkpoint is owned by `observe.ts`, so the ring is where the checkpoint is.
- Recovery is a `note`, not a `warning` (vocabulary rule: success is `note`), so there are two rows in `event-sources.ts` sharing the `slo.transition` action.
- The sustain applies to recovery as well as to breach, so an objective on its threshold cannot pair events every minute.
- Without a checkpoint path a restart re-announces a standing breach after one sustain; documented.

## How it is measured

After deploy: `curl -s 127.0.0.1:7410/slo | jq '{history, breached, capacity}'` → `history.epoch ≥ 2` once the unit has restarted once, `results[].samples` not reset by the restart, `/metrics.startedAt` equal to `history.since`; `ls -l /var/lib/substrate/slo-checkpoint.json` moving every minute and no `.part` left behind; with `SUBSTRATE_INDEX_VOLUME_BYTES` set, `capacity[0]` leaves `insufficient-data` after 24 h of `/healthz` polling. With `SUBSTRATE_SLO_NOTIFY=1`, `POST /events/query {"surface":"substrate"}` shows one `warning` per sustained breach and one `note` per recovery, none repeated across restarts.

## Rollback

Unset `SUBSTRATE_SLO_NOTIFY` (or leave unset) and `SUBSTRATE_SLO_CHECKPOINT=off` restore today's behaviour at runtime except the two unconditional `/slo` additions. Code: delete `checkpoint.ts`, `slo-notify.ts`, `slo-history.test.ts`; drop the prior layer from `metrics.ts`, the prior/export seams from `PlaneWindow`/`BurnLedger`, the capacity section from `slo.ts`, the N2 block from both `config.ts` files, the N2 fields from `observe.ts`/`server.ts`/`service.ts`/`index.ts`, the two rows from `event-sources.ts` + `docs/event-vocabulary.md`. On the host: `rm /var/lib/substrate/slo-checkpoint.json`.

## Gates

pending orchestrator
