---
phase: 60-eternal-nexus
verified: 2026-10-28
status: passed
score: 4 of 4 success criteria MET in the repository with fakes; live bucket use is OPERATOR-GATED
verified_on: main at 31a9bb36 (files read; nothing was run)
---

# 60-VERIFICATION: Eternal Memory Knowledge Nexus

## Gates

Not run by the author of this record; the full gate runs in CI on main (frozen install, tsc with the strict flags, blocking Biome lint, the full bun test suite against a scratch Postgres, the Python suites, the repo locks) and the orchestrator records the run in .planning/STATE.md. This record's evidence is file paths and test titles read on main. Do not invent test counts or CI numbers.

## Success criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Each governed memory record exposes a stable id, a version, its supersession chain, its provenance and a content hash; a verify call recomputes the hash and proves the write event is inside an anchored root. | MET | `packages/mcp-server/src/memory-record.ts` (`toNexusRecord`, `toCapsuleRecord`, `isForgottenMarker`, `supersessionChain`, `entryHashFor`, `matchEntryHash`); `packages/mcp-server/src/memory-verify.ts` (`verifyMemoryRecord`, verdicts anchored/pending/unanchored/unverified/mismatch against an injected anchor reader); `memory-record.test.ts` (`describe("entry hash")`, `describe("toNexusRecord")`, `describe("toCapsuleRecord")`, `describe("isForgottenMarker")`, `describe("supersessionChain")`, all read); `memory-verify.test.ts` (`describe("verifyMemoryRecord verdicts")`, `describe("hash recompute")`, `describe("a misbehaving anchor reader")`, `describe("caller errors")`, all read); `mcp-verify-tools.test.ts` (`describe("memory_verify: not verifiable here is a status")`, `describe("memory_verify: an entry the caller may not read answers as if absent")`, `describe("memory_verify: outputs are redacted")`, all read); tool wired at `packages/mcp-server/src/mcp.ts` (`"memory_verify"`). The anchor leg is proved against an injected fake reader; no live devnet read. |
| 2 | A deterministic capsule export (records plus a manifest and a root digest) round-trips, and its digest is recorded as a ledger event; the blob store interface has a local content-addressed store and an S3-compatible adapter tested against a fake (live use of the `ledger-archive` bucket is operator-gated). | MET | `packages/mcp-server/src/capsule.ts` (`exportCapsule`, `importCapsule`, `tombstoneCapsule`, `capsuleExportEvent`, `capsuleRedactEvent`); `capsule.test.ts` (`describe("exportCapsule")` incl. "is byte-identical for shuffled input", "root_digest is the RFC 6962 root", `describe("importCapsule")` incl. "round trips records, manifest and digest", `describe("capsule ledger notes")`, all read); `blob-store.test.ts` (`describe("LocalBlobStore")`, read); `blob-store-s3.test.ts` (`describe("S3BlobStore")` against a fake, `describe("Bun.S3Client compatibility")` compiler-checked, read); the adapter holds no client and no credential (`blob-store-s3.ts` header: the caller constructs the client and passes it in); `packages/cli/src/capsule.ts` with `describe("export")`, `describe("verify")`, `describe("httpCapsuleMcp")` in `packages/cli/src/capsule.test.ts` (read); `memory.capsule.export` row in `event-sources.ts`. No module reaches a real bucket. |
| 3 | Redaction removes a capsule's content and keeps its hash and a tombstone; the limits that on-chain immutability imposes are documented. | MET | `capsule.test.ts` `describe("tombstoneCapsule")` ("replaces the body with a tombstone, keeps the root and count, and leaves no trace of the content in the bytes", "is idempotent", all read); `packages/cli/src/capsule.test.ts` `describe("redact")` ("redacting an already redacted record changes nothing", read); `memory.capsule.redact` row in `event-sources.ts`; limits in `docs/adr/0003-memory-nexus-design.md` ("The honest limits of immutability"), `docs/runbooks/memory-capsules.md` ("The limits of immutability") and `docs/adr/0006-memo-only-anchoring.md`. |
| 4 | A decision record maps each Anda and KIP concept to adopt, adapt or reject and notes the upstream licenses; no code is copied. | MET | `docs/adr/0002-anda-kip-concept-mapping.md` (concept table with adopt, adapt and reject rows, section "Licences, stated exactly" naming the Apache-2.0/MIT sources); the ADR states concepts only were taken. That no code was copied is a statement of the ADR; this verification did not diff against upstream. |

## Residual risks

- The capsule manifest is not signed: anyone who can rewrite the whole file can reseal `records_sha256`; the defence is that the ledger note carries the capsule digest and the ledger is anchored. A capsule must be checked against a digest taken from the ledger, not from itself.
- An "anchored" verdict means the write event existed by the time a root was published. It does not say the event concerns the entry (the `memory.write` event has no entry id) and a root holds no content.
- A hash kept after redaction can confirm a guess of low-entropy content.
- Redaction affects one file. Copies, the plane, the index and the ledger are not changed by it.
- The S3 adapter was tested against a fake only; Bun's real `S3Client` against a real bucket was not exercised.
- The Anda and KIP licences are stated in ADR 0002 from the upstream repositories; this record did not re-read them (UNVERIFIED here), and the planning record D55-7 said to verify the LICENSE files before adapting anything.
- Later merged PRs touching these files after the phase commits (lint/typecheck cleanup in #149, #151; gate and docs changes in #145, #154, #155, per git log) did not change the phase logic; every evidence path above was re-read on main.

## Operator-gated

Live use of the `ledger-archive` bucket and its credentials; running capsule export against production memory; any decision to sign manifests.
