---
status: gaps_found
phase: 00-brief
phase_name: Brief
verified: 2026-09-24
mode: verify-only (no rebuild — service was already live under systemd)
source: .planning/ROADMAP.md Phase 0 success criteria; .planning/phases/00-brief/0-UAT.md
score: 5 passed / 1 partial / 2 failed of 8
---

# Phase 0 (Brief) — Verification

Run against the **live** `substrate-mcp` on `127.0.0.1:7410` (systemd `active`)
and the production Railway stores. Nothing was rebuilt or re-planned; this
report only establishes what is true right now.

## Result by success criterion

| # | Criterion | Result |
|---|-----------|--------|
| 1 | `substrate-mcp` serves MCP + HTTP surfaces | ✓ pass |
| 2 | Index and event schemas exist and hold real data | ✓ pass |
| 3 | Index backfilled from the Agent Task Graph | ✓ pass |
| 4 | `fetchBrief` runs before the Graph of Thought, fails open <1.5 s | ◑ partial |
| 5 | `ultrathink-kickoff` calls `graph_register` | ✗ fail |
| 6 | Cursor hooks appended + git post-commit collector installed | ✗ fail |
| 7 | A substrate outage leaves every agent working, just unbriefed | ✓ pass |
| 8 | Phase proof — cross-surface brief keyed by Graph ID | ✓ pass |

## Evidence

**1 — both surfaces answer.** `tools/list` returns exactly 9 tools:
`memory_brief`, `memory_write`, `memory_search`, `events_emit`, `graph_get`,
`graph_register`, `graph_claim`, `graph_release`, `graph_complete`.
`GET /healthz` → `200 {"index":true,"greptime":true}`; `POST /brief` → 200;
`POST /events` → 202 with id + hash; `POST /verify` → 400 `graph_id is
required` bare, and `200 {"ok":true,"events":4}` with a real graph — i.e. the
route answers and the hash chain validates.

**2 — schemas hold real data.** Postgres `public`: `graph_index` (6 rows),
`graph_nodes` (15), `graph_steps` (0), `memory_entries` (1). Greptime:
`agent_events` (12 rows) and `anchors` (0 rows, table present — `anchors` is
Phase 6's surface, so empty is correct here).

**3 — backfill is real, not fixture.** `graph_index` carries live Notion page
URLs across three real repos (`claude-ultrathink`, `autonogrammer`,
`clippyos`); `graph_nodes` carries real Linear identifiers on the **`SPE-`**
prefix (SPE-119, SPE-120, SPE-124, SPE-125), confirming STATE.md's correction
that the team prefix is `SPE-`, not the plan's `SWC-`.

**4 — partial.** The wiring is correct and proven: `src/claude/hook.ts:110`
starts `fetchBrief` concurrently with uplift and awaits it at line 130, before
`runThink` at line 137 — the Graph of Thought. Live call returned a 253-char
brief in 596 ms. Two deviations from the criterion as written:
- It is **not on `master`**. It lives on `feat/substrate-brief` /
  `substrate/brief`; PR #1 (`substrate/brief` → `master`) is still **OPEN**.
  A session running the plugin from `master` gets no brief.
- The injected framing is `SUBSTRATE_CONTEXT_HEADER` = `## Agent Substrate
  brief` (see `src/claude/output.ts:34`), not the literal `<SUBSTRATE_BRIEF>`
  tag the criterion names. The header carries explicit untrusted-content
  framing, which is the better choice — but the criterion's wording is unmet.

**5 — fail.** `skills/ultrathink-kickoff/SKILL.md` contains no reference to
`graph_register`, `graph.register` or the substrate at all. Newly tracked
Tasks do not register themselves in the index. This matches STATE.md's own
"Not done" list.

**6 — fail.** The collector source exists at
`packages/collectors/src/git/post-commit`, but no `.git/hooks/post-commit` is
installed in this repo. `/root/.cursor/hooks.json` contains only
`gsd-managed: true` entries across `sessionStart`, `preToolUse`,
`postToolUse`, `stop`, `subagentStart`, `subagentStop` — no substrate commands
are appended. The "not replacing them" half of the criterion holds; the
"appended" half does not. Matches STATE.md's "written but still only dry-run".

**7 — pass, proven without disturbing production.** Rather than stopping the
live service, the real `fetchBrief` was pointed at a dead port: returned `""`
in **2 ms**, no throw — inside the 1.5 s budget by three orders of magnitude.
`bun test src/substrate/brief.test.ts` → **7 pass / 0 fail**, covering timeout,
network failure and `SUBSTRATE_DISABLED`.

**8 — pass, the phase proof.** A `file.edit` event emitted as `surface=cursor`
on graph `ut-mucem4mc-ec70360f` appeared in a brief requested as
`surface=hermes` for the same graph, ~2 s later. The same brief showed three
other surfaces holding live claims — `hermes` on n3/SPE-122, `omp` on
n4/SPE-123, `grok-build` on n5/SPE-121 — plus a `claude-code` warning about
Railway internal hostnames. Cross-surface, keyed by Graph ID, is real.

## Gaps to close

1. **`graph_register` in `ultrathink-kickoff`** (criterion 5) — add the call
   after the Notion/Linear rows are created, so the index self-populates.
2. **Install the collectors** (criterion 6) — append substrate commands to the
   Cursor `hooks.json` arrays without disturbing the `gsd-managed` entries, and
   install the git post-commit hook.
3. **Merge claude-ultrathink PR #1** (criterion 4) — until it lands on
   `master`, the brief only reaches sessions running the feature branch.

None of the three is blocking for Phase 1: Lane B consumes `/brief` and
`/events` over HTTP, both of which are live and proven above.

## Note on side effects

Verification appended two real events to the append-only log (one `note`
probe, one `file.edit` cross-surface proof, stamped `uat-xsurface-1790209042`).
They were deliberately left in place — the log is hash-chained, so removing a
row would break the chain that `/verify` and Phase 6 depend on.
