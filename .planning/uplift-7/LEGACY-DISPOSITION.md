# Legacy phase drafts: disposition

Scope: phase plans present in git history at `616dd10` under `.planning/phases/` that are absent from the v1.3 archive (`.planning/milestones/v1.3-phases/`). The archive is unchanged by this note.

| Draft | Disposition | Evidence |
| --- | --- | --- |
| 22-05 (skills plane smoke, wave 4) | Superseded | `scripts/skills-sync-smoke.ts` and `scripts/skills-sync-smoke-bridge.py` exist on main. The v1.3 audit records the skills-plane regression at 18/18. |
| 22-06 (SKILL-07 operator proof, wave 5) | Open | Live operator step. `22-PROOF.md` was never written. `docs/skills-plane.md` exists. The owner merge and live sync stay held in the v1.3 audit. |
| 24-05 (TypeScript dispatcher entry, wave 5) | Superseded | PR #69 removed the TypeScript dispatcher package. The Python dispatcher (`packages/dispatcher/src/substrate_dispatcher/`) is the implementation, with `scripts/dispatcher-smoke.ts`. |
| 24-06 (DISP-08 operator proof, wave 6) | Superseded | DISP-08 closed as a bounded live window on 2026-10-12 (v1.3 audit). |
| 25-04 (docs MCP and REST wiring, wave 3) | Superseded | `docs_search` and `docs_ingest` are registered in `packages/mcp-server/src/mcp.ts`, as plans 25-01 and 25-02 specify. |
| 25-05 (docs refresh timer, wave 4) | Superseded | D25-07: no new timers. The refresh hooks fast-forward evidence, so no `substrate-docs-refresh` unit exists. |
| 25-06 (docs smoke and rehearsal env, wave 5) | Complete locally | The v1.3 audit records both missing artifacts complete: `scripts/docs-smoke.ts` and the owned RAGFlow fixture lifecycle. |
| 29-01 to 29-03 | Complete | Archived roadmap: 3/3 plans complete. |

Still open, and not closed by this note: the 43 gated live behaviors in the v1.3 audit, and the disclosed Cursor credential rotation. Both are operator-gated.
