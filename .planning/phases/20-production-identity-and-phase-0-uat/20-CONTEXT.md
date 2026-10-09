# Phase 20: Production identity and Phase 0 UAT - Context

**Gathered:** 2026-10-08
**Status:** Ready for planning
**Mode:** Smart discuss, auto-accepted under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"). The recommended answers were accepted. Items that change an operator-facing contract or need a live system are listed under "Open for the operator"; they do not block planning, and the plan uses the recommended answer unless the operator overrides it. After research (2026-10-08), D20-02, D20-04, D20-05, D20-08, D20-13, D20-15 and D20-16 were amended with verified facts (research amendments A0-A9 in `20-RESEARCH.md`).

**Spelling rule (store lock).** `store-lock.test.ts`'s `TOKEN_LITERAL` scan flags any `SUBSTRATE_TOKEN*` name followed by `:` or `=` and 16 or more path-like characters. Every doc, runbook, `.env.example` line, unit file and test this phase writes states client paths in prose ("defaults to /etc/substrate/tokens"), never as `NAME=<path>` or a shell default expression.

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
- **D20-02: `SUBSTRATE_TOKEN_<SURFACE>` accepts a comma-separated list.** One pure validator in `config.ts` (used by boot and by `identity:check --values`) splits each value on commas and whitespace, trims and drops empty entries; it does **not** copy `readReviewTokens`' 16-character floor, because test fixtures use short values. One value stays valid, so the change is backward compatible. Boot refuses the configuration (one `[substrate] refused — …` line naming variables only, never a value, then a non-zero exit) when (a) one value is listed under two surfaces, because today's `Map.set` would silently re-attribute it, or (b) a `SUBSTRATE_TOKEN_<X>` names no surface in `SURFACES` (e.g. `SUBSTRATE_TOKEN_DESK_GATEWAY`, or a client-only name such as the token-file variable landing in the server env), because today it creates a token for a non-surface and turns anonymous mode off (A1). The same value twice under one variable is deduplicated silently. Tests go in `authority.test.ts`/`server.authority.test.ts` and a spawned boot test, not in a new `config.test.ts`, which draft PR #22 creates (A8). `.env.example` and `docs/coordination.md` document the list form and drop `SUBSTRATE_TOKEN_DESK_GATEWAY` for `SUBSTRATE_TOKEN_GROK_BOT`; swarm surfaces stay single-valued, because the v1.2 installer copies the variable verbatim into an agent's `SUBSTRATE_TOKEN`.
  - The refusal exits 78 (EX_CONFIG), and `infra/vps/substrate-mcp.service` gains `RestartPreventExitStatus=78` (Open item 6); `index.ts`'s "never refuse to start" comment gains the one exception.
- **D20-03: The operator token is a dedicated value.** It is one extra entry in `SUBSTRATE_TOKEN_CLAUDE_CODE` (the operator works as `claude-code` through the CLI), also listed in `SUBSTRATE_OPERATOR_TOKENS`, and held only in the operator's own file (`~/.config/substrate/operator.token`, 0600). No hook, plugin or unit holds it.
- **D20-04: One client-side bearer resolver in agent-substrate.** A pure module (`packages/cli/src/token.ts`) resolves the bearer for a given surface in this order: `SUBSTRATE_TOKEN` from the environment; otherwise the first line of the file named by `SUBSTRATE_TOKEN_FILE`; otherwise the first line of `<tokens dir>/<surface>`, where the tokens dir is `SUBSTRATE_TOKENS_DIR` or by default /etc/substrate/tokens; otherwise no bearer, as today. The surface is validated against `^[a-z0-9][a-z0-9-]{0,63}$` before it is joined to a path; reads are capped (4 KiB); any error (missing, a directory, unreadable) means "no token" (fail-open); the value is never logged. The CLI, Phase 19's `emit.ts` (default token becomes `opts.token ?? resolveBearer(event.surface, env)`), `parity-check.ts` and `uat-phase0.ts` import it. This lets the Cursor hooks and the git post-commit hook authenticate without editing `hooks.json` or putting a value in any agent config, and lets one multi-surface collector send each event under its own surface's token.
- **D20-05: The herdr collector sends each event with the token of that event's surface,** through D20-04's resolver with the same order (A3). herdr's environment (`substrate.env` and its per-collector env file) must therefore **not** define `SUBSTRATE_TOKEN`, or every event would go out under one surface's token; `identity:check` flags it. The `substrate` token is not used for herdr because Phase 17 binds it to its own surface. The operator provisions tokens-dir files for every non-swarm surface herdr maps (`claude-code`, `codex`, `opencode`, `pi`, `omp`, `hermes`, `cursor`, `grok-build`, `muse`), and the runbook says so; `.env.example` gains blank `SUBSTRATE_TOKEN_CODEX=`, `SUBSTRATE_TOKEN_OPENCODE=` and `SUBSTRATE_TOKEN_PI=` lines.
- **D20-06: External clients keep their own convention, `SUBSTRATE_TOKEN` in their environment:** grok-hermes-connector via `/etc/grok-hermes/connector.env`; the Grok Bot gateway via `/etc/desk-gateway/gateway.env` (its existing value is reused as one `SUBSTRATE_TOKEN_GROK_BOT` entry, so the gateway needs no change); Grok Build's claude-ultrathink hooks and the Hermes engine via claude-ultrathink's resolution (D20-13). Agent swarm keeps the v1.2 per-agent env files; swarm tokens are provisioned only when a workspace is installed, and the runbook lists them as "not installed".
- **D20-07: Host jobs** (dispatcher, host, skills sync and bridge, miner, the Phase 28 anchor) get `SUBSTRATE_TOKEN_SUBSTRATE` by name in their per-unit env file. Clients whose code cannot send a bearer today (dispatcher, host) or that are broken (skills sync, bridge, miner) are listed as "dormant" with the phase that restores them. Their 401s at switch-on are expected and harmless (dispatch is disabled, host is inactive, sync and bridge already fail); the runbook records the expected count instead of hiding it.
- **D20-08: No auth exemption for `/healthz`, `/metrics` or `/slo`.** The server's auth rule is unchanged. `parity:check` (Phase 16) takes its bearer from D20-04's resolver (surface `claude-code`, so the operator's token file works through the token-file variable) and reports a 401 as "auth on, token missing", not "down". The Phase 19 Muse writer's `/healthz` call already carries its token.

### Switch-on sequencing and the no-strand guarantee
- **D20-09: Client first, server last.** Because the anonymous server ignores unknown bearers, every live client is given its token first, with no effect on production. Only then does the operator add the server-side variables and restart once. Rollback is commenting out the `SUBSTRATE_TOKEN_*`/`SUBSTRATE_OPERATOR_TOKENS` lines and restarting, which returns to today's anonymous mode; the handoff key and audit path may stay.
- **D20-10: The PR #22 bridge is optional, never required.** If #22 has merged before the window, the runbook's bridge variant applies: set the tokens plus `SUBSTRATE_ALLOW_ANONYMOUS=1`, restart, watch #22's anonymous-request counter fall to zero for a soak window, then remove the bridge and restart. Without #22, D20-09's ordering plus D20-11's check give the same guarantee. Nothing in Phase 20 names `SUBSTRATE_ALLOW_ANONYMOUS` in code.
- **D20-11: An identity manifest and a check, not a provisioning script.**
  - A tracked manifest (`infra/identity/clients.json`, no values) lists every client: id, surface, delivery (env file and variable, tokens-dir file, or external config), state (`live`, `after-phase-19`, `dormant:<phase>`, `not-installed`) and how its post-switch evidence is read.
  - `scripts/identity-check.ts`, run as `bun run identity:check`. The default mode is agent-safe: it reads variable **names** only and reports, per client, whether its delivery target exists and names the right variable, and whether the server env file names every required `SUBSTRATE_TOKEN_*`, `SUBSTRATE_OPERATOR_TOKENS`, `SUBSTRATE_HANDOFF_KEY` and `SUBSTRATE_AUDIT_PATH`. The `--values` mode is run by the operator only: it compares each client's value with the server's list in memory (by equality of sha256) and prints only `match`/`missing`/`mismatch` per client. Neither mode prints, logs or writes a value. Exit 1 when any `live` client would be stranded.
  - A test locks the manifest against the runbook: every manifest client appears in the runbook's table, and every surface the manifest needs is named in `.env.example`.
  - Token values are generated by the operator with a command the runbook gives (32 random bytes, hex) straight into the 0600 files; no repo script writes `/etc`.
- **D20-12: Post-switch evidence.** After the restart: `parity:check` with the operator token passes. The 401 read is `GET /metrics` (with the operator token): points of `substrate.request.total` with `surface=unattributed` and `status=4xx` are exactly the 401s since the restart, per route; read once right after the restart and again after a 30-minute soak (covering one Muse writer tick and at least one real prompt per live client), and attribute any delta to the dormant clients of D20-07 or to a stranded client. The same counter's `status=2xx` points per surface show each live client's token resolving, brief callers included. Claude Code's `server/discover` probe appears as `4xx` under the authenticated `claude-code` surface on `/mcp` and is not a 401. `SUBSTRATE_AUDIT_PATH` points into `/var/lib/substrate/` (exists, root, works with the installed and the repo unit), and `/healthz` reports `auditDurable: true`. A signed handoff round-trips: `substrate handoff --to hermes --graph <G>` reports "signed, stored", and MCP `coord_handoff_list {graph_id: G}` shows it verified.

### UAT script
- **D20-14: Entry point `scripts/uat-phase0.ts`, run as `bun run uat:phase0`.** It is an HTTP and MCP client of `SUBSTRATE_URL` with `SUBSTRATE_TOKEN` (D20-04 resolution), like `chaos-smoke.ts`, and stays outside the store lock (no `GREPTIME_` key, no store client). Flags: `--scenarios 1,4,7,8` (default all that are allowed for the target), `--report <path>` (JSON plus a Markdown table), `--tag <run-tag>`. It sources nothing by itself; proofs source the harness's `consumer.env`.
- **D20-15: Targets and guards.** A target whose port is in Phase 16's `PRODUCTION_PORTS` (7410, 7411, 6420) or whose host is not loopback is "production" (A7). Against production the script runs only read-only checks unless `--live <approval-ref>` is passed; scenarios that write (1's probe emit, 3's backfill, 8's emits) refuse without it, and scenario 5's live part only reads a graph a real kickoff registered. Scenario 7 ignores `SUBSTRATE_URL` entirely: it makes its own dead loopback port and its own accept-and-hang listener, and never stops anything (A9). Every write is run-tagged (`uat-<tag>` in `graph_id`/`session_id`/repo). Reports hold ids, counts, statuses, booleans and elapsed times, never a token and never raw brief bodies or event summaries from production. Pure parts (target classification, guards, report rendering, scenario expectations) have unit tests that need no server.
- **D20-16: Updated expectations, per scenario** (research table `FEATURES.md` "Phase 0 UAT"):
  1. MCP `tools/list` contains the 9 named v1.0 tools among today's set (not "exactly 9"), and `GET /healthz` 200, `POST /brief` 200, `POST /events` 202, `POST /verify` 200. A `/verify` result on a graph with September mixed-chain events is recorded, not hidden.
  2. Schemas and data, through the API only: `/healthz` reports `index`, `greptime`, `appendOnly` true; `events_query`, a graph read and `memory_search` return rows. The anchors table shape and raw row counts are an operator-approved read-only SQL step recorded as evidence, never in the script.
  3. Backfill: on the harness, `backfill-run.ts` with exported Notion rows then `graph_get` shows graphs with Linear identifiers. On production, `graph_get` of graph ids taken from an operator-approved read-only Notion export.
  4. Import the **installed** claude-ultrathink plugin (`installPath` from `~/.claude/plugins/installed_plugins.json`, today 0.3.0 at `85ca1ac`): `fetchBrief({repo, branch, surface: "claude-code"}, env)` with `SUBSTRATE_URL` always in `env` (0.3.0 otherwise defaults to production) returns a non-empty brief, and `formatPromptContext({result, brief})` from the plugin's `src/claude/output.ts` contains `## Agent Substrate brief`. No model quota is spent. The plugin version and commit that served the run are recorded.
  5. Read-only: Claude Code's config has an MCP server named `substrate` whose Authorization header names `${SUBSTRATE_TOKEN}` (names only). Live: given `--graph <gid>` from a real kickoff, `graph_get` returns it with its nodes and Linear identifiers, registered by surface `claude-code`.
  6. `bun packages/projector/src/cursor.ts --check` reports the three substrate entries current and the `stop` script present; `install-git-hook.ts --check` reports the post-commit hook present in the target repos. Cursor's `sessionStart` hook writes `.substrate/BRIEF.md` and emits no event (A2). Harness: in a scratch repo, the hook commands run with synthetic envelopes (sessionStart, postToolUse, stop per Phase 19's `cursor-stop.ts` contract with scratch cursor and transcripts dirs) and a commit runs through the installed hook; `BRIEF.md` exists and `tool.call`, `session.end` and `commit` land under `surface=cursor`, matched by surface, kind, repo and `since` (the CLI's emit carries no session id). Production: a real Cursor session and a real commit give the same evidence.
  7. Against its own dead port and its own hanging listener (never the target): `fetchBrief` from the installed plugin returns `""` within 1500 ms (plus 250 ms slack); `substrate brief --surface cursor` exits 0 with empty stdout within 1500 ms plus measured startup; the Cursor hook commands exit 0 with nothing on stdout.
  8. Register graph G with a run-tagged repo R and node `n1`, claim `n1` as `claude-code`, emit `file.edit` as `cursor` with repo R and graph G, then `POST /brief` as `hermes` with repo R and graph G: the brief contains the `cursor` edit line and `n1` held by `claude-code`. The brief lists other surfaces' actions only when `repo` is given (A6).
- **D20-17: Where each scenario runs.** Scenarios 1, 4, 7 and 8 run on the Phase 16 harness (`rehearsal up --name p20`), 3 and 6 run on the harness with fixtures. Against production after switch-on, with operator approval: 1 and 2 (read-only), 3 (Notion read), 5 (one real kickoff, which writes Notion and Linear rows), 6 (real Cursor session and commit); 8 is optional on production because its rows are permanent.
- **D20-18: Recording results.** Each run writes its report. The phase records the final per-scenario result and evidence in `.planning/milestones/v1.0-phases/00-brief/0-UAT.md` (frontmatter `status`, each `result:`/`evidence:`, the Summary counts) and links the reports from `20-UAT.md`. A failing scenario is recorded as failed with its evidence; it is never re-scoped to pass. `docs/uat.md` explains how later phases run the script as a regression check.

### Cross-repo and live steps
- **D20-13: claude-ultrathink change (UAT-03), in a fresh clone at `/root/src/worktrees/claude-ultrathink-p20`** cut from `origin/main` (`ed3243e`); the operator's checkout at `/root/src/repos/claude-ultrathink` is never written. The change:
  - a `substrate` MCP entry for Claude Code: an opt-in **user-scope** entry written by claude-ultrathink's `scripts/mcp-register.ts --substrate` (Claude host only, never default; refuses when no substrate URL is configured), equivalent to `claude mcp add-json --scope user substrate` with `type: http`, `url: <substrate url>/mcp`, header `Authorization: Bearer ${SUBSTRATE_TOKEN:-}` (names the variable, UAT-03) and `headersHelper: <clone>/bin/ultrathink-mcp substrate headers`, which prints `{"Authorization":"Bearer <v>"}` from the D20-04-style resolution for surface `claude-code` or `{}`, always exits 0 and never logs the value (A5; probed on Claude Code 2.1.278). A user-scope server keyed `substrate` exposes `mcp__substrate__graph_register`, which is what kickoff's "MCP server named `substrate`" means; a plugin-shipped server would be named `plugin:ultrathink:substrate` and is rejected. `--remove` deletes only an entry it owns;
  - kickoff registers every new graph through `graph_register`, deterministically (A4): a new `ultrathink-mcp substrate register --state <stateFile>` builds the arguments from the session record (only server-schema fields; `surface` only when the host is a substrate surface, so `prime-agent` is omitted), calls the tool over HTTP MCP with the bearer, prints one line and exits 0 (fail-open, idempotent by `graph_id`). `SKILL.md` step 3 always runs it, because step 1's `track complete` is skipped when the hook already completed tracking (the usual case on Claude, Grok, Muse and Omp); `trackComplete` also calls the same function. Calling the MCP tool directly stays the fallback when the command cannot run;
  - token resolution in `src/substrate/brief.ts` matches D20-04 (`SUBSTRATE_TOKEN`, then the token-file variable, then the tokens-dir file for the host's surface, which is the identity map for `claude-code`, `grok-build`, `hermes`, `muse`, `omp`), so the Grok Build and Hermes hosts authenticate without a value in any hook config;
  - tests in that repo, and its own conventions (AGPL headers, `CHANGELOG.md` `[Unreleased]`, docs `configuration.md`, `privacy.md` (registration sends Notion URLs, Linear ids, repo, branch and status to the substrate), `how-to/register-mcp-gateway.md`).

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

**Answered 2026-10-08: the operator accepted items 1-6 as recommended, and approved item 7.** The claude-ultrathink PR follows the same rules as v1.3 phase PRs: Greptile 5/5 with no open threads, then auto-merge, then a plugin refresh in the live window. The items below are the record.

1. **List-form tokens (D20-02, D20-03).** Allow `SUBSTRATE_TOKEN_<SURFACE>` to hold several comma-separated values so the operator, the gateway and the connector each get their own value. Why: with one value per surface, the operator token must be some surface's shared token, which gives `force` to every client of that surface, and the gateway and connector cannot be revoked separately. Recommendation: yes; the change is backward compatible.
2. **herdr's tokens (D20-05).** herdr posts each event with that surface's token from `/etc/substrate/tokens/<surface>`, so tokens are provisioned for all nine non-swarm agent surfaces it maps. Why: Phase 17 binds the `substrate` token to its own surface, so a single host-job token cannot post herdr's per-agent events. Recommendation: yes; the alternative is relaxing Phase 17's binding for `/events`.
3. **Client token files in `/etc/substrate/tokens/<surface>` (D20-04).** Why: the Cursor hooks, git hooks and Grok/Hermes hosts run with environments the operator does not control, and a file avoids putting a value in `hooks.json` or settings. Recommendation: yes, root-owned 0700 directory, 0600 files.
4. **Scenario 5's MCP entry mechanism (D20-13).** An opt-in user-scope `substrate` entry written by `scripts/mcp-register.ts --substrate` (static header naming `${SUBSTRATE_TOKEN:-}` plus a `headersHelper` reading the tokens dir), rather than a plugin-shipped server that every plugin user would see failing and that would not be named `substrate`. Research probed it on Claude Code 2.1.278. Recommendation: the opt-in entry.
5. **Which repos get the git post-commit hook (D20-19).** Recommendation: the repos in `SUBSTRATE_MUSE_REPOS`.
6. **Boot refusal exit code (D20-02).** A refused identity configuration is the server's first boot refusal. Why: with the repo unit's `Restart=always`, a refusal would crash-loop every 3 s. Recommendation: exit 78 (EX_CONFIG) and add `RestartPreventExitStatus=78` to `infra/vps/substrate-mcp.service`; it takes effect when the operator installs the repo unit, and until then the installed unit crash-loops with the refusal line in the journal (rollback: fix the env file).
7. **Scope of the claude-ultrathink PR.** It ships a deterministic `ultrathink-mcp substrate register` command and changes kickoff `SKILL.md` step 3 to always run it, plus token resolution and the opt-in MCP entry. Why: step 1's tracker command is skipped on most hosts, so the MCP-tool-only path would miss most graphs. Recommendation: yes; the PR opens on `swcstudiospace/claude-ultrathink` only with operator approval.
