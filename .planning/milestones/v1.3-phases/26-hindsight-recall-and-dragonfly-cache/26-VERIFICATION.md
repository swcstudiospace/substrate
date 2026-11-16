---
phase: 26-hindsight-recall-and-dragonfly-cache
verified: 2026-11-12T08:25:33Z
status: human_needed
score: 9/9 PLAN must-haves verified at rehearsal scope; roadmap SC4 live portion and DOCS-07 not proven (operator-gated)
covered_files: [".env.example", ".planning/milestones/v1.3-phases/26-hindsight-recall-and-dragonfly-cache/26-01-PLAN.md", ".planning/milestones/v1.3-phases/26-hindsight-recall-and-dragonfly-cache/26-01-SUMMARY.md", ".planning/milestones/v1.3-phases/26-hindsight-recall-and-dragonfly-cache/26-02-PLAN.md", ".planning/milestones/v1.3-phases/26-hindsight-recall-and-dragonfly-cache/26-02-SUMMARY.md", ".planning/milestones/v1.3-phases/26-hindsight-recall-and-dragonfly-cache/26-03-PLAN.md", ".planning/milestones/v1.3-phases/26-hindsight-recall-and-dragonfly-cache/26-03-SUMMARY.md", "docs/data-planes.md", "docs/runbooks/hindsight-cache-proof.md", "packages/mcp-server/src/cache.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/hindsight-fake.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/memory-recall.test.ts", "packages/mcp-server/src/memory-recall.ts", "packages/mcp-server/src/memory-retain.test.ts", "packages/mcp-server/src/memory-retain.ts", "packages/mcp-server/src/memory-search.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planes/hindsight.test.ts", "packages/mcp-server/src/planes/hindsight.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/store-lock.test.ts"]
covered_digest: "v3:sha256:303e293667c9561fc3f00e15ed3a9c9566cb85ebf18d9a18c9f60f5270b39ba2"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_verified: 2026-10-11T02:10:00Z
  reason: "Prior report marked passed while G1-G4 and DOCS-07 are operator-gated; operator-gated checks force human_needed under the verifier decision tree."
---

# Phase 26 verification: Hindsight recall and Dragonfly cache

**Status:** human_needed. Rehearsal-scope must-haves are verified. The live steps (roadmap SC4 live portion, DOCS-07, runbook gates G1–G4) were not run and need an operator.

## Must-have results (PLAN truths + roadmap SCs)

| # | Must-have | Result | Evidence |
|---|-----------|--------|----------|
| P1-T1 | memory_recall fans out over sub-* banks, ≤4 hits/bank, source bank named, redacted, derived | VERIFIED | `planes/hindsight.ts` (bounded fan-out, shared budget); `memory-recall.ts:119` (`derived: true`); untrusted notice `memory-recall.ts:31`; `memory-recall.test.ts` fan-out/redaction/cap tests pass |
| P1-T2 | Brief compose path never imports planes/hindsight; errors → empty+reason | VERIFIED | `brief.ts` has 0 hindsight references; brief reads only the prefetched `recall-snapshot.ts` (prefetch runs outside brief budget, `recall-snapshot.ts:46`); outage test passes |
| P1-T3 | No recall without bank segment, no retain without document_id | VERIFIED | `planes/hindsight.test.ts` client/fake tests pass |
| P2-T1 | Accepted+verified_persisted memory forwarded redacted with source to writer's sub-<surface> bank, idempotent | VERIFIED | `memory-retain.ts:178` (refuses non-accepted/unverified), `:228` (`retain.unsourced`), `:249` (`retain.unredacted`); `memory-retain.test.ts` passes |
| P2-T2 | memory_search merges derived Hindsight hits; outage → index-only with reason | VERIFIED | `memory-search.ts:1-52`; `memory-recall.test.ts` "outage degrades to index-only with a reason" passes |
| P2-T3 | No HINDSIGHT_* outside mcp-server; .env.example names reader | VERIFIED | `store-lock.test.ts` HINDSIGHT scan passes; `.env.example:292-309` documents `HINDSIGHT_*` and names the reader |
| P3-T1 | Recall cached under memory-search semantics; second identical recall is a hit; fresh retain never hidden | VERIFIED | `cache.ts:50` (`memory-search: 600`); named tests "a second identical recall is a hit", "a generation bump misses and loads again" pass |
| P3-T2 | Claim newer than 60 s visible in brief right after cache hit; plaintext non-loopback redis:// refused fail-open | VERIFIED | Named test "a fresh claim is visible in a brief served right after a cache hit" passes; "a refused redis URL leaves the cache off…" passes; `config.ts:274-277` refusal; `config.test.ts` redis refusal passes |
| P3-T3 | Live touches are operator-gated steps (G1–G4) the executor stops at | VERIFIED | `docs/runbooks/hindsight-cache-proof.md:38,51,62,74` (G1–G4 each with proof/rollback); none run |
| SC1 | Retain only after accepted/verified_persisted; recall never inside brief budget | VERIFIED (rehearsal) | See P1-T2, P2-T1 |
| SC2 | Dragonfly read-through only; /healthz {enabled, connected, hits, misses, bypasses}; uncached when down; no claim hidden >60 s | VERIFIED (rehearsal) | `cache.ts:147-152` (counters); "with Dragonfly down…" test passes; claims-freshness test passes |
| SC3 | Credentials only in substrate.env; plaintext non-loopback redis refused; Tailscale hop runbook | VERIFIED (rehearsal) | `config.ts:274`; `docs/runbooks/hindsight-cache-proof.md:8-19` (Tailscale forwarder section) |
| SC4 | Headless session answers docs question with source URL; cross-surface recall; cache hit; Dragonfly-down uncached | NEEDS HUMAN (partial) | Cache-hit and Dragonfly-down behaviour verified against fakes; headless docs_search read-back and cross-surface live recall are operator-gated (G2–G4) and were not run |

**Score:** 9/9 PLAN truths and 3/4 roadmap SCs verified at rehearsal scope. SC4 live portion is human-needed.

## Requirements coverage

| Req | Status | Evidence |
|-----|--------|----------|
| DOCS-04 | SATISFIED (rehearsal) | Recall/retain/search-merge code and tests above |
| DOCS-05 | SATISFIED (rehearsal) | cache.ts counters, recall caching, Dragonfly-down tests |
| DOCS-06 | SATISFIED (rehearsal) | config.ts redis refusal, credential perimeter test, Tailscale runbook section |
| DOCS-07 | NEEDS HUMAN | Live headless proof (G4) not run; no live evidence exists |

REQUIREMENTS.md still lists DOCS-04..07 as "Pending"; that table was not edited (out of scope for this run).

## Gaps

None. No failed truths, missing artifacts, or unwired key links found.

## Human verification required

### 1. Live G1: reachability and version probe
**Test:** Run runbook step G1 (`docs/runbooks/hindsight-cache-proof.md:38`) against the live Hindsight.
**Expected:** Version and reachability read back as recorded in the runbook.
**Why human:** Live external service; executor is forbidden from touching it.

### 2. Live G2: bank ensure plus first live recall
**Test:** Runbook step G2 (`:51`).
**Expected:** `sub-*` banks ensured; first recall returns bounded, attributed, derived hits.
**Why human:** Live external service and operator approval.

### 3. Live G3: first live retain
**Test:** Runbook step G3 (`:62`).
**Expected:** One gate-accepted memory retained into the writer's bank, read back by document_id.
**Why human:** Writes to live Hindsight; operator approval.

### 4. Live G4 plus DOCS-07 headless proof
**Test:** Runbook step G4 (`:74`): cache/topology change, then a headless session holding only the substrate MCP answers a docs question with a `docs_search` source URL readable back from its event; a memory retained by one surface is recalled by another with its source; a second identical brief is a cache hit; with Dragonfly down it returns uncached.
**Expected:** All four observations hold as specified in ROADMAP SC4.
**Why human:** Live topology change and cross-surface proof; the Dragonfly private hop must exist first.

## Verification commands run (this session)

- `bun test src/cache.test.ts -t "<6 named behaviour tests>"` (in packages/mcp-server): 6 pass, 0 fail.
- `bun test src/memory-recall.test.ts src/memory-retain.test.ts src/planes/hindsight.test.ts src/store-lock.test.ts src/config.test.ts`: 177 pass, 0 fail.
- `bun test packages/mcp-server/src/config.test.ts -t redis`: 2 pass, 0 fail.
- Debt-marker scan (TBD/FIXME/XXX) over covered implementation files: none.
- Probe scripts (`scripts/*/tests/probe-*.sh`): none exist; Step 7c not applicable.

## Not run

- Full `bun test`, `bunx tsc --noEmit`, pytest, and `check:phase-close` were not re-run here (the prior report recorded them).
- Any live Hindsight/Dragonfly/RAGFlow (retired) step (G1–G4): intentionally not run.
- No `*-SECURITY.md` exists in the phase dir. Not a blocker under the verifier rule, which applies only when the file is present. Flagged for the parent.

## Notes

- The prior VERIFICATION.md reported `status: passed` at rehearsal scope with live gates named as operator-gated. Under the verifier decision tree, operator-gated checks yield `human_needed`, so the status is downgraded.
- `covered_files` / `covered_digest` are copied verbatim from `gsd-tools query verification.fingerprint`.
