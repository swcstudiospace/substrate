---
phase: 14-workspace-install
plan: 01
one-liner: "A fresh swarm workspace is wired to substrate-mcp by the install alone: one substrate MCP entry per runtime that names the token variable and never a value, a 0600 token file per agent outside every checkout, and a runner that gives each child only its own SUBSTRATE_TOKEN and leases and tees with that same agent's token."
subsystem: projector + swarm installer and runner
tags: [swarm, install, projector, mcp, tokens, adr-0001, s4, spe-5055]
requirements-completed: [INST-01, INST-02, INST-03, INST-04, INST-05, PROOF-03]
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
  - Grok's project MCP is unlocked with --trust, which persists a per-workspace trust grant; omp mounts MCP devices despite --tools, but its swarm guard must also admit the exact projected substrate API with the process's own agent token
  - 0600 separates OS accounts, not processes of one account; documented, not fixed
completed: 2026-10-07
status: complete
---

# Plan 14-01 Summary

## What shipped
- **Projector** (agent-substrate): `swarm-workspace.ts` emits one `substrate` server entry per runtime: `${SUBSTRATE_URL}/mcp` with `Authorization: Bearer ${SUBSTRATE_TOKEN}`. It appends and keeps other entries, an identical entry is a no-op, and a differing one is refused. Writes are all-or-nothing with a `.substrate-backup`. `--spec` is the contract the swarm installer vendors.
- **Installer** (agent-swarm): `build_agents.py --install-workspace` writes the entries and one env file per agent. It keeps the existing refusals and adds refusals for non-MCP executors and for env directories inside a checkout or the workspace. A dry run prints the additions and the env files, never a token.
- **Runner**: each child gets only its own `SUBSTRATE_TOKEN`, with every other `SUBSTRATE_TOKEN*` and `SUBSTRATE_OPERATOR_TOKENS` stripped. Claude children get `--mcp-config`, `--strict-mcp-config` and the substrate tools; Grok gets `--trust`. Leases, sessions and the tee all use one token lookup. For omp, the exact projected entry and resolved own token set the matching `SWARM_SUBSTRATE_AGENT` marker; the guard allows only the known substrate API, not operator MCP calls or lookalike devices.
- **Docs**: `docs/swarm-workspace.md` (agent-substrate) and `docs/substrate-workspace.md` (agent-swarm) cover the server/agent variable split, ownership, token generation and the shared-account 0600 limit.

## Evidence
- agent-substrate projector branch, rebased on `main` after Phase 11: `bun run check` clean; 1066 pass / 0 fail with live Postgres. One fix during verification: the new token scan used `\s*` and read `.env.example`'s empty assignments across lines as a value. It now matches within one line, with a test case.
- Final agent-swarm Phase 14 branch (on Phases 12 and 13): 743 Python tests, full suite passing; `build_agents.py --check` up to date; `bun test tests/ts` 1/1; changed Python files pass Ruff. The full omp suite passes 1378 tests (5 isolated extension tests plus 1373 other tests). The two pre-existing E401s in `tests/test_uplift_harness.py` remain outside the changed files.
- PROOF-03 `/tmp/p14-proof.sh` (server from the projector branch, real Postgres and GreptimeDB, all 15 swarm tokens): 51/51 PASS (`/tmp/p14-proof-1791408555`).
  - **Install** into an empty git workspace: the dry run writes nothing; the install creates only new files; there are 15 env files, each 0600, outside every checkout, each holding its own token; no token and no Greptime MCP server appears under the workspace; a re-install changes nothing; the vendored spec equals `--spec`.
  - **Runtimes**, checked with no model tokens spent: Claude's init event shows substrate connected and the `mcp__substrate__*` tools at $0. Grok is untrusted without `--trust` and healthy with tools discovered with it. omp mounts the substrate devices under its `--tools` allowlist. A deterministic local provider then drives omp's actual tool loop: guarded `events_emit` reaches the ledger as A05, the operator MCP call is blocked, and output contains no token.
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
- Integration audit LW-01 found that omp discovery did not prove execution: the blanket MCP guard blocked the installed server. The own-token exception and actual guarded tool-loop proof close it; A01's depth cap and operator-tool denial stay intact. LW-02's missing workspace in the congestion regression fixture is corrected.

## Lessons
- Runtime discovery is not execution proof. Exercise an installed tool through the real runtime's guard and transport, and verify both the intended identity at the server and refusal of an operator-credential tool.

## Consolidated current-source receipt — 2026-10-08

- Substrate `a9d699e9e70ee7f112a4fe793572852054eff572` preserves the projector and integrates shipped lessons PR17. Swarm `60b181464d2c06413690592cdcb0a764ddbd33b9` preserves per-agent workspace credentials and integrates final signed-handoff/P12 corrections from shipped PR10. No history rewriting or user checkout edits.
- Integration corrected three new recovery-test calls to pass their private credential workspace and removed duplicate auth-refusal test definitions. The published squash tree exactly matched final PR10 source `f2686c7`; the second history merge nevertheless reintroduced obsolete guard/test definitions automatically. They were removed to preserve the tested workspace cutover. Final `60b1814` and pre-history-merge `4d2a4cf` have identical complete tree `11021d0130bbd8288f0e41c3027968e94988c5a5`.
- Parent current substrate gate: **1171 Bun tests, 0 failures, 0 skips, 4489 assertions, 40 files, 7.17s**, using `SUBSTRATE_TEST_PG_URL` on isolated real Postgres; same-source `bun run check` passed. The earlier no-PG/partial runs are not the final gate.
- Parent current swarm gate: **842 Python tests passed in107.43s**, generator current, TypeScript contract **1/1 with6 assertions**, changed-file Ruff passed. No executable-code or test-content changes followed this gate; operator recovery documentation and content-identical merge history were added. The earlier 13 fixture failures and duplicate-definition lint errors were corrected, not waived.
- Fresh PROOF-03: **51/51, 13.21s**, `/tmp/p14-proof-1791430676`, isolated `:7513`, real Postgres `:55432`/GreptimeDB `:54000`. Fifteen private env files, idempotent/spec-identical install, Claude connected at$0, Grok trust boundary and actual guarded omp own-token event/operator refusal passed. Real runner with only A01's token completed A05 through its own env-file token; A09's brief showed the correct actor/node. Graph `ut-muyzku69-40917665`, claim `03:38:09.293Z`, own-agent event `.455Z`, release `.525Z`. No full multi-agent LLM run.
- Additional current integration proof: **4/4** on signed server `a9d699e9` at`:7512`, using the final merged swarm code with four private env files outside the task workspace and every per-surface token variable removed from the client. Late queued dispatch and regenerated redispatch preserve rework; lost committed reply remains one actual signed packet; malformed receiving response preserves healthy context. Graph `ut-muyzxvyp-16a9cf4e`, root `/tmp/p13-review-real-fsl14gea`, rework `hof_e2228419a716494fa688f822ca362536`, lost reply `hof_f9355d4a780543fabe7884f7bad300b2`.
- Projector PR18 is open at exact `a9d699e9`, configured review in progress. Swarm workspace source is prepared but not yet assessed/shipped; no combined phase or milestone delivery claim. Existing1378-test omp gate is retained unchanged-extension evidence, not rerun.
