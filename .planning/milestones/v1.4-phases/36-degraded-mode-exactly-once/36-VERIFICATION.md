---
phase: 36-degraded-mode-exactly-once
verified: 2026-11-12T00:00:00Z
status: passed
score: 4/4 success criteria verified (criterion 1 as amended 2026-10-21)
behavior_unverified: 0
overrides_applied: 0
covered_files: ["packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/http.test.ts", "packages/mcp-server/src/index-store.memory-exactly-once.test.ts", "packages/mcp-server/src/memory-outage-status.test.ts", "packages/mcp-server/src/memory-write.test.ts", "packages/mcp-server/src/server.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/skills-approve.test.ts", "packages/mcp-server/src/skills/propose.git.test.ts", "packages/mcp-server/src/skills/propose.test.ts", "packages/mcp-server/src/skills/propose.ts"]
covered_digest: "v3:sha256:4858b057083a70cf673ab5e3014d815f9c2917af3019a5f3f88d5f5af54982f8"
---

# 36-VERIFICATION: Degraded-mode exactly-once replay

Re-verification of the archived v1.4 phase against the current tree (HEAD `79494be6`). It supersedes the 2026-10-21 record, which pinned `efa3ee4`. Commits in scope: `5b5f68f`, `c74fa07`, `7cf8d44` (addendum in SUMMARY.md).

## Goal Achievement

| # | Truth (ROADMAP success criterion) | Status | Evidence |
|---|---|---|---|
| 1 | Memory write with an idempotency key applies once and returns the original result | ✓ VERIFIED | `memory-write.test.ts` "exactly-once across a degraded substrate" describe (line 2052) passed: same explicit key replayed → one row, original entry. Same describe: outage after commit, then same-key replay → one row. Fake-store run, 5 pass / 0 fail. Live-PG variant (`index-store.memory-exactly-once.test.ts`) not run here: no Postgres reachable (see below). |
| 1 | Skill approve replay answers `exists`, no second row or event | ✓ VERIFIED | `skills-approve.test.ts:384` "asking again for the same merge answers exists: no second row, no second event" — pass |
| 1 | Skill propose replay answers `existing`, no second push or PR | ✓ VERIFIED | `skills/propose.test.ts` "a recorded PR that is OPEN is existing, with no clone, push or create" — pass; `skills/propose.git.test.ts:181` "resubmitting identical content is existing with no second push or PR" — pass |
| 2 | Write without a key behaves as today | ✓ VERIFIED | `memory-write.test.ts` keyless write describe (line 2063 region) — new content writes each time, identical retry dedupes; passed |
| 3 | 503 path is covered by a test | ✓ VERIFIED | `memory-outage-status.test.ts:18` (refused claim → 503), `:34` (no index → 503, not 403), `:45` (policy refusal → 403) — 3 pass; `server.test.ts` 503 tests on `memoryWriteStatus` (`server.ts:579-591`) |
| 4 | Dependent client queue built, or recorded as a decision request with a default | ✓ VERIFIED (recorded) | `CONTEXT.md` D4 and `SUMMARY.md` GREY_AREA 2 record the lessons-CLI queue as stopped with defaults. Omp skill queue already exists at `packages/projector/omp/substrate-skills.ts:205-212`. |

**Score:** 4/4 success criteria verified; 0 behavior-unverified.

## Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/mcp-server/src/memory-outage-status.test.ts` | 503 coverage | ✓ VERIFIED | 55 lines; 3 tests pass |
| `packages/mcp-server/src/index-store.memory-exactly-once.test.ts` | live-PG exactly-once | ⚠️ NOT RUN | 145 lines; skips without `SUBSTRATE_TEST_PG_URL`; the URL was set to the scratch default and connection was refused, so it did not execute |
| `packages/mcp-server/src/memory-write.test.ts` | exactly-once cases | ✓ VERIFIED | Fake-store describe passes |
| `packages/mcp-server/src/skills/propose.git.test.ts` | propose replay | ✓ VERIFIED | Real-git test passes |

## Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `POST /memory` route | `Substrate.writeMemory` | body incl. `idempotency_key` | ✓ WIRED | `server.ts:1070-1084` (per CONTEXT.md, unchanged) |
| `writeMemory` | `memoryWriteStatus` | `result.reason` `store.*` → 503 | ✓ WIRED | `server.ts:579-591`; `service.ts:3105, 3139` |
| `skills approve` | natural-key dedupe | `decideSkill` → `exists` | ✓ WIRED | `skills-approve.test.ts:384` |

## Data-Flow / Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| 503 mapping and policy 403 | `bun test memory-outage-status.test.ts` | 3 pass, 0 fail | ✓ PASS |
| Memory exactly-once (fake store) | `bun test memory-write.test.ts -t "exactly-once across a degraded\|the same explicit key never writes twice\|keyed replay after a newer version"` | 5 pass, 0 fail | ✓ PASS |
| Skill approve + propose replay | `bun test skills-approve.test.ts skills/propose.test.ts -t ...` | 2 pass, 0 fail | ✓ PASS |
| Skill propose identical resubmit (real git) | `bun test skills/propose.git.test.ts -t "resubmitting identical content"` | 1 pass, 0 fail | ✓ PASS |
| Live-PG memory exactly-once | `bun test index-store.memory-exactly-once.test.ts` | connection refused (`ERR_POSTGRES_CONNECTION_REFUSED`) | ? SKIP (environment) |

## Requirements Coverage

The phase cites the uplift-7 audit row "With the substrate unavailable, a dependent client finishes degraded; queued writes apply exactly once" (ROADMAP v1.4). No `Phase 36` row exists in `v1.4-REQUIREMENTS.md`; coverage is assessed against the ROADMAP criteria above.

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `packages/mcp-server/src/index-store.memory-exactly-once.test.ts` | — | none (no TBD/FIXME/XXX) | ℹ️ Info | — |
| Added lines in `5b5f68f`, `c74fa07`, `7cf8d44` | — | no TBD/FIXME/XXX | ℹ️ Info | — |

## Not Run

- Live-PG tests (`index-store.memory-exactly-once.test.ts`): no Postgres at the scratch URL. Previous record (2026-10-21) reports them passing on a throwaway Postgres 16; not reproduced here.
- Full `bun test`, `bunx tsc --noEmit`: not run (out of scope for a verifier re-run).
- Lessons-CLI 503 → `denied` mapping (`packages/cli/src/lessons.ts:759-760`) is a known dependent-client bug noted in SUMMARY.md; not part of the four criteria, not fixed.

## Gaps Summary

No blocking gaps. All four ROADMAP criteria are met by code and passing tests. Open items are environmental (live-PG run) and the recorded decisions (skills get no explicit key; lessons-CLI queue stopped with defaults), which the criterion permits.

---

_Verified: 2026-11-12_
_Verifier: Claude (gsd-verifier)_
