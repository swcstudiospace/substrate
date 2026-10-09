# 30-N1-SPIKE: N1 stale-pixel spike (D30-18)

**Status: LIVE-GATED — NOT RUN.** The ladder below touches the live
`substrate-desktop` container (`docker exec` keystrokes plus captures) and is
therefore a live run. It was neither executed nor simulated; every verdict
field reads `NOT-RUN`. No title-based pass is recorded anywhere.

- `n1_reproduced=NOT-RUN`
- `capture_path=NOT-RUN`
- `settle_ms=NOT-RUN`
- `timings=NOT-RUN`
- `steal=NOT-RUN`

## Preconditions (verify before running)

- `substrate-desktop` exists, carries label
  `org.swcstudio.substrate.role=desktop`, is running, publishes only
  `127.0.0.1:6081->3000`, geometry `1280 800`
  (`sudo infra/desktop/substrate-desktop.sh status`).
- `recruitment-desktop` is inspect-only for the whole spike; no code path or
  command here names it beyond a before/after
  `docker container inspect --format '{{.Id}} {{.State.Status}} {{.State.StartedAt}} {{.State.FinishedAt}}'`
  comparison.
- Decode with the plan 30-01 `decodePng`; count exact-RGB pixels of the nonce
  triple (one channel at or above `0xC0`).

## Ladder (RESEARCH Spike plan, in order)

1. **As-ported path, 3 repeats:** one run `screenshot` →
   `key ctrl+alt+t` (settle 5000) → `type <marker>` (settle 1500, marker built
   with `String.raw` backslash-`\033` sequences plus a real trailing newline)
   → `screenshot` → `type "exit\n"`. Decode the returned image block, count
   exact-RGB band pixels, record pass/fail plus timings per repeat.
2. **If absent — timing:** a following `screenshot`-only run after 2 s and
   10 s. Band appearing later means the fix is a settle/second-capture inside
   the screenshot step (fixed argv, no new action kind).
3. **Stacking/map check:** compare X-server and window-manager stacking, map
   state and workspace for the fresh-vs-stale frames.
4. **Forced repaint:** `xrefresh` (present via x11-apps) then
   `xwd -root -silent`. Fresh pixels here mean the screenshot step becomes two
   fixed calls (`xrefresh`, short settle, `xwd`); add an `xrefreshArgv`
   builder to `actions.ts` plus builder-table and driver coverage. Never add
   an action kind, never change `DesktopRunInput` limits.
5. **September layout (optional, if step 1 passes):** open a second terminal
   so the new one centers over an existing one, then run the marker.
6. Record the verdict fields above per ladder step. If no capture path yields
   the band, the pixel clause is a gap, never passed on titles.

## Outcome for plan 30-06 task 2

No spike data exists, so no capture fix is warranted and none was applied:
`actions.ts`, `driver.ts` and their tests are unchanged by this plan. The
as-ported capture path stands until the ladder runs.
