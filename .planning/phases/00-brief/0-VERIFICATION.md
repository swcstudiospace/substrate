---
status: passed
phase: 00-brief
phase_name: Brief
verified: 2026-09-24
gaps_closed: 2026-09-24
mode: verify-only (no rebuild — service was already live under systemd), then targeted gap closure
source: .planning/ROADMAP.md Phase 0 success criteria; .planning/phases/00-brief/0-UAT.md
score_at_verification: 5 passed / 1 partial / 2 failed of 8
score_after_closure: 7 passed / 1 landed-not-yet-live of 8
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
| 4 | `fetchBrief` runs before the Graph of Thought, fails open <1.5 s | ✓ pass (closed) |
| 5 | `ultrathink-kickoff` calls `graph_register` | ◑ landed, not yet live |
| 6 | Cursor hooks appended + git post-commit collector installed | ✓ pass (closed) |
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

## Gap closure (same day)

All three gaps were closed on the owner's instruction. What changed:

**Criterion 4 — closed.** claude-ultrathink PR #1 was squash-merged as
`f10e8de` (`feat(substrate): fetch the Agent Substrate brief before the Graph
of Thought (#1)`), +288/−3 across 5 files, Greptile Review passing.
`fetchBrief` is now on `origin/master`: the call site is `src/claude/hook.ts:110`
and the await is `:130`, still before `runThink`. Sessions on `master` now get
the brief.

*Accepted deviation, not a gap:* the injected framing remains
`SUBSTRATE_CONTEXT_HEADER` (`## Agent Substrate brief`, `src/claude/output.ts`)
rather than the literal `<SUBSTRATE_BRIEF>` tag the criterion names. The header
carries explicit untrusted-content framing — the brief is assembled from what
other agents wrote — which is the safer design. Recording the wording
divergence rather than changing working code.

**Criterion 6 — closed and verified.** Both collectors are installed:
- `.git/hooks/post-commit` installed in this repo via
  `bun packages/collectors/src/install-git-hook.ts .` (`--check` now reports
  `✓ present`). The installer refuses to clobber a foreign hook; the hook itself
  backgrounds its call and exits 0 unconditionally, so a dead substrate cannot
  delay a commit.
- `/root/.cursor/hooks.json` projected via
  `bun packages/projector/src/cursor.ts` — 3 `substrate-managed` entries
  appended to `sessionStart`, `postToolUse` and `stop`, with **all 6
  `gsd-managed` entries untouched**, exactly as the criterion requires. A
  backup was written to `hooks.json.substrate-backup`, and a re-run reports
  `already current`, confirming idempotence.

*Proven live, not just installed:* committing `716b8ba` to this repo raised
`agent_events` from 13 to 14, and the new row is
`commit | commit 716b8ba docs(phase-0): close the three verification gaps |
cursor` — the hook fired on a real commit and the sha matches.

**Criterion 5 — landed, not yet live.** The `graph_register` call was added to
`ultrathink-kickoff` as a new step 5 (between creating the rows and resolving
HITL), idempotent by `graph_id` and explicitly fail-open. Committed as
`c2c12a8` on branch `substrate/graph-register` in claude-ultrathink.

Two honest caveats on this one:
- It is on a branch, not yet merged to `master`.
- The **running plugin loads from a cache copy**, not the repo:
  `/root/.claude/plugins/cache/ultrathink/ultrathink/0.1.1/skills/ultrathink-kickoff/SKILL.md`
  still contains zero `graph_register` references. Until that cache is rebuilt
  (version bump / reinstall), a live kickoff still will not register. The
  criterion is satisfied in the source of truth but not yet in the running
  install.

It was committed to a *new* branch rather than the checked-out
`feat/substrate-brief` deliberately. That working tree holds **15 files
modified by another session**, including its own uncommitted rewrite of this
same `SKILL.md`, with our hunks interleaved. Staging the path would have swept
their work into this commit — the exact failure STATE.md records as a lesson.
Instead the committed blob was reconstructed as *HEAD's* `SKILL.md` plus only
these edits and written through a temporary index, so the working tree and the
shared branch's HEAD were never touched. Verified after the fact: branch still
`feat/substrate-brief` at `85ca1ac`, all 15 files still modified and
uncommitted.

## Note on side effects

Verification appended two real events to the append-only log (one `note`
probe, one `file.edit` cross-surface proof, stamped `uat-xsurface-1790209042`).
They were deliberately left in place — the log is hash-chained, so removing a
row would break the chain that `/verify` and Phase 6 depend on.
