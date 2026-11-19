# Architecture decision records

One file per decision, numbered in the order it was taken. An ADR records the
context that forced a choice, the choice, what it deliberately refuses, and what
it costs — so the next person does not have to re-derive the argument from the
code.

| # | Decision | Status | Tickets |
|---|----------|--------|---------|
| [0001](0001-agent-swarm-as-sdlc-mesh-on-substrate.md) | Integrate [Agent Swarm](https://github.com/swcstudiospace/agent-swarm) as the SDLC mesh on Agent Substrate | Accepted | [SPE-5051](https://linear.app/swcstudio/issue/SPE-5051) / [SPE-5050](https://linear.app/swcstudio/issue/SPE-5050) |
| [0002](0002-anda-kip-concept-mapping.md) | Anda and KIP concept mapping for the memory nexus (concepts only, no code copied) | Accepted | v1.6 phase 60 |
| [0003](0003-memory-nexus-design.md) | Memory nexus design: record identity, verification, capsules, redaction and the limits of immutability | Accepted | v1.6 phase 60 |
| [0004](0004-store-roles.md) | Store roles: TimescaleDB coordination index, GreptimeDB authoritative ledger, DragonflyDB cache only, Hindsight derived memory, LightRAG docs graph, Solana devnet roots | Accepted | v1.6 phase 62 |
| [0005](0005-rollback-semantics.md) | Session rollback semantics: append-only, files restored locally, memory superseded, ledger and transcripts untouched | Accepted | v1.6 phases 61, 62 |
| [0006](0006-memo-only-anchoring.md) | Memo-only anchoring: memo v1 fixed, hourly roots with inclusion proofs, devnet as evidence, operator gates | Accepted | v1.6 phases 59, 62 |
| [0007](0007-checkpoint-triggers-and-sibling-hooks.md) | Checkpoint triggers and the hook proposals for the sibling repositories (proposals only, no sibling changed) | Accepted (proposals) | v1.6 phases 61, 62 |
| [0008](0008-closeout-blueprint-layered-planes-with-contract-first-cross-.md) | Closeout blueprint: layered planes with contract-first cross-repo and reconcile surfaces | Accepted | v1.8 closeout, v1.7 gaps 66-68 |
| [0009](0009-idempotency-breaker-and-lease-fencing-for-closeout-operation.md) | Idempotency, breaker and lease fencing for closeout operations | Accepted | v1.8 closeout, phases 71, 74, 78 |
Superseding an ADR means a new file that says so, not an edit to the old one. A
decision that was taken and then reversed is two records; the reasoning in the
first is the reason the second was needed.
