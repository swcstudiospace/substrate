---
phase: 41-anchor
requirements: [E-D1, E-D2]
status: planned against the decisions in 41-CONTEXT
---

# 41-PLAN: ANCHOR

## Tasks

1. **Bundle type.** Add `anchors` and `teachables` to `EvidenceBundle` in `packages/evidence/src/report.ts`. Keep every existing field. Remove only the anchor entry from the Phase 6 pending list.
2. **Explorer URL.** A pure devnet builder (for example `packages/evidence/src/explorer.ts`) with a unit test. Format per D41-2.
3. **Anchors in the bundle.** `observe.ts` `buildGraphEvidence` calls `verifyGraph` with `anchors: true` and the injected RPC. Map each hour to an anchor entry (D41-1). An hour that fails verification is `unverified` (D41-5).
4. **Teachables in the bundle.** List the graph's teachable events from the ledger read that `buildGraphEvidence` already makes. Each carries its hour and that hour's `tx_sig` and `explorer_url` (D41-4).
5. **HTML.** Render the anchors and the teachables in the evidence HTML renderer (`packages/evidence/src/html.ts`).
6. **CLI exit.** `substrate evidence` (`cli/src/index.ts`, around line 352 and 367) exits 1 when any hour is unverified (D41-5). Other exit behaviour is unchanged.
7. **Tests.** (a) An anchored hour carries `tx_sig`, `slot` and `explorer_url`. (b) A pending hour has no `tx_sig`. (c) An unverified hour fails closed and makes the CLI exit 1. (d) The explorer URL format. (e) A teachable carries its `graph_id`, `content_sha256`, hour and `tx_sig`. (f) The HTML renders the anchors. Use the fake-RPC pattern from `teachable-anchor.test.ts`.
8. **Docs.** `docs/greptime-ledger.md` (Anchoring section): anchors are now in the evidence bundle, with the explorer link and the teachable listing. The operator live leg (G1 to G3 in `docs/agent-cards.md`) is unchanged and not run.
9. **Records.** `SUMMARY.md` and `VERIFICATION.md` for this phase.

## Acceptance

- ROADMAP criterion 1 and criterion 2, as written, proven with fake-RPC tests in the repo.
- The live devnet proof is reported as not run and operator-gated.
