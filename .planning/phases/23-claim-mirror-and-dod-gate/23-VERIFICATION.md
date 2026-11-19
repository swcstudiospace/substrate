---
phase: 23-claim-mirror-and-dod-gate
verified: 2026-11-18T12:22:31Z
status: human_needed
score: 4/5 must-haves verified (criterion 5 needs an operator-window live run)
behavior_unverified: 0
overrides_applied: 0
covered_files: [".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-01-PLAN.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-01-SUMMARY.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-02-PLAN.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-02-SUMMARY.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-03-PLAN.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-03-SUMMARY.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-04-PLAN.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-04-SUMMARY.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-05-PLAN.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-05-SUMMARY.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-06-PLAN.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-06-SUMMARY.md", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/dod-gate.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/linear.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/mirror.ts", "packages/mcp-server/src/notion.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:ccc7d6e97401cf26c1c84e36aff52c8f0062d2ab3ea2cb3ae3642861adb1857e"
human_verification:
  - test: "Run the MIRROR-08 sequence on real Linear issue SWC-467 and its Agent Task Graph Notion row via docs/runbooks/mirror-proof.md: claim, a second surface's refused claim, release, complete without dod, complete with dod"
    expected: "Each step produces its tracker state (claim: first started + agent:<surface> + no dispatch:*, one Claimed-by comment, Notion Agent set; refused claim: no writes; release: unstarted + agent:* cleared + Notion Agent cleared; complete without dod: In Review, node started_review, lease kept, no connector call; complete with dod: connector approval, Done only via the connector) each within 60 s"
    why_human: "Writes to production Linear, Notion and the hermes-linear-connector; requires an operator-approved window and production surface tokens. The last recorded live pass (v1.3-MILESTONE-AUDIT.md, 2026-10-12) ran against an earlier tip; mirror.ts and linear.ts have changed since (edge relations, MirrorSuccess type), so the proof is not carried forward to HEAD 357d6b15 by this verifier."
---

# Phase 23: Claim mirror and DoD gate Verification Report

**Phase Goal:** Linear and Notion show who holds each node as its lease changes, the lease stays authoritative when a tracker fails, and only the Definition-of-Done gate can mark an issue Done.
**Verified:** 2026-11-18T12:22:31Z
**Status:** human_needed
**Re-verification:** Yes — the phase was verified at 60bd0c1 (30/30) and re-verified at ed696ef (30/30) in `.planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-VERIFICATION.md`. This record is written at HEAD `357d6b15` against the ROADMAP success criteria.

**Scope note:** `.planning/phases/` no longer holds phase 23 (archived under `.planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/`). The archived plans and summaries are read as inputs only; the archived `23-VERIFICATION.md` is left untouched.

## Goal Achievement

### Observable Truths

| #   | Truth (ROADMAP success criterion) | Status | Evidence |
| --- | --------------------------------- | ------ | -------- |
| 1 | Granted/reclaimed lease → first `started` state, `agent:<surface>` added and every `dispatch:*` removed in one update, one `Claimed by …` comment per session, Notion `Agent` set; steal moves the label; release/reap/force → `unstarted`, `agent:*` and Notion `Agent` cleared; renewal writes nothing; `swarm-*` only comments, pinned by a test | ✓ VERIFIED | `mirror.ts` `claim`/`steal` call `claimLinear` (firstStartedStateId, one `updateIssue` with `addedLabelIds` + `removedLabelIds` for `dispatch:*` and other `agent:*`, then the exact-text comment, skipped when present among the last 20). `release`/`expire`/`force` call `clearLinear` (firstUnstartedStateId, removes all `agent:*`) and set Notion `Agent: null`. `service.ts` `runMirror` is called only on granted/reclaimed/stolen claims (line ~5544), on release/forced release (~5697), on reap/expiry (~7478); `heartbeatNode` never calls the mirror, and `Mirror` has no renew entry point (test "the Mirror has no renew or heartbeat entry point"). `swarmOnly()` posts only the comment; `mirror.test.ts` "swarm comment-only exception (D23-03)" pins every op with a `swarm-*` holder and the steal edge. |
| 2 | `graph_complete` with `dod` → `started_review` + Linear In Review, posts to `{HERMES_LINEAR_URL}/v1/complete-issue`; only the connector moves to Done; refusal or error keeps node in review with lease kept | ✓ VERIFIED | `service.ts` `completeNode` routes non-swarm, non-forced, Linear-linked completions to `gatedComplete`: `reviewNode` fenced write (step 1), `runDodGate` (`dod-gate.ts`): `linearState` skip if completed, `mirror.review` (To In Review, `inReviewStateId`), no `dod` → `dod-required` refusal, else `POST ${hermesLinearUrl}/v1/complete-issue` (`CONNECTOR_COMPLETE_PATH`), only explicit `completed: true` approves. `fencedRelease` to `completed` runs only after `gate.gate === "approved"`; refusals return without release. `config.ts` reads `HERMES_LINEAR_URL` (default `http://127.0.0.1:8792`). Mirror `done()` writes Notion only (no Linear call). `dod-gate.test.ts` (13 tests) pins refusal, timeout settle, and no-auth request. |
| 3 | Failed tracker write never rolls the lease back and yields one `warning` per failed target; losing claimant writes nothing; startup logs `mirror: linear on|off, notion on|off`; Notion writes touch only the four allowed properties on `NOTION_TASK_GRAPH_DS` Issue rows, read-then-write | ✓ VERIFIED | `mirror.ts` `run()` never throws and returns at most one linear and one notion `MirrorFailure`; `service.ts` `emitMirrorFailures` emits one `kind: "warning"` `claim mirror failed: <target> <op>` per failure, after the decision is already committed. The claim mirror is called only when `granted` (a refused claim writes nothing). `index.ts` line 165 logs `[substrate] mirror: ${describe()}`, where `describe()` returns `linear on|off, notion on|off`. `notion.ts` `NOTION_WRITABLE = ["Agent","Status","Linear State","Completed"]`, enforced in `writeShaped`/`updatePage` before any request; `taskGraphPage` GETs the page and refuses unless its parent is the configured data source (`NOTION_TASK_GRAPH_DS`, config.ts line 1150); then one PATCH. Tests: `notion.test.ts` (17) and `mirror.test.ts` "one shaped write costs a single GET and a single PATCH". |
| 4 | `graph_find` maps a Linear id or identifier to one node (`found: false` for zero or several); `issue_get` returns redacted, capped, untrusted-marked text; no reply, comment or tracker field carries a `lease_id` | ✓ VERIFIED | `service.ts` `findNode`: requires one of the refs, `findNodesByLinear`, returns `found: false` on zero or several matches, node returned with `lease_id: null` and the public `LeaseView` only. `getIssue`: `redact()` on title and description, `ISSUE_TITLE_CAP` / `ISSUE_DESCRIPTION_CAP` with `ISSUE_TRUNCATED`, `untrusted: ISSUE_TEXT_NOTICE`. Tool wiring in `mcp.ts` lines 1541-1573. Tracker comments and connector body carry only surface, session, graph and node (`transitionComment`); `dod-gate.test.ts` "the planted lease id appears in no connector request". `service.test.ts` "graph_find and issue_get (D23-22..24)" (targeted run: 42 pass, 0 fail, filter `D23|mirror|dod|DoD|graph_find|issue_get`). |
| 5 | On a real Linear issue and its Notion row, claim, second surface's refused claim, release, complete without DoD and complete with DoD each produce the tracker state above within 60 s | ? HUMAN_NEEDED | Requires a live run against production Linear (SWC-467), its Notion row, and the hermes-linear-connector. Not executed by this verifier. Prior record: `.planning/milestones/v1.3-MILESTONE-AUDIT.md` line 33 reports "CLEARED 2026-10-12" with timings 3.7/0.4/24.4/4.9/8.3 s, but at an earlier tip. Runbook: `docs/runbooks/mirror-proof.md` (exists). See human verification item 1. |

**Score:** 4/5 truths verified. No truth is FAILED. No truth is PRESENT_BEHAVIOR_UNVERIFIED: the state transitions in truths 1 and 2 are exercised by named unit tests that passed.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/mirror.ts` | Claim/release/review/done/close mirror, swarm exception, never throws | ✓ VERIFIED | 493 lines; no TODO/FIXME/placeholder markers; wired from `service.ts` via `createMirror` in `service.ts` constructor path |
| `packages/mcp-server/src/dod-gate.ts` | DoD gate, connector POST, approval only on explicit `completed: true` | ✓ VERIFIED | 200 lines; called from `service.ts` `gatedComplete` (line ~5939) |
| `packages/mcp-server/src/linear.ts` | First started/unstarted by type, In Review by name, additive-only label writes | ✓ VERIFIED | `updateIssue` has no `labelIds` parameter; `inReviewStateId` refuses a `completed` state |
| `packages/mcp-server/src/notion.ts` | Four writable properties, task-graph parent check, one GET + one PATCH | ✓ VERIFIED | `writeShaped` is the production path; see warning W1 for `updatePage` |
| `packages/mcp-server/src/service.ts` | Decision → mirror wiring, warnings, gated completion, `getIssue`, `findNode` | ✓ VERIFIED | `runMirror`, `emitMirrorFailures`, `gatedComplete`, `getIssue`, `findNode` present and called |
| `packages/mcp-server/src/mcp.ts` | `graph_find`, `issue_get` tool registration | ✓ VERIFIED | lines 1541-1573 |
| `packages/mcp-server/src/index.ts` | Startup log `mirror: linear on|off, notion on|off` | ✓ VERIFIED | line 165 |
| `packages/mcp-server/src/config.ts` | `HERMES_LINEAR_URL`, `NOTION_TASK_GRAPH_DS` | ✓ VERIFIED | lines 1148-1151 |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` claim path | `Mirror.claim/steal` | `runMirror` after `decision.action` granted/reclaimed/stolen | ✓ WIRED | line ~5544 |
| `service.ts` release path | `Mirror.release/force` | `runMirror` after released/forced decision | ✓ WIRED | line ~5697 |
| `service.ts` reaper | `Mirror.expire` | `runMirror(..., "expire")` | ✓ WIRED | line ~7478 |
| `service.ts` gated completion | `runDodGate` → `Mirror.review` | `gatedComplete` | ✓ WIRED | line ~5939 |
| `dod-gate.ts` | `{HERMES_LINEAR_URL}/v1/complete-issue` | `fetch` POST with `linear_issue_id`, `summary`, `tests_pass`, `review_pass` | ✓ WIRED | `CONNECTOR_COMPLETE_PATH` |
| `mirror.ts` | Linear / Notion clients | `LinearClient` / `NotionClient` from `createMirror(config)` | ✓ WIRED | `createMirror` at mirror.ts end |
| `index.ts` | `Mirror.describe()` | startup stdout | ✓ WIRED | line 165 |
| `mcp.ts` `graph_find` / `issue_get` | `service.ts` `findNode` / `getIssue` | `substrate.findNode`, `substrate.getIssue` | ✓ WIRED | mcp.ts 1556, 1572 |

### Data-Flow Trace (Level 4)

Not applicable: no UI or rendered dynamic data. Tracker data flows from the live Linear/Notion GraphQL and REST responses through `issueContext`, `issueText`, `getPage` into the mirror writes; the unit tests exercise those paths with fake transports.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Mirror, DoD, Linear and Notion unit behaviour (claim/steal/release/review/done/close, swarm exception, failure semantics, DoD refusal and timeout, D-07 allowlist) | `cd packages/mcp-server && bun test src/dod-gate.test.ts src/linear.test.ts src/notion.test.ts src/mirror.test.ts` | 84 pass, 0 fail, 304 expect() calls | ✓ PASS |
| Service-level D23 wiring: graph_find, issue_get, claim/complete mirror paths, DoD gate | `cd packages/mcp-server && bun test src/service.test.ts -t "D23\|mirror\|dod\|DoD\|graph_find\|issue_get"` | 42 pass, 0 fail, 177 expect() calls | ✓ PASS |
| Live Linear and Notion transitions on SWC-467 | not run (operator-gated) | — | ? SKIP → human |

### Probe Execution

No probe scripts are declared for this phase. Skipped.

### Requirements Coverage

| Requirement | Source | Description (abridged) | Status | Evidence |
| ----------- | ------ | ---------------------- | ------ | -------- |
| MIRROR-01 | archived 23-01..06 PLAN | Linear client: read context, resolve states by type, ensure labels, additive label edits, idempotent comments | ✓ SATISFIED | `linear.ts` (`issueContext`, `ensureLabel`, `updateIssue` additive only, `createComment`); `linear.test.ts` (15) |
| MIRROR-02 | archived 23-02 | Granted/reclaimed mirror, swarm exception | ✓ SATISFIED | `mirror.ts` `claim`, `claimLinear`, `swarmOnly`; `mirror.test.ts` |
| MIRROR-03 | archived 23-02/03 | Steal, release, reap, force mirror | ✓ SATISFIED | `mirror.ts` `steal`, `release`, `expire`, `force`, `clearLinear` |
| MIRROR-04 | archived 23-04 | `graph_complete` with `dod` and DoD gate | ✓ SATISFIED | `service.ts` `gatedComplete`; `dod-gate.ts`; `dod-gate.test.ts` (13) |
| MIRROR-05 | archived 23-03 | Failure semantics: never roll back, one warning per target | ✓ SATISFIED | `mirror.ts` `run`; `service.ts` `emitMirrorFailures` |
| MIRROR-06 | archived 23-05 | `graph_find`, `issue_get`, no `lease_id` in replies | ✓ SATISFIED | `service.ts` `findNode`, `getIssue`; `mcp.ts`; service tests |
| MIRROR-07 | archived 23-05/06 | Startup log, Notion allowlist and read-then-write | ✓ SATISFIED | `index.ts` line 165; `notion.ts` `NOTION_WRITABLE`, `writeShaped`, `taskGraphPage` |
| MIRROR-08 | archived 23-06 | Live proof on SWC-467 within 60 s | ? NEEDS HUMAN | See human verification item 1 |

**Orphaned requirements:** none. All MIRROR-01..08 appear in archived plans.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/notion.ts` | 115 | `updatePage` is a production method with no production caller; only `notion.test.ts` (D-07 allowlist tests) calls it. `writeShaped` replaced it on the mirror path | ⚠️ Warning (W1) | Dead production code with its own allowlist; a future caller could bypass `writeShaped`'s shaping. Remove it and point its tests at `writeShaped`, or document why it stays |
| `packages/mcp-server/src/mirror.ts` | 461-466 | The `ClaimCommentFailed` doc comment sits after `Mirror`'s closing brace, with a blank line before the class, and the `relateEdges` block is indented inside the class body on the same line as `}` | ℹ️ Info | Formatting only; no behaviour impact |
| `packages/mcp-server/src/mirror.ts` | 3 | Header comment reads "main's final lease decisions" with a stray `*` on the line | ℹ️ Info | Documentation nit |
| `packages/mcp-server/src/dod-gate.ts` | 69-71 | Doc comment for `bodyDetail` sits detached from its function by a blank line | ℹ️ Info | Documentation nit |

No TODO, FIXME, XXX, HACK, or placeholder markers in the phase-owned source files. No `return null`/empty-handler stubs on the claim, release, or complete paths.

### Human Verification Required

#### 1. MIRROR-08 live sequence on SWC-467

**Test:** Using `docs/runbooks/mirror-proof.md` in an operator-approved window, with `substrate-mcp` deployed at HEAD, Phase 20 surface tokens, and the connector on `:8792`: (a) claim the node; (b) attempt a second surface's claim; (c) release; (d) complete without `dod`; (e) complete with `dod`. Read Linear and the Notion row after each step, and time each step.
**Expected:** (a) first `started` state, `agent:<surface>` present, no `dispatch:*`, one `Claimed by …` comment, Notion `Agent` set; (b) no writes to Linear or Notion; (c) first `unstarted`, no `agent:*`, Notion `Agent` cleared; (d) In Review, node `started_review` with lease held, no connector approval and no Done; (e) connector approval, Linear Done moved only by the connector, Notion Status/Linear State/Completed set. Each within 60 s, with no `lease_id` in any tracker field.
**Why human:** Writes to production Linear, Notion and the connector; needs an operator window and production tokens. The last recorded pass (2026-10-12) was at an earlier tip; mirror.ts and linear.ts have changed since (edge relations and the `MirrorSuccess` type). This verifier did not carry that pass forward to HEAD.

## Gaps Summary

No BLOCKER gaps. Truths 1-4 hold in the code at HEAD `357d6b15`, and the targeted unit and service tests pass (84 + 42, 0 fail). Truth 5 needs one operator-window live run. Warning W1 (dead `updatePage`) is a cleanup item, not a goal gap.

Post-verification drift since ed696ef, all in phase-23 files, is additive and does not touch the claim, release, review, done or DoD paths: `mirror.ts` gained `relateEdges` and `MirrorSuccess`, `linear.ts` gained `issueRelations` and `createIssueRelation`, and `dod-gate.ts` changed one type to `review_pass?: boolean | undefined`.

---

_Verified: 2026-11-18T12:22:31Z_
_Verifier: Claude (gsd-verifier)_
