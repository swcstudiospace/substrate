---
phase: 41-anchor
verified: 2026-10-21
status: human_needed
score: 2 of 2 criteria proven in-repo with fake-RPC tests
verified_on: gsd/v13x-41-anchor at f96b448 (review fixes), on origin/main acb6767. Typecheck and full suite run on that tree
covered_files: ["packages/evidence/src/explorer.ts", "packages/evidence/src/explorer.test.ts", "packages/evidence/src/report.ts", "packages/evidence/src/index.ts", "packages/evidence/src/html.ts", "packages/evidence/src/html.test.ts", "packages/evidence/src/report.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/observe.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/evidence-anchor.test.ts", "packages/cli/src/index.ts", "packages/cli/src/evidence.test.ts", "docs/greptime-ledger.md", "README.md"]
---

> Status detail, kept verbatim from the original frontmatter: passed in-repo. The live devnet proof is not run (operator-gated)

# 41-VERIFICATION: ANCHOR

## Proven in-repo

| Claim | Evidence |
|---|---|
| Typecheck is clean | `bunx tsc --noEmit` exit 0 |
| Full suite passes | `bun test` against the verification Postgres, clean run on f96b448: 5763 pass, 2 skip (`cache-conformance.test.ts:127`, `redact.test.ts:813`, both pre-existing), 0 fail. 5765 tests in 215 files, 159 s, no `ENOSPC` |
| Anchored hour carries its transaction | `evidence-anchor.test.ts` (a): tx signature, slot and devnet explorer link |
| Pending hour does not fail | `evidence-anchor.test.ts` (b); `cli/src/evidence.test.ts` control: anchored and pending exit 0 |
| Unconfirmed hour fails closed | `evidence-anchor.test.ts` (c): devnet cannot confirm; memo disagrees with the recomputed root. `cli/src/evidence.test.ts` (c): exit 1, names the hour |
| Budget covers a long bundle | `evidence-anchor.test.ts`: five hours, each devnet read costing 350 ms on a virtual clock, all anchored; with the old 1,500 ms budget the fifth hour is unverified with a reason |
| Explorer link | `explorer.test.ts`: devnet cluster and transaction page; a signature cannot leave the transaction path |
| Teachable carries digest, hour and transaction | `evidence-anchor.test.ts` (e) |
| Altered teachable is not anchored | `evidence-anchor.test.ts`: a teachable altered after its hour was anchored is not anchored (reason `tampered`); the untouched one is |
| HTML renders anchors and teachables, and older bundles | `html.test.ts`: anchored hours, unverified hour, teachables, tampered teachable, and a bundle from a server without the fields |

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Anchors appear in the evidence bundle: a tx signature and an explorer link per hour | PASS in-repo, with a fake RPC. The live devnet send is not run | the anchor and explorer tests above |
| 2 | Teachable moments are anchored with graph id plus an observation digest | PASS in-repo. The anchored record is the hour's. The digest is the teachable event's `content_sha256`, checked against its stored hash | `evidence-anchor.test.ts` (e) and the tampered-teachable test |

## Not proven

- A real devnet anchor on the host. The hourly timer is not installed (`29-CONTEXT.md`), and no funded key is configured. The live proof (`docs/agent-cards.md` G1 to G3) is operator-gated and was not run.
- Behaviour under a live devnet outage. The bundle depends on devnet; see SUMMARY behaviour changes.
- The CLI request budget is not covered by a CLI-level test. Such a test needs real delays, which the repo forbids in tests. The server-side budget is covered.

## Load-sensitive test, not caused by this phase

- `redact-adversarial.test.ts` "the skill scan is not quadratic in the number of matches" failed once in a full run at host load average 27 (1,231 ms against its threshold). It passes on its own, twice, and in the clean full run above. The phase does not touch that code.

## Requirement coverage re-verification (2026-10-24)

Tests were not run in this task; the orchestrator runs them. Code and test names below were confirmed by read and grep only.

### E-D1

- Requirement (ROADMAP Phase 41 criterion 1): "Anchors appear in the evidence bundle: a tx signature and an explorer link per hour, so PR and incident evidence can be checked outside the system (v0.3 6.x)." (REQUIREMENTS.md line 36 words it differently; the ROADMAP text is quoted as the criterion.)
- Implementing code:
  - `packages/mcp-server/src/observe.ts:874-899` `buildGraphEvidence` takes the hour report from one `substrate.verifyGraph(graphId, { ...verify, anchors: true })` call (`observe.ts:892`) and maps it with `anchorEvidenceOf` (`observe.ts:899`).
  - `packages/mcp-server/src/observe.ts:1002-1013` `anchorEvidenceOf` sets `tx_sig` and `explorer_url` for each hour that has a transaction (`observe.ts:1010`).
  - `packages/evidence/src/explorer.ts:11` `devnetExplorerTxUrl` builds `https://explorer.solana.com/tx/<sig>?cluster=devnet`, encoding the signature.
  - `packages/mcp-server/src/service.ts:637-645` `VerifyOptions` (`anchors`, `now`, injected `rpc`); `service.ts:5539-5541` documents that the bundle takes its hours from `verifyGraph`; `service.ts:5543` `verifyGraph`.
  - `packages/mcp-server/src/server.ts:1069-1080` `POST /evidence` calls `buildGraphEvidence`, and returns HTML when `format` is `html`.
  - `packages/cli/src/index.ts:360` `cmdEvidence` (request budget; the CLI-level budget is not covered by a test, per the phase VERIFICATION).
- Tests (exact names):
  - `packages/mcp-server/src/evidence-anchor.test.ts`: "an anchored hour carries its transaction signature, slot and devnet explorer link"; "a pending hour is listed without a transaction, and does not fail"; "an hour devnet cannot confirm is unverified, names the reason, and is not anchored"; "a bundle of more hours than the old 1,500 ms budget allowed anchors every hour".
  - `packages/evidence/src/explorer.test.ts`: "names the devnet cluster and the transaction page for the signature"; "a signature cannot leave the transaction path".
  - `packages/evidence/src/html.test.ts`: "renders each anchored hour with its devnet transaction as an explorer link".
  - `packages/cli/src/evidence.test.ts`: "anchored and pending hours exit 0, and the bundle lists both".
- Evidence status: `in-repo proven` (code and tests both found, fake RPC).
- Live proof remaining: `PENDING_VALIDATION`. The hourly anchor timer is not installed and no funded devnet key is configured (phase VERIFICATION "Not proven"; the timer is cited there as `29-CONTEXT.md`, found at `.planning/phases/29-agent-cards-and-teachable-moments/29-CONTEXT.md`). Operator check: follow `docs/agent-cards.md` G3 (line 62) with the funded key: emit a proof teachable, let the hourly timer anchor its hour, read the memo back by `tx_sig`, then `substrate evidence` for that graph must list the hour as `anchored` with its explorer link and exit 0.

### E-D2

- Requirement (ROADMAP Phase 41 criterion 2): "Teachable moments are anchored with graph id plus an observation digest, a user addition carried in the brief's area E."
- Implementing code:
  - `packages/mcp-server/src/service.ts:5591-5620` `graphTeachables`: reads the graph's teachable events, sets `graph_id`, `content_sha256` (`service.ts:5615`), `hour` (`service.ts:5616`) and `tampered` (`service.ts:5617`, recomputed event hash).
  - `packages/mcp-server/src/observe.ts:899-903` loads the teachables (`observe.ts:903`) against the anchors of the same verdict (`observe.ts:899`).
  - `packages/mcp-server/src/observe.ts:1022-1036` `teachableEvidenceOf`: `anchored` is `!teachable.tampered && anchor?.status === "anchored"` (`observe.ts:1032`); a tampered teachable gets `reason: "tampered"` (`observe.ts:1033`); the hour's `tx_sig` and `explorer_url` are copied (`observe.ts:1034`).
- Tests (exact names):
  - `packages/mcp-server/src/evidence-anchor.test.ts`: "a teachable carries its graph id, its content digest, its hour and that hour's transaction"; "a teachable altered after its hour was anchored is not anchored, and an untouched teachable still is".
  - `packages/evidence/src/html.test.ts`: "renders each teachable with its digest, its hour and that hour's transaction"; "renders a tampered teachable as not anchored, with its reason".
- Evidence status: `in-repo proven`.
- Live proof remaining: `PENDING_VALIDATION`, same operator check as E-D1 (G3 in `docs/agent-cards.md`): the proof teachable's hour must be anchored on devnet and its teachable must read `anchored: true` in the bundle.

### Scope note

- Nothing in this block changes the frontmatter status, the score line, or the criteria table above.
