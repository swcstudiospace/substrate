---
phase: 14-workspace-install
verified: 2026-10-07T23:20:00Z
status: passed
score: 5/5 must-haves verified
---

# Phase 14 Verification: Workspace install

Goal: a fresh swarm workspace is wired to `substrate-mcp` by the install alone, and each agent process holds only its own token.

## Success criteria (ROADMAP)
| # | Criterion | Evidence | Result |
|---|-----------|----------|--------|
| 1 | One appended, idempotent `substrate` entry per runtime that each child really sees (Claude `--mcp-config` + allowed tools, Grok past folder trust, omp despite `--tools`) | `swarm-workspace.test.ts`, `test_install_substrate.py`, `test_agent_token.py`; live: Claude init shows substrate connected with `mcp__substrate__*` at $0, Grok untrusted → healthy with `--trust`, omp devices mounted; re-install changes nothing | passed |
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
| PROOF-03 | `/tmp/p14-proof.sh` 47/47: fresh install, no hand edits, a real `orch_plan` + `swarm_run --once`; the run is in the ledger and in A09's non-empty brief, and the claim is granted | satisfied |

## Not covered by the proof
- A full multi-agent LLM run: the agent CLI in the run is a stub that calls `events_emit` through its own MCP entry.
- Grok and omp spending model tokens.
