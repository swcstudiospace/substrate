# Legacy phase drafts: disposition (corrected)

Scope: phase plans present in git history at `616dd10` under `.planning/phases/` that are absent from the v1.3 archive (`.planning/milestones/v1.3-phases/`), plus archived or legacy material found by the planning inventory. The archive is unchanged by this note. Rules: RESTORE = incomplete, archived, no supersession marker. ALREADY_DONE = the SUMMARY shows completion. DISPUTED = superseded, dropped, or unclear. DISPUTED items raise SCOPE_CHANGE requests and are not revived.

| Source | Disposition | Reason |
| --- | --- | --- |
| 22-05 (SUMMARY, wave 4) | ALREADY_DONE | SUMMARY reports complete; skills-plane smoke 10/10 |
| 22-06 (plan only, wave 5; `22-PROOF.md` never written) | RESTORE, blocked on live approval | Open operator step with no supersession marker. Owner merge and live sync stay held in the v1.3 audit. |
| 24-05 (TypeScript dispatcher entry, wave 5) | DISPUTED (dropped) | Removed with the TypeScript dispatcher package in `5aa4494` (PR #69). The Python dispatcher is the implementation. |
| 24-06 (plan only, wave 6) | DISPUTED (superseded) | DISP-08 passed as a bounded live window on 2026-10-12 (v1.3 audit). |
| 25-04 (SUMMARY, wave 3) | ALREADY_DONE | `docs_search` and `docs_ingest` are registered in `packages/mcp-server/src/mcp.ts`. |
| 25-05 (SUMMARY, wave 4) | ALREADY_DONE for the CLI; timer clause DISPUTED | D25-07 rules out new timers. Only the canary timer exists in `infra/vps`. |
| 25-06 (SUMMARY, wave 5) | ALREADY_DONE | `scripts/docs-smoke.ts` present; the audit records both missing artifacts complete. |
| 29-01 to 29-03 | ALREADY_DONE | Archived roadmap: 3/3 plans complete. |
| 13 and 14 drafts (deleted in `427eb78`) | ALREADY_DONE | Moved to the v1.2 archive. |
| v1.0 stub phases 0.5 and 3–6 | DISPUTED (superseded by phases 21–33) | Stub wording with no check counts; phase 0.5 has no SUMMARY. |
| `uplift-6/` (no SUMMARY) | DISPUTED (status unknown) | Not recorded in STATE. |
| `SELF_IMPROVING_MEMORY_BANK_PROPOSAL.md` (deleted in `ed82266`) | DISPUTED (not phase material) | Not a phase artifact. |

Still open, and not closed by this note: the 43 gated live behaviors in the v1.3 audit, and the disclosed Cursor credential rotation. Both are operator-gated. The full inventory and conflict list are in `.planning/uplift-7/PLANNING-INVENTORY.md` on the docs branch.
