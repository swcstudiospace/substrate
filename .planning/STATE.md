---
gsd_state_version: "1.0"
milestone: v1.0
milestone_name: "Agent Substrate — four planes (runtime, memory, skills, ledger) keyed by Graph ID"
current_phase: 0
current_phase_name: "Brief"
status: executing
last_updated: 2026-09-23
progress:
  total_phases: 7
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# State

## Current

Phase 0 (Brief). Repo initialised, planning state seeded, scaffold in place.

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

**Corrections to the Notion plan, found on the VPS**

- `claude-ultrathink` is enabled (`"ultrathink@ultrathink": true`), not disabled. Phase 0's
  "re-enable the plugin" task is already satisfied.
- `/root/agent-skills` is not a git checkout: 14 real dirs + 26 symlinks.
- Ports 7410 and 6420 are free; `auctioning-greptime-1` on :4000 belongs to another project.

## Blockers

- **Greptime credentials not yet supplied.** `GREPTIME_URL` / `GREPTIME_USER` /
  `GREPTIME_PASSWORD` / `GREPTIME_DB` and `SUBSTRATE_PG_URL` are needed to point Phase 0 at the
  real stores. Not blocking the build: development and tests run against a local Greptime
  container, then repoint.

## Pending todos

- Confirm the GitHub remote name/owner before first push (`swcstudiospace/agent-substrate`,
  private, assumed).

## Deferred

- Notion §12 unknowns, each probed at the start of the phase that needs it: Orca's session/event
  query API, Muse's plugin API, Omp's skills directory, which Cursor hooks fire for the CLI,
  rivet-agentos `openSession` option names and the Codex adapter package name.
