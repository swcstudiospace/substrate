---
phase: 23-claim-mirror-and-dod-gate
verified: 2026-11-12T00:00:00Z
status: human_needed
score: 4/5 roadmap success criteria verified (SC5 / MIRROR-08 pending operator-approved live proof)
covered_files: [".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-01-PLAN.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-01-SUMMARY.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-02-PLAN.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-02-SUMMARY.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-03-PLAN.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-03-SUMMARY.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-04-PLAN.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-04-SUMMARY.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-05-PLAN.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-05-SUMMARY.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-06-PLAN.md", ".planning/milestones/v1.3-phases/23-claim-mirror-and-dod-gate/23-06-SUMMARY.md", "docs/coordination.md", "docs/event-vocabulary.md", "docs/runbooks/mirror-proof.md", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/dod-gate.test.ts", "packages/mcp-server/src/dod-gate.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/linear.test.ts", "packages/mcp-server/src/linear.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/mirror.test.ts", "packages/mcp-server/src/mirror.ts", "packages/mcp-server/src/notion.test.ts", "packages/mcp-server/src/notion.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/rehearsal-env.ts", "packages/mcp-server/src/service.ts", "scripts/mirror-smoke.ts"]
covered_digest: "v3:sha256:fe31a669e83065d1ba62dd1fe8f24aca9c8a85ad5712751ded0dbfd9ba8eae8f"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 30/30 (2026-10-11 report, plan must-haves)
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "MIRROR-08 live proof (docs/runbooks/mirror-proof.md): on Linear issue SWC-467 and its Notion row, run claim, refused second-surface claim, release, complete without DoD, complete with DoD; check each tracker state within 60 s"
    expected: "Linear state, agent:* labels, claim comments and Notion Agent / Linear State match the transition table (MIRROR-02/03/04); only the connector moves the issue to Done"
    why_human: "Requires live Linear, Notion, hermes-linear-connector on :8792 and production surface tokens, in an operator-approved window. The runbook evidence row is NOT RUN."
  - test: "Run `bun run smoke:mirror` after `rehearsal up` (consumer.env present)"
    expected: "Smoke drives claim, refused claim, release, reclaim, complete without/with DoD, steal, forced release, reap and swarm claim against loopback fakes and passes all assertions"
    why_human: "Not run in this verification: the script exits with 'no consumer.env for instance default: run rehearsal up first' and performs no checks. Starting the rehearsal harness was out of scope for this verifier."
---

# Phase 23: Claim mirror and DoD gate Verification Report

**Phase Goal:** Linear and Notion show who holds each node as leases change, the lease stays authoritative when a tracker fails, and only the Definition-of-Done gate can mark an issue Done.
**Verified:** 2026-11-12
**Status:** human_needed
**Re-verification:** Yes — fresh re-run of the phase verifier; supersedes the 2026-10-11 report (status passed).

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | Granted/reclaimed lease → Linear first `started` + `agent:<surface>` added + every `dispatch:*` removed in one update, one `Claimed by …` comment, Notion `Agent` set; steal moves the label; release/reap/force → `unstarted` and `agent:*` cleared; renewal writes nothing; `swarm-*` holder comment-only | ✓ VERIFIED | `mirror.ts:140-170` (claim/steal/release ops); `mirror.ts:147,162,173,184,195,231,247` swarm short-circuit to `swarmOnly`; `mirror.ts:396-404` one issueUpdate with dispatch/agent label removal; hooks in `service.ts` on claim/release/reap. `mirror.test.ts` and `mirror-edges.test.ts` pass (see Behavioral Spot-Checks) |
| 2 | `graph_complete` with `dod` → node `started_review`, Linear In Review, POST `{HERMES_LINEAR_URL}/v1/complete-issue`; only connector moves to Done; refusal/error leaves node in review with lease kept | ✓ VERIFIED | `mcp.ts:1510-1521` dod schema and description; `service.ts:5741-5842` gated path (`invalidDod`, `runDodGate`, timeout from `config.dodGateTimeoutMs`); `dod-gate.ts:17-20` contract, `dod-gate.ts:108-109` `dod-required` with no connector call, `dod-gate.ts:126` `AbortSignal.timeout(deps.timeoutMs)`, `dod-gate.ts:199` `dod-refused`; `dod-gate.test.ts` pass |
| 3 | Failed tracker write never rolls lease back, one `warning` per failed target; losing claimant writes nothing; startup logs `mirror: linear on|off, notion on|off`; Notion writes limited to four properties, read-then-write | ✓ VERIFIED | `mirror.ts:455` failures captured as redacted ≤300-char reasons; `mirror.test.ts` fail-open block pass; `index.ts:165` prints `[substrate] mirror: ${substrate.mirror?.describe()}` and `mirror.ts:136` returns `linear on|off, notion on|off`; `notion.ts:23` `NOTION_WRITABLE = Agent, Status, Linear State, Completed`, `notion.ts:116,133` refusal before request, `notion.ts:112,130,160` GET-before-PATCH with data-source gate; `notion.test.ts` pass |
| 4 | `graph_find` maps Linear id/identifier to one node (`found:false` for zero/several); `issue_get` returns redacted, capped, untrusted-marked text; no reply carries `lease_id` | ✓ VERIFIED | `mcp.ts:1540` `graph_find`, `mcp.ts:1558` `issue_get`; `service.ts:6002` calls `index.findNodesByLinear`; `index-store.ts:1585` `findNodesByLinear`; `observe.ts:664-665` KNOWN_TOOLS entries; lease-id absence asserted in `mcp.test.ts` / `service.test.ts` (grep-selected run: 32 pass, 0 fail) |
| 5 | On a real Linear issue and its Notion row, claim, refused second claim, release, complete without DoD and complete with DoD each produce the tracker state within 60 s | ? UNCERTAIN → human | Live proof not run. `docs/runbooks/mirror-proof.md:3` approval gate; evidence row `:65` reads `NOT RUN — Awaiting operator approval`. Loopback smoke (`scripts/mirror-smoke.ts`) not executed in this run (see below) |

**Score:** 4/5 roadmap success criteria verified; SC5 routed to human verification (MIRROR-08).

### Requirements Coverage

| Requirement | Source Plan | Description (abridged) | Status | Evidence |
| ----------- | ----------- | ---------------------- | ------ | -------- |
| MIRROR-01 | 23-01 | Linear client: read context, resolve states by type, ensure labels, additive label edits, idempotent comments | ✓ SATISFIED | `linear.ts:20` 5 s timeout; `linear.ts:128,134,138` redacted ≤200-char errors; `linear.ts:239-246` additive `addedLabelIds`/`removedLabelIds` only; `linear.test.ts` pass |
| MIRROR-02 | 23-02, 23-03 | Claim mirrors to Linear state/labels/comment and Notion Agent; no `lease_id` written; swarm comment-only | ✓ SATISFIED | `mirror.ts:140-170`, `:396-404`; `mirror.test.ts` swarm and lease-id hygiene blocks pass |
| MIRROR-03 | 23-02, 23-03 | Other transitions mirrored (renewed nothing, stolen moves label, released/expired/forced clear) | ✓ SATISFIED | `mirror.ts:156-195`, `:420-426`; `service.ts` hook sites; mirror tests pass |
| MIRROR-04 | 23-04 | `graph_complete` dod gate, In Review, connector approval, fenced completion | ✓ SATISFIED | `service.ts:5741-5842`, `dod-gate.ts`, `mcp.ts:1510-1535`; `dod-gate.test.ts` pass |
| MIRROR-05 | 23-02, 23-03 | Lease authoritative on tracker failure; one warning per target; startup log | ✓ SATISFIED | `mirror.ts:455`, `index.ts:165`, `mirror.test.ts` fail-open block pass |
| MIRROR-06 | 23-01 | Notion writes only four properties on `NOTION_TASK_GRAPH_DS` rows, read-then-write | ✓ SATISFIED | `notion.ts:23,116,133,160`; `notion.test.ts` pass |
| MIRROR-07 | 23-05 | `graph_find` / `issue_get` with redaction and no `lease_id` | ✓ SATISFIED | `mcp.ts:1540,1558`, `service.ts:6002`, `index-store.ts:1585`, `observe.ts:664-665` |
| MIRROR-08 | 23-06 | Live proof on real Linear issue and Notion row | ? NEEDS HUMAN | `docs/runbooks/mirror-proof.md:3,65` approval-gated, NOT RUN |

No orphaned requirements: all eight MIRROR IDs appear in the phase plans.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/linear.ts` | Linear leaf client | ✓ VERIFIED | Present; unit tests pass |
| `packages/mcp-server/src/notion.ts` | Notion leaf client | ✓ VERIFIED | Present; unit tests pass |
| `packages/mcp-server/src/mirror.ts` | Transition table, swarm exception, fail-open warnings | ✓ VERIFIED | Present; unit tests pass |
| `packages/mcp-server/src/dod-gate.ts` | Connector DoD gate | ✓ VERIFIED | Present; unit tests pass |
| `packages/mcp-server/src/config.ts` | `hermesLinearUrl`, `dodGateTimeoutMs`, endpoint overrides | ✓ VERIFIED | `config.ts:40`, `:290-292`, `:1157-1160` |
| `packages/mcp-server/src/index-store.ts` | `findNodesByLinear`, reaper select widening, fenced review write | ✓ VERIFIED | `index-store.ts:1585` |
| `packages/mcp-server/src/mcp.ts` | `graph_find`, `issue_get`, `graph_complete.dod` | ✓ VERIFIED | `mcp.ts:1510-1558` |
| `scripts/mirror-smoke.ts` | Loopback smoke | ⚠️ PRESENT, NOT EXECUTED | Exists; run aborted at consumer.env precondition |
| `docs/runbooks/mirror-proof.md` | Live-proof runbook | ✓ VERIFIED (document) | Approval-gated; evidence row NOT RUN |
| `docs/coordination.md` | Tracker mirror section | ✓ VERIFIED | `coordination.md:345` `## Tracker mirror` |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `mirror.ts` ops | `linear.ts` / `notion.ts` | client calls | ✓ WIRED | `mirror.ts` imports both; transition ops call them |
| `service.ts` claim/release/reap | `mirror.ts` | mirror hooks after decision | ✓ WIRED | Hook sites per plan 23-03; mirror tests cover them |
| `service.ts` completeNode | `dod-gate.ts` | `runDodGate` | ✓ WIRED | `service.ts:143` import; `service.ts:5837-5842` call |
| `dod-gate.ts` | `{HERMES_LINEAR_URL}/v1/complete-issue` | POST, no auth | ✓ WIRED | `dod-gate.ts:35` `CONNECTOR_COMPLETE_PATH` |
| `mcp.ts` graph_find/issue_get | `service.ts` → `index-store.ts` | `findNodesByLinear` | ✓ WIRED | `service.ts:6002`, `index-store.ts:1585` |
| `index.ts` startup | `mirror.describe()` | log line | ✓ WIRED | `index.ts:165` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `graph_find` reply | matches | `index.findNodesByLinear` SQL over nodes | Yes (unit-tested path) | ✓ FLOWING |
| Mirror writes | Linear/Notion payloads | Lease decision + issue read | Yes (fake-fetch tests) | ✓ FLOWING (loopback only) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Mirror, Linear, Notion, DoD gate, config, event sources, rehearsal env unit tests | `bun test linear.test.ts notion.test.ts mirror.test.ts mirror-edges.test.ts dod-gate.test.ts config.test.ts event-sources.test.ts rehearsal-env.test.ts` | 377 pass, 0 fail (8 files) | ✓ PASS |
| graph_find / issue_get / dod / mirror / lease_id cases in MCP and service suites | `bun test mcp.test.ts service.test.ts observe.test.ts -t "graph_find\|issue_get\|dod\|mirror\|Linear\|lease_id"` | 32 pass, 0 fail | ✓ PASS |
| Loopback mirror smoke | `bun run smoke:mirror` | Aborted: `no consumer.env for instance default: run rehearsal up first.` No assertions ran | ? SKIP |

Not run in this verification: full `bun test` workspace suite, `bunx tsc --noEmit`, `bun run check:phase-close`, live Postgres-backed tests, `smoke:mirror`. The grep-selected service/mcp run is a subset.

### Probe Execution

No probes declared for this phase. Skipped.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (phase implementation files, grep for TBD/FIXME/XXX) | — | none found | — | None |

### Human Verification Required

### 1. MIRROR-08 live proof
**Test:** Follow `docs/runbooks/mirror-proof.md` in an operator-approved window on Linear `SWC-467` and its Notion row.
**Expected:** Claim, refused second-surface claim, release, complete without DoD and complete with DoD each produce the specified Linear and Notion state within 60 s; only the connector moves the issue to Done.
**Why human:** Needs live Linear, Notion, the connector on :8792 and production surface tokens. Approval-gated by design; evidence row is NOT RUN.

### 2. Loopback mirror smoke
**Test:** Start the rehearsal harness (`rehearsal up`), then run `bun run smoke:mirror`.
**Expected:** Every transition assertion passes against the loopback fakes.
**Why human:** Not executed in this verification; the consumer.env precondition was absent, so the smoke ran nothing.

### Gaps Summary

No must-have truth failed. No artifact is missing or a stub, and no key link is broken. The open item is SC5 / MIRROR-08, the operator-gated live proof, which cannot be verified from the repo. Status is therefore `human_needed`, not `passed`. The 2026-10-11 `passed` verdict recorded MIRROR-08 as "deferred" to an operator window; that is not a later phase, so it does not clear the requirement and cannot stand as a passing verdict now.

---

_Verified: 2026-11-12_
_Verifier: Claude (gsd-verifier)_
