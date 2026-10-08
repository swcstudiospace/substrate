---
gsd_state_version: "1.0"
milestone: v1.2
milestone_name: Swarm leases, workspace install and lessons bank
current_phase: 15
status: completed
last_updated: "2026-10-08T02:18:33Z"
last_activity: 2026-10-08
state_head: c7c7f3d200af13339d2cb5cb3b7d5b8aa884247d
progress:
  total_phases: 5
  completed_phases: 5
  total_plans: 5
  completed_plans: 5
  percent: 100
last_activity_desc: Lessons bank PR17 merged; handoff/P12 corrections and workspace deliveries remain gated
---

# State

## Current

**v1.2 behavioral work is complete:** five phases, five plans, 43 numbered tasks and 25 requirements. Canonical manager projects all five phases complete/passed. All ten Nyquist/security reports exist; Phase 15 has current-goal re-verification and independent F-15-02 closure, with no accepted risks.

Tested code: agent-substrate lessons `439fb50` (documentation-only final head `f956ec2`) and projector `fe946a1`; agent-swarm handoffs/lease corrections `ce13342` and integrated workspace `8bbe668`. Parent gates/live proofs are recorded per phase. Phase 15: 60 focused/1146 full live-PG, clean typecheck/LSP, 18 real-store and 4 structured-diagnostic actual-CLI checks; 31-check bank proof retained at `e7be626`.

**Delivery is not complete.** Agent-substrate [PR #17](https://github.com/swcstudiospace/agent-substrate/pull/17) merged at `746a38a4aaa0cbe25cdea54d64d4babb6bda37bd` after exact-head Greptile 5/5, zero comments, round 4. GitHub's configured check was Greptile Review; no separate build/test CI claimed. Handoff/P12-correction and both workspace shipments, final milestone audit, archive, tag and planning closeout PR remain gated. Local ship Git sync failed; no local-main update is assumed. User checkouts and production were not changed.

## Historical v1.0 execution record

The following implementation notes predate v1.2. They are retained as history, not current deployment or pending-work assertions.

Phase 0 (Brief) is **complete and live on production infrastructure**.
`substrate-mcp` runs under systemd against GreptimeDB v1.1.4 and TimescaleDB,
both on Railway. The local dev containers have been deleted and the service
remains healthy, which is the proof it no longer depends on them.

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

Verified in production: chained events written to Railway Greptime and read
back, `substrate verify` confirming the hash chain intact, the index backfilled
from 6 real Agent Task Graph graphs, and three surfaces (hermes, omp,
grok-build) holding claims that a fourth (muse) sees in its brief. The service
survives SIGKILL and is restarted by systemd.

Not done: a reachable Postgres URL for the index; `graph_register` call inside
the `ultrathink-kickoff` skill; git post-commit hook and Cursor hooks are
written but still only dry-run.

## Historical implementation context

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

### Roadmap Evolution

- Phase 8.1 inserted after Phase 8: Gap closure: a version conflict now reports the decision's current version, so a swarm rewrite works when the decision is not in the newest 100 entries (MEM-02) (URGENT)

## Historical blocker notes

_(No open blockers. Credential rotation was considered and declined by the
owner — recorded here so it is not re-raised.)_

## Historical pending work

- Review and merge claude-ultrathink PR #1 (`substrate/brief` → `master`).

## Historical publication record

- `swcstudiospace/agent-substrate` (private) — `main` pushed.
- `swcstudiospace/claude-ultrathink` PR #1 — the `fetchBrief` integration,
  branched cleanly from `master`, 5 files, 256 tests green.

**Lesson recorded:** `git add <file>` on a file another session had already
modified swept four of their hunks into my commit (a 3→15 Sub-Issue assertion
and a `<thinking>`→`<rationale>` fixture change). It only surfaced because the
clean branch failed against `master`. In a shared checkout, stage hunks or
verify the diff against the target branch before pushing — not just the file
list.

## Historical investigation notes

- Notion §12 unknowns, each probed at the start of the phase that needs it: Orca's session/event
  query API, Muse's plugin API, Omp's skills directory, which Cursor hooks fire for the CLI,
  rivet-agentos `openSession` option names and the Codex adapter package name.

## Historical deployment record

`substrate-mcp` runs under systemd — `systemctl status substrate-mcp`,
`journalctl -u substrate-mcp -f`. Credentials at `/etc/substrate/substrate.env`
(0600, root). Both stores are on Railway; no local containers remain.

Railway networking, learned the hard way: `.railway.internal` and
`DATABASE_PRIVATE_URL` resolve only from inside Railway. A consumer outside it
needs the TCP proxy (`…proxy.rlwy.net:PORT`), which must be enabled per service
under Settings → Networking. HTTP services get a public domain automatically,
which is why Greptime worked immediately and Postgres did not.

## Current Position

Phase: 15
Total Phases: 5 (Phases 11-15)
Plan: 5/5 implemented and behaviorally verified; 10/10 formal reports complete
Status: Milestone close awaits gated PR merges, final audit, archive and planning closeout
Last activity: 2026-10-08 — PR17 merged, remaining deliveries in progress

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| uat_gaps | milestones/v1.0-phases/00-brief/0-UAT.md | partial (8 scenarios pending) | 2026-10-07 | v1.1 |

## Operator Next Steps

- Ship the handoff/P12-correction branch, then both workspace branches through the serialized configured gate. PR17 is merged and its receipt is synchronized. Update delivery evidence, perform a fresh v1.2 integration audit and complete the approved archive/cleanup workflow. Tag publication/destructive branch pruning require their workflow checkpoints; preserve user worktrees and shared fixtures.

## Session Continuity

Last session: 2026-10-08
Stopped at: PR17 merged at 746a38a; Phase15 current goal/security gates passed, all five canonical phases complete/passed. Handoff/P12-correction branch assessment started. Totals: lessons 1146 Bun/60 focused/18 real-store/4 diagnostics; projector 1074 Bun; handoffs 757 Python; integrated workspace 828 Python/1378 omp; retained live proofs 42/24/49/51/31.
Resume file: None; current progress is recorded in the phase summaries and ultrathink ship state.
