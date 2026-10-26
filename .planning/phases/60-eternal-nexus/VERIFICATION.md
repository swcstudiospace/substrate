---
phase: 60-eternal-nexus
verified: 2026-10-26
status: passed
score: 4 of 4 success criteria MET in the repository with fakes; live bucket use is OPERATOR-GATED
verified_on: gsd/v16-int at 979b5e2 (phase commits 084eb69, a26841d, 979b5e2)
---

# 60-VERIFICATION: Eternal Memory Knowledge Nexus

## Gates

Not run by the author of this record. Orchestrator figures for `gsd/v16-int` at 979b5e2: 7480 pass, 2 skip, 0 fail; audit gate 0 unlisted; `check:phase-close` pass; config-reference check pass. Evidence below was read from files and test names.

## Success criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Each governed memory record exposes a stable id, a version, its supersession chain, its provenance and a content hash; a verify call recomputes the hash and proves the write event is inside an anchored root | MET | `packages/mcp-server/src/memory-record.test.ts` (`entry hash`, `toNexusRecord`, `toCapsuleRecord`, `isForgottenMarker`, `supersessionChain`); `memory-verify.test.ts` (`verifyMemoryRecord verdicts`, `hash recompute`, `source event`, `a misbehaving anchor reader`, `caller errors`); `mcp-verify-tools.test.ts` (`memory_verify: not verifiable here is a status`, `an entry the caller may not read answers as if absent`, `outputs are redacted`). The anchor leg is the phase 59 verifier run against fakes; no live devnet read. |
| 2 | A deterministic capsule export (records plus a manifest and a root digest) round-trips, and its digest is recorded as a ledger event; the blob store has a local content-addressed store and an S3-compatible adapter tested against a fake | MET | `capsule.test.ts` (`exportCapsule`, `importCapsule`, `capsule ledger notes`); `blob-store.test.ts` (`LocalBlobStore`); `blob-store-s3.test.ts` (`S3BlobStore` against a fake, `Bun.S3Client compatibility`, `normalizePrefix`); `packages/cli/src/capsule.test.ts` (`export`, `verify`, `httpCapsuleMcp`, `nodeCapsuleFs (a real temporary directory)`); the `memory.capsule.export` row in `event-sources.ts`. The live `ledger-archive` bucket was not touched. |
| 3 | Redaction removes a capsule's content and keeps its hash and a tombstone; the limits that on-chain immutability imposes are documented | MET | `capsule.test.ts` `describe("tombstoneCapsule")`; `packages/cli/src/capsule.test.ts` `describe("redact")`; the `memory.capsule.redact` row in `event-sources.ts`; limits in `docs/adr/0003-memory-nexus-design.md` ("The honest limits of immutability"), `docs/runbooks/memory-capsules.md` ("The limits of immutability") and `docs/adr/0006-memo-only-anchoring.md`. |
| 4 | A decision record maps each Anda and KIP concept to adopt, adapt or reject and notes the upstream licenses; no code is copied | MET | `docs/adr/0002-anda-kip-concept-mapping.md` (concept table with adopt, adapt and reject, section "Licences, stated exactly"); the ADR states that concepts only were taken. That no code was copied is a statement of the ADR; this verification did not diff against upstream. |

## Residual risks

- The capsule manifest is not signed: anyone who can rewrite the whole file can reseal `records_sha256`; the defence is that the ledger note carries the capsule digest and the ledger is anchored. A capsule must be checked against a digest taken from the ledger, not from itself.
- An "anchored" verdict means the write event existed by the time a root was published. It does not say the event concerns the entry (the `memory.write` event has no entry id) and a root holds no content.
- A hash kept after redaction can confirm a guess of low-entropy content.
- Redaction affects one file. Copies, the plane, the index and the ledger are not changed by it.
- The S3 adapter was tested against a fake only; Bun's real `S3Client` against a real bucket was not exercised.
- The Anda and KIP licences are stated in ADR 0002 from the upstream repositories; this record did not re-read them (UNVERIFIED here), and the planning record D55-7 said to verify the LICENSE files before adapting anything.

## Operator-gated

Live use of the `ledger-archive` bucket and its credentials; running capsule export against production memory; any decision to sign manifests.
