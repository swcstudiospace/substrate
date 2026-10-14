# Phase 19: Lane B collectors - Context

**Gathered:** 2026-10-08
**Status:** Ready for planning
**Mode:** Smart discuss, auto-accepted under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"). Recommended answers were accepted. Items that touch a live system or a user-visible contract are listed under "Open for the operator" and do not block planning. After research (2026-10-08), D19-07, D19-10, D19-15, D19-16, D19-18, D19-20 and D19-27 were amended with facts verified live; see `19-RESEARCH.md`.

<domain>
## Phase Boundary

One PR on agent-substrate (LANEB-01, -02, -03, -04, -05, -07, SKILL-06). It brings the September Lane B collectors back onto `main`, re-expressed in main's vocabulary:

1. **herdr collector** (`packages/collectors/src/herdr.ts`, `herdr-map.ts`). Pane agents detected, changing status and exiting reach `POST /events` as `session.start`, `note` and `session.end` under the surface herdr detected and the origin slug of the pane's working directory.
2. **Muse brief writer** (`packages/collectors/src/muse.ts`). For each repo in `SUBSTRATE_MUSE_REPOS` it writes a redacted `.substrate/BRIEF.md` and keeps exactly one `AGENTS.md` pointer.
3. **Muse plugin** (`packages/projector/src/muse.ts`). Its PostToolUse hook emits `tool.call` as `muse`, importing the redactor from a stable installed path.
4. **Cursor `stop` hook** (`packages/collectors/src/cursor-stop.ts` plus the `stop` entry in `packages/projector/src/cursor.ts`). It copies a redacted transcript and emits `session.end`.
5. **Fail-open emit and counting** shared by every collector (LANEB-05).
6. **Units** `infra/vps/substrate-collector-{herdr,muse}.service`, at the paths the installed units already use.
7. **The isolated proof** (LANEB-07) against the Phase 16 harness, using the local herdr 0.9.1 and Muse 1.4.4.

**Out of scope:**
- Restarting the production collector units, projecting the plugin into the operator's user-scope Muse, and editing `/root/.cursor/hooks.json`. These are operator-approved steps after merge (see D19-24).
- Production tokens and `/etc/substrate/substrate.env` (Phase 20). Phase 20's UAT scenario 6 (Cursor hooks live).
- Any change to `EVENT_KINDS` or `SURFACES` (Phase 17 lock). Any redaction rule outside `redact.ts` (Phase 18 lock).
- herdr-hosted dispatch and an Orca tee collector (LANEB-08, v2).

**Depends on, none of it on `main` yet:**
- Phase 16: `scripts/rehearsal.ts` and the `consumer.env` contract.
- Phase 17: `packages/mcp-server/src/event-sources.ts` (`EVENT_SOURCES`, `SILENT_SOURCES`), `docs/event-vocabulary.md`, `bun run check:phase-close`, and the surface `substrate`.
- Phase 18: the merged `packages/mcp-server/src/redact.ts` and `redact-lock.test.ts`.

Phase 19 executes from a branch cut from a `main` that already holds all three. Planning reads their planned shapes from the sibling worktrees.

</domain>

<decisions>
## Implementation Decisions

### Port rules
- **D19-01:** Port by reading `git show acc30a8:<path>`; never merge the branch. File paths are kept exactly, because three things on this host already point at them:
  - the installed `substrate-collector-herdr` and `-muse` units (`ExecStart=… packages/collectors/src/{herdr,muse}.ts --watch`);
  - the live `/root/.cursor/hooks.json` `stop` entry (`bun /root/src/repos/agent-substrate/packages/collectors/src/cursor-stop.ts …`);
  - the Muse projector's bundle directory `/var/lib/substrate/muse-plugin`.
  The operator checkout is on `main` at `ab62c91`, where none of these collector files exist. Two consequences:
  - the two units have run September code from memory since 2026-09-29, and a restart today would fail;
  - Cursor's `stop` hook silently does nothing (`|| true`).
- **D19-02:** Phase 17's table is the contract. The mappers emit exactly these rows:
  - `herdr.agent_detected` → `session.start`;
  - `herdr.status_changed` → `note`;
  - `herdr.pane_exited` → `session.end`;
  - `herdr.other` → `note`;
  - `muse.tool_call` → `tool.call`;
  - `cursor.stop` → `session.end`;
  - silent `muse.brief_writer`, which emits nothing.

  Each mapper test asserts that its output's kind, fixed surface, `payload.runtime` and `payload.action` match the row, and that the output passes `normalizeEvent` unchanged in kind and surface. September's kinds (`agent.detected`, `agent.status`, `agent.exited`, `brief.delivered`) and its surface `herdr` do not come back. Verification includes `bun run check:phase-close`.
- **D19-03:** Every collector and hook imports `redact`/`redactValue` from `packages/mcp-server/src/redact.ts` (relative specifier in the repo). `redact-lock.test.ts` stays green, with no exemption except the narrow one D19-19 may need.

### Shared fail-open emit and refused-emit counting (LANEB-05)
- **D19-04:** Add one client module, `packages/collectors/src/emit.ts`.
  - `postEvent(event, { timeoutMs })` never throws. It returns one of three outcomes:
    - `stored`: 202;
    - `refused`: any 4xx, e.g. 400 for an unknown kind or surface, 401, or 403 for a swarm attribution refusal;
    - `failed`: 503, any other 5xx, a network error or a timeout.
  - It reads `SUBSTRATE_URL` (default `http://127.0.0.1:7410`) and sends `SUBSTRATE_TOKEN` as a bearer token when set, the CLI's client convention (`packages/cli/src/index.ts:33-40`).
  - Timeouts: 3 s in long-running collectors, at most 1.5 s in hooks.
  - Beside it, `git-context.ts` provides `repoSlug(cwd)` and `branchFor(cwd)`, using the same origin regex as the CLI's `repoSlug` and grok's `repoFor`.
  - `grok.ts` moves to the shared emit, so it counts refusals too. Nothing else in grok changes.
- **D19-05:** Refused emits are counted where the operator can see them. Each one does two things:
  1. It appends one JSON line to `${SUBSTRATE_STATE_DIR:-/var/lib/substrate}/refused-emits.jsonl`, holding `ts`, `collector`, `source` (the Phase 17 row id), `kind`, `surface`, the HTTP status and the server's `error` string (redacted and truncated). It never holds the event's summary or payload. Lines are single small `O_APPEND` writes, so concurrent hooks do not interleave.
  2. It writes one stderr line, which reaches the journal for the units.

  The long-running collectors (herdr, grok, Muse writer) also keep cumulative counters in their state file (`stored`, `refused`, `failed`, plus `unmapped` for herdr and `fetch_failed`/`no_slug` for the writer). They log a one-line summary to the journal when a counter changes, at most once a minute.

  `bun run collectors:status` prints each collector's counters and the refused lines since `--since <iso>`. It is read-only, and the proof uses it.

  The periodic `warning` event alternative was rejected for two reasons: it would need a new `EVENT_SOURCES` row, and it is lost exactly when the substrate refuses or is down.
- **D19-06:** A collector never blocks an agent.
  - Hooks always exit 0 and print nothing on stdout (Cursor auto-submits a `followup_message` found there). Their stdin read and emit are bounded.
  - Long-running collectors never wait past the timeout.
  - During an outage, events are dropped and counted as `failed`. There is no spool or retry queue, which is grok's precedent.
  - The herdr reconciler (D19-08) repairs state after an outage: the next successful pass emits the transitions that are still true.

### herdr collector (LANEB-01, LANEB-02)
- **D19-07:** The transport follows herdr 0.9.1's own schema (`herdr api schema --json`, read 2026-10-08):
  - ND-JSON over the Unix socket, with string `id`s;
  - one `events.subscribe` per connection;
  - `session.snapshot` on a fresh short-lived connection.

  Subscriptions are global or per pane:
  - **Global.** `pane.agent_detected`, `pane.exited`, `pane.created` and `pane.closed` take no `pane_id`. One long-lived global connection subscribes to all four in one call.
  - **Per pane.** `pane.agent_status_changed` requires a `pane_id`, so each pane gets its own connection. A dead pane takes down only its own connection, as in September's isolation rule.

  - **Wire names (verified live by research, 2026-10-08).** Global pushes arrive with underscores (`pane_agent_detected`, `pane_exited`, `pane_closed`, `pane_created`, with the same string in `data.type`). The per-pane push arrives dotted (`pane.agent_status_changed`).
    - A normaliser maps both spellings onto one name.
    - `pane_agent_detected` with `released: true` is a release, not a detection.
    - September matched neither spelling. Its lifecycle events went out as surface `herdr` and were refused with 400.
  - **Pushes are only triggers.** Each push marks the loop dirty. A debounced (~150 ms) single-flight pass then runs snapshot → reconcile → emit. Without it, the status push and the detection push about 90 ms later would both emit `session.start`.
  - **Per-pane connections** open and close only inside a reconcile pass, never in a tight error loop.
- **D19-08:** The snapshot is the source of truth, and pushes only trigger work.
  - Bootstrap: snapshot, then reconcile, then subscribe.
  - Every 5 s, and on every push, the collector diffs `session.snapshot` against its saved state per pane identity (`pane_id` + `terminal_id`, since pane ids are reused):
    - an agent appears → `session.start`;
    - `agent_status` changes → `note`;
    - the pane or its agent is gone → `session.end`.
  - A missed or duplicated push is therefore repaired or ignored within 5 s, inside criterion 1's 10 s budget.
- **D19-09:** Offsets.
  - The path is unchanged: `SUBSTRATE_COLLECTOR_STATE`, default `/var/lib/substrate/herdr-offsets.json`.
  - The new shape is `{ version: 2, panes: { <identity>: { agent, surface, status, session_id, repo, branch, started_at } }, counters }`, written by tmp + rename.
  - A restart reloads it and emits nothing for panes that have not changed.
  - A file without `version: 2`, such as September's `{ lastSignature }` on this host, counts as a first run. The collector seeds state silently from the snapshot and emits nothing, the way grok starts at EOF, so the cutover does not burst a `session.start` for every open pane.
- **D19-10:** The agent-to-surface table is pinned from herdr 0.9.1's `IntegrationTarget` enum and lives in `herdr-map.ts` as `HERDR_AGENT_SURFACES`:

  | herdr agent | surface |
  |---|---|
  | `claude` | `claude-code` |
  | `codex` | `codex` |
  | `opencode` | `opencode` |
  | `pi` | `pi` |
  | `omp` | `omp` |
  | `hermes` | `hermes` |
  | `cursor` | `cursor` |
  | `grok` | `grok-build` |

  - The remaining 0.9.1 ids are `copilot`, `devin`, `droid`, `kimi`, `kilo`, `qodercli`, `qwen`, `mastracode` and `antigravity_cli`. These, and any unknown id, are not emitted; they are counted in `unmapped`, by agent id.
  - One extra row is not in the enum: `muse` → `muse`. Muse 1.4.4's built-in herdr integration reports `agent: "muse"` through `pane.report_agent`, which takes a free-form string (verified by research). The test asserts this row separately from the enum coverage.
  - A pane with no agent emits nothing.
  - A test holds the 0.9.1 enum as a fixture and fails when an id is neither mapped nor explicitly unmapped.
  - `docs/event-vocabulary.md`'s herdr table is replaced with this pinned table, without the `[UNVERIFIED]` mark.
- **D19-11:** Event shape.
  - `repo` is the origin slug of the pane's `cwd` (fallback `foreground_cwd`), and `branch` comes from the same directory. A directory with no origin gives an event without `repo`, which is still emitted.
  - `actor: "agent"`.
  - The payload always carries `runtime: "herdr"`, `herdr_type` (the push type, or the equivalent type for a reconciled transition), `pane_id` and `agent`. The note adds `status` and `previous_status`.
  - `session.end` also carries `repo`. Criterion 1 finds the exit through `events_query(repo=R)`, and `brief.ts` excludes `session.start`/`session.end`, so the brief does not crowd. If Phase 17's `herdr.pane_exited` row says otherwise, this PR amends the row and the doc; Phase 17's owner has been told.
  - `session_id` stays stable for one agent run in one pane, e.g. `herdr:<terminal_id>:<started_at>`.
  - Transitions into or out of herdr's `unknown` status are recorded in state but not emitted.
  - Summaries read well in the brief, e.g. `herdr: working → idle (pane w4:p1)`.
- **D19-12:** `pane.output_matched` is kept in the mapper but not subscribed.
  - The mapper keeps the redacted `herdr.other` mapping for it, and that mapping is tested.
  - The collector does not subscribe to it. September's `"."` regex turned every output line into a note with `repo`, which would bury the repo's brief.
  - Operator-configured matchers are deferred.
- **D19-13:** The CLI shape is kept: `--once`, `--watch`, `--session <name>`, `HERDR_SOCKET_PATH`, `HERDR_SESSION`, and the default `$HOME/.config/herdr/herdr.sock` (HOME falls back to `/root`).

### Muse brief writer (LANEB-03)
- **D19-14:** `SUBSTRATE_MUSE_REPOS` is required: a colon-separated list of absolute roots, with no default (September's blast-radius rule). For each repo, each pass:
  1. resolves the slug through `git-context`;
  2. if there is no slug, skips the repo, counts it as `no_slug` and logs it;
  3. otherwise sends `POST /brief` with `{ repo: <slug>, branch, surface: "muse" }` and the bearer token.

  The brief is keyed by slug, exactly as `substrate brief` keys it, so it matches what herdr and the Muse hook store.
- **D19-15:** A good fetch is a 2xx response with a non-empty body. Anything else is a failed fetch: non-2xx, a timeout, a network error or an empty body. After a failed fetch:
  - `BRIEF.md` is left untouched;
  - `fetch_failed` is counted;
  - a journal line is written.

  On success, the writer passes the brief through `redact()` and writes `<repo>/.substrate/BRIEF.md` by tmp + rename, so a crash never leaves a partial file. It skips the write when the content is unchanged.

  `/brief` always answers 200, and nothing marks a degraded body (verified). The writer therefore makes one `GET /healthz` call per pass, before the fetches. If `greptime !== true` or the call fails, that pass counts `fetch_failed` with reason `ledger_unavailable` for every repo and writes no `BRIEF.md`. The pointer is still ensured. The remaining race, where the ledger drops between that check and a fetch, is recorded in `docs/collectors.md`.
- **D19-16:** The `AGENTS.md` pointer stays at exactly one marker block, however many times the writer runs.
  - If several blocks exist, they collapse into one at the first block's position.
  - Bytes outside the markers stay identical.
  - A missing file is created.
  - The file is written by tmp + rename, and only when its content changes.
  - The pointer is also ensured after a failed fetch.
  - Each `.substrate/` that `git check-ignore` reports as not ignored is added to the exclude file that `git rev-parse --git-path info/exclude` names. That command is used because in a worktree `.git` is a file. The change is local only and never committed, so a brief cannot be committed by accident.
- **D19-17:** The writer emits no event (Phase 17's silent `muse.brief_writer`). Its per-repo `last_success`, `last_failure` and counters live in `/var/lib/substrate/muse-offsets.json`; that path is unchanged, and the unit's wrong "byte offsets per session log" comment is corrected.

  The writer keeps `--once` and `--watch`, with the 5-minute period (`POLL_MS = 300000`).

### Muse plugin and hook (LANEB-04)
- **D19-18:** The hook template is ported with these changes:
  - `repo` is the origin slug, not September's `--show-toplevel` path, and `branch` comes from git in the hook's working directory;
  - the payload follows the `muse.tool_call` row: `tool` (from `tool_name`), plus `outcome`, `duration_ms` and `tool_use_id` when the envelope carries them, all passed through `redactValue`;
  - `session_id` comes from the envelope, `actor` is `"agent"`, and the summary is `muse called <tool>`;
  - the emit is inline and fail-open, with a 1.5 s timeout;
  - the hook appends refused emits to `<stateDir>/refused-emits.jsonl`, as in D19-05;
  - it always exits 0 and prints nothing.

  **Configuration comes from a file in the bundle, not from the environment.** Muse 1.4.4 strips hook environments down to an allowlist: `HOME`, `PATH`, `LANG`, `LOGNAME`, `TERM`, `USER` and `MUSE_PLUGIN_*`/`PLUGIN_*`/`CLAUDE_PLUGIN_*` (verified by research). `SUBSTRATE_URL`, `SUBSTRATE_TOKEN` and `SUBSTRATE_STATE_DIR` never reach the hook.
  - At projection time, the projector writes `hooks/substrate.json` from its own environment. It holds `{ url, tokenFile, stateDir }` and never a token value:
    - `url` comes from `SUBSTRATE_URL`, or defaults to `http://127.0.0.1:7410`;
    - `tokenFile` comes from `SUBSTRATE_MUSE_TOKEN_FILE`, or defaults to `/etc/substrate/substrate-collector-muse.env`, the same per-collector file the writer unit loads (D19-23);
    - `stateDir` comes from `SUBSTRATE_STATE_DIR`, or defaults to `/var/lib/substrate`.
  - The hook reads the file through `import.meta.url` and takes the `SUBSTRATE_TOKEN=` line from `tokenFile`. If the file is missing, the hook posts anonymously, as it does today.
  - The projector refuses to put any token value into the bundle.
  - PostToolUse fires only for successful tool calls; failures go to `PostToolUseFailure`, which is out of scope. `outcome` is usually absent, and `docs/collectors.md` records the gap.
- **D19-19:** The stable installed path works like this.
  - The projector copies main's `packages/mcp-server/src/redact.ts` into the bundle as `hooks/redact.ts`. That file has no imports. A header comment records the source commit and the file's sha256.
  - The hook imports `./redact.ts`.
  - `muse plugins install` and `update` copy the bundle into Muse's content-addressed cache (`~/.local/share/muse/plugins/cache/local/substrate/<hash>/package`). The hook therefore never reads the operator checkout. Today's installed hook imports `/root/src/repos/agent-substrate/packages/mcp-server/src/redact.ts`.
  - `SUBSTRATE_REDACT_MODULE` is removed.
  - The copy in the bundle is an installed artifact, not a second source (D18-16).
  - The template is a string array inside `projector/src/muse.ts`. It must not trip the lock's import rule:
    - preferably, the import line is assembled so the lock sees no `redact` import from a non-shared module;
    - otherwise the PR adds one narrowly scoped, reasoned exemption for that file.
  - `bun build` inlining was rejected: it removes the import that criterion 2 asks for, and it hides which redactor the hook carries.
- **D19-20:** The projector:
  1. writes the bundle to `MUSE_PLUGIN_DIR` (default `/var/lib/substrate/muse-plugin`);
  2. requires `muse plugins validate --json` to return `valid: true` with zero diagnostics;
  3. installs (`--scope user`) or updates;
  4. approves.

  It gains two read-only or contained modes:
  - `--check`: validates, then compares the installed hook and redactor sha256 with what main would project. It changes nothing and exits 1 on drift.
  - `--bundle-only`: writes and validates without installing.

  The proof never installs into the operator's user scope. It installs into a scratch `HOME`, with `XDG_*` unset and `MUSE_NO_AUTO_UPDATE=1` (verified to isolate Muse completely), and the proof checks that the operator's `muse plugins list` cache paths are the same before and after.
  - Every install or update resets approval to `review_needed`, so the projector approves after each one. `--check` requires `inspect` status `trusted_enabled`.
  - `muse plugins hook test` runs a hook even when it is not approved, so the proof checks approval separately.

### Cursor `stop` hook (SKILL-06)
- **D19-21:** `cursor-stop.ts` is ported with September's guards intact:
  - realpath containment under `/root/.cursor`;
  - regular files only;
  - conversation ids must match `^[A-Za-z0-9-]{8,128}$`;
  - a 20 MB cap;
  - a 0700 directory and 0600 file, written by tmp + rename;
  - `redact()` over the text;
  - `session.end` (surface `cursor`, `actor: "human"`) with `conversation_id`, `transcript_ref`, `status` and `reason`;
  - nothing on stdout, and exit 0.

  The emit goes through the shared module with the hook timeout and refused counting. `SUBSTRATE_CURSOR_ROOT` and `SUBSTRATE_TRANSCRIPTS_DIR` can override the two paths; their defaults are unchanged. The proof uses them so it never writes into the Hermes miner's live directory.
- **D19-22:** `projector/src/cursor.ts` gains September's `script()` helper and `--print-desired`.
  - The `stop` entry becomes `bun <checkout>/packages/collectors/src/cursor-stop.ts >/dev/null 2>&1 || true`. That is byte-identical to the live `hooks.json` entry, so `--check` against the live file reports "already current".
  - The checkout base sits beside the existing `SUBSTRATE_CLI` default.

### Units, live state and docs
- **D19-23:** `infra/vps/substrate-collector-{herdr,muse}.service` are ported. Unit names, `ExecStart` paths, `WorkingDirectory` and state paths are identical to the installed copies, which equal `acc30a8`'s. Three deliberate changes:
  - comments are corrected;
  - an optional `EnvironmentFile=-/etc/substrate/substrate-collector-<name>.env` is loaded after `substrate.env`, so Phase 20 can give each collector its own `SUBSTRATE_TOKEN` without editing units;
  - `Environment=SUBSTRATE_STATE_DIR=/var/lib/substrate` is set.

  `substrate-collector-grok.service` is unchanged.
- **D19-24:** The live cutover is outside this phase's proof. It is written as `docs/runbooks/lane-b-collectors.md`, which follows Phase 16's runbook directory, for an operator-approved window after merge:
  1. pull `main` in the operator checkout;
  2. install the two units and run `daemon-reload`;
  3. restart herdr and Muse;
  4. run `bun packages/projector/src/muse.ts` (user scope);
  5. run `bun packages/projector/src/cursor.ts --check`;
  6. read `bun run collectors:status`.

  The runbook also records that the units currently run code missing from disk, and the rollback: `git checkout` of the previous commit, then restart.
- **D19-25:** New topic doc `docs/collectors.md`. It covers each collector's events (linking `docs/event-vocabulary.md`), environment variables by name, state files, the refused-emit file and `collectors:status`, the herdr agent table, the Muse stable path, and the Cursor guards. README gets a link.

### Proof (LANEB-07)
- **D19-26:** The proof script is `scripts/laneb-proof.ts`, run as `bun run proof:laneb`.
  - **Guards.** It sources only `consumer.env` and refuses port 7410 or a non-loopback `SUBSTRATE_URL`.
  - **Scratch repo.** It creates a scratch repo R in a temp directory, with `git init`, a branch, and origin `https://github.com/substrate-rehearsal/p19-<tag>.git`. That slug is run-tagged and never a real repo.
  - **Proof collectors.** It starts proof instances of the collectors with their state dir and refused file in the run's temp directory.
  - **herdr flow.** It creates a scratch pane whose cwd is R, then drives it with `pane.report_agent` (`source: "substrate-proof"`, agent `omp`): first `working`, then `idle`, then it closes the pane. No model runs.
  - **Muse flow.** It projects the bundle into the isolated Muse scope, validates and approves it, then runs `muse plugins hook test substrate:post-tool-use --fixture <envelope>` inside R with the harness environment. No model runs.
  - **Event assertions.** Within 10 s, `POST /events/query` filtered to `repo=<slug>` returns:
    - `session.start`;
    - a `note` with `status: "idle"` and `runtime: "herdr"`;
    - `tool.call` from `muse` with `branch`;
    - after the pane closes, `session.end`.
  - **Restart check.** The proof collector is killed and restarted between `working` and `idle`. It emits no duplicate `session.start`, and `idle` still arrives.
  - **Brief writer.** `muse.ts --once` on R produces a `BRIEF.md` that lists both events. Five more runs leave exactly one pointer block. A run against a closed port leaves `BRIEF.md` byte-identical.
  - **Cursor stop.** A synthetic stop envelope with a scratch transcript holding a decoy secret yields a redacted copy (0600) in the scratch transcripts dir and a `session.end`.
  - **Fail-open.** With a dead URL, every hook exits 0 within its bound and prints nothing on stdout.
  - **Refused.** `collectors:status --since <start>` reports 0 refused.
  - **Wrapper.** The proof runs `rehearsal up --surfaces claude-code,cursor,hermes,omp,muse --name p19` before and `rehearsal down --name p19` after.
- **D19-27:** herdr isolation uses a scratch named session on the same 0.9.1 binary:
  - start with `herdr --session substrate-proof-<tag> server` (socket `~/.config/herdr/sessions/<name>/herdr.sock`);
  - stop with `server stop`, then `herdr session delete`.

  Research verified this headless, so the live default session is never touched and no operator approval is needed.
  - The proof strips `HERDR_*` from the environment it inherits; `--session` overrides `HERDR_SOCKET_PATH` anyway.
  - It starts each proof collector before driving that collector's scenario. Otherwise first-run seeding (D19-09) would absorb the events under test.
  - It drives the scratch pane with `workspace.create {cwd: R}`, `pane.report_agent` and `pane.close`.
- **D19-28:** Verification:
  - full `bun test` and `bunx tsc --noEmit` against the baseline (1129 pass / 56 skip / 0 fail at `ab62c91`, plus whatever Phases 16-18 add);
  - `bun run check:phase-close`;
  - `redact-lock.test.ts`;
  - `bun run proof:laneb`.

  Failures already present at HEAD are recorded, not fixed.

### Claude's Discretion
- Module boundaries inside `packages/collectors/src`, beyond `emit.ts` and `git-context.ts`, and how many plans the work splits into.
- The exact `session_id` format for herdr runs, summary wording, and the counter field names.
- Whether `collectors:status` is a script in `scripts/` or a module in `packages/collectors/src`.
- How the hook template's import line avoids the lock (assembled string or scoped exemption), as long as D19-19's constraints hold.
- The scratch-pane creation method on herdr (`pane.split`, a new workspace or tab) and the Muse isolation mechanism.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/collectors/src/grok.ts`: the fail-open emit, offsets file, `repoFor` origin slug and `--once`/`--watch` loop. `grok-map.ts`: the mapper shape and its tests.
- `packages/cli/src/index.ts:33-100`: the client conventions (`SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, `repoSlug`, `branch`, the `.substrate/BRIEF.md` write).
- `packages/projector/src/cursor.ts` (main, 110 lines): the `substrate-managed` merge, `--check`, `--remove` and the backup. `acc30a8` adds `script()` and `--print-desired` (+23 lines).
- `acc30a8` sources: `collectors/src/herdr.ts` (357), `herdr-map.ts` (105, + test 75), `muse.ts` (198, + test 120), `cursor-stop.ts` (220, + test 191), `projector/src/muse.ts` (189), and the two units (36/35 lines, identical to `/etc/systemd/system/` copies).
- `packages/mcp-server/src/redact.ts`: self-contained, with no imports, so a byte copy runs anywhere Bun does.
- Phase 16 harness: `bun run rehearsal up|down|status|smoke --name --surfaces`. `consumer.env` exports `SUBSTRATE_URL`, `SUBSTRATE_TOKEN` and `SUBSTRATE_REHEARSAL_TOKENS_DIR`.
- herdr 0.9.1 API: `session.snapshot`, `events.subscribe`, `pane.report_agent` (`pane_id`, `source`, `agent`, `state` ∈ idle/working/blocked/unknown), and `PaneInfo` (`agent`, `agent_status`, `agent_session`, `cwd`, `foreground_cwd`, `terminal_id`).
- Muse 1.4.4: `muse plugins validate|install|update|approve|inspect|hook test <plugin>:<hook> --fixture <path>`.

### Established Patterns
- `POST /events` returns 202 with `stored: true`, 503 when not stored, 400 for an invalid event, and 403 for a swarm attribution refusal. A non-swarm token may name another surface in the body (`attributedSurface`), so one collector token can post herdr's several surfaces.
- `POST /brief` takes `{ repo, branch, graph_id, surface }`. The repo is matched as stored, i.e. the slug. `brief.ts:148-165` lists recent actions per repo from every surface, excluding `session.start`/`session.end`.
- Tests sit beside sources as `*.test.ts` under `bun test`. Scripts are exposed through `package.json` (`smoke:*`, and Phase 16's `rehearsal`).
- Lock tests (`store-lock`, then `vocabulary-lock` and `redact-lock`) run in plain `bun test`.

### Integration Points
- New: `packages/collectors/src/{emit,git-context,herdr,herdr-map,muse,cursor-stop}.ts` with tests, `packages/projector/src/muse.ts` with a test, `scripts/laneb-proof.ts`, `docs/collectors.md`, `docs/runbooks/lane-b-collectors.md`, and `infra/vps/substrate-collector-{herdr,muse}.service`.
- Edited:
  - `packages/collectors/src/grok.ts` (shared emit);
  - `packages/projector/src/cursor.ts`;
  - `package.json` (`proof:laneb`, `collectors:status`);
  - `docs/event-vocabulary.md` (the pinned herdr table, and the `herdr.pane_exited` repo if needed);
  - possibly `packages/mcp-server/src/event-sources.ts` (that same row);
  - README.

</code_context>

<specifics>
## Specific Ideas

- Live facts read on this host, 2026-10-08, read-only:
  - the herdr and Muse units have been active since 2026-09-29 with 0 restarts, running September code that is no longer on disk;
  - `herdr-offsets.json` is in September's `{ lastSignature }` shape;
  - `SUBSTRATE_MUSE_REPOS` is set (5 repos);
  - `substrate.env` holds no `SUBSTRATE_TOKEN*` yet;
  - the installed Muse hook imports the redactor from the operator checkout;
  - the live herdr panes report `agent: "omp"`.
- Phase 17's research recommends the `EVENT_SOURCES` ids; the mappers use whatever ids ship there.
- Results and counters never contain a value: refused lines hold the status and the server's error string only.

</specifics>

<deferred>
## Deferred Ideas

- Operator-configured herdr output matchers (`pane.output_matched` with a real regex), mapped to `herdr.other`.
- A spool or retry queue for emits during an outage (today an outage drops events and counts them, as grok does).
- Per-collector production tokens: the unit hook exists (D19-23); provisioning is Phase 20.
- LANEB-08: herdr-hosted dispatch and an Orca tee collector.

## Open for the operator (do not block planning)

1. ~~herdr proof fallback.~~ Resolved by research: a named headless herdr session works (D19-27), so no live herdr session is touched.
2. **A real Muse model turn.** The default proof runs the installed hook through `muse plugins hook test` and uses no model. A real headless Muse turn in R spends model quota and is optional, with operator approval.
3. **Post-merge cutover window** (D19-24): restart both units onto `main`, project the plugin into user-scope Muse, and `--check` the Cursor hooks.
4. **The writer edits `.git/info/exclude`** in each `SUBSTRATE_MUSE_REPOS` repo, local only, plus the tracked `AGENTS.md` pointer that September already wrote (accepted default).

</deferred>
