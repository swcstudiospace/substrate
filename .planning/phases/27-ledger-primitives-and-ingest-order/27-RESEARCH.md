# Phase 27: Ledger primitives and ingest order - Research

**Researched:** 2026-10-08
**Domain:** GreptimeDB HTTP SQL (append-only side table, bounded reads), RFC 6962 Merkle roots, Bun workspaces, the repository's store and redaction locks
**Confidence:** HIGH. The port, the workspace wiring and every SQL statement were run, not inferred. The behaviour of production GreptimeDB v1.1.4 is MEDIUM: it rests on the vendor's versioned docs, because only v0.14.4 could be run here.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Port scope (`packages/ledger`)
- **D27-01: Port the five modules and their tests as they are.**
  - `merkle.ts`, `memo.ts`, `period.ts`, `rpc.ts` and `solana.ts`, with `merkle.test.ts`, `memo.test.ts`, `period.test.ts`, `rpc.test.ts` and `solana.test.ts`, from `acc30a8`.
  - Byte-identical where main's `tsconfig.json` (strict, `noUncheckedIndexedAccess`) accepts them. Any change needed to compile or to pass the store and redaction locks is listed in the plan's summary with its reason.
  - No new dependency: they use `Bun.CryptoHasher`, `fetch` and `node:child_process` `execFile` only.
- **D27-02: Add `packages/ledger/src/index.ts`.** `package.json` already points `main` at it, and no branch has it. It re-exports the public API of the five modules and nothing else.
- **D27-03: `chain.ts` is not ported.** Main keeps its per-session `hash`/`prev` chain. Ingest order is used for anchoring only (ARCHITECTURE Pattern 4).
- **D27-04: The ledger package stays pure.** It holds no Greptime client, names no table in SQL and reads no `GREPTIME_*` variable; store-lock rule 1 already enforces this. `rpc.ts` and `solana.ts` are ported now but get their first caller in Phase 28. Their tests pin the D-06 contract: an argv with only the keypair path, `execFile` and no shell, and memo text accepted only from memo-program instructions.
- **D27-05: `@substrate/mcp-server` depends on `@substrate/ledger` (`workspace:*`).** It imports `merkleRootHex`, `formatMemo`, `hourStart`, `hourEnd` and `isClosed` from it. It does not reimplement any of them.
- **D27-06: The memo program-ID comment keeps its `[UNVERIFIED]` status.** The comment says solana-cli 4.2.2 writes `Memo4c2p…`. Phase 28's devnet transaction is the first chance to check it.

#### Recording ingest order
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

#### The hour digest (root and memo)
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

#### The `anchors` DDL and production reconciliation
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

#### Proof and the Greptime version gap
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

### Deferred Ideas (OUT OF SCOPE)
- The hourly anchor job, `substrate-anchor.service`/`.timer`, the solana send, `anchors` writes and adopt-on-rerun (Phase 28, ANCHOR-03 and ANCHOR-04).
- Per-hour verify, and `pending`/`unverified` states (Phase 28, ANCHOR-05).
- How verify treats the D-era global-chain window (2026-09-27 to 10-01): port `verifyGlobalChain` or mark the window as a legacy segment (Phase 28).
- A repair sweep that gives an event whose ingest record failed a new record, which places it in the hour of the repair (Phase 28, if the warning ever fires).
- Recording the anchored event ids, or a digest of them, with the anchor so verify can tell "late, not anchored" from "altered" (PITFALLS 9; Phase 28's `anchors` write).
- Anchors in the evidence bundle (FEATURES E-D1).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ANCHOR-01 | An hour's events are decided by server ingest order, recorded append-only without altering `agent_events`, through typed methods that keep `store-lock.test.ts` green. | `event_ingest` DDL proven on v0.14.4 and in v1.1 docs (§Pattern 1). The insert point after the event row keeps every existing service, MCP and HTTP stub green: a prototype full-suite run broke exactly one existing test, `greptime.test.ts:293` `sql.at(-1)` (§Pitfall 1). The hour read is three flat statements, each passing `assertAppendOnly` (§Pattern 2). Store-lock line rules for `service.ts` are listed in §Pitfall 7. A prototype store-lock run with the ported package went green: 63/63 with the ledger tests. |
| ANCHOR-02 | Each closed hour gets an RFC 6962 Merkle root over its event hashes in ingest order, and the memo `substrate:v1:<period_start>:<root>:<count>`. | The five ported modules pass `bun test` (45/45) and `bunx tsc --noEmit` under main's tsconfig with zero changes. `merkleRootHex`/`formatMemo`/`MEMO_RE` are quoted verbatim below. A scratch prototype ran end to end: 4-event burst, one record per event, the same root twice, the backdated event at its ingest position, `verifyGraph` ok (§Code Examples, "Scratch proof"). |
</phase_requirements>

## Project Constraints (from AGENTS.md; there is no CLAUDE.md)

`CLAUDE.md` and `.claude/CLAUDE.md` do not exist in the worktree. `AGENTS.md` carries these directives [VERIFIED: AGENTS.md:1-13]:

- Read `.substrate/BRIEF.md` at the start of work. Substrate writes it, so never edit it by hand.
- **Draft PR only.** Open it into the default branch. Never merge, enable auto-merge, force-push or delete branches. (STATE.md's v1.3 run rules override this for shipping with `ultrathink-ship --ignore-gsd` and auto-merge after Greptile 5/5. That is the orchestrator's call, not the planner's.)
- **No secrets.** Never print, commit or echo tokens, keys or passphrases. Name environment variables only. Never write tailnet names or internal hostnames into the repo, the PR or the transcript.
- **Greptile gate.** Never claim merge-ready while any Greptile finding is open.

Run rules from STATE.md:27-33 bind this phase:
- Every live run (production service, real stores, devnet) waits for operator approval. That covers D27-17's production check and the deploy that creates `event_ingest`.
- Failures already present at HEAD are recorded, not fixed.
- Baseline: 1129 pass / 56 skip / 0 fail; `tsc` clean.

## Summary

This phase is a port plus a narrow ledger extension. There are no new external dependencies.

**The port.** The five `acc30a8` ledger modules and their tests drop in unchanged:
- In a throwaway copy, `bun test` gave 45 pass / 0 fail across 5 files, and `bunx tsc --noEmit` exited 0 under main's exact `tsconfig.json`.
- No source matches any redaction-lock detector (rules 1–4 of D18-13).
- A store-lock run over a tree holding the port gave 63/63 (store-lock plus ledger).
- The only new ledger file is `index.ts`, and a re-export list that compiles under `verbatimModuleSyntax` is given below.

**The workspace wiring** needs one `bun install`:
- Bun 1.4.0 uses the isolated linker: no root `node_modules/@substrate`, and per-package symlinks such as `packages/mcp-server/node_modules/@substrate/audit -> ../../../audit`.
- Before the install, `import … from "@substrate/ledger"` fails with `Cannot find module '@substrate/ledger'`.
- The install adds exactly one line to `bun.lock` and creates the `ledger` symlink.
- Root `scripts/*.ts` can never resolve the bare specifier. The smoke must use the relative path its other imports already use.

**The SQL.** Every candidate was run on a throwaway v0.14.4 container. The decisive findings:
1. A single `JOIN` from `event_ingest` to `agent_events` is correct but scans **all** of `agent_events`. `EXPLAIN ANALYZE` showed the `agent_events` MergeScan emitting all 8 rows when 4 matched. So it violates D27-13's "bounded by `event_ts` so Greptime can prune".
2. Inside a derived table or subquery, an epoch-integer literal fails (`Cannot infer common argument type for comparison operation Timestamp(Millisecond, None) >= Int64`). So does `WHERE … NOT IN (SELECT …)` (`No installed planner was able to convert the custom node…`).
3. Flat statements with ISO string literals work. The flat `agent_events` lookup pushes `ts >= …, ts <= …, id = … OR …` into the region scan.

So the hour read is three flat statement shapes:
1. The ingest rows in `[start, end)`.
2. A batched `IN` lookback that excludes ids with an earlier record.
3. A batched `IN` hash lookup bounded by the batch's min/max `event_ts`.

Ordering, duplicate collapse and validation happen in TypeScript, so row order from the server cannot affect the root.

**Primary recommendation:**
- Port the five modules byte-identically and add `index.ts`.
- Add the `workspace:*` dependency and commit the one-line `bun.lock` change.
- In `greptime.ts`:
  - add `IngestNotRecorded` and `INGEST_LAG_MS`;
  - add an `event_ingest` DDL, created in append mode with no fallback;
  - make the canonical `anchors` DDL and an `information_schema.columns` shape check, silent when unreadable;
  - give `insertEvent` a two-attempt ingest `INSERT` after the event `INSERT`;
  - add `hourLeaves(startMs)` built from flat statements with ISO literals.
- In `service.ts`, map `IngestNotRecorded` to `stored: true` plus a warning, and add `hourDigest`.
- Extend `greptime-smoke.ts`.
- Edit exactly one existing test line, `greptime.test.ts:293`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| RFC 6962 root, memo format/parse, UTC hour math | `packages/ledger` (pure library) | — | D27-04: no client, no SQL, no env. store-lock rule 1 enforces this. |
| Recording ingest order | API/Backend: `GreptimeClient.insertEvent` (`packages/mcp-server/src/greptime.ts`) | Database: `event_ingest` | It is the only door to `agent_events` (service.ts:586 is its only caller [VERIFIED: grep]), so every append path is covered. |
| Mapping a failed ingest record to the caller | API/Backend: `Substrate.append` (service.ts:564-593) | — | Owns `EmitResult` and the stderr reporting convention. |
| Hour membership, order, leaf lookup | API/Backend: `GreptimeClient.hourLeaves` | Database: `event_ingest`, `agent_events` | Store lock: only `greptime.ts`/`brief.ts` compose SQL (store-lock.test.ts:141). |
| Root and memo for a closed hour | API/Backend: `Substrate.hourDigest` | `packages/ledger` | Composes typed reads with pure functions, and checks closure. |
| `anchors` DDL and shape warning | API/Backend: `GreptimeClient.migrate` | Database | Boot-time warnings convention (`migrate()` returns `{ warnings }`). |
| Scratch proof | `scripts/greptime-smoke.ts` (the named store-lock exemption, store-lock.test.ts:34) | Phase 16 harness (`stores.env`) | D27-22. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Bun runtime + `bun:test` | 1.4.0 (`bun --version`), `engines.bun >=1.4.0` | Runtime, test runner, `Bun.CryptoHasher` SHA-256 | Repo standard [VERIFIED: package.json, bun --version] |
| TypeScript | 5.9.3 (installed by `bun install --frozen-lockfile`) | `bunx tsc --noEmit` gate | Repo standard [VERIFIED: install output] |
| GreptimeDB HTTP SQL API (`/v1/sql`) | production v1.1.4; scratch image `greptime/greptimedb:v0.14.4` | Ledger store | Existing `GreptimeClient.sql` [VERIFIED: greptime.ts:284-323] |
| `@substrate/ledger` (workspace) | 0.1.0 | Pure ledger primitives | Already a root workspace with `main: src/index.ts` [VERIFIED: packages/ledger/package.json] |

### Supporting
None. The ported modules import only `./*.ts`, `node:child_process`, `node:path` and Bun globals [VERIFIED: grep of the import lines in the ported files].

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Three flat statements | One `JOIN` (works on v0.14.4 with ISO literals) | No time-index pruning on `agent_events`, because the planner scans every row (EXPLAIN evidence below). It also violates D27-13. Rejected. |
| `information_schema.columns` for the shape check | `DESCRIBE "anchors"` | Both work on v0.14.4, and both headers are identical in the v1.1 docs. `information_schema` wins on two counts: the query names its own output columns, so headers are ours, and its types (`timestamp(3)`, `string`, `bigint`) match the DDL vocabulary. It is also `acc30a8`'s `columns()` precedent. It **must** filter `table_schema`. |
| ISO string timestamp literals | Epoch integers | Epoch works only at the top level and fails in subqueries on v0.14.4. ISO is what `queryEvents` already sends (greptime.ts:543-544). |

**Installation:**
```bash
# after adding "@substrate/ledger": "workspace:*" to packages/mcp-server/package.json
bun install
```

**Version verification:** no registry packages are added, so `npm view` does not apply.

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `@substrate/ledger` | workspace (`workspace:packages/ledger`, bun.lock:81) | in-repo | n/a | this repo | OK | Approved. It is local code, not a registry fetch. |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none. No external package is installed, so the legitimacy seam does not apply.

## Findings by question

### Q1. Does the port compile and pass as-is?
**Yes, with zero changes.** [VERIFIED: throwaway run in `/tmp/p27-port-check` (now deleted), main's `tsconfig.json` copied verbatim, `node_modules` symlinked read-only]
```
bun test v1.4.0 (34cbb9a40)
 45 pass
 0 fail
 105 expect() calls
Ran 45 tests across 5 files. [43.00ms]
tsc exit=0
```
- The same files plus a prototype `index.ts` and a `mcp-server` consumer gave `bunx tsc --noEmit` exit 0 over the whole repo copy.
- Sizes: merkle 49 LOC (+72 test), memo 47 (+70), period 33 (+40), rpc 181 (+152), solana 101 (+115) [VERIFIED: wc].
- The tests have no side effects beyond running `/bin/echo` twice (solana.test.ts:109-114). `rpc.test.ts` injects `fetchImpl` and `sleep`.
- `chain.ts` lives at `acc30a8:packages/mcp-server/src/chain.ts`, not under `packages/ledger`. There is nothing to exclude from the ledger directory [VERIFIED: `git ls-tree -r acc30a8 | grep chain`].
- **D27-06 nuance:** the program-ID comment is `/** Memo v4 (what solana-cli 4.2.2 writes), v3 and v1; readers accept any of them. */` (acc30a8 memo.ts:11). It carries no `[UNVERIFIED]` marker in the source. Keep the port byte-identical and record the unverified status in the SUMMARY/VERIFICATION. Editing the comment would break D27-01's byte-identity.
- Port and verification commands:
  ```bash
  for f in merkle memo period rpc solana; do
    git show acc30a8:packages/ledger/src/$f.ts > packages/ledger/src/$f.ts
    git show acc30a8:packages/ledger/src/$f.test.ts > packages/ledger/src/$f.test.ts
  done
  for f in merkle memo period rpc solana; do for s in "" .test; do
    cmp <(git show acc30a8:packages/ledger/src/$f$s.ts) packages/ledger/src/$f$s.ts; done; done
  ```

### Q2. Greptime SQL
Tested on `greptime/greptimedb:v0.14.4` (`SELECT version()` → `0.14.4`). The container was `p27-research-greptime`, bound to `127.0.0.1` on an ephemeral port with tmpfs data and `--pull never`, and was removed afterwards. All statements below were run there [VERIFIED].

**DDL:**
```sql
CREATE TABLE IF NOT EXISTS "event_ingest" ("ingested_at" TIMESTAMP TIME INDEX, "event_id" STRING, "event_ts" TIMESTAMP, "graph_id" STRING) WITH ('append_mode' = 'true')
```
Server echo from `SHOW CREATE TABLE "event_ingest"`: `"ingested_at" TIMESTAMP(3) NOT NULL, "event_id" STRING NULL, "event_ts" TIMESTAMP(3) NULL, "graph_id" STRING NULL, TIME INDEX ("ingested_at") … ENGINE=mito WITH( append_mode = 'true' )`.

**Why append_mode is not optional here.** Without it a no-PK table **deduplicates on the time index alone**:
- `INSERT … ('2026-10-08T10:00:00.000Z','a'),('2026-10-08T10:00:00.000Z','b')` into a no-PK, non-append table read back `[["b"]]`.
- With append_mode, an exact duplicate ingest row survived (8 rows inserted, `COUNT(*)` = 8).

So `migrate()` must **not** fall back to a plain `CREATE` for `event_ingest`, as it does for `agent_events` (greptime.ts:383-388). Two events ingested in the same millisecond would lose a record. The v1.1/latest docs show this exact no-PK append-only form ("Create an append-only table which disables deduplication. `CREATE TABLE IF NOT EXISTS temperatures (ts TIMESTAMP TIME INDEX, temperature DOUBLE DEFAULT 10,) with ('append_mode' = 'true')`") and state that `append_mode` defaults to `'false'`, "which removes duplicate rows by primary keys and timestamps according to the merge_mode" [CITED: docs.greptime.com/reference/sql/create/].

**The canonical `anchors` DDL:**
```sql
CREATE TABLE IF NOT EXISTS "anchors" ("period_start" TIMESTAMP TIME INDEX, "period_end" TIMESTAMP, "root" STRING, "event_count" BIGINT, "memo" STRING, "tx_sig" STRING, "signer" STRING, "cluster" STRING, "slot" BIGINT, "anchored_at" TIMESTAMP, "stale_hashes" BIGINT)
```
This is the same column list and order as acc30a8 greptime.ts:209-221 [VERIFIED: git show].
- Last-write-wins on `period_start` (D27-20) [VERIFIED]: two inserts with the same `period_start` and roots `r1`, `r2` read back `[[1791453600000,"r2"]]`.
- `CREATE TABLE IF NOT EXISTS` with the old 5-column shape against the 11-column table is a no-op. `information_schema` still reported 11 columns.

**Timestamp literals** [VERIFIED]:
- At the top level, `"ingested_at" >= '2026-10-08T10:00:00.000Z'`, `>= 1791453600000` and `>= '2026-10-08 10:00:00'` all work.
- In a derived table, subquery or JOIN, epoch integers fail with `Cannot infer common argument type for comparison operation Timestamp(Millisecond, None) >= Int64`. ISO literals work there.
- `CAST(1791453600000 AS TIMESTAMP(3))` works everywhere.
- **Use ISO via `this.q(new Date(ms).toISOString())`**, the existing `queryEvents` style.
- `TIMESTAMP` values come back as **integer epoch ms** (e.g. `1791453600200`). Parse them with `Number(row.ingested_at)`.

**The hour read.** Fixture: e1, e2 first ingested 10:05:00.010 (a tie); e1 also has an exact duplicate row; e3 has a backdated `ts` of 2026-09-01 and was ingested 10:10; e4 was ingested 09:59:59.5 and again at 10:00:00.2; e5 at 10:30:00.1 and again at 10:30:05.1. Expected members of 10:00Z: e1, e2, e3, e5.

| Form | Result on v0.14.4 |
|---|---|
| (a) `SELECT "event_id","ingested_at","event_ts" FROM "event_ingest" WHERE "ingested_at" >= '…10:00…' AND "ingested_at" < '…11:00…'` | 7 rows including duplicates. Collapse happens in TS. ✓ |
| (a′) the same with `GROUP BY "event_id"`, `MIN("ingested_at")` | `e4, e1, e2, e3, e5` ✓ (grouping in SQL also works) |
| (b) `SELECT DISTINCT "event_id" FROM "event_ingest" WHERE "ingested_at" < '…10:00…' AND "event_id" IN ('e1','e4')` | `[["e4"]]` ✓. The bounded lookback (`>= start−1h`) also works, with ISO and with top-level epoch. |
| (c) `SELECT "id","hash" FROM "agent_events" WHERE "ts" >= <min event_ts> AND "ts" <= <max event_ts> AND "id" IN (…)` | 4 rows ✓. `EXPLAIN ANALYZE VERBOSE`: `UnorderedScan … projection=["id", "hash"], filters=[ts >= TimestampMillisecond(1791453600000, None), ts <= TimestampMillisecond(1791455400000, None), id = Utf8("e1") OR id = Utf8("e2") OR id = Utf8("e5")]`. Pruned. |
| (d) A single JOIN: derived members `LEFT JOIN "agent_events" e ON e."id" = m."event_id" AND e."ts" = m."ets"`, outer `WHERE m."event_id" NOT IN (lookback subquery)` | Correct rows (e1, e2, e3, e5) **with ISO literals only**. But the `agent_events` MergeScan reported `output_rows: 8` with 8 rows in the table and 4 matching. That is a full scan with no pruning. ✗ for D27-13 |
| (e) `WHERE … AND "event_id" NOT IN (SELECT "event_id" FROM "event_ingest" WHERE …) GROUP BY …` | `Error during planning: No installed planner was able to convert the custom node to an execution plan: MergeScanLogicalPlan …` ✗ |
| (c) with 500 ids in `IN` | HTTP 200 in 0.02 s; the id list is about 19.5 KB ✓ |

**Decision: use forms (a), (b) and (c).** That is 1 + ⌈n/500⌉ + ⌈n/500⌉ statements per hour. Each is a single flat `SELECT`, so `assertAppendOnly` passes (`select` is in `APPEND_ONLY_VERBS`, greptime.ts:197).

**Lookback bound for (b).** D27-10's literal wording is "an event that also has a record before H's start". The unbounded `"ingested_at" < start` works as a flat statement [VERIFIED]. It is also robust to a later writer, such as Phase 28's deferred repair sweep, adding a record hours after an ambiguous double failure. Recommend the literal unbounded form. See Open Question 1 for the cost trade-off.

**Shape-check reads** [VERIFIED]:
- `DESCRIBE "anchors"` and `DESCRIBE TABLE "anchors"` give headers `Column, Type, Key, Null, Default, Semantic Type` and types `TimestampMillisecond`, `String`, `Int64`. The v1.1 docs show the same headers and types [CITED: docs.greptime.com/1.1/reference/sql/describe_table/].
- `SELECT "column_name","data_type","semantic_type" FROM "information_schema"."columns" WHERE "table_schema" = '<db>' AND "table_name" = 'anchors' ORDER BY "ordinal_position"` gives `period_start timestamp(3) TIMESTAMP`, `period_end timestamp(3) FIELD`, `root string FIELD`, … `stale_hashes bigint FIELD`. The v1.1 docs show `data_type: timestamp(3)` / `string` and `semantic_type` TAG/FIELD/TIMESTAMP [CITED: docs.greptime.com/1.1/reference/sql/information-schema/columns/].
- **Without the `table_schema` filter**, `information_schema.columns` returns the same-named table from **every database**. Querying from db `p27old` returned 5 `p27old` rows plus 11 `public` rows. The old shape built in `p27old` reported `root string TAG`.
- `SHOW TABLES` header: `Tables`.

**The gap to production v1.1.4.**
- Nothing here ran on v1.1.4.
- The no-PK `append_mode` table form, the DESCRIBE headers and the `information_schema.columns` columns and type spellings are confirmed for 1.1 by the vendor docs only.
- The two v0.14.4 planner failures in forms (d) and (e) are avoided by construction. Forms (a)–(c) use only flat filters that main's existing `queryEvents` (`"ts" >= '<ISO>'`) and `commitEventsNaming` already send.
- `event_ingest` first meets v1.1.4 at the approved post-merge restart (D27-23).

### Q3. How Bun resolves `@substrate/ledger`
[VERIFIED: throwaway `git archive HEAD` copy in `/tmp/p27-resolve`, now deleted]
- Bun 1.4.0 uses isolated installs. There is no `node_modules/@substrate` at the root. Each workspace gets symlinks, e.g. `packages/mcp-server/node_modules/@substrate/observability -> ../../../observability`.
- Before the dependency is added: `error: Cannot find module '@substrate/ledger' from '…/packages/mcp-server/src/ledger-probe.test.ts'`.
- After adding the dependency and running `bun install`:
  - the symlink `ledger -> ../../../ledger` appears;
  - the probe test passes (1 pass, 3 expect);
  - `bun.lock` changes by exactly one line: `>         "@substrate/ledger": "workspace:*",` under `"packages/mcp-server".dependencies`. The `"@substrate/ledger": ["@substrate/ledger@workspace:packages/ledger"]` entry already exists (bun.lock:81).
- `bun install --frozen-lockfile` reported "no changes" right after the `package.json` edit, so do not rely on it to catch a missing lock update. Commit the one-line `bun.lock` diff. There is no CI workflow in the repo (`.github/workflows` is absent).
- **Root scripts cannot resolve the bare specifier.** A probe at `scripts/*.ts` importing `@substrate/ledger` failed with `Cannot find module` even after the install, because the root package does not depend on it. `scripts/greptime-smoke.ts` already imports relatively (`../packages/mcp-server/src/...`, lines 33-37). Import `../packages/ledger/src/index.ts` there, or use only `Substrate.hourDigest`'s output.
- The existing pattern for consumers is `import { auditMode } from "@substrate/audit"` (server.ts:27) and `import { decideClaim, type ClaimDecision } from "@substrate/audit"` (service.ts:8) [VERIFIED: grep].

### Q4. Insertion point, error mapping, stubs affected
- **Insertion:** in `GreptimeClient.insertEvent` (greptime.ts:467-488), directly after `await this.sql(\`INSERT INTO "agent_events" (${EVENT_COLUMN_LIST}) VALUES (${values})\`)` at greptime.ts:487. The backslash refusal (:473-482) already ran, so the ingest values are quoted in the known dialect.
- **Mapping:** in `Substrate.append` (service.ts:585-592), inside the existing `catch`, test `cause instanceof IngestNotRecorded` **before** the generic `stored: false` path. `IngestNotRecorded` extends `GreptimeError`, so ordering matters. Return `stored: true` with `warning`, combining with `DEDUP_WARNING` when `appendOnly !== true`, because there is a single `warning?: string` (service.ts:237).
- **Why `stored: true` matters beyond the caller:** claims are withdrawn when their event is not stored (service.ts:873-969), and handoff releases a lease only if `result.stored` (service.ts:1222-1226). An ingest failure mapped to `stored: false` would wrongly withdraw a lock whose event row exists.
- **Stubs affected** [VERIFIED: grep and a prototype full-suite run]. Structural `insertEvent` stubs exist in:
  - `service.test.ts`: 10 (lines 50, 241, 421, 601, 670, 707, 814, 898, 943, 1351);
  - `mcp.test.ts`: 2 (28, 91);
  - `server.test.ts`: 2 (62, 125);
  - `authority.test.ts`: 1 (157);
  - `graph-bind.test.ts`: 1 (126);
  - `server.authority.test.ts`: 1 (81).

  That is **17 stubs, all unaffected**. They resolve `void` or throw generic errors, and `append`'s behaviour for those is unchanged.
- **The one existing test that must change:** `greptime.test.ts:288-294`, "a non-escaping server stores a backslash verbatim", asserts `expect(sql.at(-1)).toContain("'C:\\new'")`. The ingest `INSERT` is now the last statement. Change that line to `expect(insertStatement(sql)).toContain("'C:\\new'")`, using the file's existing helper at :54. The prototype full run gave `1174 pass / 56 skip / 1 fail`, and that was the only failure. 1174 = baseline 1129 + 45 ledger + 1 probe − 1.

### Q5. The `greptime.test.ts` idioms
- `stubFetch(responder)` (:64-74) records every statement in `sql: string[]` and answers per statement. The default reply answers the dialect probe with `records(["n"], [[3]])` and everything else with `affected` (:49-51).
- **Multiple statements:**
  ```ts
  const inserts = sql.filter((s) => s.startsWith("INSERT INTO"));
  expect(inserts.map((s) => s.slice(0, 26))).toEqual(['INSERT INTO "agent_events"', 'INSERT INTO "event_ingest"']);
  ```
- **Retry:** have the responder count `INSERT INTO "event_ingest"` calls and return `new Response("nope", { status: 500 })` for the first N. Then assert:
  - one event `INSERT` and two ingest `INSERT`s;
  - `rejects.toBeInstanceOf(IngestNotRecorded)` when both fail;
  - resolution when only the first fails.
- **migrate:** existing tests assert positionally: `sql[0]` contains the append-mode `agent_events` CREATE (:320-321), and the fallback test expects `sql[1]` to be the plain `agent_events` CREATE (:372-373). So emit `event_ingest`/`anchors` DDL **after** the `agent_events` block.
  - Stubs match **any** `SHOW CREATE TABLE` (:303, :311, :329, :342, :353, :367) and answer with the `agent_events` DDL. The shape check must therefore not use `SHOW CREATE TABLE`.
  - The fallback stub errors on **every** statement containing both `append_mode` and `CREATE` (:364-366), so the `event_ingest` CREATE must be in its own `try/catch` that pushes a warning.
  - Exact-warning assertions (:319 `toEqual([])`, :336 `toHaveLength(1)`, :345 `toEqual([...])`, :358 `toHaveLength(1)`) require the shape check to be **silent** when its read returns no rows or fails (the stub returns `affected`, so `sql()` returns `[]`).
  - These constraints were met by the prototype: all migrate tests stayed green.
- **Hour read stubs:** keep the three statement shapes distinguishable by substring:
  - `FROM "event_ingest"` without `DISTINCT` for the member read;
  - `SELECT DISTINCT` for the lookback;
  - `FROM "agent_events"` for hashes.

  Feed shuffled `rows` to prove the order comes from TS, not from the server.
- **stderr assertions** (the late-record warning and the append warning line): `spyOn(process.stderr, "write").mockImplementation(() => true)`, then `spy.mock.calls`, then `spy.mockRestore()`. This works in bun:test 1.4.0 [VERIFIED: throwaway test]. No in-process stderr idiom exists in these test files yet.

### Q6. Extending `scripts/greptime-smoke.ts`
- Conventions to keep [VERIFIED: greptime-smoke.ts:44-57, 78-107, 231-238]:
  - `check(ok, what, detail?)` prints `  ok  `/` FAIL ` lines;
  - exit 2 when `GREPTIME_URL` is unset or no client is built;
  - exit 1 when migrate fails or the table is not append-only;
  - a final `N/M checks passed`, then `process.exit(failed.length === 0 ? 0 : 1)`;
  - prints the host and database only.
- Insert the new section after "4. the chain verifies" (:150-152) or before "6." (:216), as "5b"/"7".
- How `stores.env` feeds it [VERIFIED: rehearsal.ts:975-978, rehearsal-env.ts:23-28, 188-190, docs/rehearsal.md:24-34]:
  - `rehearsal up` writes `${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/<name>/stores.env` (0600) as `export KEY='value'` lines.
  - It carries `GREPTIME_URL`/`USER`/`PASSWORD`/`DB` for the scratch container, plus the scratch Postgres values.
  - `loadConfig()` reads those, and the smoke builds `Substrate(config, { index: null })`.
  - Run:
    ```sh
    bun run rehearsal up --name p27
    set -a; . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/p27/stores.env"; set +a
    bun run smoke:greptime
    bun run rehearsal down --name p27
    ```
  - Run it from the worktree. Bun autoloads `.env*` from the cwd, and the worktree holds only `.env.example` [VERIFIED: ls].
- The twin started by `rehearsal up` runs **this checkout's** server, which migrates the same scratch db at boot. `event_ingest` and the canonical `anchors` already exist when the smoke runs, and the smoke's own `migrate` is a no-op. A twin built from a pre-Phase-27 checkout would leave a 5-column `anchors`, and the smoke would print a shape note.
- **D27-22 step 4 cannot hold literally.** "`event_count` equals the burst" is false whenever anything else ingested in the same hour: the smoke's own section-2 chain (3 events, :110-128), an earlier smoke run that hour, or `rehearsal smoke`. Assert instead:
  - every burst id is a member;
  - burst ids keep their emitted relative order;
  - `event_count === event_ids.length`, matching a raw distinct-first-record count for that hour taken by the smoke (which may send SQL).

  The burst can also straddle an hour boundary. Digest every hour its ingest records touch and assert that the union of members covers the burst.
- A raw `greptime.sql` read of `event_ingest` from the smoke is allowed. The smoke is the named exemption, and store-lock's SQL rule scans only `packages/mcp-server/src/*.ts` (:143-156). That covers "exactly one record per event" (`SELECT "event_id", COUNT(*) AS "n" FROM "event_ingest" WHERE "event_id" IN (…) GROUP BY "event_id"`, proven on scratch).

### Q7. Store-lock and redact-lock impact, file by file
| File | Store-lock rules that apply | Redact-lock (D18-13 rules 1–4) | Verdict |
|---|---|---|---|
| `packages/ledger/src/{merkle,memo,period,rpc,solana}.ts` | Rule 1: no `greptime` import, no `agent_events` in SQL, no `GREPTIME_` (:108-130). None present [VERIFIED: grep] | No redact import or definition, no `[REDACTED`, no detector prefix in any regex literal (scan for `PRIVATE KEY`, `tskey-`, `lin_api_`, `gh[pousr]_`, `sk-`, `AKIA`, `AIza`, `xoxb-`, `npm_`, `glpat-`, `dop_v1_`, `[pr]k-`, `redact`: zero hits) | Green. A store-lock run over a tree with the port: 63/63 with the ledger tests |
| `packages/ledger/src/*.test.ts` | as above | excluded by D18-13 scope | Green |
| `packages/ledger/src/index.ts` (new) | re-exports only | none | Green |
| `packages/mcp-server/src/greptime.ts` | In `MAY_SEND_SQL` (:141). Inside `LEDGER_PACKAGE` | Must not define `redact*`/`*Redactor`/`scan*Secret*` names | Green |
| `packages/mcp-server/src/service.ts` | (:150-153) must not contain both `greptime` and `.sql(`. (:163-170) **no line** matching `\b(?:sql|statement)\s*:` or `\bSELECT\s` (case-insensitive), **comments included** | Already imports `redact` from `./redact.ts` | Green **if** hourDigest prose avoids the word "select" followed by whitespace |
| `scripts/greptime-smoke.ts` | Named exemption (:34) | `` `ghp_${…}` `` decoy already sanctioned (D18-13 rule 4 note) | Green |
| `packages/mcp-server/package.json`, `bun.lock` | Config scan for `mcpServers` with greptime (:226-247): n/a | n/a | Green |
| `docs/greptime-ledger.md`, `README.md` | Credential scan (:268-278): name no Railway host or credential | n/a | Green if no host is written |

- **Watch item, not a trip today.** SUMMARY.md proposed a future rule "`SOLANA_*` only in the anchor module". Phase 18 did **not** adopt it (`grep SOLANA` in the 18 directory: no hits). `solana.ts` exports the constant `SOLANA_CLI_DEFAULT`, which a naive `/SOLANA_[A-Z_]+/` env-read rule would flag. Whoever adds such a rule must scope it to `process.env`/`Bun.env` reads.
- **Redaction note for Phase 28.** `parseSignature` and `RpcError` quote up to 200 characters of untrusted output in error messages (solana.ts:70-83, rpc.ts:111-127). Nothing calls them in Phase 27. When Phase 28 stores those messages, they must pass through `redact()`.

## Architecture Patterns

### System Architecture Diagram
```
 caller (emit / handoff / claim / bind …)
        │ EventInput
        ▼
 Substrate.append ── normalizeEvent (id = evt_<hex>, ts = collector or now, hash/prev)
        │
        ▼
 GreptimeClient.insertEvent
   ├─(1) INSERT INTO "agent_events" … ──fail──► throw GreptimeError ─► append: stored:false (unchanged)
   └─(2) ingested_at = clock(); INSERT INTO "event_ingest" (ingested_at,event_id,event_ts,graph_id)
          ├─ ok ─► if clock() ≥ hourEnd(hourStart(ingested_at)) + INGEST_LAG_MS → stderr "late" warning
          └─ fail ─► retry once (new stamp) ─fail─► throw IngestNotRecorded
                                                     └► append: stored:true + warning + stderr line

 Phase 28 / tests / smoke
        │ periodStartMs, now
        ▼
 Substrate.hourDigest ── whole-hour? closed (isClosed(start, now, INGEST_LAG_MS))? else throw
        ▼
 GreptimeClient.hourLeaves(start)
   (a) event_ingest rows in [start, start+1h)          ─► TS: first record per id (min ingested_at)
   (b) per ≤500 ids: DISTINCT event_id with a record < start ─► drop those ids
       TS: sort by (ingested_at, event_id) code-unit order = positions
   (c) per ≤500 members: agent_events id,hash WHERE ts∈[min,max event_ts] AND id IN (…)
       TS: every member has exactly one hash, 64 lowercase hex, else throw naming the event
        ▼
 merkleRootHex(hashes) ─► formatMemo({periodStartMs, rootHex, count})
        ▼
 { period_start, period_end, event_count, root|null, memo|null, event_ids }
```

### Recommended Project Structure
```
packages/ledger/src/
├── index.ts            # NEW: re-exports only (D27-02)
├── merkle.ts(+test)    # byte-identical port
├── memo.ts(+test)
├── period.ts(+test)
├── rpc.ts(+test)
└── solana.ts(+test)
packages/mcp-server/
├── package.json        # + "@substrate/ledger": "workspace:*"
└── src/
    ├── greptime.ts     # IngestNotRecorded, INGEST_LAG_MS, DDL, shape check, ingest write, hourLeaves
    ├── greptime.test.ts
    ├── service.ts      # append mapping, hourDigest
    └── service.test.ts
scripts/greptime-smoke.ts   # new section
docs/greptime-ledger.md     # Schema: event_ingest, canonical anchors, D-era column, dedup note, version gap
README.md:73                # "packages/ledger/  Greptime writer, Merkle anchor": now wrong; ledger is pure
bun.lock                    # one line
```

### Pattern 1: Record ingest order beside the event, never un-store
**What:** the second statement in `insertEvent`, two attempts, each with a fresh stamp.
**When to use:** every `agent_events` insert. It is the only door.
**Example:** see Code Examples, "insertEvent".

### Pattern 2: Flat, prunable statements; determinism in TypeScript
**What:** the server returns rows. The client picks the first record per id, applies the lookback exclusion, sorts by `(ingested_at, event_id)` and validates hashes.
**Why:** row order from Greptime is arbitrary for ties (docs/greptime-ledger.md:177-181). Flat statements avoid the v0.14.4 planner failures and keep time-index pruning.

### Pattern 3: Shape warnings that are silent when unanswerable
**What:** `migrate()` compares the live `anchors` columns with the canonical list. It warns only on a definite mismatch, and an empty or failed read is silent.
**Why:** it matches `migrate`'s "warn, don't fail" convention, and it is required for the existing exact-warning tests (Q5).

### Anti-Patterns to Avoid
- **A single JOIN to `agent_events`:** a full scan, every hour, forever (EXPLAIN evidence).
- **Subqueries with epoch literals or `NOT IN (SELECT …)` in `WHERE`:** planner errors on v0.14.4.
- **A plain-CREATE fallback for `event_ingest`:** silent loss of same-millisecond records.
- **`SHOW CREATE TABLE` for the anchors check:** it collides with every migrate test stub.
- **`localeCompare` for the `event_id` tiebreak:** locale-dependent ordering. Use `<`/`>` code-unit comparison.
- **Sorting by `ts`:** PITFALLS 9 itself.
- **Porting acc30a8's `DROP TABLE "anchors"` path** (acc30a8 greptime.ts:~195-207): D27-19 forbids it, and `assertAppendOnly` refuses `drop` anyway.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Merkle root | a new tree or a "sort and hash" scheme | `merkleRootHex` (acc30a8 merkle.ts:44-49) | RFC 6962 leaf/node prefixes; Trillian/CT vectors in merkle.test.ts |
| Memo text | string concatenation | `formatMemo` / `MEMO_RE` (memo.ts:9, 22-29) | Validates the whole hour, 64-hex root and count ≥ 1 |
| Hour boundaries | `Math.floor` inline everywhere | `hourStart`, `hourEnd`, `isClosed` (period.ts:9-26) | Half-open UTC hours, one definition (D27-05) |
| SQL literals | template interpolation | `this.q(...)` / `quote` (greptime.ts:226-231, 273-275) | Dialect-aware escaping. Greptime has no bind parameters |
| Statement safety | ad-hoc checks | `GreptimeClient.sql` → `assertAppendOnly` (greptime.ts:200-214) | Already enforces verbs and single statements |
| Column introspection | parsing `SHOW CREATE TABLE` text | `information_schema.columns` with explicit columns plus a `table_schema` filter | Headers we control; acc30a8 `columns()` precedent (greptime.ts:225-230 there) |

**Key insight:** every deterministic decision belongs in TypeScript, on rows the server only filters. The server's job is pruning, not ordering.

## Runtime State Inventory

The phase adds schema and changes no names, so this is recorded for the deploy rather than for a rename.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Production `agent_events` rows from before deploy get no ingest record and belong to no hour (D27-12). D-era `agent_events.ingested_at` (`FIELD timestamp(3)`) stays NULL for main-era rows (06-05-SUMMARY:13, 64) | None: no backfill by decision. Document it in `docs/greptime-ledger.md` |
| Live service config | Production `anchors`: 11 columns, 0 TAG, 0 rows per 06-05-SUMMARY:65 [UNVERIFIED against live] | Operator-approved read-only `SHOW TABLES` / `SHOW CREATE TABLE "anchors"` / `DESCRIBE "anchors"` (D27-17), or proceed under D27-18 |
| OS-registered state | None. No unit changes in this phase (timer is Phase 28) | None |
| Secrets/env vars | None added. The smoke reads `GREPTIME_*` from the sourced `stores.env` | None |
| Build artifacts | `packages/mcp-server/node_modules/@substrate/ledger` symlink (untracked) appears only after `bun install`. The production checkout needs `bun install` at deploy, or the server fails to boot with `Cannot find module '@substrate/ledger'` | Add "run `bun install`" to the deploy note in the PR/SUMMARY |

## Common Pitfalls

### Pitfall 1: The last-statement assertion
**What goes wrong:** `greptime.test.ts:293` `sql.at(-1)` now sees the ingest `INSERT`.
**How to avoid:** switch to `insertStatement(sql)`. It is the only existing test edit (verified by a full-suite prototype run).

### Pitfall 2: migrate statement order and the append_mode stub
**What goes wrong:** putting the `event_ingest` CREATE first shifts `sql[0]`/`sql[1]`. An uncaught `event_ingest` failure rejects `migrate()` in the fallback test (:362-375).
**How to avoid:** order the statements as `agent_events` (with its fallback), then `event_ingest` in a `try/catch` that pushes a warning, then `anchors`, then the shape check, probe and append-mode check.

### Pitfall 3: A shape check that speaks when it should not
**What goes wrong:** using `SHOW CREATE TABLE "anchors"` (stubs reply with the `agent_events` DDL), or warning on an empty read, breaks four exact-warning tests.
**How to avoid:** use `information_schema.columns` and stay silent on `[]` or an error.

### Pitfall 4: Epoch literals and subqueries on v0.14.4
**What goes wrong:** `Timestamp(Millisecond, None) >= Int64` planning errors, or `No installed planner…`.
**How to avoid:** use flat statements with ISO literals only.

### Pitfall 5: Integers back, not ISO
**What goes wrong:** treating `row.ingested_at` as a string.
**How to avoid:** `Number(row.ingested_at)`. Greptime returns epoch ms (verified). The smoke comment at :187-188 records the same fact for `ts`.

### Pitfall 6: Cross-database `information_schema`
**What goes wrong:** a dev box with several databases reports merged columns.
**How to avoid:** `WHERE "table_schema" = ${this.q(this.config.db)}`.

### Pitfall 7: Store-lock line rules in `service.ts`
**What goes wrong:** a doc comment such as "reads the members with a select over…", or an object key `sql:`, fails store-lock.test.ts:163-170.
**How to avoid:** keep SQL words out of `service.ts` entirely.

### Pitfall 8: The bare specifier from `scripts/`
**What goes wrong:** `import … from "@substrate/ledger"` in the smoke fails with `Cannot find module` (verified).
**How to avoid:** use the relative path, or consume `hourDigest`'s output only.

### Pitfall 9: The smoke's "equals the burst" assertion and hour straddling
**What goes wrong:** the shared hour inflates `event_count`. A burst at HH:59:59 spans two hours.
**How to avoid:** use the subset-and-order assertion, and digest each touched hour (Q6).

### Pitfall 10: Warning composition
**What goes wrong:** the ingest warning overwrites `DEDUP_WARNING`, or the reverse.
**How to avoid:** join both into the single `warning` string.

### Pitfall 11: Redaction of the new error text
**What goes wrong:** the `IngestNotRecorded` message embeds Greptime's response text (`greptime ${status}: ${text.slice(0, 500)}`, greptime.ts:302). The server may echo statement fragments.
**How to avoid:** wrap the `warning` and the stderr line in `redact(String(cause))`, as `append` does at service.ts:589.

### Pitfall 12: The late-record check needs a controllable clock
**What goes wrong:** the late-record check is untestable with a hardwired `Date.now`.
**How to avoid:** add an optional third constructor parameter (`clock: () => number = Date.now`, a DI seam). Production constructs `new GreptimeClient(config.greptime)` (service.ts:473), and tests use `new GreptimeClient(config)`. Both stay valid.

## Code Examples

### `packages/ledger/src/index.ts` (compiled clean under main's tsconfig in the throwaway copy)
```ts
export { bytesToHex, hexToBytes, merkleRoot, merkleRootHex } from "./merkle.ts";
export { formatMemo, type Memo, MEMO_PREFIX, MEMO_PROGRAM_IDS, MEMO_RE, parseMemo, stripListingPrefix } from "./memo.ts";
export { closedHours, HOUR_MS, hourEnd, hourIso, hourStart, isClosed } from "./period.ts";
export { type AddressMemo, bs58decode, type Commitment, createRpc, type Rpc, RpcError, type RpcOptions, type TransactionMemo } from "./rpc.ts";
export {
	AMOUNT_ONE_LAMPORT, AMOUNT_ZERO, execFileRunner, keygenPath, parseSignature, pubkeyArgv,
	type Runner, type RunResult, SOLANA_CLI_DEFAULT, type TransferMemoInput, transferMemoArgv,
} from "./solana.ts";
```
Every name above is a verbatim `export` of the five files [VERIFIED: read of the ported sources].

### Ported primitives the new code calls (verbatim)
```ts
// acc30a8 merkle.ts:44-49
export function merkleRootHex(hashes: readonly string[]): string {
	for (const [i, h] of hashes.entries()) {
		if (!HASH_HEX_RE.test(h)) throw new Error(`merkleRootHex: entry ${i} is not 64 lowercase hex characters`);
	}
	return bytesToHex(merkleRoot(hashes.map(hexToBytes)));
}
// acc30a8 memo.ts:9
export const MEMO_RE = /^substrate:v1:(\d{4}-\d\d-\d\dT\d\d:00:00\.000Z):([0-9a-f]{64}):([1-9]\d*)$/;
// acc30a8 period.ts:24-26
export function isClosed(hourStartMs: number, nowMs: number, lagMs: number): boolean {
	return nowMs >= hourEnd(hourStartMs) + lagMs;
}
```

### insertEvent: the ingest record (prototype shape, proven on scratch)
```ts
// greptime.ts
import { hourStart, isClosed } from "@substrate/ledger";

/** The event row is stored; its ingest record is not, so the event will not be anchored. */
export class IngestNotRecorded extends GreptimeError {
	constructor(readonly eventId: string, cause: unknown) {
		super(`event ${eventId} stored, but its ingest order was not recorded: ${String(cause)}`);
	}
}

/** How long after an hour ends before it counts as closed. Far above the 5 s write timeout. */
export const INGEST_LAG_MS = 300_000;

// constructor(private readonly config, private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
//             private readonly clock: () => number = Date.now) {}

// at the end of insertEvent, after the agent_events INSERT:
let failure: unknown;
for (let attempt = 1; attempt <= 2; attempt++) {
	const ingestedAt = this.clock();
	try {
		await this.sql(
			`INSERT INTO "event_ingest" ("ingested_at", "event_id", "event_ts", "graph_id") VALUES (` +
				`${this.q(new Date(ingestedAt).toISOString())}, ${this.q(event.id)}, ${this.q(event.ts)}, ${this.q(event.graph_id)})`,
		);
	} catch (cause) {
		failure = cause;
		continue;
	}
	const hour = hourStart(ingestedAt);
	if (isClosed(hour, this.clock(), INGEST_LAG_MS)) {
		process.stderr.write(
			`[substrate] event ${event.id} ingest record landed after hour ${new Date(hour).toISOString()} closed; ` +
				"a root computed before now would differ\n",
		);
	}
	return;
}
throw new IngestNotRecorded(event.id, failure);
```
`quote(null)` returns `NULL` (greptime.ts:227), so a null `graph_id` needs no branch.

### hourLeaves (prototype, proven on scratch)
```ts
/** One member of a closed ingest hour, in position order. */
export interface HourLeaf { event_id: string; ingested_at: number; hash: string }
const IN_BATCH = 500;

async hourLeaves(startMs: number): Promise<HourLeaf[]> {
	const at = (ms: number): string => this.q(new Date(ms).toISOString()); // ≥4 call sites
	const rows = await this.sql(
		`SELECT "event_id", "ingested_at", "event_ts" FROM "event_ingest" ` +
			`WHERE "ingested_at" >= ${at(startMs)} AND "ingested_at" < ${at(hourEnd(startMs))}`,
	);
	const first = new Map<string, { at: number; ts: number }>();
	for (const row of rows) {
		const id = String(row.event_id);
		const ingested = Number(row.ingested_at);
		const seen = first.get(id);
		if (!seen || ingested < seen.at) first.set(id, { at: ingested, ts: Number(row.event_ts) });
	}
	const ids = [...first.keys()];
	for (let i = 0; i < ids.length; i += IN_BATCH) {
		const batch = ids.slice(i, i + IN_BATCH).map((id) => this.q(id)).join(", ");
		const earlier = await this.sql(
			`SELECT DISTINCT "event_id" FROM "event_ingest" WHERE "ingested_at" < ${at(startMs)} AND "event_id" IN (${batch})`,
		);
		for (const row of earlier) first.delete(String(row.event_id));
	}
	const members = [...first]
		.map(([event_id, v]) => ({ event_id, ...v }))
		.sort((a, b) => a.at - b.at || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));
	const hashes = new Map<string, string>();
	for (let i = 0; i < members.length; i += IN_BATCH) {
		const batch = members.slice(i, i + IN_BATCH);
		const found = await this.sql(
			`SELECT "id", "hash" FROM "agent_events" WHERE "ts" >= ${at(Math.min(...batch.map((m) => m.ts)))} ` +
				`AND "ts" <= ${at(Math.max(...batch.map((m) => m.ts)))} AND "id" IN (${batch.map((m) => this.q(m.event_id)).join(", ")})`,
		);
		for (const row of found) {
			const id = String(row.id);
			const hash = String(row.hash);
			const prior = hashes.get(id);
			if (prior !== undefined && prior !== hash) throw new GreptimeError(`hour member ${id} has two stored hashes`);
			hashes.set(id, hash);
		}
	}
	return members.map(({ event_id, at: ingested_at }) => {
		const hash = hashes.get(event_id);
		if (hash === undefined) throw new GreptimeError(`hour member ${event_id} has no event row`);
		if (!/^[0-9a-f]{64}$/.test(hash)) throw new GreptimeError(`hour member ${event_id} has a hash that is not 64 lowercase hex`);
		return { event_id, ingested_at, hash };
	});
}
```

### Shape check (prototype, proven: silent on fresh db, warns on the old shape)
```ts
/** Production's period-keyed anchors, as information_schema spells the types. */
const ANCHOR_COLUMNS = "period_start timestamp(3), period_end timestamp(3), root string, event_count bigint, memo string, " +
	"tx_sig string, signer string, cluster string, slot bigint, anchored_at timestamp(3), stale_hashes bigint";

const live = await this.sql(
	`SELECT "column_name", "data_type" FROM "information_schema"."columns" ` +
		`WHERE "table_schema" = ${this.q(this.config.db)} AND "table_name" = 'anchors' ORDER BY "ordinal_position"`,
).catch(() => []);
const shape = live.map((row) => `${String(row.column_name)} ${String(row.data_type).toLowerCase()}`).join(", ");
if (live.length > 0 && shape !== ANCHOR_COLUMNS) {
	warnings.push(`anchors does not match production's period-keyed shape (live: ${shape}); see docs/greptime-ledger.md`);
}
```
Observed on the old shape, with the prototype's message: `anchors does not match the canonical shape: live [period_start timestamp, period_end timestamp, root string, tx_sig string, event_count bigint]`. The v0.14.4 and v1.1 `data_type` spellings are `timestamp(3)`, `string` and `bigint` [VERIFIED v0.14.4; CITED v1.1 docs]. Consider adding `semantic_type`, so that a `root` TAG on an otherwise matching table is also caught.

### hourDigest (service.ts: no SQL words anywhere in this file)
```ts
async hourDigest(periodStartMs: number, now = Date.now()): Promise<HourDigest> {
	if (!Number.isSafeInteger(periodStartMs) || hourStart(periodStartMs) !== periodStartMs) {
		throw new Error(`period ${periodStartMs} is not a whole UTC hour`);
	}
	const period_start = new Date(periodStartMs).toISOString();
	if (!isClosed(periodStartMs, now, INGEST_LAG_MS)) throw new Error(`hour ${period_start} is not closed yet`);
	if (!this.greptime) throw new Error("GREPTIME_URL is not set");
	const leaves = await this.greptime.hourLeaves(periodStartMs);
	const base = {
		period_start,
		period_end: new Date(hourEnd(periodStartMs)).toISOString(),
		event_count: leaves.length,
		event_ids: leaves.map((leaf) => leaf.event_id),
	};
	if (leaves.length === 0) return { ...base, root: null, memo: null };
	const root = merkleRootHex(leaves.map((leaf) => leaf.hash));
	return { ...base, root, memo: formatMemo({ periodStartMs, rootHex: root, count: leaves.length }) };
}
```

### append mapping (service.ts:585-592)
```ts
} catch (cause) {
	if (cause instanceof IngestNotRecorded) {
		const reason = redact(String(cause));
		process.stderr.write(`[substrate] event ${event.id} stored, ingest order not recorded — ${reason}\n`);
		const warnings = [INGEST_NOT_RECORDED, ...(appendOnly !== true ? [DEDUP_WARNING] : [])];
		return { event, stored: true, warning: warnings.join(" ") };
	}
	// …existing stored:false path unchanged
}
// const INGEST_NOT_RECORDED = "stored, but its ingest order was not recorded; it will not be anchored";
```

### Scratch proof (prototype output on v0.14.4, db `p27probe`)
```
migrate warnings [] idempotent true
stored [ true, true, true, true ] warnings [ null, null, null, null ]
ingest records per event [ { event_id: "evt_73a7…", n: 1 }, … ×4 ]
members 4 same root true substrate:v1:2026-10-08T23:00:00.000Z:e8e3cd46…206e:4
burst positions [ 0, 1, 2, 3 ]          # the burst's 2nd event had ts 2026-09-01 and sits at position 1
verifyGraph { ok: true, events: 4 }
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| D-era `agent_events.ingested_at` column plus a global `IngestChain` (acc30a8 06-04/06-05) | A separate append-only `event_ingest`, with the per-session chain kept | Phase 27 | No `ALTER` (refused by `assertAppendOnly`). `agent_events` is unchanged |
| acc30a8 `hourEvents` ordering `agent_events` by `ingested_at` (greptime.ts:272-276 there) | Membership and order from `event_ingest`, hashes from `agent_events` | Phase 27 | Altering an event row changes the root (D27-13) |
| acc30a8 migrate dropping an empty root-keyed `anchors` (greptime.ts:~195-207 there) | Shape warning only (D27-19) | Phase 27 | Never `DROP` |

**Deprecated/outdated:** README.md:73 describes `packages/ledger/` as "Greptime writer, Merkle anchor". After this phase it is the pure primitives, and the Greptime writer is `packages/mcp-server`. Fix the line.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | v1.1.4 accepts the flat (a)/(b)/(c) statements with ISO literals and the no-PK `append_mode` CREATE exactly as v0.14.4 does | Q2 | `event_ingest` creation fails at deploy, leaving a boot warning and every emit carrying the ingest warning, or the hour read errors. The deploy-time boot log shows it. Mitigation: the operator runs the smoke against prod only with approval. Otherwise this is first seen at deploy (D27-23) |
| A2 | Production `anchors` matches the 11-column list (06-05-SUMMARY:65) | Q2, Runtime State | A false shape warning at boot. Phase 28's writes would target a different shape. D27-17/18 cover it |
| A3 | Duplicate ingest records arise only from `insertEvent`'s single retry (and a future repair writer) | Q2 lookback | If another writer appears, the unbounded lookback still keeps D27-10 semantics. A bounded lookback would not |
| A4 | Production hour volumes keep `IN` batches and the unbounded lookback scan cheap | Q2, Open Q1 | Slower digests. Fix: bound the lookback (Open Q1) |

## Open Questions

1. **Bound the lookback statement (b) or not?**
   - What we know: both forms work on v0.14.4. Unbounded matches D27-10 literally and survives a future repair writer.
   - What's unclear: the scan cost on production `event_ingest` after months. It has 4 columns and one row per event, and the scan is filtered by `IN`.
   - Recommendation: unbounded now, with a comment naming the bound to add (e.g. `>= start − HOUR_MS`) if the digest ever gets slow. Phase 28's repair sweep must check for an existing record before writing either way.
2. **Should the shape check also compare `semantic_type`?**
   - Recommendation: yes. It catches a `root` TAG that a name/type comparison would miss. It is cheap, and `information_schema` returns it on both versions.
3. **Where `INGEST_LAG_MS` lives.**
   - Recommendation: export it from `greptime.ts`. Both `insertEvent` and `hourDigest` need it, Phase 28's job lives in mcp-server, and keeping it out of `period.ts` preserves D27-01 byte-identity. `index.ts` must stay "re-exports only" (D27-02).
4. **The smoke wording versus D27-22 step 4.** "`event_count` equals the burst" is not reliable on a shared scratch hour. Use the subset-and-order assertion (Q6). This needs no operator decision: it proves strictly more than the literal check.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Bun | tests, tsc, smoke | ✓ | 1.4.0 | — |
| Docker | Phase 16 harness | ✓ | running (containers listed) | — |
| `greptime/greptimedb` image | scratch ledger | ✓ | v0.14.4 (677 MB, local) | none: no pulls (disk) |
| `postgres:16-alpine` image | harness `up` precondition | ✓ | local | — |
| Phase 16 harness (`scripts/rehearsal.ts`, `rehearsal-env.ts`, `rehearsal` script) | D27-22 | ✗ on this base (on `/root/src/worktrees/agent-substrate-v13-phase`, HEAD 44dcee6) | — | Execution must start from a base holding Phase 16 (CONTEXT says so). Without it the smoke can still run against any loopback scratch Greptime with `GREPTIME_*` set |
| Phase 18 `redact-lock.test.ts` | D27-21 gate | ✗ on this base, and not yet on the p18 branch either (18-01 executed; the lock is in a later plan) | — | Apply the D18-13 rules by inspection (Q7). Run the real test once the base holds it |
| Disk | harness (`~2 GiB` floor) | ✓ | 20 GB free (96 % used) | — |
| Production GreptimeDB read | D27-17 | needs operator approval | v1.1.4 | D27-18 |

**Missing dependencies with no fallback:** none that block the unit work. The scratch proof needs the Phase 16 base.
**Missing dependencies with fallback:** the redact lock (inspect now, run when present). Prod check: D27-18.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `bun:test` (Bun 1.4.0) plus `bunx tsc --noEmit` (TypeScript 5.9.3) |
| Config file | none for tests. `tsconfig.json` (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) |
| Quick run command | `bun test packages/ledger packages/mcp-server/src/greptime.test.ts packages/mcp-server/src/service.test.ts packages/mcp-server/src/store-lock.test.ts` (add `packages/mcp-server/src/redact-lock.test.ts` once on base) |
| Full suite command | `bun test && bunx tsc --noEmit` |
| Scratch command | `bun run rehearsal up --name p27 && set -a && . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/p27/stores.env" && set +a && bun run smoke:greptime; bun run rehearsal down --name p27` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ANCHOR-02 | RFC 6962 vectors, memo/period/rpc/solana contracts (45 tests) | unit | `bun test packages/ledger` | ❌ Wave 0 (port) |
| ANCHOR-02 | `@substrate/ledger` resolves from mcp-server | unit/typecheck | `bunx tsc --noEmit` plus any mcp-server test importing it | ❌ (after `bun install`) |
| ANCHOR-01 | migrate creates `event_ingest` (append_mode, no PK) after `agent_events`; a failure warns, never falls back | unit | `bun test packages/mcp-server/src/greptime.test.ts -t migrate` | ✅ file, new cases |
| ANCHOR-01 | canonical 11-column `anchors` DDL; shape warning on mismatch, silent on unreadable | unit | same | ✅ file, new cases |
| ANCHOR-01 | ingest `INSERT` follows the event `INSERT`; values quoted; null `graph_id` → `NULL` | unit | `bun test …/greptime.test.ts -t insertEvent` | ✅ file, new cases, plus the edit at :293 |
| ANCHOR-01 | one retry; double failure → `IngestNotRecorded`; the event `INSERT` is sent once | unit | same | ✅ new |
| ANCHOR-01 | late-record stderr warning (injected clock) | unit | same | ✅ new |
| ANCHOR-01 | `append`: `IngestNotRecorded` → `stored: true`, warning, stderr line with the id; other errors unchanged | unit | `bun test …/service.test.ts -t append` (or the emit describe) | ✅ new |
| ANCHOR-01 | hour read: three statement shapes, ISO bounds, ≤500-id batches, lookback exclusion, duplicate collapse, `(ingested_at, event_id)` order regardless of row order | unit | `bun test …/greptime.test.ts -t hourLeaves` | ✅ new |
| ANCHOR-01 | `store-lock.test.ts` unedited and green | lock | `bun test packages/mcp-server/src/store-lock.test.ts` | ✅ |
| ANCHOR-01 | `redact-lock.test.ts` unedited and green | lock | `bun test packages/mcp-server/src/redact-lock.test.ts` | ⏳ on base after Phase 18 |
| ANCHOR-02 | `hourDigest`: refuses a non-whole hour and an open hour; empty → null root/memo; identical twice; a backdated `ts` sits in its ingest hour; one altered hash changes the root; a missing row or malformed hash fails naming the event | unit | `bun test …/service.test.ts -t hourDigest` | ✅ new |
| ANCHOR-01/02 | scratch: migrate creates both tables; one record per burst event; same root and memo twice; backdated member; chain verifies; hashes unchanged | live-isolated | scratch command above | ❌ smoke section new |

### Sampling Rate
- **Per task commit:** quick run command.
- **Per wave merge:** full suite command. Compare with baseline 1129 pass / 56 skip / 0 fail. The expected new total is +45 ledger tests plus the new cases, with 0 fail.
- **Phase gate:** full suite green, plus one scratch run whose output records the image tag `greptime/greptimedb:v0.14.4`, plus the stated v1.1.4 gap.

### Wave 0 Gaps
- [ ] `packages/ledger/src/*.ts` and `*.test.ts`: the port (D27-01)
- [ ] `packages/ledger/src/index.ts` (D27-02)
- [ ] `packages/mcp-server/package.json` dependency, `bun install`, one-line `bun.lock`
- [ ] `greptime.test.ts:293`: `sql.at(-1)` → `insertStatement(sql)`

## Security Domain

### Applicable ASVS Categories (L1)

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Unchanged. No new route, tool or CLI |
| V3 Session Management | no | — |
| V4 Access Control | no (indirect) | Store lock: typed methods only, and `service.ts` holds no SQL (store-lock.test.ts:141-171) |
| V5 Input Validation | yes | `this.q()` for every value; `periodStartMs` checked by `Number.isSafeInteger` and the whole-hour test; `Date#toISOString()` from validated numbers; hash regex before `merkleRootHex` |
| V6 Cryptography | yes | SHA-256 through `Bun.CryptoHasher` inside the RFC 6962 implementation. Never hand-roll |
| V7 Error Handling/Logging | yes | `redact(String(cause))` on new warnings and stderr lines. Messages name event ids and hours only |
| V8 Data Protection | yes | The memo is exactly `MEMO_RE`: hour, root, count. It carries no event content (PROJECT.md "roots only") |

### Known Threat Patterns for this phase

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection through ids in `IN` lists or `graph_id`/`ts` values | Tampering | Every value goes through `this.q()` (dialect-aware; greptime.ts:226-231). Ids are server-minted `evt_<32 hex>` (event.ts:140) or read back from the DB. `assertAppendOnly` refuses batches and non-read/insert verbs even if quoting failed |
| Append-only bypass (rewriting `event_ingest`/`agent_events`, dropping `anchors`) | Tampering | Only `CREATE … IF NOT EXISTS`, `INSERT` and `SELECT` are sent through `sql()`. `APPEND_ONLY_VERBS` is unchanged. No acc30a8 `DROP` path is ported |
| Silent loss of ingest records (dedup) | Repudiation/Tampering | `append_mode` with no fallback. Verified that a no-PK non-append table drops same-millisecond rows |
| Non-deterministic roots (tie order, `ts` reliance, server row order) | Tampering (false mismatch) | TS sort by `(ingested_at, event_id)` with code-unit comparison. Membership by first record. Collector `ts` is unused. Unit test with shuffled rows |
| Partial or forged roots (missing rows, malformed hashes) | Tampering | Fail closed, naming the event. Never a partial root (D27-13). Two different stored hashes for one id is an error |
| Late records changing a computed root | Repudiation | `INGEST_LAG_MS` (5 min, ≫ 5 s timeout) plus a stderr warning when a record lands after closure (D27-16) |
| Memo or log content leakage | Information disclosure | `formatMemo` admits only hour, hex and count. stderr/warning text is redacted and names ids only. The smoke prints the host and db only, never a credential (greptime-smoke.ts:68-76) |
| An operator-credentialed actor inserting fake `event_ingest` rows | Tampering | Out of client reach. Detected once an hour is anchored (Phase 28 compares the recomputed root with the chain memo). Recording anchored ids is deferred |

## Sources

### Primary (HIGH confidence)
- Worktree code, read this session: `packages/mcp-server/src/greptime.ts` (:1-642), `service.ts` (:229-266, :460-593, :873-969, :1222-1226), `greptime.test.ts` (:1-376), `service.test.ts` (:1-80, :410-440), `store-lock.test.ts` (:1-362), `event.ts` (:124-148), `scripts/greptime-smoke.ts` (all), `package.json`, `tsconfig.json`, `packages/*/package.json`, `bun.lock`, `docs/greptime-ledger.md` (:39-68, :165-200, :340-395), `AGENTS.md`.
- `git show acc30a8:packages/ledger/src/{merkle,memo,period,rpc,solana}.ts` and tests. `acc30a8:packages/mcp-server/src/greptime.ts` (:200-290). `acc30a8:.planning/phases/06-ledger/06-05-SUMMARY.md`.
- Phase 16 branch: `docs/rehearsal.md`, `scripts/rehearsal.ts` (:959-985), `packages/mcp-server/src/rehearsal-env.ts` (:15-40, :180-220).
- Phase 18 branch: `18-CONTEXT.md` (D18-09, D18-12..D18-16), `18-RESEARCH.md` rule inventory and the `DETECTOR` table.
- Empirical runs: throwaway port (45/45, tsc 0); workspace resolution before and after `bun install`; prototype full suite (1174/56/1); store-lock plus ledger (63/63); GreptimeDB v0.14.4 container statements, EXPLAIN ANALYZE, dedup and information_schema probes; the end-to-end prototype smoke.

### Secondary (MEDIUM confidence)
- docs.greptime.com/reference/sql/create/: the append-only table without a PK; `append_mode`/`merge_mode` semantics.
- docs.greptime.com/1.1/reference/sql/information-schema/columns/: `data_type` spellings and `semantic_type`.
- docs.greptime.com/1.1/reference/sql/describe_table/: DESCRIBE headers.

### Tertiary (LOW confidence)
- None relied on.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. No new dependencies; versions observed.
- Port and workspace: HIGH. Executed.
- SQL on v0.14.4: HIGH. Executed, with EXPLAIN evidence.
- SQL on v1.1.4: MEDIUM. Vendor docs only (A1).
- Test impact: HIGH. Full-suite prototype run.
- Pitfalls: HIGH. Each was reproduced or read at a line.

**Research date:** 2026-10-08
**Valid until:** 2026-11-07, or until Phase 16 or 18 merges change `greptime-smoke.ts`, `store-lock.test.ts` or `redact-lock.test.ts`.
