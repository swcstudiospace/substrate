# LightRAG cutover record (Phase 46)

This is the durable record of the docs-plane cutover to LightRAG. STATE.md Run 11 (2026-10-28) holds the full narrative; this file keeps the facts an operator needs. It names environment keys only. It records no key value, host name or internal address.

Decided by the operator: nothing in this file. Pending, each an agent default awaiting operator confirmation in the phase 46 plan: the reversal limit and rollback procedure (D4, stated below as facts), removal of the retired docs-plane client and its waivers (D6), and hybrid query mode in production (D5).

## Cutover facts

| Item | Recorded value |
|------|----------------|
| Date | 2026-10-28 (Run 11) |
| Release before | `702ed32e` (the host ran it from Oct 22; it has no LightRAG client) |
| Release after | `5cf930a0`, deployed with `deploy-release.sh release-r11-20261028` under the preflight (0 errors) |
| Docs backend | `SUBSTRATE_DOCS_BACKEND=lightrag` |
| Query mode | `SUBSTRATE_LIGHTRAG_QUERY_MODE=naive` |
| Env keys added | `LIGHTRAG_URL`, `LIGHTRAG_API_KEY` (value read from the Railway service and never printed) |
| LightRAG service | LightRAG v1.5.7, its pgvector Postgres, and a bypass endpoint that never calls a model. Chunks and embeddings are stored; no graph is built. |
| Smoke | `lightrag-smoke-run --confirm-live`: all six checks passed in naive mode |
| Plane status | `/healthz` listed the `lightrag` plane |

Naive mode is required in this state. STATE.md Run 11 records that hybrid fails the smoke query check while the bypass endpoint serves in place of a model (see `docs/docs-plane.md`).

## Reversal limits (decision D4, pending operator)

- The retired docs plane cannot be restored. LightRAG replaced RAG-backend; there is no fallback that calls the retired plane.
- The rollback procedure in the plan is app-only: redeploy release `702ed32e`, which has no LightRAG client, and restore `substrate.env` from its backup. That step does not restore the index. The `pg_dump` archive above is the only index backup.
- Whether these limits are accepted is decision D4 in the phase 46 plan, an agent default pending the operator.

## Backups taken before the cutover

- The index, as a `pg_dump -Fc` archive. Its restore was rehearsed on a throwaway Postgres first. The ledger held 32 rows, and the migration applied nothing.
- `substrate.env`, copied before any key was added.

The backup locations are not recorded in this file.

## Delta pass

The delta pass checks that the LightRAG records still match the docs state manifest. It is operator-run. Each run needs its own recorded approval, as criterion 6 requires.

1. Set `LIGHTRAG_URL` and `LIGHTRAG_API_KEY` in the operator shell, and set `SUBSTRATE_DOCS_STATE_FILE` to the manifest path.
2. Run `bun run parity:gate -- --part A`. It reads the state file and lists the plane's `corpus:` documents. It writes nothing.
3. Pass: exit 0 with zero mismatches. Record the printed counts in `.planning/STATE.md`. Do not record a host or a key.
4. Repeat after the corpus refresh timer has run, to show the records still match at HEAD.

The parity check against the frozen sample (`bun run parity:gate -- --part B`, ten read-only `/query` calls) is checkpoint C4 in the Phase 46 plan. It needs its own approval.

## Environment keys (names only)

`LIGHTRAG_URL`, `LIGHTRAG_API_KEY`, `SUBSTRATE_DOCS_BACKEND`, `SUBSTRATE_LIGHTRAG_QUERY_MODE`, `SUBSTRATE_DOCS_STATE_FILE`.
