---
phase: 41-anchor
verified: 2026-11-12T08:36:13Z
status: human_needed
score: 2/2 roadmap criteria verified in-repo (fake RPC); live devnet proof not run
covered_files: [".planning/milestones/v1.3.x-phases/41-anchor/PLAN.md", ".planning/milestones/v1.3.x-phases/41-anchor/SUMMARY.md", "README.md", "docs/greptime-ledger.md", "packages/cli/src/evidence.test.ts", "packages/cli/src/index.ts", "packages/evidence/src/explorer.test.ts", "packages/evidence/src/explorer.ts", "packages/evidence/src/html.test.ts", "packages/evidence/src/html.ts", "packages/evidence/src/index.ts", "packages/evidence/src/report.test.ts", "packages/evidence/src/report.ts", "packages/mcp-server/src/evidence-anchor.test.ts", "packages/mcp-server/src/observe.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:dc39ab0b60408fc29ea6ddaa3be0fbf33d23fee67923399a55b38636eabfcebd"
behavior_unverified: 0
overrides_applied: 0
re_verification: false
human_verification:
  - test: "Live devnet anchor proof (docs/agent-cards.md G1 to G3): with a funded anchor key, emit a proof teachable, let the hourly timer anchor its hour, read the memo back by tx_sig, then run substrate evidence for that graph."
    expected: "The hour is listed as anchored with its explorer link, the teachable reads anchored: true, and the command exits 0."
    why_human: "Needs a funded devnet key (SOLANA_ANCHOR_KEYPAIR, SOLANA_ANCHOR_PUBKEY), a live devnet send and the host hourly timer. All are operator-gated (29-CONTEXT.md)."
  - test: "Confirm the fail-closed state before the timer runs."
    expected: "Closed hours older than the 3 h verify window with no anchor are marked unverified, and substrate evidence exits 1 for that graph. This is by design (D41-5) and clears once the timer runs."
    why_human: "Depends on host timer state and live devnet reachability, which were not checked."
---

# Phase 41: ANCHOR Verification Report

**Phase Goal:** Hourly anchors appear in the evidence bundle, and teachable moments are anchored.
**Verified:** 2026-11-12T08:36:13Z
**Status:** human_needed
**Re-verification:** No. Fresh verifier run. The prior VERIFICATION.md (2026-10-21) carried no gaps section.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | Anchors appear in the evidence bundle: a tx signature and an explorer link per hour (ROADMAP SC1) | ✓ VERIFIED | `packages/mcp-server/src/observe.ts:952` calls `verifyGraph(graphId, { ...verify, anchors: true })`. `observe.ts:1062-1075` `anchorEvidenceOf` sets `tx_sig` and `explorer_url` on any hour with a transaction. `packages/evidence/src/explorer.ts:11-13` `devnetExplorerTxUrl` builds the devnet tx URL with no network call. `packages/evidence/src/report.ts:159,185` declares `anchors`. Tests: `evidence-anchor.test.ts` "an anchored hour carries its transaction signature, slot and devnet explorer link" (pass); `explorer.test.ts` (pass). |
| 2 | Teachable moments are anchored with graph id plus observation digest (ROADMAP SC2) | ✓ VERIFIED | `packages/mcp-server/src/service.ts:7832` `graphTeachables` reads teachables. `service.ts:7852` recomputes the hash (`tampered`). `observe.ts:963` loads them. `observe.ts:1083-1098` `teachableEvidenceOf` sets `graph_id`, `content_sha256`, `hour`, `anchored` (not tampered and hour anchored), and the hour's `tx_sig` and `explorer_url`. Tests: `evidence-anchor.test.ts` "a teachable carries its graph id, its content digest, its hour and that hour's transaction" and "a teachable altered after its hour was anchored is not anchored" (pass). |
| 3 | Pending hour does not fail; unverified hour fails closed (D41-5) | ✓ VERIFIED | `packages/cli/src/index.ts:521-527` exits 1 on any `unverified` anchor and on nothing else in this check. `anchorEvidenceOf` (`observe.ts:1063`) maps any status other than anchored or pending to `unverified`. Tests: `cli/src/evidence.test.ts` "an hour devnet cannot confirm exits 1…" and "anchored and pending hours exit 0…" (pass). |
| 4 | HTML renders anchors and teachables; older bundles still render | ✓ VERIFIED | `packages/evidence/src/html.ts:100` renderer, anchor rows at `:118`, teachable rows at `:130`, with an "unavailable" row for bundles without the fields. Tests: `html.test.ts` (pass). |

**Score:** 2/2 roadmap criteria verified in-repo. Truths 3 and 4 support SC1 and SC2. No truth depends on a state transition, so none is PRESENT_BEHAVIOR_UNVERIFIED.

### Deferred Items

None.

### Advisory (New Scope, Unevidenced)

None.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/evidence/src/explorer.ts` | Devnet explorer URL builder | ✓ VERIFIED | `devnetExplorerTxUrl` at :11; tests pass |
| `packages/evidence/src/report.ts` | `anchors` and `teachables` on the bundle | ✓ VERIFIED | :159, :161, :185-186 |
| `packages/mcp-server/src/observe.ts` | Anchor and teachable mapping | ✓ VERIFIED | `buildGraphEvidence` :934; `anchorEvidenceOf` :1062; `teachableEvidenceOf` :1083 |
| `packages/mcp-server/src/service.ts` | `graphTeachables` read | ✓ VERIFIED | :7832; tamper check :7852 |
| `packages/evidence/src/html.ts` | Anchor and teachable sections | ✓ VERIFIED | :100, :118, :130 |
| `packages/cli/src/index.ts` | Exit 1 on unverified hour | ✓ VERIFIED | :521-527 |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `observe.ts buildGraphEvidence` | `service.ts verifyGraph` | `verifyGraph(..., { anchors: true })` | ✓ WIRED | `observe.ts:952` |
| `observe.ts buildGraphEvidence` | `service.ts graphTeachables` | call | ✓ WIRED | `observe.ts:963` |
| `observe.ts anchorEvidenceOf` | `evidence/explorer.ts` | `devnetExplorerTxUrl` | ✓ WIRED | `observe.ts:1070` |
| `cli/index.ts cmdEvidence` | bundle `anchors` | `status === "unverified"` filter | ✓ WIRED | `cli/src/index.ts:521` |
| `evidence/html.ts` | bundle `anchors`/`teachables` | render | ✓ WIRED | `html.ts:118`, `:130` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `observe.ts` anchors | `verdict.hours` | `verifyGraph` (ledger and devnet read) | Yes, in tests via fake RPC | ✓ FLOWING |
| `observe.ts` teachables | `graphTeachables` | ledger read | Yes, in tests via scratch ledger | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Explorer, HTML and report evidence tests | `bun test packages/evidence/src/explorer.test.ts packages/evidence/src/html.test.ts packages/evidence/src/report.test.ts` | 39 pass, 0 fail | ✓ PASS |
| CLI evidence exit codes | `bun test packages/cli/src/evidence.test.ts` | 9 pass, 0 fail | ✓ PASS |
| Anchor and teachable bundle | `bun test packages/mcp-server/src/evidence-anchor.test.ts` | 123 pass, 0 fail (no live Postgres or devnet used) | ✓ PASS |

### Probe Execution

No probes declared for this phase.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| E-D1 | 41-PLAN | Anchors in the evidence bundle, with a tx signature and explorer link per hour | ✓ SATISFIED in-repo; live proof PENDING_VALIDATION | Truth 1 |
| E-D2 | 41-PLAN | Teachable moments anchored with graph id and observation digest | ✓ SATISFIED in-repo; live proof PENDING_VALIDATION | Truth 2 |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/service.ts` | — | Phase 41 files were edited by later phases (76 to 78) after f96b448 | ℹ️ Info | The code verified here is HEAD. The Phase 41 functions above are present at HEAD. |

No stubs, placeholder returns or hardcoded data were found in the phase-41 functions read.

### Not Run

- Live Postgres suite (`127.0.0.1:5432` refuses TCP; live index tests not run).
- Full `bun test` and `bunx tsc --noEmit` on HEAD. Only the phase-41 test files listed above were run.
- Live devnet anchor and the hourly timer (operator-gated).

### Human Verification Required

1. **Live devnet anchor proof** (`docs/agent-cards.md` G1 to G3). Needs a funded key and the host timer. Expected: the hour is anchored with its explorer link, the teachable reads `anchored: true`, and `substrate evidence` exits 0.
2. **Fail-closed state before the timer runs.** Hours older than the 3 h window with no anchor show as unverified, so `substrate evidence` exits 1. This is by design (D41-5). Confirm it is understood as expected.

### Gaps Summary

No gaps. Both ROADMAP success criteria are implemented, wired and covered by passing tests. Status is `human_needed` because the live devnet proof, the funded key and the hourly timer are operator-gated and were not run, as the phase requires.

---

_Verified: 2026-11-12T08:36:13Z_
_Verifier: Claude (gsd-verifier)_
