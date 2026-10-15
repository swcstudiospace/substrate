# Planning inventory (uplift-7, wave 1 / n1)

Date: 2026-10-15. Read-only. Sources: `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/milestones/`, `.planning/uplift*/`, and git history for `.planning/phases/` at `616dd10`.

## Phase state

- ROADMAP lists phases 0–33 as complete, with a progress table summing to 76 plans. Phase 0.5 and phases 1–6 are closed in the v1.0 archive.
- The v1.3 audit (2026-10-12) is newest. It records `gaps_found` and `human_needed`, with 43 live behaviors unverified (`milestones/v1.3-MILESTONE-AUDIT.md`).
- STATE.md frontmatter: 18/18 phases and 76/76 plans complete, current_phase 33, status "Awaiting next milestone", archived 2026-10-11. Its Session Continuity section (line 177) is stale and stops at phase 18 (10-08). Current progress comes from the frontmatter and the v1.3 audit.
- Decision: the newest evidence wins. The audit governs v1.3. No completed phase is rewritten.

## Conflicts (top items; all 15 were recorded in the inventory run)

| Item | ROADMAP | Newer evidence | Verdict |
| --- | --- | --- | --- |
| v1.3 status | "in progress" in the header, every phase `[x]` below it | audit `gaps_found`, 2026-10-12 | Audit governs |
| Phase 16 parity | `[x]` | audit holds production parity | Open |
| Phase 20 UAT | `[x]`, "eight scenarios pass" | audit: scenarios 1/3/4/7/8 pass, 2/5/6 held | Open |
| Phase 23 MIRROR-08 | operator-gated | audit: satisfied live 2026-10-12 | Passed |
| Phase 24 DISP-08 | operator-gated | audit: satisfied live 2026-10-12 | Passed |
| Phase 28 anchor | `[x]` | audit: ANCHOR-06 partial; devnet balance 0 lamports | Blocked |
| Phases 31–33 | `[x]` | audit: LANEA-01/03/06/08 partial | Partial |
| Plan counts | "Plans: TBD" in ten places | progress table sums to 76 | ROADMAP detail stale |
| Uplift series | STATE lists series 2–5 | `uplift-6/` exists; STATE has no U6 rows | STATE missing series 6 |

## Coverage of the appended workstreams

| Workstream | Covered by an active phase? | Evidence |
| --- | --- | --- |
| Substrate hardening | No | Post-close uplift rows only, not phases |
| Usage panel | No | Zero hits |
| Omp UI | No | Keyword only |
| Solana ledger | Partly | Phases 27–28 cover the devnet anchor; live proof held |
| SVM feasibility | No | Zero literal "SVM" hits; the matches are CPU flags |

Default applied: the three uncovered workstreams are recorded as uplift-7 artifacts, not appended to `ROADMAP.md`. Reason: `UPLIFT_PROPOSAL.md:7` sets the post-close convention as standalone artifacts with STATE progress entries and no new ROADMAP milestone. This conflicts with the spec's append rule, so it is listed for closeout as a SCOPE_CHANGE.

## Legacy and archived material (corrected)

The earlier note (`LEGACY-DISPOSITION.md`, on PR #70) was right on most drafts. The corrected dispositions follow the spec's rules: RESTORE is incomplete and archived with no supersession marker, ALREADY_DONE means the SUMMARY shows completion, and DISPUTED means superseded, dropped, or unclear.

| Source | Disposition | Reason |
| --- | --- | --- |
| 22-05 (SUMMARY, `616dd10`) | ALREADY_DONE | SUMMARY reports complete; skills-plane smoke 10/10 |
| 22-06 (plan only; `22-PROOF.md` never written) | RESTORE, blocked on live approval | Open live step with no supersession |
| 24-05 (TypeScript entry) | DISPUTED (dropped) | Removed with the TypeScript dispatcher in `5aa4494` (#69) |
| 24-06 (plan only) | DISPUTED (superseded) | DISP-08 passed live 2026-10-12 |
| 25-04 (SUMMARY) | ALREADY_DONE | `docs_search` and `docs_ingest` are registered in `mcp.ts` |
| 25-05 (SUMMARY) | ALREADY_DONE for the CLI; timer clause DISPUTED | D25-07 rules out new timers; only the canary timer exists |
| 25-06 (SUMMARY) | ALREADY_DONE | `scripts/docs-smoke.ts` present; audit records the artifacts complete |
| 29-01..03 | ALREADY_DONE | Archived roadmap: 3/3 complete |
| 13 and 14 drafts (moved to `milestones/v1.2-phases/` by the commit "docs(milestone): complete and archive milestone v1.2") | ALREADY_DONE | Archived with their SUMMARY files (13-01, 14-01) and 13-VERIFICATION. Not in the earlier note. |
| v1.0 stub phases 0.5, 3–6 | DISPUTED (superseded by 21–33) | Stub wording; no check counts. Not in the earlier note. |
| `uplift-6/` (no SUMMARY) | DISPUTED (status unknown) | Not in the earlier note. |
| `SELF_IMPROVING_MEMORY_BANK_PROPOSAL.md` | DISPUTED (not phase material) | Not in the earlier note. |

DISPUTED items raise SCOPE_CHANGE requests and are not revived.

## Command names (for PHASE_LOOP)

- Discuss: `gsd-discuss-phase`. Plan: `gsd-plan-phase`. Execute: `gsd-execute-phase`. All three appear in the available skill list. `gsd-autonomous/SKILL.md` names only the plan command explicitly. Its referenced workflow file was not read, so the discuss and execute names rest on the skill list.
- Each call is a flat top-level invocation.

## Not done in this step

No phase was run through discuss, plan, and execute. The three uncovered workstreams are done as uplift-7 records and fixes, not as roadmap phases. The MILESTONE_AUDIT, MILESTONE_COMPLETE, and CLEANUP steps are pending. MILESTONE_COMPLETE needs your approval.
