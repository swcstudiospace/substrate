# 23-03 SUMMARY — Mirror hooks on lease decisions

Wave 3 (MIRROR-02/03/05 wiring). Commit `feat(23-03)` on `gsd/v1.3-p23-claim-mirror`.

## What landed

- `index-store.ts` — reaper CTE select list gains `linear_issue_id` and
  `notion_page`; reaped rows carry both (live test, PG-gated). No new write
  method; `:732` rule intact.
- `service.ts`:
  - `stores` seam gains `mirror?`; production builds via `createMirror`
    when either tracker key is set, else null.
  - `runMirror` helper: awaits the op inside the tool call, converts each
    `MirrorFailure` to one `mirror.failed` warning (surface = holder, session
    = holder session, graph + node, payload `{action:"mirror", target, op,
    reason}`, repo null), and converts a throwing mirror into one warning —
    the lease decision never changes.
  - `claimNode`: mirrors only `granted` verdicts with action
    granted|reclaimed|stolen (renewed/denied/ledger-revoked: zero calls).
  - `releaseNode`: mirrors released→`release`, forced→`force` reading the
    holder off the decision; noop/refusals: zero calls; `alsoSetState`
    (completeNode's fenced completion) skipped — 23-04 owns it.
  - `reapExpiredLeases`: each reaped lease mirrors as `expired` with CTE refs.
- `index.ts` — `[substrate] mirror: linear on|off, notion on|off` once at
  startup from key presence (verified live: off/off without keys, on/on with).
- Tests: 10 new hook tests in `service.test.ts` (allowlist, evicted holder,
  completion-path skip, throw-vs-failure warnings, reap refs); live CTE test.

## Evidence

- `bun test service index-store.lease server mirror` — 187 pass, 31 skip
  (live-PG tests skip without `SUBSTRATE_TEST_PG_URL`), 0 fail.
- `bunx tsc --noEmit` — clean.
- Startup line verified by booting the entry with/without keys on :7419.

## Notes for later waves

- `completeNode` still runs main's path; the gated branch + `close`/`done`
  mirror wiring arrive in 23-04 (the `alsoSetState` skip is its seam).
- `mirror.failed` sample `op:"comment"` drift still open → 23-06.
