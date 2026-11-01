# Phase 73 Context: Ledger tamper evidence

Source of truth: `.planning/ROADMAP.md` Phase 73 (success criteria 1 and 2). Discovery map: scout pass on origin/main `b1b42f92`, 2026-11-01.

## Goal

A rewrite, reorder, deletion or tail truncation of the event ledger is detected by recomputing the chain from stored rows, and the verified head is anchored. Criterion 1 is proven by tests against a head saved before the change. Criterion 2 requires each graph's chain head to be recorded in the hourly anchor, and that recorded head is the only trusted proof. A head recomputed from stored rows is never used as the proof.

## Verified facts (scout, file:line on origin/main)

- Ledger events live in GreptimeDB table `agent_events` (`packages/mcp-server/src/greptime.ts` ~968-991). The primary key is `(surface, repo, graph_id, kind)`. There is no sequence column, so order comes only from `prev` links.
- `verifyChain` (`packages/mcp-server/src/event.ts:313-326`) recomputes each `hash` and checks each `prev`. It returns `{ok, brokenAt, reason}`. It takes no external head, cannot detect tail truncation, and cannot detect a self-consistent rewrite.
- `verifyGraph` (`packages/mcp-server/src/service.ts:7144-7184`) reads rows, groups by session, calls `verifyChain`, then `hourReport`. Missing ids come from the `event_ingest` table (~7513-7516). `VerifyVerdict` is at 715-731.
- The hourly anchor (`packages/mcp-server/src/anchor.ts`, `runAnchorJob` 356, `anchorRow` 327-345) records one root and one count per UTC hour across all graphs. No per-graph head is recorded anywhere today.
- Memo (`packages/ledger/src/memo.ts`): `MEMO_PREFIX = "substrate:v1:"` (line 8), `MEMO_RE` line 9, `formatMemo` 22, `parseMemo` 32. The v1 memo has no room for a graph id or head.
- Merkle: `merkleRootHex` (`packages/ledger/src/merkle.ts:44`, RFC 6962); `merkleAuditPath` 46, `verifyAuditPath` 81 (`merkle-proof.ts`).
- Real devnet send: `anchor-run.ts` via `execFileRunner` (`packages/ledger/src/solana.ts:89`). `Runner` (line 86) is the fake-transport seam.

## Locked decisions (autonomous, per DECISION_POLICY)

**D73-01 Memo version.** Keep the v1 memo and its root derivation unchanged so existing anchors still verify. Add memo `substrate:v2:` that carries the v1 hour root and count plus `heads_root`, a Merkle root over per-graph head records sorted by graph id. Options considered: (a) change v1 derivation, rejected because it invalidates every anchored hour; (b) keep heads off-chain only, rejected because off-chain heads are not trusted proof; (c) chosen, a backward-compatible v2 memo. `parseMemo` accepts both versions.

**D73-02 Per-graph head record.** For each graph with events in a UTC hour, record `{graph_id, period_start, count, leaves_root, head_event_id, head_hash}` where `leaves_root` is the Merkle root of that graph's event hashes in chain order. Also store the ordered `(event_id, hash)` list in a new GreptimeDB table `graph_chain_leaves` at anchor time. The list lets the verifier name the first differing event id after a rewrite, which a head hash alone cannot do. The on-chain `heads_root` commits to every `leaves_root`, so a tampered stored list is itself detectable.

**D73-03 Verdict language.** `verifyChain` keeps its current signature. A new `compareToAnchoredHead` takes the trusted head and the stored leaves, then reports: `first_differing_event_id` for edits and rewrites; `first_missing_event_id` for deletion and tail truncation, using the stored leaf list as the expected set. A separate verdict, `stored-leaves-mismatch`, means the stored list does not match the on-chain `leaves_root`.

**D73-04 Trusted head only.** `verifyGraph` reports `trusted: true` only when the comparison runs against a v2 anchored head whose `heads_root` verified on chain. v1-only hours and unanchored hours report `trusted: false` with an explicit reason. They never fall back to a recomputed head.

**D73-05 Live steps are not run.** The code path, memo v2 and table DDL ship and are tested with the `Runner` fake and fake Greptime. No devnet transaction is sent, and no production DDL is applied. Those are operator-gated per the v1.8 milestone rules.

**D73-06 Storage pattern.** The new table follows the existing `CREATE TABLE IF NOT EXISTS` DDL pattern in `greptime.ts`. There is no PostgreSQL migration.

**D73-07 Test harness.** Criterion 1 tests use the existing fake Greptime and runner harnesses from the anchor and event tests. Real PostgreSQL is not needed, because ledger events live in GreptimeDB.

## Scope boundaries

- In: memo v2 and parser; per-graph head builder; stored leaves table and writer; `compareToAnchoredHead`; `verifyGraph` trusted verdict; tests for edit, middle deletion, tail truncation, full rewrite with recalculated `hash` and `prev`; the untrusted-v1 and unanchored cases; a documentation update to the memo contract.
- Out: live devnet sends, anchor funding, production DDL, any change to `agent_events` columns, any new event kind (Phase 17 froze the vocabulary).

## Risks

- A stored-leaves table that grows without bound. Mitigation: one row per graph-event per hour, bounded by the hour's events, and a documented retention note rather than deletion.
- A verifier that trusts stored leaves without checking `leaves_root`. Mitigation: D73-03 requires the on-chain check first.
- Memo size. v2 stays far below the Solana memo limit (`heads_root` adds 64 hex characters).

## Execution order

Serial, because each unit consumes the previous unit's output: U1 (ledger memo v2) → U2 (head builder, leaves table, anchor writer) → U3 (verifier and `verifyGraph` verdict, with criterion 1 tests) → U4 (docs). Parallel work is not safe here: U2 and U3 share the leaf record type, and STATE writes are serialized.
