# Swarm workspaces: the `substrate` MCP entry and the `substrate.env` split (S4)

What the substrate provides so that a fresh Agent Swarm workspace is wired to `substrate-mcp` by its install alone
([ADR 0001](adr/0001-agent-swarm-as-sdlc-mesh-on-substrate.md), phase S4, SPE-5055; INST-01..05).

## The projector

`packages/projector/src/swarm-workspace.ts` is a library and a Bun CLI:

```bash
bun packages/projector/src/swarm-workspace.ts --workspace <ws> [--runtimes claude,grok,omp] --plan    # print the additions
bun packages/projector/src/swarm-workspace.ts --workspace <ws> --check                               # exit 1 if any are pending
bun packages/projector/src/swarm-workspace.ts --workspace <ws> --apply                               # write them
bun packages/projector/src/swarm-workspace.ts --spec                                                 # the projection as JSON
```

It writes one entry per runtime, in the project file that runtime reads:

| Runtime | File | Entry |
|---|---|---|
| Claude Code | `<ws>/.mcp.json` | `mcpServers.substrate = {"type": "http", "url": "${SUBSTRATE_URL}/mcp", "headers": {"Authorization": "Bearer ${SUBSTRATE_TOKEN}"}}` |
| omp | `<ws>/.mcp.json` | the same entry: omp reads Claude's file |
| Grok Build | `<ws>/.grok/config.toml` | `[mcp_servers.substrate]` with the same `url` and `headers` |

All three expand `${VAR}` in `url` and `headers` from the process's own environment when they load the file, so the
entry names the token and never holds it. There is no `:-default` on the URL: a swarm with `SUBSTRATE_URL` unset is off,
and a default would point its agents at a server anyway.

The rules are the ones Phase 0 set for Cursor's `hooks.json`, adapted to servers keyed by name:

- **Ownership is the name `substrate`.** It is added where it is missing, last, and every other server and key keeps its
  place and value. JSON is re-serialised with two-space indentation; TOML is appended to as text, so the original bytes
  stay a prefix of the file.
- **Idempotent.** An identical `substrate` entry, in any key order, is left alone; a second run writes nothing.
- **Never replace.** A `substrate` entry that differs is refused rather than overwritten: the projector cannot tell an
  older projection from an operator's edit. Remove it and re-run.
- **Refuse what it cannot read.** Unparsable JSON or TOML, a present `mcpServers`/`mcp_servers` that is not an object
  (`null` included; a missing key is the only empty map), or an inline `mcp_servers = { … }` table that an appended
  `[mcp_servers.substrate]` cannot extend is refused, never reset. So is a symlink anywhere between the workspace and
  the file, a dangling one included, and any non-regular file such as a named pipe. Planning uses the same no-follow,
  non-blocking read as apply, so a pipe cannot stall it.
- **Staged, recoverable apply.** Every config and backup is staged before any destination is published. `--apply`
  refuses if a file changed since planning, rechecks directory identities and destination snapshots immediately before
  commit, and rolls back earlier publications if a later one fails. `rename` and `link` change ctime before the
  publication can be reread. If that one read fails, rollback still treats the staged inode, mode and bytes as its own
  publication; a later external replacement is still preserved. Rollback restores original bytes and permissions,
  including an older `<file>.substrate-backup`. A detected intervening external edit is reported explicitly as
  **rollback incomplete**, not as a successful rollback.
- **Safe filesystem publication.** Existing configs retain their permissions; a backup receives the original config's
  bytes and permissions. Staging uses unpredictable, exclusive, no-follow files and destination directories pinned by
  file descriptors, so planted backup/temp symlinks cannot redirect writes. Config and backup symlinks are refused,
  including links introduced after planning. A descriptor filesystem (`/proc/self/fd` or `/dev/fd`) is required;
  unavailable support is refused rather than replaced with unsafe path writes. A directory this apply creates is
  recorded before its descriptor is opened, so a failed open still removes that empty directory. Cleanup removes only
  owned staging files and owned empty directories, never unrelated files or links. Operator permissions are not repaired.
- **Atomic per file, not crash-atomic across files.** Readers see complete individual files. A running apply can undo
  its own failed commits, but a process crash or machine loss is not a multi-file transaction; concurrent writers should
  still be excluded operationally. Detected external edits are preserved and require operator reconciliation.
- A runtime with no entry here is refused: an executing swarm agent must reach `substrate-mcp`, because a node is leased
  over MCP only (there is no REST `graph_claim`; ADR 0001 S4 criterion 6).

Exit codes: 0 done or nothing to do, 1 `--check` found pending additions, 2 refused or bad usage.

agent-swarm's installer (`build_agents.py --install-workspace`) applies the same projection with the same rules from a
vendored copy of `--spec` (`swarm/substrate_mcp.json`): agent-swarm is public and installs without this private checkout.
When the entry changes here, re-vendor it there; the PROOF-03 script diffs the two.

What the projector's test asserts, over a temp workspace (`swarm-workspace.test.ts`): no generated file registers Greptime
as an MCP server (store-lock rule 2, checked where the configs land), no file under the workspace holds a token value, and
a second run changes nothing and keeps every existing entry.

## The `substrate.env` split

The same secret has two names, at opposite ends, and they are owned by different people:

| Variable | Read by | Owner | Lives in |
|---|---|---|---|
| `SUBSTRATE_TOKEN_<SURFACE>`, one per surface, e.g. `SUBSTRATE_TOKEN_SWARM_A05_BE` | `substrate-mcp`, to map a bearer to a surface (`config.ts`) | the substrate operator | `/etc/substrate/substrate.env`, the server unit's `EnvironmentFile=`, root-owned, 0600 |
| `SUBSTRATE_OPERATOR_TOKENS` | `substrate-mcp`, for `force` | the substrate operator | the same file. No swarm token is ever listed (boot warns, `force` is refused) |
| `SUBSTRATE_HOST`, `SUBSTRATE_PORT`, `SUBSTRATE_PG_URL`, `GREPTIME_*`, `SUBSTRATE_AUDIT_PATH`, … | `substrate-mcp` | the substrate operator | the same file |
| `SUBSTRATE_TOKEN`, exactly one: the agent's own | the agent's MCP client (the expanded `Authorization` header), the `substrate` CLI, the collectors, the swarm's HTTP client | whoever runs the swarm | that agent's env file, `${XDG_CONFIG_HOME:-~/.config}/agent-swarm/agents/<workspace key>/<slug>.env`, 0600, outside the workspace and every git checkout, holding that one line |
| `SUBSTRATE_URL` | every client | whoever runs the swarm | the swarm runner's environment, inherited by each agent session |

So A05's file says `SUBSTRATE_TOKEN=<value>`, and the server holds the same value as `SUBSTRATE_TOKEN_SWARM_A05_BE`. An
agent given only the server-side name sends no bearer at all, and once any token is configured the server answers that
with 401. The `/brief` and `events.emit` paths fail open, so such an agent looks almost healthy: it runs unbriefed and
untraced. That is why the swarm installer refuses to finish without every agent's token, and why PROOF-03 asserts a
granted claim and a non-empty brief rather than a clean exit.

Swarm variables stay single-valued: one agent, one token, one entry. Only the non-swarm surfaces that host several clients at different trust — `claude-code` for the operator versus the hooks, `grok-bot` for the gateway versus the connector — hold lists.

The swarm installer reads `SUBSTRATE_TOKEN_<SURFACE>` from its own environment at install time (the operator exports the
values the server holds) and never reads `/etc/substrate/substrate.env`. An agent never reads it either.

Generate each token as 32 random bytes, e.g. `openssl rand -hex 32`. The tracked-file secret scan in
`store-lock.test.ts` flags any `SUBSTRATE_TOKEN*` assigned a value of 16 or more token characters, under either name, in
any tracked file, comments included.

## The shared-account limit

0600 separates OS accounts, not processes of one account. The swarm runner starts every agent as the same user, so each
agent could read its siblings' env files and authenticate as them, and possession of a token is the identity: nothing
server-side can tell the difference. What S1's identity work buys is real and bounded. A caller cannot **name** another
surface over its own token, and accidental misattribution and shared-holder lease renewal stop. The 30 swarm identities
are attributable, not unforgeable, among agents sharing an account. Making them a security boundary needs a separate OS
principal per agent, or a broker that hands each process only its own short-lived credential; neither is part of S4.
