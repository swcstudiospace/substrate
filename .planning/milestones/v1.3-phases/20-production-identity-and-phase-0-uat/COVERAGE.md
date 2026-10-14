# API Coverage — Phase 20 (Production identity and Phase 0 UAT)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.

Phase 20 integrates three external capabilities: Claude Code's MCP
configuration (CLI 2.1.278, live-probed in a temp `CLAUDE_CONFIG_DIR` with
dummy values during research), claude-ultrathink's kickoff and substrate
client (`origin/main` `ed3243e`, read with `git show`), and a read-only Notion
query for scenario 3. `POST /brief`, `POST /events`, `POST /events/query`,
`POST /verify`, `POST /handoff`, `GET /healthz`, `GET /metrics` and the MCP
tools on `/mcp` are the project's own loopback HTTP, not an external API, so
they carry no matrix (their use is specified in `20-RESEARCH.md` §3, §6, §7).
Linear is touched only indirectly, by the operator's real kickoff in scenario 5.

## Claude Code MCP configuration (CLI 2.1.278)

| capability | decision | reason |
|---|---|---|
| `claude mcp add-json --scope user <name> <json>` | INTEGRATE | writes the opt-in user-scope `substrate` entry from `scripts/mcp-register.ts --substrate` (D20-13, amendment A5); probed: writes top-level `mcpServers.substrate` in `<config dir>/.claude.json` |
| `claude mcp add --transport http --scope user … --header` | OPT-OUT | cannot set `headersHelper`; `add-json` covers the same entry in one call |
| `claude mcp remove --scope user substrate` | INTEGRATE | `mcp-register.ts --substrate --remove`, only when the entry is ours (helper path suffix) |
| `claude mcp get substrate` | INTEGRATE | read-only status for scenario 5 and the runbook (`✔ Connected` / `✘ Failed to connect … HTTP 401`); prints the header template, never a value (probed) |
| `headers` with `${SUBSTRATE_TOKEN:-}` | INTEGRATE | names the token variable (UAT-03); probed to expand from the process env at user scope; `SUBSTRATE_TOKEN` is not in the "reads as empty" credential set |
| `headersHelper` (user scope) | INTEGRATE | `<clone>/bin/ultrathink-mcp substrate headers` supplies the tokens-dir value; probed: runs with full env, overrides the static header, `{}` leaves it |
| `type: "http"` Streamable HTTP transport | INTEGRATE | main's stateless `/mcp` accepted Claude Code's `server/discover` + `initialize` (protocol `2025-11-25`) and connected (probed) |
| plugin-shipped `.mcp.json` / `plugin.json` `mcpServers` | OPT-OUT | registers as `plugin:ultrathink:substrate` with tools `mcp__plugin_ultrathink_substrate__*`, starts for every plugin user, cannot read the ultrathink config URL, and plugin helpers run with `*TOKEN*` variables stripped (docs) |
| project-scope `.mcp.json` | OPT-OUT | per-repo and committed; the server must be available in every project; the swarm workspace keeps its own project entry (`docs/swarm-workspace.md:21`) |
| `~/.claude/settings.json` `env` for `SUBSTRATE_TOKEN` | OPT-OUT | works (probed) but writes a token value into agent config, against D20-04 |
| OAuth (`/mcp` authenticate, `oauth` block) | OPT-OUT | substrate uses static bearer tokens; an `Authorization` header disables OAuth fallback |
| `alwaysLoad`, `timeout`, discovery cache knobs | OPT-OUT | defaults are fine for 19 small tools; nothing in the phase depends on load timing |
| WebSocket `type: "ws"` | OPT-OUT | the server speaks Streamable HTTP only |

## claude-ultrathink (`origin/main` `ed3243e`)

| capability | decision | reason |
|---|---|---|
| `src/substrate/brief.ts` `fetchBrief` / `emitEvent` bearer | INTEGRATE | gains D20-04 resolution per host surface (`SUBSTRATE_TOKEN` → `SUBSTRATE_TOKEN_FILE` → tokens dir) |
| `ultrathink-mcp track complete --state` | INTEGRATE | calls the new `registerGraph` after it writes tracking refs (D20-13) |
| new `ultrathink-mcp substrate register --state` | INTEGRATE | deterministic registration that SKILL step 3 always runs, because step 1 skips `track complete` when tracking is already complete (amendment A4) |
| new `ultrathink-mcp substrate headers` | INTEGRATE | the `headersHelper` for the Claude Code entry |
| `scripts/mcp-register.ts` | INTEGRATE | `--substrate` flag, Claude host only, reuses its `Run` seam, backups, `--dry-run`, `--remove` |
| `skills/ultrathink-kickoff/SKILL.md` step 3 | INTEGRATE | runs the register command; the MCP-tool path stays the fallback |
| `graph_register` fields `nodes[].linear_url`, `steps[].linear_identifier`, `steps[].linear_url` named in SKILL step 3 | OPT-OUT | not in the server's `graph_register` schema (`mcp.ts:442-486`); only schema fields are sent |
| `graph_register` `edges` from `graph.nodes[].dependsOn` | OPT-OUT | not in SKILL step 3's contract; Linear relation mirroring is Phase 23's |
| `graph_claim`, `pr` / `session.end` emits from kickoff | OPT-OUT | out of Phase 20 scope (FEATURES cross-repo row; later phases) |
| `surface` for host `prime-agent` | OPT-OUT | not a substrate surface; omitted so the token's surface applies (zod would refuse it) |
| `runPromptSubmit` for UAT scenario 4 | OPT-OUT | can start Jev (OpenRouter) and teach lookups that spend quota; scenario 4 imports the installed `fetchBrief` and `formatPromptContext` instead |
| installed plugin `fetchBrief` + `formatPromptContext` (0.3.0 and ≥1.4.0) | INTEGRATE | scenario 4, no model call; both versions export both |
| Grok Build, Hermes, Muse, Omp MCP entries for `substrate` | OPT-OUT | the register command needs no MCP entry; UAT-03 names Claude Code only |

## Notion (scenario 3, operator-run, read-only)

| capability | decision | reason |
|---|---|---|
| `query-data-sources` SQL on the Agent Task Graph data source (default `NOTION_TASK_GRAPH_DS`) selecting the `NotionRow` columns | INTEGRATE | the operator-approved read-only export that `backfill-run.ts` and the production `graph_get` checks consume (D20-16 #3) |
| any Notion write (`create-pages`, `update-page`) | OPT-OUT | scenario 3 never writes Notion; the only Notion writes in the phase are the operator's real kickoff in scenario 5 |
| a Notion client inside agent-substrate | OPT-OUT | main has none and the phase adds none; the export is a file input |
