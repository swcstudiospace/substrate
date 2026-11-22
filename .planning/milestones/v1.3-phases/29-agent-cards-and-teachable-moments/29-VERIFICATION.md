---
phase: 29-agent-cards-and-teachable-moments
verified: 2026-11-12T08:31:11Z
status: human_needed
score: 4/4 roadmap success criteria verified in-repo; spec fidelity (G1) and live legs (G2, G3) human_needed
covered_files: [".planning/milestones/v1.3-phases/29-agent-cards-and-teachable-moments/29-01-PLAN.md", ".planning/milestones/v1.3-phases/29-agent-cards-and-teachable-moments/29-01-SUMMARY.md", ".planning/milestones/v1.3-phases/29-agent-cards-and-teachable-moments/29-02-PLAN.md", ".planning/milestones/v1.3-phases/29-agent-cards-and-teachable-moments/29-02-SUMMARY.md", ".planning/milestones/v1.3-phases/29-agent-cards-and-teachable-moments/29-03-PLAN.md", ".planning/milestones/v1.3-phases/29-agent-cards-and-teachable-moments/29-03-SUMMARY.md", "docs/agent-cards.md", "packages/mcp-server/src/agent-card.fixtures.ts", "packages/mcp-server/src/agent-card.test.ts", "packages/mcp-server/src/agent-card.ts", "packages/mcp-server/src/server.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/teachable-anchor.test.ts", "packages/mcp-server/src/teachable.fixtures.ts", "packages/mcp-server/src/teachable.test.ts", "packages/mcp-server/src/teachable.ts"]
covered_digest: "v3:sha256:2de5227ea91d968f4b074c281e0916665633d231af4a4986dea3e0b24ddd2fdb"
behavior_unverified: 0
overrides_applied: 0
behavior_unverified_items: []
human_verification:
  - test: "G1: fetch the published A2A spec (https://a2a-protocol.org/latest/specification/) and diff its Agent Card required fields against validateAgentCard in packages/mcp-server/src/agent-card.ts"
    expected: "Field set confirmed, or the validator corrected and re-tested"
    why_human: "Operator-gated network read; the in-repo field set is explicitly UNVERIFIED against the published spec"
  - test: "G2: GET /.well-known/agent-card.json?surface=<name> on loopback for each of the 27 surfaces; decide whether any card is published beyond loopback"
    expected: "Each surface returns 200 with a validator-clean card; publication scope decided by the operator (none in v1.3 by default)"
    why_human: "Live loopback read against the running server plus an exposure decision that only the operator can make"
  - test: "G3: with the funded devnet key, emit a proof teachable into production, let the hourly timer anchor its hour, read the memo back by tx_sig, run substrate verify on the proof graph"
    expected: "The teachable's hour reports anchored and the teachable event sits inside it"
    why_human: "Writes to production ledger and devnet; no agent may run it. The in-repo proof uses a fake RPC only"
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 29: Agent Cards and teachable moments Verification Report

**Phase Goal:** Each agent surface publishes a spec-valid A2A Agent Card whose skills include what it has been taught, and every teachable is covered by the hourly anchor.
**Verified:** 2026-11-12T08:31:11Z
**Status:** human_needed
**Re-verification:** No — initial verification in this form. The previous `29-VERIFICATION.md` (status `passed`, 2026-10-11) listed G1–G3 as operator-gated while reporting `passed`; this report supersedes it.

## Goal Achievement

### Observable Truths

Truths are the four ROADMAP Phase 29 success criteria. PLAN frontmatter truths (29-01/02/03) were checked as supporting detail; none reduce scope.

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | Each surface has an A2A v1.0 Agent Card at `/.well-known/agent-card.json`, valid against the spec (id, name, description, supported interfaces, capabilities, default modes, skills[]) | ✓ VERIFIED (in-repo field set); spec fidelity → human G1 | Route: `packages/mcp-server/src/server.ts:1193-1210` (per-surface via `?surface=`, 400 on missing/unknown). Builder: `agent-card.ts:82-117` emits all listed fields. Validator: `agent-card.ts:123-170`. Route and validator cases pass in `agent-card.test.ts`. The field set is marked UNVERIFIED against the published A2A spec (`agent-card.ts:8-16`, `:43`, `:121`) pending G1. |
| 2 | A teachable is a tagged governed `fact` written through `memory_write` (no new memory kind); each accepted teachable appears in its surface's card `skills[]` | ✓ VERIFIED | Predicate: `teachable.ts:36-44` (kind `fact`, `teachable:` prefix, non-empty slug). Reader: `service.ts:3429-3455` (`subjectPrefix` search, writer and kind filter, superseded excluded, newest first). Skills mapping: `agent-card.ts:82-103` (`SKILL_NAME_RE` name, redacted description capped at 1200, tag `teachable-moment`). Card e2e in `agent-card.test.ts` passes. |
| 3 | Teachable writes emit events the hourly anchor covers; `verify` reports the hour holding a teachable as anchored | ✓ VERIFIED (in-repo, fake RPC); live anchor → human G3 | Emit: `service.ts:3160-3168` (only `accepted` + `verified_persisted` + not `deduplicated` + teachable + known surface). Event builder: `teachable.ts:58-79` (kind `note`, `action: "teachable"`, hash only). Anchor proof: `teachable-anchor.test.ts:194` ("the teachable event sits inside a verify-reported anchored hour") and `:224` (altered event fails verify naming the hour); both pass. |
| 4 | A teachable recorded from a session appears in that surface's Agent Card, and its event sits inside an anchored hour | ✓ VERIFIED (in-repo, scratch ledger + fake RPC); live → human G3 | Session → card leg in `agent-card.test.ts` (passes); event-in-anchored-hour leg in `teachable-anchor.test.ts:194` (passes). Live devnet leg not executed. |

**Score:** 4/4 roadmap success criteria verified in-repo; 0 behavior-unverified truths; 3 operator-gated human items (G1, G2, G3).

### Deferred Items

None.

### Advisory (New Scope, Unevidenced)

None. (Re-verification mode was not used; no new-scope findings were raised.)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/teachable.ts` | predicate, slug, sample-shaped event builder | ✓ VERIFIED | 79 lines; imported by `service.ts:170` |
| `packages/mcp-server/src/teachable.fixtures.ts` | shared corpus | ✓ VERIFIED | 131 lines; consumed by `teachable.test.ts` |
| `packages/mcp-server/src/agent-card.ts` | builder, validator, reader guard | ✓ VERIFIED | 174 lines; imported by `server.ts:73` |
| `packages/mcp-server/src/agent-card.fixtures.ts` | valid + violation fixtures | ✓ VERIFIED | 84 lines; consumed by `agent-card.test.ts` |
| `docs/agent-cards.md` | convention, route, coverage argument, G1–G3 map | ✓ VERIFIED | 62 lines; G1–G3 recorded unexecuted |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `server.ts` GET route | `buildAgentCard` + `teachablesForSurface` | `server.ts:1209` | ✓ WIRED | Route calls reader then builder, returns 200 JSON |
| `service.writeMemory` | `teachableEvent` → `this.emit` | `service.ts:3165-3168` | ✓ WIRED | Guarded on accepted, verified, non-deduplicated, teachable, known surface |
| `teachablesForSurface` | index `subjectPrefix` search | `service.ts:3429-3455` | ✓ WIRED | Read-only; no gate, no cache bump |
| `agent-card` skills | `SKILL_NAME_RE` | `agent-card.ts` imports `skills/propose.ts` | ✓ WIRED | Validator rejects non-matching names |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| card `skills[]` | `teachables` | `teachablesForSurface` → index search | Yes in code; tests use stub/fixture index | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Teachable write/emit/reader, card route and validator, server route, anchor proof | `bun test packages/mcp-server/src/teachable.test.ts packages/mcp-server/src/teachable-anchor.test.ts packages/mcp-server/src/agent-card.test.ts packages/mcp-server/src/server.test.ts` | 258 pass, 0 fail | ✓ PASS |
| Anchor proof file alone | `bun test packages/mcp-server/src/teachable-anchor.test.ts` | 116 pass, 0 fail | ✓ PASS |
| Phase lock gate | `bun run check:phase-close` | pass: 4 lock files green; EVENT_KINDS unchanged at 12 | ✓ PASS |
| Live G1 spec diff, G2 loopback per surface, G3 devnet anchor | not run | operator-gated | ? SKIP → human |

Not run: `bunx tsc --noEmit`, the full `bun test` suite, and the Python suites. `SUBSTRATE_TEST_PG_URL` was unset, so the live Postgres index tests did not run; the scratch-ledger proofs use in-process stores and a fake RPC.

### Probe Execution

No probes declared for this phase (no `scripts/*/tests/probe-*.sh` found; none referenced in PLAN/SUMMARY). Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| CARD-01 | 29-02 | A2A v1.0 Agent Card per surface on loopback, valid against spec | ✓ SATISFIED in-repo; spec fidelity human (G1) | `server.ts:1193-1210`, `agent-card.ts:82-170` |
| CARD-02 | 29-01, 29-02 | Teachable = governed fact via `memory_write`; appears in `skills[]` | ✓ SATISFIED | `teachable.ts:36-44`, `service.ts:3429-3455`, `agent-card.ts:82-103` |
| CARD-03 | 29-01, 29-03 | Teachable events covered by hourly anchor; verify reports anchored | ✓ SATISFIED in-repo; live (human G3) | `service.ts:3160-3168`, `teachable-anchor.test.ts:194` |
| CARD-04 | 29-03 | Session teachable appears in card; event inside anchored hour | ✓ SATISFIED in-repo; live (human G3) | `agent-card.test.ts` card e2e; `teachable-anchor.test.ts:194` |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/agent-card.ts` | 8-16, 121 | Explicit UNVERIFIED marker on the card field set | ℹ️ Info | Documented and operator-gated (G1). Not a stub. |
| `29-01-SUMMARY.md` / `29-VERIFICATION.md` (prior) | — | Records SURFACES at 27; `check:phase-close` now reports SURFACES at 42 (baseline plus substrate). Lock passes. | ℹ️ Info | Summary drift only; no gate fails. |

No TODO/FIXME/placeholder/stub returns in the four new source files.

### Human Verification Required

### 1. G1: A2A spec field-set diff

**Test:** Fetch `https://a2a-protocol.org/latest/specification/` and diff its Agent Card required fields against `validateAgentCard` in `packages/mcp-server/src/agent-card.ts`.
**Expected:** Field set confirmed, or the validator corrected and its tests updated.
**Why human:** Operator-gated network read. The in-repo set is explicitly UNVERIFIED against the published spec.

### 2. G2: Loopback card read per surface and publication decision

**Test:** `GET /.well-known/agent-card.json?surface=<name>` on loopback for each of the 27 surfaces; the operator decides whether any card is published beyond loopback.
**Expected:** Each returns 200 with a validator-clean card. Publication beyond loopback is decided by the operator (none in v1.3 by default).
**Why human:** Live read against the running server, plus an exposure decision.

### 3. G3: Devnet-backed teachable anchor proof

**Test:** With the funded devnet key, emit a proof teachable into production, wait for the hourly timer to anchor its hour, read the memo back by `tx_sig`, run `substrate verify <proof graph>`.
**Expected:** The teachable's hour reports `anchored`, and the teachable event sits inside it.
**Why human:** Writes to production ledger and devnet. Agents must not execute it. The in-repo proof uses a fake RPC only.

### Gaps Summary

No in-repo gaps. All four ROADMAP success criteria are implemented, wired, and covered by passing tests in the phase's scope. The status is not `passed` because three items are operator-gated and cannot be closed by an agent: the A2A spec field-set confirmation (G1), the live loopback read and publication decision (G2), and the devnet anchor proof (G3).

---

_Verified: 2026-11-12T08:31:11Z_
_Verifier: Claude (gsd-verifier)_
