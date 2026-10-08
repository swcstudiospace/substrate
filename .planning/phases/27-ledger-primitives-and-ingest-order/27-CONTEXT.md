# Phase 27: Ledger primitives and ingest order - Context

**Gathered:** 2026-10-08
**Status:** Ready for planning
**Mode:** Smart discuss, auto-accepted under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"). Four recommended answers touch what the operator sees in production (a new table, the anchoring start, the emit warning, the unused D-era column). The plan uses them, and they are listed under "Open for the operator".

<domain>
## Phase Boundary

One PR on agent-substrate (ANCHOR-01, ANCHOR-02). Every closed UTC hour has exactly one deterministic Merkle root over its events, ordered by when the server ingested them, and `agent_events` stays exactly as it is.

1. **Pure libraries, ported.** `packages/ledger/src/{merkle,memo,period,rpc,solana}.ts` and their five tests come from `acc30a8` (`git show acc30a8:<path>`), plus a new `src/index.ts`. `chain.ts` is not ported: a global `IngestChain` conflicts with main's per-session `prev` chain.
2. **Ingest order, recorded beside the event.** A new append-only table records which hour each event was ingested in and its position in that hour. It is written by the ledger client's single insert path, and nothing alters `agent_events`.
3. **The hour digest.** A typed read in `packages/mcp-server` returns a closed hour's members in ingest order, and a `Substrate` method turns them into the RFC 6962 root and the memo `substrate:v1:<period_start>:<root>:<count>`. Recomputing it gives the same root and memo.
4. **The `anchors` DDL matches production.** Main's 5-column, root-keyed DDL is replaced by the production table's period-keyed shape, confirmed by an operator-approved read-only check.

**Proof (isolated, no live system):** unit tests plus one run of `bun run smoke:greptime` against the Phase 16 harness's scratch GreptimeDB. The production read-only check of `anchors` is the one live step, and it needs operator approval.

**Out of scope (Phase 28):**
- Sending the Solana memo, the hourly timer and `infra/vps` units.
- Writing or reading `anchors` rows.
- `substrate verify` / `POST /verify` per-hour checks, and how verify treats the D-era global-chain window (2026-09-27 to 10-01).
- Any repair sweep for events whose ingest record failed.

**Also out of scope:**
- Any change to `agent_events` (no `ALTER`, no new column, no change to `EVENT_COLUMNS`, `eventHash` or the event `INSERT`).
- New routes, MCP tools or CLI commands. Phase 28's anchor job and verify are the first production callers.
- New `EVENT_KINDS` or `SURFACES` (Phase 17 lock) and new redaction rules (Phase 18 owns `redact.ts`).

**Depends on code not yet on `main`:** Phase 16's harness (`scripts/rehearsal.ts`, `packages/mcp-server/src/rehearsal-env.ts`, `stores.env`) for the scratch run, and Phase 18's `redact-lock.test.ts`, which the ported files must keep green. Execution starts from a base that holds both.

</domain>

<decisions>
## Implementation Decisions

### Port scope (`packages/ledger`)
- **D27-01: Port the five modules and their tests as they are.**
  - `merkle.ts`, `memo.ts`, `period.ts`, `rpc.ts` and `solana.ts`, with `merkle.test.ts`, `memo.test.ts`, `period.test.ts`, `rpc.test.ts` and `solana.test.ts`, from `acc30a8`.
  - Byte-identical where main's `tsconfig.json` (strict, `noUncheckedIndexedAccess`) accepts them. Any change needed to compile or to pass the store and redaction locks is listed in the plan's summary with its reason.
  - No new dependency: they use `Bun.CryptoHasher`, `fetch` and `node:child_process` `execFile` only.
- **D27-02: Add `packages/ledger/src/index.ts`.** `package.json` already points `main` at it, and no branch has it. It re-exports the public API of the five modules and nothing else.
- **D27-03: `chain.ts` is not ported.** Main keeps its per-session `hash`/`prev` chain. Ingest order is used for anchoring only (ARCHITECTURE Pattern 4).
- **D27-04: The ledger package stays pure.** It holds no Greptime client, names no table in SQL and reads no `GREPTIME_*` variable; store-lock rule 1 already enforces this. `rpc.ts` and `solana.ts` are ported now but get their first caller in Phase 28. Their tests pin the D-06 contract: an argv with only the keypair path, `execFile` and no shell, and memo text accepted only from memo-program instructions.
- **D27-05: `@substrate/mcp-server` depends on `@substrate/ledger` (`workspace:*`).** It imports `merkleRootHex`, `formatMemo`, `hourStart`, `hourEnd` and `isClosed` from it. It does not reimplement any of them.
- **D27-06: The memo program-ID comment keeps its `[UNVERIFIED]` status.** The comment says solana-cli 4.2.2 writes `Memo4c2p…`. Phase 28's devnet transaction is the first chance to check it.

### Recording ingest order
- **D27-07: A new append-only table, `event_ingest`, records ingest order.** `migrate()` creates it:
  - `"ingested_at" TIMESTAMP TIME INDEX`: the substrate-mcp clock, in milliseconds like `agent_events.ts`;
  - `"event_id" STRING`;
  - `"event_ts" TIMESTAMP`: a copy of the event's `ts`, so the hash lookup can prune by time index;
  - `"graph_id" STRING`, nullable: lets Phase 28's verify find the hours a graph touches without scanning every hour.
  - It is `WITH ('append_mode' = 'true')` and has no `PRIMARY KEY`, so Greptime never deduplicates a record. It carries no copy of the event's `hash`: leaves always come from `agent_events` (D27-13).
- **D27-08: The record is written in `GreptimeClient.insertEvent`, after the event row is stored.**
  - That method is the only door to `agent_events`, so every append path (emit, handoff, claims and the rest) gets a record with no caller change. A second caller cannot forget it.
  - `ingested_at` is taken immediately before the ingest `INSERT`.
  - The event row goes first. An ingest record must never name an event that does not exist.
- **D27-09: A failed ingest record never un-stores the event.**
  - The event is already in its session chain, and retrying the emit would mint a second event with a new id.
  - `insertEvent` retries the ingest `INSERT` once. If that also fails, it throws a dedicated `GreptimeError` subclass (for example `IngestNotRecorded`) that `Substrate.append` recognises.
  - `append` then returns `stored: true` with the existing optional `warning` field ("stored, but its ingest order was not recorded; it will not be anchored") and writes one stderr line with the event id.
  - The `EmitResult` shape does not change. The many test stubs whose `insertEvent` resolves `void` keep working.
- **D27-10: Hour membership and position.**
  - An event belongs to the hour containing its **first** ingest record: the earliest `ingested_at`, with ties broken by the smaller `event_id`.
  - Its position is its rank when the hour's members are ordered by (`ingested_at`, `event_id`) ascending.
  - A duplicate record never moves or repeats an event. It can only appear if the retry follows an ambiguous timeout that had in fact landed. When reading hour H, an event that also has a record before H's start is excluded from H, and repeated records inside H collapse to the first.
  - Collector `ts` plays no part. A backdated event, such as a Grok replay, lands in the hour it was ingested.
- **D27-11: `agent_events` is untouched.**
  - `APPEND_ONLY_VERBS` and `assertAppendOnly` do not change, and nothing issues `ALTER`.
  - Production's D-era `agent_events.ingested_at` column (`FIELD timestamp(3)`, added by September's 06-05 cutover) is neither read nor written.
  - Main's `INSERT` names its columns, so that column stays NULL for main-era rows. `docs/greptime-ledger.md` records this.
- **D27-12: Coverage starts when this code first runs, with no backfill.**
  - Events stored earlier have no ingest record and belong to no hour. This covers main-era rows and the D-era window.
  - A synthesised record would claim an ingest order the server never observed.
  - The deploy hour's members are just the events recorded after the restart, and its root is well defined. Phase 28 decides which hour is the first one anchored.

### The hour digest (root and memo)
- **D27-13: Leaves are `agent_events.hash`, looked up by event id.**
  - The ingest table supplies membership and order. Each member's `hash` is read from its `agent_events` row, so altering an event row, even with a consistently recomputed hash, changes the recomputed root.
  - The read is bounded by `event_ts` so Greptime can prune by time index.
  - If a member has no event row, or a hash that is not 64 lowercase hex, the digest fails with an error naming the event. It never returns a partial root.
- **D27-14: Typed reads only, composed in `greptime.ts`.**
  - New `GreptimeClient` methods return a closed hour's members in position order, with their hashes. Indicative names: `hourMembers(startMs)`, or `hourLeaves(startMs)` if fused.
  - Whether that is one `JOIN` or an ingest read plus batched `IN` lookups (batches of at most 500 ids) is researched and proven on scratch Greptime. The statement still passes `assertAppendOnly`.
  - `store-lock.test.ts` is not edited. Only `greptime.ts` and `brief.ts` compose SQL, and no new file names `agent_events`.
- **D27-15: `Substrate.hourDigest(periodStartMs, now = Date.now())` (name at discretion).**
  - It returns `{ period_start, period_end, event_count, root, memo, event_ids }`, with ISO periods, `root = merkleRootHex(hashes in position order)` and `memo = formatMemo({ periodStartMs, rootHex, count })`.
  - It refuses an hour that is not closed (`isClosed(start, now, INGEST_LAG_MS)` is false) and any `periodStartMs` that is not a whole UTC hour.
  - An empty closed hour returns `event_count: 0`, `root: null`, `memo: null`. It is never anchored, and `merkleRoot([])` throws by design.
  - `now` is injectable so tests and the scratch smoke can close the current hour without waiting.
- **D27-16: The lag is 5 minutes (`INGEST_LAG_MS = 300_000`), September's figure.**
  - That is far above the 5 s Greptime write timeout, so a record stamped inside an hour is visible before the hour counts as closed.
  - If an ingest `INSERT` completes after its stamped hour has closed (`Date.now() >= hourEnd + lag`), `insertEvent` writes a stderr warning naming the event and the hour. A root computed before that late record landed would differ when recomputed, and the warning is how that is diagnosed.
  - Phase 28 schedules its timer around this constant.

### The `anchors` DDL and production reconciliation
- **D27-17: The canonical `anchors` DDL in `migrate()` is the production table's shape.**
  - Expected, from September's 06-05 record and `acc30a8`'s `greptime.ts`: 11 columns, no tag, `period_start TIMESTAMP TIME INDEX`, then `period_end TIMESTAMP`, `root STRING`, `event_count BIGINT`, `memo STRING`, `tx_sig STRING`, `signer STRING`, `cluster STRING`, `slot BIGINT`, `anchored_at TIMESTAMP` and `stale_hashes BIGINT`, with no `PRIMARY KEY` and no `append_mode`.
  - The exact column order, types and options are taken from an operator-approved read-only check against production: `SHOW TABLES`, `SHOW CREATE TABLE "anchors"` and `DESCRIBE "anchors"`.
  - The check runs through `GreptimeClient.sql`, whose `assertAppendOnly` admits only read verbs.
  - What is recorded is the column list, the options and the row count, never a host or credential.
  - `SHOW TABLES` also confirms that the name `event_ingest` is free.
- **D27-18: If the operator defers the check, the plan proceeds on the recorded shape.**
  - The DDL comes from the 06-05 record and `acc30a8`, and is marked `[UNVERIFIED against live]` in the summary and the verification.
  - Phase 28 must run the check before its first `anchors` write.
- **D27-19: Main's 5-column, root-keyed DDL is replaced, not kept beside the new one.**
  - `CREATE TABLE IF NOT EXISTS` stays a no-op on production.
  - `migrate()` reads the live `anchors` columns (`DESCRIBE` or `information_schema.columns`, read-only) and pushes a boot warning if they differ from the canonical list. Example: a scratch or dev store built by the old DDL.
  - It never `ALTER`s, `DROP`s or recreates the table.
- **D27-20: Phase 27 writes and reads no `anchors` rows.**
  - `stale_hashes` stays in the DDL only to match production. Phase 28 gives it a meaning or leaves it NULL.
  - `docs/greptime-ledger.md` records one property for Phase 28: with no tag and no `append_mode`, rows with the same `period_start` deduplicate (last write wins). Phase 28 therefore has to adopt an existing anchor before it writes.

### Proof and the Greptime version gap
- **D27-21: Unit proof.**
  - The ported RFC 6962 vectors and memo/period/rpc/solana tests.
  - New `greptime.test.ts` cases, using the existing stubbed-`fetch` idiom: the `event_ingest` and canonical `anchors` DDL, the record written after the event, the retry and `IngestNotRecorded`, the hour read's SQL shape, duplicate collapse and the `anchors` shape warning.
  - New `service.test.ts` cases: an emit whose ingest record fails stays `stored: true` with the warning; `hourDigest` refuses an open hour; an empty hour gives a null root; the root and memo are identical across two computations and across shuffled stub row order; a backdated `ts` lands in its ingest hour; altering one leaf hash changes the root; a missing event row fails the digest.
  - `store-lock.test.ts` and `redact-lock.test.ts` stay green unedited, and `bunx tsc --noEmit` is clean.
- **D27-22: Scratch proof extends `scripts/greptime-smoke.ts`.** It is the named store-lock exemption, so no new exemption is argued.
  - Run order: `bun run rehearsal up --name p27`, source that run's `stores.env`, then `bun run smoke:greptime`.
  - The new section:
    1. `migrate` creates `event_ingest` and the canonical `anchors` on scratch.
    2. It emits a burst that includes a backdated `ts`.
    3. Every emitted event has exactly one ingest record.
    4. `hourDigest` with `now` set past the hour's lag gives the same root and memo twice, and `event_count` equals the burst.
    5. The backdated event is a member of the ingest hour.
    6. The graph's chain still verifies and its stored hashes are unchanged.
- **D27-23: The version gap is stated in the verification.** The local harness image is GreptimeDB v0.14.4, and production runs v1.1.4.
  - The scratch run proves the statements on v0.14.4 only.
  - Statements whose behaviour may differ between the two:
    - `CREATE TABLE … WITH ('append_mode' = 'true')` without a primary key;
    - the hour read's `JOIN` or `IN` form;
    - comparing `TIMESTAMP` with an ISO or epoch literal;
    - the `DESCRIBE`/`SHOW CREATE TABLE` output columns that the shape check parses.
  - The read-only production check (D27-17) covers the `anchors` shape. `event_ingest` first meets v1.1.4 when the merged code restarts in production, which is a deploy and needs operator approval.

### Claude's Discretion
- Exact method, error-class and constant names (`hourMembers`/`hourLeaves`, `hourDigest`, `IngestNotRecorded`, `INGEST_LAG_MS`) and where the lag constant lives (`@substrate/ledger` `period.ts` or `mcp-server` config).
- Whether the hour read is one `JOIN` or batched `IN` lookups, chosen on research and the scratch run.
- How the `anchors` shape check reads columns (`DESCRIBE` or `information_schema.columns`), as long as it is read-only and tolerant of both servers' output headers.
- Plan split and wave layout.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `acc30a8:packages/ledger/src/*.ts` (411 LOC and tests): an RFC 6962 tree with Trillian/CT reference vectors, the memo v1 regex `MEMO_RE`, half-open UTC hours (`hourStart`, `hourEnd`, `isClosed`, `closedHours`), the JSON-RPC reader with a built-in base58 decoder, and the solana argv builders with an `execFile` runner.
- `packages/ledger/package.json` already exists on main (`@substrate/ledger`, `main: src/index.ts`) and is a root workspace. Only `src/` is missing.
- `acc30a8:packages/mcp-server/src/greptime.ts` :208-222 (the 11-column `anchors` DDL) and :272-284 (`hourEvents` over `ingested_at`), as reference for the SQL shape. That code ordered by an `agent_events` column, and Phase 27 orders by the ingest table instead.
- `packages/mcp-server/src/greptime.ts`: `GreptimeClient.sql` (every statement passes `assertAppendOnly`), `q()`/`quote` for literals, `migrate()` returning `{ warnings }`, `insertEvent` (:467), `appendModeEnabled` (the `SHOW CREATE TABLE` parsing idiom) and `EVENT_COLUMNS`.
- `packages/mcp-server/src/event.ts`: `eventHash`, which is SHA-256 hex over canonical JSON, so every hash is a 64-character lowercase hex leaf. Also `verifyChain` and `inChainOrder`.
- `scripts/greptime-smoke.ts`: the exempt live harness. It drives `Substrate.emit` and `GreptimeClient`, exits 2 when `GREPTIME_URL` is unset, and exits 1 on failure.
- Phase 16's harness: `bun run rehearsal up|down|status|smoke --name <n>`, `consumer.env`, and the 0600 `stores.env` meant for store-client proofs such as this one.

### Established Patterns
- Only `greptime.ts` and `brief.ts` compose SQL (`store-lock.test.ts` `MAY_SEND_SQL`). Services ask through typed methods, and callers supply values, never syntax.
- `migrate()` is idempotent and warns rather than fails. A misconfigured but reachable ledger is reported at boot and keeps serving.
- Fail closed on dedup risk: `append` refuses to write to a non-`append_mode` ledger unless the operator opts in. The new table is created `append_mode` for the same reason.
- `greptime.test.ts` stubs `fetch` and asserts on the SQL text sent. `service.test.ts` injects structural `greptime` stubs, `as never` in places.
- The doc voice is long-form rationale in comments and in `docs/greptime-ledger.md`.

### Integration Points
- `GreptimeClient.migrate()`: adds the `event_ingest` DDL, the canonical `anchors` DDL and the `anchors` shape warning.
- `GreptimeClient.insertEvent()`: writes the ingest record after the event row.
- `Substrate.append()` (`service.ts` :564-593): maps `IngestNotRecorded` to `stored: true` plus a warning.
- New `Substrate.hourDigest()`, and new `GreptimeClient` hour reads.
- `packages/mcp-server/package.json`: add `@substrate/ledger: workspace:*`.
- `docs/greptime-ledger.md`, Schema: `event_ingest`, the canonical `anchors`, the ignored D-era column, the dedup note and the version gap. Phase 18 also adds a pointer to this file, so expect a small merge to resolve.

</code_context>

<specifics>
## Specific Ideas

- Requirement wording is the contract. ANCHOR-01: "decided by server ingest order, recorded append-only without altering `agent_events`, through typed methods that keep `store-lock.test.ts` green". ANCHOR-02: "an RFC 6962 Merkle root over its event hashes in ingest order, and the memo `substrate:v1:<period_start>:<root>:<count>`".
- PITFALLS 9: anchoring on `ts` gives non-reproducible roots, because `ts` is collector-supplied, replays backdate it and same-millisecond ties are arbitrary. Every determinism test here exists to rule that out.
- Roots only, never event contents (`PROJECT.md`; build plan §11). The memo is exactly `MEMO_RE`.

</specifics>

<deferred>
## Deferred Ideas

- The hourly anchor job, `substrate-anchor.service`/`.timer`, the solana send, `anchors` writes and adopt-on-rerun (Phase 28, ANCHOR-03 and ANCHOR-04).
- Per-hour verify, and `pending`/`unverified` states (Phase 28, ANCHOR-05).
- How verify treats the D-era global-chain window (2026-09-27 to 10-01): port `verifyGlobalChain` or mark the window as a legacy segment (Phase 28).
- A repair sweep that gives an event whose ingest record failed a new record, which places it in the hour of the repair (Phase 28, if the warning ever fires).
- Recording the anchored event ids, or a digest of them, with the anchor so verify can tell "late, not anchored" from "altered" (PITFALLS 9; Phase 28's `anchors` write).
- Anchors in the evidence bundle (FEATURES E-D1).

</deferred>

## Open for the operator

Defaults the plan uses. Each can be overridden before execution.

1. **Anchoring covers events from the deploy onward, with no backfill.** Events stored before Phase 27 runs in production belong to no hour (D27-12). This covers the D-era window and main-era rows since 2026-10-01. *Why it matters:* `verify` will never show those events as anchored. *Recommendation:* accept. A backfilled record would assert an ingest order the server never saw.
2. **A new production table, `event_ingest`, is created on the first restart after merge.** It also means one extra insert per event (D27-07, D27-23). *Why it matters:* a production schema addition happens at deploy, which already needs approval under the run rules. *Recommendation:* accept, and approve the deploy window when Phase 27 ships.
3. **An emit whose ingest record fails still reports `stored: true`, with a warning** (D27-09). *Why it matters:* the caller sees a stored event that will not be anchored, rather than a failure that tempts a duplicate retry. *Recommendation:* accept.
4. **Production's September `agent_events.ingested_at` column stays unused** (D27-11). *Why it matters:* an extra nullable column stays in the live table, and its D-era values are not reused. *Recommendation:* accept, because reusing it would need an `agent_events` write path change.

**Live step needing approval:** the read-only `SHOW TABLES` / `SHOW CREATE TABLE "anchors"` / `DESCRIBE "anchors"` against production GreptimeDB (D27-17). If it is deferred, D27-18 applies.
