---
phase: 29-agent-cards-and-teachable-moments
verified: 2026-11-18T12:22:32Z
status: human_needed
score: 2/4 success criteria verified in-repo; 2 human_needed (operator-gated G1, G3)
covered_files: [".planning/milestones/v1.3-phases/29-agent-cards-and-teachable-moments/29-01-PLAN.md", ".planning/milestones/v1.3-phases/29-agent-cards-and-teachable-moments/29-01-SUMMARY.md", ".planning/milestones/v1.3-phases/29-agent-cards-and-teachable-moments/29-02-PLAN.md", ".planning/milestones/v1.3-phases/29-agent-cards-and-teachable-moments/29-02-SUMMARY.md", ".planning/milestones/v1.3-phases/29-agent-cards-and-teachable-moments/29-03-PLAN.md", ".planning/milestones/v1.3-phases/29-agent-cards-and-teachable-moments/29-03-SUMMARY.md", "docs/agent-cards.md", "packages/mcp-server/src/agent-card.fixtures.ts", "packages/mcp-server/src/agent-card.test.ts", "packages/mcp-server/src/agent-card.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/teachable-anchor.test.ts", "packages/mcp-server/src/teachable.fixtures.ts", "packages/mcp-server/src/teachable.test.ts", "packages/mcp-server/src/teachable.ts", "packages/mcp-server/src/types.ts"]
covered_digest: "v3:sha256:a30935b76969696d12a41b4e20b55971d549953efbd799b5e34cfb108659f8c9"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "G1: fetch https://a2a-protocol.org/latest/specification/ and diff the Agent Card required fields against validateAgentCard() in packages/mcp-server/src/agent-card.ts; record confirmation or correction"
    expected: "Published A2A v1.0 required Agent Card fields match the in-repo set (id, name, description, supportedInterfaces, capabilities, default modes, skills[]), or the validator is corrected and its fixture corpus re-pinned"
    why_human: "Requires a network read of the published spec, which the phase plan gates behind operator approval; agents must not fetch it. Criterion 1 says 'validates against the spec' and the in-repo validator is explicitly UNVERIFIED until this runs"
  - test: "G3: with the funded devnet key, emit a proof teachable into the production ledger, let the hourly timer anchor its hour, read the memo back by tx_sig, run `substrate verify <proof graph>`"
    expected: "The teachable's hour reports status anchored on devnet, with the teachable event inside it"
    why_human: "Live devnet transaction and production ledger write; operator-approved window only. The in-repo scratch-ledger proof with a fake RPC does not exercise the chain"
  - test: "G2: GET /.well-known/agent-card.json?surface=<name> for each of the 27 surfaces on the loopback listener; decide whether any card is exposed beyond loopback"
    expected: "Each surface returns a 200 card that passes validateAgentCard; no exposure beyond loopback is approved by default"
    why_human: "Read against a live listener and an exposure decision that belongs to the operator. Not a blocker for the in-repo criteria"
---

# Phase 29: Agent Cards and teachable moments — Verification

**Phase Goal:** Each agent surface publishes a spec-valid A2A Agent Card whose skills include what it has been taught, and every teachable is covered by the hourly anchor.
**Verified:** 2026-11-18T12:22:32Z
**Status:** human_needed
**Re-verification:** No — initial verification against this record's ROADMAP success criteria (no prior `gaps:` section existed)
**Checked at:** worktree HEAD `357d6b15` (branch `gsd/autonomous-rerun`)

Phase artifacts live under `.planning/milestones/v1.3-phases/29-agent-cards-and-teachable-moments/`; the `.planning/phases/29-*` path from `init.phase-op` does not exist in this checkout.

## Goal Achievement

### Success Criteria (ROADMAP Phase 29)

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Each surface has an A2A v1.0 Agent Card on loopback at `/.well-known/agent-card.json` that validates against the spec (id, name, description, supported interfaces, capabilities, default modes, `skills[]`) | ? UNCERTAIN (human_needed) | Route in `packages/mcp-server/src/server.ts` (`GET /.well-known/agent-card.json`, `?surface=` required, unknown surface 400). Builder `buildAgentCard` in `agent-card.ts` emits id, name, description, url, version, capabilities, defaultInputModes, defaultOutputModes, supportedInterfaces, skills[]. `validateAgentCard` is an in-repo field check, not the published spec: its header states it is UNVERIFIED until G1. Tests pass (`agent-card.test.ts`: "every known surface gets a validator-clean card", "200 with a validator-clean card for a taught surface", 400 cases). Spec conformance is unproven until G1. Listener defaults to `127.0.0.1` (`config.ts`, `index.ts`); the card route has no loopback check of its own, so exposure relies on the bearer gate (`publicEdgeNeedsBearer` returns 401 for public-edge requests without a surface token). |
| 2 | A teachable is a tagged governed `fact` written through `memory_write`, no new memory kind; each accepted teachable is an entry in its surface's card `skills[]` | ✓ VERIFIED | `teachable.ts`: `isTeachable` requires kind `fact` and a non-empty `teachable:` subject slug. `MemoryKind` is unchanged in `types.ts`. `service.ts` `writeMemory` runs through the normal gate. `teachablesForSurface` (service.ts) reads by `subjectPrefix` + `writer` + `kind` and excludes superseded rows. `buildAgentCard` maps each to one `skills[]` entry with tag `teachable-moment`. Tests: `agent-card.test.ts` "one skill entry per teachable, newest first", "returns exactly the surface's live teachable facts", "another surface sees only its own", "an empty-slug fact never becomes a skill". |
| 3 | Teachable writes emit events inside the hourly anchor's coverage, and `verify` reports the hour holding a teachable as anchored | ✓ VERIFIED (in-repo scratch-ledger proof) | `service.ts` `writeMemory` emits `teachableEvent` (kind `note`, payload `{action:"teachable", memory_id, subject, content_sha256}`) only for accepted + `verified_persisted` + non-deduplicated teachables. `teachable-anchor.test.ts` "the teachable event sits inside a verify-reported anchored hour" passes (status `anchored`, `tx_sig` from the fake read-back). "altering one event in the hour fails verify naming the hour" passes (status `mismatch`). Devnet leg is G3 (see human items), not required for this criterion as written. |
| 4 | A teachable recorded from a session appears in that surface's Agent Card, and its event sits inside an anchored hour | ? UNCERTAIN (human_needed) | Session → card leg: `agent-card.test.ts` "card end-to-end (session → card)" passes. Anchored-hour leg: the scratch proof covers the mechanism, but the phase's own Proof note states the anchored hour needs a devnet anchor in an operator-approved window (G3). Not executed. |

**Score:** 2/4 criteria VERIFIED; 2 human_needed (criterion 1: spec conformance via G1; criterion 4: live devnet anchored hour via G3). No criterion is FAILED.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/agent-card.ts` | Card builder, in-repo validator, skill naming | ✓ VERIFIED | Present, substantive, wired into `server.ts` route |
| `packages/mcp-server/src/teachable.ts` | Teachable predicate, slug, trail event builder | ✓ VERIFIED | Present, wired into `service.ts` `writeMemory` |
| `packages/mcp-server/src/service.ts` | Teachable emit in `writeMemory`; `teachablesForSurface` | ✓ VERIFIED | Both present (added in PR #50 `bc8f839f`) |
| `packages/mcp-server/src/server.ts` | Loopback-listener card route | ✓ VERIFIED | Route present; 400 paths tested |
| `packages/mcp-server/src/index-store.ts`, `types.ts` | `writer` and `kind` search filters | ✓ VERIFIED | Present in `searchMemoryPage` and `MemorySearch` |
| `docs/agent-cards.md` | Convention, route, anchor coverage, G1–G3 markers | ✓ VERIFIED | Present; states G1–G3 are operator-gated and never run by agents |
| `teachable-anchor.test.ts`, `agent-card.test.ts`, `teachable.test.ts` | Pinned behavior | ✓ VERIFIED | Targeted run below: 160 pass, 0 fail |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `writeMemory` (service.ts) | `teachableEvent` → `emit` | accepted + verified teachable | ✓ WIRED | Emit is awaited with a caught failure, so a failed trail write never fails the memory write (residual risk noted below) |
| `server.ts` card route | `teachablesForSurface` → `buildAgentCard` | `GET /.well-known/agent-card.json` | ✓ WIRED | 200 path tested over a real loopback listener |
| `teachablesForSurface` | `IndexStore.searchMemoryPage` | `subjectPrefix`, `writer`, `kind` | ✓ WIRED | Filters are applied in SQL before paging (`index-store.ts`) |
| teachable event | hourly anchor / `verifyGraph` | ledger row → `hourDigest` | ✓ WIRED (scratch) | Proven against a scratch ledger with a fake RPC; live chain not exercised |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| card route | `skills[]` | `index.searchMemoryPage` over `memory_entries` | Yes (test store honours prefix/writer/kind) | ✓ FLOWING |
| teachable event | `payload.memory_id`, `content_sha256` | accepted `MemoryEntry` (`entry.id`, `entry.entry_hash`) | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Phase 29 card, teachable, and anchor-proof tests | `cd packages/mcp-server && bun test src/agent-card.test.ts src/teachable.test.ts src/teachable-anchor.test.ts` | 160 pass, 0 fail, 1106 expect() calls | ✓ PASS |

### Probe Execution

No probe scripts declared for this phase. Skipped.

### Requirements Coverage

| Requirement | Source | Description | Status | Evidence |
|-------------|--------|-------------|--------|----------|
| CARD-01 | 29-02 | Per-surface A2A card on loopback | ? NEEDS HUMAN (shape verified; spec conformance via G1) | `agent-card.ts`, `server.ts` route, `agent-card.test.ts` |
| CARD-02 | 29-01, 29-02 | Teachable as governed fact; card skills | ✓ SATISFIED | `teachable.ts`, `service.ts`, card tests |
| CARD-03 | 29-01, 29-03 | Teachable events in anchor coverage | ✓ SATISFIED (scratch proof); live leg G3 | `teachable-anchor.test.ts` |
| CARD-04 | 29-03 | Card e2e plus anchored-hour proof | ? NEEDS HUMAN (card leg verified; anchored-hour leg G3) | `agent-card.test.ts` e2e; G3 not run |

### Drift since the merge (`bc8f839`)

The prior record (dated 2026-10-11) said the card and teachable sources were "byte-identical since PR #50". That is no longer true at HEAD `357d6b15`. Later commits changed these files:

- `agent-card.ts` (+4/−2): the description warning also covers entries with `expired === true` (uplift-3 N4 TTL). This changes card content for expired-but-served entries under report mode.
- `teachable.ts` (+1/−1), `agent-card.test.ts`, `teachable.test.ts`, `teachable-anchor.test.ts`: `exactOptionalPropertyTypes` cleanup (`ca482e8e`), plus a `steering` constructor argument in test fixtures.
- `service.ts`, `server.ts`, `index-store.ts`, `types.ts` changed substantially by later phases. Phase 29 hunks still pass the targeted tests above.

The targeted tests were re-run at this HEAD. Behavior the tests pin still holds.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `agent-card.ts`, `teachable.ts` | 16 / 17 | `SOLANA_*` appears in comments only | ℹ️ Info | Comment asserting the absence of `SOLANA_*` names; no code reference |

No `TBD`, `FIXME`, `XXX`, or `TODO` debt markers in the phase's card or teachable sources. No stubs found.

### Residual risks (not gaps)

- **Silent trail failure.** The teachable emit is `.catch(() => undefined)` (service.ts). A failed emit leaves a teachable outside the anchor, and nothing reports it. This is the same precedent as `auditMemoryWrite`, so it is a design choice, not a regression. Criterion 3 depends on the emit succeeding.
- **Card route has no loopback check of its own.** The bearer gate governs it. The listener binds `127.0.0.1` by default, but `SUBSTRATE_HOST` can change that. The G2 exposure decision covers this.
- **Route shape.** The ROADMAP wording "at `/.well-known/agent-card.json`" is served as one route with `?surface=` demultiplexing, as the 400 rules require. This matches the design in `docs/agent-cards.md`.

### Human Verification Required

#### 1. G1 — spec conformance (criterion 1, CARD-01)

**Test:** Fetch `https://a2a-protocol.org/latest/specification/` (operator-approved, read-only). Diff the Agent Card required fields against `validateAgentCard()` in `packages/mcp-server/src/agent-card.ts`. Record confirmation or correction.
**Expected:** The published v1.0 required set matches the in-repo set, or the validator and its fixture corpus are corrected.
**Why human:** The phase plan gates the network read behind operator approval. The in-repo validator is explicitly UNVERIFIED until this runs.

#### 2. G3 — devnet anchored hour (criterion 4, CARD-04 live leg)

**Test:** With the funded devnet key, emit a proof teachable into the production ledger. Let the hourly timer anchor its hour. Read the memo back by `tx_sig`. Run `substrate verify <proof graph>`.
**Expected:** The teachable's hour reports `anchored` on devnet, with the teachable event inside it.
**Why human:** Live devnet transaction and production ledger write. Requires an operator-approved window. The scratch proof uses a fake RPC.

#### 3. G2 — loopback card read and exposure decision

**Test:** For each of the 27 surfaces, `GET /.well-known/agent-card.json?surface=<name>` on the loopback listener. Decide whether any card is exposed beyond loopback.
**Expected:** Each returns 200 with a validator-clean card. No exposure beyond loopback is approved by default.
**Why human:** Live read plus an operator exposure decision.

---

## Gaps Summary

No blockers. No criterion is FAILED. Status is `human_needed` because criterion 1 (spec conformance) and criterion 4 (anchored-hour leg) need the operator-gated steps G1 and G3. Criteria 2 and 3 are verified in-repo.

---

_Verified: 2026-11-18T12:22:32Z_
_Verifier: Claude (gsd-verifier)_
