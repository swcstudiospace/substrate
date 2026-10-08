# Phase 14: Workspace install - Context

**Gathered:** 2026-10-07
**Status:** Executing
**Mode:** Auto-accepted. Decisions come from ADR 0001 S4 criteria 1-9, REQUIREMENTS INST-01..05 and PROOF-03, the S4 runtime research (`v12-s4-runtime`), Phase 12's lease bridge, and probes of the installed CLIs (claude 2.1.278, grok 1.0.46, omp 18.8.0).

<domain>
## Phase Boundary

S4 (Linear SPE-5055), in two repos:

- **agent-substrate**, branch `feat/v1.2-p14-projector` from Phase 11's head: `packages/projector/src/swarm-workspace.ts` and its test, the `SUBSTRATE_TOKEN*` tracked-file secret scan in `store-lock.test.ts`, and `docs/swarm-workspace.md`.
- **agent-swarm**, branch `feat/v1.2-p14-workspace-install` from Phase 12's head:
  - `build_agents.py --install-workspace` with a new `scripts/_install_substrate.py`;
  - `swarm/workspace.py` and the vendored `swarm/substrate_mcp.json`;
  - `swarm_run.headless_command`;
  - `substrate_lease._call`;
  - docs.

Out of scope: signed handoffs (Phase 13), REST lease routes, and process isolation between agents of one account, which is documented rather than fixed.

</domain>

<decisions>
## Implementation Decisions

### Locked (2026-10-07)
- Every generated config names `${SUBSTRATE_TOKEN}`, never a value. Each agent's token is in a 0600 env file outside the workspace and every checkout.
- The installer takes tokens from `SUBSTRATE_TOKEN_<SURFACE>` in its own environment and never reads `/etc/substrate/substrate.env`. A missing token prints what the operator must create and exits non-zero.
- The runner gives each child only its own `SUBSTRATE_TOKEN`. The lease token lookup (Phase 12's single `_call`) reads the same env file.

### Claude's Discretion

**Projector shape.**
- `packages/projector/src/swarm-workspace.ts` is both a library (`plan`, `apply`, `describe`, `spec`) and a Bun CLI: `--workspace <ws> [--runtimes …] --plan|--check|--apply`, plus `--spec`.
- One entry per runtime, in the file that runtime reads:
  - claude and omp share `<ws>/.mcp.json` (JSON `mcpServers.substrate`, `type: http`);
  - grok reads `<ws>/.grok/config.toml` (`[mcp_servers.substrate]`).
- The entry is `url = ${SUBSTRATE_URL}/mcp` plus `headers.Authorization = Bearer ${SUBSTRATE_TOKEN}`. There is no `:-default` on the URL: unset `SUBSTRATE_URL` means off, and a default would quietly point agents at the production server.
- Ownership is the server name `substrate`:
  - added where missing, last, with every other entry and key kept;
  - an identical entry (in any key order) is left as it is, which makes the projection idempotent;
  - a `substrate` entry that differs is **refused, not replaced**, because the projector cannot tell an older projection from an operator's edit.
- Unparsable JSON or TOML is refused, as are an inline `mcp_servers` table, an `mcpServers` that is not an object, and a symlink anywhere on the path (dangling ones included).
- TOML is appended to as text and re-parsed. The result must hold exactly our entry and leave every other key unchanged.
- The whole plan is all-or-nothing. A file that changes is first copied to `<file>.substrate-backup`. Writes go to a temp file and are renamed into place.
- Exit codes: 0 done, 1 `--check` has pending changes, 2 refused.

**How the Python installer uses it: reimplemented in Python from one shared spec, not `bun <path>`.**
- agent-swarm is a PUBLIC repository and agent-substrate is PRIVATE (checked with `gh repo view`). The public installer cannot depend on a private checkout at install time, and the public CI cannot check one out.
- So the projector's `--spec` output is vendored as `swarm/substrate_mcp.json`, and `_install_substrate.py` applies it under the same rules.
- The PROOF-03 script checks that the two implementations stay in step:
  - the vendored spec equals `--spec`;
  - `swarm-workspace.ts --check` finds nothing to add to a workspace the Python installer produced.

**Env file.**
- Path: `${XDG_CONFIG_HOME:-~/.config}/agent-swarm/agents/<sha256(realpath ws)[:16]>/<slug>.env`. The directory is 0700 and each file is 0600, holding exactly `SUBSTRATE_TOKEN=<token>`.
- It is keyed per workspace, so a second workspace, possibly pointed at another substrate, never overwrites the first workspace's tokens.
- It is written through `O_EXCL|O_NOFOLLOW` to a temp file and then renamed.
- The reader (runner and lease) refuses a file that is not a regular file, belongs to another uid, has any group or other permission bits, or holds anything but that one line.
- The installer refuses an env directory inside the workspace, inside the swarm checkout or inside any git checkout. The check uses the real path, so a dotfiles repo behind `~/.config` is caught.

**Token sourcing.**
- `SUBSTRATE_TOKEN_<SURFACE>` (e.g. `SUBSTRATE_TOKEN_SWARM_A05_BE`) in the installer's environment.
- With that variable unset, an existing valid file is kept, so an operator can create the files by hand and re-run.
- With neither present, preflight (before generation or any write) prints each missing variable and the file it would go to, the 0600 one-line format and the `--no-substrate` escape, then exits 2.
- A dry run prints the plan and `MISSING` lines, then exits 2.
- Env files are written before the workspace configs, so a write failure leaves the workspace untouched.

**Runner (`headless_command`; `repo` is the installed workspace).**
- Child environment: drop every `SUBSTRATE_TOKEN*` and `SUBSTRATE_OPERATOR_TOKENS`, then set `SUBSTRATE_TOKEN` from the agent's env file. Without a usable file the child gets no token, never the runner's.
- claude:
  - add `--mcp-config <ws>/.mcp.json --strict-mcp-config`, because the cwd is the swarm checkout and a workspace `.mcp.json` is never read there;
  - add `mcp__substrate` to `--allowedTools`;
  - the generated `.claude/agents/*.md` `tools:` gain `mcp__substrate`. A probe showed that an agent's `tools:` hides MCP tools it does not name, and that `mcp__substrate` admits all of the server's tools.
- grok: add `--trust`. It is the documented headless flag. A workspace that is its own git checkout is not covered by a parent folder's trust, and `--yolo` already approves every tool call. The cost is that the grant persists in `~/.grok/trusted_folders.toml`.
- omp: no change. It reads `<cwd>/.mcp.json`, and `--tools` sets `toolNames`, not `restrictToolNames`. An RPC `get_state` probe showed `xd://mcp__substrate_*` devices mounted under the runner's allowlist.
- These flags are added only when the workspace has the entry (an install with `--no-substrate` wires nothing).
- `--dry-run` adds the stripped token variable names to its `env -u` list, and prints a second line naming the env file the token comes from. It never prints a value.

**Lease lookup.**
- `_call(tool, args, agent_id, workspace, env)` reads the agent's file. `Lease` carries `workspace`; `claim_node(..., workspace=)`; `LeaseBridge(root=repo)`; `settle_mirrored(..., workspace=ctx.root)`.
- A missing or bad file is `refused`, naming the file, before any request is sent. No runner variable stands in for it.

**Executing runtimes.**
- `--runtimes` (default `claude,grok,omp`) is checked against the spec's runtimes. Any other runtime, e.g. `trae`, is refused as an executing agent (exit 2): a node is leased over MCP only.
- Every existing refusal is kept: inside the checkout, `$HOME`, `~/.omp`, symlinks.
- `--no-substrate` installs the rest with the integration off.

**Secret scan.**
- `store-lock.test.ts` gets `TOKEN_LITERAL`: any `SUBSTRATE_TOKEN*` key, quoted or not, with `:` or `=`, assigned a value of 16 or more token characters. Comments are not exempt.
- Values that read the environment (`process.env.…` and the like) are excluded. That makes the 16-character threshold what separates real tokens (the docs say 32 random bytes) from the `tok-…` fixtures and placeholders.
- The projector glob in "no Greptime MCP wiring" excludes `*.test.ts`. The projector's own test has to name Greptime in order to assert its absence where the configs land, as ADR criterion 2 requires.

**Docs.**
- agent-substrate `docs/swarm-workspace.md`: the projector, the server/agent variable split with an owner for each, token generation, and the shared-account 0600 limit. It is linked from `swarm-correlation.md`.
- agent-swarm `docs/substrate-workspace.md`, plus updates to `substrate-tee.md`, `substrate-leases.md`, README, AGENTS.md and CLAUDE.md.
- **One token lookup for everything (decided after the first proof run).** `swarm/workspace.py` `credential(agent, workspace, env)` serves the lease calls, the child sessions and the event tee alike. It reads the agent's env file, else its `SUBSTRATE_TOKEN_<SURFACE>`, else nothing, and it never falls back to the runner's `SUBSTRATE_TOKEN`. The tee therefore keeps attributing rows to the right agent in an S4 install whose runner holds only A01's token. A row with no token stays local with one stderr note, fail-open as the v1.1 tee was [lesson mem_43bc8ddeb0244fc69758a24005e42f75].

</decisions>

<code_context>
## Existing Code Insights

- Before this phase the installer wrote no MCP config. `merge_claude_settings` silently resets invalid JSON; that is left as it is (not S4's file).
- `cursor.ts` tags its hooks with `substrate-managed`. MCP servers are keyed maps, so for them ownership is the name.
- Claude's `--bare` mode with no API key emits the `init` event, which lists `mcp_servers` status and the agent's tools, and then fails authentication at $0. That makes Claude's MCP visibility provable without spending model tokens. `--bare` skips project agent discovery, so the proof passes the generated agent's tools through `--agents`.
- `grok mcp doctor substrate --json` reports `folder untrusted` without trust, and `healthy` with "19 tools discovered" under `--trust`.

</code_context>

## Prior Lessons

Recalled at discuss time with `substrate lessons recall` (Phase 15). The lessons come from the v1.1 SUMMARYs' key decisions, added to the lessons bank of a smoke substrate (real Postgres and GreptimeDB; the production substrate is never touched). Query: "swarm surface token refusal fail-open timeout".

- `mem_10fb3e5a8ac54a05b4542c46293d1b34` lesson:v1.1/10-swarm-orchestrate/post-graph-single-agent-swarm-surface: No POST /graph, no single agent-swarm surface, no new event kinds (ADR 0001). [tags: s1, event-tee, graph-id, agent-swarm, fail-open]
- `mem_43bc8ddeb0244fc69758a24005e42f75` lesson:v1.1/10-swarm-orchestrate/stdlib-client-1-5-s-timeout: Stdlib client, 1.5 s timeout, outage back-off, fail-open. [tags: s1, event-tee, graph-id, agent-swarm, fail-open]
- `mem_82e6612a9d054f7c8e7090a0105fc2c0` lesson:v1.1/10-swarm-orchestrate/graph-id-order-graph-id-substrate: Graph ID order --graph-id > SUBSTRATE_GRAPH_ID > brief > mint; always adopt the server's binding.
- `mem_b219a575c7d144fca98a67458f10cb58` lesson:v1.1/10-swarm-orchestrate/swarm-type-rides-payload-event-kinds: swarm_type rides in the payload; EVENT_KINDS not widened.

<deferred>
## Deferred Ideas

- (Done in this phase, see Claude's Discretion: the tee reads the env files through the shared lookup.)
- Which `coord_handoff` caller Phase 13 uses: agents see every substrate tool (`mcp__substrate`), and the server is the enforcement point.
- Per-agent OS principals or a credential broker, to make the 15 identities a boundary.
- Updating a differing `substrate` entry in place, once the projection changes shape.

</deferred>
