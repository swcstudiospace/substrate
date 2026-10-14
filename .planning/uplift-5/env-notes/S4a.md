# S4a — `.env.example` additions (orchestrator merges)

No `package.json` script lines. One new variable, read by `substrate-mcp` only (`config.ts` → `service.ts`, `server.ts`).

Insert after the `SUBSTRATE_LEDGER_*` block (next to `SUBSTRATE_LEDGER_TTL`):

```sh
# ── Idempotent event replay (U5-4a; docs/greptime-ledger.md § Idempotent replay) ──
# off (the default): POST /events ignores an event's idempotency_key and the
# x-substrate-replay header entirely — nothing stored, no lookup, today's
# responses. accept: a valid key (8-128 chars of A-Z a-z 0-9 . _ : -) is stored
# in the payload as the reserved key _ik, and a replay-marked request that
# carries a key takes ONE ledger read; a hit is 202 with "deduplicated": true and
# nothing written, a lookup error is 503 stored:false. enforce: every keyed
# request takes the read. Dedupe covers only the same surface, repo, graph_id,
# kind and ts. GET /healthz reports the mode as "idempotency"; a client must not
# replay against off. Enable accept on the server first, then any client spool.
# Anything else is off, with a boot warning. Roll back by setting off.
SUBSTRATE_EVENT_IDEMPOTENCY=off
```
