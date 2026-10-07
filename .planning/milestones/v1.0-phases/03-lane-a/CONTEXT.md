# Phase 3: Lane A - CONTEXT

**Goal**: Sandboxed, durable Claude Code / agent sessions, one VM per Graph ID.

**Depends on**: Phase 2 (claims + leases + dispatcher)

**Current (post P2)**:
- Leases + handoff + dispatcher stub live in code.
- substrate-mcp healthy on Railway.
- Surfaces include rivet.
- rivet-agentos mentioned in plan; no local KVM.

**Success Criteria (from ROADMAP)**:
1. Free disk verified (host ~90%?).
2. rivet-agentos host runs; openTask writes shared skills, SUBSTRATE_BRIEF.md, mcp config to /home/agentos.
3. Dispatcher routes dispatch:claude-code to VM; permissionPolicy ask -> Telegram.
4. claude-ultrathink runs inside VM; kickoff/sync still write Notion/Linear.
**Proof**: Labelled issue opens VM, session survives restart, PR lands, ultrathink-sync closes loop.

**v0.3 SOTA**: Enterprise durable sessions, no data loss on host reboot, A2A cards inside VM, teachable from session.

**Constraints**: No /dev/kvm on host (QEMU out). Use Docker or existing rivet path. Fallback webtop.

**Risks**: VM provisioning, bearer token for mcp inside, network to Railway.

**References**: ROADMAP Phase 3, Notion Build Plan, previous phases.

**Next**: PLAN -> execute (disk check, rivet setup, dispatcher route, proof).
