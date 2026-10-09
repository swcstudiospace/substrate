---
phase: "30"
slug: "desktop-run"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-08"
---

# Phase 30 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `bun:test` (Bun 1.4.0), colocated `*.test.ts` |
| **Config file** | none (root `bun test`; `tsconfig.json` includes `packages/**/*.ts`, `scripts/**/*.ts`) |
| **Quick run command** | `bun test ./packages/mcp-server/src/desktop/` |
| **Full suite command** | `bun test && bunx tsc --noEmit && bun run check:phase-close` |
| **Estimated runtime** | ~90 seconds (full suite); quick run ~5 seconds |

---

## Sampling Rate

- **After every task commit:** the touched file's own `bun test ./path/to/file.test.ts` (one command per file; several paths hide a missing file) + `bunx tsc --noEmit`
- **After every plan wave:** `bun test && bunx tsc --noEmit`
- **Before `/gsd:verify-work`:** full suite green, `bun run check:phase-close` exit 0, then the proof chain
- **Max feedback latency:** 90 seconds

---

## Per-Task Verification Map

Filled by the planner per task; requirement → test map from `30-RESEARCH.md` "Validation Architecture":

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| DESK-01 | Vocabulary, limits, argv table, `--`, no shell | unit | `bun test ./packages/mcp-server/src/desktop/actions.test.ts` | ❌ W0 (port) | ⬜ pending |
| DESK-01 | XWD 24/32 bpp decode, PNG encode/decode round trip | unit | `bun test ./packages/mcp-server/src/desktop/png.test.ts` | ❌ W0 | ⬜ pending |
| DESK-01 | Busy refusal, deadline/timeout budgets, 0600/0700, retention 200 / 7 d, child env PATH/HOME only | unit | `bun test ./packages/mcp-server/src/desktop/driver.test.ts` | ❌ W0 | ⬜ pending |
| DESK-01 | Text block + image blocks; strict schema | integration (in-memory MCP) | `bun test ./packages/mcp-server/src/desktop/tool.test.ts` | ❌ W0 | ⬜ pending |
| DESK-02 | One `tool.call` per executed action; payload per row; key rule; `stored:false` stops; no event for refusals / not-started actions | unit + integration | `bun test ./packages/mcp-server/src/desktop/driver.test.ts` | ❌ W0 | ⬜ pending |
| DESK-02 | Audit record has only arg keys + digest, no typed text, no `iVBOR` | integration (HTTP) | `bun test ./packages/mcp-server/src/http.test.ts` | ✅ file, ❌ cases | ⬜ pending |
| DESK-02 | `EVENT_SOURCES` row sample and doc in sync | unit | `bun test ./packages/mcp-server/src/event-sources.test.ts` | Phase 17 | ⬜ pending |
| DESK-03 | Unlisted valid token / anonymous refused, runner 0 calls, 0 events | integration | `bun test ./packages/mcp-server/src/desktop/tool.test.ts` | ❌ W0 | ⬜ pending |
| DESK-03 | VM guest: no bearer → 401, bogus bearer → 401, `surface` arg rejected, propose header ignored | integration (real HTTP) | `bun test ./packages/mcp-server/src/http.test.ts` | ✅ file, ❌ cases | ⬜ pending |
| DESK-03 | `auditMode("desktop_run") === "fail-closed"` | unit | `bun test ./packages/audit/src/policy.test.ts` | Phase 17 | ⬜ pending |
| DESK-03 | Allowlist parsing, unknown names dropped and warned by name | unit | `bun test ./packages/mcp-server/src/desktop/config.test.ts` | ❌ W0 | ⬜ pending |
| DESK-04 | Script gates and argv (PATH stubs), `bash -n`, shellcheck | unit | `bun test ./scripts/substrate-desktop.test.ts` | ❌ W0 | ⬜ pending |
| DESK-05 | Harness `--desktop-surfaces` and env | unit | `bun test ./packages/mcp-server/src/rehearsal-env.test.ts` / `bun test ./scripts/rehearsal.test.ts` | Phase 16 | ⬜ pending |
| DESK-05 | Pixel band in returned block, sha equalities, events, audit, live refusals, 6081 401, recruitment unchanged | e2e (harness + local container) | `bun run rehearsal up --name p30 --surfaces omp,cursor --desktop-surfaces omp && bun run smoke:desktop && bun run check:phase-close && bun run rehearsal down --name p30` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/mcp-server/src/desktop/{actions,png,driver,tool,config}.test.ts`
- [ ] `scripts/substrate-desktop.test.ts` (stub helpers inside the test file)
- [ ] `scripts/desktop-smoke.ts` + `scripts/desktop-smoke.test.ts` (band finder, marker builder, URL guard)
- [ ] new cases in `http.test.ts`, `rehearsal-env.test.ts`, `rehearsal.test.ts`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| N1 capture path yields fresh pixels | DESK-05 | Depends on the live X display of the local container; a spike, not a regression test | Follow the D30-18 spike ladder; record each step in `30-N1-SPIKE.md` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 90s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
