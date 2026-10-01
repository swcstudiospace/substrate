# Phase 4: Skills + A2A Teachable +4.x - CONTEXT

**Goal**: One git-backed skills library + A2A Agent Cards with Teachable Moments (reverse skills: session observations/edge cases/learnings, not recall) anchored on Solana devnet.

**Depends**: Phase 1 (miners), Phase 2 (handoffs for provenance).

**Current**: Basic memory kinds, handoff, projector, grok/herdr collectors, miner package exists.

**Success (ROADMAP + user)**:
- agent-skills clone, deref all symlinks.
- Projector for all surfaces (claude, hermes, omp, grok, muse, cursor, rivet).
- Miners (Hermes primary cron) propose PR only.
- A2A AgentCard per agent; teachable mapped as skills[] (framing + tags).
- Solana devnet anchor for teachables + graph session edges.
- Approvals on.
- Proof: mined teachable visible in card, Solana tx verifiable.

**User addition**: Teachable Moments tracked on Solana for interop.

**Risks**: No real Solana keys here (stub + devnet); symlinks in real clone.

**References**: ROADMAP P4, A2A draft, Notion.

Execute: schema, miner, anchor stub, artifacts, projector update, proofs.
