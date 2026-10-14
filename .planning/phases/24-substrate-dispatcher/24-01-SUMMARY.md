# 24-01 Summary: Dispatcher foundation (kill switch, flock, Linear poll, markers)

## Objective
Stand up `packages/dispatcher` (Bun, zero dependencies) with the DISP-01 /
DISP-02 foundation: kill-switch re-read defaulting to disabled,
process-lifetime flock, Linear candidate poll, and once-only marker comments.

## Files
- `packages/dispatcher/package.json` — name `@substrate/dispatcher`, type
  module, `bun test` script, no dependencies.
- `packages/dispatcher/src/kill-switch.ts` — `isDispatchDisabled(envFile)`
  re-reads the dispatcher env file on every call; runs only when
  `SUBSTRATE_DISPATCH_DISABLED` is exactly `0`/`false`/`no`
  (case-insensitive). Absent file, absent var, empty, `1`/`true`/`yes`, and
  garbage all mean disabled. `process.env` is never consulted.
- `packages/dispatcher/src/kill-switch.test.ts` — tmp env files only; pins
  absent/empty/1/true/yes as disabled, `0`/false/no as enabled, and re-read
  visibility without restart.
- `packages/dispatcher/src/lock.ts` — `acquireDispatcherLock(lockPath)`
  holds `flock(2)` `LOCK_EX|LOCK_NB` via `bun:ffi` on Linux libc, copying the
  rehearsal constants; busy lock returns `held: false`; idempotent release.
- `packages/dispatcher/src/lock.test.ts` — tmp lock paths only; second
  holder does not enter, release re-arms, default path constant pinned to
  `/var/lib/substrate/dispatcher.lock` (never created by tests).
- `packages/dispatcher/src/linear-poll.ts` — `DISPATCH_OUTCOMES` (eleven
  DISP-02 tokens), `markerBody` (`substrate-dispatch: <outcome>`),
  `classifyIssue` (exactly one `dispatch:<surface>` with a known `SURFACES`
  entry), `hasMarkerComment`/`ensureMarkerComment` (page comment bodies to
  the end, exact-line match), `removeDispatchLabels` (`removedLabelIds`
  only, `dispatch:` names only), `collectCandidates` (cursor paging split).
  Structural `PollingClient` interface with a compile-time pin that the real
  `LinearClient` satisfies.
- `packages/dispatcher/src/linear-poll.test.ts` — stub-fetch fake (no live
  Linear): multi-page poll asserting no query selects title/description,
  cursor fields pinned, 21+-comment seeds proving once-only past any fixed
  window, canary title never in any comment body, additive-only label
  removal.
- `packages/mcp-server/src/linear.ts` — added `DispatchCandidate` /
  `DispatchCandidatePage` and one `listUnstartedIssues(after)` method:
  `issues(first: 50, after, filter: state.type unstarted)`, selecting only
  id, identifier, label id/name, and `pageInfo { hasNextPage endCursor }`.
- `package.json` — workspaces gains `packages/dispatcher`; nothing else.

## Verification
Not run in this pass per assignment constraints (`bun test` and `tsc`
explicitly out of scope here): the plan's `bun test packages/dispatcher`
plus `bunx tsc --noEmit` are the merge-gate checks. No new npm
dependencies; no lockfile churn.

## Prohibitions honored
No `/etc/substrate` writes, no spawned binaries, no live Linear, no
`graph_claim`, no `/var/lib/substrate` touches in tests (fakes + tmp only).

## Deviations
- `isDispatchEnabled` wrapper dropped and the enabled-token `Set` changed
  to a `Record<string, true>` to comply with repo lint rules
  (ts-no-tiny-functions, ts-set-map) surfaced during implementation.
- One bad inline edit duplicated two lines in `kill-switch.ts`; repaired
  immediately by restoring the `lookupVar` opener. Final file re-read clean.
