# Phase 20: Production identity and Phase 0 UAT - Context

**Gathered:** 2026-10-08
**Status:** Ready for planning
**Mode:** Smart discuss, auto-accepted under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"). The recommended answers were accepted. Items that change an operator-facing contract or need a live system are listed under "Open for the operator"; they do not block planning, and the plan uses the recommended answer unless the operator overrides it.

<domain>
## Phase Boundary

One PR on agent-substrate plus one PR on `swcstudiospace/claude-ultrathink` (FOUND-04, UAT-01..04).

1. **Production identity (FOUND-04).** A runbook lists every client of production `substrate-mcp` and the token it holds. Per-surface tokens, an operator token, `SUBSTRATE_HANDOFF_KEY` and `SUBSTRATE_AUDIT_PATH` are provisioned by name in `/etc/substrate/substrate.env` by the operator (values never in the repo, never read or printed by an agent). Switch-on is ordered so that no listed client is left without a token, and it can be rolled back in one restart.
2. **Phase 0 UAT as a script (UAT-01, UAT-02).** A repeatable script runs the 8 scenarios of `.planning/milestones/v1.0-phases/00-brief/0-UAT.md` against any `SUBSTRATE_URL`, with expectations updated to today's surface, and records pass or fail with evidence per scenario.
3. **Scenario 5 (UAT-03).** Claude Code gets a `substrate` MCP entry that names its token variable, and `ultrathink-kickoff` registers each new graph through `graph_register`. This ships in claude-ultrathink.
4. **Scenario 6 (UAT-04).** The Cursor hooks (including Phase 19's `stop`) and the git post-commit collector are installed and emit live.

**State at discuss time (read-only checks, 2026-10-08; names only, no values read):**
- `/etc/substrate/substrate.env` defines no `SUBSTRATE_TOKEN_*`, `SUBSTRATE_OPERATOR_TOKENS`, `SUBSTRATE_HANDOFF_KEY` or `SUBSTRATE_AUDIT_PATH`. Production runs anonymous (`config.ts:176`: `allowAnonymous` is true exactly when no token is set).
- Once any `SUBSTRATE_TOKEN_*` is set, `server.ts:254` answers 401 before every route, **including `GET /healthz`, `/metrics` and `/slo`**. Phase 16's `parity:check` probes `/healthz` without a token today.
- `readTokens` (`config.ts:120-127`) maps one value per `SUBSTRATE_TOKEN_<SURFACE>` key. A non-swarm token may name another surface on `/events` (`attributedSurface`, `mcp.ts:91-97`); swarm tokens and, after Phase 17, the `substrate` token are bound to their own surface.
- An unknown bearer is ignored while the server is anonymous (`surfaceForToken` returns null and the body's surface is used). The Grok Bot gateway proves it today: it already sends a bearer the server does not know.
- Client inventory (ClientInventory scout, 2026-10-08):

  | Client | Runs as | Surface | Token carriage today | Live |
  |---|---|---|---|---|
  | `substrate` CLI | invoked by hooks and humans | `--surface`, default `claude-code` | env `SUBSTRATE_TOKEN` | yes |
  | Cursor hooks (`/root/.cursor/hooks.json`: sessionStart brief, postToolUse emit, stop) | Cursor | `cursor` | Cursor's env (none) | yes; `stop` no-ops until Phase 19 lands |
  | git post-commit collector | git hook | `${SUBSTRATE_SURFACE:-cursor}` | CLI env | **not installed anywhere** |
  | Grok Build collector | `substrate-collector-grok.service` | `grok-build` | env `SUBSTRATE_TOKEN` (unset) | yes |
  | Muse brief writer, herdr collector | `substrate-collector-{muse,herdr}.service` | `muse`; herdr per pane agent | env `SUBSTRATE_TOKEN`; Phase 19 adds `EnvironmentFile=-/etc/substrate/substrate-collector-<name>.env` | stale code until Phase 19's cutover |
  | Muse PostToolUse hook (Phase 19) | Muse plugin | `muse` | `tokenFile` in the bundle's `hooks/substrate.json`, default `/etc/substrate/substrate-collector-muse.env` | after Phase 19 |
  | claude-ultrathink `fetchBrief`/`emitEvent` | Claude Code plugin, Grok Build hooks (`ULTRATHINK_HOST=grok-build`), Hermes engine | `claude-code`, `grok-build`, `hermes` | env `SUBSTRATE_TOKEN`; URL from `~/.config/ultrathink/config.json` | yes, no bearer |
  | grok-hermes-connector | `grok-hermes-connector.service`, `/etc/grok-hermes/connector.env` | `grok-bot` | env `SUBSTRATE_TOKEN` (not in its env file) | yes, no bearer |
  | Grok Bot gateway (desk-gateway) | `desk-gateway.service`, `/etc/desk-gateway/gateway.env` | `grok-bot` | env `SUBSTRATE_TOKEN` **set**; its comment names `SUBSTRATE_TOKEN_DESK_GATEWAY`, which is not a surface (`.env.example:104` repeats it; `docs/grok-bot.md` says `SUBSTRATE_TOKEN_GROK_BOT`) | yes, bearer unknown to the server |
  | Agent swarm | `swarm_run.py`, per-agent env files from the v1.2 installer | `swarm-a*` | `SUBSTRATE_TOKEN` per agent env file | not installed on this host |
  | omp-ultrathink, hermes-plugin `prompt_uplift`, hermes-engineering-board, skill-autonomy `propose.py` | plugins | `omp`, `hermes`, `hermes-eng-board`, `grok-build` | env or propose key | not installed or not wired |
  | Dispatcher | `substrate-dispatcher.service` (stale, `SUBSTRATE_DISPATCH_DISABLED=1`) | none (MCP) | **no bearer support** | stale until Phase 24 |
  | substrate-host | `substrate-host.service` (inactive) | `claude-code` | **no bearer support** | until Phase 31 |
  | Skills sync / bridge, Hermes miner cron | timers and cron, failing | `claude-code`, `hermes` | env or propose key | broken until Phase 22 |
  | `chaos-smoke`, `parity:check` | manual scripts | `grok-bot`; none | env `SUBSTRATE_TOKEN`; none | manual |

  No forwarder exposes `:7410` beyond loopback.
- claude-ultrathink `origin/main` is `ed3243e` (v1.4 merged). Kickoff `SKILL.md` step 3 calls `graph_register` only "when an MCP server named `substrate` is connected", and `~/.claude.json` has none. The kickoff "one command" creates the tracker rows. Claude Code loads the plugin as 0.3.0 (`gitCommitSha 85ca1ac`) from the local marketplace at `/root/src/repos/claude-ultrathink`. `fetchBrief` sends `SUBSTRATE_TOKEN` as a bearer and injects `## Agent Substrate brief` (`src/claude/hook.test.ts:417`).

**Out of scope:**
- Restoring the dispatcher (24), the host (31) and the skills sync, bridge and miner (22). Their token is provisioned by name in this phase; their code gains bearer support in their own phases.
- Fixing hermes-engineering-board's surface or installing omp-ultrathink, hermes-plugin or skill-autonomy.
- Any change to `EVENT_KINDS` or `SURFACES` (Phase 17 lock) or to `redact.ts` (Phase 18 lock).
- Merging draft PRs #22 (identity bridge) and #23 (pinned releases). Phase 20 neither depends on nor blocks them; both rebase after the v1.3 PRs (operator decision).

**Depends on, none of it on `main` yet:** Phase 16 (`bun run rehearsal`, `consumer.env`, `parity:check`, `docs/runbooks/`), Phase 17 (`substrate` surface and its binding), Phase 18 (`redact.ts`), Phase 19 (`packages/collectors/src/emit.ts`, `cursor-stop.ts`, the collector units' per-collector env file, `docs/runbooks/lane-b-collectors.md`). Phase 20 executes from a branch cut from a `main` that holds them; planning reads their planned shapes from the sibling worktrees.

</domain>

<decisions>
## Implementation Decisions

### Identity model and token delivery
- **D20-01: Identity is per client at surface granularity.** Every token names a surface (`SUBSTRATE_TOKEN_<SURFACE>`; no new surface, no `desk-gateway` surface). Clients of one surface that run at the same trust level on this host share one value: the Cursor hooks and the git post-commit collector (`cursor`); the Claude Code plugin hooks and Claude Code's `substrate` MCP entry (`claude-code`). Clients with different trust get different values even on one surface: the operator versus the `claude-code` hooks, and the Grok Bot gateway versus grok-hermes-connector (both `grok-bot`).
- **D20-02: `SUBSTRATE_TOKEN_<SURFACE>` accepts a comma-separated list.** `readTokens` splits on commas (and whitespace, like `readReviewTokens`), trims and drops empty entries. One value stays valid, so the change is backward compatible. Boot refuses the configuration (the server exits non-zero with a message naming the two variables, never the value) when one value is listed under two surfaces, because today's `Map.set` would silently re-attribute it. Tests in `config.test.ts`/`authority.test.ts`; `.env.example` and `docs/coordination.md` document the list form and drop `SUBSTRATE_TOKEN_DESK_GATEWAY` for `SUBSTRATE_TOKEN_GROK_BOT`.
- **D20-03: The operator token is a dedicated value.** It is one extra entry in `SUBSTRATE_TOKEN_CLAUDE_CODE` (the operator works as `claude-code` through the CLI), also listed in `SUBSTRATE_OPERATOR_TOKENS`, and held only in the operator's own file (`~/.config/substrate/operator.token`, 0600). No hook, plugin or unit holds it.
- **D20-04: Client-side token resolution in agent-substrate's own clients.** The CLI (`packages/cli/src/index.ts`) and the shared collector emit (`packages/collectors/src/emit.ts`, Phase 19) resolve the bearer in this order: `SUBSTRATE_TOKEN` from the environment; otherwise the file `${SUBSTRATE_TOKENS_DIR:-/etc/substrate/tokens}/<surface>` for the surface being sent (first line, trimmed); otherwise no bearer, as today. Unreadable or missing files are not errors (fail-open). The token value is never logged. This lets the Cursor hooks and the git post-commit hook authenticate without editing `hooks.json` or putting a value in any agent config, and lets one multi-surface collector send each event under its own surface's token.
- **D20-05: The herdr collector sends each event with the token of that event's surface** (D20-04's per-surface file), falling back to its own `SUBSTRATE_TOKEN`. The `substrate` token is not used for herdr because Phase 17 binds it to its own surface. The operator therefore provisions tokens for every non-swarm surface herdr maps (`claude-code`, `codex`, `opencode`, `pi`, `omp`, `hermes`, `cursor`, `grok-build`, `muse`), and the runbook says so.
- **D20-06: External clients keep their own convention, `SUBSTRATE_TOKEN` in their environment:** grok-hermes-connector via `/etc/grok-hermes/connector.env`; the Grok Bot gateway via `/etc/desk-gateway/gateway.env` (its existing value is reused as one `SUBSTRATE_TOKEN_GROK_BOT` entry, so the gateway needs no change); Grok Build's claude-ultrathink hooks and the Hermes engine via claude-ultrathink's resolution (D20-13). Agent swarm keeps the v1.2 per-agent env files; swarm tokens are provisioned only when a workspace is installed, and the runbook lists them as "not installed".
- **D20-07: Host jobs** (dispatcher, host, skills sync and bridge, miner, the Phase 28 anchor) get `SUBSTRATE_TOKEN_SUBSTRATE` by name in their per-unit env file. Clients whose code cannot send a bearer today (dispatcher, host) or that are broken (skills sync, bridge, miner) are listed as "dormant" with the phase that restores them. Their 401s at switch-on are expected and harmless (dispatch is disabled, host is inactive, sync and bridge already fail); the runbook records the expected count instead of hiding it.
- **D20-08: No auth exemption for `/healthz`, `/metrics` or `/slo`.** The server's auth rule is unchanged. `parity:check` (Phase 16) learns to send a bearer when `SUBSTRATE_TOKEN` or `SUBSTRATE_TOKEN_FILE` is set and reports a 401 as "auth on, token missing", not "down". The Phase 19 Muse writer's `/healthz` call already carries its token.

### Switch-on sequencing and the no-strand guarantee
- **D20-09: Client first, server last.** Because the anonymous server ignores unknown bearers, every live client is given its token first, with no effect on production. Only then does the operator add the server-side variables and restart once. Rollback is commenting out the `SUBSTRATE_TOKEN_*`/`SUBSTRATE_OPERATOR_TOKENS` lines and restarting, which returns to today's anonymous mode; the handoff key and audit path may stay.
- **D20-10: The PR #22 bridge is optional, never required.** If #22 has merged before the window, the runbook's bridge variant applies: set the tokens plus `SUBSTRATE_ALLOW_ANONYMOUS=1`, restart, watch #22's anonymous-request counter fall to zero for a soak window, then remove the bridge and restart. Without #22, D20-09's ordering plus D20-11's check give the same guarantee. Nothing in Phase 20 names `SUBSTRATE_ALLOW_ANONYMOUS` in code.
- **D20-11: An identity manifest and a check, not a provisioning script.**
  - A tracked manifest (`infra/identity/clients.json`, no values) lists every client: id, surface, delivery (env file and variable, tokens-dir file, or external config), state (`live`, `after-phase-19`, `dormant:<phase>`, `not-installed`) and how its post-switch evidence is read.
  - `scripts/identity-check.ts`, run as `bun run identity:check`. The default mode is agent-safe: it reads variable **names** only and reports, per client, whether its delivery target exists and names the right variable, and whether the server env file names every required `SUBSTRATE_TOKEN_*`, `SUBSTRATE_OPERATOR_TOKENS`, `SUBSTRATE_HANDOFF_KEY` and `SUBSTRATE_AUDIT_PATH`. The `--values` mode is run by the operator only: it compares each client's value with the server's list in memory (by equality of sha256) and prints only `match`/`missing`/`mismatch` per client. Neither mode prints, logs or writes a value. Exit 1 when any `live` client would be stranded.
  - A test locks the manifest against the runbook: every manifest client appears in the runbook's table, and every surface the manifest needs is named in `.env.example`.
  - Token values are generated by the operator with a command the runbook gives (32 random bytes, hex) straight into the 0600 files; no repo script writes `/etc`.
- **D20-12: Post-switch evidence.** After the restart: `parity:check` with the operator token passes; the server's journal and request telemetry show no 401 from a `live` client over a soak window (the planner picks the read: the request span's status, or #22's refusal counter when merged); each `live` client's next event or brief after the restart is attributed to its surface (read with `events_query`). `SUBSTRATE_AUDIT_PATH` points into the unit's state directory (`/var/lib/substrate/`), and `/healthz` reports `auditDurable: true`. A signed handoff round-trips (`substrate handoff` then `/verify` or the read path the planner finds).

### UAT script
- **D20-14: Entry point `scripts/uat-phase0.ts`, run as `bun run uat:phase0`.** It is an HTTP and MCP client of `SUBSTRATE_URL` with `SUBSTRATE_TOKEN` (D20-04 resolution), like `chaos-smoke.ts`, and stays outside the store lock (no `GREPTIME_` key, no store client). Flags: `--scenarios 1,4,7,8` (default all that are allowed for the target), `--report <path>` (JSON plus a Markdown table), `--tag <run-tag>`. It sources nothing by itself; proofs source the harness's `consumer.env`.
- **D20-15: Targets and guards.** A target on port 7410 or on a non-loopback host is "production". Against production the script runs only read-only checks unless `--live <approval-ref>` is passed; scenarios that write (3's backfill, 5's kickoff check that registers, 8's emits) refuse without it. Scenario 7 refuses any target except a scratch instance it can stop or a dead port, and never stops production. Every write is run-tagged (`uat-<tag>` in `graph_id`/`session_id`). Pure parts (target classification, guards, report rendering, scenario expectations) have unit tests that need no server.
- **D20-16: Updated expectations, per scenario** (research table `FEATURES.md` "Phase 0 UAT"):
  1. MCP `tools/list` contains the 9 named v1.0 tools among today's set (not "exactly 9"), and `GET /healthz` 200, `POST /brief` 200, `POST /events` 202, `POST /verify` 200. A `/verify` result on a graph with September mixed-chain events is recorded, not hidden.
  2. Schemas and data, through the API only: `/healthz` reports `index`, `greptime`, `appendOnly` true; `events_query`, a graph read and `memory_search` return rows. The anchors table shape and raw row counts are an operator-approved read-only SQL step recorded as evidence, never in the script.
  3. Backfill: on the harness, `backfill-run.ts` with exported Notion rows then `graph_get` shows graphs with Linear identifiers. On production, `graph_get` of graph ids taken from an operator-approved read-only Notion export.
  4. The installed claude-ultrathink `fetchBrief` (or its hook entry with planning disabled, whichever research finds runs without model quota) against the target returns a brief, and the hook output contains `## Agent Substrate brief`. The plugin version and commit that served the run are recorded.
  5. Read-only: Claude Code's config has an MCP server named `substrate` whose Authorization header names `${SUBSTRATE_TOKEN}` (names only). Live: given `--graph <gid>` from a real kickoff, `graph_get` returns it with its nodes and Linear identifiers, registered by surface `claude-code`.
  6. `bun packages/projector/src/cursor.ts --check` reports the three substrate entries current and the `stop` script present; the post-commit hook is installed in the target repos. Harness: the hook commands run with synthetic envelopes in a scratch repo and the events land. Production: a real Cursor session and a real commit produce `session.start`/`tool.call`/`session.end` and `commit` for the session, read with `events_query`.
  7. `fetchBrief` and `substrate brief` against a stopped scratch instance and a dead port return within 1.5 s with an empty brief and exit 0; the Cursor hook commands exit 0 with nothing on stdout. `chaos-smoke` against the harness may be reused.
  8. Emit a `file.edit` as `cursor` on graph G, then `POST /brief` as `hermes` for G: the edit appears with other surfaces' claims.
- **D20-17: Where each scenario runs.** Scenarios 1, 4, 7 and 8 run on the Phase 16 harness (`rehearsal up --name p20`), 3 and 6 run on the harness with fixtures. Against production after switch-on, with operator approval: 1 and 2 (read-only), 3 (Notion read), 5 (one real kickoff, which writes Notion and Linear rows), 6 (real Cursor session and commit); 8 is optional on production because its rows are permanent.
- **D20-18: Recording results.** Each run writes its report. The phase records the final per-scenario result and evidence in `.planning/milestones/v1.0-phases/00-brief/0-UAT.md` (frontmatter `status`, each `result:`/`evidence:`, the Summary counts) and links the reports from `20-UAT.md`. A failing scenario is recorded as failed with its evidence; it is never re-scoped to pass. `docs/uat.md` explains how later phases run the script as a regression check.

### Cross-repo and live steps
- **D20-13: claude-ultrathink change (UAT-03), in a fresh clone at `/root/src/worktrees/claude-ultrathink-p20`** cut from `origin/main` (`ed3243e`); the operator's checkout at `/root/src/repos/claude-ultrathink` is never written. The change:
  - a `substrate` MCP entry for Claude Code whose Authorization header names `${SUBSTRATE_TOKEN}` and whose URL comes from the configured substrate URL. Research decides the mechanism, in this order of preference: an opt-in user-scope entry installed by a plugin setup command (so users without a substrate see no failing server), or a plugin-shipped `.mcp.json`. The server name must be exactly what kickoff checks for;
  - kickoff registers every new graph through `graph_register`, deterministically: the kickoff "one command" calls the MCP tool over HTTP with the bearer after it records tracking refs, fail-open with one log line, idempotent by `graph_id`; `SKILL.md` step 3 stays as the fallback when the command cannot run;
  - token resolution in `src/substrate/brief.ts` matches D20-04 (`SUBSTRATE_TOKEN`, then the per-surface tokens-dir file for the host's surface), so the Grok Build and Hermes hosts authenticate without a value in any hook config;
  - tests in that repo, and its own conventions (AGPL headers, its CHANGELOG/version bump per its rules).

  Pushing the branch, opening the PR, merging and refreshing the installed plugin (`/root/src/repos/claude-ultrathink` pulled to `main`, plugin update in Claude Code) are operator-approved live steps.
- **D20-19: Git post-commit installation.** The hook is installed with `bun packages/collectors/src/install-git-hook.ts` into the repos the runbook lists (recommended: the repos in `SUBSTRATE_MUSE_REPOS`), by the operator, because it writes into those repos' `.git/hooks`, which their worktrees share. Commits made by agents in worktrees would otherwise default to `cursor`; the runbook records how wrappers set `SUBSTRATE_SURFACE` and accepts the `cursor`/`human` default for bare commits (the hook's own comment).
- **D20-20: Live steps, each waiting for operator approval, in this order:** (1) Phase 19's collector cutover has happened (its runbook); (2) the client-side token files and env entries are written (D20-09); (3) `identity:check` names-only (agent) and `--values` (operator) pass; (4) the server variables are added and `substrate-mcp` restarts, optionally with the repo unit installed (Phase 16's runbook); (5) post-switch evidence (D20-12); (6) claude-ultrathink PR merged and plugin refreshed; (7) the git hook installed and Cursor hooks checked; (8) the production UAT run of scenarios 1, 2, 3, 5, 6 (and optionally 8). Agents never edit `/etc/substrate`, `/etc/desk-gateway`, `/etc/grok-hermes`, `~/.claude*`, `~/.cursor`, run `systemctl` state changes or read a value.
- **D20-21: Runbook `docs/runbooks/production-identity.md`.** It holds the client table from the manifest (client, surface, variable or file, state, evidence), the generation commands, the ordered window (D20-20), the bridge variant (D20-10), the expected dormant 401s (D20-07), rollback (D20-09) and key rotation (`SUBSTRATE_HANDOFF_KEY_PREV`, list-form token rotation by adding the new value before removing the old). It links Phase 16's parity runbook and Phase 19's collector runbook.
- **D20-22: Verification.** Full `bun test` and `bunx tsc --noEmit` against the baseline (plus what Phases 16-19 add), `bun run check:phase-close`, `redact-lock.test.ts`, `store-lock.test.ts`, `bun run identity:check` names-only, and `bun run uat:phase0` on the harness for 1, 3, 4, 6, 7, 8. Failures already present at HEAD are recorded, not fixed.

### Claude's Discretion
- The manifest's exact format and location, and whether the runbook table is generated from it or checked against it.
- How `identity-check.ts` reads names from env files (a strict `KEY=` parser that never retains values in names-only mode).
- Report format details, the run-tag format and the soak-window length.
- How many plans the work splits into and their waves.
- Whether scenario 4 drives `fetchBrief` directly or the hook entry, as long as no model quota is spent.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/mcp-server/src/config.ts`: `readTokens` (:120-127), `tokenEnvName` (:111), `readReviewTokens` (the comma/whitespace split precedent), `isOperator`, `allowAnonymous` (:176), `readHandoffKeys` (rotation with `_PREV`).
- `packages/mcp-server/src/server.ts:254`: the 401 gate before every route; `memoryWriter`, `bodySurface`, handoff sender rules.
- `packages/mcp-server/src/mcp.ts:91-116`: `attributedSurface`, `claimAttribution` (swarm binding; Phase 17 adds `substrate`).
- `packages/cli/src/index.ts:30-40`: `base()` and `headers()` (bearer from `SUBSTRATE_TOKEN`); `emit`, `brief`, `verify`, `handoff`.
- `packages/collectors/src/install-git-hook.ts`, `git/post-commit` (surface `${SUBSTRATE_SURFACE:-cursor}`).
- `packages/projector/src/cursor.ts` (`--check`), `packages/projector/src/swarm-workspace.ts:54-57` (MCP entry with `Authorization: Bearer ${SUBSTRATE_TOKEN}`, the precedent for naming the variable, never the value).
- `scripts/chaos-smoke.ts`: HTTP-only client of `SUBSTRATE_URL`, MCP `tools/call`, the outage path; precedent for scripts outside the store lock.
- `packages/mcp-server/src/backfill-run.ts` and `backfill.test.ts` (scenario 3).
- Phase 16 (sibling worktree `/root/src/worktrees/agent-substrate-v13-phase`): `scripts/rehearsal.ts` (`up|down|status|smoke`, `--surfaces`, `--operator`, `--anonymous`), `consumer.env`, `scripts/parity-check.ts`, `docs/runbooks/production-parity.md`, the port and loopback guard.
- Phase 19 (planned, `/root/src/worktrees/agent-substrate-v13-p19`): `emit.ts` (`postEvent` outcomes, bearer from `SUBSTRATE_TOKEN`), `cursor-stop.ts`, per-collector `EnvironmentFile=-/etc/substrate/substrate-collector-<name>.env`, the Muse bundle `tokenFile`, `collectors:status`.
- claude-ultrathink `origin/main`: `src/substrate/brief.ts` (`resolveSubstrate`, `authHeaders`, `fetchBrief`, `emitEvent`), `src/claude/hook.ts:466`, `skills/ultrathink-kickoff/SKILL.md` step 3, `.claude-plugin/plugin.json` 1.4.0.

### Established Patterns
- Token values live only in 0600 files outside the repo; the repo names variables (`store-lock.test.ts` forbids a tracked token value).
- Scripts are Bun TypeScript in `scripts/`, exposed through `package.json`; proofs source `consumer.env` and refuse port 7410 or a non-loopback target.
- Runbooks live in `docs/runbooks/`; live steps are operator-approved and recorded with who and when.
- Fail-open clients: 1.5 s in hooks, 3 s in collectors, never block an agent, exit 0.

### Integration Points
- `package.json` scripts: `identity:check`, `uat:phase0`.
- `config.ts` list-form tokens; CLI and `emit.ts` tokens-dir resolution; `parity-check.ts` bearer support.
- New files: `infra/identity/clients.json`, `scripts/identity-check.ts`, `scripts/uat-phase0.ts`, `docs/runbooks/production-identity.md`, `docs/uat.md`; edits to `.env.example`, `docs/coordination.md`, `docs/grok-bot.md`, `docs/collectors.md` (Phase 19).
- claude-ultrathink: MCP entry mechanism, kickoff command registration, `brief.ts` token resolution.
- `.planning/milestones/v1.0-phases/00-brief/0-UAT.md` results.

</code_context>

<specifics>
## Specific Ideas

- The gateway's comment "SUBSTRATE_TOKEN_DESK_GATEWAY on the substrate side" would create a token for a non-surface `desk-gateway`. The runbook maps the gateway's existing value to one entry of `SUBSTRATE_TOKEN_GROK_BOT`, so the gateway keeps working unchanged at switch-on.
- Switch-on order in one line: client files, names check, values check, server variables, one restart, evidence, soak.
- Scenario 5's real kickoff writes Linear rows; Linear Free caps active issues at 250 (FEATURES P11), so the run needs free slots and no hard-coded identifiers.
- The UAT script doubles as the later phases' regression check: `rehearsal up` → `uat:phase0 --scenarios 1,4,7,8` → `rehearsal down`.

</specifics>

<deferred>
## Deferred Ideas

- Per-token labels (a client id next to the surface) in audit and telemetry, so two clients of one surface are distinguishable in the ledger. Today audit records the surface only.
- Relaxing Phase 17's `substrate` binding so one host-job token can post `/events` for other surfaces (an alternative to D20-05).
- A provisioning helper that writes token files and `substrate.env` lines itself.
- Bearer support in the dispatcher, host and skills clients (Phases 22, 24, 31).
- Fixing hermes-engineering-board's `hermes-eng-board` surface (its own repo).
- Moving client paths to `/opt/agent-substrate/current` (draft PR #23).

</deferred>

## Open for the operator (user-visible)

1. **List-form tokens (D20-02, D20-03).** Allow `SUBSTRATE_TOKEN_<SURFACE>` to hold several comma-separated values so the operator, the gateway and the connector each get their own value. Why: with one value per surface, the operator token must be some surface's shared token, which gives `force` to every client of that surface, and the gateway and connector cannot be revoked separately. Recommendation: yes; the change is backward compatible.
2. **herdr's tokens (D20-05).** herdr posts each event with that surface's token from `/etc/substrate/tokens/<surface>`, so tokens are provisioned for all nine non-swarm agent surfaces it maps. Why: Phase 17 binds the `substrate` token to its own surface, so a single host-job token cannot post herdr's per-agent events. Recommendation: yes; the alternative is relaxing Phase 17's binding for `/events`.
3. **Client token files in `/etc/substrate/tokens/<surface>` (D20-04).** Why: the Cursor hooks, git hooks and Grok/Hermes hosts run with environments the operator does not control, and a file avoids putting a value in `hooks.json` or settings. Recommendation: yes, root-owned 0700 directory, 0600 files.
4. **Scenario 5's MCP entry mechanism (D20-13).** An opt-in user-scope `substrate` entry installed by a claude-ultrathink setup command, rather than a plugin-shipped server that every plugin user would see failing. Recommendation: the opt-in entry, confirmed by research.
5. **Which repos get the git post-commit hook (D20-19).** Recommendation: the repos in `SUBSTRATE_MUSE_REPOS`.
