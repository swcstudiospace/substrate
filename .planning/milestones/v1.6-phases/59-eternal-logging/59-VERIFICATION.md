---
phase: 59-eternal-logging
verified: 2026-11-18T00:00:00Z
status: human_needed
score: 6/6 roadmap success criteria verified in the repository (offline, targeted tests green); live devnet proof not run (operator-gated)
behavior_unverified: 0
overrides_applied: 0
covered_files: [".planning/milestones/v1.6-phases/59-eternal-logging/CONTEXT.md", ".planning/milestones/v1.6-phases/59-eternal-logging/SUMMARY.md", "packages/ledger/src/devnet-reset.ts", "packages/ledger/src/merkle-proof.ts", "packages/ledger/src/rpc.ts", "packages/ledger/src/signer-set.ts", "packages/mcp-server/src/anchor-verify-deps.ts", "packages/mcp-server/src/checkpoint-verify.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/reanchor-plan.ts", "packages/mcp-server/src/reanchor-run.ts", "packages/mcp-server/src/reanchor.ts"]
covered_digest: "v3:sha256:7323aa6c6550661f96f4f33fda16a55544a0eb43752c6f3fd9f53c37492e2794"
human_verification:
  - test: "Run the operator-gated devnet round trip: fund the anchor key, run one anchor cycle, then call checkpoint_verify on a checkpoint in that hour"
    expected: "The verdict is anchored, with the devnet transaction's memo equal to the stored root and event count"
    why_human: "Needs a funded devnet key and a live cluster; nothing in this record sent a transaction"
  - test: "Confirm the live devnet genesis hash still equals DEVNET_GENESIS_HASH (EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG) before any anchor send"
    expected: "getGenesisHash returns the constant; a different value is classified reset-suspected, not tampering"
    why_human: "Live network read; the constant was last checked read-only on 2026-10-26"
  - test: "If a devnet reset is ever observed, follow docs/runbooks/devnet-reset-and-reanchor.md: dry-run the plan, then run reanchor-run.ts --execute by hand"
    expected: "Dry run prints the plan with no send; --execute records one anchor.reanchor note per hour and leaves no duplicate anchors row"
    why_human: "The executor has never run against any cluster; the replace-or-ignore behaviour of the anchors table is UNVERIFIED"
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 59: Eternal logging, verifiable checkpoint and rollback events on Solana devnet — Verification

**Phase Goal:** Every checkpoint and rollback is a ledger event that is provably inside an hourly root anchored on Solana devnet, verifiable without trusting the substrate; devnet resets and signer changes are detected and recoverable. Roots only, devnet only.
**Verified:** 2026-11-18
**Status:** human_needed
**Re-verification:** No. A prior record exists at `VERIFICATION.md` in this directory (2026-10-28, status human_needed). This record was written independently against HEAD `357d6b15` (branch `gsd/autonomous-rerun`); it does not reuse that record's claims.

## Method

- Read the roadmap entry (`gsd-tools query roadmap.get-phase 59`) and the phase directory, which resolves to `.planning/milestones/v1.6-phases/59-eternal-logging/` (the phase is archived under v1.6; `.planning/phases/59*` does not exist).
- Checked every cited file and symbol exists at HEAD, and grepped for the send call sites and the operator gate.
- Ran the targeted tests named by the criteria: `packages/ledger/src/{merkle-proof,devnet-reset,signer-set,rpc}.test.ts` (99 pass, 0 fail) and `packages/mcp-server/src/{checkpoint-verify,reanchor-run,config-anchor-signer-set}.test.ts` (106 pass, 0 fail). No live network call was made and no transaction was sent.
- SUMMARY.md was read only as a pointer to code; each claim below rests on a file or test at HEAD.

## Success Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Merkle inclusion proof verifies against the hourly root for every tree size and index; tampering fails | ✓ VERIFIED | `packages/ledger/src/merkle-proof.ts` (`merkleAuditPath`, verify); `merkle-proof.test.ts:30` "every index of every size 1..40 verifies against merkleRootHex…" and `:84` "verification fails for a flipped leaf, a flipped path element, a wrong index, a different root". Passed in the targeted run. Root is `merkleRootHex` in `packages/ledger/src/merkle.ts:44`. |
| 2 | Checkpoint verification resolves a checkpoint to hour root, proof, `anchors` row and devnet tx; reports exactly one of anchored, pending, unanchored, unverified, mismatch | ✓ VERIFIED (offline, fakes) | `CHECKPOINT_VERIFY_STATUSES = ["anchored","pending","unanchored","unverified","mismatch"]` at `packages/mcp-server/src/checkpoint-verify.ts:47`; exposed as the `checkpoint_verify` tool (`mcp.ts:975`, `observe.ts:650`). Ports wired in `anchor-verify-deps.ts`. `checkpoint-verify.test.ts` `describe("anchored: a proof for every tree size 1..17 at every index")` passes. |
| 3 | A mainnet/testnet devnet RPC URL is refused at config load and at RPC construction, beside the genesis gate | ✓ VERIFIED | `assertDevnetRpcUrl` at `packages/ledger/src/rpc.ts:32` (refuses non-http(s), userinfo, fragment, mainnet/testnet host); called in `createRpc` at `rpc.ts:144`, and in `readSolana` at `packages/mcp-server/src/config.ts:906`, which sets `solana.problem` (the config does not load a refused URL). Consumers honour it: `anchor-run.ts:40` exits, `reanchor-run.ts:252` and `reanchor-plan-run.ts:479` refuse, `anchor-verify-deps.ts:160` answers unverified. Genesis gate still present at `packages/mcp-server/src/anchor.ts:251,286`. `rpc.test.ts` `describe("assertDevnetRpcUrl (defence in depth…)")` passes. |
| 4 | Signer set with validity windows accepts rotated-key anchors and rejects others; a rotation is a ledger event | ✓ VERIFIED | `packages/ledger/src/signer-set.ts`: `parseSignerSet` (:152), `acceptsSigner` by block time (:183), `ANCHOR_SIGNER_ROTATE_ACTION = "anchor.signer.rotate"` (:20), rotation draft builder (:253). `signer-set.test.ts` `describe("parseSignerSet")`, `describe("acceptsSigner")`, `describe("rotation payloads and event drafts")` pass. Bootstrap `SUBSTRATE_ANCHOR_SIGNER_SET` read in `config.ts` (`readAnchorSignerSet`) and `anchor-verify-deps.ts:208`. Retired-signer check at `anchor-verify-deps.ts:530`. `config-anchor-signer-set.test.ts` passes. |
| 5 | Devnet reset classified apart from tampering; re-anchor procedure with dry-run exists; chain documented as evidence, not storage | ✓ VERIFIED (offline, fakes) | Classification: `packages/ledger/src/devnet-reset.ts:59` `classifyChainEvidence`, verdicts `ok / reset-suspected / chain-unreachable / signature-missing` (:19), with the rule that the last three are unverified, never mismatch (:10-11); `devnet-reset.test.ts:20` passes. Re-anchor: `packages/mcp-server/src/reanchor.ts` (`parseSavedPlan` :236, `dryRunReanchor` :306, guarded `executeReanchor`); `reanchor-run.ts:85` makes a dry run unless `--execute`; `reanchor-plan.ts` / `reanchor-plan-run.ts` plan read-only. Documentation: `docs/runbooks/devnet-reset-and-reanchor.md:13` "Devnet is evidence of a root, not storage"; `docs/ussr-integration.md:12` "the chain is evidence, not storage". The send path (`reanchor.ts:718` `sendMemo`) is reached only through `executeReanchor`, which requires `--execute` and `--confirm-genesis`. It has never run against a cluster. |
| 6 | No transaction sent by this phase's code outside operator-run steps; runbook exists | ✓ VERIFIED | No send call in the verifier, planner or dry-run modules (`checkpoint-verify.ts`, `anchor-verify-deps.ts`, `reanchor-plan*.ts`). The only new send is `reanchor.ts:874` inside `executeReanchor`, reached only from `reanchor-run.ts --execute`. `reanchor-run.test.ts:526` "the only calls that can change anything are the two runner calls and the one note" and `:558` "the entry builds the one real runner and sends only through the orchestrator" pass. `reanchor-run.ts` is documented as operator-only (`docs/runbooks/devnet-reset-and-reanchor.md:127`). Runbooks present: `anchor-chain-outage.md`, `anchor-signer-rotation.md`, `devnet-reset-and-reanchor.md`. |

**Score:** 6/6 criteria verified in the repository. No criterion is a gap.

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/ledger/src/merkle-proof.ts` | proof build and verify | ✓ VERIFIED | exists, substantive, tested |
| `packages/ledger/src/devnet-reset.ts` | chain classification | ✓ VERIFIED | exists, substantive, tested |
| `packages/ledger/src/signer-set.ts` | signer windows and rotation | ✓ VERIFIED | exists, substantive, tested |
| `packages/ledger/src/rpc.ts` | devnet URL guard | ✓ VERIFIED | `assertDevnetRpcUrl` called at construction |
| `packages/mcp-server/src/checkpoint-verify.ts` | five-status verdict | ✓ VERIFIED | exists, tested, registered as tool |
| `packages/mcp-server/src/anchor-verify-deps.ts` | verifier ports, signer set, pointer rule | ✓ VERIFIED | `newestBoundNote` at :342 |
| `packages/mcp-server/src/reanchor.ts` | guarded re-anchor executor | ✓ VERIFIED | dry run default; send only under execute |
| `packages/mcp-server/src/reanchor-run.ts` | operator entry | ✓ VERIFIED | `--execute` gated; leaf entry |
| `packages/mcp-server/src/config.ts` | URL refusal and signer-set env at load | ✓ VERIFIED | `readSolana` :898-920 |
| `docs/runbooks/devnet-reset-and-reanchor.md` (+ 2 more) | operator steps | ✓ VERIFIED | present; live steps marked operator-run |

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `config.ts readSolana` | `rpc.ts assertDevnetRpcUrl` | call at load, result into `solana.problem` | ✓ WIRED | consumers refuse on a non-null problem |
| `createRpc` | `assertDevnetRpcUrl` | call at construction | ✓ WIRED | `rpc.ts:144` |
| `checkpoint_verify` tool | `checkpoint-verify.ts` | `mcp.ts:975` | ✓ WIRED | |
| `executeReanchor` | `sendMemo` | direct call after gates | ✓ WIRED | reachable only via `--execute` |
| `reanchor-run.ts --execute` | `executeReanchor` | `reanchor-run.ts:93` | ✓ WIRED | |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Merkle proofs verify for all sizes/indices, tampering fails | `bun test packages/ledger/src/merkle-proof.test.ts` | pass (part of 99/0) | ✓ PASS |
| Devnet reset classified, not mismatch | `bun test packages/ledger/src/devnet-reset.test.ts` | pass | ✓ PASS |
| Signer set windows and rotation | `bun test packages/ledger/src/signer-set.test.ts` | pass | ✓ PASS |
| RPC guard | `bun test packages/ledger/src/rpc.test.ts` | pass | ✓ PASS |
| Verdicts, proofs at every index, config problem | `bun test packages/mcp-server/src/checkpoint-verify.test.ts` | pass (part of 106/0) | ✓ PASS |
| Re-anchor only sends through the operator entry | `bun test packages/mcp-server/src/reanchor-run.test.ts` | pass | ✓ PASS |

Targeted runs only, not the full suite.

## Anti-Patterns and Observations

| File | Observation | Severity | Impact |
|------|-------------|----------|--------|
| `packages/mcp-server/src/anchor.ts:758-825` | The anchor job (phase 41, not phase 59 code) sends memo transactions. Its timer is `infra/vps/substrate-anchor.timer`. | ℹ️ Info | Not a phase 59 breach. Criterion 6 concerns this phase's code. Whether the timer is installed on any host was not checked here; the prior record says it is not [INFERENCE]. |
| Commits after `b19ff515` | `330507a6` (re-anchor v2 check), `83779a1d` (memo v2, phase 73), and `config.ts` +326 lines since the last record change code this phase covers. The targeted tests still pass at HEAD. | ℹ️ Info | The phase 59 decision "memo v1 stays" is now partly superseded by v2 for hours with graph-owned events. Not a criterion failure. |
| `packages/ledger/src/reanchor-plan.ts` | Cited in the prior record under `ledger/src`; it actually lives in `packages/mcp-server/src/`. | ℹ️ Info | Documentation path only. |

No TODO, stub, or placeholder markers found in the phase's covered files.

## Human Verification Required

### 1. Live devnet round trip

**Test:** Fund the anchor key, run one anchor cycle, then call `checkpoint_verify` on a checkpoint in that hour.
**Expected:** Verdict `anchored`; the devnet memo equals the stored root and event count.
**Why human:** Needs a funded key and a live cluster. Nothing here sent a transaction.

### 2. Live genesis hash check

**Test:** Read `getGenesisHash` from the configured devnet RPC before any send.
**Expected:** Equals `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. A different value must read `reset-suspected`.
**Why human:** Live network read. The constant was last checked read-only on 2026-10-26.

### 3. Re-anchor executor against a real cluster

**Test:** If a devnet reset is observed, follow `docs/runbooks/devnet-reset-and-reanchor.md`: dry-run, then `reanchor-run.ts --execute --confirm-genesis <hash>` by hand.
**Expected:** The dry run sends nothing. Execute records one `anchor.reanchor` note per hour with no duplicate `anchors` row.
**Why human:** Never executed against any cluster. Whether a second `anchors` insert replaces or is ignored is UNVERIFIED.

## Gaps Summary

No gaps. All six roadmap success criteria are verified in the repository by file, symbol and targeted test. The status is `human_needed` because the three items above are operator-gated live steps: the phase goal says "anchored on Solana devnet", and no live anchor has ever been sent.

---

_Verified: 2026-11-18_
_Verifier: Claude (gsd-verifier)_
