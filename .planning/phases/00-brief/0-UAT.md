---
status: complete
phase: 00-brief
source: .planning/ROADMAP.md (Phase 0 success criteria) — no SUMMARY.md exists; Phase 0 was built directly from the approved plan rather than through plan-phase/execute-phase
started: 2026-09-23T18:55:00Z
updated: 2026-09-24T00:18:00Z
completed_by: /gsd-autonomous (verify-only mode — no rebuild)
---

## Current Test

[all 8 tests run 2026-09-24 against the live service; see 0-VERIFICATION.md]

## Tests

### 1. substrate-mcp serves both surfaces
expected: 9 MCP tools listed; GET /healthz, POST /brief, POST /events, POST /verify all answer
result: passed
evidence: "tools/list returned exactly 9 (memory_brief/write/search, events_emit, graph_get/register/claim/release/complete); /healthz 200 {index:true,greptime:true}; /brief 200; /events 202 with id+hash; /verify 200 {ok:true,events:4} on a real graph_id"

### 2. Schemas exist and hold real data
expected: graph_index/graph_nodes/graph_steps/memory_entries in Postgres, agent_events/anchors in Greptime, all on Railway
result: passed
evidence: "postgres: graph_index(6), graph_nodes(15), graph_steps(0), memory_entries(1); greptime: agent_events(12), anchors(0 rows, table present — anchors is Phase 6's surface)"

### 3. Index backfilled from the Notion Agent Task Graph
expected: real graphs and nodes from the live database, with Linear identifiers
result: passed
evidence: "6 graphs with live Notion page URLs across claude-ultrathink/autonogrammer/clippyos; nodes carry real SPE- identifiers (SPE-119, SPE-120, SPE-124, SPE-125), confirming the SPE- prefix over the plan's SWC-"

### 4. The brief reaches a Claude Code session
expected: fetchBrief runs before the Graph of Thought and injects the brief into prompt context
result: partial
evidence: "src/claude/hook.ts:110 starts fetchBrief concurrently with uplift, awaits at :130 before runThink at :137; live call returned a 253-char brief in 596ms. BUT: not on master — PR #1 (substrate/brief → master) still OPEN; and framing is SUBSTRATE_CONTEXT_HEADER '## Agent Substrate brief' (output.ts:34), not the literal <SUBSTRATE_BRIEF> tag the criterion names"

### 5. ultrathink-kickoff calls graph_register
expected: a newly tracked Task registers itself in the index automatically
result: issue
evidence: "skills/ultrathink-kickoff/SKILL.md has no reference to graph_register, graph.register, or the substrate. Newly tracked Tasks do not self-register. Matches STATE.md's own 'Not done' list"

### 6. Cursor hooks and the git post-commit collector are installed
expected: a Cursor session writes .substrate/BRIEF.md; a commit emits a commit event
result: issue
evidence: "collector source exists at packages/collectors/src/git/post-commit but no .git/hooks/post-commit is installed; /root/.cursor/hooks.json holds only gsd-managed:true entries across all six arrays — no substrate commands appended. Matches STATE.md's 'written but still only dry-run'"

### 7. A substrate outage does not block any agent
expected: with substrate-mcp stopped, prompts proceed normally, just unbriefed
result: passed
evidence: "proven without disturbing production — real fetchBrief pointed at a dead port returned '' in 2ms with no throw, inside the 1.5s budget; bun test src/substrate/brief.test.ts → 7 pass / 0 fail covering timeout, network failure and SUBSTRATE_DISABLED"

### 8. Phase proof — cross-surface brief
expected: work done on one surface appears in another surface's brief, keyed by Graph ID
result: passed
evidence: "a file.edit emitted as surface=cursor on graph ut-mucem4mc-ec70360f appeared ~2s later in a brief requested as surface=hermes for the same graph; the same brief showed hermes on n3/SPE-122, omp on n4/SPE-123 and grok-build on n5/SPE-121 holding live claims"

## Summary

total: 8
passed: 5
issues: 2
pending: 0
partial: 1
skipped: 0
blocked: 0

## Gaps

All three closed the same day, on the owner's instruction. Test results above
record the state **at the time of the run**; this records what changed after.

1. ~~`graph_register` not called from `ultrathink-kickoff` (test 5)~~ —
   **landed, not yet live.** Added as step 5, idempotent and fail-open,
   committed as `c2c12a8` on branch `substrate/graph-register`. Two caveats:
   it is not yet merged to `master`, and the running plugin loads from a cache
   copy (`plugins/cache/ultrathink/ultrathink/0.1.1/…`) that still has no
   `graph_register`, so a live kickoff will not register until that cache is
   rebuilt.
2. ~~Collectors written but not installed (test 6)~~ — **closed and verified.**
   `.git/hooks/post-commit` installed (`--check` → `✓ present`); 3
   `substrate-managed` entries appended to `/root/.cursor/hooks.json` with all
   6 `gsd-managed` entries untouched, backup written, re-run idempotent.
3. ~~claude-ultrathink PR #1 unmerged (test 4)~~ — **closed.** Squash-merged as
   `f10e8de`; `fetchBrief` is on `origin/master` with the call site at
   `hook.ts:110` and the await at `:130`, before `runThink`. The
   `<SUBSTRATE_BRIEF>` wording divergence is recorded as an accepted deviation
   — the code uses a markdown header with untrusted-content framing instead.

None was blocking for Phase 1, which consumes `/brief` and `/events` over HTTP
— both live and proven here.
