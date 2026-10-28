# ADR 0002: Anda and KIP concept mapping for the memory nexus

- **Status:** Accepted (design; the code it governs is `memory-record.ts`,
  `memory-verify.ts`, `capsule.ts`, `blob-store.ts` and `blob-store-s3.ts`, ADR 0003)
- **Date:** 2026-10-26
- **Tickets:** v1.6 phase 60, "Eternal Memory Knowledge Nexus"
- **Deciders:** Spectrum Web Co platform
- **Affects:** `packages/mcp-server` (memory plane), `docs/memory-governance.md`

## Context

v1.6 gives governed memory a verifiable identity, a provenance view and a
deterministic export. Two upstream projects by LDC Labs work on the same problem
space, durable cognitive memory for agents, and have vocabulary worth borrowing:

- [**Anda**](https://github.com/ldclabs/anda), a Rust framework for composable AI
  agent runtimes, with a KIP-based memory extension and a separate memory product,
  [Anda Brain](https://github.com/ldclabs/anda-brain).
- [**KIP**](https://github.com/ldclabs/KIP) (Knowledge Interaction Protocol, now
  "KIP 2.0, Cognitive State Protocol for Agent Memory"), the protocol Anda's memory
  tools speak. Its portable artifact is the Cognitive Capsule.

We take **concepts** from them. We do not take code, schemas, a runtime, a chain,
a canister or a token.

### Licences, stated exactly

- **Anda** (`ldclabs/anda`): the repository root holds both `LICENSE-APACHE`
  (Apache License 2.0) and `LICENSE-MIT`; the workspace `Cargo.toml` declares
  `license = "MIT OR Apache-2.0"`. The README's closing section says "licensed
  under the MIT License" and links `LICENSE-MIT`. The brief for this phase names
  Apache-2.0; that is one of the two options the repository offers, and the README
  names the other. Read from the default branch on 2026-10-26; **no commit was
  pinned (UNVERIFIED which commit)**.
- **KIP** (`ldclabs/KIP`): MIT License (`LICENSE`; the README's closing section
  says the same).
- **No code copied.** Nothing in this repository is derived from either project's
  source, schemas or test vectors. The mapping below is of ideas, written from the
  READMEs and, for KIP, the Capsule Specification sections cited. Neither licence's
  conditions are therefore triggered; the projects are credited here as a courtesy
  and because the vocabulary is theirs.

### What was read (and what was not)

Read: the Anda `README.md`, `Cargo.toml` and `docs/architecture.md`; the KIP
`README.md` and `KIP-2.0-Capsule-Specification.md` (sections 37 to 40.2 in
particular). **Not read, UNVERIFIED:** the KIP `SPECIFICATION.md` body, the
Cognitive Memory Profile, the Anda engine source (`anda_engine/src/memory.rs` and
the KIP tools), the Anda Brain repository, and any claim in a README that is backed
only by a link. Where a row below rests on a README sentence alone, it says so.

## Decision

Each upstream concept is marked **adopt** (same idea, same job here), **adapt**
(the idea, reshaped to what the substrate already has) or **reject** (not built, with
the reason). "Already present" means the substrate had it before this phase; the row
records that the upstream idea confirms the existing design rather than adding work.

### KIP concepts

| KIP concept | Mark | Here, and why |
|-------------|------|---------------|
| Change never rewrites the past: a corrected claim is superseded and the old one stays on record (README "The one idea") | adopt (already present) | `supersedes` / `superseded_by` on `memory_entries`. The nexus record adds an explicit `state` and a cycle-safe `supersessionChain`; no row is ever deleted by a supersession. |
| Meaning, Belief and Authority kept apart; a stored claim is truth-neutral and belief is computed at read time (README) | adapt | The gate already separates authority (default-deny RBAC), trust (`agent-claimed`, `human-confirmed`, `verified-by-test`) and content. We do not build an epistemic-projection engine; `trust` plus `state` is the read-time stance. |
| Evidence and Activity as first-class provenance (README) | adapt | A flat `provenance` view over columns we already store: writer, actor, trust, `source_event`, session, graph, repo, created. No graph of evidence elements. |
| Cognitive Capsule: portable, immutable, inspectable artifact; "not executable mutation authority" (Capsule spec 37.1, 37.2) | adapt | `capsule.ts`. Snapshot only, data only; importing returns verified records and never writes to the index. |
| Canonical representation and a content digest over canonical bytes (37.7) | adapt | We use the repository's existing `canonicalJson` (sorted keys, no whitespace) and SHA-256 of the bytes. **We do not claim RFC 8785 (JCS) conformance**, which KIP's profile requires in full, so a KIP tool will not accept our capsules and we do not say it would. |
| Capsule signature proves origin and integrity, "never truth, trust, or authority" (README; 37.8) | adopt (principle) | A capsule digest proves the bytes are unchanged. It says nothing about whether the claims are true. The ADR 0003 verdicts are worded to the same limit. |
| Signed capsule (37.8) | reject | No signing key or signer is introduced. The defence is that the digest is recorded in an anchored ledger note (ADR 0003). |
| Delta Capsule: ordered changes between `base_seq` and `target_seq` (37.5) | reject | Snapshot export is enough for v1.6; a delta needs sequence numbers the index does not have. |
| Import modes: preview, isolate, merge, restore (39.x) | reject | The substrate's import is verify-and-read only. Merging into the index would bypass the governance gate (RBAC, quarantine, exactly-once), which is the one thing memory must not do. |
| "Redacted" and "unavailable" stay distinguishable (40.2) | adopt | A tombstone says withheld, with a reason and a time; an id absent from a capsule says nothing was exported. |
| `PURGE PAYLOAD`: destroy the observed bytes, keep the digest and the record (README) | adopt | `tombstoneCapsule`: the body goes, `content_hash` stays, the Merkle root is unchanged and still verifies. |
| `LIST DEPENDENTS`: bounded reverse traversal of provenance (README) | reject | The supersession chain covers the one relation memory has. Revisit if derived cognition (reflect, mental models) is stored. |
| KQL, KML, META query and mutation languages; Transaction Runtime; Change Stream (README) | reject | The substrate's surface is `memory_write`, `memory_recall` and `memory_search` behind the gate. A second query or write language is a second door. |
| Strength policy `kip:strength-half-life-30d`, computed at read time (README) | reject (already similar) | Trust already decays through `reverify_after` and `needs_reverification`. No new decay model. |
| Outcome Evidence and the consequence channel (README) | reject | Out of scope for this phase. `verified-by-test` trust is the existing, narrower mechanism. |
| Cognitive Nexus, the Rust KIP engine `anda_cognitive_nexus` (README, Implementations) | reject (name only) | We use "nexus" for our own view over governed memory. No engine, no AndaDB. |

### Anda concepts

| Anda concept | Mark | Here, and why |
|--------------|------|---------------|
| Composable agents and tools registered through traits (README feature 1) | reject | The substrate is a platform under agents, not an agent runtime (ADR 0001). |
| Model routing by labelled tiers (feature 2) | reject | Model choice belongs to the agents and to the memory bank's own configuration. |
| `CompletionRunner` with steering, follow-up and compact continuation handoffs (feature 3) | adapt (other v1.6 phases) | The ideas map to live steering and the signed handoff packet that already exist; they are not part of this phase's code. |
| Scoped execution context with isolated state per agent or tool (feature 4) | adopt (already present) | Memory scopes (`graph:`, `repo:`, `global`, `agent:`, `person:`) with RBAC per surface. |
| Extensible memory: conversation storage and KIP-based memory tools (feature 5) | adapt | The governed `memory_*` tools are the equivalent. Conversation storage stays with the memory bank, not the index. |
| Notes and todos that survive context compression (feature 5) | adopt (already present) | Memory kinds `todo` and `handoff`. |
| File-backed skills (feature 5) | reject | The skills plane already exists (`docs/skills-plane.md`). |
| Discovery-aware tool bundles, `tools_groups` and `tools_select` (feature 6) | reject | The MCP tool surface is fixed and audited (`docs/mcp-audit.md`). |
| MCP integration with call policies (feature 6) | reject (already present) | `substrate-mcp` is the only door to the stores. |
| Optional ICP, TEE and web3 backing (`anda_web3_client`; workspace description "powered by ICP and TEEs") | reject | Owner decision: no chain, canister or token. Solana stays devnet-only and carries roots, never content. |
| Anda Brain as a persistent memory service (README, Products) | reject (as a dependency) | The memory bank (Hindsight) is the retention plane. Nothing here calls Anda Brain. |

## Consequences

- The nexus vocabulary (record, capsule, tombstone, provenance, chain) is
  ours; its borrowed meanings are listed above and nowhere else.
- A reader who knows KIP will find the same principles (history is kept,
  integrity is not truth, redaction keeps the digest) and none of its wire format.
- If KIP interoperability is wanted later it is a new ADR: JCS canonicalisation,
  KIP's capsule schema and a signing key are all additive and none is assumed here.

## References

- Anda: <https://github.com/ldclabs/anda> (README, `Cargo.toml`, `docs/architecture.md`)
- KIP: <https://github.com/ldclabs/KIP> (README, `KIP-2.0-Capsule-Specification.md`)
- ADR 0003, the nexus design
