# 30-N1-SPIKE: N1 stale-pixel spike (D30-18)

**Status: LIVE-RUN — as-ported capture fresh 3/3, `n1_reproduced=false`, no
capture fix.** The historical NOT-RUN record from 2026-10-09 is kept verbatim
below; current live evidence follows first. No title-based pass is recorded
anywhere: every verdict below counts exact-RGB pixels.

## Current live evidence (parent live run, worktree rev `4df30a0`)

- `n1_reproduced=false`
- `capture_path=as-ported-xwd-root` (`xwd -root -silent`, unchanged port)
- `fresh_as_ported=true` — 3/3 repeats passed, so no capture-path fix is
  warranted and none was applied: `actions.ts`, `driver.ts` and their tests
  are unchanged by this plan.
- Marker repeats (fresh nonce per repeat; terminal settle 5000 ms, type
  settle 200 ms; owned terminal closed after each repeat):

  | repeat | nonce RGB | baseline px | marker px | solid | rect | duration |
  | --- | --- | --- | --- | --- | --- | --- |
  | 1 | 201,147,232 | 0 | 9120 | true | 480x19 at (2,117) | 6318 ms |
  | 2 | 18,119,233 | 0 | 9120 | true | 480x19 at (2,117) | 6281 ms |
  | 3 | 18,192,95 | 0 | 9120 | true | 480x19 at (2,117) | 6306 ms |

- Per-call fixed-argv samples (program, wall ms, host steal %; every call
  exit 0; steal from `/proc/stat` aggregate steal/total delta sampled
  before/after every fixed argv call):
  `xdotool` 123/2.02, `xwd` 284/6.03, `xdotool` 184/5.30,
  `xdotool` 669/1.30, `xwd` 162/1.53, `xdotool` 124/2.06,
  `xwd` 140/3.57, `xdotool` 137/2.78, `xdotool` 704/4.56,
  `xwd` 155/1.67, `xdotool` 122/0, `xwd` 147/1.75, `xdotool` 125/0,
  `xdotool` 711/4.82, `xwd` 170/9.15, `xdotool` 141/7.02.
  Steal stays 0–9.15%, far below September's ~70% — consistent with fresh
  frames, not a stale-pixel regime.
- Cleanup: every owned terminal closed (the closing `exit` typed at each
  repeat end); the dedicated `substrate-desktop` container left running;
  the unrelated desktop untouched (no create/start/stop/rename).
- First full smoke on this evidence reads **18/20 FAIL**, not a pass: the
  pixel, event, audit, refusal, 401 and status checks all passed (marker
  9120 px, 2 image blocks, 5/5 hash-only ledger rows, unlisted 5→5 events,
  tokenless MCP 401, webtop 401, 2 audit records) and only the two
  `recruitment-desktop` inspect checks failed — the unrelated desktop is
  absent here and the old null-on-error inspect conflated absence with
  probe failure. The corrected snapshot rerun is parent-owned and pending.

## Historical record (2026-10-09 — NOT-RUN, kept verbatim)

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

## Outcome for plan 30-06 task 2 (historical — written with no data)

No spike data exists, so no capture fix is warranted and none was applied:
`actions.ts`, `driver.ts` and their tests are unchanged by this plan. The
as-ported capture path stands until the ladder runs.

## Current outcome for plan 30-06 task 2 (live evidence above)

The ladder ran live after the historical record: step 1 passed 3/3 fresh as
ported (9120 px, baseline 0, solid 480x19 each repeat), so steps 2–4 were
not needed and step 5 did not apply. No capture fix is warranted and none
was applied: `actions.ts`, `driver.ts` and their tests remain unchanged by
this plan — the fresh-as-ported branch of the task, now with evidence
instead of a NOT-RUN note.
