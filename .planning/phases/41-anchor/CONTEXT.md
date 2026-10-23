---
phase: 41-anchor
requirements: [E-D1, E-D2]
depends_on: [M6, F-D2, E-T4]
status: scoped in-repo on origin/main acb6767. The live devnet proof is operator-gated
---

# 41-CONTEXT: ANCHOR

## Scope (ROADMAP)

- E-D1: anchors appear in the evidence bundle: a tx signature and an explorer link per hour, so PR and incident evidence can be checked outside the system.
- E-D2: teachable moments are anchored with graph id plus an observation digest.

## State on main (acb6767)

- The hourly anchor job exists: `packages/mcp-server/src/anchor.ts` (`runAnchorJob`, line 356), `anchor-run.ts`, and the `anchors` row written by `greptime.ts` `insertAnchor` (line 1642). The live devnet send has never run (`28-VERIFICATION.md`).
- The evidence bundle excluded anchors: `observe.ts` called `verifyGraph(graphId, { anchors: false })`. `packages/evidence/src/report.ts` had no anchor field and listed the anchor as a Phase 6 pending gap.
- No explorer link was generated anywhere in the repo.
- A teachable is a ledger event (`teachable.ts`, `service.ts:2019-2022`) carrying `graph_id`, `session_id` and `content_sha256`. Each sits inside an hour root that the hourly anchor covers.

## Decisions (conservative defaults, stated here)

- D41-1. The bundle gains `anchors`: one entry per hour in the graph's verify report, `{period_start, period_end, status, root, event_count, tx_sig, slot, explorer_url}`. `tx_sig`, `slot` and `explorer_url` are absent for an hour with no anchor.
- D41-2. The explorer URL is the Solana devnet transaction page for `tx_sig`: `https://explorer.solana.com/tx/<sig>?cluster=devnet`, built locally, with no network call.
- D41-3. The memo format `period_start|root|count` does not change. A format change needs its own decision.
- D41-4. E-D2 is met by listing each teachable in the bundle with `graph_id`, `session_id` (when present), `event_id`, `content_sha256` (the observation digest), its hour, and that hour's `tx_sig` and `explorer_url`. A teachable counts as anchored when its hour is anchored and its event sits inside the hour root, which is the existing verify rule. No DB or memo schema change.
- D41-5. Fail closed, using the verify layer's own statuses. An hour is `pending` while it has no anchor row and still sits inside the verify window (3 hours after it closes, or it has not closed yet). After that window, a missing anchor is `unanchored`, which verify already fails, and the bundle marks it `unverified`. A `mismatch` or `unverified` hour is also `unverified`. `substrate evidence` exits non-zero when any hour is `unverified`. A `pending` hour does not fail.
- D41-6. Anchor data is read through the existing `verifyGraph` with an injected RPC, so tests use a fake RPC, as `teachable-anchor.test.ts` does.

## Out of scope

- Running the live devnet send, funding a key, or installing the hourly timer on the host. These are operator-gated (`docs/agent-cards.md` G1 to G3; `29-CONTEXT.md`).
- Any change to the memo format, the anchor DDL, or the signer.

## Operator-gated (not run by agents)

- A funded devnet key and its path (`SOLANA_ANCHOR_KEYPAIR`), and `SOLANA_ANCHOR_PUBKEY`.
- The live proof: a teachable written into production, the hourly timer anchoring its hour, and `substrate verify` reporting that hour as anchored.
