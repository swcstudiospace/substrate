---
phase: 39-dispatch
requirements: [C-D2, C-D4]
status: verified in-repo; no product code changed; signing key and live drift run await the operator
---

# 39-SUMMARY: DISPATCH

## Built

Nothing new in product code. The phase verifies what the U3 work (SPE-10477) already built, and records the evidence: the pre-launch drift gate, and the signed, replayable handoff packet.

## Decisions

- **Issue prose stays out of the packet (DISP-07).** The operator chose this on 2026-10-21, over carrying the issue title and DoD section. C-D2's "goal from the issue" is met by the issue identifier and the fixed DoD lines. REQUIREMENTS.md and ROADMAP.md now say so.

## Known gaps

- "Signed" needs `SUBSTRATE_HANDOFF_KEY` set on the server. Without it, packets are recorded as unsigned (`status: "unsigned"`). Provisioning the key is operator work.
- The live drift run on a Lane B worktree has not run.
- `.planning/UPLIFT_PROPOSAL.md` (line 46, per the read-only map) says the dispatcher uses neither mechanism. That statement is stale against this tree. It is recorded here and not edited.

## Post-merge corrections (phases 37 and 38)

- STATE, ROADMAP and REQUIREMENTS said phases 37 and 38 were in review. Both are merged: PR #89 at a1b7152, and PR #90 at 1d4e4aa. Corrected in this phase's PR.
