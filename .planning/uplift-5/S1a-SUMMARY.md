# S1a summary: deploy preflight and rollback-compatibility tests

Nothing below was run through the test suite, `tsc` or the formatter (slice rules). What was run: `bash -n` and `shellcheck -s bash` on `deploy-release.sh` (both clean), and `scripts/deploy-preflight.ts` itself against this worktree with scratch env and state files under `/tmp/u5-s1a-smoke` (it is read-only): a clean env printed an all-ok table and exited 0, a token value listed under two surfaces printed the `loadConfig` error and exited 1, a bare invocation exited 2, and the planted value never appeared in any of those outputs.

## What changed

- **`scripts/deploy-preflight.ts`** (new; `bun run deploy:preflight`). Read-only: no network, docker or systemctl, no write; child processes are the config child (`bun`) and `df`. Four isolated checks, each `ok|warn|error` with a one-line reason:
  - `config`: the release's real `loadConfig` plus every export matching `configWarnings`, `swarmTokenWarnings` or `*ConfigWarnings` in `config.ts`, `brief-profile.ts`, `recall-snapshot.ts`, `hindsight-inventory.ts` (the modules `index.ts` takes them from; a warning function added to one of them later is run without editing the list), plus `config.metricsHistory.problems`. It runs in a child `bun` whose environment is exactly the `Environment=` lines of the release's `substrate-mcp.service` (+ `.conf` drop-ins) and the `--env-file`s, parsed with systemd rules (no `$` expansion, no `export`, last wins). A `ConfigError` is an `error` ("the unit would exit 78"); each warning is a `warn`.
  - `state`: `docs-ingest.json` through the release's `loadIngestRecords` (a `version` above 2 is an error, `problem` is an error); `slo-checkpoint.json` through its `restoreCheckpoint` (a `v` above `CHECKPOINT_VERSION` is an error); `retain-outbox.jsonl` and `event-spool.jsonl` parsed in the script, mirroring `retain-outbox.ts:121` (`isEntry`), because constructing a `RetainOutbox` compacts and rewrites its file and this script never writes. No usable line is an error, malformed lines among good ones a warning, absent is ok.
  - `units`: `MemoryHigh, MemoryMax, MemorySwapMax, TasksMax, CPUQuota, Type, WatchdogSec, Slice` of `substrate-mcp.service` (+ `.conf` drop-ins; `.example` files are ignored as systemd does) and `MemoryLow, CPUWeight, IOWeight` of `substrate.slice`, release against `--installed-units-dir`. Differences and a missing installed unit are `warn`, never `error`.
  - `disk`: `df -Pk` on the release filesystem against `SUBSTRATE_DEPLOY_MIN_FREE_GB` (default 5, `0` disables, same regex as the shell).
  - Output: table or `--json`, last line `preflight-receipt release=<sha> result=pass|fail ok=N warn=N error=N`. Exit 0 no error, 1 at least one, 2 usage or internal. A finding whose message quotes a value an `--env-file` supplied (six characters or more, except mode words) is withheld whole and replaced by the names of the variables.
- **`infra/vps/deploy-release.sh`**: `SUBSTRATE_DEPLOY_PREFLIGHT=off|report|enforce` (default `report`) and `SUBSTRATE_DEPLOY_GATE=off|report|enforce` (default `off`), run from the NEW release dir between `require_release_entries` and `prepare_health`/the swap: preflight first, then gate. `report` prints and always continues (nonzero exit, crash, `bun` missing, script missing); `enforce` refuses with `die` on any nonzero (fail-closed, "unavailable" included) while `current` is untouched; the gate is `bun scripts/release-gate.ts` (U5-1b's contract: 0 pass, 1 fail, 2 unavailable), receipt line `gate-receipt mode=… result=pass|fail|unavailable exit=N`. Table and receipts go to stderr so stdout stays the one `current -> releases/<sha>` line. A mode value outside the three is refused at the start of `cmd_deploy` (not `rollback`). `--dry-run` runs the preflight with report semantics against the release that is `current` (no tag to build), prints it on stdout, never runs the gate, and cannot change its exit code. `rollback` runs neither hook. With nothing set the only behavioural difference is the printed preflight table.
- **`infra/vps/deploy-release.test.ts`**: the `bun` stub dispatches the two hook scripts to their own logs (so every existing install assertion still counts installs only), `stage()` ships empty `scripts/deploy-preflight.ts` and `scripts/release-gate.ts`; 14 new tests (below).
- **`packages/mcp-server/src/rollback-compat.test.ts`** + `fixtures/rollback-9231f43/` (README, `docs-ingest.json`, `brief-snapshot-envelope.json`, `retain-outbox.jsonl`): see below.
- **Docs**: `infra/vps/README.md` (section "Pre-swap preflight and release gate", rollback line points at the runbook), `docs/runbooks/rollback-compat.md` (new).
- `package.json`: one script line, `deploy:preflight`.

## Flags and defaults
`SUBSTRATE_DEPLOY_PREFLIGHT=report`, `SUBSTRATE_DEPLOY_GATE=off` (see `env-notes/S1a.md`). Shell variables of `deploy-release.sh`, not server settings. `SUBSTRATE_PREFLIGHT_STATE_DIR` / `SUBSTRATE_PREFLIGHT_INSTALLED_UNITS_DIR` are optional overrides, unset in production.

## Tests added and what each proves
`scripts/deploy-preflight.test.ts`
- env parsing follows systemd rules (comments, quotes, continuation, last wins, no expansion, no `export`); unit `Environment=` splitting.
- withholding: a message quoting a supplied value is dropped whole and names the variables, in any position, level and check kept; short values and mode words pass through; several variables sharing one value are named once, sorted; a finding named after a value is renamed to its check class.
- config: a valid env exits 0 and the child saw ONLY the supplied variables (a variable set in the test process alone must not produce a warning); a release warning is reported by variable name with the value absent (sentinel); a `ConfigError` env (same token under two surfaces) is an `error`, exit 1, names the variables, prints no value, and the other checks still ran; a missing env file warns, an unreadable one errors; the unit's own `Environment=` lines reach the check; every warning function `index.ts` calls matches the pattern the preflight uses; a child that did not report is one error and the other checks still run.
- state: absent is ok; docs state of a newer version or not JSON errors; SLO checkpoint of a newer version or not a checkpoint errors; JSONL error/warn/ok boundaries.
- units: differences warn naming both values, never error; `.conf` drop-ins count and `.example` does not; not-installed and slice differences warn; an empty drop-in assignment resets.
- disk: floor boundary, `0`, malformed floor, unreadable `df`.
- CLI: usage errors exit 2 with no findings; argument placement; a real process run prints the receipt last, exit code is the verdict, the planted value never appears (pass and fail runs).

`infra/vps/deploy-release.test.ts` (new `pre-swap hooks` block)
- default is `report`: preflight runs once per deploy from the new release dir, with the env-file path and floor, while `current` still names the old release (and `none` on a first deploy); stdout stays one line.
- `report` deploys on exit 1, 2 and 139, table on stderr only.
- `enforce` refuses on exit 1 and 2, with `current`, `previous`, systemctl log and health log untouched and no rollback message; first deploy publishes nothing; exit 0 deploys.
- `off` never runs it. Mistyped modes refuse before git or a build and release the lock (an empty value is the default).
- without `bun` on PATH (skipped if the host has bun in `/usr/bin`): `report` continues, `enforce` refuses. A release without the script: same.
- gate: off by default; `report` receipts for 0/1/2, cwd is the release dir, runs after the preflight, sees the old `current`; `enforce` refuses on 1, 2 and 3 and passes on 0; a missing gate script refuses under `enforce`; an enforced preflight refusal stops before the gate.
- `--dry-run`: preflight against `current`, report semantics under `enforce`, no gate, nothing changed, `off` silent, no-current message, typo message; `rollback` ignores both hooks and a typo.

`packages/mcp-server/src/rollback-compat.test.ts` (frozen contracts cite old `file:line`; every violation string starts with its citation)
- docs state: the REAL `saveIngestRecords` output (records with `commit` + `superseded`, two datasets, triggers and lag set) meets every 9231f43 requirement and adds only `triggers` and `lag`; with nothing triggered its key set is exactly the old one; **ten mutation cases delete or retype each required key (`records`, a record's `sha`/`dataset_id`/`source_url`/`document_id`, a superseded `document_id`, a version row's `commit`/`content_sha256`, the version number, `versions` as an array) and assert the violation citing the old line is produced** (`docs-ingest.ts:563/574/580/544,605`, `docs-datasets.ts:90/97-103`); a frozen 9231f43 file loads whole through the real `loadIngestRecords` and, saved back, still satisfies the old contract; the file an old release writes after stripping `triggers`/`lag` loads with empty freshness.
- brief snapshot: a real `briefDetailed` at default flags writes exactly one `brief-snapshot` key equal to the frozen old key, in an envelope the old `peek` accepts, adding only `sections` and `until`, with `text` equal to the served brief; the sections-encoded `brief` entry is NOT under the key 9231f43 computes (its shape check is only `typeof string`, so a collision would serve JSON as the brief); a frozen 9231f43 envelope (no sections, no until) is served as the snapshot, with `snapshotAt`, when a source is down; mutation cases for `text`, `at` and the `v` member name `cache.ts:628/651`.
- retain outbox: lines from a real enqueue and from the compaction a failed replay causes meet the old `isEntry` and add no key; mutation cases name `retain-outbox.ts:125-130,134` and `:132-133,135`; a frozen 9231f43 file is hydrated by the real outbox (last line per document wins, torn line skipped and counted) and the boot rewrite is still readable by the old contract.

**The assertion that turns red when an old-required key is dropped** is the first `expect(oldDocsStateViolations(parsed)).toEqual([])` (resp. `oldSnapshotEnvelopeViolations`, `oldOutboxLineViolations`) in each "real output" test: the diff prints e.g. `docs-ingest.ts:574 requires records["agent-substrate README.md"].sha to be a string`. The mutation tests prove each citation fires.

## Verify (orchestrator)
```sh
bunx tsc --noEmit
bun test scripts/deploy-preflight.test.ts infra/vps/deploy-release.test.ts packages/mcp-server/src/rollback-compat.test.ts
bun run check:phase-close          # store lock: no GREPTIME_/HINDSIGHT_ tokens and no token literals were added outside mcp-server/src
bash -n infra/vps/deploy-release.sh && shellcheck -s bash infra/vps/deploy-release.sh   # both were clean when written
SUBSTRATE_DEPLOY_MIN_FREE_GB=0 bun run deploy:preflight . --state-dir /nonexistent --installed-units-dir /nonexistent
#  expect: loadConfig ok, "10 warning source(s) ran; none fired" (more with sibling slices), four state rows ok
#  (absent), two units rows warn (not installed), disk ok, `preflight-receipt … result=pass … error=0`, exit 0
bun run deploy:preflight /no/such/dir; echo $?    # 2
```

## Operator steps
None are taken by code. `SUBSTRATE_DEPLOY_PREFLIGHT=enforce` / `SUBSTRATE_DEPLOY_GATE=…` are set by the operator in the shell that runs `deploy-release.sh`. Before a rollback to 9231f43, remove `20-watchdog.conf` if installed (`docs/runbooks/rollback-compat.md`).

## Deviations from the brief
- Fixtures live in `fixtures/rollback-9231f43/` (the repo's existing convention is root `fixtures/<topic>/`, as `fixtures/docs-golden/`), not `packages/mcp-server/src/__fixtures__/`.
- The preflight table goes to stderr in a deploy (stdout is parsed as one line), to stdout under `--dry-run`.
- Values supplied by `--env-file`s are withheld (the finding's message is dropped whole and names the variables); values the release's own unit file declares are repo text and are shown. The shared redactor (`packages/mcp-server/src/redact.ts`) was not used: it matches credential SHAPES, and a planted non-credential-shaped value would pass it; and `redact-lock.test.ts` forbids a second redactor, so the script defines no masking function, only a filter that drops whole findings.
- The retain outbox and event spool files are parsed by a mirror of `isEntry`, not the real `RetainOutbox` (constructing it writes); the docs and SLO files use the real loaders as the brief prefers.
- The preflight's `disk` check runs after the build, so it can fail where the pre-build floor passed; it is the same floor.
- Extra test-seam variables `SUBSTRATE_PREFLIGHT_STATE_DIR` and `SUBSTRATE_PREFLIGHT_INSTALLED_UNITS_DIR` (the brief gave only the CLI flags; the shell script needs a way to pass them).
- Where the lanes were wrong or unverified: L9 inferred the old loaders ignore unknown keys and that `9231f43` never reads the SLO checkpoint; both are now read from `git show 9231f43` (`loadIngestRecords` reads `records` and `versions` only; `git grep -i "slo-checkpoint\|SLO_CHECKPOINT" 9231f43` is empty). L9 found no old-reader-on-new-value test: added. The docs state's `version` is not checked by the old reader at all; it is pinned to 2 here as the old writer's value, flagged as such in the test.

## Residual risks and unknowns
- 9231f43 is never executed; the frozen contracts are read from its source. If the old readers tolerate more or demand more than captured, the tests are stricter or blind accordingly (stated in the runbook).
- Only the shapes in the runbook table were enumerated: docs state, SLO checkpoint, retain outbox, event spool, `brief`/`brief-snapshot`/`recall-snapshot` cache classes, `metric_samples`, Postgres (no new column or table found), ledger events, audit chain and collector state (no source change since 9231f43).
- The watchdog drop-in blocks a rollback to a release without `watchdog.ts`; the runbook says to remove it first, nothing automates that.
- `enforce` refuses a redeploy of an old tag that predates `scripts/deploy-preflight.ts`; set the mode to `off` for it.
- A refused `enforce` leaves the built tree under `releases/<sha>` until the next health-checked deploy prunes it (disk pressure on a host at 94 %).
- The preflight's config check uses the release's unit `Environment=` lines plus env files only. An `EnvironmentFile` the real unit names beyond the one passed with `--env-file` is not read (the shell passes `SUBSTRATE_HEALTH_ENV_FILE`, default `/etc/substrate/substrate.env`, which is the drop-in's file).
- Sibling slices add `*ConfigWarnings` functions to `config.ts`; they are picked up by name. A new warning source in a module outside `WARNING_MODULES` is not (edit the list).
- One preflight test sets and restores `process.env.SUBSTRATE_SLO_CHECKPOINT` in the test process to prove the child does not inherit it; tests in a file run sequentially, so it cannot leak into a sibling test.

## Review round 1 fixes (11 findings)
1. [P2] The config child is spawned `bun --no-env-file`: a `.env` in the working directory no longer reaches `loadConfig`. Test: a real process run in a directory holding a `.env` that would produce a config warning.
2. [P2] Docs say per hook what it touches: the preflight is read-only, the gate is not (scratch containers through docker, `docker pause` of the scratch ledger, a run directory, needs images and disk). `deploy-release.sh` header and usage text, `infra/vps/README.md`, `env-notes/S1a.md`.
3. [P2] `rollback-compat.md`: any second deploy sets `previous`, `SUBSTRATE_RELEASE_RESTART=0` or not; only the very first deploy has none.
4. [P2] `rollback-compat.md` gains "Installed units that a rollback to 9231f43 breaks": every `infra/vps` `ExecStart` checked against `git show 9231f43:<entry>`. Absent in the old tree: `index archive` and `ledger archive` (the old `cmdIndex` accepts only `sweep`, no `ledger` command), `scripts/docs-golden.ts`, `scripts/doctor-runtime.ts`, `scripts/substrate-alert.ts`. The rolling-back steps now disable those four timers first and re-enable them after the roll-forward.
5. [P2] `readText` stats first; a state or JSONL file over 8 MiB, an env or unit file over 1 MiB is an `error` naming the size, never read. Test with sparse files, including the "at the cap is read" boundary.
6. [P3] `withholdQuotedValues` also matches the JSON-escaped form; comments and README say a message quoting a WHOLE value is withheld.
7. [P3] State files are found at the paths the child's loaded config resolved (`docsStateFile`, `retainOutbox.path`, `sloCheckpointPath`; the spool follows `SUBSTRATE_STATE_DIR`), else `--state-dir`; a switched-off checkpoint is `ok (off)`; the host's default `/var/lib/substrate/slo-checkpoint.json` is read from `--state-dir` instead, so a run is hermetic. All four state checks moved into the child, so a child that does not report now skips them too (its error says so).
8. [P3] The environment comes from the INSTALLED `substrate-mcp.service` when there is one, else the release's; the installed unit's values are withheld like an env file's. Parser comments and README say "closely, not completely".
9. [P3] `deploy-release.sh`: `cmd_dry_run` is called plainly (errexit stays on) and calls `dry_run_preflight` itself before each of its returns.
10. [P3] `rollback-compat.test.ts`: the old `version: 2;` is `docs-ingest.ts:543` (writer `:605`); citation and mutation prefix fixed.
11. [P3] Test hygiene: scratch dirs removed in `afterAll`; "every warning function" is derived from `index.ts`; the real `saveIngestRecords` (triggers and lag set) and real `RetainOutbox` output is fed to the preflight (in `rollback-compat.test.ts`, because the store lock forbids scripts importing `docs-ingest.ts`), and `DOCS_STATE_KNOWN_VERSION` is asserted equal to the version the real writer writes.
