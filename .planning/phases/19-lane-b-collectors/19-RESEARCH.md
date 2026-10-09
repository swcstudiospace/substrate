# Phase 19: Lane B collectors - Research

**Researched:** 2026-10-08
**Domain:** Host-side event collectors (herdr socket API, Muse native plugin hooks, Cursor hooks) feeding `substrate-mcp` under the closed v1.2 vocabulary; isolated proof on the Phase 16 harness
**Confidence:** HIGH for herdr (live-probed on a throwaway named session) and for Muse plugin mechanics (live-probed in a scratch HOME); MEDIUM for the Muse PostToolUse envelope in a real model turn (binary string table plus `hook test` only)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

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

  `pane.agent_detected`, `pane.exited`, `pane.created` and `pane.closed` are global subscription types with no `pane_id`, so one long-lived global connection carries them. `pane.agent_status_changed` requires `pane_id`, so each pane gets its own connection. A dead pane takes down only its own connection, as in September's isolation rule.

  The researcher re-verifies live the global types and the push payload field names (`data.agent_status` and others).
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

  - The remaining 0.9.1 ids are `copilot`, `devin`, `droid`, `kimi`, `kilo`, `qodercli`, `qwen`, `mastracode` and `antigravity_cli`. These and any unknown id are not emitted; they are counted in `unmapped` by agent id. herdr has no Muse id.
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

  The researcher checks whether `/brief` can answer 200 with a degraded body when Greptime is unreachable. If the server marks that case, the writer treats it as a failed fetch; if it does not, the limitation is recorded rather than fixed here.
- **D19-16:** The `AGENTS.md` pointer stays at exactly one marker block, however many times the writer runs.
  - If several blocks exist, they collapse into one at the first block's position.
  - Bytes outside the markers stay identical.
  - A missing file is created.
  - The file is written by tmp + rename, and only when its content changes.
  - The pointer is also ensured after a failed fetch.
  - Each `.substrate/` that `git check-ignore` reports as not ignored is added to that repo's `.git/info/exclude`. This is local only and never committed, so a brief cannot be committed by accident.
- **D19-17:** The writer emits no event (Phase 17's silent `muse.brief_writer`). Its per-repo `last_success`, `last_failure` and counters live in `/var/lib/substrate/muse-offsets.json`; that path is unchanged, and the unit's wrong "byte offsets per session log" comment is corrected.

  The writer keeps `--once` and `--watch`, with the 5-minute period (`POLL_MS = 300000`).

### Muse plugin and hook (LANEB-04)
- **D19-18:** The hook template is ported with these changes:
  - `repo` is the origin slug, not September's `--show-toplevel` path, and `branch` comes from git in the hook's working directory;
  - the payload follows the `muse.tool_call` row: `tool` (from `tool_name`), plus `outcome`, `duration_ms` and `tool_use_id` when the envelope carries them, all passed through `redactValue`;
  - `session_id` comes from the envelope, `actor` is `"agent"`, and the summary is `muse called <tool>`;
  - the emit is inline and fail-open with a 1.5 s timeout;
  - the hook appends refused emits to `refused-emits.jsonl` as in D19-05;
  - it always exits 0 and prints nothing.

  The researcher pins the PostToolUse envelope fields from Muse 1.4.4's bundled plugin contract docs.
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

  The proof installs into an isolated Muse scope and never into the operator's user scope. The researcher picks the mechanism: a scratch data home through Muse's home/XDG override, or `--scope project` in the scratch repo.

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
- **D19-27:** herdr isolation: the preferred path is a scratch herdr named session (`--session substrate-proof-<tag>`) on the same 0.9.1 binary, if it can run headless. The researcher verifies this.

  The fallback is a labelled scratch workspace on the default socket, closed at the end. Under the fallback, the live September herdr collector also sees the scratch pane and posts it to production, so that fallback needs operator approval (open item 1).
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

### Deferred Ideas (OUT OF SCOPE)
- Operator-configured herdr output matchers (`pane.output_matched` with a real regex), mapped to `herdr.other`.
- A spool or retry queue for emits during an outage (today an outage drops events and counts them, as grok does).
- Per-collector production tokens: the unit hook exists (D19-23); provisioning is Phase 20.
- LANEB-08: herdr-hosted dispatch and an Orca tee collector.

### Open for the operator (do not block planning; from CONTEXT)
1. **herdr proof fallback.** If herdr 0.9.1 cannot run an isolated named session headless, the proof must use a scratch workspace on the default socket. The live September herdr collector would then post that scratch pane's events to production `:7410`. Approve the fallback, or approve stopping that unit for the proof window.
2. **A real Muse model turn.** The default proof runs the installed hook through `muse plugins hook test` and uses no model. A real headless Muse turn in R spends model quota and is optional, with operator approval.
3. **Post-merge cutover window** (D19-24): restart both units onto `main`, project the plugin into user-scope Muse, and `--check` the Cursor hooks.
4. **The writer edits `.git/info/exclude`** in each `SUBSTRATE_MUSE_REPOS` repo, local only, plus the tracked `AGENTS.md` pointer that September already wrote (accepted default).

> Research outcome for open item 1: **herdr 0.9.1 runs an isolated headless named session** (verified below), so the fallback is not needed and no operator approval is required for the herdr part of the proof.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LANEB-01 | The herdr collector runs from `main` as `substrate-collector-herdr.service`: it bootstraps from `session.snapshot`, holds one `events.subscribe` per connection, reconciles every 5 s with dedupe offsets, and posts fail-open to `POST /events`. [VERIFIED: .planning/REQUIREMENTS.md:31] | Live wire facts (§ Verified herdr 0.9.1 wire facts): global vs per-pane subscription, underscore vs dotted event names, second subscribe resets the connection, bad `pane_id` kills only its connection. Reconciler state machine (Pattern 3). Unit facts (Pattern 9). |
| LANEB-02 | herdr events use main's vocabulary: surface = the agent herdr detected, repo = the origin slug of the pane's working directory, detected → `session.start`, exited → `session.end`, status change → `note` with `payload.status` and `runtime: herdr`. [VERIFIED: .planning/REQUIREMENTS.md:32] | `IntegrationTarget` enum verified (17 ids), PaneInfo fields verified, `EVENT_SOURCES` rows planned by Phase 17 (Pattern 4), `herdr.pane_exited` row amendment (Pitfall 6). |
| LANEB-03 | The Muse brief writer … fetches `POST /brief` as surface `muse` keyed by repo slug, writes a redacted `<repo>/.substrate/BRIEF.md` and an idempotent `AGENTS.md` pointer, refreshes every 5 minutes and keeps the last good file when a fetch fails. [VERIFIED: .planning/REQUIREMENTS.md:33] | `/brief` always answers 200, no degraded marker (§ `/brief` degraded body). Pointer collapse algorithm, `--git-path info/exclude` worktree trap (Pattern 5, Pitfall 9). |
| LANEB-04 | The Muse plugin is projected, validated and approved; its PostToolUse hook emits `tool.call` as surface `muse` with repo and branch from git, importing the redactor from a stable installed path rather than the operator checkout. [VERIFIED: .planning/REQUIREMENTS.md:34] | Bundle with `hooks/redact.ts` validates clean; `update` re-reads the source and resets approval; **hook env is scrubbed** so URL/token/state dir must come from a projected config file (Pattern 6/7, Pitfall 1). Lock rule 1 does not see the string-array import (verified with Phase 18's regexes). |
| LANEB-05 | Collectors never block an agent, keep their offsets across restarts, and count refused emits where the operator can see them … [VERIFIED: .planning/REQUIREMENTS.md:35] | Status → outcome mapping verified against `server.ts` (Pattern 1). Grok state-file counters (Pitfall 11). First-run seeding (Pitfall 4). |
| LANEB-07 | Proof (isolated): a herdr pane going working → idle in repo R and a Muse tool call in R appear in `events_query(repo=R)` within 10 s … zero refused emits, and R's `.substrate/BRIEF.md` lists them on its next refresh. [VERIFIED: .planning/REQUIREMENTS.md:37] | Named headless herdr session verified; Muse scratch-HOME isolation verified; harness `consumer.env` keys and guard helpers verified in the Phase 16 worktree (Pattern 11). |
| SKILL-06 | The Cursor `stop` hook runs from `main`: it copies a redacted transcript to `/var/lib/substrate/transcripts/cursor` and emits `session.end`. [VERIFIED: .planning/REQUIREMENTS.md:46] | Live `hooks.json` `stop` entry equals acc30a8's `script()` output byte for byte; transcripts dir exists empty 0700 (Runtime State Inventory). Symlink TOCTOU hardening (Security Domain). |
</phase_requirements>

## Project Constraints (from AGENTS.md)

No `CLAUDE.md` exists in the worktree. `AGENTS.md` carries the desk rules [VERIFIED: AGENTS.md:7-13]:
- **No secrets.** Never print, commit, or echo tokens, keys, passphrases, or bus secrets. Reference environment variables by name only. Do not write tailnet names or internal hostnames into the repo, the pull request, or the session transcript.
- **Greptile gate via Desk Quality.** Every PR goes through the Greptile merge gate; a FAILED, SKIPPED or unavailable review is a blocker, never a pass.
- **Draft PR only** applies to Cursor cloud agents; the v1.3 run rules (STATE.md) govern this milestone's shipping (one PR per phase, `ultrathink-ship --ignore-gsd`, Greptile 5/5, auto-merge) [VERIFIED: .planning/STATE.md:29-32].
- Run rules: every live run (production service, real stores, model quota) waits for operator approval; failures already present at HEAD are recorded, not fixed [VERIFIED: .planning/STATE.md:32].
- `AGENTS.md` itself already carries the substrate-brief marker block at lines 1-5, the exact block September's writer produces [VERIFIED: AGENTS.md:1-5; `git show ab62c91:AGENTS.md`].

## Summary

The September port sources are sound in shape but **were wrong about herdr's wire format**, and that error is visible on this host today. Global lifecycle pushes arrive with **underscore** event names (`"event":"pane_agent_detected"`, `"pane_closed"`, `"pane_exited"`, `"pane_created"`, with the same string in `data.type`), while the per-pane status push arrives with the **dotted** name (`"event":"pane.agent_status_changed"`, no `data.type`) [VERIFIED: live probe on a throwaway named session, transcript below]. September's mapper switched on `"pane.agent_detected"` and `"pane.exited"`, so those events fell through to its default branch, and every herdr event carried surface `herdr`, which main's `normalizeEvent` rejects with 400. The live offsets file contains signature keys `<pane>:pane_agent_detected` and `<pane>:pane_exited` [VERIFIED: key shapes of `/var/lib/substrate/herdr-offsets.json`]. The September collector's `emit()` discarded the status, so this was silent. That is exactly the failure LANEB-05 exists to make visible. Also verified: `pane.close` produces `pane_closed`, not `pane_exited`; a shell exiting produces `pane_exited` followed by `pane_agent_detected` with `released: true`. The snapshot-as-truth reconciler of D19-08 is therefore the right design, and the mapper must normalise both spellings.

**Muse runs hooks with a scrubbed environment.** Under `muse plugins hook test` the hook process saw only `CLAUDE_PLUGIN_DATA, CLAUDE_PLUGIN_ROOT, HOME, LANG, LOGNAME, MUSE_PLUGIN_DATA_DIR, MUSE_PLUGIN_ID, MUSE_PLUGIN_ROOT, PATH, PLUGIN_DATA, PLUGIN_ROOT, TERM, USER`. `SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, `SUBSTRATE_STATE_DIR` and an arbitrary probe variable were all dropped [VERIFIED: probe hook dump]. D19-18's env-based emit therefore cannot work. Worse, in the proof the hook would silently fall back to `http://127.0.0.1:7410` and post to production. The hook must read its URL, token-file path and state dir from a **config file written into the bundle by the projector** (`hooks/substrate.json`; validated clean alongside `hooks/redact.ts`). Everything else in the Muse plan checks out live. A scratch `HOME` isolates Muse completely. `update` re-reads the source dir and resets approval to `review_needed`, and `approve` sets `trusted_enabled`. The hook's cwd is the caller's cwd, its stdin is the fixture's `stdin` object verbatim, and a relative `./redact.ts` import resolves inside the cache.

herdr 0.9.1 runs a **headless named session** (`herdr --session <name> server`) with its own socket under `~/.config/herdr/sessions/<name>/herdr.sock`. It stops cleanly and `herdr session delete` removes it, so the proof needs no operator approval for herdr. `/brief` always answers 200 and has no degraded marker. Phase 18's planned line-anchored import regex does not see the string-array template line, so no lock exemption is needed. Phase 17's `herdr.pane_exited` row says "without repo", so this PR amends it.

**Primary recommendation:** Build herdr as a pure `reconcile(state, panes) → {transitions, state}` core, with pushes debounced into single-flight snapshot passes and a wire-name normaliser. Give the Muse hook a projected `hooks/substrate.json` (URL, token-file path, state dir; never a token value). Start every proof collector before its scenario so first-run seeding cannot swallow the events under test.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| herdr pane observation (snapshot, subscribe, reconcile) | Host collector process (`substrate-collector-herdr.service`) | herdr server (Unix socket) | Long-lived, needs socket access and local state; never inside the MCP server |
| herdr → vocabulary mapping | Pure library (`collectors/src/herdr-map.ts`) | `mcp-server/src/event-sources.ts` (contract) | Testable without a socket; asserted against `EVENT_SOURCES` |
| Fail-open emit, outcome classification, refused counting | Shared client lib (`collectors/src/emit.ts`) | `substrate-mcp` `POST /events` (status codes) | One convention for every collector and hook; server owns durability truth |
| Repo/branch attribution | Shared client lib (`collectors/src/git-context.ts`) | git CLI | Same regex as CLI and grok |
| Brief file + pointer | Host collector process (`substrate-collector-muse.service`) | `POST /brief` | Muse has no prompt-injection seam; a static file is the delivery path |
| Muse tool-call capture | Muse plugin hook (installed artifact in Muse cache) | Projector (`projector/src/muse.ts`) generates it | Hook runs inside Muse's runner with a scrubbed env; config must be baked at projection |
| Cursor transcript copy + session end | Cursor hook script (`collectors/src/cursor-stop.ts`) | Projector (`projector/src/cursor.ts`) wires it | Hook runtime; path already pinned in live `hooks.json` |
| Redaction | `mcp-server/src/redact.ts` (single source) | Write path `normalizeEvent` | Phase 18 lock; collectors redact early, server redacts again |
| Isolated proof orchestration | Repo ops script (`scripts/laneb-proof.ts`) | Phase 16 harness, scratch herdr session, scratch Muse HOME | No production store or live agent touched |

## Standard Stack

### Core
| Library / tool | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Bun runtime | 1.4.0 [VERIFIED: `bun --version`] | Every collector, hook, projector and test (`bun test`) | Repo engine `"bun": ">=1.4.0"` [VERIFIED: package.json] |
| `node:net` `createConnection` | Bun builtin | ND-JSON over the herdr Unix socket | September transport, verified live |
| `node:fs`, `node:child_process` `spawnSync` | Bun builtin | State files (tmp + rename), git calls, `muse` CLI | Existing grok/CLI pattern |
| `fetch` + `AbortSignal.timeout` | Bun builtin | `POST /events`, `POST /brief`, `/events/query` | CLI convention (`packages/cli/src/index.ts:63-74`) [VERIFIED] |
| herdr | 0.9.1, protocol 22 [VERIFIED: `herdr --version`; `ping` → `"protocol":22`] | Pane/agent source of truth | Installed on host |
| Muse Code | 1.4.4 (1.4.4-R5419.1) [VERIFIED: `muse --version`, `/root/.local/bin/.muse-version`] | Plugin host for PostToolUse hook | Installed on host |
| git | system `/usr/bin/git` | origin slug, branch, `check-ignore`, `--git-path` | Existing |

### Supporting
| Tool | Purpose | When to Use |
|---------|---------|-------------|
| `scripts/rehearsal.ts` (Phase 16) | Twin `substrate-mcp` + scratch stores; `consumer.env` | Proof wrapper (`up`/`down`) |
| `refuseSmokeUrl`, `parseShellExports`, `runDirFor`, `parseName` exported by `scripts/rehearsal.ts` [VERIFIED: phase worktree rehearsal.ts:89,187,791,804; import-safe, `main` behind `import.meta.main` at :1043] | Guard + consumer.env parsing | Import into `laneb-proof.ts`; do not copy |
| `systemd-analyze verify <unit>` | Lint unit files offline [VERIFIED: acc30a8 herdr unit verifies clean, rc 0] | Unit verification task |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Scratch `HOME` for Muse isolation | `--scope project` in R | Project scope writes Muse state into R and still reads user scope for the operator's plugins. The scratch HOME verifiably shows `plugins: []` and creates everything under it. **Use scratch HOME.** |
| Bundle-baked `hooks/substrate.json` | `$MUSE_PLUGIN_DATA_DIR/config.json` (`~/.local/share/muse/plugins/data/substrate`) | Data dir survives updates but is Muse-internal layout and is not covered by `validate` or the `--check` sha comparison. Bundle-baked is self-describing and checkable. **Use bundle-baked.** |
| `workspace.create {cwd: R}` for the scratch pane | `pane.split {cwd}` / `tab.create {cwd}` | All three accept `cwd` [VERIFIED schema]. `workspace.create` returns `root_pane` directly, and closing that pane auto-closes the workspace [VERIFIED]. **Use `workspace.create`.** |

**Installation:** none. No new packages.

## Package Legitimacy Audit

This phase installs **no external packages**. Everything uses Bun builtins plus the already-installed herdr, Muse, git and Docker (for the Phase 16 harness).

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| — | — | — | — | — | — | No packages added |

**Packages removed due to [SLOP] verdict:** none. **Packages flagged as suspicious [SUS]:** none.

## Verified herdr 0.9.1 wire facts

All from `herdr api schema --json` (byte-identical to `/tmp/herdr-schema.json`) and a throwaway named session `p19-research-1008a`, started headless, probed, stopped and deleted this session. The default session was not touched; it still lists 6 workspaces afterwards.

**Subscriptions** [VERIFIED: schema `.schemas.request.$defs.Subscription`]. Global types with only `type` required: `workspace.*`, `worktree.*`, `tab.*`, `pane.created`, `pane.closed`, `pane.updated`, `pane.focused`, `pane.moved`, `pane.exited`, `pane.agent_detected`, `layout.updated`. Types that require `pane_id`: `pane.output_matched` (also `source`, `match`), `pane.agent_status_changed` (optional `agent_status` filter), `pane.scroll_changed`.

**Push envelopes as they actually arrive** [VERIFIED: probe transcript, verbatim]:
```
[global] {"data":{"pane":{"agent_status":"unknown","cwd":"/tmp/p19-research/repo-0AgaMB",…,"pane_id":"w1:p1",…,"terminal_id":"term_65d5b12c7b50b1","workspace_id":"w1"},"type":"pane_created"},"event":"pane_created"}
[pane]   {"data":{"agent":"omp","agent_status":"working","pane_id":"w1:p1","workspace_id":"w1"},"event":"pane.agent_status_changed"}
[global] {"data":{"agent":"omp","pane_id":"w1:p1","type":"pane_agent_detected","workspace_id":"w1"},"event":"pane_agent_detected"}
[pane]   {"data":{"agent":"omp","agent_status":"idle","pane_id":"w1:p1","workspace_id":"w1"},"event":"pane.agent_status_changed"}
[global] {"data":{"agent":"omp","final_status":"unknown","pane_id":"w1:p1","released":true,"type":"pane_agent_detected","workspace_id":"w1"},"event":"pane_agent_detected"}   ← after pane.release_agent
[global] {"data":{"pane_id":"w1:p1","type":"pane_closed","workspace_id":"w1"},"event":"pane_closed"}   ← after pane.close
[global] {"data":{"pane_id":"w2:p2","type":"pane_exited","workspace_id":"w2"},"event":"pane_exited"}   ← after `exit` typed in the pane's shell
[global] {"data":{"agent":"claude","final_status":"idle","pane_id":"w2:p2","released":true,"type":"pane_agent_detected","workspace_id":"w2"},"event":"pane_agent_detected"}
```
- Lifecycle `EventKind` enum uses underscores: `"pane_created","pane_closed",…,"pane_exited","pane_agent_detected","pane_agent_status_changed"` [VERIFIED: schema `.schemas.event.$defs.EventKind.enum`]. Subscription-stream `SubscriptionEventKind` uses dots: `"pane.output_matched","pane.agent_status_changed","pane.scroll_changed"` [VERIFIED: `.schemas.subscription_event.$defs.SubscriptionEventKind`].
- `pane_agent_detected` data: `agent: string|null`, `final_status: AgentStatus|null`, `pane_id`, `released: boolean`, `workspace_id` [VERIFIED schema]. **The same event type signals both detection and release.**
- `pane.agent_status_changed` data requires `pane_id, workspace_id, agent_status` and also carries `agent, display_agent, state_labels, title` [VERIFIED schema].
- `AgentStatus` enum: `"idle","working","blocked","done","unknown"` [VERIFIED schema]. `pane.report_agent` `state` enum (`PaneAgentState`): `"idle","working","blocked","unknown"` (no `done`) [VERIFIED schema].
- Probe: `report_agent idle` → snapshot `agent_status: "idle"` (not `done`) 800 ms later on a headless server with no TUI client [VERIFIED]. `idle` and `done` both mean "ready"; which one shows depends on server "seen" state [CITED: `herdr --skill` line 59].
- **One subscribe per connection**: a second `events.subscribe` on a subscribed connection got `read ECONNRESET` [VERIFIED].
- **Bad pane id**: `{"id":"sub:badpane:sub:0:probe","error":{"code":"pane_not_found","message":"pane w999:p999 not found"}}` then close [VERIFIED]. Note the error reply's `id` is **suffixed** (`<id>:sub:0:probe`), not the request id, so match errors on prefix, or treat any `error` on a subscribe connection as fatal for that connection.
- Subscribe ack: `{"id":"<id>","result":{"type":"subscription_started"}}` [VERIFIED].
- `pane.report_agent` returns `{"type":"ok"}` and produces **both** pushes: the per-pane `pane.agent_status_changed` (~2 ms) and the global `pane_agent_detected` (~90 ms later) [VERIFIED]. `pane.release_agent {pane_id, source, agent}` → status `unknown`, agent removed from the snapshot, global `pane_agent_detected` with `released: true` [VERIFIED].
- `PaneReportAgentParams` required: `pane_id, source, agent, state`; optional `agent_session_id, agent_session_path, message, seq` [VERIFIED schema]. `agent` is a **free string**, not the `IntegrationTarget` enum.

**Snapshot** [VERIFIED schema + live]. `session.snapshot` result is `{"type":"session_snapshot","snapshot":{version, protocol, workspaces, tabs, panes, layouts, agents, focused_*}}`. `PaneInfo` required: `pane_id, terminal_id, workspace_id, tab_id, focused, agent_status, revision`; optional: `agent, agent_session{source,agent,kind,value}, cwd, foreground_cwd, display_agent, label, title, terminal_title, terminal_title_stripped, scroll, state_labels, tokens`. Live panes additionally carry `screen_detection_skipped` and `state_change_seq` [VERIFIED: live key list]. A pane with no agent has no `agent` key and `agent_status: "unknown"` [VERIFIED]. Live host: 10 panes `agent: "omp"` (idle/working), 1 pane without agent [VERIFIED; values not recorded].

**Creating and closing a scratch pane** [VERIFIED]. `workspace.create {cwd, label, focus:false}` → `{"type":"workspace_created","workspace":{…},"tab":{…},"root_pane":PaneInfo}` with `root_pane.cwd` = the given cwd. `pane.split {target_pane_id, direction, cwd}` → `{"type":"pane_info","pane":{…}}`. `pane.close {pane_id}` → `ok`; closing the root (only) pane removed the workspace (`workspace.list` → `[]`). `workspace.close {workspace_id}` → `ok`.

**IntegrationTarget enum** (17): `pi, omp, claude, codex, copilot, devin, droid, kimi, opencode, kilo, hermes, qodercli, qwen, cursor, mastracode, antigravity_cli, grok` [VERIFIED schema `.schemas.request.$defs.IntegrationTarget`]. It matches D19-10's mapped plus unmapped lists exactly.

**Muse reports itself to herdr as agent `muse`.** Muse 1.4.4 ships a built-in herdr integration whose `herdr_report.py` sends `pane.report_agent` with `SOURCE = "muse:herdr"` and `AGENT = "muse"` [VERIFIED: `/root/.local/share/muse/plugins/cache/builtin/herdr/hooks/*/hooks/herdr_report.py` and the string table in the binary]. Whether that integration is active in this host's Muse sessions is [UNVERIFIED]: `muse plugins inspect herdr` says "not installed", and no live pane currently shows `agent: "muse"`. See Open Question 1.

**Named headless session** [VERIFIED]:
```
$ env -u HERDR_SOCKET_PATH -u HERDR_ENV … herdr --session p19-research-1008a server
herdr server running; you can use any herdr CLI command in another terminal.
api socket: /root/.config/herdr/sessions/p19-research-1008a/herdr.sock
$ herdr --session p19-research-1008a server stop      # status → stopped
$ herdr session delete p19-research-1008a             # "deleted session p19-research-1008a"
```
- `herdr --session X <cmd>` targets X even when `HERDR_SOCKET_PATH` points at the default socket. `workspace list` returned `[]` with and without the env var, while the default session has 6 [VERIFIED].
- `session delete` leaves an empty `~/.config/herdr/sessions/` parent when it was created for this session. Research removed it with `rmdir`. The proof should `rmdir` it only if empty.
- This agent itself runs inside a herdr pane (`HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID` set). Proof children must not inherit them by accident (Pitfall 5).

## Verified Muse 1.4.4 plugin facts

- `/root/.local/bin/muse` is a wrapper that exports `MUSE_EXPERIMENTAL_PLUGINS=1` when unset, then execs `muse-launcher` [VERIFIED: file]. The launcher resolves its install dir from its own path, not `HOME`, and may self-update in the background unless `MUSE_NO_AUTO_UPDATE=1` [VERIFIED: muse-launcher:87-89,1089-1114]. **The proof sets `MUSE_NO_AUTO_UPDATE=1`.**
- **Isolation** [VERIFIED]: `HOME=<scratch>`, `XDG_*` unset, `MUSE_NO_AUTO_UPDATE=1` → `muse plugins list --json` → `[]`. After `install <bundle> --scope user` everything lives under `<scratch>/.local/share/muse/plugins/{cache/local/substrate/<sha>/package, installed.json}`. The operator's `plugins list` is unchanged before and after: `substrate` still at cache `0cc980bb…`, `ultrathink` at `9851476d…`.
- **Approval lifecycle** [VERIFIED]: after `install` → `inspect` `runtime_capabilities[].status: "review_needed"`, warning `"third-party plugin: hooks require review before activation"`. `approve substrate` → `"trusted_enabled"`. After `update substrate` (source changed) → back to `"review_needed"`. **The projector must approve after every install or update.**
- **`update` re-reads the source dir** [VERIFIED]: editing `hooks/post-tool-use.ts` in the source bundle, then `update substrate`, moved the cache from `ca1e7c3a…` → `df7a6cbb…` → `851cc5e0…`.
- **`hook test` runs regardless of approval** [VERIFIED: ran with status `review_needed`]. It does not prove approval, so the proof checks `inspect` status separately.
- **Fixture format** [VERIFIED by error messages]: `{"event":"PostToolUse","stdin":{…envelope…}}`. A fixture without `event` fails with ``fixture event must be `PostToolUse` or `post_tool_use` ``; without `stdin` it fails with ``fixture must contain `stdin` ``. The hook receives `stdin` serialized verbatim.
- **`hook test` output** [VERIFIED]: `{"decision":{…},"records":2,"terminals":[{"duration_ms":23,"event":"post_tool_use","exit_code":0,"hook_key":"plugin:substrate:post-tool-use","status":"completed","stderr":"","stdout":"",…}]}`. The proof asserts `exit_code == 0` and `stdout == ""`.
- **Hook cwd** = the cwd of the `muse plugins hook test` process [VERIFIED: `"cwd":"/tmp/p19-research/murepo"`].
- **Hook env is an allowlist** [VERIFIED]: keys `CLAUDE_PLUGIN_DATA, CLAUDE_PLUGIN_ROOT, HOME, LANG, LOGNAME, MUSE_PLUGIN_DATA_DIR, MUSE_PLUGIN_ID, MUSE_PLUGIN_ROOT, PATH, PLUGIN_DATA, PLUGIN_ROOT, TERM, USER`. `HOME` and `PATH` pass through from the caller. `MUSE_PLUGIN_DATA_DIR` = `<HOME>/.local/share/muse/plugins/data/substrate`; `MUSE_PLUGIN_ROOT` = the cache `package` dir. Whether a live model turn uses the same allowlist is [UNVERIFIED]. The ultrathink Muse hooks set their own `ULTRATHINK_HOST` in a wrapper script, which is consistent with a scrubbed env [VERIFIED: /root/claude-ultrathink/hooks/muse-post-tool].
- **Relative import from cache works** [VERIFIED]: the hook's `import { redact, redactValue } from "./redact.ts"` resolved and `redact("x")` returned `"x"`.
- **Validate** [VERIFIED]: a bundle with `.muse-plugin/plugin.json`, `hooks/post-tool-use.ts`, `hooks/redact.ts` (byte copy of main's) **and** `hooks/substrate.json` → `{"valid":true,"diagnostics":[]}`. Contract rules: manifest paths are relative, no traversal, symlinks must not escape, and "Hook source paths cannot be shared by two hook IDs" [CITED: bundled native-plugin-contract.md:54-95].
- **Installed list shape** [VERIFIED]: `muse plugins list --json` → `plugins[].plugin.id`, `.record.cache_path`, `.record.source.path`, `.record.enabled`, `.record.trust`, `.plugin.capabilities.hooks[].{id,event,command,timeout_ms,source_path}`. `inspect <id> --json` → `runtime_capabilities[].status`.
- **PostToolUse envelope** [VERIFIED under `hook test`, MEDIUM for live turns]: Muse "speaks the Claude hook protocol" [CITED: /root/claude-ultrathink/hooks/muse-post-tool header; docs/architecture.md:183]. The binary's string table groups keys as `hook_event_name ToolUseStart tool_name tool_input tool_use_id PermissionRequest …` and `PostToolUse tool_response PostToolUseFailure error is_interrupt duration_ms` [VERIFIED: `strings`/`dd` around offsets 3930488, 5892288]. The ultrathink PostToolUse reader uses `session_id, tool_name, tool_input, tool_response` [VERIFIED: pr-sync.ts:22-25], and Muse's herdr hook reads `post_stop` from the same stdin [VERIFIED: herdr_report.py:192-201]. **Conclusion:** PostToolUse carries `hook_event_name, session_id, tool_name, tool_input, tool_use_id, tool_response` (and likely `cwd`, `transcript_path`, `post_stop`). `error`, `is_interrupt` and `duration_ms` appear tied to **PostToolUseFailure**, a separate event: "Dispatch matches hook events exactly, so tool failures need their own entry beside `post-tool-use`" [VERIFIED: embedded post_tool_use_failure.py docstring]. So a PostToolUse-only hook sees successful calls and no `outcome`. The hook must treat `outcome`/`duration_ms` as optional (D19-18 already says "when the envelope carries them").
- Muse has no `matcher` for PostToolUse on this build; every tool call reaches the hook [CITED: ultrathink muse-post-tool header; list shows `"matcher":null`].

## `/brief` degraded body (D19-15 research item)

- `POST /brief` always answers `200 text/markdown` with whatever `substrate.brief()` returns [VERIFIED: server.ts:316-328].
- `composeBrief` "Never throws — a partial brief beats a blocked prompt". Every source is `.catch(swallow(...))`, which logs `[substrate] brief: <what> unavailable — …` to the server's stderr and substitutes an empty result [VERIFIED: brief.ts:107-216]. With Greptime unreachable, the recent-actions block silently disappears. With nothing else available, the body becomes `## Substrate brief: <repo> @ <branch>` plus `No substrate history for this repo yet. You are the first <surface> session here.` [VERIFIED: brief.ts:211-213].
- **No marker** distinguishes a degraded body: no header, no status, no body token. `service.brief` records `ok` only into an observer histogram [VERIFIED: service.ts:519-536].
- `GET /healthz` does expose `greptime: boolean` (and `eventsWritable`). It answers 503 when a configured ledger is not writable [VERIFIED: server.ts:61-67, 260-277; service.ts:1467-1487]. Bearer auth applies to `/healthz` as to every route [VERIFIED: server.ts:254-257].
- **Per D19-15 the limitation is recorded** in `docs/collectors.md`: "a 200 brief composed while the ledger is down can replace a richer last-good brief". An optional writer-side mitigation outside the server exists: read `/healthz` once per pass and treat `greptime !== true` as `fetch_failed` (reason `ledger_unavailable`). It is a race-narrowing heuristic, not a marker, and is the planner's call (Open Question 3).

## Architecture Patterns

### System Architecture Diagram

```
                herdr server (default socket in prod; named session in proof)
                 │ session.snapshot (fresh conn)   │ events.subscribe (global: pane.created/closed/exited/agent_detected)
                 │                                 │ events.subscribe ×N (per pane: pane.agent_status_changed)
                 ▼                                 ▼
  herdr.ts ── push = trigger ──► debounce(~150ms) + single-flight ──► snapshot ──► reconcile(state, panes)
     ▲  every 5 s timer ───────────────────────────────────────────────┘                │
     │                                                                                   ▼
     │                           transitions: start / status-note / end ──► herdr-map.ts (EVENT_SOURCES rows,
     │                                                                        HERDR_AGENT_SURFACES, git-context)
     │                                                                                   │
     │  state v2 (tmp+rename) ◄── advance on stored|refused; keep on failed ◄── emit.ts postEvent()
     │                                                                                   │ 202 stored / 4xx refused / 5xx|net|timeout failed
     │                                                                                   ├─► refused-emits.jsonl (O_APPEND, no summary/payload) + stderr
     │                                                                                   ▼
     │                                                                       substrate-mcp POST /events ──► normalizeEvent ──► ledger
     │
  Muse turn ─► PostToolUse hook (cache copy; env scrubbed) ─► reads hooks/substrate.json ─► git-context in cwd ─► inline emit (1.5 s) ─┘
  Cursor turn end ─► cursor-stop.ts (stdin, realpath guard, O_NOFOLLOW read, redact, 0600 copy) ─► emit.ts (1.5 s) ─┘

  muse.ts writer (5 min) ─► per repo: git-context slug ─► POST /brief {repo: slug, branch, surface:"muse"}
        ├─ good (2xx, non-empty) ─► redact ─► .substrate/BRIEF.md (tmp+rename, skip if unchanged)
        ├─ failed ─► leave BRIEF.md, count fetch_failed
        └─ always ─► ensure one AGENTS.md pointer block; ensure .substrate/ ignored (git --git-path info/exclude)

  collectors:status ─► reads state files' counters + refused-emits.jsonl since --since
```

### Recommended Project Structure
```
packages/collectors/src/
├── emit.ts               # postEvent → stored|refused|failed; refused-line writer; Counters helper
├── emit.test.ts
├── git-context.ts        # repoSlug(cwd), branchFor(cwd) — CLI/grok regex
├── git-context.test.ts
├── herdr-map.ts          # HERDR_AGENT_SURFACES, wire-name normaliser, transition → EventInput
├── herdr-map.test.ts     # EVENT_SOURCES conformance, enum fixture, normalizeEvent round trip
├── herdr-state.ts        # pure reconcile(state, panes, now) + load/save v2 (Claude's discretion: may live in herdr.ts)
├── herdr-state.test.ts
├── herdr.ts              # socket transport + loop, behind import.meta.main
├── muse.ts               # brief writer (exports pure helpers; CLI behind import.meta.main)
├── muse.test.ts
├── cursor-stop.ts        # port + shared emit + env path overrides
├── cursor-stop.test.ts
├── status.ts             # collectors:status (or scripts/collectors-status.ts)
├── grok.ts               # edited: shared emit + counters
packages/projector/src/
├── muse.ts               # bundle + config + validate/install|update/approve; --check; --bundle-only
├── muse.test.ts
├── cursor.ts             # + script(), --print-desired, stop entry
infra/vps/substrate-collector-{herdr,muse}.service
scripts/laneb-proof.ts
docs/collectors.md, docs/runbooks/lane-b-collectors.md
```

### Pattern 1: Shared fail-open emit (`emit.ts`)
**What:** One `postEvent(event, { timeoutMs, collector, source })` that never throws and classifies the response. The status → outcome mapping is grounded in the server: 202 `stored:true`; 503 `stored:false` [VERIFIED: server.ts:349]; 403 attribution refusal [VERIFIED: server.ts:338-341]; 400 `InvalidEventError` / bad JSON [VERIFIED: server.ts:482-489]; 401 missing or unknown token [VERIFIED: server.ts:254-257]; 503 audit-sink denial [VERIFIED: server.ts:203-214]; 500 unexpected [VERIFIED: server.ts:490-491].
**Example:**
```ts
// Source: pattern from packages/cli/src/index.ts:33-74 and server.ts status codes (verified)
export type EmitOutcome = { kind: "stored" } | { kind: "refused"; status: number; error: string } | { kind: "failed"; status?: number; error: string };

export async function postEvent(event: EventInput, opts: { timeoutMs: number }): Promise<EmitOutcome> {
	const base = (process.env.SUBSTRATE_URL?.trim() || "http://127.0.0.1:7410").replace(/\/+$/, "");
	const tok = process.env.SUBSTRATE_TOKEN?.trim(); // short local name: see Pitfall 8 (store-lock TOKEN_LITERAL)
	try {
		const res = await fetch(`${base}/events`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(opts.timeoutMs),
		});
		if (res.status === 202) return { kind: "stored" };
		const error = await res.text().catch(() => "");
		if (res.status >= 400 && res.status < 500) return { kind: "refused", status: res.status, error };
		return { kind: "failed", status: res.status, error };
	} catch (cause) {
		return { kind: "failed", error: String(cause) };
	}
}
```
Read env **at call time**, not at module load, so tests and the proof can vary it (September captured `SUBSTRATE_URL` in a module const). Hooks pass an explicit `{ url, token }` override because the Muse hook has no env (Pattern 7). The refused line is one `appendFileSync(path, line)` call per refusal. It holds `{ts, collector, source, kind, surface, status, error: redact(error).slice(0, 200)}` and never `summary` or `payload`. Name the helper something like `recordRefusal`, **not** `redact…` (Pitfall 7).

### Pattern 2: `git-context.ts`
Same regex as CLI and grok: `/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/` over `git -C <cwd> remote get-url origin` [VERIFIED: cli index.ts:53-57; grok.ts:49-56]. `branchFor` = `git -C <cwd> rev-parse --abbrev-ref HEAD` [VERIFIED: cli :59-61]. `https://github.com/substrate-rehearsal/p19-<tag>.git` → `substrate-rehearsal/p19-<tag>`. Cache the slug per cwd (grok precedent). Never cache the branch.

### Pattern 3: herdr reconciler (pure core)
**Identity:** `${pane_id}|${terminal_id}`. Pane ids are reused across workspaces (`w1:p1`, then `w2:p1`), while terminal ids are unique per terminal (`term_65d5…`) [VERIFIED probe].
**Inputs:** previous state v2 and the current snapshot `panes`. **Outputs:** transitions plus the next state.

| Condition (per identity) | Transition | Row | `herdr_type` (canonical) |
|---|---|---|---|
| no state entry, `agent` present | session.start (status in payload) | `herdr.agent_detected` | `pane.agent_detected` |
| entry exists, same agent, `agent_status` ≠ last emitted status, neither side `unknown` | note (`status`, `previous_status`) | `herdr.status_changed` | `pane.agent_status_changed` |
| entry exists, pane absent from snapshot | session.end (`end_reason: "pane_gone"`) | `herdr.pane_exited` | `pane.exited` |
| entry exists, pane present but `agent` absent | session.end (`end_reason: "agent_released"`) | `herdr.pane_exited` | `pane.exited` |
| entry exists, pane present, `agent` differs | session.end (old) then session.start (new) | both | as above |
| `agent` maps to no surface | none; `counters.unmapped[agent]++` once per identity | — | — |

- **`unknown` rule (D19-11):** keep `raw_status` and `status` (the last *emitted* known status) in state. A move into `unknown` updates only `raw_status`. Leaving `unknown` compares against `status`, so `working → unknown → idle` still emits one `working → idle` note, while `working → unknown → working` emits nothing. A start with status `unknown` is emitted (start is about presence) with `status: "unknown"` in the payload.
- **`done`:** pass it through as a status like any other (`AgentStatus` includes it) [VERIFIED].
- **State advance:** after `stored` or `refused`, advance the entry and save (tmp + rename). After `failed`, do **not** advance, so the next pass re-emits the still-true transition (D19-06, "repairs state after an outage"). Count `failed` per attempt, but rate-limit the stderr summary (D19-05, once a minute).
- **First run** (file missing, or no `version: 2`): seed every agent pane into state silently, write v2, emit nothing (D19-09). This includes a **missing file**, the grok "start at EOF" analogue (Pitfall 4).
- **Push handling:** pushes carry no truth. Any push (or connection error) marks the loop dirty, and a debounced (~150 ms) single-flight pass runs snapshot → reconcile → emit. This coalesces the status push with the `pane_agent_detected` that follows ~90 ms later [VERIFIED timing] and prevents two concurrent passes from double-emitting (Pitfall 3).
- **Connections:** one global connection subscribing `[{type:"pane.created"},{type:"pane.closed"},{type:"pane.exited"},{type:"pane.agent_detected"}]` in **one** call. One per-pane connection with `[{type:"pane.agent_status_changed",pane_id}]` for each pane in the snapshot. Open and close per-pane connections only inside the reconcile pass (5 s cadence), never in tight error loops. September's `reconnectPane` re-fetched the snapshot on every error.
- **Repo/branch:** compute only when emitting, from `cwd ?? foreground_cwd`, and store `repo`/`branch` in state so `session.end` reuses them even after the pane is gone.
- **`session_id`:** `herdr:${terminal_id}:${started_at}` with `started_at` the ISO time of the start transition. It is stable across restarts because it is stored in state.
- **Wire-name normaliser** (needed only for logging and the `herdr.other` mapping, because pushes are triggers): `{ pane_created: "pane.created", pane_closed: "pane.closed", pane_exited: "pane.exited", pane_agent_detected: "pane.agent_detected", pane_agent_status_changed: "pane.agent_status_changed", pane_output_changed: "pane.output_changed" }`. Dotted names pass through.

### Pattern 4: Mapper conformance against `EVENT_SOURCES`
Phase 17 plans `EventSource { id, phase, kind: EventKind, surface: SurfaceRule, actions?, runtime?, carriesRepo, periodic, sample(): EventInput }`, where `SurfaceRule` has variants `{fixed: Surface}`, `"herdr-agent"`, `"caller"`, `"memory-writer"`, `"lease-holder"`. It also plans `SILENT_SOURCES` containing `muse.brief_writer` [CITED: 17-01-PLAN.md:57 action text; not on `main` yet, so the executor reads the merged file]. Planned rows [CITED: 17-01-PLAN.md:57; 17-RESEARCH.md:327-332]:

| id | kind | surface rule | runtime | carriesRepo |
|---|---|---|---|---|
| `herdr.agent_detected` | session.start | herdr-agent | herdr | yes |
| `herdr.status_changed` | note | herdr-agent | herdr | yes |
| `herdr.pane_exited` | session.end | herdr-agent | herdr | **no → amend to yes (D19-11)** |
| `herdr.other` | note | herdr-agent | herdr | no |
| `muse.tool_call` | tool.call | `{fixed:"muse"}` | — | yes (+branch); payload keys `tool, outcome, duration_ms` |
| `cursor.stop` | session.end | `{fixed:"cursor"}`, `actor: "human"` | — | no |

```ts
// Source: shape per 17-RESEARCH.md:600-616 (planned) + D19-02
import { EVENT_SOURCES } from "../../mcp-server/src/event-sources.ts";
import { normalizeEvent } from "../../mcp-server/src/event.ts";
const row = (id: string) => {
	const found = EVENT_SOURCES.find((s) => s.id === id);
	if (!found) throw new Error(`no EVENT_SOURCES row ${id}`);
	return found;
};
test("status transition conforms to herdr.status_changed", () => {
	const ev = transitionToEvent(statusNote /* fixture with repo */);
	const r = row("herdr.status_changed");
	const stored = normalizeEvent(ev, null);
	expect({ kind: stored.kind, runtime: ev.payload?.runtime, action: ev.payload?.action, repo: Boolean(ev.repo) })
		.toEqual({ kind: r.kind, runtime: r.runtime, action: r.actions?.[0], repo: r.carriesRepo });
	expect(Object.values(HERDR_AGENT_SURFACES)).toContain(stored.surface); // herdr-agent rule
	expect(stored.surface).toBe(ev.surface);
});
```
For `{fixed: S}` rows assert `stored.surface === S`. Keep the `IntegrationTarget` fixture as a literal array in the test, so a herdr upgrade adding an id fails it.

### Pattern 5: Muse brief writer
- Read `SUBSTRATE_COLLECTOR_STATE` (default `${SUBSTRATE_STATE_DIR:-/var/lib/substrate}/muse-offsets.json`). The installed unit already sets `SUBSTRATE_COLLECTOR_STATE=/var/lib/substrate/muse-offsets.json`, but September's `muse.ts` never read it [VERIFIED: acc30a8 unit + muse.ts]. The file does not exist on the host today [VERIFIED].
- Fetch with `AbortSignal.timeout(3000)`. "Good" = 2xx and `text.length > 0`. Write via `writeFileSync(tmp, …, { flag: "wx" })` + `renameSync`. Compare to the existing bytes first and skip if equal.
- **Pointer collapse:** find all `START…END` pairs in order (indexOf loop). With zero pairs, append with September's separator rule (`""` / `"\n"` / `"\n\n"`) and a trailing `\n`. With one or more, keep `prefix-before-first-start` + block + the text between pairs minus the blocks + `suffix-after-last-end`. An orphan `START` without `END` (or the reverse) is malformed: leave the file untouched and count `pointer_malformed` rather than guess (Pitfall 10). The markers are `<!-- substrate-brief:start -->` / `<!-- substrate-brief:end -->` and the block text is September's four lines [VERIFIED: acc30a8 muse.ts:30-41; identical to AGENTS.md:1-5].
- **Ignore:** `git -C repo check-ignore -q .substrate/BRIEF.md` exits 0 when ignored, 1 when not, 128 for not-a-repo [VERIFIED rc probe]. When it exits 1, append `/.substrate/` to `resolve(repo, git -C repo rev-parse --git-path info/exclude)` [VERIFIED: returns `.git/info/exclude` relative for a normal repo and the absolute common-dir path for a worktree]. This repo's common exclude already has `/.substrate`, and `.gitignore:14` ignores `.substrate/` [VERIFIED].

### Pattern 6: Muse projector bundle
Files written to `MUSE_PLUGIN_DIR`:
- `.muse-plugin/plugin.json`: September manifest unchanged (schemaVersion 1, name `substrate`, hook `post-tool-use`, event `PostToolUse`, command `[BUN_BIN, "hooks/post-tool-use.ts"]`, `timeoutMs: 3000`) [VERIFIED: acc30a8 projector muse.ts:31-56; validates clean].
- `hooks/post-tool-use.ts`: the template (Pattern 7).
- `hooks/redact.ts`: header comment (`// Generated by packages/projector/src/muse.ts from packages/mcp-server/src/redact.ts — commit <c>, sha256 <h> of the source bytes`) followed by the exact source bytes. Use the commit that last touched `redact.ts` (`git log -1 --format=%H -- packages/mcp-server/src/redact.ts`), **not** `HEAD`; otherwise every unrelated merge shows as `--check` drift (Pitfall 12). Assert at projection time that the source has no `import`/`require` lines. Main's has none (exports only `REDACTED`, `redact`, `redactValue`), and September's full version with the skill engine has none either [VERIFIED: grep ab62c91 and acc30a8 redact.ts]. Phase 18 appends the skill engine verbatim [CITED: 18-02-PLAN.md Task 1].
- `hooks/substrate.json`: `{ "url": "<SUBSTRATE_URL at projection or default>", "tokenFile": "<path or null>", "stateDir": "<SUBSTRATE_STATE_DIR or default>" }`. **Never a token value.** Recommended production default `tokenFile`: `/etc/substrate/substrate-collector-muse.env`, parsed for its `SUBSTRATE_TOKEN=` line. That is the same per-collector file D19-23 gives the writer unit, so Phase 20 provisions one file. A missing file means anonymous, today's behaviour. Projector env names: `SUBSTRATE_MUSE_TOKEN_FILE` (path) and the existing `SUBSTRATE_URL` / `SUBSTRATE_STATE_DIR`.
- Then `validate --json` (`valid === true && diagnostics.length === 0`), then `install --scope user` or `update`, then `approve`. Check `inspect` status `trusted_enabled`.
- `--check`: compute the would-be bundle in a temp dir (never `MUSE_PLUGIN_DIR`). Locate the installed cache via `list --json` (`.record.cache_path`). Compare sha256 of `hooks/post-tool-use.ts`, `hooks/redact.ts` and `hooks/substrate.json`, and require status `trusted_enabled`. Exit 1 on any drift.
- `--bundle-only`: write and validate only.
- Remove `SUBSTRATE_REDACT_MODULE` (D19-19).

### Pattern 7: Muse hook template behaviour
```
read stdin (bounded, ~1 s) → JSON (tolerate BOM/empty) →
cfg = JSON.parse(readFileSync(new URL("./substrate.json", import.meta.url)))   // falls back to defaults if absent
cwd = typeof env.cwd === "string" && isDirectory(env.cwd) ? env.cwd : process.cwd()
slug/branch via git -C cwd (same regex, inline in template — the hook cannot import collectors/src)
token = cfg.tokenFile ? parse SUBSTRATE_TOKEN= line : undefined
event = { surface:"muse", kind:"tool.call", summary: redact(`muse called ${tool}`), session_id, repo: slug, branch, actor:"agent",
          payload: redactValue({ tool, tool_use_id?, outcome?, duration_ms? }) }
POST cfg.url + "/events" with 1.5 s timeout; 4xx → appendFileSync(cfg.stateDir + "/refused-emits.jsonl", line)
catch everything; print nothing on stdout; process.exit(0)
```
The hook is self-contained apart from `./redact.ts`. It cannot import `packages/collectors/src/emit.ts` from the cache, which is why the emit is inline (D19-18). Do not define any function named `redact*` in the template (Pitfall 7).

### Pattern 8: Cursor stop port
Port acc30a8 `cursor-stop.ts` with: the shared `postEvent` at 1.5 s; `root = process.env.SUBSTRATE_CURSOR_ROOT ?? "/root/.cursor"`; `destDir = process.env.SUBSTRATE_TRANSCRIPTS_DIR ?? "/var/lib/substrate/transcripts/cursor"`; refused counting; and the hardening in the Security Domain (O_NOFOLLOW open, `wx` tmp). Projector: add `script()`, `STOP_SCRIPT` beside `CLI` (`SUBSTRATE_CURSOR_STOP` env, default `/root/src/repos/agent-substrate/packages/collectors/src/cursor-stop.ts`), `stop: script(STOP_SCRIPT)`, and `--print-desired` [VERIFIED: acc30a8 diff vs ab62c91]. Live `hooks.json` holds exactly `bun /root/src/repos/agent-substrate/packages/collectors/src/cursor-stop.ts >/dev/null 2>&1 || true` under `stop`, plus the main-identical `sessionStart` and `postToolUse` entries, and 6 gsd-managed entries [VERIFIED: jq read-only]. Main's projector would today report `~ stop` as a change, because main has `stop: command("emit --kind session.end …")` [VERIFIED: diff].

### Pattern 9: Units
Installed `/etc/systemd/system/substrate-collector-{herdr,muse}.service` are byte-identical to acc30a8's copies, and grok's is identical to main's [VERIFIED: `diff -q`]. All three units have been active since 2026-09-29 16:39 UTC with 0 restarts [VERIFIED: `systemctl show`]. Port with the D19-23 changes. Add `EnvironmentFile=-/etc/substrate/substrate-collector-<name>.env` **after** the `substrate.env` line, because later `EnvironmentFile=` assignments override earlier ones [ASSUMED: systemd.exec semantics]. `substrate.env` contains no `SUBSTRATE_URL` or `SUBSTRATE_TOKEN*` key [VERIFIED: key names only], so collectors default to `http://127.0.0.1:7410`, anonymous. Keep `ProtectSystem=full`, `ProtectHome=false` (the writer writes under `/root/src`, and herdr's socket is under `/root/.config`) and `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`. Lint with `systemd-analyze verify`.

### Pattern 10: `collectors:status`
A read-only module (recommend `packages/collectors/src/status.ts` with pure `summarize(stateFiles, refusedLines, since)` plus a thin CLI). Flags: `--since <iso>`, `--state-dir <dir>` (default `SUBSTRATE_STATE_DIR`). It reads `herdr-offsets.json` `.counters`, `muse-offsets.json` `.counters` and the grok state file's counters (Pitfall 11), plus `refused-emits.jsonl` lines with `ts >= since`. It prints counters and refused lines. The proof can parse a `--json` output.

### Pattern 11: Proof sequence (`scripts/laneb-proof.ts`)
1. `bun run rehearsal up --surfaces claude-code,cursor,hermes,omp,muse --name p19` (spawned). Read `runDirFor("p19")/consumer.env` with `parseShellExports`. Keys: `SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, `SUBSTRATE_REHEARSAL_TOKENS_DIR`, `SUBSTRATE_REHEARSAL_NAME`, `SUBSTRATE_TEST_PG_URL` [VERIFIED: rehearsal-env.ts:196-207]. Token files are `tokens/<surface>` holding the token plus `\n`, dir 0700 [VERIFIED: rehearsal.ts:512-522]. The run dir is `${XDG_RUNTIME_DIR ?? "/tmp"}/substrate-rehearsal/<name>` [VERIFIED: :187-189]; `XDG_RUNTIME_DIR=/run/user/0` here. `refuseSmokeUrl(url)` refuses `:7410` and non-loopback hosts [VERIFIED: :791-801]. The default twin port is 17410 [VERIFIED: :48].
2. `mkdtemp` run dir T. Create R: `git init -b p19-<tag>`, origin `https://github.com/substrate-rehearsal/p19-<tag>.git`, and one commit so `rev-parse --abbrev-ref HEAD` resolves (an unborn branch returns `HEAD`; Pitfall 13).
3. Start the scratch herdr: spawn `herdr --session substrate-proof-<tag> server` detached, with `HERDR_*` removed from its env. Wait for the socket file.
4. Start the proof herdr collector: `bun packages/collectors/src/herdr.ts --watch --session substrate-proof-<tag>`. Its env is built explicitly: twin URL, token, `SUBSTRATE_STATE_DIR=T/state`, `SUBSTRATE_COLLECTOR_STATE=T/state/herdr-offsets.json`, `HOME`, `PATH`. **Wait until the state file exists with `version: 2`** (first-run seed done; Pitfall 4).
5. `workspace.create {cwd: R, label: "substrate-proof-<tag>"}` → `root_pane.pane_id`. `pane.report_agent {pane_id, source:"substrate-proof", agent:"omp", state:"working"}`. Poll `/events/query {repo: slug, include_payload: true, order: "asc"}` for `session.start`. Wait until the state file holds the identity, then SIGTERM, then restart, then wait for the restart's bootstrap.
6. `report_agent … state:"idle"`. Poll for a `note` with `payload.status === "idle"` and `payload.runtime === "herdr"`. Assert exactly one `session.start` for that `session_id`.
7. Muse: `HOME=T/muse-home`, `MUSE_NO_AUTO_UPDATE=1`, `XDG_*` unset. Write a token env file `T/muse-token.env` (0600) containing `SUBSTRATE_TOKEN=<twin muse token>`. Run `SUBSTRATE_URL=<twin> SUBSTRATE_STATE_DIR=T/state SUBSTRATE_MUSE_TOKEN_FILE=T/muse-token.env MUSE_PLUGIN_DIR=T/muse-plugin bun packages/projector/src/muse.ts`. Assert `inspect` status `trusted_enabled` **and** that the installed `hooks/substrate.json` url equals the twin url before any hook runs. Then, in cwd R: `muse plugins hook test substrate:post-tool-use --fixture T/fixture.json --json` with fixture `{"event":"PostToolUse","stdin":{"hook_event_name":"PostToolUse","session_id":"rh-p19-<tag>","tool_name":"read_file","tool_use_id":"tu-<tag>","tool_input":{},"tool_response":{}}}`. Assert terminal `exit_code 0`, `stdout ""`, and a `tool.call` from `muse` with `branch` within 10 s.
8. `pane.close {pane_id}` → poll for `session.end` with `repo`.
9. Brief: `SUBSTRATE_MUSE_REPOS=R bun packages/collectors/src/muse.ts --once` (state in T). Assert `BRIEF.md` contains both summaries (the brief lists `- HH:MM <surface padded to 12> <summary>` for up to 5 non-start/end rows [VERIFIED: brief.ts:150-164]). Run 5 more times and assert exactly one START marker. Run with `SUBSTRATE_URL=http://127.0.0.1:<closed port>` and assert `BRIEF.md` is byte-identical.
10. Cursor: write `T/cursor-root/projects/x/agent-transcripts/<id>.jsonl` with a runtime-assembled decoy. Pipe `{conversation_id, transcript_path, status:"completed"}` into `bun packages/collectors/src/cursor-stop.ts` with `SUBSTRATE_CURSOR_ROOT=T/cursor-root`, `SUBSTRATE_TRANSCRIPTS_DIR=T/transcripts`. Assert the copy is mode 0600 in a 0700 dir and lacks the decoy, and that `session.end` has `transcript_ref`.
11. Fail-open: run cursor-stop and the generated Muse hook (directly via `bun`, from a `--bundle-only` bundle whose config url is a closed port) with stdin. Assert exit 0, empty stdout, wall time under the bound. A closed loopback port refuses instantly; use a ~2 s bound for hooks.
12. `collectors:status --since <start> --state-dir T/state --json` → refused 0.
13. Teardown (always, in `finally`): kill the proof collector, `herdr --session … server stop`, `herdr session delete …`, `rmdir ~/.config/herdr/sessions` if empty, `rm -rf T`, `rehearsal down --name p19`.

### Anti-Patterns to Avoid
- **Switching on push event names:** the wire uses two spellings. Pushes are triggers; the snapshot is truth.
- **Top-level side effects in importable modules:** September's `herdr.ts` starts the collector at import. Every CLI module needs `if (import.meta.main)` so tests can import its pure parts. grok.ts has no guard, but nothing imports it.
- **Advancing state on `failed`:** loses the transition forever. Advance on `stored|refused` only.
- **Using `...process.env` for proof children:** leaks `HERDR_SOCKET_PATH` (default session) or operator env into the proof. Build env explicitly.
- **Trusting env inside the Muse hook:** it is not there (Pitfall 1).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Redaction / secret detection in collectors or the hook | Local regexes or `redactX` helpers | `packages/mcp-server/src/redact.ts` (`redact`, `redactValue`, `REDACTED`) | Phase 18 lock rules 1-4 fail the build |
| consumer.env parsing, production-target guard | New parser and guard | `parseShellExports`, `refuseSmokeUrl`, `runDirFor` from `scripts/rehearsal.ts` | One guard convention; import-safe |
| Event validation in tests | Ad-hoc kind/surface checks | `normalizeEvent` + `EVENT_SOURCES` | The contract test D19-02 asks for |
| Origin slug parsing | A new regex | The CLI/grok regex in `git-context.ts` | Brief keys must match what the CLI stores |
| herdr pane/workspace creation in the proof | Driving the TUI or `send-text` | Socket `workspace.create` / `pane.report_agent` / `pane.close` | Deterministic, verified |
| Plugin install state inspection | Reading `installed.json` directly | `muse plugins list --json` / `inspect --json` | Supported interface; layout is internal |

**Key insight:** every boundary here (herdr wire, Muse runner env, `/brief` semantics) behaved differently from what the September comments claimed. Rely on what was probed, and keep the logic in pure functions so the probes become fixtures.

## Runtime State Inventory

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `/var/lib/substrate/herdr-offsets.json` in the September shape: top key `lastSignature` only, 52 entries keyed `<pane>:pane_agent_detected`, `<pane>:pane_exited`, `<pane>:pane.agent_status_changed`, `<pane>:pane.output_matched` [VERIFIED: keys only]. `/var/lib/substrate/grok-offsets.json` (flat path → offset map, live grok unit). `muse-offsets.json` and `refused-emits.jsonl` absent. `/var/lib/substrate/transcripts/cursor` exists, 0700, empty [VERIFIED]. | Code: the v2 loader treats a non-v2 file as first run (silent seed, no migration needed). Grok counters must coexist with the live flat map (Pitfall 11). No data migration. |
| Live service config | `/root/.cursor/hooks.json`: substrate-managed `sessionStart`, `postToolUse`, `stop` (stop already points at `cursor-stop.ts`) [VERIFIED]. Operator user-scope Muse plugin `substrate`: cache `0cc980bb…`, source `/var/lib/substrate/muse-plugin`, `trusted_enabled`, hook imports `/root/src/repos/agent-substrate/packages/mcp-server/src/redact.ts` [VERIFIED]. Ultrathink Muse plugin also installed (untouched). | Post-merge, operator-approved (D19-24): re-project Muse (user scope) and `cursor.ts --check`. Nothing in this phase's proof. |
| OS-registered state | systemd units `substrate-collector-{herdr,muse,grok}`, active since 2026-09-29, `NRestarts=0`, running September code no longer on disk [VERIFIED: systemctl]. | Runbook only (D19-24); the proof never restarts them. |
| Secrets/env vars | `/etc/substrate/substrate.env` holds no `SUBSTRATE_TOKEN*` and no `SUBSTRATE_URL` [VERIFIED: key names]. It does hold store credentials, which collector units inherit via `EnvironmentFile=` (pre-existing). No `/etc/substrate/substrate-collector-*.env` exist yet. | None now. Phase 20 provisions per-collector files; the Muse hook token-file default should be the same path. |
| Build artifacts | `/var/lib/substrate/muse-plugin/` (September bundle, only `hooks/post-tool-use.ts` visible), plus Muse cache packages under `/root/.local/share/muse/plugins/cache/local/substrate/` [VERIFIED]. | Re-projection at cutover replaces them; `--check` detects drift. |

## Common Pitfalls

### Pitfall 1: Muse hook env is scrubbed
**What goes wrong:** the hook reads `SUBSTRATE_URL`/`SUBSTRATE_TOKEN`/`SUBSTRATE_STATE_DIR`, finds nothing, posts anonymously to `127.0.0.1:7410` and writes refused lines to `/var/lib/substrate`. In the proof that means **posting to production** and polluting the production refused file.
**Why:** Muse passes an allowlisted env to hooks [VERIFIED].
**How to avoid:** bundle-baked `hooks/substrate.json` (Pattern 6/7). The proof asserts the installed config url equals the twin url before running `hook test`.
**Warning signs:** the twin never sees a `tool.call`; production `:7410` gets a `muse called read_file`.

### Pitfall 2: herdr event-name spellings
**What goes wrong:** a switch on `"pane.agent_detected"` never matches `"pane_agent_detected"`.
**How to avoid:** normaliser table plus snapshot reconciliation. Test both spellings with verbatim probe lines as fixtures.

### Pitfall 3: Double emission from concurrent passes
**What goes wrong:** the status push and the agent-detected push (~90 ms apart) each start a reconcile; both see "no state" and both emit `session.start`.
**How to avoid:** single-flight with a dirty flag and a ~150 ms debounce. Save state before releasing the lock.

### Pitfall 4: First-run seeding swallows the proof's events
**What goes wrong:** the proof creates the pane and reports `working`, then starts the collector; the collector seeds silently and no `session.start` ever arrives.
**How to avoid:** start the collector first, wait for the v2 state file, then drive the pane. The same applies after the restart: the state file exists, so the restart is not a first run.

### Pitfall 5: This shell runs inside herdr
**What goes wrong:** proof children inherit `HERDR_SOCKET_PATH=/root/.config/herdr/herdr.sock` (the default session). A collector started without `--session` attaches to the live session. A `herdr server stop` without `--session` would stop the operator's server.
**How to avoid:** always pass `--session substrate-proof-<tag>`, which takes precedence over `HERDR_SOCKET_PATH` both in herdr's CLI [VERIFIED] and in `herdr.ts`'s resolution order. Strip `HERDR_*` from child envs. Never call `server.stop` on a socket path outside `~/.config/herdr/sessions/substrate-proof-*`.

### Pitfall 6: Phase 17 row says `herdr.pane_exited` has no repo
**What goes wrong:** the Phase 17 conformance test (`Boolean(sample.repo) === entry.carriesRepo`) and D19-11 disagree.
**How to avoid:** in this PR, set `carriesRepo: true` on `herdr.pane_exited`, add `repo` to its sample and change the doc table's repo cell [CITED: 17-01-PLAN.md:57 "herdr.pane_exited … without repo"]. `herdr.other` stays without repo, so `herdr.other` mappings must omit `repo`.

### Pitfall 7: Phase 18 lock rule 2 and rule 3 in non-test sources
**What goes wrong:** a helper named `redactError`/`redactLine` (rule 2: `redact\w*` definitions anywhere outside `redact.ts`; the `function` regex is unanchored, so it also fires inside template strings), or a `"[REDACTED"` literal in `laneb-proof.ts` or a collector (rule 3) [CITED: 18-RESEARCH.md:413-424].
**How to avoid:** name helpers `sanitizeError`/`recordRefusal`. In scripts, assert "decoy absent" or import `REDACTED` from the shared module (rule 1 allows that import). **Verified:** Phase 18's planned rule-1/2/3 regexes run over the September template with the specifier changed to `"./redact.ts"` give imports `node:fs, node:child_process, node:path` only, dynamic `[]`, defs `[]`, markers `0`. The template line `\t'import { redact, redactValue } from "./redact.ts";',` is not matched, so **no exemption is needed** [VERIFIED: /tmp probe with 18-RESEARCH Pattern 5 regexes]. Executors still run `redact-lock.test.ts`, because Phase 18's final regex may differ.

### Pitfall 8: store-lock `TOKEN_LITERAL` and `GREPTIME_` scans hit new scripts
**What goes wrong:** assigning a long identifier (16+ chars, e.g. a `harness…Value` local) to the `SUBSTRATE_TOKEN` key with `:` or `=` trips `TOKEN_LITERAL`. Any `GREPTIME_` text in a `.ts` file outside `packages/mcp-server/src` and `scripts/greptime-smoke.ts` fails "nothing else reads GREPTIME_" [VERIFIED: store-lock.test.ts:95,124-130].
**How to avoid:** short locals (`tok`), `{ ...env, SUBSTRATE_TOKEN: tok }`, and never write the word `GREPTIME_` in collectors or the proof. Lowercase `greptime` (the `/healthz` key) is fine.

### Pitfall 9: `.git/info/exclude` in worktrees
**What goes wrong:** `join(repo, ".git/info/exclude")` fails when `.git` is a file (worktree) [VERIFIED: this worktree's `.git` is a 79-byte file].
**How to avoid:** `resolve(repo, git -C repo rev-parse --git-path info/exclude)` [VERIFIED].

### Pitfall 10: Malformed pointer markers
**What goes wrong:** an orphan start marker plus September's "append if no complete pair" adds a second start marker, and "exactly one block" breaks.
**How to avoid:** detect orphan markers and leave the file untouched with a counter and log line. Test it.

### Pitfall 11: Grok state file shape
**What goes wrong:** D19-05 puts counters "in their state file", but grok's file is a flat `Record<path, number>` read by the live grok unit [VERIFIED: grok.ts:28-45].
**How to avoid:** store counters under a reserved `counters` key and make `loadOffsets` skip non-number values. Paths are absolute, so there is no collision. The old grok code tolerates the key: it only indexes `offsets[log.path]` and writes the object back. Alternatively use a sibling `grok-counters.json` (planner's call; Open Question 4).

### Pitfall 12: `--check` drift on every merge
**What goes wrong:** a header that records `HEAD` changes `hooks/redact.ts` bytes on every commit.
**How to avoid:** record the last commit that touched `redact.ts` plus the sha256 of its bytes.

### Pitfall 13: Unborn branch in scratch repos
**What goes wrong:** `git rev-parse --abbrev-ref HEAD` in a repo with no commits prints `HEAD` with a non-zero exit, so `branch` is undefined and the "tool.call with branch" assertion fails.
**How to avoid:** make an initial empty commit in R (`git commit --allow-empty -m init` with a local user config).

### Pitfall 14: Bun test path filters
**What goes wrong:** `bun test a.test.ts missing.test.ts` exits 0 if one file matches [CITED: 17-RESEARCH.md:525-538, probed on Bun 1.4.0].
**How to avoid:** run new test files one per command in verification steps.

### Pitfall 15: Muse launcher self-update during the proof
**How to avoid:** `MUSE_NO_AUTO_UPDATE=1` for every proof `muse` call. Otherwise the launcher may replace the binary in the background [VERIFIED: muse-launcher:1098-1111].

## Code Examples

### herdr socket call (verified envelope)
```ts
// Source: verified against herdr 0.9.1 (protocol 22), probe this session
// request:  {"id":"substrate:herdr:1","method":"session.snapshot","params":{}}\n
// response: {"id":"substrate:herdr:1","result":{"type":"session_snapshot","snapshot":{"panes":[…]}}}
// subscribe:{"id":"…","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.agent_detected"},{"type":"pane.exited"},{"type":"pane.created"},{"type":"pane.closed"}]}}
// ack:      {"id":"…","result":{"type":"subscription_started"}}
// push:     {"event":"pane_agent_detected","data":{"agent":"omp","pane_id":"w1:p1","type":"pane_agent_detected","workspace_id":"w1"}}
```
Use `Promise.withResolvers()` for the one-shot call helper (repo rules prefer it over executor-form `new Promise`; Phase 16 uses it in `pickFreePort` [VERIFIED: rehearsal.ts:192-193]).

### Muse hook-test fixture (verified format)
```json
{"event":"PostToolUse","stdin":{"hook_event_name":"PostToolUse","session_id":"rh-p19-TAG","tool_name":"read_file","tool_use_id":"tu-TAG","tool_input":{"path":"x"},"tool_response":{"ok":true}}}
```

### Herdr transition → event (shape)
```ts
// Source: D19-11 + EVENT_SOURCES rows (planned) — payload keys avoid SENSITIVE_KEY (redact.ts) by construction
{ surface: HERDR_AGENT_SURFACES[agent], kind: "note", actor: "agent", session_id: `herdr:${terminal_id}:${started_at}`,
  repo, branch, summary: `herdr: ${prev} → ${status} (pane ${pane_id})`,
  payload: { runtime: "herdr", herdr_type: "pane.agent_status_changed", pane_id, agent, status, previous_status: prev } }
```

## State of the Art

| Old Approach (acc30a8) | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Kinds `agent.detected/status/exited`, `brief.delivered`; surface `herdr` | `session.start`/`note`/`session.end` under the detected agent's surface; writer silent | Phase 17 vocabulary (v1.3) | Every September herdr event is a 400 on main |
| Per-pane subscribe of 4 types incl. `output_matched "."` | Global connection (4 lifecycle types) + per-pane status; no output matching | D19-07/12 | No replay spam into briefs |
| `lastSignature` dedupe of pushes | v2 per-identity state + snapshot reconciliation | D19-08/09 | Restart-safe; missed pushes repaired within 5 s |
| `emit()` returns `response.ok`, discarded | `stored`/`refused`/`failed` + refused file + counters | D19-04/05 | Vocabulary mismatches become visible |
| Hook imports the redactor by absolute operator-checkout path; reads env | `./redact.ts` copy in bundle; config in `hooks/substrate.json` | D19-19 + this research | Hook independent of checkout and of Muse's env scrub |
| `deliverTo(repo)` keyed by repo **path**; `brief.delivered` event | Keyed by origin **slug**; no event | D19-14/17 | Brief matches what herdr and Muse store |

**Deprecated/outdated:** `SUBSTRATE_REDACT_MODULE`; September's `herdr.ts` header claims ("Pushed events arrive as `{event,data}`" is right; the implied dotted lifecycle names are wrong).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | A live Muse model turn runs hooks with the same allowlisted env and cwd as `hook test` | Muse facts, Pitfall 1 | Low: the config-file design works either way; only the env-based design would differ |
| A2 | PostToolUse envelope includes `cwd`/`transcript_path`; `duration_ms` and error fields only on PostToolUseFailure | Muse facts | Low: hook treats all as optional; `outcome` would just be absent |
| A3 | Later `EnvironmentFile=` lines override earlier ones (systemd.exec) | Pattern 9 | Medium: the per-collector token would not win; verify with `systemd-analyze` / docs in the unit task |
| A4 | Single `appendFileSync` of a <4 KiB line to an `O_APPEND` file is not interleaved by concurrent writers on Linux local fs | Pattern 1 | Low: worst case a garbled refused line; `collectors:status` should skip unparsable lines |
| A5 | Muse's built-in herdr integration reports agent `muse` when Muse runs inside a herdr pane on this host | herdr facts, OQ1 | Low: without a mapping row such panes are counted `unmapped`, not lost silently |
| A6 | `EVENT_SOURCES` field names (`carriesRepo`, `runtime`, `actions`, `surface` rule) ship as Phase 17 planned | Pattern 4 | Low: tests adapt to the merged names; D19 says "the mappers use whatever ids ship there" |
| A7 | Phase 18's final lock regexes equal its research prototypes | Pitfall 7 | Low: if the lock flags the template, D19-19 allows one scoped exemption |

## Open Questions (RESOLVED)

How each question was settled:
- OQ1: RESOLVED by the amended D19-10. The `muse` row is added in plan 19-02.
- OQ2: RESOLVED as out of scope (amended D19-18). The gap is documented in `docs/collectors.md` (plan 19-04).
- OQ3: RESOLVED by the amended D19-15. The writer gets a `/healthz` pre-check in plan 19-03.
- OQ4: RESOLVED as a reserved `counters` key in the grok state file (plan 19-01).
- OQ5: RESOLVED with the `tokenFile` default `/etc/substrate/substrate-collector-muse.env` (amended D19-18, plan 19-04). Phase 20 provisions the file.

1. **Map herdr agent `muse` → surface `muse`?**
   - What we know: `pane.report_agent.agent` is a free string. Muse 1.4.4 ships a herdr integration that reports `agent: "muse"`, `source: "muse:herdr"` [VERIFIED]. Phase 17's research table listed `Muse → muse`; D19-10 says "herdr has no Muse id".
   - What's unclear: whether that integration is active in this host's Muse sessions.
   - Recommendation: add `muse: "muse"` to `HERDR_AGENT_SURFACES` as a documented non-enum reporter id, with the source cited. The enum-coverage test stays enum-only and the extra row is asserted separately. This is a small deviation from D19-10's text, grey-area auto-accept under the run rules; otherwise keep D19-10 verbatim and Muse panes count as `unmapped`.
2. **Capture failed Muse tool calls?** PostToolUse fires only on success; failures go to `PostToolUseFailure` [VERIFIED]. LANEB-04 names only PostToolUse. Recommendation: out of scope; record the gap in `docs/collectors.md`. If wanted later, add a second hook id with its **own** source file (`DuplicateHookSource` rule).
3. **`/healthz` pre-check in the writer?** The literal D19-15 path is to record the limitation, because `/brief` has no marker. The cheap mitigation is to skip the write when `/healthz` reports `greptime !== true`. Recommendation: record the limitation (D19-15 literal); offer the pre-check as a one-task optional item only if the planner judges it in scope.
4. **Grok counters location**: reserved `counters` key (recommended) vs sibling file.
5. **Muse hook token source in production**: recommended default `tokenFile = /etc/substrate/substrate-collector-muse.env` (unit-shared). Phase 20 should confirm it provisions that file.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| bun | everything | ✓ | 1.4.0 | — |
| herdr | herdr collector, proof | ✓ | 0.9.1 (protocol 22); named headless session works | — |
| muse (wrapper + launcher) | projector, proof | ✓ | 1.4.4-R5419.1 | — |
| git | git-context, writer, proof | ✓ | `/usr/bin/git` | — |
| docker | Phase 16 harness | ✓ | server 29.6.2 | — |
| Phase 16 `scripts/rehearsal.ts` | proof wrapper | ✗ on this branch (in sibling worktree, executed, not merged) | — | Phase 19 executes from a `main` that holds it (CONTEXT); proof task blocks if absent |
| Phase 17 `event-sources.ts`, `check:phase-close` | mapper tests, verification | ✗ on this branch (planned) | — | Same |
| Phase 18 `redact.ts` merge, `redact-lock.test.ts` | lock compliance | ✗ on this branch (planned) | — | Same |
| `systemd-analyze` | unit lint | ✓ | `/usr/bin/systemd-analyze` | — |
| Port 7410 | production (must NOT be used) | listening (production) | — | Guards refuse it |

**Missing dependencies with no fallback:** Phases 16-18 merged to `main` before execution (stated precondition in CONTEXT).
**Missing dependencies with fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `bun test` (Bun 1.4.0), tests beside sources as `*.test.ts` |
| Config file | none (root `package.json` `"test": "bun test"`; `tsconfig.json` includes `packages/**/*.ts`, `scripts/**/*.ts`) |
| Quick run command | `bun test ./packages/collectors/src/<file>.test.ts` (one file per command; Pitfall 14) |
| Full suite command | `bun test` and `bunx tsc --noEmit` |
| Phase gates | `bun run check:phase-close` (Phase 17), `bun test ./packages/mcp-server/src/redact-lock.test.ts`, `bun test ./packages/mcp-server/src/store-lock.test.ts`, `bun run proof:laneb` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LANEB-05 | `postEvent` maps 202→stored, 400/401/403→refused, 500/503/network/timeout→failed; never throws; bearer only when token set; reads env at call time | unit (Bun.serve on port 0) | `bun test ./packages/collectors/src/emit.test.ts` | ❌ Wave 0 |
| LANEB-05 | Refused line holds only `ts,collector,source,kind,surface,status,error`; error redacted and ≤200 chars; no summary/payload; one line per refusal | unit | same | ❌ Wave 0 |
| LANEB-02 | `repoSlug` for https/ssh/`.git`/no-origin; `branchFor` | unit (tmp git repos) | `bun test ./packages/collectors/src/git-context.test.ts` | ❌ Wave 0 |
| LANEB-02 | Each transition conforms to its `EVENT_SOURCES` row (kind, surface rule, runtime, action, carriesRepo) and survives `normalizeEvent` | unit | `bun test ./packages/collectors/src/herdr-map.test.ts` | ❌ Wave 0 |
| LANEB-02 | `IntegrationTarget` fixture (17 ids) fully classified; unknown id → unmapped; no-agent pane → nothing | unit | same | ❌ Wave 0 |
| LANEB-02 | Wire normaliser maps verbatim probe lines (both spellings); `herdr.other` redacts matched text and omits repo | unit | same | ❌ Wave 0 |
| LANEB-01 | Reconcile: start/note/end; `unknown` suppression; `done` passthrough; pane-id reuse with a new `terminal_id`; agent change → end+start; first-run (missing or v1 file) seeds silently; restart emits nothing for unchanged panes; advance on stored/refused, not failed | unit (pure) | `bun test ./packages/collectors/src/herdr-state.test.ts` | ❌ Wave 0 |
| LANEB-01 | Transport: one subscribe per connection; bad-pane error closes only that connection; debounce/single-flight produces one start for two near-simultaneous pushes | unit (fake ND-JSON server on a tmp Unix socket via `node:net`) | `bun test ./packages/collectors/src/herdr.test.ts` | ❌ Wave 0 (optional but recommended) |
| LANEB-03 | Good fetch writes redacted BRIEF via tmp+rename; unchanged content → no write; non-2xx/empty/timeout/network → byte-identical; no `/events` call ever | unit (fetch stub) | `bun test ./packages/collectors/src/muse.test.ts` | ❌ Wave 0 |
| LANEB-03 | Pointer: create; idempotent ×6; multiple blocks collapse at the first; bytes outside identical; orphan marker → untouched; ensured after a failed fetch | unit | same | ❌ Wave 0 |
| LANEB-03 | `.substrate/` not ignored → added via `--git-path info/exclude` (normal repo + worktree); idempotent; no slug → `no_slug`, skipped | unit (tmp git repos) | same | ❌ Wave 0 |
| LANEB-04 | Bundle: `hooks/redact.ts` = header + exact source bytes; hook imports `./redact.ts`; `substrate.json` has url/tokenFile/stateDir and no token value; `--bundle-only` writes only to the given dir | unit (tmp dir; `MUSE_BIN` stub script) | `bun test ./packages/projector/src/muse.test.ts` | ❌ Wave 0 |
| LANEB-04 | Generated hook run with `bun` + fixture stdin against a Bun.serve stub: emits `tool.call` from `muse` with slug and branch, payload `tool`/`tool_use_id`; dead URL → exit 0, empty stdout, < 2 s; 4xx → refused line | integration (spawn) | same | ❌ Wave 0 |
| LANEB-04 | Template passes the lock (no exemption) | lock | `bun test ./packages/mcp-server/src/redact-lock.test.ts` | ✅ after Phase 18 |
| SKILL-06 | Ported September cursor-stop tests (BOM, id regex, realpath, symlink-out refused, 20 MB cap, 0600/0700, tmp+rename, null/malformed envelopes still emit, rejecting emit swallowed, nothing on stdout) + env path overrides + refused counting | unit | `bun test ./packages/collectors/src/cursor-stop.test.ts` | ❌ Wave 0 |
| SKILL-06 | `--print-desired` `stop` entry equals the live string; `--check --path <copy of a fixture equal to live>` prints "already current" and exits 0 | unit (spawn on tmp file) | `bun test ./packages/projector/src/cursor.test.ts` | ❌ Wave 0 |
| LANEB-05 | `collectors:status` summarises counters and refused lines since `--since`; skips unparsable lines | unit | `bun test ./packages/collectors/src/status.test.ts` | ❌ Wave 0 |
| LANEB-02 | `herdr.pane_exited` row amended (`carriesRepo: true`, doc cell) | unit (Phase 17) | `bun test ./packages/mcp-server/src/event-sources.test.ts` | ✅ after Phase 17 |
| LANEB-01/03 | Unit files: ExecStart/WorkingDirectory/state paths unchanged; new EnvironmentFile/Environment lines present; syntax valid | static | `systemd-analyze verify infra/vps/substrate-collector-herdr.service infra/vps/substrate-collector-muse.service` | ❌ Wave 0 (files new) |
| LANEB-07 | End-to-end isolated proof (Pattern 11) | e2e | `bun run proof:laneb` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** the touched file's single-file `bun test` + `bunx tsc --noEmit`.
- **Per wave merge:** full `bun test`, `bun test ./packages/mcp-server/src/redact-lock.test.ts`, `bun test ./packages/mcp-server/src/store-lock.test.ts`, `bun run check:phase-close`.
- **Phase gate:** full suite green against the baseline (1129/56/0 at `ab62c91` plus Phases 16-18 additions), `bun run proof:laneb` green, before `/gsd:verify-work`.

### Wave 0 Gaps
- [ ] `packages/collectors/src/emit.test.ts`, `git-context.test.ts`, `herdr-map.test.ts`, `herdr-state.test.ts` (or `herdr.test.ts`), `muse.test.ts`, `cursor-stop.test.ts`, `status.test.ts`
- [ ] `packages/projector/src/muse.test.ts`, `packages/projector/src/cursor.test.ts`
- [ ] Fixtures: verbatim herdr probe lines (above), the 17-id `IntegrationTarget` list, the Muse `hook test` fixture format
- [ ] `package.json` scripts `proof:laneb`, `collectors:status`
- Framework install: none needed.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (client side) | Bearer `SUBSTRATE_TOKEN` from env (collectors, Cursor hook) or a root-owned token file (Muse hook); never logged, never in bundles or refused lines |
| V3 Session Management | no | — |
| V4 Access Control | yes | Server-side attribution (`attributedSurface`): non-swarm tokens may name observed surfaces [VERIFIED: mcp.ts:91-97]; collectors never use swarm tokens |
| V5 Input Validation | yes | Envelope parse with type guards; conversation id `^[A-Za-z0-9-]{8,128}$`; herdr data treated as triggers only; `normalizeEvent` on the server |
| V6 Cryptography | minimal | sha256 via `Bun.CryptoHasher` / `node:crypto` for `--check` and headers; no hand-rolled crypto |
| V7 Error handling / logging | yes | Refused lines carry status and redacted, truncated error only; stderr lines never include tokens |
| V12 Files and resources | yes | realpath containment, O_NOFOLLOW, size cap, 0600/0700, tmp + rename with `wx` |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Transcript path traversal (`transcript_path` = `../../etc/shadow`, or an id with `/`) | Information disclosure / Tampering | realpath, then `startsWith(rootReal + "/")`; id regex blocks `/` and `.` in the destination name (September guards, kept) |
| Symlink swap between check and read (TOCTOU) | Tampering | Open the realpath with `O_RDONLY|O_NOFOLLOW`, `fstat` the fd (regular file, size ≤ cap), read from the fd. Write tmp with `flag: "wx"` inside the 0700 dir, then rename. (Hardening beyond September; recommended) |
| Secrets in transcripts or briefs reaching disk | Information disclosure | `redact()` over the whole text before write (D19-15/21); the server also redacts on write; the proof's decoy is runtime-assembled and asserted absent |
| Token in Muse bundle/cache (`~/.local/share/muse/plugins/cache`, world-readable dirs) | Information disclosure | `substrate.json` holds a **path**, never the value; the projector refuses an env-derived literal; the token file is 0600 |
| Refused-emit file leaking content | Information disclosure | Fixed key set; error string `redact()`ed and truncated; never summary or payload (D19-05) |
| Proof hitting production (`:7410`) or the live herdr session | Tampering / DoS | `refuseSmokeUrl`; hook config asserted equal to the twin url; `--session substrate-proof-<tag>` only; `HERDR_*` stripped; teardown in `finally` |
| Muse scope confusion (installing into the operator's user scope) | Tampering | Scratch `HOME` + `MUSE_NO_AUTO_UPDATE=1`; the proof asserts operator `plugins list` cache paths are unchanged before and after |
| AGENTS.md / exclude write outside the named repos | Tampering | `SUBSTRATE_MUSE_REPOS` required, absolute roots only (reject relative entries); writes confined to `<repo>/AGENTS.md`, `<repo>/.substrate/`, and the git-reported exclude path |
| Hostile herdr pushes (local socket) | Spoofing | Pushes only trigger a snapshot; mapped fields come from the snapshot; summaries redacted server-side |
| Stdout injection into Cursor (`followup_message`) | Tampering | Hooks print nothing on stdout; tests assert empty stdout |

## Sources

### Primary (HIGH confidence)
- herdr 0.9.1 binary: `herdr api schema --json` (protocol 22, schema_version 1), `herdr --help`/`server`/`session`/`pane`/`workspace` help, `herdr --skill`, and a live throwaway named session `p19-research-1008a` (started, probed with raw ND-JSON, stopped, deleted)
- Muse 1.4.4: `muse plugins --help`, `hook test` error contract, scratch-HOME install/update/approve/inspect/validate/hook-test runs; bundled `native-plugin-contract.md`; built-in herdr hooks (`herdr_report.py`, `post_tool_use_failure.py`); binary string table
- Repo (this worktree, `9f7ad43`): `packages/mcp-server/src/{server.ts,brief.ts,service.ts,event.ts,types.ts,mcp.ts,redact.ts,store-lock.test.ts}`, `packages/cli/src/index.ts`, `packages/collectors/src/{grok.ts,grok-map.ts,grok-map.test.ts}`, `package.json`, `tsconfig.json`, `AGENTS.md`, `.gitignore`
- `git show acc30a8:` `packages/collectors/src/{herdr,herdr-map,herdr-map.test,muse,muse.test,cursor-stop,cursor-stop.test}.ts`, `packages/projector/src/{muse,cursor}.ts`, `infra/vps/substrate-collector-{herdr,muse}.service`, `packages/mcp-server/src/redact.ts`
- Phase 16 worktree (executed): `scripts/rehearsal.ts`, `packages/mcp-server/src/rehearsal-env.ts`
- Live host, read-only: `systemctl show`, unit `diff -q`, `/var/lib/substrate` listing and offsets key shapes, `/root/.cursor/hooks.json` substrate entries, `/etc/substrate/substrate.env` key names, `muse plugins list --json` (operator)

### Secondary (MEDIUM confidence: planned, not merged)
- Phase 17: `17-RESEARCH.md` (Pattern 1 rows, Pitfall 1), `17-01-PLAN.md` (row text), `17-03-PLAN.md` (check:phase-close)
- Phase 18: `18-CONTEXT.md` D18-12..16, `18-RESEARCH.md` Pattern 5 (lock regexes), `18-02-PLAN.md`

### Tertiary (LOW confidence)
- systemd `EnvironmentFile=` ordering semantics (A3), O_APPEND interleaving (A4): training knowledge

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, since no new dependencies and all tool versions were probed.
- Architecture: HIGH for herdr and the Muse install lifecycle (live). MEDIUM for the Muse live-turn envelope and env (A1, A2).
- Pitfalls: HIGH. Most were reproduced live or read in source; lock-rule behaviour was checked with Phase 18's prototype regexes.

**Research date:** 2026-10-08
**Valid until:** 2026-11-07, or immediately on a herdr or Muse version change (both self-update: re-run `herdr api schema --json` and the Muse env probe).

**Scratch cleanup performed:** herdr session `p19-research-1008a` stopped and deleted, empty `~/.config/herdr/sessions/` removed, default session still 6 workspaces; operator Muse scope unchanged; all probe files under `/tmp/p19-research` deleted at the end of research.
