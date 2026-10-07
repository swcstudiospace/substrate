# Phase 6: Ledger - CONTEXT

**Goal**: Tamper-evident history + Solana anchors for events and teachables.

**Current**: Event hash/prev, verifyChain in event.ts. Greptime ledger.

**Success**:
1. Collectors compute hash/prev.
2. Hourly Merkle to Solana devnet memo, record in anchors.
3. substrate verify checks.
4. Evidence export for PR/incident + teachables.
5. Solana for teachables.

**Proof**: Alter row -> verify fails. Export matches. Solana tx for teachable.

**Implementation**: Extend index for anchors, add anchor fn, export, Solana stub.
