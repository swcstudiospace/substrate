# Phase 20: Production identity and Phase 0 UAT - Research

**Researched:** 2026-10-08
**Domain:** bearer-token identity for a loopback MCP/HTTP service (agent-substrate `config.ts`, CLI, collectors), Claude Code MCP configuration, claude-ultrathink kickoff, and a repeatable HTTP-only UAT script
**Confidence:** HIGH (every mechanism below was read in source or probed live on scratch instances; the live production window is the only unprobed part)

## Summary

The phase is two PRs and one operator window. The agent-substrate PR changes one server function (`readTokens` gains a comma/whitespace list form and a boot refusal), adds one client-side resolver shared by the CLI, the Phase 19 collector emit and `parity:check`, and adds three scripts and two docs: an identity manifest plus `identity:check`, `uat:phase0`, `docs/runbooks/production-identity.md` and `docs/uat.md`. The claude-ultrathink PR adds the same tokens-dir resolution to `src/substrate/brief.ts`, a deterministic `graph_register` call over HTTP MCP from the kickoff command path, and an opt-in user-scope `substrate` MCP entry for Claude Code. Everything that touches production is an operator step.

Three facts discovered this session reshape the plan. (1) The committed `20-CONTEXT.md` already fails `store-lock.test.ts` on this branch: its D20-04 line holds the tokens-dir default in `${NAME:-path}` form, which the `TOKEN_LITERAL` scan reads as an assigned token value (test run pasted below). Every doc, runbook, `.env.example` line and unit file this phase writes must avoid `SUBSTRATE_TOKENS_DIR=<path>`, `SUBSTRATE_TOKEN_FILE=<path>` and `${SUBSTRATE_TOKENS_DIR:-<path>}` spellings. (2) Claude Code 2.1.278, probed against a temp `CLAUDE_CONFIG_DIR`, expands `${SUBSTRATE_TOKEN:-}` in a user-scope HTTP entry's `headers`, runs a user-scope `headersHelper` with the full environment, lets the helper's `Authorization` override the static header, and connects (`✔ Connected`) to main's stateless `/mcp` with a list-form bearer. So the entry can both *name* `${SUBSTRATE_TOKEN}` (UAT-03) and *get* its value from `/etc/substrate/tokens/claude-code` through a helper, with no value in any config. (3) Kickoff's "one command" (`ultrathink-mcp track complete`) runs only when tracking is incomplete; on Claude Code, Grok, Muse and Omp the planner usually completes tracking inside the hook, so a `graph_register` placed only in `track complete` would miss most graphs. Registration needs its own command (`ultrathink-mcp substrate register --state <file>`) that SKILL step 3 always runs, and that `track complete` also calls.

**Primary recommendation:** Implement one pure token-config validator in `config.ts` (list form, duplicate value across surfaces, unknown surface suffix) used by both boot and `identity:check --values`; one pure bearer resolver (`SUBSTRATE_TOKEN` → `SUBSTRATE_TOKEN_FILE` → tokens-dir file for a validated surface) used by the CLI, `emit.ts`, `parity-check.ts` and `uat-phase0.ts`; and read post-switch evidence from `GET /metrics` (`substrate.request.total`, `surface=unattributed`, `status=4xx` is exactly the 401 count since restart).

### CONTEXT amendments this research proposes (evidence in the sections cited)

| # | Decision | Fact found | Proposed amendment |
|---|---|---|---|
| A0 | D20-04 text in `20-CONTEXT.md` | Line 62 trips `TOKEN_LITERAL`; `bun test store-lock.test.ts -t "no tracked file assigns"` fails naming `20-CONTEXT.md` (§Pitfall 1) | Reword line 62 (e.g. "the file `<tokens dir>/<surface>`, where the tokens dir is `SUBSTRATE_TOKENS_DIR` or by default `/etc/substrate/tokens`") before any code lands; add the spelling rule to every later doc |
| A1 | D20-02 | `envSuffixToSurface` (`config.ts:116-118`) casts any suffix to a surface, so `SUBSTRATE_TOKEN_DESK_GATEWAY` (still in `.env.example:104`) or a stray `SUBSTRATE_TOKEN_FILE` in the server env becomes a token for a non-surface and also turns `allowAnonymous` off | Boot also refuses a `SUBSTRATE_TOKEN_<X>` whose `X` is not in `SURFACES`, naming the variable. No test uses a non-surface suffix today (grep below), so this is safe |
| A2 | D20-16 #6 | The Cursor `sessionStart` hook runs `brief --surface cursor --write` and emits **no** `session.start` (`projector/src/cursor.ts:44-46`) | Expect `.substrate/BRIEF.md` written at session start (the original 0-UAT wording), then `tool.call`, `session.end` (Phase 19 `cursor-stop.ts`) and `commit`; correlate by `surface=cursor`, `kind`, `since`, not by session id (CLI `emit` sends none) |
| A3 | D20-05 vs D20-04 | D20-04 says env `SUBSTRATE_TOKEN` first, then the per-surface file; D20-05 says herdr uses the per-surface file first, then its own `SUBSTRATE_TOKEN` | Keep one resolver order (D20-04) everywhere; the herdr unit's env (substrate.env and its per-collector env file) must not define `SUBSTRATE_TOKEN`, and `identity:check` flags it if it does |
| A4 | D20-13 (registration point) | `SKILL.md` step 1 skips the command when `tracking.status === "complete"`; `hook.ts:676-693` and `host/plan.ts:224-228` complete tracking in-hook on every host except Hermes | Add `ultrathink-mcp substrate register --state <stateFile>`; SKILL step 3 runs it always (idempotent), `trackComplete` also calls the same function; the MCP-tool path stays the fallback when the command cannot run |
| A5 | D20-13 (MCP entry mechanism) | Probes: `${SUBSTRATE_TOKEN:-}` expands in user-scope headers; user-scope `headersHelper` runs with full env and overrides the static header; `{}` from the helper leaves the static header | User-scope entry written by `bun scripts/mcp-register.ts --substrate` (claude host only): `type http`, `url <substrate.url>/mcp`, `headers.Authorization "Bearer ${SUBSTRATE_TOKEN:-}"`, `headersHelper "<clone>/bin/ultrathink-mcp substrate headers"` |
| A6 | D20-16 #8 | `composeBrief` lists recent actions only when `repo` is given (`brief.ts:150-165`); `graph_id` alone gives node and claim lines but never another surface's `file.edit` | Scenario 8 registers G with a run-tagged repo R, claims a node as one surface, emits `file.edit` as `cursor` with repo R and graph G, then briefs as `hermes` with repo R and graph G |
| A7 | D20-15 | Phase 16 classifies `PRODUCTION_PORTS = [7410, 7411, 6420]` (`scripts/rehearsal.ts:49`) | "Production" = port in `PRODUCTION_PORTS` or non-loopback host (reuse the constant, extend `refuseSmokeUrl`'s logic into a classifier) |
| A8 | D20-02 (test file) | Draft PR #22 creates `packages/mcp-server/src/config.test.ts` and rewrites `loadConfig`'s token lines | Put the list-form tests in `authority.test.ts` (exists on main) or a distinct `config-tokens.test.ts`, to avoid an add/add conflict with #22 |
| A9 | D20-16 #7 / D20-15 | Scenario 7 can be proven without ever touching the target | Scenario 7 ignores `SUBSTRATE_URL`: it makes its own dead loopback port and its own accept-and-hang listener; it never stops anything |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|---|---|---|---|
| Token → surface map, list form, boot refusal | API / Backend (`packages/mcp-server/src/config.ts`, `index.ts`) | — | The server is the only authority on which bearer names which surface |
| 401 gate and request telemetry | API / Backend (`server.ts:254-257`, `observability` `recordRequest`) | — | Unchanged by D20-08; read for evidence only |
| Bearer resolution (env → token file → tokens dir) | Client tier (CLI, collectors `emit.ts`, scripts) | claude-ultrathink `brief.ts` (same rule, separate repo) | Each client resolves its own credential; the server never reads client files |
| Token values at rest | OS (`/etc/substrate/tokens/<surface>` 0600, env files 0600, `~/.config/substrate/operator.token`) | — | Operator-provisioned; repo holds names only (store lock) |
| Claude Code `substrate` MCP entry | Host config (`~/.claude.json` user scope) written by claude-ultrathink setup | claude-ultrathink `bin/ultrathink-mcp substrate headers` helper | Claude Code owns MCP connections; the plugin only writes the entry |
| Kickoff graph registration | claude-ultrathink CLI (`src/mcp/cli.ts`, new `src/substrate/register.ts`) | substrate `graph_register` over `/mcp` | Deterministic command, fail-open, idempotent by `graph_id` |
| Identity manifest and check | Repo (`infra/identity/clients.json`, `scripts/identity-check.ts`) | Runbook | Names and delivery targets are code-reviewable; values are not |
| UAT scenarios | Script tier (`scripts/uat-phase0.ts`, HTTP/MCP client only) | Phase 16 harness, installed claude-ultrathink plugin | Same client surface as every agent; no store client |

## Standard Stack

No new dependencies. Everything uses what the two repos already ship.

### Core
| Library / tool | Version | Purpose | Why Standard |
|---|---|---|---|
| Bun | 1.4.0 (agent-substrate `engines >=1.4.0`); claude-ultrathink `engines >=1.2` | runtime, `bun test`, `Bun.serve` stubs, `fetch`, `AbortSignal.timeout` | Both repos' only runtime [VERIFIED: `bun --version` → 1.4.0; package.json] |
| `@modelcontextprotocol/sdk` | 1.30.1 (server side only) | stateless `StreamableHTTPServerTransport` behind `/mcp` | Already the server transport [VERIFIED: node_modules/.bun/@modelcontextprotocol+sdk@1.30.1] |
| zod | 4.6.5 | tool input schemas (`objectFromShape`) | Existing [VERIFIED: node_modules/.bun/zod@4.6.5] |
| `node:crypto` `createHash("sha256")` | built-in | `identity:check --values` equality by hash | No hand-rolled hashing |
| Claude Code CLI | 2.1.278 | `claude mcp add-json --scope user`, `claude mcp get` | Host of UAT-03 [VERIFIED: `claude --version`] |

### Supporting (existing in-repo modules to reuse)
| Module | Purpose | When to Use |
|---|---|---|
| `scripts/rehearsal.ts` (Phase 16): `PRODUCTION_PORTS`, `refuseSmokeUrl`, `parseShellExports`, `pickFreePort`, `ensurePrivateDir` | target classification, consumer.env parsing, scratch ports | UAT guards (D20-15) and scenario 7 |
| `scripts/chaos-smoke.ts` `headers()`, `parseBody()`, `toolResult()` | raw JSON-RPC over `/mcp` with SSE framing | UAT MCP calls (copy the pattern into a small shared helper) |
| `packages/mcp-server/src/backfill.ts` `mapNotionRows` (imports only `types.ts`) | Notion rows → `graph_register` plans | scenario 3 fixture validation |
| claude-ultrathink `scripts/mcp-register.ts` (`planClaude`, `applyCliPlan`, backups, `--dry-run`/`--remove`) | registering host MCP entries with backups | the `substrate` user-scope entry |
| claude-ultrathink `src/claude/output.ts` `formatPromptContext`, `SUBSTRATE_CONTEXT_HEADER` (both 0.3.0 and 1.4.0) | the hook's brief framing | scenario 4 without a model call |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|---|---|---|
| user-scope entry + `headersHelper` | plugin-shipped `.mcp.json` | Plugin servers register as `plugin:ultrathink:substrate` with tools `mcp__plugin_ultrathink_substrate__*` [CITED: code.claude.com/docs/en/mcp "Plugin MCP tool names"], start for every plugin user, cannot read `~/.config/ultrathink/config.json` for the URL, and a plugin `headersHelper` runs with every `*TOKEN*` variable stripped [CITED: same page, "headersHelper … Removed: a server … in a plugin"]. Rejected |
| `headersHelper` reading the tokens dir | `env.SUBSTRATE_TOKEN` in `~/.claude/settings.json` | Works (probe: settings `env` reaches header expansion → `✔ Connected`), but writes a value into agent config, against D20-04's intent. Rejected |
| kickoff registers through the MCP tool only | (today's SKILL step 3) | Non-deterministic, depends on the model and on an MCP entry being connected. Kept as fallback only |
| `/metrics` counters for 401 evidence | journal grep | The server writes no journal line for a 401 (`server.ts:254-257` sends and returns). `/metrics` is the only read without OTLP export (production logs "no OTLP endpoint configured") |

**Installation:** none.

## Package Legitimacy Audit

No external package is installed by this phase (no `package.json` dependency changes in either repo).

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---|---|---|---|---|---|---|
| (none) | — | — | — | — | — | — |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

<user_constraints>
## User Constraints (from CONTEXT.md)

Copied verbatim from `20-CONTEXT.md` `<decisions>`, with one exception marked `[elided]`: the D20-04 tokens-dir default is not reproduced in its `${…:-path}` spelling, because that spelling fails `store-lock.test.ts` in any tracked file (Pitfall 1, amendment A0).

### Locked Decisions

#### Identity model and token delivery
- **D20-01: Identity is per client at surface granularity.** Every token names a surface (`SUBSTRATE_TOKEN_<SURFACE>`; no new surface, no `desk-gateway` surface). Clients of one surface that run at the same trust level on this host share one value: the Cursor hooks and the git post-commit collector (`cursor`); the Claude Code plugin hooks and Claude Code's `substrate` MCP entry (`claude-code`). Clients with different trust get different values even on one surface: the operator versus the `claude-code` hooks, and the Grok Bot gateway versus grok-hermes-connector (both `grok-bot`).
- **D20-02: `SUBSTRATE_TOKEN_<SURFACE>` accepts a comma-separated list.** `readTokens` splits on commas (and whitespace, like `readReviewTokens`), trims and drops empty entries. One value stays valid, so the change is backward compatible. Boot refuses the configuration (the server exits non-zero with a message naming the two variables, never the value) when one value is listed under two surfaces, because today's `Map.set` would silently re-attribute it. Tests in `config.test.ts`/`authority.test.ts`; `.env.example` and `docs/coordination.md` document the list form and drop `SUBSTRATE_TOKEN_DESK_GATEWAY` for `SUBSTRATE_TOKEN_GROK_BOT`.
- **D20-03: The operator token is a dedicated value.** It is one extra entry in `SUBSTRATE_TOKEN_CLAUDE_CODE` (the operator works as `claude-code` through the CLI), also listed in `SUBSTRATE_OPERATOR_TOKENS`, and held only in the operator's own file (`~/.config/substrate/operator.token`, 0600). No hook, plugin or unit holds it.
- **D20-04: Client-side token resolution in agent-substrate's own clients.** The CLI (`packages/cli/src/index.ts`) and the shared collector emit (`packages/collectors/src/emit.ts`, Phase 19) resolve the bearer in this order: `SUBSTRATE_TOKEN` from the environment; otherwise the file `<SUBSTRATE_TOKENS_DIR, default /etc/substrate/tokens>/<surface>` [elided: the `${…:-…}` spelling] for the surface being sent (first line, trimmed); otherwise no bearer, as today. Unreadable or missing files are not errors (fail-open). The token value is never logged. This lets the Cursor hooks and the git post-commit hook authenticate without editing `hooks.json` or putting a value in any agent config, and lets one multi-surface collector send each event under its own surface's token.
- **D20-05: The herdr collector sends each event with the token of that event's surface** (D20-04's per-surface file), falling back to its own `SUBSTRATE_TOKEN`. The `substrate` token is not used for herdr because Phase 17 binds it to its own surface. The operator therefore provisions tokens for every non-swarm surface herdr maps (`claude-code`, `codex`, `opencode`, `pi`, `omp`, `hermes`, `cursor`, `grok-build`, `muse`), and the runbook says so.
- **D20-06: External clients keep their own convention, `SUBSTRATE_TOKEN` in their environment:** grok-hermes-connector via `/etc/grok-hermes/connector.env`; the Grok Bot gateway via `/etc/desk-gateway/gateway.env` (its existing value is reused as one `SUBSTRATE_TOKEN_GROK_BOT` entry, so the gateway needs no change); Grok Build's claude-ultrathink hooks and the Hermes engine via claude-ultrathink's resolution (D20-13). Agent swarm keeps the v1.2 per-agent env files; swarm tokens are provisioned only when a workspace is installed, and the runbook lists them as "not installed".
- **D20-07: Host jobs** (dispatcher, host, skills sync and bridge, miner, the Phase 28 anchor) get `SUBSTRATE_TOKEN_SUBSTRATE` by name in their per-unit env file. Clients whose code cannot send a bearer today (dispatcher, host) or that are broken (skills sync, bridge, miner) are listed as "dormant" with the phase that restores them. Their 401s at switch-on are expected and harmless (dispatch is disabled, host is inactive, sync and bridge already fail); the runbook records the expected count instead of hiding it.
- **D20-08: No auth exemption for `/healthz`, `/metrics` or `/slo`.** The server's auth rule is unchanged. `parity:check` (Phase 16) learns to send a bearer when `SUBSTRATE_TOKEN` or `SUBSTRATE_TOKEN_FILE` is set and reports a 401 as "auth on, token missing", not "down". The Phase 19 Muse writer's `/healthz` call already carries its token.

#### Switch-on sequencing and the no-strand guarantee
- **D20-09: Client first, server last.** Because the anonymous server ignores unknown bearers, every live client is given its token first, with no effect on production. Only then does the operator add the server-side variables and restart once. Rollback is commenting out the `SUBSTRATE_TOKEN_*`/`SUBSTRATE_OPERATOR_TOKENS` lines and restarting, which returns to today's anonymous mode; the handoff key and audit path may stay.
- **D20-10: The PR #22 bridge is optional, never required.** If #22 has merged before the window, the runbook's bridge variant applies: set the tokens plus `SUBSTRATE_ALLOW_ANONYMOUS=1`, restart, watch #22's anonymous-request counter fall to zero for a soak window, then remove the bridge and restart. Without #22, D20-09's ordering plus D20-11's check give the same guarantee. Nothing in Phase 20 names `SUBSTRATE_ALLOW_ANONYMOUS` in code.
- **D20-11: An identity manifest and a check, not a provisioning script.**
  - A tracked manifest (`infra/identity/clients.json`, no values) lists every client: id, surface, delivery (env file and variable, tokens-dir file, or external config), state (`live`, `after-phase-19`, `dormant:<phase>`, `not-installed`) and how its post-switch evidence is read.
  - `scripts/identity-check.ts`, run as `bun run identity:check`. The default mode is agent-safe: it reads variable **names** only and reports, per client, whether its delivery target exists and names the right variable, and whether the server env file names every required `SUBSTRATE_TOKEN_*`, `SUBSTRATE_OPERATOR_TOKENS`, `SUBSTRATE_HANDOFF_KEY` and `SUBSTRATE_AUDIT_PATH`. The `--values` mode is run by the operator only: it compares each client's value with the server's list in memory (by equality of sha256) and prints only `match`/`missing`/`mismatch` per client. Neither mode prints, logs or writes a value. Exit 1 when any `live` client would be stranded.
  - A test locks the manifest against the runbook: every manifest client appears in the runbook's table, and every surface the manifest needs is named in `.env.example`.
  - Token values are generated by the operator with a command the runbook gives (32 random bytes, hex) straight into the 0600 files; no repo script writes `/etc`.
- **D20-12: Post-switch evidence.** After the restart: `parity:check` with the operator token passes; the server's journal and request telemetry show no 401 from a `live` client over a soak window (the planner picks the read: the request span's status, or #22's refusal counter when merged); each `live` client's next event or brief after the restart is attributed to its surface (read with `events_query`). `SUBSTRATE_AUDIT_PATH` points into the unit's state directory (`/var/lib/substrate/`), and `/healthz` reports `auditDurable: true`. A signed handoff round-trips (`substrate handoff` then `/verify` or the read path the planner finds).

#### UAT script
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

#### Cross-repo and live steps
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

### Deferred Ideas (OUT OF SCOPE)
- Per-token labels (a client id next to the surface) in audit and telemetry, so two clients of one surface are distinguishable in the ledger. Today audit records the surface only.
- Relaxing Phase 17's `substrate` binding so one host-job token can post `/events` for other surfaces (an alternative to D20-05).
- A provisioning helper that writes token files and `substrate.env` lines itself.
- Bearer support in the dispatcher, host and skills clients (Phases 22, 24, 31).
- Fixing hermes-engineering-board's `hermes-eng-board` surface (its own repo).
- Moving client paths to `/opt/agent-substrate/current` (draft PR #23).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FOUND-04 | Runbook lists every client and its token; per-surface tokens, operator token, `SUBSTRATE_HANDOFF_KEY`, `SUBSTRATE_AUDIT_PATH` by name in `/etc/substrate/substrate.env`; no listed client left without a token at switch-on | §4 (list form, validator, boot refusal), §5 (client resolver), §6 (evidence via `/metrics`, `/healthz`, handoff list), §8 (manifest + names-only/values check), Runtime State Inventory |
| UAT-01 | All 8 scenarios re-run against main with updated expectations, pass/fail with evidence | §3 (transport, 19 tools), §7 (per-scenario calls and assertions, amendments A2, A6, A9) |
| UAT-02 | Repeatable script against any `SUBSTRATE_URL` | §7 (structure, guards A7, report), Validation Architecture |
| UAT-03 | Claude Code `substrate` MCP entry naming its token variable; kickoff registers each new graph via `graph_register` | §1 (probed mechanism A5), §2 (registration point A4, payload mapping, tests, conventions) |
| UAT-04 | Cursor hooks (incl. `stop`) and git post-commit installed and emitting live | §5 (CLI resolver for hooks), §7 scenario 6 (A2), Runtime State Inventory (installed copies) |
</phase_requirements>

## Project Constraints (from AGENTS.md)

`/root/src/worktrees/agent-substrate-v13-p20/AGENTS.md` (no `CLAUDE.md` exists):
- Read `.substrate/BRIEF.md` at the start of work in the repo; do not edit it by hand.
- Draft PR only into the default branch; no merge, no auto-merge, no force-push, no branch deletion.
- **No secrets:** never print, commit or echo tokens, keys, passphrases or bus secrets; reference environment variables by name only; **do not write tailnet names or internal hostnames into the repo, the PR or the session transcript.** (UAT reports committed to `.planning/` must therefore hold `127.0.0.1:<port>` at most, never an internal host.)
- Greptile gate via Desk Quality; a FAILED/SKIPPED/unavailable review is a blocker, never a pass.

v1.3 run rules (`STATE.md:27-33`): every live run (production service, Linear/Notion writes, GitHub PRs on other repos, model quota) waits for operator approval; failures present at HEAD are recorded, not fixed; baseline `bun test` 1129 pass / 56 skip / 0 fail, `bunx tsc --noEmit` clean at `ab62c91`.

claude-ultrathink conventions (`CONTRIBUTING.md` at `ed3243e`): AGPL-3.0-or-later SPDX header `// SPDX-License-Identifier: AGPL-3.0-or-later` + `// Copyright (C) 2026 SWC Studio` on every source file; tests are `bun:test` beside the code, deterministic (temp dirs, fake `fetch` and process runners, no network); "Never log or print secrets … never copy them into … test fixtures"; a line under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog + SemVer) and README/`SKILL.md` updates for anything user-visible; commits `type(scope): summary`; checks `bun run check` (tsc 5.9.3) and `bun test`, plus `python3 hosts/hermes/bridge_test.py` when `hosts/hermes` changes. Versions live in `package.json` and `.claude-plugin/plugin.json` (both `1.4.0`); the bump to `1.5.0` belongs to the release commit, not the feature commit [ASSUMED from the 1.4.0 history: `0f38890 release(1.4.0): …`].

## 1. Claude Code MCP configuration (UAT-03, D20-13)

### Facts (doc + live probes on Claude Code 2.1.278, `CLAUDE_CONFIG_DIR=/tmp/p20-ccprobe`, dummy values only, removed afterwards)

| Question | Answer | Evidence |
|---|---|---|
| `${VAR}` in `headers` of a **user-scope** entry in `~/.claude.json` | Expands from Claude Code's process env | [VERIFIED: probe — `claude mcp get substrate` run with the client token variable set to a dummy value in the shell → stub server logged `auth=Bearer dummy-probe-value`] and [CITED: code.claude.com/docs/en/mcp: "referencing it via `${VAR}` expansion … in a local- or user-scoped server entry in `~/.claude.json`"] |
| … in a project `.mcp.json` | Yes: `command`, `args`, `env`, `url`, `headers` | [CITED: code.claude.com/docs/en/mcp "Expansion locations"]; repo precedent `docs/swarm-workspace.md:21` |
| … in a plugin `.mcp.json` / `plugin.json` `mcpServers` | `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}` substitute in `url`, `headers`, `headersHelper`; "access to the same environment variables as manually configured servers" | [CITED: same page, "Plugin-provided MCP servers"] |
| Is `SUBSTRATE_TOKEN` a "credential variable that reads as empty"? | No: the covered set is Claude Code's own and cloud-provider credentials and a fixed list (`HTTPS_PROXY`, `NPM_TOKEN`, …); "A name outside this set … expands as written" | [VERIFIED: probe above expanded it] |
| `headersHelper` exists? | Yes, for `http`/`sse`/`ws`; command prints a JSON object; 10 s limit; "Dynamic headers override any static `headers` with the same name"; re-run on 401/403 | [CITED: "Use dynamic headers for custom authentication"]; [VERIFIED: probe with helper printing `{"Authorization":"Bearer from-helper-file"}` → server saw `auth=Bearer from-helper-file`; helper printing `{}` → server saw the static `auth=Bearer ` (empty, since `${SUBSTRATE_TOKEN:-}` unset)] |
| Helper env for user scope | Full env, including `*TOKEN*` names; user-scope helpers need no folder trust; cwd is `~/.claude` (or `CLAUDE_CONFIG_DIR`), so use an absolute path | [CITED: "Where the helper runs", "Not removed: a server at user … scope"]; [VERIFIED: probe helper recorded `SUBSTRATE_TOKEN`, `CLAUDE_CODE_MCP_SERVER_URL`, `CLAUDE_CODE_MCP_SERVER_NAME` in its env] |
| Plugin-provided server naming | Server `plugin:<plugin>:<server>`, tools `mcp__plugin_<plugin>_<server>__<tool>`; a bare `mcp__substrate__…` matcher never fires for it | [CITED: "Plugin MCP tool names"]. A user-scope server keyed `substrate` exposes `mcp__substrate__graph_register`, which is what SKILL step 3's "MCP server named `substrate`" means |
| `~/.claude/settings.json` `env` reaching header expansion | Yes | [VERIFIED: probe — settings `{"env":{"SUBSTRATE_TOKEN":…}}` with the shell var unset → `Status: ✔ Connected`]. Reaching plugin hooks: [ASSUMED] (hooks are child processes of the session) |
| What `claude mcp add --transport http --scope user … --header` writes | Top-level `mcpServers.<name> = {"type":"http","url":…,"headers":{"Authorization":"Bearer ${SUBSTRATE_TOKEN:-}"}}` in `<config dir>/.claude.json`, the `${…}` kept literal when passed as an argv element (no shell); CLI echoes the header as `[REDACTED]` | [VERIFIED: probe; file content read back] |
| Display | `claude mcp get substrate` prints `Authorization: Bearer ${SUBSTRATE_TOKEN}` (template, not value) and `Status: ✔ Connected` / `✘ Failed to connect` with `Issue: … (HTTP 401) … {"error":"unknown or missing bearer token"}` | [VERIFIED: probe against a scratch main `substrate-mcp` on :18998 with a list-form token] |
| Does Claude Code connect to main's stateless `/mcp`? | Yes. It sends `server/discover` then `initialize` (protocol `2025-11-25`) | [VERIFIED: probe → `✔ Connected`; stub log shows both methods] |

### Recommended mechanism (A5)

Extend claude-ultrathink `scripts/mcp-register.ts` with `--substrate` (Claude host only, opt-in, never default). It runs, through the script's existing `Run` seam and backup logic:

```text
claude mcp add-json --scope user substrate '{"type":"http","url":"<substrate.url>/mcp","headers":{"Authorization":"Bearer ${SUBSTRATE_TOKEN:-}"},"headersHelper":"<clone>/bin/ultrathink-mcp substrate headers"}'
```

- URL from the ultrathink config `substrate.url` (env `SUBSTRATE_URL` wins, same as `resolveSubstrate`); refuse to install when neither is set.
- `${SUBSTRATE_TOKEN:-}` names the variable (UAT-03) and avoids the "Missing environment variable" warning; empty means the helper's value or no bearer.
- `ultrathink-mcp substrate headers` prints `{"Authorization":"Bearer <v>"}` when the D20-04 resolution (with surface `claude-code`) finds a value, else `{}`; it always exits 0, writes nothing to stderr, never logs the value.
- Ownership: an entry is "ours" when `headersHelper` ends with `/bin/ultrathink-mcp substrate headers` (mirror of `isOurs`, `mcp-register.ts:108`); `--remove` deletes only ours.
- Precedent: the script already writes `<clone>/bin/ultrathink-mcp` absolute paths into user configs (`mcp-register.ts:204-205`), so the same "re-run after moving the clone" caveat applies; the plugin cache path changes per version, so document running it from the stable clone.

## 2. claude-ultrathink kickoff and token resolution (UAT-03, D20-13)

### Where tracking refs are finalized
- In-hook (Claude, Grok, Muse, Omp): `src/claude/hook.ts:676-693` (`deps.track(...)` → `tracking`), record written with `host: deps.surface ?? "claude-code"` (`hook.ts:700-714`); Hermes passes no tracker (`src/host/plan.ts:224-228`).
- Kickoff command: `src/mcp/cli.ts:283-324` `trackComplete` → `tracker({plan, graph, existing})` → `writeAtomic(statePath, …)` → prints `tracking <status> · …` [VERIFIED: `git show origin/main:src/mcp/cli.ts`].
- SKILL step 1 runs `<repo>/bin/ultrathink-mcp track complete --state <stateFile>` only when `tracking.status` is not `"complete"` [VERIFIED: `skills/ultrathink-kickoff/SKILL.md` step 1]. Hence A4.

### Recommended change
- `src/substrate/register.ts` (new): `buildRegisterArgs(record)` (pure) and `registerGraph(record, env, configuredUrl, fetchImpl?)` → `{ outcome: "registered" | "skipped" | "failed", detail }`, never throws. Same opt-in as `fetchBrief` (`resolveSubstrate`: no URL → skipped; `SUBSTRATE_DISABLED=1` → skipped).
- Wire: `POST <url>/mcp`, headers `content-type: application/json`, `accept: application/json, text/event-stream`, bearer from the shared resolver (surface below); body `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"graph_register","arguments":{…}}}`; no `initialize`, no session header (stateless server, §3). Parse JSON or the last `data:` SSE frame (`chaos-smoke.ts:84-102`). A tool error is `result.isError === true`.
- Arguments (SKILL step 3 table, restricted to the server schema `mcp.ts:442-486`): `graph_id = plan.graphId`; `notion_task_page = tracking.notion.taskUrl`; `repo`/`branch` = `plan.task.repo`/`.branch`; `status = plan.task.status`; `nodes[]` from `tracking.linear.nodes[n]` (`linear_issue_id = .id`, `linear_identifier = .identifier`) and `tracking.notion.nodes[n]` (`notion_page`); `steps[]` from keys `"<nodeId>.<step>"` (`linear_sub_issue_id = .id`, `notion_page = notion.steps[key]`). Send only schema fields (SKILL's `linear_url`/step `linear_identifier` are not in the schema; zod would strip them [ASSUMED: zod 4 `z.object` default strip]). Omit absent values.
- `surface`: the record's `host` only when it is a substrate surface (`claude-code`, `grok-build`, `hermes`, `muse`, `omp`); `prime-agent` is a claude-ultrathink host (`src/host/types.ts:7`) but not a substrate surface, so omit it and let the server use the token's surface (`mcp.ts:488`). Sending it would fail zod validation of `surfaceSchema`.
- CLI: `ultrathink-mcp substrate register --state <file>` prints one line (`substrate: registered <graphId>` / `substrate: skipped (<reason>)` / `substrate: register failed (<status or error, redacted>)`) and exits 0. `trackComplete` calls `registerGraph` after `writeAtomic` when `tracking.status !== "failed"` and prints the same line. `ultrathink-mcp substrate headers` (§1). Add both to `USAGE` (`cli.ts:30-40`).
- `SKILL.md` step 3: "Run `<repo>/bin/ultrathink-mcp substrate register --state <stateFile>` once (step 1's command already registered when it ran; running again is harmless, `graph_register` is idempotent by `graph_id`). Only if the command cannot run (exit 127/126, file missing), call `graph_register` on an MCP server named `substrate` when one is connected, as before." Keep "fail open, one line, no retry".
- `src/substrate/brief.ts`: replace `authHeaders(env)` with `authHeaders(env, surface)` using `SUBSTRATE_TOKEN` → `SUBSTRATE_TOKEN_FILE` → tokens-dir `<dir>/<surface>`; callers pass `input.surface ?? "claude-code"` (`fetchBrief`, `emitEvent`). Host → surface is the identity map for the five shared names (`detectHost`, `src/host/detect.ts`; Grok hooks set `ULTRATHINK_HOST=grok-build` in `~/.grok/hooks/ultrathink.json`; Hermes sets `child_env["ULTRATHINK_HOST"] = "hermes"` in `hosts/hermes/bridge.py:369`).
- Docs: `docs/configuration.md` env table (`SUBSTRATE_TOKEN`, add `SUBSTRATE_TOKEN_FILE`, `SUBSTRATE_TOKENS_DIR` in prose), `substrate` section (registration), `README.md:94,111` and `docs/privacy.md` (registration now sends Notion page URLs, Linear issue ids/identifiers, repo, branch, status to the substrate), `docs/how-to/register-mcp-gateway.md` (`--substrate`), `CHANGELOG.md` `[Unreleased]`.
- Tests (beside code, fake `fetch`, temp dirs): `src/substrate/register.test.ts` (args mapping, prime-agent omission, opt-in skip, SSE parse, 401/503/timeout → failed without throw, bearer from tokens dir, no value in output); `src/substrate/brief.test.ts` (tokens-dir file used for the input surface; env wins; missing/dir-instead-of-file → no header; surface with `/` or `..` never read); `src/mcp/cli.test.ts` (`track complete` calls register once with a seam; `substrate register` on a record without `plan` → skipped; `substrate headers` prints `{}` without a value).

### Hosts and token reachability
| Host | Process env source | Surface | Resolution after change |
|---|---|---|---|
| Claude Code hooks | Claude Code session env (no `SUBSTRATE_TOKEN` today) | `claude-code` | tokens dir `claude-code` |
| Claude Code MCP entry | same | `claude-code` | helper → tokens dir |
| Grok Build hooks | Grok process; hook `env` only sets `ULTRATHINK_HOST` | `grok-build` | tokens dir `grok-build` |
| Hermes engine | `os.environ.copy()` of Hermes (`bridge.py:342-343`) | `hermes` | tokens dir `hermes` |
All run as root on this host and `/etc/substrate` is `drwx------ root` [VERIFIED: `ls -ld`], so the files are readable to them and to nothing else.

### Scenario 4 without model quota
Import the **installed** plugin (`installPath` from `~/.claude/plugins/installed_plugins.json`, today `/root/.claude/plugins/cache/ultrathink/ultrathink/0.3.0`, `gitCommitSha 85ca1acc…`): (a) `fetchBrief({repo, branch, surface: "claude-code"}, env, url)` — 0.3.0's signature is `(input, env)` and ignores the third argument; 1.4.0's is `(input, env, url)` [VERIFIED: both files]; pass `SUBSTRATE_URL` in `env` so both versions hit the target; 0.3.0 defaults to `http://127.0.0.1:7410` when the URL is unset, so always set it. (b) `formatPromptContext({ result: {xml:"<BUILD_PROMPT/>", original:"uat", root:<cwd>, source:"fallback"}, brief })` from `<installPath>/src/claude/output.ts` contains `SUBSTRATE_CONTEXT_HEADER` (`## Agent Substrate brief`) — both versions export both [VERIFIED]. Do not drive `runPromptSubmit`: it starts lookups (Jev decisions over OpenRouter, teach recall) that can spend quota.

## 3. substrate-mcp HTTP MCP transport

- Stateless: `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per request (`server.ts:530-537`); `validateSession` returns early when `sessionIdGenerator === undefined` [VERIFIED: sdk `webStandardStreamableHttp.js:737-741`]. No `initialize`, no `mcp-session-id`.
- POST only (`server.ts:514-517` → 405 otherwise); `accept` must include both `application/json` and `text/event-stream` or the SDK answers 406 [VERIFIED: sdk `:470-472`; `chaos-smoke.ts:66-70`]; `content-type: application/json`.
- Responses to `tools/list`/`tools/call` are one SSE frame (`data: {…}`) [VERIFIED: probe body was 2 lines].
- The 401 gate runs before every route including `/healthz` [VERIFIED: probe, no bearer → `/mcp` 401, `/healthz` 401 once a token is set].
- Probe (scratch main on :18998, server env `SUBSTRATE_TOKEN_CLAUDE_CODE=probe-tok-a,probe-tok-b`): `Bearer probe-tok-a` → 401, `Bearer probe-tok-a,probe-tok-b` → 200, proving today's `readTokens` treats the list as one opaque value (the D20-02 change is real work).
- Nine v1.0 tools (`STATE.md:49-51`): `memory_brief`, `memory_write`, `memory_search`, `events_emit`, `graph_get`, `graph_register`, `graph_claim`, `graph_release`, `graph_complete`.
- Today's set on this branch, 19 [VERIFIED: probe `tools/list` and `mcp.ts:178-785`]: `coord_drift_scan`, `coord_handoff`, `coord_handoff_list`, `coord_handoff_verify`, `coord_reap_leases`, `events_emit`, `events_query`, `events_verify`, `graph_bind`, `graph_claim`, `graph_complete`, `graph_get`, `graph_heartbeat`, `graph_register`, `graph_release`, `memory_brief`, `memory_pending`, `memory_search`, `memory_write`. Later phases add more, so scenario 1 asserts "superset of the nine".

## 4. List-form tokens (D20-02, A1, A8)

Current code [VERIFIED: `config.ts:120-127`, `:173-176`]:
```ts
function readTokens(env: Record<string, string | undefined>): Map<string, Surface> {
	const tokens = new Map<string, Surface>();
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith("SUBSTRATE_TOKEN_") || !value) continue;
		tokens.set(value, envSuffixToSurface(key.slice("SUBSTRATE_TOKEN_".length)));
	}
	return tokens;
}
// …
		tokens: readTokens(env),
		allowAnonymous: readTokens(env).size === 0,
```
`readReviewTokens` precedent (`config.ts:194-203`) splits `/[\s,]+/` but also drops entries shorter than 16. **Do not copy the length filter**: every test fixture uses short values (`tok-hermes`, `tok-a05`, `tok-a`).

Recommended shape:
- `export class ConfigError extends Error {}` and a pure `export function tokenConfig(env): { tokens: Map<string, Surface>; errors: string[] }`: for each `SUBSTRATE_TOKEN_<X>`, `X → surface`; if the surface is not in `SURFACES` → error `SUBSTRATE_TOKEN_<X> names no surface` (A1); split value on `/[\s,]+/`, trim, drop empties; a value already mapped to a different surface → error naming both variables (D20-02); same value twice under one variable → dedupe silently. Errors never include a value.
- `loadConfig` calls it once, throws `ConfigError(errors.join("; "))` when any; `allowAnonymous` from the same map (PR #22 makes the same single-call refactor — expect a textual conflict there, A8).
- `index.ts` (`:16`, top-level `const config = loadConfig()`): wrap; on `ConfigError` write `[substrate] refused — <message>\n` and `process.exit(1)`; rethrow anything else. This is the first boot refusal: `index.ts:5-9` documents "never a reason to refuse to start" for degraded stores and observability, so add a sentence that a self-contradictory identity config is the exception. `configWarnings`/`swarmTokenWarnings` stay warnings.
- systemd: the repo unit has `Restart=always`, `RestartSec=3`, `StartLimitIntervalSec=0` (`infra/vps/substrate-mcp.service`); a refused config crash-loops every 3 s with the refusal line in the journal, and rollback is editing the env file. Optionally add `RestartPreventExitStatus=78` and exit 78 (EX_CONFIG) — the installed unit (no `StateDirectory`, `systemctl cat` read-only) differs from the repo unit, so this only applies once the repo unit is installed.
- `.env.example`: comment the list form on the `SUBSTRATE_TOKEN_*` block; delete line 103-104 (`SUBSTRATE_TOKEN_DESK_GATEWAY`) and put its comment on `SUBSTRATE_TOKEN_GROK_BOT` ("the Grok Bot gateway and grok-hermes-connector each hold one entry"); add blank `SUBSTRATE_TOKEN_CODEX=`, `SUBSTRATE_TOKEN_OPENCODE=`, `SUBSTRATE_TOKEN_PI=` (D20-05 surfaces missing today; the D20-11 lock test needs them); Phase 17 adds `SUBSTRATE_TOKEN_SUBSTRATE=`.
- Docs: `docs/coordination.md` (list form, operator entry, boot refusal), `docs/grok-bot.md:9` (gateway value is one `SUBSTRATE_TOKEN_GROK_BOT` entry), `docs/swarm-workspace.md:78-94` (list form allowed; the swarm installer copies `SUBSTRATE_TOKEN_<SURFACE>` verbatim into the agent's `SUBSTRATE_TOKEN`, so swarm surfaces must stay single-valued), `docs/memory-governance.md:104`, `docs/lessons-bank.md:48`, `.planning/PROJECT.md:101` (names `SUBSTRATE_TOKEN_DESK_GATEWAY`).
- Tests: extend `authority.test.ts` (list resolves each entry; whitespace/newline split; duplicate across surfaces throws `ConfigError` whose message names both variables and not the value; unknown suffix throws; single value unchanged; operator entry in a list is an operator) and `server.authority.test.ts` (a second list entry authenticates over HTTP); add a boot test that spawns `bun packages/mcp-server/src/index.ts` with a duplicate env and asserts non-zero exit, both names on stderr, value absent from stdout+stderr (refusal precedes stores, so no Postgres/Greptime needed).
- Overlap: Phase 17 touches `types.ts` (`substrate` appended), `mcp.ts` (`attributedSurface`), `authority.test.ts` (surface pin 27) and `.env.example` (`SUBSTRATE_TOKEN_SUBSTRATE=`); not `readTokens` [VERIFIED: 17-01-PLAN.md]. PR #22 touches `config.ts` `loadConfig`, adds `config.test.ts`, rewrites `git/post-commit` (inline `bun -e` reading only `SUBSTRATE_TOKEN`) and `grok.ts` [VERIFIED: `gh pr diff 22`]. If #22 merges first, its inline post-commit poster also needs the tokens-dir resolution.

`git grep` for `SUBSTRATE_TOKEN_[A-Z0-9_]+` outside docs finds only surface suffixes plus `SUBSTRATE_TOKEN_DESK_GATEWAY` (`.env.example`) and `SUBSTRATE_TOKEN_X` (a comment in `store-lock.test.ts:92`), so A1 breaks no test [VERIFIED].

## 5. Client token resolution (D20-04, D20-05, A3)

- CLI today: `headers()` takes no surface (`cli/src/index.ts:37-40`); `post()` calls it (`:63-74`); `lessons` builds its own token (`:392`). Each command knows its surface: `brief`, `emit`, `handoff` use `str(args.surface) ?? "claude-code"` (`:82`, `:121`, `:231`); `verify`, `drift`, `evidence`, `lessons` have none → `claude-code`. The file executes its `switch` at module load (`:366-415`), so put the resolver in a new pure module (`packages/cli/src/token.ts`) to make it unit-testable, and test the CLI end to end by spawning it against a `Bun.serve` stub.
- Resolver (one implementation, imported by the CLI, Phase 19 `emit.ts` via relative path like its `redact.ts` import, `scripts/parity-check.ts` and `scripts/uat-phase0.ts`): `resolveBearer(surface, env, readFirstLine?)` → `SUBSTRATE_TOKEN` (trimmed) → `SUBSTRATE_TOKEN_FILE` first line → `<SUBSTRATE_TOKENS_DIR or /etc/substrate/tokens>/<surface>` first line → none. Validate `surface` against `/^[a-z0-9][a-z0-9-]{0,63}$/` before joining a path (the CLI's `--surface` is caller-controlled). Cap the read (4 KiB), treat any error (missing, EISDIR, EACCES) as "no token", never log.
- `SUBSTRATE_TOKEN_FILE` makes D20-08's parity-check option and D20-03's operator file usable without exporting a value; it is a client-only name. A1 makes the server refuse it if it ever lands in `substrate.env`.
- Phase 19 `emit.ts` API (planned): `postEvent(event, { timeoutMs, collector, source, url?, token? })`, env read at call time [VERIFIED: 19-01-PLAN.md truths/action]. Phase 20 changes the default token to `opts.token ?? resolveBearer(event.surface, process.env)`, which gives herdr per-event-surface tokens with no herdr change, provided the herdr unit's env has no `SUBSTRATE_TOKEN` (A3).
- Muse PostToolUse hook (Phase 19): reads `tokenFile` from the bundle's `hooks/substrate.json`, default from `SUBSTRATE_MUSE_TOKEN_FILE` → `/etc/substrate/substrate-collector-muse.env` (a `KEY=value` file holding `SUBSTRATE_TOKEN`) [VERIFIED: 19-04-PLAN.md truth D19-18 (truncated in read) and acceptance "substrate.json holds url, tokenFile and stateDir and no token value"]. The manifest lists it with delivery "env file `substrate-collector-muse.env`, variable `SUBSTRATE_TOKEN`".
- git post-commit: runs the CLI from `SUBSTRATE_CLI` (default the operator checkout, `post-commit:13`), backgrounded, `>/dev/null 2>&1`, surface `${SUBSTRATE_SURFACE:-cursor}`; the CLI change covers it once the operator checkout is pulled. `install-git-hook.ts` **copies** the file (`:61-62`, `:72-73`) and `--check` reports `present`/`not installed`/foreign without writing; a changed hook needs a re-run of the installer to refresh copies.
- Store lock: `TOKEN_LITERAL` (`store-lock.test.ts:95`) flags any `SUBSTRATE_TOKEN*` name followed by `:`/`=` and ≥16 chars of `[\w.~+/=-]`; tests must use short fixtures and short identifiers after such a key (a three-letter local such as `dir` passes; a 16+ character camelCase local fails) [VERIFIED: regex run, Pitfall 1].

## 6. Post-switch evidence (D20-12)

- **401 count, exact:** after switch-on every authenticated request has a surface, so `GET /metrics` → `metrics[name="substrate.request.total"].points` with `attributes.surface == "unattributed"` and `status == "4xx"` is exactly the number of 401s since process start, per `route` [VERIFIED: probe output `[{"surface":"unattributed","route":"/mcp","status":"4xx"},4], … [{"surface":"unattributed","route":"/healthz","status":"4xx"},1]`; `server.ts:236-241`, `instruments.ts:215-225` buckets status into a class]. Read once right after restart and again after the soak; the delta is the soak's 401s. Counters reset on restart.
- **Attribution:** the same counter's points with `surface == <s>` and `status == "2xx"` per route show each token resolving (brief callers included, which `events_query` cannot show). Two clients of one surface are not separable (deferred per-token labels). Note Claude Code's `server/discover` probe lands as a `4xx` under the *authenticated* surface on `/mcp` (probe: `claude-code /mcp 4xx: 4`) — expected noise, not a 401.
- **Spans:** `startRequestSpan` sets `http.route` and `substrate.surface` and `http.response.status_code` (`observe.ts:520-521`, `server.ts:233`), but production exports nothing (boot logs "no OTLP endpoint configured"), so spans are not a production read.
- **Journal:** no line per 401; at boot after switch-on expect `[substrate] misconfigured — no token for 15 swarm surfaces (…)` (`swarmTokenWarnings`) [VERIFIED: scratch boot output] and `listening … (<n> tokens, audit <path>, …)` where `<n>` counts values, not surfaces.
- **`/healthz`:** returns `index`, `greptime`, `appendOnly`, `quotingDialectKnown`, `eventsWritable` (`service.ts:1467-1486`) plus `auditDurable`, `auditRecords` (`server.ts:267-268`). `SUBSTRATE_AUDIT_PATH=/var/lib/substrate/mcp-audit.jsonl` (`.env.example:133`). The installed unit has no `StateDirectory=` but `/var/lib/substrate` exists (`drwxr-xr-x root`, created by the collectors) and the unit runs as root [VERIFIED: `systemctl cat` grep, `ls -ld`], so the path works with either unit.
- **Handoff round trip:** `substrate handoff --to hermes --goal "uat-<tag> handoff check" --graph <G>` prints `<id> to hermes — signed, stored` (`cli/src/index.ts:241-244`); read back with MCP `coord_handoff_list {graph_id: G}` (each packet with its verification verdict, `mcp.ts:735-747`) or `coord_handoff_verify {packet}` (`mcp.ts:721-733`). `/verify` is the event hash chain, not handoff signatures. The sender is the token's surface (`server.ts:409`), so with the operator token it is `claude-code`.
- **`parity-check.ts` (Phase 16):** `probeHealthz()` reads only `SUBSTRATE_TOKEN` (`parity-check.ts:283-291`) and the verdict already says `"healthz answered 401 (auth is configured — set SUBSTRATE_TOKEN)"` (`:142-143`); D20-08 swaps the token read for `resolveBearer("claude-code", env)` and the 401 text for "auth on, token missing"; extend `parity-check.test.ts`.

## 7. UAT scenarios (UAT-01, UAT-02)

Script shape: pure exports plus `if (import.meta.main)`, like `scripts/rehearsal.ts`. Exit 0 all selected scenarios pass, 1 any fails, 2 usage/refused. Report JSON `{ tag, target: { url_host, class }, started_at, plugin?: {version, sha}, scenarios: [{ id, title, result: "pass"|"fail"|"refused"|"skipped", checks: [{ok, what, detail?}], evidence: {…} }] }` plus a Markdown table; evidence holds ids, counts, statuses, booleans and elapsed ms — never a token, never raw brief bodies or event summaries from production (they can name repos and hosts; AGENTS.md forbids internal hostnames in the repo).

Target class (A7): `production` when port ∈ `PRODUCTION_PORTS` or host is not loopback (`127.0.0.1`, `localhost`, `::1`); else `scratch`. Write scenarios need `--live <approval-ref>` on production. Run tag default `uat-<base36 time>`; graph ids `ut-uat-<tag>-<n>`, sessions `uat-<tag>-<n>`, scratch repos `uat-<tag>/<name>` (lowercase; `normalizeIdentifier` lowercases repo matching, `brief.ts:154`).

| # | Calls (all through `SUBSTRATE_URL`) | Assertions | Where |
|---|---|---|---|
| 1 | `GET /healthz`; MCP `tools/list`; `POST /brief {repo, surface}`; `POST /events {kind:"note", summary:"uat-<tag> probe", surface, session_id, graph_id}` (scratch only, or production with `--live`); `POST /verify {graph_id}` on the probe graph and, read-only, on `--verify-graph` (default `ut-mucem4mc-ec70360f`, the September proof graph) | healthz 200; the nine names ⊆ tool names (record the full count); brief 200 text; events 202 `stored:true`; verify 200 (record `ok` and any first failing event for the September graph, never hide it) | harness; production read-only (skip the emit) |
| 2 | `GET /healthz`; MCP `events_query {limit: 20, order:"desc"}`; pick the first row with `graph_id` → `graph_get`; `memory_search {query: <--memory-query, default "substrate">, limit: 5}` | `index`, `greptime`, `appendOnly` all `true`; events ≥1; `graph_get` returns a graph; memory rows ≥1 (0 is a recorded failure, not a skip). Anchors shape and row counts: operator SQL step, recorded by hand | production read-only |
| 3 | Harness: fixture `rows.json` (shape of `backfill.ts:27-41` `NotionRow`; graph ids run-tagged; `Issue ID` set on Issue rows, `Linear URL` on Sub-Issue rows) → validate with `mapNotionRows` (pure import) → spawn `bun packages/mcp-server/src/backfill-run.ts rows.json` with a minimal env `{PATH, HOME, SUBSTRATE_PG_URL: <consumer.env SUBSTRATE_TEST_PG_URL>}` → MCP `graph_get` per id. Production: `--notion-export <file>` (operator's read-only export) → `graph_get` per Graph ID, no write | every graph found; nodes carry `linear_identifier` | harness (fixture), production (export) |
| 4 | Import `<installPath>/src/substrate/brief.ts` and `<installPath>/src/claude/output.ts` (§2) | brief non-empty; `formatPromptContext({result, brief})` contains `## Agent Substrate brief`; record `version`, `gitCommitSha` from `installed_plugins.json` | harness |
| 5 | Read-only: parse `<CLAUDE_CONFIG_DIR or HOME>/.claude.json` top-level `mcpServers.substrate` and extract only `type`, `url` host:port, and whether `headers.Authorization` matches `/^Bearer \$\{SUBSTRATE_TOKEN(:-[^}]*)?\}$/`; optionally `claude mcp get substrate` `Status` line. Live: `--graph <gid>` → `graph_get` | entry exists, `type` `http`, URL equals the target's `/mcp`, header names the variable (booleans only in the report); graph has nodes with `linear_identifier` and `surface == "claude-code"` | production (operator kickoff) |
| 6 | `bun packages/projector/src/cursor.ts --check` (exit 0 = current) and `--print-desired` (Phase 19); `install-git-hook.ts --check <repos>`. Harness: scratch repo with `origin` = `https://example.invalid/uat-<tag>/scratch.git`, run each desired hook command via `sh -c` with env `SUBSTRATE_URL`, `SUBSTRATE_CLI`/`SUBSTRATE_CURSOR_STOP` pointing at the worktree, cwd the scratch repo, stdin a synthetic envelope (sessionStart `{}`, postToolUse `{"tool_name":"Edit"}`, stop `{"conversation_id":…,"status":"completed"}` per Phase 19's `cursor-stop.ts` contract with `SUBSTRATE_CURSOR_ROOT`/`SUBSTRATE_TRANSCRIPTS_DIR` in temp dirs); install the post-commit hook into the scratch repo and commit; poll `events_query {surface:"cursor", repo:<slug>, since:<t0>}` up to 10 s | `.substrate/BRIEF.md` written (A2); `tool.call`, `session.end`, `commit` rows present; every hook command exit 0, stdout empty | harness; production read-only checks + operator's real session/commit read by `since` |
| 7 | Ignore the target (A9): `pickFreePort()` then close → dead port; a `Bun.listen` TCP server that accepts and never writes → hanging; for each: in-process `fetchBrief` (installed plugin) and spawned `substrate brief --surface cursor` and the Cursor `sessionStart`/`postToolUse` hook commands | `fetchBrief` returns `""` in ≤ 1500 ms + 250 ms slack; CLI exit 0, stdout empty, wall ≤ 1500 ms + startup allowance (record the measured startup; suggest 1000 ms); hooks exit 0, stdout empty. Never stops any process | anywhere |
| 8 | `graph_register {graph_id: G, repo: R, nodes:[{node_id:"n1"}]}` as caller; `graph_claim {graph_id:G, node_id:"n1", surface:"claude-code", session_id:"uat-<tag>-8"}`; `POST /events {kind:"file.edit", summary:"uat-<tag> edited x.ts", surface:"cursor", repo:R, graph_id:G}`; `POST /brief {repo:R, graph_id:G, surface:"hermes"}` (A6) | brief contains the `cursor` `file.edit` summary line and `n1 held by claude-code` | harness (production optional, permanent rows) |

Tokens on the harness: `consumer.env` exports `SUBSTRATE_TOKEN` (first non-swarm surface) and `SUBSTRATE_REHEARSAL_TOKENS_DIR` (one 0600 file per `--surfaces` entry) [VERIFIED: `rehearsal-env.ts:196-206`]. One token suffices: a non-swarm, non-`substrate` token may name any surface on `/events`, and `/brief` takes the body's surface (`mcp.ts:91-97`, `server.ts:324`). To exercise real per-surface attribution the operator may run with `SUBSTRATE_TOKEN` unset and `SUBSTRATE_TOKENS_DIR` pointed at the rehearsal tokens dir; run `rehearsal up --name p20 --surfaces claude-code,cursor,hermes,omp` (the default list) so scenario 8's three surfaces have files.

Notion export for scenario 3 production (operator): Notion MCP `query-data-sources` in SQL mode on `collection://be3418f0-d2d8-411b-8677-fa8a95ee63be` (the default `NOTION_TASK_GRAPH_DS`, `config.ts:172`) selecting `url, "Graph ID", "Level", "Item", "Issue ID", "Linear URL", "Linear State", "Step", "Repo", "Branch", "Status", "Agent", "PR URL"`; save as JSON array (or `{results:[…]}`, both accepted by `backfill-run.ts:29-31`). Read-only.

## 8. Identity manifest and check (D20-11)

- Manifest `infra/identity/clients.json`: `{ "version": 1, "server_env": "/etc/substrate/substrate.env", "required_server_names": ["SUBSTRATE_OPERATOR_TOKENS", "SUBSTRATE_HANDOFF_KEY", "SUBSTRATE_AUDIT_PATH"], "clients": [{ "id", "surface", "delivery": {"kind": "tokens-dir"} | {"kind": "env-file", "path", "variable"} | {"kind": "operator-file", "path"} | {"kind": "external", "note"}, "state": "live" | "after-phase-19" | "dormant:<phase>" | "not-installed", "evidence": "<how read>" }] }`. Rows from the ClientInventory table (CONTEXT lines 24-40), split per client (Claude hooks, Claude MCP entry, Grok hooks, Hermes engine, Cursor hooks, git post-commit, grok collector, herdr per surface, Muse writer, Muse hook, connector, gateway, operator, dispatcher, host, skills sync, bridge, miner, swarm A01-A15 `not-installed`, omp-ultrathink/hermes-plugin/hermes-eng-board/skill-autonomy `not-installed`).
- Names-only parser (systemd `EnvironmentFile` syntax): per line, strip; skip empty and lines starting `#` or `;`; strip an optional `export `; match `^([A-Za-z_][A-Za-z0-9_]*)\s*=`; record the name and `valueIsEmpty = rest.trim() === "" || rest.trim() === '""' || rest.trim() === "''"`, then drop `rest`. A line whose previous line ended with `\` is a continuation: skip it, never parse it as a key (a continuation fragment such as `abc=` would otherwise surface part of a value as a "name"). Output only names from the manifest's expected set plus any unexpected name that starts with `SUBSTRATE_TOKEN_` (reported as unexpected, e.g. `SUBSTRATE_TOKEN_DESK_GATEWAY`); never echo arbitrary names. Last definition wins (systemd), but report duplicates by count.
- Tokens-dir check (names-only): `stat` the file → exists, regular, mode `0600`, owner root, size > 0; never read it in names-only mode. Directory mode `0700`.
- `--values` (operator only): read values into memory, `sha256` each entry of each server `SUBSTRATE_TOKEN_*` list and each client value; `match` when a client's hash is in its surface's set, `mismatch` when present but in another surface's set or none, `missing` when absent. Also run the server's `tokenConfig()` validator (§4) on the server env and print its errors (they name variables only), so a duplicate or unknown suffix is caught before the restart. Never print hashes either (a hash of a short token is guessable).
- Exit 1 when any `live` client is not `ok`/`match`; dormant and not-installed are reported, never fail.
- Lock test (`scripts/identity-check.test.ts` or `infra/identity/clients.test.ts`): every manifest `id` appears in the runbook table between markers (`<!-- identity-clients:start -->` / `:end`, the Phase 17 marked-table pattern); every manifest surface has `tokenEnvName(surface) + "="` in `.env.example`; manifest surfaces ⊆ `SURFACES`; no `delivery.path` under a repo checkout. Plus parser tests with fixtures that contain values (short, below the `TOKEN_LITERAL` length) asserting values never appear in output, continuation lines, quoted values, `export`, comments.

## Architecture Patterns

### System Architecture Diagram

```text
                  operator (approved window)
                  ├─ writes 0600 values ─► /etc/substrate/tokens/<surface>, env files, ~/.config/substrate/operator.token
                  ├─ bun run identity:check [--values] ─► reads names (or values in memory) ─► match/missing/mismatch
                  └─ edits /etc/substrate/substrate.env (list values) ─► restart substrate-mcp
                                                                      │
 client process (hook / collector / CLI / plugin)                     ▼
   surface S ─► resolveBearer(S): SUBSTRATE_TOKEN ─► SUBSTRATE_TOKEN_FILE ─► tokens dir/S ─► (none)
   └─ HTTP POST /brief|/events|/mcp  Authorization: Bearer <v> ─────────► substrate-mcp :7410
                                                                           ├─ tokenConfig(env) at boot: list form,
                                                                           │   duplicate / unknown suffix ⇒ exit 1
                                                                           ├─ surfaceForToken ⇒ S or null
                                                                           ├─ null && !allowAnonymous ⇒ 401 (metrics: unattributed 4xx)
                                                                           └─ route ⇒ stores; metrics surface=S
 Claude Code ─► ~/.claude.json mcpServers.substrate (user scope)
   headers "Bearer ${SUBSTRATE_TOKEN:-}" ◄─ overridden by headersHelper ─► ultrathink-mcp substrate headers ─► tokens dir/claude-code
 kickoff ─► ultrathink-mcp track complete ─► registerGraph ─┐
        └─► ultrathink-mcp substrate register (step 3) ─────┴─► POST /mcp tools/call graph_register (idempotent)
 uat:phase0 ─► classify target ─► guards (--live) ─► scenarios 1..8 ─► report.json + report.md
```

### Recommended Project Structure

```text
packages/mcp-server/src/config.ts         # tokenConfig(), ConfigError, list form (edit)
packages/mcp-server/src/index.ts          # boot refusal (edit)
packages/cli/src/token.ts                 # resolveBearer() (new, pure)
packages/cli/src/index.ts                 # headers(surface), lessons token (edit)
packages/collectors/src/emit.ts           # default token = resolveBearer(event.surface) (edit, Phase 19 file)
scripts/parity-check.ts                   # bearer via resolveBearer (edit, Phase 16 file)
scripts/identity-check.ts (+ .test.ts)    # names-only / --values
scripts/uat-phase0.ts (+ .test.ts)        # UAT runner, pure parts exported
scripts/uat/fixtures/notion-rows.json     # scenario 3 fixture (run-tag substituted at run time)
infra/identity/clients.json               # manifest
docs/runbooks/production-identity.md      # runbook with marked client table
docs/uat.md                               # how to run the regression
claude-ultrathink: src/substrate/register.ts (+test), src/substrate/brief.ts, src/mcp/cli.ts, scripts/mcp-register.ts, skills/ultrathink-kickoff/SKILL.md, docs, CHANGELOG.md
```

### Pattern 1: one validator, two callers
**What:** `tokenConfig(env)` is the only place that knows the list form and its refusals; boot throws on its errors, `identity:check --values` prints them.
**When to use:** any rule that decides whether the server will start.

### Pattern 2: one resolver, every agent-substrate client
**What:** `resolveBearer(surface, env)` in `packages/cli/src/token.ts`; the CLI, `emit.ts`, `parity-check.ts` and `uat-phase0.ts` import it. claude-ultrathink carries the same rule in `brief.ts` (separate repo, same order and names).

### Pattern 3: pure core + `import.meta.main` scripts
**What:** classification, guards, expectations, report rendering and parsers are exported pure functions with server-free tests; the main block does I/O. Precedent `scripts/rehearsal.ts`, `scripts/parity-check.ts`.

### Anti-Patterns to Avoid
- **Copying `readReviewTokens`'s 16-char filter into `readTokens`:** breaks every short-fixture test and would make a short operator value silently anonymous.
- **Writing `<NAME>=<path>` for `SUBSTRATE_TOKENS_DIR`/`SUBSTRATE_TOKEN_FILE` in tracked files:** fails `store-lock.test.ts`.
- **UAT importing `service.ts`/`greptime.ts` or naming `GREPTIME_`:** violates D20-14 and `store-lock.test.ts` rule 1; spawn `backfill-run.ts` instead.
- **Driving `runPromptSubmit` for scenario 4:** may call OpenRouter (Jev) and teach lookups.
- **Registering graphs only in `track complete`:** misses in-hook-complete graphs (A4).
- **Reading `/etc` values in names-only mode, or printing hashes in `--values` mode.**

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| MCP client handshake | an `initialize` + session state machine | one stateless JSON-RPC POST with both Accept types; SSE `data:` parse (`chaos-smoke.ts`) | the server is stateless; Claude Code itself connected without a session |
| Target guard | new port lists | Phase 16 `PRODUCTION_PORTS`, `refuseSmokeUrl` logic, `pickFreePort` | one definition of "production" |
| Host MCP entry writes | editing `~/.claude.json` JSON by hand | `claude mcp add-json --scope user` through `mcp-register.ts`'s `Run` seam, with its backups and `--dry-run` | Claude Code owns the file format and validation |
| Notion row → plan mapping | a new mapper | `mapNotionRows` (`backfill.ts`) | tested against real rows |
| Hashing for equality | custom compare | `node:crypto` sha256 + `timingSafeEqual` not needed (in-memory set membership of hashes) | no value leaves memory |
| Doc/table drift | free-text runbook | marked table + parse test (Phase 17 `event-vocabulary` pattern) | manifest and runbook cannot drift |

**Key insight:** identity here is configuration, not code; the only code worth writing is the validator, the resolver and the checks that make a misconfiguration loud before the restart.

## Runtime State Inventory

| Category | Items Found | Action Required |
|---|---|---|
| Stored data | Greptime ledger and Postgres index carry surfaces, not tokens; audit records surface only. No data keyed by a token value. Scenario 5/8 production runs add permanent run-tagged rows | none (record run tags in the report) |
| Live service config | `/etc/substrate/substrate.env` (no `SUBSTRATE_TOKEN_*` today); `/etc/desk-gateway/gateway.env` (`SUBSTRATE_TOKEN` set, comment names `SUBSTRATE_TOKEN_DESK_GATEWAY`); `/etc/grok-hermes/connector.env` (no `SUBSTRATE_*`); `/root/.cursor/hooks.json` (3 substrate entries, `stop` → missing `cursor-stop.ts` until Phase 19); `~/.claude.json` (no `substrate` server); `~/.config/ultrathink/config.json` (`substrate.url` set); `/etc/substrate/tokens/` does not exist [VERIFIED: `ls`] | operator writes token files and env lines (runbook); `mcp-register.ts --substrate` adds the Claude entry |
| OS-registered state | `substrate-mcp.service` (installed copy differs from repo: no `StateDirectory`), `substrate-collector-{grok,herdr,muse}.service` (Phase 19 adds `EnvironmentFile=-…/substrate-collector-<name>.env`), `grok-hermes-connector.service`, `desk-gateway.service`, `substrate-dispatcher.service` (stale), `substrate-host.service` (inactive), skills timers; Hermes cron `substrate-skill-miner` | restarts of substrate-mcp, connector (after its env line), collectors (Phase 19 cutover) are operator steps |
| Secrets/env vars | New names: `SUBSTRATE_TOKEN_<SURFACE>` (list form) for claude-code (hooks+MCP, operator), cursor, grok-build, grok-bot (gateway, connector), hermes, muse, omp, codex, opencode, pi, substrate; `SUBSTRATE_OPERATOR_TOKENS`; `SUBSTRATE_HANDOFF_KEY` (+`_ID`); `SUBSTRATE_AUDIT_PATH`. Client names: `SUBSTRATE_TOKEN`, `SUBSTRATE_TOKEN_FILE`, `SUBSTRATE_TOKENS_DIR` | code reads new names; values are operator-only |
| Build artifacts / installed packages | Claude Code plugin cache `ultrathink@ultrathink` 0.3.0 (`85ca1ac`) — needs a plugin update to ≥ the release carrying this change; operator checkout `/root/src/repos/claude-ultrathink` on `feat/v1.4-session-native-planning` (Grok hooks and Hermes run from it) — needs pulling to `main`; operator checkout `/root/src/repos/agent-substrate` (hooks' `SUBSTRATE_CLI`, post-commit default) — needs pulling; installed git post-commit hooks are copies — none installed today | operator steps D20-20 (6), (7) |

## Common Pitfalls

### Pitfall 1: store lock fires on path-valued client variables
**What goes wrong:** `TOKEN_LITERAL` matches four spellings this phase is likely to write: (a) the tokens-dir variable, an equals sign, then the absolute default path; (b) the token-file variable, an equals sign, then a `~/.config/…` path; (c) the shell default form `${<tokens-dir variable>:-<absolute path>}` (exactly what `20-CONTEXT.md:62` holds); (d) a TS object key `<tokens-dir variable>:` followed by a 16+ character identifier.
**Why it happens:** the regex keys on any `SUBSTRATE_TOKEN*` name, then `:`/`=`, then ≥16 chars of `[\w.~+/=-]`.
**Evidence:** [VERIFIED: bun regex run printed `true` for the four strings above and `false` for `SUBSTRATE_TOKENS_DIR: dir,`, `SUBSTRATE_TOKEN_CLAUDE_CODE=tok-a,tok-operator`, `SUBSTRATE_TOKENS_DIR=${dir}`]; and on this branch now:
```text
(fail) no secrets in the repo > no tracked file assigns a substrate token a value
+   ".planning/phases/20-production-identity-and-phase-0-uat/20-CONTEXT.md",
 0 pass … 1 fail
```
**How to avoid:** write defaults in prose ("defaults to /etc/substrate/tokens"), use `"$HOME/…"` or `$dir` after `=`, keep variable names after a `SUBSTRATE_TOKEN*:` key short; fix `20-CONTEXT.md:62` (A0); run `store-lock.test.ts` after every doc task.
**Warning signs:** `store-lock.test.ts` failing on a `.md` file.

### Pitfall 2: boot refusal is new behaviour in a never-refuse entry point
**What goes wrong:** a thrown error at `index.ts:16` crashes with a stack trace (Bun prints the message; a message built from env could leak) and systemd restarts every 3 s.
**How to avoid:** `ConfigError` messages name variables only; catch in `index.ts`, one line, exit non-zero; test the spawned boot for value absence.

### Pitfall 3: unknown suffix tokens
**What goes wrong:** `SUBSTRATE_TOKEN_DESK_GATEWAY=<gateway value>` creates surface `desk-gateway`; requests authenticate but `memoryWriter`/handoff sender become a non-surface; and any non-surface suffix turns `allowAnonymous` off.
**How to avoid:** A1 refusal; runbook maps the gateway value into `SUBSTRATE_TOKEN_GROK_BOT`.

### Pitfall 4: kickoff never registers in-hook-tracked graphs
**What goes wrong:** registration only in `trackComplete` never runs when the hook already completed tracking.
**How to avoid:** A4 (`substrate register` in step 3).

### Pitfall 5: `prime-agent` surface
**What goes wrong:** `graph_register` with `surface: "prime-agent"` fails zod (`surfaceSchema`), so registration fails for that host.
**How to avoid:** send `surface` only for hosts in substrate `SURFACES`.

### Pitfall 6: scenario 8 brief has no other-surface action
**What goes wrong:** briefing by `graph_id` only shows nodes, never `file.edit` lines.
**How to avoid:** A6, same `repo` on emit and brief.

### Pitfall 7: Cursor sessionStart is not an event
**What goes wrong:** expecting `session.start` from Cursor fails a correct system.
**How to avoid:** A2.

### Pitfall 8: swarm installer and list form
**What goes wrong:** the v1.2 installer copies `SUBSTRATE_TOKEN_<SURFACE>` into an agent's `SUBSTRATE_TOKEN`; a list would become an unknown bearer.
**How to avoid:** runbook: swarm surfaces single-valued; docs/swarm-workspace.md note.

### Pitfall 9: root makes permission tests meaningless
**What goes wrong:** tests run as root; `chmod 000` files are still readable, so "unreadable file" tests pass vacuously.
**How to avoid:** simulate unreadable with a directory at the file path (EISDIR) or an injected reader.

### Pitfall 10: herdr picks the env token for every surface
**What goes wrong:** with `SUBSTRATE_TOKEN` in the herdr unit env, D20-04 order sends one surface's token for all events (still accepted, wrong identity).
**How to avoid:** A3; `identity:check` flags `SUBSTRATE_TOKEN` in herdr's env files.

### Pitfall 11: Claude Code `server/discover` noise
**What goes wrong:** `/metrics` shows `claude-code /mcp 4xx` after the MCP entry is added and it looks like failures.
**How to avoid:** count 401s only from `surface=unattributed`.

### Pitfall 12: 0.3.0 plugin defaults to production
**What goes wrong:** scenario 4 against the harness silently calls `127.0.0.1:7410` if `SUBSTRATE_URL` is not in the env passed to 0.3.0's `fetchBrief`.
**How to avoid:** always pass `SUBSTRATE_URL` in the env argument.

## Code Examples

### Raw MCP call (from `chaos-smoke.ts:62-102,146-148`)
```ts
const response = await fetch(`${base}/mcp`, {
	method: "POST",
	headers: {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	},
	body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
	signal: AbortSignal.timeout(timeoutMs),
});
// body is one `data: {…}` SSE frame: take the last parseable `data:` line, then result.content[0].text as JSON
```

### Token config validator (shape)
```ts
export class ConfigError extends Error {}
export function tokenConfig(env: Record<string, string | undefined>): { tokens: Map<string, Surface>; errors: string[] } {
	const tokens = new Map<string, Surface>();
	const owner = new Map<string, string>(); // value -> variable, never printed
	const errors: string[] = [];
	for (const [key, raw] of Object.entries(env)) {
		if (!key.startsWith("SUBSTRATE_TOKEN_") || !raw) continue;
		const surface = envSuffixToSurface(key.slice("SUBSTRATE_TOKEN_".length));
		if (!(SURFACES as readonly string[]).includes(surface)) { errors.push(`${key} names no surface`); continue; }
		for (const value of raw.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean)) {
			const first = owner.get(value);
			if (first !== undefined && first !== key) { errors.push(`${first} and ${key} list the same token`); continue; }
			owner.set(value, key);
			tokens.set(value, surface);
		}
	}
	return { tokens, errors };
}
```

### Bearer resolver (shape)
```ts
const SURFACE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function resolveBearer(surface: string, env = process.env, read = firstLine): string | null {
	const direct = env.SUBSTRATE_TOKEN?.trim();
	if (direct) return direct;
	const file = env.SUBSTRATE_TOKEN_FILE?.trim();
	if (file) { const v = read(file); if (v) return v; }
	if (!SURFACE_NAME.test(surface)) return null;
	const dir = env.SUBSTRATE_TOKENS_DIR?.trim() || DEFAULT_TOKENS_DIR; // constant defined once, not in KEY=path form
	return read(join(dir, surface));
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|---|---|---|---|
| One value per `SUBSTRATE_TOKEN_<SURFACE>` | list form + boot refusal | this phase | operator, gateway, connector separately revocable |
| Clients read only `SUBSTRATE_TOKEN` | env → token file → tokens dir per surface | this phase | hooks authenticate with no value in hook config |
| Kickoff registers via model-called MCP tool when a `substrate` server is connected | deterministic `ultrathink-mcp substrate register` | this phase | every planned graph registered |
| Claude Code `SSE`/stateful MCP | Streamable HTTP, `server/discover` first, protocol `2025-11-25` | Claude Code 2.1.2xx | main's stateless server is compatible (probed) |

**Deprecated/outdated:** `SUBSTRATE_TOKEN_DESK_GATEWAY` (`.env.example:104`, `.planning/PROJECT.md:101`); September's `cursor-stop.ts` path in the live `hooks.json` until Phase 19 restores it.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|---|---|---|
| A1 | zod 4 `z.object` strips unknown keys in MCP tool args | §2 | extra SKILL fields would fail validation; mitigated by sending only schema fields |
| A2 | `~/.claude/settings.json` `env` reaches plugin hook processes | §1 | none for the recommendation (tokens dir does not depend on it) |
| A3 | The stale dispatcher makes no HTTP call while `SUBSTRATE_DISPATCH_DISABLED=1` (journal says "dispatch disabled") | §6, D20-07 | the dormant 401 count is non-zero; runbook records the observed number anyway |
| A4 | claude-ultrathink bumps versions in a separate `release(x.y.z)` commit | Project Constraints | the PR may need to include the bump; check with the maintainer convention at PR time |
| A5 | Claude Code, Grok Build and Hermes run as root on this host | §2 | a non-root host process cannot read `/etc/substrate/tokens/*` and stays unauthenticated (fail-open, then 401) |
| A6 | Phase 19's `cursor-stop.ts` stdin contract (`conversation_id`, `transcript_path`, `status`) as planned in 19-03 | §7 scenario 6 | fixture envelope must follow the merged file |

## Open Questions

1. **Exit code for boot refusal (1 vs 78 with `RestartPreventExitStatus=78`).**
   - What we know: the repo unit restarts always; the installed unit is older.
   - Recommendation: exit 78 and add `RestartPreventExitStatus=78` to the repo unit; document that the installed unit crash-loops until it is replaced.
2. **Soak window length.** Discretion; recommend 30 min covering one Muse writer tick (5 min) and at least one real Claude/Cursor prompt per live client.
3. **Should `identity:check` names-only read `~/.claude.json`?** It is under `~/.claude*` (agents may read names only). Recommend: yes, only `mcpServers.substrate` keys and the header template match, as in scenario 5.
4. **PR #22 ordering.** If #22 merges before Phase 20, re-apply A1/D20-02 on #22's `loadConfig` and add tokens-dir support to #22's inline post-commit poster.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|---|---|---|---|---|
| Bun | everything | ✓ | 1.4.0 | — |
| Docker | Phase 16 harness | ✓ | 29.6.2 | — (harness disk gate applies) |
| Claude Code CLI | `mcp-register --substrate`, scenario 5 | ✓ | 2.1.278 | — |
| git, jq | post-commit hook | ✓ | git 2.43.0; jq present | hook writes `[]` files without jq |
| openssl | runbook value generation | ✓ | 3.0.13 | `head -c 32 /dev/urandom \| xxd -p -c 64` |
| systemd-analyze | unit lint (if the repo unit changes) | ✓ | — | — |
| herdr, muse, grok, hermes | live clients | ✓ (`~/.local/bin`, `/usr/bin/grok`) | — | — |
| Cursor CLI | scenario 6 production | ✗ (no `cursor` binary on host) | — | operator's real Cursor session (remote) |
| Phases 16-19 on `main` | harness, emit.ts, cursor-stop, `--print-desired` | ✗ (sibling branches) | — | none: Phase 20 executes from a main that holds them |
| `/etc/substrate/tokens/` | D20-04 default | ✗ | — | operator creates it (runbook) |

**Missing dependencies with no fallback:** Phases 16-19 merged to `main` (execution precondition, as CONTEXT states).
**Missing dependencies with fallback:** Cursor CLI (operator session); tokens dir (created in the window).

## Validation Architecture

### Test Framework
| Property | Value |
|---|---|
| Framework | `bun test` (Bun 1.4.0), `bun:test` API; claude-ultrathink `bun test` + `bun run check` |
| Config file | none (`tsconfig.json` includes `packages/**/*.ts`, `scripts/**/*.ts`) |
| Quick run command | `bun test <file>` per touched file |
| Full suite command | `bun test && bunx tsc --noEmit` (agent-substrate); `bun test && bun run check` (claude-ultrathink) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| FOUND-04 | list form resolves each entry; duplicate across surfaces and unknown suffix raise `ConfigError` naming variables only | unit | `bun test packages/mcp-server/src/authority.test.ts` | ✅ (extend) |
| FOUND-04 | a second list entry authenticates over HTTP; unknown 401 | integration (in-process server) | `bun test packages/mcp-server/src/server.authority.test.ts` | ✅ (extend) |
| FOUND-04 | spawned boot with duplicate env exits non-zero, names both variables, value absent | integration (subprocess) | `bun test packages/mcp-server/src/boot-refusal.test.ts` | ❌ W0 |
| FOUND-04 | `resolveBearer` order, surface validation, fail-open, never logs | unit | `bun test packages/cli/src/token.test.ts` | ❌ W0 |
| FOUND-04 | CLI sends the tokens-dir bearer for `--surface cursor`; env wins; none when absent | integration (spawn CLI vs `Bun.serve` stub) | `bun test packages/cli/src/cli-auth.test.ts` | ❌ W0 |
| FOUND-04 | `postEvent` default token is the event surface's file | unit | `bun test packages/collectors/src/emit.test.ts` | ✅ after Phase 19 (extend) |
| FOUND-04 | parity-check sends bearer from `SUBSTRATE_TOKEN_FILE`; 401 reads "auth on, token missing" | unit | `bun test scripts/parity-check.test.ts` | ✅ after Phase 16 (extend) |
| FOUND-04 | names-only parser never retains/prints values; continuation lines; manifest ↔ runbook ↔ `.env.example` lock | unit | `bun test scripts/identity-check.test.ts` | ❌ W0 |
| FOUND-04 | no tracked token literal (incl. new docs) | lock | `bun test packages/mcp-server/src/store-lock.test.ts` | ✅ (currently FAILS on 20-CONTEXT.md, A0) |
| UAT-02 | target classification (`PRODUCTION_PORTS`, loopback), `--live` guards, run tags, report rendering, scenario expectation functions | unit | `bun test scripts/uat-phase0.test.ts` | ❌ W0 |
| UAT-01 | scenarios 1, 3, 4, 6, 7, 8 pass on the harness | live-isolated | `bun run rehearsal up --name p20 && (set -a; . "$XDG_RUNTIME_DIR/substrate-rehearsal/p20/consumer.env"; bun run uat:phase0 --scenarios 1,3,4,6,7,8 --report <path>); bun run rehearsal down --name p20` | ❌ proof step |
| UAT-01 | scenarios 1, 2, 3, 5, 6 on production | live (operator) | `bun run uat:phase0 --scenarios 1,2,3,5,6 --live <ref> …` | ❌ operator step |
| UAT-03 | `buildRegisterArgs` mapping, prime-agent omission, fail-open, SSE parse; `substrate register`/`headers` CLI; `track complete` calls register | unit | `bun test src/substrate/register.test.ts src/mcp/cli.test.ts` (claude-ultrathink) | ❌ W0 / ✅ extend |
| UAT-03 | `fetchBrief`/`emitEvent` tokens-dir bearer per surface | unit | `bun test src/substrate/brief.test.ts` (claude-ultrathink) | ✅ extend |
| UAT-03 | `mcp-register.ts --substrate` plans `claude mcp add-json --scope user substrate …` with the header template and helper path; `--remove` only ours; `--dry-run` writes nothing | unit (fake `Run`) | `bun test scripts/mcp-register.test.ts` (claude-ultrathink) | ✅ extend |
| UAT-04 | scenario 6 harness path (hooks with envelopes, scratch post-commit) | live-isolated | part of the harness `uat:phase0` run | ❌ proof step |

### Sampling Rate
- **Per task commit:** the touched file's `bun test <file>` plus `bun test packages/mcp-server/src/store-lock.test.ts` for any task that writes docs.
- **Per wave merge:** `bun test && bunx tsc --noEmit`; claude-ultrathink `bun test && bun run check`.
- **Phase gate:** full suites green against the baseline, `bun run check:phase-close`, `redact-lock.test.ts`, `store-lock.test.ts`, `bun run identity:check` (names-only), harness `uat:phase0` for 1,3,4,6,7,8, before `/gsd:verify-work`.

### Wave 0 Gaps
- [ ] Fix `20-CONTEXT.md:62` spelling (A0) so `store-lock.test.ts` is green before any task.
- [ ] `packages/mcp-server/src/boot-refusal.test.ts` — FOUND-04 boot refusal.
- [ ] `packages/cli/src/token.test.ts`, `packages/cli/src/cli-auth.test.ts` — resolver and CLI bearer.
- [ ] `scripts/identity-check.test.ts` — parser, check, locks.
- [ ] `scripts/uat-phase0.test.ts` — pure parts.
- [ ] claude-ultrathink `src/substrate/register.test.ts`.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---|---|---|
| V2 Authentication | yes | bearer per surface; list form; boot refusal on ambiguous mapping; operator token separate (D20-03) |
| V3 Session Management | no | stateless MCP transport |
| V4 Access Control | yes | `isOperator` (operator ⊆ surface tokens, never swarm); `attributedSurface` swarm/`substrate` binding unchanged |
| V5 Input Validation | yes | `--surface` validated before path join; manifest validated against `SURFACES`; UAT target URL parsed and classified |
| V6 Cryptography | yes | values from `openssl rand -hex 32`; sha256 only for in-memory equality; never print hashes |
| V7 Error Handling and Logging | yes | `ConfigError` and every report name variables, never values; UAT reports hold no brief bodies or hostnames |
| V14 Configuration | yes | 0600 files, 0700 tokens dir, root-owned; `store-lock` scan on all tracked files |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---|---|---|
| Token value in a tracked file, report or log | Information disclosure | `store-lock` `TOKEN_LITERAL`; reports carry booleans/counts; resolver and helper never log; `claude mcp add` echoes `[REDACTED]` |
| Same value under two surfaces re-attributes a caller | Spoofing | boot refusal (D20-02) |
| Non-surface suffix (`DESK_GATEWAY`, `FILE`) creates a phantom identity | Spoofing | boot refusal (A1) |
| `--surface ../../x` reads an arbitrary file's first line as a bearer | Information disclosure | surface regex before `join` |
| Agent sets `SUBSTRATE_URL` to a remote host so a hook ships its token there | Information disclosure | accepted on this host: the processes are root and can read the files anyway; document; scope tokens to surfaces so one leak is one surface |
| Names-only parser leaks a value fragment via a continuation line or an arbitrary "name" | Information disclosure | skip continuation lines; print only expected names and unexpected `SUBSTRATE_TOKEN_*` names |
| UAT write against production by mistake | Tampering | `PRODUCTION_PORTS`/non-loopback ⇒ read-only unless `--live <ref>`; run-tagged writes; scenario 7 never touches the target |
| Lockout at switch-on (stranded client) | Denial of service | client-first ordering (D20-09), `identity:check --values` incl. validator, rollback by commenting lines; `/metrics` unattributed 4xx watch |
| Plugin-supplied MCP entry for every user | Elevation / surprise | opt-in user-scope entry only (A5) |

## Sources

### Primary (HIGH confidence)
- agent-substrate worktree files read this session: `packages/mcp-server/src/config.ts` (1-333), `server.ts` (138-538), `mcp.ts` (73-178, 259-490, 721-748), `index.ts`, `types.ts` (30-70), `brief.ts` (115-216), `backfill-run.ts`, `backfill.ts` (27-66), `service.ts` (1452-1488, 438-456), `index-store.ts` (grep), `store-lock.test.ts` (1-123, 249-362), `authority.test.ts` (grep), `packages/cli/src/index.ts` (1-143, 170-311, 360-416), `lessons.ts` (780-825), `packages/collectors/src/git/post-commit`, `install-git-hook.ts`, `packages/projector/src/cursor.ts` (grep), `packages/observability/src/instruments.ts` (14-28, 210-235), `scripts/chaos-smoke.ts`, `.env.example` (grep), `infra/vps/substrate-mcp.service`, `package.json`, `tsconfig.json`, `AGENTS.md`.
- Phase 16 worktree: `scripts/rehearsal.ts` (grep), `scripts/parity-check.ts` (grep), `packages/mcp-server/src/rehearsal-env.ts` (180-220), `docs/rehearsal.md:120-123`. Phase 17 plans/summary (grep). Phase 19 plans 19-01, 19-03, 19-04, 19-05 (grep), COVERAGE.md.
- claude-ultrathink `origin/main` `ed3243e` via `git --no-optional-locks show`: `skills/ultrathink-kickoff/SKILL.md`, `src/mcp/cli.ts`, `src/substrate/brief.ts`, `src/claude/hook.ts` (320-350, 455-480, 640-720), `hooks/uplift.ts`, `src/host/{detect,types,plan}.ts`, `src/claude/output.ts`, `scripts/mcp-register.ts`, `package.json`, `.claude-plugin/plugin.json`, `CHANGELOG.md`, `CONTRIBUTING.md`, `hosts/hermes/bridge.py` (grep); installed 0.3.0 `src/substrate/brief.ts`, `src/claude/output.ts`; `installed_plugins.json`.
- Claude Code docs: https://code.claude.com/docs/en/mcp (env expansion, credential variables, headersHelper, plugin servers and tool names, scopes).
- Live probes (scratch, dummy values, cleaned up): Claude Code 2.1.278 against a header-recording stub and against a scratch main `substrate-mcp` on :18998; raw `curl` MCP calls; `/metrics` read; regex runs; `store-lock.test.ts -t "no tracked file assigns"`.
- `gh pr diff 22` / `gh pr view 22` (draft, open).

### Secondary (MEDIUM confidence)
- ClientInventory scout report (`agent://Phase20DiscussPlan.ClientInventory/report`) for unit and env-file names on the host.

### Tertiary (LOW confidence)
- None used for decisions.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; versions probed.
- Architecture: HIGH — every insertion point read; Claude Code mechanism probed end to end.
- Pitfalls: HIGH — the store-lock and brief-composition pitfalls reproduced; dormant 401 count is [ASSUMED] until the window.

**Research date:** 2026-10-08
**Valid until:** 2026-11-07 (Claude Code MCP behaviour changes often; re-probe `claude --version` and the helper behaviour if the CLI moves past 2.1.278)
