---
gsd_state_version: "1.0"
milestone: v1.0
milestone_name: "Agent Substrate — four planes (runtime, memory, skills, ledger) keyed by Graph ID"
current_phase: 0
current_phase_name: "Brief"
status: awaiting-credentials
last_updated: 2026-09-23
progress:
  total_phases: 7
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 12
---

# State

## Current

Phase 0 (Brief) is **built and proven against a local stack**; it is not yet
pointed at the real stores.

Done:
- `substrate-mcp` on `127.0.0.1:7410` — MCP at `/mcp` plus `POST /brief`,
  `/events`, `/verify` and `GET /healthz`. Tools: `memory_brief`,
  `memory_write`, `memory_search`, `events_emit`, `graph_get`,
  `graph_register`, `graph_claim`, `graph_release`, `graph_complete`.
  (Underscores, not the doc's dots — Anthropic tool names must match
  `^[a-zA-Z0-9_-]{1,64}$`.)
- Postgres index + Greptime `agent_events` schemas, with the hash chain
  computed on ingest so Phase 6 has a correct chain from row one.
- Redaction on the write path, ported from the connector's `redactor.py`.
- `fetchBrief` in `claude-ultrathink` on branch `feat/substrate-brief`,
  fetched alongside uplift and awaited before the Graph of Thought.
- `substrate` CLI, git post-commit collector, Cursor hook projector,
  systemd unit.
- Index backfilled from 6 real Agent Task Graph graphs / 15 nodes.

**Proof met:** a brief fetched from inside `claude-ultrathink` named a Cursor
edit, a Hermes test run, another agent's open graph and a warning — 14 ms,
inside the 1.5 s budget.

Not done: real Greptime/Postgres credentials; `graph_register` call inside the
`ultrathink-kickoff` skill; nothing installed to the live system yet (systemd
unit, git hook and Cursor hooks are all written but only dry-run).

## Accumulated context

**Decisions**

- `agent-substrate` is its own git repo. Before `git init` it was an empty dir inside
  `/root/src/repos`, so GSD resolved upward to that repo's `.planning/` — an unrelated
  "Voice stream and desk wiring" milestone. The local `.git` scopes GSD correctly.
- RAGFlow and GreptimeDB live on a Railway account this MCP connection cannot see. Both are
  consumed as **external endpoints** from `/etc/substrate/substrate.env`; the substrate never
  provisions them.
- The index Postgres is assumed to be on that same account. Fallback is the connected Supabase
  project. It does **not** go on this VPS — disk is at 90%.
- Phase 4 vendors the real content of `/root/agent-skills` (dereferencing all 26 symlinks)
  rather than committing links or using submodules.
- Execution is full-autonomous, including live phase proofs and cross-repo PRs.

**Corrections found while building**

- Linear team is **swcstudio** with the **`SPE-`** prefix. The Notion plan's
  examples say `SWC-123`; real rows are `SPE-119`. Anything matching on the
  identifier must not hardcode `SWC`.
- MCP tool names cannot contain dots, so `memory.brief` is `memory_brief`.
- Greptime reserves `id` as a column name — all identifiers are quoted.
- Greptime returns TIMESTAMP columns as integer epochs, not ISO strings.
- Bun's SQL binds a JS array for `in ${sql(arr)}`, but `= any(${arr})` emits a
  malformed array literal.

**Corrections to the Notion plan, found on the VPS**

- `claude-ultrathink` is enabled (`"ultrathink@ultrathink": true`), not disabled. Phase 0's
  "re-enable the plugin" task is already satisfied.
- `/root/agent-skills` is not a git checkout: 14 real dirs + 26 symlinks.
- Ports 7410 and 6420 are free; `auctioning-greptime-1` on :4000 belongs to another project.

## Blockers

- **Greptime and Postgres credentials not yet supplied.** `GREPTIME_URL` /
  `GREPTIME_USER` / `GREPTIME_PASSWORD` / `GREPTIME_DB` and `SUBSTRATE_PG_URL`
  are needed to point Phase 0 at the real stores. Development runs against
  throwaway local containers (`substrate-dev-pg` on 55432, `substrate-dev-greptime`
  on 44000); repointing is an env change, no code change.

## Pending todos

- Confirm the GitHub remote name/owner before first push (`swcstudiospace/agent-substrate`,
  private, assumed).

## Deferred

- Notion §12 unknowns, each probed at the start of the phase that needs it: Orca's session/event
  query API, Muse's plugin API, Omp's skills directory, which Cursor hooks fire for the CLI,
  rivet-agentos `openSession` option names and the Codex adapter package name.

## Local dev stack

Two throwaway containers, safe to delete:

    docker rm -f substrate-dev-pg substrate-dev-greptime

`substrate-mcp` runs from /tmp/substrate-mcp.pid during development.
