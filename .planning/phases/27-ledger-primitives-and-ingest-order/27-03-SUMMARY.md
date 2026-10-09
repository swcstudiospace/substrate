---
phase: 27-ledger-primitives-and-ingest-order
plan: "03"
subsystem: database
tags: [greptime, anchoring, ingest-order, merkle, hour-digest, append-only]

requires:
  - phase: 27-ledger-primitives-and-ingest-order plan 02
    provides: event_ingest records, IngestNotRecorded, INGEST_LAG_MS, canonical anchors DDL
provides:
  - GreptimeClient.hourLeaves, three flat batched reads that return a closed hour's members in position order with their event hashes
  - Substrate.append maps IngestNotRecorded to stored true plus a warning and one redacted journal line
  - Substrate.hourDigest, the deterministic RFC 6962 root and substrate:v1 memo for a closed UTC hour
affects: [27-04 (scratch proof), phase-28 (calls hourDigest per closed hour)]

actuals:
  tasks: 3
  commits: 5

key-files:
  modified:
    - packages/mcp-server/src/greptime.ts
    - packages/mcp-server/src/greptime.test.ts
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/service.test.ts

key-decisions:
  - "hourDigest takes an injectable now (default Date.now) so tests and the smoke pick the clock; an hour counts as closed exactly at its end plus INGEST_LAG_MS"
  - "Bad input (a start that is not a whole UTC hour, an hour still open) throws InvalidEventError like the other input checks; an unconfigured ledger throws the file's existing GREPTIME_URL wording, because it is an operational condition, not a caller bug"
  - "The service tests add a second layer: a real GreptimeClient subclass that overrides only sql, so shuffled server rows, a backdated event and a same-millisecond tie are proved through Substrate.hourDigest and not only through the unit that sorts"
  - "hourLeaves rejects a null, empty or non-numeric ingested_at or event_ts naming the event (epochMs helper); Number() would have turned them into 0 or NaN"

requirements-completed: [ANCHOR-01, ANCHOR-02]

coverage:
  - id: D1
    description: "hourLeaves returns members in (ingested_at, event_id) order with duplicates collapsed and earlier-hour ids excluded, whatever order the server answers in; a missing row, a malformed or doubled hash, or a non-numeric time throws naming the event"
    requirement: "ANCHOR-02"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/greptime.test.ts — hourLeaves (11 cases, three added by the review pass)"
        status: pass
    human_judgment: false
  - id: D2
    description: "append maps IngestNotRecorded to stored true plus warning (joined with the dedup caveat when the ledger may deduplicate) and a redacted journal line naming the event; every other failure stays stored false"
    requirement: "ANCHOR-01"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/service.test.ts — emit when the ingest record is not recorded (6 cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "hourDigest refuses non-whole and open hours, nulls the empty hour, matches the pure ledger functions, and is identical across calls and across shuffled server rows"
    requirement: "ANCHOR-02"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/service.test.ts — hourDigest and hourDigest over a real ledger client (12 cases); mutation-checked (ingest branch disabled: 4 fail; leaves reversed: 2 fail; lag ignored: 1 fail)"
        status: pass
    human_judgment: false

duration: ~1h
completed: 2026-10-09
status: complete
---

# Phase 27 Plan 03: Hour read, append mapping and hourDigest Summary

**A closed UTC hour now digests to one stable root and memo over its members in ingest order, and an ingest-record failure degrades to stored-with-warning instead of an un-stored event.**

## Accomplishments

- `GreptimeClient.hourLeaves(startMs)` reads through three flat statement shapes (the hour's ingest rows, an unbounded earlier-record lookback per 500 ids, the hash lookup per 500 ids bounded by the batch's `event_ts` range). TypeScript decides membership and order, so the server's row order and any write interleaving cannot move the root. Every statement passes `assertAppendOnly`.
- `Substrate.append` branches first on `IngestNotRecorded`: the event row is durable, so the caller gets `stored: true`, no `error`, and a warning that no hourly anchor will cover the event and that it must not be re-emitted. The warning is joined with the dedup caveat on a ledger that may deduplicate. One journal line (`[substrate] event <id> stored but not anchored`) is redacted, since a connection error can quote a URL.
- `Substrate.hourDigest(periodStartMs, now)` returns `{ period_start, period_end, event_count, root, memo, event_ids }`. The root and memo come from `@substrate/ledger` (`merkleRootHex`, `formatMemo`), imported and not reimplemented. An empty hour gives `null` root and memo.

## Task Commits

1. `b5441e8` feat(27-03): add `GreptimeClient.hourLeaves` as three flat batched reads
2. `93733e2` feat(27-03): map `IngestNotRecorded` to stored-with-warning and add `Substrate.hourDigest`
3. `d63ce63` test(27-03): cover append ingest mapping and `hourDigest`
4. `03f45d2` fix(27-03): name the event when an ingest record carries a time that is not a number (found in the self-review)

## Verification

- `bunx tsc --noEmit` exit 0. `bun test packages/mcp-server/src/greptime.test.ts` 81 pass. `bun test packages/mcp-server/src/service.test.ts` 113 pass. `store-lock.test.ts` 18 pass, unedited.
- Mutations: disabling the `IngestNotRecorded` branch fails 4 service tests; reversing the leaves before the root fails 2; ignoring the lag fails 1. The file was restored each time.

## Deviations from Plan

One addition: the `epochMs` guard in `hourLeaves` and its three tests, from the phase self-review. No plan task changed.

## Threat notes

- **T-27-06 (ordering and membership):** membership by first record and rank by (`ingested_at`, `event_id`) are computed in TypeScript; shuffled-row tests at both the client and the service level pin server-order independence.
- **T-27-07 (partial or forged roots):** a missing row, a hash that is not 64 lowercase hex, two hashes for one id and a non-numeric time each throw naming the event.
- **T-27-08 (disclosure):** the warning is a constant; the journal line passes the cause through `redact`; the memo carries the hour, the root and the count only.

## Self-Check: PASSED

Commits above exist; the four test files pass as listed; the working tree held only these files.
