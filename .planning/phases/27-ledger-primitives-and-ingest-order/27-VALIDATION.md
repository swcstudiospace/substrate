---
phase: "27"
slug: "ledger-primitives-and-ingest-order"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-08"
---

# Phase 27 — Validation Strategy

> The validation contract for Phase 27: what is sampled and when, so execution gets fast feedback.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `bun:test` (Bun 1.4.0) and `bunx tsc --noEmit` (TypeScript 5.x) |
| **Config file** | none for tests; `tsconfig.json` (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) |
| **Quick run command** | `bun test packages/ledger packages/mcp-server/src/greptime.test.ts packages/mcp-server/src/service.test.ts packages/mcp-server/src/store-lock.test.ts` (add `packages/mcp-server/src/redact-lock.test.ts` once it is on the base) |
| **Full suite command** | `bun test && bunx tsc --noEmit` |
| **Scratch command** | `bun run rehearsal up --name p27 && set -a && . "${XDG_RUNTIME_DIR:-/tmp}/substrate-rehearsal/p27/stores.env" && set +a && bun run smoke:greptime; bun run rehearsal down --name p27` |
| **Estimated runtime** | quick run about 15 s; full suite about 90 s; scratch run about 120 s |

---

## Sampling Rate

- **After every task commit:** run the quick run command.
- **After every plan wave:** run the full suite command. The baseline at `ab62c91` is 1129 pass / 56 skip / 0 fail. The expected result is that baseline plus 45 ported ledger tests plus the new cases, with 0 fail.
- **Before `/gsd:verify-work`:** the full suite must be green, and one scratch run must have recorded `greptime/greptimedb:v0.14.4` and the stated gap to production v1.1.4.
- **Max feedback latency:** 120 seconds.

---

## Per-Task Verification Map

This is a requirement-level map, taken from `27-RESEARCH.md` § Validation Architecture. The PLAN files bind task IDs to these rows.

| Requirement | Behavior | Threat Ref | Test Type | Automated Command | File Exists | Status |
|-------------|----------|------------|-----------|-------------------|-------------|--------|
| ANCHOR-02 | RFC 6962 reference vectors, memo/period/rpc/solana contracts (45 ported tests) | T-27 root non-determinism, memo leakage | unit | `bun test packages/ledger` | ❌ W0 (port) | ⬜ pending |
| ANCHOR-02 | `@substrate/ledger` resolves from mcp-server after `bun install` | — | typecheck | `bunx tsc --noEmit` | ❌ W0 | ⬜ pending |
| ANCHOR-01 | `migrate` creates `event_ingest` (`append_mode`, no PK) after `agent_events`; a failure warns and never falls back to a deduplicating table | T-27 dedup loss | unit | `bun test packages/mcp-server/src/greptime.test.ts` | ✅ file, new cases | ⬜ pending |
| ANCHOR-01 | Canonical 11-column `anchors` DDL; shape warning on mismatch (name, type, semantic type); silent when unreadable | T-27 append-only bypass | unit | `bun test packages/mcp-server/src/greptime.test.ts` | ✅ file, new cases | ⬜ pending |
| ANCHOR-01 | Ingest `INSERT` follows the event `INSERT`; values quoted; null `graph_id` written as `NULL`; one retry; a double failure throws `IngestNotRecorded` and the event `INSERT` was sent exactly once; late-record stderr warning | T-27 SQL injection, late record | unit | `bun test packages/mcp-server/src/greptime.test.ts` | ✅ file, new cases, plus the edit at :293 | ⬜ pending |
| ANCHOR-01 | `append`: `IngestNotRecorded` gives `stored: true`, a warning and a stderr line with the id; other errors unchanged | T-27 duplicate emit | unit | `bun test packages/mcp-server/src/service.test.ts` | ✅ file, new cases | ⬜ pending |
| ANCHOR-01 | Hour read: three flat statements, ISO bounds, batches of at most 500 ids, earlier-record exclusion, duplicate collapse, `(ingested_at, event_id)` order whatever the row order | T-27 root non-determinism | unit | `bun test packages/mcp-server/src/greptime.test.ts` | ✅ file, new cases | ⬜ pending |
| ANCHOR-01 | `store-lock.test.ts` unedited and green | T-27 second door | lock | `bun test packages/mcp-server/src/store-lock.test.ts` | ✅ | ⬜ pending |
| ANCHOR-01 | `redact-lock.test.ts` unedited and green | — | lock | `bun test packages/mcp-server/src/redact-lock.test.ts` | ⏳ on the base after Phase 18 | ⬜ pending |
| ANCHOR-02 | `hourDigest`: refuses a non-whole hour and an open hour; an empty hour gives a null root and memo; the result is identical twice and under shuffled rows; a backdated `ts` sits in its ingest hour; one altered hash changes the root; a missing row or malformed hash fails, naming the event | T-27 partial root | unit | `bun test packages/mcp-server/src/service.test.ts` | ✅ file, new cases | ⬜ pending |
| ANCHOR-01/02 | Scratch: migrate creates both tables; one record per burst event; the same root and memo twice for every hour the burst touches; burst members in emitted order; the backdated event is a member; the chain verifies; hashes unchanged | T-27 prod write | live-isolated (Docker) | scratch command above | ❌ smoke section is new | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/ledger/src/{merkle,memo,period,rpc,solana}.ts` and the matching `*.test.ts`, ported byte-identical from `acc30a8` (D27-01)
- [ ] `packages/ledger/src/index.ts`, re-exports only (D27-02)
- [ ] `packages/mcp-server/package.json` gains `"@substrate/ledger": "workspace:*"`; run `bun install` (one `bun.lock` line)
- [ ] `packages/mcp-server/src/greptime.test.ts:293`: `sql.at(-1)` becomes `insertStatement(sql)`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Production `anchors` shape matches the canonical DDL | ANCHOR-01 (D27-17) | A live production read; needs operator approval | After approval, run read-only `SHOW TABLES`, `SHOW CREATE TABLE "anchors"` and `DESCRIBE "anchors"` through `GreptimeClient.sql` (`assertAppendOnly` admits reads only). Record the column list, the options and the row count, never a host or credential. If the operator defers, D27-18 applies. |
| `event_ingest` DDL accepted by production GreptimeDB v1.1.4 | ANCHOR-01 (D27-23) | It first runs at the post-merge restart, which is a deploy | Check the boot log of the approved deploy for migrate warnings. |

---

## Validation Sign-Off

- [ ] All tasks have an `<automated>` verify or a Wave 0 dependency
- [ ] Sampling continuity: no 3 consecutive tasks without an automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120 s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
