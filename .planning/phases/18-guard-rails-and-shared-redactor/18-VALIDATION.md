---
phase: "18"
slug: "guard-rails-and-shared-redactor"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-08"
---

# Phase 18 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `bun:test` (Bun 1.4.0); typecheck with `bunx tsc --noEmit` |
| **Config file** | none (`package.json` `"test": "bun test"`); `tsconfig.json` |
| **Quick run command** | `bun test packages/mcp-server/src/redact.test.ts packages/mcp-server/src/redact-lock.test.ts` |
| **Full suite command** | `bun test && bunx tsc --noEmit` (baseline at `ab62c91`: 1129 pass / 56 skip / 0 fail across 40 files; tsc clean) |
| **Estimated runtime** | quick about 2 s; full about 120 s |

---

## Sampling Rate

- **After every task commit:** run the quick run command, plus `bunx tsc --noEmit`.
- **After every plan wave:** run `bun test && bunx tsc --noEmit`.
- **Before `/gsd:verify-work`:** the full suite must be green against the baseline. The expected change is one more file (`redact-lock.test.ts`), more passes, and one or more extra skips from the gated harness block. `store-lock.test.ts` must also be green. When Phase 16's harness is on the base, the gated round trip must have run.
- **Max feedback latency:** 120 seconds.

---

## Per-Task Verification Map

| Area | Plan (expected) | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| Labelled rules, D-04 merge, fixture corpus | 18-01 | LANEB-06 SC1 | Credential in an event or memory body | Every named rule redacts its planted fixture; idempotent; `redactValue` reaches it | unit | `bun test packages/mcp-server/src/redact.test.ts` | ✅ extend | ⬜ pending |
| Counter exemption kept | 18-01 | LANEB-06 SC1 | Over-redaction destroying usage | `input_tokens` and the other counts survive; `{tokens: fixture}` and `api_key: "short"` are redacted whole | unit | `bun test packages/mcp-server/src/redact.test.ts` | ✅ extend | ⬜ pending |
| Memory classify widened | 18-01 | LANEB-06 | Credential in a memory body | A `<private>` body and a D-04 shape classify as `secret` | unit | `bun test packages/mcp-server/src/memory-classify.test.ts` | ✅ extend | ⬜ pending |
| Skill engine in the same module, new skill rules, parity | 18-02 | LANEB-06 SC2 | Credential in a published skill | High-confidence shapes are findings; placeholders are kept; the parity test fails on an unmatched rule | unit | `bun test packages/mcp-server/src/redact.test.ts` | ✅ extend | ⬜ pending |
| `redactKnown` and the `lessons.ts` migration | 18-03 | LANEB-06 SC2 | Second redactor | Known values are scrubbed through the module; `lessons.ts` behaviour is unchanged | unit | `bun test packages/mcp-server/src/redact.test.ts packages/cli/src/lessons.test.ts` | ✅ | ⬜ pending |
| Redaction lock | 18-03 | LANEB-06 SC2 | Second, divergent redactor | Clean on the tree; catches every planted offender; passes every planted non-offender; seam rule | unit (repo) | `bun test packages/mcp-server/src/redact-lock.test.ts` | ❌ W0 | ⬜ pending |
| Store lock stays green | 18-03/18-04 | LANEB-06 | Test or doc leaking a token | No literal token shape added | unit (repo) | `bun test packages/mcp-server/src/store-lock.test.ts` | ✅ | ⬜ pending |
| Harness round trip | 18-04 | LANEB-06 | Round trip hitting production | Loopback and not-7410 asserted; no fixture survives; counts do | live-isolated (gated) | `bun test packages/mcp-server/src/redact.test.ts`, with `consumer.env` sourced, between `bun run rehearsal up` and `down` | ✅ gated / harness ❌ until Phase 16 is on the base | ⬜ pending |
| Full suite | 18-04 | LANEB-06 | — | No regression from the baseline | suite | `bun test && bunx tsc --noEmit` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/mcp-server/src/redact-lock.test.ts`: new, covers LANEB-06 SC2. It is created in the plan that ships the lock, not as a stub.

*No framework install and no shared fixtures file: the fixtures live in `redact.test.ts`.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Harness round trip when Phase 16 is absent from the base | LANEB-06 | Depends on the Phase 16 merge order | If `scripts/rehearsal.ts` is absent after rebasing, record "harness round trip not run: Phase 16 not on base" in the SUMMARY and the PR body |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
