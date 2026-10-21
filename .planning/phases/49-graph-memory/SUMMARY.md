---
phase: 49-graph-memory
requirements: [SOTA-05]
status: in review (draft PR). In-repo gates green. Causality is the session order, not proven cause; the live ledger is not exercised
---

# 49-SUMMARY: Graph-linked memory and causal recall from Greptime events

## Built

- **Graph-linked results (`graph_linked`).** `memory_search` returns `graph_links`: for each distinct `graph_id` among the returned entries, the five newest ledger events of that graph, reduced to `id`, `ts`, `kind`, `surface`, `node_id` and a summary cut to 200 characters. A graph with no events gets an empty list. One ledger read per graph, under a 1000 ms budget.
- **Causal recall (`causal`).** Each returned entry with a `source_event` gains `causal_chain`: up to five events from that event's session that come before it in session order, nearest first, reduced the same way. An entry without a source event, or whose source is not in its session, gets an empty chain. One ledger read per session.
- **Honesty of the reply.** `graph_links_notice` and `causal_notice` carry the untrusted label. The causal notice says the chain is what preceded the memory, not proof of cause. A failed or timed-out read drops only its own part and adds a reason to `degraded`.
- **Paged listing.** The paged `memory_search` shape takes the same two options.
- **Docs.** A subsection `Graph-linked results and causal recall` in `docs/memory-governance.md`.

## Decisions

- D49-a to D49-h in CONTEXT.md. No schema change, no new event kind, no new tool, no new audit class. Causality uses the existing session order (`session_id`, `ts`, `id`) and the memory's existing `source_event`.

## Deviations (from the plan, with reasons)

- **Paged listing included.** The plan named the list reply only. The paged shape takes the options too, since a silent no-op on `subject_prefix` would mislead.
- **Dropped parts are omitted, not nulled.** A failed graph read leaves that graph out of `graph_links`, and a failed session read leaves `causal_chain` off that entry. `graph_links` is still an array when `graph_linked` is set, so an empty array can mean every read was dropped; `degraded` and `reason` tell the two apart.
- **Reason joining.** A ledger reason is appended to any existing recall reason with `; `. A plain search with no Hindsight reports `hindsight is not configured` and, with a failed ledger read, both reasons.
- **Redaction on read.** `reduceEvent` runs `redact()` on the summary as well as the cut. Ledger writes already redact, so this is a second pass, kept because the read path should not trust stored text.
- **Return types widened.** `searchMemory` returns `MemorySearchReply` and `searchMemoryPage` returns `MemorySearchPageReply`, both supersets of the old types. No other caller exists.

## Verified in-repo

- Typecheck: `bunx tsc --noEmit` exit 0.
- Config reference: up to date (no config change in this phase).
- Targeted: `memory-graph.test.ts` and `mcp.test.ts` 77 pass, including the six memory_search option cases.
- Full suite: `bun test` 5917 pass, 2 skip (pre-existing), 0 fail, over 5919 tests in 220 files, on the tree merged with the current main.
- Repo locks: `bun run check:phase-close` green.

## Open items

- **Writer and kind on `memory_search`.** The index supports both filters, but `parseMemorySearch` drops them and the tool takes no such argument. Out of scope here.
- **Graph-linked Hindsight recall.** Hindsight has no graph field, so graph-linked recall over Hindsight documents is not attempted. Replace-upserts would rewrite existing documents if metadata changed.
- **Causality is sequence, not cause.** The chain is the session's prior events. Recording a true cause would need a new event field, which needs an operator recreate of `agent_events` (no column is added here).

## Cleanup

- The worktree `/root/pr-fix/v149-graph` stays until close-out, with the other phase worktrees, after the user approves cleanup.
