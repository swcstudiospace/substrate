---
phase: 60-eternal-nexus
milestone: v1.6
requirements: [SOTA-16]
status: implemented on gsd/v16-int (084eb69 modules, a26841d memory_verify, 979b5e2 substrate capsule); not merged; criteria 1 to 4 met with fakes
---

# 60-SUMMARY: Eternal Memory Knowledge Nexus

## What was built

- **`memory-record.ts` (084eb69):** the gate's content hash (`entryHashFor`, `matchEntryHash`; `a26841d` makes it reuse the gate's exported `contentHash`), `toNexusRecord` (stable id, version, supersession chain, provenance, content hash), `toCapsuleRecord`, `isForgottenMarker`, `supersessionChain`.
- **`memory-verify.ts` (084eb69):** `verifyMemoryRecord` answers one verdict from two independent questions: does the stored content still hash to the stored `entry_hash`, and does the ledger event the write rested on sit inside an anchored root (an injected reader). Statuses are those of phase 59: anchored, pending, unanchored, unverified, mismatch. Exposed as the read tool `memory_verify` (a26841d); it answers as if absent for an entry the caller may not read, and its outputs are redacted (`mcp-verify-tools.test.ts`).
- **`capsule.ts` (084eb69):** deterministic export (manifest line plus one canonical-JSON record per line sorted by id; `records_sha256`, RFC 6962 `root_digest` over the content hashes, capsule digest), import with verification, `tombstoneCapsule` redaction, and the `memory.capsule.export` and `memory.capsule.redact` ledger-note drafts (ids, counts and digests only).
- **`blob-store.ts`, `blob-store-s3.ts` (084eb69):** `LocalBlobStore` and `S3BlobStore` keyed by SHA-256 with the digest recomputed on every read; `S3Like` is satisfied structurally by `Bun.S3Client`, and the module holds no client and no credential (a compatibility test checks the `Bun.S3Client` shape).
- **`substrate capsule` (979b5e2):** `packages/cli/src/capsule.ts` with `export`, `verify` and `redact`; the ledger note goes through the CLI event path and is reported as `NOT RECORDED` (fail-open) when the ledger refuses.
- **ADRs 0002 (Anda and KIP concept mapping with licences) and 0003 (design, with "The honest limits of immutability")**, and `docs/runbooks/memory-capsules.md`.

## Key decisions

- No new table; no on-chain content; the capsule is not signed (see CONTEXT).
- Verification answers "the write event existed by the time a root was published", not anything about the record body, and the reasons in the reply say so.

## Deviations from the plan

- None found against the ROADMAP criteria. Criterion 1's "each governed memory record exposes ..." is delivered through `toNexusRecord`, the `memory_verify` reply and capsule export; no separate read tool for the projection was added.

## Findings

- A checkpoint or record that verifies as `verified` proves an entry hash and an anchored cited event, not that the event concerns the entry (the `memory.write` event carries no entry id), so a verdict of "anchored" is weaker than a reader may assume. Recorded as residual.
- Redaction removes content and provenance from one capsule file only; copies, the plane, the index and the ledger are untouched (`docs/runbooks/memory-capsules.md`, "The limits of immutability").

## What remains

- Live use of the `ledger-archive` bucket (operator-gated); a decision on a signed manifest; adding an entry id to the write event so a verdict can be tied to an entry; running a real export and verify against production data.
