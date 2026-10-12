# Roadmap: Agent Substrate

## Milestones

- ⚠️ **v1.0 build plan (phases 0-6 + 0.5)** — closed 2026-10-01 with known gaps. Archive: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md) · audit: [milestones/v1.0-MILESTONE-AUDIT.md](milestones/v1.0-MILESTONE-AUDIT.md)
- ✅ **v1.1 Swarm correlation, governed memory and orchestrate integrations** — Phases 7-10 with inserted 8.1, shipped 2026-10-07 (ADR 0001 S1 and S3). Archive: [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md)
- ✅ **v1.2 Swarm leases, workspace install and lessons bank** — Phases 11-15, shipped 2026-10-08 (ADR 0001 S2, S4, SPE-5830). Archive: [milestones/v1.2-ROADMAP.md](milestones/v1.2-ROADMAP.md) · audit: [milestones/v1.2-MILESTONE-AUDIT.md](milestones/v1.2-MILESTONE-AUDIT.md)
- **v1.3 Build plan completion** — implementation archived 2026-10-11 (18/18 phases, 76/76 plans); current end-to-end acceptance HELD. Archive: [milestones/v1.3-ROADMAP.md](milestones/v1.3-ROADMAP.md) · current evidence: [VALIDATION.md](VALIDATION.md)

## Phases

<details>
<summary>⚠️ v1.0 build plan (Phases 0-6, with 0.5) — CLOSED 2026-10-01 with known gaps</summary>

- [x] Phase 0: Brief — complete and live
- Phase 0.5: Governance — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 1: Lane B — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 2: Claims and dispatch — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 3: Lane A — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 4: Skills — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 5: Docs and desktop — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 6: Ledger — closed in archive; see [MILESTONES.md](MILESTONES.md)

Phase details: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md) · audit: [milestones/v1.0-MILESTONE-AUDIT.md](milestones/v1.0-MILESTONE-AUDIT.md) · phase folders: `milestones/v1.0-phases/`

</details>

<details>
<summary>✅ v1.1 Swarm correlation, governed memory and orchestrate integrations (Phases 7-10, with 8.1) — SHIPPED 2026-10-07</summary>

- [x] Phase 7: Database structures (1/1 plans) — completed 2026-10-07
- [x] Phase 8: Memory structures (1/1 plans) — completed 2026-10-07
- [x] Phase 8.1: Version conflicts carry the standing version (INSERTED) (1/1 plans) — completed 2026-10-07
- [x] Phase 9: claude-ultrathink integration (1/1 plans) — completed 2026-10-07
- [x] Phase 10: Swarm orchestrate integration (1/1 plans) — completed 2026-10-07

Phase details: [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md) · requirements: [milestones/v1.1-REQUIREMENTS.md](milestones/v1.1-REQUIREMENTS.md) · audit: [milestones/v1.1-MILESTONE-AUDIT.md](milestones/v1.1-MILESTONE-AUDIT.md) · phase folders: `milestones/v1.1-phases/`

</details>

<details>
<summary>✅ v1.2 Swarm leases, workspace install and lessons bank (Phases 11-15) — SHIPPED 2026-10-08</summary>

- [x] Phase 11: Lease authority (1/1 plans) — completed 2026-10-07
- [x] Phase 12: Swarm lease bridge (1/1 plans) — completed 2026-10-07
- [x] Phase 13: Signed handoffs (1/1 plans) — completed 2026-10-07
- [x] Phase 14: Workspace install (1/1 plans) — completed 2026-10-07
- [x] Phase 15: Lessons bank (1/1 plans) — completed 2026-10-07

Phase details: [milestones/v1.2-ROADMAP.md](milestones/v1.2-ROADMAP.md) · requirements: [milestones/v1.2-REQUIREMENTS.md](milestones/v1.2-REQUIREMENTS.md) · audit: [milestones/v1.2-MILESTONE-AUDIT.md](milestones/v1.2-MILESTONE-AUDIT.md) · phase folders: `milestones/v1.2-phases/`

</details>

## v1.3 archive and current acceptance hold

The approved phase details, plans and source-completion history live in
[milestones/v1.3-ROADMAP.md](milestones/v1.3-ROADMAP.md),
[milestones/v1.3-REQUIREMENTS.md](milestones/v1.3-REQUIREMENTS.md) and
`milestones/v1.3-phases/`. There are no active implementation phases here;
GSD must not propose replaying archived Phase 16 because its active directory
was moved by the existing archive. Historical totals remain 18 phases,
76 plans and 68 requirements. No new milestone has been opened.

**Current acceptance: human needed, not waived.** The user retains real-proof
criteria. The historical 43 live remainders, separately held Phase 20 evidence
and MIRROR-08, and the disclosed credential rotation remain open. Reachable
current source integration repairs are verified and locally committed on the
isolated correction branch; green local checks are not production acceptance.
See [VALIDATION.md](VALIDATION.md) for current proof and operator gates. Do not
repeat milestone completion/cleanup, recreate active plans, or start a next
milestone to hide the remaining acceptance work.

Live acceptance progress 2026-10-12 (operator-approved windows): MIRROR-08 and
DISP-08 cleared on production; UAT scenarios 1/3/4/7/8 live-pass; docs G1/G2
live-pass on RAGFlow v0.27.1; Hindsight governance, Dragonfly hit and outage
arms live-pass; Lane A doors/boot/rollback proven with four named turn-chain
prerequisites. The two older missing docs proof artifacts are shipped in the isolated
correction tree: `--ragflow-fixture` and `scripts/docs-smoke.ts`, with actual
named docs82/82 and skills18/18 proof. Final local checks are Bun3355/58/0,
Python246,types0 and phase-close119/0. The user explicitly retained the
consolidated docs API/local manifests/last-five manifests and superseded only
the older dry_run/RAGFlow-rebuild/physical-deletion source clauses; real live
gates remain required. Native discovery still has0 active phases and no next
phase; this is not0 archived phases and does not authorise re-completion.
