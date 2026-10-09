---
phase: "18"
slug: "guard-rails-and-shared-redactor"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-08"
audited: "2026-10-09"
---

# Phase 18 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `bun:test` (Bun 1.4.0); typecheck with `bunx tsc --noEmit` |
| **Config file** | none (`package.json` `"test": "bun test"`); `tsconfig.json` |
| **Quick run command** | `bun test packages/mcp-server/src/redact.test.ts packages/mcp-server/src/redact-lock.test.ts packages/mcp-server/src/redact-contract.test.ts` |
| **Full suite command** | `bun test && bunx tsc --noEmit` (plan-time baseline at `ab62c91`: 1129 pass / 56 skip / 0 fail; post-18-04 HEAD: 1395 pass / 57 skip / 1 fail, the fail being the pre-existing store-lock flag on `18-PATTERNS.md`; tsc clean) |
| **Estimated runtime** | quick about 2 s; full about 120 s |

---

## Sampling Rate

- **After every task commit:** run the quick run command, plus `bunx tsc --noEmit`.
- **After every plan wave:** run `bun test && bunx tsc --noEmit`.
- **Before `/gsd:verify-work`:** the full suite must be green against the baseline. The expected change is one more file (`redact-lock.test.ts`), more passes, and one or more extra skips from the gated harness block. `store-lock.test.ts` must also be green. When Phase 16's harness is on the base, the gated round trip must have run.
- **Max feedback latency:** 120 seconds.

---

## Per-Task Verification Map

| Area | Plan (task) | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| Labelled rules, D-04 merge, fixture corpus | 18-01 (T1, T2) | LANEB-06 SC1 · D18-01/03/04 | Credential in an event or memory body | Every named rule redacts its planted fixture; idempotent; `redactValue` reaches it | unit | `bun test packages/mcp-server/src/redact.test.ts` | ✅ | ✅ green |
| Event rule order (September order) — gap filled | 18-01 (T1) | LANEB-06 SC1 · D18-01 | Private prose surviving when a keyed value abuts `</private>` | `private-tag` first, `api-key-lower` right after `assignment`, the eight provider shapes in order before `jwt`; a `<private>` block ending in `password: x` goes as one block | unit | `bun test packages/mcp-server/src/redact-contract.test.ts` | ✅ (new, validate-phase) | ✅ green |
| Counter exemption kept | 18-01 (T2) | LANEB-06 SC1 · D18-02/05/06 | Over-redaction destroying usage | `input_tokens` and the other counts survive; `{tokens: fixture}` and `api_key: "short"` are redacted whole; near-misses survive | unit | `bun test packages/mcp-server/src/redact.test.ts` | ✅ | ✅ green |
| Narrowed `pk-rk` (D18-21) | 18-01 (T2), 18-02 (T2) | LANEB-06 · D18-21 | Over-redaction of branch slugs / missed publishable key | Digit-bearing `pk-`/`rk-` keys redact on both passes; word-only slugs survive both | unit | `bun test packages/mcp-server/src/redact.test.ts` | ✅ | ✅ green |
| Memory classify widened | 18-01 (T3) | LANEB-06 · D18-17 | Credential in a memory body | A `<private>` body, a D-04 shape and a digit-bearing `pk-` body classify as `secret`, not reviewable; prose and word-only slugs return null | unit | `bun test packages/mcp-server/src/memory-classify.test.ts` | ✅ | ✅ green |
| Skill engine in the same module, new skill rules, parity | 18-02 (T1, T2) | LANEB-06 SC2 · D18-07/08/09/10 | Credential in a published skill | High-confidence shapes are findings; placeholders are kept; the parity test fails on an unmatched rule; `scanSkillFiles` is the only exported scan | unit | `bun test packages/mcp-server/src/redact.test.ts` (T1 also `bunx tsc --noEmit`) | ✅ | ✅ green |
| Skill `api-key-lower` line-local — gap filled | 18-02 (T1) | LANEB-06 SC2 · D18-08 | Skill pass redacting the next line's content | `api_key:` / `apiKey =` / `api-key:` with the value on the next line yield no hit; the same value on the same line redacts as `api-key-lower` | unit | `bun test packages/mcp-server/src/redact-contract.test.ts` | ✅ (new, validate-phase) | ✅ green |
| `redactKnown` and the `lessons.ts` migration | 18-03 (T1) | LANEB-06 SC2 · D18-11 | Second redactor | Known values are scrubbed through the module longest-first, empties ignored; `lessons.ts` tests pass unchanged | unit | `bun test packages/mcp-server/src/redact.test.ts packages/cli/src/lessons.test.ts` | ✅ | ✅ green |
| Redaction lock | 18-03 (T2, T3) | LANEB-06 SC2 · D18-12/13/14/15/16 | Second, divergent redactor | Clean on the tree; catches every planted offender; passes every planted non-offender; seam rule | unit (repo) | `bun test packages/mcp-server/src/redact-lock.test.ts` | ✅ | ✅ green (see Manual-Only for two advisory pins) |
| Store lock stays green | 18-03 (T3) / 18-04 (T1) | LANEB-06 | Test or doc leaking a token | No literal token shape added | unit (repo) | `bun test packages/mcp-server/src/store-lock.test.ts` | ✅ | ✅ green for phase files (1 pre-existing fail: `18-PATTERNS.md`, present at branch base) |
| Redaction doc matches the module — gap filled | 18-04 (T1) | LANEB-06 · D18-18 | Doc drift telling a new package the wrong rules | `docs/redaction.md` rule table lists every event rule in table order; excluded rows equal `SKILL_EXCLUSIONS`; every other row has a same-name skill rule; the three pointer docs link to it | unit (repo) | `bun test packages/mcp-server/src/redact-contract.test.ts` | ✅ (new, validate-phase) | ✅ green |
| Harness round trip | 18-04 (T2) | LANEB-06 · D18-19 | Round trip hitting production | Loopback and not-7410 asserted; no fixture survives; counts do | live-isolated (gated) | `bun test packages/mcp-server/src/redact.test.ts`, with `consumer.env` sourced, between `bun run rehearsal up` and `down` | ✅ | ✅ green per 18-04 SUMMARY (instance `p18`, loopback, 174 pass / 0 fail, twin torn down); skips without env; not re-run in this audit (Docker barred for the gate) |
| Full suite | 18-04 (T2) | LANEB-06 · D18-19 | — | No regression from the baseline | suite | `bun test && bunx tsc --noEmit` | ✅ | ✅ green vs baseline per 18-04 SUMMARY (1395 / 57 / 1 pre-existing fail); tsc clean re-checked 2026-10-09 |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `packages/mcp-server/src/redact-lock.test.ts`: new, covers LANEB-06 SC2. Created in 18-03 with the lock, not as a stub.

*No framework install and no shared fixtures file: the fixtures live in `redact.test.ts`.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Harness round trip when Phase 16 is absent from the base | LANEB-06 | Depends on the Phase 16 merge order | Not triggered: Phase 16's harness was on the base and the gated round trip ran (18-04 SUMMARY). Re-run only with `consumer.env` sourced, this file only, between `rehearsal up` and `down`. |
| Live-effect line in SUMMARY and PR body | LANEB-06 · D18-20 | Process evidence, not behavior | Confirmed present in 18-04-SUMMARY.md (body and PR body block): "Redaction widens on the production write path at the operator's next approved restart of `substrate-mcp`; nothing restarts in this PR." |
| Lock scope covers shebang sources and excludes the shared module and tests (pin) | LANEB-06 · D18-13 | Filled by the orchestrator after the audit: `redact-lock.test.ts` test "lock scope holds the shebang hook and never the shared module or a test file". The tree holds no `.py`/`.sh` source today, so only the extension regex covers them; detectors are proven on planted `.py`/`.sh` bodies. | Automated: `bun test packages/mcp-server/src/redact-lock.test.ts` |
| Injected-seam allowlist is exactly three paths (pin) | LANEB-06 · D18-14/16 | Filled by the orchestrator after the audit: `redact-lock.test.ts` test "the injected-seam allowlist is exactly the three cycle-bound files". | Automated: `bun test packages/mcp-server/src/redact-lock.test.ts` |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 120s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-10-09 (validate-phase, non-interactive run: gap gate took the recommended "Fix all gaps" option; the auditor role ran inline because no subagent-spawn tool was available to the gate; two advisory pins escalated to Manual-Only because filling them needs an edit to `redact-lock.test.ts`)

## Validation Audit 2026-10-09

| Metric | Count |
|---|---|
| Gaps found | 5 |
| Resolved | 3 |
| Escalated | 2 |
