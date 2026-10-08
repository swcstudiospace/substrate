---
phase: 14-workspace-install
verified: 2026-10-07T22:44:46Z
status: passed
score: 5/5 must-haves verified
---

# Phase 14 Verification: Workspace install

Goal: a fresh swarm workspace is wired to `substrate-mcp` by the install alone, and each agent process holds only its own token.

## Success criteria (ROADMAP)
| # | Criterion | Evidence | Result |
|---|-----------|----------|--------|
| 1 | One appended, idempotent `substrate` entry per runtime that each child really sees (Claude `--mcp-config` + allowed tools, Grok past folder trust, omp despite `--tools`) | Projector and installer tests; live: Claude init connects at $0, Grok is untrusted then healthy with `--trust`, omp's real guarded tool loop invokes `events_emit` as A05 while an operator-credential MCP call remains blocked; re-install changes nothing | passed |
| 2 | Configs name `${SUBSTRATE_TOKEN}`, never a value; no Greptime MCP server; no token literal under the workspace; the tracked-file scan flags `SUBSTRATE_TOKEN*` literals | Projector and installer tests with a sentinel token; `store-lock.test.ts` token scan (with the single-line fix); live: no token or Greptime under the workspace, before and after a run, and none in the server log | passed |
| 3 | One 0600 env file per agent outside every checkout and the workspace, holding only its `SUBSTRATE_TOKEN`; a missing token prints what to create and exits non-zero | `test_install_substrate.py`; live: 15 files, 0600 in a 0700 dir, each its own token; dry run lists MISSING and exits 2 | passed |
| 4 | Each child gets only its own `SUBSTRATE_TOKEN`; the runner leases with the same agent's file | `test_agent_token.py`, `test_substrate_lease.py`, `test_substrate_tee.py`; live: the session's token is A05's (by hash) from its file, the claim is granted to swarm-a05-be as `A05@r0:<graph>`, the tee and lease use the same lookup | passed |
| 5 | Non-MCP executors refused; existing refusals kept; dry run prints additions and env files; docs record the `substrate.env` split and the 0600 limit | Installer tests (`trae` refused, bad JSON, differing entry, symlink, `$HOME`, `~/.omp`, checkout); `docs/swarm-workspace.md`, `docs/substrate-workspace.md` | passed |

## Requirements
| ID | Evidence | Status |
|----|----------|--------|
| INST-01 | Criterion 1 | satisfied |
| INST-02 | Criterion 2 | satisfied |
| INST-03 | Criteria 3 and 4 | satisfied |
| INST-04 | Criterion 5 | satisfied |
| INST-05 | Criterion 5 (docs) | satisfied |
| PROOF-03 | `/tmp/p14-proof.sh` 51/51 (`/tmp/p14-proof-1791408555`): fresh install, no hand edits, real `orch_plan` + `swarm_run --once`; the run reaches the ledger and A09's non-empty brief, the claim is granted, and omp invokes the installed tool through its guard | satisfied |

## Historical implementation checks
- Python suite: 743 passing; `build_agents.py --check` up to date; TypeScript contract test 1/1; changed Python files pass Ruff.
- Full omp suite: 1378 passing (5 isolated extension tests plus 1373 other tests).
- Cross-phase integration audit's omp guard finding is fixed: the runner marks only the exact projected entry with the agent's own token; the guard admits the known substrate API only for that session. Missing/invalid config, operator credentials, lookalike tools and A01's depth cap remain blocked.

## Not covered by the proof
- A full multi-agent LLM run: the agent CLI in the run is a stub that calls `events_emit` through its own MCP entry.
- Grok and omp spending model tokens.

## Formal audit remediation

- Tested snapshots: agent-substrate `fe946a1`; agent-swarm `8bbe668`. Exclusive randomized staging and pinned directory descriptors prevent auxiliary symlink escapes; conditional rollback preserves external edits on late failure. Existing nonprivate or wrong-owner token directories are refused without permission repair. Claude/Grok automatic wiring requires the exact installed substrate entry.
- Parent gates: 1074 substrate Bun tests and clean typecheck; 828 integrated swarm Python tests, current generator, TypeScript contract 1/1 and changed-file Ruff clean; 1378 omp tests (5 isolated extension tests plus 1373 others).
- Parent before/after smokes confirm that planted backup/temp links cannot alter the external sentinel and a 0777 existing token directory is refused before writing credentials.
- Fresh installed-runtime proof: 51/51, isolated 7499, 7.38 seconds; `/tmp/p14-proof-1791412718`. Fifteen private token files, exact projection, idempotence, Claude connection, Grok trust, actual guarded omp execution/operator refusal, own-token runner claim/completion and another agent's brief all passed.
- [Nyquist validation](14-VALIDATION.md) and [ASVS-L1 security](14-SECURITY.md) record the audit and remediation evidence. Multi-file rollback is not crash-atomic; shared-OS-account and no-full-LLM proof limits remain explicit. Shipping in both repositories is separately gated.
