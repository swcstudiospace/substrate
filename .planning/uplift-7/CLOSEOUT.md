# uplift-7 closeout: appended workstreams recorded as uplift artifacts

**Decision (2026-10-21):** recorded as uplift artifacts by the project owner.

All paths are relative to `.planning/` unless shown. Line numbers are from the files on the program branch.

PR facts are the PR numbers, titles, states, and merge dates from `gh pr list` on 2026-10-21. They are labelled "PR facts" below. Where a repo source names a PR differently, the conflict is listed in section 6.

## 1. Decision and reason

- **Convention:** `UPLIFT_PROPOSAL.md:7` makes the seven items "standalone post-close artifacts" with "STATE.md progress entries", and "no new ROADMAP milestone".
- **Path conflict:** `UPLIFT_PROPOSAL.md:7` names `.planning/uplift/`. The directory here is `uplift-7/`. Which name is canonical is **not verified**. `uplift-7/PLANNING-INVENTORY.md:24` notes that `uplift-6/` exists and STATE has no series-6 rows.
- **Scope change:** `uplift-7/MILESTONE-AUDIT.md:9` says "The three workstreams were not appended to ROADMAP.md (default applied; SCOPE_CHANGE pending)." `:11` says "The workstreams are not in ROADMAP.md (SCOPE_CHANGE pending)." This decision closes the pending SCOPE_CHANGE by recording the workstreams as artifacts. It answers `uplift-7/BLOCKING-UNKNOWNS.md:23` (item 17, "Recorded as uplift-7 records, not phases. This is a SCOPE_CHANGE. Confirm.").
- **Reason:** `uplift-7/PLANNING-INVENTORY.md:36`: "Reason: `UPLIFT_PROPOSAL.md:7` sets the post-close convention as standalone artifacts with STATE progress entries and no new ROADMAP milestone."
- **Effect on the audit:** this decision does not change any FAIL. The six FAIL rows stay FAIL (section 3).
- **Conflict:** `ROADMAP.md:79-81` and requirement lines `:442`, `:454`, `:467` put the three substrate gaps into Phases 34-36 inside the v1.3 block, citing uplift-7 audit rows. That conflicts with "not in ROADMAP.md" (`uplift-7/MILESTONE-AUDIT.md:9`). See section 6.

## 2. Workstream table

| Workstream | Status | Evidence | Open item |
| --- | --- | --- | --- |
| Substrate hardening | Partly done (`uplift-7/WAVE-PLAN.md:16`). Open draft PR #85, `feat(security): harden host API, MCP edge, git boundary, redaction, ledger`, head `feat/sota-hardening` (PR facts). PR #85 is mapped here by title only. The title matches only in part, and no uplift-7 source names #85. Not on ROADMAP: `uplift-7/PLANNING-INVENTORY.md:30` ("Substrate hardening", coverage "No", "Post-close uplift rows only, not phases"). | `uplift-7/WAVE-PLAN.md:16`: fixed in PR #72 (oversize `/memory` returns 413; truncated memory flagged) and PR #73 (cross-agent visibility). `uplift-7/MILESTONE-AUDIT.md:22`: PR #73 merged as `33b4677`. `:26`: PR #72 is "on the PR branch, not merged". PR #83 is CLOSED, `feat: 7 SOTA enhancements to Agent Substrate for resource utility`, head `feature/7-sota-enhancements` (PR facts). | U1 invalid-write round trip (`WAVE-PLAN.md:38`); U2 expected-version for skills and docs (`:39`); U3 degraded-mode queue (`:40`). Audit FAILs at `MILESTONE-AUDIT.md:23`, `:24`, `:25`. No date set (`BLOCKING-UNKNOWNS.md:21`, item 15). Whether PR #85 closes U1 to U3 is **not verified**. ROADMAP Phases 34-36 (`ROADMAP.md:79-81`) hold the same three gaps; see section 6. |
| Usage panel | **Inferred** from title. PR #70, `feat(omp): show Agent Substrate usage in the Omp TUI`, MERGED 2026-10-15 (PR facts). The mapping to "usage panel" is an inference from that title. | `uplift-7/PLANNING-INVENTORY.md:31`: "Usage panel", not covered by an active phase, "Zero hits". `uplift-7/MILESTONE-AUDIT.md:30` names PR #70 as the Omp UI evidence. | Whether PR #70 is the usage panel is **not verified** beyond its title. Repo sources also cite #70 for planning material (section 6, conflict 3). |
| Omp UI | Merged: PR #70 (2026-10-15); PR #77, `feat(omp): publish the substrate status for the Omp bar` (MERGED 2026-10-15); PR #82, `fix(omp): drop the substrate footer and below-editor widget` (MERGED 2026-10-20) (PR facts). Audit: six PASS and three WAIVED rows (`uplift-7/MILESTONE-AUDIT.md:34-43`; WAIVED at `:40-42`). Wave status: "Blocked on your STALE decision" (`WAVE-PLAN.md:17`). | `uplift-7/MILESTONE-AUDIT.md:30`: PR #70 at `aad5347`, `bun test packages/projector/omp/` 68 pass. `WAVE-PLAN.md:19`: PR #70 merged as `9cd6bf9`. `WAVE-PLAN.md:12`: capture uses attributed counters (PR #70). PR #77 and PR #82 are not named by any uplift-7 source. | (a) **WP-U5 Omp STALE state.** This record calls it WP-U5; the wave plan names it U5 (`WAVE-PLAN.md:42`): "Only if you choose `POST /events/query` for event times". Still open (`BLOCKING-UNKNOWNS.md:17`, item 11, "Open"). (b) **Conflict.** `WAVE-PLAN.md:54` (2026-10-15 closeout text) says "the footer is the headline, the widget shows the last three omp changes". PR #82 (merged 2026-10-20) dropped the footer and the below-editor widget. The surface after #82 is **not verified**. The footer rows in the audit (`MILESTONE-AUDIT.md:34`, `:35`, `:37`) are 2026-10-15 readings. |
| SVM feasibility | Memo done. Memo PR #71, `docs(planning): uplift-7 SVM feasibility, substrate health, planning inventory` (MERGED 2026-10-15, PR facts). Records PRs #74 to #76 (uplift-7 audit, closeout, and cleanup records; PR facts). Verdicts: `uplift-7/SOLANA-FEASIBILITY.md:37` full validator on Railway "NOT_FEASIBLE_NOW"; `:38` single-node test validator "UNVERIFIED; not recommended"; `:68` "CONDITIONAL_GO: anchor the closed-hour roots to devnet." | `uplift-7/MILESTONE-AUDIT.md:49-54`: memo rows PASS; the "nothing pushed" row WAIVED (`:53`). `WAVE-PLAN.md:13`: memo in PR #71. Conflict: `WAVE-PLAN.md:10` cites #74 as a substrate fix PR (section 6, conflict 4). | Go/no-go VALIDATION_REQUEST: `SOLANA-FEASIBILITY.md:70` (confirm devnet; approve operator steps). Whether it was approved is **not verified**. Railway budget ceiling: `BLOCKING-UNKNOWNS.md:14` (item 8, "Default"). |
| Solana ledger | Phases 27 and 28 are `[x]` on the ROADMAP (`ROADMAP.md:72`, `:73`). Anchor role and verdict: `SOLANA-FEASIBILITY.md:68` CONDITIONAL_GO. Devnet anchor key holds 0 lamports (read 2026-10-12): `milestones/v1.3-MILESTONE-AUDIT.md:48`. ANCHOR-06 is partial (`milestones/v1.3-MILESTONE-AUDIT.md:44-48`). | `milestones/v1.3-MILESTONE-AUDIT.md:48`: "SOLANA_ANCHOR_PUBKEY balance read 0 lamports 2026-10-12 — funded send steps L4/L5/L8 blocked on funding." `WAVE-PLAN.md:20`: "Blocked"; "The key holds 0 SOL. Operator step." `PLANNING-INVENTORY.md:21`: Phase 28 "Blocked". | Fund the anchor key on devnet (`WAVE-PLAN.md:20`; `BLOCKING-UNKNOWNS.md:22`, item 16, "Operator"). Install and enable `substrate-anchor.timer` (`WAVE-PLAN.md:43`; `SOLANA-FEASIBILITY.md:68` condition 2). ANCHOR-06 proof on one closed hour (`WAVE-PLAN.md:43`; `SOLANA-FEASIBILITY.md:68` condition 3). A devnet balance re-read after 2026-10-12 is **not verified**. |

## 3. The six FAIL rows

These rows stay FAIL and are recorded here unchanged. They are not re-graded in this record.

| Line | Section | Criterion (verbatim) | Grade | Audit evidence (summary) |
| --- | --- | --- | --- | --- |
| `uplift-7/MILESTONE-AUDIT.md:9` | Milestone | Every roadmap phase, including appended ones, has CONTEXT, PLAN, and SUMMARY, or is BLOCKED or DEFERRED with a decision request | FAIL | Phases 0 and 0.5 lack SUMMARY and PLAN artifacts. |
| `:11` | Milestone | Each completed phase has STATE.md and ROADMAP.md updates in phase order | FAIL | No roadmap phase completed; no STATE or ROADMAP entry recorded for the workstreams. |
| `:12` | Milestone | Each discuss, plan, and execute step ran as its own flat Skill() call, with no nesting | FAIL | The phase loop was not run for the appended workstreams. |
| `:23` | Substrate | Invalid writes are rejected, with nothing partially persisted | FAIL | Round-trip check not run in an isolated namespace. |
| `:24` | Substrate | A stale concurrent update is rejected or resolved under the documented policy | FAIL | Memory decisions have `expected_version`; skills and docs do not. |
| `:25` | Substrate | With the substrate unavailable, a dependent client finishes degraded; queued writes apply exactly once | FAIL | No queued replay for memory or skills; not tested. |

- The audit's own count, `uplift-7/MILESTONE-AUDIT.md:58`: "Unresolved FAILs: 6 (milestone 3, substrate 3). MILESTONE_COMPLETE is blocked."
- **MILESTONE_COMPLETE was not run** (`uplift-7/MILESTONE-AUDIT.md:3`, `:14`). It needs explicit approval: `:61` "MILESTONE_COMPLETE needs your approval once the FAILs are cleared"; `WAVE-PLAN.md:21` "Blocked on your approval"; `WAVE-PLAN.md:44` (U7, VALIDATION_REQUEST). This record does not run it and does not approve it.

## 4. Open operator decisions and steps

| Item | Source | Owner | State |
| --- | --- | --- | --- |
| WP-U5 Omp STALE state: whether to read `POST /events/query` for event times (source time, not ingest time) | `WAVE-PLAN.md:42`; `:17`; `:52` (question 1); `BLOCKING-UNKNOWNS.md:17` | User (decision) | Open. "Blocked on your STALE decision" (`WAVE-PLAN.md:17`). |
| WP-U6: fund the anchor key on devnet | `WAVE-PLAN.md:20`, `:43`; `BLOCKING-UNKNOWNS.md:22` | Operator | Blocked. Every airdrop attempt rate-limited; key holds 0 SOL (`WAVE-PLAN.md:20`). EXTERNAL_EFFECT (`:43`). |
| WP-U6: install and enable `substrate-anchor.timer` per `infra/vps/README.md` | `WAVE-PLAN.md:43`; `SOLANA-FEASIBILITY.md:68` (condition 2) | Operator | Listed as a remaining step (`WAVE-PLAN.md:32`). Current state **not verified**. |
| WP-U6: ANCHOR-06 proof on one closed hour, in an approved window | `WAVE-PLAN.md:43`; `SOLANA-FEASIBILITY.md:68` (condition 3); `milestones/v1.3-MILESTONE-AUDIT.md:48` | Operator | Listed as a remaining step. Funded steps L4/L5/L8 blocked on funding (`milestones/v1.3-MILESTONE-AUDIT.md:48`). |
| WP-U6: deploy `main` | `WAVE-PLAN.md:43`; `milestones/v1.3-MILESTONE-AUDIT.md:43` | Operator | Listed as a remaining step. The audit says production runs the 2026-10-10 `substrate-mcp` process until a parity restart after the correction PR merges (`:43`). |
| WP-U6: skills timers | `WAVE-PLAN.md:43` | Operator | Listed as a remaining step. Current state **not verified**. |
| WP-U6: Cursor credential rotation | `WAVE-PLAN.md:43`; `milestones/v1.3-MILESTONE-AUDIT.md:56` ("requires operator rotation through the approved two-restart rollout") | Operator | Listed as a remaining step. Current state **not verified**. |
| WP-U6: one live write through Omp (optional) | `WAVE-PLAN.md:43` | Operator | Optional. |
| Devnet target and operator-step approval (VALIDATION_REQUEST) | `WAVE-PLAN.md:50`; `SOLANA-FEASIBILITY.md:70` | User | Approval **not verified**. |
| Closeout questions: (1) STALE from `POST /events/query`? (2) substrate gaps fixed now, or accepted with a date? (3) approve MILESTONE_COMPLETE? (4) confirm the defaults in `BLOCKING-UNKNOWNS.md` | `WAVE-PLAN.md:52` | User | Open. |

WP-U5 is a user decision (`WAVE-PLAN.md:17`).

## 5. Pending decisions in BLOCKING-UNKNOWNS.md

Items 3, 8, 11, 13, and 14. Status and basis are quoted from `uplift-7/BLOCKING-UNKNOWNS.md`. Legend at `:3`: "Default" means "a documented default applied and is still open for your confirmation"; "Open" means "no decision yet".

| Item | Line | Status (quoted) | Basis (quoted) |
| --- | --- | --- | --- |
| 3. Event retention, and who may view it | `:9` | `Default` | "Inherits the substrate's controls. The panel shows counts and names, never record content. Confirm." |
| 8. The Railway budget ceiling | `:14` | `Default` | "$50 per month at test scale. Confirm." |
| 11. Whether the STALE state can be shown | `:17` | `Open` | "It needs an event time, and `/metrics` carries none. `POST /events/query` returns each stored event's `ts`, which is source event time and not a guaranteed server ingest time. Reading it is an option you have not decided." |
| 13. Routine and category gaps | `:19` | `Default` | "Reported, not built." |
| 14. The known-client list source | `:20` | `Default` | "The ten token files in `SUBSTRATE_TOKENS_DIR`, with `omp` always included. Confirm." |

## 6. Source conflicts and unverified items

Conflicts (not resolved in this record):

1. **Directory name.** `UPLIFT_PROPOSAL.md:7` says `.planning/uplift/`. The directory here is `uplift-7/`.
2. **Phases 34-36 in the v1.3 block.** `ROADMAP.md:79-81` (detail `:437-476`) hold the three substrate gaps. Their requirement lines (`:442`, `:454`, `:467`) cite uplift-7 audit rows. `uplift-7/MILESTONE-AUDIT.md:9` and the decision in section 1 say the workstreams are not ROADMAP phases.
3. **PR #70 identity.** PR facts give #70 the title `feat(omp): show Agent Substrate usage in the Omp TUI`. Repo sources also cite #70 for planning material: `uplift-7/MILESTONE-AUDIT.md:10` (LEGACY-DISPOSITION.md is "on PR #70"), `uplift-7/PLANNING-INVENTORY.md:40`, `uplift-7/BLOCKING-UNKNOWNS.md:25`, and `uplift-7/WAVE-PLAN.md:9` ("PRs #70, #71"). Which content is in #70 is **not verified**.
4. **PR #74 identity.** PR facts give #74 as an uplift-7 audit, closeout, or cleanup record. `uplift-7/WAVE-PLAN.md:10` cites #74 as a substrate fix ("Fixes in PRs #72, #73, and #74"). Which is right is **not verified**.
5. **Omp footer and widget.** `uplift-7/WAVE-PLAN.md:54` (2026-10-15) describes a footer and widget. PR #82 (merged 2026-10-20) dropped both (section 2).
6. **Labels.** This record writes WP-U5 and WP-U6. `uplift-7/WAVE-PLAN.md` writes U5 and U6 (`:42`, `:43`). This is a label difference only.

Not verified:

- **PRs #77, #82, #83, #85**: no uplift-7 or v1.3 source names them. Their numbers, titles, states, and dates come only from the PR facts at the top of this record, checked with gh on 2026-10-21.
- **PRs #72 and #73**: only `uplift-7/MILESTONE-AUDIT.md:22`, `:26` and `uplift-7/WAVE-PLAN.md:10`, `:16` state their status. They are not in the PR facts at the top of this record.
- **Usage panel**: the mapping of PR #70 to "usage panel" is an inference from its title (section 2).
- **Substrate hardening**: the mapping of PR #85 is by title only. Whether it resolves U1 to U3 is unknown.
- **Omp surface after PR #82**: not verified.
- **VALIDATION_REQUEST approval** (`SOLANA-FEASIBILITY.md:70`): not verified.
- **Devnet balance after 2026-10-12**: not verified.
- The seven SOTA enhancements are covered by the v1.5 program (ROADMAP phases 45-51), not by this record.

## 7. Verification

This record is documentation only. Only read-only `cat`, `grep`, and `awk` were run. No tests, tsc, lint, gsd-tools, or git state changes were run.
