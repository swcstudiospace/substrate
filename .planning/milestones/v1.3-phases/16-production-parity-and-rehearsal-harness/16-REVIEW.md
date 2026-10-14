---
phase: 16-production-parity-and-rehearsal-harness
reviewed: 2026-10-08T21:35:18Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - README.md
  - docs/observability.md
  - docs/rehearsal.md
  - docs/runbooks/production-parity.md
  - infra/vps/substrate-mcp.service
  - package.json
  - packages/mcp-server/src/rehearsal-env.test.ts
  - packages/mcp-server/src/rehearsal-env.ts
  - scripts/parity-check.test.ts
  - scripts/parity-check.ts
  - scripts/rehearsal.test.ts
  - scripts/rehearsal.ts
findings:
  critical: 0
  warning: 8
  info: 9
  total: 17
status: issues_found
---

# Phase 16: Code Review Report

**Reviewed:** 2026-10-08T21:35:18Z
**Depth:** standard
**Files Reviewed:** 12
**Status:** issues_found

## Summary

Scope: the union of phase 16's task commits (evaluation scope `resolved`, source `task-commits`,
range base `6417c92f`), which matches the SUMMARY `key-files` lists exactly. Reviewed: the
scratch rehearsal harness (`scripts/rehearsal.ts`), its env builder
(`packages/mcp-server/src/rehearsal-env.ts`), the read-only parity check
(`scripts/parity-check.ts`), the unit-file guard, the package scripts, the tests and the docs.

`rehearsal-env.ts` is sound. Every store URL is loopback-checked, the parent environment is
read only through the allowlist, and the round-trip tests go through the real `loadConfig`.
`parity-check.ts` fails closed on every unknown fact and makes no state-changing call.

The defects are in the harness lifecycle in `rehearsal.ts`. `up` declares a twin ready when
its `/healthz` is only partly healthy. One validation path (the default operator) is skipped,
and a later throw on that path crashes `up` after the containers are running, so they leak.
Missing flag values fall back to defaults without a word, so `down --name` tears down
`default`. The disk-floor preflight fails open. The run directory is created in shared `/tmp`
and a pre-existing directory is trusted. A twin started from a `system.slice` context can be
started but never stopped. The smoke's `register` step passes on a tool error. In
`parity-check.ts`, owner pids are not deduplicated, so a single owner seen on two fds or
addresses reads as two holders and fails.

No Critical findings: nothing here reaches production stores or leaks a credential.

## Narrative Findings (AI reviewer)

## Warnings

### WR-01: `up` accepts a partially healthy twin as ready

**File:** `scripts/rehearsal.ts:426` (caller `scripts/rehearsal.ts:658-664`)
**Issue:** `waitForHealth` returns `last` at the deadline. `last` is non-null whenever any
200 was seen, even one with `index`, `greptime` or `eventsWritable` false. `runUp` only
checks `health === null`, so a twin whose scratch ledger or index never came up is reported
`up` and gets a `state.json` and `consumer.env`. `docs/rehearsal.md` says `up` "waits for
`GET /healthz` to report a writable index and ledger". The code does not hold to that, and
later proofs then run against a degraded twin.
**Fix:**
```ts
const health = await waitForHealth(url, firstToken ?? null, READY_TIMEOUT_MS);
if (health === null || !health.index || !health.ledger || !health.writable) {
	killOwn(server.pid);
	removeLabelledContainers(opts.name);
	process.stderr.write(`[rehearsal] twin never reached healthy /healthz (index=${health?.index} ledger=${health?.ledger} writable=${health?.writable}); log kept at ${logPath}.\n`);
	return 1;
}
```

### WR-02: Default operator skips the swarm check, and the later throw leaks running containers

**File:** `scripts/rehearsal.ts:122-125` (throw site `scripts/rehearsal.ts:623`, rethrow `scripts/rehearsal.ts:1012`)
**Issue:** `parseOperator` returns `surfaces[0]` without the `isSwarmSurface` check that the
explicit `--operator` path applies. With `--surfaces swarm-a05-be,...` the swarm surface
becomes the operator. `buildRehearsalEnv` then throws `RehearsalEnvError` at line 623. By
then both scratch containers are started and healthy and the token files are written.
`main` only catches `RehearsalRefused`, so the error is rethrown. The process exits with a
stack trace instead of the documented exit 2, and the labelled containers and run directory
are left behind. Any other `RehearsalEnvError` from `buildRehearsalEnv` leaks the same way.
**Fix:** Apply the swarm check on the default path, and build the env before any container
starts:
```ts
if (raw === undefined) {
	const first = surfaces[0];
	if (first === undefined) throw new RehearsalRefused("no surfaces to pick an operator from");
	if (isSwarmSurface(first)) throw new RehearsalRefused(`operator surface ${first} is a swarm surface; pass --operator`);
	return first;
}
```
Also wrap the `buildRehearsalEnv` call in `try { … } catch (e) { removeLabelledContainers(opts.name); throw e instanceof RehearsalEnvError ? new RehearsalRefused(e.message) : e; }`.

### WR-03: Missing flag values fall back to defaults without a word (`down --name` stops `default`)

**File:** `scripts/rehearsal.ts:966-970`, `scripts/rehearsal.ts:994`
**Issue:** `flag()` returns `argv[at + 1]`, which is `undefined` when the flag is the last
argument. The guard `if (value === null) usage(...)` can never fire, so it is dead code. As a
result `rehearsal down --name` falls back to the `default` instance and tears it down.
`up --surfaces` falls back to the default surface list, and `up --operator` falls back to the
first surface. A flag followed by another flag is taken as the value, for example
`--operator --anonymous`.
**Fix:**
```ts
function flag(argv: string[], name: string): string | undefined | null {
	const at = argv.indexOf(name);
	if (at < 0) return undefined;
	const value = argv[at + 1];
	return value === undefined || value.startsWith("--") ? null : value;
}
```

### WR-04: The disk-floor preflight fails open

**File:** `scripts/rehearsal.ts:483-491`
**Issue:** When `XDG_RUNTIME_DIR` is set, `statfsSync(runDir)` runs before `runDir` exists.
It throws `ENOENT`, and the `catch` swallows every error that is not `RehearsalRefused`. The
2 GiB floor is then skipped without any message. Any other `statfs` error is swallowed the
same way. The docs say `up` "refuses unless ... free disk is above the ~2 GiB floor".
**Fix:** Stat an existing ancestor, such as `process.env.XDG_RUNTIME_DIR ?? "/tmp"`, and turn
a `statfs` failure into a refusal:
`catch (cause) { if (cause instanceof RehearsalRefused) throw cause; throw new RehearsalRefused("could not read free disk"); }`.

### WR-05: Run directory in shared `/tmp` trusts a pre-existing directory and swallows the chmod failure

**File:** `scripts/rehearsal.ts:188`, `scripts/rehearsal.ts:506-518`
**Issue:** Without `XDG_RUNTIME_DIR` the run directory is `/tmp/substrate-rehearsal/<name>`.
`mkdirSync(..., { recursive: true, mode: 0o700 })` applies the mode only to directories it
creates. If another local user pre-created `/tmp/substrate-rehearsal`, or the instance
directory itself, `chmodSync` fails and the error is swallowed under the comment "Mode
argument already applied", which is false in that case. Bearer tokens, `stores.env` (ledger
and Postgres passwords) and `consumer.env` are then written into a directory another user
controls, or under a parent they can rename.
**Fix:** After `mkdirSync`, `lstatSync` each of `/tmp/substrate-rehearsal` and `runDir`.
Refuse unless each is a real directory (not a symlink), owned by `process.getuid()`, with
mode `0o700`. Better, default to a per-user base (`XDG_RUNTIME_DIR`, or `os.tmpdir()` plus
`mkdtemp`) instead of a fixed shared `/tmp` name. Do not swallow `chmodSync` errors.

### WR-06: A twin started from a `system.slice` context can never be stopped by `down`

**File:** `scripts/rehearsal.ts:165` (spawn-time facts `scripts/rehearsal.ts:649-654`)
**Issue:** `mayStop` refuses any process whose cgroup contains `/system.slice/`. `up` reads
the twin's facts right after spawning it but never runs `mayStop` on them. When the harness
is launched from a systemd-managed agent or service, the twin inherits that `system.slice`
cgroup. `up` succeeds, then every `down` refuses with "process is in system.slice". The twin
and its containers are left running, and only a manual kill clears them.
**Fix:** At up-time, after `readProcFacts(server.pid)`, run the same predicate against the
state about to be written and refuse early:
```ts
const stopReason = mayStop(facts, { pid: server.pid, checkout, startSeconds: facts.startSeconds });
if (stopReason !== null) { killOwn(server.pid); removeLabelledContainers(opts.name); throw new RehearsalRefused(`twin would not be stoppable: ${stopReason}`); }
```
Alternatively, start the twin in its own transient user scope.

### WR-07: `parseSsListeners` does not deduplicate pids, so a single owner can fail "exactly MainPID"

**File:** `scripts/parity-check.ts:50-51` (verdict `scripts/parity-check.ts:133`)
**Issue:** Every `pid=N` on every matching line is appended. A process that holds the port on
two fds (`users:(("bun",pid=1,fd=21),("bun",pid=1,fd=22))`) or on two addresses (IPv4 and
IPv6 loopback) yields `[1, 1]`. `parityVerdict` requires `ssOwnerPids.length === 1`, so a
correct deployment reads as "port 7410 owners [1, 1] are not exactly MainPID". The check
fails closed, but on a false reason, and an operator chasing a "stray" that does not exist
may kill the healthy unit.
**Fix:** `out.set(port, [...new Set([...(out.get(port) ?? []), ...pids])]);` and add a test
with a duplicated pid.

### WR-08: The smoke `register` step passes on a tool error

**File:** `scripts/rehearsal.ts:946` (helper `scripts/rehearsal.ts:884-894`)
**Issue:** The server returns tool refusals as `{ content: [{ text: JSON.stringify({ error }) }], isError: true }`
(`packages/mcp-server/src/mcp.ts:153-155`). `smokeToolResult` parses any JSON-object text and
never looks at `result.isError`, so `check(smokeToolResult(registered) !== null, "register")`
prints `ok` for a refused registration. The overall exit still fails, because `claim` would
not be granted. Even so, the per-step ok/FAIL record in the proof evidence misattributes the
failure.
**Fix:**
```ts
const body = attempt.body as { result?: { isError?: boolean; content?: Array<{ text?: string }> } } | null;
if (body?.result?.isError === true) return null;
```
For `register`, also assert the expected success field (for example a `status` or
`graph_id` echo).

## Info

### IN-01: `parity:check --json` mixes human lines with the JSON on stdout

**File:** `scripts/parity-check.ts:409-421`
**Issue:** The three `[parity:check]` summary lines, the FAIL and warning lines and the final
PASS/FAIL line all go to stdout around the JSON object. So `bun run parity:check --json | jq`
fails, even though the runbook presents `--json` as the evidence feed.
**Fix:** Under `--json`, write only the JSON object to stdout and send the human lines to
stderr.

### IN-02: `ls-remote` failure is reported as "could not ask whether origin/main is local" and can block on credentials

**File:** `scripts/parity-check.ts:352-356`, `scripts/parity-check.ts:167`
**Issue:** A failed network `ls-remote` leaves `originShaKnown` null. The failure message
then names the local object-store question, not the remote read that failed. The git child
also inherits the terminal-prompt behaviour, and its only bound is the 15 s spawn timeout.
**Fix:** Track the `ls-remote` failure separately ("could not read origin/main"). Spawn git
with `GIT_TERMINAL_PROMPT=0`.

### IN-03: `refuseSmokeUrl` rejects bracketed IPv6 loopback and refuses only `7410`

**File:** `scripts/rehearsal.ts:798-799`
**Issue:** `new URL("http://[::1]:17410").hostname` is `[::1]`, so the `::1` entry in
`SMOKE_LOOPBACK_HOSTS` never matches. `assertLoopback` in `rehearsal-env.ts` strips the
brackets, so the two checks disagree. The smoke also refuses only port `7410`, while
`PRODUCTION_PORTS` includes `7411` and `6420`.
**Fix:** Strip the brackets as `assertLoopback` does, and refuse every `PRODUCTION_PORTS`
member.

### IN-04: Duplicated `/proc` start-time parsing with a hard-coded clock tick

**File:** `scripts/rehearsal.ts:256-269`, `scripts/parity-check.ts:66-75`
**Issue:** Two copies of the btime + field-22 computation exist, both assuming
`CLK_TCK = 100`.
**Fix:** Have `rehearsal.ts` import `procStartSeconds` from `parity-check.ts`, or a shared
module. Optionally read the tick from `getconf CLK_TCK`.

### IN-05: Unused or dead parameters and properties

**File:** `scripts/rehearsal.ts:81`/`470`, `scripts/parity-check.ts:17`/`185`
**Issue:** `refusePort(port, listening)` is only ever called with `[]`. `WATCHED_PORTS`
parses `7411` and `6420` but only `7410` is used. `ConditionResult`, `Result` and `ExecStart`
are requested from `systemctl show` but never read. That last point matters with the new
`ConditionPathExists` guard: a start skipped by the condition shows only as `inactive/dead`,
with no reason given.
**Fix:** Drop the unused inputs, or use `ConditionResult=no` to name a skipped start in the
failure text.

### IN-06: `refuseCheckoutDir` is an exact string comparison

**File:** `scripts/rehearsal.ts:137-138`
**Issue:** A trailing slash, a symlinked path or a subdirectory of the production checkout
all pass the guard.
**Fix:** Compare `realpathSync(cwd)` against `realpathSync(UNIT_WORKING_DIRECTORY)`, and
refuse any path inside it.

### IN-07: `--anonymous` silently ignores an explicit `--operator`

**File:** `scripts/rehearsal.ts:121`
**Issue:** `parseOperator` returns null before looking at `raw`, so
`--anonymous --operator hermes` drops the operator without a warning.
**Fix:** Refuse when both flags are given.

### IN-08: `docs/rehearsal.md` drifts from the code

**File:** `docs/rehearsal.md:26`, `docs/rehearsal.md:91`, `docs/rehearsal.md:134-137`
**Issue:**
- `state.json` holds container *names*, not ids.
- The "operator token" is the operator surface's own bearer token, not a separately
  generated one.
- `up` returns exit `1`, not `2`, when the twin or the stores never become healthy
  (`scripts/rehearsal.ts:604`, `scripts/rehearsal.ts:663`).
**Fix:** Align the docs with the code, or change the code's exit codes to match the
documented contract.

### IN-09: Runbook rollback 1 makes `parity:check` fail by design, and the runbook does not say so

**File:** `docs/runbooks/production-parity.md:168-172`
**Issue:** Rollback 1 checks out an older known-good commit and then says "re-run the
check". The check fails `originDiffPaths` whenever HEAD and `origin/main` differ on server
paths, so after a real rollback the expected result is FAIL. The runbook does not say so.
**Fix:** State that a FAIL naming only server-path drift from `origin/main` is expected
after rollback. Alternatively, record the rollback commit and compare against it.

---

_Reviewed: 2026-10-08T21:35:18Z_
_Reviewer: the agent (gsd-code-reviewer, executed inline by Execute16.CodeReview16 — no subagent-spawn tool was available in this runtime)_
_Depth: standard_
