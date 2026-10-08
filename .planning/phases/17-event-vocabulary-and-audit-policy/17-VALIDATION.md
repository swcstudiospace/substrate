---
phase: "17"
slug: "event-vocabulary-and-audit-policy"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-08"
---

# Phase 17 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Derived from `17-RESEARCH.md` "Validation Architecture".

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `bun:test` (Bun 1.4.0) |
| **Config file** | none — root `bun test` discovery; `tsconfig.json` includes `scripts/**/*.ts` |
| **Quick run command** | `bun test ./packages/mcp-server/src/vocabulary-lock.test.ts ./packages/mcp-server/src/event-sources.test.ts ./packages/audit/src/policy.test.ts ./scripts/phase-close-check.test.ts ./scripts/vocabulary-smoke.test.ts ./packages/mcp-server/src/store-lock.test.ts` |
| **Full suite command** | `bun test && bunx tsc --noEmit` (baseline `ab62c91`: 1129 pass / 56 skip / 0 fail, tsc clean) |
| **Phase gate** | `bun run check:phase-close` exits 0, then the isolated proof against the Phase 16 harness |
| **Estimated runtime** | quick < 5 s; full ~60 s |

---

## Sampling Rate

- **After every task commit:** the quick run command (only the files that exist so far; Bun exits 0 when a listed file is missing, so check the file list)
- **After every plan wave:** `bun test && bunx tsc --noEmit`
- **Before `/gsd:verify-work`:** full suite green, `bun run check:phase-close` exit 0, isolated proof recorded
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Req / SC | Behavior | Test Type | Automated Command | File Exists | Status |
|----------|----------|-----------|-------------------|-------------|--------|
| FOUND-02 / SC-1 | Doc's marked table and `EVENT_SOURCES` ∪ `SILENT_SOURCES` name the same ids, kinds and actions; every roadmap source (herdr, Muse, Cursor stop, skills propose, docs ingest, desktop, anchoring, teachables) has ≥ 1 row; periodic rows carry no `repo`; no content-bearing payload keys | unit | `bun test ./packages/mcp-server/src/event-sources.test.ts` | ❌ W0 | ⬜ pending |
| FOUND-02 / SC-2 | `EVENT_KINDS` (12, ordered) and `SURFACES` (26, ordered) equal their v1.2 literals | unit | `bun test ./packages/mcp-server/src/vocabulary-lock.test.ts` | ❌ W0 | ⬜ pending |
| FOUND-02 / SC-2 | Every sample passes `normalizeEvent` with kind, surface and payload unchanged | unit | `bun test ./packages/mcp-server/src/event-sources.test.ts` | ❌ W0 | ⬜ pending |
| FOUND-02 / SC-2 | Smoke guards: refuse ports 7410/7411/6420 and non-loopback hosts; parse `consumer.env` quoted values; run tags `rh-`-prefixed and ≤ 512 chars | unit | `bun test ./scripts/vocabulary-smoke.test.ts` | ❌ W0 | ⬜ pending |
| FOUND-02 / SC-2 | One sample per mapped source stored over the wire, 0 refusals, read back N/N | live-isolated (Docker, Phase 16 harness) | `bun run rehearsal up --name p17 && bun run smoke:vocabulary --name p17; bun run rehearsal down --name p17` | ❌ proof step | ⬜ pending |
| FOUND-02 / SC-3 | Baseline parser extracts the 12 kinds from `ab62c91`; diff reports changes; a missing test file fails the check | unit | `bun test ./scripts/phase-close-check.test.ts` | ❌ W0 | ⬜ pending |
| FOUND-02 / SC-3 | Phase-close check passes on this phase | script | `bun run check:phase-close` | ❌ W0 | ⬜ pending |
| FOUND-02 / SC-3 | Store lock green with the new scripts and docs | unit (existing) | `bun test ./packages/mcp-server/src/store-lock.test.ts` | ✅ | ⬜ pending |
| FOUND-02 / SC-4 | Each planned tool explicitly in its decided set, not the other; `auditMode` equals the decision; served tool names each in exactly one set | unit | `bun test ./packages/audit/src/policy.test.ts` | ✅ (new tests W0) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

Negative checks for the verifier (temporary local edits, never committed): append `"agent.detected"` to `EVENT_KINDS` (lock test and `check:phase-close` fail); edit both `EVENT_KINDS` and the lock literal (`check:phase-close` still fails on the git diff); move `desktop_run` to `FAIL_OPEN_TOOLS` (`policy.test.ts` fails); rename `event-sources.test.ts` (`check:phase-close` exits non-zero); change a doc row's kind (`event-sources.test.ts` fails).

---

## Wave 0 Requirements

- [ ] `packages/mcp-server/src/vocabulary-lock.test.ts` — SC-2 literal pins
- [ ] `packages/mcp-server/src/event-sources.test.ts` — SC-1/SC-2 table, doc and sample tests
- [ ] `scripts/phase-close-check.test.ts` — SC-3 pure helpers
- [ ] `scripts/vocabulary-smoke.test.ts` — SC-2 guard and parser
- [ ] `packages/audit/src/policy.test.ts` — planned-tools test (+ served-name scan)

No framework install needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Isolated sample-emit proof | FOUND-02 / SC-2 | Needs Docker and the Phase 16 harness on the executing branch | `bun run rehearsal up --name p17` → `bun run smoke:vocabulary --name p17` → `bun run check:phase-close` → `bun run rehearsal down --name p17`; afterwards `docker ps -a --filter label=substrate.rehearsal=p17` is empty |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
