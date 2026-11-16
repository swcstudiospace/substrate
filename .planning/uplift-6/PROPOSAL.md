# Uplift 6 — seven improvements, proposed 2026-10-14

Base: `origin/main` at `6e0dfd4` (uplift 5 merged). The operator accepted a revised set after uplift 5 had already landed the earlier idempotency, skills-registry, and ledger-freeze work. Standing rules are unchanged: a flag defaults to today's behaviour or to report-only; nothing deletes production data; no new service, replica, plan tier, or dependency; `EVENT_KINDS` 12 and `SURFACES` 27 stay closed; Greptime SQL stays in `greptime.ts` / `brief.ts`; memory tables stay in `index-store.ts` / `memory-write.ts`. Nothing in this series is deployed.

## The seven

### U6-1 — `tenant=swc` hash v2 (memory only)

`SUBSTRATE_HASH_VERSION=v1|v2`, default `v1`. `v1` is today's content and request preimage, byte for byte. `v2` adds `hv: 2` and `tenant: "swc"` inside those two hashes only. A v2 write still matches a row stored under the v1 digest, so a parked quarantine or review is not inserted again. No column, no backfill, no event-hash change: `verifyChain` recomputes from stored ledger columns, and Greptime's `CREATE TABLE IF NOT EXISTS` cannot add a discriminator to a live append-only table. Hindsight document ids are unchanged.

### U6-2 — governed-memory lifecycle report

`SUBSTRATE_MEMORY_LIFECYCLE=report|off`, default `report`. When the index sweep is already opening the store, `report` prints a second section: candidate counts and capped ids for the existing `30d` and `graph` ttl classes, plus the Hindsight bank name and `document_id` those rows already map to. No body, no subject text, no `deleteDocument`, no new HTTP API. `off` skips the read. The sweep's own deletes are unchanged and still need `SUBSTRATE_INDEX_SWEEP=apply`, `--apply`, and `SUBSTRATE_MEMORY_EXPIRY=enforce`.

### U6-3 — Redis / Dragonfly conformance and the idempotency-mirror decision

`packages/mcp-server/src/cache-conformance.test.ts` pins the closed cache key classes and the Bun Redis commands the client actually uses (`GET`, `MGET`, `SET EX`, `INCR`, `EVAL`). It pins the sentence in `docs/data-planes.md`: an idempotency mirror stays a target, not a current key. A live matrix runs only when `SUBSTRATE_CONFORMANCE_REDIS_URL` (and optionally `SUBSTRATE_CONFORMANCE_DRAGONFLY_URL`) is a loopback URL; those names are read only from the test file. No production flag and no Railway hop.

### U6-4 — guarded `migrate()`

Always on. One reserved connection takes `pg_advisory_lock` on `substrate.index.migrate`, sets `lock_timeout` and `statement_timeout` for that session only, then runs the existing DDL as versions 1–31 recorded in `schema_migrations`. A recorded version is skipped; a missing version still runs, so an index that booted before the ledger still receives later statements. Timeouts are reset before the connection returns to the pool. No flag skips migration. `schema_migrations` is not an archive table.

### U6-5 — index archive/restore drill

`SUBSTRATE_GATE_INDEX_DRILL=1` only. Unset, `gate:boot`'s check list is unchanged. When set, after `healthz` the gate archives the scratch index to a temp dir under the rehearsal run dir and restores it into a second database on the same `postgres:16` container, then drops that database. `allowRootfs` and `minFreeGb: 0` are arguments to that call, not environment. `/mnt/index-archive` is refused. The drill does not call `index-run.ts`, so it writes no ledger note.

### U6-6 — `substrate skills list` and `substrate skills approve`

CLI over the existing `GET /skills` and `POST /skills/approve`. `approve`, `decline`, and `retire` are `decision` values on the same route. No new server route, no registry change. Missing `SUBSTRATE_TOKEN` sends nothing.

### U6-7 — per-plane chaos beyond the ledger freeze

`scripts/chaos-planes.ts` pauses only the rehearsal twin's own Postgres container, asserts `/healthz` shows `planes.index.ok === false` while `POST /brief` stays 200, and always unpauses. Cache, Hindsight, and RAGFlow are skipped when the twin does not configure them. The 60s Greptime proof in `gate:boot` is unchanged. Off unless `rehearsal smoke --chaos-planes` or `SUBSTRATE_GATE_CHAOS_PLANES=1`.

## Explicitly not built

Event-hash v2 (would break `verifyChain` until the ledger can store the new preimage). Enforcement of `requires` / `blocks` / `gated_by` at claim time (ADR 0001). A Hindsight document delete. A Redis or RAGFlow container inside the default rehearsal twin.
