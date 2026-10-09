# 24-03 Summary: Hermes dispatch core (DISP-04, DISP-05, DISP-06, DISP-07)

## Objective
Build the lease-correct heart of the phase: the authenticated substrate
client, the headless Hermes launch contract, the 900 s claim watch with
the persistent given-up set, and the tick that wires poll, resolve, gate,
launch, and watch together — all on fakes, never spawning Hermes.

## Files
- `packages/dispatcher/src/substrate-client.ts` — stateless `POST /mcp`
  `tools/call` client bearing `SUBSTRATE_TOKEN_SUBSTRATE`, shaped like the
  `callTool` helper in `http.test.ts:948-969` (JSON body, else first SSE
  `data:` line, else first result text). Exposes `graph_find`,
  `graph_get`, `events_emit` only; any other tool name is refused at
  runtime (static `Record` allowlist, per repo rule) as well as by the
  `AllowedToolName` type. `events_emit` always sends `surface:
  "substrate"`. No claim code path exists in this module.
- `packages/dispatcher/src/substrate-client.test.ts` — fake-fetch suite:
  envelope/bearer shape, JSON vs SSE parsing, substrate surface pin,
  every request body scanned for the forbidden holder-operation name
  (assembled by concatenation so the literal appears nowhere near the
  client), pre-fetch refusal of that tool, HTTP and JSON-RPC errors as
  `SubstrateError`.
- `packages/dispatcher/src/launch-hermes.ts` — exact argv `hermes chat
  --oneshot --quiet --source tool --yolo --accept-hooks --in <worktree>
  --query-file <prompt>` (no `--worktree`, `-z`, `--safe-mode`,
  `--ignore-user-config`); spawn only via an injected `SpawnFn` with
  `stdinPath: "/dev/null"`, `detached: true`, cwd on the worktree; fresh
  child env of `HOME`, `PATH`, `USER`/`LOGNAME`/`LANG`/`LC_ALL`/`TMPDIR`
  if set, optional `HERMES_HOME`, plus `SUBSTRATE_URL` and
  `SUBSTRATE_TOKEN_HERMES` — never `LINEAR_API_KEY`,
  `SUBSTRATE_TOKEN_SUBSTRATE`, or any other secret; ids-only prompt
  (`graph`, `node`, `session_id: hermes:<graph>:<node>`), file mode 0600;
  `checkSubstrateMcp` preflight (null/missing/substrate-free config is
  `mcp-unconfigured`, assumption A1 fail-closed).
- `packages/dispatcher/src/launch-hermes.test.ts` — exact-argv
  equality, forbidden-flag sweep, spawn options record, keys-only env
  assertions (set and unset plumbing), canary title/description in
  neither prompt nor argv, prompt mode 0600 in tmp, preflight table.
  Nothing imports a spawner: the real binary is never executed.
- `packages/dispatcher/src/watch.ts` — triple-condition `isLanded`
  (`claimed_by === "hermes"`, `claim_session` equals the prompt session,
  `lease_expires_at` strictly future; `lease_id` ignored, always null on
  public reads), `isLiveLease` for the pre-launch gate, `given-up.json`
  set keyed by Linear issue id (mode 0600, missing file is empty, corrupt
  file throws rather than relaunching), `watchClaim` over injected
  `getNode`/`isAlive`/`signal`/`sleep`/`now`: landed wins over a
  simultaneous exit; exit writes `exited-unclaimed`; 900 s writes
  `claim-timeout` between SIGTERM, the 5 s grace (A4), and SIGKILL; both
  unclaimed endings persist the file BEFORE `onUnclaimed` (T-24-03e).
  `WATCH_BUDGET_MS` pinned to `DEFAULT_LEASE_TTL_SECONDS` by import.
- `packages/dispatcher/src/watch.test.ts` — landing table (incl. null
  `lease_id`, exact-expiry boundary, foreign surface/session),
  live-vs-landed split, store round-trip/mode/corrupt, landed run with no
  signal and no file, exit run asserting file-before-report order, fake-
  clock timeout asserting SIGTERM→(5 s)→SIGKILL order, the 900 s budget
  actually elapsing, and landed-beats-exit.
- `packages/dispatcher/src/tick.ts` — `dispatchIssue` (given-up skip →
  non-hermes defer with zero side effects → `graph_find` resolve →
  live-lease `already-claimed` gate, any live lease incl. same session →
  MCP preflight skip with event only → worktree refusal marker → prompt
  write, allowlisted spawn, `watchClaim` whose `onUnclaimed` comments,
  removes only dispatch labels, and emits) and `runTick` (poll via
  `collectCandidates`, `not-dispatchable` markers). Landed launches leave
  labels to the Mirror. All events are vocabulary-closed (`note`/
  `warning`, surface substrate via the client, `action: "dispatch"`,
  `runtime: "dispatcher"`, summaries of graph id + outcome token only).
  `TickSubstrate` is satisfied by `SubstrateClient` (compile-time pin, as
  `linear-poll.ts` does for `LinearClient`).
- `packages/dispatcher/src/tick.test.ts` — full fake seams incl. a
  `DispatchMarkerComments`-shaped GraphQL stub: landed end-to-end (exact
  argv, env keys, prompt content, launch event, nothing else touched),
  already-claimed (no spawn, label kept), exit (file-before-comment
  observed inside the comment fake, dispatch-only label removal, exact
  marker body), timeout (signal order, give-up, comment, labels, event),
  preflight skip (event only), no-node (no worktree call, no spawn),
  worktree refusal, given-up silence (no substrate calls at all),
  claude-code deferral (no side effects — 24-04 owns that surface), and a
  two-issue `runTick` with every event vocabulary-closed and canary-free.

## Verification
Not run in this pass per assignment constraints (`bun test` and `tsc`
explicitly out of scope here): the merge-gate checks are `bun test
packages/dispatcher`, `bunx tsc --noEmit`, and `bun run
check:phase-close` (vocabulary unchanged: no new kind, no new surface).
Static review done instead: `noUncheckedIndexedAccess` guards on every
index read (repo `if (!x) throw` idiom), `import type` for type-only
imports, no dynamic imports, static `Record` allowlist, no tiny
wrappers beyond multi-site domain contracts. No new npm dependencies.

## Prohibitions honored
No `graph_claim` in dispatcher request paths (prompt template names the
tool for the Hermes child only, per research); no issue text in prompt,
argv, comments, or events (canary tests); no real hermes spawn (injected
`SpawnFn`, fakes record argv); no `/var/lib/substrate` or
`/etc/substrate` (injected dirs, tmp in tests); no live Linear/MCP; no
edits to `worktree.ts`, `kill-switch.ts`, `lock.ts`, `linear-poll.ts`,
or `linear.ts`; no reset/rebase/push (HEAD still `6e0c6c2` + 2 commits).

## Deviations
- `defaultHermesConfigPath` helper dropped for the repo tiny-function
  rule; the tick receives config text behind a `readHermesConfig` seam
  and 24-05 will join the path at the call site.
- An expired live lease is not probed as a separate tick test; the
  `isLiveLease` unit table plus the free-lease end-to-end path cover the
  gate logic (expired reads as free, dispatch proceeds).
- Three mis-ranged surgical edits during this pass (one Set→Record swap,
  one import insert, one test-setup reorder) were repaired immediately;
  final files re-read clean.
