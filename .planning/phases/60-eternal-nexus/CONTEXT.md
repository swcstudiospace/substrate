---
phase: 60-eternal-nexus
milestone: v1.6
requirements: [SOTA-16]
discussed: 2026-10-26
status: implemented on gsd/v16-int; criteria 1 to 4 met with fakes; live bucket use operator-gated
---

# 60-CONTEXT: Eternal Memory Knowledge Nexus

## Goal

Memory records are durable, versioned, carry provenance and are verifiable against the anchored ledger; deterministic capsules can be exported and content-addressed, informed by the concepts of Anda and KIP without adopting their chain or code. The roadmap block is ROADMAP.md, Phase 60.

## Locked decisions

- **The Nexus is a verified projection, not a new table (D55 correction 8).** `memory_entries` already holds version, `superseded_by`, conflict key, actor, session, graph and governance columns (index steps 10, 11, 27), so `memory-record.ts` projects them and adds no schema.
- **Anda and KIP are a concept reference only (D55-7).** No code, schema, runtime, chain, canister or token is taken. Each concept is mapped to adopt, adapt or reject in ADR 0002, with the upstream licences stated; the licence files were read, and the project does not move to ICP.
- **Capsules are deterministic and not signed.** Bytes depend only on the records and an injected clock. The manifest binds `records_sha256`, an RFC 6962 `root_digest` over the records' content hashes, and a capsule digest that a `memory.capsule.export` ledger note records; the defence against a resealed file is the anchored ledger, not a signature.
- **Redaction keeps the hash.** A redacted record becomes `{id, content_hash, tombstone}` so the root still verifies; a hash of low-entropy content can confirm a guess, which is a documented limit.
- **Devnet is evidence, not storage (D55-6).** On-chain immutability cannot be undone for a root, but a root holds no content; the limits are in ADR 0003 and the capsule runbook.
- **The blob store is local content-addressed plus an S3-compatible adapter tested against a fake.** The live `ledger-archive` bucket is operator-gated; no test or module reaches a real bucket.

## Links

- Code: `packages/mcp-server/src/{memory-record,memory-verify,capsule,blob-store,blob-store-s3}.ts`; tool `memory_verify` (`mcp.ts`); CLI `packages/cli/src/capsule.ts` (`substrate capsule`)
- ADRs: `docs/adr/0002-anda-kip-concept-mapping.md`, `docs/adr/0003-memory-nexus-design.md`
- Runbook: `docs/runbooks/memory-capsules.md`; governance: `docs/memory-governance.md`
- Discovery: `../55-migration-safety/CONTEXT.md`
