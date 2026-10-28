# Runbook — export governed memory as a capsule, verify one, redact records from one

| | |
| --- | --- |
| Question | Can I take a portable, checkable copy of the memory entries I can read, prove later that a copy was not altered, and remove specific records from a copy when I am asked to? |
| Trigger | A hand-off or archive of memory, an audit that wants the records and their provenance, an erasure request that has to reach a copy that was already exported |
| Who | An operator, or an agent with the `substrate` CLI and its own token. Export reads **as the caller's surface**: it sees what that surface's `memory_search` sees and nothing more. |
| Scope | Governed memory entries (`memory_entries`) as capsule files, optionally a local content-addressed store. Not the Hindsight bank, not LightRAG, not the ledger's events. |
| Blast radius | A new file (mode 0600, never overwriting) and, for `--store`, a new blob in a local directory. Two ledger notes. **Nothing in the index, the memory bank or the ledger is changed, and nothing is imported anywhere.** |

Design and its limits: `docs/adr/0003-memory-nexus-design.md`. The pure modules are `packages/mcp-server/src/{memory-record,capsule,memory-verify,blob-store}.ts`; the commands are `packages/cli/src/capsule.ts`.

## The stance

- **A capsule is a copy, not a source of truth.** The index stays authoritative. Verifying a capsule tells you the copy is internally consistent; comparing its digest with the ledger note tells you it is the copy that was exported.
- **Integrity is not truth.** A clean capsule can hold entries that were wrong when they were written.
- **Redaction removes content from one file.** It does not erase anything anywhere else (see "The limits of immutability").
- **Devnet only, roots only.** Anchors, where used, are Merkle roots on Solana devnet; they carry no record and no capsule.

## What is in a capsule

A text file: line 1 is the manifest, then one record per line sorted by id, every line canonical JSON ending in a newline.

- **Manifest:** `capsule_version`, `schema`, `producer` (`substrate-cli` for these commands), `created_at`, `count`, `records_sha256` (SHA-256 of every byte after the manifest line), `root_digest` (the RFC 6962 Merkle root over the records' content hashes, in id order).
- **A record with content:** id, version, `supersedes`/`superseded_by`, state (`current` or `superseded`), provenance (writer, actor, trust, source event, session, graph, repo, created) and the hashed content (scope, kind, subject, text). Its `content_hash` is the governance gate's own `entry_hash`.
- **A tombstone:** `{id, content_hash, tombstone: {reason, at}}`. A **forgotten** entry is always exported as a tombstone, never with content, even if the row still has it.
- The capsule **digest** is the SHA-256 of all its bytes.

The export asks for superseded and forgotten entries too, so a capsule carries the history of a claim (its versions) and not only what is in force today.

## Export

```sh
substrate memory capsule export --out capsule-2026-10-26.jsonl
substrate memory capsule export --out s.jsonl --session sess-demo --repo acme/app --since 2026-10-20T00:00:00Z --limit 500 --store /var/lib/substrate-capsules
```

| Flag | Meaning |
| --- | --- |
| `--out FILE` | **required.** Created exclusively with mode 0600. An existing path is refused before anything is read, and again at creation; it is never overwritten |
| `--session S` | only entries whose own `session_id` is S |
| `--repo R` | only entries whose own `repo` is R (also sent to the server, which uses it to decide which `agent:` entries the caller may see) |
| `--since ISO` | only entries created at or after this instant; an ISO time with a zone |
| `--limit N` | at most N records: default 1,000, maximum 10,000 |
| `--store DIR` | also put the capsule into a local content-addressed store rooted at DIR (see below) |
| `--surface S` | the surface whose token reads memory and whose name the ledger note carries; default `claude-code`, like the other commands |

The grammar is strict: each flag at most once, a value flag takes its value as the **next** argument (never `--out=F`), no positional argument. A wrong flag prints the usage and exits 2 before any request.

**What it does.** It pages the `memory_search` MCP tool newest first, 100 entries a page, and stops at `--limit` matching entries, at the first entry older than `--since`, or after examining 50,000 entries. `--session`, `--repo` and `--since` are applied here to each entry's own fields (the server has no such filter). Each entry is converted by the nexus modules and checked against its own hash; the capsule is built, written, optionally stored, and **one** `memory.capsule.export` note is recorded.

**What it prints:** the path, the **digest**, the record count (with and without content), the **root digest**, the size and, with `--store`, the store path. Keep the digest with whatever you hand the file to: it is the one value that identifies this exact file.

### Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | done |
| 1 | failed, **or the export is incomplete**: a server that did not answer, an unreadable or refused read, nothing matched, a file or store that could not be written, or entries that could not be made into capsule records (written, but listed as `INCOMPLETE` on stderr) |
| 2 | usage |
| 3 | `verify --anchors` could not finish the live check (below) |

### Reading the warnings

- `stopped at --limit N: more matching entries may exist` — the cap was reached. Raise `--limit` (up to 10,000) or narrow with `--since`. It is a warning, not a failure: the capsule is valid and says exactly what it holds.
- `stopped after examining 50000 entries` — a filter that matches few entries over a very large bank hit the scan bound. Narrow with `--since`.
- `INCOMPLETE: N entries ... were left out` — an entry has no `entry_hash` (written before the governance gate), its content does not hash to its `entry_hash`, or it was not a valid `memory_search` entry. The ids and reasons are printed (never content). The capsule is written without them and the exit is 1, so a script cannot mistake it for a full export. A content-hash mismatch is worth investigating: it is what an edited row looks like.
- `ledger: memory.capsule.export note NOT RECORDED: ...` — see "The ledger notes".

Reads can be answered from the server's short-lived search cache; a very recent write may not be in an export taken in the same moment. Re-run after it settles if that matters.

### The local store

`--store DIR` puts the capsule bytes into a `LocalBlobStore`: `DIR/<2 hex>/<64-hex digest>`, directories 0700, files 0600, written to a temporary file, fsynced and renamed, so a reader sees a whole blob or none. The name **is** the SHA-256 of the bytes, every read re-checks it, and putting the same capsule twice is a no-op. A relative DIR is taken from the current directory. The store refuses a symlinked shard or blob. If the store fails after the file was written, the command says so and exits 1; the file stays.

**No object-storage bucket is ever touched by these commands.** `S3BlobStore` exists as a module and is unwired. The live ledger-archive bucket stays **operator-gated**: provisioning it, giving it credentials and pointing a `BlobStore` at it is a separate operator decision with its own configuration and documentation entries. Nothing in this runbook reads or sets a credential for it.

## Verify

```sh
substrate memory capsule verify capsule-2026-10-26.jsonl
substrate memory capsule verify capsule-2026-10-26.jsonl --anchors
```

**Offline (the default)** runs `importCapsule` on the whole file: the manifest, `records_sha256`, the record count, every line's shape and canonical form, strictly ascending ids, **every full record's content hash**, and the Merkle root. It prints the digest, the producer, the counts and the root. A failure prints `capsule INVALID: <rule>: <message>` and exits 1. It needs no server and reads no store. **Not checked, and printed as such: who wrote the file.** The manifest is not signed; anyone who can rewrite the whole file can reseal it. Compare the printed **digest** with the `digest` in the `memory.capsule.export` ledger note (read it through the ledger's normal read path), not with a value the file or its sender gives you.

**`--anchors`** then looks up at most **50** records with content through the `memory_verify` MCP tool (all of them when there are fewer; otherwise evenly spaced and deterministic, so the same capsule samples the same records). Each line is the status for one record: `verified`, `hash-mismatch`, `pending`, `unanchored`, `unverified` or `anchor-mismatch`, or `capsule-differs` (the live entry's hash differs from the capsule's) or `unavailable` (the lookup could not be completed). Tombstones are not looked up.

- `verified` means the stored hash is intact **and** the ledger event the write cited is inside an anchored hourly root. It does **not** prove that event concerns that entry. `pending`, `unanchored` and `unverified` are honest answers (the hour is not closed, no root exists, or the check could not settle), not verdicts of tampering.
- Exit 1 if any sampled record is `hash-mismatch`, `anchor-mismatch` or `capsule-differs`. Exit **3** if any lookup was `unavailable` (the server did not answer, refused it, or did not answer a verdict): the offline result still prints, and the anchors cannot be claimed.
- The lookup answers as the caller: an entry the caller cannot read (another surface's `agent:` scope, or one past its lifetime under enforcement) answers as if absent and shows as `unavailable`, which is not an error in the capsule. Run the verify as the surface that exported it.

## Redact

```sh
substrate memory capsule redact capsule-2026-10-26.jsonl --ids mem_0123,mem_0456 --reason "erasure request" --out capsule-2026-10-26.redacted.jsonl
```

| Flag | Meaning |
| --- | --- |
| `FILE` | the capsule to redact; the **first** argument. It is read and never changed |
| `--ids a,b` | the record ids to redact (at most 1,000). An id that is not in the capsule refuses the whole call |
| `--reason TEXT` | a short **label** (letters, digits, space and `. _ : / -`, at most 120 characters), not prose: it lands in the tombstone and in the ledger note, so it must not carry content or a name |
| `--out FILE2` | the new file; created exclusively, mode 0600, must differ from the input |

Each named record becomes `{id, content_hash, tombstone}`: its content **and its provenance** are gone, only the id and hash remain. `count`, `created_at` and `root_digest` are unchanged (the root covers hashes, so it still verifies), `records_sha256` and the digest change. The command prints both digests and records **one** `memory.capsule.redact` note (digest before, digest after, count, reason). Redacting records that are already tombstones changes nothing: it prints `nothing to redact`, writes no file and records no note, so a repeat is safe.

Re-run `verify` on the new file. The old file is still on disk: **redaction does not delete it**; remove or secure it yourself.

## The ledger notes

Both commands record exactly one note through the CLI's normal event path (`substrate emit`'s), on the caller's surface, with no repo: `memory.capsule.export` (`digest`, `count`, `root_digest`, `size`) and `memory.capsule.redact` (`digest_before`, `digest_after`, `redacted_count`, `reason`). They are ordinary `note` events carrying `payload.action`; no event kind or surface was added. They never carry record content, and the nexus modules refuse a payload with any other key.

The note is **fail-open**: if the server is down or refuses it, the capsule that was written stays written, the command still exits 0, and the output says `NOT RECORDED` with why (including whether it was parked in the event spool). A capsule with no note has no digest in the ledger to check it against. Re-run the export under a new `--out`: the note's idempotency key is the capsule digest, so an identical re-export dedupes where the server honours idempotency keys (`SUBSTRATE_EVENT_IDEMPOTENCY=accept|enforce`).

Whether the server validates a capsule note's payload beyond the general event rules is **UNVERIFIED** here; the CLI builds the payload with the nexus validators before sending.

## The limits of immutability

- **A devnet anchor is evidence of a root, not storage.** It carries a Merkle root over event hashes, never a record or a capsule. Given the events, the root proves they existed by that hour; given the root alone, nothing can be rebuilt. Devnet may reset and publishes no retention window; the roots also live in the ledger's own table. See `docs/runbooks/devnet-reset-and-reanchor.md`.
- **Content can be redacted; hashes remain.** A tombstone keeps `content_hash` so the root verifies. A hash of short or guessable text can confirm a guess ("is it this sentence?"). Redaction does not make the hash unguessable.
- **Redaction touches one file.** Other capsules, copies of this capsule, the live index, the Hindsight bank and backups that already hold the content are untouched. Erasing those is the memory-forget path and an operator procedure, not this command.
- **The manifest is not signed.** A capsule is checked against a digest taken from the ledger, not from itself. Provenance fields (writer, trust, source event, timestamps) are covered by `records_sha256` and the digest, not by the Merkle root: a provenance edit that re-seals `records_sha256` imports cleanly. Only the ledger digest catches it.
- **The hash covers content and writer only.** Not trust, actor, ttl, source event or timestamps. A `verified` verdict says nothing about those fields.
- **The index is mutable.** A row edited by someone with database access is detectable for content and writer (`hash-mismatch`), not for trust, actor or timestamps.
- **Anchoring is hourly and lagged.** A fresh record is `pending`, honestly.

## Not in scope

No import of a capsule back into the index. No delta capsules. No signing key. No live bucket. No new environment variable, event kind, surface, table or migration. No server file changed.

## UNVERIFIED and open

- That `memory_search` with an empty query and a far-future `before` cursor pages the whole bank on the live server. The tool's own description gives this recipe for paging a plain query from the top; it was exercised against fakes here, not the live server.
- That forgotten entries are listed by `memory_search` when superseded entries are requested. If they are not, an export simply holds no tombstone for them; it never holds their content.
- Whether the live server accepts a `memory.capsule.*` note exactly as built (above).
- The `--store` path was exercised with a fake and with a temporary directory, not with a production directory.
