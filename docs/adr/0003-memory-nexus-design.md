# ADR 0003: Memory nexus design: identity, verification, capsules and the limits of immutability

- **Status:** Accepted (design and pure modules; no service, MCP or config wiring lands with this ADR)
- **Date:** 2026-10-26
- **Tickets:** v1.6 phase 60, "Eternal Memory Knowledge Nexus"
- **Deciders:** Spectrum Web Co platform
- **Affects:** `packages/mcp-server/src/{memory-record,memory-verify,capsule,blob-store,blob-store-s3}.ts`
- **Concepts from:** ADR 0002

## Context

Governed memory is durable in the index (`memory_entries`), and the gate
(`memory-write.ts`) already stamps every row with an `entry_hash`, a `version`,
`supersedes` and `superseded_by`, and the writer's cited `source_event`. Four things
were missing:

1. one stable, verifiable **identity** for a record, and a **provenance** view of it;
2. a **verdict** that says whether a record is intact and whether the event it cites is
   inside an anchored ledger root;
3. a deterministic, portable **export** that survives redaction;
4. a place to **keep** exports that is content-addressed and checks itself.

The constraints are fixed: no new event kind or surface (12 kinds, 42 surfaces), no SQL
outside `greptime.ts` and `brief.ts`, no new table, column or migration step in this
phase, no new dependency, no new environment variable, and Solana is devnet-only and
carries roots, never event contents.

## Decision

### 1. Record identity (`memory-record.ts`)

A record's identity is the pair **(`id`, `content_hash`)**. `id` is the row's primary key.
`content_hash` is the gate's own `entry_hash`, verbatim: SHA-256 over the canonical JSON
of `{scope, kind, subject, text, writer}` (v1), or the same object plus `hv: 2` and
`tenant: "swc"` (v2, selected by `SUBSTRATE_HASH_VERSION`). `contentHash` in
`memory-write.ts` is private, so the module rebuilds that preimage from the same two
primitives (`canonicalJson`, `sha256Hex`), accepts either version (a flag flip must not
orphan rows), and a test pins the constants it shares with the gate against the gate's
source. There is exactly one hash in the system.

The hash covers **content and writer only**. It does not cover trust, actor, ttl, source
event or timestamps, because the gate does not hash them (a reviewed re-submission must
hash like the proposal it approves). A verdict of `verified` therefore says nothing
about those fields; the capsule digest and the limits below say what does.

`state` is derived, never stored:

| `superseded_by` | `state` |
|-----------------|---------|
| empty | `current` |
| an entry id | `superseded` |
| starts with `forgotten:` | `forgotten` |

A `forgotten:<x>` value (written by the memory-forget path) is a **terminal tombstone,
not a pointer**. The record view reports `superseded_by: null` and `forgotten_by: <x>`,
and `supersessionChain` stops there instead of looking for a row that does not exist. The
chain walk is pure and safe on hostile data: each id is visited once (a cycle is
reported and not followed), each direction is bounded by 256 hops, and a link to a row
the input does not hold is reported as dangling.

### 2. Verification (`memory-verify.ts`)

`verifyMemoryRecord(deps, id)` answers two questions in order and returns exactly one of
six verdicts, with reasons:

1. Does the stored content still hash to the stored `entry_hash`? A mismatch is
   `hash-mismatch` and the anchor is not consulted.
2. Does the event the writer cited (`source_event`) sit inside an anchored root? An
   injected `anchorEvidence(eventId)` returns `anchored | pending | unanchored |
   unverified | mismatch` plus a proof reference. The real reader over checkpoints is
   built elsewhere; this module only fixes the minimal contract.

| Verdict | Meaning |
|---------|---------|
| `verified` | content hash intact **and** the cited event is anchored, with a proof reference |
| `hash-mismatch` | the row changed after the gate wrote it |
| `pending` | the cited event exists; its hour has no published root yet |
| `unanchored` | no `source_event`, a `session:` reference (the gate's fallback for lessons, not a ledger event id), or no root will cover it. Never an error |
| `unverified` | the reader failed, timed out, returned a malformed answer, or said `anchored` without a proof; or the row predates `entry_hash` |
| `anchor-mismatch` | a root exists and the event does not verify against it |

A failing reader is `unverified`, never `verified` and never an exception. A forgotten
entry whose body is gone is reported with `content_checked: false` rather than as
tampering, because removing the body is what forgetting is.

**What `verified` does not prove.** It joins the record to the event *the writer cited*.
The gate checks only that a cited event exists (`verifySourceEvent`); the memory-write
verdict events seen in `event-sources.ts` name outcome, reason, scope and kind and no
entry id. Whether any event binds a specific entry id to its `entry_hash` is
**UNVERIFIED**. `verified` means: the content is as the gate hashed it, and the event it
points at existed by the anchored hour. It does not mean the event was about this memory.

### 3. Capsule format (`capsule.ts`)

A capsule is a text file, newline-terminated lines of canonical JSON:

```
line 1       manifest {capsule_version, schema, producer, created_at, count, records_sha256, root_digest}
lines 2..n   one record per line, sorted by id
```

- **Deterministic.** Records sort by `id` (code-unit order); keys sort inside
  `canonicalJson`; `created_at` comes from an injected clock. Same records and same
  clock give byte-identical output regardless of input order or key insertion order.
- **Three bindings.** `records_sha256` is SHA-256 of every byte after the manifest line.
  `root_digest` is the RFC 6962 Merkle root (`@substrate/ledger`, the same tree as the
  anchor job) over the records' **content hashes** in id order. The capsule `digest` is
  SHA-256 of all bytes.
- **Strict import.** `importCapsule` returns records or a typed error. It checks the
  manifest, `records_sha256`, the count, each line's shape (unknown keys refused) and
  canonical form, strictly ascending ids, every full record's content hash, and the
  root. It never throws for bad input and never writes anywhere.
- **Records.** A full record is the nexus record plus `content {scope, kind, subject,
  text}`. A forgotten entry is exported as a tombstone, never with content, even if the
  row still has it.
- **Empty capsules are refused**, like an empty anchor hour.

The Merkle root covers content hashes; the rest of a record (provenance, chain links,
version) is covered by `records_sha256` and the digest only. That is deliberate: it is
what lets redaction leave the root alone. It also means a provenance edit that re-seals
`records_sha256` imports cleanly (a test pins this). The **manifest is not signed.** A
capsule is checked against a digest taken from the ledger, not from itself.

### 4. Redaction semantics

`tombstoneCapsule(bytes, ids, reason, now)` replaces each named record with
`{id, content_hash, tombstone: {reason, at}}`:

- the body, scope, subject **and** provenance of that record are removed; only `id`,
  the hash and the tombstone remain, so the redacted content is in no byte of the output
  (tested by searching the bytes);
- `root_digest`, `count` and `created_at` are unchanged, `records_sha256` and the
  digest change, and the root still verifies because it covers hashes;
- redacting an existing tombstone is a no-op, so redaction is idempotent;
- `reason` is a short label (letters, digits, space and `. _ : / -`, at most 120
  characters), not prose, because it lands in the tombstone and in a ledger note.

Two notes record these. `memory.capsule.export` carries `{digest, count, root_digest,
size}`; `memory.capsule.redact` carries `{digest_before, digest_after, redacted_count,
reason}`. Both are existing kind `note` with `payload.action`, on the caller's surface,
carry no record content, and are validated strictly (unknown keys refused). The export
note's idempotency key is its digest, so a replayed export dedupes.

### 5. Blob store (`blob-store.ts`, `blob-store-s3.ts`)

`BlobStore {put, get, has, remove}` is keyed by the SHA-256 hex of the bytes, so a name
is also a checksum and every read recomputes it.

- `LocalBlobStore(dir)`: the directory is absolute with no `..`; the only path component
  built from input is a validated 64-hex digest (two-character shard directory), so no
  input can leave the store; a symlinked shard or blob is refused; writes go to an
  exclusive temp file, are fsynced, renamed into place and the directory fsynced, so a
  reader sees a whole blob or none; directories are 0700 and files 0600; a put of
  stored bytes is a no-op unless the stored file fails its checksum, in which case it is
  replaced.
- `S3BlobStore(client, {prefix})` over a four-method `S3Like` that `Bun.S3Client`
  satisfies (`write`, `file().arrayBuffer()`, `exists`, `delete`; a type-level test
  checks this). It imports no client and holds no credential; it is tested against an
  in-memory fake only.

**The live ledger-archive bucket stays operator-gated.** This phase provisions no
bucket, sets no credential and reads no new environment variable. `S3BlobStore` is
unwired; connecting it to a bucket is an operator decision made later with its own
configuration and documentation entries.

## The honest limits of immutability

"Eternal" is a goal, not a property this design can deliver. What it does deliver:

- **A devnet anchor is evidence of a root, not storage.** The Memo on Solana devnet
  carries a Merkle root over event hashes. It holds no event, no memory body and no
  capsule. Given the events, the root proves they existed by that hour; given the root
  alone, nothing can be reconstructed.
- **Devnet may reset.** It is a test cluster with no durability promise. The roots
  themselves live in the ledger's `anchors` table (`docs/greptime-ledger.md`); the chain
  is a public witness of them. A reset cluster loses the witness, not the roots. A later
  move to a durable cluster is outside this phase and outside the "devnet only" owner
  decision.
- **Content can be redacted; hashes remain.** A tombstone keeps `content_hash` so the
  root verifies. A hash of short or guessable text can confirm a guess ("is it this
  sentence?"). Redaction removes the content from the capsule; it does not make the
  hash unguessable, and it does not touch other capsules, the index, the memory bank or
  backups that already hold the content. Erasing those is the forget path and an
  operator procedure, not this module.
- **Integrity is not truth.** A verified, anchored record can still be wrong. Trust
  levels and reverification remain the only statement about confidence.
- **The index is mutable.** `memory_entries` can be edited by anyone with database
  access. The design makes that detectable (`hash-mismatch`) for content and writer, not
  impossible, and not detectable for trust, actor or timestamps.
- **Anchoring is hourly and lagged.** A fresh record is `pending`, honestly.

## Non-goals

No new chain, canister, token or signing key. No SQL, table, column or migration. No
import into the index. No delta capsules. No JCS (RFC 8785) conformance claim. No live
bucket. No wiring into `service.ts`, MCP tools or configuration in this phase.

## Consequences

- Memory gains a single identity, a verdict vocabulary and a portable export, all as pure
  functions that take their dependencies as parameters; the integration step wires them.
- The wiring this requires, in the order the integration step needs it:
  1. a `getEntry(id)` over the existing memory read path (`toMemoryEntry`);
  2. an `anchorEvidence(eventId)` reader over the anchor checkpoints;
  3. emission of the two notes with the caller's authenticated surface and, where one
     exists, the session id, via the normal `events.emit` path;
  4. an MCP or CLI surface for verify, export and redact, behind the existing RBAC;
  5. only if wanted, configuration for a `BlobStore` location, with its flag-registry
     and documentation entries at that time.
- Two modules duplicate three constants of the gate (`"swc"`, `2`, the preimage shape).
  The drift test fails the build if the gate changes them; exporting `contentHash` from
  the gate would remove the duplication and is a one-line follow-up for whoever next
  owns `memory-write.ts`.

## References

- ADR 0002, the Anda and KIP concept mapping
- `docs/memory-governance.md`, `docs/greptime-ledger.md`, `docs/event-vocabulary.md`
- RFC 6962 (Certificate Transparency), section 2.1, the Merkle tree hash
