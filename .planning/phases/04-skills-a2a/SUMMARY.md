# Phase 4: Skills + A2A Teachable - SUMMARY

**Status**: schema + miner + card + Solana stub delivered.

**Delivered**:
- types: "teachable" MemoryKind, AgentCard, TeachableMoment (framing, observations, edges, learnings, solana_anchor).
- packages/miner/src/teachable.ts: extractTeachableFromEvents, makeAgentCard, anchorTeachableOnSolanaDevnet (stub), verify.
- projector mention (via prior), approvals stub in dispatcher.
- Artifacts: CONTEXT/PLAN/SUMMARY.

**Proof**:
- Extract from sample events produces framing + edges.
- Card includes teachables as skills[].
- Anchor produces devnet-memo style sig; verify passes.
- bun run on miner/teachable + dispatcher.

**Integration**: Use with Phase 2 handoff (provenance), Phase 6 anchors, Phase 1 collectors (source events). Hermes primary miner propose PR.

**Evidence**: teachable visible in AgentCard, Solana tx stub verifiable.

Phase 4 schema + extraction core complete.
