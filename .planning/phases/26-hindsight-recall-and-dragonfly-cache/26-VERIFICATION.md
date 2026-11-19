---
phase: 26-hindsight-recall-and-dragonfly-cache
verified: 2026-11-18T00:00:00Z
status: human_needed
score: 2/4 success criteria verified in code and rehearsal; criterion 1 carries a WARNING; criterion 4 live proof operator-gated
behavior_unverified: 1
overrides_applied: 0
covered_files: [".env.example", ".planning/milestones/v1.3-phases/26-hindsight-recall-and-dragonfly-cache/26-01-PLAN.md", ".planning/milestones/v1.3-phases/26-hindsight-recall-and-dragonfly-cache/26-01-SUMMARY.md", ".planning/milestones/v1.3-phases/26-hindsight-recall-and-dragonfly-cache/26-02-PLAN.md", ".planning/milestones/v1.3-phases/26-hindsight-recall-and-dragonfly-cache/26-02-SUMMARY.md", ".planning/milestones/v1.3-phases/26-hindsight-recall-and-dragonfly-cache/26-03-PLAN.md", ".planning/milestones/v1.3-phases/26-hindsight-recall-and-dragonfly-cache/26-03-SUMMARY.md", "docs/data-planes.md", "docs/runbooks/hindsight-cache-proof.md", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/memory-recall.ts", "packages/mcp-server/src/memory-retain.ts", "packages/mcp-server/src/planes/hindsight.ts", "packages/mcp-server/src/recall-snapshot.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:01be1474bd68f4bf3e8663a4ddd21fb99277022266086b484358585d48133b7e"
gaps: []
human_verification:
  - test: "Run the DOCS-07 headless proof and the G1-G4 live gates from docs/runbooks/hindsight-cache-proof.md, in order, in an operator-approved window"
    expected: "A headless session holding only the substrate MCP answers a docs question with a source URL that docs_search returned and that is readable back from its event; a memory retained by one surface (gate-accepted, verified_persisted, sourced) is recalled by another surface with its source bank; a second identical brief is a cache hit on /healthz.cache.hits; with Dragonfly down the same brief returns uncached and equal"
    why_human: "Requires live Hindsight, RAGFlow/LightRAG, Dragonfly and a headless agent session; the runbook marks these as operator-gated and the rehearsal harness cannot reach them"
  - test: "Decide whether the brief's enforce-mode Recalled context section (SUBSTRATE_BRIEF_RECALL=enforce) is acceptable against success criterion 1"
    expected: "Either accept that enforce mode may hold the brief response up to BRIEF_RECALL_CAP_MS (3000 ms, measured from brief start) to read recall, or require recall to stay out of the brief response path as D26-05 states"
    why_human: "Policy decision: the phase 26 contract says recall never runs inside the brief's 1.5 s budget; a later phase (uplift-4 S5) added an awaited, capped recall section that is outside the 1.2 s source budget but inside the 3 s cap. The default is off, so the shipped default meets the criterion"
---

# Phase 26 verification: Hindsight recall and Dragonfly cache

**Phase Goal:** Accepted memories are recallable across surfaces and repeated reads are cached, without either plane slowing the brief, hiding a fresh claim or holding a credential outside `substrate.env`.
**Verified:** 2026-11-18 against branch `gsd/autonomous-rerun`, HEAD `357d6b15`
**Status:** human_needed
**Re-verification:** No (the prior record is `.planning/milestones/v1.3-phases/26-hindsight-recall-and-dragonfly-cache/26-VERIFICATION.md`, dated 2026-10-11 at `ed696ef`; this record re-checks the four roadmap success criteria against the current tree and does not rely on it)

## Goal Achievement

### Observable Truths

| # | Success criterion | Status | Evidence |
|---|-------------------|--------|----------|
| 1 | Hindsight retains a memory only after the gate returns `accepted` with `verified_persisted`, redacted and sourced, into `sub-<surface>`. Recall is a tool or derived `memory_search`, and never runs inside the 1.5 s brief budget. | ⚠️ UNCERTAIN (WARNING) | Retain gate: `service.ts:3353` forwards only when `outcome === "accepted" && verified_persisted && result.entry`. `memory-retain.ts` `forwardEntry` refuses `retain.unsourced` when no `source_event`, refuses `retain.unredacted` on any finding, and bank is `bankForSurface(config, writer)` = `sub-<surface>` (`planes/hindsight.ts:bankForSurface`). The criterion says "receipt_path or source"; the code carries `source` (metadata `source` = the entry's `source_event`); no `receipt_path` exists anywhere in the code, which the "or" permits. Recall tool: `mcp.ts:930` `memory_recall`, `memory-recall.ts` fan-out with `derived: true` hits and untrusted notice. `memory_search` merge: `mcp.ts:903` appends derived plane hits after index entries. **Gap in the budget clause:** the brief's enforce-mode `Recalled context` section (`brief.ts:310`, `recall-snapshot.ts:46` `BRIEF_RECALL_CAP_MS = 3000`) awaits a recall read inside the brief response path, up to 3 s from brief start, past the 1.2 s source budget (`config.ts:1196`) and the 1.5 s recall budget. It is off by default (`.env.example:765` `SUBSTRATE_BRIEF_RECALL=off`), so the shipped default meets the clause. D26-05 (`26-CONTEXT.md:61`) said the brief never calls recall inline. See the human item on this. |
| 2 | Dragonfly is read-through only; `/healthz` reports `{enabled, connected, hits, misses, bypasses}`; identical answers come back uncached while Dragonfly is down; a cached brief never hides a claim older than 60 s. | ✓ VERIFIED (note on wording) | Read-through: `cache.ts` `ReadThroughCache` serves a value only on a hit; every failure path is a bypass (`cache.ts:1118`), and the brief/recall paths fall through to the live compose on bypass. `/healthz`: `health()` (`cache.ts:523`) returns `enabled, connected, mode, hits, misses, bypasses, errors, ...`; `service.ts:8766` places it in the health body as `cache`, and `server.ts:993-1056` serves that body. Health "does not ping Dragonfly" (`service.ts:8762` comment). Down-plane equivalence: `cache.test.ts:884` "with Dragonfly down the same recall comes back uncached", `cache.test.ts:912` refused URL answers uncached. Freshness pin: `cache.test.ts:846`, a brief is served fresh after an accepted write, because the accept bumps the memory generation (`service.ts` accept path, `cache.ts` class TTL `brief: 300`). **Wording note:** the criterion says "never hides a claim older than 60 s"; the implemented pin is generation-based (every accepted write and graph write bumps the generation) plus the earliest-refresh deadline (`earliestRefreshAt`, `cache.ts:124`), and the test's comment reads "a claim newer than 60 s lands". The design intent (a fresh claim is not hidden) is met; no 60 s TTL exists. |
| 3 | Plane credentials live only in `substrate.env`; a plaintext non-loopback `redis://` Dragonfly URL is refused; a runbook covers the Tailscale forwarder hop. | ✓ VERIFIED | `config.ts:2007` `parseRedisUrl` refuses `redis://` and `rediss://` whose endpoint classifies `direct`, unless loopback or listed in `SUBSTRATE_DB_PROXY_ALLOW`; wired at `config.ts:2039`, refusal logged as "cache off: refusing redis:// to host ...". Tests: `config.test.ts:340-367`, all pass in the targeted run below. Credential perimeter: `store-lock.test.ts:532-580` forbids `HINDSIGHT_URL`/`HINDSIGHT_API_KEY` assignments outside `mcp-server`; `flag-registry.ts:758` marks `HINDSIGHT_URL` `secret-ref`; `.env.example:287-288` blank with "lives only in /etc/substrate/substrate.env" (`:2`). Runbook: `docs/runbooks/hindsight-cache-proof.md` section "Reach: the Tailscale forwarder hop" (lines 8-22). Note: refusal is stricter than the "plaintext" wording, since `rediss://` to a direct host is also refused. This is safe, and is recorded as info only. |
| 4 | Headless session answers a docs question with a `docs_search` source URL readable back from its event; a memory retained by one surface is recalled by another with its source; a second identical brief is a cache hit; with Dragonfly down it is uncached. | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (human) | Rehearsal parts exist and pass: cross-surface recall with source-bank attribution (`memory-recall.test.ts:80`, `:290`, `:336`), second-recall hit (`cache.test.ts:855`), Dragonfly-down uncached (`cache.test.ts:884`). The live headless proof (DOCS-07) and G1-G4 are operator-gated in `docs/runbooks/hindsight-cache-proof.md` and were not run. Per the verifier rule, this is human_needed, not a gap. |

**Score:** 2/4 truths verified (criteria 2 and 3). Criterion 1 is a WARNING (retain and recall verified; the budget clause is contradicted in enforce mode). Criterion 4 is human_needed (rehearsal verified; live proof gated).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/planes/hindsight.ts` | Hindsight HTTP client, banks, recall, retain | ✓ VERIFIED | 776 lines, bank-in-path, `sub-` prefix, `hindsightOp` fixed table, `Result` returns |
| `packages/mcp-server/src/memory-recall.ts` | `memory_recall` fan-out, derived framing | ✓ VERIFIED | caller bank first, shared budget, 4 per bank, untrusted notice |
| `packages/mcp-server/src/memory-retain.ts` | Gate-accepted retain forward | ✓ VERIFIED | sourced, redacted, idempotent `document_id`, refusal warnings locator-only |
| `packages/mcp-server/src/cache.ts` | Read-through Dragonfly cache, `health()` | ✓ VERIFIED | hits/misses/bypasses counted; generation-bound classes |
| `packages/mcp-server/src/config.ts` | `parseRedisUrl` refusal | ✓ VERIFIED | `config.ts:2007`, wired at `:2039` |
| `docs/runbooks/hindsight-cache-proof.md` | Forwarder hop runbook and G1-G4 gates | ✓ VERIFIED | Reach section present; each gate has proof read and rollback |
| `packages/mcp-server/src/brief.ts` + `recall-snapshot.ts` | Brief compose path free of the Hindsight client | ✓ VERIFIED | import-edge test `memory-recall.test.ts:261`; recall reaches the brief only by injection |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `service.ts` accept path | `forwardRetain` → `sub-<surface>` | `result.outcome === "accepted" && result.verified_persisted` (`service.ts:3353`) | ✓ WIRED | Bank via `bankForSurface(hindsight, writer)` |
| `mcp.ts` memory_recall | `Substrate.recallMemories` → `recallMemories` | `mcp.ts:952`, `server.ts:1501` | ✓ WIRED | |
| `mcp.ts` memory_search | derived plane leg | `mcp.ts:903` | ✓ WIRED | index first, plane appended derived |
| `service.ts` health | `cache.health()` | `service.ts:8766` → `/healthz` body | ✓ WIRED | |
| `config.ts` DRAGONFLY_URL | `parseRedisUrl` | `config.ts:2039` | ✓ WIRED | refusal sets cache off with reason |
| `brief.ts` recall section | `recallRead` / `boundedRecall` | `brief.ts:310`, `service.ts:2397` | ⚠️ PARTIAL | awaited up to `BRIEF_RECALL_CAP_MS` only when `SUBSTRATE_BRIEF_RECALL=enforce`; default off |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `recallMemories` | `results` | Hindsight `POST .../memories/recall` per configured bank | Yes (rehearsal fake and live client) | ✓ FLOWING (rehearsal) |
| `/healthz` `cache` | `hits/misses/bypasses` | live counters in `ReadThroughCache` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Redis refusal, cache hit, Dragonfly-down uncached, recall cache hit, claims freshness, brief/recall test set | `cd packages/mcp-server && bun test src/cache.test.ts src/config.test.ts src/planes/hindsight.test.ts src/memory-recall.test.ts -t "recall\|redis\|Redis\|Dragonfly\|dragonfly\|claim\|cache"` | 80 pass, 0 fail, 234 filtered | ✓ PASS |
| Live Hindsight recall, live Dragonfly, headless docs session | operator runbook G1-G4 | not run (operator-gated) | ? SKIP (human) |

### Probe Execution

No probe scripts (`scripts/*/tests/probe-*.sh`) are declared for this phase. Skipped.

### Requirements Coverage

| Requirement | Source | Status | Evidence |
|-------------|--------|--------|----------|
| DOCS-04 | 26-01, 26-02 | ✓ SATISFIED (rehearsal) / ⚠️ budget clause | recall tool, retain forward, merge; live G2/G3 gated |
| DOCS-05 | 26-03 | ✓ SATISFIED (rehearsal) | recall cache class, claims freshness pin, Dragonfly-down uncached |
| DOCS-06 | 26-03 | ✓ SATISFIED | `parseRedisUrl` refusal; runbook reach section |
| DOCS-07 | 26-03 | ? NEEDS HUMAN | live headless proof, operator-gated |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `packages/mcp-server/src/brief.ts` | 310 | recall awaited in brief response path (enforce mode) | ⚠️ Warning | Brief can run up to 3 s when `SUBSTRATE_BRIEF_RECALL=enforce`, past the 1.5 s recall budget named by the phase |
| `packages/mcp-server/src/cache.ts` | (class TTL) | no 60 s claim TTL; freshness is generation-based | ℹ️ Info | Matches the implemented pin; wording of criterion 2 differs |
| `packages/mcp-server/src/config.ts` | 2007-2030 | `rediss://` refused as well as `redis://` | ℹ️ Info | Stricter than "plaintext" wording |

No `TBD`, `FIXME`, `XXX`, `TODO`, or `PLACEHOLDER` markers in the phase's core files (`cache.ts`, `memory-recall.ts`, `planes/hindsight.ts`, `memory-retain.ts`, `recall-snapshot.ts`).

### Human Verification Required

See the two items in the frontmatter `human_verification` block:

1. **DOCS-07 and G1-G4 live proof.** Run `docs/runbooks/hindsight-cache-proof.md` in order in an approved window, with a headless session holding only the substrate MCP.
2. **Brief recall budget decision.** Decide whether enforce-mode recall in the brief (up to 3 s) is acceptable, or whether recall must stay outside the brief response path as D26-05 states.

### Gaps Summary

No success criterion is FAILED. The phase has no BLOCKER. Criterion 1's budget clause is a WARNING: the shipped default (`SUBSTRATE_BRIEF_RECALL=off`) keeps recall out of the brief, but the enforce mode from a later phase (uplift-4 S5) awaits recall inside the brief response, which the phase 26 decision D26-05 does not allow. Criterion 4's live proof is operator-gated, which makes the record human_needed. Nothing was run live.

Checks run: a targeted `bun test` on four files, 80 pass and 0 fail. No full suite, no live stack.

---

_Verified: 2026-11-18_
_Verifier: Claude (gsd-verifier)_
