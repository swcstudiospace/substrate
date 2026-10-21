---
phase: 41-anchor
verified: 2026-10-21
status: passed in-repo. The live devnet proof is not run (operator-gated)
score: 2 of 2 criteria proven in-repo with fake-RPC tests
verified_on: gsd/v13x-41-anchor, based on origin/main acb6767. Typecheck and full suite run on the tree after the last edit
covered_files: ["packages/evidence/src/explorer.ts", "packages/evidence/src/explorer.test.ts", "packages/evidence/src/report.ts", "packages/evidence/src/index.ts", "packages/evidence/src/html.ts", "packages/evidence/src/html.test.ts", "packages/evidence/src/report.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/observe.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/evidence-anchor.test.ts", "packages/cli/src/index.ts", "packages/cli/src/evidence.test.ts", "docs/greptime-ledger.md", "README.md"]
---

# 41-VERIFICATION: ANCHOR

## Proven in-repo

| Claim | Evidence |
|---|---|
| Typecheck is clean | `bunx tsc --noEmit` exit 0 |
| Full suite passes | `bun test` against the verification Postgres: 5758 pass, 2 skip (`cache-conformance.test.ts:127`, `redact.test.ts:813`, both pre-existing), 0 fail. 5760 tests in 215 files, 141 s, no `ENOSPC` |
| Anchored hour carries its transaction | `evidence-anchor.test.ts` (a): tx signature, slot and devnet explorer link |
| Pending hour does not fail | `evidence-anchor.test.ts` (b); `cli/src/evidence.test.ts` control: anchored and pending exit 0 |
| Unconfirmed hour fails closed | `evidence-anchor.test.ts` (c), two tests: devnet cannot confirm; memo disagrees with the recomputed root. `cli/src/evidence.test.ts` (c): exit 1, names the hour |
| Explorer link | `explorer.test.ts`: devnet cluster and transaction page; a signature cannot leave the transaction path |
| Teachable carries digest, hour and transaction | `evidence-anchor.test.ts` (e) |
| HTML renders anchors and teachables | `html.test.ts`: three tests |

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Anchors appear in the evidence bundle: a tx signature and an explorer link per hour | PASS in-repo, with a fake RPC. The live devnet send is not run | the anchor and explorer tests above |
| 2 | Teachable moments are anchored with graph id plus an observation digest | PASS in-repo. The anchored record is the hour's; the digest is the teachable event's `content_sha256` | `evidence-anchor.test.ts` (e) |

## Not proven

- A real devnet anchor on the host. The hourly timer is not installed (`29-CONTEXT.md`), and no funded key is configured. The live proof (`docs/agent-cards.md` G1 to G3) is operator-gated and was not run.
- Behaviour under a live devnet outage. The bundle now depends on devnet; see SUMMARY behaviour changes.
