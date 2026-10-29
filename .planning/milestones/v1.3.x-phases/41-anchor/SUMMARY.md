---
phase: 41-anchor
requirements: [E-D1, E-D2]
status: in review (draft PR). Both criteria pass in-repo with fake-RPC tests. The live devnet proof is operator-gated and not run
---

# 41-SUMMARY: ANCHOR

## Built

- The evidence bundle carries `anchors`: one entry per hour of the graph's verify report, with `status` (`anchored`, `pending` or `unverified`), `root`, `event_count`, and for anchored hours `tx_sig`, `slot` and `explorer_url`. `explorer_url` is the devnet transaction page, built locally. An unverified hour carries its verify `reason`.
- The bundle carries `teachables`: each teachable moment with `graph_id`, `session_id` (when present), `event_id`, `content_sha256` (the observation digest), its `hour`, `anchored`, and that hour's `tx_sig` and `explorer_url`. A teachable whose stored content no longer matches its stored hash is not anchored, with reason `tampered`.
- The evidence HTML renders both sections. `substrate evidence` exits 1 when an hour is `unverified`.
- The Phase 6 pending entry for the anchor is removed. The bundle no longer reports the anchor as missing.

## Decisions

- D41-1 to D41-6 as recorded in 41-CONTEXT.
- D41-5 is stated precisely there: `pending` means inside the verify window (3 hours after the hour closes). After the window a missing anchor is `unanchored`, which verify already fails, so the bundle marks it `unverified`. This keeps the existing verify rule.

## Review fixes (PR #93, commit f96b448)

- **F1, budget.** `substrate evidence` posts with the verify budget (`SUBSTRATE_VERIFY_TIMEOUT_MS`) plus a 5 s response margin, instead of the 1,500 ms default. The server budget is unchanged. An hour past the budget stays `unverified` with its reason, so the bundle fails closed rather than passing silently.
- **F2, tampered teachable.** `graphTeachables` recomputes each teachable event's hash from its stored content, using the same hashing as `verifyChain`. A mismatch is reported as `tampered` and not anchored. The hour's transaction is still shown, because it is a fact about the hour.
- **F3, older bundles.** A bundle from a server that predates `anchors` and `teachables` renders. The HTML says that anchor data is unavailable from that server.

## Behaviour changes to review

- **Devnet reads per closed hour.** `POST /evidence` and `substrate evidence` now call devnet for each closed hour, bounded by `SUBSTRATE_VERIFY_TIMEOUT_MS`. The bundle is slower, and it depends on devnet being reachable. An unreachable devnet marks hours `unverified` and the CLI exits 1.
- **The hourly timer is not installed on the host** (`29-CONTEXT.md`). Until the operator installs it, every closed hour older than 3 hours is `unanchored`, so `substrate evidence` exits 1 for any graph with such hours. That follows the fail-closed rule. It is expected until the timer runs.
- **Teachables come from a new read.** `Substrate.graphTeachables()` is a second ledger read per bundle. Verify does not expose its rows, so this was judged cleaner than widening `VerifyVerdict`.
- **Uncovered events do not fail the bundle.** An event with no ingest record is `uncovered`. D41-5 covers hours only. Its teachable shows as not anchored.

## Tests changed (existing)

- `packages/evidence/src/html.test.ts`: the test is renamed "shows the stub warning". The assertion on the pending wording is removed. It pinned text, not behaviour.
- `packages/evidence/src/report.test.ts`: the assertion that the anchor text is not pending is removed. It pinned text.
- `packages/mcp-server/src/observe.test.ts`: the "is verified when the chain checks out" stub now returns the real verify verdict shape (`chain`, `hours`, `uncovered`, `legacy`). It was stale. The assertion is unchanged.
- `packages/mcp-server/src/service.test.ts`: the title is renamed to "anchors off returns the chain verdict only". The body is unchanged.

## Tests added

- `packages/evidence/src/explorer.test.ts`: two tests (the devnet cluster and transaction page; a signature cannot leave the transaction path).
- `packages/evidence/src/html.test.ts`: anchored hour as an explorer link; unverified hour shown with its reason; teachable with its digest, hour and transaction; a tampered teachable; a bundle without the new fields.
- `packages/mcp-server/src/evidence-anchor.test.ts`: the anchored hour (a); the pending hour (b); the unconfirmed hour and the mismatched memo (c); the teachable (e); a bundle longer than the old budget; the altered teachable. It uses a scratch ledger and a fake RPC. Hour timings use a virtual `Date.now` clock, restored after each test.
- `packages/cli/src/evidence.test.ts`: an unconfirmed hour exits 1 and names it (c); a control where anchored and pending hours exit 0.

## Repair note

During implementation, two edits were corrupted by stale line numbers and repaired (`report.ts`), and `index.ts` was rewritten in full. Checked after: the existing exports are unchanged, plus the new explorer export. The typecheck is clean and the full suite passes.

## Known gaps

- The live devnet proof (`docs/agent-cards.md` G1 to G3) is operator-gated and not run.
- No CLI-level test for the request budget. The server-side budget is tested.
- `docs/agent-cards.md` is unchanged. Nothing in it contradicted the change.
