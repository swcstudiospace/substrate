# Phase 3: Lane A - PLAN

**Goal**: One durable VM (rivet-agentos or Docker fallback) per Graph ID. Dispatcher routes dispatch:claude-code to it. Sessions survive restart. Brief + skills + mcp inside.

**Wave 1**:
- Disk check (df, 90% free?).
- Install/verify rivet-agentos or container equiv on host.
- openTask / dispatcher: inject SUBSTRATE_BRIEF.md, skills, mcp bearer, env for Railway.
- Route: enhance dispatcher stub to spawn for claude-code label.

**Wave 2**:
- Permission ask -> Telegram (reuse stop-notify).
- Track skills inside VM.
- Proof: durable restart, PR sync, brief inside.

**Verification**:
- Disk smoke.
- VM starts, mcp inside reaches substrate.
- Claim/lease works from VM.
- Session restart keeps graph.

**Files**: packages/dispatcher, infra/vps, docs, .planning update.

**Risk**: No KVM; use container path.

See CONTEXT. Execute after gate.
