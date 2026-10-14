# U5-4b summary — collector / CLI event spool (client half of idempotent replay)

Slice branch `u5/s4b`. Wire contract: `U5-4-CONTRACT.md` (honoured, no deviation). Nothing
here was run through `bun test`, `tsc` or the lock tests (edit-only rules). Two scratch scripts under `/tmp/u5-s4b-smoke/`
exercised `spool.ts`, `emit.ts` and the git hook once (append/overflow/drain/0600; 503 -> parked -> replay -> empty; hook
parks a redacted commit event on an unreachable server and exits 0); their output matched what the tests below assert.

## What changed

| File | Change |
| --- | --- |
| `packages/collectors/src/spool.ts` (new) | `EventSpool`: 0600 JSONL, `O_EXCL` lock file shared by every process that appends or compacts, temp + rename compaction, caps (lines, bytes, TTL, attempts), drop reports with a cause, exp backoff 30 s..1 h with +-20 % jitter, torn/garbled-line tolerance, bounded read. `spoolConfig`, `spoolBackoffMs`, `canonicalJson`, `contentKey`. No network, no `fetch`. |
| `packages/collectors/src/emit.ts` | `prepareEvent` (redact, fix `ts`, key), `postEvent` parks retryable failures when the flag is on, `parkEvent` (hook-safe append), `drainEventSpool` (single-flight replay with `/healthz` gate, `x-substrate-replay: 1`), `eventSpool`/`openEventSpool`, `countSpoolDrops`, `refused-emits.jsonl` rotation at `SUBSTRATE_REFUSED_EMITS_MAX_BYTES`, `recordRefusal` takes an optional `kind` (spool drops write `kind: "dropped"`). `EmitOutcome` `failed` gains optional `spooled: true`. Flag off: the same request body, no file I/O. |
| `packages/collectors/src/grok.ts` | `grokEventKey(path, session, offset, line)` passed as the stable idempotency key; `replaySpool()` after each pass (a no-op with the flag off). |
| `packages/collectors/src/herdr.ts` | A parked transition advances (`"spooled"` outcome) and is not emitted again; unref'd, single-flight replay tick (`SPOOL_DRAIN_MS` 30 s) only when the flag is on, cleared in `stop()`; `--once` drains once. `drain`/`drainMs` options are the test seam. |
| `packages/collectors/src/herdr-state.ts` | `TransitionOutcome` gains `"spooled"`: advances like stored, counts `failed`. |
| `packages/collectors/src/git/post-commit` + `install-git-hook.ts` | The hook parks a redacted, keyed commit event on 5xx/unreachable when `SUBSTRATE_EVENT_SPOOL=on` and the installer baked the collectors dir (`__SUBSTRATE_COLLECTORS_SRC__` placeholder) in; never replays, never probes. A dir with shell metacharacters is never baked. |
| `packages/collectors/src/status.ts` | `collectors:status` reads `refused-emits.jsonl.1` too. |
| `packages/cli/src/spool.ts` (new) + `index.ts` | `substrate spool status [--json]`, `substrate spool flush [--json] [--budget-ms N]`; `substrate emit` parks through `postEvent` when the flag is on (the CLI never replays). Exit 0 for status and any flush result, 1 on a usage error. `args.ts` unchanged. |
| `scripts/doctor-vps.ts` | One `LIVE_STATE` row so the doctor names `event-spool.jsonl` (and its `.lock`/`.tmp` siblings) as live collector state instead of `unknown owner`. (Outside the brief's file list; single line.) |
| `docs/collectors.md` | New "Event spool" section, env rows, state-file rows, rotated refused file; the sentence "There is no retry queue." now says it is the default. (The brief limits me to the spool section; the old sentence would have become false.) |

## Flags and defaults

`SUBSTRATE_EVENT_SPOOL=off|on` (default `off`), `_MAX` 5000, `_MAX_BYTES` 8388608, `_TTL_H` 48, `_MAX_ATTEMPTS` 12,
`SUBSTRATE_REFUSED_EMITS_MAX_BYTES` 1048576 (4096..64 MiB). Invalid values warn once on stderr and use the default;
caps above their ceilings (100000 lines, 64 MiB, 720 h, 100 attempts) are clamped. Exact `.env.example` lines:
`.planning/uplift-5/env-notes/S4b.md`.

## Behaviour that matters

- Flag off: no spool file is opened, created or read (including by `drainEventSpool` and `substrate spool flush`); the POST
  body is `JSON.stringify(event)` as before. The refused journal is the one always-on change: it now rotates at its cap.
- Parked: network error, timeout, 5xx (503 `stored:false` included). Never parked: any 4xx (logged as a refusal), 202,
  body over 1,000,000 bytes (a `dropped` line). The bearer, URL and headers are never written.
- Redaction before write: the shared `redact`/`redactValue` over `session_id`, `graph_id`, `node_id`, `linear_identifier`,
  `repo`, `branch`, `summary` and `payload`, before the first send, so the live body and the spool agree byte for byte.
- Key: caller key when it matches `[A-Za-z0-9._:-]{8,128}`, else `ik1:` + sha256(collector, surface, session, kind, ts,
  summary, repo, branch, graph, node, linear, step, actor, canonical payload). `ts` is fixed at the first attempt.
- Replay: one `GET /healthz` (cached 15 s per URL); requires `idempotency` in `accept|enforce` and `greptime !== false`.
  Otherwise `held` and one rate-limited stderr line; no attempt consumed. Entries replay oldest first with
  `x-substrate-replay: 1` and the exact first body. 202 removes; 4xx logs a refusal and removes; 5xx/timeout consumes an
  attempt and backs off; connection refused holds the pass without consuming, and a 401 skips that credential's remaining entries for the pass (kept, no attempt) while other credentials continue; three failures in a row stop it.
  Settled entries are written back every 25 and at the end, and the rewrite re-reads under the lock, so an event a hook
  appended mid-replay survives. A crash after a 202 and before the rewrite replays the entry, and the server dedupes it.

## Tests added (each fails on the old code: no `spool.ts`, no `spooled`, no rotation, no `spool` command)

- `packages/collectors/src/spool.test.ts`: 0600 file and non-world dir; append never touches `fetch`; entry shape has no
  credential field; unwritable, oversize and one-attempt drops are reported; line cap, byte cap and bulk drop (full count,
  20 samples); TTL at drain and at compaction; attempt exhaustion; backoff math; due vs `all`; ordering and per-attempt
  schedule; hold consumes nothing; three-failure stop; time budget; refusal/delivery removal; throwing callback; overlapping
  drains; crash between a delivery and the rewrite replays the same key and body; append during a drain survives; torn and
  garbled lines; stale lock stolen, live lock waited for; four concurrent processes append 100 lines with none lost or torn;
  stats; config defaults, typos, clamps; canonical JSON and key alphabet.
- `packages/collectors/src/emit-spool.test.ts`: flag off is byte-identical and creates no file (5xx, network, timeout, 4xx,
  unknown flag value with a pre-existing file untouched, `parkEvent`); 5xx/network/timeout park the exact sent body 0600;
  4xx (400/401/403/413/429) never park; 202 parks nothing; planted secret absent from wire and file; bearer absent from file;
  oversize dropped visibly; overflow leaves a `dropped` line without summary/payload; key determinism and sensitivity; `ts`
  normalisation; caller key use and fallback; malformed `ts` refused not parked; replay marker only on replay, body identical;
  timeout-after-success replays to one row; replay refused for `off`, missing field, bogus value, `greptime:false`, non-JSON;
  health answer cached; unreachable health holds; nothing due asks nothing; refused connection holds, and a 401 skips its credential, without consuming;
  400 removed and logged, 503 backs off; bearer re-resolved; hook append has no network; overlapping drains share a pass;
  `refused-emits.jsonl` rotation, floor and status reporter.
- `packages/collectors/src/herdr-spool.test.ts`, `herdr-state.test.ts` (one test added): parked transition advances and is
  not re-emitted; an unparked failure still blocks; tick is single-flight, unref'd, cleared by `stop()`, absent when off.
- `packages/collectors/src/grok-spool.test.ts`: key stability and sensitivity; parked under the file/offset/line key with the
  offset still advancing; two lines two keys; re-read same key; stored parks nothing; flag off creates no state-dir file.
- `packages/collectors/src/git/post-commit-spool.test.ts`: hook parks once, redacted, no replay or `/healthz`; unreachable
  parks; 4xx not parked; flag off or no baked dir creates no file; unwritable state dir still exits 0.
- `packages/collectors/src/install-git-hook.test.ts`: baked directory, mode 0755, refresh idempotent, `--check` writes nothing.
- `packages/cli/src/spool.test.ts`: status fields and no body; `--json` with drop counters by cause; empty spool creates
  nothing; flush off is a no-op exit 0; flush passes `all` and the budget, exit 0 for ran/held/stopped; budget default and
  clamp; every usage error exits 1; the real CLI process: emit parks on a 503, `spool status`, `spool flush` replays with the
  marker and the same body and empties the file; flag off is one POST and no file; help lists the command.

## Review round 1 (P2 x5, P3 x3) — all fixed

- Replay gate also holds on `eventsWritable === false`, `ledger.writable === false` and a non-200 `/healthz` (no attempt consumed).
- Compaction reports drops only after its write reached the disk (a failed write clears them; the retry reports once).
- Temp file write is inside the unlink-on-failure try; each compaction sweeps up to 5 orphan `event-spool.jsonl.*.tmp` older than the stale-lock age. `EventSpool` takes an `io` seam for tests.
- `appendLocked` writes every byte (loops on short writes); a write that stops fails the append and truncates the torn tail.
- Replay: 403 keeps the entry untouched and moves to the next (`skip`, `skipped` in the report, ` skipped=N` in `spool flush` output); a 401 skips that credential's remaining entries (superseded by round 3: per credential, pass continues); other 4xx remain permanent refusals.
- Docs: replay-answer table, retained-journal drop counts, hook lock-wait note, journal file mode, enforce collapse note. Content key (and the Grok key) now hash a JSON array, not a `|` join. A finite non-zero numeric `ts` is normalised, not replaced.

## Review round 2 (integrated review)

- P1: the `/healthz` probe now sends the replay's credential (explicit `token`, else the surface resolver on the first parked entry's surface; one `replayBearer` rule shared with `replayEntry`); 401/403 on the probe = hold `healthz-auth`, no attempt consumed. Callers (herdr, grok, CLI `spool flush`) pass no token and rely on the resolver. New `emit-spool-real-server.test.ts` drives the real `createHttpServer` with surface tokens and anonymous disabled behind a duck-typed ledger (a thin shim adds `idempotency` to `/healthz` only when the real body lacks it).
- P2: every spool-related test fixture (`spool-test-env.ts`: all spool, refused-journal, state-dir, URL and token variables snapshotted/cleared/restored, tokens dir emptied, spool explicitly `off`), including the pre-existing `emit.test.ts`; verified green with `SUBSTRATE_EVENT_SPOOL=on`, `_TTL_H=24`, `_MAX_ATTEMPTS=1`, `_MAX_BYTES=5000`, a token and a malformed refused cap in the shell.
- P3: `_MAX_BYTES` minimum 1024 is enforced in the parser with a warning (status shows the effective value); a malformed/out-of-range `SUBSTRATE_REFUSED_EMITS_MAX_BYTES` warns once.

## Review round 3 (delta review)

- R1: local expiry/attempt sweep (`sweepSettled`) runs before and independently of the probe; the probe tries up to 4 distinct credentials of replay-eligible entries (`eligible`) and holds `healthz-auth` only if all are refused; a replay 401 skips that credential's remaining entries for the pass (kept, no attempt); all skipped => `held: "unauthorized"`.
- R2: 401/403 probe answers are never cached; successes are keyed by URL + a 12-hex sha256 fingerprint of the bearer (memory only).
- R3: `SUBSTRATE_REFUSED_EMITS_MAX_BYTES` `0`/negative => default 1 MiB + once-only warning.
- `emit-spool-real-server.test.ts` is the integration-tree version (`SUBSTRATE_EVENT_IDEMPOTENCY: accept`, `findByIdempotencyKey`, no shim). It needs the server half, so its 3 delivery cases fail in this worktree alone (the earlier shim version of the file passed 5/5 against this code); they belong to the merged tree.

## Review round 4

- The pre-probe sweep's drops are now part of every `DrainResult` (`held` gains `dropped`; `ran` adds them to `dropped`), so the CLI line, the Grok summary and the journal agree.
- Added tests: sweep before probe, cleanup-only hold reported by CLI, same bearer refused then accepted (401 never cached), four-credential probe bound, shared bearer across surfaces, probe cache TTL and 16-entry bound, `healthz-auth` log throttle. `spoolProbeCacheSize()` is exported for the bound test; Date.now is overridden in those tests.

## Smoke commands for the orchestrator

```
bun test packages/collectors/src/spool.test.ts packages/collectors/src/emit-spool.test.ts \
  packages/collectors/src/herdr-spool.test.ts packages/collectors/src/herdr-state.test.ts \
  packages/collectors/src/grok-spool.test.ts packages/collectors/src/install-git-hook.test.ts \
  packages/collectors/src/git/post-commit-spool.test.ts packages/cli/src/spool.test.ts
bun test packages/collectors packages/cli scripts/doctor-vps.test.ts     # existing emit/grok/herdr/status/cursor-stop tests unchanged
bun run check:phase-close                                                # redact-lock (new files import the shared redactor only), store-lock
bunx tsc --noEmit
```

Manual: with a stub on a scratch port that answers `/healthz` `{"idempotency":"accept","greptime":true}` and 503 on
`POST /events`: `SUBSTRATE_URL=http://127.0.0.1:<port> SUBSTRATE_STATE_DIR=/tmp/x SUBSTRATE_EVENT_SPOOL=on bun packages/cli/src/index.ts emit --kind note --summary hi`
exits 0 and `/tmp/x/event-spool.jsonl` has one 0600 line; `... spool status` prints `depth: 1`; after the stub returns 202,
`... spool flush` prints `delivered=1 refused=0 retried=0 dropped=0 remaining=0` and the file is empty. With
`SUBSTRATE_EVENT_SPOOL` unset the first command writes nothing under `/tmp/x`.

## Operator steps (nothing is installed by code)

1. Land the server half; set `SUBSTRATE_EVENT_IDEMPOTENCY=accept`; confirm `/healthz` shows `"idempotency":"accept"`.
2. Add `SUBSTRATE_EVENT_SPOOL=on` to one collector env file at a time and restart that unit; watch
   `substrate spool status` and `bun run collectors:status`.
3. Re-run `install-git-hook.ts <repo>` for each repo whose post-commit hook should park.
4. Rollback: set `SUBSTRATE_EVENT_SPOOL=off`. The file is then inert (never read); delete it by hand if desired.

## Known limits and unknowns

- The cross-process lock is a lock file. A stale one is taken over after 10 s; if two processes take it over in the same
  instant, one append can be lost. A lock held longer than 0.5 s makes an append fail visibly (`spool-write_failed`).
- Line cap enforcement between size checks can overshoot by up to a tenth of the cap (at most ~1600 lines); the byte cap is
  exact.
- `refused-emits.jsonl` rotation is not locked: two processes crossing the cap at once can rotate twice and lose the older
  of the two files' lines. Bounded, and only refusal lines.
- The Muse tool hook (projector-generated, self-contained) does not spool; the git hook does only when the installer baked
  the collectors dir in; hook environments need `SUBSTRATE_EVENT_SPOOL` set by the operator.
- A `substrate emit` with the flag on adds the idempotency key and a stamped `ts` to the body, and a 4xx now also writes a
  refused-journal line (through the shared emit); with the flag off it is untouched.
- Server-side behaviour (lookup, `deduplicated`, `/healthz` `idempotency` field, `ts` future bound) is slice U5-4a's and is
  only exercised here against stubs. If U5-4a names the `/healthz` field or its values differently, change `probeReplay` in
  `emit.ts` only.
- Collector counters count a parked event as `failed` (the live attempt failed); a later replay is not counted in them.
- Not done: surfacing `spool_depth`/`spool_oldest_age_s` in `/healthz` or the doctor (server/doctor scope); `substrate spool
  status` and the drop counters are the client-side view.
