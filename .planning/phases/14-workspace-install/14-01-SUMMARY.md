---
phase: 14-workspace-install
plan: 01
one-liner: "A fresh swarm workspace is wired to substrate-mcp by the install alone: one substrate MCP entry per runtime that names the token variable and never a value, a 0600 token file per agent outside every checkout, and a runner that gives each child only its own SUBSTRATE_TOKEN and leases and tees with that same agent's token."
subsystem: projector + swarm installer and runner
tags: [swarm, install, projector, mcp, tokens, adr-0001, s4, spe-5055]
provides:
  - packages/projector/src/swarm-workspace.ts - library and bun CLI (--plan, --check, --apply, --spec) writing the substrate entry for Claude Code and omp (.mcp.json) and Grok Build (.grok/config.toml)
  - swarm installer applies the vendored projector spec; idempotent, appends, refuses a differing entry, unparsable files and non-MCP executors
  - per-agent env files - 0700 directory, 0600 file, exactly SUBSTRATE_TOKEN=<its token>, outside the workspace and every git checkout
  - one token lookup (swarm/workspace.py credential) for child sessions, leases and the event tee; never the runner's SUBSTRATE_TOKEN
  - runner flags - Claude --mcp-config <ws>/.mcp.json --strict-mcp-config and mcp__substrate tools; Grok --trust; omp unchanged
  - tracked-file scan fails on any SUBSTRATE_TOKEN* assigned a literal value
key-files:
  created:
    - packages/projector/src/swarm-workspace.ts
    - packages/projector/src/swarm-workspace.test.ts
    - docs/swarm-workspace.md
    - agent-swarm swarm/workspace.py
    - agent-swarm swarm/substrate_mcp.json
    - agent-swarm scripts/_install_substrate.py
    - agent-swarm tests/test_install_substrate.py
    - agent-swarm tests/test_agent_token.py
    - agent-swarm docs/substrate-workspace.md
  modified:
    - packages/projector/package.json
    - packages/mcp-server/src/store-lock.test.ts
    - docs/swarm-correlation.md
    - agent-swarm scripts/build_agents.py
    - agent-swarm scripts/swarm_run.py
    - agent-swarm swarm/substrate_lease.py
    - agent-swarm swarm/substrate_tee.py
    - agent-swarm scripts/orch_status.py
    - agent-swarm .claude/agents/*.md (tools gain mcp__substrate)
key-decisions:
  - The public swarm installer applies a vendored copy of the projector's --spec rather than calling the private repo's bun projector; the proof checks the two stay identical and that the projector finds nothing to add after the installer
  - Tokens come from SUBSTRATE_TOKEN_<SURFACE> in the installer's environment; the installer never reads the server's substrate.env, and a missing token stops the install with nothing written
  - One lookup for sessions, leases and the tee (env file, else the agent's SUBSTRATE_TOKEN_<SURFACE>, never the runner's SUBSTRATE_TOKEN), so an S4 runner holding only A01's token still attributes every row to its agent
  - Grok's project MCP is unlocked with --trust, which persists a per-workspace trust grant; omp's --tools allowlist leaves MCP devices mounted, so omp needs no flag
  - 0600 separates OS accounts, not processes of one account; documented, not fixed
completed: 2026-10-07
status: complete
---

# Plan 14-01 Summary

## What shipped
- **Projector** (agent-substrate): `swarm-workspace.ts` emits one `substrate` server entry per runtime: `${SUBSTRATE_URL}/mcp` with `Authorization: Bearer ${SUBSTRATE_TOKEN}`. It appends and keeps other entries, an identical entry is a no-op, and a differing one is refused. Writes are all-or-nothing with a `.substrate-backup`. `--spec` is the contract the swarm installer vendors.
- **Installer** (agent-swarm): `build_agents.py --install-workspace` writes the entries and one env file per agent. It keeps the existing refusals and adds refusals for non-MCP executors and for env directories inside a checkout or the workspace. A dry run prints the additions and the env files, never a token.
- **Runner**: each child gets only its own `SUBSTRATE_TOKEN`, with every other `SUBSTRATE_TOKEN*` and `SUBSTRATE_OPERATOR_TOKENS` stripped. Claude children get `--mcp-config`, `--strict-mcp-config` and the substrate tools; Grok gets `--trust`. Leases, sessions and the tee all use one token lookup.
- **Docs**: `docs/swarm-workspace.md` (agent-substrate) and `docs/substrate-workspace.md` (agent-swarm) cover the server/agent variable split, ownership, token generation and the shared-account 0600 limit.

## Evidence
- agent-substrate projector branch, rebased on `main` after Phase 11: `bun run check` clean; 1066 pass / 0 fail with live Postgres. One fix during verification: the new token scan used `\s*` and read `.env.example`'s empty assignments across lines as a value. It now matches within one line, with a test case.
- agent-swarm Phase 14 branch (on Phase 12): 700 tests, full suite passing; `build_agents.py --check` up to date; `bun test tests/ts` passing; ruff clean except the two E401s already on `main`.
- PROOF-03 `/tmp/p14-proof.sh` (server from the projector branch, real Postgres and GreptimeDB, all 15 swarm tokens): 47/47 PASS.
  - **Install** into an empty git workspace: the dry run writes nothing; the install creates only new files; there are 15 env files, each 0600, outside every checkout, each holding its own token; no token and no Greptime MCP server appears under the workspace; a re-install changes nothing; the vendored spec equals `--spec`.
  - **Runtimes**, checked with no model tokens spent: Claude's init event shows substrate connected and the `mcp__substrate__*` tools at $0. Grok is untrusted without `--trust` and healthy with tools discovered with it. omp mounts the substrate devices under its `--tools` allowlist.
  - **A real `orch_plan` plus `swarm_run --once`** with only A01's token in the runner, and a stub agent CLI that calls `events_emit` through its own MCP entry:
    - the session held only A05's token, from its env file;
    - the claim was granted to `swarm-a05-be` as `A05@r0:<graph>`;
    - the agent's own event is in the ledger;
    - DONE completed the node (`graph_get`: completed, unheld);
    - no `lease_id` appears in the trail;
    - A09's brief for the repo is non-empty and names swarm-a05-be and the node;
    - no token appears under the workspace or in the server log.

## Deviations
- The tee was first left on runner-side overrides. The proof showed that an S4 runner with only A01's token would lose A05's rows, so the tee now uses the shared lookup (decided in CONTEXT, with a cited v1.1 lesson).
- The proof's first completion check looked for an `action: completed` payload, which `graph_complete` does not write (its trail row is the fenced release note). It now reads the node's state.
