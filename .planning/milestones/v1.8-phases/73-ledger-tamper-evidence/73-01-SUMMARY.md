# 73-01 Summary: ledger tamper evidence

Units U1 to U4 are implemented. Verification: orchestrator gates run after this summary.

## Units and files

- **U1, memo v2 and heads (packages/ledger):** `memo.ts` (v2 format, `formatMemoV2`, `parseMemo` accepts v1 and v2), `heads.ts` (new: `GraphHeadRecord`, `headRecordHash`, `headsRoot`), `merkle.ts` (`sha256` exported), `index.ts` (re-exports). Tests: `memo.test.ts`, `heads.test.ts`.
- **U2, head builder, leaves table, anchor writer (packages/mcp-server):** `anchor.ts` (`buildGraphHeads`, heads read, v2 memo, leaves written before the row), `greptime.ts` (`graph_chain_leaves` DDL, `insertGraphChainLeaves`), `event.ts` (`inChainOrder` made generic). Tests: `anchor.test.ts`.
- **U3, verifier and verdict (packages/mcp-server):** `event.ts` (`compareToAnchoredHead`, `orderedLeaves`, `headRecordsFromLeaves`), `greptime.ts` (`hourChainLeaves`), `service.ts` (per-hour trust, `trusted` fields, `ok` gating, budget), `reanchor-plan.ts` (v1 or v2 memos). Tests: `service.test.ts`, `reanchor-plan.test.ts`.
- **U4, docs:** `docs/greptime-ledger.md`, `docs/corpus-proofs.md`, `docs/runbooks/devnet-reset-and-reanchor.md`, `73-01-PLAN.md`.

## Decisions as implemented

- **D73-01:** the v1 derivation is unchanged. v2 adds `heads_root` alongside the same root and count.
- **D73-02:** heads are keyed by (graph_id, session_id), not by graph. A graph-level list would depend on read order, because chains are per session. An absent session is `""`.
- **D73-03:** `compareToAnchoredHead` reports `first_differing_event_id` or `first_missing_event_id`, and `stored-leaves-mismatch` when the stored leaves do not reproduce the anchored head. Each row's content hash is recomputed, because the hour root reads the stored hash column.
- **D73-04:** `trusted` holds only against an on-chain v2 `heads_root`. Recomputed heads are never trusted. Untrusted reasons: v1 memo, unanchored hour, no events, no anchored hour, `budget exhausted`, `store-failed`.
- **D73-05:** no devnet send and no production DDL were run.
- **D73-06:** `CREATE TABLE IF NOT EXISTS` in `greptime.ts`. No PostgreSQL.
- **D73-07:** tests use the existing fake Greptime and runner harnesses.
- **`ok` semantics:** false on any contradiction with an anchored head, including a full rewrite that passes the local chain check. Unchanged for `budget exhausted` and `store-failed`, which claim no tampering.
- **Anchored-hour ordering:** the heads read happens only where a row is stored or a transaction is sent. An already-anchored hour cannot add a failure.
- **Budget split:** a read that outlasts its allowance is `budget exhausted`. A read that throws is `store-failed`.
- **Generic `inChainOrder`:** a type-only change, so ledger rows can be ordered without a duplicate row type. Members are sorted by id first, because its start and fork choice depend on input order.

## Residuals

- The leaves table has no primary key, so duplicates collapse on read rather than being prevented.
- A leaves write that fails after a send can lead to a resend on the next run. This is the same exposure `insertAnchor` has today.
- Live devnet sends and production DDL were not run.
- The leaves read is bounded to the hour but covers every graph in that hour.
- Events with no `graph_id` have no head. They stay in the hour root only.
